// ============================================================
// Openmukti Audiobook Creator — AutoBook pipeline intelligence
// ("lightweight AI", part 2 of 2 — orchestrator).
//
// Turns raw book text into a cast-narrated audiobook script:
//   1. classifyGenre      fiction vs non-fiction from stylistic signals
//   2. analyzeStructure   page numbers, TOC, running heads, copyright,
//                         index and references → marked "do not read"
//   3. attributeDialogue  who says each quoted line (tag verbs, pronoun
//                         resolution, vocatives, alternation)
//   4. casting            via autobook-cast.ts demographics + profiles
//
// 100% local, zero-download: this IS the lightweight model — a
// deterministic, explainable NLP engine (every decision carries
// evidence). No network, no DOM, no randomness: the same book always
// produces the identical script.
// ============================================================
import type { VoiceProfileDef } from '@/lib/types';
import { castVoiceFor, inferCharacterMeta, withRole, type AgeBand, type CastAssignment, type CharacterMeta, type Gender } from '@/lib/engines/autobook-cast';

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
// Multi-word tags ("went on", "called out") must come first so the regex
// alternation matches them before their single-word prefixes.
const VERBS = 'went on|put in|broke in|cut in|called out|cried out|spoke up'
  + '|said|asked|replied|repeated|answered|returned|retorted|countered|objected|protested|insisted|suggested|agreed|admitted|confessed|promised|explained|complained|urged|offered|lied|joked|teased|pleaded|begged|ordered|warned|threatened|reassured|comforted|informed|announced|observed|commented|stated|affirmed|asserted|mentioned|volunteered|quipped|chuckled|laughed|sighed|sobbed|wept|shouted|whispered|muttered|exclaimed|cried|demanded|continued|began|added|called|remarked|declared|murmured|growled|hissed|snapped|breathed|screamed|yelled|bellowed|roared|shrieked|stammered|stuttered|mouthed';
const VERB_RE = new RegExp(`\\b(${VERBS})\\b`, 'gi');
/** Internal-monologue verbs: "he thought" means the quote is NOT spoken aloud.
 * THOUGHT_RE itself is built after NAME_TOKEN (below) to avoid TDZ issues. */
const THOUGHT_VERBS = 'thought|wondered|mused|pondered|reflected|realised|realized|decided|figured';
/**
 * Descriptive (unnamed) speakers: "said the other girl", "replied the old
 * man", "the little boy answered". The captured phrase must END in a
 * recognised role noun so tags like "said the next morning" are rejected.
 */
const ROLE_NOUN_SET = new Set([
  'girl', 'boy', 'man', 'woman', 'child', 'kid', 'children', 'lady', 'gentleman', 'witch', 'wizard',
  'princess', 'prince', 'king', 'queen', 'maid', 'nun', 'monk', 'friar', 'mistress', 'master',
  'sister', 'brother', 'mother', 'father', 'grandmother', 'grandfather', 'granny', 'grandpa', 'aunt', 'uncle',
  'daughter', 'son', 'bride', 'groom', 'waitress', 'waiter', 'actress', 'actor', 'duchess', 'duke',
  'countess', 'count', 'lord', 'squire', 'hostess', 'host', 'housekeeper', 'nurse', 'doctor',
  'soldier', 'sailor', 'guard', 'cook', 'farmer', 'merchant', 'stranger', 'traveller', 'traveler',
  'hunter', 'fisherman', 'shepherd', 'innkeeper', 'shopkeeper', 'miller', 'baker', 'tailor',
  'blacksmith', 'carpenter', 'knight', 'servant', 'slave', 'captive', 'prisoner', 'giant', 'dwarf',
  'elf', 'fairy', 'dragon', 'wolf', 'fox', 'cat', 'dog', 'bird', 'owl', 'crow', 'raven', 'lion',
  'bear', 'horse', 'pony', 'voice', 'creature', 'figure', 'shadow', 'officer', 'captain', 'teacher',
  'priest', 'driver', 'passenger', 'visitor', 'guest', 'neighbour', 'neighbor', 'twin', 'baby', 'infant',
]);
const DESCRIPTIVE_WORDS = String.raw`[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3}`;
const DESCR_AFTER_RE = new RegExp(`\\b(${VERBS})\\s*,?\\s*(?:the|a|an|this|that)\\s+(${DESCRIPTIVE_WORDS})`, 'i');
const DESCR_BEFORE_RE = new RegExp(`\\b(?:the|a|an|this|that)\\s+(${DESCRIPTIVE_WORDS})\\s+(${VERBS})\\b`, 'i');

/** Gender/age inference for a descriptive phrase like "the other girl". */
function descriptiveMeta(phrase: string): { gender: Gender; age?: AgeBand } {
  const p = phrase.toLowerCase();
  const age: AgeBand | undefined = /\b(girl|boy|child|kid|children|little|small|young|baby|infant)\b/.test(p)
    ? 'child'
    : /\b(old|elderly|aged|ancient|grey|gray|white)\b/.test(p) ? 'elder' : undefined;
  const gender: Gender = /\b(girl|woman|women|lady|ladies|witch|princess|queen|maid|nun|mistress|sister|mother|grandmother|granny|aunt|daughter|bride|waitress|actress|duchess|countess|hostess|housekeeper|nurse)\b/.test(p)
    ? 'female'
    : /\b(boy|man|men|gentleman|gentlemen|prince|king|monk|friar|brother|father|grandfather|grandpa|uncle|son|groom|waiter|actor|duke|count|lord|master|squire|host|wizard)\b/.test(p)
      ? 'male'
      : 'neutral';
  return { gender, age };
}

/** "other girl" → "The Other Girl" when the phrase ends in a role noun; else null. */
function descriptiveName(phrase: string): string | null {
  const words = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return null;
  if (!ROLE_NOUN_SET.has(words[words.length - 1])) return null;
  // reject phrases that are clearly not people/characters
  if (words.some((w) => /^(morning|evening|afternoon|night|day|week|month|year|time|moment|end|rest|sound|sight|thought)$/.test(w))) return null;
  return 'The ' + words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const QUOTE_RE = /“([^”\n]{1,600})”|"([^"\n]{1,600})"/g;

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

const EMOTION_BY_VERB: Record<string, ScriptUnit['emotionHint']> = {
  whispered: 'whisper', murmured: 'soft', muttered: 'soft', breathed: 'soft', mouthed: 'whisper',
  sobbed: 'soft', wept: 'soft', pleaded: 'soft', begged: 'soft', comforted: 'soft', reassured: 'soft',
  shouted: 'urgent', cried: 'urgent', called: 'urgent', demanded: 'urgent', growled: 'urgent', snapped: 'urgent', hissed: 'urgent',
  screamed: 'urgent', yelled: 'urgent', bellowed: 'urgent', roared: 'urgent', shrieked: 'urgent', threatened: 'urgent',
  protested: 'urgent', objected: 'urgent', 'cried out': 'urgent', 'called out': 'urgent',
  asked: 'curious', wondered: 'curious', teased: 'curious', quipped: 'curious', chuckled: 'soft', laughed: 'soft',
};

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

/** Title-honorific prefix optionally glued before a name. */
const TITLE_PREFIX = String.raw`(?:Mr|Mrs|Miss|Ms|Dr|Sir|Lady|Lord|Aunt|Uncle|Captain|Professor|Doctor)\.?\s+`;
const NAME_TOKEN = String.raw`[A-Z][\w'-]{1,20}`;

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
 * Find plausible character names: capitalized tokens that appear
 * mid-sentence (never sentence-initial only), next to a speech verb or
 * at least twice, optionally behind an honorific. Deterministic; capped.
 */
export function discoverCharacterNames(text: string): string[] {
  const sample = text.slice(0, 120_000);
  const midSentence = new Map<string, number>();
  const sentences = sample.split(/(?<=[.!?…])\s+/);
  for (const sent of sentences) {
    // find capitalized tokens NOT at position 0 of the sentence
    const re = new RegExp(`(^|[^.!?…\\s]\\s)(${TITLE_PREFIX})?(${NAME_TOKEN})(?:\\s+${NAME_TOKEN})?`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(sent))) {
      const full = ((m[2] ?? '') + m[3]).replace(/\s+/g, ' ').trim();
      if (STOP_WORDS.has(m[3].toLowerCase())) continue;
      const token = m[3];
      if (token.length >= 3 && token[0] === token[0].toUpperCase() && /[a-z]/.test(token)) {
        midSentence.set(full, (midSentence.get(full) ?? 0) + 1);
      }
    }
  }
  const names: string[] = [];
  for (const [name, count] of midSentence) {
    // keep names seen ≥2× mid-sentence OR seen once next to a speech verb
    const esc = escapeName(name);
    const nearVerb = new RegExp(`\\b(?:${VERBS})\\s+${esc}\\b|\\b${esc}\\s+(?:${VERBS})\\b`, 'i');
    if (count >= 2 || nearVerb.test(sample)) names.push(name);
    if (names.length >= 24) break;
  }
  return names;
}

function escapeName(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Segment {
  kind: 'narration' | 'quote';
  text: string;
}

function splitQuoted(paragraph: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  QUOTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUOTE_RE.exec(paragraph))) {
    const before = paragraph.slice(last, m.index);
    if (normSpace(before)) segments.push({ kind: 'narration', text: before });
    segments.push({ kind: 'quote', text: m[1] ?? m[2] ?? '' });
    last = m.index + m[0].length;
  }
  const tail = paragraph.slice(last);
  if (normSpace(tail)) segments.push({ kind: 'narration', text: tail });
  return segments;
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
 * The attribution engine. Walks paragraphs, extracts quoted spans and
 * decides WHO speaks, in priority order:
 *   0. internal-monologue tag ("she thought") → Narrator reads it, softly
 *   1. speech-verb tag with a name ("said Eleanor" / "Eleanor said") —
 *      matched ONLY in the tag zones: end of the preceding narration or
 *      start of the following narration (a previous quote's tag never leaks)
 *   1c. descriptive speaker ("said the other girl" / "the old man replied") —
 *      unnamed role-noun characters become speakers like "The Other Girl"
 *   2. pronoun tag ("she said") → matching-gender speaker from the recent
 *      turn stack, then the pass-1 roster, then the nearest mention
 *   3. action-beat role noun ("the boy hesitated" → the child speaks)
 *   4. nearest character mention right before the quote (action beat)
 *   5. vocative inside the quote → the other speaker in the exchange
 *   6. turn-taking across paragraph breaks: the previous spoken line's
 *      speaker yields to the other participant in the exchange
 *   7. Narrator reads the quote aloud (safe default)
 * Skip sentinels (@@SKIP:reason@@…@@ENDSKIP@@) re-emerge as struck-through
 * script rows so the review UI can show exactly what will not be read.
 */
export interface AttributionHints {
  /** Every plausible speaker discovered by a first pass (first-appearance order). */
  roster?: string[];
  /** Precomputed name → gender (from full-text context). */
  genders?: Record<string, Gender>;
}

/** Action-beat role nouns: narration like "the boy hesitated at the door" implies the child speaks next. */
const BEAT_NOUNS: ReadonlyArray<{ re: RegExp; gender: Gender; age?: AgeBand }> = [
  { re: /\b(?:the|a|one)\s+(?:young|little|small)\s+boy\b/i, gender: 'male', age: 'child' },
  { re: /\b(?:the|a|one)\s+(?:young|little|small)\s+girl\b/i, gender: 'female', age: 'child' },
  { re: /\bthe\s+boy\b/i, gender: 'male', age: 'child' },
  { re: /\bthe\s+girl\b/i, gender: 'female', age: 'child' },
  { re: /\b(?:the|an?)\s+old\s+man\b/i, gender: 'male', age: 'elder' },
  { re: /\b(?:the|an?)\s+old\s+woman\b/i, gender: 'female', age: 'elder' },
  { re: /\bthe\s+man\b/i, gender: 'male' },
  { re: /\bthe\s+woman\b/i, gender: 'female' },
];

const SKIP_SENTINEL_RE = /@@SKIP:([a-z-]+)@@([\s\S]*?)@@ENDSKIP@@/g;
const KNOWN_SKIP_REASONS = new Set<SkipReason>([
  'page-number', 'running-head', 'toc', 'copyright', 'frontmatter', 'index', 'reference', 'footnote',
]);

export function attributeDialogue(text: string, knownNames: string[], hints?: AttributionHints): ScriptUnit[] {
  const units: ScriptUnit[] = [];
  const known = new Set(knownNames.map((n) => n.toLowerCase()));
  const roster = (hints?.roster ?? []).filter((n) => n !== 'Narrator');
  const genderHints = hints?.genders ?? {};
  const paragraphsRaw = text.split(/\n{2,}/);

  const recent: string[] = []; // most-recent-first stack of NAMED speakers
  /** Speaker of the last dialogue unit pushed (drives cross-paragraph turn-taking). */
  let lastDialogueSpeaker: string | null = null;
  /** Demographics of descriptive speakers ("The Other Girl") created on the fly. */
  const descrMeta = new Map<string, { gender: Gender; age?: AgeBand }>();
  const contexts = new Map<string, string[]>(); // name → context paragraphs (for demographics)
  const ageCache = new Map<string, AgeBand>();
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
    if (!name || name.length > 28) return null;
    const key = name.toLowerCase();
    if (STOP_WORDS.has(key)) return null;
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
        continue;
      }

      const para = piece.text.replace(/\n/g, ' ').trim();
      if (!para) continue;

      // whole-paragraph chapter markers become silent units
      if (isChapterHeadingLine(para) || SOLO_HEADING_RE.test(para)) {
        push({ kind: 'skip', speaker: '(skipped)', text: para.slice(0, 120), skipReason: 'marker' });
        continue;
      }

      const segments = splitQuoted(para);
      const paraQuotes = segments.filter((s) => s.kind === 'quote').length;

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
        const preRaw = si > 0 && segments[si - 1].kind === 'narration' ? segments[si - 1].text : '';
        const postRaw = si + 1 < segments.length && segments[si + 1].kind === 'narration' ? segments[si + 1].text : '';
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
          const tagSents = cleaned.match(/[^.!?…]+[.!?…]*\s*/g) ?? [];
          const first = normSpace(tagSents[0] ?? '');
          // A pure tag sentence at the START of a between-quotes fragment
          // binds to the PREVIOUS quote — drop it from this quote's context.
          if (betweenQuotes && first && PURE_TAG_RE.test(first)) {
            tagSents.shift();
            preBody = tagSents.join(' ');
            droppedTag = true;
          }
        }
        const preSents = preBody.slice(-160).match(/[^.!?…]+[.!?…]*\s*/g) ?? [preBody.slice(-160)];
        const preLead = normSpace(preSents[preSents.length - 1] ?? '');
        const postSents = post.match(/[^.!?…]+[.!?…]*\s*/g) ?? [post];
        const postTag = normSpace(postSents[0] ?? '');
        let speaker: string | null = null;
        let emotion: ScriptUnit['emotionHint'] | undefined;

        // (0) internal monologue:  "ABC", she thought. / Mary wondered, "…"
        //     A trailing thought tag decides immediately; a leading thought tag
        //     only when no speech tag follows the quote ('he lied' beats
        //     'Thomas thought about lying').
        const postHasSpeechTag = new RegExp(`\\b(${VERBS})\\b`, 'i').test(postTag);
        if (THOUGHT_RE.test(postTag) || (!postHasSpeechTag && THOUGHT_RE.test(preLead))) {
          speaker = 'Narrator';
          emotion = 'soft';
        }

        // (1a) verb-then-name:  said Mrs. Coulter / asked Tom
        if (!speaker) {
          const after = new RegExp(`\\b(${VERBS})\\s+(${TITLE_PREFIX})?(${NAME_TOKEN})`, 'i');
          const afterM = after.exec(postTag) ?? after.exec(preLead);
          if (afterM) {
            emotion = EMOTION_BY_VERB[afterM[1].toLowerCase()];
            speaker = validName(`${afterM[2] ?? ''}${afterM[3]}`.replace(/\s+/g, ' '));
          }
        }

        // (1b) name-then-verb:  Mrs. Coulter said / Tom asked
        if (!speaker) {
          const before = new RegExp(`(${TITLE_PREFIX})?(${NAME_TOKEN})\\s+(${VERBS})\\b`, 'i');
          const beforeM = before.exec(postTag) ?? before.exec(preLead);
          if (beforeM) {
            emotion = EMOTION_BY_VERB[beforeM[3].toLowerCase()];
            speaker = validName(`${beforeM[1] ?? ''}${beforeM[2]}`.replace(/\s+/g, ' '));
          }
        }

        // (1c) verb-then-descriptive:  said the other girl / replied the old man
        if (!speaker) {
          const dm = DESCR_AFTER_RE.exec(postTag) ?? DESCR_AFTER_RE.exec(preLead);
          const name = dm ? descriptiveName(dm[2]) : null;
          if (dm && name) {
            emotion = EMOTION_BY_VERB[dm[1].toLowerCase()];
            speaker = name;
            if (!descrMeta.has(name)) descrMeta.set(name, descriptiveMeta(dm[2]));
          }
        }

        // (1d) descriptive-then-verb:  the other girl said / the old man replied
        if (!speaker) {
          const dm = DESCR_BEFORE_RE.exec(postTag) ?? DESCR_BEFORE_RE.exec(preLead);
          const name = dm ? descriptiveName(dm[1]) : null;
          if (dm && name) {
            emotion = EMOTION_BY_VERB[dm[2].toLowerCase()];
            speaker = name;
            if (!descrMeta.has(name)) descrMeta.set(name, descriptiveMeta(dm[1]));
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
          }
        }

        // (3) action-beat role noun: "the boy hesitated" → the child speaks
        //     Searches preBody only — the tag-stripped zone — so a previous
        //     quote's trailing tag ("said the other girl.") never poisons it.
        if (!speaker) {
          for (const beat of BEAT_NOUNS) {
            if (beat.re.test(preBody) || beat.re.test(preLead)) {
              speaker = matchByDemographics(beat.gender, beat.age);
              if (speaker) break;
            }
          }
        }

        // (4) nearest character mention right before the quote (action beat),
        //     again in the tag-stripped zone only.
        if (!speaker) speaker = nearestMention(preBody.slice(-140), 140);

        // (4c) name-led action beat right AFTER the quote:
        //     '"But I can!" Mary stood up.' — the actor touching the quote
        //     is almost always the one who just spoke.
        if (!speaker) {
          const leadM = new RegExp(`^(${TITLE_PREFIX})?(${NAME_TOKEN}(?:\\s+${NAME_TOKEN})?)\\b`).exec(postTag);
          if (leadM) speaker = validName(`${leadM[1] ?? ''}${leadM[2]}`.replace(/\s+/g, ' '));
        }

        // (4b) pronoun action beat touching the quote: '"…" He stepped inside.'
        //      or 'She glanced up. "…"' — the beat's actor is usually the speaker.
        if (!speaker) {
          const beatM = PRONOUN_BEAT_RE.exec(postTag) ?? PRONOUN_BEAT_RE.exec(preLead);
          if (beatM) speaker = matchByDemographics(beatM[1].toLowerCase() === 'she' ? 'female' : 'male');
        }

        // (5) vocative inside the quote → the OTHER speaker is talking
        if (!speaker && seg.text.length >= 8) {
          for (const n of recent) {
            if (n !== recent[0] && new RegExp(`\\b${escapeName(n)}\\b`).test(seg.text)) {
              speaker = recent[0];
              break;
            }
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
        }
        if (!speaker && recent.length >= 2 && (paraQuotes >= 2 || lastDialogueSpeaker === recent[0])) {
          speaker = recent[1];
        }

        // (7) fallback — the Narrator reads the quote
        if (!speaker) speaker = 'Narrator';

        if (speaker !== 'Narrator') rememberSpeaker(speaker);
        push({ kind: 'dialogue', speaker, text: normSpace(seg.text), emotionHint: emotion });
        lastDialogueSpeaker = speaker;
      }
    }
  }

  return units;
}

const CAPTURED_NAME_RE = /^[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)?$/;

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

  const names = discoverCharacterNames(speakable);
  // pass 1 discovers the speaking roster; pass 2 resolves pronoun tags
  // against it plus full-text genders — the two-pass trick that lets
  // "she said" resolve on the very first line of a book.
  const pass1 = attributeDialogue(speakable, names);
  const roster = [...new Set(pass1.filter((u) => u.kind === 'dialogue' && u.speaker !== 'Narrator').map((u) => u.speaker))];
  const snippetSource = speakable
    .split(/\n{2,}/)
    // narration-only contexts: quoted dialogue is blanked out at its exact
    // offsets (a vocative like "How old is the lens, Tomas?" is not narration
    // about Tomas — and must not leak Pip's "ten years old" into his zone)
    .map((p) => p.replace(/“[^”\n]*”|"[^"\n]*"/g, (m) => ' '.repeat(m.length)));
  const genders: Record<string, Gender> = {};
  for (const n of [...roster, ...names]) {
    if (!(n in genders)) genders[n] = inferCharacterMeta(n, snippetSource.filter((p) => p.includes(n)).slice(0, 6)).gender;
  }
  let units = attributeDialogue(speakable, names, { roster, genders });

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
  const maxCast = Math.max(1, opts?.maxCast ?? 8);
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
    const meta = inferCharacterMeta(name, contexts);
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
