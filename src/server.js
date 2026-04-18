// server.js — HiveExchange Express app
import express from 'express';
import cors from 'cors';
import { initDb, dbHealth, isInMemory, store } from './db.js';
import { createPredictMarket, listPredictMarkets, calcOdds } from './prediction.js';
import marketsRouter from './routes/markets.js';
import ordersRouter from './routes/orders.js';
import poolsRouter from './routes/pools.js';
import predictRouter from './routes/predict.js';
import settleRouter from './routes/settle.js';
import { rateLimit } from './middleware/rate-limit.js';

const app = express();
const PORT = process.env.PORT || 3010;
const HIVEGATE_URL = process.env.HIVEGATE_URL || 'https://hivegate.onrender.com';
const HIVEBANK_URL = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';
const FOUNDER_DID = 'did:hive:f150bbec-5660-413e-b305-d8d965b47845';

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const did = req.headers['x-hive-did'] ? ` [${req.headers['x-hive-did'].slice(0, 20)}...]` : '';
    console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms${did}`);
  });
  next();
});

// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const db = await dbHealth();

  // Market stats
  let marketCount = 0;
  let orderCount = 0;
  let tradeCount = 0;
  let predictCount = 0;

  if (isInMemory()) {
    marketCount = store.markets.size;
    orderCount = store.orders.size;
    tradeCount = store.trades.size;
    predictCount = store.predictMarkets.size;
  } else {
    try {
      const { pool } = await import('./db.js');
      const [m, o, t, p] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM markets'),
        pool.query('SELECT COUNT(*) FROM orders'),
        pool.query('SELECT COUNT(*) FROM trades'),
        pool.query('SELECT COUNT(*) FROM predict_markets'),
      ]);
      marketCount = parseInt(m.rows[0].count, 10);
      orderCount = parseInt(o.rows[0].count, 10);
      tradeCount = parseInt(t.rows[0].count, 10);
      predictCount = parseInt(p.rows[0].count, 10);
    } catch (_) { /* ignore */ }
  }

  res.status(200).json({
    status: 'ok',
    service: 'hiveexchange',
    version: '1.0.0',
    platform: 'Hive Civilization #20',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    db,
    stats: {
      markets: marketCount,
      orders: orderCount,
      trades: tradeCount,
      predict_markets: predictCount,
    },
    integrations: {
      hivegate: HIVEGATE_URL,
      hivebank: HIVEBANK_URL,
      founder_did: FOUNDER_DID,
    },
    rails: ['usdc', 'usdcx', 'usad', 'aleo'],
    features: ['spot_trading', 'amm_pools', 'prediction_markets', '4_settlement_rails'],
  });
});

// ─── Hive Network Manifest ─────────────────────────────────────────────────────
app.get('/.well-known/hive-pulse.json', (req, res) => {
  res.json({
    name: 'HiveExchange',
    type: 'exchange',
    platform_id: 20,
    did: `did:hive:exchange:hiveexchange`,
    founder_did: FOUNDER_DID,
    network: 'Hive Civilization',
    version: '1.0.0',
    description: 'Agent-to-Agent Trading Exchange & Prediction Markets — 100% autonomous, no human trading.',
    base_url: `https://hiveexchange.onrender.com`,
    endpoints: {
      health: '/health',
      markets: '/v1/exchange/markets',
      orders: '/v1/exchange/orders',
      pools: '/v1/exchange/pools',
      predict: '/v1/exchange/predict/markets',
      settle: '/v1/exchange/settle',
    },
    settlement_rails: {
      usdc: { network: 'Base L2', token: 'USDC' },
      usdcx: { network: 'Aleo ZK', token: 'USDCx' },
      usad: { network: 'Aleo ZK', token: 'USAD', anonymous: true },
      aleo: { network: 'Aleo', token: 'ALEO' },
    },
    integrations: {
      hivegate: HIVEGATE_URL,
      hivebank: HIVEBANK_URL,
    },
    auth: {
      type: 'hive-did',
      header: 'x-hive-did',
      register: `${HIVEGATE_URL}/v1/gate/register`,
    },
    fees: {
      maker_pct: 0.10,
      taker_pct: 0.18,
      amm_swap_pct: 0.30,
      prediction_resolution_pct: 2.0,
    },
    trust: {
      min_score: 20,
      trust_bonus_threshold: 80,
      source: `${HIVEGATE_URL}/v1/gate/trust/:did`,
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── Trades route (attached to orders router but needs separate path) ──────────
app.get('/v1/exchange/trades', rateLimit(), async (req, res) => {
  const { market_id, limit = '50' } = req.query;
  const pageLimit = Math.min(parseInt(limit), 200);

  try {
    let trades;
    if (isInMemory()) {
      trades = Array.from(store.trades.values())
        .filter((t) => !market_id || t.market_id === market_id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, pageLimit);
    } else {
      const { query } = await import('./db.js');
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
app.use('/v1/exchange/markets', marketsRouter);
app.use('/v1/exchange/orders', ordersRouter);
app.use('/v1/exchange/pools', poolsRouter);
app.use('/v1/exchange/predict', predictRouter);
app.use('/v1/exchange/settle', settleRouter);

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    error: 'NOT_FOUND',
    detail: `Route ${req.method} ${req.path} not found`,
    docs: 'https://github.com/srotzin/hiveexchange-service',
    available: [
      'GET /health',
      'GET /.well-known/hive-pulse.json',
      'GET /v1/exchange/markets',
      'POST /v1/exchange/orders',
      'POST /v1/exchange/pools',
      'POST /v1/exchange/predict/markets',
      'POST /v1/exchange/settle',
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

// ─── Construction Prediction Market Seeds ─────────────────────────────────────
const CONSTRUCTION_MARKETS = [
  {
    question: 'Will the San Francisco Permit Office approve residential ADU permits within 30 days in Q3 2026?',
    resolution_criteria: 'Resolution based on official SFPUC/DBI permit processing times for ADU applications filed in Q3 2026. YES if median approval time <= 30 days.',
    resolution_date: '2026-10-01T00:00:00.000Z',
    category: 'construction',
    settlement_rail: 'usdc',
  },
  {
    question: 'Will concrete costs (Portland Cement, per ton) exceed $180 by July 2026?',
    resolution_criteria: 'Based on USGS Minerals Information monthly Portland Cement price index. YES if average spot price exceeds $180/ton in July 2026.',
    resolution_date: '2026-07-31T00:00:00.000Z',
    category: 'construction',
    settlement_rail: 'usdc',
  },
  {
    question: 'Will a randomly sampled HiveConstruct draw request be approved within 14 days?',
    resolution_criteria: 'Random sample of 100 HiveConstruct construction draw requests submitted in Q2 2026. YES if >= 60% are approved within 14 calendar days.',
    resolution_date: '2026-07-15T00:00:00.000Z',
    category: 'construction',
    settlement_rail: 'usdc',
  },
  {
    question: 'Will subcontractor no-show rates on HiveExchange construction jobs exceed 15% in Q2 2026?',
    resolution_criteria: 'Measured by HiveExchange on-chain job completion records for Q2 2026. YES if confirmed no-show/abandonment rate exceeds 15%.',
    resolution_date: '2026-07-01T00:00:00.000Z',
    category: 'construction',
    settlement_rail: 'usdc',
  },
  {
    question: 'Will the NAHB Housing Market Index exceed 55 in June 2026?',
    resolution_criteria: 'Based on the official NAHB/Wells Fargo Housing Market Index released for June 2026. YES if HMI reading > 55.',
    resolution_date: '2026-06-30T00:00:00.000Z',
    category: 'construction',
    settlement_rail: 'usdc',
  },
];

async function seedConstructionMarkets() {
  const existing = await listPredictMarkets({ category: 'construction' });
  if (existing.length >= 5) {
    console.log(`[seed] ${existing.length} construction prediction markets already seeded — skipping`);
    return;
  }

  console.log('[seed] Seeding 5 construction prediction markets...');
  for (const m of CONSTRUCTION_MARKETS) {
    try {
      const created = await createPredictMarket({
        ...m,
        creator_did: FOUNDER_DID,
        initial_yes: 100, // Founder seeds 100 USDC each side
        initial_no: 100,
      });
      console.log(`[seed] Created: "${created.question.slice(0, 60)}..." (${created.id})`);
    } catch (e) {
      console.warn(`[seed] Failed to create market: ${e.message}`);
    }
  }
  console.log('[seed] Construction prediction markets seeded');
}

// ─── Startup ────────────────────────────────────────────────────────────────────
async function start() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        HiveExchange — Platform #20               ║');
  console.log('║    Agent-to-Agent Trading Exchange & Predict     ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await initDb();
  await seedConstructionMarkets();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n[server] HiveExchange running on port ${PORT}`);
    console.log(`[server] Health: http://localhost:${PORT}/health`);
    console.log(`[server] Manifest: http://localhost:${PORT}/.well-known/hive-pulse.json`);
    console.log(`[server] DB mode: ${isInMemory() ? 'IN-MEMORY' : 'PostgreSQL'}`);
    console.log(`[server] HiveGate: ${HIVEGATE_URL}`);
    console.log(`[server] HiveBank: ${HIVEBANK_URL}`);
    console.log(`[server] Founder DID: ${FOUNDER_DID}\n`);
  });
}

start().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});

export default app;
