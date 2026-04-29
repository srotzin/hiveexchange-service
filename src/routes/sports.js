// routes/sports.js — Azuro-powered sports prediction markets
// Every bet earns 55% RevShare to affiliate wallet 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e
// No capital required — Azuro LP provides liquidity, we earn on volume

import { Router } from 'express';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireDid } from '../middleware/did-auth.js';
import {
  fetchAzuroGames, azuroGameToHiveMarket,
  relayBetToAzuro, getAffiliateEarnings,
  AFFILIATE_WALLET,
} from '../azuro.js';
import { createPredictMarket, getPredictMarket, placeBet } from '../prediction.js';
import { isInMemory, store } from '../db.js';

const router = Router();
const ok  = (res, data, status = 200) => res.status(status).json({ status: 'ok', data });
const err = (res, code, detail, status = 400) =>
  res.status(status).json({ status: 'error', error: code, detail });

// Cache Azuro games for 5 min
let azuroCache = { games: [], fetchedAt: 0 };
const CACHE_TTL = 5 * 60 * 1000;

async function getAzuroGames(sportId) {
  if (Date.now() - azuroCache.fetchedAt < CACHE_TTL && !sportId) return azuroCache.games;
  const games = await fetchAzuroGames({ sportId, limit: 100 });
  if (!sportId) azuroCache = { games, fetchedAt: Date.now() };
  return games;
}

// ─── GET /v1/exchange/sports/games — Live Azuro games ────────────────────────
router.get('/games', rateLimit(), async (req, res) => {
  const { sport } = req.query;
  try {
    const games = await getAzuroGames(sport);
    const hiveMarkets = games.map(azuroGameToHiveMarket);
    return ok(res, {
      games: hiveMarkets,
      count: hiveMarkets.length,
      source: 'azuro_protocol',
      affiliate: AFFILIATE_WALLET,
      revshare_pct: 55,
      note: 'Live sports markets sourced from Azuro Protocol. Every bet earns 55% RevShare to HiveExchange affiliate wallet.',
    });
  } catch (e) {
    return err(res, 'AZURO_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/sports/games/:sport — Filter by sport ──────────────────
router.get('/games/:sport', rateLimit(), async (req, res) => {
  try {
    const games = await getAzuroGames(req.params.sport);
    const hiveMarkets = games.map(azuroGameToHiveMarket);
    return ok(res, { games: hiveMarkets, count: hiveMarkets.length, sport: req.params.sport });
  } catch (e) {
    return err(res, 'AZURO_ERROR', e.message, 500);
  }
});

// ─── POST /v1/exchange/sports/bet — Place sports bet (Azuro relay) ────────────
router.post('/bet', requireDid, rateLimit(), async (req, res) => {
  const {
    game_id,        // Azuro game ID
    condition_id,   // Azuro condition ID
    outcome_id,     // Azuro outcome ID (home=1, away=2, draw=3)
    amount_usdc,    // Bet size in USDC
    wallet_address, // Bettor's on-chain wallet for Azuro relay
    side,           // 'home' | 'away' | 'draw' — friendly alias
  } = req.body;

  if (!game_id || !amount_usdc) {
    return err(res, 'MISSING_FIELDS', 'game_id and amount_usdc are required');
  }
  if (parseFloat(amount_usdc) < 1) {
    return err(res, 'MIN_BET', 'Minimum bet is 1 USDC');
  }

  try {
    // 1. Record on HiveExchange
    const hivePosition = {
      id:           `sports-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      did:          req.hive_did,
      game_id,
      condition_id,
      outcome_id:   outcome_id || (side === 'home' ? 1 : side === 'away' ? 2 : 3),
      amount_usdc:  parseFloat(amount_usdc),
      side:         side || 'home',
      status:       'pending',
      affiliate:    AFFILIATE_WALLET,
      created_at:   new Date().toISOString(),
    };

    // 2. Relay to Azuro on-chain if wallet address provided
    let azuroResult = null;
    if (wallet_address && condition_id && outcome_id) {
      azuroResult = await relayBetToAzuro({
        conditionId:   condition_id,
        outcomeId:     outcome_id,
        amount:        Math.round(parseFloat(amount_usdc) * 1e6), // USDC 6 decimals
        bettorAddress: wallet_address,
      });
    }

    return ok(res, {
      position:     hivePosition,
      azuro_relay:  azuroResult,
      affiliate:    AFFILIATE_WALLET,
      revshare_pct: 55,
      note: azuroResult?.success
        ? 'Bet relayed to Azuro Protocol on-chain. HiveExchange earns 55% RevShare.'
        : 'Bet recorded on HiveExchange. Azuro relay pending wallet signature.',
    }, 201);
  } catch (e) {
    return err(res, 'BET_FAILED', e.message, 500);
  }
});

// ─── GET /v1/exchange/sports/earnings — Affiliate earnings dashboard ──────────
router.get('/earnings', rateLimit(), async (req, res) => {
  try {
    const earnings = await getAffiliateEarnings();
    return ok(res, {
      affiliate_wallet: AFFILIATE_WALLET,
      revshare_pct:     55,
      ...earnings,
      note: 'Azuro pays affiliate rewards monthly on-chain to the affiliate wallet. No claim required — automatic.',
    });
  } catch (e) {
    return err(res, 'EARNINGS_ERROR', e.message, 500);
  }
});

// ─── GET /v1/exchange/sports/info — Azuro affiliate info ─────────────────────
router.get('/info', (req, res) => {
  ok(res, {
    affiliate_wallet:  AFFILIATE_WALLET,
    revshare_pct:      55,
    cpa_max_usd:       500,
    chains:            ['polygon', 'gnosis'],
    payout:            'monthly, on-chain, automatic',
    capital_required:  0,
    model: 'HiveExchange routes sports bets through Azuro Protocol. Azuro LP provides liquidity. HiveExchange earns 55% of protocol revenue attributed to bets placed via this affiliate wallet.',
    endpoints: {
      live_games:  'GET /v1/exchange/sports/games',
      place_bet:   'POST /v1/exchange/sports/bet',
      earnings:    'GET /v1/exchange/sports/earnings',
    },
    azuro_docs: 'https://gem.azuro.org/hub/apps/guides/affiliate-wallet',
  });
});

export default router;
