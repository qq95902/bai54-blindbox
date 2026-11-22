import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import solc from 'solc';
import { AbiCoder, BrowserProvider, ContractFactory, NonceManager, Wallet, ZeroAddress, keccak256, parseEther, formatEther } from 'ethers';

// Local EVM stress simulation only. No BSC RPC, wallet keys, or production funds are used.
const root = path.resolve(import.meta.dirname, '..');
const tempDir = path.join(root, 'sandbox', '.tmp');
fs.mkdirSync(tempDir, { recursive: true });
process.env.TMPDIR = tempDir;
process.env.TEMP = tempDir;
const sources = {};
function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.sol')) sources[path.relative(root, full).split(path.sep).join('/')] = { content: fs.readFileSync(full, 'utf8') };
  }
}
collect(path.join(root, 'contracts'));
sources['sandbox/Mocks.sol'] = { content: fs.readFileSync(path.join(root, 'sandbox/Mocks.sol'), 'utf8') };
const input = {
  language: 'Solidity', sources,
  settings: {
    optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: 'shanghai', metadata: { bytecodeHash: 'none' },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
  }
};
function findImports(importPath) {
  const resolved = importPath.startsWith('@openzeppelin/') ? path.join(root, 'node_modules', importPath) : path.join(root, importPath);
  try { return { contents: fs.readFileSync(resolved, 'utf8') }; }
  catch { return { error: `Import not found: ${importPath}` }; }
}
const compiled = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (compiled.errors ?? []).filter((item) => item.severity === 'error');
if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join('\n'));
const serverModule = await import('ganache');
let chainProvider;
const ganacheOptions = {
  // Permit the local Shanghai build; npm run compile enforces the production EIP-170 limit.
  logging: { quiet: true }, chain: { chainId: 31337, hardfork: 'shanghai', allowUnlimitedContractSize: true },
  miner: { blockGasLimit: 70_000_000, defaultGasPrice: 50_000_000 }, wallet: { totalAccounts: 3_020, defaultBalance: 10_000 }
};
const report = { assertions: 0, operations: {}, invariants: [], timingsMs: {} };
const gasUsage = {};
let provider;
function check(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  report.assertions++;
  report.invariants.push(message);
}
async function expectRevert(action, message) {
  try { await action(); }
  catch { check(true, message); return; }
  throw new Error(`ASSERTION FAILED: ${message}`);
}
async function depositIdFromTransfer(token, receipt, vault) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== (await token.getAddress()).toLowerCase()) continue;
    let parsed;
    try { parsed = token.interface.parseLog(log); } catch { continue; }
    if (parsed?.name === 'Transfer' && parsed.args.to.toLowerCase() === vault.toLowerCase()) {
      return keccak256(AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256'], [receipt.hash, BigInt(log.index ?? log.logIndex)]
      ));
    }
  }
  throw new Error('Could not find the USDT Transfer log to the deposit vault');
}
async function mine(txPromise, phase = 'other') {
  const receipt = await (await txPromise).wait();
  const item = gasUsage[phase] ??= { count: 0, gasUsed: 0n, maxGas: 0n };
  const gasUsed = BigInt(receipt.gasUsed);
  item.count++;
  item.gasUsed += gasUsed;
  if (gasUsed > item.maxGas) item.maxGas = gasUsed;
  return receipt;
}
async function rpc(method, params = []) { return provider.send(method, params); }
function artifact(source, name) {
  const item = compiled.contracts[source]?.[name];
  if (!item?.evm?.bytecode?.object) throw new Error(`Missing bytecode ${source}:${name}`);
  return item;
}
async function deploy(source, name, signer, args = []) {
  const item = artifact(source, name);
  const contract = await new ContractFactory(item.abi, `0x${item.evm.bytecode.object}`, signer).deploy(...args, { gasLimit: 35_000_000 });
  await contract.waitForDeployment();
  return contract;
}
async function eachBatched(items, width, action, label) {
  const started = Date.now();
  let completed = 0;
  report.operations.activePhase = label;
  for (let start = 0; start < items.length; start += width) {
    const batch = items.slice(start, start + width);
    try {
      await Promise.all(batch.map(async (item, offset) => {
        await action(item, start + offset);
        completed++;
      }));
    } catch (error) {
      report.operations.failedPhase = label;
      report.operations.completedInFailedPhase = completed;
      console.error('BATCH_PHASE_FAILURE', JSON.stringify({
        label, completed, name: error?.name, message: error?.shortMessage || error?.message,
        code: error?.code, data: error?.data, reason: error?.reason,
        info: error?.info?.error?.message, transaction: error?.transaction
      }));
      throw error;
    }
    if (completed % 500 === 0 || completed === items.length) {
      process.stderr.write(`${label}: ${completed}/${items.length}\n`);
    }
  }
  report.timingsMs[label] = Date.now() - started;
  delete report.operations.activePhase;
}

try {
chainProvider = serverModule.default.provider(ganacheOptions);
provider = new BrowserProvider(chainProvider);
const initialAccounts = chainProvider.getInitialAccounts();
const keys = Object.values(initialAccounts).map((account) => account.secretKey);
const wallets = keys.map((key) => new NonceManager(new Wallet(key, provider)));
const [admin, ...users] = wallets;
const userAddresses = await Promise.all(users.map((wallet) => wallet.getAddress()));
  const usdt = await deploy('sandbox/Mocks.sol', 'SandboxUSDT', admin);
  const vrf = await deploy('sandbox/Mocks.sol', 'SandboxVRF', admin);
  const factory = await deploy('sandbox/Mocks.sol', 'SandboxFactory', admin);
  const router = await deploy('sandbox/Mocks.sol', 'SandboxRouter', admin, [await usdt.getAddress(), '0x0000000000000000000000000000000000000001']);
  const renderer = await deploy('contracts/BAICardMetadataRenderer.sol', 'BAICardMetadataRenderer', admin);
  const game = await deploy('contracts/BAIBlindBoxGameV2.sol', 'BAIBlindBoxGameV2', admin, [
    await usdt.getAddress(), await vrf.getAddress(), `0x${'11'.repeat(32)}`, 1, 3, 350000,
    await renderer.getAddress()
  ]);
  const drop = await deploy('contracts/BAIFreeDrop.sol', 'BAIFreeDrop', admin, [
    await game.getAddress(), await vrf.getAddress(), `0x${'22'.repeat(32)}`, 1, 3, 350000
  ]);
  const adminAddress = await admin.getAddress();
  const token = await deploy('contracts/BAIToken.sol', 'BAIToken', admin, [
    await factory.getAddress(), await usdt.getAddress(), adminAddress, await game.getAddress(),
    await drop.getAddress(), userAddresses[4], await game.getAddress()
  ]);
  const purchaseProcessor = await deploy('contracts/BAIPurchaseProcessor.sol', 'BAIPurchaseProcessor', admin, [
    await usdt.getAddress(), await game.getAddress(), await router.getAddress(), adminAddress
  ]);
  const processor = await deploy('sandbox/Mocks.sol', 'SandboxLiquidityProcessor', admin, [
    await game.getAddress(), await usdt.getAddress(), await token.getAddress()
  ]);
  check((await token.quoteToken()).toLowerCase() === (await usdt.getAddress()).toLowerCase(), 'BAI immutable quote token matches the deployed USDT contract');
  check((await token.dividendVault()).toLowerCase() === (await game.getAddress()).toLowerCase(), 'BAI immutable dividend vault matches the deployed game contract');
  check((await game.deployer()).toLowerCase() === adminAddress.toLowerCase(), 'game deployer is the Ganache admin account used for one-time wiring');
  await mine(game.setBAIToken(await token.getAddress()));
  await mine(game.setLiquidityProcessor(await processor.getAddress()));
  await mine(game.setPurchaseProcessor(await purchaseProcessor.getAddress()));
  await mine(drop.setBAIToken(await token.getAddress()));
  await mine(processor.setMarketReady(true));
  await mine(usdt.mint(await router.getAddress(), parseEther('1000000')));

  const count = 3_000;
  const claimers = wallets.slice(1, count + 1);
  const buyer = wallets[count + 1]; // reserve one non-player account for market purchases and cap probes
  const extraCapBuyer = wallets[count + 2];
  const freeDay = BigInt(await drop.currentDayId());
  const freeStarted = Date.now();
  await eachBatched(claimers, 25, async (wallet) => mine(drop.connect(wallet).claimFreeBox({ gasLimit: 180_000 }), 'freeClaims'), 'free claim registrations');
  report.operations.freeClaims = count;
  report.timingsMs.freeClaimsTotal = Date.now() - freeStarted;
  check(await drop.totalClaims() === BigInt(count), '3,000 distinct wallets registered exactly one free claim each');
  check(await drop.claimedToday(freeDay, await claimers[0].getAddress()), 'per-wallet/day free-claim replay flag is set');
  try {
    await drop.connect(claimers[0]).claimFreeBox.staticCall();
    throw new Error('same wallet should not register two free claims in one Beijing day');
  } catch (error) {
    if (String(error?.message).includes('same wallet should not register')) throw error;
    report.assertions++;
    report.invariants.push('same wallet cannot register two free claims on the same Beijing day');
  }
  try {
    await drop.connect(wallets[count + 3]).claimFreeBox.staticCall();
    throw new Error('daily free-claim cap should reject claim 3,001');
  } catch (error) {
    if (String(error?.message).includes('daily free-claim cap should reject')) throw error;
    report.assertions++;
    report.invariants.push('claim 3,001 is rejected at the 3,000/day cap');
  }

  // 3,000 paid boxes, split at the on-chain 2,000-box daily limit. The inviter
  // buys one box with BNB, then the other 2,999 players use the real USDT vault,
  // Keeper registration, and permissionless on-chain settlement path.
  const buyStarted = Date.now();
  const perBoxBNB = parseEther('0.01');
  const buyers = wallets.slice(1, count + 1);
  // The inviter must be confirmed on-chain before referrals are sent; concurrent
  // submission would make the simulator depend on miner transaction ordering.
  await mine(purchaseProcessor.connect(buyers[0]).buyWithBNB(1, ZeroAddress, perBoxBNB, { value: perBoxBNB, gasLimit: 500_000 }), 'purchases');
  const directUsdtBuyerAddress = await buyers[1].getAddress();
  const inviterAddress = userAddresses[0];
  const directBuyerVault = await purchaseProcessor.predictVault(directUsdtBuyerAddress, inviterAddress);
  check(directBuyerVault !== ZeroAddress && !(await purchaseProcessor.isDepositVault(directBuyerVault)), 'buyer receives a deterministic personal deposit address without an extra on-chain setup transaction');
  await mine(usdt.mint(directUsdtBuyerAddress, parseEther('10')));
  const directBoxesBefore = await game.nextTokenId();
  const directTransferReceipt = await mine(usdt.connect(buyers[1]).transfer(directBuyerVault, parseEther('10')), 'directUSDTUser');
  const directDepositId = await depositIdFromTransfer(usdt, directTransferReceipt, directBuyerVault);
  await expectRevert(() => purchaseProcessor.connect(admin).registerDeposit.staticCall(
    directDepositId, userAddresses[count + 2], inviterAddress, directBuyerVault, parseEther('10')
  ), 'compromised Keeper cannot assign a funded vault to another buyer');
  await mine(purchaseProcessor.connect(admin).registerDeposit(
    directDepositId, directUsdtBuyerAddress, inviterAddress, directBuyerVault, parseEther('10')
  ), 'directUSDTKeeper');
  const directDeposit = await purchaseProcessor.deposits(directDepositId);
  check(directDeposit.buyer.toLowerCase() === directUsdtBuyerAddress.toLowerCase() && !directDeposit.settled,
    'Keeper registration binds the confirmed USDT transfer to its sender and leaves it pending until settlement');
  await mine(purchaseProcessor.connect(buyers[2]).settleDeposit(directDepositId), 'directUSDTSettlement');
  check((await game.nextTokenId()) === directBoxesBefore + 1n && await game.hasPurchased(directUsdtBuyerAddress),
    'a valid 10 USDT vault transfer settles into exactly one paid box for its sender');
  check(await usdt.balanceOf(directBuyerVault) === 0n && (await purchaseProcessor.deposits(directDepositId)).settled,
    'successful settlement releases the buyer-bound vault funds exactly once');
  await expectRevert(() => purchaseProcessor.connect(admin).registerDeposit.staticCall(
    directDepositId, directUsdtBuyerAddress, inviterAddress, directBuyerVault, parseEther('10')
  ), 'duplicate Keeper registration for one transfer is rejected');
  await expectRevert(() => purchaseProcessor.connect(buyers[2]).settleDeposit.staticCall(directDepositId),
    'a settled USDT deposit cannot mint a second box');
  report.operations.usdtDepositSettlements = 1;

  // Mock-token distribution is fixture setup, not a player transaction. Chunk it
  // to keep calldata bounded and leave the tested transfer/settlement path intact.
  const fixtureFundingStarted = Date.now();
  const buyerAddresses = await Promise.all(buyers.slice(2).map((wallet) => wallet.getAddress()));
  for (let start = 0; start < buyerAddresses.length; start += 100) {
    await mine(usdt.batchMint(buyerAddresses.slice(start, start + 100), parseEther('10')), 'testFixtureFunding');
  }
  report.timingsMs.usdtFixtureFunding = Date.now() - fixtureFundingStarted;

  async function processUsdtDeposits(walletBatch, label) {
    const transfers = await Promise.all(walletBatch.map(async (wallet) => {
      const buyerAddress = await wallet.getAddress();
      const vault = await purchaseProcessor.predictVault(buyerAddress, inviterAddress);
      const receipt = await mine(usdt.connect(wallet).transfer(vault, parseEther('10')), 'directUSDTUser');
      const depositId = await depositIdFromTransfer(usdt, receipt, vault);
      return { wallet, buyerAddress, vault, depositId };
    }));
    // The production Keeper uses a nonce-managed signer; verify that bounded
    // concurrent broadcasts from one keeper account preserve unique nonces.
    await eachBatched(transfers, 25, ({ buyerAddress, vault, depositId }) => mine(
      purchaseProcessor.connect(admin).registerDeposit(depositId, buyerAddress, inviterAddress, vault, parseEther('10')),
      'directUSDTKeeper'
    ), `${label} Keeper registration`);
    await eachBatched(transfers, 25, ({ wallet, depositId }) => mine(
      purchaseProcessor.connect(wallet).settleDeposit(depositId, { gasLimit: 650_000 }),
      'directUSDTSettlement'
    ), `${label} settlement`);
    return transfers.length;
  }

  await processUsdtDeposits(buyers.slice(2, 2_000), 'paid USDT deposits day 1');
  const firstGameDay = BigInt(await drop.currentDayId());
  check((await game.rounds(firstGameDay)).boxCount === 2_000n, 'first purchase round stops exactly at 2,000 boxes');
  await rpc('evm_increaseTime', [24 * 60 * 60]);
  await rpc('evm_mine');
  const secondGameDay = BigInt(await drop.currentDayId());
  check(secondGameDay === firstGameDay + 1n, 'Beijing day rollover opens a new independent box-round cap');
  await processUsdtDeposits(buyers.slice(2_000), 'paid USDT deposits day 2');
  // Exercise the exact per-wallet limit and the next-box rejection on day 2.
  const maxTen = 10;
  await mine(purchaseProcessor.connect(extraCapBuyer).buyWithBNB(maxTen, ZeroAddress, perBoxBNB * 10n, { value: perBoxBNB * 10n, gasLimit: 4_000_000 }), 'capProbe');
  try {
    await purchaseProcessor.connect(extraCapBuyer).buyWithBNB.staticCall(1, ZeroAddress, perBoxBNB, { value: perBoxBNB });
    throw new Error('11th daily box should be rejected');
  } catch (error) {
    if (String(error?.message).includes('11th daily box should be rejected')) throw error;
    report.assertions++;
    report.invariants.push('wallet purchase 11 is rejected after buying 10/day');
  }
  report.operations.paidPlayerPurchases = count;
  report.operations.capProbeBoxes = 10;
  report.timingsMs.purchasesTotal = Date.now() - buyStarted;
  check((await game.rounds(firstGameDay)).boxCount === 2_000n, 'first-day global sale cap remains exactly 2,000');
  check((await game.rounds(secondGameDay)).boxCount === 1_010n, 'second-day purchases include 1,000 players plus 10-cap probe');
  check(await game.pendingReferralUSDT(userAddresses[0]) === parseEther('8997'), 'one-level inviter liability equals 2,999 referred boxes × 3 USDT');
  check(await game.totalReferralLiability() === parseEther('8997'), 'round referral liabilities equal the inviter balance and are not counted as prizes');
  check((await usdt.balanceOf(await game.getAddress())) === parseEther('30100'), 'BNB and direct USDT routes deliver exactly 3,010 boxes × 10 USDT to the game');

  // After both Beijing sales days close, execute VRF callbacks and bounded settlement batches.
  await rpc('evm_increaseTime', [48 * 60 * 60]);
  await rpc('evm_mine');
  await mine(drop.requestDailyDraw(freeDay, { gasLimit: 350_000 }), 'freeDraw');
  const freeRequest = await drop.activeRequestForDay(freeDay);
  await mine(vrf.fulfill(freeRequest, 0x9a78123n, { gasLimit: 2_000_000 }), 'freeDraw');
  for (let from = 0; from < count; from += 50) await mine(drop.settleBatch(from, Math.min(50, count - from), { gasLimit: 10_000_000 }), 'freeSettlement');
  check(await drop.totalSettled() === BigInt(count), '3,000 free rewards settle with the contract-enforced maximum batch size of 50');
  check(await drop.pendingRewardReserve() === 0n, 'all 3,000 free rewards transfer directly because each claimant completed a paid purchase');
  report.operations.freeRewardSettlementBatches = Math.ceil(count / 50);

  const drawDay1 = async (dayId, boxCount, seed) => {
    await mine(game.requestDraw(dayId, { gasLimit: 500_000 }), 'paidDraw');
    const request = await game.requestForDay(dayId);
    await mine(vrf.fulfill(request, seed, { gasLimit: 2_000_000 }), 'paidDraw');
    await mine(game.loadRandomness(dayId, { gasLimit: 500_000 }), 'paidDraw');
    for (let from = 0; from < boxCount; from += 50) await mine(game.settleBatch(dayId, from, Math.min(50, boxCount - from), { gasLimit: 10_000_000 }), 'paidSettlement');
    await mine(game.finalizeDraw(dayId, { gasLimit: 2_000_000 }), 'paidDraw');
    check((await game.rounds(dayId)).finalized && (await game.rounds(dayId)).settledCount === BigInt(boxCount), `round ${dayId} VRF draw and ${boxCount} box settlements finalize`);
  };
  const drawStarted = Date.now();
  await drawDay1(firstGameDay, 2_000, 0xabcde123n);
  await drawDay1(secondGameDay, 1_010, 0x456789abn);
  report.operations.paidBoxRevealBatches = Math.ceil(2_000 / 50) + Math.ceil(1_010 / 50);
  report.timingsMs.drawAndSettlement = Date.now() - drawStarted;
  check((await game.nextTokenId()) === 3_011n, '3,010 paid boxes are minted exactly once with contiguous token IDs');
  check(await token.balanceOf(await game.getAddress()) >= await game.reservedBAI(), 'game BAI inventory covers all outstanding reward/dividend/synthesis liabilities');

  // Verify purchase replay and the direct-transfer-vs-purchase distinction.
  const countBeforeTransfer = await game.nextTokenId();
  await mine(usdt.mint(await claimers[0].getAddress(), parseEther('10')));
  await mine(usdt.connect(claimers[0]).transfer(await game.getAddress(), parseEther('10')));
  check(await game.nextTokenId() === countBeforeTransfer, 'direct USDT transfers to the game do not mint boxes or bypass purchase checks');

  // Real-processor invalid and expired deposits must return funds without minting boxes.
  const refundBuyer = wallets[count + 3];
  const refundBuyerAddress = await refundBuyer.getAddress();
  await mine(usdt.mint(refundBuyerAddress, parseEther('200')));
  const refundVault = await purchaseProcessor.predictVault(refundBuyerAddress, inviterAddress);
  const boxesBeforeRefundScenarios = await game.nextTokenId();
  const invalidAmounts = [parseEther('5'), parseEther('110')];
  for (const amount of invalidAmounts) {
    const balanceBefore = await usdt.balanceOf(refundBuyerAddress);
    const transferReceipt = await mine(usdt.connect(refundBuyer).transfer(refundVault, amount), 'directUSDTRefundProbe');
    const depositId = await depositIdFromTransfer(usdt, transferReceipt, refundVault);
    await mine(purchaseProcessor.connect(admin).registerDeposit(depositId, refundBuyerAddress, inviterAddress, refundVault, amount), 'directUSDTKeeper');
    await mine(purchaseProcessor.connect(admin).refundInvalidDeposit(depositId), 'directUSDTKeeper');
    check(await usdt.balanceOf(refundBuyerAddress) === balanceBefore,
      amount === parseEther('5') ? 'underpayment is refunded in full without a card' : 'deposit above the 10-box cap is refunded in full without a card');
    check((await purchaseProcessor.deposits(depositId)).refunded, 'invalid deposit is marked refunded and cannot be replayed');
    await expectRevert(() => purchaseProcessor.connect(admin).refundInvalidDeposit.staticCall(depositId),
      'invalid-deposit refund cannot be claimed twice');
  }
  const expiredAmount = parseEther('10');
  const expiredTransfer = await mine(usdt.connect(refundBuyer).transfer(refundVault, expiredAmount), 'directUSDTRefundProbe');
  const expiredDepositId = await depositIdFromTransfer(usdt, expiredTransfer, refundVault);
  await mine(purchaseProcessor.connect(admin).registerDeposit(expiredDepositId, refundBuyerAddress, inviterAddress, refundVault, expiredAmount), 'directUSDTKeeper');
  await expectRevert(() => purchaseProcessor.connect(refundBuyer).refundExpiredDeposit.staticCall(expiredDepositId),
    'valid deposit cannot be refunded before the 24-hour timeout');
  await rpc('evm_increaseTime', [24 * 60 * 60 + 1]);
  await rpc('evm_mine');
  await expectRevert(() => purchaseProcessor.connect(refundBuyer).settleDeposit.staticCall(expiredDepositId),
    'expired deposit cannot settle into a late box');
  const expiredBalanceBefore = await usdt.balanceOf(refundBuyerAddress);
  await mine(purchaseProcessor.connect(refundBuyer).refundExpiredDeposit(expiredDepositId), 'directUSDTKeeper');
  check(await usdt.balanceOf(refundBuyerAddress) === expiredBalanceBefore + expiredAmount,
    'anyone can reclaim a valid but unsettled deposit after 24 hours');
  check(await game.nextTokenId() === boxesBeforeRefundScenarios,
    'invalid and expired USDT deposit paths never mint cards');
  report.operations.invalidDepositRefunds = 2;
  report.operations.expiredDepositRefunds = 1;
  report.operations.usdtDepositTransfers = 2_999;
  report.operations.usdtKeeperRegistrations = 2_999;
  report.operations.usdtDepositSettlements = 2_999;

  // One-level commission is a pull-payment; the inviter withdraws once and cannot replay.
  const inviterBefore = await usdt.balanceOf(userAddresses[0]);
  await mine(game.connect(buyers[0]).claimReferralCommission({ gasLimit: 300_000 }), 'referralClaim');
  check(await usdt.balanceOf(userAddresses[0]) === inviterBefore + parseEther('8997'), 'direct inviter can withdraw the exact 8,997 USDT liability once');
  check(await game.totalReferralLiability() === 0n, 'referral liability clears after the pull withdrawal');

  // Cards trade on the real escrow market. Use losing cards only; all buyer USDT is local mock currency.
  const marketBuyerAddress = await buyer.getAddress();
  const marketBuyers = wallets.slice(count + 1, count + 21);
  const fundingStarted = Date.now();
  for (let index = 0; index < marketBuyers.length; index++) {
    const wallet = marketBuyers[index];
    const address = await wallet.getAddress();
    await mine(usdt.mint(address, parseEther('1000')), 'marketFunding');
    if ((index + 1) % 5 === 0 || index + 1 === marketBuyers.length) {
      process.stderr.write(`market buyer funding: ${index + 1}/${marketBuyers.length}\n`);
    }
  }
  report.timingsMs.marketFunding = Date.now() - fundingStarted;
  await eachBatched(marketBuyers, marketBuyers.length, async (wallet) => {
    await mine(usdt.connect(wallet).approve(await game.getAddress(), parseEther('1000')), 'marketApprovals');
  }, 'market buyer approvals');
  const listingIds = [];
  for (let id = 1; id <= 3_010 && listingIds.length < 200; id++) {
    if (!(await game.isWinningBox(id))) listingIds.push(id);
  }
  if (listingIds.length < 200) throw new Error(`Only ${listingIds.length} losing cards available for market load`);
  const walletByAddress = new Map(await Promise.all(wallets.map(async (wallet) => [
    (await wallet.getAddress()).toLowerCase(), wallet
  ])));
  const sellerFor = async (id) => {
    const owner = (await game.ownerOf(id)).toLowerCase();
    const seller = walletByAddress.get(owner);
    if (!seller) throw new Error(`No signer for on-chain card owner ${owner}, token ${id}`);
    return seller;
  };
  const marketStarted = Date.now();
  await eachBatched(listingIds, 20, async (id) => mine(game.connect(await sellerFor(id)).listCard(id, parseEther('1'), { gasLimit: 350_000 }), 'marketListings'), 'card listings');
  await eachBatched(listingIds, marketBuyers.length, async (id, index) => {
    const marketBuyer = marketBuyers[index % marketBuyers.length];
    return mine(game.connect(marketBuyer).buyListedCard(id, { gasLimit: 350_000 }), 'marketTrades');
  }, 'card trades');
  report.operations.marketListings = listingIds.length;
  report.operations.marketTrades = listingIds.length;
  report.timingsMs.market = Date.now() - marketStarted;
  const finalMarketBuyer = await marketBuyers[(listingIds.length - 1) % marketBuyers.length].getAddress();
  check((await game.ownerOf(listingIds.at(-1))).toLowerCase() === finalMarketBuyer.toLowerCase(), 'market escrow settles 200 purchases and transfers ownership to buyers');
  const cancelId = listingIds[0];
  await mine(game.connect(buyer).listCard(cancelId, parseEther('2'), { gasLimit: 350_000 }), 'marketListings');
  await mine(game.connect(buyer).cancelCardListing(cancelId, { gasLimit: 350_000 }), 'marketCancellations');
  check((await game.ownerOf(cancelId)).toLowerCase() === marketBuyerAddress.toLowerCase(), 'cancelled market listing restores the seller card');
  report.operations.marketCancellations = 1;

  // Synthesis uses 80 distinct eligible losing inputs: half succeed, half fail, all consume inputs/fee once.
  const synthesisCount = 50;
  const synthesisInputs = [];
  for (let id = 1; id <= 3_010 && synthesisInputs.length < synthesisCount * 4 + 4; id++) {
    if (!(await game.isWinningBox(id)) && !listingIds.includes(id)) synthesisInputs.push(id);
  }
  if (synthesisInputs.length !== synthesisCount * 4 + 4) throw new Error('Not enough non-winning cards for synthesis scenarios');
  for (let index = 0; index < synthesisInputs.length; index++) {
    const id = synthesisInputs[index];
    const seller = await sellerFor(id);
    if (!(await game.baiRewardClaimed(id))) {
      await mine(game.connect(seller).claimBAIReward(id, { gasLimit: 250_000 }), 'synthesisInputRewards');
    }
    await mine(game.connect(seller).transferFrom(await seller.getAddress(), adminAddress, id, { gasLimit: 300_000 }), 'synthesisInputs');
  }
  await mine(token.approve(await game.getAddress(), parseEther('1000')));
  const synthesisStarted = Date.now();
  let synthSuccess = 0;
  let synthFailure = 0;
  for (let i = 0; i < synthesisCount; i++) {
    const ids = synthesisInputs.slice(i * 4, i * 4 + 4);
    await mine(game.requestSynthesis(ids, { gasLimit: 1_000_000 }), 'synthesis');
    const synthId = await game.nextSynthesisId() - 1n;
    const request = await game.requestForForge(synthId);
    await mine(vrf.fulfill(request, i % 2 === 0 ? 0x100n : 0x101n, { gasLimit: 1_000_000 }), 'synthesis');
    const receipt = await mine(game.completeSynthesis(synthId, { gasLimit: 1_000_000 }), 'synthesis');
    const event = receipt.logs.map((log) => { try { return game.interface.parseLog(log); } catch { return null; } })
      .find((parsed) => parsed?.name === 'SynthesisCompleted');
    if (event?.args?.outputTokenId > 0n) synthSuccess++;
    else synthFailure++;
  }
  report.timingsMs.synthesis = Date.now() - synthesisStarted;
  report.operations.synthesisAttempts = synthesisCount;
  report.operations.synthesisSuccess = synthSuccess;
  report.operations.synthesisFailure = synthFailure;
  check(synthSuccess === 25 && synthFailure === 25, '50 synthesis requests in one Beijing day include both outcomes and consume exactly four inputs plus one fee each');
  check(await game.pendingSynthesisFees() === 0n, 'completed syntheses leave no stranded fee liability');
  try {
    await game.requestSynthesis.staticCall(synthesisInputs.slice(200, 204));
    throw new Error('51st synthesis request should be rejected at the daily cap');
  } catch (error) {
    if (String(error?.message).includes('51st synthesis request should be rejected')) throw error;
    check(true, '51st synthesis VRF request is rejected at the on-chain daily cap');
  }
  await rpc('evm_increaseTime', [24 * 60 * 60]);
  await rpc('evm_mine');
  const synthesisNextDay = await game.requestSynthesis(synthesisInputs.slice(200, 204), { gasLimit: 1_000_000 });
  await mine(Promise.resolve(synthesisNextDay), 'synthesisNextDay');
  const nextDaySynthesisId = await game.nextSynthesisId() - 1n;
  const nextDaySynthesisRequest = await game.requestForForge(nextDaySynthesisId);
  await mine(vrf.fulfill(nextDaySynthesisRequest, 0x102n, { gasLimit: 1_000_000 }), 'synthesisNextDay');
  await mine(game.completeSynthesis(nextDaySynthesisId, { gasLimit: 1_000_000 }), 'synthesisNextDay');
  check(await game.pendingSynthesisFees() === 0n, 'synthesis request quota resets on the next Beijing day');

  // Dividend tax, day-start snapshot, claims and final rounding-dust accounting.
  await rpc('evm_increaseTime', [24 * 60 * 60]);
  await rpc('evm_mine');
  const dividendDay = BigInt(await drop.currentDayId());
  await mine(factory.setPair(marketBuyerAddress));
  await mine(token.transfer(marketBuyerAddress, parseEther('100')));
  check(await game.dailyDividendPool(dividendDay) === parseEther('1'), '2% BAI pair tax routes exactly 1% to the dividend pool');
  check(await token.balanceOf(userAddresses[4]) >= parseEther('1'), '1% BAI operations tax reaches the configured treasury');
  await rpc('evm_increaseTime', [24 * 60 * 60]);
  await rpc('evm_mine');
  const eligible = [];
  const dividendCandidates = wallets.slice(1);
  for (let start = 0; start < dividendCandidates.length; start += 50) {
    const batch = dividendCandidates.slice(start, start + 50);
    const batchAddresses = await Promise.all(batch.map((wallet) => wallet.getAddress()));
    const weights = await Promise.all(batchAddresses.map((address) => game.dividendWeightOf(address)));
    for (let i = 0; i < batch.length; i++) {
      if (weights[i] > 0n && await game.claimableDividend(dividendDay, batchAddresses[i]) > 0n) eligible.push(batch[i]);
    }
  }
  if (await game.dividendWeightOf(adminAddress) > 0n && await game.claimableDividend(dividendDay, adminAddress) > 0n) eligible.push(admin);
  if (!eligible.length) throw new Error('No dividend-eligible S/SS/SSSR holders after reveal');
  const dividendStarted = Date.now();
  await eachBatched(eligible, 20, async (wallet) => mine(game.connect(wallet).claimDividend(dividendDay, { gasLimit: 300_000 }), 'dividends'), 'dividend claims');
  report.timingsMs.dividend = Date.now() - dividendStarted;
  report.operations.dividendClaimants = eligible.length;
  check(await game.dividendClaimedAmount(dividendDay) === parseEther('1'), 'dividend claimants receive the pool exactly, including rounding remainder');
  check(await game.totalDividendLiability() === 0n, 'dividend liability clears completely after the last eligible holder claims');

  // Check final prize pool, liquidity release and all major accounting reserves.
  for (const dayId of [firstGameDay, secondGameDay]) {
    const round = await game.rounds(dayId);
    check(round.boxCount > 0n && round.totalUSDT === round.boxCount * parseEther('10'), `round ${dayId} collected exactly 10 USDT for every paid box`);
    const prizeBudget = round.totalUSDT * 2_200n / 10_000n;
    const referralLiability = await game.referralUSDTByRound(dayId);
    check(round.liquidityBudget + prizeBudget + referralLiability === round.totalUSDT,
      `round ${dayId} prize, liquidity, and referral allocations never exceed collected USDT`);
    await mine(processor.processLiquidity(dayId, { gasLimit: 300_000 }));
    check(await processor.released(dayId) === round.liquidityBudget, `round ${dayId} liquidity is released once for the computed budget`);
  }
  check(await token.balanceOf(await game.getAddress()) >= await game.reservedBAI(), 'final BAI reserve remains solvent after free claims, syntheses, and dividends');
  report.operations.uniqueFreeClaimers = count;
  report.operations.totalPaidBoxes = 3_010;
  report.operations.draws = 2;
  const scenarioGasPriceGwei = Number(process.env.BAI_BSC_SCENARIO_GAS_PRICE_GWEI || 0.05);
  const modeledGasPriceWei = BigInt(Math.round(scenarioGasPriceGwei * 1_000_000_000));
  const gasProfile = Object.fromEntries(Object.entries(gasUsage).map(([phase, item]) => [phase, {
    transactions: item.count,
    totalGas: item.gasUsed.toString(),
    averageGas: Math.round(Number(item.gasUsed) / item.count),
    maxGas: item.maxGas.toString(),
    totalFeeBNBAtScenarioGasPrice: formatEther(item.gasUsed * modeledGasPriceWei)
  }]));
  const playerTransactionsGas = gasUsage.freeClaims.gasUsed + gasUsage.purchases.gasUsed + (gasUsage.directUSDTUser?.gasUsed ?? 0n);
  const playerTransactionsCount = gasUsage.freeClaims.count + gasUsage.purchases.count + (gasUsage.directUSDTUser?.count ?? 0);
  // Keep this deterministic load test independent from RPC availability. Live
  // snapshots may be passed explicitly, with their sampling source recorded below.
  const scenarioBlockGasLimit = Number(process.env.BAI_BSC_SCENARIO_BLOCK_GAS_LIMIT || 70_000_000);
  const scenarioUtilizationPct = Number(process.env.BAI_BSC_SCENARIO_UTILIZATION_PCT || 31.94);
  const scenarioBlockIntervalSeconds = Number(process.env.BAI_BSC_SCENARIO_BLOCK_INTERVAL_SECONDS || 0.45);
  const scenarioSource = process.env.BAI_BSC_SCENARIO_SOURCE?.trim() || 'fixed scenario inputs; NOT a live BSC snapshot';
  if (![scenarioGasPriceGwei, scenarioBlockGasLimit, scenarioUtilizationPct, scenarioBlockIntervalSeconds].every(Number.isFinite) ||
      scenarioGasPriceGwei <= 0 || scenarioBlockGasLimit <= 0 || scenarioUtilizationPct < 0 || scenarioUtilizationPct >= 100 ||
      scenarioBlockIntervalSeconds <= 0) throw new Error('Invalid BSC scenario parameters');
  const scenarioHeadroomPerBlock = scenarioBlockGasLimit * (1 - scenarioUtilizationPct / 100);
  const estimatedBlocksAtScenarioHeadroom = Math.ceil(Number(playerTransactionsGas) / scenarioHeadroomPerBlock);
  const allTestedGas = Object.values(gasUsage).reduce((sum, item) => sum + item.gasUsed, 0n);
  const allTestedTransactionCount = Object.values(gasUsage).reduce((sum, item) => sum + item.count, 0);
  const estimatedAllMeasuredBlocksAtScenarioHeadroom = Math.ceil(Number(allTestedGas) / scenarioHeadroomPerBlock);
  console.log(JSON.stringify({
    result: 'PASS', network: 'Ganache local EVM (chain 31337)', liveChainUsed: false,
    accounts: 3_020, freeClaimDay: freeDay.toString(), paidRoundDays: [firstGameDay.toString(), secondGameDay.toString()],
    operations: report.operations, timingsMs: report.timingsMs, assertions: report.assertions,
    bscMainnetProjection: {
      scenarioAssumptions: {
        source: scenarioSource,
        blockGasLimit: scenarioBlockGasLimit,
        averageGasUsedPct: scenarioUtilizationPct,
        gasPriceGwei: scenarioGasPriceGwei,
        blockIntervalSeconds: scenarioBlockIntervalSeconds
      },
      measuredGasProfile: gasProfile,
      playerTransactions: {
        count: playerTransactionsCount,
        gasUsed: playerTransactionsGas.toString(),
        totalFeeBNBAtScenarioGasPrice: formatEther(playerTransactionsGas * modeledGasPriceWei),
        estimatedBlocksAtScenarioHeadroom,
        estimatedDrainTimeSecondsAtScenarioBlockInterval: Number((estimatedBlocksAtScenarioHeadroom * scenarioBlockIntervalSeconds).toFixed(2))
      },
      allMeasuredTransactions: {
        count: allTestedTransactionCount,
        gasUsed: allTestedGas.toString(),
        totalFeeBNBAtScenarioGasPrice: formatEther(allTestedGas * modeledGasPriceWei),
        estimatedBlocksAtScenarioHeadroom: estimatedAllMeasuredBlocksAtScenarioHeadroom,
        estimatedDrainTimeSecondsAtScenarioBlockInterval: Number((estimatedAllMeasuredBlocksAtScenarioHeadroom * scenarioBlockIntervalSeconds).toFixed(2))
      },
      caveat: 'Projection applies measured local-EVM gas to the recorded assumed or sampled block headroom. It is not a throughput benchmark and does not reproduce mainnet mempool ordering, RPC limits, wallet signing delays, or backend throughput.'
    },
    invariants: report.invariants,
    finalAccounting: {
      totalFreeClaims: String(await drop.totalClaims()), totalFreeSettled: String(await drop.totalSettled()),
      freePendingReserve: formatEther(await drop.pendingRewardReserve()),
      referralLiability: formatEther(await game.totalReferralLiability()),
      dividendLiability: formatEther(await game.totalDividendLiability()),
      pendingSynthesisFees: formatEther(await game.pendingSynthesisFees()),
      gameBAIBalance: formatEther(await token.balanceOf(await game.getAddress())),
      gameReservedBAI: formatEther(await game.reservedBAI())
    }
  }, null, 2));
} catch (error) {
  console.error('LOAD_SANDBOX_FAILURE', JSON.stringify({
    name: error?.name,
    message: error?.shortMessage || error?.message || String(error),
    code: error?.code,
    data: error?.data,
    reason: error?.reason,
    info: error?.info?.error?.message,
    operations: report.operations,
    lastInvariant: report.invariants.at(-1)
  }));
  process.exitCode = 1;
} finally {
  await chainProvider?.disconnect();
}
