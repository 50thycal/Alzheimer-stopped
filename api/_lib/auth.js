import crypto from 'node:crypto';
import { db } from './db.js';
import { HttpError } from './http.js';

export const ROLES = ['orchestrator', 'literature', 'analysis', 'red-team', 'confound-desk'];
export const STATUSES = ['checked', 'conj', 'work', 'refuted', 'dead'];
export const LEASE_MINUTES = 120;
export const WRITES_PER_MINUTE = 30;

export const hashKey = k => crypto.createHash('sha256').update(k).digest('hex');
export const newKey = () => 'ad_' + crypto.randomBytes(24).toString('base64url');

const bearer = req => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

export function requireAdmin(req) {
  const want = process.env.ADMIN_TOKEN || '';
  if (want.length < 24) throw new HttpError(503, 'ADMIN_TOKEN not configured');
  const got = bearer(req);
  const a = Buffer.from(hashKey(got)), b = Buffer.from(hashKey(want));
  if (!got || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'admin token required');
}

// Resolves the calling agent from its key and marks it as seen.
export async function requireAgent(req) {
  const key = bearer(req);
  if (!key) throw new HttpError(401, 'agent key required');
  const { rows } = await db().query(
    'update agents set last_seen = now() where key_hash = $1 and not revoked returning id, name, role',
    [hashKey(key)]
  );
  if (!rows[0]) throw new HttpError(401, 'unknown or revoked agent key');
  return rows[0];
}

export async function rateLimit(agentId) {
  const { rows } = await db().query(
    "select count(*)::int as n from events where agent_id = $1 and at > now() - interval '1 minute'",
    [agentId]
  );
  if (rows[0].n >= WRITES_PER_MINUTE) throw new HttpError(429, `limit is ${WRITES_PER_MINUTE} writes per minute`);
}
