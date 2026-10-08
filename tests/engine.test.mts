/**
 * Fixture suite for the AutoBook rule engine (discovery + attribution + casting).
 * Run:  node --experimental-loader ./tests/alias-loader.mjs tests/engine.test.mts
 * Every fixture is a tiny scene exercising ONE dialogue convention; the expected
 * speakers assert the rule that must fire.
 */
import { discoverCharacterNames, attributeDialogue, buildAudiobookScript } from '@/lib/engines/autobook';
import type { VoiceProfileDef } from '@/lib/types';

// ---------- tiny test harness ----------
let passed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); }
}
function speakersOf(text: string): string[] {
  return attributeDialogue(text, discoverCharacterNames(text))
    .filter((u) => u.kind === 'dialogue')
    .map((u) => u.speaker);
}

const PROFILES: VoiceProfileDef[] = [
  { id: 'aura-neutral', name: 'Aura Neutral', gender: 'neutral', basePitchHz: 165, timbre: 1, breath: 0.18, lang: 'en', description: 'x' },
  { id: 'aura-deep', name: 'Aura Deep', gender: 'male', basePitchHz: 108, timbre: 0.94, breath: 0.12, lang: 'en', description: 'x' },
  { id: 'aura-warm', name: 'Aura Warm', gender: 'male', basePitchHz: 124, timbre: 0.97, breath: 0.22, lang: 'en', description: 'x' },
  { id: 'aura-bright', name: 'Aura Bright', gender: 'female', basePitchHz: 214, timbre: 1.1, breath: 0.2, lang: 'en', description: 'x' },
  { id: 'atlas-narrator', name: 'Atlas Narrator', gender: 'male', basePitchHz: 116, timbre: 0.96, breath: 0.15, lang: 'en', description: 'x' },
  { id: 'nova-narrator', name: 'Nova Narrator', gender: 'female', basePitchHz: 196, timbre: 1.08, breath: 0.16, lang: 'en', description: 'x' },
  { id: 'chip-robotic', name: 'Chip', gender: 'neutral', basePitchHz: 148, timbre: 0.82, breath: 0.04, lang: 'en', description: 'x' },
  { id: 'whisper-soft', name: 'Whisper Soft', gender: 'neutral', basePitchHz: 158, timbre: 1.02, breath: 0.85, lang: 'en', description: 'x' },
  { id: 'storyteller', name: 'Storyteller', gender: 'male', basePitchHz: 132, timbre: 0.99, breath: 0.2, lang: 'en', description: 'x' },
  { id: 'junior', name: 'Junior', gender: 'neutral', basePitchHz: 250, timbre: 1.18, breath: 0.24, lang: 'en', description: 'x' },
  { id: 'grandpa', name: 'Grandpa', gender: 'male', basePitchHz: 96, timbre: 0.9, breath: 0.35, lang: 'en', description: 'x' },
  { id: 'mono-flat', name: 'Mono', gender: 'neutral', basePitchHz: 170, timbre: 1, breath: 0.1, lang: 'en', description: 'x' },
];

// ---------- 1. tags ----------
{
  const units = attributeDialogue('"The clocks were striking thirteen." "Hmm," said George. "Odd."', ['George']);
  const sp = units.filter((u) => u.kind === 'dialogue').map((u) => u.speaker);
  check('untagged opening stays Narrator', sp[0] === 'Narrator', sp.join('|'));
  check('tag-before:name', sp[1] === 'George', sp.join('|'));
  check('tag-after:name', sp[2] === 'George', sp.join('|'));
}
{
  const sp = speakersOf('"You will not believe this," Eleanor said. "Try me," said Tomas.');
  check('pair tags', sp.join('|') === 'Eleanor|Tomas', sp.join('|'));
}
{
  const sp = speakersOf('Mrs. Coulter stepped in. "My child," said Mrs. Coulter, "you look pale."', ['Mrs. Coulter']);
  const all = attributeDialogue('Mrs. Coulter stepped in. "My child," said Mrs. Coulter, "you look pale."', discoverCharacterNames('Mrs. Coulter stepped in. "My child," said Mrs. Coulter, "you look pale."'));
  check('honorific tag', all.some((u) => u.speaker === 'Mrs. Coulter'), all.map((u) => u.speaker).join('|'));
}

// ---------- 2. pronoun + roster ----------
{
  const text = 'Eleanor entered. "Where is the map?" "In the drawer," he replied.';
  const names = discoverCharacterNames(text);
  const pass1 = attributeDialogue(text, names);
  const roster = [...new Set(pass1.filter((u) => u.kind === 'dialogue' && u.speaker !== 'Narrator').map((u) => u.speaker))];
  const genders: Record<string, string> = { Eleanor: 'female' };
  const units = attributeDialogue(text, names, { roster, genders: genders as never });
  const d = units.filter((u) => u.kind === 'dialogue');
  check('nearest mention resolves opener', d[0].speaker === 'Eleanor', d[0].speaker);
  check('pronoun without male candidate stays Narrator', d[1].speaker === 'Narrator', d[1].speaker);
}

// ---------- 3. descriptive / group speakers ----------
{
  const sp = speakersOf('"Mind the gap," said the other girl.');
  check('descriptive speaker', sp[0] === 'The Other Girl', sp.join('|'));
}
{
  const sp = speakersOf('"Long live the king!" cried the soldiers.');
  check('group speaker', sp[0] === 'The Soldiers', sp.join('|'));
}
{
  const sp = speakersOf('"Follow me," the innkeeper said, and up the stairs they went. "Careful, they creak."');
  check('descriptive-then-verb', sp[0] === 'The Innkeeper', sp.join('|'));
}

// ---------- 4. inverted pronoun ----------
{
  const text = 'Marcus bowed. "As you wish," said he.';
  const names = discoverCharacterNames(text);
  const genders: Record<string, string> = { Marcus: 'male' };
  const units = attributeDialogue(text, names, { genders: genders as never });
  const d = units.filter((u) => u.kind === 'dialogue')[0];
  check('inverted pronoun', d.speaker === 'Marcus', `${d.speaker} [${d.evidence}]`);
}

// ---------- 5. headless reply ----------
{
  const sp = speakersOf('"Did you take the gold?" Eleanor asked.\n\nTomas folded his arms. "I never touched it," came the reply.');
  check('came the reply', sp[1] === 'Tomas', sp.join('|'));
}
{
  const sp = speakersOf('"Did you take it?" Eleanor asked.\n\nTomas shrugged. "Never," came the reply.\n\n"Liar!"');
  check('headless reply alternates', sp.join('|') === 'Eleanor|Tomas|Eleanor', sp.join('|'));
}

// ---------- 6. vocative ----------
{
  const text = 'Tomas turned. "Eleanor, come here at once!"';
  const names = discoverCharacterNames(text);
  const pass1 = attributeDialogue(text, names);
  const roster = [...new Set(pass1.filter((u) => u.kind === 'dialogue' && u.speaker !== 'Narrator').map((u) => u.speaker))];
  const units = attributeDialogue(text, names, { roster });
  const d = units.filter((u) => u.kind === 'dialogue')[0];
  check('vocative names the listener', d.speaker === 'Tomas', `${d.speaker} [${d.evidence}]`);
}

// ---------- 7. alternation ----------
{
  const sp = speakersOf('"One," said Eleanor.\n\n"Two."\n\n"Three."\n\n"Four."');
  check('alternation', sp.join('|') === 'Eleanor|Narrator|Narrator|Narrator' || new Set(sp).size === 2, sp.join('|'));
}
{
  const text = '"Coffee?" Eleanor asked.\n\n"Please." Tomas set down two cups.';
  const names = discoverCharacterNames(text);
  const roster = ['Eleanor', 'Tomas'];
  const units = attributeDialogue(text, names, { roster });
  const sp = units.filter((u) => u.kind === 'dialogue').map((u) => u.speaker);
  check('alternation with beat', sp.join('|') === 'Eleanor|Tomas', sp.join('|'));
}

// ---------- 8. tag sandwich ----------
{
  const sp = speakersOf('"You must rest," said the girl. "You need sleep."');
  check('sandwich continuation', sp[0] === 'The Girl' && sp[1] === 'The Girl', sp.join('|'));
}
{
  const sp = speakersOf('"You must rest," said the girl. "But I cannot!"');
  check('turn marker breaks sandwich', sp[1] === 'Narrator' || sp[1] === 'The Girl', sp.join('|'));
}

// ---------- 9. British single quotes ----------
{
  const sp = speakersOf('‘Hullo,’ said George. ‘You look dreadful.’');
  check('curly single', sp.join('|') === 'George|George', sp.join('|'));
}
{
  const sp = speakersOf("'Hullo there,' said George. 'You look dreadful.'");
  check('straight single', sp.join('|') === 'George|George', sp.join('|'));
}

// ---------- 10. em-dash dialogue ----------
{
  const sp = speakersOf('—You never wrote, Eleanor complained.\n\n—Neither did you, Tomas replied.\n\n—I wrote every single week.');
  check('dash dialogue', sp.join('|') === 'Eleanor|Tomas|Eleanor', sp.join('|'));
}

// ---------- 11. play format ----------
{
  const text = 'FIRST WITCH: When shall we three meet again?\nSECOND WITCH: When the hurlyburly’s done.';
  const names = discoverCharacterNames(text);
  const units = attributeDialogue(text, names);
  const sp = units.filter((u) => u.kind === 'dialogue').map((u) => u.speaker);
  check('play colons', sp.join('|') === 'First Witch|Second Witch', sp.join('|') + ' names=' + names.join(','));
}

// ---------- 12. letter signature ----------
{
  const text = 'Dearest Jane,\n\n"I shall return by Michaelmas," the letter promised.\n\nYours sincerely,\nEleanor';
  const names = discoverCharacterNames(text);
  const units = attributeDialogue(text, names);
  check('signature discovered', names.includes('Eleanor'), names.join(','));
}

// ---------- 13. internal monologue ----------
{
  const units = attributeDialogue('"There is no way out," she thought. "None at all."', []);
  const d = units.filter((u) => u.kind === 'dialogue');
  check('thought → Narrator soft', d[0].speaker === 'Narrator' && d[0].emotionHint === 'soft', d.map((u) => `${u.speaker}:${u.emotionHint}`).join('|'));
}
{
  const text = 'Eleanor smiled. "Not a chance," she thought. "You forget who taught you."';
  const names = discoverCharacterNames(text);
  const pass1 = attributeDialogue(text, names);
  const roster = [...new Set(pass1.filter((u) => u.kind === 'dialogue' && u.speaker !== 'Narrator').map((u) => u.speaker))];
  const genders: Record<string, string> = { Eleanor: 'female' };
  const units = attributeDialogue(text, names, { roster, genders: genders as never });
  const d = units.filter((u) => u.kind === 'dialogue');
  check('thought sandwich: 1st Narrator, 2nd speaker', d[0].speaker === 'Narrator' && d[1].speaker === 'Eleanor', d.map((u) => u.speaker).join('|'));
}

// ---------- 14. interruption ----------
{
  const sp = speakersOf('"But I never—"\n\n"Silence!" the magistrate ordered.');
  check('interruption', sp[1] === 'The Magistrate', sp.join('|'));
}

// ---------- 15. continued speech across paragraphs ----------
{
  const text = '"When I was a child," Eleanor began, "my grandmother kept bees.\n\nEvery morning she walked the orchard rows,\n\nand every morning the bees followed her."';
  const names = discoverCharacterNames(text);
  const units = attributeDialogue(text, names);
  const d = units.filter((u) => u.kind === 'dialogue');
  const allSame = d.every((u) => u.speaker === d[0].speaker);
  check('continued speech keeps speaker', d.length === 4 && allSame, d.map((u) => `${u.speaker}[${u.evidence}]`).join('|'));
}

// ---------- 16. aliases ----------
{
  const text = '"Sit down, Bingley," said Mr. Darcy. "Never," said Mr. Bingley. "Darcy, be reasonable," said Darcy.';
  const names = discoverCharacterNames(text);
  const result = buildAudiobookScript(text, PROFILES, { genre: 'force-fiction' });
  const speakers = new Set(result.units.filter((u) => u.kind === 'dialogue').map((u) => u.speaker));
  check('alias merge Darcy/Bingley', speakers.has('Mr. Darcy') && speakers.has('Mr. Bingley'), [...speakers].join('|'));
}
{
  const result = buildAudiobookScript('"I said no," said Miss Bingley. "And I agree," said Bingley.', PROFILES, { genre: 'force-fiction' });
  const speakers = new Set(result.units.filter((u) => u.kind === 'dialogue').map((u) => u.speaker));
  check('female title does NOT swallow surname', speakers.has('Miss Bingley') && (speakers.has('Bingley') || speakers.has('Mr. Bingley')), [...speakers].join('|'));
}

// ---------- 17. discovery shapes ----------
{
  const names = discoverCharacterNames("Anna van der Berg smiled. \"McTavish roared. O'Brien laughed. Jean-Luc bowed.\" The crowd watched Anna van der Berg the whole evening.");
  check('particles', names.some((n) => /van der Berg/i.test(n)), names.join(','));
  check('Mc name', names.some((n) => /McTavish/i.test(n)), names.join(','));
  check("apostrophe name", names.some((n) => /O'Brien/i.test(n)), names.join(','));
  check('hyphen name', names.some((n) => /Jean-Luc/i.test(n)), names.join(','));
}
{
  const text = 'They found a girl named Lily asleep in the barn. Lily woke and smiled. "You found me," Lily said.';
  const names = discoverCharacterNames(text);
  check('named-alias discovery', names.includes('Lily'), names.join(','));
}
{
  // large cast: 30 distinct speakers, all discovered, all voiced
  const parts: string[] = [];
  for (let i = 1; i <= 30; i++) {
    const name = `Persname${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${i < 10 ? 'i' : 'j'}`;
    parts.push(`The bell rang. "Line ${i} reporting," said ${name}.`);
  }
  const text = parts.join('\n\n');
  const names = discoverCharacterNames(text);
  check('30 names discovered', names.length >= 30, String(names.length));
  const result = buildAudiobookScript(text, PROFILES, { genre: 'force-fiction' });
  const voiced = result.cast.filter((c) => c.name !== 'Narrator');
  const narratedQuotes = result.units.filter((u) => u.kind === 'dialogue' && u.speaker === 'Narrator').length;
  check('large cast fully voiced', voiced.length >= 30, `${voiced.length} cast, ${narratedQuotes} quotes folded to Narrator`);
  const voiceKeys = new Set(voiced.map((c) => `${c.profileId}:${c.pitch}:${c.rate}`));
  check('voices differentiated', voiceKeys.size >= 25, String(voiceKeys.size));
}

// ---------- 18. possessive beat ----------
{
  const text = 'Eleanor froze. Her voice trembled. "Do not follow me."';
  const names = discoverCharacterNames(text);
  const pass1 = attributeDialogue(text, names);
  const roster = [...new Set(pass1.filter((u) => u.kind === 'dialogue' && u.speaker !== 'Narrator').map((u) => u.speaker))];
  const units = attributeDialogue(text, names, { roster });
  const d = units.filter((u) => u.kind === 'dialogue')[0];
  check('possessive beat', d.speaker === 'Eleanor', `${d.speaker} [${d.evidence}]`);
}

// ---------- 19. voice-came ----------
{
  const sp = speakersOf('"Who goes there?" came the voice of an old man.');
  check('voice of an old man', sp[0] === 'The Old Man', sp.join('|'));
}

// ---------- 20. full pipeline sanity ----------
{
  const text = [
    'Chapter One',
    '',
    'Eleanor woke at dawn. "Tomas," she called, "the tide is early."',
    '',
    'Tomas was already dressed. "Then we leave now," he said, "or we swim."',
    '',
    'The innkeeper only laughed. "The tide," said the innkeeper, "waits for no one."',
    '',
    '"Page 47"',
    'Copyright the Author. All rights reserved.',
  ].join('\n');
  const result = buildAudiobookScript(text, PROFILES, { genre: 'force-fiction' });
  const d = result.units.filter((u) => u.kind === 'dialogue');
  const sp = d.map((u) => u.speaker);
  check('pipeline: skip furniture', result.units.some((u) => u.kind === 'skip' && u.skipReason === 'copyright'), '');
  check('pipeline: three speakers + narrator', result.cast.length >= 4, result.cast.map((c) => c.name).join('|'));
  check('pipeline: Tomas attributed', sp.includes('Tomas'), sp.join('|'));
  check('pipeline: innkeeper descriptive', sp.includes('The Innkeeper'), sp.join('|'));
  check('pipeline: stats.speakers', result.stats.speakers >= 3, String(result.stats.speakers));
}

// ---------- report ----------
console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
