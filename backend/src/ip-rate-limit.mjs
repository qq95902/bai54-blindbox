/**
 * Bounded per-process fixed-window limiter. Map insertion order follows window
 * start time because expired keys are removed before being reinserted.
 */
export function consumeIpRateLimit(map, ip, now, { limit, windowMs = 60_000, maxKeys = 5_000 } = {}) {
  if (!(map instanceof Map) || typeof ip !== 'string' || !ip || !Number.isFinite(now) ||
      !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1 ||
      !Number.isSafeInteger(maxKeys) || maxKeys < 1) {
    throw new TypeError('IP_RATE_LIMIT_ARGUMENTS_INVALID');
  }

  const current = map.get(ip);
  if (current && now - current.startedAt < windowMs) {
    if (current.count >= limit) return false;
    current.count++;
    return true;
  }
  if (current) map.delete(ip);

  while (map.size >= maxKeys) {
    const oldest = map.entries().next().value;
    if (!oldest || now - oldest[1].startedAt < windowMs) return false;
    map.delete(oldest[0]);
  }

  map.set(ip, { startedAt: now, count: 1 });
  return true;
}
