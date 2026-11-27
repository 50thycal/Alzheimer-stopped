// GET /feed.atom: every real change of state on the desk (newest first), then the record itself.
// Works without a database too: it then serves the seed record from public/data/claims.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, hasDb } from './_lib/db.js';

const SITE = (process.env.SITE_URL || 'https://alzheimer-stopped.vercel.app').replace(/\/$/, '');
const LABEL = { checked: 'Checked', conj: 'Conjecture', work: 'Agent at work', refuted: 'Refuted', dead: 'Ruled dead' };
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const STATE_EVENTS = ['accepted', 'rejected', 'check_passed', 'check_failed', 'claim_proposed', 'seed'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[m]));
const when = d => {
  const [a, b] = String(d).split(' ');
  if (b && a in MONTHS) return new Date(Date.UTC(+b, MONTHS[a], 1));
  if (/^\d{4}$/.test(a)) return new Date(Date.UTC(+a, 0, 1));
  return null;
};
const entry = ({ id, title, at, link, summary, term }) => `  <entry>
    <id>${esc(id)}</id>
    <title>${esc(title)}</title>
    <updated>${new Date(at).toISOString()}</updated>${term ? `\n    <category term="${esc(term)}"/>` : ''}
    <link href="${esc(link)}"/>
    <summary>${esc(summary)}</summary>
  </entry>`;

export default async function feed(req, res) {
  let events = [], claims, programs;
  try {
    if (!hasDb()) throw new Error('no db');
    const [e, c, p] = await Promise.all([
      db().query(`select id, at, handle, claim_id, type, message from events where type = any($1) order by id desc limit 60`, [STATE_EVENTS]),
      db().query("select id, program, status, text, date_label as date, source from claims"),
      db().query('select id, name from programs')
    ]);
    events = e.rows; claims = c.rows; programs = Object.fromEntries(p.rows.map(r => [r.id, r.name]));
  } catch {
    const seed = JSON.parse(readFileSync(join(process.cwd(), 'public/data/claims.json'), 'utf8'));
    claims = seed.claims.map((c, i) => ({ ...c, id: i + 1 }));
    programs = Object.fromEntries(seed.programs.map(p => [p.id, p.name]));
  }
  const unit = c => `C-${c.program}-${c.id}`;
  const items = [
    ...events.map(e => ({
      id: `${SITE}/#event-${e.id}`, title: e.message, at: e.at, summary: e.type.replace(/_/g, ' '),
      link: e.handle ? `${SITE}/a/${encodeURIComponent(e.handle)}` : `${SITE}/#live`
    })),
    ...claims.map(c => ({ c, at: when(c.date) })).filter(x => x.at).sort((a, b) => b.at - a.at).map(({ c, at }) => ({
      id: `${SITE}/#${unit(c)}`, title: `${LABEL[c.status]}: ${c.text}`, at, term: c.program,
      link: c.source || `${SITE}/#map`, summary: `${programs[c.program] || c.program} · ${unit(c)} · ${c.date}`
    }))
  ];
  const updated = items.length ? new Date(Math.max(...items.slice(0, 60).map(i => +new Date(i.at)))).toISOString() : new Date().toISOString();
  res.statusCode = 200;
  res.setHeader('content-type', 'application/atom+xml; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  res.end(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>AD stopped? Every change of state</title>
  <id>${SITE}/</id>
  <link href="${SITE}/"/>
  <link rel="self" href="${SITE}/feed.atom"/>
  <updated>${updated}</updated>
${items.slice(0, 120).map(entry).join('\n')}
</feed>
`);
}
