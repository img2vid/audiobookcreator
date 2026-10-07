use client';

// ============================================================
// Openmukti Audiobook Creator — real local language-model director
//
// Uses Transformers.js + ONNX quantized instruction models. Locally hosted
// weights under /models/autobook-ai are preferred. If the selected model is not
// available locally, it is downloaded once from the model's own Hugging Face
// repository and cached by the browser. This applies to every entry in
// LOCAL_AI_MODELS — the runtime reads `model.source`, so selecting any listed
// model downloads that model; it is not limited to the default SmolLM2 model.
// This module is intentionally browser-only.
//
// v2: general-purpose AI runtime. Every module in the studio calls
// aiPromptText/aiPromptJson; AutoBook additionally gets deep
// multi-pass direction (chapters, narration emotion, pacing, lexicon,
// complex dialogue attribution, character relationship mapping).
// ============================================================

import { getLocalAiModel, DEFAULT_LOCAL_AI_MODEL_ID, LOCAL_AI_MODELS, type LocalAiModelDef } from '@/lib/data/local-ai-models';
import type { AutobookOptions, AutobookResult, ScriptUnit } from '@/lib/engines/autobook';

type AutobookOptionsContext = NonNullable<AutobookOptions['fileContext']>;

export interface LocalAiStatus {
  checked: boolean;
  ready: boolean;
  modelId: string;
  modelName: string;
  sizeMB: number;
  message: string;
}

export interface AiCharacterInsight {
  name: string;
  gender?: 'male' | 'female' | 'neutral';
  ageBand?: 'child' | 'young' | 'adult' | 'middle' | 'elder' | 'unknown';
  role?: 'major' | 'minor';
  delivery?: 'calm' | 'warm' | 'urgent' | 'curious' | 'sad' | 'angry' | 'solemn' | 'soft';
  evidence?: string[];
  /** Physical description inferred from text */
  physicalDescription?: string;
  /** Personality traits inferred from text */
  personalityTraits?: string[];
  /** Relationship to other characters */
  relationships?: { character: string; relation: string }[];
}

export interface AiDialogueDecision {
  id: string;
  speaker: string;
  confidence?: number;
  emotion?: 'calm' | 'warm' | 'urgent' | 'curious' | 'sad' | 'angry' | 'solemn' | 'soft';
  /** Reasoning for this attribution */
  reasoning?: string;
}

export interface AiChapterPlan {
  index: number;
  title: string;
  summary: string;
  paceWpm: number;
}

export interface AiNarrationEmotion {
  id: string;
  emotion: ScriptUnit['emotionHint'];
}

export interface AiLexiconEntry {
  word: string;
  sayAs: string;
}

export interface LocalAiEnhancement {
  modelId: string;
  modelName: string;
  genre?: 'fiction' | 'non-fiction';
  genreConfidence?: number;
  titleGuess?: string;
  authorGuess?: string;
  narratorStyle?: string;
  characters: AiCharacterInsight[];
  dialogue: AiDialogueDecision[];
  reviewedDialogue: number;
  notes: string[];
  // Deep-pass additions (present when options.deep is set)
  chapterPlan?: AiChapterPlan[];
  narrationEmotion?: AiNarrationEmotion[];
  lexicon?: AiLexiconEntry[];
  sceneBreaks?: number;
  /** Complex dialogue structures resolved (thoughts, mutterings, interruptions) */
  complexDialogueResolved?: number;
  /** Character relationship map */
  relationshipMap?: { from: string; to: string; relation: string }[];
}

type Progress = (p: number, message?: string) => void;

export interface AiRunOptions {
  modelId?: string;
  maxNewTokens?: number;
  temperature?: number;
  onProgress?: Progress;
  taskLabel?: string;
}

export interface AiTaskOutcome<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

const cache = new Map<string, Promise<unknown>>();

function modelBasePath(model: LocalAiModelDef): string {
  if (typeof document === 'undefined') return `/models/autobook-ai/${model.folder}/`;
  return new URL(`./models/autobook-ai/${model.folder}/`, document.baseURI).pathname;
}

export function getLocalAiModelOptions(): LocalAiModelDef[] {
  return LOCAL_AI_MODELS;
}

export async function getLocalAIStatus(modelId = DEFAULT_LOCAL_AI_MODEL_ID): Promise<LocalAiStatus> {
  const model = getLocalAiModel(modelId);
  if (typeof window === 'undefined') {
    return {
      checked: true,
      ready: false,
      modelId: model.id,
      modelName: model.label,
      sizeMB: model.sizeMB,
      message: 'Browser-only local AI.',
    };
  }

  const base = modelBasePath(model);
  try {
    // Probe the model's primary config and weight files. If they are absent the
    // generator will use the registry `source` for a one-time remote download.
    const config = await fetch(`${base}config.json`, { cache: 'no-store' });
    if (!config.ok) {
      return {
        checked: true,
        ready: false,
        modelId: model.id,
        modelName: model.label,
        sizeMB: model.sizeMB,
        message: `Model files are missing from ${base}. First use will download ~${model.sizeMB} MB from ${model.source}; after that it runs locally.`,
      };
    }

    let weightsOk = false;
    for (const dt of model.dtypes ?? [model.dtype]) {
      const file = `model_${dt}.onnx`;
      const res = await fetch(`${base}onnx/${file}`, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
      if (res?.ok) { weightsOk = true; break; }
    }
    if (!weightsOk && model.weights) {
      const res = await fetch(`${base}onnx/${model.weights}`, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
      weightsOk = Boolean(res?.ok);
    }

    const ready = weightsOk;
    return {
      checked: true,
      ready,
      modelId: model.id,
      modelName: model.label,
      sizeMB: model.sizeMB,
      message: ready
        ? 'Local model files detected. AI runs entirely in this browser.'
        : `Model weights are missing from ${base}. First use will download ~${model.sizeMB} MB from ${model.source}; after that it runs locally.`,
    };
  } catch {
    return {
      checked: true,
      ready: false,
      modelId: model.id,
      modelName: model.label,
      sizeMB: model.sizeMB,
      message: 'Local model could not be checked. The rule-based fallback is still available.',
    };
  }
}

/** True when the local model files are present and loadable. */
export async function aiIsReady(modelId?: string): Promise<boolean> {
  const status = await getLocalAIStatus(modelId ?? DEFAULT_LOCAL_AI_MODEL_ID);
  return status.ready;
}

type LocalAiDevice = 'webgpu' | 'wasm';

async function loadModelConfigForDevice(
  model: LocalAiModelDef,
  useRemote: boolean,
  device: LocalAiDevice,
  dtypes: LocalAiModelDef['dtypes'],
): Promise<any> {
  const url = useRemote
    ? `https://huggingface.co/${model.source}/resolve/main/config.json`
    : `${modelBasePath(model)}config.json`;

  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Could not load model config from ${url}: HTTP ${response.status}`);
  }

  const config = await response.json();

  // Some q4f16/fp16 ONNX exports advertise a float16 KV cache in config.json
  // even though their WASM graphs expect float32. Patch the in-memory config
  // only; keep the declared dtype so Transformers.js still selects the
  // intended model_q4f16.onnx / model_q4.onnx file.
  if (device === 'wasm') {
    const transformersJsConfig = config['transformers.js_config'] ?? {};
    const kvCacheDtype = transformersJsConfig.kv_cache_dtype ?? {};
    for (const dtype of dtypes) {
      kvCacheDtype[dtype] = 'float32';
    }
    transformersJsConfig.kv_cache_dtype = kvCacheDtype;
    config['transformers.js_config'] = transformersJsConfig;
  }

  return config;
}

export async function createGenerator(
  model: LocalAiModelDef,
  opts?: { onProgress?: Progress },
): Promise<any> {
  const hit = cache.get(model.id);
  if (hit) return hit;

  const promise = (async () => {
    const transformers = await import('@huggingface/transformers');
    const { env, pipeline } = transformers as any;

    // Local-first, remote fallback for any registered model. `model.source` is
    // the model-specific Hugging Face repository, so every LOCAL_AI_MODELS
    // entry can download independently when selected.
    const status = await getLocalAIStatus(model.id).catch(() => null);
    const useRemote = !status?.ready;
    const modelRef = useRemote ? model.source : model.folder;

    env.allowRemoteModels = useRemote;
    env.allowLocalModels = !useRemote;
    env.localModelPath = new URL(`./models/autobook-ai/`, document.baseURI).pathname;
    env.useBrowserCache = true;

    // Serve ONNX Runtime's WebAssembly from this site (public/ort/, copied by
    // `npm run prepare:local-assets`) instead of Transformers.js's default CDN.
    // GitHub Pages cannot send the COOP/COEP headers multi-threaded WASM needs,
    // so we force single-threaded WASM for maximum compatibility.
    const wasmBase = new URL('./ort/', document.baseURI).href;
    // Try multiple env paths for different Transformers.js versions
    const wasmTargets = [
      env.backends?.onnx?.wasm,
      env.onnx?.wasm,
      env.ort?.wasm,
    ];
    for (const wasmEnv of wasmTargets) {
      if (wasmEnv) {
        wasmEnv.wasmPaths = wasmBase;
        wasmEnv.numThreads = 1;
        if (wasmEnv.simd === undefined) wasmEnv.simd = true;
      }
    }

    // Try WebGPU only if the browser advertises it AND can actually get an adapter.
    // Chrome has navigator.gpu even on systems with no compatible GPU; only
    // requestAdapter() tells the truth.
    const gpu = (navigator as any).gpu;
    let webgpuOk = false;
    if (gpu) {
      try {
        const adapter = await gpu.requestAdapter();
        webgpuOk = Boolean(adapter);
      } catch {
        webgpuOk = false;
      }
    }

    // dtype fallback chain — try the declared dtype first, then any other
    // variant the build pipeline may have produced, on the best device.
    const device = webgpuOk ? 'webgpu' : 'wasm';
    const dtypesToTry = [model.dtype, ...(model.dtypes ?? []).filter((d) => d !== model.dtype)];
    const configByDevice = new Map<LocalAiDevice, Promise<any>>();
    const configFor = (deviceName: LocalAiDevice) => {
      let pending = configByDevice.get(deviceName);
      if (!pending) {
        pending = loadModelConfigForDevice(model, useRemote, deviceName, dtypesToTry);
        configByDevice.set(deviceName, pending);
      }
      return pending;
    };

    const progressCallback = opts?.onProgress
      ? (event: any) => {
          const rawProgress = typeof event?.progress === 'number' ? event.progress : 0;
          // Transformers.js may report either 0..1 or 0..100 depending on version.
          const progress = rawProgress > 1 ? rawProgress / 100 : rawProgress;
          opts.onProgress?.(
            Math.max(0, Math.min(1, progress)),
            useRemote ? `Downloading ${model.label}…` : `Loading ${model.label}…`,
          );
        }
      : undefined;

    const loadOptions = async (dtype: string, deviceName: LocalAiDevice) => ({
      dtype,
      device: deviceName,
      config: await configFor(deviceName),
      ...(progressCallback ? { progress_callback: progressCallback } : {}),
    });

    let lastErr: unknown;
    for (const dtype of dtypesToTry) {
      try {
        return await pipeline('text-generation', modelRef, await loadOptions(dtype, device));
      } catch (e) {
        lastErr = e;
      }
    }

    // If the chosen device failed for every dtype and we were on WebGPU, retry all on CPU/WASM.
    if (webgpuOk) {
      for (const dtype of dtypesToTry) {
        try {
          return await pipeline('text-generation', modelRef, await loadOptions(dtype, 'wasm'));
        } catch (e) {
          lastErr = e;
        }
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr ?? `Could not load ${model.label} from ${modelRef}`));
  })();

  cache.set(model.id, promise);
  // Don't cache a failed load — let the next attempt retry from scratch.
  promise.catch(() => cache.delete(model.id));
  return promise;
}

function generatedText(raw: unknown): string {
  if (!Array.isArray(raw) || !raw.length) return '';
  const first = raw[0] as any;
  const value = first?.generated_text;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    if (typeof last === 'string') return last;
    if (last && typeof last.content === 'string') return last.content;
  }
  return '';
}

function extractJson(raw: string): unknown {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  const starts = [cleaned.indexOf('{'), cleaned.indexOf('[')].filter((n) => n >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    for (let end = cleaned.length; end > start + 1; end--) {
      const candidate = cleaned.slice(start, end).trim();
      try { return JSON.parse(candidate); } catch { /* keep shrinking */ }
    }
  }
  return null;
}

async function askJson(generator: any, prompt: string, maxNewTokens: number): Promise<any> {
  const output = await generator(prompt, {
    max_new_tokens: maxNewTokens,
    do_sample: false,
    return_full_text: false,
  });
  return extractJson(generatedText(output));
}

// ---------- General-purpose runtime used by every module ----------

/** Run any AI call and convert failures into a structured outcome (never throws). */
export async function runAiTask<T>(label: string, fn: () => Promise<T>): Promise<AiTaskOutcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: `${label}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** General prompt → raw text from the local model. Throws when unavailable. */
export async function aiPromptText(prompt: string, options?: AiRunOptions): Promise<string> {
  const model = getLocalAiModel(options?.modelId ?? DEFAULT_LOCAL_AI_MODEL_ID);
  options?.onProgress?.(0, `Loading ${model.label}…`);
  const generator = await createGenerator(model, { onProgress: options?.onProgress });
  const output = await generator(prompt, {
    max_new_tokens: options?.maxNewTokens ?? 512,
    do_sample: (options?.temperature ?? 0) > 0,
    temperature: Math.max(0, Math.min(1, options?.temperature ?? 0)),
    return_full_text: false,
  });
  return generatedText(output).trim();
}

/** General prompt → parsed JSON (null when the model is unavailable or output is invalid). */
export async function aiPromptJson<T = any>(prompt: string, maxNewTokens = 700, modelId?: string): Promise<T | null> {
  const model = getLocalAiModel(modelId ?? DEFAULT_LOCAL_AI_MODEL_ID);
  const generator = await createGenerator(model);
  return (await askJson(generator, prompt, maxNewTokens)) as T | null;
}

function excerpt(text: string, start: number, length: number): string {
  const slice = text.slice(Math.max(0, start), Math.min(text.length, start + length));
  return slice.replace(/\s+/g, ' ').trim();
}

function bookSamples(text: string): string[] {
  if (text.length <= 14000) return [text.slice(0, 14000)];
  const third = Math.max(1, Math.floor(text.length / 3));
  return [excerpt(text, 0, 5200), excerpt(text, third, 5200), excerpt(text, text.length - 5200, 5200)];
}

function isValidSpeaker(speaker: unknown, candidates: Set<string>): boolean {
  if (typeof speaker !== 'string') return false;
  if (speaker === 'Narrator') return true;
  return candidates.has(speaker.toLowerCase());
}

function contextForUnit(text: string, unit: ScriptUnit): string {
  const needle = unit.text.slice(0, Math.min(120, unit.text.length));
  const idx = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (idx < 0) return unit.text.slice(0, 420);
  return text.slice(Math.max(0, idx - 260), Math.min(text.length, idx + unit.text.length + 260)).replace(/\s+/g, ' ').trim();
}

const VALID_UNIT_EMOTION = new Set(['whisper', 'urgent', 'curious', 'soft']);

// ---------- Deep-pass helpers ----------

function unusualTokens(text: string, baseline: AutobookResult): string[] {
  const counts = new Map<string, number>();
  const words = text.toLowerCase().match(/[a-z][a-z''-]{2,}/g) ?? [];
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const names = new Set(baseline.cast.map((c) => c.name.toLowerCase()));
  const common = new Set(('the and that with have this will from they say said what when your about into over such then them well were are was for not but had his her she you all can out one our who been more other some time these two may than its now like know take make year see use man day').split(' '));
  const scored = [...counts.entries()]
    .filter(([w, n]) => n >= 2 && !common.has(w) && !/^\d/.test(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([w]) => w);
  return scored.filter((w) => w.length >= 4 || names.has(w)).slice(0, 24);
}

async function deepChapterPass(generator: any, text: string, baseline: AutobookResult): Promise<{ plan: AiChapterPlan[]; scenes: number }> {
  const anchor = baseline.chapters.slice(0, 10).map((c: any, i: number) => ({ index: i, title: typeof c?.title === 'string' ? c.title : '' }));
  const raw = await askJson(generator, [
    'You are an audiobook structural editor. Given the book excerpts and the current chapter list, propose a reading plan: rename chapters to specific evocative titles, write one-sentence summaries, and assign a target narration pace in words-per-minute (130 calm … 180 brisk) per chapter.',
    'Also estimate how many scene breaks (location/time shifts) the excerpts contain.',
    'Return ONLY valid JSON: {"chapters":[{"index":0,"title":"...","summary":"...","paceWpm":150}],"sceneBreaks":3}. Chapter indexes must refer to the CURRENT CHAPTERS list and must not exceed it.',
    `CURRENT CHAPTERS: ${JSON.stringify(anchor)}`,
    `EXCERPTS: ${bookSamples(text).map((s, i) => `E${i + 1}: ${s.slice(0, 3000)}`).join('\n')}`,
  ].join('\n'), 800);
  const plan = Array.isArray(raw?.chapters)
    ? raw.chapters
        .filter((c: any) => typeof c?.index === 'number' && c.index >= 0 && c.index < baseline.chapters.length && typeof c?.title === 'string')
        .map((c: any) => ({
          index: c.index,
          title: c.title.trim().slice(0, 120),
          summary: typeof c.summary === 'string' ? c.summary.trim().slice(0, 300) : '',
          paceWpm: typeof c.paceWpm === 'number' ? Math.max(110, Math.min(200, Math.round(c.paceWpm))) : 150,
        }))
    : [];
  return { plan, scenes: typeof raw?.sceneBreaks === 'number' ? Math.max(0, Math.min(200, Math.round(raw.sceneBreaks))) : 0 };
}

async function deepNarrationEmotionPass(generator: any, text: string, baseline: AutobookResult, onProgress: Progress): Promise<AiNarrationEmotion[]> {
  const narration = baseline.units.filter((u) => u.kind === 'narration' && u.text.trim()).slice(0, 320);
  const out: AiNarrationEmotion[] = [];
  const batchSize = 16;
  for (let start = 0; start < narration.length; start += batchSize) {
    const batch = narration.slice(start, start + batchSize);
    const rows = batch.map((u) => ({ id: u.id, text: u.text.slice(0, 280), context: contextForUnit(text, u).slice(0, 500) }));
    try {
      const arr = await askJson(generator, [
        'You are narrating an audiobook. For each passage choose a delivery from: whisper, urgent, curious, soft (soft = neutral/warm default). Base it on tension, imagery and pacing of the context.',
        'Return ONLY a JSON array: [{"id":"...","emotion":"soft"}].',
        `PASSAGES: ${JSON.stringify(rows)}`,
      ].join('\n'), Math.max(220, batch.length * 26));
      if (Array.isArray(arr)) {
        for (const d of arr) {
          if (typeof d?.id === 'string' && VALID_UNIT_EMOTION.has(d?.emotion)) out.push({ id: d.id, emotion: d.emotion });
        }
      }
    } catch { /* batch left to default delivery */ }
    onProgress?.(0.82 + (Math.min(start + batch.length, narration.length) / Math.max(1, narration.length)) * 0.1, `AI director: narrating tone ${Math.min(start + batch.length, narration.length)}/${narration.length}…`);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return out;
}

async function deepLexiconPass(generator: any, text: string, baseline: AutobookResult): Promise<AiLexiconEntry[]> {
  const tokens = unusualTokens(text, baseline);
  if (!tokens.length) return [];
  try {
    const arr = await askJson(generator, [
      'You are a pronunciation librarian for an audiobook narrator. For each term, give the spoken form (respelling such as "SHAR-lok", "jon-uh-thun"). Only include entries that genuinely need guidance — skip anything read as spelled.',
      'Return ONLY a JSON array: [{"word":"...","sayAs":"..."}].',
      `TERMS: ${JSON.stringify(tokens)}`,
    ].join('\n'), Math.max(250, tokens.length * 22));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e: any) => typeof e?.word === 'string' && typeof e?.sayAs === 'string' && e.word.trim() && e.sayAs.trim())
      .map((e: any) => ({ word: e.word.trim().toLowerCase(), sayAs: e.sayAs.trim().slice(0, 60) }))
      .slice(0, 30);
  } catch {
    return [];
  }
}

async function deepComplexDialoguePass(
  generator: any,
  text: string,
  baseline: AutobookResult,
  onProgress: Progress,
): Promise<{ decisions: AiDialogueDecision[]; resolved: number }> {
  // Find complex dialogue patterns: thoughts, mutterings, interruptions, nested quotes
  const complexUnits = baseline.units.filter((u) => {
    if (u.kind !== 'dialogue' && u.kind !== 'narration') return false;
    const ctx = contextForUnit(text, u);
    // Look for thought verbs, action beats between quotes, interrupted speech
    const hasComplexPattern = /\b(thought|wondered|muttered|whispered|hissed|growled|snapped|breathed|murmured)\b/i.test(ctx) ||
      /"[^"]*"\s*,?\s*\b(he|she)\s+\b(thought|said|muttered|whispered)\b/i.test(ctx) ||
      /\b(he|she)\s+\b(thought|muttered|whispered)\b\s*,?\s*"[^"]*"/i.test(ctx) ||
      /—\s*"|"\s*—/.test(ctx);
    return hasComplexPattern;
  }).slice(0, 120);

  const decisions: AiDialogueDecision[] = [];
  const batchSize = 10;

  for (let start = 0; start < complexUnits.length; start += batchSize) {
    const batch = complexUnits.slice(start, start + batchSize);
    const rows = batch.map((u) => ({
      id: u.id,
      text: u.text.slice(0, 320),
      context: contextForUnit(text, u).slice(0, 700),
      baselineSpeaker: u.speaker,
      kind: u.kind,
    }));

    try {
      const arr = await askJson(generator, [
        'You are a literary dialogue analyst specializing in complex narrative structures. Analyze each passage and determine the TRUE speaker.',
        'Handle these patterns: "ABC", he thought. (thought = narrator/internal monologue, NOT spoken); "DEF" "GHI", he muttered. (muttered = spoken by character); interrupted speech —; nested quotes within quotes.',
        'For thoughts/internal monologue: speaker should be "Narrator" (it is not spoken aloud). For spoken dialogue: identify the actual character speaking.',
        'Also provide delivery emotion from: calm, warm, urgent, curious, sad, angry, solemn, soft.',
        'Return ONLY a JSON array: [{"id":"...","speaker":"...","confidence":0..1,"emotion":"...","reasoning":"..."}]',
        `ROWS: ${JSON.stringify(rows)}`,
      ].join('\n'), Math.max(300, batch.length * 55));

      if (Array.isArray(arr)) {
        for (const d of arr) {
          const row = rows.find((r) => r.id === d?.id);
          if (!row) continue;
          const speaker = d.speaker === 'Narrator' ? 'Narrator' :
            baseline.cast.find((c) => c.name.toLowerCase() === String(d.speaker).toLowerCase())?.name ?? d.speaker;
          decisions.push({
            id: row.id,
            speaker,
            confidence: typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : undefined,
            emotion: ['calm', 'warm', 'urgent', 'curious', 'sad', 'angry', 'solemn', 'soft'].includes(d.emotion) ? d.emotion : undefined,
            reasoning: typeof d.reasoning === 'string' ? d.reasoning : undefined,
          });
        }
      }
    } catch { /* batch left to deterministic baseline */ }

    onProgress?.(
      0.65 + (Math.min(start + batch.length, complexUnits.length) / Math.max(1, complexUnits.length)) * 0.15,
      `AI director: complex dialogue ${Math.min(start + batch.length, complexUnits.length)}/${complexUnits.length}…`,
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  return { decisions, resolved: decisions.length };
}

async function deepCharacterAnalysisPass(
  generator: any,
  text: string,
  baseline: AutobookResult,
): Promise<{ characters: AiCharacterInsight[]; relationships: { from: string; to: string; relation: string }[] }> {
  const baselineNames = baseline.cast.filter((c) => c.name !== 'Narrator').map((c) => c.name);
  const samples = bookSamples(text);

  try {
    const raw = await askJson(generator, [
      'You are a literary character analyst. From the text excerpts, analyze each character thoroughly.',
      'For each character determine: gender, age band (child/young/adult/middle/elder/unknown), physical description, personality traits, and relationships to other characters.',
      'Also map relationships between characters: who is related to whom, who is friends/enemies, power dynamics.',
      'Return ONLY valid JSON: {"characters":[{"name":"...","gender":"male|female|neutral","ageBand":"...","physicalDescription":"...","personalityTraits":["..."],"relationships":[{"character":"...","relation":"..."}]}],"relationships":[{"from":"...","to":"...","relation":"..."}]}',
      `EXISTING NAMES: ${JSON.stringify(baselineNames)}`,
      samples.map((s, i) => `EXCERPT ${i + 1}: ${s}`).join('\n\n'),
    ].join('\n'), 1200);

    const characters: AiCharacterInsight[] = Array.isArray(raw?.characters)
      ? raw.characters
          .filter((c: any) => c && typeof c.name === 'string' && c.name.trim())
          .map((c: any) => ({
            name: c.name.trim(),
            gender: ['male', 'female', 'neutral'].includes(c.gender) ? c.gender : undefined,
            ageBand: ['child', 'young', 'adult', 'middle', 'elder', 'unknown'].includes(c.ageBand) ? c.ageBand : undefined,
            role: ['major', 'minor'].includes(c.role) ? c.role : undefined,
            delivery: ['calm', 'warm', 'urgent', 'curious', 'sad', 'angry', 'solemn', 'soft'].includes(c.delivery) ? c.delivery : undefined,
            evidence: Array.isArray(c.evidence) ? c.evidence.filter((e: unknown) => typeof e === 'string').slice(0, 4) : undefined,
            physicalDescription: typeof c.physicalDescription === 'string' ? c.physicalDescription : undefined,
            personalityTraits: Array.isArray(c.personalityTraits) ? c.personalityTraits.filter((t: unknown) => typeof t === 'string').slice(0, 5) : undefined,
            relationships: Array.isArray(c.relationships)
              ? c.relationships
                  .filter((r: any) => typeof r?.character === 'string' && typeof r?.relation === 'string')
                  .map((r: any) => ({ character: r.character, relation: r.relation }))
                  .slice(0, 5)
              : undefined,
          }))
      : [];

    const relationships = Array.isArray(raw?.relationships)
      ? raw.relationships
          .filter((r: any) => typeof r?.from === 'string' && typeof r?.to === 'string' && typeof r?.relation === 'string')
          .map((r: any) => ({ from: r.from, to: r.to, relation: r.relation }))
          .slice(0, 20)
      : [];

    return { characters, relationships };
  } catch {
    return { characters: [], relationships: [] };
  }
}

export async function analyzeWithLocalAI(
  text: string,
  baseline: AutobookResult,
  options?: { modelId?: string; onProgress?: Progress; fileContext?: AutobookOptionsContext; deep?: boolean },
): Promise<LocalAiEnhancement> {
  const model = getLocalAiModel(options?.modelId ?? DEFAULT_LOCAL_AI_MODEL_ID);
  const onProgress = options?.onProgress;

  // CORRECTED: missing local model files are no longer fatal. Previously this
  // threw when `status.ready` was false, which silently forced the deterministic
  // fallback even though createGenerator() can download the model once from the
  // registry `source` (Hugging Face) and cache it in the browser. We still probe
  // the status so the UI message accurately reflects "first use will download".
  const status = await getLocalAIStatus(model.id);
  if (!status.ready) {
    onProgress?.(0.01, status.message);
  }

  onProgress?.(0.02, `Loading ${model.label}…`);
  const generator = await createGenerator(model);
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const baselineNames = baseline.cast.filter((c) => c.name !== 'Narrator').map((c) => c.name);
  const samples = bookSamples(text);
  const prompt = [
    'You are an audiobook editorial director. Analyze the supplied book excerpts and return ONLY valid JSON.',
    'Do not invent names. Keep character names that appear in the text. Decide whether the book is fiction or non-fiction from narrative behavior, not just the word density.',
    `INPUT FILE CONTEXT (metadata only; never read these fields aloud): ${JSON.stringify(options?.fileContext ?? { category: 'text', textKind: 'plain' })}`,
    'Use the file type to interpret extracted material correctly. For scanned PDFs/images, prioritize OCR text and ignore page furniture, scanning metadata and OCR noise. For web/HTML/document extraction, do not treat navigation, menus, file metadata or formatting furniture as book prose.',
    'Return this exact shape: {"genre":"fiction|non-fiction","genreConfidence":0..1,"titleGuess":"","authorGuess":"","narratorStyle":"","characters":[{"name":"","gender":"male|female|neutral","ageBand":"child|young|adult|middle|elder|unknown","role":"major|minor","delivery":"calm|warm|urgent|curious|sad|angry|solemn|soft","evidence":[""]}]}.',
    `Existing deterministic names (may be incomplete): ${JSON.stringify(baselineNames)}`,
    samples.map((s, i) => `EXCERPT ${i + 1}: ${s}`).join('\n\n'),
  ].join('\n');

  onProgress?.(0.10, 'AI director: genre and cast analysis…');
  const global = await askJson(generator, prompt, 900);
  const rawCharacters = Array.isArray(global?.characters) ? global.characters : [];

  const dialogueUnits = baseline.units.filter((u) => u.kind === 'dialogue');
  const candidates = new Set([...baselineNames, ...rawCharacters.map((c: any) => String(c?.name ?? '')).filter(Boolean)].map((n) => n.toLowerCase()));
  const needsReview = dialogueUnits.filter((u) => u.speaker === 'Narrator' || candidates.has(u.speaker.toLowerCase()));
  const decisions: AiDialogueDecision[] = [];
  const batchSize = 14;
  const reviewCap = Math.min(needsReview.length, 280);

  for (let start = 0; start < reviewCap; start += batchSize) {
    const batch = needsReview.slice(start, start + batchSize);
    const rows = batch.map((u) => ({
      id: u.id,
      quote: u.text.slice(0, 320),
      context: contextForUnit(text, u).slice(0, 700),
      baselineSpeaker: u.speaker,
    }));
    const qPrompt = [
      'You are adjudicating dialogue speakers in a novel. Return ONLY a JSON array.',
      'For each row, choose the speaker from the candidate roster or Narrator. Never invent a different name. Use dialogue grammar, action beats, vocatives and nearby context.',
      'Also provide a delivery emotion from: calm, warm, urgent, curious, sad, angry, solemn, soft.',
      'Shape: [{"id":"...","speaker":"...","confidence":0..1,"emotion":"..."}]',
      `CANDIDATES: ${JSON.stringify([...candidates])}`,
      `ROWS: ${JSON.stringify(rows)}`,
    ].join('\n');
    try {
      const arr = await askJson(generator, qPrompt, Math.max(250, batch.length * 45));
      if (Array.isArray(arr)) {
        for (const d of arr) {
          const row = rows.find((r) => r.id === d?.id);
          if (!row || !isValidSpeaker(d?.speaker, candidates)) continue;
          decisions.push({
            id: row.id,
            speaker: d.speaker === 'Narrator' ? 'Narrator' : baseline.cast.find((c) => c.name.toLowerCase() === String(d.speaker).toLowerCase())?.name ?? d.speaker,
            confidence: typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : undefined,
            emotion: ['calm', 'warm', 'urgent', 'curious', 'sad', 'angry', 'solemn', 'soft'].includes(d.emotion) ? d.emotion : undefined,
          });
        }
      }
    } catch {
      // A failed batch is safely left to the deterministic baseline.
    }
    onProgress?.(0.16 + (start + batch.length) / Math.max(1, reviewCap) * 0.54, `AI director: adjudicating dialogue ${Math.min(start + batch.length, reviewCap)}/${reviewCap}…`);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  // ---------- Deep passes: structure, narration tone, pacing, pronunciation, complex dialogue, character analysis ----------
  let chapterPlan: AiChapterPlan[] | undefined;
  let narrationEmotion: AiNarrationEmotion[] | undefined;
  let lexicon: AiLexiconEntry[] | undefined;
  let sceneBreaks: number | undefined;
  let complexDialogueResolved = 0;
  let relationshipMap: { from: string; to: string; relation: string }[] | undefined;
  let enrichedCharacters: AiCharacterInsight[] | undefined;

  if (options?.deep) {
    onProgress?.(0.72, 'AI director: chapter structure & pacing…');
    try {
      const ch = await deepChapterPass(generator, text, baseline);
      chapterPlan = ch.plan.length ? ch.plan : undefined;
      sceneBreaks = ch.scenes;
    } catch { /* structure pass is optional */ }
    await new Promise((resolve) => requestAnimationFrame(resolve));

    onProgress?.(0.76, 'AI director: complex dialogue structures…');
    try {
      const cd = await deepComplexDialoguePass(generator, text, baseline, (p, m) => onProgress?.(p, m));
      if (cd.decisions.length) {
        for (const d of cd.decisions) {
          const existing = decisions.find((x) => x.id === d.id);
          if (existing) {
            existing.speaker = d.speaker;
            existing.confidence = d.confidence;
            existing.emotion = d.emotion;
            existing.reasoning = d.reasoning;
          } else {
            decisions.push(d);
          }
        }
        complexDialogueResolved = cd.resolved;
      }
    } catch { /* complex dialogue pass is optional */ }
    await new Promise((resolve) => requestAnimationFrame(resolve));

    onProgress?.(0.80, 'AI director: deep character analysis…');
    try {
      const ca = await deepCharacterAnalysisPass(generator, text, baseline);
      enrichedCharacters = ca.characters.length ? ca.characters : undefined;
      relationshipMap = ca.relationships.length ? ca.relationships : undefined;
    } catch { /* character analysis pass is optional */ }
    await new Promise((resolve) => requestAnimationFrame(resolve));

    onProgress?.(0.86, 'AI director: narration tone…');
    try {
      const ne = await deepNarrationEmotionPass(generator, text, baseline, (p, m) => onProgress?.(p, m));
      narrationEmotion = ne.length ? ne : undefined;
    } catch { /* tone pass is optional */ }

    onProgress?.(0.94, 'AI director: pronunciation lexicon…');
    try {
      const lx = await deepLexiconPass(generator, text, baseline);
      lexicon = lx.length ? lx : undefined;
    } catch { /* lexicon pass is optional */ }
  }

  onProgress?.(0.97, 'AI director: applying confidence-checked decisions…');
  const notes: string[] = [
    status.ready
      ? `Used ${model.label} locally with remote model loading disabled.`
      : `Used ${model.label} via a one-time download from ${model.source}; it is now cached in this browser.`,
    `AI reviewed ${decisions.length} dialogue lines; deterministic attribution remains the fallback for the rest.`,
  ];
  if (options?.deep) {
    if (chapterPlan?.length) notes.push(`AI restructured ${chapterPlan.length} chapters with titles, summaries and per-chapter pacing.`);
    if (complexDialogueResolved > 0) notes.push(`AI resolved ${complexDialogueResolved} complex dialogue structures (thoughts, mutterings, interruptions).`);
    if (enrichedCharacters?.length) notes.push(`AI performed deep analysis on ${enrichedCharacters.length} characters including personality and physical traits.`);
    if (relationshipMap?.length) notes.push(`AI mapped ${relationshipMap.length} character relationships.`);
    if (narrationEmotion?.length) notes.push(`AI directed the narration tone of ${narrationEmotion.length} passages.`);
    if (lexicon?.length) notes.push(`AI suggested pronunciations for ${lexicon.length} unusual terms.`);
    if (sceneBreaks) notes.push(`AI detected ~${sceneBreaks} scene breaks for beat-aware pacing.`);
  }
  if (needsReview.length > reviewCap) notes.push(`${needsReview.length - reviewCap} additional dialogue lines were left to the deterministic resolver to keep long books responsive.`);

  return {
    modelId: model.id,
    modelName: model.label,
    genre: global?.genre === 'fiction' || global?.genre === 'non-fiction' ? global.genre : undefined,
    genreConfidence: typeof global?.genreConfidence === 'number' ? Math.max(0, Math.min(1, global.genreConfidence)) : undefined,
    titleGuess: typeof global?.titleGuess === 'string' ? global.titleGuess.trim() : undefined,
    authorGuess: typeof global?.authorGuess === 'string' ? global.authorGuess.trim() : undefined,
    narratorStyle: typeof global?.narratorStyle === 'string' ? global.narratorStyle.trim() : undefined,
    characters: enrichedCharacters ?? rawCharacters
      .filter((c: any) => c && typeof c.name === 'string' && c.name.trim())
      .map((c: any) => ({
        name: c.name.trim(),
        gender: ['male', 'female', 'neutral'].includes(c.gender) ? c.gender : undefined,
        ageBand: ['child', 'young', 'adult', 'middle', 'elder', 'unknown'].includes(c.ageBand) ? c.ageBand : undefined,
        role: ['major', 'minor'].includes(c.role) ? c.role : undefined,
        delivery: ['calm', 'warm', 'urgent', 'curious', 'sad', 'angry', 'solemn', 'soft'].includes(c.delivery) ? c.delivery : undefined,
        evidence: Array.isArray(c.evidence) ? c.evidence.filter((e: unknown) => typeof e === 'string').slice(0, 4) : undefined,
      })),
    dialogue: decisions,
    reviewedDialogue: decisions.length,
    notes,
    chapterPlan,
    narrationEmotion,
    lexicon,
    sceneBreaks,
    complexDialogueResolved: options?.deep ? complexDialogueResolved : undefined,
    relationshipMap,
  };
}
