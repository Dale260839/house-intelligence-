/**
 * Material Takeoff — dependency-free rate limiter
 * -----------------------------------------------
 * Fixed-window, in-memory, per-client request limiter. Zero runtime dependencies
 * (matches the module's stack — no `express-rate-limit`, no Redis client). Keyed by
 * client IP.
 *
 * SCOPE / LIMITS (be honest about them):
 *   - Per-PROCESS, in-memory. On a single Railway instance this is fine; if the
 *     service is scaled to multiple instances each keeps its own counters (effective
 *     limit = max × instances). Move the store to Redis/Supabase when that matters.
 *   - Fixed window (not sliding), so a burst can straddle a window boundary. Good
 *     enough to stop abuse / runaway clients, which is the goal here.
 *
 * Config comes from the environment via selectRateLimiter():
 *   RATE_LIMIT_MAX        max requests per window per client   (default 120)
 *   RATE_LIMIT_WINDOW_MS  window length in ms                  (default 60000 = 1 min)
 *   RATE_LIMIT_DISABLED   set truthy to disable entirely (no-op limiter)
 */

// Derive the client key. Behind a proxy (Railway/Cloudflare) the real client IP is the
// FIRST hop in X-Forwarded-For; fall back to the socket address for direct connections.
function clientKey(req) {
  const xff = req && req.headers && req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Create a fixed-window limiter.
 *   check(key[, now]) -> { allowed, limit, remaining, resetAt, retryAfterMs }
 * `now` is injectable so the window/reset behaviour is deterministically testable.
 */
function createRateLimiter({ windowMs = 60000, max = 120 } = {}) {
  let cfg = { windowMs: Number(windowMs) || 60000, max: Number(max) || 120 };
  const hits = new Map(); // key -> { count, resetAt }

  function check(key, now = Date.now()) {
    let e = hits.get(key);
    if (!e || now >= e.resetAt) {
      e = { count: 0, resetAt: now + cfg.windowMs };
      hits.set(key, e);
    }
    e.count += 1;
    const allowed = e.count <= cfg.max;
    return {
      allowed,
      limit: cfg.max,
      remaining: Math.max(0, cfg.max - e.count),
      resetAt: e.resetAt,
      retryAfterMs: allowed ? 0 : Math.max(0, e.resetAt - now),
    };
  }

  // Drop expired buckets so the Map can't grow unbounded. Call periodically.
  function sweep(now = Date.now()) {
    for (const [k, e] of hits) if (now >= e.resetAt) hits.delete(k);
    return hits.size;
  }

  return {
    id: 'fixed-window',
    check,
    sweep,
    configure(next = {}) {
      if ('windowMs' in next) cfg.windowMs = Number(next.windowMs) || cfg.windowMs;
      if ('max' in next) cfg.max = Number(next.max);
    },
    reset() { hits.clear(); },
    get config() { return { ...cfg }; },
    get size() { return hits.size; },
  };
}

// No-op limiter used when rate limiting is disabled: always allows, tracks nothing.
function createNoopLimiter() {
  return {
    id: 'noop',
    check() { return { allowed: true, limit: 0, remaining: 0, resetAt: 0, retryAfterMs: 0 }; },
    sweep() { return 0; },
    configure() {},
    reset() {},
    get config() { return { windowMs: 0, max: 0, disabled: true }; },
    get size() { return 0; },
  };
}

/**
 * Auto-select from the environment (mirrors selectPricingProvider/selectStore):
 *   RATE_LIMIT_DISABLED truthy → no-op limiter
 *   otherwise                  → fixed-window limiter from RATE_LIMIT_MAX/WINDOW_MS
 * Returns { limiter, enabled, label }.
 */
function selectRateLimiter(env = process.env) {
  const disabled = String(env.RATE_LIMIT_DISABLED || '').trim().toLowerCase();
  if (disabled && !['0', 'false', 'no', 'off'].includes(disabled)) {
    return { limiter: createNoopLimiter(), enabled: false, label: 'disabled (RATE_LIMIT_DISABLED)' };
  }
  const windowMs = Number(env.RATE_LIMIT_WINDOW_MS) || 60000;
  const max = Number(env.RATE_LIMIT_MAX) || 120;
  return {
    limiter: createRateLimiter({ windowMs, max }),
    enabled: true,
    label: `${max} req / ${Math.round(windowMs / 1000)}s per client`,
  };
}

module.exports = { clientKey, createRateLimiter, createNoopLimiter, selectRateLimiter };
