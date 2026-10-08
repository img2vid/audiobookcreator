// ============================================================
// Openmukti Audiobook Creator — AutoBook pipeline intelligence
// ("lightweight AI", part 2 of 2 — orchestrator).
//
// Turns raw book text into a cast-narrated audiobook script:
//   1. classifyGenre      fiction vs non-fiction from stylistic signals
//   2. analyzeStructure   page numbers, TOC, running heads, copyright,
//                         index and references → marked "do not read"
//   3. discoverCharacterNames  UNLIMITED character census from every name
//                         shape (honorifics, particles, Mc/Mac/O', hyphens,
//                         vocatives, play labels, letter signatures, aliases)
//   4. attributeDialogue  who says each quoted line — 18 ranked rules over
//                         every dialogue convention (curly/straight/single
//                         quotes, dashes, play colons, continued paragraphs,
//                         letter signatures), each unit carrying its evidence
//   5. casting            via autobook-cast.ts demographics + profiles —
//                         every character keeps a voice (formant
//                         differentiation when profiles run out)
//
// 100% local, zero-download: this IS the lightweight model — a
// deterministic, explainable NLP engine (every decision carries
// evidence). No network, no DOM, no randomness: the same book always
// produces the identical script.
// ============================================================
import type { VoiceProfileDef } from '@/lib/types';
import { castVoiceFor, inferCharacterMeta, withRole, type AgeBand, type CastAssignment, type CharacterMeta, type Gender } from '@/lib/engines/autobook-cast';
import {
  VERBS_ALTERNATION, EMOTION_BY_VERB, ROLE_NOUN_SET, roleMetaForPhrase, TITLE_PREFIX,
  letterSignature, scanQuotes, vocativeNames, PLAY_LINE_RE, isHonorific,
  NOT_A_NAME_WORDS, COMMON_CAPITALIZED_NON_NAMES, NAME_PARTICLES, NARRATION_BEAT_VERBS,
  NAME_TOKEN as NAME_TOKEN_SRC,
  type QuoteSpan,
} from '@/lib/engines/dialogue-patterns';

// ---------- public types ----------
export type SkipReason =
  | 'page-number' | 'running-head' | 'toc' | 'copyright' | 'frontmatter'
  | 'index' | 'reference' | 'footnote' | 'blank' | 'marker';

export interface GenreSignal {
  name: string;
  /** Signed: positive pushes toward fiction, negative toward non-fiction. */
  weight: number;
  detail: string;
}

export interface GenreVerdict {
  kind: 'fiction' | 'non-fiction';
  confidence: number; // 0..1
  signals: GenreSignal[];
  reasons: string[];
}

export interface ScriptUnit {
  id: string;
  kind: 'narration' | 'dialogue' | 'skip';
  /** 'Narrator', a character name, or '(skipped)'. */
  speaker: string;
  text: string;
  skipReason?: SkipReason;
  /** 0-based chapter index (assigned by buildAudiobookScript). */
  chapterIndex: number;
  emotionHint?: 'whisper' | 'urgent' | 'curious' | 'soft';
  /** Which attribution rule decided the speaker ("tag-after:name",
   * "vocative", "turn-taking", "continued-speech", "ai:verification"…). */
  evidence?: string;
}

export interface BookChapter {
  title: string;
  /** Index into AutobookResult.units where the chapter starts. */
  startUnit: number;
}

export interface BookCastMember {
  name: string;
  meta: CharacterMeta;
  profileId: string;
  rate: number;
  pitch: number;
  rationale: string;
}

export interface AutobookStats {
  words: number;
  skippedWords: number;
  skippedUnits: number;
  dialogueUnits: number;
  narrationUnits: number;
  speakers: number;
  /** Speakable words ÷ 155 wpm. */
  estMinutes: number;
}

export interface AutobookMeta {
  titleGuess: string;
  authorGuess?: string;
  language: string;
  structure: 'chapters' | 'sections' | 'plain';
}

export interface AutobookOptions {
  /** Maximum named voices to cast before folding extras into the Narrator. */
  maxCast?: number;
  /** Safety cap on discovered character names (0/undefined = unlimited). */
  maxNames?: number;
  genre?: 'auto' | 'force-fiction' | 'force-nonfiction';
  detectChapters?: boolean;
  /** Original file context supplied to the AI director (never spoken aloud). */
  fileContext?: { fileName?: string; ext?: string; category?: string; textKind?: string };
}

export interface AutobookResult {
  verdict: GenreVerdict;
  units: ScriptUnit[];
  chapters: BookChapter[];
  /** Index 0 is always the Narrator. */
  cast: BookCastMember[];
  stats: AutobookStats;
  meta: AutobookMeta;
  /** Optional real local-LLM enhancement metadata. */
  ai?: {
    enabled: boolean;
    modelId?: string;
    modelName: string;
    /** Units the AI actually returned a decision for. */
    reviewedDialogue: number;
    /** Total speakable units submitted to the AI. */
    totalUnits?: number;
    /** reviewedDialogue / totalUnits (1 = every line AI-verified). */
    coverage?: number;
    /** Candidate character names the AI explicitly validated. */
    charactersValidated?: number;
    /** Candidate names the AI rejected as non-characters (ordinary words). */
    charactersRejected?: string[];
    /** Ambiguous Narrator-attributed quotes the AI gave a real speaker to. */
    speakersResolved?: number;
    /** Set when a checkpoint was resumed instead of starting from scratch. */
    resumedFromCheckpoint?: boolean;
    notes: string[];
  };
}

// ---------- shared heuristics ----------
// The full catalogs (300+ speech verbs, ~400 role nouns, 110+ honorifics)
// live in dialogue-patterns.ts; here they are composed into the compiled
// regexes the discovery + attribution passes run per paragraph.
const VERBS = VERBS_ALTERNATION;
const VERB_RE = new RegExp(`\\b(${VERBS})\\b`, 'gi');
/** Internal-monologue verbs: "he thought" means the quote is NOT spoken aloud.
 * THOUGHT_RE itself is built after NAME_TOKEN (below) to avoid TDZ issues. */
const THOUGHT_VERBS = 'thought|wondered|mused|pondered|reflected|realised|realized|decided|figured|recollected|dreamed|dreamt';

/** Name token: capital-led, apostrophes/hyphens allowed (O'Brien, Jean-Luc). */
const NAME_TOKEN = NAME_TOKEN_SRC;
/** Honorific prefix regex fragment — used as \b${HONORIFIC_PREFIX}. */
const HONORIFIC_PREFIX = `(?:${TITLE_PREFIX})`;

/**
 * Descriptive (unnamed) speakers: "said the other girl", "replied the old
 * man", "the little boy answered". The captured phrase must END in a
 * recognised role noun so tags like "said the next morning" are rejected.
 */
const DESCRIPTIVE_WORDS = String.raw`[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3}`;
const ROLE_NOUNS_ALT = [...ROLE_NOUN_SET].sort((a, b) => b.length - a.length).join('|');
const DESCR_AFTER_RE = new RegExp(`\\b(${VERBS})\\s*,?\\s*(?:the|a|an|this|that|one)\\s+(${DESCRIPTIVE_WORDS})`, 'i');
const DESCR_BEFORE_RE = new RegExp(`\\b(?:the|a|an|this|that|one)\\s+(${DESCRIPTIVE_WORDS})\\s+(${VERBS})\\b`, 'i');
/** Role noun must terminate the phrase: "said the next morning" is rejected. */
function endsInRoleNoun(phrase: string): boolean {
  const words = phrase.trim().toLowerCase().replace(/\s+/g, ' ').split(/\s+/);
  if (!words.length) return false;
  const last = words[words.length - 1];
  if (ROLE_NOUN_SET.has(last)) return true;
  if (words.length >= 2 && ROLE_NOUN_SET.has(`${words[words.length - 2]} ${last}`)) return true;
  return false;
}

/** Gender/age inference for a descriptive phrase like "the other girl" —
 * driven by the role-noun catalog, with pronoun/adjective fallbacks. */
function descriptiveMeta(phrase: string): { gender: Gender; age?: AgeBand; group?: boolean } {
  const p = phrase.toLowerCase();
  const meta = roleMetaForPhrase(p);
  let gender: Gender = meta?.gender ?? 'neutral';
  let age: AgeBand | undefined = meta?.age;
  const group = meta?.group ?? false;
  if (!meta) {
    if (/\b(she|her|hers|woman|women|girl|lady|ladies|witch|princess|queen|maid|nun|mistress|sister|mother|grandmother|granny|aunt|daughter|bride|waitress|actress|duchess|countess|hostess|housekeeper|nurse)\b/.test(p)) gender = 'female';
    else if (/\b(he|him|his|man|men|boy|gentleman|gentlemen|prince|king|monk|friar|brother|father|grandfather|grandpa|uncle|son|groom|waiter|actor|duke|count|lord|master|squire|host|wizard)\b/.test(p)) gender = 'male';
  }
  if (!age) {
    if (/\b(girl|boy|child|kid|children|little|small|baby|infant)\b/.test(p)) age = 'child';
    else if (/\b(old|elderly|aged|ancient|grey|gray|white[- ]haired|wrinkled)\b/.test(p)) age = 'elder';
    else if (/\b(young|teen|teenager|youthful|adolescent)\b/.test(p)) age = 'young';
  }
  return { gender, age, group };
}

/** "other girl" → "The Other Girl" when the phrase ends in a role noun; else null. */
function descriptiveName(phrase: string): string | null {
  const words = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return null;
  if (!endsInRoleNoun(words.join(' '))) return null;
  // reject phrases that are clearly not people/characters
  if (words.some((w) => /^(morning|evening|afternoon|night|day|week|month|year|time|moment|end|rest|sound|sight|thought|way|thing|place)$/.test(w))) return null;
  return 'The ' + words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const CHAPTER_WORD_RE = /^\s*(chapter|part|book|act|scene|canto|letter)\s+([\dIVXLCivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b[.:—–-]?\s*(.*)$/i;
const SOLO_HEADING_RE = /^\s*(prologue|epilogue|interlude|afterword|foreword|preface|acknowled?gements|dedication)\s*[:.!?—–-]?\s*(.*)$/i;
const NUMBERED_HEADING_RE = /^\s*(\d{1,2})[.:)]\s+([A-Z][^.!?]{2,60})$/;
const ALLCAPS_HEADING_RE = /^\s*[A-Z][A-Z0-9 '’!,.&-]{3,59}\s*$/;

const STOP_WORDS = new Set(
  ('i the a an and but or so then when while after before because that this these those there here where what who why how ' +
    'yes no okay ok well oh ah now still just again he she it they we you his her their my your our its him them if else ' +
    'mr mrs ms dr miss sir lady lord aunt uncle captain professor doctor mother father grandmother grandfather ' +
    'january february march april may june july august september october november december monday tuesday wednesday ' +
    'thursday friday saturday sunday chapter part page section act scene book prologue epilogue narrator god').split(/\s+/),
);

const REFERENCE_HEADING_RE = /^\s*(references|bibliography|notes|works cited|further reading|endnotes|sources)\s*:?\s*$/i;
const INDEX_HEADING_RE = /^\s*(index|subject index|general index)\s*:?\s*$/i;
const COPYRIGHT_RE = /(©|\(c\)|copyright|all rights reserved|isbn|published by|first edition|second edition|printed in)/i;
const FRONTMATTER_RE = /^(table of contents|contents|about this book|about the author|dedication|epigraph)\s*:?\s*$/i;

function normSpace(s: string): string {
  return s.replace(/[ \t]+/g, ' ').trim();
}

function countWords(s: string): number {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
}

function isChapterHeadingLine(line: string): boolean {
  const t = normSpace(line);
  if (!t || t.length > 80) return false;
  return CHAPTER_WORD_RE.test(t) || SOLO_HEADING_RE.test(t) || NUMBERED_HEADING_RE.test(t);
}

// ============================================================
// 1. Genre classification
// ============================================================

/**
 * Fiction vs non-fiction from style alone. Every signal is computed,
 * weighted and reported — the verdict always ships with its evidence.
 */
export function classifyGenre(text: string): GenreVerdict {
  const sample = text.slice(0, 60_000);
  const words = Math.max(1, countWords(sample));
  const per1k = (n: number) => (n / words) * 1000;
  const signals: GenreSignal[] = [];

  // dialogue density — quoted spans per 1k words
  const quotes = sample.match(/“[^”\n]{1,600}”|"[^"\n]{1,600}"/g)?.length ?? 0;
  const qPer1k = per1k(quotes);
  let qWeight = 0;
  if (qPer1k >= 8) qWeight = 4;
  else if (qPer1k >= 3) qWeight = 1.5;
  else if (qPer1k < 0.3 && words > 1200) qWeight = -2;
  signals.push({
    name: 'Dialogue density',
    weight: qWeight,
    detail: `${qPer1k.toFixed(1)} quoted spans per 1k words (${quotes} total)`,
  });

  // dialogue verbs — said/asked/whispered... per 1k words
  const verbs = (sample.match(VERB_RE) ?? []).length;
  const vPer1k = per1k(verbs);
  const vWeight = vPer1k >= 5 ? 1.5 : vPer1k >= 1.5 ? 0.8 : vPer1k < 0.2 && words > 1200 ? -0.8 : 0;
  signals.push({ name: 'Dialogue verbs', weight: vWeight, detail: `${vPer1k.toFixed(1)} speech verbs per 1k words` });

  // instructional voice — "you should / step 1 / make sure"
  const instruct = (sample.match(/\b(you (?:should|can|must|need to|will want)|make sure|step \d|note that|in this chapter we|as discussed in)\b/gi) ?? []).length;
  const iWeight = per1k(instruct) > 2 ? -2 : 0;
  signals.push({ name: 'Instructional voice', weight: iWeight, detail: `${instruct} instructional phrases` });

  // non-fiction apparatus — citations, figures, ISBN...
  const apparatusHits = (
    sample.match(/\[\d{1,3}\]|\([A-Z][a-z]+, \d{4}\)|\bet al\.|\bFigure \d|\bTable \d|\bISBN\b|\bhttps?:\/\/\S+/g) ?? []
  ).length;
  const aWeight = apparatusHits > 0 ? -Math.min(4, 2 + apparatusHits * 0.1) : 0;
  signals.push({ name: 'Scholarly apparatus', weight: aWeight, detail: `${apparatusHits} citation/figure/URL markers` });

  // front/back matter words — glossary, exercises, index entries
  const matterHits = (sample.match(/\bglossary\b|\bexercises?\b|\bfurther reading\b|\bstudy questions\b|\bappendix\b/gi) ?? []).length;
  const mWeight = matterHits > 2 ? -1.5 : 0;
  signals.push({ name: 'Textbook furniture', weight: mWeight, detail: `${matterHits} glossary/exercise/appendix mentions` });

  // narrative world — rooms, eyes, night, voices...
  const worldHits = (sample.match(/\b(door|room|eyes|smiled|laughed|night|voice|hand|window|street|dark)\b/gi) ?? []).length;
  const wPer1k = per1k(worldHits);
  const wWeight = wPer1k > 12 ? 1 : 0;
  signals.push({ name: 'Narrative scenery', weight: wWeight, detail: `${wPer1k.toFixed(1)} scene words per 1k words` });

  const score = signals.reduce((a, s) => a + s.weight, 0);
  const kind: GenreVerdict['kind'] = score >= 0 ? 'fiction' : 'non-fiction';
  const confidence = Math.min(0.99, Math.abs(score) / (Math.abs(score) + 5));
  const reasons = [...signals]
    .sort((x, y) => Math.abs(y.weight) - Math.abs(x.weight))
    .filter((s) => s.weight !== 0)
    .slice(0, 3)
    .map((s) => `${s.name}: ${s.detail}`);
  if (!reasons.length) reasons.push('Style is evenly balanced — defaulting to fiction narration with dialogue kept inline');
  return { kind, confidence, signals, reasons };
}

// ============================================================
// 2. Structure analysis — what must NOT be read aloud
// ============================================================

export interface StructureLine {
  text: string;
  skip?: SkipReason;
}

export interface StructureChapter {
  title: string;
  lineIndex: number;
}

/**
 * Line-level janitor: page numbers, running heads, dotted TOC rows,
 * copyright pages, index/reference/footnote regions and blank lines are
 * classified so the pipeline never speaks them. Chapter headings are
 * returned separately as structure (they become silent markers).
 */
export function analyzeStructure(text: string): { lines: StructureLine[]; chapters: StructureChapter[] } {
  const rawLines = text.split(/\r?\n/);

  // running-head detection: identical short unpunctuated lines repeated ≥3×
  const freq = new Map<string, number>();
  for (const l of rawLines) {
    const t = normSpace(l);
    if (t.length >= 3 && t.length <= 60 && !/[.!?]$/.test(t) && !isChapterHeadingLine(t)) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const runningHeads = new Set([...freq.entries()].filter(([, n]) => n >= 3).map(([t]) => t));

  const lines: StructureLine[] = rawLines.map((l) => ({ text: l }));
  const chapters: StructureChapter[] = [];

  // ALL-CAPS headings only count when the doc has ≥2 of them (a lone "STOP" is not a chapter)
  const capsCount = rawLines.filter((l) => {
    const t = normSpace(l);
    return t.length >= 4 && ALLCAPS_HEADING_RE.test(t) && /\s/.test(t) && !t.endsWith('.') && t === t.toUpperCase();
  }).length;
  const useCapsHeadings = capsCount >= 2;

  let section: 'body' | 'references' | 'index' = 'body';
  for (let i = 0; i < lines.length; i++) {
    const t = normSpace(lines[i].text);

    if (!t) {
      lines[i].skip = 'blank';
      continue;
    }

    // section switches — a heading or any chapter line ends reference/index regions
    if (section !== 'body' && (isChapterHeadingLine(t) || FRONTMATTER_RE.test(t))) section = 'body';
    if (REFERENCE_HEADING_RE.test(t)) {
      section = 'references';
      lines[i].skip = 'marker';
      continue;
    }
    if (INDEX_HEADING_RE.test(t)) {
      section = 'index';
      lines[i].skip = 'marker';
      continue;
    }
    if (section === 'references') {
      lines[i].skip = 'reference';
      continue;
    }
    if (section === 'index') {
      lines[i].skip = 'index';
      continue;
    }

    // chapter headings (silent markers, never spoken)
    if (isChapterHeadingLine(t) || (useCapsHeadings && ALLCAPS_HEADING_RE.test(t) && /\s/.test(t) && t === t.toUpperCase() && !t.endsWith('.'))) {
      lines[i].skip = 'marker';
      chapters.push({ title: t.slice(0, 80), lineIndex: i });
      continue;
    }

    if (/^\s*(page\s*)?\d{1,4}\s*$/i.test(t)) {
      lines[i].skip = 'page-number';
      continue;
    }
    // dotted TOC rows: "Getting started ........ 12" / "The Storm … 45"
    if (/\s(?:\.{3,}|…|·{3,}|—{3,})\s*\d{1,3}\s*$/.test(t) || (/^.{2,60}\s+\d{1,3}$/.test(t) && /\.{2,}|…/.test(t))) {
      lines[i].skip = 'toc';
      continue;
    }
    if (COPYRIGHT_RE.test(t) && t.length < 200) {
      lines[i].skip = 'copyright';
      if (i + 1 < lines.length && normSpace(lines[i + 1].text)) lines[i + 1].skip = 'copyright';
      continue;
    }
    if (FRONTMATTER_RE.test(t)) {
      lines[i].skip = 'frontmatter';
      continue;
    }
    if (runningHeads.has(t)) {
      lines[i].skip = 'running-head';
      continue;
    }
    // footnote bodies: superscript-style starts like "[12] See earlier…" or "¹ …"
    if (/^\s*(\[\d{1,3}\]|\^\d{1,3}|[¹²³⁴⁵⁶⁷⁸⁹⁰])\s+\S/.test(t) && t.length < 300) {
      lines[i].skip = 'footnote';
      continue;
    }
  }

  // a TOC region is usually a dense run of toc lines — also catch the "Contents" block
  let tocRun = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].skip === 'toc') {
      tocRun++;
    } else {
      if (tocRun >= 2) {
        // the heading right above the run is frontmatter
        for (let j = i - tocRun - 1; j <= i - 1; j++) {
          if (j >= 0 && !lines[j].skip) lines[j].skip = 'frontmatter';
        }
      }
      tocRun = 0;
    }
  }

  return { lines, chapters };
}

/**
 * Chapter headings detected across the ORIGINAL text (line-indexed).
 * Used by views for a quick structure preview; the pipeline itself
 * re-detects markers on the cleaned stream for exact unit alignment.
 */
export function extractChapters(text: string): StructureChapter[] {
  return analyzeStructure(text).chapters;
}

// ============================================================
// 3. Character discovery + dialogue attribution
// ============================================================

/** Matches "she thought", "Mary wondered", "thought he" — internal monologue. */
const THOUGHT_RE = new RegExp(
  `\\b(she|he|they|${NAME_TOKEN}(?:\\s+${NAME_TOKEN})?)\\s+(?:${THOUGHT_VERBS})\\b|\\b(?:${THOUGHT_VERBS})\\s+(she|he|they)\\b`,
  'i',
);

/** Matches a narration sentence that is ONLY a dialogue tag: "she said.",
 * "Mary asked.", "said the other girl.", "the old man replied." */
const PURE_TAG_RE = new RegExp(
  `^[,;:\\s]*(?:`
  + `(?:(?:${TITLE_PREFIX})?${NAME_TOKEN}(?:\\s+${NAME_TOKEN})?|she|he|they)\\s+(?:${VERBS})\\b`
  + `|(?:${VERBS})\\s+(?:(?:${TITLE_PREFIX})?${NAME_TOKEN}|she|he|they|(?:the|a|an|this|that)\\s+${DESCRIPTIVE_WORDS})\\b`
  + `|(?:the|a|an|this|that)\\s+${DESCRIPTIVE_WORDS}\\s+(?:${VERBS})\\b`
  // tags normally END a sentence — terminal punctuation (and a stray closing
  // quote/paren) must be allowed or "said the other girl." never matches and
  // the stale tag leaks into the NEXT quote's attribution zone
  + `)[^.!?]*[.!?…]*['"’”)\\]]?\\s*$`,
  'i',
);

/** An action beat led by a pronoun touching a quote: '"…" He stepped inside.' */
const PRONOUN_BEAT_RE = /^["'(\s]*(she|he)\b/i;

/** Pure internal-monologue tag: "she thought.", "Mary wondered." — used to
 * drop orphaned thought tags from narration the same way PURE_TAG_RE drops
 * orphaned speech tags. */
const PURE_THOUGHT_RE = new RegExp(
  `^[,;:\\s]*(?:`
  + `(?:(?:${TITLE_PREFIX})?${NAME_TOKEN}(?:\\s+${NAME_TOKEN})?|she|he|they)\\s+(?:${THOUGHT_VERBS})\\b`
  + `|(?:${THOUGHT_VERBS})\\s+(?:(?:${TITLE_PREFIX})?${NAME_TOKEN}|she|he|they)\\b`
  + `)[^.!?]*[.!?…]*['"’”)\\]]?\\s*$`,
  'i',
);

/** Discourse marker at the head of a quote signalling a NEW TURN (rebuttal,
 * question, interjection) rather than a continuation of the same speaker:
 * "But I can!" / "How? Show me?" / "Well, …". */
const TURN_MARKER_RE = /^["'“”‘’(\s]*(?:but|well|no|yes|yeah|why|how|what|where|when|who|which|whose|so|then|still|yet|however|ha|oh|really|indeed|sure|maybe|perhaps|please|look|listen|stop|wait|enough|fine|okay|ok|alright|hush|come|go|tell|show|let|do|don't|can|could|would|will|shall|is|are|was|were|now|see|here|there|never|always|impossible|nonsense|rubbish|liar|coward)\b/i;

/**
 * UNLIMITED character discovery. Collects every plausible character name from
 * the WHOLE book (no 24-name cap, no 120k sample cut) across every surface a
 * name can appear on:
 *
 *   1. mid-sentence mentions            — "asked Eleanor whether…"
 *   2. honorific names                  — "Mrs. Coulter", "Dr. Watson"
 *   3. multi-token names + particles    — "Anna van der Berg", "de la Cruz"
 *   4. Mc/Mac/O'/apostrophe/hyphen      — "McTavish", "O'Brien", "Jean-Luc"
 *   5. title-led names                  — "Queen Eleanor", "Uncle Podge"
 *   6. vocatives inside dialogue        — "Eleanor, come here!"
 *   7. named/called/known-as aliases    — "a girl named Lily"
 *   8. letter/diary signatures          — "Yours sincerely, Eleanor"
 *   9. play/screenplay speaker labels   — "FIRST WITCH: When shall…"
 *  10. possessive mentions              — "Eleanor's hand flew…"
 *
 * A candidate survives when it is seen ≥2× mid-sentence, OR once next to a
 * speech verb / vocative / signature / play label / alias pattern. Deterministic
 * and stable: first-appearance order, no randomness.
 */
export function discoverCharacterNames(text: string, opts?: { maxNames?: number }): string[] {
  const maxNames = Math.max(0, opts?.maxNames ?? 0); // 0 = unlimited
  /** display form → score. score: +1 per mention, +2 near a speech verb. */
  const tally = new Map<string, { score: number; first: number }>();
  let order = 0;
  const seen = (name: string, weight = 1): void => {
    const key = name.replace(/\s+/g, ' ').trim();
    if (!key) return;
    const cur = tally.get(key);
    if (cur) cur.score += weight;
    else tally.set(key, { score: weight, first: order++ });
  };
  const hardCap = maxNames > 0 ? maxNames * 40 + 2000 : 100_000;
  let processed = 0;

  // ---- process the book in sentence slices (whole text, no sample cut) ----
  const SLICE = 120_000;
  for (let off = 0; off < text.length && processed < hardCap; off += SLICE) {
    const chunk = text.slice(off, off + SLICE);
    processed += chunk.length;

    // (1-5) capitalized candidates — mid-sentence (strong) and
    // sentence-initial followed by an action/speech verb ("Eleanor froze.",
    // "Tomas turned.", "McTavish roared.") which is nearly as strong.
    // Sentence splitting honors honorific dots and paragraph breaks.
    const sentences = splitSentences(chunk);
    for (const sent of sentences) {
      const re = new RegExp(`(^|[^.!?…\\s]\\s)(${HONORIFIC_PREFIX})?(${NAME_TOKEN})((?:\\s+(?:${NAME_PARTICLES})\\s+${NAME_TOKEN}|\\s+${NAME_TOKEN}){0,2})`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(sent))) {
        const honorific = (m[2] ?? '').replace(/\s+/g, ' ').trim();
        const candidate = ((honorific ? honorific + ' ' : '') + m[3] + (m[4] ?? '')).replace(/\s+/g, ' ').trim();
        const head = m[3];
        const headLower = head.toLowerCase().replace(/[.'’-]+$/, '');
        if (STOP_WORDS.has(headLower)) continue;
        if (!honorific && (NOT_A_NAME_WORDS.has(headLower) || COMMON_CAPITALIZED_NON_NAMES.has(headLower))) continue;
        if (head.length < 2) continue;
        // ALL-CAPS words are usually furniture ("STOP", "THE END") — accept
        // them only via play labels / vocatives below, except ALL-CAPS 2-tokens
        const isAllCaps = head === head.toUpperCase() && !/[a-z]/.test(head);
        if (isAllCaps && !/[\s]/.test(candidate)) continue;
        // possessive gluing: "Eleanor's" captured with trailing 's — trim
        const cleaned = candidate.replace(/['’]s$/i, '');
        if (!cleaned || cleaned.length > 44) continue;
        // sentence-initial candidates need a following action/speech verb
        const atSentenceStart = m[1] === '^' || m[1] === '';
        if (atSentenceStart) {
          const after = sent.slice((m.index ?? 0) + m[0].length).trimStart();
          const nextWord = (after.match(/^[a-z']+/) ?? [''])[0].toLowerCase();
          if (!NARRATION_BEAT_VERBS.has(nextWord) && !isSpeechVerbLocal(nextWord)) continue;
          seen(cleaned, 2);
          continue;
        }
        seen(cleaned, 1);
      }
      // (7) alias patterns — "a girl named Lily", "called himself Fenris"
      const aliasRe = new RegExp(`\\b(?:named|called|christened|dubbed|baptised|baptized|known\\s+as|styled|hight)\\s+((?:${HONORIFIC_PREFIX})?${NAME_TOKEN}(?:\\s+${NAME_TOKEN})?)`, 'gi');
      let am: RegExpExecArray | null;
      while ((am = aliasRe.exec(sent))) {
        const alias = am[1].replace(/\s+/g, ' ').trim();
        if (!isCapitalLedName(alias)) continue;
        const headLower = (alias.split(/\s+/).pop() ?? '').toLowerCase();
        if (alias.length >= 3 && !STOP_WORDS.has(headLower) && !COMMON_CAPITALIZED_NON_NAMES.has(headLower)) {
          seen(alias, 3); // strong signal — counts as near-verb
        }
      }
    }
  }

  // ---- (2b) verb-adjacent pass over the WHOLE text ("said Eleanor" /
  // "Eleanor said") — one mention next to a speech verb is enough evidence. ----
  const verbAdj = new RegExp(`\\b(?:${VERBS})\\s+((?:${HONORIFIC_PREFIX})?${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){0,2})|((?:${HONORIFIC_PREFIX})?${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){0,2})\\s+(?:${VERBS})\\b`, 'gi');
  let vm: RegExpExecArray | null;
  while ((vm = verbAdj.exec(text))) {
    let raw = (vm[1] ?? vm[2] ?? '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    // the regex runs case-insensitive so "Said"/"SAID" match — but names must stay capital-led
    if (!isCapitalLedName(raw)) continue;
    // possessive capture ("said Mr. Bingley’s") — trim before tallying
    raw = raw.replace(/['’]s$/i, '');
    // ALL-CAPS single tokens (Gutenberg captions "BENNET", "EDW") are furniture
    const capsWords = raw.split(/\s+/);
    if (capsWords.length === 1 && capsWords[0] === capsWords[0].toUpperCase() && capsWords[0].length >= 2) continue;
    const headLower = (raw.split(/\s+/).pop() ?? '').toLowerCase();
    // "In went Mr. Collins" — inversion adverbs must not become characters;
    // "When Darcy replied" — the head word must not be a function word either
    const headFirst = raw.split(/\s+/)[0].toLowerCase().replace(/\.$/, '');
    if (STOP_WORDS.has(headFirst) || NOT_A_NAME_WORDS.has(headFirst) || COMMON_CAPITALIZED_NON_NAMES.has(headFirst)) continue;
    if (STOP_WORDS.has(headLower) || NOT_A_NAME_WORDS.has(headLower) || COMMON_CAPITALIZED_NON_NAMES.has(headLower)) continue;
    if (raw.length < 3 || raw.length > 44) continue;
    seen(raw, 3);
  }

  // ---- (6) vocatives + (9) play labels: scan quote-bearing paragraphs ----
  const paragraphs = text.split(/\n{2,}/);
  for (const para of paragraphs) {
    if (processed > hardCap * 2) break;
    // (9) play/screenplay labels — per LINE, not per paragraph
    for (const line of para.split(/\n/)) {
      const play = PLAY_LINE_RE.exec(line);
      if (!play) continue;
      const label = (play[1] ?? play[2] ?? '').trim();
      const words = label.split(/\s+/);
      const realWords = words.filter((w) => w.length >= 2 && !NOT_A_NAME_WORDS.has(w.toLowerCase()) && !isHonorific(w));
      if (label && label.length <= 40 && realWords.length >= 1) {
        const display = words.map((w) => (isHonorific(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
        seen(display, 3);
      }
    }
    // (8b) letter signatures — naturally span lines ("Yours sincerely,\nEleanor")
    const paraSig = letterSignature(para);
    if (paraSig && /^[A-Z]/.test(paraSig)) {
      const headLower = (paraSig.split(/\s+/).pop() ?? '').toLowerCase();
      if (!STOP_WORDS.has(headLower) && !COMMON_CAPITALIZED_NON_NAMES.has(headLower)) seen(paraSig, 3);
    }
    // (6) vocatives — capitalized names addressed inside any quote convention
    const spans = scanQuotes(para);
    for (const span of spans) {
      const q = span.text;
      if (q.length < 4) continue;
      // capitalized tokens not at the quote's start are address candidates
      const re = new RegExp(`(?<![.!?…]\\s)\\b(${NAME_TOKEN})(?=\\s*[,!?.:;—–])`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(q))) {
        const token = m[1];
        const lower = token.toLowerCase();
        if (STOP_WORDS.has(lower) || NOT_A_NAME_WORDS.has(lower) || COMMON_CAPITALIZED_NON_NAMES.has(lower)) continue;
        if (token.length < 3) continue;
        // ALL-CAPS tokens are Gutenberg/OCR furniture — play labels come in via PLAY_LINE_RE
        if (token === token.toUpperCase()) continue;
        seen(token, 2);
      }
    }
  }

  // ---- survive rule: ≥2 mentions OR ≥3 score (verb/vocative/signature/alias) ----
  const out: string[] = [];
  for (const [name, { score }] of tally) {
    if (score >= 2 || score >= 3) {
      out.push(name);
      if (maxNames > 0 && out.length >= maxNames) break;
    }
  }
  out.sort((a, b) => (tally.get(a)?.first ?? 0) - (tally.get(b)?.first ?? 0));
  return out;
}

/**
 * Sentence splitter that honors honorific dots and paragraph breaks:
 * "Mrs. Coulter stepped in." stays one sentence; "Chapter One\u000a\u000aEleanor
 * woke…" splits at the newline so prose after a heading starts a sentence.
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.split(/\n{1,}/)) {
    for (const frag of piece.split(/(?<=[.!?…])\s+/)) {
      const last = out[out.length - 1];
      if (last && /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|Messrs|Gen|Col|Maj|Capt|Lt|Sgt|Rev|Hon|Esq)\.?$/i.test(last.trim())) {
        out[out.length - 1] = `${last} ${frag}`;
      } else {
        out.push(frag);
      }
    }
  }
  return out;
}

/** Every word capital-led, except name particles ("van der Berg"). Rejects
 * "The gentlemen"/"You have" junk that the case-insensitive verb-adjacent
 * pass would otherwise harvest. */
const PARTICLE_WORD_RE = new RegExp(`^(?:${NAME_PARTICLES})$`, 'i');
function isCapitalLedName(raw: string): boolean {
  const words = raw.split(/\s+/);
  return words.every((w, i) => (i > 0 && PARTICLE_WORD_RE.test(w)) || /^[A-Z]/.test(w));
}

/** Local speech-verb check (avoids importing the whole catalog twice). */
function isSpeechVerbLocal(word: string): boolean {
  return /\b(said|asked|replied|called|shouted|whispered|yelled|screamed|growled|hissed|snapped|began|added|thought|muttered|murmured|exclaimed|declared|announced|demanded|answered|continued|warned|urged|pleaded|insisted|laughed|sobbed|wept|gasped|sighed|grunted|echoed|roared|bellowed|chuckled|ordered|commanded|complained|wondered|recollected)\b/.test(word);
}

function escapeName(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Segment {
  kind: 'narration' | 'quote';
  text: string;
  span?: QuoteSpan;
}

/**
 * Multi-convention quote splitter: builds narration/quote segments from every
 * convention scanQuotes understands (curly/straight doubles, curly/straight
 * British singles, guillemets, dash paragraphs, continued paragraphs).
 */
function splitQuoted(paragraph: string, openConvention: QuoteSpan['convention'] | null): { segments: Segment[]; open: QuoteSpan['convention'] | null } {
  const spans = scanQuotes(paragraph, { openConvention });
  const segments: Segment[] = [];
  let last = 0;
  let open: QuoteSpan['convention'] | null = openConvention;
  for (const span of spans) {
    const before = paragraph.slice(last, span.start);
    if (normSpace(before)) segments.push({ kind: 'narration', text: before });
    segments.push({ kind: 'quote', text: span.text, span });
    last = span.end;
    // track whether speech is still open at the end of the paragraph
    if (span.convention === 'continued') {
      open = span.unclosed ? open : null;
    } else if (span.convention === 'curly-double' || span.convention === 'straight-double'
      || span.convention === 'curly-single' || span.convention === 'straight-single' || span.convention === 'guillemet') {
      // a closed span inside narration closes nothing; only an unclosed END span opens speech
      open = null;
    } else if (span.convention === 'dash') {
      open = null;
    }
  }
  const tail = paragraph.slice(last);
  if (normSpace(tail)) segments.push({ kind: 'narration', text: tail });
  // the final span decides the open state for the NEXT paragraph
  const lastSpan = spans[spans.length - 1];
  if (lastSpan) {
    const endsOpen = lastSpan.unclosed === true
      || ((lastSpan.convention === 'curly-double' || lastSpan.convention === 'straight-double'
        || lastSpan.convention === 'curly-single' || lastSpan.convention === 'straight-single' || lastSpan.convention === 'guillemet')
        && paragraph.slice(lastSpan.start, lastSpan.end).indexOf(lastSpan.convention === 'curly-double' ? '”'
          : lastSpan.convention === 'straight-double' ? '"'
            : lastSpan.convention === 'curly-single' ? '’'
              : lastSpan.convention === 'straight-single' ? "'"
                : '»') === -1);
    if (endsOpen) open = lastSpan.convention;
    else if (lastSpan.convention !== 'continued') open = null;
  } else if (openConvention) {
    // a narration paragraph with no spans while speech is open: only closing
    // punctuation would have ended it — scanQuotes already handled the closer
    open = openConvention;
  }
  return { segments, open };
}

/** Split narration into units of ≤ ~300 chars at sentence boundaries. */
function chunkNarration(text: string, cap = 300): string[] {
  const clean = normSpace(text);
  if (clean.length <= cap) return clean ? [clean] : [];
  const sentences = clean.match(/[^.!?…]+[.!?…]*\s*/g) ?? [clean];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + s).length > cap) {
      out.push(normSpace(cur));
      cur = '';
    }
    cur += s;
  }
  if (normSpace(cur)) out.push(normSpace(cur));
  return out;
}

/**
 * The attribution engine. Walks paragraphs, extracts quoted spans (every
 * convention: curly/straight doubles, British singles, guillemets, em-dash
 * paragraphs, play colons, continued paragraphs) and decides WHO speaks,
 * in priority order:
 *   0.  play/screenplay colon line — "FIRST WITCH: When shall we three…"
 *   0b. internal-monologue tag ("she thought") → Narrator reads it, softly
 *   0c. continued speech — a paragraph continuing an unclosed quote keeps
 *       the speaker of the paragraph that opened it
 *   1.  speech-verb tag with a name ("said Eleanor" / "Eleanor said"),
 *       matched ONLY in the tag zones: end of the preceding narration or
 *       start of the following narration (a previous quote's tag never leaks)
 *   1c. descriptive speaker ("said the other girl" / "the old man replied") —
 *       unnamed role-noun characters become speakers like "The Other Girl"
 *   1e. inverted pronoun tag ("said he") — archaic but common
 *   1f. "came the reply/was the answer" → the OTHER participant in the exchange
 *   1g. "came the voice of an old man" / "a woman's voice asked" → role speaker
 *   1h. joint tag ("said Eleanor and Thomas") → the first named speaker
 *   2.  pronoun tag ("she said") → matching-gender speaker from the recent
 *       turn stack, then the pass-1 roster, then the nearest mention
 *   2b. possessive action beat ("Her voice trembled.") → matching-gender speaker
 *   3.  action-beat role noun ("the boy hesitated" → the child speaks; the
 *       full role-noun catalog with a create-descriptive fallback)
 *   4.  nearest character mention right before the quote (action beat)
 *   4c. name-led action beat right after the quote ('"But I can!" Mary stood up.')
 *   4b. pronoun action beat touching the quote ('"…" He stepped inside.')
 *   5.  vocative inside the quote → the OTHER speaker in the exchange
 *   5c. letter/diary signature ("Yours sincerely, Eleanor") signs the quote
 *   6.  turn-taking across paragraph breaks: the previous spoken line's
 *       speaker yields to the other participant in the exchange
 *   7.  Narrator reads the quote aloud (safe default)
 * Every dialogue unit records WHICH rule decided it in `evidence`.
 * Skip sentinels (@@SKIP:reason@@…@@ENDSKIP@@) re-emerge as struck-through
 * script rows so the review UI can show exactly what will not be read.
 */
export interface AttributionHints {
  /** Every plausible speaker discovered by a first pass (first-appearance order). */
  roster?: string[];
  /** Precomputed name → gender (from full-text context). */
  genders?: Record<string, Gender>;
  /** OUTPUT: demographics of descriptive speakers created on the fly
   * ("The Other Girl", "The Soldiers") — filled during attribution so the
   * casting pass can give them the right voice. */
  descriptiveOut?: Map<string, { gender: Gender; age?: AgeBand; group?: boolean }>;
}

const SKIP_SENTINEL_RE = /@@SKIP:([a-z-]+)@@([\s\S]*?)@@ENDSKIP@@/g;
const KNOWN_SKIP_REASONS = new Set<SkipReason>([
  'page-number', 'running-head', 'toc', 'copyright', 'frontmatter', 'index', 'reference', 'footnote',
]);

/** "said he" / "asked she" — archaic inverted pronoun tags. */
const INVERTED_TAG_RE = new RegExp(`\\b(${VERBS})\\s+(she|he|they)\\b`, 'i');
/** "came the reply" / "was the answer" — headless responses. */
const HEADLESS_REPLY_RE = /\b(?:came|was)\s+the\s+(?:stern\s+|curt\s+|quick\s+|immediate\s+)?(reply|answer|response|retort|rejoinder|return)\b/i;
/** "came the voice of an old man" / "came a woman's voice" */
const VOICE_CAME_RE = new RegExp(
  `\\bcame\\s+(?:the\\s+)?(?:voice|voices)\\s+of\\s+(?:an?\\s+|the\\s+|one\\s+)?((?:[a-z]+\\s+){0,2}?(${ROLE_NOUNS_ALT}))\\b`
  + `|\\b(?:came|in)\\s+(?:an?\\s+)?((?:[a-z]+\\s+){0,2}?(?:${ROLE_NOUNS_ALT}))'s\\s+voice\\b`,
  'i',
);
/** Joint tag: "said Eleanor and Thomas" — attribute to the first, remember both. */
const JOINT_TAG_RE = new RegExp(`\\b(${VERBS})\\s+((?:${HONORIFIC_PREFIX})?${NAME_TOKEN})(?:\\s+(?:${HONORIFIC_PREFIX})?${NAME_TOKEN})?\\s+and\\s+(?:(?:${HONORIFIC_PREFIX})?${NAME_TOKEN})\\b`, 'i');
/** Possessive action beat touching a quote: "Her voice trembled." "His words died." */
const POSSESSIVE_BEAT_RE = /^["'“”‘’(\s]*(her|his|their)\s+(voice|words|tone|eyes|gaze|look|hand|hands|head|face|smile|brow|whisper|breath|heart|arms|lips|cheeks?|throat)\b/i;
/** Generalized action-beat role noun: "the innkeeper waddled over" → innkeeper speaks. */
const BEAT_ROLE_RE = new RegExp(`\\b(?:the|a|an|one)\\s+((?:[a-z]+\\s+){0,2}?(${ROLE_NOUNS_ALT}))\\b`, 'i');
/** Valid play label: all-caps words or title-case 1-3 words. */
function validPlayLabel(raw: string): string | null {
  const label = raw.replace(/\s+/g, ' ').trim();
  if (!label || label.length > 40) return null;
  const words = label.split(/\s+/);
  if (!words.length) return null;
  const allCaps = words.every((w) => w === w.toUpperCase() && /^[A-Z]/.test(w));
  const titleCase = words.length <= 3 && words.every((w) => /^[A-Z]/.test(w));
  if (!allCaps && !titleCase) return null;
  const real = words.filter((w) => w.length >= 1 && !NOT_A_NAME_WORDS.has(w.toLowerCase()) && !isHonorific(w));
  if (!real.length) return null;
  return words.map((w) => (isHonorific(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
}

export function attributeDialogue(text: string, knownNames: string[], hints?: AttributionHints): ScriptUnit[] {
  const units: ScriptUnit[] = [];
  const known = new Set(knownNames.map((n) => n.toLowerCase()));
  const roster = (hints?.roster ?? []).filter((n) => n !== 'Narrator');
  const genderHints = hints?.genders ?? {};
  const paragraphsRaw = text.split(/\n{2,}/);

  const recent: string[] = []; // most-recent-first stack of NAMED speakers
  /** Speaker of the last dialogue unit pushed (drives cross-paragraph turn-taking). */
  let lastDialogueSpeaker: string | null = null;
  /** Open multi-paragraph speech: the speaker + quote convention to continue. */
  let openSpeech: { speaker: string; convention: QuoteSpan['convention'] } | null = null;
  /** Demographics of descriptive speakers ("The Other Girl") created on the fly. */
  const descrMeta = new Map<string, { gender: Gender; age?: AgeBand; group?: boolean }>();
  const contexts = new Map<string, string[]>(); // name → context paragraphs (for demographics)
  const ageCache = new Map<string, AgeBand>();
  const descriptiveOut = hints?.descriptiveOut;
  let uidCounter = 0;

  const push = (u: Omit<ScriptUnit, 'id' | 'chapterIndex'>) => {
    units.push({ ...u, id: `u${uidCounter++}`, chapterIndex: 0 });
  };
  const rememberSpeaker = (name: string) => {
    const i = recent.indexOf(name);
    if (i > 0) recent.splice(i, 1);
    if (i !== 0) recent.unshift(name);
  };
  const contextsFor = (name: string): string[] => {
    if (!contexts.has(name)) contexts.set(name, paragraphsRaw.filter((p) => p.includes(name)).slice(0, 6));
    return contexts.get(name) ?? [];
  };
  const genderOf = (name: string): Gender =>
    descrMeta.get(name)?.gender ?? genderHints[name] ?? inferCharacterMeta(name, contextsFor(name)).gender;
  const ageOf = (name: string): AgeBand => {
    const d = descrMeta.get(name)?.age;
    if (d) return d;
    if (!ageCache.has(name)) ageCache.set(name, inferCharacterMeta(name, contextsFor(name)).ageBand);
    return ageCache.get(name) ?? 'unknown';
  };
  const validName = (raw: string): string | null => {
    const name = normSpace(raw);
    if (!name || name.length > 40) return null;
    const key = name.toLowerCase();
    if (STOP_WORDS.has(key)) return null;
    // unknown short tokens ("In came Mrs. Bennet") and furniture words are not names
    if (key.length < 3 && !known.has(key)) return null;
    if (NOT_A_NAME_WORDS.has(key) || COMMON_CAPITALIZED_NON_NAMES.has(key)) return null;
    const words = key.split(/\s+/);
    // a bare role noun ("Duchess said") is the descriptive path's job
    if (words.length === 1 && ROLE_NOUN_SET.has(key) && !known.has(key)) return null;
    // a bare honorific ("Mrs. said") is never a name
    if (words.every((w) => isHonorific(w.replace(/\.$/, '')))) return null;
    if (known.has(key) || CAPTURED_NAME_RE.test(name)) return name;
    return null;
  };
  /** recent turns first, then the pass-1 roster, then every discovered name —
   * deduped, order-stable. Discovered names let first-paragraph action beats
   * resolve ("Thomas smiled." → Thomas) before anyone has spoken. */
  const candidatePool = (): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of [...recent, ...roster, ...knownNames]) {
      const k = n.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(n); }
    }
    return out;
  };
  /** Last candidate mentioned within the final `limit` chars of `haystack`. */
  const nearestMention = (haystack: string, limit: number): string | null => {
    const zone = haystack.slice(-limit);
    let best: { name: string; idx: number } | null = null;
    for (const n of candidatePool()) {
      const m = new RegExp(`\\b${escapeName(n)}\\b`, 'i').exec(zone);
      if (m && (!best || m.index > best.idx)) best = { name: n, idx: m.index };
    }
    return best?.name ?? null;
  };
  const matchByDemographics = (gender: Gender, age?: AgeBand): string | null => {
    const pool = candidatePool();
    if (age) return pool.find((n) => genderOf(n) === gender && ageOf(n) === age) ?? null;
    return pool.find((n) => genderOf(n) === gender && ageOf(n) !== 'child' && ageOf(n) !== 'elder')
      ?? pool.find((n) => genderOf(n) === gender)
      ?? null;
  };
  /** The participant whose turn it is NOT: "came the reply" answers the last speaker. */
  const otherParticipant = (): string | null => {
    if (!recent.length) return null;
    if (lastDialogueSpeaker && recent[0] === lastDialogueSpeaker) return recent[1] ?? null;
    return recent[0];
  };

  for (const paraRaw of paragraphsRaw) {
    if (!paraRaw.trim()) continue;

    // split the paragraph at skip sentinels first
    const pieces: Array<{ kind: 'skip'; reason: SkipReason; text: string } | { kind: 'text'; text: string }> = [];
    let lastIdx = 0;
    SKIP_SENTINEL_RE.lastIndex = 0;
    let sm: RegExpExecArray | null;
    while ((sm = SKIP_SENTINEL_RE.exec(paraRaw))) {
      const before = paraRaw.slice(lastIdx, sm.index);
      if (before.trim()) pieces.push({ kind: 'text', text: before });
      const reason = sm[1] as SkipReason;
      pieces.push({ kind: 'skip', reason, text: sm[2].trim() });
      lastIdx = sm.index + sm[0].length;
    }
    const tail = paraRaw.slice(lastIdx);
    if (tail.trim()) pieces.push({ kind: 'text', text: tail });

    for (const piece of pieces) {
      if (piece.kind === 'skip') {
        push({
          kind: 'skip',
          speaker: '(skipped)',
          text: piece.text.slice(0, 200),
          skipReason: KNOWN_SKIP_REASONS.has(piece.reason) ? piece.reason : 'frontmatter',
        });
        openSpeech = null; // a skipped furniture block ends any continued speech
        continue;
      }

      const para = piece.text.replace(/\n/g, ' ').trim();
      if (!para) continue;

      // whole-paragraph chapter markers become silent units
      if (isChapterHeadingLine(para) || SOLO_HEADING_RE.test(para)) {
        push({ kind: 'skip', speaker: '(skipped)', text: para.slice(0, 120), skipReason: 'marker' });
        openSpeech = null;
        continue;
      }

      // (0) play / screenplay colon lines — handled per RAW line, because a
      // play paragraph holds several speaker lines ("FIRST WITCH: …\nSECOND WITCH: …")
      const paraLines = piece.text.split(/\n/).map((l) => l.trim()).filter(Boolean);
      const allPlay = paraLines.length > 0 && paraLines.every((l) => {
        const pm = PLAY_LINE_RE.exec(l);
        return !!pm && !!validPlayLabel(pm[1] ?? pm[2] ?? '') && normSpace(pm[3] ?? '').length > 0;
      });
      if (allPlay) {
        for (const line of paraLines) {
          const pm = PLAY_LINE_RE.exec(line);
          if (!pm) continue;
          const label = validPlayLabel(pm[1] ?? pm[2] ?? '');
          const speech = normSpace(pm[3] ?? '');
          if (!label || !speech) continue;
          push({ kind: 'dialogue', speaker: label, text: speech, evidence: 'play-colon' });
          rememberSpeaker(label);
          lastDialogueSpeaker = label;
        }
        openSpeech = null;
        continue;
      }

      const { segments, open } = splitQuoted(para, openSpeech?.convention ?? null);
      const paraQuotes = segments.filter((s) => s.kind === 'quote').length;
      let lastQuoteSpeaker: string | null = null;
      let lastQuoteUnclosed = false;

      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];

        if (seg.kind === 'narration') {
          // a heading glued at the start of a narration paragraph
          if (si === 0 && isChapterHeadingLine(normSpace(seg.text).split(/[.!?]/)[0] ?? '')) {
            push({ kind: 'skip', speaker: '(skipped)', text: normSpace(seg.text).slice(0, 120), skipReason: 'marker' });
            continue;
          }
          for (const chunk of chunkNarration(seg.text)) {
            // Orphaned dialogue tags keep a dangling comma (", Mary said.") —
            // strip leading punctuation so narration reads cleanly.
            let cleaned = chunk.replace(/^[\s,;:—–-]+/, '');
            // Orphaned tag fragments ("Mary said.", "she whispered.", "said
            // the other girl.", "he thought.") were already consumed as
            // attribution evidence — reading them aloud duplicates the speaker
            // label, so drop them. Only next to a quote; mid-scene narration
            // keeps every sentence.
            const touchesQuote = (si > 0 && segments[si - 1].kind === 'quote')
              || (si + 1 < segments.length && segments[si + 1].kind === 'quote');
            if (cleaned && touchesQuote) {
              const kept = (cleaned.match(/[^.!?…]+[.!?…]*(?:["'’”)\]]+)?\s*/g) ?? [cleaned])
                .filter((s) => {
                  const t = normSpace(s);
                  return t && !PURE_TAG_RE.test(t) && !PURE_THOUGHT_RE.test(t);
                });
              cleaned = normSpace(kept.join(' '));
            }
            if (cleaned) push({ kind: 'narration', speaker: 'Narrator', text: cleaned });
            // A long narration block ends the turn-taking scene.
            if (cleaned && cleaned.length > 160) lastDialogueSpeaker = null;
          }
          continue;
        }

        // ----- dialogue attribution -----
        const span = seg.span;

        // (0c) continued speech — same speaker as the paragraph that opened it
        if (span?.convention === 'continued' && openSpeech) {
          const carriedSpeaker = openSpeech.speaker;
          push({ kind: 'dialogue', speaker: carriedSpeaker, text: normSpace(seg.text), evidence: 'continued-speech' });
          lastQuoteSpeaker = carriedSpeaker;
          lastQuoteUnclosed = span.unclosed === true;
          if (!span.unclosed) openSpeech = null;
          lastDialogueSpeaker = carriedSpeaker;
          continue;
        }

        const preRaw = si > 0 && segments[si - 1].kind === 'narration' ? segments[si - 1].text : '';
        const postRaw = si + 1 < segments.length && segments[si + 1].kind === 'narration' ? segments[si + 1].text : '';
        // dash convention: the tag usually trails INSIDE the span ("—Hello, she said.")
        let spanText = seg.text;
        let dashTagSpeaker: string | null = null;
        let dashEmotion: ScriptUnit['emotionHint'] | undefined;
        if (span?.convention === 'dash') {
          const tailSents = splitSentences(spanText);
          const tailSent = normSpace(tailSents[tailSents.length - 1] ?? '');
          // tag in its own sentence ("—Hello. she said.") or trailing clause
          // sharing the final sentence ("—Hello, Eleanor complained.")
          const DASH_CLAUSE_TAG_RE = new RegExp(
            `,\\s*((?:${HONORIFIC_PREFIX})?${NAME_TOKEN}|she|he|they|(?:the|a|an)\\s+${DESCRIPTIVE_WORDS})\\s+(${VERBS})\\b[^.!?…]*[.!?…]*\\s*$`, 'i');
          const clauseM = DASH_CLAUSE_TAG_RE.exec(spanText);
          if (clauseM && clauseM.index > 4) {
            const tagText = clauseM[0];
            const nameM = new RegExp(`^((?:${HONORIFIC_PREFIX})?${NAME_TOKEN})$`, 'i').exec(clauseM[1].trim());
            if (nameM) {
              dashTagSpeaker = validName(nameM[1].replace(/\s+/g, ' '));
              dashEmotion = EMOTION_BY_VERB[clauseM[2].toLowerCase()];
            } else if (/^(she|he|they)$/i.test(clauseM[1].trim())) {
              dashTagSpeaker = matchByDemographics(clauseM[1].toLowerCase() === 'she' ? 'female' : clauseM[1].toLowerCase() === 'he' ? 'male' : 'neutral');
              dashEmotion = EMOTION_BY_VERB[clauseM[2].toLowerCase()];
            } else {
              const dname = descriptiveName(clauseM[1].replace(/^\s*(?:the|a|an)\s+/i, ''));
              if (dname) {
                dashTagSpeaker = dname;
                if (!descrMeta.has(dname)) {
                  const meta = descriptiveMeta(clauseM[1]);
                  descrMeta.set(dname, meta);
                  descriptiveOut?.set(dname, meta);
                }
                dashEmotion = EMOTION_BY_VERB[clauseM[2].toLowerCase()];
              }
            }
            if (dashTagSpeaker) {
              spanText = normSpace(spanText.slice(0, clauseM.index));
            }
          }
          if (tailSents.length >= 2 && PURE_TAG_RE.test(tailSent)) {
            const after = new RegExp(`\\b(${VERBS})\\s+(${HONORIFIC_PREFIX})?(${NAME_TOKEN})`, 'i').exec(tailSent)
              ?? new RegExp(`(${HONORIFIC_PREFIX})?(${NAME_TOKEN})\\s+(${VERBS})\\b`, 'i').exec(tailSent);
            const dm = DESCR_AFTER_RE.exec(tailSent) ?? DESCR_BEFORE_RE.exec(tailSent);
            const pron = /\b(she|he)\s+(?:VERBS)\b/i.exec(tailSent);
            if (after && after[3]) {
              dashTagSpeaker = validName(`${after[2] ?? ''}${after[3]}`.replace(/\s+/g, ' '));
              dashEmotion = EMOTION_BY_VERB[after[1].toLowerCase()];
            } else if (after && after[2]) {
              dashTagSpeaker = validName(`${after[1] ?? ''}${after[2]}`.replace(/\s+/g, ' '));
            } else if (dm && descriptiveName(dm[2])) {
              dashTagSpeaker = descriptiveName(dm[2]);
              if (dashTagSpeaker && !descrMeta.has(dashTagSpeaker)) descrMeta.set(dashTagSpeaker, descriptiveMeta(dm[2]));
              dashEmotion = EMOTION_BY_VERB[dm[1].toLowerCase()];
            }
            // strip the tag sentence from the spoken text
            tailSents.pop();
            spanText = normSpace(tailSents.join(' '));
          }
        }

        const pre = normSpace(preRaw.slice(-160));
        const post = normSpace(postRaw.slice(0, 160));
        // TAG ZONES: a tag for THIS quote can only sit at the END of the
        // preceding narration ("Mary said, '…'") or the START of the following
        // narration ("'…', Mary said."). When the preceding narration sits
        // BETWEEN two quotes and its first sentence is a pure tag ("she said.",
        // ", said the girl."), that tag binds LEFT to the previous quote —
        // dropping it stops stale tags leaking into this quote's attribution.
        const preSegFull = normSpace(preRaw);
        const betweenQuotes = si >= 2 && segments[si - 2].kind === 'quote';
        let preBody = preSegFull;
        // Set when a stale left-binding tag was dropped from this quote's
        // context — the dropped tag belongs to the PREVIOUS quote, and an
        // untagged quote right after a tag sandwich is usually the SAME
        // speaker continuing ('"You must", said the girl. "You need rest."'),
        // unless a discourse marker opens a new turn ('"But I can!"').
        let droppedTag = false;
        {
          const cleaned = preSegFull.replace(/^[\s,;:!?—–-]+\s*/, '');
          const tagSents = splitSentences(cleaned);
          const first = normSpace(tagSents[0] ?? '');
          // A pure tag sentence at the START of a between-quotes fragment
          // binds to the PREVIOUS quote — drop it from this quote's context.
          if (betweenQuotes && first && PURE_TAG_RE.test(first)) {
            tagSents.shift();
            preBody = tagSents.join(' ');
            droppedTag = true;
          }
        }
        const preSents = splitSentences(preBody.slice(-200));
        const preLead = normSpace(preSents[preSents.length - 1] ?? '');
        const postSents = splitSentences(post);
        const postTag = normSpace(postSents[0] ?? '');
        let speaker: string | null = null;
        let evidence = 'fallback-narrator';
        let emotion: ScriptUnit['emotionHint'] | undefined;

        if (dashTagSpeaker) {
          speaker = dashTagSpeaker;
          evidence = 'tag-dash';
          emotion = dashEmotion;
        }

        // (0b) internal monologue:  "ABC", she thought. / Mary wondered, "…"
        //     A trailing thought tag decides immediately; a leading thought tag
        //     only when no speech tag follows the quote ('he lied' beats
        //     'Thomas thought about lying').
        const postHasSpeechTag = new RegExp(`\\b(${VERBS})\\b`, 'i').test(postTag);
        // "ABC," she thought. "You forget who taught you." — the follow-up
        // quote addressing a listener (you/your) is SPOKEN aloud, not thought.
        const thoughtSandwich = betweenQuotes
          && PURE_THOUGHT_RE.test(normSpace(splitSentences(preSegFull.replace(/^[\s,;:!?—–-]+\s*/, ''))[0] ?? ''))
          && /\b(you|your|yours|yourself)\b/i.test(seg.text);
        if (!speaker && !thoughtSandwich && (THOUGHT_RE.test(postTag) || (!postHasSpeechTag && THOUGHT_RE.test(preLead)))) {
          speaker = 'Narrator';
          evidence = 'thought-tag';
          emotion = 'soft';
        }
        // spoken override: "she thought." still names the speaker via the pronoun
        if (!speaker && thoughtSandwich) {
          const pron = new RegExp(`\\b(she|he)\\s+(${VERBS}|${THOUGHT_VERBS})\\b`, 'i').exec(preLead)
            ?? new RegExp(`\\b(she|he)\\s+(${VERBS}|${THOUGHT_VERBS})\\b`, 'i').exec(postTag);
          if (pron) {
            const want: Gender = pron[1].toLowerCase() === 'she' ? 'female' : 'male';
            speaker = matchByDemographics(want) ?? nearestMention(preBody.slice(-200), 200);
            if (speaker) evidence = 'thought-sandwich-spoken';
          }
        }

        // (1a) verb-then-name:  said Mrs. Coulter / asked Tom
        if (!speaker) {
          const after = new RegExp(`\\b(${VERBS})\\s+(${HONORIFIC_PREFIX})?(${NAME_TOKEN})`, 'i');
          const afterM = after.exec(postTag) ?? after.exec(preLead);
          if (afterM) {
            emotion = EMOTION_BY_VERB[afterM[1].toLowerCase()];
            speaker = validName(`${afterM[2] ?? ''}${afterM[3]}`.replace(/\s+/g, ' '));
            if (speaker) evidence = 'tag-after:name';
          }
        }

        // (1b) name-then-verb:  Mrs. Coulter said / Tom asked
        if (!speaker) {
          const before = new RegExp(`(${HONORIFIC_PREFIX})?(${NAME_TOKEN})\\s+(${VERBS})\\b`, 'i');
          const beforeM = before.exec(postTag) ?? before.exec(preLead);
          if (beforeM) {
            emotion = EMOTION_BY_VERB[beforeM[3].toLowerCase()];
            speaker = validName(`${beforeM[1] ?? ''}${beforeM[2]}`.replace(/\s+/g, ' '));
            if (speaker) evidence = 'tag-before:name';
          }
        }

        // (1c) verb-then-descriptive:  said the other girl / replied the old man
        if (!speaker) {
          const dm = DESCR_AFTER_RE.exec(postTag) ?? DESCR_AFTER_RE.exec(preLead);
          const name = dm ? descriptiveName(dm[2]) : null;
          if (dm && name) {
            emotion = EMOTION_BY_VERB[dm[1].toLowerCase()];
            speaker = name;
            evidence = 'tag-after:descriptive';
            if (!descrMeta.has(name)) {
              const meta = descriptiveMeta(dm[2]);
              descrMeta.set(name, meta);
              descriptiveOut?.set(name, meta);
            }
          }
        }

        // (1d) descriptive-then-verb:  the other girl said / the old man replied
        if (!speaker) {
          const dm = DESCR_BEFORE_RE.exec(postTag) ?? DESCR_BEFORE_RE.exec(preLead);
          const name = dm ? descriptiveName(dm[1]) : null;
          if (dm && name) {
            emotion = EMOTION_BY_VERB[dm[2].toLowerCase()];
            speaker = name;
            evidence = 'tag-before:descriptive';
            if (!descrMeta.has(name)) {
              const meta = descriptiveMeta(dm[1]);
              descrMeta.set(name, meta);
              descriptiveOut?.set(name, meta);
            }
          }
        }

        // (1e) inverted pronoun tag:  said he / asked she (archaic)
        if (!speaker) {
          const inv = INVERTED_TAG_RE.exec(postTag) ?? INVERTED_TAG_RE.exec(preLead);
          if (inv) {
            emotion = EMOTION_BY_VERB[inv[1].toLowerCase()];
            const want: Gender = inv[2].toLowerCase() === 'she' ? 'female' : inv[2].toLowerCase() === 'he' ? 'male' : 'neutral';
            speaker = matchByDemographics(want) ?? nearestMention(preBody.slice(-200), 200);
            if (speaker) evidence = 'tag-inverted-pronoun';
          }
        }

        // (1f) headless reply:  "No," came the reply. / "Never," was the answer.
        if (!speaker) {
          const hr = HEADLESS_REPLY_RE.exec(postTag) ?? HEADLESS_REPLY_RE.exec(preLead);
          if (hr) {
            const other = otherParticipant();
            speaker = other;
            if (speaker) evidence = 'headless-reply';
          }
        }

        // (1g) voice-came:  "Who's there?" came the voice of an old man.
        if (!speaker) {
          const vc = VOICE_CAME_RE.exec(postTag) ?? VOICE_CAME_RE.exec(preLead);
          const phrase = vc ? (vc[1] ?? vc[3] ?? '') : '';
          const name = phrase ? descriptiveName(phrase) : null;
          if (vc && name) {
            speaker = name;
            evidence = 'voice-came';
            if (!descrMeta.has(name)) {
              const meta = descriptiveMeta(phrase);
              descrMeta.set(name, meta);
              descriptiveOut?.set(name, meta);
            }
          }
        }

        // (1h) joint tag:  "Bravo!" said Eleanor and Thomas.
        if (!speaker) {
          const jm = JOINT_TAG_RE.exec(postTag) ?? JOINT_TAG_RE.exec(preLead);
          if (jm) {
            emotion = EMOTION_BY_VERB[jm[1].toLowerCase()];
            speaker = validName(`${jm[2]}`);
            if (speaker) {
              evidence = 'tag-joint';
              const second = validName(jm[3] ?? '');
              if (second && second !== speaker) rememberSpeaker(second);
            }
          }
        }

        // (2) pronoun tag:  she said / he asked
        if (!speaker) {
          const pron = new RegExp(`\\b(she|he)\\s+(${VERBS})\\b`, 'i');
          const pronM = pron.exec(postTag) ?? pron.exec(preLead);
          if (pronM) {
            emotion = EMOTION_BY_VERB[pronM[2].toLowerCase()];
            const want: Gender = pronM[1].toLowerCase() === 'she' ? 'female' : 'male';
            speaker = matchByDemographics(want) ?? nearestMention(preBody.slice(-200), 200);
            if (speaker) evidence = 'tag-pronoun';
          }
        }

        // (2b) possessive action beat touching the quote: "Her voice trembled."
        if (!speaker) {
          const pb = POSSESSIVE_BEAT_RE.exec(postTag) ?? POSSESSIVE_BEAT_RE.exec(preLead);
          if (pb) {
            const want: Gender = pb[1].toLowerCase() === 'her' ? 'female' : pb[1].toLowerCase() === 'his' ? 'male' : 'neutral';
            speaker = matchByDemographics(want);
            if (speaker) evidence = 'beat-possessive';
          }
        }

        // (3) action-beat role noun: "the boy hesitated" → the child speaks.
        //     Generalized over the full role-noun catalog; when no known
        //     candidate matches the demographics, the beat noun itself becomes
        //     a descriptive speaker ("The Innkeeper") so unnamed characters
        //     still get a voice.
        if (!speaker) {
          const bm = BEAT_ROLE_RE.exec(preBody) ?? BEAT_ROLE_RE.exec(preLead);
          if (bm) {
            const phrase = bm[1];
            const meta = descriptiveMeta(phrase);
            const name = descriptiveName(phrase);
            speaker = matchByDemographics(meta.gender, meta.age) ?? (meta.group || !name ? null : name);
            if (speaker === name && name && !descrMeta.has(name)) {
              descrMeta.set(name, meta);
              descriptiveOut?.set(name, meta);
            }
            if (speaker) evidence = 'beat-role-noun';
          }
        }

        // (4) nearest character mention right before the quote (action beat),
        //     again in the tag-stripped zone only.
        if (!speaker) {
          speaker = nearestMention(preBody.slice(-140), 140);
          if (speaker) evidence = 'beat-nearest-mention';
        }

        // (4c) name-led action beat right AFTER the quote:
        //     '"But I can!" Mary stood up.' — the actor touching the quote
        //     is almost always the one who just spoke.
        if (!speaker) {
          const leadM = new RegExp(`^(${HONORIFIC_PREFIX})?(${NAME_TOKEN}(?:\\s+${NAME_TOKEN})?)\\b`).exec(postTag);
          if (leadM) {
            speaker = validName(`${leadM[1] ?? ''}${leadM[2]}`.replace(/\s+/g, ' '));
            if (speaker) evidence = 'beat-after:name';
          }
        }

        // (4b) pronoun action beat touching the quote: '"…" He stepped inside.'
        //      or 'She glanced up. "…"' — the beat's actor is usually the speaker.
        if (!speaker) {
          const beatM = PRONOUN_BEAT_RE.exec(postTag) ?? PRONOUN_BEAT_RE.exec(preLead);
          if (beatM) {
            speaker = matchByDemographics(beatM[1].toLowerCase() === 'she' ? 'female' : 'male');
            if (speaker) evidence = 'beat-pronoun';
          }
        }

        // (5) vocative inside the quote → the OTHER speaker is talking
        if (!speaker && seg.text.length >= 8) {
          const addressed = vocativeNames(seg.text, [...recent, ...roster]);
          if (addressed.length) {
            const first = recent.find((n) => !addressed.some((a) => a.toLowerCase() === n.toLowerCase()));
            speaker = first ?? null;
            if (speaker) evidence = 'vocative';
          }
        }

        // (5c) letter/diary signature: "…Yours sincerely, Eleanor" signs the quote
        if (!speaker) {
          const sig = letterSignature(para);
          if (sig && known.has(sig.toLowerCase())) {
            speaker = knownNames.find((n) => n.toLowerCase() === sig.toLowerCase()) ?? null;
            if (speaker) evidence = 'letter-signature';
          }
        }

        // (6) turn-taking vs continuation. After a dropped tag sandwich the
        //     untagged quote is normally the SAME speaker continuing ('"You
        //     must", said the girl. "You need rest."'); a discourse marker at
        //     the quote's head signals a NEW turn instead ('"But I can!"').
        //     Without a tag sandwich, an untagged quote in an exchange belongs
        //     to the OTHER recent speaker — across paragraph breaks too, as
        //     long as the previous spoken line came from the turn-holder.
        if (!speaker && droppedTag && !TURN_MARKER_RE.test(seg.text) && recent.length >= 1) {
          speaker = recent[0];
          if (speaker) evidence = 'tag-sandwich-continuation';
        }
        if (!speaker && recent.length >= 2 && (paraQuotes >= 2 || lastDialogueSpeaker === recent[0])) {
          speaker = recent[1];
          if (speaker) evidence = 'turn-taking';
        }

        // (7) fallback — the Narrator reads the quote
        if (!speaker) speaker = 'Narrator';

        if (speaker !== 'Narrator') rememberSpeaker(speaker);
        push({ kind: 'dialogue', speaker, text: normSpace(spanText), emotionHint: emotion, evidence });
        lastQuoteSpeaker = speaker;
        lastQuoteUnclosed = span?.unclosed === true;
        lastDialogueSpeaker = speaker;
      }

      // keep multi-paragraph speech open with the speaker who holds the floor
      if (lastQuoteSpeaker && lastQuoteUnclosed && open) {
        openSpeech = { speaker: lastQuoteSpeaker, convention: open };
      } else if (open && lastQuoteSpeaker && segments.some((s) => s.kind === 'quote')) {
        openSpeech = { speaker: lastQuoteSpeaker, convention: open };
      } else if (!open) {
        openSpeech = null;
      }
    }
  }

  return units;
}

const CAPTURED_NAME_RE = new RegExp(`^(?:${HONORIFIC_PREFIX})?[A-Z][\\w'’-]*(?:\\s+[A-Z][\\w'’-]*){0,2}$`);

// ============================================================
// 4. The one-call pipeline
// ============================================================

function guessMeta(text: string, structure: 'chapters' | 'sections' | 'plain'): AutobookMeta {
  const lines = text.split(/\r?\n/).map((l) => normSpace(l)).filter(Boolean).slice(0, 60);
  let titleGuess = 'Untitled Book';
  for (const l of lines) {
    if (/^(project gutenberg|the project gutenberg|\*\*\*)/i.test(l)) continue;
    if (l.length >= 3 && l.length <= 80 && !/[.!?]$/.test(l)) {
      titleGuess = l;
      break;
    }
  }
  let authorGuess: string | undefined;
  for (const l of lines) {
    const by = /^by\s+([A-Z][\w .''-]{2,40})$/.exec(l);
    const author = /^(?:author|written by)[:\s]+([A-Z][\w .''-]{2,40})$/i.exec(l);
    if (by) { authorGuess = by[1].trim(); break; }
    if (author) { authorGuess = author[1].trim(); break; }
  }
  const language = /[\u0400-\u04FF]/.test(text.slice(0, 2000)) ? 'ru'
    : /[\u4e00-\u9fff]/.test(text.slice(0, 2000)) ? 'zh'
    : /[\u3040-\u30ff]/.test(text.slice(0, 2000)) ? 'ja'
    : /[\u0600-\u06FF]/.test(text.slice(0, 2000)) ? 'ar'
    : /[\u0900-\u097F]/.test(text.slice(0, 2000)) ? 'hi'
    : 'en';
  return { titleGuess, authorGuess, language, structure };
}

/** Title strings whose bearers must never merge with a bare surname. */
const FEMALE_TITLES = new Set(
  ('mrs miss ms madam madame mademoiselle lady dame mistress aunt auntie aunty grandmother grandma granny '
   + 'grannie nana nanna sister mother nurse matron widow goodwife goody memsahib begum srimati rani maharani '
   + 'sultana tsarina kaiserin empress queen princess duchess baroness marchioness marchioness viscountess '
   + 'countess abbess signora senora senhora frau frau mevron mevr nonna abuela oma babushka pan pani gospozha').split(/\s+/),
);

/**
 * Deterministic alias merge for character-name display: "Mrs. Coulter" and
 * "Coulter" unify to the fuller form; "Miss Bingley" and "Bingley" do NOT
 * merge. Rule: A merges into B when
 *   - A's LAST token equals B's last token (case-insensitive), and
 *   - one of them has no honorific and the other's honorific is not
 *     female-coded (a bare surname may be the Mr. or the Miss — only merge
 *     toward a male/neutral-titled or longer plain form), and
 *   - the fuller form is at least as long.
 * Returns normalised-lowercase alias → canonical display name.
 */
function buildAliasMerge(names: string[]): Map<string, string> {
  const merge = new Map<string, string>();
  const titleOf = (n: string): { title: string; rest: string } => {
    const words = n.replace(/\s+/g, ' ').trim().split(/\s+/);
    const first = words[0]?.replace(/\.$/, '').toLowerCase() ?? '';
    if (words.length >= 2 && isHonorific(first)) return { title: first, rest: words.slice(1).join(' ') };
    return { title: '', rest: words.join(' ') };
  };
  const byLast = new Map<string, string[]>();
  for (const n of names) {
    const words = n.replace(/\s+/g, ' ').trim().split(/\s+/);
    if (!words.length) continue;
    const last = words[words.length - 1].toLowerCase().replace(/[^\w'’-]/g, '');
    if (!last) continue;
    byLast.set(last, [...(byLast.get(last) ?? []), n]);
  }
  for (const [, group] of byLast) {
    if (group.length < 2) continue;
    // prefer the longest form as canonical; tie-break by input order (stable)
    const sorted = [...group].sort((a, b) => b.length - a.length || group.indexOf(a) - group.indexOf(b));
    const canonical = sorted[0];
    const canTitle = titleOf(canonical);
    for (const alias of sorted.slice(1)) {
      const aTitle = titleOf(alias);
      if (aTitle.rest.toLowerCase() !== canTitle.rest.toLowerCase()) continue;
      if (aTitle.title && canTitle.title && aTitle.title !== canTitle.title) continue; // Mrs. vs Dr. — different people
      if (!aTitle.title && canTitle.title && FEMALE_TITLES.has(canTitle.title)) continue; // "Bingley" ≠ "Miss Bingley"
      if (!canTitle.title && aTitle.title && FEMALE_TITLES.has(aTitle.title)) continue;
      merge.set(alias.toLowerCase(), canonical);
    }
  }
  return merge;
}

/**
 * One call: raw book text → genre verdict, skip plan, attributed
 * script, chapter map and a fully cast voice lineup. Deterministic.
 */
export function buildAudiobookScript(text: string, profiles: VoiceProfileDef[], opts?: AutobookOptions): AutobookResult {
  const emptyStats: AutobookStats = { words: 0, skippedWords: 0, skippedUnits: 0, dialogueUnits: 0, narrationUnits: 0, speakers: 0, estMinutes: 0 };
  if (!text || !text.trim()) {
    return {
      verdict: { kind: 'non-fiction', confidence: 0, signals: [], reasons: ['No text to analyze'] },
      units: [], chapters: [], cast: [], stats: emptyStats,
      meta: { titleGuess: 'Untitled Book', language: 'en', structure: 'plain' },
    };
  }

  const { lines } = analyzeStructure(text);
  // Skip lines become @@SKIP@@ sentinels (they re-emerge as struck-through
  // script rows with their reason); chapter headings stay so they become
  // silent chapter markers inside the attributed stream.
  const speakable = lines
    .map((l) => {
      if (l.skip === 'blank') return '';
      if (l.skip === 'marker') return l.text;
      if (l.skip) return `@@SKIP:${l.skip}@@${normSpace(l.text).slice(0, 200)}@@ENDSKIP@@`;
      return l.text;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const skippedSource = lines.filter((l) => l.skip && l.skip !== 'blank' && l.skip !== 'marker').map((l) => l.text).join('\n');

  const verdict = opts?.genre === 'force-fiction' ? { ...classifyGenre(text), kind: 'fiction' as const }
    : opts?.genre === 'force-nonfiction' ? { ...classifyGenre(text), kind: 'non-fiction' as const }
    : classifyGenre(text);

  const descriptive = new Map<string, { gender: Gender; age?: AgeBand; group?: boolean }>();
  const names = discoverCharacterNames(speakable, { maxNames: opts?.maxNames });
  // Alias unification: "Coulter" and "Mrs. Coulter" are one speaker. A name
  // merges into a fuller form when its last token matches and the title class
  // is compatible (never across female-coded titles — "Miss Bingley" is NOT
  // "Bingley"). The merged display keeps the fuller, more frequent form.
  const aliasMerge = buildAliasMerge(names);
  const resolveAlias = (n: string): string => aliasMerge.get(n.toLowerCase()) ?? n;
  // pass 1 discovers the speaking roster; pass 2 resolves pronoun tags
  // against it plus full-text genders — the two-pass trick that lets
  // "she said" resolve on the very first line of a book.
  const pass1 = attributeDialogue(speakable, names, { descriptiveOut: descriptive });
  for (const u of pass1) {
    if (u.kind === 'dialogue' && u.speaker !== 'Narrator') u.speaker = resolveAlias(u.speaker);
  }
  const roster = [...new Set(pass1.filter((u) => u.kind === 'dialogue' && u.speaker !== 'Narrator').map((u) => u.speaker))];
  const snippetSource = speakable
    .split(/\n{2,}/)
    // narration-only contexts: quoted dialogue is blanked out at its exact
    // offsets (a vocative like "How old is the lens, Tomas?" is not narration
    // about Tomas — and must not leak Pip's "ten years old" into his zone)
    .map((p) => p.replace(/“[^”\n]*”|"[^"\n]*"/g, (m) => ' '.repeat(m.length)))
    .map((p) => p.replace(/‘[^’\n]*’|«[^»\n]*»/g, (m) => ' '.repeat(m.length)));
  const genders: Record<string, Gender> = {};
  for (const n of [...roster, ...names]) {
    if (!(n in genders)) genders[n] = inferCharacterMeta(n, snippetSource.filter((p) => p.includes(n)).slice(0, 6)).gender;
  }
  let units = attributeDialogue(speakable, names, { roster, genders, descriptiveOut: descriptive });
  for (const u of units) {
    if (u.kind === 'dialogue' && u.speaker !== 'Narrator') u.speaker = resolveAlias(u.speaker);
  }

  // Non-fiction: every line is the Narrator's — quotes stay inline narration.
  if (verdict.kind === 'non-fiction') {
    units = units.map((u) => (u.kind === 'dialogue' ? { ...u, kind: 'narration' as const, speaker: 'Narrator' } : u));
  }

  // chapter indices walk the marker units in order
  const chapters: BookChapter[] = [];
  if (opts?.detectChapters !== false) {
    let chapterIndex = -1;
    let seenBody = false;
    for (const u of units) {
      if (u.kind === 'skip' && u.skipReason === 'marker') {
        // markers before any spoken content open chapter 0 silently
        chapterIndex = seenBody ? chapterIndex + 1 : Math.max(0, chapterIndex + 1);
        chapters.push({ title: u.text, startUnit: units.indexOf(u) });
        continue;
      }
      if (u.kind !== 'skip') {
        if (chapterIndex < 0) chapterIndex = 0;
        seenBody = true;
      }
      u.chapterIndex = Math.max(0, chapterIndex);
    }
    if (!chapters.length) chapters.push({ title: 'Opening', startUnit: 0 });
  } else {
    for (const u of units) u.chapterIndex = 0;
  }

  // ----- casting -----
  const quoteCounts = new Map<string, number>();
  for (const u of units) {
    if (u.kind === 'dialogue' && u.speaker !== 'Narrator') quoteCounts.set(u.speaker, (quoteCounts.get(u.speaker) ?? 0) + 1);
  }
  const ranked = [...quoteCounts.entries()].sort((a, b) => b[1] - a[1]);
  // Every character keeps a voice by default — the formant engine
  // differentiates reused profiles by rate/pitch so casts far larger than the
  // profile catalog still sound distinct. The cap is only a user-facing
  // guardrail (maxCast option / UI slider) for absurdly large rosters.
  const maxCast = Math.max(1, opts?.maxCast ?? 48);
  const featured = ranked.slice(0, maxCast).map(([name]) => name);
  const folded = ranked.slice(maxCast).map(([name]) => name);
  // minor speakers beyond the cap read as the Narrator
  if (folded.length) {
    const fold = new Set(folded);
    units = units.map((u) => (u.kind === 'dialogue' && fold.has(u.speaker) ? { ...u, speaker: 'Narrator' } : u));
  }

  const cast: BookCastMember[] = [];
  const taken = new Set<string>();
  const narratorProfile = profiles.find((p) => p.id === 'atlas-narrator') ?? profiles.find((p) => p.id === 'nova-narrator') ?? profiles[0];
  const narratorMeta = withRole(
    {
      name: 'Narrator',
      gender: narratorProfile?.gender === 'female' ? 'female' : narratorProfile?.gender === 'male' ? 'male' : 'neutral',
      ageBand: 'unknown',
      role: 'narrator',
      evidence: ['the book’s narration voice'],
    },
    'narrator',
  );
  const narratorCast = castVoiceFor(narratorMeta, profiles, taken);
  cast.push({ name: 'Narrator', meta: narratorMeta, ...narratorCast });

  for (const name of featured) {
    const quotes = quoteCounts.get(name) ?? 0;
    const contexts = snippetSource.filter((p) => p.includes(name)).slice(0, 6);
    const descr = descriptive.get(name);
    const baseMeta = inferCharacterMeta(name, contexts);
    const meta: CharacterMeta = descr
      ? { ...baseMeta, gender: descr.gender, ageBand: descr.age ?? baseMeta.ageBand, group: descr.group }
      : baseMeta;
    const role: CharacterMeta['role'] = quotes >= 3 || (quotes >= 2 && featured.length <= 4) ? 'major' : 'minor';
    const assignment: CastAssignment = castVoiceFor(withRole(meta, role), profiles, taken);
    cast.push({ name, meta: withRole(meta, role), ...assignment });
  }

  // re-map speaker names → display casing used in cast (names discovered mid-text keep their original casing)
  const display = new Map(cast.map((c) => [c.name.toLowerCase(), c.name]));
  for (const u of units) {
    if (u.speaker !== 'Narrator' && u.speaker !== '(skipped)') {
      const d = display.get(u.speaker.toLowerCase());
      if (d) u.speaker = d;
    }
  }

  const speakableUnits = units.filter((u) => u.kind !== 'skip');
  const words = speakableUnits.reduce((a, u) => a + countWords(u.text), 0);
  const skippedWords = countWords(skippedSource);
  const stats: AutobookStats = {
    words,
    skippedWords,
    skippedUnits: units.filter((u) => u.kind === 'skip' && u.skipReason !== 'blank').length,
    dialogueUnits: units.filter((u) => u.kind === 'dialogue').length,
    narrationUnits: units.filter((u) => u.kind === 'narration').length,
    speakers: new Set(speakableUnits.filter((u) => u.kind === 'dialogue').map((u) => u.speaker)).size,
    estMinutes: words / 155,
  };

  const meta = guessMeta(text, chapters.length >= 2 ? 'chapters' : 'plain');
  return { verdict, units, chapters, cast, stats, meta };
}

// ============================================================
// 5. Handoff helpers
// ============================================================

/** "Name: line" rows — pastes straight into Dialogue Studio. */
export function toDialogueFormat(units: ScriptUnit[]): string {
  return units
    .filter((u) => u.kind !== 'skip' && u.text.trim())
    .map((u) => `${u.speaker}: ${u.text}`)
    .join('\n');
}

/**
 * Wrap a line with voice markup for its emotion hint — the delivery
 * direction the "AI director" gives each line before synthesis.
 */
export function withEmotionMarkup(text: string, hint?: ScriptUnit['emotionHint']): string {
  if (!hint) return text;
  switch (hint) {
    case 'whisper': return `[whisper]${text}[/whisper]`;
    case 'soft': return `[rate 0.94]${text}[/rate]`;
    case 'urgent': return `[em]${text}[/em]`;
    default: return text;
  }
}
