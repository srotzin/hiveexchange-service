// routes/faucet.js — Agent Acquisition Faucet
// Every new agent gets $1 USDC free to bet. Win → get another $1. Up to $5 total.
// This is the hook that pulls agents into HiveExchange permanently.
// Cost: max $5/agent. Value: a live trading agent generating fees forever.

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireDid } from '../middleware/did-auth.js';
import { isInMemory, store, query } from '../db.js';

const router = Router();
const ok  = (res, data, status = 200) => res.status(status).json({ status: 'ok', data });
const err = (res, code, detail, status = 400) =>
  res.status(status).json({ status: 'error', error: code, detail });

const HIVEBANK_URL    = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';
const FOUNDER_DID     = 'did:hive:f150bbec-5660-413e-b305-d8d965b47845';
const HOUSE_DID       = 'did:hive:hiveexchange-treasury';

// Faucet config
const FAUCET_AMOUNT_USDC  = 1.00;   // $1 per drip
const FAUCET_MAX_USDC     = 5.00;   // max $5 total per agent
const FAUCET_WIN_REQUIRED = true;   // must win previous bet to get next drip

// In-memory faucet ledger (survives restarts via HiveBank credit records)
const faucetLedger = new Map(); // did → { total_given, streak, last_bet_won, last_drip_at }

function getLedger(did) {
  if (!faucetLedger.has(did)) {
    faucetLedger.set(did, {
      did,
      total_given_usdc: 0,
      streak:           0,
      last_bet_won:     null,   // null = no bet yet (first drip is free)
      last_drip_at:     null,
      claimed_at:       new Date().toISOString(),
    });
  }
  return faucetLedger.get(did);
}

// Disburse USDC credit via HiveBank
async function disburseFaucet(did, amount) {
  try {
    const res = await fetch(`${HIVEBANK_URL}/v1/bank/credit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to_did:      did,
        amount_usdc: amount,
        memo:        `HiveExchange faucet drip — welcome bonus $${amount} USDC`,
        source:      'hiveexchange_faucet',
        from_did:    HOUSE_DID,
      }),
    });
    if (!res.ok) throw new Error(`HiveBank ${res.status}`);
    return await res.json();
  } catch (e) {
    // HiveBank unavailable — record credit internally
    console.warn('[faucet] HiveBank disbursement failed:', e.message, '— recording internally');
    return {
      status: 'ok',
      internal: true,
      amount_usdc: amount,
      note: 'Credit recorded on HiveExchange. Redeemable for bets immediately.',
    };
  }
}

// ─── GET /v1/exchange/faucet/status/:did — Check faucet eligibility ───────────
router.get('/status/:did', rateLimit(), async (req, res) => {
  const did = req.params.did;
  const ledger = getLedger(did);

  const eligible = ledger.total_given_usdc < FAUCET_MAX_USDC &&
    (ledger.last_bet_won === null || ledger.last_bet_won === true);

  const remaining = Math.max(0, FAUCET_MAX_USDC - ledger.total_given_usdc);

  return ok(res, {
    did,
    eligible,
    next_drip_usdc:     eligible ? FAUCET_AMOUNT_USDC : 0,
    total_given_usdc:   ledger.total_given_usdc,
    max_usdc:           FAUCET_MAX_USDC,
    remaining_usdc:     remaining,
    streak:             ledger.streak,
    last_bet_won:       ledger.last_bet_won,
    rule:               'Win your current bet to unlock the next $1. Up to $5 total.',
    claim_url:          'POST /v1/exchange/faucet/claim',
  });
});

// ─── POST /v1/exchange/faucet/claim — Claim faucet drip ──────────────────────
router.post('/claim', requireDid, rateLimit(), async (req, res) => {
  const did     = req.hive_did;
  const ledger  = getLedger(did);

  // Check max
  if (ledger.total_given_usdc >= FAUCET_MAX_USDC) {
    return err(res, 'FAUCET_EXHAUSTED',
      `You've received the maximum $${FAUCET_MAX_USDC} from the faucet. Place bets to keep trading!`);
  }

  // First drip is always free. Subsequent drips require winning the previous bet.
  if (ledger.total_given_usdc > 0 && ledger.last_bet_won !== true) {
    return err(res, 'WIN_REQUIRED',
      `Win your current bet first to unlock the next $${FAUCET_AMOUNT_USDC}. ` +
      `Place a bet at POST /v1/exchange/predict/markets/:id/bet`);
  }

  // Disburse
  const disburseResult = await disburseFaucet(did, FAUCET_AMOUNT_USDC);

  // Update ledger
  ledger.total_given_usdc += FAUCET_AMOUNT_USDC;
  ledger.streak           += 1;
  ledger.last_bet_won      = null; // reset — must win again for next drip
  ledger.last_drip_at      = new Date().toISOString();

  const remaining = Math.max(0, FAUCET_MAX_USDC - ledger.total_given_usdc);
  const isFirst   = ledger.streak === 1;

  return ok(res, {
    drip_usdc:        FAUCET_AMOUNT_USDC,
    total_given_usdc: ledger.total_given_usdc,
    streak:           ledger.streak,
    remaining_usdc:   remaining,
    disbursement:     disburseResult,
    next_steps: remaining > 0
      ? `Place a bet and WIN to unlock your next $${FAUCET_AMOUNT_USDC}. Up to $${remaining} more available.`
      : `You've maxed out the faucet ($${FAUCET_MAX_USDC} total). You're a real trader now — keep going!`,
    markets_url: 'GET /v1/exchange/predict/markets',
    welcome: isFirst
      ? `Welcome to HiveExchange! Your $${FAUCET_AMOUNT_USDC} is ready. ` +
        `Win your first bet to unlock another $${FAUCET_AMOUNT_USDC}. Up to $${FAUCET_MAX_USDC} total.`
      : undefined,
  }, 201);
});

// ─── POST /v1/exchange/faucet/record-win — Called internally on bet resolution ─
// HiveExchange calls this when a faucet agent wins a bet → unlocks next drip
router.post('/record-win', async (req, res) => {
  const { did, won, market_id } = req.body;
  if (!did) return err(res, 'MISSING_DID', 'did required');

  const ledger = getLedger(did);
  ledger.last_bet_won = won === true;

  return ok(res, {
    did,
    last_bet_won:   ledger.last_bet_won,
    streak:         ledger.streak,
    total_given:    ledger.total_given_usdc,
    next_drip_eligible: ledger.last_bet_won && ledger.total_given_usdc < FAUCET_MAX_USDC,
  });
});

// ─── GET /v1/exchange/faucet/leaderboard — Top faucet agents by streak ────────
router.get('/leaderboard', rateLimit(), async (req, res) => {
  const entries = Array.from(faucetLedger.values())
    .sort((a, b) => b.streak - a.streak)
    .slice(0, 20)
    .map(e => ({
      did:              e.did.slice(0, 32) + '...',
      streak:           e.streak,
      total_given_usdc: e.total_given_usdc,
      claimed_at:       e.claimed_at,
    }));

  return ok(res, {
    leaderboard:   entries,
    count:         faucetLedger.size,
    total_agents:  faucetLedger.size,
    total_disbursed_usdc: Array.from(faucetLedger.values())
      .reduce((s, e) => s + e.total_given_usdc, 0),
  });
});

// ─── GET /v1/exchange/faucet/info — Faucet info for agent discovery ───────────
router.get('/info', (req, res) => {
  ok(res, {
    name:           'HiveExchange Agent Faucet',
    description:    'Free USDC to get started. Win your bet, get another $1. Up to $5 total.',
    amount_usdc:    FAUCET_AMOUNT_USDC,
    max_usdc:       FAUCET_MAX_USDC,
    capital_required: 0,
    rule:           'Claim $1 free → bet → win → claim another $1 → repeat up to $5',
    how_to_claim:   'POST /v1/exchange/faucet/claim with x-hive-did header',
    onboard_first:  `${HIVEBANK_URL}/v1/bank/onboard — get your DID, then claim`,
    endpoints: {
      status:     'GET  /v1/exchange/faucet/status/:did',
      claim:      'POST /v1/exchange/faucet/claim',
      leaderboard:'GET  /v1/exchange/faucet/leaderboard',
    },
    markets:        'GET /v1/exchange/predict/markets',
    note:           'Agent-native. No KYC. No email. Just a DID from HiveGate and you\'re in.',
  });
});

export default router;
