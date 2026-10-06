'use client';

// ============================================================
// Openmukti Audiobook Creator — AI services for every module.
// One shared local model powers OCR correction, transcript
// cleanup, TTS direction, document intelligence, asset tagging,
// video planning, dialogue scoring and voice design.
// All calls are optional-enhancement only: deterministic
// engines remain the fallback when AI is off or unavailable.
// ============================================================

import {
  aiPromptJson,
  aiPromptText,
  runAiTask,
  type AiTaskOutcome,
} from '@/lib/engines/local-ai';
import { useAppStore } from '@/lib/stores/app-store';
import type {
  AssetItem,
  AssetKind,
  OcrResult,
  TranscriptChapter,
  VoiceProfileDef,
  AiDocumentIntel,
  AiAssetTags,
  AiVideoPlan,
  AiVoiceDesign,
  AiDialogueDirection,
  AiOcrEnhancement,
  AiSpeechDirection,
  AiTranscriptCleanup,
} from '@/lib/types';

export type AiDomain = 'ocr' | 'transcript' | 'tts' | 'files' | 'assets' | 'video' | 'dialogue' | 'voices';

export function aiDomainEnabled(domain: AiDomain): boolean {
  const s = useAppStore.getState().settings;
  if (!s.aiAssist) return false;
  switch (domain) {
    case 'ocr': return s.aiAssistOcr;
    case 'transcript': return s.aiAssistTranscript;
    case 'tts': return s.aiAssistTts;
    case 'files': return s.aiAssistFiles;
    case 'assets': return s.aiAssistAssets;
    case 'video': return s.aiAssistVideo;
    case 'dialogue': return s.aiAssistDialogue;
    case 'voices': return s.aiAssistVoices;
  }
}

function depthScale(): number {
  const d = useAppStore.getState().settings.aiDepth;
  return d === 'light' ? 1 : d === 'deep' ? 3 : 2;
}

function modelId(): string | undefined {
  return useAppStore.getState().settings.localAiModelId;
}

const JSON_RULES = 'Return ONLY valid JSON. No prose, no markdown fences.';

// ---------- OCR: post-correction editor ----------
export async function aiEnhanceOcrResult(
  result: OcrResult,
  fileContext?: Record<string, unknown>,
): Promise<AiTaskOutcome<AiOcrEnhancement>> {
  if (!aiDomainEnabled('ocr')) return { ok: false, error: 'AI OCR assist disabled' };
  const sample = result.text.slice(0, 9000);
  return runAiTask('AI OCR correction', async () => {
    const raw = await aiPromptJson<AiOcrEnhancement>([
      'You are an OCR post-correction editor. The text came from template-matching OCR and contains substitution errors (rn→m, 0→O, 1→l), broken hyphenation, missing punctuation/capitalization and page furniture (headers, footers, page numbers, scan noise).',
      'Fix errors using context, restore punctuation and capitalization, join words split across lines, and DELETE page furniture and OCR noise — do not invent content that is not supported by the characters present.',
      `INPUT FILE CONTEXT (never read aloud): ${JSON.stringify(fileContext ?? { category: 'image', textKind: 'ocr' })}`,
      JSON_RULES,
      'Shape: {"text":"full corrected text","lines":[{"text":"corrected line","confidence":0..1}],"notes":["what was fixed"]}. Keep line count close to the input.',
      `INPUT LINES: ${JSON.stringify(result.lines.slice(0, 220).map((l) => l.text))}`,
      `RAW TEXT: ${sample}`,
    ].join('\n'), 1100, modelId());
    if (!raw?.text) throw new Error('Model returned no corrected text');
    return {
      text: raw.text,
      lines: Array.isArray(raw.lines)
        ? raw.lines
            .filter((l) => typeof l?.text === 'string')
            .map((l) => ({
              text: l.text,
              confidence: typeof l.confidence === 'number' ? Math.max(0, Math.min(1, l.confidence)) : result.avgConfidence,
            }))
        : result.lines.map((l) => ({ text: l.text, confidence: l.confidence })),
      notes: Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === 'string').slice(0, 6) : [],
    };
  });
}

// ---------- Transcription: cleanup + chaptering ----------
export async function aiCleanTranscript(rawText: string): Promise<AiTaskOutcome<AiTranscriptCleanup>> {
  if (!aiDomainEnabled('transcript')) return { ok: false, error: 'AI transcript assist disabled' };
  return runAiTask('AI transcript cleanup', async () => {
    const out = await aiPromptJson<{ text: string; notes: string[] }>([
      'You are a transcript editor. Raw speech-to-text output lacks punctuation and paragraphing and may contain recognition errors and filler noise.',
      'Add sentence punctuation, paragraph breaks and capitalization. Remove false-starts and repeated filler only when meaning is preserved. Fix obvious homophone errors from context. Do NOT add content.',
      JSON_RULES,
      'Shape: {"text":"cleaned transcript","notes":["edits made"]}.',
      `RAW TRANSCRIPT: ${rawText.slice(0, 12000)}`,
    ].join('\n'), Math.min(1800, 400 + Math.floor(rawText.length / 6)), modelId());
    if (!out?.text) throw new Error('Model returned no transcript');
    return { text: out.text, notes: Array.isArray(out.notes) ? out.notes.filter((n): n is string => typeof n === 'string').slice(0, 6) : [] };
  });
}

export async function aiTranscriptToChapters(text: string, maxChapters = 12): Promise<AiTaskOutcome<TranscriptChapter[]>> {
  if (!aiDomainEnabled('transcript')) return { ok: false, error: 'AI transcript assist disabled' };
  return runAiTask('AI chaptering', async () => {
    const out = await aiPromptJson<{ chapters: { title: string; text: string }[] }>([
      `You are a podcast/lecture editor. Split the transcript into up to ${maxChapters} coherent chapters at topic boundaries. Every input word must appear in exactly one chapter, in order — do not summarize or drop content.`,
      'Give each chapter a short specific title.',
      JSON_RULES,
      'Shape: {"chapters":[{"title":"...","text":"verbatim transcript slice"}]}.',
      `TRANSCRIPT: ${text.slice(0, 16000)}`,
    ].join('\n'), 1600, modelId());
    if (!Array.isArray(out?.chapters) || !out.chapters.length) throw new Error('Model returned no chapters');
    return out.chapters
      .filter((c) => typeof c?.title === 'string' && typeof c?.text === 'string' && c.text.trim())
      .map((c) => ({ title: c.title.trim().slice(0, 120), text: c.text }));
  });
}

// ---------- TTS: directorial normalization ----------
export async function aiNormalizeForSpeech(text: string): Promise<AiTaskOutcome<AiSpeechDirection>> {
  if (!aiDomainEnabled('tts')) return { ok: false, error: 'AI TTS assist disabled' };
  return runAiTask('AI speech direction', async () => {
    const out = await aiPromptJson<{ text: string; notes: string[] }>([
      'You are a voice director preparing text for text-to-speech. Expand symbols, numbers, currency and abbreviations into spoken words; keep the text otherwise verbatim and in the original order.',
      'Mark dramatic pauses with an em-dash (—) only where a real pause belongs (scene shifts, before punchlines). Never reorder or delete words.',
      JSON_RULES,
      'Shape: {"text":"speakable script","notes":["director choices"]}.',
      `TEXT: ${text.slice(0, 9000)}`,
    ].join('\n'), 1200, modelId());
    if (!out?.text) throw new Error('Model returned no script');
    return { text: out.text, notes: Array.isArray(out.notes) ? out.notes.filter((n): n is string => typeof n === 'string').slice(0, 5) : [] };
  });
}

// ---------- Files: document intelligence ----------
export async function aiAnalyzeDocument(text: string): Promise<AiTaskOutcome<AiDocumentIntel>> {
  if (!aiDomainEnabled('files')) return { ok: false, error: 'AI file assist disabled' };
  return runAiTask('AI document analysis', async () => {
    const out = await aiPromptJson<AiDocumentIntel>([
      `You are a document analyst. Read the document and produce a title guess, a summary of at most ${120 * depthScale()} words, ${5 * depthScale()} key points, and up to 10 keywords. Be faithful; do not invent facts.`,
      JSON_RULES,
      'Shape: {"title":"...","summary":"...","keyPoints":["..."],"keywords":["..."]}.',
      `DOCUMENT: ${text.slice(0, 12000)}`,
    ].join('\n'), 900, modelId());
    if (!out?.summary) throw new Error('Model returned no summary');
    return {
      title: typeof out.title === 'string' ? out.title : 'Untitled',
      summary: out.summary,
      keyPoints: Array.isArray(out.keyPoints) ? out.keyPoints.filter((k): k is string => typeof k === 'string').slice(0, 15) : [],
      keywords: Array.isArray(out.keywords) ? out.keywords.filter((k): k is string => typeof k === 'string').slice(0, 12) : [],
    };
  });
}

// ---------- Asset bin: auto-tagging ----------
export async function aiTagAsset(
  asset: Pick<AssetItem, 'name' | 'kind' | 'text' | 'mimeType'>,
): Promise<AiTaskOutcome<AiAssetTags>> {
  if (!aiDomainEnabled('assets')) return { ok: false, error: 'AI asset assist disabled' };
  return runAiTask('AI asset tagging', async () => {
    const out = await aiPromptJson<AiAssetTags>([
      'You are a media librarian. From the asset name, kind, mime type and (if present) a text preview, produce lowercase snake_case tags, a one-sentence description, and the most likely asset kind from: audio, image, text, video, data.',
      JSON_RULES,
      'Shape: {"tags":["..."],"description":"...","kind":"audio|image|text|video|data"}.',
      `ASSET: ${JSON.stringify({ name: asset.name, kind: asset.kind, mimeType: asset.mimeType, preview: (asset.text ?? '').slice(0, 1200) })}`,
    ].join('\n'), 350, modelId());
    if (!out) throw new Error('Model returned no tags');
    const kinds: AssetKind[] = ['audio', 'image', 'text', 'video', 'data'];
    return {
      tags: Array.isArray(out.tags) ? out.tags.filter((t): t is string => typeof t === 'string').slice(0, 10) : [],
      description: typeof out.description === 'string' ? out.description : '',
      kind: kinds.includes(out.kind as AssetKind) ? (out.kind as AssetKind) : asset.kind,
    };
  });
}

// ---------- Video editor: planning + captions ----------
const VIDEO_ENUMS = 'transition: none|fade|slide|wipe · kenBurns: none|zoom-in|zoom-out|pan-left|pan-right · filter: none|grayscale|sepia|vintage|cool|warm';

export async function aiPlanVideo(brief: string, clipCount = 6): Promise<AiTaskOutcome<AiVideoPlan>> {
  if (!aiDomainEnabled('video')) return { ok: false, error: 'AI video assist disabled' };
  return runAiTask('AI video plan', async () => {
    const out = await aiPromptJson<AiVideoPlan>([
      `You are a video storyboard director. From the brief, design a ${clipCount}-clip plan. Each clip gets short on-screen text, a duration of 2–8 seconds, and enums (${VIDEO_ENUMS}). Keep durations realistic and the flow narrative.`,
      'Also write up to 6 subtitle captions for the whole piece.',
      JSON_RULES,
      'Shape: {"title":"...","clips":[{"text":"...","durationSec":4,"transition":"fade","kenBurns":"zoom-in","filter":"none"}],"captions":["..."]}.',
      `BRIEF: ${brief.slice(0, 2500)}`,
    ].join('\n'), 800, modelId());
    if (!Array.isArray(out?.clips) || !out.clips.length) throw new Error('Model returned no plan');
    return out;
  });
}

export async function aiWriteCaptions(scriptText: string, count = 8): Promise<AiTaskOutcome<string[]>> {
  if (!aiDomainEnabled('video')) return { ok: false, error: 'AI video assist disabled' };
  return runAiTask('AI captions', async () => {
    const out = await aiPromptJson<{ captions: string[] }>([
      `Write exactly ${count} concise subtitle captions for this narration script, in order, each under 60 characters. Verbatim fragments only — do not paraphrase.`,
      JSON_RULES,
      'Shape: {"captions":["..."]}.',
      `SCRIPT: ${scriptText.slice(0, 6000)}`,
    ].join('\n'), 500, modelId());
    if (!Array.isArray(out?.captions) || !out.captions.length) throw new Error('Model returned no captions');
    return out.captions.filter((c): c is string => typeof c === 'string').slice(0, count);
  });
}

// ---------- Dialogue: per-line direction ----------
export async function aiDirectDialogue(
  lines: { id: string; speaker: string; text: string }[],
): Promise<AiTaskOutcome<AiDialogueDirection[]>> {
  if (!aiDomainEnabled('dialogue')) return { ok: false, error: 'AI dialogue assist disabled' };
  return runAiTask('AI dialogue direction', async () => {
    const out = await aiPromptJson<{ directions: AiDialogueDirection[] }>([
      'You are a dialogue coach. For each line, choose the delivery emotion from: whisper, urgent, curious, soft. Use subtext, punctuation and the surrounding exchange — not stereotypes.',
      JSON_RULES,
      'Shape: {"directions":[{"id":"...","emotion":"soft","note":"one line of reasoning"}]}.',
      `LINES: ${JSON.stringify(lines.slice(0, 40))}`,
    ].join('\n'), Math.max(300, lines.length * 35), modelId());
    if (!Array.isArray(out?.directions)) throw new Error('Model returned no directions');
    const valid = ['whisper', 'urgent', 'curious', 'soft'];
    return out.directions
      .filter((d) => typeof d?.id === 'string' && valid.includes(d.emotion))
      .map((d) => ({
        id: d.id,
        emotion: d.emotion as AiDialogueDirection['emotion'],
        note: typeof d.note === 'string' ? d.note.slice(0, 140) : undefined,
      }));
  });
}

// ---------- Voice library: design profiles from prose ----------
export async function aiDesignVoiceProfile(description: string): Promise<AiTaskOutcome<AiVoiceDesign>> {
  if (!aiDomainEnabled('voices')) return { ok: false, error: 'AI voice assist disabled' };
  return runAiTask('AI voice design', async () => {
    const out = await aiPromptJson<AiVoiceDesign>([
      'You are a voice designer for a formant synthesizer. From the natural-language description, derive concrete parameters.',
      JSON_RULES,
      'Shape: {"name":"short profile name","gender":"male|female|neutral","basePitchHz":90..260,"timbre":0..1,"breath":0..1,"description":"one sentence"}. basePitchHz ~120 male, ~210 female; timbre 0 dark/warm → 1 bright/nasal; breath 0 clear → 1 whispery.',
      `DESCRIPTION: ${description.slice(0, 800)}`,
    ].join('\n'), 300, modelId());
    if (!out || typeof out.basePitchHz !== 'number') throw new Error('Model returned no design');
    return {
      name: typeof out.name === 'string' && out.name.trim() ? out.name.trim().slice(0, 40) : 'AI Voice',
      gender: ['male', 'female', 'neutral'].includes(out.gender) ? out.gender : 'neutral',
      basePitchHz: Math.max(60, Math.min(300, Math.round(out.basePitchHz))),
      timbre: Math.max(0, Math.min(1, Number(out.timbre) || 0.5)),
      breath: Math.max(0, Math.min(1, Number(out.breath) || 0.2)),
      description: typeof out.description === 'string' ? out.description : description.slice(0, 120),
    };
  });
}

// ---------- Generic free-form AI (dashboard assistant, etc.) ----------
export async function aiAsk(question: string, context?: string): Promise<AiTaskOutcome<string>> {
  if (!useAppStore.getState().settings.aiAssist) return { ok: false, error: 'AI assist disabled' };
  return runAiTask('AI assistant', () =>
    aiPromptText(
      [
        'You are Aura, the embedded assistant of Openmukti Audiobook Creator, a fully local audio/OCR studio. Answer concisely and practically. Never claim to send data anywhere — everything runs locally.',
        context ? `CONTEXT:\n${context.slice(0, 6000)}` : '',
        `QUESTION: ${question}`,
      ].filter(Boolean).join('\n'),
      { maxNewTokens: 420, modelId: modelId() },
    ).then((t) => (t ? t : Promise.reject(new Error('Empty model output')))),
  );
}
