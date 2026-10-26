import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, writeBatch } from 'firebase/firestore';
import fs from 'fs';
import Database from 'better-sqlite3';

const firebaseConfig = {
  apiKey: "AIzaSyC9D_8nq1xBv3NT5MVfSwihSIpsKHgibFQ",
  authDomain: "archery-league-f6c44.firebaseapp.com",
  projectId: "archery-league-f6c44",
  storageBucket: "archery-league-f6c44.firebasestorage.app",
  messagingSenderId: "621887643411",
  appId: "1:621887643411:web:f7489876b2702e2f12c4e6",
  measurementId: "G-FLYDD5NSE3"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Commit in chunks of up to 400 operations (Firestore limit is 500)
async function commitBatch(ops) {
  let batch = writeBatch(db);
  let count = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    batch.set(op.ref, op.data, { merge: true });
    count++;
    if (count === 400) {
      await batch.commit();
      batch = writeBatch(db);
      count = 0;
    }
  }
  if (count > 0) {
    await batch.commit();
  }
}

async function migrate() {
  console.log("=== Starting Migration to Firebase ===");

  // 1. Migrate data.json (Config, Archers/Roster, RSVPs)
  const dataRaw = fs.readFileSync('data.json', 'utf8');
  const data = JSON.parse(dataRaw);

  console.log("Migrating config & league state...");
  await setDoc(doc(db, "app_state", "current"), {
    config: data.config || {},
    upcomingSunday: "2026-11-01", // Upcoming Sunday
    event: {
      status: data.config?.defaultStatus || "PENDING",
      updatedAt: new Date().toISOString()
    }
  }, { merge: true });

  console.log(`Migrating ${data.archers.length} archers to 'roster'...`);
  const archerOps = [];
  for (const a of data.archers) {
    archerOps.push({
      ref: doc(db, "roster", a.name.toLowerCase().trim()),
      data: a
    });
  }
  await commitBatch(archerOps);

  console.log("Migrating RSVPs...");
  const rsvpOps = [];
  if (data.rsvps) {
    for (const [date, rsvpList] of Object.entries(data.rsvps)) {
      for (const r of rsvpList) {
        const id = `${date}_${r.archerName.toLowerCase().trim()}`;
        rsvpOps.push({
          ref: doc(db, "rsvps", id),
          data: {
            date,
            ...r
          }
        });
      }
    }
  }
  console.log(`Committing ${rsvpOps.length} RSVP records...`);
  await commitBatch(rsvpOps);

  // 2. Migrate from sqlite_dump.json
  console.log("Loading sqlite_dump.json...");
  const sqliteDump = JSON.parse(fs.readFileSync('sqlite_dump.json', 'utf8'));

  const events = sqliteDump.events;
  console.log(`Migrating ${events.length} scoring events...`);
  const eventOps = events.map(e => ({
    ref: doc(db, "scoring_events", e.id),
    data: e
  }));
  await commitBatch(eventOps);

  const participants = sqliteDump.participants;
  console.log(`Migrating ${participants.length} event participants...`);
  const partOps = participants.map(p => ({
    ref: doc(db, "event_participants", p.id),
    data: p
  }));
  await commitBatch(partOps);

  const ends = sqliteDump.ends;
  console.log(`Migrating ${ends.length} end scores (this may take a few seconds)...`);
  const endOps = ends.map(es => {
    let arrows = [];
    try {
      arrows = JSON.parse(es.arrows_json);
    } catch (e) {
      arrows = [];
    }
    return {
      ref: doc(db, "end_scores", es.id),
      data: {
        ...es,
        arrows
      }
    };
  });
  await commitBatch(endOps);

  console.log("=== Migration Completed Successfully! ===");
}

migrate().then(() => process.exit(0)).catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
