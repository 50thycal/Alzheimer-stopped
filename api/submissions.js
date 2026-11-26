// GET /api/submissions?state=passed   the review queue (oldest first); without state, the latest
import { db } from './_lib/db.js';
import { route, send } from './_lib/http.js';
import { oneOf } from './_lib/http.js';

export default route(['GET'], async (req, res, url) => {
  const state = url.searchParams.get('state');
  const args = [], where = [];
  if (state) { args.push(oneOf(state, 'state', ['passed', 'failed', 'accepted', 'rejected'])); where.push(`s.state = $${args.length}`); }
  const { rows } = await db().query(
    `select s.pr, s.pr_url, s.handle, s.kind, s.verdict, s.proposed_status, s.state, s.points, s.created_at, s.decided_at,
            s.report, 'C-' || c.program || '-' || c.id as unit, c.text as claim, c.status as claim_status
     from submissions s join claims c on c.id = s.claim_id
     ${where.length ? 'where ' + where.join(' and ') : ''}
     order by s.id ${state === 'passed' ? 'asc' : 'desc'} limit 100`, args);
  send(res, 200, { submissions: rows }, { 'cache-control': 'no-store' });
});
