#!/usr/bin/env node
// ============================================================
// Openmukti Audiobook Creator — OS Speech Bridge server
// ============================================================
// A zero-dependency local companion server that routes synthesis to the
// ESTABLISHED speech engine that ships with your operating system, so the
// app can RENDER FILES with real OS voices instead of the bundled formant
// synthesizer:
//
//   Windows  →  SAPI 5 via System.Speech (PowerShell)  — Microsoft David, Zira, …
//   macOS    →  Apple Speech (`say`)                   — Samantha, Alex, Siri-class…, plus optional Piper neural voices
//
// Endpoints (all local-only, bound to 127.0.0.1):
//   GET  /ping                  → { ok, platform, engines, piperVoices }
//   GET  /voices                → { voices: [{ id, engine, name, lang, gender?, neural?, quality }] }
//   POST /synthesize            → audio/wav bytes
//                               body: { engine?, voice?, text, rate?, pitch?, volume? }
//
// Usage:
//   npm run os-tts                 (or: node scripts/os-tts-server.mjs)
//   PORT=8477 PIPER_VOICES_DIR=~/piper npm run os-tts
//
// Security: binds to loopback only, caps request size, renders into the OS
// temp dir, kills hung engine processes after a timeout.
// ============================================================

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 2;
const PORT = Number(process.env.PORT) || 8477;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_TEXT_CHARS = 25_000;
const ENGINE_TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS) || 60_000;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'os-tts-bridge-'));

// ---------------------------------------------------------------- utilities

function log(...args) {
  console.log(`[os-tts] ${new Date().toISOString().slice(11, 19)}`, ...args);
}

function run(cmd, args, { input, timeoutMs = ENGINE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(new Error(`${cmd} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 400) || stdout.trim().slice(0, 400)}`));
    });
    if (input != null) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function which(bin) {
  const probe = process.platform === 'win32'
    ? spawn('where.exe', [bin])
    : spawn('which', [bin]);
  return new Promise((resolve) => {
    let out = '';
    probe.stdout.on('data', (d) => { out += d; });
    probe.on('error', () => resolve(null));
    probe.on('close', (code) => {
      const first = out.split(/\r?\n/).find(Boolean);
      resolve(code === 0 && first ? first.trim() : null);
    });
  });
}

function uniqueTemp(ext) {
  return path.join(TMP_DIR, `utt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function sanitizeText(text) {
  // strip control chars (keep \n) — engines choke on NULs and friends
  return String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .normalize('NFC');
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  // CORS on EVERY response — the preflight alone is not enough. The page that
  // calls us (http://localhost:3000 or https://<user>.github.io) is always a
  // DIFFERENT origin than http://127.0.0.1:8477, so without ACAO on the actual
  // response Chrome blocks the JSON with:
  //   "No 'Access-Control-Allow-Origin' header is present on the requested resource"
  res.writeHead(code, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendWav(res, file) {
  const data = fs.readFileSync(file);
  try { fs.unlinkSync(file); } catch { /* noop */ }
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'audio/wav',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

// ------------------------------------------------------ rate / pitch mapping
// The app speaks in multipliers (1.0 = normal). Map to each engine's scale.

function wpmFor(rate, base = 175) {
  return clamp(Math.round(base * clamp(rate || 1, 0.25, 4)), 60, 500);
}
function sapiRate(rate) {
  // System.Speech Rate: -10..10, 0 = normal. log2 keeps 1.0 → 0.
  return clamp(Math.round(Math.log2(clamp(rate || 1, 0.25, 4)) * 5), -10, 10);
}
function sapiVolume(volume) {
  return clamp(Math.round(clamp(volume ?? 1, 0, 1) * 100), 0, 100);
}
function espeakPitch(pitch) {
  // espeak-ng -p: 0..99, 50 = normal
  return clamp(Math.round(50 + ((pitch || 1) - 1) * 45), 0, 99);
}
function espeakAmp(volume) {
  // espeak-ng -a: 0..200, 100 = normal
  return clamp(Math.round(clamp(volume ?? 1, 0, 1.6) * 100), 0, 200);
}
function ssmlPercent(rate, pitch, volume) {
  const r = clamp(rate || 1, 0.25, 4);
  const p = clamp(pitch || 1, 0.5, 1.8);
  const v = clamp(volume ?? 1, 0, 1);
  return `rate="${Math.round(r * 100)}%" pitch="${p >= 1 ? '+' : ''}${Math.round((p - 1) * 100)}%" volume="${Math.round(v * 100)}%"`;
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------- engines

const PLATFORM = process.platform;
const ENGINES = {}; // id → { available, list(), synth() }

// ---------- Windows SAPI 5 (System.Speech) ----------
const SAPI_PS_LIST = `
Add-Type -AssemblyName System.Speech | Out-Null;
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$s.GetInstalledVoices() | ForEach-Object {
  $i = $_.VoiceInfo;
  [PSCustomObject]@{ name = $i.Name; lang = $i.Culture.Name; gender = if ($i.Gender -eq 'Female') {'female'} elseif ($i.Gender -eq 'Male') {'male'} else {''}; desc = $i.Description } |
    ConvertTo-Json -Compress
};
`;

const SAPI_PS_SYNTH = `
param([string]$TextPath, [string]$OutPath, [int]$Rate, [int]$Volume, [string]$SsmlPath)
Add-Type -AssemblyName System.Speech | Out-Null;
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$s.Rate = $Rate;
$s.Volume = $Volume;
$s.SetOutputToWaveFile($OutPath, (New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)));
$text = [IO.File]::ReadAllText($TextPath);
if ([string]::IsNullOrEmpty($SsmlPath)) {
  $s.Speak($text) | Out-Null;
} else {
  $ssml = [IO.File]::ReadAllText($SsmlPath);
  try { $s.SpeakSsml($ssml) | Out-Null; } catch { $s.Speak($text) | Out-Null; }
}
$s.Dispose();
`;

ENGINES.sapi = {
  label: 'Windows SAPI 5 (System.Speech)',
  async available() { return PLATFORM === 'win32'; },
  async list() {
    try {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SAPI_PS_LIST]);
      const voices = [];
      for (const line of stdout.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const v = JSON.parse(t);
          voices.push({
            id: `sapi:${v.name}`,
            engine: 'sapi',
            name: v.name,
            lang: v.lang || 'en-US',
            gender: v.gender || undefined,
            neural: /natural|neural|online/i.test(v.name),
            quality: /natural|neural/i.test(v.name) ? 5 : 3,
            description: v.desc || 'Windows SAPI voice',
          });
        } catch { /* skip malformed line */ }
      }
      return voices;
    } catch (err) {
      log('sapi list failed:', err.message);
      return [];
    }
  },
  async synth({ text, voice, rate, pitch, volume, lang }) {
    const textFile = uniqueTemp('txt');
    fs.writeFileSync(textFile, sanitizeText(text), 'utf8');
    const outFile = uniqueTemp('wav');
    let ssmlFile = '';
    // System.Speech has no Pitch property — use SSML prosody when pitch != 1
    if (pitch && Math.abs(pitch - 1) > 0.01) {
      ssmlFile = uniqueTemp('xml');
      const xmlLang = (lang || 'en-US').replace(/_/g, '-');
      const ssml = `<?xml version="1.0" encoding="utf-8"?><speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xmlLang}"><prosody ${ssmlPercent(rate, pitch, volume)}>${escapeXml(sanitizeText(text))}</prosody></speak>`;
      fs.writeFileSync(ssmlFile, ssml, 'utf8');
    }
    try {
      await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SAPI_PS_SYNTH,
        '-TextPath', textFile, '-OutPath', outFile,
        '-Rate', String(sapiRate(rate)), '-Volume', String(sapiVolume(volume)),
        '-SsmlPath', ssmlFile,
      ]);
      return outFile;
    } catch (err) {
      try { fs.unlinkSync(outFile); } catch { /* noop */ }
      throw err;
    } finally {
      try { fs.unlinkSync(textFile); } catch { /* noop */ }
      if (ssmlFile) { try { fs.unlinkSync(ssmlFile); } catch { /* noop */ } }
    }
  },
};

// ---------- macOS Apple Speech (`say`) ----------
ENGINES.say = {
  label: 'macOS Apple Speech (say)',
  async available() { return PLATFORM === 'darwin' && !!(await which('say')); },
  async list() {
    try {
      const { stdout } = await run('say', ['-v', '?']);
      const voices = [];
      for (const line of stdout.split(/\r?\n/)) {
        // "Samantha            en_US    # Hello, my name is Samantha."
        const m = /^(.+?)\s{2,}([a-zA-Z]{2,4}[-_][A-Za-z]{2,4}|[a-zA-Z]{2,4})\s*(?:#\s*(.*))?$/.exec(line.trim());
        if (!m) continue;
        const name = m[1].trim();
        const rawLang = m[2].replace('_', '-');
        const comment = (m[3] ?? '').trim();
        const enhanced = /enhanced|premium|novelty|eloquence/i.test(comment) ? 0 : 0;
        voices.push({
          id: `say:${name}`,
          engine: 'say',
          name,
          lang: rawLang,
          neural: /premium|enhanced/i.test(comment),
          quality: /premium/i.test(comment) ? 5 : /enhanced/i.test(comment) ? 4 : 3,
          description: comment || 'Apple Speech voice',
          _reserved: enhanced,
        });
      }
      return voices;
    } catch (err) {
      log('say list failed:', err.message);
      return [];
    }
  },
  async synth({ text, voice, rate }) {
    const outFile = uniqueTemp('wav');
    const args = ['-o', outFile, '--data-format=LEI16@22050'];
    if (voice) args.push('-v', voice);
    if (rate && Math.abs(rate - 1) > 0.01) args.push('-r', String(wpmFor(rate, 180)));
    args.push(sanitizeText(text));
    await run('say', args);
    return outFile;
  },
};

// ---------- Linux espeak-ng / espeak ----------
function espeakListFactory(bin) {
  return {
    label: `${bin} (Linux speech synthesizer)`,
    async available() { return PLATFORM !== 'win32' && PLATFORM !== 'darwin' && !!(await which(bin)); },
    async list() {
      try {
        const { stdout } = await run(bin, ['--voices']);
        const voices = [];
        for (const line of stdout.split(/\r?\n/).slice(1)) {
          // Pty Language Age/Gender VoiceName          File          Languages
          const m = /^\s*\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+\S+.*$/.exec(line);
          if (!m) continue;
          const lang = m[1].replace('_', '-');
          const gender = /female/i.test(m[2]) ? 'female' : /male/i.test(m[2]) ? 'male' : undefined;
          const name = m[3];
          voices.push({
            id: `${bin}:${name}`,
            engine: bin,
            name,
            lang,
            gender,
            neural: false,
            quality: 2,
            description: `espeak voice “${name}” (${lang})`,
          });
        }
        return voices;
      } catch (err) {
        log(`${bin} list failed:`, err.message);
        return [];
      }
    },
    async synth({ text, voice, rate, pitch, volume }) {
      const outFile = uniqueTemp('wav');
      const args = ['-w', outFile];
      args.push('-v', voice || 'en');
      if (rate && Math.abs(rate - 1) > 0.01) args.push('-s', String(wpmFor(rate, 175)));
      if (pitch && Math.abs(pitch - 1) > 0.01) args.push('-p', String(espeakPitch(pitch)));
      if (volume != null && Math.abs(volume - 1) > 0.01) args.push('-a', String(espeakAmp(volume)));
      args.push(sanitizeText(text));
      await run(bin, args);
      return outFile;
    },
  };
}
ENGINES['espeak-ng'] = espeakListFactory('espeak-ng');
ENGINES.espeak = espeakListFactory('espeak');

// ---------- Piper (established open-source neural TTS) ----------
const piperVoicesDir = process.env.PIPER_VOICES_DIR || '';

function piperModels() {
  if (!piperVoicesDir) return [];
  try {
    return fs.readdirSync(piperVoicesDir)
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => {
        const base = f.replace(/\.onnx$/, '');
        const m = /^([a-z]{2,3})_([A-Z]{2,4})-(.+)$/.exec(base);
        return {
          id: `piper:${base}`,
          engine: 'piper',
          name: base,
          lang: m ? `${m[1]}-${m[2]}` : 'en-US',
          neural: true,
          quality: 5,
          modelPath: path.join(piperVoicesDir, f),
          description: `Piper neural voice “${m ? m[3] : base}”`,
        };
      });
  } catch {
    return [];
  }
}

ENGINES.piper = {
  label: 'Piper neural TTS',
  async available() {
    if (!(await which('piper'))) return false;
    return piperModels().length > 0;
  },
  async list() { return piperModels(); },
  async synth({ text, rate, modelPath }) {
    const outFile = uniqueTemp('wav');
    const args = ['--model', modelPath || '', '--output_file', outFile];
    if (rate && Math.abs(rate - 1) > 0.01) args.push('--length_scale', String(clamp(1 / clamp(rate, 0.5, 2), 0.5, 2)));
    await run('piper', args, { input: sanitizeText(text) });
    return outFile;
  },
};

// ------------------------------------------------------------ engine status

let enginesCache = { at: 0, available: {}, voices: [] };
let refreshInFlight = null;

async function refreshEngines(force = false) {
  if (!force && Date.now() - enginesCache.at < 15_000) return enginesCache;
  // Share ONE enumeration between concurrent / overlapping callers. The first
  // scan spawns PowerShell on Windows (seconds); without this dedup every
  // retried /ping would spawn yet another scan and none would finish early.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const available = {};
    for (const [id, eng] of Object.entries(ENGINES)) {
      try { available[id] = await eng.available(); } catch { available[id] = false; }
    }
    const voices = [];
    for (const id of Object.keys(ENGINES)) {
      if (!available[id]) continue;
      try {
        for (const v of await ENGINES[id].list()) voices.push(v);
      } catch (err) {
        log(`voice list for ${id} failed:`, err.message);
      }
    }
    enginesCache = { at: Date.now(), available, voices };
    return enginesCache;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function pickEngine(requested) {
  const { available } = enginesCache;
  if (requested && ENGINES[requested] && available[requested]) return requested;
  // platform-native preference order (most realistic first)
  const order = PLATFORM === 'win32' ? ['sapi', 'piper']
    : PLATFORM === 'darwin' ? ['say', 'piper']
      : ['espeak-ng', 'espeak', 'piper'];
  for (const id of order) if (available[id]) return id;
  return null;
}

// ---------------------------------------------------------------- HTTP layer

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // Chrome "Private Network Access": pages served over HTTPS (e.g. GitHub Pages)
  // or from the LAN may talk to this loopback bridge ONLY if the preflight
  // response carries this header — without it Chrome blocks the request even
  // though CORS above is wide open. Harmless for plain-http localhost use.
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && (route === '/ping' || route === '/' )) {
      // Liveness must be INSTANT. The first engine scan (PowerShell on Windows)
      // can take several seconds — never make /ping wait for it: answer from the
      // cache and warm the cache in the background. /voices awaits the shared
      // scan, so clients that want the voice list simply block a little longer.
      const warming = Date.now() - enginesCache.at >= 15_000;
      if (warming) void refreshEngines().catch(() => { /* logged inside */ });
      sendJson(res, 200, {
        ok: true,
        server: 'os-tts-bridge',
        version: VERSION,
        platform: PLATFORM,
        engines: enginesCache.available,
        voiceCount: enginesCache.voices.length,
        ...(warming ? { warming: true } : {}),
        piperVoicesDir: piperVoicesDir || undefined,
      });
      return;
    }

    if (req.method === 'GET' && route === '/voices') {
      const status = await refreshEngines();
      sendJson(res, 200, { voices: status.voices, engines: status.available });
      return;
    }

    if (req.method === 'POST' && route === '/synthesize') {
      await refreshEngines(false);
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = sanitizeText(body.text ?? '');
      if (!text.trim()) { sendJson(res, 400, { error: 'text is required' }); return; }
      if (text.length > MAX_TEXT_CHARS) { sendJson(res, 413, { error: `text exceeds ${MAX_TEXT_CHARS} chars — split it client-side` }); return; }

      const engineId = pickEngine(body.engine);
      if (!engineId) {
        sendJson(res, 503, { error: 'no OS speech engine available on this machine' });
        return;
      }
      const eng = ENGINES[engineId];
      const voice = typeof body.voice === 'string' && body.voice ? body.voice.replace(/^(sapi|say|espeak-ng|espeak|piper):/, '') : undefined;
      log(`synthesize: engine=${engineId} voice=${voice ?? '(default)'} chars=${text.length}`);
      const file = await eng.synth({ ...body, text, voice });
      if (!fs.existsSync(file) || fs.statSync(file).size < 44) {
        throw new Error('engine produced no audio');
      }
      res.writeHead(200, {
        ...CORS,
        'Content-Type': 'audio/wav',
        'X-OS-TTS-Engine': engineId,
        'Cache-Control': 'no-store',
      });
      const data = fs.readFileSync(file);
      try { fs.unlinkSync(file); } catch { /* noop */ }
      res.end(data);
      return;
    }

    sendJson(res, 404, { error: `unknown route ${route}` });
  } catch (err) {
    log('error:', err.message);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, async () => {
  log(`OS Speech Bridge listening on http://${HOST}:${PORT}`);
  log(`Platform: ${PLATFORM} · temp dir: ${TMP_DIR}`);
  const status = await refreshEngines(true);
  log('Detected engines:', JSON.stringify(status.available));
  log(`Voices: ${status.voices.length}`);
  if (!status.voices.length) {
    log('No voices found — start the app anyway; TTS Studio will show exactly which engine is missing.');
    if (PLATFORM === 'linux' && !status.available['espeak-ng']) {
      log('Hint: install espeak-ng (sudo apt install espeak-ng) for Linux voices, or Piper for neural quality.');
    }
  }
  log('Press Ctrl+C to stop.');
});

process.on('SIGINT', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(0);
});
