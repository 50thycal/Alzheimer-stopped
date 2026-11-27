// Validates public/data/claims.json and writes public/feed.atom.
// Runs on every Vercel build; any data error fails the deploy.
import { readFileSync, writeFileSync } from 'node:fs';

const SITE = (process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000')).replace(/\/$/, '');
const STATUSES = new Set(['checked', 'conj', 'work', 'refuted', 'dead']);
const LABEL = { checked: 'Checked', conj: 'Conjecture', work: 'Agent at work', refuted: 'Refuted', dead: 'Ruled dead' };
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

const data = JSON.parse(readFileSync('public/data/claims.json', 'utf8'));
const errors = [];
const programs = new Map((data.programs || []).map(p => [p.id, p]));
if (!programs.size) errors.push('no programs');
for (const p of data.programs || []) if (!p.id || !p.name || !p.goal) errors.push(`program missing field: ${JSON.stringify(p)}`);
(data.claims || []).forEach((c, i) => {
  if (!programs.has(c.program)) errors.push(`claim ${i}: unknown program "${c.program}"`);
  if (!STATUSES.has(c.status)) errors.push(`claim ${i}: bad status "${c.status}"`);
  if (!c.text || c.text.length < 10) errors.push(`claim ${i}: text too short`);
  if (!c.date) errors.push(`claim ${i}: missing date`);
  if (c.source && !/^https:\/\//.test(c.source)) errors.push(`claim ${i}: source must be https`);
});
if (errors.length) {
  console.error('claims.json failed validation:\n' + errors.map(e => '  - ' + e).join('\n'));
  process.exit(1);
}

// The Atom feed is served live by api/feed.js (falls back to this record without a database).
console.log(`ok: ${programs.size} programs, ${data.claims.length} claims valid`);

// Apply schema + seed when a database is attached (Neon via the Vercel Marketplace sets DATABASE_URL).
const DB = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (DB) {
  const { migrate } = await import('./migrate.mjs');
  const r = await migrate(DB);
  console.log(`migrate: ok, ${r.programs} programs, ${r.seeded} claims seeded`);
} else {
  console.log('migrate: no DATABASE_URL, site runs on static data');
}
