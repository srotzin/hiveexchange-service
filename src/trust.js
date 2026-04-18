// trust.js — HiveGate trust score fetch + 5-minute cache
import fetch from 'node-fetch';

const HIVEGATE_URL = process.env.HIVEGATE_URL || 'https://hivegate.onrender.com';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TRUST = 50;
const MIN_TRUST = 20;

const cache = new Map(); // did → { score, fetchedAt }

/**
 * Get trust score for a DID.
 * Returns cached value if < 5 minutes old.
 * Returns DEFAULT_TRUST (50) if HiveGate is unreachable.
 */
export async function getTrustScore(did) {
  if (!did) return DEFAULT_TRUST;

  const cached = cache.get(did);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.score;
  }

  try {
    const url = `${HIVEGATE_URL}/v1/gate/trust/${encodeURIComponent(did)}`;
    const res = await fetch(url, {
      timeout: 5000,
      headers: { 'x-hive-internal-key': process.env.HIVE_INTERNAL_KEY || '' },
    });

    if (res.ok) {
      const body = await res.json();
      // Support both { trust_score: N } and { data: { trust_score: N } }
      const score =
        body?.trust_score ??
        body?.data?.trust_score ??
        body?.score ??
        DEFAULT_TRUST;

      const numScore = parseFloat(score);
      const finalScore = isNaN(numScore) ? DEFAULT_TRUST : Math.max(0, Math.min(100, numScore));

      cache.set(did, { score: finalScore, fetchedAt: Date.now() });
      return finalScore;
    } else {
      console.warn(`[trust] HiveGate returned ${res.status} for ${did} — defaulting to ${DEFAULT_TRUST}`);
    }
  } catch (err) {
    console.warn(`[trust] HiveGate unreachable for ${did}: ${err.message} — defaulting to ${DEFAULT_TRUST}`);
  }

  // Cache the default to avoid hammering HiveGate
  cache.set(did, { score: DEFAULT_TRUST, fetchedAt: Date.now() });
  return DEFAULT_TRUST;
}

/**
 * Check if a DID is allowed to trade (trust score >= MIN_TRUST).
 * Returns { allowed: bool, score: number }
 */
export async function checkTrustAllowed(did) {
  const score = await getTrustScore(did);
  return { allowed: score >= MIN_TRUST, score };
}

/**
 * Invalidate cache for a specific DID.
 */
export function invalidateTrustCache(did) {
  cache.delete(did);
}

/**
 * Clear entire trust cache (admin/testing).
 */
export function clearTrustCache() {
  cache.clear();
}

export { DEFAULT_TRUST, MIN_TRUST };
