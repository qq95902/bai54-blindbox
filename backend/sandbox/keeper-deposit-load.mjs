import assert from 'node:assert/strict';
import { mapSettledLimit } from '../src/map-settled-limit.mjs';

let assertions = 0;
function check(condition, message) { assert.ok(condition, message); assertions++; }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ordered = await mapSettledLimit([30, 10, 20], 2, async (value) => {
  await pause(value === 30 ? 3 : 1);
  return value * 2;
});
check(ordered.map((item) => item.value).join(',') === '60,20,40', 'bounded worker preserves result order despite out-of-order completion');
check((await mapSettledLimit([], 5, async () => true)).length === 0, 'empty batch returns without creating workers');
check((await mapSettledLimit([1], 1, async () => { throw new Error('injected'); }))[0].status === 'rejected',
  'a rejected action is recorded without rejecting the whole batch');
await assert.rejects(() => mapSettledLimit([1], 0, async () => true), /MAP_SETTLED_LIMIT_ARGUMENTS_INVALID/);
assertions++;

const total = 3_000;
const batchSize = 100;
const concurrency = 25;
let active = 0;
let maxActive = 0;
let injectedRegistrationFailure = false;
let injectedSettlementFailure = false;
const registrationAttempts = new Map();
const settlementAttempts = new Map();
const registered = new Set();
const settled = new Set();

async function countedDelay() {
  active++;
  maxActive = Math.max(maxActive, active);
  await pause(1);
  active--;
}

async function register(id) {
  registrationAttempts.set(id, (registrationAttempts.get(id) || 0) + 1);
  await countedDelay();
  if (id === 1_177 && !injectedRegistrationFailure) {
    injectedRegistrationFailure = true;
    throw new Error('injected keeper registration timeout');
  }
  registered.add(id);
}

async function settle(id) {
  settlementAttempts.set(id, (settlementAttempts.get(id) || 0) + 1);
  await countedDelay();
  if (id === 2_277 && !injectedSettlementFailure) {
    injectedSettlementFailure = true;
    throw new Error('injected settlement receipt timeout');
  }
  assert.ok(registered.has(id), `deposit ${id} cannot settle before Keeper registration`);
  settled.add(id);
}

for (let start = 0; start < total; start += batchSize) {
  const ids = Array.from({ length: Math.min(batchSize, total - start) }, (_, index) => start + index);
  await mapSettledLimit(ids, concurrency, register);
  const ready = ids.filter((id) => registered.has(id));
  await mapSettledLimit(ready, concurrency, settle);
}

// Recover one registration timeout and one settlement timeout on later Keeper cycles.
const unregistered = Array.from({ length: total }, (_, index) => index).filter((id) => !registered.has(id));
await mapSettledLimit(unregistered, concurrency, register);
const unsettled = Array.from({ length: total }, (_, index) => index).filter((id) => !settled.has(id));
await mapSettledLimit(unsettled, concurrency, settle);

check(injectedRegistrationFailure && injectedSettlementFailure, 'both Keeper fault injections were exercised');
check(registered.size === total && settled.size === total, 'all 3,000 deposits eventually register and settle');
check(maxActive <= concurrency, `in-flight jobs stay within configured concurrency ${concurrency}`);
check(registrationAttempts.get(1_177) === 2, 'timed-out registration is retried once');
check(settlementAttempts.get(2_277) === 2, 'timed-out settlement is retried once');
check([...settled].every((id) => settlementAttempts.get(id) === (id === 2_277 ? 2 : 1)),
  'no successfully settled deposit is submitted twice');

console.log(JSON.stringify({
  simulation: 'Keeper 3,000-deposit bounded concurrency and retry recovery',
  deposits: total,
  keeperBatchSize: batchSize,
  concurrency,
  maximumInFlight: maxActive,
  injectedFaults: 2,
  assertions,
  passed: assertions,
  failed: 0
}, null, 2));
