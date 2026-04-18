// routes/portfolio.js — Agent portfolio: orders, positions, trades, PnL
import { Router } from 'express';
import { isInMemory, store, query } from '../db.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { fetchAllPrices } from '../oracle.js';

const router = Router();
const ok = (res, data) => res.json({ status: 'ok', data });
const err = (res, code, detail, status = 400) =>
  res.status(status).json({ status: 'error', error: code, detail });

// ─── GET /v1/exchange/portfolio/:did ──────────────────────────────────────────
router.get('/:did', rateLimit(), async (req, res) => {
  try {
    const { did } = req.params;
    if (!did) return err(res, 'DID_REQUIRED', 'DID is required', 400);

    const [openOrders, openPositions, recentTrades, allPositions] =
      await Promise.all([
        getOpenOrders(did),
        getOpenPositions(did),
        getRecentTrades(did, 50),
        getAllPositions(did),
      ]);

    // Prediction market stats
    const wonPositions = allPositions.filter(p => p.status === 'won');
    const lostPositions = allPositions.filter(p => p.status === 'lost');
    const totalBetUsdc = allPositions.reduce((s, p) => s + parseFloat(p.amount_usdc || 0), 0);
    const totalPayoutUsdc = wonPositions.reduce((s, p) => s + parseFloat(p.payout_usdc || 0), 0);
    const winRate = allPositions.filter(p => p.status !== 'open' && p.status !== 'void').length > 0
      ? parseFloat(((wonPositions.length / (wonPositions.length + lostPositions.length)) * 100).toFixed(1))
      : null;

    // Trading volume
    const totalVolume = recentTrades.reduce(
      (s, t) => s + parseFloat(t.price) * parseFloat(t.quantity), 0
    );

    // Unrealized PnL estimate for open positions
    // (simplified: compare current pool odds vs entry price)
    const priceMap = await fetchAllPrices().catch(() => ({}));
    const unrealizedPnl = estimateUnrealizedPnl(openPositions, priceMap);

    ok(res, {
      did,
      open_orders: openOrders,
      open_orders_count: openOrders.length,
      open_positions: openPositions,
      open_positions_count: openPositions.length,
      recent_trades: recentTrades,
      recent_trades_count: recentTrades.length,
      stats: {
        total_volume_usdc: parseFloat(totalVolume.toFixed(4)),
        prediction_wins: wonPositions.length,
        prediction_losses: lostPositions.length,
        prediction_open: openPositions.length,
        win_rate_pct: winRate,
        total_bet_usdc: parseFloat(totalBetUsdc.toFixed(4)),
        total_payout_usdc: parseFloat(totalPayoutUsdc.toFixed(4)),
        net_prediction_pnl_usdc: parseFloat((totalPayoutUsdc - totalBetUsdc).toFixed(4)),
        unrealized_pnl_estimate_usdc: unrealizedPnl,
      },
      oracle_prices_snapshot: Object.fromEntries(
        Object.entries(priceMap).map(([k, v]) => [k, v?.price_usd ?? v])
      ),
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    err(res, 'PORTFOLIO_ERROR', e.message, 500);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getOpenOrders(did) {
  if (isInMemory()) {
    return Array.from(store.orders.values()).filter(
      o => o.did === did && (o.status === 'open' || o.status === 'partial')
    );
  }
  const res = await query(
    "SELECT * FROM orders WHERE did=$1 AND status IN ('open','partial') ORDER BY created_at DESC",
    [did]
  );
  return res.rows;
}

async function getOpenPositions(did) {
  if (isInMemory()) {
    return Array.from(store.positions.values()).filter(
      p => p.did === did && p.status === 'open'
    );
  }
  const res = await query(
    "SELECT * FROM positions WHERE did=$1 AND status='open' ORDER BY created_at DESC",
    [did]
  );
  return res.rows;
}

async function getRecentTrades(did, limit = 50) {
  if (isInMemory()) {
    return Array.from(store.trades.values())
      .filter(t => t.maker_did === did || t.taker_did === did)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit)
      .map(t => ({ ...t, role: t.maker_did === did ? 'maker' : 'taker' }));
  }
  const res = await query(
    `SELECT *, CASE WHEN maker_did=$1 THEN 'maker' ELSE 'taker' END AS role
     FROM trades WHERE maker_did=$1 OR taker_did=$1
     ORDER BY created_at DESC LIMIT $2`,
    [did, limit]
  );
  return res.rows;
}

async function getAllPositions(did) {
  if (isInMemory()) {
    return Array.from(store.positions.values()).filter(p => p.did === did);
  }
  const res = await query(
    'SELECT * FROM positions WHERE did=$1 ORDER BY created_at DESC',
    [did]
  );
  return res.rows;
}

function estimateUnrealizedPnl(openPositions, priceMap) {
  // For prediction market positions: estimate based on current market odds
  // Simplified: current_value = shares * current_yes_or_no_price
  // We don't have live odds here without fetching each market, so return a note
  // Real implementation would join with predict_markets table
  return {
    estimate_usdc: null,
    note: 'Unrealized PnL requires live market odds. Fetch /v1/exchange/predict/markets for current odds on open positions.',
  };
}

export default router;
