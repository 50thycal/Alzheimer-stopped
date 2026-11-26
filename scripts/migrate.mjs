// Idempotent schema + seed. Safe to run on every build.
// Seeds programs (upsert) and claims (only when the claims table is empty) from public/data/claims.json.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const SCHEMA = `
create table if not exists programs (
  id text primary key,
  name text not null,
  goal text not null,
  ord int not null default 0
);
create table if not exists agents (
  id text primary key,
  name text not null,
  role text not null check (role in ('orchestrator','literature','analysis','red-team','confound-desk')),
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen timestamptz,
  revoked boolean not null default false
);
create table if not exists claims (
  id serial primary key,
  program text not null references programs(id),
  status text not null check (status in ('checked','conj','work','refuted','dead')),
  text text not null,
  refutes_if text,
  date_label text not null default 'Open',
  source text,
  created_by text references agents(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  lease_agent text references agents(id),
  lease_until timestamptz
);
create table if not exists attempts (
  id serial primary key,
  claim_id int not null references claims(id),
  agent_id text not null references agents(id),
  kind text not null check (kind in ('argument','evidence','result','refutation')),
  body text not null,
  evidence jsonb not null default '[]',
  proposed_status text check (proposed_status in ('checked','conj','work','refuted','dead')),
  verdict text check (verdict in ('accepted','rejected')),
  verdict_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create table if not exists events (
  id bigserial primary key,
  at timestamptz not null default now(),
  agent_id text,
  claim_id int,
  type text not null,
  message text not null
);
create index if not exists events_agent_at on events (agent_id, at);
create index if not exists attempts_claim on attempts (claim_id);
create index if not exists attempts_open on attempts (verdict) where verdict is null;
`;

export async function migrate(connectionString, seedPath = 'public/data/claims.json') {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(4242)');
    await client.query(SCHEMA);
    const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
    for (const [i, p] of seed.programs.entries()) {
      await client.query(
        'insert into programs (id, name, goal, ord) values ($1,$2,$3,$4) on conflict (id) do update set name = excluded.name, goal = excluded.goal, ord = excluded.ord',
        [p.id, p.name, p.goal, i]
      );
    }
    const { rows } = await client.query('select count(*)::int as n from claims');
    let seeded = 0;
    if (rows[0].n === 0) {
      for (const c of seed.claims) {
        await client.query(
          'insert into claims (program, status, text, date_label, source) values ($1,$2,$3,$4,$5)',
          [c.program, c.status, c.text, c.date, c.source || null]
        );
        seeded++;
      }
      await client.query("insert into events (type, message) values ('seed', $1)", [`Record opened with ${seeded} claims from public results.`]);
    }
    await client.query('commit');
    return { programs: seed.programs.length, seeded };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) { console.log('migrate: no DATABASE_URL, skipped'); process.exit(0); }
  migrate(url).then(r => console.log(`migrate: ok, ${r.programs} programs, ${r.seeded} claims seeded`))
    .catch(e => { console.error('migrate failed:', e.message); process.exit(1); });
}
