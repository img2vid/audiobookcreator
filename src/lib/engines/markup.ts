/**
 * Voice markup engine — a mini-SSML layer for the built-in synthesizer.
 *
 * Supported tags (all optional, plain text passes through untouched):
 *   [pause 500]        → 500 ms of silence (also accepts [pause 1.2s])
 *   [break]            → short comma-style pause (250 ms)
 *   [em]word[/em]      → emphasis: slight slow-down, pitch lift, volume boost
 *   [rate 1.2]…[/rate] → rate override for a span
 *   [pitch 0.9]…[/pitch] → pitch override for a span
 *   [whisper]…[/whisper] → quiet, breathy delivery
 *   [spell]ABC[/spell] → letter-by-letter spelling with gaps
 *
 * Everything is parsed into a flat segment plan; each segment is synthesized
 * independently by the formant engine and the pieces are joined with exact
 * pause durations — fully offline and deterministic.
 */

import { synthesizeSpeech, estimateSpeechDurationSec } from './formant';
import { yieldToUI } from '@/lib/utils/async';

export interface MarkupSegment {
  /** Text with all tags removed (may be empty for pause-only segments). */
  text: string;
  rate: number;
  pitch: number;
  volume: number;
  /** Silence appended after this segment, ms. */
  pauseAfterMs: number;
  /** Rendering hint used for the segment. */
  style: 'normal' | 'emphasis' | 'whisper' | 'spell';
}

export interface MarkupParseResult {
  segments: MarkupSegment[];
  /** Text with all markup stripped — used for AI-engine preview. */
  plainText: string;
  /** True when at least one recognized tag was found. */
  hasMarkup: boolean;
  /** Tags actually recognized (unique, ordered). */
  tagsUsed: string[];
}

const PAUSE_RE = /\[pause\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds)?\]/gi;
const BREAK_RE = /\[break\]/gi;
const EM_RE = /\[em\]([\s\S]*?)\[\/em\]/gi;
const RATE_RE = /\[rate\s+(\d*\.?\d+)\]([\s\S]*?)\[\/rate\]/gi;
const PITCH_RE = /\[pitch\s+(\d*\.?\d+)\]([\s\S]*?)\[\/pitch\]/gi;
const WHISPER_RE = /\[whisper\]([\s\S]*?)\[\/whisper\]/gi;
const SPELL_RE = /\[spell\]([\s\S]*?)\[\/spell\]/gi;

/** Clamp helper shared by parser and applier. */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function parsePauseMs(value: string, unit: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 400;
  if (unit && /^(s|sec|secs|seconds)$/i.test(unit)) return clamp(n * 1000, 0, 30_000);
  return clamp(n, 0, 30_000);
}

/**
 * Parse voice markup into a segment plan. Unrecognized [brackets] are left
 * untouched in the plain text so ordinary bracketed prose still reads fine.
 */
export function parseVoiceMarkup(input: string, base: { rate: number; pitch: number; volume: number }): MarkupParseResult {
  const tagsUsed: string[] = [];
  const seen = new Set<string>();
  const note = (t: string) => { if (!seen.has(t)) { seen.add(t); tagsUsed.push(t); } };

  let hasMarkup = false;
  let plain = input;

  // Pre-compute plain text (inner text of spans kept, tags dropped).
  plain = plain
    .replace(PAUSE_RE, (_m, _v, _u) => ' ')
    .replace(BREAK_RE, () => ' ')
    .replace(EM_RE, '$1')
    .replace(RATE_RE, '$2')
    .replace(PITCH_RE, '$2')
    .replace(WHISPER_RE, '$1')
    .replace(SPELL_RE, (_m, g: string) => g.split('').join(' '))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  // Direct recursive descent over the input: clear, testable, and adequate
  // for studio text sizes (tags nest, styles compose multiplicatively).
  interface Frame {
    rate: number;
    pitch: number;
    volume: number;
    style: MarkupSegment['style'];
  }

  function walk(src: string, frame: Frame, out: MarkupSegment[], plainOut: string[]): void {
    let buf = '';
    let i = 0;
    const flush = () => {
      const t = buf.trim();
      buf = '';
      if (t) {
        out.push({
          text: t,
          rate: clamp(frame.rate, 0.1, 10),
          pitch: clamp(frame.pitch, 0, 2),
          volume: clamp(frame.volume, 0, 1),
          pauseAfterMs: 0,
          style: frame.style,
        });
      }
    };
    while (i < src.length) {
      const ch = src[i];
      if (ch === '[') {
        const close = src.indexOf(']', i);
        if (close !== -1) {
          const tag = src.slice(i, close + 1);
          const lower = tag.toLowerCase();
          // block-level tags that flush the buffer
          let pauseMs: number | null = null;
          const pm = /^\[pause\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds)?\]$/i.exec(tag);
          if (pm) { pauseMs = parsePauseMs(pm[1], pm[2]); note('pause'); }
          else if (/^\[break\]$/i.test(tag)) { pauseMs = 250; note('break'); }
          if (pauseMs !== null) {
            flush();
            if (out.length) out[out.length - 1].pauseAfterMs += pauseMs;
            else out.push({ text: '', rate: frame.rate, pitch: frame.pitch, volume: frame.volume, pauseAfterMs: pauseMs, style: 'normal' });
            hasMarkup = true;
            i = close + 1;
            continue;
          }
          if (/^\[em\]$/i.test(tag)) {
            flush();
            const closeTag = src.toLowerCase().indexOf('[/em]', i);
            const inner = closeTag === -1 ? src.slice(i + 5) : src.slice(i + 5, closeTag);
            hasMarkup = true; note('em');
            walk(inner, { ...frame, rate: frame.rate * 0.88, pitch: clamp(frame.pitch * 1.06, 0, 2), volume: clamp(frame.volume * 1.15, 0, 1), style: 'emphasis' }, out, plainOut);
            flush();
            i = closeTag === -1 ? src.length : closeTag + 5;
            continue;
          }
          if (/^\[whisper\]$/i.test(tag)) {
            flush();
            const closeTag = src.toLowerCase().indexOf('[/whisper]', i);
            const inner = closeTag === -1 ? src.slice(i + 9) : src.slice(i + 9, closeTag);
            hasMarkup = true; note('whisper');
            walk(inner, { ...frame, volume: clamp(frame.volume * 0.4, 0, 1), rate: frame.rate * 0.95, style: 'whisper' }, out, plainOut);
            flush();
            i = closeTag === -1 ? src.length : closeTag + 10;
            continue;
          }
          if (/^\[spell\]$/i.test(tag)) {
            flush();
            const closeTag = src.toLowerCase().indexOf('[/spell]', i);
            const inner = closeTag === -1 ? src.slice(i + 7) : src.slice(i + 7, closeTag);
            hasMarkup = true; note('spell');
            // spell: uppercase letters separated by " ," so the engine gaps
            const spelled = inner.replace(/\s+/g, '').split('').join(', ').toUpperCase();
            walk(spelled, { ...frame, rate: frame.rate * 0.9, style: 'spell' }, out, plainOut);
            flush();
            i = closeTag === -1 ? src.length : closeTag + 8;
            continue;
          }
          const rm = /^\[rate\s+(\d*\.?\d+)\]$/i.exec(tag);
          if (rm) {
            flush();
            const closeTag = src.toLowerCase().indexOf('[/rate]', i);
            const inner = closeTag === -1 ? src.slice(i + tag.length) : src.slice(i + tag.length, closeTag);
            hasMarkup = true; note('rate');
            walk(inner, { ...frame, rate: clamp(Number(rm[1]) || 1, 0.1, 10) }, out, plainOut);
            flush();
            i = closeTag === -1 ? src.length : closeTag + 7;
            continue;
          }
          const pm2 = /^\[pitch\s+(\d*\.?\d+)\]$/i.exec(tag);
          if (pm2) {
            flush();
            const closeTag = src.toLowerCase().indexOf('[/pitch]', i);
            const inner = closeTag === -1 ? src.slice(i + tag.length) : src.slice(i + tag.length, closeTag);
            hasMarkup = true; note('pitch');
            walk(inner, { ...frame, pitch: clamp(Number(pm2[1]) || 1, 0, 2) }, out, plainOut);
            flush();
            i = closeTag === -1 ? src.length : closeTag + 8;
            continue;
          }
          // unknown tag — keep literally
        }
      }
      buf += ch;
      i++;
    }
    flush();
    if (buf.trim()) plainOut.push(buf.trim());
  }

  const segments: MarkupSegment[] = [];
  const plainParts: string[] = [];
  walk(input, { rate: base.rate, pitch: base.pitch, volume: base.volume, style: 'normal' }, segments, plainParts);
  if (plainParts.length && !plain) plain = plainParts.join(' ');

  return { segments, plainText: plain, hasMarkup, tagsUsed };
}

/** Create an AudioBuffer of pure silence. */
function silenceBuffer(seconds: number, sampleRate: number): AudioBuffer {
  const len = Math.max(1, Math.round(seconds * sampleRate));
  const ctx = new OfflineAudioContext(1, len, sampleRate);
  return ctx.createBuffer(1, len, sampleRate);
}

/** Concatenate buffers sample-exactly (they may differ in length, not rate). */
function concatAll(buffers: AudioBuffer[], sampleRate: number, channels: number): AudioBuffer {
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const ctx = new OfflineAudioContext(channels, Math.max(1, total), sampleRate);
  const out = ctx.createBuffer(channels, Math.max(1, total), sampleRate);
  let offset = 0;
  for (const b of buffers) {
    for (let c = 0; c < channels; c++) {
      const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
      out.getChannelData(c).set(src, offset);
    }
    offset += b.length;
  }
  return out;
}

export interface MarkupSynthOptions {
  profileId: string;
  rate: number;
  pitch: number;
  volume: number;
  quality: 'fast' | 'balanced' | 'high' | 'max';
}

/**
 * Synthesize text containing voice markup via the local formant engine.
 * Each segment is rendered at its own rate/pitch/volume; pauses become
 * exact silence. Falls back to plain synthesis when no markup is present.
 */
export async function synthesizeWithMarkup(
  text: string,
  opts: MarkupSynthOptions,
  onProgress?: (p: number) => void,
): Promise<AudioBuffer> {
  const parsed = parseVoiceMarkup(text, { rate: opts.rate, pitch: opts.pitch, volume: opts.volume });
  if (!parsed.hasMarkup || parsed.segments.length === 0) {
    return synthesizeSpeech(text, opts, onProgress);
  }

  // Render each non-empty segment; keep a shared sampleRate for stitching.
  const sampleRate = { fast: 16000, balanced: 22050, high: 32000, max: 44100 }[opts.quality] ?? 22050;
  const pieces: AudioBuffer[] = [];
  const renderable = parsed.segments.filter((s) => s.text.length > 0);
  const totalUnits = renderable.length || 1;
  let done = 0;

  for (const seg of parsed.segments) {
    // segments without any speakable characters (stray punctuation between
    // tags) become exact silence instead of a failed synthesis call
    const speakable = /[a-z0-9]/i.test(seg.text);
    if (seg.pauseAfterMs > 0 && (!speakable || seg.text.length === 0)) {
      pieces.push(silenceBuffer(seg.pauseAfterMs / 1000, sampleRate));
    }
    if (speakable) {
      const buf = await synthesizeSpeech(seg.text, {
        profileId: opts.profileId,
        rate: seg.rate,
        pitch: seg.pitch,
        volume: seg.volume,
        quality: opts.quality,
        gapMs: seg.style === 'spell' ? 90 : undefined,
      });
      pieces.push(buf);
      if (seg.pauseAfterMs > 0) pieces.push(silenceBuffer(seg.pauseAfterMs / 1000, sampleRate));
      done++;
      onProgress?.(done / totalUnits);
      await yieldToUI();
    }
  }
  if (pieces.length === 0) return synthesizeSpeech(text, opts, onProgress);
  return concatAll(pieces, sampleRate, 1);
}

/**
 * Strip markup for engines that cannot honor it (AI preview): keep inner text
 * and convert pauses to natural punctuation so delivery stays fluent.
 */
export function stripVoiceMarkup(input: string): string {
  return input
    .replace(PAUSE_RE, ' … ')
    .replace(BREAK_RE, ', ')
    .replace(EM_RE, '$1')
    .replace(RATE_RE, '$2')
    .replace(PITCH_RE, '$2')
    .replace(WHISPER_RE, '$1')
    .replace(SPELL_RE, (_m, g: string) => g.split(/\s*/).join(' '))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Rough duration estimate that accounts for pauses. */
export function estimateMarkupDurationSec(text: string, rate: number): number {
  const parsed = parseVoiceMarkup(text, { rate, pitch: 1, volume: 1 });
  const pauseMs = parsed.segments.reduce((n, s) => n + s.pauseAfterMs, 0);
  const base = estimateSpeechDurationSec(parsed.plainText || text, rate);
  // emphasis/spelling slow things down slightly
  const styled = parsed.segments.filter((s) => s.style !== 'normal').reduce((n, s) => n + s.text.length, 0);
  return base + pauseMs / 1000 + (styled / Math.max(1, (parsed.plainText || text).length || 1)) * base * 0.12;
}
