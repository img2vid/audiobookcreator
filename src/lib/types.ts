// ============================================================
// Openmukti Audiobook Creator — shared domain types
// Single source of truth for all engines, stores and views.
// ============================================================

// ---------- Navigation ----------
export type ViewId =
  | 'dashboard'
  | 'assets'
  | 'autobook'
  | 'tts'
  | 'dialogue'
  | 'files'
  | 'ocr'
  | 'audiobook'
  | 'video'
  | 'transcribe'
  | 'voices'
  | 'queue'
  | 'settings'
  | 'features';

// ---------- Hardware profiling ----------
export interface CpuModel {
  id: string;
  name: string;
  cores: number;
  threads: number;
  baseGhz: number;
  boostGhz?: number;
  tdpW?: number;
  year?: number;
}
export interface CpuGeneration {
  id: string;
  name: string;
  years: string;
  models: CpuModel[];
}
export interface CpuBrand {
  id: string; // 'intel' | 'amd' | 'apple' | 'qualcomm' | 'custom'
  name: string;
  generations: CpuGeneration[];
}

export interface GpuModel {
  id: string;
  name: string;
  vramGB: number;
  teraflops: number;
  tensorCores?: number;
  year?: number;
}
export interface GpuGeneration {
  id: string;
  name: string;
  years: string;
  models: GpuModel[];
}
export interface GpuBrand {
  id: string; // 'nvidia' | 'amd' | 'intel' | 'apple' | 'qualcomm' | 'custom'
  name: string;
  generations: GpuGeneration[];
}

export interface PCProfile {
  cpuBrand: string;
  cpuGeneration: string;
  cpuModel: string;
  customCpu: { clockGhz: number; cores: number; threads: number };
  gpuEnabled: boolean;
  gpuBrand: string;
  gpuGeneration: string;
  gpuModel: string;
  customGpu: { vramGB: number; teraflops: number };
  ramGB: number;
  storage: 'hdd' | 'sata-ssd' | 'nvme' | 'nvme-gen4' | 'nvme-gen5';
  os: 'windows' | 'macos' | 'linux';
}

export type Tier = 'low' | 'mid' | 'high' | 'ultra';
export type OcrPower = 'lite' | 'standard' | 'heavy' | 'ultra';
export type SynthQuality = 'fast' | 'balanced' | 'high' | 'max';

export interface TunedSettings {
  score: number; // 0..100 hardware score
  tier: Tier;
  ocrPower: OcrPower;
  ocrMaxPixels: number;
  ocrThreads: number;
  ttsThreads: number;
  ttsBatchSize: number;
  ttsChunkChars: number;
  synthesisQuality: SynthQuality;
  cacheMB: number;
  ioBufferKB: number;
  queueConcurrency: number;
  videoExportPreset: 'fast' | 'balanced' | 'quality';
  gpuOffload: boolean;
  notes: string[];
}

// ---------- OCR ----------
export interface OcrOptions {
  power: OcrPower;
  language: string;
  preprocess: boolean;
  minConfidence: number;
  onProgress?: (p: number, msg?: string) => void;
}
export interface OcrLine {
  text: string;
  confidence: number; // 0..1
}
export interface OcrTimedLine extends OcrLine {
  startSec: number;
  endSec: number;
}
export interface OcrResult {
  text: string;
  lines: OcrLine[];
  durationMs: number;
  regions: number;
  avgConfidence: number;
}

// ---------- Audio formats ----------
export type AudioFormatId = string;
export interface FormatDescriptor {
  id: AudioFormatId;
  label: string;
  container: string;
  encoding: string;
  bitDepth: string;
  lossless: boolean;
  native: boolean; // true = encodable in-browser build
  mime: string;
  extension: string;
}
export interface EncodeOptions {
  sampleRate?: number;
  channels?: 1 | 2;
  dither?: boolean;
}

// ---------- Formant synth ----------
export interface VoiceProfileDef {
  id: string;
  name: string;
  gender: 'male' | 'female' | 'neutral';
  basePitchHz: number;
  timbre: number; // formant shaping 0..1
  breath: number; // 0..1
  lang: string;
  description: string;
}
export interface SynthOptions {
  profileId: string;
  rate: number; // words-per-minute multiplier 0.5..2
  pitch: number; // 0.5..2 multiplier
  volume: number; // 0..1
  quality: SynthQuality;
  gapMs?: number;
}

// ---------- System speech ----------
export interface SpeakerHandlers {
  onStart?: () => void;
  onBoundary?: (charIndex: number, word: string) => void;
  onEnd?: (error?: Error) => void;
}
/**
 * Which class of system voice to use when the selected engine is an OS-level
 * one. 'neural' prefers neural/natural voices, 'classic' prefers the classic
 * SAPI-style local voices — the selected model's engine decides, so choosing
 * “OS Classic Voices” actually yields classic voices instead of neural ones.
 */
export type SystemVoiceClass = 'neural' | 'classic' | 'any';
export interface SpeakOptions {
  voiceURI?: string;
  /** Voice class to honor when voiceURI is unset or unknown. Default 'any'. */
  voiceClass?: SystemVoiceClass;
  /** Preferred language tag ('en', 'de', …) used for auto voice picking. */
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

// ---------- OS speech bridge (established OS engines via local server) ----------
export type OsTtsEngineId = 'sapi' | 'say' | 'espeak-ng' | 'espeak' | 'piper';
export interface OsTtsVoiceDef {
  id: string;
  engine: OsTtsEngineId;
  name: string;
  lang: string;
  gender?: 'male' | 'female';
  neural?: boolean;
  quality?: number;
  description?: string;
}
export interface OsTtsBridgeStatus {
  url: string;
  ok: boolean;
  platform?: string;
  engines?: Partial<Record<OsTtsEngineId, boolean>>;
  voiceCount?: number;
  error?: string;
}

// ---------- File ingestion ----------
export type IngestCategory =
  | 'text'
  | 'code'
  | 'data'
  | 'document'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'binary'
  | 'unknown';
export type IngestTextKind =
  | 'plain'
  | 'converted'
  | 'ocr'
  | 'extracted'
  | 'strings'
  | 'binary-dump'
  | 'none';
export interface IngestResult {
  fileName: string;
  sizeBytes: number;
  ext: string;
  category: IngestCategory;
  text: string; // speakable text
  textKind: IngestTextKind;
  metadata: Record<string, string | number | boolean>;
  preview?: string;
  warnings: string[];
  durationMs: number;
  ocrSuggested?: boolean;
}

// ---------- Queue ----------
export type QueueJobType =
  | 'autobook'
  | 'tts-render'
  | 'file-convert'
  | 'ocr'
  | 'audiobook'
  | 'video-export'
  | 'encode';
export type QueueJobStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled';
export interface QueueJob {
  id: string;
  type: QueueJobType;
  label: string;
  status: QueueJobStatus;
  progress: number; // 0..1
  message?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: Record<string, unknown>;
  error?: string;
  /** Boosted by the user — runs before all non-priority queued jobs (oldest first). */
  priority?: boolean;
}

// ---------- Asset bin ----------
export type AssetKind = 'audio' | 'image' | 'text' | 'video' | 'data';
export interface AssetItem {
  id: string;
  name: string;
  kind: AssetKind;
  createdAt: number;
  mimeType: string;
  sizeBytes?: number;
  durationSec?: number;
  text?: string;
  blobUrl?: string;
  buffer?: AudioBuffer; // runtime only (not persisted)
  width?: number;
  height?: number;
  meta?: Record<string, unknown>;
}

// ---------- Video editor ----------
export interface ClipTextOverlay {
  text: string;
  size: number;
  color: string;
  position: 'top' | 'center' | 'bottom';
  shadow: boolean;
}
export interface VideoClip {
  id: string;
  type: 'image' | 'color' | 'gradient' | 'text';
  assetId?: string;
  color?: string;
  color2?: string;
  text?: string;
  durationSec: number;
  transition: 'none' | 'fade' | 'slide' | 'wipe';
  kenBurns: 'none' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right';
  overlay?: ClipTextOverlay;
  filter: 'none' | 'grayscale' | 'sepia' | 'vintage' | 'cool' | 'warm';
}
export interface VideoProject {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  clips: VideoClip[];
  soundtrackAssetId?: string;
  musicBedAssetId?: string;
  musicBed?: MusicBedSettings;
  subtitles?: SubtitleCue[];
  subtitleStyle?: SubtitleStyle;
}

// ---------- Subtitles ----------
export interface SubtitleCue { startSec: number; endSec: number; text: string; speaker?: string; }
export interface SubtitleStyle { fontSize: number; color: string; position: 'top' | 'center' | 'bottom'; background: boolean; outline: boolean; showSpeaker?: boolean; }

// ---------- Music bed (Video Editor second audio layer) ----------
/** Manual duck automation point: at `t` seconds into the timeline the bed depth equals `depth` (0..1). */
export interface DuckGainPoint { t: number; depth: number; }
export interface MusicBedSettings {
  volume: number; // 0..1 music level
  loop: boolean; // loop the bed to fill the timeline
  duck: boolean; // auto-duck under the narration soundtrack
  duckAmount: number; // 0..1 how much the bed dips when narration speaks (1 = silent)
  attackMs: number; // duck-in speed
  releaseMs: number; // duck-out recovery
  /** Optional manual automation (click-to-edit on the preview). When present with ≥1 point it overrides duckAmount; linear interpolation between points, clamped at both ends. */
  gainPoints?: DuckGainPoint[];
}

// ---------- Activity log (dashboard chart + queue history) ----------
export type ActivityKind =
  | 'job-done' | 'job-error' | 'job-cancelled' | 'job-queued'
  | 'asset-added' | 'asset-removed'
  | 'project-saved' | 'export'
  | 'transcript' | 'voice-profile';
export interface ActivityEvent {
  id: string;
  at: number; // epoch ms
  kind: ActivityKind;
  label: string; // short human-readable text
}
export interface VideoExportOptions {
  format: 'webm-vp9' | 'webm-vp8' | 'mp4-h264';
  quality: 'low' | 'medium' | 'high';
  onProgress?: (p: number) => void;
}

// ---------- Transcription → Audiobook chapters ----------
export interface TranscriptChapter { title: string; text: string; }

// ---------- AI assistance ----------
export type AiDepth = 'light' | 'standard' | 'deep';

export interface AiDocumentIntel {
  title: string;
  summary: string;
  keyPoints: string[];
  keywords: string[];
}

export interface AiAssetTags {
  tags: string[];
  description: string;
  kind: AssetKind;
}

export interface AiVideoPlan {
  title: string;
  clips: { text: string; durationSec: number; transition: string; kenBurns: string; filter: string }[];
  captions: string[];
}

export interface AiVoiceDesign {
  name: string;
  gender: 'male' | 'female' | 'neutral';
  basePitchHz: number;
  timbre: number;
  breath: number;
  description: string;
}

export interface AiDialogueDirection {
  id: string;
  emotion: 'whisper' | 'urgent' | 'curious' | 'soft';
  note?: string;
}

export interface AiOcrEnhancement {
  text: string;
  lines: { text: string; confidence: number }[];
  notes: string[];
}

export interface AiSpeechDirection {
  text: string;
  notes: string[];
}

export interface AiTranscriptCleanup {
  text: string;
  notes: string[];
}

// ---------- Feature registry ----------
export interface FeatureEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  status: 'active' | 'config' | 'engine';
  keywords?: string[];
}

// ---------- TTS model registry ----------
export type TtsEngineKind = 'system-neural' | 'system-classic' | 'os-bridge' | 'formant';
export interface TTSModelDef {
  id: string;
  name: string;
  family: string;
  lang: string;
  sizeMB: number;
  quality: 1 | 2 | 3 | 4 | 5;
  engine: TtsEngineKind;
  bundled: boolean;
  description: string;
  tags: string[];
  gpuRecommended: boolean;
}

// ---------- TTS render result ----------
export interface TtsRenderResult {
  buffer: AudioBuffer;
  /** Which engine actually rendered this audio. */
  engineUsed: 'os-bridge' | 'ai' | 'fallback';
  /** Human-readable label of the engine/voice that rendered the audio. */
  engineLabel: string;
  chars: number;
  durationSec: number;
  fallbackReason?: string;
}
