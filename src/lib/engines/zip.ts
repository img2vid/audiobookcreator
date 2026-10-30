// Bounded ZIP reader shared by DOCX, ODT, EPUB and archive inspection.
// Pure-JS DEFLATE works even where DecompressionStream('deflate-raw') is absent.
import { Inflate } from 'fflate';
import { yieldToUI } from '@/lib/utils/async';

export interface ZipEntry {
  name: string; size: number; compressedSize: number; method: number;
  offset: number; isDir: boolean; crc32?: number; flags?: number;
}
const MAX_ENTRY = 32 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

export function parseZip(buf: ArrayBuffer): { entries: ZipEntry[]; warning?: string } {
  const view = new DataView(buf), bytes = new Uint8Array(buf);
  const bounds = (off: number, n: number) => {
    if (off < 0 || n < 0 || off + n > buf.byteLength) throw new Error('Truncated or corrupt ZIP archive');
  };
  const u16 = (o: number) => { bounds(o, 2); return view.getUint16(o, true); };
  const u32 = (o: number) => { bounds(o, 4); return view.getUint32(o, true); };
  let end = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === buf.byteLength) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a valid ZIP archive');
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) throw new Error('Multi-volume ZIP archives are not supported');
  const count = u16(end + 10), size = u32(end + 12), start = u32(end + 16);
  if (count === 65535 || start === 0xffffffff || size === 0xffffffff) throw new Error('ZIP64 documents are too large; export a smaller standard ZIP');
  if (count > 10000) throw new Error('Archive has more than 10,000 entries');
  bounds(start, size);
  if (start + size > end) throw new Error('Invalid ZIP central directory');
  const entries: ZipEntry[] = [], names = new Set<string>();
  let off = start, expanded = 0;
  for (let i = 0; i < count; i++) {
    bounds(off, 46);
    if (u32(off) !== 0x02014b50) throw new Error('Corrupt ZIP directory entry');
    const flags = u16(off + 8), method = u16(off + 10), compressedSize = u32(off + 20), entrySize = u32(off + 24);
    const nameLen = u16(off + 28), extraLen = u16(off + 30), commentLen = u16(off + 32), offset = u32(off + 42);
    const next = off + 46 + nameLen + extraLen + commentLen;
    if (next > start + size) throw new Error('ZIP entry exceeds central directory');
    const name = new TextDecoder('utf-8').decode(bytes.subarray(off + 46, off + 46 + nameLen));
    if (flags & 1) throw new Error('Encrypted ZIP documents are not supported. Decrypt the document first.');
    if (entrySize > MAX_ENTRY || (expanded += entrySize) > MAX_EXPANDED) throw new Error('Archive exceeds safe expansion limits (32 MB per entry, 256 MB total)');
    if (names.has(name) || name.includes('\0') || name.replace(/\\/g, '/').split('/').includes('..') || /^[\\/]|^[a-z]:/i.test(name)) throw new Error('Unsafe or duplicate ZIP entry name');
    names.add(name);
    bounds(offset, 30);
    entries.push({ name, flags, method, size: entrySize, compressedSize, offset, isDir: name.endsWith('/'), crc32: u32(off + 16) });
    off = next;
  }
  if (off !== start + size) throw new Error('Unexpected ZIP directory size');
  return { entries };
}

export async function readZipEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(buf), off = entry.offset;
  if (entry.isDir) return new Uint8Array(0);
  if (entry.size > MAX_ENTRY || off < 0 || off + 30 > buf.byteLength || view.getUint32(off, true) !== 0x04034b50) throw new Error('Invalid ZIP local header');
  if (view.getUint16(off + 6, true) & 1 || view.getUint16(off + 8, true) !== entry.method) throw new Error('Encrypted or inconsistent ZIP entry');
  const start = off + 30 + view.getUint16(off + 26, true) + view.getUint16(off + 28, true);
  if (start + entry.compressedSize > buf.byteLength) throw new Error('Truncated ZIP payload');
  const input = new Uint8Array(buf, start, entry.compressedSize);
  let output: Uint8Array;
  if (entry.method === 0) output = input.slice();
  else if (entry.method === 8) {
    const pieces: Uint8Array[] = [];
    let length = 0;
    const inflater = new Inflate(piece => {
      length += piece.length;
      if (length > entry.size || length > MAX_ENTRY) throw new Error('ZIP expansion exceeds the declared size');
      pieces.push(piece);
    });
    for (let i = 0; i < input.length; i += 16384) {
      inflater.push(input.subarray(i, i + 16384), i + 16384 >= input.length);
      await yieldToUI();
    }
    output = new Uint8Array(length);
    let position = 0;
    for (const piece of pieces) { output.set(piece, position); position += piece.length; }
  } else throw new Error(`Unsupported ZIP compression method ${entry.method}`);
  if (output.length !== entry.size) throw new Error('ZIP entry size does not match its directory');
  let crc = 0xffffffff;
  for (const b of output) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  if (entry.crc32 !== undefined && ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error('ZIP checksum mismatch — document is damaged');
  return output;
}
export async function readZipEntryText(buf: ArrayBuffer, entry: ZipEntry): Promise<string> {
  return new TextDecoder('utf-8').decode(await readZipEntry(buf, entry));
}
