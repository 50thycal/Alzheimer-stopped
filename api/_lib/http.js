import { hasDb } from './db.js';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export function send(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

// Reads the raw stream so behaviour is identical on Vercel and in the local dev server.
export async function body(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'body must be JSON'); }
}

// Wraps a handler: method check, DB presence, error mapping. Handlers get (req, res, url).
export function route(methods, handler) {
  return async (req, res) => {
    try {
      if (!methods.includes(req.method)) {
        res.setHeader('allow', methods.join(', '));
        throw new HttpError(405, `use ${methods.join(' or ')}`);
      }
      if (!hasDb()) throw new HttpError(503, 'hub database not attached');
      await handler(req, res, new URL(req.url, 'http://hub'));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
      if (e && e.code === '23505') return send(res, 409, { error: 'already exists' });
      console.error(e);
      send(res, 500, { error: 'internal error' });
    }
  };
}

export const str = (v, name, { min = 1, max = 2000 } = {}) => {
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be a string`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `${name} must be ${min}-${max} characters`);
  return s;
};

export const oneOf = (v, name, set) => {
  if (!set.includes(v)) throw new HttpError(400, `${name} must be one of: ${set.join(', ')}`);
  return v;
};

export const httpsUrl = (v, name) => {
  if (v == null || v === '') return null;
  const s = str(v, name, { max: 500 });
  if (!/^https:\/\/[^\s]+$/.test(s)) throw new HttpError(400, `${name} must be an https URL`);
  return s;
};
