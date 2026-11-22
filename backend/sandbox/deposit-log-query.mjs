import { chunkDepositVaults, fetchDepositLogs, isSplittableLogQueryError } from '../src/deposit-log-query.mjs';

let assertions = 0;
function check(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  assertions++;
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { error: { code, message } });
}

const usdt = '0x0000000000000000000000000000000000000055';
const vaults = Array.from({ length: 4 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
check(chunkDepositVaults(Array.from({ length: 3000 }, (_, i) => vaults[i % vaults.length]), 500).length, 6,
  '3,000 registered vaults fit in six recipient filters at batch size 500');
check(chunkDepositVaults(Array.from({ length: 90_000 }, (_, i) => vaults[i % vaults.length]), 500).length, 180,
  '90,000 registered vaults fit in 180 recipient filters at batch size 500');

for (const error of [
  rpcError(-32601, 'The method eth_getLogs does not exist/is not available'),
  rpcError(429, 'rate limit exceeded'),
  rpcError(-32005, 'request quota exceeded')
]) {
  let calls = 0;
  let failed = false;
  try {
    await fetchDepositLogs({ async getLogs() { calls++; throw error; } }, usdt, 100, 110, vaults);
  } catch { failed = true; }
  check(failed, true, 'non-splittable RPC error surfaces');
  check(calls, 1, 'non-splittable RPC error does not fan out');
  check(isSplittableLogQueryError(error), false, 'non-splittable error classification');
}

let blockCalls = 0;
const blockLogs = await fetchDepositLogs({
  async getLogs(filter) {
    blockCalls++;
    if (filter.toBlock - filter.fromBlock > 0) throw rpcError(-32005, 'block range limit exceeded');
    return [{ blockNumber: filter.fromBlock }];
  }
}, usdt, 20, 23, [vaults[0]]);
check(blockLogs.length, 4, 'block-range fallback returns all logs');
check(blockCalls, 7, 'block-range fallback remains bounded');

let topicCalls = 0;
const topicLogs = await fetchDepositLogs({
  async getLogs(filter) {
    topicCalls++;
    const recipients = filter.topics[2];
    if (recipients.length > 1) throw rpcError(-32602, 'too many topics in log query');
    return [{ recipient: recipients[0] }];
  }
}, usdt, 30, 30, vaults);
check(topicLogs.length, 4, 'topic fallback returns every recipient log');
check(topicCalls, 7, 'topic fallback remains bounded');

check(isSplittableLogQueryError(rpcError(-32000, 'query returned more than 10000 results')), true,
  'provider result-count limit is recognized');
check(isSplittableLogQueryError(rpcError(-32000, 'block range is too wide')), true,
  'provider block-range limit is recognized');

let budgetCalls = 0;
let budgetRejected = false;
try {
  await fetchDepositLogs({ async getLogs() { budgetCalls++; throw rpcError(-32005, 'result limit exceeded'); } }, usdt, 40, 43, vaults, { maxAttempts: 5 });
} catch { budgetRejected = true; }
check(budgetRejected, true, 'persistent oversized query fails instead of returning partial logs');
check(budgetCalls, 5, 'split budget caps provider calls');

console.log(JSON.stringify({ simulation: 'deposit log RPC failure and split bounds', assertions, passed: assertions, failed: 0 }, null, 2));
