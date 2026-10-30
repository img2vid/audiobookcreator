/** Streaming ZIP32 writer (stored entries). One input blob is live at a time. */
export interface ZipSource { name: string; blob: Blob }
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const bytes = (length: number) => new Uint8Array(length);
const checkSize = (n: number) => { if (n > 0xffffffff) throw new Error('ZIP32 limit reached. Download individual chapters instead.'); };

export async function* zipFiles(sources: AsyncIterable<ZipSource>): AsyncGenerator<Uint8Array> {
  let position = 0;
  const central: Uint8Array[] = [];
  const emit = (b: Uint8Array) => { position += b.length; checkSize(position); return b; };
  for await (const { name, blob } of sources) {
    if (central.length >= 65534) throw new Error('Too many ZIP entries');
    checkSize(blob.size);
    const filename = new TextEncoder().encode(name);
    if (filename.length > 65535 || name.split('/').includes('..') || name.startsWith('/')) throw new Error('Invalid ZIP filename');
    const offset = position;
    const header = bytes(30 + filename.length), hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true); hv.setUint16(4, 20, true);
    hv.setUint16(6, 0x808, true); hv.setUint16(12, 33, true); hv.setUint16(26, filename.length, true); header.set(filename, 30);
    yield emit(header);
    let crc = 0xffffffff;
    const reader = blob.stream().getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const b of value) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
        yield emit(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = bytes(16), dv = new DataView(descriptor.buffer);
    dv.setUint32(0, 0x08074b50, true); dv.setUint32(4, crc, true);
    dv.setUint32(8, blob.size, true); dv.setUint32(12, blob.size, true); yield emit(descriptor);
    const entry = bytes(46 + filename.length), ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true); ev.setUint16(4, 20, true); ev.setUint16(6, 20, true);
    ev.setUint16(8, 0x808, true); ev.setUint16(14, 33, true); ev.setUint32(16, crc, true);
    ev.setUint32(20, blob.size, true); ev.setUint32(24, blob.size, true);
    ev.setUint16(28, filename.length, true); ev.setUint32(42, offset, true); entry.set(filename, 46); central.push(entry);
  }
  const cdOffset = position;
  for (const entry of central) yield emit(entry);
  const end = bytes(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, position - cdOffset, true); ev.setUint32(16, cdOffset, true); yield emit(end);
}
