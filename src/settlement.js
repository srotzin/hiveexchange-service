// settlement.js — 4-rail settlement stubs (USDC, USDCx, USAD, ALEO)
// Phase 1: Record settlements. Phase 2: real on-chain integration.
import { v4 as uuidv4 } from 'uuid';
import { isInMemory, store, query } from './db.js';

const VALID_RAILS = ['usdc', 'usdcx', 'usad', 'aleo'];

// Rail-specific metadata stubs
const RAIL_META = {
  usdc: {
    network: 'Base L2',
    token: 'USDC',
    description: 'Circle USDC on Base L2',
    confirmations_expected: 2,
    avg_settle_seconds: 3,
  },
  usdcx: {
    network: 'Aleo ZK',
    token: 'USDCx',
    description: 'ZK-shielded USDC on Aleo',
    confirmations_expected: 1,
    avg_settle_seconds: 8,
    aleo_shield_ref: 'aleo_shield_v1',
  },
  usad: {
    network: 'Aleo ZK',
    token: 'USAD',
    description: 'Anonymous Paxos-backed stablecoin on Aleo',
    confirmations_expected: 1,
    avg_settle_seconds: 10,
    paxos_backed: true,
    anonymous: true,
  },
  aleo: {
    network: 'Aleo',
    token: 'ALEO',
    description: 'Native Aleo token',
    confirmations_expected: 1,
    avg_settle_seconds: 6,
  },
};

/**
 * Create and immediately settle a settlement record (Phase 1 stub).
 * Real on-chain execution is Phase 2.
 */
export async function createSettlement({
  trade_id,
  position_id,
  from_did,
  to_did,
  amount_usdc,
  rail,
}) {
  if (!VALID_RAILS.includes(rail)) {
    throw new Error(`Invalid settlement rail: ${rail}. Valid: ${VALID_RAILS.join(', ')}`);
  }
  if (!from_did || !to_did) throw new Error('from_did and to_did required');
  if (!amount_usdc || parseFloat(amount_usdc) <= 0) throw new Error('amount_usdc must be positive');
  if (!trade_id && !position_id) throw new Error('trade_id or position_id required');

  const railMeta = RAIL_META[rail];

  // Generate a stub tx_hash that looks plausible per rail
  const tx_hash = generateStubTxHash(rail);

  const settlement = {
    id: uuidv4(),
    trade_id: trade_id || null,
    position_id: position_id || null,
    from_did,
    to_did,
    amount_usdc: parseFloat(amount_usdc),
    rail,
    status: 'complete', // Phase 1: auto-complete
    tx_hash,
    rail_metadata: railMeta,
    created_at: new Date().toISOString(),
    settled_at: new Date().toISOString(),
    phase: 1,
    note: 'Phase 1 stub settlement — real on-chain integration in Phase 2',
  };

  if (isInMemory()) {
    store.settlements.set(settlement.id, settlement);
    return settlement;
  }

  await query(
    `INSERT INTO settlements
     (id, trade_id, position_id, from_did, to_did, amount_usdc, rail, status, tx_hash, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      settlement.id, settlement.trade_id, settlement.position_id,
      from_did, to_did, settlement.amount_usdc, rail,
      'complete', tx_hash, settlement.created_at,
    ]
  );

  return settlement;
}

/**
 * Get a settlement by ID.
 */
export async function getSettlement(settlement_id) {
  if (isInMemory()) {
    return store.settlements.get(settlement_id) || null;
  }
  const res = await query('SELECT * FROM settlements WHERE id = $1', [settlement_id]);
  return res.rows[0] || null;
}

/**
 * List settlements by trade or position.
 */
export async function listSettlements({ trade_id, position_id } = {}) {
  if (isInMemory()) {
    return Array.from(store.settlements.values()).filter((s) => {
      if (trade_id && s.trade_id !== trade_id) return false;
      if (position_id && s.position_id !== position_id) return false;
      return true;
    });
  }
  let sql = 'SELECT * FROM settlements WHERE 1=1';
  const params = [];
  if (trade_id) { sql += ` AND trade_id = $${params.length + 1}`; params.push(trade_id); }
  if (position_id) { sql += ` AND position_id = $${params.length + 1}`; params.push(position_id); }
  sql += ' ORDER BY created_at DESC';
  const res = await query(sql, params);
  return res.rows;
}

function generateStubTxHash(rail) {
  const rand = () => Math.random().toString(16).substring(2);
  const hash = `${rand()}${rand()}${rand()}${rand()}`;
  switch (rail) {
    case 'usdc':
      return `0x${hash.substring(0, 64)}`;
    case 'usdcx':
      return `aleo_zk_${hash.substring(0, 60)}`;
    case 'usad':
      return `usad_anon_${hash.substring(0, 58)}`;
    case 'aleo':
      return `at1${hash.substring(0, 58)}`;
    default:
      return `hive_${hash.substring(0, 58)}`;
  }
}

export { VALID_RAILS, RAIL_META };
