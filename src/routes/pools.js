// routes/pools.js — AMM Liquidity Pool routes
import { Router } from 'express';
import {
  createPool, addLiquidity, removeLiquidity, ammSwap, getPool, poolState,
} from '../amm.js';
import { requireDid } from '../middleware/did-auth.js';
import { rateLimit } from '../middleware/rate-limit.js';

const router = Router();

const ok = (res, data, status = 200) => res.status(status).json({ status: 'ok', data });
const err = (res, code, detail, status = 400) =>
  res.status(status).json({ status: 'error', error: code, detail });

// ─── POST /v1/exchange/pools — Create pool ────────────────────────────────────
router.post('/', requireDid, rateLimit(), async (req, res) => {
  try {
    const { market_id, initial_base, initial_quote } = req.body;

    if (!market_id || !initial_base || !initial_quote) {
      return err(res, 'MISSING_FIELDS', 'market_id, initial_base, and initial_quote are required');
    }

    if (parseFloat(initial_base) <= 0 || parseFloat(initial_quote) <= 0) {
      return err(res, 'INVALID_AMOUNTS', 'Initial reserves must be positive');
    }

    const pool = await createPool({
      market_id,
      initial_base,
      initial_quote,
      creator_did: req.hive_did,
    });

    ok(res, { pool: poolState(pool) }, 201);
  } catch (e) {
    err(res, 'POOL_CREATE_FAILED', e.message, 500);
  }
});

// ─── GET /v1/exchange/pools/:pool_id — Pool state ─────────────────────────────
router.get('/:pool_id', rateLimit(), async (req, res) => {
  try {
    const pool = await getPool(req.params.pool_id);
    if (!pool) return err(res, 'POOL_NOT_FOUND', `Pool ${req.params.pool_id} not found`, 404);
    ok(res, { pool: poolState(pool) });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── POST /v1/exchange/pools/:pool_id/add — Add liquidity ─────────────────────
router.post('/:pool_id/add', requireDid, rateLimit(), async (req, res) => {
  try {
    const { base_amount, quote_amount } = req.body;

    if (!base_amount || !quote_amount) {
      return err(res, 'MISSING_FIELDS', 'base_amount and quote_amount are required');
    }

    const result = await addLiquidity({
      pool_id: req.params.pool_id,
      base_amount,
      quote_amount,
      provider_did: req.hive_did,
    });

    ok(res, result);
  } catch (e) {
    if (e.message.includes('not found')) return err(res, 'POOL_NOT_FOUND', e.message, 404);
    err(res, 'ADD_LIQUIDITY_FAILED', e.message, 400);
  }
});

// ─── POST /v1/exchange/pools/:pool_id/remove — Remove liquidity ───────────────
router.post('/:pool_id/remove', requireDid, rateLimit(), async (req, res) => {
  try {
    const { shares } = req.body;

    if (!shares || parseFloat(shares) <= 0) {
      return err(res, 'MISSING_FIELDS', 'shares is required and must be positive');
    }

    const result = await removeLiquidity({
      pool_id: req.params.pool_id,
      shares,
      provider_did: req.hive_did,
    });

    ok(res, result);
  } catch (e) {
    if (e.message.includes('not found')) return err(res, 'POOL_NOT_FOUND', e.message, 404);
    err(res, 'REMOVE_LIQUIDITY_FAILED', e.message, 400);
  }
});

// ─── POST /v1/exchange/pools/:pool_id/swap — AMM swap ────────────────────────
router.post('/:pool_id/swap', requireDid, rateLimit(), async (req, res) => {
  try {
    const { input_asset, input_amount, override_slippage = false } = req.body;

    if (!input_asset || !input_amount) {
      return err(res, 'MISSING_FIELDS', 'input_asset (base|quote) and input_amount are required');
    }

    if (!['base', 'quote'].includes(input_asset)) {
      return err(res, 'INVALID_INPUT_ASSET', 'input_asset must be base or quote');
    }

    if (parseFloat(input_amount) <= 0) {
      return err(res, 'INVALID_AMOUNT', 'input_amount must be positive');
    }

    const result = await ammSwap({
      pool_id: req.params.pool_id,
      input_asset,
      input_amount,
      override_slippage,
      swapper_did: req.hive_did,
    });

    ok(res, result);
  } catch (e) {
    if (e.message.includes('not found')) return err(res, 'POOL_NOT_FOUND', e.message, 404);
    if (e.message.includes('Price impact')) return err(res, 'SLIPPAGE_TOO_HIGH', e.message, 400);
    err(res, 'SWAP_FAILED', e.message, 400);
  }
});

export default router;
