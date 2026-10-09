// Smoke test for the OS-bridge additions — pure logic only (no DOM).
import { readFileSync } from 'node:fs';
import { parseWav } from '@/lib/engines/os-tts-bridge';
import { pickOsVoiceForProfile, voiceClassForModel } from '@/lib/engines/dispatch';
import { TTS_MODELS } from '@/lib/data/tts-models';
import { scoreVoiceForClass } from '@/lib/engines/speech';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}`); }
}

// 1. WAV parser vs a real espeak-ng render produced by the bridge server
try {
  const wav = readFileSync('/tmp/out.wav');
  const info = parseWav(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
  check(`parseWav sampleRate 22050 (got ${info.sampleRate})`, info.sampleRate === 22050);
  check(`parseWav mono (got ${info.channels})`, info.channels === 1);
  check(`parseWav ~2.7s of samples (got ${info.float32[0].length})`, Math.abs(info.float32[0].length / 22050 - 2.71) < 0.2);
  let peak = 0;
  for (const v of info.float32[0]) peak = Math.max(peak, Math.abs(v));
  check(`parseWav audible peak ${peak.toFixed(3)}`, peak > 0.05 && peak <= 1);
} catch (e) {
  // file only exists when the server smoke test ran on this machine
  console.log(`skip - wav file not available: ${e instanceof Error ? e.message : e}`);
}

// 2. voice-class semantics: classic models must rank classic voices above neural ones
const fakeVoice = (name: string, localService: boolean, voiceURI = name, lang = 'en-US') =>
  ({ name, localService, voiceURI, lang, default: false }) as unknown as SpeechSynthesisVoice;
const voices = [
  fakeVoice('Microsoft Aria Online (Natural) - English (US)', false),
  fakeVoice('Microsoft Zira Desktop - English (US)', true),
  fakeVoice('Microsoft David Desktop - English (US)', true),
];
const neural = [...voices].sort((a, b) => scoreVoiceForClass(b, 'en', 'neural') - scoreVoiceForClass(a, 'en', 'neural'));
const classic = [...voices].sort((a, b) => scoreVoiceForClass(b, 'en', 'classic') - scoreVoiceForClass(a, 'en', 'classic'));
check('neural class ranks the Natural voice first', /Natural/.test(neural[0].name));
check('classic class ranks a Desktop (local) voice first', /Desktop/.test(classic[0].name));
check('classic class ranks the Online Natural voice LAST', /Natural/.test(classic[classic.length - 1].name));

// 3. model → voice class mapping
const classicModel = TTS_MODELS.find((m) => m.id === 'system-classic');
const neuralModel = TTS_MODELS.find((m) => m.id === 'system-neural-auto');
const bridgeModel = TTS_MODELS.find((m) => m.id === 'os-native-speech');
check('system-classic → classic', voiceClassForModel(classicModel) === 'classic');
check('system-neural-auto → neural', voiceClassForModel(neuralModel) === 'neural');
check('os-native-speech exists and is os-bridge', bridgeModel?.engine === 'os-bridge');

// 4. deterministic, distinct OS voice mapping per profile
const osVoices = [
  { id: 'sapi:Zira', engine: 'sapi' as const, name: 'Zira', lang: 'en-US', gender: 'female' as const, quality: 3 },
  { id: 'sapi:David', engine: 'sapi' as const, name: 'David', lang: 'en-US', gender: 'male' as const, quality: 3 },
  { id: 'say:Samantha', engine: 'say' as const, name: 'Samantha', lang: 'en-US', gender: 'female' as const, quality: 3 },
  { id: 'piper:lessac', engine: 'piper' as const, name: 'lessac', lang: 'en-US', quality: 5, neural: true },
];
const v1 = pickOsVoiceForProfile(osVoices, 'aura-neutral', 'neutral', 'en');
const v2 = pickOsVoiceForProfile(osVoices, 'aura-warm', 'male', 'en');
const v3 = pickOsVoiceForProfile(osVoices, 'aura-warm', 'male', 'en');
const v4 = pickOsVoiceForProfile(osVoices, 'aura-bright', 'female', 'en');
check('profile mapping is deterministic (aura-warm)', v2.id === v3.id);
check('male profile maps to a male voice', v2.gender === 'male');
check('female profile maps to a female voice', v4.gender === 'female');
check('auto-pick prefers the best-ranked (piper neural) voice for neutral', v1?.engine === 'piper');

// 5. default catalog: OS bridge model ships first (new default selection)
check('default model is the OS Speech Engine', TTS_MODELS[0].id === 'os-native-speech');

// 6. honest catalog: no simulated/fake engine packs are selectable
const RETIRED = ['aura-formant-core', 'aura-formant-studio', 'vox-mecha-lite', 'storybook-pack', 'whisper-kit', 'deep-ctx-pro', 'emotive-x'];
check('retired formant packs are gone from the catalog', RETIRED.every((id) => !TTS_MODELS.some((m) => m.id === id)));
check('every catalog entry routes to a real OS-level runtime', TTS_MODELS.every((m) => m.engine !== 'formant'));
check('selectors (polyglot/clarity) use the established system-neural runtime',
  ['polyglot-latin', 'clarity-broadcast'].every((id) => TTS_MODELS.find((m) => m.id === id)?.engine === 'system-neural'));

console.log(`\n${pass} checks passed, ${fail} failed`);
if (fail > 0) process.exit(1);
