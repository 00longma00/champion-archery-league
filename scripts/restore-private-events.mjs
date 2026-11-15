// Bring back Private Hub sessions that were deleted (hidden with `deleted: true`).
// The Firestore rules never allow private scores to be truly deleted from the
// site, so a "delete" — by mistake or by someone else — only hides the session.
//
//   node scripts/restore-private-events.mjs                  # dry run: list hidden sessions
//   node scripts/restore-private-events.mjs --hub long_weijia  # only one hub
//   node scripts/restore-private-events.mjs --write          # restore them
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, updateDoc, query, where, deleteField } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyC9D_8nq1xBv3NT5MVfSwihSIpsKHgibFQ",
  authDomain: "archery-league-f6c44.firebaseapp.com",
  projectId: "archery-league-f6c44",
  storageBucket: "archery-league-f6c44.firebasestorage.app",
  messagingSenderId: "621887643411",
  appId: "1:621887643411:web:f7489876b2702e2f12c4e6"
};

const write = process.argv.includes('--write');
const hubArg = process.argv.indexOf('--hub');
const hub = hubArg > -1 ? process.argv[hubArg + 1] : null;
const db = getFirestore(initializeApp(firebaseConfig));

const q = hub
  ? query(collection(db, 'private_events'), where('deleted', '==', true), where('hub_id', '==', hub))
  : query(collection(db, 'private_events'), where('deleted', '==', true));
const snap = await getDocs(q);
for (const d of snap.docs) {
  const ev = d.data();
  console.log(`${d.id}  hub=${ev.hub_id}  ${ev.date}  "${ev.name}"  deleted ${ev.deleted_at || '?'}`);
  if (write) await updateDoc(doc(db, 'private_events', d.id), { deleted: deleteField(), deleted_at: deleteField() });
}
console.log(`${snap.size} hidden session(s) ${write ? 'restored' : 'found (dry run, pass --write to restore)'}.`);
process.exit(0);
