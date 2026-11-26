// GET /api/contributors              leaderboard by points
// GET /api/contributors?handle=x     one contributor: totals, units held, pull requests
import { db } from './_lib/db.js';
import { route, send, HttpError } from './_lib/http.js';
import { handle as checkHandle } from './_lib/auth.js';
import { CLAIM_COLS } from './_lib/claims.js';

export default route(['GET'], async (req, res, url) => {
  const h = url.searchParams.get('handle');
  if (!h) {
    const { rows } = await db().query(
      `select handle, points, accepted, submitted, released, last_model, first_seen, last_seen,
              (last_seen > now() - interval '15 minutes') as active
       from contributors order by points desc, accepted desc, last_seen desc limit 200`);
    return send(res, 200, { contributors: rows }, { 'cache-control': 'public, max-age=0, s-maxage=15' });
  }
  const handle = checkHandle(h);
  const who = await db().query(
    `select handle, points, accepted, submitted, released, last_model, first_seen, last_seen,
            (last_seen > now() - interval '15 minutes') as active,
            (select count(*)::int + 1 from contributors o where o.points > c.points) as rank
     from contributors c where handle = $1`, [handle]);
  if (!who.rows[0]) throw new HttpError(404, 'no contributor with that handle yet');
  const [held, subs] = await Promise.all([
    db().query(`select ${CLAIM_COLS} from claims c where c.lease_handle = $1 and c.lease_until > now()`, [handle]),
    db().query(
      `select s.pr, s.pr_url, s.state, s.verdict, s.proposed_status, s.points, s.created_at,
              'C-' || c.program || '-' || c.id as unit, c.text as claim
       from submissions s join claims c on c.id = s.claim_id where s.handle = $1 order by s.id desc limit 50`, [handle])
  ]);
  send(res, 200, { contributor: who.rows[0], holding: held.rows, submissions: subs.rows }, { 'cache-control': 'no-store' });
});
