#!/usr/bin/env node
// One foreground process controls both local services on Windows, macOS and Linux.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
if (!existsSync(path.join(root, dev ? 'node_modules/next/dist/bin/next' : 'out/index.html'))) {
  console.error(dev ? 'Run npm ci first.' : 'Run npm ci and npm run build first.'); process.exit(1);
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
const launch = (args, env = {}) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...env } });
  children.push(child); child.on('error', err => { console.error(err.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 1); });
};
launch(['scripts/os-tts-server.mjs'], { PORT: process.env.BRIDGE_PORT || '8477' });
launch(dev ? ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', process.env.PORT || '3000'] : ['scripts/serve-out.mjs']);
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
