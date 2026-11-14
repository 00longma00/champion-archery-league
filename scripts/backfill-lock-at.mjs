// One-time backfill: add `lock_at` to every league scoring event.
// Run this BEFORE deploying firestore.rules — the rules treat events without
// lock_at as locked, and once deployed they block updates to locked events.
//
// lock_at is computed in the machine's local time zone, so set TZ to the
// league's zone:
//   TZ=America/Los_Angeles node scripts/backfill-lock-at.mjs           # dry run
//   TZ=America/Los_Angeles node scripts/backfill-lock-at.mjs --write   # apply
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { computeEventLockStatus } from '../event-lock.js';

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

console.log(`Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}${write ? '' : '  (dry run, pass --write to apply)'}`);
const snap = await getDocs(collection(db, 'scoring_events'));
let changed = 0;
for (const d of snap.docs) {
  const ev = d.data();
  const info = computeEventLockStatus(ev.date, ev.start_time || '18:00');
  const lockAt = new Date(info.lock_deadline_iso);
  const existing = ev.lock_at && typeof ev.lock_at.toDate === 'function' ? ev.lock_at.toDate() : null;
  if (existing && existing.getTime() === lockAt.getTime()) continue;
  console.log(`${d.id}  ${ev.date} ${ev.start_time || '18:00'}  -> lock_at ${lockAt.toISOString()}${info.is_locked ? '  (locked)' : ''}`);
  if (write) await updateDoc(doc(db, 'scoring_events', d.id), { lock_at: lockAt });
  changed++;
}
console.log(`${changed} of ${snap.size} events ${write ? 'updated' : 'need lock_at'}.`);
process.exit(0);
