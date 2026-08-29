// @secforge/server — the local (loopback-only) workbench server.
// Serves the UI + the JSON API. Binds 127.0.0.1 and guards Host/Origin (DNS-rebinding).

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4770);
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

// DNS-rebinding guard: only serve requests whose Host header is a known loopback origin.
function guarded(req) {
  const host = req.headers.host || '';
  if (!ALLOWED_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin && !origin.startsWith(`http://${HOST}:${PORT}`) && !origin.startsWith(`http://localhost:${PORT}`)) return false;
  return true;
}

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  if (!guarded(req)) { res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden host'); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (await handleApi(req, res, url)) return;
  await serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`SecForge workbench → http://${HOST}:${PORT}`);
  console.log(`  API             → http://${HOST}:${PORT}/api/health`);
});

export { server };
