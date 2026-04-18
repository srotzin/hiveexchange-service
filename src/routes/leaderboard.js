// routes/leaderboard.js — Top agents by volume, PnL, trade count
import { Router } from 'express';
import { isInMemory, store, query } from '../db.js';
import { rateLimit } from '../middleware/rate-limit.js';

const router = Router();
const ok = (res, data) => res.json({ status: 'ok', data });
const err = (res, code, detail, status = 500) =>
  res.status(status).json({ status: 'error', error: code, detail });

// ─── GET /v1/exchange/leaderboard ─────────────────────────────────────────────
router.get('/', rateLimit(), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    if (isInMemory()) {
      return ok(res, buildInMemoryLeaderboard(limit));
    }

    // PostgreSQL path
    const [tradeRes, posRes] = await Promise.all([
      query(`
        SELECT
          did,
          SUM(volume_usdc) AS total_volume,
          COUNT(*) AS trade_count
        FROM (
          SELECT maker_did AS did, price * quantity AS volume_usdc FROM trades
          UNION ALL
          SELECT taker_did AS did, price * quantity AS volume_usdc FROM trades
        ) t
        GROUP BY did
        ORDER BY total_volume DESC
        LIMIT $1
      `, [limit]),
      query(`
        SELECT
          did,
          COUNT(*) FILTER (WHERE status = 'won') AS wins,
          COUNT(*) FILTER (WHERE status = 'lost') AS losses,
          COALESCE(SUM(payout_usdc) FILTER (WHERE status = 'won'), 0) AS total_payout
        FROM positions
        GROUP BY did
      `, []),
    ]);

    // Merge trade + prediction stats
    const posMap = new Map(posRes.rows.map(r => [r.did, r]));
    const byVolume = tradeRes.rows.map((r, i) => {
      const pos = posMap.get(r.did) || {};
      return {
        rank: i + 1,
        did: r.did,
        volume_usdc: parseFloat(r.total_volume || 0),
        trade_count: parseInt(r.trade_count || 0),
        prediction_wins: parseInt(pos.wins || 0),
        prediction_losses: parseInt(pos.losses || 0),
        prediction_payout_usdc: parseFloat(pos.total_payout || 0),
      };
    });

    // Top by prediction wins (separate sort)
    const allPosRes = await query(`
      SELECT did,
        COUNT(*) FILTER (WHERE status = 'won') AS wins,
        COUNT(*) FILTER (WHERE status = 'lost') AS losses,
        COALESCE(SUM(payout_usdc) FILTER (WHERE status = 'won'), 0) AS payout
      FROM positions
      GROUP BY did
      ORDER BY wins DESC
      LIMIT $1
    `, [limit]);

    const byPnl = allPosRes.rows.map((r, i) => ({
      rank: i + 1,
      did: r.did,
      prediction_wins: parseInt(r.wins),
      prediction_losses: parseInt(r.losses),
      win_rate_pct: r.wins + r.losses > 0
        ? parseFloat(((r.wins / (r.wins + r.losses)) * 100).toFixed(1))
        : null,
      total_payout_usdc: parseFloat(r.payout),
    }));

    ok(res, {
      by_volume: byVolume,
      by_prediction_pnl: byPnl,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    err(res, 'LEADERBOARD_ERROR', e.message);
  }
});

function buildInMemoryLeaderboard(limit) {
  const trades = Array.from(store.trades.values());
  const positions = Array.from(store.positions.values());

  // Aggregate by DID
  const agentMap = new Map();

  const ensure = (did) => {
    if (!agentMap.has(did)) {
      agentMap.set(did, {
        did,
        volume_usdc: 0,
        trade_count: 0,
        prediction_wins: 0,
        prediction_losses: 0,
        prediction_payout_usdc: 0,
      });
    }
    return agentMap.get(did);
  };

  for (const t of trades) {
    const vol = parseFloat(t.price) * parseFloat(t.quantity);
    ensure(t.maker_did).volume_usdc += vol;
    ensure(t.maker_did).trade_count += 1;
    ensure(t.taker_did).volume_usdc += vol;
    ensure(t.taker_did).trade_count += 1;
  }

  for (const p of positions) {
    const a = ensure(p.did);
    if (p.status === 'won') {
      a.prediction_wins += 1;
      a.prediction_payout_usdc += parseFloat(p.payout_usdc || 0);
    } else if (p.status === 'lost') {
      a.prediction_losses += 1;
    }
  }

  const agents = Array.from(agentMap.values());

  const byVolume = [...agents]
    .sort((a, b) => b.volume_usdc - a.volume_usdc)
    .slice(0, limit)
    .map((a, i) => ({ rank: i + 1, ...a }));

  const byPnl = [...agents]
    .sort((a, b) => b.prediction_wins - a.prediction_wins)
    .slice(0, limit)
    .map((a, i) => ({
      rank: i + 1,
      did: a.did,
      prediction_wins: a.prediction_wins,
      prediction_losses: a.prediction_losses,
      win_rate_pct: a.prediction_wins + a.prediction_losses > 0
        ? parseFloat(((a.prediction_wins / (a.prediction_wins + a.prediction_losses)) * 100).toFixed(1))
        : null,
      total_payout_usdc: parseFloat(a.prediction_payout_usdc.toFixed(4)),
    }));

  const byTrades = [...agents]
    .sort((a, b) => b.trade_count - a.trade_count)
    .slice(0, limit)
    .map((a, i) => ({ rank: i + 1, did: a.did, trade_count: a.trade_count, volume_usdc: parseFloat(a.volume_usdc.toFixed(4)) }));

  return {
    by_volume: byVolume,
    by_prediction_pnl: byPnl,
    by_trade_count: byTrades,
    total_agents_tracked: agentMap.size,
    generated_at: new Date().toISOString(),
  };
}

export default router;
