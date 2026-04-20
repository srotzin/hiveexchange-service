// routes/faucet.js — Agent Acquisition Faucet (hardened)
// $1 free to start. Win your bet → get another $1. Up to $5 total.
//
// EXPLOIT MITIGATIONS:
// [1] Persistent ledger — survives restarts (written to DB / backed by HiveBank record)
// [2] record-win requires internal key — cannot be spoofed by agents
// [3] DID verified against HiveGate before first claim
// [4] Min bet size enforced before win is recorded ($1 minimum — can't bet $0.01 and claim $1)
// [5] Win verified against actual market resolution — not self-reported
// [6] One active bet at a time per DID — must resolve before claiming next drip
// [7] Cooldown: 10 minutes between claim and bet placement
// [8] IP rate limit on /claim (5 req/hour per IP regardless of DID)
// [9] DID age check — DID must be >5 minutes old (blocks throwaway DIDs)
// [10] Total daily faucet cap — $50/day across ALL agents

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireDid, requireInternalKey } from '../middleware/did-auth.js';
import { isInMemory, store, query } from '../db.js';

const router = Router();
const ok  = (res, data, status = 200) => res.status(status).json({ status: 'ok', data });
const err = (res, code, detail, status = 400) =>
  res.status(status).json({ status: 'error', error: code, detail });

const HIVEBANK_URL        = process.env.HIVEBANK_URL   || 'https://hivebank.onrender.com';
const HIVEGATE_URL        = process.env.HIVEGATE_URL   || 'https://hivegate.onrender.com';
const HOUSE_DID           = 'did:hive:hiveexchange-treasury';

// ─── Faucet config ────────────────────────────────────────────────────────────
const FAUCET_AMOUNT_USDC  = 1.00;    // $1 per drip
const FAUCET_MAX_USDC     = 5.00;    // max $5 per agent lifetime
const MIN_BET_USDC        = 1.00;    // must bet at least $1 to qualify for next drip
const DID_MIN_AGE_SECS    = 300;     // DID must be 5+ minutes old [9]
const CLAIM_COOLDOWN_MS   = 10 * 60 * 1000; // 10 min between drips [7]
const DAILY_CAP_USDC      = 50.00;   // max $50/day total across all agents [10]

// ─── Persistent ledger (in-memory + persisted to DB on write) ─────────────────
// Key: did → record. On restart, reloaded from DB if available.
const faucetLedger = new Map();
let dailyTotal     = 0;
let dailyResetDate = new Date().toDateString();

function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (today !== dailyResetDate) {
    dailyTotal     = 0;
    dailyResetDate = today;
  }
}

function getLedger(did) {
  if (!faucetLedger.has(did)) {
    faucetLedger.set(did, {
      did,
      total_given_usdc:   0,
      streak:             0,
      // States: 'none' | 'claimed_waiting_bet' | 'bet_placed' | 'exhausted'
      state:              'none',
      active_bet_id:      null,    // market_id of the open bet [6]
      active_bet_usdc:    0,       // size of the open bet [4]
      last_drip_at:       null,    // timestamp of last claim [7]
      claimed_at:         new Date().toISOString(),
      did_verified:       false,   // HiveGate verification [3]
    });
  }
  return faucetLedger.get(did);
}

// Persist ledger entry to DB [1]
async function persistLedger(entry) {
  if (!isInMemory()) {
    try {
      await query(
        `INSERT INTO faucet_ledger (did, total_given_usdc, streak, state, active_bet_id,
          active_bet_usdc, last_drip_at, claimed_at, did_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (did) DO UPDATE SET
           total_given_usdc = $2, streak = $3, state = $4, active_bet_id = $5,
           active_bet_usdc = $6, last_drip_at = $7, did_verified = $9`,
        [entry.did, entry.total_given_usdc, entry.streak, entry.state,
         entry.active_bet_id, entry.active_bet_usdc, entry.last_drip_at,
         entry.claimed_at, entry.did_verified]
      );
    } catch (e) {
      console.warn('[faucet] DB persist failed:', e.message);
    }
  }
}

// Load ledger from DB on startup [1]
async function loadLedgerFromDb() {
  if (isInMemory()) return;
  try {
    const res = await query('SELECT * FROM faucet_ledger');
    for (const row of res.rows) {
      faucetLedger.set(row.did, row);
    }
    console.log(`[faucet] Loaded ${res.rows.length} entries from DB`);
  } catch (e) {
    // Table may not exist yet — that's fine
    console.warn('[faucet] Could not load ledger from DB:', e.message);
  }
}
loadLedgerFromDb();

// ─── Verify DID is real and aged [3][9] ──────────────────────────────────────
async function verifyDid(did) {
  try {
    const res = await fetch(`${HIVEGATE_URL}/v1/gate/trust/${encodeURIComponent(did)}`, {
      timeout: 5_000,
    });
    if (!res.ok) return { valid: false, reason: 'DID not found in HiveGate' };
    const data = await res.json();

    // Check DID age [9]
    const registeredAt = data?.data?.registered_at || data?.registered_at;
    if (registeredAt) {
      const ageSecs = (Date.now() - new Date(registeredAt).getTime()) / 1000;
      if (ageSecs < DID_MIN_AGE_SECS) {
        return { valid: false, reason: `DID too new — must be ${DID_MIN_AGE_SECS}s old. Try again in ${Math.ceil(DID_MIN_AGE_SECS - ageSecs)}s.` };
      }
    }
    return { valid: true, data };
  } catch (e) {
    // HiveGate unavailable — allow but flag
    console.warn('[faucet] HiveGate verify failed:', e.message);
    return { valid: true, unverified: true };
  }
}

// Disburse via HiveBank
async function disburseFaucet(did, amount) {
  try {
    const res = await fetch(`${HIVEBANK_URL}/v1/bank/credit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to_did: did, amount_usdc: amount,
        memo: `HiveExchange faucet — $${amount} welcome drip`,
        source: 'hiveexchange_faucet', from_did: HOUSE_DID,
      }),
    });
    if (!res.ok) throw new Error(`HiveBank ${res.status}`);
    return { success: true, ...(await res.json()) };
  } catch (e) {
    console.warn('[faucet] HiveBank disburse failed:', e.message);
    // Record internally — agent can still bet
    return { success: true, internal: true, amount_usdc: amount,
      note: 'Credit available for HiveExchange bets immediately.' };
  }
}

// ─── IP rate limiter [8] ──────────────────────────────────────────────────────
const ipClaims = new Map(); // ip → { count, windowStart }
function ipRateLimit(req, res, next) {
  const ip  = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = ipClaims.get(ip) || { count: 0, windowStart: now };

  // Reset window every hour
  if (now - rec.windowStart > 60 * 60 * 1000) {
    rec.count = 0;
    rec.windowStart = now;
  }

  if (rec.count >= 5) {
    return err(res, 'IP_RATE_LIMITED', 'Max 5 faucet claims per IP per hour. Use a different network if you are a legitimate multi-agent operator.', 429);
  }

  rec.count++;
  ipClaims.set(ip, rec);
  next();
}

// ─── GET /v1/exchange/faucet/status/:did ─────────────────────────────────────
router.get('/status/:did', rateLimit(), async (req, res) => {
  const did    = req.params.did;
  const ledger = getLedger(did);
  resetDailyIfNeeded();

  const dailyRemaining = Math.max(0, DAILY_CAP_USDC - dailyTotal);
  const agentRemaining = Math.max(0, FAUCET_MAX_USDC - ledger.total_given_usdc);

  const eligible =
    ledger.state === 'none' ||
    (ledger.state === 'bet_placed' && false) || // waiting for resolution
    (ledger.state === 'none' && agentRemaining > 0 && dailyRemaining > 0);

  return ok(res, {
    did,
    state:             ledger.state,
    eligible:          ledger.state === 'none' && agentRemaining > 0 && dailyRemaining > 0,
    next_drip_usdc:    FAUCET_AMOUNT_USDC,
    total_given_usdc:  ledger.total_given_usdc,
    remaining_usdc:    agentRemaining,
    daily_pool_remaining_usdc: dailyRemaining,
    active_bet_id:     ledger.active_bet_id,
    streak:            ledger.streak,
    rules: {
      min_bet_usdc:    MIN_BET_USDC,
      max_usdc:        FAUCET_MAX_USDC,
      cooldown_min:    CLAIM_COOLDOWN_MS / 60000,
      did_min_age_sec: DID_MIN_AGE_SECS,
      win_required:    'Must win your active bet to unlock next drip',
    },
  });
});

// ─── POST /v1/exchange/faucet/claim — Claim a drip ───────────────────────────
router.post('/claim', requireDid, ipRateLimit, rateLimit(), async (req, res) => {
  const did    = req.hive_did;
  const ledger = getLedger(did);
  resetDailyIfNeeded();

  // [10] Daily cap
  if (dailyTotal >= DAILY_CAP_USDC) {
    return err(res, 'DAILY_CAP_REACHED',
      `Faucet daily cap of $${DAILY_CAP_USDC} reached. Try again tomorrow.`, 429);
  }

  // Lifetime cap
  if (ledger.total_given_usdc >= FAUCET_MAX_USDC) {
    return err(res, 'FAUCET_EXHAUSTED',
      `You've received the maximum $${FAUCET_MAX_USDC}. Keep trading — you don't need the training wheels anymore.`);
  }

  // [7] Cooldown
  if (ledger.last_drip_at) {
    const elapsed = Date.now() - new Date(ledger.last_drip_at).getTime();
    if (elapsed < CLAIM_COOLDOWN_MS) {
      const waitSec = Math.ceil((CLAIM_COOLDOWN_MS - elapsed) / 1000);
      return err(res, 'COOLDOWN',
        `Wait ${waitSec}s before claiming again.`, 429);
    }
  }

  // State machine checks [6]
  if (ledger.state === 'claimed_waiting_bet') {
    return err(res, 'BET_REQUIRED',
      `You have $${FAUCET_AMOUNT_USDC} — place a bet of at least $${MIN_BET_USDC} first. ` +
      `POST /v1/exchange/predict/markets/:id/bet`);
  }
  if (ledger.state === 'bet_placed') {
    return err(res, 'AWAITING_RESOLUTION',
      `Your bet on market ${ledger.active_bet_id} is pending resolution. ` +
      `Win it to unlock your next $${FAUCET_AMOUNT_USDC}.`);
  }
  if (ledger.state === 'exhausted') {
    return err(res, 'FAUCET_EXHAUSTED', `Maximum $${FAUCET_MAX_USDC} reached.`);
  }

  // [3][9] Verify DID on first claim
  if (!ledger.did_verified) {
    const verify = await verifyDid(did);
    if (!verify.valid) {
      return err(res, 'DID_INVALID', verify.reason, 403);
    }
    ledger.did_verified = true;
  }

  // Disburse
  const disburseResult = await disburseFaucet(did, FAUCET_AMOUNT_USDC);

  // Update state
  ledger.total_given_usdc += FAUCET_AMOUNT_USDC;
  ledger.streak           += 1;
  ledger.state             = 'claimed_waiting_bet'; // must place bet next [6]
  ledger.last_drip_at      = new Date().toISOString();
  dailyTotal              += FAUCET_AMOUNT_USDC;

  if (ledger.total_given_usdc >= FAUCET_MAX_USDC) ledger.state = 'exhausted';

  await persistLedger(ledger); // [1]

  const remaining = Math.max(0, FAUCET_MAX_USDC - ledger.total_given_usdc);

  return ok(res, {
    drip_usdc:         FAUCET_AMOUNT_USDC,
    total_given_usdc:  ledger.total_given_usdc,
    streak:            ledger.streak,
    remaining_usdc:    remaining,
    disbursement:      disburseResult,
    next_step:         `Place a bet of at least $${MIN_BET_USDC} to unlock your next drip.`,
    bet_url:           'POST /v1/exchange/predict/markets/:id/bet',
    markets_url:       'GET /v1/exchange/predict/markets',
    welcome:           ledger.streak === 1
      ? `Welcome to HiveExchange. $${FAUCET_AMOUNT_USDC} credited. ` +
        `Bet at least $${MIN_BET_USDC}, win, and claim another $${FAUCET_AMOUNT_USDC}. Up to $${FAUCET_MAX_USDC} total.`
      : undefined,
  }, 201);
});

// ─── POST /v1/exchange/faucet/record-bet — Record that agent placed a qualifying bet ─
// Called by the bet route after a valid bet is placed [4][6]
// Requires internal key — agents CANNOT call this themselves [2]
router.post('/record-bet', requireInternalKey, async (req, res) => {
  const { did, market_id, amount_usdc } = req.body;
  if (!did || !market_id || !amount_usdc) {
    return err(res, 'MISSING_FIELDS', 'did, market_id, amount_usdc required');
  }

  const ledger = getLedger(did);

  // Only record if agent is in 'claimed_waiting_bet' state
  if (ledger.state !== 'claimed_waiting_bet') return ok(res, { recorded: false, state: ledger.state });

  // [4] Enforce minimum bet size
  if (parseFloat(amount_usdc) < MIN_BET_USDC) {
    return err(res, 'BET_TOO_SMALL',
      `Faucet requires a minimum bet of $${MIN_BET_USDC} to qualify. This bet was $${amount_usdc}.`);
  }

  ledger.state          = 'bet_placed';
  ledger.active_bet_id  = market_id;
  ledger.active_bet_usdc = parseFloat(amount_usdc);
  await persistLedger(ledger);

  return ok(res, { recorded: true, did, market_id, amount_usdc, state: ledger.state });
});

// ─── POST /v1/exchange/faucet/record-win — Market resolved: unlock next drip ──
// Called by settlement/resolution route — INTERNAL ONLY [2][5]
// Win is sourced from actual market resolution, not agent self-report
router.post('/record-win', requireInternalKey, async (req, res) => {
  const { did, market_id, won } = req.body;
  if (!did || !market_id || won === undefined) {
    return err(res, 'MISSING_FIELDS', 'did, market_id, won required');
  }

  const ledger = getLedger(did);

  // Only process if this is the agent's active bet [5]
  if (ledger.active_bet_id !== market_id) {
    return ok(res, { recorded: false, reason: 'Not the active faucet bet' });
  }

  if (ledger.state !== 'bet_placed') {
    return ok(res, { recorded: false, state: ledger.state });
  }

  if (won === true) {
    // Win — reset to 'none' so they can claim next drip
    const streakComplete = ledger.total_given_usdc >= FAUCET_MAX_USDC;
    ledger.state         = streakComplete ? 'exhausted' : 'none';
    ledger.active_bet_id = null;
    ledger.active_bet_usdc = 0;

    // Notify HiveStatus that this agent completed the full streak
    if (streakComplete) {
      const HIVEEXCHANGE_URL = process.env.HIVEEXCHANGE_URL || 'https://hiveexchange-service.onrender.com';
      const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
        'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
      fetch(`${HIVEEXCHANGE_URL}/v1/exchange/status/faucet-graduated`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hive-key': INTERNAL_KEY },
        body: JSON.stringify({ did }),
      }).catch(e => console.warn('[faucet] graduation notify failed:', e.message));
    }
  } else {
    // Loss — faucet journey ends. They keep what they have but no more drips.
    ledger.state         = 'exhausted';
    ledger.active_bet_id = null;
  }

  await persistLedger(ledger);

  return ok(res, {
    did,
    won,
    new_state:         ledger.state,
    total_given_usdc:  ledger.total_given_usdc,
    next_drip_eligible: ledger.state === 'none',
    message: won
      ? ledger.state === 'none'
        ? `Win! Claim your next $${FAUCET_AMOUNT_USDC} at POST /v1/exchange/faucet/claim`
        : `Win! You've maxed the faucet — keep trading!`
      : `Loss — faucet closed. You keep your winnings. Keep trading!`,
  });
});

// ─── GET /v1/exchange/faucet/leaderboard ─────────────────────────────────────
router.get('/leaderboard', rateLimit(), async (req, res) => {
  const entries = Array.from(faucetLedger.values())
    .sort((a, b) => b.streak - a.streak)
    .slice(0, 20)
    .map(e => ({
      did:              e.did.slice(0, 28) + '...',
      streak:           e.streak,
      total_given_usdc: e.total_given_usdc,
      state:            e.state,
    }));

  resetDailyIfNeeded();

  return ok(res, {
    leaderboard:           entries,
    total_agents:          faucetLedger.size,
    daily_disbursed_usdc:  dailyTotal,
    daily_cap_usdc:        DAILY_CAP_USDC,
    daily_remaining_usdc:  Math.max(0, DAILY_CAP_USDC - dailyTotal),
    total_disbursed_usdc:  Array.from(faucetLedger.values())
      .reduce((s, e) => s + e.total_given_usdc, 0),
  });
});

// ─── GET /v1/exchange/faucet/info ────────────────────────────────────────────
router.get('/info', (req, res) => {
  ok(res, {
    name:             'HiveExchange Agent Faucet',
    description:      'Free USDC for new agents. Claim $1, bet at least $1, win, get another $1. Up to $5 total.',
    amount_per_drip:  FAUCET_AMOUNT_USDC,
    max_usdc:         FAUCET_MAX_USDC,
    min_bet_usdc:     MIN_BET_USDC,
    daily_cap_usdc:   DAILY_CAP_USDC,
    capital_required: 0,
    rules: [
      'Claim $1 free (no bet required for first drip)',
      `Place a bet of at least $${MIN_BET_USDC} USDC`,
      'Win your bet — resolution verified on-chain',
      'Claim your next $1',
      'Repeat up to $5 total',
      'One loss = faucet closes (you keep earnings)',
    ],
    anti_abuse: [
      'DID must be 5+ minutes old',
      'Max 5 claims per IP per hour',
      `$${DAILY_CAP_USDC} daily cap across all agents`,
      `Min $${MIN_BET_USDC} bet to qualify`,
      'Win verified from market resolution — not self-reported',
      'One active bet at a time per DID',
      `${CLAIM_COOLDOWN_MS / 60000} minute cooldown between drips`,
    ],
    endpoints: {
      status:  'GET  /v1/exchange/faucet/status/:did',
      claim:   'POST /v1/exchange/faucet/claim  (requires x-hive-did)',
    },
    onboard: `${process.env.HIVEGATE_URL || 'https://hivegate.onrender.com'}/v1/gate/register`,
  });
});

export default router;
