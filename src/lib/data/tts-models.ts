import type { TTSModelDef } from '@/lib/types';

/**
 * Local TTS model catalog.
 *  - All non-Piper models render through Balabolka CMD (balcon.exe) via the
 *    local bridge. Piper is used only when explicitly selected.
 *  - Legacy system-neural/system-classic presets select Balabolka voices.
 *    Previews and file exports use the same command-line backend.
 *
 * The former "AuraVoice Formant Core/Studio", "VoxMecha", "Storybook Voice
 * Pack", "WhisperKit Profiles", "DeepContext Pro" and "EmotiveX" catalog
 * entries were retired: they were all presets of the built-in parametric
 * formant synthesizer (and the two "Pro" packs were simulated), not real
 * speech engines. The formant profiles remain as persona definitions, but
 * their built-in synthesizer is not used when Balabolka or Piper is absent.
 * Everything runs locally.
 */
export const TTS_MODELS: TTSModelDef[] = [
  {
    id: 'os-native-speech',
    name: 'Balabolka CMD (Windows)',
    family: 'OS Bridge',
    lang: 'multi',
    sizeMB: 0,
    quality: 5,
    engine: 'os-bridge',
    bundled: true,
    description: 'Uses Balabolka CMD (balcon.exe) and installed Windows SAPI voices for all non-Piper speech. Previews and exports use the same local engine.',
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
    description: 'Legacy profile: prefers natural-sounding voices available to Balabolka CMD; both preview and export use balcon.exe.',
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
    description: 'Classic Windows SAPI voices via Balabolka CMD. No GPU required.',
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
