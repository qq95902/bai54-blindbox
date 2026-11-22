import { performance } from 'node:perf_hooks';
import { createApiServer } from '../src/api.mjs';

const CLIENTS = 3_000;
const CLIENTS_PER_WAVE = 50;
const POOL_MAX = 10;
const SIMULATED_QUERY_MS = 5;
const GAME = '0x0000000000000000000000000000000000000056';
const config = {
  chainId: 97,
  trustedProxyIps: ['127.0.0.1'],
  contracts: { game: GAME, freeDrop: '0x0000000000000000000000000000000000000097', liquidityManager: '0x0000000000000000000000000000000000000098' }
};

class SimulatedPostgresPool {
  active = 0;
  maxActive = 0;
  queued = 0;
  maxQueued = 0;
  queryCount = 0;
  waiters = [];

  async query(sql) {
    this.queryCount++;
    if (this.active >= POOL_MAX) {
      this.queued++;
      this.maxQueued = Math.max(this.maxQueued, this.queued);
      await new Promise((resolve) => this.waiters.push(resolve));
      this.queued--;
    }
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, SIMULATED_QUERY_MS));
      if (/SELECT\s+block_number/i.test(sql)) return { rows: [{ block_number: 123456 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

const database = new SimulatedPostgresPool();
const rpc = { async getNetwork() { return { chainId: 97n }; }, async getBlockNumber() { return 123456; } };
const server = createApiServer({ config, pool: database, providers: [rpc], publicOrigins: ['https://bai.example'] });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const originalWrite = process.stdout.write.bind(process.stdout);
let suppressedLogLines = 0;
process.stdout.write = (chunk, ...args) => {
  suppressedLogLines += String(chunk).split('\n').filter(Boolean).length;
  return true;
};
const rssStart = process.memoryUsage().rss;
let peakRss = rssStart;
const memorySampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
const latencies = [];
const statusCounts = new Map();
const startedAt = performance.now();

try {
  for (let offset = 0; offset < CLIENTS; offset += CLIENTS_PER_WAVE) {
    const requests = Array.from({ length: Math.min(CLIENTS_PER_WAVE, CLIENTS - offset) }, (_, j) => {
      const i = offset + j;
      const ip = `198.18.${Math.floor(i / 256)}.${(i % 256) + 1}`;
      const address = `0x${(BigInt(i + 1)).toString(16).padStart(40, '0')}`;
      return ['/v1/cards?address=' + address, '/v1/market'].map(async (route) => {
        const started = performance.now();
        try {
          const response = await fetch(`${base}${route}`, { headers: { 'x-forwarded-for': ip } });
          await response.arrayBuffer();
          statusCounts.set(response.status, (statusCounts.get(response.status) || 0) + 1);
          latencies.push(performance.now() - started);
        } catch {
          statusCounts.set('network_error', (statusCounts.get('network_error') || 0) + 1);
          latencies.push(performance.now() - started);
        }
      });
    }).flat();
    await Promise.all(requests);
  }
} finally {
  clearInterval(memorySampler);
  process.stdout.write = originalWrite;
  await new Promise((resolve) => server.close(resolve));
}

latencies.sort((a, b) => a - b);
const percentile = (p) => Number(latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)]?.toFixed(2) || 0);
const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
const report = {
  simulation: '3,000 virtual API clients in controlled concurrency waves',
  requests: CLIENTS * 2,
  uniqueClients: CLIENTS,
  clientsPerWave: CLIENTS_PER_WAVE,
  maxConcurrentRequests: CLIENTS_PER_WAVE * 2,
  routes: ['/v1/cards', '/v1/market'],
  databaseModel: { poolMax: POOL_MAX, queryLatencyMs: SIMULATED_QUERY_MS, note: 'Synthetic bounded pool; not a real PostgreSQL benchmark.' },
  elapsedMs,
  requestsPerSecond: Number((CLIENTS * 2 * 1000 / elapsedMs).toFixed(1)),
  latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: Number(latencies.at(-1)?.toFixed(2) || 0) },
  httpStatuses: Object.fromEntries(statusCounts),
  sqlQueries: database.queryCount,
  databaseConcurrency: { maxActive: database.maxActive, maxQueued: database.maxQueued },
  memory: { rssStartMB: +(rssStart / 1024 / 1024).toFixed(1), peakRssMB: +(peakRss / 1024 / 1024).toFixed(1), deltaMB: +((peakRss - rssStart) / 1024 / 1024).toFixed(1) },
  requestLogsCaptured: suppressedLogLines,
  result: latencies.length === CLIENTS * 2 && statusCounts.get(200) === CLIENTS * 2 ? 'PASS' : 'FAIL'
};
console.log(JSON.stringify(report, null, 2));
if (report.result !== 'PASS' || database.maxActive > POOL_MAX) process.exitCode = 1;
