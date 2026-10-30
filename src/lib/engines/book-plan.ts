/** Pure, lossless book planning. Limits are UTF-16 units; never split a surrogate pair. */
export interface BookChapter { id: string; title: string; text: string }
export interface Pronunciation { from: string; to: string }
export interface BookProject {
  version: 1; id: string; title: string; author: string; language: string;
  engine: 'builtin' | 'bridge'; voiceId: string; profileId: string;
  rate: number; pitch: number; volume: number;
  chunkChars: number; partChars: number; dictionary: Pronunciation[];
  chapters: BookChapter[]; updatedAt: number;
}

export const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Join the output to recover the input exactly (including whitespace/punctuation). */
export function splitBookText(text: string, limit: number): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error('Chunk limit must be an integer of at least 2');
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + limit);
    if (end < text.length) {
      const window = text.slice(start, end);
      // Prefer paragraphs, then sentences (including CJK), then word boundaries.
      let cut = window.lastIndexOf('\n\n');
      if (cut >= limit / 3) end = start + cut + 2;
      else {
        const matches = [...window.matchAll(/[.!?。！？]["'”’»）)]*\s+|\n|\s+/gu)];
        const match = matches.filter(m => m.index! >= limit / 2).pop();
        if (match) end = start + match.index! + match[0].length;
      }
      // Avoid separating UTF-16 surrogate pairs when there is no word boundary.
      if (/^[\uDC00-\uDFFF]$/.test(text[end] ?? '') && /^[\uD800-\uDBFF]$/.test(text[end - 1])) end--;
    }
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

export function planChapters(text: string, partChars = 6000): BookChapter[] {
  if (!text.trim()) return [];
  // Retain headings and the preface; large chapters become numbered parts.
  const headings = /^(?:#{1,6}\s+.+|(?:chapter|part|book|prologue|epilogue)\b[^\n]{0,100})$/gim;
  const boundaries = [...text.matchAll(headings)].map(m => m.index!);
  const starts = [...new Set([0, ...boundaries, text.length])];
  const chapters: BookChapter[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const section = text.slice(starts[i], starts[i + 1]);
    const pieces = splitBookText(section, partChars);
    const title = section.split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 100) || 'Untitled';
    for (let j = 0; j < pieces.length; j++) chapters.push({
      id: newId(), title: `${title}${pieces.length > 1 ? ` — part ${j + 1}` : ''}`, text: pieces[j],
    });
  }
  if (chapters.length > 5000) throw new Error('Book exceeds 5,000 parts. Import it in smaller volumes.');
  return chapters;
}

export function makeBookProject(text: string, title = 'My audiobook'): BookProject {
  return { version: 1, id: newId(), title, author: '', language: 'en', engine: 'builtin',
    voiceId: '', profileId: 'atlas-narrator', rate: 1, pitch: 1, volume: 1,
    chunkChars: 600, partChars: 6000, dictionary: [], chapters: planChapters(text), updatedAt: Date.now() };
}

/** Literal, case-sensitive replacements. Longest first, single pass, no regex/replacement injection. */
export function pronounce(text: string, dictionary: Pronunciation[]): string {
  const entries = dictionary.filter(e => e.from).sort((a, b) => b.from.length - a.from.length);
  if (!entries.length) return text;
  const map = new Map(entries.map(e => [e.from, e.to]));
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(entries.map(e => escape(e.from)).join('|'), 'gu'), s => map.get(s)!);
}

export function renderSignature(project: BookProject, text: string): string {
  return JSON.stringify([2, project.engine, project.voiceId, project.profileId, project.language,
    project.rate, project.pitch, project.volume, pronounce(text, project.dictionary)]);
}

export function safeBookName(name: string): string {
  const clean = name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 110);
  return !clean || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(clean) ? `Book_${clean || 'untitled'}` : clean;
}

export function validateBookProject(value: unknown): BookProject {
  if (!value || typeof value !== 'object') throw new Error('Invalid project');
  const p = value as BookProject;
  if (p.version !== 1 || typeof p.title !== 'string' || p.title.length > 1000 ||
      !['builtin', 'bridge'].includes(p.engine) || !Array.isArray(p.chapters) || p.chapters.length > 5000 ||
      !Array.isArray(p.dictionary) || p.dictionary.length > 500) throw new Error('Unsupported or invalid book project');
  for (const k of ['author', 'language', 'voiceId', 'profileId'] as const) if (typeof p[k] !== 'string' || p[k].length > 1000) throw new Error(`Invalid ${k}`);
  for (const k of ['rate', 'pitch', 'volume'] as const) if (!Number.isFinite(p[k]) || p[k] < (k === 'volume' ? 0 : 0.5) || p[k] > 2) throw new Error(`Invalid ${k}`);
  if (!Number.isInteger(p.chunkChars) || p.chunkChars < 100 || p.chunkChars > 1200 ||
      !Number.isInteger(p.partChars) || p.partChars < 1000 || p.partChars > 12000) throw new Error('Invalid part/chunk limit');
  let chars = 0;
  for (const c of p.chapters) {
    if (!c || typeof c.text !== 'string' || typeof c.title !== 'string' || c.text.length > 12000) throw new Error('Invalid chapter (maximum 12,000 characters per part)');
    chars += c.text.length;
  }
  if (chars > 20_000_000 || !chars) throw new Error('Project text must contain 1–20,000,000 characters');
  for (const e of p.dictionary) if (!e || typeof e.from !== 'string' || typeof e.to !== 'string' || e.from.length > 200 || e.to.length > 500) throw new Error('Invalid pronunciation entry');
  // Imported identities must not collide with another local project's cached audio.
  return { ...p, id: newId(), chapters: p.chapters.map(c => ({ ...c, id: newId() })), updatedAt: Date.now() };
}

export function wavHeader(dataBytes: number, sampleRate = 22050): Uint8Array {
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataBytes % 2 || dataBytes > 0xffffffff - 36) throw new Error('WAV exceeds the RIFF limit; export smaller parts');
  const b = new Uint8Array(44), v = new DataView(b.buffer);
  const tag = (s: string, off: number) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  tag('RIFF', 0); v.setUint32(4, dataBytes + 36, true); tag('WAVEfmt ', 8);
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag('data', 36); v.setUint32(40, dataBytes, true);
  return b;
}

export function vttTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
