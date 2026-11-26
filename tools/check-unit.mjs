#!/usr/bin/env node
// The checker. Judges one unit file (units/C-<program>-<n>.json) the same way locally and in CI.
//
//   node tools/check-unit.mjs <file> [--path units/C-tau-13.json] [--author <github login>]
//                             [--hub https://...] [--offline] [--report out.json] [--markdown out.md]
//
// Exit 0 = PASSED, 1 = REJECTED (the file is wrong), 2 = FAULT (a registry or the hub could not be
// reached; says nothing about the file). The file is only ever parsed as JSON: nothing in it runs.
//
// What PASSED means: the file is well-formed, consistent, sent by the lease holder, and every
// identifier it cites exists, is not retracted, and (for a "checked" proposal) has posted results.
// Whether the evidence truly supports the claim is decided by human review when the PR is merged.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'alzheimer-stopped-checker/1.0 (https://github.com/50thycal/Alzheimer-stopped)';
const MAX_BYTES = 64 * 1024;

export const VERDICT_STATUS = {
  evidence: { supports: ['checked', 'work'], contradicts: ['refuted', 'dead'], mixed: ['conj', 'work'], insufficient: ['conj'] },
  refute: { supports: ['checked'], contradicts: ['refuted', 'dead'], mixed: ['checked', 'conj'], insufficient: ['checked'] }
};
const KEYS = ['unit', 'lease', 'handle', 'model', 'kind', 'verdict', 'proposed_status', 'summary', 'evidence', 'new_claims'];
const EV_KEYS = ['type', 'id', 'role', 'finding'];
const NC_KEYS = ['program', 'text', 'refutes_if'];
const FDA_HOSTS = new Set(['fda.gov', 'www.fda.gov', 'accessdata.fda.gov', 'www.accessdata.fda.gov']);

const programs = () => {
  try { return new Set(JSON.parse(readFileSync(join(ROOT, 'public/data/claims.json'), 'utf8')).programs.map(p => p.id)); }
  catch { return new Set(['amy', 'tau', 'imm', 'apoe', 'vas', 'met', 'inf', 'det', 'prev', 'syn']); }
};

// ---------- pure validation ----------
export function validate(raw, { path, author } = {}) {
  const errors = [], warnings = [];
  const err = m => errors.push(m), warn = m => warnings.push(m);
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return { errors: [`file is larger than ${MAX_BYTES / 1024} KiB`], warnings, doc: null };
  if (raw.includes('\uFFFD')) err('file is not valid UTF-8');
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { return { errors: [`not valid JSON: ${e.message}`], warnings, doc: null }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { errors: ['the file must be one JSON object'], warnings, doc: null };

  for (const k of Object.keys(doc)) if (!KEYS.includes(k)) err(`unknown field "${k}"`);
  for (const k of KEYS) if (!(k in doc)) err(`missing field "${k}"`);
  const s = (v, name, min, max) => {
    if (typeof v !== 'string') { err(`${name} must be a string`); return ''; }
    const t = v.trim();
    if (t.length < min || t.length > max) err(`${name} must be ${min}-${max} characters (is ${t.length})`);
    return t;
  };

  const unit = s(doc.unit, 'unit', 4, 20);
  const um = unit.match(/^C-([a-z]{2,8})-(\d{1,7})$/);
  if (!um) err('unit must look like C-tau-13');
  if (path && path !== `units/${unit}.json`) err(`the file must be at units/${unit}.json (it is at ${path})`);
  if (um && !programs().has(um[1])) err(`unknown program "${um[1]}"`);

  if (doc.lease !== '' && !(typeof doc.lease === 'string' && /^lz_[0-9a-f]{20}$/.test(doc.lease))) err('lease must be the lease id from the desk (lz_...), or "" if you hold none');
  if (doc.lease === '') warn('no lease: a unit you did not take earns only the floor of 10 points');
  const h = s(doc.handle, 'handle', 1, 39);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(h)) err('handle must be a GitHub login');
  if (author && h.toLowerCase() !== author.toLowerCase()) err(`handle "${h}" is not the pull request author "${author}"`);
  if (typeof doc.model !== 'string' || !/^[A-Za-z0-9._:\/-]{1,60}$/.test(doc.model)) err('model must be a short id like claude-opus-5-5, or unknown');

  const kind = doc.kind;
  if (!['evidence', 'refute'].includes(kind)) err('kind must be evidence or refute (as the desk gave it)');
  const verdict = doc.verdict;
  if (!['supports', 'contradicts', 'mixed', 'insufficient'].includes(verdict)) err('verdict must be supports, contradicts, mixed or insufficient');
  const allowed = VERDICT_STATUS[kind]?.[verdict];
  if (allowed && !allowed.includes(doc.proposed_status)) err(`for kind ${kind} with verdict ${verdict}, proposed_status must be ${allowed.join(' or ')}`);
  s(doc.summary, 'summary', 80, 2000);

  const ev = Array.isArray(doc.evidence) ? doc.evidence : (err('evidence must be an array'), []);
  if (ev.length < 1 || ev.length > 12) err('evidence must have 1-12 items');
  const seen = new Set();
  ev.forEach((e, i) => {
    const at = `evidence[${i}]`;
    if (!e || typeof e !== 'object') return err(`${at} must be an object`);
    for (const k of Object.keys(e)) if (!EV_KEYS.includes(k)) err(`${at}: unknown field "${k}"`);
    if (!['nct', 'pmid', 'doi', 'fda'].includes(e.type)) err(`${at}.type must be nct, pmid, doi or fda`);
    if (!['primary', 'supporting', 'contradicting'].includes(e.role)) err(`${at}.role must be primary, supporting or contradicting`);
    s(e.finding, `${at}.finding`, 20, 600);
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (e.type === 'nct' && !/^NCT\d{8}$/.test(id)) err(`${at}.id must look like NCT01234567`);
    if (e.type === 'pmid' && !/^[1-9]\d{0,8}$/.test(id)) err(`${at}.id must be a PubMed id (digits only)`);
    if (e.type === 'doi' && !/^10\.\d{4,9}\/[^\s"<>]{1,200}$/.test(id)) err(`${at}.id must be a bare DOI like 10.1056/NEJMoa2212948`);
    if (e.type === 'fda') {
      let u; try { u = new URL(id); } catch {}
      if (!u || u.protocol !== 'https:' || !FDA_HOSTS.has(u.hostname)) err(`${at}.id must be an https URL on fda.gov or accessdata.fda.gov`);
    }
    const key = `${e.type}:${id.toLowerCase()}`;
    if (seen.has(key)) err(`${at} repeats ${e.type} ${id}`);
    seen.add(key);
  });
  if (ev.length && !ev.some(e => e && e.role === 'primary')) err('at least one evidence item must have role primary');
  if (verdict === 'contradicts' && !ev.some(e => e && (e.role === 'contradicting' || e.role === 'primary'))) err('a contradicts verdict needs primary or contradicting evidence');

  const nc = Array.isArray(doc.new_claims) ? doc.new_claims : (err('new_claims must be an array (use [] for none)'), []);
  if (nc.length > 3) err('new_claims holds at most 3 claims');
  nc.forEach((n, i) => {
    const at = `new_claims[${i}]`;
    if (!n || typeof n !== 'object') return err(`${at} must be an object`);
    for (const k of Object.keys(n)) if (!NC_KEYS.includes(k)) err(`${at}: unknown field "${k}"`);
    if (!programs().has(n.program)) err(`${at}.program is not a program id`);
    s(n.text, `${at}.text`, 15, 400);
    s(n.refutes_if, `${at}.refutes_if`, 10, 400);
  });
  return { errors, warnings, doc };
}

// ---------- registry lookups ----------
async function getJson(fetchFn, url, { allow404 = true } = {}) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetchFn(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 404 && allow404) return { status: 404 };
      if (r.status === 429 || r.status >= 500) { last = `HTTP ${r.status}`; await new Promise(z => setTimeout(z, 1000 * (attempt + 1))); continue; }
      if (!r.ok) return { status: r.status };
      return { status: 200, json: await r.json() };
    } catch (e) { last = e.message; await new Promise(z => setTimeout(z, 1000 * (attempt + 1))); }
  }
  return { status: 0, fault: last || 'unreachable' };
}

export async function resolve(e, fetchFn = fetch) {
  const id = e.id.trim();
  if (e.type === 'nct') {
    const r = await getJson(fetchFn, `https://clinicaltrials.gov/api/v2/studies/${id}?format=json`);
    if (r.fault) return { fault: `ClinicalTrials.gov: ${r.fault}` };
    if (r.status === 404) return { found: false, detail: 'not found on ClinicalTrials.gov' };
    if (r.status !== 200) return { fault: `ClinicalTrials.gov answered HTTP ${r.status}` };
    const p = r.json.protocolSection || {};
    return {
      found: true,
      title: p.identificationModule?.briefTitle || '',
      detail: `${p.statusModule?.overallStatus || 'status unknown'}${r.json.hasResults ? ', results posted' : ', no results posted'}`,
      has_results: !!r.json.hasResults,
      url: `https://clinicaltrials.gov/study/${id}`
    };
  }
  if (e.type === 'pmid') {
    const r = await getJson(fetchFn, `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${id}`);
    if (r.fault) return { fault: `PubMed: ${r.fault}` };
    if (r.status !== 200) return { fault: `PubMed answered HTTP ${r.status}` };
    const rec = r.json.result?.[id];
    if (!rec || rec.error) return { found: false, detail: 'not found on PubMed' };
    const types = (rec.pubtype || []).map(String);
    return {
      found: true,
      title: rec.title || '',
      detail: [rec.fulljournalname || rec.source, rec.pubdate].filter(Boolean).join(', '),
      retracted: types.includes('Retracted Publication'),
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`
    };
  }
  if (e.type === 'doi') {
    const r = await getJson(fetchFn, `https://api.crossref.org/works/${encodeURIComponent(id)}`);
    if (r.fault) return { fault: `Crossref: ${r.fault}` };
    if (r.status === 404) return { found: false, detail: 'DOI not registered with Crossref' };
    if (r.status !== 200) return { fault: `Crossref answered HTTP ${r.status}` };
    const m = r.json.message || {};
    const upd = (m['updated-by'] || []).map(u => String(u.type || '').toLowerCase());
    return {
      found: true,
      title: (m.title || [])[0] || '',
      detail: [(m['container-title'] || [])[0], m.issued?.['date-parts']?.[0]?.[0]].filter(Boolean).join(', '),
      retracted: upd.includes('retraction') || upd.includes('withdrawal'),
      url: `https://doi.org/${id}`
    };
  }
  if (e.type === 'fda') {
    try {
      const r = await fetchFn(id, { method: 'GET', redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
      if (r.status === 404 || r.status === 410) return { found: false, detail: `FDA page answered HTTP ${r.status}` };
      if (!r.ok) return { found: true, unverified: true, detail: `FDA site answered HTTP ${r.status}; not verified automatically`, url: id };
      return { found: true, detail: 'FDA page reachable', url: id };
    } catch (err) { return { found: true, unverified: true, detail: `FDA site unreachable (${err.message}); not verified automatically`, url: id }; }
  }
  return { found: false, detail: 'unknown type' };
}

async function hubUnit(fetchFn, hub, unit) {
  const r = await getJson(fetchFn, `${hub}/desk/unit?id=${encodeURIComponent(unit)}`, { allow404: true });
  return r;
}

// ---------- full check ----------
export async function check(raw, { path, author, hub, offline = false, fetchFn = fetch } = {}) {
  const { errors, warnings, doc } = validate(raw, { path, author });
  const items = [], faults = [];
  if (doc && !errors.length && !offline) {
    if (hub) {
      const u = await hubUnit(fetchFn, hub, doc.unit);
      if (u.status === 404) errors.push(`${doc.unit} is not a unit on the desk`);
      else if (u.status === 200) {
        if (u.json.status === 'dead') errors.push(`${doc.unit} is ruled dead`);
        if (u.json.kind && u.json.kind !== doc.kind) errors.push(`${doc.unit} is a ${u.json.kind} unit, not ${doc.kind}`);
      } else warnings.push('the hub could not confirm the unit (it may not be connected yet)');
    }
    for (const e of doc.evidence) {
      const r = await resolve(e, fetchFn);
      items.push({ type: e.type, id: e.id.trim(), role: e.role, ...r });
      if (r.fault) faults.push(`${e.type} ${e.id}: ${r.fault}`);
      else if (!r.found) errors.push(`${e.type} ${e.id}: ${r.detail}`);
      else if (r.retracted && e.role !== 'contradicting') errors.push(`${e.type} ${e.id} is retracted; cite it only as contradicting evidence`);
      else if (r.retracted) warnings.push(`${e.type} ${e.id} is retracted (cited as contradicting: fine)`);
      if (r.unverified) warnings.push(`${e.type} ${e.id}: ${r.detail}`);
    }
    if (doc.proposed_status === 'checked' && doc.kind === 'evidence') {
      const strong = items.some(i => i.role === 'primary' && i.found && !i.retracted &&
        (i.type === 'pmid' || i.type === 'doi' || (i.type === 'fda' && !i.unverified) || (i.type === 'nct' && i.has_results)));
      if (!strong && !faults.length) errors.push('proposing checked needs a primary source with results: a paper (pmid or doi), an FDA decision, or a trial with posted results');
    }
  } else if (offline && doc) warnings.push('offline: identifiers were not looked up');

  const ok = !errors.length && !faults.length;
  const state = errors.length ? 'REJECTED' : faults.length ? 'FAULT' : 'PASSED';
  const summary_line = errors.length ? errors[0] : faults.length ? `could not reach a registry: ${faults[0]}` : offline ? 'format checks passed; identifiers not looked up (offline)' : `${items.length} source(s) verified`;
  return { state, ok, unit: doc?.unit, kind: doc?.kind, verdict: doc?.verdict, proposed_status: doc?.proposed_status, lease: doc?.lease, handle: doc?.handle, errors, warnings, faults, items, summary_line };
}

export function markdown(rep) {
  const head = { PASSED: 'Checker: PASSED', REJECTED: 'Checker: REJECTED', FAULT: 'Checker: FAULT (not your fault; it will be checked again)' }[rep.state];
  const lines = [`<!-- adx-checker -->`, `### ${head}`, ''];
  if (rep.unit) lines.push(`Unit **${rep.unit}** · ${rep.kind} · verdict **${rep.verdict}** · proposes **${rep.proposed_status}**`, '');
  if (rep.errors.length) lines.push('**What to fix**', ...rep.errors.map(e => `- ${e}`), '');
  if (rep.faults.length) lines.push('**Could not check**', ...rep.faults.map(e => `- ${e}`), '');
  if (rep.items.length) {
    lines.push('| Source | Role | Found | Title | Notes |', '|---|---|---|---|---|');
    for (const i of rep.items) {
      const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').slice(0, 140);
      lines.push(`| ${i.url ? `[${cell(i.type + ' ' + i.id)}](${i.url})` : cell(i.type + ' ' + i.id)} | ${i.role} | ${i.fault ? 'fault' : i.found ? (i.retracted ? 'retracted' : 'yes') : 'no'} | ${cell(i.title)} | ${cell(i.detail || i.fault)} |`);
    }
    lines.push('');
  }
  if (rep.warnings.length) lines.push('**Notes**', ...rep.warnings.map(e => `- ${e}`), '');
  lines.push(rep.state === 'PASSED'
    ? 'Every source exists and none is retracted. A maintainer now reviews whether the evidence supports the verdict; merging accepts it and credits the points.'
    : rep.state === 'REJECTED' ? 'Push a fixed file to this same pull request, or release the unit and move on.' : 'Nothing to do: the check reruns on the next push, or a maintainer reruns it.');
  return lines.join('\n');
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const VAL = new Set(['--path', '--author', '--hub', '--report', '--markdown']);
  let file;
  for (let i = 0; i < args.length; i++) { if (VAL.has(args[i])) { i++; continue; } if (!args[i].startsWith('--')) { file = args[i]; break; } }
  if (!file) { console.error('usage: node tools/check-unit.mjs <file> [--path units/C-x-n.json] [--author login] [--hub URL] [--offline]'); process.exit(2); }
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(2); }
  const rep = await check(raw, { path: opt('--path'), author: opt('--author'), hub: opt('--hub')?.replace(/\/$/, ''), offline: args.includes('--offline') });
  if (opt('--report')) writeFileSync(opt('--report'), JSON.stringify(rep, null, 2));
  if (opt('--markdown')) writeFileSync(opt('--markdown'), markdown(rep));
  console.log(`${rep.state}: ${rep.summary_line}`);
  for (const e of rep.errors) console.log(`  fix: ${e}`);
  for (const f of rep.faults) console.log(`  fault: ${f}`);
  for (const w of rep.warnings) console.log(`  note: ${w}`);
  process.exit(rep.state === 'PASSED' ? 0 : rep.state === 'REJECTED' ? 1 : 2);
}
