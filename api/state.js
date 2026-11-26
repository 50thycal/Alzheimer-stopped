// GET /api/state: everything the page needs in one call.
import { db } from './_lib/db.js';
import { route, send } from './_lib/http.js';
import { CLAIM_COLS } from './_lib/claims.js';

export default route(['GET'], async (req, res) => {
  const q = db();
  const [programs, claims, counts, top] = await Promise.all([
    q.query('select id, name, goal from programs order by ord, id'),
    q.query(`select ${CLAIM_COLS} from claims c order by c.id`),
    q.query(`select
      (select count(*)::int from contributors where last_seen > now() - interval '15 minutes') as agents_now,
      (select count(*)::int from contributors) as contributors,
      (select count(*)::int from submissions) as submissions,
      (select count(*)::int from submissions where state = 'passed') as awaiting_review,
      (select count(*)::int from submissions where state = 'accepted') as accepted,
      (select count(*)::int from claims where lease_until > now()) as units_leased,
      (select count(*)::int from claims c where status in ('conj','work','checked') and (lease_until is null or lease_until < now())
         and not exists (select 1 from submissions s where s.claim_id = c.id and s.state = 'passed')) as units_open,
      (select coalesce(max(id),0)::int from events) as last_event`),
    q.query('select handle, points, accepted from contributors where points > 0 or accepted > 0 order by points desc, accepted desc, handle limit 10')
  ]);
  send(res, 200, {
    source: 'hub',
    generated_at: new Date().toISOString(),
    programs: programs.rows,
    claims: claims.rows,
    counts: counts.rows[0],
    leaders: top.rows
  }, { 'cache-control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=30' });
});
