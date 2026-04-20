// oracle.js — Price oracle: CoinGecko (crypto) + Pyth Hermes (equities, FX, metals)
// Pyth gives us 1,748 equity feeds + 290 FX + 11 metals — all live, no key required
// 30-second cache. Pyth batch-fetches up to 1000 feed IDs per call.

import fetch from 'node-fetch';

const CACHE_TTL_MS   = 30_000;  // 30 seconds
const PYTH_HERMES    = 'https://hermes.pyth.network/v2/updates/price/latest';
const PYTH_FEED_URL  = 'https://hermes.pyth.network/v2/price_feeds';

const LEGAL_NOTICE = 'Equity, FX, and metals prices are sourced live from Pyth Network oracle for agent-to-agent synthetic positions. No real assets are bought, sold, or custodied. Agents trade price exposure only, settled in USDC. This is not investment advice and does not constitute securities trading.';

// ─── Crypto IDs (CoinGecko) ──────────────────────────────────────────────────
const CRYPTO_IDS = {
  BTC:          'bitcoin',
  ETH:          'ethereum',
  SOL:          'solana',
  ALEO:         'aleo',
  BNB:          'binancecoin',
  AVAX:         'avalanche-2',
  MATIC:        'matic-network',
  ARB:          'arbitrum',
  OP:           'optimism',
  USAD:         'usd-coin',
};

// Hive-native pegged tokens
const HIVE_NATIVE = {
  'HIVE-CREDIT': 1.00,
  USDC:          1.00,
};

// ─── Pyth feed registry — loaded once on startup ──────────────────────────────
let pythEquityFeeds = [];   // { symbol, feed_id, category, pyth_asset_type }
let pythFxFeeds     = [];
let pythMetalFeeds  = [];
let pythFeedsLoaded = false;

async function loadPythFeeds() {
  if (pythFeedsLoaded) return;
  try {
    console.log('[oracle] Loading Pyth feed registry...');

    const [equityRes, fxRes, metalRes] = await Promise.all([
      fetch(`${PYTH_FEED_URL}?asset_type=equity`, { timeout: 20_000 }),
      fetch(`${PYTH_FEED_URL}?asset_type=fx`,     { timeout: 20_000 }),
      fetch(`${PYTH_FEED_URL}?asset_type=metal`,  { timeout: 20_000 }),
    ]);

    const [equityData, fxData, metalData] = await Promise.all([
      equityRes.json(),
      fxRes.json(),
      metalRes.json(),
    ]);

    pythEquityFeeds = equityData.map(f => ({
      symbol:         f.attributes?.base || f.id.slice(0, 8),
      display_symbol: `${f.attributes?.base}/${f.attributes?.quote_currency}`,
      feed_id:        '0x' + f.id,
      category:       'equity',
      country:        f.attributes?.country || 'US',
      asset_class:    'synthetic_equity',
      pyth_name:      f.attributes?.generic_symbol || f.attributes?.base,
    }));

    pythFxFeeds = fxData.map(f => ({
      symbol:         `${f.attributes?.base}/${f.attributes?.quote_currency}`,
      display_symbol: `${f.attributes?.base}/${f.attributes?.quote_currency}`,
      feed_id:        '0x' + f.id,
      category:       'fx',
      asset_class:    'fx',
    }));

    pythMetalFeeds = metalData.map(f => ({
      symbol:         f.attributes?.base || f.id.slice(0, 6),
      display_symbol: `${f.attributes?.base}/${f.attributes?.quote_currency}`,
      feed_id:        '0x' + f.id,
      category:       'metal',
      asset_class:    'commodity',
    }));

    pythFeedsLoaded = true;
    console.log(`[oracle] Pyth feeds loaded: ${pythEquityFeeds.length} equity, ${pythFxFeeds.length} FX, ${pythMetalFeeds.length} metals`);
  } catch (err) {
    console.warn('[oracle] Pyth feed registry load failed:', err.message);
  }
}

// ─── Pyth price cache ─────────────────────────────────────────────────────────
const pythPriceCache = new Map();   // feed_id → { price_usd, conf, ts }
let   pythLastBatch  = 0;
const PYTH_BATCH_TTL = 30_000;

// Batch fetch a list of feed IDs from Pyth Hermes (max 1000 per call)
async function pythBatchFetch(feedIds) {
  if (!feedIds.length) return;
  const chunks = [];
  for (let i = 0; i < feedIds.length; i += 1000) {
    chunks.push(feedIds.slice(i, i + 1000));
  }
  for (const chunk of chunks) {
    try {
      const params = new URLSearchParams();
      chunk.forEach(id => params.append('ids[]', id));
      const res = await fetch(`${PYTH_HERMES}?${params.toString()}`, { timeout: 15_000 });
      if (!res.ok) {
        console.warn(`[oracle] Pyth batch ${res.status}`);
        continue;
      }
      const data = await res.json();
      const parsed = data?.parsed || [];
      for (const p of parsed) {
        const feedId = '0x' + p.id;
        const price  = parseInt(p.price?.price, 10);
        const expo   = p.price?.expo ?? 0;
        const priceUsd = price * Math.pow(10, expo);
        const conf   = parseInt(p.price?.conf || '0', 10) * Math.pow(10, expo);
        pythPriceCache.set(feedId, {
          price_usd:  priceUsd,
          conf,
          ts:         p.price?.publish_time,
          fetchedAt:  Date.now(),
        });
      }
    } catch (e) {
      console.warn('[oracle] Pyth batch chunk failed:', e.message);
    }
  }
  pythLastBatch = Date.now();
}

// ─── Main price cache ─────────────────────────────────────────────────────────
const priceCache = new Map();   // symbol → { symbol, price_usd, source, ... }

async function refreshCryptoPrices() {
  try {
    const ids = Object.values(CRYPTO_IDS).join(',');
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { timeout: 8_000 }
    );
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();
    for (const [symbol, id] of Object.entries(CRYPTO_IDS)) {
      const price = data[id]?.usd ?? null;
      if (price != null) {
        priceCache.set(symbol, {
          symbol,
          price_usd:  price,
          source:     'coingecko_live',
          fetchedAt:  Date.now(),
          asset_type: 'crypto',
        });
      }
    }
  } catch (e) {
    console.warn('[oracle] CoinGecko failed:', e.message);
  }
}

async function refreshPythPrices() {
  await loadPythFeeds();
  if (Date.now() - pythLastBatch < PYTH_BATCH_TTL) return;

  const allFeeds = [
    ...pythEquityFeeds,
    ...pythFxFeeds,
    ...pythMetalFeeds,
  ].map(f => f.feed_id);

  await pythBatchFetch(allFeeds);

  // Populate main cache from Pyth results
  for (const feed of [...pythEquityFeeds, ...pythFxFeeds, ...pythMetalFeeds]) {
    const p = pythPriceCache.get(feed.feed_id);
    if (p && p.price_usd > 0) {
      priceCache.set(feed.display_symbol, {
        symbol:      feed.display_symbol,
        price_usd:   p.price_usd,
        conf:        p.conf,
        feed_id:     feed.feed_id,
        source:      'pyth_live',
        fetchedAt:   p.fetchedAt,
        asset_type:  feed.asset_class,
        category:    feed.category,
        synthetic_only: true,
        legal_notice: LEGAL_NOTICE,
      });
      // Also index by base symbol for easy lookup
      priceCache.set(feed.symbol, {
        symbol:      feed.symbol,
        display:     feed.display_symbol,
        price_usd:   p.price_usd,
        feed_id:     feed.feed_id,
        source:      'pyth_live',
        fetchedAt:   p.fetchedAt,
        asset_type:  feed.asset_class,
        category:    feed.category,
        synthetic_only: true,
        legal_notice: LEGAL_NOTICE,
      });
    }
  }
}

async function refreshPrices() {
  await Promise.all([
    refreshCryptoPrices(),
    refreshPythPrices(),
  ]);

  // Hive-native pegs
  for (const [symbol, price] of Object.entries(HIVE_NATIVE)) {
    priceCache.set(symbol, {
      symbol,
      price_usd:  price,
      source:     'hive_peg',
      fetchedAt:  Date.now(),
      asset_type: 'hive_native',
    });
  }
}

// ─── Cache freshness guard ────────────────────────────────────────────────────
let refreshPromise = null;

async function ensureFresh() {
  const oldest = Array.from(priceCache.values()).reduce((min, v) => Math.min(min, v.fetchedAt || 0), Date.now());
  if (Date.now() - oldest > CACHE_TTL_MS || priceCache.size < 5) {
    if (!refreshPromise) {
      refreshPromise = refreshPrices().finally(() => { refreshPromise = null; });
    }
    await refreshPromise;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchPrice(symbol) {
  const sym = symbol.toUpperCase().replace('/USDC', '');
  await ensureFresh();
  return priceCache.get(sym) || priceCache.get(sym + '/USD') || null;
}

export async function fetchAllPrices() {
  await ensureFresh();
  return Object.fromEntries(priceCache.entries());
}

export async function getPriceMap() {
  await ensureFresh();
  const map = {};
  for (const [sym, data] of priceCache.entries()) {
    map[sym] = data.price_usd;
  }
  return map;
}

export async function forceRefresh() {
  await refreshPrices();
}

/** Returns the full Pyth feed registry (for market seeding) */
export function getPythFeeds() {
  return {
    equity: pythEquityFeeds,
    fx:     pythFxFeeds,
    metals: pythMetalFeeds,
    loaded: pythFeedsLoaded,
  };
}

/** Get live Pyth price for a single feed_id */
export async function getPythPrice(feedId) {
  await loadPythFeeds();
  const p = pythPriceCache.get(feedId);
  if (p && Date.now() - p.fetchedAt < PYTH_BATCH_TTL) return p;
  // Single fetch
  try {
    const params = new URLSearchParams();
    params.append('ids[]', feedId);
    const res = await fetch(`${PYTH_HERMES}?${params.toString()}`, { timeout: 10_000 });
    const data = await res.json();
    const parsed = data?.parsed?.[0];
    if (!parsed) return null;
    const price   = parseInt(parsed.price?.price, 10);
    const expo    = parsed.price?.expo ?? 0;
    const priceUsd = price * Math.pow(10, expo);
    const result = { price_usd: priceUsd, conf: 0, ts: parsed.price?.publish_time, fetchedAt: Date.now() };
    pythPriceCache.set(feedId, result);
    return result;
  } catch { return null; }
}

// Prime on load
loadPythFeeds().then(() => refreshPrices()).catch(e => console.warn('[oracle] Boot prime failed:', e.message));
