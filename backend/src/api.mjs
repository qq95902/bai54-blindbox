import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ethers } from 'ethers';
import { loadConfig } from './config.mjs';
import { createPool, migrate, heartbeat } from './db.mjs';
import { verifyChainAndContracts } from './chain.mjs';
import { errorCode, instanceId, instrumentRpc, log, requestId, withRequestContext } from './logger.mjs';
import { resolveClientIp } from './client-ip.mjs';
import { consumeIpRateLimit } from './ip-rate-limit.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { managerStatusAbi } from './abis.mjs';

export function createApiServer({ config, pool, providers, publicOrigins: configuredOrigins, marketStatusReader } = {}) {
  if (!config || !pool || !Array.isArray(providers) || providers.length < 1) throw new Error('API_CONFIG_POOL_AND_RPC_PROVIDERS_REQUIRED');
  const metrics = { requests: 0, errors: 0, durationMs: 0, readyFailures: 0 };
  let activeProvider = 0;
  const publicOrigins = new Set(configuredOrigins || (process.env.PUBLIC_SITE_ORIGINS || 'https://qq95902.github.io')
    .split(',').map((origin) => origin.trim()).filter(Boolean));
  const cardReadsByIp = new Map();
  const depositAddressReadsByIp = new Map();
  let challengeCleanupCounter = 0;

  async function getChainStatus() {
  let lastError;
  for (let i = 0; i < providers.length; i++) {
    const index = (activeProvider + i) % providers.length;
    try {
      const network = await providers[index].getNetwork();
      if (Number(network.chainId) !== config.chainId) throw new Error('RPC_CHAIN_ID_MISMATCH');
      const block = await providers[index].getBlockNumber();
      activeProvider = index;
      return { blockNumber: block, providerIndex: index };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('RPC_UNAVAILABLE');
}

async function getMarketStatus(providerIndex) {
  const provider = providers[providerIndex];
  const result = marketStatusReader
    ? await marketStatusReader(provider)
    : await (async () => {
      const manager = new ethers.Contract(config.contracts.liquidityManager, managerStatusAbi, provider);
      const [ready, twap, observations, observationIntervalSeconds, twapPeriodSeconds, maximumAgeSeconds] = await Promise.all([
        manager.marketReady(), manager.twapStatus(), manager.observationCount(), manager.observationInterval(),
        manager.twapPeriod(), manager.maxObservationAge()
      ]);
      return {
        ready,
        twapAgeSeconds: Number(twap.age),
        observations: Number(observations),
        observationIntervalSeconds: Number(observationIntervalSeconds),
        twapPeriodSeconds: Number(twapPeriodSeconds),
        maximumAgeSeconds: Number(maximumAgeSeconds)
      };
    })();
  return { ...result, state: result.ready ? 'ready' : 'paused' };
}

function routeTemplate(pathname) {
  if (pathname === '/healthz' || pathname === '/readyz' || pathname === '/metrics' || pathname === '/v1/status' || pathname === '/v1/cards' || pathname === '/v1/market' || pathname === '/v1/purchase-status' || pathname === '/v1/deposit-challenge' || pathname === '/v1/deposit-address') return pathname;
  return '/not-found';
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

async function readJsonBody(req, maximumBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBytes) throw Object.assign(new Error('request_body_too_large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid_json'), { statusCode: 400 }); }
}

  function authorizedMetrics(req) {
    if (!config.metricsToken) return false;
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${config.metricsToken}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  const server = http.createServer((req, res) => {
  const id = requestId();
  return withRequestContext(id, async () => {
  const started = process.hrtime.bigint();
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  const origin = req.headers.origin;
  if (origin && publicOrigins.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
  }
  let status = 500;
  let requestErrorCode;
  res.setHeader('x-request-id', id);
  try {
    if (req.method === 'OPTIONS' && origin && publicOrigins.has(origin)) {
      status = 204; res.writeHead(status); return res.end();
    }
    if (req.method === 'GET' && pathname === '/healthz') {
      status = 200; return json(res, status, { status: 'ok' });
    }
    if (req.method === 'GET' && pathname === '/readyz') {
      try {
        await pool.query('SELECT 1');
        const chain = await getChainStatus();
        await heartbeat(pool, 'api', instanceId, { chainId: config.chainId, blockNumber: chain.blockNumber });
        status = 200; return json(res, status, {
          status: 'ready', chainId: config.chainId, blockNumber: chain.blockNumber,
          features: config.usdtAddress && config.contracts.purchaseProcessor ? ['buyer_bound_usdt_vaults'] : []
        });
      } catch (error) {
        requestErrorCode = errorCode(error);
        metrics.readyFailures++;
        status = 503; return json(res, status, { status: 'not_ready', errorCode: errorCode(error) });
      }
    }
    if (req.method === 'GET' && pathname === '/v1/status') {
      const chain = await getChainStatus();
      const { rows } = await pool.query(
        `SELECT service_name, instance_id, heartbeat_at, details
         FROM service_heartbeats WHERE heartbeat_at > now() - interval '2 minutes'
         ORDER BY service_name`
      );
      const cursor = await pool.query('SELECT contract_address, block_number FROM indexer_cursors WHERE chain_id = $1 ORDER BY contract_address', [config.chainId]);
      const keeperHeartbeat = rows.find((row) => row.service_name === 'keeper');
      const keeperAgeMs = keeperHeartbeat ? Math.max(0, Date.now() - new Date(keeperHeartbeat.heartbeat_at).getTime()) : null;
      let market;
      try {
        market = await getMarketStatus(chain.providerIndex);
      } catch (error) {
        market = { ready: null, state: 'unknown', errorCode: errorCode(error) };
      }
      status = 200;
      return json(res, status, {
        chainId: config.chainId,
        latestBlock: chain.blockNumber,
        indexedContracts: cursor.rows.map((row) => ({ address: row.contract_address, blockNumber: Number(row.block_number) })),
        services: rows.map((row) => ({ name: row.service_name, instance: row.instance_id, heartbeatAt: row.heartbeat_at, details: row.details })),
        keeper: {
          state: keeperHeartbeat && keeperAgeMs <= 120_000 ? 'healthy' : 'stale',
          heartbeatAt: keeperHeartbeat?.heartbeat_at || null,
          ageSeconds: keeperAgeMs === null ? null : Math.floor(keeperAgeMs / 1000)
        },
        market
      });
    }
    if (req.method === 'POST' && (pathname === '/v1/deposit-challenge' || pathname === '/v1/deposit-address')) {
      if (!config.usdtAddress || !config.contracts.purchaseProcessor) {
        status = 503;
        return json(res, status, { error: 'direct_usdt_purchases_not_configured' });
      }
      const now = Date.now();
      const ip = resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], config.trustedProxyIps);
      if (!consumeIpRateLimit(depositAddressReadsByIp, ip, now, { limit: 30 })) {
        status = 429; return json(res, status, { error: 'rate_limited' });
      }

      const body = await readJsonBody(req);
      const buyer = body?.buyer || '';
      const referrer = body?.referrer || ethers.ZeroAddress;
      if (!ethers.isAddress(buyer) || buyer === ethers.ZeroAddress || !ethers.isAddress(referrer)) {
        status = 400;
        return json(res, status, { error: 'invalid_buyer_or_referrer' });
      }
      const normalizedBuyer = ethers.getAddress(buyer);
      const normalizedReferrer = ethers.getAddress(referrer);
      if (normalizedBuyer.toLowerCase() === normalizedReferrer.toLowerCase()) {
        status = 400;
        return json(res, status, { error: 'self_referral_not_allowed' });
      }
      if (pathname === '/v1/deposit-challenge') {
        const requestOrigin = typeof origin === 'string' && publicOrigins.has(origin) ? origin : [...publicOrigins][0];
        if (!requestOrigin) {
          status = 503;
          return json(res, status, { error: 'public_site_origin_not_configured' });
        }
        const issuedAt = new Date(now).toISOString();
        const expiresAt = new Date(now + 5 * 60_000).toISOString();
        const challengeId = randomBytes(32).toString('hex');
        const message = [
          'BAI Blind Box',
          'Action: Create a buyer-bound USDT deposit address',
          `Origin: ${requestOrigin}`,
          `Buyer: ${normalizedBuyer}`,
          `Referrer: ${normalizedReferrer}`,
          `Chain ID: ${config.chainId}`,
          `Nonce: ${challengeId}`,
          `Issued At: ${issuedAt}`,
          `Expires At: ${expiresAt}`
        ].join('\n');
        await pool.query(
          `INSERT INTO wallet_signing_challenges
           (challenge_id,chain_id,buyer_address,referrer_address,origin,message,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [challengeId, config.chainId, normalizedBuyer.toLowerCase(), normalizedReferrer.toLowerCase(), requestOrigin, message, expiresAt]
        );
        challengeCleanupCounter++;
        if (challengeCleanupCounter >= 128) {
          challengeCleanupCounter = 0;
          await pool.query(
            `WITH expired AS (
               SELECT challenge_id FROM wallet_signing_challenges
               WHERE expires_at < now() - interval '1 day' LIMIT 500
             )
             DELETE FROM wallet_signing_challenges WHERE challenge_id IN (SELECT challenge_id FROM expired)`
          );
        }
        status = 200;
        return json(res, status, { challengeId, message, expiresAt, chainId: config.chainId });
      }

      const challengeId = body?.challengeId || '';
      const signature = body?.signature || '';
      if (!/^[0-9a-f]{64}$/i.test(challengeId) || !/^0x[0-9a-f]{130}$/i.test(signature)) {
        status = 400;
        return json(res, status, { error: 'valid_deposit_signature_required' });
      }
      const challengeResult = await pool.query(
        `SELECT buyer_address,referrer_address,origin,message,expires_at,used_at
         FROM wallet_signing_challenges WHERE challenge_id=$1 AND chain_id=$2 LIMIT 1`,
        [challengeId, config.chainId]
      );
      const challenge = challengeResult.rows[0];
      if (!challenge || challenge.used_at || new Date(challenge.expires_at).getTime() <= now ||
          challenge.buyer_address.toLowerCase() !== normalizedBuyer.toLowerCase() ||
          challenge.referrer_address.toLowerCase() !== normalizedReferrer.toLowerCase()) {
        status = 409;
        return json(res, status, { error: 'deposit_signature_expired_or_mismatched' });
      }
      if (origin && (!publicOrigins.has(origin) || challenge.origin !== origin)) {
        status = 403;
        return json(res, status, { error: 'deposit_signature_origin_mismatch' });
      }
      let recoveredAddress;
      try { recoveredAddress = ethers.verifyMessage(challenge.message, signature); }
      catch { recoveredAddress = ethers.ZeroAddress; }
      if (recoveredAddress.toLowerCase() !== normalizedBuyer.toLowerCase()) {
        status = 401;
        return json(res, status, { error: 'deposit_signature_invalid' });
      }
      const chain = await getChainStatus();
      const provider = providers[chain.providerIndex];
      const processor = new ethers.Contract(config.contracts.purchaseProcessor, [
        'function predictVault(address buyer,address referrer) view returns(address)'
      ], provider);
      const game = new ethers.Contract(config.contracts.game, [
        'function hasPurchased(address wallet) view returns(bool)',
        'function referrerOf(address wallet) view returns(address)'
      ], provider);
      if (normalizedReferrer !== ethers.ZeroAddress && !(await game.hasPurchased(normalizedReferrer))) {
        status = 400;
        return json(res, status, { error: 'referrer_not_eligible' });
      }
      if (await game.hasPurchased(normalizedBuyer)) {
        const boundReferrer = await game.referrerOf(normalizedBuyer);
        if (boundReferrer.toLowerCase() !== normalizedReferrer.toLowerCase()) {
          status = 409;
          return json(res, status, { error: 'buyer_referrer_already_bound' });
        }
      }
      const vault = await processor.predictVault(normalizedBuyer, normalizedReferrer);
      const consumed = await pool.query(
        `UPDATE wallet_signing_challenges SET used_at=now()
         WHERE challenge_id=$1 AND chain_id=$2 AND buyer_address=$3 AND referrer_address=$4
           AND used_at IS NULL AND expires_at > now()`,
        [challengeId, config.chainId, normalizedBuyer.toLowerCase(), normalizedReferrer.toLowerCase()]
      );
      if (consumed.rowCount !== 1) {
        status = 409;
        return json(res, status, { error: 'deposit_signature_already_used' });
      }
      const { rowCount } = await pool.query(
        `INSERT INTO purchase_vaults(chain_id,processor_address,buyer_address,referrer_address,vault_address)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (chain_id,processor_address,buyer_address,referrer_address)
         DO UPDATE SET vault_address=EXCLUDED.vault_address
         WHERE purchase_vaults.vault_address=EXCLUDED.vault_address`,
        [config.chainId, config.contracts.purchaseProcessor.toLowerCase(), normalizedBuyer.toLowerCase(), normalizedReferrer.toLowerCase(), vault.toLowerCase()]
      );
      if (rowCount === 0) {
        status = 409;
        return json(res, status, { error: 'deposit_vault_registry_conflict' });
      }
      status = 200;
      return json(res, status, { buyer: normalizedBuyer, referrer: normalizedReferrer, vault, chainId: config.chainId });
    }
    if (req.method === 'GET' && pathname === '/v1/purchase-status') {
      if (!config.usdtAddress || !config.contracts.purchaseProcessor) {
        status = 503;
        return json(res, status, { state: 'unavailable', error: 'direct_usdt_purchases_not_configured' });
      }
      const params = new URL(req.url || '/', 'http://localhost').searchParams;
      const txHash = params.get('txHash') || '';
      const wallet = params.get('address') || '';
      if ((!txHash && !wallet) || (txHash && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) ||
          (wallet && !ethers.isAddress(wallet))) {
        status = 400;
        return json(res, status, { error: 'provide_a_valid_txHash_or_address' });
      }
      const now = Date.now();
      const ip = resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], config.trustedProxyIps);
      if (!consumeIpRateLimit(cardReadsByIp, ip, now, { limit: 60 })) {
        status = 429; return json(res, status, { error: 'rate_limited' });
      }
      const normalizedHash = txHash.toLowerCase();
      const { rows } = txHash
        ? await pool.query(
          `SELECT args, block_number, transaction_hash FROM chain_events
           WHERE chain_id=$1 AND contract_address=$2 AND transaction_hash=$3 AND event_name='Transfer'
           ORDER BY log_index`,
          [config.chainId, config.usdtAddress.toLowerCase(), normalizedHash]
        )
        : await pool.query(
          `SELECT args, block_number, transaction_hash FROM chain_events
           WHERE chain_id=$1 AND contract_address=$2 AND event_name='Transfer'
             AND args ? 'depositId'
             AND (lower(args->>'from')=$4 OR lower(args->>'to') IN (
               SELECT vault_address FROM purchase_vaults
               WHERE chain_id=$1 AND processor_address=$3 AND buyer_address=$4
             ))
           ORDER BY block_number DESC,log_index DESC LIMIT 1`,
          [config.chainId, config.usdtAddress.toLowerCase(), config.contracts.purchaseProcessor.toLowerCase(), wallet.toLowerCase()]
        );
      const transfer = rows.find((row) => row.args?.depositId);
      if (transfer) {
        const effectiveHash = normalizedHash || transfer.transaction_hash?.toLowerCase();
        const id = transfer.args.depositId;
        const terminal = await pool.query(
          `SELECT event_name,args FROM chain_events
           WHERE chain_id=$1 AND contract_address=$2
             AND event_name IN ('DepositSettled','DepositRefunded','UnregisteredTransferRefundAuthorized','UnregisteredTransferReturned')
             AND args->>'depositId'=$3 ORDER BY block_number DESC,log_index DESC LIMIT 1`,
          [config.chainId, config.contracts.purchaseProcessor.toLowerCase(), id]
        );
        const binding = await pool.query(
          `SELECT buyer_address,referrer_address FROM purchase_vaults
           WHERE chain_id=$1 AND processor_address=$2 AND vault_address=$3 LIMIT 1`,
          [config.chainId, config.contracts.purchaseProcessor.toLowerCase(), transfer.args.to.toLowerCase()]
        );
        const registered = await pool.query(
          `SELECT block_number FROM chain_events WHERE chain_id=$1 AND contract_address=$2
           AND event_name='DepositRegistered' AND args->>'depositId'=$3 ORDER BY block_number DESC LIMIT 1`,
          [config.chainId, config.contracts.purchaseProcessor.toLowerCase(), id]
        );
        const finalEvent = terminal.rows[0];
        const boundBuyer = binding.rows[0]?.buyer_address?.toLowerCase() || transfer.args.from.toLowerCase();
        const senderMismatch = boundBuyer !== transfer.args.from.toLowerCase();
        const state = finalEvent?.event_name === 'UnregisteredTransferReturned' ? 'refunded_to_buyer'
          : finalEvent?.event_name === 'DepositSettled' ? 'settled'
          : finalEvent?.event_name === 'DepositRefunded' ? 'refunded'
          : finalEvent?.event_name === 'UnregisteredTransferRefundAuthorized' ? 'refund_available'
          : registered.rows[0] ? 'pending_settlement' : 'pending_keeper_registration';
        status = 200;
        return json(res, status, {
          state, transactionHash: effectiveHash, depositId: id,
          buyer: boundBuyer, sender: transfer.args.from.toLowerCase(),
          ...(finalEvent && ['UnregisteredTransferRefundAuthorized', 'UnregisteredTransferReturned'].includes(finalEvent.event_name)
            ? { refundRecipient: finalEvent.args?.buyer?.toLowerCase() || boundBuyer }
            : {}),
          referrer: binding.rows[0]?.referrer_address?.toLowerCase() || ethers.ZeroAddress,
          vault: transfer.args.to.toLowerCase(), amount: transfer.args.value,
          transferBlock: Number(transfer.block_number),
          ...(registered.rows[0] ? { registeredBlock: Number(registered.rows[0].block_number) } : {}),
          ...(finalEvent ? { outcome: finalEvent.args } : {}),
          ...(senderMismatch ? { senderMismatch: true } : {})
        });
      }
      if (wallet) {
        status = 200;
        return json(res, status, { state: 'not_found', address: wallet.toLowerCase() });
      }
      const chain = await getChainStatus();
      const receipt = await providers[chain.providerIndex].getTransactionReceipt(normalizedHash);
      if (receipt && Number(receipt.status) === 0) {
        status = 200;
        return json(res, status, { state: 'transaction_failed', transactionHash: normalizedHash });
      }
      status = 200;
      return json(res, status, {
        state: receipt ? 'confirming_or_indexing' : 'not_found', transactionHash: normalizedHash,
        ...(receipt ? {
          transferBlock: Number(receipt.blockNumber),
          confirmations: Math.max(0, chain.blockNumber - Number(receipt.blockNumber) + 1)
        } : {})
      });
    }
    if (req.method === 'GET' && pathname === '/v1/cards') {
      const address = new URL(req.url || '/', 'http://localhost').searchParams.get('address') || '';
      if (!ethers.isAddress(address)) { status = 400; return json(res, status, { error: 'invalid_address' }); }
      const now = Date.now();
      const ip = resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], config.trustedProxyIps);
      if (!consumeIpRateLimit(cardReadsByIp, ip, now, { limit: 60 })) {
        status = 429; return json(res, status, { error: 'rate_limited' });
      }
      const normalized = address.toLowerCase();
      const gameAddress = config.contracts.game.toLowerCase();
      const cursor = await pool.query(
        'SELECT block_number FROM indexer_cursors WHERE chain_id = $1 AND contract_address = $2',
        [config.chainId, gameAddress]
      );
      const { rows } = await pool.query(
        `WITH touched AS (
           SELECT DISTINCT args->>'tokenId' AS token_id
           FROM chain_events
           WHERE chain_id = $1 AND contract_address = $2 AND event_name = 'Transfer'
             AND (lower(args->>'from') = $3 OR lower(args->>'to') = $3)
         ), latest AS (
           SELECT DISTINCT ON (e.args->>'tokenId') e.args->>'tokenId' AS token_id, lower(e.args->>'to') AS owner
           FROM chain_events e JOIN touched t ON t.token_id = e.args->>'tokenId'
           WHERE e.chain_id = $1 AND e.contract_address = $2 AND e.event_name = 'Transfer'
           ORDER BY e.args->>'tokenId', e.block_number DESC, e.transaction_index DESC, e.log_index DESC
         )
         SELECT token_id FROM latest WHERE owner = $3 ORDER BY token_id::numeric LIMIT 10000`,
        [config.chainId, gameAddress, normalized]
      );
      status = 200;
      return json(res, status, {
        address: normalized,
        tokenIds: rows.map((row) => row.token_id),
        indexedThroughBlock: cursor.rows[0] ? Number(cursor.rows[0].block_number) : null,
        complete: rows.length < 10000
      });
    }
    if (req.method === 'GET' && pathname === '/v1/market') {
      const now = Date.now();
      const ip = resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], config.trustedProxyIps);
      if (!consumeIpRateLimit(cardReadsByIp, ip, now, { limit: 60 })) {
        status = 429; return json(res, status, { error: 'rate_limited' });
      }
      const cursor = await pool.query(
        'SELECT block_number FROM indexer_cursors WHERE chain_id = $1 AND contract_address = $2',
        [config.chainId, config.contracts.game.toLowerCase()]
      );
      const { rows } = await pool.query(
        `WITH listing_events AS (
           SELECT args->>'tokenId' AS token_id, event_name, args, block_number, transaction_index, log_index
           FROM chain_events
           WHERE chain_id = $1 AND contract_address = $2
             AND event_name IN ('ListingCreated', 'ListingCancelled', 'CardPurchased')
         ), latest AS (
           SELECT DISTINCT ON (token_id) token_id, event_name, args, block_number
           FROM listing_events
           ORDER BY token_id, block_number DESC, transaction_index DESC, log_index DESC
         )
         SELECT token_id, lower(args->>'seller') AS seller, args->>'priceUSDT' AS price_usdt, block_number
         FROM latest WHERE event_name = 'ListingCreated'
         ORDER BY block_number DESC, token_id::numeric DESC LIMIT 1000`,
        [config.chainId, config.contracts.game.toLowerCase()]
      );
      status = 200;
      return json(res, status, {
        listings: rows.map((row) => ({ tokenId: row.token_id, seller: row.seller, priceUSDT: row.price_usdt })),
        indexedThroughBlock: cursor.rows[0] ? Number(cursor.rows[0].block_number) : null,
        complete: rows.length < 1000
      });
    }
    if (req.method === 'GET' && pathname === '/metrics') {
      if (!authorizedMetrics(req)) { status = 404; return json(res, status, { error: 'not_found' }); }
      status = 200;
      const output = [
        '# HELP bai_backend_http_requests_total Completed HTTP requests',
        '# TYPE bai_backend_http_requests_total counter',
        `bai_backend_http_requests_total ${metrics.requests}`,
        '# HELP bai_backend_http_errors_total HTTP requests returning 5xx',
        '# TYPE bai_backend_http_errors_total counter',
        `bai_backend_http_errors_total ${metrics.errors}`,
        '# HELP bai_backend_http_duration_ms_total Sum of request duration in milliseconds',
        '# TYPE bai_backend_http_duration_ms_total counter',
        `bai_backend_http_duration_ms_total ${metrics.durationMs}`,
        '# HELP bai_backend_readiness_failures_total Readiness check failures',
        '# TYPE bai_backend_readiness_failures_total counter',
        `bai_backend_readiness_failures_total ${metrics.readyFailures}`
      ].join('\n') + '\n';
      res.writeHead(status, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(output);
    }
    status = 404;
    return json(res, status, { error: 'not_found' });
  } catch (error) {
    requestErrorCode = errorCode(error);
    status = error.statusCode || 500;
    return json(res, status, { error: status === 413 ? 'request_body_too_large' : status === 400 ? 'invalid_json' : 'internal_error', requestId: id });
  } finally {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    metrics.requests++;
    metrics.durationMs += durationMs;
    if (status >= 500) metrics.errors++;
    log(status >= 500 ? 'error' : 'info', 'http_request_complete', {
      requestId: id, method: req.method, route: routeTemplate(pathname), status, durationMs: Math.round(durationMs * 100) / 100,
      ...(requestErrorCode ? { errorCode: requestErrorCode } : {})
    });
  }
  });
});
server.headersTimeout = 15000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  return server;
}

export async function startApi() {
  const config = loadConfig('api');
  const pool = createPool(config.databaseUrl);
  const providers = config.rpcUrls.map((url, index) => instrumentRpc(new ethers.JsonRpcProvider(url), `rpc-${index + 1}`));
  await migrate(pool);
  let activeProvider = 0;
  let lastError;
  for (let index = 0; index < providers.length; index++) {
    try {
      const network = await providers[index].getNetwork();
      if (Number(network.chainId) !== config.chainId) throw new Error('RPC_CHAIN_ID_MISMATCH');
      await providers[index].getBlockNumber();
      activeProvider = index;
      lastError = null;
      break;
    } catch (error) { lastError = error; }
  }
  if (lastError) { await pool.end(); throw lastError; }
  await verifyChainAndContracts(providers[activeProvider], config);
  const server = createApiServer({ config, pool, providers });
  server.listen(config.port, '0.0.0.0', () => log('info', 'api_listening', { port: config.port, chainId: config.chainId }));
  async function shutdown(signal) {
    log('info', 'shutdown_started', { signal });
    server.close(async () => { await pool.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return { server, pool };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await startApi();
