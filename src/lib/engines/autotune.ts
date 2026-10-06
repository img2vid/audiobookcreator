// ============================================================
// Openmukti Audiobook Creator — hardware scoring + engine auto-tune
// Owned by Task 1-d.
//
// Scoring model (0..100 composite, clamped 1..100):
//   GPU enabled : 45% cpuScore + 25% gpuScore + ramScore(≤26) + storageScore(≤8)
//   GPU disabled: 60% cpuScore + ramScore(≤26) + storageScore(≤8)  (renormalized)
// cpuScore    = thread curve (log2) + SMT bonus (≤10) + boost bonus (≤14)
//               + generation-year recency (≤12)
// gpuScore    = FP32 teraflops curve (≤92) + VRAM bonus (≤30)
// Everything interpolates smoothly — tier boundaries only gate the
// human-facing `tier` label, not the individual tuned values.
// ============================================================

import type {
  CpuModel,
  GpuModel,
  OcrPower,
  PCProfile,
  SynthQuality,
  Tier,
  TunedSettings,
} from '@/lib/types';
import { CPU_BRANDS, GPU_BRANDS } from './specs-db';

// ---------- small helpers ----------
const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));
const log2 = (v: number): number => Math.log2(Math.max(v, Number.EPSILON));
const round1 = (v: number): number => Math.round(v * 10) / 10;

// ---------- DB lookup helpers (shared with the UI cascades) ----------

/** Resolve the exact selected CPU from the specs DB. Null for custom / unknown / partial selections. */
export function getSelectedCpu(profile: PCProfile): CpuModel | null {
  if (!profile.cpuBrand || profile.cpuBrand === 'custom') return null;
  const brand = CPU_BRANDS.find((b) => b.id === profile.cpuBrand);
  if (!brand) return null;
  const gen = brand.generations.find((g) => g.id === profile.cpuGeneration);
  if (!gen) return null;
  return gen.models.find((m) => m.id === profile.cpuModel) ?? null;
}

/** Resolve the exact selected GPU from the specs DB. Null for custom / unknown / partial selections. */
export function getSelectedGpu(profile: PCProfile): GpuModel | null {
  if (!profile.gpuBrand || profile.gpuBrand === 'custom') return null;
  const brand = GPU_BRANDS.find((b) => b.id === profile.gpuBrand);
  if (!brand) return null;
  const gen = brand.generations.find((g) => g.id === profile.gpuGeneration);
  if (!gen) return null;
  return gen.models.find((m) => m.id === profile.gpuModel) ?? null;
}

// ---------- normalized hardware facts (graceful degradation) ----------

interface CpuFacts {
  name: string;
  cores: number;
  threads: number;
  baseGhz: number;
  boostGhz: number;
  year: number; // 0 = unknown → mid recency assumption
  specified: boolean; // exact DB model matched
}

interface GpuFacts {
  name: string;
  vramGB: number;
  teraflops: number;
  specified: boolean;
}

/** Mid-range assumptions for unspecified hardware. */
const MID_CPU: Omit<CpuFacts, 'name'> = {
  cores: 4,
  threads: 8,
  baseGhz: 3.0,
  boostGhz: 3.6,
  year: 0,
  specified: false,
};

function resolveCpuFacts(profile: PCProfile): CpuFacts {
  const model = getSelectedCpu(profile);
  if (model) {
    return {
      name: model.name,
      cores: Math.max(1, model.cores),
      threads: Math.max(model.threads, model.cores),
      baseGhz: model.baseGhz,
      boostGhz: model.boostGhz ?? model.baseGhz,
      year: model.year ?? 0,
      specified: true,
    };
  }

  if (profile.cpuBrand === 'custom') {
    const c = profile.customCpu;
    const cores = clamp(Math.round(c?.cores ?? 4), 1, 512);
    const threads = clamp(Math.round(c?.threads ?? 8), 1, 512);
    const clock = clamp(c?.clockGhz ?? 3.4, 0.2, 8);
    return {
      name: `Custom CPU (${cores}C/${threads}T @ ${round1(clock)} GHz)`,
      cores,
      threads: Math.max(threads, cores),
      baseGhz: clock,
      boostGhz: clock, // boost unknown → assume clock
      year: 0,
      specified: false,
    };
  }

  const brand = CPU_BRANDS.find((b) => b.id === profile.cpuBrand);
  return {
    ...MID_CPU,
    name: brand ? `${brand.name} CPU (model not set)` : 'Unknown CPU',
  };
}

function resolveGpuFacts(profile: PCProfile): GpuFacts | null {
  if (!profile.gpuEnabled) return null;

  const model = getSelectedGpu(profile);
  if (model) {
    return {
      name: model.name,
      vramGB: Math.max(0, model.vramGB),
      teraflops: Math.max(0, model.teraflops),
      specified: true,
    };
  }

  if (profile.gpuBrand === 'custom') {
    const g = profile.customGpu;
    return {
      name: `Custom GPU (${round1(g?.teraflops ?? 8)} TF / ${Math.round(g?.vramGB ?? 6)} GB)`,
      vramGB: clamp(g?.vramGB ?? 6, 0, 512),
      teraflops: clamp(g?.teraflops ?? 8, 0, 500),
      specified: false,
    };
  }

  const brand = GPU_BRANDS.find((b) => b.id === profile.gpuBrand);
  return {
    name: brand ? `${brand.name} GPU (model not set)` : 'Unknown GPU',
    vramGB: 6, // mid assumptions
    teraflops: 8,
    specified: false,
  };
}

// ---------- component scores ----------

/** CPU score 1..100: threads (log2 curve) + SMT + boost + generation recency. */
function cpuScoreOf(c: CpuFacts): number {
  const threadScore = (60 * log2(clamp(c.threads, 1, 4096) + 1)) / log2(65); // 1T→0 … 64T→60
  const smtBonus =
    c.threads > c.cores
      ? clamp(10 * (c.threads / Math.max(c.cores, 1) - 1), 0, 10)
      : 0;
  const boostBonus = clamp((c.boostGhz - 2.0) * 5, 0, 14);
  const recencyBonus = c.year
    ? clamp(((c.year - 2011) / 14) * 12, 0, 12) // 2011→0 … 2025→12
    : 6; // unknown generation → mid assumption
  return clamp(threadScore + smtBonus + boostBonus + recencyBonus, 1, 100);
}

/** GPU score 0..100: FP32 teraflops (log2 curve, capped) + VRAM bonus. */
function gpuScoreOf(g: GpuFacts): number {
  const tfPart = clamp(15 * log2(g.teraflops + 1), 0, 92); // ~1 TF→15 … 80+ TF→92
  const vramPart = clamp(g.vramGB * 1.1, 0, 30); // 1 GB→1.1 … 27+ GB→30
  return clamp(tfPart + vramPart, 0, 100);
}

/** RAM score 0..26: piecewise linear (8→8, 16→14, 32→20, 64→24, ≥128→26). */
const RAM_STEPS: ReadonlyArray<readonly [number, number]> = [
  [2, 2], [4, 4], [8, 8], [12, 11], [16, 14], [24, 17],
  [32, 20], [48, 22], [64, 24], [96, 25], [128, 26],
];
function ramScoreOf(ramGB: number): number {
  const ram = clamp(ramGB, 0, 512);
  if (ram <= RAM_STEPS[0][0]) return RAM_STEPS[0][1];
  const last = RAM_STEPS[RAM_STEPS.length - 1];
  if (ram >= last[0]) return last[1];
  for (let i = 1; i < RAM_STEPS.length; i++) {
    const [x1, y1] = RAM_STEPS[i - 1];
    const [x2, y2] = RAM_STEPS[i];
    if (ram <= x2) return y1 + ((ram - x1) / (x2 - x1)) * (y2 - y1);
  }
  return last[1];
}

/** Storage score: HDD 2 → NVMe Gen5 8. */
function storageScoreOf(storage: PCProfile['storage']): number {
  switch (storage) {
    case 'hdd':
      return 2;
    case 'sata-ssd':
      return 3.5;
    case 'nvme':
      return 5;
    case 'nvme-gen4':
      return 6.5;
    case 'nvme-gen5':
      return 8;
    default:
      return 4;
  }
}

export function tierOf(score: number): Tier {
  return score >= 80 ? 'ultra' : score >= 60 ? 'high' : score >= 35 ? 'mid' : 'low';
}

interface ScoreBreakdown {
  score: number;
  cpuScore: number;
  gpuScore: number; // 0 when GPU disabled
  ramScore: number;
  storageScore: number;
}

function computeScore(
  profile: PCProfile,
  cpu: CpuFacts,
  gpu: GpuFacts | null,
): ScoreBreakdown {
  const cpuScore = cpuScoreOf(cpu);
  const gpuScore = gpu ? gpuScoreOf(gpu) : 0;
  const ramScore = ramScoreOf(profile.ramGB);
  const storageScore = storageScoreOf(profile.storage);

  const raw = gpu
    ? cpuScore * 0.45 + gpuScore * 0.25 + ramScore + storageScore
    : cpuScore * 0.6 + ramScore + storageScore;

  return {
    score: Math.round(clamp(raw, 1, 100)),
    cpuScore,
    gpuScore,
    ramScore,
    storageScore,
  };
}

// ---------- public scoring API ----------

/** 0..100 composite hardware score for the given PC profile. */
export function hardwareScore(profile: PCProfile): number {
  return computeScore(profile, resolveCpuFacts(profile), resolveGpuFacts(profile)).score;
}

// ---------- tuned-settings mapping ----------

const OCR_POWER_ORDER: OcrPower[] = ['lite', 'standard', 'heavy', 'ultra'];
const OCR_POWER_PIXEL_CAP: Record<OcrPower, number> = {
  lite: 1_200_000,
  standard: 3_000_000,
  heavy: 6_000_000,
  ultra: 12_000_000,
};
const IO_BUFFER_KB: Record<PCProfile['storage'], number> = {
  hdd: 256,
  'sata-ssd': 512,
  nvme: 1024,
  'nvme-gen4': 1536,
  'nvme-gen5': 2048,
};

/** RAM-based OCR pixel ceiling (big pages need headroom). */
function ramPixelCap(ramGB: number): number {
  if (ramGB <= 2) return 800_000;
  if (ramGB <= 4) return 1_500_000;
  if (ramGB <= 8) return 3_000_000;
  if (ramGB <= 16) return 6_000_000;
  if (ramGB <= 32) return 12_000_000;
  return 24_000_000;
}

function ocrPowerOf(score: number, gpuEnabled: boolean): OcrPower {
  let power: OcrPower =
    score >= 78 ? 'ultra' : score >= 60 ? 'heavy' : score >= 40 ? 'standard' : 'lite';
  // Software-only OCR stack → cap at Standard regardless of raw score.
  if (!gpuEnabled && OCR_POWER_ORDER.indexOf(power) > OCR_POWER_ORDER.indexOf('standard')) {
    power = 'standard';
  }
  return power;
}

function cpuThreadNote(cpu: CpuFacts): string {
  const threads = cpu.threads;
  const verdict =
    threads >= 24
      ? 'excellent multi-thread budget'
      : threads >= 12
        ? 'strong multi-thread budget'
        : threads >= 6
          ? 'adequate multi-thread budget'
          : 'light multi-thread budget — conservative thread allocation';
  return `${cpu.name} (${cpu.cores}C/${cpu.threads}T) → ${verdict}`;
}

function storageNoteOf(storage: PCProfile['storage']): string {
  switch (storage) {
    case 'hdd':
      return 'HDD storage → conservative I/O buffering (256 KB)';
    case 'sata-ssd':
      return 'SATA SSD → moderate I/O buffering (512 KB)';
    case 'nvme':
      return 'NVMe Gen3 storage → 1024 KB I/O buffering';
    case 'nvme-gen4':
      return 'NVMe Gen4 storage → high-throughput I/O buffering (1536 KB)';
    case 'nvme-gen5':
      return 'NVMe Gen5 storage → high-throughput I/O buffering (2048 KB)';
    default:
      return 'Unknown storage → moderate I/O buffering (512 KB)';
  }
}

/**
 * Derive tuned engine settings from the PC profile.
 * `opts.ocrPowerOverride` ('auto' | OcrPower) wins over the score-derived
 * OCR power when it is not 'auto'.
 */
export function autoTune(
  profile: PCProfile,
  opts?: { ocrPowerOverride?: 'auto' | OcrPower },
): TunedSettings {
  const cpu = resolveCpuFacts(profile);
  const gpu = resolveGpuFacts(profile);
  const { score } = computeScore(profile, cpu, gpu);
  const tier = tierOf(score);
  const threads = cpu.threads;

  // ----- OCR -----
  const override = opts?.ocrPowerOverride ?? 'auto';
  const scoreOcrPower = ocrPowerOf(score, Boolean(gpu));
  const ocrPower: OcrPower =
    override !== 'auto' ? override : scoreOcrPower;
  const ramCap = ramPixelCap(profile.ramGB);
  const ocrMaxPixels = Math.round(Math.min(OCR_POWER_PIXEL_CAP[ocrPower], ramCap));
  const ocrThreads = clamp(Math.round(cpu.cores / 2), 2, 8);

  // ----- TTS -----
  const ttsThreads = clamp(Math.round(cpu.cores / 4) + 1, 1, 8);
  const ttsBatchSize = clamp(Math.round(2 + score / 10), 2, 12);
  const chunkFactor = clamp(
    (score / 100) * 0.6 + (Math.min(profile.ramGB, 64) / 64) * 0.4,
    0,
    1,
  );
  const ttsChunkChars = Math.round(800 + 3200 * chunkFactor); // 800 (low) → 4000 (ultra)
  const synthesisQuality: SynthQuality =
    score >= 85 && (Boolean(gpu) || threads >= 16)
      ? 'max'
      : score >= 65
        ? 'high'
        : score >= 35
          ? 'balanced'
          : 'fast';

  // ----- memory / I/O / queue -----
  const cacheMB = clamp(Math.round(profile.ramGB * 16), 64, 2048);
  const ioBufferKB = IO_BUFFER_KB[profile.storage] ?? 512;
  const queueConcurrency = clamp(Math.round(cpu.cores / 6 + 1), 1, 4);
  const videoExportPreset: TunedSettings['videoExportPreset'] =
    score >= 80 ? 'quality' : score >= 55 ? 'balanced' : 'fast';
  const gpuOffload = gpu !== null && (gpu.teraflops >= 8 || gpu.vramGB >= 6);

  // ----- human-readable notes (4-7) -----
  const notes: string[] = [cpuThreadNote(cpu)];
  if (!cpu.specified) {
    notes.push('No exact CPU model selected → mid-range assumptions applied');
  }
  notes.push(
    gpu
      ? `${gpu.name} (${round1(gpu.teraflops)} TF / ${Math.round(gpu.vramGB)} GB) → ${
          gpuOffload
            ? 'GPU offload enabled'
            : 'modest GPU — CPU remains the primary engine'
        }`
      : 'GPU acceleration off → OCR capped at Standard',
  );
  notes.push(`${Math.round(profile.ramGB)} GB RAM → ${cacheMB} MB synthesis cache`);
  notes.push(storageNoteOf(profile.storage));
  notes.push(
    override !== 'auto'
      ? `OCR power override active → ${ocrPower}`
      : `Hardware score ${score} → OCR power ${ocrPower}${
          ramCap < OCR_POWER_PIXEL_CAP[ocrPower]
            ? ` (pixel budget RAM-limited to ${round1(ramCap / 1_000_000)} MP)`
            : ''
        }`,
  );
  notes.push(
    `Synthesis quality ${synthesisQuality} (tier ${tier}) — batch ${ttsBatchSize}, ${ttsChunkChars} chars/chunk`,
  );

  return {
    score,
    tier,
    ocrPower,
    ocrMaxPixels,
    ocrThreads,
    ttsThreads,
    ttsBatchSize,
    ttsChunkChars,
    synthesisQuality,
    cacheMB,
    ioBufferKB,
    queueConcurrency,
    videoExportPreset,
    gpuOffload,
    notes: notes.slice(0, 7),
  };
}
