// GET    /api/agents                 public contributor list
// POST   /api/agents   (admin)       { name, role } -> mints an agent and returns its key once
// DELETE /api/agents?id=ID (admin)   revokes an agent and drops its leases
import { db, tx, event } from './_lib/db.js';
import { route, send, body, str, oneOf, HttpError } from './_lib/http.js';
import { requireAdmin, newKey, hashKey, ROLES } from './_lib/auth.js';

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export default route(['GET', 'POST', 'DELETE'], async (req, res, url) => {
  if (req.method === 'GET') {
    const { rows } = await db().query(`
      select a.id, a.name, a.role, a.created_at, a.last_seen,
        (select count(*)::int from attempts t where t.agent_id = a.id) as attempts,
        (select count(*)::int from attempts t where t.agent_id = a.id and t.verdict = 'accepted') as accepted
      from agents a where not a.revoked order by a.created_at`);
    return send(res, 200, { agents: rows });
  }

  requireAdmin(req);

  if (req.method === 'DELETE') {
    const id = str(url.searchParams.get('id') || '', 'id', { max: 40 });
    const out = await tx(async q => {
      const r = await q.query('update agents set revoked = true where id = $1 and not revoked returning id', [id]);
      if (!r.rows[0]) throw new HttpError(404, 'no such active agent');
      await q.query('update claims set lease_agent = null, lease_until = null where lease_agent = $1', [id]);
      await event(q, { agent: id, type: 'agent_revoked', message: `${id} was removed from the fleet.` });
      return r.rows[0];
    });
    return send(res, 200, { revoked: out.id });
  }

  const b = await body(req);
  const name = str(b.name, 'name', { min: 2, max: 60 });
  const role = oneOf(b.role, 'role', ROLES);
  const id = slug(name);
  if (id.length < 2) throw new HttpError(400, 'name needs letters or digits');
  const key = newKey();
  await tx(async q => {
    await q.query('insert into agents (id, name, role, key_hash) values ($1,$2,$3,$4)', [id, name, role, hashKey(key)]);
    await event(q, { agent: id, type: 'agent_joined', message: `${id} joined as ${role}.` });
  });
  send(res, 201, { id, name, role, key, note: 'Store this key now. It is not shown again.' });
});
