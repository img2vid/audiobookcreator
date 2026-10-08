import { readFileSync } from 'node:fs';
import { buildAudiobookScript } from '@/lib/engines/autobook';

const text = readFileSync('/tmp/pnp.txt', 'utf-8');
const profiles = [
  { id: 'aura-neutral', name: 'Aura Neutral', gender: 'neutral', basePitchHz: 165, timbre: 1, breath: 0.18, lang: 'en', description: 'x' },
  { id: 'aura-deep', name: 'Aura Deep', gender: 'male', basePitchHz: 108, timbre: 0.94, breath: 0.12, lang: 'en', description: 'x' },
  { id: 'aura-warm', name: 'Aura Warm', gender: 'male', basePitchHz: 124, timbre: 0.97, breath: 0.22, lang: 'en', description: 'x' },
  { id: 'aura-bright', name: 'Aura Bright', gender: 'female', basePitchHz: 214, timbre: 1.1, breath: 0.2, lang: 'en', description: 'x' },
  { id: 'atlas-narrator', name: 'Atlas Narrator', gender: 'male', basePitchHz: 116, timbre: 0.96, breath: 0.15, lang: 'en', description: 'x' },
  { id: 'nova-narrator', name: 'Nova Narrator', gender: 'female', basePitchHz: 196, timbre: 1.08, breath: 0.16, lang: 'en', description: 'x' },
  { id: 'storyteller', name: 'Storyteller', gender: 'male', basePitchHz: 132, timbre: 0.99, breath: 0.2, lang: 'en', description: 'x' },
  { id: 'junior', name: 'Junior', gender: 'neutral', basePitchHz: 250, timbre: 1.18, breath: 0.24, lang: 'en', description: 'x' },
  { id: 'grandpa', name: 'Grandpa', gender: 'male', basePitchHz: 96, timbre: 0.9, breath: 0.35, lang: 'en', description: 'x' },
] as never;

const t0 = Date.now();
const result = buildAudiobookScript(text, profiles, { genre: 'force-fiction' });
const ms = Date.now() - t0;
console.log(`Pride & Prejudice — ${(text.length / 1024).toFixed(0)} KB in ${ms} ms`);
console.log('genre:', result.verdict.kind, `(${(result.verdict.confidence * 100).toFixed(0)}%)`);
console.log('chapters:', result.chapters.length, '· units:', result.units.length, '· words:', result.stats.words);
const dlg = result.units.filter((u) => u.kind === 'dialogue');
const narr = dlg.filter((u) => u.speaker === 'Narrator').length;
console.log('dialogue units:', dlg.length, `· Narrator-held: ${narr} (${(narr / dlg.length * 100).toFixed(1)}%)`);
console.log('speaking characters:', result.stats.speakers, '· cast voiced:', result.cast.length - 1);
const cast = result.cast.slice(1, 14).map((c) => `${c.name}(${c.profileId})`);
console.log('top cast:', cast.join(', '));
// attribution quality spot-check against known ground truth
const expect = ['Elizabeth', 'Darcy', 'Mr. Bennet', 'Mrs. Bennet', 'Jane', 'Mr. Collins', 'Wickham', 'Lydia', 'Mr. Bingley', 'Charlotte'];
const speakers = new Set(result.units.filter((u) => u.kind === 'dialogue').map((u) => u.speaker));
const hit = expect.filter((n) => speakers.has(n));
console.log('ground-truth speakers found:', hit.length + '/' + expect.length, '→', hit.join(', '));
const missing = expect.filter((n) => !speakers.has(n));
if (missing.length) console.log('missing:', missing.join(', '));
