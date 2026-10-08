'use client';

/**
 * AutoBook — the one-click "any file → audiobook / videobook" pipeline.
 *
 * Drop a book (txt, md, epub, pdf, docx, rtf, html, subtitle files, even a
 * scanned dump routed through File-Studio ingest + OCR) and one job runs the
 * whole local pipeline:
 *
 *   Ingest → Understand (fiction? who speaks? what must NOT be read?) →
 *   Cast (age/gender-aware voices) → Script (reviewable, editable) →
 *   Produce (stitched audiobook + optionally a videobook whose captions are
 *   the book text itself — synced, with NO timestamps or speaker labels).
 *
 * The intelligence is the zero-download engine in lib/engines/autobook.ts —
 * a deterministic, explainable NLP core ("lightweight AI") that runs entirely
 * in this tab. Every classic studio (TTS, Dialogue, Audiobook, Video) stays
 * available for hands-on work; AutoBook simply orchestrates them.
 */

import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { useAppStore } from '@/lib/stores/app-store';
import { enqueueJob } from '@/lib/queue';
import { allVoiceProfiles } from '@/lib/engines/formant';
import { synthesizeWithMarkup } from '@/lib/engines/markup';
import { ingestFile } from '@/lib/engines/ingest';
import {
  toDialogueFormat, withEmotionMarkup,
  type AutobookResult, type BookCastMember, type ScriptUnit,
} from '@/lib/engines/autobook';
import { buildAudiobookScriptWithAI, createAudiobookZip, type ZipExportPayload } from '@/lib/engines/autobook-ai';
import { getLocalAIStatus, getLocalAiModelOptions, type LocalAiStatus } from '@/lib/engines/local-ai';
import { concatenateBuffers, makeSilenceBuffer, normalizeBuffer, sliceBuffer } from '@/lib/engines/dsp';
import { encodeAudioBufferChunked, getFormat } from '@/lib/engines/encode';
import { buildSrt, detectExportFormats, exportVideo } from '@/lib/engines/video-render';
import type { AssetItem, SubtitleCue, TranscriptChapter, VideoProject } from '@/lib/types';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { formatDuration, formatNumber } from '@/lib/utils/format';
import { uid } from '@/lib/utils/async';
import {
  BookAudio, BookOpen, Check, Clapperboard, Download, FileText, FileUp, GraduationCap, Lightbulb, ListFilter,
  Loader2, ClipboardPaste, Pencil, RefreshCcw, ScrollText, ShieldCheck, Sparkles, Users, Volume2, WandSparkles, X,
} from 'lucide-react';

// ---------- speaker palette (matches Dialogue Studio — no blues) ----------
const SPEAKER_COLORS = [
  { dot: '#8b5cf6', soft: 'rgba(139, 92, 246, 0.10)' },   // violet
  { dot: '#10b981', soft: 'rgba(16, 185, 129, 0.10)' },   // emerald
  { dot: '#f59e0b', soft: 'rgba(245, 158, 11, 0.12)' },   // amber
  { dot: '#f43f5e', soft: 'rgba(244, 63, 94, 0.10)' },    // rose
  { dot: '#14b8a6', soft: 'rgba(20, 184, 166, 0.10)' },   // teal
  { dot: '#f97316', soft: 'rgba(249, 115, 22, 0.10)' },   // orange
  { dot: '#d946ef', soft: 'rgba(217, 70, 239, 0.10)' },   // fuchsia
  { dot: '#84cc16', soft: 'rgba(132, 204, 22, 0.12)' },   // lime
] as const;

function speakerColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return SPEAKER_COLORS[Math.abs(h) % SPEAKER_COLORS.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

interface RenderTiming { unitId: string; speaker: string; text: string; startSec: number; endSec: number; chapterIndex: number; }

/** Convert each synthesized unit into small source-text cues. Timing is derived
 * from the actual rendered audio duration, so video captions follow the generated
 * soundtrack rather than a guessed WPM clock. The visible cue text contains only
 * book words — timestamps and speaker labels remain metadata/export-only. */
function buildWordSyncedCues(timings: RenderTiming[], scopeSec: number): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const t of timings) {
    if (t.startSec >= scopeSec) break;
    const end = Math.min(t.endSec, scopeSec);
    const words = t.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length || end <= t.startSec) continue;
    const weights = words.map((w) => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length));
    const total = weights.reduce((a, b) => a + b, 0);
    let cursor = t.startSec;
    for (let i = 0; i < words.length; i++) {
      const next = i === words.length - 1 ? end : cursor + (end - t.startSec) * (weights[i] / total);
      cues.push({ startSec: cursor, endSec: Math.max(cursor + 0.03, next), text: words[i] });
      cursor = next;
    }
  }
  return cues;
}

// ---------- pipeline stage strip ----------
type StageState = 'idle' | 'active' | 'done';
const STAGES = [
  { id: 'ingest', label: 'Ingest', hint: 'Any file → clean text' },
  { id: 'understand', label: 'Understand', hint: 'Local AI · genre · speakers' },
  { id: 'cast', label: 'Cast', hint: 'Age & gender → voices' },
  { id: 'script', label: 'Script', hint: 'Reviewable, editable' },
  { id: 'produce', label: 'Produce', hint: 'Audiobook / videobook' },
] as const;

function StageStrip({ states, message }: { states: StageState[]; message: string }) {
  return (
    <div className="ab-stage-strip" role="status" aria-label={`Pipeline progress: ${message}`}>
      <div className="flex items-stretch gap-1.5">
        {STAGES.map((s, i) => {
          const st = states[i];
          return (
            <div key={s.id} className="flex min-w-0 flex-1 flex-col gap-1.5" data-ab-stage={st}>
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition-all',
                    st === 'done' && 'border-emerald-500/40 bg-emerald-500/15 text-emerald-600',
                    st === 'active' && 'ab-stage-active border-violet-500/50 bg-violet-500/15 text-violet-600',
                    st === 'idle' && 'border-border bg-muted/50 text-muted-foreground',
                  )}
                >
                  {st === 'done' ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </div>
                <div className="min-w-0">
                  <div className={cn('truncate text-xs font-semibold leading-tight', st === 'idle' && 'text-muted-foreground')}>
                    {s.label}
                  </div>
                  <div className="hidden truncate text-[10px] leading-tight text-muted-foreground sm:block">{s.hint}</div>
                </div>
                {i < STAGES.length - 1 && <div className="ab-stage-link mx-0.5 h-px flex-1 bg-border" aria-hidden />}
              </div>
            </div>
          );
        })}
      </div>
      {message && <p className="mt-2 truncate text-[11px] text-muted-foreground" aria-live="polite">{message}</p>}
    </div>
  );
}

// ---------- genre verdict card ----------
const SKIP_LABELS: Record<string, string> = {
  'page-number': 'Page number', 'running-head': 'Running head', 'toc': 'Contents line',
  'copyright': 'Copyright page', 'frontmatter': 'Front matter', 'index': 'Index entry',
  'reference': 'Reference', 'footnote': 'Footnote', 'blank': 'Blank', 'marker': 'Chapter heading',
};

function ConfidenceRing({ value, kind }: { value: number; kind: 'fiction' | 'non-fiction' }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = Math.round(value * 100);
  return (
    <div className="relative h-16 w-16 shrink-0" role="img" aria-label={`${kind} verdict, ${pct}% confidence`}>
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-muted" />
        <circle
          cx="32" cy="32" r={r} fill="none" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - value)}
          className={kind === 'fiction' ? 'stroke-violet-500' : 'stroke-emerald-500'}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-xs font-bold tabular-nums">{pct}%</div>
    </div>
  );
}

// ---------- original sample books (public-domain-safe, written for AuraVoice) ----------
const SAMPLE_FICTION = `The Lighthouse at Wren Point

Chapter One

The storm had been building since noon, and by evening the wind was throwing spray clear over the lamp room. Eleanor Marsh climbed the spiral stairs with a lantern in one hand and her father's logbook in the other.

"The glass is falling fast," she said, setting the lantern on the desk. "We'll need to trim the wicks before midnight."

Old Tomas looked up from the boiler, his white hair plastered to his forehead. "Aye, girl. And after midnight, we'll need more than trimmed wicks."

"How old is the lens, Tomas?" asked Pip, who was ten years old and had never seen a storm this size.

"Older than the three of us put together," Tomas said with a smile.

Eleanor turned to the window. Somewhere beyond the rain, a bell buoy clanged once, then fell silent.

"Pip," she whispered, "run down and fetch the oil can. Hurry now."

The boy hesitated at the door. "Will the light hold, Ellie?"

"The light always holds," Tomas said. "That's what it's for."

Chapter Two

Morning came grey and quiet. Wreckage dotted the shingle below the tower, and among it the gulls argued over something pale. Eleanor found the ship's boat split end to end, and beside it, a sea chest with brass fittings and no name.

"Whose is it?" Pip asked.

"No one's now," Eleanor said softly. "Help me carry it inside."

Tomas ran his thumb along the hasp and frowned. "Locked. And the lock's newer than the chest."

"Then someone wanted what's inside to stay ours," Eleanor said. "Bring it up to the lamp room."
`;

const SAMPLE_NONFICTION = `A Practical Guide to Coastal Navigation

Table of Contents
1. Reading Charts ........ 12
2. Tides and Currents ........ 34
3. Weather Signs ........ 58

Chapter 1: Reading Charts

A nautical chart is a working document, not a picture. You should always check the date of the latest survey before trusting a depth sounding, and you must make sure the chart datum matches the datum set in your receiver. A mismatch of one meter is enough to turn a safe passage into a grounding.

Depths are shown in meters on most modern charts, with shallow water highlighted. Note that older charts may use fathoms instead.

The scale of the chart matters as much as its age. A small-scale chart shows a whole sea but little detail; a large-scale chart shows an anchorage in full. Experienced navigators move between scales as the passage demands.

Page 12

Chapter 2: Tides and Currents

Tide tables predict the vertical movement of water, but the current that accompanies it can run across your intended track. Plan each leg so that the stream carries you toward, not against, your next waypoint.

Copyright 2019 by the Coastal Press. All rights reserved.

References
[1] International Hydrographic Organization, Standards for Chart Symbols, 2020.
[2] Coastal Survey Office, Annual Report, 2019.
`;

// ---------- unit row ----------
interface UnitRowProps {
  unit: ScriptUnit;
  index: number;
  onEdit: (u: ScriptUnit) => void;
}

function UnitRow({ unit, index, onEdit }: UnitRowProps) {
  if (unit.kind === 'skip' && unit.skipReason !== 'marker') {
    return (
      <div className="ab-skip-row flex items-baseline gap-2 px-3 py-1" data-ab-unit={unit.id}>
        <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/50">{index + 1}</span>
        <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] text-muted-foreground">{SKIP_LABELS[unit.skipReason ?? ''] ?? 'Skipped'}</Badge>
        <span className="ab-skip-text truncate text-xs text-muted-foreground/60">{unit.text}</span>
        <span className="sr-only"> — will not be read aloud</span>
        <button type="button" onClick={() => onEdit(unit)} className="ml-auto shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground" aria-label={`Edit skipped line ${index + 1}`}>
          <Pencil className="h-3 w-3" />
        </button>
      </div>
    );
  }
  if (unit.kind === 'skip') {
    return (
      <div className="ab-marker-row flex items-center gap-2 px-3 py-1.5" data-ab-unit={unit.id}>
        <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/50">{index + 1}</span>
        <ScrollText className="h-3 w-3 shrink-0 text-violet-500/70" />
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-violet-600/90">{unit.text}</span>
        <span className="sr-only"> — chapter heading, not read</span>
      </div>
    );
  }
  if (unit.kind === 'dialogue') {
    const color = speakerColor(unit.speaker);
    return (
      <div className="ab-dialogue-row flex items-start gap-2 px-3 py-1.5" data-ab-unit={unit.id} style={{ background: color.soft }}>
        <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/50">{index + 1}</span>
        <span
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
          style={{ background: color.dot }}
          aria-hidden
        >
          {initialsOf(unit.speaker)}
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onEdit(unit)}
            className="mr-1.5 rounded px-0.5 text-[11px] font-bold underline-offset-2 hover:underline"
            style={{ color: color.dot }}
            title="Correct speaker"
          >
            {unit.speaker}
          </button>
          {unit.emotionHint && <Badge variant="outline" className="mr-1.5 h-4 px-1 text-[9px]">{unit.emotionHint}</Badge>}
          <span className="ab-dialogue-text text-xs leading-relaxed">{unit.text}</span>
        </div>
        <button type="button" onClick={() => onEdit(unit)} className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground" aria-label={`Edit line ${index + 1}`}>
          <Pencil className="h-3 w-3" />
        </button>
      </div>
    );
  }
  return (
    <div className="ab-narration-row flex items-start gap-2 px-3 py-1.5" data-ab-unit={unit.id}>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/50">{index + 1}</span>
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border bg-muted/60 text-[9px] font-bold text-muted-foreground" aria-hidden>N</span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onEdit(unit)}
          className="mr-1.5 rounded px-0.5 text-[11px] font-semibold text-muted-foreground underline-offset-2 hover:underline"
          title="Correct speaker or turn this into dialogue"
        >
          Narrator
        </button>
        <span className="ab-narration-text text-xs leading-relaxed text-foreground/85">{unit.text}</span>
      </div>
      <button type="button" onClick={() => onEdit(unit)} className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground" aria-label={`Edit line ${index + 1}`}>
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}

// ---------- main view ----------
export function AutoBookView() {
  const addAsset = useAppStore((s) => s.addAsset);
  const assets = useAppStore((s) => s.assets);
  const settings = useAppStore((s) => s.settings);
  const tuned = useAppStore((s) => s.tuned);
  const customProfiles = useAppStore((s) => s.customProfiles);
  const setView = useAppStore((s) => s.setView);
  const setPendingTranscriptChapters = useAppStore((s) => s.setPendingTranscriptChapters);
  const setPendingVideoProject = useAppStore((s) => s.setPendingVideoProject);
  const logActivity = useAppStore((s) => s.logActivity);
  const { toast } = useToast();
  const reduceMotion = useReducedMotion();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<{ name: string; sizeBytes: number; via: 'file' | 'paste' | 'sample' } | null>(null);
  const [fileRef, setFileRef] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState<string | null>(null);
  const [dragHot, setDragHot] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteDraft, setPasteDraft] = useState('');

  const [stageStates, setStageStates] = useState<StageState[]>(['idle', 'idle', 'idle', 'idle', 'idle']);
  const [stageMsg, setStageMsg] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AutobookResult | null>(null);
  const [localAiStatus, setLocalAiStatus] = useState<LocalAiStatus | null>(null);
  const renderTimingsRef = useRef<RenderTiming[]>([]);

  const [maxCast, setMaxCast] = useState(8);
  const [genreMode, setGenreMode] = useState<'auto' | 'force-fiction' | 'force-nonfiction'>('auto');

  // cast overrides keyed by speaker name
  const [castOverrides, setCastOverrides] = useState<Record<string, { profileId: string; rate: number; pitch: number }>>({});
  // Per-unit manual corrections keyed by unit id: text, speaker, delivery hint,
  // and skipped state. Speaker changes also let a corrected narration line be
  // promoted to dialogue when a character name is chosen.
  const [unitEdits, setUnitEdits] = useState<Record<string, {
    text?: string;
    skipped?: boolean;
    speaker?: string;
    emotionHint?: ScriptUnit['emotionHint'] | null;
  }>>({});
  const [editingUnit, setEditingUnit] = useState<ScriptUnit | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editSkip, setEditSkip] = useState(false);
  const [editSpeaker, setEditSpeaker] = useState('Narrator');
  const [editCustomSpeaker, setEditCustomSpeaker] = useState('');
  const [editEmotion, setEditEmotion] = useState<'__keep' | '__none' | 'whisper' | 'urgent' | 'curious' | 'soft'>('__keep');
  const [filter, setFilter] = useState<'all' | 'dialogue' | 'narration' | 'skipped'>('all');

  // videobook options
  const [videoFull, setVideoFull] = useState(false);
  const [videoTheme, setVideoTheme] = useState<'aurora' | 'parchment' | 'ink'>('aurora');
  const [videoHiRes, setVideoHiRes] = useState(false);

  // production outputs
  const [audioOut, setAudioOut] = useState<AssetItem | null>(null);
  const [videoOut, setVideoOut] = useState<AssetItem | null>(null);
  const [producing, setProducing] = useState<'audio' | 'video' | null>(null);
  const [producingProgress, setProducingProgress] = useState(0);

  // explicit model download/remove operation (progress + phase)
  const [modelOp, setModelOp] = useState<{ phase: 'download' | 'clear'; p: number } | null>(null);

  const profiles = useMemo(() => allVoiceProfiles(), [customProfiles]);
  const localAiModels = useMemo(() => getLocalAiModelOptions(), []);

  useEffect(() => {
    let cancelled = false;
    getLocalAIStatus(settings.localAiModelId).then((status) => { if (!cancelled) setLocalAiStatus(status); });
    return () => { cancelled = true; };
  }, [settings.localAiModelId]);

  const refreshAiStatus = useCallback(() => {
    getLocalAIStatus(settings.localAiModelId).then(setLocalAiStatus);
  }, [settings.localAiModelId]);

  const downloadModel = useCallback(async () => {
    if (modelOp) return;
    setModelOp({ phase: 'download', p: 0 });
    try {
      const { warmLocalAiModel } = await import('@/lib/engines/local-ai');
      const status = await warmLocalAiModel(settings.localAiModelId, (p) => setModelOp({ phase: 'download', p }));
      toast({ title: 'AI model ready', description: `${status.modelName} is downloaded — analysis will use it.` });
    } catch (e: any) {
      console.error('[autobook] downloadModel failed', e);
      toast({
        title: 'Model download failed',
        description: `${e?.name ?? 'Error'}: ${e?.message ?? 'unknown'} — see DevTools console for the [local-ai] log`,
        variant: 'destructive',
      });
    } finally {
      setModelOp(null);
      refreshAiStatus();
    }
  }, [modelOp, settings.localAiModelId, refreshAiStatus, toast]);

  const clearModel = useCallback(async () => {
    if (modelOp) return;
    setModelOp({ phase: 'clear', p: 0 });
    try {
      const { clearLocalAiCache } = await import('@/lib/engines/local-ai');
      await clearLocalAiCache(settings.localAiModelId);
      toast({ title: 'Cached model cleared', description: 'The next analysis will download it again.' });
    } finally {
      setModelOp(null);
      refreshAiStatus();
    }
  }, [modelOp, settings.localAiModelId, refreshAiStatus, toast]);

  // ---------- derived ----------
  const effectiveUnits = useMemo(() => {
    if (!result) return [];
    return result.units.map((u) => {
      const e = unitEdits[u.id];
      if (!e) return u;
      if (e.skipped === true) return { ...u, kind: 'skip' as const, skipReason: 'footnote' as const, speaker: '(skipped)' };

      let next: ScriptUnit = u;
      if (e.speaker !== undefined) {
        const speaker = e.speaker.trim();
        if (!speaker || speaker.toLowerCase() === 'narrator') {
          next = { ...next, kind: 'narration', speaker: 'Narrator' };
        } else {
          // Any non-Narrator speaker makes the line dialogue, so a corrected
          // attribution immediately affects production, exports and handoffs.
          next = { ...next, kind: 'dialogue', speaker };
        }
      }
      if (e.skipped === false && next.kind === 'skip') {
        next = { ...next, kind: 'narration', speaker: 'Narrator' };
      }
      if (e.text != null) next = { ...next, text: e.text };
      if (e.emotionHint !== undefined) next = { ...next, emotionHint: e.emotionHint ?? undefined };
      return next;
    });
  }, [result, unitEdits]);

  const speakerOptions = useMemo(() => {
    const names = new Set<string>(['Narrator']);
    for (const c of result?.cast ?? []) if (c.name?.trim()) names.add(c.name.trim());
    for (const u of effectiveUnits) {
      if (u.kind !== 'skip' && u.speaker?.trim() && u.speaker !== '(skipped)') names.add(u.speaker.trim());
    }
    return [...names].sort((a, b) => (a === 'Narrator' ? -1 : b === 'Narrator' ? 1 : a.localeCompare(b)));
  }, [result, effectiveUnits]);

  const visibleUnits = useMemo(() => {
    if (filter === 'all') return effectiveUnits;
    if (filter === 'skipped') return effectiveUnits.filter((u) => u.kind === 'skip');
    return effectiveUnits.filter((u) => u.kind === filter);
  }, [effectiveUnits, filter]);

  const speakableUnits = useMemo(() => effectiveUnits.filter((u) => u.kind !== 'skip' && u.text.trim()), [effectiveUnits]);
  const correctedDialogueUnits = useMemo(() => speakableUnits.filter((u) => u.kind === 'dialogue').length, [speakableUnits]);
  const correctedSpeakerCount = useMemo(
    () => new Set(speakableUnits.map((u) => u.speaker).filter((s) => s && s !== 'Narrator')).size,
    [speakableUnits],
  );
  const estWords = useMemo(() => speakableUnits.reduce((a, u) => a + (u.text.match(/\S+/g)?.length ?? 0), 0), [speakableUnits]);
  const estMinutes = estWords / 155;

  const castFor = useCallback((speaker: string): { profileId: string; rate: number; pitch: number } => {
    const override = castOverrides[speaker];
    if (override) return override;
    const member = result?.cast.find((c) => c.name === speaker);
    if (member) return { profileId: member.profileId, rate: member.rate, pitch: member.pitch };
    const narrator = result?.cast[0];
    return { profileId: narrator?.profileId ?? 'aura-neutral', rate: narrator?.rate ?? 1, pitch: narrator?.pitch ?? 1 };
  }, [castOverrides, result]);

  const chapterTitleFor = useCallback((chapterIndex: number) => {
    const ch = result?.chapters[chapterIndex];
    return ch?.title ?? `Chapter ${chapterIndex + 1}`;
  }, [result]);

  // ---------- pipeline ----------
  const resetAnalysis = useCallback(() => {
    setResult(null);
    setStageStates(['idle', 'idle', 'idle', 'idle', 'idle']);
    setStageMsg('');
    setCastOverrides({});
    setUnitEdits({});
    setAudioOut(null);
    setVideoOut(null);
    setProducing(null);
    setProducingProgress(0);
  }, []);

  const loadSample = useCallback((which: 'fiction' | 'nonfiction') => {
    resetAnalysis();
    setFileRef(null);
    setPastedText(which === 'fiction' ? SAMPLE_FICTION : SAMPLE_NONFICTION);
    setSource({ name: which === 'fiction' ? 'the-lighthouse-at-wren-point.txt' : 'coastal-navigation-guide.txt', sizeBytes: (which === 'fiction' ? SAMPLE_FICTION : SAMPLE_NONFICTION).length, via: 'sample' });
    toast({ title: which === 'fiction' ? 'Fiction sample loaded' : 'Non-fiction sample loaded', description: 'Press Analyze to run the local intelligence.' });
  }, [resetAnalysis, toast]);

  const acceptFiles = useCallback((files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    resetAnalysis();
    setFileRef(f);
    setPastedText(null);
    setSource({ name: f.name, sizeBytes: f.size, via: 'file' });
  }, [resetAnalysis]);

  const applyPaste = useCallback(() => {
    if (!pasteDraft.trim()) return;
    resetAnalysis();
    setFileRef(null);
    setPastedText(pasteDraft);
    setSource({ name: 'pasted-text.txt', sizeBytes: pasteDraft.length, via: 'paste' });
    setPasteOpen(false);
    setPasteDraft('');
  }, [pasteDraft, resetAnalysis]);

  /**
   * THE one-click run. mode 'analyze' stops after the script; 'audiobook'
   * continues to a stitched audio render; 'videobook' adds a rendered video
   * whose captions are the synced book text (no timestamps, no speaker tags).
   */
  const run = useCallback((mode: 'analyze' | 'audiobook' | 'videobook') => {
    if (running) return;
    if (!source) {
      toast({ title: 'Choose a book first', description: 'Drop a file, paste text, or load a sample.' });
      return;
    }
    setRunning(true);
    resetAnalysis();
    setProducing(mode === 'analyze' ? null : mode === 'audiobook' ? 'audio' : 'video');
    setProducingProgress(0);
    const file = fileRef;
    const pasted = pastedText;
    const fmtId = settings.outputFormat || 'wav-16';
    const quality = tuned.synthesisQuality;
    const profilesSnapshot = profiles;
    const maxCastSnapshot = maxCast;
    const genreSnapshot = genreMode;
    const overridesSnapshot = { ...castOverrides };
    const theme = videoTheme;
    const hiRes = videoHiRes;
    const fullVideo = videoFull;
    const titleFallback = source.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');

    enqueueJob(
      { type: 'autobook', label: `AutoBook: ${source.name}` },
      async (api) => {
        // ---------- stage 1: ingest ----------
        setStageStates(['active', 'idle', 'idle', 'idle', 'idle']);
        setStageMsg(mode === 'analyze' ? 'Reading the book…' : 'Reading the book — one click, no uploads…');
        let text = '';
        let sourceNote = source.via === 'paste' ? 'pasted text' : 'sample text';
        let fileContext: { fileName?: string; ext?: string; category?: string; textKind?: string } = {
          fileName: source.name,
          category: source.via,
          textKind: source.via,
        };
        if (file) {
          const ing = await ingestFile(file, {
            ocr: {
              power: tuned.ocrPower,
              language: 'eng',
              preprocess: true,
              minConfidence: 0.35,
              onProgress: (p, msg) => api.setProgress(0.02 + p * 0.12, msg ?? 'Reading image text…'),
            },
            pdfOcr: {
              power: tuned.ocrPower,
              language: 'eng',
              preprocess: true,
              minConfidence: 0.35,
              onProgress: (p, msg) => api.setProgress(0.08 + p * 0.11, msg ?? 'OCRing scanned PDF…'),
            },
            onProgress: (p, msg) => api.setProgress(0.02 + p * 0.12, msg ?? 'Reading file…'),
          });
          text = ing.text;
          sourceNote = `${ing.textKind} text via ${ing.category} handler`;
          fileContext = {
            fileName: file.name,
            ext: ing.ext,
            category: ing.category,
            textKind: ing.textKind,
          };
          if (ing.ocrSuggested && ing.text.trim().length < 40) {
            api.log('No useful text layer found — AutoBook attempted local OCR; if unavailable, the deterministic fallback remains usable.');
          }
          if (ing.textKind === 'ocr') api.log('Local OCR text is feeding the same AI director pipeline — no manual OCR handoff required.');
          ing.warnings.slice(0, 3).forEach((w) => api.log(w));
        } else {
          text = pasted ?? '';
          api.setProgress(0.12, 'Text ready');
        }
        if (!text.trim()) throw new Error('No readable text found in this file — try OCR Lab for scans.');
        if (api.shouldCancel()) return;

        // ---------- stage 2: understand ----------
        setStageStates(['done', 'active', 'idle', 'idle', 'idle']);
        setStageMsg('Classifying fiction vs non-fiction, mapping structure, finding who speaks…');
        api.setProgress(0.16, 'Understanding the book…');
        await api.waitWhilePaused();
        await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 350)); // let the stage strip paint
        const analysis = await buildAudiobookScriptWithAI(text, profilesSnapshot, {
          maxCast: maxCastSnapshot,
          genre: genreSnapshot,
          modelId: useAppStore.getState().settings.localAiModelId,
          fileContext,
          onProgress: (p, msg) => api.setProgress(0.16 + p * 0.04, msg ?? 'Local AI director…'),
        });
        api.log(`Verdict: ${analysis.verdict.kind} (${Math.round(analysis.verdict.confidence * 100)}% confidence) · ${analysis.stats.dialogueUnits} dialogue lines · ${analysis.stats.skippedWords} words skipped`);
        api.log(analysis.ai?.enabled ? `Local AI: ${analysis.ai.modelName} · ${analysis.ai.reviewedDialogue} dialogue lines AI-reviewed.` : `Local AI fallback: ${analysis.ai?.notes?.[0] ?? 'deterministic AutoBook used'}`);
        if (analysis.stats.skippedWords > 0) {
          const reasons = new Set(analysis.units.filter((u) => u.kind === 'skip' && u.skipReason !== 'marker').map((u) => u.skipReason));
          api.log(`Never read aloud: ${[...reasons].map((r) => SKIP_LABELS[r ?? ''] ?? r).join(', ')}`);
        }

        // ---------- stage 3+4: cast & script ----------
        setStageStates(['done', 'done', 'active', 'active', 'idle']);
        setStageMsg(`Casting ${analysis.cast.length} voices · ${analysis.stats.speakers} speaking characters`);
        api.setProgress(0.2, `Cast ready — ${analysis.cast.length} voices`);
        await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 350));
        setResult(analysis);
        setStageStates(['done', 'done', 'done', 'done', 'idle']);
        setStageMsg(mode === 'analyze' ? 'Script ready — review, then produce.' : 'Script ready — producing…');
        if (mode === 'analyze') {
          api.setProgress(1, `Script ready: ${analysis.stats.words} words, ${analysis.stats.estMinutes.toFixed(1)} min`);
          setProducing(null);
          return { words: analysis.stats.words, verdict: analysis.verdict.kind };
        }
        if (api.shouldCancel()) return;

        // ---------- production: synthesize every speakable unit ----------
        const edited = analysis.units.map((u) => {
          const e = unitEdits[u.id];
          if (!e) return u;
          if (e.skipped === true) return { ...u, kind: 'skip' as const, speaker: '(skipped)' };
          if (e.skipped === false && u.kind === 'skip') return { ...u, kind: 'narration' as const, speaker: 'Narrator' };
          return e.text != null ? { ...u, text: e.text } : u;
        });
        const speakable = edited.filter((u) => u.kind !== 'skip' && u.text.trim());
        if (!speakable.length) throw new Error('Every line is marked skip — nothing to narrate.');

        const pieces: AudioBuffer[] = [];
        const timings: { unitId: string; speaker: string; text: string; startSec: number; endSec: number; chapterIndex: number }[] = [];
        let cursor = 0;
        const GAP = 0.26;
        const CHAPTER_GAP = 0.7;
        for (let i = 0; i < speakable.length; i++) {
          const u = speakable[i];
          const cast = overridesSnapshot[u.speaker] ?? {
            profileId: analysis.cast.find((c) => c.name === u.speaker)?.profileId ?? analysis.cast[0]?.profileId ?? 'aura-neutral',
            rate: analysis.cast.find((c) => c.name === u.speaker)?.rate ?? 1,
            pitch: analysis.cast.find((c) => c.name === u.speaker)?.pitch ?? 1,
          };
          const spoken = withEmotionMarkup(u.text, u.emotionHint);
          const buf = await synthesizeWithMarkup(spoken, { profileId: cast.profileId, rate: cast.rate, pitch: cast.pitch, volume: 1, quality });
          timings.push({ unitId: u.id, speaker: u.speaker, text: u.text, startSec: cursor, endSec: cursor + buf.duration, chapterIndex: u.chapterIndex });
          pieces.push(buf);
          const next = speakable[i + 1];
          const gapSec = next && next.chapterIndex !== u.chapterIndex ? CHAPTER_GAP : GAP;
          cursor += buf.duration + (next ? gapSec : 0);
          if (next && gapSec > 0) pieces.push(makeSilenceBuffer(gapSec, buf.sampleRate, 1));
          api.setProgress(0.22 + (i + 1) / speakable.length * 0.55, `Narrating line ${i + 1}/${speakable.length} — ${u.speaker}`);
          await api.waitWhilePaused();
          if (api.shouldCancel()) return;
        }
        renderTimingsRef.current = timings;
        api.log(`Synthesized ${speakable.length} lines in ${analysis.cast.length} voices`);

        // ---------- stitch + encode ----------
        api.setProgress(0.8, 'Stitching the audiobook…');
        const joined = pieces.length === 1 ? pieces[0] : await concatenateBuffers(pieces, 0);
        const norm = normalizeBuffer(joined, -1);
        api.setProgress(0.84, `Encoding ${getFormat(fmtId)?.label ?? fmtId}…`);
        const blob = await encodeAudioBufferChunked(norm, fmtId, { channels: 1 }, (p) => api.setProgress(0.84 + p * 0.05, `Encoding ${(p * 100).toFixed(0)}%`));
        const fmt = getFormat(fmtId);
        const baseName = (analysis.meta.titleGuess || titleFallback).replace(/\s+/g, '-').toLowerCase().slice(0, 48);
        const audioAsset: AssetItem = {
          id: uid('asset'),
          name: `${baseName}-audiobook.${fmt?.extension ?? 'wav'}`,
          kind: 'audio',
          createdAt: Date.now(),
          mimeType: fmt?.mime ?? 'audio/wav',
          sizeBytes: blob.size,
          durationSec: norm.duration,
          buffer: norm,
          blobUrl: URL.createObjectURL(blob),
          meta: { source: 'autobook', title: analysis.meta.titleGuess, lines: speakable.length },
        };
        addAsset(audioAsset);
        logActivity('export', `AutoBook audiobook · ${analysis.meta.titleGuess}`);
        setAudioOut(audioAsset);
        api.setProgress(0.9, `Audiobook ready — ${formatDuration(norm.duration)}`);
        api.log(`Audiobook encoded: ${audioAsset.name} (${formatDuration(norm.duration)})`);
        if (mode === 'audiobook' || api.shouldCancel()) {
          setStageStates(['done', 'done', 'done', 'done', 'done']);
          setStageMsg(`Done — audiobook in the Asset Bin.`);
          setProducing(null);
          return { fileName: audioAsset.name, durationSec: norm.duration };
        }

        // ---------- videobook: clean synced captions, zero artifacts ----------
        const scopeSec = fullVideo ? norm.duration : Math.min(60, norm.duration);
        const scopeBuffer = sliceBuffer(norm, 0, scopeSec);
        const theme2 = theme === 'aurora' ? { bg: '#2e1065', bg2: '#7c3aed', text: '#f5f3ff' }
          : theme === 'parchment' ? { bg: '#78350f', bg2: '#d97706', text: '#fffbeb' }
          : { bg: '#09090b', bg2: '#3f3f46', text: '#fafafa' };
        const cues: SubtitleCue[] = buildWordSyncedCues(timings, scopeSec);
        // chapter backdrop clips sized to the actual chapter spans
        const chapterSpans = new Map<number, { start: number; end: number }>();
        for (const t of timings) {
          if (t.startSec >= scopeSec) break;
          const s = chapterSpans.get(t.chapterIndex);
          chapterSpans.set(t.chapterIndex, { start: s ? s.start : t.startSec, end: Math.min(t.endSec, scopeSec) });
        }
        const spans = [...chapterSpans.entries()].sort((a, b) => a[0] - b[0]);
        const clips: VideoProject['clips'] = spans.map(([ci, span], idx) => ({
          id: `ab-clip-${ci}`,
          type: 'gradient',
          color: idx % 2 === 0 ? theme2.bg : theme2.bg2,
          color2: idx % 2 === 0 ? theme2.bg2 : theme2.bg,
          durationSec: Math.max(0.5, span.end - span.start),
          transition: 'fade',
          kenBurns: 'zoom-in',
          filter: theme === 'parchment' ? 'warm' : 'none',
        }));
        const project: VideoProject = {
          id: uid('vp'),
          name: `${analysis.meta.titleGuess || titleFallback} (videobook)`,
          width: hiRes ? 1920 : 1280,
          height: hiRes ? 1080 : 720,
          fps: 30,
          clips,
          subtitles: cues,
          subtitleStyle: {
            fontSize: 4.2,
            color: '#ffffff',
            position: 'bottom',
            background: false,
            outline: true,
            showSpeaker: false, // clean captions — no speaker labels, no timestamps, ever
          },
          soundtrackAssetId: audioAsset.id,
        };
        setPendingVideoProject(project);
        const formats = detectExportFormats();
        const vfmt = formats.find((f) => f.id === 'webm-vp9' && f.supported)?.id
          ?? formats.find((f) => f.id === 'webm-vp8' && f.supported)?.id
          ?? formats.find((f) => f.supported)?.id;
        if (!vfmt) throw new Error('This browser cannot record video — the audiobook is still in the Asset Bin.');
        setStageStates(['done', 'done', 'done', 'done', 'active']);
        setStageMsg(`Recording videobook (${scopeSec < norm.duration ? 'first 60 s preview' : 'full length'})…`);
        api.log(`Videobook: ${project.width}×${project.height}, ${clips.length} chapter backdrops, ${cues.length} clean captions, ${vfmt}`);
        const videoBlob = await exportVideo(project, [...useAppStore.getState().assets, { ...audioAsset, buffer: scopeBuffer } as AssetItem], {
          format: vfmt,
          quality: 'medium',
          aborted: () => api.shouldCancel(),
          onLog: (m) => api.log(m),
          onProgress: (p) => api.setProgress(0.9 + p * 0.1, `Recording video ${(p * 100).toFixed(0)}% — real-time capture`),
        });
        const videoAsset: AssetItem = {
          id: uid('asset'),
          name: `${baseName}-videobook.${vfmt.startsWith('mp4') ? 'mp4' : 'webm'}`,
          kind: 'video',
          createdAt: Date.now(),
          mimeType: vfmt.startsWith('mp4') ? 'video/mp4' : 'video/webm',
          sizeBytes: videoBlob.size,
          durationSec: scopeSec,
          blobUrl: URL.createObjectURL(videoBlob),
          width: project.width,
          height: project.height,
          meta: { source: 'autobook', cleanCaptions: true, wordSyncedCaptions: true, aiModel: analysis.ai?.modelName ?? 'fallback', title: analysis.meta.titleGuess },
        };
        addAsset(videoAsset);
        logActivity('export', `AutoBook videobook · ${analysis.meta.titleGuess}`);
        setVideoOut(videoAsset);
        setStageStates(['done', 'done', 'done', 'done', 'done']);
        setStageMsg('Done — audiobook + videobook are in the Asset Bin.');
        setProducing(null);
        return { audio: audioAsset.name, video: videoAsset.name, durationSec: scopeSec };
      },
    );

    // job lifecycle → local UI state (same polling pattern as Dialogue Studio)
    const label = `AutoBook: ${source.name}`;
    const timer = setInterval(() => {
      const job = useAppStore.getState().jobs.find((j) => j.label === label);
      if (!job) return;
      setProducingProgress(job.progress);
      if (['done', 'error', 'cancelled'].includes(job.status)) {
        clearInterval(timer);
        setRunning(false);
        setProducing(null);
        if (job.status === 'done') {
          const last = useAppStore.getState().assets[0];
          toast({ title: 'AutoBook finished', description: last ? `${last.name} is in the Asset Bin.` : 'Outputs are in the Asset Bin.' });
        } else if (job.status === 'error') {
          toast({ title: 'AutoBook failed', description: job.error, variant: 'destructive' });
        }
      }
    }, 500);
  }, [running, source, fileRef, pastedText, settings.outputFormat, tuned.synthesisQuality, profiles, maxCast, genreMode, castOverrides, unitEdits, videoTheme, videoHiRes, videoFull, reduceMotion, addAsset, logActivity, setPendingVideoProject, toast]);

  // ---------- handoffs ----------
  const chaptersForAudiobookStudio = useCallback((): TranscriptChapter[] => {
    if (!result) return [];
    const byChapter = new Map<number, string[]>();
    for (const u of speakableUnits) {
      const arr = byChapter.get(u.chapterIndex) ?? [];
      arr.push(u.text);
      byChapter.set(u.chapterIndex, arr);
    }
    return [...byChapter.entries()].map(([ci, texts]) => ({ title: chapterTitleFor(ci), text: texts.join('\n\n') }));
  }, [result, speakableUnits, chapterTitleFor]);

  const sendToAudiobookStudio = useCallback(() => {
    const chapters = chaptersForAudiobookStudio();
    if (!chapters.length) return;
    setPendingTranscriptChapters(chapters);
    setView('audiobook');
    toast({ title: 'Chapters sent', description: `${chapters.length} chapters waiting in Audiobook Studio.` });
  }, [chaptersForAudiobookStudio, setPendingTranscriptChapters, setView, toast]);

  const copyDialogueScript = useCallback(async () => {
    if (!result) return;
    const fmt = toDialogueFormat(effectiveUnits);
    await navigator.clipboard.writeText(fmt);
    toast({ title: 'Script copied', description: 'Paste it into Dialogue Studio ("Paste script") for line-by-line control.' });
  }, [result, effectiveUnits, toast]);

  const downloadScript = useCallback(() => {
    if (!result) return;
    const text = effectiveUnits.map((u) => (u.kind === 'skip' ? `[${SKIP_LABELS[u.skipReason ?? ''] ?? 'skipped'}] ${u.text}` : `${u.speaker}: ${u.text}`)).join('\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(result.meta.titleGuess || 'autobook-script').replace(/\s+/g, '-').toLowerCase()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [result, effectiveUnits]);

  const downloadSrt = useCallback(() => {
    if (!audioOut) return;
    const cues = buildWordSyncedCues(renderTimingsRef.current, audioOut.durationSec ?? Number.POSITIVE_INFINITY);
    const blob = new Blob([buildSrt(cues)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(result?.meta.titleGuess || 'autobook').replace(/\s+/g, '-').toLowerCase()}.srt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [audioOut, speakableUnits, result]);

  const downloadZip = useCallback(async () => {
    if (!result) return;
    const scriptText = effectiveUnits.map((u) => (u.kind === 'skip' ? `[${SKIP_LABELS[u.skipReason ?? ''] ?? 'skipped'}] ${u.text}` : `${u.speaker}: ${u.text}`)).join('\n\n');
    const cues = buildWordSyncedCues(renderTimingsRef.current, audioOut?.durationSec ?? Number.POSITIVE_INFINITY);
    const subtitleSrt = buildSrt(cues);
    const baseName = (result.meta.titleGuess || 'autobook').replace(/\s+/g, '-').toLowerCase().slice(0, 48);

    const payload: ZipExportPayload = {
      scriptText,
      subtitleSrt,
      audioBlob: audioOut?.blobUrl ? await fetch(audioOut.blobUrl).then((r) => r.blob()) : undefined,
      videoBlob: videoOut?.blobUrl ? await fetch(videoOut.blobUrl).then((r) => r.blob()) : undefined,
      metadata: {
        title: result.meta.titleGuess || baseName,
        author: result.meta.authorGuess,
        genre: result.verdict.kind,
        confidence: result.verdict.confidence,
        words: result.stats.words,
        estMinutes: result.stats.estMinutes,
        speakers: correctedSpeakerCount,
        aiModel: result.ai?.modelName,
        aiNotes: result.ai?.notes,
        cast: result.cast.filter((c) => c.name !== 'Narrator').map((c) => ({
          name: c.name,
          gender: c.meta.gender ?? 'unknown',
          ageBand: c.meta.ageBand ?? 'unknown',
          voice: c.profileId,
          rationale: c.rationale,
        })),
      },
    };

    const zipBlob = await createAudiobookZip(payload, (p) => setProducingProgress(p));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipBlob);
    a.download = `${baseName}-autobook.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast({ title: 'ZIP exported', description: 'Script, subtitles, metadata, audio and video packaged.' });
  }, [result, effectiveUnits, audioOut, videoOut, toast]);

  const recast = useCallback(() => {
    if (!result) return;
    setCastOverrides({});
    toast({ title: 'Cast reset', description: 'Back to the engine’s original casting.' });
  }, [result, toast]);

  // ---------- edit dialog ----------
  const openEdit = useCallback((u: ScriptUnit) => {
    const edit = unitEdits[u.id];
    const currentSpeaker = edit?.speaker ?? (u.kind === 'skip' ? 'Narrator' : u.speaker);
    const speaker = currentSpeaker && currentSpeaker !== '(skipped)' ? currentSpeaker.trim() : 'Narrator';

    setEditingUnit(u);
    setEditDraft(edit?.text ?? u.text);
    setEditSkip(u.kind === 'skip');
    setEditSpeaker(speakerOptions.includes(speaker) ? speaker : '__custom');
    setEditCustomSpeaker(speaker);
    setEditEmotion(edit?.emotionHint === undefined ? '__keep' : edit.emotionHint ?? '__none');
  }, [unitEdits, speakerOptions]);

  const applyEdit = useCallback(() => {
    if (!editingUnit) return;

    const chosenName = editSpeaker === '__custom'
      ? editCustomSpeaker.trim()
      : editSpeaker.trim();
    const finalSpeaker = !chosenName || chosenName.toLowerCase() === 'narrator'
      ? 'Narrator'
      : chosenName;
    const emotionPatch = editEmotion === '__keep'
      ? undefined
      : editEmotion === '__none'
        ? null
        : editEmotion;

    setUnitEdits((m) => ({
      ...m,
      [editingUnit.id]: {
        text: editDraft,
        skipped: editSkip,
        speaker: finalSpeaker,
        ...(emotionPatch === undefined ? {} : { emotionHint: emotionPatch }),
      },
    }));

    // A manually introduced speaker needs a cast entry, otherwise production
    // would silently fall back to the narrator's voice for that line.
    if (!editSkip && finalSpeaker !== 'Narrator' && result && !result.cast.some((c) => c.name.toLowerCase() === finalSpeaker.toLowerCase())) {
      let hash = 0;
      for (let i = 0; i < finalSpeaker.length; i++) hash = (hash * 31 + finalSpeaker.charCodeAt(i)) | 0;
      const profile = profiles.length
        ? profiles[Math.abs(hash) % profiles.length]
        : undefined;
      const member: BookCastMember = {
        name: finalSpeaker,
        meta: {
          name: finalSpeaker,
          gender: 'neutral',
          ageBand: 'adult',
          role: 'minor',
          evidence: ['Manually added during script review'],
        },
        profileId: profile?.id ?? 'aura-neutral',
        rate: 1,
        pitch: 1,
        rationale: 'Manually added during script review',
      };
      setResult((prev) => prev
        ? { ...prev, cast: [...prev.cast.filter((c) => c.name.toLowerCase() !== finalSpeaker.toLowerCase()), member] }
        : prev);
      toast({ title: 'Speaker added to cast', description: `${finalSpeaker} was added with ${member.profileId}.` });
    }

    setEditingUnit(null);
  }, [editingUnit, editDraft, editSkip, editSpeaker, editCustomSpeaker, editEmotion, profiles, result, toast]);

  // ---------- render ----------
  const hasSource = !!source;
  const skippedWords = result?.stats.skippedWords ?? 0;
  const verdict = result?.verdict;
  const stagesPreview = stageStates;

  return (
    <div className="flex flex-col gap-4">
      {/* ============ HERO — the one-click dropzone ============ */}
      <SectionPanel
        title="AutoBook — one-click book studio"
        description="Drop any file. AutoBook performs local OCR when needed, then uses a real on-device language model to classify the book, resolve speakers, cast voices, suppress non-spoken furniture, and run the audiobook/videobook pipeline."
        actions={<Badge variant="outline" className="gap-1 border-violet-500/40 bg-violet-500/10 text-violet-600"><WandSparkles className="h-3 w-3" />AI pipeline</Badge>}
      >
        <div
          className={cn(
            'ab-dropzone relative overflow-hidden rounded-xl border-2 border-dashed p-6 text-center transition-all md:p-8',
            dragHot ? 'ab-dropzone-hot border-violet-500/70 bg-violet-500/5' : 'border-border hover:border-violet-500/40 hover:bg-accent/30',
          )}
          data-hot={dragHot || undefined}
          onDragOver={(e) => { e.preventDefault(); setDragHot(true); }}
          onDragLeave={() => setDragHot(false)}
          onDrop={(e) => { e.preventDefault(); setDragHot(false); acceptFiles(e.dataTransfer.files); }}
          role="button"
          tabIndex={0}
          aria-label="Drop a book file here or press Enter to browse"
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
        >
          <div className="pointer-events-none absolute inset-0 ab-hero-glow" aria-hidden />
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            aria-label="Choose a book file"
            onChange={(e) => acceptFiles(e.target.files)}
          />
          <FileUp className="mx-auto h-10 w-10 text-violet-500/80" aria-hidden />
          <p className="mt-3 text-sm font-semibold">
            {hasSource ? source!.name : 'Drop a book here, or click to browse'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {hasSource
              ? `${formatNumber(source!.sizeBytes)} bytes · ${source!.via === 'file' ? 'file' : source!.via} — ready to analyze`
              : 'txt · md · epub · pdf · docx · rtf · html · srt — 900+ formats understood, scanned pages OCR’d automatically'}
          </p>
        </div>

        <div className="mt-3 grid gap-2 rounded-lg border bg-muted/30 p-3 md:grid-cols-[1fr_auto]" data-ab-ai-panel>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <WandSparkles className="h-3.5 w-3.5 text-violet-500" />
              <p className="text-xs font-semibold">Local AI director</p>
              <Badge variant="outline" className={cn('h-5 gap-1 text-[10px]',
                !settings.aiAssist ? 'text-muted-foreground'
                : localAiStatus?.ready ? 'border-emerald-500/40 text-emerald-600'
                : !settings.aiAllowRemoteDownload ? 'border-amber-500/40 text-amber-600'
                : 'text-muted-foreground')}>
                <span className={cn('h-1.5 w-1.5 rounded-full',
                  !settings.aiAssist ? 'bg-muted-foreground/50'
                  : localAiStatus?.ready ? 'bg-emerald-500'
                  : !settings.aiAllowRemoteDownload ? 'bg-amber-500' : 'bg-muted-foreground/50')} />
                {!settings.aiAssist ? 'AI disabled'
                  : localAiStatus?.ready ? 'Ready'
                  : !settings.aiAllowRemoteDownload ? 'Downloads disabled'
                  : 'Will download on first use'}
              </Badge>
            </div>
            <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
              {!settings.aiAssist
                ? 'AI is turned off in Settings — AutoBook will use its deterministic engine and will not download anything.'
                : localAiStatus?.ready
                  ? `${localAiStatus.modelName} · ~${localAiStatus.sizeMB} MB · runs entirely in this browser.`
                  : !settings.aiAllowRemoteDownload
                    ? 'Model is not bundled and downloads are blocked — the deterministic fallback will be used. Run "npm run fetch:model && npm run build", or enable downloads in Settings.'
                    : `${localAiStatus?.modelName ?? 'Model'} (~${localAiStatus?.sizeMB ?? '?'} MB) is downloaded once on first analysis, then cached in this browser.`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!localAiStatus?.ready && settings.aiAssist && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-xs"
                  onClick={downloadModel}
                  disabled={!!modelOp || !settings.aiAllowRemoteDownload}
                  title={settings.aiAllowRemoteDownload ? 'Download the selected model now' : 'Downloads are disabled in Settings'}
                >
                  {modelOp?.phase === 'download'
                    ? <><Loader2 className="h-3 w-3 animate-spin" />{Math.round(modelOp.p * 100)}%</>
                    : <><Download className="h-3 w-3" />Download model</>}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1 text-xs text-muted-foreground"
                  onClick={clearModel}
                  disabled={!!modelOp || !settings.aiAllowRemoteDownload}
                  title="Forget the cached copy and re-download next time"
                >
                  <RefreshCcw className="h-3 w-3" />
                </Button>
              </>
            )}
            <Label className="sr-only">Local AI model</Label>
            <Select value={settings.localAiModelId} onValueChange={(v) => useAppStore.getState().setSetting('localAiModelId', v)}>
              <SelectTrigger className="h-8 w-56 text-xs" aria-label="Local AI model"><SelectValue /></SelectTrigger>
              <SelectContent>
                {localAiModels.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    {m.label} · {m.tier === 'advanced' ? '★ advanced' : m.tier === 'fast' ? 'fast' : 'balanced'} · ~{m.sizeMB} MB
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" className="gap-1.5" onClick={() => run('analyze')} disabled={!hasSource || running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Analyze book
          </Button>
          <Button size="sm" variant="default" className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => run('audiobook')} disabled={!hasSource || running}>
            <BookAudio className="h-4 w-4" />
            One-click audiobook
          </Button>
          <Button size="sm" variant="default" className="gap-1.5 bg-violet-600 text-white hover:bg-violet-700" onClick={() => run('videobook')} disabled={!hasSource || running}>
            <Clapperboard className="h-4 w-4" />
            One-click videobook
          </Button>
          <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setPasteOpen(true)}>
            <ClipboardPaste className="h-3.5 w-3.5" /> Paste text
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => loadSample('fiction')}>
            <BookOpen className="h-3.5 w-3.5" /> Fiction sample
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => loadSample('nonfiction')}>
            <GraduationCap className="h-3.5 w-3.5" /> Non-fiction sample
          </Button>
          {hasSource && (
            <Button size="sm" variant="ghost" className="ml-auto gap-1.5 text-muted-foreground" onClick={() => { resetAnalysis(); setSource(null); setFileRef(null); setPastedText(null); }}>
              <X className="h-3.5 w-3.5" /> Clear
            </Button>
          )}
        </div>

        {hasSource && (
          <div className="mt-4">
            <StageStrip states={stagesPreview} message={stageMsg} />
          </div>
        )}

        {(producing || producingProgress > 0) && producing !== null && (
          <div className="mt-3" data-ab-producing={producing}>
            <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{producing === 'video' ? 'Producing audiobook + videobook' : 'Producing audiobook'}…</span>
              <span className="tabular-nums">{Math.round(producingProgress * 100)}%</span>
            </div>
            <Progress value={producingProgress * 100} aria-label="Production progress" />
          </div>
        )}
      </SectionPanel>

      {/* ============ VERDICT ============ */}
      <AnimatePresence>
        {verdict && result && (
          <motion.div
            key="verdict"
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <SectionPanel
              title="What AutoBook understood"
              description="The deterministic engine remains the safety net; the local language model supplies an additional reasoning pass for genre, speakers, casting and delivery."
              actions={
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="gap-1"><ShieldCheck className="h-3 w-3 text-emerald-600" />{result.meta.language.toUpperCase()}</Badge>
                  {result.ai && <Badge variant="outline" className="gap-1 text-violet-600"><WandSparkles className="h-3 w-3" />{result.ai.enabled ? 'Local AI' : 'Fallback'}</Badge>}
                  {result.ai?.enabled && typeof result.ai.coverage === 'number' && (
                    <Badge variant="outline" className="gap-1 tabular-nums text-violet-600">
                      AI lines {result.ai.reviewedDialogue}/{result.ai.totalUnits ?? '?'} ({Math.round(result.ai.coverage * 100)}%)
                    </Badge>
                  )}
                  <Badge variant="outline" className="tabular-nums">{formatNumber(result.stats.words)} words</Badge>
                  <Badge variant="outline" className="tabular-nums">~{formatNumber(Math.max(1, Math.round(result.stats.estMinutes)))} min</Badge>
                </div>
              }
            >
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-lg border p-4" data-ab-verdict>
                  <div className="flex items-start gap-4">
                    <ConfidenceRing value={verdict.confidence} kind={verdict.kind} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">
                        {verdict.kind === 'fiction' ? 'Fiction — characters will speak for themselves' : 'Non-fiction — narrated cover to cover'}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        “{result.meta.titleGuess}”{result.meta.authorGuess ? ` · by ${result.meta.authorGuess}` : ''}
                      </p>
                      <ul className="mt-2 space-y-1">
                        {verdict.reasons.map((r) => (
                          <li key={r} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                            <Lightbulb className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" /> {r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <div className="mt-3 space-y-1.5" data-ab-signals>
                    {verdict.signals.map((s) => {
                      const mag = Math.min(1, Math.abs(s.weight) / 4);
                      return (
                        <div key={s.name} className="ab-signal-row flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="w-32 shrink-0 truncate">{s.name}</span>
                          <div className="relative h-1.5 flex-1 rounded-full bg-muted">
                            <div
                              className={cn('absolute top-0 h-full rounded-full', s.weight >= 0 ? 'bg-violet-500' : 'bg-emerald-500')}
                              style={s.weight >= 0 ? { left: '50%', width: `${mag * 50}%` } : { right: '50%', width: `${mag * 50}%` }}
                            />
                            <div className="absolute left-1/2 top-0 h-full w-px bg-border" aria-hidden />
                          </div>
                          <span className="w-40 shrink-0 truncate" title={s.detail}>{s.detail}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-lg border p-4">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
                    <ListFilter className="h-3.5 w-3.5 text-muted-foreground" /> Reading plan
                  </p>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-600" />{result.stats.narrationUnits} narration passages — read by the {result.cast[0]?.meta.gender === 'female' ? 'female' : result.cast[0]?.meta.gender === 'male' ? 'male' : ''} narrator voice</li>
                    <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-600" />{correctedDialogueUnits} dialogue lines — performed by {correctedSpeakerCount} cast voices</li>
                    <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-600" />{result.chapters.length} chapter{result.chapters.length === 1 ? '' : 's'} detected — headings stay silent, gaps get a 0.7 s breath</li>
                    <li className="flex items-center gap-2"><X className="h-3.5 w-3.5 text-rose-500" />{formatNumber(skippedWords)} words never read: {(() => {
                      const reasons = [...new Set(result.units.filter((u) => u.kind === 'skip' && u.skipReason !== 'marker').map((u) => u.skipReason))];
                      return reasons.map((r) => (SKIP_LABELS[r ?? ''] ?? r).toLowerCase()).join(', ') || 'nothing needed skipping';
                    })()}</li>
                  </ul>
                  {skippedWords > 0 && (
                    <p className="mt-2 rounded-md bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">
                      Skipped lines stay visible in the script below, struck through with their reason — you can un-skip any of them.
                    </p>
                  )}
                </div>
              </div>
            </SectionPanel>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ============ CAST ============ */}
      {result && result.cast.length > 0 && (
        <SectionPanel
          title="Cast & voices"
          description={result.ai?.enabled
            ? `Every name AI-validated against full-text evidence${result.ai.charactersRejected?.length ? ` — ${result.ai.charactersRejected.length} non-character words rejected` : ''} — override any voice; the render follows you.`
            : 'Inferred from names, honorifics, kinship words and pronouns — override any voice; the render follows you.'}
          actions={
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="gap-1"><Users className="h-3 w-3" />{result.cast.length}</Badge>
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-muted-foreground" onClick={recast}>
                <RefreshCcw className="h-3 w-3" /> Reset casting
              </Button>
            </div>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-ab-cast>
            {result.cast.map((member: BookCastMember) => {
              const color = speakerColor(member.name);
              const override = castOverrides[member.name];
              const current = override ?? { profileId: member.profileId, rate: member.rate, pitch: member.pitch };
              return (
                <div key={member.name} className={cn('ab-cast-card rounded-lg border p-3 transition-shadow hover:shadow-md', member.meta.role === 'narrator' && 'border-violet-500/40 bg-violet-500/5')} data-ab-cast-card={member.name}>
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: color.dot }} aria-hidden>
                      {initialsOf(member.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{member.name}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">{member.meta.gender}</Badge>
                        <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">{member.meta.ageBand === 'unknown' ? 'ageless' : member.meta.ageBand}</Badge>
                        {member.meta.role !== 'minor' && <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">{member.meta.role}</Badge>}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5 space-y-1.5">
                    <Select
                      value={current.profileId}
                      onValueChange={(v) => setCastOverrides((m) => ({ ...m, [member.name]: { ...current, profileId: v } }))}
                    >
                      <SelectTrigger className="h-8 text-xs" aria-label={`${member.name} voice`}><SelectValue /></SelectTrigger>
                      <SelectContent className="max-h-64">
                        {profiles.map((p) => (
                          <SelectItem key={p.id} value={p.id} className="text-xs">
                            {p.name} · {p.gender}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <Volume2 className="h-3 w-3" aria-hidden />
                      <span className="tabular-nums">rate {current.rate.toFixed(2)} · pitch {current.pitch.toFixed(2)}</span>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <p className="cursor-help truncate text-[10px] italic text-muted-foreground/80">“{override ? 'manual override' : member.rationale}”</p>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-72">
                        <p className="font-semibold">Why this voice</p>
                        <p>{override ? 'You overrode the engine’s pick.' : member.rationale}</p>
                        <ul className="mt-1 list-disc pl-3 opacity-80">
                          {member.meta.evidence.map((e) => <li key={e}>{e}</li>)}
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              );
            })}
          </div>
        </SectionPanel>
      )}

      {/* ============ SCRIPT ============ */}
      {result && (
        <SectionPanel
          title={`Script (${speakableUnits.length} lines to read · ${effectiveUnits.length - speakableUnits.length} skipped)`}
          description="The exact narration script. Click a line or speaker to correct speaker, delivery, wording, or skipped state — the render uses this view."
          actions={
            <div className="flex items-center gap-1">
              {(['all', 'dialogue', 'narration', 'skipped'] as const).map((f) => (
                <Button key={f} size="sm" variant={filter === f ? 'default' : 'ghost'} className="h-7 px-2 text-[11px] capitalize" onClick={() => setFilter(f)} aria-pressed={filter === f}>
                  {f}
                </Button>
              ))}
            </div>
          }
        >
          <div className="max-h-96 overflow-y-auto rounded-lg border" data-ab-script>
            {visibleUnits.length === 0 ? (
              <p className="p-6 text-center text-xs text-muted-foreground">No lines match this filter.</p>
            ) : (
              <div className="divide-y divide-border/40">
                {visibleUnits.map((u) => {
                  const realIndex = effectiveUnits.indexOf(u);
                  const chapterChanged = u.kind === 'skip' && u.skipReason === 'marker';
                  return (
                    <div key={u.id}>
                      {chapterChanged && (
                        <div className="sticky top-0 z-10 border-b bg-muted/80 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-violet-600 backdrop-blur">
                          {u.text}
                        </div>
                      )}
                      <UnitRow unit={u} index={realIndex < 0 ? 0 : realIndex} onEdit={openEdit} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </SectionPanel>
      )}

      {/* ============ PRODUCE / OUTPUTS ============ */}
      {result && (
        <SectionPanel
          title="Produce & hand off"
          description="The classic studios remain one click away — AutoBook just did the casting and timing for them."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div className="ab-output-card rounded-lg border p-4" data-ab-output="audio">
              <div className="flex items-center gap-2">
                <BookAudio className="h-4 w-4 text-emerald-600" />
                <p className="text-sm font-semibold">Audiobook</p>
                {audioOut && <Badge variant="outline" className="ml-auto h-5 gap-1 text-[10px] text-emerald-600"><Check className="h-3 w-3" />Ready</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Full cast recording, chapter-aware pauses, {formatNumber(Math.max(1, Math.round(estMinutes)))} min estimated · {getFormat(settings.outputFormat || 'wav-16')?.label ?? 'WAV'}
              </p>
              {audioOut && (
                <div className="mt-2 rounded-md bg-emerald-500/10 p-2 text-[11px]">
                  <p className="truncate font-medium text-emerald-700">{audioOut.name}</p>
                  <p className="text-emerald-600/80">{formatDuration(audioOut.durationSec ?? 0)} · {formatNumber(audioOut.sizeBytes ?? 0)} bytes</p>
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => run('audiobook')} disabled={running}>
                  {producing === 'audio' ? <Loader2 className="h-3 w-3 animate-spin" /> : <BookAudio className="h-3 w-3" />}
                  {audioOut ? 'Re-render' : 'Render audiobook'}
                </Button>
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={sendToAudiobookStudio} disabled={running}>
                  Chapter tools →
                </Button>
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={downloadSrt} disabled={running}>
                  <Download className="h-3 w-3" /> SRT
                </Button>
              </div>
            </div>

            <div className="ab-output-card rounded-lg border p-4" data-ab-output="video">
              <div className="flex items-center gap-2">
                <Clapperboard className="h-4 w-4 text-violet-600" />
                <p className="text-sm font-semibold">Videobook</p>
                {videoOut && <Badge variant="outline" className="ml-auto h-5 gap-1 text-[10px] text-violet-600"><Check className="h-3 w-3" />Ready</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Chapter backdrops + the book text on screen, word-synced. Captions are clean by design — no timestamps, no speaker labels.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Backdrop</Label>
                  <Select value={videoTheme} onValueChange={(v) => setVideoTheme(v as typeof videoTheme)}>
                    <SelectTrigger className="h-8 text-xs" aria-label="Videobook backdrop"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="aurora" className="text-xs">Aurora (violet)</SelectItem>
                      <SelectItem value="parchment" className="text-xs">Parchment (amber)</SelectItem>
                      <SelectItem value="ink" className="text-xs">Ink (mono)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Resolution</Label>
                  <Select value={videoHiRes ? '1080' : '720'} onValueChange={(v) => setVideoHiRes(v === '1080')}>
                    <SelectTrigger className="h-8 text-xs" aria-label="Videobook resolution"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="720" className="text-xs">1280 × 720</SelectItem>
                      <SelectItem value="1080" className="text-xs">1920 × 1080</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between rounded-md bg-muted/40 px-2 py-1.5">
                <div>
                  <p className="text-[11px] font-medium">Full length</p>
                  <p className="text-[10px] text-muted-foreground">off = first 60 s preview (video records in real time)</p>
                </div>
                <Switch checked={videoFull} onCheckedChange={setVideoFull} aria-label="Render full-length videobook" />
              </div>
              {videoOut && (
                <div className="mt-2 rounded-md bg-violet-500/10 p-2 text-[11px]">
                  <p className="truncate font-medium text-violet-700">{videoOut.name}</p>
                  <p className="text-violet-600/80">{formatDuration(videoOut.durationSec ?? 0)} · {videoOut.width}×{videoOut.height}</p>
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => run('videobook')} disabled={running}>
                  {producing === 'video' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Clapperboard className="h-3 w-3" />}
                  {videoOut ? 'Re-render' : 'Render videobook'}
                </Button>
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={copyDialogueScript}>
              <ClipboardPaste className="h-3 w-3" /> Copy script for Dialogue Studio
            </Button>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={downloadScript}>
              <FileText className="h-3 w-3" /> Download script (.txt)
            </Button>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={downloadZip} disabled={running || !result}>
              <Download className="h-3 w-3" /> Export ZIP (all files)
            </Button>
          </div>
        </SectionPanel>
      )}

      {/* ============ edit dialog ============ */}
      <Dialog open={!!editingUnit} onOpenChange={(o) => !o && setEditingUnit(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Correct line {editingUnit?.id}</DialogTitle>
            <DialogDescription>
              Manually correct the detected speaker, delivery hint, text, or skipped state. Choosing a character changes narration into dialogue; choosing Narrator changes dialogue into narration.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="line-speaker">Speaker</Label>
              <Select value={editSpeaker} onValueChange={setEditSpeaker}>
                <SelectTrigger id="line-speaker" className="w-full">
                  <SelectValue placeholder="Choose speaker" />
                </SelectTrigger>
                <SelectContent>
                  {speakerOptions.map((name) => (
                    <SelectItem key={name} value={name}>{name}</SelectItem>
                  ))}
                  <SelectItem value="__custom">New / custom speaker…</SelectItem>
                </SelectContent>
              </Select>
              {editSpeaker === '__custom' && (
                <Input
                  value={editCustomSpeaker}
                  onChange={(e) => setEditCustomSpeaker(e.target.value)}
                  placeholder="Enter the corrected speaker name"
                  aria-label="Custom speaker name"
                />
              )}
              <p className="text-[11px] text-muted-foreground">
                Select Narrator for narration, an existing cast member, or enter a new speaker name.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Delivery hint</Label>
              <Select value={editEmotion} onValueChange={(v) => setEditEmotion(v as typeof editEmotion)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Delivery hint" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__keep">Keep auto-detected hint</SelectItem>
                  <SelectItem value="__none">No delivery hint</SelectItem>
                  <SelectItem value="whisper">Whisper</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="curious">Curious</SelectItem>
                  <SelectItem value="soft">Soft</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="line-text">Line text</Label>
              <Textarea id="line-text" value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={5} aria-label="Line text" />
            </div>

            <label className="flex items-center gap-2 text-xs">
              <Switch checked={editSkip} onCheckedChange={setEditSkip} aria-label="Skip this line" />
              Skip this line (never read aloud)
            </label>
          </div>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setEditingUnit(null)}>Cancel</Button>
            <Button
              size="sm"
              onClick={applyEdit}
              disabled={!editSkip && editSpeaker === '__custom' && !editCustomSpeaker.trim()}
            >
              Save correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ============ paste dialog ============ */}
      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Paste book text</DialogTitle>
            <DialogDescription>Paste any prose — the same pipeline runs on it locally.</DialogDescription>
          </DialogHeader>
          <Textarea
            value={pasteDraft}
            onChange={(e) => setPasteDraft(e.target.value)}
            rows={12}
            placeholder={'Paste the book here…\n\nTip: keep paragraph breaks — they help the dialogue attribution.'}
            aria-label="Book text"
          />
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setPasteOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={applyPaste} disabled={!pasteDraft.trim()}>Use this text</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
