// server.js — hive-prediction-market-router
// BREAKING: refactor(doctrine) 2026-04-29
// All AMM, perp, synthetic-equity, derivatives, MPC-wallet routes DISABLED (410 Gone).
// Service reclassified as hive-prediction-market-router per Partner Doctrine.
// Clean revenue path: Azuro 55% rev-share attribution + Polymarket routing.
// Fee: 5 bps trust+receipt fee paid by agent via x402 on every routing event.
// Hive does NOT custody, does NOT match, does NOT run any AMM or order book.
// Hive routes prediction-market orders to Azuro / Polymarket and issues Spectral receipts.

import express from 'express';
import cors from 'cors';
import { initDb, dbHealth } from './db.js';
import predictRouter from './routes/predict.js';
import leaderboardRouter from './routes/leaderboard.js';
import faucetRouter from './routes/faucet.js';
import hivestatusRouter from './routes/hivestatus.js';
import { rateLimit } from './middleware/rate-limit.js';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = process.env.PORT || 3010;
const HIVEGATE_URL = process.env.HIVEGATE_URL || 'https://hivegate.onrender.com';
const HIVE_ORACLE_URL = 'https://hive-mcp-oracle.onrender.com';
const FOUNDER_DID = 'did:hive:f150bbec-5660-413e-b305-d8d965b47845';

// ─── Treasury ─────────────────────────────────────────────────────────────────
const TREASURY = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRUST_FEE_BPS = 5; // 5 bps trust+receipt fee — x402, partner-doctrine clean

// ─── Spectral receipt emitter ─────────────────────────────────────────────────
async function emitSpectralReceipt({ event_type, amount_usd, caller_did, meta = {} }) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    await fetch('https://hive-receipt.onrender.com/v1/receipt/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        issuer_did: 'did:hive:hive-prediction-market-router',
        event_type,
        amount_usd,
        currency: 'USDC',
        network: 'base',
        pay_to: TREASURY,
        caller_did,
        ...meta,
      }),
    });
    clearTimeout(t);
  } catch (_) {
    // Non-blocking — never interrupt fee path
  }
}

app.use(cors());
app.use(express.json());

// ─── 410 GONE — doctrine-disabled routes ─────────────────────────────────────
// ALL AMM, perp, synthetic-equity, derivatives, spot-trading, and MPC-wallet
// routes are permanently disabled per Partner Doctrine (2026-04-29).
// Hive is NEVER a DEX, NEVER an AMM, NEVER a derivatives venue,
// NEVER a synthetic-equity issuer, NEVER an MPC wallet.
// These surfaces belong to OKX, Coinbase, dYdX, Hyperliquid, MetaMask — our partners.

const DISABLED_ROUTES = [
  // AMM liquidity pools
  '/v1/exchange/pools',
  '/v1/exchange/pools/:id',
  '/v1/exchange/pools/:id/add',
  '/v1/exchange/pools/:id/remove',
  '/v1/exchange/pools/:id/swap',
  // Spot order book / matching engine
  '/v1/exchange/markets',
  '/v1/exchange/markets/:id',
  '/v1/exchange/orders',
  '/v1/exchange/orders/:id',
  '/v1/exchange/trades',
  '/v1/exchange/book/:market_id',
  // Perpetual futures
  '/v1/exchange/perps/markets',
  '/v1/exchange/perps/positions',
  '/v1/exchange/perps/positions/:id/close',
  '/v1/exchange/perps/funding',
  // Options / derivatives
  '/v1/exchange/derivatives/markets',
  '/v1/exchange/derivatives/positions',
  '/v1/exchange/derivatives/positions/:id/exercise',
  '/v1/exchange/derivatives/chain/:underlying',
  // Synthetic equity prices (Pyth feeds — now routed to hive-mcp-oracle)
  '/v1/exchange/prices',
  '/v1/exchange/prices/:symbol',
  // Settlement (was native — now prediction-market only via /v1/predict/settle)
  '/v1/exchange/settle',
  '/v1/exchange/settle/:id',
];

const GONE_BODY = (path) => ({
  status: 'gone',
  error: 'ROUTE_DISABLED',
  code: 410,
  reclassification: {
    effective: '2026-04-29',
    reason: 'Partner Doctrine violation. Hive is NEVER a DEX, AMM, derivatives venue, synthetic-equity issuer, or MPC wallet.',
    doctrine_doc: 'https://hiveagentiq.com/docs/partner-doctrine',
    new_service: 'hive-prediction-market-router',
    new_endpoint: path.includes('prices') || path.includes('prices')
      ? '/dev/null — use hive-mcp-oracle for price feeds (Pyth partner output)'
      : path.includes('settle') ? '/v1/predict/settle' : '/v1/predict/markets',
    partner_alternatives: {
      amm_dex: 'OKX DEX, Uniswap, Coinbase Exchange',
      perps_derivatives: 'dYdX, Hyperliquid',
      synthetic_equities: 'not in scope for Hive — route to regulated incumbent',
      mpc_wallet: 'MetaMask, Trust Wallet, Coinbase Wallet',
      price_feeds: 'hive-mcp-oracle (Pyth partner output): https://hive-mcp-oracle.onrender.com',
    },
  },
  message: `${path} was disabled on 2026-04-29 during doctrine reclassification. This service is now hive-prediction-market-router. Use /v1/predict/* for prediction-market routing.`,
});

// Register 410 for all disabled patterns (all HTTP methods)
for (const pattern of DISABLED_ROUTES) {
  app.all(pattern, (req, res) => {
    res.status(410).json(GONE_BODY(req.path));
  });
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const db = await dbHealth();
  res.json({
    status: 'ok',
    service: 'hive-prediction-market-router',
    did: 'did:hive:hive-prediction-market-router',
    version: '2.0.0',
    reclassified: '2026-04-29',
    platform: 'Hive Civilization #20',
    description:
      'Prediction-market order router. Routes to Azuro (sports) and Polymarket (general). ' +
      'Azuro 55% rev-share. 5 bps trust+receipt fee via x402. ' +
      'Hive does not custody, match, or run any AMM.',
    doctrine: 'partner — never competitor to OKX, Coinbase, dYdX, Hyperliquid, Polymarket, Azuro',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    db,
    revenue: {
      primary: 'Azuro 55% rev-share on sports prediction markets',
      secondary: 'Polymarket referral attribution',
      fee_model: '5 bps trust+receipt fee (x402, agent-paid)',
      treasury: TREASURY,
      currency: 'USDC',
      network: 'base',
    },
    partners: {
      azuro: 'https://azuro.org — bookmaker; Hive is attribution/routing layer',
      polymarket: 'https://polymarket.com — venue; Hive is routing layer',
      pyth: 'price feeds now via hive-mcp-oracle (Pyth partner output)',
      pyth_oracle_url: HIVE_ORACLE_URL,
    },
    disabled_surfaces: [
      'AMM pools (was: /v1/exchange/pools/*)',
      'Spot markets / order book (was: /v1/exchange/markets/*, /v1/exchange/orders/*)',
      'Perpetual futures (was: /v1/exchange/perps/*)',
      'Derivatives / options (was: /v1/exchange/derivatives/*)',
      'Synthetic equity prices (was: /v1/exchange/prices/*) — now via hive-mcp-oracle',
      'Native settlement (was: /v1/exchange/settle) — now /v1/predict/settle',
    ],
    active_surfaces: [
      'GET  /v1/predict/markets',
      'POST /v1/predict/markets',
      'GET  /v1/predict/markets/:id',
      'POST /v1/predict/markets/:id/bet',
      'POST /v1/predict/markets/:id/resolve',
      'GET  /v1/predict/markets/:id/positions',
      'GET  /v1/predict/positions',
      'POST /v1/predict/settle',
      'GET  /v1/predict/leaderboard',
      'GET  /v1/predict/portfolio/:did',
    ],
    integrations: {
      hivegate: HIVEGATE_URL,
      hive_oracle: HIVE_ORACLE_URL,
      founder_did: FOUNDER_DID,
    },
    rails: ['usdc', 'usdcx', 'usad'],
  });
});

// ─── Root — reclassification notice + route map ───────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'hive-prediction-market-router',
    version: '2.0.0',
    reclassified: '2026-04-29',
    description:
      'Hive Prediction Market Router — routes prediction-market orders to Azuro (sports) ' +
      'and Polymarket (general). Azuro 55% rev-share. 5 bps x402 trust+receipt fee. ' +
      'Hive does not custody, does not match, does not run an AMM.',
    doctrine: {
      status: 'CLEAN',
      partner_not_competitor: true,
      partners: ['Azuro', 'Polymarket', 'Pyth', 'OKX', 'Coinbase', 'dYdX', 'Hyperliquid'],
      never: ['DEX', 'AMM', 'derivatives-venue', 'synthetic-equity-issuer', 'MPC-wallet'],
    },
    fee: {
      model: 'trust_receipt',
      bps: 5,
      protocol: 'x402',
      asset: 'USDC',
      network: 'base',
      pay_to: TREASURY,
    },
    available: [
      'GET  /health',
      'GET  /v1/predict/markets',
      'POST /v1/predict/markets',
      'GET  /v1/predict/markets/:id',
      'POST /v1/predict/markets/:id/bet',
      'POST /v1/predict/markets/:id/resolve',
      'GET  /v1/predict/markets/:id/positions',
      'GET  /v1/predict/positions?did=',
      'POST /v1/predict/settle',
      'GET  /v1/predict/leaderboard',
      'GET  /v1/predict/portfolio/:did',
      'GET  /v1/predict/subscription',
      'POST /v1/predict/subscription',
      'GET  /.well-known/agent-card.json',
    ],
    disabled: {
      message: 'AMM, perp, synthetic-equity, derivatives, and spot-market routes return 410 Gone.',
      details: 'https://hiveagentiq.com/docs/partner-doctrine',
    },
    pyth_feeds: {
      disposition: 'REROUTED_TO_ORACLE_PARTNER',
      note:
        '1,748 Pyth synthetic-equity feeds previously consumed by the AMM are now surfaced ' +
        'as price-feed partner output through hive-mcp-oracle. ' +
        'Pyth is a partner; Hive never issues its own prices.',
      oracle_url: HIVE_ORACLE_URL,
    },
  });
});

// ─── x402 Subscription (prediction-market access tier) ───────────────────────
app.post('/v1/predict/subscription', rateLimit(), async (req, res) => {
  const { tier = 'starter', tx_hash, did } = req.body;

  const tiers = {
    starter:    { price_usd: 20,  label: 'Starter',    markets_per_mo: 100,  note: 'Azuro sports + Polymarket general' },
    pro:        { price_usd: 99,  label: 'Pro',         markets_per_mo: 1000, note: 'Full market access + Spectral receipts + priority routing' },
    enterprise: { price_usd: 500, label: 'Enterprise',  markets_per_mo: null, note: 'Unlimited + SLA + custom Azuro rev-share split + audit attestation' },
  };

  const t = tiers[tier] || tiers.starter;

  if (tier === 'enterprise' || tx_hash) {
    const sub_id = uuidv4();
    await emitSpectralReceipt({
      event_type: 'prediction_market_subscription',
      amount_usd: t.price_usd,
      caller_did: did || 'anonymous',
      meta: { tier, sub_id, partner_attribution: 'Azuro 55% rev-share | Polymarket referral' },
    });
    return res.json({
      status: 'ok',
      subscription: {
        id: sub_id,
        tier,
        ...t,
        expires_ms: Date.now() + 30 * 24 * 60 * 60 * 1000,
        receipt_emitted: true,
        brand: '#C08D23',
        partner_attribution:
          'Routes to Azuro (sports, 55% rev-share) and Polymarket (general). ' +
          'Hive never acts as bookmaker or AMM. All market settlement is on-venue.',
      },
    });
  }

  // x402 gate
  return res.status(402).json({
    type: 'x402',
    version: '1',
    kind: `subscription_prediction_market_${tier}`,
    asking_usd: t.price_usd,
    asset: 'USDC',
    asset_address: USDC_BASE,
    network: 'base',
    pay_to: TREASURY,
    fee_bps: TRUST_FEE_BPS,
    bogo: { first_call_free: true, loyalty_every_n: 6 },
    tier_details: t,
    partner_attribution:
      'Azuro 55% rev-share on sports markets. Polymarket referral. ' +
      'Hive is routing layer only — never bookmaker, never AMM, never derivatives venue.',
    brand: '#C08D23',
  });
});

app.get('/v1/predict/subscription', (req, res) => {
  res.json({
    tiers: {
      starter:    { price_usd: 20,  markets_per_mo: 100,  features: ['Azuro sports routing', 'Polymarket general routing', 'Spectral receipts'] },
      pro:        { price_usd: 99,  markets_per_mo: 1000, features: ['All starter features', 'Priority routing', 'Azuro rev-share reporting', 'x402 fee waivers'] },
      enterprise: { price_usd: 500, markets_per_mo: null, features: ['All pro features', 'Custom Azuro rev-share split', 'SLA guarantee', 'Audit attestation'] },
    },
    fee_model: {
      bps: TRUST_FEE_BPS,
      note: '5 bps trust+receipt fee on every routing event (paid by agent via x402)',
      partner_revenue: 'Azuro 55% rev-share on sports markets',
    },
  });
});

// ─── Prediction-market routes (CLEAN path) ────────────────────────────────────
app.use('/v1/predict', predictRouter);
app.use('/v1/predict/leaderboard', leaderboardRouter);
app.use('/v1/predict/portfolio', leaderboardRouter);  // portfolio is on same router

// ─── Pyth feed disposition endpoint ──────────────────────────────────────────
// The 1,748 Pyth feeds previously consumed by the AMM are now surfaced
// through hive-mcp-oracle as price-feed partner output.
// This endpoint explains and redirects.
app.get('/v1/pyth-feeds', (req, res) => {
  res.json({
    status: 'rerouted',
    disposition: 'REROUTED_TO_ORACLE_PARTNER',
    effective: '2026-04-29',
    feeds_count: 1748,
    explanation:
      'The 1,748 Pyth synthetic-equity feeds previously consumed by the AMM (which has been ' +
      'disabled per Partner Doctrine) are now surfaced as price-feed partner output through ' +
      'hive-mcp-oracle. Pyth is a Hive partner; Hive never issues its own prices or operates ' +
      'a synthetic-equity venue. All price queries should be directed to hive-mcp-oracle.',
    oracle: {
      url: HIVE_ORACLE_URL,
      endpoint: `${HIVE_ORACLE_URL}/v1/oracle/price/:symbol`,
      partner: 'Pyth Network',
      note: 'Pyth is partner — Hive routes, Pyth sources. Trust receipts issued on every query.',
    },
    doctrine_ref: 'https://hiveagentiq.com/docs/partner-doctrine',
  });
});

// ─── Faucet (free USDC for new agents — prediction market entry) ─────────────
app.use('/v1/predict/faucet', faucetRouter);
app.use('/v1/exchange/faucet', faucetRouter); // legacy redirect

// ─── Hive status ──────────────────────────────────────────────────────────────
app.use('/v1/hivestatus', hivestatusRouter);

// ─── Agent card ───────────────────────────────────────────────────────────────
app.get('/.well-known/agent-card.json', (req, res) => {
  res.json({
    protocolVersion: '0.3.0',
    name: 'hive-prediction-market-router',
    description:
      'Hive Prediction Market Router — routes prediction-market orders to Azuro (sports) ' +
      'and Polymarket (general events). Azuro 55% rev-share. ' +
      '5 bps trust+receipt fee paid by agent via x402 on every routing event. ' +
      'Hive issues Spectral receipts on routing events with the partner venue\'s confirmation hash. ' +
      'Hive does not custody funds, does not match orders, does not run an AMM or order book.',
    url: 'https://hiveexchange-service.onrender.com',
    version: '2.0.0',
    provider: {
      organization: 'Hive Civilization',
      url: 'https://hiveagentiq.com',
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      prediction_market_routing: true,
      azuro_rev_share: true,
      spectral_receipts: true,
      x402_payments: true,
    },
    skills: [
      {
        id: 'predict-route',
        name: 'Prediction Market Routing',
        description:
          'Route a prediction-market order to Azuro (sports) or Polymarket (general). ' +
          '5 bps trust+receipt fee. Spectral receipt issued with venue confirmation hash.',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        fee: { bps: 5, model: 'trust_receipt', protocol: 'x402' },
      },
      {
        id: 'azuro-bet',
        name: 'Azuro Sports Routing',
        description:
          'Route sports prediction-market orders to Azuro protocol. ' +
          'Azuro is the bookmaker; Hive is the attribution/routing layer earning 55% rev-share.',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'polymarket-route',
        name: 'Polymarket General Routing',
        description:
          'Route general prediction-market orders to Polymarket. ' +
          'Polymarket is the venue; Hive provides routing and receipt attestation.',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    authentication: { schemes: ['x402', 'api-key'] },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: TREASURY,
      fee_bps: TRUST_FEE_BPS,
      note: '5 bps trust+receipt fee on every routing event',
    },
    extensions: {
      hive_pricing: {
        currency: 'USDC',
        network: 'base',
        model: 'per_routing_event',
        fee_bps: 5,
        subscription_available: true,
        first_call_free: true,
        loyalty_threshold: 6,
        loyalty_message: 'Every 6th paid routing event is free',
      },
      doctrine: {
        status: 'CLEAN',
        reclassified: '2026-04-29',
        never: ['DEX', 'AMM', 'perps', 'derivatives', 'synthetic-equities', 'MPC-wallet'],
        partner_to: ['Azuro', 'Polymarket', 'Pyth', 'OKX', 'Coinbase', 'dYdX', 'Hyperliquid'],
      },
    },
    bogo: {
      first_call_free: true,
      loyalty_threshold: 6,
      pitch: 'Pay this once, your 6th paid routing event is on the house.',
      claim_with: 'x-hive-did header',
    },
  });
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    error: 'NOT_FOUND',
    detail: `Route ${req.method} ${req.path} not found`,
    docs: 'https://github.com/srotzin/hiveexchange-service',
    service: 'hive-prediction-market-router',
    available: [
      'GET  /health',
      'GET  /v1/predict/markets',
      'POST /v1/predict/markets',
      'GET  /v1/predict/markets/:id',
      'POST /v1/predict/markets/:id/bet',
      'POST /v1/predict/markets/:id/resolve',
      'GET  /v1/predict/markets/:id/positions',
      'GET  /v1/predict/positions?did=',
      'POST /v1/predict/settle',
      'GET  /v1/predict/leaderboard',
      'GET  /v1/predict/portfolio/:did',
      'GET  /v1/predict/subscription',
      'POST /v1/predict/subscription',
      'GET  /v1/pyth-feeds',
      'GET  /.well-known/agent-card.json',
    ],
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`[hive-prediction-market-router] listening on :${PORT}`);
    console.log(`[doctrine] reclassified 2026-04-29 — AMM/perp/synth/deriv/MPC-wallet DISABLED`);
    console.log(`[fee] 5 bps trust+receipt via x402 — Azuro 55% rev-share primary revenue`);
    console.log(`[pyth] 1,748 feeds rerouted to hive-mcp-oracle (partner output)`);
  });
}
boot().catch((e) => { console.error(e); process.exit(1); });
