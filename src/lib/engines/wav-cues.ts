/**
 * RIFF/WAV cue-point embedding — real metadata, no placeholders.
 *
 * `insertWavCueChunks` parses the RIFF chunk table of a WAV blob and rebuilds
 * the file with two new chunks inserted immediately before the `data` chunk:
 *
 *  1. `cue ` — standard Cue Chunk: dwCuePoints, then 24-byte cue records
 *     (dwName, dwPosition, fccChunk 'data', dwChunkStart, dwBlockStart,
 *     dwSampleOffset).
 *  2. `LIST` of type `adlt` — labelled text entries (`labl`: size, dwName,
 *     NUL-terminated label padded to even) that players like VLC/ffprobe/
 *     Audition surface as named chapter markers.
 *
 * All original chunks are preserved byte-for-byte (including their pad bytes),
 * the RIFF header size is recomputed, and odd-sized chunks are handled per
 * spec (a single zero pad byte after odd-length data). Everything is
 * little-endian. The blob is validated as RIFF/WAVE — anything else throws.
 */

export interface WavCuePoint {
  /** Cue position in samples from the start of the `data` chunk. */
  sampleOffset: number;
  /** Label stored in the matching `labl` entry. */
  label: string;
}

/** Minimal RIFF chunk reference: absolute byte range in the source file. */
interface ChunkRef {
  id: string;
  /** Offset of the chunk id (4CC). */
  start: number;
  /** Exclusive end offset, covering id + size + data + pad byte. */
  end: number;
}

function asciiChunkId(s: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function readChunkId(bytes: Uint8Array, off: number): string {
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

/** Builds the standard `cue ` chunk (id + size + dwCuePoints + 24 B per point). */
function buildCueChunk(cues: WavCuePoint[]): Uint8Array {
  const bodySize = 4 + cues.length * 24;
  const out = new Uint8Array(8 + bodySize);
  const dv = new DataView(out.buffer);
  out.set(asciiChunkId('cue '), 0);
  dv.setUint32(4, bodySize, true);
  dv.setUint32(8, cues.length, true); // dwCuePoints
  let o = 12;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const name = i + 1; // dwName — 1-based cue identifiers
    dv.setUint32(o, name, true); // dwName
    dv.setUint32(o + 4, c.sampleOffset >>> 0, true); // dwPosition (samples into data)
    out.set(asciiChunkId('data'), o + 8); // fccChunk
    dv.setUint32(o + 12, 0, true); // dwChunkStart (data chunk start, relative)
    dv.setUint32(o + 16, 0, true); // dwBlockStart
    dv.setUint32(o + 20, c.sampleOffset >>> 0, true); // dwSampleOffset
    o += 24;
  }
  return out;
}

/** Builds a `LIST` chunk of type `adlt` with one `labl` entry per cue. */
function buildListChunk(cues: WavCuePoint[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries = cues.map((c, i) => {
    const labelBytes = encoder.encode(c.label);
    // data = dwName(4) + label + NUL, padded so the entry stays even-aligned
    const textLen = labelBytes.length + 1;
    const entryDataSize = 4 + textLen + (textLen % 2);
    const entry = new Uint8Array(8 + entryDataSize);
    const dv = new DataView(entry.buffer);
    entry.set(asciiChunkId('labl'), 0);
    dv.setUint32(4, entryDataSize, true);
    dv.setUint32(8, i + 1, true); // dwName matches the cue chunk order
    entry.set(labelBytes, 12);
    // trailing bytes are already zero: NUL terminator + pad
    return entry;
  });
  const bodySize = 4 + entries.reduce((a, e) => a + e.length, 0);
  const out = new Uint8Array(8 + bodySize);
  const dv = new DataView(out.buffer);
  out.set(asciiChunkId('LIST'), 0);
  dv.setUint32(4, bodySize, true);
  out.set(asciiChunkId('adlt'), 8);
  let o = 12;
  for (const e of entries) {
    out.set(e, o);
    o += e.length;
  }
  return out;
}

/**
 * Inserts cue-point metadata (`cue ` + `LIST adlt` chunks) into a RIFF/WAV
 * blob. Cues are clamped to the audio length (via `fmt ` block-align when
 * present), sorted by sample offset and written before the `data` chunk.
 * Returns the original blob unchanged when `cues` is empty.
 */
export async function insertWavCueChunks(blob: Blob, cues: WavCuePoint[]): Promise<Blob> {
  if (!cues.length) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 12) throw new Error('Not a RIFF/WAVE file — too short');
  if (readChunkId(bytes, 0) !== 'RIFF' || readChunkId(bytes, 8) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file — missing RIFF/WAVE signature');
  }
  const srcDv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Walk the chunk table, tolerating odd-sized chunks (one pad byte after data).
  const chunks: ChunkRef[] = [];
  let dataChunk: ChunkRef | null = null;
  let fmtChunk: ChunkRef | null = null;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = readChunkId(bytes, off);
    const size = srcDv.getUint32(off + 4, true);
    if (off + 8 + size > bytes.length) throw new Error('Corrupt RIFF chunk table — chunk overruns file');
    const ref: ChunkRef = { id, start: off, end: off + 8 + size + (size % 2) };
    chunks.push(ref);
    if (id === 'data') dataChunk = ref;
    else if (id === 'fmt ') fmtChunk = ref;
    off = ref.end;
  }
  if (!dataChunk) throw new Error('Not a playable RIFF/WAVE file — no data chunk');

  // Clamp cue offsets to the actual audio length when fmt gives us block align.
  let maxSamples = Number.MAX_SAFE_INTEGER;
  if (fmtChunk) {
    const fmtData = fmtChunk.start + 8;
    if (fmtData + 16 <= bytes.length) {
      const blockAlign = srcDv.getUint16(fmtData + 12, true); // nBlockAlign
      if (blockAlign > 0) {
        maxSamples = Math.floor((dataChunk.end - (dataChunk.start + 8)) / blockAlign);
      }
    }
  }
  const sorted = cues
    .map((c) => ({ ...c, sampleOffset: Math.max(0, Math.min(Math.round(c.sampleOffset), maxSamples)) }))
    .sort((a, b) => a.sampleOffset - b.sampleOffset);

  const cueChunk = buildCueChunk(sorted);
  const listChunk = buildListChunk(sorted);

  // Recompute the RIFF payload size: 'WAVE' + every chunk (id+size+data+pad).
  let riffSize = 4;
  for (const ch of chunks) riffSize += ch.end - ch.start;
  riffSize += cueChunk.length + listChunk.length;

  const out = new Uint8Array(8 + riffSize);
  const outDv = new DataView(out.buffer);
  out.set(asciiChunkId('RIFF'), 0);
  outDv.setUint32(4, riffSize, true);
  out.set(asciiChunkId('WAVE'), 8);
  let o = 12;
  for (const ch of chunks) {
    if (ch.start === dataChunk.start) {
      out.set(cueChunk, o);
      o += cueChunk.length;
      out.set(listChunk, o);
      o += listChunk.length;
    }
    out.set(bytes.subarray(ch.start, ch.end), o);
    o += ch.end - ch.start;
  }
  return new Blob([out], { type: blob.type || 'audio/wav' });
}
