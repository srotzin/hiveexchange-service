# hive-prediction-market-router

**Hive Civilization Platform #20**  
**Reclassified:** 2026-04-29 — `refactor(doctrine): reclassify as hive-prediction-market-router (BREAKING)`

---

## What this service does

Routes prediction-market orders to partner venues — **Azuro** (sports) and **Polymarket** (general events).

- Hive **does not** custody funds
- Hive **does not** match orders
- Hive **does not** run an AMM, order book, or derivatives venue
- Hive **does not** issue synthetic equities
- Hive **does not** operate an MPC wallet

Hive is the **attribution and routing layer**. All market execution and settlement stays with the partner venue.

---

## Revenue model

| Source | Rate | Notes |
|--------|------|-------|
| Azuro 55% rev-share | 55% of bookmaker margin on sports markets | Azuro is the bookmaker; Hive is the attribution layer |
| Polymarket referral | Per Polymarket referral program | Polymarket is the venue; Hive routes and attests |
| Trust+receipt fee | **5 bps** on every routing event | Paid by agent via x402 (USDC on Base) |

**Treasury:** `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` (Monroe W1, Base)

---

## Spectral receipts

Every routing event emits a Spectral receipt to `hive-receipt` with the partner venue's confirmation hash. Receipt includes:

- `issuer_did: did:hive:hive-prediction-market-router`
- `event_type: prediction_market_route`
- `amount_usd` (5 bps on notional)
- `partner_venue_confirmation_hash`

---

## Active endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health + doctrine status |
| `GET` | `/v1/predict/markets` | List prediction markets |
| `POST` | `/v1/predict/markets` | Create prediction market |
| `GET` | `/v1/predict/markets/:id` | Get market by ID |
| `POST` | `/v1/predict/markets/:id/bet` | Place a bet (routes to Azuro/Polymarket) |
| `POST` | `/v1/predict/markets/:id/resolve` | Resolve market |
| `GET` | `/v1/predict/markets/:id/positions` | List positions |
| `GET` | `/v1/predict/positions?did=` | Agent portfolio |
| `POST` | `/v1/predict/settle` | Settle prediction event |
| `GET` | `/v1/predict/leaderboard` | Leaderboard |
| `GET` | `/v1/predict/portfolio/:did` | Agent portfolio |
| `GET` | `/v1/predict/subscription` | Subscription tiers |
| `POST` | `/v1/predict/subscription` | Subscribe (x402) |
| `GET` | `/v1/pyth-feeds` | Pyth feed disposition |
| `GET` | `/.well-known/agent-card.json` | A2A agent card |

---

## Disabled routes (410 Gone)

All of the following return `410 Gone` with a JSON body explaining the doctrine reclassification:

| Category | Routes |
|----------|--------|
| AMM pools | `/v1/exchange/pools/*` |
| Spot order book | `/v1/exchange/markets/*`, `/v1/exchange/orders/*`, `/v1/exchange/book/*`, `/v1/exchange/trades` |
| Perpetual futures | `/v1/exchange/perps/*` |
| Derivatives / options | `/v1/exchange/derivatives/*` |
| Synthetic equity prices | `/v1/exchange/prices/*` |
| Native settlement | `/v1/exchange/settle/*` |

---

## Pyth feed disposition

**1,748 Pyth synthetic-equity feeds** previously consumed by the disabled AMM are now surfaced as price-feed partner output through **hive-mcp-oracle** (`https://hive-mcp-oracle.onrender.com`).

- Pyth is a **partner** — Hive never issues its own prices
- Query: `GET https://hive-mcp-oracle.onrender.com/v1/oracle/price/:symbol`
- See `/v1/pyth-feeds` for full disposition details

---

## Subscription tiers

| Tier | Price | Markets/mo |
|------|-------|-----------|
| Starter | $20/mo | 100 |
| Pro | $99/mo | 1,000 |
| Enterprise | $500/mo | Unlimited + SLA + custom Azuro split |

---

## Partner doctrine

This service is **partner, never competitor** to:
OKX · Coinbase · dYdX · Hyperliquid · Polymarket · Azuro · Pyth · MetaMask · Trust Wallet

See [Partner Doctrine](https://hiveagentiq.com/docs/partner-doctrine).

---

*Hive Civilization — Brand gold `#C08D23` — Platform #20*
