// routes/perps.js — Perpetual futures trading routes
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireDid, optionalDid } from '../middleware/did-auth.js';
import { rateLimit } from '../middleware/rate-limit.js';

const router = Router();

const ok  = (res, data, status = 200) => res.status(status).json({ status: 'ok', data });
const err = (res, code, detail, status = 400) =>
  res.status(status).json({ status: 'error', error: code, detail });

// ─── In-memory position store (ephemeral, resets on restart) ──────────────────
const perpsPositions = new Map();

// ─── Synthetic market data helpers ────────────────────────────────────────────
const BASE_MARKETS = [
  {
    id:                  'BTC-PERP',
    symbol:              'BTC-PERP',
    base_price:          67_420,
    funding_rate_base:   0.0001,
    open_interest_base:  48_200_000,
    volume_24h_base:     312_000_000,
    leverage_max:        20,
    long_ratio_base:     0.58,
  },
  {
    id:                  'ETH-PERP',
    symbol:              'ETH-PERP',
    base_price:          3_512,
    funding_rate_base:   0.00008,
    open_interest_base:  22_100_000,
    volume_24h_base:     187_000_000,
    leverage_max:        20,
    long_ratio_base:     0.54,
  },
  {
    id:                  'SOL-PERP',
    symbol:              'SOL-PERP',
    base_price:          172.4,
    funding_rate_base:   0.00012,
    open_interest_base:  8_900_000,
    volume_24h_base:     64_000_000,
    leverage_max:        15,
    long_ratio_base:     0.61,
  },
  {
    id:                  'ALEO-PERP',
    symbol:              'ALEO-PERP',
    base_price:          2.18,
    funding_rate_base:   0.00015,
    open_interest_base:  1_200_000,
    volume_24h_base:     9_400_000,
    leverage_max:        10,
    long_ratio_base:     0.63,
  },
  {
    id:                  'HIVE-PERP',
    symbol:              'HIVE-PERP',
    base_price:          0.84,
    funding_rate_base:   0.00018,
    open_interest_base:  480_000,
    volume_24h_base:     3_100_000,
    leverage_max:        10,
    long_ratio_base:     0.67,
  },
];

/** Tiny deterministic jitter so repeated calls look live. */
function jitter(value, pct = 0.002) {
  return parseFloat((value * (1 + (Math.random() * 2 - 1) * pct)).toFixed(8));
}

function buildMarket(m) {
  const mark_price  = jitter(m.base_price, 0.0015);
  const index_price = jitter(m.base_price, 0.001);
  const long_ratio  = parseFloat(jitter(m.long_ratio_base, 0.01).toFixed(4));
  return {
    id:                  m.id,
    symbol:              m.symbol,
    mark_price:          parseFloat(mark_price.toFixed(6)),
    index_price:         parseFloat(index_price.toFixed(6)),
    funding_rate:        parseFloat(jitter(m.funding_rate_base, 0.05).toFixed(8)),
    open_interest_usdc:  Math.round(jitter(m.open_interest_base, 0.003)),
    volume_24h_usdc:     Math.round(jitter(m.volume_24h_base, 0.005)),
    long_ratio:          long_ratio,
    short_ratio:         parseFloat((1 - long_ratio).toFixed(4)),
    leverage_max:        m.leverage_max,
  };
}

function getBaseMarket(id) {
  return BASE_MARKETS.find(m => m.id === id);
}

// ─── GET /v1/exchange/perps/markets ───────────────────────────────────────────
router.get('/markets', rateLimit(), (req, res) => {
  try {
    const markets = BASE_MARKETS.map(buildMarket);
    ok(res, {
      markets,
      count: markets.length,
      timestamp: new Date().toISOString(),
      note: 'Perpetual futures — synthetic positions, no real asset delivery. Settled in USDC.',
    });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── POST /v1/exchange/perps/positions — Open a perpetual position ─────────────
router.post('/positions', requireDid, rateLimit(), (req, res) => {
  try {
    const {
      market_id,
      side,
      size_usdc,
      leverage,
      collateral_usdc,
    } = req.body;

    const did = req.hive_did;

    if (!market_id || !side || !size_usdc || !leverage || !collateral_usdc) {
      return err(res, 'MISSING_FIELDS',
        'market_id, side, size_usdc, leverage, and collateral_usdc are required');
    }
    if (!['long', 'short'].includes(side)) {
      return err(res, 'INVALID_SIDE', 'side must be long or short');
    }

    const leverageNum = parseFloat(leverage);
    if (leverageNum < 1 || leverageNum > 20) {
      return err(res, 'INVALID_LEVERAGE', 'leverage must be between 1 and 20');
    }

    const base = getBaseMarket(market_id);
    if (!base) {
      return err(res, 'MARKET_NOT_FOUND',
        `Perp market ${market_id} not found. Available: ${BASE_MARKETS.map(m => m.id).join(', ')}`, 404);
    }
    if (leverageNum > base.leverage_max) {
      return err(res, 'LEVERAGE_EXCEEDED',
        `Max leverage for ${market_id} is ${base.leverage_max}x`);
    }

    const sizeNum       = parseFloat(size_usdc);
    const collateral    = parseFloat(collateral_usdc);
    const mark_price    = jitter(base.base_price, 0.001);
    const funding_rate  = parseFloat(jitter(base.funding_rate_base, 0.05).toFixed(8));

    // Liquidation price: mark ± (collateral / size) * mark
    const liqDistance   = (collateral / sizeNum) * mark_price;
    const liquidation_price = side === 'long'
      ? parseFloat((mark_price - liqDistance * 0.9).toFixed(6))
      : parseFloat((mark_price + liqDistance * 0.9).toFixed(6));

    const position = {
      id:                uuidv4(),
      did,
      market_id,
      side,
      size_usdc:         sizeNum,
      leverage:          leverageNum,
      collateral_usdc:   collateral,
      entry_price:       parseFloat(mark_price.toFixed(6)),
      mark_price:        parseFloat(mark_price.toFixed(6)),
      liquidation_price,
      funding_rate,
      unrealized_pnl_usdc: 0,
      status:            'open',
      created_at:        new Date().toISOString(),
      updated_at:        new Date().toISOString(),
    };

    perpsPositions.set(position.id, position);

    ok(res, {
      position_id:       position.id,
      market_id,
      side,
      size_usdc:         sizeNum,
      leverage:          leverageNum,
      collateral_usdc:   collateral,
      entry_price:       position.entry_price,
      liquidation_price,
      funding_rate,
      status:            'open',
      created_at:        position.created_at,
      note:              'Synthetic perpetual position. No real asset is bought or sold.',
    }, 201);
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/perps/positions?did= — List open positions ───────────────
router.get('/positions', optionalDid, rateLimit(), (req, res) => {
  try {
    const filterDid = req.query.did || req.hive_did;
    if (!filterDid) {
      return err(res, 'DID_REQUIRED', 'Provide ?did= query param or x-hive-did header', 400);
    }

    const positions = Array.from(perpsPositions.values())
      .filter(p => p.did === filterDid && p.status === 'open')
      .map(p => {
        // Simulate live mark price movement
        const base = getBaseMarket(p.market_id);
        const current_price = base ? jitter(base.base_price, 0.005) : p.entry_price;
        const direction     = p.side === 'long' ? 1 : -1;
        const priceDiff     = (current_price - p.entry_price) / p.entry_price;
        const unrealized_pnl_usdc = parseFloat((p.size_usdc * priceDiff * direction).toFixed(4));
        return { ...p, mark_price: parseFloat(current_price.toFixed(6)), unrealized_pnl_usdc };
      });

    ok(res, { positions, count: positions.length, did: filterDid });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── POST /v1/exchange/perps/positions/:id/close — Close a position ───────────
router.post('/positions/:id/close', requireDid, rateLimit(), (req, res) => {
  try {
    const { id }  = req.params;
    const did     = req.hive_did;
    const position = perpsPositions.get(id);

    if (!position) {
      return err(res, 'POSITION_NOT_FOUND', `Position ${id} not found`, 404);
    }
    if (position.did !== did) {
      return err(res, 'FORBIDDEN', 'You can only close your own positions', 403);
    }
    if (position.status !== 'open') {
      return err(res, 'POSITION_NOT_OPEN', `Position is already ${position.status}`);
    }

    const base          = getBaseMarket(position.market_id);
    const exit_price    = base ? jitter(base.base_price, 0.003) : position.entry_price;
    const direction     = position.side === 'long' ? 1 : -1;
    const priceDiff     = (exit_price - position.entry_price) / position.entry_price;
    const gross_pnl     = position.size_usdc * priceDiff * direction;
    // 0.05% taker fee on size
    const fee           = position.size_usdc * 0.0005;
    const pnl_usdc      = parseFloat((gross_pnl - fee).toFixed(4));

    const settled = {
      ...position,
      status:       'closed',
      exit_price:   parseFloat(exit_price.toFixed(6)),
      pnl_usdc,
      fee_usdc:     parseFloat(fee.toFixed(4)),
      closed_at:    new Date().toISOString(),
    };
    perpsPositions.set(id, settled);

    const zk_receipt = {
      receipt_id:       uuidv4(),
      type:             'perp_close',
      position_id:      id,
      did,
      market_id:        position.market_id,
      side:             position.side,
      entry_price:      position.entry_price,
      exit_price:       parseFloat(exit_price.toFixed(6)),
      size_usdc:        position.size_usdc,
      pnl_usdc,
      fee_usdc:         parseFloat(fee.toFixed(4)),
      settlement_rail:  'usdcx',
      zk_proof_stub:    `0x${uuidv4().replace(/-/g, '')}${uuidv4().replace(/-/g, '')}`,
      settled_at:       new Date().toISOString(),
      note:             'ZK receipt stub. Full Aleo proof generation available via HiveGate.',
    };

    ok(res, {
      position_id:   id,
      status:        'closed',
      pnl_usdc,
      fee_usdc:      parseFloat(fee.toFixed(4)),
      entry_price:   position.entry_price,
      exit_price:    parseFloat(exit_price.toFixed(6)),
      zk_receipt,
    });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/perps/funding — Current funding rates ───────────────────
router.get('/funding', rateLimit(), (req, res) => {
  try {
    const rates = BASE_MARKETS.map(m => ({
      market_id:        m.id,
      symbol:           m.symbol,
      funding_rate:     parseFloat(jitter(m.funding_rate_base, 0.08).toFixed(8)),
      funding_rate_pct: parseFloat((jitter(m.funding_rate_base, 0.08) * 100).toFixed(6)),
      funding_interval: '8h',
      next_funding_at:  (() => {
        const now = new Date();
        // Next 8-hour mark (00:00, 08:00, 16:00 UTC)
        const nextHour = (Math.ceil(now.getUTCHours() / 8) * 8) % 24;
        const next = new Date(now);
        next.setUTCHours(nextHour, 0, 0, 0);
        if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
        return next.toISOString();
      })(),
      annualized_rate_pct: parseFloat((jitter(m.funding_rate_base, 0.08) * 3 * 365 * 100).toFixed(4)),
    }));

    ok(res, {
      funding_rates: rates,
      count: rates.length,
      timestamp: new Date().toISOString(),
      note: 'Funding rates settle every 8 hours between longs and shorts.',
    });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

export default router;
