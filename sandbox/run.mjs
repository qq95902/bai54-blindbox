import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import solc from 'solc';
import { AbiCoder, BrowserProvider, ContractFactory, keccak256, parseEther, formatEther, ZeroAddress } from 'ethers';
import { resolveClientIp } from '../backend/src/client-ip.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = path.join(root, 'sandbox', '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const tempDir = fs.mkdtempSync(path.join(tempRoot, 'ganache-'));
process.env.TMPDIR = tempDir;
process.env.TEMP = tempDir;
const { default: ganache } = await import('ganache');
const sources = {};
function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.sol')) {
      const key = path.relative(root, full).split(path.sep).join('/');
      sources[key] = { content: fs.readFileSync(full, 'utf8') };
    }
  }
}
collect(path.join(root, 'contracts'));
sources['sandbox/Mocks.sol'] = { content: fs.readFileSync(path.join(root, 'sandbox/Mocks.sol'), 'utf8') };
const input = {
  language: 'Solidity', sources,
  settings: {
    optimizer: { enabled: true, runs: 1 },
    viaIR: true,
    evmVersion: 'shanghai',
    metadata: { bytecodeHash: 'none' },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
  }
};
function findImports(importPath) {
  const resolved = importPath.startsWith('@openzeppelin/')
    ? path.join(root, 'node_modules', importPath)
    : path.join(root, importPath);
  try { return { contents: fs.readFileSync(resolved, 'utf8') }; }
  catch { return { error: `Import not found: ${importPath}` }; }
}
const compiled = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const diagnostics = (compiled.errors ?? []).filter((item) => item.severity === 'error');
if (diagnostics.length) throw new Error(diagnostics.map((x) => x.formattedMessage).join('\n'));
const warnings = (compiled.errors ?? []).filter((item) => item.severity === 'warning');

let chainProvider;
const ganacheOptions = {
  logging: { quiet: true },
  // The sandbox compiler targets Shanghai for Ganache compatibility. The production build is
  // separately checked against EIP-170 using the compiler's BSC-targeted default EVM version.
  chain: { chainId: 31337, hardfork: 'shanghai', allowUnlimitedContractSize: true },
  miner: { blockGasLimit: 40_000_000 },
  wallet: { totalAccounts: 8, defaultBalance: 100_000 }
};
let passed = 0;
const report = [];
try {
chainProvider = ganache.provider(ganacheOptions);
const provider = new BrowserProvider(chainProvider);
const signers = await Promise.all(Array.from({ length: 7 }, (_, i) => provider.getSigner(i)));
const [admin, alice, bob, carol, buyer, outsider, purchaseKeeper] = signers;
const addresses = await Promise.all(signers.map((s) => s.getAddress()));
function ok(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  passed++;
  report.push(`PASS ${message}`);
}
async function expectRevert(label, action) {
  try {
    const result = await action();
    if (result?.wait) await result.wait();
    throw new Error(`Expected revert: ${label}`);
  } catch (error) {
    if (String(error?.message ?? error).includes(`Expected revert: ${label}`)) throw error;
    passed++;
    report.push(`PASS revert guard: ${label}`);
  }
}
function artifact(source, name) {
  const a = compiled.contracts[source]?.[name];
  if (!a?.evm?.bytecode?.object) throw new Error(`No bytecode for ${source}:${name}`);
  return a;
}
async function deploy(source, name, signer, args = []) {
  const a = artifact(source, name);
  const factory = new ContractFactory(a.abi, `0x${a.evm.bytecode.object}`, signer);
  const contract = await factory.deploy(...args, { gasLimit: 35_000_000 });
  await contract.waitForDeployment();
  return contract;
}
async function tx(promise) { const response = await promise; return response.wait(); }
async function rpc(method, params = []) { return provider.send(method, params); }

ok(resolveClientIp('203.0.113.10', '198.51.100.2', ['10.0.0.10']) === '203.0.113.10',
  'untrusted clients cannot spoof X-Forwarded-For to evade API rate limits');
ok(resolveClientIp('10.0.0.10', '198.51.100.2', ['10.0.0.10']) === '198.51.100.2',
  'trusted load balancer forwards each client address for independent API rate limiting');
ok(resolveClientIp('10.0.0.10', '192.0.2.99, 198.51.100.7, 10.0.0.11', ['10.0.0.10', '10.0.0.11']) === '198.51.100.7',
  'multi-proxy forwarding strips trusted hops and ignores a spoofed leftmost address');
ok(resolveClientIp('10.0.0.10', 'invalid-value', ['10.0.0.10']) === '10.0.0.10',
  'malformed proxy headers fall back to the trusted proxy address');

function findGameSeed(day) {
  const coder = AbiCoder.defaultAbiCoder();
  const seedOffset = BigInt(process.env.SANDBOX_SEED_OFFSET || '1');
  if (seedOffset < 1n || seedOffset >= 100_000n) throw new Error('SANDBOX_SEED_OFFSET must be 1..99999');
  for (let candidate = seedOffset; candidate < 100_000n; candidate++) {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    let mask = (1n << 52n) | (1n << 53n);
    for (let i = 0; i < 12; i++) {
      const hash = BigInt(keccak256(coder.encode(['uint256', 'uint64', 'uint256', 'string'], [candidate, day, i, 'WIN'])));
      const j = i + Number(hash % BigInt(52 - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
      mask |= 1n << BigInt(deck[i]);
    }
    let aliceLosses = 0;
    let bobLosses = 0;
    let wins = 0;
    let aliceWins = 0;
    let specialCards = 0;
    let aliceSpecials = 0;
    let bobSpecials = 0;
    for (let id = 1; id <= 20; id++) {
      const face = Number(BigInt(keccak256(coder.encode(['uint256', 'uint64', 'uint256'], [candidate, day, id]))) % 54n);
      const won = (mask & (1n << BigInt(face))) !== 0n;
      if (won) { wins++; if (id <= 10) aliceWins++; }
      if (face >= 52) {
        specialCards++;
        if (id <= 10) aliceSpecials++;
        else bobSpecials++;
      }
      else if (!won && id <= 10) aliceLosses++;
      else if (!won) bobLosses++;
    }
    if (wins >= 1 && aliceWins > 0 && specialCards === 3 && aliceSpecials > 0 && bobSpecials > 0 &&
        aliceLosses >= 6 && bobLosses >= 6) return candidate;
  }
  throw new Error('Unable to find deterministic sandbox seed');
}

  const usdt = await deploy('sandbox/Mocks.sol', 'SandboxUSDT', admin);
  const vrf = await deploy('sandbox/Mocks.sol', 'SandboxVRF', admin);
  const factory = await deploy('sandbox/Mocks.sol', 'SandboxFactory', admin);
  const router = await deploy('sandbox/Mocks.sol', 'SandboxRouter', admin, [await usdt.getAddress(), '0x0000000000000000000000000000000000000001']);
  const metadataRenderer = await deploy('contracts/BAICardMetadataRenderer.sol', 'BAICardMetadataRenderer', admin);
  const classicJson = JSON.parse(Buffer.from((await metadataRenderer.tokenURI(1, 0, 0, false, false, 1)).split(',')[1], 'base64').toString('utf8'));
  const neonJson = JSON.parse(Buffer.from((await metadataRenderer.tokenURI(2, 1, 0, false, false, 1)).split(',')[1], 'base64').toString('utf8'));
  ok(classicJson.attributes.some((item) => item.trait_type === 'Style' && item.value === 'Classic') &&
    neonJson.attributes.some((item) => item.trait_type === 'Style' && item.value === 'Neon'),
    'four skin variants are represented as distinct NFT metadata traits');
  const game = await deploy('contracts/BAIBlindBoxGameV2.sol', 'BAIBlindBoxGameV2', admin, [
    await usdt.getAddress(), await vrf.getAddress(), `0x${'11'.repeat(32)}`, 1, 3, 350000, await metadataRenderer.getAddress()
  ]);
  const purchaseProcessor = await deploy('contracts/BAIPurchaseProcessor.sol', 'BAIPurchaseProcessor', admin, [
    await usdt.getAddress(), await game.getAddress(), await router.getAddress(), addresses[6]
  ]);
  const drop = await deploy('contracts/BAIFreeDrop.sol', 'BAIFreeDrop', admin, [
    await game.getAddress(), await vrf.getAddress(), `0x${'22'.repeat(32)}`, 1, 3, 350000
  ]);
  const token = await deploy('contracts/BAIToken.sol', 'BAIToken', admin, [
    await factory.getAddress(), await usdt.getAddress(), addresses[0], await game.getAddress(),
    await drop.getAddress(), addresses[5], await game.getAddress()
  ]);
  const processor = await deploy('sandbox/Mocks.sol', 'SandboxLiquidityProcessor', admin, [
    await game.getAddress(), await usdt.getAddress(), await token.getAddress()
  ]);
  await tx(game.setBAIToken(await token.getAddress()));
  await tx(game.setLiquidityProcessor(await processor.getAddress()));
  await tx(game.setPurchaseProcessor(await purchaseProcessor.getAddress()));
  await tx(drop.setBAIToken(await token.getAddress()));
  await tx(processor.setMarketReady(true));
  await tx(usdt.mint(await router.getAddress(), parseEther('1000000')));
  await tx(usdt.mint(addresses[1], parseEther('1000')));
  await tx(usdt.mint(addresses[2], parseEther('1000')));
  await tx(usdt.mint(addresses[3], parseEther('1000')));
  await tx(usdt.mint(addresses[4], parseEther('1000')));
  const dayId = Number(await drop.currentDayId());
  const dayIdBI = BigInt(dayId);
  const gameSeed = findGameSeed(dayId);

  await tx(processor.setMarketReady(false));
  await expectRevert('cannot buy while the market/liquidity processor is unavailable', () => game.connect(alice).buyBoxes(1, ZeroAddress));
  await tx(processor.setMarketReady(true));
  await tx(usdt.connect(alice).approve(await game.getAddress(), parseEther('100')));
  await tx(usdt.connect(bob).approve(await game.getAddress(), parseEther('100')));
  await expectRevert('zero box purchase is rejected', () => game.connect(alice).buyBoxes(0, ZeroAddress));
  await tx(game.connect(alice).buyBoxes(10, ZeroAddress));
  ok(await game.boughtByWallet(dayIdBI, addresses[1]) === 10n, '10 USDT-priced boxes mint 10 NFTs and consume the wallet daily cap');
  await expectRevert('sealed box cannot be transferred before the daily draw', () =>
    game.connect(alice).transferFrom(addresses[1], addresses[2], 1));
  const tokenIdBeforeDirectTransfer = await game.nextTokenId();
  const roundBeforeDirectTransfer = await game.rounds(dayIdBI);
  await tx(usdt.connect(alice).transfer(await game.getAddress(), parseEther('10')));
  const roundAfterDirectTransfer = await game.rounds(dayIdBI);
  ok(await game.nextTokenId() === tokenIdBeforeDirectTransfer &&
    roundAfterDirectTransfer.boxCount === roundBeforeDirectTransfer.boxCount &&
    roundAfterDirectTransfer.totalUSDT === roundBeforeDirectTransfer.totalUSDT,
  'direct USDT transfer to the game does not mint a box or count as a purchase');
  const predictedReferralVault = await purchaseProcessor.predictVault(addresses[4], addresses[1]);
  const referralVault = predictedReferralVault;
  ok(referralVault !== ZeroAddress && !(await purchaseProcessor.isDepositVault(referralVault)),
    'buyer gets a deterministic, buyer-bound USDT address without a setup transaction');
  const directDepositId = keccak256(AbiCoder.defaultAbiCoder().encode(['string','address','uint256'], ['sandbox-deposit', addresses[4], 1]));
  const beforeVaultTransfer = await game.nextTokenId();
  await tx(usdt.connect(buyer).transfer(referralVault, parseEther('10')));
  ok(await game.nextTokenId() === beforeVaultTransfer && await usdt.balanceOf(referralVault) === parseEther('10'),
    'plain USDT transfer reaches the buyer-bound vault without minting before confirmed Keeper processing');
  await expectRevert('non-Keeper cannot register a USDT deposit', () =>
    purchaseProcessor.connect(admin).registerDeposit(directDepositId, addresses[4], addresses[1], referralVault, parseEther('10')));
  await expectRevert('configured Keeper cannot redirect a funded buyer vault to another wallet', () =>
    purchaseProcessor.connect(purchaseKeeper).registerDeposit(directDepositId, addresses[5], addresses[1], referralVault, parseEther('10')));
  await tx(purchaseProcessor.connect(purchaseKeeper).registerDeposit(directDepositId, addresses[4], addresses[1], referralVault, parseEther('10')));
  await expectRevert('registered USDT purchase cannot use the unregistered-transfer return path', () =>
    purchaseProcessor.connect(buyer).returnUnregisteredTransfer(directDepositId));
  await expectRevert('same USDT transfer log cannot be registered twice', () =>
    purchaseProcessor.connect(purchaseKeeper).registerDeposit(directDepositId, addresses[4], addresses[1], referralVault, parseEther('10')));
  ok(await purchaseProcessor.buyerForVault(referralVault) === addresses[4] &&
    await purchaseProcessor.referrerForVault(referralVault) === addresses[1],
    'deployed vault records the buyer/referrer binding enforced during registration');
  const directMintTokenId = await game.nextTokenId();
  await tx(purchaseProcessor.connect(purchaseKeeper).settleDeposit(directDepositId));
  ok(await game.ownerOf(directMintTokenId) === addresses[4] && await game.boughtByWallet(dayIdBI, addresses[4]) === 1n,
    'confirmed USDT deposit mints the box to the transfer sender and counts toward the normal wallet cap');
  await expectRevert('settled USDT deposit cannot mint boxes twice', () => purchaseProcessor.connect(purchaseKeeper).settleDeposit(directDepositId));
  ok(await game.pendingReferralUSDT(addresses[1]) === parseEther('3'),
    'deposit destination preserves the inviter and accrues the normal 3 USDT one-level commission');
  const strayTransferId = keccak256(AbiCoder.defaultAbiCoder().encode(['string','address','uint256'], ['sandbox-stray', addresses[4], 1]));
  const buyerBeforeStrayReturn = await usdt.balanceOf(addresses[4]);
  const senderBeforeStrayReturn = await usdt.balanceOf(addresses[1]);
  const attackerBeforeStrayReturn = await usdt.balanceOf(addresses[5]);
  const boxesBeforeStrayReturn = await game.nextTokenId();
  await tx(usdt.connect(alice).transfer(referralVault, parseEther('2')));
  await expectRevert('unverified transfer ID cannot be refunded by the vault-bound buyer', () =>
    purchaseProcessor.connect(buyer).returnUnregisteredTransfer(strayTransferId));
  await expectRevert('only Keeper can authorize an observed transfer refund', () =>
    purchaseProcessor.connect(outsider).authorizeUnregisteredTransferRefund(
      strayTransferId, addresses[4], addresses[1], addresses[1], referralVault, parseEther('2')));
  await expectRevert('normal buyer transfer cannot be sent through the wrong-sender refund path', () =>
    purchaseProcessor.connect(purchaseKeeper).authorizeUnregisteredTransferRefund(
      strayTransferId, addresses[4], addresses[1], addresses[4], referralVault, parseEther('2')));
  await tx(purchaseProcessor.connect(purchaseKeeper).authorizeUnregisteredTransferRefund(
    strayTransferId, addresses[4], addresses[1], addresses[5], referralVault, parseEther('2')));
  const authorizedStray = await purchaseProcessor.unregisteredRefunds(strayTransferId);
  ok(authorizedStray.buyer === addresses[4] && authorizedStray.vault === referralVault &&
    authorizedStray.amount === parseEther('2') && !authorizedStray.returned,
    'authorized refund stores the deterministic vault buyer, vault, amount, and pending state');
  await expectRevert('authorized wrong-sender transfer cannot also be registered as a purchase', () =>
    purchaseProcessor.connect(purchaseKeeper).registerDeposit(strayTransferId, addresses[4], addresses[1], referralVault, parseEther('2')));
  await tx(purchaseProcessor.connect(alice).returnUnregisteredTransfer(strayTransferId));
  ok(await usdt.balanceOf(addresses[4]) === buyerBeforeStrayReturn + parseEther('2') &&
    await usdt.balanceOf(addresses[1]) === senderBeforeStrayReturn - parseEther('2') &&
    await usdt.balanceOf(addresses[5]) === attackerBeforeStrayReturn &&
    await game.nextTokenId() === boxesBeforeStrayReturn &&
    (await purchaseProcessor.unregisteredRefunds(strayTransferId)).returned,
    'even a compromised Keeper cannot redirect a wrong-sender refund away from the vault-bound buyer');
  await expectRevert('unregistered transfer cannot be returned twice', () =>
    purchaseProcessor.connect(outsider).returnUnregisteredTransfer(strayTransferId));
  const invalidDepositId = keccak256(AbiCoder.defaultAbiCoder().encode(['string','address','uint256'], ['sandbox-deposit', addresses[4], 2]));
  const buyerBalanceBeforeInvalid = await usdt.balanceOf(addresses[4]);
  await tx(usdt.connect(buyer).transfer(referralVault, parseEther('5')));
  await tx(purchaseProcessor.connect(purchaseKeeper).registerDeposit(invalidDepositId, addresses[4], addresses[1], referralVault, parseEther('5')));
  await expectRevert('fractional-box deposit cannot settle', () => purchaseProcessor.connect(purchaseKeeper).settleDeposit(invalidDepositId));
  await tx(purchaseProcessor.connect(purchaseKeeper).refundInvalidDeposit(invalidDepositId));
  ok(await usdt.balanceOf(addresses[4]) === buyerBalanceBeforeInvalid && await game.boughtByWallet(dayIdBI, addresses[4]) === 1n,
    'invalid fractional-box deposit is refunded without minting or changing purchase accounting');
  const sealedMetadata = await game.tokenURI(1);
  ok(sealedMetadata.startsWith('data:application/json;base64,'), 'newly minted sealed box exposes self-contained on-chain JSON metadata');
  const sealedJson = JSON.parse(Buffer.from(sealedMetadata.split(',')[1], 'base64').toString('utf8'));
  ok(sealedJson.name.includes('Sealed BAI Box') && sealedJson.attributes.some((item) => item.value === 'Pending') &&
    sealedJson.image.startsWith('data:image/svg+xml;base64,'), 'sealed box metadata marks its pending reveal and embeds the card image');
  await expectRevert('11th paid box for the same wallet/day is rejected', () => game.connect(alice).buyBoxes(1, ZeroAddress));
  const bnbCost = parseEther('0.02');
  await tx(game.connect(bob).buyBoxes(9, addresses[1]));
  await tx(purchaseProcessor.connect(bob).buyWithBNB(1, ZeroAddress, bnbCost, { value: bnbCost }));
  ok(await game.boughtByWallet(dayIdBI, addresses[2]) === 10n, 'USDT and BNB purchase paths share the same per-wallet cap');
  ok(await game.hasPurchased(addresses[1]) && await game.hasPurchased(addresses[2]), 'successful paid purchases register purchase history');
  ok(await game.pendingReferralUSDT(addresses[1]) === parseEther('33'), 'direct inviter accrues 3 USDT on every referred paid box across USDT-deposit and BNB routes');
  ok(await game.totalReferralLiability() === parseEther('33') && await game.referralUSDTByRound(dayIdBI) === parseEther('33'), 'referral commission is tracked as a USDT liability and excluded from round liquidity');
  const roundBefore = await game.rounds(dayIdBI);
  ok(roundBefore.boxCount === 21n && roundBefore.totalUSDT === parseEther('210'), 'USDT, indexed deposits, and BNB routes record exactly 210 USDT for 21 boxes');
  await expectRevert('draw cannot start while Beijing sales window remains open', () => game.requestDraw(dayIdBI));
  await expectRevert('wrong address cannot fulfill a VRF request', () => game.connect(outsider).rawFulfillRandomWords(1, [1]));

  // Three free claims exercise both direct reward and paid-purchase lock paths.
  await tx(drop.connect(alice).claimFreeBox());
  await tx(drop.connect(bob).claimFreeBox());
  await tx(drop.connect(carol).claimFreeBox());
  await expectRevert('same wallet cannot register two free claims in one Beijing day', () => drop.connect(carol).claimFreeBox());
  ok(await drop.totalClaims() === 3n, 'free campaign registers one claim per wallet/day');

  // Close the Beijing day; then run the actual VRF callback and game settlement.
  await rpc('evm_increaseTime', [48 * 60 * 60]);
  await rpc('evm_mine');
  const closedAt = await provider.getBlock('latest');
  const closeTime = (await game.rounds(dayIdBI)).salesClose;
  if (BigInt(closedAt.timestamp) < closeTime) throw new Error(`Sandbox clock did not pass salesClose: ${closedAt.timestamp} < ${closeTime}`);
  await tx(game.requestDraw(dayIdBI, { gasLimit: 5_000_000 }));
  const gameRequest = await game.requestForDay(dayIdBI);
  await tx(vrf.fulfill(gameRequest, gameSeed));
  await tx(game.loadRandomness(dayIdBI));
  await tx(game.settleBatch(dayIdBI, 0, 21));
  await tx(game.finalizeDraw(dayIdBI));
  const round = await game.rounds(dayIdBI);
  ok(round.finalized && round.settledCount === 21n, 'VRF fulfillment, all 21 box reveals, and draw finalization complete in order');
  const revealedMetadata = await game.tokenURI(1);
  const revealedJson = JSON.parse(Buffer.from(revealedMetadata.split(',')[1], 'base64').toString('utf8'));
  ok(revealedJson.attributes.some((item) => item.trait_type === 'Card') && revealedJson.attributes.some((item) => item.trait_type === 'Rarity'),
    'revealed card metadata records its asset and rarity after settlement');
  ok(revealedJson.image.startsWith('data:image/svg+xml;base64,'), 'revealed NFT art is embedded SVG and needs no metadata server');
  ok(round.liquidityBudget === parseEther('130.8'), '210 USDT sales preserve 22% prizes, pay 33 USDT direct referrals, and allocate the remaining 130.8 USDT to liquidity');
  await expectRevert('settlement cannot be replayed after finalization', () => game.settleBatch(dayIdBI, 0, 1));
  await tx(processor.processLiquidity(dayIdBI));
  ok(await processor.released(dayIdBI) === parseEther('130.8'), 'liquidity processor releases the post-referral budget exactly once');
  await expectRevert('liquidity budget cannot be released twice', () => processor.processLiquidity(dayIdBI));

  const aliceUSDTBeforeReferralClaim = await usdt.balanceOf(addresses[1]);
  await tx(game.connect(alice).claimReferralCommission());
  ok(await usdt.balanceOf(addresses[1]) - aliceUSDTBeforeReferralClaim === parseEther('33') && await game.pendingReferralUSDT(addresses[1]) === 0n, 'inviter claims accrued USDT commission once and liability is cleared');
  await expectRevert('claimed referral commission cannot be withdrawn twice', () => game.connect(alice).claimReferralCommission());
  ok(await game.totalReferralLiability() === 0n, 'paid referral liabilities are removed from contract accounting');

  const losingAlice = [];
  const losingBob = [];
  const winning = [];
  for (let id = 1; id <= 21; id++) {
    const owner = (await game.ownerOf(id)).toLowerCase();
    if (await game.isWinningBox(id)) {
      if (owner === addresses[1].toLowerCase() || owner === addresses[2].toLowerCase()) winning.push(id);
    }
    else if (owner === addresses[1].toLowerCase()) losingAlice.push(id);
    else if (owner === addresses[2].toLowerCase()) losingBob.push(id);
  }
  ok(winning.length > 0 && losingAlice.length >= 4 && losingBob.length >= 4, 'seed yields winners plus enough losing cards for two synthesis paths');
  if (winning.length) {
    const w = winning[0];
    const owner = await game.ownerOf(w);
    await expectRevert('non-owner cannot claim a winning card prize', () => game.connect(outsider).claimPrize(w));
    const seller = owner.toLowerCase() === addresses[1].toLowerCase() ? alice : bob;
    await tx(game.connect(seller).listCard(w, parseEther('1')));
    await tx(usdt.connect(buyer).approve(await game.getAddress(), parseEther('1')));
    await tx(game.connect(buyer).buyListedCard(w));
    ok((await game.ownerOf(w)).toLowerCase() === addresses[4].toLowerCase(), 'winning card and its unclaimed prize entitlement transfer through the marketplace');
    await expectRevert('former owner cannot claim a traded winning card prize', () => game.connect(seller).claimPrize(w));
    await tx(game.connect(buyer).claimPrize(w));
    await expectRevert('winning card prize cannot be claimed twice', () => game.connect(buyer).claimPrize(w));
    await tx(game.connect(buyer).transferFrom(addresses[4], addresses[1], w));
    ok((await game.ownerOf(w)).toLowerCase() === addresses[1].toLowerCase(), 'a revealed winning card remains transferable after its prize is claimed');
  }
  if (losingAlice.length) {
    await expectRevert('winning NFT cannot claim losing-card BAI reward', () => game.connect(alice).claimBAIReward(winning.find((x) => x <= 10) ?? winning[0]));
    await expectRevert('losing card cannot claim the USDT prize', () => game.connect(alice).claimPrize(losingAlice[0]));
    await tx(game.connect(alice).claimBAIReward(losingAlice[0]));
    await expectRevert('same losing-card BAI reward cannot be claimed twice', () => game.connect(alice).claimBAIReward(losingAlice[0]));
  }
  if (losingBob.length) {
    ok((await game.referrerOf(addresses[2])).toLowerCase() === addresses[1].toLowerCase(), 'valid referral is bound to the buyer wallet');
    const referralBase = (await game.rounds(dayIdBI)).baiRewardPerLoser;
    const buyerBefore = await token.balanceOf(addresses[2]);
    const referrerBefore = await token.balanceOf(addresses[1]);
    await tx(game.connect(bob).claimBAIReward(losingBob[0]));
    ok((await token.balanceOf(addresses[2])) - buyerBefore === referralBase && await token.balanceOf(addresses[1]) === referrerBefore, 'non-winning BAI award goes fully to the card holder; referral commission is separate USDT');
  }
  ok(await token.balanceOf(await game.getAddress()) >= await game.reservedBAI(), 'reserved BAI reward liability is covered by game inventory');

  // Free draw: Alice/Bob already bought and receive directly; Carol remains pending.
  await tx(drop.requestDailyDraw(dayIdBI));
  await expectRevert('free-drop VRF request cannot be replaced before the retry delay', () => drop.requestDailyDraw(dayIdBI));
  const freeRequest = await drop.activeRequestForDay(dayIdBI);
  await tx(vrf.fulfill(freeRequest, 0xabcdef123n));
  ok(await drop.drawFulfilled(dayIdBI), 'free-drop VRF fulfillment completes the daily draw');
  await tx(drop.settleBatch(0, 3));
  ok(await drop.claimSettled(dayIdBI, addresses[3]), 'free-drop randomness assigns every registered claim');
  const carolPending = await drop.pendingReward(addresses[3]);
  ok(carolPending > 0n && (await token.balanceOf(addresses[3])) === 0n, 'unqualified free reward remains pending and is not transferred prematurely');
  await expectRevert('pending free BAI cannot be withdrawn before a paid purchase', () => drop.connect(carol).claimPendingReward());
  await expectRevert('self-referral is rejected on the first paid purchase', () => game.connect(carol).buyBoxes(1, addresses[3]));
  await tx(usdt.connect(carol).approve(await game.getAddress(), parseEther('10')));
  await tx(game.connect(carol).buyBoxes(1, addresses[1]));
  ok(await game.hasPurchased(addresses[3]), 'Carol is eligible after her paid purchase is recorded');
  ok((await game.referrerOf(addresses[3])).toLowerCase() === addresses[1].toLowerCase(), 'referrer is recorded once for a new player');
  ok(await game.pendingReferralUSDT(addresses[1]) === parseEther('3'), 'one referred paid box accrues exactly 3 USDT commission in the next round');
  await tx(drop.connect(carol).claimPendingReward({ gasLimit: 250_000 }));
  ok(await drop.pendingReward(addresses[3]) === 0n && await token.balanceOf(addresses[3]) === carolPending, 'paid purchase unlocks exactly the pending free BAI balance');

  // Marketplace escrow and settlement with the real NFT contract methods.
  const listedToken = losingBob[0];
  await tx(game.connect(bob).listCard(listedToken, parseEther('3')));
  ok((await game.ownerOf(listedToken)).toLowerCase() === (await game.getAddress()).toLowerCase(), 'listing escrows the card in the game contract');
  await expectRevert('seller cannot buy their own listing', () => game.connect(bob).buyListedCard(listedToken));
  await expectRevert('only seller can cancel a listing', () => game.connect(outsider).cancelCardListing(listedToken));
  await tx(usdt.connect(buyer).approve(await game.getAddress(), parseEther('3')));
  const buyerUSDTBefore = await usdt.balanceOf(addresses[4]);
  await tx(game.connect(buyer).buyListedCard(listedToken));
  ok((await game.ownerOf(listedToken)).toLowerCase() === addresses[4].toLowerCase(), 'marketplace purchase pays the seller and transfers card ownership');
  ok(buyerUSDTBefore - await usdt.balanceOf(addresses[4]) === parseEther('3'), 'marketplace payment uses the exact listing price');
  const cancelToken = losingBob[1];
  await tx(game.connect(bob).listCard(cancelToken, parseEther('2')));
  await tx(game.connect(bob).cancelCardListing(cancelToken));
  ok((await game.ownerOf(cancelToken)).toLowerCase() === addresses[2].toLowerCase(), 'seller can cancel and recover an escrowed card');

  // Synthesis fee, VRF requirement, success path and expired-request refund.
  await tx(token.transfer(addresses[1], parseEther('100')));
  const aliceForgeInputs = losingAlice.slice(1, 5);
  await expectRevert('paid losing card must claim its reserved BAI before synthesis', () => game.connect(alice).requestSynthesis(aliceForgeInputs));
  for (const id of aliceForgeInputs) {
    if (!(await game.baiRewardClaimed(id))) await tx(game.connect(alice).claimBAIReward(id));
  }
  await tx(token.connect(alice).approve(await game.getAddress(), parseEther('50')));
  await expectRevert('synthesis rejects duplicate token IDs', () => game.connect(alice).requestSynthesis([
    aliceForgeInputs[0], aliceForgeInputs[0], aliceForgeInputs[2], aliceForgeInputs[3]
  ]));
  let unclaimedWinningCard;
  for (const id of winning) {
    if (id !== winning[0] && (await game.ownerOf(id)).toLowerCase() === addresses[1].toLowerCase()) {
      unclaimedWinningCard = id;
      break;
    }
  }
  if (unclaimedWinningCard !== undefined) {
    await expectRevert('winning card cannot be synthesized before its USDT prize is claimed', () => game.connect(alice).requestSynthesis([
      unclaimedWinningCard, ...aliceForgeInputs.slice(1)
    ]));
  }
  const tradableForgeInputs = winning.length ? [winning[0], ...aliceForgeInputs.slice(1)] : aliceForgeInputs;
  await tx(game.connect(alice).requestSynthesis(tradableForgeInputs));
  const forgeId = await game.nextSynthesisId() - 1n;
  ok(await game.nextSynthesisId() === forgeId + 1n, 'claimed winning NFT is accepted as a synthesis input');
  await expectRevert('synthesis cannot complete before VRF fulfillment', () => game.completeSynthesis(forgeId));
  const forgeRequest = await game.requestForForge(forgeId);
  await tx(vrf.fulfill(forgeRequest, 0x2468n));
  ok(await game.forgeRandomnessFulfilled(forgeId), 'authorized VRF callback marks synthesis randomness as fulfilled');
  const synthesizedTokenId = await game.nextTokenId();
  await tx(game.completeSynthesis(forgeId, { gasLimit: 1_500_000 }));
  ok((await game.syntheses(forgeId)).completed, 'synthesis consumes its four inputs and finalizes after VRF');
  await tx(game.connect(alice).listCard(synthesizedTokenId, parseEther('4')));
  await tx(usdt.connect(buyer).approve(await game.getAddress(), parseEther('4')));
  await tx(game.connect(buyer).buyListedCard(synthesizedTokenId));
  ok((await game.ownerOf(synthesizedTokenId)).toLowerCase() === addresses[4].toLowerCase(), 'successfully synthesized card can be listed and traded');
  await expectRevert('completed synthesis cannot be replayed', () => game.completeSynthesis(forgeId));

  const bobForgeInputs = losingBob.slice(2, 6);
  for (const id of bobForgeInputs) {
    if (!(await game.baiRewardClaimed(id))) await tx(game.connect(bob).claimBAIReward(id));
  }
  if (bobForgeInputs.length !== 4) throw new Error(`Bob synthesis fixture requires 4 losing cards; got ${bobForgeInputs.length} from ${losingBob.length} losing cards: ${losingBob.join(',')}; day=${dayId}, seed=${gameSeed}`);
  await tx(token.transfer(addresses[2], parseEther('100')));
  await tx(token.connect(bob).approve(await game.getAddress(), parseEther('50')));
  const bobBefore = await token.balanceOf(addresses[2]);
  await tx(game.connect(bob).requestSynthesis(bobForgeInputs));
  const expiredForgeId = await game.nextSynthesisId() - 1n;
  const escrowed = (await game.syntheses(expiredForgeId)).fee;
  await rpc('evm_increaseTime', [8 * 24 * 60 * 60]);
  await rpc('evm_mine');
  await tx(game.connect(bob).cancelExpiredSynthesis(expiredForgeId, { gasLimit: 1_500_000 }));
  ok((await game.syntheses(expiredForgeId)).cancelled && await token.balanceOf(addresses[2]) === bobBefore, 'expired unfulfilled synthesis restores inputs and refunds full BAI fee');
  ok(escrowed === parseEther('10'), 'four R cards request the documented next tier with a 10 BAI fee');
  await expectRevert('cancelled synthesis cannot be cancelled again', () => game.cancelExpiredSynthesis(expiredForgeId));

  // Exercise fixed BAI pair tax and dividend accounting using a local mock pair.
  const pairAddress = await (await provider.getSigner(6)).getAddress();
  const dividendHolders = new Set();
  await tx(factory.setPair(pairAddress));
  const adminBefore = await token.balanceOf(addresses[0]);
  const opsBefore = await token.balanceOf(addresses[5]);
  const taxTransfer = parseEther('100');
  await tx(token.transfer(pairAddress, taxTransfer));
  ok(adminBefore - await token.balanceOf(addresses[0]) === taxTransfer, 'pair transfer debits the sender by the full gross amount');
  ok((await token.balanceOf(addresses[5])) - opsBefore === parseEther('1'), 'pair transfer routes 1% operations tax to treasury');
  ok((await token.balanceOf(pairAddress)) === parseEther('98'), 'pair receives net amount after total 2% tax');
  ok((await game.totalDividendLiability()) >= parseEther('1'), '1% dividend tax is recorded as a protected game liability');
  const ordinaryReceiver = addresses[3];
  const ordinaryBefore = await token.balanceOf(ordinaryReceiver);
  const senderBefore = await token.balanceOf(addresses[0]);
  await tx(token.transfer(ordinaryReceiver, parseEther('1')));
  ok(senderBefore - await token.balanceOf(addresses[0]) === parseEther('1') &&
    (await token.balanceOf(ordinaryReceiver)) - ordinaryBefore === parseEther('1'),
  'ordinary BAI wallet transfers are untaxed');
  const currentDividendDay = BigInt(await drop.currentDayId());
  const dividendSnapshotAt = currentDividendDay * 86400n - 28800n;
  for (const account of addresses) {
    if (await game.getDividendWeightAt(account, dividendSnapshotAt) > 0n) dividendHolders.add(account.toLowerCase());
  }
  ok(dividendHolders.size > 0, 'the deterministic draw includes SSSR special card holders with dividend weight');
  ok(await game.dailyDividendPool(currentDividendDay) === parseEther('1'), 'dividend tax is allocated to the day pool when snapshot weights exist');
  await rpc('evm_increaseTime', [24 * 60 * 60]);
  await rpc('evm_mine');
  const orderedDividendHolders = [...dividendHolders];
  const signerForHolder = new Map(addresses.map((address, index) => [address.toLowerCase(), signers[index]]));
  for (const holder of orderedDividendHolders.slice(0, -1)) {
    const signer = signerForHolder.get(holder);
    await tx(game.connect(signer).claimDividend(currentDividendDay));
  }
  const finalHolder = orderedDividendHolders.at(-1);
  const finalHolderSigner = signerForHolder.get(finalHolder);
  const remainingDividend = parseEther('1') - await game.dividendClaimedAmount(currentDividendDay);
  const finalClaimableDividend = await game.claimableDividend(currentDividendDay, finalHolder);
  ok(finalClaimableDividend === remainingDividend,
    `the final claimant sees the exact rounded remainder before claiming (claimable=${finalClaimableDividend}, remaining=${remainingDividend}, totalWeight=${await game.getTotalDividendWeightAt(currentDividendDay * 86400n - 28800n)}, accountWeight=${await game.getDividendWeightAt(finalHolder, currentDividendDay * 86400n - 28800n)}, claimedWeight=${await game.dividendClaimedWeight(currentDividendDay)})`);
  await tx(game.connect(finalHolderSigner).claimDividend(currentDividendDay));
  ok(await game.dividendClaimedAmount(currentDividendDay) === parseEther('1') && await game.totalDividendLiability() === 0n,
    `last dividend claimant receives rounding dust and the pool liability clears exactly (claimed=${await game.dividendClaimedAmount(currentDividendDay)}, liability=${await game.totalDividendLiability()}, pool=${await game.dailyDividendPool(currentDividendDay)})`);

  // Run delayed retry tests after normal gameplay so clock advances cannot
  // perturb the Beijing-day dividend snapshots above.
  const retryFreeDay = BigInt(await drop.currentDayId());
  await tx(drop.connect(outsider).claimFreeBox());
  const latestBeforeFreeClose = await provider.getBlock('latest');
  const freeCloseAt = (retryFreeDay + 1n) * 86400n - 28800n;
  if (BigInt(latestBeforeFreeClose.timestamp) < freeCloseAt) {
    await rpc('evm_increaseTime', [Number(freeCloseAt - BigInt(latestBeforeFreeClose.timestamp) + 1n)]);
    await rpc('evm_mine');
  }
  await tx(drop.connect(purchaseKeeper).requestDailyDraw(retryFreeDay));
  const firstFreeRetryRequest = await drop.activeRequestForDay(retryFreeDay);
  await rpc('evm_increaseTime', [24 * 60 * 60 + 1]);
  await rpc('evm_mine');
  await expectRevert('public caller cannot spend subscription funds on a delayed free-drop VRF retry', () =>
    drop.connect(outsider).requestDailyDraw(retryFreeDay));
  await tx(drop.requestDailyDraw(retryFreeDay));
  const activeFreeRetryRequest = await drop.activeRequestForDay(retryFreeDay);
  await tx(vrf.fulfill(firstFreeRetryRequest, 0x777777n));
  ok(!(await drop.drawFulfilled(retryFreeDay)), 'late fulfillment from a superseded free-drop request is ignored');
  await tx(vrf.fulfill(activeFreeRetryRequest, 0xabcdef999n));
  ok(await drop.drawFulfilled(retryFreeDay), 'configured operator can retry and complete delayed free-drop VRF');
  await tx(drop.settleBatch(3, 1));
  ok(await drop.claimSettled(retryFreeDay, addresses[5]), 'retried free-drop request settles the queued claim');

  await tx(usdt.mint(addresses[5], parseEther('10')));
  await tx(usdt.connect(outsider).approve(await game.getAddress(), parseEther('10')));
  await tx(game.connect(outsider).buyBoxes(1, ZeroAddress));
  const latestBeforePaidClose = await provider.getBlock('latest');
  const retryPaidDay = BigInt(Math.floor((latestBeforePaidClose.timestamp + 8 * 60 * 60) / 86400));
  const retryPaidRound = await game.rounds(retryPaidDay);
  if (retryPaidRound.boxCount === 0n) throw new Error('Expected a paid round to verify delayed game VRF retry access');
  if (BigInt(latestBeforePaidClose.timestamp) < retryPaidRound.salesClose) {
    await rpc('evm_increaseTime', [Number(retryPaidRound.salesClose - BigInt(latestBeforePaidClose.timestamp) + 1n)]);
    await rpc('evm_mine');
  }
  await tx(game.connect(outsider).requestDraw(retryPaidDay));
  const firstPaidRetryRequest = await game.requestForDay(retryPaidDay);
  await rpc('evm_increaseTime', [24 * 60 * 60 + 1]);
  await rpc('evm_mine');
  await expectRevert('public caller cannot spend subscription funds on a delayed game VRF retry', () =>
    game.connect(outsider).requestDraw(retryPaidDay));
  await tx(game.connect(purchaseKeeper).requestDraw(retryPaidDay));
  const activePaidRetryRequest = await game.requestForDay(retryPaidDay);
  await tx(vrf.fulfill(firstPaidRetryRequest, gameSeed ^ 0x1111n));
  ok(!(await game.roundRandomnessFulfilled(retryPaidDay)), 'late fulfillment from a superseded game request is ignored');
  await tx(vrf.fulfill(activePaidRetryRequest, gameSeed ^ 0x2222n));
  ok(await game.roundRandomnessFulfilled(retryPaidDay), 'configured operator can retry and complete delayed game VRF');

  console.log(JSON.stringify({
    sandbox: 'Ganache local chain 31337',
    contracts: {
      game: await game.getAddress(), freeDrop: await drop.getAddress(), bai: await token.getAddress(),
      usdt: await usdt.getAddress(), mockVRF: await vrf.getAddress(), liquidityProcessor: await processor.getAddress(),
      purchaseProcessor: await purchaseProcessor.getAddress(), referralVault
    },
    simulatedDayId: dayId,
    randomSeed: gameSeed.toString(),
    boxCount: Number(round.boxCount),
    winningBoxes: winning.length,
    losingBoxes: losingAlice.length + losingBob.length,
    synthesisFee: formatEther(escrowed),
    freeClaims: Number(await drop.totalClaims()),
    checksPassed: passed,
    compilerWarnings: warnings.length,
    report
  }, null, 2));
} catch (error) {
  console.error('SANDBOX_FAILURE', JSON.stringify({
    name: error?.name,
    message: error?.shortMessage || error?.message || String(error),
    code: error?.code,
    data: error?.data,
    reason: error?.reason,
    errorInfo: error?.info?.error?.message,
    stack: error?.stack,
    gameRuntimeBytes: compiled.contracts?.['contracts/BAIBlindBoxGameV2.sol']?.BAIBlindBoxGameV2?.evm?.deployedBytecode?.object?.length / 2,
    checksPassed: passed,
    lastCheck: report.at(-1)
  }));
  process.exitCode = 1;
} finally {
  await chainProvider?.disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
