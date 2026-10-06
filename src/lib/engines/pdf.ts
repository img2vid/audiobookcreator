// ============================================================
// Openmukti Audiobook Creator — best-effort local PDF text extraction
// Handles uncompressed and FlateDecode streams; detects encryption.
// ============================================================
import { yieldToUI } from '@/lib/utils/async';

export interface PdfExtractResult {
  text: string;
  pages: number;
  ok: boolean;
  warning?: string;
}

async function inflateDeflate(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as unknown as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!CS) return null;
  for (const fmt of ['deflate', 'deflate-raw'] as const) {
    try {
      const ds = new CS(fmt);
      const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // try next format
    }
  }
  return null;
}

function decodePdfString(raw: Uint8Array): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (b === 0x5c && i + 1 < raw.length) {
      // escape
      const n = raw[++i];
      switch (n) {
        case 0x6e: out += '\n'; break;
        case 0x72: out += '\r'; break;
        case 0x74: out += '\t'; break;
        case 0x62: out += ''; break;
        case 0x66: out += ''; break;
        default:
          if (n >= 0x30 && n <= 0x37) {
            // octal up to 3 digits
            let oct = String.fromCharCode(n);
            while (oct.length < 3 && i + 1 < raw.length && raw[i + 1] >= 0x30 && raw[i + 1] <= 0x37) {
              oct += String.fromCharCode(raw[++i]);
            }
            out += String.fromCharCode(parseInt(oct, 8));
          } else {
            out += String.fromCharCode(n);
          }
      }
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

function decodeHexString(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  // detect UTF-16BE (common for PDFs)
  if (clean.length % 4 === 0 && clean.startsWith('feff')) {
    for (let i = 4; i + 3 < clean.length; i += 4) {
      out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
    }
    return out;
  }
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

/** Extract text operators from a decoded content stream. */
function extractFromContentStream(content: string): string {
  let out = '';
  // TJ arrays: [(str) num (str)] TJ
  const tjArray = /\[((?:[^\[\]\\]|\\.)*)\]\s*TJ/g;
  // (str) Tj / ' / "
  const tj = /\(((?:[^()\\]|\\.|\\)*)\)\s*(?:Tj|')/g;
  const tjQuote = /\(((?:[^()\\]|\\.)*)\)\s*"/g;
  const hexTj = /<([0-9a-fA-F\s]+)>\s*(?:Tj|')/g;
  // line moves → newline
  let m: RegExpExecArray | null;

  const lastIndexOf = (s: string) => s.length;
  void lastIndexOf;

  while ((m = tjArray.exec(content)) !== null) {
    const inner = m[1];
    const re = /\(((?:[^()\\]|\\.)*)\)|<([0-9a-fA-F\s]+)>/g;
    let s: RegExpExecArray | null;
    while ((s = re.exec(inner)) !== null) {
      out += s[1] !== undefined ? decodePdfString(new TextEncoder().encode(s[1])) : decodeHexString(s[2] ?? '');
    }
    out += ' ';
  }
  while ((m = tj.exec(content)) !== null) out += decodePdfString(new TextEncoder().encode(m[1])) + ' ';
  while ((m = tjQuote.exec(content)) !== null) out += decodePdfString(new TextEncoder().encode(m[1])) + '\n';
  while ((m = hexTj.exec(content)) !== null) out += decodeHexString(m[1]) + ' ';
  // BT/ET and Td/TD/T* → line breaks approximated
  out = out.replace(/\r/g, '\n');
  return out;
}

export async function extractPdfText(
  buf: ArrayBuffer,
  onProgress?: (p: number) => void,
): Promise<PdfExtractResult> {
  const u8 = new Uint8Array(buf);
  const latin = new TextDecoder('latin1');
  const head = latin.decode(u8.slice(0, Math.min(u8.length, 4096)));
  if (!head.startsWith('%PDF')) {
    return { text: '', pages: 0, ok: false, warning: 'Not a PDF file' };
  }
  if (/\/Encrypt\b/.test(latin.decode(u8.slice(0, Math.min(u8.length, 2_000_000))))) {
    return { text: '', pages: 0, ok: false, warning: 'PDF is encrypted — local extraction blocked. Try OCR mode.' };
  }

  // count pages
  const sampleForPages = latin.decode(u8.slice(0, Math.min(u8.length, 4_000_000)));
  const pageMatches = sampleForPages.match(/\/Type\s*\/Page[^s]/g);
  const pages = pageMatches ? pageMatches.length : 0;

  // find stream objects
  const results: string[] = [];
  const decoder = new TextDecoder('latin1');
  let searchPos = 0;
  const maxStreams = 4000;
  let processed = 0;
  const limit = Math.min(u8.length, 60_000_000); // cap 60MB scan

  while (searchPos < limit && processed < maxStreams) {
    const chunkStr = decoder.decode(u8.slice(searchPos, Math.min(searchPos + 4_000_000, limit)));
    const streamIdx = chunkStr.indexOf('stream');
    if (streamIdx < 0) break;
    const absStream = searchPos + streamIdx;
    const endIdx = chunkStr.indexOf('endstream', streamIdx);
    if (endIdx < 0) break;
    const absEnd = searchPos + endIdx;
    // locate dict before 'stream'
    const dictStart = Math.max(0, absStream - 3000);
    const dict = decoder.decode(u8.slice(dictStart, absStream));
    const isFlate = /\/FlateDecode/.test(dict);
    const isImage = /\/Subtype\s*\/Image|\/Image\b/.test(dict);
    const hasTextOps = /\/Contents|\/Page\b/.test(dict) || !isImage;
    // data between EOL after 'stream' and 'endstream'
    let dataStart = absStream + 'stream'.length;
    if (u8[dataStart] === 0x0d) dataStart++;
    if (u8[dataStart] === 0x0a) dataStart++;
    const raw = u8.slice(dataStart, absEnd);
    if (!isImage && hasTextOps && raw.length > 8) {
      let content: string | null = null;
      if (isFlate) {
        const inflated = await inflateDeflate(raw);
        if (inflated) {
          content = latin.decode(inflated);
          if (/(\)\s*Tj|\]\s*TJ|Tm|BT)/.test(content)) {
            results.push(extractFromContentStream(content));
          }
        }
      } else {
        content = decoder.decode(raw);
        if (/(\)\s*Tj|\]\s*TJ|BT)/.test(content)) {
          results.push(extractFromContentStream(content));
        }
      }
    }
    processed++;
    searchPos = absEnd + 9;
    onProgress?.(Math.min(0.95, searchPos / limit));
    if (processed % 24 === 0) await yieldToUI();
  }

  let text = results.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  let ok = text.length > 0;
  let warning: string | undefined;
  if (!ok) {
    warning = 'No extractable text layer found (scanned or vector-only PDF). Use OCR mode on rendered pages.';
  }
  // CIDs / garbage check: if mostly non-ascii control chars, fail gracefully
  const printable = text.replace(/[^\x20-\x7E\n]/g, '').length;
  if (ok && printable / Math.max(1, text.length) < 0.5) {
    warning = 'PDF uses embedded CID fonts that could not be mapped — text may be garbled. OCR mode recommended.';
    if (printable / Math.max(1, text.length) < 0.3) {
      text = '';
      ok = false;
    }
  }
  onProgress?.(1);
  return { text, pages, ok, warning };
}
