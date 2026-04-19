// routes/derivatives.js — Options & derivatives trading routes
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireDid, optionalDid } from '../middleware/did-auth.js';
import { rateLimit } from '../middleware/rate-limit.js';

const router = Router();

const ok  = (res, data, status = 200) => res.status(status).json({ status: 'ok', data });
const err = (res, code, detail, status = 400) =>
  res.status(status).json({ status: 'error', error: code, detail });

// ─── In-memory position store ─────────────────────────────────────────────────
const derivPositions = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function jitter(value, pct = 0.002) {
  return value * (1 + (Math.random() * 2 - 1) * pct);
}

/** Black-Scholes approximation for option premium (simplified). */
function approxPremium(spotPrice, strike, daysToExpiry, iv, type) {
  const T   = daysToExpiry / 365;
  const sqT = Math.sqrt(T);
  const d1  = (Math.log(spotPrice / strike) + 0.5 * iv * iv * T) / (iv * sqT);
  const d2  = d1 - iv * sqT;

  // Approximation of N(x) — cumulative normal distribution
  function Ncdf(x) {
    const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
    const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1.0 / (1.0 + p * Math.abs(x));
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  }

  if (type === 'call') {
    return Math.max(0, spotPrice * Ncdf(d1) - strike * Ncdf(d2));
  } else {
    return Math.max(0, strike * Ncdf(-d2) - spotPrice * Ncdf(-d1));
  }
}

// ─── Static options chain seed data ──────────────────────────────────────────
const UNDERLYINGS = {
  BTC:  { spot: 67_420, iv_base: 0.72 },
  ETH:  { spot: 3_512,  iv_base: 0.78 },
  SOL:  { spot: 172.4,  iv_base: 0.95 },
  ALEO: { spot: 2.18,   iv_base: 1.10 },
  HIVE: { spot: 0.84,   iv_base: 1.20 },
};

const EXPIRIES = [
  { label: '7d',  days: 7  },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

/** Generate a deterministic-ish options chain for a given underlying. */
function buildChain(underlying) {
  const base = UNDERLYINGS[underlying];
  if (!base) return null;

  const spot    = jitter(base.spot, 0.001);
  const iv_base = base.iv_base;
  const markets = [];

  for (const expiry of EXPIRIES) {
    const strikeMults = [0.85, 0.90, 0.95, 1.00, 1.05, 1.10, 1.15];
    for (const mult of strikeMults) {
      const strike = parseFloat((base.spot * mult).toFixed(4));
      const iv     = parseFloat(jitter(iv_base * (1 + Math.abs(mult - 1) * 0.3), 0.02).toFixed(4));
      const expDate = new Date();
      expDate.setUTCDate(expDate.getUTCDate() + expiry.days);
      expDate.setUTCHours(8, 0, 0, 0);

      for (const type of ['call', 'put']) {
        const premium_raw   = approxPremium(spot, strike, expiry.days, iv, type);
        const premium_usdc  = parseFloat(Math.max(0.01, premium_raw).toFixed(4));

        // Greeks (approximations)
        const direction = type === 'call' ? 1 : -1;
        const moneyness = spot / strike;
        const delta     = parseFloat((direction * Math.max(0.01, Math.min(0.99,
          type === 'call' ? moneyness * 0.5 : (1 - moneyness * 0.5)
        )).toFixed(4)));
        const gamma     = parseFloat((0.05 / (spot * iv * Math.sqrt(expiry.days / 365))).toFixed(6));

        markets.push({
          id:           `${underlying}-${expiry.label}-${strike}-${type.toUpperCase()}`,
          underlying,
          type,
          strike,
          expiry:       expDate.toISOString(),
          expiry_label: expiry.label,
          premium_usdc,
          delta,
          gamma,
          iv,
          spot_ref:     parseFloat(spot.toFixed(4)),
          open_interest: Math.round(jitter(500, 0.3)),
          volume_24h:    Math.round(jitter(200, 0.5)),
        });
      }
    }

    // Also add a forward/future for each expiry
    const futurePrice = parseFloat((spot * (1 + 0.05 * expiry.days / 365)).toFixed(4));
    const expDate     = new Date();
    expDate.setUTCDate(expDate.getUTCDate() + expiry.days);
    expDate.setUTCHours(8, 0, 0, 0);

    markets.push({
      id:           `${underlying}-${expiry.label}-FUTURE`,
      underlying,
      type:         'future',
      strike:       null,
      expiry:       expDate.toISOString(),
      expiry_label: expiry.label,
      premium_usdc: parseFloat(futurePrice.toFixed(4)),
      delta:        1.0,
      gamma:        0.0,
      iv:           null,
      spot_ref:     parseFloat(spot.toFixed(4)),
      open_interest: Math.round(jitter(1200, 0.2)),
      volume_24h:    Math.round(jitter(800, 0.3)),
    });
  }

  return { underlying, spot_ref: parseFloat(spot.toFixed(4)), markets };
}

/** Pre-build a combined list of all derivative markets. */
function getAllMarkets() {
  return Object.keys(UNDERLYINGS).flatMap(u => {
    const chain = buildChain(u);
    return chain ? chain.markets : [];
  });
}

// ─── GET /v1/exchange/derivatives/markets ────────────────────────────────────
router.get('/markets', rateLimit(), (req, res) => {
  try {
    const markets = getAllMarkets();
    ok(res, {
      markets,
      count: markets.length,
      underlyings: Object.keys(UNDERLYINGS),
      timestamp: new Date().toISOString(),
      note: 'Synthetic options and futures. No real asset delivery. Settled in USDC.',
    });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/derivatives/chain/:underlying ───────────────────────────
router.get('/chain/:underlying', rateLimit(), (req, res) => {
  try {
    const ul = req.params.underlying.toUpperCase();
    if (!UNDERLYINGS[ul]) {
      return err(res, 'UNDERLYING_NOT_FOUND',
        `Underlying ${ul} not found. Available: ${Object.keys(UNDERLYINGS).join(', ')}`, 404);
    }
    const chain = buildChain(ul);
    ok(res, {
      ...chain,
      count: chain.markets.length,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── POST /v1/exchange/derivatives/positions — Buy or write an option ─────────
router.post('/positions', requireDid, rateLimit(), (req, res) => {
  try {
    const {
      market_id,
      side,
      contracts,
      premium_usdc,
    } = req.body;

    const did = req.hive_did;

    if (!market_id || !side || !contracts || !premium_usdc) {
      return err(res, 'MISSING_FIELDS',
        'market_id, side, contracts, and premium_usdc are required');
    }
    if (!['buy', 'write'].includes(side)) {
      return err(res, 'INVALID_SIDE', 'side must be buy or write');
    }

    const contractsNum = parseFloat(contracts);
    if (contractsNum <= 0) {
      return err(res, 'INVALID_CONTRACTS', 'contracts must be positive');
    }

    // Look up market from chain
    const allMarkets = getAllMarkets();
    const market     = allMarkets.find(m => m.id === market_id);
    if (!market) {
      return err(res, 'MARKET_NOT_FOUND',
        `Derivative market ${market_id} not found. Use GET /v1/exchange/derivatives/markets to list markets`, 404);
    }

    const premiumNum   = parseFloat(premium_usdc);
    const total_premium = parseFloat((premiumNum * contractsNum).toFixed(4));

    const position = {
      id:             uuidv4(),
      did,
      market_id,
      underlying:     market.underlying,
      type:           market.type,
      side,
      strike:         market.strike,
      expiry:         market.expiry,
      contracts:      contractsNum,
      premium_usdc:   premiumNum,
      total_premium_usdc: total_premium,
      entry_spot:     market.spot_ref,
      delta:          market.delta,
      gamma:          market.gamma,
      iv:             market.iv,
      status:         'open',
      pnl_usdc:       0,
      created_at:     new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    };

    derivPositions.set(position.id, position);

    ok(res, {
      position_id:        position.id,
      market_id,
      underlying:         market.underlying,
      type:               market.type,
      side,
      strike:             market.strike,
      expiry:             market.expiry,
      contracts:          contractsNum,
      premium_usdc:       premiumNum,
      total_premium_usdc: total_premium,
      entry_spot:         market.spot_ref,
      delta:              market.delta,
      status:             'open',
      created_at:         position.created_at,
      note:               'Synthetic option position. No real asset delivery. Settled in USDC.',
    }, 201);
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/derivatives/positions?did= ──────────────────────────────
router.get('/positions', optionalDid, rateLimit(), (req, res) => {
  try {
    const filterDid = req.query.did || req.hive_did;
    if (!filterDid) {
      return err(res, 'DID_REQUIRED', 'Provide ?did= query param or x-hive-did header', 400);
    }

    const positions = Array.from(derivPositions.values())
      .filter(p => p.did === filterDid)
      .map(p => {
        if (p.status !== 'open') return p;
        // Simulate live greeks update
        const base = UNDERLYINGS[p.underlying];
        if (!base) return p;
        const current_spot = jitter(base.spot, 0.005);
        const daysLeft     = Math.max(0.1,
          (new Date(p.expiry) - Date.now()) / (1000 * 60 * 60 * 24));
        const current_premium = p.type !== 'future'
          ? parseFloat(approxPremium(current_spot, p.strike, daysLeft, p.iv || 0.8, p.type).toFixed(4))
          : parseFloat(jitter(current_spot * (1 + 0.05 * daysLeft / 365), 0.002).toFixed(4));

        const direction = p.side === 'buy' ? 1 : -1;
        const pnl_usdc  = parseFloat(
          ((current_premium - p.premium_usdc) * p.contracts * direction).toFixed(4));

        return {
          ...p,
          current_spot:    parseFloat(current_spot.toFixed(4)),
          current_premium,
          pnl_usdc,
        };
      });

    ok(res, { positions, count: positions.length, did: filterDid });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── POST /v1/exchange/derivatives/positions/:id/exercise ─────────────────────
router.post('/positions/:id/exercise', requireDid, rateLimit(), (req, res) => {
  try {
    const { id } = req.params;
    const did    = req.hive_did;
    const pos    = derivPositions.get(id);

    if (!pos) {
      return err(res, 'POSITION_NOT_FOUND', `Derivative position ${id} not found`, 404);
    }
    if (pos.did !== did) {
      return err(res, 'FORBIDDEN', 'You can only exercise your own positions', 403);
    }
    if (pos.status !== 'open') {
      return err(res, 'POSITION_NOT_OPEN', `Position is already ${pos.status}`);
    }
    if (pos.side !== 'buy') {
      return err(res, 'NOT_EXERCISABLE',
        'Only bought options can be exercised. Written options expire or are assigned.');
    }

    const base         = UNDERLYINGS[pos.underlying] || { spot: pos.entry_spot };
    const current_spot = jitter(base.spot, 0.003);

    let intrinsic_value = 0;
    let in_the_money    = false;

    if (pos.type === 'call') {
      intrinsic_value = Math.max(0, current_spot - pos.strike);
      in_the_money    = current_spot > pos.strike;
    } else if (pos.type === 'put') {
      intrinsic_value = Math.max(0, pos.strike - current_spot);
      in_the_money    = current_spot < pos.strike;
    } else {
      // Future settlement
      intrinsic_value = Math.abs(current_spot - pos.entry_spot);
      in_the_money    = true;
    }

    const gross_settlement   = parseFloat((intrinsic_value * pos.contracts).toFixed(4));
    const fee                = parseFloat((gross_settlement * 0.001).toFixed(4));
    const net_settlement_usdc = parseFloat((gross_settlement - fee - pos.total_premium_usdc).toFixed(4));

    const exercised = {
      ...pos,
      status:               'exercised',
      exit_spot:            parseFloat(current_spot.toFixed(4)),
      intrinsic_value,
      gross_settlement_usdc: gross_settlement,
      fee_usdc:             fee,
      net_settlement_usdc,
      in_the_money,
      exercised_at:         new Date().toISOString(),
    };
    derivPositions.set(id, exercised);

    const zk_receipt = {
      receipt_id:            uuidv4(),
      type:                  'option_exercise',
      position_id:           id,
      did,
      market_id:             pos.market_id,
      underlying:            pos.underlying,
      option_type:           pos.type,
      strike:                pos.strike,
      expiry:                pos.expiry,
      contracts:             pos.contracts,
      spot_at_exercise:      parseFloat(current_spot.toFixed(4)),
      intrinsic_value,
      gross_settlement_usdc: gross_settlement,
      fee_usdc:              fee,
      net_settlement_usdc,
      in_the_money,
      settlement_rail:       'usdcx',
      zk_proof_stub:         `0x${uuidv4().replace(/-/g, '')}${uuidv4().replace(/-/g, '')}`,
      settled_at:            new Date().toISOString(),
      note:                  'ZK receipt stub. Full Aleo proof generation available via HiveGate.',
    };

    ok(res, {
      position_id:           id,
      status:                'exercised',
      in_the_money,
      intrinsic_value,
      gross_settlement_usdc: gross_settlement,
      fee_usdc:              fee,
      net_settlement_usdc,
      zk_receipt,
    });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

export default router;
