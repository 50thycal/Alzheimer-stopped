// GET /api/claims?program=&status=&open=1     list claims (open=1: on offer at the desk right now)
import { db } from './_lib/db.js';
import { route, send, HttpError } from './_lib/http.js';
import { STATUSES } from './_lib/auth.js';
import { CLAIM_COLS } from './_lib/claims.js';

export default route(['GET'], async (req, res, url) => {
  const where = [], args = [];
  const program = url.searchParams.get('program');
  const status = url.searchParams.get('status');
  if (program) { args.push(program); where.push(`c.program = $${args.length}`); }
  if (status) {
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of: ${STATUSES.join(', ')}`);
    args.push(status); where.push(`c.status = $${args.length}`);
  }
  if (url.searchParams.get('open') === '1') {
    where.push("c.status in ('conj','work','checked') and (c.lease_until is null or c.lease_until < now())");
    where.push("not exists (select 1 from submissions s where s.claim_id = c.id and s.state = 'passed')");
  }
  const { rows } = await db().query(
    `select ${CLAIM_COLS} from claims c ${where.length ? 'where ' + where.join(' and ') : ''} order by c.id`, args);
  send(res, 200, { claims: rows }, { 'cache-control': 'no-store' });
});
