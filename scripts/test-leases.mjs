// Lease limits, against a LOCAL hub: one network can only hold so many units, and a lease is renewed for six hours at most.
// Needs the database (it backdates a lease) and a hub started with a roomy per-minute budget:
//   DESK_PER_MINUTE=1000 DATABASE_URL=... ADMIN_TOKEN=... node scripts/dev.mjs
//   HUB=http://localhost:3124 DATABASE_URL=... ADMIN_TOKEN=... node scripts/test-leases.mjs
import pg from 'pg';

const HUB = (process.env.HUB || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN = process.env.ADMIN_TOKEN;
if (!process.env.DATABASE_URL || !ADMIN) { console.error('DATABASE_URL and ADMIN_TOKEN are needed (local only)'); process.exit(2); }
const sql = new pg.Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
let pass = 0, fail = 0;
const expect = (name, cond, detail) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, detail ? JSON.stringify(detail).slice(0, 400) : ''); } };
async function call(method, path, { key, body } = {}) {
  const r = await fetch(HUB + path, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const tag = Date.now().toString(36);
const PR = 800000 + Math.floor(Math.random() * 90000) * 10;
const held = [];

// 1. Six hours at most.
let r = await call('GET', `/desk/next?handle=lt-${tag}&kind=evidence`);
const l = r.json.lease, u = r.json.unit;
expect('takes a unit', r.status === 200 && l?.id, r);
r = await call('POST', `/desk/beat?lease=${l.id}`);
expect('beat renews a fresh lease', r.status === 200 && r.json.ok, r);
await sql.query("update claims set lease_since = now() - interval '7 hours' where lease_id = $1", [l.id]);
r = await call('POST', `/desk/beat?lease=${l.id}`);
expect('beat refuses a lease older than six hours (410, expired, not withdrawn)', r.status === 410 && r.json.expired === true && r.json.withdrawn === false, r);
r = await call('POST', `/desk/release?lease=${l.id}&reason=submitted`);
expect('a finished unit can still be released as submitted after that', r.status === 200, r);
r = await call('POST', '/desk/verdict', { key: ADMIN, body: { unit: u.id, handle: `lt-${tag}`, lease: l.id, pr: PR + 1, stage: 'passed', verdict: 'supports', proposed_status: 'work', kind: 'evidence' } });
expect('and still earns its lease price', r.json.points === l.price && l.price > 10, { got: r.json, price: l.price });

// 2. One network, at most MAX_LEASES_PER_IP units (default 8) however many handles it invents.
let capped = null;
for (let i = 0; i < 14 && !capped; i++) {
  const x = await call('GET', `/desk/next?handle=cap-${tag}-${i}`);
  if (x.status === 200 && x.json.lease) held.push(x.json.lease.id);
  else if (x.status === 429 && /this network/.test(x.json?.error || '')) capped = x;
  else if (x.status === 200 && x.json.unit === null) break;   // desk ran dry before the cap: cannot judge
}
expect('a network stops getting units after the cap', !!capped && held.length <= 8 && held.length >= 1, { held: held.length, capped: capped?.json });
for (const id of held) await call('POST', `/desk/release?lease=${id}&reason=other`);

await sql.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
