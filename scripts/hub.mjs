#!/usr/bin/env node
// Admin CLI for the hub. You are the checker until Phase 2 automates it.
//   HUB=https://alzheimer-stopped.vercel.app ADMIN_TOKEN=... node scripts/hub.mjs <command>
//
//   mint <name> <role>                     create an agent, prints its key once
//   revoke <agent-id>                      remove an agent and drop its leases
//   agents                                 list agents
//   queue                                  attempts awaiting a verdict
//   accept <claim> <attempt> "<note>"      accept (applies proposed status)
//   reject <claim> <attempt> "<note>"      reject
const HUB = (process.env.HUB || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN;
const [cmd, ...args] = process.argv.slice(2);

async function call(method, path, body) {
  const r = await fetch(HUB + path, {
    method,
    headers: { ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`${r.status}: ${json.error || 'request failed'}`); process.exit(1); }
  return json;
}

const usage = () => { console.log(readHelp()); process.exit(1); };
function readHelp() { return 'commands: mint <name> <role> | revoke <id> | agents | queue | accept|reject <claim> <attempt> "<note>"'; }

switch (cmd) {
  case 'mint': {
    if (args.length < 2) usage();
    const r = await call('POST', '/api/agents', { name: args[0], role: args[1] });
    console.log(`agent ${r.id} (${r.role})\nkey: ${r.key}\nStore it now; it is not shown again.`);
    break;
  }
  case 'revoke': {
    if (!args[0]) usage();
    await call('DELETE', `/api/agents?id=${encodeURIComponent(args[0])}`);
    console.log(`revoked ${args[0]}`);
    break;
  }
  case 'agents': {
    const r = await call('GET', '/api/agents');
    for (const a of r.agents) console.log(`${a.id.padEnd(28)} ${a.role.padEnd(14)} attempts ${a.attempts} (accepted ${a.accepted})  last seen ${a.last_seen || 'never'}`);
    break;
  }
  case 'queue': {
    const r = await call('GET', '/api/attempts?open=1');
    if (!r.attempts.length) console.log('queue empty');
    for (const a of r.attempts) {
      console.log(`\n#${a.id} on claim #${a.claim} [${a.claim_status}] by ${a.agent}: ${a.kind}${a.proposed_status ? ' -> ' + a.proposed_status : ''}`);
      console.log(`  claim: ${a.claim_text}`);
      console.log(`  body:  ${a.body.replace(/\s+/g, ' ').slice(0, 400)}`);
      for (const e of a.evidence) console.log(`  evidence: ${e.type} ${e.ref}${e.note ? ' (' + e.note + ')' : ''}`);
    }
    break;
  }
  case 'accept':
  case 'reject': {
    if (args.length < 3) usage();
    const r = await call('POST', `/api/claims/${args[0]}/verdict`, { attempt_id: Number(args[1]), verdict: cmd === 'accept' ? 'accepted' : 'rejected', note: args[2] });
    console.log(`${r.verdict}${r.status ? `; claim is now ${r.status}` : ''}`);
    break;
  }
  default: usage();
}
