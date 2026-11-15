import test, { before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore';

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

async function seedPrivate() {
  await env.withSecurityRulesDisabled(async ctx => {
    const a = ctx.firestore();
    // pOpen: created recently, editable for ~47h more. pPast: lock passed. pLegacy: no lock_at.
    await setDoc(doc(a, 'private_events/pOpen'), { id: 'pOpen', hub_id: 'h', date: day(-30), name: 'Practice', lock_at: new Date(Date.now() + 47 * H) });
    await setDoc(doc(a, 'private_events/pPast'), { id: 'pPast', hub_id: 'h', date: day(-3), name: 'Practice', lock_at: new Date(Date.now() - H) });
    await setDoc(doc(a, 'private_events/pLegacy'), { id: 'pLegacy', hub_id: 'h', date: day(0), name: 'Practice' });
    for (const e of ['pOpen', 'pPast', 'pLegacy']) {
      await setDoc(doc(a, `private_end_scores/s_${e}`), { hub_id: 'h', event_id: e, end_total: 20 });
      await setDoc(doc(a, `private_participants/p_${e}`), { hub_id: 'h', event_id: e, name: 'A', archer_notes: '' });
      await setDoc(doc(a, `private_groups/g_${e}`), { hub_id: 'h', event_id: e, current_end: 1 });
    }
    await setDoc(doc(a, 'private_hubs/h'), { id: 'h', name: 'H', salt: 'aa', password_hash: 'bb', linked_archers: ['A'], passkeys: [] });
    await setDoc(doc(a, 'private_hubs/legacy'), { id: 'legacy', name: 'L' });
    await setDoc(doc(a, 'private_league_notes/n'), { hub_id: 'h', archer_notes: 'x' });
  });
}

test('private: nothing can be deleted', async () => {
  await seedPrivate();
  for (const e of ['pOpen', 'pPast', 'pLegacy']) {
    await assertFails(deleteDoc(doc(db, `private_events/${e}`)));
    await assertFails(deleteDoc(doc(db, `private_end_scores/s_${e}`)));
  }
  await assertFails(deleteDoc(doc(db, 'private_hubs/h')));
  await assertFails(deleteDoc(doc(db, 'private_league_notes/n')));
  await assertFails(deleteDoc(doc(db, 'private_participants/p_pPast')));
  await assertFails(deleteDoc(doc(db, 'private_groups/g_pPast')));
});
test('private: reads stay open', async () => {
  await seedPrivate();
  await assertSucceeds(getDoc(doc(db, 'private_end_scores/s_pPast')));
  await assertSucceeds(getDoc(doc(db, 'private_hubs/h')));
});
test('private: create a session with a 48h lock, then score it', async () => {
  await seedPrivate();
  await assertSucceeds(setDoc(doc(db, 'private_events/new'), { id: 'new', hub_id: 'h', date: day(-10), lock_at: new Date(Date.now() + 48 * H) }));
  await assertSucceeds(setDoc(doc(db, 'private_groups/g_new'), { hub_id: 'h', event_id: 'new' }));
  await assertSucceeds(setDoc(doc(db, 'private_participants/p_new'), { hub_id: 'h', event_id: 'new', name: 'A' }));
  await assertSucceeds(setDoc(doc(db, 'private_end_scores/s_new'), { hub_id: 'h', event_id: 'new', end_total: 27 }));
});
test('private: lock_at must be set and near now', async () => {
  await assertFails(setDoc(doc(db, 'private_events/a'), { id: 'a', date: day(0) }));
  await assertFails(setDoc(doc(db, 'private_events/b'), { id: 'b', date: day(0), lock_at: new Date(Date.now() + 30 * 86400e3) }));
  await assertFails(setDoc(doc(db, 'private_events/c'), { id: 'c', date: day(0), lock_at: new Date(Date.now() - H) }));
});
test('private: open session is editable but its lock cannot move', async () => {
  await seedPrivate();
  await assertSucceeds(updateDoc(doc(db, 'private_events/pOpen'), { name: 'Renamed', date: day(-1) }));
  await assertSucceeds(updateDoc(doc(db, 'private_end_scores/s_pOpen'), { end_total: 25 }));
  await assertSucceeds(updateDoc(doc(db, 'private_groups/g_pOpen'), { current_end: 2 }));
  await assertSucceeds(deleteDoc(doc(db, 'private_groups/g_pOpen')));
  await assertSucceeds(deleteDoc(doc(db, 'private_participants/p_pOpen')));
  await assertFails(updateDoc(doc(db, 'private_events/pOpen'), { lock_at: new Date(Date.now() + 9e9) }));
  await assertFails(updateDoc(doc(db, 'private_end_scores/s_pOpen'), { event_id: 'other' }));
});
for (const e of ['pPast', 'pLegacy']) {
  test(`private ${e}: scores frozen, notes and soft delete allowed`, async () => {
    await seedPrivate();
    await assertFails(updateDoc(doc(db, `private_end_scores/s_${e}`), { end_total: 0 }));
    await assertFails(setDoc(doc(db, `private_end_scores/s_${e}`), { hub_id: 'h', event_id: e, end_total: 0 }));
    await assertFails(setDoc(doc(db, 'private_end_scores/new'), { hub_id: 'h', event_id: e, end_total: 30 }));
    await assertFails(updateDoc(doc(db, `private_participants/p_${e}`), { name: 'B' }));
    await assertFails(setDoc(doc(db, 'private_participants/new'), { event_id: e }));
    await assertFails(updateDoc(doc(db, `private_groups/g_${e}`), { current_end: 9 }));
    await assertFails(updateDoc(doc(db, `private_events/${e}`), { name: 'X' }));
    await assertFails(updateDoc(doc(db, `private_events/${e}`), { lock_at: new Date(Date.now() + 9e9) }));
    await assertSucceeds(updateDoc(doc(db, `private_participants/p_${e}`), { archer_notes: 'felt good' }));
    await assertSucceeds(updateDoc(doc(db, `private_events/${e}`), { updated_at: 'now' }));
    await assertSucceeds(updateDoc(doc(db, `private_events/${e}`), { deleted: true, deleted_at: 'now', updated_at: 'now' }));
    await assertSucceeds(updateDoc(doc(db, `private_events/${e}`), { deleted: false }));
  });
}
test('private: scores need an existing session', async () => {
  await assertFails(setDoc(doc(db, 'private_end_scores/orphan'), { event_id: 'missing', end_total: 30 }));
});
test('private: hub password cannot be replaced, other fields can change', async () => {
  await seedPrivate();
  await assertFails(updateDoc(doc(db, 'private_hubs/h'), { password_hash: 'evil' }));
  await assertFails(updateDoc(doc(db, 'private_hubs/h'), { salt: 'evil' }));
  await assertFails(setDoc(doc(db, 'private_hubs/h'), { name: 'H' }));
  await assertSucceeds(updateDoc(doc(db, 'private_hubs/h'), { passkeys: [{ id: 'k' }], updated_at: 'now' }));
  await assertSucceeds(setDoc(doc(db, 'private_hubs/legacy'), { salt: 'cc', password_hash: 'dd' }, { merge: true }));
  await assertSucceeds(setDoc(doc(db, 'private_hubs/brand_new'), { id: 'brand_new', salt: 'ee', password_hash: 'ff' }));
});
test('private league notes: editable, not deletable', async () => {
  await seedPrivate();
  await assertSucceeds(setDoc(doc(db, 'private_league_notes/n'), { archer_notes: 'y' }, { merge: true }));
  await assertFails(deleteDoc(doc(db, 'private_league_notes/n')));
});
