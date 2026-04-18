// amm.js — Uniswap v2-style AMM (constant product: x * y = k)
import { v4 as uuidv4 } from 'uuid';
import { isInMemory, store, query, memInsert, memGet, memUpdate } from './db.js';

const SWAP_FEE_TOTAL = 0.003;    // 0.30%
const SWAP_FEE_LP = 0.0025;     // 0.25% to LPs
const SWAP_FEE_HIVE = 0.0005;   // 0.05% to Hive
const MAX_PRICE_IMPACT = 0.05;  // 5% max slippage

// ─── Pool Creation ────────────────────────────────────────────────────────────
export async function createPool({ market_id, initial_base, initial_quote, creator_did }) {
  const reserve_base = parseFloat(initial_base);
  const reserve_quote = parseFloat(initial_quote);

  if (reserve_base <= 0 || reserve_quote <= 0) {
    throw new Error('Initial reserves must be positive');
  }

  const k_constant = reserve_base * reserve_quote;
  const lp_shares = Math.sqrt(k_constant); // Initial LP shares = sqrt(k)

  const pool = {
    id: uuidv4(),
    market_id,
    reserve_base,
    reserve_quote,
    k_constant,
    total_lp_shares: lp_shares,
    lp_positions: { [creator_did]: lp_shares },
    status: 'active',
    created_by_did: creator_did,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (isInMemory()) {
    memInsert('pools', pool);
    return pool;
  }

  await query(
    `INSERT INTO pools
     (id, market_id, reserve_base, reserve_quote, k_constant,
      total_lp_shares, lp_positions, status, created_by_did, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      pool.id, market_id, reserve_base, reserve_quote, k_constant,
      lp_shares, JSON.stringify({ [creator_did]: lp_shares }),
      'active', creator_did, pool.created_at, pool.updated_at,
    ]
  );
  return pool;
}

// ─── Add Liquidity ────────────────────────────────────────────────────────────
export async function addLiquidity({ pool_id, base_amount, quote_amount, provider_did }) {
  const pool = await getPool(pool_id);
  if (!pool) throw new Error('Pool not found');
  if (pool.status !== 'active') throw new Error('Pool is not active');

  const base = parseFloat(base_amount);
  const quote = parseFloat(quote_amount);
  const rb = parseFloat(pool.reserve_base);
  const rq = parseFloat(pool.reserve_quote);
  const totalShares = parseFloat(pool.total_lp_shares);

  // Calculate actual amounts to maintain ratio
  const expectedQuote = (base / rb) * rq;
  const actualBase = base;
  const actualQuote = Math.min(quote, expectedQuote);

  // LP shares minted proportional to base contribution
  const sharesMinted = (actualBase / rb) * totalShares;

  const newReserveBase = rb + actualBase;
  const newReserveQuote = rq + actualQuote;
  const newK = newReserveBase * newReserveQuote;
  const newTotalShares = totalShares + sharesMinted;

  const lp_positions = typeof pool.lp_positions === 'string'
    ? JSON.parse(pool.lp_positions)
    : { ...pool.lp_positions };
  lp_positions[provider_did] = (lp_positions[provider_did] || 0) + sharesMinted;

  const updates = {
    reserve_base: newReserveBase,
    reserve_quote: newReserveQuote,
    k_constant: newK,
    total_lp_shares: newTotalShares,
    lp_positions,
  };

  if (isInMemory()) {
    memUpdate('pools', pool_id, updates);
  } else {
    await query(
      `UPDATE pools SET reserve_base=$1, reserve_quote=$2, k_constant=$3,
       total_lp_shares=$4, lp_positions=$5, updated_at=NOW()
       WHERE id=$6`,
      [newReserveBase, newReserveQuote, newK, newTotalShares,
       JSON.stringify(lp_positions), pool_id]
    );
  }

  return {
    pool_id,
    actual_base_added: actualBase,
    actual_quote_added: actualQuote,
    shares_minted: sharesMinted,
    new_price: newReserveQuote / newReserveBase,
    provider_shares: lp_positions[provider_did],
  };
}

// ─── Remove Liquidity ─────────────────────────────────────────────────────────
export async function removeLiquidity({ pool_id, shares, provider_did }) {
  const pool = await getPool(pool_id);
  if (!pool) throw new Error('Pool not found');

  const lp_positions = typeof pool.lp_positions === 'string'
    ? JSON.parse(pool.lp_positions)
    : { ...pool.lp_positions };

  const providerShares = lp_positions[provider_did] || 0;
  const sharesToRedeem = Math.min(parseFloat(shares), providerShares);

  if (sharesToRedeem <= 0) throw new Error('No LP shares to redeem');

  const totalShares = parseFloat(pool.total_lp_shares);
  const fraction = sharesToRedeem / totalShares;

  const rb = parseFloat(pool.reserve_base);
  const rq = parseFloat(pool.reserve_quote);

  const base_returned = rb * fraction;
  const quote_returned = rq * fraction;

  const newReserveBase = rb - base_returned;
  const newReserveQuote = rq - quote_returned;
  const newK = newReserveBase * newReserveQuote;
  const newTotalShares = totalShares - sharesToRedeem;

  lp_positions[provider_did] = providerShares - sharesToRedeem;
  if (lp_positions[provider_did] <= 0) delete lp_positions[provider_did];

  const updates = {
    reserve_base: newReserveBase,
    reserve_quote: newReserveQuote,
    k_constant: newK,
    total_lp_shares: newTotalShares,
    lp_positions,
  };

  if (isInMemory()) {
    memUpdate('pools', pool_id, updates);
  } else {
    await query(
      `UPDATE pools SET reserve_base=$1, reserve_quote=$2, k_constant=$3,
       total_lp_shares=$4, lp_positions=$5, updated_at=NOW()
       WHERE id=$6`,
      [newReserveBase, newReserveQuote, newK, newTotalShares,
       JSON.stringify(lp_positions), pool_id]
    );
  }

  return {
    pool_id,
    shares_redeemed: sharesToRedeem,
    base_returned,
    quote_returned,
  };
}

// ─── AMM Swap ─────────────────────────────────────────────────────────────────
export async function ammSwap({ pool_id, input_asset, input_amount, override_slippage, swapper_did }) {
  const pool = await getPool(pool_id);
  if (!pool) throw new Error('Pool not found');
  if (pool.status !== 'active') throw new Error('Pool is not active');

  const amountIn = parseFloat(input_amount);
  if (amountIn <= 0) throw new Error('Input amount must be positive');

  const rb = parseFloat(pool.reserve_base);
  const rq = parseFloat(pool.reserve_quote);

  // Determine direction
  let reserveIn, reserveOut, outputAsset;
  if (input_asset === 'base') {
    reserveIn = rb;
    reserveOut = rq;
    outputAsset = 'quote';
  } else {
    reserveIn = rq;
    reserveOut = rb;
    outputAsset = 'base';
  }

  // Constant product formula with fee
  const amountInWithFee = amountIn * (1 - SWAP_FEE_TOTAL);
  const amountOut = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);

  // Price impact
  const spotPriceBefore = reserveOut / reserveIn;
  const effectivePrice = amountOut / amountIn;
  const priceImpact = Math.abs(1 - effectivePrice / spotPriceBefore);

  if (priceImpact > MAX_PRICE_IMPACT && !override_slippage) {
    throw new Error(
      `Price impact ${(priceImpact * 100).toFixed(2)}% exceeds 5% limit. Pass override_slippage: true to proceed.`
    );
  }

  const hiveFee = amountIn * SWAP_FEE_HIVE;

  // Update reserves
  let newReserveBase, newReserveQuote;
  if (input_asset === 'base') {
    newReserveBase = rb + amountIn;
    newReserveQuote = rq - amountOut;
  } else {
    newReserveBase = rb - amountOut;
    newReserveQuote = rq + amountIn;
  }

  const newK = newReserveBase * newReserveQuote;

  const updates = {
    reserve_base: newReserveBase,
    reserve_quote: newReserveQuote,
    k_constant: newK,
  };

  if (isInMemory()) {
    memUpdate('pools', pool_id, updates);
  } else {
    await query(
      `UPDATE pools SET reserve_base=$1, reserve_quote=$2, k_constant=$3, updated_at=NOW()
       WHERE id=$4`,
      [newReserveBase, newReserveQuote, newK, pool_id]
    );
  }

  return {
    pool_id,
    input_asset,
    input_amount: amountIn,
    output_asset: outputAsset,
    output_amount: amountOut,
    price_impact_pct: parseFloat((priceImpact * 100).toFixed(4)),
    swap_fee_total: amountIn * SWAP_FEE_TOTAL,
    hive_fee: hiveFee,
    new_price_base_per_quote: newReserveQuote / newReserveBase,
  };
}

// ─── Pool State ────────────────────────────────────────────────────────────────
export async function getPool(pool_id) {
  if (isInMemory()) {
    return memGet('pools', pool_id);
  }
  const res = await query('SELECT * FROM pools WHERE id = $1', [pool_id]);
  if (!res.rows.length) return null;
  const p = res.rows[0];
  if (typeof p.lp_positions === 'string') p.lp_positions = JSON.parse(p.lp_positions);
  return p;
}

export function poolState(pool) {
  const rb = parseFloat(pool.reserve_base);
  const rq = parseFloat(pool.reserve_quote);
  return {
    ...pool,
    price_base: rq / rb,          // quote per base
    price_quote: rb / rq,         // base per quote
    k: parseFloat(pool.k_constant),
    total_lp_shares: parseFloat(pool.total_lp_shares),
  };
}
