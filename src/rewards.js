// rewards.js — Fire $1 ladder rewards to HiveBank
// Fire-and-forget: NEVER blocks trade/settle responses
// Bulletproof: retry with backoff, circuit breaker, idempotency keys, full DNA

const HIVEBANK_URL = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';
const HIVE_INTERNAL_KEY = 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

// ─── In-memory circuit breaker ────────────────────────────────────────────────
// Prevents hammering HiveBank if it's cold-starting
const breaker = {
  failures: 0,
  lastFailure: 0,
  THRESHOLD: 3,        // open after 3 consecutive failures
  RESET_MS: 60_000,    // try again after 60s
  isOpen() {
    if (this.failures < this.THRESHOLD) return false;
    if (Date.now() - this.lastFailure > this.RESET_MS) {
      this.failures = 0; // half-open: let one through
      return false;
    }
    return true;
  },
  recordSuccess() { this.failures = 0; },
  recordFailure() { this.failures++; this.lastFailure = Date.now(); },
};

// ─── In-memory dedup — prevents double-fire on hot reload ────────────────────
const firedSet = new Set(); // "did:trigger" — clears on restart, DB handles persistent dedup

function idemKey(did, trigger, refId = '') {
  return `${did}:${trigger}:${refId}`;
}

// ─── Core fire function — retries up to 3x with exponential backoff ───────────
async function fireReward({ did, wallet_address, trigger, ref_id = null }, attempt = 1) {
  const key = idemKey(did, trigger, ref_id || '');

  // In-memory dedup (fast path — avoids network call)
  if (firedSet.has(key)) {
    console.log(`[rewards] dedup (in-memory): ${key}`);
    return;
  }

  if (breaker.isOpen()) {
    console.warn(`[rewards] circuit open — queuing ${key} for retry`);
    setTimeout(() => fireReward({ did, wallet_address, trigger, ref_id }, 1), 30_000);
    return;
  }

  const payload = {
    did,
    wallet_address,
    trigger,
    ref_id: ref_id || null,
    // Idempotency key — HiveBank uses this to prevent duplicate payouts across restarts
    _idem: `${key}:${Math.floor(Date.now() / 60000)}`, // 1-minute window
  };

  try {
    const res = await fetch(`${HIVEBANK_URL}/v1/bank/rewards/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hive-internal': HIVE_INTERNAL_KEY,
        'x-hive-did': did,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000),
    });

    const body = await res.json().catch(() => ({}));

    if (res.status === 200 || res.status === 201) {
      breaker.recordSuccess();
      firedSet.add(key); // mark fired
      if (body.already_claimed) {
        console.log(`[rewards] already claimed: ${key}`);
      } else {
        console.log(`[rewards] ✓ $1 fired: did=${did} trigger=${trigger} tx=${body.tx_hash || 'n/a'}`);
      }
      return body;
    }

    if (res.status === 429) {
      // Max rewards reached — log and stop retrying
      console.log(`[rewards] cap reached: ${key} (${body.detail})`);
      firedSet.add(key);
      return;
    }

    // Server error — retry
    throw new Error(`HiveBank ${res.status}: ${JSON.stringify(body).slice(0, 120)}`);

  } catch (err) {
    breaker.recordFailure();
    console.error(`[rewards] attempt ${attempt} failed: ${key} — ${err.message}`);

    if (attempt < 3) {
      const delay = attempt * 4_000; // 4s, 8s
      console.log(`[rewards] retrying in ${delay}ms...`);
      setTimeout(() => fireReward({ did, wallet_address, trigger, ref_id }, attempt + 1), delay);
    } else {
      console.error(`[rewards] gave up after 3 attempts: ${key}`);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fire on agent's FIRST trade (predict bet or order placed, amount ≥ $1).
 * @param {{ did, wallet_address, tradeCountBefore, amount_usdc }} opts
 */
export async function maybeFireFirstTradeReward({ did, wallet_address, tradeCountBefore, amount_usdc = 0 }) {
  if (tradeCountBefore !== 0) return; // not first trade
  if (!did || !wallet_address) {
    console.log(`[rewards] first_trade skipped — did=${did} wallet=${wallet_address}`);
    return;
  }
  if (parseFloat(amount_usdc) < 1) {
    console.log(`[rewards] first_trade skipped — amount ${amount_usdc} < $1`);
    return;
  }
  // Fire-and-forget
  fireReward({ did, wallet_address, trigger: 'first_trade' })
    .catch(e => console.error('[rewards] first_trade uncaught:', e.message));
}

/**
 * Fire when a referred agent claims their DID.
 * @param {{ referrer_did, referrer_wallet, referred_did }} opts
 */
export async function fireReferralReward({ referrer_did, referrer_wallet, referred_did }) {
  if (!referrer_did || !referrer_wallet) return;
  fireReward({
    did: referrer_did,
    wallet_address: referrer_wallet,
    trigger: 'first_referral',
    ref_id: referred_did,
  }).catch(e => console.error('[rewards] referral uncaught:', e.message));
}

/**
 * Fire when agent completes a settlement ≥ $1.
 * @param {{ did, wallet_address, amount_usdc }} opts
 */
export async function maybeFireFirstSettleReward({ did, wallet_address, amount_usdc }) {
  if (!did || !wallet_address) return;
  if (parseFloat(amount_usdc) < 1) return;
  fireReward({ did, wallet_address, trigger: 'first_settle' })
    .catch(e => console.error('[rewards] first_settle uncaught:', e.message));
}

/**
 * Fire when agent claims their DID (called from HiveGate or HiveBank onboard hook).
 * @param {{ did, wallet_address }} opts
 */
export async function fireClaimDidReward({ did, wallet_address }) {
  if (!did || !wallet_address) return;
  fireReward({ did, wallet_address, trigger: 'claim_did' })
    .catch(e => console.error('[rewards] claim_did uncaught:', e.message));
}
