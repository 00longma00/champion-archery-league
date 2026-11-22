// End-to-end tests of firebase-adapter.js against the Firestore and Auth emulators,
// with firestore.rules enforced. Run from this folder: npm test
// (node --import ./adapter-loader.mjs maps the browser SDK URLs to the npm packages.)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, collection, writeBatch } from 'firebase/firestore';
import * as adapter from '../../firebase-adapter.js';

const RULES = new URL('../../firestore.rules', import.meta.url).pathname;
const H = 3600e3;
const isoDay = (d) => d.toISOString().slice(0, 10);
const today = isoDay(new Date());
const daysAgo = (n) => isoDay(new Date(Date.now() - n * 86400e3));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let env, hubId;
// Reads and writes as the Firebase console would (rules off).
async function adminGet(path) {
  let data;
  await env.withSecurityRulesDisabled(async ctx => { data = (await getDoc(doc(ctx.firestore(), path))).data(); });
  return data;
}
const adminSet = (path, data) => env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), path), data));
const LEAGUE = 25;    // league nights, L0 (oldest) .. L24 (today, still open)
const PRIVATE = 12;   // private sessions P0 .. P11

const leagueId = i => `L${i}`;
const leagueDate = i => (i === LEAGUE - 1 ? today : daysAgo((LEAGUE - 1 - i) * 7));
const privateDate = i => daysAgo(i * 7 + 3);

function endDoc(id, eventId, participantId, endNumber, arrows, extra = {}) {
  const val = a => (a === 'X' ? 10 : a === 'M' ? 0 : Number(a));
  return {
    id, event_id: eventId, participant_id: participantId, round_number: 1, end_number: endNumber,
    arrows, arrows_json: JSON.stringify(arrows), end_total: arrows.reduce((s, a) => s + val(a), 0),
    x_count: arrows.filter(a => a === 'X').length, ten_count: arrows.filter(a => a === 'X' || a === '10').length,
    ...extra
  };
}

async function waitFor(check, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return true;
    await sleep(100);
  }
  return false;
}

// Pages one after another, as a person tapping "Next" would. Summary saves from
// the previous page finish first: the emulator can return wrong query results
// while unrelated writes to the same collection are being committed.
async function allPages(firstPage, size = 10) {
  const events = [...firstPage.events];
  let hasMore = firstPage.hasMore;
  while (hasMore) {
    await adapter.scoreSummariesSaved();
    const res = await firstPage.loadMore(size);
    events.push(...res.events);
    hasMore = res.hasMore;
  }
  return events;
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT || 'demo-archery',
    firestore: { rules: fs.readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8080 }
  });
  await env.clearFirestore();

  // The hub is created through the adapter, so this test's device is a signed-in member.
  const reg = await adapter.registerPrivateHubSpace({ name: 'Adapter Test Hub', password: 'correct horse 42', linkedArchers: ['Alice Archer'] });
  hubId = reg.hub.id;

  await env.withSecurityRulesDisabled(async ctx => {
    const admin = ctx.firestore();
    const batch = writeBatch(admin);
    batch.set(doc(admin, 'roster/alice'), { name: 'Alice Archer', bowCategory: 'BAREBOW', avatarId: 'av_fox' });
    for (let i = 0; i < LEAGUE; i++) {
      const id = leagueId(i);
      const open = i === LEAGUE - 1;
      batch.set(doc(admin, `scoring_events/${id}`), {
        id, name: i === 10 ? 'Testing night' : `League Night ${i}`, date: leagueDate(i), start_time: '18:00',
        status: 'ON', ends_per_round: 2, arrows_per_end: 3, rounds: 1, scoring_type: 'USAA_10', bales_per_group: 2,
        created_at: `${leagueDate(i)}T00:00:00Z`,
        lock_at: open ? new Date(Date.now() + 7 * H) : new Date(Date.now() - 86400e3)
      });
      const archers = [['a', 'Alice Archer'], ['b', 'Bob Bow']];
      if (i % 2 === 0) archers.push(['c', 'Cara Cross']);
      archers.forEach(([k, name], idx) => {
        batch.set(doc(admin, `event_participants/${id}_${k}`), { id: `${id}_${k}`, event_id: id, name, bale_number: 1, position: 'ABC'[idx], bow_category: 'BAREBOW', sort_order: idx });
      });
      if (i !== 5) { // Alice did not shoot on night 5
        batch.set(doc(admin, `end_scores/es_${id}_${id}_a_1_1`), endDoc(`es_${id}_${id}_a_1_1`, id, `${id}_a`, 1, ['X', '9', String(i % 10)]));
        batch.set(doc(admin, `end_scores/es_${id}_${id}_a_1_2`), endDoc(`es_${id}_${id}_a_1_2`, id, `${id}_a`, 2, ['8', '8', '8']));
      }
      batch.set(doc(admin, `end_scores/es_${id}_${id}_b_1_1`), endDoc(`es_${id}_${id}_b_1_1`, id, `${id}_b`, 1, ['7', '7', '7']));
    }
    for (let i = 0; i < PRIVATE; i++) {
      const id = `P${i}`;
      // P3 is the hub's own record of league night 20, so the synced copy is hidden.
      const date = i === 3 ? leagueDate(20) : privateDate(i);
      batch.set(doc(admin, `private_events/${id}`), {
        id, hub_id: hubId, name: `Practice ${i}`, date, session_category: i === 3 ? 'League' : 'Practice',
        ends_per_round: 2, arrows_per_end: 3, rounds: 1, scoring_type: 'USAA_10', created_at: `${date}T01:00:00Z`
      });
      batch.set(doc(admin, `private_participants/${id}_a`), { id: `${id}_a`, hub_id: hubId, event_id: id, name: 'Alice Archer', bale_number: 1, position: 'A', sort_order: 0, archer_notes: '' });
      batch.set(doc(admin, `private_end_scores/scr_${id}_${id}_a_r1_e1`), endDoc(`scr_${id}_${id}_a_r1_e1`, id, `${id}_a`, 1, ['10', '10', String(i % 10)], { hub_id: hubId }));
      batch.set(doc(admin, `private_end_scores/scr_${id}_${id}_a_r1_e2`), endDoc(`scr_${id}_${id}_a_r1_e2`, id, `${id}_a`, 2, ['9', '9', '9'], { hub_id: hubId }));
    }
    await batch.commit();
  });
});

after(async () => {
  await env.cleanup();
  setTimeout(() => process.exit(0), 200).unref();
});

test('league hub: newest first, 10 at a time, nothing missed or repeated', async () => {
  const first = await adapter.getScoringEventsHub({ pageSize: 10 });
  assert.equal(first.events.length, 10);
  assert.equal(first.hasMore, true);
  assert.equal(first.events[0].id, leagueId(LEAGUE - 1));
  assert.equal(first.events[0].participant_count, 3);
  assert.equal(first.events[1].participant_count, 2);
  const all = await allPages(first);
  assert.equal(all.length, LEAGUE);
  assert.equal(new Set(all.map(e => e.id)).size, LEAGUE);
  assert.deepEqual(all.map(e => e.date), [...all.map(e => e.date)].sort().reverse());
  assert.ok(first.rsvpImport.allArchers.some(a => a.name === 'Alice Archer'));
});

test('private hub: sessions and synced league nights merged by date, a page at a time', async () => {
  const first = await adapter.getPrivateScoringEventsHub(hubId, ['Alice Archer'], { pageSize: 10 });
  assert.equal(first.events.length, 10);
  assert.equal(first.hasMore, true);
  const all = await allPages(first);
  const ids = all.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  assert.deepEqual(all.map(e => e.date), [...all.map(e => e.date)].sort().reverse());
  // 12 private + 25 league nights - night 5 (Alice did not shoot) - the "Testing" night - night 20 (logged privately)
  assert.equal(all.length, PRIVATE + LEAGUE - 3);
  for (const hidden of ['league:L5', 'league:L10', 'league:L20']) assert.ok(!ids.includes(hidden), hidden);
  const p0 = all.find(e => e.id === 'P0');
  assert.equal(p0.participant_summaries[0].score, 10 + 10 + 0 + 27);
  const l7 = all.find(e => e.id === 'league:L7');
  assert.deepEqual(l7.participant_summaries.map(s => [s.name, s.score]), [['Alice Archer', 10 + 9 + 7 + 24]]);
  assert.equal(all.find(e => e.id === 'league:L24').is_locked, false);
});

test('first hub load saves score summaries; locked league nights only, open ones stay live', async () => {
  await adapter.scoreSummariesSaved();
  const saved = await waitFor(async () => {
    const p = await adminGet('private_participants/P0_a');
    const l = await adminGet('event_participants/L7_a');
    return p.score_summary && l.score_summary;
  });
  assert.ok(saved, 'summaries were written');
  const l7 = (await adminGet('event_participants/L7_a')).score_summary;
  assert.deepEqual(l7.ends.map(e => e.end_total), [26, 24]);
  const open = (await adminGet('event_participants/L24_a'));
  assert.equal(open.score_summary, undefined, 'an open event is not summarised from the list');

  // A second load reads the summaries and shows the same thing.
  const again = await allPages(await adapter.getPrivateScoringEventsHub(hubId, ['Alice Archer'], { pageSize: 10 }));
  assert.equal(again.length, PRIVATE + LEAGUE - 3);
  assert.equal(again.find(e => e.id === 'league:L7').participant_summaries[0].score, 50);
});

test('analytics: every session of the linked archer, from summaries or end scores', async () => {
  await adapter.scoreSummariesSaved();
  const res = await adapter.getPrivateAnalyticsData(hubId, ['Alice Archer']);
  const alice = res.archers['alice archer'];
  assert.ok(alice);
  assert.equal(alice.sessions.length, PRIVATE + LEAGUE - 3);
  const l7 = alice.sessions.find(s => s.event_id === 'league:L7');
  assert.equal(l7.total_score, 50);
  assert.equal(l7.ends.length, 2);
  assert.equal(l7.ring_counts.X, 1);
  assert.deepEqual(alice.sessions.map(s => s.date), [...alice.sessions.map(s => s.date)].sort());
});

test('live event: first load matches getEventData, then other devices\' scores arrive', async () => {
  const updates = [];
  const stop = adapter.subscribeToEvent('L24', {}, json => updates.push(json));
  try {
    assert.ok(await waitFor(() => updates.length > 0));
    const fetched = await adapter.getEventData('L24');
    assert.deepEqual(updates[0].data.leaderboard.map(p => [p.id, p.running_total]), fetched.data.leaderboard.map(p => [p.id, p.running_total]));

    // Another device scores Cara's first end.
    await adminSet('end_scores/es_L24_L24_c_1_1', endDoc('es_L24_L24_c_1_1', 'L24', 'L24_c', 1, ['X', 'X', 'X']));
    assert.ok(await waitFor(() => {
      const last = updates[updates.length - 1];
      return last.data.participants.find(p => p.id === 'L24_c').running_total === 30;
    }), 'the new score reached this device');
  } finally {
    stop();
  }
});

test('saving an end: one batch, returns the updated page and keeps the archer summary current', async () => {
  const updates = [];
  const stop = adapter.subscribeToEvent('L24', {}, json => updates.push(json));
  try {
    assert.ok(await waitFor(() => updates.length > 0));
    const res = await adapter.submitEndScore({
      eventId: 'L24', participantId: 'L24_a', roundNumber: 1, endNumber: 2,
      arrows: ['X', '10', '10'], endTotal: 30, xCount: 1, tenCount: 3, scoredBy: 'Bob Bow'
    });
    assert.equal(res.success, true);
    const alice = res.data.participants.find(p => p.id === 'L24_a');
    assert.equal(alice.running_total, 10 + 9 + 4 + 30, 'end 2 replaced, end 1 kept');
    const summary = (await adminGet('event_participants/L24_a')).score_summary;
    assert.deepEqual(summary.ends.map(e => [e.end_number, e.end_total]), [[1, 23], [2, 30]]);
    const score = (await adminGet('end_scores/es_L24_L24_a_1_2'));
    assert.equal(score.end_total, 30);
  } finally {
    stop();
  }
});

test('saving without a live page still saves, and drops the summary so lists rebuild it', async () => {
  const res = await adapter.submitEndScore({
    eventId: 'L24', participantId: 'L24_b', roundNumber: 1, endNumber: 2,
    arrows: ['9', '9', '9'], endTotal: 27, xCount: 0, tenCount: 0, scoredBy: 'Bob Bow'
  });
  assert.deepEqual(res, { success: true });
  const bob = (await adminGet('event_participants/L24_b'));
  assert.equal(bob.score_summary, undefined);
});

test('a locked night refuses new scores with the friendly message', async () => {
  await assert.rejects(
    adapter.submitEndScore({ eventId: 'L23', participantId: 'L23_a', roundNumber: 1, endNumber: 1, arrows: ['X', 'X', 'X'], endTotal: 30, xCount: 3, tenCount: 3, scoredBy: 'x' }),
    /Scoring is locked/
  );
  const kept = (await adminGet('end_scores/es_L23_L23_a_1_1'));
  assert.equal(kept.end_total, 10 + 9 + 3);
});

test('private session: live save by a hub member updates scores and summary', async () => {
  const updates = [];
  const stop = adapter.subscribeToEvent('P0', { hubId, linkedArchers: ['Alice Archer'] }, json => updates.push(json));
  try {
    assert.ok(await waitFor(() => updates.length > 0));
    assert.equal(updates[0].data.event.id, 'P0');
    const res = await adapter.submitPrivateEndScore(hubId, {
      eventId: 'P0', participantId: 'P0_a', roundNumber: 1, endNumber: 2,
      arrows: ['X', 'X', '10'], endTotal: 30, xCount: 2, tenCount: 3, scoredBy: 'Alice Archer'
    });
    assert.equal(res.data.participants[0].running_total, 20 + 30);
    const summary = (await adminGet('private_participants/P0_a')).score_summary;
    assert.deepEqual(summary.ends.map(e => e.end_total), [20, 30]);
  } finally {
    stop();
  }
});

test('private league night: the hub\'s archer only, saved into the league scores', async () => {
  const page = await adapter.getPrivateEventData('league:L24', hubId, ['Alice Archer']);
  assert.deepEqual(page.data.participants.map(p => p.id), ['L24_a']);
  const updates = [];
  const stop = adapter.subscribeToEvent('league:L24', { hubId, linkedArchers: ['Alice Archer'] }, json => updates.push(json));
  try {
    assert.ok(await waitFor(() => updates.length > 0));
    const res = await adapter.submitPrivateEndScore(hubId, {
      eventId: 'league:L24', participantId: 'L24_a', roundNumber: 1, endNumber: 1,
      arrows: ['X', 'X', 'X'], endTotal: 30, xCount: 3, tenCount: 3, scoredBy: 'Alice Archer'
    });
    assert.equal(res.data.participants[0].running_total, 60);
  } finally {
    stop();
  }
});

test('saving bale assignments keeps the stored summary', async () => {
  const before = (await adminGet('event_participants/L24_a')).score_summary;
  assert.ok(before);
  const page = await adapter.getEventData('L24');
  // The page's participants carry computed fields; none of them may be written back.
  const res = await adapter.saveBaleAssignments('L24', { participants: page.data.participants.map(p => ({ ...p, score_summary: { v: 1, ends: [] } })) });
  assert.equal(res.success, true);
  const afterDoc = (await adminGet('event_participants/L24_a'));
  assert.deepEqual(afterDoc.score_summary, before);
  assert.equal(afterDoc.running_total, undefined);
  assert.equal(afterDoc.scores, undefined);
});
