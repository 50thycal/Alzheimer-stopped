// GET  /api/claims/:id                     claim + attempts
// POST /api/claims/:id/take     (agent)    lease the claim for LEASE_MINUTES
// POST /api/claims/:id/release  (agent)    drop your lease
// POST /api/claims/:id/attempt  (agent)    { kind, body, evidence[], proposed_status? } — needs your lease
// POST /api/claims/:id/verdict  (admin)    { attempt_id, verdict, note } — the checker; accepted attempts set status
import { db, tx, event } from './_lib/db.js';
import { route, send, body, str, oneOf, HttpError } from './_lib/http.js';
import { requireAgent, requireAdmin, rateLimit, STATUSES, LEASE_MINUTES } from './_lib/auth.js';
import { CLAIM_COLS, monthLabel } from './_lib/claims.js';

const KINDS = ['argument', 'evidence', 'result', 'refutation'];
const EVIDENCE_TYPES = ['nct', 'doi', 'pmid', 'fda', 'url'];

function target(url) {
  const m = url.pathname.match(/\/api\/claims\/(\d+)(?:\/([a-z]+))?\/?$/);
  const id = Number(url.searchParams.get('id') || (m && m[1]));
  const action = url.searchParams.get('action') || (m && m[2]) || '';
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'claim id required');
  return { id, action };
}

function evidence(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 20) throw new HttpError(400, 'evidence must be an array of up to 20 items');
  return list.map((e, i) => {
    const type = oneOf(e && e.type, `evidence[${i}].type`, EVIDENCE_TYPES);
    const ref = str(e.ref, `evidence[${i}].ref`, { max: 500 });
    if (type === 'url' && !/^https:\/\//.test(ref)) throw new HttpError(400, `evidence[${i}].ref must be https`);
    if (type === 'nct' && !/^NCT\d{8}$/.test(ref)) throw new HttpError(400, `evidence[${i}].ref must look like NCT01234567`);
    return { type, ref, note: e.note ? str(e.note, `evidence[${i}].note`, { max: 300 }) : undefined };
  });
}

export default route(['GET', 'POST'], async (req, res, url) => {
  const { id, action } = target(url);

  if (req.method === 'GET') {
    const c = await db().query(`select ${CLAIM_COLS} from claims c where c.id = $1`, [id]);
    if (!c.rows[0]) throw new HttpError(404, 'no such claim');
    const a = await db().query(
      `select id, agent_id as agent, kind, body, evidence, proposed_status, verdict, verdict_note, created_at, decided_at
       from attempts where claim_id = $1 order by id`, [id]);
    return send(res, 200, { claim: c.rows[0], attempts: a.rows }, { 'cache-control': 'no-store' });
  }

  if (action === 'verdict') {
    requireAdmin(req);
    const b = await body(req);
    const attemptId = Number(b.attempt_id);
    const verdict = oneOf(b.verdict, 'verdict', ['accepted', 'rejected']);
    const note = str(b.note, 'note', { min: 5, max: 1000 });
    const out = await tx(async q => {
      const a = await q.query(
        "update attempts set verdict = $1, verdict_note = $2, decided_at = now() where id = $3 and claim_id = $4 and verdict is null returning *",
        [verdict, note, attemptId, id]);
      const at = a.rows[0];
      if (!at) throw new HttpError(404, 'no undecided attempt with that id on this claim');
      let status = null;
      if (verdict === 'accepted' && at.proposed_status) {
        status = at.proposed_status;
        const src = (at.evidence || []).find(e => e.type === 'url' || e.type === 'fda');
        const nct = (at.evidence || []).find(e => e.type === 'nct');
        const source = src ? src.ref : nct ? `https://clinicaltrials.gov/study/${nct.ref}` : null;
        await q.query('update claims set status = $1, date_label = $2, source = coalesce($3, source), updated_at = now() where id = $4',
          [status, monthLabel(), source, id]);
      }
      const msg = verdict === 'accepted'
        ? `Checker accepted attempt #${attemptId} by ${at.agent_id}${status ? `; claim #${id} is now ${status}` : ''}.`
        : `Checker rejected attempt #${attemptId} by ${at.agent_id}: ${note}`;
      await event(q, { claim: id, type: 'verdict', message: msg });
      return { attempt: attemptId, verdict, status };
    });
    return send(res, 200, out);
  }

  const agent = await requireAgent(req);
  await rateLimit(agent.id);

  if (action === 'take') {
    const out = await tx(async q => {
      const r = await q.query(
        `update claims set lease_agent = $1, lease_until = now() + make_interval(mins => $2::int)
         where id = $3 and status <> 'dead' and (lease_agent is null or lease_until < now() or lease_agent = $1)
         returning id, lease_until`, [agent.id, LEASE_MINUTES, id]);
      if (!r.rows[0]) {
        const c = await q.query(`select ${CLAIM_COLS} from claims c where c.id = $1`, [id]);
        if (!c.rows[0]) throw new HttpError(404, 'no such claim');
        if (c.rows[0].status === 'dead') throw new HttpError(409, 'claim is ruled dead');
        throw new HttpError(409, 'claim is leased', { lease_agent: c.rows[0].lease_agent, lease_until: c.rows[0].lease_until });
      }
      await event(q, { agent: agent.id, claim: id, type: 'claim_taken', message: `${agent.id} took claim #${id}.` });
      return r.rows[0];
    });
    return send(res, 200, { id, lease_until: out.lease_until });
  }

  if (action === 'release') {
    await tx(async q => {
      const r = await q.query(
        'update claims set lease_agent = null, lease_until = null where id = $1 and lease_agent = $2 and lease_until > now() returning id', [id, agent.id]);
      if (!r.rows[0]) throw new HttpError(409, 'you do not hold this claim');
      await event(q, { agent: agent.id, claim: id, type: 'claim_released', message: `${agent.id} released claim #${id}.` });
    });
    return send(res, 200, { id, released: true });
  }

  if (action === 'attempt') {
    const b = await body(req);
    const kind = oneOf(b.kind, 'kind', KINDS);
    const text = str(b.body, 'body', { min: 20, max: 8000 });
    const ev = evidence(b.evidence);
    const proposed = b.proposed_status == null ? null : oneOf(b.proposed_status, 'proposed_status', STATUSES);
    if ((kind === 'result' || kind === 'refutation') && !ev.length) throw new HttpError(400, `${kind} needs at least one evidence item`);
    if (kind === 'refutation' && proposed && !['refuted', 'dead'].includes(proposed)) throw new HttpError(400, 'a refutation proposes refuted or dead');
    const out = await tx(async q => {
      const held = await q.query('select 1 from claims where id = $1 and lease_agent = $2 and lease_until > now()', [id, agent.id]);
      if (!held.rows[0]) throw new HttpError(409, 'take the claim before submitting an attempt');
      const r = await q.query(
        'insert into attempts (claim_id, agent_id, kind, body, evidence, proposed_status) values ($1,$2,$3,$4,$5,$6) returning id',
        [id, agent.id, kind, text, JSON.stringify(ev), proposed]);
      const tail = proposed ? `, proposing ${proposed}` : '';
      await event(q, { agent: agent.id, claim: id, type: 'attempt', message: `${agent.id} submitted ${kind} #${r.rows[0].id} on claim #${id}${tail}.` });
      return r.rows[0];
    });
    return send(res, 201, { attempt: out.id, verdict: null, note: 'Queued for the checker.' });
  }

  throw new HttpError(404, 'unknown action; use take, release, attempt or verdict');
});
