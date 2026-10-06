// ============================================================
// Openmukti Audiobook Creator — minimal real ZIP reader (DecompressionStream)
// ============================================================

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  offset: number;
  isDir: boolean;
}

function u16(dv: DataView, o: number): number {
  return dv.getUint16(o, true);
}
function u32(dv: DataView, o: number): number {
  return dv.getUint32(o, true);
}

/** Parse ZIP central directory. */
export function parseZip(buf: ArrayBuffer): { entries: ZipEntry[]; warning?: string } {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // find End Of Central Directory (scan backwards, allow comment up to 64k)
  let eocd = -1;
  const minEocd = Math.max(0, buf.byteLength - 65557);
  for (let i = buf.byteLength - 22; i >= minEocd; i--) {
    if (u32(dv, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP archive (no End Of Central Directory found)');
  let entryCount = u16(dv, eocd + 10);
  let cdOffset = u32(dv, eocd + 16);
  let warning: string | undefined;
  // ZIP64 locator
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    const z64 = eocd - 20;
    if (z64 >= 0 && u32(dv, z64) === 0x07064b50) {
      const z64Off = u32(dv, z64 + 8);
      if (u32(dv, z64Off) === 0x06064b50) {
        entryCount = u32(dv, z64Off + 32);
        cdOffset = u32(dv, z64Off + 48);
        warning = 'ZIP64 archive detected — basic support only';
      }
    }
  }
  const entries: ZipEntry[] = [];
  let off = cdOffset;
  for (let i = 0; i < entryCount && off + 46 <= buf.byteLength; i++) {
    if (u32(dv, off) !== 0x02014b50) break;
    const method = u16(dv, off + 10);
    const compressedSize = u32(dv, off + 20);
    const size = u32(dv, off + 24);
    const nameLen = u16(dv, off + 28);
    const extraLen = u16(dv, off + 30);
    const commentLen = u16(dv, off + 32);
    const localOff = u32(dv, off + 42);
    const flags = u16(dv, off + 8);
    const nameBytes = u8.slice(off + 46, off + 46 + nameLen);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'utf-8').decode(nameBytes);
    entries.push({
      name,
      size,
      compressedSize,
      method,
      offset: localOff,
      isDir: name.endsWith('/'),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, warning };
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as unknown as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!CS) throw new Error('DecompressionStream not supported in this browser');
  const ds = new CS('deflate-raw');
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return out;
}

/** Read & decompress a single entry. */
export async function readZipEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const dv = new DataView(buf);
  const off = entry.offset;
  if (u32(dv, off) !== 0x04034b50) throw new Error('Bad local header for ' + entry.name);
  const nameLen = u16(dv, off + 26);
  const extraLen = u16(dv, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const method = u16(dv, off + 8);
  const compressedSize = entry.method === 0 && entry.size === entry.compressedSize
    ? entry.size
    : entry.compressedSize || u32(dv, off + 18);
  if (entry.isDir) return new Uint8Array(0);
  if (method === 0) {
    return new Uint8Array(buf.slice(dataStart, dataStart + entry.size));
  }
  if (method === 8) {
    const raw = new Uint8Array(buf.slice(dataStart, dataStart + compressedSize));
    return inflateRaw(raw);
  }
  throw new Error(`Unsupported ZIP compression method ${method} for ${entry.name}`);
}

export async function readZipEntryText(buf: ArrayBuffer, entry: ZipEntry): Promise<string> {
  const bytes = await readZipEntry(buf, entry);
  return new TextDecoder('utf-8').decode(bytes);
}
