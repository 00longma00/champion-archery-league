import test, { before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc, writeBatch } from 'firebase/firestore';
import crypto from 'node:crypto';

const RULES = process.env.RULES || new URL('../../firestore.rules', import.meta.url).pathname;
let env, db;
const H = 3600e3;
const day = (offsetDays) => new Date(Date.now() + offsetDays * 86400e3).toISOString().slice(0, 10);

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-archery', firestore: { rules: fs.readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8080 } });
  db = env.unauthenticatedContext().firestore();
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const a = ctx.firestore();
    // open: started 1h ago, locks in 7h
    await setDoc(doc(a, 'scoring_events/open'), { id: 'open', date: day(0), start_time: '18:00', status: 'SETUP', lock_at: new Date(Date.now() + 7 * H) });
    // last week, never marked COMPLETED
    await setDoc(doc(a, 'scoring_events/past'), { id: 'past', date: day(-6), start_time: '18:00', status: 'ON', lock_at: new Date(Date.now() - 5 * 86400e3) });
    await setDoc(doc(a, 'scoring_events/legacy'), { id: 'legacy', date: day(0), start_time: '18:00', status: 'SETUP' });
    await setDoc(doc(a, 'scoring_events/done'), { id: 'done', date: day(0), status: 'COMPLETED', lock_at: new Date(Date.now() + 7 * H) });
    for (const e of ['open', 'past', 'legacy', 'done']) {
      await setDoc(doc(a, `end_scores/s_${e}`), { event_id: e, end_total: 20 });
      await setDoc(doc(a, `event_participants/p_${e}`), { event_id: e, name: 'A' });
      await setDoc(doc(a, `scoring_groups/g_${e}`), { event_id: e, current_end: 1 });
    }
  });
});

test('reads stay open', async () => {
  await assertSucceeds(getDoc(doc(db, 'scoring_events/past')));
  await assertSucceeds(getDoc(doc(db, 'end_scores/s_past')));
});
test('open event: scores, participants, groups writable', async () => {
  await assertSucceeds(setDoc(doc(db, 'end_scores/new'), { event_id: 'open', end_total: 30 }));
  await assertSucceeds(updateDoc(doc(db, 'end_scores/s_open'), { end_total: 25 }));
  await assertSucceeds(updateDoc(doc(db, 'event_participants/p_open'), { name: 'B' }));
  await assertSucceeds(updateDoc(doc(db, 'scoring_groups/g_open'), { current_end: 2 }));
  await assertSucceeds(updateDoc(doc(db, 'scoring_events/open'), { status: 'ON' }));
  await assertSucceeds(updateDoc(doc(db, 'scoring_events/open'), { status: 'COMPLETED' }));
});
for (const e of ['past', 'legacy', 'done']) {
  test(`${e} event: everything frozen`, async () => {
    await assertFails(setDoc(doc(db, 'end_scores/new'), { event_id: e, end_total: 30 }));
    await assertFails(updateDoc(doc(db, `end_scores/s_${e}`), { end_total: 30 }));
    await assertFails(deleteDoc(doc(db, `end_scores/s_${e}`)));
    await assertFails(updateDoc(doc(db, `event_participants/p_${e}`), { name: 'B' }));
    await assertFails(setDoc(doc(db, 'event_participants/new'), { event_id: e }));
    await assertFails(updateDoc(doc(db, `scoring_groups/g_${e}`), { current_end: 9 }));
    await assertFails(updateDoc(doc(db, `scoring_events/${e}`), { status: 'SETUP' }));
    await assertFails(updateDoc(doc(db, `scoring_events/${e}`), { lock_at: new Date(Date.now() + 9e9) }));
    await assertFails(deleteDoc(doc(db, `scoring_events/${e}`)));
  });
}
test('cannot move a score from a locked event onto an open one', async () => {
  await assertFails(updateDoc(doc(db, 'end_scores/s_past'), { event_id: 'open' }));
});
test('lock_at cannot be pushed far past the event date', async () => {
  await assertFails(updateDoc(doc(db, 'scoring_events/open'), { lock_at: new Date(Date.now() + 30 * 86400e3) }));
  await assertFails(updateDoc(doc(db, 'scoring_events/open'), { lock_at: 'never' }));
  await assertSucceeds(updateDoc(doc(db, 'scoring_events/open'), { start_time: '19:00', lock_at: new Date(Date.now() + 8 * H) }));
});
test('create event: needs valid future lock_at', async () => {
  await assertSucceeds(setDoc(doc(db, 'scoring_events/n1'), { date: day(1), start_time: '18:00', status: 'SETUP', lock_at: new Date(Date.now() + 30 * H) }));
  await assertFails(setDoc(doc(db, 'scoring_events/n2'), { date: day(1), start_time: '18:00', status: 'SETUP' }));
  await assertFails(setDoc(doc(db, 'scoring_events/n3'), { date: day(-3), start_time: '18:00', status: 'SETUP', lock_at: new Date(Date.now() - 2 * 86400e3) }));
});
test('deleting an open event then its orphaned children works', async () => {
  await assertSucceeds(deleteDoc(doc(db, 'scoring_events/open')));
  await assertSucceeds(deleteDoc(doc(db, 'event_participants/p_open')));
  await assertSucceeds(deleteDoc(doc(db, 'scoring_groups/g_open')));
  await assertSucceeds(deleteDoc(doc(db, 'end_scores/s_open')));
});
test('other collections unchanged (open)', async () => {
  for (const c of ['app_state', 'rsvps', 'roster', 'feedback']) {
    await assertSucceeds(setDoc(doc(db, `${c}/x`), { a: 1 }));
    await assertSucceeds(deleteDoc(doc(db, `${c}/x`)));
  }
});

// ---------- private hub ----------

const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const KEY = 'a1'.repeat(32);      // what PBKDF2(password, salt) gives the owner
const KEY2 = 'b2'.repeat(32);     // after the key is rotated
const MKEY = 'c3'.repeat(32);     // mallory's own hub
const as = (uid) => env.authenticatedContext(uid).firestore();

async function seedHubs() {
  await env.withSecurityRulesDisabled(async ctx => {
    const a = ctx.firestore();
    await setDoc(doc(a, 'private_hubs/h1'), { id: 'h1', name: 'H1', salt: 's1', generation: 1, key_version: 2, linked_archers: ['A'], passkeys: [] });
    await setDoc(doc(a, 'private_hub_keys/h1'), { key_hash: sha(KEY) });
    await setDoc(doc(a, 'private_hub_keys/h1/members/alice'), { key: KEY, generation: 1 });
    await setDoc(doc(a, 'private_hubs/h2'), { id: 'h2', name: 'H2', salt: 's2', generation: 1, key_version: 2 });
    await setDoc(doc(a, 'private_hub_keys/h2'), { key_hash: sha(MKEY) });
    await setDoc(doc(a, 'private_hub_keys/h2/members/mallory'), { key: MKEY, generation: 1 });
    // a hub from before the migration: never secured, no key
    await setDoc(doc(a, 'private_hubs/legacy'), { id: 'legacy', name: 'Legacy', salt: 's3', password_hash: 'x' });
    await setDoc(doc(a, 'private_events/e1'), { id: 'e1', hub_id: 'h1', name: 'Practice' });
    await setDoc(doc(a, 'private_end_scores/s1'), { hub_id: 'h1', event_id: 'e1', end_total: 27 });
    await setDoc(doc(a, 'private_participants/p1'), { hub_id: 'h1', event_id: 'e1', name: 'A', archer_notes: '' });
    await setDoc(doc(a, 'private_groups/g1'), { hub_id: 'h1', event_id: 'e1', current_end: 1 });
    await setDoc(doc(a, 'private_league_notes/h1_ev_a'), { hub_id: 'h1', league_event_id: 'ev', archer_notes: 'x' });
    await setDoc(doc(a, 'private_end_scores/nohub'), { event_id: 'e1', end_total: 10 });
  });
}

const h1Docs = ['private_events/e1', 'private_end_scores/s1', 'private_participants/p1', 'private_groups/g1', 'private_league_notes/h1_ev_a'];

test('private: data stays readable, the key hash never is', async () => {
  await seedHubs();
  for (const p of h1Docs) await assertSucceeds(getDoc(doc(db, p)));
  await assertSucceeds(getDoc(doc(db, 'private_hubs/h1')));
  await assertFails(getDoc(doc(db, 'private_hub_keys/h1')));
  await assertFails(getDoc(doc(as('alice'), 'private_hub_keys/h1')));
  await assertSucceeds(getDoc(doc(as('alice'), 'private_hub_keys/h1/members/alice')));
  await assertFails(getDoc(doc(as('bob'), 'private_hub_keys/h1/members/alice')));
});

for (const [who, ctx] of [['signed-out visitor', () => db], ['signed-in non-member', () => as('bob')], ['member of another hub', () => as('mallory')]]) {
  test(`private: ${who} cannot change or delete a hub's data`, async () => {
    await seedHubs();
    const d = ctx();
    for (const p of h1Docs) {
      await assertFails(deleteDoc(doc(d, p)));
      await assertFails(updateDoc(doc(d, p), { archer_notes: 'wiped', end_total: 0 }));
    }
    await assertFails(setDoc(doc(d, 'private_events/new'), { hub_id: 'h1', name: 'X' }));
    await assertFails(setDoc(doc(d, 'private_end_scores/new'), { hub_id: 'h1', event_id: 'e1', end_total: 0 }));
    await assertFails(updateDoc(doc(d, 'private_hubs/h1'), { linked_archers: [] }));
    await assertFails(deleteDoc(doc(d, 'private_hubs/h1')));
    await assertFails(setDoc(doc(d, 'private_hub_keys/h1'), { key_hash: sha('evil') }));
    await assertFails(deleteDoc(doc(d, 'private_hub_keys/h1/members/alice')));
  });
}

test('private: member can create, edit and delete anything in their hub', async () => {
  await seedHubs();
  const d = as('alice');
  await assertSucceeds(setDoc(doc(d, 'private_events/e2'), { id: 'e2', hub_id: 'h1', name: 'New' }));
  await assertSucceeds(setDoc(doc(d, 'private_groups/g2'), { hub_id: 'h1', event_id: 'e2' }));
  await assertSucceeds(setDoc(doc(d, 'private_participants/p2'), { hub_id: 'h1', event_id: 'e2', name: 'A' }));
  await assertSucceeds(setDoc(doc(d, 'private_end_scores/s2'), { hub_id: 'h1', event_id: 'e2', end_total: 30 }));
  await assertSucceeds(setDoc(doc(d, 'private_end_scores/s2'), { hub_id: 'h1', event_id: 'e2', end_total: 29 }, { merge: true }));
  await assertSucceeds(updateDoc(doc(d, 'private_end_scores/s1'), { end_total: 0 }));
  await assertSucceeds(updateDoc(doc(d, 'private_events/e1'), { name: 'Renamed', updated_at: 'now' }));
  await assertSucceeds(setDoc(doc(d, 'private_league_notes/h1_ev2_a'), { hub_id: 'h1', archer_notes: 'y' }, { merge: true }));
  await assertSucceeds(updateDoc(doc(d, 'private_hubs/h1'), { linked_archers: ['A', 'B'], passkeys: [{ id: 'k' }], updated_at: 'now' }));
  // delete a session the way the app does: session first, then its children
  await assertSucceeds(deleteDoc(doc(d, 'private_events/e1')));
  for (const p of ['private_end_scores/s1', 'private_participants/p1', 'private_groups/g1', 'private_league_notes/h1_ev_a']) {
    await assertSucceeds(deleteDoc(doc(d, p)));
  }
});

test('private: members cannot move or plant documents across hubs', async () => {
  await seedHubs();
  await assertFails(updateDoc(doc(as('alice'), 'private_end_scores/s1'), { hub_id: 'h2' }));
  await assertFails(updateDoc(doc(as('alice'), 'private_end_scores/s1'), { event_id: 'other' }));
  // mallory, member of h2, tags a score with her own hub inside alice's session
  await assertFails(setDoc(doc(as('mallory'), 'private_end_scores/scr_e1_p1_r1_e9'), { hub_id: 'h2', event_id: 'e1', end_total: 0 }));
  await assertFails(setDoc(doc(as('mallory'), 'private_participants/p_e1_9'), { hub_id: 'h2', event_id: 'e1', name: 'X' }));
  await assertFails(setDoc(doc(as('mallory'), 'private_league_notes/h1_ev3_a'), { hub_id: 'h2', archer_notes: 'x' }));
  await assertSucceeds(setDoc(doc(as('mallory'), 'private_league_notes/h2_ev3_a'), { hub_id: 'h2', archer_notes: 'x' }));
  // and a score needs an existing session of that hub
  await assertFails(setDoc(doc(as('alice'), 'private_end_scores/orphan'), { hub_id: 'h1', event_id: 'missing', end_total: 1 }));
});

test('private: legacy documents without hub_id are read-only', async () => {
  await seedHubs();
  await assertFails(updateDoc(doc(as('alice'), 'private_end_scores/nohub'), { end_total: 0 }));
  await assertFails(deleteDoc(doc(as('alice'), 'private_end_scores/nohub')));
});

test('private: registering a device needs the right key and current generation', async () => {
  await seedHubs();
  const d = as('bob');
  await assertFails(setDoc(doc(d, 'private_hub_keys/h1/members/bob'), { key: 'wrong', generation: 1 }));
  await assertFails(setDoc(doc(d, 'private_hub_keys/h1/members/bob'), { key: sha(KEY), generation: 1 })); // the public hash is not the key
  await assertFails(setDoc(doc(d, 'private_hub_keys/h1/members/bob'), { key: KEY, generation: 0 }));
  await assertFails(setDoc(doc(d, 'private_hub_keys/h1/members/carol'), { key: KEY, generation: 1 })); // someone else's slot
  await assertFails(setDoc(doc(d, 'private_hub_keys/h1/members/bob'), { key: KEY, generation: 1, admin: true }));
  await assertFails(setDoc(doc(db, 'private_hub_keys/h1/members/bob'), { key: KEY, generation: 1 })); // signed out
  await assertSucceeds(setDoc(doc(d, 'private_hub_keys/h1/members/bob'), { key: KEY, generation: 1, registered_at: 'now' }));
  await assertSucceeds(updateDoc(doc(d, 'private_end_scores/s1'), { end_total: 28 }));
  // lock: removing its own registration takes the access away again
  await assertSucceeds(deleteDoc(doc(d, 'private_hub_keys/h1/members/bob')));
  await assertFails(updateDoc(doc(d, 'private_end_scores/s1'), { end_total: 28 }));
});

test('private: hubs without a key (not migrated) cannot be written or claimed', async () => {
  await seedHubs();
  const d = as('bob');
  await assertFails(updateDoc(doc(d, 'private_hubs/legacy'), { name: 'Mine' }));
  await assertFails(setDoc(doc(d, 'private_hub_keys/legacy'), { key_hash: sha('evil') }));
  const b = writeBatch(d);
  b.set(doc(d, 'private_hubs/legacy'), { id: 'legacy', name: 'Mine', salt: 's', generation: 1 });
  b.set(doc(d, 'private_hub_keys/legacy'), { key_hash: sha('evil') });
  b.set(doc(d, 'private_hub_keys/legacy/members/bob'), { key: 'evil', generation: 1 });
  await assertFails(b.commit());
});

test('private: sign-up creates hub, key hash and membership together', async () => {
  await seedHubs();
  const d = as('carol');
  const ok = writeBatch(d);
  ok.set(doc(d, 'private_hubs/h3'), { id: 'h3', name: 'H3', salt: 's', generation: 1, key_version: 2 });
  ok.set(doc(d, 'private_hub_keys/h3'), { key_hash: sha('k3') });
  ok.set(doc(d, 'private_hub_keys/h3/members/carol'), { key: 'k3', generation: 1, registered_at: 'now' });
  await assertSucceeds(ok.commit());
  await assertSucceeds(setDoc(doc(d, 'private_events/e3'), { hub_id: 'h3', name: 'Mine' }));
  // not without the key hash, not with a password_hash, not over an existing hub
  await assertFails(setDoc(doc(d, 'private_hubs/h4'), { id: 'h4', name: 'H4', salt: 's', generation: 1 }));
  const bad = writeBatch(d);
  bad.set(doc(d, 'private_hubs/h5'), { id: 'h5', salt: 's', generation: 1, password_hash: 'p' });
  bad.set(doc(d, 'private_hub_keys/h5'), { key_hash: sha('k5') });
  await assertFails(bad.commit());
  const bob = as('bob');
  const takeover = writeBatch(bob);
  takeover.set(doc(bob, 'private_hubs/h1'), { id: 'h1', salt: 's', generation: 1 });
  takeover.set(doc(bob, 'private_hub_keys/h1'), { key_hash: sha('evil') });
  await assertFails(takeover.commit());
});

test('private: rotating the key signs out every other device', async () => {
  await seedHubs();
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'private_hub_keys/h1/members/bob'), { key: KEY, generation: 1 }));
  const d = as('alice');
  const rot = writeBatch(d);
  rot.update(doc(d, 'private_hubs/h1'), { salt: 'new', generation: 2, key_version: 2 });
  rot.set(doc(d, 'private_hub_keys/h1'), { key_hash: sha(KEY2) });
  rot.set(doc(d, 'private_hub_keys/h1/members/alice'), { key: KEY2, generation: 2, registered_at: 'now' });
  await assertSucceeds(rot.commit());
  await assertSucceeds(updateDoc(doc(d, 'private_end_scores/s1'), { end_total: 26 }));
  await assertFails(updateDoc(doc(as('bob'), 'private_end_scores/s1'), { end_total: 0 }));
  await assertFails(setDoc(doc(as('bob'), 'private_hub_keys/h1/members/bob'), { key: KEY, generation: 2 }));
  await assertSucceeds(setDoc(doc(as('bob'), 'private_hub_keys/h1/members/bob'), { key: KEY2, generation: 2 }));
});

test('private: salt, generation and key hash only change together', async () => {
  await seedHubs();
  const d = as('alice');
  await assertFails(updateDoc(doc(d, 'private_hubs/h1'), { salt: 'other' }));
  await assertFails(updateDoc(doc(d, 'private_hubs/h1'), { generation: 2 }));
  await assertFails(updateDoc(doc(d, 'private_hubs/h1'), { password_hash: 'p' }));
  await assertFails(updateDoc(doc(d, 'private_hubs/h1'), { id: 'h9' }));
  await assertFails(setDoc(doc(d, 'private_hub_keys/h1'), { key_hash: sha(KEY2) }));
  await assertFails(deleteDoc(doc(d, 'private_hub_keys/h1')));
  await assertFails(deleteDoc(doc(d, 'private_hubs/h1')));
  const skip = writeBatch(d);
  skip.update(doc(d, 'private_hubs/h1'), { salt: 'new', generation: 5 });
  skip.set(doc(d, 'private_hub_keys/h1'), { key_hash: sha(KEY2) });
  await assertFails(skip.commit());
});

// ---------- score summaries ----------

const summary = { v: 1, ends: [{ round_number: 1, end_number: 1, arrows: ['X'], end_total: 10, x_count: 1, ten_count: 1 }], updated_at: 'now' };

test('open event: an end score and the archer summary save together in one batch', async () => {
  const b = writeBatch(db);
  b.set(doc(db, 'end_scores/es_new'), { event_id: 'open', participant_id: 'p_open', end_total: 30 });
  b.set(doc(db, 'event_participants/p_open'), { event_id: 'open', score_summary: summary }, { merge: true });
  await assertSucceeds(b.commit());
});

test('locked event: a missing summary can be filled in once, and nothing else changes', async () => {
  await assertSucceeds(updateDoc(doc(db, 'event_participants/p_past'), { score_summary: summary }));
  await assertFails(updateDoc(doc(db, 'event_participants/p_past'), { score_summary: { ...summary, ends: [] } }));
  await assertFails(updateDoc(doc(db, 'event_participants/p_done'), { score_summary: summary, name: 'Changed' }));
  await assertFails(updateDoc(doc(db, 'event_participants/p_done'), { score_summary: 'not a summary' }));
  await assertFails(updateDoc(doc(db, 'event_participants/p_legacy'), { score_summary: { v: 1 } }));
  // A save batch on a locked event still fails as a whole.
  const b = writeBatch(db);
  b.set(doc(db, 'end_scores/es_x'), { event_id: 'done', participant_id: 'p_done', end_total: 30 });
  b.set(doc(db, 'event_participants/p_done'), { event_id: 'done', score_summary: summary }, { merge: true });
  await assertFails(b.commit());
});
