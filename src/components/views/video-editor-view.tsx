'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useAppStore } from '@/lib/stores/app-store';
import { VideoRenderer, buildSrt, buildVtt, createDefaultProject, detectExportFormats, exportVideo, parseSrt } from '@/lib/engines/video-render';
import { aiPlanVideo, aiWriteCaptions } from '@/lib/engines/ai-services';
import { computeRmsLevels, mixMusicBed, sliceBuffer, smoothDuckGains } from '@/lib/engines/dsp';
import {
  VIDEO_PROJECTS_CURRENT_KEY,
  deleteProject,
  getProject,
  listProjects,
  putProject,
  type StoredVideoProject,
} from '@/lib/engines/video-projects-db';
import { enqueueJob } from '@/lib/queue';
import type { ClipTextOverlay, DuckGainPoint, MusicBedSettings, SubtitleCue, SubtitleStyle, VideoClip, VideoProject } from '@/lib/types';
import { motion } from 'framer-motion';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/utils/format';
import { speakerChipClass } from '@/lib/utils/speaker-color';
import { uid, yieldToUI } from '@/lib/utils/async';
import {
  ArrowDown, ArrowUp, AudioLines, Captions, Check, ClipboardPaste, Copy, Download, FileJson, FileText, Film, FolderOpen,
  Image as ImageIcon, Layers, Music, Music4, Palette, Pause, Pencil, Play, Plus, Redo2, Save, Sparkles, Trash2, Type, Undo2, Upload, Volume2, Wand2, X,
} from 'lucide-react';

const PALETTE = ['#0d0d0f', '#1c1c22', '#2d1b2e', '#3d2b1f', '#1f2d1b', '#122a2a', '#2a1224', '#e8e4d8'];

const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSize: 5, // % of frame height
  color: '#ffffff',
  position: 'bottom',
  background: true,
  outline: true,
};

const DEFAULT_MUSIC_BED: MusicBedSettings = {
  volume: 0.25,
  loop: true,
  duck: true,
  duckAmount: 0.7,
  attackMs: 30,
  releaseMs: 400,
};

/** Manual duck automation is capped — beyond this the canvas ignores new points (toast). */
const MAX_GAIN_POINTS = 24;

/** Pointer hit radius (CSS px) for picking gain-point diamonds on the preview. */
const GAIN_POINT_HIT_PX = 8;

/** Stable empty array so a derived gainPoints value never breaks callback/effect identity. */
const NO_GAIN_POINTS: DuckGainPoint[] = [];

/**
 * Legacy localStorage round-trip key — kept ONLY as a one-time migration source.
 * Persistence moved to IndexedDB ('auravoice-video-projects-db', record 'current');
 * after a successful restore/migration the legacy key is removed so the two
 * paths can never double-restore. IndexedDB path won.
 */
const VIDEO_PROJECT_KEY = 'auravoice-video-project-v1';

/** Tolerant number clamp used by every sanitizer below. */
const CLAMP_NUM = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

const CLIP_TYPES = ['image', 'color', 'gradient', 'text'] as const;
const CLIP_TRANSITIONS = ['none', 'fade', 'slide', 'wipe'] as const;
const CLIP_KEN_BURNS = ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right'] as const;
const CLIP_FILTERS = ['none', 'grayscale', 'sepia', 'vintage', 'cool', 'warm'] as const;
const TEXT_POSITIONS = ['top', 'center', 'bottom'] as const;

/** Compact relative timestamp for the saved-project list ("2m ago"). */
function timeAgo(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Tolerant stats from a stored record's snapshot (list meta line). */
function storedProjectStats(rec: StoredVideoProject): { clips: number; duration: number; cues: number } {
  const p = (rec?.project ?? {}) as Partial<VideoProject>;
  const clips = Array.isArray(p.clips) ? (p.clips as Partial<VideoClip>[]) : [];
  const cues = Array.isArray(p.subtitles) ? (p.subtitles as Partial<SubtitleCue>[]) : [];
  const duration = clips.reduce((a, c) => a + CLAMP_NUM(c?.durationSec, 0, 0, 3600), 0);
  return { clips: clips.length, duration, cues: cues.length };
}

/**
 * Tolerant round-trip for manual duck gain points: plain `{t, depth}` data only
 * (kept fully serializable for history snapshots + IndexedDB), finite values,
 * clamped, sorted by t, capped at MAX_GAIN_POINTS. Absent/empty → undefined.
 */
function sanitizeGainPoints(raw: unknown): DuckGainPoint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const pts: DuckGainPoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as { t?: unknown; depth?: unknown };
    if (typeof p.t !== 'number' || !Number.isFinite(p.t)) continue;
    if (typeof p.depth !== 'number' || !Number.isFinite(p.depth)) continue;
    pts.push({ t: Math.min(3600, Math.max(0, p.t)), depth: Math.min(1, Math.max(0, p.depth)) });
  }
  if (!pts.length) return undefined;
  pts.sort((a, b) => a.t - b.t);
  return pts.slice(0, MAX_GAIN_POINTS);
}

function sanitizeMusicBed(raw: unknown): MusicBedSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_MUSIC_BED };
  const r = raw as Record<string, unknown>;
  return {
    volume: CLAMP_NUM(r.volume, DEFAULT_MUSIC_BED.volume, 0, 1),
    loop: typeof r.loop === 'boolean' ? r.loop : DEFAULT_MUSIC_BED.loop,
    duck: typeof r.duck === 'boolean' ? r.duck : DEFAULT_MUSIC_BED.duck,
    duckAmount: CLAMP_NUM(r.duckAmount, DEFAULT_MUSIC_BED.duckAmount, 0, 1),
    attackMs: CLAMP_NUM(r.attackMs, DEFAULT_MUSIC_BED.attackMs, 1, 5000),
    releaseMs: CLAMP_NUM(r.releaseMs, DEFAULT_MUSIC_BED.releaseMs, 1, 10000),
    gainPoints: sanitizeGainPoints(r.gainPoints),
  };
}

function sanitizeOverlay(raw: unknown): ClipTextOverlay | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Partial<ClipTextOverlay>;
  if (typeof o.text !== 'string' || !o.text) return undefined;
  return {
    text: o.text,
    size: CLAMP_NUM(o.size, 6, 2, 24),
    color: typeof o.color === 'string' ? o.color : '#f4f4f5',
    position: TEXT_POSITIONS.includes(o.position as (typeof TEXT_POSITIONS)[number])
      ? (o.position as ClipTextOverlay['position'])
      : 'center',
    shadow: typeof o.shadow === 'boolean' ? o.shadow : true,
  };
}

function sanitizeProject(raw: unknown, fallback: VideoProject): VideoProject {
  if (!raw || typeof raw !== 'object') return fallback;
  const p = raw as Partial<VideoProject>;
  const clips = Array.isArray(p.clips)
    ? p.clips
        .filter((c) => Boolean(c) && typeof c === 'object')
        .map((c) => {
          const cc = c as Partial<VideoClip>;
          const partial: Partial<VideoClip> = {
            type: CLIP_TYPES.includes(cc.type as (typeof CLIP_TYPES)[number]) ? (cc.type as VideoClip['type']) : 'gradient',
            durationSec: CLAMP_NUM(cc.durationSec, 4, 0.1, 3600),
            transition: CLIP_TRANSITIONS.includes(cc.transition as (typeof CLIP_TRANSITIONS)[number])
              ? (cc.transition as VideoClip['transition'])
              : 'fade',
            kenBurns: CLIP_KEN_BURNS.includes(cc.kenBurns as (typeof CLIP_KEN_BURNS)[number])
              ? (cc.kenBurns as VideoClip['kenBurns'])
              : 'none',
            filter: CLIP_FILTERS.includes(cc.filter as (typeof CLIP_FILTERS)[number])
              ? (cc.filter as VideoClip['filter'])
              : 'none',
            overlay: sanitizeOverlay(cc.overlay),
          };
          // only set optional fields when present — an explicit undefined would
          // override newClip()'s defaults during the spread
          if (typeof cc.id === 'string' && cc.id) partial.id = cc.id;
          if (typeof cc.assetId === 'string') partial.assetId = cc.assetId;
          if (typeof cc.color === 'string') partial.color = cc.color;
          if (typeof cc.color2 === 'string') partial.color2 = cc.color2;
          if (typeof cc.text === 'string') partial.text = cc.text;
          return newClip(partial);
        })
    : fallback.clips;
  const subtitles = Array.isArray(p.subtitles)
    ? p.subtitles
        .filter((c) => Boolean(c) && typeof c === 'object')
        .map((c) => {
          const cc = c as Partial<SubtitleCue>;
          return {
            startSec: Number(cc.startSec),
            endSec: Number(cc.endSec),
            text: typeof cc.text === 'string' ? cc.text : '',
            // speaker attribution survives round-trips (empty/whitespace = none)
            speaker: typeof cc.speaker === 'string' && cc.speaker.trim() ? cc.speaker : undefined,
          };
        })
        .filter((c) => Number.isFinite(c.startSec) && Number.isFinite(c.endSec))
    : undefined;
  const ss = (p.subtitleStyle && typeof p.subtitleStyle === 'object' ? p.subtitleStyle : {}) as Partial<SubtitleStyle>;
  return {
    ...fallback,
    id: typeof p.id === 'string' && p.id ? p.id : fallback.id,
    name: typeof p.name === 'string' && p.name.trim() ? p.name : fallback.name,
    width: CLAMP_NUM(p.width, fallback.width, 160, 4096),
    height: CLAMP_NUM(p.height, fallback.height, 160, 4096),
    fps: CLAMP_NUM(p.fps, fallback.fps, 1, 120),
    clips: clips.length ? clips : fallback.clips,
    soundtrackAssetId: typeof p.soundtrackAssetId === 'string' ? p.soundtrackAssetId : undefined,
    musicBedAssetId: typeof p.musicBedAssetId === 'string' ? p.musicBedAssetId : undefined,
    musicBed: p.musicBed === undefined ? undefined : sanitizeMusicBed(p.musicBed),
    subtitles: subtitles && subtitles.length ? subtitles : undefined,
    subtitleStyle: p.subtitleStyle && typeof p.subtitleStyle === 'object'
      ? {
          fontSize: CLAMP_NUM(ss.fontSize, DEFAULT_SUBTITLE_STYLE.fontSize, 2, 12),
          color: typeof ss.color === 'string' && ss.color ? ss.color : DEFAULT_SUBTITLE_STYLE.color,
          position: TEXT_POSITIONS.includes(ss.position as (typeof TEXT_POSITIONS)[number])
            ? (ss.position as SubtitleStyle['position'])
            : DEFAULT_SUBTITLE_STYLE.position,
          background: typeof ss.background === 'boolean' ? ss.background : DEFAULT_SUBTITLE_STYLE.background,
          outline: typeof ss.outline === 'boolean' ? ss.outline : DEFAULT_SUBTITLE_STYLE.outline,
          showSpeaker: typeof ss.showSpeaker === 'boolean' ? ss.showSpeaker : undefined,
        }
      : undefined,
  };
}

/** Module-level preview music player (kept outside React to avoid re-render churn). */
const musicPlayer = {
  ctx: null as AudioContext | null,
  src: null as AudioBufferSourceNode | null,
  stop() {
    try { this.src?.stop(); } catch { /* noop */ }
    this.src = null;
  },
  start(buffer: AudioBuffer, fromSec: number) {
    this.stop();
    if (!this.ctx) this.ctx = new AudioContext();
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0, Math.max(0, Math.min(fromSec, buffer.duration)));
    this.src = src;
  },
};

function newClip(partial?: Partial<VideoClip>): VideoClip {
  return {
    id: uid('clip'),
    type: 'gradient',
    color: '#2d1b2e',
    color2: '#0d0d0f',
    durationSec: 4,
    transition: 'fade',
    kenBurns: 'none',
    filter: 'none',
    overlay: undefined,
    ...partial,
  };
}

/** The default timeline shown on first visit (2 demo clips). */
function createDemoProject(): VideoProject {
  return {
    ...createDefaultProject(),
    clips: [
      newClip({ type: 'gradient', color: '#2d1b2e', color2: '#122a2a', durationSec: 3, overlay: { text: 'Openmukti Audiobook Creator', size: 9, color: '#f4f4f5', position: 'center', shadow: true } }),
      newClip({ type: 'color', color: '#1c1c22', durationSec: 4, overlay: { text: 'Built locally.\nZero uploads.', size: 6, color: '#d4d4d8', position: 'center', shadow: true } }),
    ],
  };
}

/** Plain-data copy of the project — safe to persist (no runtime buffers exist on it). */
function serializeProject(p: VideoProject): VideoProject {
  return {
    ...p,
    clips: p.clips.map((c) => ({ ...c, overlay: c.overlay ? { ...c.overlay } : undefined })),
    subtitles: p.subtitles?.map((c) => ({ ...c })),
    subtitleStyle: p.subtitleStyle ? { ...p.subtitleStyle } : undefined,
    musicBed: p.musicBed ? { ...p.musicBed } : undefined,
  };
}

/**
 * Does a stored/parsed snapshot differ from the default empty demo project?
 * Content-only comparison — clip ids are regenerated per session.
 */
function snapshotDiffersFromDefault(raw: unknown, baseline: VideoProject): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Partial<VideoProject>;
  if (Array.isArray(p.subtitles) && p.subtitles.length) return true;
  if (typeof p.soundtrackAssetId === 'string' || typeof p.musicBedAssetId === 'string') return true;
  // duck gain points alone are enough editing to deserve a session restore
  const mbRaw = p.musicBed as { gainPoints?: unknown } | undefined;
  if (Array.isArray(mbRaw?.gainPoints) && (mbRaw?.gainPoints as unknown[]).length > 0) return true;
  if (Array.isArray(p.clips)) {
    if (p.clips.length !== baseline.clips.length) return true;
    return p.clips.some((c, i) => {
      const cc = (c ?? {}) as Partial<VideoClip>;
      const b = baseline.clips[i];
      if (!b) return true;
      return cc.type !== b.type || cc.durationSec !== b.durationSec || cc.color !== b.color || cc.color2 !== b.color2 || cc.text !== b.text;
    });
  }
  return false;
}

/** Max snapshots in the undo stack — the OLDEST is dropped beyond this (bounded memory). */
const HISTORY_LIMIT = 50;

/** Same-tag commits within this window coalesce into one snapshot (slider drags, typing bursts). */
const HISTORY_COALESCE_MS = 500;

/**
 * Undo/redo history for the working video project.
 *
 * Model: a stack of full-project snapshots + a pointer. `commit()` pushes the
 * next state (discarding any redo branch first); undo/redo only move the
 * pointer and apply the stored snapshot — no push — so the autosave effect
 * still fires and history changes persist like any other edit. Snapshots are
 * `serializeProject()` copies: plain data (clips, cues, style, asset ids).
 * The project state holds no runtime buffers — audio lives in the Asset Bin,
 * the project stores asset ids only — so snapshots are fully serializable.
 *
 * Coalescing: `commit(updater, tag)` REPLACES the current snapshot when the
 * same tag commits again within HISTORY_COALESCE_MS, so continuous drags
 * (music-bed volume, subtitle font size, clip duration, color pickers, cue
 * text typing, rapid nudges…) collapse into a single undo step instead of
 * flooding the stack. Tags are derived per field (`clip:<id>:durationSec`,
 * `bed:volume`, `style:fontSize`, `cue:<i>:text`, `cue-nudge:<i>`).
 *
 * Loads/imports/session restores call `reset()`, which clears the stack and
 * pushes the loaded state as the new baseline — deliberately NOT undoable:
 * letting ⌘Z crawl back into the previous project would make "load" look
 * broken and splice two timelines into one history. The honest UX is a fresh
 * history per project; the previous project is safe in its named snapshot.
 */
function useProjectHistory(initial: () => VideoProject) {
  const [project, setProjectState] = useState<VideoProject>(initial);
  // Mirror of the live project — every write routes through commit()/reset()
  // below, so commits always read the freshest state synchronously.
  const projectRef = useRef<VideoProject>(project);
  // Snapshot stack + pointer. Entries are never mutated after being stored
  // (every edit produces immutable spreads), so shared references are safe.
  const stackRef = useRef<VideoProject[]>([project]);
  const pointerRef = useRef(0);
  const lastTagRef = useRef<string | null>(null);
  const lastPushAtRef = useRef(0);
  // pointer/depth mirrored into state so the buttons + indicator re-render.
  const [hist, setHist] = useState({ pointer: 0, depth: 1 });

  const syncHist = useCallback(() => {
    setHist((h) => (h.pointer === pointerRef.current && h.depth === stackRef.current.length
      ? h
      : { pointer: pointerRef.current, depth: stackRef.current.length }));
  }, []);

  /** History-aware project setter: apply `updater` and record a snapshot. */
  const commit = useCallback((updater: (p: VideoProject) => VideoProject, tag?: string) => {
    const prev = projectRef.current;
    const next = updater(prev);
    if (next === prev) return; // updater declined (e.g. out-of-bounds reorder) — nothing to record
    const snap = serializeProject(next);
    projectRef.current = next;
    setProjectState(next);
    const now = Date.now();
    const stack = stackRef.current;
    if (tag && tag === lastTagRef.current && now - lastPushAtRef.current < HISTORY_COALESCE_MS) {
      stack[pointerRef.current] = snap; // coalesce — one entry for the whole drag/burst
    } else {
      stack.length = pointerRef.current + 1; // discard the redo branch
      stack.push(snap);
      if (stack.length > HISTORY_LIMIT) stack.shift(); // cap — drop the oldest
      pointerRef.current = stack.length - 1;
    }
    lastTagRef.current = tag ?? null;
    lastPushAtRef.current = now;
    syncHist();
  }, [syncHist]);

  /** Move the pointer back one snapshot (no push). */
  const undo = useCallback(() => {
    const stack = stackRef.current;
    if (pointerRef.current <= 0) return;
    pointerRef.current -= 1;
    lastTagRef.current = null; // the next edit must branch, never coalesce across an undo
    projectRef.current = stack[pointerRef.current];
    setProjectState(stack[pointerRef.current]);
    syncHist();
  }, [syncHist]);

  /** Move the pointer forward one snapshot (no push). */
  const redo = useCallback(() => {
    const stack = stackRef.current;
    if (pointerRef.current >= stack.length - 1) return;
    pointerRef.current += 1;
    lastTagRef.current = null;
    projectRef.current = stack[pointerRef.current];
    setProjectState(stack[pointerRef.current]);
    syncHist();
  }, [syncHist]);

  /**
   * Hard reset for context switches — named load, JSON import, session
   * restore. Clears the stack and pushes `next` as the new baseline (see the
   * JSDoc above for why this is deliberately not undoable).
   */
  const reset = useCallback((next: VideoProject) => {
    projectRef.current = next;
    setProjectState(next);
    stackRef.current = [serializeProject(next)];
    pointerRef.current = 0;
    lastTagRef.current = null;
    lastPushAtRef.current = 0;
    setHist({ pointer: 0, depth: 1 });
  }, []);

  return {
    project,
    commit,
    reset,
    undo,
    redo,
    canUndo: hist.pointer > 0,
    canRedo: hist.pointer < hist.depth - 1,
    step: hist.pointer + 1,
    depth: hist.depth,
  };
}

export function VideoEditorView() {
  const { toast } = useToast();
  const assets = useAppStore((s) => s.assets);
  const addAsset = useAppStore((s) => s.addAsset);
  const tuned = useAppStore((s) => s.tuned);
  // Active-view flag — the shell keeps every view mounted (display:none when
  // inactive), so the document-level ⌘Z/⇧⌘Z handler below must gate on the
  // editor actually being visible.
  const isEditorActive = useAppStore((s) => s.view === 'video');

  const {
    project,
    commit,
    reset,
    undo,
    redo,
    canUndo,
    canRedo,
    step: historyStep,
    depth: historyDepth,
  } = useProjectHistory(createDemoProject);
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [exportFormat, setExportFormat] = useState<'webm-vp9' | 'webm-vp8' | 'mp4-h264'>('webm-vp9');
  const [exportQuality, setExportQuality] = useState<'low' | 'medium' | 'high'>('medium');
  const [exporting, setExporting] = useState(false);
  const [editingCueIdx, setEditingCueIdx] = useState<number | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [shiftSecs, setShiftSecs] = useState('');
  const [savedProjects, setSavedProjects] = useState<StoredVideoProject[]>([]);
  const [saveName, setSaveName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<StoredVideoProject | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<VideoRenderer | null>(null);
  const rafRef = useRef<number>(0);
  const subFileRef = useRef<HTMLInputElement | null>(null);
  const bedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rmsCacheRef = useRef<{ buffer: AudioBuffer; levels: Float32Array } | null>(null);
  // Duck gain-point editing: selected index (LOCAL view state, not project
  // state), the in-flight drag overlay (canvas-render only — the project only
  // updates on pointerup) and the press-on-empty flag that turns a clean
  // pointerup into a point ADD.
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const dragRef = useRef<{ index: number; t: number; depth: number } | null>(null);
  const pressedEmptyRef = useRef(false);
  const projectRestoredRef = useRef(false);
  const projFileRef = useRef<HTMLInputElement | null>(null);
  const currentCreatedAtRef = useRef<number | null>(null);
  const saveNameDirtyRef = useRef(false);

  const pendingSoundtrack = useAppStore((st) => st.pendingSoundtrackAssetId);
  const setPendingSoundtrack = useAppStore((st) => st.setPendingSoundtrackAssetId);
  const pendingSubtitleCues = useAppStore((st) => st.pendingSubtitleCues);
  const setPendingSubtitleCues = useAppStore((st) => st.setPendingSubtitleCues);
  const audioAssets = useMemo(() => assets.filter((a) => a.kind === 'audio' && a.buffer), [assets]);
  const imageAssets = useMemo(() => assets.filter((a) => a.kind === 'image'), [assets]);
  const formats = useMemo(() => detectExportFormats(), []);
  const total = useMemo(() => project.clips.reduce((a, c) => a + Math.max(0.1, c.durationSec), 0), [project.clips]);
  const activeClip = project.clips.find((c) => c.id === selectedClip) ?? project.clips[0];
  const soundtrack = audioAssets.find((a) => a.id === project.soundtrackAssetId);
  const bedAsset = audioAssets.find((a) => a.id === project.musicBedAssetId);
  const bedAttached = Boolean(bedAsset && project.musicBedAssetId);
  const musicBed = { ...DEFAULT_MUSIC_BED, ...project.musicBed };
  // manual duck automation points (empty = sidechain-only ducking)
  const gainPoints = musicBed.gainPoints ?? NO_GAIN_POINTS;
  const subtitles = project.subtitles ?? [];
  const subtitleStyle = { ...DEFAULT_SUBTITLE_STYLE, ...project.subtitleStyle };
  // speaker display defaults ON as soon as any cue carries a speaker tag
  const showSpeakerNames = project.subtitleStyle?.showSpeaker ?? subtitles.some((c) => Boolean(c.speaker?.trim()));
  // unique speaker names across cues — feeds the per-row speaker <datalist>
  // (Dialogue Studio cast names are not reachable from this view; cue tags only)
  const knownSpeakers = useMemo(() => {
    const out: string[] = [];
    for (const c of subtitles) {
      const s = (c.speaker ?? '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  }, [subtitles]);

  // consume soundtrack handoff from Asset Bin (deferred to avoid sync setState in effect)
  useEffect(() => {
    if (!pendingSoundtrack) return;
    if (!assets.some((a) => a.id === pendingSoundtrack)) return;
    const id = pendingSoundtrack;
    const t = setTimeout(() => {
      commit((pr) => ({ ...pr, soundtrackAssetId: id }), 'soundtrack');
      toast({ title: 'Soundtrack applied', description: 'Set from the Asset Bin.' });
      setPendingSoundtrack(null);
    }, 0);
    return () => clearTimeout(t);
  }, [pendingSoundtrack, assets, setPendingSoundtrack]);

  // consume subtitle-cue handoff (OCR Lab / Dialogue Studio — deferred to avoid
  // sync setState in effect). Cues pass through UNTOUCHED so R9-b's `speaker`
  // tags (and any other fields) arrive intact; sanitizers keep speaker when it
  // is a string, and this effect never strips unknown fields.
  useEffect(() => {
    if (!pendingSubtitleCues) return;
    const cues = pendingSubtitleCues;
    const t = setTimeout(() => {
      commit((pr) => ({ ...pr, subtitles: cues }), 'subtitles-import');
      setEditingCueIdx(null);
      const tagged = cues.filter((c) => typeof c.speaker === 'string' && c.speaker.trim()).length;
      toast({
        title: `Subtitles imported (${cues.length} cues${tagged ? `, ${tagged} speaker-tagged` : ''})`,
        description: 'Timed cues applied as the subtitle track.',
      });
      setPendingSubtitleCues(null);
    }, 0);
    return () => clearTimeout(t);
  }, [pendingSubtitleCues, setPendingSubtitleCues]);

  // consume full-project handoff from AutoBook (deferred to avoid sync setState
  // in effect). The project arrives with its own clips, clean-caption subtitle
  // track and a soundtrackAssetId that resolves inside the Asset Bin.
  const pendingVideoProject = useAppStore((st) => st.pendingVideoProject);
  const setPendingVideoProject = useAppStore((st) => st.setPendingVideoProject);
  useEffect(() => {
    if (!pendingVideoProject) return;
    const incoming = pendingVideoProject;
    const t = setTimeout(() => {
      commit(() => ({ ...incoming }), 'autobook-import');
      setSelectedClip(incoming.clips[0]?.id ?? null);
      toast({
        title: 'Videobook timeline imported',
        description: `${incoming.clips.length} chapter backdrops · ${incoming.subtitles?.length ?? 0} clean captions.`,
      });
      setPendingVideoProject(null);
    }, 0);
    return () => clearTimeout(t);
  }, [pendingVideoProject, setPendingVideoProject]);

  // ---------- project persistence (IndexedDB) ----------

  const refreshProjects = useCallback(async () => {
    try {
      const rows = await listProjects();
      setSavedProjects(rows.filter((r) => r && typeof r.id === 'string' && r.id !== VIDEO_PROJECTS_CURRENT_KEY));
    } catch {
      setSavedProjects([]);
    }
  }, []);

  const buildAutosaveRecord = useCallback((p: VideoProject): StoredVideoProject => {
    const now = Date.now();
    const createdAt = currentCreatedAtRef.current ?? now;
    currentCreatedAtRef.current = createdAt;
    return { id: VIDEO_PROJECTS_CURRENT_KEY, name: p.name || 'Untitled Video', updatedAt: now, createdAt, project: serializeProject(p) };
  }, []);

  /** Immediate (non-debounced) write of the working project — used before loads. */
  const flushCurrentAutosave = useCallback((p: VideoProject) => {
    void putProject(buildAutosaveRecord(p));
  }, [buildAutosaveRecord]);

  // restore the working project from IndexedDB ('current' autosave record).
  // IndexedDB is the single persistence path now (it won over the legacy
  // localStorage round-trip, which is migrated once and then cleared).
  useEffect(() => {
    let cancelled = false;
    const baseline = createDemoProject();
    const t = setTimeout(() => {
      void (async () => {
        let restoredFromDb = false;
        try {
          const cur = await getProject(VIDEO_PROJECTS_CURRENT_KEY);
          if (cur && snapshotDiffersFromDefault(cur.project, baseline)) {
            const restored = sanitizeProject(cur.project, baseline);
            const next: VideoProject = {
              ...restored,
              id: restored.id && restored.id !== VIDEO_PROJECTS_CURRENT_KEY ? restored.id : uid('vproj'),
            };
            reset(next); // session restore = loading a project → fresh history (see useProjectHistory)
            setSaveName(next.name);
            saveNameDirtyRef.current = false;
            currentCreatedAtRef.current = Number.isFinite(cur.createdAt) ? cur.createdAt : Date.now();
            restoredFromDb = true;
            if (!cancelled) toast({ title: 'Video project restored', description: 'Clips, subtitles and music-bed settings recovered from your last session.' });
          }
        } catch {
          // best-effort — fall through to the legacy migration
        }
        if (cancelled) return;
        if (!restoredFromDb) {
          // one-time migration from the legacy localStorage snapshot
          try {
            const raw = localStorage.getItem(VIDEO_PROJECT_KEY);
            if (raw) {
              const saved = JSON.parse(raw) as unknown;
              if (snapshotDiffersFromDefault(saved, baseline)) {
                const restored = sanitizeProject(saved, baseline);
                reset({ ...restored, id: restored.id && restored.id !== 'vp-default' ? restored.id : uid('vproj') }); // restore = load → fresh history
                setSaveName(restored.name);
                saveNameDirtyRef.current = false;
                toast({ title: 'Video project restored', description: 'Clips, subtitles and music-bed settings recovered from your last session.' });
              }
              localStorage.removeItem(VIDEO_PROJECT_KEY); // legacy path retired — no double restore
            }
          } catch {
            // corrupt payload — start fresh
          }
        } else {
          try { localStorage.removeItem(VIDEO_PROJECT_KEY); } catch { /* ignore */ }
        }
        if (!cancelled) {
          projectRestoredRef.current = true;
          void refreshProjects();
        }
      })();
    }, 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, []); // run once on mount; setters/toast/refreshProjects are stable

  // debounced autosave of the working project into IndexedDB (after restore)
  useEffect(() => {
    if (!projectRestoredRef.current) return;
    const t = setTimeout(() => {
      void putProject(buildAutosaveRecord(project));
    }, 1500);
    return () => clearTimeout(t);
  }, [project, buildAutosaveRecord]);

  // the "Save project" name input defaults to the live project name until edited
  useEffect(() => {
    if (!saveNameDirtyRef.current) setSaveName(project.name);
  }, [project.name]);

  // ⌘Z / Ctrl+Z → undo · ⇧⌘Z / Ctrl+Shift+Z / Ctrl+Y → redo. Document-level,
  // but ONLY while the Video Editor view is the active view — the shell keeps
  // every view mounted (display:none), so an ungated listener would also fire
  // from every other tab. Typing targets (inputs/textareas/contentEditable)
  // are skipped so text fields keep their native undo; no-op when the history
  // can't move (guards inside undo/redo).
  useEffect(() => {
    if (!isEditorActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isEditorActive, undo, redo]);

  // renderer setup
  useEffect(() => {
    if (!canvasRef.current) return;
    if (!rendererRef.current) {
      rendererRef.current = new VideoRenderer(canvasRef.current, project);
    } else {
      rendererRef.current.setProject(project);
    }
    rendererRef.current.drawFrameAt(playing ? time : time, assets);
  }, [project, assets, playing, time]);

  // preview loop
  useEffect(() => {
    if (!playing) return;
    const t0 = performance.now() - time * 1000;
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      if (t >= total) {
        setTime(0);
        setPlaying(false);
        musicPlayer.stop();
        return;
      }
      setTime(t);
      rendererRef.current?.drawFrameAt(t, assets);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, total, assets]);

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      musicPlayer.stop();
    } else {
      setPlaying(true);
      if (soundtrack?.buffer) musicPlayer.start(soundtrack.buffer, time);
    }
  };

  const updateClip = useCallback((id: string, patch: Partial<VideoClip>) => {
    // call sites pass exactly one field (audited) → the per-field tag coalesces
    // slider drags / typing bursts into a single undo step
    commit((p) => ({ ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }), `clip:${id}:${Object.keys(patch).join('+')}`);
  }, [commit]);

  const moveClip = useCallback((id: string, dir: -1 | 1) => {
    commit((p) => {
      const idx = p.clips.findIndex((c) => c.id === id);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= p.clips.length) return p; // declined → no history entry
      const clips = [...p.clips];
      [clips[idx], clips[target]] = [clips[target], clips[idx]];
      return { ...p, clips };
    }, 'clips-reorder');
  }, [commit]);

  const fitToSoundtrack = useCallback(() => {
    if (!soundtrack?.buffer) return;
    const target = soundtrack.buffer.duration;
    const per = target / Math.max(1, project.clips.length);
    commit((p) => ({ ...p, clips: p.clips.map((c) => ({ ...c, durationSec: +per.toFixed(2) })) }), 'clips-fit');
    toast({ title: 'Clips fitted to soundtrack', description: `Each clip now ${(per).toFixed(1)}s (total ${target.toFixed(1)}s).` });
  }, [soundtrack, project.clips.length, toast, commit]);

  // ---------- subtitles ----------

  const setSubtitleStylePatch = useCallback((patch: Partial<SubtitleStyle>) => {
    commit((p) => ({ ...p, subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE, ...p.subtitleStyle, ...patch } }), `style:${Object.keys(patch).join('+')}`);
  }, [commit]);

  const addCueAtPlayhead = useCallback(() => {
    const start = time;
    commit((p) => ({ ...p, subtitles: [...(p.subtitles ?? []), { startSec: start, endSec: start + 3, text: '' }] }), 'cue-add');
    setEditingCueIdx(subtitles.length); // appended cue becomes the last row — select it for editing
    toast({ title: 'Cue added', description: `New cue at ${formatDuration(start)}–${formatDuration(start + 3)} — click its text to type.` });
  }, [time, subtitles.length, toast, commit]);

  const updateCue = useCallback((idx: number, patch: Partial<SubtitleCue>) => {
    commit((p) => ({ ...p, subtitles: (p.subtitles ?? []).map((c, i) => (i === idx ? { ...c, ...patch } : c)) }), `cue:${idx}:${Object.keys(patch).join('+')}`);
  }, [commit]);

  const deleteCue = useCallback((idx: number) => {
    commit((p) => ({ ...p, subtitles: (p.subtitles ?? []).filter((_, i) => i !== idx) }), 'cue-delete');
    setEditingCueIdx((cur) => (cur === null ? null : cur === idx ? null : cur > idx ? cur - 1 : cur));
  }, [commit]);

  const clearSubtitles = useCallback(() => {
    commit((p) => ({ ...p, subtitles: undefined }), 'cue-clear');
    setEditingCueIdx(null);
    toast({ title: 'Subtitles cleared', description: 'All subtitle cues removed from the project.' });
  }, [toast, commit]);

  /** Move one cue in time (start + end shift together, duration preserved); clamped at 0. */
  const nudgeCue = useCallback((idx: number, delta: number) => {
    commit((p) => ({
      ...p,
      subtitles: (p.subtitles ?? []).map((c, i) => {
        if (i !== idx) return c;
        const dur = Math.max(0.05, c.endSec - c.startSec);
        const start = Math.max(0, c.startSec + delta);
        return { ...c, startSec: +start.toFixed(3), endSec: +(start + dur).toFixed(3) };
      }),
    }), `cue-nudge:${idx}`); // same-tag → rapid nudge bursts coalesce into one step
  }, [commit]);

  /** Shift every cue by `delta` seconds — starts clamp at 0, order and durations preserved. */
  const shiftAllCues = useCallback((delta: number) => {
    commit((p) => ({
      ...p,
      subtitles: (p.subtitles ?? []).map((c) => {
        const dur = Math.max(0.05, c.endSec - c.startSec);
        const start = Math.max(0, c.startSec + delta);
        return { ...c, startSec: +start.toFixed(3), endSec: +(start + dur).toFixed(3) };
      }),
    }), 'cue-shift-all');
  }, [commit]);

  const applyShiftAll = useCallback(() => {
    const d = parseFloat(shiftSecs);
    if (!Number.isFinite(d) || d === 0) {
      toast({ title: 'Nothing to shift', description: 'Enter a non-zero offset — negative moves cues earlier, positive later.' });
      return;
    }
    shiftAllCues(d);
    toast({ title: 'All cues shifted', description: `Moved by ${d > 0 ? '+' : ''}${d.toFixed(1)} s${d < 0 ? ' — cues clamped at 0 s where needed.' : '.'}` });
  }, [shiftSecs, shiftAllCues, toast]);

  const downloadCueFile = useCallback((ext: 'srt' | 'vtt') => {
    const content = ext === 'srt' ? buildSrt(subtitles) : buildVtt(subtitles);
    const name = `${project.name.replace(/\s+/g, '-') || 'subtitles'}.${ext}`;
    const blob = new Blob([content], { type: ext === 'srt' ? 'application/x-subrip' : 'text/vtt' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast({ title: `Downloaded ${name}`, description: `${subtitles.length} cue${subtitles.length === 1 ? '' : 's'} · ${ext.toUpperCase()} format.` });
  }, [subtitles, project.name, toast]);

  const copyCues = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildSrt(subtitles));
      toast({ title: 'Cues copied', description: `${subtitles.length} cue${subtitles.length === 1 ? '' : 's'} copied as SRT — paste into any editor.` });
    } catch {
      toast({ title: 'Copy failed', description: 'Clipboard access was blocked by the browser.', variant: 'destructive' });
    }
  }, [subtitles, toast]);

  const importSubtitleFile = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const raw = await fetch(url).then((r) => r.text());
      const cues = parseSrt(raw);
      if (!cues.length) {
        toast({ title: 'No cues found', description: `${file.name} contains no usable subtitle timings.`, variant: 'destructive' });
        return;
      }
      commit((p) => ({ ...p, subtitles: cues }), 'subtitles-import');
      setEditingCueIdx(null);
      toast({ title: 'Subtitles imported', description: `${cues.length} cues parsed from ${file.name}.` });
    } catch {
      toast({ title: 'Import failed', description: 'Could not read the subtitle file.', variant: 'destructive' });
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [toast, commit]);

  const parsePastedSubtitles = useCallback(() => {
    const cues = parseSrt(pasteText);
    if (!cues.length) {
      toast({ title: 'No cues found', description: 'The pasted text has no valid `start --> end` timing lines.', variant: 'destructive' });
      return;
    }
    commit((p) => ({ ...p, subtitles: cues }), 'subtitles-import');
    setEditingCueIdx(null);
    setPasteText('');
    setPasteOpen(false);
    toast({ title: 'Subtitles parsed', description: `${cues.length} cues added to the timeline.` });
  }, [pasteText, toast, commit]);

  // ---------- music bed ----------

  const setMusicBedPatch = useCallback((patch: Partial<MusicBedSettings>) => {
    commit((p) => ({ ...p, musicBed: { ...DEFAULT_MUSIC_BED, ...p.musicBed, ...patch } }), `bed:${Object.keys(patch).join('+')}`);
  }, [commit]);

  /** Short queue job: mix the first 10 s of narration + bed (with ducking) and play it. */
  const previewMusicBedMix = useCallback(() => {
    const voice = soundtrack?.buffer;
    const bed = bedAsset?.buffer;
    if (!voice || !bed) return;
    setPlaying(false);
    musicPlayer.stop();
    enqueueJob(
      { type: 'encode', label: 'Preview music-bed mix' },
      async (api) => {
        api.log(`Mixing the first ${Math.min(10, voice.duration).toFixed(1)} s of narration + music bed…`);
        await yieldToUI();
        const vSlice = sliceBuffer(voice, 0, Math.min(10, voice.duration));
        const bSlice = sliceBuffer(bed, 0, Math.min(10, bed.duration));
        const mixed = mixMusicBed(vSlice, bSlice, musicBed);
        api.log(musicBed.duck
          ? musicBed.gainPoints?.length
            ? `Duck envelope from ${musicBed.gainPoints.length} manual gain points (attack ${musicBed.attackMs} ms, release ${musicBed.releaseMs} ms)`
            : `Duck envelope applied — amount ${Math.round(musicBed.duckAmount * 100)}%, attack ${musicBed.attackMs} ms, release ${musicBed.releaseMs} ms`
          : 'Ducking off — bed mixed flat');
        await yieldToUI();
        musicPlayer.start(mixed, 0);
        api.log('Playing preview mix…');
        return { seconds: +mixed.duration.toFixed(2) };
      },
    );
  }, [soundtrack, bedAsset, musicBed]);

  // ---------- named projects (IndexedDB snapshots) ----------

  const saveNamedProject = useCallback(() => {
    const name = saveName.trim() || project.name.trim() || 'Untitled Video';
    const fixedId = project.id && project.id !== VIDEO_PROJECTS_CURRENT_KEY ? project.id : uid('vproj');
    if (fixedId !== project.id || name !== project.name) commit((p) => ({ ...p, id: fixedId, name }), 'project-rename');
    saveNameDirtyRef.current = false;
    void (async () => {
      const now = Date.now();
      const existing = await getProject(fixedId);
      await putProject({
        id: fixedId,
        name,
        updatedAt: now,
        createdAt: existing?.createdAt ?? now,
        project: serializeProject({ ...project, id: fixedId, name }),
      });
      await refreshProjects();
      toast({ title: `Project saved — ${project.clips.length} clips, ${subtitles.length} cues`, description: `“${name}” stored on-device (IndexedDB).` });
    })();
  }, [project, saveName, subtitles.length, toast, refreshProjects, commit]);

  const loadSavedProject = useCallback((rec: StoredVideoProject) => {
    flushCurrentAutosave(project); // non-destructive: current work is autosaved first
    const restored = sanitizeProject(rec.project, project);
    const next: VideoProject = { ...restored, id: rec.id, name: rec.name || restored.name };
    reset(next); // named load = context switch → history RESETS to the loaded baseline (see useProjectHistory)
    setSaveName(next.name);
    saveNameDirtyRef.current = false;
    setEditingCueIdx(null);
    setSelectedClip(null);
    const st = storedProjectStats(rec);
    toast({ title: 'Project loaded', description: `“${next.name}” — ${st.clips} clips, ${st.cues} cues. Your previous timeline was autosaved.` });
  }, [project, flushCurrentAutosave, toast, reset]);

  const duplicateSavedProject = useCallback((rec: StoredVideoProject) => {
    void (async () => {
      const now = Date.now();
      const newId = uid('vproj');
      const copy = sanitizeProject(rec.project, project);
      await putProject({
        id: newId,
        name: `Copy of ${rec.name}`,
        updatedAt: now,
        createdAt: now,
        project: serializeProject({ ...copy, id: newId, name: `Copy of ${rec.name}` }),
      });
      await refreshProjects();
      toast({ title: 'Project duplicated', description: `“Copy of ${rec.name}” added to saved projects.` });
    })();
  }, [project, toast, refreshProjects]);

  const commitRename = useCallback(() => {
    const target = savedProjects.find((r) => r.id === renamingId);
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!target || !name || name === target.name) return;
    void (async () => {
      await putProject({ ...target, name, updatedAt: Date.now(), project: { ...(target.project as Record<string, unknown>), name } });
      if (project.id === target.id) {
        commit((p) => ({ ...p, name }), 'project-rename');
        setSaveName(name);
        saveNameDirtyRef.current = false;
      }
      await refreshProjects();
      toast({ title: 'Project renamed', description: `Now “${name}”.` });
    })();
  }, [savedProjects, renamingId, renameDraft, project.id, toast, refreshProjects, commit]);

  const confirmDeleteProject = useCallback(() => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    void (async () => {
      await deleteProject(target.id);
      await refreshProjects();
      toast({ title: 'Project deleted', description: `“${target.name}” removed from saved projects. The current timeline is untouched.` });
    })();
  }, [deleteTarget, toast, refreshProjects]);

  const exportSavedProjectJson = useCallback((rec: StoredVideoProject) => {
    const safe = (rec.name || 'project').replace(/\s+/g, '-').replace(/[/\\:*?"<>|]/g, '') || 'project';
    const blob = new Blob([JSON.stringify(rec.project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safe}.auravoice-video.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const st = storedProjectStats(rec);
    toast({ title: 'Project exported', description: `${safe}.auravoice-video.json — ${st.clips} clips, ${st.cues} cues.` });
  }, [toast]);

  const importProjectFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      // accept both a raw project and a wrapped { project: … } record/export
      const candidate = parsed && typeof parsed === 'object' && 'project' in (parsed as Record<string, unknown>)
        ? (parsed as Record<string, unknown>).project
        : parsed;
      if (!candidate || typeof candidate !== 'object') throw new Error('not a project');
      const restored = sanitizeProject(candidate, project);
      const next: VideoProject = { ...restored, id: uid('vproj') };
      reset(next); // import = loading a project → history resets to the imported baseline
      setSaveName(next.name);
      saveNameDirtyRef.current = false;
      setEditingCueIdx(null);
      setSelectedClip(null);
      toast({ title: 'Project imported', description: `${file.name} — ${next.clips.length} clips${next.subtitles?.length ? `, ${next.subtitles.length} cues` : ''}. Hit “Save project” to keep a named copy.` });
    } catch {
      toast({ title: 'Import failed', description: 'Not a readable AuraVoice video project JSON.', variant: 'destructive' });
    }
  }, [project, toast, reset]);

  // ---------- duck preview canvas: draw + gain-point editing ----------

  /**
   * Draw the duck preview: cached narration RMS blocks + bed-gain curve via the
   * dsp hop-rate sibling `smoothDuckGains`. When ≥1 manual gain point exists the
   * points are forwarded to the dsp — the exact same envelope definition the
   * export's mixMusicBed uses — so preview and export can never diverge. Points
   * render as violet diamonds (rotated squares, 2 px outline); the selected one
   * gets a focus ring. `sel` is passed in (never read from state) so pointer
   * handlers can render the selection synchronously without waiting for React.
   */
  const drawDuckPreview = useCallback((sel: number | null) => {
    const voice = soundtrack?.buffer;
    const canvas = bedCanvasRef.current;
    if (!voice || !canvas) return;
    if (rmsCacheRef.current?.buffer !== voice) {
      rmsCacheRef.current = { buffer: voice, levels: computeRmsLevels(voice, 100) };
    }
    const levels = rmsCacheRef.current?.levels;
    if (!levels) return;

    // Effective points: stored automation with the in-flight drag overlay
    // substituted (dragRef is canvas-render-only — the project only updates on
    // pointerup). ≥1 point bypasses the sidechain inside smoothDuckGains exactly
    // like computeDuckEnvelope does at export time.
    const live = dragRef.current;
    const pts = live && live.index >= 0 && live.index < gainPoints.length
      ? gainPoints.map((p, i) => (i === live.index ? { t: live.t, depth: live.depth } : p))
      : gainPoints;
    const gains = musicBed.duck
      ? smoothDuckGains(levels, 100, { amount: musicBed.duckAmount, attackMs: musicBed.attackMs, releaseMs: musicBed.releaseMs, gainPoints: pts.length ? pts : undefined })
      : null;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(96, Math.round((canvas.clientWidth || 320) * dpr));
    const h = Math.max(48, Math.round(64 * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const dur = voice.duration;

    // narration RMS blocks (zinc) — anchored to the bottom, RMS scaled ×2.5 for visibility
    const step = Math.max(2, Math.round(3 * dpr));
    const barW = Math.max(1, Math.round(2 * dpr));
    ctx.fillStyle = 'rgba(113, 113, 122, 0.55)'; // zinc-500
    for (let x = 0; x + barW <= w; x += step) {
      const tt = (x / w) * dur;
      const lvl = levels[Math.min(levels.length - 1, Math.floor(tt * 100))] ?? 0;
      const bh = Math.max(dpr, Math.min(1, lvl * 2.5) * h * 0.85);
      ctx.fillRect(x, h - bh, barW, bh);
    }

    // bed gain = volume × duck envelope (emerald curve + soft fill to the bottom)
    const gainAt = (x: number) => {
      const tt = (x / w) * dur;
      const e = gains ? gains[Math.min(gains.length - 1, Math.floor(tt * 100))] : 1;
      return musicBed.volume * (e ?? 1);
    };
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const y = h - Math.min(1, Math.max(0, gainAt(x))) * h;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(16, 185, 129, 0.12)'; // emerald-500 @ 12%
    ctx.fill();
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const y = h - Math.min(1, Math.max(0, gainAt(x))) * h;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#10b981'; // emerald-500
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();

    // dashed ceiling at the plain bed volume (gain without ducking)
    if (musicBed.duck) {
      const cy = h - Math.min(1, Math.max(0, musicBed.volume)) * h;
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ctx.strokeStyle = 'rgba(113, 113, 122, 0.45)';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(w, cy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // gain-point diamonds (violet rotated squares, 2 px outline; ring on selection)
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = (dur > 0 ? Math.min(1, Math.max(0, p.t / dur)) : 0) * w;
      const y = h - Math.min(1, Math.max(0, p.depth)) * h;
      const s = 4.5 * dpr; // half-diagonal
      if (sel === i) {
        ctx.beginPath();
        ctx.arc(x, y, s + 2.5 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(139, 92, 246, 0.55)'; // violet-500 @ 55%
        ctx.lineWidth = 1.5 * dpr;
        ctx.stroke();
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.rect(-s * 0.72, -s * 0.72, s * 1.44, s * 1.44);
      ctx.fillStyle = sel === i ? '#a78bfa' : '#8b5cf6'; // violet-400 / violet-500
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = '#fafafa'; // zinc-50 outline keeps diamonds readable over the curve
      ctx.stroke();
      ctx.restore();
    }
  }, [soundtrack, gainPoints, musicBed.volume, musicBed.duck, musicBed.duckAmount, musicBed.attackMs, musicBed.releaseMs]);

  // Immediate redraw whenever the drawn inputs change (settings, points,
  // selection) plus a 300 ms layout-settle pass. The R8 debounce is dropped as
  // the primary mechanism because the RMS walk is cached per voice buffer and
  // the 100 Hz envelope walk is microseconds — and the point interactions below
  // need synchronous redraws anyway.
  useEffect(() => {
    drawDuckPreview(selectedPoint);
    const t = setTimeout(() => drawDuckPreview(selectedPoint), 300);
    return () => clearTimeout(t);
  }, [drawDuckPreview, selectedPoint]);

  // A selection that no longer exists (undo/redo/remove) is dropped — never act
  // on a stale index.
  useEffect(() => {
    if (selectedPoint != null && selectedPoint >= gainPoints.length) setSelectedPoint(null);
  }, [gainPoints.length, selectedPoint]);

  // CSS-pixel position on the canvas time axis (t seconds / depth 0..1). The
  // axis spans the narration length — the same timeline the envelope (and the
  // export mix) actually runs over — so t clamps to [0, narration duration].
  const bedCanvasPos = useCallback((clientX: number, clientY: number): { t: number; depth: number } | null => {
    const canvas = bedCanvasRef.current;
    const dur = soundtrack?.buffer?.duration ?? 0;
    if (!canvas || !(dur > 0)) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      t: Math.min(dur, Math.max(0, ((clientX - rect.left) / rect.width) * dur)),
      depth: Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height)),
    };
  }, [soundtrack]);

  /** Nearest gain-point diamond within GAIN_POINT_HIT_PX of the pointer, else -1. */
  const hitGainPoint = useCallback((clientX: number, clientY: number): number => {
    const canvas = bedCanvasRef.current;
    const dur = soundtrack?.buffer?.duration ?? 0;
    if (!canvas || !(dur > 0) || !gainPoints.length) return -1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return -1;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best = -1;
    let bestD = GAIN_POINT_HIT_PX * GAIN_POINT_HIT_PX;
    for (let i = 0; i < gainPoints.length; i++) {
      const dx = px - (gainPoints[i].t / dur) * rect.width;
      const dy = py - (1 - gainPoints[i].depth) * rect.height;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }, [soundtrack, gainPoints]);

  /** Insert a point at (t, depth) — sorted by t, capped at MAX_GAIN_POINTS. */
  const addGainPointAt = useCallback((t: number, depth: number) => {
    const np: DuckGainPoint = { t: +t.toFixed(3), depth: +depth.toFixed(3) };
    let rejected = false;
    let insertIdx = -1;
    commit((p) => {
      const mb = p.musicBed ?? DEFAULT_MUSIC_BED;
      const pts = mb.gainPoints ?? NO_GAIN_POINTS;
      if (pts.length >= MAX_GAIN_POINTS) { rejected = true; return p; }
      const next = [...pts, np].sort((a, b) => a.t - b.t);
      insertIdx = next.indexOf(np);
      return { ...p, musicBed: { ...mb, gainPoints: next } };
    }, 'bed:gainpoint-add');
    if (rejected) {
      toast({ title: 'Point limit reached', description: `Duck automation is capped at ${MAX_GAIN_POINTS} points — remove or clear some first.` });
      return;
    }
    setSelectedPoint(insertIdx);
  }, [commit, toast]);

  const removeGainPoint = useCallback((idx: number) => {
    commit((p) => {
      const mb = p.musicBed ?? DEFAULT_MUSIC_BED;
      const pts = mb.gainPoints ?? NO_GAIN_POINTS;
      if (idx < 0 || idx >= pts.length) return p;
      const next = pts.filter((_, i) => i !== idx);
      return { ...p, musicBed: { ...mb, gainPoints: next.length ? next : undefined } };
    }, 'bed:gainpoint-remove');
    setSelectedPoint(null); // indices shift — never keep a stale selection
  }, [commit]);

  const clearGainPoints = useCallback(() => {
    commit((p) => {
      const mb = p.musicBed ?? DEFAULT_MUSIC_BED;
      if (!mb.gainPoints?.length) return p;
      return { ...p, musicBed: { ...mb, gainPoints: undefined } };
    }, 'bed:gainpoint-clear');
    setSelectedPoint(null);
  }, [commit]);

  /** Nudge a point's t/depth with neighbor + duration clamps (arrow keys). */
  const nudgeGainPoint = useCallback((idx: number, dt: number, dd: number) => {
    const dur = soundtrack?.buffer?.duration ?? 0;
    commit((p) => {
      const mb = p.musicBed ?? DEFAULT_MUSIC_BED;
      const pts = mb.gainPoints ?? NO_GAIN_POINTS;
      if (idx < 0 || idx >= pts.length) return p;
      const cur = pts[idx];
      const prev = pts[idx - 1];
      const next = pts[idx + 1];
      let t = cur.t + dt;
      if (prev) t = Math.max(prev.t + 0.01, t);
      if (next) t = Math.min(next.t - 0.01, t);
      if (dur > 0) t = Math.min(dur, Math.max(0, t));
      const rt = +Math.min(1, Math.max(0, t)).toFixed(3);
      const rd = +Math.min(1, Math.max(0, cur.depth + dd)).toFixed(3);
      if (rt === cur.t && rd === cur.depth) return p; // clamped into place — no history noise
      const nextPts = pts.map((pt, i) => (i === idx ? { t: rt, depth: rd } : pt));
      return { ...p, musicBed: { ...mb, gainPoints: nextPts } };
    }, 'bed:gainpoint-nudge'); // same tag → arrow-key bursts coalesce into one undo step
  }, [commit, soundtrack]);

  const onBedCanvasPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!musicBed.duck || dragRef.current || e.button !== 0) return;
    e.preventDefault(); // no text selection / native drag while editing points
    e.currentTarget.focus(); // arrows/Delete act on the focused wrapper
    const hit = hitGainPoint(e.clientX, e.clientY);
    if (hit >= 0) {
      const p = gainPoints[hit];
      setSelectedPoint(hit);
      dragRef.current = { index: hit, t: p.t, depth: p.depth };
      e.currentTarget.setPointerCapture(e.pointerId);
      drawDuckPreview(hit);
      pressedEmptyRef.current = false;
    } else {
      pressedEmptyRef.current = true; // pointerup without a drag adds a point here
    }
  }, [musicBed.duck, gainPoints, hitGainPoint, drawDuckPreview]);

  const onBedCanvasPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const pos = bedCanvasPos(e.clientX, e.clientY);
    if (!pos || drag.index < 0 || drag.index >= gainPoints.length) return;
    const prev = gainPoints[drag.index - 1];
    const next = gainPoints[drag.index + 1];
    let t = pos.t;
    if (prev) t = Math.max(prev.t + 0.01, t);
    if (next) t = Math.min(next.t - 0.01, t);
    if (prev && next && prev.t + 0.01 > next.t - 0.01) t = (prev.t + next.t) / 2; // degenerate window — park at the midpoint, never cross
    dragRef.current = { index: drag.index, t, depth: pos.depth };
    drawDuckPreview(drag.index);
  }, [gainPoints, bedCanvasPos, drawDuckPreview]);

  const onBedCanvasPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const pressedEmpty = pressedEmptyRef.current;
    pressedEmptyRef.current = false;
    if (drag) {
      const t = +drag.t.toFixed(3);
      const depth = +drag.depth.toFixed(3);
      commit((p) => {
        const mb = p.musicBed ?? DEFAULT_MUSIC_BED;
        const pts = mb.gainPoints ?? NO_GAIN_POINTS;
        if (drag.index < 0 || drag.index >= pts.length) return p;
        const cur = pts[drag.index];
        if (cur.t === t && cur.depth === depth) return p; // click-without-drag → no history noise
        const next = pts.map((pt, i) => (i === drag.index ? { t, depth } : pt));
        return { ...p, musicBed: { ...mb, gainPoints: next } };
      }, 'bed:gainpoint-move');
      return;
    }
    if (!pressedEmpty || !musicBed.duck) return;
    const pos = bedCanvasPos(e.clientX, e.clientY);
    if (pos) addGainPointAt(pos.t, pos.depth);
  }, [commit, musicBed.duck, bedCanvasPos, addGainPointAt]);

  const onBedCanvasPointerCancel = useCallback(() => {
    dragRef.current = null;
    pressedEmptyRef.current = false;
  }, []);

  const onBedCanvasDoubleClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!musicBed.duck) return;
    const hit = hitGainPoint(e.clientX, e.clientY);
    if (hit >= 0) removeGainPoint(hit);
  }, [musicBed.duck, hitGainPoint, removeGainPoint]);

  // Keyboard editing on the focused canvas wrapper — deliberately NOT another
  // document-level listener (the ⌘Z one above stays the only one in this file).
  // Selection is clamped so an undo/redo that removed the selected point can
  // never act on a stale index.
  const onBedCanvasKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!musicBed.duck) return;
    const sel = selectedPoint != null && selectedPoint < gainPoints.length ? selectedPoint : null;
    if (sel == null) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeGainPoint(sel);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const stepSec = e.shiftKey ? 0.01 : 0.1;
      nudgeGainPoint(sel, e.key === 'ArrowLeft' ? -stepSec : stepSec, 0);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      nudgeGainPoint(sel, 0, e.key === 'ArrowUp' ? 0.05 : -0.05);
    }
  }, [musicBed.duck, gainPoints.length, selectedPoint, removeGainPoint, nudgeGainPoint]);

  const startExport = useCallback(() => {
    if (exporting) return;
    if (!project.clips.length) {
      toast({ title: 'Timeline empty', description: 'Add clips before exporting.' });
      return;
    }
    const exportLabel = `Export video: ${project.name} (${formatDuration(total)})${subtitles.length ? ' +subs' : ''}${bedAttached ? ' +music bed' : ''}`;
    setExporting(true);
    enqueueJob(
      { type: 'video-export', label: exportLabel },
      async (api) => {
        api.log(`Recording ${project.width}×${project.height} @ ${project.fps}fps · ${exportFormat} · ${exportQuality}`);
        if (subtitles.length) api.log(`Subtitles burned in: ${subtitles.length} cues`);
        if (bedAttached) api.log(`Music bed: baking ${musicBed.duck ? 'ducked' : 'flat'} mix into the soundtrack…`);
        const blob = await exportVideo(project, assets, {
          format: exportFormat,
          quality: exportQuality,
          onProgress: (p) => api.setProgress(p, `Recording ${(p * 100).toFixed(0)}%`),
          aborted: () => api.shouldCancel(),
          onLog: api.log,
        });
        const ext = exportFormat === 'mp4-h264' ? 'mp4' : 'webm';
        addAsset({
          id: uid('asset'),
          name: `${project.name.replace(/\s+/g, '-')}.${ext}`,
          kind: 'video',
          createdAt: Date.now(),
          mimeType: blob.type,
          sizeBytes: blob.size,
          durationSec: total,
          blobUrl: URL.createObjectURL(blob),
          meta: { clips: project.clips.length, format: exportFormat, subtitles: subtitles.length, musicBed: bedAttached },
        });
        api.log(`Export complete: ${(blob.size / 1048576).toFixed(1)} MB`);
        return { bytes: blob.size, durationSec: total };
      },
    );
    const t = setInterval(() => {
      const job = useAppStore.getState().jobs.find((j) => j.label === exportLabel);
      if (job && ['done', 'error', 'cancelled'].includes(job.status)) {
        setExporting(false);
        clearInterval(t);
        if (job.status === 'done') toast({ title: 'Video exported', description: 'Saved to the asset bin.' });
        else if (job.status === 'error') toast({ title: 'Export failed', description: job.error, variant: 'destructive' });
      }
    }, 700);
  }, [exporting, project, assets, total, subtitles, bedAttached, musicBed.duck, exportFormat, exportQuality, addAsset, toast]);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <SectionPanel
          title="Preview"
          description={`${project.width}×${project.height} · ${project.fps} fps · ${formatDuration(total)} total`}
          actions={
            <div className="flex items-center gap-1.5">
              <Select value={String(project.width)} onValueChange={(v) => {
                const presets: Record<string, [number, number]> = { '854': [854, 480], '1280': [1280, 720], '1920': [1920, 1080], '1080v': [1080, 1920] };
                const [w, h] = presets[v] ?? [1280, 720];
                commit((p) => ({ ...p, width: w, height: h }), 'canvas');
              }}>
                <SelectTrigger className="h-8 w-32" aria-label="Resolution"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="854">854×480</SelectItem>
                  <SelectItem value="1280">1280×720</SelectItem>
                  <SelectItem value="1920">1920×1080</SelectItem>
                  <SelectItem value="1080v">1080×1920 (vertical)</SelectItem>
                </SelectContent>
              </Select>
              <Select value={String(project.fps)} onValueChange={(v) => commit((p) => ({ ...p, fps: Number(v) }), 'fps')}>
                <SelectTrigger className="h-8 w-20" aria-label="FPS"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[24, 30, 60].map((f) => <SelectItem key={f} value={String(f)}>{f} fps</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          }
        >
          <div className="overflow-hidden rounded-lg border bg-black">
            <canvas ref={canvasRef} className="mx-auto block h-auto w-full max-w-full" style={{ aspectRatio: `${project.width}/${project.height}` }} aria-label="Video preview" />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button size="icon" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <input
              type="range"
              min={0}
              max={Math.max(0.1, total)}
              step={0.05}
              value={time}
              onChange={(e) => { setTime(Number(e.target.value)); rendererRef.current?.drawFrameAt(Number(e.target.value), assets); }}
              className="flex-1 accent-violet-600"
              aria-label="Timeline position"
            />
            <span className="text-xs tabular-nums text-muted-foreground">{formatDuration(time)} / {formatDuration(total)}</span>
          </div>
          {/* timeline strip */}
          <div className="mt-3 flex h-11 gap-0.5 overflow-hidden rounded-md border bg-muted/40">
            {project.clips.map((c, i) => (
              <button
                key={c.id}
                onClick={() => setSelectedClip(c.id)}
                style={{ flexGrow: Math.max(0.1, c.durationSec) }}
                className={cn(
                  'group relative min-w-8 overflow-hidden rounded-sm border text-[10px] transition-colors',
                  selectedClip === c.id ? 'border-violet-500 bg-violet-500/20' : 'border-border bg-background/60 hover:bg-muted',
                )}
                title={`${c.type} clip · ${c.durationSec}s`}
              >
                <span className="absolute left-1 top-0.5 tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="flex h-full items-end justify-start p-1 text-left leading-tight">
                  {c.overlay?.text?.split('\n')[0]?.slice(0, 18) ?? (c.type === 'text' ? c.text?.split('\n')[0]?.slice(0, 18) : c.type)}
                </span>
              </button>
            ))}
            {project.clips.length === 0 && (
              <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">Timeline empty — add clips</div>
            )}
          </div>
          {/* subtitle cue strip — visual extents only, non-interactive */}
          {subtitles.length > 0 && total > 0 && (
            <div className="subtitle-lane relative mt-1 h-2 overflow-hidden rounded-sm border bg-muted/40" aria-hidden>
              {subtitles.map((c, i) => {
                const left = Math.min(100, Math.max(0, (c.startSec / total) * 100));
                const width = Math.max(0.8, Math.min(100 - left, ((c.endSec - c.startSec) / total) * 100));
                return <div key={i} className="absolute inset-y-0 bg-violet-500/70" style={{ left: `${left}%`, width: `${width}%` }} />;
              })}
            </div>
          )}
        </SectionPanel>

        <SectionPanel
          title={`Clips (${project.clips.length})`}
          description="Click to select. Order and timing update the preview instantly."
          actions={
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => { const c = newClip({ type: 'color', color: PALETTE[Math.floor(Math.random() * PALETTE.length)] }); commit((p) => ({ ...p, clips: [...p.clips, c] }), 'clip-add'); setSelectedClip(c.id); }}>
                <Plus className="mr-1 h-3.5 w-3.5" />Color
              </Button>
              <Button size="sm" variant="outline" onClick={() => { const c = newClip({ type: 'gradient' }); commit((p) => ({ ...p, clips: [...p.clips, c] }), 'clip-add'); setSelectedClip(c.id); }}>
                <Palette className="mr-1 h-3.5 w-3.5" />Gradient
              </Button>
              <Button size="sm" variant="outline" onClick={() => { const c = newClip({ type: 'text', color: '#101014', color2: '#f4f4f5', text: 'Your title here' }); commit((p) => ({ ...p, clips: [...p.clips, c] }), 'clip-add'); setSelectedClip(c.id); }}>
                <Type className="mr-1 h-3.5 w-3.5" />Title card
              </Button>
              <Button size="sm" variant="outline" disabled={!imageAssets.length} onClick={() => { const c = newClip({ type: 'image', assetId: imageAssets[0]?.id }); commit((p) => ({ ...p, clips: [...p.clips, c] }), 'clip-add'); setSelectedClip(c.id); }}>
                <ImageIcon className="mr-1 h-3.5 w-3.5" />Image
              </Button>
              <Button size="sm" variant="outline" onClick={async () => {
                const brief = project.clips.map((c) => c.text).filter(Boolean).join(' ') || project.name;
                if (!brief) { toast({ title: 'No content', description: 'Add clip text or a project name first.', variant: 'destructive' }); return; }
                const plan = await aiPlanVideo(brief, 6);
                if (plan.ok && plan.value) {
                  const newClips = plan.value.clips.map((clip) => newClip({
                    type: 'color',
                    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
                    text: clip.text,
                    durationSec: clip.durationSec,
                    transition: clip.transition as VideoClip['transition'],
                    kenBurns: clip.kenBurns as VideoClip['kenBurns'],
                    filter: clip.filter as VideoClip['filter'],
                  }));
                  commit((p) => ({ ...p, clips: newClips, name: plan.value?.title ?? p.name }), 'ai-plan');
                  toast({ title: 'AI video plan ready', description: `${newClips.length} clips planned.` });
                } else {
                  toast({ title: 'AI plan failed', description: plan.error ?? 'Try again.', variant: 'destructive' });
                }
              }}>
                <Sparkles className="mr-1 h-3.5 w-3.5" />AI plan
              </Button>
            </div>
          }
        >
          <ScrollArea className="max-h-64 pr-3">
            <div className="space-y-2">
              {project.clips.map((c, i) => (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedClip(c.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedClip(c.id); }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors',
                    activeClip?.id === c.id ? 'border-violet-500/60 bg-violet-500/5' : 'hover:bg-muted/40',
                  )}
                >
                  <Badge variant="secondary" className="tabular-nums">{i + 1}</Badge>
                  {c.type === 'image' ? <ImageIcon className="h-4 w-4 text-rose-600" /> : c.type === 'text' ? <Type className="h-4 w-4 text-emerald-600" /> : c.type === 'gradient' ? <Palette className="h-4 w-4 text-amber-600" /> : <Layers className="h-4 w-4 text-zinc-500" />}
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {c.type === 'text' ? c.text?.split('\n')[0] : c.type === 'image' ? assets.find((a) => a.id === c.assetId)?.name ?? 'image' : c.type}
                    {c.overlay?.text && <span className="text-muted-foreground"> · overlay: {c.overlay.text.split('\n')[0].slice(0, 24)}</span>}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{c.durationSec.toFixed(1)}s · {c.transition}</span>
                  <span className="flex shrink-0">
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Move up" onClick={(e) => { e.stopPropagation(); moveClip(c.id, -1); }}><ArrowUp className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Move down" onClick={(e) => { e.stopPropagation(); moveClip(c.id, 1); }}><ArrowDown className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Duplicate" onClick={(e) => { e.stopPropagation(); commit((p) => { const idx = p.clips.findIndex((x) => x.id === c.id); const copy = { ...c, id: uid('clip') }; const clips = [...p.clips]; clips.splice(idx + 1, 0, copy); return { ...p, clips }; }, 'clip-duplicate'); }}><Copy className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Delete clip" onClick={(e) => { e.stopPropagation(); commit((p) => ({ ...p, clips: p.clips.filter((x) => x.id !== c.id) }), 'clip-delete'); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </SectionPanel>
      </div>

      <div className="space-y-4">
        {activeClip && (
          <SectionPanel title="Clip inspector" description="Fine-tune the selected clip.">
            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Duration</Label>
                  <span className="text-xs tabular-nums text-muted-foreground">{activeClip.durationSec.toFixed(1)} s</span>
                </div>
                <Slider value={[activeClip.durationSec]} min={0.5} max={30} step={0.1}
                  onValueChange={([v]) => updateClip(activeClip.id, { durationSec: v })} />
              </div>

              {(activeClip.type === 'color' || activeClip.type === 'gradient' || activeClip.type === 'text') && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Color A</Label>
                    <div className="flex gap-1.5">
                      <input type="color" value={activeClip.color ?? '#111111'} aria-label="Color A"
                        onChange={(e) => updateClip(activeClip.id, { color: e.target.value })}
                        className="h-8 w-10 cursor-pointer rounded border bg-transparent" />
                      <Input value={activeClip.color ?? ''} onChange={(e) => updateClip(activeClip.id, { color: e.target.value })} className="h-8 text-xs" />
                    </div>
                  </div>
                  {(activeClip.type === 'gradient' || activeClip.type === 'text') && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">{activeClip.type === 'gradient' ? 'Color B' : 'Text color'}</Label>
                      <div className="flex gap-1.5">
                        <input type="color" value={activeClip.color2 ?? '#ffffff'} aria-label="Color B"
                          onChange={(e) => updateClip(activeClip.id, { color2: e.target.value })}
                          className="h-8 w-10 cursor-pointer rounded border bg-transparent" />
                        <Input value={activeClip.color2 ?? ''} onChange={(e) => updateClip(activeClip.id, { color2: e.target.value })} className="h-8 text-xs" />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeClip.type === 'text' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Title text</Label>
                  <textarea
                    value={activeClip.text ?? ''}
                    onChange={(e) => updateClip(activeClip.id, { text: e.target.value })}
                    className="min-h-16 w-full rounded-md border bg-transparent p-2 text-sm"
                    aria-label="Title text"
                  />
                </div>
              )}

              {activeClip.type === 'image' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Image asset</Label>
                  <Select value={activeClip.assetId ?? 'none'} onValueChange={(v) => updateClip(activeClip.id, { assetId: v === 'none' ? undefined : v })}>
                    <SelectTrigger aria-label="Image"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {imageAssets.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Transition in</Label>
                  <Select value={activeClip.transition} onValueChange={(v) => updateClip(activeClip.id, { transition: v as VideoClip['transition'] })}>
                    <SelectTrigger aria-label="Transition"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['none', 'fade', 'slide', 'wipe'].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Motion (Ken Burns)</Label>
                  <Select value={activeClip.kenBurns} onValueChange={(v) => updateClip(activeClip.id, { kenBurns: v as VideoClip['kenBurns'] })}>
                    <SelectTrigger aria-label="Motion"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right'].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Color filter</Label>
                <Select value={activeClip.filter} onValueChange={(v) => updateClip(activeClip.id, { filter: v as VideoClip['filter'] })}>
                  <SelectTrigger aria-label="Filter"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['none', 'grayscale', 'sepia', 'vintage', 'cool', 'warm'].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs flex items-center gap-1.5"><Type className="h-3.5 w-3.5" />Text overlay</Label>
                  <Button size="sm" variant="ghost" className="h-7 px-2"
                    onClick={() => updateClip(activeClip.id, { overlay: activeClip.overlay ? undefined : { text: 'Caption text', size: 6, color: '#f4f4f5', position: 'bottom', shadow: true } })}>
                    {activeClip.overlay ? 'Remove' : 'Add'}
                  </Button>
                </div>
                {activeClip.overlay && (
                  <div className="space-y-2.5 rounded-lg border p-2.5">
                    <Input value={activeClip.overlay.text} onChange={(e) => updateClip(activeClip.id, { overlay: { ...activeClip.overlay!, text: e.target.value } })} className="h-8 text-xs" placeholder="Overlay text" />
                    <div className="grid grid-cols-2 gap-2">
                      <Select value={activeClip.overlay.position} onValueChange={(v) => updateClip(activeClip.id, { overlay: { ...activeClip.overlay!, position: v as 'top' | 'center' | 'bottom' } })}>
                        <SelectTrigger className="h-8" aria-label="Position"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {['top', 'center', 'bottom'].map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <div className="flex items-center gap-2">
                        <input type="color" value={activeClip.overlay.color} aria-label="Overlay color"
                          onChange={(e) => updateClip(activeClip.id, { overlay: { ...activeClip.overlay!, color: e.target.value } })}
                          className="h-8 w-9 cursor-pointer rounded border bg-transparent" />
                        <span className="text-[11px] text-muted-foreground">size {activeClip.overlay.size}</span>
                      </div>
                    </div>
                    <Slider value={[activeClip.overlay.size]} min={3} max={14} step={0.5}
                      onValueChange={([v]) => updateClip(activeClip.id, { overlay: { ...activeClip.overlay!, size: v } })} />
                  </div>
                )}
              </div>
            </div>
          </SectionPanel>
        )}

        <SectionPanel title="Soundtrack" description="Pick any audio from the asset bin (TTS renders, conversions).">
          <div className="space-y-2">
            <Select value={project.soundtrackAssetId ?? 'none'} onValueChange={(v) => commit((p) => ({ ...p, soundtrackAssetId: v === 'none' ? undefined : v }), 'soundtrack')}>
              <SelectTrigger aria-label="Soundtrack"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No soundtrack</SelectItem>
                {audioAssets.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.name} · {formatDuration(a.durationSec ?? 0)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={fitToSoundtrack} disabled={!soundtrack}>
                <Wand2 className="mr-1.5 h-3.5 w-3.5" />Fit clips to audio
              </Button>
            </div>
            {!audioAssets.length && (
              <div className="flex items-center gap-1.5 rounded-md border border-dashed p-2.5 text-[11px] text-muted-foreground">
                <Music className="h-3.5 w-3.5 shrink-0" />
                Render audio in TTS Studio or File Studio first — it will appear here.
              </div>
            )}
          </div>
        </SectionPanel>

        <SectionPanel
          title={`Subtitles (${subtitles.length})`}
          description="Timed cues burned into the preview and every export."
        >
          <Collapsible open={pasteOpen} onOpenChange={setPasteOpen}>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={() => subFileRef.current?.click()}>
                <FileText className="mr-1.5 h-3.5 w-3.5" />Import .srt/.vtt
              </Button>
              <CollapsibleTrigger asChild>
                <Button size="sm" variant="outline" aria-expanded={pasteOpen}>
                  <ClipboardPaste className="mr-1.5 h-3.5 w-3.5" />Paste subtitles
                </Button>
              </CollapsibleTrigger>
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" variant="outline" onClick={async () => {
                  const scriptText = project.clips.map((c) => c.text).filter(Boolean).join(' ') || project.name;
                  if (!scriptText) { toast({ title: 'No content', description: 'Add clip text or a project name first.', variant: 'destructive' }); return; }
                  const caps = await aiWriteCaptions(scriptText, 8);
                  if (caps.ok && caps.value) {
                    const cues: SubtitleCue[] = caps.value.map((text, i) => ({
                      startSec: i * 4, endSec: i * 4 + 3.5, text,
                    }));
                    commit((p) => ({ ...p, subtitles: cues }), 'ai-captions');
                    toast({ title: 'AI captions ready', description: `${cues.length} captions written.` });
                  } else {
                    toast({ title: 'AI captions failed', description: caps.error ?? 'Try again.', variant: 'destructive' });
                  }
                }}>
                  <Sparkles className="mr-1 h-3.5 w-3.5" />AI captions
                </Button>
                <Button size="sm" variant="outline" onClick={addCueAtPlayhead}>
                  <Plus className="mr-1 h-3.5 w-3.5" />Add cue at playhead
                </Button>
                <Button size="sm" variant="ghost" onClick={clearSubtitles} disabled={!subtitles.length}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" />Clear all
                </Button>
              </div>
            </div>
            <input
              ref={subFileRef}
              type="file"
              accept=".srt,.vtt,text/plain"
              className="hidden"
              aria-label="Import subtitle file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importSubtitleFile(f);
                e.target.value = '';
              }}
            />
            <CollapsibleContent>
              <div className="mt-2 space-y-1.5 rounded-lg border border-dashed p-2.5">
                <Textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={'1\n00:00:01,000 --> 00:00:03,000\nHello world\n\n2\n00:00:04,000 --> 00:00:06,500\nSecond cue'}
                  className="min-h-24 font-mono text-xs"
                  aria-label="Subtitle text to parse"
                />
                <div className="flex gap-1.5">
                  <Button size="sm" onClick={parsePastedSubtitles} disabled={!pasteText.trim()}>
                    <ClipboardPaste className="mr-1.5 h-3.5 w-3.5" />Parse text
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setPasteText(''); setPasteOpen(false); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {subtitles.length > 0 ? (
            <>
              <datalist id="video-speaker-options">
                {knownSpeakers.map((s) => <option key={s} value={s} />)}
              </datalist>
              <ScrollArea className="mt-2.5 max-h-64 pr-3">
                <div className="space-y-2">
                  {subtitles.map((c, i) => (
                    <div
                      key={i}
                      className={cn(
                        'cue-row flex items-start gap-2 rounded-lg border p-2.5 transition-colors',
                        editingCueIdx === i ? 'border-violet-500/60 bg-violet-500/5' : 'hover:bg-muted/40',
                      )}
                    >
                      <Badge variant="secondary" className="mt-0.5 shrink-0 tabular-nums">{i + 1}</Badge>
                      <span className="mt-0.5 w-24 shrink-0 text-[10px] leading-snug tabular-nums text-muted-foreground">
                        {formatDuration(c.startSec)}–{formatDuration(c.endSec)}
                      </span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-start gap-1.5">
                          {c.speaker ? (
                            <span
                              className={cn('speaker-chip mt-0.5 inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-medium leading-4', speakerChipClass(c.speaker))}
                              title={`Speaker: ${c.speaker}`}
                            >
                              {c.speaker}
                            </span>
                          ) : null}
                          {editingCueIdx === i ? (
                            <Textarea
                              autoFocus
                              value={c.text}
                              onChange={(e) => updateCue(i, { text: e.target.value })}
                              onBlur={() => setEditingCueIdx(null)}
                              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setEditingCueIdx(null); } }}
                              className="min-h-10 min-w-0 flex-1 text-xs"
                              aria-label={`Edit cue ${i + 1} text`}
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => setEditingCueIdx(i)}
                              title="Click to edit"
                              className="min-w-0 flex-1 text-left text-sm leading-snug hover:underline hover:underline-offset-2"
                            >
                              {c.text || <span className="italic text-muted-foreground">empty — click to type</span>}
                            </button>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Input
                            value={c.speaker ?? ''}
                            onChange={(e) => updateCue(i, { speaker: e.target.value.trim() ? e.target.value : undefined })}
                            list="video-speaker-options"
                            placeholder="Speaker"
                            className="h-6 w-20 px-1.5 text-[10px]"
                            aria-label={`Speaker for cue ${i + 1} (empty = none)`}
                          />
                          <span className="text-[10px] text-muted-foreground">speaker · empty = none</span>
                        </div>
                      </div>
                      <span className="cue-row-actions flex shrink-0 items-center gap-0.5">
                        <Button size="icon" variant="ghost" className="h-6 w-6 text-[10px] tabular-nums" aria-label={`Move cue ${i + 1} earlier by 0.5 seconds`} title="−0.5 s" onClick={() => nudgeCue(i, -0.5)}>−.5</Button>
                        <Button size="icon" variant="ghost" className="h-6 w-6 text-[10px] tabular-nums" aria-label={`Move cue ${i + 1} earlier by 0.1 seconds`} title="−0.1 s" onClick={() => nudgeCue(i, -0.1)}>−.1</Button>
                        <Button size="icon" variant="ghost" className="h-6 w-6 text-[10px] tabular-nums" aria-label={`Move cue ${i + 1} later by 0.1 seconds`} title="+0.1 s" onClick={() => nudgeCue(i, 0.1)}>+.1</Button>
                        <Button size="icon" variant="ghost" className="h-6 w-6 text-[10px] tabular-nums" aria-label={`Move cue ${i + 1} later by 0.5 seconds`} title="+0.5 s" onClick={() => nudgeCue(i, 0.5)}>+.5</Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Delete cue ${i + 1}`} title="Delete cue" onClick={() => deleteCue(i)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="mt-2.5 flex items-center gap-1.5 rounded-md border border-dashed p-2.5 text-[11px] text-muted-foreground">
              <Captions className="h-3.5 w-3.5 shrink-0" />
              No cues yet — import an .srt/.vtt, paste subtitle text, or add a cue at the playhead. OCR Lab can send timed cues here too.
            </div>
          )}

          {subtitles.length > 0 && (
            <div className="mt-2.5 flex items-center gap-2">
              <Label className="shrink-0 text-xs" htmlFor="shift-all-secs">Shift all</Label>
              <Input
                id="shift-all-secs"
                type="number"
                step={0.1}
                value={shiftSecs}
                placeholder="0.0"
                onChange={(e) => setShiftSecs(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applyShiftAll(); }}
                className="h-7 w-20 text-xs tabular-nums"
                aria-label="Shift all cues by seconds (negative or positive)"
              />
              <span className="text-[11px] text-muted-foreground">seconds · −/+ moves earlier/later</span>
              <Button size="sm" variant="outline" className="ml-auto h-7" onClick={applyShiftAll}>
                <Wand2 className="mr-1 h-3.5 w-3.5" />Apply
              </Button>
            </div>
          )}

          <Separator className="my-3" />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Export</Label>
              <span className="text-[11px] text-muted-foreground">round-trips with the importer</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button size="sm" variant="outline" disabled={!subtitles.length} onClick={() => downloadCueFile('srt')}>
                      <Download className="mr-1.5 h-3.5 w-3.5" />Download .srt
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{subtitles.length ? 'Save the cue list as an SRT file' : 'No cues yet — add or import cues first'}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button size="sm" variant="outline" disabled={!subtitles.length} onClick={() => downloadCueFile('vtt')}>
                      <Download className="mr-1.5 h-3.5 w-3.5" />Download .vtt
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{subtitles.length ? 'Save the cue list as a WebVTT file' : 'No cues yet — add or import cues first'}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button size="sm" variant="outline" disabled={!subtitles.length} onClick={() => void copyCues()}>
                      <Copy className="mr-1.5 h-3.5 w-3.5" />Copy cues
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{subtitles.length ? 'Copy all cues to the clipboard (SRT format)' : 'No cues yet — add or import cues first'}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          <Separator className="my-3" />

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Style</Label>
              <span className="text-[11px] text-muted-foreground">burned into preview &amp; export</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Font size ({subtitleStyle.fontSize})</Label>
                <Slider
                  value={[subtitleStyle.fontSize]}
                  min={2}
                  max={12}
                  step={0.5}
                  onValueChange={([v]) => setSubtitleStylePatch({ fontSize: v })}
                  aria-label="Subtitle font size"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Color</Label>
                <div className="flex gap-1.5">
                  <input
                    type="color"
                    value={subtitleStyle.color}
                    aria-label="Subtitle color"
                    onChange={(e) => setSubtitleStylePatch({ color: e.target.value })}
                    className="h-8 w-10 cursor-pointer rounded border bg-transparent"
                  />
                  <Input
                    value={subtitleStyle.color}
                    onChange={(e) => setSubtitleStylePatch({ color: e.target.value })}
                    className="h-8 min-w-0 flex-1 text-xs"
                  />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Position</Label>
                <Select value={subtitleStyle.position} onValueChange={(v) => setSubtitleStylePatch({ position: v as SubtitleStyle['position'] })}>
                  <SelectTrigger className="h-8" aria-label="Subtitle position"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(['top', 'center', 'bottom'] as const).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col justify-center gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs">Background</Label>
                  <Switch checked={subtitleStyle.background} onCheckedChange={(v) => setSubtitleStylePatch({ background: v })} aria-label="Subtitle background" />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs">Outline</Label>
                  <Switch checked={subtitleStyle.outline} onCheckedChange={(v) => setSubtitleStylePatch({ outline: v })} aria-label="Subtitle outline" />
                </div>
                {subtitles.length > 0 && (
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs">Speaker names</Label>
                    <Switch
                      checked={showSpeakerNames}
                      onCheckedChange={(v) => setSubtitleStylePatch({ showSpeaker: v })}
                      aria-label="Show speaker names in subtitles"
                    />
                  </div>
                )}
              </div>
            </div>
            {subtitles.some((c) => Boolean(c.speaker?.trim())) && (
              <p className="text-[11px] text-muted-foreground">
                {showSpeakerNames ? 'Burns “Name: text” into exports' : 'Speaker names are hidden'} — per-cue tags live in the cue list above.
              </p>
            )}
          </div>
        </SectionPanel>

        <SectionPanel
          title={`Projects (${savedProjects.length})`}
          description="Named snapshots on-device — the working timeline autosaves as you edit."
        >
          <div className="space-y-2.5">
            <div className="undo-pair flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button size="icon" variant="outline" className="h-7 w-7 shrink-0" aria-label="Undo last project change" onClick={undo} disabled={!canUndo}>
                      <Undo2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{canUndo ? 'Undo (⌘Z)' : 'Nothing to undo'}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button size="icon" variant="outline" className="h-7 w-7 shrink-0" aria-label="Redo last undone change" onClick={redo} disabled={!canRedo}>
                      <Redo2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{canRedo ? 'Redo (⇧⌘Z)' : 'Nothing to redo'}</TooltipContent>
              </Tooltip>
              <span className="history-step hidden min-[420px]:inline self-center whitespace-nowrap text-[10px] tabular-nums text-muted-foreground" title="Undo history position">
                {historyStep}/{historyDepth}
              </span>
              <Input
                value={saveName}
                onChange={(e) => { setSaveName(e.target.value); saveNameDirtyRef.current = true; }}
                onKeyDown={(e) => { if (e.key === 'Enter') saveNamedProject(); }}
                placeholder="Project name"
                className="h-8 min-w-0 flex-1 text-xs"
                aria-label="Project name for saving"
              />
              <Button size="sm" variant="outline" className="h-8 shrink-0" onClick={saveNamedProject}>
                <Save className="mr-1 h-3.5 w-3.5" />Save project
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={() => projFileRef.current?.click()}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />Import JSON
              </Button>
              <input
                ref={projFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                aria-label="Import project JSON"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importProjectFile(f);
                  e.target.value = '';
                }}
              />
              <span className="text-[11px] text-muted-foreground">.auravoice-video.json · round-trips with Export</span>
            </div>

            {savedProjects.length > 0 ? (
              <ScrollArea className="max-h-64 pr-3">
                <div className="space-y-2">
                  {savedProjects.map((rec) => {
                    const st = storedProjectStats(rec);
                    return (
                      <motion.div
                        key={rec.id}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.15, ease: 'easeOut' }}
                        className={cn('rounded-lg border p-2.5', rec.id === project.id ? 'project-row-loaded border-violet-500/60 bg-violet-500/5' : 'hover:bg-muted/40')}
                      >
                        {renamingId === rec.id ? (
                          <div className="flex items-center gap-1.5">
                            <Input
                              autoFocus
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename();
                                if (e.key === 'Escape') setRenamingId(null);
                              }}
                              className="h-7 text-xs"
                              aria-label={`Rename project ${rec.name}`}
                            />
                            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label="Confirm rename" onClick={commitRename}><Check className="h-3.5 w-3.5" /></Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label="Cancel rename" onClick={() => setRenamingId(null)}><X className="h-3.5 w-3.5" /></Button>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={rec.name}>{rec.name}</span>
                              {rec.id === project.id && <Badge variant="outline" className="shrink-0 text-[10px]">loaded</Badge>}
                              <span className="flex shrink-0 items-center">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Load project ${rec.name}`} onClick={() => loadSavedProject(rec)}>
                                      <FolderOpen className="h-3.5 w-3.5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Load into the editor — current work autosaves first</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Rename project ${rec.name}`} onClick={() => { setRenamingId(rec.id); setRenameDraft(rec.name); }}>
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Rename</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Duplicate project ${rec.name}`} onClick={() => duplicateSavedProject(rec)}>
                                      <Copy className="h-3.5 w-3.5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Duplicate as “Copy of {rec.name}”</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Export project ${rec.name} as JSON`} onClick={() => exportSavedProjectJson(rec)}>
                                      <FileJson className="h-3.5 w-3.5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Export .auravoice-video.json</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button size="icon" variant="ghost" className="h-7 w-7 text-rose-600 hover:text-rose-700" aria-label={`Delete project ${rec.name}`} onClick={() => setDeleteTarget(rec)}>
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Delete — asks to confirm</TooltipContent>
                                </Tooltip>
                              </span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              <span className="tabular-nums">{st.clips} clip{st.clips === 1 ? '' : 's'} · {formatDuration(st.duration)} · {st.cues} cue{st.cues === 1 ? '' : 's'}</span> · {timeAgo(rec.updatedAt)}
                            </div>
                          </>
                        )}
                      </motion.div>
                    );
                  })}
                </div>
              </ScrollArea>
            ) : (
              <div className="flex items-center gap-1.5 rounded-md border border-dashed p-2.5 text-[11px] text-muted-foreground">
                <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                No saved projects yet — name this timeline and hit “Save project”.
              </div>
            )}

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The working timeline autosaves to IndexedDB continuously; “Save project” keeps a named copy you can load, rename, duplicate, export as JSON or delete. Everything stays on-device.
            </p>
          </div>

          <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete saved project?</AlertDialogTitle>
                <AlertDialogDescription>
                  “{deleteTarget?.name}” will be removed from saved projects on this device. Your current editor timeline is not affected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={confirmDeleteProject}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </SectionPanel>

        <SectionPanel title="Music bed" description="Second audio layer, auto-ducked under the narration soundtrack.">
          <div className="space-y-2.5">
            <Select value={project.musicBedAssetId ?? 'none'} onValueChange={(v) => commit((p) => ({ ...p, musicBedAssetId: v === 'none' ? undefined : v }), 'bed-attach')}>
              <SelectTrigger aria-label="Music bed"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No music bed</SelectItem>
                {audioAssets.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.name} · {formatDuration(a.durationSec ?? 0)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!audioAssets.length && (
              <div className="flex items-center gap-1.5 rounded-md border border-dashed p-2.5 text-[11px] text-muted-foreground">
                <Music4 className="h-3.5 w-3.5 shrink-0" />
                Attach a track from the Asset Bin — render or import audio in TTS / File Studio and it appears here.
              </div>
            )}

            {bedAsset && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="space-y-3 rounded-lg border p-2.5"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Volume</Label>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{Math.round(musicBed.volume * 100)}%</span>
                  </div>
                  <Slider value={[musicBed.volume]} min={0} max={1} step={0.01} onValueChange={([v]) => setMusicBedPatch({ volume: v })} aria-label="Music bed volume" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs">Loop</Label>
                    <Switch checked={musicBed.loop} onCheckedChange={(v) => setMusicBedPatch({ loop: v })} aria-label="Loop music bed" />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs">Duck</Label>
                    <Switch checked={musicBed.duck} onCheckedChange={(v) => setMusicBedPatch({ duck: v })} aria-label="Auto-duck music bed" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Duck amount</Label>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{Math.round(musicBed.duckAmount * 100)}%</span>
                  </div>
                  <Slider value={[musicBed.duckAmount]} min={0} max={1} step={0.01} disabled={!musicBed.duck} onValueChange={([v]) => setMusicBedPatch({ duckAmount: v })} aria-label="Duck amount" />
                  {gainPoints.length > 0 && (
                    <p className={cn('text-[11px]', musicBed.duck ? 'text-amber-600' : 'text-muted-foreground')}>
                      Overridden by {gainPoints.length} manual point{gainPoints.length === 1 ? '' : 's'}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Attack</Label>
                      <span className="text-[11px] tabular-nums text-muted-foreground">{musicBed.attackMs} ms</span>
                    </div>
                    <Slider value={[musicBed.attackMs]} min={5} max={200} step={5} disabled={!musicBed.duck} onValueChange={([v]) => setMusicBedPatch({ attackMs: v })} aria-label="Duck attack" />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Release</Label>
                      <span className="text-[11px] tabular-nums text-muted-foreground">{musicBed.releaseMs} ms</span>
                    </div>
                    <Slider value={[musicBed.releaseMs]} min={50} max={2000} step={10} disabled={!musicBed.duck} onValueChange={([v]) => setMusicBedPatch({ releaseMs: v })} aria-label="Duck release" />
                  </div>
                </div>
              </motion.div>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5 text-xs"><AudioLines className="h-3.5 w-3.5" />Duck preview</Label>
                <span className="text-[11px] text-muted-foreground">narration + bed gain</span>
              </div>
              {soundtrack?.buffer ? (
                <div
                  tabIndex={0}
                  onPointerDown={onBedCanvasPointerDown}
                  onPointerMove={onBedCanvasPointerMove}
                  onPointerUp={onBedCanvasPointerUp}
                  onPointerCancel={onBedCanvasPointerCancel}
                  onDoubleClick={onBedCanvasDoubleClick}
                  onKeyDown={onBedCanvasKeyDown}
                  className={cn(
                    'rounded-lg outline-none select-none touch-none focus-visible:ring-2 focus-visible:ring-violet-500/60',
                    musicBed.duck ? 'cursor-crosshair' : 'cursor-not-allowed opacity-60',
                  )}
                  title={musicBed.duck ? undefined : 'Enable duck to edit points'}
                  aria-label="Duck gain-point editor: click to add, drag to move, double-click to delete; arrow keys nudge the selected point, Delete removes it"
                >
                  <canvas
                    ref={bedCanvasRef}
                    data-editable={musicBed.duck || undefined}
                    className="duck-preview-canvas h-16 w-full border"
                    aria-label="Music bed duck envelope preview over the narration waveform"
                  />
                </div>
              ) : (
                <div className="flex items-center gap-1.5 rounded-md border border-dashed p-2.5 text-[11px] text-muted-foreground">
                  <Volume2 className="h-3.5 w-3.5 shrink-0" />
                  Pick a narration soundtrack to preview the duck envelope over it.
                </div>
              )}
              {soundtrack?.buffer && (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-zinc-500/60 align-middle" aria-hidden />narration RMS ·
                    <span className="mx-1 inline-block h-2 w-2 rounded-sm bg-emerald-500 align-middle" aria-hidden />bed gain (volume × duck envelope) ·
                    <span className="mx-1 inline-block h-2 w-2 rotate-45 rounded-[1px] bg-violet-500 align-middle" aria-hidden />gain points
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="text-[10px] text-muted-foreground">
                      {musicBed.duck
                        ? 'Click: add · Drag: move · Double-click: delete · Del/arrows on selected'
                        : 'Enable duck to edit points'}
                    </p>
                    <div className="ml-auto flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px] tabular-nums">{gainPoints.length} pts</Badge>
                      {gainPoints.length > 0 && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={clearGainPoints}>
                          <Trash2 className="mr-1 h-3 w-3" />Clear points
                        </Button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button size="sm" variant="outline" onClick={previewMusicBedMix} disabled={!bedAsset || !soundtrack}>
                    <Play className="mr-1.5 h-3.5 w-3.5" />Preview mix (10 s)
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {bedAsset && soundtrack ? 'Mix the first 10 s of narration + bed and play it' : 'Needs both a music bed and a narration soundtrack'}
              </TooltipContent>
            </Tooltip>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The bed is baked into every export automatically (the job label gains “+music bed”) — narration stays clear while the music dips under speech.
            </p>
          </div>
        </SectionPanel>

        <SectionPanel title="Export" description="Recorded in real time via MediaRecorder.">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1.5"><Film className="h-3.5 w-3.5" />Format</Label>
              <Select value={exportFormat} onValueChange={(v) => setExportFormat(v as typeof exportFormat)}>
                <SelectTrigger aria-label="Export format"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {formats.map((f) => (
                    <SelectItem key={f.id} value={f.id} disabled={!f.supported}>
                      {f.label} {f.supported ? '' : '(not supported here)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Quality</Label>
              <Select value={exportQuality} onValueChange={(v) => setExportQuality(v as typeof exportQuality)}>
                <SelectTrigger aria-label="Quality"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low (1.2 Mbps)</SelectItem>
                  <SelectItem value="medium">Medium (4 Mbps)</SelectItem>
                  <SelectItem value="high">High (10 Mbps)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
              <span>Export preset: {tuned.videoExportPreset}</span>
              <span>{formatDuration(total)} · {project.clips.length} clips</span>
            </div>
            <Button className="w-full" onClick={startExport} disabled={exporting}>
              <Film className="mr-1.5 h-4 w-4" />
              {exporting ? 'Exporting…' : 'Export video'}
            </Button>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Export renders in real time (a {formatDuration(total)} video takes ~{formatDuration(total)} to record).
              The result lands in the asset bin and can be downloaded. Video export engine: canvas + MediaRecorder,
              100% local.
            </p>
          </div>
        </SectionPanel>
      </div>
    </div>
  );
}
