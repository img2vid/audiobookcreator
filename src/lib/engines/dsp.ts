// Stub — replaced & expanded by Task 1-a (audio engines agent).
import type { DuckGainPoint } from '@/lib/types';
import { uid } from '@/lib/utils/async';

export interface DspAnalysis {
  peakDb: number;
  rmsDb: number;
  durationSec: number;
  clippingPct: number;
}

function copyTo(ctx: BaseAudioContext, src: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
  for (let c = 0; c < src.numberOfChannels; c++) out.copyToChannel(src.getChannelData(c), c);
  return out;
}

export function analyzeBuffer(b: AudioBuffer): DspAnalysis {
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  let total = 0;
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      sumSq += d[i] * d[i];
      total++;
    }
  }
  const rms = Math.sqrt(sumSq / Math.max(1, total));
  const toDb = (x: number) => 20 * Math.log10(Math.max(1e-6, x));
  return { peakDb: toDb(peak), rmsDb: toDb(rms), durationSec: b.duration, clippingPct: (clipped / Math.max(1, total)) * 100 };
}

export function normalizeBuffer(b: AudioBuffer, targetDb = -1): AudioBuffer {
  const out = copyTo(new OfflineAudioContext(1, 1, b.sampleRate), b);
  let peak = 0;
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  const gain = Math.pow(10, targetDb / 20) / Math.max(1e-6, peak);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= gain;
  }
  return out;
}

export function gainBuffer(b: AudioBuffer, db: number): AudioBuffer {
  const out = copyTo(new OfflineAudioContext(1, 1, b.sampleRate), b);
  const g = Math.pow(10, db / 20);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = Math.max(-1, Math.min(1, d[i] * g));
  }
  return out;
}

// ---------- brush volume envelope ----------
export interface EnvelopePoint { tSec: number; gain: number } // gain 0..2, 1 = unity

/**
 * Canonical form for envelope points: sorted by time, t clamped to
 * [0, durationSec], gain clamped to [0, 2], and points closer than 10 ms
 * together are dropped (the first of a cluster wins). Points that are already
 * in range keep their object identity so UI drag-state can track them across
 * re-normalization.
 */
export function normalizeEnvelopePoints(points: EnvelopePoint[], durationSec: number): EnvelopePoint[] {
  const maxT = Math.max(0, durationSec);
  const prepared = points.map((p) => {
    const tSec = Number.isFinite(p.tSec) ? Math.min(maxT, Math.max(0, p.tSec)) : 0;
    const gain = Number.isFinite(p.gain) ? Math.min(2, Math.max(0, p.gain)) : 1;
    if (tSec === p.tSec && gain === p.gain) return p;
    return { tSec, gain };
  });
  prepared.sort((a, b) => a.tSec - b.tSec);
  const out: EnvelopePoint[] = [];
  for (const p of prepared) {
    if (out.length > 0 && p.tSec - out[out.length - 1].tSec < 0.01) continue; // < 10 ms apart → drop (keep first)
    out.push(p);
  }
  return out;
}

/**
 * Apply a piecewise-LINEAR volume envelope to a copy of the buffer.
 * Gain is implicitly 1 before the first point and after the last point; between
 * consecutive points it ramps linearly. Output samples are clamped to [-1, 1].
 * Gain is computed per sample by WALKING the segment list per channel (no
 * per-sample binary search) so hour-long renders stay fast.
 */
export function applyVolumeEnvelope(b: AudioBuffer, points: EnvelopePoint[]): AudioBuffer {
  const out = copyTo(new OfflineAudioContext(1, 1, b.sampleRate), b);
  const pts = normalizeEnvelopePoints(points, b.duration);
  if (pts.length === 0) return out; // unity everywhere — nothing to do
  const sr = b.sampleRate;
  const len = out.length;
  // Sample-space segment list, built once:
  //   [0, s0)       → constant 1  (implicit, before the first point)
  //   [s_i, s_i+1)  → linear ramp pts[i].gain → pts[i+1].gain
  //   [s_last, len) → constant 1  (implicit, after the last point)
  const segs: { start: number; end: number; g0: number; g1: number }[] = [];
  const s0 = Math.min(len, Math.round(pts[0].tSec * sr));
  if (s0 > 0) segs.push({ start: 0, end: s0, g0: 1, g1: 1 });
  let cursor = s0;
  let prevGain = pts[0].gain;
  for (let i = 1; i < pts.length; i++) {
    const s = Math.min(len, Math.round(pts[i].tSec * sr));
    if (s > cursor) {
      segs.push({ start: cursor, end: s, g0: prevGain, g1: pts[i].gain });
      cursor = s;
    }
    prevGain = pts[i].gain;
  }
  if (cursor < len) segs.push({ start: cursor, end: len, g0: 1, g1: 1 });
  if (segs.length === 0) return out; // every point sits at/after the buffer end

  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    let seg = segs[0];
    let si = 0;
    let span = seg.end - seg.start;
    for (let i = 0; i < len; i++) {
      while (i >= seg.end && si < segs.length - 1) {
        si++;
        seg = segs[si];
        span = seg.end - seg.start;
      }
      const g = span > 0 ? seg.g0 + ((seg.g1 - seg.g0) * (i - seg.start)) / span : seg.g1;
      const v = d[i] * g;
      d[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }
  return out;
}

export function fadeBuffer(b: AudioBuffer, inSec: number, outSec: number): AudioBuffer {
  const out = copyTo(new OfflineAudioContext(1, 1, b.sampleRate), b);
  const inN = Math.floor(inSec * b.sampleRate);
  const outN = Math.floor(outSec * b.sampleRate);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = 0; i < inN && i < d.length; i++) d[i] *= i / inN;
    for (let i = 0; i < outN && i < d.length; i++) d[d.length - 1 - i] *= i / outN;
  }
  return out;
}

export function trimSilenceBuffer(b: AudioBuffer, thresholdDb = -45, padMs = 120): AudioBuffer {
  const thr = Math.pow(10, thresholdDb / 20);
  const pad = Math.floor((padMs / 1000) * b.sampleRate);
  let start = 0;
  let end = b.length - 1;
  const d0 = b.getChannelData(0);
  const loud = (i: number) => {
    for (let c = 0; c < b.numberOfChannels; c++) if (Math.abs(b.getChannelData(c)[i]) > thr) return true;
    return false;
  };
  while (start < d0.length && !loud(start)) start++;
  while (end > start && !loud(end)) end--;
  start = Math.max(0, start - pad);
  end = Math.min(b.length - 1, end + pad);
  const len = Math.max(1, end - start + 1);
  const ctx = new OfflineAudioContext(b.numberOfChannels, len, b.sampleRate);
  const out = ctx.createBuffer(b.numberOfChannels, len, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) {
    out.copyToChannel(b.getChannelData(c).slice(start, start + len), c);
  }
  return out;
}

export function reverseBuffer(b: AudioBuffer): AudioBuffer {
  const ctx = new OfflineAudioContext(b.numberOfChannels, b.length, b.sampleRate);
  const out = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const src = b.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0, j = src.length - 1; i < src.length; i++, j--) dst[j] = src[i];
  }
  return out;
}

export function toMono(b: AudioBuffer): AudioBuffer {
  if (b.numberOfChannels === 1) return b;
  const ctx = new OfflineAudioContext(1, b.length, b.sampleRate);
  const out = ctx.createBuffer(1, b.length, b.sampleRate);
  const d = out.getChannelData(0);
  for (let i = 0; i < b.length; i++) {
    let s = 0;
    for (let c = 0; c < b.numberOfChannels; c++) s += b.getChannelData(c)[i];
    d[i] = s / b.numberOfChannels;
  }
  return out;
}

export function removeDcOffset(b: AudioBuffer): AudioBuffer {
  const ctx = new OfflineAudioContext(1, 1, b.sampleRate);
  const out = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const src = b.getChannelData(c);
    let mean = 0;
    for (let i = 0; i < src.length; i++) mean += src[i];
    mean /= Math.max(1, src.length);
    const d = out.getChannelData(c);
    for (let i = 0; i < src.length; i++) d[i] = Math.max(-1, Math.min(1, src[i] - mean));
  }
  return out;
}

export async function changeSpeedBuffer(b: AudioBuffer, factor: number): Promise<AudioBuffer> {
  if (factor === 1) return b;
  const len = Math.ceil(b.length / factor);
  const ctx = new OfflineAudioContext(b.numberOfChannels, len, b.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.playbackRate.value = factor;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

export async function concatenateBuffers(buffers: AudioBuffer[], gapSec = 0): Promise<AudioBuffer> {
  const valid = buffers.filter(Boolean);
  if (valid.length === 0) throw new Error('No buffers to concatenate');
  const sr = valid[0].sampleRate;
  const ch = valid[0].numberOfChannels;
  const gapN = Math.floor(gapSec * sr);
  const total = valid.reduce((a, b) => a + b.length + gapN, 0);
  const ctx = new OfflineAudioContext(ch, Math.max(1, total), sr);
  const out = ctx.createBuffer(ch, Math.max(1, total), sr);
  let off = 0;
  for (const b of valid) {
    for (let c = 0; c < ch; c++) {
      out.getChannelData(c).set(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), off);
    }
    off += b.length + gapN;
  }
  void ctx;
  return out;
}

/** Extract a time region [startSec, endSec) as a new AudioBuffer (all channels preserved). */
export function sliceBuffer(b: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const sr = b.sampleRate;
  const s = Math.max(0, Math.min(b.length, Math.floor(startSec * sr)));
  const e = Math.max(s, Math.min(b.length, Math.ceil(endSec * sr)));
  const len = Math.max(1, e - s);
  const ctx = new OfflineAudioContext(b.numberOfChannels, len, sr);
  const out = ctx.createBuffer(b.numberOfChannels, len, sr);
  for (let c = 0; c < b.numberOfChannels; c++) {
    out.getChannelData(c).set(b.getChannelData(c).subarray(s, e));
  }
  void ctx;
  return out;
}

export function makeSilenceBuffer(seconds: number, sampleRate = 44100, channels: 1 | 2 = 1): AudioBuffer {
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.floor(seconds * sampleRate)), sampleRate);
  return ctx.createBuffer(channels, Math.max(1, Math.floor(seconds * sampleRate)), sampleRate);
}

// ---------- 3-band EQ ----------
export interface EqSettings {
  lowDb: number;   // low shelf @ 180 Hz
  midDb: number;   // peaking @ midFreqHz
  highDb: number;  // high shelf @ 3800 Hz
  midFreqHz?: number;
}

/** Voice-oriented EQ presets (values in dB). */
export const EQ_PRESETS: { id: string; name: string; description: string; eq: EqSettings }[] = [
  { id: 'natural', name: 'Natural', description: 'Untouched synthesis tone', eq: { lowDb: 0, midDb: 0, highDb: 0 } },
  { id: 'podcast', name: 'Podcast', description: 'Warm lows, present mids — classic spoken word', eq: { lowDb: 2.5, midDb: 2, highDb: -1 } },
  { id: 'radio', name: 'Broadcast', description: 'Bright presence cut for narration', eq: { lowDb: -1.5, midDb: 3.5, highDb: 1.5 } },
  { id: 'warm', name: 'Warm analog', description: 'Soft top end, gentle low lift', eq: { lowDb: 3, midDb: -0.5, highDb: -3.5 } },
  { id: 'bright', name: 'Bright & airy', description: 'Crisp consonants, clearer sibilance', eq: { lowDb: -1, midDb: 0.5, highDb: 4 } },
  { id: 'telephone', name: 'Telephone', description: 'Narrow band, vintage call effect', eq: { lowDb: -14, midDb: 6, highDb: -10, midFreqHz: 1800 } },
  { id: 'megaphone', name: 'Megaphone', description: 'Aggressive mid honk', eq: { lowDb: -18, midDb: 9, highDb: -14, midFreqHz: 2500 } },
];

/**
 * Render the buffer through a 3-band EQ (low shelf / peaking / high shelf)
 * using an OfflineAudioContext — real biquad filters, sample-accurate.
 */
export async function eqBuffer(b: AudioBuffer, eq: EqSettings): Promise<AudioBuffer> {
  const flat = eq.lowDb === 0 && eq.midDb === 0 && eq.highDb === 0;
  if (flat) return b;
  const ctx = new OfflineAudioContext(b.numberOfChannels, b.length, b.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = b;
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 180;
  low.gain.value = eq.lowDb;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = eq.midFreqHz ?? 1200;
  mid.Q.value = 0.9;
  mid.gain.value = eq.midDb;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 3800;
  high.gain.value = eq.highDb;
  src.connect(low).connect(mid).connect(high).connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

export interface CompressorSettings {
  thresholdDb: number;
  ratio: number;
  attackSec: number;
  releaseSec: number;
  makeupDb?: number;
}

/**
 * Dynamics compressor (soft-knee) with optional makeup gain — evens out the
 * dynamic range of spoken audio so quiet words stay intelligible.
 */
export async function compressBuffer(b: AudioBuffer, c: CompressorSettings): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(b.numberOfChannels, b.length, b.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = b;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = c.thresholdDb;
  comp.ratio.value = c.ratio;
  comp.attack.value = c.attackSec;
  comp.release.value = c.releaseSec;
  comp.knee.value = 12;
  src.connect(comp);
  if (c.makeupDb) {
    const makeup = ctx.createGain();
    makeup.gain.value = Math.pow(10, c.makeupDb / 20);
    comp.connect(makeup).connect(ctx.destination);
  } else {
    comp.connect(ctx.destination);
  }
  src.start();
  return ctx.startRendering();
}

// ---------- music bed with auto-ducking ----------

/** Mono-mixed RMS level per time hop (default 100 Hz → 10 ms windows). Cheap single pass. */
export function computeRmsLevels(b: AudioBuffer, hopsPerSec = 100): Float32Array {
  const win = Math.max(1, Math.round(b.sampleRate / Math.max(1, hopsPerSec)));
  const hops = Math.max(1, Math.ceil(b.length / win));
  const out = new Float32Array(hops);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[(i / win) | 0] += d[i] * d[i];
  }
  const chans = Math.max(1, b.numberOfChannels);
  for (let h = 0; h < hops; h++) {
    const n = Math.min(win, b.length - h * win); // last window is usually short
    out[h] = Math.sqrt(out[h] / Math.max(1, n * chans));
  }
  return out;
}

export interface DuckOptions {
  amount: number; // 0..1 — how deep the bed dips while narration is active (1 = silent)
  attackMs: number; // duck-in speed
  releaseMs: number; // duck-out recovery
  /** Voice-active threshold as a fraction of peak RMS (default 0.35). */
  thresholdScale?: number;
  /**
   * Manual duck-gain automation points (see `DuckGainPoint`). When at least one
   * point is present the envelope TARGET at time t becomes the piecewise-linear
   * interpolation of the points sorted by `t` — clamped constant to the first
   * point's depth before it and to the last point's depth after it — and the
   * voice-sidechain `amount` is ignored entirely (the user has taken manual
   * control of the curve; `depth` is the envelope GAIN the bed settles to near
   * that time, so 1 = full bed, 0 = silent). The attack/release one-pole
   * smoothing STILL applies on top of the point-driven target exactly as it
   * does for the sidechain target, so point ramps stay smooth. With 0 points
   * (or undefined) behavior is byte-identical to the pre-points implementation.
   */
  gainPoints?: DuckGainPoint[];
}

/**
 * Normalized gain-point curve shared by `computeDuckEnvelope` and
 * `smoothDuckGains`: points sorted by `t` (finite values only, `t` clamped to
 * ≥ 0, `depth` clamped to [0, 1]) plus the per-segment slope of the piecewise
 * interpolation so the hot loops never divide. Returns null for empty/undefined
 * input so callers fall through to the legacy `amount` path untouched. One
 * allocation per CALL (never per sample), proportional to the point count.
 */
function normalizeDuckGainPoints(points: DuckGainPoint[] | undefined): {
  t: Float64Array;
  d: Float64Array;
  slope: Float64Array;
  n: number;
} | null {
  if (!points || points.length === 0) return null;
  const clean = points
    .filter((p) => Boolean(p) && Number.isFinite(p.t) && Number.isFinite(p.depth))
    .map((p) => ({ t: Math.max(0, p.t), d: Math.min(1, Math.max(0, p.depth)) }))
    .sort((a, b) => a.t - b.t);
  const n = clean.length;
  if (!n) return null;
  const t = new Float64Array(n);
  const d = new Float64Array(n);
  const slope = new Float64Array(Math.max(0, n - 1));
  for (let i = 0; i < n; i++) {
    t[i] = clean[i].t;
    d[i] = clean[i].d;
  }
  for (let i = 0; i + 1 < n; i++) {
    const dt = t[i + 1] - t[i];
    slope[i] = dt > 1e-9 ? (d[i + 1] - d[i]) / dt : 0; // duplicate-t points: the later one wins via the cursor advance
  }
  return { t, d, slope, n };
}

/**
 * RMS sidechain-duck envelope for a music bed under a narration (voice) buffer.
 *
 * Pipeline: ~20 ms RMS windows → threshold = peakRMS × thresholdScale → per-window
 * target (1 − amount when voice is active, else 1) → per-sample one-pole smoothing
 * toward the target (attack coefficient while dipping, release while recovering).
 *
 * Yield-safety: chosen "fast enough" over chunking — the function is synchronous
 * (returns Float32Array) and does exactly two O(n) passes with no per-sample
 * allocation. Measured in Bun/V8: ~80 ms for a 3-minute 48 kHz mono buffer
 * (linear in duration — ~0.5 s for an hour), so it belongs in queue jobs (the
 * export mixdown), never in rAF or effect bodies. Preview canvases should use
 * the hop-rate sibling `smoothDuckGains` over cached `computeRmsLevels` output
 * instead. The output has exactly `length` samples at `sampleRate` (the mix
 * timeline), independent of the voice buffer's own length/rate — samples past
 * the end of the voice count as "no narration" (gain returns to 1).
 *
 * Gain points: when `opts.gainPoints` holds ≥ 1 point the voice sidechain is
 * bypassed (the RMS pass is skipped) and the target becomes the clamped
 * piecewise-linear interpolation of the points at each mix sample — attack/
 * release smoothing still applies toward that target. The voice buffer may
 * then even be empty; the points alone define the envelope.
 */
export function computeDuckEnvelope(
  voice: AudioBuffer,
  length: number,
  sampleRate: number,
  opts: DuckOptions,
): Float32Array {
  const len = Math.max(1, Math.floor(length) || 1);
  const env = new Float32Array(len);
  const amount = Math.min(1, Math.max(0, Number.isFinite(opts.amount) ? opts.amount : 0.7));
  const win = Math.max(1, Math.round(sampleRate * 0.02)); // ~20 ms analysis window

  // Shared one-pole coefficients (identical expressions as the legacy path —
  // hoisted so both the gain-point walk and the sidechain walk reuse them).
  const atk = 1 - Math.exp(-1 / Math.max(1e-4, (Math.max(1, opts.attackMs) / 1000) * sampleRate));
  const rel = 1 - Math.exp(-1 / Math.max(1e-4, (Math.max(1, opts.releaseMs) / 1000) * sampleRate));

  // Manual gain-point automation — replaces the sidechain target entirely.
  // Cursor walk over the sorted points: one amortized compare per sample plus
  // one multiply-add; no allocations, fully deterministic.
  const pts = normalizeDuckGainPoints(opts.gainPoints);
  if (pts) {
    const { t: ptT, d: ptD, slope: ptS, n } = pts;
    const invSr = 1 / Math.max(1, sampleRate);
    let g = 1;
    let cur = -1; // index of the last point with t <= current time (-1 = before the first)
    for (let i = 0; i < len; i++) {
      const tt = i * invSr;
      while (cur + 1 < n && ptT[cur + 1] <= tt) cur++;
      const target = cur < 0 ? ptD[0] : cur >= n - 1 ? ptD[n - 1] : ptD[cur] + (tt - ptT[cur]) * ptS[cur];
      const coef = target < g ? atk : rel;
      g += (target - g) * coef;
      env[i] = g;
    }
    return env;
  }

  if (!voice || voice.length === 0 || amount <= 0) {
    env.fill(1);
    return env;
  }

  // 1) windowed RMS (mono-mixed across channels) + peak
  const hops = Math.max(1, Math.ceil(voice.length / win));
  const sq = new Float32Array(hops);
  for (let c = 0; c < voice.numberOfChannels; c++) {
    const d = voice.getChannelData(c);
    for (let i = 0; i < d.length; i++) sq[(i / win) | 0] += d[i] * d[i];
  }
  const chans = Math.max(1, voice.numberOfChannels);
  let peak = 0;
  const rms = new Float32Array(hops);
  for (let h = 0; h < hops; h++) {
    const n = Math.min(win, voice.length - h * win);
    const r = Math.sqrt(sq[h] / Math.max(1, n * chans));
    rms[h] = r;
    if (r > peak) peak = r;
  }
  const threshold = peak * (opts.thresholdScale ?? 0.35);
  const ducked = 1 - amount;

  // 2) per-sample one-pole toward the per-window target. The target only changes
  //    on window boundaries, so the branch (attack vs release coefficient) is
  //    hoisted out of the inner loop: one compare + one multiply-add per sample.
  //    `next` is the first mix sample index that falls into hop hi+1.
  const step = (voice.sampleRate / sampleRate) / win; // hops per mix sample
  let g = 1;
  let hi = 0;
  let target = hi < hops && rms[hi] > threshold ? ducked : 1;
  let coef = target < g ? atk : rel;
  let next = Math.ceil(1 / step);
  for (let i = 0; i < len; i++) {
    if (i >= next) {
      hi++;
      target = hi < hops && rms[hi] > threshold ? ducked : 1;
      coef = target < g ? atk : rel;
      next = Math.ceil((hi + 1) / step);
    }
    g += (target - g) * coef;
    env[i] = g;
  }
  return env;
}

/**
 * Hop-rate sibling of `computeDuckEnvelope` for preview canvases: identical
 * targeting + one-pole smoothing math, but walked over pre-computed RMS levels
 * (see `computeRmsLevels`) at `hopsPerSec` instead of audio rate. A 30 ms attack
 * spans ~3 hops at 100 Hz, so the shape is visually identical — and the walk is
 * microseconds even for hour-long material, making it safe for debounced
 * settings-driven redraws.
 *
 * Gain points: with ≥ 1 `opts.gainPoints` entry the sidechain is bypassed here
 * too and each hop's target is the clamped point interpolation at t = i/hz —
 * exactly what `computeDuckEnvelope` targets per sample, so a preview drawn
 * from this function matches the export mix sample-for-sample (modulo hop
 * quantization).
 */
export function smoothDuckGains(levels: Float32Array, hopsPerSec: number, opts: DuckOptions): Float32Array {
  const out = new Float32Array(levels.length);
  if (!levels.length) return out;
  const hz = Math.max(1, hopsPerSec);
  const atk = 1 - Math.exp(-1 / Math.max(1e-4, (Math.max(1, opts.attackMs) / 1000) * hz));
  const rel = 1 - Math.exp(-1 / Math.max(1e-4, (Math.max(1, opts.releaseMs) / 1000) * hz));
  const pts = normalizeDuckGainPoints(opts.gainPoints);
  if (pts) {
    const { t: ptT, d: ptD, slope: ptS, n } = pts;
    let g = 1;
    let cur = -1;
    for (let i = 0; i < levels.length; i++) {
      const tt = i / hz;
      while (cur + 1 < n && ptT[cur + 1] <= tt) cur++;
      const target = cur < 0 ? ptD[0] : cur >= n - 1 ? ptD[n - 1] : ptD[cur] + (tt - ptT[cur]) * ptS[cur];
      const coef = target < g ? atk : rel;
      g += (target - g) * coef;
      out[i] = g;
    }
    return out;
  }
  const amount = Math.min(1, Math.max(0, Number.isFinite(opts.amount) ? opts.amount : 0.7));
  if (amount <= 0) {
    out.fill(1);
    return out;
  }
  let peak = 0;
  for (let i = 0; i < levels.length; i++) if (levels[i] > peak) peak = levels[i];
  const threshold = peak * (opts.thresholdScale ?? 0.35);
  const ducked = 1 - amount;
  let g = 1;
  for (let i = 0; i < levels.length; i++) {
    const target = levels[i] > threshold ? ducked : 1;
    g += (target - g) * (target < g ? atk : rel);
    out[i] = g;
  }
  return out;
}

export interface MusicBedMixOptions {
  volume: number; // 0..1 bed level
  loop: boolean; // loop the bed to fill the voice length
  duck: boolean; // apply the sidechain duck envelope
  duckAmount: number; // 0..1
  attackMs: number;
  releaseMs: number;
  /** Pre-computed duck envelope (skip recomputation when the caller already has one). */
  duckEnvelope?: Float32Array;
  /**
   * Manual duck-gain automation points (forwarded to `computeDuckEnvelope`).
   * When ≥ 1 point is present any pre-computed `duckEnvelope` is IGNORED and
   * the envelope is recomputed from the points — callers that precomputed
   * against amount-only settings (e.g. the export's `bakeMusicBed`) still get
   * point-accurate output, keeping preview and export identical.
   */
  gainPoints?: DuckGainPoint[];
}

/**
 * Mix a music bed UNDER a narration buffer, returning a new AudioBuffer of the
 * voice's length/rate: out = clamp(voice + bed × volume × duckEnv, [-1, 1]).
 * The bed is trimmed/looped to the voice length (loop wraps sample-exactly) and
 * linearly resampled when its sample rate differs. Channel count is the max of
 * both inputs (mono sources duplicate into stereo).
 *
 * Yield-safety: implemented as a MANUAL sample loop instead of an
 * OfflineAudioContext render graph — synchronous, deterministic and testable
 * headlessly, with full-rate envelope accuracy (no 100 Hz curve quantization).
 * One O(length × channels) pass — measured ~150 ms for 3 min mono in Bun (linear
 * in duration) — so callers must run it inside queue jobs (preview mix / export),
 * never per frame.
 */
export function mixMusicBed(voice: AudioBuffer, bed: AudioBuffer, opts: MusicBedMixOptions): AudioBuffer {
  if (!voice || voice.length === 0) throw new Error('mixMusicBed: voice buffer is empty');
  if (!bed || bed.length === 0) throw new Error('mixMusicBed: music bed buffer is empty');
  const sr = voice.sampleRate;
  const len = Math.max(1, voice.length);
  const ch = Math.max(1, Math.min(32, Math.max(voice.numberOfChannels, bed.numberOfChannels)));
  const ctx = new OfflineAudioContext(ch, len, sr);
  const out = ctx.createBuffer(ch, len, sr);

  const env = opts.duck
    ? opts.gainPoints && opts.gainPoints.length > 0
      ? computeDuckEnvelope(voice, len, sr, { amount: opts.duckAmount, attackMs: opts.attackMs, releaseMs: opts.releaseMs, gainPoints: opts.gainPoints })
      : opts.duckEnvelope ??
        computeDuckEnvelope(voice, len, sr, { amount: opts.duckAmount, attackMs: opts.attackMs, releaseMs: opts.releaseMs })
    : null;
  const vol = Math.min(1, Math.max(0, Number.isFinite(opts.volume) ? opts.volume : 0.25));
  const ratio = bed.sampleRate / sr;
  const blen = bed.length;
  const vCh = voice.numberOfChannels;
  const bCh = bed.numberOfChannels;
  const loop = opts.loop;

  for (let c = 0; c < ch; c++) {
    const o = out.getChannelData(c);
    const vd = voice.getChannelData(Math.min(c, vCh - 1));
    const bd = bed.getChannelData(Math.min(c, bCh - 1));
    for (let i = 0; i < len; i++) {
      let pos = ratio === 1 ? i : i * ratio;
      if (loop && blen > 0) pos = pos % blen;
      let bs = 0;
      if (blen > 0 && pos < blen) {
        const i0 = pos | 0;
        const frac = ratio === 1 ? 0 : pos - i0;
        const s0 = bd[i0];
        const s1 = i0 + 1 < blen ? bd[i0 + 1] : loop ? bd[0] : s0;
        bs = s0 + (s1 - s0) * frac;
      } // !loop && pos ≥ bed length → the bed has finished: silence
      const g = vol * (env ? env[i] : 1);
      const v = vd[i] + bs * g;
      o[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }
  return out;
}

/** One-click "master" preset for spoken word: gentle compression + podcast EQ. */
export const VOICE_MASTER_COMPRESSOR: CompressorSettings = {
  thresholdDb: -24, ratio: 3.5, attackSec: 0.008, releaseSec: 0.18, makeupDb: 2,
};

export function bufferId(): string {
  return uid('dsp');
}
