// End-to-end check of the desk and hub API. Creates test contributors and submissions:
// run it against a local hub, never production.
// HUB=http://localhost:3000 ADMIN_TOKEN=... node scripts/test-hub.mjs
const HUB = (process.env.HUB || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN = process.env.ADMIN_TOKEN;
let pass = 0, fail = 0;

async function call(method, path, { key, body } = {}) {
  const r = await fetch(HUB + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
function expect(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, detail ? JSON.stringify(detail).slice(0, 400) : ''); }
}

const PR = 900000 + Math.floor(Math.random() * 90000) * 10;
const A = 'test-a-' + Date.now().toString(36), B = 'test-b-' + Date.now().toString(36);
let r = await call('GET', '/api/state');
expect('state loads from hub', r.status === 200 && r.json.source === 'hub' && r.json.claims.length > 0, r.json);
const openBefore = r.json.counts.units_open;

r = await call('GET', '/desk/next?handle=bad_handle!');
expect('bad handle refused', r.status === 400, r);
r = await call('GET', `/desk/next?handle=${A}&model=claude-opus-5-5&program=tau&kind=evidence`);
expect('A takes a tau evidence unit', r.status === 200 && r.json.unit?.program === 'tau' && r.json.unit.kind === 'evidence' && r.json.lease?.id, r.json);
const u1 = r.json.unit, l1 = r.json.lease;
expect('unit carries template, file and price', u1.template?.unit === u1.id && u1.file === `units/${u1.id}.json` && l1.price > 0, u1);
r = await call('GET', `/desk/next?handle=${A}&model=claude-opus-5-5`);
expect('asking again returns the held unit', r.json.unit?.id === u1.id && /already hold/.test(r.json.note || ''), r.json);
r = await call('GET', `/desk/next?handle=${B}&unit=${u1.id}`);
expect('B cannot take A unit', r.status === 200 && r.json.unit === null, r.json);
r = await call('GET', `/desk/unit?id=${u1.id}`);
expect('unit shows leased', r.json.open === false && r.json.leased_by === A.toLowerCase(), r.json);

r = await call('POST', `/desk/beat?lease=${l1.id}`);
expect('beat renews', r.status === 200 && r.json.ok, r.json);
r = await call('POST', '/desk/beat?lease=lz_nope');
expect('unknown lease is 410 withdrawn', r.status === 410 && r.json.withdrawn === true, r);
r = await call('GET', `/desk/next?handle=${A}&another=1&kind=refute`);
expect('A takes a second (refute) unit with another=1', r.status === 200 && r.json.unit?.kind === 'refute' && r.json.lease.price > 0, r.json);
const u2 = r.json.unit, l2 = r.json.lease;
r = await call('POST', `/desk/release?lease=${l2.id}&reason=bogus`);
expect('bad release reason refused', r.status === 400, r);
r = await call('POST', `/desk/release?lease=${l2.id}&reason=out_of_time`);
expect('A releases refute unit', r.status === 200, r);
r = await call('GET', `/desk/next?handle=${A}&unit=${u2.id}&another=1`);
expect('released out_of_time is not re-offered within the hour', r.json.unit === null, r.json);
r = await call('GET', `/desk/next?handle=${B}&unit=${u2.id}`);
expect('but B can take it', r.json.unit?.id === u2.id, r.json);
await call('POST', `/desk/release?lease=${r.json.lease.id}&reason=insufficient_evidence`);

// Production order: adx.sh opens the pull request and releases the lease as "submitted" within a second; CI judges the
// file 20-40 seconds later. The lease price must survive that release (it was frozen at floor 10 before this test).
const Cc = 'test-c-' + Date.now().toString(36);
r = await call('GET', `/desk/next?handle=${Cc}&kind=evidence`);
const u3 = r.json.unit, l3 = r.json.lease;
expect('C takes a priced unit', r.status === 200 && l3?.price > 10, r.json);
r = await call('POST', `/desk/release?lease=${l3.id}&reason=submitted`);
expect('C releases as submitted first', r.status === 200, r);
r = await call('POST', '/desk/verdict', { key: ADMIN, body: { unit: u3.id, handle: Cc, lease: l3.id, pr: PR + 4, stage: 'passed', verdict: 'supports', proposed_status: 'work', kind: 'evidence' } });
expect('lease price survives the release (production order)', r.json.points === l3.price, { got: r.json, price: l3.price });
r = await call('POST', '/desk/verdict', { key: ADMIN, body: { unit: u3.id, handle: 'someone-else', lease: l3.id, pr: PR + 5, stage: 'passed', verdict: 'supports', proposed_status: 'work', kind: 'evidence' } });
expect('another handle cannot use that lease (floor only)', r.json.points === 10, r.json);

// Checker: PR passes, then merged.
const file = {
  unit: u1.id, lease: l1.id, handle: A, model: 'claude-opus-5-5', kind: 'evidence', verdict: 'supports', proposed_status: 'work',
  summary: 'test', evidence: [{ type: 'nct', id: 'NCT04437511', role: 'primary', finding: 'test' }],
  new_claims: [{ program: 'tau', text: 'A follow-up claim opened by the end-to-end test run.', refutes_if: 'Refuted if the test is wrong.' }]
};
r = await call('POST', '/desk/verdict', { body: { unit: u1.id, handle: A, pr: PR + 1, stage: 'passed' } });
expect('verdict needs admin', r.status === 401, r);
r = await call('POST', '/desk/verdict', { key: ADMIN, body: { unit: u1.id, handle: A, lease: l1.id, pr: PR + 1, stage: 'passed', verdict: 'supports', proposed_status: 'work', kind: 'evidence', report: { summary_line: 'all identifiers resolve' } } });
expect('checker pass recorded with lease price', r.status === 200 && r.json.state === 'passed' && r.json.points === l1.price, r.json);
r = await call('POST', `/desk/release?lease=${l1.id}&reason=submitted`);
expect('A releases as submitted', r.status === 200, r);
r = await call('GET', `/desk/next?handle=${B}&unit=${u1.id}`);
expect('unit in review is not offered', r.json.unit === null, r.json);
r = await call('POST', '/desk/verdict', { key: ADMIN, body: { unit: u1.id, handle: A, pr: PR + 2, stage: 'merged' } });
expect('merge without a passed check refused', r.status === 409, r);
r = await call('POST', '/desk/verdict', { key: ADMIN, body: { unit: u1.id, handle: A, pr: PR + 1, stage: 'merged', file } });
expect('merge accepts: points, status, new claim', r.status === 200 && r.json.state === 'accepted' && r.json.status === 'work' && r.json.opened.length === 1, r.json);
r = await call('POST', '/desk/verdict', { key: ADMIN, body: { unit: u1.id, handle: A, lease: l1.id, pr: PR + 1, stage: 'passed', verdict: 'supports', proposed_status: 'work' } });
expect('a late re-check cannot reopen an accepted PR', r.json.state === 'accepted' && r.json.note === 'already decided', r.json);
r = await call('POST', '/desk/verdict', { key: ADMIN, body: { unit: u1.id, handle: A, pr: PR + 1, stage: 'merged', file } });
expect('second merge is idempotent', r.status === 200 && r.json.note === 'already decided', r.json);

// A floor-points submission: B sends a proof without a lease, then it is closed.
r = await call('POST', '/desk/verdict', { key: ADMIN, body: { unit: u1.id, handle: B, pr: PR + 3, stage: 'passed', verdict: 'contradicts', proposed_status: 'refuted' } });
expect('unleased pass earns floor', r.json.points === 10, r.json);
r = await call('POST', '/desk/verdict', { key: ADMIN, body: { unit: u1.id, handle: B, pr: PR + 3, stage: 'closed' } });
expect('closed PR rejected', r.json.state === 'rejected', r.json);

r = await call('GET', `/api/contributors?handle=${A}`);
expect('profile shows points and submission', r.status === 200 && r.json.contributor.points === l1.price && r.json.submissions.length === 1, r.json);
r = await call('GET', '/api/contributors');
expect('leaderboard lists A', r.json.contributors.some(c => c.handle === A.toLowerCase()), r.json);
r = await call('GET', `/api/claims/${u1.claim}`);
expect('claim detail shows submissions + releases', r.json.submissions.length >= 2 && r.json.claim.status === 'work', r.json);
r = await call('GET', '/api/events?limit=60');
const types = new Set(r.json.events.map(e => e.type));
expect('events logged', ['unit_taken', 'unit_released', 'check_passed', 'accepted', 'rejected'].every(t => types.has(t)), [...types]);
r = await call('GET', '/api/state');
expect('state counts update', r.json.counts.accepted >= 1 && r.json.leaders.some(l => l.handle === A.toLowerCase()), r.json.counts);

let limited = false;
for (let i = 0; i < 45 && !limited; i++) { const x = await call('GET', `/desk/unit?id=${u1.id}`); if (x.status === 429) limited = true; }
expect('desk rate limit applies per IP', limited);

console.log(`\n${pass} passed, ${fail} failed (open units before: ${openBefore})`);
process.exit(fail ? 1 : 0);
