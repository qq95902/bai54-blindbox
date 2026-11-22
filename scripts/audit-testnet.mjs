import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Contract, JsonRpcProvider, getAddress, parseEther } from 'ethers';

const root = process.cwd();
for (const filePath of [
  path.join(root, '.env.testnet'),
  path.join(root, '.env'),
  path.resolve(root, '../bai54-contracts/.env')
]) {
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2').replace(/\s+#.*$/, '');
  }
}
const deploymentsDir = path.join(root, 'deployments');
const requestedManifest = process.env.BAI_TESTNET_MANIFEST;
const defaultManifest = fs.existsSync(path.join(deploymentsDir, 'bsc-testnet-v12.json'))
  ? 'bsc-testnet-v12.json'
  : 'bsc-testnet-v10.json';
const manifestName = requestedManifest || defaultManifest;
const manifestPath = path.join(deploymentsDir, manifestName);
if (!fs.existsSync(manifestPath)) throw new Error(`Missing testnet manifest: ${manifestName}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.chainId !== 97) throw new Error(`Manifest chainId must be 97, got ${manifest.chainId}`);

const frontendSource = fs.readFileSync(path.join(root, 'bai-config.js'), 'utf8');
const frontendMatch = frontendSource.match(/window\.BAI_CONFIG\s*=\s*Object\.freeze\(([\s\S]*?)\);/);
if (!frontendMatch) throw new Error('Could not parse the public BAI_CONFIG from bai-config.js');
const frontend = JSON.parse(frontendMatch[1]);
class CurlJsonRpcProvider extends JsonRpcProvider {
  constructor(url) { super(url, 97, { staticNetwork: true }); this.rpcUrl = url; }
  async _send(payload) {
    const body = execFileSync('curl', [
      '--fail-with-body', '-sS', '--max-time', '25',
      '-H', 'content-type: application/json', '--data-binary', '@-', this.rpcUrl
    ], { input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    const response = JSON.parse(body);
    return Array.isArray(response) ? response : [response];
  }
}
const configuredRpcUrls = (process.env.BSC_TESTNET_RPC_URLS || '').split(',').map((url) => url.trim()).filter(Boolean);
const rpcUrls = [...new Set([
  process.env.BSC_TESTNET_RPC_URL,
  ...configuredRpcUrls,
  frontend.readRpcUrl,
  ...(frontend.rpcUrls || []),
  'https://bsc-testnet-dataseed.bnbchain.org',
  'https://bsc-testnet-rpc.publicnode.com'
].filter(Boolean))];
const preferredTransport = process.env.BSC_TESTNET_RPC_TRANSPORT === 'curl' ? 'curl' : 'fetch';
let provider;
let network;
let blockNumber;
let rpcEndpointHost;
const rpcErrors = [];
for (const url of rpcUrls) {
  const transports = preferredTransport === 'curl' ? ['curl', 'fetch'] : ['fetch', 'curl'];
  for (const transport of transports) {
    try {
      const candidate = transport === 'curl' ? new CurlJsonRpcProvider(url) : new JsonRpcProvider(url, 97, { staticNetwork: true });
      const [candidateNetwork, candidateBlock] = await Promise.all([candidate.getNetwork(), candidate.getBlockNumber()]);
      if (candidateNetwork.chainId !== 97n) {
        rpcErrors.push({ host: new URL(url).host, transport, error: `chainId ${candidateNetwork.chainId}` });
        await candidate.destroy();
        continue;
      }
      provider = candidate;
      network = candidateNetwork;
      blockNumber = candidateBlock;
      rpcEndpointHost = new URL(url).host;
      break;
    } catch (error) {
      rpcErrors.push({
        host: new URL(url).host,
        transport,
        error: transport === 'curl' && error.status ? `curl_exit_${error.status}` : (error.code || error.cause?.code || 'request_failed')
      });
    }
  }
  if (provider) break;
}
if (!provider) {
  console.log(JSON.stringify({
    network: 'BNB Smart Chain Testnet',
    result: 'RPC_UNAVAILABLE',
    tried: rpcErrors,
    noTransactionsSent: true
  }, null, 2));
  process.exit(2);
}

const normalized = (value, label) => {
  try { return getAddress(value).toLowerCase(); }
  catch { throw new Error(`${label} is not a valid EVM address in ${manifestName}`); }
};
const sameAddress = (left, right) => {
  try { return getAddress(left).toLowerCase() === getAddress(right).toLowerCase(); }
  catch { return false; }
};
const contracts = manifest.contracts || {};
const contractEntries = Object.entries(contracts);
const deployedCode = await Promise.all(contractEntries.map(async ([name, address]) => {
  const code = await provider.getCode(normalized(address, `contracts.${name}`));
  return [name, { address, hasCode: code !== '0x', runtimeBytes: code === '0x' ? 0 : (code.length - 2) / 2 }];
}));
const contractCode = Object.fromEntries(deployedCode);
const externalEntries = Object.entries(manifest.external || {}).filter(([name, address]) =>
  ['usdt', 'router', 'factory', 'vrfCoordinator', 'wrappedNative', 'pair'].includes(name) && typeof address === 'string'
);
const externalCode = Object.fromEntries(await Promise.all(externalEntries.map(async ([name, address]) => {
  const code = await provider.getCode(normalized(address, `external.${name}`));
  return [name, { address, hasCode: code !== '0x', runtimeBytes: code === '0x' ? 0 : (code.length - 2) / 2 }];
})));

const manager = new Contract(contracts.liquidityManager, [
  'function marketReady() view returns(bool)',
  'function twapStatus() view returns(bool,uint64,uint256)',
  'function observationCount() view returns(uint8)',
  'function usdtReserve() view returns(uint256)',
  'function lpPair() view returns(address)',
  'function initialLPRecorded() view returns(bool)'
], provider);
const game = new Contract(contracts.game, [
  'function baiToken() view returns(address)',
  'function liquidityProcessor() view returns(address)',
  'function purchaseProcessor() view returns(address)'
], provider);
const drop = new Contract(contracts.freeDrop, [
  'function game() view returns(address)',
  'function baiToken() view returns(address)',
  'function freeRewardReserve() view returns(uint256)',
  'function totalClaims() view returns(uint32)'
], provider);
const bai = new Contract(contracts.baiToken || contracts.bai, [
  'function balanceOf(address) view returns(uint256)'
], provider);
const vrf = new Contract(manifest.external.vrfCoordinator, [
  'function getSubscription(uint256) view returns(uint96,uint96,uint64,address,address[])'
], provider);

const [marketReady, twap, observations, usdtReserve, pair, initialLPRecorded,
  gameBai, gameManager, dropGame, dropBai, freeReserve, totalClaims,
  freeDropBAIBalance, subscription] = await Promise.all([
  manager.marketReady(), manager.twapStatus(), manager.observationCount(), manager.usdtReserve(),
  manager.lpPair(), manager.initialLPRecorded(), game.baiToken(), game.liquidityProcessor(),
  drop.game(), drop.baiToken(), drop.freeRewardReserve(), drop.totalClaims(),
  bai.balanceOf(contracts.freeDrop), vrf.getSubscription(manifest.external.vrfSubscriptionId)
]);

const expectedConsumers = [contracts.game, contracts.freeDrop].map((item, i) => normalized(item, `VRF consumer ${i}`));
const actualConsumers = subscription[4].map((item) => item.toLowerCase());
const hasDirectUsdtProcessor = Number(manifest.version) >= 12;
let processor = null;
let purchaseProcessorAddress = null;
if (hasDirectUsdtProcessor) {
  purchaseProcessorAddress = contracts.purchaseProcessor;
  if (!purchaseProcessorAddress || !manifest.purchaseKeeper || !manifest.external.usdt) {
    throw new Error('v12+ manifest is missing purchase processor, Keeper, or USDT address');
  }
  processor = new Contract(purchaseProcessorAddress, [
    'function keeper() view returns(address)',
    'function game() view returns(address)',
    'function usdtToken() view returns(address)'
  ], provider);
}
const processorConfig = processor ? await Promise.all([
  processor.keeper(), processor.game(), processor.usdtToken(), game.purchaseProcessor()
]) : null;

const minVrfNativeBalance = BigInt(
  manifest.vrf?.minimumNativeBalanceWei || process.env.VRF_MIN_NATIVE_BALANCE_WEI || parseEther('0.1')
);
const checks = {
  manifestMarkedDeployedReady: manifest.status === 'DEPLOYED_READY',
  currentRulesContractVersionAtLeast12: Number(manifest.version) >= 12,
  allManifestContractsHaveCode: Object.values(contractCode).every((item) => item.hasCode),
  allConfiguredExternalContractsHaveCode: Object.values(externalCode).every((item) => item.hasCode),
  frontendChainMatchesManifest: frontend.chainId === manifest.chainId,
  frontendCoreAddressesMatchManifest: ['game', 'freeDrop', 'metadataRenderer', 'liquidityManager']
    .every((key) => sameAddress(frontend.contracts?.[key], contracts[key])) &&
    sameAddress(frontend.contracts?.bai, contracts.baiToken || contracts.bai),
  gameBaiLinked: normalized(gameBai, 'on-chain game BAI') === normalized(contracts.baiToken || contracts.bai, 'contracts.baiToken'),
  gameLiquidityManagerLinked: normalized(gameManager, 'on-chain game liquidity manager') === normalized(contracts.liquidityManager, 'contracts.liquidityManager'),
  freeDropGameLinked: normalized(dropGame, 'on-chain free-drop game') === normalized(contracts.game, 'contracts.game'),
  freeDropBaiLinked: normalized(dropBai, 'on-chain free-drop BAI') === normalized(contracts.baiToken || contracts.bai, 'contracts.baiToken'),
  expectedVrfConsumersRegistered: expectedConsumers.every((address) => actualConsumers.includes(address)),
  vrfSubscriptionOwnedByDeployer: subscription[3].toLowerCase() === normalized(manifest.deployer, 'manifest.deployer'),
  vrfNativeBalanceAboveOperatingFloor: subscription[1] >= minVrfNativeBalance,
  freeRewardReserveFunded: freeDropBAIBalance >= freeReserve,
  initialLiquidityRecorded: initialLPRecorded,
  liquidityPairMatchesManifest: sameAddress(pair, manifest.external.pair),
  directUsdtProcessorDeployed: hasDirectUsdtProcessor && contractCode.purchaseProcessor?.hasCode === true,
  frontendPublicApiConfigured: Boolean(frontend.apiBaseUrl),
  oracleAndMarketReady: marketReady
};
if (hasDirectUsdtProcessor) {
  const [processorKeeper, processorGame, processorUsdt, gameProcessor] = processorConfig;
  checks.purchaseProcessorCodePresent = contractCode.purchaseProcessor?.hasCode === true;
  checks.frontendPurchaseProcessorAndUsdtMatchManifest =
    sameAddress(frontend.contracts?.purchaseProcessor, contracts.purchaseProcessor) &&
    sameAddress(frontend.contracts?.usdt, manifest.external.usdt);
  checks.frontendApiMatchesManifest = frontend.apiBaseUrl === manifest.publicApiBaseUrl;
  checks.processorKeeperMatchesManifest = normalized(processorKeeper, 'on-chain purchase Keeper') === normalized(manifest.purchaseKeeper, 'manifest.purchaseKeeper');
  checks.processorGameLinked = normalized(processorGame, 'on-chain processor game') === normalized(contracts.game, 'contracts.game');
  checks.processorUsdtLinked = normalized(processorUsdt, 'on-chain processor USDT') === normalized(manifest.external.usdt, 'external.usdt');
  checks.gamePurchaseProcessorLinked = normalized(gameProcessor, 'on-chain game purchase processor') === normalized(contracts.purchaseProcessor, 'contracts.purchaseProcessor');
}

const report = {
  network: 'BNB Smart Chain Testnet',
  chainId: Number(network.chainId),
  blockNumber,
  rpcEndpointHost,
  rpcTransport: provider instanceof CurlJsonRpcProvider ? 'curl' : 'fetch',
  manifest: { file: manifestName, version: manifest.version, status: manifest.status },
  contracts: contractCode,
  externalContracts: externalCode,
  market: {
    ready: marketReady,
    twapReady: twap[0],
    twapAgeSeconds: String(twap[1]),
    averagePriceX112: String(twap[2]),
    observationCount: Number(observations),
    usdtReserve: String(usdtReserve),
    pair,
    initialLPRecorded
  },
  freeDrop: {
    totalClaims: Number(totalClaims),
    configuredReserve: String(freeReserve),
    actualBaiBalance: String(freeDropBAIBalance)
  },
  vrf: {
    owner: subscription[3],
    linkBalanceWei: String(subscription[0]),
    nativeBalanceWei: String(subscription[1]),
    minimumNativeBalanceWei: String(minVrfNativeBalance),
    consumerCount: subscription[4].length,
    requiredConsumersRegistered: expectedConsumers.every((address) => actualConsumers.includes(address))
  },
  purchase: {
    directUsdtProcessorRequired: true,
    processorConfigured: hasDirectUsdtProcessor,
    apiBaseUrlConfigured: Boolean(frontend.apiBaseUrl),
    processorAddress: purchaseProcessorAddress,
    keeperAddress: manifest.purchaseKeeper || null
  },
  checks,
  result: Object.values(checks).every(Boolean) ? 'PASS' : 'NOT_READY'
};
console.log(JSON.stringify(report, null, 2));
if (report.result !== 'PASS') process.exitCode = 1;
