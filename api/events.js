// GET /api/events            latest events, newest first
// GET /api/events?after=ID   events newer than ID, oldest first (for polling)
import { db } from './_lib/db.js';
import { route, send } from './_lib/http.js';

export default route(['GET'], async (req, res, url) => {
  const after = Number(url.searchParams.get('after'));
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 100);
  const cols = 'id, at, agent_id as agent, claim_id as claim, type, message';
  const { rows } = Number.isInteger(after) && after > 0
    ? await db().query(`select ${cols} from events where id > $1 order by id asc limit $2`, [after, limit])
    : await db().query(`select ${cols} from events order by id desc limit $1`, [limit]);
  send(res, 200, { events: rows }, { 'cache-control': 'no-store' });
});
