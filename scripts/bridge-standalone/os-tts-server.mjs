#!/usr/bin/env node
// ============================================================
// Openmukti Audiobook Creator — OS Speech Bridge server
// ============================================================
// A zero-dependency local companion server that routes synthesis to the
// ESTABLISHED speech engine that ships with your operating system, so the
// app can RENDER FILES with real OS voices instead of the bundled formant
// synthesizer:
//
//   Windows  →  Windows Natural Voices (WinRT/OneCore) — Aria, Jenny, Guy, every
//               Natural/neural + language-pack voice, PLUS legacy SAPI 5 via
//               System.Speech (David, Zira, …)
//   macOS    →  Apple Speech (`say`)                   — Samantha, Alex, Siri-class…
//   Linux    →  espeak-ng / espeak
//   any OS   →  optional Piper neural voices
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

const VERSION = 5;
const PORT = Number(process.env.PORT) || 8477;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_TEXT_CHARS = 25_000;
const ENGINE_TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS) || 60_000;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'os-tts-bridge-'));

// ---------------------------------------------------------------- utilities

function log(...args) {
  console.log(`[os-tts] ${new Date().toISOString().slice(11, 19)}`, ...args);
}

function run(cmd, args, { input, timeoutMs = ENGINE_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, cwd });
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

// The optional engines' Windows installers often do NOT add themselves to
// PATH — probe the standard install locations too. (This is why espeak-ng
// used to report "false" on Windows even when it was installed: the old
// availability check was Linux-only.)
const WIN_BIN_CANDIDATES = {
  'espeak-ng': [
    'C:\\Program Files\\eSpeak NG\\espeak-ng.exe',
    'C:\\Program Files (x86)\\eSpeak NG\\espeak-ng.exe',
  ],
  espeak: [
    'C:\\Program Files\\eSpeak\\espeak.exe',
    'C:\\Program Files (x86)\\eSpeak\\espeak.exe',
    'C:\\Program Files\\eSpeak NG\\espeak.exe',
  ],
  piper: [
    'C:\\Program Files\\piper\\piper.exe',
    path.join(os.homedir(), 'piper', 'piper.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'piper', 'piper.exe'),
  ],
};
const resolvedBinaries = {};

async function findBinary(bin) {
  if (resolvedBinaries[bin]) return resolvedBinaries[bin];
  const viaPath = await which(bin);
  if (viaPath) { resolvedBinaries[bin] = viaPath; return viaPath; }
  for (const cand of WIN_BIN_CANDIDATES[bin] || []) {
    try { if (fs.existsSync(cand)) { resolvedBinaries[bin] = cand; return cand; } } catch { /* noop */ }
  }
  return null;
}

// PowerShell scripts are executed through -File (not appended to -Command):
// that way the param() block binds reliably on every Windows version.
function writePsScript(text) {
  const file = uniqueTemp('ps1');
  fs.writeFileSync(file, text, 'utf8');
  return file;
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
function winrtRate(rate) {
  // WinRT SpeakingRate range: 0.5 .. 2.0 (1.0 = normal)
  return clamp(clamp(rate || 1, 0.25, 4), 0.5, 2);
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
    const ps1 = writePsScript(SAPI_PS_SYNTH);
    try {
      await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1,
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
      try { fs.unlinkSync(ps1); } catch { /* noop */ }
    }
  },
};

// ---------- Windows Natural Voices (WinRT / OneCore) ----------
// SAPI 5 (above) only sees LEGACY desktop voices registered under
// HKLM\SOFTWARE\Microsoft\Speech\Voices — a stock Windows 10/11 exposes just
// Microsoft David + Zira there (this is why only 2 voices used to appear).
// Every MODERN voice — Aria, Jenny, Guy, all "Natural" neural voices, plus
// every language pack added via Settings → Time & Language → Speech — lives
// in the OneCore stack and is reachable only through Windows.Media
// .SpeechSynthesis (WinRT). We drive it from PowerShell too, awaiting the
// IAsyncOperation results via the WindowsRuntime AsTask bridge and draining
// the audio with the WinRT→.NET stream shim.
// v4 diagnostics: the list script ALWAYS reports its environment. WINRTINFO
// tells us the projection loaded and how many voices AllVoices holds;
// WINRTERROR (+ inner) reports a failed projection with full detail. No
// statement-in-hashtable tricks — PS 5.1-safe across builds.
const WINRT_PS_LIST = `
$ErrorActionPreference = 'Stop';
try {
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime];
  $s = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer;
  $all = @($s.AllVoices);
  Write-Output ('WINRTINFO: voices=' + $all.Count + ' ps=' + $PSVersionTable.PSVersion.ToString() + ' runtime=' + [Environment]::Version.ToString());
  foreach ($v in $all) {
    $g = '';
    try { $g = [string]$v.Gender; } catch { }
    $gender = '';
    if ($g -eq 'Female') { $gender = 'female'; }
    elseif ($g -eq 'Male') { $gender = 'male'; }
    $desc = '';
    try { $desc = [string]$v.Description; } catch { }
    [PSCustomObject]@{ name = [string]$v.DisplayName; lang = [string]$v.Language; gender = $gender; desc = $desc } |
      ConvertTo-Json -Compress
  };
  try { $s.Dispose(); } catch { }
} catch {
  Write-Output ('WINRTERROR: ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message);
  if ($_.Exception.InnerException) { Write-Output ('WINRTERROR-INNER: ' + $_.Exception.InnerException.Message); }
};
`;

// Pure registry cross-check (no WinRT involved): how many voice token keys do
// the OneCore and SAPI stores actually hold? Distinguishes “projection broke”
// from “this Windows genuinely has no OneCore voices” (LTSC / de-bloated
// builds ship without the modern speech stack).
const WINRT_PS_REGCHECK = `
$ErrorActionPreference = 'SilentlyContinue';
foreach ($p in 'HKLM:\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices\\Tokens','HKCU:\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices\\Tokens','HKLM:\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens') {
  if (Test-Path $p) { Write-Output ('REG ' + $p + ' = ' + @(Get-ChildItem $p).Count); }
  else { Write-Output ('REG ' + $p + ' = MISSING'); }
};
`;

const WINRT_PS_SYNTH = `
param([string]$TextPath, [string]$OutPath, [string]$Voice, [double]$Rate, [double]$Pitch, [double]$Volume)
$ErrorActionPreference = 'Stop';
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null;
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime];
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1);
function AwaitOp($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result; }
$s = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer;
if (-not [string]::IsNullOrEmpty($Voice)) {
  $vi = @($s.AllVoices | Where-Object { $_.DisplayName -eq $Voice }) | Select-Object -First 1;
  if ($vi) { $s.Voice = $vi; }
}
try { $s.Options.SpeakingRate = $Rate; } catch { }
try { $s.Options.AudioPitch = $Pitch; } catch { }
try { $s.Options.AudioVolume = $Volume; } catch { }
$stream = AwaitOp ($s.SynthesizeTextToStreamAsync([IO.File]::ReadAllText($TextPath))) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]);
$net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0));
$ms = New-Object System.IO.MemoryStream;
$net.CopyTo($ms);
[IO.File]::WriteAllBytes($OutPath, $ms.ToArray());
$net.Dispose();
$s.Dispose();
`;

let winrtCache = { at: 0, voices: [] };

// Human-readable reason strings, surfaced on the console, in /ping and in
// /voices so a "winrt": false is never silent again.
const engineNotes = {};

// -EncodedCommand is the primary transport (UTF-16LE base64): immune to every
// quoting / newline / comma mangling a -Command argument could ever hit.
function psEncode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}
function runPs(script, mode = 'encoded') {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (mode === 'encoded') args.push('-EncodedCommand', psEncode(script));
  else args.push('-Command', script);
  return run('powershell.exe', args);
}

async function winrtRegistryCheck() {
  try {
    const { stdout } = await runPs(WINRT_PS_REGCHECK);
    const out = {};
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^REG (.+) = (.+)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return Object.keys(out).length ? out : { note: 'no REG lines in output', raw: stdout.trim().slice(0, 200) };
  } catch (err) {
    return { error: err.message };
  }
}

async function winrtScan() {
  if (Date.now() - winrtCache.at < 60_000) return winrtCache.voices;
  winrtCache = { at: Date.now(), voices: [] }; // failed/empty scans are cached for the TTL too
  delete engineNotes.winrt;
  const notes = [];
  try {
    let stdout = '';
    let usedMode = 'encoded';
    try {
      ({ stdout } = await runPs(WINRT_PS_LIST, 'encoded'));
    } catch (err) {
      // transport-level failure (spawn error, non-zero exit, timeout) — retry
      // once with the classic -Command transport before giving up.
      notes.push(`encoded transport failed (${err.message}); retried with -Command`);
      usedMode = 'command';
      ({ stdout } = await runPs(WINRT_PS_LIST, 'command'));
    }
    const seen = new Set();
    const voices = [];
    let infoLine = '';
    let errorLine = '';
    let innerLine = '';
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('WINRTINFO:')) { infoLine = t.slice(10).trim(); continue; }
      if (t.startsWith('WINRTERROR-INNER:')) { innerLine = t.slice(17).trim(); continue; }
      if (t.startsWith('WINRTERROR:')) { errorLine = t.slice(11).trim(); continue; }
      if (!t.startsWith('{')) continue;
      try {
        const v = JSON.parse(t);
        const name = String(v.name || '').trim();
        const key = name.toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const haystack = `${name} ${v.desc || ''}`;
        voices.push({
          id: `winrt:${name}`,
          engine: 'winrt',
          name,
          lang: v.lang || 'en-US',
          gender: v.gender || undefined,
          neural: /natural|neural|online/i.test(haystack),
          quality: /natural|neural/i.test(haystack) ? 5 : 4,
          description: v.desc || 'Windows voice (OneCore)',
        });
      } catch { /* skip malformed line */ }
    }
    if (errorLine) {
      // The WinRT projection itself is broken on this machine.
      const detail = `${errorLine}${innerLine ? ` (inner: ${innerLine})` : ''}`;
      notes.push(`WinRT projection failed: ${detail} [transport=${usedMode}]`);
      log('winrt scan:', detail, `[transport=${usedMode}]`);
      const reg = await winrtRegistryCheck();
      notes.push(`registry cross-check: ${JSON.stringify(reg)}`);
      log('winrt registry cross-check:', JSON.stringify(reg));
    } else if (!voices.length) {
      // Exit 0, projection healthy, but NO OneCore voices — the LTSC /
      // de-bloated Windows signature. Tell the user exactly how to fix it.
      const reg = await winrtRegistryCheck();
      const summary = infoLine
        ? `WinRT projection OK (${infoLine}) but 0 OneCore voices are installed — modern voices (Aria/Jenny/Natural + language packs) are missing on this Windows (typical of LTSC or de-bloated builds). Fix: Settings → Time & Language → Speech → Add voices, or run as admin: Add-WindowsCapability -Online -Name Language.Speech~~~en-US~0.0.1.0, then restart the bridge`
        : `PowerShell produced no WINRTINFO and no voices (exit 0${stdout ? `, stdout head: ${stdout.trim().slice(0, 160)}` : ''})`;
      notes.push(`${summary} · registry: ${JSON.stringify(reg)}`);
      log('winrt scan empty:', summary);
      log('winrt registry cross-check:', JSON.stringify(reg));
    }
    winrtCache = { at: Date.now(), voices };
  } catch (err) {
    notes.push(`scan failed: ${err.message}`);
    log('winrt list failed:', err.message);
  }
  if (notes.length) engineNotes.winrt = notes.join(' · ');
  return winrtCache.voices;
}

ENGINES.winrt = {
  label: 'Windows Natural Voices (OneCore)',
  async available() { return PLATFORM === 'win32' && (await winrtScan()).length > 0; },
  async list() { return winrtScan(); },
  async synth({ text, voice, rate, pitch, volume }) {
    const textFile = uniqueTemp('txt');
    fs.writeFileSync(textFile, sanitizeText(text), 'utf8');
    const outFile = uniqueTemp('wav');
    const ps1 = writePsScript(WINRT_PS_SYNTH);
    try {
      await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-TextPath', textFile, '-OutPath', outFile, '-Voice', voice || '',
        '-Rate', String(winrtRate(rate)), '-Pitch', String(clamp(pitch || 1, 0, 2)),
        '-Volume', String(clamp(volume ?? 1, 0, 1)),
      ]);
      return outFile;
    } catch (err) {
      try { fs.unlinkSync(outFile); } catch { /* noop */ }
      throw err;
    } finally {
      try { fs.unlinkSync(textFile); } catch { /* noop */ }
      try { fs.unlinkSync(ps1); } catch { /* noop */ }
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
    label: `${bin} (open-source formant synthesizer)`,
    // Any platform where the binary exists — including Windows, where the
    // installer rarely touches PATH (see WIN_BIN_CANDIDATES).
    async available() { return !!(await findBinary(bin)); },
    async list() {
      try {
        const exe = (await findBinary(bin)) || bin;
        const { stdout } = await run(exe, ['--voices']);
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
      const exe = (await findBinary(bin)) || bin;
      const outFile = uniqueTemp('wav');
      const args = ['-w', outFile];
      args.push('-v', voice || 'en');
      if (rate && Math.abs(rate - 1) > 0.01) args.push('-s', String(wpmFor(rate, 175)));
      if (pitch && Math.abs(pitch - 1) > 0.01) args.push('-p', String(espeakPitch(pitch)));
      if (volume != null && Math.abs(volume - 1) > 0.01) args.push('-a', String(espeakAmp(volume)));
      args.push(sanitizeText(text));
      await run(exe, args);
      return outFile;
    },
  };
}
ENGINES['espeak-ng'] = espeakListFactory('espeak-ng');
ENGINES.espeak = espeakListFactory('espeak');

// ---------- Piper (established open-source neural TTS) ----------
const piperVoicesDir = process.env.PIPER_VOICES_DIR || '';

// Piper ships as a plain zip (no installer, no PATH entry), and its *.onnx
// models live wherever the user unzipped them — probe the conventional spots.
function piperVoicesDirs() {
  const dirs = [];
  const push = (d) => { if (d && !dirs.includes(d)) dirs.push(d); };
  push(piperVoicesDir);
  if (resolvedBinaries.piper) {
    const dir = path.dirname(resolvedBinaries.piper);
    push(path.join(dir, 'voices'));
    push(dir);
  }
  push(path.join(process.cwd(), 'piper-voices'));
  push(path.join(process.cwd(), 'voices'));
  push(path.join(os.homedir(), 'piper', 'voices'));
  return dirs;
}

function piperModels() {
  const models = [];
  for (const dir of piperVoicesDirs()) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.onnx')) continue;
      const modelPath = path.join(dir, f);
      if (models.some((m) => m.modelPath === modelPath)) continue;
      const base = f.replace(/\.onnx$/, '');
      const m = /^([a-z]{2,3})_([A-Z]{2,4})-(.+)$/.exec(base);
      models.push({
        id: `piper:${base}`,
        engine: 'piper',
        name: base,
        lang: m ? `${m[1]}-${m[2]}` : 'en-US',
        neural: true,
        quality: 5,
        modelPath,
        description: `Piper neural voice “${m ? m[3] : base}”`,
      });
    }
  }
  return models;
}

ENGINES.piper = {
  label: 'Piper neural TTS',
  async available() {
    const exe = await findBinary('piper');
    if (!exe) return false;
    // piper.exe cannot phonemize without the espeak-ng-data folder that ships
    // in its release zip — users who copied the bare exe get instant synth
    // failures. Surface that as a warning (engine still listed, but the app
    // and the console tell the user exactly what is missing).
    const dataDir = path.join(path.dirname(exe), 'espeak-ng-data');
    if (fs.existsSync(dataDir)) delete engineNotes.piper;
    else engineNotes.piper = `piper binary found at ${exe} but its espeak-ng-data folder is missing next to it — extract the FULL piper release zip (piper.exe + all .dll + espeak-ng-data), otherwise every render fails`;
    return piperModels().length > 0;
  },
  async list() { return piperModels(); },
  // Piper ships in two CLI flavors: the classic C++ binary (--output_file,
  // --length_scale) and the newer Python piper1-gpl (--output-file,
  // --length-scale). Try the classic form first, fall back once — and always
  // run with cwd = the binary's folder so its DLLs and espeak-ng-data resolve.
  async synth({ text, rate, modelPath }) {
    const exe = (await findBinary('piper')) || 'piper';
    const outFile = uniqueTemp('wav');
    const model = modelPath || piperModels()[0]?.modelPath;
    if (!model) {
      throw new Error('no Piper .onnx model found — put *.onnx files (with their .onnx.json) in a "voices" folder next to piper.exe or in %USERPROFILE%\\piper\\voices, then restart the bridge');
    }
    const attempts = [
      { out: '--output_file', scale: '--length_scale' },
      { out: '--output-file', scale: '--length-scale' },
    ];
    const errors = [];
    let firstErr = null;
    for (const a of attempts) {
      const args = ['--model', model, a.out, outFile];
      if (rate && Math.abs(rate - 1) > 0.01) args.push(a.scale, String(clamp(1 / clamp(rate, 0.5, 2), 0.5, 2)));
      try {
        await run(exe, args, { input: sanitizeText(text), cwd: path.dirname(exe) });
      } catch (err) {
        if (!firstErr) firstErr = `${a.out}: ${err.message}`;
        errors.push(`${a.out}: ${err.message}`);
        continue;
      }
      if (fs.existsSync(outFile) && fs.statSync(outFile).size >= 44) {
        // Diagnostic gold when the user's piper is the OTHER flavor:
        if (firstErr) log(`piper: fell back to ${a.out} — first attempt failed: ${firstErr}`);
        return outFile;
      }
      errors.push(`${a.out}: exited 0 but produced no audio (model path wrong? unsupported model?)`);
    }
    throw new Error(errors.join(' | '));
  },
};

// ------------------------------------------------------------ engine status

let enginesCache = { at: 0, available: {}, voices: [] };
let refreshInFlight = null;

// Merge order for the combined voice list: better-sounding engines win
// duplicate names (Piper neural > WinRT natural > legacy SAPI > …).
const MERGE_PRIORITY = ['piper', 'winrt', 'sapi', 'say', 'espeak-ng', 'espeak'];

// WHY is an engine false? Static per-engine reasons for the optional /
// platform-specific engines, overridden by live scan diagnostics (engineNotes)
// when we know more. Shown on the console + /ping + /voices so "false" is
// never mysterious.
function engineReason(id) {
  if (id === 'piper') return 'not installed on this machine — optional neural voices; place piper.exe + *.onnx models in C:\\Program Files\\piper or %USERPROFILE%\\piper (see https://github.com/rhasspy/piper)';
  if (engineNotes[id]) return engineNotes[id];
  if (id === 'say' && PLATFORM !== 'darwin') return 'macOS-only engine (Apple Speech `say`) — not applicable on this OS';
  if (id === 'sapi' && PLATFORM !== 'win32') return 'Windows-only engine (System.Speech) — not applicable on this OS';
  if (id === 'winrt' && PLATFORM !== 'win32') return 'Windows-only engine (Windows.Media.SpeechSynthesis) — not applicable on this OS';
  if (id === 'espeak-ng' || id === 'espeak') return 'not installed on this machine — optional; get it from https://github.com/espeak-ng/espeak-ng/releases';
  if (id === 'piper') return 'not installed on this machine — optional neural voices; place piper.exe + *.onnx models in C:\\Program Files\\piper or %USERPROFILE%\\piper (see https://github.com/rhasspy/piper)';
  return 'not available on this machine';
}

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
    // Merge the voice lists with a fixed priority so a voice that two engines
    // both expose (e.g. "Microsoft David" under SAPI and WinRT) is listed
    // once, under the better-sounding engine.
    const seen = new Set();
    const voices = [];
    for (const id of MERGE_PRIORITY) {
      const eng = ENGINES[id];
      if (!eng || !available[id]) continue;
      try {
        for (const v of await eng.list()) {
          const key = String(v.name || '').toLowerCase();
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          voices.push(v);
        }
      } catch (err) {
        log(`voice list for ${id} failed:`, err.message);
      }
    }
    const engineInfo = {};
    for (const id of Object.keys(ENGINES)) {
      engineInfo[id] = available[id]
        ? { available: true, ...(engineNotes[id] ? { warning: engineNotes[id] } : {}) }
        : { available: false, reason: engineReason(id) };
    }
    enginesCache = { at: Date.now(), available, voices, engineInfo };
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
  // platform-native preference order (most realistic first; the OneCore
  // natural voices beat legacy SAPI David/Zira by a wide margin)
  const order = PLATFORM === 'win32' ? ['winrt', 'sapi', 'piper']
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
        engineInfo: enginesCache.engineInfo || undefined,
        voiceCount: enginesCache.voices.length,
        ...(warming ? { warming: true } : {}),
        piperVoicesDir: piperVoicesDir || undefined,
      });
      return;
    }

    if (req.method === 'GET' && route === '/voices') {
      const status = await refreshEngines();
      sendJson(res, 200, { voices: status.voices, engines: status.available, engineInfo: status.engineInfo });
      return;
    }

    if (req.method === 'POST' && route === '/synthesize') {
      await refreshEngines(false);
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = sanitizeText(body.text ?? '');
      if (!text.trim()) { sendJson(res, 400, { error: 'text is required' }); return; }
      if (text.length > MAX_TEXT_CHARS) { sendJson(res, 413, { error: `text exceeds ${MAX_TEXT_CHARS} chars — split it client-side` }); return; }

      // Route by the VOICE first — a known voice name pinpoints exactly one
      // engine, whatever the client asked for. This keeps OLDER deployed app
      // bundles (which hardcode the old engine ids) fully compatible when a
      // new bridge adds engines such as 'winrt'.
      const wanted = typeof body.voice === 'string'
        ? body.voice.replace(/^(sapi|winrt|say|espeak-ng|espeak|piper):/, '').trim()
        : '';
      const voiceRec = wanted
        ? enginesCache.voices.find((v) => String(v.name).toLowerCase() === wanted.toLowerCase())
        : undefined;
      const engineId = voiceRec && ENGINES[voiceRec.engine] && enginesCache.available[voiceRec.engine]
        ? voiceRec.engine
        : pickEngine(body.engine);
      if (!engineId) {
        sendJson(res, 503, { error: 'no OS speech engine available on this machine' });
        return;
      }
      // Piper's model path is engine-owned state: voice records carry it, but
      // OLD deployed app bundles never send it (they only know the voice
      // name). Resolve it HERE from the record we matched — never trust the
      // client, and never hand piper an empty --model.
      let modelPath = typeof body.modelPath === 'string' && body.modelPath && fs.existsSync(body.modelPath)
        ? body.modelPath
        : undefined;
      if (engineId === 'piper') {
        if (voiceRec?.modelPath) modelPath = voiceRec.modelPath;
        else if (!modelPath || !voiceRec) {
          const models = piperModels();
          const byName = wanted ? models.find((m) => m.name === wanted || m.id === `piper:${wanted}`) : undefined;
          modelPath = byName?.modelPath || modelPath || models[0]?.modelPath;
        }
        if (!modelPath) {
          sendJson(res, 503, { error: 'piper is installed but no .onnx voice models were found — put *.onnx files in a "voices" folder next to piper.exe (or %USERPROFILE%\\piper\\voices), then restart the bridge' });
          return;
        }
      }
      const eng = ENGINES[engineId];
      const voice = wanted || undefined;
      log(`synthesize: engine=${engineId} voice=${voice ?? '(default)'}${engineId === 'piper' ? ` model=${modelPath}` : ''} chars=${text.length}`);
      let file;
      try {
        file = await eng.synth({ ...body, text, voice, modelPath });
      } catch (err) {
        // enrich + log so the 500 body (which the app toasts) names the
        // engine and the underlying cause — no more opaque failures
        log(`synthesize failed: engine=${engineId} voice=${voice ?? '(default)'} — ${err.message}`);
        throw new Error(`${engineId} render failed: ${err.message}`);
      }
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
  // v4: ALWAYS explain every "false" — no more silent labels. The reason for
  // winrt comes from the live scan (projection error vs 0 voices installed);
  // the others are static platform/optional-install explanations.
  for (const [id, info] of Object.entries(status.engineInfo || {})) {
    if (!info.available) log(`  ${id}: false — ${info.reason}`);
    else if (info.warning) log(`  ${id}: true, with warning — ${info.warning}`);
  }
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
