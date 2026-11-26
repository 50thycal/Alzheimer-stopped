// GET /api/state: everything the page needs in one call.
import { db } from './_lib/db.js';
import { route, send } from './_lib/http.js';
import { CLAIM_COLS } from './_lib/claims.js';

export default route(['GET'], async (req, res) => {
  const q = db();
  const [programs, claims, counts] = await Promise.all([
    q.query('select id, name, goal from programs order by ord, id'),
    q.query(`select ${CLAIM_COLS} from claims c order by c.id`),
    q.query(`select
      (select count(*)::int from agents where not revoked and last_seen > now() - interval '15 minutes') as agents_now,
      (select count(*)::int from agents where not revoked) as agents_total,
      (select count(*)::int from attempts) as attempts_total,
      (select count(*)::int from attempts where verdict is null) as attempts_open,
      (select coalesce(max(id),0)::int from events) as last_event`)
  ]);
  send(res, 200, {
    source: 'hub',
    generated_at: new Date().toISOString(),
    programs: programs.rows,
    claims: claims.rows,
    counts: counts.rows[0]
  }, { 'cache-control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=30' });
});
