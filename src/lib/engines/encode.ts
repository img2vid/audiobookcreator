// ============================================================
// Openmukti Audiobook Creator — audio encoding engine
// 39 REAL, fully in-browser encoders: WAV family, RF64, AIFF/AIFC,
// Au/SND, CAF, headerless RAW, plus MediaRecorder compressed exports
// (WebM Opus / MP4 AAC / Ogg Opus — browser-native, no libraries).
// ============================================================
import type { AudioFormatId, EncodeOptions, FormatDescriptor } from '@/lib/types';
import { yieldToUI } from '@/lib/utils/async';

/** TS 5.7 BlobPart strictness shim — Uint8Array is a valid BlobPart at runtime. */
const asPart = (u: Uint8Array): BlobPart => u as unknown as BlobPart;

// ---------- format registry ----------
export const AUDIO_FORMATS: FormatDescriptor[] = [
  { id: 'wav-8', label: 'WAV PCM 8-bit', container: 'RIFF/WAV', encoding: 'PCM (unsigned)', bitDepth: '8-bit', lossless: true, native: true, mime: 'audio/wav', extension: 'wav' },
  { id: 'wav-16', label: 'WAV PCM 16-bit', container: 'RIFF/WAV', encoding: 'PCM', bitDepth: '16-bit', lossless: true, native: true, mime: 'audio/wav', extension: 'wav' },
  { id: 'wav-24', label: 'WAV PCM 24-bit', container: 'RIFF/WAV', encoding: 'PCM', bitDepth: '24-bit', lossless: true, native: true, mime: 'audio/wav', extension: 'wav' },
  { id: 'wav-32', label: 'WAV PCM 32-bit', container: 'RIFF/WAV', encoding: 'PCM', bitDepth: '32-bit', lossless: true, native: true, mime: 'audio/wav', extension: 'wav' },
  { id: 'wav-32f', label: 'WAV IEEE Float 32-bit', container: 'RIFF/WAV', encoding: 'IEEE Float', bitDepth: '32-bit float', lossless: true, native: true, mime: 'audio/wav', extension: 'wav' },
  { id: 'wav-64f', label: 'WAV IEEE Float 64-bit', container: 'RIFF/WAV', encoding: 'IEEE Float', bitDepth: '64-bit float', lossless: true, native: true, mime: 'audio/wav', extension: 'wav' },
  { id: 'wav-ulaw', label: 'WAV μ-law (G.711)', container: 'RIFF/WAV', encoding: 'μ-law', bitDepth: '8-bit comp', lossless: false, native: true, mime: 'audio/wav', extension: 'wav' },
  { id: 'wav-alaw', label: 'WAV A-law (G.711)', container: 'RIFF/WAV', encoding: 'A-law', bitDepth: '8-bit comp', lossless: false, native: true, mime: 'audio/wav', extension: 'wav' },
  { id: 'wav-adpcm', label: 'WAV IMA ADPCM 4-bit', container: 'RIFF/WAV', encoding: 'IMA ADPCM', bitDepth: '4-bit', lossless: false, native: true, mime: 'audio/wav', extension: 'wav' },
  { id: 'rf64-16', label: 'RF64 (BWF) PCM 16-bit', container: 'RF64', encoding: 'PCM', bitDepth: '16-bit', lossless: true, native: true, mime: 'audio/wav', extension: 'rf64' },
  { id: 'aiff-8', label: 'AIFF PCM 8-bit', container: 'AIFF', encoding: 'PCM (big-endian)', bitDepth: '8-bit', lossless: true, native: true, mime: 'audio/aiff', extension: 'aiff' },
  { id: 'aiff-16', label: 'AIFF PCM 16-bit', container: 'AIFF', encoding: 'PCM (big-endian)', bitDepth: '16-bit', lossless: true, native: true, mime: 'audio/aiff', extension: 'aiff' },
  { id: 'aiff-24', label: 'AIFF PCM 24-bit', container: 'AIFF', encoding: 'PCM (big-endian)', bitDepth: '24-bit', lossless: true, native: true, mime: 'audio/aiff', extension: 'aiff' },
  { id: 'aiff-32', label: 'AIFF PCM 32-bit', container: 'AIFF', encoding: 'PCM (big-endian)', bitDepth: '32-bit', lossless: true, native: true, mime: 'audio/aiff', extension: 'aiff' },
  { id: 'aifc-f32', label: 'AIFC IEEE Float 32-bit', container: 'AIFC', encoding: 'FL32 (big-endian)', bitDepth: '32-bit float', lossless: true, native: true, mime: 'audio/aiff', extension: 'aifc' },
  { id: 'au-ulaw', label: 'Au/SND μ-law', container: 'Au (NeXT/Sun)', encoding: 'μ-law', bitDepth: '8-bit comp', lossless: false, native: true, mime: 'audio/basic', extension: 'au' },
  { id: 'au-alaw', label: 'Au/SND A-law', container: 'Au (NeXT/Sun)', encoding: 'A-law', bitDepth: '8-bit comp', lossless: false, native: true, mime: 'audio/basic', extension: 'au' },
  { id: 'au-8', label: 'Au/SND PCM 8-bit', container: 'Au (NeXT/Sun)', encoding: 'PCM (big-endian)', bitDepth: '8-bit', lossless: true, native: true, mime: 'audio/basic', extension: 'au' },
  { id: 'au-16', label: 'Au/SND PCM 16-bit', container: 'Au (NeXT/Sun)', encoding: 'PCM (big-endian)', bitDepth: '16-bit', lossless: true, native: true, mime: 'audio/basic', extension: 'au' },
  { id: 'au-24', label: 'Au/SND PCM 24-bit', container: 'Au (NeXT/Sun)', encoding: 'PCM (big-endian)', bitDepth: '24-bit', lossless: true, native: true, mime: 'audio/basic', extension: 'au' },
  { id: 'au-32', label: 'Au/SND PCM 32-bit', container: 'Au (NeXT/Sun)', encoding: 'PCM (big-endian)', bitDepth: '32-bit', lossless: true, native: true, mime: 'audio/basic', extension: 'au' },
  { id: 'au-f32', label: 'Au/SND IEEE Float 32-bit', container: 'Au (NeXT/Sun)', encoding: 'IEEE Float (big-endian)', bitDepth: '32-bit float', lossless: true, native: true, mime: 'audio/basic', extension: 'au' },
  { id: 'caf-16', label: 'CAF PCM 16-bit', container: 'CAF (Core Audio)', encoding: 'PCM (big-endian)', bitDepth: '16-bit', lossless: true, native: true, mime: 'audio/x-caf', extension: 'caf' },
  { id: 'caf-24', label: 'CAF PCM 24-bit', container: 'CAF (Core Audio)', encoding: 'PCM (big-endian)', bitDepth: '24-bit', lossless: true, native: true, mime: 'audio/x-caf', extension: 'caf' },
  { id: 'caf-32', label: 'CAF PCM 32-bit', container: 'CAF (Core Audio)', encoding: 'PCM (big-endian)', bitDepth: '32-bit', lossless: true, native: true, mime: 'audio/x-caf', extension: 'caf' },
  { id: 'caf-f32', label: 'CAF IEEE Float 32-bit', container: 'CAF (Core Audio)', encoding: 'IEEE Float (big-endian)', bitDepth: '32-bit float', lossless: true, native: true, mime: 'audio/x-caf', extension: 'caf' },
  { id: 'caf-f64', label: 'CAF IEEE Float 64-bit', container: 'CAF (Core Audio)', encoding: 'IEEE Float (big-endian)', bitDepth: '64-bit float', lossless: true, native: true, mime: 'audio/x-caf', extension: 'caf' },
  { id: 'webm-opus', label: 'WebM Opus (compressed)', container: 'WebM', encoding: 'Opus', bitDepth: '—', lossless: false, native: true, mime: 'audio/webm', extension: 'webm' },
  { id: 'mp4-aac', label: 'MP4 AAC (compressed)', container: 'MP4', encoding: 'AAC-LC', bitDepth: '—', lossless: false, native: true, mime: 'audio/mp4', extension: 'm4a' },
  { id: 'ogg-opus', label: 'Ogg Opus (compressed)', container: 'Ogg', encoding: 'Opus', bitDepth: '—', lossless: false, native: true, mime: 'audio/ogg', extension: 'ogg' },
  { id: 'raw-u8', label: 'Raw PCM 8-bit unsigned', container: 'Raw', encoding: 'PCM (no header)', bitDepth: '8-bit', lossless: true, native: true, mime: 'application/octet-stream', extension: 'raw' },
  { id: 'raw-s8', label: 'Raw PCM 8-bit signed', container: 'Raw', encoding: 'PCM (no header)', bitDepth: '8-bit', lossless: true, native: true, mime: 'application/octet-stream', extension: 'raw' },
  { id: 'raw-s16le', label: 'Raw PCM 16-bit LE', container: 'Raw', encoding: 'PCM (no header)', bitDepth: '16-bit', lossless: true, native: true, mime: 'application/octet-stream', extension: 'raw' },
  { id: 'raw-s16be', label: 'Raw PCM 16-bit BE', container: 'Raw', encoding: 'PCM (no header)', bitDepth: '16-bit', lossless: true, native: true, mime: 'application/octet-stream', extension: 'raw' },
  { id: 'raw-s24le', label: 'Raw PCM 24-bit LE', container: 'Raw', encoding: 'PCM (no header)', bitDepth: '24-bit', lossless: true, native: true, mime: 'application/octet-stream', extension: 'raw' },
  { id: 'raw-s24be', label: 'Raw PCM 24-bit BE', container: 'Raw', encoding: 'PCM (no header)', bitDepth: '24-bit', lossless: true, native: true, mime: 'application/octet-stream', extension: 'raw' },
  { id: 'raw-s32le', label: 'Raw PCM 32-bit LE', container: 'Raw', encoding: 'PCM (no header)', bitDepth: '32-bit', lossless: true, native: true, mime: 'application/octet-stream', extension: 'raw' },
  { id: 'raw-f32le', label: 'Raw Float 32-bit LE', container: 'Raw', encoding: 'IEEE Float (no header)', bitDepth: '32-bit float', lossless: true, native: true, mime: 'application/octet-stream', extension: 'raw' },
  { id: 'raw-f32be', label: 'Raw Float 32-bit BE', container: 'Raw', encoding: 'IEEE Float (no header)', bitDepth: '32-bit float', lossless: true, native: true, mime: 'application/octet-stream', extension: 'raw' },
];

export function getFormat(id: AudioFormatId): FormatDescriptor | undefined {
  return AUDIO_FORMATS.find((f) => f.id === id);
}

// ---------- shared helpers ----------
function getChannels(buffer: AudioBuffer, channels: 1 | 2): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    out.push(buffer.getChannelData(buffer.numberOfChannels === 1 ? 0 : Math.min(c, buffer.numberOfChannels - 1)));
  }
  return out;
}

let ditherState = 12345;
function prand(): number {
  ditherState = (ditherState * 1103515245 + 12345) & 0x7fffffff;
  return ditherState / 0x7fffffff;
}

/** Quantize a frame range into interleaved PCM bytes. */
function quantizeRange(
  chans: Float32Array[],
  channels: number,
  startFrame: number,
  endFrame: number,
  bits: number,
  isFloat: boolean,
  isBE: boolean,
  dither: boolean,
  unsigned8: boolean,
): Uint8Array {
  const bytesPer = bits / 8;
  const frames = endFrame - startFrame;
  const out = new Uint8Array(frames * channels * bytesPer);
  const dv = new DataView(out.buffer);
  let off = 0;
  for (let i = startFrame; i < endFrame; i++) {
    for (let c = 0; c < channels; c++) {
      let s = chans[c][i];
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      if (isFloat) {
        if (bits === 32) dv.setFloat32(off, s, !isBE);
        else dv.setFloat64(off, s, !isBE);
      } else if (bits === 8) {
        if (unsigned8) {
          let q = s * 127 + 128;
          if (dither) q += prand() + prand() - 1;
          dv.setUint8(off, Math.max(0, Math.min(255, Math.round(q))));
        } else {
          let q = s * 127;
          if (dither) q += prand() + prand() - 1;
          dv.setInt8(off, Math.max(-128, Math.min(127, Math.round(q))));
        }
      } else {
        if (dither && bits <= 16) s += (prand() + prand() - 1) / (1 << (bits - 1));
        let q: number;
        if (bits === 16) q = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
        else if (bits === 24) q = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388607)));
        else q = Math.max(-2147483648, Math.min(2147483647, Math.round(s * 2147483647)));
        if (isBE) {
          if (bits === 16) dv.setInt16(off, q, false);
          else if (bits === 24) {
            dv.setUint8(off, (q >> 16) & 0xff);
            dv.setUint8(off + 1, (q >> 8) & 0xff);
            dv.setUint8(off + 2, q & 0xff);
          } else dv.setInt32(off, q, false);
        } else {
          if (bits === 16) dv.setInt16(off, q, true);
          else if (bits === 24) {
            dv.setUint8(off, q & 0xff);
            dv.setUint8(off + 1, (q >> 8) & 0xff);
            dv.setUint8(off + 2, (q >> 16) & 0xff);
          } else dv.setInt32(off, q, true);
        }
      }
      off += bytesPer;
    }
  }
  return out;
}

// ---------- G.711 companding ----------
const ULAW_TABLE = (() => {
  const t = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) {
    let x = i < 32768 ? i : i - 65536;
    const BIAS = 0x84;
    const CLIP = 32635;
    const sign = x < 0 ? 0x80 : 0x00;
    if (sign) x = -x;
    if (x > CLIP) x = CLIP;
    x += BIAS;
    let exponent = 7;
    let mask = 0x4000;
    for (; exponent > 0 && !(x & mask); exponent--, mask >>= 1);
    const mantissa = (x >> (exponent + 3)) & 0x0f;
    t[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return t;
})();

const ALAW_TABLE = (() => {
  const t = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) {
    let x = i < 32768 ? i : i - 65536;
    const sign = x < 0 ? 0x80 : 0x00;
    if (sign) x = -x;
    if (x < 256) {
      t[i] = (sign | (x >> 4)) ^ 0x55;
    } else {
      let exponent: number;
      if (x < 1024) exponent = 3;
      else if (x < 2048) exponent = 4;
      else if (x < 4096) exponent = 5;
      else if (x < 8192) exponent = 6;
      else exponent = 7;
      const mantissa = (x >> exponent) & 0x0f;
      t[i] = (sign | ((exponent - 3) << 4) | mantissa) ^ 0x55;
    }
  }
  return t;
})();

function compandRange(
  chans: Float32Array[],
  channels: number,
  startFrame: number,
  endFrame: number,
  table: Uint8Array,
): Uint8Array {
  const frames = endFrame - startFrame;
  const out = new Uint8Array(frames * channels);
  let off = 0;
  for (let i = startFrame; i < endFrame; i++) {
    for (let c = 0; c < channels; c++) {
      const pcm = Math.max(-32768, Math.min(32767, Math.round(chans[c][i] * 32767)));
      out[off++] = table[pcm + 32768];
    }
  }
  return out;
}

// ---------- IMA ADPCM ----------
const IMA_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 229, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const IMA_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

const ADPCM_FRAMES_PER_BLOCK = 1024;

/** Encode one IMA ADPCM block starting at startFrame (expects up to FRAMES_PER_BLOCK-1 frames available). */
function encodeAdpcmBlock(chans: Float32Array[], channels: number, startFrame: number, availableFrames: number): Uint8Array {
  const dataFrames = ADPCM_FRAMES_PER_BLOCK - 1;
  const blockBytes = 4 * channels + Math.ceil(dataFrames * channels / 2);
  const out = new Uint8Array(blockBytes);
  const dv = new DataView(out.buffer);
  const prev = new Int32Array(channels);
  const index = new Int32Array(channels);
  for (let c = 0; c < channels; c++) {
    prev[c] = Math.max(-32768, Math.min(32767, Math.round(chans[c][startFrame] * 32767)));
    dv.setInt16(c * 4, prev[c], true);
    dv.setInt8(c * 4 + 2, 0);
    dv.setInt8(c * 4 + 3, 0);
  }
  const encodeNibble = (c: number, sample: number): number => {
    const step = IMA_STEP_TABLE[index[c]];
    let diff = sample - prev[c];
    let nib = diff < 0 ? 8 : 0;
    let mag = Math.abs(diff);
    if (mag >= step) { nib |= 4; mag -= step; }
    if (mag >= step >> 1) { nib |= 2; mag -= step >> 1; }
    if (mag >= step >> 2) nib |= 1;
    // reconstruction (matches decoder)
    let delta = step >> 3;
    if (nib & 4) delta += step;
    if (nib & 2) delta += step >> 1;
    if (nib & 1) delta += step >> 2;
    if (nib & 8) delta = -delta;
    prev[c] = Math.max(-32768, Math.min(32767, prev[c] + delta));
    index[c] = Math.max(0, Math.min(88, index[c] + IMA_INDEX_TABLE[nib & 7]));
    return nib;
  };
  let outOff = 4 * channels;
  if (channels === 1) {
    let pending: number | null = null;
    for (let f = 1; f < Math.min(availableFrames, dataFrames + 1); f++) {
      const s = Math.max(-32768, Math.min(32767, Math.round(chans[0][startFrame + f] * 32767)));
      const nib = encodeNibble(0, s);
      if (pending == null) pending = nib;
      else {
        out[outOff++] = pending | (nib << 4);
        pending = null;
      }
    }
    if (pending != null) out[outOff++] = pending;
  } else {
    for (let f = 1; f < Math.min(availableFrames, dataFrames + 1); f++) {
      const s0 = Math.max(-32768, Math.min(32767, Math.round(chans[0][startFrame + f] * 32767)));
      const s1 = Math.max(-32768, Math.min(32767, Math.round(chans[1][startFrame + f] * 32767)));
      const lo = encodeNibble(0, s0);
      const hi = encodeNibble(1, s1);
      out[outOff++] = lo | (hi << 4);
    }
  }
  return out;
}

// ---------- container headers ----------
function ascii(dv: DataView, off: number, s: string) {
  for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
}

function wavHeader(
  dataBytes: number,
  sampleRate: number,
  channels: number,
  bits: number,
  isFloat: boolean,
  formatTag?: number,
  extra?: { blockAlign?: number; avgBytes?: number; samplesPerBlock?: number },
): [ArrayBuffer, number] {
  const useExt = formatTag != null && formatTag !== 1 && formatTag !== 3; // ADPCM-style fmt with cbSize=2
  const fmtSize = useExt ? 20 : 16;
  const hasFact = useExt;
  const headerSize = 12 + 8 + fmtSize + (hasFact ? 12 : 0) + 8;
  const buf = new ArrayBuffer(headerSize);
  const dv = new DataView(buf);
  ascii(dv, 0, 'RIFF');
  dv.setUint32(4, headerSize - 8 + dataBytes, true);
  ascii(dv, 8, 'WAVE');
  ascii(dv, 12, 'fmt ');
  dv.setUint32(16, fmtSize, true);
  dv.setUint16(20, formatTag ?? (isFloat ? 3 : 1), true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  const blockAlign = extra?.blockAlign ?? (channels * bits) / 8;
  const avg = extra?.avgBytes ?? Math.round((sampleRate * blockAlign) / (extra?.samplesPerBlock ?? 1));
  dv.setUint32(28, avg, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bits, true);
  let off = 12 + 8 + fmtSize;
  if (useExt) {
    dv.setUint16(36, 2, true); // cbSize
    dv.setUint16(38, extra?.samplesPerBlock ?? 505, true); // wSamplesPerBlock
    ascii(dv, off, 'fact');
    dv.setUint32(off + 4, 4, true);
    dv.setUint32(off + 8, Math.floor(dataBytes / Math.max(1, extra?.blockAlign ?? 1)) * (extra?.samplesPerBlock ?? 1), true);
    off += 12;
  }
  ascii(dv, off, 'data');
  dv.setUint32(off + 4, dataBytes, true);
  off += 8;
  return [buf, off];
}

function rf64Header(dataBytes: number, sampleRate: number, channels: number, bits: number): [ArrayBuffer, number] {
  // RF64 (Broadcast Wave 64): 'RF64' + ds64 chunk; 0xFFFFFFFF data sentinel for >4GB safety
  const frameCount = Math.floor(dataBytes / ((channels * bits) / 8));
  const headerSize = 12 + 8 + 28 + 24 + 8;
  const buf = new ArrayBuffer(headerSize);
  const dv = new DataView(buf);
  ascii(dv, 0, 'RF64');
  dv.setUint32(4, 0xffffffff, true);
  dv.setUint32(8, 0, true); // riff size high
  ascii(dv, 12, 'WAVE');
  ascii(dv, 16, 'ds64');
  dv.setUint32(20, 28, true);
  dv.setUint32(24, headerSize - 8 + dataBytes, true); // riffSize low
  dv.setUint32(28, 0, true); // riffSize high
  dv.setUint32(32, dataBytes, true); // dataSize low
  dv.setUint32(36, 0, true); // dataSize high
  dv.setUint32(40, frameCount, true); // sampleCount low
  dv.setUint32(44, 0, true); // sampleCount high
  dv.setUint32(48, 0, true); // tableLength
  let off = 52;
  ascii(dv, off, 'fmt ');
  dv.setUint32(off + 4, 16, true);
  dv.setUint16(off + 8, 1, true);
  dv.setUint16(off + 10, channels, true);
  dv.setUint32(off + 12, sampleRate, true);
  dv.setUint32(off + 16, sampleRate * channels * (bits / 8), true);
  dv.setUint16(off + 20, (channels * bits) / 8, true);
  dv.setUint16(off + 22, bits, true);
  off += 24;
  ascii(dv, off, 'data');
  dv.setUint32(off + 4, 0xffffffff, true);
  off += 8;
  return [buf, off];
}

function aiffHeader(dataBytes: number, sampleRate: number, channels: number, bits: number, isFloat: boolean): [ArrayBuffer, number] {
  const isAifc = isFloat;
  const commSize = isAifc ? 34 : 18; // AIFC adds 4-byte compressionType + 12-byte name = 16? (type 4 + pstring 'not compressed' = 16 → total 34)
  const frameCount = Math.floor(dataBytes / ((channels * bits) / 8));
  const headerSize = 12 + 8 + commSize + 16;
  const buf = new ArrayBuffer(headerSize);
  const dv = new DataView(buf);
  ascii(dv, 0, 'FORM');
  dv.setUint32(4, headerSize - 8 + dataBytes, false);
  ascii(dv, 8, isAifc ? 'AIFC' : 'AIFF');
  ascii(dv, 12, 'COMM');
  dv.setUint32(16, commSize, false);
  dv.setUint16(20, channels, false);
  dv.setUint32(22, frameCount, false);
  dv.setUint16(26, bits, false);
  // 80-bit IEEE 754 extended float sample rate (sign+exp 16 bits, explicit-int-bit mantissa 64 bits)
  const rateOff = 28;
  const ex = Math.floor(Math.log2(sampleRate));
  const mant = sampleRate / Math.pow(2, ex);
  const biasedExp = 16383 + ex; // exponent bias for normalized value with integer bit
  dv.setUint16(rateOff, biasedExp, false);
  const f = mant - 1; // fractional part (mant is in [1, 2))
  const hi32 = (0x80000000 | Math.floor(f * Math.pow(2, 31))) >>> 0;
  const lo32 = Math.floor((f * Math.pow(2, 31)) % 1 * Math.pow(2, 32)) >>> 0;
  dv.setUint32(rateOff + 2, hi32, false);
  dv.setUint32(rateOff + 6, lo32, false);
  let off = 12 + 8 + commSize;
  if (isAifc) {
    ascii(dv, 28 + 10, 'FL32');
    // pascal-style compression name 'not compressed'
    const name = 'not compressed';
    dv.setUint8(28 + 14, name.length);
    for (let i = 0; i < name.length; i++) dv.setUint8(28 + 15 + i, name.charCodeAt(i));
  }
  ascii(dv, off, 'SSND');
  dv.setUint32(off + 4, 8 + dataBytes, false);
  dv.setUint32(off + 8, 0, false); // offset
  dv.setUint32(off + 12, 0, false); // block size
  off += 16;
  return [buf, off];
}

function auHeader(dataBytes: number, sampleRate: number, channels: number, encoding: number): [ArrayBuffer, number] {
  const buf = new ArrayBuffer(28);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x2e736e64, false); // '.snd'
  dv.setUint32(4, 28, false);
  dv.setUint32(8, dataBytes, false);
  dv.setUint32(12, encoding, false);
  dv.setUint32(16, sampleRate, false);
  dv.setUint32(20, channels, false);
  dv.setUint32(24, 0, false);
  return [buf, 28];
}

function cafHeader(dataBytes: number, sampleRate: number, channels: number, bits: number, isFloat: boolean): [ArrayBuffer, number] {
  // CAF: file header (8) + 'desc' chunk (12+32) + 'data' chunk header (8+8+4) — all big-endian
  const headerSize = 8 + 8 + 32 + 8 + 8 + 4;
  const buf = new ArrayBuffer(headerSize);
  const dv = new DataView(buf);
  ascii(dv, 0, 'caff');
  dv.setUint16(4, 1, false); // version
  dv.setUint16(6, 0, false); // flags
  ascii(dv, 8, 'desc');
  dv.setUint32(12, 32, false);
  dv.setFloat64(16, sampleRate, false);
  ascii(dv, 24, isFloat ? (bits === 64 ? 'fl64' : 'fl32') : 'lpcm');
  dv.setUint32(28, 0, false); // flags: 0 = big-endian floats/ints
  dv.setUint32(32, bits, false);
  dv.setUint32(36, channels, false);
  dv.setUint32(40, (channels * bits) / 8, false); // bytes per frame
  dv.setUint32(44, 0, false); // bytes per packet (0 for lpcm = frame-packet)
  ascii(dv, 48, 'data');
  dv.setUint32(56, dataBytes + 4, false); // chunk size includes edit count
  dv.setUint32(64, 0, false); // mEditCount
  return [buf, 68];
}

// ---------- format params ----------
interface FormatParams {
  family: 'wav' | 'rf64' | 'aiff' | 'aifc' | 'au' | 'caf' | 'raw';
  bits: number;
  isFloat: boolean;
  isBE: boolean;
  encoding: 'pcm' | 'ulaw' | 'alaw' | 'adpcm';
  unsigned8: boolean;
}

const F = (
  family: FormatParams['family'], bits: number, isFloat: boolean, isBE: boolean,
  encoding: FormatParams['encoding'] = 'pcm', unsigned8 = false,
): FormatParams => ({ family, bits, isFloat, isBE, encoding, unsigned8 });

const FORMAT_PARAMS: Record<string, FormatParams> = {
  'wav-8': F('wav', 8, false, false, 'pcm', true),
  'wav-16': F('wav', 16, false, false),
  'wav-24': F('wav', 24, false, false),
  'wav-32': F('wav', 32, false, false),
  'wav-32f': F('wav', 32, true, false),
  'wav-64f': F('wav', 64, true, false),
  'wav-ulaw': F('wav', 8, false, false, 'ulaw'),
  'wav-alaw': F('wav', 8, false, false, 'alaw'),
  'wav-adpcm': F('wav', 4, false, false, 'adpcm'),
  'rf64-16': F('rf64', 16, false, false),
  'aiff-8': F('aiff', 8, false, true),
  'aiff-16': F('aiff', 16, false, true),
  'aiff-24': F('aiff', 24, false, true),
  'aiff-32': F('aiff', 32, false, true),
  'aifc-f32': F('aifc', 32, true, true),
  'au-ulaw': F('au', 8, false, true, 'ulaw'),
  'au-alaw': F('au', 8, false, true, 'alaw'),
  'au-8': F('au', 8, false, true),
  'au-16': F('au', 16, false, true),
  'au-24': F('au', 24, false, true),
  'au-32': F('au', 32, false, true),
  'au-f32': F('au', 32, true, true),
  'caf-16': F('caf', 16, false, true),
  'caf-24': F('caf', 24, false, true),
  'caf-32': F('caf', 32, false, true),
  'caf-f32': F('caf', 32, true, true),
  'caf-f64': F('caf', 64, true, true),
  'raw-u8': F('raw', 8, false, false, 'pcm', true),
  'raw-s8': F('raw', 8, false, false),
  'raw-s16le': F('raw', 16, false, false),
  'raw-s16be': F('raw', 16, false, true),
  'raw-s24le': F('raw', 24, false, false),
  'raw-s24be': F('raw', 24, false, true),
  'raw-s32le': F('raw', 32, false, false),
  'raw-f32le': F('raw', 32, true, false),
  'raw-f32be': F('raw', 32, true, true),
};

function encodeRange(p: FormatParams, chans: Float32Array[], channels: number, start: number, end: number, dither: boolean): Uint8Array {
  if (p.encoding === 'ulaw') return compandRange(chans, channels, start, end, ULAW_TABLE);
  if (p.encoding === 'alaw') return compandRange(chans, channels, start, end, ALAW_TABLE);
  return quantizeRange(chans, channels, start, end, p.bits, p.isFloat, p.isBE, dither, p.unsigned8);
}

function computeDataBytes(buffer: AudioBuffer, channels: number, p: FormatParams): number {
  if (p.encoding === 'adpcm') {
    const blocks = Math.ceil(buffer.length / (ADPCM_FRAMES_PER_BLOCK - 1));
    return blocks * (4 * channels + Math.ceil((ADPCM_FRAMES_PER_BLOCK - 1) * channels / 2));
  }
  const bytesPer = p.encoding === 'ulaw' || p.encoding === 'alaw' ? 1 : p.bits / 8;
  return Math.ceil(buffer.length * channels * bytesPer);
}

function buildHeader(p: FormatParams, dataBytes: number, sampleRate: number, channels: number): [ArrayBuffer, number] {
  switch (p.family) {
    case 'wav': {
      if (p.encoding === 'ulaw' || p.encoding === 'alaw') {
        return wavHeader(dataBytes, sampleRate, channels, 8, false, p.encoding === 'ulaw' ? 7 : 6, {
          blockAlign: channels,
          samplesPerBlock: 1,
        });
      }      if (p.encoding === 'adpcm') {
        const blockAlign = 4 * channels + Math.ceil((ADPCM_FRAMES_PER_BLOCK - 1) * channels / 2);
        return wavHeader(dataBytes, sampleRate, channels, 4, false, 17, {
          blockAlign,
          samplesPerBlock: ADPCM_FRAMES_PER_BLOCK - 1,
        });
      }
      return wavHeader(dataBytes, sampleRate, channels, p.bits, p.isFloat);
    }
    case 'rf64': return rf64Header(dataBytes, sampleRate, channels, p.bits);
    case 'aiff': case 'aifc': return aiffHeader(dataBytes, sampleRate, channels, p.bits, p.isFloat);
    case 'au': {
      const enc = p.encoding === 'ulaw' ? 1 : p.encoding === 'alaw' ? 27 : p.isFloat ? 6 : p.bits === 8 ? 2 : p.bits === 16 ? 3 : p.bits === 24 ? 4 : 5;
      return auHeader(dataBytes, sampleRate, channels, enc);
    }
    case 'caf': return cafHeader(dataBytes, sampleRate, channels, p.bits, p.isFloat);
    default: return [new ArrayBuffer(0), 0];
  }
}

// ---------- MediaRecorder compressed exports ----------
// Browser-native lossy formats recorded through the Web Audio graph.
// Descriptors above stay static so SSR/hydration is stable; actual
// encode-time support is probed per browser via MediaRecorder.isTypeSupported.
const RECORDER_MIMES: Record<string, string> = {
  'webm-opus': 'audio/webm;codecs=opus',
  'mp4-aac': 'audio/mp4;codecs=mp4a.40.2',
  'ogg-opus': 'audio/ogg;codecs=opus',
};

const RECORDER_FORMAT_IDS = new Set(Object.keys(RECORDER_MIMES));

const RECORDER_SUPPORT_CACHE = new Map<string, boolean>();

/** True when this browser can natively encode the given compressed format id. Cached per session. */
export function recorderFormatSupported(id: string): boolean {
  const cached = RECORDER_SUPPORT_CACHE.get(id);
  if (cached !== undefined) return cached;
  const mime = RECORDER_MIMES[id];
  let ok = false;
  if (mime && typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
    try {
      ok = MediaRecorder.isTypeSupported(mime);
    } catch {
      ok = false;
    }
  }
  RECORDER_SUPPORT_CACHE.set(id, ok);
  return ok;
}

// ---------- device capability probes (informational — used by format pickers) ----------
// No top-level browser access: MediaRecorder is only touched inside functions, so
// these are SSR-safe and tree-shakeable. Availability mirrors the routing of
// encodeAudioBufferChunked exactly (same RECORDER_FORMAT_IDS set), so what a
// picker reports as available can never disagree with what the encoder will do.
let recorderSupportMapMemo: Record<string, boolean> | undefined;

/**
 * One-shot per-session map of MediaRecorder codec availability, keyed by the
 * same format ids the chunked encoder routes to encodeWithMediaRecorder.
 * Values are true when MediaRecorder.isTypeSupported accepts the codec, false
 * when it does not — including SSR/non-DOM environments where MediaRecorder is
 * undefined. Memoized after the first call (per-id probes are themselves cached).
 */
export function recorderSupportMap(): Record<string, boolean> {
  if (!recorderSupportMapMemo) {
    const map: Record<string, boolean> = {};
    for (const id of RECORDER_FORMAT_IDS) map[id] = recorderFormatSupported(id);
    recorderSupportMapMemo = map;
  }
  return recorderSupportMapMemo;
}

/**
 * Whether a format id can actually be encoded on this device. Mirrors the
 * routing of encodeAudioBufferChunked: ids present in the recorder support map
 * (the compressed WebM/MP4/Ogg family) depend on MediaRecorder codec support,
 * every other id found in `formats` is one of this app's own byte-level PCM
 * writers and is always available. Unknown ids are false. SSR-safe.
 */
export function isFormatAvailable(id: string, formats: FormatDescriptor[]): boolean {
  const support = recorderSupportMap();
  if (support[id] !== undefined) return support[id];
  return formats.some((f) => f.id === id);
}

/** Number of the given formats that isFormatAvailable reports as encodable on this device. */
export function countAvailableFormats(formats: FormatDescriptor[]): number {
  return formats.reduce((n, f) => (isFormatAvailable(f.id, formats) ? n + 1 : n), 0);
}

// ---------- batch-export size estimates (additive, pure — no encode behavior) ----------
// Heuristics used by the TTS Studio batch-export panel to show "~2.4 MB"-style
// size hints without encoding anything. Pure functions with no top-level browser
// access, so they are SSR-safe and tree-shakeable like the probes above.

/**
 * Container overhead added to compressed-format estimates. Real WebM/MP4/Ogg
 * containers carry headers and seek cues worth a few KB, so ~4 KB keeps short
 * clips from looking free without pretending the number is byte-exact.
 */
const COMPRESSED_CONTAINER_OVERHEAD_BYTES = 4096;

/**
 * Nominal bitrates (kbps) for the MediaRecorder compressed family, keyed by the
 * same ids RECORDER_MIMES routes. encodeWithMediaRecorder actually requests
 * 128 kbps; Ogg Opus carries the conventional 96 kbps nominal. MP3 is not in
 * AUDIO_FORMATS today but is recognized by descriptor encoding/label so foreign
 * registries estimate sensibly too.
 */
const NOMINAL_KBPS: Record<string, number> = {
  'webm-opus': 128,
  'mp4-aac': 128,
  'ogg-opus': 96,
};

/**
 * Nominal bitrate (kbps) for a compressed format id, or null when the format
 * belongs to a PCM/companded family whose size scales with sample rate and
 * bit depth instead of a bitrate. Recognizes the MediaRecorder compressed ids
 * directly, then falls back to a descriptor encoding/label match (e.g. MP3 →
 * 192 kbps). Pure + SSR-safe.
 */
export function formatBitrateKbps(formatId: string, formats: FormatDescriptor[]): number | null {
  if (formatId in NOMINAL_KBPS) return NOMINAL_KBPS[formatId];
  const fmt = formats.find((f) => f.id === formatId);
  if (!fmt) return null;
  const hay = `${fmt.encoding} ${fmt.label}`.toLowerCase();
  if (hay.includes('mp3')) return 192;
  return null;
}

/**
 * Rough encoded file size in bytes for one format over `durationSec` of audio,
 * or null when the format is unknown to `formats` (or has no estimable depth).
 *
 * Heuristics per format family:
 *  - compressed (WebM Opus / MP4 AAC / Ogg Opus, MP3): duration × nominal
 *    bitrate ÷ 8 + ~4 KB container overhead — see {@link formatBitrateKbps};
 *  - PCM / companded (WAV, AIFF, Au, CAF, RAW, μ-law/A-law, IMA ADPCM):
 *    duration × sampleRate × channels × bytesPerSample, where bytesPerSample is
 *    parsed from the descriptor's `bitDepth` ('8-bit'→1 … '24-bit'→3, '32-bit'
 *    →4 (int or float), '64-bit float'→8, '4-bit'→0.5 for ADPCM). Container
 *    headers (~44 B WAV / ~54 B AIFF) are ignored — negligible next to data.
 *
 * `opts` lets callers pass the real render target (default 44.1 kHz mono, the
 * app's settings default); compressed estimates ignore it. Pure + SSR-safe.
 */
export function estimateEncodedBytes(
  durationSec: number,
  formatId: string,
  formats: FormatDescriptor[],
  opts?: { sampleRate?: number; channels?: 1 | 2 },
): number | null {
  if (!Number.isFinite(durationSec)) return null;
  const fmt = formats.find((f) => f.id === formatId);
  if (!fmt) return null;
  const duration = Math.max(0, durationSec);

  // Compressed family: size scales with the nominal bitrate.
  const kbps = formatBitrateKbps(formatId, formats);
  if (kbps !== null) {
    return Math.round((duration * kbps * 1000) / 8) + COMPRESSED_CONTAINER_OVERHEAD_BYTES;
  }

  // PCM / companded family: size scales with sample rate × channels × depth.
  const bits = /^(\d+)/.exec(fmt.bitDepth.trim());
  if (!bits) return null; // '—' or unrecognized depth → cannot estimate
  const bytesPerSample = Number(bits[1]) / 8;
  const sampleRate = opts?.sampleRate ?? 44100;
  const channels = opts?.channels ?? 1;
  if (!(sampleRate > 0) || !(channels > 0)) return null;
  return Math.round(duration * sampleRate * channels * bytesPerSample);
}

/**
 * Encode an AudioBuffer to a compressed format (Opus/AAC) using the browser's
 * native MediaRecorder. The buffer is played through a live AudioContext into a
 * MediaStreamAudioDestinationNode and recorded as encoded audio chunks.
 *
 * IMPORTANT: this records in REAL TIME — encoding a 3-minute buffer takes about
 * 3 minutes of wall-clock time (the codec runs alongside playback, not faster).
 * The UI stays responsive and `opts.onProgress` reports elapsed/duration (capped
 * at 0.99 until completion).
 *
 * Throws when the browser lacks MediaRecorder or the specific codec — callers
 * should fall back to a WAV/AIFF format. `opts.sampleRate` is inherently the
 * AudioContext's hardware rate; MediaRecorder output is best-effort per browser.
 */
export async function encodeWithMediaRecorder(
  buffer: AudioBuffer,
  format: AudioFormatId,
  opts?: EncodeOptions & { onProgress?: (p: number) => void },
): Promise<Blob> {
  const mime = RECORDER_MIMES[format];
  const label = getFormat(format)?.label ?? format;
  if (typeof MediaRecorder === 'undefined' || !mime || !recorderFormatSupported(format)) {
    throw new Error(`${label} is not supported by this browser — pick a WAV/AIFF format instead`);
  }

  const ctx = new AudioContext();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);

    const channels = Math.min(2, Math.max(1, opts?.channels ?? buffer.numberOfChannels)) as 1 | 2;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = channels; // node defaults to a stereo stream; 1 keeps mono exports mono
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(dest);

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 128_000 });
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mime.split(';')[0] }));
      recorder.onerror = () => reject(new Error(`${label} recording failed — pick a WAV/AIFF format instead`));
    });

    recorder.start(250); // 250 ms timeslice → chunks arrive steadily, small memory footprint
    source.start();

    // Real-time progress: elapsed seconds vs buffer duration, capped at 0.99 so 1
    // only ever fires after the recorder has flushed and stopped.
    const duration = buffer.duration > 0 ? buffer.duration : 1;
    const startedAt = performance.now();
    timer = setInterval(() => {
      const elapsed = (performance.now() - startedAt) / 1000;
      opts?.onProgress?.(Math.min(0.99, elapsed / duration));
    }, 100);

    await new Promise<void>((resolve) => {
      source.onended = () => {
        // 250 ms grace period: let the codec flush its tail before recorder.stop(),
        // otherwise the last buffered frames can be dropped.
        setTimeout(() => {
          if (recorder.state !== 'inactive') recorder.stop();
          resolve();
        }, 250);
      };
    });

    const blob = await stopped;
    opts?.onProgress?.(1);
    return blob;
  } finally {
    if (timer !== undefined) clearInterval(timer);
    void ctx.close().catch(() => undefined);
  }
}

// ---------- realtime-phase detection (additive UI helper — no encode behavior) ----------
/**
 * Human-readable hint describing the MediaRecorder real-time phases. The queue
 * UI shows this next to jobs whose progress message matches
 * {@link isRealtimeEncodePhase}.
 */
export const REALTIME_PHASE_HINT =
  'This export records in real time — a 60 s file takes ~60 s. WAV/FLAC exports are much faster.';

/**
 * Lower-case container/codec keywords unique to the MediaRecorder compressed
 * family (WebM Opus / MP4 AAC / Ogg Opus). The byte-level PCM writers (WAV,
 * AIFF, Au, RAW…) never emit these strings, so their presence in a progress
 * message or job label is a reliable (if weak) real-time signal.
 */
const COMPRESSED_FORMAT_KEYWORDS: readonly string[] = ['webm', 'opus', 'mp4', 'aac', 'ogg'];

/**
 * Conservative matcher for the MediaRecorder real-time phases, tested against
 * queue progress messages (and job labels, as a weaker signal):
 *  - video export records the canvas in real time → message `Recording ${pct}%`;
 *  - compressed audio encodes route through encodeWithMediaRecorder → their
 *    pre-encode message embeds the format label, e.g.
 *    `Encoding WebM Opus (compressed)…`.
 * Bare `Encoding ${pct}%` messages are intentionally NOT matched: WAV/AIFF
 * encodes emit the exact same string while finishing far faster than real time.
 * Pure string inspection — has zero effect on encode behavior.
 */
export function isRealtimeEncodePhase(msg?: string): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  if (m.includes('recording')) return true;
  return COMPRESSED_FORMAT_KEYWORDS.some((k) => m.includes(k));
}

// ---------- public API ----------
export function encodeAudioBuffer(buffer: AudioBuffer, format: AudioFormatId, opts?: EncodeOptions): Blob {
  if (RECORDER_FORMAT_IDS.has(format)) throw new Error('Compressed formats require the async encoder');
  const p = FORMAT_PARAMS[format];
  if (!p) throw new Error(`Unknown audio format: ${format}`);
  const channels = (opts?.channels ?? buffer.numberOfChannels) as 1 | 2;
  const chans = getChannels(buffer, channels);
  const sampleRate = buffer.sampleRate;
  const dither = opts?.dither ?? false;

  if (p.encoding === 'adpcm') {
    const blocks: Uint8Array[] = [];
    const dataFrames = ADPCM_FRAMES_PER_BLOCK - 1;
    for (let start = 0; start < buffer.length; start += dataFrames) {
      const end = Math.min(start + dataFrames, buffer.length);
      const frames = end - start;
      if (frames < dataFrames) {
        const padded: Float32Array[] = chans.map((ch) => {
          const a = new Float32Array(dataFrames);
          a.set(ch.slice(start, end));
          if (frames > 0) a.fill(ch[end - 1], frames);
          return a;
        });
        blocks.push(encodeAdpcmBlock(padded, channels, 0, dataFrames + 1));
      } else {
        blocks.push(encodeAdpcmBlock(chans, channels, start, dataFrames + 1));
      }
    }
    const dataBytes = blocks.reduce((a, b) => a + b.length, 0);
    const [header, off] = buildHeader(p, dataBytes, sampleRate, channels);
    return new Blob([header.slice(0, off) as unknown as BlobPart, ...blocks.map(asPart)], { type: getFormat(format)?.mime ?? 'audio/wav' });
  }

  const data = encodeRange(p, chans, channels, 0, buffer.length, dither);
  const dataBytes = computeDataBytes(buffer, channels, p);
  void dataBytes;
  const [header, headerOff] = buildHeader(p, data.length, sampleRate, channels);
  const parts: BlobPart[] = p.family === 'raw' ? [asPart(data)] : [header.slice(0, headerOff) as unknown as BlobPart, asPart(data)];
  return new Blob(parts, { type: getFormat(format)?.mime ?? 'application/octet-stream' });
}

/**
 * Chunked encoding for hour-long buffers: yields to the UI thread regularly,
 * reports progress, and assembles the Blob incrementally (no freeze, no giant spike).
 */
export async function encodeAudioBufferChunked(
  buffer: AudioBuffer,
  format: AudioFormatId,
  opts?: EncodeOptions,
  onProgress?: (p: number) => void,
): Promise<Blob> {
  // Compressed formats (WebM/MP4/Ogg) route through the browser's native
  // MediaRecorder instead of the byte-level PCM writers below.
  if (RECORDER_FORMAT_IDS.has(format)) return encodeWithMediaRecorder(buffer, format, { ...opts, onProgress });
  const p = FORMAT_PARAMS[format];
  if (!p) throw new Error(`Unknown audio format: ${format}`);
  const channels = (opts?.channels ?? buffer.numberOfChannels) as 1 | 2;
  const chans = getChannels(buffer, channels);
  const sampleRate = buffer.sampleRate;
  const dither = opts?.dither ?? false;

  if (p.encoding === 'adpcm') {
    const dataFrames = ADPCM_FRAMES_PER_BLOCK - 1;
    const blockCount = Math.ceil(buffer.length / dataFrames) || 1;
    const blockBytes = 4 * channels + Math.ceil(dataFrames * channels / 2);
    const dataBytes = blockCount * blockBytes;
    const [header, off] = buildHeader(p, dataBytes, sampleRate, channels);
    const parts: BlobPart[] = [header.slice(0, off)];
    for (let b = 0; b < blockCount; b++) {
      const start = b * dataFrames;
      const end = Math.min(start + dataFrames, buffer.length);
      const frames = end - start;
      let src: Float32Array[];
      if (frames < dataFrames) {
        src = chans.map((ch) => {
          const a = new Float32Array(dataFrames);
          a.set(ch.slice(start, end));
          if (frames > 0) a.fill(ch[end - 1], frames);
          return a;
        });
      } else {
        src = chans.map((ch) => ch.slice(start, end));
      }
      parts.push(encodeAdpcmBlock(src, channels, 0, dataFrames + 1) as unknown as BlobPart);
      if (b % 128 === 0) {
        onProgress?.(b / blockCount);
        await yieldToUI();
      }
    }
    onProgress?.(1);
    return new Blob(parts, { type: getFormat(format)?.mime ?? 'audio/wav' });
  }

  const CHUNK = 500_000;
  const total = buffer.length;
  const dataBytes = computeDataBytes(buffer, channels, p);
  const [header, headerOff] = buildHeader(p, dataBytes, sampleRate, channels);
  const parts: BlobPart[] = p.family === 'raw' ? [] : [header.slice(0, headerOff)];
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total);
    parts.push(encodeRange(p, chans, channels, start, end, dither) as unknown as BlobPart);
    onProgress?.(end / total);
    await yieldToUI();
  }
  onProgress?.(1);
  return new Blob(parts, { type: getFormat(format)?.mime ?? 'application/octet-stream' });
}

export async function resampleBuffer(
  buffer: AudioBuffer,
  sampleRate: number,
  channels?: 1 | 2,
): Promise<AudioBuffer> {
  const targetCh = channels ?? buffer.numberOfChannels;
  if (sampleRate === buffer.sampleRate && targetCh === buffer.numberOfChannels) return buffer;
  const len = Math.max(1, Math.ceil(buffer.duration * sampleRate));
  const ctx = new OfflineAudioContext(targetCh, len, sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}
