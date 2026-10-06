'use client';

// ============================================================
// Openmukti Audiobook Studio — AI-first AutoBook orchestration.
//
// The deterministic engine (autobook.ts) generates a DRAFT script.
// This module then drives the local LLM to:
//   1. Verify the draft script CHUNK BY CHUNK across the entire book
//   2. Correct dialogue attribution errors the rules missed
//   3. Rebuild the cast from full-text evidence (gender, age, role, personality)
//   4. Assign voices AI-driven by character description, not just gender+age
//   5. Rewrite/refine narration for better audiobook flow
//   6. Deep-analyze complex dialogue (thoughts, mutterings, interruptions)
//
// CONTEXT-AWARE PROCESSING: no AI decision is ever made from a single line
// in isolation. Every chunk verification shows the AI the previous and
// coming lines (read-only context); character validation sees the sentences
// before and after each name mention; narration refinement reasons over the
// surrounding scene flow.
//
// Every AI call is optional-enhancement: if the model is missing or cannot
// load, the rule-based draft is returned unchanged. When remote fallback is
// enabled in local-ai.ts, a missing model is downloaded from its own Hugging
// Face repository before inference starts.
// ============================================================

import { buildAudiobookScript, type AutobookOptions, type AutobookResult, type ScriptUnit, type BookCastMember, type AutobookStats } from '@/lib/engines/autobook';
import { castVoiceFor, inferCharacterMeta, withRole } from '@/lib/engines/autobook-cast';
import { analyzeWithLocalAI, type LocalAiEnhancement } from '@/lib/engines/local-ai';
import { autobookCheckpointKey, clearAutobookCheckpoint, loadAutobookCheckpoint, saveAutobookCheckpoint } from '@/lib/engines/autobook-checkpoint';
import { useAppStore } from '@/lib/stores/app-store';
import { yieldToUI } from '@/lib/utils/async';
import type { VoiceProfileDef } from '@/lib/types';

export interface AiProgress { onProgress?: (p: number, message?: string) => void; }

function countWords(text: string): number { return (text.match(/\S+/g) ?? []).length; }
function normaliseName(name: string): string { return name.replace(/\s+/g, ' ').trim().toLowerCase(); }

function validDeliveryHint(v: unknown): ScriptUnit['emotionHint'] | undefined {
  switch (v) {
    case 'whisper': case 'urgent': case 'curious': case 'soft': return v;
    case 'angry': return 'urgent';
    case 'sad': case 'solemn': case 'warm': case 'calm': return 'soft';
    default: return undefined;
  }
}

// ---------- Utility: extract JSON from model output ----------

function extractJson(raw: unknown): unknown {
  const text = typeof raw === 'string' ? raw : generatedText(raw);
  const cleaned = text
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

// ---------- Chunk-by-chunk script verification ----------

interface ChunkVerification {
  id: string;
  speaker: string;
  corrected?: boolean;
  emotion?: ScriptUnit['emotionHint'];
  reasoning?: string;
}

interface ChunkResult {
  verifications: ChunkVerification[];
  /** Every unit id the AI returned a decision for — drives honest coverage. */
  coveredIds: string[];
  newCharacters?: { name: string; gender: string; age: string; description: string; evidence: string[] }[];
  notes: string[];
}

const CHUNK_SIZE = 12;
// Light mode uses smaller prompts and shorter outputs so CPU/WASM inference
// remains usable in a normal browser tab.
const LIGHT_CHUNK_SIZE = 4;
const LIGHT_VERIFY_TOKENS = 384;
// How many neighbouring units BEFORE and AFTER each chunk are shown to the AI
// as read-only context. Every line is judged against the sentences that come
// before and after it — never the single line in isolation.
const CONTEXT_UNITS = 6;
// How many sentences around a name mention are shown to the character validator.
const NAME_CONTEXT_SENTENCES = 2;

function formatUnitLine(u: ScriptUnit, maxLen = 120): string {
  return `${u.id}: [${u.kind}] ${u.speaker}: "${u.text.slice(0, maxLen)}${u.text.length > maxLen ? '...' : ''}"`;
}

/** Sentences immediately before and after a unit's own text — the "previous and
 * coming sentences" the AI must reason from. Derived from the script units
 * themselves so no raw-text searching is needed. */
function surroundingUnitLines(
  units: ScriptUnit[],
  startIdx: number,
  endIdx: number,
  contextUnits = CONTEXT_UNITS,
): { before: string[]; after: string[] } {
  const before = units
    .slice(Math.max(0, startIdx - contextUnits), startIdx)
    .map((u) => formatUnitLine(u));
  const after = units
    .slice(endIdx, Math.min(units.length, endIdx + contextUnits))
    .map((u) => formatUnitLine(u));
  return { before, after };
}

function buildChunkContext(text: string, units: ScriptUnit[], startIdx: number, endIdx: number): string {
  const unitTexts = units.slice(startIdx, endIdx).map((u) => u.text);
  let context = '';
  for (const ut of unitTexts.slice(0, 6)) {
    const idx = text.indexOf(ut.slice(0, Math.min(50, ut.length)));
    if (idx >= 0) {
      context += text.slice(Math.max(0, idx - 100), Math.min(text.length, idx + ut.length + 100)) + '\n\n---\n\n';
    }
  }
  return context.slice(0, 4000);
}

/** Extract the sentences around every mention of `name` — including the
 * sentences BEFORE and AFTER each mention — so the AI judges a candidate
 * character from its narrative context, not from the name string alone. */
function extractNameContextWindows(text: string, name: string): string {
  // Split the book into sentences (crude but robust across formats;
  // no lookbehind so older engines stay supported).
  const sentences = text
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]+(?:["'\)\]]+)?|[^.!?]+$/g)
    ?.map((s) => s.trim())
    .filter((s) => s.length > 1) ?? [];
  const windows: string[] = [];
  const needle = name.toLowerCase(); // "The Other Girl" must match "the other girl"
  for (let i = 0; i < sentences.length && windows.length < 2; i++) {
    if (!sentences[i].toLowerCase().includes(needle)) continue;
    const from = Math.max(0, i - NAME_CONTEXT_SENTENCES);
    const to = Math.min(sentences.length, i + NAME_CONTEXT_SENTENCES + 1);
    windows.push(sentences.slice(from, to).join(' '));
  }
  return windows.join(' || ').slice(0, 700);
}

async function verifyChunk(
  generator: any,
  text: string,
  units: ScriptUnit[],
  startIdx: number,
  endIdx: number,
  knownCharacters: string[],
  maxNewTokens = 1600,
  contextUnits = CONTEXT_UNITS,
): Promise<ChunkResult> {
  const chunk = units.slice(startIdx, endIdx);
  const context = buildChunkContext(text, units, startIdx, endIdx);
  const { before, after } = surroundingUnitLines(units, startIdx, endIdx, contextUnits);
  const prompt = [
    'You are an expert literary editor reviewing an audiobook script. The script was generated by rule-based automation and may contain errors.',
    'CRITICAL: Never judge a line from the line alone. Use the PREVIOUS LINES and COMING LINES shown below to understand who is speaking, what is being thought vs said, and how each line flows from its neighbours. Pronouns, action beats and dialogue tags often resolve only in the surrounding sentences.',
    'You MUST return a decision for EVERY unit id listed in the SCRIPT CHUNK section — all ' + chunk.length + ' of them. Do not omit any unit, even if it is already correct.',
    'Do NOT return decisions for ids in the PREVIOUS LINES or COMING LINES sections — those are context only.',
    'For each unit, verify the speaker attribution is correct USING THE SURROUNDING SENTENCES. Pay special attention to:',
    '  - Two quotes in a row: are they the same speaker or different? Check who spoke in the lines before/after.',
    '  - "ABC", he thought. "DEF" → The thought is internal monologue (speaker = Narrator), NOT spoken.',
    '  - "GHI", he muttered. "JKL" → The muttering IS spoken by the character.',
    '  - Action beats before quotes: "The boy hesitated. \\"I don\'t know.\\"" → The boy speaks.',
    '  - Gendered pronouns: if "she said" follows a quote, the speaker is the most recent female character mentioned in the preceding lines.',
    '  - Vocative names inside quotes: "Eleanor, come here" → the OTHER person is speaking.',
    '  - Interruptions: "—But I—" "Quiet!" → track who was interrupted from the surrounding exchange.',
    '  - If the speaker name is an ordinary word or placeholder (e.g. "It", "Well", "Monday", "The Boy"), correct it to the real character name or Narrator.',
    'Return ONLY valid JSON.',
    'Shape: {"verifications":[{"id":"u0","speaker":"Narrator","corrected":false,"emotion":"soft","reasoning":"..."}],"newCharacters":[{"name":"...","gender":"male|female|neutral","age":"child|young|adult|middle|elder","description":"...","evidence":["..."]}],"notes":["..."]}.',
    'The verifications array MUST contain exactly one entry per unit id in the SCRIPT CHUNK — confirm correct attributions with corrected:false rather than omitting them.',
    `KNOWN CHARACTERS: ${JSON.stringify(knownCharacters)}`,
    ...(before.length ? ['PREVIOUS LINES (context only — do NOT return decisions for these):', ...before] : ['PREVIOUS LINES: (none — this is the start of the book)']),
    `SCRIPT CHUNK (return a decision for every one of these ${chunk.length} units):`,
    ...chunk.map((u) => `  ${formatUnitLine(u)}`),
    ...(after.length ? ['COMING LINES (context only — do NOT return decisions for these):', ...after] : ['COMING LINES: (none — this is the end of the book)']),
    `SOURCE TEXT EXCERPTS:\n${context}`,
  ].join('\n');

  try {
    const raw = await generator(prompt, { max_new_tokens: maxNewTokens, do_sample: false, return_full_text: false });
    const out = extractJson(raw) as Record<string, any> | null;
    if (!out || typeof out !== 'object') return { verifications: [], coveredIds: [], notes: ['Chunk parse failed'] };
    const chunkIds = new Set(chunk.map((u) => u.id));
    const verifications: ChunkVerification[] = Array.isArray(out.verifications)
      ? out.verifications
          .filter((v: any) => typeof v?.id === 'string' && typeof v?.speaker === 'string' && chunkIds.has(v.id))
          .map((v: any) => ({
            id: v.id, speaker: v.speaker, corrected: Boolean(v.corrected),
            emotion: validDeliveryHint(v.emotion),
            reasoning: typeof v.reasoning === 'string' ? v.reasoning : undefined,
          }))
      : [];
    const coveredIds = verifications.map((v) => v.id);
    const newCharacters = Array.isArray(out.newCharacters)
      ? out.newCharacters
          .filter((c: any) => typeof c?.name === 'string' && c.name.trim())
          .map((c: any) => ({
            name: c.name.trim(),
            gender: ['male', 'female', 'neutral'].includes(c.gender) ? c.gender : 'neutral',
            age: ['child', 'young', 'adult', 'middle', 'elder'].includes(c.age) ? c.age : 'adult',
            description: typeof c.description === 'string' ? c.description : '',
            evidence: Array.isArray(c.evidence) ? c.evidence.filter((e: unknown): e is string => typeof e === 'string').slice(0, 4) : [],
          }))
      : [];
    const notes = Array.isArray(out.notes) ? out.notes.filter((n: unknown): n is string => typeof n === 'string').slice(0, 3) : [];
    return { verifications, coveredIds, newCharacters, notes };
  } catch {
    return { verifications: [], coveredIds: [], notes: ['Chunk verification failed'] };
  }
}

// ---------- AI speaker resolution for unresolved quotes ----------
// After rule attribution + chunk verification, quotes still attributed to the
// Narrator (and not marked as internal monologue) are the genuinely hard
// cases. This pass re-examines each against its surrounding lines — who spoke
// last, who replies, tags, pronouns, action beats — and assigns a real
// character whenever the conversational context supports one.

/** Cooperative pause/cancel hooks injected by the job queue so multi-hour
 * analyses can be paused and resumed. Every AI loop awaits these per batch. */
export interface PipelineControl {
  waitWhilePaused?: () => Promise<void>;
  shouldCancel?: () => boolean;
}

export interface SpeakerResolution {
  id: string;
  speaker: string;
  confidence?: 'high' | 'medium' | 'low';
  reasoning?: string;
}

/** A speaker label the AI invented that is not on the roster yet — either a
 * "The <Role>" descriptive name or a capitalised proper name. */
function plausibleNewSpeakerLabel(name: string): boolean {
  if (name.length < 3 || name.length > 28) return false;
  if (/^The\s+[A-Z][\w'-]*(\s+[A-Za-z][\w'-]*){0,2}$/.test(name)) return true;
  return /^[A-Z][\w'-]{1,20}(?:\s+[A-Z][\w'-]{1,20})?$/.test(name);
}

async function aiResolveSpeakers(
  generator: any,
  units: ScriptUnit[],
  unresolvedIdx: number[],
  roster: string[],
  control?: PipelineControl,
  onBatch?: (done: number, total: number) => void,
): Promise<SpeakerResolution[]> {
  const resolutions: SpeakerResolution[] = [];
  if (!unresolvedIdx.length) return resolutions;
  const canonicalRoster = new Map(roster.map((n) => [n.toLowerCase(), n]));

  // Group targets that sit close together so one prompt can reuse a single
  // shared context window (gap > 4 units starts a new prompt).
  const batches: number[][] = [];
  let current: number[] = [];
  for (const idx of unresolvedIdx) {
    if (current.length && (idx - current[current.length - 1] > 4 || current.length >= 8)) {
      batches.push(current);
      current = [];
    }
    current.push(idx);
  }
  if (current.length) batches.push(current);

  for (let bi = 0; bi < batches.length; bi++) {
    await control?.waitWhilePaused?.();
    if (control?.shouldCancel?.()) break;
    const batch = batches[bi];
    const firstIdx = batch[0];
    const lastIdx = batch[batch.length - 1];
    const { before, after } = surroundingUnitLines(units, firstIdx, lastIdx + 1);
    const targets = batch.map((i) => units[i]);
    const prompt = [
      'You are an expert at dialogue attribution in fiction. The lines below are quoted speech currently attributed to the Narrator because automation could not determine the speaker. Decide who actually speaks each one.',
      'CRITICAL: Never judge a line from the line alone. Reconstruct the conversation from the PREVIOUS LINES and COMING LINES: track turns (who spoke last and who would reply), dialogue tags, pronouns, and action beats touching each quote.',
      '  - In a two-person exchange, untagged quotes ALTERNATE between the two speakers unless a tag says otherwise.',
      '  - A quote right after a tag sandwich ("…", she said. "…") usually continues the SAME speaker; a rebuttal opener ("But …", "Why …", "How …") starts the OTHER speaker\'s turn.',
      '  - "she thought" / "he wondered" mark internal monologue — keep those as Narrator.',
      '  - Use a name from KNOWN CHARACTERS whenever the evidence points to them. For a clearly characterised but unnamed speaker use "The <Role>" (e.g. "The Other Girl", "The Innkeeper"). Answer "Narrator" only when the line is genuinely not character speech.',
      'Return ONLY valid JSON: {"resolutions":[{"id":"u0","speaker":"Name","confidence":"high|medium|low","reasoning":"one sentence"}]} — exactly one entry per TARGET id.',
      `KNOWN CHARACTERS: ${JSON.stringify(roster)}`,
      ...(before.length ? ['PREVIOUS LINES (context only):', ...before] : ['PREVIOUS LINES: (none — start of book)']),
      `TARGET LINES (resolve every one of these ${targets.length} ids):`,
      ...targets.map((u) => `  ${formatUnitLine(u)}`),
      ...(after.length ? ['COMING LINES (context only):', ...after] : ['COMING LINES: (none — end of book)']),
    ].join('\n');
    try {
      const raw = await generator(prompt, { max_new_tokens: 900, do_sample: false, return_full_text: false });
      const out = extractJson(raw) as Record<string, any> | null;
      const ids = new Set(targets.map((u) => u.id));
      if (out && Array.isArray(out.resolutions)) {
        for (const r of out.resolutions) {
          if (typeof r?.id !== 'string' || typeof r?.speaker !== 'string' || !ids.has(r.id)) continue;
          const cleaned = r.speaker.trim();
          const canonical = canonicalRoster.get(cleaned.toLowerCase());
          const speaker = canonical ?? (cleaned === 'Narrator' ? 'Narrator'
            : plausibleNewSpeakerLabel(cleaned) ? cleaned : null);
          if (!speaker) continue;
          resolutions.push({
            id: r.id, speaker,
            confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'medium',
            reasoning: typeof r.reasoning === 'string' ? r.reasoning.slice(0, 160) : undefined,
          });
        }
      }
    } catch { /* batch failed — leave those lines as Narrator */ }
    onBatch?.(bi + 1, batches.length);
  }
  return resolutions;
}

// ---------- AI character validation gate ----------
// The rule engine proposes candidate names from capitalized tokens; some are
// ordinary words ("Monday", "It", "Chapter"). The AI judges every candidate
// against its context evidence BEFORE any name enters the cast.

export interface AiCharacterVerdict {
  name: string;
  isCharacter: boolean;
  /** Canonical casing/spelling the AI prefers (may differ from candidate). */
  canonicalName?: string;
  /** If this candidate is an alias of another validated character. */
  mergeWith?: string;
  gender?: 'male' | 'female' | 'neutral';
  ageBand?: 'child' | 'young' | 'adult' | 'middle' | 'elder' | 'unknown';
  reason?: string;
}

interface AiValidationBatch {
  verdicts: AiCharacterVerdict[];
}

async function aiValidateCharacters(
  generator: any,
  candidates: { name: string; quotes: number; context: string }[],
  onProgress?: (done: number, total: number) => void,
  control?: PipelineControl,
): Promise<AiCharacterVerdict[]> {
  const BATCH = 10;
  const all: AiCharacterVerdict[] = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    await control?.waitWhilePaused?.();
    if (control?.shouldCancel?.()) break;
    const batch = candidates.slice(i, i + BATCH);
    const prompt = [
      'You are a literary analyst. A rule-based script generator proposed the following strings as CHARACTER NAMES for an audiobook.',
      'For EACH candidate, decide whether it is truly a named character in the story — reject ordinary words, places, dates, chapter words, and sentence fragments.',
      'CRITICAL: Judge each candidate from the SENTENCES AROUND its mentions (shown below — including the sentences before and after the name appears), never from the name string alone. A capitalised word is only a character if the surrounding narrative treats it as a person who acts, speaks, or is spoken to.',
      'If two candidates are aliases of the same person (e.g. "Elizabeth" and "Lizzy", or "Mr. Darcy" and "Darcy"), keep the fullest form and mark the other with mergeWith.',
      'Return ONLY valid JSON:',
      '{"verdicts":[{"name":"...","isCharacter":true,"canonicalName":"...","mergeWith":"...","gender":"male|female|neutral","ageBand":"child|young|adult|middle|elder","reason":"..."}]}.',
      'Include EVERY candidate exactly once. canonicalName is required when isCharacter is true.',
      'CANDIDATES (with surrounding-sentence context):',
      ...batch.map((c) => `  - "${c.name}" (${c.quotes} attributed quotes). Surrounding context: ${c.context.slice(0, 650)}`),
    ].join('\n');

    try {
      const raw = await generator(prompt, { max_new_tokens: 900, do_sample: false, return_full_text: false });
      const out = extractJson(raw) as AiValidationBatch | null;
      if (out && Array.isArray(out.verdicts)) {
        for (const v of out.verdicts) {
          if (typeof v?.name !== 'string') continue;
          all.push({
            name: v.name,
            isCharacter: Boolean(v.isCharacter),
            canonicalName: typeof v.canonicalName === 'string' && v.canonicalName.trim() ? v.canonicalName.trim() : undefined,
            mergeWith: typeof v.mergeWith === 'string' && v.mergeWith.trim() ? v.mergeWith.trim() : undefined,
            gender: (['male', 'female', 'neutral'].includes(v.gender as string) ? v.gender : undefined) as AiCharacterVerdict['gender'],
            ageBand: (['child', 'young', 'adult', 'middle', 'elder', 'unknown'].includes(v.ageBand as string) ? v.ageBand : undefined) as AiCharacterVerdict['ageBand'],
            reason: typeof v.reason === 'string' ? v.reason : undefined,
          });
        }
      } else {
        // parse failed — accept the batch unchanged rather than silently dropping names
        for (const c of batch) all.push({ name: c.name, isCharacter: true, canonicalName: c.name, reason: 'AI validation parse failed — kept' });
      }
    } catch {
      for (const c of batch) all.push({ name: c.name, isCharacter: true, canonicalName: c.name, reason: 'AI validation failed — kept' });
    }
    onProgress?.(Math.min(i + BATCH, candidates.length), candidates.length);
  }
  return all;
}

// ---------- Full-cast AI builder ----------

interface AiCastMember {
  name: string;
  gender: 'male' | 'female' | 'neutral';
  ageBand: 'child' | 'young' | 'adult' | 'middle' | 'elder' | 'unknown';
  role: 'major' | 'minor';
  physicalDescription: string;
  personalityTraits: string[];
  voiceDescription: string;
  evidence: string[];
  quoteCount: number;
}

interface AiCastResult {
  cast: AiCastMember[];
  narratorStyle: string;
  notes: string[];
}

async function aiBuildCastFromFullText(
  generator: any,
  text: string,
  baselineCast: BookCastMember[],
  baselineUnits: ScriptUnit[],
): Promise<AiCastResult> {
  const quoteCounts = new Map<string, number>();
  for (const u of baselineUnits) {
    if (u.kind === 'dialogue' && u.speaker !== 'Narrator') {
      quoteCounts.set(u.speaker, (quoteCounts.get(u.speaker) ?? 0) + 1);
    }
  }
  const samples: string[] = [];
  const chunkLen = Math.min(6000, Math.max(3000, Math.floor(text.length / 4)));
  for (let i = 0; i < text.length && samples.length < 4; i += chunkLen) {
    samples.push(text.slice(i, i + chunkLen));
  }
  const prompt = [
    'You are a literary casting director. From the text samples, build a complete character roster for an audiobook.',
    'For EACH character, determine: gender, age band, physical description, personality traits, and a VOICE DESCRIPTION (e.g. "warm gravelly baritone, speaks slowly").',
    'Also describe the narrator style.',
    'Return ONLY valid JSON:',
    '{"cast":[{"name":"...","gender":"male|female|neutral","ageBand":"child|young|adult|middle|elder","role":"major|minor","physicalDescription":"...","personalityTraits":["..."],"voiceDescription":"...","evidence":["..."],"quoteCount":0}],"narratorStyle":"...","notes":["..."]}.',
    'Only include characters who actually speak. The Narrator is handled separately.',
    `KNOWN SPEAKERS FROM DRAFT: ${JSON.stringify([...quoteCounts.entries()].map(([n, c]) => ({ name: n, quotes: c })))}`,
    ...samples.map((s, i) => `SAMPLE ${i + 1}:\n${s.slice(0, 2500)}`),
  ].join('\n\n');

  try {
    const raw = await generator(prompt, { max_new_tokens: 1600, do_sample: false, return_full_text: false });
    const out = extractJson(raw) as Record<string, any> | null;
    if (!out || typeof out !== 'object') return { cast: [], narratorStyle: '', notes: ['Cast build failed'] };
    const cast = Array.isArray(out.cast)
      ? out.cast
          .filter((c: any) => typeof c?.name === 'string' && c.name.trim() && c.name !== 'Narrator')
          .map((c: any) => ({
            name: c.name.trim(),
            gender: (['male', 'female', 'neutral'].includes(c.gender) ? c.gender : 'neutral') as AiCastMember['gender'],
            ageBand: (['child', 'young', 'adult', 'middle', 'elder', 'unknown'].includes(c.ageBand) ? c.ageBand : 'unknown') as AiCastMember['ageBand'],
            role: (['major', 'minor'].includes(c.role) ? c.role : 'minor') as AiCastMember['role'],
            physicalDescription: typeof c.physicalDescription === 'string' ? c.physicalDescription : '',
            personalityTraits: Array.isArray(c.personalityTraits) ? c.personalityTraits.filter((t: unknown): t is string => typeof t === 'string').slice(0, 5) : [],
            voiceDescription: typeof c.voiceDescription === 'string' ? c.voiceDescription : '',
            evidence: Array.isArray(c.evidence) ? c.evidence.filter((e: unknown): e is string => typeof e === 'string').slice(0, 4) : [],
            quoteCount: typeof c.quoteCount === 'number' ? c.quoteCount : (quoteCounts.get(c.name.trim()) ?? 0),
          }))
      : [];
    for (const member of cast) {
      if (!member.quoteCount) member.quoteCount = quoteCounts.get(member.name) ?? 0;
    }
    return {
      cast,
      narratorStyle: typeof out.narratorStyle === 'string' ? out.narratorStyle : '',
      notes: Array.isArray(out.notes) ? out.notes.filter((n: unknown): n is string => typeof n === 'string').slice(0, 5) : [],
    };
  } catch {
    return { cast: [], narratorStyle: '', notes: ['Cast build failed'] };
  }
}

// ---------- AI voice assignment ----------

interface AiVoiceAssignment {
  profileId: string;
  rate: number;
  pitch: number;
  rationale: string;
}

async function aiAssignVoice(
  generator: any,
  character: AiCastMember,
  availableProfiles: { id: string; name: string; description: string; gender: string }[],
): Promise<AiVoiceAssignment> {
  const prompt = [
    'You are a voice casting director. Choose the best voice profile for this character.',
    'Return ONLY valid JSON: {"profileId":"...","rate":0.8..1.2,"pitch":0.85..1.3,"rationale":"..."}.',
    `CHARACTER: ${JSON.stringify({ name: character.name, voiceDescription: character.voiceDescription, gender: character.gender, age: character.ageBand, personality: character.personalityTraits.join(', ') })}`,
    `AVAILABLE PROFILES: ${JSON.stringify(availableProfiles)}`,
  ].join('\n');

  try {
    const raw = await generator(prompt, { max_new_tokens: 250, do_sample: false, return_full_text: false });
    const out = extractJson(raw) as Record<string, any> | null;
    if (!out || typeof out !== 'object' || typeof out.profileId !== 'string') throw new Error('No assignment');
    return {
      profileId: out.profileId,
      rate: Math.max(0.8, Math.min(1.2, Number(out.rate) || 1.0)),
      pitch: Math.max(0.85, Math.min(1.3, Number(out.pitch) || 1.0)),
      rationale: typeof out.rationale === 'string' ? out.rationale : `AI-assigned ${out.profileId}`,
    };
  } catch {
    const meta = inferCharacterMeta(character.name, []);
    const assignment = castVoiceFor(
      withRole({ ...meta, gender: character.gender, ageBand: character.ageBand, role: character.role, evidence: character.evidence }, character.role),
      availableProfiles as VoiceProfileDef[],
      new Set(),
    );
    return {
      profileId: assignment.profileId,
      rate: assignment.rate,
      pitch: assignment.pitch,
      rationale: `${assignment.rationale} (AI voice assignment failed — rule fallback)`,
    };
  }
}

// ---------- Script refinement ----------

interface ScriptRefinement {
  id: string;
  text?: string;
  emotionHint?: ScriptUnit['emotionHint'];
  note?: string;
}

async function aiRefineScriptChunk(
  generator: any,
  units: ScriptUnit[],
  startIdx: number,
  endIdx: number,
): Promise<ScriptRefinement[]> {
  const chunk = units.slice(startIdx, endIdx).filter((u) => u.kind === 'narration');
  if (chunk.length < 2) return [];
  const { before, after } = surroundingUnitLines(units, startIdx, endIdx);
  const prompt = [
    'You are an audiobook editor. Refine these narration passages for spoken delivery.',
    'CRITICAL: Never refine a passage from the passage alone. Read the PREVIOUS LINES and COMING LINES to understand the scene flow — a pronoun like "he" or "she" must resolve to whoever the surrounding sentences establish, and the emotional tone must carry over from what came before and lead into what comes next.',
    'You may: expand abbreviations, clarify ambiguous pronouns using the surrounding context, smooth awkward phrasing, adjust emotion hints to fit the scene flow.',
    'You may NOT: change meaning, delete content, alter dialogue quotes, or return refinements for context lines.',
    'Return ONLY valid JSON: [{"id":"u0","text":"refined text","emotionHint":"soft","note":"why"}].',
    'Only include units from the TARGET PASSAGES section that you actually changed.',
    ...(before.length ? ['PREVIOUS LINES (context only — do NOT refine these):', ...before] : ['PREVIOUS LINES: (none — start of book)']),
    'TARGET PASSAGES:',
    ...chunk.map((u) => `  ${u.id}: "${u.text.slice(0, 200)}${u.text.length > 200 ? '...' : ''}"`),
    ...(after.length ? ['COMING LINES (context only — do NOT refine these):', ...after] : ['COMING LINES: (none — end of book)']),
  ].join('\n');

  try {
    const raw = await generator(prompt, { max_new_tokens: 800, do_sample: false, return_full_text: false });
    const out = extractJson(raw) as any[] | null;
    if (!Array.isArray(out)) return [];
    return out
      .filter((r: any) => typeof r?.id === 'string')
      .map((r: any) => ({
        id: r.id,
        text: typeof r.text === 'string' ? r.text : undefined,
        emotionHint: validDeliveryHint(r.emotionHint),
        note: typeof r.note === 'string' ? r.note : undefined,
      }))
      .filter((r: ScriptRefinement) => r.text || r.emotionHint);
  } catch {
    return [];
  }
}

// ---------- ZIP export types & helper ----------

export interface ZipExportPayload {
  audioBlob?: Blob;
  videoBlob?: Blob;
  scriptText: string;
  subtitleSrt: string;
  metadata: {
    title: string;
    author?: string;
    genre: string;
    confidence: number;
    words: number;
    estMinutes: number;
    speakers: number;
    aiModel?: string;
    aiNotes?: string[];
    cast: { name: string; gender: string; ageBand: string; voice: string; rationale: string }[];
  };
}

async function crc32(bytes: Uint8Array): Promise<number> {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (const b of bytes) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dateToDos(date: Date): { time: number; date: number } {
  return {
    time: (date.getSeconds() >> 1) | (date.getMinutes() << 5) | (date.getHours() << 11),
    date: date.getDate() | ((date.getMonth() + 1) << 5) | ((date.getFullYear() - 1980) << 9),
  };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as unknown as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) throw new Error('CompressionStream not supported');
  const ds = new CS('deflate-raw');
  const writer = ds.writable.getWriter();
  await writer.write(data as unknown as BufferSource);
  await writer.close();
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export async function createAudiobookZip(payload: ZipExportPayload, onProgress?: (p: number) => void): Promise<Blob> {
  const encoder = new TextEncoder();
  const entries: { name: string; data: Uint8Array; compressed: boolean }[] = [];

  const scriptBytes = encoder.encode(payload.scriptText);
  entries.push({ name: 'script.txt', data: scriptBytes, compressed: true });
  onProgress?.(0.1);

  const srtBytes = encoder.encode(payload.subtitleSrt);
  entries.push({ name: 'subtitles.srt', data: srtBytes, compressed: true });
  onProgress?.(0.2);

  const metaBytes = encoder.encode(JSON.stringify(payload.metadata, null, 2));
  entries.push({ name: 'metadata.json', data: metaBytes, compressed: true });
  onProgress?.(0.3);

  if (payload.audioBlob) {
    const audioBytes = new Uint8Array(await payload.audioBlob.arrayBuffer());
    entries.push({ name: `audiobook.${payload.audioBlob.type.includes('wav') ? 'wav' : 'mp3'}`, data: audioBytes, compressed: false });
  }
  onProgress?.(0.5);

  if (payload.videoBlob) {
    const videoBytes = new Uint8Array(await payload.videoBlob.arrayBuffer());
    entries.push({ name: `videobook.${payload.videoBlob.type.includes('mp4') ? 'mp4' : 'webm'}`, data: videoBytes, compressed: false });
  }
  onProgress?.(0.6);

  const parts: Uint8Array[] = [];
  const cdRecords: Uint8Array[] = [];
  let currentOffset = 0;
  const now = new Date();
  const dos = dateToDos(now);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const nameBytes = encoder.encode(entry.name);
    let data = entry.data;
    let method = 0;
    let compressed = data;
    let crc = await crc32(data);

    if (entry.compressed && data.length > 0) {
      try {
        compressed = await deflateRaw(data);
        method = 8;
      } catch {
        compressed = data;
        method = 0;
      }
    }

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, dos.time, true);
    lv.setUint16(12, dos.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, dos.time, true);
    cv.setUint16(14, dos.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, currentOffset, true);
    central.set(nameBytes, 46);

    parts.push(local);
    parts.push(compressed);
    cdRecords.push(central);
    currentOffset += local.length + compressed.length;
  }

  const cdOffset = currentOffset;
  for (const cd of cdRecords) parts.push(cd);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdRecords.reduce((a, c) => a + c.length, 0), true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);
  parts.push(eocd);

  const total = parts.reduce((a, p) => a + p.length, 0);
  const zip = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { zip.set(p, off); off += p.length; }

  onProgress?.(1);
  return new Blob([zip], { type: 'application/zip' });
}

// ---------- Main orchestration: AI-first build ----------

/** Pipeline stage markers for checkpoint resume: the stage to RUN next. */
type AutobookCheckpointStage = 'verify' | 'resolve' | 'validate' | 'cast' | 'voices' | 'refine';

/** Complete resumable snapshot of the AI pipeline's intermediate state. */
interface AutobookCheckpointState {
  stage: AutobookCheckpointStage;
  globalAi?: LocalAiEnhancement;
  /** STEP 2 loop position + accumulated results. */
  verifyNextChunk: number;
  verifications: Record<string, ChunkVerification>;
  coveredIds: string[];
  newCharacters: AiCastMember[];
  chunkNotes: string[];
  failedChunks: number;
  /** Units snapshot as of the last completed stage boundary. */
  unitsSnapshot?: ScriptUnit[];
  /** STEP 3a verdicts (once computed). */
  verdicts?: AiCharacterVerdict[];
  /** STEP 3b cast result (once computed). */
  aiCast?: AiCastResult;
  /** STEP 4 assignments keyed by normalised character name. */
  voiceAssignments?: Record<string, AiVoiceAssignment>;
  /** STEP 5 loop position. */
  refineNextChunk?: number;
}

export async function buildAudiobookScriptWithAI(
  text: string,
  profiles: VoiceProfileDef[],
  opts?: AutobookOptions & { modelId?: string; onProgress?: AiProgress['onProgress']; control?: PipelineControl },
): Promise<AutobookResult> {
  const onProgress = opts?.onProgress;
  const control = opts?.control;

  // STEP 0: Build rule-based DRAFT
  onProgress?.(0.05, 'Building draft script with rules…');
  const draft = buildAudiobookScript(text, profiles, opts);
  if (!text.trim() || draft.units.length === 0) return draft;

  const deep = useAppStore.getState().settings.aiAssist && useAppStore.getState().settings.aiDepth !== 'light';
  const modelId = opts?.modelId ?? useAppStore.getState().settings.localAiModelId;

  // Check AI availability. A missing local model is not an immediate fallback:
  // createGenerator() uses the model registry's Hugging Face source for a
  // one-time browser download, then runs inference locally from its cache.
  const { getLocalAIStatus, createGenerator } = await import('@/lib/engines/local-ai');
  const { getLocalAiModel } = await import('@/lib/data/local-ai-models');
  const status = await getLocalAIStatus(modelId);

  if (!status.ready) {
    onProgress?.(
      0.06,
      `${status.modelName} not installed — downloading ~${status.sizeMB} MB from Hugging Face…`,
    );
  }

  // Load generator — this is the ONLY point where we fall back to rule-based.
  // If the model loads (even on CPU/WASM), we commit to running the full AI pipeline.
  onProgress?.(
    0.08,
    status.ready
      ? `Loading ${status.modelName}…`
      : `Downloading ${status.modelName}…`,
  );
  let generator: any;
  try {
    const model = getLocalAiModel(modelId);
    generator = await createGenerator(model, {
      onProgress: (p, message) => onProgress?.(0.08 + p * 0.06, message),
    });
  } catch (err: any) {
    onProgress?.(1, `Model failed to load (${err?.message || 'unknown'}) — using rule-based draft`);
    return {
      ...draft,
      ai: {
        enabled: false, modelId, modelName: 'Rule-based draft (model load failed)',
        reviewedDialogue: 0, totalUnits: 0, coverage: 0,
        notes: [`AI model could not load: ${err?.message || 'unknown'}`, 'Rule-based AutoBook produced this draft instead.'],
      },
    };
  }

  // From here on, the model IS loaded. Every step below has its own try-catch.
  // Individual failures are logged but never abort the pipeline — the AI runs on
  // CPU if GPU is missing, and even if a single chunk times out, the rest continue.

  // ---------- checkpoint resume ----------
  // The pipeline saves its full intermediate state to IndexedDB after every
  // chunk. Same book + same model + same settings → same key → resume
  // instead of restart, even across browser restarts (multi-day CPU runs).
  const checkpointKey = autobookCheckpointKey({ text, modelId, deep, genre: opts?.genre, maxCast: opts?.maxCast });
  const bookLabel = opts?.fileContext?.fileName;
  const savedCp = await loadAutobookCheckpoint<AutobookCheckpointState>(checkpointKey);
  const cp = savedCp?.state ?? null;
  const resumedFromCheckpoint = !!cp;
  const resumeStage: AutobookCheckpointStage | null = cp?.stage ?? null;
  if (cp) {
    onProgress?.(0.10, `AI: resuming saved analysis (stage: ${cp.stage}, saved ${new Date(savedCp!.updatedAt).toLocaleString()})…`);
  }
  /** Persist the full checkpoint state — call sites pass every field so the
   * saved record is always complete and independently resumable. */
  const persist = (stage: AutobookCheckpointStage, state: AutobookCheckpointState, progress: number) =>
    saveAutobookCheckpoint(checkpointKey, { ...state, stage }, { label: bookLabel, stage, progress });

  // STEP 1: Deep global analysis
  onProgress?.(0.12, 'AI: analyzing book structure and genre…');
  let globalAi: LocalAiEnhancement | undefined = cp?.globalAi;
  try {
    if (!globalAi) {
      globalAi = await analyzeWithLocalAI(text, draft, {
        modelId, fileContext: opts?.fileContext, deep,
        onProgress: (p, m) => onProgress?.(0.12 + p * 0.18, m),
      });
    }
  } catch (e: any) {
    onProgress?.(0.30, `AI global analysis skipped: ${e?.message || 'error'}`);
  }

  // STEP 2: Chunk-by-chunk script verification across EVERY line of the book
  onProgress?.(0.30, 'AI: verifying every line of the script…');
  const allVerifications = new Map<string, ChunkVerification>(Object.entries(cp?.verifications ?? {}));
  const coveredIds = new Set<string>(cp?.coveredIds ?? []);
  const allNewCharacters: AiCastMember[] = cp?.newCharacters ?? [];
  const chunkNotes: string[] = cp?.chunkNotes ?? [];
  let failedChunks = cp?.failedChunks ?? 0;

  const speakableUnits = draft.units.filter((u) => u.kind !== 'skip');
  const lightAi = !deep;
  const activeChunkSize = lightAi ? LIGHT_CHUNK_SIZE : CHUNK_SIZE;
  const activeMaxNewTokens = lightAi ? LIGHT_VERIFY_TOKENS : 1600;
  const totalChunks = Math.ceil(speakableUnits.length / activeChunkSize);
  // Resume mid-verify where the checkpoint stopped; a checkpoint past the
  // verify stage means the loop is already complete.
  const verifyStart = !cp ? 0 : cp.stage === 'verify' ? Math.min(cp.verifyNextChunk, totalChunks) : totalChunks;

  let cancelledMidPipeline = false;
  for (let ci = verifyStart; ci < totalChunks; ci++) {
    await control?.waitWhilePaused?.();
    if (control?.shouldCancel?.()) { cancelledMidPipeline = true; break; }
    const startIdx = ci * activeChunkSize;
    const endIdx = Math.min(startIdx + activeChunkSize, speakableUnits.length);
    try {
      const chunkResult = await verifyChunk(
        generator, text, speakableUnits, startIdx, endIdx,
        draft.cast.filter((c) => c.name !== 'Narrator').map((c) => c.name),
        activeMaxNewTokens,
        lightAi ? 2 : CONTEXT_UNITS,
      );
      for (const v of chunkResult.verifications) allVerifications.set(v.id, v);
      for (const id of chunkResult.coveredIds) coveredIds.add(id);
      if (chunkResult.newCharacters) {
        for (const nc of chunkResult.newCharacters) {
          if (!allNewCharacters.find((c) => normaliseName(c.name) === normaliseName(nc.name))) {
            allNewCharacters.push({
              name: nc.name, gender: nc.gender as AiCastMember['gender'],
              ageBand: nc.age as AiCastMember['ageBand'], role: 'minor',
              physicalDescription: '', personalityTraits: [], voiceDescription: '',
              evidence: nc.evidence, quoteCount: 0,
            });
          }
        }
      }
      chunkNotes.push(...chunkResult.notes);
      onProgress?.(0.30 + (ci + 1) / Math.max(1, totalChunks) * 0.25,
        `AI: line check ${Math.min(endIdx, speakableUnits.length)}/${speakableUnits.length} (${coveredIds.size} confirmed)`);
    } catch (e: any) {
      failedChunks++;
      chunkNotes.push(`Chunk ${ci + 1} failed: ${e?.message || 'unknown'}`);
      onProgress?.(0.30 + (ci + 1) / Math.max(1, totalChunks) * 0.25,
        `AI: chunk ${ci + 1}/${totalChunks} failed (${e?.message || 'error'}) — continuing`);
    }
    // Checkpoint after EVERY chunk — a days-long run must never lose work.
    await persist('verify', {
      stage: 'verify', globalAi, verifyNextChunk: ci + 1,
      verifications: Object.fromEntries(allVerifications), coveredIds: [...coveredIds],
      newCharacters: allNewCharacters, chunkNotes, failedChunks,
    }, 0.30 + (ci + 1) / Math.max(1, totalChunks) * 0.25);
    // Give the browser a macrotask between chunks so progress can paint even
    // when the surrounding job queue is busy.
    await yieldToUI();
  }
  if (cancelledMidPipeline) {
    await persist('verify', {
      stage: 'verify', globalAi, verifyNextChunk: Math.max(verifyStart, Math.min(totalChunks, allVerifications.size ? verifyStart + Math.ceil(coveredIds.size / CHUNK_SIZE) : verifyStart)),
      verifications: Object.fromEntries(allVerifications), coveredIds: [...coveredIds],
      newCharacters: allNewCharacters, chunkNotes, failedChunks,
    }, 0.30);
    onProgress?.(0.30, 'AI: paused/cancelled — progress saved, re-run to resume');
  }

  // Apply chunk corrections (or restore the post-verify snapshot when the
  // checkpoint shows the verify loop already finished).
  let units: ScriptUnit[];
  if (cp?.unitsSnapshot && cp.stage !== 'verify') {
    units = cp.unitsSnapshot.map((u) => ({ ...u }));
  } else {
    units = draft.units.map((u) => {
      const v = allVerifications.get(u.id);
      if (!v) return { ...u };
      return { ...u, speaker: v.speaker, emotionHint: v.emotion ?? u.emotionHint };
    });
  }

  // STEP 2b: Resolve leftover Narrator-attributed quotes. The rules and the
  // per-chunk verification leave genuinely ambiguous quotes with the Narrator;
  // this pass reasons about turn-taking from the surrounding lines to give
  // them a real speaker. Internal monologue (soft) stays with the Narrator.
  const rosterForResolution = [...new Set([
    ...draft.cast.filter((c) => c.name !== 'Narrator').map((c) => c.name),
    ...allNewCharacters.map((c) => c.name),
  ])];
  const unresolvedIdx = units
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.kind === 'dialogue' && u.speaker === 'Narrator' && u.emotionHint !== 'soft')
    .map(({ i }) => i);
  let speakersResolved = 0;
  const runResolve = !resumeStage || resumeStage === 'verify' || resumeStage === 'resolve';
  // Checkpoint the post-verify state so a resume re-runs only what remains.
  if (!cancelledMidPipeline && resumeStage !== 'validate' && resumeStage !== 'cast' && resumeStage !== 'voices' && resumeStage !== 'refine') {
    await persist('resolve', {
      stage: 'resolve', globalAi, verifyNextChunk: totalChunks,
      verifications: Object.fromEntries(allVerifications), coveredIds: [...coveredIds],
      newCharacters: allNewCharacters, chunkNotes, failedChunks, unitsSnapshot: units,
    }, 0.555);
  }
  const preResolveUnits = units;
  if (!cancelledMidPipeline && runResolve && unresolvedIdx.length) {
    onProgress?.(0.555, `AI: resolving ${unresolvedIdx.length} ambiguous speaker lines…`);
    const resolutions = await aiResolveSpeakers(generator, units, unresolvedIdx, rosterForResolution, control,
      (done, total) => onProgress?.(0.555 + (done / Math.max(1, total)) * 0.045, `AI: speaker resolution batch ${done}/${total}`));
    if (control?.shouldCancel?.()) cancelledMidPipeline = true;
    const byId = new Map(resolutions.map((r) => [r.id, r]));
    units = units.map((u) => {
      const r = byId.get(u.id);
      if (!r || r.speaker === 'Narrator') return u;
      speakersResolved++;
      // A label the AI invented enters the character pipeline so the cast and
      // validation gate downstream see it like any rule-discovered name.
      if (!rosterForResolution.some((n) => normaliseName(n) === normaliseName(r.speaker))
        && !allNewCharacters.find((c) => normaliseName(c.name) === normaliseName(r.speaker))) {
        allNewCharacters.push({
          name: r.speaker, gender: 'neutral', ageBand: 'adult', role: 'minor',
          physicalDescription: '', personalityTraits: [], voiceDescription: '',
          evidence: r.reasoning ? [r.reasoning] : [], quoteCount: 0,
        });
      }
      return { ...u, speaker: r.speaker };
    });
  }
  // Persist after speaker resolution: cancelled → resume re-runs resolution
  // from the pre-resolution units; completed → resume skips straight to 3a.
  if (runResolve) {
    await persist(cancelledMidPipeline ? 'resolve' : 'validate', {
      stage: cancelledMidPipeline ? 'resolve' : 'validate', globalAi,
      verifyNextChunk: totalChunks,
      verifications: Object.fromEntries(allVerifications), coveredIds: [...coveredIds],
      newCharacters: allNewCharacters, chunkNotes, failedChunks,
      unitsSnapshot: cancelledMidPipeline ? preResolveUnits : units,
    }, 0.6);
  }

  // STEP 3a: AI validates EVERY candidate character name before casting.
  // Rule-discovered + AI-discovered names all pass through the gate; ordinary
  // words the rules mistook for names are rejected here, and aliases merged.
  onProgress?.(0.57, 'AI: validating character roster…');
  const quoteCountsPre = new Map<string, number>();
  for (const u of units) {
    if (u.kind === 'dialogue' && u.speaker !== 'Narrator' && u.speaker !== '(skipped)') {
      quoteCountsPre.set(u.speaker, (quoteCountsPre.get(u.speaker) ?? 0) + 1);
    }
  }
  const candidates = [...quoteCountsPre.entries()].map(([name, quotes]) => ({
    name, quotes,
    // Sentences BEFORE and AFTER each mention — the AI judges the name in
    // its narrative context, not in isolation.
    context: extractNameContextWindows(text, name),
  }));
  const runValidate = !resumeStage || resumeStage === 'verify' || resumeStage === 'resolve' || resumeStage === 'validate';
  const verdicts = cp?.verdicts ?? (cancelledMidPipeline ? [] : await aiValidateCharacters(generator, candidates,
    (done, total) => onProgress?.(0.57 + (done / Math.max(1, total)) * 0.05, `AI: validated ${done}/${total} character names`),
    control));
  if (control?.shouldCancel?.()) cancelledMidPipeline = true;

  const rejectedNames = new Set(verdicts.filter((v) => !v.isCharacter).map((v) => normaliseName(v.name)));
  const mergeMap = new Map<string, string>(); // normalised alias → canonical display name
  const aiApproved = new Map<string, AiCharacterVerdict>();
  for (const v of verdicts) {
    if (!v.isCharacter) continue;
    const canonical = v.canonicalName ?? v.name;
    if (v.mergeWith) {
      mergeMap.set(normaliseName(v.name), v.mergeWith);
    } else {
      aiApproved.set(normaliseName(canonical), { ...v, name: canonical });
      mergeMap.set(normaliseName(v.name), canonical);
    }
  }
  // resolve merge chains ("Lizzy" → "Elizabeth Bennet" if AI said so)
  for (const [alias, target] of [...mergeMap]) {
    const deeper = mergeMap.get(normaliseName(target));
    if (deeper && normaliseName(deeper) !== alias) mergeMap.set(alias, deeper);
  }

  // Apply the gate to the script: rejected names and aliases are re-attributed.
  units = units.map((u) => {
    if (u.kind !== 'dialogue' || u.speaker === 'Narrator' || u.speaker === '(skipped)') return u;
    const key = normaliseName(u.speaker);
    if (rejectedNames.has(key)) return { ...u, speaker: 'Narrator', emotionHint: undefined };
    const merged = mergeMap.get(key);
    if (merged && merged !== u.speaker) return { ...u, speaker: merged };
    return u;
  });

  // Persist after the validation gate — verdicts are only stored when the
  // validation loop COMPLETED, so a cancelled run re-validates on resume.
  if (runValidate) {
    await persist(cancelledMidPipeline ? 'validate' : 'cast', {
      stage: cancelledMidPipeline ? 'validate' : 'cast', globalAi,
      verifyNextChunk: totalChunks,
      verifications: Object.fromEntries(allVerifications), coveredIds: [...coveredIds],
      newCharacters: allNewCharacters, chunkNotes, failedChunks,
      unitsSnapshot: units,
      verdicts: cancelledMidPipeline ? undefined : verdicts,
    }, 0.63);
  }

  // STEP 3b: AI builds complete cast from full-text evidence (validated names only)
  onProgress?.(0.63, 'AI: building cast from full-text evidence…');
  let aiCast: AiCastResult = cp?.aiCast ?? { cast: [], narratorStyle: '', notes: [] };
  try {
    if (!cancelledMidPipeline && !cp?.aiCast) aiCast = await aiBuildCastFromFullText(generator, text, draft.cast, units);
  } catch (e: any) {
    aiCast.notes.push(`Cast build failed: ${e?.message || 'unknown'}`);
    onProgress?.(0.65, `AI cast build failed (${e?.message || 'error'}) — using validated roster`);
  }
  if (control?.shouldCancel?.()) cancelledMidPipeline = true;
  if (!cancelledMidPipeline) {
    await persist('voices', {
      stage: 'voices', globalAi, verifyNextChunk: totalChunks,
      verifications: Object.fromEntries(allVerifications), coveredIds: [...coveredIds],
      newCharacters: allNewCharacters, chunkNotes, failedChunks,
      unitsSnapshot: units, verdicts, aiCast,
    }, 0.7);
  }

  // Merge: AI-cast members + AI-validated roster names + AI chunk discoveries.
  // Rule-only names that the AI rejected never enter the cast.
  const combinedCastMap = new Map<string, AiCastMember>();
  for (const c of aiCast.cast) {
    if (rejectedNames.has(normaliseName(c.name))) continue;
    combinedCastMap.set(normaliseName(c.name), c);
  }
  for (const [key, v] of aiApproved) {
    if (!combinedCastMap.has(key)) {
      combinedCastMap.set(key, {
        name: v.canonicalName ?? v.name,
        gender: v.gender ?? 'neutral',
        ageBand: v.ageBand ?? 'unknown',
        role: 'minor',
        physicalDescription: '', personalityTraits: [], voiceDescription: '',
        evidence: v.reason ? [v.reason] : [], quoteCount: 0,
      });
    }
  }
  for (const nc of allNewCharacters) {
    const key = normaliseName(nc.name);
    if (!rejectedNames.has(key) && !combinedCastMap.has(key)) combinedCastMap.set(key, nc);
  }
  for (const u of units) {
    if (u.kind === 'dialogue' && u.speaker !== 'Narrator') {
      const key = normaliseName(u.speaker);
      if (rejectedNames.has(key)) continue;
      if (!combinedCastMap.has(key)) {
        const meta = inferCharacterMeta(u.speaker, []);
        combinedCastMap.set(key, {
          name: u.speaker, gender: meta.gender, ageBand: meta.ageBand, role: 'minor',
          physicalDescription: '', personalityTraits: [], voiceDescription: '',
          evidence: meta.evidence, quoteCount: 0,
        });
      }
      const entry = combinedCastMap.get(key)!;
      entry.quoteCount = (entry.quoteCount ?? 0) + 1;
    }
  }

  // STEP 4: AI assigns voices to each character — resumable: assignments are
  // checkpointed one by one, so a resume only voices the remaining cast.
  onProgress?.(0.72, 'AI: assigning voices by character description…');
  const availableProfiles = profiles.map((p) => ({ id: p.id, name: p.name, description: p.description, gender: p.gender }));
  const assigned = new Set<string>();
  const castMembers: BookCastMember[] = [];
  const voiceAssignments = new Map<string, AiVoiceAssignment>(Object.entries(cp?.voiceAssignments ?? {}));

  for (const [, character] of combinedCastMap) {
    if (character.quoteCount < 1 && character.role === 'minor') continue;
    await control?.waitWhilePaused?.();
    if (control?.shouldCancel?.()) { cancelledMidPipeline = true; break; }
    const charKey = normaliseName(character.name);
    let voice: AiVoiceAssignment | undefined = voiceAssignments.get(charKey);
    const voiceFromAi = !voice;
    if (!voice) {
      try {
        voice = await aiAssignVoice(generator, character, availableProfiles);
      } catch {
        const meta = inferCharacterMeta(character.name, []);
        const fallback = castVoiceFor(
          withRole({ ...meta, name: character.name, gender: character.gender, ageBand: character.ageBand, role: character.role, evidence: character.evidence }, character.role),
          profiles, assigned,
        );
        voice = { profileId: fallback.profileId, rate: fallback.rate, pitch: fallback.pitch, rationale: fallback.rationale };
      }
      voiceAssignments.set(charKey, voice);
      // Checkpoint after every voice — but only AI-derived ones; rule
      // fallbacks are recomputed on resume so a transient AI failure retries.
      if (voiceFromAi) {
        await persist('voices', {
          stage: 'voices', globalAi, verifyNextChunk: totalChunks,
          verifications: Object.fromEntries(allVerifications), coveredIds: [...coveredIds],
          newCharacters: allNewCharacters, chunkNotes, failedChunks,
          unitsSnapshot: units, verdicts, aiCast,
          voiceAssignments: Object.fromEntries(voiceAssignments),
        }, 0.72);
      }
    }
    assigned.add(voice.profileId);
    castMembers.push({
      name: character.name,
      meta: {
        name: character.name,
        gender: character.gender, ageBand: character.ageBand, role: character.role,
        evidence: [...character.evidence, `AI voice: ${character.voiceDescription || 'no description'}`].slice(0, 7),
      },
      profileId: voice.profileId,
      rate: voice.rate,
      pitch: voice.pitch,
      rationale: `${voice.rationale} · AI cast: ${character.physicalDescription || 'no physical description'} · ${character.personalityTraits.join(', ') || 'no personality traits'}`,
    });
  }

  // Add Narrator
  castMembers.unshift({
    name: 'Narrator',
    meta: { name: 'Narrator', gender: 'neutral', ageBand: 'adult', role: 'major', evidence: ['Default narrator'] },
    profileId: 'samantha',
    rate: 1.0, pitch: 1.0,
    rationale: aiCast.narratorStyle ? `AI narrator style: ${aiCast.narratorStyle}` : 'Default narrator voice',
  });

  // Normalize speakers to canonical names
  const canonical = new Map<string, string>();
  for (const c of castMembers) canonical.set(normaliseName(c.name), c.name);
  for (const u of units) {
    if (u.speaker !== 'Narrator' && u.speaker !== '(skipped)') {
      u.speaker = canonical.get(normaliseName(u.speaker)) ?? u.speaker;
    }
  }

  // Checkpoint the post-cast state — refinement resumes chunk-by-chunk.
  if (!cancelledMidPipeline && resumeStage !== 'refine') {
    await persist('refine', {
      stage: 'refine', globalAi, verifyNextChunk: totalChunks,
      verifications: Object.fromEntries(allVerifications), coveredIds: [...coveredIds],
      newCharacters: allNewCharacters, chunkNotes, failedChunks,
      unitsSnapshot: units, verdicts, aiCast,
      voiceAssignments: Object.fromEntries(voiceAssignments), refineNextChunk: 0,
    }, 0.8);
  }

  // STEP 5: AI refines narration in chunks
  if (deep && !cancelledMidPipeline) {
    onProgress?.(0.82, 'AI: refining narration for spoken delivery…');
    const refineChunks = Math.ceil(units.length / CHUNK_SIZE);
    const refineStart = resumeStage === 'refine' ? Math.min(cp?.refineNextChunk ?? 0, refineChunks) : 0;
    for (let ci = refineStart; ci < refineChunks; ci++) {
      await control?.waitWhilePaused?.();
      if (control?.shouldCancel?.()) { cancelledMidPipeline = true; break; }
      const startIdx = ci * CHUNK_SIZE;
      const endIdx = Math.min(startIdx + CHUNK_SIZE, units.length);
      try {
        const refinements = await aiRefineScriptChunk(generator, units, startIdx, endIdx);
        for (const r of refinements) {
          const idx = units.findIndex((u) => u.id === r.id);
          if (idx >= 0) {
            if (r.text) units[idx] = { ...units[idx], text: r.text };
            if (r.emotionHint) units[idx] = { ...units[idx], emotionHint: r.emotionHint };
          }
        }
        onProgress?.(0.82 + (ci + 1) / Math.max(1, refineChunks) * 0.13, `AI: refined chunk ${ci + 1}/${refineChunks}`);
      } catch (e: any) {
        onProgress?.(0.82 + (ci + 1) / Math.max(1, refineChunks) * 0.13, `AI: refinement chunk ${ci + 1} failed — continuing`);
      }
      // Checkpoint each refined chunk (units mutated in place).
      await persist('refine', {
        stage: 'refine', globalAi, verifyNextChunk: totalChunks,
        verifications: Object.fromEntries(allVerifications), coveredIds: [...coveredIds],
        newCharacters: allNewCharacters, chunkNotes, failedChunks,
        unitsSnapshot: units, verdicts, aiCast,
        voiceAssignments: Object.fromEntries(voiceAssignments), refineNextChunk: ci + 1,
      }, 0.82 + (ci + 1) / Math.max(1, refineChunks) * 0.13);
    }
  }

  // STEP 6: Rebuild chapters (keep rule chapters, AI may have re-titled them)
  let chapters = draft.chapters.map((c) => ({ ...c }));
  if (globalAi?.chapterPlan?.length) {
    for (const plan of globalAi.chapterPlan) {
      const ch = chapters[plan.index];
      if (ch && plan.title) ch.title = plan.title;
    }
  }

  // Apply narration emotion from global analysis
  if (globalAi?.narrationEmotion?.length) {
    const tone = new Map(globalAi.narrationEmotion.map((n) => [n.id, n.emotion]));
    for (const u of units) {
      if (u.kind !== 'narration') continue;
      const hint = tone.get(u.id);
      if (hint && !u.emotionHint) u.emotionHint = hint;
    }
  }

  // Apply lexicon from global analysis
  const meta: Record<string, unknown> = { ...draft.meta };
  if (globalAi?.lexicon?.length) meta.aiLexicon = globalAi.lexicon;
  if (globalAi?.relationshipMap?.length) meta.aiRelationshipMap = globalAi.relationshipMap;
  if (aiCast.narratorStyle) meta.aiNarratorStyle = aiCast.narratorStyle;

  // Genre override
  let verdict = { ...draft.verdict };
  const genreDisagrees = !!globalAi?.genre && globalAi.genre !== verdict.kind;
  const genreTrusted = !!globalAi?.genre && (globalAi.genreConfidence ?? 0) >= (genreDisagrees ? 0.88 : 0.70);
  if (genreTrusted && globalAi!.genre && opts?.genre === 'auto') {
    verdict = {
      ...verdict, kind: globalAi!.genre,
      confidence: Math.max(verdict.confidence, globalAi!.genreConfidence ?? 0),
      reasons: [
        globalAi!.genre === 'fiction' ? 'Local language model detected narrative/character dialogue patterns.' : 'Local language model detected expository/instructional patterns.',
        ...verdict.reasons.filter((r) => !/local language model/i.test(r)),
      ].slice(0, 5),
    };
  }

  if (verdict.kind === 'non-fiction') {
    for (const u of units) {
      if (u.kind === 'dialogue') { u.kind = 'narration'; u.speaker = 'Narrator'; u.emotionHint = undefined; }
    }
  }

  const speakable = units.filter((u) => u.kind !== 'skip' && u.text.trim());
  const stats: AutobookStats = {
    ...draft.stats,
    words: speakable.reduce((n, u) => n + countWords(u.text), 0),
    dialogueUnits: units.filter((u) => u.kind === 'dialogue').length,
    narrationUnits: units.filter((u) => u.kind === 'narration').length,
    speakers: new Set(units.filter((u) => u.kind === 'dialogue').map((u) => u.speaker)).size,
  };
  stats.estMinutes = stats.words / 155;

  const totalUnits = speakableUnits.length;
  const aiCoverage = totalUnits ? coveredIds.size / totalUnits : 0;

  const notes: string[] = [
    ...(resumedFromCheckpoint ? [`Resumed from a saved checkpoint (stage: ${resumeStage}) — no completed work was re-done.`] : []),
    `Used ${status.modelName} locally with remote model loading disabled.`,
    `AI reviewed ${coveredIds.size}/${totalUnits} lines (${Math.round(aiCoverage * 100)}% coverage) across ${totalChunks} chunks${failedChunks ? ` (${failedChunks} chunks failed and were skipped)` : ''} — every line judged with its previous and coming lines as context.`,
    `AI speaker resolution: ${unresolvedIdx.length} ambiguous quote(s) re-examined against their surrounding conversation; ${speakersResolved} given a real character voice.`,
    ...(cancelledMidPipeline ? ['Cancelled mid-pipeline — partial AI enhancements applied.'] : []),
    `AI validated ${aiApproved.size} character names; rejected ${rejectedNames.size} non-characters${rejectedNames.size ? ` (${[...rejectedNames].slice(0, 5).join(', ')}${rejectedNames.size > 5 ? '…' : ''})` : ''}.`,
    `AI built cast of ${castMembers.length - 1} characters from full-text evidence.`,
    `AI assigned voices based on character voice descriptions.`,
    ...(globalAi?.notes ?? []),
    ...(aiCast.notes ?? []),
    ...chunkNotes.slice(0, 6),
  ];
  if (!deep) notes.push('Deep refinement disabled (set AI depth to Standard or Deep for narration rewriting).');
  if (aiCoverage < 1) notes.push(`Coverage note: ${totalUnits - coveredIds.size} line(s) kept their rule-based attribution because the AI did not return a decision for them.`);

  const result: AutobookResult = {
    units, chapters, cast: castMembers, stats,
    verdict, meta: meta as any,
    ai: {
      enabled: true, modelId, modelName: status.modelName,
      reviewedDialogue: coveredIds.size,
      totalUnits,
      coverage: aiCoverage,
      charactersValidated: aiApproved.size,
      charactersRejected: verdicts.filter((v) => !v.isCharacter).map((v) => v.name),
      speakersResolved,
      resumedFromCheckpoint,
      notes,
    },
  };

  // A completed run clears its checkpoint — a cancelled/paused run keeps it,
  // so re-running the same book resumes exactly where it stopped.
  if (!cancelledMidPipeline) {
    await clearAutobookCheckpoint(checkpointKey);
  } else {
    notes.push('Progress checkpoint saved — run AutoBook again on this book to resume where the analysis stopped.');
  }

  onProgress?.(1, `Local AI ready — ${status.modelName} (deep: ${deep ? 'yes' : 'no'})`);
  return result;
}
