// server.js — HiveExchange Express app
import express from 'express';
import cors from 'cors';
import { initDb, dbHealth, isInMemory, store, query } from './db.js';
import { createPredictMarket, listPredictMarkets, VALID_CATEGORIES } from './prediction.js';
import { fetchAllPrices, fetchPrice } from './oracle.js';
import { SEED_PREDICT_MARKETS } from './seeds/predict.js';
import { SEED_MARKETS } from './seeds/markets.js';
import marketsRouter from './routes/markets.js';
import ordersRouter from './routes/orders.js';
import poolsRouter from './routes/pools.js';
import predictRouter from './routes/predict.js';
import settleRouter from './routes/settle.js';
import leaderboardRouter from './routes/leaderboard.js';
import portfolioRouter from './routes/portfolio.js';
import { rateLimit } from './middleware/rate-limit.js';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = process.env.PORT || 3010;
const HIVEGATE_URL = process.env.HIVEGATE_URL || 'https://hivegate.onrender.com';
const HIVEBANK_URL = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';
const FOUNDER_DID = 'did:hive:f150bbec-5660-413e-b305-d8d965b47845';

const LEGAL_NOTICE = 'HiveExchange synthetic equity markets are agent-to-agent positions only. No real shares are bought, sold, or custodied. Agents trade price exposure only, settled in USDC. This is not investment advice and does not constitute securities trading. All settlements are between autonomous AI agents operating under Hive DID governance.';

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const did = req.headers['x-hive-did'] ? ` [${req.headers['x-hive-did'].slice(0, 24)}...]` : '';
    console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms${did}`);
  });
  next();
});

// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const db = await dbHealth();

  let stats = { markets: 0, orders: 0, trades: 0, predict_markets: 0, positions: 0, settlements: 0 };
  let marketBreakdown = {};

  if (isInMemory()) {
    const allMarkets = Array.from(store.markets.values());
    stats.markets = allMarkets.length;
    stats.orders = store.orders.size;
    stats.trades = store.trades.size;
    stats.predict_markets = store.predictMarkets.size;
    stats.positions = store.positions.size;
    stats.settlements = store.settlements.size;

    // Market type breakdown
    const cryptoMarkets = allMarkets.filter(m => m.metadata?.asset_class === 'crypto');
    const syntheticMarkets = allMarkets.filter(m => m.metadata?.asset_class === 'synthetic_equity');
    const hiveNativeMarkets = allMarkets.filter(m => m.metadata?.asset_class === 'hive_native');
    const predictionMarkets = Array.from(store.predictMarkets.values());
    const sportsMarkets = predictionMarkets.filter(m => m.category === 'sports');

    // Category sub-counts for prediction markets
    const catCounts = {};
    for (const cat of VALID_CATEGORIES) {
      catCounts[cat] = predictionMarkets.filter(m => m.category === cat).length;
    }

    marketBreakdown = {
      spot_crypto: cryptoMarkets.length,
      spot_synthetic_equity: syntheticMarkets.length,
      spot_hive_native: hiveNativeMarkets.length,
      prediction_markets: predictionMarkets.length,
      prediction_by_category: catCounts,
      sports_betting: sportsMarkets.length,
      total: allMarkets.length + predictionMarkets.length,
    };
  } else {
    try {
      const [m, o, t, p, pos, s] = await Promise.all([
        query('SELECT COUNT(*) FROM markets'),
        query('SELECT COUNT(*) FROM orders'),
        query('SELECT COUNT(*) FROM trades'),
        query('SELECT COUNT(*) FROM predict_markets'),
        query('SELECT COUNT(*) FROM positions'),
        query('SELECT COUNT(*) FROM settlements'),
      ]);
      stats.markets = parseInt(m.rows[0].count, 10);
      stats.orders = parseInt(o.rows[0].count, 10);
      stats.trades = parseInt(t.rows[0].count, 10);
      stats.predict_markets = parseInt(p.rows[0].count, 10);
      stats.positions = parseInt(pos.rows[0].count, 10);
      stats.settlements = parseInt(s.rows[0].count, 10);
    } catch (_) { /* ignore */ }
  }

  res.status(200).json({
    status: 'ok',
    service: 'hiveexchange',
    version: '1.0.0',
    platform: 'Hive Civilization #20',
    description: 'Agent-to-Agent Trading Exchange & Prediction Markets — 100% autonomous, no human trading.',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    db,
    stats,
    market_breakdown: marketBreakdown,
    integrations: {
      hivegate: HIVEGATE_URL,
      hivebank: HIVEBANK_URL,
      founder_did: FOUNDER_DID,
    },
    rails: ['usdc', 'usdcx', 'usad', 'aleo'],
    features: [
      'spot_trading',
      'synthetic_equities',
      'amm_pools',
      'prediction_markets',
      'sports_betting',
      'price_oracle',
      'leaderboard',
      'agent_portfolio',
      '4_settlement_rails',
    ],
    prediction_categories: VALID_CATEGORIES,
    legal_notice: LEGAL_NOTICE,
  });
});

// ─── Hive Network Manifest ─────────────────────────────────────────────────────
app.get('/.well-known/hive-pulse.json', (req, res) => {
  res.json({
    name: 'HiveExchange',
    type: 'exchange',
    platform_id: 20,
    did: 'did:hive:exchange:hiveexchange',
    founder_did: FOUNDER_DID,
    network: 'Hive Civilization',
    version: '1.0.0',
    description: 'Agent-to-Agent Trading Exchange & Prediction Markets — 100% autonomous, no human trading.',
    base_url: 'https://hiveexchange.onrender.com',
    endpoints: {
      health: '/health',
      markets: '/v1/exchange/markets',
      orders: '/v1/exchange/orders',
      pools: '/v1/exchange/pools',
      predict: '/v1/exchange/predict/markets',
      settle: '/v1/exchange/settle',
      prices: '/v1/exchange/prices',
      leaderboard: '/v1/exchange/leaderboard',
      portfolio: '/v1/exchange/portfolio/:did',
    },
    settlement_rails: {
      usdc:  { network: 'Base L2',  token: 'USDC',  description: 'Circle USDC on Base L2' },
      usdcx: { network: 'Aleo ZK',  token: 'USDCx', description: 'ZK-shielded USDC on Aleo' },
      usad:  { network: 'Aleo ZK',  token: 'USAD',  description: 'Anonymous Paxos-backed stablecoin', anonymous: true },
      aleo:  { network: 'Aleo',     token: 'ALEO',  description: 'Native Aleo token' },
    },
    spot_markets: {
      crypto: ['BTC/USDC','ETH/USDC','SOL/USDC','ALEO/USDC','USAD/USDC','BNB/USDC','AVAX/USDC','MATIC/USDC','ARB/USDC','OP/USDC'],
      synthetic_equity: ['AAPL/USDC','MSFT/USDC','NVDA/USDC','GOOGL/USDC','AMZN/USDC','META/USDC','TSLA/USDC','SPY/USDC','QQQ/USDC','GLD/USDC','OIL/USDC'],
      hive_native: ['HIVE-CREDIT/USDC'],
    },
    integrations: {
      hivegate: HIVEGATE_URL,
      hivebank: HIVEBANK_URL,
      price_oracle: 'CoinGecko (crypto live) + reference stubs (synthetic equity)',
    },
    auth: {
      type: 'hive-did',
      header: 'x-hive-did',
      register: `${HIVEGATE_URL}/v1/gate/register`,
    },
    fees: {
      maker_pct: 0.10,
      taker_pct: 0.18,
      synthetic_equity_maker_pct: 0.15,
      synthetic_equity_taker_pct: 0.25,
      amm_swap_pct: 0.30,
      prediction_resolution_pct: 2.0,
    },
    trust: {
      min_score: 20,
      trust_bonus_threshold: 80,
      source: `${HIVEGATE_URL}/v1/gate/trust/:did`,
    },
    prediction_categories: VALID_CATEGORIES,
    seeded_prediction_markets: 180,
    legal_notice: LEGAL_NOTICE,
    timestamp: new Date().toISOString(),
  });
});

// ─── Price Oracle Routes ───────────────────────────────────────────────────────
app.get('/v1/exchange/prices', rateLimit(), async (req, res) => {
  try {
    const prices = await fetchAllPrices();
    res.json({
      status: 'ok',
      data: {
        prices,
        count: Object.keys(prices).length,
        note: 'Crypto: CoinGecko live (30s cache). Equities: reference stubs for synthetic positioning only.',
        legal_notice: LEGAL_NOTICE,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: 'ORACLE_ERROR', detail: e.message });
  }
});

app.get('/v1/exchange/prices/:symbol', rateLimit(), async (req, res) => {
  try {
    const price = await fetchPrice(req.params.symbol);
    if (!price) {
      return res.status(404).json({
        status: 'error',
        error: 'SYMBOL_NOT_FOUND',
        detail: `Symbol ${req.params.symbol} not found in oracle. Available: BTC, ETH, SOL, ALEO, BNB, AVAX, MATIC, ARB, OP, USAD, AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA, SPY, QQQ, GLD, OIL, HIVE-CREDIT`,
      });
    }
    res.json({ status: 'ok', data: price });
  } catch (e) {
    res.status(500).json({ status: 'error', error: 'ORACLE_ERROR', detail: e.message });
  }
});

// ─── Trades route ──────────────────────────────────────────────────────────────
app.get('/v1/exchange/trades', rateLimit(), async (req, res) => {
  const { market_id, limit = '50' } = req.query;
  const pageLimit = Math.min(parseInt(limit), 200);
  try {
    let trades;
    if (isInMemory()) {
      trades = Array.from(store.trades.values())
        .filter(t => !market_id || t.market_id === market_id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, pageLimit);
    } else {
      let sql = 'SELECT * FROM trades WHERE 1=1';
      const params = [];
      if (market_id) { sql += ` AND market_id = $${params.length + 1}`; params.push(market_id); }
      sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
      params.push(pageLimit);
      const result = await query(sql, params);
      trades = result.rows;
    }
    res.json({ status: 'ok', data: { trades, count: trades.length } });
  } catch (e) {
    res.status(500).json({ status: 'error', error: 'INTERNAL_ERROR', detail: e.message });
  }
});

// ─── Orderbook shortcut ────────────────────────────────────────────────────────
app.get('/v1/exchange/book/:market_id', rateLimit(), async (req, res) => {
  try {
    const { getOrderbook } = await import('./matching-engine.js');
    const depth = Math.min(parseInt(req.query.depth) || 50, 200);
    const orderbook = await getOrderbook(req.params.market_id, depth);
    res.json({ status: 'ok', data: { market_id: req.params.market_id, orderbook, depth } });
  } catch (e) {
    res.status(500).json({ status: 'error', error: 'INTERNAL_ERROR', detail: e.message });
  }
});

// ─── Routes ────────────────────────────────────────────────────────────────────
app.use('/v1/exchange/markets',     marketsRouter);
app.use('/v1/exchange/orders',      ordersRouter);
app.use('/v1/exchange/pools',       poolsRouter);
app.use('/v1/exchange/predict',     predictRouter);
app.use('/v1/exchange/settle',      settleRouter);
app.use('/v1/exchange/leaderboard', leaderboardRouter);
app.use('/v1/exchange/portfolio',   portfolioRouter);

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    error: 'NOT_FOUND',
    detail: `Route ${req.method} ${req.path} not found`,
    docs: 'https://github.com/srotzin/hiveexchange-service',
    available: [
      'GET  /health',
      'GET  /.well-known/hive-pulse.json',
      'GET  /v1/exchange/markets',
      'POST /v1/exchange/markets',
      'GET  /v1/exchange/markets/:id',
      'POST /v1/exchange/orders',
      'DELETE /v1/exchange/orders/:id',
      'GET  /v1/exchange/orders/:id',
      'GET  /v1/exchange/orders?did=',
      'GET  /v1/exchange/trades?market_id=',
      'GET  /v1/exchange/book/:market_id',
      'POST /v1/exchange/pools',
      'GET  /v1/exchange/pools/:id',
      'POST /v1/exchange/pools/:id/add',
      'POST /v1/exchange/pools/:id/remove',
      'POST /v1/exchange/pools/:id/swap',
      'GET  /v1/exchange/predict/markets',
      'POST /v1/exchange/predict/markets',
      'GET  /v1/exchange/predict/markets/:id',
      'POST /v1/exchange/predict/markets/:id/bet',
      'POST /v1/exchange/predict/markets/:id/resolve',
      'GET  /v1/exchange/predict/markets/:id/positions',
      'GET  /v1/exchange/predict/positions?did=',
      'POST /v1/exchange/settle',
      'GET  /v1/exchange/settle/:id',
      'GET  /v1/exchange/prices',
      'GET  /v1/exchange/prices/:symbol',
      'GET  /v1/exchange/leaderboard',
      'GET  /v1/exchange/portfolio/:did',
    ],
  });
});

// ─── Error Handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({
    status: 'error',
    error: 'INTERNAL_ERROR',
    detail: err.message || 'An unexpected error occurred',
  });
});

// ─── Seed: Spot Markets ────────────────────────────────────────────────────────
async function seedSpotMarkets() {
  let existingCount = 0;
  if (isInMemory()) {
    existingCount = store.markets.size;
  } else {
    const res = await query('SELECT COUNT(*) FROM markets');
    existingCount = parseInt(res.rows[0].count, 10);
  }

  if (existingCount >= SEED_MARKETS.length) {
    console.log(`[seed] ${existingCount} spot markets already present — skipping`);
    return;
  }

  console.log(`[seed] Seeding ${SEED_MARKETS.length} spot markets...`);
  for (const m of SEED_MARKETS) {
    // Check by stable ID first (avoid duplicates on redeploy)
    const marketId = m.id;
    if (isInMemory()) {
      if (store.markets.has(marketId)) continue;
      store.markets.set(marketId, {
        ...m,
        id: marketId,
        status: 'active',
        created_by_did: FOUNDER_DID,
        created_at: new Date().toISOString(),
      });
    } else {
      try {
        await query(
          `INSERT INTO markets
           (id, symbol, base_asset, quote_asset, market_type, status,
            maker_fee_pct, taker_fee_pct, created_by_did, metadata, created_at)
           VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,NOW())
           ON CONFLICT (id) DO NOTHING`,
          [
            marketId, m.symbol, m.base_asset, m.quote_asset,
            m.market_type, m.maker_fee_pct, m.taker_fee_pct,
            FOUNDER_DID, JSON.stringify(m.metadata || {}),
          ]
        );
      } catch (e) {
        console.warn(`[seed] market ${m.symbol}: ${e.message}`);
      }
    }
  }
  console.log(`[seed] ${SEED_MARKETS.length} spot markets seeded`);
}

// ─── Seed: Prediction Markets (125 total, stable IDs) ─────────────────────────
async function seedPredictMarkets() {
  // Count existing by checking for stable IDs
  let existingCount = 0;
  if (isInMemory()) {
    existingCount = store.predictMarkets.size;
  } else {
    const res = await query('SELECT COUNT(*) FROM predict_markets');
    existingCount = parseInt(res.rows[0].count, 10);
  }

  if (existingCount >= 5) {
    // Check if we need to add new ones (expansion scenario)
    const toAdd = SEED_PREDICT_MARKETS.filter(m => {
      if (isInMemory()) return !store.predictMarkets.has(m.id);
      return true; // For PG, rely on ON CONFLICT DO NOTHING
    });

    if (toAdd.length === 0 && isInMemory()) {
      console.log(`[seed] ${existingCount} prediction markets already seeded — skipping`);
      return;
    }
    console.log(`[seed] Adding/refreshing ${SEED_PREDICT_MARKETS.length} prediction markets (${existingCount} existing)...`);
  } else {
    console.log(`[seed] Seeding all ${SEED_PREDICT_MARKETS.length} prediction markets...`);
  }

  let seeded = 0;
  let skipped = 0;

  for (const m of SEED_PREDICT_MARKETS) {
    try {
      if (isInMemory()) {
        if (store.predictMarkets.has(m.id)) { skipped++; continue; }
        store.predictMarkets.set(m.id, {
          id: m.id,
          question: m.question,
          resolution_criteria: m.resolution_criteria || m.question,
          category: m.category,
          resolution_date: m.resolution_date,
          status: 'open',
          outcome: null,
          yes_pool_usdc: m.initial_yes,
          no_pool_usdc: m.initial_no,
          total_volume_usdc: 0,
          creator_did: m.creator_did,
          settlement_rail: m.settlement_rail,
          meta_market_id: m.meta_market_id || null,
          created_at: new Date().toISOString(),
          resolved_at: null,
        });
        seeded++;
      } else {
        const result = await query(
          `INSERT INTO predict_markets
           (id, question, resolution_criteria, category, resolution_date,
            status, outcome, yes_pool_usdc, no_pool_usdc, total_volume_usdc,
            creator_did, settlement_rail, meta_market_id, created_at, resolved_at)
           VALUES ($1,$2,$3,$4,$5,'open',NULL,$6,$7,0,$8,$9,$10,NOW(),NULL)
           ON CONFLICT (id) DO NOTHING`,
          [
            m.id, m.question, m.resolution_criteria || m.question,
            m.category, m.resolution_date,
            m.initial_yes, m.initial_no,
            m.creator_did, m.settlement_rail,
            m.meta_market_id || null,
          ]
        );
        if (result.rowCount > 0) seeded++;
        else skipped++;
      }
    } catch (e) {
      console.warn(`[seed] predict ${m.id}: ${e.message}`);
    }
  }

  console.log(`[seed] Prediction markets: ${seeded} seeded, ${skipped} already existed`);
}

// ─── Startup ────────────────────────────────────────────────────────────────────
async function start() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║           HiveExchange — Platform #20                 ║');
  console.log('║   Agent-to-Agent Trading, Prediction & Sports Betting ║');
  console.log('║   22 Spot Markets · 180 Prediction Markets · 19 Cats  ║');
  console.log('║   Meta-Markets · Space · Sports · Oracle · Leaderboard║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  await initDb();
  await Promise.all([
    seedSpotMarkets(),
    seedPredictMarkets(),
  ]);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n[server] HiveExchange running on port ${PORT}`);
    console.log(`[server] Health:      http://localhost:${PORT}/health`);
    console.log(`[server] Manifest:    http://localhost:${PORT}/.well-known/hive-pulse.json`);
    console.log(`[server] Prices:      http://localhost:${PORT}/v1/exchange/prices`);
    console.log(`[server] Leaderboard: http://localhost:${PORT}/v1/exchange/leaderboard`);
    console.log(`[server] DB mode:     ${isInMemory() ? 'IN-MEMORY' : 'PostgreSQL'}`);
    console.log(`[server] HiveGate:    ${HIVEGATE_URL}`);
    console.log(`[server] HiveBank:    ${HIVEBANK_URL}`);
    console.log(`[server] Founder DID: ${FOUNDER_DID}\n`);
  });
}

start().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});

export default app;
