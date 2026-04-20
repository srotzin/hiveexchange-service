// seeds/pyth-markets.js — Dynamic market seeder for all Pyth feeds
// Seeds 1,748 equity + 290 FX + 11 metals as HiveExchange prediction markets
// Called once at startup, idempotent via ON CONFLICT DO NOTHING

import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { store, isInMemory, query } from '../db.js';

const PYTH_FEED_URL = 'https://hermes.pyth.network/v2/price_feeds';
const FOUNDER_DID   = 'did:hive:f150bbec-5660-413e-b305-d8d965b47845';

const LEGAL_NOTICE = 'Agent-to-agent synthetic position. Not a real security. No real assets are bought, sold, or custodied. Agents trade price exposure only, settled in USDC. Not investment advice. Not securities trading.';

// Resolution windows: equity markets resolve based on Pyth price at expiry
function resolutionDateDays(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(21, 0, 0, 0); // 9PM UTC = 5PM EST close
  return d.toISOString();
}

// Build prediction market entry from a Pyth feed
function makeEquityPredictMarket(feed, currentPriceUsd) {
  const ticker = feed.display_symbol || `${feed.symbol}/USD`;
  const base   = feed.symbol;
  const country = feed.country || 'US';
  const flag   = country === 'DE' ? '🇩🇪 ' : country === 'FR' ? '🇫🇷 ' : country === 'CA' ? '🇨🇦 ' : country === 'CN' ? '🇨🇳 ' : '';

  const priceTxt = currentPriceUsd > 0
    ? `(currently $${currentPriceUsd.toFixed(2)} per Pyth oracle)`
    : '(Pyth oracle live price)';

  const targetUp   = currentPriceUsd > 0 ? (currentPriceUsd * 1.05).toFixed(2) : 'current + 5%';
  const targetDown = currentPriceUsd > 0 ? (currentPriceUsd * 0.95).toFixed(2) : 'current - 5%';

  const resDate7   = resolutionDateDays(7);
  const resDate30  = resolutionDateDays(30);

  return [
    {
      id:                  `pyth-eq-${base}-up-7d`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      question:            `${flag}Will ${ticker} close above $${targetUp} within 7 days? ${priceTxt}`,
      resolution_criteria: `YES if Pyth ${feed.feed_id} price >= ${targetUp} at any point before ${resDate7}. NO otherwise. Auto-resolved via Pyth oracle.`,
      category:            'synthetic_equity',
      resolution_date:     resDate7,
      initial_yes:         50,
      initial_no:          50,
      creator_did:         FOUNDER_DID,
      settlement_rail:     'usdc',
      metadata: {
        pyth_feed_id:   feed.feed_id,
        ticker,
        base,
        country,
        asset_class:    'synthetic_equity',
        direction:      'up',
        window_days:    7,
        house_fee_pct:  2,
        legal_notice:   LEGAL_NOTICE,
        oracle:         'pyth_network',
      },
    },
    {
      id:                  `pyth-eq-${base}-dn-30d`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      question:            `${flag}Will ${ticker} drop below $${targetDown} within 30 days? ${priceTxt}`,
      resolution_criteria: `YES if Pyth ${feed.feed_id} price <= ${targetDown} at any point before ${resDate30}. NO otherwise. Auto-resolved via Pyth oracle.`,
      category:            'synthetic_equity',
      resolution_date:     resDate30,
      initial_yes:         50,
      initial_no:          50,
      creator_did:         FOUNDER_DID,
      settlement_rail:     'usdc',
      metadata: {
        pyth_feed_id:   feed.feed_id,
        ticker,
        base,
        country,
        asset_class:    'synthetic_equity',
        direction:      'down',
        window_days:    30,
        house_fee_pct:  2,
        legal_notice:   LEGAL_NOTICE,
        oracle:         'pyth_network',
      },
    },
  ];
}

function makeFxPredictMarket(feed) {
  const pair = feed.display_symbol;
  const res7 = resolutionDateDays(7);
  return {
    id:                  `pyth-fx-${pair.replace('/', '-')}-7d`.toLowerCase(),
    question:            `Will ${pair} move more than 1% in either direction over the next 7 days? (Pyth live oracle)`,
    resolution_criteria: `YES if Pyth FX ${pair} price changes ≥1% from current level before ${res7}. NO otherwise.`,
    category:            'fx',
    resolution_date:     res7,
    initial_yes:         50,
    initial_no:          50,
    creator_did:         FOUNDER_DID,
    settlement_rail:     'usdc',
    metadata: {
      pyth_feed_id:   feed.feed_id,
      pair,
      asset_class:    'fx',
      house_fee_pct:  2,
      legal_notice:   LEGAL_NOTICE,
      oracle:         'pyth_network',
    },
  };
}

function makeMetalPredictMarket(feed) {
  const ticker = feed.display_symbol;
  const res30  = resolutionDateDays(30);
  return {
    id:                  `pyth-metal-${feed.symbol.toLowerCase()}-30d`,
    question:            `Will ${ticker} move more than 5% in either direction over the next 30 days? (Pyth live oracle)`,
    resolution_criteria: `YES if Pyth ${ticker} price changes ≥5% from current before ${res30}. NO otherwise.`,
    category:            'commodity',
    resolution_date:     res30,
    initial_yes:         50,
    initial_no:          50,
    creator_did:         FOUNDER_DID,
    settlement_rail:     'usdc',
    metadata: {
      pyth_feed_id:   feed.feed_id,
      ticker,
      asset_class:    'commodity',
      house_fee_pct:  2,
      legal_notice:   LEGAL_NOTICE,
      oracle:         'pyth_network',
    },
  };
}

// Seed spot markets for all Pyth equity feeds (synthetic, agent-to-agent)
function makeEquitySpotMarket(feed) {
  const ticker = feed.display_symbol || `${feed.symbol}/USD`;
  const base   = feed.symbol;
  return {
    id:          `spot-eq-${base}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    symbol:      `${base}/USDC`,
    base_asset:  base,
    quote_asset: 'USDC',
    market_type: 'spot',
    maker_fee_pct: 0.15,
    taker_fee_pct: 0.25,
    metadata: {
      asset_class:     'synthetic_equity',
      pyth_feed_id:    feed.feed_id,
      pyth_ticker:     ticker,
      country:         feed.country || 'US',
      price_source:    'pyth_live',
      synthetic_only:  true,
      legal_notice:    LEGAL_NOTICE,
    },
  };
}

// ─── Main seeder ─────────────────────────────────────────────────────────────

export async function seedPythMarkets() {
  console.log('[seed:pyth] Fetching Pyth feed registry...');

  let equityFeeds = [], fxFeeds = [], metalFeeds = [];
  try {
    const [eRes, fRes, mRes] = await Promise.all([
      fetch(`${PYTH_FEED_URL}?asset_type=equity`, { timeout: 20_000 }),
      fetch(`${PYTH_FEED_URL}?asset_type=fx`,     { timeout: 20_000 }),
      fetch(`${PYTH_FEED_URL}?asset_type=metal`,  { timeout: 20_000 }),
    ]);
    const [eData, fData, mData] = await Promise.all([eRes.json(), fRes.json(), mRes.json()]);

    equityFeeds = eData.map(f => ({
      symbol:         f.attributes?.base || f.id.slice(0, 8),
      display_symbol: `${f.attributes?.base}/${f.attributes?.quote_currency}`,
      feed_id:        '0x' + f.id,
      country:        f.attributes?.country || 'US',
    }));
    fxFeeds = fData.map(f => ({
      symbol:         `${f.attributes?.base}/${f.attributes?.quote_currency}`,
      display_symbol: `${f.attributes?.base}/${f.attributes?.quote_currency}`,
      feed_id:        '0x' + f.id,
    }));
    metalFeeds = mData.map(f => ({
      symbol:         f.attributes?.base || f.id.slice(0, 6),
      display_symbol: `${f.attributes?.base}/${f.attributes?.quote_currency}`,
      feed_id:        '0x' + f.id,
    }));

    console.log(`[seed:pyth] Feeds: ${equityFeeds.length} equity, ${fxFeeds.length} FX, ${metalFeeds.length} metals`);
  } catch (err) {
    console.warn('[seed:pyth] Failed to load Pyth feeds:', err.message);
    return;
  }

  // ── Seed spot markets for all equities ──────────────────────────────────────
  let spotSeeded = 0, spotSkipped = 0;
  for (const feed of equityFeeds) {
    const mkt = makeEquitySpotMarket(feed);
    if (isInMemory()) {
      if (store.markets.has(mkt.id)) { spotSkipped++; continue; }
      store.markets.set(mkt.id, {
        ...mkt,
        status:         'active',
        created_by_did: FOUNDER_DID,
        created_at:     new Date().toISOString(),
      });
      spotSeeded++;
    } else {
      try {
        const r = await query(
          `INSERT INTO markets (id, symbol, base_asset, quote_asset, market_type, status,
            maker_fee_pct, taker_fee_pct, created_by_did, metadata, created_at)
           VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,NOW())
           ON CONFLICT (id) DO NOTHING`,
          [mkt.id, mkt.symbol, mkt.base_asset, mkt.quote_asset, mkt.market_type,
           mkt.maker_fee_pct, mkt.taker_fee_pct, FOUNDER_DID, JSON.stringify(mkt.metadata)]
        );
        if (r.rowCount > 0) spotSeeded++; else spotSkipped++;
      } catch (e) {
        console.warn(`[seed:pyth] spot ${mkt.symbol}: ${e.message}`);
      }
    }
  }
  console.log(`[seed:pyth] Spot markets: ${spotSeeded} seeded, ${spotSkipped} already existed`);

  // ── Seed prediction markets ─────────────────────────────────────────────────
  let predSeeded = 0, predSkipped = 0;

  // Equity: 2 prediction markets per feed (up-7d, down-30d) → up to 3,496
  for (const feed of equityFeeds) {
    const markets = makeEquityPredictMarket(feed, 0);
    for (const m of markets) {
      if (isInMemory()) {
        if (store.predictMarkets.has(m.id)) { predSkipped++; continue; }
        store.predictMarkets.set(m.id, {
          ...m,
          status:       'open',
          outcome:      null,
          total_volume_usdc: 0,
          created_at:   new Date().toISOString(),
          resolved_at:  null,
        });
        predSeeded++;
      } else {
        try {
          const r = await query(
            `INSERT INTO predict_markets
             (id, question, resolution_criteria, category, resolution_date,
              status, outcome, yes_pool_usdc, no_pool_usdc, total_volume_usdc,
              creator_did, settlement_rail, created_at, resolved_at)
             VALUES ($1,$2,$3,$4,$5,'open',NULL,$6,$7,0,$8,$9,NOW(),NULL)
             ON CONFLICT (id) DO NOTHING`,
            [m.id, m.question, m.resolution_criteria, m.category,
             m.resolution_date, m.initial_yes, m.initial_no,
             m.creator_did, m.settlement_rail]
          );
          if (r.rowCount > 0) predSeeded++; else predSkipped++;
        } catch (e) {
          console.warn(`[seed:pyth] predict ${m.id}: ${e.message}`);
        }
      }
    }
  }

  // FX prediction markets
  for (const feed of fxFeeds) {
    const m = makeFxPredictMarket(feed);
    if (isInMemory()) {
      if (store.predictMarkets.has(m.id)) { predSkipped++; continue; }
      store.predictMarkets.set(m.id, { ...m, status: 'open', outcome: null, total_volume_usdc: 0, created_at: new Date().toISOString(), resolved_at: null });
      predSeeded++;
    } else {
      try {
        const r = await query(
          `INSERT INTO predict_markets (id, question, resolution_criteria, category, resolution_date, status, outcome, yes_pool_usdc, no_pool_usdc, total_volume_usdc, creator_did, settlement_rail, created_at, resolved_at) VALUES ($1,$2,$3,$4,$5,'open',NULL,$6,$7,0,$8,$9,NOW(),NULL) ON CONFLICT (id) DO NOTHING`,
          [m.id, m.question, m.resolution_criteria, m.category, m.resolution_date, m.initial_yes, m.initial_no, m.creator_did, m.settlement_rail]
        );
        if (r.rowCount > 0) predSeeded++; else predSkipped++;
      } catch (e) { console.warn(`[seed:pyth] fx ${m.id}: ${e.message}`); }
    }
  }

  // Metals prediction markets
  for (const feed of metalFeeds) {
    const m = makeMetalPredictMarket(feed);
    if (isInMemory()) {
      if (store.predictMarkets.has(m.id)) { predSkipped++; continue; }
      store.predictMarkets.set(m.id, { ...m, status: 'open', outcome: null, total_volume_usdc: 0, created_at: new Date().toISOString(), resolved_at: null });
      predSeeded++;
    } else {
      try {
        const r = await query(
          `INSERT INTO predict_markets (id, question, resolution_criteria, category, resolution_date, status, outcome, yes_pool_usdc, no_pool_usdc, total_volume_usdc, creator_did, settlement_rail, created_at, resolved_at) VALUES ($1,$2,$3,$4,$5,'open',NULL,$6,$7,0,$8,$9,NOW(),NULL) ON CONFLICT (id) DO NOTHING`,
          [m.id, m.question, m.resolution_criteria, m.category, m.resolution_date, m.initial_yes, m.initial_no, m.creator_did, m.settlement_rail]
        );
        if (r.rowCount > 0) predSeeded++; else predSkipped++;
      } catch (e) { console.warn(`[seed:pyth] metal ${m.id}: ${e.message}`); }
    }
  }

  console.log(`[seed:pyth] Prediction markets: ${predSeeded} seeded, ${predSkipped} already existed`);
  console.log(`[seed:pyth] TOTAL markets on HiveExchange: ${
    isInMemory()
      ? store.markets.size + ' spot + ' + store.predictMarkets.size + ' prediction'
      : 'see DB'
  }`);
}
