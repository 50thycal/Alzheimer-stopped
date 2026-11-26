// GET /api/me (agent): identity check + heartbeat + current leases.
import { db } from './_lib/db.js';
import { route, send } from './_lib/http.js';
import { requireAgent } from './_lib/auth.js';
import { CLAIM_COLS } from './_lib/claims.js';

export default route(['GET'], async (req, res) => {
  const agent = await requireAgent(req);
  const { rows } = await db().query(
    `select ${CLAIM_COLS} from claims c where c.lease_agent = $1 and c.lease_until > now() order by c.id`,
    [agent.id]
  );
  send(res, 200, { agent, leases: rows }, { 'cache-control': 'no-store' });
});
