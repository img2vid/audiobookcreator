/**
 * Web Speech Recognition wrapper — minimal, dependency-free.
 *
 * Declares the tiny slice of the SpeechRecognition API the Transcribe Studio
 * needs (module-local ambient shapes — deliberately NOT global augmentations,
 * so newer lib.dom versions that ship their own declarations can't conflict).
 * Also provides the language catalog and a live recognizer that auto-restarts
 * on 'end' (Chrome periodically stops a continuous session) while the host
 * session is still running.
 *
 * Unavailable engines (Firefox / Safari / SSR) simply return null — callers
 * fall back to manual stamping.
 */

// ---------- minimal ambient types (module-local, no global pollution) ----------

export interface SpeechAlternativeLike {
  transcript: string;
  confidence: number;
}

export interface SpeechResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternativeLike;
}

export interface SpeechResultListLike {
  length: number;
  [index: number]: SpeechResultLike;
}

export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechResultListLike;
}

export interface SpeechRecognitionErrorEventLike {
  error: string;
  message?: string;
}

export interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((e: Event) => void) | null;
  onend: ((e: Event) => void) | null;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechWindow {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

// ---------- availability probe ----------

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechRecognitionAvailable(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

// ---------- language catalog ----------

export interface SpeechLanguageOption {
  id: string; // '' = browser default
  label: string;
}

export const SPEECH_LANGUAGES: SpeechLanguageOption[] = [
  { id: '', label: 'Browser default' },
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'es-ES', label: 'Español (España)' },
  { id: 'fr-FR', label: 'Français' },
  { id: 'de-DE', label: 'Deutsch' },
  { id: 'it-IT', label: 'Italiano' },
  { id: 'pt-BR', label: 'Português (Brasil)' },
  { id: 'hi-IN', label: 'हिन्दी' },
  { id: 'ar-SA', label: 'العربية' },
  { id: 'zh-CN', label: '中文 (简体)' },
  { id: 'ja-JP', label: '日本語' },
  { id: 'ko-KR', label: '한국어' },
  { id: 'ru-RU', label: 'Русский' },
];

// ---------- speaker diarization heuristics (R11-b) ----------
//
// Deterministic, dependency-free "who said this?" suggestions built from two
// signals the transcript already carries: PAUSES (silence between segments)
// and PACING (clip lengths). Pure + SSR-safe: no window/document, no
// Math.random, no Date.now — same input in, same suggestions out, every time,
// on the server or in a worker.

export type SpeakerSuggestionReason = 'gap' | 'duration' | 'seed' | 'alternation';

/** Minimal segment shape the heuristics need (text is accepted but unused — timing only). */
export interface SuggestSpeakersSegment {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string | null;
}

export interface SpeakerSuggestion {
  /** Index into the CALLER's array (original order, not the time-sorted copy). */
  index: number;
  speaker: string;
  /** 0..1 — rough confidence; ≥ 0.6 is treated as high-confidence by the UI. */
  confidence: number;
  reason: SpeakerSuggestionReason;
}

export interface SuggestSpeakersOptions {
  /** Pause (prev end → start) that opens a candidate new speaker turn. Default 1.2 s. */
  gapSec?: number;
  /** Cap on DISTINCT new speaker names (seeds excluded). Default 4. */
  maxSpeakers?: number;
}

const DEFAULT_GAP_SEC = 1.2;
const DEFAULT_MAX_SPEAKERS = 4;
/** A clip inherits a tagged speaker's name when |Δdur| / taggedDur ≤ 15 %. */
const DURATION_MATCH_TOLERANCE = 0.15;
/** log-duration spread below which a whole turn is treated as ONE speaker (ratio < e^0.2 ≈ 1.22). */
const UNIFORM_SPREAD_LOG = 0.2;
const KMEANS_MAX_ITER = 20;
/** k is picked as the smallest whose inertia lands within 20 % of the best (elbow-ish). */
const K_INERTIA_TOLERANCE = 0.2;
/** Floor for log-duration (0-length clips still cluster). */
const MIN_DUR_SEC = 0.05;

const CONFIDENCE_SEED = 1;
const CONFIDENCE_GAP_BASE = 0.55;
const CONFIDENCE_GAP_MAX_BONUS = 0.35;
const CONFIDENCE_DURATION_INHERIT = 0.78;
const CONFIDENCE_DURATION_CLUSTER = 0.62;
const CONFIDENCE_DURATION_REUSE = 0.55;
const CONFIDENCE_ALTERNATION = 0.45;

/** "Speaker A"…"Speaker Z", then "S27", "S28"… (letters run out past 26). */
function newSpeakerLabel(n: number): string {
  return n < 26 ? `Speaker ${String.fromCharCode(65 + n)}` : `S${n + 1}`;
}

interface Item {
  index: number; // original caller index
  start: number;
  end: number;
  dur: number;
  speaker: string | null; // trimmed seed name, if any
}

/**
 * 1-D k-means over log-durations. Deterministic: quantile init on the sorted
 * values (shortest and longest anchor the extremes), distance ties resolve to
 * the lower cluster index, empty clusters keep their centroid, ≤ 20 iterations.
 */
function kMeans1D(values: number[], k: number): { assign: number[]; centroids: number[]; inertia: number } {
  const n = values.length;
  const sortedIdx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const centroids: number[] = [];
  for (let c = 0; c < k; c++) {
    const pos = k === 1 ? 0 : Math.min(n - 1, Math.round((c * (n - 1)) / (k - 1)));
    centroids.push(sortedIdx[pos].v);
  }
  let assign = new Array<number>(n).fill(0);
  for (let iter = 0; iter < KMEANS_MAX_ITER; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = Math.abs(values[i] - centroids[c]);
        if (d < bestD - 1e-12) { bestD = d; best = c; } // strict `<` keeps lower index on ties
      }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    for (let c = 0; c < k; c++) {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (assign[i] === c) { sum += values[i]; count++; }
      }
      if (count > 0) centroids[c] = sum / count; // empty cluster keeps its centroid
    }
    if (!changed && iter > 0) break;
  }
  let inertia = 0;
  for (let i = 0; i < n; i++) inertia += (values[i] - centroids[assign[i]]) ** 2;
  return { assign, centroids, inertia };
}

/**
 * Suggest speaker tags for a transcript. See the section comment above for the
 * full heuristic; short version — seeds are kept, long pauses open candidate
 * new turns, clip lengths inherit tagged names or form k-means duration
 * clusters, and a light alternation pass breaks suspicious same-speaker runs.
 * Every untagged segment with valid times gets exactly one suggestion; tagged
 * segments get a `seed` suggestion echoing their existing name. Negative/NaN
 * times are filtered out; empty input returns []. Never mutates the caller's
 * array. Output is sorted by the original index.
 */
export function suggestSpeakers(
  segments: SuggestSpeakersSegment[],
  opts?: SuggestSpeakersOptions,
): SpeakerSuggestion[] {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const gapThreshold = typeof opts?.gapSec === 'number' && Number.isFinite(opts.gapSec) ? Math.max(0, opts.gapSec) : DEFAULT_GAP_SEC;
  const maxSpeakers = Math.max(1, Math.floor(typeof opts?.maxSpeakers === 'number' && Number.isFinite(opts.maxSpeakers) ? opts.maxSpeakers : DEFAULT_MAX_SPEAKERS));

  // Normalize + drop invalid times; keep original indices; sort a copy in time order.
  const items: Item[] = segments
    .map((s, index) => {
      const start = typeof s?.startSec === 'number' && Number.isFinite(s.startSec) ? s.startSec : NaN;
      const end = typeof s?.endSec === 'number' && Number.isFinite(s.endSec) ? s.endSec : NaN;
      const speaker = typeof s?.speaker === 'string' && s.speaker.trim() ? s.speaker.trim() : null;
      return { index, start, end, speaker, dur: Number.isFinite(start) && Number.isFinite(end) ? end - start : NaN };
    })
    .filter((it) => Number.isFinite(it.start) && Number.isFinite(it.end) && it.start >= 0 && it.end >= 0)
    .sort((a, b) => a.start - b.start || a.index - b.index);
  if (!items.length) return [];

  const suggestions = new Map<number, SpeakerSuggestion>();

  // (a) seeds — tagged segments keep their speaker, full confidence.
  for (const it of items) {
    if (it.speaker) suggestions.set(it.index, { index: it.index, speaker: it.speaker, confidence: CONFIDENCE_SEED, reason: 'seed' });
  }
  const usedNames = new Set<string>(items.flatMap((it) => (it.speaker ? [it.speaker] : [])));

  // Tagged clip lengths power the duration-inheritance rule (global — simple + deterministic).
  const taggedDurs: { name: string; dur: number }[] = items
    .filter((it) => it.speaker && it.dur > 0)
    .map((it) => ({ name: it.speaker as string, dur: it.dur }));
  /** The ONE tagged speaker whose clip length is within 15 % — null when none or ambiguous. */
  const inheritFor = (dur: number): string | null => {
    if (!(dur > 0)) return null;
    let match: string | null = null;
    for (const t of taggedDurs) {
      if (Math.abs(dur - t.dur) / t.dur <= DURATION_MATCH_TOLERANCE) {
        if (match === null) match = t.name;
        else if (match !== t.name) return null; // two tagged speakers match — ambiguous
      }
    }
    return match;
  };

  // New-speaker bookkeeping: first-appearance names + mean durations for over-cap reuse.
  const newSpeakerDurs = new Map<string, number[]>();
  let newNameCount = 0;
  let nextLabelN = 0;
  const mintNewName = (): string => {
    let label = newSpeakerLabel(nextLabelN);
    while (usedNames.has(label)) label = newSpeakerLabel(++nextLabelN);
    nextLabelN++;
    usedNames.add(label);
    newSpeakerDurs.set(label, []);
    newNameCount++;
    return label;
  };
  const closestExistingNewSpeaker = (dur: number): string | null => {
    let best: string | null = null;
    let bestD = Infinity;
    for (const [name, durs] of newSpeakerDurs) {
      if (!durs.length) continue;
      const mean = durs.reduce((a, b) => a + b, 0) / durs.length;
      const d = Math.abs(mean - dur);
      if (d < bestD - 1e-12) { bestD = d; best = name; }
    }
    return best;
  };

  // Split into turns: a turn starts at the first segment and after any pause > gapThreshold.
  const untaggedInTurn: Item[][] = [[]];
  let prevEnd: number | null = null;
  for (const it of items) {
    const gap = prevEnd !== null ? it.start - prevEnd : null;
    if (prevEnd !== null && gap !== null && gap > gapThreshold) {
      untaggedInTurn.push([]);
    }
    untaggedInTurn[untaggedInTurn.length - 1].push(it);
    prevEnd = it.end;
  }

  for (let t = 0; t < untaggedInTurn.length; t++) {
    const turn = untaggedInTurn[t];
    if (!turn.length) continue;
    const firstOverall = turn[0];
    // (c) first pass — inherit a tagged speaker when the clip length matches uniquely.
    const rest: Item[] = [];
    for (const it of turn) {
      if (suggestions.has(it.index)) continue; // seed — never re-assigned
      const inherited = inheritFor(it.dur);
      if (inherited) {
        suggestions.set(it.index, { index: it.index, speaker: inherited, confidence: CONFIDENCE_DURATION_INHERIT, reason: 'duration' });
      } else {
        rest.push(it);
      }
    }
    if (!rest.length) continue;

    const assignName = (clusterMeanDur: number): { name: string; reused: boolean } => {
      if (newNameCount < maxSpeakers) return { name: mintNewName(), reused: false };
      const reuse = closestExistingNewSpeaker(clusterMeanDur);
      if (reuse) return { name: reuse, reused: true };
      return { name: mintNewName(), reused: false }; // budget freed by construction — never hits here
    };

    // Near-uniform clip lengths (or a lone segment) — the whole turn is ONE voice.
    const logs = rest.map((it) => Math.log(Math.max(MIN_DUR_SEC, it.dur)));
    const spread = Math.max(...logs) - Math.min(...logs);
    if (rest.length === 1 || spread < UNIFORM_SPREAD_LOG) {
      const meanDur = rest.reduce((a, it) => a + Math.max(MIN_DUR_SEC, it.dur), 0) / rest.length;
      const { name, reused } = assignName(meanDur);
      const clusterConf = reused ? CONFIDENCE_DURATION_REUSE : CONFIDENCE_DURATION_CLUSTER;
      for (const it of rest) {
        if (it === firstOverall) {
          // Turn opener: the pause (or the start of the recording) is the evidence.
          const gap = it === items[0] ? null : it.start - (items[items.indexOf(it) - 1]?.end ?? 0);
          const conf = gap === null
            ? CONFIDENCE_GAP_BASE
            : CONFIDENCE_GAP_BASE + Math.min(CONFIDENCE_GAP_MAX_BONUS, Math.max(0, gap) * 0.1);
          suggestions.set(it.index, { index: it.index, speaker: name, confidence: conf, reason: 'gap' });
        } else {
          suggestions.set(it.index, { index: it.index, speaker: name, confidence: clusterConf, reason: 'duration' });
        }
      }
      for (const it of rest) newSpeakerDurs.get(name)?.push(Math.max(MIN_DUR_SEC, it.dur));
      continue;
    }

    // (c) second pass — 1-D k-means on log-duration, k chosen elbow-style in 2..maxSpeakers.
    const kMax = Math.min(maxSpeakers, rest.length);
    let chosen: { assign: number[]; inertia: number } | null = null;
    if (kMax >= 2) {
      let bestInertia = Infinity;
      const candidates: { k: number; assign: number[]; inertia: number }[] = [];
      for (let k = 2; k <= kMax; k++) {
        const r = kMeans1D(logs, k);
        candidates.push({ k, assign: r.assign, inertia: r.inertia });
        if (r.inertia < bestInertia) bestInertia = r.inertia;
      }
      const tol = Math.abs(bestInertia) * K_INERTIA_TOLERANCE + 1e-9;
      chosen = candidates.find((c) => c.inertia <= bestInertia + tol) ?? candidates[candidates.length - 1];
    }

    if (!chosen) {
      // Degenerate (single segment) — one voice, same as the uniform path.
      const it = rest[0];
      const { name } = assignName(Math.max(MIN_DUR_SEC, it.dur));
      suggestions.set(it.index, { index: it.index, speaker: name, confidence: CONFIDENCE_GAP_BASE, reason: 'gap' });
      newSpeakerDurs.get(name)?.push(Math.max(MIN_DUR_SEC, it.dur));
      continue;
    }

    // Map clusters → names in first-appearance order (chronological walk).
    const clusterNames = new Map<number, { name: string; reused: boolean }>();
    rest.forEach((it, i) => {
      const c = chosen!.assign[i];
      let entry = clusterNames.get(c);
      if (!entry) {
        let sum = 0;
        let count = 0;
        for (let j = 0; j < rest.length; j++) {
          if (chosen!.assign[j] === c) { sum += Math.max(MIN_DUR_SEC, rest[j].dur); count++; }
        }
        entry = assignName(count > 0 ? sum / count : MIN_DUR_SEC);
        clusterNames.set(c, entry);
      }
      const clusterConf = entry.reused ? CONFIDENCE_DURATION_REUSE : CONFIDENCE_DURATION_CLUSTER;
      if (it === firstOverall) {
        const gap = it === items[0] ? null : it.start - (items[items.indexOf(it) - 1]?.end ?? 0);
        const conf = gap === null
          ? CONFIDENCE_GAP_BASE
          : CONFIDENCE_GAP_BASE + Math.min(CONFIDENCE_GAP_MAX_BONUS, Math.max(0, gap) * 0.1);
        suggestions.set(it.index, { index: it.index, speaker: entry.name, confidence: conf, reason: 'gap' });
      } else {
        suggestions.set(it.index, { index: it.index, speaker: entry.name, confidence: clusterConf, reason: 'duration' });
      }
      newSpeakerDurs.get(entry.name)?.push(Math.max(MIN_DUR_SEC, it.dur));
    });
  }

  // (d) light alternation smoothing — a run of > 3 identical suggested speakers
  // between two DIFFERENT tagged speakers smells like a missed handoff: flip the
  // single lowest-confidence run member toward the nearer tagged neighbour.
  const ordered = items.map((it) => suggestions.get(it.index)).filter((s): s is SpeakerSuggestion => !!s);
  let runStart = 0;
  while (runStart < ordered.length) {
    let runEnd = runStart;
    while (runEnd + 1 < ordered.length && ordered[runEnd + 1].speaker === ordered[runStart].speaker) runEnd++;
    const runLen = runEnd - runStart + 1;
    const runIsSuggested = ordered.slice(runStart, runEnd + 1).some((s) => s.reason !== 'seed');
    if (runLen > 3 && runIsSuggested) {
      const prevTagged = ordered[runStart - 1]?.reason === 'seed' ? ordered[runStart - 1].speaker : null;
      let nextTagged: string | null = null;
      for (let i = runEnd + 1; i < ordered.length; i++) {
        if (ordered[i].reason === 'seed') { nextTagged = ordered[i].speaker; break; }
      }
      if (prevTagged && nextTagged && prevTagged !== nextTagged) {
        const members = ordered
          .slice(runStart, runEnd + 1)
          .map((s, pos) => ({ s, pos }))
          .filter(({ s }) => s.reason !== 'seed')
          .sort((a, b) => a.s.confidence - b.s.confidence || a.s.index - b.s.index);
        for (const { s, pos } of members) {
          const target = pos < runLen / 2 ? prevTagged : nextTagged;
          if (target !== s.speaker) {
            suggestions.set(s.index, { index: s.index, speaker: target, confidence: CONFIDENCE_ALTERNATION, reason: 'alternation' });
            break; // one deliberate flip per run — "light" smoothing
          }
        }
      }
    }
    runStart = runEnd + 1;
  }

  return [...suggestions.values()].sort((a, b) => a.index - b.index);
}

/**
 * Human sentence for a suggestion tooltip. Accepts a full suggestion (preferred
 * — phrasing can use the suggested name) or a bare reason string. For `gap`
 * suggestions pass the measured pause in seconds; omit it for the first
 * segment of a transcript ("Start of the recording — first turn").
 */
export function describeSuggestion(
  suggestionOrReason: SpeakerSuggestion | SpeakerSuggestionReason,
  gapSec?: number,
): string {
  const reason = typeof suggestionOrReason === 'string' ? suggestionOrReason : suggestionOrReason.reason;
  const speaker = typeof suggestionOrReason === 'string' ? null : suggestionOrReason.speaker;
  const name = speaker && speaker.trim() ? speaker.trim() : 'this speaker';
  switch (reason) {
    case 'seed':
      return speaker && speaker.trim() ? `Already tagged ${speaker.trim()}` : 'Keeps its existing tag';
    case 'gap':
      return gapSec !== undefined && Number.isFinite(gapSec) && gapSec >= 0
        ? `After a ${gapSec.toFixed(1)} s pause`
        : 'Start of the recording — first turn';
    case 'duration':
      return `Clip length matches ${name}'s`;
    case 'alternation':
      return 'Turn-taking pattern suggests a new voice here';
  }
}

// ---------- live recognizer with auto-restart ----------

export interface LiveRecognizerOptions {
  /** BCP-47 tag, or '' for the browser default. */
  lang: string;
  /** While false, 'end' no longer auto-restarts (session stopped/paused). */
  shouldRun: () => boolean;
  onFinal: (text: string, confidence: number) => void;
  onInterim: (text: string) => void;
  /** Real errors only — callers still filter silent codes ('no-speech', 'aborted'). */
  onError: (code: string, message: string) => void;
}

export interface LiveRecognizer {
  start(): void;
  stop(): void;
  setLang(lang: string): void;
}

const RESTART_DELAY_MS = 250;
/** Give up if the engine bounces more than this many times within the window. */
const RESTART_WINDOW_MS = 5000;
const RESTART_MAX_BOUNCES = 8;

export function createLiveRecognizer(opts: LiveRecognizerOptions): LiveRecognizer | null {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return null;

  let rec: SpeechRecognitionLike | null = null;
  let lang = opts.lang;
  let stopped = false;
  let restartTimes: number[] = [];
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const build = (): SpeechRecognitionLike => {
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    if (lang) r.lang = lang;

    r.onresult = (e: SpeechRecognitionEventLike) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const alt = res[0];
        if (!alt) continue;
        if (res.isFinal) {
          const text = alt.transcript.trim();
          if (text) opts.onFinal(text, alt.confidence);
        } else {
          interim += alt.transcript;
        }
      }
      opts.onInterim(interim.trim());
    };

    r.onerror = (e: SpeechRecognitionErrorEventLike) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // routine — handled by restart
      opts.onError(e.error, e.message ?? e.error);
    };

    r.onend = () => {
      if (stopped || !opts.shouldRun()) return;
      // Engine bounced while the session is live — auto-restart (bounded).
      const now = Date.now();
      restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
      restartTimes.push(now);
      if (restartTimes.length > RESTART_MAX_BOUNCES) {
        opts.onError('restart-loop', 'Recognition keeps stopping — try a different language or reload the page.');
        return;
      }
      restartTimer = setTimeout(() => {
        if (stopped || !opts.shouldRun()) return;
        try { rec?.start(); } catch { /* already started — next 'end' retries */ }
      }, RESTART_DELAY_MS);
    };

    return r;
  };

  rec = build();

  return {
    start() {
      stopped = false;
      restartTimes = [];
      try { rec?.start(); } catch { /* InvalidStateError — already running */ }
    },
    stop() {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      try { rec?.stop(); } catch { /* not running */ }
    },
    setLang(next: string) {
      if (next === lang) return;
      lang = next;
      // Apply on a fresh session: stop now; the host's restart flow picks the new lang up.
      try { rec?.stop(); } catch { /* not running */ }
    },
  };
}
