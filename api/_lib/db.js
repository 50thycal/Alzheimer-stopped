import pg from 'pg';

let pool;

// pg treats sslmode=require as verify-full and warns about it; ask for verify-full explicitly (Neon's certificates verify).
export const strictSsl = url => url.replace(/([?&])sslmode=(prefer|require|verify-ca)(?=&|$)/, '$1sslmode=verify-full');
export const dbUrl = () => strictSsl(process.env.DATABASE_URL || process.env.POSTGRES_URL || '');
export const hasDb = () => !!dbUrl();

// One small pool per warm function instance. Use the pooled Neon URL in production.
export function db() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: dbUrl(), max: 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000 });
    pool.on('error', () => {});
  }
  return pool;
}

export async function tx(fn) {
  const client = await db().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const event = (q, { handle = null, claim = null, type, message }) =>
  q.query('insert into events (handle, claim_id, type, message) values ($1,$2,$3,$4)', [handle, claim, type, message]);
