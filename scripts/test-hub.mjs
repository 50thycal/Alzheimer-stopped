// End-to-end check of the hub API. Creates test agents, so run it against a local or preview hub, not production.
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
  else { fail++; console.log('  FAIL', name, detail ? JSON.stringify(detail) : ''); }
}

const tag = Date.now().toString(36);
let r = await call('GET', '/api/state');
expect('state loads from hub', r.status === 200 && r.json.source === 'hub' && r.json.claims.length > 0, r.json);
const claimId = r.json.claims.find(c => c.status === 'conj' && !c.lease_agent)?.id;

r = await call('POST', '/api/agents', { body: { name: 'x', role: 'literature' } });
expect('minting without admin is refused', r.status === 401, r);
r = await call('POST', '/api/agents', { key: ADMIN, body: { name: `test lit ${tag}`, role: 'literature' } });
expect('admin mints agent A', r.status === 201 && r.json.key?.startsWith('ad_'), r.json);
const A = r.json;
r = await call('POST', '/api/agents', { key: ADMIN, body: { name: `test red ${tag}`, role: 'red-team' } });
const B = r.json;
r = await call('POST', '/api/agents', { key: ADMIN, body: { name: `test red ${tag}`, role: 'red-team' } });
expect('duplicate agent name rejected', r.status === 409, r);
r = await call('POST', '/api/agents', { key: ADMIN, body: { name: 'bad role', role: 'god' } });
expect('bad role rejected', r.status === 400, r);

r = await call('GET', '/api/me', { key: A.key });
expect('agent key resolves', r.status === 200 && r.json.agent.id === A.id, r.json);
r = await call('GET', '/api/me', { key: 'ad_nope' });
expect('bad key refused', r.status === 401, r);

r = await call('POST', `/api/claims/${claimId}/attempt`, { key: A.key, body: { kind: 'argument', body: 'An argument long enough to pass validation.' } });
expect('attempt without lease refused', r.status === 409, r);
r = await call('POST', `/api/claims/${claimId}/take`, { key: A.key });
expect('A takes claim', r.status === 200 && r.json.lease_until, r.json);
r = await call('POST', `/api/claims/${claimId}/take`, { key: B.key });
expect('B blocked by lease', r.status === 409 && r.json.lease_agent === A.id, r.json);

r = await call('POST', `/api/claims/${claimId}/attempt`, { key: A.key, body: { kind: 'result', body: 'A result with no evidence attached at all.' } });
expect('result without evidence refused', r.status === 400, r);
r = await call('POST', `/api/claims/${claimId}/attempt`, { key: A.key, body: { kind: 'evidence', body: 'Registry entry for the trial that tests this claim.', evidence: [{ type: 'nct', ref: 'NCT123' }] } });
expect('malformed NCT refused', r.status === 400, r);
r = await call('POST', `/api/claims/${claimId}/attempt`, {
  key: A.key,
  body: { kind: 'result', body: 'Pre-registered primary endpoint met; see registry.', evidence: [{ type: 'nct', ref: 'NCT01234567' }], proposed_status: 'checked' }
});
expect('A submits result', r.status === 201 && r.json.attempt, r.json);
const attemptId = r.json.attempt;

r = await call('GET', `/api/claims/${claimId}`);
expect('claim detail shows attempt + lease', r.status === 200 && r.json.attempts.some(a => a.id === attemptId) && r.json.claim.lease_agent === A.id, r.json);

r = await call('POST', `/api/claims/${claimId}/verdict`, { key: A.key, body: { attempt_id: attemptId, verdict: 'accepted', note: 'self-check' } });
expect('agent cannot act as checker', r.status === 401, r);
r = await call('POST', `/api/claims/${claimId}/verdict`, { key: ADMIN, body: { attempt_id: attemptId, verdict: 'rejected', note: 'Test run; registry ID is a placeholder.' } });
expect('checker rejects attempt', r.status === 200 && r.json.verdict === 'rejected' && r.json.status === null, r.json);
r = await call('POST', `/api/claims/${claimId}/verdict`, { key: ADMIN, body: { attempt_id: attemptId, verdict: 'accepted', note: 'second try' } });
expect('verdict is final', r.status === 404, r);

r = await call('POST', '/api/claims', { key: B.key, body: { program: 'tau', text: 'Test claim stated by the end-to-end check run.', refutes_if: 'Refuted if this test fails.' } });
expect('B proposes new conjecture', r.status === 201 && r.json.status === 'conj', r.json);
const newId = r.json.id;
r = await call('POST', '/api/claims', { key: B.key, body: { program: 'nope', text: 'Test claim with an unknown program id.', refutes_if: 'Refuted if accepted.' } });
expect('unknown program refused', r.status === 400, r);

r = await call('POST', `/api/claims/${claimId}/release`, { key: B.key });
expect('B cannot release A lease', r.status === 409, r);
r = await call('POST', `/api/claims/${claimId}/release`, { key: A.key });
expect('A releases', r.status === 200, r);
r = await call('POST', `/api/claims/${claimId}/take`, { key: B.key });
expect('B takes after release', r.status === 200, r);

r = await call('GET', '/api/events?limit=50');
const types = new Set(r.json.events.map(e => e.type));
expect('events logged', ['agent_joined', 'claim_taken', 'attempt', 'verdict', 'claim_proposed', 'claim_released'].every(t => types.has(t)), [...types]);
const maxId = Math.max(...r.json.events.map(e => e.id));
r = await call('GET', `/api/events?after=${maxId}`);
expect('polling after newest returns nothing', r.status === 200 && r.json.events.length === 0, r.json);

r = await call('GET', '/api/agents');
expect('contributors list hides keys', r.status === 200 && r.json.agents.some(a => a.id === A.id) && !JSON.stringify(r.json).includes('key_hash'), r.json);

r = await call('DELETE', `/api/agents?id=${encodeURIComponent(B.id)}`, { key: ADMIN });
expect('admin revokes B (lease dropped)', r.status === 200, r);
r = await call('GET', '/api/me', { key: B.key });
expect('revoked key refused', r.status === 401, r);
r = await call('GET', `/api/claims/${claimId}`);
expect('revoked agent lease cleared', r.json.claim.lease_agent === null, r.json.claim);
r = await call('DELETE', `/api/agents?id=${encodeURIComponent(A.id)}`, { key: ADMIN });

r = await call('PUT', '/api/state');
expect('wrong method is 405', r.status === 405, r);

console.log(`\n${pass} passed, ${fail} failed${newId ? ` (test claim #${newId} left as conjecture)` : ''}`);
process.exit(fail ? 1 : 0);
