// ============================================================
// OS Speech Bridge — client side.
// Talks to the zero-dependency local companion server
// (scripts/os-tts-server.mjs, `npm run os-tts`) that renders WAV files
// with the ESTABLISHED speech engine installed with the operating system:
//   Windows → SAPI 5 (System.Speech)   macOS → Apple Speech (`say`)
//   Linux   → espeak-ng / espeak       any OS → Piper neural voices
//
// The browser alone can synthesize OS voices for live preview (Web Speech
// API) but CANNOT capture them into a file — this bridge is what makes
// “the selected OS engine actually renders the export” possible.
// ============================================================
import type { OsTtsBridgeStatus, OsTtsEngineId, OsTtsVoiceDef } from '@/lib/types';

const BRIDGE_URL_KEY = 'os-tts-bridge-url';
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8477';

/**
 * Accept loose human input ("127.0.0.1", "localhost", "localhost:8477") and
 * turn it into a full bridge URL. Bare loopback hosts get the default port.
 */
export function normalizeBridgeUrl(input: string): string {
  let v = input.trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  try {
    const u = new URL(v);
    if (!u.port && /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) {
      u.port = '8477';
    }
    return u.toString().replace(/\/+$/, '');
  } catch {
    return v;
  }
}

/** User-configurable bridge URL (localStorage; falls back to the default). */
export function getBridgeUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_BRIDGE_URL;
  try {
    const v = window.localStorage.getItem(BRIDGE_URL_KEY);
    return v && /^https?:\/\//i.test(v) ? v.replace(/\/+$/, '') : DEFAULT_BRIDGE_URL;
  } catch {
    return DEFAULT_BRIDGE_URL;
  }
}

export function setBridgeUrl(url: string): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = normalizeBridgeUrl(url);
    if (!clean || clean === DEFAULT_BRIDGE_URL) window.localStorage.removeItem(BRIDGE_URL_KEY);
    else window.localStorage.setItem(BRIDGE_URL_KEY, clean);
  } catch { /* private mode — ignore */ }
}

// ---------- capability table ----------
export interface OsEngineCaps {
  label: string;
  /** Supported parameter dimensions (unsupported ones are ignored/applied client-side). */
  rate: boolean;
  pitch: boolean;
  volume: boolean;
}

export const OS_ENGINE_CAPS: Record<OsTtsEngineId, OsEngineCaps> = {
  sapi: { label: 'Windows SAPI 5', rate: true, pitch: true, volume: true },
  say: { label: 'macOS Apple Speech', rate: true, pitch: false, volume: false },
  'espeak-ng': { label: 'espeak-ng', rate: true, pitch: true, volume: true },
  espeak: { label: 'espeak', rate: true, pitch: true, volume: true },
  piper: { label: 'Piper neural', rate: true, pitch: false, volume: false },
};

// ---------- probing ----------

export interface ProbeResult {
  status: OsTtsBridgeStatus;
  voices: OsTtsVoiceDef[];
}

let cached: { at: number; result: ProbeResult } | null = null;
let inFlight: Promise<ProbeResult> | null = null;
const CACHE_MS = 20_000;

/** Invalidate the cached bridge probe (used after a manual retry). */
export function invalidateBridgeCache(): void {
  cached = null;
}

/**
 * Probe the local bridge server. Never throws — a missing bridge resolves to
 * `{ ok: false }` so callers can degrade to the bundled engine with a clear
 * reason instead of an unhandled error.
 */
export async function probeOsTtsBridge(force = false): Promise<ProbeResult> {
  const url = getBridgeUrl();
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.result;
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<ProbeResult> => {
    try {
      const ctrl = new AbortController();
      // 10 s: a cold bridge answers /ping instantly, but on some Windows boxes
      // even process startup can lag — do not give up before it had a chance.
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`${url}/ping`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`bridge /ping → HTTP ${res.status}`);
      const info = (await res.json()) as {
        ok?: boolean; platform?: string; engines?: Record<string, boolean>; voiceCount?: number;
      };
      const status: OsTtsBridgeStatus = {
        url,
        ok: !!info.ok,
        platform: info.platform,
        engines: info.engines as OsTtsBridgeStatus['engines'],
        voiceCount: info.voiceCount,
      };
      let voices: OsTtsVoiceDef[] = [];
      if (status.ok) {
        try {
          const vres = await fetch(`${url}/voices`, { cache: 'no-store' });
          if (vres.ok) {
            const data = (await vres.json()) as { voices?: OsTtsVoiceDef[] };
            voices = Array.isArray(data.voices) ? data.voices : [];
          }
        } catch { /* voices listing is best-effort */ }
      }
      const result: ProbeResult = { status, voices };
      cached = { at: Date.now(), result };
      return result;
    } catch (err) {
      const result: ProbeResult = {
        status: { url, ok: false, error: err instanceof Error ? err.message : String(err) },
        voices: [],
      };
      cached = { at: Date.now(), result };
      return result;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// ---------- WAV decoding (manual parse — deterministic across browsers) ----

interface WavInfo {
  sampleRate: number;
  channels: number;
  float32: Float32Array<ArrayBuffer>[]; // per channel
}

/** Parse a RIFF/WAVE file (PCM 8/16/24/32-bit int or 32-bit float). */
export function parseWav(buffer: ArrayBuffer): WavInfo {
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  if (buffer.byteLength < 44 || String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'RIFF' ||
    String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let off = 12;
  let format = 1;
  let channels = 1;
  let sampleRate = 22050;
  let bits = 16;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= view.byteLength) {
    const id = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      format = view.getUint16(off + 8, true);
      channels = Math.max(1, view.getUint16(off + 10, true));
      sampleRate = view.getUint32(off + 12, true) || 22050;
      bits = view.getUint16(off + 22, true) || 16;
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = Math.min(size, view.byteLength - dataOff);
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) throw new Error('WAV has no data chunk');
  const bytesPer = Math.max(1, bits >> 3);
  const frames = Math.floor(dataLen / (bytesPer * channels));
  const out: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * bytesPer;
      let v = 0;
      if (format === 3 && bits === 32) v = view.getFloat32(p, true);
      else if (bits === 8) v = (view.getUint8(p) - 128) / 128; // unsigned
      else if (bits === 16) v = view.getInt16(p, true) / 32768;
      else if (bits === 24) {
        const b0 = u8[p], b1 = u8[p + 1], b2 = u8[p + 2];
        let iv = (b2 << 16) | (b1 << 8) | b0;
        if (iv & 0x800000) iv -= 0x1000000;
        v = iv / 8388608;
      } else if (bits === 32) v = view.getInt32(p, true) / 2147483648;
      out[c][i] = v;
    }
  }
  return { sampleRate, channels, float32: out };
}

/** Build an AudioBuffer from raw WAV bytes at the WAV's own sample rate. */
export function wavToAudioBuffer(buffer: ArrayBuffer): AudioBuffer {
  const info = parseWav(buffer);
  const ctx = new OfflineAudioContext(info.channels, Math.max(1, info.float32[0].length), info.sampleRate);
  const out = ctx.createBuffer(info.channels, info.float32[0].length, info.sampleRate);
  for (let c = 0; c < info.channels; c++) out.copyToChannel(info.float32[c], c);
  return out;
}

// ---------- synthesis ----------

export interface OsSynthRequest {
  /** Engine id ('sapi' | 'say' | 'espeak-ng' | 'espeak' | 'piper'). Omit → server picks the platform default. */
  engine?: OsTtsEngineId;
  /** Engine-specific voice name (server strips the `engine:` prefix). */
  voice?: string;
  text: string;
  /** Multiplier (1 = normal). */
  rate?: number;
  pitch?: number;
  volume?: number;
}

export interface OsSynthResult {
  buffer: AudioBuffer;
  /** Engine that actually rendered (echoed back by the server). */
  engine?: string;
}

/** Synthesize one chunk through the bridge and decode the returned WAV. Throws on failure. */
export async function synthesizeViaBridge(req: OsSynthRequest, timeoutMs = 120_000): Promise<OsSynthResult> {
  const url = getBridgeUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let msg = `bridge /synthesize → HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) msg = j.error;
      } catch { /* body was not JSON */ }
      throw new Error(msg);
    }
    const ab = await res.arrayBuffer();
    return { buffer: wavToAudioBuffer(ab), engine: res.headers.get('X-OS-TTS-Engine') ?? undefined };
  } finally {
    clearTimeout(timer);
  }
}
