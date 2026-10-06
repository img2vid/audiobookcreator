'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/lib/stores/app-store';
import { useMounted } from '@/hooks/use-mounted';
import { enqueueJob } from '@/lib/queue';
import { allVoiceProfiles, estimateSpeechDurationSec, isCustomProfile } from '@/lib/engines/formant';
import { synthesizeWithMarkup, parseVoiceMarkup, estimateMarkupDurationSec } from '@/lib/engines/markup';
import {
  AUDIO_FORMATS, countAvailableFormats, encodeAudioBufferChunked, getFormat, isFormatAvailable, recorderSupportMap,
} from '@/lib/engines/encode';
import { concatenateBuffers, makeSilenceBuffer, normalizeBuffer } from '@/lib/engines/dsp';
import { insertWavCueChunks, type WavCuePoint } from '@/lib/engines/wav-cues';
import {
  saveAudiobookDraft, loadAudiobookDraft, clearAudiobookDraft, draftHasContent,
} from '@/lib/engines/audiobook-db';
import type { AssetItem } from '@/lib/types';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatDuration, formatNumber } from '@/lib/utils/format';
import { uid } from '@/lib/utils/async';
import { saveProject } from '@/lib/engines/project-vault';
import {
  BookOpen, Bookmark, ChevronDown, ChevronUp, ClipboardPaste, Copy, Download, FileJson, GripVertical, Headphones,
  Image as ImageIcon, ListChecks, ListMusic, Merge, Package, Palette, Pause, PencilLine, Play, Plus, Save, Scissors,
  Sparkles, Square, Timer, Trash2, TriangleAlert, Wand2,
} from 'lucide-react';

interface Chapter {
  id: string;
  title: string;
  text: string;
  voiceProfile: string;
  rate: number;
  status: 'draft' | 'queued' | 'rendered' | 'error';
  progress: number;
  buffer?: AudioBuffer;
  blobUrl?: string;
  bytes?: number;
}

interface DictRule {
  id: string;
  find: string;
  replace: string;
  enabled: boolean;
}

// ---------- device encoder capability (format-picker badges) ----------
// Availability mirrors the encodeAudioBufferChunked routing exactly: ids keyed in
// recorderSupportMap are the MediaRecorder compressed family (WebM/MP4/Ogg) and
// depend on browser codec support; every other AUDIO_FORMATS entry is one of the
// app's own byte-level PCM writers and is always available. Pure functions — no
// top-level browser access, so the module stays SSR-safe.
type FormatDotState = 'native' | 'recorder' | 'none';

const FORMAT_STATE_ARIA: Record<FormatDotState, string> = {
  native: 'available natively',
  recorder: 'available via hardware encoder',
  none: 'unavailable',
};

function formatDotState(id: string): FormatDotState {
  const support = recorderSupportMap();
  if (support[id] !== undefined) return support[id] ? 'recorder' : 'none';
  return isFormatAvailable(id, AUDIO_FORMATS) ? 'native' : 'none';
}

// ---------- listen bookmarks (resume positions per book, localStorage) ----------
interface ListenMark { chapterId: string; pos: number; at: number }
const MARKS_KEY = 'auravoice-listen-marks';

function loadMarks(): Record<string, ListenMark> {
  try {
    return JSON.parse(localStorage.getItem(MARKS_KEY) ?? '{}') as Record<string, ListenMark>;
  } catch { return {}; }
}
function saveMark(bookKey: string, mark: ListenMark): void {
  try {
    const all = loadMarks();
    all[bookKey] = mark;
    localStorage.setItem(MARKS_KEY, JSON.stringify(all));
  } catch { /* best-effort */ }
}
function clearMark(bookKey: string): void {
  try {
    const all = loadMarks();
    delete all[bookKey];
    localStorage.setItem(MARKS_KEY, JSON.stringify(all));
  } catch { /* best-effort */ }
}

// ---------- per-chapter cover thumbnail (120×180 canvas → dataURL) ----------
function drawChapterThumbDataUrl(chapterTitle: string, index: number, bookTitle: string, accent: (typeof COVER_ACCENTS)[number]): string {
  const W = 120;
  const H = 180;
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const ctx = off.getContext('2d');
  if (!ctx) return '';
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, accent.deep);
  g.addColorStop(1, accent.base);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // mini waveform arcs
  ctx.globalAlpha = 0.45;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.strokeStyle = i % 2 ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.5;
    ctx.arc(W / 2, 128, 12 + i * 9, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = '800 30px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(String(index), 10, 38);
  // wrapped chapter title (max 3 lines)
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  const words = chapterTitle.replace(/^chapter\s+\d+[:.]?\s*/i, '').split(/\s+/);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + w).length <= 14) lines[lines.length - 1] = last + ' ' + w;
    else lines.push(w);
    if (lines.length === 3) break;
  }
  lines.forEach((l, i) => ctx.fillText(l, 10, 58 + i * 15));
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '500 7px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText((bookTitle || 'AURAVOICE').toUpperCase().slice(0, 20), 10, H - 10);
  return off.toDataURL('image/png');
}

const SAMPLE_BOOK = `Chapter 1: The Machine That Listened

The workshop smelled of ozone and warm dust. Ada turned the dial slowly, and for the first time in three years, the machine answered.

"Hello," it said, in a voice assembled from oscillators and hope.

Chapter 2: Voices in the Wires

News traveled fast through the quarter. By morning, a dozen people stood outside her door, each holding a letter they could not read, each hoping the machine would read it aloud.

Ada charged no coin. "Words belong to everyone," she said.

Chapter 3: The Long Winter

When the storm cut the roads, the machine became the town's storyteller. Every evening it spoke chapters of forgotten books while snow sealed the windows shut.`;

// ---------- tolerant chapter paste parser ----------
// Accepts either "Title | text" per line (first '|' splits) or "## Title" (any #-depth)
// headings whose following lines form the body. Anything else becomes its own
// "Chapter N" so partial markers still produce chapters. Capped at 200 like the
// transcript handoff channel; empty bodies are dropped.
function parsePastedChapters(raw: string): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  let current: { title: string; text: string } | null = null;
  const flush = () => {
    if (current && current.text.trim()) out.push(current);
    current = null;
  };
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      current = { title: heading[1].trim(), text: '' };
      continue;
    }
    if (current) {
      current.text = current.text ? `${current.text}\n${line}` : line;
      continue;
    }
    const pipe = line.indexOf('|');
    if (pipe > 0 && line.slice(0, pipe).trim() && line.slice(pipe + 1).trim()) {
      out.push({ title: line.slice(0, pipe).trim(), text: line.slice(pipe + 1).trim() });
    } else {
      out.push({ title: `Chapter ${out.length + 1}`, text: line });
    }
  }
  flush();
  return out.slice(0, 200);
}

// ---------- chapter split planner (R11-d) ----------
// Pure planning for the per-chapter "Split chapter" dialog. Modes: 'blank' splits
// on blank-line runs (paragraphs), 'sentences' groups every N sentences per part
// using a naive [.!?]+ boundary, 'marker' splits on lines whose trimmed content is
// exactly '---'. Parts are trimmed, empties dropped, and the result is capped at 40
// parts by folding the tail into the last kept part (no content is silently lost).
// A text with no split points comes back as a single part (the dialog shows a
// "No split points found" warning); whitespace-only text yields [].
type SplitMode = 'blank' | 'sentences' | 'marker';

const SPLIT_PART_CAP = 40;

/** Naive sentence tokenizer: runs of text ending in [.!?]+ plus any closing quotes/brackets. */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(/[^.!?]+[.!?]+["'”’)\]]*(?:\s+|$)/g)) {
    const s = m[0].trim();
    if (s) out.push(s);
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < text.length) {
    const tail = text.slice(last).trim();
    if (tail) out.push(tail);
  }
  return out;
}

function planChapterSplit(text: string, mode: SplitMode, n: number): string[] {
  const src = text.trim();
  if (!src) return [];
  let parts: string[];
  if (mode === 'blank') {
    parts = src.split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
  } else if (mode === 'sentences') {
    const every = Math.min(10, Math.max(1, Math.round(Number.isFinite(n) ? n : 4)));
    const sentences = splitSentences(src);
    parts = [];
    for (let i = 0; i < sentences.length; i += every) {
      const chunk = sentences.slice(i, i + every).join(' ');
      if (chunk) parts.push(chunk);
    }
  } else {
    parts = [''];
    for (const line of src.split(/\r?\n/)) {
      if (line.trim() === '---') parts.push('');
      else parts[parts.length - 1] = parts[parts.length - 1] ? `${parts[parts.length - 1]}\n${line.trim()}` : line.trim();
    }
    parts = parts.map((p) => p.trim()).filter(Boolean);
  }
  if (parts.length <= 1) return [src];
  if (parts.length > SPLIT_PART_CAP) {
    parts = [...parts.slice(0, SPLIT_PART_CAP - 1), parts.slice(SPLIT_PART_CAP - 1).join('\n\n')];
  }
  return parts;
}

// ---------- cover art studio ----------
const COVER_PRESETS = ['aurora', 'minimal', 'classic', 'bold'] as const;
type CoverPreset = (typeof COVER_PRESETS)[number];

const COVER_ACCENTS = [
  { id: 'violet', base: '#8b5cf6', deep: '#4c1d95', soft: '#ede9fe' },
  { id: 'emerald', base: '#10b981', deep: '#064e3b', soft: '#d1fae5' },
  { id: 'amber', base: '#f59e0b', deep: '#78350f', soft: '#fef3c7' },
  { id: 'rose', base: '#f43f5e', deep: '#881337', soft: '#ffe4e6' },
  { id: 'zinc', base: '#71717a', deep: '#27272a', soft: '#f4f4f5' },
] as const;

/** Draws a 600×900 audiobook cover directly to a canvas — pure local canvas 2D, four styles. */
function drawCoverArt(
  canvas: HTMLCanvasElement,
  opts: { title: string; author: string; narrator: string; preset: CoverPreset; accent: (typeof COVER_ACCENTS)[number] },
) {
  const W = 600;
  const H = 900;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { title, author, preset, accent } = opts;
  const titleLines: string[] = [];
  // naive wrap to ≤ 22 chars/line, max 4 lines
  for (const word of (title || 'Untitled Audiobook').split(/\s+/)) {
    const last = titleLines[titleLines.length - 1];
    if (last && (last + ' ' + word).length <= 22) titleLines[titleLines.length - 1] = last + ' ' + word;
    else titleLines.push(word);
    if (titleLines.length === 4) break;
  }

  if (preset === 'aurora') {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, accent.deep);
    g.addColorStop(0.55, accent.base);
    g.addColorStop(1, accent.soft);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // decorative waveform arcs
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 7; i++) {
      ctx.beginPath();
      ctx.strokeStyle = i % 2 ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 2 + i * 1.5;
      ctx.arc(W / 2, 620, 60 + i * 26, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '700 44px ui-sans-serif, system-ui, sans-serif';
    titleLines.forEach((l, i) => ctx.fillText(l, 48, 150 + i * 54));
    ctx.font = '400 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(author || 'Unknown author', 48, 160 + titleLines.length * 54);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.font = '500 16px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('AUDIOBOOK · AURAVOICE LOCAL', 48, 856);
  } else if (preset === 'minimal') {
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = accent.base;
    ctx.fillRect(48, 96, 84, 10);
    ctx.fillStyle = '#18181b';
    ctx.font = '700 46px ui-sans-serif, system-ui, sans-serif';
    titleLines.forEach((l, i) => ctx.fillText(l, 48, 200 + i * 58));
    ctx.font = '400 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#52525b';
    ctx.fillText(author || 'Unknown author', 48, 216 + titleLines.length * 58);
    // thin waveform strip
    ctx.fillStyle = accent.base;
    for (let x = 0; x < 40; x++) {
      const h = 8 + Math.abs(Math.sin(x * 0.7)) * 54;
      ctx.fillRect(48 + x * 13, 700 - h / 2, 5, h);
    }
    ctx.fillStyle = '#a1a1aa';
    ctx.font = '500 15px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('AUDIOBOOK · AURAVOICE LOCAL', 48, 856);
  } else if (preset === 'classic') {
    ctx.fillStyle = accent.soft;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = accent.deep;
    ctx.lineWidth = 4;
    ctx.strokeRect(26, 26, W - 52, H - 52);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(38, 38, W - 76, H - 76);
    ctx.fillStyle = accent.deep;
    ctx.textAlign = 'center';
    ctx.font = '700 44px ui-serif, Georgia, serif';
    titleLines.forEach((l, i) => ctx.fillText(l, W / 2, 300 + i * 56));
    ctx.font = 'italic 24px ui-serif, Georgia, serif';
    ctx.fillText(author || 'Unknown author', W / 2, 324 + titleLines.length * 56);
    // ornament
    ctx.beginPath();
    ctx.moveTo(W / 2 - 60, 690);
    ctx.lineTo(W / 2 + 60, 690);
    ctx.moveTo(W / 2, 676);
    ctx.lineTo(W / 2, 704);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '500 15px ui-serif, Georgia, serif';
    ctx.fillText('AUDIOBOOK · AURAVOICE LOCAL', W / 2, 848);
    ctx.textAlign = 'left';
  } else {
    // bold
    ctx.fillStyle = accent.deep;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = accent.base;
    ctx.fillRect(0, 560, W, 130);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 64px ui-sans-serif, system-ui, sans-serif';
    const bigLines = titleLines.slice(0, 3);
    bigLines.forEach((l, i) => ctx.fillText(l.toUpperCase(), 40, 170 + i * 78));
    ctx.fillStyle = accent.soft;
    ctx.font = '700 30px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText((author || 'Unknown author').toUpperCase(), 40, 640);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '600 18px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('NARRATED LOCALLY BY ' + (opts.narrator || 'AURAVOICE').toUpperCase(), 40, 800);
    ctx.fillStyle = accent.base;
    ctx.font = '600 15px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('AUDIOBOOK · AURAVOICE LOCAL', 40, 856);
  }
}

function CoverStudio({
  meta,
  preset, accent,
  setPreset, setAccent,
  onSave,
}: {
  meta: { title: string; author: string; narrator: string };
  preset: CoverPreset;
  accent: (typeof COVER_ACCENTS)[number];
  setPreset: (p: CoverPreset) => void;
  setAccent: (a: (typeof COVER_ACCENTS)[number]) => void;
  onSave?: (dataUrl: string) => void;
}) {
  const { toast } = useToast();
  const addAsset = useAppStore((s) => s.addAsset);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (c) drawCoverArt(c, { title: meta.title, author: meta.author, narrator: meta.narrator, preset, accent });
  }, [meta.title, meta.author, meta.narrator, preset, accent]);

  const savePng = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      addAsset({
        id: uid('asset'),
        name: `${meta.title.replace(/\s+/g, '-').toLowerCase()}-cover.png`,
        kind: 'image',
        createdAt: Date.now(),
        mimeType: 'image/png',
        sizeBytes: blob.size,
        width: c.width,
        height: c.height,
        blobUrl: url,
        meta: { source: 'cover-studio', preset, accent: accent.id },
      });
      if (onSave) {
        // parent (package export) consumes the live dataURL
        onSave(c.toDataURL('image/png'));
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = `${meta.title.replace(/\s+/g, '-').toLowerCase()}-cover.png`;
      a.click();
      toast({ title: 'Cover saved', description: 'PNG added to the asset bin and downloaded.' });
    }, 'image/png');
  }, [meta.title, preset, accent, addAsset, toast, onSave]);

  return (
    <div className="space-y-3">
      <canvas ref={canvasRef} className="aspect-[2/3] w-full rounded-lg border shadow-sm" aria-label="Audiobook cover preview" />
      <div className="space-y-2">
        <Label className="text-xs">Style</Label>
        <div className="grid grid-cols-4 gap-1.5">
          {COVER_PRESETS.map((p) => (
            <Button key={p} size="sm" variant={preset === p ? 'secondary' : 'outline'}
              className={cn('h-7 px-1 text-[11px] capitalize', preset === p && 'ring-1 ring-primary')}
              onClick={() => setPreset(p)}>
              {p}
            </Button>
          ))}
        </div>
        <Label className="text-xs">Accent</Label>
        <div className="flex gap-1.5">
          {COVER_ACCENTS.map((a) => (
            <button key={a.id} type="button" aria-label={`Accent ${a.id}`}
              onClick={() => setAccent(a)}
              className={cn('h-6 w-6 rounded-full border-2 transition-transform hover:scale-110', accent.id === a.id ? 'border-foreground' : 'border-transparent')}
              style={{ backgroundColor: a.base }} />
          ))}
        </div>
      </div>
      <Button size="sm" variant="outline" className="w-full" onClick={savePng}>
        <ImageIcon className="mr-1.5 h-3.5 w-3.5" />Save cover as PNG
      </Button>
      <p className="text-[11px] leading-snug text-muted-foreground">
        The cover is drawn locally on canvas from the book metadata and embedded into the M4B-style package manifest.
      </p>
    </div>
  );
}

// ---------- package timeline (shared by the package job and the chapter-list copy button) ----------
interface PackageTiming {
  index: number;
  title: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  voice: string;
  rate: number;
}

/**
 * Builds the combined package timeline: rendered chapters in order with the
 * configured gap silence between them. Returns both the buffer sequence (for
 * concatenation) and per-chapter start/end offsets on the combined timeline.
 */
function buildPackageTimeline(chapters: Chapter[], gapSec: number): { buffers: AudioBuffer[]; timings: PackageTiming[] } {
  const rendered = chapters.filter((c) => c.status === 'rendered' && c.buffer);
  const buffers: AudioBuffer[] = [];
  const timings: PackageTiming[] = [];
  let cursor = 0;
  for (let i = 0; i < rendered.length; i++) {
    const c = rendered[i];
    const start = cursor;
    buffers.push(c.buffer!);
    cursor += c.buffer!.duration;
    const end = cursor;
    timings.push({ index: i + 1, title: c.title, startSec: +start.toFixed(3), endSec: +end.toFixed(3), durationSec: +c.buffer!.duration.toFixed(3), voice: c.voiceProfile, rate: c.rate });
    if (i < rendered.length - 1 && gapSec > 0) {
      buffers.push(makeSilenceBuffer(gapSec, c.buffer!.sampleRate, 1));
      cursor += gapSec;
    }
  }
  return { buffers, timings };
}

/** YouTube-style timestamp — mm:ss, switching to h:mm:ss once over an hour. */
function youTubeStamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function AudiobookView() {
  const { toast } = useToast();
  const mounted = useMounted();
  const tuned = useAppStore((s) => s.tuned);
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);
  const addAsset = useAppStore((s) => s.addAsset);
  const customProfiles = useAppStore((s) => s.customProfiles);
  const pendingTranscriptChapters = useAppStore((s) => s.pendingTranscriptChapters);
  const setPendingTranscriptChapters = useAppStore((s) => s.setPendingTranscriptChapters);
  // device encoder capability — probed client-side only (MediaRecorder is undefined
  // during SSR); useMounted gates rendering so server HTML matches the first client render
  const availableCount = mounted ? countAvailableFormats(AUDIO_FORMATS) : null;
  const formatUnavailable = mounted && !isFormatAvailable(settings.outputFormat || 'wav-16', AUDIO_FORMATS);

  const [meta, setMeta] = useState({ title: 'Untitled Audiobook', author: '', narrator: 'AuraVoice', genre: 'Fiction' });
  const [rawText, setRawText] = useState('');
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [rules, setRules] = useState<DictRule[]>([
    { id: uid('rule'), find: 'Ada', replace: 'Ay-da', enabled: true },
  ]);
  const [gapSec, setGapSec] = useState(0.8);
  const [useFallbackVoice, setUseFallbackVoice] = useState('aura-neutral');
  const [globalRate, setGlobalRate] = useState(0.95);
  const [rendering, setRendering] = useState(false);
  const [splitMarker, setSplitMarker] = useState('');
  const [saving, setSaving] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  // chapter power tools — selection mode, split planner, screen-reader announcements
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [splitFor, setSplitFor] = useState<string | null>(null);
  const [splitMode, setSplitMode] = useState<SplitMode>('blank');
  const [splitEveryRaw, setSplitEveryRaw] = useState('4');
  const [liveMsg, setLiveMsg] = useState('');
  // cover studio + chapter text editor
  const [coverPreset, setCoverPreset] = useState<CoverPreset>('aurora');
  const [coverAccent, setCoverAccent] = useState<(typeof COVER_ACCENTS)[number]>(COVER_ACCENTS[0]);
  const [expandedChapter, setExpandedChapter] = useState<string | null>(null);
  const coverDataUrlRef = useRef<string | null>(null);

  // Built-in + custom (Voice Library) voice profiles — recomputed when the store's
  // customProfiles array changes so pickers re-render when voices are added or
  // deleted. Engine registration itself is handled by the app-store mirror.
  const voiceProfiles = useMemo(() => allVoiceProfiles(), [customProfiles]);

  // ---------- draft autosave (IndexedDB, debounced) ----------
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const d = await loadAudiobookDraft();
      if (cancelled) return;
      if (d && draftHasContent(d)) {
        const accent = COVER_ACCENTS.find((a) => a.id === d.coverAccentId) ?? COVER_ACCENTS[0];
        setMeta(d.meta);
        setRawText(d.rawText);
        setSplitMarker(d.splitMarker);
        setGapSec(d.gapSec);
        setUseFallbackVoice(d.defaultVoice || 'aura-neutral');
        setGlobalRate(d.globalRate || 0.95);
        setCoverPreset((COVER_PRESETS as readonly string[]).includes(d.coverPreset) ? (d.coverPreset as CoverPreset) : 'aurora');
        setCoverAccent(accent);
        setRules(d.rules.map((r) => ({ ...r })));
        setChapters(d.chapters.map((c) => ({
          id: c.id || uid('ch'),
          title: c.title,
          text: c.text,
          voiceProfile: c.voiceProfile,
          rate: c.rate,
          status: 'draft',
          progress: 0,
        })));
        setDraftRestored(true);
        toast({ title: 'Draft restored', description: `“${d.meta.title}” — ${d.chapters.length} chapter${d.chapters.length === 1 ? '' : 's'} saved ${new Date(d.savedAt).toLocaleString()}.` });
      } else {
        setDraftRestored(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!draftRestored) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      void saveAudiobookDraft({
        savedAt: Date.now(),
        meta,
        rawText,
        splitMarker,
        gapSec,
        defaultVoice: useFallbackVoice,
        globalRate,
        coverPreset,
        coverAccentId: coverAccent.id,
        rules: rules.map((r) => ({ id: r.id, find: r.find, replace: r.replace, enabled: r.enabled })),
        chapters: chapters.map((c) => ({ id: c.id, title: c.title, text: c.text, voiceProfile: c.voiceProfile, rate: c.rate })),
      }).then(() => setDraftSavedAt(Date.now()));
    }, 1200);
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current); };
  }, [draftRestored, meta, rawText, splitMarker, gapSec, useFallbackVoice, globalRate, coverPreset, coverAccent, rules, chapters]);

  const discardDraft = useCallback(() => {
    void clearAudiobookDraft();
    setDraftSavedAt(null);
    toast({ title: 'Draft cleared from device', description: 'Current work stays open — autosave restarts on the next change.' });
  }, [toast]);

  // ---------- listen player + sleep timer + bookmarks ----------
  const [listen, setListen] = useState<{ chapterId: string; pos: number; dur: number; playing: boolean } | null>(null);
  const [sleepMin, setSleepMin] = useState<number | null>(null); // null=off, 0=end of chapter, N=minutes
  const [sleepRemaining, setSleepRemaining] = useState<number | null>(null);
  const sleepDeadlineRef = useRef<number | null>(null);
  const sleepModeRef = useRef<'off' | 'minutes' | 'end'>('off');
  const listenRef = useRef<{ src: AudioBufferSourceNode; ctx: AudioContext; gain: GainNode; startedAt: number; offset: number } | null>(null);
  const listenRafRef = useRef<number | null>(null);
  const lastMarkRef = useRef(0);

  const listenChapter = useMemo(
    () => (listen ? chapters.find((c) => c.id === listen.chapterId) ?? null : null),
    [listen, chapters],
  );
  const savedMark = loadMarks()[meta.title] ?? null;

  // per-chapter cover thumbnails (redrawn only when chapter titles/accent change)
  const thumbs = useMemo(() => {
    const map = new Map<string, string>();
    chapters.forEach((c, i) => {
      map.set(c.id, drawChapterThumbDataUrl(c.title, i + 1, meta.title, coverAccent));
    });
    return map;
  }, [chapters.map((c) => `${c.id}:${c.title}`).join('|'), meta.title, coverAccent]);

  const stopListen = useCallback((save = true) => {
    const cur = listenRef.current;
    const l = listen;
    if (cur) {
      const pos = cur.offset + (cur.ctx.currentTime - cur.startedAt);
      try { cur.src.onended = null; cur.src.stop(); } catch { /* stopped */ }
      if (save && l && pos > 1) saveMark(meta.title, { chapterId: l.chapterId, pos, at: Date.now() });
      listenRef.current = null;
    }
    if (listenRafRef.current != null) { cancelAnimationFrame(listenRafRef.current); listenRafRef.current = null; }
    sleepDeadlineRef.current = null;
    setSleepRemaining(null);
    setListen((prev) => (prev ? { ...prev, playing: false } : prev));
  }, [listen, meta.title]);

  const playChapter = useCallback((ch: Chapter, fromSec?: number) => {
    if (!ch.buffer) return;
    const buffer = ch.buffer; // stable capture for the tick closure
    stopListen(true);
    const mark = loadMarks()[meta.title];
    const autoResume = !fromSec && mark && mark.chapterId === ch.id && mark.pos > 1 && mark.pos < buffer.duration - 1 ? mark.pos : 0;
    const offset = Math.min(fromSec ?? autoResume, Math.max(0, buffer.duration - 0.05));
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(ctx.destination);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    src.onended = () => {
      if (listenRef.current?.src === src) {
        clearMark(meta.title);
        listenRef.current = null;
        if (listenRafRef.current != null) { cancelAnimationFrame(listenRafRef.current); listenRafRef.current = null; }
        sleepDeadlineRef.current = null;
        setSleepRemaining(null);
        setListen(null);
      }
    };
    src.start(0, offset);
    listenRef.current = { src, ctx, gain, startedAt: ctx.currentTime, offset };
    lastMarkRef.current = offset;
    setListen({ chapterId: ch.id, pos: offset, dur: buffer.duration, playing: true });
    if (autoResume > 1 && !fromSec) {
      toast({ title: 'Resumed from bookmark', description: `${ch.title} — continuing at ${formatDuration(autoResume)}.` });
    }
    const tick = () => {
      const cur = listenRef.current;
      if (!cur || cur.src !== src) return;
      const pos = cur.offset + (cur.ctx.currentTime - cur.startedAt);
      // sleep timer: fade the last 10 s, stop at zero
      if (sleepModeRef.current === 'minutes') {
        const dl = sleepDeadlineRef.current;
        if (dl != null) {
          const remaining = (dl - Date.now()) / 1000;
          setSleepRemaining(Math.max(0, remaining));
          cur.gain.gain.value = Math.min(1, Math.max(0.001, remaining / 10));
          if (remaining <= 0) {
            saveMark(meta.title, { chapterId: ch.id, pos, at: Date.now() });
            try { src.onended = null; src.stop(); } catch { /* stopped */ }
            listenRef.current = null;
            sleepDeadlineRef.current = null;
            setSleepRemaining(null);
            setListen({ chapterId: ch.id, pos, dur: buffer.duration, playing: false });
            toast({ title: 'Sleep timer finished', description: 'Playback paused — bookmark saved.' });
            return;
          }
        }
      } else if (sleepModeRef.current === 'end') {
        const remaining = buffer.duration - pos;
        cur.gain.gain.value = Math.min(1, Math.max(0.001, remaining / 10));
      }
      if (pos - lastMarkRef.current > 3) {
        lastMarkRef.current = pos;
        saveMark(meta.title, { chapterId: ch.id, pos, at: Date.now() });
      }
      setListen((l) => (l && l.chapterId === ch.id ? { ...l, pos, playing: true } : l));
      listenRafRef.current = requestAnimationFrame(tick);
    };
    listenRafRef.current = requestAnimationFrame(tick);
  }, [stopListen, meta.title, toast]);

  const pauseListen = useCallback(() => {
    const cur = listenRef.current;
    if (cur && listen) {
      const pos = cur.offset + (cur.ctx.currentTime - cur.startedAt);
      saveMark(meta.title, { chapterId: listen.chapterId, pos, at: Date.now() });
      try { cur.src.onended = null; cur.src.stop(); } catch { /* stopped */ }
      listenRef.current = null;
      if (listenRafRef.current != null) { cancelAnimationFrame(listenRafRef.current); listenRafRef.current = null; }
      setListen((l) => (l ? { ...l, pos, playing: false } : l));
    } else if (listen && listenChapter?.buffer) {
      playChapter(listenChapter, listen.pos);
    }
  }, [listen, listenChapter, meta.title, playChapter]);

  const setSleepTimer = useCallback((min: number | null) => {
    setSleepMin(min);
    sleepModeRef.current = min == null ? 'off' : min === 0 ? 'end' : 'minutes';
    sleepDeadlineRef.current = min != null && min > 0 ? Date.now() + min * 60_000 : null;
    if (min != null && min > 0) setSleepRemaining(min * 60);
    else setSleepRemaining(null);
    const cur = listenRef.current;
    if (cur && min == null) cur.gain.gain.value = 1;
  }, []);

  useEffect(() => () => {
    // unmount cleanup: stop audio without overwriting the bookmark
    const cur = listenRef.current;
    if (cur) { try { cur.src.onended = null; cur.src.stop(); } catch { /* stopped */ } }
    if (listenRafRef.current != null) cancelAnimationFrame(listenRafRef.current);
  }, []);

  // ---------- chapter drag reordering ----------
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverEdge, setDragOverEdge] = useState<'top' | 'bottom'>('top');

  // Array-move reorder + polite live-region announcement. The hovered edge decides
  // the insert point: dropping on the top edge lands BEFORE the target row, the
  // bottom edge AFTER it (the index shifts by one when the drag started above).
  const reorderChapters = useCallback((fromId: string, toId: string, edge: 'top' | 'bottom') => {
    const from = chapters.findIndex((c) => c.id === fromId);
    const to = chapters.findIndex((c) => c.id === toId);
    if (from === -1 || to === -1 || from === to) return;
    const copy = [...chapters];
    const [moved] = copy.splice(from, 1);
    const target = (from < to ? to - 1 : to) + (edge === 'bottom' ? 1 : 0);
    copy.splice(target, 0, moved);
    setChapters(copy);
    setLiveMsg(`Moved “${moved.title}” to position ${copy.indexOf(moved) + 1} of ${copy.length}`);
  }, [chapters]);

  const moveChapter = useCallback((id: string, dir: -1 | 1) => {
    const i = chapters.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= chapters.length) return;
    const copy = [...chapters];
    const moved = copy[i];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    setChapters(copy);
    setLiveMsg(`Moved “${moved.title}” to position ${j + 1} of ${copy.length}`);
  }, [chapters]);

  const applyRules = useCallback((text: string) => {
    let out = text;
    for (const r of rules) {
      if (!r.enabled || !r.find) continue;
      try {
        out = out.replace(new RegExp(r.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), r.replace);
      } catch { /* invalid pattern — skip */ }
    }
    return out;
  }, [rules]);

  // ---------- shared chapter factory (detect / transcript handoff / paste) ----------
  const makeChapters = useCallback((parts: { title: string; text: string }[]): Chapter[] =>
    parts
      .filter((p) => p.text)
      .map((p) => ({
        id: uid('ch'),
        title: p.title.slice(0, 80),
        text: p.text,
        voiceProfile: useFallbackVoice,
        rate: globalRate,
        status: 'draft' as const,
        progress: 0,
      })), [useFallbackVoice, globalRate]);

  // ---------- consume the Transcribe Studio → Audiobook chapter handoff ----------
  // Push-based channel, consume-once: validate tolerantly (trimmed non-empty
  // title + text, cap 200), append through the shared chapter factory, toast, then
  // clear the channel so the same batch never lands twice. Gated on the draft
  // restore so imported chapters can't be overwritten by a late IndexedDB load.
  useEffect(() => {
    if (!draftRestored || !pendingTranscriptChapters) return;
    setPendingTranscriptChapters(null);
    const valid = pendingTranscriptChapters
      .filter((c) => c && typeof c.title === 'string' && typeof c.text === 'string')
      .map((c) => ({ title: c.title.trim(), text: c.text.trim() }))
      .filter((c) => c.title && c.text)
      .slice(0, 200);
    if (!valid.length) {
      toast({ title: 'Nothing to import', description: 'The transcript handoff had no chapters with both a title and text.' });
      return;
    }
    setSelectedIds(new Set());
    setChapters((l) => [...l, ...makeChapters(valid)]);
    toast({ title: `${valid.length} chapter${valid.length === 1 ? '' : 's'} imported from transcript`, description: 'Appended to the chapter list — reorder, edit or render as usual.' });
  }, [draftRestored, pendingTranscriptChapters, setPendingTranscriptChapters, makeChapters, toast]);

  const importPastedChapters = useCallback((replace: boolean) => {
    const parsed = parsePastedChapters(pasteText);
    if (!parsed.length) {
      toast({ title: 'Nothing to import', description: 'Use “Title | text” per line, or “## Title” headings followed by paragraph lines.' });
      return;
    }
    const created = makeChapters(parsed);
    setSelectedIds(new Set());
    setChapters((l) => (replace ? created : [...l, ...created]));
    setPasteOpen(false);
    setPasteText('');
    toast({ title: replace ? 'Chapters replaced' : 'Chapters appended', description: `${created.length} chapter${created.length === 1 ? '' : 's'} from pasted text.` });
  }, [pasteText, makeChapters, toast]);

  const detectChapters = useCallback(() => {
    const source = rawText.trim();
    if (!source) return;
    let parts: { title: string; text: string }[];
    if (splitMarker.trim()) {
      const marker = splitMarker.trim();
      const chunks = source.split(new RegExp(`\\n?\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n?`));
      parts = chunks.map((c, i) => ({ title: `Part ${i + 1}`, text: c.trim() })).filter((p) => p.text);
    } else {
      const matches = Array.from(source.matchAll(/\n?\s*((?:Chapter|CHAPTER|Part|PART|Book|BOOK)\s+[\dIVXLC]+[.:—-]?[^\n]*)\n?/g));
      if (matches.length === 0) {
        parts = [{ title: 'Chapter 1', text: source }];
      } else {
        parts = [];
        const first = matches[0];
        if (first.index && first.index > 40) {
          parts.push({ title: 'Introduction', text: source.slice(0, first.index).trim() });
        }
        for (let i = 0; i < matches.length; i++) {
          const start = matches[i].index! + matches[i][0].length;
          const end = i + 1 < matches.length ? matches[i + 1].index! : source.length;
          parts.push({ title: matches[i][1].trim(), text: source.slice(start, end).trim() });
        }
      }
    }
    const created = makeChapters(parts);
    setSelectedIds(new Set());
    setChapters(created);
    toast({ title: 'Chapters detected', description: `${created.length} chapters created.` });
  }, [rawText, splitMarker, makeChapters, toast]);

  // ---------- chapter power tools (merge / duplicate / split) ----------
  const mergeWithNext = useCallback((id: string) => {
    const i = chapters.findIndex((c) => c.id === id);
    if (i === -1 || i >= chapters.length - 1) return;
    const first = chapters[i];
    const second = chapters[i + 1];
    const merged: Chapter = {
      ...first, // title, voice and rate stay with the first chapter
      text: `${first.text}\n\n${second.text}`,
      status: 'draft',
      progress: 0,
      buffer: undefined,
      blobUrl: undefined,
      bytes: undefined,
    };
    setChapters((l) => l.map((c) => (c.id === first.id ? merged : c)).filter((c) => c.id !== second.id));
    setSelectedIds(new Set());
    setLiveMsg(`Merged “${second.title}” into “${first.title}”`);
    toast({ title: 'Chapters merged', description: `“${second.title}” joined “${first.title}” — combined text, status reset to draft.` });
  }, [chapters, toast]);

  const mergeSelected = useCallback(() => {
    const sel = chapters.filter((c) => selectedIds.has(c.id)); // list order
    if (sel.length < 2) return;
    const first = sel[0];
    const merged: Chapter = {
      ...first, // merged chapter takes the first selected chapter's identity/voice/rate
      text: sel.map((c) => c.text).join('\n\n'),
      status: 'draft',
      progress: 0,
      buffer: undefined,
      blobUrl: undefined,
      bytes: undefined,
    };
    setChapters((l) => l.map((c) => (c.id === first.id ? merged : c)).filter((c) => c.id === first.id || !selectedIds.has(c.id)));
    setSelectedIds(new Set());
    setLiveMsg(`Merged ${sel.length} chapters into “${first.title}”`);
    toast({ title: `${sel.length} chapters merged`, description: `Joined in list order into “${first.title}” — status reset to draft.` });
  }, [chapters, selectedIds, toast]);

  const duplicateChapter = useCallback((id: string) => {
    const i = chapters.findIndex((c) => c.id === id);
    if (i === -1) return;
    const orig = chapters[i];
    const clone: Chapter = { ...orig, id: uid('ch'), title: `${orig.title} (copy)` };
    setChapters((l) => [...l.slice(0, i + 1), clone, ...l.slice(i + 1)]);
    setLiveMsg(`Duplicated “${orig.title}”`);
    toast({ title: 'Chapter duplicated', description: `“${clone.title}” inserted below the original.` });
  }, [chapters, toast]);

  // structural change — selection is id-based so nothing can go stale, but it is
  // still cleared to keep the "Merge selected" intent honest after any reshaping
  const deleteChapter = useCallback((id: string) => {
    const ch = chapters.find((c) => c.id === id);
    setChapters((l) => l.filter((c) => c.id !== id));
    setSelectedIds(new Set());
    if (expandedChapter === id) setExpandedChapter(null);
    if (ch) setLiveMsg(`Removed “${ch.title}”`);
  }, [chapters, expandedChapter]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ---------- split planner (live preview driven by planChapterSplit) ----------
  const splitChapter = useMemo(() => chapters.find((c) => c.id === splitFor) ?? null, [chapters, splitFor]);
  const splitParsed = Number.parseInt(splitEveryRaw, 10);
  const splitN = Number.isFinite(splitParsed) ? Math.min(10, Math.max(2, splitParsed)) : 4;
  const splitParts = useMemo(
    () => (splitChapter ? planChapterSplit(splitChapter.text, splitMode, splitN) : []),
    [splitChapter, splitMode, splitN],
  );

  const openSplitChapter = useCallback((id: string) => {
    setSplitFor(id);
    setSplitMode('blank');
    setSplitEveryRaw('4');
  }, []);

  const applySplit = useCallback(() => {
    const idx = chapters.findIndex((c) => c.id === splitFor);
    if (idx === -1) return;
    const orig = chapters[idx];
    const parts = planChapterSplit(orig.text, splitMode, splitN);
    if (parts.length < 2) {
      toast({ title: 'Nothing to split', description: 'No split points found with the current mode.' });
      return;
    }
    // reuse the shared chapter factory (uid/status defaults), then inherit the
    // original chapter's voice + rate and title each part “<original> · Part k”
    const created = makeChapters(parts.map((text, k) => ({
      title: parts.length > 1 ? `${orig.title} · Part ${k + 1}` : orig.title,
      text,
    }))).map((c) => ({ ...c, voiceProfile: orig.voiceProfile, rate: orig.rate }));
    setChapters((l) => [...l.slice(0, idx), ...created, ...l.slice(idx + 1)]);
    setSplitFor(null);
    setExpandedChapter(null);
    setSelectedIds(new Set());
    setLiveMsg(`Split “${orig.title}” into ${created.length} chapters`);
    toast({ title: 'Chapter split', description: `“${orig.title}” became ${created.length} consecutive chapters.` });
  }, [chapters, splitFor, splitMode, splitN, makeChapters, toast]);

  const chapterEstSec = useCallback((ch: Chapter) => {
    const prepared = applyRules(ch.text);
    const info = parseVoiceMarkup(prepared, { rate: ch.rate, pitch: 1, volume: 1 });
    return info.hasMarkup ? estimateMarkupDurationSec(prepared, ch.rate) : estimateSpeechDurationSec(prepared, ch.rate);
  }, [applyRules]);

  const stats = useMemo(() => {
    const words = chapters.reduce((a, c) => a + c.text.trim().split(/\s+/).filter(Boolean).length, 0);
    const estSec = chapters.reduce((a, c) => a + chapterEstSec(c), 0);
    const rendered = chapters.filter((c) => c.status === 'rendered');
    const renderedSec = rendered.reduce((a, c) => a + (c.buffer?.duration ?? 0), 0);
    return { words, estSec, chapters: chapters.length, rendered: rendered.length, renderedSec };
  }, [chapters, chapterEstSec]);

  const renderChapter = useCallback((ch: Chapter) => {
    setChapters((list) => list.map((c) => (c.id === ch.id ? { ...c, status: 'queued', progress: 0 } : c)));
    const fmtId = settings.outputFormat || 'wav-16';
    enqueueJob(
      { type: 'audiobook', label: `Chapter: ${ch.title}` },
      async (api) => {
        const prepared = applyRules(ch.text);
        const info = parseVoiceMarkup(prepared, { rate: ch.rate, pitch: 1, volume: 1 });
        if (info.hasMarkup) api.log(`Voice markup detected: ${info.tagsUsed.join(', ')}`);
        // markup-aware synthesis: [pause], [em], [rate], [spell], [whisper] all honored
        const buf = await synthesizeWithMarkup(prepared, {
          profileId: ch.voiceProfile, rate: ch.rate, pitch: 1, volume: 1, quality: tuned.synthesisQuality,
        }, (p) => api.setProgress(p * 0.85, `Synthesizing ${(p * 100).toFixed(0)}%`));
        if (api.shouldCancel()) return;
        await api.waitWhilePaused();
        api.setProgress(0.9, 'Normalizing…');
        const norm = normalizeBuffer(buf, -1);
        const blob = await encodeAudioBufferChunked(norm, fmtId, { channels: 1 }, (p) =>
          api.setProgress(0.9 + p * 0.1, `Encoding ${(p * 100).toFixed(0)}%`));
        const fmt = getFormat(fmtId);
        const url = URL.createObjectURL(blob);
        setChapters((list) => list.map((c) => (c.id === ch.id
          ? { ...c, status: 'rendered', progress: 1, buffer: norm, blobUrl: url, bytes: blob.size }
          : c)));
        addAsset({
          id: uid('asset'),
          name: `${meta.title} - ${ch.title}.${fmt?.extension ?? 'wav'}`.replace(/[\\/:*?"<>|]/g, '_'),
          kind: 'audio',
          createdAt: Date.now(),
          mimeType: fmt?.mime ?? 'audio/wav',
          sizeBytes: blob.size,
          durationSec: norm.duration,
          buffer: norm,
          blobUrl: url,
          meta: { book: meta.title, chapter: ch.title },
        });
        api.log(`Chapter rendered: ${norm.duration.toFixed(1)}s`);
        return { chapter: ch.title, durationSec: norm.duration, bytes: blob.size };
      },
    );
    // completion watcher
    const t = setInterval(() => {
      const job = useAppStore.getState().jobs.find((j) => j.label === `Chapter: ${ch.title}`);
      if (job && ['done', 'error', 'cancelled'].includes(job.status)) {
        clearInterval(t);
        setChapters((list) => list.map((c) => (c.id === ch.id && c.status !== 'rendered' ? { ...c, status: job.status === 'done' ? 'rendered' : 'error', progress: 1 } : c)));
        if (job.status === 'error') toast({ title: 'Chapter failed', description: job.error, variant: 'destructive' });
      } else if (job) {
        setChapters((list) => list.map((c) => (c.id === ch.id ? { ...c, progress: job.progress } : c)));
      }
    }, 500);
  }, [applyRules, tuned.synthesisQuality, settings.outputFormat, meta.title, addAsset, toast]);

  const renderAll = useCallback(() => {
    if (!chapters.length) return;
    setRendering(true);
    chapters.filter((c) => c.status !== 'rendered').forEach(renderChapter);
    const t = setInterval(() => {
      const allDone = useAppStore.getState().jobs.filter((j) => j.type === 'audiobook')
        .every((j) => ['done', 'error', 'cancelled'].includes(j.status));
      if (allDone) {
        setRendering(false);
        clearInterval(t);
        toast({ title: 'Audiobook render complete', description: 'All chapters are in the asset bin.' });
      }
    }, 1200);
  }, [chapters, renderChapter, toast]);

  const exportManifest = useCallback(() => {
    const manifest = {
      title: meta.title,
      author: meta.author,
      narrator: meta.narrator,
      genre: meta.genre,
      generator: 'Openmukti Audiobook Creator (local)',
      gapSeconds: gapSec,
      chapters: chapters.map((c, i) => ({
        index: i + 1,
        title: c.title,
        durationSec: +(c.buffer?.duration ?? estimateSpeechDurationSec(c.text, c.rate)).toFixed(2),
        words: c.text.split(/\s+/).length,
        voice: c.voiceProfile,
        rate: c.rate,
        rendered: c.status === 'rendered',
      })),
      totalDurationSec: +stats.renderedSec.toFixed(2),
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${meta.title.replace(/\s+/g, '-').toLowerCase()}-manifest.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [meta, chapters, gapSec, stats.renderedSec]);

  const exportCombined = useCallback(async () => {
    const rendered = chapters.filter((c) => c.status === 'rendered' && c.buffer);
    if (!rendered.length) {
      toast({ title: 'Nothing to combine', description: 'Render chapters first.' });
      return;
    }
    setRendering(true);
    enqueueJob(
      { type: 'audiobook', label: `Combined export: ${meta.title}` },
      async (api) => {
        const buffers: AudioBuffer[] = [];
        for (let i = 0; i < rendered.length; i++) {
          buffers.push(rendered[i].buffer!);
          if (i < rendered.length - 1 && gapSec > 0) buffers.push(makeSilenceBuffer(gapSec, rendered[0].buffer!.sampleRate, 1));
          api.setProgress((i + 1) / rendered.length * 0.5, `Collecting ${i + 1}/${rendered.length}`);
          await new Promise((r) => setTimeout(r, 0));
        }
        const joined = buffers.length === 1 ? buffers[0] : await concatenateBuffers(buffers, 0);
        api.setProgress(0.7, 'Encoding combined file…');
        const fmtId = settings.outputFormat || 'wav-16';
        const blob = await encodeAudioBufferChunked(joined, fmtId, { channels: 1 }, (p) =>
          api.setProgress(0.7 + p * 0.3, `Encoding ${(p * 100).toFixed(0)}%`));
        const fmt = getFormat(fmtId);
        const asset: AssetItem = {
          id: uid('asset'),
          name: `${meta.title} (complete).${fmt?.extension ?? 'wav'}`,
          kind: 'audio',
          createdAt: Date.now(),
          mimeType: fmt?.mime ?? 'audio/wav',
          sizeBytes: blob.size,
          durationSec: joined.duration,
          buffer: joined,
          blobUrl: URL.createObjectURL(blob),
          meta: { book: meta.title, chapters: rendered.length },
        };
        addAsset(asset);
        return { fileName: asset.name, bytes: blob.size, durationSec: joined.duration };
      },
    );
    const t = setInterval(() => {
      const job = useAppStore.getState().jobs.find((j) => j.label === `Combined export: ${meta.title}`);
      if (job && ['done', 'error', 'cancelled'].includes(job.status)) {
        setRendering(false);
        clearInterval(t);
        if (job.status === 'done') toast({ title: 'Combined audiobook exported', description: 'Find it in the asset bin.' });
      }
    }, 700);
  }, [chapters, gapSec, meta.title, settings.outputFormat, addAsset, toast]);

  // M4B-style package: combined audio + enhanced manifest (chapter start/end timestamps + embedded cover PNG)
  const exportPackage = useCallback(() => {
    const rendered = chapters.filter((c) => c.status === 'rendered' && c.buffer);
    if (!rendered.length) {
      toast({ title: 'Nothing to package', description: 'Render at least one chapter first.' });
      return;
    }
    setRendering(true);
    enqueueJob(
      { type: 'audiobook', label: `Package: ${meta.title}` },
      async (api) => {
        // 1. combined timeline with per-chapter timings (shared with "Copy chapter list")
        const { buffers, timings } = buildPackageTimeline(chapters, gapSec);
        for (let i = 0; i < timings.length; i++) {
          api.setProgress((i + 1) / timings.length * 0.45, `Timeline ${i + 1}/${timings.length}`);
          await new Promise((r) => setTimeout(r, 0));
        }
        const joined = buffers.length === 1 ? buffers[0] : await concatenateBuffers(buffers, 0);
        // 2. encode combined audio — WAV containers also get embedded chapter cue markers
        api.setProgress(0.55, 'Encoding packaged audio…');
        const fmtId = settings.outputFormat || 'wav-16';
        let blob = await encodeAudioBufferChunked(joined, fmtId, { channels: 1 }, (p) =>
          api.setProgress(0.55 + p * 0.35, `Encoding ${(p * 100).toFixed(0)}%`));
        const fmt = getFormat(fmtId);
        if (fmtId.startsWith('wav-')) {
          const cues: WavCuePoint[] = timings.map((t) => ({
            sampleOffset: Math.max(0, Math.round(t.startSec * joined.sampleRate)),
            label: `Chapter ${t.index}: ${t.title}`.slice(0, 60),
          }));
          try {
            blob = await insertWavCueChunks(blob, cues);
            api.log(`Embedded ${cues.length} chapter cue markers in WAV`);
          } catch (e) {
            api.log(`Cue embedding skipped: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          api.log('Chapter markers available in package manifest');
        }
        const asset: AssetItem = {
          id: uid('asset'),
          name: `${meta.title} (package).${fmt?.extension ?? 'wav'}`,
          kind: 'audio',
          createdAt: Date.now(),
          mimeType: fmt?.mime ?? 'audio/wav',
          sizeBytes: blob.size,
          durationSec: joined.duration,
          buffer: joined,
          blobUrl: URL.createObjectURL(blob),
          meta: { book: meta.title, packaged: true, chapters: rendered.length },
        };
        addAsset(asset);
        // 3. manifest with embedded cover + chapter timestamps
        api.setProgress(0.95, 'Writing package manifest…');
        const off = document.createElement('canvas');
        drawCoverArt(off, { title: meta.title, author: meta.author, narrator: meta.narrator, preset: coverPreset, accent: coverAccent });
        const manifest = {
          format: 'auravoice-m4b-style/1',
          title: meta.title,
          author: meta.author,
          narrator: meta.narrator,
          genre: meta.genre,
          generator: 'Openmukti Audiobook Creator (local)',
          gapSeconds: gapSec,
          cover: { mimeType: 'image/png', dataUrl: off.toDataURL('image/png') },
          audioFile: asset.name,
          audioMime: asset.mimeType,
          chapters: timings,
          totalDurationSec: +joined.duration.toFixed(3),
        };
        const mblob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
        const murl = URL.createObjectURL(mblob);
        const a = document.createElement('a');
        a.href = murl;
        a.download = `${meta.title.replace(/\s+/g, '-').toLowerCase()}-package.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(murl), 4000);
        return { fileName: asset.name, bytes: blob.size, durationSec: joined.duration, chapters: timings.length };
      },
    );
    const t = setInterval(() => {
      const job = useAppStore.getState().jobs.find((j) => j.label === `Package: ${meta.title}`);
      if (job && ['done', 'error', 'cancelled'].includes(job.status)) {
        setRendering(false);
        clearInterval(t);
        if (job.status === 'done') toast({ title: 'Package exported', description: 'Combined audio + manifest with cover & chapter timings.' });
        else toast({ title: 'Package failed', description: job.error, variant: 'destructive' });
      }
    }, 700);
  }, [chapters, gapSec, meta, settings.outputFormat, coverPreset, coverAccent, addAsset, toast]);

  // ---------- chapter list for show notes (YouTube-style 0:00 Chapter 1 …) ----------
  const chapterListText = useMemo(
    () => buildPackageTimeline(chapters, gapSec).timings.map((t) => `${youTubeStamp(t.startSec)} ${t.title}`).join('\n'),
    [chapters, gapSec],
  );

  const copyChapterList = useCallback(async () => {
    if (!chapterListText) {
      toast({ title: 'Nothing to copy', description: 'Render chapters first — timestamps come from the combined timeline.' });
      return;
    }
    try {
      await navigator.clipboard.writeText(chapterListText);
      toast({ title: 'Chapter list copied', description: 'Paste into YouTube/Spotify show notes.' });
    } catch (e) {
      toast({ title: 'Copy failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    }
  }, [chapterListText, toast]);

  const saveToVault = useCallback(async () => {
    setSaving(true);
    try {
      await saveProject({
        name: meta.title,
        type: 'audiobook',
        data: {
          meta,
          rawTextLength: rawText.length,
          splitMarker,
          gapSec,
          rules,
          chapters: chapters.map((c) => ({ title: c.title, textLength: c.text.length, voice: c.voiceProfile, rate: c.rate, status: c.status })),
        },
      });
      toast({ title: 'Audiobook saved to local vault' });
    } catch (e) {
      toast({ title: 'Vault unavailable', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }, [meta, rawText, splitMarker, gapSec, rules, chapters, toast]);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        <SectionPanel
          title="Book metadata"
          description="Included in the export manifest."
          actions={
            <div className="flex flex-wrap items-center gap-1.5">
              {draftSavedAt != null && (
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600"
                  title={new Date(draftSavedAt).toLocaleString()}
                >
                  <Bookmark className="mr-1 h-3 w-3" />draft saved
                </Badge>
              )}
              {draftSavedAt != null && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={discardDraft}>
                  <Trash2 className="mr-1 h-3 w-3" />Discard draft
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={saveToVault} disabled={saving || !chapters.length}><Save className="mr-1.5 h-3.5 w-3.5" />{saving ? 'Saving…' : 'Save to vault'}</Button>
            </div>
          }
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">Title</Label>
              <Input value={meta.title} onChange={(e) => setMeta((m) => ({ ...m, title: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Author</Label>
              <Input value={meta.author} onChange={(e) => setMeta((m) => ({ ...m, author: e.target.value }))} placeholder="Author name" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Genre</Label>
              <Input value={meta.genre} onChange={(e) => setMeta((m) => ({ ...m, genre: e.target.value }))} />
            </div>
          </div>
        </SectionPanel>

        <SectionPanel
          title="Manuscript"
          description="Paste a book or long text, then detect chapters."
          actions={
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setRawText(SAMPLE_BOOK)}><Wand2 className="mr-1.5 h-3.5 w-3.5" />Sample</Button>
              <Button size="sm" onClick={detectChapters} disabled={!rawText.trim()}><Sparkles className="mr-1.5 h-3.5 w-3.5" />Detect chapters</Button>
              {chapters.length === 0 && (
                <Button size="sm" variant="outline" onClick={() => setPasteOpen(true)} title="Skip the manuscript — paste “Title | text” rows or “## Title” headings directly">
                  <ClipboardPaste className="mr-1.5 h-3.5 w-3.5" />Paste chapters
                </Button>
              )}
            </div>
          }
        >
          <Textarea value={rawText} onChange={(e) => setRawText(e.target.value)}
            placeholder="Paste the full book text here. Chapters are detected from 'Chapter N' headings, or use a custom split marker."
            className="min-h-36 resize-y text-sm" aria-label="Manuscript text" />
          <div className="mt-2 flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Custom split marker (optional):</Label>
            <Input value={splitMarker} onChange={(e) => setSplitMarker(e.target.value)} placeholder="e.g. ***" className="h-8 w-28" />
          </div>
        </SectionPanel>

        {chapters.length > 0 && (
          <SectionPanel
            title={`Chapters (${chapters.length})`}
            description={`${formatNumber(stats.words)} words · estimated ${formatDuration(stats.estSec)} · ${stats.rendered} rendered${stats.renderedSec ? ` (${formatDuration(stats.renderedSec)} audio)` : ''}`}
            actions={
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[10px] tabular-nums" title="Chapter count and total manuscript words">
                  {stats.chapters} chapters · {formatNumber(stats.words)} words
                </Badge>
                <Button
                  size="sm"
                  variant={selectMode ? 'secondary' : 'outline'}
                  className={cn(selectMode && 'text-violet-600')}
                  aria-pressed={selectMode}
                  onClick={() => { if (selectMode) setSelectedIds(new Set()); setSelectMode(!selectMode); }}
                  title="Toggle row checkboxes for bulk merge"
                >
                  <ListChecks className="mr-1.5 h-3.5 w-3.5" />{selectMode ? 'Exit select' : 'Select'}
                </Button>
                {selectMode && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={mergeSelected}
                          disabled={selectedIds.size < 2}
                          title="Join the selected chapters, in list order, into one chapter at the first selected position"
                        >
                          <Merge className="mr-1.5 h-3.5 w-3.5" />Merge selected ({selectedIds.size})
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      {selectedIds.size < 2
                        ? 'Select at least two chapters to merge'
                        : `Merges ${selectedIds.size} chapters in list order — texts join with blank lines, title/voice come from the first`}
                    </TooltipContent>
                  </Tooltip>
                )}
                <Button size="sm" variant="outline" onClick={() => setPasteOpen(true)} title="Paste “Title | text” rows or “## Title” headings as chapters">
                  <ClipboardPaste className="mr-1.5 h-3.5 w-3.5" />Paste chapters
                </Button>
                <Button size="sm" variant="outline" onClick={exportManifest} disabled={!chapters.length}>
                  <FileJson className="mr-1.5 h-3.5 w-3.5" />Manifest
                </Button>
                <Button size="sm" variant="outline" onClick={exportPackage} disabled={rendering || !stats.rendered}
                  title="Combined audio + manifest with embedded cover and chapter timestamps">
                  <Package className="mr-1.5 h-3.5 w-3.5" />Package
                </Button>
                <Button size="sm" variant="outline" onClick={() => void exportCombined()} disabled={rendering || !stats.rendered}>
                  <Merge className="mr-1.5 h-3.5 w-3.5" />Combined
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void copyChapterList()}
                        disabled={!stats.rendered}
                        title="Copy YouTube-style chapter timestamps (0:00 Chapter 1 …) from the combined package timeline"
                      >
                        <Copy className="mr-1.5 h-3.5 w-3.5" />Copy chapter list
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {stats.rendered
                      ? 'Copies “0:00 Chapter 1 …” lines for YouTube/Spotify show notes'
                      : 'Render chapters first — timestamps come from the combined timeline'}
                  </TooltipContent>
                </Tooltip>
                <Button size="sm" onClick={renderAll} disabled={rendering}>
                  <Play className="mr-1.5 h-3.5 w-3.5" />{rendering ? 'Rendering…' : 'Render all'}
                </Button>
              </div>
            }
          >
            <p aria-live="polite" role="status" className="sr-only">{liveMsg}</p>
            <ScrollArea className="max-h-[560px] pr-3">
              <div className="space-y-2">
                {chapters.map((ch, i) => (
                  <div
                    key={ch.id}
                    draggable
                    onDragStart={(e) => {
                      const t = e.target as HTMLElement | null;
                      if (t && t.closest('input, textarea, select, button, img')) { e.preventDefault(); return; }
                      setDragId(ch.id);
                      setDragOverId(null);
                      setDragOverEdge('top');
                      e.dataTransfer.effectAllowed = 'move';
                      try { e.dataTransfer.setData('text/plain', ch.id); } catch { /* IE */ }
                    }}
                    onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (!dragId || dragId === ch.id) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      setDragOverId(ch.id);
                      setDragOverEdge(e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom');
                    }}
                    onDragLeave={() => { setDragOverId((cur) => (cur === ch.id ? null : cur)); setDragOverEdge('top'); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragId && dragId !== ch.id) reorderChapters(dragId, ch.id, dragOverEdge);
                      setDragId(null);
                      setDragOverId(null);
                    }}
                    tabIndex={0}
                    aria-label={`Chapter ${i + 1}: ${ch.title}, position ${i + 1} of ${chapters.length}`}
                    onKeyDown={(e) => {
                      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                      const t = e.target as HTMLElement | null;
                      if (t && t.closest('input, textarea, select')) return;
                      e.preventDefault();
                      moveChapter(ch.id, e.key === 'ArrowUp' ? -1 : 1);
                    }}
                    className={cn(
                      'relative rounded-lg border p-3 transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
                      'border-l-4',
                      ch.status === 'rendered' && 'border-l-emerald-500/70',
                      ch.status === 'error' && 'border-l-rose-500/70',
                      ch.status === 'queued' && 'border-l-amber-500/70',
                      ch.status === 'draft' && 'border-l-zinc-300 dark:border-l-zinc-700',
                      dragId === ch.id && 'opacity-50',
                      'hover:shadow-sm',
                    )}
                  >
                    {dragOverId === ch.id && dragId !== null && dragId !== ch.id && (
                      <span
                        aria-hidden
                        className={cn('pointer-events-none absolute inset-x-1 z-10 rounded-full bg-emerald-500', dragOverEdge === 'bottom' ? '-bottom-px h-0.5' : '-top-px h-0.5')}
                      />
                    )}
                    <div className="flex items-center gap-2">
                      {selectMode && (
                        <Checkbox
                          checked={selectedIds.has(ch.id)}
                          onCheckedChange={() => toggleSelect(ch.id)}
                          aria-label={`Select chapter ${ch.title}`}
                          className="shrink-0"
                        />
                      )}
                      <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground/40 transition-colors hover:text-muted-foreground active:cursor-grabbing" aria-hidden />
                      <img
                        src={thumbs.get(ch.id)}
                        alt={`Chapter ${i + 1} thumbnail`}
                        width={30}
                        height={45}
                        draggable={false}
                        className="h-[45px] w-[30px] shrink-0 rounded-sm border object-cover shadow-sm"
                        loading="lazy"
                      />
                      <div className="min-w-0 flex-1">
                        <Input
                          value={ch.title}
                          onChange={(e) => setChapters((l) => l.map((c) => (c.id === ch.id ? { ...c, title: e.target.value } : c)))}
                          className="h-8 border-0 bg-transparent px-1 font-medium focus-visible:ring-1"
                          aria-label={`Chapter ${i + 1} title`}
                        />
                        <div className="flex items-center gap-2 px-1 text-[10px] text-muted-foreground">
                          <span className="tabular-nums">{formatNumber(ch.text.split(/\s+/).filter(Boolean).length)} words</span>
                          <span>≈ {formatDuration(chapterEstSec(ch))}</span>
                          {ch.buffer && <span className="tabular-nums">{formatDuration(ch.buffer.duration)} audio</span>}
                        </div>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          'shrink-0',
                          ch.status === 'rendered' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
                          ch.status === 'error' && 'border-rose-500/30 bg-rose-500/10 text-rose-600',
                          ch.status === 'queued' && 'border-amber-500/30 bg-amber-500/10 text-amber-600',
                        )}
                      >
                        {ch.status}
                      </Badge>
                      {parseVoiceMarkup(applyRules(ch.text), { rate: ch.rate, pitch: 1, volume: 1 }).hasMarkup && (
                        <Badge variant="outline" className="shrink-0 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600" title="Voice markup tags will be honored during synthesis">
                          markup
                        </Badge>
                      )}
                      {!voiceProfiles.some((v) => v.id === ch.voiceProfile) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className="inline-flex h-2 w-2 shrink-0 rounded-full bg-amber-500"
                              role="img"
                              aria-label="Voice missing — using default"
                            />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            Voice missing — renders use the default built-in voice until you pick another.
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <Select value={ch.voiceProfile} onValueChange={(v) => setChapters((l) => l.map((c) => (c.id === ch.id ? { ...c, voiceProfile: v } : c)))}>
                        <SelectTrigger className="h-8 w-36 shrink-0" aria-label="Voice"><SelectValue /></SelectTrigger>
                        <SelectContent className="max-h-60">
                          {voiceProfiles.map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              {v.name}
                              {isCustomProfile(v) && (
                                <span className="ml-auto rounded border border-violet-500/40 px-1 text-[9px] font-medium uppercase tracking-wide text-violet-600">custom</span>
                              )}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                              aria-label="Merge with next chapter"
                              onClick={() => mergeWithNext(ch.id)}
                              disabled={i === chapters.length - 1}
                            >
                              <Merge className="h-3.5 w-3.5" />
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          {i === chapters.length - 1 ? 'Last chapter — nothing to merge into' : 'Merge with next chapter'}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                            aria-label="Split chapter"
                            onClick={() => openSplitChapter(ch.id)}
                          >
                            <Scissors className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Split chapter</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                            aria-label="Duplicate chapter"
                            onClick={() => duplicateChapter(ch.id)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Duplicate chapter</TooltipContent>
                      </Tooltip>
                      <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Edit chapter text"
                        onClick={() => setExpandedChapter((e) => (e === ch.id ? null : ch.id))}
                        title="Edit chapter text">
                        {expandedChapter === ch.id ? <ChevronUp className="h-3.5 w-3.5" /> : <PencilLine className="h-3.5 w-3.5" />}
                      </Button>
                      {ch.buffer && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className={cn('h-8 w-8 shrink-0', listen?.chapterId === ch.id && 'text-emerald-600')}
                          aria-label={listen?.chapterId === ch.id && listen.playing ? 'Stop listening' : 'Listen to chapter'}
                          title={listen?.chapterId === ch.id && listen.playing ? 'Stop listening' : 'Listen (supports sleep timer & bookmarks)'}
                          onClick={() => { if (listen?.chapterId === ch.id && listen.playing) stopListen(true); else playChapter(ch); }}
                        >
                          {listen?.chapterId === ch.id && listen.playing ? <Square className="h-3.5 w-3.5" /> : <Headphones className="h-3.5 w-3.5" />}
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Render chapter"
                        onClick={() => renderChapter(ch)} disabled={ch.status === 'queued'}
                        title="Render chapter to audio">
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Remove chapter"
                        onClick={() => deleteChapter(ch.id)} title="Remove chapter">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {expandedChapter === ch.id && (
                      <div className="mt-2 pl-8">
                        <Textarea
                          value={ch.text}
                          onChange={(e) => setChapters((l) => l.map((c) => (c.id === ch.id ? { ...c, text: e.target.value } : c)))}
                          className="min-h-32 resize-y text-sm"
                          aria-label={`Chapter ${i + 1} text`}
                          placeholder="Chapter text — voice markup like [pause 500] or [em]…[/em] is honored."
                        />
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-3 pl-8 text-xs text-muted-foreground">
                      <div className="flex items-center gap-0.5">
                        <Button size="icon" variant="ghost" className="h-6 w-6" aria-label="Move chapter up" disabled={i === 0} onClick={() => moveChapter(ch.id, -1)} title="Move up">
                          <ChevronUp className="h-3 w-3" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-6 w-6" aria-label="Move chapter down" disabled={i === chapters.length - 1} onClick={() => moveChapter(ch.id, 1)} title="Move down">
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                      </div>
                      <span className="text-[10px]">drag to reorder · focus the card and press Alt+↑ / Alt+↓</span>
                      {ch.blobUrl && (
                        <a href={ch.blobUrl} download={`${meta.title}-${i + 1}.${getFormat(settings.outputFormat)?.extension ?? 'wav'}`}
                          className="inline-flex items-center gap-1 text-violet-600 hover:underline">
                          <Download className="h-3 w-3" />download ({formatNumber(ch.bytes ?? 0)} B)
                        </a>
                      )}
                      {savedMark && savedMark.chapterId === ch.id && !(listen?.chapterId === ch.id && listen.playing) && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded px-1 text-[10px] text-amber-600 hover:underline"
                          onClick={() => ch.buffer && playChapter(ch, Math.min(savedMark.pos, Math.max(0, ch.buffer.duration - 0.05)))}
                          title="Resume from bookmark"
                        >
                          <Bookmark className="h-3 w-3" />resume at {formatDuration(savedMark.pos)}
                        </button>
                      )}
                      <div className="ml-auto flex w-40 items-center gap-2">
                        <Label className="text-[10px]">rate</Label>
                        <Slider value={[ch.rate]} min={0.5} max={2} step={0.05} className="flex-1"
                          onValueChange={([v]) => setChapters((l) => l.map((c) => (c.id === ch.id ? { ...c, rate: v } : c)))} />
                        <span className="w-8 text-right tabular-nums">{ch.rate.toFixed(2)}</span>
                      </div>
                    </div>
                    {(ch.status === 'queued' || (ch.status === 'rendered' && ch.progress < 1)) && (
                      <Progress value={ch.progress * 100} className="mt-2 h-1" />
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
            {listen && (
              <div className="mt-3 rounded-lg border bg-card p-3 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Headphones className={cn('h-4 w-4 shrink-0', listen.playing ? 'animate-pulse text-emerald-600' : 'text-muted-foreground')} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{listenChapter?.title ?? 'Chapter'}</div>
                    <div className="text-[10px] text-muted-foreground tabular-nums">
                      {formatDuration(listen.pos)} / {formatDuration(listen.dur)}
                    </div>
                  </div>
                  <Button size="icon" variant="outline" className="h-8 w-8" onClick={pauseListen} aria-label={listen.playing ? 'Pause' : 'Resume'}>
                    {listen.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Stop" title="Stop & save bookmark"
                    onClick={() => stopListen(true)}>
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                  <div className="flex items-center gap-1.5">
                    <Timer className={cn('h-3.5 w-3.5', sleepMin != null ? 'text-violet-600' : 'text-muted-foreground')} />
                    <Select
                      value={sleepMin == null ? 'off' : String(sleepMin)}
                      onValueChange={(v) => setSleepTimer(v === 'off' ? null : Number(v))}
                    >
                      <SelectTrigger className="h-8 w-[150px] text-[11px]" aria-label="Sleep timer"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Sleep timer off</SelectItem>
                        <SelectItem value="5">5 min (fade out)</SelectItem>
                        <SelectItem value="10">10 min (fade out)</SelectItem>
                        <SelectItem value="15">15 min (fade out)</SelectItem>
                        <SelectItem value="30">30 min (fade out)</SelectItem>
                        <SelectItem value="45">45 min (fade out)</SelectItem>
                        <SelectItem value="60">60 min (fade out)</SelectItem>
                        <SelectItem value="0">End of chapter (fade)</SelectItem>
                      </SelectContent>
                    </Select>
                    {sleepRemaining != null && sleepMin != null && sleepMin > 0 && (
                      <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 text-[10px] tabular-nums text-violet-600">
                        {Math.floor(sleepRemaining / 60)}:{String(Math.floor(sleepRemaining % 60)).padStart(2, '0')}
                      </Badge>
                    )}
                  </div>
                </div>
                <Progress value={(listen.pos / Math.max(0.01, listen.dur)) * 100} className="mt-2 h-1" />
              </div>
            )}
          </SectionPanel>
        )}
      </div>

      <div className="space-y-4">
        <SectionPanel
          title="Cover studio"
          description="Canvas-drawn cover art from the book metadata."
          actions={<Badge variant="outline" className="text-[10px]"><Palette className="mr-1 h-3 w-3" />{coverPreset}</Badge>}
        >
          <CoverStudio
            meta={meta}
            preset={coverPreset}
            accent={coverAccent}
            setPreset={setCoverPreset}
            setAccent={setCoverAccent}
            onSave={(dataUrl) => { coverDataUrlRef.current = dataUrl; }}
          />
        </SectionPanel>

        <SectionPanel title="Export format" description="Shared by chapter renders, combined exports and the package job.">
          <div className="space-y-2.5">
            <Select value={settings.outputFormat || 'wav-16'} onValueChange={(v) => setSetting('outputFormat', v)}>
              <SelectTrigger size="sm" className="text-xs" aria-label="Export format"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {AUDIO_FORMATS.map((f) => {
                  const dot = formatDotState(f.id);
                  return (
                    <SelectItem key={f.id} value={f.id} aria-label={`${f.label} — ${FORMAT_STATE_ARIA[dot]}`}>
                      {f.label} <span className="text-muted-foreground">· {f.container}{f.lossless ? '' : ' · lossy'}</span>
                      {dot !== 'none' && (
                        <span
                          role="img"
                          aria-label={FORMAT_STATE_ARIA[dot]}
                          className={cn('codec-dot ml-auto inline-flex h-1.5 w-1.5 shrink-0 rounded-full', dot === 'native' ? 'bg-emerald-500' : 'bg-violet-500')}
                        />
                      )}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="cursor-default text-[11px] text-muted-foreground tabular-nums">
                  {availableCount === null
                    ? 'Checking codec support on this device…'
                    : `${availableCount} of ${AUDIO_FORMATS.length} formats available on this device`}
                </p>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start" className="w-64">
                <span className="flex items-center gap-2">
                  <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                  Encoded by this app — always available.
                </span>
                <span className="mt-1 flex items-center gap-2">
                  <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" aria-hidden />
                  Compressed codec via your browser&apos;s hardware encoder (records in real time).
                </span>
                <span className="mt-1 flex items-center gap-2">
                  <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground/60" aria-hidden />
                  No dot — your browser lacks the codec; renders with that format will fail.
                </span>
              </TooltipContent>
            </Tooltip>
            {formatUnavailable && (
              <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                <TriangleAlert />
                <AlertTitle className="text-xs">{getFormat(settings.outputFormat || 'wav-16')?.label ?? 'Selected format'} is unavailable on this device</AlertTitle>
                <AlertDescription className="text-[11px] text-amber-700/90 dark:text-amber-400/90">
                  This format needs MediaRecorder support that your browser lacks — chapter renders, combined
                  exports and the package job will fail and log the error. Switch to a WAV format (always
                  available) or Ogg Opus.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </SectionPanel>

        <SectionPanel title="Narration defaults" description="Applied when new chapters are created.">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Default voice</Label>
              <Select value={useFallbackVoice} onValueChange={setUseFallbackVoice}>
                <SelectTrigger aria-label="Default voice"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-60">
                  {voiceProfiles.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name} <span className="text-muted-foreground">· {v.gender}</span>
                      {isCustomProfile(v) && (
                        <span className="ml-auto rounded border border-violet-500/40 px-1 text-[9px] font-medium uppercase tracking-wide text-violet-600">custom</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!voiceProfiles.some((v) => v.id === useFallbackVoice) && (
                <p className="text-[11px] text-amber-600" role="status">Voice missing — new chapters fall back to the default built-in voice until you pick another.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Default rate</Label>
                <span className="text-xs tabular-nums text-muted-foreground">{globalRate.toFixed(2)}×</span>
              </div>
              <Slider value={[globalRate]} min={0.5} max={2} step={0.05} onValueChange={([v]) => setGlobalRate(v)} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Chapter gap</Label>
                <span className="text-xs tabular-nums text-muted-foreground">{gapSec.toFixed(1)} s</span>
              </div>
              <Slider value={[gapSec]} min={0} max={3} step={0.1} onValueChange={([v]) => setGapSec(v)} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-2.5">
              <div>
                <Label className="text-xs">Narrator consistency check</Label>
                <p className="text-[11px] text-muted-foreground">Warn on mismatched chapter voices</p>
              </div>
              <Switch defaultChecked />
            </div>
          </div>
        </SectionPanel>

        <SectionPanel title="Pronunciation dictionary" description="Find → replace rules applied before synthesis.">
          <div className="space-y-2">
            <ScrollArea className="max-h-48">
              <div className="space-y-2">
                {rules.map((rule) => (
                  <div key={rule.id} className="flex items-center gap-1.5 rounded-lg border p-2">
                    <Switch checked={rule.enabled} onCheckedChange={(v) => setRules((l) => l.map((r) => (r.id === rule.id ? { ...r, enabled: v } : r)))} />
                    <Input value={rule.find} onChange={(e) => setRules((l) => l.map((r) => (r.id === rule.id ? { ...r, find: e.target.value } : r)))}
                      className="h-8 flex-1" placeholder="find" aria-label="Find" />
                    <span className="text-xs text-muted-foreground">→</span>
                    <Input value={rule.replace} onChange={(e) => setRules((l) => l.map((r) => (r.id === rule.id ? { ...r, replace: e.target.value } : r)))}
                      className="h-8 flex-1" placeholder="replace" aria-label="Replace" />
                    <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Delete rule"
                      onClick={() => setRules((l) => l.filter((r) => r.id !== rule.id))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => setRules((l) => [...l, { id: uid('rule'), find: '', replace: '', enabled: true }])}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />Add rule
              </Button>
              <Button size="sm" variant="ghost" onClick={() => {
                const blob = new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'pronunciation-dictionary.json';
                a.click();
                URL.revokeObjectURL(a.href);
              }}>
                <Download className="mr-1.5 h-3.5 w-3.5" />Export
              </Button>
            </div>
          </div>
        </SectionPanel>

        <SectionPanel title="Production stats" description="Live statistics for this book.">
          <Tabs defaultValue="chapters">
            <TabsList className="w-full">
              <TabsTrigger value="chapters" className="flex-1"><BookOpen className="mr-1 h-3.5 w-3.5" />Book</TabsTrigger>
              <TabsTrigger value="audio" className="flex-1"><ListMusic className="mr-1 h-3.5 w-3.5" />Audio</TabsTrigger>
            </TabsList>
            <TabsContent value="chapters" className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Chapters</span><span className="font-medium tabular-nums">{stats.chapters}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Total words</span><span className="font-medium tabular-nums">{formatNumber(stats.words)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Estimated runtime</span><span className="font-medium tabular-nums">{formatDuration(stats.estSec)}</span></div>
              <Separator />
              <div className="flex justify-between"><span className="text-muted-foreground">Narrator</span><span className="font-medium">{meta.narrator}</span></div>
            </TabsContent>
            <TabsContent value="audio" className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Rendered chapters</span><span className="font-medium tabular-nums">{stats.rendered}/{stats.chapters}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Rendered audio</span><span className="font-medium tabular-nums">{formatDuration(stats.renderedSec)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Export format</span><span className="font-medium">{getFormat(settings.outputFormat)?.label ?? 'WAV 16-bit'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Quality tier</span><span className="font-medium capitalize">{tuned.synthesisQuality}</span></div>
            </TabsContent>
          </Tabs>
          <div className="mt-3 flex items-center gap-1.5 rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">
            <Scissors className="h-3.5 w-3.5 shrink-0" />
            Chapters render as separate background jobs — pause, resume or cancel any of them in Activity & Queue.
          </div>
        </SectionPanel>
      </div>

      {/* paste chapters — compact parser dialog ("Title | text" rows or "## Title" headings) */}
      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent className="chapters-paste sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Paste chapters</DialogTitle>
            <DialogDescription className="text-xs">
              One chapter per line as <span className="font-mono">Title | text</span>, or a{' '}
              <span className="font-mono">## Title</span> heading followed by paragraph lines. Up to 200 chapters.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            className="max-h-64 min-h-40 resize-y overflow-y-auto font-mono text-xs"
            placeholder={'Chapter 1 | The Machine That Listened\n\n## Chapter 2\nVoices in the wires…'}
            aria-label="Chapters to import"
          />
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => { setPasteOpen(false); setPasteText(''); }}>Cancel</Button>
            <Button size="sm" variant="outline" onClick={() => importPastedChapters(false)} disabled={!pasteText.trim()}>Append</Button>
            <Button size="sm" onClick={() => importPastedChapters(true)} disabled={!pasteText.trim()}>Replace chapters</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* split chapter — compact planner dialog with live part preview */}
      <Dialog open={splitFor !== null} onOpenChange={(o) => { if (!o) setSplitFor(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base">Split chapter</DialogTitle>
            <DialogDescription className="text-xs">
              Divide “{splitChapter?.title ?? ''}” into consecutive chapters. Parts inherit the chapter's voice and rate and land as drafts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="text-xs text-muted-foreground">Mode</Label>
              <Select value={splitMode} onValueChange={(v) => setSplitMode(v as SplitMode)}>
                <SelectTrigger className="h-8 w-[240px] text-xs" aria-label="Split mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="blank">At blank line (paragraph)</SelectItem>
                  <SelectItem value="sentences">At sentence every N sentences</SelectItem>
                  <SelectItem value="marker">At cursor marker</SelectItem>
                </SelectContent>
              </Select>
              {splitMode === 'sentences' && (
                <Input
                  type="number"
                  min={2}
                  max={10}
                  value={splitEveryRaw}
                  onChange={(e) => setSplitEveryRaw(e.target.value)}
                  className="h-8 w-20"
                  aria-label="Sentences per part"
                />
              )}
            </div>
            {splitMode === 'marker' && (
              <p className="text-[11px] text-muted-foreground">Splits on lines containing only <span className="font-mono">---</span>.</p>
            )}
            <Textarea
              readOnly
              value={splitChapter?.text ?? ''}
              className="max-h-40 min-h-16 resize-none font-mono text-xs"
              aria-label="Chapter text preview"
            />
            <div className="max-h-40 overflow-y-auto rounded-md border p-2" aria-label="Split preview">
              {splitChapter && !splitChapter.text.trim() && (
                <p className="text-[11px] text-muted-foreground">Nothing to split — the chapter text is empty.</p>
              )}
              {splitChapter && splitChapter.text.trim() && splitParts.length <= 1 && (
                <p className="text-[11px] text-amber-600" role="status">No split points found — the chapter would stay in one part.</p>
              )}
              {splitParts.length >= 2 && (
                <ol className="space-y-1">
                  {splitParts.map((p, k) => (
                    <li key={k} className="flex items-baseline gap-2 text-xs">
                      <span className="shrink-0 font-medium">Part {k + 1}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">({formatNumber(p.split(/\s+/).filter(Boolean).length)} words)</span>
                      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{p}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setSplitFor(null)}>Cancel</Button>
            <Button
              size="sm"
              className="bg-emerald-600 text-white hover:bg-emerald-600/90"
              disabled={splitParts.length < 2}
              onClick={applySplit}
            >
              <Scissors className="mr-1.5 h-3.5 w-3.5" />
              Split into {splitParts.length} part{splitParts.length === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
