// node tools/check-unit.test.mjs — offline tests of the checker with a fake registry.
import { check, validate, markdown } from './check-unit.mjs';
let pass = 0, fail = 0;
const t = (name, cond, d) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, d ? JSON.stringify(d).slice(0, 500) : ''); } };

const good = {
  unit: 'C-amy-1', lease: 'lz_0123456789abcdef0123', handle: 'octocat', model: 'claude-opus-5-5', kind: 'evidence',
  verdict: 'supports', proposed_status: 'checked',
  summary: 'CLARITY AD randomised 1,795 people with early Alzheimer disease; lecanemab slowed decline on CDR-SB by 0.45 points (27%) at 18 months versus placebo.',
  evidence: [
    { type: 'nct', id: 'NCT03887455', role: 'primary', finding: 'Registered phase 3 trial; primary endpoint CDR-SB change at 18 months.' },
    { type: 'pmid', id: '36449413', role: 'primary', finding: 'NEJM 2023: difference -0.45 on CDR-SB (95% CI -0.67 to -0.23).' }
  ],
  new_claims: []
};
const J = o => JSON.stringify(o);
const reply = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => json });
const fake = (over = {}) => async url => {
  for (const [k, v] of Object.entries(over)) if (url.includes(k)) return typeof v === 'function' ? v(url) : v;
  if (url.includes('/desk/unit')) return reply(200, { unit: 'C-amy-1', status: 'conj', kind: 'evidence', open: false });
  if (url.includes('clinicaltrials.gov')) return reply(200, { protocolSection: { identificationModule: { briefTitle: 'Clarity AD' }, statusModule: { overallStatus: 'COMPLETED' } }, hasResults: true });
  if (url.includes('esummary')) { const id = new URL(url).searchParams.get('id'); return reply(200, { result: { [id]: { title: 'Lecanemab in Early Alzheimer Disease.', pubtype: ['Journal Article'], source: 'N Engl J Med', pubdate: '2023 Jan 5' } } }); }
  if (url.includes('crossref')) return reply(200, { message: { title: ['A paper'], 'container-title': ['Nature'], issued: { 'date-parts': [[2006]] } } });
  return reply(200, {});
};
const opts = (o = {}) => ({ path: 'units/C-amy-1.json', author: 'octocat', hub: 'https://hub.test', fetchFn: fake(), ...o });

let r = await check(J(good), opts());
t('valid file passes', r.state === 'PASSED' && r.items.length === 2 && r.items[1].title.startsWith('Lecanemab'), r);
t('markdown has marker and table', markdown(r).includes('<!-- adx-checker -->') && markdown(r).includes('| Source |'));

r = await check(J(good), opts({ author: 'someone-else' }));
t('author must match handle', r.state === 'REJECTED' && /pull request author/.test(r.errors[0]), r.errors);
r = await check(J(good), opts({ path: 'units/C-amy-2.json' }));
t('path must match unit', r.state === 'REJECTED', r.errors);
r = await check(J({ ...good, extra: 1 }), opts());
t('unknown field rejected', r.errors.some(e => /unknown field "extra"/.test(e)), r.errors);
r = await check(J({ ...good, verdict: 'contradicts' }), opts());
t('verdict/status mismatch rejected', r.errors.some(e => /proposed_status must be refuted or dead/.test(e)), r.errors);
r = await check(J({ ...good, evidence: [{ ...good.evidence[0], id: 'NCT123' }] }), opts());
t('malformed NCT rejected', r.errors.some(e => /NCT01234567/.test(e)), r.errors);
r = await check(J({ ...good, evidence: [{ type: 'fda', id: 'https://evil.example/fda', role: 'primary', finding: 'An approval letter for the product.' }] }), opts());
t('non-FDA host rejected', r.errors.some(e => /fda.gov/.test(e)), r.errors);
r = await check(J({ ...good, evidence: [good.evidence[0], good.evidence[0]] }), opts());
t('duplicate source rejected', r.errors.some(e => /repeats/.test(e)), r.errors);
r = await check(J({ ...good, summary: 'too short' }), opts());
t('short summary rejected', r.errors.some(e => /summary must be/.test(e)), r.errors);
r = await check('{not json', opts());
t('bad JSON rejected', r.state === 'REJECTED' && /not valid JSON/.test(r.errors[0]), r.errors);
r = await check('x'.repeat(70000), opts());
t('oversize rejected', /larger than/.test(r.errors[0]), r.errors);

r = await check(J(good), opts({ fetchFn: fake({ 'clinicaltrials.gov': reply(404, {}) }) }));
t('unknown NCT rejected', r.state === 'REJECTED' && /not found on ClinicalTrials.gov/.test(r.errors.join()), r.errors);
r = await check(J(good), opts({ fetchFn: fake({ esummary: url => { const id = new URL(url).searchParams.get('id'); return reply(200, { result: { [id]: { error: 'cannot get document summary' } } }); } }) }));
t('unknown PMID rejected', r.errors.some(e => /not found on PubMed/.test(e)), r.errors);
r = await check(J(good), opts({ fetchFn: fake({ esummary: url => { const id = new URL(url).searchParams.get('id'); return reply(200, { result: { [id]: { title: 'X', pubtype: ['Journal Article', 'Retracted Publication'] } } }); } }) }));
t('retracted primary PMID rejected', r.errors.some(e => /retracted/.test(e)), r.errors);
const deadClaim = { ...good, verdict: 'contradicts', proposed_status: 'dead', evidence: [{ type: 'doi', id: '10.1038/nature04533', role: 'contradicting', finding: 'The Nature 2006 paper on Abeta*56 was retracted in 2024.' }, { type: 'pmid', id: '38918585', role: 'primary', finding: 'Retraction notice published by Nature in June 2024.' }] };
r = await check(J(deadClaim), opts({ fetchFn: fake({ crossref: reply(200, { message: { title: ['A specific amyloid-beta protein assembly'], 'updated-by': [{ type: 'retraction' }] } }) }) }));
t('retracted source allowed as contradicting', r.state === 'PASSED' && r.warnings.some(w => /retracted/.test(w)), r);
r = await check(J({ ...good, evidence: [good.evidence[0]] }), opts({ fetchFn: fake({ 'clinicaltrials.gov': reply(200, { protocolSection: { statusModule: { overallStatus: 'RECRUITING' } }, hasResults: false }) }) }));
t('checked needs results, not just a registration', r.errors.some(e => /needs a primary source with results/.test(e)), r.errors);
r = await check(J(good), opts({ fetchFn: fake({ esummary: reply(503, {}) }) }));
t('registry outage is FAULT, not rejection', r.state === 'FAULT' && !r.errors.length, r);
r = await check(J(good), opts({ fetchFn: fake({ '/desk/unit': reply(200, { status: 'checked', kind: 'refute' }) }) }));
t('kind must match the desk', r.errors.some(e => /is a refute unit/.test(e)), r.errors);
r = await check(J(good), opts({ fetchFn: fake({ '/desk/unit': reply(503, {}) }) }));
t('hub down only warns', r.state === 'PASSED' && r.warnings.some(w => /hub could not confirm/.test(w)), r);
r = await check(J({ ...good, new_claims: [{ program: 'zzz', text: 'short', refutes_if: 'x' }] }), opts());
t('bad new claim rejected', r.errors.some(e => /new_claims\[0\]/.test(e)), r.errors);
const v = validate(J({ ...good, lease: '' }), { path: 'units/C-amy-1.json' });
t('no lease only warns (floor points)', !v.errors.length && v.warnings.some(w => /floor/.test(w)), v);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
