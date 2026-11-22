import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import solc from 'solc';
import { Contract, JsonRpcProvider, keccak256 } from 'ethers';

const root = process.cwd();
const manifestName = process.env.BAI_TESTNET_MANIFEST || 'bsc-testnet-v12.json';
const manifestPath = path.join(root, 'deployments', manifestName);
if (!fs.existsSync(manifestPath)) {
  throw new Error(`Testnet verification cannot run: ${manifestName} does not exist. Deploy v12 to BSC testnet first; the existing v10 deployment does not contain the direct-USDT purchase processor.`);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.chainId !== 97 || manifest.status !== 'DEPLOYED_READY' || Number(manifest.version) < 12) {
  throw new Error(`Expected a DEPLOYED_READY BSC Testnet v12+ manifest: ${manifestName}`);
}

const sources = {};
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(fullPath);
    else if (entry.name.endsWith('.sol')) {
      sources[path.relative(root, fullPath).split(path.sep).join('/')] = {
        content: fs.readFileSync(fullPath, 'utf8')
      };
    }
  }
}
collect(path.join(root, 'contracts'));
const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 1 },
    viaIR: true,
    evmVersion: 'cancun',
    metadata: { bytecodeHash: 'none' },
    outputSelection: { '*': { '*': ['evm.deployedBytecode'] } }
  }
};
function findImports(importPath) {
  for (const candidate of [path.resolve(root, importPath), path.resolve(root, 'node_modules', importPath)]) {
    if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, 'utf8') };
  }
  return { error: `Import not found: ${importPath}` };
}
const compiled = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (compiled.errors || []).filter((item) => item.severity === 'error');
if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join('\n'));
const gameArtifact = compiled.contracts['contracts/BAIBlindBoxGameV2.sol'].BAIBlindBoxGameV2.evm.deployedBytecode;
const localGameBytecode = `0x${gameArtifact.object}`;

const configPath = path.join(root, 'bai-config.js');
const frontendConfig = fs.readFileSync(configPath, 'utf8').toLowerCase();
const rpcUrl = process.env.BSC_TESTNET_RPC_URL || 'https://bsc-testnet-dataseed.bnbchain.org';
class CurlJsonRpcProvider extends JsonRpcProvider {
  async _send(payload) {
    const body = execFileSync('curl', [
      '--fail-with-body', '-sS', '--max-time', '20',
      '-H', 'content-type: application/json', '--data-binary', '@-', rpcUrl
    ], { input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const response = JSON.parse(body);
    return Array.isArray(response) ? response : [response];
  }
}
const Provider = process.env.BSC_TESTNET_RPC_TRANSPORT === 'curl' ? CurlJsonRpcProvider : JsonRpcProvider;
const provider = new Provider(rpcUrl, 97, { staticNetwork: true });
const [network, blockNumber, gameCode] = await Promise.all([
  provider.getNetwork(), provider.getBlockNumber(), provider.getCode(manifest.contracts.game)
]);
if (network.chainId !== 97n) throw new Error(`Connected to chain ${network.chainId}, expected 97`);
function normalizeImmutableBytes(bytecode, references) {
  const chars = bytecode.slice(2).split('');
  for (const reference of Object.values(references).flat()) {
    for (let offset = 0; offset < reference.length; offset++) {
      const index = (reference.start + offset) * 2;
      chars[index] = '0';
      chars[index + 1] = '0';
    }
  }
  return `0x${chars.join('')}`;
}
const localNormalizedGameCode = normalizeImmutableBytes(localGameBytecode, gameArtifact.immutableReferences || {});
const chainNormalizedGameCode = normalizeImmutableBytes(gameCode, gameArtifact.immutableReferences || {});
const runtimeDiffs = [];
for (let index = 2; index < localNormalizedGameCode.length && runtimeDiffs.length < 12; index += 2) {
  if (localNormalizedGameCode.slice(index, index + 2) !== chainNormalizedGameCode.slice(index, index + 2)) {
    runtimeDiffs.push({ byteOffset: (index - 2) / 2, local: localNormalizedGameCode.slice(index, index + 2), chain: chainNormalizedGameCode.slice(index, index + 2) });
  }
}

const manager = new Contract(manifest.contracts.liquidityManager, [
  'function marketReady() view returns(bool)',
  'function twapStatus() view returns(bool,uint64,uint256)',
  'function observationCount() view returns(uint8)',
  'function usdtReserve() view returns(uint256)',
  'function lpPair() view returns(address)',
  'function initialLPRecorded() view returns(bool)'
], provider);
const game = new Contract(manifest.contracts.game, [
  'function baiToken() view returns(address)',
  'function liquidityProcessor() view returns(address)',
  'function purchaseProcessor() view returns(address)'
], provider);
const drop = new Contract(manifest.contracts.freeDrop, [
  'function game() view returns(address)',
  'function baiToken() view returns(address)',
  'function freeRewardReserve() view returns(uint256)',
  'function totalClaims() view returns(uint32)'
], provider);
const bai = new Contract(manifest.contracts.baiToken, ['function balanceOf(address) view returns(uint256)'], provider);
const vrf = new Contract(manifest.external.vrfCoordinator, [
  'function getSubscription(uint256) view returns(uint96,uint96,uint64,address,address[])'
], provider);

const hasDirectUsdtProcessor = Number(manifest.version) >= 12;
let purchaseProcessor = null;
let processorCode = '0x';
let usdtCode = '0x';
let processorKeeper = null;
let processorGame = null;
let processorUsdt = null;
let buyerVaultOne = null;
let buyerVaultTwo = null;
if (hasDirectUsdtProcessor) {
  const processorAddress = manifest.contracts.purchaseProcessor;
  if (!processorAddress || !manifest.purchaseKeeper || !manifest.external.usdt) {
    throw new Error('v12+ manifest is missing purchase processor, Keeper, or USDT addresses');
  }
  processorCode = await provider.getCode(processorAddress);
  usdtCode = await provider.getCode(manifest.external.usdt);
  purchaseProcessor = new Contract(processorAddress, [
    'function keeper() view returns(address)',
    'function game() view returns(address)',
    'function usdtToken() view returns(address)',
    'function predictVault(address,address) view returns(address)'
  ], provider);
  [processorKeeper, processorGame, processorUsdt, buyerVaultOne, buyerVaultTwo] = await Promise.all([
    purchaseProcessor.keeper(), purchaseProcessor.game(), purchaseProcessor.usdtToken(),
    purchaseProcessor.predictVault('0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000000'),
    purchaseProcessor.predictVault('0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000000')
  ]);
}

const [ready, twap, observations, usdtReserve, pair, initialLPRecorded,
  gameBai, gameManager, dropGame, dropBai, freeReserve, claims,
  freeDropBAIBalance, subscription] = await Promise.all([
  manager.marketReady(), manager.twapStatus(), manager.observationCount(), manager.usdtReserve(),
  manager.lpPair(), manager.initialLPRecorded(), game.baiToken(), game.liquidityProcessor(),
  drop.game(), drop.baiToken(), drop.freeRewardReserve(), drop.totalClaims(),
  bai.balanceOf(manifest.contracts.freeDrop), vrf.getSubscription(manifest.external.vrfSubscriptionId)
]);

const expectedConsumers = [manifest.contracts.game, manifest.contracts.freeDrop].map((item) => item.toLowerCase());
const registeredConsumers = subscription[4].map((item) => item.toLowerCase());
const checks = {
  gameRuntimeMatchesCurrentBuild: keccak256(chainNormalizedGameCode) === keccak256(localNormalizedGameCode),
  frontendConfigMatchesManifest: ['game', 'baiToken', 'freeDrop', 'metadataRenderer', 'liquidityManager']
    .every((key) => frontendConfig.includes(manifest.contracts[key].toLowerCase())) &&
    (!hasDirectUsdtProcessor || [manifest.contracts.purchaseProcessor, manifest.external.usdt].every((address) => frontendConfig.includes(address.toLowerCase()))),
  frontendApiMatchesManifest: !hasDirectUsdtProcessor || frontendConfig.includes(`"apiBaseUrl": "${manifest.publicApiBaseUrl}"`.toLowerCase()),
  gameBAILinked: gameBai.toLowerCase() === manifest.contracts.baiToken.toLowerCase(),
  gameManagerLinked: gameManager.toLowerCase() === manifest.contracts.liquidityManager.toLowerCase(),
  freeDropGameLinked: dropGame.toLowerCase() === manifest.contracts.game.toLowerCase(),
  freeDropBAILinked: dropBai.toLowerCase() === manifest.contracts.baiToken.toLowerCase(),
  bothVRFConsumersRegistered: expectedConsumers.every((address) => registeredConsumers.includes(address)),
  freeRewardReserveFunded: freeDropBAIBalance >= freeReserve,
  initialLiquidityLocked: initialLPRecorded,
  marketReady: ready,
  ...(hasDirectUsdtProcessor ? {
    purchaseProcessorCodePresent: processorCode !== '0x',
    purchaseUsdtCodePresent: usdtCode !== '0x',
    purchaseProcessorKeeperMatchesManifest: processorKeeper.toLowerCase() === manifest.purchaseKeeper.toLowerCase(),
    purchaseProcessorGameLinked: processorGame.toLowerCase() === manifest.contracts.game.toLowerCase(),
    purchaseProcessorUsdtLinked: processorUsdt.toLowerCase() === manifest.external.usdt.toLowerCase(),
    gamePurchaseProcessorLinked: (await game.purchaseProcessor()).toLowerCase() === manifest.contracts.purchaseProcessor.toLowerCase(),
    buyerBoundDepositVaults: buyerVaultOne !== '0x0000000000000000000000000000000000000000' &&
      buyerVaultTwo !== '0x0000000000000000000000000000000000000000' &&
      buyerVaultOne.toLowerCase() !== buyerVaultTwo.toLowerCase()
  } : {})
};

const report = {
  network: 'BNB Smart Chain Testnet',
  deploymentVersion: manifest.version,
  chainId: Number(network.chainId),
  blockNumber,
  contractAddresses: manifest.contracts,
  gameRuntimeBytes: { local: (localGameBytecode.length - 2) / 2, chain: (gameCode.length - 2) / 2 },
  gameRuntimeCheck: { immutableSlots: Object.values(gameArtifact.immutableReferences || {}).flat().length, differingByteOffsetsAfterImmutableNormalization: runtimeDiffs },
  market: { ready, twapAgeSeconds: String(twap[1]), observations: Number(observations), usdtReserve: String(usdtReserve), pair },
  freeDrop: { configuredReserve: String(freeReserve), actualReserve: String(freeDropBAIBalance), totalClaims: Number(claims) },
  vrfNativeBalanceWei: String(subscription[1]),
  checks,
  result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'
};
console.log(JSON.stringify(report, null, 2));
if (report.result !== 'PASS') process.exitCode = 1;
