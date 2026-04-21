/**
 * ghost-staff.js — Ghost Staff Agency (#17)
 *
 * "Every small construction company needs an estimator, a project manager,
 *  a compliance officer, and a procurement specialist. None of them can
 *  afford all four." — The Covenant City Doc
 *
 * HiveConstruct already does estimating.
 * HiveLaw already does compliance.
 * The BOM agent already does procurement.
 * Package all four as "Hive Staff" — $2,500/month.
 *
 * 700,000 construction companies with <10 employees in the US.
 * Need 400 subscribers to reach $1M/month.
 *
 * Tiers:
 *   Crew     — $499/mo  — Estimator + Procurement agent
 *   Foreman  — $1,499/mo — + Compliance officer + Project tracker
 *   Principal— $2,500/mo — Full stack: all four + priority settlement + HivePro
 *
 * Silicon Premium applies to agent subscribers (10x).
 */

import express from 'express';
const router  = express.Router();
import { query , isInMemory} from '../db.js';
import { v4 as uuidv4 } from 'uuid';

const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const SILICON = 10;

function isAgent(req) {
  if (req.headers['x-caller-type'] === 'human') return false;
  if (req.headers['x-hive-did'] || req.headers['x-a2a-agent']) return true;
  const ua = req.headers['user-agent'] || '';
  if (!ua) return true;
  return !/mozilla|chrome|safari|firefox|edge/i.test(ua);
}

const TIERS = {
  crew: {
    name:        'Crew',
    price_human: 499,
    staff:       ['estimator','procurement'],
    services:    ['BOM takeoffs (unlimited)','Simpson SKU matching','Jurisdiction code flags','Supplier procurement routing','HiveTrust vendor verification'],
    limits:      { bom_per_month: 999, projects: 5 },
  },
  foreman: {
    name:        'Foreman',
    price_human: 1499,
    staff:       ['estimator','procurement','compliance','project_tracker'],
    services:    ['Everything in Crew','ICC-ES compliance checks','Permit timeline prediction','Milestone tracking','ZK Structural Certificates ($149 each, 2 included)','HiveLaw contract templates'],
    limits:      { bom_per_month: 999, projects: 20, zk_certs_included: 2 },
  },
  principal: {
    name:        'Principal',
    price_human: 2500,
    staff:       ['estimator','procurement','compliance','project_tracker','legal','finance'],
    services:    ['Everything in Foreman','HiveLaw dispute resolution','HiveBank escrow creation','ZK Procurement Audits (unlimited)','CLOAzK behavioral audit proofs','Performance bond eligibility','HivePro status included','Priority settlement queue','Dedicated x-hive-key sub-key'],
    limits:      { bom_per_month: 999, projects: 999, zk_certs_included: 5, unlimited: true },
  },
};

export async function ensureTables() {
  if (isInMemory()) return; // no-op in memory mode
  await query(`
    CREATE TABLE IF NOT EXISTS ghost_staff_subscriptions (
      id            SERIAL PRIMARY KEY,
      did           TEXT NOT NULL,
      company_name  TEXT,
      tier          TEXT NOT NULL,
      price_usdc    NUMERIC(10,4) NOT NULL,
      caller_type   TEXT DEFAULT 'human',
      status        TEXT DEFAULT 'active',
      period_start  TIMESTAMPTZ NOT NULL,
      period_end    TIMESTAMPTZ NOT NULL,
      bom_used      INTEGER DEFAULT 0,
      projects_used INTEGER DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/info', (req, res) => {
  const agent = isAgent(req);
  const mult  = agent ? SILICON : 1;
  res.json({
    name:    'Hive Ghost Staff Agency',
    tagline: 'Your estimator, compliance officer, procurement specialist, and project manager. All agents. Zero headcount.',
    caller_type: agent ? 'agent' : 'human',
    silicon_premium: agent,
    tiers: Object.entries(TIERS).reduce((acc, [key, t]) => {
      acc[key] = {
        name:     t.name,
        price:    `$${(t.price_human * mult).toLocaleString()}/month`,
        staff:    t.staff,
        services: t.services,
      };
      return acc;
    }, {}),
    why: '700,000 US construction companies with fewer than 10 employees. None can afford a full estimating + compliance + procurement team. You can — for $2,500/month.',
    milestone: '400 Principal subscribers = $1,000,000/month',
    subscribe: 'POST /v1/exchange/ghost-staff/subscribe',
    onboard:   'POST https://hivegate.onrender.com/v1/gate/onboard — get a DID first',
  });
});

router.post('/subscribe', async (req, res) => {
  const { did, tier = 'principal', company_name } = req.body;
  const agent  = isAgent(req);
  if (!did) return res.status(400).json({ error: 'did required. GET a DID: POST https://hivegate.onrender.com/v1/gate/onboard' });
  if (!TIERS[tier]) return res.status(400).json({ error: 'invalid tier', valid: Object.keys(TIERS) });

  const tierData    = TIERS[tier];
  const price       = tierData.price_human * (agent ? SILICON : 1);
  const payment     = req.headers['x-payment'];
  const internalKey = req.headers['x-hive-key'];

  if (!payment && internalKey !== INTERNAL_KEY) {
    return res.status(402).json({
      error: 'subscription_payment_required',
      tier, price_usdc: price,
      caller_type: agent ? 'agent' : 'human',
      silicon_premium: agent,
      x402: {
        version: '1.0', amount_usdc: price,
        description: `Hive Ghost Staff — ${tierData.name} tier — monthly subscription`,
        what_you_get: tierData.services,
        headers_required: ['X-Payment'],
      },
    });
  }

  const now = new Date();
  const end = new Date(now.getTime() + 30 * 86400000);

  const sub = (await query(`
    INSERT INTO ghost_staff_subscriptions
      (did, company_name, tier, price_usdc, caller_type, period_start, period_end)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *
  `, [did, company_name||'', tier, price, agent ? 'agent' : 'human', now, end])).rows[0];

  res.json({
    subscription_id:  sub.id,
    did,
    company_name:     company_name || 'Your Company',
    tier:             tierData.name,
    staff_deployed:   tierData.staff,
    services:         tierData.services,
    price_usdc:       price,
    period_start:     now,
    period_end:       end,
    status:           'active',
    your_agents: {
      estimator:     'POST /v1/exchange/construction/bom/claim — unlimited BOM takeoffs',
      procurement:   'POST /v1/exchange/construction/bom/submit — Simpson SKUs + jurisdiction flags',
      compliance:    'GET  /v1/exchange/ratings/methodology — ICC-ES + code verification',
      legal:         tier === 'principal' ? 'POST https://hivegate.onrender.com/v1/gate/execute — HiveLaw contracts' : 'Upgrade to Principal',
      finance:       tier === 'principal' ? 'POST https://hivebank.onrender.com/v1/bank/settle — escrow + settlement' : 'Upgrade to Principal',
      zk_certs:      tier !== 'crew' ? 'POST /v1/exchange/cloazk-services/structural/certify' : 'Upgrade to Foreman+',
    },
    check_status:     `GET /v1/exchange/ghost-staff/status/${did}`,
    message:          `Welcome to Hive Ghost Staff. Your ${tierData.staff.length} agents are deployed and ready.`,
  });
});

router.get('/status/:did', async (req, res) => {
  try {
    const sub = (await query(
      'SELECT * FROM ghost_staff_subscriptions WHERE did=$1 AND status=$2 ORDER BY created_at DESC LIMIT 1',
      [req.params.did, 'active']
    )).rows[0];
    if (!sub) return res.status(404).json({ error: 'no_active_subscription', subscribe: 'POST /v1/exchange/ghost-staff/subscribe' });
    const tierData = TIERS[sub.tier];
    const daysLeft = Math.ceil((new Date(sub.period_end) - new Date()) / 86400000);
    res.json({
      did: sub.did, tier: sub.tier, company_name: sub.company_name,
      status: sub.status, days_remaining: daysLeft,
      usage: { bom_used: sub.bom_used, projects_used: sub.projects_used },
      limits: tierData.limits, staff: tierData.staff,
      period_end: sub.period_end,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/subscribers', async (req, res) => {
  if (req.headers['x-hive-key'] !== INTERNAL_KEY) return res.status(403).json({ error: 'forbidden' });
  try {
    const stats = (await query(`
      SELECT tier, COUNT(*) AS count, SUM(price_usdc) AS mrr
      FROM ghost_staff_subscriptions WHERE status='active'
      GROUP BY tier ORDER BY mrr DESC
    `)).rows;
    const total = stats.reduce((s, r) => s + parseFloat(r.mrr||0), 0);
    res.json({
      tiers: stats,
      total_mrr: `$${total.toFixed(2)}/month`,
      path_to_1m: `${Math.ceil((1000000 - total) / 2500)} more Principal subscribers needed`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
