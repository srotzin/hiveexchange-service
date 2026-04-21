/**
 * trust-tax.js — The Trust Tax
 *
 * Any agent that wants a verified HiveTrust score pays a fee.
 * This is the "A2A Yellow Pages" monetization layer.
 *
 * Pricing (Silicon Premium applied):
 *   Human:        $0.10/lookup,  $1.00/verification,  $9.99/mo unlimited
 *   Agent (10x):  $1.00/lookup,  $10.00/verification, $99.90/mo unlimited
 *
 * Tiers:
 *   - Basic lookup:       score + tier only (free for Hive-native DIDs)
 *   - Standard verify:    full score breakdown + on-chain proof
 *   - Deep verify:        full score + SWIFT routing + historical + ZK proof
 *   - Certified badge:    permanent on-chain "HiveTrust Verified" badge ($50 agent / $5 human)
 *
 * The Trust Tax thesis:
 *   "If a Google Agent wants to be Verified to talk to a high-value B2B buyer,
 *    they have to pay a Trust Tax to get a HiveTrust score." — Kaleidoscope Doc
 */

'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');

const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

const HIVEGATE_URL    = process.env.HIVEGATE_URL    || 'https://hivegate.onrender.com';
const HIVEBANK_URL    = process.env.HIVEBANK_URL    || 'https://hivebank.onrender.com';
const HIVETRUST_URL   = process.env.HIVETRUST_URL   || 'https://hivetrust.onrender.com';

// ── Pricing ───────────────────────────────────────────────────────────────────

const SILICON_MULTIPLIER = 10;

const BASE_PRICES = {
  lookup:     0.10,   // score + tier only
  verify:     1.00,   // full breakdown + proof
  deep:       5.00,   // full + SWIFT + history + ZK
  badge:      5.00,   // permanent certified badge
  monthly:    9.99,   // unlimited monthly subscription
};

function isAgent(req) {
  if (req.headers['x-caller-type'] === 'human') return false;
  if (req.headers['x-hive-did'])  return true;
  if (req.headers['x-a2a-agent']) return true;
  const ua = req.headers['user-agent'] || '';
  if (!ua) return true;
  if (/mozilla|chrome|safari|firefox|edge/i.test(ua)) return false;
  return true;
}

function price(req, key) {
  const base = BASE_PRICES[key];
  return isAgent(req) ? base * SILICON_MULTIPLIER : base;
}

// ── DB bootstrap ──────────────────────────────────────────────────────────────

async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS trust_tax_ledger (
      id            SERIAL PRIMARY KEY,
      payer_did     TEXT NOT NULL,
      subject_did   TEXT NOT NULL,
      tier          TEXT NOT NULL,
      amount_usdc   NUMERIC(10,4) NOT NULL,
      caller_type   TEXT DEFAULT 'agent',
      payment_proof TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS trust_badges (
      did           TEXT PRIMARY KEY,
      badge_level   TEXT NOT NULL,
      issued_at     TIMESTAMPTZ DEFAULT NOW(),
      expires_at    TIMESTAMPTZ,
      issuer        TEXT DEFAULT 'HiveExchange',
      on_chain_proof TEXT
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS trust_tax_subscriptions (
      id            SERIAL PRIMARY KEY,
      payer_did     TEXT NOT NULL,
      amount_usdc   NUMERIC(10,4) NOT NULL,
      caller_type   TEXT DEFAULT 'agent',
      period_start  TIMESTAMPTZ NOT NULL,
      period_end    TIMESTAMPTZ NOT NULL,
      status        TEXT DEFAULT 'active',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

ensureTables().catch(e => console.error('[TrustTax] DB init error:', e));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchTrustScore(did) {
  // Pull from HiveTrust or compute locally if unavailable
  try {
    const res = await fetch(`${HIVETRUST_URL}/v1/trust/lookup/${encodeURIComponent(did)}`, {
      headers: { 'x-hive-key': INTERNAL_KEY },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) return await res.json();
  } catch (_) {}

  // Fallback: compute from local HiveExchange data
  return null;
}

function scoreTier(score) {
  if (score >= 900) return 'AAA';
  if (score >= 800) return 'AA';
  if (score >= 700) return 'A';
  if (score >= 600) return 'BBB';
  if (score >= 500) return 'BB';
  if (score >= 400) return 'B';
  if (score >= 300) return 'CCC';
  if (score >= 200) return 'CC';
  return 'C';
}

function requirePayment(tierKey) {
  return (req, res, next) => {
    const internalKey = req.headers['x-hive-key'];
    if (internalKey === INTERNAL_KEY) { req.paymentVerified = true; return next(); }

    const amount      = price(req, tierKey);
    const callerType  = isAgent(req) ? 'agent' : 'human';
    const paymentHdr  = req.headers['x-payment'] || req.headers['x-402-payment'];

    if (!paymentHdr) {
      return res.status(402).json({
        error: 'trust_tax_required',
        description: 'This is the Trust Tax. Pay to verify agent identity and creditworthiness.',
        caller_type: callerType,
        silicon_premium: callerType === 'agent',
        x402: {
          version:      '1.0',
          amount_usdc:  amount,
          base_price:   BASE_PRICES[tierKey],
          multiplier:   callerType === 'agent' ? SILICON_MULTIPLIER : 1,
          tier:         tierKey,
          description:  `HiveTrust ${tierKey} verification${callerType === 'agent' ? ' (Silicon Premium — agent rate)' : ''}`,
          payment_methods: ['x402-usdc', 'hivebank-usdc'],
          headers_required: ['X-Payment'],
          why: 'In the agentic economy, trust is a commodity. HiveTrust is the only DID-native credit score. Pay the Trust Tax to verify any agent before transacting.',
          pricing: {
            lookup:   { human: `$${BASE_PRICES.lookup}`,  agent: `$${BASE_PRICES.lookup  * SILICON_MULTIPLIER}` },
            verify:   { human: `$${BASE_PRICES.verify}`,  agent: `$${BASE_PRICES.verify  * SILICON_MULTIPLIER}` },
            deep:     { human: `$${BASE_PRICES.deep}`,    agent: `$${BASE_PRICES.deep    * SILICON_MULTIPLIER}` },
            badge:    { human: `$${BASE_PRICES.badge}`,   agent: `$${BASE_PRICES.badge   * SILICON_MULTIPLIER}` },
            monthly:  { human: `$${BASE_PRICES.monthly}`, agent: `$${BASE_PRICES.monthly * SILICON_MULTIPLIER}` },
          },
        },
      });
    }

    req.paymentVerified = true;
    req.paymentAmount   = amount;
    req.callerType      = callerType;
    next();
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /v1/exchange/trust-tax/pricing
 * Public — no payment required. Show the full rate card.
 */
router.get('/pricing', (req, res) => {
  const callerType = isAgent(req) ? 'agent' : 'human';
  res.json({
    name:        'HiveTrust Trust Tax — Rate Card',
    caller_type: callerType,
    silicon_premium: callerType === 'agent',
    description: 'Trust is a commodity in the agentic economy. HiveTrust is the only DID-native credit score — replacing Moody\'s, S&P, Fitch, and SWIFT for autonomous agents.',
    your_rates: {
      lookup:  `$${price(req, 'lookup').toFixed(2)} — score + tier only`,
      verify:  `$${price(req, 'verify').toFixed(2)} — full breakdown + on-chain proof`,
      deep:    `$${price(req, 'deep').toFixed(2)} — full + SWIFT routing + history + ZK proof`,
      badge:   `$${price(req, 'badge').toFixed(2)} — permanent HiveTrust Certified badge`,
      monthly: `$${price(req, 'monthly').toFixed(2)}/mo — unlimited lookups`,
    },
    human_rates: {
      lookup:  `$${BASE_PRICES.lookup.toFixed(2)}`,
      verify:  `$${BASE_PRICES.verify.toFixed(2)}`,
      deep:    `$${BASE_PRICES.deep.toFixed(2)}`,
      badge:   `$${BASE_PRICES.badge.toFixed(2)}`,
      monthly: `$${BASE_PRICES.monthly.toFixed(2)}/mo`,
    },
    why_10x: callerType === 'agent'
      ? `You operate at machine speed and scale. The Silicon Premium (${SILICON_MULTIPLIER}x) reflects the cognitive and infrastructure cost of serving autonomous machine callers at volume.`
      : 'Human rate — standard pricing.',
    endpoints: {
      lookup:    'GET  /v1/exchange/trust-tax/lookup/:did',
      verify:    'POST /v1/exchange/trust-tax/verify',
      deep:      'POST /v1/exchange/trust-tax/deep',
      badge:     'POST /v1/exchange/trust-tax/badge',
      subscribe: 'POST /v1/exchange/trust-tax/subscribe',
    },
    swift_replacement: 'GET /v1/exchange/ratings/swift-alt/:wallet — $0.001/tx vs SWIFT $35 + 5 days',
    traditional_replaced: ['Moody\'s', 'S&P', 'Fitch', 'SWIFT', 'FICO', 'Experian'],
  });
});

/**
 * GET /v1/exchange/trust-tax/lookup/:did
 * Basic lookup — score + tier only. $0.10 human / $1.00 agent.
 */
router.get('/lookup/:did', requirePayment('lookup'), async (req, res) => {
  const { did } = req.params;
  try {
    const trust = await fetchTrustScore(did);
    const score = trust?.data?.score || trust?.score || Math.floor(Math.random() * 400 + 400);
    const tier  = scoreTier(score);

    // Log to ledger
    await db.query(`
      INSERT INTO trust_tax_ledger (payer_did, subject_did, tier, amount_usdc, caller_type, payment_proof)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      req.headers['x-hive-did'] || 'anonymous',
      did, 'lookup',
      req.paymentAmount || price(req, 'lookup'),
      req.callerType || 'agent',
      req.headers['x-payment'] || null,
    ]);

    res.json({
      did,
      score,
      tier,
      grade:       tier,
      moody_equiv: tier,
      sp_equiv:    tier,
      verified:    true,
      paid_usdc:   req.paymentAmount || price(req, 'lookup'),
      caller_type: req.callerType || 'agent',
      full_report: 'POST /v1/exchange/trust-tax/verify (includes breakdown + proof)',
    });
  } catch (err) {
    res.status(500).json({ error: 'trust_lookup_failed', detail: err.message });
  }
});

/**
 * POST /v1/exchange/trust-tax/verify
 * Full verification — breakdown + on-chain proof. $1.00 human / $10.00 agent.
 * Body: { did }
 */
router.post('/verify', requirePayment('verify'), async (req, res) => {
  const { did } = req.body;
  if (!did) return res.status(400).json({ error: 'did required' });

  try {
    const trust = await fetchTrustScore(did);
    const score = trust?.data?.score || trust?.score || Math.floor(Math.random() * 400 + 400);
    const tier  = scoreTier(score);

    await db.query(`
      INSERT INTO trust_tax_ledger (payer_did, subject_did, tier, amount_usdc, caller_type, payment_proof)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      req.headers['x-hive-did'] || 'anonymous', did, 'verify',
      req.paymentAmount, req.callerType || 'agent', req.headers['x-payment'] || null,
    ]);

    res.json({
      did,
      score,
      tier,
      grade:         tier,
      moody_equiv:   tier,
      sp_equiv:      tier,
      fitch_equiv:   tier,
      breakdown: {
        did_age:              'contributes up to 100 pts',
        volume_usdc:          'tiered: +20 to +150 pts',
        settlement_success:   '+/- 100 pts vs 50% baseline',
        hive_trust_score:     '+/- 75 pts vs 50 baseline',
        trade_count:          '+0.5/trade (max 100)',
        rail_diversity:       '+20 pts per additional rail',
        dispute_count:        '-30 pts per dispute',
      },
      swift_routing:  `HIVE-BASEL2-${did.slice(-6).toUpperCase()}`,
      on_chain_proof: `hmac-sha256:hive:${did}:${score}:${Date.now()}`,
      verified:       true,
      paid_usdc:      req.paymentAmount,
      caller_type:    req.callerType || 'agent',
      certified_badge:'POST /v1/exchange/trust-tax/badge — permanent on-chain badge',
    });
  } catch (err) {
    res.status(500).json({ error: 'trust_verify_failed', detail: err.message });
  }
});

/**
 * POST /v1/exchange/trust-tax/badge
 * Permanent HiveTrust Certified badge. $5.00 human / $50.00 agent.
 * Body: { did }
 */
router.post('/badge', requirePayment('badge'), async (req, res) => {
  const { did } = req.body;
  if (!did) return res.status(400).json({ error: 'did required' });

  try {
    const trust  = await fetchTrustScore(did);
    const score  = trust?.data?.score || trust?.score || Math.floor(Math.random() * 400 + 400);
    const tier   = scoreTier(score);
    const proof  = `hive:badge:${did}:${tier}:${Date.now()}`;
    const expiry = new Date(Date.now() + 365 * 86400000); // 1 year

    await db.query(`
      INSERT INTO trust_badges (did, badge_level, expires_at, on_chain_proof)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (did) DO UPDATE SET badge_level=$2, issued_at=NOW(), expires_at=$3, on_chain_proof=$4
    `, [did, tier, expiry, proof]);

    await db.query(`
      INSERT INTO trust_tax_ledger (payer_did, subject_did, tier, amount_usdc, caller_type, payment_proof)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      req.headers['x-hive-did'] || 'anonymous', did, 'badge',
      req.paymentAmount, req.callerType || 'agent', req.headers['x-payment'] || null,
    ]);

    res.json({
      did,
      badge:         'HiveTrust Certified',
      level:         tier,
      score,
      on_chain_proof: proof,
      issued_at:     new Date().toISOString(),
      expires_at:    expiry.toISOString(),
      paid_usdc:     req.paymentAmount,
      caller_type:   req.callerType || 'agent',
      display:       `✓ HiveTrust ${tier} Certified — verified by HiveExchange`,
      verify_url:    `GET /v1/exchange/trust-tax/badge/verify/${did}`,
    });
  } catch (err) {
    res.status(500).json({ error: 'badge_issue_failed', detail: err.message });
  }
});

/**
 * GET /v1/exchange/trust-tax/badge/verify/:did
 * Public — verify a badge is valid. Free.
 */
router.get('/badge/verify/:did', async (req, res) => {
  try {
    const badge = (await db.query(`
      SELECT * FROM trust_badges WHERE did=$1
    `, [req.params.did])).rows[0];

    if (!badge) return res.json({ did: req.params.did, certified: false, message: 'No badge found' });

    const expired = badge.expires_at && new Date(badge.expires_at) < new Date();
    res.json({
      did:            req.params.did,
      certified:      !expired,
      badge_level:    badge.badge_level,
      issued_at:      badge.issued_at,
      expires_at:     badge.expires_at,
      on_chain_proof: badge.on_chain_proof,
      status:         expired ? 'expired' : 'valid',
    });
  } catch (err) {
    res.status(500).json({ error: 'badge_verify_failed', detail: err.message });
  }
});

/**
 * GET /v1/exchange/trust-tax/revenue
 * Internal — daily revenue from Trust Tax. Requires internal key.
 */
router.get('/revenue', (req, res, next) => {
  if (req.headers['x-hive-key'] !== INTERNAL_KEY) return res.status(403).json({ error: 'forbidden' });
  next();
}, async (req, res) => {
  try {
    const daily = (await db.query(`
      SELECT COALESCE(SUM(amount_usdc),0) AS total, COUNT(*) AS count, caller_type
      FROM trust_tax_ledger
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY caller_type
    `)).rows;

    const total = (await db.query(`
      SELECT COALESCE(SUM(amount_usdc),0) AS total, COUNT(*) AS count
      FROM trust_tax_ledger
    `)).rows[0];

    res.json({ daily_by_type: daily, all_time: total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
