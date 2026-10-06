// ============================================================
// Openmukti Audiobook Creator — AutoBook casting engine
// Character inference + voice-profile assignment for the local
// audiobook pipeline ("lightweight AI", part 1 of 2).
//
// Given a character name and the sentences that mention it, this
// module infers gender / age band / narrative role from:
//   1. title honorifics   (Mrs., Sir, Dr., Aunt, King, ...)
//   2. kinship/role words (grandmother, stable boy, the old king)
//   3. pronouns near the name (she/her vs he/his/him)
//   4. a compact given-name database (~300 entries)
// and then deterministically casts the character onto the
// built-in formant voice profiles (aura-*, atlas/nova-narrator,
// storyteller, junior, grandpa, ...). Custom profiles are honored
// automatically because casting picks from the `profiles`
// argument by id and only falls back by gender preference.
//
// Pure TypeScript: no DOM, no network, no Math.random, no Date —
// the same book always produces byte-identical casting.
// ============================================================
import type { VoiceProfileDef } from '@/lib/types';

// ---------- demographic primitives ----------
export type Gender = 'male' | 'female' | 'neutral';
export type AgeBand = 'child' | 'young' | 'adult' | 'middle' | 'elder' | 'unknown';

export interface CharacterMeta {
  name: string;
  gender: Gender;
  ageBand: AgeBand;
  role: 'narrator' | 'major' | 'minor';
  /** Human-readable justification, ordered strongest evidence first. */
  evidence: string[];
}

/** Overwrite just the role on a CharacterMeta (shallow copy — meta stays immutable). */
export function withRole(meta: CharacterMeta, role: CharacterMeta['role']): CharacterMeta {
  return { ...meta, role };
}

// ---------- given-name database (~300 entries, lowercase) ----------
// English-heavy with an international spread. Lookup order is
// FEMALE → MALE → UNISEX, so a name listed in a gendered table
// always wins over the unisex table. Kept as space-separated
// strings on purpose: compact, readable, zero runtime cost.
const FEMALE_NAMES = new Set(
  (
    'emma elizabeth mary sarah olivia sophia isabella charlotte amelia mia evelyn abigail emily ella camila ' +
    'luna sofia mila aria scarlett penelope layla chloe victoria madison eleanor grace nora zoey hannah hazel ' +
    'lily ellie violet lillian zoe stella aurora natalie emilia everly leah aubrey willow addison lucy audrey ' +
    'bella claire daisy josephine vera margaret diana anna alice julia rose lucia irene helen beatrice clara ' +
    'jane florence martha edith agnes mabel frances joan ruth virginia doris gladys pearl esther judith susan ' +
    'linda karen nancy betty sandra ashley kimberly donna carol sharon michelle laura jessica jennifer amanda ' +
    'melissa nicole stephanie rebecca rachel heather amber megan samantha molly lauren paige erin holly sally ' +
    'lucille vivian cecilia francesca angelina rosa carmen elena bianca giulia valentina isabelle gabrielle ' +
    'camille celine amelie brigitte colette marguerite ingrid astrid freya greta annika katarina svetlana ' +
    'natasha tatiana olga irina anya elsa heidi klara liesel aisha fatima zainab yasmin amira leila noor ' +
    'mariam hawa abena amara zola thandiwe chioma nia priya ananya lakshmi meera sunita indira dewi mei yuki ' +
    'sakura hana keiko mai ximena valeria mariana beatriz ines aoife sinead niamh siobhan maeve saoirse gwen ' +
    'mira talia'
  ).split(/\s+/),
);
const MALE_NAMES = new Set(
  (
    'james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony ' +
    'mark paul steven andrew kenneth george joshua kevin brian edward ronald timothy jason jeffrey ryan jacob ' +
    'gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel gregory frank alexander ' +
    'raymond patrick jack dennis jerry tyler aaron henry douglas peter adam nathan zachary walter harold carl ' +
    'arthur gerald roger keith jeremy lawrence sean albert oscar felix leon hugo marcus victor oscar tariq ' +
    'hassan ibrahim ali ahmed yousef rashid kwame carlos dmitri hiroshi kofi mohammed luca marco giovanni ' +
    'pierre louis antoine nikolai sergei vladimir boris ivan yuri klaus hans otto lars erik nils bjorn sven ' +
    'mateo diego javier miguel alejandro rafael fernando pablo andres joaquin ricardo bruno liam noah ethan ' +
    'mason lucas owen caleb isaac vincent theodore gideon silas atticus rufus ernest cecil percy alfred ' +
    'bernard clifford gordon duncan colin alistair hamish ian ewan seamus declan finn conor elijah abraham ' +
    'moses solomon ezra timmy tom harry ralph norman stanley'
  ).split(/\s+/),
);
const UNISEX_NAMES = new Set(
  (
    'alex sam jordan robin casey taylor jamie morgan avery riley skyler quinn harper rowan sawyer parker ' +
    'emerson finley sage blake drew reese shannon kelly dana leslie noel ellis marley charlie frankie ari kai ' +
    'devon phoenix river lee pat jo kit chris andy nicky ash toni'
  ).split(/\s+/),
);

/** Capitalized sentence-initial words that must never be read as character names. */
const NOT_A_NAME = new Set(
  (
    'i the a an and but or so then when while after before because that this these those there here where ' +
    'what who why how yes no okay ok well oh ah now still just again he she it they we you his her their my ' +
    'your our its him them if else soon yet ever never always suddenly quietly slowly quickly finally ' +
    'meanwhile however therefore thus indeed perhaps maybe certainly chapter part page section act scene book ' +
    'prologue epilogue narrator january february march april may june july august september october november ' +
    'december monday tuesday wednesday thursday friday saturday sunday mr mrs ms dr miss sir lady lord aunt ' +
    'uncle tomorrow tonight today yesterday'
  ).split(/\s+/),
);

// ---------- honorific tables ----------
const MALE_HONORIFICS = ['mr', 'sir', 'lord', 'king', 'prince', 'duke', 'emperor', 'father', 'uncle', 'grandfather', 'grandpa', 'master'];
const FEMALE_HONORIFICS = ['mrs', 'miss', 'ms', 'madam', 'madame', 'lady', 'queen', 'aunt', 'auntie', 'grandmother', 'grandma', 'princess', 'duchess', 'empress', 'mother'];
const NEUTRAL_HONORIFICS = ['dr', 'doctor', 'professor'];
const ALL_HONORIFICS = [...MALE_HONORIFICS, ...FEMALE_HONORIFICS, ...NEUTRAL_HONORIFICS];
const HONORIFIC_DISPLAY: Record<string, string> = {
  mr: 'Mr.', mrs: 'Mrs.', ms: 'Ms.', miss: 'Miss', dr: 'Dr.', doctor: 'Doctor', professor: 'Professor',
  sir: 'Sir', lord: 'Lord', lady: 'Lady', king: 'King', queen: 'Queen', prince: 'Prince', princess: 'Princess',
  duke: 'Duke', duchess: 'Duchess', emperor: 'Emperor', empress: 'Empress', father: 'Father', mother: 'Mother',
  uncle: 'Uncle', aunt: 'Aunt', auntie: 'Auntie', grandfather: 'Grandfather', grandmother: 'Grandmother',
  grandpa: 'Grandpa', grandma: 'Grandma', madam: 'Madam', madame: 'Madame', master: 'Master',
};

// ---------- kinship / role nouns (context words) ----------
const KINSHIP_MALE = 'father dad daddy papa grandfather grandpa granddad grandson uncle brother husband nephew son widower stepfather godfather'.split(' ');
const KINSHIP_FEMALE = 'mother mom mummy mama grandmother grandma granny nana granddaughter aunt auntie sister wife niece daughter widow stepmother godmother'.split(' ');
const NOUN_MALE = 'man boy gentleman lad fellow king prince duke emperor lord monk priest butler wizard'.split(' ');
const NOUN_FEMALE = 'woman girl lady lass maiden maid queen princess duchess empress madam madame nun waitress witch governess'.split(' ');
const MALE_ROLE_SET = new Set([...KINSHIP_MALE, ...NOUN_MALE]);
const FEMALE_ROLE_SET = new Set([...KINSHIP_FEMALE, ...NOUN_FEMALE]);
const KINSHIP_SET = new Set([...KINSHIP_MALE, ...KINSHIP_FEMALE]);
const ROLE_WORD_RE = new RegExp(`\\b(${[...MALE_ROLE_SET, ...FEMALE_ROLE_SET].join('|')})\\b`, 'gi');

// ---------- age cue patterns ----------
// 'little' is guarded against "Little did she know" false positives.
const CHILD_WORDS_RE = /\b(kid|child|children|boy|girl|toddler|infant|school|schoolboy|schoolgirl)\b|\blittle\b(?!\s+did\b)/gi;
const ELDER_WORDS_RE = /\b(old man|old woman|elderly|ancient|white[- ]haired|grey[- ]haired|gray[- ]haired|wrinkled|stooped|grandfather|grandmother|grandpa|grandma|granny|great-uncle|great-aunt|old)\b/gi;
const YOUNG_WORDS_RE = /\b(young|teenager|teen|adolescent|youthful)\b/gi;
const AGE_STATED_RE = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+years?\s+old\b/gi;
const WORD_AGE: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capFirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function ageFromNumber(n: number): AgeBand {
  if (n <= 12) return 'child';
  if (n <= 19) return 'young';
  if (n <= 59) return 'adult';
  return 'elder';
}

function genderFromNameDatabase(firstLower: string): Gender | undefined {
  if (FEMALE_NAMES.has(firstLower)) return 'female';
  if (MALE_NAMES.has(firstLower)) return 'male';
  if (UNISEX_NAMES.has(firstLower)) return 'neutral';
  return undefined;
}

/** Look for an honorific glued to the name itself ("Mrs. Coulter") or right before it in context. */
function findHonorific(name: string, context: string[], firstLower: string): { token: string; kind: 'male' | 'female' | 'neutral' } | undefined {
  const nameHead = /^\s*([a-z]+)\b/.exec(name.toLowerCase());
  if (nameHead && ALL_HONORIFICS.includes(nameHead[1])) {
    const kind = MALE_HONORIFICS.includes(nameHead[1]) ? 'male' : FEMALE_HONORIFICS.includes(nameHead[1]) ? 'female' : 'neutral';
    return { token: nameHead[1], kind };
  }
  if (!firstLower) return undefined;
  for (const hon of ALL_HONORIFICS) {
    const re = new RegExp(`\\b${hon}\\.?\\s+${escapeRe(firstLower)}\\b`, 'i');
    if (context.some((c) => re.test(c))) {
      const kind = MALE_HONORIFICS.includes(hon) ? 'male' : FEMALE_HONORIFICS.includes(hon) ? 'female' : 'neutral';
      return { token: hon, kind };
    }
  }
  return undefined;
}

/**
 * Infer everything the caster needs to know about a character from the name plus
 * the sentences that mention it. Deterministic; evidence is ordered strongest-first.
 * `role` is only a default here — callers override it with withRole().
 */
export function inferCharacterMeta(name: string, contextSnippets: string[]): CharacterMeta {
  const evidence: string[] = [];
  const trimmed = (name ?? '').trim();
  const tokens = trimmed.split(/\s+/);
  const displayFirst = (tokens[0] ?? '').replace(/[^A-Za-z'-]/g, '');
  const firstLower = displayFirst.toLowerCase();
  const context = contextSnippets.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const joined = context.join(' ').toLowerCase();

  // Mention-focused windows: ±60 chars around every occurrence of the name.
  // Demographics must describe THIS character — cues belonging to other
  // people in the same paragraph ("Pip, who was ten years old") must not leak.
  const nameRe = new RegExp(`\\b${escapeRe((trimmed.split(/\s+/).pop() ?? trimmed).toLowerCase())}\\b`, 'ig');
  const nearZones: string[] = [];
  for (const c of context) {
    const lower = c.toLowerCase();
    nameRe.lastIndex = 0;
    let zm: RegExpExecArray | null;
    while ((zm = nameRe.exec(lower))) {
      nearZones.push(lower.slice(Math.max(0, zm.index - 60), zm.index + zm[0].length + 60));
    }
  }
  const nearJoined = nearZones.join(' ');

  let gender: Gender | undefined;
  let neutralHonorific: string | undefined;

  // --- 1. honorifics: strongest signal ("title honorific: Mrs.") ---
  const honorific = findHonorific(trimmed, context, firstLower);
  if (honorific && honorific.kind !== 'neutral') {
    gender = honorific.kind;
    evidence.push(`title honorific: ${HONORIFIC_DISPLAY[honorific.token] ?? capFirst(honorific.token)}`);
  } else if (honorific) {
    // Dr./Professor stay unresolved on purpose — the name database gets the next word.
    neutralHonorific = honorific.token;
  }

  // --- 2. kinship / role nouns near the name ("kinship term: grandmother") ---
  if (!gender) {
    const firstLowerName = firstLower;
    if (firstLowerName && MALE_ROLE_SET.has(firstLowerName)) {
      gender = 'male';
      evidence.push(`kinship term: ${firstLowerName}`);
    } else if (firstLowerName && FEMALE_ROLE_SET.has(firstLowerName)) {
      gender = 'female';
      evidence.push(`kinship term: ${firstLowerName}`);
    }
  }
  // --- 2. kinship / role nouns NEAR the name ("kinship term: grandmother") ---
  // Possessive relatives are someone else's family — "her father's logbook"
  // says nothing about the bearer's own gender and is skipped.
  if (!gender && nearJoined) {
    ROLE_WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROLE_WORD_RE.exec(nearJoined))) {
      const word = m[1].toLowerCase();
      if (new RegExp(`\\b(?:her|his|their|my|your|our)\\s+${word}s?\\b`, 'i').test(nearJoined)) continue;
      if (MALE_ROLE_SET.has(word)) {
        gender = 'male';
        evidence.push(`${KINSHIP_SET.has(word) ? 'kinship term' : 'context noun'}: ${word}`);
        break;
      }
      if (FEMALE_ROLE_SET.has(word)) {
        gender = 'female';
        evidence.push(`${KINSHIP_SET.has(word) ? 'kinship term' : 'context noun'}: ${word}`);
        break;
      }
    }
  }

  // --- 3. pronouns near the name ("referred to as “she” in context") ---
  if (!gender) {
    const zone = nearJoined || joined;
    const female = (zone.match(/\b(?:she|her|hers)\b/g) ?? []).length;
    const male = (zone.match(/\b(?:he|him|his)\b/g) ?? []).length;
    // Require a strict majority — a lone "he" next to a female name is usually another character.
    if (female > male) {
      gender = 'female';
      evidence.push('referred to as “she” in context');
    } else if (male > female) {
      gender = 'male';
      evidence.push('referred to as “he” in context');
    }
  }

  // --- 4. given-name database ("first name Emma matches female name database") ---
  if (!gender && firstLower) {
    const db = genderFromNameDatabase(firstLower);
    if (db === 'female') {
      gender = 'female';
      evidence.push(`first name ${capFirst(displayFirst)} matches female name database`);
    } else if (db === 'male') {
      gender = 'male';
      evidence.push(`first name ${capFirst(displayFirst)} matches male name database`);
    } else if (db === 'neutral') {
      gender = 'neutral';
      evidence.push(`first name ${capFirst(displayFirst)} is unisex — no gendered evidence found`);
    }
  }

  // Dr./Professor only decide gender when nothing more specific was found.
  if (!gender && neutralHonorific) {
    gender = 'neutral';
    evidence.push(`title honorific: ${HONORIFIC_DISPLAY[neutralHonorific] ?? capFirst(neutralHonorific)} (gender-neutral title)`);
  }

  // --- age band: explicit age beats child cues beats elder cues beats "young" ---
  // All age cues read the mention-focused windows only — ages stated about
  // other characters must not leak across paragraphs.
  let ageBand: AgeBand | undefined;
  const ageZone = nearJoined;
  AGE_STATED_RE.lastIndex = 0;
  const ageM = AGE_STATED_RE.exec(ageZone);
  if (ageM) {
    const n = /^\d+$/.test(ageM[1]) ? parseInt(ageM[1], 10) : (WORD_AGE[ageM[1].toLowerCase()] ?? 35);
    ageBand = ageFromNumber(n);
    evidence.push(`age stated: ${ageM[1]} years old`);
  }
  if (!ageBand) {
    CHILD_WORDS_RE.lastIndex = 0;
    const hits: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = CHILD_WORDS_RE.exec(ageZone)) && hits.length < 3) {
      const w = m[0].toLowerCase().replace(/\s+/g, ' ');
      if (!hits.includes(w)) hits.push(w);
    }
    if (hits.length) {
      ageBand = 'child';
      evidence.push(`childhood cue: ${hits.join(', ')}`);
    }
  }
  if (!ageBand) {
    ELDER_WORDS_RE.lastIndex = 0;
    const hits: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = ELDER_WORDS_RE.exec(ageZone)) && hits.length < 3) {
      const w = m[0].toLowerCase();
      if (!hits.includes(w)) hits.push(w);
    }
    if (hits.length) {
      ageBand = 'elder';
      evidence.push(`elder cue: ${hits.join(', ')}`);
    }
  }
  if (!ageBand) {
    YOUNG_WORDS_RE.lastIndex = 0;
    const ym = YOUNG_WORDS_RE.exec(ageZone);
    if (ym) {
      ageBand = 'young';
      evidence.push(`youth cue: ${ym[0].toLowerCase()}`);
    }
  }

  // Any evidence at all ⇒ named character defaults to adult; zero evidence ⇒ unknown.
  const hadEvidence = evidence.length > 0 || firstLower.length > 0;
  if (!ageBand) {
    ageBand = hadEvidence ? 'adult' : 'unknown';
    if (hadEvidence) evidence.push('no age cues found — assumed adult');
  }
  if (!gender) gender = 'neutral';

  return { name: trimmed || name, gender, ageBand, role: 'minor', evidence };
}

// ---------- voice casting ----------
export interface CastAssignment {
  profileId: string;
  rate: number;
  pitch: number;
  /** e.g. "elder male → Grandpa (low, unhurried)". */
  rationale: string;
}

const RATE_MIN = 0.8;
const RATE_MAX = 1.2;
const PITCH_MIN = 0.85;
const PITCH_MAX = 1.3;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Short sound description used inside rationales. */
const PROFILE_TAGS: Record<string, string> = {
  'aura-neutral': 'balanced default',
  'aura-deep': 'low, steady',
  'aura-warm': 'warm, soft-edged',
  'aura-bright': 'clear, bright',
  'atlas-narrator': 'deep, deliberate',
  'nova-narrator': 'smooth, long-form',
  'chip-robotic': 'flat, robotic',
  'whisper-soft': 'airy whisper',
  storyteller: 'expressive',
  junior: 'bright, childlike',
  grandpa: 'low, unhurried',
  'mono-flat': 'monotone',
};

/** One casting candidate: a profile id plus an optional per-profile pitch override. */
interface CastStep {
  readonly id: string;
  readonly pitch?: number;
}
interface CastIntent {
  readonly steps: readonly CastStep[];
  readonly rate: number;
  readonly pitch: number;
  readonly why: string;
}

/**
 * Casting policy — the WHY of each line:
 * - narrator gets the dedicated long-form voices, paced slightly under 1.0 for calm delivery;
 * - children get Junior (high base pitch), quickened a touch;
 * - elder men get Grandpa. Elder women must NOT get whisper-soft (it is a literal whisper,
 *   unusable for a whole book), so they get the narrator voices slowed and lowered instead;
 * - adult voices go deep male / bright female first, then drift warmer or more neutral;
 * - teens share Storyteller pitched up, then fall back by gender.
 */
function intentFor(meta: CharacterMeta): CastIntent {
  const g = meta.gender;
  if (meta.role === 'narrator' || meta.name === 'Narrator') {
    const id = g === 'male' ? 'atlas-narrator' : g === 'female' ? 'nova-narrator' : 'aura-neutral';
    return { steps: [{ id }], rate: 0.96, pitch: 1, why: `narrator (${g})` };
  }
  if (meta.ageBand === 'child') {
    return { steps: [{ id: 'junior' }], rate: 1.05, pitch: 1.25, why: 'child' };
  }
  if (meta.ageBand === 'elder') {
    if (g === 'male') return { steps: [{ id: 'grandpa' }], rate: 0.92, pitch: 0.95, why: 'elder male' };
    return {
      steps: [{ id: 'nova-narrator', pitch: 0.9 }, { id: 'aura-bright', pitch: 0.85 }],
      rate: 0.9,
      pitch: 0.9,
      why: g === 'female' ? 'elder female' : 'elder (gender unclear)',
    };
  }
  if (meta.ageBand === 'young') {
    const rest = g === 'female' ? ['aura-bright', 'nova-narrator'] : g === 'male' ? ['aura-deep', 'aura-warm'] : ['aura-neutral', 'mono-flat'];
    return { steps: [{ id: 'storyteller', pitch: 1.15 }, ...rest.map((id) => ({ id }))], rate: 1.05, pitch: 1.15, why: `young ${g}` };
  }
  if (meta.ageBand === 'middle' && g === 'male') {
    return { steps: [{ id: 'aura-warm' }, { id: 'aura-deep' }, { id: 'storyteller' }], rate: 1, pitch: 1, why: 'middle-aged male' };
  }
  if (meta.ageBand === 'middle' && g === 'female') {
    return { steps: [{ id: 'nova-narrator' }, { id: 'aura-bright' }], rate: 1, pitch: 1, why: 'middle-aged female' };
  }
  if (g === 'female') {
    return {
      steps: [{ id: 'aura-bright' }, { id: 'nova-narrator' }, { id: 'storyteller', pitch: 0.9 }, { id: 'whisper-soft' }],
      rate: 1,
      pitch: 1,
      why: 'adult female',
    };
  }
  if (g === 'male') {
    return { steps: [{ id: 'aura-deep' }, { id: 'storyteller' }, { id: 'aura-warm' }, { id: 'chip-robotic' }], rate: 1, pitch: 1, why: 'adult male' };
  }
  return { steps: [{ id: 'aura-neutral' }, { id: 'mono-flat' }, { id: 'whisper-soft' }], rate: 1, pitch: 1, why: 'neutral / unspecified' };
}

/**
 * Deterministic profile pick: preferred ids first (present in `profiles` AND unused),
 * then same-gender unused, then neutral unused, then anything unused; when every
 * profile is taken, reuse the closest preferred id; never invent ids that are not
 * in `profiles`. Returns null only when `profiles` is empty.
 */
function pickProfile(intent: CastIntent, gender: Gender, profiles: VoiceProfileDef[], taken: Set<string>): { id: string; pitch: number; reused: boolean } | null {
  if (profiles.length === 0) return null;
  const byId = new Map(profiles.map((p) => [p.id, p] as const));
  for (const step of intent.steps) {
    if (byId.has(step.id) && !taken.has(step.id)) return { id: step.id, pitch: step.pitch ?? intent.pitch, reused: false };
  }
  const unused = profiles.filter((p) => !taken.has(p.id));
  const fallback = unused.find((p) => p.gender === gender) ?? unused.find((p) => p.gender === 'neutral') ?? unused[0];
  if (fallback) return { id: fallback.id, pitch: intent.pitch, reused: false };
  for (const step of intent.steps) {
    if (byId.has(step.id)) return { id: step.id, pitch: step.pitch ?? intent.pitch, reused: true };
  }
  return { id: profiles[0].id, pitch: intent.pitch, reused: true };
}

/**
 * Cast a character onto a voice profile. Mutates `taken` by adding the chosen id so
 * sequential calls hand out distinct voices while alternatives remain.
 */
export function castVoiceFor(meta: CharacterMeta, profiles: VoiceProfileDef[], taken: Set<string>): CastAssignment {
  const intent = intentFor(meta);
  const noProfiles: CastAssignment = {
    profileId: 'aura-neutral',
    rate: round2(clamp(intent.rate, RATE_MIN, RATE_MAX)),
    pitch: round2(clamp(intent.pitch, PITCH_MIN, PITCH_MAX)),
    rationale: `no voice profiles available — defaulting to aura-neutral for ${intent.why}`,
  };
  const pick = pickProfile(intent, meta.gender, profiles, taken);
  if (!pick) return noProfiles;
  taken.add(pick.id);
  const profile = profiles.find((p) => p.id === pick.id);
  const tag = PROFILE_TAGS[pick.id] ?? 'fallback voice';
  const reuseNote = pick.reused ? ' — every voice already cast, reusing' : '';
  return {
    profileId: pick.id,
    rate: round2(clamp(intent.rate, RATE_MIN, RATE_MAX)),
    pitch: round2(clamp(pick.pitch, PITCH_MIN, PITCH_MAX)),
    rationale: `${intent.why} → ${profile?.name ?? pick.id} (${tag})${reuseNote}`,
  };
}
