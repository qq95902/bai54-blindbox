import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage();

export const instanceId = process.env.INSTANCE_ID || `${process.env.HOSTNAME || 'local'}-${process.pid}`;

export function log(level, event, fields = {}) {
  const requestId = requestContext.getStore()?.requestId;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    instanceId,
    ...(requestId ? { requestId } : {}),
    ...fields
  };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function errorCode(error) {
  const code = error?.code || error?.error?.code || error?.name || 'Error';
  return String(code).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) || 'Error';
}

export function requestId() { return randomUUID(); }

export function withRequestContext(id, callback) {
  return requestContext.run({ requestId: id }, callback);
}

export function currentRequestId() {
  return requestContext.getStore()?.requestId || null;
}

function durationSince(started) {
  return Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100;
}

export function instrumentRpc(provider, providerName) {
  if (provider.__baiRpcInstrumented) return provider;
  const originalSend = provider.send.bind(provider);
  provider.send = async (method, params) => {
    const started = process.hrtime.bigint();
    try {
      const result = await originalSend(method, params);
      log('info', 'rpc_request_complete', { rpcCallId: requestId(), provider: providerName, method, durationMs: durationSince(started) });
      return result;
    } catch (error) {
      log('error', 'rpc_request_failed', {
        rpcCallId: requestId(), provider: providerName, method, durationMs: durationSince(started), errorCode: errorCode(error)
      });
      throw error;
    }
  };
  Object.defineProperty(provider, '__baiRpcInstrumented', { value: true });
  return provider;
}
