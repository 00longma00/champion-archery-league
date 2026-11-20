// Which preset badge each archer wears (browser ES module, shared by the adapter,
// both pages and scripts/assign-avatars.mjs).
//
// Every archer keeps one badge: the one they picked, otherwise the one they used
// most recently in a league. Archers with no badge get one nobody uses yet, or
// a random least-used one once all 18 are taken.

import { archerDirectory } from './archer-names.js';

export const PRESET_AVATAR_IDS = [
  'tabby_cat', 'calico_cat', 'shiba_dog', 'husky_dog', 'golden_dog', 'shadow_cat',
  'corgi_dog', 'bengal_cat', 'devon_rex_cat', 'siamese_cat', 'maine_coon_cat', 'tuxedo_cat',
  'scottish_fold_cat', 'german_shepherd_dog', 'border_collie_dog', 'samoyed_dog', 'dachshund_dog', 'poodle_dog'
];

export function isPresetAvatar(id) {
  return PRESET_AVATAR_IDS.includes(id);
}

// A preset nobody (or the fewest archers) wears, picked at random among those tied,
// so new archers don't all start with the same badge. `random` returns [0, 1).
export function leastUsedAvatar(usedAvatarIds = [], random = Math.random) {
  const counts = new Map(PRESET_AVATAR_IDS.map(id => [id, 0]));
  usedAvatarIds.forEach(id => { if (counts.has(id)) counts.set(id, counts.get(id) + 1); });
  const fewest = Math.min(...counts.values());
  const candidates = PRESET_AVATAR_IDS.filter(id => counts.get(id) === fewest);
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
}

// Map of archer key -> preset badge from roster docs ({ name, avatarId }).
// Docs saved under another spelling of the same archer count too.
export function rosterAvatarsByArcher(rosterDocs = []) {
  const byKey = new Map();
  rosterDocs.forEach(r => {
    const key = archerDirectory.key(r && r.name);
    if (key && isPresetAvatar(r.avatarId) && !byKey.has(key)) byKey.set(key, r.avatarId);
  });
  return byKey;
}

/**
 * Plan a badge for every archer.
 *   roster:      [{ name, avatarId }]                 picked badges
 *   pastEntries: [{ name, avatar_id, date }]          league participants
 *   assignNewSince: 'YYYY-MM-DD' | null               only archers seen on/after this date
 *                                                     (or on the roster with no history) get a
 *                                                     new badge; null = everyone
 * Returns Map key -> { name, avatarId, source: 'picked' | 'previous' | 'assigned' | null, lastSeen }
 */
export function planArcherAvatars({ roster = [], pastEntries = [], assignNewSince = null } = {}) {
  const archers = new Map();
  const entry = (name) => {
    const full = archerDirectory.display(name);
    const key = archerDirectory.key(full);
    if (!key) return null;
    if (!archers.has(key)) archers.set(key, { name: full, picked: null, previous: null, previousDate: '', lastSeen: '' });
    return archers.get(key);
  };

  roster.forEach(r => {
    const a = entry(r && r.name);
    if (a && !a.picked && isPresetAvatar(r.avatarId)) a.picked = r.avatarId;
  });
  pastEntries.forEach(p => {
    const a = entry(p && p.name);
    if (!a) return;
    const date = String(p.date || '');
    if (date > a.lastSeen) a.lastSeen = date;
    if (isPresetAvatar(p.avatar_id) && date >= a.previousDate) {
      a.previous = p.avatar_id;
      a.previousDate = date;
    }
  });

  const plan = new Map();
  const used = [];
  for (const [key, a] of archers) {
    const avatarId = a.picked || a.previous || null;
    plan.set(key, { name: a.name, avatarId, source: a.picked ? 'picked' : a.previous ? 'previous' : null, lastSeen: a.lastSeen });
    if (avatarId) used.push(avatarId);
  }

  // Archers without a badge: most recently active first, so regulars get the unused ones.
  const waiting = Array.from(plan.entries())
    .filter(([, p]) => !p.avatarId && (!assignNewSince || !p.lastSeen || p.lastSeen >= assignNewSince))
    .sort(([, x], [, y]) => y.lastSeen.localeCompare(x.lastSeen) || x.name.localeCompare(y.name));
  for (const [, p] of waiting) {
    p.avatarId = leastUsedAvatar(used);
    p.source = 'assigned';
    used.push(p.avatarId);
  }
  return plan;
}
