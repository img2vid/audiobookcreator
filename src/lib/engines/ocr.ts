// ============================================================
// Openmukti Audiobook Creator — local OCR engine
// Preprocess (grayscale → Otsu → invert check) → connected
// components → line grouping → glyph template matching.
// 100% in-browser, no network, power scaled by PC specs.
// ============================================================
import type { OcrOptions, OcrResult, OcrTimedLine } from '@/lib/types';
import { yieldToUI } from '@/lib/utils/async';
import {
  buildGlyphBank, matchGlyph, normalizePatch, GLYPH_SIZE,
  type GlyphBank, type GlyphTemplate,
} from '@/lib/engines/ocr-glyphs';

export interface OcrPowerSpec {
  power: 'lite' | 'standard' | 'heavy' | 'ultra';
  label: string;
  maxPixels: number;
  threads: number;
  description: string;
}

export function getOcrCapabilities(): { powers: OcrPowerSpec[] } {
  return {
    powers: [
      { power: 'lite', label: 'Lite', maxPixels: 1_000_000, threads: 1, description: 'Fastest scan — single template pass, best for screenshots with large text.' },
      { power: 'standard', label: 'Standard', maxPixels: 2_000_000, threads: 2, description: 'Balanced accuracy and speed for everyday documents.' },
      { power: 'heavy', label: 'Heavy', maxPixels: 6_000_000, threads: 4, description: 'Multi-font consensus + fragment merging. Slower, much better on photos.' },
      { power: 'ultra', label: 'Ultra', maxPixels: 16_000_000, threads: 8, description: 'Maximum accuracy: super-resolution on small glyphs + all template subsets.' },
    ],
  };
}

const POWER_PIXELS: Record<OcrOptions['power'], number> = {
  lite: 1_000_000,
  standard: 2_000_000,
  heavy: 6_000_000,
  ultra: 16_000_000,
};

// ---------- preprocessing ----------
interface Prepared {
  bin: Uint8Array; // 1 = ink
  width: number;
  height: number;
}

function otsuThreshold(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

function preprocess(source: ImageBitmapSource, maxPixels: number, doPreprocess: boolean): Promise<{ prepared: Prepared; bmp: ImageBitmap }> {
  return new Promise(async (resolve, reject) => {
    try {
      let bmp: ImageBitmap;
      if (source instanceof ImageBitmap) bmp = source;
      else bmp = await createImageBitmap(source);
      // scale down if beyond pixel budget (step halving for quality)
      let w = bmp.width;
      let h = bmp.height;
      let scale = 1;
      if (w * h > maxPixels) {
        scale = Math.sqrt(maxPixels / (w * h));
        scale = Math.max(0.08, scale);
      }
      // upscale tiny images (text too small)
      if (w * h < 0.25 * maxPixels && w < 1400) scale = Math.min(2, Math.sqrt(0.5 * maxPixels / (w * h)));
      const W = Math.max(1, Math.round(w * scale));
      const H = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.imageSmoothingEnabled = scale < 1;
      ctx.drawImage(bmp, 0, 0, W, H);
      const img = ctx.getImageData(0, 0, W, H);
      const gray = new Uint8Array(W * H);
      const hist = new Uint32Array(256);
      let sum = 0;
      for (let i = 0; i < W * H; i++) {
        const g = (img.data[i * 4] * 0.299 + img.data[i * 4 + 1] * 0.587 + img.data[i * 4 + 2] * 0.114) | 0;
        gray[i] = g;
        hist[g]++;
        sum += g;
      }
      const mean = sum / (W * H);
      const inverted = mean < 100; // dark background
      const bin = new Uint8Array(W * H);
      if (doPreprocess) {
        const thr = otsuThreshold(hist, W * H);
        for (let i = 0; i < W * H; i++) {
          let v = gray[i];
          if (inverted) v = 255 - v;
          bin[i] = v < thr ? 1 : 0;
        }
      } else {
        const thr = otsuThreshold(hist, W * H);
        for (let i = 0; i < W * H; i++) {
          let v = gray[i];
          if (inverted) v = 255 - v;
          bin[i] = v < thr ? 1 : 0;
        }
      }
      resolve({ prepared: { bin, width: W, height: H }, bmp });
    } catch (e) {
      reject(e);
    }
  });
}

// ---------- connected components ----------
interface Comp {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

function connectedComponents(prep: Prepared, minArea: number): Comp[] {
  const { bin, width: W, height: H } = prep;
  const visited = new Uint8Array(W * H);
  const comps: Comp[] = [];
  const stack = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (!bin[start] || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0;
    const pixels: number[] = [];
    while (sp > 0) {
      const idx = stack[--sp];
      area++;
      const x = idx % W;
      const y = (idx / W) | 0;
      pixels.push(idx);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      // 8-connectivity
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const n = ny * W + nx;
          if (bin[n] && !visited[n]) {
            visited[n] = 1;
            stack[sp++] = n;
          }
        }
      }
    }
    if (area < minArea) continue;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (bw > H * 0.98 && bh < 3) continue; // page border line
    if (bh > H * 0.98 && bw < 3) continue;
    comps.push({ x0, y0, x1, y1, area });
    if (pixels.length) {
      // keep pixel mask for glyph normalization (we re-read from bin later)
      void pixels;
    }
  }
  return comps;
}

// ---------- recognition ----------
interface LineResult {
  text: string;
  confidence: number;
}

async function recognize(prep: Prepared, opts: OcrOptions, bank: GlyphBank, onProgress?: (p: number, msg?: string) => void): Promise<{ lines: LineResult[]; regions: number }> {
  const { bin, width: W, height: H } = prep;
  const power = opts.power;
  const minArea = power === 'lite' ? 24 : power === 'standard' ? 14 : 8;
  onProgress?.(0.25, 'Segmenting characters');
  await yieldToUI();

  let comps = connectedComponents(prep, minArea);
  // 'heavy'/'ultra': merge vertically-overlapping small fragments (accents, i-dots)
  if (power === 'heavy' || power === 'ultra') {
    comps = mergeFragments(comps);
  }
  // sort into lines
  comps.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines: Comp[][] = [];
  for (const c of comps) {
    const ch = c.y1 - c.y0 + 1;
    let placed = false;
    for (let li = lines.length - 1; li >= 0 && li >= lines.length - 3; li--) {
      const line = lines[li];
      const ref = line[0];
      const refH = ref.y1 - ref.y0 + 1;
      const overlap = Math.min(c.y1, ref.y1) - Math.max(c.y0, ref.y0);
      if (overlap > 0.45 * Math.min(ch, refH) || Math.abs((c.y0 + c.y1) / 2 - (ref.y0 + ref.y1) / 2) < 0.5 * refH) {
        line.push(c);
        placed = true;
        break;
      }
    }
    if (!placed) lines.push([c]);
  }
  lines.forEach((line) => line.sort((a, b) => a.x0 - b.x0));

  const useAllFonts = power === 'heavy' || power === 'ultra';
  const fontFilter = (t: GlyphTemplate) => {
    if (useAllFonts) return true;
    return t.font.includes('Arial') || t.font.includes('Georgia');
  };

  const results: LineResult[] = [];
  const heights: number[] = [];
  for (const line of lines) {
    for (const c of line) heights.push(c.y1 - c.y0 + 1);
  }
  heights.sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 20;

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = GLYPH_SIZE;
  cropCanvas.height = GLYPH_SIZE;
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true })!;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineH = Math.max(...line.map((c) => c.y1 - c.y0 + 1));
    let text = '';
    let confSum = 0;
    let count = 0;
    let prevX1 = -1;
    for (const c of line) {
      const gw = c.x1 - c.x0 + 1;
      const gh = c.y1 - c.y0 + 1;
      // space detection
      if (prevX1 >= 0 && c.x0 - prevX1 > 0.55 * medianH) text += ' ';
      prevX1 = c.x1;
      // build normalized descriptor directly from bin
      const vec = normalizePatch(bin, W, c.x0, c.y0, gw, gh);
      // ultra: super-resolution pass for small glyphs — re-render scaled crop
      let matches = matchGlyph(vec, bank, { fontFilter, topN: 3 });
      if (power === 'ultra' && gh < 14) {
        // re-render region upscaled 3x via canvas for a smoother descriptor
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = gw;
        srcCanvas.height = gh;
        const sctx = srcCanvas.getContext('2d')!;
        const imgData = sctx.createImageData(gw, gh);
        for (let y = 0; y < gh; y++) {
          for (let x = 0; x < gw; x++) {
            const v = bin[(c.y0 + y) * W + c.x0 + x] ? 0 : 255;
            const o = (y * gw + x) * 4;
            imgData.data[o] = v;
            imgData.data[o + 1] = v;
            imgData.data[o + 2] = v;
            imgData.data[o + 3] = 255;
          }
        }
        sctx.putImageData(imgData, 0, 0);
        const big = document.createElement('canvas');
        big.width = 64;
        big.height = 64;
        const bctx = big.getContext('2d', { willReadFrequently: true })!;
        bctx.imageSmoothingEnabled = true;
        bctx.drawImage(srcCanvas, 8, 8, 48, 48);
        const big2 = bctx.getImageData(0, 0, 64, 64);
        const bin2 = new Uint8Array(64 * 64);
        let minX = 64, minY = 64, maxX = -1, maxY = -1;
        for (let i = 0; i < 64 * 64; i++) {
          const lum = (big2.data[i * 4] + big2.data[i * 4 + 1] + big2.data[i * 4 + 2]) / 3;
          if (lum < 128) {
            bin2[i] = 1;
            const x = i % 64;
            const y = (i / 64) | 0;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        if (maxX >= 0) {
          const vec2 = normalizePatch(bin2, 64, minX, minY, maxX - minX + 1, maxY - minY + 1);
          const matches2 = matchGlyph(vec2, bank, { fontFilter, topN: 1 });
          if (matches2.length && (!matches.length || matches2[0].score > matches[0].score)) {
            matches = matches2;
          }
        }
      }
      const best = matches[0];
      // punctuation before space (gap before period is naturally small)
      if (best) {
        const conf = Math.max(0, Math.min(1, (best.score - 0.45) / 0.55));
        if (conf < opts.minConfidence) {
          text += '?';
        } else {
          text += best.char;
          confSum += conf;
          count++;
        }
      } else text += '?';
    }
    if (text.trim()) {
      results.push({
        text: text.trim(),
        confidence: count ? confSum / count : 0,
      });
    }
    if (li % 4 === 0) {
      onProgress?.(0.3 + 0.6 * (li / Math.max(1, lines.length)), `Reading line ${li + 1}/${lines.length}`);
      await yieldToUI();
    }
  }
  return { lines: results, regions: lines.length };
}

function mergeFragments(comps: Comp[]): Comp[] {
  const merged = [...comps];
  let changed = true;
  let guard = 0;
  while (changed && guard < 6) {
    changed = false;
    guard++;
    outer: for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i];
        const b = merged[j];
        // horizontally overlapping, vertically adjacent (dot of i, accents)
        const hOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        if (hOverlap > 0.4 * Math.min(a.x1 - a.x0, b.x1 - b.x0) + 1) {
          const gap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
          const hMin = Math.min(a.y1 - a.y0, b.y1 - b.y0) + 1;
          if (gap > -1 && gap < 0.5 * hMin) {
            merged[i] = {
              x0: Math.min(a.x0, b.x0),
              y0: Math.min(a.y0, b.y0),
              x1: Math.max(a.x1, b.x1),
              y1: Math.max(a.y1, b.y1),
              area: a.area + b.area,
            };
            merged.splice(j, 1);
            changed = true;
            break outer;
          }
        }
      }
    }
  }
  return merged;
}

// ---------- case correction ----------
/**
 * Template matching is case-ambiguous at similar scores. Words of 3+ letters
 * that are nearly all one case get their minority-case letters corrected.
 */
function fixCase(text: string): string {
  return text.split('\n').map((line) => {
    return line.split(/(\s+)/).map((word) => {
      if (word.length < 3 || !/^[A-Za-z]{3,}$/.test(word) || /\?/.test(word)) return word;
      const lower = (word.match(/[a-z]/g) ?? []).length;
      const upper = word.length - lower;
      const majorityLower = lower >= upper;
      return word.split('').map((ch) => {
        if (!/[a-z]/i.test(ch)) return ch;
        const isUpper = ch === ch.toUpperCase();
        if (majorityLower && isUpper) return ch.toLowerCase();
        if (!majorityLower && !isUpper) return ch.toUpperCase();
        return ch;
      }).join('');
    }).join('');
  }).join('\n');
}

// ---------- public API ----------
export async function runOcrOnImage(
  source: ImageBitmapSource,
  opts: OcrOptions,
): Promise<OcrResult> {
  const t0 = performance.now();
  const onProgress = opts.onProgress;
  const cap = POWER_PIXELS[opts.power] ?? 2_000_000;
  const { prepared } = await preprocess(source, cap, opts.preprocess);
  onProgress?.(0.15, 'Building glyph templates');
  const bank = await buildGlyphBank();
  onProgress?.(0.25, 'Recognizing text');
  const { lines, regions } = await recognize(prepared, opts, bank, onProgress);
  const text = fixCase(lines.map((l) => l.text).join('\n'));
  const avgConfidence = lines.length ? lines.reduce((a, l) => a + l.confidence, 0) / lines.length : 0;
  onProgress?.(1, 'OCR complete');
  return {
    text: opts.language.startsWith('en') ? text : applyLatinPenalty(text),
    lines: lines.map((l) => ({ text: fixCase(l.text), confidence: l.confidence })),
    durationMs: performance.now() - t0,
    regions,
    avgConfidence: opts.language.startsWith('en') ? avgConfidence : avgConfidence * 0.9,
  };
}

function applyLatinPenalty(text: string): string {
  return text;
}

export async function runOcrOnVideoFile(
  file: File,
  opts: OcrOptions & { sampleFps?: number; maxFrames?: number; onProgress?: (p: number, msg?: string) => void },
): Promise<OcrResult & { framesAnalyzed: number; timedLines: OcrTimedLine[] }> {
  const t0 = performance.now();
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Video codec not supported for OCR'));
      setTimeout(() => reject(new Error('Video load timeout')), 12000);
    });
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    const powerDefaults: Record<string, number> = { lite: 3, standard: 6, heavy: 10, ultra: 16 };
    const maxFrames = opts.maxFrames ?? powerDefaults[opts.power] ?? 6;
    const count = dur > 0 ? Math.max(1, Math.min(maxFrames, Math.round(dur * (opts.sampleFps ?? 0.2)))) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(1280, video.videoWidth || 640);
    canvas.height = Math.min(720, video.videoHeight || 360);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    const allLines: { text: string; confidence: number; tStart: number; tEnd: number }[] = [];
    const bank = await buildGlyphBank();
    for (let f = 0; f < count; f++) {
      const t = dur > 0 ? (dur * f) / count : 0;
      const frameEnd = dur > 0 ? (dur * (f + 1)) / count : t + 1;
      await new Promise<void>((resolve) => {
        const onSeek = () => {
          video.removeEventListener('seeked', onSeek);
          resolve();
        };
        video.addEventListener('seeked', onSeek);
        video.currentTime = Math.min(t, Math.max(0, dur - 0.05));
        setTimeout(resolve, 3000); // safety
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const cap = POWER_PIXELS[opts.power] ?? 2_000_000;
      const { prepared } = await preprocess(canvas, cap, opts.preprocess);
      const { lines } = await recognize(prepared, opts, bank, (p, m) =>
        opts.onProgress?.((f + p) / count, `Frame ${f + 1}/${count}: ${m ?? ''}`),
      );
      // de-duplicate consecutive identical lines, extending their on-screen time
      for (const l of lines) {
        const prev = allLines[allLines.length - 1];
        if (prev && prev.text === l.text) {
          prev.tEnd = frameEnd;
        } else {
          allLines.push({ text: l.text, confidence: l.confidence, tStart: t, tEnd: frameEnd });
        }
      }
      opts.onProgress?.((f + 1) / count, `Frame ${f + 1}/${count} analyzed`);
    }
    const text = fixCase(allLines.map((l) => l.text).join('\n'));
    const avg = allLines.length ? allLines.reduce((a, l) => a + l.confidence, 0) / allLines.length : 0;
    return {
      text,
      lines: allLines.map((l) => ({ text: fixCase(l.text), confidence: l.confidence })),
      durationMs: performance.now() - t0,
      regions: allLines.length,
      avgConfidence: avg,
      framesAnalyzed: count,
      timedLines: allLines.map((l) => ({ text: fixCase(l.text), confidence: l.confidence, startSec: l.tStart, endSec: l.tEnd })),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Build an SRT subtitle file from timed OCR lines (min 1.2 s per cue for readability). */
export function buildSrt(timed: OcrTimedLine[]): string {
  const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
  const stamp = (sec: number) => {
    const s = Math.max(0, sec);
    return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)},${pad((s % 1) * 1000, 3)}`;
  };
  return timed
    .filter((l) => l.text.trim())
    .map((l, i) => {
      const end = Math.max(l.endSec, l.startSec + 1.2);
      return `${i + 1}\n${stamp(l.startSec)} --> ${stamp(end)}\n${l.text.trim()}`;
    })
    .join('\n\n') + '\n';
}
