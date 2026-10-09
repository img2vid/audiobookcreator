#!/usr/bin/env node
// ============================================================
// Bridge v5 self-checks — static + live, including a FAKE Piper
// binary that reproduces the user's 500 (client never sends
// modelPath → old server passed --model '' → instant failure).
//   node scripts/bridge-v5-checks.mjs
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'scripts', 'os-tts-server.mjs');
const src = fs.readFileSync(serverPath, 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
}

// ---------------------------------------------------------------- static
console.log('static:');
check('VERSION bumped to 5', /const VERSION = 5;/.test(src));
check('winrt list uses -EncodedCommand transport', /runPs\(WINRT_PS_LIST, 'encoded'\)/.test(src));
check('WINRTINFO diagnostic marker present', /WINRTINFO: voices=/.test(src));
check('WINRTERROR carries exception type + inner', /WINRTERROR-INNER:/.test(src) && /Exception\.GetType\(\)\.Name/.test(src));
check('zero-voice scan explains itself (LTSC hint)', /0 OneCore voices are installed/.test(src));
check('registry cross-check targets OneCore tokens', /Speech_OneCore\\\\Voices\\\\Tokens/.test(src));
check('piper never gets an empty --model', !/modelPath \|\| ''/.test(src));
check('piper synth requires a model with clear error', /no Piper \.onnx model found/.test(src));
check('piper CLI flavor fallback (classic + python)', /--output_file/.test(src) && /--output-file/.test(src) && /--length_scale/.test(src) && /--length-scale/.test(src));
check('piper runs with cwd = binary folder', /cwd: path\.dirname\(exe\)/.test(src));
check('piper espeak-ng-data warning at scan', /espeak-ng-data folder is missing next to it/.test(src));
check('server resolves modelPath from the matched voice record', /voiceRec\?\.modelPath\) modelPath = voiceRec\.modelPath/.test(src));
check('503 with fix hint when piper has no models', /piper is installed but no \.onnx voice models were found/.test(src));
check('500 errors name the engine', /render failed: \$\{err\.message\}/.test(src));
check('engineInfo carries warnings for available engines', /engineNotes\[id\] \? \{ warning: engineNotes\[id\] \}/.test(src));
check('startup logs warnings for true engines', /true, with warning/.test(src));
check('run() supports cwd option', /\{ windowsHide: true, cwd \}/.test(src));
check('engineReason covers say (macOS-only)', /macOS-only engine/.test(src));
check('/ping exposes engineInfo', /engineInfo: enginesCache\.engineInfo \|\| undefined/.test(src));

// ---------------------------------------------------------------- live
console.log('live:');

// Fake Piper: mimics the NEW python piper1-gpl CLI (rejects --output_file, so
// the bridge MUST fall back to --output-file). Refuses an empty --model, which
// is exactly what the old server used to pass.
const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'fakepiper-'));
const binDir = path.join(fake, 'bin');
const voiceDir = path.join(fake, 'voices');
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(voiceDir, { recursive: true });
const fakeScript = `#!/usr/bin/env bash
model="" ; out="" ; outflag="" ; prev=""
while [ $# -gt 0 ]; do
  if [ "$prev" = "--model" ]; then model="$1"; fi
  if [ "$1" = "--output_file" ] || [ "$1" = "--output-file" ]; then outflag="$1"; fi
  if [ "$prev" = "$outflag" ] || [ "$2" = "" ]; then :; fi
  if [ "$prev" = "--output_file" ] || [ "$prev" = "--output-file" ]; then out="$1"; fi
  prev="$1"; shift
done
if [ -z "$model" ]; then echo "error: --model is required" >&2; exit 2; fi
if [ "$outflag" = "--output_file" ]; then echo "piper-gpl: unrecognized argument: --output_file" >&2; exit 2; fi
cat > /dev/null
printf 'RIFF\\x24\\x08\\x00\\x00WAVEfmt \\x10\\x00\\x00\\x00\\x01\\x00\\x01\\x00\\x22\\x56\\x00\\x00\\x44\\xac\\x00\\x00\\x02\\x00\\x10\\x00data\\x00\\x08\\x00\\x00' > "$out"
head -c 2048 /dev/zero >> "$out"
exit 0
`;
fs.writeFileSync(path.join(binDir, 'piper'), fakeScript, { mode: 0o755 });
fs.writeFileSync(path.join(voiceDir, 'en_US-faketest-medium.onnx'), 'fake-onnx-bytes');

const PORT = 8499;
const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PATH: `${binDir}:${process.env.PATH}`,
    PIPER_VOICES_DIR: voiceDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { tries = 50, step = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await wait(step);
  }
  throw new Error('condition not met in time');
}
const get = (p, headers = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { headers }).then(async (r) => ({ code: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }));
const synth = (bodyObj) => fetch(`http://127.0.0.1:${PORT}/synthesize`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Origin': 'https://img2vid.github.io' },
  body: JSON.stringify(bodyObj),
});

try {
  const ping = await until(async () => {
    const r = await get('/ping');
    return r.body?.version === 5 && !r.body?.warming ? r : null;
  }, { tries: 60, step: 300 });
  check('/ping answers with version 5', ping.body.version === 5);
  check('/ping CORS + PNA headers on JSON', ping.headers.get('access-control-allow-origin') === '*' && ping.headers.get('access-control-allow-private-network') === 'true');
  check('fake piper detected (piper:true)', ping.body.engines?.piper === true);
  check('piper warning surfaced (espeak-ng-data missing)', /espeak-ng-data/.test(String(ping.body.engineInfo?.piper?.warning ?? '')));
  check('unavailable engine ships a reason (say → macOS-only)', /macOS-only/.test(String(ping.body.engineInfo?.say?.reason ?? '')));

  const pre = await fetch(`http://127.0.0.1:${PORT}/ping`, { method: 'OPTIONS' });
  check('OPTIONS preflight 204 + PNA', pre.status === 204 && pre.headers.get('access-control-allow-private-network') === 'true');

  const voices = await get('/voices');
  const piperVoice = (voices.body.voices || []).find((v) => v.engine === 'piper');
  check('/voices lists the fake piper model with modelPath', !!piperVoice && typeof piperVoice.modelPath === 'string' && piperVoice.modelPath.endsWith('.onnx'));

  // THE user regression: voice name only, NO modelPath — old code 500'd here.
  const r1 = await synth({ voice: 'en_US-faketest-medium', text: 'Piper name routing regression.', rate: 1 });
  const b1 = Buffer.from(await r1.arrayBuffer());
  check('voice-name-only render → 200 piper WAV (was the 500)', r1.status === 200 && r1.headers.get('x-os-tts-engine') === 'piper' && b1.toString('latin1', 0, 4) === 'RIFF' && b1.length > 1000);

  // Python-flavor binary: proves --output_file → --output-file fallback fired.
  check('flavor fallback engaged (--output-file attempt succeeded)', /piper: fell back to --output-file/.test(serverLog));

  // engine=piper, no voice → first-model fallback server-side.
  const r2 = await synth({ engine: 'piper', text: 'First model fallback.' });
  check('engine-only render → 200 via first-model fallback', r2.status === 200 && r2.headers.get('x-os-tts-engine') === 'piper');

  // espeak-ng regression (real binary in sandbox) still healthy.
  const r3 = await synth({ text: 'Bridge five diagnostics self test.' });
  check('default engine (espeak-ng) → RIFF WAV', r3.status === 200 && Buffer.from(await r3.arrayBuffer()).toString('latin1', 0, 4) === 'RIFF');

  await until(() => /Detected engines:/.test(serverLog) && /Voices:/.test(serverLog), { tries: 20, step: 200 });
  check('startup logs piper warning line', /piper: true, with warning — /.test(serverLog));
  check('startup logs false-engine reasons', /false — /.test(serverLog));
  console.log('  --- bridge console excerpt ---');
  for (const line of serverLog.split(/\r?\n/).filter(Boolean).slice(0, 16)) console.log('  |', line);
} catch (err) {
  fail++;
  console.log('FAIL  live round-trip:', err.message);
  console.log(serverLog.slice(-3000));
} finally {
  child.kill('SIGINT');
  await wait(300);
  child.kill('SIGKILL');
  try { fs.rmSync(fake, { recursive: true, force: true }); } catch { /* noop */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
