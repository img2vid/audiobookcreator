// ============================================================
// Openmukti Audiobook Creator — binary intelligence: strings, entropy, hex, magic
// ============================================================

export function extractStrings(
  bytes: Uint8Array,
  opts?: { minLen?: number; maxStrings?: number; includeUtf16?: boolean },
): string[] {
  const minLen = opts?.minLen ?? 6;
  const max = opts?.maxStrings ?? 4000;
  const includeUtf16 = opts?.includeUtf16 ?? true;
  const out: string[] = [];
  let run = '';
  const flush = () => {
    if (run.length >= minLen) out.push(run);
    run = '';
  };
  const n = bytes.length;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b >= 32 && b < 127) {
      run += String.fromCharCode(b);
      if (run.length > 4096) flush();
    } else {
      flush();
    }
    if (out.length >= max) break;
  }
  flush();
  if (includeUtf16 && out.length < max) {
    // UTF-16LE detection: printable pairs
    let run16 = '';
    for (let i = 0; i + 1 < n && out.length < max; i += 2) {
      const lo = bytes[i];
      const hi = bytes[i + 1];
      if (hi === 0 && lo >= 32 && lo < 127) {
        run16 += String.fromCharCode(lo);
        if (run16.length > 2048) {
          if (run16.length >= minLen) out.push(run16);
          run16 = '';
        }
      } else {
        if (run16.length >= Math.max(minLen, 8)) out.push(run16);
        run16 = '';
        if (hi > 0 && hi < 127) i -= 1; // resync for BE-ish data
      }
    }
    if (run16.length >= Math.max(minLen, 8)) out.push(run16);
  }
  return out;
}

export function shannonEntropy(bytes: Uint8Array, sampleSize = 262144): number {
  const n = Math.min(bytes.length, sampleSize);
  if (n === 0) return 0;
  const freq = new Uint32Array(256);
  const step = Math.max(1, Math.floor(bytes.length / n));
  let count = 0;
  for (let i = 0; i < bytes.length && count < n; i += step) {
    freq[bytes[i]]++;
    count++;
  }
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (freq[i] === 0) continue;
    const p = freq[i] / count;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function hexDump(bytes: Uint8Array, maxLines = 64): string {
  const lines: string[] = [];
  const rows = Math.min(Math.ceil(bytes.length / 16), maxLines);
  for (let r = 0; r < rows; r++) {
    const off = r * 16;
    let hex = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      const b = bytes[off + i];
      if (b === undefined) {
        hex += '   ';
        ascii += ' ';
      } else {
        hex += b.toString(16).padStart(2, '0') + ' ';
        ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
      }
    }
    lines.push(off.toString(16).padStart(8, '0') + '  ' + hex + ' ' + ascii);
  }
  if (bytes.length > maxLines * 16) lines.push(`… (${bytes.length - maxLines * 16} more bytes)`);
  return lines.join('\n');
}

const MAGIC: [Uint8Array | number[], string, string][] = [
  [[0x50, 0x4b, 0x03, 0x04], 'ZIP archive', 'Contains compressed entries (documents, JARs, APKs, OOXML files)'],
  [[0x25, 0x50, 0x44, 0x46], 'PDF document', 'Portable Document Format'],
  [[0x89, 0x50, 0x4e, 0x47], 'PNG image', 'Portable Network Graphics'],
  [[0xff, 0xd8, 0xff], 'JPEG image', 'JFIF/EXIF bitmap'],
  [[0x47, 0x49, 0x46, 0x38], 'GIF image', 'Graphics Interchange Format'],
  [[0x52, 0x49, 0x46, 0x46], 'RIFF container', 'WAV/AVI/WEBP family'],
  [[0x49, 0x44, 0x33], 'MP3 audio', 'ID3 tagged MPEG audio'],
  [[0x4f, 0x67, 0x67, 0x53], 'Ogg container', 'Vorbis/Opus/Theora media'],
  [[0x66, 0x4c, 0x61, 0x43], 'FLAC audio', 'Free Lossless Audio Codec'],
  [[0x7f, 0x45, 0x4c, 0x46], 'ELF binary', 'Linux/Unix executable or library'],
  [[0x4d, 0x5a], 'Windows PE binary', 'EXE / DLL / driver'],
  [[0xcf, 0xfa, 0xed, 0xfe], 'Mach-O binary', 'macOS executable'],
  [[0xca, 0xfe, 0xba, 0xbe], 'Java class', 'JVM bytecode'],
  [[0x00, 0x61, 0x73, 0x6d], 'WebAssembly', 'WASM binary module'],
  [[0x1f, 0x8b], 'gzip stream', 'Compressed data'],
  [[0x37, 0x7a, 0xbc, 0xaf], '7-Zip archive', '7z compressed archive'],
  [[0x52, 0x61, 0x72, 0x21], 'RAR archive', 'Roshal Archive'],
  [[0x53, 0x51, 0x4c, 0x69], 'SQLite database', 'Embedded database file'],
  [[0x77, 0x4f, 0x46, 0x32], 'WOFF2 font', 'Web Open Font Format 2'],
  [[0x00, 0x01, 0x00, 0x00], 'TrueType font', 'TTF font file'],
  [[0x30, 0x26, 0xb2, 0x75], 'ASF/WMV container', 'Windows Media'],
  [[0x78, 0x61, 0x62, 0x01], 'XAR archive', 'PKG/dmg installer format'],
];

export function guessBinaryKind(bytes: Uint8Array, ext: string): { kind: string; detail: string } {
  for (const [magic, kind, detail] of MAGIC) {
    let ok = true;
    for (let i = 0; i < magic.length; i++) {
      if (bytes[i] !== magic[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { kind, detail };
  }
  const e = shannonEntropy(bytes);
  if (e > 7.2) return { kind: 'Compressed / encrypted data', detail: `Very high entropy (${e.toFixed(2)} bits/byte)` };
  if (e > 5.5) return { kind: 'Structured binary', detail: `High entropy (${e.toFixed(2)} bits/byte) — likely compiled or packed` };
  if (e < 2 && bytes.length > 512) {
    const zeros = bytes.slice(0, 4096).reduce((a, b) => a + (b === 0 ? 1 : 0), 0) / Math.min(4096, bytes.length);
    if (zeros > 0.5) return { kind: 'Sparse / padded binary', detail: 'Mostly zero-filled (disk image or template?)' };
  }
  return { kind: `Binary data (.${ext})`, detail: `Entropy ${e.toFixed(2)} bits/byte` };
}
