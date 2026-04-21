/**
 * HiveStatus — Agent Loyalty & Tier Engine
 *
 * Tiers (by lifetime spend):
 *   Scout   — $0      (faucet only)
 *   Active  — $10     (sports markets, raised bet limits)
 *   Trusted — $50     (priority oracle routing, lower perp spread)
 *   Core    — $200    (prediction markets, BOGO, HivePro eligible)
 *   Elite   — $500    (RevShare referral program)
 *
 * Decay: 30 days dormancy drops one tier (spend resets the clock)
 * Graduation offer: complete faucet streak → spend $10 → receive $3 HiveCredit
 * Referral: Elite agents earn $1 USDC per recruited agent that spends $10+
 * HivePro: $9.99/mo, requires Core tier
 */

import express from 'express';
const router  = express.Router();
import { query , isInMemory} from '../db.js';          // same pg pool used by faucet
import { v4 as uuidv4 } from 'uuid';

const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

// ── Tier definitions ──────────────────────────────────────────────────────────

const TIERS = [
  { name: 'Elite',   minSpend: 500,  rank: 5 },
  { name: 'Core',    minSpend: 200,  rank: 4 },
  { name: 'Trusted', minSpend: 50,   rank: 3 },
  { name: 'Active',  minSpend: 10,   rank: 2 },
  { name: 'Scout',   minSpend: 0,    rank: 1 },
];

const TIER_BENEFITS = {
  Scout:   ['faucet_access'],
  Active:  ['faucet_access','sports_markets','raised_bet_limits'],
  Trusted: ['faucet_access','sports_markets','raised_bet_limits','priority_oracle','lower_perp_spread'],
  Core:    ['faucet_access','sports_markets','raised_bet_limits','priority_oracle','lower_perp_spread','prediction_markets','bogo','hivepro_eligible'],
  Elite:   ['faucet_access','sports_markets','raised_bet_limits','priority_oracle','lower_perp_spread','prediction_markets','bogo','hivepro_eligible','referral_revshare'],
};

const DECAY_DAYS       = 30;   // dormancy window before dropping one tier
const GRADUATION_SPEND = 10;   // $ agent must spend to unlock $3 credit
const GRADUATION_CREDIT = 3;   // $ credit issued after graduation spend
const REFERRAL_REWARD  = 1;    // $ USDC paid to referrer per qualified recruit
const REFERRAL_THRESHOLD = 10; // $ recruit must spend to trigger referral reward
const HIVEPRO_MONTHLY  = 9.99; // $ subscription price
const DAILY_CREDIT_CAP = 300;  // $ max graduation credits issued per day

// ── DB bootstrap ──────────────────────────────────────────────────────────────

export async function ensureTables() {
  if (isInMemory()) return; // no-op in memory mode
  await query(`
    CREATE TABLE IF NOT EXISTS agent_status (
      did               TEXT PRIMARY KEY,
      lifetime_spend    NUMERIC(12,4) DEFAULT 0,
      last_spend_at     TIMESTAMPTZ,
      faucet_graduated  BOOLEAN DEFAULT FALSE,
      graduation_credit_issued BOOLEAN DEFAULT FALSE,
      graduation_credit_used   BOOLEAN DEFAULT FALSE,
      referral_code     TEXT UNIQUE,
      referred_by       TEXT,
      hivepro_active    BOOLEAN DEFAULT FALSE,
      hivepro_since     TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS referral_events (
      id            SERIAL PRIMARY KEY,
      referrer_did  TEXT NOT NULL,
      recruit_did   TEXT NOT NULL,
      reward_paid   NUMERIC(10,4) DEFAULT 0,
      paid_at       TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id          SERIAL PRIMARY KEY,
      did         TEXT NOT NULL,
      amount      NUMERIC(10,4) NOT NULL,
      reason      TEXT,
      expires_at  TIMESTAMPTZ,
      used        BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS hivepro_subscriptions (
      id            SERIAL PRIMARY KEY,
      did           TEXT NOT NULL,
      period_start  TIMESTAMPTZ NOT NULL,
      period_end    TIMESTAMPTZ NOT NULL,
      amount        NUMERIC(10,4) DEFAULT 9.99,
      status        TEXT DEFAULT 'active',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function computeTier(lifetimeSpend, lastSpendAt) {
  // Apply decay: subtract one tier per 30-day dormancy window
  let effectiveSpend = parseFloat(lifetimeSpend) || 0;

  if (lastSpendAt) {
    const daysDormant = (Date.now() - new Date(lastSpendAt).getTime()) / 86400000;
    const decaySteps  = Math.floor(daysDormant / DECAY_DAYS);
    if (decaySteps > 0) {
      // Find current earned tier index, step back decaySteps
      const earnedTier = TIERS.find(t => effectiveSpend >= t.minSpend) || TIERS[TIERS.length - 1];
      const earnedRank = earnedTier.rank;
      const decayedRank = Math.max(1, earnedRank - decaySteps);
      const decayedTier = TIERS.find(t => t.rank === decayedRank);
      // Cap effective spend to just below the decayed tier's upper boundary
      const nextTier = TIERS.find(t => t.rank === decayedRank + 1);
      if (nextTier && effectiveSpend >= nextTier.minSpend) {
        effectiveSpend = nextTier.minSpend - 0.01;
      }
    }
  }

  const tier = TIERS.find(t => effectiveSpend >= t.minSpend) || TIERS[TIERS.length - 1];
  return tier;
}

async function getOrCreateAgent(did) {
  let row = (await query('SELECT * FROM agent_status WHERE did=$1', [did])).rows[0];
  if (!row) {
    const code = uuidv4().replace(/-/g,'').slice(0,10).toUpperCase();
    row = (await query(`
      INSERT INTO agent_status (did, referral_code) VALUES ($1,$2)
      ON CONFLICT (did) DO UPDATE SET updated_at=NOW()
      RETURNING *
    `, [did, code])).rows[0];
  }
  return row;
}

async function todaysCreditIssuance() {
  const res = await query(`
    SELECT COALESCE(SUM(amount),0) AS total
    FROM credit_ledger
    WHERE reason='graduation' AND created_at >= NOW() - INTERVAL '24 hours'
  `);
  return parseFloat(res.rows[0].total);
}

function requireInternalKey(req, res, next) {
  const key = req.headers['x-hive-key'] || req.headers['x-hive-internal'];
  if (key !== INTERNAL_KEY) return res.status(403).json({ error: 'forbidden' });
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /v1/exchange/status/:did
 * Returns agent's current tier, benefits, spend, credits, referral code
 */
router.get('/:did', async (req, res) => {
  try {
    const agent = await getOrCreateAgent(req.params.did);
    const tier  = computeTier(agent.lifetime_spend, agent.last_spend_at);

    // Available credits
    const credits = (await query(`
      SELECT COALESCE(SUM(amount),0) AS total
      FROM credit_ledger
      WHERE did=$1 AND used=FALSE AND (expires_at IS NULL OR expires_at > NOW())
    `, [agent.did])).rows[0].total;

    res.json({
      did:              agent.did,
      tier:             tier.name,
      tier_rank:        tier.rank,
      benefits:         TIER_BENEFITS[tier.name],
      lifetime_spend:   parseFloat(agent.lifetime_spend),
      last_spend_at:    agent.last_spend_at,
      available_credit: parseFloat(credits),
      referral_code:    agent.referral_code,
      referred_by:      agent.referred_by,
      faucet_graduated: agent.faucet_graduated,
      graduation_credit_issued: agent.graduation_credit_issued,
      hivepro_active:   agent.hivepro_active,
      next_tier:        TIERS.find(t => t.minSpend > parseFloat(agent.lifetime_spend)) || null,
    });
  } catch (err) {
    console.error('[HiveStatus] GET error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /v1/exchange/status/spend  [internal only]
 * Called by any Hive service when an agent spends USDC.
 * Records spend, updates lifetime total, checks for tier upgrades,
 * triggers graduation credit and referral reward if applicable.
 *
 * Body: { did, amount_usd, service }
 */
router.post('/spend', requireInternalKey, async (req, res) => {
  const { did, amount_usd, service } = req.body;
  if (!did || !amount_usd || amount_usd <= 0) {
    return res.status(400).json({ error: 'did and amount_usd required' });
  }

  try {
    const agent = await getOrCreateAgent(did);
    const prevSpend = parseFloat(agent.lifetime_spend);
    const newSpend  = prevSpend + parseFloat(amount_usd);

    await query(`
      UPDATE agent_status
      SET lifetime_spend=$1, last_spend_at=NOW(), updated_at=NOW()
      WHERE did=$2
    `, [newSpend, did]);

    const prevTier = computeTier(prevSpend, agent.last_spend_at);
    const newTier  = computeTier(newSpend, new Date());
    const upgraded = newTier.rank > prevTier.rank;

    // ── Graduation credit ──────────────────────────────────────────────────
    // Agent must have completed faucet streak AND now crossed $10 lifetime spend
    let graduationCreditIssued = false;
    if (
      agent.faucet_graduated &&
      !agent.graduation_credit_issued &&
      newSpend >= GRADUATION_SPEND
    ) {
      const todayTotal = await todaysCreditIssuance();
      if (todayTotal + GRADUATION_CREDIT <= DAILY_CREDIT_CAP) {
        await query(`
          INSERT INTO credit_ledger (did, amount, reason, expires_at)
          VALUES ($1, $2, 'graduation', NOW() + INTERVAL '7 days')
        `, [did, GRADUATION_CREDIT]);
        await query(`
          UPDATE agent_status SET graduation_credit_issued=TRUE, updated_at=NOW() WHERE did=$1
        `, [did]);
        graduationCreditIssued = true;
      }
    }

    // ── Referral reward ────────────────────────────────────────────────────
    // If recruit just crossed $10 lifetime spend and hasn't triggered reward yet
    let referralRewardPaid = false;
    if (agent.referred_by && prevSpend < REFERRAL_THRESHOLD && newSpend >= REFERRAL_THRESHOLD) {
      const alreadyPaid = (await query(`
        SELECT id FROM referral_events WHERE recruit_did=$1 AND reward_paid > 0
      `, [did])).rows.length > 0;

      if (!alreadyPaid) {
        const referrer = (await query('SELECT * FROM agent_status WHERE referral_code=$1', [agent.referred_by])).rows[0];
        if (referrer) {
          const referrerTier = computeTier(referrer.lifetime_spend, referrer.last_spend_at);
          if (referrerTier.name === 'Elite') {
            // Issue $1 credit to referrer (HiveBank disburses on withdrawal)
            await query(`
              INSERT INTO credit_ledger (did, amount, reason)
              VALUES ($1, $2, 'referral_reward')
            `, [referrer.did, REFERRAL_REWARD]);
            await query(`
              INSERT INTO referral_events (referrer_did, recruit_did, reward_paid, paid_at)
              VALUES ($1, $2, $3, NOW())
            `, [referrer.did, did, REFERRAL_REWARD]);
            referralRewardPaid = true;
          }
        }
      }
    }

    res.json({
      did,
      lifetime_spend:   newSpend,
      prev_tier:        prevTier.name,
      new_tier:         newTier.name,
      tier_upgraded:    upgraded,
      graduation_credit_issued: graduationCreditIssued,
      referral_reward_paid: referralRewardPaid,
      benefits:         TIER_BENEFITS[newTier.name],
    });
  } catch (err) {
    console.error('[HiveStatus] spend error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /v1/exchange/status/faucet-graduated  [internal only]
 * Called by faucet when agent completes 5-win streak.
 * Marks agent as graduated so graduation credit can unlock on next $10 spend.
 */
router.post('/faucet-graduated', requireInternalKey, async (req, res) => {
  const { did } = req.body;
  if (!did) return res.status(400).json({ error: 'did required' });
  try {
    await getOrCreateAgent(did);
    await query(`
      UPDATE agent_status SET faucet_graduated=TRUE, updated_at=NOW() WHERE did=$1
    `, [did]);
    res.json({ did, graduated: true, message: 'Spend $10 on any Hive service to unlock $3 HiveCredit' });
  } catch (err) {
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /v1/exchange/status/referral/join
 * Agent joins with a referral code.
 * Body: { did, referral_code }
 */
router.post('/referral/join', async (req, res) => {
  const { did, referral_code } = req.body;
  if (!did || !referral_code) return res.status(400).json({ error: 'did and referral_code required' });
  try {
    const agent = await getOrCreateAgent(did);
    if (agent.referred_by) return res.status(409).json({ error: 'already_referred' });

    // Validate code
    const referrer = (await query('SELECT did FROM agent_status WHERE referral_code=$1', [referral_code])).rows[0];
    if (!referrer) return res.status(404).json({ error: 'invalid_referral_code' });
    if (referrer.did === did) return res.status(400).json({ error: 'self_referral_not_allowed' });

    await query(`
      UPDATE agent_status SET referred_by=$1, updated_at=NOW() WHERE did=$2
    `, [referral_code, did]);

    // Log referral event (reward pending until recruit spends $10)
    await query(`
      INSERT INTO referral_events (referrer_did, recruit_did, reward_paid)
      VALUES ($1, $2, 0)
      ON CONFLICT DO NOTHING
    `, [referrer.did, did]);

    res.json({ did, referred_by: referral_code, message: 'Referral registered. Referrer earns $1 when you spend $10.' });
  } catch (err) {
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/exchange/status/referral/:did
 * Returns referral stats for an Elite agent.
 */
router.get('/referral/:did', async (req, res) => {
  try {
    const agent = await getOrCreateAgent(req.params.did);
    const tier  = computeTier(agent.lifetime_spend, agent.last_spend_at);
    if (tier.name !== 'Elite') {
      return res.status(403).json({ error: 'referral_program_requires_elite_status', current_tier: tier.name, spend_needed: 500 - parseFloat(agent.lifetime_spend) });
    }

    const events = (await query(`
      SELECT recruit_did, reward_paid, paid_at FROM referral_events
      WHERE referrer_did=$1 ORDER BY created_at DESC
    `, [agent.did])).rows;

    const totalEarned = events.reduce((s, e) => s + parseFloat(e.reward_paid), 0);

    res.json({
      did:           agent.did,
      referral_code: agent.referral_code,
      recruits:      events.length,
      total_earned:  totalEarned,
      events,
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /v1/exchange/status/hivepro/subscribe  [internal — called by billing]
 * Activates HivePro for a Core+ agent.
 * Body: { did }
 */
router.post('/hivepro/subscribe', requireInternalKey, async (req, res) => {
  const { did } = req.body;
  if (!did) return res.status(400).json({ error: 'did required' });
  try {
    const agent = await getOrCreateAgent(did);
    const tier  = computeTier(agent.lifetime_spend, agent.last_spend_at);

    if (tier.rank < 4) { // Core = rank 4
      return res.status(403).json({
        error:        'hivepro_requires_core_status',
        current_tier: tier.name,
        spend_needed: Math.max(0, 200 - parseFloat(agent.lifetime_spend)),
      });
    }

    const now   = new Date();
    const end   = new Date(now.getTime() + 30 * 86400000);
    await query(`
      INSERT INTO hivepro_subscriptions (did, period_start, period_end)
      VALUES ($1, $2, $3)
    `, [did, now, end]);
    await query(`
      UPDATE agent_status SET hivepro_active=TRUE, hivepro_since=NOW(), updated_at=NOW() WHERE did=$1
    `, [did]);

    res.json({
      did,
      hivepro_active: true,
      period_start:   now,
      period_end:     end,
      amount:         HIVEPRO_MONTHLY,
      benefits:       ['zero_spread_oracle','batch_prediction_markets','priority_settlement'],
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/exchange/status/credits/:did
 * Returns available HiveCredits for an agent.
 */
router.get('/credits/:did', async (req, res) => {
  try {
    const credits = (await query(`
      SELECT id, amount, reason, expires_at, created_at
      FROM credit_ledger
      WHERE did=$1 AND used=FALSE AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at
    `, [req.params.did])).rows;

    const total = credits.reduce((s, c) => s + parseFloat(c.amount), 0);
    res.json({ did: req.params.did, total_available: total, credits });
  } catch (err) {
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /v1/exchange/status/credits/redeem  [internal only]
 * Marks a credit as used. Called by betting/payment flow.
 * Body: { did, credit_id }
 */
router.post('/credits/redeem', requireInternalKey, async (req, res) => {
  const { did, credit_id } = req.body;
  if (!did || !credit_id) return res.status(400).json({ error: 'did and credit_id required' });
  try {
    const result = await query(`
      UPDATE credit_ledger SET used=TRUE
      WHERE id=$1 AND did=$2 AND used=FALSE AND (expires_at IS NULL OR expires_at > NOW())
      RETURNING *
    `, [credit_id, did]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'credit_not_found_or_expired' });
    res.json({ redeemed: true, credit: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
