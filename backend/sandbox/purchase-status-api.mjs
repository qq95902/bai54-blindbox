import assert from 'node:assert/strict';
import { AbiCoder, Wallet } from 'ethers';
import { issueDepositChallenge } from '../src/deposit-challenge.mjs';
import { createApiServer } from '../src/api.mjs';
import { instrumentClientQuery } from '../src/db.mjs';

const hash = `0x${'a'.repeat(64)}`;
const depositId = `0x${'b'.repeat(64)}`;
let mode = { transfer: true, registered: false, terminal: null, senderMismatch: false, receipt: null, databaseDown: false, rpcDown: false, wrongChain: false,
  primaryDown: false, buyerPurchased: false, boundReferrer: '0x0000000000000000000000000000000000000000', vaultConflict: false };
const buyerWallet = Wallet.createRandom();
const buyerAddress = buyerWallet.address;
const challenges = new Map();
const challengeSecret = 'sandbox-deposit-challenge-secret-'.padEnd(64, 'x');
let challengeWrites = 0;
let vaultRegistryWrites = 0;
const pool = {
  async query(sql) {
    if (mode.databaseDown) throw Object.assign(new Error('simulated database unavailable'), { code: 'ECONNREFUSED' });
    if (sql.includes('INSERT INTO wallet_signing_challenges')) {
      challengeWrites++;
      const [challengeId, chainId, buyer, referrer, origin, message, expiresAt] = arguments[1];
      if (challenges.has(challengeId)) return { rowCount: 0, rows: [] };
      challenges.set(challengeId, { challenge_id: challengeId, chain_id: chainId, buyer_address: buyer, referrer_address: referrer, origin, message, expires_at: expiresAt, used_at: new Date().toISOString() });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('INSERT INTO purchase_vaults')) { vaultRegistryWrites++; return { rowCount: mode.vaultConflict ? 0 : 1, rows: [] }; }
    if (sql.includes("event_name='Transfer'")) return { rows: mode.transfer ? [{
      transaction_hash: hash,
      args: { depositId, from: mode.senderMismatch ? '0x9999999999999999999999999999999999999999' : '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222', value: '10000000000000000000' },
      block_number: '90'
    }] : [] };
    if (sql.includes('SELECT buyer_address,referrer_address FROM purchase_vaults')) {
      return { rows: [{ buyer_address: '0x1111111111111111111111111111111111111111', referrer_address: '0x0000000000000000000000000000000000000000' }] };
    }
    if (sql.includes("event_name IN ('DepositSettled','DepositRefunded','UnregisteredTransferRefundAuthorized','UnregisteredTransferReturned')")) {
      return { rows: mode.terminal ? [{ event_name: mode.terminal, args: { depositId, boxes: 1 } }] : [] };
    }
    if (sql.includes("event_name='DepositRegistered'")) return { rows: mode.registered ? [{ block_number: '91' }] : [] };
    return { rows: [] };
  }
};
instrumentClientQuery(pool, { waitingCount: 0, totalCount: 1, idleCount: 0 });
function mockProvider({ primary = false } = {}) {
  function assertAvailable() {
    if (mode.rpcDown || (primary && mode.primaryDown)) throw new Error('simulated RPC unavailable');
  }
  return {
  async getNetwork() { assertAvailable(); return { chainId: mode.wrongChain ? 56n : 97n }; },
  async getBlockNumber() { assertAvailable(); return 100; },
  async getTransactionReceipt() { assertAvailable(); return mode.receipt; },
  async call({ data }) {
    assertAvailable();
    const selector = data.slice(0, 10).toLowerCase();
    const argument = `0x${data.slice(10 + 24, 10 + 64)}`.toLowerCase();
    if (selector === '0x9a5a4eb6') return AbiCoder.defaultAbiCoder().encode(['address'], ['0x7777777777777777777777777777777777777777']);
    if (selector === '0x90118fb4') {
      const isReferrer = argument === '0x1111111111111111111111111111111111111111';
      return AbiCoder.defaultAbiCoder().encode(['bool'], [isReferrer || (mode.buyerPurchased && argument === buyerAddress.toLowerCase())]);
    }
    if (selector === '0xd21cacdf') return AbiCoder.defaultAbiCoder().encode(['address'], [mode.boundReferrer]);
    throw new Error(`unexpected provider call ${selector}`);
  }
  };
}
const providers = [mockProvider({ primary: true }), mockProvider()];
const config = {
  chainId: 97,
  usdtAddress: '0x3333333333333333333333333333333333333333',
  contracts: {
    purchaseProcessor: '0x4444444444444444444444444444444444444444',
    game: '0x5555555555555555555555555555555555555555',
    liquidityManager: '0x6666666666666666666666666666666666666666'
  },
  trustedProxyIps: [], metricsToken: '', depositChallengeSecret: challengeSecret
};
const siteOrigin = 'https://bai.example';
const server = createApiServer({ config, pool, providers, publicOrigins: [siteOrigin] });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const originalWrite = process.stdout.write;
const logRecords = [];
let assertions = 0;
function check(actual, expected, message) { assert.equal(actual, expected, message); assertions++; }
async function status(queryHash = hash) {
  return fetch(`http://127.0.0.1:${server.address().port}/v1/purchase-status?txHash=${queryHash}`);
}
async function readiness(path = '/readyz') {
  return fetch(`http://127.0.0.1:${server.address().port}${path}`);
}
async function getDepositChallenge(buyer = buyerAddress, referrer = '0x1111111111111111111111111111111111111111') {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/deposit-challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: siteOrigin }, body: JSON.stringify({ buyer, referrer })
  });
  return { response, challenge: await response.json(), buyer, referrer };
}
async function submitDepositChallenge({ challenge, buyer = buyerAddress, referrer = '0x1111111111111111111111111111111111111111', signer = buyerWallet, origin = siteOrigin }) {
  const signature = await signer.signMessage(challenge.message);
  return fetch(`http://127.0.0.1:${server.address().port}/v1/deposit-address`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ buyer, referrer, challengeId: challenge.challengeId, signature })
  });
}
async function requestDepositAddress(buyer = buyerAddress, referrer = '0x1111111111111111111111111111111111111111') {
  const { response, challenge } = await getDepositChallenge(buyer, referrer);
  if (!response.ok) return response;
  return submitDepositChallenge({ challenge, buyer, referrer });
}

try {
  process.stdout.write = (chunk) => { logRecords.push(JSON.parse(String(chunk))); return true; };
  let response;
  response = await readiness('/healthz');
  check(response.status, 200, 'liveness responds while dependencies are down');
  mode.databaseDown = true;
  const dbDownTraceStart = logRecords.length;
  response = await readiness();
  check(response.status, 503, 'readiness fails when database is unavailable');
  const dbDownHttpLog = logRecords.slice(dbDownTraceStart).find((record) => record.event === 'http_request_complete');
  check(dbDownHttpLog?.errorCode, 'ECONNREFUSED', 'readiness HTTP log records the safe database error code');
  mode.databaseDown = false;
  mode.wrongChain = true;
  response = await readiness();
  check(response.status, 503, 'readiness fails when RPC is on the wrong chain');
  mode.wrongChain = false;
  mode.rpcDown = true;
  response = await readiness();
  check(response.status, 503, 'readiness fails when all configured RPC providers are unavailable');
  mode.rpcDown = false;
  const traceStart = logRecords.length;
  response = await readiness();
  const readyBody = await response.json();
  check(response.status, 200, 'readiness succeeds after database and BSC Testnet RPC recover');
  check(`${readyBody.status}:${readyBody.chainId}:${readyBody.blockNumber}`, 'ready:97:100', 'readiness reports the validated chain and current block');
  check(readyBody.features.includes('buyer_bound_usdt_vaults'), true, 'readiness advertises the buyer-bound direct-USDT API capability');
  const readyTrace = logRecords.slice(traceStart);
  const databaseTrace = readyTrace.find((record) => record.event === 'database_query_complete');
  const httpTrace = readyTrace.find((record) => record.event === 'http_request_complete');
  check(databaseTrace?.requestId, httpTrace?.requestId, 'HTTP readiness and its database query share a request ID');
  check(response.headers.get('x-request-id'), httpTrace?.requestId, 'response header exposes the same trace ID for support diagnostics');
  assert.ok(databaseTrace?.queryId, 'database trace keeps its own query ID');
  assertions++;

  let issued = await getDepositChallenge();
  check(issued.response.status, 200, 'deposit challenge is issued without registering a deposit vault');
  check(challenges.size, 0, 'unsigned challenge issuance stays stateless and cannot grow database rows');
  check(challengeWrites, 0, 'unsigned requests perform no challenge database writes');
  check(vaultRegistryWrites, 0, 'unsigned requests cannot add recipients to the indexer monitored vault registry');
  response = await submitDepositChallenge({ challenge: issued.challenge, signer: Wallet.createRandom() });
  check(response.status, 401, 'a signature from a different wallet cannot register the buyer vault');
  check(challengeWrites, 0, 'invalid signatures do not create replay rows');
  response = await submitDepositChallenge({ challenge: issued.challenge });
  check(response.status, 200, 'buyer signature registers the chain-derived buyer-specific vault');
  check(vaultRegistryWrites, 1, 'a valid one-time buyer signature creates exactly one monitored deposit-vault record');
  check(challengeWrites, 1, 'only a valid wallet signature writes the one-time replay guard');
  const addressBody = await response.json();
  check(`${response.status}:${addressBody.vault}:${addressBody.chainId}`, '200:0x7777777777777777777777777777777777777777:97',
    'deposit-address API returns the chain-derived buyer-specific vault');
  response = await submitDepositChallenge({ challenge: issued.challenge });
  check(response.status, 409, 'a valid address-registration signature cannot be replayed');
  issued = await getDepositChallenge();
  response = await submitDepositChallenge({ challenge: issued.challenge, origin: 'https://attacker.example' });
  check(response.status, 403, 'deposit signature cannot be replayed from a different website origin');
  issued = await getDepositChallenge();
  response = await submitDepositChallenge({ challenge: issued.challenge, referrer: '0x2222222222222222222222222222222222222222' });
  check(response.status, 409, 'signature is bound to the exact referrer selected in the challenge');
  const writesBeforeInvalidTokens = challengeWrites;
  const expiredChallenge = issueDepositChallenge({ secret: challengeSecret, chainId: 97, buyer: buyerAddress,
    referrer: '0x1111111111111111111111111111111111111111', origin: siteOrigin, now: Date.now() - 6 * 60_000 });
  response = await submitDepositChallenge({ challenge: expiredChallenge });
  check(response.status, 409, 'expired stateless challenges cannot register a vault');
  issued = await getDepositChallenge();
  const tamperedChallenge = { ...issued.challenge, challengeId: `${issued.challenge.challengeId.slice(0, -1)}${issued.challenge.challengeId.endsWith('0') ? '1' : '0'}` };
  response = await submitDepositChallenge({ challenge: tamperedChallenge });
  check(response.status, 409, 'tampered challenge tokens fail HMAC validation before database access');
  check(challengeWrites, writesBeforeInvalidTokens, 'expired and tampered tokens do not write replay rows');
  check(challenges.size, 1, 'expired and tampered tokens do not grow the replay table');
  response = await requestDepositAddress(buyerAddress, buyerAddress);
  check(response.status, 400, 'deposit-address API rejects self-referral');
  response = await requestDepositAddress(buyerAddress, '0x2222222222222222222222222222222222222222');
  check(response.status, 400, 'deposit-address API rejects an ineligible referrer');
  mode.buyerPurchased = true;
  mode.boundReferrer = '0x3333333333333333333333333333333333333333';
  response = await requestDepositAddress();
  check(response.status, 409, 'deposit-address API cannot change an existing buyer referral binding');
  mode.buyerPurchased = false;
  mode.boundReferrer = '0x0000000000000000000000000000000000000000';
  mode.vaultConflict = true;
  response = await requestDepositAddress();
  check(response.status, 409, 'deposit-address registry refuses a conflicting deterministic vault');
  mode.vaultConflict = false;

  response = await status();
  check((await response.json()).state, 'pending_keeper_registration', 'confirmed transfer waits for Keeper registration');
  response = await fetch(`http://127.0.0.1:${server.address().port}/v1/purchase-status?address=0x1111111111111111111111111111111111111111`);
  const addressStatus = await response.json();
  check(`${addressStatus.state}:${addressStatus.transactionHash}`, `pending_keeper_registration:${hash}`,
    'wallet refresh finds its latest direct-USDT order without requiring the transaction hash');
  mode.senderMismatch = true;
  response = await fetch(`http://127.0.0.1:${server.address().port}/v1/purchase-status?address=0x1111111111111111111111111111111111111111`);
  const mismatchStatus = await response.json();
  check(`${mismatchStatus.state}:${mismatchStatus.buyer}:${mismatchStatus.sender}:${mismatchStatus.amount}`,
    'pending_keeper_registration:0x1111111111111111111111111111111111111111:0x9999999999999999999999999999999999999999:10000000000000000000',
    'wallet refresh does not expose a refund until the Keeper authorizes the exact transfer');
  mode.terminal = 'UnregisteredTransferRefundAuthorized';
  response = await status();
  check((await response.json()).state, 'refund_available', 'buyer-bound refund becomes claimable only after the Keeper authorization is indexed');
  mode.terminal = 'UnregisteredTransferReturned';
  response = await status();
  const returnedStatus = await response.json();
  check(`${returnedStatus.state}:${returnedStatus.refundRecipient}`, 'refunded_to_buyer:0x1111111111111111111111111111111111111111',
    'unregistered transfer refund reports the immutable recipient bound to the buyer vault');
  mode.terminal = null;
  mode.senderMismatch = false;
  mode.registered = true;
  response = await status();
  check((await response.json()).state, 'pending_settlement', 'registered deposit waits for settlement');
  mode.terminal = 'DepositSettled';
  response = await status();
  check((await response.json()).state, 'settled', 'settled deposit is reported');
  mode.terminal = 'DepositRefunded';
  response = await status();
  check((await response.json()).state, 'refunded', 'refunded deposit is reported');
  check((await status('invalid')).status, 400, 'malformed transaction hash is rejected');

  mode.transfer = false;
  mode.receipt = { status: 0, blockNumber: 90 };
  response = await status();
  check((await response.json()).state, 'transaction_failed', 'failed chain transaction is reported');
  mode.receipt = { status: 1, blockNumber: 98 };
  response = await status();
  check((await response.json()).state, 'confirming_or_indexing', 'successful receipt waits for indexing');
  mode.receipt = null;
  mode.primaryDown = true;
  response = await status();
  check(`${response.status}:${(await response.json()).state}`, '200:not_found',
    'transaction status fails over from an unavailable primary RPC before reading its receipt');
  mode.primaryDown = false;
  response = await status();
  check((await response.json()).state, 'not_found', 'unknown transaction is distinguished');

  let throttled = false;
  for (let index = 0; index < 60; index++) {
    response = await status();
    if (response.status === 429) { throttled = true; break; }
  }
  assert.ok(throttled, 'requests above 60 per IP per minute are rejected');
  assertions++;
} finally {
  process.stdout.write = originalWrite;
  await new Promise((resolve) => server.close(resolve));
}

console.log(JSON.stringify({ simulation: 'Public purchase-status API state machine and abuse limit', assertions, passed: assertions, failed: 0 }, null, 2));
