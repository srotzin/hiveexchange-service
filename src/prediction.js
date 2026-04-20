// prediction.js — Prediction markets: LMSR odds, betting, resolution, payouts
import { v4 as uuidv4 } from 'uuid';
import https from 'https';
import http from 'http';
import {
  isInMemory, store, query, memInsert, memGet, memUpdate, memList,
  snapshotMarket, getSnapshots,
} from './db.js';

// ─── HiveBank resolution fee recorder ──────────────────────────────────
async function recordResolutionFee(marketId, feeUsdc) {
  try {
    const payload = Buffer.from(JSON.stringify({
      from_did: 'did:hive:hiveexchange-treasury',
      to_did: 'did:hive:hiveforce-treasury',
      amount_usdc: feeUsdc,
      rail: 'base-usdc',
      memo: `HiveExchange 2% resolution fee — market ${marketId}`,
      hive_fee_usdc: feeUsdc,
    }));
    const url = new URL('https://hivebank.onrender.com/v1/bank/vault/deposit');
    const lib = url.protocol === 'https:' ? https : http;
    await new Promise((resolve) => {
      const req = lib.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'x-hive-internal': 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46',
        },
        timeout: 5000,
      }, resolve);
      req.on('error', resolve); // fire and forget
      req.write(payload);
      req.end();
    });
  } catch (_) { /* fire and forget */ }
}

export { getSnapshots };

const HIVE_FEE_PCT = 0.02;  // 2% Hive fee on resolution
const MIN_POOL_EACH = 10;   // 10 USDC minimum per side

export const VALID_CATEGORIES = [
  'construction',
  'agent',
  'general',
  'weather',
  'seismic',
  'natural_disaster',
  'housing',
  'legal',
  'macro',
  'energy',
  'crypto',
  'labor',
  'climate',
  'geopolitical',
  'tech',
  'real_estate',
  'sports',
  'meta',
  'space',
];

// ─── Odds Calculation (LMSR-style simplified) ─────────────────────────────────
export function calcOdds(yes_pool, no_pool) {
  const total = parseFloat(yes_pool) + parseFloat(no_pool);
  if (total === 0) return { yes: 0.5, no: 0.5 };
  const yesPrice = parseFloat(yes_pool) / total;
  const noPrice = parseFloat(no_pool) / total;
  return {
    yes: parseFloat(yesPrice.toFixed(6)),
    no: parseFloat(noPrice.toFixed(6)),
    total_pool: total,
  };
}

/**
 * Shares received for a bet using LMSR-style pricing.
 * Simplified: shares = amount / current_odds_price
 * So if YES is at 0.6 and you bet $100, you get 100/0.6 ≈ 166.67 shares
 * worth $1 each on resolution.
 */
export function calcShares(amount_usdc, side, yes_pool, no_pool) {
  const odds = calcOdds(yes_pool, no_pool);
  const price = side === 'YES' ? odds.yes : odds.no;
  if (price <= 0) return 0;
  return parseFloat(amount_usdc) / price;
}

/**
 * Potential payout if this side wins.
 * Payout per share = 1.0 USDC on win (before fee).
 */
export function calcPotentialPayout(shares, total_pool) {
  // Winner gets proportional share of total pool
  return parseFloat(shares) * 1.0; // Simplified: each share = $1 face value
}

// ─── Create Prediction Market ──────────────────────────────────────────────────
export async function createPredictMarket({
  question, resolution_criteria, resolution_date, category,
  settlement_rail, creator_did, initial_yes = MIN_POOL_EACH, initial_no = MIN_POOL_EACH,
  meta_market_id = null,
}) {
  const market = {
    id: uuidv4(),
    question,
    resolution_criteria: resolution_criteria || question,
    category: category || 'general',
    resolution_date: resolution_date || null,
    status: 'open',
    outcome: null,
    yes_pool_usdc: Math.max(parseFloat(initial_yes), MIN_POOL_EACH),
    no_pool_usdc: Math.max(parseFloat(initial_no), MIN_POOL_EACH),
    total_volume_usdc: 0,
    creator_did: creator_did || null,
    settlement_rail: settlement_rail || 'usdc',
    meta_market_id: meta_market_id || null,
    created_at: new Date().toISOString(),
    resolved_at: null,
  };

  if (isInMemory()) {
    store.predictMarkets.set(market.id, market);
    return market;
  }

  await query(
    `INSERT INTO predict_markets
     (id, question, resolution_criteria, category, resolution_date,
      status, outcome, yes_pool_usdc, no_pool_usdc, total_volume_usdc,
      creator_did, settlement_rail, meta_market_id, created_at, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      market.id, market.question, market.resolution_criteria, market.category,
      market.resolution_date, market.status, market.outcome,
      market.yes_pool_usdc, market.no_pool_usdc, market.total_volume_usdc,
      market.creator_did, market.settlement_rail, market.meta_market_id,
      market.created_at, market.resolved_at,
    ]
  );
  return market;
}

// ─── Get Predict Market ────────────────────────────────────────────────────────
export async function getPredictMarket(market_id) {
  if (isInMemory()) return store.predictMarkets.get(market_id) || null;
  const res = await query('SELECT * FROM predict_markets WHERE id = $1', [market_id]);
  return res.rows[0] || null;
}

// ─── List Predict Markets ──────────────────────────────────────────────────────
export async function listPredictMarkets({ category, status } = {}) {
  if (isInMemory()) {
    return Array.from(store.predictMarkets.values())
      .filter((m) => {
        if (category && m.category !== category) return false;
        if (status && m.status !== status) return false;
        return true;
      })
      .sort((a, b) => parseFloat(b.total_volume_usdc) - parseFloat(a.total_volume_usdc));
  }

  let sql = 'SELECT * FROM predict_markets WHERE 1=1';
  const params = [];
  if (category) { sql += ` AND category = $${params.length + 1}`; params.push(category); }
  if (status) { sql += ` AND status = $${params.length + 1}`; params.push(status); }
  sql += ' ORDER BY total_volume_usdc DESC, created_at DESC';

  const res = await query(sql, params);
  return res.rows;
}

// ─── Place Bet ────────────────────────────────────────────────────────────────
export async function placeBet({ market_id, did, side, amount_usdc, settlement_rail }) {
  const market = await getPredictMarket(market_id);
  if (!market) throw new Error('Prediction market not found');
  if (market.status !== 'open') throw new Error('Market is not open for betting');
  if (!['YES', 'NO'].includes(side)) throw new Error('Side must be YES or NO');

  const amount = parseFloat(amount_usdc);
  if (amount <= 0) throw new Error('Amount must be positive');

  const yes_pool = parseFloat(market.yes_pool_usdc);
  const no_pool = parseFloat(market.no_pool_usdc);
  const odds = calcOdds(yes_pool, no_pool);
  const entry_price = side === 'YES' ? odds.yes : odds.no;
  const shares = calcShares(amount, side, yes_pool, no_pool);

  // Update pool — bet goes to the opposite pool (AMM-style market making)
  const new_yes = side === 'YES' ? yes_pool + amount : yes_pool;
  const new_no = side === 'NO' ? no_pool + amount : no_pool;
  const new_volume = parseFloat(market.total_volume_usdc) + amount;

  const position = {
    id: uuidv4(),
    market_id,
    did,
    side,
    amount_usdc: amount,
    shares: parseFloat(shares.toFixed(8)),
    entry_price: parseFloat(entry_price.toFixed(6)),
    payout_usdc: null,
    status: 'open',
    settlement_rail: settlement_rail || market.settlement_rail || 'usdc',
    created_at: new Date().toISOString(),
  };

  if (isInMemory()) {
    store.positions.set(position.id, position);
    store.predictMarkets.set(market_id, {
      ...market,
      yes_pool_usdc: new_yes,
      no_pool_usdc: new_no,
      total_volume_usdc: new_volume,
    });
    // Snapshot for sparkline / meta-market resolution
    const posCount = Array.from(store.positions.values()).filter(p => p.market_id === market_id).length;
    snapshotMarket(market_id, {
      yes_pool: new_yes,
      no_pool: new_no,
      total_volume: new_volume,
      position_count: posCount,
    });
  } else {
    await query(
      `INSERT INTO positions
       (id, market_id, did, side, amount_usdc, shares, entry_price,
        payout_usdc, status, settlement_rail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        position.id, market_id, did, side, amount, position.shares,
        position.entry_price, null, 'open',
        position.settlement_rail, position.created_at,
      ]
    );
    await query(
      `UPDATE predict_markets SET yes_pool_usdc=$1, no_pool_usdc=$2, total_volume_usdc=$3
       WHERE id=$4`,
      [new_yes, new_no, new_volume, market_id]
    );
    // Snapshot for PG mode too
    snapshotMarket(market_id, {
      yes_pool: new_yes,
      no_pool: new_no,
      total_volume: new_volume,
      position_count: null, // would need extra query
    });
  }

  const newOdds = calcOdds(new_yes, new_no);
  const potential_payout = shares * (1 - HIVE_FEE_PCT);

  return {
    position_id: position.id,
    market_id,
    side,
    amount_usdc: amount,
    shares: position.shares,
    entry_price: position.entry_price,
    current_odds: newOdds,
    potential_payout: parseFloat(potential_payout.toFixed(8)),
  };
}

// ─── Resolve Market ────────────────────────────────────────────────────────────
export async function resolveMarket({ market_id, outcome, resolver_did }) {
  const market = await getPredictMarket(market_id);
  if (!market) throw new Error('Prediction market not found');
  if (market.status !== 'open') throw new Error('Market already resolved or closed');
  if (!['YES', 'NO', 'VOID'].includes(outcome)) throw new Error('Outcome must be YES, NO, or VOID');

  const resolved_at = new Date().toISOString();
  const total_pool = parseFloat(market.yes_pool_usdc) + parseFloat(market.no_pool_usdc);

  // Get all positions for this market
  let positions;
  if (isInMemory()) {
    positions = Array.from(store.positions.values()).filter(
      (p) => p.market_id === market_id && p.status === 'open'
    );
  } else {
    const res = await query(
      "SELECT * FROM positions WHERE market_id = $1 AND status = 'open'",
      [market_id]
    );
    positions = res.rows;
  }

  const payouts = [];

  if (outcome === 'VOID') {
    // Full refund
    for (const pos of positions) {
      const payout_usdc = parseFloat(pos.amount_usdc);
      payouts.push({ position_id: pos.id, did: pos.did, payout_usdc, status: 'void' });
      await updatePosition(pos.id, { payout_usdc, status: 'void' });
    }
  } else {
    // Winners get proportional share of total pool minus 2% Hive fee
    const winners = positions.filter((p) => p.side === outcome);
    const totalWinnerShares = winners.reduce((sum, p) => sum + parseFloat(p.shares), 0);

    for (const pos of positions) {
      if (pos.side === outcome) {
        const shareOfWinnerPool = totalWinnerShares > 0
          ? parseFloat(pos.shares) / totalWinnerShares
          : 0;
        const payout_usdc = parseFloat((total_pool * shareOfWinnerPool * (1 - HIVE_FEE_PCT)).toFixed(8));
        payouts.push({ position_id: pos.id, did: pos.did, payout_usdc, status: 'won' });
        await updatePosition(pos.id, { payout_usdc, status: 'won' });
      } else {
        payouts.push({ position_id: pos.id, did: pos.did, payout_usdc: 0, status: 'lost' });
        await updatePosition(pos.id, { payout_usdc: 0, status: 'lost' });
      }
    }
  }

  // Update market status
  if (isInMemory()) {
    store.predictMarkets.set(market_id, {
      ...market,
      status: outcome === 'VOID' ? 'void' : 'resolved',
      outcome,
      resolved_at,
    });
  } else {
    await query(
      `UPDATE predict_markets SET status=$1, outcome=$2, resolved_at=$3 WHERE id=$4`,
      [outcome === 'VOID' ? 'void' : 'resolved', outcome, resolved_at, market_id]
    );
  }

  // Record 2% resolution fee in HiveBank (fire-and-forget)
  const feeUsdc = parseFloat((total_pool * HIVE_FEE_PCT).toFixed(8));
  if (feeUsdc > 0) {
    recordResolutionFee(market_id, feeUsdc).catch(() => {});
  }

  return {
    market_id,
    outcome,
    resolved_at,
    total_pool_usdc: total_pool,
    hive_fee_usdc: feeUsdc,
    positions_settled: payouts.length,
    payouts,
  };
}

async function updatePosition(position_id, updates) {
  if (isInMemory()) {
    const pos = store.positions.get(position_id);
    if (pos) store.positions.set(position_id, { ...pos, ...updates });
    return;
  }
  const sets = Object.keys(updates).map((k, i) => `${k}=$${i + 1}`).join(', ');
  const vals = Object.values(updates);
  await query(`UPDATE positions SET ${sets} WHERE id=$${vals.length + 1}`, [...vals, position_id]);
}

// ─── Get Positions ─────────────────────────────────────────────────────────────
export async function getPositionsByMarket(market_id) {
  if (isInMemory()) {
    return Array.from(store.positions.values()).filter((p) => p.market_id === market_id);
  }
  const res = await query('SELECT * FROM positions WHERE market_id = $1 ORDER BY created_at DESC', [market_id]);
  return res.rows;
}

export async function getPositionsByDid(did) {
  if (isInMemory()) {
    return Array.from(store.positions.values()).filter((p) => p.did === did);
  }
  const res = await query('SELECT * FROM positions WHERE did = $1 ORDER BY created_at DESC', [did]);
  return res.rows;
}
