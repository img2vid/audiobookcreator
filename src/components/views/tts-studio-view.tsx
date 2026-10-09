'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/lib/stores/app-store';
import { useMounted } from '@/hooks/use-mounted';
import { enqueueJob } from '@/lib/queue';
import { SpeechQueue, listSystemVoices, isSpeechSynthesisAvailable } from '@/lib/engines/speech';
import {
  probeOsTtsBridge, invalidateBridgeCache, getBridgeUrl, setBridgeUrl, OS_ENGINE_CAPS,
} from '@/lib/engines/os-tts-bridge';
import { synthesizeWithSelectedEngine, voiceClassForModel } from '@/lib/engines/dispatch';
import {
  allVoiceProfiles,
  estimateSpeechDurationSec,
  isCustomProfile,
  registerCustomProfiles,
  synthesizeSpeech,
} from '@/lib/engines/formant';
import {
  synthesizeWithMarkup, stripVoiceMarkup, parseVoiceMarkup, estimateMarkupDurationSec,
} from '@/lib/engines/markup';
import {
  applyLexicon, loadLexicon, saveLexicon, parseLexiconText, serializeLexicon, mergeLexicon,
  LEXICON_PRESETS, type LexiconRule,
} from '@/lib/engines/lexicon';
import {
  AUDIO_FORMATS, countAvailableFormats, encodeAudioBufferChunked, estimateEncodedBytes, getFormat, isFormatAvailable, recorderSupportMap,
} from '@/lib/engines/encode';
import { aiNormalizeForSpeech } from '@/lib/engines/ai-services';
import { analyzeBuffer, normalizeBuffer, fadeBuffer, trimSilenceBuffer, gainBuffer, sliceBuffer, eqBuffer, compressBuffer, EQ_PRESETS, VOICE_MASTER_COMPRESSOR, applyVolumeEnvelope, normalizeEnvelopePoints, type EnvelopePoint } from '@/lib/engines/dsp';
import { TTS_MODELS } from '@/lib/data/tts-models';
import type { AssetItem, OsTtsBridgeStatus, OsTtsVoiceDef } from '@/lib/types';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatBytes, formatDuration, formatNumber } from '@/lib/utils/format';
import { uid, yieldToUI } from '@/lib/utils/async';
import { saveProject } from '@/lib/engines/project-vault';
import {
  AudioLines, AudioWaveform, BookA, Check, CircleHelp, Crop, Download, Flame, HardDriveDownload, Mic2, Pause, Play, Plus, RefreshCw, Repeat,
  RotateCcw, Save, Scissors, Server, Sparkles, Square, Trash2, TriangleAlert, Upload, Volume2, Wand2, Waves, X, Zap, ZoomIn,
} from 'lucide-react';

const SAMPLE_TEXT = `Welcome to Openmukti Audiobook Creator — a fully local text-to-speech workstation.
Everything you hear is generated on this machine. No uploads, no cloud, no waiting rooms.

[pause 400]Try the voice markup: [em]this phrase is emphasized[/em], [whisper]this one is a whisper[/whisper], and [spell]tts[/spell] is spelled out.
[rate 1.15]You can even change speed mid-sentence like this[/rate], then return to normal.`;

interface RenderOpts {
  normalize: boolean;
  fadeIn: number;
  fadeOut: number;
  trimSilence: boolean;
  gainDb: number;
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

// Hard cap on formats checked at once in the batch-export panel — encodes run
// sequentially, but six hour-long PCM renders is already a lot of blob memory.
const MAX_BATCH_FORMATS = 6;

export function TtsStudioView() {
  const mounted = useMounted();
  const { toast } = useToast();
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);
  const tuned = useAppStore((s) => s.tuned);
  const addAsset = useAppStore((s) => s.addAsset);
  const setEngine = useAppStore((s) => s.setEngine);
  const customProfiles = useAppStore((s) => s.customProfiles);

  const [text, setText] = useState('');
  const [modelId, setModelId] = useState(settings.preferredModelId || TTS_MODELS[0].id);
  const [voiceURI, setVoiceURI] = useState(settings.preferredVoiceURI);
  const [profileId, setProfileId] = useState('aura-neutral');
  const [rate, setRate] = useState(1);
  const [pitch, setPitch] = useState(1);
  const [volume, setVolume] = useState(1);
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [boundary, setBoundary] = useState<{ index: number; word: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playProgress, setPlayProgress] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [lastBuffer, setLastBuffer] = useState<AudioBuffer | null>(null);
  const [lastAsset, setLastAsset] = useState<AssetItem | null>(null);
  const [engineNote, setEngineNote] = useState<string | null>(null);
  const [aiDirectedText, setAiDirectedText] = useState<string | null>(null);
  const [aiDirectorNotes, setAiDirectorNotes] = useState<string[] | null>(null);
  const [opts, setOpts] = useState<RenderOpts>({ normalize: true, fadeIn: 0.02, fadeOut: 0.05, trimSilence: true, gainDb: 0 });
  // enhancer: 3-band EQ preset + dynamics compressor (real biquads via OfflineAudioContext)
  const [eqPresetId, setEqPresetId] = useState('natural');
  const [useCompressor, setUseCompressor] = useState(false);
  const [formatId, setFormatId] = useState(settings.outputFormat || 'wav-16');
  // batch export: multi-format encoding of the current working buffer. Defaults are
  // applied in a post-mount effect (persisted output format + wav-16) so the server
  // HTML and the first client render always agree — never read rehydrated settings
  // into initial markup.
  const [batchIds, setBatchIds] = useState<string[]>(['wav-16']);
  const [batchRunning, setBatchRunning] = useState(false);
  // device encoder capability — probed client-side only (MediaRecorder is undefined
  // during SSR); useMounted gates rendering so server HTML matches the first client render
  const availableCount = mounted ? countAvailableFormats(AUDIO_FORMATS) : null;
  const formatUnavailable = mounted && !isFormatAvailable(formatId, AUDIO_FORMATS);
  const [saving, setSaving] = useState(false);
  // rendered-output transport
  const [renderedPlaying, setRenderedPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [speed, setSpeed] = useState(1);
  // selected time region on the waveform (DAW-style): drag across the wave to select
  const [region, setRegion] = useState<{ start: number; end: number } | null>(null);
  // waveform zoom (1 = fit whole file, up to 40× pixel zoom) with scroll container
  const [zoom, setZoom] = useState(1);
  const waveScrollRef = useRef<HTMLDivElement | null>(null);
  // DAW-style brush volume envelope — edits the working buffer (like trim)
  const [envelopeMode, setEnvelopeMode] = useState(false);
  const [envelopePts, setEnvelopePts] = useState<EnvelopePoint[]>([]);
  const envDragRef = useRef<{ index: number; point: EnvelopePoint } | null>(null);
  // pronunciation lexicon (shared with Dialogue Studio via localStorage)
  const [lexRules, setLexRules] = useState<LexiconRule[]>([]);
  const [lexOn, setLexOn] = useState(true);
  const [lexImportText, setLexImportText] = useState('');
  const [newFind, setNewFind] = useState('');
  const [newReplace, setNewReplace] = useState('');
  // OS speech bridge — established OS engines (SAPI / say / espeak-ng / Piper) via the
  // local companion server. Probed once on mount; manual retry available in the UI.
  const [bridgeStatus, setBridgeStatus] = useState<OsTtsBridgeStatus | null>(null);
  const [bridgeVoices, setBridgeVoices] = useState<OsTtsVoiceDef[]>([]);
  const [bridgeProbing, setBridgeProbing] = useState(false);
  const [bridgeUrlDraft, setBridgeUrlDraft] = useState('');
  const [osVoiceId, setOsVoiceId] = useState('');

  const speechQueue = useRef<SpeechQueue | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const playbackRef = useRef<{ src: AudioBufferSourceNode; ctx: AudioContext; startedAt: number; offset: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const waveCacheRef = useRef<{ mins: Float32Array; maxs: Float32Array; w: number; h: number } | null>(null);
  const regionDragRef = useRef<{ downX: number; downT: number; moved: boolean } | null>(null);

  const model = useMemo(() => TTS_MODELS.find((m) => m.id === modelId) ?? TTS_MODELS[0], [modelId]);
  const usesAI = mounted && model.engine !== 'formant' && !settings.fallbackMode && isSpeechSynthesisAvailable();
  // The selected model's engine class decides WHICH system voices are used —
  // “OS Classic Voices” really picks classic local voices, “OS Neural Voices”
  // really picks neural ones. No more one-engine-for-everything.
  const voiceClass = voiceClassForModel(model);
  const isBridgeModel = model.engine === 'os-bridge';
  const bridgeUp = mounted && !!bridgeStatus?.ok && bridgeVoices.length > 0;
  const words = useMemo(() => text.trim() ? text.trim().split(/\s+/).length : 0, [text]);

  // voice profile picker = built-ins + registered custom voices (recomputed whenever the
  // persisted custom set changes; the effect above keeps the engine registry in sync)
  const voiceProfiles = useMemo(() => allVoiceProfiles(), [customProfiles]);
  const selectedProfile = useMemo(
    () => voiceProfiles.find((v) => v.id === profileId),
    [voiceProfiles, profileId],
  );

  // load the shared lexicon once
  useEffect(() => {
    setLexRules(loadLexicon());
  }, []);

  // ---- OS speech bridge: probe on mount, restore the persisted bridge voice ----
  useEffect(() => {
    let cancelled = false;
    setBridgeProbing(true);
    try { setOsVoiceId(window.localStorage.getItem('os-tts-voice') ?? ''); } catch { /* ignore */ }
    setBridgeUrlDraft('');
    void probeOsTtsBridge().then((res) => {
      if (cancelled) return;
      setBridgeStatus(res.status);
      setBridgeVoices(res.voices);
      setBridgeProbing(false);
    });
    return () => { cancelled = true; };
  }, []);

  const retryBridge = useCallback(async () => {
    if (bridgeUrlDraft.trim()) setBridgeUrl(bridgeUrlDraft.trim());
    invalidateBridgeCache();
    setBridgeProbing(true);
    const res = await probeOsTtsBridge(true);
    setBridgeStatus(res.status);
    setBridgeVoices(res.voices);
    setBridgeProbing(false);
    if (res.status.ok) toast({ title: 'OS speech bridge detected', description: `${res.voices.length} voices from your operating system's speech engines.` });
    else toast({ title: 'Bridge not reachable', description: `Start it with: npm run os-tts (${res.status.url})`, variant: 'destructive' });
  }, [bridgeUrlDraft, toast]);

  const updateOsVoiceId = useCallback((id: string) => {
    setOsVoiceId(id);
    try { window.localStorage.setItem('os-tts-voice', id); } catch { /* ignore */ }
  }, []);

  // Register the persisted custom voice profiles with the formant engine (idempotent —
  // the Voice Library and the app-store mirror this, so view mount order never matters).
  useEffect(() => {
    registerCustomProfiles(customProfiles);
  }, [customProfiles]);

  // Default batch selection: the persisted output format + wav-16, pruned to formats
  // this device can encode. Runs once on mount (MediaRecorder probes and persisted
  // settings only exist client-side, so this never fights hydration).
  const batchOutputFormatRef = useRef(settings.outputFormat);
  useEffect(() => {
    if (!mounted) return;
    const defaults = Array.from(new Set([batchOutputFormatRef.current || 'wav-16', 'wav-16']));
    setBatchIds(defaults.filter((id) => isFormatAvailable(id, AUDIO_FORMATS)));
  }, [mounted]);

  const updateLexRules = useCallback((next: LexiconRule[]) => {
    setLexRules(next);
    saveLexicon(next);
  }, []);

  // lexicon-prepared text (single source for preview, render, estimates)
  const prepared = useMemo(() => {
    const source = aiDirectedText ?? text;
    if (!lexOn || !source) return { text: source, substitutions: 0, applied: [] as string[] };
    const rep = applyLexicon(source, lexRules);
    return { text: rep.text, substitutions: rep.substitutions, applied: rep.applied };
  }, [text, lexRules, lexOn, aiDirectedText]);
  const activeLexRules = lexRules.filter((r) => r.enabled).length;

  const runAiDirection = useCallback(async () => {
    if (!text.trim()) return;
    const dir = await aiNormalizeForSpeech(text);
    if (dir.ok && dir.value) {
      setAiDirectedText(dir.value.text);
      setAiDirectorNotes(dir.value.notes);
      toast({ title: 'AI speech director ready', description: dir.value.notes[0] ?? 'Text normalized for speech.' });
    } else {
      toast({ title: 'AI speech director', description: dir.error ?? 'No changes needed.', variant: 'destructive' });
    }
  }, [text, toast]);

  const markupInfo = useMemo(() => parseVoiceMarkup(prepared.text, { rate, pitch, volume }), [prepared.text, rate, pitch, volume]);
  const estSec = useMemo(
    () => markupInfo.hasMarkup ? estimateMarkupDurationSec(prepared.text, rate) : estimateSpeechDurationSec(prepared.text, rate),
    [prepared.text, rate, markupInfo],
  );

  useEffect(() => {
    void listSystemVoices().then((v) => {
      setSystemVoices(v);
      setEngine({ systemVoices: v.length });
    });
    return () => {
      speechQueue.current?.stop();
      audioSrcRef.current?.stop();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      void audioCtxRef.current?.close();
    };
  }, []);

  // consume cross-module handoffs (OCR Lab, File Studio)
  const pendingText = useAppStore((s) => s.pendingText);
  const pendingTextMeta = useAppStore((s) => s.pendingTextMeta);
  const setPendingText = useAppStore((s) => s.setPendingText);
  useEffect(() => {
    if (pendingText) {
      setText((prev) => (prev ? prev + '\n\n' : '') + pendingText);
      setPendingText(null);
      toast({ title: 'Text received', description: pendingTextMeta ?? 'Added to TTS Studio input.' });
    }
  }, [pendingText]);

  // waveform: compute per-column min/max cache once per buffer (high-res, zoom-aware)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !lastBuffer) return;
    const ch0 = lastBuffer.getChannelData(0);
    const target = Math.min(16384, Math.max(4096, Math.round(ch0.length / 4)));
    const step = Math.max(1, Math.floor(ch0.length / target));
    const cols = Math.max(1, Math.ceil(ch0.length / step));
    const mins = new Float32Array(cols);
    const maxs = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      let min = 1;
      let max = -1;
      const base = x * step;
      for (let i = 0; i < step; i++) {
        const v = ch0[base + i] ?? 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      mins[x] = min;
      maxs[x] = max;
    }
    waveCacheRef.current = { mins, maxs, w: cols, h: 96 };
    setZoom((z) => Math.max(1, Math.min(z, 40)));
  }, [lastBuffer]);

  // waveform paint — zoom-aware: canvas spans the full duration at clientWidth × zoom,
  // bars are sampled from the high-res cache, and a time ruler runs along the bottom.
  useEffect(() => {
    const canvas = canvasRef.current;
    const cache = waveCacheRef.current;
    const scroller = waveScrollRef.current;
    if (!canvas || !lastBuffer || !cache || !scroller) return;
    const dpr = window.devicePixelRatio || 1;
    const baseW = scroller.clientWidth || canvas.clientWidth || 800;
    const cssW = Math.max(64, Math.round(baseW * zoom));
    const waveH = 96;
    const rulerH = 18;
    const H = waveH + rulerH;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${H}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, H);
    const dur = lastBuffer.duration || 0.001;
    const t2x = (t: number) => (t / dur) * cssW;
    const playedX = t2x(playhead);
    // played / unplayed wash
    ctx.fillStyle = 'rgba(139, 92, 246, 0.10)';
    ctx.fillRect(playedX, 0, cssW - playedX, waveH);
    ctx.fillStyle = 'rgba(139, 92, 246, 0.16)';
    ctx.fillRect(0, 0, playedX, waveH);
    // bars
    const { mins, maxs } = cache;
    const cols = mins.length;
    for (let x = 0; x < cssW; x++) {
      const i = Math.min(cols - 1, Math.floor((x / cssW) * cols));
      const y1 = (1 - maxs[i]) * (waveH / 2);
      const y2 = (1 - mins[i]) * (waveH / 2);
      ctx.fillStyle = x <= playedX ? 'rgba(139, 92, 246, 0.85)' : 'rgba(139, 92, 246, 0.38)';
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    // playhead
    ctx.fillStyle = 'rgba(16, 185, 129, 0.95)';
    ctx.fillRect(Math.max(0, Math.min(cssW - 2, playedX)), 0, 2, waveH);
    // selected region overlay (amber band + edge handles, dim outside)
    if (region && region.end - region.start > 0.001) {
      const x1 = t2x(region.start);
      const x2 = t2x(region.end);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fillRect(0, 0, Math.max(0, x1), waveH);
      ctx.fillRect(Math.min(cssW, x2), 0, Math.max(0, cssW - x2), waveH);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.16)';
      ctx.fillRect(Math.max(0, x1), 0, Math.max(1, x2 - x1), waveH);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.95)';
      ctx.fillRect(Math.max(0, x1 - 1), 0, 2, waveH);
      ctx.fillRect(Math.min(cssW - 2, x2 - 1), 0, 2, waveH);
    }
    // brush volume envelope overlay (emerald) — wave area only, drawn above the region wash
    if (envelopeMode && envelopePts.length > 0) {
      const g2y = (g: number) => waveH - (Math.min(2, Math.max(0, g)) / 2) * waveH;
      const unityY = g2y(1);
      const xs = envelopePts.map((p) => t2x(p.tSec));
      const ys = envelopePts.map((p) => g2y(p.gain));
      // unity reference line (dashed, subtle)
      ctx.save();
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(unityY) + 0.5);
      ctx.lineTo(cssW, Math.round(unityY) + 0.5);
      ctx.stroke();
      ctx.restore();
      // translucent fill under the curve down to the bottom of the wave area
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, waveH);
      ctx.lineTo(0, unityY);
      for (let i = 0; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
      ctx.lineTo(cssW, unityY);
      ctx.lineTo(cssW, waveH);
      ctx.closePath();
      ctx.fillStyle = 'rgba(16, 185, 129, 0.10)';
      ctx.fill();
      // envelope polyline — gain is implicitly 1 before the first / after the last point
      ctx.beginPath();
      ctx.moveTo(0, unityY);
      for (let i = 0; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
      ctx.lineTo(cssW, unityY);
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // point handles: white core + emerald ring (dragged point slightly larger)
      const dragIdx = envDragRef.current?.index ?? -1;
      for (let i = 0; i < xs.length; i++) {
        const r = i === dragIdx ? 4.5 : 3.5;
        ctx.beginPath();
        ctx.arc(xs[i], ys[i], r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.95)';
        ctx.stroke();
      }
      ctx.restore();
    }
    // time ruler
    ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
    ctx.fillRect(0, waveH, cssW, rulerH);
    ctx.fillStyle = 'rgba(113, 113, 122, 0.9)';
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const niceSteps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const stepSec = niceSteps.find((s) => (s / dur) * cssW >= 72) ?? 600;
    for (let t = 0; t <= dur + 0.0001; t += stepSec) {
      const x = Math.round(t2x(t));
      ctx.fillRect(x, waveH, 1, 5);
      const label = t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${t.toFixed(t < 1 ? 2 : t % 1 === 0 ? 0 : 1)}s`;
      ctx.fillText(label, x + 3, waveH + rulerH / 2 + 1);
      ctx.fillStyle = 'rgba(113, 113, 122, 0.25)';
      ctx.fillRect(x, 0, 1, waveH);
      ctx.fillStyle = 'rgba(113, 113, 122, 0.9)';
    }
  }, [lastBuffer, playhead, region, zoom, envelopeMode, envelopePts]);

  // follow the playhead while playing (never fights user scroll)
  useEffect(() => {
    const scroller = waveScrollRef.current;
    if (!scroller || !renderedPlaying || !lastBuffer) return;
    const x = (playhead / (lastBuffer.duration || 1)) * (scroller.scrollWidth || 1);
    if (x < scroller.scrollLeft + 24 || x > scroller.scrollLeft + scroller.clientWidth - 48) {
      scroller.scrollTo({ left: Math.max(0, x - scroller.clientWidth * 0.4), behavior: 'smooth' });
    }
  }, [playhead, renderedPlaying, lastBuffer]);

  // ---------- rendered-output transport ----------
  const stopRenderedPlayback = useCallback(() => {
    const pb = playbackRef.current;
    if (pb) {
      try { pb.src.onended = null; pb.src.stop(); } catch { /* already stopped */ }
      playbackRef.current = null;
    }
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    setRenderedPlaying(false);
  }, []);

  const startRenderedPlayback = useCallback((fromSec: number) => {
    const buf = lastBuffer;
    if (!buf) return;
    stopRenderedPlayback();
    speechQueue.current?.stop();
    audioSrcRef.current?.stop();
    audioSrcRef.current = null;
    const ctx = audioCtxRef.current ?? new AudioContext();
    audioCtxRef.current = ctx;
    if (ctx.state === 'suspended') void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speed;
    src.loop = loopPlayback;
    src.connect(ctx.destination);
    // region-aware bounds: when a selection is active, playback is confined to it
    const rStart = region ? Math.max(0, Math.min(buf.duration, region.start)) : 0;
    const rEnd = region ? Math.max(rStart + 0.01, Math.min(buf.duration, region.end)) : buf.duration;
    const offset = Math.min(Math.max(rStart, fromSec), Math.max(rStart, rEnd - 0.01));
    src.onended = () => {
      if (playbackRef.current?.src === src) {
        playbackRef.current = null;
        setRenderedPlaying(false);
        setPlayhead(rStart);
      }
    };
    src.start(0, offset);
    const pb = { src, ctx, startedAt: ctx.currentTime, offset };
    playbackRef.current = pb;
    setRenderedPlaying(true);
    const tick = () => {
      const cur = playbackRef.current;
      if (!cur || cur.src !== src) return;
      const raw = cur.offset + (cur.ctx.currentTime - cur.startedAt) * speed;
      const span = rEnd - rStart;
      const t = loopPlayback && span > 0.01
        ? rStart + (((raw - rStart) % span) + span) % span
        : Math.min(raw, rEnd);
      setPlayhead(Math.max(rStart, t));
      if (!loopPlayback && raw >= rEnd) {
        try { src.stop(); } catch { /* already stopped */ }
        playbackRef.current = null;
        setRenderedPlaying(false);
        setPlayhead(rStart);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [lastBuffer, speed, loopPlayback, region, stopRenderedPlayback]);

  const toggleRenderedPlayback = useCallback(() => {
    if (renderedPlaying) {
      // pause: freeze at the current playhead
      const pb = playbackRef.current;
      if (pb) {
        const raw = pb.offset + (pb.ctx.currentTime - pb.startedAt) * speed;
        setPlayhead(loopPlayback && lastBuffer ? raw % lastBuffer.duration : Math.min(raw, lastBuffer?.duration ?? raw));
      }
      stopRenderedPlayback();
    } else {
      startRenderedPlayback(playhead);
    }
  }, [renderedPlaying, playhead, speed, loopPlayback, lastBuffer, startRenderedPlayback, stopRenderedPlayback]);

  const timeAtPointer = useCallback((clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !lastBuffer) return 0;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    return frac * lastBuffer.duration;
  }, [lastBuffer]);

  // pointer flow: press → drag selects a region; press+release without movement seeks & clears region
  const onWavePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!lastBuffer) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const t = timeAtPointer(e.clientX);
    regionDragRef.current = { downX: e.clientX, downT: t, moved: false };
    draggingRef.current = true;
    setPlayhead(t);
  }, [lastBuffer, timeAtPointer]);

  const onWavePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = regionDragRef.current;
    if (!d || !lastBuffer) return;
    if (!d.moved && Math.abs(e.clientX - d.downX) < 5) return;
    d.moved = true;
    const t = timeAtPointer(e.clientX);
    setRegion({ start: Math.min(d.downT, t), end: Math.max(d.downT, t) });
  }, [lastBuffer, timeAtPointer]);

  const onWavePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = regionDragRef.current;
    regionDragRef.current = null;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (!d) return;
    if (!d.moved) {
      // simple click → seek (and drop any previous selection)
      setRegion(null);
      if (renderedPlaying) startRenderedPlayback(d.downT);
    } else if (region) {
      setPlayhead(region.start);
      if (renderedPlaying) startRenderedPlayback(region.start);
    }
  }, [region, renderedPlaying, startRenderedPlayback]);

  // ---------- brush volume envelope (replaces region gestures while active) ----------
  const WAVE_H = 96; // canvas is 114px CSS: 96px wave + 18px ruler — envelope lives in the wave area only

  // pointer → (time, gain): gain 0..2 across the wave height, 1 = unity mid-line
  const envelopeGeometryAtPointer = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas || !lastBuffer) return null;
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y > WAVE_H) return null; // below the wave area (ruler) → ignore pointer events
    const gain = Math.min(2, Math.max(0, (1 - y / WAVE_H) * 2));
    return { t: timeAtPointer(e.clientX), gain };
  }, [lastBuffer, timeAtPointer]);

  const onEnvelopePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!lastBuffer) return;
    const geo = envelopeGeometryAtPointer(e);
    if (!geo) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const dur = lastBuffer.duration || 0.001;
    // existing point within ~8px horizontally → drag it; otherwise add a new one
    let bestIdx = -1;
    let bestDist = 8;
    envelopePts.forEach((p, i) => {
      const d = Math.abs((p.tSec / dur) * rect.width - px);
      if (d <= bestDist) { bestDist = d; bestIdx = i; }
    });
    if (bestIdx >= 0) {
      envDragRef.current = { index: bestIdx, point: envelopePts[bestIdx] };
      return;
    }
    // points may not sit closer than 10 ms — absorb neighbors at the click position
    const kept = envelopePts.filter((p) => Math.abs(p.tSec - geo.t) >= 0.01);
    const added = { tSec: geo.t, gain: geo.gain };
    const next = normalizeEnvelopePoints([...kept, added], lastBuffer.duration);
    const idx = next.findIndex((p) => p === added);
    setEnvelopePts(next);
    envDragRef.current = idx >= 0 ? { index: idx, point: added } : null;
  }, [lastBuffer, envelopePts, envelopeGeometryAtPointer]);

  const onEnvelopePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = envDragRef.current;
    if (!drag || !lastBuffer) return;
    const geo = envelopeGeometryAtPointer(e);
    if (!geo) return;
    let idx = envelopePts.findIndex((p) => p === drag.point);
    if (idx < 0) idx = Math.min(drag.index, envelopePts.length - 1);
    if (idx < 0) { envDragRef.current = null; return; }
    const t = Math.min(lastBuffer.duration, Math.max(0, geo.t));
    // absorb any point the dragged one crosses (10 ms minimum spacing)
    const kept = envelopePts.filter((p, i) => i !== idx && Math.abs(p.tSec - t) >= 0.01);
    const moved = { ...envelopePts[idx], tSec: t, gain: geo.gain };
    const next = normalizeEnvelopePoints([...kept, moved], lastBuffer.duration);
    const nextIdx = Math.max(0, next.findIndex((p) => p === moved));
    envDragRef.current = { index: nextIdx, point: moved };
    setEnvelopePts(next);
  }, [lastBuffer, envelopePts, envelopeGeometryAtPointer]);

  const onEnvelopePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // points added on down persist even without movement — nothing else to do
    envDragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ }
  }, []);

  const onEnvelopeContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!lastBuffer || envelopePts.length === 0) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const dur = lastBuffer.duration || 0.001;
    let bestIdx = -1;
    let bestDist = 10;
    envelopePts.forEach((p, i) => {
      const d = Math.abs((p.tSec / dur) * rect.width - px);
      if (d <= bestDist) { bestDist = d; bestIdx = i; }
    });
    if (bestIdx < 0 || envDragRef.current?.point === envelopePts[bestIdx]) return;
    setEnvelopePts(envelopePts.filter((_, i) => i !== bestIdx));
  }, [lastBuffer, envelopePts]);

  // ---------- region tools ----------
  const exportRegion = useCallback(() => {
    if (!lastBuffer || !region || region.end - region.start < 0.01) return;
    const fmtId = formatId;
    enqueueJob(
      { type: 'tts-render', label: `Export selection ${formatDuration(region.start)}–${formatDuration(region.end)}` },
      async (api) => {
        api.log('Slicing selected region…');
        const cut = sliceBuffer(lastBuffer, region.start, region.end);
        api.setProgress(0.3, `Encoding ${getFormat(fmtId)?.label ?? fmtId}…`);
        const blob = await encodeAudioBufferChunked(cut, fmtId, { channels: settings.channels }, (p) =>
          api.setProgress(0.3 + p * 0.65, `Encoding ${(p * 100).toFixed(0)}%`));
        if (api.shouldCancel()) return;
        const fmt = getFormat(fmtId);
        const asset: AssetItem = {
          id: uid('asset'),
          name: `selection-${Math.round(region.start * 1000)}-${Math.round(region.end * 1000)}.${fmt?.extension ?? 'wav'}`,
          kind: 'audio',
          createdAt: Date.now(),
          mimeType: fmt?.mime ?? 'audio/wav',
          sizeBytes: blob.size,
          durationSec: cut.duration,
          buffer: cut,
          blobUrl: URL.createObjectURL(blob),
          meta: { source: 'region-export', format: fmtId },
        };
        addAsset(asset);
        api.log(`Selection saved: ${formatBytes(blob.size)}`);
        return { fileName: asset.name, bytes: blob.size, durationSec: cut.duration };
      },
    );
    const t = setInterval(() => {
      const job = useAppStore.getState().jobs.find((j) => j.label.startsWith('Export selection'));
      if (job && ['done', 'error', 'cancelled'].includes(job.status)) {
        clearInterval(t);
        if (job.status === 'done') toast({ title: 'Selection exported', description: 'Saved to the asset bin.' });
        else toast({ title: 'Export failed', description: job.error, variant: 'destructive' });
      }
    }, 400);
  }, [lastBuffer, region, formatId, settings.channels, addAsset, toast]);

  // ---------- batch export (one buffer → many formats) ----------
  // Per-format size estimates for the batch panel + picker hint. Recomputed per
  // buffer/channel change — 39 cheap pure calls, no encoding.
  const batchEstimates = useMemo(() => {
    const map: Record<string, number | null> = {};
    if (!lastBuffer) return map;
    for (const f of AUDIO_FORMATS) {
      map[f.id] = estimateEncodedBytes(lastBuffer.duration, f.id, AUDIO_FORMATS, {
        sampleRate: lastBuffer.sampleRate,
        channels: settings.channels,
      });
    }
    return map;
  }, [lastBuffer, settings.channels]);
  const selectedEstimate = lastBuffer ? (batchEstimates[formatId] ?? null) : null;
  const batchTotalBytes = useMemo(() => {
    if (!lastBuffer || batchIds.length === 0) return null;
    let total = 0;
    for (const id of batchIds) {
      const v = batchEstimates[id];
      if (v == null) return null;
      total += v;
    }
    return total;
  }, [lastBuffer, batchIds, batchEstimates]);

  const toggleBatchFormat = useCallback((id: string, on: boolean) => {
    setBatchIds((prev) => {
      if (!on) return prev.filter((x) => x !== id);
      if (prev.includes(id) || prev.length >= MAX_BATCH_FORMATS) return prev;
      return [...prev, id];
    });
  }, []);

  const startBatchExport = useCallback(() => {
    const srcBuf = lastBuffer;
    const ids = batchIds.slice();
    if (!srcBuf || ids.length === 0) return;
    setBatchRunning(true);
    const n = ids.length;
    // same base name as a normal single export (render-<stamp>), plus the format id
    // as a suffix — several wav-* formats share the .wav extension, so the id keeps
    // files from colliding inside one batch
    const baseName = `render-${Date.now().toString(36)}`;
    void enqueueJob(
      { type: 'encode', label: `Batch export → ${n} format${n === 1 ? '' : 's'}` },
      async (api) => {
        api.log(`Batch export: ${n} format${n === 1 ? '' : 's'} from one ${formatDuration(srcBuf.duration)} buffer — renders once, encodes many`);
        let done = 0;
        let failed = 0;
        let cancelled = false;
        try {
          for (let i = 0; i < n; i++) {
            const id = ids[i];
            const fmt = getFormat(id);
            const fmtLabel = fmt?.label ?? id;
            if (api.shouldCancel()) { cancelled = true; break; }
            await api.waitWhilePaused();
            if (api.shouldCancel()) { cancelled = true; break; }
            api.setProgress(i / n, `Encoding ${fmtLabel}…`);
            await yieldToUI();
            try {
              const blob = await encodeAudioBufferChunked(srcBuf, id, { channels: settings.channels }, (p) =>
                api.setProgress((i + p) / n, `Encoding ${fmtLabel}…`));
              if (api.shouldCancel()) { cancelled = true; break; } // in-flight file dropped — completed files stay
              const asset: AssetItem = {
                id: uid('asset'),
                name: `${baseName}-${id}.${fmt?.extension ?? 'wav'}`,
                kind: 'audio',
                createdAt: Date.now(),
                mimeType: fmt?.mime ?? 'audio/wav',
                sizeBytes: blob.size,
                durationSec: srcBuf.duration,
                buffer: srcBuf,
                blobUrl: URL.createObjectURL(blob),
                meta: { source: 'batch-export', format: id },
              };
              addAsset(asset);
              done++;
              api.log(`[${done}/${n}] ${fmtLabel} — ${formatBytes(blob.size)}`);
            } catch (err) {
              failed++;
              api.log(`Skipped ${fmtLabel} — ${err instanceof Error ? err.message : String(err)}`);
            }
            await yieldToUI();
          }
        } finally {
          setBatchRunning(false);
        }
        if (cancelled) {
          toast({ title: `Batch export cancelled after ${done} file${done === 1 ? '' : 's'}`, description: 'Completed files were kept in the Asset Bin.' });
        } else if (done === 0 && failed > 0) {
          toast({ title: 'Batch export failed', description: `No format could encode on this device — ${failed} skipped.`, variant: 'destructive' });
        } else {
          toast({ title: `Batch export finished — ${done} file${done === 1 ? '' : 's'} in Asset Bin`, description: failed > 0 ? `${failed} format${failed === 1 ? '' : 's'} could not encode and were skipped.` : undefined });
        }
        return { files: done, failed, cancelled, formats: ids };
      },
    );
  }, [lastBuffer, batchIds, settings.channels, addAsset, toast]);

  const trimToRegion = useCallback(() => {
    if (!lastBuffer || !region || region.end - region.start < 0.01) return;
    stopRenderedPlayback();
    const cut = sliceBuffer(lastBuffer, region.start, region.end);
    setLastBuffer(cut);
    setLastAsset((a) => (a ? { ...a, durationSec: cut.duration } : a));
    setRegion(null);
    setEnvelopePts([]);
    setEnvelopeMode(false);
    setPlayhead(0);
    toast({ title: 'Trimmed to selection', description: `Working buffer is now ${formatDuration(cut.duration)}. Export again to save it.` });
  }, [lastBuffer, region, stopRenderedPlayback, toast]);

  // bake the drawn envelope into the working buffer (queued so long buffers never freeze the UI)
  const applyEnvelope = useCallback(() => {
    if (!lastBuffer || envelopePts.length === 0) return;
    stopRenderedPlayback();
    const pts = envelopePts;
    const n = pts.length;
    void enqueueJob(
      { type: 'tts-render', label: `Apply volume envelope (${n} points)` },
      async (api) => {
        await yieldToUI();
        api.log(`Applying ${n}-point volume envelope…`);
        api.setProgress(0.25, 'Applying volume envelope…');
        const gMin = pts.reduce((m, p) => Math.min(m, p.gain), 1);
        const gMax = pts.reduce((m, p) => Math.max(m, p.gain), 1);
        const next = applyVolumeEnvelope(lastBuffer, pts);
        api.setProgress(1, 'Envelope applied');
        api.log(`Gain range ${gMin.toFixed(2)}–${gMax.toFixed(2)} × (unity = 1.00)`);
        setLastBuffer(next);
        setEnvelopePts([]); // points are baked in — clear for the next pass
        setEnvelopeMode(true); // stay in envelope mode
        toast({ title: `Envelope applied — ${n} points`, description: `Gain ${gMin.toFixed(2)}–${gMax.toFixed(2)} × baked into the working buffer.` });
        return { points: n, gainMin: Number(gMin.toFixed(3)), gainMax: Number(gMax.toFixed(3)) };
      },
    );
  }, [lastBuffer, envelopePts, stopRenderedPlayback, toast]);

  // ---------- preview ----------
  const stopPreview = useCallback(() => {
    speechQueue.current?.stop();
    audioSrcRef.current?.stop();
    audioSrcRef.current = null;
    setPlaying(false);
    setBoundary(null);
    setPlayProgress(0);
  }, []);

  // audition a single lexicon rule: speak its replacement with the current profile
  const auditionLexRule = useCallback((rule: LexiconRule) => {
    const phrase = rule.replace.trim();
    if (!phrase) return;
    stopPreview();
    stopRenderedPlayback();
    void synthesizeSpeech(` ${phrase}. `, {
      profileId, rate: 1, pitch: 1, volume: 1, quality: 'fast',
    }).then((buf) => {
      const ctx = audioCtxRef.current ?? new AudioContext();
      audioCtxRef.current = ctx;
      audioSrcRef.current?.stop();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => { if (audioSrcRef.current === src) audioSrcRef.current = null; };
      audioSrcRef.current = src;
      src.start();
      setEngine({ ttsEngine: 'fallback' });
    }).catch((e) => {
      toast({ title: 'Audition failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    });
  }, [profileId, stopPreview, stopRenderedPlayback, setEngine, toast]);

  const startPreview = useCallback(() => {
    if (!prepared.text.trim()) return;
    stopPreview();
    stopRenderedPlayback();
    // OS bridge models WITH the bridge running: preview through the real OS
    // engine (SAPI / say / espeak-ng / Piper) — the exact render path.
    if (isBridgeModel && bridgeUp) {
      const previewText = prepared.text.length > 900 ? prepared.text.slice(0, 900) : prepared.text;
      setPlaying(true);
      void synthesizeWithSelectedEngine(previewText, {
        model, profileId, osVoiceId: osVoiceId || undefined, voiceURI: voiceURI || undefined,
        rate, pitch, volume, quality: tuned.synthesisQuality, forceFallback: settings.fallbackMode,
      }).then((res) => {
        const ctx = audioCtxRef.current ?? new AudioContext();
        audioCtxRef.current = ctx;
        const src = ctx.createBufferSource();
        src.buffer = res.buffer;
        src.connect(ctx.destination);
        src.onended = () => { setPlaying(false); setPlayProgress(0); };
        audioSrcRef.current = src;
        src.start();
        setEngine({ ttsEngine: 'os-bridge' });
        const t0 = ctx.currentTime;
        const tick = () => {
          if (!audioSrcRef.current) return;
          setPlayProgress(Math.min(1, (ctx.currentTime - t0) / res.buffer.duration));
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }).catch((e) => {
        setPlaying(false);
        toast({ title: 'OS engine error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
      });
      return;
    }
    if (usesAI) {
      const q = new SpeechQueue(180);
      speechQueue.current = q;
      // AI voices cannot honor markup — strip it so tags are never read aloud.
      // voiceClass makes the model selection real: classic models pick classic
      // voices, neural models pick neural voices.
      q.start(markupInfo.hasMarkup ? stripVoiceMarkup(prepared.text) : prepared.text, {
        voiceURI: voiceURI || undefined,
        voiceClass,
        lang: model.lang !== 'multi' ? model.lang : undefined,
        rate: Math.min(10, Math.max(0.1, rate)),
        pitch: Math.min(2, Math.max(0, pitch)),
        volume,
      }, {
        onStart: () => setPlaying(true),
        onBoundary: (index, word) => setBoundary({ index, word }),
        onProgress: (spoken, total) => setPlayProgress(total ? spoken / total : 0),
        onEnd: (err) => {
          setPlaying(false);
          setBoundary(null);
          setPlayProgress(0);
          if (err) {
            if (settings.autoFallback) {
              setEngineNote(`AI engine error (${err.message}) — switch to the fallback engine for guaranteed playback.`);
              setEngine({ ttsEngine: 'fallback', fallbackReason: err.message });
            } else {
              toast({ title: 'AI engine error', description: err.message, variant: 'destructive' });
            }
          }
        },
      });
      setEngine({ ttsEngine: 'ai' });
    } else {
      // formant engine preview: render first sentence group (max ~1 min) then play
      const previewText = prepared.text.length > 4000 ? prepared.text.slice(0, 4000) : prepared.text;
      setPlaying(true);
      void synthesizeWithMarkup(previewText, {
        profileId, rate, pitch, volume, quality: tuned.synthesisQuality,
      }).then((buf) => {
        const ctx = audioCtxRef.current ?? new AudioContext();
        audioCtxRef.current = ctx;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.onended = () => {
          setPlaying(false);
          setPlayProgress(0);
        };
        audioSrcRef.current = src;
        src.start();
        setEngine({ ttsEngine: 'fallback' });
        const t0 = ctx.currentTime;
        const tick = () => {
          if (!audioSrcRef.current) return;
          setPlayProgress(Math.min(1, (ctx.currentTime - t0) / buf.duration));
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }).catch((e) => {
        setPlaying(false);
        toast({ title: 'Fallback engine error', description: String(e), variant: 'destructive' });
      });
    }
  }, [prepared.text, usesAI, isBridgeModel, bridgeUp, osVoiceId, voiceURI, voiceClass, model, rate, pitch, volume, profileId, tuned.synthesisQuality, settings.autoFallback, settings.fallbackMode, stopPreview, stopRenderedPlayback, markupInfo.hasMarkup, setEngine, toast]);

  const togglePause = useCallback(() => {
    const q = speechQueue.current;
    if (q && q.isActive) {
      if (q.isPaused) {
        q.resume();
        setPlaying(true);
      } else {
        q.pause();
        setPlaying(false);
      }
      return;
    }
    const ctx = audioCtxRef.current;
    if (ctx) {
      if (ctx.state === 'running') {
        void ctx.suspend();
        setPlaying(false);
      } else {
        void ctx.resume();
        setPlaying(true);
      }
    }
  }, []);

  // ---------- render to file ----------
  const startRender = useCallback(() => {
    if (!text.trim() || rendering) return;
    setRendering(true);
    setRenderProgress(0);
    setEngineNote(null);
    const jobId = enqueueJob(
      { type: 'tts-render', label: `Render ${formatNumber(words)} words → ${getFormat(formatId)?.label ?? formatId}` },
      async (api) => {
        api.log(
          model.engine === 'formant' || settings.fallbackMode
            ? 'Synthesizing with the built-in AuraVoice engine…'
            : `Synthesizing with the selected engine (${model.name})…`,
        );
        // 1. synthesize via the ENGINE DISPATCHER — routes to the engine the user
        //    selected: OS bridge (SAPI / say / espeak-ng / Piper) for OS-level
        //    models, the bundled formant engine otherwise. No more silent swap.
        if (prepared.substitutions > 0) {
          api.log(`Lexicon: ${prepared.substitutions} substitution${prepared.substitutions === 1 ? '' : 's'} (${prepared.applied.slice(0, 5).join(', ')}${prepared.applied.length > 5 ? '…' : ''})`);
        }
        const result = await synthesizeWithSelectedEngine(prepared.text, {
          model,
          profileId,
          osVoiceId: osVoiceId || undefined,
          voiceURI: voiceURI || undefined,
          rate, pitch, volume,
          quality: tuned.synthesisQuality,
          forceFallback: settings.fallbackMode,
          fallbackOnBridgeUnavailable: settings.autoFallback,
          onProgress: (p) => api.setProgress(p * 0.7, `Synthesizing ${(p * 100).toFixed(0)}%`),
        });
        const raw = result.buffer;
        api.log(`Engine actually used: ${result.engineLabel}`);
        if (result.fallbackReason) {
          api.log(result.fallbackReason);
          setEngineNote(result.fallbackReason);
          setEngine({ ttsEngine: 'fallback', fallbackReason: result.fallbackReason });
        } else {
          setEngine({ ttsEngine: result.engineUsed === 'os-bridge' ? 'os-bridge' : result.engineUsed === 'ai' ? 'ai' : 'fallback' });
        }
        api.log(`Synthesis done: ${raw.duration.toFixed(1)}s of audio`);
        if (api.shouldCancel()) return;
        await api.waitWhilePaused();
        // 2. DSP chain
        api.setProgress(0.72, 'Applying enhancements…');
        let buf = raw;
        if (opts.trimSilence) { buf = trimSilenceBuffer(buf); api.log('Trimmed silence'); }
        if (opts.normalize) { buf = normalizeBuffer(buf, -1); api.log('Normalized to -1 dBFS'); }
        if (opts.gainDb !== 0) { buf = gainBuffer(buf, opts.gainDb); api.log(`Applied ${opts.gainDb > 0 ? '+' : ''}${opts.gainDb} dB gain`); }
        if (opts.fadeIn > 0 || opts.fadeOut > 0) { buf = fadeBuffer(buf, opts.fadeIn, opts.fadeOut); api.log('Applied fades'); }
        const eqPreset = EQ_PRESETS.find((p) => p.id === eqPresetId) ?? EQ_PRESETS[0];
        if (eqPreset.eq.lowDb !== 0 || eqPreset.eq.midDb !== 0 || eqPreset.eq.highDb !== 0) {
          api.setProgress(0.74, `EQ: ${eqPreset.name}…`);
          buf = await eqBuffer(buf, eqPreset.eq);
          api.log(`EQ preset “${eqPreset.name}” (low ${eqPreset.eq.lowDb > 0 ? '+' : ''}${eqPreset.eq.lowDb} / mid ${eqPreset.eq.midDb > 0 ? '+' : ''}${eqPreset.eq.midDb} / high ${eqPreset.eq.highDb > 0 ? '+' : ''}${eqPreset.eq.highDb} dB)`);
        }
        if (useCompressor) {
          api.setProgress(0.76, 'Compressing dynamics…');
          buf = await compressBuffer(buf, VOICE_MASTER_COMPRESSOR);
          api.log(`Compressor: ${(VOICE_MASTER_COMPRESSOR.ratio)}:1 @ ${VOICE_MASTER_COMPRESSOR.thresholdDb} dB, +${VOICE_MASTER_COMPRESSOR.makeupDb} dB makeup`);
        }
        if (api.shouldCancel()) return;
        await api.waitWhilePaused();
        // 3. resample + encode
        api.setProgress(0.78, `Encoding ${getFormat(formatId)?.label ?? formatId}…`);
        const fmt = getFormat(formatId);
        const targetRate = settings.sampleRate || 44100;
        let exportBuf = buf;
        if (fmt && fmt.container !== 'Raw') {
          const { resampleBuffer } = await import('@/lib/engines/encode');
          exportBuf = await resampleBuffer(buf, targetRate, settings.channels);
        }
        const blob = await encodeAudioBufferChunked(exportBuf, formatId, {
          channels: settings.channels,
          dither: formatId.startsWith('wav-8') || formatId === 'raw-u8',
        }, (p) => api.setProgress(0.78 + p * 0.2, `Encoding ${(p * 100).toFixed(0)}%`));
        if (api.shouldCancel()) return;
        await api.waitWhilePaused();
        // 4. store asset
        const asset: AssetItem = {
          id: uid('asset'),
          name: `render-${Date.now().toString(36)}.${fmt?.extension ?? 'wav'}`,
          kind: 'audio',
          createdAt: Date.now(),
          mimeType: fmt?.mime ?? 'audio/wav',
          sizeBytes: blob.size,
          durationSec: exportBuf.duration,
          buffer: exportBuf,
          blobUrl: URL.createObjectURL(blob),
          meta: { engine: result.engineUsed, engineLabel: result.engineLabel, profile: profileId, chars: prepared.text.length, format: formatId, lexicon: prepared.substitutions, eq: eqPresetId, compressor: useCompressor },
        };
        addAsset(asset);
        setLastBuffer(exportBuf);
        setLastAsset(asset);
        stopRenderedPlayback();
        setRegion(null);
        setEnvelopePts([]); // fresh buffer → stale envelope points no longer apply
        setEnvelopeMode(false);
        setPlayhead(0);
        api.log(`Encoded ${formatBytes(blob.size)} → asset bin`);
        return { fileName: asset.name, bytes: blob.size, durationSec: exportBuf.duration };
      },
    );
    void jobId;
    // watch for completion
    const t = setInterval(() => {
      const jobs = useAppStore.getState().jobs;
      const job = jobs.find((j) => j.label.includes('words'));
      if (job && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) {
        setRendering(false);
        setRenderProgress(job.status === 'done' ? 1 : 0);
        clearInterval(t);
        if (job.status === 'done') {
          toast({ title: 'Render complete', description: `${job.label} — saved to asset bin.` });
          void import('@/lib/engines/speech').then(() => {});
        } else if (job.status === 'error') {
          toast({ title: 'Render failed', description: job.error, variant: 'destructive' });
        }
      } else if (job) {
        setRenderProgress(job.progress);
      }
    }, 400);
  }, [prepared, rendering, words, model, profileId, osVoiceId, voiceURI, rate, pitch, volume, tuned.synthesisQuality, opts, eqPresetId, useCompressor, formatId, settings.sampleRate, settings.channels, settings.fallbackMode, settings.autoFallback, addAsset, stopRenderedPlayback, setEngine, toast]);

  // ---------- highlight render ----------
  const highlighted = useMemo(() => {
    if (!boundary || !usesAI) return null;
    return { before: text.slice(0, boundary.index), word: boundary.word, after: text.slice(boundary.index + boundary.word.length) };
  }, [boundary, text, usesAI]);

  // ---------- text tools ----------
  const applyTextTool = useCallback((tool: 'clean' | 'strip-md' | 'strip-time' | 'sentences') => {
    setText((t) => {
      if (!t) return t;
      switch (tool) {
        case 'clean':
          return t.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        case 'strip-md':
          return t
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/(^|\s)#{1,6}\s/g, '$1')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^>\s?/gm, '')
            .replace(/~~([^~]+)~~/g, '$1');
        case 'strip-time':
          return t.replace(/\[?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\]?/g, '').replace(/-->\s*\d{1,2}:\d{2}[^\n]*\n?/g, '').replace(/\n{3,}/g, '\n\n').trim();
        case 'sentences':
          return t.replace(/\s*\n+\s*/g, ' ').replace(/([.!?])\s*(?=[A-Z])/g, '$1 ').replace(/\s{2,}/g, ' ').trim();
      }
    });
  }, []);

  // ---------- voice markup insertion ----------
  const insertMarkup = useCallback((before: string, after = '', placeholder = '') => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const selected = text.slice(start, end) || placeholder;
    const next = text.slice(0, start) + before + selected + after + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + before.length + selected.length;
      el.setSelectionRange(pos, pos);
    });
  }, [text]);

  const saveWaveformPng = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `waveform-${Date.now().toString(36)}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast({ title: 'Waveform image saved' });
    }, 'image/png');
  }, [toast]);

  const saveToVault = useCallback(async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await saveProject({
        name: text.slice(0, 40) || 'TTS Project',
        type: 'tts',
        data: { text, profileId, rate, pitch, volume, formatId, eqPresetId, useCompressor },
      });
      toast({ title: 'Saved to local vault', description: 'Project stored in this browser (IndexedDB) — nothing is uploaded.' });
    } catch (e) {
      toast({ title: 'Vault unavailable', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }, [text, profileId, rate, pitch, volume, formatId, eqPresetId, useCompressor, toast]);

  // ---------- studio hotkeys (⌘⏎ render · Space transport · ←/→ seek) ----------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        startRender();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ' && lastBuffer) {
        e.preventDefault();
        toggleRenderedPlayback();
      } else if (e.key === 'ArrowLeft' && lastBuffer) {
        e.preventDefault();
        const t = Math.max(0, playhead - 2);
        setPlayhead(t);
        if (renderedPlaying) startRenderedPlayback(t);
      } else if (e.key === 'ArrowRight' && lastBuffer) {
        e.preventDefault();
        const t = Math.min(lastBuffer.duration, playhead + 2);
        setPlayhead(t);
        if (renderedPlaying) startRenderedPlayback(t);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [startRender, toggleRenderedPlayback, startRenderedPlayback, renderedPlaying, playhead, lastBuffer]);

  const stats = lastBuffer ? analyzeBuffer(lastBuffer) : null;
  const activeEqPreset = EQ_PRESETS.find((p) => p.id === eqPresetId) ?? EQ_PRESETS[0];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <SectionPanel
          title="Text input"
          description="Type, paste, or send text from other modules. Rendered entirely on this machine."
          actions={
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="tabular-nums">{formatNumber(text.length)} chars · {formatNumber(words)} words</Badge>
              <Badge variant="outline" className="tabular-nums">≈ {formatDuration(estSec)}</Badge>
            </div>
          }
        >
          <div className="relative">
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type or paste the text you want to hear… Use [pause 500], [em]emphasis[/em], [rate 1.15]…[/rate], [spell]NASA[/spell] or [whisper]…[/whisper] for expressive control."
              className="min-h-44 resize-y text-sm leading-relaxed"
              aria-label="Text to synthesize"
            />
            {highlighted && playing && (
              <div className="pointer-events-none absolute inset-0 rounded-md border border-violet-500/40 bg-background/95 p-3 text-sm leading-relaxed overflow-hidden">
                <span className="text-muted-foreground">{highlighted.before.slice(-220)}</span>
                <mark className="rounded bg-violet-500/25 px-0.5 font-semibold text-foreground">{highlighted.word}</mark>
                <span className="text-muted-foreground">{highlighted.after.slice(0, 220)}</span>
              </div>
            )}
          </div>
          {lexOn && prepared.substitutions > 0 && (
            <div className="mt-2 flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
              <BookA className="h-3.5 w-3.5 shrink-0" />
              <span>
                Lexicon will replace <strong>{prepared.substitutions}</strong> match{prepared.substitutions === 1 ? '' : 'es'}: {prepared.applied.slice(0, 6).join(', ')}{prepared.applied.length > 6 ? '…' : ''}
              </span>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              Voice markup
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground" aria-label="Voice markup help">
                    <CircleHelp className="h-3.5 w-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-80 text-xs" align="start">
                  <div className="space-y-2">
                    <div className="font-medium">Voice markup cheat sheet</div>
                    <p className="text-muted-foreground">Inline tags honored by the built-in engine in previews and file renders. AI voices read the stripped text.</p>
                    <div className="space-y-1.5 font-mono text-[11px]">
                      <div><span className="rounded bg-muted px-1">[pause 500]</span> <span className="font-sans text-muted-foreground">500 ms of silence (or 1.5s)</span></div>
                      <div><span className="rounded bg-muted px-1">[break]</span> <span className="font-sans text-muted-foreground">short breath pause</span></div>
                      <div><span className="rounded bg-muted px-1">[em]…[/em]</span> <span className="font-sans text-muted-foreground">emphasis: slower, brighter, louder</span></div>
                      <div><span className="rounded bg-muted px-1">[rate 1.2]…[/rate]</span> <span className="font-sans text-muted-foreground">speed span</span></div>
                      <div><span className="rounded bg-muted px-1">[pitch 0.9]…[/pitch]</span> <span className="font-sans text-muted-foreground">pitch span</span></div>
                      <div><span className="rounded bg-muted px-1">[spell]NASA[/spell]</span> <span className="font-sans text-muted-foreground">letter-by-letter</span></div>
                      <div><span className="rounded bg-muted px-1">[whisper]…[/whisper]</span> <span className="font-sans text-muted-foreground">quiet breathy delivery</span></div>
                    </div>
                    <p className="text-muted-foreground">Tags nest — styles compose. Unknown [brackets] stay as plain text.</p>
                  </div>
                </PopoverContent>
              </Popover>
            </span>
            <Button size="sm" variant="secondary" className="h-7 px-2 font-mono text-[11px]" onClick={() => insertMarkup('[pause 500]')} title="Insert 500 ms pause">[pause]</Button>
            <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" onClick={() => insertMarkup('[em]', '[/em]', 'word')} title="Wrap selection in emphasis">emphasis</Button>
            <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" onClick={() => insertMarkup('[rate 1.15]', '[/rate]', '')} title="Wrap selection in a rate span">rate</Button>
            <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" onClick={() => insertMarkup('[spell]', '[/spell]', 'NASA')} title="Wrap selection to spell letter-by-letter">spell</Button>
            <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" onClick={() => insertMarkup('[whisper]', '[/whisper]', '')} title="Wrap selection in a whisper">whisper</Button>
            {markupInfo.hasMarkup && (
              <Badge variant="outline" className="h-5 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600">
                {markupInfo.tagsUsed.join(' · ')}
              </Badge>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={playing ? stopPreview : startPreview} disabled={!text.trim()}>
              {playing ? <Square className="mr-1.5 h-3.5 w-3.5" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
              {playing ? 'Stop' : 'Preview'}
            </Button>
            <Button size="sm" variant="outline" onClick={togglePause} disabled={!playing && !audioSrcRef.current}>
              <Pause className="mr-1.5 h-3.5 w-3.5" />Pause / Resume
            </Button>
            <Button size="sm" onClick={startRender} disabled={!text.trim() || rendering}>
              {rendering ? <Waves className="mr-1.5 h-3.5 w-3.5 animate-pulse" /> : <AudioLines className="mr-1.5 h-3.5 w-3.5" />}
              {rendering ? 'Rendering…' : 'Render to audio'}
            </Button>
            <Button size="sm" variant="outline" onClick={runAiDirection} disabled={!text.trim()}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />AI director
            </Button>
            {aiDirectorNotes && (
              <span className="text-[11px] text-muted-foreground">{aiDirectorNotes[0]}</span>
            )}
            <Button size="sm" variant="ghost" onClick={() => setText(SAMPLE_TEXT)}>
              <Wand2 className="mr-1.5 h-3.5 w-3.5" />Sample text
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => applyTextTool('clean')} disabled={!text} title="Collapse whitespace, keep paragraphs">
                Clean spaces
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => applyTextTool('strip-md')} disabled={!text} title="Remove markdown syntax">
                Strip markdown
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => applyTextTool('strip-time')} disabled={!text} title="Remove timestamps like [00:12] or 00:00:00">
                Remove timestamps
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => applyTextTool('sentences')} disabled={!text} title="Join lines into flowing sentences">
                Flow sentences
              </Button>
            </div>
            {playing && <Progress value={playProgress * 100} className="ml-1 h-1.5 w-28" />}
          </div>
          {engineNote && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{engineNote}</span>
            </div>
          )}
        </SectionPanel>

        {lastBuffer && (
          <SectionPanel
            title="Rendered output"
            description={`${getFormat(formatId)?.label} · ${formatDuration(lastBuffer.duration)} · ${settings.sampleRate} Hz`}
            actions={
              <div className="flex gap-1.5">
                {lastBuffer && (
                  <Button size="sm" variant="outline" onClick={saveWaveformPng}>
                    <Waves className="mr-1.5 h-3.5 w-3.5" />Save waveform
                  </Button>
                )}
                {lastAsset?.blobUrl && (
                  <Button size="sm" variant="outline" asChild>
                    <a href={lastAsset.blobUrl} download={lastAsset.name}>
                      <Download className="mr-1.5 h-3.5 w-3.5" />Download
                    </a>
                  </Button>
                )}
              </div>
            }
          >
            <div
              ref={waveScrollRef}
              className={cn(
                'overflow-x-auto overflow-y-hidden rounded-md border bg-muted/30',
                (renderedPlaying || playhead > 0) && 'border-violet-500/40',
                region && 'border-amber-500/50',
              )}
            >
              <canvas
                ref={canvasRef}
                className="block h-[114px] cursor-crosshair touch-none select-none"
                aria-label={envelopeMode
                  ? 'Waveform volume envelope — click to add or move a gain point, right-click to delete a point'
                  : 'Waveform — click to seek, drag to select a region, scroll horizontally when zoomed'}
                onPointerDown={envelopeMode ? onEnvelopePointerDown : onWavePointerDown}
                onPointerMove={envelopeMode ? onEnvelopePointerMove : onWavePointerMove}
                onPointerUp={envelopeMode ? onEnvelopePointerUp : onWavePointerUp}
                onPointerCancel={() => { regionDragRef.current = null; draggingRef.current = false; envDragRef.current = null; }}
                onContextMenu={envelopeMode ? onEnvelopeContextMenu : undefined}
              />
            </div>
            <div className="envelope-toolbar mt-2 flex flex-wrap items-center gap-2">
              <Button size="icon" variant="outline" className="h-8 w-8" onClick={toggleRenderedPlayback} aria-label={renderedPlaying ? 'Pause playback' : 'Play rendered audio'}>
                {renderedPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                <span className={cn('font-medium', renderedPlaying && 'text-emerald-600')}>{formatDuration(playhead)}</span>
                {' / '}{formatDuration(lastBuffer.duration)}
              </span>
              {region && region.end - region.start > 0.001 && (
                <Badge variant="outline" className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600">
                  <Square className="h-2.5 w-2.5" />
                  {formatDuration(region.start)}–{formatDuration(region.end)} · {formatDuration(region.end - region.start)}
                </Badge>
              )}
              <Button
                size="sm"
                variant={loopPlayback ? 'secondary' : 'ghost'}
                className={cn('h-7 px-2 text-[11px]', loopPlayback && 'text-violet-600')}
                onClick={() => setLoopPlayback((v) => !v)}
                aria-pressed={loopPlayback}
                title="Loop playback"
              >
                <Repeat className="mr-1 h-3 w-3" />Loop
              </Button>
              <Select
                value={String(speed)}
                onValueChange={(v) => {
                  const s = Number(v);
                  setSpeed(s);
                  if (renderedPlaying) startRenderedPlayback(playhead);
                }}
              >
                <SelectTrigger className="h-7 w-24 text-[11px]" aria-label="Playback speed"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                    <SelectItem key={s} value={String(s)}>{s}× speed</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {envelopePts.length > 0 && (
                <Badge variant="outline" className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-600">
                  <AudioWaveform className="h-2.5 w-2.5" />
                  envelope: {envelopePts.length} pts
                </Badge>
              )}
              <Button
                size="sm"
                variant={envelopeMode ? 'secondary' : 'ghost'}
                className={cn('h-7 px-2 text-[11px]', envelopeMode && 'text-violet-600')}
                onClick={() => setEnvelopeMode((v) => !v)}
                aria-pressed={envelopeMode}
                title="Volume envelope"
              >
                <AudioWaveform className="mr-1 h-3 w-3" />Envelope
              </Button>
              {envelopeMode && (
                <>
                  <Button
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={applyEnvelope}
                    disabled={envelopePts.length === 0}
                    title="Bake the drawn envelope into the working buffer"
                  >
                    <Check className="mr-1 h-3 w-3" />Apply envelope
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setEnvelopePts([])}
                    disabled={envelopePts.length === 0}
                    title="Remove all envelope points"
                  >
                    <RotateCcw className="mr-1 h-3 w-3" />Reset
                  </Button>
                </>
              )}
              {region && region.end - region.start > 0.001 && (
                <>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={exportRegion}
                    title="Save the selected region as a new asset in the chosen format">
                    <Scissors className="mr-1 h-3 w-3" />Export selection
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={trimToRegion}
                    title="Replace the working buffer with just the selection">
                    <Crop className="mr-1 h-3 w-3" />Trim to selection
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setRegion(null)} aria-label="Clear selection" title="Clear selection">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
              {envelopeMode ? (
                <span className="ml-auto hidden text-[11px] text-muted-foreground/70 sm:inline">click: add/move point · right-click: delete point</span>
              ) : (
                <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">click to seek · drag to select a region</span>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5">
              <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><ZoomIn className="h-3 w-3" />zoom</span>
              <Slider
                value={[zoom]}
                min={1}
                max={40}
                step={1}
                className="h-4 max-w-52 flex-1"
                onValueChange={([v]) => setZoom(v)}
                aria-label="Waveform zoom"
              />
              <span className="w-10 text-right text-[11px] tabular-nums text-muted-foreground">{zoom}×</span>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setZoom(1)} disabled={zoom === 1}>Fit</Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  const scroller = waveScrollRef.current;
                  if (!scroller || !lastBuffer) return;
                  const x = (playhead / (lastBuffer.duration || 1)) * scroller.scrollWidth;
                  scroller.scrollTo({ left: Math.max(0, x - scroller.clientWidth / 2), behavior: 'smooth' });
                }}
              >
                Center playhead
              </Button>
            </div>
            {stats && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded-md border bg-muted/30 p-2"><div className="text-[10px] uppercase text-muted-foreground">Peak</div><div className="font-medium tabular-nums">{stats.peakDb.toFixed(1)} dB</div></div>
                <div className="rounded-md border bg-muted/30 p-2"><div className="text-[10px] uppercase text-muted-foreground">RMS</div><div className="font-medium tabular-nums">{stats.rmsDb.toFixed(1)} dB</div></div>
                <div className="rounded-md border bg-muted/30 p-2"><div className="text-[10px] uppercase text-muted-foreground">Duration</div><div className="font-medium tabular-nums">{formatDuration(stats.durationSec)}</div></div>
                <div className="rounded-md border bg-muted/30 p-2"><div className="text-[10px] uppercase text-muted-foreground">Clipping</div><div className="font-medium tabular-nums">{stats.clippingPct.toFixed(2)}%</div></div>
              </div>
            )}
          </SectionPanel>
        )}
      </div>

      {/* right column */}
      <div className="space-y-4">
        <SectionPanel title="Engine & Voice" description="Model family, engine and voice selection.">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Local model</Label>
              <Select value={modelId} onValueChange={(v) => { setModelId(v); setSetting('preferredModelId', v); }}>
                <SelectTrigger aria-label="Model"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {TTS_MODELS.filter((m) => m.bundled).map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name} <span className="text-muted-foreground">· {m.family}</span></SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-1.5">
                {model.tags.map((t) => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}
                {model.gpuRecommended && <Badge variant="outline" className="text-[10px] border-violet-500/30 text-violet-600">GPU recommended</Badge>}
              </div>
            </div>

            {(isBridgeModel || model.engine.startsWith('system')) && (
              <div className={cn('rounded-md border p-2.5 text-[11px] leading-relaxed', bridgeUp ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Server className="h-3.5 w-3.5" />
                    OS speech bridge {bridgeProbing ? '· probing…' : bridgeUp
                      ? `· online (${bridgeVoices.length} OS voices)`
                      : '· not running'}
                  </span>
                  <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[11px]" onClick={() => void retryBridge()} disabled={bridgeProbing}>
                    <RefreshCw className={cn('h-3 w-3', bridgeProbing && 'animate-spin')} />Retry
                  </Button>
                </div>
                {bridgeUp ? (
                  <p className="mt-1 text-muted-foreground">
                    Detected: {Object.entries(bridgeStatus?.engines ?? {}).filter(([, ok]) => ok).map(([id]) => OS_ENGINE_CAPS[id as keyof typeof OS_ENGINE_CAPS]?.label ?? id).join(' · ') || 'system engines'} — renders use the real OS voice.
                  </p>
                ) : (
                  <>
                    <p className="mt-1 text-muted-foreground">
                      Renders with OS voices need the local bridge server (the browser alone cannot capture system speech to files). Start it next to the app:
                    </p>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">npm run os-tts</code>
                      <Input
                        value={bridgeUrlDraft}
                        onChange={(e) => setBridgeUrlDraft(e.target.value)}
                        placeholder={getBridgeUrl()}
                        className="h-6 max-w-44 bg-background font-mono text-[10px]"
                        aria-label="Bridge server URL"
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {isBridgeModel && bridgeUp ? (
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5 text-xs"><Server className="h-3.5 w-3.5" />OS voice ({bridgeVoices.length} from your system)</Label>
                <Select value={osVoiceId || 'auto'} onValueChange={(v) => updateOsVoiceId(v === 'auto' ? '' : v)}>
                  <SelectTrigger aria-label="OS voice"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value="auto">Auto (best match per voice profile)</SelectItem>
                    {bridgeVoices.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name} <span className="text-muted-foreground">({v.lang} · {OS_ENGINE_CAPS[v.engine]?.label ?? v.engine})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Previews AND file exports render through this exact OS engine and voice.
                </p>
              </div>
            ) : usesAI ? (
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5 text-xs"><Mic2 className="h-3.5 w-3.5" />System voice ({systemVoices.length} detected · {voiceClass} class)</Label>
                <Select value={voiceURI || 'auto'} onValueChange={(v) => { setVoiceURI(v === 'auto' ? '' : v); setSetting('preferredVoiceURI', v === 'auto' ? '' : v); }}>
                  <SelectTrigger aria-label="Voice"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value="auto">Auto (best {voiceClass} match)</SelectItem>
                    {systemVoices.map((v) => (
                      <SelectItem key={v.voiceURI} value={v.voiceURI}>{v.name} <span className="text-muted-foreground">({v.lang})</span></SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {voiceClass === 'classic'
                    ? 'Classic local voices are preferred automatically — the model selection is honored.'
                    : 'Neural/natural voices are preferred automatically. '}
                  {bridgeUp
                    ? 'File exports render through the OS speech bridge when this model is rendered.'
                    : 'Start the OS speech bridge (npm run os-tts) to render files with real OS voices.'}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5 text-xs"><Sparkles className="h-3.5 w-3.5" />Voice profile <span className="text-muted-foreground">({voiceProfiles.length})</span></Label>
                <Select value={profileId} onValueChange={setProfileId}>
                  <SelectTrigger aria-label="Voice profile"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {voiceProfiles.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name} <span className="text-muted-foreground">· {v.gender}</span>
                        {isCustomProfile(v) && (
                          <span className="ml-1.5 rounded border border-violet-500/40 px-1 align-middle text-[9px] font-medium uppercase tracking-wide text-violet-600">custom</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">{selectedProfile?.description}</p>
                {!selectedProfile && (
                  <p className="text-[11px] text-amber-600">
                    That profile no longer exists — synthesis falls back to the default built-in voice until you pick another.
                  </p>
                )}
              </div>
            )}

            <Separator />

            {([
              ['Rate', rate, setRate, 0.5, 2, 0.05, '×'],
              ['Pitch', pitch, setPitch, 0.5, 1.8, 0.05, '×'],
              ['Volume', volume, setVolume, 0, 1, 0.05, ''],
            ] as const).map(([label, val, set, min, max, step, suffix]) => (
              <div key={label} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">{label}</Label>
                  <span className="text-xs tabular-nums text-muted-foreground">{val.toFixed(2)}{suffix}</span>
                </div>
                <Slider value={[val]} min={min} max={max} step={step} onValueChange={([v]) => set(v)} aria-label={label} />
              </div>
            ))}
          </div>
        </SectionPanel>

        <SectionPanel
          title="Pronunciation lexicon"
          description="Shared word→saying dictionary applied before synthesis."
          actions={
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] tabular-nums">{activeLexRules} active</Badge>
              <Switch checked={lexOn} onCheckedChange={setLexOn} aria-label="Apply lexicon" />
            </div>
          }
        >
          <div className="space-y-2">
            <ScrollArea className="max-h-44">
              <div className="space-y-1.5">
                {lexRules.length === 0 && (
                  <p className="rounded-md border border-dashed p-3 text-center text-[11px] text-muted-foreground">
                    No rules yet — add one below or load a preset. Rules apply across TTS Studio and Dialogue Studio.
                  </p>
                )}
                {lexRules.map((rule) => (
                  <div key={rule.id} className="group flex items-center gap-1.5 rounded-md border p-1.5 transition-colors hover:border-violet-500/40">
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={(v) => updateLexRules(lexRules.map((r) => (r.id === rule.id ? { ...r, enabled: v } : r)))}
                      aria-label={`Rule ${rule.find}`}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{rule.find}</span>
                    <span className="text-[10px] text-muted-foreground">→</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-emerald-600">{rule.replace}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label={`Audition replacement for ${rule.find}`}
                      title={`Hear “${rule.replace}”`}
                      onClick={() => auditionLexRule(rule)}
                    >
                      <Volume2 className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      aria-label={`Delete rule ${rule.find}`}
                      title="Delete rule"
                      onClick={() => updateLexRules(lexRules.filter((r) => r.id !== rule.id))}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <div className="flex gap-1.5">
              <Input value={newFind} onChange={(e) => setNewFind(e.target.value)} placeholder="word" className="h-8 flex-1 font-mono text-xs" aria-label="New rule find" />
              <Input value={newReplace} onChange={(e) => setNewReplace(e.target.value)} placeholder="saying" className="h-8 flex-1 font-mono text-xs" aria-label="New rule replacement"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newFind.trim() && newReplace.trim()) {
                    updateLexRules([...lexRules, { id: uid('lex'), find: newFind.trim(), replace: newReplace.trim(), enabled: true }]);
                    setNewFind(''); setNewReplace('');
                  }
                }} />
              <Button
                size="icon"
                variant="secondary"
                className="h-8 w-8"
                aria-label="Add lexicon rule"
                title="Add rule"
                disabled={!newFind.trim() || !newReplace.trim()}
                onClick={() => {
                  updateLexRules([...lexRules, { id: uid('lex'), find: newFind.trim(), replace: newReplace.trim(), enabled: true }]);
                  setNewFind(''); setNewReplace('');
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]"><Upload className="mr-1 h-3 w-3" />Import</Button>
                </PopoverTrigger>
                <PopoverContent className="w-80" align="start">
                  <div className="space-y-2">
                    <div className="text-xs font-medium">Import rules</div>
                    <p className="text-[11px] text-muted-foreground">One per line: <span className="font-mono">find =&gt; replace</span> (also accepts CSV/TSV, # comments).</p>
                    <Textarea value={lexImportText} onChange={(e) => setLexImportText(e.target.value)} className="min-h-24 font-mono text-[11px]" placeholder={'Kubernetes => koo-ber-net-eez'} aria-label="Lexicon import text" />
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        disabled={!lexImportText.trim()}
                        onClick={() => {
                          const parsed = parseLexiconText(lexImportText);
                          if (!parsed.length) { toast({ title: 'No rules found', variant: 'destructive' }); return; }
                          const merged = mergeLexicon(lexRules, parsed);
                          updateLexRules(merged.rules);
                          setLexImportText('');
                          toast({ title: 'Lexicon updated', description: `${merged.added} new rule${merged.added === 1 ? '' : 's'} added.` });
                        }}
                      >
                        Merge {lexImportText ? `(${parseLexiconText(lexImportText).length})` : ''}
                      </Button>
                      <label className="inline-flex cursor-pointer items-center">
                        <Button size="sm" variant="ghost" asChild><span>From file…</span></Button>
                        <input
                          type="file"
                          accept=".txt,.csv,.tsv,.json,text/plain"
                          className="sr-only"
                          aria-label="Import lexicon file"
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (!f) return;
                            try {
                              const raw = await f.text();
                              let parsed = parseLexiconText(raw);
                              if (f.name.endsWith('.json')) {
                                try {
                                  const arr = JSON.parse(raw) as { find: string; replace: string }[];
                                  if (Array.isArray(arr)) parsed = arr.map((r, i) => ({ id: uid('lex'), find: String(r.find ?? ''), replace: String(r.replace ?? ''), enabled: true })).filter((r) => r.find && r.replace);
                                } catch { /* fall back to line parser */ }
                              }
                              const merged = mergeLexicon(lexRules, parsed);
                              updateLexRules(merged.rules);
                              toast({ title: 'Lexicon updated', description: `${merged.added} new rule${merged.added === 1 ? '' : 's'} from ${f.name}.` });
                            } catch {
                              toast({ title: 'Import failed', variant: 'destructive' });
                            }
                          }}
                        />
                      </label>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                disabled={!lexRules.length}
                onClick={() => {
                  const blob = new Blob([serializeLexicon(lexRules)], { type: 'text/plain' });
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = 'auravoice-lexicon.txt';
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
                }}
              >
                <Download className="mr-1 h-3 w-3" />Export
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]"><Sparkles className="mr-1 h-3 w-3" />Presets</Button>
                </PopoverTrigger>
                <PopoverContent className="w-72" align="start">
                  <div className="space-y-2">
                    <div className="text-xs font-medium">Preset dictionaries</div>
                    {LEXICON_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="w-full rounded-md border p-2 text-left transition-colors hover:bg-accent"
                        onClick={() => {
                          const incoming = p.rules.map(([find, replace], i) => ({ id: uid('lex'), find, replace, enabled: true }));
                          const merged = mergeLexicon(lexRules, incoming);
                          updateLexRules(merged.rules);
                          toast({ title: `“${p.name}” applied`, description: `${merged.added} rule${merged.added === 1 ? '' : 's'} added.` });
                        }}
                      >
                        <div className="text-xs font-medium">{p.name}</div>
                        <div className="text-[11px] text-muted-foreground">{p.description} · {p.rules.length} rules</div>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              {lexRules.length > 0 && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-rose-500 hover:text-rose-600" onClick={() => updateLexRules([])}>
                  <Flame className="mr-1 h-3 w-3" />Clear all
                </Button>
              )}
            </div>
          </div>
        </SectionPanel>

        <SectionPanel
          title="Enhancer"
          description="Tone shaping and dynamics — real biquad EQ + compressor rendered offline."
          actions={
            (eqPresetId !== 'natural' || useCompressor) && (
              <Badge variant="outline" className="gap-0.5 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600">
                <Sparkles className="h-2.5 w-2.5" />
                {eqPresetId !== 'natural' ? EQ_PRESETS.find((p) => p.id === eqPresetId)?.name : ''}
                {eqPresetId !== 'natural' && useCompressor ? ' + ' : ''}
                {useCompressor ? 'Comp' : ''}
              </Badge>
            )
          }
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">EQ character</Label>
              <Select value={eqPresetId} onValueChange={setEqPresetId}>
                <SelectTrigger aria-label="EQ preset"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EQ_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} <span className="text-muted-foreground">· {p.description}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {eqPresetId !== 'natural' && (
                <div className="flex items-end justify-center gap-3 rounded-md border bg-muted/30 px-3 py-2.5">
                  {([['LOW', activeEqPreset.eq.lowDb], ['MID', activeEqPreset.eq.midDb], ['HIGH', activeEqPreset.eq.highDb]] as const).map(([band, db]) => {
                    const pct = Math.min(1, Math.abs(db) / 12);
                    const up = db >= 0;
                    return (
                      <div key={band} className="flex w-14 flex-col items-center gap-1">
                        <div className="relative flex h-12 w-full items-center justify-center">
                          <span className="absolute inset-x-1 top-1/2 h-px bg-border" aria-hidden />
                          <div
                            className={cn('absolute w-5 rounded-sm transition-all', up ? 'bottom-1/2 bg-emerald-500/70' : 'top-1/2 bg-rose-500/70')}
                            style={{ height: `${Math.max(2, pct * 44)}px` }}
                            aria-hidden
                          />
                        </div>
                        <span className="text-[9px] font-semibold tracking-wider text-muted-foreground">{band}</span>
                        <span className={cn('text-[10px] font-medium tabular-nums', up ? 'text-emerald-600' : 'text-rose-600')}>
                          {db > 0 ? '+' : ''}{db} dB
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="text-sm">Dynamics compressor</Label>
                <p className="text-[11px] text-muted-foreground">3.5:1 @ −24 dB, +2 dB makeup — evens quiet words</p>
              </div>
              <Switch checked={useCompressor} onCheckedChange={setUseCompressor} aria-label="Enable compressor" />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Applied during render (and logged in the job). Preview is unaffected.
            </p>
          </div>
        </SectionPanel>

        <SectionPanel title="Export format" description={`${AUDIO_FORMATS.length} genuinely-encoded formats — pick one for the render.`}>
          <div className="space-y-3">
            <Select value={formatId} onValueChange={(v) => { setFormatId(v); setSetting('outputFormat', v); }}>
              <SelectTrigger aria-label="Export format"><SelectValue /></SelectTrigger>
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
                    : <>
                      {`${availableCount} of ${AUDIO_FORMATS.length} formats available on this device`}
                      {selectedEstimate !== null && (
                        <span className="text-[10px]"> · ~{formatBytes(selectedEstimate)} as {getFormat(formatId)?.label}</span>
                      )}
                    </>}
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
                <AlertTitle className="text-xs">{getFormat(formatId)?.label ?? formatId} is unavailable on this device</AlertTitle>
                <AlertDescription className="text-[11px] text-amber-700/90 dark:text-amber-400/90">
                  This format needs MediaRecorder support that your browser lacks — renders will fail and the
                  job will log the error. Switch to a WAV format (always available) or Ogg Opus.
                </AlertDescription>
              </Alert>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Sample rate</Label>
                <Select value={String(settings.sampleRate)} onValueChange={(v) => setSetting('sampleRate', Number(v))}>
                  <SelectTrigger aria-label="Sample rate"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[8000, 16000, 22050, 32000, 44100, 48000, 88200, 96000].map((r) => (
                      <SelectItem key={r} value={String(r)}>{r >= 1000 ? `${r / 1000} kHz` : `${r} Hz`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Channels</Label>
                <Select value={String(settings.channels)} onValueChange={(v) => setSetting('channels', Number(v) as 1 | 2)}>
                  <SelectTrigger aria-label="Channels"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Mono</SelectItem>
                    <SelectItem value="2">Stereo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Separator />
            <div className="space-y-2.5">
              {([
                ['normalize', 'Normalize to −1 dBFS'],
                ['trimSilence', 'Trim leading/trailing silence'],
              ] as const).map(([k, label]) => (
                <div key={k} className="flex items-center justify-between">
                  <Label className="text-xs">{label}</Label>
                  <Switch checked={opts[k]} onCheckedChange={(v) => setOpts((o) => ({ ...o, [k]: v }))} />
                </div>
              ))}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Gain trim</Label>
                  <span className="text-xs tabular-nums text-muted-foreground">{opts.gainDb > 0 ? '+' : ''}{opts.gainDb} dB</span>
                </div>
                <Slider value={[opts.gainDb]} min={-12} max={6} step={0.5} onValueChange={([v]) => setOpts((o) => ({ ...o, gainDb: v }))} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Fade in (s)</Label>
                  <Input type="number" min={0} max={5} step={0.01} value={opts.fadeIn}
                    onChange={(e) => setOpts((o) => ({ ...o, fadeIn: Math.max(0, Number(e.target.value)) }))} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Fade out (s)</Label>
                  <Input type="number" min={0} max={5} step={0.01} value={opts.fadeOut}
                    onChange={(e) => setOpts((o) => ({ ...o, fadeOut: Math.max(0, Number(e.target.value)) }))} />
                </div>
              </div>
            </div>
          </div>
        </SectionPanel>

        <SectionPanel
          title="Batch export"
          description="Renders once, encodes many — every file stays in the Asset Bin."
          actions={
            <Badge variant="outline" className="text-[10px] tabular-nums">
              {batchIds.length} selected
            </Badge>
          }
        >
          <div className="space-y-2">
            <div className="max-h-64 space-y-1 overflow-y-auto pr-1" role="group" aria-label="Batch export formats">
              {AUDIO_FORMATS.map((f) => {
                // null = probes not ready yet (pre-mount) — render a neutral row so the
                // server HTML matches the first client render exactly (R8-c pattern)
                const probe = mounted ? formatDotState(f.id) : null;
                const unavailable = probe === 'none';
                const checked = batchIds.includes(f.id);
                const atCap = batchIds.length >= MAX_BATCH_FORMATS;
                const bytes = lastBuffer ? (batchEstimates[f.id] ?? null) : null;
                return (
                  <label
                    key={f.id}
                    className={cn(
                      'flex h-7 cursor-pointer items-center gap-2 rounded-md border px-2 text-[11px] transition-colors',
                      checked ? 'border-emerald-500/30 bg-emerald-500/10' : 'hover:bg-accent/60',
                      unavailable && 'cursor-not-allowed border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
                    )}
                    title={unavailable
                      ? 'This browser lacks the codec for this format'
                      : !checked && atCap
                        ? `Deselect a format to add this one (max ${MAX_BATCH_FORMATS})`
                        : undefined}
                  >
                    <Checkbox
                      className="h-3.5 w-3.5"
                      checked={checked}
                      disabled={unavailable || (!checked && atCap)}
                      onCheckedChange={(v) => toggleBatchFormat(f.id, v === true)}
                      aria-label={`${f.label}${probe ? ` — ${FORMAT_STATE_ARIA[probe]}` : ''}`}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {f.label}
                      <span className="text-muted-foreground"> · .{f.extension}</span>
                    </span>
                    {probe && probe !== 'none' && (
                      <span
                        role="img"
                        aria-label={FORMAT_STATE_ARIA[probe]}
                        className={cn('codec-dot inline-flex h-1.5 w-1.5 shrink-0 rounded-full', probe === 'native' ? 'bg-emerald-500' : 'bg-violet-500')}
                      />
                    )}
                    {unavailable ? (
                      <span className="shrink-0 text-[10px] font-medium">no codec</span>
                    ) : (
                      <span className={cn('batch-estimate w-16 shrink-0 text-right text-[10px] tabular-nums', checked ? 'text-foreground' : 'text-muted-foreground')}>
                        {bytes !== null ? `~${formatBytes(bytes)}` : '—'}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                {batchIds.length === 0
                  ? 'Nothing selected'
                  : `Max ${MAX_BATCH_FORMATS} at once${batchIds.length >= MAX_BATCH_FORMATS ? ' — deselect one to add another' : ''}`}
              </span>
              {batchTotalBytes !== null && (
                <span className="tabular-nums">~{formatBytes(batchTotalBytes)} total</span>
              )}
            </div>
            <Button
              className="h-11 w-full sm:h-9"
              onClick={startBatchExport}
              disabled={!lastBuffer || batchIds.length === 0 || batchRunning}
              title={lastBuffer
                ? `Encode ${batchIds.length} format${batchIds.length === 1 ? '' : 's'} from the current buffer into the Asset Bin`
                : 'Render audio first — batch export encodes the current working buffer'}
              aria-label={batchRunning
                ? 'Batch export running'
                : `Batch export ${batchIds.length} format${batchIds.length === 1 ? '' : 's'}`}
            >
              {batchRunning
                ? <Waves className="mr-1.5 h-3.5 w-3.5 animate-pulse" />
                : <HardDriveDownload className="mr-1.5 h-3.5 w-3.5" />}
              {batchRunning ? 'Exporting…' : `Export ${batchIds.length} format${batchIds.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </SectionPanel>

        <Card>
          <CardContent className="flex flex-wrap items-center gap-2 p-4">
            <Button size="sm" variant="outline" onClick={saveToVault} disabled={!text.trim() || saving}>
              <Save className="mr-1.5 h-3.5 w-3.5" />{saving ? 'Saving…' : 'Save to local vault'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setText(''); setLastBuffer(null); stopPreview(); stopRenderedPlayback(); setRegion(null); setEnvelopePts([]); setEnvelopeMode(false); setPlayhead(0); }}
              disabled={!text}
            >
              <Flame className="mr-1.5 h-3.5 w-3.5" />Clear
            </Button>
            <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <HardDriveDownload className="h-3.5 w-3.5" />chunked · no-freeze pipeline
              <Zap className="h-3.5 w-3.5 text-amber-500" />{tuned.ttsThreads} threads
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
