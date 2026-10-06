'use client';

import { useCallback, useRef, useState } from 'react';
import { useAppStore } from '@/lib/stores/app-store';
import { runOcrOnImage, runOcrOnVideoFile, getOcrCapabilities, buildSrt } from '@/lib/engines/ocr';
import { aiEnhanceOcrResult } from '@/lib/engines/ai-services';
import type { OcrPower, OcrResult, OcrTimedLine, SubtitleCue } from '@/lib/types';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatMs } from '@/lib/utils/format';
import {
  AudioLines, Captions, Copy, Download, FileVideo, Image as ImageIcon, Info, ScanText, Settings2, Sparkles, Trash2,
} from 'lucide-react';

interface Job {
  id: string;
  name: string;
  kind: 'image' | 'video';
  url: string;
  status: 'idle' | 'running' | 'done' | 'error';
  progress: number;
  message?: string;
  result?: OcrResult & { framesAnalyzed?: number; timedLines?: OcrTimedLine[] };
  error?: string;
}

export function OcrLabView() {
  const { toast } = useToast();
  const tuned = useAppStore((s) => s.tuned);
  const settings = useAppStore((s) => s.settings);
  const setView = useAppStore((s) => s.setView);
  const setPendingText = useAppStore((s) => s.setPendingText);
  const setPendingSubtitleCues = useAppStore((s) => s.setPendingSubtitleCues);

  const [power, setPower] = useState<OcrPower>(tuned.ocrPower);
  const [preprocess, setPreprocess] = useState(true);
  const [minConfidence, setMinConfidence] = useState(0.35);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const capabilities = getOcrCapabilities();

  const patch = (id: string, p: Partial<Job>) =>
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...p } : j)));

  const addFiles = useCallback(async (files: File[]) => {
    const newJobs: Job[] = [];
    for (const file of files.slice(0, 8)) {
      const isVideo = file.type.startsWith('video') || /\.(mp4|webm|mov|mkv|avi)$/i.test(file.name);
      const isImage = file.type.startsWith('image') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
      if (!isImage && !isVideo) {
        toast({ title: 'Unsupported for OCR', description: `${file.name} is not an image or video.` });
        continue;
      }
      newJobs.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: file.name,
        kind: isVideo ? 'video' : 'image',
        url: URL.createObjectURL(file),
        status: 'idle',
        progress: 0,
        message: 'Ready',
      });
    }
    if (newJobs.length) {
      setJobs((list) => [...newJobs, ...list]);
      setSelected((s) => s ?? newJobs[0].id);
    }
  }, [toast]);

  const runOcr = useCallback(async (job: Job) => {
    patch(job.id, { status: 'running', progress: 0.02, message: 'Starting local OCR…' });
    try {
      const file = await fetch(job.url).then((r) => r.blob()) as unknown as File;
      Object.defineProperty(file, 'name', { value: job.name });
      const opts = {
        power,
        language: 'en',
        preprocess,
        minConfidence,
        onProgress: (p: number, msg?: string) => patch(job.id, { progress: p, message: msg }),
      };
      let result = job.kind === 'video'
        ? await runOcrOnVideoFile(file, opts)
        : await runOcrOnImage(file, opts);
      // AI post-correction
      patch(job.id, { status: 'running', progress: 0.95, message: 'AI correcting OCR…' });
      const enh = await aiEnhanceOcrResult(result, { category: job.kind, textKind: 'ocr', fileName: job.name });
      if (enh.ok && enh.value) {
        result = { ...result, text: enh.value.text, lines: enh.value.lines, avgConfidence: Math.max(result.avgConfidence, 0.8) };
      }
      patch(job.id, { status: 'done', progress: 1, result, message: enh.ok ? 'Complete (AI-corrected)' : 'Complete' });
      toast({
        title: `OCR complete — ${job.name}`,
        description: `${result.lines.length} lines · ${(result.avgConfidence * 100).toFixed(0)}% confidence · ${formatMs(result.durationMs)}${enh.ok ? ' · AI-corrected' : ''}`,
      });
    } catch (e) {
      patch(job.id, { status: 'error', error: e instanceof Error ? e.message : String(e), message: 'Failed' });
      toast({ title: 'OCR failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    }
  }, [power, preprocess, minConfidence, patch, toast]);

  const runAll = useCallback(async () => {
    for (const job of jobs.filter((j) => j.status === 'idle' || j.status === 'error')) {
      await runOcr(job);
    }
  }, [jobs, runOcr]);

  const activeJob = jobs.find((j) => j.id === selected);
  const recognized = activeJob?.result?.text ?? '';
  const timed = activeJob?.result?.timedLines ?? [];
  const srtText = timed.length ? buildSrt(timed) : '';

  const downloadSrt = () => {
    if (!srtText || !activeJob) return;
    const blob = new Blob([srtText], { type: 'application/x-subrip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = activeJob.name.replace(/\.[^.]+$/, '') + '.srt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast({ title: 'Subtitles exported', description: `${timed.length} cues written to .srt — works in any video player or editor.` });
  };

  const sendToTts = () => {
    if (!recognized.trim()) return;
    setPendingText(recognized, `OCR result from ${activeJob?.name}`);
    setView('tts');
  };

  const sendToVideoEditor = () => {
    if (!timed.length) return;
    const cues: SubtitleCue[] = timed.map((l) => ({ startSec: l.startSec, endSec: l.endSec, text: l.text }));
    setPendingSubtitleCues(cues);
    toast({ title: 'Sent — open Video Editor to apply', description: `${cues.length} timed cues queued as a subtitle track.` });
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        <SectionPanel
          title="Local OCR intake"
          description="Images and videos are recognized entirely on this machine. Engine power scales with your PC specifications and can be adjusted here."
          actions={<Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 text-violet-600"><ScanText className="mr-1 h-3 w-3" />power: {power}</Badge>}
        >
          <div
            role="button"
            tabIndex={0}
            aria-label="Drop images or videos for OCR"
            className={cn(
              'flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-5 text-center transition-colors',
              dragOver ? 'border-violet-500 bg-violet-500/10' : 'border-border hover:border-violet-500/50 hover:bg-muted/40',
            )}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); void addFiles(Array.from(e.dataTransfer.files)); }}
          >
            <ScanText className="h-6 w-6 text-primary" />
            <div className="text-sm font-medium">Drop images or videos here</div>
            <div className="text-xs text-muted-foreground">PNG · JPG · GIF · WebP · BMP · MP4 · WebM — screenshots, scans, photos, slides</div>
            <input ref={inputRef} type="file" multiple accept="image/*,video/*" className="hidden"
              onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          </div>

          {jobs.length > 0 && (
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" onClick={runAll}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />Recognize all ({jobs.filter((j) => j.status === 'idle' || j.status === 'error').length})
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { jobs.forEach((j) => URL.revokeObjectURL(j.url)); setJobs([]); setSelected(null); }}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />Clear
              </Button>
            </div>
          )}
        </SectionPanel>

        {jobs.length > 0 && (
          <SectionPanel title={`Queue (${jobs.length})`} description="Select an item to inspect its result.">
            <ScrollArea className="max-h-72 pr-3">
              <div className="space-y-2">
                {jobs.map((job) => (
                  <div
                    key={job.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelected(job.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelected(job.id); }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                      selected === job.id ? 'border-violet-500/50 bg-violet-500/5' : 'hover:bg-muted/40',
                    )}
                  >
                    {job.kind === 'video'
                      ? <FileVideo className="h-4.5 w-4.5 shrink-0 text-fuchsia-600" />
                      : <ImageIcon className="h-4.5 w-4.5 shrink-0 text-rose-600" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{job.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {job.status === 'running' && `${job.message ?? 'Working…'} (${(job.progress * 100).toFixed(0)}%)`}
                        {job.status === 'idle' && 'Ready'}
                        {job.status === 'done' && job.result && (
                          `${job.result.lines.length} lines · ${(job.result.avgConfidence * 100).toFixed(0)}% conf · ${formatMs(job.result.durationMs)}${job.result.framesAnalyzed ? ` · ${job.result.framesAnalyzed} frames` : ''}${job.result.timedLines?.length ? ` · ${job.result.timedLines.length} timed cues` : ''}`
                        )}
                        {job.status === 'error' && <span className="text-rose-600">{job.error}</span>}
                      </div>
                      {job.status === 'running' && <Progress value={job.progress * 100} className="mt-1.5 h-1" />}
                    </div>
                    {job.status === 'idle' && (
                      <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); void runOcr(job); }}>
                        Recognize
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </SectionPanel>
        )}

        {activeJob?.status === 'done' && (
          <SectionPanel
            title={`Recognized text — ${activeJob.name}`}
            description={`${activeJob.result?.regions ?? 0} regions · avg confidence ${((activeJob.result?.avgConfidence ?? 0) * 100).toFixed(0)}%`}
            actions={
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(recognized); toast({ title: 'Copied' }); }}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />Copy
                </Button>
                {activeJob.kind === 'video' && timed.length > 0 && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { void navigator.clipboard.writeText(srtText); toast({ title: 'SRT copied', description: `${timed.length} timed cues on the clipboard.` }); }}
                    >
                      <Captions className="mr-1.5 h-3.5 w-3.5" />Copy SRT
                    </Button>
                    <Button size="sm" variant="outline" onClick={downloadSrt}>
                      <Download className="mr-1.5 h-3.5 w-3.5" />Export .srt
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-violet-500/40 text-violet-600 hover:bg-violet-500/10 hover:text-violet-700"
                      onClick={sendToVideoEditor}
                    >
                      <Captions className="mr-1.5 h-3.5 w-3.5" />Send to Video Editor
                    </Button>
                  </>
                )}
                <Button size="sm" onClick={sendToTts} disabled={!recognized.trim()}>
                  <AudioLines className="mr-1.5 h-3.5 w-3.5" />Speak this
                </Button>
              </div>
            }
          >
            {activeJob.kind === 'image' ? (
              <img src={activeJob.url} alt={activeJob.name} className="mb-3 max-h-48 rounded-md border object-contain" />
            ) : (
              <video src={activeJob.url} controls className="mb-3 max-h-48 w-full rounded-md border" />
            )}
            <ScrollArea className="max-h-56 rounded-md border bg-muted/20">
              <div className="space-y-1 p-3">
                {activeJob.result?.lines.length ? (
                  activeJob.result.lines.map((l, i) => (
                    <div key={i} className="flex items-baseline gap-2 text-sm">
                      <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                        {(l.confidence * 100).toFixed(0)}%
                      </span>
                      <span className={cn(l.confidence < 0.5 && 'text-amber-600')}>{l.text}</span>
                    </div>
                  ))
                ) : (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    No text recognized. Try a higher power level, cleaner source, or enable preprocessing.
                  </div>
                )}
              </div>
            </ScrollArea>
          </SectionPanel>
        )}
      </div>

      <SectionPanel title="OCR Engine" description="Power level, preprocessing and confidence gate.">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-xs"><Settings2 className="h-3.5 w-3.5" />Engine power</Label>
            <Select value={power} onValueChange={(v) => setPower(v as OcrPower)}>
              <SelectTrigger aria-label="OCR power"><SelectValue /></SelectTrigger>
              <SelectContent>
                {capabilities.powers.map((p) => (
                  <SelectItem key={p.power} value={p.power}>
                    {p.label} <span className="text-muted-foreground">· up to {(p.maxPixels / 1e6).toFixed(0)} MP</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-start gap-1.5 rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {capabilities.powers.find((p) => p.power === power)?.description}
              {settings.ocrPowerOverride === 'auto' && power === tuned.ocrPower && ' (auto-selected from your PC specs — override in Settings)'}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label className="text-sm">Image preprocessing</Label>
              <p className="text-xs text-muted-foreground">Grayscale, contrast & Otsu binarization</p>
            </div>
            <Switch checked={preprocess} onCheckedChange={setPreprocess} />
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Minimum confidence</Label>
              <span className="text-xs tabular-nums text-muted-foreground">{(minConfidence * 100).toFixed(0)}%</span>
            </div>
            <Slider value={[minConfidence]} min={0.1} max={0.9} step={0.05} onValueChange={([v]) => setMinConfidence(v)} />
            <p className="text-[11px] text-muted-foreground">Below this score, characters become &quot;?&quot; instead of wrong guesses.</p>
          </div>

          <div className="rounded-lg border bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
            <div className="mb-1 font-medium text-foreground">How it works</div>
            The engine binarizes your image, segments character blobs via connected components, groups them into
            lines, then matches each glyph against canvas-rendered templates from {capabilities.powers.length} power
            tiers across 7 font families × 2 weights. Everything runs in this tab — zero network calls.
          </div>
        </div>
      </SectionPanel>
    </div>
  );
}
