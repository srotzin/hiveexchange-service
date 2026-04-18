// routes/markets.js — Market listing, creation, detail + orderbook
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { isInMemory, store, query, memInsert, memGet } from '../db.js';
import { getOrderbook } from '../matching-engine.js';
import { requireDid, requireInternalKey } from '../middleware/did-auth.js';
import { rateLimit } from '../middleware/rate-limit.js';

const router = Router();

const ok = (res, data, status = 200) => res.status(status).json({ status: 'ok', data });
const err = (res, code, detail, status = 400) =>
  res.status(status).json({ status: 'error', error: code, detail });

// ─── GET /v1/exchange/markets ─────────────────────────────────────────────────
router.get('/', rateLimit(), async (req, res) => {
  try {
    const { market_type, status = 'active' } = req.query;

    let markets;
    if (isInMemory()) {
      markets = Array.from(store.markets.values()).filter((m) => {
        if (status && m.status !== status) return false;
        if (market_type && m.market_type !== market_type) return false;
        return true;
      });
    } else {
      let sql = 'SELECT * FROM markets WHERE 1=1';
      const params = [];
      if (status) { sql += ` AND status = $${params.length + 1}`; params.push(status); }
      if (market_type) { sql += ` AND market_type = $${params.length + 1}`; params.push(market_type); }
      sql += ' ORDER BY created_at DESC';
      const result = await query(sql, params);
      markets = result.rows;
    }

    ok(res, { markets, count: markets.length });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── POST /v1/exchange/markets ────────────────────────────────────────────────
router.post('/', requireDid, rateLimit(), async (req, res) => {
  try {
    const {
      symbol, base_asset, quote_asset, market_type = 'spot',
      maker_fee_pct = 0.10, taker_fee_pct = 0.18, metadata = {},
    } = req.body;

    if (!symbol || !base_asset || !quote_asset) {
      return err(res, 'MISSING_FIELDS', 'symbol, base_asset, and quote_asset are required');
    }

    if (!['spot', 'prediction'].includes(market_type)) {
      return err(res, 'INVALID_MARKET_TYPE', 'market_type must be spot or prediction');
    }

    const market = {
      id: uuidv4(),
      symbol: symbol.toUpperCase(),
      base_asset: base_asset.toUpperCase(),
      quote_asset: quote_asset.toUpperCase(),
      market_type,
      status: 'active',
      maker_fee_pct: parseFloat(maker_fee_pct),
      taker_fee_pct: parseFloat(taker_fee_pct),
      created_by_did: req.hive_did,
      metadata,
      created_at: new Date().toISOString(),
    };

    if (isInMemory()) {
      memInsert('markets', market);
    } else {
      await query(
        `INSERT INTO markets
         (id, symbol, base_asset, quote_asset, market_type, status,
          maker_fee_pct, taker_fee_pct, created_by_did, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          market.id, market.symbol, market.base_asset, market.quote_asset,
          market.market_type, market.status, market.maker_fee_pct,
          market.taker_fee_pct, market.created_by_did,
          JSON.stringify(metadata), market.created_at,
        ]
      );
    }

    ok(res, { market }, 201);
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/markets/:market_id ──────────────────────────────────────
router.get('/:market_id', rateLimit(), async (req, res) => {
  try {
    const { market_id } = req.params;

    let market;
    if (isInMemory()) {
      market = store.markets.get(market_id);
    } else {
      const result = await query('SELECT * FROM markets WHERE id = $1', [market_id]);
      market = result.rows[0];
    }

    if (!market) return err(res, 'MARKET_NOT_FOUND', `Market ${market_id} not found`, 404);

    const orderbook = await getOrderbook(market_id);

    // Recent trades
    let recent_trades = [];
    if (isInMemory()) {
      recent_trades = Array.from(store.trades.values())
        .filter((t) => t.market_id === market_id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 20);
    } else {
      const trRes = await query(
        'SELECT * FROM trades WHERE market_id = $1 ORDER BY created_at DESC LIMIT 20',
        [market_id]
      );
      recent_trades = trRes.rows;
    }

    const last_price = recent_trades.length > 0 ? recent_trades[0].price : null;

    ok(res, { market, orderbook, last_price, recent_trades });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/book/:market_id ─────────────────────────────────────────
router.get('/book/:market_id', rateLimit(), async (req, res) => {
  try {
    const { market_id } = req.params;
    const depth = Math.min(parseInt(req.query.depth) || 50, 200);
    const orderbook = await getOrderbook(market_id, depth);
    ok(res, { market_id, orderbook, depth });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

export default router;
