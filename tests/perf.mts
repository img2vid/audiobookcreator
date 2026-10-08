import { discoverCharacterNames, attributeDialogue, buildAudiobookScript } from '@/lib/engines/autobook';
// build a ~1MB synthetic novel with 40 characters
const names = Array.from({length: 40}, (_, i) => `Charname${i < 10 ? '0' + i : i}`);
const paras: string[] = ['Chapter One', ''];
for (let i = 0; i < names.length; i++) {
  const a = names[i], b = names[(i + 1) % names.length];
  paras.push(`${a} turned at the gate. "Are you coming, ${b}?" ${a} asked, "or must I wait?"`);
  paras.push(`${b} laughed. "I am coming," said ${b}. "You forget who taught you patience, ${a}."`);
  paras.push('"She thought about the sea," she thought. "Endless and green."');
}
for (let i = 0; i < 800; i++) {
  const a = names[i % names.length];
  paras.push(`${a} walked along the shore where the waves broke softly against the grey rocks and the gulls cried overhead in the pale morning light while the wind carried the smell of salt and rain.`);
}
const text = paras.join('\n\n');
console.log('book size:', (text.length / 1024).toFixed(0), 'KB');
let t = Date.now();
const namesFound = discoverCharacterNames(text);
console.log('discovery:', Date.now() - t, 'ms ·', namesFound.length, 'names');
t = Date.now();
const units = attributeDialogue(text, namesFound);
console.log('attribution:', Date.now() - t, 'ms ·', units.filter(u => u.kind === 'dialogue').length, 'dialogue units');
const dlg = units.filter(u => u.kind === 'dialogue');
const attributed = dlg.filter(u => u.speaker !== 'Narrator').length;
console.log('attributed to characters:', attributed, '/', dlg.length, `(${(attributed / dlg.length * 100).toFixed(1)}%)`);
t = Date.now();
const profiles = [{ id: 'aura-neutral', name: 'Aura Neutral', gender: 'neutral', basePitchHz: 165, timbre: 1, breath: 0.18, lang: 'en', description: 'x' }] as never;
const result = buildAudiobookScript(text, [
  { id: 'aura-neutral', name: 'Aura Neutral', gender: 'neutral', basePitchHz: 165, timbre: 1, breath: 0.18, lang: 'en', description: 'x' },
  { id: 'aura-deep', name: 'Aura Deep', gender: 'male', basePitchHz: 108, timbre: 0.94, breath: 0.12, lang: 'en', description: 'x' },
  { id: 'aura-bright', name: 'Aura Bright', gender: 'female', basePitchHz: 214, timbre: 1.1, breath: 0.2, lang: 'en', description: 'x' },
], { genre: 'force-fiction' });
console.log('full pipeline:', Date.now() - t, 'ms · cast:', result.cast.length, '· speakers:', result.stats.speakers);
const voiceKeys = new Set(result.cast.map(c => `${c.profileId}:${c.pitch}:${c.rate}`));
console.log('distinct voice params:', voiceKeys.size, '/', result.cast.length);
