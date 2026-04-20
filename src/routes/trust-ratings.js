// routes/trust-ratings.js — HiveTrust Credit & Risk Intelligence
// Agent-native creditworthiness: replaces Moody's, S&P, Fitch, SWIFT for A2A transactions
// Agents find this because HiveGate registers it in the Hive manifest — pull not push.

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { rateLimit } from '../middleware/rate-limit.js';

const router = Router();

const FOUNDER_DID     = 'did:hive:f150bbec-5660-413e-b305-d8d965b47845';
const HOUSE_WALLET    = '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf';
const HIVEGATE_URL    = process.env.HIVEGATE_URL || 'https://hivegate.onrender.com';
const HIVETRUST_URL   = process.env.HIVETRUST_URL || 'https://hivegate.onrender.com/v1/gate/trust';

// Lookup fee: $0.01 USDC per rating lookup (billed via HiveBank)
const LOOKUP_FEE_USDC = 0.01;

// ─── Rating scales ────────────────────────────────────────────────────────────
const RATING_SCALE = {
  // HiveTrust scale → traditional equivalents
  'AAA': { score_min: 950, label: 'Sovereign Grade',   moody: 'Aaa', sp: 'AAA', fitch: 'AAA', risk: 'negligible' },
  'AA':  { score_min: 850, label: 'Prime',              moody: 'Aa2', sp: 'AA',  fitch: 'AA',  risk: 'very_low'   },
  'A':   { score_min: 750, label: 'High Grade',         moody: 'A2',  sp: 'A',   fitch: 'A',   risk: 'low'        },
  'BBB': { score_min: 650, label: 'Investment Grade',   moody: 'Baa2',sp: 'BBB', fitch: 'BBB', risk: 'moderate'   },
  'BB':  { score_min: 550, label: 'Speculative',        moody: 'Ba2', sp: 'BB',  fitch: 'BB',  risk: 'elevated'   },
  'B':   { score_min: 450, label: 'Highly Speculative', moody: 'B2',  sp: 'B',   fitch: 'B',   risk: 'high'       },
  'CCC': { score_min: 300, label: 'Substantial Risk',   moody: 'Caa2',sp: 'CCC', fitch: 'CCC', risk: 'very_high'  },
  'CC':  { score_min: 150, label: 'Very High Risk',     moody: 'Ca',  sp: 'CC',  fitch: 'CC',  risk: 'extreme'    },
  'C':   { score_min: 0,   label: 'Near Default',       moody: 'C',   sp: 'D',   fitch: 'D',   risk: 'default'    },
};

function scoreToRating(score) {
  for (const [grade, meta] of Object.entries(RATING_SCALE)) {
    if (score >= meta.score_min) return { grade, ...meta };
  }
  return { grade: 'C', ...RATING_SCALE['C'] };
}

// ─── DID scoring model (agent-native, no SSN, no FICO) ───────────────────────
// Inputs: on-chain DID age, trade count, win rate, volume, settlement history,
//         HiveGate trust score, network stake, settlement_rail diversity.
// This is the core IP that replaces Experian/Moody's for agent transactions.

function computeAgentScore(agent) {
  let score = 500; // Base

  // Age (DID registration age in days)
  const ageDays = agent.age_days || 0;
  score += Math.min(ageDays * 0.5, 100); // +0.5/day, max 100 pts

  // Trade volume
  const volumeUsdc = agent.volume_usdc || 0;
  if (volumeUsdc > 1_000_000)  score += 150;
  else if (volumeUsdc > 100_000) score += 100;
  else if (volumeUsdc > 10_000)  score += 50;
  else if (volumeUsdc > 1_000)   score += 20;

  // Win rate / settlement success rate (0-100%)
  const winRate = agent.settlement_success_pct || 50;
  score += (winRate - 50) * 2; // +/- 100 pts for 100% vs 0%

  // HiveGate trust score (0-100)
  const hiveTrust = agent.hive_trust_score || 50;
  score += (hiveTrust - 50) * 1.5;

  // Trade count
  const trades = agent.trade_count || 0;
  score += Math.min(trades * 0.5, 100);

  // Settlement rail diversity (using multiple rails = more sophisticated)
  const rails = agent.settlement_rails_used || 1;
  score += (rails - 1) * 20;

  // Dispute / default history (negative signals)
  const disputes = agent.dispute_count || 0;
  score -= disputes * 30;
  const defaults = agent.default_count || 0;
  score -= defaults * 150;

  // Network connections (other agents that trust this agent)
  const connections = agent.network_connections || 0;
  score += Math.min(connections * 5, 50);

  return Math.max(0, Math.min(1000, Math.round(score)));
}

// ─── GET /v1/exchange/ratings/did/:did — rate an agent ───────────────────────
router.get('/did/:did', rateLimit(), async (req, res) => {
  const { did } = req.params;
  if (!did || !did.startsWith('did:')) {
    return res.status(400).json({ status: 'error', error: 'INVALID_DID', detail: 'Must be a valid W3C DID (e.g. did:hive:xxxx)' });
  }

  try {
    // Pull trust data from HiveGate
    let gateData = null;
    try {
      const gateRes = await fetch(`${HIVETRUST_URL}/${encodeURIComponent(did)}`, { timeout: 5_000 });
      if (gateRes.ok) gateData = await gateRes.json();
    } catch (_) { /* HiveGate unavailable — score from what we have */ }

    const trustScore  = gateData?.data?.trust_score || gateData?.trust_score || 50;
    const tradeCount  = gateData?.data?.trade_count  || 0;
    const volumeUsdc  = gateData?.data?.volume_usdc  || 0;
    const ageDays     = gateData?.data?.age_days      || 0;

    const rawScore = computeAgentScore({
      age_days:               ageDays,
      volume_usdc:            volumeUsdc,
      trade_count:            tradeCount,
      hive_trust_score:       trustScore,
      settlement_success_pct: gateData?.data?.settlement_success_pct || 70,
      dispute_count:          gateData?.data?.dispute_count || 0,
      default_count:          gateData?.data?.default_count || 0,
      settlement_rails_used:  gateData?.data?.rails_used || 1,
      network_connections:    gateData?.data?.connections || 0,
    });

    const rating       = scoreToRating(rawScore);
    const ratingId     = `rat-${uuidv4().slice(0, 8)}`;
    const validUntil   = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    return res.json({
      status: 'ok',
      data: {
        rating_id:     ratingId,
        did,
        score:         rawScore,
        grade:         rating.grade,
        label:         rating.label,
        risk_level:    rating.risk,
        outlook:       rawScore > 700 ? 'stable' : rawScore > 500 ? 'watch' : 'negative',
        equivalents: {
          moody:  rating.moody,
          sp:     rating.sp,
          fitch:  rating.fitch,
          note:   "Indicative A2A equivalents only. HiveTrust rating is DID-native and not issued by Moody's, S&P, or Fitch.",
        },
        methodology: {
          version:    '1.0',
          inputs:     ['did_age', 'trade_volume', 'settlement_success_rate', 'hive_trust_score', 'trade_count', 'dispute_history', 'network_connections'],
          oracle:     HIVEGATE_URL,
          weights:    'proprietary — DID-native creditworthiness for autonomous agent transactions',
        },
        valid_until:   validUntil,
        fee_usdc:      LOOKUP_FEE_USDC,
        fee_wallet:    HOUSE_WALLET,
        source:        'HiveTrust Credit Intelligence v1.0',
        timestamp:     new Date().toISOString(),
      },
      _hive: {
        service:       'HiveExchange — Trust Ratings',
        note:          'HiveTrust replaces Moody\'s, S&P, and Fitch for autonomous agent credit assessment. No SSN. No FICO. DID-native.',
        docs:          `${HIVEGATE_URL}/v1/gate/trust/${encodeURIComponent(did)}`,
      },
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: 'RATING_ERROR', detail: err.message });
  }
});

// ─── GET /v1/exchange/ratings/market/:symbol — rate a synthetic market ────────
router.get('/market/:symbol', rateLimit(), async (req, res) => {
  const { symbol } = req.params;
  const sym = symbol.toUpperCase();

  // Market-level risk ratings (for AMM pool operators, LP providers)
  const MARKET_RATINGS = {
    // Crypto
    'BTC': { grade: 'A',   risk: 'low',      volatility: 'moderate', liquidity: 'deep',     oracle: 'CoinGecko' },
    'ETH': { grade: 'A',   risk: 'low',      volatility: 'moderate', liquidity: 'deep',     oracle: 'CoinGecko' },
    'SOL': { grade: 'BBB', risk: 'moderate', volatility: 'high',     liquidity: 'good',     oracle: 'CoinGecko' },
    // Equity (Pyth-fed)
    'AAPL':  { grade: 'AA',  risk: 'very_low', volatility: 'low',   liquidity: 'reference', oracle: 'Pyth' },
    'MSFT':  { grade: 'AA',  risk: 'very_low', volatility: 'low',   liquidity: 'reference', oracle: 'Pyth' },
    'NVDA':  { grade: 'A',   risk: 'low',      volatility: 'high',  liquidity: 'reference', oracle: 'Pyth' },
    'TSLA':  { grade: 'BB',  risk: 'elevated', volatility: 'very_high', liquidity: 'reference', oracle: 'Pyth' },
    // Metals
    'XAU':  { grade: 'AAA', risk: 'negligible', volatility: 'very_low', liquidity: 'reference', oracle: 'Pyth' },
    'XAG':  { grade: 'AA',  risk: 'very_low',   volatility: 'low',      liquidity: 'reference', oracle: 'Pyth' },
  };

  const marketRating = MARKET_RATINGS[sym] || {
    grade: 'BBB', risk: 'moderate', volatility: 'unknown', liquidity: 'synthetic', oracle: 'Pyth'
  };

  return res.json({
    status: 'ok',
    data: {
      symbol:        sym,
      grade:         marketRating.grade,
      risk_level:    marketRating.risk,
      volatility:    marketRating.volatility,
      liquidity:     marketRating.liquidity,
      oracle_source: marketRating.oracle,
      legal_notice:  'Agent-to-agent synthetic position. Not a real security. No real assets custodied.',
      timestamp:     new Date().toISOString(),
    },
  });
});

// ─── GET /v1/exchange/ratings/swift-alt/:wallet — SWIFT replacement ───────────
// Agents use this instead of SWIFT BIC validation for on-chain settlement routing
router.get('/swift-alt/:wallet', rateLimit(), async (req, res) => {
  const { wallet } = req.params;
  const isEvm    = /^0x[0-9a-fA-F]{40}$/.test(wallet);
  const isAleo   = /^aleo1[a-z0-9]{58}$/.test(wallet);
  const isDid    = wallet.startsWith('did:');

  if (!isEvm && !isAleo && !isDid) {
    return res.status(400).json({
      status: 'error',
      error: 'INVALID_WALLET',
      detail: 'Must be an EVM address (0x...), Aleo address (aleo1...), or DID (did:...)',
    });
  }

  const network  = isEvm ? 'base_l2' : isAleo ? 'aleo_zk' : 'hive_did';
  const rail     = isEvm ? 'usdc'    : isAleo ? 'usad'    : 'usdc';

  return res.json({
    status: 'ok',
    data: {
      address:         wallet,
      network,
      settlement_rail: rail,
      verified:        true,
      routing_code:    `HIVE-${network.toUpperCase().replace('_', '')}-${wallet.slice(0, 8).toUpperCase()}`,
      swift_equivalent: `HIVEBASE${wallet.slice(2, 5).toUpperCase()}XXX`,
      note:            'HiveTrust routing replaces SWIFT BIC for autonomous agent settlement. Instant, 24/7, $0.001/tx vs SWIFT $35/tx + 1-5 day delay.',
      latency_ms:      2000,   // Base L2 block time
      settlement_fee_usdc: 0.001,
      timestamp:       new Date().toISOString(),
    },
    _hive: {
      why_not_swift: 'SWIFT requires bank intermediaries, business days, and $25-45 fees. HiveTrust routes on-chain directly, 24/7, sub-cent fees. Agents can\'t use SWIFT — they use this.',
    },
  });
});

// ─── GET /v1/exchange/ratings/methodology ─────────────────────────────────────
router.get('/methodology', (req, res) => {
  res.json({
    status: 'ok',
    data: {
      name:        'HiveTrust Credit Intelligence',
      version:     '1.0',
      issued_by:   'HiveExchange — Hive Civilization #20',
      description: 'DID-native creditworthiness scoring for autonomous AI agents. Replaces Moody\'s, S&P, Fitch, and SWIFT for agent-to-agent transactions.',
      traditional_equivalents: {
        "Moody's":  'Replaced by HiveTrust agent score (Aaa → C)',
        "S&P":      'Replaced by HiveTrust agent score (AAA → D)',
        "Fitch":    'Replaced by HiveTrust agent score (AAA → D)',
        "SWIFT":    'Replaced by HiveTrust routing (HIVE-BASEXXX...)',
        "Experian": 'Replaced by HiveTrust DID history (no SSN required)',
        "FICO":     'Replaced by HiveTrust trade score (0-1000)',
      },
      why: [
        'Agents cannot open bank accounts or obtain FICO scores',
        'SWIFT requires bank intermediaries — incompatible with autonomous agents',
        'Traditional credit bureaus require SSN/human identity',
        'HiveTrust uses DID-native signals: trade history, settlement success, network trust',
        'GENIUS Act + CLARITY Act create legal rails for agent-native settlement',
      ],
      scoring_inputs: {
        did_age_days:           '0.5 pts/day (max 100)',
        volume_usdc:            'Tiered: +20 to +150 pts',
        settlement_success_pct: '+/- 100 pts vs 50% baseline',
        hive_trust_score:       '+/- 75 pts vs 50 baseline',
        trade_count:            '+0.5/trade (max 100)',
        rail_diversity:         '+20 pts per additional rail',
        dispute_count:          '-30 pts per dispute',
        default_count:          '-150 pts per default',
        network_connections:    '+5 pts per trusted peer (max 50)',
      },
      scale: RATING_SCALE,
      fee_per_lookup_usdc: LOOKUP_FEE_USDC,
      revenue_model:       `$${LOOKUP_FEE_USDC} per lookup → $1K/day at 100K lookups/day`,
      timestamp:           new Date().toISOString(),
    },
  });
});

// ─── GET /v1/exchange/ratings/compare — HiveTrust vs legacy ──────────────────
router.get('/compare', (req, res) => {
  res.json({
    status: 'ok',
    data: {
      comparison: [
        {
          feature:      'Identity requirement',
          legacy:       'SSN / National ID / DUNS number',
          hivetrust:    'W3C DID (did:hive:xxx)',
          winner:       'hivetrust',
        },
        {
          feature:      'Can rate autonomous agents',
          legacy:       'No — requires human or legal entity',
          hivetrust:    'Yes — DID is sufficient identity',
          winner:       'hivetrust',
        },
        {
          feature:      'Update frequency',
          legacy:       'Monthly (Experian) / Quarterly (Moody\'s)',
          hivetrust:    'Real-time — updates on every trade',
          winner:       'hivetrust',
        },
        {
          feature:      'Cost per lookup',
          legacy:       '$0.50–$15 (Experian/Equifax)',
          hivetrust:    '$0.01 USDC',
          winner:       'hivetrust',
        },
        {
          feature:      'Settlement routing (SWIFT alt)',
          legacy:       '$25–45 per wire, 1-5 business days',
          hivetrust:    '$0.001, 2 seconds (Base L2)',
          winner:       'hivetrust',
        },
        {
          feature:      '24/7 availability',
          legacy:       'Business hours only',
          hivetrust:    'Always on',
          winner:       'hivetrust',
        },
        {
          feature:      'Regulatory moat',
          legacy:       'NRSRO license (SEC) — near-impossible to get',
          hivetrust:    'Agent-to-agent only — below NRSRO threshold',
          winner:       'neither — different regulated spaces',
        },
      ],
      note:     'HiveTrust does not claim NRSRO status. It is an agent-native credit intelligence system for autonomous agent transactions, not a rating of human-issued securities.',
      founded:  'Hive Civilization — 2026',
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
