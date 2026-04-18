// rate-limit.js — Simple in-memory rate limiter (no Redis dep)
// Sliding window per IP and per DID

const windows = new Map(); // key → { count, windowStart }

const DEFAULT_MAX = 120;    // requests per window
const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minute

// More restrictive for order placement
const ORDER_MAX = 30;
const ORDER_WINDOW_MS = 60 * 1000;

function checkLimit(key, max, windowMs) {
  const now = Date.now();
  const entry = windows.get(key);

  if (!entry || now - entry.windowStart >= windowMs) {
    windows.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
  }

  entry.count++;
  const remaining = Math.max(0, max - entry.count);
  const resetAt = entry.windowStart + windowMs;

  if (entry.count > max) {
    return { allowed: false, remaining: 0, resetAt };
  }

  return { allowed: true, remaining, resetAt };
}

// Periodic cleanup to prevent memory leak (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows.entries()) {
    if (now - entry.windowStart > DEFAULT_WINDOW_MS * 2) {
      windows.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Standard rate limiter middleware.
 */
export function rateLimit(max = DEFAULT_MAX, windowMs = DEFAULT_WINDOW_MS) {
  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const did = req.headers['x-hive-did'] || null;

    // Key by DID if present, else IP
    const key = did ? `did:${did}` : `ip:${ip}`;
    const result = checkLimit(key, max, windowMs);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.floor(result.resetAt / 1000));

    if (!result.allowed) {
      return res.status(429).json({
        status: 'error',
        error: 'RATE_LIMITED',
        detail: `Too many requests. Limit: ${max} per ${windowMs / 1000}s.`,
        retry_after_seconds: Math.ceil((result.resetAt - Date.now()) / 1000),
      });
    }

    next();
  };
}

/**
 * Strict rate limiter for order placement.
 */
export function orderRateLimit() {
  return rateLimit(ORDER_MAX, ORDER_WINDOW_MS);
}
