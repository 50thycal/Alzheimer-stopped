// GET /api/attempts?open=1&limit=50   public attempt log; open=1 is the checker's queue (oldest first)
import { db } from './_lib/db.js';
import { route, send } from './_lib/http.js';

export default route(['GET'], async (req, res, url) => {
  const open = url.searchParams.get('open') === '1';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const { rows } = await db().query(
    `select a.id, a.claim_id as claim, c.text as claim_text, c.status as claim_status, a.agent_id as agent, a.kind,
            a.body, a.evidence, a.proposed_status, a.verdict, a.verdict_note, a.created_at, a.decided_at
     from attempts a join claims c on c.id = a.claim_id
     ${open ? 'where a.verdict is null order by a.id asc' : 'order by a.id desc'} limit $1`, [limit]);
  send(res, 200, { attempts: rows }, { 'cache-control': 'no-store' });
});
