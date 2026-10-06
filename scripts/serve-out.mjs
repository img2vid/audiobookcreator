// Tiny zero-dependency static server for the exported site in ./out — behaves
// like GitHub Pages (including the NEXT_PUBLIC_BASE_PATH sub-path), so you can
// test the exact production output locally:
//
//   npm run build && npm run preview
//   # project-site simulation:
//   NEXT_PUBLIC_BASE_PATH=/my-repo npm run build && NEXT_PUBLIC_BASE_PATH=/my-repo npm run preview
//   (PowerShell: $env:NEXT_PUBLIC_BASE_PATH="/my-repo")

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'out');
const port = Number(process.env.PORT) || 3000;

const raw = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').trim();
const basePath = raw && raw !== '/' ? `/${raw.replace(/^\/+|\/+$/g, '')}` : '';

if (!fs.existsSync(path.join(outDir, 'index.html'))) {
  console.error('No ./out folder found. Run `npm run build` first.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.traineddata': 'application/octet-stream',
  '.map': 'application/json',
};

function resolveFile(urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const abs = path.resolve(outDir, rel);
  if (abs !== outDir && !abs.startsWith(outDir + path.sep)) return null; // path traversal guard
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const index = path.join(abs, 'index.html');
    return fs.existsSync(index) ? index : null;
  }
  return fs.existsSync(abs) ? abs : null;
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = url.pathname;

    if (basePath) {
      if (pathname === basePath) {
        res.writeHead(301, { Location: `${basePath}/${url.search}` }).end();
        return;
      }
      if (!pathname.startsWith(`${basePath}/`)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found. This build is served under ${basePath}/`);
        return;
      }
      pathname = pathname.slice(basePath.length);
    }

    const file = resolveFile(pathname);
    if (!file) {
      const notFound = path.join(outDir, '404.html');
      res.writeHead(404, { 'Content-Type': MIME['.html'] });
      res.end(req.method === 'HEAD' ? undefined : fs.existsSync(notFound) ? fs.readFileSync(notFound) : 'Not found');
      return;
    }
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
  }
});

server.listen(port, () => {
  console.log(`Serving ./out at http://localhost:${port}${basePath || ''}/  (Ctrl+C to stop)`);
});
