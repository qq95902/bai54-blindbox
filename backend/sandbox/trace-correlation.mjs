import assert from 'node:assert/strict';
import { instrumentClientQuery } from '../src/db.mjs';
import { instrumentRpc, log, withRequestContext } from '../src/logger.mjs';

const records = [];
const originalWrite = process.stdout.write;
process.stdout.write = (chunk) => { records.push(JSON.parse(String(chunk))); return true; };

const client = {
  async query() { return { rowCount: 1, rows: [] }; }
};
const pool = { waitingCount: 0, totalCount: 1, idleCount: 0 };
instrumentClientQuery(client, pool);
const provider = instrumentRpc({ async send() { return '0x61'; } }, 'rpc-test');

try {
  await withRequestContext('req-correlation-001', async () => {
    await client.query('SELECT 1');
    await provider.send('eth_chainId', []);
    log('info', 'http_request_complete', { method: 'GET', route: '/readyz', status: 200 });
  });
  await provider.send('eth_blockNumber', []);

  const db = records.find((record) => record.event === 'database_query_complete');
  const rpc = records.find((record) => record.event === 'rpc_request_complete');
  const http = records.find((record) => record.event === 'http_request_complete');
  const backgroundRpc = records.filter((record) => record.event === 'rpc_request_complete')[1];
  assert.equal(db.requestId, 'req-correlation-001', 'database query inherits the HTTP request ID');
  assert.equal(rpc.requestId, 'req-correlation-001', 'RPC call inherits the HTTP request ID');
  assert.equal(http.requestId, 'req-correlation-001', 'HTTP completion carries the same request ID');
  assert.ok(db.queryId, 'database query keeps a distinct query ID');
  assert.ok(rpc.rpcCallId, 'RPC call keeps a distinct call ID');
  assert.equal(backgroundRpc.requestId, undefined, 'background RPC is not assigned a fake HTTP request ID');
  assert.ok(backgroundRpc.rpcCallId, 'background RPC remains individually traceable');
  process.stdout.write = originalWrite;
  console.log(JSON.stringify({ simulation: 'HTTP, database, and RPC trace correlation', assertions: 7, passed: 7, failed: 0 }, null, 2));
} finally {
  process.stdout.write = originalWrite;
}
