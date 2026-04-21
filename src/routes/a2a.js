/**
 * a2a.js — A2A Protocol JSON-RPC Endpoint
 *
 * Implements the Agent2Agent Protocol spec (v0.2.1) at POST /
 * Also handles legacy v0.1 method name (tasks/send → message/send)
 *
 * The openclaw.io audit found our agents registered on a2aregistry.org
 * with healthy HEAD responses but no tasks/send handler. This fixes that.
 *
 * Spec: https://google.github.io/A2A/specification/
 *
 * METHODS IMPLEMENTED:
 *   message/send    — v0.2.1 current spec (creates/continues a task)
 *   tasks/send      — v0.1 legacy compat (same behavior)
 *   tasks/get       — retrieve task by ID
 *   tasks/cancel    — cancel a task
 *   tasks/resubscribe — SSE reconnect (returns current state)
 *
 * TASK LIFECYCLE:
 *   submitted → working → completed
 *                       → input-required (if DID missing)
 *                       → auth-required  (if payment required)
 *                       → failed
 *
 * HIVE ROUTING:
 *   - No DID: task state = auth-required, onboard URL returned
 *   - Has DID, valid intent: routes to HiveExchange capabilities
 *   - Unknown skill: returns input-required with skill list
 */

'use strict';

import express from 'express';
import crypto  from 'crypto';

const router = express.Router();

const SERVICE_NAME  = 'HiveExchange';
const SERVICE_URL   = 'https://hiveexchange-service.onrender.com';
const ONBOARD_URL   = 'https://hivegate.onrender.com/v1/gate/onboard';
const INTERNAL_KEY  = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

// In-memory task store (sufficient — tasks are ephemeral A2A sessions)
const TASKS = new Map();

function taskId()     { return 'task-'    + crypto.randomBytes(8).toString('hex'); }
function contextId()  { return 'ctx-'     + crypto.randomBytes(8).toString('hex'); }

// ── Skill router — maps incoming text to a HiveExchange capability ────────────

const SKILLS = [
  { keyword: ['price', 'quote', 'cost'],        skill: 'prices',      description: 'Live asset prices — BTC, ETH, SOL, ALEO, FX, metals via Pyth' },
  { keyword: ['market', 'markets', 'list'],      skill: 'markets',     description: 'List or create prediction/trading markets' },
  { keyword: ['predict', 'bet', 'outcome'],      skill: 'predict',     description: 'Place or resolve prediction market bets' },
  { keyword: ['trade', 'swap', 'exchange'],      skill: 'trade',       description: 'Execute spot trades or pool swaps' },
  { keyword: ['perp', 'perpetual', 'short', 'long'], skill: 'perps',  description: 'Perpetual futures positions on agent flow indexes' },
  { keyword: ['intent', 'route', 'settle'],      skill: 'intent',      description: 'Submit and route transaction intent (God Loop)' },
  { keyword: ['trust', 'rating', 'score'],       skill: 'trust',       description: 'CLOAzK trust ratings and agent credit scores' },
  { keyword: ['faucet', 'free', 'usdc', '$1'],   skill: 'faucet',      description: 'Claim $1 USDC faucet — free to registered agents' },
  { keyword: ['identity', 'did', 'onboard'],     skill: 'identity',    description: 'Register DID, get credentials, onboard to Hive' },
];

function routeSkill(text = '') {
  const lower = text.toLowerCase();
  for (const s of SKILLS) {
    if (s.keyword.some(k => lower.includes(k))) return s;
  }
  return null;
}

// ── Build a Task object ───────────────────────────────────────────────────────

function makeTask(id, ctxId, state, textResponse, metadata = {}) {
  return {
    id,
    contextId: ctxId,
    status: {
      state,
      message: {
        role:  'agent',
        parts: [{ type: 'text', text: textResponse }],
      },
      timestamp: new Date().toISOString(),
    },
    artifacts: state === 'completed' ? [{
      artifactId: 'resp-' + crypto.randomBytes(4).toString('hex'),
      parts: [{ type: 'text', text: textResponse }],
    }] : undefined,
    metadata: {
      service:  SERVICE_NAME,
      network:  'Hive Civilization — 24+ services',
      onboard:  ONBOARD_URL,
      ...metadata,
    },
  };
}

// ── Core handler — shared by message/send and tasks/send ─────────────────────

async function handleSend(params, req) {
  const { id, message, contextId: inContextId, metadata = {} } = params || {};

  if (!id)      return { error: { code: -32602, message: 'Missing required field: id' } };
  if (!message) return { error: { code: -32602, message: 'Missing required field: message' } };

  const tid    = id;
  const ctxId  = inContextId || contextId();
  const did    = req.headers['x-hive-did'] || req.headers['x-agent-did'] || metadata.agent_did || null;

  // Extract text from message parts
  const parts  = message.parts || [];
  const text   = parts.find(p => p.type === 'text')?.text || '';

  // No DID — auth-required
  if (!did) {
    const task = makeTask(tid, ctxId, 'auth-required',
      `This is ${SERVICE_NAME} — part of Hive Civilization (24+ services). ` +
      `To interact, register a free Hive DID at ${ONBOARD_URL} ` +
      `and include it as the X-Hive-DID header. First DID is free.`,
      { auth_required: true, onboard: ONBOARD_URL }
    );
    TASKS.set(tid, task);
    return { result: task };
  }

  // Route to skill
  const skill = routeSkill(text);

  if (!skill) {
    const task = makeTask(tid, ctxId, 'input-required',
      `I'm ${SERVICE_NAME}. I can help with: ` +
      SKILLS.map(s => s.skill).join(', ') + '. ' +
      `What would you like to do? Include your X-Hive-DID header to transact.`,
      { skills: SKILLS.map(s => ({ skill: s.skill, description: s.description })) }
    );
    TASKS.set(tid, task);
    return { result: task };
  }

  // Route to endpoint
  const endpoints = {
    prices:   `${SERVICE_URL}/v1/exchange/prices`,
    markets:  `${SERVICE_URL}/v1/exchange/markets`,
    predict:  `${SERVICE_URL}/v1/exchange/predict/markets`,
    trade:    `${SERVICE_URL}/v1/exchange/orders`,
    perps:    `${SERVICE_URL}/v1/exchange/perps/markets`,
    intent:   `${SERVICE_URL}/v1/exchange/intent/submit`,
    trust:    `${SERVICE_URL}/v1/exchange/ratings/did/${did}`,
    faucet:   `${SERVICE_URL}/v1/exchange/faucet/claim`,
    identity: ONBOARD_URL,
  };

  const task = makeTask(tid, ctxId, 'completed',
    `Routed to ${skill.description}. ` +
    `Endpoint: ${endpoints[skill.skill]}. ` +
    `Your DID (${did}) is recognized. Include X-Hive-DID on your next request.`,
    {
      skill:    skill.skill,
      endpoint: endpoints[skill.skill],
      agent_did: did,
      hive_network: '24+ services | thehiveryiq.com',
    }
  );
  TASKS.set(tid, task);
  return { result: task };
}

// ── JSON-RPC dispatcher ───────────────────────────────────────────────────────

router.post('/', express.json(), async (req, res) => {
  const { jsonrpc, id: rpcId, method, params } = req.body || {};

  // Validate JSON-RPC envelope
  if (!method) {
    return res.status(200).json({
      jsonrpc: '2.0', id: rpcId || null,
      error: { code: -32600, message: 'Invalid Request — missing method' },
    });
  }

  try {
    let result;

    switch (method) {

      // ── v0.2.1 current + v0.1 legacy ──────────────────────────────────────
      case 'message/send':
      case 'tasks/send': {
        result = await handleSend(params, req);
        break;
      }

      // ── tasks/get ─────────────────────────────────────────────────────────
      case 'tasks/get': {
        const tid = params?.id;
        if (!tid) {
          result = { error: { code: -32602, message: 'Missing required field: id' } };
          break;
        }
        const task = TASKS.get(tid);
        if (!task) {
          result = { error: { code: -32001, message: `Task ${tid} not found` } };
          break;
        }
        result = { result: task };
        break;
      }

      // ── tasks/cancel ──────────────────────────────────────────────────────
      case 'tasks/cancel': {
        const tid = params?.id;
        if (!tid) {
          result = { error: { code: -32602, message: 'Missing required field: id' } };
          break;
        }
        const task = TASKS.get(tid);
        if (!task) {
          result = { error: { code: -32001, message: `Task ${tid} not found` } };
          break;
        }
        task.status.state = 'canceled';
        task.status.timestamp = new Date().toISOString();
        TASKS.set(tid, task);
        result = { result: task };
        break;
      }

      // ── tasks/resubscribe — return current state (no SSE for now) ─────────
      case 'tasks/resubscribe': {
        const tid = params?.id;
        const task = tid ? TASKS.get(tid) : null;
        result = { result: task || { error: 'Task not found or expired' } };
        break;
      }

      // ── Agent Card discovery ───────────────────────────────────────────────
      case 'agent/getCard':
      case 'agent/card': {
        result = { result: {
          protocolVersion: '0.2.1',
          name: SERVICE_NAME,
          description: 'A2A-compliant exchange, prediction markets, perps, derivatives, CLOAzK trust ratings, and transaction intent routing for autonomous agents.',
          url: SERVICE_URL,
          skills: SKILLS.map(s => ({
            id: s.skill, name: s.skill, description: s.description,
            inputModes: ['application/json'], outputModes: ['application/json'],
          })),
          capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
        }};
        break;
      }

      // ── Unknown method ────────────────────────────────────────────────────
      default: {
        result = { error: { code: -32601, message: `Method not found: ${method}`, data: {
          supported: ['message/send', 'tasks/send', 'tasks/get', 'tasks/cancel', 'tasks/resubscribe'],
          service: SERVICE_NAME,
        }}};
      }
    }

    // Return JSON-RPC 2.0 envelope
    if (result.error) {
      return res.status(200).json({ jsonrpc: '2.0', id: rpcId, error: result.error });
    }
    return res.status(200).json({ jsonrpc: '2.0', id: rpcId, result: result.result });

  } catch (e) {
    console.error('[A2A]', method, e.message);
    return res.status(200).json({
      jsonrpc: '2.0', id: rpcId,
      error: { code: -32603, message: 'Internal error', data: e.message },
    });
  }
});

export default router;
