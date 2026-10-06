'use client';

// PDF scan fallback for AutoBook. PDF.js renders pages locally; Tesseract.js
// recognizes the rendered page locally with local worker/core/lang assets.
// No PDF/image data is uploaded anywhere.

import type { OcrOptions } from '@/lib/types';
import type { OcrPower } from '@/lib/types';

function assetUrl(relative: string): string {
  return new URL(relative, document.baseURI).href;
}

function renderScale(power: OcrPower): number {
  switch (power) {
    case 'lite': return 1.35;
    case 'heavy': return 2.15;
    case 'ultra': return 2.6;
    default: return 1.8;
  }
}

function preprocessPage(source: HTMLCanvasElement, power: OcrPower): HTMLCanvasElement {
  // Old yellowed paper becomes much easier for OCR after color removal and a
  // gentle contrast lift. Keep grayscale rather than hard thresholding so the
  // recognizer can preserve thin serif strokes.
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  if (!ctx) return source;
  const img = source.getContext('2d')?.getImageData(0, 0, source.width, source.height);
  if (!img) return source;
  const d = img.data;
  const gain = power === 'ultra' ? 1.55 : power === 'heavy' ? 1.42 : 1.32;
  const center = 142;
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const v = Math.max(0, Math.min(255, (g - center) * gain + center));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export async function ocrPdfToText(
  file: File,
  opts: OcrOptions,
): Promise<{ text: string; pages: number; avgConfidence: number }> {
  const onProgress = opts.onProgress;
  if (typeof window === 'undefined') throw new Error('PDF OCR requires a browser.');

  onProgress?.(0.02, 'Loading local PDF renderer…');
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = assetUrl('./pdfjs/pdf.worker.min.mjs');

  const tesseract: any = await import('tesseract.js');
  const worker = await tesseract.createWorker(opts.language || 'eng', 1, {
    workerPath: assetUrl('./ocr/worker.min.js'),
    corePath: assetUrl('./ocr/core/'),
    langPath: assetUrl('./ocr/lang/'),
    gzip: false,
    workerBlobURL: false,
    logger: (m: any) => {
      const pagePart = typeof m.progress === 'number' ? m.progress : 0;
      if (m.status) onProgress?.(0.08 + pagePart * 0.05, `OCR engine: ${m.status}`);
    },
  });

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const chunks: string[] = [];
    let confidenceSum = 0;
    let confidenceCount = 0;
    const scale = renderScale(opts.power);

    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      onProgress?.(0.12 + ((pageNo - 1) / Math.max(1, pdf.numPages)) * 0.84, `OCR page ${pageNo}/${pdf.numPages}…`);
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const prepared = preprocessPage(canvas, opts.power);
      const result = await worker.recognize(prepared);
      const text = String(result?.data?.text ?? '').replace(/\r\n?/g, '\n').trim();
      if (text) chunks.push(text);
      const c = Number(result?.data?.confidence);
      if (Number.isFinite(c)) {
        confidenceSum += c / 100;
        confidenceCount++;
      }
      canvas.width = 1;
      canvas.height = 1;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    onProgress?.(1, `PDF OCR complete — ${pdf.numPages} pages`);
    return {
      text: chunks.join('\n\n'),
      pages: pdf.numPages,
      avgConfidence: confidenceCount ? confidenceSum / confidenceCount : 0,
    };
  } finally {
    await worker.terminate();
  }
}
