// Stub — replaced & expanded by Task 1-a (audio engines agent).
// Real Web Speech API wrapper (works out of the box).
import type { SpeakerHandlers, SpeakOptions } from '@/lib/types';

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

export function splitIntoChunks(text: string, maxChars: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const sentences = clean.match(/[^.!?\n]+[.!?]*/g) ?? [clean];
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > maxChars && cur) {
      chunks.push(cur.trim());
      cur = '';
    }
    if (s.length > maxChars) {
      // hard-split very long sentence at word boundaries
      let rest = s;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars);
        if (cut < maxChars * 0.5) cut = maxChars;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
      cur = rest;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
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
    if (opts.voiceURI) {
      const voices = window.speechSynthesis.getVoices();
      const v = voices.find((x) => x.voiceURI === opts.voiceURI);
      if (v) u.voice = v;
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
    const neural = voices.filter((v) => /neural|natural|premium|enhanced|siri/i.test(v.name));
    return neural.length ? neural : voices.filter((v) => v.localService);
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

/**
 * Speaks arbitrarily long text by chunking (browsers truncate long utterances).
 * Boundary callbacks report absolute indices into the ORIGINAL text.
 */
export class SpeechQueue {
  private speaker = new SpeechSpeaker();
  private chunks: string[] = [];
  private offsets: number[] = [];
  private index = 0;
  private paused = false;
  private stopped = false;
  private total = 0;

  constructor(private maxChars = 180) {}

  get isActive(): boolean {
    return this.index > 0 || this.speaker.state !== 'idle';
  }
  get isPaused(): boolean {
    return this.paused;
  }

  start(text: string, opts: SpeakOptions, handlers?: SpeechQueueHandlers): void {
    this.stop();
    const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    this.chunks = splitIntoChunks(clean, this.maxChars);
    // compute absolute offsets of each chunk in the original text
    this.offsets = [];
    let searchFrom = 0;
    for (const c of this.chunks) {
      const idx = clean.indexOf(c, searchFrom);
      this.offsets.push(idx >= 0 ? idx : searchFrom);
      searchFrom = (idx >= 0 ? idx : searchFrom) + c.length;
    }
    this.total = clean.length;
    this.index = 0;
    this.paused = false;
    this.stopped = false;
    handlers?.onStart?.();
    this.speakNext(opts, handlers);
  }

  private speakNext(opts: SpeakOptions, handlers?: SpeechQueueHandlers): void {
    if (this.stopped) return;
    if (this.index >= this.chunks.length) {
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
          handlers?.onEnd?.(err);
          return;
        }
        this.index++;
        handlers?.onProgress?.(this.offsets[Math.min(this.index, this.offsets.length - 1)] ?? this.total, this.total);
        this.speakNext(opts, handlers);
      },
    });
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
    this.speaker.cancel();
    this.index = 0;
    this.paused = false;
  }
}
