#!/usr/bin/env node
// Browser CI tests exercise the real app/HTTP bridge/WAV export pipeline.
// Only the Balabolka executable is replaced with a deterministic CLI fixture.
// This is NOT a listening test or a test of real Windows SAPI quality.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests', 'fixtures', 'mock-balcon.mjs');
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
function start(script, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  child.on('error', error => { console.error(error); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 1); });
}

start('scripts/os-tts-server.mjs', {
  PORT: '8477',
  BALABOLKA_CMD: process.execPath,
  BALABOLKA_CMD_SCRIPT: fixture,
});
start('scripts/serve-out.mjs');
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
