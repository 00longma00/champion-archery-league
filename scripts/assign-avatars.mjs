// One-time: give every archer on the roster a preset badge.
//   - Archers who already have a badge keep it.
//   - Otherwise they get back the badge they wore most recently in a league.
//   - Archers who never had one get a badge nobody wears yet (least-used once all 18
//     are taken), most recently active first. Only archers seen in the last 90 days
//     are given a new badge now; the rest get one when they next RSVP or shoot.
// Only the roster's `avatarId` field is written.
//
//   node scripts/assign-avatars.mjs           # dry run: print the plan
//   node scripts/assign-avatars.mjs --write   # apply it
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { archerDirectory } from '../archer-names.js';
import { planArcherAvatars, isPresetAvatar } from '../archer-avatars.js';

const firebaseConfig = {
  apiKey: "AIzaSyC9D_8nq1xBv3NT5MVfSwihSIpsKHgibFQ",
  authDomain: "archery-league-f6c44.firebaseapp.com",
  projectId: "archery-league-f6c44",
  storageBucket: "archery-league-f6c44.firebasestorage.app",
  messagingSenderId: "621887643411",
  appId: "1:621887643411:web:f7489876b2702e2f12c4e6"
};

const write = process.argv.includes('--write');
const db = getFirestore(initializeApp(firebaseConfig));

const [rosterSnap, partSnap, eventSnap] = await Promise.all([
  getDocs(collection(db, 'roster')),
  getDocs(collection(db, 'event_participants')),
  getDocs(collection(db, 'scoring_events'))
]);

const roster = rosterSnap.docs.map(d => ({ ...d.data(), id: d.id }));
archerDirectory.learn(roster);
const dates = Object.fromEntries(eventSnap.docs.map(d => [d.id, d.data().date || '']));
const pastEntries = partSnap.docs.map(d => {
  const p = d.data();
  return { name: p.name, avatar_id: p.avatar_id, date: dates[p.event_id] || '' };
});

const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const plan = planArcherAvatars({ roster, pastEntries, assignNewSince: since });

console.log(`${write ? 'Applying' : 'Dry run (pass --write to apply)'}: new badges only for archers seen since ${since}\n`);
let changes = 0;
const rows = [];
for (const r of roster) {
  const entry = plan.get(archerDirectory.key(r.name));
  const current = isPresetAvatar(r.avatarId) ? r.avatarId : null;
  const next = entry && entry.avatarId;
  let action = 'keep';
  if (!current && next) action = entry.source === 'previous' ? 'restore previous' : 'assign unused';
  else if (!current) action = 'wait (inactive)';
  rows.push({ name: archerDirectory.display(r.name), doc: r.id, current: r.avatarId || '-', badge: current || next || '-', action, lastSeen: (entry && entry.lastSeen) || '-' });
  if (!current && next) {
    changes++;
    if (write) await updateDoc(doc(db, 'roster', r.id), { avatarId: next });
  }
}
rows.sort((a, b) => a.action.localeCompare(b.action) || a.name.localeCompare(b.name));
console.table(rows);

const counts = {};
rows.forEach(r => { if (isPresetAvatar(r.badge)) counts[r.badge] = (counts[r.badge] || 0) + 1; });
const shared = Object.entries(counts).filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);
console.log(`\n${changes} roster ${changes === 1 ? 'entry' : 'entries'} ${write ? 'updated' : 'would be updated'}.`);
console.log(`Badges in use: ${Object.keys(counts).length} of 18${shared.length ? ` (shared: ${shared.join(', ')})` : ''}.`);
process.exit(0);
