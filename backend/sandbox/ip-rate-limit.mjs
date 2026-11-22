import assert from 'node:assert/strict';
import { consumeIpRateLimit } from '../src/ip-rate-limit.mjs';

let assertions = 0;
function check(actual, expected, label) {
  assert.equal(actual, expected, label);
  assertions++;
}

const limit = new Map();
check(consumeIpRateLimit(limit, '192.0.2.1', 1_000, { limit: 2, maxKeys: 2 }), true, 'first request accepted');
check(consumeIpRateLimit(limit, '192.0.2.1', 1_001, { limit: 2, maxKeys: 2 }), true, 'request within limit accepted');
check(consumeIpRateLimit(limit, '192.0.2.1', 1_002, { limit: 2, maxKeys: 2 }), false, 'per-IP limit enforced');
check(consumeIpRateLimit(limit, '192.0.2.2', 1_003, { limit: 2, maxKeys: 2 }), true, 'second IP occupies bounded slot');
check(consumeIpRateLimit(limit, '192.0.2.3', 1_004, { limit: 2, maxKeys: 2 }), false, 'new IP rejected at capacity');
check(limit.size, 2, 'unique-IP flood cannot grow the map past its configured maximum');
check(consumeIpRateLimit(limit, '192.0.2.3', 62_000, { limit: 2, maxKeys: 2 }), true, 'expired oldest windows are pruned before admitting a new IP');
check(limit.size, 2, 'expired slot is recycled while the map remains capped');
check(consumeIpRateLimit(limit, '192.0.2.1', 62_001, { limit: 2, maxKeys: 2 }), true, 'expired existing IP receives a fresh window');
check(limit.size, 2, 'reused IP is moved into the current window order');

console.log(JSON.stringify({ simulation: 'bounded per-IP rate limiter under unique-IP flood', assertions, passed: assertions, failed: 0 }, null, 2));
