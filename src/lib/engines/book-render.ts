import { bookChunkId, claimBook, getBook, getBookChunk, putBookChunk, releaseBook } from './book-db';
import { newId, pronounce, renderSignature, splitBookText, type BookProject } from './book-plan';
import { synthesizeWithSelectedEngine } from './dispatch';
import { resampleBuffer } from './encode';
import { TTS_MODELS } from '@/lib/data/tts-models';
import type { TTSModelDef } from '@/lib/types';

const BUILTIN: TTSModelDef = { id: 'desk-builtin', name: 'Built-in English formant', family: 'Formant',
  lang: 'en', sizeMB: 0, quality: 1, engine: 'formant', bundled: true, description: 'Lightweight robotic English speech', tags: [], gpuRecommended: false };

export interface BookRenderProgress { done: number; total: number; chapter: string; reused: number; engineLabel?: string }

/** Sequential bounded synthesis. Only a single short AudioBuffer is held by this loop. */
export async function renderBook(project: BookProject, opts: {
  signal: AbortSignal; waitWhilePaused: () => Promise<void>; onProgress: (p: BookRenderProgress) => void;
  chapterId?: string;
}): Promise<void> {
  const owner = newId();
  if (!await claimBook(project.id, owner)) throw new Error('This book is rendering in another tab. Stop that render, or wait two minutes after a crashed tab.');
  const abort = new AbortController();
  const stop = () => abort.abort(opts.signal.reason);
  opts.signal.addEventListener('abort', stop, { once: true });
  const heartbeat = setInterval(() => {
    void claimBook(project.id, owner).then(ok => {
      if (!ok) abort.abort(new Error('Another tab acquired the book lock. Resume this book after stopping the other tab.'));
    }).catch(err => abort.abort(err));
  }, 20_000);
  try {
    opts.signal.throwIfAborted();
    const saved = await getBook(project.id);
    if (!saved || saved.updatedAt !== project.updatedAt) throw new Error('This project changed in another tab. Reopen it before rendering.');
    const chapters = project.chapters.filter(c => !opts.chapterId || c.id === opts.chapterId);
    const total = chapters.reduce((n, c) => n + splitBookText(c.text, project.chunkChars).filter(t => t.trim()).length, 0);
    let done = 0, reused = 0;
    for (const chapter of chapters) {
      const chunks = splitBookText(chapter.text, project.chunkChars).filter(t => t.trim());
      for (let index = 0; index < chunks.length; index++) {
        await opts.waitWhilePaused(); abort.signal.throwIfAborted();
        const text = chunks[index], signature = `balabolka-cmd-v1:${renderSignature(project, text)}`;
        const id = bookChunkId(project.id, chapter.id, index);
        const old = await getBookChunk(id);
        let label = old?.engineLabel;
        if (old?.signature === signature) reused++;
        else {
          const spoken = pronounce(text, project.dictionary);
          if (spoken.length > 6000 || !spoken.trim()) throw new Error('Pronunciation rules produced empty or excessively long speech. Edit the dictionary and resume.');
          opts.onProgress({ done, total, reused, chapter: chapter.title });
          const result = await synthesizeWithSelectedEngine(spoken, {
            model: project.engine === 'builtin' ? BUILTIN : TTS_MODELS[0],
            profileId: project.profileId, osVoiceId: project.voiceId || undefined, lang: project.language,
            rate: project.rate, pitch: project.pitch, volume: project.volume, quality: 'fast',
            fallbackOnBridgeUnavailable: false, signal: abort.signal,
          });
          abort.signal.throwIfAborted();
          const buffer = await resampleBuffer(result.buffer, 22050, 1);
          // Persist raw PCM as an ArrayBuffer: Safari/WebKit can abort IndexedDB
          // transactions containing Blob values, even though WAV downloads support Blobs.
          const samples = buffer.getChannelData(0), pcm = new ArrayBuffer(samples.length * 2), view = new DataView(pcm);
          for (let i = 0; i < samples.length; i++) {
            const x = Number.isFinite(samples[i]) ? Math.min(1, Math.max(-1, samples[i])) : 0;
            view.setInt16(i * 2, Math.round(x * (x < 0 ? 32768 : 32767)), true);
          }
          abort.signal.throwIfAborted();
          label = result.engineLabel;
          await putBookChunk({ id, projectId: project.id, chapterId: chapter.id, index, signature,
            pcm, frames: samples.length, sampleRate: 22050, engineLabel: label });
        }
        done++; opts.onProgress({ done, total, reused, chapter: chapter.title, engineLabel: label });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
  } finally {
    clearInterval(heartbeat); opts.signal.removeEventListener('abort', stop);
    await releaseBook(project.id, owner);
  }
}
