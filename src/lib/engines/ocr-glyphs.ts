// ============================================================
// Openmukti Audiobook Creator — OCR glyph template bank
// Renders reference glyphs from system fonts on canvas, normalizes
// to 24x24 descriptors, and matches via cosine similarity.
// ============================================================

export interface GlyphTemplate {
  char: string;
  vec: Float32Array; // 576 floats (24x24)
  font: string;
  weight: string;
}

export interface GlyphBank {
  templates: GlyphTemplate[];
  fonts: string[];
  chars: string[];
}

export const GLYPH_SIZE = 24;

export const OCR_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,!?\'"()-[]:;/@#$%&*+=_';

const FONT_STACKS = [
  'Arial, "Helvetica Neue", sans-serif',
  'Georgia, "Times New Roman", serif',
  '"Courier New", monospace',
  '"Times New Roman", Times, serif',
  'Verdana, Geneva, sans-serif',
  '"Trebuchet MS", Tahoma, sans-serif',
  '"Segoe UI", Roboto, sans-serif',
];
const WEIGHTS = ['normal', 'bold'];

let bankCache: GlyphBank | null = null;
let building: Promise<GlyphBank> | null = null;

/** Render one glyph to a normalized 24x24 Float32 descriptor. */
export function renderGlyphToVec(
  char: string,
  font: string,
  weight: string,
  size = 48,
): Float32Array | null {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#fff';
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textBaseline = 'alphabetic';
  const metrics = ctx.measureText(char);
  const w = Math.ceil(metrics.width);
  if (w <= 0) return null;
  ctx.fillText(char, 2, 50);
  const img = ctx.getImageData(0, 0, 64, 64);
  // binarize + tight crop
  let minX = 64, minY = 64, maxX = -1, maxY = -1;
  const bin = new Uint8Array(64 * 64);
  for (let i = 0; i < 64 * 64; i++) {
    const lum = (img.data[i * 4] + img.data[i * 4 + 1] + img.data[i * 4 + 2]) / 3;
    if (lum > 128) {
      bin[i] = 1;
      const x = i % 64;
      const y = (i / 64) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const gw = maxX - minX + 1;
  const gh = maxY - minY + 1;
  return normalizePatch(bin, 64, minX, minY, gw, gh);
}

/** Normalize a binarized patch (crop → aspect-preserving scale → center) into 24x24 floats 0..1. */
export function normalizePatch(
  bin: Uint8Array,
  stride: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): Float32Array {
  const out = new Float32Array(GLYPH_SIZE * GLYPH_SIZE);
  if (w <= 0 || h <= 0) return out;
  const scale = Math.min(GLYPH_SIZE / w, GLYPH_SIZE / h);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const ox = Math.floor((GLYPH_SIZE - dw) / 2);
  const oy = Math.floor((GLYPH_SIZE - dh) / 2);
  for (let y = 0; y < dh; y++) {
    const sy = y0 + Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < dw; x++) {
      const sx = x0 + Math.min(w - 1, Math.floor(x / scale));
      const v = bin[sy * stride + sx];
      if (v) {
        const dy = oy + y;
        const dx = ox + x;
        out[dy * GLYPH_SIZE + dx] = 1;
      }
    }
  }
  return out;
}

/** Build (and cache) the glyph template bank. */
export function buildGlyphBank(): Promise<GlyphBank> {
  if (bankCache) return Promise.resolve(bankCache);
  if (building) return building;
  building = new Promise<GlyphBank>((resolve) => {
    const templates: GlyphTemplate[] = [];
    const chars = OCR_CHARS.split('');
    for (const font of FONT_STACKS) {
      for (const weight of WEIGHTS) {
        for (const char of chars) {
          const vec = renderGlyphToVec(char, font, weight);
          if (vec) templates.push({ char, vec, font, weight });
        }
      }
    }
    bankCache = { templates, fonts: FONT_STACKS, chars };
    building = null;
    resolve(bankCache);
  });
  return building;
}

/** Cosine similarity between two unit-normalized vectors. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface GlyphMatch {
  char: string;
  score: number;
}

/** Match a glyph descriptor against the bank, optionally restricted to font subsets. */
export function matchGlyph(
  vec: Float32Array,
  bank: GlyphBank,
  opts?: { fontFilter?: (t: GlyphTemplate) => boolean; topN?: number },
): GlyphMatch[] {
  const topN = opts?.topN ?? 3;
  const best = new Map<string, number>();
  for (const t of bank.templates) {
    if (opts?.fontFilter && !opts.fontFilter(t)) continue;
    const score = cosine(vec, t.vec);
    const prev = best.get(t.char);
    if (prev === undefined || score > prev) best.set(t.char, score);
  }
  return Array.from(best.entries())
    .map(([char, score]) => ({ char, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

export const GLYPH_BANK_INFO = () => ({
  chars: OCR_CHARS.length,
  fonts: FONT_STACKS.length,
  weights: WEIGHTS.length,
  templates: bankCache?.templates.length ?? 0,
});
