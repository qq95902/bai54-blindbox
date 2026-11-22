import assert from 'node:assert/strict';
import { isChainDeadlineReached, SYNTHESIS_TIMEOUT_SECONDS, VRF_RETRY_DELAY_SECONDS } from '../src/keeper-time.mjs';

let assertions = 0;
function check(value, message) { assert.ok(value, message); assertions++; }

const requestAt = 1_800_000_000n;
// Model a server clock that is 48 hours fast: on-chain state still prevents early retry.
check(!isChainDeadlineReached(requestAt + 15n * 60n, requestAt, VRF_RETRY_DELAY_SECONDS), 'VRF retry waits for chain time even when host time is far ahead');
check(isChainDeadlineReached(requestAt + BigInt(VRF_RETRY_DELAY_SECONDS), requestAt, VRF_RETRY_DELAY_SECONDS), 'VRF retry becomes eligible exactly at the chain-time deadline');
check(!isChainDeadlineReached(requestAt + BigInt(VRF_RETRY_DELAY_SECONDS) - 1n, requestAt, VRF_RETRY_DELAY_SECONDS), 'VRF retry remains ineligible one chain second before deadline');
// Model a server clock that is 48 hours slow: expired synthesis can still be recovered from chain time.
check(!isChainDeadlineReached(requestAt + BigInt(SYNTHESIS_TIMEOUT_SECONDS) - 1n, requestAt, SYNTHESIS_TIMEOUT_SECONDS), 'synthesis cannot be cancelled before its on-chain timeout');
check(isChainDeadlineReached(requestAt + BigInt(SYNTHESIS_TIMEOUT_SECONDS), requestAt, SYNTHESIS_TIMEOUT_SECONDS), 'synthesis cancellation becomes eligible at seven chain days');
assert.throws(() => isChainDeadlineReached(-1, requestAt, 1), RangeError, 'negative block timestamps are rejected');
assertions++;

console.log(JSON.stringify({
  simulation: 'Keeper chain-time deadlines under host-clock skew',
  hostClockSkewScenarios: 2,
  assertions,
  passed: assertions,
  failed: 0
}, null, 2));
