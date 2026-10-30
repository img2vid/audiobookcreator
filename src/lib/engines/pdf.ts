// PDF.js resolves font encodings, Unicode CMaps, object streams and page order.
// The old regex scanner could silently reorder or omit text operators.
export interface PdfExtractResult { text: string; pages: number; ok: boolean; warning?: string }
export async function extractPdfText(buf: ArrayBuffer, onProgress?: (p: number) => void): Promise<PdfExtractResult> {
  if (typeof document === 'undefined') throw new Error('PDF extraction requires a browser');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const asset = (name: string) => new URL(`./pdfjs/${name}`, document.baseURI).href;
  pdfjs.GlobalWorkerOptions.workerSrc = asset('pdf.worker.min.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf),
    cMapUrl: asset('cmaps/'), cMapPacked: true, standardFontDataUrl: asset('standard_fonts/'), wasmUrl: asset('wasm/') });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    let empty = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        // Safari/WebKit's ReadableStream may not implement Symbol.asyncIterator.
        // PDF.js getTextContent() uses for-await internally and throws there.
        // Read the same ordered PDF.js text chunks through the portable reader API.
        const reader = page.streamTextContent().getReader();
        let text = '';
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const item of value.items) {
              if (!('str' in item)) continue;
              text += item.str + (item.hasEOL ? '\n' : ' ');
            }
          }
        } finally {
          reader.releaseLock();
        }
        text = text.replace(/[ \t]+\n/g, '\n').trim();
        if (!text) empty++;
        pages.push(text);
      } finally { page.cleanup(); }
      onProgress?.(number / pdf.numPages);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const text = pages.join('\n\n');
    return { text, pages: pdf.numPages, ok: !!text.trim(), ...(empty ? { warning: `${empty} page(s) have no text layer; use OCR for scanned pages.` } : {}) };
  } catch (err) {
    if (err instanceof Error && err.name === 'PasswordException') return { text: '', pages: 0, ok: false, warning: 'This PDF requires a password. Export a decrypted copy before importing.' };
    throw err;
  } finally { await task.destroy(); }
}
