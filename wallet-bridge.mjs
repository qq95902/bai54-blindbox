import { createServer } from 'node:http';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8788);
const origins = new Set([
  `http://127.0.0.1:${port}`, `http://localhost:${port}`,
  'http://127.0.0.1:8787', 'http://localhost:8787'
]);

const bawPath = realpathSync(spawnSync('which', ['baw'], { encoding: 'utf8' }).stdout.trim());
const QRCode = createRequire(bawPath)('qrcode');
const requestContext = new AsyncLocalStorage();
let pairing = null;
let verifyProcess = null;

function emitLog(event, fields = {}) {
  // Keep logs machine-readable and avoid recording request bodies, wallet addresses,
  // pairing codes, QR contents, CLI output, or raw query strings.
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'bai-wallet-bridge',
    requestId: requestContext.getStore()?.requestId,
    event,
    ...fields
  })}\n`);
}

function routeName(pathname) {
  if (pathname === '/api/auth/signin') return 'auth.signin';
  if (pathname === '/api/auth/status') return 'auth.status';
  if (pathname === '/api/auth/cancel') return 'auth.cancel';
  if (pathname === '/' || pathname.endsWith('.html')) return 'static.html';
  if (/\.(css|js|svg|png|jpe?g|webp)$/i.test(pathname)) return 'static.asset';
  return 'other';
}

function safeError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/0x[a-fA-F0-9]{40}/g, '[address]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .slice(0, 180);
}

function parseCliJson(output) {
  const text = String(output || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Binance CLI did not return JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

async function cli(args, timeout = 20_000) {
  const operation = args.slice(0, 2).join('.');
  const startedAt = performance.now();
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('baw', args, { timeout, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    stdout = error.stdout || '';
    try {
      const failed = parseCliJson(stdout);
      if (failed.error?.message) throw new Error(failed.error.message);
    } catch (parseError) {
      if (parseError.message !== 'Binance CLI did not return JSON.') throw parseError;
    }
    const stderr = String(error.stderr || '').trim();
    const failure = new Error(stderr || error.message || 'Binance CLI request failed.');
    emitLog('dependency.operation', {
      operation,
      outcome: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      errorType: error.code || error.name || 'CliError',
      error: safeError(failure)
    });
    throw failure;
  }
  try {
    const result = parseCliJson(stdout);
    if (result.success === false) throw new Error(result.error?.message || 'Binance CLI request failed.');
    emitLog('dependency.operation', {
      operation,
      outcome: 'ok',
      durationMs: Math.round(performance.now() - startedAt)
    });
    return result.data || {};
  } catch (error) {
    emitLog('dependency.operation', {
      operation,
      outcome: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      errorType: error.name || 'CliResponseError',
      error: safeError(error)
    });
    throw error;
  }
}

function findAddress(value) {
  if (typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findAddress(item); if (found) return found; }
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/bsc|bnb|56/i.test(key)) { const found = findAddress(item); if (found) return found; }
    }
    for (const item of Object.values(value)) { const found = findAddress(item); if (found) return found; }
  }
  return '';
}

async function readConnectedAddress() {
  const status = await cli(['wallet', 'status', '--json']);
  if (!/CONNECTED/i.test(JSON.stringify(status))) return '';
  const addresses = await cli(['wallet', 'address', '--json']);
  return findAddress(addresses);
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function authStatus() {
  return {
    status: pairing?.status || 'idle',
    pairingCode: pairing?.status === 'pending' ? pairing.pairingCode : '',
    qrDataUrl: pairing?.status === 'pending' ? pairing.qrDataUrl : '',
    urlForWeb: pairing?.status === 'pending' ? pairing.urlForWeb : '',
    expiresAt: pairing?.expiresAt || 0,
    address: pairing?.status === 'connected' ? pairing.address : '',
    message: pairing?.message || ''
  };
}

async function beginPairing() {
  if (pairing?.status === 'pending' && pairing.expiresAt > Date.now()) return authStatus();
  const existingAddress = await readConnectedAddress().catch(() => '');
  if (existingAddress) {
    pairing = { status: 'connected', address: existingAddress, message: '' };
    return authStatus();
  }
  const data = await cli(['auth', 'signin', '--json'], 30_000);
  if (data.status === 'ALREADY_CONNECTED') {
    const address = await readConnectedAddress();
    if (!address) throw new Error('Wallet is signed in, but the BSC address could not be read.');
    pairing = { status: 'connected', address, message: '' };
    return authStatus();
  }
  if (!data.qrCodeId || !data.urlForWeb || !data.pairingCode) throw new Error('The Binance CLI did not return a complete pairing request.');
  const pairingUrl = new URL(data.urlForWeb);
  const allowedPairingHosts = new Set(['app.binance.com', 'web3.binance.com']);
  if (pairingUrl.protocol !== 'https:' || !allowedPairingHosts.has(pairingUrl.hostname)) throw new Error('The Binance CLI returned an unexpected pairing URL host.');
  const expiresAt = Number(data.expireAt) || Date.now() + 5 * 60_000;
  const qrStartedAt = performance.now();
  let qrDataUrl;
  try {
    qrDataUrl = await QRCode.toDataURL(data.urlForWeb, { width: 280, margin: 2, errorCorrectionLevel: 'M' });
    emitLog('dependency.operation', {
      operation: 'qr.generate',
      outcome: 'ok',
      durationMs: Math.round(performance.now() - qrStartedAt)
    });
  } catch (error) {
    emitLog('dependency.operation', {
      operation: 'qr.generate',
      outcome: 'error',
      durationMs: Math.round(performance.now() - qrStartedAt),
      errorType: error.name || 'QrError',
      error: safeError(error)
    });
    throw error;
  }
  pairing = { status: 'pending', pairingCode: String(data.pairingCode), urlForWeb: data.urlForWeb, qrCodeId: data.qrCodeId, expiresAt, qrDataUrl, message: '' };
  const verifyStartedAt = performance.now();
  verifyProcess = spawn('baw', ['auth', 'verify', '--qrCodeId', data.qrCodeId, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  verifyProcess.stdout.on('data', chunk => { stdout += chunk.toString(); });
  verifyProcess.stderr.on('data', () => {});
  verifyProcess.on('close', async code => {
    verifyProcess = null;
    if (pairing?.qrCodeId !== data.qrCodeId) return;
    try {
      const result = parseCliJson(stdout);
      if (code !== 0 || result.success === false || !/SUCCESS/i.test(JSON.stringify(result.data || {}))) {
        throw new Error(result.error?.message || 'Pairing was not verified. Please generate a new QR code.');
      }
      const address = await readConnectedAddress();
      if (!address) throw new Error('Pairing completed, but the BSC wallet address is unavailable.');
      emitLog('dependency.operation', { operation: 'wallet.verify', outcome: 'ok', durationMs: Math.round(performance.now() - verifyStartedAt) });
      pairing = { status: 'connected', address, message: '' };
    } catch (error) {
      emitLog('dependency.operation', {
        operation: 'wallet.verify', outcome: 'error', durationMs: Math.round(performance.now() - verifyStartedAt),
        errorType: error.name || 'PairingVerificationError', error: safeError(error)
      });
      pairing = { status: 'error', message: error.message || 'Pairing failed.' };
    }
  });
  return authStatus();
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const server = createServer(async (req, res) => {
  const requestId = randomUUID();
  return requestContext.run({ requestId }, async () => {
  const startedAt = performance.now();
  const pathname = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`).pathname;
  const route = routeName(pathname);
  res.setHeader('X-Request-Id', requestId);
  res.once('finish', () => emitLog('http.request', {
    requestId,
    method: req.method,
    route,
    statusCode: res.statusCode,
    durationMs: Math.round(performance.now() - startedAt),
    responseBytes: Number(res.getHeader('Content-Length')) || undefined
  }));
  const origin = req.headers.origin;
  const isLocalDevOrigin = typeof origin === 'string'
    && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin);
  if (origin && !origins.has(origin) && !isLocalDevOrigin) {
    emitLog('security.cors_rejected', { requestId, origin });
    return json(res, 403, { error: 'Origin not allowed.' });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (pathname === '/api/auth/signin' && req.method === 'POST') {
    try { return json(res, 200, await beginPairing()); }
    catch (error) {
      emitLog('application.error', { requestId, route, errorType: error.name || 'PairingError', error: safeError(error) });
      return json(res, 503, { status: 'error', message: error.message || 'Could not start Binance pairing.' });
    }
  }
  if (pathname === '/api/auth/status' && req.method === 'GET') return json(res, 200, authStatus());
  if (pathname === '/api/auth/cancel' && req.method === 'POST') {
    if (verifyProcess) verifyProcess.kill('SIGTERM');
    verifyProcess = null;
    pairing = null;
    return json(res, 200, authStatus());
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
  let filePath;
  try {
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    filePath = resolve(root, `.${relative}`);
    if (!filePath.startsWith(root) || relative.split('/').some(part => part.startsWith('.'))) return json(res, 404, { error: 'Not found.' });
    const readStartedAt = performance.now();
    const contents = await readFile(filePath);
    emitLog('dependency.operation', {
      operation: 'filesystem.read',
      outcome: 'ok',
      durationMs: Math.round(performance.now() - readStartedAt),
      assetType: extname(filePath).toLowerCase() || 'html',
      responseBytes: contents.byteLength
    });
    res.writeHead(200, { 'Content-Type': mime[extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    return res.end(contents);
  } catch (error) {
    if (error?.code !== 'ENOENT') emitLog('application.error', { requestId, route, errorType: error.name || 'AssetReadError', error: safeError(error) });
    return json(res, 404, { error: 'Not found.' });
  }
  }).catch(error => {
    emitLog('application.error', {
      requestId,
      route: routeName(new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`).pathname),
      errorType: error.name || 'RequestError',
      error: safeError(error)
    });
    if (!res.headersSent) json(res, 500, { error: 'Internal server error.', requestId });
    else res.destroy();
  });
});

server.listen(port, '127.0.0.1', () => {
  emitLog('service.started', { port, bindAddress: '127.0.0.1' });
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (verifyProcess) verifyProcess.kill('SIGTERM');
  server.close(() => process.exit(0));
});
