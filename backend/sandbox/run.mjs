import assert from 'node:assert/strict';
import { createApiServer } from '../src/api.mjs';
import { acquireAdvisoryLock } from '../src/db.mjs';

const summaries = [];
let totalAssertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  totalAssertions++;
}

class MockDatabase {
  fail = false;
  keeperActive = true;
  calls = [];
  async query(sql, params = []) {
    this.calls.push({ sql: String(sql), params });
    if (this.fail) throw Object.assign(new Error('simulated database outage'), { code: 'ECONNRESET' });
    if (/SELECT\s+1/i.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/FROM service_heartbeats/i.test(sql)) return { rows: [
      { service_name: 'indexer', instance_id: 'sim-indexer', heartbeat_at: new Date(), details: {} },
      ...(this.keeperActive ? [{ service_name: 'keeper', instance_id: 'sim-keeper', heartbeat_at: new Date(), details: {} }] : [])
    ], rowCount: this.keeperActive ? 2 : 1 };
    if (/FROM indexer_cursors/i.test(sql)) {
      if (/SELECT contract_address/i.test(sql)) return { rows: [{ contract_address: GAME, block_number: 990 }], rowCount: 1 };
      return { rows: [{ block_number: 990 }], rowCount: 1 };
    }
    if (/WITH touched AS/i.test(sql)) return { rows: [{ token_id: '7' }, { token_id: '12' }], rowCount: 2 };
    if (/WITH listing_events AS/i.test(sql)) return { rows: [{ token_id: '12', seller: SELLER, price_usdt: '10000000000000000000', block_number: 989 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
}

const GAME = '0x0000000000000000000000000000000000000056';
const SELLER = '0x00000000000000000000000000000000000000ab';
const PLAYER = '0x00000000000000000000000000000000000000cd';
const API_CONFIG = {
  chainId: 97,
  trustedProxyIps: ['127.0.0.1'],
  metricsToken: 'simulated-metrics-token',
  contracts: { game: GAME, freeDrop: '0x0000000000000000000000000000000000000097', liquidityManager: '0x0000000000000000000000000000000000000098' }
};
let simulatedMarket = {
  ready: true,
  twapAgeSeconds: 20,
  observations: 4,
  observationIntervalSeconds: 5,
  twapPeriodSeconds: 15,
  maximumAgeSeconds: 300
};

function makeProvider(name) {
  return {
    name,
    online: true,
    chainId: 97,
    attempts: 0,
    blocks: 0,
    async getNetwork() {
      this.attempts++;
      if (!this.online) throw Object.assign(new Error('simulated RPC timeout'), { code: 'ETIMEDOUT' });
      return { chainId: BigInt(this.chainId) };
    },
    async getBlockNumber() {
      this.blocks++;
      if (!this.online) throw Object.assign(new Error('simulated RPC timeout'), { code: 'ETIMEDOUT' });
      return 1000 + this.blocks;
    }
  };
}

async function withServer(run) {
  const database = new MockDatabase();
  const providers = [makeProvider('rpc-a'), makeProvider('rpc-b')];
  const server = createApiServer({ config: API_CONFIG, pool: database, providers, publicOrigins: ['https://bai.example'], marketStatusReader: async () => ({ ...simulatedMarket }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, database, providers }); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function get(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

for (let round = 1; round <= 5; round++) {
  const before = totalAssertions;
  await withServer(async ({ base, database, providers }) => {
    let result = await get(base, '/healthz');
    check(result.response.status === 200 && result.body.status === 'ok', `round ${round}: liveness stays healthy`);

    result = await get(base, '/readyz');
    check(result.response.status === 200 && result.body.chainId === 97, `round ${round}: readiness requires DB and a matching RPC`);

    result = await get(base, '/v1/status');
    check(result.response.status === 200 && result.body.indexedContracts[0].blockNumber === 990 && result.body.keeper.state === 'healthy' && result.body.market.state === 'ready', `round ${round}: status returns indexer cursor, fresh keeper heartbeat, and live market readiness`);

    database.keeperActive = false;
    simulatedMarket = { ...simulatedMarket, ready: false, twapAgeSeconds: 301, observations: 2 };
    result = await get(base, '/v1/status');
    check(result.response.status === 200 && result.body.keeper.state === 'stale' && result.body.market.state === 'paused' && result.body.market.twapAgeSeconds === 301, `round ${round}: stopped keeper and expired TWAP are visible as distinct launch blockers`);
    database.keeperActive = true;
    simulatedMarket = { ...simulatedMarket, ready: true, twapAgeSeconds: 20, observations: 4 };

    result = await get(base, `/v1/cards?address=${PLAYER}`, { headers: { 'x-forwarded-for': `198.51.100.${round}` } });
    check(result.response.status === 200 && result.body.tokenIds.join(',') === '7,12', `round ${round}: card endpoint returns indexed holdings`);

    result = await get(base, '/v1/market');
    check(result.response.status === 200 && result.body.listings[0].seller === SELLER, `round ${round}: market endpoint serves indexed active listing`);

    result = await get(base, '/v1/cards?address=bad');
    check(result.response.status === 400 && result.body.error === 'invalid_address', `round ${round}: invalid address is rejected before SQL`);

    result = await get(base, '/missing');
    check(result.response.status === 404, `round ${round}: unknown paths do not fall through`);

    result = await get(base, '/healthz', { method: 'OPTIONS', headers: { origin: 'https://bai.example' } });
    check(result.response.status === 204 && result.response.headers.get('access-control-allow-origin') === 'https://bai.example', `round ${round}: CORS preflight accepts the configured site`);

    result = await get(base, '/healthz', { method: 'OPTIONS', headers: { origin: 'https://attacker.example' } });
    check(result.response.status === 404 && !result.response.headers.has('access-control-allow-origin'), `round ${round}: CORS rejects untrusted sites`);

    result = await get(base, '/metrics');
    check(result.response.status === 404, `round ${round}: metrics are hidden without bearer authorization`);
    result = await get(base, '/metrics', { headers: { authorization: 'Bearer simulated-metrics-token' } });
    check(result.response.status === 200 && result.body.includes('bai_backend_http_requests_total'), `round ${round}: authorized metrics are readable`);

    providers[0].online = false;
    const beforeB = providers[1].attempts;
    result = await get(base, '/readyz');
    check(result.response.status === 200 && providers[1].attempts > beforeB, `round ${round}: RPC-A outage fails over to RPC-B`);

    providers[1].online = false;
    result = await get(base, '/readyz');
    check(result.response.status === 503 && result.body.status === 'not_ready', `round ${round}: all RPCs down returns not-ready`);
    result = await get(base, '/healthz');
    check(result.response.status === 200, `round ${round}: RPC outage does not kill process liveness`);

    providers[0].online = true;
    providers[1].online = true;
    providers[0].chainId = 1;
    providers[1].chainId = 1;
    result = await get(base, '/readyz');
    check(result.response.status === 503, `round ${round}: wrong-chain RPCs are rejected`);
    providers[0].chainId = 97;
    providers[1].chainId = 97;

    database.fail = true;
    result = await get(base, '/readyz');
    check(result.response.status === 503, `round ${round}: database outage returns not-ready`);
    result = await get(base, '/healthz');
    check(result.response.status === 200, `round ${round}: database outage does not kill process liveness`);
    result = await get(base, `/v1/cards?address=${PLAYER}`);
    check(result.response.status === 500 && result.body.error === 'internal_error' && !JSON.stringify(result.body).includes('simulated database outage'), `round ${round}: DB errors are sanitized from public responses`);
    database.fail = false;
    result = await get(base, '/readyz');
    check(result.response.status === 200, `round ${round}: readiness recovers after DB restoration`);

    const client = `203.0.113.${round}`;
    for (let i = 0; i < 60; i++) {
      result = await get(base, `/v1/cards?address=${PLAYER}`, { headers: { 'x-forwarded-for': client } });
      if (result.response.status !== 200) throw new Error(`rate-limit request ${i + 1} unexpectedly returned ${result.response.status}`);
    }
    result = await get(base, `/v1/market`, { headers: { 'x-forwarded-for': client } });
    check(result.response.status === 429, `round ${round}: combined card and market reads enforce the 60/minute IP limit`);
    result = await get(base, `/v1/cards?address=${PLAYER}`, { headers: { 'x-forwarded-for': `203.0.114.${round}` } });
    check(result.response.status === 200, `round ${round}: independent client IP receives its own rate window`);
  });
  summaries.push({ round, assertions: totalAssertions - before, outcome: 'pass' });
}

class MockLockPool {
  locks = new Set();
  async connect() {
    let held;
    return {
      query: async (_sql, [namespace, lockId]) => {
        const key = `${namespace}:${lockId}`;
        if (this.locks.has(key)) return { rows: [{ locked: false }] };
        this.locks.add(key);
        held = key;
        return { rows: [{ locked: true }] };
      },
      release: () => { if (held) this.locks.delete(held); }
    };
  }
}

for (let cycle = 1; cycle <= 5; cycle++) {
  const pool = new MockLockPool();
  const primary = await acquireAdvisoryLock(pool, 97, 2);
  const standby = await acquireAdvisoryLock(pool, 97, 2);
  check(!!primary && standby === null, `lock cycle ${cycle}: only one keeper acquires the advisory lock`);
  primary.release();
  const promoted = await acquireAdvisoryLock(pool, 97, 2);
  check(!!promoted, `lock cycle ${cycle}: standby takes over after primary disconnect`);
  promoted.release();
}

console.log(JSON.stringify({
  simulation: 'HTTP backend + PostgreSQL/RPC fault injection + advisory-lock failover',
  rounds: summaries.length,
  keeperFailoverCycles: 5,
  assertions: totalAssertions,
  passed: totalAssertions,
  failed: 0,
  roundsSummary: summaries
}, null, 2));
