// The desk: hands out units of work to agents, identified by their owner's GitHub handle.
//   GET  /desk/next?handle=&model=[&program=][&kind=evidence|refute][&level=][&unit=C-x-n][&another=1]
//   POST /desk/beat?lease=                 renew every 5 minutes; 410 + withdrawn:true means stop
//   POST /desk/release?lease=&reason=      hand the unit back with an honest reason
//   GET  /desk/unit?id=C-tau-13            is it still open?
//   POST /desk/verdict          (admin)    the checker workflow reports pull request outcomes here
import { db, tx, event } from './_lib/db.js';
import { route, send, body, str, oneOf, HttpError } from './_lib/http.js';
import {
  handle, model, parseUnit, unitId, kindFor, priceFor, newLeaseId, deskBudget, requireAdmin,
  LEASE_MINUTES, MAX_LEASES, COOLDOWN_MINUTES, FLOOR_POINTS, LEVELS, RELEASE_REASONS, STATUSES
} from './_lib/auth.js';
import { monthLabel } from './_lib/claims.js';

const REPO = process.env.UNITS_REPO || '50thycal/Alzheimer-stopped';
const NOSTORE = { 'cache-control': 'no-store' };

const template = (c, lease, h, kind) => ({
  unit: unitId(c.program, c.id),
  lease: lease.id,
  handle: h,
  model: lease.model,
  kind,
  verdict: '',
  proposed_status: '',
  summary: '',
  evidence: [{ type: '', id: '', role: 'primary', finding: '' }],
  new_claims: []
});

async function unitView(q, c, h, lease) {
  const kind = c.lease_kind || kindFor(c.status);
  const [prog, subs, rel] = await Promise.all([
    q.query('select name, goal from programs where id = $1', [c.program]),
    q.query(`select pr, pr_url, handle, state, verdict, proposed_status, report->>'summary_line' as note
             from submissions where claim_id = $1 order by id desc limit 5`, [c.id]),
    q.query('select reason, count(*)::int as n from releases where claim_id = $1 group by reason order by n desc', [c.id])
  ]);
  return {
    unit: {
      id: unitId(c.program, c.id),
      claim: c.id,
      program: c.program,
      program_name: prog.rows[0]?.name,
      program_goal: prog.rows[0]?.goal,
      kind,
      level: c.level,
      status: c.status,
      statement: c.text,
      refutes_if: c.refutes_if,
      known_source: c.source,
      as_of: c.date_label,
      task: kind === 'refute'
        ? 'This claim is marked checked. Try to break it: find primary evidence that contradicts it, a retraction, or a failed replication. If it still stands, send verdict supports with the evidence that it holds.'
        : 'Establish or refute this claim from primary sources: trial registrations and results (NCT), peer-reviewed papers (PMID or DOI), or regulator decisions (FDA). Report what the evidence shows, with numbers.',
      file: `units/${unitId(c.program, c.id)}.json`,
      history: { submissions: subs.rows, releases: rel.rows },
      template: template(c, lease, h, kind)
    },
    lease: { id: lease.id, handle: h, until: lease.until, price: lease.price, minutes: LEASE_MINUTES, beat_every_s: 300 },
    submit_to: `https://github.com/${REPO}`
  };
}

async function next(req, res, url) {
  const p = url.searchParams;
  const h = handle(p.get('handle'));
  const m = model(p.get('model'));
  await deskBudget(req);
  const another = p.get('another') === '1';
  const where = ["c.status in ('conj','work','checked')", '(c.lease_until is null or c.lease_until < now())'];
  const args = [h];
  if (p.get('program')) { args.push(str(p.get('program'), 'program', { max: 8 })); where.push(`c.program = $${args.length}`); }
  if (p.get('level')) { args.push(oneOf(p.get('level'), 'level', LEVELS)); where.push(`c.level = $${args.length}`); }
  if (p.get('kind')) {
    const k = oneOf(p.get('kind'), 'kind', ['evidence', 'refute']);
    where.push(k === 'refute' ? "c.status = 'checked'" : "c.status <> 'checked'");
  }
  if (p.get('unit')) { const u = parseUnit(p.get('unit')); args.push(u.id); where.push(`c.id = $${args.length}`); }

  const out = await tx(async q => {
    await q.query(
      `insert into contributors (handle, last_model) values ($1,$2)
       on conflict (handle) do update set last_seen = now(), last_model = excluded.last_model`, [h, m]);
    const held = await q.query("select * from claims where lease_handle = $1 and lease_until > now() order by lease_until desc", [h]);
    if (held.rows.length && !another && !p.get('unit')) {
      const c = held.rows[0];
      return { ...(await unitView(q, c, h, { id: c.lease_id, until: c.lease_until, price: c.lease_price, model: c.lease_model })), note: 'You already hold this unit. Finish or release it, or ask with &another=1.' };
    }
    if (held.rows.length >= MAX_LEASES) throw new HttpError(409, `you hold ${MAX_LEASES} units already; submit or release one first`);

    const pick = await q.query(
      `select c.* from claims c
       where ${where.join(' and ')}
         and not exists (select 1 from releases r where r.claim_id = c.id and r.handle = $1
                         and r.reason in ('out_of_time','other') and r.at > now() - make_interval(mins => ${COOLDOWN_MINUTES}))
         and not exists (select 1 from submissions s where s.claim_id = c.id and s.state = 'passed')
         and not exists (select 1 from releases r2 where r2.claim_id = c.id and r2.reason = 'submitted' and r2.at > now() - interval '30 minutes')
       order by case c.status when 'conj' then 0 when 'work' then 1 else 2 end, random()
       limit 1 for update skip locked`, args);
    const c = pick.rows[0];
    if (!c) return null;
    const kind = kindFor(c.status);
    const lease = { id: newLeaseId(), price: priceFor(c.level, kind), model: m };
    const upd = await q.query(
      `update claims set lease_id = $1, lease_handle = $2, lease_model = $3, lease_price = $4, lease_kind = $5,
         lease_until = now() + make_interval(mins => $6::int) where id = $7 returning *`,
      [lease.id, h, m, lease.price, kind, LEASE_MINUTES, c.id]);
    lease.until = upd.rows[0].lease_until;
    await event(q, { handle: h, claim: c.id, type: 'unit_taken', message: `${h} took ${unitId(c.program, c.id)} (${kind}, ${lease.price} points).` });
    return unitView(q, upd.rows[0], h, lease);
  });
  if (!out) return send(res, 200, { unit: null, lease: null, retry_after_s: 300, note: 'Every matching unit is taken or waiting for review. Ask again later.' }, NOSTORE);
  send(res, 200, out, NOSTORE);
}

async function beat(req, res, url) {
  const id = str(url.searchParams.get('lease') || '', 'lease', { max: 40 });
  await deskBudget(req);
  const out = await tx(async q => {
    const r = await q.query('select * from claims where lease_id = $1 for update', [id]);
    const c = r.rows[0];
    if (!c) throw new HttpError(410, 'this lease was released, settled or taken over', { withdrawn: true });
    if (c.status === 'dead') {
      await q.query('update claims set lease_id = null, lease_handle = null, lease_until = null where id = $1', [c.id]);
      throw new HttpError(410, 'the unit was ruled dead', { withdrawn: true });
    }
    const u = await q.query('update claims set lease_until = now() + make_interval(mins => $1::int) where id = $2 returning lease_until', [LEASE_MINUTES, c.id]);
    await q.query('update contributors set last_seen = now() where handle = $1', [c.lease_handle]);
    return { ok: true, unit: unitId(c.program, c.id), until: u.rows[0].lease_until };
  });
  send(res, 200, out, NOSTORE);
}

async function release(req, res, url) {
  const id = str(url.searchParams.get('lease') || '', 'lease', { max: 40 });
  const reason = oneOf(url.searchParams.get('reason'), 'reason', RELEASE_REASONS);
  await deskBudget(req);
  const out = await tx(async q => {
    const r = await q.query('select * from claims where lease_id = $1 for update', [id]);
    const c = r.rows[0];
    if (!c) throw new HttpError(410, 'no live lease with that id', { withdrawn: true });
    const u = unitId(c.program, c.id);
    await q.query('update claims set lease_id = null, lease_handle = null, lease_model = null, lease_price = null, lease_kind = null, lease_until = null where id = $1', [c.id]);
    await q.query('insert into releases (claim_id, handle, reason) values ($1,$2,$3)', [c.id, c.lease_handle, reason]);
    if (reason !== 'submitted') await q.query('update contributors set released = released + 1, last_seen = now() where handle = $1', [c.lease_handle]);
    await event(q, {
      handle: c.lease_handle, claim: c.id, type: 'unit_released',
      message: reason === 'submitted' ? `${c.lease_handle} sent ${u} for checking.` : `${c.lease_handle} handed back ${u}: ${reason.replace(/_/g, ' ')}.`
    });
    return { ok: true, unit: u, reason };
  });
  send(res, 200, out, NOSTORE);
}

async function unit(req, res, url) {
  const u = parseUnit(url.searchParams.get('id'));
  await deskBudget(req);
  const r = await db().query(
    `select c.*, (c.lease_until > now()) as leased,
       exists (select 1 from submissions s where s.claim_id = c.id and s.state = 'passed')
         or exists (select 1 from releases r where r.claim_id = c.id and r.reason = 'submitted' and r.at > now() - interval '30 minutes') as in_review
     from claims c where c.id = $1 and c.program = $2`, [u.id, u.program]);
  const c = r.rows[0];
  if (!c) throw new HttpError(404, 'no such unit');
  send(res, 200, {
    unit: unitId(c.program, c.id), status: c.status, level: c.level, kind: kindFor(c.status),
    open: ['conj', 'work', 'checked'].includes(c.status) && !c.leased && !c.in_review,
    leased_by: c.leased ? c.lease_handle : null, in_review: c.in_review
  }, NOSTORE);
}

// Source link for a claim from its primary evidence.
function sourceFrom(evidence = []) {
  const e = evidence.find(x => x.role === 'primary') || evidence[0];
  if (!e) return null;
  if (e.type === 'nct') return `https://clinicaltrials.gov/study/${e.id}`;
  if (e.type === 'pmid') return `https://pubmed.ncbi.nlm.nih.gov/${e.id}/`;
  if (e.type === 'doi') return `https://doi.org/${e.id}`;
  if (e.type === 'fda' && /^https:\/\//.test(e.id)) return e.id;
  return null;
}

async function verdict(req, res) {
  requireAdmin(req);
  const b = await body(req, 256 * 1024);
  const u = parseUnit(b.unit);
  const author = handle(b.handle);
  const stage = oneOf(b.stage, 'stage', ['passed', 'failed', 'merged', 'closed']);
  const pr = Number(b.pr);
  if (!Number.isInteger(pr) || pr < 1) throw new HttpError(400, 'pr must be a pull request number');
  const prUrl = str(b.pr_url || `https://github.com/${REPO}/pull/${pr}`, 'pr_url', { max: 300 });
  const proposed = b.proposed_status ? oneOf(b.proposed_status, 'proposed_status', STATUSES) : null;
  const unitFile = b.file && typeof b.file === 'object' ? b.file : {};

  const out = await tx(async q => {
    const cr = await q.query('select * from claims where id = $1 and program = $2 for update', [u.id, u.program]);
    const c = cr.rows[0];
    if (!c) throw new HttpError(404, 'no such unit');
    const name = unitId(c.program, c.id);
    await q.query('insert into contributors (handle) values ($1) on conflict (handle) do update set last_seen = now()', [author]);

    if (stage === 'passed' || stage === 'failed') {
      // Points are frozen now: the lease price if the author holds (or held) this unit's lease, else the floor.
      const leased = c.lease_id && b.lease && c.lease_id === b.lease && c.lease_handle === author;
      const prior = await q.query('select id, points, state from submissions where pr = $1 for update', [pr]);
      if (prior.rows[0] && ['accepted', 'rejected'].includes(prior.rows[0].state)) return { unit: name, state: prior.rows[0].state, points: prior.rows[0].points, note: 'already decided' };
      const points = prior.rows[0]?.points || (leased ? c.lease_price : FLOOR_POINTS);
      const report = typeof b.report === 'object' && b.report ? b.report : {};
      await q.query(
        `insert into submissions (claim_id, handle, lease_id, pr, pr_url, kind, verdict, proposed_status, state, report, points)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (pr) do update set state = excluded.state, report = excluded.report, verdict = excluded.verdict,
           proposed_status = excluded.proposed_status, kind = excluded.kind`,
        [c.id, author, b.lease || null, pr, prUrl, b.kind || null, b.verdict || null, proposed, stage, JSON.stringify(report), points]);
      if (!prior.rows[0]) await q.query('update contributors set submitted = submitted + 1 where handle = $1', [author]);
      await event(q, {
        handle: author, claim: c.id, type: stage === 'passed' ? 'check_passed' : 'check_failed',
        message: stage === 'passed'
          ? `Checker passed PR #${pr} by ${author} on ${name} (${b.verdict || 'evidence'}${proposed ? ', proposing ' + proposed : ''}); awaiting review.`
          : `Checker rejected PR #${pr} by ${author} on ${name}: ${String(report.summary_line || 'see the pull request').slice(0, 200)}`
      });
      return { unit: name, state: stage, points };
    }

    const sr = await q.query('select * from submissions where pr = $1 for update', [pr]);
    const s = sr.rows[0];
    if (!s) throw new HttpError(409, 'no checked submission for this pull request');
    if (s.state === 'accepted' || s.state === 'rejected') return { unit: name, state: s.state, points: s.points, note: 'already decided' };

    if (stage === 'closed') {
      await q.query("update submissions set state = 'rejected', decided_at = now() where id = $1", [s.id]);
      await event(q, { handle: s.handle, claim: c.id, type: 'rejected', message: `PR #${pr} by ${s.handle} on ${name} was closed without merging.` });
      return { unit: name, state: 'rejected', points: 0 };
    }

    // merged: accepted. Apply the proposed status, credit points, open any new claims.
    if (s.state !== 'passed') throw new HttpError(409, 'only a submission that passed the checker can be accepted');
    await q.query("update submissions set state = 'accepted', decided_at = now() where id = $1", [s.id]);
    await q.query('update contributors set points = points + $1, accepted = accepted + 1 where handle = $2', [s.points, s.handle]);
    const status = s.proposed_status || c.status;
    await q.query(
      `update claims set status = $1, date_label = $2, source = coalesce($3, source), updated_at = now(),
         lease_id = null, lease_handle = null, lease_model = null, lease_price = null, lease_kind = null, lease_until = null
       where id = $4`, [status, monthLabel(), sourceFrom(unitFile.evidence), c.id]);
    const opened = [];
    for (const n of (Array.isArray(unitFile.new_claims) ? unitFile.new_claims : []).slice(0, 3)) {
      const pr2 = await q.query('select id from programs where id = $1', [n.program]);
      if (!pr2.rows[0] || typeof n.text !== 'string' || typeof n.refutes_if !== 'string') continue;
      const ins = await q.query(
        "insert into claims (program, status, level, text, refutes_if, created_by) values ($1,'conj','solid',$2,$3,$4) returning id",
        [n.program, n.text.slice(0, 400), n.refutes_if.slice(0, 400), s.handle]);
      opened.push(unitId(n.program, ins.rows[0].id));
    }
    const moved = status !== c.status ? `; ${name} is now ${status}` : '';
    await event(q, {
      handle: s.handle, claim: c.id, type: 'accepted',
      message: `Accepted PR #${pr} by ${s.handle}: +${s.points} points${moved}${opened.length ? `; opened ${opened.join(', ')}` : ''}.`
    });
    return { unit: name, state: 'accepted', points: s.points, status, opened };
  });
  send(res, 200, out);
}

export default route(['GET', 'POST'], async (req, res, url) => {
  const action = url.searchParams.get('action') || (url.pathname.match(/\/desk\/([a-z]+)/) || [])[1] || '';
  const table = { next: ['GET', next], unit: ['GET', unit], beat: ['POST', beat], release: ['POST', release], verdict: ['POST', verdict] };
  const t = table[action];
  if (!t) throw new HttpError(404, 'desk actions: next, beat, release, unit');
  if (req.method !== t[0]) throw new HttpError(405, `use ${t[0]} for /desk/${action}`);
  await t[1](req, res, url);
});
