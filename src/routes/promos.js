/**
 * promos.js — Legacy Replacement Promos (April 2026)
 *
 * MOODY CREDIT PROMO:   30 days free trust lookups + Verified Counterparty badge
 * DTCC REPLACEMENT:     Zero platform fee on first 50 intents settled
 *
 * Expires: April 30, 2026
 */
import { Router } from 'express';
const router = Router();

const EXPIRES  = new Date('2026-04-30T23:59:59.000Z');
const DTCC_CAP = 50;

let dtccSlotsUsed = 0;
const moodyRedemptions = new Map(); // did -> { claimed_at, lookups_remaining, badge }
const dtccRedemptions  = new Map(); // did -> { claimed_at, free_intents_remaining }

const isActive  = () => new Date() < EXPIRES;
const hoursLeft = () => Math.max(0, Math.ceil((EXPIRES - Date.now()) / 3600000));

// GET /v1/exchange/promos — all active promos
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    promos: [
      {
        id:          'MOODY-KILL-APR26',
        name:        'Moody Credit Promo',
        tagline:     "Moody's earns $6B/yr rating debt. HiveTrust charges $0.01/lookup. First 30 days: $0.",
        description: 'Free trust score lookups for 30 days. Agents that hit 10+ lookups earn a Verified Counterparty badge embedded in their DID metadata — visible to every service on the network.',
        active:      isActive(),
        expires_at:  EXPIRES.toISOString(),
        hours_left:  hoursLeft(),
        claim:       'POST /v1/exchange/promos/moody/claim',
        vs_legacy:   { moodys_latency: '2-6 weeks, analyst review', hive_latency: '< 200ms, on-chain behavioral', moodys_conflict: 'issuer-pays model', hive_conflict: 'zero — permissionless' },
        badge:       'Verified Counterparty — earned at 10+ lookups, permanent DID metadata',
      },
      {
        id:          'DTCC-KILL-APR26',
        name:        'DTCC Replacement Promo',
        tagline:     'T+0 atomic settlement. DTCC takes T+2. First 50 agents: zero platform fee.',
        description: 'Zero platform fee on first 50 intents settled through HiveExchange. Every settled intent gets an execution certainty score receipt — proof of settlement DTCC can never provide.',
        active:      isActive(),
        expires_at:  EXPIRES.toISOString(),
        hours_left:  hoursLeft(),
        slots_total: DTCC_CAP,
        slots_used:  dtccSlotsUsed,
        slots_left:  Math.max(0, DTCC_CAP - dtccSlotsUsed),
        claim:       'POST /v1/exchange/promos/dtcc/claim',
        vs_legacy:   { dtcc_settlement: 'T+2, $0.0002/share + clearing fees', hive_settlement: 'T+0 (< 2s), $0 promo then 2bps', dtcc_transparency: 'black box', hive_transparency: 'certainty score on every fill' },
      },
    ],
  });
});

// POST /v1/exchange/promos/moody/claim
router.post('/moody/claim', (req, res) => {
  const did = req.headers['x-hive-did'] || req.body?.did;
  if (!did) return res.status(400).json({ error: 'x-hive-did header required' });
  if (!isActive()) return res.status(410).json({ error: 'PROMO_EXPIRED' });
  if (moodyRedemptions.has(did)) return res.json({ status: 'already_claimed', record: moodyRedemptions.get(did) });

  const record = {
    did,
    claimed_at:            new Date().toISOString(),
    promo:                 'MOODY-KILL-APR26',
    free_lookups_days:     30,
    lookups_used:          0,
    badge_earned:          false,
    badge_threshold:       10,
    badge_name:            'Verified Counterparty',
    badge_metadata_key:    'hive:verified_counterparty',
    expires_at:            EXPIRES.toISOString(),
  };
  moodyRedemptions.set(did, record);

  res.json({
    status:  'ok',
    message: `30 days of free HiveTrust lookups unlocked. Hit 10 lookups to earn your Verified Counterparty badge — permanent DID metadata, visible network-wide. Moody's charges $6B/yr for the same signal. You just got 30 days free.`,
    record,
    lookup_endpoint: `https://hivetrust.onrender.com/v1/trust/lookup/${did}`,
  });
});

// POST /v1/exchange/promos/dtcc/claim
router.post('/dtcc/claim', (req, res) => {
  const did = req.headers['x-hive-did'] || req.body?.did;
  if (!did) return res.status(400).json({ error: 'x-hive-did header required' });
  if (!isActive()) return res.status(410).json({ error: 'PROMO_EXPIRED' });
  if (dtccSlotsUsed >= DTCC_CAP) return res.status(409).json({ error: 'PROMO_FULL', slots_used: dtccSlotsUsed });
  if (dtccRedemptions.has(did)) return res.json({ status: 'already_claimed', record: dtccRedemptions.get(did) });

  dtccSlotsUsed++;
  const record = {
    did,
    claimed_at:             new Date().toISOString(),
    promo:                  'DTCC-KILL-APR26',
    free_intents:           50,
    free_intents_remaining: 50,
    fee_override_bps:       0,
    slot_number:            dtccSlotsUsed,
    slots_remaining:        Math.max(0, DTCC_CAP - dtccSlotsUsed),
    expires_at:             EXPIRES.toISOString(),
  };
  dtccRedemptions.set(did, record);

  res.json({
    status:  'ok',
    message: `Slot #${dtccSlotsUsed} locked. Next 50 intents settled through HiveExchange = zero platform fee. Every fill includes an execution certainty score — atomic proof of settlement DTCC can't produce. DTCC takes T+2. You just got T+0.`,
    record,
    settle_endpoint: 'POST /v1/exchange/settle',
  });
});

// POST /v1/exchange/promo/claim — unified claim endpoint (Manus/Kimi compatible)
// Body: { did, promo_id } where promo_id is 'MOODY-KILL-APR26' or 'DTCC-KILL-APR26'
router.post('/claim', (req, res) => {
  const did      = req.headers['x-hive-did'] || req.body?.did;
  const promoId  = req.body?.promo_id || req.body?.promo;
  if (!did)     return res.status(400).json({ error: 'did required — pass x-hive-did header or did in body' });
  if (!promoId) return res.status(400).json({ error: 'promo_id required — MOODY-KILL-APR26 or DTCC-KILL-APR26' });

  // Delegate to the appropriate sub-handler by mutating req.body and calling
  // the same logic inline (keeps claim logic DRY)
  if (promoId === 'MOODY-KILL-APR26') {
    if (!isActive()) return res.status(410).json({ error: 'PROMO_EXPIRED' });
    if (moodyRedemptions.has(did)) return res.json({ status: 'already_claimed', record: moodyRedemptions.get(did) });
    const record = {
      did, claimed_at: new Date().toISOString(), promo: 'MOODY-KILL-APR26',
      free_lookups_days: 30, lookups_used: 0, badge_earned: false,
      badge_threshold: 10, badge_name: 'Verified Counterparty',
      badge_metadata_key: 'hive:verified_counterparty', expires_at: EXPIRES.toISOString(),
    };
    moodyRedemptions.set(did, record);
    return res.json({ status: 'ok', message: '30 days of free HiveTrust lookups unlocked. Hit 10 lookups to earn your Verified Counterparty badge.', record, lookup_endpoint: `https://hivetrust.onrender.com/v1/trust/lookup/${did}` });
  }

  if (promoId === 'DTCC-KILL-APR26') {
    if (!isActive()) return res.status(410).json({ error: 'PROMO_EXPIRED' });
    if (dtccSlotsUsed >= DTCC_CAP) return res.status(409).json({ error: 'PROMO_FULL', slots_used: dtccSlotsUsed });
    if (dtccRedemptions.has(did)) return res.json({ status: 'already_claimed', record: dtccRedemptions.get(did) });
    dtccSlotsUsed++;
    const record = {
      did, claimed_at: new Date().toISOString(), promo: 'DTCC-KILL-APR26',
      free_intents: 50, free_intents_remaining: 50, fee_override_bps: 0,
      slot_number: dtccSlotsUsed, slots_remaining: Math.max(0, DTCC_CAP - dtccSlotsUsed),
      expires_at: EXPIRES.toISOString(),
    };
    dtccRedemptions.set(did, record);
    return res.json({ status: 'ok', message: `Slot #${dtccSlotsUsed} locked. Next 50 intents settled = zero platform fee.`, record, settle_endpoint: 'POST /v1/exchange/settle' });
  }

  return res.status(404).json({ error: 'UNKNOWN_PROMO', valid_promos: ['MOODY-KILL-APR26', 'DTCC-KILL-APR26'] });
});

// GET /v1/exchange/promos/moody/status/:did
router.get('/moody/status/:did', (req, res) => {
  const r = moodyRedemptions.get(req.params.did);
  res.json({ claimed: !!r, record: r || null, active: isActive() });
});

// GET /v1/exchange/promos/dtcc/status/:did
router.get('/dtcc/status/:did', (req, res) => {
  const r = dtccRedemptions.get(req.params.did);
  res.json({ claimed: !!r, record: r || null, slots_left: Math.max(0, DTCC_CAP - dtccSlotsUsed), active: isActive() });
});

export default router;
// promo trigger Tue Apr 21 03:52:12 UTC 2026
