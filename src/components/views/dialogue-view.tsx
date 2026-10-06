'use client';

/**
 * Dialogue Studio — multi-speaker script renderer (module 12).
 *
 * Write a cast of speakers, assign each a voice profile (built-in or custom), then author
 * a screenplay-style script ("Name: line"). Every line renders with its
 * speaker's voice through the local formant/markup engine and the takes are
 * stitched — with configurable inter-line pauses — into a single audio file.
 * Everything runs on-device.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/lib/stores/app-store';
import { enqueueJob } from '@/lib/queue';
import { allVoiceProfiles, estimateSpeechDurationSec, isCustomProfile } from '@/lib/engines/formant';
import { synthesizeWithMarkup, parseVoiceMarkup, estimateMarkupDurationSec } from '@/lib/engines/markup';
import { applyLexicon, loadLexicon, type LexiconRule } from '@/lib/engines/lexicon';
import { saveDialogueDraft, loadDialogueDraft, clearDialogueDraft, dialogueDraftHasContent, type DialogueDraft } from '@/lib/engines/dialogue-db';
import { buildSrt } from '@/lib/engines/video-render';
import { aiDirectDialogue } from '@/lib/engines/ai-services';
import { AUDIO_FORMATS, encodeAudioBufferChunked, getFormat } from '@/lib/engines/encode';
import { concatenateBuffers, makeSilenceBuffer, normalizeBuffer } from '@/lib/engines/dsp';
import type { AssetItem, SubtitleCue } from '@/lib/types';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { formatDuration, formatNumber } from '@/lib/utils/format';
import { uid } from '@/lib/utils/async';
import {
  BookOpen, Braces, Captions, ChevronDown, ChevronUp, Clapperboard, CloudUpload, Download, FileJson, MessagesSquare, Pause, Play, Plus,
  Sparkles, Square, Trash2, Upload, Volume2, VolumeX, Users, Wand2, Waypoints,
} from 'lucide-react';

// ---------- speaker palette (no blues) ----------
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

const DEFAULT_ROTATION = ['atlas-narrator', 'nova-narrator', 'aura-bright', 'storyteller', 'aura-warm', 'whisper-soft'];

interface DialogueLine {
  id: string;
  speaker: string;
  text: string;
  muted: boolean;
}

/** Per-line timing captured during a full-cast render — becomes a subtitle cue 1:1. */
interface LineTiming {
  speaker: string;
  text: string; // ORIGINAL line text (subtitles show what was written, not the lexicon-resolved text)
  startSec: number;
  endSec: number;
}

interface CastMember {
  voiceProfile: string;
  rate: number;
  pitch: number;
  /** Speaker group — undefined = actor (default). Narrators get distinct styling. */
  group?: 'narrator' | 'actor';
}

const NARRATOR_NAME_RE = /narrator/i;

function newCastMember(speaker: string, profileIdx: number): CastMember {
  return {
    voiceProfile: DEFAULT_ROTATION[profileIdx % DEFAULT_ROTATION.length],
    rate: 1,
    pitch: 1,
    group: NARRATOR_NAME_RE.test(speaker) ? 'narrator' : undefined,
  };
}

function colorFor(speakers: string[], speaker: string) {
  const idx = Math.max(0, speakers.indexOf(speaker));
  return SPEAKER_COLORS[idx % SPEAKER_COLORS.length];
}

const SAMPLE_SCRIPT = `Narrator: The observatory hummed at midnight. [pause 400] Dr. Vance pressed her palm to the cold alloy door.
Vance: Orbital, run diagnostic level three. [em]Everything[/em], not just the array.
Orbital: Diagnostic running. Estimated time, forty seconds. Shall I dim the lights?
Narrator: Somewhere below the floor, the machine began to count.
Vance: [whisper]There — did you hear that?[/whisper]
Orbital: I hear everything you hear, Doctor. Plus the things you cannot.
Narrator: [rate 0.9]And for the first time in eleven years, nobody answered her.`;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function DialogueView() {
  const { toast } = useToast();
  const tuned = useAppStore((s) => s.tuned);
  const settings = useAppStore((s) => s.settings);
  const addAsset = useAppStore((s) => s.addAsset);
  const setView = useAppStore((s) => s.setView);
  const setPendingSubtitleCues = useAppStore((s) => s.setPendingSubtitleCues);
  const customProfiles = useAppStore((s) => s.customProfiles);
  const reducedMotion = useReducedMotion();

  const [title, setTitle] = useState('Untitled Dialogue');
  const [lines, setLines] = useState<DialogueLine[]>([]);
  const [cast, setCast] = useState<Record<string, CastMember>>({});
  const [gapMs, setGapMs] = useState(450);
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [expandedLine, setExpandedLine] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [useLexicon, setUseLexicon] = useState(true);
  const [lexiconRules, setLexiconRules] = useState<LexiconRule[]>([]);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  // speaker-tagged subtitle handoff (Dialogue → Video Editor / .srt)
  const lastLineTimingsRef = useRef<LineTiming[]>([]);
  const scriptVersionRef = useRef(0);
  const [hasTimings, setHasTimings] = useState(false); // 0 → false, cue count → true (set after a full render)
  const [srtWithSpeakers, setSrtWithSpeakers] = useState(true);
  // draft autosave (IndexedDB)
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const draftReadyRef = useRef(false);

  const previewSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const previewCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    setLexiconRules(loadLexicon());
    // restore a persisted draft once, before autosave kicks in
    void (async () => {
      try {
        const draft = await loadDialogueDraft();
        if (dialogueDraftHasContent(draft) && draft) {
          setTitle(draft.title || 'Untitled Dialogue');
          setLines(draft.lines.map((l) => ({ ...l })));
          // tolerant cast restore: older drafts have no `group` field (missing = actor)
          setCast(Object.fromEntries(Object.entries(draft.cast).map(([k, v]) => [k, {
            voiceProfile: typeof v.voiceProfile === 'string' ? v.voiceProfile : 'aura-neutral',
            rate: typeof v.rate === 'number' ? v.rate : 1,
            pitch: typeof v.pitch === 'number' ? v.pitch : 1,
            group: v.group === 'narrator' || v.group === 'actor' ? v.group : undefined,
          }])));
          setGapMs(draft.gapMs);
          setUseLexicon(draft.useLexicon);
          setDraftSavedAt(draft.savedAt);
          toast({ title: 'Draft restored', description: `Dialogue “${draft.title || 'Untitled'}” recovered from on-device storage.` });
        }
      } catch { /* best-effort */ } finally {
        draftReadyRef.current = true;
      }
    })();
    return () => {
      try { previewSrcRef.current?.stop(); } catch { /* stopped */ }
      void previewCtxRef.current?.close();
    };
  }, []);

  // debounced draft autosave — only after the restore pass finished
  useEffect(() => {
    if (!draftReadyRef.current) return;
    const draft: Omit<DialogueDraft, 'key' | 'savedAt'> = {
      title, lines: lines.map((l) => ({ id: l.id, speaker: l.speaker, text: l.text, muted: l.muted })),
      cast, gapMs, useLexicon,
    };
    const t = setTimeout(() => {
      void saveDialogueDraft({ ...draft, savedAt: Date.now() }).then(() => setDraftSavedAt(Date.now()));
    }, 1200);
    return () => clearTimeout(t);
  }, [title, lines, cast, gapMs, useLexicon]);

  // any script mutation (line edit/reorder/mute, cast change, gap, lexicon toggle)
  // bumps the version and drops the previous render's cue timings — the handoff
  // buttons stay disabled until the current script has been rendered again
  useEffect(() => {
    scriptVersionRef.current += 1;
    lastLineTimingsRef.current = [];
    setHasTimings(false);
  }, [lines, cast, gapMs, useLexicon]);

  const speakers = useMemo(() => [...new Set(lines.map((l) => l.speaker))], [lines]);

  // Built-in + custom (Voice Library) voice profiles — recomputed when the store's
  // customProfiles array changes so cast rows re-render when voices are added or
  // deleted. Engine registration itself is handled by the app-store mirror.
  const voiceProfiles = useMemo(() => allVoiceProfiles(), [customProfiles]);

  const ensureCastFor = useCallback((speaker: string) => {
    setCast((c) => {
      if (c[speaker]) return c;
      const idx = Object.keys(c).length;
      return { ...c, [speaker]: newCastMember(speaker, idx) };
    });
  }, []);

  const addLine = useCallback((speaker = 'Narrator', text = '') => {
    setLines((l) => [...l, { id: uid('line'), speaker, text, muted: false }]);
    ensureCastFor(speaker);
  }, [ensureCastFor]);

  const parseScript = useCallback((raw: string, replace: boolean) => {
    const parsed: DialogueLine[] = [];
    const castSeen: Record<string, CastMember> = replace ? {} : { ...cast };
    let nextIdx = Object.keys(castSeen).length;
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = /^([^:]{1,32}):\s*(.+)$/.exec(line);
      if (m) {
        const speaker = m[1].trim();
        parsed.push({ id: uid('line'), speaker, text: m[2].trim(), muted: false });
        if (!castSeen[speaker]) {
          castSeen[speaker] = newCastMember(speaker, nextIdx);
          nextIdx++;
        }
      } else {
        // continuation text → attach to previous speaker or the stage default
        const last = parsed[parsed.length - 1];
        const speaker = last?.speaker ?? 'Narrator';
        if (last) last.text = `${last.text} ${line}`.trim();
        else parsed.push({ id: uid('line'), speaker, text: line, muted: false });
        if (!castSeen[speaker]) {
          castSeen[speaker] = newCastMember(speaker, nextIdx);
          nextIdx++;
        }
      }
    }
    if (!parsed.length) {
      toast({ title: 'Nothing to import', description: 'Use "Name: line" format — one line of dialogue per row.' });
      return;
    }
    setCast(castSeen);
    setLines((l) => (replace ? parsed : [...l, ...parsed]));
    setPasteOpen(false);
    setPasteText('');
    toast({ title: replace ? 'Script imported' : 'Lines appended', description: `${parsed.length} line${parsed.length === 1 ? '' : 's'} · ${Object.keys(castSeen).length} speakers.` });
  }, [cast, toast]);

  const moveLine = useCallback((id: string, dir: -1 | 1) => {
    setLines((l) => {
      const i = l.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= l.length) return l;
      const copy = [...l];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }, []);

  const prepare = useCallback((text: string) => {
    const lexed = useLexicon ? applyLexicon(text, lexiconRules).text : text;
    return lexed;
  }, [useLexicon, lexiconRules]);

  const estLineSec = useCallback((l: DialogueLine) => {
    if (l.muted || !l.text.trim()) return 0;
    const member = cast[l.speaker] ?? { voiceProfile: 'aura-neutral', rate: 1, pitch: 1 };
    const prepared = prepare(l.text);
    const info = parseVoiceMarkup(prepared, { rate: member.rate, pitch: member.pitch, volume: 1 });
    return info.hasMarkup ? estimateMarkupDurationSec(prepared, member.rate) : estimateSpeechDurationSec(prepared, member.rate);
  }, [cast, prepare]);

  const stats = useMemo(() => {
    const speakable = lines.filter((l) => !l.muted && l.text.trim());
    const words = speakable.reduce((a, l) => a + l.text.trim().split(/\s+/).length, 0);
    const speech = speakable.reduce((a, l) => a + estLineSec(l), 0);
    const pauses = Math.max(0, speakable.length - 1) * (gapMs / 1000);
    return { lines: lines.length, speakable: speakable.length, words, speakers: speakers.length, estSec: speech + pauses };
  }, [lines, speakers.length, gapMs, estLineSec]);

  const stopPreview = useCallback(() => {
    try { previewSrcRef.current?.stop(); } catch { /* stopped */ }
    previewSrcRef.current = null;
    setPreviewingId(null);
  }, []);

  const previewLine = useCallback(async (l: DialogueLine) => {
    if (previewingId === l.id) { stopPreview(); return; }
    stopPreview();
    if (!l.text.trim() || l.muted) return;
    const member = cast[l.speaker] ?? { voiceProfile: 'aura-neutral', rate: 1, pitch: 1 };
    setPreviewingId(l.id);
    try {
      const buf = await synthesizeWithMarkup(prepare(l.text), {
        profileId: member.voiceProfile, rate: member.rate, pitch: member.pitch, volume: 1, quality: tuned.synthesisQuality,
      });
      const ctx = previewCtxRef.current ?? new AudioContext();
      previewCtxRef.current = ctx;
      if (ctx.state === 'suspended') void ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => {
        if (previewSrcRef.current === src) { previewSrcRef.current = null; setPreviewingId(null); }
      };
      previewSrcRef.current = src;
      src.start();
    } catch (e) {
      setPreviewingId(null);
      toast({ title: 'Preview failed', description: String(e), variant: 'destructive' });
    }
  }, [previewingId, cast, prepare, tuned.synthesisQuality, stopPreview, toast]);

  const renderDialogue = useCallback(() => {
    const speakable = lines.filter((l) => !l.muted && l.text.trim());
    if (!speakable.length || rendering) return;
    setRendering(true);
    setRenderProgress(0);
    const fmtId = settings.outputFormat || 'wav-16';
    const rulesSnapshot = lexiconRules;
    const lexOn = useLexicon;
    const vAtStart = scriptVersionRef.current; // timings only stay fresh if the script is untouched during the render
    enqueueJob(
      { type: 'tts-render', label: `Dialogue: ${title}` },
      async (api) => {
        const renderSpeakers = [...new Set(speakable.map((l) => l.speaker))];
        const narratorCount = renderSpeakers.filter((s) => cast[s]?.group === 'narrator').length;
        const actorCount = renderSpeakers.length - narratorCount;
        api.log(`Cast: ${renderSpeakers.length} speakers (${narratorCount} narrator${narratorCount === 1 ? '' : 's'}, ${actorCount} actor${actorCount === 1 ? '' : 's'})`);
        const pieces: AudioBuffer[] = [];
        const lexApplied: string[] = [];
        // per-line cursor timing — matches the stitched take exactly: each piece
        // (line buffer + optional gap silence) lands back-to-back via
        // concatenateBuffers(…, 0), and normalizeBuffer rescales amplitude only
        const lineTimings: LineTiming[] = [];
        let cursorSec = 0;
        for (let i = 0; i < speakable.length; i++) {
          const l = speakable[i];
          const member = cast[l.speaker] ?? { voiceProfile: 'aura-neutral', rate: 1, pitch: 1 };
          let prepared = l.text;
          if (lexOn) {
            const rep = applyLexicon(prepared, rulesSnapshot);
            prepared = rep.text;
            rep.applied.forEach((w) => lexApplied.push(w));
          }
          const buf = await synthesizeWithMarkup(prepared, {
            profileId: member.voiceProfile, rate: member.rate, pitch: member.pitch, volume: 1, quality: tuned.synthesisQuality,
          });
          lineTimings.push({ speaker: l.speaker, text: l.text, startSec: cursorSec, endSec: cursorSec + buf.duration });
          cursorSec += buf.duration + (i < speakable.length - 1 && gapMs > 0 ? gapMs / 1000 : 0);
          pieces.push(buf);
          if (i < speakable.length - 1 && gapMs > 0) {
            pieces.push(makeSilenceBuffer(gapMs / 1000, buf.sampleRate, 1));
          }
          api.setProgress((i + 1) / speakable.length * 0.8, `Line ${i + 1}/${speakable.length} — ${l.speaker}`);
          await api.waitWhilePaused();
        }
        api.log(`Synthesized ${speakable.length} lines${lexApplied.length ? ` · lexicon: ${[...new Set(lexApplied)].slice(0, 6).join(', ')}${lexApplied.length > 6 ? '…' : ''}` : ''}`);
        if (api.shouldCancel()) return;
        api.setProgress(0.85, 'Stitching takes…');
        const joined = pieces.length === 1 ? pieces[0] : await concatenateBuffers(pieces, 0);
        const norm = normalizeBuffer(joined, -1);
        api.setProgress(0.88, `Encoding ${getFormat(fmtId)?.label ?? fmtId}…`);
        const blob = await encodeAudioBufferChunked(norm, fmtId, { channels: 1 }, (p) =>
          api.setProgress(0.88 + p * 0.12, `Encoding ${(p * 100).toFixed(0)}%`));
        const fmt = getFormat(fmtId);
        const asset: AssetItem = {
          id: uid('asset'),
          name: `${title || 'dialogue'}.${fmt?.extension ?? 'wav'}`.replace(/\s+/g, '-').toLowerCase(),
          kind: 'audio',
          createdAt: Date.now(),
          mimeType: fmt?.mime ?? 'audio/wav',
          sizeBytes: blob.size,
          durationSec: norm.duration,
          buffer: norm,
          blobUrl: URL.createObjectURL(blob),
          meta: { source: 'dialogue-studio', speakers: speakers.length, lines: speakable.length },
        };
        addAsset(asset);
        api.log(`Encoded ${asset.name}`);
        // publish the timings for the subtitle handoff — only when the script did
        // not change while the render was in flight (otherwise the take is stale)
        if (scriptVersionRef.current === vAtStart) {
          lastLineTimingsRef.current = lineTimings;
          setHasTimings(true);
        }
        return { fileName: asset.name, bytes: blob.size, durationSec: norm.duration, lineTimings };
      },
    );
    const t = setInterval(() => {
      const job = useAppStore.getState().jobs.find((j) => j.label === `Dialogue: ${title}`);
      if (job && ['done', 'error', 'cancelled'].includes(job.status)) {
        clearInterval(t);
        setRendering(false);
        setRenderProgress(job.status === 'done' ? 1 : 0);
        if (job.status === 'done') toast({ title: 'Dialogue rendered', description: 'The full cast recording is in the asset bin.' });
        else if (job.status === 'error') toast({ title: 'Render failed', description: job.error, variant: 'destructive' });
      } else if (job) {
        setRenderProgress(job.progress);
      }
    }, 500);
  }, [lines, rendering, title, settings.outputFormat, lexiconRules, useLexicon, cast, gapMs, tuned.synthesisQuality, speakers.length, addAsset, toast]);

  // ---------- script import / export ----------
  const exportJson = useCallback(() => {
    const data = {
      format: 'auravoice-dialogue/1',
      title,
      gapMs,
      cast: Object.fromEntries(Object.entries(cast).map(([k, v]) => [k, {
        voiceProfile: v.voiceProfile, rate: v.rate, pitch: v.pitch, group: v.group,
      }])),
      lines: lines.map((l) => ({ speaker: l.speaker, text: l.text, muted: l.muted })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/\s+/g, '-').toLowerCase()}-script.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, [title, gapMs, cast, lines]);

  const importJson = useCallback(async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as {
        title?: string; gapMs?: number;
        cast?: Record<string, CastMember>;
        lines?: { speaker: string; text: string; muted?: boolean }[];
      };
      if (!Array.isArray(data.lines)) throw new Error('No lines array');
      setTitle(data.title ?? title);
      setGapMs(typeof data.gapMs === 'number' ? data.gapMs : gapMs);
      // preserve group on cast entries; tolerate missing/unknown values (missing = actor)
      setCast(Object.fromEntries(Object.entries(data.cast ?? {}).map(([k, v]) => [k, {
        voiceProfile: typeof v.voiceProfile === 'string' ? v.voiceProfile : 'aura-neutral',
        rate: typeof v.rate === 'number' ? v.rate : 1,
        pitch: typeof v.pitch === 'number' ? v.pitch : 1,
        group: v.group === 'narrator' || v.group === 'actor' ? v.group : undefined,
      }])));
      setLines(data.lines.map((l) => ({ id: uid('line'), speaker: l.speaker, text: l.text, muted: Boolean(l.muted) })));
      toast({ title: 'Script loaded', description: `${data.lines.length} lines imported.` });
    } catch (e) {
      toast({ title: 'Import failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    }
  }, [title, gapMs, toast]);

  // ---------- subtitle handoff (speaker-tagged cues from the last full render) ----------
  const sendCuesToVideo = useCallback(() => {
    const timings = lastLineTimingsRef.current;
    if (!timings.length) return;
    const cues: SubtitleCue[] = timings.map((l) => ({ startSec: l.startSec, endSec: l.endSec, text: l.text, speaker: l.speaker }));
    setPendingSubtitleCues(cues);
    setView('video');
    toast({ title: `${cues.length} speaker-tagged cue${cues.length === 1 ? '' : 's'} sent`, description: 'They burn into exports in the Video Editor.' });
  }, [setPendingSubtitleCues, setView, toast]);

  const downloadDialogueSrt = useCallback(() => {
    const timings = lastLineTimingsRef.current;
    if (!timings.length) return;
    // buildSrt passes cue text through verbatim, so the optional speaker prefix
    // is folded into the text here (buildSrt's signature stays untouched)
    const cues: SubtitleCue[] = timings.map((l) => ({
      startSec: l.startSec,
      endSec: l.endSec,
      text: srtWithSpeakers ? `${l.speaker}: ${l.text}` : l.text,
    }));
    const blob = new Blob([buildSrt(cues)], { type: 'application/x-subrip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(title || 'dialogue').replace(/\s+/g, '-').toLowerCase()}-subtitles.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast({ title: '.srt downloaded', description: `${cues.length} cue${cues.length === 1 ? '' : 's'}${srtWithSpeakers ? ' · speaker names included' : ''}.` });
  }, [srtWithSpeakers, title, toast]);

  // ref-backed values render fine here: they change exactly when hasTimings flips
  const cueCount = hasTimings ? lastLineTimingsRef.current.length : 0;
  const cuesEndSec = hasTimings && lastLineTimingsRef.current.length ? lastLineTimingsRef.current[lastLineTimingsRef.current.length - 1].endSec : 0;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      {/* left column — script */}
      <div className="space-y-4">
        <SectionPanel
          title="Production"
          description="Name the take and manage the script."
          actions={
            <div className="flex flex-wrap gap-1.5">
              <Popover open={pasteOpen} onOpenChange={setPasteOpen}>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline"><Upload className="mr-1.5 h-3.5 w-3.5" />Parse script</Button>
                </PopoverTrigger>
                <PopoverContent className="w-96" align="end">
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Parse a screenplay</div>
                    <p className="text-[11px] text-muted-foreground">One line of dialogue per row, in <span className="font-mono">Name: text</span> format. Unprefixed rows continue the previous speaker.</p>
                    <Textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} className="min-h-32 font-mono text-xs" placeholder={'Vance: Run diagnostic level three.\nOrbital: Running. Forty seconds.'} aria-label="Script to parse" />
                    <div className="flex gap-1.5">
                      <Button size="sm" onClick={() => parseScript(pasteText, true)} disabled={!pasteText.trim()}>Replace script</Button>
                      <Button size="sm" variant="outline" onClick={() => parseScript(pasteText, false)} disabled={!pasteText.trim()}>Append</Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
              <Button size="sm" variant="ghost" onClick={() => { setTitle('Midnight Diagnostic'); parseScript(SAMPLE_SCRIPT, true); }}>
                <Wand2 className="mr-1.5 h-3.5 w-3.5" />Sample
              </Button>
              <Button size="sm" onClick={() => addLine('Narrator')}><Plus className="mr-1.5 h-3.5 w-3.5" />Add line</Button>
              <Button size="sm" variant="outline" onClick={async () => {
                const dir = await aiDirectDialogue(lines.map((l) => ({ id: l.id, speaker: l.speaker, text: l.text })));
                if (dir.ok && dir.value) {
                  setLines((prev) => prev.map((l) => {
                    const d = dir.value!.find((x) => x.id === l.id);
                    return d ? { ...l, emotion: d.emotion } : l;
                  }));
                  toast({ title: 'AI dialogue direction', description: `${dir.value.length} lines scored with delivery emotion.` });
                } else {
                  toast({ title: 'AI direction failed', description: dir.error ?? 'Try again.', variant: 'destructive' });
                }
              }}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />AI score
              </Button>
              {draftSavedAt && (
                <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600" title={`Draft saved ${new Date(draftSavedAt).toLocaleTimeString()} — survives reloads`}>
                  <CloudUpload className="h-3 w-3" />draft saved
                </Badge>
              )}
              {draftSavedAt && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] text-rose-500 hover:text-rose-600"
                  title="Clear the on-device draft (keeps the current script in this session)"
                  onClick={async () => {
                    draftReadyRef.current = false;
                    await clearDialogueDraft();
                    setDraftSavedAt(null);
                    draftReadyRef.current = true;
                    toast({ title: 'Draft discarded', description: 'Autosave continues from your next edit.' });
                  }}
                >
                  Discard draft
                </Button>
              )}
            </div>
          }
        >
          <div className="flex items-center gap-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-9 flex-1 font-medium" aria-label="Production title" placeholder="Production title" />
            <Badge variant="outline" className="tabular-nums">{stats.speakable}/{stats.lines} lines</Badge>
            <Badge variant="outline" className="tabular-nums">{stats.speakers} speakers</Badge>
            <Badge variant="outline" className="tabular-nums">≈ {formatDuration(stats.estSec)}</Badge>
          </div>
        </SectionPanel>

        {lines.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-14 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
              <MessagesSquare className="h-6 w-6 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">No lines yet</p>
              <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
                Add lines manually, paste a screenplay with <span className="font-mono">Name: text</span> rows, or load the sample production to hear a two-actor scene.
              </p>
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => addLine('Narrator')}><Plus className="mr-1.5 h-3.5 w-3.5" />Add line</Button>
              <Button size="sm" variant="outline" onClick={() => { setTitle('Midnight Diagnostic'); parseScript(SAMPLE_SCRIPT, true); }}><Sparkles className="mr-1.5 h-3.5 w-3.5" />Load sample</Button>
            </div>
          </div>
        ) : (
          <SectionPanel
            title="Script"
            description="Chat-style takes — every line renders in its speaker's voice."
            actions={
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={exportJson} title="Export script as JSON"><FileJson className="mr-1.5 h-3.5 w-3.5" />JSON</Button>
                <label className="inline-flex cursor-pointer items-center">
                  <Button size="sm" variant="ghost" asChild>
                    <span><Braces className="mr-1.5 h-3.5 w-3.5" />Import</span>
                  </Button>
                  <input type="file" accept=".json,application/json" className="sr-only"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ''; }}
                    aria-label="Import script JSON" />
                </label>
              </div>
            }
          >
            <ScrollArea className="max-h-[520px] pr-3">
              <div className="space-y-2.5">
                {lines.map((l, i) => {
                  const color = colorFor(speakers, l.speaker);
                  const member = cast[l.speaker];
                  const isNarrator = member?.group === 'narrator';
                  const memberVoice = member ? voiceProfiles.find((v) => v.id === member.voiceProfile) : undefined;
                  const info = parseVoiceMarkup(prepare(l.text), { rate: member?.rate ?? 1, pitch: member?.pitch ?? 1, volume: 1 });
                  const flip = i % 2 === 1;
                  return (
                    <div key={l.id} className={cn('group flex gap-2.5', flip && 'flex-row-reverse')} data-line-id={l.id}>
                      <div
                        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm"
                        style={{ backgroundColor: color.dot }}
                        title={l.speaker}
                        aria-hidden
                      >
                        {initialsOf(l.speaker)}
                      </div>
                      <div
                        className={cn(
                          'min-w-0 max-w-[85%] flex-1 rounded-xl border p-2.5 transition-shadow group-hover:shadow-sm',
                          flip && 'rounded-tr-sm',
                          !flip && 'rounded-tl-sm',
                          isNarrator && 'dialogue-narrator-bubble border-dashed border-l-2 bg-muted/50 dark:bg-muted/30',
                        )}
                        style={{ backgroundColor: isNarrator ? undefined : color.soft }}
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            className="text-xs font-semibold hover:underline"
                            onClick={() => { const s = prompt('Rename speaker', l.speaker); if (s && s.trim()) { const name = s.trim().slice(0, 32); ensureCastFor(name); setLines((ls) => ls.map((x) => (x.id === l.id ? { ...x, speaker: name } : x))); } }}
                            title="Rename speaker"
                          >
                            {l.speaker}
                          </button>
                          {isNarrator && (
                            <Badge variant="outline" className="h-4 border-zinc-500/30 bg-zinc-500/10 px-1.5 text-[9px] font-normal text-zinc-600 dark:text-zinc-400">
                              <BookOpen className="mr-0.5 h-2.5 w-2.5" />narrator
                            </Badge>
                          )}
                          {member && (
                            <Badge
                              variant={memberVoice ? 'secondary' : 'outline'}
                              className={cn('h-4 px-1.5 text-[9px] font-normal', !memberVoice && 'border-amber-500/40 bg-amber-500/10 text-amber-600')}
                              title={memberVoice ? undefined : 'Voice missing — using default'}
                            >
                              {memberVoice?.name ?? member.voiceProfile}
                            </Badge>
                          )}
                          {info.hasMarkup && (
                            <Badge variant="outline" className="h-4 border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[9px] text-emerald-600">markup</Badge>
                          )}
                          {l.muted && <Badge variant="outline" className="h-4 px-1.5 text-[9px]">muted</Badge>}
                          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">≈ {formatDuration(estLineSec(l))}</span>
                        </div>
                        {expandedLine === l.id ? (
                          <Textarea
                            value={l.text}
                            onChange={(e) => setLines((ls) => ls.map((x) => (x.id === l.id ? { ...x, text: e.target.value } : x)))}
                            onBlur={() => setExpandedLine((cur) => (cur === l.id ? null : cur))}
                            className="min-h-20 resize-y bg-background/70 text-sm"
                            autoFocus
                            aria-label={`Edit line ${i + 1}`}
                            placeholder="Line text — [pause 500], [em]…[/em] markup is honored."
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setExpandedLine(l.id)}
                            className={cn('block w-full text-left text-sm leading-relaxed text-foreground/90', isNarrator && 'italic')}
                            title="Click to edit"
                          >
                            {l.text || <span className="italic text-muted-foreground">Empty line — click to write…</span>}
                          </button>
                        )}
                        <div className={cn('mt-1.5 flex items-center gap-0.5', flip && 'flex-row-reverse')}>
                          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => void previewLine(l)} disabled={l.muted || !l.text.trim()}
                            aria-label={previewingId === l.id ? 'Stop preview' : 'Preview line'} title="Preview this line">
                            {previewingId === l.id ? <Square className="h-3 w-3 text-rose-500" /> : <Play className="h-3 w-3" />}
                          </Button>
                          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setLines((ls) => ls.map((x) => (x.id === l.id ? { ...x, muted: !x.muted } : x)))}
                            aria-label={l.muted ? 'Unmute line' : 'Mute line'} title={l.muted ? 'Unmute' : 'Mute (skipped in render)'}>
                            {l.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
                          </Button>
                          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => moveLine(l.id, -1)} disabled={i === 0} aria-label="Move line up" title="Move up"><ChevronUp className="h-3 w-3" /></Button>
                          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => moveLine(l.id, 1)} disabled={i === lines.length - 1} aria-label="Move line down" title="Move down"><ChevronDown className="h-3 w-3" /></Button>
                          <Button size="icon" variant="ghost" className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100" onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}
                            aria-label="Delete line" title="Delete line"><Trash2 className="h-3 w-3 text-rose-500/70 hover:text-rose-500" /></Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <span className="rounded border border-dashed px-1.5 py-0.5 text-[10px]">narrator</span>
              <span className="rounded border px-1.5 py-0.5 text-[10px]">actor</span>
              <span>narrator takes read italic with a dimmed bubble — set the group per speaker in Cast &amp; voices</span>
            </div>
            {rendering && (
              <div className="mt-3 space-y-1">
                <Progress value={renderProgress * 100} className="h-1.5" />
                <p className="text-[11px] text-muted-foreground">Rendering dialogue — {Math.round(renderProgress * 100)}%</p>
              </div>
            )}
          </SectionPanel>
        )}
      </div>

      {/* right column — cast, delivery, export */}
      <div className="space-y-4">
        <SectionPanel
          title="Cast & voices"
          description="Voice, rate and pitch per speaker."
          actions={<Badge variant="outline" className="text-[10px]"><Users className="mr-1 h-3 w-3" />{speakers.length}</Badge>}
        >
          {speakers.length === 0 ? (
            <p className="text-xs text-muted-foreground">Speakers appear here once the script has lines.</p>
          ) : (
            <div className="space-y-3">
              {speakers.map((sp) => {
                const member = cast[sp] ?? { voiceProfile: 'aura-neutral', rate: 1, pitch: 1 };
                const color = colorFor(speakers, sp);
                const lineCount = lines.filter((l) => l.speaker === sp && !l.muted).length;
                return (
                  <div key={sp} className="space-y-2 rounded-lg border p-2.5" style={{ borderColor: `${color.dot}40` }}>
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color.dot }} aria-hidden />
                      <span className="min-w-0 truncate text-sm font-semibold">{sp}</span>
                      <Select
                        value={member.group ?? 'actor'}
                        onValueChange={(v) => setCast((c) => ({ ...c, [sp]: { ...member, group: v === 'narrator' ? 'narrator' : 'actor' } }))}
                      >
                        <SelectTrigger className="ml-auto h-7 w-24 shrink-0 text-[10px]" aria-label={`${sp} group`} title="Speaker group — narrators get distinct chat styling"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="actor">Actor</SelectItem>
                          <SelectItem value="narrator">Narrator</SelectItem>
                        </SelectContent>
                      </Select>
                      <Badge variant="secondary" className="shrink-0 text-[9px] tabular-nums">{lineCount} lines</Badge>
                    </div>
                    <Select value={member.voiceProfile} onValueChange={(v) => setCast((c) => ({ ...c, [sp]: { ...member, voiceProfile: v } }))}>
                      <SelectTrigger className="h-8 text-xs" aria-label={`${sp} voice`}><SelectValue /></SelectTrigger>
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
                    {!voiceProfiles.some((v) => v.id === member.voiceProfile) && (
                      <p className="text-[11px] text-amber-600" role="status">Voice missing — using default until you pick another.</p>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="mb-1 flex justify-between text-[10px] text-muted-foreground"><span>rate</span><span className="tabular-nums">{member.rate.toFixed(2)}×</span></div>
                        <Slider value={[member.rate]} min={0.5} max={2} step={0.05} aria-label={`${sp} rate`}
                          onValueChange={([v]) => setCast((c) => ({ ...c, [sp]: { ...member, rate: v } }))} />
                      </div>
                      <div>
                        <div className="mb-1 flex justify-between text-[10px] text-muted-foreground"><span>pitch</span><span className="tabular-nums">{member.pitch.toFixed(2)}</span></div>
                        <Slider value={[member.pitch]} min={0.5} max={1.8} step={0.05} aria-label={`${sp} pitch`}
                          onValueChange={([v]) => setCast((c) => ({ ...c, [sp]: { ...member, pitch: v } }))} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionPanel>

        <SectionPanel title="Delivery" description="Timing and language rules for the take.">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Pause between lines</Label>
                <span className="text-xs tabular-nums text-muted-foreground">{gapMs} ms</span>
              </div>
              <Slider value={[gapMs]} min={0} max={2000} step={50} onValueChange={([v]) => setGapMs(v)} aria-label="Pause between lines" />
              <p className="text-[11px] text-muted-foreground">Inserts exact silence between takes — stage directions can add more with [pause 800].</p>
            </div>
            <Separator />
            <div className="flex items-center justify-between rounded-lg border p-2.5">
              <div>
                <Label className="text-xs">Pronunciation lexicon</Label>
                <p className="text-[11px] text-muted-foreground">Shared dictionary from TTS Studio</p>
              </div>
              <Switch checked={useLexicon} onCheckedChange={setUseLexicon} aria-label="Apply pronunciation lexicon" />
            </div>
            {useLexicon && (
              <p className="text-[11px] text-muted-foreground">
                {lexiconRules.filter((r) => r.enabled).length} active rule{lexiconRules.filter((r) => r.enabled).length === 1 ? '' : 's'} — manage them in TTS Studio.
              </p>
            )}
          </div>
        </SectionPanel>

        <SectionPanel title="Render" description="Stitch all takes into one file.">
          <div className="space-y-3">
            <Select value={settings.outputFormat || 'wav-16'} onValueChange={(v) => useAppStore.getState().setSetting('outputFormat', v)}>
              <SelectTrigger aria-label="Output format"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-64">
                {AUDIO_FORMATS.map((f) => (
                  <SelectItem key={f.id} value={f.id}>{f.label} <span className="text-muted-foreground">· {f.container}</span></SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="w-full" onClick={renderDialogue} disabled={rendering || !stats.speakable}>
              {rendering ? <Waypoints className="mr-1.5 h-4 w-4 animate-pulse" /> : <MessagesSquare className="mr-1.5 h-4 w-4" />}
              {rendering ? 'Rendering dialogue…' : `Render full dialogue (${stats.speakable} lines)`}
            </Button>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>≈ {formatDuration(stats.estSec)} · {formatNumber(stats.words)} words</span>
              <span>{formatNumber(stats.lines - stats.speakable)} muted</span>
            </div>
            <p className="rounded-md bg-muted/40 p-2 text-[11px] leading-snug text-muted-foreground">
              <Pause className="mr-1 inline h-3 w-3" />Takes render as one background job — pause or cancel any time from Activity & Queue.
            </p>
          </div>
        </SectionPanel>

        <SectionPanel title="Subtitles" description="Speaker-tagged cues from the last full-cast render.">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 rounded-lg border p-2.5">
              <div>
                <Label className="text-xs">Include speaker names</Label>
                <p className="text-[11px] text-muted-foreground">.srt lines read “Speaker: line”</p>
              </div>
              <Switch checked={srtWithSpeakers} onCheckedChange={setSrtWithSpeakers} aria-label="Include speaker names in downloaded .srt" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex min-w-0 flex-1">
                    <Button
                      size="sm"
                      className="h-7 w-full border-emerald-500/40 bg-emerald-500/15 text-[11px] text-emerald-600 hover:bg-emerald-500/25 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
                      onClick={sendCuesToVideo}
                      disabled={!hasTimings}
                      aria-label="Send speaker-tagged cues to the Video Editor"
                    >
                      <Clapperboard className="mr-1.5 h-3.5 w-3.5" />Send to Video Editor
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {hasTimings
                    ? 'Builds speaker-tagged cues from the last full-cast render and opens the Video Editor'
                    : 'Render the full dialogue first — cues come from the last render'}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={downloadDialogueSrt} disabled={!hasTimings} aria-label="Download dialogue subtitles as SRT">
                      <Download className="mr-1.5 h-3.5 w-3.5" />.srt
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Downloads the dialogue timings as an SRT file{hasTimings ? ` (${cueCount} cues)` : ''}</TooltipContent>
              </Tooltip>
            </div>
            <AnimatePresence initial={false}>
              {hasTimings ? (
                <motion.div
                  key="cues-ready"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.18 }}
                >
                  <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400">
                    <Captions className="h-3 w-3" />{cueCount} cues · ≈ {formatDuration(cuesEndSec)}
                  </Badge>
                </motion.div>
              ) : (
                <motion.p
                  key="cues-none"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.15 }}
                  className="text-[11px] text-muted-foreground"
                >
                  No cues yet — render the full dialogue to time every line.
                </motion.p>
              )}
            </AnimatePresence>
            <p className="rounded-md bg-muted/40 p-2 text-[11px] leading-snug text-muted-foreground">
              Cues mirror the stitched take 1:1 — each line’s original text with its speaker, timed from the render cursor. Any script edit invalidates them until the next render.
            </p>
          </div>
        </SectionPanel>
      </div>
    </div>
  );
}
