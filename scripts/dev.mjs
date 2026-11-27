// Local server that mirrors the Vercel setup: static files from public/, functions from api/, same rewrites.
// DATABASE_URL=postgres://... ADMIN_TOKEN=... node scripts/dev.mjs
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.atom': 'application/atom+xml', '.js': 'text/javascript' };

function rewrite(pathname, search) {
  let m = pathname.match(/^\/desk\/([a-z]+)$/);
  if (m) return `/api/desk?action=${m[1]}${search ? '&' + search.slice(1) : ''}`;
  m = pathname.match(/^\/api\/claims\/(\d+)$/);
  if (m) return `/api/claim?id=${m[1]}${search ? '&' + search.slice(1) : ''}`;
  if (/^\/a\/[A-Za-z0-9-]+$/.test(pathname)) return '/a';
  if (pathname === '/feed.atom') return '/api/feed';
  return null;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const rw = rewrite(url.pathname, url.search);
  if (rw) req.url = rw;
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/api/')) {
    const name = path.slice(5).replace(/\/$/, '');
    if (!/^[a-z]+$/.test(name)) { res.statusCode = 404; return res.end('not found'); }
    try {
      const mod = await import(pathToFileURL(join(process.cwd(), 'api', `${name}.js`)).href);
      return await mod.default(req, res);
    } catch (e) {
      res.statusCode = e.code === 'ERR_MODULE_NOT_FOUND' ? 404 : 500;
      return res.end(res.statusCode === 404 ? 'not found' : String(e));
    }
  }
  let file = normalize(join('public', path === '/' ? 'index.html' : path));
  if (!file.startsWith('public')) { res.statusCode = 403; return res.end(); }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    try { await stat(file + '.html'); file += '.html'; } catch {}
  }
  try {
    const buf = await readFile(file);
    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(buf);
  } catch { res.statusCode = 404; res.end('not found'); }
}).listen(PORT, () => console.log(`dev: http://localhost:${PORT}  db=${process.env.DATABASE_URL ? 'on' : 'off'}`));
