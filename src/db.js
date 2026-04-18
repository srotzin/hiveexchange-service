// db.js — PostgreSQL pool + in-memory fallback + schema init
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const { Pool } = pg;

let pool = null;
let useInMemory = false;

// ─── In-Memory Store ────────────────────────────────────────────────────────
export const store = {
  markets: new Map(),
  orders: new Map(),
  trades: new Map(),
  pools: new Map(),
  predictMarkets: new Map(),
  positions: new Map(),
  settlements: new Map(),
};

// ─── DB Init ─────────────────────────────────────────────────────────────────
export async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log('[db] No DATABASE_URL — running in in-memory mode');
    useInMemory = true;
    return;
  }

  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    await pool.query('SELECT 1');
    console.log('[db] PostgreSQL connected');
    await runMigrations();
  } catch (err) {
    console.warn('[db] PostgreSQL unavailable, falling back to in-memory:', err.message);
    useInMemory = true;
    pool = null;
  }
}

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS markets (
      id UUID PRIMARY KEY,
      symbol VARCHAR(100) NOT NULL,
      base_asset VARCHAR(50) NOT NULL,
      quote_asset VARCHAR(50) NOT NULL,
      market_type VARCHAR(20) NOT NULL DEFAULT 'spot',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      maker_fee_pct NUMERIC(6,4) NOT NULL DEFAULT 0.10,
      taker_fee_pct NUMERIC(6,4) NOT NULL DEFAULT 0.18,
      created_by_did TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      market_id UUID NOT NULL,
      did TEXT NOT NULL,
      side VARCHAR(10) NOT NULL,
      order_type VARCHAR(10) NOT NULL,
      price NUMERIC(24,8),
      quantity NUMERIC(24,8) NOT NULL,
      filled_quantity NUMERIC(24,8) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      trust_score_at_placement NUMERIC(5,2),
      settlement_rail VARCHAR(20) NOT NULL DEFAULT 'usdc',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS trades (
      id UUID PRIMARY KEY,
      market_id UUID NOT NULL,
      buy_order_id UUID NOT NULL,
      sell_order_id UUID NOT NULL,
      price NUMERIC(24,8) NOT NULL,
      quantity NUMERIC(24,8) NOT NULL,
      maker_did TEXT NOT NULL,
      taker_did TEXT NOT NULL,
      fee_usdc NUMERIC(24,8) NOT NULL DEFAULT 0,
      settlement_rail VARCHAR(20) NOT NULL DEFAULT 'usdc',
      settled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pools (
      id UUID PRIMARY KEY,
      market_id UUID NOT NULL,
      reserve_base NUMERIC(24,8) NOT NULL DEFAULT 0,
      reserve_quote NUMERIC(24,8) NOT NULL DEFAULT 0,
      k_constant NUMERIC(48,16) NOT NULL DEFAULT 0,
      total_lp_shares NUMERIC(24,8) NOT NULL DEFAULT 0,
      lp_positions JSONB DEFAULT '{}',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_by_did TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS predict_markets (
      id UUID PRIMARY KEY,
      question TEXT NOT NULL,
      resolution_criteria TEXT,
      category VARCHAR(50) NOT NULL DEFAULT 'general',
      resolution_date TIMESTAMPTZ,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      outcome VARCHAR(10),
      yes_pool_usdc NUMERIC(24,8) NOT NULL DEFAULT 10,
      no_pool_usdc NUMERIC(24,8) NOT NULL DEFAULT 10,
      total_volume_usdc NUMERIC(24,8) NOT NULL DEFAULT 0,
      creator_did TEXT,
      settlement_rail VARCHAR(20) NOT NULL DEFAULT 'usdc',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS positions (
      id UUID PRIMARY KEY,
      market_id UUID NOT NULL,
      did TEXT NOT NULL,
      side VARCHAR(10) NOT NULL,
      amount_usdc NUMERIC(24,8) NOT NULL,
      shares NUMERIC(24,8) NOT NULL,
      entry_price NUMERIC(10,6) NOT NULL,
      payout_usdc NUMERIC(24,8),
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      settlement_rail VARCHAR(20) NOT NULL DEFAULT 'usdc',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id UUID PRIMARY KEY,
      trade_id UUID,
      position_id UUID,
      from_did TEXT NOT NULL,
      to_did TEXT NOT NULL,
      amount_usdc NUMERIC(24,8) NOT NULL,
      rail VARCHAR(20) NOT NULL DEFAULT 'usdc',
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      tx_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id);
    CREATE INDEX IF NOT EXISTS idx_orders_did ON orders(did);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id);
    CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_id);
    CREATE INDEX IF NOT EXISTS idx_positions_did ON positions(did);
  `);
  console.log('[db] Migrations complete');
}

// ─── DB Health ────────────────────────────────────────────────────────────────
export async function dbHealth() {
  if (useInMemory) {
    return {
      mode: 'in-memory',
      status: 'ok',
      markets: store.markets.size,
      orders: store.orders.size,
      trades: store.trades.size,
    };
  }
  try {
    const res = await pool.query('SELECT COUNT(*) FROM markets');
    return {
      mode: 'postgresql',
      status: 'ok',
      markets: parseInt(res.rows[0].count, 10),
    };
  } catch (err) {
    return { mode: 'postgresql', status: 'error', error: err.message };
  }
}

// ─── Query Helpers ────────────────────────────────────────────────────────────
export function isInMemory() {
  return useInMemory;
}

export async function query(sql, params = []) {
  if (useInMemory) throw new Error('In-memory mode — use store directly');
  return pool.query(sql, params);
}

export { pool };

// ─── Generic In-Memory CRUD ───────────────────────────────────────────────────
export function memInsert(collection, record) {
  if (!record.id) record.id = uuidv4();
  if (!record.created_at) record.created_at = new Date().toISOString();
  store[collection].set(record.id, record);
  return record;
}

export function memGet(collection, id) {
  return store[collection].get(id) || null;
}

export function memUpdate(collection, id, updates) {
  const existing = store[collection].get(id);
  if (!existing) return null;
  const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
  store[collection].set(id, updated);
  return updated;
}

export function memList(collection, filterFn = null) {
  const all = Array.from(store[collection].values());
  return filterFn ? all.filter(filterFn) : all;
}
