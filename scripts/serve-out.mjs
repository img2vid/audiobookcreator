// Zero-dependency, loopback-only server for the production static export.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.traineddata': 'application/octet-stream', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4b': 'audio/mp4', '.map': 'application/json' };
export function createStaticServer({ outDir = path.join(root, 'out'), basePath = '' } = {}) {
  const canonical = fs.realpathSync(outDir);
  return http.createServer((req, res) => {
    try {
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host ?? '')) { res.writeHead(403).end('Invalid loopback Host'); return; }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = url.pathname;
      if (basePath) {
        if (pathname === basePath) { res.writeHead(301, { Location: `${basePath}/${url.search}` }).end(); return; }
        if (!pathname.startsWith(`${basePath}/`)) { res.writeHead(404).end(req.method === 'HEAD' ? undefined : `This build is served under ${basePath}/`); return; }
        pathname = pathname.slice(basePath.length);
      }
      const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
      if (rel.includes('\0') || rel.includes('\\')) throw new Error('Invalid path');
      let file = path.resolve(canonical, rel);
      const within = f => f === canonical || f.startsWith(canonical + path.sep);
      if (!within(file)) { res.writeHead(403).end(); return; }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      let status = 200;
      if (!fs.existsSync(file)) { file = path.join(canonical, '404.html'); status = 404; }
      if (!fs.existsSync(file)) { res.writeHead(404).end(req.method === 'HEAD' ? undefined : 'Not found'); return; }
      file = fs.realpathSync(file);
      if (!within(file) || !fs.statSync(file).isFile()) { res.writeHead(403).end(); return; }
      const { size } = fs.statSync(file);
      let start = 0, end = size - 1;
      if (req.headers.range && status === 200) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        let valid = !!match && !!(match[1] || match[2]);
        if (valid) {
          if (!match[1]) start = Math.max(0, size - Number(match[2]));
          else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
          valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size;
        }
        if (!valid) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
        status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      res.writeHead(status, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': Math.max(0, end - start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD' || size === 0) res.end();
      else {
        const stream = fs.createReadStream(file, { start, end });
        stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
      }
    } catch { if (!res.headersSent) res.writeHead(400).end(req.method === 'HEAD' ? undefined : 'Bad request'); else res.destroy(); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(path.join(root, 'out/index.html'))) { console.error('Run npm run build first.'); process.exit(1); }
  const raw = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').trim();
  const basePath = raw && raw !== '/' ? `/${raw.replace(/^\/+|\/+$/g, '')}` : '';
  const port = Number(process.env.PORT) || 3000;
  const server = createStaticServer({ basePath });
  server.on('error', err => { console.error(`Local server: ${err.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Audiobook Creator: http://127.0.0.1:${port}${basePath}/ (Ctrl+C to stop)`));
}
