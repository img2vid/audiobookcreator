'use client';

/**
 * Transcribe Studio — live microphone transcription (module 13).
 *
 * Capture the mic with MediaRecorder while webkitSpeechRecognition turns the
 * same session into timestamped text segments in real time. Segments are
 * editable, seek the recorded playback, and export as plain text / SRT / VTT
 * — all generated on-device. Segments can carry speaker tags that fold into
 * subtitle exports and hand off to the Video Editor (subtitle cues) and the
 * Audiobook Studio (auto-split chapters). Browsers without the Web Speech API
 * (Firefox, Safari) fall back to MANUAL MODE: type a line and stamp it at the
 * playhead, so the module works everywhere. Drafts autosave to IndexedDB;
 * nothing ever uploads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useAppStore } from '@/lib/stores/app-store';
import { enqueueJob } from '@/lib/queue';
import { useMounted } from '@/hooks/use-mounted';
import {
  SPEECH_LANGUAGES,
  createLiveRecognizer,
  describeSuggestion,
  speechRecognitionAvailable,
  suggestSpeakers,
  type LiveRecognizer,
  type SpeakerSuggestion,
} from '@/lib/engines/recognize';
import {
  saveTranscribeDraft,
  loadTranscribeDraft,
  clearTranscribeDraft,
  transcribeDraftHasContent,
} from '@/lib/engines/transcribe-db';
import { aiCleanTranscript, aiTranscriptToChapters } from '@/lib/engines/ai-services';
import { uid, yieldToUI } from '@/lib/utils/async';
import type { AssetItem, SubtitleCue, TranscriptChapter } from '@/lib/types';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/utils/format';
import { speakerChipClass } from '@/lib/utils/speaker-color';
import {
  AudioLines, BookOpen, Captions, Check, CheckCircle2, Clapperboard, CloudUpload, Copy, Database, FileText, Info, Mic, MicOff, Pause,
  Play, Send, Sparkles, Square, Stamp, Timer, Trash2, Users, Wand2, X,
} from 'lucide-react';

// ---------- constants ----------

/** Segment count above which export formatting runs as a cancellable queue job. */
const LARGE_EXPORT_SEGMENTS = 200;
/** Large exports yield to the UI every N segments. */
const EXPORT_YIELD_EVERY = 50;
const DRAFT_DEBOUNCE_MS = 800;
/** Manual "Stamp at playhead" gives each line a 2 s extent. */
const MANUAL_STAMP_SEC = 2;
/** "Suggest speakers" needs a few rows to say anything meaningful (R11-b). */
const SUGGEST_MIN_SEGMENTS = 3;
/** Suggestions at/above this confidence count as high-confidence (and pass "Apply high-confidence only"). */
const SUGGEST_HIGH_CONFIDENCE = 0.6;

// ---------- local types ----------

interface TranscriptSegment {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  confidence: number; // 0..1 (0 = unknown — many engines never report it)
  speaker?: string; // optional attribution — empty/missing = unassigned
}

type RecState = 'idle' | 'recording' | 'paused';
type ExportFmt = 'txt' | 'srt' | 'vtt';

// ---------- pure helpers (module-level, SSR-safe) ----------

/** mm:ss.d timestamp chip (h:mm:ss.d past one hour). */
function formatChip(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0';
  const t = Math.floor(sec * 10) / 10;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const d = Math.floor((t % 1) * 10);
  const core = `${m}:${String(s).padStart(2, '0')}.${d}`;
  return h > 0 ? `${h}:${core.padStart(7, '0')}` : core;
}

/** SRT timecode — HH:MM:SS,mmm */
function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}

/** WebVTT timecode — HH:MM:SS.mmm */
function vttTime(sec: number): string {
  return srtTime(sec).replace(',', '.');
}

/**
 * Plain-text transcript. With timestamps: one "HH:MM:SS,mmm text" line per
 * segment. Without: one paragraph per segment.
 */
function buildPlainText(segments: TranscriptSegment[], withTimestamps: boolean): string {
  const lines = segments
    .map((s) => (withTimestamps ? `${srtTime(s.startSec)} ${s.text}` : s.text))
    .filter((l) => l.trim().length > 0);
  return lines.join(withTimestamps ? '\n' : '\n\n');
}

/**
 * Fold "Name: " into a cue/line when the export includes speaker names and
 * the segment actually carries one (trimmed — exports get clean text).
 */
function withSpeakerPrefix(text: string, speaker: string | undefined, enabled: boolean): string {
  const name = typeof speaker === 'string' ? speaker.trim() : '';
  return enabled && name ? `${name}: ${text}` : text;
}

function buildSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${srtTime(s.startSec)} --> ${srtTime(s.endSec)}\n${s.text}\n`)
    .join('\n');
}

function buildVtt(segments: TranscriptSegment[]): string {
  const body = segments
    .map((s) => `${vttTime(s.startSec)} --> ${vttTime(s.endSec)}\n${s.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/**
 * Build an export with progress + yielding for LARGE transcripts. `sink` is
 * the queue-job api — pass undefined for small inline exports.
 */
async function buildExportText(
  fmt: ExportFmt,
  segments: TranscriptSegment[],
  withTimestamps: boolean,
  withSpeakers: boolean,
  sink?: { setProgress: (p: number, msg?: string) => void; waitWhilePaused: () => Promise<void>; shouldCancel: () => boolean },
): Promise<string | null> {
  const out: string[] = [];
  if (fmt === 'vtt') out.push('WEBVTT\n');
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (fmt === 'txt') out.push(withTimestamps ? `${srtTime(s.startSec)} ${s.text}` : s.text);
    else if (fmt === 'srt') out.push(`${i + 1}\n${srtTime(s.startSec)} --> ${srtTime(s.endSec)}\n${withSpeakerPrefix(s.text, s.speaker, withSpeakers)}\n`);
    else out.push(`${vttTime(s.startSec)} --> ${vttTime(s.endSec)}\n${withSpeakerPrefix(s.text, s.speaker, withSpeakers)}\n`);
    if (sink && (i + 1) % EXPORT_YIELD_EVERY === 0 && i < segments.length - 1) {
      sink.setProgress(((i + 1) / segments.length) * 0.9, `Formatting cue ${i + 1}/${segments.length}`);
      await yieldToUI();
      await sink.waitWhilePaused();
      if (sink.shouldCancel()) return null;
    }
  }
  const joiner = fmt === 'txt' ? (withTimestamps ? '\n' : '\n\n') : '\n';
  return out.join(joiner);
}

const EXPORT_MIME: Record<ExportFmt, string> = {
  txt: 'text/plain',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
};

function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
}

function extensionForMime(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

function confidenceTier(c: number): 'high' | 'mid' | 'low' | 'unknown' {
  if (!Number.isFinite(c) || c <= 0) return 'unknown';
  if (c >= 0.8) return 'high';
  if (c >= 0.5) return 'mid';
  return 'low';
}

const CONFIDENCE_DOT: Record<'high' | 'mid' | 'low' | 'unknown', string> = {
  high: 'bg-emerald-500',
  mid: 'bg-amber-500',
  low: 'bg-rose-500',
  unknown: 'bg-zinc-400 dark:bg-zinc-600',
};

/** Pick the best MediaRecorder mimeType ('' = browser default). */
function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch { /* probe failed — try next */ }
  }
  return '';
}

/** Tolerant draft sanitization — never let a corrupt row break the restore. */
function sanitizeSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text.trim()) continue;
    const start = typeof o.startSec === 'number' && Number.isFinite(o.startSec) ? Math.max(0, o.startSec) : 0;
    const endRaw = typeof o.endSec === 'number' && Number.isFinite(o.endSec) ? Math.max(0, o.endSec) : start + MANUAL_STAMP_SEC;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : uid('seg'),
      startSec: start,
      endSec: Math.max(start, endRaw),
      text,
      confidence: typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? Math.min(1, Math.max(0, o.confidence)) : 0,
      speaker: typeof o.speaker === 'string' && o.speaker.trim() ? o.speaker : undefined,
    });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Tolerant numeric input parse — junk/empty falls back to the given default. */
function parseNumber(raw: string, fallback: number): number {
  if (!raw.trim()) return fallback; // Number('') is 0 — treat a cleared field as untouched
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Split chronological, non-empty segments into audiobook chapters: a new
 * chapter starts when the silence gap BEFORE a segment (consecutive
 * end → start) reaches `gapSec`, or — fallback — when the current chapter
 * already holds `everyN` segments. Segments with empty text are skipped
 * entirely. Pure: never mutates the caller's array.
 */
function buildChapters(segments: TranscriptSegment[], gapSec: number, everyN: number): TranscriptChapter[] {
  const clean = segments
    .filter((s) => typeof s.text === 'string' && s.text.trim().length > 0)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  if (!clean.length) return [];
  const gap = Number.isFinite(gapSec) ? Math.max(0, gapSec) : 0;
  const every = Math.max(1, Math.floor(Number.isFinite(everyN) ? everyN : 1));
  const chapters: string[][] = [[]];
  let prevEnd: number | null = null;
  for (const seg of clean) {
    let cur = chapters[chapters.length - 1];
    const gapBreak = prevEnd !== null && seg.startSec - prevEnd >= gap;
    const countBreak = cur.length >= every;
    if (gapBreak || countBreak) {
      cur = [];
      chapters.push(cur);
    }
    cur.push(seg.text.trim());
    prevEnd = seg.endSec;
  }
  return chapters.map((texts, i) => ({ title: `Chapter ${i + 1}`, text: texts.join(' ') }));
}

// ---------- view ----------

export function TranscribeView() {
  const mounted = useMounted();
  const { toast } = useToast();
  const addAsset = useAppStore((s) => s.addAsset);
  const reducedMotion = useReducedMotion();

  // Availability probes render-side (useMounted keeps SSR + first client render identical)
  const recognizerAvailable = mounted && speechRecognitionAvailable();

  const [recState, setRecState] = useState<RecState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState('');
  const [lang, setLang] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [permissionIssue, setPermissionIssue] = useState<string | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingMime, setRecordingMime] = useState('audio/webm');
  const [recordingSize, setRecordingSize] = useState(0);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [manualText, setManualText] = useState('');
  const [includeTimestamps, setIncludeTimestamps] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [draftRecordingNotice, setDraftRecordingNotice] = useState(false);
  // speakers (R10) — per-row assignment lives on the segment rows themselves
  const [bulkSpeaker, setBulkSpeaker] = useState(''); // "Assign remaining to…" toolbar
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null); // null = All (view-only)
  const [includeSpeakers, setIncludeSpeakers] = useState<boolean | null>(null); // null = follow default (ON when any speaker tagged)
  // audiobook chapter split options — string state = raw input, parsed tolerantly
  const [chapterGapRaw, setChapterGapRaw] = useState('1.5');
  const [chapterEveryRaw, setChapterEveryRaw] = useState('25');
  const [chapterOpen, setChapterOpen] = useState(false);
  // speaker suggestions (R11-b) — review mode: null = off; otherwise suggestions by segment index
  const [suggestions, setSuggestions] = useState<SpeakerSuggestion[] | null>(null);
  const [rejectedIdx, setRejectedIdx] = useState<Set<number>>(new Set()); // individually skipped suggestions

  const hasRecording = recordingUrl !== null;

  // ---------- refs (live media + session clock) ----------
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterRafRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderMimeRef = useRef('');
  const chunksRef = useRef<Blob[]>([]);
  const accMsRef = useRef(0); // session clock accumulated across pauses
  const startedAtRef = useRef<number | null>(null); // epoch ms of the current run
  const recognizerRef = useRef<LiveRecognizer | null>(null);
  const listeningRef = useRef(false); // recognition auto-restarts only while true
  const lastFinalEndRef = useRef(0); // session clock of the last committed segment
  const finalizeRef = useRef<() => void>(() => {});
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const meterCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(0);
  const draftReadyRef = useRef(false);
  const exportPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const nowElapsedMs = useCallback(() => {
    return accMsRef.current + (startedAtRef.current !== null ? Date.now() - startedAtRef.current : 0);
  }, []);

  // ---------- draft restore (once, before autosave) ----------
  useEffect(() => {
    void (async () => {
      try {
        const draft = await loadTranscribeDraft();
        if (transcribeDraftHasContent(draft) && draft) {
          const restored = sanitizeSegments(draft.segments);
          if (restored.length > 0) {
            setSegments(restored);
            setLang(typeof draft.language === 'string' ? draft.language : '');
            setDraftSavedAt(draft.savedAt);
            if (draft.hadRecording) setDraftRecordingNotice(true);
            toast({ title: 'Draft restored', description: `${restored.length} segment${restored.length === 1 ? '' : 's'} recovered from on-device storage.` });
          }
        }
      } catch { /* best-effort */ } finally {
        draftReadyRef.current = true;
      }
    })();
    return () => {
      listeningRef.current = false;
      try { recognizerRef.current?.stop(); } catch { /* not running */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      cancelAnimationFrame(meterRafRef.current);
      if (exportPollRef.current) clearInterval(exportPollRef.current);
    };
  }, [toast]);

  // ---------- debounced draft autosave (segments + language only) ----------
  useEffect(() => {
    if (!draftReadyRef.current) return;
    const t = setTimeout(() => {
      void saveTranscribeDraft({
        savedAt: Date.now(),
        segments: segments.map((s) => ({ id: s.id, startSec: s.startSec, endSec: s.endSec, text: s.text, confidence: s.confidence, speaker: s.speaker })),
        language: lang,
        hadRecording: hasRecording,
      }).then(() => setDraftSavedAt(Date.now()));
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [segments, lang, hasRecording]);

  // ---------- session clock ticker ----------
  useEffect(() => {
    if (recState !== 'recording') return;
    const t = setInterval(() => setElapsedMs(nowElapsedMs()), 100);
    return () => clearInterval(t);
  }, [recState, nowElapsedMs]);

  // ---------- live input level meter (rAF while recording) ----------
  useEffect(() => {
    if (recState !== 'recording') return;
    const canvas = meterCanvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(60, Math.round((rect.width || 144) * dpr));
    canvas.height = Math.max(16, Math.round((rect.height || 28) * dpr));

    const buf = new Uint8Array(analyser.fftSize);
    const history: number[] = [];
    const BARS = 40;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      history.push(Math.min(1, rms * 3.2));
      while (history.length > BARS) history.shift();
      const w = canvas.width;
      const h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);
      const bw = w / BARS;
      for (let i = 0; i < BARS; i++) {
        const v = history[i] ?? 0;
        const bh = Math.max(2 * dpr, v * (h - 2));
        ctx2d.fillStyle = `oklch(0.72 0.17 162 / ${(0.3 + v * 0.7).toFixed(2)})`; // emerald bars
        ctx2d.fillRect(i * bw + 1, (h - bh) / 2, Math.max(2, bw - 2), bh);
      }
    };
    raf = requestAnimationFrame(draw);
    meterRafRef.current = raf;
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [recState]);

  // ---------- segment helpers ----------

  const commitSegment = useCallback((text: string, confidence: number) => {
    const endMs = accMsRef.current + (startedAtRef.current !== null ? Date.now() - startedAtRef.current : 0);
    const startMs = Math.min(lastFinalEndRef.current, endMs);
    lastFinalEndRef.current = endMs;
    setSegments((s) => [...s, {
      id: uid('seg'),
      startSec: startMs / 1000,
      endSec: Math.max(startMs + 200, endMs) / 1000,
      text,
      confidence: Number.isFinite(confidence) ? confidence : 0,
    }]);
    setInterim('');
  }, []);

  const removeSegment = useCallback((id: string) => {
    setSegments((s) => s.filter((x) => x.id !== id));
  }, []);

  const commitEdit = useCallback((id: string) => {
    if (editingId !== id) return;
    const text = editText.trim();
    // empty edit deletes the segment — matches the Dialogue Studio convention
    setSegments((s) => (text ? s.map((x) => (x.id === id ? { ...x, text } : x)) : s.filter((x) => x.id !== id)));
    setEditingId(null);
    setEditText('');
  }, [editingId, editText]);

  // ---------- recognition ----------

  const startRecognition = useCallback(() => {
    if (!speechRecognitionAvailable()) return;
    recognizerRef.current?.stop();
    recognizerRef.current = createLiveRecognizer({
      lang,
      shouldRun: () => listeningRef.current,
      onFinal: (text, confidence) => commitSegment(text, confidence),
      onInterim: setInterim,
      onError: (code, message) => {
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          listeningRef.current = false;
          setPermissionIssue('Speech recognition was blocked — allow microphone access for this page and try again.');
          setManualMode(true);
        } else {
          toast({ title: 'Recognition error', description: message, variant: 'destructive' });
        }
      },
    });
    try { recognizerRef.current?.start(); } catch { /* already running */ }
  }, [lang, commitSegment, toast]);

  // ---------- session control ----------

  const startClock = useCallback(() => {
    accMsRef.current = 0;
    startedAtRef.current = Date.now();
    lastFinalEndRef.current = 0;
    setElapsedMs(0);
    setRecState('recording');
    listeningRef.current = true;
  }, []);

  const finalizeRecording = useCallback(() => {
    const chunks = chunksRef.current;
    chunksRef.current = [];
    recorderRef.current = null;
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: recorderMimeRef.current || undefined });
    const url = URL.createObjectURL(blob);
    setRecordingUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    setRecordingMime(blob.type || 'audio/webm');
    setRecordingSize(blob.size);
    setRecordingDuration(accMsRef.current / 1000);
    setPlayheadSec(0);
    toast({ title: 'Recording captured', description: `${formatDuration(accMsRef.current / 1000)} of audio attached — play it back or export the transcript.` });
  }, [toast]);

  // keep the onstop closure fresh without re-arming the recorder
  useEffect(() => {
    finalizeRef.current = finalizeRecording;
  }, [finalizeRecording]);

  const startSession = useCallback(async () => {
    if (recState !== 'idle' || !mounted) return;
    setPermissionIssue(null);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPermissionIssue('Live audio capture is not supported in this browser.');
      setManualMode(true);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : 'Error';
      const why = name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Microphone access was denied.'
        : name === 'NotFoundError'
          ? 'No microphone was found on this device.'
          : name === 'NotReadableError'
            ? 'The microphone is busy — close other apps using it.'
            : `Could not open the microphone (${name}).`;
      setPermissionIssue(why);
      setManualMode(true);
      toast({ title: 'Microphone unavailable', description: 'Manual mode is on — type lines and stamp them at the playhead.', variant: 'destructive' });
      return;
    }
    streamRef.current = stream;

    // input level meter (optional — never blocks the session)
    try {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') void ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
    } catch { /* meter unavailable */ }

    // recorder (prefer webm/opus, fall back to the browser default)
    recorderMimeRef.current = pickRecorderMime();
    try {
      const rec = recorderMimeRef.current
        ? new MediaRecorder(stream, { mimeType: recorderMimeRef.current })
        : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => finalizeRef.current();
      rec.start(250);
    } catch {
      recorderRef.current = null;
      toast({ title: 'Recorder failed', description: 'Transcription continues, but the audio will not be playable.', variant: 'destructive' });
    }

    startClock();
    startRecognition();
  }, [recState, mounted, startClock, startRecognition, toast]);

  /** Mic denied / unsupported — run the session clock alone (manual stamping). */
  const startTimerOnly = useCallback(() => {
    if (recState !== 'idle') return;
    setPermissionIssue(null);
    setManualMode(true);
    startClock();
    toast({ title: 'Timer running', description: 'Stamping timestamps from the session clock — no audio will be recorded.' });
  }, [recState, startClock, toast]);

  const pauseSession = useCallback(() => {
    if (recState !== 'recording') return;
    if (startedAtRef.current !== null) accMsRef.current += Date.now() - startedAtRef.current;
    startedAtRef.current = null;
    setElapsedMs(accMsRef.current);
    setRecState('paused');
    listeningRef.current = false;
    try { recognizerRef.current?.stop(); } catch { /* not running */ }
    setInterim('');
    try { recorderRef.current?.pause(); } catch { /* recorder optional */ }
  }, [recState]);

  const resumeSession = useCallback(() => {
    if (recState !== 'paused') return;
    startedAtRef.current = Date.now();
    lastFinalEndRef.current = accMsRef.current; // segments continue from the frozen clock
    setRecState('recording');
    listeningRef.current = true;
    try { recorderRef.current?.resume(); } catch { /* recorder optional */ }
    try { recognizerRef.current?.start(); } catch { /* not running */ }
  }, [recState]);

  const stopSession = useCallback(() => {
    if (recState === 'idle') return;
    if (startedAtRef.current !== null) accMsRef.current += Date.now() - startedAtRef.current;
    startedAtRef.current = null;
    setElapsedMs(accMsRef.current);
    setRecState('idle');
    listeningRef.current = false;
    try { recognizerRef.current?.stop(); } catch { /* not running */ }
    recognizerRef.current = null;
    setInterim('');
    if (recorderRef.current) {
      try { recorderRef.current.stop(); } catch { finalizeRef.current(); }
    } else {
      finalizeRef.current(); // no recorder — nothing to finalize, keeps state consistent
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    // drop the frozen meter bars
    const canvas = meterCanvasRef.current;
    const g = canvas?.getContext('2d');
    if (canvas && g) g.clearRect(0, 0, canvas.width, canvas.height);
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
  }, [recState]);

  // ---------- manual stamping ----------

  const stampManual = useCallback(() => {
    const text = manualText.trim();
    if (!text) return;
    const start = recState !== 'idle'
      ? nowElapsedMs() / 1000
      : hasRecording ? playheadSec : 0;
    lastFinalEndRef.current = Math.max(lastFinalEndRef.current, (start + MANUAL_STAMP_SEC) * 1000);
    setSegments((s) => [...s, { id: uid('seg'), startSec: start, endSec: start + MANUAL_STAMP_SEC, text, confidence: 1 }]);
    setManualText('');
  }, [manualText, recState, hasRecording, playheadSec, nowElapsedMs]);

  // ---------- playback ----------

  const seek = useCallback((sec: number) => {
    const el = audioElRef.current;
    const t = Math.max(0, Math.min(sec, recordingDuration || sec));
    if (el) {
      try { el.currentTime = t; } catch { /* not seekable yet */ }
    }
    setPlayheadSec(t);
  }, [recordingDuration]);

  // ghost-highlight the segment under the playhead
  const activeSegmentId = useMemo(() => {
    if (!hasRecording) return null;
    const t = playheadSec;
    const exact = segments.find((s) => t >= s.startSec && t <= s.endSec);
    if (exact) return exact.id;
    let prev: TranscriptSegment | null = null;
    for (const s of segments) {
      if (s.startSec <= t) prev = s;
      else break;
    }
    return prev?.id ?? null;
  }, [segments, playheadSec, hasRecording]);

  useEffect(() => {
    if (!activeSegmentId) return;
    const el = document.getElementById(`seg-row-${activeSegmentId}`);
    el?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [activeSegmentId, reducedMotion]);

  // keep the newest segment in view while recording
  useEffect(() => {
    if (segments.length > prevCountRef.current && recState === 'recording' && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevCountRef.current = segments.length;
  }, [segments.length, recState]);

  // ---------- derived stats ----------

  const stats = useMemo(() => {
    const words = segments.reduce((a, s) => a + s.text.trim().split(/\s+/).filter(Boolean).length, 0);
    const speechSec = segments.reduce((a, s) => a + Math.max(0, s.endSec - s.startSec), 0);
    return { words, speechSec };
  }, [segments]);

  const joinedProse = useMemo(
    () => segments.map((s) => s.text.trim()).filter(Boolean).join(' '),
    [segments],
  );

  // ---------- derived speaker stats ----------

  /** Unique speakers in first-appearance order with per-speaker counts. */
  const speakerInfo = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of segments) {
      const name = typeof s.speaker === 'string' ? s.speaker.trim() : '';
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
  }, [segments]);
  const knownSpeakers = useMemo(() => speakerInfo.map((s) => s.name), [speakerInfo]);
  const anySpeaker = speakerInfo.length > 0;
  const unassignedCount = useMemo(
    () => segments.filter((s) => !(typeof s.speaker === 'string' && s.speaker.trim())).length,
    [segments],
  );
  /** Switch value — explicit user choice wins, else ON when any speaker is tagged. */
  const includeSpeakersOn = includeSpeakers ?? anySpeaker;
  /** Segments eligible for the Video Editor cue handoff: text + valid time extent. */
  const cueableCount = useMemo(
    () => segments.filter((s) => s.text.trim().length > 0 && Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec).length,
    [segments],
  );
  /** Filtered view of the segment list — exports & handoffs always use everything. */
  const visibleSegments = useMemo(
    () => (speakerFilter === null ? segments : segments.filter((s) => typeof s.speaker === 'string' && s.speaker.trim() === speakerFilter)),
    [segments, speakerFilter],
  );

  // a filtered speaker that disappears (renamed/deleted) falls back to "All"
  useEffect(() => {
    if (speakerFilter !== null && !knownSpeakers.includes(speakerFilter)) setSpeakerFilter(null);
  }, [speakerFilter, knownSpeakers]);

  // ---------- audiobook chapter split (live preview) ----------

  const chapterGapSec = useMemo(() => Math.max(0, parseNumber(chapterGapRaw, 1.5)), [chapterGapRaw]);
  const chapterEveryN = useMemo(() => Math.max(1, Math.floor(parseNumber(chapterEveryRaw, 25))), [chapterEveryRaw]);
  const previewChapters = useMemo(
    () => buildChapters(segments, chapterGapSec, chapterEveryN),
    [segments, chapterGapSec, chapterEveryN],
  );

  // ---------- exports & handoffs ----------

  const copyTranscript = useCallback(() => {
    if (!segments.length) return;
    const text = buildPlainText(segments, includeTimestamps);
    void navigator.clipboard.writeText(text)
      .then(() => toast({ title: 'Transcript copied', description: `${segments.length} segment${segments.length === 1 ? '' : 's'} on the clipboard.` }))
      .catch(() => toast({ title: 'Copy failed', description: 'The clipboard is unavailable in this context.', variant: 'destructive' }));
  }, [segments, includeTimestamps, toast]);

  const runExport = useCallback((fmt: ExportFmt) => {
    if (!segments.length) return;
    const snapshot = segments;
    const withTs = includeTimestamps;
    const withSp = fmt !== 'txt' && includeSpeakersOn; // speaker names fold into .srt/.vtt only
    const name = `auravoice-transcript-${dateStamp()}.${fmt}`;
    const finish = (text: string) => {
      downloadBlob(new Blob([text], { type: EXPORT_MIME[fmt] }), name);
      toast({ title: `${fmt.toUpperCase()} downloaded`, description: `${snapshot.length} segment${snapshot.length === 1 ? '' : 's'} · ${name}` });
    };

    if (snapshot.length > LARGE_EXPORT_SEGMENTS) {
      // LARGE transcript — build in the queue so the UI never stalls
      setExporting(true);
      const jobId = enqueueJob(
        { type: 'encode', label: 'Build transcript exports' },
        async (api) => {
          api.log(`Formatting ${snapshot.length} segments as ${fmt.toUpperCase()}…`);
          const text = await buildExportText(fmt, snapshot, withTs, withSp, api);
          if (text === null) return { cancelled: true };
          api.setProgress(0.95, 'Preparing download…');
          downloadBlob(new Blob([text], { type: EXPORT_MIME[fmt] }), name);
          api.log(`Downloaded ${name}`);
          return { format: fmt, segments: snapshot.length };
        },
      );
      if (exportPollRef.current) clearInterval(exportPollRef.current);
      exportPollRef.current = setInterval(() => {
        const job = useAppStore.getState().jobs.find((j) => j.id === jobId);
        if (job && ['done', 'error', 'cancelled'].includes(job.status)) {
          if (exportPollRef.current) clearInterval(exportPollRef.current);
          exportPollRef.current = null;
          setExporting(false);
          if (job.status === 'done') toast({ title: 'Export ready', description: `${fmt.toUpperCase()} with ${snapshot.length} segments downloaded.` });
          else toast({ title: 'Export failed', description: job.error ?? 'The job did not complete.', variant: 'destructive' });
        }
      }, 400);
      return;
    }

    // small transcript — inline
    void buildExportText(fmt, snapshot, withTs, withSp).then((text) => {
      if (text !== null) finish(text);
    });
  }, [segments, includeTimestamps, includeSpeakersOn, toast]);

  const saveTranscriptAsset = useCallback(() => {
    if (!segments.length) return;
    const text = buildPlainText(segments, includeTimestamps);
    const asset: AssetItem = {
      id: uid('asset'),
      name: `transcript-${dateStamp()}.txt`,
      kind: 'text',
      createdAt: Date.now(),
      mimeType: 'text/plain',
      sizeBytes: new Blob([text]).size,
      text,
      meta: { source: 'transcribe-studio', segments: segments.length },
    };
    addAsset(asset);
    toast({ title: 'Transcript saved', description: 'Text asset added to the Asset Bin.' });
  }, [segments, includeTimestamps, addAsset, toast]);

  const saveRecordingAsset = useCallback(() => {
    if (!recordingUrl) return;
    const asset: AssetItem = {
      id: uid('asset'),
      name: `recording-${dateStamp()}.${extensionForMime(recordingMime)}`,
      kind: 'audio',
      createdAt: Date.now(),
      mimeType: recordingMime,
      sizeBytes: recordingSize,
      durationSec: recordingDuration,
      blobUrl: recordingUrl,
      meta: { source: 'transcribe-studio' },
    };
    addAsset(asset);
    toast({ title: 'Recording saved', description: 'Audio asset added to the Asset Bin.' });
  }, [recordingUrl, recordingMime, recordingSize, recordingDuration, addAsset, toast]);

  const sendToTts = useCallback(() => {
    if (!joinedProse) return;
    const store = useAppStore.getState();
    store.setPendingText(joinedProse, `Transcript · ${segments.length} segments`);
    store.setView('tts');
    toast({ title: 'Sent to TTS Studio', description: 'The transcript is queued as pending text — TTS Studio will pick it up.' });
  }, [joinedProse, segments.length, toast]);

  /** Per-row speaker tag — empty input clears the assignment. */
  const setSegmentSpeaker = useCallback((id: string, raw: string) => {
    const speaker = raw.trim() ? raw : undefined;
    setSegments((s) => s.map((x) => (x.id === id ? { ...x, speaker } : x)));
  }, []);

  /** One-click bulk: tag every unassigned segment with the toolbar's name. */
  const assignRemainingTo = useCallback(() => {
    const name = bulkSpeaker.trim();
    if (!name || unassignedCount === 0) return;
    setSegments((s) => s.map((x) => (typeof x.speaker === 'string' && x.speaker.trim() ? x : { ...x, speaker: name })));
    setBulkSpeaker('');
    toast({
      title: `${unassignedCount} segment${unassignedCount === 1 ? '' : 's'} assigned to ${name}`,
      description: 'Every unassigned segment now carries this speaker tag.',
    });
  }, [bulkSpeaker, unassignedCount, toast]);

  // ---------- speaker suggestions (R11-b) — review-then-apply, one source of truth ----------

  /** Suggestions still in play: not individually rejected, row still untagged, segment still alive. */
  const activeSuggestions = useMemo(() => {
    if (!suggestions) return [];
    return suggestions.filter((sg) => {
      if (rejectedIdx.has(sg.index)) return false;
      const seg = segments[sg.index];
      return !!seg && !(typeof seg.speaker === 'string' && seg.speaker.trim());
    });
  }, [suggestions, rejectedIdx, segments]);

  const highConfSuggestions = useMemo(
    () => activeSuggestions.filter((sg) => sg.confidence >= SUGGEST_HIGH_CONFIDENCE),
    [activeSuggestions],
  );

  /** Row lookup — key = segment's index in the FULL segments array (suggestions are positional). */
  const suggestionByIndex = useMemo(() => {
    const m = new Map<number, SpeakerSuggestion>();
    for (const sg of activeSuggestions) m.set(sg.index, sg);
    return m;
  }, [activeSuggestions]);

  const segmentIndexById = useMemo(() => {
    const m = new Map<string, number>();
    segments.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [segments]);

  const exitReview = useCallback(() => {
    setSuggestions(null);
    setRejectedIdx(new Set());
  }, []);

  // Suggestions hold positional indexes — any add/remove shifts them, so drop the review.
  useEffect(() => {
    exitReview();
  }, [segments.length, exitReview]);

  /** Compute suggestions from the current segments and enter review mode (nothing applied yet). */
  const runSuggest = useCallback(() => {
    const result = suggestSpeakers(
      segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text, speaker: s.speaker ?? null })),
    );
    // Review mode targets untagged rows — seeds already live on their segments.
    const applicable = result.filter((sg) => {
      const seg = segments[sg.index];
      return !!seg && !(typeof seg.speaker === 'string' && seg.speaker.trim());
    });
    if (!applicable.length) {
      toast({ title: 'No suggestions', description: 'Nothing looked like a speaker change — tag rows manually or use “Assign remaining to…”.' });
      return;
    }
    setSuggestions(applicable);
    setRejectedIdx(new Set());
  }, [segments, toast]);

  /** Accept ONE suggestion — rides the exact per-row speaker setter (same path as typing in the Input). */
  const acceptSuggestion = useCallback((sg: SpeakerSuggestion) => {
    const seg = segments[sg.index];
    if (!seg) return;
    setSegmentSpeaker(seg.id, sg.speaker);
    setSuggestions((prev) => (prev ? prev.filter((x) => x.index !== sg.index) : prev));
  }, [segments, setSegmentSpeaker]);

  /** Reject ONE suggestion — stays off until review is re-run. */
  const rejectSuggestion = useCallback((sg: SpeakerSuggestion) => {
    setRejectedIdx((prev) => {
      const next = new Set(prev);
      next.add(sg.index);
      return next;
    });
  }, []);

  /**
   * Apply all active suggestions with confidence ≥ minConfidence, then leave
   * review mode. Writes go through the same state-update path as the per-row
   * input (setSegments + { ...x, speaker } merge) — the debounced autosave
   * effect persists them to IndexedDB like any other speaker edit, and rows
   * that gained a tag meanwhile are never overwritten.
   */
  const applySuggestions = useCallback((minConfidence: number) => {
    const apply = activeSuggestions.filter((sg) => sg.confidence >= minConfidence);
    if (!apply.length) return;
    const nameByIndex = new Map(apply.map((sg) => [sg.index, sg.speaker]));
    setSegments((prev) => prev.map((x, i) => {
      if (typeof x.speaker === 'string' && x.speaker.trim()) return x; // never overwrite
      const name = nameByIndex.get(i);
      return name ? { ...x, speaker: name } : x;
    }));
    exitReview();
    toast({
      title: `Applied ${apply.length} speaker suggestion${apply.length === 1 ? '' : 's'}`,
      description: minConfidence > 0
        ? `High-confidence picks only (≥ ${Math.round(minConfidence * 100)}%).`
        : 'Names use the same tagging path — exports and handoffs pick them up.',
    });
  }, [activeSuggestions, exitReview, toast]);

  /** Segments → SubtitleCue handoff (speaker rides along; burn-in lives in the Video Editor). */
  const sendToVideo = useCallback(() => {
    const cues: SubtitleCue[] = segments
      .filter((s) => s.text.trim().length > 0 && Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
      .map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text, speaker: s.speaker?.trim() ? s.speaker.trim() : undefined }));
    if (!cues.length) return;
    const store = useAppStore.getState();
    store.setPendingSubtitleCues(cues);
    store.setView('video');
    const tagged = cues.filter((c) => typeof c.speaker === 'string' && c.speaker).length;
    toast({
      title: `${cues.length} cue${cues.length === 1 ? '' : 's'} sent to Video Editor`,
      description: tagged > 0
        ? `${tagged} speaker-tagged — names burn into exports there.`
        : 'They land on the subtitle track, ready to burn into exports.',
    });
  }, [segments, toast]);

  /** Chapters → Audiobook Studio handoff (split previewed live in the popover). */
  const sendToAudiobook = useCallback(async () => {
    let rawText = segments.map((s) => s.text).join(' ');
    // AI cleanup
    const clean = await aiCleanTranscript(rawText);
    if (clean.ok && clean.value) {
      rawText = clean.value.text;
    }
    const aiChapters = await aiTranscriptToChapters(rawText, 12);
    let chapters: TranscriptChapter[];
    if (aiChapters.ok && aiChapters.value && aiChapters.value.length > 0) {
      chapters = aiChapters.value;
    } else {
      chapters = buildChapters(segments, chapterGapSec, chapterEveryN);
    }
    if (!chapters.length) return;
    const store = useAppStore.getState();
    store.setPendingTranscriptChapters(chapters);
    store.setView('audiobook');
    setChapterOpen(false);
    toast({
      title: `${chapters.length} chapter${chapters.length === 1 ? '' : 's'} sent to Audiobook Studio`,
      description: `${aiChapters.ok ? 'AI-chaptered' : `Split on ${chapterGapSec}s silence gaps`} — queued as pending chapters.`,
    });
  }, [segments, chapterGapSec, chapterEveryN, toast]);

  const clearTranscript = useCallback(() => {
    setSegments([]);
    setInterim('');
    setEditingId(null);
    lastFinalEndRef.current = 0;
    toast({ title: 'Transcript cleared', description: 'Segments removed — the recording is kept.' });
  }, [toast]);

  const discardDraft = useCallback(async () => {
    draftReadyRef.current = false;
    await clearTranscribeDraft();
    setDraftSavedAt(null);
    setDraftRecordingNotice(false);
    draftReadyRef.current = true;
    toast({ title: 'Draft discarded', description: 'Autosave continues from your next edit.' });
  }, [toast]);

  const onLangChange = useCallback((v: string) => {
    const next = v === 'default' ? '' : v;
    setLang(next);
    if (recState !== 'idle') recognizerRef.current?.setLang(next); // applies on the engine's next restart
  }, [recState]);

  // ---------- render ----------

  const elapsedSec = elapsedMs / 1000;
  const stampDisabled = recState === 'idle' && !hasRecording;
  const showManualRow = manualMode || recState !== 'idle';

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      {/* ===== left column — capture, playback, transcript ===== */}
      <div className="min-w-0 space-y-4">
        <SectionPanel
          title="Recorder"
          description="One session clock drives timestamps, playback and manual stamping."
          actions={
            recState === 'recording' ? (
              <Badge variant="outline" className="gap-1.5 border-rose-500/30 bg-rose-500/10 text-[10px] text-rose-600 dark:text-rose-400">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75" aria-hidden />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" aria-hidden />
                </span>
                REC {formatChip(elapsedSec)}
              </Badge>
            ) : recState === 'paused' ? (
              <Badge variant="outline" className="gap-1 border-violet-500/30 bg-violet-500/10 text-[10px] text-violet-600 dark:text-violet-400">
                <Pause className="h-3 w-3" />paused
              </Badge>
            ) : hasRecording ? (
              <Badge variant="outline" className="text-[10px] tabular-nums">
                <CheckCircle2 className="mr-1 h-3 w-3 text-emerald-500" />captured {formatDuration(recordingDuration)}
              </Badge>
            ) : null
          }
        >
          <div
            className={cn(
              'rounded-xl border p-4 transition-colors',
              recState === 'recording' ? 'recording-tint border-violet-500/40 bg-violet-500/5 dark:bg-violet-500/10' : 'border-border',
            )}
          >
            <div className="flex flex-wrap items-center gap-3">
              {recState === 'idle' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button onClick={() => void startSession()} disabled={!mounted} className="h-10 min-w-36 sm:h-8 sm:min-w-32" aria-label="Start recording">
                      <Mic className="mr-1.5 h-4 w-4" />Start recording
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Asks for mic access, records audio and transcribes live</TooltipContent>
                </Tooltip>
              ) : (
                <>
                  <Button variant="destructive" onClick={stopSession} className="h-10 sm:h-8" aria-label="Stop session">
                    <Square className="mr-1.5 h-3.5 w-3.5" />Stop
                  </Button>
                  {recState === 'recording' ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" onClick={pauseSession} className="h-10 sm:h-8" aria-label="Pause recording">
                          <Pause className="mr-1.5 h-3.5 w-3.5" />Pause
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">Freezes the session clock and the recorder</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" onClick={resumeSession} className="h-10 sm:h-8" aria-label="Resume recording">
                          <Play className="mr-1.5 h-3.5 w-3.5" />Resume
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">Continue on the same clock</TooltipContent>
                    </Tooltip>
                  )}
                </>
              )}
              <span
                className={cn(
                  'ml-auto text-3xl font-semibold tracking-tight tabular-nums',
                  recState === 'idle' && 'text-muted-foreground',
                )}
                aria-label={`Session clock ${formatDuration(elapsedSec)}`}
              >
                {formatDuration(elapsedSec)}
              </span>
              <canvas
                ref={meterCanvasRef}
                className="transcribe-meter h-7 w-36 rounded-md bg-muted/60"
                aria-hidden
              />
            </div>
            {recState === 'idle' && !hasRecording && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                {recognizerAvailable
                  ? 'Live captions appear as you speak — finalized lines land in the transcript with timestamps.'
                  : 'This browser has no speech recognition — manual mode below keeps the workflow alive.'}
              </p>
            )}
          </div>

          {/* permission / unsupported alert */}
          {permissionIssue && (
            <div role="alert" className="mt-3 flex items-start gap-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3">
              <MicOff className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden />
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{permissionIssue}</p>
                <p className="text-[11px] text-muted-foreground">
                  Check the microphone permission in the address bar, or keep working in manual mode — timestamps still come from the session clock.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => void startSession()}>Try again</Button>
                  <Button size="sm" variant="outline" onClick={startTimerOnly}>
                    <Timer className="mr-1.5 h-3.5 w-3.5" />Start timer only
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPermissionIssue(null)}>Dismiss</Button>
                </div>
              </div>
            </div>
          )}
        </SectionPanel>

        {/* playback — appears once a recording exists */}
        {hasRecording && recordingUrl && (
          <SectionPanel title="Playback" description="Scrub the take — the transcript highlights the segment under the playhead.">
            <audio
              ref={audioElRef}
              src={recordingUrl}
              preload="metadata"
              className="hidden"
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
              onTimeUpdate={(e) => setPlayheadSec(e.currentTarget.currentTime)}
            />
            <div className="flex items-center gap-3">
              <Button
                size="icon"
                onClick={() => {
                  const el = audioElRef.current;
                  if (!el) return;
                  if (el.paused) void el.play().catch(() => toast({ title: 'Playback failed', variant: 'destructive' }));
                  else el.pause();
                }}
                className="h-10 w-10 shrink-0 rounded-full sm:h-9 sm:w-9"
                aria-label={isPlaying ? 'Pause playback' : 'Play recording'}
              >
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
              </Button>
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{formatChip(playheadSec)}</span>
              <input
                type="range"
                min={0}
                max={Math.max(0.1, recordingDuration)}
                step={0.05}
                value={Math.min(playheadSec, Math.max(0.1, recordingDuration))}
                onChange={(e) => seek(Number(e.target.value))}
                className="h-1.5 min-w-0 flex-1 cursor-pointer accent-emerald-600"
                aria-label="Seek recording"
              />
              <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(recordingDuration)}</span>
            </div>
          </SectionPanel>
        )}

        <SectionPanel
          title="Transcript"
          description="Chronological segments — click text to edit, timestamp to seek."
          actions={
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] tabular-nums">{segments.length} seg</Badge>
              <Badge variant="outline" className="text-[10px] tabular-nums">{stats.words} words</Badge>
              {speakerInfo.length > 0 && (
                <Badge variant="outline" className="text-[10px] tabular-nums">
                  <Users className="mr-1 h-3 w-3 text-violet-500 dark:text-violet-400" />
                  {speakerInfo.length} speaker{speakerInfo.length === 1 ? '' : 's'}
                </Badge>
              )}
              <Badge variant="outline" className="hidden text-[10px] tabular-nums sm:inline-flex">≈ {formatDuration(stats.speechSec)}</Badge>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px] text-rose-500 hover:text-rose-600"
                onClick={clearTranscript}
                disabled={!segments.length}
                aria-label="Clear transcript"
              >
                <Trash2 className="mr-1 h-3 w-3" />Clear
              </Button>
            </div>
          }
        >
          {/* speaker toolbar — per-row tags below + one-click bulk assignment */}
          {segments.length > 0 && (
            <>
              <datalist id="transcribe-speaker-options">
                {knownSpeakers.map((sp) => <option key={sp} value={sp} />)}
              </datalist>
              <motion.div
                initial={{ opacity: 0, y: reducedMotion ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' }}
                className="mb-2 flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 p-2"
              >
                <Users className="h-3.5 w-3.5 shrink-0 text-violet-500 dark:text-violet-400" aria-hidden />
                <Input
                  value={bulkSpeaker}
                  onChange={(e) => setBulkSpeaker(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); assignRemainingTo(); } }}
                  list="transcribe-speaker-options"
                  placeholder="Assign remaining to…"
                  className="h-7 min-w-0 flex-1 text-xs"
                  aria-label="Speaker name to assign to all unassigned segments"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 px-2.5 text-[11px]"
                      onClick={assignRemainingTo}
                      disabled={!bulkSpeaker.trim() || unassignedCount === 0}
                    >
                      Apply{unassignedCount > 0 ? ` (${unassignedCount})` : ''}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-56 text-xs">
                    {unassignedCount === 0
                      ? 'Every segment already has a speaker'
                      : `Tags all ${unassignedCount} unassigned segments with this name`}
                  </TooltipContent>
                </Tooltip>
                {segments.length >= SUGGEST_MIN_SEGMENTS && unassignedCount > 0 && !suggestions && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
                        onClick={runSuggest}
                        aria-label="Suggest speakers from pauses and pacing"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-56 text-xs">
                      Suggest speakers from pauses &amp; pacing — reviewed before anything is applied
                    </TooltipContent>
                  </Tooltip>
                )}
              </motion.div>

              {/* suggestion review bar — nothing is applied until a button says so */}
              {suggestions !== null && (
                <motion.div
                  initial={{ opacity: 0, y: reducedMotion ? 0 : 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' }}
                  role="status"
                  aria-live="polite"
                  className="mb-2 rounded-lg border border-violet-500/30 bg-violet-500/5 p-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-500 dark:text-violet-400" aria-hidden />
                    <p className="min-w-0 flex-1 text-xs">
                      <span className="font-medium tabular-nums">{activeSuggestions.length}</span>
                      {' '}suggestion{activeSuggestions.length === 1 ? '' : 's'} ·{' '}
                      <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">{highConfSuggestions.length}</span>
                      {' '}high-confidence
                      <span className="ml-1.5 hidden text-[11px] text-muted-foreground sm:inline">— nothing applied yet</span>
                    </p>
                    <Button
                      size="sm"
                      onClick={() => applySuggestions(0)}
                      disabled={activeSuggestions.length === 0}
                      className="h-7 border-emerald-600/50 bg-emerald-600 px-2.5 text-[11px] text-white hover:bg-emerald-600/90"
                    >
                      <Check className="mr-1 h-3 w-3" />Apply all
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => applySuggestions(SUGGEST_HIGH_CONFIDENCE)}
                      disabled={highConfSuggestions.length === 0}
                      className="h-7 px-2.5 text-[11px]"
                    >
                      Apply high-confidence only
                    </Button>
                    <Button size="sm" variant="ghost" onClick={exitReview} className="h-7 px-2.5 text-[11px]">
                      Discard
                    </Button>
                  </div>
                </motion.div>
              )}
            </>
          )}

          {/* speaker filter chips — view-only (exports & handoffs keep everything) */}
          {speakerInfo.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setSpeakerFilter(null)}
                    aria-pressed={speakerFilter === null}
                    data-active={speakerFilter === null || undefined}
                    className={cn(
                      'speaker-filter-chip inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-4 transition-opacity',
                      speakerFilter === null ? 'border-foreground/40 bg-foreground/5' : 'opacity-75 hover:opacity-100',
                    )}
                  >
                    All
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs tabular-nums">
                  {segments.length} segment{segments.length === 1 ? '' : 's'} total — show everything
                </TooltipContent>
              </Tooltip>
              {speakerInfo.map(({ name, count }) => (
                <Tooltip key={name}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setSpeakerFilter(speakerFilter === name ? null : name)}
                      aria-pressed={speakerFilter === name}
                      data-active={speakerFilter === name || undefined}
                      className={cn(
                        'speaker-filter-chip inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-4 transition-opacity',
                        speakerChipClass(name),
                        speakerFilter === name ? 'ring-1 ring-foreground/40' : 'opacity-75 hover:opacity-100',
                      )}
                    >
                      {name}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs tabular-nums">
                    {count} segment{count === 1 ? '' : 's'} — click to filter
                  </TooltipContent>
                </Tooltip>
              ))}
              <span className="text-[10px] text-muted-foreground">
                view-only — exports &amp; handoffs include every segment
                {speakerFilter !== null ? ` · ${visibleSegments.length}/${segments.length} shown` : ''}
              </span>
            </div>
          )}

          {segments.length === 0 && !interim ? (
            <div className="flex flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed py-10 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10">
                <AudioLines className="h-5 w-5 text-primary" aria-hidden />
              </div>
              <div>
                <p className="text-sm font-medium">Nothing transcribed yet</p>
                <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
                  Start a session to transcribe live, or type a line below and stamp it at the playhead.
                </p>
              </div>
            </div>
          ) : (
            <div ref={listRef} className="max-h-96 overflow-y-auto overscroll-contain pr-1" role="list" aria-label="Transcript segments">
              <div className="space-y-1">
                {visibleSegments.map((s) => {
                  const active = s.id === activeSegmentId;
                  const tier = confidenceTier(s.confidence);
                  // R11-b — suggestion for THIS row (keyed by index in the full segments array)
                  const segIdx = segmentIndexById.get(s.id) ?? -1;
                  const sugg = segIdx >= 0 ? suggestionByIndex.get(segIdx) : undefined;
                  const suggGap = sugg && sugg.reason === 'gap' && segIdx > 0
                    ? segments[segIdx].startSec - segments[segIdx - 1].endSec
                    : undefined;
                  const suggTitle = sugg
                    ? `${describeSuggestion(sugg, suggGap)} · ${Math.round(sugg.confidence * 100)}% confidence`
                    : '';
                  return (
                    <motion.div
                      key={s.id}
                      id={`seg-row-${s.id}`}
                      role="listitem"
                      initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' }}
                      className={cn(
                        'transcribe-segment-active group flex items-start gap-2 rounded-lg border-l-2 px-2 py-1.5 transition-colors',
                        active ? 'border-emerald-500 bg-emerald-500/5' : 'border-transparent hover:bg-muted/40',
                      )}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => seek(s.startSec)}
                            disabled={!hasRecording}
                            className="mt-0.5 shrink-0 rounded border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-emerald-600 disabled:cursor-default disabled:opacity-70 dark:hover:text-emerald-400"
                            title={hasRecording ? `Seek recording to ${formatChip(s.startSec)}` : 'Record audio to enable seeking'}
                          >
                            {formatChip(s.startSec)}
                          </button>
                        </TooltipTrigger>
                        {hasRecording && (
                          <TooltipContent side="top" className="text-xs">Seek recording to {formatChip(s.startSec)}</TooltipContent>
                        )}
                      </Tooltip>
                      {typeof s.speaker === 'string' && s.speaker.trim() ? (
                        <span
                          className={cn('speaker-chip mt-0.5 inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-medium leading-4', speakerChipClass(s.speaker))}
                          title={`Speaker: ${s.speaker}`}
                        >
                          {s.speaker}
                        </span>
                      ) : null}
                      <div className="min-w-0 flex-1">
                        {editingId === s.id ? (
                          <Input
                            autoFocus
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onBlur={() => commitEdit(s.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit(s.id);
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                            className="h-7 text-xs"
                            aria-label={`Edit segment at ${formatChip(s.startSec)}`}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setEditingId(s.id); setEditText(s.text); }}
                            className="block w-full text-left text-sm leading-relaxed text-foreground/90 hover:underline decoration-dotted underline-offset-4"
                            title="Click to edit"
                          >
                            {s.text}
                          </button>
                        )}
                      </div>
                      <div className="mt-0.5 flex shrink-0 items-center gap-1">
                        <Input
                          value={s.speaker ?? ''}
                          onChange={(e) => setSegmentSpeaker(s.id, e.target.value)}
                          list="transcribe-speaker-options"
                          placeholder="Speaker"
                          data-empty={!s.speaker?.trim() || undefined}
                          className="segment-speaker-input h-6 w-20 px-1.5 text-[10px]"
                          aria-label={`Speaker for segment at ${formatChip(s.startSec)} (empty = unassigned)`}
                        />
                        {sugg && (
                          <>
                            <span
                              title={suggTitle}
                              data-hot={sugg.confidence >= SUGGEST_HIGH_CONFIDENCE || undefined}
                              className={cn(
                                'speaker-suggestion-chip inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-medium leading-4 tabular-nums',
                                sugg.confidence >= SUGGEST_HIGH_CONFIDENCE
                                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                  : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
                              )}
                            >
                              S: {sugg.speaker} · {Math.round(sugg.confidence * 100)}%
                            </span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 shrink-0"
                                  onClick={() => acceptSuggestion(sugg)}
                                  aria-label={`Accept ${sugg.speaker} for segment at ${formatChip(s.startSec)}`}
                                >
                                  <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">Tag this segment {sugg.speaker}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 shrink-0"
                                  onClick={() => rejectSuggestion(sugg)}
                                  aria-label={`Reject ${sugg.speaker} for segment at ${formatChip(s.startSec)}`}
                                >
                                  <X className="h-3 w-3 text-rose-500/70 hover:text-rose-500" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">Skip this suggestion</TooltipContent>
                            </Tooltip>
                          </>
                        )}
                      </div>
                      <span
                        className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', CONFIDENCE_DOT[tier])}
                        title={tier === 'unknown' ? 'confidence not reported' : `confidence ${Math.round(s.confidence * 100)}%`}
                        aria-label={tier === 'unknown' ? 'confidence not reported' : `confidence ${Math.round(s.confidence * 100)} percent`}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 max-sm:opacity-100"
                        onClick={() => removeSegment(s.id)}
                        aria-label="Delete segment"
                      >
                        <Trash2 className="h-3 w-3 text-rose-500/70 hover:text-rose-500" />
                      </Button>
                    </motion.div>
                  );
                })}

                {speakerFilter !== null && visibleSegments.length === 0 && (
                  <p className="px-2 py-3 text-center text-[11px] text-muted-foreground" role="status">
                    No segments tagged “{speakerFilter}” — switch back to All to see the full transcript.
                  </p>
                )}

                {/* interim ghost line */}
                {interim && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="transcribe-ghost-line flex items-center gap-2 rounded-lg border border-dashed border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-xs italic text-muted-foreground">
                      {interim}
                      <span className="ml-0.5 animate-pulse not-italic text-emerald-500">▍</span>
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-emerald-600/70 dark:text-emerald-400/70">listening</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* manual stamping row */}
          {showManualRow && (
            <div className="mt-3 flex flex-col gap-2 rounded-lg border bg-muted/30 p-2.5 sm:flex-row sm:items-center">
              <Badge variant="outline" className="shrink-0 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400">
                <Stamp className="mr-1 h-3 w-3" />manual
              </Badge>
              <Input
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stampManual(); } }}
                placeholder="Type a line, then stamp it at the playhead…"
                className="h-8 min-w-0 flex-1 text-xs"
                aria-label="Manual transcript line"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="outline" onClick={stampManual} disabled={!manualText.trim() || stampDisabled} className="h-8 shrink-0">
                    <Stamp className="mr-1.5 h-3.5 w-3.5" />Stamp at playhead
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-56 text-xs">
                  {stampDisabled
                    ? 'Start a session or record audio first — the stamp needs a playhead'
                    : `Creates a segment at ${formatChip(recState !== 'idle' ? elapsedSec : playheadSec)} (+${MANUAL_STAMP_SEC}s)`}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </SectionPanel>
      </div>

      {/* ===== right column — settings, exports, draft ===== */}
      <div className="space-y-4">
        <SectionPanel title="Capture settings" description="Recognition language and fallback mode.">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="ts-lang">Recognition language</Label>
              <Select value={lang || 'default'} onValueChange={onLangChange}>
                <SelectTrigger id="ts-lang" className="h-8 text-xs" aria-label="Recognition language"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {SPEECH_LANGUAGES.map((l) => (
                    <SelectItem key={l.id || 'default'} value={l.id || 'default'}>{l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">Applies immediately — the engine restarts on the next pause in speech.</p>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-2.5">
              <div className="min-w-0 pr-2">
                <Label className="text-xs">Manual stamping</Label>
                <p className="text-[11px] text-muted-foreground">Type lines and stamp them at the playhead</p>
              </div>
              <Switch checked={manualMode} onCheckedChange={setManualMode} aria-label="Manual stamping mode" />
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-dashed p-2.5">
              {recognizerAvailable ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
              ) : (
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
              )}
              <p className="text-[11px] text-muted-foreground">
                {mounted
                  ? recognizerAvailable
                    ? 'Web Speech recognition detected — live captions enabled.'
                    : 'Speech recognition is unavailable here (Firefox / Safari). Manual mode keeps timestamps and exports working.'
                  : 'Detecting speech recognition support…'}
              </p>
            </div>
          </div>
        </SectionPanel>

        <SectionPanel title="Exports & handoffs" description="Generated entirely on-device — nothing uploads.">
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border p-2.5">
              <div className="min-w-0 pr-2">
                <Label className="text-xs">Timestamp prefixes</Label>
                <p className="text-[11px] text-muted-foreground">HH:MM:SS,mmm before each line</p>
              </div>
              <Switch checked={includeTimestamps} onCheckedChange={setIncludeTimestamps} aria-label="Timestamp prefixes" />
            </div>
            {speakerInfo.length > 0 && (
              <div className="flex items-center justify-between rounded-lg border p-2.5">
                <div className="min-w-0 pr-2">
                  <Label className="text-xs">Include speaker names</Label>
                  <p className="text-[11px] text-muted-foreground">Folds “Name: text” into .srt/.vtt exports</p>
                </div>
                <Switch checked={includeSpeakersOn} onCheckedChange={setIncludeSpeakers} aria-label="Include speaker names in .srt/.vtt exports" />
              </div>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="outline" onClick={copyTranscript} disabled={!segments.length} className="h-10 sm:h-8">
                    <Copy className="mr-1.5 h-3.5 w-3.5" />Copy
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Copy transcript as plain text</TooltipContent>
              </Tooltip>
              <Button size="sm" variant="outline" onClick={() => runExport('txt')} disabled={!segments.length || exporting} className="h-10 sm:h-8" aria-label="Download .txt">
                <FileText className="mr-1.5 h-3.5 w-3.5" />.txt
              </Button>
              <Button size="sm" variant="outline" onClick={() => runExport('srt')} disabled={!segments.length || exporting} className="h-10 sm:h-8" aria-label="Download .srt subtitles">
                <Captions className="mr-1.5 h-3.5 w-3.5" />.srt
              </Button>
              <Button size="sm" variant="outline" onClick={() => runExport('vtt')} disabled={!segments.length || exporting} className="h-10 sm:h-8" aria-label="Download .vtt subtitles">
                <Captions className="mr-1.5 h-3.5 w-3.5" />.vtt
              </Button>
            </div>
            {exporting && (
              <p className="text-[11px] text-muted-foreground" role="status">
                Building the export in the queue — watch progress in the activity view.
              </p>
            )}
            <Separator />
            <div className="grid gap-1.5">
              <Button size="sm" variant="outline" onClick={saveTranscriptAsset} disabled={!segments.length} className="h-10 justify-start sm:h-8">
                <Database className="mr-1.5 h-3.5 w-3.5" />Save transcript to Asset Bin
              </Button>
              <Button size="sm" variant="outline" onClick={saveRecordingAsset} disabled={!hasRecording} className="h-10 justify-start sm:h-8">
                <AudioLines className="mr-1.5 h-3.5 w-3.5" />Save recording to Asset Bin
              </Button>
            </div>
            <Separator />
            <Button onClick={sendToTts} disabled={!segments.length} className="h-10 w-full sm:h-9">
              <Send className="mr-1.5 h-4 w-4" />Send to TTS Studio
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Speaks the transcript back — speech → text → speech, the full round-trip.
            </p>
            <Separator />
            <div className="grid gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={sendToVideo}
                    disabled={cueableCount === 0}
                    className="h-10 justify-start sm:h-9"
                    aria-label="Send transcript to Video Editor as subtitle cues"
                  >
                    <Clapperboard className="mr-1.5 h-3.5 w-3.5" />Send to Video Editor
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-56 text-xs">
                  {cueableCount === 0
                    ? 'Needs at least one segment with a valid time extent'
                    : `Loads ${cueableCount} timed cue${cueableCount === 1 ? '' : 's'} on the subtitle track${speakerInfo.length > 0 ? ' — speaker tags ride along' : ''}`}
                </TooltipContent>
              </Tooltip>
              <Popover open={chapterOpen} onOpenChange={setChapterOpen}>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!segments.length}
                    className="h-10 justify-start sm:h-9"
                    aria-expanded={chapterOpen}
                    aria-label="Send transcript to Audiobook Studio as chapters"
                  >
                    <BookOpen className="mr-1.5 h-3.5 w-3.5" />Send to Audiobook Studio
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" className="w-72 space-y-3">
                  <div className="space-y-0.5">
                    <p className="text-xs font-medium">Split the transcript into chapters</p>
                    <p className="text-[11px] text-muted-foreground">Empty segments are skipped — the preview updates live.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs" htmlFor="ts-chapter-gap">Split on silence gaps ≥</Label>
                    <div className="flex items-center gap-1.5">
                      <Input
                        id="ts-chapter-gap"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={0.1}
                        value={chapterGapRaw}
                        onChange={(e) => setChapterGapRaw(e.target.value)}
                        className="h-7 w-20 text-xs tabular-nums"
                        aria-label="Minimum silence gap in seconds that starts a new chapter"
                      />
                      <span className="text-[11px] text-muted-foreground">seconds (end → start)</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs" htmlFor="ts-chapter-every">Fallback: split every</Label>
                    <div className="flex items-center gap-1.5">
                      <Input
                        id="ts-chapter-every"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        value={chapterEveryRaw}
                        onChange={(e) => setChapterEveryRaw(e.target.value)}
                        className="h-7 w-20 text-xs tabular-nums"
                        aria-label="Maximum number of segments per chapter before forcing a split"
                      />
                      <span className="text-[11px] text-muted-foreground">segments</span>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground" aria-live="polite">
                    ≈ <span className="font-medium tabular-nums text-foreground">{previewChapters.length}</span> chapter{previewChapters.length === 1 ? '' : 's'}
                    {' '}from {segments.length} segment{segments.length === 1 ? '' : 's'}
                  </p>
                  <Button size="sm" className="h-9 w-full" onClick={sendToAudiobook} disabled={!previewChapters.length}>
                    <Send className="mr-1.5 h-3.5 w-3.5" />Send
                  </Button>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </SectionPanel>

        <SectionPanel title="Draft" description="Autosaved on-device (segments + language).">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400">
                <CloudUpload className="h-3 w-3" />
                {draftSavedAt ? `draft saved ${new Date(draftSavedAt).toLocaleTimeString()}` : 'draft pending'}
              </Badge>
              {draftSavedAt && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] text-rose-500 hover:text-rose-600"
                  onClick={() => void discardDraft()}
                >
                  Discard draft
                </Button>
              )}
            </div>
            {draftRecordingNotice && (
              <p className="rounded-lg border border-dashed bg-muted/30 p-2 text-[11px] text-muted-foreground">
                Recording not kept in draft — re-record to attach audio.
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              Audio blobs are deliberately excluded to keep the draft light; everything else survives a reload.
            </p>
          </div>
        </SectionPanel>
      </div>
    </div>
  );
}
