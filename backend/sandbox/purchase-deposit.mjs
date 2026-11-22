import assert from 'node:assert/strict';
import { processRegisteredDeposit } from '../src/purchase-deposit.mjs';

const BUYER = '0x1111111111111111111111111111111111111111';
const PRICE = 10_000_000n;
const REFUND_DELAY = 86_400;
let assertions = 0;
function check(actual, expected, message) { assert.equal(actual, expected, message); assertions++; }

function fixture({ amount = PRICE, registeredAt = 1_800_000_000, settled = false, refunded = false,
  buyer = BUYER, price = PRICE, refundDelay = REFUND_DELAY, failFirstSettle = false } = {}) {
  const state = { amount: BigInt(amount), registeredAt: BigInt(registeredAt), settled, refunded, buyer };
  const actions = [];
  let settleFailures = failFirstSettle ? 1 : 0;
  const processor = {
    async deposits() { return state; },
    async DEPOSIT_REFUND_DELAY() { return refundDelay; },
    async settleDeposit() {
      if (settleFailures-- > 0) throw Object.assign(new Error('temporary paused market'), { code: 'CALL_EXCEPTION' });
      state.settled = true;
    },
    async refundInvalidDeposit() { state.refunded = true; },
    async refundExpiredDeposit() { state.refunded = true; }
  };
  const game = { async boxPrice() { return price; } };
  const action = async (key, label, send) => {
    actions.push({ key, label });
    try { await send(); return true; } catch { return false; }
  };
  return { state, actions, processor, game, action };
}

for (let run = 1; run <= 20; run++) {
  // Exact pricing boundaries: one and ten boxes settle; fractional, dust, and >10 refund.
  for (const amount of [PRICE, PRICE * 10n]) {
    const f = fixture({ amount });
    const result = await processRegisteredDeposit({ ...f, depositId: `valid-${run}-${amount}`, chainTimestamp: 1_800_000_001 });
    check(result, 'settle', `run ${run}: valid integer box amount settles`);
    check(f.state.settled, true, `run ${run}: valid amount reaches processor settlement`);
  }
  for (const amount of [1n, PRICE - 1n, PRICE + 1n, PRICE * 11n]) {
    const f = fixture({ amount });
    const result = await processRegisteredDeposit({ ...f, depositId: `invalid-${run}-${amount}`, chainTimestamp: 1_800_000_001 });
    check(result, 'refund_invalid', `run ${run}: dust, fractional, and over-cap deposits refund`);
    check(f.state.refunded, true, `run ${run}: invalid amount is returned`);
  }

  // The expiry comparison matches Solidity: exact deadline may settle; one second later refunds.
  const atDeadline = fixture();
  check(await processRegisteredDeposit({ ...atDeadline, depositId: `deadline-${run}`, chainTimestamp: 1_800_000_000 + REFUND_DELAY }),
    'settle', `run ${run}: exact expiry boundary remains settleable`);
  const expired = fixture();
  check(await processRegisteredDeposit({ ...expired, depositId: `expired-${run}`, chainTimestamp: 1_800_000_001 + REFUND_DELAY }),
    'refund_expired', `run ${run}: expired valid amount refunds`);

  const done = fixture({ settled: true });
  check(await processRegisteredDeposit({ ...done, depositId: `done-${run}`, chainTimestamp: 1_800_000_001 }),
    'terminal', `run ${run}: already-settled deposit is not replayed`);
  check(done.actions.length, 0, `run ${run}: terminal deposit sends no Keeper transaction`);
}

// A temporary revert leaves a registered deposit retryable; a later Keeper tick settles it.
{
  const f = fixture({ failFirstSettle: true });
  check(await processRegisteredDeposit({ ...f, depositId: 'retry', chainTimestamp: 1_800_000_001 }), 'settle', 'first transient attempt is classified for settlement');
  check(f.state.settled, false, 'temporary failure does not falsely mark deposit settled');
  check(await processRegisteredDeposit({ ...f, depositId: 'retry', chainTimestamp: 1_800_000_002 }), 'settle', 'next Keeper tick retries a still-valid deposit');
  check(f.state.settled, true, 'retry settles once the temporary condition clears');
  check(f.actions.length, 2, 'retry performs no duplicate after a confirmed success');
}

await assert.rejects(() => processRegisteredDeposit({ ...fixture({ price: 0n }), depositId: 'zero-price', chainTimestamp: 1 }),
  /GAME_BOX_PRICE_ZERO/);
assertions++;
await assert.rejects(() => processRegisteredDeposit({ ...fixture({ refundDelay: 0 }), depositId: 'bad-delay', chainTimestamp: 1 }),
  /PURCHASE_REFUND_DELAY_INVALID/);
assertions++;

console.log(JSON.stringify({ simulation: 'Keeper USDT deposit policy and retry boundaries', runs: 20, assertions, passed: assertions, failed: 0 }, null, 2));
