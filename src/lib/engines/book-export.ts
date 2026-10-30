import { chapterChunks } from './book-db';
import { renderSignature, safeBookName, splitBookText, vttTime, wavHeader, type BookProject } from './book-plan';
import { zipFiles, type ZipSource } from './zip-write';

export async function chapterAudio(project: BookProject, chapterId: string): Promise<{ blob: Blob; vtt: string; duration: number; name: string }> {
  const chapter = project.chapters.find(c => c.id === chapterId);
  if (!chapter) throw new Error('Chapter not found');
  const plan = splitBookText(chapter.text, project.chunkChars).filter(t => t.trim());
  const records = await chapterChunks(chapterId);
  if (!plan.length) throw new Error('This chapter is empty');
  const chunks = plan.map((text, index) => {
    const found = records.find(c => c.index === index && c.signature === renderSignature(project, text));
    if (!found) throw new Error('Render this chapter first. Some chunks are missing or were changed.');
    if (found.sampleRate !== 22050 || found.pcm.size !== found.frames * 2) throw new Error('Invalid saved audio. Render this chapter again.');
    return found;
  });
  let duration = 0;
  const vtt = ['WEBVTT', '', 'NOTE Captions align to rendered chunks, not individual words.', ''];
  chunks.forEach((c, i) => {
    const start = duration; duration += c.frames / c.sampleRate;
    vtt.push(String(i + 1), `${vttTime(start)} --> ${vttTime(duration)}`, plan[i].trim().replace(/-->/g, '→').replace(/\n\s*\n/g, '\n').replace(/&/g, '&amp;').replace(/</g, '&lt;'), '');
  });
  const size = chunks.reduce((n, c) => n + c.pcm.size, 0);
  const blob = new Blob([wavHeader(size) as BlobPart, ...chunks.map(c => c.pcm)], { type: 'audio/wav' });
  const number = String(project.chapters.indexOf(chapter) + 1).padStart(4, '0');
  return { blob, duration, vtt: vtt.join('\n'), name: `${number}-${safeBookName(chapter.title)}` };
}

export async function* bookPackage(project: BookProject): AsyncGenerator<Uint8Array> {
  async function* sources(): AsyncGenerator<ZipSource> {
    yield { name: 'project.json', blob: new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }) };
    const playlist = ['#EXTM3U'];
    const manifest = { title: project.title, author: project.author, language: project.language,
      format: 'WAV PCM 16-bit mono 22050 Hz', chapters: [] as { title: string; file: string; duration: number }[] };
    for (const chapter of project.chapters) {
      if (!chapter.text.trim()) continue;
      const audio = await chapterAudio(project, chapter.id);
      yield { name: `${audio.name}.wav`, blob: audio.blob };
      yield { name: `${audio.name}.vtt`, blob: new Blob([audio.vtt], { type: 'text/vtt' }) };
      yield { name: `${audio.name}.txt`, blob: new Blob([chapter.text], { type: 'text/plain;charset=utf-8' }) };
      playlist.push(`#EXTINF:${audio.duration.toFixed(3)},${chapter.title.replace(/[\r\n]/g, ' ')}`, `${audio.name}.wav`);
      manifest.chapters.push({ title: chapter.title, file: `${audio.name}.wav`, duration: audio.duration });
    }
    yield { name: 'playlist.m3u8', blob: new Blob([playlist.join('\n')], { type: 'audio/x-mpegurl' }) };
    yield { name: 'chapters.json', blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }) };
  }
  yield* zipFiles(sources());
}

export function downloadBookBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  // Keep the URL alive long enough for Safari's download handoff.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

interface FileSink { write: (data: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }
export async function exportBookPackage(project: BookProject, onBytes: (n: number) => void): Promise<void> {
  const name = `${safeBookName(project.title)}.zip`;
  const picker = (window as unknown as { showSaveFilePicker?: (opts: unknown) => Promise<{ createWritable: () => Promise<FileSink> }> }).showSaveFilePicker;
  // Must invoke the picker directly in the click gesture, before reading IndexedDB.
  const sink = picker ? await (await picker({ suggestedName: name, types: [{ description: 'Audiobook ZIP', accept: { 'application/zip': ['.zip'] } }] })).createWritable() : undefined;
  const parts: BlobPart[] = [];
  let size = 0;
  try {
    for await (const bytes of bookPackage(project)) {
      size += bytes.length;
      if (sink) await sink.write(bytes);
      else {
        if (size > 128 * 1024 * 1024) throw new Error('This browser needs an in-memory ZIP. The 128 MB safety limit was reached. Download individual chapter WAVs, or use a browser with Save File support.');
        parts.push(bytes as BlobPart);
      }
      onBytes(size);
    }
    if (sink) await sink.close();
    else downloadBookBlob(new Blob(parts, { type: 'application/zip' }), name);
  } catch (err) { if (sink) await sink.abort().catch(() => {}); throw err; }
}
