// Local Tesseract LSTM OCR: one bounded CPU worker, no CDN and no GPU.
import type { OcrOptions, OcrResult, OcrTimedLine } from '@/lib/types';
import type { Worker } from 'tesseract.js';

export interface OcrPowerSpec { power: OcrOptions['power']; label: string; maxPixels: number; threads: number; description: string }
const PIXELS = { lite: 800_000, standard: 2_000_000, heavy: 4_000_000, ultra: 6_000_000 };
export function getOcrCapabilities(): { powers: OcrPowerSpec[] } {
  return { powers: (Object.keys(PIXELS) as OcrOptions['power'][]).map(power => ({ power,
    label: power[0].toUpperCase() + power.slice(1), maxPixels: PIXELS[power], threads: 1,
    description: `Local Tesseract LSTM, one CPU worker, ${PIXELS[power] / 1e6} MP page budget.` })) };
}

export async function createLocalOcrWorker(opts: OcrOptions): Promise<Worker> {
  const { createWorker } = await import('tesseract.js');
  const aliases: Record<string, string> = { en: 'eng', hi: 'hin', ja: 'jpn', fr: 'fra', de: 'deu', es: 'spa' };
  const language = aliases[opts.language] || opts.language || 'eng';
  if (!/^[a-z_]{3,12}(?:\+[a-z_]{3,12})*$/i.test(language)) throw new Error('Invalid OCR language code');
  const asset = (s: string) => new URL(`./ocr/${s}`, document.baseURI).href;
  return createWorker(language, 1, { workerPath: asset('worker.min.js'), corePath: asset('core/'),
    langPath: asset('lang/'), gzip: false, workerBlobURL: false,
    logger: m => opts.onProgress?.(Math.min(0.95, Number(m.progress) || 0), `Local OCR: ${m.status}`) });
}

async function recognizeImage(worker: Worker, source: ImageBitmapSource, opts: OcrOptions): Promise<OcrResult> {
  const start = performance.now();
  const owned = !(source instanceof ImageBitmap);
  const bmp = owned ? await createImageBitmap(source) : source;
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, Math.sqrt(PIXELS[opts.power] / (bmp.width * bmp.height)));
    canvas.width = Math.max(1, Math.round(bmp.width * scale)); canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas is unavailable');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (opts.preprocess) {
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < image.data.length; i += 4) {
        const g = image.data[i] * .299 + image.data[i + 1] * .587 + image.data[i + 2] * .114;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = g;
      }
      ctx.putImageData(image, 0, 0);
    }
    const result = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const lines = (result.data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines))
      .filter(l => l.text.trim() && l.confidence / 100 >= opts.minConfidence)
      .map(l => ({ text: l.text.trim(), confidence: l.confidence / 100 }));
    return { text: result.data.text.trim(), lines, regions: lines.length,
      durationMs: performance.now() - start, avgConfidence: result.data.confidence / 100 };
  } finally { if (owned) bmp.close(); canvas.width = canvas.height = 1; }
}
export async function runOcrOnImage(source: ImageBitmapSource, opts: OcrOptions): Promise<OcrResult> {
  const worker = await createLocalOcrWorker(opts);
  try { const result = await recognizeImage(worker, source, opts); opts.onProgress?.(1, 'Local OCR complete'); return result; }
  finally { await worker.terminate(); }
}
export async function runOcrOnVideoFile(file: File, opts: OcrOptions & { sampleFps?: number; maxFrames?: number }): Promise<OcrResult & { framesAnalyzed: number; timedLines: OcrTimedLine[] }> {
  const start = performance.now(), url = URL.createObjectURL(file);
  const video = document.createElement('video'), canvas = document.createElement('canvas');
  let worker: Worker | undefined;
  try {
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Video load timeout')), 12000);
      video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('Video codec is not supported by this browser')); };
      video.src = url;
    });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video has no finite duration');
    const requested = opts.maxFrames ?? ({ lite: 3, standard: 6, heavy: 10, ultra: 16 }[opts.power]);
    const count = Math.max(1, Math.min(120, requested, Math.round(duration * (opts.sampleFps ?? .2))));
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas is unavailable');
    worker = await createLocalOcrWorker(opts);
    const timedLines: OcrTimedLine[] = [];
    for (let index = 0; index < count; index++) {
      const time = Math.min(duration - .01, duration * index / count);
      if (Math.abs(video.currentTime - time) > .001) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', done); };
        const done = () => { cleanup(); resolve(); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Video seek timed out')); }, 8000);
        video.addEventListener('seeked', done); video.currentTime = time;
      });
      // Decoding current time 0 may not have completed at metadata readiness.
      if (video.readyState < 2) await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { video.removeEventListener('loadeddata', done); reject(new Error('Video frame decode timed out')); }, 8000);
        video.addEventListener('loadeddata', done, { once: true });
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const result = await recognizeImage(worker, canvas, opts);
      for (const line of result.lines) {
        const previous = timedLines[timedLines.length - 1];
        if (previous?.text === line.text) previous.endSec = duration * (index + 1) / count;
        else timedLines.push({ ...line, startSec: time, endSec: duration * (index + 1) / count });
      }
      opts.onProgress?.((index + 1) / count, `Frame ${index + 1}/${count}`);
    }
    return { text: timedLines.map(l => l.text).join('\n'), lines: timedLines, timedLines,
      regions: timedLines.length, framesAnalyzed: count, durationMs: performance.now() - start,
      avgConfidence: timedLines.length ? timedLines.reduce((n, l) => n + l.confidence, 0) / timedLines.length : 0 };
  } finally { await worker?.terminate(); video.pause(); video.removeAttribute('src'); video.load(); canvas.width = canvas.height = 1; URL.revokeObjectURL(url); }
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
