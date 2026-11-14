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
  for (const c of ['app_state', 'rsvps', 'roster', 'private_events', 'private_end_scores', 'private_hubs', 'feedback']) {
    await assertSucceeds(setDoc(doc(db, `${c}/x`), { a: 1 }));
    await assertSucceeds(deleteDoc(doc(db, `${c}/x`)));
  }
});
