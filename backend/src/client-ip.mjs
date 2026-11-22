import { isIP } from 'node:net';

const normalize = (value) => {
  const ip = String(value || '').trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  return isIP(ip) ? ip.toLowerCase() : null;
};

/** Resolve a client IP only when the direct peer is an explicitly trusted proxy. */
export function resolveClientIp(remoteAddress, forwardedFor, trustedProxyIps = []) {
  const remote = normalize(remoteAddress);
  if (!remote) return 'unknown';
  const trusted = new Set(trustedProxyIps.map(normalize).filter(Boolean));
  if (!trusted.has(remote)) return remote;

  const forwarded = String(forwardedFor || '').split(',').map(normalize);
  if (forwarded.length === 0 || forwarded.some((ip) => !ip)) return remote;

  const chain = [...forwarded, remote];
  let index = chain.length - 1;
  while (index > 0 && trusted.has(chain[index])) index--;
  return chain[index];
}
