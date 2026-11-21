import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArrows,
  buildScoreSummary,
  hasScoreSummary,
  summaryEnds,
  scoreTotals,
  upsertScore,
  buildLeagueEventData,
  buildPrivateSessionData,
  buildPrivateLeagueEventData,
  buildPrivateSessionCard,
  buildSyncedLeagueCard,
  buildLeagueHubCard,
  buildArcherAnalytics,
  createMergedPager,
  chunk,
  SCORE_SUMMARY_VERSION
} from '../scoring-data.js';

const end = (participant_id, end_number, arrows, extra = {}) => {
  const values = { X: 10, M: 0 };
  const total = arrows.reduce((s, a) => s + (values[a] ?? Number(a)), 0);
  return {
    participant_id,
    event_id: 'ev1',
    round_number: 1,
    end_number,
    arrows,
    end_total: total,
    x_count: arrows.filter(a => a === 'X').length,
    ten_count: arrows.filter(a => a === 'X' || a === '10').length,
    ...extra
  };
};

// A league night tomorrow, so it is open (not locked) whenever the tests run.
const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
const openEvent = { id: 'ev1', name: 'League Night', date: tomorrow, start_time: '18:00', ends_per_round: 2, arrows_per_end: 3, rounds: 1, scoring_type: 'USAA_10', bales_per_group: 2 };

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

test('parseArrows reads arrays, the older JSON string, and bad data', () => {
  assert.deepEqual(parseArrows({ arrows: ['X', '9'] }), ['X', '9']);
  assert.deepEqual(parseArrows({ arrows_json: '["10","8"]' }), ['10', '8']);
  assert.deepEqual(parseArrows({ arrows_json: 'not json' }), []);
  assert.deepEqual(parseArrows({}), []);
});

test('buildScoreSummary keeps only shot ends, in round/end order, as plain numbers', () => {
  const summary = buildScoreSummary([
    end('p1', 2, ['9', '8', '7']),
    { ...end('p1', 3, []), arrows: [] },
    { ...end('p1', 1, ['X', '10', '9']), end_total: '29', arrows: undefined, arrows_json: '["X","10","9"]' }
  ], '2026-11-21T00:00:00.000Z');
  assert.equal(summary.v, SCORE_SUMMARY_VERSION);
  assert.equal(summary.updated_at, '2026-11-21T00:00:00.000Z');
  assert.deepEqual(summary.ends.map(e => e.end_number), [1, 2]);
  assert.equal(summary.ends[0].end_total, 29);
  assert.deepEqual(summary.ends[0].arrows, ['X', '10', '9']);
  assert.ok(hasScoreSummary({ score_summary: summary }));
});

test('summaryEnds is null without a current summary, so callers read end scores instead', () => {
  assert.equal(summaryEnds({ id: 'p1' }), null);
  assert.equal(summaryEnds({ id: 'p1', score_summary: { v: 0, ends: [] } }), null);
  const ends = summaryEnds({ id: 'p1', event_id: 'ev1', score_summary: buildScoreSummary([end('p1', 1, ['9', '9', '9'])]) });
  assert.equal(ends.length, 1);
  assert.equal(ends[0].participant_id, 'p1');
  assert.equal(ends[0].event_id, 'ev1');
});

test('scoreTotals adds up ends and counts completed ones', () => {
  const t = scoreTotals([end('p1', 1, ['X', '10', '9']), end('p1', 2, ['8', '7'])], 3);
  assert.deepEqual(t, { score: 44, arrows: 5, xs: 1, tens: 2, completedEnds: 1 });
});

test('upsertScore replaces the same end and adds a new one', () => {
  const list = [end('p1', 1, ['9', '9', '9']), end('p2', 1, ['8', '8', '8'])];
  const replaced = upsertScore(list, end('p1', 1, ['X', 'X', 'X']));
  assert.equal(replaced.length, 2);
  assert.equal(replaced.find(s => s.participant_id === 'p1').end_total, 30);
  const added = upsertScore(list, end('p1', 2, ['7', '7', '7']));
  assert.equal(added.length, 3);
  assert.equal(list.length, 2, 'input list is not changed');
});

// ---------------------------------------------------------------------------
// Event pages
// ---------------------------------------------------------------------------

const leagueRaw = () => ({
  event: { ...openEvent },
  participants: [
    { id: 'p1', event_id: 'ev1', name: 'Alice Archer', bale_number: 1, position: 'A', bow_category: 'BAREBOW' },
    { id: 'p2', event_id: 'ev1', name: 'Bob Bow', bale_number: 1, position: 'B', bow_category: 'COMPOUND' },
    { id: 'p3', event_id: 'ev1', name: 'Cara Cross', bale_number: 3, position: 'A' }
  ],
  scores: [
    end('p1', 1, ['X', '10', '9']), end('p1', 2, ['9', '9', '9']),
    end('p2', 1, ['10', '10', '10']), end('p2', 2, ['X', '8', '8']),
    { ...end('p3', 1, ['5', '5', '5']), arrows: undefined, arrows_json: '["5","5","5"]' }
  ],
  groups: [],
  notes: []
});

test('league event page: totals, ranks, categories and default groups', () => {
  const res = buildLeagueEventData(leagueRaw());
  assert.equal(res.success, true);
  const { event, participants, leaderboard, leaderboard_by_category, groups, scores } = res.data;
  assert.equal(event.midpoint_end, 2);
  assert.equal(event.is_locked, false);
  assert.equal(event.all_scores_filled, false, 'Cara has only one end');
  const alice = participants.find(p => p.id === 'p1');
  assert.equal(alice.running_total, 56);
  assert.equal(alice.ends_completed, 2);
  assert.equal(alice.designation, '1A');
  assert.equal(alice.avg_per_arrow, '9.33');
  // Alice and Bob tie on 56 and on Xs; Bob has more 10s.
  assert.deepEqual(leaderboard.map(p => p.id), ['p2', 'p1', 'p3']);
  assert.equal(leaderboard_by_category.COMPOUND[0].category_rank, 1);
  assert.equal(scores.length, 5);
  assert.deepEqual(scores.find(s => s.participant_id === 'p3').arrows, ['5', '5', '5']);
  assert.deepEqual(groups.map(g => g.bales), [[1, 3]]);
});

test('league event page is not found when the event document is gone', () => {
  assert.equal(buildLeagueEventData({ ...leagueRaw(), event: null }).success, false);
});

test('league event page locks once the event is 8 hours past its start', () => {
  const raw = leagueRaw();
  raw.event.date = '2020-01-05';
  const res = buildLeagueEventData(raw);
  assert.equal(res.data.event.is_locked, true);
  assert.equal(res.data.event.is_finished, true);
});

test('private league page shows only the hub\'s archers and their notes', () => {
  const raw = leagueRaw();
  raw.notes = [{ league_event_id: 'ev1', archer_key: 'alice archer', archer_notes: 'Good form', updated_at: '1' }];
  const res = buildPrivateLeagueEventData(raw, { linkedArchers: ['Alice Archer'] });
  assert.equal(res.data.event.id, 'league:ev1');
  assert.deepEqual(res.data.participants.map(p => p.id), ['p1']);
  assert.equal(res.data.participants[0].archer_notes, 'Good form');
  assert.equal(res.data.scores.length, 2, 'other archers\' scores are left out');
});

test('private session page fills a default group', () => {
  const raw = leagueRaw();
  raw.event = { ...openEvent, id: 'pe1', hub_id: 'h' };
  const res = buildPrivateSessionData(raw);
  assert.equal(res.data.event.is_locked, false);
  assert.equal(res.data.groups.length, 1);
  assert.equal(res.data.leaderboard[0].rank, 1);
});

// ---------------------------------------------------------------------------
// Hub cards and analytics read summaries exactly like end scores
// ---------------------------------------------------------------------------

function endsBoth(raw) {
  const fromScores = {};
  raw.scores.forEach(s => { (fromScores[s.participant_id] = fromScores[s.participant_id] || []).push(s); });
  const fromSummaries = {};
  raw.participants.forEach(p => {
    fromSummaries[p.id] = summaryEnds({ ...p, score_summary: buildScoreSummary(fromScores[p.id] || []) });
  });
  return { fromScores, fromSummaries };
}

test('private session card: same numbers from summaries as from end scores', () => {
  const raw = leagueRaw();
  const ev = { ...openEvent, id: 'ev1', session_category: 'Practice' };
  const { fromScores, fromSummaries } = endsBoth(raw);
  const a = buildPrivateSessionCard(ev, raw.participants, fromScores);
  const b = buildPrivateSessionCard(ev, raw.participants, fromSummaries);
  assert.deepEqual(a, b);
  assert.equal(a.participant_summaries.length, 3);
  assert.equal(a.participant_summaries.find(s => s.id === 'p1').score, 56);
  assert.equal(a.all_scores_filled, false);
});

test('synced league card: only linked archers, null when they did not shoot', () => {
  const raw = leagueRaw();
  const { fromSummaries } = endsBoth(raw);
  const card = buildSyncedLeagueCard(openEvent, raw.participants, fromSummaries, { linkedArchers: ['Bob Bow'] });
  assert.equal(card.id, 'league:ev1');
  assert.equal(card.is_league_synced, true);
  assert.deepEqual(card.participant_summaries.map(s => s.name), ['Bob Bow']);
  assert.equal(card.all_scores_filled, true);
  assert.equal(buildSyncedLeagueCard(openEvent, raw.participants, fromSummaries, { linkedArchers: ['Nobody Here'] }), null);
  assert.equal(buildSyncedLeagueCard({ ...openEvent, name: 'Testing night' }, raw.participants, fromSummaries, { linkedArchers: ['Bob Bow'] }), null);
});

test('league hub card shows the archer count and lock', () => {
  const card = buildLeagueHubCard(openEvent, 7);
  assert.equal(card.participant_count, 7);
  assert.equal(card.is_locked, false);
});

test('analytics: identical from summaries and from end scores', () => {
  const raw = leagueRaw();
  const { fromScores, fromSummaries } = endsBoth(raw);
  const events = [{ ...openEvent, session_category: 'Practice' }];
  const a = buildArcherAnalytics({ events, participants: raw.participants, endsByParticipant: fromScores });
  const b = buildArcherAnalytics({ events, participants: raw.participants, endsByParticipant: fromSummaries });
  assert.deepEqual(a, b);
  const alice = a.archers['alice archer'];
  assert.equal(alice.sessions.length, 1);
  assert.equal(alice.sessions[0].total_score, 56);
  assert.equal(alice.sessions[0].ring_counts.X, 1);
  assert.equal(alice.sessions[0].ends.length, 2);
  assert.equal(a.total_events, 1);
});

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

// A fake source that serves `items` in batches and records each fetch.
function source(items, batch = 2) {
  const rest = [...items];
  const s = {
    fetches: 0,
    async fetchMore() {
      s.fetches++;
      const page = rest.splice(0, batch);
      return { items: page, done: rest.length === 0 };
    }
  };
  return s;
}
const byDate = (a, b) => String(b.date).localeCompare(String(a.date));

test('pager merges two newest-first streams a page at a time', async () => {
  const priv = source([{ id: 'p5', date: '05' }, { id: 'p3', date: '03' }, { id: 'p1', date: '01' }]);
  const league = source([{ id: 'l4', date: '04' }, { id: 'l2', date: '02' }]);
  const pager = createMergedPager([priv, league], { compare: byDate });
  assert.deepEqual((await pager.next(2)).map(e => e.id), ['p5', 'l4']);
  assert.equal(pager.hasMore, true);
  assert.deepEqual((await pager.next(2)).map(e => e.id), ['p3', 'l2']);
  assert.deepEqual((await pager.next(10)).map(e => e.id), ['p1']);
  assert.equal(pager.hasMore, false);
  assert.deepEqual(await pager.next(5), []);
});

test('pager reads only what a page needs', async () => {
  const big = source(Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, date: String(1000 - i) })), 10);
  const pager = createMergedPager([big], { compare: byDate });
  await pager.next(10);
  assert.equal(big.fetches, 1);
  await pager.next(5);
  assert.equal(big.fetches, 2, 'the second page needs one more batch');
});

test('pager: on the same date the first source wins, and skip drops duplicates', async () => {
  const priv = source([{ id: 'priv-league', date: '07', own: true }]);
  const league = source([{ id: 'league-07', date: '07' }, { id: 'league-06', date: '06' }]);
  const pager = createMergedPager([priv, league], {
    compare: byDate,
    skip: (item, emitted) => !item.own && emitted.some(e => e.own && e.date === item.date)
  });
  assert.deepEqual((await pager.next(5)).map(e => e.id), ['priv-league', 'league-06']);
});

test('pager keeps going through batches that came back empty', async () => {
  let calls = 0;
  const sparse = {
    async fetchMore() {
      calls++;
      if (calls < 4) return { items: [], done: false };
      return { items: [{ id: 'x', date: '01' }], done: true };
    }
  };
  const pager = createMergedPager([sparse], { compare: byDate });
  assert.deepEqual((await pager.next(3)).map(e => e.id), ['x']);
  assert.equal(pager.hasMore, false);
});

test('chunk splits ids for Firestore `in` queries (30 max)', () => {
  const ids = Array.from({ length: 65 }, (_, i) => i);
  assert.deepEqual(chunk(ids).map(c => c.length), [30, 30, 5]);
  assert.deepEqual(chunk([]), []);
});
