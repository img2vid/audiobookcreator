// ============================================================
// Engine dispatch — ONE entry point that routes synthesis to the engine the
// user actually selected, instead of silently re-rendering everything with
// the bundled formant engine.
//
// Selection semantics (previously broken):
//   • “OS Neural Voices / OS Classic Voices” previews used the Web Speech
//     API but every FILE RENDER went through the built-in formant engine.
//   • system-neural and system-classic behaved identically — the engine
//     class never reached the voice picker.
//
// Now:
//   • formant models                → bundled AuraVoice formant engine.
//   • os-bridge models              → established OS speech engines
//                                     (Windows SAPI 5, macOS `say`,
//                                     Linux espeak-ng, Piper neural) via the
//                                     local bridge server — real files,
//                                     real OS voices.
//   • system-neural/system-classic  → OS bridge when running (the selected
//                                     voice class is honored: neural vs
//                                     classic); otherwise formant fallback
//                                     with an explicit reason.
// ============================================================
import type {
  OsTtsEngineId,
  OsTtsVoiceDef,
  SystemVoiceClass,
  TTSModelDef,
  TtsRenderResult,
} from '@/lib/types';
import { allVoiceProfiles, hashString } from '@/lib/engines/formant';
import { OS_ENGINE_CAPS, probeOsTtsBridge, synthesizeViaBridge } from '@/lib/engines/os-tts-bridge';
import { prepareTextForNeuralSpeech, splitIntoChunks } from '@/lib/engines/speech';
import { parseVoiceMarkup } from '@/lib/engines/markup';

/** Engine priority when auto-picking a bridge voice (realism first). */
const ENGINE_PRIORITY: Record<OsTtsEngineId, number> = {
  balabolka: 40, piper: 50, winrt: 0, sapi: 0, say: 0, 'espeak-ng': 0, espeak: 0, 

};

export function voiceClassForModel(model: TTSModelDef | undefined): SystemVoiceClass {
  if (!model) return 'any';
  if (model.engine === 'system-neural') return 'neural';
  if (model.engine === 'system-classic') return 'classic';
  return 'any';
}

function rankOsVoice(v: OsTtsVoiceDef): number {
  return (v.quality ?? 3) * 10 + (ENGINE_PRIORITY[v.engine] ?? 10) + (v.neural ? 25 : 0);
}

function sortOsVoices(voices: OsTtsVoiceDef[], langPrefix?: string): OsTtsVoiceDef[] {
  const want = langPrefix?.split(/[-_]/)[0].toLowerCase();
  return [...voices].sort((a, b) => {
    const la = want && a.lang.toLowerCase().startsWith(want) ? 1 : 0;
    const lb = want && b.lang.toLowerCase().startsWith(want) ? 1 : 0;
    if (la !== lb) return lb - la;
    return rankOsVoice(b) - rankOsVoice(a);
  });
}

/**
 * Deterministically map a formant voice profile onto an OS bridge voice, so
 * multi-voice audiobooks keep DISTINCT per-character voices even when the
 * render runs on OS engines. Same profile id → same OS voice; different
 * profiles cycle through the (gender-matched) candidates.
 */
export function pickOsVoiceForProfile(
  voices: OsTtsVoiceDef[],
  profileId: string,
  gender?: 'male' | 'female' | 'neutral',
  langPrefix?: string,
): OsTtsVoiceDef | undefined {
  if (!voices.length) return undefined;
  const sorted = sortOsVoices(voices, langPrefix);
  const language = langPrefix?.split(/[-_]/)[0].toLowerCase();
  const matching = language ? sorted.filter(v => v.lang.toLowerCase().split(/[-_]/)[0] === language) : [];
  const ranked = matching.length ? matching : sorted;
  const withGender = ranked.filter((v) => v.gender);
  const pool = gender && gender !== 'neutral' && withGender.length
    ? ranked.filter((v) => v.gender === gender)
    : ranked;
  const candidates = pool.length ? pool : ranked;
  // stable per-profile index → deterministic, distinct voice assignments
  const idx = candidates.length === 1 ? 0 : hashString(profileId || 'default') % candidates.length;
  return candidates[idx];
}

// ---------- OS render planning (markup-aware chunking) ----------

interface OsSegment {
  text: string;
  rate: number;
  pitch: number;
  volume: number;
  /** Exact silence appended AFTER this segment (from [pause]/[break] tags). */
  pauseAfterMs: number;
  /** Whisper spans are delivered quieter — OS engines have no whisper mode. */
  whisper: boolean;
}

function planOsSegments(text: string, base: { rate: number; pitch: number; volume: number }): OsSegment[] {
  const parsed = parseVoiceMarkup(text, base);
  if (!parsed.hasMarkup) {
    return [{ text, rate: base.rate, pitch: base.pitch, volume: base.volume, pauseAfterMs: 0, whisper: false }];
  }
  const out: OsSegment[] = [];
  for (const seg of parsed.segments) {
    const clean = seg.text.trim();
    if (clean) {
      // whisper spans already arrive with reduced volume from the markup parser
      out.push({
        text: clean,
        rate: seg.rate,
        pitch: seg.pitch,
        volume: seg.volume,
        pauseAfterMs: seg.pauseAfterMs,
        whisper: seg.style === 'whisper',
      });
    } else if (seg.pauseAfterMs > 0 && out.length) {
      out[out.length - 1].pauseAfterMs += seg.pauseAfterMs;
    }
  }
  return out;
}

/** Apply gain in place (used to honor volume on engines without volume control). */
function applyGainInPlace(buffer: AudioBuffer, mult: number): void {
  if (Math.abs(mult - 1) < 0.01) return;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= mult;
  }
}

function silenceBuffer(seconds: number, sampleRate: number, channels = 1): AudioBuffer {
  const len = Math.max(1, Math.round(seconds * sampleRate));
  const ctx = new OfflineAudioContext(channels, len, sampleRate);
  return ctx.createBuffer(channels, len, sampleRate);
}

function concatSameRate(buffers: AudioBuffer[], sampleRate: number, channels: number): AudioBuffer {
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const ctx = new OfflineAudioContext(channels, Math.max(1, total), sampleRate);
  const out = ctx.createBuffer(channels, Math.max(1, total), sampleRate);
  let offset = 0;
  for (const b of buffers) {
    for (let c = 0; c < channels; c++) {
      const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
      out.getChannelData(c).set(src, offset);
    }
    offset += b.length;
  }
  return out;
}

// ---------- the dispatcher ----------

export interface DispatchOptions {
  signal?: AbortSignal;
  lang?: string;
  /** Selected TTS model — decides which engine family renders. */
  model: TTSModelDef;
  /** Bundled formant profile (used directly by formant; maps to an OS voice otherwise). */
  profileId: string;
  /** Explicit bridge voice id (e.g. "sapi:Microsoft Zira Desktop"). Empty → auto-map. */
  osVoiceId?: string;
  /** Explicit Web Speech voiceURI (preview paths). */
  voiceURI?: string;
  rate: number;
  pitch: number;
  volume: number;
  quality: 'fast' | 'balanced' | 'high' | 'max';
  /** Legacy setting; ignored because non-Piper synthesis must use Balabolka CMD. */
  forceFallback?: boolean;
  /** Legacy setting; the dispatcher always reports a bridge error instead of using formant. */
  fallbackOnBridgeUnavailable?: boolean;
  onProgress?: (p: number) => void;
}

export class OsBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsBridgeUnavailableError';
  }
}

/**
 * Route a synthesis request to the SELECTED engine and return the rendered
 * buffer plus an honest report of what actually rendered.
 */
export async function synthesizeWithSelectedEngine(
  text: string,
  opts: DispatchOptions,
): Promise<TtsRenderResult> {
  opts.signal?.throwIfAborted();
  const requestedEngine: OsTtsEngineId = (
    opts.model.id === 'os-piper-neural' ||
    opts.osVoiceId?.startsWith('piper:') ||
    opts.voiceURI?.startsWith('piper:')
  ) ? 'piper' : 'balabolka';
  // All synthesis, including former formant/"fallback" modes, now goes
  // through the same local bridge. Never silently return the robotic voice.
  const probe = await probeOsTtsBridge();
  if (!probe.status.ok) {
    throw new OsBridgeUnavailableError(
      `Local Balabolka/Piper bridge is not available at ${probe.status.url}. Start it with npm run os-tts.`,
    );
  }
  const availableVoices = probe.voices.filter(v => v.engine === requestedEngine);
  if (!availableVoices.length) {
    throw new OsBridgeUnavailableError(
      requestedEngine === 'piper'
        ? 'No Piper voice model available. Install Piper and its .onnx voice models.'
        : 'No Balabolka voices available. Install balcon.exe on Windows and configure BALABOLKA_CMD; select Piper on other operating systems.',
    );
  }
  return renderViaOsBridge(text, opts, availableVoices);

}

async function renderViaOsBridge(
  text: string,
  opts: DispatchOptions,
  bridgeVoices: OsTtsVoiceDef[],
): Promise<TtsRenderResult> {
  // 1. resolve the OS voice — explicit pick wins, else map the profile
  let voice: OsTtsVoiceDef | undefined;
  if (opts.osVoiceId) {
    voice = bridgeVoices.find((v) => v.id === opts.osVoiceId);
    // Older projects often stored sapi:/winrt: voice ids. Keep the same
    // installed SAPI voice name, but render it with Balabolka instead.
    if (!voice && !opts.osVoiceId.startsWith('piper:')) {
      const wantedName = opts.osVoiceId.replace(/^[^:]+:/, '');
      voice = bridgeVoices.find((v) => v.name.toLowerCase() === wantedName.toLowerCase());
    }
    if (opts.osVoiceId.startsWith('piper:') && !voice)
      throw new Error('The selected Piper voice is no longer installed.');
  }
  if (!voice && opts.voiceURI) voice = bridgeVoices.find((v) => v.id === opts.voiceURI);
  const voiceClass = voiceClassForModel(opts.model);
  const filtered = bridgeVoices.filter(v => voiceClass === 'any' || (voiceClass === 'neural' ? v.neural : !v.neural));
  const candidates = filtered.length ? filtered : bridgeVoices;
  if (!voice) {
    const profile = allVoiceProfiles().find((p) => p.id === opts.profileId);
    voice = pickOsVoiceForProfile(candidates, opts.profileId, profile?.gender, opts.lang ?? 'en');
  }
  if (!voice) voice = sortOsVoices(bridgeVoices)[0];
  if (!voice) throw new Error('No OS voices available');

  const engine = voice.engine as OsTtsEngineId;
  // Unknown engine ids must NEVER crash a render (a NEW bridge can list
  // engines an OLDER deployed app bundle does not know): treat them as fully
  // capable — rate/pitch/volume are also honored server-side per engine.
  const caps = OS_ENGINE_CAPS[engine] ?? { label: engine, rate: true, pitch: true, volume: true };

  // 2. plan segments (voice markup) → chunks per segment
  const base = { rate: opts.rate, pitch: opts.pitch, volume: opts.volume };
  const segments = planOsSegments(text, base);
  interface Chunk extends OsSegment { chunk: string }
  const chunks: Chunk[] = [];
  for (const seg of segments) {
    const clean = prepareTextForNeuralSpeech(seg.text);
    if (!clean) {
      if (seg.pauseAfterMs > 0 && chunks.length) chunks[chunks.length - 1].pauseAfterMs += seg.pauseAfterMs;
      continue;
    }
    const pieces = splitIntoChunks(clean, 900);
    pieces.forEach((c, i) => {
      chunks.push({
        ...seg,
        chunk: c,
        pauseAfterMs: i === pieces.length - 1 ? seg.pauseAfterMs : 0,
      });
    });
  }
  if (!chunks.length) {
    const buf = silenceBuffer(0.25, 22050);
    return { buffer: buf, engineUsed: 'os-bridge', engineLabel: caps.label, chars: text.length, durationSec: buf.duration };
  }

  // 3. render every chunk through the actual OS engine
  const buffers: AudioBuffer[] = [];
  let sampleRate = 0;
  let channels = 1;
  let i = 0;
  for (const c of chunks) {
    opts.signal?.throwIfAborted();
    const res = await synthesizeViaBridge({
      engine,
      voice: voice!.name,
      modelPath: voice!.modelPath,
      text: c.chunk,
      rate: caps.rate ? c.rate : undefined,
      pitch: caps.pitch ? c.pitch : undefined,
      volume: caps.volume ? c.volume : undefined,
    }, 120_000, opts.signal);
    // engines without volume control get the gain applied here
    if (!caps.volume) applyGainInPlace(res.buffer, c.volume);
    buffers.push(res.buffer);
    sampleRate = sampleRate || res.buffer.sampleRate;
    channels = Math.max(channels, res.buffer.numberOfChannels);
    if (c.pauseAfterMs > 0) {
      buffers.push(silenceBuffer(c.pauseAfterMs / 1000, sampleRate, channels));
    } else if (i < chunks.length - 1) {
      // sentence-aligned breathing gap between chunks (mirrors SpeechQueue)
      buffers.push(silenceBuffer(0.18, sampleRate, channels));
    }
    i++;
    opts.onProgress?.(i / chunks.length);
  }

  const joined = buffers.length === 1 ? buffers[0] : concatSameRate(buffers, sampleRate, channels);
  const label = `${caps.label} · ${voice.name}`;
  return { buffer: joined, engineUsed: 'os-bridge', engineLabel: label, chars: text.length, durationSec: joined.duration };
}
