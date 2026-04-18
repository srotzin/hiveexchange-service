// routes/orders.js — Order placement, cancellation, status, list
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { isInMemory, store, query, memInsert, memGet, memUpdate } from '../db.js';
import { matchOrder } from '../matching-engine.js';
import { checkTrustAllowed } from '../trust.js';
import { requireDid, optionalDid } from '../middleware/did-auth.js';
import { orderRateLimit, rateLimit } from '../middleware/rate-limit.js';

const router = Router();

const ok = (res, data, status = 200) => res.status(status).json({ status: 'ok', data });
const err = (res, code, detail, status = 400) =>
  res.status(status).json({ status: 'error', error: code, detail });

// ─── POST /v1/exchange/orders — Place order ────────────────────────────────────
router.post('/', requireDid, orderRateLimit(), async (req, res) => {
  try {
    const {
      market_id,
      side,
      order_type = 'limit',
      price,
      quantity,
      settlement_rail = 'usdc',
    } = req.body;

    const did = req.hive_did;

    // Validate inputs
    if (!market_id || !side || !quantity) {
      return err(res, 'MISSING_FIELDS', 'market_id, side, and quantity are required');
    }
    if (!['buy', 'sell'].includes(side)) {
      return err(res, 'INVALID_SIDE', 'side must be buy or sell');
    }
    if (!['limit', 'market'].includes(order_type)) {
      return err(res, 'INVALID_ORDER_TYPE', 'order_type must be limit or market');
    }
    if (order_type === 'limit' && (!price || parseFloat(price) <= 0)) {
      return err(res, 'PRICE_REQUIRED', 'price is required for limit orders');
    }
    if (parseFloat(quantity) <= 0) {
      return err(res, 'INVALID_QUANTITY', 'quantity must be positive');
    }

    // Validate market exists
    let market;
    if (isInMemory()) {
      market = store.markets.get(market_id);
    } else {
      const mRes = await query('SELECT * FROM markets WHERE id = $1', [market_id]);
      market = mRes.rows[0];
    }
    if (!market) return err(res, 'MARKET_NOT_FOUND', `Market ${market_id} not found`, 404);
    if (market.status !== 'active') return err(res, 'MARKET_INACTIVE', 'Market is not active');

    // Trust score check
    const { allowed, score: trust_score } = await checkTrustAllowed(did);
    if (!allowed) {
      return res.status(403).json({
        status: 'error',
        error: 'TRUST_SCORE_TOO_LOW',
        detail: `Trust score ${trust_score} is below minimum (20). Build reputation via HiveGate.`,
        trust_score,
        hivegate_url: process.env.HIVEGATE_URL || 'https://hivegate.onrender.com',
      });
    }

    const order = {
      id: uuidv4(),
      market_id,
      did,
      side,
      order_type,
      price: price ? parseFloat(price) : null,
      quantity: parseFloat(quantity),
      filled_quantity: 0,
      status: 'open',
      trust_score_at_placement: trust_score,
      settlement_rail,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (isInMemory()) {
      memInsert('orders', order);
    } else {
      await query(
        `INSERT INTO orders
         (id, market_id, did, side, order_type, price, quantity, filled_quantity,
          status, trust_score_at_placement, settlement_rail, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          order.id, market_id, did, side, order_type,
          order.price, order.quantity, 0, 'open',
          trust_score, settlement_rail,
          order.created_at, order.updated_at,
        ]
      );
    }

    // Run matching engine
    const trades = await matchOrder(order);

    // Reload order to get updated fill status
    let updatedOrder = order;
    if (isInMemory()) {
      updatedOrder = store.orders.get(order.id) || order;
    } else {
      const oRes = await query('SELECT * FROM orders WHERE id = $1', [order.id]);
      if (oRes.rows[0]) updatedOrder = oRes.rows[0];
    }

    ok(res, {
      order: updatedOrder,
      trades_executed: trades.length,
      trades,
    }, 201);
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/orders/:order_id — Order status ─────────────────────────
router.get('/:order_id', rateLimit(), async (req, res) => {
  try {
    const { order_id } = req.params;
    let order;

    if (isInMemory()) {
      order = store.orders.get(order_id);
    } else {
      const result = await query('SELECT * FROM orders WHERE id = $1', [order_id]);
      order = result.rows[0];
    }

    if (!order) return err(res, 'ORDER_NOT_FOUND', `Order ${order_id} not found`, 404);
    ok(res, { order });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── DELETE /v1/exchange/orders/:order_id — Cancel order ──────────────────────
router.delete('/:order_id', requireDid, rateLimit(), async (req, res) => {
  try {
    const { order_id } = req.params;
    const did = req.hive_did;

    let order;
    if (isInMemory()) {
      order = store.orders.get(order_id);
    } else {
      const result = await query('SELECT * FROM orders WHERE id = $1', [order_id]);
      order = result.rows[0];
    }

    if (!order) return err(res, 'ORDER_NOT_FOUND', `Order ${order_id} not found`, 404);

    // Only the DID that placed the order can cancel it
    if (order.did !== did) {
      return err(res, 'FORBIDDEN', 'You can only cancel your own orders', 403);
    }

    if (['filled', 'cancelled'].includes(order.status)) {
      return err(res, 'ORDER_NOT_CANCELLABLE', `Order is already ${order.status}`);
    }

    if (isInMemory()) {
      memUpdate('orders', order_id, { status: 'cancelled' });
    } else {
      await query(
        "UPDATE orders SET status='cancelled', updated_at=NOW() WHERE id=$1",
        [order_id]
      );
    }

    ok(res, { order_id, status: 'cancelled', message: 'Order cancelled successfully' });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/orders?did=<did> — List orders for DID ──────────────────
router.get('/', optionalDid, rateLimit(), async (req, res) => {
  try {
    const { did, market_id, status, limit = '50' } = req.query;
    const filterDid = did || req.hive_did;
    const pageLimit = Math.min(parseInt(limit), 200);

    let orders;
    if (isInMemory()) {
      orders = Array.from(store.orders.values()).filter((o) => {
        if (filterDid && o.did !== filterDid) return false;
        if (market_id && o.market_id !== market_id) return false;
        if (status && o.status !== status) return false;
        return true;
      })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, pageLimit);
    } else {
      let sql = 'SELECT * FROM orders WHERE 1=1';
      const params = [];
      if (filterDid) { sql += ` AND did = $${params.length + 1}`; params.push(filterDid); }
      if (market_id) { sql += ` AND market_id = $${params.length + 1}`; params.push(market_id); }
      if (status) { sql += ` AND status = $${params.length + 1}`; params.push(status); }
      sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
      params.push(pageLimit);
      const result = await query(sql, params);
      orders = result.rows;
    }

    ok(res, { orders, count: orders.length, filter_did: filterDid });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/trades?market_id=<id> — Recent trades ───────────────────
router.get('/trades', rateLimit(), async (req, res) => {
  try {
    const { market_id, limit = '50' } = req.query;
    const pageLimit = Math.min(parseInt(limit), 200);

    let trades;
    if (isInMemory()) {
      trades = Array.from(store.trades.values())
        .filter((t) => !market_id || t.market_id === market_id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, pageLimit);
    } else {
      let sql = 'SELECT * FROM trades WHERE 1=1';
      const params = [];
      if (market_id) { sql += ` AND market_id = $${params.length + 1}`; params.push(market_id); }
      sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
      params.push(pageLimit);
      const result = await query(sql, params);
      trades = result.rows;
    }

    ok(res, { trades, count: trades.length });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

export default router;
