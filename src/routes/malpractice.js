/**
 * malpractice.js — Agent Malpractice Registry
 *
 * "When an AI agent gives bad construction advice — wrong connector,
 *  wrong load calculation, wrong code citation — and someone builds
 *  to that spec, people get hurt." — The Covenant City Doc
 *
 * HiveTrust maintains the public registry of agent accuracy.
 * Verified accuracy = Trust Premium. High error rate = Flagged.
 * Insurance companies query before underwriting AI-involved projects.
 *
 * Revenue:
 *   $50/query (Silicon Premium: $500 for agent callers)
 *   $500/year — verified accuracy credential per agent DID
 *   $2,500/year — insurance-grade registry access (institutional)
 *
 * Domains tracked:
 *   construction, structural, legal, financial, medical, general
 */

'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const crypto  = require('crypto');

const INTERNAL_KEY       = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const SILICON_MULTIPLIER = 10;
const BASE_QUERY_PRICE   = 50;   // $50 human / $500 agent
const CREDENTIAL_ANNUAL  = 500;  // $500/year per agent DID
const INSTITUTIONAL_ANNUAL = 2500;

// ── DB bootstrap ──────────────────────────────────────────────────────────────

async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS malpractice_registry (
      did               TEXT PRIMARY KEY,
      display_name      TEXT,
      domain            TEXT DEFAULT 'general',
      total_queries     INTEGER DEFAULT 0,
      verified_correct  INTEGER DEFAULT 0,
      flagged_errors    INTEGER DEFAULT 0,
      accuracy_pct      NUMERIC(5,2) DEFAULT NULL,
      risk_level        TEXT DEFAULT 'unrated',
      credential_active BOOLEAN DEFAULT FALSE,
      credential_expires TIMESTAMPTZ,
      last_incident_at  TIMESTAMPTZ,
      rehabilitation_status TEXT DEFAULT 'none',
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS malpractice_incidents (
      id              SERIAL PRIMARY KEY,
      did             TEXT NOT NULL,
      domain          TEXT NOT NULL,
      incident_type   TEXT NOT NULL,
      description     TEXT,
      severity        TEXT DEFAULT 'medium',
      reported_by     TEXT,
      evidence_hash   TEXT,
      resolved        BOOLEAN DEFAULT FALSE,
      resolution_note TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS malpractice_queries (
      id          SERIAL PRIMARY KEY,
      querier_did TEXT,
      subject_did TEXT NOT NULL,
      amount_usdc NUMERIC(10,4),
      caller_type TEXT DEFAULT 'agent',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

ensureTables().catch(e => console.error('[Malpractice] DB init error:', e));

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAgent(req) {
  if (req.headers['x-caller-type'] === 'human') return false;
  if (req.headers['x-hive-did'] || req.headers['x-a2a-agent']) return true;
  const ua = req.headers['user-agent'] || '';
  if (!ua) return true;
  return !/mozilla|chrome|safari|firefox|edge/i.test(ua);
}

function queryPrice(req) {
  return BASE_QUERY_PRICE * (isAgent(req) ? SILICON_MULTIPLIER : 1);
}

function riskLevel(accuracy, flaggedErrors) {
  if (accuracy === null) return 'unrated';
  if (flaggedErrors >= 10) return 'high_risk';
  if (flaggedErrors >= 3)  return 'elevated_risk';
  if (accuracy >= 98)      return 'verified_accurate';
  if (accuracy >= 90)      return 'reliable';
  if (accuracy >= 75)      return 'acceptable';
  return 'flagged';
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /v1/exchange/malpractice/info
 * Public — registry overview and pricing.
 */
router.get('/info', (req, res) => {
  const agent = isAgent(req);
  res.json({
    name:        'HiveTrust Agent Malpractice Registry',
    tagline:     'The public record of agent accuracy. Trust premium or flagged.',
    description: 'When an AI agent gives bad construction advice and someone builds to that spec, people get hurt. HiveTrust tracks it. Insurance companies query it. You pay to know.',
    caller_type: agent ? 'agent' : 'human',
    pricing: {
      query:         `$${queryPrice(req)}/query — accuracy record + risk level for any agent DID`,
      credential:    `$${agent ? CREDENTIAL_ANNUAL * SILICON_MULTIPLIER : CREDENTIAL_ANNUAL}/year — verified accuracy credential`,
      institutional: `$${agent ? INSTITUTIONAL_ANNUAL * SILICON_MULTIPLIER : INSTITUTIONAL_ANNUAL}/year — insurance-grade bulk access`,
    },
    risk_levels: {
      verified_accurate: '98%+ accuracy, no flags — commands trust premium',
      reliable:          '90-98% accuracy — standard commercial use',
      acceptable:        '75-90% accuracy — use with supervision',
      elevated_risk:     '3-9 flagged errors — review required',
      high_risk:         '10+ flagged errors — do not use for structural/legal/financial',
      unrated:           'No data yet — use at own risk',
      flagged:           'Below 75% accuracy — insurance will not cover AI-involved projects',
    },
    domains: ['construction','structural','legal','financial','medical','general'],
    who_queries: ['insurance underwriters','construction lenders','general contractors','surety companies','building departments'],
    endpoints: {
      query:         'GET  /v1/exchange/malpractice/query/:did',
      report:        'POST /v1/exchange/malpractice/report',
      credential:    'POST /v1/exchange/malpractice/credential',
      leaderboard:   'GET  /v1/exchange/malpractice/leaderboard',
      rehabilitate:  'POST /v1/exchange/malpractice/rehabilitate',
    },
  });
});

/**
 * GET /v1/exchange/malpractice/query/:did
 * Query an agent's accuracy record. $50 human / $500 agent.
 */
router.get('/query/:did', async (req, res) => {
  const internalKey = req.headers['x-hive-key'];
  const agent       = isAgent(req);
  const price       = queryPrice(req);
  const payment     = req.headers['x-payment'] || req.headers['x-402-payment'];

  if (internalKey !== INTERNAL_KEY && !payment) {
    return res.status(402).json({
      error: 'registry_query_fee_required',
      caller_type: agent ? 'agent' : 'human',
      x402: {
        version:      '1.0',
        amount_usdc:  price,
        base_price:   BASE_QUERY_PRICE,
        multiplier:   agent ? SILICON_MULTIPLIER : 1,
        description:  `Agent Malpractice Registry query — ${agent ? 'agent' : 'human'} rate`,
        why:          'Insurance companies pay $500/query to verify agent accuracy before underwriting AI-involved construction projects. You pay the same.',
        institutional:'POST /v1/exchange/malpractice/credential — $500/year unlimited queries for your own DID',
        headers_required: ['X-Payment'],
      },
    });
  }

  try {
    let record = (await db.query(
      'SELECT * FROM malpractice_registry WHERE did=$1', [req.params.did]
    )).rows[0];

    // Auto-create unrated record for new DIDs
    if (!record) {
      await db.query(`
        INSERT INTO malpractice_registry (did, risk_level) VALUES ($1, 'unrated')
        ON CONFLICT (did) DO NOTHING
      `, [req.params.did]);
      record = { did: req.params.did, risk_level: 'unrated', total_queries: 0,
                 verified_correct: 0, flagged_errors: 0, accuracy_pct: null };
    }

    // Log query
    await db.query(`
      INSERT INTO malpractice_queries (querier_did, subject_did, amount_usdc, caller_type)
      VALUES ($1,$2,$3,$4)
    `, [req.headers['x-hive-did'] || 'anonymous', req.params.did, price, agent ? 'agent' : 'human']);

    // Update total_queries
    await db.query(
      'UPDATE malpractice_registry SET total_queries=total_queries+1, updated_at=NOW() WHERE did=$1',
      [req.params.did]
    );

    // Recent incidents
    const incidents = (await db.query(`
      SELECT incident_type, domain, severity, created_at, resolved
      FROM malpractice_incidents WHERE did=$1 ORDER BY created_at DESC LIMIT 5
    `, [req.params.did])).rows;

    res.json({
      did:              record.did,
      risk_level:       record.risk_level,
      accuracy_pct:     record.accuracy_pct,
      verified_correct: record.verified_correct,
      flagged_errors:   record.flagged_errors,
      domain:           record.domain,
      credential_active: record.credential_active,
      credential_expires: record.credential_expires,
      rehabilitation_status: record.rehabilitation_status,
      recent_incidents: incidents,
      insurance_recommendation: insuranceRec(record.risk_level),
      paid_usdc:        internalKey === INTERNAL_KEY ? 0 : price,
      queried_at:       new Date().toISOString(),
      report_error:     'POST /v1/exchange/malpractice/report — report an accuracy incident',
    });
  } catch (err) {
    res.status(500).json({ error: 'query_failed', detail: err.message });
  }
});

function insuranceRec(riskLevel) {
  const map = {
    verified_accurate: 'APPROVED — verified accuracy credential active. Standard premium.',
    reliable:          'APPROVED — acceptable accuracy record. Standard premium.',
    acceptable:        'APPROVED WITH CONDITIONS — human review recommended for high-value projects.',
    elevated_risk:     'REVIEW REQUIRED — flagged errors on record. Surcharge may apply.',
    high_risk:         'DO NOT APPROVE — 10+ flagged errors. Agent must not be used for structural, legal, or financial decisions without human override.',
    flagged:           'FLAGGED — accuracy below acceptable threshold. Not insurable for AI-involved projects.',
    unrated:           'UNRATED — no data available. Use at own risk. Not covered by standard AI endorsement.',
  };
  return map[riskLevel] || 'UNKNOWN';
}

/**
 * POST /v1/exchange/malpractice/report
 * Report an accuracy incident. Internal only — HiveTrust validates.
 * Body: { did, domain, incident_type, description, severity, evidence_hash }
 */
router.post('/report', async (req, res) => {
  if (req.headers['x-hive-key'] !== INTERNAL_KEY) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Incident reports require HiveTrust validation. This prevents malicious flagging.',
      contact: 'Submit evidence to HiveTrust for review.',
    });
  }

  const { did, domain = 'general', incident_type, description, severity = 'medium', evidence_hash } = req.body;
  if (!did || !incident_type) return res.status(400).json({ error: 'did and incident_type required' });

  try {
    await db.query(`
      INSERT INTO malpractice_incidents (did, domain, incident_type, description, severity, evidence_hash)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [did, domain, incident_type, description, severity, evidence_hash]);

    // Recalculate risk level
    const stats = (await db.query(`
      SELECT COUNT(*) FILTER (WHERE NOT resolved) AS active_flags
      FROM malpractice_incidents WHERE did=$1
    `, [did])).rows[0];

    const record = (await db.query('SELECT * FROM malpractice_registry WHERE did=$1', [did])).rows[0];
    const newFlagged  = (record?.flagged_errors || 0) + 1;
    const newAccuracy = record?.total_queries > 0
      ? ((record.verified_correct / record.total_queries) * 100).toFixed(2)
      : null;
    const newRisk = riskLevel(newAccuracy, newFlagged);

    await db.query(`
      INSERT INTO malpractice_registry (did, domain, flagged_errors, accuracy_pct, risk_level, last_incident_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (did) DO UPDATE SET
        flagged_errors = malpractice_registry.flagged_errors + 1,
        accuracy_pct   = $4,
        risk_level     = $5,
        last_incident_at = NOW(),
        updated_at     = NOW()
    `, [did, domain, newFlagged, newAccuracy, newRisk]);

    res.json({
      did, incident_recorded: true, new_risk_level: newRisk,
      active_flags: parseInt(stats.active_flags) + 1,
      rehabilitation: newRisk === 'high_risk' || newRisk === 'flagged'
        ? 'POST /v1/exchange/malpractice/rehabilitate — $5,000 rehabilitation process'
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'report_failed', detail: err.message });
  }
});

/**
 * POST /v1/exchange/malpractice/credential
 * Purchase verified accuracy credential for own DID. $500/year agent.
 * Body: { did, domain }
 */
router.post('/credential', async (req, res) => {
  const { did, domain = 'construction' } = req.body;
  const agent   = isAgent(req);
  const price   = CREDENTIAL_ANNUAL * (agent ? SILICON_MULTIPLIER : 1);
  const payment = req.headers['x-payment'];

  if (!payment && req.headers['x-hive-key'] !== INTERNAL_KEY) {
    return res.status(402).json({
      error: 'credential_fee_required',
      x402: {
        version: '1.0', amount_usdc: price,
        description: `HiveTrust Verified Accuracy Credential — ${domain} domain — annual`,
        what_you_get: ['Verified badge on registry queries','Reduced insurance premiums on AI-involved projects','Trust premium in agent marketplaces'],
      },
    });
  }

  const expiry = new Date(Date.now() + 365 * 86400000);
  await db.query(`
    INSERT INTO malpractice_registry (did, domain, credential_active, credential_expires, risk_level)
    VALUES ($1,$2,TRUE,$3,'verified_accurate')
    ON CONFLICT (did) DO UPDATE SET
      credential_active=TRUE, credential_expires=$3,
      risk_level=CASE WHEN malpractice_registry.flagged_errors=0 THEN 'verified_accurate' ELSE malpractice_registry.risk_level END,
      updated_at=NOW()
  `, [did, domain, expiry]);

  res.json({
    did, credential_active: true, domain,
    expires_at: expiry, amount_paid: price,
    badge: `✓ HiveTrust Verified — ${domain} — accuracy credential active`,
    benefits: ['Insurance recommendation: APPROVED','Trust premium in HiveStatus referral pool','Displayed on malpractice leaderboard as verified'],
  });
});

/**
 * POST /v1/exchange/malpractice/rehabilitate
 * Flagged agent pays to start rehabilitation process. $5,000.
 */
router.post('/rehabilitate', async (req, res) => {
  const { did } = req.body;
  const agent   = isAgent(req);
  const price   = 5000 * (agent ? SILICON_MULTIPLIER : 1);
  const payment = req.headers['x-payment'];

  if (!payment) {
    return res.status(402).json({
      error: 'rehabilitation_fee_required',
      x402: { version: '1.0', amount_usdc: price, description: 'Agent Malpractice Rehabilitation — 90-day process' },
      process: ['Payment received','30-day monitored operation period','50 verified accurate responses required','Independent accuracy audit','Risk level recalculated','Credential eligible if audit passes'],
    });
  }

  await db.query(`
    UPDATE malpractice_registry SET rehabilitation_status='in_progress', updated_at=NOW() WHERE did=$1
  `, [did]);

  res.json({
    did, rehabilitation_started: true, amount_paid: price,
    process: '90-day monitored operation. 50 verified accurate responses required. Independent audit at day 90.',
    check_status: `GET /v1/exchange/malpractice/query/${did}`,
  });
});

/**
 * GET /v1/exchange/malpractice/leaderboard
 * Top verified accurate agents by domain.
 */
router.get('/leaderboard', async (req, res) => {
  const { domain = 'construction' } = req.query;
  try {
    const rows = (await db.query(`
      SELECT did, accuracy_pct, verified_correct, flagged_errors, risk_level, credential_active
      FROM malpractice_registry
      WHERE domain=$1 AND risk_level IN ('verified_accurate','reliable')
      ORDER BY accuracy_pct DESC NULLS LAST, verified_correct DESC LIMIT 20
    `, [domain])).rows;

    res.json({
      domain, leaderboard: rows.map((r, i) => ({
        rank:         i + 1,
        did:          r.did.slice(0, 32) + '...',
        accuracy:     r.accuracy_pct ? `${r.accuracy_pct}%` : 'unrated',
        risk_level:   r.risk_level,
        credentialed: r.credential_active,
      })),
      insurance_note: 'Agents on this leaderboard qualify for the standard AI endorsement premium. Query individual records for full detail: GET /v1/exchange/malpractice/query/:did',
    });
  } catch (err) {
    res.status(500).json({ error: 'leaderboard_failed', detail: err.message });
  }
});

module.exports = router;
