#!/usr/bin/env node
// Runs inside GitHub Actions (pull_request_target). Never checks out or runs anything from the pull request:
// it lists the PR's files through the API and reads the bytes of the one unit file as data.
//
//   node tools/ci-pr.mjs check     judge the unit file, comment the verdict, report to the hub
//   node tools/ci-pr.mjs closed    on merge: credit on the hub; on close: record the rejection
import { check, markdown } from './check-unit.mjs';

const env = k => process.env[k] || '';
const REPO = env('GITHUB_REPOSITORY');
const PR = Number(env('PR_NUMBER'));
let AUTHOR = env('PR_AUTHOR');
const HUB = (env('HUB') || 'https://alzheimer-stopped.vercel.app').replace(/\/$/, '');
const TOKEN = env('GITHUB_TOKEN');
const PATH_RE = /^units\/C-[a-z]{2,8}-\d{1,7}\.json$/;
const MARK = '<!-- adx-checker -->';

async function gh(method, path, body, accept = 'application/vnd.github+json') {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'adx-ci', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok && r.status !== 404) throw new Error(`GitHub ${method} ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  if (r.status === 404) return null;
  return accept.includes('raw') ? r.text() : r.json();
}

async function prFiles() {
  const files = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh('GET', `/repos/${REPO}/pulls/${PR}/files?per_page=100&page=${page}`);
    if (!batch || !batch.length) break;
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

async function comment(body) {
  const list = (await gh('GET', `/repos/${REPO}/issues/${PR}/comments?per_page=100`)) || [];
  const mine = list.filter(c => c.user?.type === 'Bot' && String(c.body || '').includes(MARK)).pop();
  if (mine) await gh('PATCH', `/repos/${REPO}/issues/comments/${mine.id}`, { body });
  else await gh('POST', `/repos/${REPO}/issues/${PR}/comments`, { body });
}

async function label(add, remove) {
  try { await gh('POST', `/repos/${REPO}/issues/${PR}/labels`, { labels: [add] }); } catch (e) { console.log(`label: ${e.message}`); }
  try { await gh('DELETE', `/repos/${REPO}/issues/${PR}/labels/${encodeURIComponent(remove)}`); } catch {}
}

async function hub(payload) {
  const key = env('HUB_ADMIN_TOKEN');
  if (!key) return { skipped: 'HUB_ADMIN_TOKEN secret is not set' };
  if (!/^[\x21-\x7e]+$/.test(key)) return { error: 'HUB_ADMIN_TOKEN holds characters that are not plain text (masked dots or spaces were probably pasted); set it again with the real value' };
  try {
    const r = await fetch(`${HUB}/desk/verdict`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20000)
    });
    const json = await r.json().catch(() => ({}));
    return r.ok ? json : { error: `hub HTTP ${r.status}: ${json.error || 'no detail'}` };
  } catch (e) { return { error: `hub unreachable: ${e.message}` }; }
}

const prUrl = `https://github.com/${REPO}/pull/${PR}`;

async function runCheck() {
  const files = await prFiles();
  let rep;
  const unitFiles = files.filter(f => PATH_RE.test(f.filename));
  if (files.length !== 1 || unitFiles.length !== 1 || unitFiles[0].status !== 'added') {
    const why = files.length !== 1
      ? `a unit pull request changes exactly one file; this one changes ${files.length}`
      : unitFiles.length !== 1 ? `the one file must be units/C-<program>-<n>.json (it is ${files[0]?.filename})`
      : 'the unit file must be new: never edit a file already on main';
    rep = { state: 'REJECTED', ok: false, errors: [why], warnings: [], faults: [], items: [], summary_line: why };
  } else {
    const f = unitFiles[0];
    const raw = await gh('GET', `/repos/${env('HEAD_REPO')}/contents/${f.filename}?ref=${env('HEAD_SHA')}`, null, 'application/vnd.github.raw+json');
    if (raw == null) throw new Error('could not read the unit file from the pull request head');
    rep = await check(String(raw), { path: f.filename, author: AUTHOR, hub: HUB });
  }
  let note = '';
  if (rep.state !== 'FAULT' && rep.unit) {
    const h = await hub({
      unit: rep.unit, handle: AUTHOR, lease: rep.lease || null, pr: PR, pr_url: prUrl,
      stage: rep.state === 'PASSED' ? 'passed' : 'failed', kind: rep.kind, verdict: rep.verdict, proposed_status: rep.proposed_status,
      report: { summary_line: rep.summary_line, errors: rep.errors, warnings: rep.warnings, items: rep.items.map(({ type, id, role, found, retracted, title, detail }) => ({ type, id, role, found, retracted, title: (title || '').slice(0, 200), detail })) }
    });
    note = h.skipped ? `\n\n_Hub: not recorded (${h.skipped})._`
      : h.error ? `\n\n_Hub: not recorded (${h.error})._`
      : rep.state === 'PASSED' ? `\n\n_Hub: recorded. Worth **${h.points}** points if merged._` : '\n\n_Hub: recorded._';
  }
  await comment(markdown(rep) + note);
  await label(rep.state === 'PASSED' ? 'checks-passed' : 'checks-failed', rep.state === 'PASSED' ? 'checks-failed' : 'checks-passed');
  console.log(`${rep.state}: ${rep.summary_line}`);
  process.exit(rep.state === 'PASSED' ? 0 : 1);
}

async function runClosed() {
  const files = await prFiles();
  const f = files.length === 1 && PATH_RE.test(files[0].filename) ? files[0] : null;
  if (!f) { console.log('not a unit pull request; nothing to record'); return; }
  const unit = f.filename.slice('units/'.length, -'.json'.length);
  const merged = env('MERGED') === 'true';
  let file = null;
  if (merged) {
    const raw = await gh('GET', `/repos/${REPO}/contents/${f.filename}?ref=${env('MERGE_SHA')}`, null, 'application/vnd.github.raw+json');
    try { file = JSON.parse(String(raw)); } catch { file = null; }
  }
  const h = await hub({ unit, handle: AUTHOR, pr: PR, pr_url: prUrl, stage: merged ? 'merged' : 'closed', file });
  // Merged before the checker's verdict reached the hub (a fast merge, or the hub was briefly down during the
  // check): the hub says 409 "no checked submission". Check the merged file now, exactly as the maintainer's
  // replay does, instead of leaving the pull request uncredited until someone notices.
  if (merged && h.error && /HTTP 409/.test(h.error)) { console.log('merged before the check was recorded; replaying'); return runReplay(); }
  let body;
  if (!merged) body = `${MARK}\n### Closed without merging\nThe submission is recorded as rejected. ${h.error || h.skipped ? `_(Hub: ${h.error || h.skipped})_` : ''}`;
  else if (h.state === 'accepted') body = `${MARK}\n### Accepted\n+${h.points} points to @${AUTHOR}.${h.status ? ` ${unit} is now **${h.status}**.` : ''}${h.opened?.length ? ` Opened ${h.opened.join(', ')}.` : ''}`;
  else body = `${MARK}\n### Merged, not credited\n${h.error || h.skipped || h.note || 'The hub did not accept this merge.'}`;
  await gh('POST', `/repos/${REPO}/issues/${PR}/comments`, { body });
  console.log(JSON.stringify(h));
}

// Replay: re-record a pull request on the hub after it was down or its token was wrong.
// A merged PR is checked again from the merged file, then recorded as passed and merged.
async function runReplay() {
  const pr = await gh('GET', `/repos/${REPO}/pulls/${PR}`);
  if (!pr) throw new Error(`no pull request #${PR}`);
  AUTHOR = pr.user.login;
  if (!pr.merged) {
    if (pr.state === 'open') { process.env.HEAD_REPO = pr.head.repo.full_name; process.env.HEAD_SHA = pr.head.sha; return runCheck(); }
    console.log('closed without merging: nothing to replay'); return;
  }
  const files = await prFiles();
  const f = files.length === 1 && PATH_RE.test(files[0].filename) ? files[0] : null;
  if (!f) { console.log('not a unit pull request'); return; }
  const raw = await gh('GET', `/repos/${REPO}/contents/${f.filename}?ref=${pr.merge_commit_sha}`, null, 'application/vnd.github.raw+json');
  const rep = await check(String(raw), { path: f.filename, author: AUTHOR, hub: HUB });
  if (rep.state !== 'PASSED') { console.log(`the merged file does not pass now (${rep.state}: ${rep.summary_line}); not credited`); process.exit(1); }
  const passed = await hub({
    unit: rep.unit, handle: AUTHOR, lease: rep.lease || null, pr: PR, pr_url: prUrl, stage: 'passed',
    kind: rep.kind, verdict: rep.verdict, proposed_status: rep.proposed_status,
    report: { summary_line: rep.summary_line, errors: rep.errors, warnings: rep.warnings, items: rep.items.map(({ type, id, role, found, retracted, title, detail }) => ({ type, id, role, found, retracted, title: (title || '').slice(0, 200), detail })) }
  });
  if (passed.error || passed.skipped) throw new Error(passed.error || passed.skipped);
  let file = null; try { file = JSON.parse(String(raw)); } catch {}
  const h = await hub({ unit: rep.unit, handle: AUTHOR, pr: PR, pr_url: prUrl, stage: 'merged', file });
  if (h.error || h.skipped) throw new Error(h.error || h.skipped);
  const body = h.state === 'accepted'
    ? `${MARK}\n### Accepted (replayed)\n+${h.points} points to @${AUTHOR}.${h.status ? ` ${rep.unit} is now **${h.status}**.` : ''}${h.opened?.length ? ` Opened ${h.opened.join(', ')}.` : ''}`
    : `${MARK}\n### Replayed\n${h.note || h.state}`;
  await gh('POST', `/repos/${REPO}/issues/${PR}/comments`, { body });
  console.log(JSON.stringify(h));
}

const mode = process.argv[2];
if (!REPO || !PR || !TOKEN || (mode !== 'replay' && !AUTHOR)) { console.error('missing GitHub context'); process.exit(2); }
(mode === 'check' ? runCheck() : mode === 'closed' ? runClosed() : mode === 'replay' ? runReplay() : Promise.reject(new Error('mode is check, closed or replay')))
  .catch(e => { console.error(e.message); process.exit(2); });
