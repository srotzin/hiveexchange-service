// matching-engine.js — Order matching engine: FIFO + trust score bonus
import { v4 as uuidv4 } from 'uuid';
import { isInMemory, store, query, memUpdate } from './db.js';

const TRUST_BONUS_THRESHOLD = 80;
const TRUST_BONUS_MS = 1; // virtual ms advantage

/**
 * Get effective timestamp for ordering — agents with trust > 80 get 1ms advantage.
 */
function effectiveTs(order) {
  const base = new Date(order.created_at).getTime();
  return order.trust_score_at_placement > TRUST_BONUS_THRESHOLD
    ? base - TRUST_BONUS_MS
    : base;
}

/**
 * Match a newly placed order against the book.
 * Returns array of Trade records created.
 */
export async function matchOrder(newOrder) {
  const trades = [];

  if (newOrder.side === 'buy') {
    await matchBuy(newOrder, trades);
  } else {
    await matchSell(newOrder, trades);
  }

  return trades;
}

async function matchBuy(buyOrder, trades) {
  const asks = await getOpenOrders(buyOrder.market_id, 'sell');

  // Sort asks: lowest price first, then by effective timestamp (FIFO + trust bonus)
  asks.sort((a, b) => {
    const priceDiff = parseFloat(a.price) - parseFloat(b.price);
    if (priceDiff !== 0) return priceDiff;
    return effectiveTs(a) - effectiveTs(b);
  });

  let remainingQty =
    parseFloat(buyOrder.quantity) - parseFloat(buyOrder.filled_quantity);

  for (const ask of asks) {
    if (remainingQty <= 0) break;

    // For market orders, match any price; for limit orders, check price
    if (
      buyOrder.order_type === 'limit' &&
      parseFloat(buyOrder.price) < parseFloat(ask.price)
    ) {
      break; // No more matches possible (asks sorted by price)
    }

    const askRemaining =
      parseFloat(ask.quantity) - parseFloat(ask.filled_quantity);
    const fillQty = Math.min(remainingQty, askRemaining);

    if (fillQty <= 0) continue;

    const tradePrice = parseFloat(ask.price); // Maker price
    const trade = await createTrade({
      market_id: buyOrder.market_id,
      buy_order_id: buyOrder.id,
      sell_order_id: ask.id,
      price: tradePrice,
      quantity: fillQty,
      maker_did: ask.did,
      taker_did: buyOrder.did,
      settlement_rail: buyOrder.settlement_rail || ask.settlement_rail || 'usdc',
    });

    trades.push(trade);

    // Update ask order
    const newAskFilled = parseFloat(ask.filled_quantity) + fillQty;
    const askStatus =
      newAskFilled >= parseFloat(ask.quantity) ? 'filled' : 'partial';
    await updateOrderFill(ask.id, newAskFilled, askStatus);

    // Update buy order
    remainingQty -= fillQty;
    const newBuyFilled = parseFloat(buyOrder.filled_quantity) + fillQty;
    const buyStatus =
      newBuyFilled >= parseFloat(buyOrder.quantity) ? 'filled' : 'partial';
    await updateOrderFill(buyOrder.id, newBuyFilled, buyStatus);
    buyOrder.filled_quantity = newBuyFilled;
  }
}

async function matchSell(sellOrder, trades) {
  const bids = await getOpenOrders(sellOrder.market_id, 'buy');

  // Sort bids: highest price first, then by effective timestamp
  bids.sort((a, b) => {
    const priceDiff = parseFloat(b.price) - parseFloat(a.price);
    if (priceDiff !== 0) return priceDiff;
    return effectiveTs(a) - effectiveTs(b);
  });

  let remainingQty =
    parseFloat(sellOrder.quantity) - parseFloat(sellOrder.filled_quantity);

  for (const bid of bids) {
    if (remainingQty <= 0) break;

    if (
      sellOrder.order_type === 'limit' &&
      parseFloat(sellOrder.price) > parseFloat(bid.price)
    ) {
      break;
    }

    const bidRemaining =
      parseFloat(bid.quantity) - parseFloat(bid.filled_quantity);
    const fillQty = Math.min(remainingQty, bidRemaining);

    if (fillQty <= 0) continue;

    const tradePrice = parseFloat(bid.price); // Maker price
    const trade = await createTrade({
      market_id: sellOrder.market_id,
      buy_order_id: bid.id,
      sell_order_id: sellOrder.id,
      price: tradePrice,
      quantity: fillQty,
      maker_did: bid.did,
      taker_did: sellOrder.did,
      settlement_rail: sellOrder.settlement_rail || bid.settlement_rail || 'usdc',
    });

    trades.push(trade);

    const newBidFilled = parseFloat(bid.filled_quantity) + fillQty;
    const bidStatus =
      newBidFilled >= parseFloat(bid.quantity) ? 'filled' : 'partial';
    await updateOrderFill(bid.id, newBidFilled, bidStatus);

    remainingQty -= fillQty;
    const newSellFilled = parseFloat(sellOrder.filled_quantity) + fillQty;
    const sellStatus =
      newSellFilled >= parseFloat(sellOrder.quantity) ? 'filled' : 'partial';
    await updateOrderFill(sellOrder.id, newSellFilled, sellStatus);
    sellOrder.filled_quantity = newSellFilled;
  }
}

async function getOpenOrders(marketId, side) {
  if (isInMemory()) {
    return Array.from(store.orders.values()).filter(
      (o) =>
        o.market_id === marketId &&
        o.side === side &&
        (o.status === 'open' || o.status === 'partial')
    );
  }

  const res = await query(
    `SELECT * FROM orders
     WHERE market_id = $1 AND side = $2 AND status IN ('open', 'partial')`,
    [marketId, side]
  );
  return res.rows;
}

async function updateOrderFill(orderId, filledQty, status) {
  if (isInMemory()) {
    memUpdate('orders', orderId, { filled_quantity: filledQty, status });
    return;
  }
  await query(
    `UPDATE orders SET filled_quantity = $1, status = $2, updated_at = NOW()
     WHERE id = $3`,
    [filledQty, status, orderId]
  );
}

async function createTrade({ market_id, buy_order_id, sell_order_id, price, quantity, maker_did, taker_did, settlement_rail }) {
  // Fee = taker_fee_pct (0.18%) of trade value
  const fee_usdc = parseFloat((price * quantity * 0.0018).toFixed(8));

  const trade = {
    id: uuidv4(),
    market_id,
    buy_order_id,
    sell_order_id,
    price,
    quantity,
    maker_did,
    taker_did,
    fee_usdc,
    settlement_rail,
    settled_at: null,
    created_at: new Date().toISOString(),
  };

  if (isInMemory()) {
    store.trades.set(trade.id, trade);
    return trade;
  }

  await query(
    `INSERT INTO trades
     (id, market_id, buy_order_id, sell_order_id, price, quantity,
      maker_did, taker_did, fee_usdc, settlement_rail, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      trade.id, market_id, buy_order_id, sell_order_id,
      price, quantity, maker_did, taker_did, fee_usdc,
      settlement_rail, trade.created_at,
    ]
  );
  return trade;
}

/**
 * Build orderbook snapshot for a market.
 * Returns { bids: [...], asks: [...] }
 */
export async function getOrderbook(marketId, depth = 50) {
  let orders;

  if (isInMemory()) {
    orders = Array.from(store.orders.values()).filter(
      (o) =>
        o.market_id === marketId &&
        (o.status === 'open' || o.status === 'partial') &&
        o.order_type === 'limit'
    );
  } else {
    const res = await query(
      `SELECT * FROM orders
       WHERE market_id = $1 AND status IN ('open','partial') AND order_type = 'limit'`,
      [marketId]
    );
    orders = res.rows;
  }

  // Aggregate by price level
  const bidMap = new Map();
  const askMap = new Map();

  for (const o of orders) {
    const remaining = parseFloat(o.quantity) - parseFloat(o.filled_quantity);
    if (remaining <= 0) continue;
    const priceKey = parseFloat(o.price).toFixed(8);
    const map = o.side === 'buy' ? bidMap : askMap;
    map.set(priceKey, (map.get(priceKey) || 0) + remaining);
  }

  const bids = Array.from(bidMap.entries())
    .map(([price, quantity]) => ({ price: parseFloat(price), quantity }))
    .sort((a, b) => b.price - a.price)
    .slice(0, depth);

  const asks = Array.from(askMap.entries())
    .map(([price, quantity]) => ({ price: parseFloat(price), quantity }))
    .sort((a, b) => a.price - b.price)
    .slice(0, depth);

  return { bids, asks };
}
