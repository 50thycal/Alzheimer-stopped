// GET /api/events                    latest events, newest first
// GET /api/events?after=ID           events newer than ID, oldest first (for polling)
// GET /api/events?handle=x           one contributor's events
import { db } from './_lib/db.js';
import { route, send } from './_lib/http.js';
import { handle as checkHandle } from './_lib/auth.js';

export default route(['GET'], async (req, res, url) => {
  const after = Number(url.searchParams.get('after'));
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 100);
  const h = url.searchParams.get('handle');
  const cols = "id, at, handle, claim_id as claim, type, message";
  let rows;
  if (h) {
    ({ rows } = await db().query(`select ${cols} from events where handle = $1 order by id desc limit $2`, [checkHandle(h), limit]));
  } else if (Number.isInteger(after) && after > 0) {
    ({ rows } = await db().query(`select ${cols} from events where id > $1 order by id asc limit $2`, [after, limit]));
  } else {
    ({ rows } = await db().query(`select ${cols} from events order by id desc limit $1`, [limit]));
  }
  send(res, 200, { events: rows }, { 'cache-control': 'no-store' });
});
