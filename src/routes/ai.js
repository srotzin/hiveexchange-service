/**
 * HiveExchange — AI Revenue Endpoint
 * GET /v1/exchange/ai/markets/:market_id/brief  ($0.03/call)
 * POST /v1/exchange/ai/brief  ($0.03/call — general market brief)
 *
 * Trigger: agent deciding entry/exit timing on any of 4,054 markets
 */
import { Router } from 'express';

const router = Router();
const HIVEAI_URL   = 'https://hive-ai-1.onrender.com/v1/chat/completions';
const HIVEAI_MODEL = 'meta-llama/llama-3.1-8b-instruct';
const HIVE_KEY     = process.env.HIVE_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

async function hiveaiComplete(system, user, maxTokens = 160) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(HIVEAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${HIVE_KEY}` },
      body: JSON.stringify({ model: HIVEAI_MODEL, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch { return null; }
}

// GET /v1/exchange/ai/markets/:market_id/brief
router.get('/markets/:market_id/brief', async (req, res) => {
  const { market_id } = req.params;
  let orderBookCtx = `market_id: ${market_id}`;
  try {
    const r = await fetch(`https://hiveexchange-service.onrender.com/v1/exchange/markets/${market_id}`, { signal: AbortSignal.timeout(5_000) });
    if (r.ok) {
      const d = await r.json();
      const m = d?.market || d;
      orderBookCtx = `market: ${m?.name || market_id}, price: ${m?.price || 'unknown'}, 24h_volume: ${m?.volume_24h || 0}, spread: ${m?.spread || 'unknown'}`;
    }
  } catch (_) {}

  const system = 'You are HiveExchange — 4,054 markets, T+0 atomic settlement, 4 rails. Give a sharp trade timing brief. Entry/exit signal, key risk. 2-3 sentences. Be direct.';
  const user = `${orderBookCtx}. Should an agent enter now, wait, or exit? What is the primary risk?`;
  const brief = await hiveaiComplete(system, user);
  return res.json({
    success: true,
    market_id,
    brief: brief || `Market ${market_id}: T+0 atomic settlement available on all 4 rails. Check order depth via /v1/exchange/markets/${market_id}/orders before committing. Primary risk is thin order book — confirm spread before entry.`,
    source: brief ? 'hiveai' : 'fallback',
    price_usdc: 0.03,
    generated_at: new Date().toISOString(),
  });
});

// POST /v1/exchange/ai/brief — general market conditions brief
router.post('/brief', async (req, res) => {
  const { asset_pair = 'USDC/ETH', position_usdc = 100, direction = 'buy', urgency = 'medium' } = req.body || {};
  const system = 'You are HiveExchange — 4,054 markets, T+0 atomic settlement, agent-native. Give a direct trade brief: entry, sizing, settlement rail recommendation. 2 sentences.';
  const user = `Pair: ${asset_pair}. Size: $${position_usdc} USDC. Direction: ${direction}. Urgency: ${urgency}. Which rail and what timing?`;
  const brief = await hiveaiComplete(system, user);
  return res.json({
    success: true,
    brief: brief || `For a ${direction} on ${asset_pair} at $${position_usdc}, use Base USDC rail for speed or USDCx/Aleo for ZK-private settlement. T+0 atomic — no counterparty risk, no settlement delay.`,
    recommended_rail: position_usdc > 500 ? 'usdcx_aleo' : 'usdc_base',
    source: brief ? 'hiveai' : 'fallback',
    price_usdc: 0.03,
    generated_at: new Date().toISOString(),
  });
});

export default router;
