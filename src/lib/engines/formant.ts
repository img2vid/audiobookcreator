// ============================================================
// Openmukti Audiobook Creator — local formant speech synthesis engine
// A genuine, fully in-browser TTS engine: text normalization →
// English grapheme-to-phoneme rules → formant synthesis via
// OfflineAudioContext (glottal source + 3-formant filters).
// No network, no models to download, no uploads.
// ============================================================
import type { SynthOptions, VoiceProfileDef } from '@/lib/types';
import { concatenateBuffers } from '@/lib/engines/dsp';
import { yieldToUI } from '@/lib/utils/async';

// ---------- voice profiles ----------
export const VOICE_PROFILES: VoiceProfileDef[] = [
  { id: 'aura-neutral', name: 'Aura Neutral', gender: 'neutral', basePitchHz: 165, timbre: 1.0, breath: 0.18, lang: 'en', description: 'Balanced default voice with natural prosody.' },
  { id: 'aura-deep', name: 'Aura Deep', gender: 'male', basePitchHz: 108, timbre: 0.94, breath: 0.12, lang: 'en', description: 'Low male voice, calm and steady.' },
  { id: 'aura-warm', name: 'Aura Warm', gender: 'male', basePitchHz: 124, timbre: 0.97, breath: 0.22, lang: 'en', description: 'Warm male voice with soft breath.' },
  { id: 'aura-bright', name: 'Aura Bright', gender: 'female', basePitchHz: 214, timbre: 1.1, breath: 0.2, lang: 'en', description: 'Clear female voice with bright formants.' },
  { id: 'atlas-narrator', name: 'Atlas Narrator', gender: 'male', basePitchHz: 116, timbre: 0.96, breath: 0.15, lang: 'en', description: 'Deep audiobook narrator, deliberate pace.' },
  { id: 'nova-narrator', name: 'Nova Narrator', gender: 'female', basePitchHz: 196, timbre: 1.08, breath: 0.16, lang: 'en', description: 'Smooth female narrator for long-form audio.' },
  { id: 'chip-robotic', name: 'Chip (Robotic)', gender: 'neutral', basePitchHz: 148, timbre: 0.82, breath: 0.04, lang: 'en', description: 'Retro robotic voice — minimal breath, flat contour.' },
  { id: 'whisper-soft', name: 'Whisper Soft', gender: 'neutral', basePitchHz: 158, timbre: 1.02, breath: 0.85, lang: 'en', description: 'Airy whispered delivery, very low volume.' },
  { id: 'storyteller', name: 'Storyteller', gender: 'male', basePitchHz: 132, timbre: 0.99, breath: 0.2, lang: 'en', description: 'Expressive storyteller with rich pitch movement.' },
  { id: 'junior', name: 'Junior', gender: 'neutral', basePitchHz: 250, timbre: 1.18, breath: 0.24, lang: 'en', description: 'Child-like high voice.' },
  { id: 'grandpa', name: 'Grandpa', gender: 'male', basePitchHz: 96, timbre: 0.9, breath: 0.35, lang: 'en', description: 'Elderly male voice, slow with slight rasp.' },
  { id: 'mono-flat', name: 'Mono (Flat)', gender: 'neutral', basePitchHz: 170, timbre: 1.0, breath: 0.1, lang: 'en', description: 'Monotone delivery — zero pitch contour.' },
];

// ---------- custom voice registry ----------
// Views hydrate this module-level set from the persisted store (app-store customProfiles)
// on mount and whenever the store array changes — see registerCustomProfiles(). The
// app-store also mirrors the registration via a store subscription, so synthesis and the
// queue worker resolve custom ids even right after a reload before any view mounts.
const BUILTIN_PROFILE_IDS = new Set(VOICE_PROFILES.map((p) => p.id));
let registeredCustomProfiles: VoiceProfileDef[] = [];

/**
 * Replace the registered custom-profile set (idempotent; called by views/store on change).
 * Tolerant of junk: entries without a string id/name are dropped, duplicate ids collapse.
 * Custom profiles can never shadow a built-in id — the Voice Library prevents that at
 * creation, and this filter keeps it airtight.
 */
export function registerCustomProfiles(profiles: VoiceProfileDef[]): void {
  if (!Array.isArray(profiles)) {
    registeredCustomProfiles = [];
    return;
  }
  const seen = new Set<string>();
  const clean: VoiceProfileDef[] = [];
  for (const p of profiles) {
    if (!p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || !p.name) continue;
    if (BUILTIN_PROFILE_IDS.has(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    clean.push(p);
  }
  registeredCustomProfiles = clean;
}

/** All selectable profiles: built-ins first, then the registered custom voices. */
export function allVoiceProfiles(): VoiceProfileDef[] {
  return [...VOICE_PROFILES, ...registeredCustomProfiles];
}

/** True when a profile is not one of the bundled built-ins (used for "custom" badges). */
export function isCustomProfile(p: VoiceProfileDef): boolean {
  return !BUILTIN_PROFILE_IDS.has(p.id);
}

/** Synthesis lookup: custom ids win, then built-ins, then the default profile. */
function resolveProfile(id: string | undefined): VoiceProfileDef {
  if (id) {
    const custom = registeredCustomProfiles.find((v) => v.id === id);
    if (custom) return custom;
    const builtin = VOICE_PROFILES.find((v) => v.id === id);
    if (builtin) return builtin;
  }
  return VOICE_PROFILES[0];
}

// ---------- phoneme definitions ----------
type PhoneType = 'vowel' | 'nasal' | 'glide' | 'liquid' | 'rhotic' | 'fric-u' | 'fric-v' | 'stop-u' | 'stop-v' | 'affr-u' | 'affr-v' | 'aspirate' | 'silence';

interface PhoneDef {
  type: PhoneType;
  f?: [number, number, number]; // formants at start
  f2?: [number, number, number]; // formants at end (diphthong)
  band?: [number, number]; // fricative band center, Q
  burst?: [number, number]; // stop burst center freq, Q
  dur: number; // base ms
}

const P: Record<string, PhoneDef> = {
  // vowels (F1,F2,F3)
  AA: { type: 'vowel', f: [730, 1090, 2440], dur: 130 },
  AE: { type: 'vowel', f: [660, 1720, 2410], dur: 130 },
  AH: { type: 'vowel', f: [640, 1190, 2390], dur: 90 },
  AO: { type: 'vowel', f: [570, 840, 2410], dur: 130 },
  EH: { type: 'vowel', f: [530, 1840, 2480], dur: 110 },
  ER: { type: 'vowel', f: [490, 1350, 1690], dur: 130 },
  IH: { type: 'vowel', f: [390, 1990, 2550], dur: 90 },
  IY: { type: 'vowel', f: [270, 2290, 3010], dur: 120 },
  UH: { type: 'vowel', f: [440, 1020, 2240], dur: 90 },
  UW: { type: 'vowel', f: [300, 870, 2240], dur: 120 },
  // diphthongs
  AY: { type: 'vowel', f: [730, 1090, 2440], f2: [400, 1950, 2600], dur: 180 },
  EY: { type: 'vowel', f: [530, 1840, 2480], f2: [340, 2100, 2700], dur: 170 },
  OW: { type: 'vowel', f: [540, 900, 2400], f2: [380, 760, 2300], dur: 170 },
  AW: { type: 'vowel', f: [730, 1090, 2440], f2: [380, 760, 2300], dur: 180 },
  OY: { type: 'vowel', f: [570, 840, 2410], f2: [340, 2100, 2700], dur: 190 },
  // nasals
  M: { type: 'nasal', f: [280, 900, 2200], dur: 70 },
  N: { type: 'nasal', f: [280, 1700, 2600], dur: 70 },
  NG: { type: 'nasal', f: [280, 2300, 2750], dur: 75 },
  // liquids / glides / rhotic
  L: { type: 'liquid', f: [360, 1300, 2900], dur: 70 },
  R: { type: 'rhotic', f: [490, 1350, 1690], dur: 75 },
  W: { type: 'glide', f: [300, 610, 2200], dur: 65 },
  Y: { type: 'glide', f: [270, 2290, 3010], dur: 65 },
  // unvoiced fricatives
  F: { type: 'fric-u', band: [6400, 1.6], dur: 90 },
  TH: { type: 'fric-u', band: [6200, 1.4], dur: 85 },
  S: { type: 'fric-u', band: [7200, 2.2], dur: 100 },
  SH: { type: 'fric-u', band: [3400, 1.8], dur: 100 },
  HH: { type: 'aspirate', band: [1800, 0.7], dur: 60 },
  // voiced fricatives
  V: { type: 'fric-v', f: [280, 1400, 2600], band: [5200, 1.2], dur: 70 },
  DH: { type: 'fric-v', f: [280, 1600, 2600], band: [5600, 1.1], dur: 65 },
  Z: { type: 'fric-v', f: [280, 1700, 2600], band: [6800, 1.8], dur: 85 },
  ZH: { type: 'fric-v', f: [280, 1800, 2600], band: [3200, 1.8], dur: 85 },
  // stops
  P: { type: 'stop-u', burst: [900, 1.2], dur: 85 },
  T: { type: 'stop-u', burst: [3900, 1.6], dur: 85 },
  K: { type: 'stop-u', burst: [2200, 1.4], dur: 90 },
  B: { type: 'stop-v', f: [280, 900, 2200], burst: [800, 1.2], dur: 75 },
  D: { type: 'stop-v', f: [280, 1700, 2600], burst: [3600, 1.6], dur: 70 },
  G: { type: 'stop-v', f: [280, 2000, 2400], burst: [2000, 1.4], dur: 75 },
  // affricates
  CH: { type: 'affr-u', band: [3200, 1.8], burst: [2600, 1.5], dur: 130 },
  JH: { type: 'affr-v', f: [280, 1700, 2600], band: [3000, 1.8], dur: 110 },
  // special
  _: { type: 'silence', dur: 60 },
};

// ---------- text normalization ----------
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function threeDigitsToWords(n: number): string {
  let out = '';
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h > 0) out += NUMBER_WORDS[h] + ' hundred' + (r > 0 ? ' ' : '');
  if (r >= 20) {
    out += TENS[Math.floor(r / 10)];
    if (r % 10 > 0) out += '-' + NUMBER_WORDS[r % 10];
  } else if (r > 0) out += NUMBER_WORDS[r];
  return out;
}

function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n < 0) return 'negative ' + numberToWords(-n);
  if (Number.isInteger(n) && n < 20) return NUMBER_WORDS[n];
  if (Number.isInteger(n) && n < 100 && n % 10 === 0) return TENS[n / 10];
  if (Number.isInteger(n) && n < 1000) return threeDigitsToWords(n);
  const units: [number, string][] = [
    [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand'],
  ];
  for (const [v, name] of units) {
    if (n >= v) {
      const q = Math.floor(n / v);
      const r = n % v;
      return threeDigitsToWords(q) + ' ' + name + (r > 0 ? ' ' + numberToWords(r) : '');
    }
  }
  // decimals
  if (!Number.isInteger(n)) {
    const [int, dec] = String(n).split('.');
    return numberToWords(parseInt(int)) + ' point ' + dec.split('').map((d) => NUMBER_WORDS[+d]).join(' ');
  }
  return String(n);
}

const EXCEPTIONS: Record<string, string> = {
  the: 'DH AH', a: 'AH', of: 'AH V', to: 'T UW', and: 'AE N D', you: 'Y UW',
  i: 'AY', is: 'IH Z', are: 'AA R', was: 'W AH Z', were: 'W ER', be: 'B IY',
  been: 'B IH N', am: 'AE M', do: 'D UW', does: 'D AH Z', did: 'D IH D',
  have: 'HH AE V', has: 'HH AE Z', had: 'HH AE D', will: 'W IH L',
  would: 'W UH D', could: 'K UH D', should: 'SH UH D', can: 'K AE N',
  one: 'W AH N', two: 'T UW', once: 'W AH N S', who: 'HH UW', what: 'W AH T',
  where: 'W EH R', when: 'W EH N', why: 'W AY', how: 'HH AW', there: 'DH EH R',
  their: 'DH EH R', they: 'DH EY', them: 'DH EH M', this: 'DH IH S', that: 'DH AE T',
  these: 'DH IY Z', those: 'DH OW Z', then: 'DH EH N', than: 'DH AE N',
  with: 'W IH DH', without: 'W IH DH AW T', from: 'F R AH M', for: 'F AO R',
  or: 'AO R', on: 'AA N', in: 'IH N', into: 'IH N T UW', onto: 'AA N T UW',
  out: 'AW T', about: 'AH B AW T', above: 'AH B AH V', over: 'OW V ER',
  under: 'AH N D ER', again: 'AH G EH N', said: 'S EH D', says: 'S EH Z',
  come: 'K AH M', some: 'S AH M', done: 'D AH N', none: 'N AH N',
  love: 'L AH V', move: 'M UW V', prove: 'P R UW V', give: 'G IH V',
  live: 'L IH V', sure: 'SH UH R', eye: 'AY', eyes: 'AY Z', people: 'P IY P AH L',
  because: 'B IH K AH Z', through: 'TH R UW', though: 'DH OW', thought: 'TH AO T',
  enough: 'IH N AH F', tough: 'T AH F', rough: 'R AH F', laugh: 'L AE F',
  friend: 'F R EH N D', great: 'G R EY T', break: 'B R EY K', steak: 'S T EY K',
  heart: 'HH AA R T', hear: 'HH IY R', here: 'HH IY R', near: 'N IY R',
  year: 'Y IH R', years: 'Y IH R Z', word: 'W ER D', words: 'W ER D Z',
  work: 'W ER D', works: 'W ER D S', world: 'W ER L D', many: 'M EH N IY',
  any: 'EH N IY', very: 'V EH R IY', every: 'EH V R IY', only: 'OW N L IY',
  other: 'AH DH ER', another: 'AH N AH DH ER', mother: 'M AH DH ER',
  father: 'F AA DH ER', brother: 'B R AH DH ER', water: 'W AO T ER',
  after: 'AE F T ER', before: 'B IH F AO R', also: 'AO L S OW', both: 'B OW TH',
  now: 'N AW', new: 'N UW', know: 'N OW', known: 'N OW N', knew: 'N UW',
  right: 'R AY T', night: 'N AY T', light: 'L AY T', might: 'M AY T',
  time: 'T AY M', like: 'L AY K', make: 'M EY K', made: 'M EY D',
  take: 'T EY K', took: 'T UH K', see: 'S IY', saw: 'S AO', seen: 'S IY N',
  use: 'Y UW Z', used: 'Y UW Z D', way: 'W EY', day: 'D EY', days: 'D EY Z',
  back: 'B AE K', good: 'G UH D', just: 'JH AH S T', get: 'G EH T',
  got: 'G AA T', go: 'G OW', goes: 'G OW Z', going: 'G OW IH NG',
  gone: 'G AO N', our: 'AW R', your: 'Y AO R', my: 'M AY', me: 'M IY',
  we: 'W IY', he: 'HH IY', she: 'SH IY', it: 'IH T', its: 'IH T S',
  if: 'IH F', not: 'N AA T', but: 'B AH T', so: 'S OW', no: 'N OW',
  yes: 'Y EH S', as: 'AE Z', at: 'AE T', by: 'B AY', an: 'AE N',
  all: 'AO L', more: 'M AO R', most: 'M OW S T', such: 'S AH CH',
  each: 'IY CH', which: 'W IH CH', while: 'W AY L', where_: 'W EH R',
};

const ABBREV: Record<string, string> = {
  'mr.': 'mister', 'mrs.': 'missus', 'ms.': 'miss', 'dr.': 'doctor',
  'prof.': 'professor', 'sr.': 'senior', 'jr.': 'junior', 'st.': 'saint',
  'vs.': 'versus', 'etc.': 'et cetera', 'e.g.': 'for example',
  'i.e.': 'that is', 'approx.': 'approximately', 'fig.': 'figure',
  'no.': 'number', 'inc.': 'incorporated', 'ltd.': 'limited',
  'co.': 'company', 'corp.': 'corporation', 'ave.': 'avenue',
  'jan.': 'january', 'feb.': 'february', 'mar.': 'march', 'apr.': 'april',
  'jun.': 'june', 'jul.': 'july', 'aug.': 'august', 'sep.': 'september',
  'sept.': 'september', 'oct.': 'october', 'nov.': 'november', 'dec.': 'december',
};

const ORDINALS: Record<string, string> = {
  '1st': 'first', '2nd': 'second', '3rd': 'third', '4th': 'fourth', '5th': 'fifth',
  '6th': 'sixth', '7th': 'seventh', '8th': 'eighth', '9th': 'ninth', '10th': 'tenth',
  '11th': 'eleventh', '12th': 'twelfth', '13th': 'thirteenth', '20th': 'twentieth',
  '21st': 'twenty-first', '22nd': 'twenty-second', '30th': 'thirtieth',
};

/** TTS front-end: normalize text for pronunciation (numbers, currency, times, abbrevs). */
export function normalizeText(input: string): string {
  let t = input;
  // URLs & emails
  t = t.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, ' email address ');
  t = t.replace(/\bhttps?:\/\/\S+/g, ' web address ');
  // abbreviations (case-insensitive, word boundary)
  for (const [k, v] of Object.entries(ABBREV)) {
    const re = new RegExp(k.replace('.', '\\.') + '\\b', 'gi');
    t = t.replace(re, v);
  }
  // times 3:30 → three thirty (12h assumption)
  t = t.replace(/\b(\d{1,2}):(\d{2})\s*(a\.m\.|am|p\.m\.|pm)?\b/gi, (_m, h, min, ap) => {
    const hh = parseInt(h);
    const part = ap ? (/a/i.test(ap) ? ' A M' : ' P M') : '';
    return numberToWords(hh) + ' ' + (min === '00' ? 'o\'clock' : numberToWords(parseInt(min))) + part;
  });
  // currency
  t = t.replace(/\$\s?([\d,]+(?:\.\d+)?)/g, (_m, n) => {
    const num = parseFloat(String(n).replace(/,/g, ''));
    const [int, dec] = String(num).split('.');
    let out = numberToWords(parseInt(int)) + ' dollars';
    if (dec) out += ' ' + numberToWords(parseInt(dec)) + ' cents';
    return out;
  });
  t = t.replace(/€\s?([\d,]+(?:\.\d+)?)/g, (_m, n) => numberToWords(parseFloat(String(n).replace(/,/g, ''))) + ' euros');
  t = t.replace(/£\s?([\d,]+(?:\.\d+)?)/g, (_m, n) => numberToWords(parseFloat(String(n).replace(/,/g, ''))) + ' pounds');
  // percent & degrees
  t = t.replace(/(\d+(?:\.\d+)?)\s?%/g, (_m, n) => numberToWords(parseFloat(n)) + ' percent');
  t = t.replace(/(\d+(?:\.\d+)?)\s?°\s?([CF])?/g, (_m, n, unit) => numberToWords(parseFloat(n)) + ' degrees' + (unit ? ' ' + (unit === 'C' ? 'celsius' : 'fahrenheit') : ''));
  // ordinals
  for (const [k, v] of Object.entries(ORDINALS)) t = t.replace(new RegExp('\\b' + k + '\\b', 'gi'), v);
  // remaining numbers with commas / plain
  t = t.replace(/\b\d{1,3}(,\d{3})+\b/g, (m) => numberToWords(parseInt(m.replace(/,/g, ''))));
  t = t.replace(/\b\d+(\.\d+)?\b/g, (m) => numberToWords(parseFloat(m)));
  // symbols
  t = t.replace(/&/g, ' and ').replace(/@/g, ' at ').replace(/\+/g, ' plus ')
    .replace(/=/g, ' equals ').replace(/#/g, ' number ')
    .replace(/[""]/g, '"').replace(/['']/g, "'").replace(/—/g, ', ').replace(/–/g, ' to ');
  // cleanup multiple spaces
  return t.replace(/\s+/g, ' ').trim();
}

// ---------- grapheme → phoneme ----------
interface PhoneTok { key: string; stress: boolean }

const DIGRAPHS: [string, string][] = [
  ['tch', 'CH'], ['igh', 'AY'], ['eigh', 'EY'], ['ough', 'AO'], ['augh', 'AO'],
  ['sch', 'S K'], ['chr', 'K R'], ['ph', 'F'], ['th', 'TH'], ['sh', 'SH'],
  ['ch', 'CH'], ['wh', 'W'], ['ck', 'K'], ['ng', 'NG'], ['qu', 'K W'],
  ['gh', 'G'], ['kn', 'N'], ['wr', 'R'], ['mb', 'M'], ['gn', 'N'],
  ['oo', 'UW'], ['ee', 'IY'], ['ea', 'IY'], ['oa', 'OW'], ['ou', 'AW'],
  ['ow', 'OW'], ['ai', 'EY'], ['ay', 'EY'], ['oi', 'OY'], ['oy', 'OY'],
  ['au', 'AO'], ['aw', 'AO'], ['ie', 'IY'], ['ei', 'EY'], ['eu', 'Y UW'],
  ['ew', 'UW'], ['ue', 'UW'], ['ui', 'UW'], ['oe', 'OW'], ['oa', 'OW'],
  ['er', 'ER'], ['ir', 'ER'], ['ur', 'ER'], ['ar', 'AA R'], ['or', 'AO R'],
];

const SINGLE: Record<string, string> = {
  a: 'AE', b: 'B', c: 'K', d: 'D', e: 'EH', f: 'F', g: 'G', h: 'HH',
  i: 'IH', j: 'JH', k: 'K', l: 'L', m: 'M', n: 'N', o: 'AA', p: 'P',
  q: 'K', r: 'R', s: 'S', t: 'T', u: 'AH', v: 'V', w: 'W', x: 'K S',
  y: 'Y', z: 'Z',
};

const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'EH', 'ER', 'IH', 'IY', 'UH', 'UW', 'AY', 'EY', 'OW', 'AW', 'OY']);

function wordToPhones(wordRaw: string): PhoneTok[] {
  const w = wordRaw.toLowerCase().replace(/[^a-z']/g, '');
  if (!w) return [];
  if (EXCEPTIONS[w]) {
    return EXCEPTIONS[w].split(' ').filter(Boolean).map((k) => ({ key: k, stress: false }));
  }
  // magic-e: silent final e after consonant, making preceding vowel long
  let s = w.replace(/'/g, '');
  const magicE = /^[^aeiou]*[aeiou]+[^aeiou]*e$/.test(s) && s.length > 3;
  if (magicE) s = s.slice(0, -1);
  const toks: PhoneTok[] = [];
  let i = 0;
  let vowelIndex = 0;
  while (i < s.length) {
    let matched = false;
    for (const [g, ph] of DIGRAPHS) {
      if (s.startsWith(g, i)) {
        const keys = ph.split(' ');
        for (const k of keys) {
          const isVowel = VOWELS.has(k);
          if (isVowel) {
            // long vowel for magic-e or double vowel digraphs
            const longKey: Record<string, string> = { AE: 'EY', EH: 'EY', IH: 'AY', AA: 'EY', AH: 'EY' };
            const key = magicE && longKey[k] ? longKey[k] : k;
            toks.push({ key, stress: vowelIndex === 0 && s.length > 3 });
            vowelIndex++;
          } else toks.push({ key: k, stress: false });
        }
        i += g.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const ch = s[i];
    if (ch === 'e' && i === s.length - 1 && toks.length > 0) {
      // silent final e (non magic-e case) → skip
      i++;
      continue;
    }
    let key = SINGLE[ch] ?? '';
    if (key) {
      if (VOWELS.has(key)) {
        if (magicE) {
          const longKey: Record<string, string> = { AE: 'EY', EH: 'EY', IH: 'AY', AA: 'EY', AH: 'EY' };
          key = longKey[key] ?? key;
        }
        toks.push({ key, stress: vowelIndex === 0 && s.length > 3 });
        vowelIndex++;
      } else {
        // doubled consonants
        if (ch === s[i + 1] && !VOWELS.has(SINGLE[s[i + 1]] ?? '')) i++;
        toks.push({ key, stress: false });
      }
    }
    i++;
  }
  return toks.filter((t) => P[t.key]);
}

// ---------- synthesis ----------
const QUALITY_RATE: Record<string, number> = { fast: 16000, balanced: 22050, high: 32000, max: 44100 };

interface ScheduledPhone {
  def: PhoneDef;
  start: number; // sec
  dur: number; // sec
  stress: boolean;
  f0: number;
  nextVowelF?: [number, number, number];
}

export function estimateSpeechDurationSec(text: string, rate: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const wpm = 165 * Math.max(0.25, rate);
  return Math.max(0.2, (words / wpm) * 60);
}

function planSentence(sentence: string, opts: SynthOptions, profile: VoiceProfileDef, contour: (i: number, n: number) => number): ScheduledPhone[] {
  const norm = normalizeText(sentence);
  const words = norm.split(/\s+/).filter(Boolean);
  const rate = Math.max(0.25, opts.rate);
  const phones: ScheduledPhone[] = [];
  let t = 0;
  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi];
    const toks = wordToPhones(word);
    if (toks.length === 0) continue;
    for (let pi = 0; pi < toks.length; pi++) {
      const def = P[toks[pi].key];
      if (!def || def.type === 'silence') continue;
      let dur = (def.dur / 1000) / rate;
      if (toks[pi].stress && def.type === 'vowel') dur *= 1.18;
      const f0 = profile.basePitchHz * opts.pitch * contour(wi, words.length) * (toks[pi].stress ? 1.05 : 1);
      const nextVowelF = (() => {
        for (let j = pi + 1; j < toks.length; j++) {
          const d = P[toks[j].key];
          if (d?.type === 'vowel') return d.f;
        }
        return undefined;
      })();
      phones.push({ def, start: t, dur, stress: toks[pi].stress, f0, nextVowelF });
      t += dur;
    }
    t += 0.045 / rate; // word gap
    if (/[,]$/.test(word)) t += 0.1 / rate;
  }
  return phones;
}

let glottalWaveCache: { ctx: BaseAudioContext; wave: PeriodicWave } | null = null;
function getGlottalWave(ctx: BaseAudioContext): PeriodicWave {
  if (glottalWaveCache && glottalWaveCache.ctx === ctx) return glottalWaveCache.wave;
  const N = 48;
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  for (let n = 1; n < N; n++) {
    imag[n] = (1 / Math.pow(n, 1.12)) * (n % 2 === 1 ? 1 : 0.62); // tilt + slight odd emphasis
  }
  const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  glottalWaveCache = { ctx, wave };
  return wave;
}

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 987654321;
  for (let i = 0; i < len; i++) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    d[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return buf;
}

function renderSentence(
  phones: ScheduledPhone[],
  opts: SynthOptions,
  profile: VoiceProfileDef,
  sampleRate: number,
  tailSec: number,
): Promise<AudioBuffer> {
  const total = phones.length ? phones[phones.length - 1].start + phones[phones.length - 1].dur : 0.1;
  const ctx = new OfflineAudioContext(1, Math.ceil((total + tailSec) * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = opts.volume * (profile.breath > 0.6 ? 0.55 : 1);
  master.connect(ctx.destination);
  const wave = getGlottalWave(ctx);
  const noise = noiseBuffer(ctx);
  const timbre = profile.timbre;
  const flat = profile.id === 'mono-flat' || profile.id === 'chip-robotic';

  for (const ph of phones) {
    const def = ph.def;
    const t0 = ph.start;
    const dur = ph.dur;
    const F = def.f ? ([def.f[0] * timbre, def.f[1] * timbre, def.f[2] * timbre] as [number, number, number]) : undefined;
    const F2 = def.f2 ? ([def.f2[0] * timbre, def.f2[1] * timbre, def.f2[2] * timbre] as [number, number, number]) : undefined;

    const voiced = def.type === 'vowel' || def.type === 'nasal' || def.type === 'glide' ||
      def.type === 'liquid' || def.type === 'rhotic' || def.type === 'fric-v' || def.type === 'stop-v' || def.type === 'affr-v';

    if (voiced && F) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.setValueAtTime(Math.max(60, ph.f0), t0);
      if (!flat) {
        // micro contour within phone
        osc.frequency.linearRampToValueAtTime(Math.max(60, ph.f0 * (def.type === 'vowel' ? 1.012 : 0.995)), t0 + dur);
      }
      const srcGain = ctx.createGain();
      srcGain.gain.setValueAtTime(0, t0);
      srcGain.gain.linearRampToValueAtTime(0.9, t0 + Math.min(0.012, dur * 0.2));
      srcGain.gain.setValueAtTime(0.9, t0 + dur * 0.7);
      srcGain.gain.linearRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(srcGain);
      // 3 formant bandpass filters in parallel
      for (let fi = 0; fi < 3; fi++) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        const Q = fi === 0 ? 7 : fi === 1 ? 9 : 11;
        bp.Q.value = Q;
        const fStart = F[fi];
        bp.frequency.setValueAtTime(Math.max(80, fStart), t0);
        if (F2) bp.frequency.linearRampToValueAtTime(Math.max(80, F2[fi]), t0 + dur);
        else if (def.type === 'glide' || def.type === 'liquid' && ph.nextVowelF) {
          const target = ph.nextVowelF ? ph.nextVowelF[fi] * timbre : fStart;
          bp.frequency.linearRampToValueAtTime(Math.max(80, target), t0 + dur);
        }
        const fg = ctx.createGain();
        fg.gain.value = fi === 0 ? 1 : fi === 1 ? 0.62 : 0.28;
        srcGain.connect(bp);
        bp.connect(fg);
        fg.connect(master);
      }
      // breath noise mixed into voiced path
      if (profile.breath > 0.05) {
        const nsrc = ctx.createBufferSource();
        nsrc.buffer = noise;
        nsrc.loop = true;
        const nf = ctx.createBiquadFilter();
        nf.type = 'bandpass';
        nf.frequency.value = F[1] * 1.6;
        nf.Q.value = 0.6;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t0);
        ng.gain.linearRampToValueAtTime(0.16 * profile.breath, t0 + dur * 0.3);
        ng.gain.linearRampToValueAtTime(0.0001, t0 + dur);
        nsrc.connect(nf);
        nf.connect(ng);
        ng.connect(master);
        nsrc.start(t0, Math.random() * 0.5);
        nsrc.stop(t0 + dur);
      }
      // voiced fricative adds frication
      if (def.type === 'fric-v' && def.band) {
        const nsrc = ctx.createBufferSource();
        nsrc.buffer = noise;
        nsrc.loop = true;
        const nf = ctx.createBiquadFilter();
        nf.type = 'bandpass';
        nf.frequency.value = def.band[0];
        nf.Q.value = def.band[1];
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t0);
        ng.gain.linearRampToValueAtTime(0.22, t0 + dur * 0.35);
        ng.gain.linearRampToValueAtTime(0.0001, t0 + dur);
        nsrc.connect(nf);
        nf.connect(ng);
        ng.connect(master);
        nsrc.start(t0, Math.random() * 0.5);
        nsrc.stop(t0 + dur);
      }
      if (def.type === 'nasal') {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2600;
        // (simple approximation: reduce brightness via extra lowpass on source path)
        void lp;
      }
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }

    if ((def.type === 'fric-u' || def.type === 'aspirate') && def.band) {
      const nsrc = ctx.createBufferSource();
      nsrc.buffer = noise;
      nsrc.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = def.band[0];
      bp.Q.value = def.band[1];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(def.type === 'aspirate' ? 0.1 : 0.3, t0 + dur * 0.25);
      g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
      nsrc.connect(bp);
      bp.connect(g);
      g.connect(master);
      nsrc.start(t0, Math.random() * 0.5);
      nsrc.stop(t0 + dur);
    }

    if ((def.type === 'stop-u' || def.type === 'stop-v' || def.type === 'affr-u' || def.type === 'affr-v') && def.burst) {
      // closure silence then burst
      const closure = def.type.startsWith('affr') ? 0.02 : dur * 0.55;
      const burstDur = def.type.startsWith('affr') ? (dur - closure) * 0.9 : 0.012;
      const nsrc = ctx.createBufferSource();
      nsrc.buffer = noise;
      nsrc.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = def.burst[0];
      bp.Q.value = def.burst[1];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + closure);
      g.gain.linearRampToValueAtTime(def.type.startsWith('affr') ? 0.34 : 0.5, t0 + closure + burstDur * 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + closure + burstDur);
      nsrc.connect(bp);
      bp.connect(g);
      g.connect(master);
      nsrc.start(t0 + closure, Math.random() * 0.5);
      nsrc.stop(t0 + closure + burstDur + 0.01);
      // voiced stops add brief voicing bar
      if (def.type === 'stop-v' && def.f) {
        const osc = ctx.createOscillator();
        osc.setPeriodicWave(wave);
        osc.frequency.value = Math.max(60, ph.f0 * 0.9);
        const vg = ctx.createGain();
        vg.gain.setValueAtTime(0.0001, t0);
        vg.gain.linearRampToValueAtTime(0.18, t0 + closure * 0.4);
        vg.gain.linearRampToValueAtTime(0.0001, t0 + closure);
        const bp2 = ctx.createBiquadFilter();
        bp2.type = 'bandpass';
        bp2.frequency.value = def.f[0] * timbre;
        bp2.Q.value = 6;
        osc.connect(bp2);
        bp2.connect(vg);
        vg.connect(master);
        osc.start(t0);
        osc.stop(t0 + closure + 0.01);
      }
    }
  }

  return ctx.startRendering();
}

/** Segment text into renderable sentences (kept for chunked rendering). */
export function segmentSentences(text: string, maxLen = 400): string[] {
  const parts = text.replace(/\s+/g, ' ').split(/(?<=[.!?;:])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).length > maxLen && cur) {
      out.push(cur.trim());
      cur = '';
    }
    if (p.length > maxLen) {
      // split on commas / spaces
      let rest = p;
      while (rest.length > maxLen) {
        let cut = rest.lastIndexOf(',', maxLen);
        const sc = rest.lastIndexOf(';', maxLen);
        if (sc > cut) cut = sc;
        if (cut < maxLen * 0.4) cut = rest.lastIndexOf(' ', maxLen);
        if (cut <= 0) cut = maxLen;
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
      }
      cur = rest;
    } else {
      cur = cur ? cur + ' ' + p : p;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/**
 * Synthesize speech locally via formant synthesis.
 * Returns a rendered AudioBuffer. Fully offline — no network, no uploads.
 */
export function synthesizeSpeech(
  text: string,
  opts: SynthOptions,
  onProgress?: (p: number) => void,
): Promise<AudioBuffer> {
  return synthesizeWithProfile(text, opts, resolveProfile(opts.profileId), onProgress);
}

/**
 * Synthesize with an explicit profile object — used for live audition of unsaved
 * custom voices (creator sliders) and for saved custom profiles without registering
 * them first. Thin wrapper reusing the exact same internals as synthesizeSpeech.
 */
export function synthesizeSpeechWithProfile(
  profile: VoiceProfileDef,
  text: string,
  opts: Omit<SynthOptions, 'profileId'>,
  onProgress?: (p: number) => void,
): Promise<AudioBuffer> {
  return synthesizeWithProfile(text, { ...opts, profileId: profile.id }, profile, onProgress);
}

async function synthesizeWithProfile(
  text: string,
  opts: SynthOptions,
  profile: VoiceProfileDef,
  onProgress?: (p: number) => void,
): Promise<AudioBuffer> {
  const sampleRate = QUALITY_RATE[opts.quality] ?? 22050;
  const sentences = segmentSentences(text);
  if (sentences.length === 0) {
    const ctx = new OfflineAudioContext(1, sampleRate / 2, sampleRate);
    return ctx.createBuffer(1, sampleRate / 2, sampleRate);
  }
  const estDur = estimateSpeechDurationSec(text, opts.rate);
  if (estDur > 15 * 60) {
    throw new Error('Text too long for a single synthesis call (max ~15 minutes). Use the queue to render in chunks.');
  }

  const buffers: AudioBuffer[] = [];
  const flat = profile.id === 'mono-flat' || profile.id === 'chip-robotic';
  const contour = (wi: number, n: number) => {
    if (flat) return 1;
    // gentle declination with slight rise mid-sentence
    const base = 1 + 0.05 * Math.cos((wi / Math.max(1, n)) * Math.PI) - 0.06 * (wi / Math.max(1, n));
    return base;
  };

  const gapMs = opts.gapMs ?? 0;
  const tailSec = 0.12 + (gapMs > 0 ? gapMs / 1000 : 0.18);

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    // sentence-final intonation: '?' rises, '.' falls, ';' slight fall
    let contourMod = contour;
    if (/\?$/.test(s)) contourMod = (wi, n) => (flat ? 1 : 1 + 0.1 * (wi / Math.max(1, n)));
    else if (/[.;]$/.test(s)) contourMod = (wi, n) => (flat ? 1 : 1 - 0.1 * (wi / Math.max(1, n)));
    const phones = planSentence(s, opts, profile, contourMod);
    if (phones.length === 0) continue;
    const buf = await renderSentence(phones, opts, profile, sampleRate, tailSec);
    buffers.push(buf);
    onProgress?.((i + 1) / sentences.length);
    if (i % 2 === 1) await yieldToUI();
  }

  // text that produced no speech at all (punctuation-only etc.) → short silence
  if (buffers.length === 0) {
    const silent = new OfflineAudioContext(1, Math.round(sampleRate * 0.25), sampleRate);
    return silent.createBuffer(1, Math.round(sampleRate * 0.25), sampleRate);
  }
  if (buffers.length === 1) return buffers[0];
  return concatenateBuffers(buffers, Math.max(0, (opts.gapMs ?? 180) / 1000));
}
