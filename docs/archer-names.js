// One name per archer, shared by the Firebase adapter and both pages (browser ES module).
//
// Archers have been entered as short names ("Max"), full names ("Maxwell Shepherd")
// and typos ("Alex Grossmanx"). Saved scores keep whatever was typed, so every
// name is passed through the directory below on its way to the screen, and new
// saves use the full name. Unknown names are never guessed: they stay as typed,
// and the pages offer "Did you mean…?" suggestions instead.
//
// To link another name, add it to KNOWN_ARCHER_ALIASES, or give that archer's
// roster document in Firestore an `aliases` array (e.g. ["Sam"]).

export const KNOWN_ARCHER_ALIASES = [
  { name: 'Long Ma', aliases: ['Long'] },
  { name: 'Weijia Li', aliases: ['Weijia', 'Jiajia'] },
  { name: 'Alex Grossman', aliases: ['Alex', 'Alex Grossmanx'] },
  { name: 'Maxwell Shepherd', aliases: ['Max'] },
  { name: 'Ling Fang', aliases: ['Ling', 'Ling Fangng'] },
  { name: 'Xianchu Chen', aliases: ['Xianchu', 'Xianchuu'] },
  { name: 'Qihuan Aixinjueluo', aliases: ['Qihuan', 'Qihuanan'] },
  { name: 'TZ', aliases: [] },
  { name: 'Maginur Gilmitdinova', aliases: ['Magnur Gilmutdin'] },
  { name: 'Joy Lin', aliases: ['Joy'] }
];

// Trimmed, single-spaced, as typed otherwise.
export function cleanArcherName(name) {
  return String(name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

// Case-insensitive key used for every name comparison.
export function nameKey(name) {
  return cleanArcherName(name).toLowerCase();
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export class ArcherDirectory {
  constructor(entries = KNOWN_ARCHER_ALIASES) {
    this.byKey = new Map();      // any known key (full name or alias) -> full name
    this.aliasKeys = new Map();  // full-name key -> Set of every key that maps to it
    for (const e of entries) this.link(e.name, e.aliases);
  }

  // Declare `name` as an archer's full name, reachable from each of `aliases`.
  // A key that already belongs to an archer is never moved to another one.
  link(name, aliases = []) {
    const full = this.resolve(name) || cleanArcherName(name);
    const fullKey = nameKey(full);
    if (!fullKey) return null;
    if (!this.byKey.has(fullKey)) this.byKey.set(fullKey, full);
    if (!this.aliasKeys.has(fullKey)) this.aliasKeys.set(fullKey, new Set([fullKey]));
    for (const alias of Array.isArray(aliases) ? aliases : []) {
      const k = nameKey(alias);
      if (!k || this.byKey.has(k)) continue;
      this.byKey.set(k, full);
      this.aliasKeys.get(fullKey).add(k);
    }
    return full;
  }

  // Remember names seen in the roster or in past events, so they can be suggested.
  // Roster docs may carry an `aliases` array.
  learn(records = []) {
    for (const r of records) {
      if (typeof r === 'string') this.link(r);
      else if (r && r.name) this.link(r.name, r.aliases);
    }
  }

  // Full name for a known name or alias, otherwise null.
  resolve(name) {
    return this.byKey.get(nameKey(name)) || null;
  }

  // Name to show and save: the full name when known, otherwise the cleaned input.
  display(name) {
    return this.resolve(name) || cleanArcherName(name);
  }

  // Comparison key that is the same for every spelling of one archer.
  key(name) {
    return nameKey(this.display(name));
  }

  // Every key that refers to the same archer as `name` (for old data keyed by short names).
  keysFor(name) {
    const k = this.key(name);
    return Array.from(this.aliasKeys.get(k) || [k]);
  }

  // Full names of every archer the directory knows, sorted.
  names() {
    return Array.from(new Set(this.byKey.values())).sort((a, b) => a.localeCompare(b));
  }

  // "Did you mean…?" candidates for a name the directory doesn't know.
  suggest(name, limit = 3) {
    const typed = nameKey(name);
    if (typed.length < 2 || this.resolve(typed)) return [];
    const scored = new Map();
    for (const [k, full] of this.byKey) {
      const first = k.split(' ')[0];
      let score = null;
      if (first === typed) score = 0;                                  // "sam" -> "Sam Zhang"
      else if (typed.length >= 3 && k.startsWith(typed)) score = 1;    // "maxw" -> "Maxwell Shepherd"
      else if (typed.length >= 4) {
        const d = Math.min(editDistance(typed, k), editDistance(typed, first));
        if (d <= (typed.length >= 8 ? 2 : 1)) score = 1 + d;           // "jasn feng" / "maxwel"
      }
      if (score !== null && (!scored.has(full) || score < scored.get(full))) scored.set(full, score);
    }
    return Array.from(scored.entries())
      .filter(([full]) => nameKey(full) !== typed)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([full]) => full);
  }

  // Roster doc id to write for an archer: reuse an existing doc that belongs to
  // the same archer (e.g. "long" for Long Ma) so avatars and settings carry over.
  rosterDocId(name, rosterDocs = []) {
    const k = this.key(name);
    const existing = rosterDocs.find(r => r && (this.key(r.name) === k || this.key(r.id) === k));
    return existing ? existing.id : k;
  }
}

// Shared instance: the adapter teaches it the roster and past names as data loads.
export const archerDirectory = new ArcherDirectory();

export const displayArcherName = (name) => archerDirectory.display(name);
export const archerKey = (name) => archerDirectory.key(name);
