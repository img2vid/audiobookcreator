// ============================================================
// Openmukti Audiobook Creator — shared speaker color identity
// One deterministic mapping so a speaker renders identically in
// every module (Transcribe segments, Video cue chips, etc.).
// Palette: 8 theme-safe tones, NO blue/indigo (project rule).
// ============================================================

export const SPEAKER_CHIP_CLASSES = [
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  'bg-lime-500/15 text-lime-700 dark:text-lime-300',
  'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
] as const;

/** Stable 31-polynomial hash — same name ⇒ same hue, forever. */
export function hashSpeakerName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Tailwind chip classes for a speaker name (empty/whitespace name ⇒ zinc neutral). */
export function speakerChipClass(name: string): string {
  if (!name || !name.trim()) return 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300';
  return SPEAKER_CHIP_CLASSES[hashSpeakerName(name) % SPEAKER_CHIP_CLASSES.length];
}
