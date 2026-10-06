// Local AI model registry for AutoBook. Models are loaded only from the app's
// own /models tree; there is deliberately no runtime Hugging Face fallback.
//
// Tiers:
//   fast     — tiny models for low-memory machines and quick drafts
//   balanced — good reasoning at moderate cost (default)
//   advanced — largest models that still fit a browser tab; best cast/dialogue
//              reasoning, slowest on CPU. Use with AI depth "deep".
//
// `weights` is the filename probed by getLocalAIStatus(); `dtypes` lists the
// precision variants the build pipeline may have produced — the loader picks
// the first one present on disk.

export type LocalAiTier = 'fast' | 'balanced' | 'advanced';
export type LocalAiDtype = 'q4f16' | 'q4' | 'q8' | 'fp16' | 'fp32';

export interface LocalAiModelDef {
  id: string;
  label: string;
  folder: string;
  source: string;
  sizeMB: number;
  /** Primary dtype requested from the pipeline. */
  dtype: LocalAiDtype;
  /** All dtypes accepted, in preference order. */
  dtypes: LocalAiDtype[];
  /** Weight file name inside onnx/ that getLocalAIStatus() probes. */
  weights: string;
  tier: LocalAiTier;
  description: string;
  recommended?: boolean;
  /** Suggested max new tokens per call on CPU. */
  cpuMaxNewTokens: number;
}

export const LOCAL_AI_MODELS: LocalAiModelDef[] = [
  {
    id: 'smollm2-360m-instruct',
    label: 'SmolLM2 360M Instruct',
    folder: 'smollm2-360m-instruct',
    source: 'onnx-community/SmolLM2-360M-Instruct-ONNX',
    sizeMB: 272,
    dtype: 'q4f16',
    dtypes: ['q4f16'],
    weights: 'model_q4f16.onnx',
    tier: 'balanced',
    description: 'Recommended local director: small enough for GitHub-hosted apps while still useful for genre, dialogue and casting decisions.',
    recommended: true,
    cpuMaxNewTokens: 512,
  },
  {
    id: 'smollm2-135m-instruct',
    label: 'SmolLM2 135M Instruct',
    folder: 'smollm2-135m-instruct',
    source: 'onnx-community/SmolLM2-135M-Instruct-ONNX',
    sizeMB: 117,
    dtype: 'q4f16',
    dtypes: ['q4f16'],
    weights: 'model_q4f16.onnx',
    tier: 'fast',
    description: 'Ultra-light fallback for lower-memory machines. Expect weaker dialogue adjudication than the 360M model.',
    cpuMaxNewTokens: 384,
  },
  {
    id: 'smollm2-1p7b-instruct',
    label: 'SmolLM2 1.7B Instruct',
    folder: 'smollm2-1p7b-instruct',
    source: 'onnx-community/SmolLM2-1.7B-Instruct-ONNX',
    sizeMB: 1100,
    dtype: 'q4',
    dtypes: ['q4', 'q4f16', 'fp16'],
    weights: 'model_q4.onnx',
    tier: 'advanced',
    description: 'Advanced reasoning tier — noticeably better dialogue attribution, character profiling and narration rewriting. Needs ~2 GB free RAM; slow but thorough on CPU.',
    cpuMaxNewTokens: 640,
  },
  {
    id: 'qwen25-1p5b-instruct',
    label: 'Qwen2.5 1.5B Instruct',
    folder: 'qwen25-1p5b-instruct',
    source: 'onnx-community/Qwen2.5-1.5B-Instruct-ONNX',
    sizeMB: 980,
    dtype: 'q4',
    dtypes: ['q4', 'q4f16', 'fp16'],
    weights: 'model_q4.onnx',
    tier: 'advanced',
    description: 'Advanced multilingual tier — strong instruction following and long-context consistency for whole-book casting. Needs ~2 GB free RAM.',
    cpuMaxNewTokens: 640,
  },
  {
    id: 'llama32-1b-instruct',
    label: 'Llama 3.2 1B Instruct',
    folder: 'llama32-1b-instruct',
    source: 'onnx-community/Llama-3.2-1B-Instruct-ONNX',
    sizeMB: 800,
    dtype: 'q4',
    dtypes: ['q4', 'q4f16', 'fp16'],
    weights: 'model_q4.onnx',
    tier: 'advanced',
    description: 'Advanced tier — sharp character/persona inference from sparse evidence. Needs ~1.5 GB free RAM.',
    cpuMaxNewTokens: 640,
  },
  {
    id: 'phi35-mini-instruct',
    label: 'Phi-3.5 Mini Instruct',
    folder: 'phi35-mini-instruct',
    source: 'onnx-community/Phi-3.5-mini-instruct-ONNX',
    sizeMB: 2400,
    dtype: 'q4',
    dtypes: ['q4', 'q4f16'],
    weights: 'model_q4.onnx',
    tier: 'advanced',
    description: 'Largest supported model — best quality across every AI feature. WebGPU strongly recommended; CPU runs but expect long waits. Needs ~4 GB free RAM.',
    cpuMaxNewTokens: 768,
  },
];

export const DEFAULT_LOCAL_AI_MODEL_ID = LOCAL_AI_MODELS.find((m) => m.recommended)?.id ?? LOCAL_AI_MODELS[0].id;

export function getLocalAiModel(id?: string): LocalAiModelDef {
  return LOCAL_AI_MODELS.find((m) => m.id === id) ?? LOCAL_AI_MODELS[0];
}

/** All models in a tier — used to route heavy tasks to the best available model. */
export function getLocalAiModelsByTier(tier: LocalAiTier): LocalAiModelDef[] {
  return LOCAL_AI_MODELS.filter((m) => m.tier === tier);
}

/**
 * Pick the best model for a task. `preferred` wins if given; otherwise the
 * heaviest tier the caller allows, falling back to the default.
 */
export function pickLocalAiModel(preferredId?: string, maxTier: LocalAiTier = 'advanced'): LocalAiModelDef {
  if (preferredId) return getLocalAiModel(preferredId);
  const order: LocalAiTier[] = ['advanced', 'balanced', 'fast'];
  const cap = order.indexOf(maxTier);
  for (let i = cap; i < order.length; i++) {
    const found = LOCAL_AI_MODELS.find((m) => m.tier === order[i] && m.recommended) ?? LOCAL_AI_MODELS.find((m) => m.tier === order[i]);
    if (found) return found;
  }
  return getLocalAiModel(DEFAULT_LOCAL_AI_MODEL_ID);
}
