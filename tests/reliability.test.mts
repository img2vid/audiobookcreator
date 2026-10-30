import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { zipSync, strToU8 } from 'fflate';
import { makeBookProject, planChapters, splitBookText, pronounce, renderSignature, safeBookName, validateBookProject, wavHeader, vttTime } from '@/lib/engines/book-plan';
import { parseZip, readZipEntry, readZipEntryText } from '@/lib/engines/zip';
import { zipFiles } from '@/lib/engines/zip-write';
import { parseWav } from '@/lib/engines/os-tts-bridge';
import { saveBook, getBook, bookChunkId, putBookChunk, bookChunkInfo, claimBook, releaseBook, deleteBook } from '@/lib/engines/book-db';
import { chapterAudio, bookPackage } from '@/lib/engines/book-export';
import { autoTune } from '@/lib/engines/autotune';

function ab(a: Uint8Array): ArrayBuffer { return a.slice().buffer; }
async function collect(stream: AsyncIterable<Uint8Array>): Promise<ArrayBuffer> {
  const parts: Uint8Array[] = []; for await (const p of stream) parts.push(p);
  const blob = new Blob(parts as BlobPart[]); return blob.arrayBuffer();
}

test('bounded splits retain all text and never break emoji', () => {
  const cases = ['?!'.repeat(2500), 'No punctuation '.repeat(4000), '日本語の文章です。\n'.repeat(3000), '😀🚀'.repeat(5000), ' \n\t'.repeat(500), 'A'.repeat(2200)];
  for (const text of cases) for (const limit of [2, 3, 100, 600]) {
    const chunks = splitBookText(text, limit); assert.equal(chunks.join(''), text);
    assert.ok(chunks.every(c => c.length <= limit && c.length > 0));
    assert.ok(chunks.every(c => !/^[\uDC00-\uDFFF]/.test(c) && !/[\uD800-\uDBFF]$/.test(c)));
  }
  assert.throws(() => splitBookText('x', 0));
});
test('chapter planning retains preface, 85 chapters, and long trailing section', () => {
  const text = 'A preface.\n\n' + Array.from({ length: 85 }, (_, i) => `Chapter ${i + 1}\n${'Example prose. '.repeat(600)}\n`).join('');
  const chapters = planChapters(text);
  assert.equal(chapters.map(c => c.text).join(''), text);
  assert.ok(chapters.length > 85 && chapters.every(c => c.text.length <= 6000));
});
test('literal dictionary handles regex metacharacters and substitution dollars once', () => {
  assert.equal(pronounce('C++ Ada Ada Lovelace $&', [{ from: 'Ada', to: 'A' }, { from: 'Ada Lovelace', to: 'Ada' }, { from: 'C++', to: '$&' }]), '$& A Ada $&');
});
test('settings cache signature changes only for audio-affecting settings/text', () => {
  const p = makeBookProject('Hello');
  assert.equal(renderSignature(p, 'Hello'), renderSignature({ ...p, title: 'Different' }, 'Hello'));
  assert.notEqual(renderSignature(p, 'Hello'), renderSignature({ ...p, rate: 1.2 }, 'Hello'));
  assert.notEqual(renderSignature(p, 'Hello'), renderSignature(p, 'Hello!'));
});
test('portable names and imported-project validation', () => {
  assert.equal(safeBookName('CON'), 'Book_CON'); assert.equal(safeBookName('a/b:c?. '), 'a_b_c_');
  const p = makeBookProject('Chapter 1\nHello'); const copy = validateBookProject(p);
  assert.notEqual(copy.id, p.id); assert.notEqual(copy.chapters[0].id, p.chapters[0].id);
  for (const bad of [{ ...p, rate: NaN }, { ...p, chapters: [null] }, { ...p, chunkChars: 0 }, { ...p, dictionary: [{}] }]) assert.throws(() => validateBookProject(bad));
});
test('compressed ZIP, UTF-8 names, CRC and malformed input', async () => {
  const archive = ab(zipSync({ '日本語.txt': strToU8('Hello, world! '.repeat(500)) }));
  const [entry] = parseZip(archive).entries;
  assert.equal(await readZipEntryText(archive, entry), 'Hello, world! '.repeat(500));
  const broken = archive.slice(0); new Uint8Array(broken)[entry.offset + 30 + new TextEncoder().encode(entry.name).length] ^= 8;
  await assert.rejects(() => readZipEntry(broken, entry));
  for (const short of [new ArrayBuffer(0), archive.slice(0, 10), archive.slice(0, -5)]) assert.throws(() => parseZip(short));
  const hostile = ab(zipSync({ '../secret.txt': strToU8('x') })); assert.throws(() => parseZip(hostile));
});
test('ZIP expansion and encrypted flags rejected before allocation', () => {
  const archive = ab(zipSync({ 'a.txt': strToU8('a') })); const v = new DataView(archive);
  const end = archive.byteLength - 22, cd = v.getUint32(end + 16, true);
  v.setUint32(cd + 24, 100 * 1024 * 1024, true); assert.throws(() => parseZip(archive), /expansion/);
  v.setUint32(cd + 24, 1, true); v.setUint16(cd + 8, 1, true); assert.throws(() => parseZip(archive), /Encrypted/);
});
test('streamed ZIP is readable by independent fflate and our checksum reader', async () => {
  async function* entries() { yield { name: 'audio/001.wav', blob: new Blob(['abcdef']) }; yield { name: '日本語.txt', blob: new Blob(['こんにちは']) }; }
  const archive = await collect(zipFiles(entries())); const entriesOut = parseZip(archive).entries;
  assert.equal(entriesOut.length, 2); assert.equal(await readZipEntryText(archive, entriesOut[1]), 'こんにちは');
  const { unzipSync } = await import('fflate'); assert.equal(new TextDecoder().decode(unzipSync(new Uint8Array(archive))['audio/001.wav']), 'abcdef');
});
test('WAV header, PCM and captions use sample-exact durations', () => {
  const header = wavHeader(4), payload = new Uint8Array([0, 128, 255, 127]);
  const all = new Uint8Array(48); all.set(header); all.set(payload, 44);
  const wav = parseWav(ab(all)); assert.equal(wav.float32[0][0], -1); assert.ok(wav.float32[0][1] > 0.999);
  const bad = all.slice(); new DataView(bad.buffer).setUint16(20, 17, true); assert.throws(() => parseWav(ab(bad)), /Unsupported/);
  assert.throws(() => wavHeader(0x100000000)); assert.equal(vttTime(3661.125), '01:01:01.125');
});
test('IDB commits, cross-tab lease, stale cache rejection, chapter/package export and deletion', async () => {
  const p = makeBookProject('Chapter 1\nThe complete text.'); await saveBook(p);
  assert.equal((await getBook(p.id))?.title, p.title);
  assert.equal(await claimBook(p.id, 'tab1'), true); assert.equal(await claimBook(p.id, 'tab2'), false);
  await assert.rejects(() => saveBook(p)); await assert.rejects(() => deleteBook(p.id));
  await releaseBook(p.id, 'tab2'); assert.equal(await claimBook(p.id, 'tab2'), false);
  await releaseBook(p.id, 'tab1');
  const c = p.chapters[0], text = splitBookText(c.text, p.chunkChars)[0];
  await putBookChunk({ id: bookChunkId(p.id, c.id, 0), projectId: p.id, chapterId: c.id, index: 0, signature: renderSignature(p, text), pcm: new Blob([new Uint8Array(44100)]), frames: 22050, sampleRate: 22050, engineLabel: 'fixture' });
  const info = await bookChunkInfo(p.id); assert.equal(info.length, 1); assert.equal('pcm' in info[0], false);
  const audio = await chapterAudio(p, c.id); assert.equal(audio.duration, 1); assert.equal(audio.blob.size, 44144); assert.match(audio.vtt, /00:00:00.000 --> 00:00:01.000/);
  // New WebKit-safe ArrayBuffer chunks and legacy Blob chunks must export identically.
  await putBookChunk({ id: bookChunkId(p.id, c.id, 0), projectId: p.id, chapterId: c.id, index: 0, signature: renderSignature(p, text), pcm: new ArrayBuffer(44100), frames: 22050, sampleRate: 22050, engineLabel: 'buffer-fixture' });
  const fromBuffer = await chapterAudio(p, c.id);
  assert.equal(fromBuffer.blob.size, 44144); assert.equal(fromBuffer.duration, 1);
  await assert.rejects(() => chapterAudio({ ...p, rate: 1.2 }, c.id), /Render/);
  const archive = await collect(bookPackage(p)); const names = parseZip(archive).entries.map(e => e.name);
  assert.ok(names.includes('project.json') && names.includes('playlist.m3u8') && names.includes('chapters.json'));
  await deleteBook(p.id); assert.equal(await getBook(p.id), undefined); assert.equal((await bookChunkInfo(p.id)).length, 0);
});
test('low-end profile runs only one queue task and OCR thread without GPU', () => {
  const tuned = autoTune({ cpuBrand: 'custom', cpuGeneration: '', cpuModel: '', customCpu: { cores: 2, threads: 2, clockGhz: 1.6 }, gpuEnabled: false, gpuBrand: '', gpuGeneration: '', gpuModel: '', customGpu: { vramGB: 0, teraflops: 0 }, ramGB: 2, storage: 'hdd', os: 'linux' });
  assert.equal(tuned.queueConcurrency, 1); assert.equal(tuned.ocrThreads, 1); assert.equal(tuned.gpuOffload, false); assert.ok(tuned.ocrMaxPixels <= 800000);
});

test('automatic voice mapping stays within the requested language', async () => {
  const { pickOsVoiceForProfile } = await import('@/lib/engines/dispatch');
  const voices = [
    { id: 'say:English', engine: 'say', name: 'English', lang: 'en-US', gender: 'female', neural: true, quality: 5 },
    { id: 'say:Japanese', engine: 'say', name: 'Japanese', lang: 'ja-JP', gender: 'female', neural: false, quality: 3 },
  ];
  for (const profile of ['one', 'two', 'three', 'four']) assert.equal(pickOsVoiceForProfile(voices as any, profile, 'female', 'ja')?.name, 'Japanese');
});
test('queue serializes tasks, cancellation stays cancelled, and active jobs cannot be dismissed', async () => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => memory.get(k) ?? null, setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) } });
  const { useAppStore } = await import('@/lib/stores/app-store');
  const { enqueueJob, cancelJob, dismissJob } = await import('@/lib/queue');
  useAppStore.setState({ jobs: [], tuned: { ...useAppStore.getState().tuned, queueConcurrency: 1 } });
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const order: string[] = [];
  const first = enqueueJob({ type: 'tts-render', label: 'first' }, async api => { order.push('first'); await gate; api.setProgress(.5); });
  const second = enqueueJob({ type: 'tts-render', label: 'second' }, async () => { order.push('second'); });
  const waitFor = async (condition: () => boolean) => { for (let i = 0; i < 100 && !condition(); i++) await new Promise(r => setTimeout(r,20)); assert.ok(condition()); };
  await waitFor(() => order.includes('first'));
  assert.deepEqual(order, ['first']); dismissJob(first); assert.ok(useAppStore.getState().jobs.find(j => j.id === first));
  cancelJob(first); release();
  await waitFor(() => useAppStore.getState().jobs.find(j => j.id === second)?.status === 'done');
  assert.equal(useAppStore.getState().jobs.find(j => j.id === first)?.status, 'cancelled');
  assert.deepEqual(order, ['first', 'second']);
});
