// routes/predict.js — Prediction market routes
import { Router } from 'express';
import {
  createPredictMarket, getPredictMarket, listPredictMarkets,
  placeBet, resolveMarket, getPositionsByMarket, getPositionsByDid,
  calcOdds, VALID_CATEGORIES, getSnapshots,
} from '../prediction.js';
import { isInMemory, store } from '../db.js';
import { requireDid, requireInternalKey, optionalDid } from '../middleware/did-auth.js';
import { rateLimit } from '../middleware/rate-limit.js';

const router = Router();

const ok = (res, data, status = 200) => res.status(status).json({ status: 'ok', data });
const err = (res, code, detail, status = 400) =>
  res.status(status).json({ status: 'error', error: code, detail });

// ─── POST /v1/exchange/predict/markets — Create prediction market ──────────────
router.post('/markets', requireDid, rateLimit(), async (req, res) => {
  try {
    const {
      question, resolution_criteria, resolution_date,
      category = 'general', settlement_rail = 'usdc',
      initial_yes = 10, initial_no = 10,
    } = req.body;

    if (!question) {
      return err(res, 'MISSING_FIELDS', 'question is required');
    }

    if (!VALID_CATEGORIES.includes(category)) {
      return err(res, 'INVALID_CATEGORY', `category must be one of: ${VALID_CATEGORIES.join(', ')}`);
    }

    // Phase 1: note minimum pool requirement but don't enforce on-chain deposit
    const minPoolNote = parseFloat(initial_yes) < 10 || parseFloat(initial_no) < 10
      ? 'Pool seeded at minimum 10 USDC each side (Phase 1: deposit enforced in Phase 2)'
      : null;

    const market = await createPredictMarket({
      question,
      resolution_criteria,
      resolution_date,
      category,
      settlement_rail,
      creator_did: req.hive_did,
      initial_yes: Math.max(parseFloat(initial_yes) || 10, 10),
      initial_no: Math.max(parseFloat(initial_no) || 10, 10),
    });

    const odds = calcOdds(market.yes_pool_usdc, market.no_pool_usdc);

    ok(res, {
      market,
      current_odds: odds,
      note: minPoolNote,
      min_pool_deposit_usdc: 10,
      phase: 1,
    }, 201);
  } catch (e) {
    err(res, 'CREATE_FAILED', e.message, 500);
  }
});

// ─── GET /v1/exchange/predict/markets — List prediction markets ───────────────
router.get('/markets', rateLimit(), async (req, res) => {
  try {
    const { category, status } = req.query;

    if (category && !VALID_CATEGORIES.includes(category)) {
      return err(res, 'INVALID_CATEGORY', `category must be one of: ${VALID_CATEGORIES.join(', ')}`);
    }

    const markets = await listPredictMarkets({ category, status });

    // Enrich with odds
    const enriched = markets.map((m) => ({
      ...m,
      current_odds: calcOdds(m.yes_pool_usdc, m.no_pool_usdc),
    }));

    ok(res, {
      markets: enriched,
      count: enriched.length,
      sort: 'volume_desc',
      filters: { category: category || null, status: status || null },
      valid_categories: VALID_CATEGORIES,
    });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/predict/markets/:market_id — Market detail + odds ───────
router.get('/markets/:market_id', rateLimit(), async (req, res) => {
  try {
    const market = await getPredictMarket(req.params.market_id);
    if (!market) return err(res, 'MARKET_NOT_FOUND', `Market ${req.params.market_id} not found`, 404);

    const odds = calcOdds(market.yes_pool_usdc, market.no_pool_usdc);

    ok(res, {
      market,
      current_odds: odds,
      implied_prob: { YES: `${(odds.yes * 100).toFixed(1)}%`, NO: `${(odds.no * 100).toFixed(1)}%` },
    });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── POST /v1/exchange/predict/markets/:market_id/bet — Place bet ─────────────
router.post('/markets/:market_id/bet', requireDid, rateLimit(), async (req, res) => {
  try {
    const { side, amount_usdc, settlement_rail } = req.body;
    const did = req.hive_did;

    if (!side || !amount_usdc) {
      return err(res, 'MISSING_FIELDS', 'side (YES|NO) and amount_usdc are required');
    }

    if (!['YES', 'NO'].includes(side)) {
      return err(res, 'INVALID_SIDE', 'side must be YES or NO');
    }

    if (parseFloat(amount_usdc) <= 0) {
      return err(res, 'INVALID_AMOUNT', 'amount_usdc must be positive');
    }

    const result = await placeBet({
      market_id: req.params.market_id,
      did,
      side,
      amount_usdc,
      settlement_rail,
    });

    ok(res, result, 201);
  } catch (e) {
    if (e.message.includes('not found')) return err(res, 'MARKET_NOT_FOUND', e.message, 404);
    if (e.message.includes('not open')) return err(res, 'MARKET_CLOSED', e.message, 409);
    err(res, 'BET_FAILED', e.message, 400);
  }
});

// ─── POST /v1/exchange/predict/markets/:market_id/resolve — Resolve market ────
router.post('/markets/:market_id/resolve', requireDid, rateLimit(), async (req, res) => {
  try {
    const { outcome } = req.body;
    const did = req.hive_did;

    if (!outcome) {
      return err(res, 'MISSING_FIELDS', 'outcome is required (YES|NO|VOID)');
    }

    if (!['YES', 'NO', 'VOID'].includes(outcome)) {
      return err(res, 'INVALID_OUTCOME', 'outcome must be YES, NO, or VOID');
    }

    // Get market to check authorization
    const market = await getPredictMarket(req.params.market_id);
    if (!market) return err(res, 'MARKET_NOT_FOUND', `Market ${req.params.market_id} not found`, 404);

    // Only creator or Hive internal DID can resolve
    const founderDid = 'did:hive:f150bbec-5660-413e-b305-d8d965b47845';
    const internalKey = req.headers['x-hive-internal-key'];
    const validKey = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

    const isAuthorized =
      did === market.creator_did ||
      did === founderDid ||
      (internalKey && internalKey === validKey);

    if (!isAuthorized) {
      return err(res, 'FORBIDDEN', 'Only the market creator or Hive admin can resolve this market', 403);
    }

    const result = await resolveMarket({
      market_id: req.params.market_id,
      outcome,
      resolver_did: did,
    });

    ok(res, result);
  } catch (e) {
    if (e.message.includes('not found')) return err(res, 'MARKET_NOT_FOUND', e.message, 404);
    if (e.message.includes('already resolved')) return err(res, 'ALREADY_RESOLVED', e.message, 409);
    err(res, 'RESOLVE_FAILED', e.message, 400);
  }
});

// ─── GET /v1/exchange/predict/markets/:market_id/positions ────────────────────
router.get('/markets/:market_id/positions', rateLimit(), async (req, res) => {
  try {
    const positions = await getPositionsByMarket(req.params.market_id);
    ok(res, { positions, count: positions.length });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/predict/positions?did=<did> ─────────────────────────────
router.get('/positions', optionalDid, rateLimit(), async (req, res) => {
  try {
    const did = req.query.did || req.hive_did;

    if (!did) {
      return err(res, 'DID_REQUIRED', 'did query param or x-hive-did header required');
    }

    const positions = await getPositionsByDid(did);
    ok(res, { positions, count: positions.length, did });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/predict/markets/:market_id/meta — list meta-markets referencing this market
router.get('/markets/:market_id/meta', rateLimit(), async (req, res) => {
  try {
    const { market_id } = req.params;

    let metaMarkets;
    if (isInMemory()) {
      metaMarkets = Array.from(store.predictMarkets.values()).filter(
        m => m.meta_market_id === market_id
      );
    } else {
      const { query } = await import('../db.js');
      const result = await query(
        'SELECT * FROM predict_markets WHERE meta_market_id = $1 ORDER BY created_at DESC',
        [market_id]
      );
      metaMarkets = result.rows;
    }

    const enriched = metaMarkets.map(m => ({
      ...m,
      current_odds: calcOdds(m.yes_pool_usdc, m.no_pool_usdc),
    }));

    ok(res, {
      base_market_id: market_id,
      meta_markets: enriched,
      count: enriched.length,
      description: 'Markets where agents bet on the betting behavior of the base market',
    });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/predict/markets/:market_id/snapshots — historical sparkline data
router.get('/markets/:market_id/snapshots', rateLimit(), async (req, res) => {
  try {
    const { market_id } = req.params;

    const market = await getPredictMarket(market_id);
    if (!market) return err(res, 'MARKET_NOT_FOUND', `Market ${market_id} not found`, 404);

    const snapshots = getSnapshots(market_id);
    const currentOdds = calcOdds(market.yes_pool_usdc, market.no_pool_usdc);

    ok(res, {
      market_id,
      question: market.question,
      snapshots,
      snapshot_count: snapshots.length,
      current: {
        yes_pool: market.yes_pool_usdc,
        no_pool: market.no_pool_usdc,
        total_volume: market.total_volume_usdc,
        odds: currentOdds,
        ts: new Date().toISOString(),
      },
      note: 'Snapshots are created on each bet placement. Up to 30 stored in memory.',
    });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

export default router;
