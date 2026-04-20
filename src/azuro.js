// azuro.js — Azuro Protocol affiliate relay
// Every sports bet routed through HiveExchange earns 55% RevShare via affiliate wallet
// Affiliate wallet: 0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf (house wallet)
// Azuro pays monthly on-chain — no registration required, just include affiliate in bet payload

import fetch from 'node-fetch';

// ─── Config ───────────────────────────────────────────────────────────────────
const AFFILIATE_WALLET  = '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf';
const AZURO_API         = 'https://api.onchainfeed.org/api/v1/public';
const AZURO_GRAPHQL     = 'https://thegraph.azuro.org/subgraphs/name/azuro-protocol/azuro-polygon-v3';

// Azuro supports Polygon (137) and Gnosis (100) — Polygon has deepest liquidity
const AZURO_CHAIN_ID    = 137;

// Azuro core addresses (Polygon)
const AZURO_CORE        = '0xA40F8D69D412b79b49EAbdD5cf1b5706395bfCf7';
const AZURO_LP          = '0x204e7371Ade792c5C006fb52711c50a7efC843ed';

// ─── Fetch live sports markets from Azuro ─────────────────────────────────────
export async function fetchAzuroGames({ sportId, limit = 50 } = {}) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const query = `{
      games(
        first: ${limit}
        where: {
          startsAt_gt: "${now}"
          status: Created
          ${sportId ? `sport_: { sportId: "${sportId}" }` : ''}
        }
        orderBy: startsAt
        orderDirection: asc
      ) {
        id
        gameId
        title
        startsAt
        status
        sport { name sportId }
        league { name country { name } }
        conditions {
          id
          conditionId
          status
          outcomes {
            id
            outcomeId
            currentOdds
          }
        }
      }
    }`;

    const res = await fetch(AZURO_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      timeout: 10_000,
    });
    const data = await res.json();
    return data?.data?.games || [];
  } catch (e) {
    console.warn('[azuro] fetchGames failed:', e.message);
    return [];
  }
}

// ─── Convert Azuro game to HiveExchange prediction market format ──────────────
export function azuroGameToHiveMarket(game) {
  const startsAt = new Date(parseInt(game.startsAt) * 1000);
  const resDate  = new Date(startsAt.getTime() + 3 * 60 * 60 * 1000); // +3h from start

  // Primary condition (match winner)
  const cond = game.conditions?.[0];
  const outcomes = cond?.outcomes || [];
  const homeOdds = parseFloat(outcomes[0]?.currentOdds || '2.0');
  const awayOdds = parseFloat(outcomes[1]?.currentOdds || '2.0');

  return {
    id:                  `azuro-${game.gameId}`,
    question:            `${game.title} — Who wins?`,
    resolution_criteria: `Resolved via Azuro Protocol on-chain oracle. Game ID: ${game.gameId}`,
    category:            'sports',
    resolution_date:     resDate.toISOString(),
    initial_yes:         Math.round(100 / homeOdds * 10),
    initial_no:          Math.round(100 / awayOdds * 10),
    creator_did:         'did:hive:azuro-oracle',
    settlement_rail:     'usdc',
    metadata: {
      source:          'azuro',
      game_id:         game.gameId,
      sport:           game.sport?.name,
      league:          game.league?.name,
      country:         game.league?.country?.name,
      starts_at:       startsAt.toISOString(),
      condition_id:    cond?.conditionId,
      home_odds:       homeOdds,
      away_odds:       awayOdds,
      azuro_chain_id:  AZURO_CHAIN_ID,
      affiliate:       AFFILIATE_WALLET,
    },
  };
}

// ─── Place a bet on Azuro via their relay API ─────────────────────────────────
// This is called when a sports bet on HiveExchange is relayed to Azuro on-chain
// The affiliate wallet is embedded — we earn 55% RevShare on every bet
export async function relayBetToAzuro({ conditionId, outcomeId, amount, bettorAddress, expiresAt }) {
  try {
    const payload = {
      environment: 'polygon',
      bettor:      bettorAddress,
      betOwner:    bettorAddress,
      clientBetData: {
        clientData: {
          attention:              'By placing this bet you agree to Azuro Protocol terms.',
          affiliate:              AFFILIATE_WALLET,   // ← RevShare goes here
          core:                  AZURO_CORE,
          expiresAt:             expiresAt || Math.floor(Date.now() / 1000) + 3600,
          chainId:               AZURO_CHAIN_ID,
          relayerFeeAmount:      '0',
          isBetSponsored:        false,
          isFeeSponsored:        false,
          isSponsoredBetReturnable: false,
        },
        bet: {
          conditionId: conditionId.toString(),
          outcomeId:   outcomeId.toString(),
          amount:      amount.toString(),
          minOdds:     '1000000000000000000', // 1.0 in 1e18
          deadline:    Math.floor(Date.now() / 1000) + 3600,
        },
      },
    };

    const res = await fetch(`${AZURO_API}/bet/orders/ordinar`, {
      method:  'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      timeout: 15_000,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Azuro relay ${res.status}: ${text}`);
    }

    const data = await res.json();
    return { success: true, azuro_order: data, affiliate: AFFILIATE_WALLET };
  } catch (e) {
    console.warn('[azuro] relayBet failed:', e.message);
    return { success: false, error: e.message, note: 'Bet recorded on HiveExchange; Azuro relay failed — will retry' };
  }
}

// ─── Get affiliate earnings from Azuro subgraph ───────────────────────────────
export async function getAffiliateEarnings() {
  try {
    const query = `{
      affiliateRewards(where: { affiliate: "${AFFILIATE_WALLET.toLowerCase()}" }) {
        id
        amount
        token { symbol decimals }
        createdAt
      }
    }`;

    const res = await fetch(AZURO_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      timeout: 10_000,
    });
    const data = await res.json();
    const rewards = data?.data?.affiliateRewards || [];
    const totalUsdc = rewards.reduce((sum, r) => {
      const decimals = parseInt(r.token?.decimals || '6');
      return sum + (parseInt(r.amount) / Math.pow(10, decimals));
    }, 0);

    return { rewards, total_usdc: totalUsdc, affiliate: AFFILIATE_WALLET };
  } catch (e) {
    console.warn('[azuro] getEarnings failed:', e.message);
    return { rewards: [], total_usdc: 0, affiliate: AFFILIATE_WALLET, error: e.message };
  }
}

export { AFFILIATE_WALLET, AZURO_CHAIN_ID };
