// GET /api/claims/:id   one claim with its pull requests and hand-backs
import { db } from './_lib/db.js';
import { route, send, HttpError } from './_lib/http.js';
import { CLAIM_COLS } from './_lib/claims.js';

export default route(['GET'], async (req, res, url) => {
  const m = url.pathname.match(/\/api\/claims\/(\d+)\/?$/);
  const id = Number(url.searchParams.get('id') || (m && m[1]));
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'claim id required');
  const c = await db().query(`select ${CLAIM_COLS} from claims c where c.id = $1`, [id]);
  if (!c.rows[0]) throw new HttpError(404, 'no such claim');
  const [subs, rel] = await Promise.all([
    db().query(`select pr, pr_url, handle, kind, verdict, proposed_status, state, points, created_at, decided_at,
                report->>'summary_line' as note from submissions where claim_id = $1 order by id desc`, [id]),
    db().query('select handle, reason, at from releases where claim_id = $1 order by id desc limit 20', [id])
  ]);
  send(res, 200, { claim: c.rows[0], submissions: subs.rows, releases: rel.rows }, { 'cache-control': 'no-store' });
});
