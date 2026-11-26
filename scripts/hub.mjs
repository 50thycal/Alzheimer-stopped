#!/usr/bin/env node
// Maintainer CLI. Merging a pull request on GitHub is the verdict; this shows what is waiting.
//   HUB=https://alzheimer-stopped.vercel.app node scripts/hub.mjs <command>
//     queue           pull requests that passed the checker and wait for review (oldest first)
//     contributors    the leaderboard
//     unit <C-x-n>    one unit: status, holder, pull requests
const HUB = (process.env.HUB || 'https://alzheimer-stopped.vercel.app').replace(/\/$/, '');
const [cmd, arg] = process.argv.slice(2);
const get = async p => { const r = await fetch(HUB + p); const j = await r.json().catch(() => ({})); if (!r.ok) { console.error(`${r.status}: ${j.error || 'failed'}`); process.exit(1); } return j; };
if (cmd === 'queue') {
  const { submissions } = await get('/api/submissions?state=passed');
  if (!submissions.length) console.log('nothing waiting for review');
  for (const s of submissions) {
    console.log(`\n${s.unit} [${s.claim_status}] ${s.pr_url}  by ${s.handle}: ${s.verdict} -> ${s.proposed_status}  (${s.points} pts)`);
    console.log(`  claim: ${s.claim}`);
    for (const i of s.report?.items || []) console.log(`  ${i.role.padEnd(13)} ${i.type} ${i.id}: ${i.title}`);
  }
} else if (cmd === 'contributors') {
  const { contributors } = await get('/api/contributors');
  contributors.forEach((c, i) => console.log(`${String(i + 1).padStart(3)}. ${c.handle.padEnd(28)} ${String(c.points).padStart(6)} pts  ${c.accepted} accepted  ${c.submitted} sent  ${c.released} handed back`));
} else if (cmd === 'unit' && /^C-[a-z]{2,8}-\d+$/.test(arg || '')) {
  const u = await get(`/desk/unit?id=${arg}`);
  const d = await get(`/api/claims/${arg.split('-').pop()}`);
  console.log(`${arg}: ${d.claim.status} (${u.kind}, ${d.claim.level})${u.leased_by ? `, held by ${u.leased_by}` : u.open ? ', open' : u.in_review ? ', in review' : ''}\n  ${d.claim.text}`);
  for (const s of d.submissions) console.log(`  ${s.pr_url} ${s.handle} ${s.state} ${s.verdict || ''}`);
} else console.log('commands: queue | contributors | unit <C-x-n>');
