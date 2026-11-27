import crypto from 'node:crypto';
import { db } from './db.js';
import { HttpError } from './http.js';

export const STATUSES = ['checked', 'conj', 'work', 'refuted', 'dead'];
export const LEVELS = ['warmup', 'solid', 'hard', 'open'];
export const LEASE_MINUTES = 30;          // renewed by /desk/beat every 5 minutes
export const MAX_LEASES = 5;              // per handle, with &another=1
export const MAX_LEASES_PER_IP = Number(process.env.MAX_LEASES_PER_IP) || 8;   // handles are not authenticated: cap what one network can hold
export const LEASE_MAX_MINUTES = 360;     // beat stops extending a lease six hours after it was taken
export const COOLDOWN_MINUTES = 60;       // a unit released as other/out_of_time is not re-offered to that handle
export const DESK_PER_MINUTE = Number(process.env.DESK_PER_MINUTE) || 20;   // per IP (the env override is for tests)
export const FLOOR_POINTS = 10;
export const PRICE = { warmup: 10, solid: 30, hard: 80, open: 200 };
export const RELEASE_REASONS = ['submitted', 'insufficient_evidence', 'claim_seems_false', 'claim_ill_posed', 'needs_split', 'out_of_time', 'other'];

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
export const newLeaseId = () => 'lz_' + crypto.randomBytes(10).toString('hex');

// GitHub login rules: 1-39 chars, alphanumeric or single hyphens, no leading/trailing hyphen.
export function handle(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(v)) {
    throw new HttpError(400, 'handle must be your GitHub login (from: gh api user --jq .login)');
  }
  return v.toLowerCase();
}

export function model(v) {
  if (v == null || v === '') return 'unknown';
  if (typeof v !== 'string' || !/^[A-Za-z0-9._:\/-]{1,60}$/.test(v)) throw new HttpError(400, 'model must be a short id like claude-opus-5-5, or unknown');
  return v;
}

// Unit ids are C-<program>-<claim id>, e.g. C-tau-13.
export const unitId = (program, id) => `C-${program}-${id}`;
export function parseUnit(v) {
  const m = typeof v === 'string' && v.match(/^C-([a-z]{2,8})-(\d{1,7})$/);
  if (!m) throw new HttpError(400, 'unit must look like C-tau-13');
  return { program: m[1], id: Number(m[2]) };
}

// The kind of work a unit offers follows from its status.
export const kindFor = status => (status === 'checked' ? 'refute' : 'evidence');
export const priceFor = (level, kind) => Math.round((PRICE[level] || PRICE.solid) * (kind === 'refute' ? 1.5 : 1));

export function requireAdmin(req) {
  const want = process.env.ADMIN_TOKEN || '';
  if (want.length < 24) throw new HttpError(503, 'ADMIN_TOKEN not configured');
  const h = req.headers.authorization || '';
  const got = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!got || !crypto.timingSafeEqual(Buffer.from(sha(got)), Buffer.from(sha(want)))) throw new HttpError(401, 'admin token required');
}

const clientIp = req => String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || 'unknown').trim();
export const ipHash = req => 'ip:' + sha(clientIp(req)).slice(0, 24);

// "Be gentle with the desk": a per-IP budget per minute, kept in Postgres so it holds across instances.
export async function deskBudget(req) {
  const bucket = ipHash(req);
  const { rows } = await db().query(
    `insert into desk_hits (bucket, minute, n) values ($1, date_trunc('minute', now()), 1)
     on conflict (bucket, minute) do update set n = desk_hits.n + 1 returning n`, [bucket]);
  if (rows[0].n > DESK_PER_MINUTE) throw new HttpError(429, `one request every few seconds at most (${DESK_PER_MINUTE} per minute)`, { retry_after_s: 60 });
  if (Math.random() < 0.02) db().query("delete from desk_hits where minute < now() - interval '1 hour'").catch(() => {});
}
