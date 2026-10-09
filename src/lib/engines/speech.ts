// Web Speech API wrapper for the neural / system engines — v2 naturalness pass.
// Works out of the box, no network models required.
//
// Why system/neural voices used to sound robotic here, and what changed:
//   1. Long text was chopped into fixed 180-character chunks and fed to the
//      synthesizer back-to-back, producing clipped, breathless, machine-like
//      pacing. → Chunks are now sentence-aligned (never mid-clause when
//      avoidable) and separated by a natural breathing pause that is longer
//      at paragraph breaks.
//   2. Raw text was sent as-is, so markdown debris and symbols were read
//      aloud ("asterisk asterisk…", stray pipes and backticks). →
//      prepareTextForNeuralSpeech() cleans markup, converts dashes and
//      symbols to spoken pauses and drops emoji/pictographs.
//   3. Voice selection silently fell back to the OS default — very often a
//      robotic SAPI/espeak voice. → scoreVoice()/pickBestVoice() rank
//      neural/natural/premium voices first and penalize known-robotic ones.
//   4. Chrome silently stalls utterances after ~15 s. → a keep-alive
//      interval nudges the queue while it is speaking.
// The public API is unchanged: SpeechSpeaker, SpeechQueue, listSystemVoices…
import type { SpeakerHandlers, SpeakOptions, SystemVoiceClass } from '@/lib/types';

export function isSpeechSynthesisAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function listSystemVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!isSpeechSynthesisAvailable()) return resolve([]);
    const v = window.speechSynthesis.getVoices();
    if (v.length) return resolve(v);
    const handler = () => {
      resolve(window.speechSynthesis.getVoices());
      window.speechSynthesis.onvoiceschanged = null;
    };
    window.speechSynthesis.onvoiceschanged = handler;
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1500);
  });
}

export function onVoicesChanged(cb: () => void): () => void {
  if (!isSpeechSynthesisAvailable()) return () => {};
  window.speechSynthesis.onvoiceschanged = cb;
  return () => {
    window.speechSynthesis.onvoiceschanged = null;
  };
}

// ---------- text preparation for neural engines ----------
/**
 * Clean arbitrary prose/markdown for speech synthesis: never read formatting
 * debris aloud, and turn typographic symbols into the pauses a narrator
 * would make. Keeps paragraph breaks so the queue can breathe at them.
 */
export function prepareTextForNeuralSpeech(text: string): string {
  let t = text;
  // markdown: code fences/inline code, links, emphasis, headings, quotes, bullets
  t = t
    .replace(/```[\s\S]*?```/g, ' Code block. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, ' image: $1. ')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '');
  // typographic symbols → spoken pauses; strip decorative characters
  t = t
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, ', ')
    .replace(/\u2026/g, '...')
    .replace(/[*_~|>#`]+/g, ' ')
    // drop emoji, pictographs, arrows, dingbats, variation selectors, ZWJ
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ');
  // whitespace: keep \n and \n\n (paragraph breath), drop the rest
  t = t
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  // guarantee a space after sentence punctuation so chunking sees boundaries
  t = t.replace(/([.!?,;:])([A-Za-z])/g, '$1 $2');
  return t.trim();
}

// ---------- voice quality ranking ----------
const ROBOTIC_VOICE_RE = /espeak|flite|pico|festival|mbrola|freetts|cephstral|robotic|sam\b/i;
const NEURAL_VOICE_RE = /neural|natural|premium|enhanced|studio/i;

/**
 * Score a system voice by how natural it is likely to sound.
 * Neural/natural/premium names rank highest; classic robotic engines
 * (eSpeak, Pico, Flite, Festival…) are penalized hard so they are only
 * used when nothing better exists.
 */
export function scoreVoice(v: SpeechSynthesisVoice, lang?: string): number {
  return scoreVoiceForClass(v, lang, 'neural');
}

/**
 * Class-aware voice scoring. This is what makes engine selection REAL:
 *  - 'neural'   → neural/natural/premium voices float to the top.
 *  - 'classic'  → classic local SAPI-style voices (localService, no
 *                 neural/online branding) float to the top, so selecting
 *                 “OS Classic Voices” actually yields a classic voice.
 *  - 'any'      → plain naturalness ranking (legacy behavior).
 */
export function scoreVoiceForClass(v: SpeechSynthesisVoice, lang: string | undefined, voiceClass: SystemVoiceClass): number {
  let s = 0;
  const name = v.name;
  const neuralish = NEURAL_VOICE_RE.test(name) || /\b(online|cloud)\b/i.test(name) || /siri/i.test(name) || /google/i.test(name);
  if (voiceClass === 'classic') {
    // classic ranking: the plain local voices the OS has shipped for years
    if (v.localService) s += 40;
    else s -= 24; // network voices are (almost) always the neural ones
    if (neuralish) s -= 45; // explicitly avoid neural branding
    if (/microsoft/i.test(name)) s += 10; // David / Zira desktop classics
    if (/\b(david|zira|mark|hazel|susan|alex|fred|ralph|kathy|albert)\b/i.test(name)) s += 12;
    if (ROBOTIC_VOICE_RE.test(name)) s -= 20; // still the last resort
    if (/\b(compact|basic|eloquence)\b/i.test(name)) s -= 24;
  } else {
    if (NEURAL_VOICE_RE.test(name)) s += 45;
    if (/siri/i.test(name)) s += 38;
    if (/google/i.test(name)) s += 30;
    if (/\b(online|cloud)\b/i.test(name)) s += 14;
    if (/microsoft/i.test(name)) s += 8;
    if (v.localService) s += 6;
    else s += 4; // network voices often sound best; keep a small base
    if (ROBOTIC_VOICE_RE.test(name)) s -= 55;
    if (/\b(compact|basic|eloquence)\b/i.test(name)) s -= 30;
  }
  if (v.default) s += 3;
  if (lang) {
    const want = lang.split(/[-_]/)[0].toLowerCase();
    const have = v.lang.split(/[-_]/)[0].toLowerCase();
    if (have === want) s += 20;
    else if (v.lang.toLowerCase().startsWith(want)) s += 10;
    else s -= 25;
  }
  return s;
}

/** Highest-scoring voice for a (optional) language — prefers neural quality. */
export function pickBestVoice(voices: SpeechSynthesisVoice[], lang?: string): SpeechSynthesisVoice | null {
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -Infinity;
  for (const v of voices) {
    const s = scoreVoice(v, lang);
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }
  return best;
}

/**
 * Resolve the voice the SPEAKER actually asked for, honoring the engine's
 * voice class when no explicit voice is configured:
 *   1. exact voiceURI match (the user's explicit selection always wins)
 *   2. best voice of the requested class + language
 *   3. best voice of that class in any language
 * Returns null when the browser exposes no voices at all.
 */
export function pickVoiceForOptions(voices: SpeechSynthesisVoice[], opts: Pick<SpeakOptions, 'voiceURI' | 'voiceClass' | 'lang'>): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  if (opts.voiceURI) {
    const exact = voices.find((x) => x.voiceURI === opts.voiceURI);
    if (exact) return exact;
  }
  const voiceClass: SystemVoiceClass = opts.voiceClass ?? 'any';
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -Infinity;
  for (const v of voices) {
    const s = scoreVoiceForClass(v, opts.lang, voiceClass);
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }
  return best;
}

export function splitIntoChunks(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const out: string[] = [];
  for (const para of paragraphs) {
    const clean = para.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    if (clean.length <= maxChars) {
      out.push(clean);
      continue;
    }
    // pack whole sentences up to maxChars — never leave a chunk mid-sentence
    const sentences = clean.match(/[^.!?\n]+[.!?]*/g) ?? [clean];
    let cur = '';
    const flush = () => {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    };
    for (const s of sentences) {
      if (s.length > maxChars) {
        flush();
        out.push(...hardSplitSentence(s, maxChars));
        continue;
      }
      if ((cur + ' ' + s).trim().length > maxChars && cur) flush();
      cur = cur ? cur + ' ' + s : s;
    }
    flush();
  }
  return out;
}

/** Hard-split an over-long sentence, preferring clause punctuation over raw word breaks. */
function hardSplitSentence(sentence: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(', ', maxChars);
    let keepSep = true;
    for (const sep of ['; ', ': ', ' — ', ' – ']) {
      const idx = rest.lastIndexOf(sep, maxChars);
      if (idx > cut) { cut = idx; keepSep = true; }
    }
    if (cut < maxChars * 0.5) {
      cut = rest.lastIndexOf(' ', maxChars);
      keepSep = false;
    }
    if (cut <= 0) {
      cut = maxChars;
      keepSep = false;
    }
    if (keepSep) {
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    } else {
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut + 1).trim();
    }
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

export class SpeechSpeaker {
  private utter: SpeechSynthesisUtterance | null = null;
  state: 'idle' | 'speaking' | 'paused' = 'idle';

  speak(text: string, opts: SpeakOptions, handlers?: SpeakerHandlers): void {
    if (!isSpeechSynthesisAvailable()) {
      handlers?.onEnd?.(new Error('Speech synthesis unavailable in this browser'));
      return;
    }
    this.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    // Resolve the voice the user (or the selected engine) asked for — an
    // unknown voiceURI falls back to the requested voice CLASS, never to a
    // hard-coded neural default.
    const voice = pickVoiceForOptions(voices, opts) ?? undefined;
    if (voice) {
      u.voice = voice;
      if (voice.lang) u.lang = voice.lang;
    } else if (opts.lang) {
      u.lang = opts.lang;
    }
    if (opts.rate != null) u.rate = Math.max(0.1, Math.min(10, opts.rate));
    if (opts.pitch != null) u.pitch = Math.max(0, Math.min(2, opts.pitch));
    if (opts.volume != null) u.volume = Math.max(0, Math.min(1, opts.volume));
    u.onstart = () => {
      this.state = 'speaking';
      handlers?.onStart?.();
    };
    u.onboundary = (e) => {
      if (e.name === 'word' || e.name === undefined) {
        const word = text.slice(e.charIndex, e.charIndex + (e.charLength || 8));
        handlers?.onBoundary?.(e.charIndex, word.trim().split(/\s/)[0] ?? '');
      }
    };
    u.onend = () => {
      this.state = 'idle';
      handlers?.onEnd?.();
    };
    u.onerror = (e) => {
      this.state = 'idle';
      handlers?.onEnd?.(new Error(e.error || 'speech error'));
    };
    this.utter = u;
    window.speechSynthesis.speak(u);
  }

  pause() {
    if (isSpeechSynthesisAvailable() && this.state === 'speaking') {
      window.speechSynthesis.pause();
      this.state = 'paused';
    }
  }

  resume() {
    if (isSpeechSynthesisAvailable() && this.state === 'paused') {
      window.speechSynthesis.resume();
      this.state = 'speaking';
    }
  }

  cancel() {
    if (isSpeechSynthesisAvailable()) {
      try { window.speechSynthesis.cancel(); } catch { /* noop */ }
    }
    this.state = 'idle';
    this.utter = null;
  }
}

// ---------- quality helpers ----------
export function listNeuralVoices(): Promise<SpeechSynthesisVoice[]> {
  return listSystemVoices().then((voices) => {
    const ranked = voices
      .map((v) => ({ v, s: scoreVoice(v) }))
      .sort((a, b) => b.s - a.s);
    // anything above the "generic local" band counts as neural-quality
    const top = ranked.filter((x) => x.s >= 30).map((x) => x.v);
    return top.length ? top : voices.filter((v) => v.localService);
  });
}

export function groupVoicesByLang(voices: SpeechSynthesisVoice[]): Map<string, SpeechSynthesisVoice[]> {
  const map = new Map<string, SpeechSynthesisVoice[]>();
  for (const v of voices) {
    const key = v.lang.split(/[-_]/)[0].toLowerCase();
    const arr = map.get(key) ?? [];
    arr.push(v);
    map.set(key, arr);
  }
  return map;
}

// ---------- long-text narrator ----------
export interface SpeechQueueHandlers {
  onStart?: () => void;
  onBoundary?: (absoluteCharIndex: number, word: string) => void;
  onProgress?: (spokenChars: number, totalChars: number) => void;
  onEnd?: (error?: Error) => void;
}

export interface SpeechPauseOptions {
  /** Breathing pause between chunks (ms). Default 170. */
  chunkPauseMs?: number;
  /** Extra-long pause when the next chunk starts a new paragraph (ms). Default 430. */
  paragraphPauseMs?: number;
}

/**
 * Speaks arbitrarily long text by chunking (browsers truncate long utterances).
 * Chunks are sentence-aligned and separated by natural breathing pauses;
 * boundary callbacks report absolute indices into the ORIGINAL text.
 */
export class SpeechQueue {
  private speaker = new SpeechSpeaker();
  private chunks: string[] = [];
  private offsets: number[] = [];
  private chunkPauses: number[] = [];
  private index = 0;
  private paused = false;
  private stopped = false;
  private total = 0;
  private gapTimer: number | null = null;
  private keepAlive: number | null = null;
  private maxChars: number;
  private pauses: SpeechPauseOptions;

  constructor(maxChars = 180, pauses: SpeechPauseOptions = {}) {
    this.maxChars = maxChars;
    this.pauses = pauses;
  }

  get isActive(): boolean {
    return this.index > 0 || this.speaker.state !== 'idle';
  }
  get isPaused(): boolean {
    return this.paused;
  }

  start(text: string, opts: SpeakOptions, handlers?: SpeechQueueHandlers): void {
    this.stop();
    const clean = prepareTextForNeuralSpeech(text);
    this.chunks = splitIntoChunks(clean, this.maxChars);
    // compute absolute offsets of each chunk in the cleaned text
    this.offsets = [];
    let searchFrom = 0;
    for (const c of this.chunks) {
      const idx = clean.indexOf(c, searchFrom);
      this.offsets.push(idx >= 0 ? idx : searchFrom);
      searchFrom = Math.max(searchFrom, (idx >= 0 ? idx : searchFrom) + c.length);
    }
    this.total = clean.length;
    // breathing pauses between chunks; paragraphs get a longer beat
    const chunkPause = Math.max(0, this.pauses.chunkPauseMs ?? 170);
    const paraPause = Math.max(0, this.pauses.paragraphPauseMs ?? 430);
    this.chunkPauses = this.chunks.map((c, i) => {
      const end = this.offsets[i] + c.length;
      const next = clean.slice(end, end + 2);
      return next.includes('\n') ? paraPause : chunkPause;
    });
    this.index = 0;
    this.paused = false;
    this.stopped = false;
    this.armKeepAlive();
    handlers?.onStart?.();
    this.speakNext(opts, handlers);
  }

  private speakNext(opts: SpeakOptions, handlers?: SpeechQueueHandlers): void {
    if (this.stopped) return;
    if (this.index >= this.chunks.length) {
      this.disarmKeepAlive();
      handlers?.onProgress?.(this.total, this.total);
      handlers?.onEnd?.();
      return;
    }
    const chunk = this.chunks[this.index];
    const baseOffset = this.offsets[this.index];
    this.speaker.speak(chunk, opts, {
      onStart: () => handlers?.onProgress?.(baseOffset, this.total),
      onBoundary: (charIndex, word) => {
        handlers?.onBoundary?.(baseOffset + charIndex, word);
      },
      onEnd: (err) => {
        if (this.stopped) return;
        if (err) {
          this.disarmKeepAlive();
          handlers?.onEnd?.(err);
          return;
        }
        this.index++;
        handlers?.onProgress?.(this.offsets[Math.min(this.index, this.offsets.length - 1)] ?? this.total, this.total);
        // natural breathing gap before the next chunk (0 after the last one)
        const pauseMs = this.index >= this.chunks.length ? 0 : this.chunkPauses[this.index - 1] ?? 0;
        if (pauseMs > 0) {
          this.gapTimer = window.setTimeout(() => {
            this.gapTimer = null;
            if (this.stopped) return;
            if (this.paused) {
              // user paused during the breathing gap — retry shortly
              this.gapTimer = window.setTimeout(() => {
                this.gapTimer = null;
                if (!this.stopped) this.speakNext(opts, handlers);
              }, 120);
              return;
            }
            this.speakNext(opts, handlers);
          }, pauseMs);
        } else {
          this.speakNext(opts, handlers);
        }
      },
    });
  }

  /**
   * Chrome (and some Chromium builds) silently stall long synthesis runs.
   * While the queue is actively speaking, periodically nudge the engine —
   * a no-op unless the engine actually stalled.
   */
  private armKeepAlive(): void {
    if (this.keepAlive != null || !isSpeechSynthesisAvailable()) return;
    this.keepAlive = window.setInterval(() => {
      try {
        if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch { /* noop */ }
    }, 10000);
  }

  private disarmKeepAlive(): void {
    if (this.keepAlive != null) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  pause(): void {
    this.paused = true;
    this.speaker.pause();
  }

  resume(): void {
    this.paused = false;
    this.speaker.resume();
  }

  stop(): void {
    this.stopped = true;
    if (this.gapTimer != null) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
    this.disarmKeepAlive();
    this.speaker.cancel();
    this.index = 0;
    this.paused = false;
  }
}
