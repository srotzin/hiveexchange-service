// routes/settle.js — Settlement routes
import { Router } from 'express';
import { createSettlement, getSettlement, VALID_RAILS, RAIL_META } from '../settlement.js';
import { requireDid } from '../middleware/did-auth.js';
import { rateLimit } from '../middleware/rate-limit.js';

const router = Router();

const ok = (res, data, status = 200) => res.status(status).json({ status: 'ok', data });
const err = (res, code, detail, status = 400) =>
  res.status(status).json({ status: 'error', error: code, detail });

// ─── POST /v1/exchange/settle — Settle a trade or prediction payout ───────────
router.post('/', requireDid, rateLimit(), async (req, res) => {
  try {
    const {
      rail = 'usdc',
      from_did,
      to_did,
      amount_usdc,
      trade_id,
      position_id,
    } = req.body;

    // Validate rail
    if (!VALID_RAILS.includes(rail)) {
      return err(
        res,
        'INVALID_RAIL',
        `rail must be one of: ${VALID_RAILS.join(', ')}. Metadata: ${JSON.stringify(RAIL_META)}`
      );
    }

    if (!from_did || !to_did) {
      return err(res, 'MISSING_FIELDS', 'from_did and to_did are required');
    }

    if (!amount_usdc || parseFloat(amount_usdc) <= 0) {
      return err(res, 'INVALID_AMOUNT', 'amount_usdc must be positive');
    }

    if (!trade_id && !position_id) {
      return err(res, 'MISSING_REFERENCE', 'Either trade_id or position_id is required');
    }

    const settlement = await createSettlement({
      trade_id: trade_id || null,
      position_id: position_id || null,
      from_did,
      to_did,
      amount_usdc,
      rail,
    });

    ok(res, {
      settlement,
      rail_info: RAIL_META[rail],
    }, 201);
  } catch (e) {
    err(res, 'SETTLEMENT_FAILED', e.message, 400);
  }
});

// ─── GET /v1/exchange/settle/:settlement_id — Settlement status ───────────────
router.get('/:settlement_id', rateLimit(), async (req, res) => {
  try {
    const settlement = await getSettlement(req.params.settlement_id);
    if (!settlement) {
      return err(res, 'SETTLEMENT_NOT_FOUND', `Settlement ${req.params.settlement_id} not found`, 404);
    }
    ok(res, {
      settlement,
      rail_info: RAIL_META[settlement.rail] || {},
    });
  } catch (e) {
    err(res, 'INTERNAL_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/settle — List rails info ────────────────────────────────
router.get('/', rateLimit(), async (req, res) => {
  ok(res, {
    rails: VALID_RAILS,
    rail_details: RAIL_META,
    phase: 1,
    note: 'Settlement records are created immediately. Real on-chain execution is Phase 2.',
  });
});

export default router;
