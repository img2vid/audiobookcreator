import type { TTSModelDef } from '@/lib/types';

/**
 * Local TTS model catalog.
 *  - "os-bridge" models route renders to the ESTABLISHED speech engine that
 *    ships with your OS (Windows SAPI 5, macOS Apple Speech, Linux espeak-ng)
 *    or to Piper neural voices — via the local bridge server (`npm run os-tts`).
 *  - "system-neural" / "system-classic" models map onto the browser's Web
 *    Speech voices (which wrap the same OS runtimes) for live preview, and to
 *    the bridge for file renders when it is running.
 *
 * The former "AuraVoice Formant Core/Studio", "VoxMecha", "Storybook Voice
 * Pack", "WhisperKit Profiles", "DeepContext Pro" and "EmotiveX" catalog
 * entries were retired: they were all presets of the built-in parametric
 * formant synthesizer (and the two "Pro" packs were simulated), not real
 * speech engines. The formant synth remains ONLY as an emergency fallback
 * when no OS engine is reachable, and as the persona definition format that
 * maps onto real OS voices.
 * Everything runs locally.
 */
export const TTS_MODELS: TTSModelDef[] = [
  {
    id: 'os-native-speech',
    name: 'OS Speech Engine (native)',
    family: 'OS Bridge',
    lang: 'multi',
    sizeMB: 0,
    quality: 5,
    engine: 'os-bridge',
    bundled: true,
    description: 'Renders through the established speech engine installed with your OS — Windows SAPI 5, macOS Apple Speech (say) or Linux espeak-ng — via the local bridge server (npm run os-tts). Real OS voices in previews AND file exports.',
    tags: ['bundled', 'os-level', 'renders-to-file', 'multi-language'],
    gpuRecommended: false,
  },
  {
    id: 'os-piper-neural',
    name: 'Piper Neural (OS Bridge)',
    family: 'OS Bridge',
    lang: 'multi',
    sizeMB: 0,
    quality: 5,
    engine: 'os-bridge',
    bundled: true,
    description: 'Realistic neural-network voices via the Piper engine on your machine (set PIPER_VOICES_DIR when starting the bridge). The most lifelike fully-local option when Piper is installed.',
    tags: ['bundled', 'os-level', 'neural', 'renders-to-file'],
    gpuRecommended: false,
  },
  {
    id: 'system-neural-auto',
    name: 'OS Neural Voices (Auto-detect)',
    family: 'System Runtime',
    lang: 'multi',
    sizeMB: 0,
    quality: 5,
    engine: 'system-neural',
    bundled: true,
    description: 'Automatically uses the highest-quality neural voices installed on this machine (Edge/Windows Natural, macOS Siri voices, etc.). Previews speak in-browser; file renders go through the OS bridge when it is running.',
    tags: ['bundled', 'best-quality', 'multi-language'],
    gpuRecommended: false,
  },
  {
    id: 'system-classic',
    name: 'OS Classic Voices',
    family: 'System Runtime',
    lang: 'multi',
    sizeMB: 0,
    quality: 2,
    engine: 'system-classic',
    bundled: true,
    description: 'Classic SAPI-style system voices (Microsoft David/Zira, Apple Fred…). Selection is honored: classic local voices are picked instead of neural ones. Very low latency, extremely stable for batch jobs.',
    tags: ['bundled', 'low-latency', 'classic'],
    gpuRecommended: false,
  },
  {
    id: 'polyglot-latin',
    name: 'Polyglot Latin Pack',
    family: 'System Runtime',
    lang: 'multi',
    sizeMB: 0,
    quality: 4,
    engine: 'system-neural',
    bundled: true,
    description: 'Not a separate engine — routes the OS neural voices you already have to Latin-script languages (es, fr, de, pt, it…). Same established runtime as OS Neural Voices.',
    tags: ['bundled', 'multi-language'],
    gpuRecommended: false,
  },
  {
    id: 'clarity-broadcast',
    name: 'Clarity Broadcast',
    family: 'System Runtime',
    lang: 'en',
    sizeMB: 0,
    quality: 4,
    engine: 'system-neural',
    bundled: true,
    description: 'Not a separate engine — prefers crisp news-anchor style neural voices among the ones installed on this machine. Same established runtime as OS Neural Voices.',
    tags: ['bundled', 'news'],
    gpuRecommended: false,
  },
  {
    id: 'legacy-sapi',
    name: 'Legacy SAPI Bridge',
    family: 'System Runtime',
    lang: 'multi',
    sizeMB: 0,
    quality: 1,
    engine: 'system-classic',
    bundled: true,
    description: 'Maximum-compatibility mode using the very first classic voice the OS exposes. Not a separate engine — the most conservative pick from your installed OS voices.',
    tags: ['bundled', 'fallback'],
    gpuRecommended: false,
  },
];

export function getModel(id: string): TTSModelDef | undefined {
  return TTS_MODELS.find((m) => m.id === id);
}
