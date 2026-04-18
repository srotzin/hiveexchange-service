// did-auth.js — x-hive-did header check, 402 on missing
const HIVEGATE_URL = process.env.HIVEGATE_URL || 'https://hivegate.onrender.com';

/**
 * Require x-hive-did header. Returns 402 with onboard URL if missing.
 */
export function requireDid(req, res, next) {
  const did = req.headers['x-hive-did'] || req.body?.did;
  if (!did) {
    return res.status(402).json({
      status: 'error',
      error: 'DID_REQUIRED',
      detail: 'A Hive DID is required to trade on HiveExchange. Register your agent at HiveGate.',
      onboard_url: `${HIVEGATE_URL}/v1/gate/register`,
      hivegateway: HIVEGATE_URL,
      docs: 'https://github.com/srotzin/hivegate-service#agent-dids',
    });
  }
  req.hive_did = did;
  next();
}

/**
 * Optional DID extraction — does not block if missing.
 * Sets req.hive_did if present, null otherwise.
 */
export function optionalDid(req, res, next) {
  req.hive_did = req.headers['x-hive-did'] || req.body?.did || null;
  next();
}

/**
 * Require internal Hive key for admin actions.
 */
export function requireInternalKey(req, res, next) {
  const key = req.headers['x-hive-internal-key'] || req.headers['authorization']?.replace('Bearer ', '');
  const validKey = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

  if (!key || key !== validKey) {
    return res.status(403).json({
      status: 'error',
      error: 'FORBIDDEN',
      detail: 'Internal Hive key required for this action.',
    });
  }
  next();
}
