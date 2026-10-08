// ============================================================
// Openmukti Audiobook Creator — comprehensive dialogue pattern catalog
// ("lightweight AI", part 0 — shared by autobook.ts discovery + attribution).
//
// One place holds EVERY dialogue convention the rule engine understands:
//   1. speech verbs        — ~260 verbs, grouped by loudness/question/mood,
//                            multi-word verbs first so alternation matches them
//   2. role nouns          — ~150 singular + ~120 group nouns with gender/age
//   3. honorifics          — ~110 titles (military, clergy, nobility, civic,
//                            academic, international, family, professional)
//   4. name shapes         — particles (von/de/al/Mc/O'), hyphens, apostrophes
//   5. quote scanner       — curly double, straight double, curly single
//                            (British), straight single (British, guarded),
//                            guillemets, em-dash paragraphs, play-colon lines,
//                            unclosed/continued speech across paragraphs
//   6. epistolary closings — "Yours sincerely, Eleanor" signature extraction
//   7. vocatives           — addressee names inside quotes
//
// Pure TypeScript: no DOM, no network, no randomness, no Date — the same
// text always produces the identical spans and names.
// ============================================================

// ---------- 1. speech verbs ----------

export type VerbMood =
  | 'neutral'    // said, replied, explained…
  | 'loud'       // shouted, bellowed, thundered…
  | 'soft'       // whispered, murmured, breathed…
  | 'question'   // asked, inquired, demanded…
  | 'response';  // retorted, countered, rejoined…

/** Multi-word verbs MUST precede their single-word prefixes in the regex
 * alternation ("went on" before a hypothetical "went"). */
const VERB_GROUPS: Record<VerbMood, string[]> = {
  neutral: [
    'went on', 'put in', 'broke in', 'cut in', 'chipped in', 'chimed in', 'weighed in', 'threw in',
    'jumped in', 'leapt in', 'burst out', 'burst in', 'spoke up', 'spoke out', 'started up',
    'called back', 'yelled back', 'shot back', 'fired back', 'tossed back', 'threw back', 'sent back',
    'answered back', 'read out', 'called after', 'sang out', 'cried out', 'called out', 'pointed out',
    'went so far as to say', 'had to say', 'was saying', 'kept saying',
    'said', 'says', 'add', 'added', 'adds', 'began', 'begins', 'continued', 'continues', 'resumed',
    'replied', 'replies', 'returned', 'responded', 'responds', 'remarked', 'observed', 'commented',
    'noted', 'stated', 'declared', 'announced', 'reported', 'informed', 'explained', 'related',
    'recounted', 'mentioned', 'volunteered', 'offered', 'interposed', 'echoed', 'repeated',
    'reiterated', 'quoted', 'recited', 'dictated', 'affirmed', 'asserted', 'averred', 'avowed',
    'attested', 'testified', 'swore', 'vowed', 'promised', 'pledged', 'consented', 'agreed',
    'concurred', 'conceded', 'admitted', 'confessed', 'owned', 'allowed', 'granted', 'acknowledged',
    'maintained', 'contended', 'argued', 'reasoned', 'suggested', 'proposed', 'advised', 'counselled',
    'counseled', 'recommended', 'urged', 'pressed', 'pleaded', 'plead', 'appealed', 'begged',
    'implored', 'beseeched', 'besought', 'entreated', 'petitioned', 'uttered', 'articulated',
    'pronounced', 'enunciated', 'voiced', 'lied', 'fibbed', 'bluffed', 'boasted', 'bragged',
    'joked', 'quipped', 'teased', 'bantered', 'jested', 'punned', 'enthused', 'gushed', 'fawned',
    'marveled', 'marvelled', 'praised', 'flattered', 'confided', 'disclosed', 'revealed', 'admitted',
    'declared', 'proclaimed', 'professed', 'preached', 'sermonised', 'sermonized', 'lectured',
    'expounded', 'instructed', 'directed', 'bade', 'forbade', 'commanded', 'ordered', 'demanded',
    'warned', 'cautioned', 'threatened', 'menaced', 'bullied', 'coaxed', 'wheedled', 'sweet-talked',
    'comforted', 'consoled', 'soothed', 'reassured', 'assured', 'blessed', 'cursed', 'damned',
    'grumbled', 'complained', 'moaned', 'groaned', 'lamented', 'bemoaned', 'fretted', 'fumed',
    'seethed', 'raged', 'insisted', 'objected', 'protested', 'dissented', 'denied', 'refuted',
    'rebutted', 'disagreed', 'differed', 'stipulated', 'specified', 'clarified', 'confirmed',
    'verified', 'affirmed', 'reaffirmed', 'certified', 'swore',
  ],
  loud: [
    'shouted', 'yelled', 'screamed', 'shrieked', 'screeched', 'howled', 'bawled', 'bellowed',
    'roared', 'thundered', 'boomed', 'cried', 'called', 'hollered', 'holler', 'exclaimed',
    'ejaculated', 'vociferated', 'clamoured', 'clamored', 'whooped', 'cheered', 'hailed', 'barked',
    'snapped', 'snarled', 'growled', 'spat', 'hissed', 'rasped', 'screamed out', 'thundered out',
    'roared out', 'bellowed out', 'boomed out', 'shrieked out', 'bleated', 'brayed',
  ],
  soft: [
    'whispered', 'whisper', 'murmured', 'murmur', 'muttered', 'mutter', 'mumbled', 'breathed',
    'sighed', 'mouthed', 'hummed', 'crooned', 'cooed', 'lilted', 'sang', 'intones', 'intoned',
    'droned', 'drawled', 'mewled', 'whimpered', 'whined', 'sobbed', 'wept', 'sniffled', 'choked out',
    'choked', 'gasped', 'panted', 'puffed', 'huffed', 'susurrated', 'hushed', 'blurted', 'blurted out',
    'stammered', 'stuttered', 'faltered', 'hesitated', 'trailed off', 'babbled', 'gabbled',
    'spluttered', 'sputtered', 'stammered out', 'mouthed silently',
  ],
  question: [
    'asked', 'asks', 'inquired', 'enquired', 'queried', 'questioned', 'interrogated', 'quizzed',
    'wondered', 'wonder', 'requested', 'quizzed', 'cross-examined', 'grilled', 'pressed',
  ],
  response: [
    'retorted', 'countered', 'rejoined', 'answered', 'opined', 'ventured', 'conceded', 'acquiesced',
    'assented', 'scoffed', 'sneered', 'jeered', 'taunted', 'mocked', 'derided', 'ridiculed',
    'crowed', 'gloated', 'cackled', 'chuckled', 'giggled', 'sniggered', 'snickered', 'tittered',
    'chortled', 'guffawed', 'laughed', 'chimed', 'shrilled', 'wailed', 'sniffed', 'grunted',
    'sighed',
  ],
};

export const EMOTION_BY_VERB: Record<string, 'whisper' | 'urgent' | 'curious' | 'soft'> = (() => {
  const map: Record<string, 'whisper' | 'urgent' | 'curious' | 'soft'> = {
    whispered: 'whisper', mouthed: 'whisper', 'choked out': 'soft', 'trailed off': 'soft',
    murmured: 'soft', muttered: 'soft', breathed: 'soft', mumbled: 'soft', sobbed: 'soft',
    wept: 'soft', pleaded: 'soft', begged: 'soft', comforted: 'soft', reassured: 'soft',
    whimpered: 'soft', mewled: 'soft', crooned: 'soft', cooed: 'soft', lilted: 'soft',
    shouted: 'urgent', cried: 'urgent', called: 'urgent', demanded: 'urgent', growled: 'urgent',
    snapped: 'urgent', hissed: 'urgent', screamed: 'urgent', yelled: 'urgent', bellowed: 'urgent',
    roared: 'urgent', shrieked: 'urgent', threatened: 'urgent', protested: 'urgent', objected: 'urgent',
    'cried out': 'urgent', 'called out': 'urgent', howled: 'urgent', bawled: 'urgent', thundered: 'urgent',
    barked: 'urgent', snarled: 'urgent', spat: 'urgent', stormed: 'urgent', swore: 'urgent',
    asked: 'curious', wondered: 'curious', queried: 'curious', inquired: 'curious', enquired: 'curious',
    teased: 'curious', quipped: 'curious', chuckled: 'soft', laughed: 'soft', giggled: 'soft',
    snickered: 'soft', sniggered: 'soft', tittered: 'soft', chortled: 'soft', cackled: 'soft',
    sighed: 'soft', groaned: 'soft', moaned: 'soft', gasped: 'soft', stammered: 'soft',
    stuttered: 'soft', faltered: 'soft', blurted: 'urgent', 'blurted out': 'urgent',
  };
  return map;
})();

/** Longest-first alternation source for the whole catalog (multi-word safe). */
export const ALL_SPEECH_VERBS: string[] = (() => {
  const seen = new Set<string>();
  const all: string[] = [];
  for (const mood of Object.keys(VERB_GROUPS) as VerbMood[]) {
    for (const v of VERB_GROUPS[mood]) {
      const key = v.toLowerCase();
      if (!seen.has(key)) { seen.add(key); all.push(v); }
    }
  }
  return all.sort((a, b) => b.length - a.length || a.localeCompare(b));
})();

/** Regex alternation fragment — escape nothing: the catalog is plain words. */
export const VERBS_ALTERNATION: string = ALL_SPEECH_VERBS.join('|');

/** True when `word` is any known speech verb (case-insensitive). */
const VERB_SET = new Set(ALL_SPEECH_VERBS.map((v) => v.toLowerCase()));
export function isSpeechVerb(word: string): boolean {
  return VERB_SET.has(word.toLowerCase().replace(/\s+/g, ' ').trim());
}

/** Verb mood → delivery hint default (verbs not in EMOTION_BY_VERB stay undefined). */
export function moodForVerb(verb: string): 'whisper' | 'urgent' | 'curious' | 'soft' | undefined {
  return EMOTION_BY_VERB[verb.toLowerCase().replace(/\s+/g, ' ').trim()];
}

/** Common narration action verbs — a capitalized token leading a sentence and
 * followed by one of these ("Tomas turned.", "Eleanor froze.") is very likely
 * a character performing a beat. Used by discovery as a strong signal. */
export const NARRATION_BEAT_VERBS: ReadonlySet<string> = new Set(
  (
    'turned smiled frowned nodded shook stepped rose stood sat walked ran looked stared glanced sighed '
    + 'laughed cried paused hesitated waited knocked entered appeared vanished woke dressed arrived left '
    + 'returned bowed froze shivered trembled groaned yawned stretched wandered strolled marched hurried '
    + 'hurried limped climbed descended descended leaned leaned bent knelt knelt spat sneezed coughed '
    + 'whispered gasped panicked blushed paled grinned scowled glowered beamed waved saluted beckoned '
    + 'shouted yelled screamed called followed chased fled retreated advanced approached circled '
    + 'opened shut closed locked unlocked folded unfolded crossed tensed straightened shrugged grabbed seized clutched gripped dropped threw caught lifted '
    + 'carried pulled pushed hauled dragged tugged yanked shoved slammed banged tapped rapped kicked '
    + 'punched struck hit slapped pinched scratched rubbed patted stroked hugged kissed embraced '
    + 'listened heard watched observed peered peeked studied examined inspected searched hunted sought '
    + 'found lost hid hid sought fled swung spun twirled danced sang whistled hummed prayed meditated '
    + 'slept dozed napped dream woke awoke ate drank feasted dined cooked baked brewed poured sipped '
    + 'gulped chewed swallowed licked bit chewed read wrote drew sketched painted carved whittled '
    + 'measured counted weighed weighed paid spent bought sold traded bargained haggled stole robbed '
    + 'cheated lied confessed admitted vowed swore promised agreed refused consented declined accepted '
    + 'gathered scattered assembled dispersed rallied mustered marshaled organised organized planned '
    + 'prepared arranged settled unpacked packed boarded disembarked landed departed sailed anchored '
    + 'rowed steered navigated mapped charted explored discovered ventured journeyed traveled travelled '
    + 'camped rested slept bathed washed cleaned scrubbed swept mended stitched sewed knitted spun '
    + 'forged hammered shaped moulded molded fired aimed shot missed reloaded drew sheathed '
    + 'unsheathed blocked parried dodged ducked lunged charged retreated guarded defended attacked '
    + 'reigned ruled governed taxed commanded led obeyed served protected guarded patrolled marched'
  ).split(/\s+/),
);

// ---------- 2. role nouns (descriptive speakers) ----------

export interface RoleNounMeta {
  gender: 'male' | 'female' | 'neutral';
  age?: 'child' | 'young' | 'adult' | 'middle' | 'elder';
  /** Plural/group speaker — gets a deeper, ensemble voice. */
  group?: boolean;
}

const ROLE_TABLE_RAW: Array<[string, RoleNounMeta]> = [
  // — people by age/sex —
  ['girl', { gender: 'female', age: 'child' }], ['boy', { gender: 'male', age: 'child' }],
  ['child', { gender: 'neutral', age: 'child' }], ['kid', { gender: 'neutral', age: 'child' }],
  ['children', { gender: 'neutral', age: 'child', group: true }],
  ['toddler', { gender: 'neutral', age: 'child' }], ['infant', { gender: 'neutral', age: 'child' }],
  ['baby', { gender: 'neutral', age: 'child' }], ['lad', { gender: 'male', age: 'young' }],
  ['lass', { gender: 'female', age: 'young' }], ['teenager', { gender: 'neutral', age: 'young' }],
  ['teen', { gender: 'neutral', age: 'young' }], ['youth', { gender: 'male', age: 'young' }],
  ['maiden', { gender: 'female', age: 'young' }],
  ['man', { gender: 'male' }], ['woman', { gender: 'female' }],
  ['gentleman', { gender: 'male' }], ['gentlewoman', { gender: 'female' }],
  ['lady', { gender: 'female' }], ['fellow', { gender: 'male' }],
  ['person', { gender: 'neutral' }], ['chap', { gender: 'male' }], ['bloke', { gender: 'male' }],
  ['old man', { gender: 'male', age: 'elder' }], ['old woman', { gender: 'female', age: 'elder' }],
  ['old fellow', { gender: 'male', age: 'elder' }], ['old lady', { gender: 'female', age: 'elder' }],
  ['old gentleman', { gender: 'male', age: 'elder' }],
  ['elderly man', { gender: 'male', age: 'elder' }], ['elderly woman', { gender: 'female', age: 'elder' }],
  ['elderly gentleman', { gender: 'male', age: 'elder' }], ['elderly lady', { gender: 'female', age: 'elder' }],
  ['young man', { gender: 'male', age: 'young' }], ['young woman', { gender: 'female', age: 'young' }],
  ['little boy', { gender: 'male', age: 'child' }], ['little girl', { gender: 'female', age: 'child' }],
  ['little one', { gender: 'neutral', age: 'child' }], ['small boy', { gender: 'male', age: 'child' }],
  ['small girl', { gender: 'female', age: 'child' }], ['young girl', { gender: 'female', age: 'young' }],
  ['young boy', { gender: 'male', age: 'child' }], ['other girl', { gender: 'female', age: 'young' }],
  ['other boy', { gender: 'male', age: 'young' }], ['other man', { gender: 'male' }],
  ['other woman', { gender: 'female' }], ['other girl', { gender: 'female', age: 'young' }],
  // — nobility / titles —
  ['king', { gender: 'male' }], ['queen', { gender: 'female' }], ['prince', { gender: 'male' }],
  ['princess', { gender: 'female' }], ['duke', { gender: 'male' }], ['duchess', { gender: 'female' }],
  ['earl', { gender: 'male' }], ['count', { gender: 'male' }], ['countess', { gender: 'female' }],
  ['baron', { gender: 'male' }], ['baroness', { gender: 'female' }],
  ['marquis', { gender: 'male' }], ['marchioness', { gender: 'female' }],
  ['viscount', { gender: 'male' }], ['lord', { gender: 'male' }],
  ['emperor', { gender: 'male' }], ['empress', { gender: 'female' }],
  ['tsar', { gender: 'male' }], ['czar', { gender: 'male' }], ['tsarina', { gender: 'female' }],
  ['kaiser', { gender: 'male' }], ['sultan', { gender: 'male' }], ['sultana', { gender: 'female' }],
  ['shah', { gender: 'male' }], ['khan', { gender: 'male' }], ['pharaoh', { gender: 'male' }],
  ['rajah', { gender: 'male' }], ['maharaja', { gender: 'male' }], ['rani', { gender: 'female' }],
  ['maharani', { gender: 'female' }], ['knight', { gender: 'male' }], ['squire', { gender: 'male' }],
  ['page', { gender: 'male', age: 'young' }], ['herald', { gender: 'neutral' }],
  ['seneschal', { gender: 'male' }], ['steward', { gender: 'male' }],
  // — household / service —
  ['maid', { gender: 'female' }], ['servant', { gender: 'neutral' }], ['servants', { gender: 'neutral', group: true }],
  ['butler', { gender: 'male' }], ['valet', { gender: 'male' }], ['footman', { gender: 'male' }],
  ['coachman', { gender: 'male' }], ['stableboy', { gender: 'male', age: 'child' }],
  ['stable boy', { gender: 'male', age: 'child' }], ['stableman', { gender: 'male' }],
  ['groom', { gender: 'male' }], ['host', { gender: 'male' }], ['hostess', { gender: 'female' }],
  ['housekeeper', { gender: 'female' }], ['chambermaid', { gender: 'female' }],
  ['scullerymaid', { gender: 'female' }], ['barmaid', { gender: 'female' }], ['barman', { gender: 'male' }],
  ['landlord', { gender: 'male' }], ['landlady', { gender: 'female' }],
  ['porter', { gender: 'male' }], ['gatekeeper', { gender: 'male' }], ['watchman', { gender: 'male' }],
  ['cook', { gender: 'female' }], ['governess', { gender: 'female' }],
  ['nurse', { gender: 'female' }], ['matron', { gender: 'female' }],
  ['schoolmaster', { gender: 'male' }], ['schoolmistress', { gender: 'female' }],
  ['teacher', { gender: 'female' }], ['pupil', { gender: 'male', age: 'young' }],
  ['student', { gender: 'neutral', age: 'young' }], ['waiter', { gender: 'male' }],
  ['waitress', { gender: 'female' }], ['attendant', { gender: 'neutral' }],
  ['doorman', { gender: 'male' }], ['doorkeeper', { gender: 'neutral' }],
  // — trades —
  ['innkeeper', { gender: 'male' }], ['innkeeper\'s wife', { gender: 'female' }],
  ['ostler', { gender: 'male' }], ['blacksmith', { gender: 'male' }], ['smith', { gender: 'male' }],
  ['miller', { gender: 'male' }], ['baker', { gender: 'male' }], ['tailor', { gender: 'male' }],
  ['cobbler', { gender: 'male' }], ['shoemaker', { gender: 'male' }], ['carpenter', { gender: 'male' }],
  ['joiner', { gender: 'male' }], ['mason', { gender: 'male' }], ['weaver', { gender: 'female' }],
  ['merchant', { gender: 'male' }], ['trader', { gender: 'neutral' }],
  ['shopkeeper', { gender: 'neutral' }], ['peddler', { gender: 'male' }], ['pedlar', { gender: 'male' }],
  ['hawker', { gender: 'male' }], ['fisherman', { gender: 'male' }],
  ['fisherwoman', { gender: 'female' }], ['fisherman\'s wife', { gender: 'female' }],
  ['shepherd', { gender: 'male' }], ['shepherdess', { gender: 'female' }],
  ['farmer', { gender: 'male' }], ['farmer\'s wife', { gender: 'female' }],
  ['ploughboy', { gender: 'male', age: 'child' }], ['plowboy', { gender: 'male', age: 'child' }],
  ['midwife', { gender: 'female', age: 'elder' }], ['healer', { gender: 'female' }],
  ['physician', { gender: 'male' }], ['doctor', { gender: 'neutral' }], ['surgeon', { gender: 'male' }],
  ['apothecary', { gender: 'male' }], ['dentist', { gender: 'male' }],
  ['scribe', { gender: 'male' }], ['clerk', { gender: 'neutral' }], ['secretary', { gender: 'female' }],
  ['treasurer', { gender: 'male' }], ['moneylender', { gender: 'male' }], ['pawnbroker', { gender: 'male' }],
  ['stationmaster', { gender: 'male' }], ['conductor', { gender: 'male' }],
  ['engine driver', { gender: 'male' }], ['postman', { gender: 'male' }], ['milkman', { gender: 'male' }],
  ['newsboy', { gender: 'male', age: 'child' }], ['errand boy', { gender: 'male', age: 'child' }],
  // — authority / law —
  ['magistrate', { gender: 'male' }], ['judge', { gender: 'neutral' }], ['justice', { gender: 'male' }],
  ['lawyer', { gender: 'neutral' }], ['advocate', { gender: 'male' }], ['solicitor', { gender: 'male' }],
  ['barrister', { gender: 'male' }], ['attorney', { gender: 'male' }], ['notary', { gender: 'male' }],
  ['mayor', { gender: 'male' }], ['sheriff', { gender: 'male' }], ['constable', { gender: 'male' }],
  ['bailiff', { gender: 'male' }], ['coroner', { gender: 'male' }], ['marshal', { gender: 'male' }],
  ['deputy', { gender: 'male' }], ['ranger', { gender: 'male' }], ['gamekeeper', { gender: 'male' }],
  ['poacher', { gender: 'male' }], ['jailer', { gender: 'male' }], ['gaoler', { gender: 'male' }],
  ['turnkey', { gender: 'male' }], ['executioner', { gender: 'male' }],
  ['detective', { gender: 'neutral' }], ['inspector', { gender: 'male' }], ['officer', { gender: 'male' }],
  ['policeman', { gender: 'male' }], ['policewoman', { gender: 'female' }],
  // — military —
  ['soldier', { gender: 'male' }], ['warrior', { gender: 'male' }], ['general', { gender: 'male' }],
  ['colonel', { gender: 'male' }], ['major', { gender: 'male' }], ['captain', { gender: 'male' }],
  ['commander', { gender: 'male' }], ['admiral', { gender: 'male' }], ['lieutenant', { gender: 'male' }],
  ['sergeant', { gender: 'male' }], ['corporal', { gender: 'male' }],
  ['sentry', { gender: 'male' }], ['guard', { gender: 'male' }], ['guardsman', { gender: 'male' }],
  ['archer', { gender: 'male' }], ['bowman', { gender: 'male' }], ['pikeman', { gender: 'male' }],
  ['musketeer', { gender: 'male' }], ['gunner', { gender: 'male' }], ['cavalryman', { gender: 'male' }],
  ['trooper', { gender: 'male' }], ['mercenary', { gender: 'male' }], ['gladiator', { gender: 'male' }],
  ['centurion', { gender: 'male' }], ['legionary', { gender: 'male' }], ['hoplite', { gender: 'male' }],
  // — sea —
  ['sailor', { gender: 'male' }], ['seaman', { gender: 'male' }], ['boatswain', { gender: 'male' }],
  ['bosun', { gender: 'male' }], ['coxswain', { gender: 'male' }],
  ['quartermaster', { gender: 'male' }], ['navigator', { gender: 'male' }], ['pilot', { gender: 'male' }],
  ['deckhand', { gender: 'male' }], ['cabin boy', { gender: 'male', age: 'child' }],
  ['ferryman', { gender: 'male' }], ['boatman', { gender: 'male' }],
  ['pirate', { gender: 'male' }], ['buccaneer', { gender: 'male' }], ['corsair', { gender: 'male' }],
  ['smuggler', { gender: 'male' }], ['bandit', { gender: 'male' }], ['outlaw', { gender: 'male' }],
  ['brigand', { gender: 'male' }], ['highwayman', { gender: 'male' }], ['robber', { gender: 'male' }],
  ['thief', { gender: 'male' }], ['cutpurse', { gender: 'male' }],
  // — clergy / magic —
  ['priest', { gender: 'male' }], ['priestess', { gender: 'female' }], ['monk', { gender: 'male' }],
  ['friar', { gender: 'male' }], ['nun', { gender: 'female' }], ['abbot', { gender: 'male' }],
  ['abbess', { gender: 'female' }], ['prior', { gender: 'male' }], ['deacon', { gender: 'male' }],
  ['bishop', { gender: 'male' }], ['archbishop', { gender: 'male' }], ['cardinal', { gender: 'male' }],
  ['pope', { gender: 'male' }], ['curate', { gender: 'male' }], ['vicar', { gender: 'male' }],
  ['rector', { gender: 'male' }], ['parson', { gender: 'male' }], ['chaplain', { gender: 'male' }],
  ['rabbi', { gender: 'male' }], ['imam', { gender: 'male' }], ['mullah', { gender: 'male' }],
  ['sheikh', { gender: 'male' }], ['pandit', { gender: 'male' }], ['swami', { gender: 'male' }],
  ['guru', { gender: 'neutral' }],
  ['witch', { gender: 'female' }], ['wizard', { gender: 'male' }],
  ['sorceress', { gender: 'female' }], ['sorcerer', { gender: 'male' }],
  ['enchantress', { gender: 'female' }], ['necromancer', { gender: 'male' }],
  ['warlock', { gender: 'male' }], ['alchemist', { gender: 'male' }], ['druid', { gender: 'male' }],
  ['shaman', { gender: 'male' }], ['seer', { gender: 'neutral' }],
  ['prophet', { gender: 'male' }], ['prophetess', { gender: 'female' }], ['oracle', { gender: 'female' }],
  // — peoples / fantasy —
  ['elf', { gender: 'neutral', age: 'young' }], ['dwarf', { gender: 'male' }],
  ['giant', { gender: 'male' }], ['ogre', { gender: 'male' }], ['troll', { gender: 'male' }],
  ['goblin', { gender: 'male' }], ['hobgoblin', { gender: 'male' }], ['orc', { gender: 'male' }],
  ['fairy', { gender: 'female' }], ['pixie', { gender: 'female' }], ['sprite', { gender: 'female' }],
  ['nymph', { gender: 'female' }], ['mermaid', { gender: 'female' }], ['merman', { gender: 'male' }],
  ['centaur', { gender: 'male' }], ['minotaur', { gender: 'male' }], ['vampire', { gender: 'male' }],
  ['werewolf', { gender: 'male' }], ['ghost', { gender: 'neutral' }], ['spirit', { gender: 'neutral' }],
  ['phantom', { gender: 'neutral' }], ['spectre', { gender: 'male' }], ['specter', { gender: 'male' }],
  ['wraith', { gender: 'male' }], ['poltergeist', { gender: 'neutral' }], ['zombie', { gender: 'male' }],
  ['ghoul', { gender: 'male' }], ['demon', { gender: 'male' }], ['devil', { gender: 'male' }],
  ['angel', { gender: 'female' }], ['genie', { gender: 'male' }], ['jinn', { gender: 'male' }],
  ['djinn', { gender: 'male' }],
  // — animals that talk in fiction —
  ['wolf', { gender: 'male' }], ['fox', { gender: 'male' }], ['cat', { gender: 'neutral' }],
  ['dog', { gender: 'male' }], ['bird', { gender: 'neutral' }], ['owl', { gender: 'neutral' }],
  ['crow', { gender: 'neutral' }], ['raven', { gender: 'neutral' }], ['lion', { gender: 'male' }],
  ['tiger', { gender: 'male' }], ['bear', { gender: 'male' }], ['horse', { gender: 'male' }],
  ['mare', { gender: 'female' }], ['stallion', { gender: 'male' }], ['pony', { gender: 'neutral' }],
  ['donkey', { gender: 'male' }], ['goat', { gender: 'male' }], ['sheep', { gender: 'neutral' }],
  ['pig', { gender: 'male' }], ['rat', { gender: 'male' }], ['mouse', { gender: 'neutral' }],
  ['snake', { gender: 'male' }], ['serpent', { gender: 'male' }], ['dragon', { gender: 'male' }],
  ['eagle', { gender: 'male' }], ['hawk', { gender: 'male' }], ['falcon', { gender: 'male' }],
  ['parrot', { gender: 'neutral' }], ['spider', { gender: 'neutral' }], ['toad', { gender: 'male' }],
  ['frog', { gender: 'male' }], ['owl', { gender: 'neutral' }],
  // — mystery speakers —
  ['voice', { gender: 'neutral' }], ['creature', { gender: 'neutral' }],
  ['figure', { gender: 'neutral' }], ['shadow', { gender: 'neutral' }],
  ['stranger', { gender: 'neutral' }], ['newcomer', { gender: 'neutral' }],
  ['visitor', { gender: 'neutral' }], ['guest', { gender: 'neutral' }],
  ['passer-by', { gender: 'neutral' }], ['bystander', { gender: 'neutral' }],
  ['watcher', { gender: 'neutral' }], ['hooded figure', { gender: 'neutral' }],
  ['tall man', { gender: 'male' }], ['small man', { gender: 'male' }],
  ['traveller', { gender: 'neutral' }], ['traveler', { gender: 'neutral' }],
  ['wanderer', { gender: 'neutral' }], ['vagabond', { gender: 'male' }], ['beggar', { gender: 'male' }],
  ['captain of the guard', { gender: 'male' }], ['leader', { gender: 'male' }],
  ['chief', { gender: 'male' }], ['chieftain', { gender: 'male' }],
  ['elder', { gender: 'neutral', age: 'elder' }], ['ward', { gender: 'neutral' }],
  ['orphan', { gender: 'neutral', age: 'child' }], ['foundling', { gender: 'neutral', age: 'child' }],
  ['captive', { gender: 'neutral' }], ['prisoner', { gender: 'male' }], ['slave', { gender: 'neutral' }],
  ['neighbour', { gender: 'neutral' }], ['neighbor', { gender: 'neutral' }],
  ['twin', { gender: 'neutral' }], ['cousin', { gender: 'neutral' }],
  ['bride', { gender: 'female' }], ['groom\'s brother', { gender: 'male' }],
  ['aunt', { gender: 'female' }], ['uncle', { gender: 'male' }],
  ['mother', { gender: 'female' }], ['father', { gender: 'male' }],
  ['grandmother', { gender: 'female', age: 'elder' }], ['grandfather', { gender: 'male', age: 'elder' }],
  ['granny', { gender: 'female', age: 'elder' }], ['grandpa', { gender: 'male', age: 'elder' }],
  ['grandma', { gender: 'female', age: 'elder' }], ['nana', { gender: 'female', age: 'elder' }],
  ['daughter', { gender: 'female' }], ['son', { gender: 'male' }],
  ['sister', { gender: 'female' }], ['brother', { gender: 'male' }],
  ['wife', { gender: 'female' }], ['husband', { gender: 'male' }],
  ['mistress', { gender: 'female' }], ['master', { gender: 'male' }],
  ['widow', { gender: 'female', age: 'middle' }], ['widower', { gender: 'male', age: 'middle' }],
  ['hunter', { gender: 'male' }], ['gipsy', { gender: 'female' }], ['gypsy', { gender: 'female' }],
  ['innkeeper', { gender: 'male' }], ['barman', { gender: 'male' }],
];

/** Plural / group nouns — an ensemble speaks ("cried the soldiers"). */
const GROUP_TABLE_RAW: Array<[string, RoleNounMeta]> = [
  ['men', { gender: 'male', group: true }], ['women', { gender: 'female', group: true }],
  ['boys', { gender: 'male', age: 'young', group: true }], ['girls', { gender: 'female', age: 'young', group: true }],
  ['folks', { gender: 'neutral', group: true }], ['folk', { gender: 'neutral', group: true }],
  ['people', { gender: 'neutral', group: true }], ['others', { gender: 'neutral', group: true }],
  ['crowd', { gender: 'neutral', group: true }], ['crowds', { gender: 'neutral', group: true }],
  ['throng', { gender: 'neutral', group: true }], ['multitude', { gender: 'neutral', group: true }],
  ['mob', { gender: 'neutral', group: true }], ['horde', { gender: 'neutral', group: true }],
  ['assembly', { gender: 'neutral', group: true }], ['audience', { gender: 'neutral', group: true }],
  ['spectators', { gender: 'neutral', group: true }], ['onlookers', { gender: 'neutral', group: true }],
  ['bystanders', { gender: 'neutral', group: true }], ['passers-by', { gender: 'neutral', group: true }],
  ['congregation', { gender: 'neutral', group: true }], ['courtiers', { gender: 'neutral', group: true }],
  ['court', { gender: 'neutral', group: true }], ['nobles', { gender: 'neutral', group: true }],
  ['lords', { gender: 'male', group: true }], ['ladies', { gender: 'female', group: true }],
  ['peasants', { gender: 'neutral', group: true }], ['villagers', { gender: 'neutral', group: true }],
  ['townsfolk', { gender: 'neutral', group: true }], ['townspeople', { gender: 'neutral', group: true }],
  ['countryfolk', { gender: 'neutral', group: true }], ['farmers', { gender: 'male', group: true }],
  ['soldiers', { gender: 'male', group: true }], ['troops', { gender: 'male', group: true }],
  ['warriors', { gender: 'male', group: true }], ['knights', { gender: 'male', group: true }],
  ['guards', { gender: 'male', group: true }], ['guardsmen', { gender: 'male', group: true }],
  ['watchmen', { gender: 'male', group: true }], ['militia', { gender: 'neutral', group: true }],
  ['rebels', { gender: 'neutral', group: true }], ['sailors', { gender: 'male', group: true }],
  ['seamen', { gender: 'male', group: true }], ['crew', { gender: 'neutral', group: true }],
  ['pirates', { gender: 'male', group: true }], ['archers', { gender: 'male', group: true }],
  ['horsemen', { gender: 'male', group: true }], ['riders', { gender: 'neutral', group: true }],
  ['hunters', { gender: 'male', group: true }], ['settlers', { gender: 'neutral', group: true }],
  ['miners', { gender: 'male', group: true }], ['workmen', { gender: 'male', group: true }],
  ['workers', { gender: 'neutral', group: true }], ['labourers', { gender: 'male', group: true }],
  ['laborers', { gender: 'male', group: true }], ['apprentices', { gender: 'neutral', group: true }],
  ['craftsmen', { gender: 'male', group: true }], ['artisans', { gender: 'neutral', group: true }],
  ['merchants', { gender: 'neutral', group: true }], ['traders', { gender: 'neutral', group: true }],
  ['peddlers', { gender: 'male', group: true }], ['beggars', { gender: 'neutral', group: true }],
  ['vagabonds', { gender: 'neutral', group: true }], ['wanderers', { gender: 'neutral', group: true }],
  ['travellers', { gender: 'neutral', group: true }], ['travelers', { gender: 'neutral', group: true }],
  ['pilgrims', { gender: 'neutral', group: true }], ['refugees', { gender: 'neutral', group: true }],
  ['exiles', { gender: 'neutral', group: true }], ['prisoners', { gender: 'neutral', group: true }],
  ['captives', { gender: 'neutral', group: true }], ['slaves', { gender: 'neutral', group: true }],
  ['students', { gender: 'neutral', group: true }], ['pupils', { gender: 'neutral', group: true }],
  ['scholars', { gender: 'neutral', group: true }], ['nuns', { gender: 'female', group: true }],
  ['monks', { gender: 'male', group: true }], ['friars', { gender: 'male', group: true }],
  ['priests', { gender: 'male', group: true }],
  ['choir', { gender: 'neutral', group: true }], ['chorus', { gender: 'neutral', group: true }],
  ['choristers', { gender: 'neutral', group: true }], ['musicians', { gender: 'neutral', group: true }],
  ['minstrels', { gender: 'neutral', group: true }], ['bards', { gender: 'neutral', group: true }],
  ['jesters', { gender: 'neutral', group: true }], ['actors', { gender: 'neutral', group: true }],
  ['players', { gender: 'neutral', group: true }], ['troupe', { gender: 'neutral', group: true }],
  ['company', { gender: 'neutral', group: true }], ['band', { gender: 'neutral', group: true }],
  ['orchestra', { gender: 'neutral', group: true }], ['dancers', { gender: 'neutral', group: true }],
  ['guests', { gender: 'neutral', group: true }], ['visitors', { gender: 'neutral', group: true }],
  ['strangers', { gender: 'neutral', group: true }], ['newcomers', { gender: 'neutral', group: true }],
  ['arrivals', { gender: 'neutral', group: true }], ['passengers', { gender: 'neutral', group: true }],
  ['customers', { gender: 'neutral', group: true }], ['clients', { gender: 'neutral', group: true }],
  ['patrons', { gender: 'neutral', group: true }], ['diners', { gender: 'neutral', group: true }],
  ['drinkers', { gender: 'neutral', group: true }], ['regulars', { gender: 'neutral', group: true }],
  ['locals', { gender: 'neutral', group: true }], ['natives', { gender: 'neutral', group: true }],
  ['tribesmen', { gender: 'male', group: true }], ['clansmen', { gender: 'male', group: true }],
  ['kinsmen', { gender: 'male', group: true }], ['relatives', { gender: 'neutral', group: true }],
  ['family', { gender: 'neutral', group: true }], ['parents', { gender: 'neutral', group: true }],
  ['grandparents', { gender: 'neutral', group: true }], ['twins', { gender: 'neutral', group: true }],
  ['siblings', { gender: 'neutral', group: true }], ['cousins', { gender: 'neutral', group: true }],
  ['companions', { gender: 'neutral', group: true }], ['comrades', { gender: 'neutral', group: true }],
  ['friends', { gender: 'neutral', group: true }], ['allies', { gender: 'neutral', group: true }],
  ['enemies', { gender: 'neutral', group: true }], ['foes', { gender: 'neutral', group: true }],
  ['rivals', { gender: 'neutral', group: true }], ['opponents', { gender: 'neutral', group: true }],
  ['captors', { gender: 'neutral', group: true }], ['rescuers', { gender: 'neutral', group: true }],
  ['pursuers', { gender: 'neutral', group: true }], ['followers', { gender: 'neutral', group: true }],
  ['devotees', { gender: 'neutral', group: true }], ['worshippers', { gender: 'neutral', group: true }],
  ['believers', { gender: 'neutral', group: true }], ['faithful', { gender: 'neutral', group: true }],
  ['flock', { gender: 'neutral', group: true }], ['herd', { gender: 'neutral', group: true }],
  ['pack', { gender: 'neutral', group: true }], ['swarm', { gender: 'neutral', group: true }],
  ['legion', { gender: 'male', group: true }], ['battalion', { gender: 'male', group: true }],
  ['regiment', { gender: 'male', group: true }], ['squadron', { gender: 'male', group: true }],
  ['platoon', { gender: 'male', group: true }], ['squad', { gender: 'neutral', group: true }],
  ['team', { gender: 'neutral', group: true }], ['committee', { gender: 'neutral', group: true }],
  ['council', { gender: 'neutral', group: true }], ['board', { gender: 'neutral', group: true }],
  ['jury', { gender: 'neutral', group: true }], ['senate', { gender: 'neutral', group: true }],
  ['officials', { gender: 'neutral', group: true }], ['clerks', { gender: 'neutral', group: true }],
  ['boys', { gender: 'male', age: 'young', group: true }],
  ['elders', { gender: 'neutral', age: 'elder', group: true }],
  ['twelve', { gender: 'neutral', group: true }], ['threescore', { gender: 'neutral', group: true }],
  ['dozen', { gender: 'neutral', group: true }], ['hundred', { gender: 'neutral', group: true }],
  ['thousands', { gender: 'neutral', group: true }], ['voices', { gender: 'neutral', group: true }],
];

export const ROLE_NOUN_META: ReadonlyMap<string, RoleNounMeta> = new Map(
  [...ROLE_TABLE_RAW, ...GROUP_TABLE_RAW].map(([noun, meta]) => [noun, meta] as const),
);

export const ROLE_NOUN_SET: ReadonlySet<string> = new Set(ROLE_NOUN_META.keys());

/** Meta for a role-noun phrase's last word(s) — tries two-word phrases first. */
export function roleMetaForPhrase(phrase: string): RoleNounMeta | undefined {
  const words = phrase.trim().toLowerCase().replace(/\s+/g, ' ').split(/\s+/);
  if (!words.length) return undefined;
  if (words.length >= 2) {
    const two = `${words[words.length - 2]} ${words[words.length - 1]}`;
    const twoMeta = ROLE_NOUN_META.get(two);
    if (twoMeta) return twoMeta;
  }
  return ROLE_NOUN_META.get(words[words.length - 1]);
}

// ---------- 3. honorifics ----------

export const HONORIFICS: string[] = [
  // social
  'Mr', 'Mrs', 'Miss', 'Ms', 'Mx', 'Mme', 'M', 'Monsieur', 'Mademoiselle', 'Madame', 'Messieurs',
  'Mesdames', 'Frau', 'Herr', 'Fräulein', 'Fraulein', 'Signor', 'Signora', 'Signorina', 'Don',
  'Doña', 'Dona', 'Dom', 'Señor', 'Senor', 'Señora', 'Senora', 'Señorita', 'Senhorita', 'Senhor',
  'Sahib', 'Memsahib', 'Begum', 'Shri', 'Smt', 'Kumari', 'Pan', 'Pani', 'Gospodin', 'Gospozha',
  'Fröken', 'Fru', 'Herra', 'Goodwife', 'Goody', 'Widow',
  // professional / academic
  'Dr', 'Doctor', 'Professor', 'Prof', 'Dean', 'Rector', 'Provost', 'Warden', 'Chancellor',
  'Headmaster', 'Headmistress', 'Schoolmaster', 'Schoolmistress', 'Master', 'Mistress', 'Tutor',
  // civic
  'Mayor', 'Governor', 'President', 'Senator', 'Congressman', 'Congresswoman', 'Premier',
  'Minister', 'Secretary', 'Ambassador', 'Consul', 'Judge', 'Justice', 'Magistrate', 'Sheriff',
  'Deputy', 'Bailiff', 'Coroner', 'Clerk', 'Constable', 'Commissioner', 'Inspector', 'Detective',
  'Officer', 'Agent', 'Sergeant', 'Captain', 'Lieutenant', 'Commander', 'Major', 'Colonel',
  'General', 'Admiral', 'Commodore', 'Marshal', 'Private', 'Corporal', 'Skipper', 'Coach', 'Boss',
  'Foreman', 'Bo\'sun', 'Bosun', 'Chief',
  // clergy
  'Father', 'Mother', 'Sister', 'Brother', 'Reverend', 'Rev', 'Pastor', 'Deacon', 'Bishop',
  'Archbishop', 'Cardinal', 'Pope', 'Abbot', 'Abbess', 'Prior', 'Friar', 'Rabbi', 'Imam', 'Mullah',
  'Sheikh', 'Sheik', 'Swami', 'Guru', 'Pandit', 'Elder', 'Saint', 'St',
  // nobility
  'King', 'Queen', 'Prince', 'Princess', 'Duke', 'Duchess', 'Earl', 'Count', 'Countess', 'Baron',
  'Baroness', 'Marquis', 'Marquess', 'Marchioness', 'Viscount', 'Viscountess', 'Lord', 'Lady',
  'Sir', 'Dame', 'Emperor', 'Empress', 'Tsar', 'Czar', 'Tsarina', 'Kaiser', 'Sultan', 'Shah',
  'Khan', 'Emir', 'Pharaoh', 'Rajah', 'Maharaja', 'Maharani', 'Rani', 'Sultana', 'Sire', 'Grand Duke',
  'Grand Duchess',
  // family
  'Aunt', 'Auntie', 'Aunty', 'Uncle', 'Grandfather', 'Grandmother', 'Grandpa', 'Grandma',
  'Granddad', 'Grandad', 'Grannie', 'Granny', 'Nana', 'Nanna', 'Opa', 'Oma', 'Nonna', 'Nonno',
  'Abuela', 'Abuelo', 'Babushka', 'Dedushka', 'Baba', 'Papa', 'Mama', 'Mum', 'Mom', 'Dad', 'Poppa',
  'Cousin', 'Nurse', 'Matron', 'Madam', 'Madame', 'Dame',
];

export const HONORIFIC_SET: ReadonlySet<string> = new Set(HONORIFICS.map((h) => h.toLowerCase()));

/** Regex alternation for optional honorific prefix before a name ("Mr. " etc). */
export const TITLE_PREFIX: string = `(?:${HONORIFICS.join('|')})\\.?\\s+`;

/** "Queen Eleanor" / "Sir Gawain" — title treated as part of the name. */
export function isHonorific(word: string): boolean {
  return HONORIFIC_SET.has(word.toLowerCase().replace(/\.$/, ''));
}

// ---------- 4. name shapes ----------

/** Nobility/kinship prefixes that ARE the name ("Grandmother Willow"). */
export const KINSHIP_TITLES = 'Mother|Father|Mum|Mom|Dad|Papa|Mama|Grandmother|Grandma|Granny|Grannie|Nana|Grandfather|Grandpa|Granddad|Grandad|Aunt|Auntie|Aunty|Uncle|Cousin|Sister|Brother|Nurse|Matron|Cook|Elder';

/** Name particles that glue name parts together (lowercase in text). */
export const NAME_PARTICLES = 'van|von|der|den|de|del|della|delle|di|da|dos|dello|della|degli|delle|du|la|le|les|bin|ibn|bint|abu|umm|al|el|an|ben|bar|bat|ab|af|ap|mac|mc|fitz|san|santo|santa|ter|ter|van der|van den|van de|de la|de las|de los|of the|of';

/** A single capitalized name token: letters, apostrophes, hyphens (no digits,
 * no underscores — Gutenberg italics like _so_ and OCR junk stay out). */
export const NAME_TOKEN = String.raw`[A-Z][A-Za-z'’-]{1,24}`;

/** Full name: optional honorific, 1–3 capitalized tokens, lowercase particles allowed between. */
export const FULL_NAME_RE_SOURCE =
  `(?:${TITLE_PREFIX})?`
  + `${NAME_TOKEN}(?:\\s+(?:${NAME_PARTICLES})\\s+${NAME_TOKEN}|\\s+${NAME_TOKEN}){0,2}`;

// ---------- 5. quote scanner (multi-convention) ----------

export type QuoteConvention =
  | 'curly-double'   // “…”
  | 'straight-double' // "…"
  | 'curly-single'   // ‘…’
  | 'straight-single' // '…' (British — boundary-guarded)
  | 'guillemet'      // «…»
  | 'dash'           // —Bonjour! (paragraph-led)
  | 'colon'          // ELEANOR: Bonjour. (play format)
  | 'continued';     // continuation paragraph of an unclosed quote

export interface QuoteSpan {
  /** Offset of the opening delimiter within the scanned paragraph. */
  start: number;
  /** Offset one past the closing delimiter (or end of text when unclosed). */
  end: number;
  /** Speech text WITHOUT delimiters. */
  text: string;
  convention: QuoteConvention;
  /** Speech continues in the following paragraph (no closing delimiter found). */
  unclosed?: boolean;
}

const MAX_QUOTE_LEN = 2400;

interface ConventionPattern {
  convention: QuoteConvention;
  open: string;
  close: string;
  re: RegExp;
}

/** Order matters: curly variants before straight so “ and ” win when mixed. */
const PAIRED_CONVENTIONS: ConventionPattern[] = [
  { convention: 'curly-double', open: '“', close: '”', re: new RegExp(`“([^”\\n]{1,${MAX_QUOTE_LEN}})”`, 'g') },
  { convention: 'curly-single', open: '‘', close: '’', re: new RegExp(`‘([^’\\n]{1,${MAX_QUOTE_LEN}})’`, 'g') },
  { convention: 'guillemet', open: '«', close: '»', re: new RegExp(`«([^»\\n]{1,${MAX_QUOTE_LEN}})»`, 'g') },
];

const STRAIGHT_DOUBLE_RE = new RegExp(`"([^"\\n]{1,${MAX_QUOTE_LEN}})"`, 'g');

/** A closing straight single quote that ends a British-quoted span must be
 * followed by space/punctuation/end and the char before the opener must not
 * be a letter/digit/apostrophe context (else it's an apostrophe: "don't"). */
const STRAIGHT_SINGLE_RE = new RegExp(
  String.raw`(^|[{\[(\s—–\-,;:.!?…“”"'‘’])(‘|')([^'\n]{2,${MAX_QUOTE_LEN}})'(?=[\s.,;:!?…)\]}'”»—–-]|$)`,
  'g',
);

/** Paragraph-initial dash dialogue: —Speech here. / –Speech. */
const DASH_OPEN_RE = /^\s*[—–]\s*/;

/** Play / screenplay line: "ELEANOR: …" / "Eleanor: …" / "FIRST WITCH: …".
 * Exported for the attribution engine, which validates the label against the
 * roster before trusting it. */
export const PLAY_LINE_RE =
  /^\s*(?:([A-Z][A-Z0-9 .'’-]{1,38})|([A-Z][\w'’-]{1,20}(?:\s+[A-Z][\w'’-]{1,20}){0,2}))\s*:\s+(\S.*)$/;

export interface ScanQuotesOptions {
  /** Previous scan left an open speech that continues into this paragraph. */
  openConvention?: QuoteConvention | null;
}

/**
 * Multi-convention quote scanner for ONE paragraph.
 * - Paired curly / guillemet spans always detected.
 * - Straight doubles detected unless the paragraph leads with a dash.
 * - Straight singles (British) detected only when the paragraph has no
 *   double-quote spans (mixed books then treat ' as apostrophe safely).
 * - Dash paragraphs produce one dash span (speech to a trailing tag or end).
 * - Play/screenplay colon lines are detected by the attribution engine via
 *   PLAY_LINE_RE (they need roster validation, not the scanner).
 * - When `openConvention` is set and the paragraph does not start with an
 *   opener, everything before the first closer is a `continued` span.
 */
export function scanQuotes(paragraph: string, opts?: ScanQuotesOptions): QuoteSpan[] {
  const spans: QuoteSpan[] = [];
  const text = paragraph;

  // (a) continuation of an unclosed quote from the previous paragraph
  const openConv = opts?.openConvention ?? null;
  const startsWithOpener = /^[“"'‘«\s—–]/.test(text);
  if (openConv && !startsWithOpener) {
    const closer = openConv === 'straight-single' || openConv === 'curly-single'
      ? (openConv === 'straight-single' ? "'" : '’')
      : openConv === 'guillemet' ? '»'
        : openConv === 'straight-double' ? '"'
          : openConv === 'dash' ? null
            : '”';
    if (closer) {
      const closeIdx = text.indexOf(closer);
      if (closeIdx >= 0) {
        const speech = text.slice(0, closeIdx);
        if (speech.trim()) spans.push({ start: 0, end: closeIdx + 1, text: speech, convention: 'continued' });
      } else {
        // the whole paragraph is still the same speech — and stays open
        if (text.trim()) spans.push({ start: 0, end: text.length, text, convention: 'continued', unclosed: true });
        return spans;
      }
    }
    // fall through — the part after the closer is normal narration/quotes
    if (closer && text.slice(text.indexOf(closer) + 1).trim()) {
      const rest = text.slice(text.indexOf(closer) + 1);
      const restSpans = scanQuotes(rest, { openConvention: null });
      const shift = text.length - rest.length;
      for (const s of restSpans) spans.push({ ...s, start: s.start + shift, end: s.end + shift });
      return spans;
    }
    return spans;
  }

  // (b) dash-led dialogue paragraph
  const dashM = DASH_OPEN_RE.exec(text);
  if (dashM) {
    const speechStart = dashM[0].length;
    spans.push({ start: 0, end: text.length, text: text.slice(speechStart), convention: 'dash' });
    return spans;
  }

  // (c) paired conventions
  const takePaired = (pattern: ConventionPattern) => {
    pattern.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.re.exec(text))) {
      spans.push({ start: m.index, end: m.index + m[0].length, text: m[1] ?? '', convention: pattern.convention });
    }
  };
  for (const c of PAIRED_CONVENTIONS) takePaired(c);

  // (d) straight doubles — only when no curly double exists in the paragraph
  const hasCurlyDouble = spans.some((s) => s.convention === 'curly-double');
  if (!hasCurlyDouble) {
    STRAIGHT_DOUBLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STRAIGHT_DOUBLE_RE.exec(text))) {
      spans.push({ start: m.index, end: m.index + m[0].length, text: m[1] ?? '', convention: 'straight-double' });
    }
  }

  // (e) British straight singles — only when the paragraph has NO double quotes
  const hasDouble = spans.some((s) => s.convention === 'curly-double' || s.convention === 'straight-double');
  if (!hasDouble) {
    STRAIGHT_SINGLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STRAIGHT_SINGLE_RE.exec(text))) {
      const body = m[3] ?? '';
      // reject apostrophe false-positives: 'tis-like openers without content words are fine,
      // but possessive/contraction fragments like "n't" never appear here because the
      // boundary guard requires a preceding space/start.
      if (body.trim().length < 2) continue;
      if (!/[A-Za-z]/.test(body)) continue;
      const start = m.index + m[1].length;
      spans.push({ start, end: m.index + m[0].length, text: body, convention: 'straight-single' });
    }
  }

  // (f) unclosed-tail detection — a paragraph that OPENS a quote but never
  // closes it (the multi-paragraph speech convention: every paragraph of a
  // long speech opens without closing; only the last one closes). Scan the
  // tail after the last closed span for the LAST opener that has no closer
  // after it; everything from that opener is an unclosed speech span.
  {
    const lastClosedEnd = spans.length ? Math.max(...spans.map((sp) => sp.end)) : 0;
    const tail = text.slice(lastClosedEnd);
    if (tail.trim().length > 0) {
      const pairs: Array<[string, string, QuoteConvention]> = [
        ['“', '”', 'curly-double'],
        ['"', '"', 'straight-double'],
        ['‘', '’', 'curly-single'],
        ['«', '»', 'guillemet'],
      ];
      let best: { idx: number; conv: QuoteConvention; speech: string } | null = null;
      for (const [open, close, conv] of pairs) {
        const oi = tail.lastIndexOf(open);
        if (oi < 0) continue;
        const after = tail.slice(oi + 1);
        if (after.includes(close)) continue; // a closed pair — normal spans handle it
        if (!after.trim()) continue; // opener at the very end — no speech yet
        if (/["”’»“]/.test(after)) continue; // another convention's delimiter inside — risky
        if (!best || oi > best.idx) best = { idx: oi, conv, speech: after };
      }
      if (best) {
        spans.push({
          start: lastClosedEnd + best.idx,
          end: text.length,
          text: best.speech,
          convention: best.conv,
          unclosed: true,
        });
      }
    }
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  // drop nested/overlapping spans (inner quotes stay inside their parent's text)
  const cleaned: QuoteSpan[] = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start < lastEnd) continue;
    cleaned.push(s);
    lastEnd = s.end;
  }
  return cleaned;
}

// ---------- 6. epistolary signatures ----------

const SIGNATURE_RE = new RegExp(
  String.raw`\b(?:yours(?:\s+(?:sincerely|faithfully|truly|ever|always|affectionately|lovingly))?(?:,|;)?`
  + String.raw`|sincerely(?:\s+yours)?,?|faithfully\s+yours,?|with\s+(?:love|affection|regards|gratitude|respect),?`
  + String.raw`|love,?|regards,?|farewell,?|adieu,?|ever\s+yours,?|affectionately,?|gratefully,?|respectfully,?)`
  + String.raw`\s*(?:,|\n|\s)+`
  + String.raw`((?:${TITLE_PREFIX})?${NAME_TOKEN}(?:\s+${NAME_TOKEN}){0,2})\s*[.,!—–-]?\s*$`,
  'im',
);

/** Signature name at the very end of a letter/diary entry (last ~200 chars). */
export function letterSignature(text: string): string | null {
  const window = text.slice(-240);
  const m = SIGNATURE_RE.exec(window);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim();
  if (name.length < 3 || name.length > 40) return null;
  return name;
}

// ---------- 7. vocatives ----------

/**
 * Names a quote ADDRESSES (vocatives): "Eleanor, come here" / "Come here,
 * Eleanor!" / "You fool, Tomas!" — only roster names are considered so the
 * result is high-precision.
 */
export function vocativeNames(quoteText: string, roster: string[]): string[] {
  const found: string[] = [];
  for (const name of roster) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // "Name," at the very start, or ", Name!" / ", Name." / "! Name," mid/end
    const re = new RegExp(
      `^${esc}\\b\\s*[,.!?:—–-]`           // Eleanor, …
      + `|[,!?.]\\s*${esc}\\b\\s*[.!?:—–-]?\\s*$` // …, Eleanor!
      + `|[,!?.]\\s*${esc}\\b\\s*[,.!?:—–-]`,   // …, Eleanor, if you please
      'i',
    );
    if (re.test(quoteText)) found.push(name);
  }
  return found;
}

// ---------- 8. non-name filters ----------

/** Capitalized strings that are never character names (places, times, furniture of prose). */
export const NOT_A_NAME_WORDS: ReadonlySet<string> = new Set(
  (
    'i the a an and but or so then when while after before because that this these those there here ' + 'in on at it as is am be do go so no to of or if up us we he my me '
    + 'where what who why how yes no okay ok well oh ah now still just again he she it they we you '
    + 'his her their my your our its him them if else soon yet ever never always suddenly quietly '
    + 'slowly quickly finally meanwhile however therefore thus indeed perhaps maybe certainly '
    + 'chapter part page section act scene book prologue epilogue narrator god lord oh '
    + 'january february march april may june july august september october november december '
    + 'monday tuesday wednesday thursday friday saturday sunday easter christmas halloween '
    + 'mr mrs ms dr miss sir lady lord aunt uncle tomorrow tonight today yesterday '
    + 'morning evening afternoon night noon midnight dawn dusk day week month year hour minute '
    + 'monday tuesday england scotland wales ireland france germany italy spain europe america '
    + 'london paris rome venice florence naples berlin vienna madrid moscow petersburg york boston '
    + 'yorkshire devon cornwall kent essex sussex surrey oxford cambridge windsor bath edinburgh '
    + 'dublin glasgow india africa asia china japan egypt greece troy sparta athens '
    + 'god lord jesus christ joseph madonna saint satan devil heaven hell paradise '
    + 'school church hospital prison castle palace court kitchen garden forest sea ocean mountain '
    + 'street road lane house room door window table chair bed fire sun moon star sky earth '
    + 'monday easter sunday saturday exit stage left right entrance upstage downstage michaelmas ladyday midlent whitsun pentecost lammas martinmas '
    + 'nay both true pshaw humph marry hark alas hence thither anon methinks troth nothing something anything everything everyone someone anybody nobody somebody neither either none '
    + 'act scene prologue epilogue interlude curtain exeunt exit aside soliloquy '
    + 'note letter letter? chapter verse psalm gospel testament genesis exodus '
    + 'the but and however meanwhile suddenly finally at last then now when while '
  ).split(/\s+/),
);

/** Ordinary nouns that pass the capitalization test but are not characters
 * ("the Door swung open" — OCR-garbled or stylistic capitalization). */
export const COMMON_CAPITALIZED_NON_NAMES: ReadonlySet<string> = new Set(
  (
    'it he she they we you i god saturday sunday june july april march may august september october '
    + 'november december january february may day night morning evening summer winter autumn spring '
    + 'christmas easter birthday wedding funeral breakfast lunch dinner supper tea home work school '
    + 'station hotel inn house hall office shop street church captain-major general hospital '
    + 'doctor professor father mother uncle aunt sir madam mister mademoiselle monsieur '
    + 'the a an and or but if then else when while because although though since until unless '
    + 'yes no not so too very just only even still also again once twice never ever always '
    + 'oh ah eh um er well now then there here what who why how which whose when whom '
    + 'north south east west up down left right forward backward in out on off over under '
    + 'english french german spanish italian russian latin greek chinese indian african '
    + 'good bad great small big large little old young new long short high low first last next '
    + 'stop go come look listen wait hurry run walk sit stand give take bring send keep let done '
    + 'having remember forget know believe suppose imagine think declare hear seen gone made undoubtedly really except removed everybody yours mine hers ours theirs money niece nephew brother sister cousin friend husband wife widow courier sermons pamphlet novel volume edition chapter illustration illustrations list advertisement advertisements preface introduction dedication imprint publisher printed london paris ' 
    + 'please thank thanks hello hey hi goodbye farewell welcome sorry pardon excuse'
  ).split(/\s+/),
);
