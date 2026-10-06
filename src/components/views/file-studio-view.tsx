'use client';

import { useCallback, useRef, useState } from 'react';
import { useAppStore } from '@/lib/stores/app-store';
import { ingestFile, getSupportedExtensionCount, categorizeFile } from '@/lib/engines/ingest';
import { aiAnalyzeDocument } from '@/lib/engines/ai-services';
import { enqueueJob } from '@/lib/queue';
import { synthesizeSpeech } from '@/lib/engines/formant';
import { encodeAudioBufferChunked, getFormat } from '@/lib/engines/encode';
import type { IngestResult } from '@/lib/types';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatBytes, formatMs, formatNumber } from '@/lib/utils/format';
import { uid } from '@/lib/utils/async';
import {
  Braces, ChevronDown, FileAudio, FileCode, FileImage, FileQuestion, FileText,
  FileVideo, FileWarning, FolderArchive, Layers, Package, Sparkles, Trash2, Upload,
  Volume2, FileSpreadsheet,
} from 'lucide-react';

const CATEGORY_META: Record<string, { icon: typeof FileText; tone: string }> = {
  text: { icon: FileText, tone: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' },
  code: { icon: FileCode, tone: 'bg-violet-500/10 text-violet-600 border-violet-500/30' },
  data: { icon: FileSpreadsheet, tone: 'bg-amber-500/10 text-amber-600 border-amber-500/30' },
  document: { icon: FileText, tone: 'bg-zinc-500/10 text-zinc-600 border-zinc-500/30' },
  image: { icon: FileImage, tone: 'bg-rose-500/10 text-rose-600 border-rose-500/30' },
  video: { icon: FileVideo, tone: 'bg-fuchsia-500/10 text-fuchsia-600 border-fuchsia-500/30' },
  audio: { icon: FileAudio, tone: 'bg-teal-500/10 text-teal-600 border-teal-500/30' },
  archive: { icon: FolderArchive, tone: 'bg-orange-500/10 text-orange-600 border-orange-500/30' },
  binary: { icon: Package, tone: 'bg-zinc-500/10 text-zinc-600 border-zinc-500/30' },
  unknown: { icon: FileQuestion, tone: 'bg-zinc-500/10 text-zinc-600 border-zinc-500/30' },
};

interface FileEntry {
  id: string;
  file: File;
  status: 'pending' | 'parsing' | 'done' | 'error';
  progress: number;
  message?: string;
  result?: IngestResult;
}

export function FileStudioView() {
  const { toast } = useToast();
  const tuned = useAppStore((s) => s.tuned);
  const settings = useAppStore((s) => s.settings);
  const addAsset = useAppStore((s) => s.addAsset);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [converting, setConverting] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);

  const patchEntry = useCallback((id: string, patch: Partial<FileEntry>) => {
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const handleFiles = useCallback(async (files: File[]) => {
    for (const file of files.slice(0, 24)) {
      const id = uid('file');
      const { category, handler } = categorizeFile(file.name);
      setEntries((list) => [{ id, file, status: 'parsing', progress: 0.05, message: handler }, ...list]);
      try {
        const result = await ingestFile(file, {
          ocr: category === 'image' || category === 'video'
            ? { power: tuned.ocrPower, language: 'en', preprocess: true, minConfidence: 0.35 }
            : undefined,
          onProgress: (p, msg) => patchEntry(id, { progress: p, message: msg }),
        });
        patchEntry(id, { status: 'done', progress: 1, result, message: undefined });
        // AI document intelligence
        if (result.text.trim().length > 40) {
          const intel = await aiAnalyzeDocument(result.text);
          if (intel.ok && intel.value) {
            patchEntry(id, {
              status: 'done',
              progress: 1,
              result: {
                ...result,
                metadata: {
                  ...result.metadata,
                  aiTitle: intel.value.title,
                  aiSummary: intel.value.summary,
                  aiKeyPoints: intel.value.keyPoints.join(' | '),
                  aiKeywords: intel.value.keywords.join(', '),
                },
              },
              message: 'AI-analyzed',
            });
          }
        }
        if (result.warnings.length) {
          toast({ title: `Parsed with notes — ${file.name}`, description: result.warnings[0] });
        }
      } catch (err) {
        patchEntry(id, { status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [tuned.ocrPower, patchEntry, toast]);

  const convertToAudio = useCallback((entry: FileEntry) => {
    if (!entry.result || converting.has(entry.id)) return;
    setConverting((s) => new Set(s).add(entry.id));
    const formatId = settings.outputFormat || 'wav-16';
    enqueueJob(
      { type: 'file-convert', label: `Speak "${entry.file.name}" → ${getFormat(formatId)?.label ?? formatId}` },
      async (api) => {
        api.log(`Source: ${entry.file.name} (${entry.result?.category}, ${entry.result?.textKind})`);
        const text = entry.result!.text;
        if (!text.trim()) throw new Error('No speakable text extracted from this file');
        // chunked synthesis for long documents
        const maxChars = tuned.ttsChunkChars;
        const chunks: string[] = [];
        let rest = text;
        while (rest.length > 0) {
          if (rest.length <= maxChars) { chunks.push(rest); break; }
          let cut = rest.lastIndexOf('.', maxChars);
          const q = rest.lastIndexOf('!', maxChars);
          const qq = rest.lastIndexOf('?', maxChars);
          cut = Math.max(cut, q, qq);
          if (cut < maxChars * 0.4) cut = rest.lastIndexOf(' ', maxChars);
          if (cut <= 0) cut = maxChars;
          chunks.push(rest.slice(0, cut + 1).trim());
          rest = rest.slice(cut + 1).trim();
        }
        api.log(`Split into ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} (chunk size ${maxChars})`);
        const buffers: AudioBuffer[] = [];
        for (let i = 0; i < chunks.length; i++) {
          if (api.shouldCancel()) return;
          await api.waitWhilePaused();
          const buf = await synthesizeSpeech(chunks[i], {
            profileId: 'aura-neutral', rate: 1, pitch: 1, volume: 1, quality: tuned.synthesisQuality,
          });
          buffers.push(buf);
          api.setProgress(0.05 + 0.85 * ((i + 1) / chunks.length), `Synthesized chunk ${i + 1}/${chunks.length}`);
          if (i % 2 === 1) await new Promise((r) => setTimeout(r, 0));
        }
        // concatenate
        const { concatenateBuffers, normalizeBuffer } = await import('@/lib/engines/dsp');
        const { resampleBuffer } = await import('@/lib/engines/encode');
        api.setProgress(0.92, 'Joining chunks…');
        let full = buffers.length === 1 ? buffers[0] : await concatenateBuffers(buffers, 0.18);
        full = normalizeBuffer(full, -1);
        full = await resampleBuffer(full, settings.sampleRate, settings.channels);
        const blob = await encodeAudioBufferChunked(full, formatId, { channels: settings.channels }, (p) =>
          api.setProgress(0.92 + p * 0.06, `Encoding ${(p * 100).toFixed(0)}%`));
        const fmt = getFormat(formatId);
        addAsset({
          id: uid('asset'),
          name: entry.file.name.replace(/\.[^.]+$/, '') + '.' + (fmt?.extension ?? 'wav'),
          kind: 'audio',
          createdAt: Date.now(),
          mimeType: fmt?.mime ?? 'audio/wav',
          sizeBytes: blob.size,
          durationSec: full.duration,
          buffer: full,
          blobUrl: URL.createObjectURL(blob),
          meta: { source: entry.file.name, chunks: chunks.length },
        });
        api.log(`Done: ${formatBytes(blob.size)}, ${full.duration.toFixed(1)}s`);
        return { fileName: entry.file.name, bytes: blob.size, durationSec: full.duration };
      },
    );
    // poll for completion to clear spinner + toast
    const t = setInterval(() => {
      const jobs = useAppStore.getState().jobs;
      const job = jobs.find((j) => j.label === `Speak "${entry.file.name}" → ${getFormat(formatId)?.label ?? formatId}`);
      if (job && ['done', 'error', 'cancelled'].includes(job.status)) {
        setConverting((s) => { const n = new Set(s); n.delete(entry.id); return n; });
        clearInterval(t);
        if (job.status === 'done') toast({ title: `Converted ${entry.file.name}`, description: 'Saved to asset bin.' });
        else if (job.status === 'error') toast({ title: `Conversion failed`, description: job.error, variant: 'destructive' });
      }
    }, 500);
  }, [converting, settings.outputFormat, settings.sampleRate, settings.channels, tuned.ttsChunkChars, tuned.synthesisQuality, addAsset, toast]);

  const doneCount = entries.filter((e) => e.status === 'done').length;
  const errCount = entries.filter((e) => e.status === 'error').length;
  const totalSpeakable = entries.reduce((a, e) => a + (e.result?.text.length ?? 0), 0);
  const speakableEntries = entries.filter((e) => e.status === 'done' && e.result?.text.trim() && !converting.has(e.id));

  // batch: queue every parsed, speakable file in one go (FIFO through the job queue)
  const convertAll = useCallback(() => {
    if (!speakableEntries.length) return;
    const names = speakableEntries.map((e) => e.file.name);
    speakableEntries.forEach((entry) => convertToAudio(entry));
    toast({
      title: `Batch queued — ${names.length} file${names.length === 1 ? '' : 's'}`,
      description: `Queued in order: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3} more` : ''}. Boost any job in Activity & Queue to jump the line.`,
    });
  }, [speakableEntries, convertToAudio, toast]);

  return (
    <div className="space-y-4">
      <SectionPanel
        title="Local file intake"
        description={`Drop or choose files — ${formatNumber(getSupportedExtensionCount())}+ extensions recognized, parsed in-browser, never uploaded. Data files become natural speech; images and videos run through local OCR; unknown binaries are analyzed intelligently.`}
        actions={<Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600"><Upload className="mr-1 h-3 w-3" />0 bytes uploaded</Badge>}
      >
        <div
          role="button"
          tabIndex={0}
          aria-label="Drop files or click to browse"
          className={cn(
            'flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors',
            dragOver ? 'border-violet-500 bg-violet-500/10' : 'border-border hover:border-violet-500/50 hover:bg-muted/40',
          )}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Upload className="h-6 w-6 text-primary" />
          </div>
          <div className="text-sm font-medium">Drop files here or click to browse</div>
          <div className="max-w-md text-xs text-muted-foreground">
            Documents (.docx .pdf .epub .rtf .html), data (.csv .json .xml .yaml), text & code, subtitles, images
            &amp; videos (OCR), audio, archives and unknown binaries — all processed intelligently &amp; locally.
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>
      </SectionPanel>

      {entries.length > 0 && (
        <SectionPanel
          title={`Files (${entries.length})`}
          description={`${doneCount} parsed · ${errCount} failed · ${formatNumber(totalSpeakable)} speakable characters extracted`}
          actions={
            <div className="flex items-center gap-1.5">
              {speakableEntries.length > 1 && (
                <Button size="sm" variant="secondary" onClick={convertAll} title="Queue every parsed file with speakable text">
                  <Layers className="mr-1.5 h-3.5 w-3.5" />Convert all ({speakableEntries.length})
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setEntries([])}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />Clear list
              </Button>
            </div>
          }
        >
          <ScrollArea className="max-h-[34rem] pr-3">
            <div className="space-y-2.5">
              {entries.map((entry) => {
                const meta = CATEGORY_META[entry.result?.category ?? categorizeFile(entry.file.name).category] ?? CATEGORY_META.unknown;
                const Icon = meta.icon;
                return (
                  <Collapsible key={entry.id} className="rounded-lg border">
                    <div className="flex items-center gap-3 p-3">
                      <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border', meta.tone)}>
                        <Icon className="h-4.5 w-4.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{entry.file.name}</div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          <span>{formatBytes(entry.file.size)}</span>
                          {entry.status === 'parsing' && <span className="text-violet-600">· {entry.message ?? 'parsing…'} ({(entry.progress * 100).toFixed(0)}%)</span>}
                          {entry.status === 'done' && entry.result && (
                            <>
                              <span>· {entry.result.category}</span>
                              <span>· {formatNumber(entry.result.text.length)} chars</span>
                              <span>· {formatMs(entry.result.durationMs)}</span>
                              {entry.result.textKind !== 'none' && entry.result.textKind !== 'plain' && (
                                <Badge variant="secondary" className="h-4 px-1 text-[10px]">{entry.result.textKind}</Badge>
                              )}
                            </>
                          )}
                          {entry.status === 'error' && <span className="text-rose-600">· {entry.message}</span>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {entry.status === 'done' && entry.result?.text.trim() && (
                          <Button size="sm" variant="outline" onClick={() => convertToAudio(entry)} disabled={converting.has(entry.id)}>
                            <Volume2 className="mr-1.5 h-3.5 w-3.5" />
                            {converting.has(entry.id) ? 'Converting…' : 'Convert to audio'}
                          </Button>
                        )}
                        {entry.status === 'done' && entry.result?.ocrSuggested && !entry.result.text.trim() && (
                          <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600">
                            <Sparkles className="mr-1 h-3 w-3" />OCR suggested — run in OCR Lab
                          </Badge>
                        )}
                        {entry.status === 'parsing' && <Progress value={entry.progress * 100} className="h-1.5 w-20" />}
                        <CollapsibleTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Toggle details">
                            <ChevronDown className="h-4 w-4 transition-transform [[data-state=open]>&]:rotate-180" />
                          </Button>
                        </CollapsibleTrigger>
                      </div>
                    </div>
                    {entry.status === 'parsing' && <Progress value={entry.progress * 100} className="h-1 rounded-none" />}
                    <CollapsibleContent>
                      <div className="border-t px-3 py-3">
                        {entry.result && (
                          <div className="space-y-2">
                            <div className="flex flex-wrap gap-1.5">
                              {Object.entries(entry.result.metadata).slice(0, 8).map(([k, v]) => (
                                <Badge key={k} variant="secondary" className="text-[10px] font-normal">{k}: {String(v)}</Badge>
                              ))}
                            </div>
                            {entry.result.warnings.map((w, i) => (
                              <div key={i} className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                                <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />{w}
                              </div>
                            ))}
                            {entry.result.preview ? (
                              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2.5 text-xs leading-relaxed">
                                {entry.result.text.slice(0, 2400)}{entry.result.text.length > 2400 ? '\n…' : ''}
                              </pre>
                            ) : (
                              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                                <Braces className="mr-1.5 inline h-3.5 w-3.5" />
                                No text extracted — enable OCR in this panel&apos;s suggestion or convert via OCR Lab for images/videos.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          </ScrollArea>
        </SectionPanel>
      )}
    </div>
  );
}
