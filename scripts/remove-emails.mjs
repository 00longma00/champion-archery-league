// One-time cleanup: delete stored `email` / `remindMe` fields from Firestore.
// Email reminders are no longer used, and these collections are publicly readable.
//
//   node scripts/remove-emails.mjs           # dry run: lists what would change
//   node scripts/remove-emails.mjs --write   # delete the fields
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, updateDoc, deleteField } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyC9D_8nq1xBv3NT5MVfSwihSIpsKHgibFQ",
  authDomain: "archery-league-f6c44.firebaseapp.com",
  projectId: "archery-league-f6c44",
  storageBucket: "archery-league-f6c44.firebasestorage.app",
  messagingSenderId: "621887643411",
  appId: "1:621887643411:web:f7489876b2702e2f12c4e6"
};

const FIELDS = ['email', 'remindMe'];
const COLLECTIONS = ['roster', 'rsvps'];
const write = process.argv.includes('--write');
const db = getFirestore(initializeApp(firebaseConfig));

let total = 0;
for (const name of COLLECTIONS) {
  const snap = await getDocs(collection(db, name));
  for (const d of snap.docs) {
    const data = d.data();
    const present = FIELDS.filter(f => f in data);
    if (present.length === 0) continue;
    const hadEmail = typeof data.email === 'string' && data.email.trim() !== '';
    console.log(`${name}/${d.id}: ${present.join(', ')}${hadEmail ? ' (has an address)' : ''}`);
    if (write) await updateDoc(d.ref, Object.fromEntries(present.map(f => [f, deleteField()])));
    total++;
  }
}
console.log(`${total} document(s) ${write ? 'cleaned' : 'would be cleaned (dry run, pass --write to apply)'}.`);
process.exit(0);
