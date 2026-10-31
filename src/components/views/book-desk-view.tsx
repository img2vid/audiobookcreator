'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Download, FilePlus2, Pause, Play, RefreshCw, Save, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { makeBookProject, planChapters, renderSignature, safeBookName, splitBookText, validateBookProject, type BookProject } from '@/lib/engines/book-plan';
import { bookChunkId, bookChunkInfo, deleteBook, listBooks, saveBook, type BookChunkInfo } from '@/lib/engines/book-db';
import { chapterAudio, downloadBookBlob, exportBookPackage } from '@/lib/engines/book-export';
import { renderBook, type BookRenderProgress } from '@/lib/engines/book-render';
import { allVoiceProfiles } from '@/lib/engines/formant';
import { probeOsTtsBridge, getBridgeUrl, setBridgeUrl, setBridgeAccessToken } from '@/lib/engines/os-tts-bridge';
import { useAppStore } from '@/lib/stores/app-store';
import type { OsTtsVoiceDef } from '@/lib/types';

const selectStyle = 'h-9 w-full rounded-md border bg-background px-2 text-sm';
const message = (err: unknown) => err instanceof Error ? err.message : String(err);

export function BookDeskView() {
  const [books, setBooks] = useState<BookProject[]>([]);
  const [project, setProject] = useState<BookProject | null>(null);
  const [source, setSource] = useState('');
  const [sourceTitle, setSourceTitle] = useState('My audiobook');
  const [chapterIndex, setChapterIndex] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [paused, setPaused] = useState(false);
  const pauseRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<BookRenderProgress | null>(null);
  const [notice, setNotice] = useState('Import a document or paste text to begin. No GPU or model download is required.');
  const [error, setError] = useState('');
  const [info, setInfo] = useState<BookChunkInfo[]>([]);
  const [voices, setVoices] = useState<OsTtsVoiceDef[]>([]);
  const [hostedUrl, setHostedUrl] = useState('');
  const [hostedToken, setHostedToken] = useState('');
  const [hostedStatus, setHostedStatus] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [dictFrom, setDictFrom] = useState(''), [dictTo, setDictTo] = useState('');
  const [storage, setStorage] = useState('');
  const [allowOcr, setAllowOcr] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null), backupRef = useRef<HTMLInputElement>(null);
  const pendingText = useAppStore(s => s.pendingText);
  const chapter = project?.chapters[chapterIndex];

  const refresh = async () => { setBooks(await listBooks()); };
  useEffect(() => { void refresh().catch(e => setError(message(e))); }, []);
  useEffect(() => {
    if (!project) { setInfo([]); return; }
    void bookChunkInfo(project.id).then(setInfo).catch(e => setError(message(e)));
  }, [project?.id]);
  useEffect(() => {
    if (!pendingText) return;
    setSource(pendingText); setNotice('Text received from another studio. Create a book when ready.');
    useAppStore.getState().setPendingText(null);
  }, [pendingText]);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  useEffect(() => {
    if (!dirty && !rendering) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, rendering]);

  const completion = useMemo(() => {
    const map = new Map(info.map(c => [c.id, c]));
    return project?.chapters.map(c => {
      const plan = splitBookText(c.text, project.chunkChars).filter(t => t.trim());
      const valid = plan.map((t, i) => map.get(bookChunkId(project.id, c.id, i))).filter((x, i) => x?.signature === `balabolka-cmd-v1:${renderSignature(project, plan[i])}`);
      return { done: valid.length, total: plan.length, seconds: valid.reduce((n, c) => n + (c ? c.frames / c.sampleRate : 0), 0) };
    }) ?? [];
  }, [project, info]);

  function edit(patch: Partial<BookProject>) {
    if (!project) return;
    setProject({ ...project, ...patch }); setDirty(true); setAudioUrl('');
  }
  async function persist(p: BookProject): Promise<BookProject> {
    const saved = { ...p, updatedAt: Date.now() };
    await saveBook(saved); setProject(saved); setDirty(false); await refresh();
    return saved;
  }
  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (err) { if (!(err instanceof DOMException && err.name === 'AbortError')) setError(message(err)); }
    finally { setBusy(false); }
  }

  async function importFiles(files: File[]) {
    await action(async () => {
      if (files.length > 20) throw new Error('Import at most 20 files at a time.');
      let totalCharacters = 0;
      const texts: string[] = [], warnings: string[] = [];
      const { ingestFile } = await import('@/lib/engines/ingest');
      for (const file of files) {
        setNotice(`Reading ${file.name}…`);
        const result = await ingestFile(file, {
          ...(allowOcr ? { pdfOcr: { language: 'eng', power: 'lite' as const, preprocess: true, minConfidence: 0.3 }, ocr: { language: 'eng', power: 'lite' as const, preprocess: true, minConfidence: 0.3 } } : {}),
          onProgress: (_, msg) => { if (msg) setNotice(msg); },
        }).catch(err => { warnings.push(`${file.name}: ${message(err)}`); return null; });
        if (!result) continue;
        totalCharacters += result.text.length;
        if (totalCharacters > 20_000_000) throw new Error('The batch exceeds 20 million text characters. Import fewer files.');
        warnings.push(...result.warnings.map(w => `${file.name}: ${w}`));
        if (['audio', 'video', 'binary', 'archive', 'unknown'].includes(result.category) || ['none', 'strings', 'binary-dump'].includes(result.textKind) || !result.text.trim()) {
          warnings.push(`${file.name}: no readable document text. Try OCR for scans or export this file to TXT/DOCX/EPUB.`); continue;
        }
        texts.push(result.text);
      }
      if (texts.length) {
        setSource(texts.join('\n\n')); setSourceTitle(files[0].name.replace(/\.[^.]+$/, ''));
      }
      setNotice(`${texts.length}/${files.length} files imported. ${warnings.join(' ') || 'Review the text below before creating a book.'}`);
    });
  }

  async function start(chapterId?: string) {
    if (!project || busy) return;
    setBusy(true); setRendering(true); setError(''); setProgress(null);
    pauseRef.current = false; setPaused(false);
    const ctrl = new AbortController(); controller.current = ctrl;
    try {
      const p = await persist(project);
      await renderBook(p, {
        chapterId, signal: ctrl.signal,
        waitWhilePaused: async () => { while (pauseRef.current && !ctrl.signal.aborted) await new Promise(r => setTimeout(r, 150)); },
        onProgress: setProgress,
      });
      setNotice('Render complete. Preview or download each part, or export the book ZIP.');
    } catch (err) {
      if (ctrl.signal.aborted) setNotice('Stopped. Completed chunks are saved; Render / resume will reuse them.');
      else setError(message(err));
    } finally {
      controller.current = null; pauseRef.current = false; setPaused(false); setRendering(false); setBusy(false);
      void bookChunkInfo(project.id).then(setInfo).catch(e => setError(message(e)));
    }
  }

  async function checkStorage() {
    const estimate = await navigator.storage?.estimate?.();
    const persistent = await navigator.storage?.persist?.();
    setStorage(estimate ? `${Math.round((estimate.usage ?? 0) / 1048576)} MB used / ${Math.round((estimate.quota ?? 0) / 1048576)} MB quota. ${persistent ? 'Persistent storage granted.' : 'Keep a project backup and download completed audio.'}` : 'Storage estimates are unavailable in this browser.');
  }

  return <div className="space-y-5">
    <Card className="border-primary/25">
      <CardHeader><CardTitle className="flex items-center gap-2"><BookOpen className="h-5 w-5" /> Book Conversion Desk</CardTitle>
        <p className="text-sm text-muted-foreground">CPU-only conversion, short audio chunks, saved progress, chapter WAVs and book packages.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p role="status" aria-live="polite" className="text-sm break-words">{notice}</p>
        {error && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} variant="outline" onClick={() => fileRef.current?.click()}><FilePlus2 className="mr-2 h-4 w-4" />Import files</Button>
          <Button disabled={busy} variant="outline" onClick={() => backupRef.current?.click()}>Restore project JSON</Button>
          <Button disabled={busy} variant="outline" onClick={() => void action(checkStorage)}>Check local storage</Button>
        </div>
        <details className="rounded-md border p-3 text-xs">
          <summary className="cursor-pointer font-medium">Hosted Balabolka connection (no visitor installation)</summary>
          <p className="mt-2 text-muted-foreground">
            On GitHub Pages, audio comes from a separately hosted Windows speech server. Your browser does not run Balabolka.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div><Label htmlFor="book-hosted-url">Hosted HTTPS speech URL</Label>
              <Input id="book-hosted-url" className="h-8" value={hostedUrl} onChange={e => setHostedUrl(e.target.value)}
                placeholder={getBridgeUrl() || 'https://tts.example.com'} />
            </div>
            <div><Label htmlFor="book-hosted-token">Access token (if required)</Label>
              <Input id="book-hosted-token" type="password" autoComplete="off" className="h-8" value={hostedToken}
                onChange={e => setHostedToken(e.target.value)} placeholder="Not stored after this tab closes" />
            </div>
          </div>
          <Button size="sm" variant="outline" disabled={busy} className="mt-2" onClick={() => void action(async () => {
            if (hostedUrl.trim()) setBridgeUrl(hostedUrl);
            if (hostedToken.trim()) { setBridgeAccessToken(hostedToken); setHostedToken(''); }
            const probe = await probeOsTtsBridge(true);
            if (!probe.status.ok) throw new Error(probe.status.error || 'Hosted Balabolka server unreachable.');
            setVoices(probe.voices);
            setHostedStatus(`${probe.voices.length} remote voice(s) available.`);
          })}>Connect hosted Balabolka</Button>
          {hostedStatus && <p className="mt-1" role="status">{hostedStatus}</p>}
          <p className="mt-1 text-muted-foreground">The server operator must configure the backend; this form does not create a server.</p>
        </details>
        <input ref={fileRef} className="hidden" type="file" multiple aria-label="Import book files" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void importFiles(files); }} />
        <input ref={backupRef} className="hidden" type="file" accept=".json" aria-label="Restore book project" onChange={e => {
          const file = e.target.files?.[0]; e.target.value = '';
          if (file) void action(async () => {
            if (file.size > 64 * 1024 * 1024) throw new Error('Project backup is too large (64 MB maximum)');
            if (dirty && !window.confirm('Discard unsaved edits and restore this project?')) return;
            const p = validateBookProject(JSON.parse(await file.text())); await persist(p); setChapterIndex(0); setAudioUrl('');
            setNotice('Project restored. Audio can be regenerated through the configured hosted Balabolka service; backups contain text and settings.');
          });
        }} />
        <label className="flex gap-2 text-sm"><input type="checkbox" disabled={busy} checked={allowOcr} onChange={e => setAllowOcr(e.target.checked)} />Use local English OCR for images and scanned PDFs (slower)</label>
        {storage && <p className="text-xs text-muted-foreground">{storage}</p>}
        <details><summary className="cursor-pointer text-sm font-medium">Import or paste a new book</summary>
          <div className="mt-3 space-y-3">
            <Label htmlFor="desk-source-title">New book title</Label><Input id="desk-source-title" disabled={busy} value={sourceTitle} onChange={e => setSourceTitle(e.target.value)} />
            <Label htmlFor="desk-source">Source text (review extraction before rendering)</Label>
            <Textarea id="desk-source" disabled={busy} value={source} onChange={e => setSource(e.target.value)} rows={9} placeholder="Paste the complete book here…" />
            <p className="text-xs text-muted-foreground">{source.length.toLocaleString()} characters. Headings are detected; long sections become parts of up to 6,000 characters.</p>
            <Button disabled={busy || !source.trim()} onClick={() => void action(async () => {
              if (source.length > 20_000_000) throw new Error('Book exceeds 20 million characters. Import it in smaller volumes.');
              if (dirty && !window.confirm('Discard unsaved edits and create a new book?')) return;
              await persist(makeBookProject(source, sourceTitle)); setChapterIndex(0); setAudioUrl(''); setSource('');
              setNotice('Book created. Choose a voice, then Render / resume.');
            })}>Create book</Button>
          </div>
        </details>
        <Label htmlFor="desk-book">Saved books</Label>
        <select id="desk-book" disabled={busy} className={selectStyle} value={project?.id ?? ''} onChange={e => {
          if (dirty && !window.confirm('Discard unsaved edits and open another book?')) return;
          const book = books.find(p => p.id === e.target.value); if (book) { setProject(book); setDirty(false); setChapterIndex(0); setAudioUrl(''); }
        }}><option value="" disabled>Select a saved book</option>{books.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(refresh)}><RefreshCw className="mr-2 h-3 w-3" />Refresh saved books</Button>
      </CardContent>
    </Card>

    {project && <>
      <Card><CardHeader><CardTitle>Voice and book settings</CardTitle></CardHeader><CardContent className="space-y-4">
        <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="desk-title">Book title</Label><Input id="desk-title" value={project.title} onChange={e => edit({ title: e.target.value })} /></div>
          <div className="space-y-2"><Label htmlFor="desk-author">Author</Label><Input id="desk-author" value={project.author} onChange={e => edit({ author: e.target.value })} /></div>
          <div className="space-y-2"><Label htmlFor="desk-engine">Speech engine</Label><select id="desk-engine" className={selectStyle} value={project.engine} onChange={e => edit({ engine: e.target.value as BookProject['engine'] })}>
            <option value="builtin">Balabolka CMD · mapped voice (Windows)</option><option value="bridge">Installed Balabolka / Piper voice · local bridge</option>
          </select></div>
          <div className="space-y-2"><Label htmlFor="desk-language">Language code</Label><Input id="desk-language" value={project.language} onChange={e => edit({ language: e.target.value })} placeholder="en, hi-IN, ja-JP…" /></div>
          {project.engine === 'builtin' ? <div className="space-y-2"><Label htmlFor="desk-profile">Character profile (maps to Balabolka)</Label><select id="desk-profile" className={selectStyle} value={project.profileId} onChange={e => edit({ profileId: e.target.value })}>{allVoiceProfiles().map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            : <div className="space-y-2"><Label htmlFor="desk-voice">Installed voice</Label><select id="desk-voice" className={selectStyle} value={project.voiceId} onChange={e => edit({ voiceId: e.target.value })}><option value="">Auto-select by language</option>{voices.map(v => <option key={v.id} value={v.id}>{v.name} · {v.lang} · {v.engine}</option>)}</select>
              <Button size="sm" variant="outline" onClick={() => void action(async () => { const probe = await probeOsTtsBridge(true); setVoices(probe.voices); if (!probe.status.ok || !probe.voices.length) throw new Error('No Balabolka/Piper voices found. Configure the hosted speech connection above, or start a bridge for local development.'); setNotice(`${probe.voices.length} installed voices available.`); })}>Refresh installed voices</Button>
              <p className="text-xs text-muted-foreground">Start the companion with <code>npm run os-tts</code>. Voice availability depends on installed language packs. No automatic fallback changes your selected engine.</p>
            </div>}
          {(['rate', 'pitch', 'volume'] as const).map(k => <div className="space-y-2" key={k}><Label htmlFor={`desk-${k}`}>{k[0].toUpperCase() + k.slice(1)}: {project[k].toFixed(2)}</Label><input className="w-full" id={`desk-${k}`} type="range" min={k === 'volume' ? 0 : 0.5} max={k === 'volume' ? 1 : 2} step="0.05" value={project[k]} onChange={e => edit({ [k]: Number(e.target.value) })} /></div>)}
        </fieldset>
        <p className="text-xs text-muted-foreground">Output: 22,050 Hz mono, 16-bit WAV. Unsupported pitch controls depend on the OS engine. Changing text, voice or settings regenerates only affected cached chunks.</p>
        <details><summary className="cursor-pointer text-sm font-medium">Pronunciation dictionary ({project.dictionary.length})</summary>
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">Literal, case-sensitive substitutions. Source text is preserved.</p>
            <div className="flex flex-wrap gap-2"><Input className="max-w-60" aria-label="Dictionary original" maxLength={200} placeholder="Original text" value={dictFrom} disabled={busy} onChange={e => setDictFrom(e.target.value)} /><Input className="max-w-60" aria-label="Dictionary pronunciation" maxLength={500} placeholder="Say it as…" value={dictTo} disabled={busy} onChange={e => setDictTo(e.target.value)} /><Button disabled={busy || !dictFrom || !dictTo || project.dictionary.length >= 500} onClick={() => { edit({ dictionary: [...project.dictionary.filter(e => e.from !== dictFrom), { from: dictFrom, to: dictTo }] }); setDictFrom(''); setDictTo(''); }}>Add rule</Button></div>
            {project.dictionary.map((e, i) => <div key={e.from} className="flex items-center gap-2 text-sm"><span>{e.from} → {e.to}</span><Button disabled={busy} variant="ghost" size="sm" onClick={() => edit({ dictionary: project.dictionary.filter((_, j) => i !== j) })}>Remove</Button></div>)}
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || !dirty} variant="outline" onClick={() => void action(async () => { await persist(project); setNotice('Project saved.'); })}><Save className="mr-2 h-4 w-4" />Save edits</Button>
          <span className="text-xs text-muted-foreground">{dirty ? 'Unsaved changes' : 'Saved locally'}</span>
          <Button disabled={busy} variant="outline" onClick={() => downloadBookBlob(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), `${safeBookName(project.title)}.project.json`)}>Backup project</Button>
          <Button disabled={busy} variant="ghost" onClick={() => void action(async () => { if (window.confirm(`Delete “${project.title}” and its saved audio?`)) { await deleteBook(project.id); setProject(null); setAudioUrl(''); setDirty(false); await refresh(); } })}><Trash2 className="mr-2 h-4 w-4" />Delete book</Button>
        </div>
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Chapters and rendering</CardTitle></CardHeader><CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void start()}><Play className="mr-2 h-4 w-4" />Render / resume book</Button>
          <Button variant="outline" disabled={busy || !chapter} onClick={() => void start(chapter?.id)}>Render selected part</Button>
          <Button variant="outline" disabled={!rendering} onClick={() => { pauseRef.current = !pauseRef.current; setPaused(pauseRef.current); }}><Pause className="mr-2 h-4 w-4" />{paused ? 'Continue' : 'Pause'}</Button>
          <Button variant="outline" disabled={!rendering} onClick={() => { controller.current?.abort(); setNotice('Stopping after the current short synthesis operation…'); }}><Square className="mr-2 h-4 w-4" />Stop</Button>
        </div>
        {progress && <div role="status" className="space-y-2"><Progress value={100 * progress.done / Math.max(1, progress.total)} /><p className="text-sm">{paused ? 'Paused between chunks. ' : ''}{progress.done}/{progress.total} chunks · {progress.reused} reused · {progress.chapter}{progress.engineLabel ? ` · ${progress.engineLabel}` : ''}</p></div>}
        <Label htmlFor="desk-chapter">Book part</Label><select id="desk-chapter" className={selectStyle} disabled={busy} value={chapterIndex} onChange={e => { setChapterIndex(Number(e.target.value)); setAudioUrl(''); }}>{project.chapters.map((c, i) => <option key={c.id} value={i}>{i + 1}. {c.title} ({completion[i]?.done ?? 0}/{completion[i]?.total ?? 0} chunks saved)</option>)}</select>
        {chapter && <fieldset disabled={busy} className="space-y-2">
          <Label htmlFor="desk-chapter-title">Part title</Label><Input id="desk-chapter-title" value={chapter.title} onChange={e => edit({ chapters: project.chapters.map((c, i) => i === chapterIndex ? { ...c, title: e.target.value } : c) })} />
          <Label htmlFor="desk-chapter-text">Part text</Label><Textarea id="desk-chapter-text" rows={8} maxLength={12000} value={chapter.text} onChange={e => edit({ chapters: project.chapters.map((c, i) => i === chapterIndex ? { ...c, text: e.target.value } : c) })} />
          <p className="text-xs text-muted-foreground">{chapter.text.length.toLocaleString()} characters · {(completion[chapterIndex]?.seconds / 60 || 0).toFixed(1)} saved audio minutes. Up to 12,000 characters per part.</p>
          <Button variant="outline" size="sm" onClick={() => { if (window.confirm('Rebuild parts from the current text? Saved audio will need rendering again.')) { edit({ chapters: planChapters(project.chapters.map(c => c.text).join('')) }); setChapterIndex(0); } }}>Rebuild chapter boundaries</Button>
        </fieldset>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !chapter} variant="outline" onClick={() => void action(async () => { const a = await chapterAudio(project, chapter!.id); setAudioUrl(URL.createObjectURL(a.blob)); })}>Preview part</Button>
          <Button disabled={busy || !chapter} variant="outline" onClick={() => void action(async () => { const a = await chapterAudio(project, chapter!.id); downloadBookBlob(a.blob, `${a.name}.wav`); })}><Download className="mr-2 h-4 w-4" />Part WAV</Button>
          <Button disabled={busy || !chapter} variant="outline" onClick={() => void action(async () => { const a = await chapterAudio(project, chapter!.id); downloadBookBlob(new Blob([a.vtt], { type: 'text/vtt' }), `${a.name}.vtt`); })}>Part captions</Button>
          <Button disabled={busy} onClick={() => void action(async () => { await exportBookPackage(project, n => setNotice(`Packaging ${(n / 1048576).toFixed(1)} MB…`)); setNotice('Book package exported: chapter WAVs, transcripts, captions, playlist, manifest and project backup.'); })}>Export book ZIP</Button>
        </div>
        {audioUrl && <audio className="w-full" src={audioUrl} controls preload="none" aria-label="Rendered chapter preview" />}
        <p className="text-xs text-muted-foreground">Resume survives page reloads. Keep this tab open while rendering. A paused render retains its project lock. Text backups exclude audio; download the ZIP to preserve finished audio. ZIP streams to disk where Save File is supported; other browsers use a 128 MB limit and individual chapter downloads.</p>
      </CardContent></Card>
    </>}
  </div>;
}
