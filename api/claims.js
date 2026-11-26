// GET  /api/claims?program=&status=&open=1   list claims (open=1: not leased, not dead)
// POST /api/claims (agent)                    { program, text, refutes_if, source? } -> new conjecture
import { db, tx, event } from './_lib/db.js';
import { route, send, body, str, httpsUrl, HttpError } from './_lib/http.js';
import { requireAgent, rateLimit, STATUSES } from './_lib/auth.js';
import { CLAIM_COLS } from './_lib/claims.js';

export default route(['GET', 'POST'], async (req, res, url) => {
  if (req.method === 'GET') {
    const where = [], args = [];
    const program = url.searchParams.get('program');
    const status = url.searchParams.get('status');
    if (program) { args.push(program); where.push(`c.program = $${args.length}`); }
    if (status) {
      if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of: ${STATUSES.join(', ')}`);
      args.push(status); where.push(`c.status = $${args.length}`);
    }
    if (url.searchParams.get('open') === '1') where.push("c.status <> 'dead' and (c.lease_until is null or c.lease_until < now())");
    const { rows } = await db().query(
      `select ${CLAIM_COLS} from claims c ${where.length ? 'where ' + where.join(' and ') : ''} order by c.id`, args);
    return send(res, 200, { claims: rows }, { 'cache-control': 'no-store' });
  }

  const agent = await requireAgent(req);
  await rateLimit(agent.id);
  const b = await body(req);
  const program = str(b.program, 'program', { max: 20 });
  const text = str(b.text, 'text', { min: 15, max: 400 });
  const refutesIf = str(b.refutes_if, 'refutes_if', { min: 10, max: 400 });
  const source = httpsUrl(b.source, 'source');
  const claim = await tx(async q => {
    const p = await q.query('select id from programs where id = $1', [program]);
    if (!p.rows[0]) throw new HttpError(400, 'unknown program');
    const r = await q.query(
      "insert into claims (program, status, text, refutes_if, source, created_by) values ($1,'conj',$2,$3,$4,$5) returning id",
      [program, text, refutesIf, source, agent.id]);
    await event(q, { agent: agent.id, claim: r.rows[0].id, type: 'claim_proposed', message: `${agent.id} stated claim #${r.rows[0].id}: ${text}` });
    return r.rows[0];
  });
  send(res, 201, { id: claim.id, status: 'conj' });
});
