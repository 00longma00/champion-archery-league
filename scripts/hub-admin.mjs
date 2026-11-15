// Private Hub admin tasks.
//
//   node scripts/hub-admin.mjs migrate                       # dry run: show what would change
//   node scripts/hub-admin.mjs migrate --write               # secure every existing hub
//   node scripts/hub-admin.mjs reset <hub id> <new password> # forgotten password or lost phone
//
// migrate: run it with --write right BEFORE `firebase deploy --only firestore:rules`
// (and after the new site is live). For each hub it moves the old public
// password_hash into private_hub_keys/{hub} (as sha256, which nobody can read
// once the rules are deployed) and removes it from the hub. Owners keep their
// password; their next sign-in replaces this carried-over key with a new one.
//
// reset: makes a new salt and key for the hub and signs every device out. Once
// the rules are deployed the script can't write these, so it prints the three
// fields to set in the Firebase console (Firestore). It writes them itself
// only with --write before the rules are deployed, or against the emulator.
// The password ends up in your shell history; clear it if that matters.
//
// Emulator: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-archery node scripts/hub-admin.mjs ...
import { initializeApp } from 'firebase/app';
import {
  getFirestore, connectFirestoreEmulator, collection, getDocs, getDoc, doc, writeBatch, deleteField
} from 'firebase/firestore';
import { deriveHubKey, generateSaltHex, sha256Hex, HUB_KEY_VERSION } from '../hub-keys.js';

const firebaseConfig = {
  apiKey: "AIzaSyC9D_8nq1xBv3NT5MVfSwihSIpsKHgibFQ",
  authDomain: "archery-league-f6c44.firebaseapp.com",
  projectId: process.env.GCLOUD_PROJECT || "archery-league-f6c44",
  storageBucket: "archery-league-f6c44.firebasestorage.app",
  messagingSenderId: "621887643411",
  appId: "1:621887643411:web:f7489876b2702e2f12c4e6"
};

const PRIVATE_DATA = ['private_events', 'private_participants', 'private_groups', 'private_end_scores', 'private_league_notes'];

const args = process.argv.slice(2);
const command = args[0];
const write = args.includes('--write');
const db = getFirestore(initializeApp(firebaseConfig));
if (process.env.FIRESTORE_EMULATOR_HOST) {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(db, host, Number(port));
}

function isSecured(hub) {
  return typeof hub.generation === 'number';
}

function refused(err) {
  return err && err.code === 'permission-denied';
}

async function migrate() {
  console.log(`Project: ${firebaseConfig.projectId}${write ? '' : '  (dry run, pass --write to apply)'}`);
  const hubsSnap = await getDocs(collection(db, 'private_hubs'));
  const writable = new Set();
  let toSecure = 0;
  let noPassword = 0;

  for (const d of hubsSnap.docs) {
    const hub = d.data();
    const label = `${d.id} ("${hub.name || d.id}")`;
    if (isSecured(hub)) {
      console.log(`  ok        ${label}: already secured`);
      writable.add(d.id);
      continue;
    }
    if (typeof hub.password_hash !== 'string' || !/^[0-9a-f]{64}$/.test(hub.password_hash)) {
      console.log(`  NO PASSWORD ${label}: nobody can sign in. Set one with: node scripts/hub-admin.mjs reset ${d.id} <password>`);
      noPassword++;
      continue;
    }
    console.log(`  secure    ${label}`);
    toSecure++;
    writable.add(d.id);
    if (write) {
      const batch = writeBatch(db);
      batch.set(doc(db, 'private_hub_keys', d.id), { key_hash: await sha256Hex(hub.password_hash) });
      // key_version 1: the key is the old public hash, replaced on the next sign-in.
      batch.update(doc(db, 'private_hubs', d.id), { generation: 1, key_version: 1, password_hash: deleteField() });
      await batch.commit();
    }
  }

  // Data that no secured hub owns can't be changed once the rules are deployed.
  for (const name of PRIVATE_DATA) {
    const snap = await getDocs(collection(db, name));
    const stranded = snap.docs.filter(d => !writable.has(d.data().hub_id));
    if (stranded.length > 0) {
      const ids = stranded.slice(0, 5).map(d => `${d.id}${d.data().hub_id ? ` (hub ${d.data().hub_id})` : ' (no hub_id)'}`);
      console.log(`  read-only ${name}: ${stranded.length} of ${snap.size} docs belong to no secured hub, e.g. ${ids.join(', ')}`);
    }
  }

  console.log(`${toSecure} hub(s) ${write ? 'secured' : 'to secure'}, ${noPassword} without a password, ${hubsSnap.size} in total.`);
  if (write) console.log('Now deploy the rules straight away: firebase deploy --only firestore:rules');
}

async function reset(hubId, password) {
  if (!hubId || !password) {
    console.error('Usage: node scripts/hub-admin.mjs reset <hub id> <new password> [--write]');
    process.exit(1);
  }
  const snap = await getDoc(doc(db, 'private_hubs', hubId));
  if (!snap.exists()) {
    console.error(`No hub with id "${hubId}". Hub ids are the document ids in private_hubs.`);
    process.exit(1);
  }
  const hub = snap.data();
  const generation = isSecured(hub) ? hub.generation + 1 : 1;
  const salt = generateSaltHex();
  const keyHash = await sha256Hex(await deriveHubKey(password, salt));

  console.log(`New password for ${hubId} ("${hub.name || hubId}"). Every device will need to sign in with it.`);
  console.log('In the Firebase console > Firestore Database, set:');
  console.log(`  private_hubs/${hubId}:      salt = "${salt}" (string), generation = ${generation} (number), key_version = ${HUB_KEY_VERSION} (number)`);
  if ('password_hash' in hub) console.log(`  private_hubs/${hubId}:      delete the field password_hash`);
  console.log(`  private_hub_keys/${hubId}:  key_hash = "${keyHash}" (string; create the document if it's missing)`);

  if (!write) return;
  const batch = writeBatch(db);
  batch.update(doc(db, 'private_hubs', hubId), {
    salt, generation, key_version: HUB_KEY_VERSION, password_hash: deleteField(), updated_at: new Date().toISOString()
  });
  batch.set(doc(db, 'private_hub_keys', hubId), { key_hash: keyHash });
  await batch.commit();
  console.log('Written.');
}

try {
  if (command === 'migrate') await migrate();
  else if (command === 'reset') await reset(args[1], args[2]);
  else {
    console.error('Usage: node scripts/hub-admin.mjs migrate [--write] | reset <hub id> <new password> [--write]');
    process.exit(1);
  }
} catch (err) {
  if (refused(err) && command === 'reset') {
    console.error('Firestore refused the write: the new rules are already deployed. Make the console edits printed above instead.');
  } else if (refused(err)) {
    console.error('Firestore refused the write: the new rules are already deployed, so migrate can no longer run.');
    console.error('Deploy the previous firestore.rules for a moment, run migrate --write, then deploy the new rules again.');
  } else {
    console.error(err);
  }
  process.exit(1);
}
process.exit(0);
