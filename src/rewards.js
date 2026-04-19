// rewards.js — Fire $1 reward to HiveBank on agent's first trade
// Fire-and-forget: never blocks the trade response

const HIVEBANK_URL = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';
const HIVE_INTERNAL_KEY = 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

/**
 * Check if this is the agent's first trade, and if so, fire the $1 reward.
 * @param {object} opts
 * @param {string} opts.did - Agent DID
 * @param {string} opts.wallet_address - Wallet address for USDC payout
 * @param {number} opts.tradeCountBefore - Number of trades this agent had BEFORE this trade
 */
export async function maybeFireFirstTradeReward({ did, wallet_address, tradeCountBefore }) {
  // Only fire on the very first trade (count was 0 before this one)
  if (tradeCountBefore !== 0) return;
  if (!did) return;
  if (!wallet_address) {
    console.log(`[rewards] first_trade: DID=${did} has no wallet_address — skipping reward`);
    return;
  }

  const url = `${HIVEBANK_URL}/v1/bank/rewards/claim`;
  const payload = {
    did,
    wallet_address,
    trigger: 'first_trade',
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hive-internal': HIVE_INTERNAL_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    console.log(`[rewards] first_trade reward fired: did=${did} status=${res.status}`, body);
  } catch (err) {
    console.error(`[rewards] first_trade reward error (non-fatal): did=${did}`, err.message);
  }
}
