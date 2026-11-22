import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { currentRequestId, errorCode, log } from './logger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export function createPool(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    application_name: `bai-${process.env.SERVICE_NAME || 'backend'}`,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: true }
  });
  pool.on('error', (error) => log('error', 'database_pool_error', { errorCode: errorCode(error) }));
  pool.on('connect', (client) => instrumentClientQuery(client, pool));
  return pool;
}

export function instrumentClientQuery(client, pool) {
    const originalQuery = client.query.bind(client);
    client.query = (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
      const operation = (sql.match(/^\s*(select|insert|update|delete|begin|commit|rollback|create|alter|drop|with)/i)?.[1] || 'other').toLowerCase();
      const tableMatch = sql.match(/\b(?:from|into|update)\s+([a-zA-Z0-9_."]+)|\btable\s+(?:if\s+not\s+exists\s+)?([a-zA-Z0-9_."]+)/i);
      const table = (tableMatch?.[1] || tableMatch?.[2] || 'unknown').replaceAll('"', '');
      const normalizedSql = sql.replace(/'(?:''|[^'])*'/g, '?').replace(/\b\d+\b/g, '?').replace(/\$\d+/g, '$?').replace(/\s+/g, ' ').trim();
      const queryFingerprint = createHash('sha256').update(normalizedSql).digest('hex').slice(0, 16);
      const started = process.hrtime.bigint();
      const queryId = randomUUID();
      const callbackIndex = args.findLastIndex((value) => typeof value === 'function');
      const logQuery = (error, result) => log(error ? 'error' : 'info', error ? 'database_query_failed' : 'database_query_complete', {
        ...(currentRequestId() ? { requestId: currentRequestId() } : {}),
        queryId, operation, table, queryFingerprint,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
        poolWaiting: pool.waitingCount, poolTotal: pool.totalCount, poolIdle: pool.idleCount,
        ...(error ? { errorCode: errorCode(error) } : { rowCount: result?.rowCount ?? null })
      });
      if (callbackIndex >= 0) {
        const callback = args[callbackIndex];
        args[callbackIndex] = function (error, result) { logQuery(error, result); return callback.apply(this, arguments); };
        return originalQuery(...args);
      }
      const query = originalQuery(...args);
      if (!query || typeof query.then !== 'function') return query;
      return query.then((result) => {
        logQuery(null, result);
        return result;
      }, (error) => {
        logQuery(error);
        throw error;
      });
    };
}

export async function migrate(pool) {
  const client = await pool.connect();
  try {
  await client.query('SELECT pg_advisory_lock(2147483646, 2147483646)');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const directory = path.resolve(here, '../migrations');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
    if (rows.length) continue;
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(directory, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  } finally {
    await client.query('SELECT pg_advisory_unlock(2147483646, 2147483646)').catch(() => {});
    client.release();
  }
}

export async function acquireAdvisoryLock(pool, namespace, lockId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [namespace, lockId]);
    if (!rows[0].locked) {
      client.release();
      return null;
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

export async function heartbeat(pool, serviceName, instanceId, details = {}) {
  await pool.query(
    `INSERT INTO service_heartbeats(service_name, instance_id, heartbeat_at, details)
     VALUES ($1, $2, now(), $3::jsonb)
     ON CONFLICT (service_name, instance_id) DO UPDATE SET
       heartbeat_at = EXCLUDED.heartbeat_at,
       details = EXCLUDED.details`,
    [serviceName, instanceId, JSON.stringify(details)]
  );
}
