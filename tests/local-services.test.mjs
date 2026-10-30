import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createStaticServer } from '../scripts/serve-out.mjs';
import { exportCommand } from '../scripts/export-audiobook.mjs';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-tests-'));
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };

test('static serving: base paths, HEAD, ranges, hostile host, malformed URLs, missing files', async () => {
  const dir = temp(); fs.writeFileSync(path.join(dir, 'index.html'), 'hello'); fs.writeFileSync(path.join(dir, 'audio.wav'), '0123456789');
  const server = createStaticServer({ outDir: dir, basePath: '/books' }); const url = await listen(server);
  try {
    assert.equal((await fetch(`${url}/books/`)).status, 200);
    const head = await fetch(`${url}/books/`, { method: 'HEAD' }); assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), '5');
    const range = await fetch(`${url}/books/audio.wav`, { headers: { Range: 'bytes=3-6' } }); assert.equal(range.status, 206); assert.equal(await range.text(), '3456');
    assert.equal((await fetch(`${url}/books/audio.wav`, { headers: { Range: 'bytes=99-' } })).status, 416);
    assert.equal((await fetch(`${url}/books`, { redirect: 'manual' })).status, 301);
    assert.equal((await fetch(`${url}/books/%FF`)).status, 400);
    assert.equal((await fetch(`${url}/books/%2f..%2fpackage.json`)).status, 403);
    assert.equal((await fetch(`${url}/books/missing`)).status, 404);
    assert.equal((await fetch(`${url}/books/`, { method: 'POST' })).status, 405);
    const badHost = await new Promise(resolve => {
      const req = http.get(`${url}/books/`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', e => { throw e; });
    }); assert.equal(badHost, 403);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bridge: loopback policy, validation, CPU admission control and disconnect cleanup', { timeout: 20000 }, async () => {
  const dir = temp();
  // This stub tests process/HTTP plumbing; it is explicitly NOT a voice-quality test.
  if (process.platform !== 'win32') {
    const stub = `#!/usr/bin/env node
import fs from 'node:fs';
const a=process.argv.slice(2);
if(a.includes('--voices')) { console.log('Pty Language Age/Gender VoiceName File'); console.log(' 5 en M Fixture fixture'); process.exit(0); }
let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',d=>text+=d); process.stdin.on('end',()=>{
const b=Buffer.alloc(444); b.write('RIFF'); b.writeUInt32LE(436,4); b.write('WAVEfmt ',8); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(22050,24); b.writeUInt32LE(44100,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(400,40);
setTimeout(()=>fs.writeFileSync(a[a.indexOf('-w')+1],b), text.includes('slow')?10000:20);
});
`;
    fs.writeFileSync(path.join(dir, 'espeak-ng'), stub, { mode: 0o755 });
  }
  const reserve = net.createServer(); const address = await listen(reserve); const port = new URL(address).port; await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, ['scripts/os-tts-server.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: port, PATH: dir + path.delimiter + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  const url = `http://127.0.0.1:${port}`;
  const post = body => fetch(`${url}/synthesize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { const r = await fetch(`${url}/ping`); if (r.ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
    assert.ok(ready, logs);
    assert.equal((await fetch(`${url}/ping`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const local = await fetch(`${url}/ping`, { headers: { Origin: 'http://localhost:3000' } }); assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.equal((await post('{')).status, 400);
    assert.equal((await post({ text: 'test', volume: 4 })).status, 400);
    assert.equal((await post({ text: 'test', engine: 'fake-engine' })).status, 400);
    assert.equal((await post({ text: 'a'.repeat(25001) })).status, 413);
    if (process.platform !== 'win32') {
      await fetch(`${url}/voices`);
      const audio = await post({ engine: 'espeak-ng', voice: 'Fixture', text: 'hello' }); assert.equal(audio.status, 200); assert.equal((await audio.arrayBuffer()).byteLength, 444);
      const ctrl = new AbortController();
      const hanging = fetch(`${url}/synthesize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'espeak-ng', text: 'slow' }), signal: ctrl.signal }).catch(() => null);
      await new Promise(r => setTimeout(r, 150));
      assert.equal((await post({ engine: 'espeak-ng', text: 'hello' })).status, 429);
      ctrl.abort(); await hanging;
      let retried;
      for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 50)); retried = await post({ engine: 'espeak-ng', text: 'hello' }); if (retried.status !== 429) break; }
      assert.equal(retried.status, 200);
    }
  } finally { child.kill(); await once(child, 'exit'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('FFmpeg exporter uses actual sample duration and rejects escaping inputs', () => {
  const dir = temp(), p = path.join(dir, 'part.wav');
  const b = Buffer.alloc(44144); b.write('RIFF'); b.write('WAVEfmt ', 8); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(22050,24); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(44100,40); fs.writeFileSync(p,b);
  const manifest = { title: 'Title', author: 'Author', language: 'en', chapters: [{ file: 'part.wav', duration: 99, title: 'Part = 1' }] };
  fs.writeFileSync(path.join(dir, 'chapters.json'), JSON.stringify(manifest));
  try {
    const args = exportCommand(dir, path.join(dir, 'result.m4b'), dir); assert.ok(args.includes('aac') && args.includes('1'));
    assert.match(fs.readFileSync(path.join(dir, 'metadata.txt'), 'utf8'), /END=1000/);
    assert.throws(() => exportCommand(dir, 'file.exe', dir));
    manifest.chapters[0].file = '../outside.wav'; fs.writeFileSync(path.join(dir, 'chapters.json'), JSON.stringify(manifest));
    assert.throws(() => exportCommand(dir, 'x.m4b', dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
