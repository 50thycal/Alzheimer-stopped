import pg from 'pg';

let pool;

export const dbUrl = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
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

export const event = (q, { agent = null, claim = null, type, message }) =>
  q.query('insert into events (agent_id, claim_id, type, message) values ($1,$2,$3,$4)', [agent, claim, type, message]);
