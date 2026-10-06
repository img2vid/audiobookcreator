/**
 * Pronunciation lexicon — a global, user-editable pronunciation dictionary.
 *
 * Rules map a written word/phrase to a speakable replacement ("Kubernetes" →
 * "koo-ber-net-eez"). Replacements respect word boundaries, preserve capital-
 * ization style of the source token, and are applied before synthesis in every
 * module (TTS Studio, Audiobook Studio, Dialogue Studio).
 *
 * The lexicon persists in localStorage so a rule added once works everywhere.
 * Import/export uses a simple `find => replace` line format (one rule per
 * line, `#` comments allowed) — compatible with common lexicon conventions.
 */

export interface LexiconRule {
  id: string;
  find: string;
  replace: string;
  enabled: boolean;
}

const STORAGE_KEY = 'auravoice-lexicon-v1';

// ---------- built-in presets ----------

export interface LexiconPreset {
  id: string;
  name: string;
  description: string;
  rules: [find: string, replace: string][];
}

export const LEXICON_PRESETS: LexiconPreset[] = [
  {
    id: 'tech',
    name: 'Tech terms',
    description: 'Common developer/infrastructure words read correctly.',
    rules: [
      ['Kubernetes', 'koo-ber-net-eez'],
      ['GNOME', 'guh-nome'],
      ['Linux', 'linn-ucks'],
      ['nginx', 'engine-x'],
      ['SQLite', 'S-Q-Lite'],
      ['PostgreSQL', 'post-gress'],
      ['GitHub', 'git-hub'],
      ['NuGet', 'new-get'],
      ['i18n', 'i-eighteen-n'],
      ['l10n', 'l-ten-n'],
      ['OAuth', 'oh-auth'],
      ['DevOps', 'dev-ops'],
      ['CI/CD', 'C-I C-D'],
      ['APIs', 'A-P-eyes'],
      ['GUI', 'gooey'],
      ['CLI', 'C-L-I'],
      ['RAM', 'ram'],
      ['BIOS', 'by-oss'],
      ['cache', 'cash'],
      ['cached', 'cashed'],
      ['tuple', 'too-pul'],
      ['daemon', 'demon'],
      ['sudo', 'soo-doo'],
      ['vim', 'vim'],
      ['wxWidgets', 'wix-widgets'],
    ],
  },
  {
    id: 'ai',
    name: 'AI & models',
    description: 'Model and lab names the letter-reader would butcher.',
    rules: [
      ['GPT', 'G-P-T'],
      ['LLM', 'L-L-M'],
      ['LLMs', 'L-L-Ms'],
      ['TTS', 'T-T-S'],
      ['ASR', 'A-S-R'],
      ['OCR', 'O-C-R'],
      ['SSML', 'S-S-M-L'],
      ['OpenAI', 'open-A-I'],
      ['ChatGPT', 'chat-G-P-T'],
      ['Claude', 'clawed'],
      ['Anthropic', 'an-throp-ic'],
      ['xAI', 'x-A-I'],
      ['RAG', 'rag'],
      ['AGI', 'A-G-I'],
      ['NLP', 'N-L-P'],
      ['GPU', 'G-P-U'],
      ['CUDA', 'koo-da'],
      ['TensorFlow', 'tensor-flow'],
      ['PyTorch', 'pie-torch'],
    ],
  },
  {
    id: 'fantasy',
    name: 'Fantasy names',
    description: 'Gentle respellings for invented names in fiction.',
    rules: [
      ['Niamh', 'Neeve'],
      ['Siobhan', 'Shi-vawn'],
      ['Caoimhe', 'Kee-va'],
      ['Tadgh', 'Tige'],
      ['Eowyn', 'Ay-oh-win'],
      ['Sauron', 'Sow-ron'],
      ['Belerion', 'Beh-lair-ee-on'],
      ['Aerith', 'Air-ith'],
      ['Zephyrion', 'Zef-eer-ee-on'],
      ['Lyralei', 'Leer-ah-lay'],
      ['Kaerith', 'Kye-rith'],
      ['Solveig', 'Sohl-vay'],
    ],
  },
  {
    id: 'british',
    name: 'Everyday fixes',
    description: 'Words whose letter-by-letter reading needs a nudge.',
    rules: [
      ['colonel', 'kernel'],
      ['lieutenant', 'left-tenant'],
      ['Worcestershire', 'wus-ter-shure'],
      ['Leicester', 'les-ter'],
      ['Reading', 'red-ding'],
      ['thought', 'thawt'],
      ['enough', 'e-nuf'],
      ['queue', 'cue'],
      ['queuing', 'cue-ing'],
      ['recipe', 'ress-uh-pee'],
      ['salmon', 'sam-un'],
      ['island', 'eye-land'],
      ['height', 'hite'],
      ['Tuesday', 'tooze-day'],
    ],
  },
];

// ---------- persistence ----------

export function loadLexicon(): LexiconRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LexiconRule[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && typeof r.find === 'string' && typeof r.replace === 'string')
      .map((r, i) => ({ id: r.id || `lex-${i}`, find: r.find, replace: r.replace, enabled: r.enabled !== false }));
  } catch {
    return [];
  }
}

export function saveLexicon(rules: LexiconRule[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch { /* storage full or unavailable — session-only then */ }
}

// ---------- text format (import / export) ----------

/** Parse `find => replace` lines. Also accepts `find, replace` and TSV. */
export function parseLexiconText(text: string): LexiconRule[] {
  const rules: LexiconRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const m = /^(.+?)\s*(?:=>|->|,|\t)\s*(.+)$/.exec(line);
    if (!m) continue;
    const find = m[1].trim();
    const replace = m[2].trim();
    if (find && replace) rules.push({ id: `lex-${Date.now().toString(36)}-${rules.length}`, find, replace, enabled: true });
  }
  return rules;
}

export function serializeLexicon(rules: LexiconRule[]): string {
  const lines = [
    '# AuraVoice pronunciation lexicon — one rule per line: find => replace',
    ...rules.map((r) => `${r.find} => ${r.replace}`),
  ];
  return lines.join('\n');
}

// ---------- application ----------

function matchCaseOf(source: string, replacement: string): string {
  if (!source || !replacement) return replacement;
  const isUpper = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();
  const isCapitalized = (s: string) => /^[A-Z]/.test(s) && s.slice(1) === s.slice(1).toLowerCase();
  if (isUpper(source) && source.length > 1) return replacement.toUpperCase();
  if (isCapitalized(source)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

export interface LexiconReport {
  text: string;
  substitutions: number;
  applied: string[];
}

/**
 * Apply lexicon rules to text. Word-boundary safe, longest-find-first so
 * "PostgreSQL" wins over "SQL". Case is preserved stylistically.
 */
export function applyLexicon(input: string, rules: LexiconRule[]): LexiconReport {
  const active = rules
    .filter((r) => r.enabled && r.find.trim())
    .sort((a, b) => b.find.length - a.find.length);
  if (!active.length || !input) return { text: input, substitutions: 0, applied: [] };

  // Build one pass with alternation so overlapping rules behave predictably.
  const escaped = active.map((r) => ({ rule: r, re: r.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }));
  const master = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.map((e) => `(${e.re})`).join('|')})(?![\\p{L}\\p{N}])`, 'giu');

  let substitutions = 0;
  const applied = new Set<string>();
  const text = input.replace(master, (match, ...groups) => {
    // the first defined capture group tells us which rule matched
    let idx = -1;
    for (let i = 0; i < groups.length - 2; i++) {
      if (groups[i] !== undefined) { idx = i; break; }
    }
    if (idx === -1 || idx >= escaped.length) return match;
    const rule = escaped[idx].rule;
    substitutions++;
    applied.add(rule.find);
    return matchCaseOf(match, rule.replace);
  });

  return { text, substitutions, applied: [...applied] };
}

/** Escape a find string for literal display. */
export function countPotentialMatches(text: string, rules: LexiconRule[]): number {
  if (!text) return 0;
  return applyLexicon(text, rules).substitutions;
}

/** Merge imported rules, skipping exact duplicates of existing finds. */
export function mergeLexicon(existing: LexiconRule[], incoming: LexiconRule[]): { rules: LexiconRule[]; added: number } {
  const seen = new Set(existing.map((r) => r.find.toLowerCase()));
  const fresh = incoming.filter((r) => {
    const key = r.find.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { rules: [...existing, ...fresh], added: fresh.length };
}
