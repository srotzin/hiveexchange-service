// oracle.js — Price oracle: CoinGecko live (crypto) + equity stubs
// 30-second cache for all prices

import fetch from 'node-fetch';

const CACHE_TTL_MS = 30 * 1000; // 30 seconds

// ─── Coingecko ID map ─────────────────────────────────────────────────────────
const CRYPTO_IDS = {
  'BTC':  'bitcoin',
  'ETH':  'ethereum',
  'SOL':  'solana',
  'ALEO': 'aleo',
  'BNB':  'binancecoin',
  'AVAX': 'avalanche-2',
  'MATIC':'matic-network',
  'ARB':  'arbitrum',
  'OP':   'optimism',
  'USAD': 'usd-coin',      // USAD is a USDC-backed stablecoin — peg to 1.00
};

// ─── Equity reference prices (synthetic only) ─────────────────────────────────
const EQUITY_STUBS = {
  'AAPL': 198.50,
  'MSFT': 415.00,
  'NVDA': 875.00,
  'GOOGL':175.00,
  'AMZN': 195.00,
  'META': 520.00,
  'TSLA': 250.00,
  'SPY':  540.00,
  'QQQ':  465.00,
  'GLD':  235.00,
  'OIL':  82.00,
};

// Hive-native tokens
const HIVE_NATIVE = {
  'HIVE-CREDIT': 1.00,   // 1:1 with USDC
  'USDC':        1.00,
};

const LEGAL_NOTICE = "Equity prices are reference-only for agent-to-agent synthetic positions. No real shares are bought, sold, or custodied. Not investment advice. Not securities trading.";

// ─── Cache ────────────────────────────────────────────────────────────────────
const priceCache = new Map(); // symbol → { price, fetchedAt, source }

// ─── Fetch live crypto prices from CoinGecko ──────────────────────────────────
async function fetchCoinGeckoPrices() {
  const ids = Object.values(CRYPTO_IDS).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;

  try {
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();

    // Invert the ID map to symbol → price
    const results = {};
    for (const [symbol, id] of Object.entries(CRYPTO_IDS)) {
      const price = data[id]?.usd ?? null;
      if (price !== null) results[symbol] = price;
    }
    return results;
  } catch (err) {
    console.warn(`[oracle] CoinGecko unavailable: ${err.message} — using last cached or stub prices`);
    return null;
  }
}

// ─── Refresh all prices into cache ────────────────────────────────────────────
async function refreshPrices() {
  const now = Date.now();

  // Fetch live crypto
  const liveCrypto = await fetchCoinGeckoPrices();

  for (const [symbol, id] of Object.entries(CRYPTO_IDS)) {
    const livePrice = liveCrypto?.[symbol];
    const existing = priceCache.get(symbol);

    if (livePrice != null) {
      priceCache.set(symbol, {
        symbol,
        price_usd: livePrice,
        source: 'coingecko_live',
        fetchedAt: now,
        asset_type: 'crypto',
      });
    } else if (!existing) {
      // Hard fallback stubs if never been fetched
      const stubs = { BTC: 65000, ETH: 3200, SOL: 150, ALEO: 2.50, BNB: 580,
                      AVAX: 35, MATIC: 0.75, ARB: 1.10, OP: 2.20, USAD: 1.00 };
      priceCache.set(symbol, {
        symbol,
        price_usd: stubs[symbol] ?? 1.00,
        source: 'stub_fallback',
        fetchedAt: now,
        asset_type: 'crypto',
        stale: true,
      });
    }
  }

  // Equity stubs — always fresh (no live feed in phase 1)
  for (const [symbol, price] of Object.entries(EQUITY_STUBS)) {
    priceCache.set(symbol, {
      symbol,
      price_usd: price,
      source: 'reference_stub',
      fetchedAt: now,
      asset_type: 'synthetic_equity',
      synthetic_only: true,
      legal_notice: LEGAL_NOTICE,
    });
  }

  // Hive-native
  for (const [symbol, price] of Object.entries(HIVE_NATIVE)) {
    priceCache.set(symbol, {
      symbol,
      price_usd: price,
      source: 'hive_peg',
      fetchedAt: now,
      asset_type: 'hive_native',
    });
  }
}

// ─── Ensure cache is fresh ────────────────────────────────────────────────────
let refreshPromise = null;

async function ensureFresh() {
  const oldest = Math.min(...Array.from(priceCache.values()).map(v => v.fetchedAt || 0), 0);
  if (Date.now() - oldest > CACHE_TTL_MS || priceCache.size === 0) {
    // Deduplicate concurrent refresh calls
    if (!refreshPromise) {
      refreshPromise = refreshPrices().finally(() => { refreshPromise = null; });
    }
    await refreshPromise;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch price for a single symbol (e.g. "BTC", "AAPL", "ETH").
 * Returns null if symbol not found.
 */
export async function fetchPrice(symbol) {
  const sym = symbol.toUpperCase().replace('/USDC', '').replace('/USD', '');
  await ensureFresh();
  return priceCache.get(sym) || null;
}

/**
 * Fetch all prices (crypto live + equity stubs + hive-native).
 */
export async function fetchAllPrices() {
  await ensureFresh();
  return Object.fromEntries(priceCache.entries());
}

/**
 * Get price map snapshot — all symbols → price_usd (no metadata).
 */
export async function getPriceMap() {
  await ensureFresh();
  const map = {};
  for (const [sym, data] of priceCache.entries()) {
    map[sym] = data.price_usd;
  }
  return map;
}

/**
 * Force-refresh the cache.
 */
export async function forceRefresh() {
  await refreshPrices();
}

// Prime cache on module load
refreshPrices().catch(err => console.warn('[oracle] Initial price fetch failed:', err.message));
