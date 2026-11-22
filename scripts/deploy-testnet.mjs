import fs from 'node:fs';
import path from 'node:path';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress, parseUnits, formatUnits } from 'ethers';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const outputPath = path.join(root, 'deployments', 'bsc-testnet-v12.json');
const execute = process.argv.includes('--execute');
const envFiles = [path.join(root, '.env.testnet'), path.join(root, '.env'), path.resolve(root, '../bai54-contracts/.env')];
for (const file of envFiles) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2').replace(/\s+#.*$/, '');
  }
}
const env = process.env;
const missingConfig = [];
if (!env.BSC_TESTNET_RPC_URL?.trim()) missingConfig.push('BSC_TESTNET_RPC_URL');
if (!env.DEPLOYER_PRIVATE_KEY?.trim() && !env.DEPLOYER_PRIVATE_KEY_FILE?.trim()) {
  missingConfig.push('DEPLOYER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY_FILE');
}
if (env.DEPLOYER_PRIVATE_KEY_FILE?.trim() && !fs.existsSync(path.resolve(env.DEPLOYER_PRIVATE_KEY_FILE.trim()))) {
  missingConfig.push('file configured by DEPLOYER_PRIVATE_KEY_FILE');
}
if (!env.BSC_TESTNET_PURCHASE_KEEPER_ADDRESS?.trim()) missingConfig.push('BSC_TESTNET_PURCHASE_KEEPER_ADDRESS');
if (!env.BSC_TESTNET_OPERATIONS_TREASURY?.trim()) missingConfig.push('BSC_TESTNET_OPERATIONS_TREASURY');
if (!env.PUBLIC_API_BASE_URL?.trim()) missingConfig.push('PUBLIC_API_BASE_URL');
if (!env.WALLETCONNECT_PROJECT_ID?.trim()) missingConfig.push('WALLETCONNECT_PROJECT_ID (public WalletConnect Cloud project ID for desktop QR pairing)');
if (!env.BSC_TESTNET_VRF_KEY_HASH?.trim()) missingConfig.push('BSC_TESTNET_VRF_KEY_HASH');
if (!env.BSC_TESTNET_VRF_SUBSCRIPTION_ID?.trim()) missingConfig.push('BSC_TESTNET_VRF_SUBSCRIPTION_ID');
if (missingConfig.length) {
  console.error(`Missing testnet deployment configuration:\n${missingConfig.map((name) => `- ${name}`).join('\n')}\nFill these in .env.testnet, then rerun npm run deploy:testnet:check.`);
  process.exit(1);
}
const defaults = {
  chainId: 97,
  usdt: '0x337610d27c682e347c9cd60bd4b3b107c9d34ddd',
  router: '0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3',
  coordinator: '0xDA3b641D438362C440Ac5458c57e00a712b66700',
  keyHash: '0x' + '0'.repeat(64),
  confirmations: 3,
  callbackGasLimit: 350000,
  initialUsdt: '2',
  initialBai: '80000',
  observationInterval: 5,
  twapPeriod: 15,
  maxObservationAge: 300,
  minPoolValue: '2'
};
const publicRpcUrl = 'https://bsc-testnet-dataseed.bnbchain.org';
const required = (name, fallback) => {
  const value = env[name]?.trim() || fallback;
  if (!value) throw new Error(`Missing ${name}. Configure it in .env.testnet or the existing private .env file.`);
  return value;
};
const address = (name, value) => {
  try { return getAddress(value); } catch { throw new Error(`${name} is not a valid EVM address`); }
};
const artifact = (name) => JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'mainnet', `${name}.json`), 'utf8'));
const save = (data) => {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`);
};

const previous = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : null;
const rpcUrl = required('BSC_TESTNET_RPC_URL');
const keyFile = env.DEPLOYER_PRIVATE_KEY_FILE?.trim();
const privateKey = keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : required('DEPLOYER_PRIVATE_KEY');
if (!/^0x[\da-fA-F]{64}$/.test(privateKey)) throw new Error('Configured private key must be one 32-byte hex key');
const signerAddress = new Wallet(privateKey).address;
const usdt = address('BSC_TESTNET_USDT_ADDRESS', required('BSC_TESTNET_USDT_ADDRESS', defaults.usdt));
const routerAddress = address('BSC_TESTNET_ROUTER_ADDRESS', required('BSC_TESTNET_ROUTER_ADDRESS', defaults.router));
const coordinator = address('BSC_TESTNET_VRF_COORDINATOR', required('BSC_TESTNET_VRF_COORDINATOR', defaults.coordinator));
const treasury = address('BSC_TESTNET_OPERATIONS_TREASURY', required('BSC_TESTNET_OPERATIONS_TREASURY'));
const purchaseKeeper = address('BSC_TESTNET_PURCHASE_KEEPER_ADDRESS', required('BSC_TESTNET_PURCHASE_KEEPER_ADDRESS'));
const publicApiInput = required('PUBLIC_API_BASE_URL');
const walletConnectProjectId = required('WALLETCONNECT_PROJECT_ID');
if (!/^[a-f\d]{32}$/i.test(walletConnectProjectId)) throw new Error('WALLETCONNECT_PROJECT_ID must be the 32-character public project ID from WalletConnect Cloud');
let publicApiBaseUrl;
try {
  const parsed = new URL(publicApiInput);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
  publicApiBaseUrl = parsed.origin;
} catch { throw new Error('PUBLIC_API_BASE_URL must be an HTTPS origin, for example https://api.example.com'); }
const lpBeneficiary = address('BSC_TESTNET_LP_BENEFICIARY', required('BSC_TESTNET_LP_BENEFICIARY', signerAddress));
if (lpBeneficiary.toLowerCase() !== signerAddress.toLowerCase()) throw new Error('LP beneficiary must be the configured deployment wallet');
const keyHash = required('BSC_TESTNET_VRF_KEY_HASH');
if (!/^0x[\da-fA-F]{64}$/.test(keyHash) || /^0x0+$/.test(keyHash)) throw new Error('BSC_TESTNET_VRF_KEY_HASH must be a non-zero bytes32');
const subscriptionId = BigInt(required('BSC_TESTNET_VRF_SUBSCRIPTION_ID'));
if (subscriptionId <= 0n) throw new Error('BSC_TESTNET_VRF_SUBSCRIPTION_ID must be positive');
const confirmations = Number(env.VRF_REQUEST_CONFIRMATIONS || defaults.confirmations);
const callbackGasLimit = Number(env.VRF_CALLBACK_GAS_LIMIT || defaults.callbackGasLimit);
if (!Number.isInteger(confirmations) || confirmations < 3 || confirmations > 200) throw new Error('VRF confirmations must be between 3 and 200');
if (!Number.isInteger(callbackGasLimit) || callbackGasLimit < 100000 || callbackGasLimit > 2500000) throw new Error('VRF callback gas limit is outside the BNB Chain range');
const vrfMinNativeBalanceInput = env.VRF_MIN_NATIVE_BALANCE_BNB?.trim() || '0.1';
if (!/^\d+(\.\d{1,18})?$/.test(vrfMinNativeBalanceInput)) {
  throw new Error('VRF_MIN_NATIVE_BALANCE_BNB must be a positive decimal amount with at most 18 places');
}
const vrfMinNativeBalance = parseUnits(vrfMinNativeBalanceInput, 18);
if (vrfMinNativeBalance <= 0n) throw new Error('VRF_MIN_NATIVE_BALANCE_BNB must be greater than zero');
const initialUsdt = required('BSC_TESTNET_INITIAL_SEED_USDT', defaults.initialUsdt);
const initialBai = required('BSC_TESTNET_INITIAL_SEED_BAI', defaults.initialBai);
if (![initialUsdt, initialBai].every((v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0)) throw new Error('Initial LP seed amounts must be positive decimals');
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
const Provider = env.BSC_TESTNET_RPC_TRANSPORT === 'curl' ? CurlJsonRpcProvider : JsonRpcProvider;
const provider = new Provider(rpcUrl, defaults.chainId, { staticNetwork: true });
const signer = new Wallet(privateKey, provider);
const chain = await provider.getNetwork();
if (chain.chainId !== 97n) throw new Error(`Connected to chain ${chain.chainId}; BSC Testnet (97) required`);
const token = new Contract(usdt, ['function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)','function approve(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)'], signer);
const router = new Contract(routerAddress, ['function factory() view returns(address)','function WETH() view returns(address)','function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns(uint256,uint256,uint256)'], signer);
const factoryAbi = ['function getPair(address,address) view returns(address)','function createPair(address,address) returns(address)'];
const factoryAddress = address('router factory', await router.factory());
const factory = new Contract(factoryAddress, factoryAbi, signer);
const [usdtCode, routerCode, coordinatorCode, factoryCode, usdtDecimals, usdtBalance, nativeBalance] = await Promise.all([
  provider.getCode(usdt), provider.getCode(routerAddress), provider.getCode(coordinator), provider.getCode(factoryAddress),
  token.decimals(), token.balanceOf(signerAddress), provider.getBalance(signerAddress)
]);
if ([usdtCode, routerCode, coordinatorCode, factoryCode].some((code) => code === '0x')) throw new Error('One or more configured testnet contracts have no code');
if (Number(usdtDecimals) !== 18) throw new Error(`Test USDT decimals are ${usdtDecimals}; expected 18`);
const usdtSeed = parseUnits(initialUsdt, Number(usdtDecimals));
const baiSeed = parseUnits(initialBai, 18);
if (usdtBalance < usdtSeed) throw new Error(`Deployment wallet needs ${initialUsdt} test USDT for the new test pool`);
if (nativeBalance < parseUnits('0.05', 18)) throw new Error('Deployment wallet needs at least 0.05 tBNB for deployment and setup transactions');
const vrf = new Contract(coordinator, ['function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)','function addConsumer(uint256,address)'], signer);
const subscription = await vrf.getSubscription(subscriptionId);
if (subscription.owner.toLowerCase() !== signerAddress.toLowerCase()) throw new Error('Configured deployer does not own the VRF subscription');
if (subscription.nativeBalance < vrfMinNativeBalance) {
  throw new Error(`VRF subscription native BNB balance ${formatUnits(subscription.nativeBalance, 18)} is below the configured Keeper operating floor ${vrfMinNativeBalanceInput}`);
}
const newPlan = {
  network: 'BNB Smart Chain Testnet', chainId: 97, version: 12, deployer: signerAddress, purchaseKeeper, publicApiBaseUrl,
  external: { usdt, router: routerAddress, factory: factoryAddress, vrfCoordinator: coordinator, vrfSubscriptionId: subscriptionId.toString(), wrappedNative: await router.WETH() },
  initialLiquidity: { usdt: formatUnits(usdtSeed, Number(usdtDecimals)), bai: formatUnits(baiSeed, 18) },
  vrf: {
    subscriptionOwner: subscription.owner,
    nativeBalanceWei: subscription.nativeBalance.toString(),
    minimumNativeBalanceWei: vrfMinNativeBalance.toString(),
    minimumNativeBalanceBNB: vrfMinNativeBalanceInput,
    existingConsumers: subscription.consumers.length
  },
  testnetSettings: { observationIntervalSeconds: defaults.observationInterval, twapSeconds: defaults.twapPeriod, maximumObservationAgeSeconds: defaults.maxObservationAge, minimumPoolValueUSDT: Number(defaults.minPoolValue) },
  rules: { directReferralUSDT: '3 USDT per referred 10 USDT box (30%), one level only', lpAllocation: '78% sales less same-round referral commissions', legacyMultiLevelReferral: false },
  startedAt: new Date().toISOString(), contracts: {}, transactions: {}
};
if (previous) {
  if (previous.version !== 12) throw new Error('Existing testnet record uses an older contract version; v12 requires a fresh deployment manifest');
  if (previous.chainId !== 97 || previous.deployer?.toLowerCase() !== signerAddress.toLowerCase() ||
      previous.external?.usdt?.toLowerCase() !== usdt.toLowerCase() ||
      previous.external?.router?.toLowerCase() !== routerAddress.toLowerCase() ||
      previous.external?.vrfCoordinator?.toLowerCase() !== coordinator.toLowerCase() ||
      previous.external?.vrfSubscriptionId !== subscriptionId.toString() ||
      previous.purchaseKeeper?.toLowerCase() !== purchaseKeeper.toLowerCase() ||
      previous.publicApiBaseUrl !== publicApiBaseUrl ||
      previous.rules?.directReferralUSDT !== newPlan.rules.directReferralUSDT) {
    throw new Error('Existing testnet deployment record does not match the current deployment settings; refusing to continue');
  }
}
const plan = previous ? {
  ...newPlan,
  ...previous,
  external: { ...newPlan.external, ...previous.external },
  vrf: { ...previous.vrf, ...newPlan.vrf },
  contracts: { ...previous.contracts },
  transactions: { ...previous.transactions }
} : newPlan;
process.stdout.write(`${JSON.stringify({ ...plan, deployerBalance: { tBNB: formatUnits(nativeBalance, 18), testUSDT: formatUnits(usdtBalance, Number(usdtDecimals)) } }, null, 2)}\n`);
if (!execute) {
  process.stdout.write('Read-only preflight passed. No transaction sent. Run npm run deploy:testnet to deploy testnet v12.\n');
  process.exit(0);
}

execFileSync('node', ['scripts/compile.mjs'], { cwd: root, stdio: 'inherit' });
save({ ...plan, status: 'DEPLOYING' });
async function deploy(name, args, key) {
  const build = artifact(name);
  if (plan.contracts[key]) {
    if ((await provider.getCode(plan.contracts[key])) === '0x') throw new Error(`Recorded ${name} has no code on BSC testnet`);
    process.stdout.write(`${name}: resuming at ${plan.contracts[key]}\n`);
    return new Contract(plan.contracts[key], build.abi, signer);
  }
  const pendingHash = plan.transactions[`${key}Deployment`];
  if (pendingHash) {
    let receipt = await provider.getTransactionReceipt(pendingHash);
    if (!receipt) receipt = await provider.waitForTransaction(pendingHash, 1);
    if (!receipt || receipt.status !== 1 || !receipt.contractAddress ||
        (await provider.getCode(receipt.contractAddress)) === '0x') {
      throw new Error(`Recorded ${name} deployment ${pendingHash} did not produce contract code; inspect it before retrying`);
    }
    plan.contracts[key] = getAddress(receipt.contractAddress);
    save({ ...plan, status: 'DEPLOYING' });
    process.stdout.write(`${name}: recovered mined deployment at ${plan.contracts[key]}\n`);
    return new Contract(plan.contracts[key], build.abi, signer);
  }
  const contract = await new ContractFactory(build.abi, build.bytecode, signer).deploy(...args);
  const tx = contract.deploymentTransaction();
  plan.transactions[`${key}Deployment`] = tx.hash;
  save({ ...plan, status: 'DEPLOYING' });
  await contract.waitForDeployment();
  const deployed = await contract.getAddress();
  plan.contracts[key] = deployed;
  save({ ...plan, status: 'DEPLOYING' });
  process.stdout.write(`${name}: ${deployed}\n`);
  return contract;
}
async function sendAndWait(promise) {
  const tx = await promise;
  await tx.wait();
  return tx;
}
const renderer = await deploy('BAICardMetadataRenderer', [], 'metadataRenderer');
const game = await deploy('BAIBlindBoxGameV2', [usdt, coordinator, keyHash, subscriptionId, confirmations, callbackGasLimit, await renderer.getAddress()], 'game');
const purchaseProcessor = await deploy('BAIPurchaseProcessor', [usdt, await game.getAddress(), routerAddress, purchaseKeeper], 'purchaseProcessor');
const freeDrop = await deploy('BAIFreeDrop', [await game.getAddress(), coordinator, keyHash, subscriptionId, confirmations, callbackGasLimit], 'freeDrop');
const bai = await deploy('BAIToken', [factoryAddress, usdt, signerAddress, await game.getAddress(), await freeDrop.getAddress(), treasury, await game.getAddress()], 'baiToken');
const gameAddress = await game.getAddress();
const freeDropAddress = await freeDrop.getAddress();
const baiAddress = await bai.getAddress();
const linkedGameToken = await game.baiToken();
if (linkedGameToken === '0x0000000000000000000000000000000000000000') await (await game.setBAIToken(baiAddress)).wait();
else if (linkedGameToken.toLowerCase() !== baiAddress.toLowerCase()) throw new Error('Game is linked to a different BAI token');
const linkedPurchaseProcessor = await game.purchaseProcessor();
if (linkedPurchaseProcessor === '0x0000000000000000000000000000000000000000') await (await game.setPurchaseProcessor(await purchaseProcessor.getAddress())).wait();
else if (linkedPurchaseProcessor.toLowerCase() !== (await purchaseProcessor.getAddress()).toLowerCase()) throw new Error('Game is linked to a different purchase processor');
const linkedDropToken = await freeDrop.baiToken();
if (linkedDropToken === '0x0000000000000000000000000000000000000000') await (await freeDrop.setBAIToken(baiAddress)).wait();
else if (linkedDropToken.toLowerCase() !== baiAddress.toLowerCase()) throw new Error('Free drop is linked to a different BAI token');
let currentSubscription = await vrf.getSubscription(subscriptionId);
if (!currentSubscription.consumers.some((consumer) => consumer.toLowerCase() === gameAddress.toLowerCase())) {
  const tx = await vrf.addConsumer(subscriptionId, gameAddress); await tx.wait(); plan.transactions.addGameVRFConsumer = tx.hash;
}
currentSubscription = await vrf.getSubscription(subscriptionId);
if (!currentSubscription.consumers.some((consumer) => consumer.toLowerCase() === freeDropAddress.toLowerCase())) {
  const tx = await vrf.addConsumer(subscriptionId, freeDropAddress); await tx.wait(); plan.transactions.addFreeDropVRFConsumer = tx.hash;
}
let pairAddress = await factory.getPair(usdt, baiAddress);
if (pairAddress === '0x0000000000000000000000000000000000000000') {
  const pairTx = await factory.createPair(usdt, baiAddress);
  await pairTx.wait();
  pairAddress = await factory.getPair(usdt, baiAddress);
} else {
  const pairCheck = new Contract(pairAddress, ['function token0() view returns(address)','function token1() view returns(address)'], provider);
  const pairTokens = [(await pairCheck.token0()).toLowerCase(), (await pairCheck.token1()).toLowerCase()].sort();
  if (pairTokens[0] !== usdt.toLowerCase() || pairTokens[1] !== baiAddress.toLowerCase()) throw new Error('Existing pair does not match the new BAI and test USDT');
}
plan.external.pair = pairAddress;
const manager = await deploy('BAILiquidityManager', [gameAddress, usdt, baiAddress, routerAddress,
  lpBeneficiary, pairAddress, defaults.observationInterval, defaults.twapPeriod, defaults.maxObservationAge,
  BigInt(defaults.minPoolValue)], 'liquidityManager');
const currentProcessor = await game.liquidityProcessor();
if (currentProcessor === '0x0000000000000000000000000000000000000000') await (await game.setLiquidityProcessor(await manager.getAddress())).wait();
else if (currentProcessor.toLowerCase() !== (await manager.getAddress()).toLowerCase()) throw new Error('Game points at a different liquidity manager');
if ((await token.allowance(signerAddress, routerAddress)) < usdtSeed) await sendAndWait(token.approve(routerAddress, usdtSeed));
const baiAsset = new Contract(baiAddress, ['function approve(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)','function balanceOf(address) view returns(uint256)'], signer);
if ((await baiAsset.balanceOf(signerAddress)) < baiSeed) throw new Error('Deployer BAI balance is below the configured LP seed');
if ((await baiAsset.allowance(signerAddress, routerAddress)) < baiSeed) await sendAndWait(baiAsset.approve(routerAddress, baiSeed));
const pair = new Contract(pairAddress, ['function balanceOf(address) view returns(uint256)'], provider);
let lpAmount = await pair.balanceOf(await manager.getAddress());
let seedReceipt = null;
if (lpAmount === 0n) {
  const seedTx = await router.addLiquidity(baiAddress, usdt, baiSeed, usdtSeed,
    baiSeed * 9_500n / 10_000n, usdtSeed * 9_500n / 10_000n,
    await manager.getAddress(), BigInt(Math.floor(Date.now() / 1000) + 900));
  seedReceipt = await seedTx.wait();
  plan.transactions.seedLiquidity = seedReceipt.hash;
  save({ ...plan, status: 'DEPLOYING' });
  lpAmount = await pair.balanceOf(await manager.getAddress());
}
if (lpAmount === 0n) throw new Error('LP seed created no liquidity shares for the manager');
if (!(await manager.initialLPRecorded())) {
  const lockTx = await manager.lockInitialLP(lpAmount); await lockTx.wait(); plan.transactions.lockInitialLP = lockTx.hash;
  save({ ...plan, status: 'DEPLOYING' });
}
// Seed the first oracle observation, but never keep the deployment process
// alive for the full TWAP window. The production Keeper records observations
// on schedule; readiness can be checked again by rerunning this script later.
const observationInterval = Number(await manager.observationInterval());
const latestBlock = await provider.getBlock('latest');
if (!latestBlock) throw new Error('Could not read the latest testnet block');
const currentObservationSlot = Math.floor(latestBlock.timestamp / observationInterval);
const lastObservationSlot = Number(await manager.lastObservationHour());
if (currentObservationSlot > lastObservationSlot) await sendAndWait(manager.update());
const ready = await manager.marketReady();
const config = {
  chainId: 97, chainName: 'BNB Smart Chain Testnet', nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
  rpcUrls: [publicRpcUrl, 'https://bsc-testnet-rpc.publicnode.com'], blockExplorerUrls: ['https://testnet.bscscan.com'], readRpcUrl: publicRpcUrl, apiBaseUrl: publicApiBaseUrl, walletConnectProjectId,
  contracts: { game: gameAddress, bai: baiAddress, freeDrop: freeDropAddress, metadataRenderer: await renderer.getAddress(), purchaseProcessor: await purchaseProcessor.getAddress(), usdt, router: routerAddress, liquidityManager: await manager.getAddress() }
};
fs.writeFileSync(path.join(root, 'bai-config.js'), `// Public BSC testnet deployment addresses; no secrets.\nwindow.BAI_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`);
let apiReadiness = null;
let apiReadinessError = null;
try {
  const response = await fetch(`${publicApiBaseUrl}/readyz`, { signal: AbortSignal.timeout(8000) });
  apiReadiness = await response.json();
  if (!response.ok || apiReadiness.status !== 'ready' || Number(apiReadiness.chainId) !== 97 ||
      !apiReadiness.features?.includes('buyer_bound_usdt_vaults')) {
    apiReadinessError = `Public API is not ready for BSC Testnet (HTTP ${response.status}, status ${apiReadiness.status || 'unknown'}, chain ${apiReadiness.chainId ?? 'unknown'})`;
  }
} catch (error) {
  const reason = error?.name === 'TimeoutError' ? 'timed out' : error?.message || 'could not be reached';
  apiReadinessError = `Public API /readyz ${reason}; configure and start the backend with the addresses in ${path.relative(root, outputPath)} before enabling purchases`;
}
plan.status = apiReadinessError ? 'DEPLOYED_BACKEND_PENDING' : !ready ? 'DEPLOYED_TWAP_WARMUP' : 'DEPLOYED_READY';
plan.marketReadiness = ready ? 'ready' : 'twap_warmup';
plan.completedAt = new Date().toISOString();
plan.initialLiquidity.lpSharesLocked = lpAmount.toString();
plan.apiReadiness = apiReadinessError ? { status: 'pending', error: apiReadinessError } : { status: 'ready', chainId: Number(apiReadiness.chainId) };
save(plan);
process.stdout.write(`Testnet v12 deployment complete. Market: ${plan.marketReadiness}. Backend: ${plan.apiReadiness.status}. Manifest: ${outputPath}\n`);
if (apiReadinessError) {
  console.error(apiReadinessError);
  process.exitCode = 2;
}
