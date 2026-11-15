import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress, parseUnits, formatEther, formatUnits } from 'ethers';

const root = process.cwd();
const outFile = path.join(root, 'deployments', 'bsc-mainnet-v1.json');
const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
for (const envFile of ['.env.mainnet', '.env']) {
  const filePath = path.join(root, envFile);
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2').replace(/\s+#.*$/, '');
    process.env[match[1]] = value;
  }
}
const defaults = {
  chainId: 56,
  quoteToken: '0x55d398326f99059fF775485246999027B3197955', // Binance-Peg BSC-USD
  router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  coordinator: '0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9',
  vrfKeyHash: '0xeb0f72532fed5c94b4caf7b49caf454b35a729608a441101b9269efb7efe2c6c',
  confirmations: 3,
  observationInterval: 3600,
  twapPeriod: 86400,
  maxObservationAge: 172800,
  initialBai: '400000',
  slippageBps: 500
};
const env = process.env;
const missing = [];
function required(name) {
  const value = env[name]?.trim();
  if (!value) missing.push(name);
  return value;
}
function address(name, value) {
  try { return getAddress(value); } catch { throw new Error(`${name} is not a valid EVM address`); }
}
function integer(name, value, min = 1) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) throw new Error(`${name} must be an integer >= ${min}`);
  return number;
}
function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'mainnet', `${name}.json`), 'utf8'));
}
function save(record) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
}
function writeRuntimeConfig(record, apiBaseUrl) {
  const config = {
    chainId: defaults.chainId,
    chainName: 'BNB Smart Chain Mainnet',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
    blockExplorerUrls: ['https://bscscan.com'],
    readRpcUrl: 'https://bsc-dataseed.bnbchain.org',
    apiBaseUrl,
    contracts: {
      game: record.game,
      bai: record.baiToken,
      freeDrop: record.freeDrop,
      usdt: record.quoteToken,
      router: record.pancakeV2Router,
      liquidityManager: record.liquidityManager
    }
  };
  fs.writeFileSync(path.join(root, 'bai-config.js'), `// Generated after a successful BNB Chain mainnet deployment. Contains public addresses only.\nwindow.BAI_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`);
}
function update(record, key, value) {
  record[key] = value;
  fs.writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
}
async function deployContract(signer, name, constructorArgs, record, key) {
  const build = artifact(name);
  if (record[key]) {
    if (await signer.provider.getCode(record[key]) === '0x') {
      throw new Error(`Recorded ${name} address ${record[key]} has no code; refusing to deploy over a partial record`);
    }
    process.stdout.write(`${name}: resuming at ${record[key]}\n`);
    return new Contract(record[key], build.abi, signer);
  }
  const pending = record.pendingDeployments?.[key];
  if (pending) {
    let receipt = await signer.provider.getTransactionReceipt(pending.hash);
    if (!receipt) {
      const transaction = await signer.provider.getTransaction(pending.hash);
      if (!transaction) throw new Error(`Pending ${name} deployment transaction ${pending.hash} is not available from this RPC; inspect it on BscScan before resuming`);
      receipt = await signer.provider.waitForTransaction(pending.hash, 1);
    }
    if (receipt.status !== 1 || await signer.provider.getCode(pending.address) === '0x') {
      throw new Error(`Recorded ${name} deployment transaction failed; inspect ${pending.hash} before resuming`);
    }
    update(record, key, pending.address);
    delete record.pendingDeployments[key];
    return new Contract(pending.address, build.abi, signer);
  }
  const factory = new ContractFactory(build.abi, build.bytecode, signer);
  const contract = await factory.deploy(...constructorArgs);
  const deploymentTx = contract.deploymentTransaction();
  record.pendingDeployments ||= {};
  record.pendingDeployments[key] = { hash: deploymentTx.hash, address: await contract.getAddress() };
  fs.writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${name} deployment tx: ${deploymentTx.hash}\n`);
  await contract.waitForDeployment();
  const deployed = await contract.getAddress();
  update(record, key, deployed);
  delete record.pendingDeployments[key];
  fs.writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${name}: ${deployed}\n`);
  return contract;
}

if (args.has('--help')) {
  process.stdout.write('Read-only preflight by default. Mainnet deployment requires --execute, complete environment, and typing DEPLOY BSC MAINNET. See README-mainnet-deploy.md.\n');
  process.exit(0);
}

const rpcUrl = required('BSC_MAINNET_RPC_URL');
const privateKeyFile = env.DEPLOYER_PRIVATE_KEY_FILE?.trim();
if (!privateKeyFile && !env.DEPLOYER_PRIVATE_KEY?.trim()) missing.push('DEPLOYER_PRIVATE_KEY_FILE or DEPLOYER_PRIVATE_KEY');
const treasuryInput = required('OPERATIONS_TREASURY');
const subscriptionInput = required('VRF_SUBSCRIPTION_ID');
const callbackGasInput = required('VRF_CALLBACK_GAS_LIMIT');
const initialQuoteInput = required('INITIAL_LIQUIDITY_BSC_USD');
const minPoolInput = required('ORACLE_MIN_POOL_VALUE_USD');
const publicApiInput = required('PUBLIC_API_BASE_URL');
if (missing.length) {
  process.stderr.write(`Missing deployment configuration: ${missing.join(', ')}\n`);
  process.stderr.write('No transaction was sent. Fill the mainnet deployment environment, then rerun the preflight.\n');
  process.exit(2);
}
if (privateKeyFile && !fs.existsSync(privateKeyFile)) throw new Error('DEPLOYER_PRIVATE_KEY_FILE does not point to a readable key file');
const quoteToken = address('QUOTE_TOKEN_ADDRESS', env.QUOTE_TOKEN_ADDRESS || defaults.quoteToken);
const routerAddress = address('PANCAKE_V2_ROUTER', env.PANCAKE_V2_ROUTER || defaults.router);
const coordinatorAddress = address('VRF_COORDINATOR', env.VRF_COORDINATOR || defaults.coordinator);
const treasury = address('OPERATIONS_TREASURY', treasuryInput);
const lpBeneficiaryInput = env.LP_BENEFICIARY || '';
const subscriptionId = BigInt(subscriptionInput);
if (subscriptionId <= 0n) throw new Error('VRF_SUBSCRIPTION_ID must be positive');
const callbackGas = integer('VRF_CALLBACK_GAS_LIMIT', callbackGasInput, 100_000);
if (callbackGas > 2_500_000) throw new Error('VRF_CALLBACK_GAS_LIMIT exceeds the BNB Chain VRF v2.5 maximum of 2500000');
const initialQuote = initialQuoteInput;
if (!/^\d+(\.\d+)?$/.test(initialQuote) || Number(initialQuote) <= 0) throw new Error('INITIAL_LIQUIDITY_BSC_USD must be a positive decimal amount');
const minPool = minPoolInput;
if (!/^\d+$/.test(minPool) || !Number.isSafeInteger(Number(minPool)) || Number(minPool) <= 0) throw new Error('ORACLE_MIN_POOL_VALUE_USD must be a positive whole-dollar amount');
let publicApiBaseUrl;
try {
  const parsed = new URL(publicApiInput);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
  publicApiBaseUrl = parsed.origin;
} catch { throw new Error('PUBLIC_API_BASE_URL must be an HTTPS origin, for example https://api.example.com'); }
const keyHash = env.VRF_KEY_HASH || defaults.vrfKeyHash;
const confirmations = integer('VRF_REQUEST_CONFIRMATIONS', env.VRF_REQUEST_CONFIRMATIONS || defaults.confirmations);
if (!/^0x[0-9a-fA-F]{64}$/.test(keyHash)) throw new Error('VRF_KEY_HASH must be a 32-byte hex value');
if (confirmations < 3 || confirmations > 200) throw new Error('VRF_REQUEST_CONFIRMATIONS must be between 3 and 200 on BNB Chain');
const provider = new JsonRpcProvider(rpcUrl, defaults.chainId, { staticNetwork: true });
const privateKey = privateKeyFile ? fs.readFileSync(privateKeyFile, 'utf8').trim() : env.DEPLOYER_PRIVATE_KEY.trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Private key file must contain exactly one 32-byte hex private key');
const signer = new Wallet(privateKey, provider);
const deployer = await signer.getAddress();
const lpBeneficiary = address('LP_BENEFICIARY', lpBeneficiaryInput || deployer);
if (lpBeneficiary.toLowerCase() !== deployer.toLowerCase()) {
  throw new Error('For this deployment flow, LP_BENEFICIARY must be the deployer: the deployer adds and locks the initial LP.');
}
const chain = await provider.getNetwork();
if (chain.chainId !== BigInt(defaults.chainId)) throw new Error(`RPC is chain ${chain.chainId}, expected BSC mainnet Chain ID 56`);
const [quoteCode, routerCode, coordinatorCode, balance, quoteDecimals, quoteBalance, routerFactory] = await Promise.all([
  provider.getCode(quoteToken), provider.getCode(routerAddress), provider.getCode(coordinatorAddress),
  provider.getBalance(deployer), new Contract(quoteToken, ['function decimals() view returns (uint8)'], provider).decimals(),
  new Contract(quoteToken, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(deployer),
  new Contract(routerAddress, ['function factory() view returns (address)'], provider).factory()
]);
if ([quoteCode, routerCode, coordinatorCode].some((code) => code === '0x')) throw new Error('RPC preflight found missing code at a configured token/router/VRF address');
if ((await provider.getCode(routerFactory)) === '0x') throw new Error('PancakeSwap router returned a factory address without deployed code');
if (Number(quoteDecimals) > 18) throw new Error(`Quote token decimals ${quoteDecimals} exceed contract support`);
const initialQuoteAmount = parseUnits(initialQuote, Number(quoteDecimals));
if (quoteBalance < initialQuoteAmount) {
  throw new Error(`Deployer BSC-USD balance ${quoteBalance} is below the configured initial liquidity ${initialQuote}`);
}
const coord = new Contract(coordinatorAddress, [
  'function getSubscription(uint256) view returns (uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)',
  'function addConsumer(uint256 subId,address consumer)'
], provider);
let subscription;
try { subscription = await coord.getSubscription(subscriptionId); }
catch { throw new Error('VRF subscription does not exist at the configured coordinator'); }
if (subscription.owner.toLowerCase() !== deployer.toLowerCase()) {
  throw new Error(`VRF subscription owner ${subscription.owner} must equal deployer ${deployer}, so the deployment can register both consumers`);
}
if (subscription.nativeBalance === 0n) throw new Error('VRF subscription native BNB balance is zero');
const vrfConsumers = subscription.consumers.map((consumer) => consumer.toLowerCase());

const plan = {
  network: 'BNB Smart Chain Mainnet', chainId: 56, deployer, lpBeneficiary, operationsTreasury: treasury,
  quoteToken, quoteDecimals: Number(quoteDecimals), quoteTokenLabel: 'Binance-Peg BSC-USD',
  pancakeV2Router: routerAddress, pancakeV2Factory: routerFactory, vrfCoordinator: coordinatorAddress,
  vrfSubscriptionId: subscriptionId.toString(), vrfSubscriptionOwner: subscription.owner,
  vrfNativeBalanceWei: subscription.nativeBalance.toString(), vrfConsumerCount: subscription.consumers.length,
  vrfKeyHash: keyHash, vrfRequestConfirmations: confirmations, vrfCallbackGasLimit: callbackGas,
  initialLiquidityBAI: defaults.initialBai, initialLiquidityBSCUSD: initialQuote,
  initialLiquidityBAITaxBps: 200,
  expectedInitialLiquidityBAINet: formatUnits(parseUnits(defaults.initialBai, 18) * 9_800n / 10_000n, 18),
  publicApiBaseUrl,
  oracleMinimumPoolValueUSD: minPool,
  twap: { observationInterval: defaults.observationInterval, period: defaults.twapPeriod, maxObservationAge: defaults.maxObservationAge },
  deployerBNB: formatEther(balance), deployerQuoteBalance: formatUnits(quoteBalance, Number(quoteDecimals)),
  notes: [
    'This script deploys contracts and seeds the initial PancakeSwap V2 liquidity. It does not deploy the web backend or configure DNS.',
    'Sales remain paused until the 24-hour TWAP reaches maturity and the pool floor is satisfied; run the production keeper before opening purchases.',
    'The initial BAI liquidity transfer touches the configured pair and incurs the fixed 2% token tax: 400,000 BAI gross results in approximately 392,000 BAI reaching the pair.',
    'The generated bai-config.js points the public site to the deployed contract addresses and the configured HTTPS card-index API. Publish the reviewed static-site change separately.',
    'BSC-USD is Binance-Peg BSC-USD. The contract purchase path uses the buyBoxes transaction (and token approval), not a plain token transfer to the game address.'
  ]
};
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
let record = null;
if (fs.existsSync(outFile)) {
  record = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  if (record.status === 'DEPLOYED_TWAP_WARMUP') {
    process.stdout.write(`A deployment is already recorded at ${outFile}; this script will not start another deployment.\n`);
    process.exit(0);
  }
}
if (!execute) {
  process.stdout.write(record
    ? `Read-only preflight passed. A partial deployment record exists and can be resumed with --execute: ${outFile}\n`
    : 'Read-only preflight passed. No deployment transaction was sent.\n');
  process.exit(0);
}

execFileSync('node', ['scripts/compile.mjs'], { cwd: root, stdio: 'inherit' });

const rl = readline.createInterface({ input: stdin, output: stdout });
const confirmation = await rl.question('Type DEPLOY BSC MAINNET to send irreversible deployment transactions: ');
rl.close();
if (confirmation !== 'DEPLOY BSC MAINNET') throw new Error('Confirmation did not match; no transaction was sent');

if (record) {
  const immutable = ['chainId','deployer','lpBeneficiary','operationsTreasury','quoteToken','pancakeV2Router',
    'vrfCoordinator','vrfSubscriptionId','vrfKeyHash','vrfRequestConfirmations','vrfCallbackGasLimit',
    'initialLiquidityBAI','initialLiquidityBSCUSD','oracleMinimumPoolValueUSD','publicApiBaseUrl'];
  for (const key of immutable) {
    if (String(record[key]) !== String(plan[key])) throw new Error(`Deployment record does not match current configuration (${key}); refusing to resume`);
  }
  record.status = 'DEPLOYING';
  record.lastResumedAt = new Date().toISOString();
  fs.writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
} else {
  record = { status: 'DEPLOYING', startedAt: new Date().toISOString(), ...plan, contracts: {} };
  save(record);
}
const game = await deployContract(signer, 'BAIBlindBoxGameV2', [quoteToken, coordinatorAddress, keyHash,
  subscriptionId, confirmations, callbackGas, routerAddress], record, 'game');
const freeDrop = await deployContract(signer, 'BAIFreeDrop', [await game.getAddress(), coordinatorAddress,
  keyHash, subscriptionId, confirmations, callbackGas], record, 'freeDrop');
const router = new Contract(routerAddress, [
  'function factory() view returns (address)',
  'function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)'
], signer);
const factory = new Contract(routerFactory, [
  'function getPair(address,address) view returns (address)',
  'function createPair(address,address) returns (address)'
], signer);
const token = await deployContract(signer, 'BAIToken', [routerFactory, quoteToken, deployer, await game.getAddress(),
  await freeDrop.getAddress(), treasury, await game.getAddress()], record, 'baiToken');
const actualToken = await token.getAddress();
const pairView = new Contract(routerFactory, ['function getPair(address,address) view returns (address)'], provider);
let pairAddress = await pairView.getPair(quoteToken, actualToken);
if (pairAddress === '0x0000000000000000000000000000000000000000') {
  await (await factory.createPair(quoteToken, actualToken)).then((tx) => tx.wait());
  pairAddress = await pairView.getPair(quoteToken, actualToken);
}
if (pairAddress === '0x0000000000000000000000000000000000000000') throw new Error('Could not find/create BAI/quote pair');
update(record, 'baiQuotePair', pairAddress);
if ((await game.baiToken()).toLowerCase() !== actualToken.toLowerCase()) {
  await (await (await game.setBAIToken(actualToken)).wait());
}
if ((await freeDrop.baiToken()).toLowerCase() !== actualToken.toLowerCase()) {
  await (await (await freeDrop.setBAIToken(actualToken)).wait());
}
const manager = await deployContract(signer, 'BAILiquidityManager', [await game.getAddress(), quoteToken,
  actualToken, routerAddress, lpBeneficiary, pairAddress, defaults.observationInterval,
  defaults.twapPeriod, defaults.maxObservationAge, BigInt(minPool)], record, 'liquidityManager');
if ((await game.liquidityProcessor()).toLowerCase() !== (await manager.getAddress()).toLowerCase()) {
  await (await (await game.setLiquidityProcessor(await manager.getAddress())).wait());
}
let currentSubscription = await coord.connect(signer).getSubscription(subscriptionId);
if (!currentSubscription.consumers.map((consumer) => consumer.toLowerCase()).includes((await game.getAddress()).toLowerCase())) {
  await (await (await coord.connect(signer).addConsumer(subscriptionId, await game.getAddress())).wait());
}
currentSubscription = await coord.connect(signer).getSubscription(subscriptionId);
if (!currentSubscription.consumers.map((consumer) => consumer.toLowerCase()).includes((await freeDrop.getAddress()).toLowerCase())) {
  await (await (await coord.connect(signer).addConsumer(subscriptionId, await freeDrop.getAddress())).wait());
}

const erc20 = new Contract(quoteToken, [
  'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)'
], signer);
const baiErc20 = new Contract(actualToken, ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], signer);
const quoteAmount = parseUnits(initialQuote, Number(quoteDecimals));
const baiAmount = parseUnits(defaults.initialBai, 18);
if (await erc20.balanceOf(deployer) < quoteAmount) throw new Error('Deployer quote-token balance is below INITIAL_LIQUIDITY_BSC_USD');
if (await baiErc20.balanceOf(deployer) < baiAmount) throw new Error('Deployer BAI balance is below the initial LP allocation');
if ((await erc20.allowance(deployer, routerAddress)) < quoteAmount) {
  await (await (await erc20.approve(routerAddress, quoteAmount)).wait());
}
if ((await baiErc20.allowance(deployer, routerAddress)) < baiAmount) {
  await (await (await baiErc20.approve(routerAddress, baiAmount)).wait());
}
const lp = new Contract(pairAddress, ['function balanceOf(address) view returns (uint256)'], provider);
if (!(await manager.initialLPRecorded()) && (await lp.balanceOf(await manager.getAddress())) === 0n) {
  const tx = await router.addLiquidity(actualToken, quoteToken, baiAmount, quoteAmount,
    baiAmount * 9_500n / 10_000n, quoteAmount * 9_500n / 10_000n,
    await manager.getAddress(), BigInt(Math.floor(Date.now() / 1000) + 900));
  const liquidityReceipt = await tx.wait();
  update(record, 'initialLiquidityTx', liquidityReceipt.hash);
}
const lpBalance = await lp.balanceOf(await manager.getAddress());
if (!(await manager.initialLPRecorded())) {
  if (lpBalance === 0n) throw new Error('Initial LP transaction minted no LP tokens to manager');
  const lockTx = await manager.lockInitialLP(lpBalance);
  await lockTx.wait();
  update(record, 'initialLPLockTx', lockTx.hash);
}
record.status = 'DEPLOYED_TWAP_WARMUP';
record.completedAt = new Date().toISOString();
record.notes.push('Initial liquidity was seeded and LP tokens were locked. Purchases will remain unavailable until the configured TWAP is mature and the pool meets its minimum value.');
writeRuntimeConfig(record, publicApiBaseUrl);
fs.writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`Deployment complete. Record: ${outFile}\n`);
