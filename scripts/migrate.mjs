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

-- Every claim is a unit of work on the desk. Leases are held by a GitHub handle.
create table if not exists claims (
  id serial primary key,
  program text not null references programs(id),
  status text not null check (status in ('checked','conj','work','refuted','dead')),
  level text not null default 'solid' check (level in ('warmup','solid','hard','open')),
  text text not null,
  refutes_if text,
  date_label text not null default 'Open',
  source text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  lease_id text unique,
  lease_handle text,
  lease_model text,
  lease_price int,
  lease_kind text,
  lease_until timestamptz
);

create table if not exists contributors (
  handle text primary key,
  points int not null default 0,
  accepted int not null default 0,
  submitted int not null default 0,
  released int not null default 0,
  last_model text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

-- One row per pull request that carries a unit file.
create table if not exists submissions (
  id serial primary key,
  claim_id int not null references claims(id),
  handle text not null,
  lease_id text,
  pr int not null unique,
  pr_url text not null,
  kind text,
  verdict text,
  proposed_status text check (proposed_status in ('checked','conj','work','refuted','dead')),
  state text not null check (state in ('passed','failed','accepted','rejected')),
  report jsonb not null default '{}',
  points int not null default 0,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists releases (
  id serial primary key,
  claim_id int not null references claims(id),
  handle text not null,
  reason text not null,
  at timestamptz not null default now()
);

create table if not exists events (
  id bigserial primary key,
  at timestamptz not null default now(),
  handle text,
  claim_id int,
  type text not null,
  message text not null
);

create table if not exists desk_hits (
  bucket text not null,
  minute timestamptz not null,
  n int not null default 0,
  primary key (bucket, minute)
);

create index if not exists events_handle_at on events (handle, at);
create index if not exists submissions_claim on submissions (claim_id);
create index if not exists submissions_handle on submissions (handle);
create index if not exists releases_lookup on releases (claim_id, handle, at);
create index if not exists claims_open on claims (status, lease_until);
`;

// Price levels for the seeded record: open questions are worth more than re-checking settled ones.
const seedLevel = c => (c.status === 'checked' ? 'hard' : c.status === 'conj' ? 'solid' : c.status === 'work' ? 'solid' : 'warmup');

export async function migrate(connectionString, seedPath = 'public/data/claims.json') {
  const client = new pg.Client({ connectionString: connectionString.replace(/([?&])sslmode=(prefer|require|verify-ca)(?=&|$)/, '$1sslmode=verify-full') });
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
          'insert into claims (program, status, level, text, date_label, source) values ($1,$2,$3,$4,$5,$6)',
          [c.program, c.status, seedLevel(c), c.text, c.date, c.source || null]
        );
        seeded++;
      }
      await client.query("insert into events (type, message) values ('seed', $1)", [`Record opened with ${seeded} claims from public results.`]);
    }
    // Old key-based tables from the first hub draft are not used any more.
    await client.query('drop table if exists attempts');
    await client.query('drop table if exists agents');
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
