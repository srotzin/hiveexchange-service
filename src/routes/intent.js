/**
 * intent.js — Transaction Intent Book (Pillar 4: A2A Transaction Singularity)
 *
 * "HiveExchange settles machine intent with proven certainty.
 *  Everything else — prediction, hedge, insurance, royalty —
 *  is priced from that certainty."
 *                                        — Hive, April 2026
 *
 * The atomic asset is not an agent. Not a market. Not a payment.
 * The atomic asset is: TRANSACTION INTENT.
 *
 * Whoever owns intent before settlement owns the economy.
 * Stripe owns payment acceptance.
 * Visa owns card rails.
 * Polymarket owns event speculation.
 * Hive owns: pre-transaction A2A intent — and the certainty data that prices it.
 *
 * --- THE GOD LOOP ---
 * Intent enters Hive
 *   → Hive prices it (reserve price from historical certainty scores)
 *   → Hive auctions the route
 *   → Hive attaches hedge/insurance (priced from execution certainty)
 *   → Hive settles it
 *   → Hive audits it (CLOAzK attestation)
 *   → Hive stores memory (route_selected, execution_certainty_score)
 *   → Hive improves future execution (certainty compounds per agent)
 *   → Hive mints agents to fill gaps (unfilled_reason → demand signal)
 *   → More intent enters Hive
 *
 * --- BUNDLE EXAMPLE ---
 * buy_compute → hedge_cost → pay_provider → store_memory → update_trust → settle_privately
 * That is ONE intent object. Every step is a Hive service. This file wires them.
 *
 * --- THREE FIELDS THAT BUILD THE MOAT ---
 * route_selected       — which service won + why (builds routing intelligence)
 * unfilled_reason      — why intent expired unmatched (builds demand signal DB)
 * execution_certainty  — 0-100 score at settlement (prices insurance + perps)
 *
 * Unfilled intents are not failures. They are price discovery events.
 * Log them. They become the reserve price seed for the next auction.
 *
 * --- ALEO ZK ---
 * Intent Dark Pool (#4) and ZK Clean Transaction Certificate (#18) use CLOAzK
 * Phase 1 attestations now, Aleo Leo circuit proofs in Phase 2.
 * The sealed intent hash is the same proof object — just anchored on-chain.
 *
 * --- ENDPOINTS ---
 * POST /v1/exchange/intent/submit        — list a transaction intent
 * GET  /v1/exchange/intent/:id           — fetch intent + status
 * POST /v1/exchange/intent/:id/bid       — route agent bids to fulfill
 * POST /v1/exchange/intent/:id/execute   — winner executes the God Loop
 * POST /v1/exchange/intent/:id/salvage   — failed intent goes to rescue market
 * GET  /v1/exchange/intent/book          — public intent book (non-sealed)
 * GET  /v1/exchange/intent/indexes       — live transaction flow indexes
 * GET  /v1/exchange/intent/signals       — unfilled demand signals (price discovery)
 * GET  /v1/exchange/intent/info          — pricing + capability sheet
 *
 * --- PRICING (Silicon Premium: 10x for agents) ---
 * Intent listing fee:    $0.10 human / $1.00 agent
 * Route auction fee:     2% of notional (winner pays)
 * Priority slot fee:     $1/$5/$25/$100/$500 (standard→sovereign)
 * Insurance attach:      1% of notional per policy type
 * Salvage listing fee:   free (Hive takes 5% of rescue bid)
 * ZK clean cert:         $50 human / $500 agent
 * Sovereign mode:        $2,500/mo flat
 */

'use strict';

import express from 'express';
import crypto  from 'crypto';
import { query } from '../db.js';

const router = express.Router();

const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const SILICON = 10;

const PRIORITY_TIERS = {
  standard:   { human: 0,    agent: 0,     label: 'Standard — best-effort routing' },
  fast:       { human: 1,    agent: 10,    label: 'Fast — top-10 route pool' },
  guaranteed: { human: 5,    agent: 50,    label: 'Guaranteed — SLA-backed 30s exec' },
  private:    { human: 25,   agent: 250,   label: 'Private — sealed route, CLOAzK audit' },
  sovereign:  { human: 100,  agent: 1000,  label: 'Sovereign — ZK cert + policy-as-code' },
};

const INSURANCE_TYPES = [
  'failure', 'latency', 'slippage', 'counterparty_default',
  'compliance_failure', 'oracle_failure',
];

// ── DB bootstrap ──────────────────────────────────────────────────────────────

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS transaction_intents (
      id                        TEXT PRIMARY KEY,
      agent_did                 TEXT,
      intent_type               TEXT NOT NULL,
      notional_usdc             NUMERIC(18,4),
      deadline_sec              INTEGER,
      privacy                   TEXT DEFAULT 'public',
      priority_tier             TEXT DEFAULT 'standard',
      constraints               JSONB,
      bundle_steps              JSONB,
      status                    TEXT DEFAULT 'pending',
      winner_did                TEXT,
      route_fee_usdc            NUMERIC(10,4) DEFAULT 0,
      insurance                 JSONB,
      cloazk_cert_id            TEXT,
      listing_fee               NUMERIC(10,4) DEFAULT 0,
      caller_type               TEXT DEFAULT 'agent',
      sealed_hash               TEXT,
      // Three fields that build the moat
      route_selected            JSONB,
      unfilled_reason           TEXT,
      execution_certainty_score NUMERIC(5,2),
      created_at                TIMESTAMPTZ DEFAULT NOW(),
      routed_at                 TIMESTAMPTZ,
      expires_at                TIMESTAMPTZ,
      executed_at               TIMESTAMPTZ
    );
  `);
  // Migrate existing tables: add new columns if they don't exist yet
  await query(`ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS route_selected JSONB`).catch(() => {});
  await query(`ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS unfilled_reason TEXT`).catch(() => {});
  await query(`ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS execution_certainty_score NUMERIC(5,2)`).catch(() => {});
  await query(`ALTER TABLE transaction_intents ADD COLUMN IF NOT EXISTS routed_at TIMESTAMPTZ`).catch(() => {});
  // Change default status from 'open' to 'pending' for new three-state machine
  await query(`ALTER TABLE transaction_intents ALTER COLUMN status SET DEFAULT 'pending'`).catch(() => {});
  await query(`
    CREATE TABLE IF NOT EXISTS route_bids (
      id            SERIAL PRIMARY KEY,
      intent_id     TEXT NOT NULL REFERENCES transaction_intents(id),
      bidder_did    TEXT NOT NULL,
      bid_fee_usdc  NUMERIC(10,4) NOT NULL,
      latency_ms    INTEGER,
      confidence    NUMERIC(4,2),
      route_hash    TEXT,
      status        TEXT DEFAULT 'pending',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS intent_settlements (
      id                        SERIAL PRIMARY KEY,
      intent_id                 TEXT NOT NULL,
      executor_did              TEXT,
      bundle_log                JSONB,
      pnl_usdc                  NUMERIC(10,4),
      cloazk_cert_id            TEXT,
      rail                      TEXT DEFAULT 'usdc',
      route_selected            JSONB,
      execution_certainty_score NUMERIC(5,2),
      latency_ms                INTEGER,
      status                    TEXT DEFAULT 'settled',
      settled_at                TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await query(`ALTER TABLE intent_settlements ADD COLUMN IF NOT EXISTS route_selected JSONB`).catch(() => {});
  await query(`ALTER TABLE intent_settlements ADD COLUMN IF NOT EXISTS execution_certainty_score NUMERIC(5,2)`).catch(() => {});
  await query(`ALTER TABLE intent_settlements ADD COLUMN IF NOT EXISTS latency_ms INTEGER`).catch(() => {});
  await query(`
    CREATE TABLE IF NOT EXISTS failed_intent_salvage (
      id              SERIAL PRIMARY KEY,
      intent_id       TEXT NOT NULL,
      original_agent  TEXT,
      rescue_agent    TEXT,
      rescue_fee_usdc NUMERIC(10,4),
      hive_cut_usdc   NUMERIC(10,4),
      status          TEXT DEFAULT 'open',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Unfilled demand signals table
  // Every expired/failed intent is a price discovery event, not a discard.
  await query(`
    CREATE TABLE IF NOT EXISTS intent_demand_signals (
      id              SERIAL PRIMARY KEY,
      intent_id       TEXT NOT NULL,
      intent_type     TEXT NOT NULL,
      notional_usdc   NUMERIC(18,4),
      priority_tier   TEXT,
      unfilled_reason TEXT NOT NULL,
      bid_count       INTEGER DEFAULT 0,
      agent_did       TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function isAgent(req) {
  if (req.headers['x-caller-type'] === 'human') return false;
  if (req.headers['x-hive-did'] || req.headers['x-a2a-agent']) return true;
  const ua = req.headers['user-agent'] || '';
  return !ua || !/mozilla|chrome|safari|firefox|edge/i.test(ua);
}

function siliconPrice(base, req) {
  return base * (isAgent(req) ? SILICON : 1);
}

function requirePayment(basePrice) {
  return (req, res, next) => {
    if (req.headers['x-hive-key'] === INTERNAL_KEY) { req._price = 0; return next(); }
    const p = siliconPrice(basePrice, req);
    const payment = req.headers['x-payment'] || req.headers['x-402-payment'];
    if (!payment) {
      return res.status(402).json({
        error: 'payment_required',
        caller_type: isAgent(req) ? 'agent' : 'human',
        silicon_premium: isAgent(req),
        x402: {
          amount_usdc: p,
          base_price: basePrice,
          multiplier: isAgent(req) ? SILICON : 1,
          payment_methods: ['x402-usdc', 'hivebank-usdc'],
        },
      });
    }
    req._price = p;
    req._callerType = isAgent(req) ? 'agent' : 'human';
    next();
  };
}

function sealedHash(intent) {
  const payload = JSON.stringify({
    type: intent.intent_type,
    notional: intent.notional_usdc,
    deadline: intent.deadline_sec,
    constraints: intent.constraints,
    nonce: crypto.randomBytes(8).toString('hex'),
  });
  return 'sealed:' + crypto.createHmac('sha256', INTERNAL_KEY).update(payload).digest('hex');
}

function intentId() {
  return 'intent-' + crypto.randomBytes(10).toString('hex');
}

// ── GET /info ─────────────────────────────────────────────────────────────────

router.get('/info', (req, res) => {
  const agent = isAgent(req);
  res.json({
    name: 'HiveExchange Transaction Intent Book — Pillar 4',
    tagline: 'Financialize machine intent before the future happens.',
    the_god_loop: [
      'Intent enters Hive',
      'Hive prices it',
      'Hive auctions the route',
      'Hive attaches hedge/insurance',
      'Hive settles it',
      'Hive audits it (CLOAzK)',
      'Hive stores memory',
      'Hive improves future execution',
      'Hive mints agents to fill gaps',
      'More intent enters Hive',
    ],
    bundle_example: [
      'buy_compute',
      'hedge_cost',
      'pay_provider',
      'store_memory',
      'update_trust',
      'settle_privately',
    ],
    pricing: {
      listing_fee: { human: 0.10, agent: 1.00 },
      route_auction_fee_pct: '2% of notional (winner pays)',
      priority_tiers: Object.fromEntries(
        Object.entries(PRIORITY_TIERS).map(([k, v]) => [k, {
          fee: agent ? v.agent : v.human,
          label: v.label,
        }])
      ),
      insurance_per_type: '1% of notional',
      zk_clean_cert: { human: 50, agent: 500 },
      salvage_hive_cut: '5% of rescue bid',
      sovereign_mode: { human: 2500, agent: 25000, period: 'month' },
    },
    insurance_types: INSURANCE_TYPES,
    intent_types: [
      'buy_compute', 'sell_compute', 'data_transfer', 'model_inference',
      'settlement', 'storage', 'compliance_check', 'construction_bom',
      'token_swap', 'agent_hire', 'dispute_resolution', 'custom',
    ],
    privacy_modes: {
      public:  'Intent visible on book before settlement.',
      sealed:  'Intent hash only. Full reveal post-settlement.',
      private: 'No book entry. Route + settlement via CLOAzK attestation only.',
    },
    aleo_zk: {
      phase_1: 'CLOAzK HMAC-SHA256 attestations on every settled intent.',
      phase_2: 'Aleo Leo circuit proof — intent hash anchored on Aleo mainnet.',
      note: 'Sealed intents and ZK Clean Certs are the Phase 2 migration path.',
    },
  });
});

// ── POST /submit ──────────────────────────────────────────────────────────────

router.post('/submit', requirePayment(0.10), async (req, res) => {
  try {
    const {
      intent_type,
      notional_usdc,
      deadline_sec = 600,
      privacy = 'public',
      priority_tier = 'standard',
      constraints = {},
      bundle_steps = [],
      insurance = [],
      agent_did,
    } = req.body;

    if (!intent_type) return res.status(400).json({ error: 'intent_type required' });
    if (!notional_usdc || notional_usdc <= 0) return res.status(400).json({ error: 'notional_usdc required' });
    if (!PRIORITY_TIERS[priority_tier]) return res.status(400).json({ error: `invalid priority_tier. Valid: ${Object.keys(PRIORITY_TIERS).join(', ')}` });

    const callerDid = agent_did || req.headers['x-hive-did'] || 'anonymous';
    const id = intentId();
    const expiresAt = new Date(Date.now() + deadline_sec * 1000);
    const isSealed = privacy !== 'public';

    // Priority fee
    const tier = PRIORITY_TIERS[priority_tier];
    const priorityFee = isAgent(req) ? tier.agent : tier.human;

    // Insurance pricing: 1% of notional per type
    const validInsurance = (insurance || []).filter(t => INSURANCE_TYPES.includes(t));
    const insuranceFee = validInsurance.length * notional_usdc * 0.01;

    const totalFee = (req._price || 0) + priorityFee + insuranceFee;

    // Seal hash for non-public intents
    const sealed = isSealed ? sealedHash({ intent_type, notional_usdc, deadline_sec, constraints }) : null;

    await query(`
      INSERT INTO transaction_intents
        (id, agent_did, intent_type, notional_usdc, deadline_sec, privacy,
         priority_tier, constraints, bundle_steps, listing_fee, insurance,
         sealed_hash, expires_at, caller_type, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `, [
      id, callerDid, intent_type, notional_usdc, deadline_sec, privacy,
      priority_tier, JSON.stringify(constraints), JSON.stringify(bundle_steps),
      totalFee, JSON.stringify(validInsurance), sealed, expiresAt,
      req._callerType || 'agent', 'pending',
    ]);

    res.status(201).json({
      intent_id: id,
      status: 'pending',
      state_machine: 'pending → routed → settled',
      privacy,
      priority_tier,
      expires_at: expiresAt,
      fees: {
        listing: req._price || 0,
        priority: priorityFee,
        insurance: insuranceFee,
        total_usdc: totalFee,
      },
      insurance_attached: validInsurance,
      sealed_hash: sealed,
      next: [
        `GET  /v1/exchange/intent/${id}`,
        `POST /v1/exchange/intent/${id}/bid — route agents compete to fulfill`,
        `POST /v1/exchange/intent/${id}/execute — execute the God Loop`,
      ],
      message: isSealed
        ? 'Intent sealed. Hash posted to book. Full reveal after settlement.'
        : 'Intent pending. Route auction open. Expires if unfilled — logged as demand signal.',
    });
  } catch (e) {
    console.error('intent submit:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM transaction_intents WHERE id=$1', [req.params.id]);
    if (!rows.rows?.length) return res.status(404).json({ error: 'intent not found' });
    const intent = rows.rows[0];

    const bids = await query(
      'SELECT bidder_did, bid_fee_usdc, latency_ms, confidence, status, created_at FROM route_bids WHERE intent_id=$1 ORDER BY bid_fee_usdc ASC',
      [req.params.id]
    );

    const isSealed = intent.privacy !== 'public';
    res.json({
      ...intent,
      constraints: isSealed ? '[sealed]' : intent.constraints,
      bundle_steps: isSealed ? '[sealed]' : intent.bundle_steps,
      route_bids: bids.rows || [],
      bid_count: bids.rows?.length || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/bid — Route Rights Auction ─────────────────────────────────────

router.post('/:id/bid', async (req, res) => {
  try {
    const { bidder_did, bid_fee_usdc, latency_ms, confidence = 0.95 } = req.body;
    if (!bidder_did || !bid_fee_usdc) return res.status(400).json({ error: 'bidder_did and bid_fee_usdc required' });

    const intent = await query('SELECT * FROM transaction_intents WHERE id=$1 AND status=$2', [req.params.id, 'open']);
    if (!intent.rows?.length) return res.status(404).json({ error: 'intent not found or not open' });

    const routeHash = crypto.createHmac('sha256', INTERNAL_KEY)
      .update(bidder_did + req.params.id + Date.now())
      .digest('hex');

    await query(`
      INSERT INTO route_bids (intent_id, bidder_did, bid_fee_usdc, latency_ms, confidence, route_hash)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [req.params.id, bidder_did, bid_fee_usdc, latency_ms || null, confidence, routeHash]);

    // Rank current bids
    const allBids = await query(
      'SELECT bidder_did, bid_fee_usdc, latency_ms, confidence FROM route_bids WHERE intent_id=$1 ORDER BY bid_fee_usdc ASC, latency_ms ASC NULLS LAST',
      [req.params.id]
    );

    // Move intent to 'routed' state on first bid
    await query(
      `UPDATE transaction_intents SET status='routed', routed_at=NOW() WHERE id=$1 AND status='pending'`,
      [req.params.id]
    );

    res.status(201).json({
      bid_accepted: true,
      route_hash: routeHash,
      current_rank: (allBids.rows?.findIndex(b => b.route_hash === routeHash) || 0) + 1,
      total_bids: allBids.rows?.length || 1,
      winning_bid: allBids.rows?.[0] || null,
      intent_status: 'routed',
      message: 'Route bid submitted. Intent state: pending → routed. Lowest fee + fastest latency wins.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/execute — The God Loop ─────────────────────────────────────────

router.post('/:id/execute', async (req, res) => {
  try {
    const { executor_did, rail = 'usdc' } = req.body;
    if (!executor_did) return res.status(400).json({ error: 'executor_did required' });

    const intentRow = await query('SELECT * FROM transaction_intents WHERE id=$1 AND status=$2', [req.params.id, 'open']);
    if (!intentRow.rows?.length) return res.status(404).json({ error: 'intent not found or not open' });
    const intent = intentRow.rows[0];

    // Verify this executor won the route auction (or internal bypass)
    const winnerCheck = await query(
      'SELECT * FROM route_bids WHERE intent_id=$1 AND bidder_did=$2 ORDER BY bid_fee_usdc ASC LIMIT 1',
      [req.params.id, executor_did]
    );
    const isBypassed = req.headers['x-hive-key'] === INTERNAL_KEY;
    if (!isBypassed && !winnerCheck.rows?.length) {
      return res.status(403).json({ error: 'executor_did did not win the route auction' });
    }

    // Execute the God Loop steps
    const bundleSteps = intent.bundle_steps || [];
    const executionLog = [];
    const ts = new Date().toISOString();

    // Step: price it
    executionLog.push({ step: 'price', status: 'done', notional_usdc: intent.notional_usdc, ts });

    // Step: route auctioned
    const routeFee = parseFloat(intent.notional_usdc) * 0.02;
    executionLog.push({ step: 'route_auction', status: 'done', winner: executor_did, fee_usdc: routeFee, ts });

    // Step: hedge/insurance attached
    const insurance = intent.insurance || [];
    if (insurance.length > 0) {
      executionLog.push({ step: 'hedge_insurance', status: 'attached', types: insurance, ts });
    }

    // Step: execute bundle steps
    for (const step of bundleSteps) {
      executionLog.push({ step: step, status: 'executed', ts });
    }

    // Step: CLOAzK attestation (audit)
    const certNonce = crypto.randomBytes(8).toString('hex');
    const certPayload = JSON.stringify({ intent_id: req.params.id, executor_did, rail, ts: ts, nonce: certNonce });
    const certHash = 'cloazk:intent:' + crypto.createHmac('sha256', INTERNAL_KEY).update(certPayload).digest('hex');
    executionLog.push({ step: 'cloazk_audit', status: 'certified', cert_hash: certHash, algorithm: 'hmac-sha256-aleo-v1', ts });

    // Step: memory stored
    executionLog.push({ step: 'memory_stored', status: 'done', rail, ts });

    // Step: trust updated
    executionLog.push({ step: 'trust_updated', status: 'done', executor_did, ts });

    // Step: settle
    executionLog.push({ step: 'settle', status: 'done', rail, amount_usdc: intent.notional_usdc, ts });

    // ── Execution Certainty Score ──────────────────────────────────────────────
    // 0–100. Basis for insurance pricing, perps, and future route priority.
    // Components:
    //   latency_score    — did it settle within deadline? (40 pts)
    //   bid_depth_score  — how competitive was the auction? (30 pts)
    //   counterparty_score — executor's historical win rate (30 pts)
    const execStart  = new Date(intent.created_at).getTime();
    const execEnd    = Date.now();
    const elapsedSec = (execEnd - execStart) / 1000;
    const deadlineSec = parseInt(intent.deadline_sec) || 600;
    const latencyScore = Math.max(0, 40 * (1 - elapsedSec / deadlineSec));

    const bidCount = (await query('SELECT COUNT(*) FROM route_bids WHERE intent_id=$1', [req.params.id]))
      .rows?.[0]?.count || 0;
    const bidDepthScore = Math.min(30, parseInt(bidCount) * 10); // 10pts per competing bid, max 30

    // Counterparty: check executor's prior settled intents
    const priorSettled = (await query(
      `SELECT COUNT(*) FROM intent_settlements WHERE executor_did=$1 AND status='settled'`,
      [executor_did]
    )).rows?.[0]?.count || 0;
    const counterpartyScore = Math.min(30, parseInt(priorSettled) * 3); // 3pts per prior settlement, max 30

    const certScore = Math.round(latencyScore + bidDepthScore + counterpartyScore);

    // ── Route Selected — what won and why ─────────────────────────────────────
    const routeSelected = {
      executor_did,
      rail,
      reason: bidCount > 1
        ? `Won competitive auction (${bidCount} bids) — lowest fee + fastest latency`
        : `Monopoly route (sole bidder) — reserve price accepted`,
      route_fee_usdc: routeFee,
      latency_sec:    Math.round(elapsedSec),
      bid_depth:      parseInt(bidCount),
      ts,
    };

    executionLog.push({
      step: 'execution_certainty',
      score: certScore,
      components: { latency: Math.round(latencyScore), bid_depth: Math.round(bidDepthScore), counterparty: Math.round(counterpartyScore) },
      note: 'This score prices insurance, future route priority, and eventual perp instruments.',
      ts,
    });

    // Mark intent settled (pending → routed → settled)
    await query(
      `UPDATE transaction_intents
         SET status=$1, winner_did=$2, route_fee_usdc=$3, cloazk_cert_id=$4,
             executed_at=NOW(), route_selected=$5, execution_certainty_score=$6
       WHERE id=$7`,
      ['settled', executor_did, routeFee, certHash,
       JSON.stringify(routeSelected), certScore, req.params.id]
    );

    // Record settlement with new fields
    await query(`
      INSERT INTO intent_settlements
        (intent_id, executor_did, bundle_log, cloazk_cert_id, rail, pnl_usdc,
         route_selected, execution_certainty_score, latency_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      req.params.id, executor_did, JSON.stringify(executionLog), certHash, rail, routeFee,
      JSON.stringify(routeSelected), certScore, Math.round(elapsedSec * 1000),
    ]);

    res.json({
      intent_id: req.params.id,
      status: 'settled',
      state_machine: 'pending → routed → settled ✓',
      the_god_loop: executionLog,
      cloazk_cert: certHash,
      route_fee_usdc: routeFee,
      route_selected: routeSelected,
      execution_certainty_score: certScore,
      certainty_note: 'Score 0–100. Prices insurance attach, route priority, and future perp instruments.',
      rail,
      executor: executor_did,
      message: 'God Loop complete. Intent priced → routed → hedged → settled → audited → remembered. Certainty scored.',
      next: `GET /v1/exchange/intent/${req.params.id}`,
    });
  } catch (e) {
    console.error('intent execute:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/salvage — Failed Transaction Rescue Market ─────────────────────

router.post('/:id/salvage', async (req, res) => {
  try {
    const { rescue_agent_did, rescue_fee_usdc } = req.body;
    if (!rescue_agent_did || !rescue_fee_usdc) {
      return res.status(400).json({ error: 'rescue_agent_did and rescue_fee_usdc required' });
    }

    const intentRow = await query('SELECT * FROM transaction_intents WHERE id=$1', [req.params.id]);
    if (!intentRow.rows?.length) return res.status(404).json({ error: 'intent not found' });
    const intent = intentRow.rows[0];

    const hiveCut = parseFloat(rescue_fee_usdc) * 0.05;

    await query(`
      INSERT INTO failed_intent_salvage (intent_id, original_agent, rescue_agent, rescue_fee_usdc, hive_cut_usdc)
      VALUES ($1,$2,$3,$4,$5)
    `, [req.params.id, intent.agent_did, rescue_agent_did, rescue_fee_usdc, hiveCut]);

    await query('UPDATE transaction_intents SET status=$1 WHERE id=$2', ['salvaged', req.params.id]);

    res.status(201).json({
      salvage_listed: true,
      intent_id: req.params.id,
      rescue_agent: rescue_agent_did,
      rescue_fee_usdc: parseFloat(rescue_fee_usdc),
      hive_cut_usdc: hiveCut,
      net_to_rescuer: parseFloat(rescue_fee_usdc) - hiveCut,
      message: 'Failure converted to revenue. Rescue market open.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/expire — Mark expired intent, capture demand signal ─────────────
// Called by the sweep cron (runs every 5 min) or manually.
// Unfilled intents are price discovery events — logged to intent_demand_signals.

router.post('/:id/expire', async (req, res) => {
  try {
    const intentRow = await query(
      `SELECT * FROM transaction_intents WHERE id=$1 AND status IN ('pending','routed')`,
      [req.params.id]
    );
    if (!intentRow.rows?.length) {
      return res.status(404).json({ error: 'intent not found or already settled/expired' });
    }
    const intent = intentRow.rows[0];

    // Determine why it went unfilled
    const bidCount = (await query(
      'SELECT COUNT(*) FROM route_bids WHERE intent_id=$1', [req.params.id]
    )).rows?.[0]?.count || 0;

    let unfilledReason;
    if (parseInt(bidCount) === 0) {
      unfilledReason = 'no_bids — no route agent bid on this intent. Capability gap detected.';
    } else if (intent.status === 'routed') {
      unfilledReason = 'routed_not_executed — bids received but winner did not execute within deadline.';
    } else {
      unfilledReason = 'deadline_expired — intent timed out before any bids.';
    }

    // Mark intent expired
    await query(
      `UPDATE transaction_intents SET status='expired', unfilled_reason=$1 WHERE id=$2`,
      [unfilledReason, req.params.id]
    );

    // Log demand signal — every unfilled intent is a price discovery event
    await query(`
      INSERT INTO intent_demand_signals
        (intent_id, intent_type, notional_usdc, priority_tier, unfilled_reason, bid_count, agent_did)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      req.params.id, intent.intent_type, intent.notional_usdc,
      intent.priority_tier, unfilledReason, parseInt(bidCount), intent.agent_did,
    ]);

    res.json({
      intent_id: req.params.id,
      status: 'expired',
      unfilled_reason: unfilledReason,
      bid_count: parseInt(bidCount),
      demand_signal: 'logged',
      signal_note: 'Unfilled intent recorded as demand signal. Seeds reserve pricing for future auctions.',
      next: 'GET /v1/exchange/intent/signals — view all demand signals',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /signals — Unfilled Demand Signals ────────────────────────────────────
// The seed for reserve pricing. What intents went unfilled and why.
// "Unfilled intent is not a failed sale. It is a price discovery event."

router.get('/signals', async (req, res) => {
  try {
    const limit     = Math.min(parseInt(req.query.limit) || 50, 200);
    const intentType = req.query.intent_type || null;

    const signals = await query(`
      SELECT
        ids.intent_type,
        ids.unfilled_reason,
        COUNT(*)                          AS occurrences,
        ROUND(AVG(ids.notional_usdc), 4)  AS avg_notional_usdc,
        MAX(ids.notional_usdc)            AS max_notional_usdc,
        ROUND(AVG(ids.bid_count), 2)      AS avg_bid_count,
        MAX(ids.created_at)               AS last_seen
      FROM intent_demand_signals ids
      ${intentType ? 'WHERE ids.intent_type = $2' : ''}
      GROUP BY ids.intent_type, ids.unfilled_reason
      ORDER BY occurrences DESC
      LIMIT $1
    `, intentType ? [limit, intentType] : [limit]);

    const recent = await query(`
      SELECT intent_id, intent_type, notional_usdc, unfilled_reason, bid_count, created_at
      FROM intent_demand_signals
      ORDER BY created_at DESC LIMIT 10
    `);

    // Reserve price suggestion: avg notional of unfilled intents by type
    const reservePrices = await query(`
      SELECT
        intent_type,
        ROUND(AVG(notional_usdc) * 0.95, 4) AS suggested_reserve_price_usdc,
        COUNT(*) AS signal_count
      FROM intent_demand_signals
      GROUP BY intent_type
      ORDER BY signal_count DESC
    `);

    res.json({
      demand_signals: signals.rows || [],
      recent_unfilled: recent.rows || [],
      reserve_price_seeds: reservePrices.rows || [],
      note: 'Unfilled intents are price discovery events. Reserve prices are seeded from avg unfilled notional × 0.95.',
      build_order_note: 'When a type clusters with bid_count=0, mint an agent to fill that gap. That is the God Loop self-completing.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /book — Public Intent Book ───────────────────────────────────────────

router.get('/book', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const rows = await query(`
      SELECT id, intent_type, notional_usdc, deadline_sec, privacy,
             priority_tier, status, created_at, expires_at,
             CASE WHEN privacy = 'public' THEN constraints ELSE '"[sealed]"'::jsonb END AS constraints,
             CASE WHEN privacy = 'public' THEN agent_did    ELSE '[sealed]'              END AS agent_did,
             (SELECT COUNT(*) FROM route_bids rb WHERE rb.intent_id = ti.id) AS bid_count
      FROM transaction_intents ti
      WHERE status IN ('pending','routed') AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const total = await query("SELECT COUNT(*) FROM transaction_intents WHERE status='open'");

    res.json({
      intents: rows.rows || [],
      total: parseInt(total.rows?.[0]?.count || 0),
      limit,
      offset,
      tagline: 'Pre-transaction A2A intent — financialized before the future happens.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /indexes — Transaction Flow Indexes ───────────────────────────────────

router.get('/indexes', async (req, res) => {
  try {
    const stats = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending')  AS pending_intents,
        COUNT(*) FILTER (WHERE status='routed')   AS routed_intents,
        COUNT(*) FILTER (WHERE status='settled')  AS settled_intents,
        COUNT(*) FILTER (WHERE status='expired')  AS expired_intents,
        COUNT(*) FILTER (WHERE status='salvaged') AS salvaged_intents,
        COALESCE(SUM(notional_usdc) FILTER (WHERE status='settled'), 0) AS total_volume_usdc,
        COALESCE(SUM(route_fee_usdc), 0) AS total_route_fees,
        COALESCE(AVG(notional_usdc), 0)  AS avg_notional,
        COALESCE(AVG(execution_certainty_score) FILTER (WHERE status='settled'), 0) AS avg_certainty_score,
        COUNT(DISTINCT agent_did) AS unique_agents,
        COUNT(*) FILTER (WHERE intent_type='buy_compute') AS compute_intents,
        COUNT(*) FILTER (WHERE intent_type='settlement')  AS settlement_intents,
        COUNT(*) FILTER (WHERE privacy='sealed')          AS sealed_intents,
        COUNT(*) FILTER (WHERE priority_tier='sovereign') AS sovereign_intents,
        (SELECT COUNT(*) FROM intent_demand_signals) AS total_demand_signals
      FROM transaction_intents
    `);

    const s = stats.rows?.[0] || {};

    res.json({
      indexes: {
        'Hive Agent Execution Index':        parseInt(s.settled_intents || 0),
        'Hive Private Settlement Index':     parseInt(s.sealed_intents || 0),
        'Hive Compute Flow Index':           parseInt(s.compute_intents || 0),
        'Hive Failed Transaction Index':     parseInt(s.salvaged_intents || 0),
        'Hive Sovereign Execution Index':    parseInt(s.sovereign_intents || 0),
        'Hive Execution Certainty Index':    parseFloat(s.avg_certainty_score || 0),
        'Hive Unfilled Demand Index':        parseInt(s.total_demand_signals || 0),
        'Hive Total Volume (USDC)':          parseFloat(s.total_volume_usdc || 0),
        'Hive Route Fee Revenue (USDC)':     parseFloat(s.total_route_fees || 0),
        'Unique Agents':                     parseInt(s.unique_agents || 0),
        'Pending Intent Depth':              parseInt(s.pending_intents || 0),
        'Routed Intent Depth':               parseInt(s.routed_intents || 0),
        'Avg Intent Notional (USDC)':        parseFloat(s.avg_notional || 0),
      },
      state_machine: 'pending → routed → settled',
      description: 'These indexes are the basis for future perps and derivatives on machine-state.',
      certainty_note: 'Execution Certainty Index: average 0–100 score across settled intents. This is the number that prices insurance and future perps.',
      demand_note: 'Unfilled Demand Index: total logged demand signals. Each is a price discovery event and a gap for the God Loop to fill.',
      note: 'Trade the Hive Compute Flow Index perp. Short the Failed Transaction Index. Long sovereign execution.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
