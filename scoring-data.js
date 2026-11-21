// Pure scoring logic shared by the Firestore adapter and the tests.
// Nothing here talks to Firebase: it turns documents into what the pages show.
import { leagueEventLockFields } from "./event-lock.js";
import { archerDirectory } from "./archer-names.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function parseArrows(s) {
  if (s && Array.isArray(s.arrows)) return s.arrows;
  if (s && typeof s.arrows_json === "string") {
    try { return JSON.parse(s.arrows_json || "[]"); } catch (e) { return []; }
  }
  return [];
}

export function sortByRoundEnd(a, b) {
  return (Number(a.round_number) - Number(b.round_number)) || (Number(a.end_number) - Number(b.end_number));
}

// Any spelling of a linked archer counts ("Alex" matches a hub linked to "Alex Grossman").
export function normalizeLinkedArcherMatch(participantName, linkedArchers = []) {
  const key = archerDirectory.key(participantName);
  if (!key) return null;
  for (const arch of linkedArchers) {
    if (archerDirectory.key(arch) === key) return archerDirectory.display(arch);
  }
  return null;
}

// Private league notes were saved under short names ("long"); file them under the archer's full name.
export function addLeagueNote(notesMap, n) {
  const k = `${n.league_event_id}_${archerDirectory.key(n.archer_key)}`;
  const stamp = String(n.updated_at || "");
  if (!(k in notesMap) || stamp >= (notesMap[`${k}__at`] || "")) {
    notesMap[k] = n.archer_notes || "";
    notesMap[`${k}__at`] = stamp;
  }
}

export function leagueNotesMap(notes = []) {
  const map = {};
  notes.forEach(n => addLeagueNote(map, n));
  return map;
}

// An archer's own badge (from the roster) wins over whatever a past entry saved.
export function badgeFrom(rosterBadges, name, saved) {
  return (rosterBadges && rosterBadges.get(archerDirectory.key(name))) || saved || null;
}

// Linked archers as full names, without duplicates.
export function linkedArcherNames(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(n => {
    const name = archerDirectory.display(n);
    if (name && !out.some(o => archerDirectory.key(o) === archerDirectory.key(name))) out.push(name);
  });
  return out;
}

export function isTestLeagueEventName(name) {
  const n = String(name || "").trim().toLowerCase();
  return n.startsWith("test") || n.includes("testing");
}

export function sortEventsNewestFirst(a, b) {
  const dc = String(b.date || "").localeCompare(String(a.date || ""));
  if (dc !== 0) return dc;
  return String(b.created_at || b.id || "").localeCompare(String(a.created_at || a.id || ""));
}

// Split a list into chunks Firestore's `in` filter accepts (at most 30 values).
export function chunk(list, size = 30) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Per-archer score summaries
//
// Every participant document carries `score_summary`: the archer's ends for that
// session. Lists and analytics read it instead of every end score document.
// The end score documents stay the source of truth for the event page.
// ---------------------------------------------------------------------------

export const SCORE_SUMMARY_VERSION = 1;

// Summary of one archer's ends (only ends with arrows count).
export function buildScoreSummary(scores = [], now = new Date().toISOString()) {
  const ends = scores
    .map(s => ({ s, arrows: parseArrows(s) }))
    .filter(({ arrows }) => arrows.length > 0)
    .map(({ s, arrows }) => ({
      round_number: Number(s.round_number) || 1,
      end_number: Number(s.end_number) || 1,
      arrows: arrows.map(String),
      end_total: Number(s.end_total) || 0,
      x_count: Number(s.x_count) || 0,
      ten_count: Number(s.ten_count) || 0
    }))
    .sort(sortByRoundEnd);
  return { v: SCORE_SUMMARY_VERSION, ends, updated_at: now };
}

export function hasScoreSummary(p) {
  const s = p && p.score_summary;
  return Boolean(s && s.v === SCORE_SUMMARY_VERSION && Array.isArray(s.ends));
}

// The ends of a participant, as end-score-like objects, from its summary.
export function summaryEnds(p) {
  return hasScoreSummary(p) ? p.score_summary.ends.map(e => ({ ...e, participant_id: p.id, event_id: p.event_id })) : null;
}

// Totals of a list of ends.
export function scoreTotals(ends = [], arrowsPerEnd = 3) {
  const t = { score: 0, arrows: 0, xs: 0, tens: 0, completedEnds: 0 };
  ends.forEach(s => {
    const arrows = parseArrows(s);
    if (arrows.length === 0) return;
    t.score += Number(s.end_total) || 0;
    t.arrows += arrows.length;
    t.xs += Number(s.x_count) || 0;
    t.tens += Number(s.ten_count) || 0;
    if (arrows.length >= (arrowsPerEnd || 3)) t.completedEnds++;
  });
  return t;
}

// Replace (or add) one end score in a list, matched by participant, round and end.
export function upsertScore(scores = [], score) {
  const same = s => s.participant_id === score.participant_id
    && Number(s.round_number) === Number(score.round_number)
    && Number(s.end_number) === Number(score.end_number);
  const out = scores.filter(s => !same(s));
  out.push(score);
  return out;
}

// ---------------------------------------------------------------------------
// Event pages
// raw = { event, participants: [], scores: [], groups: [], notes: [] } (document data)
// ---------------------------------------------------------------------------

function enrichParticipant(p, pScores, arrowsPerEnd, extra = {}) {
  const t = scoreTotals(pScores, arrowsPerEnd);
  return {
    ...p,
    ...extra,
    designation: `${p.bale_number || 1}${p.position || "A"}`,
    running_total: t.score,
    x_count: t.xs,
    ten_count: t.tens,
    arrows_shot: t.arrows,
    ends_completed: t.completedEnds,
    avg_per_arrow: t.arrows > 0 ? (t.score / t.arrows).toFixed(2) : "0.00",
    scores: pScores
  };
}

function scoresWithArrays(scores) {
  return (scores || []).map(s => ({ ...s, arrows: parseArrows(s) }));
}

function groupScores(scores, participantIds) {
  const by = {};
  participantIds.forEach(id => { by[id] = []; });
  scores.forEach(s => {
    if (!by[s.participant_id]) by[s.participant_id] = [];
    by[s.participant_id].push(s);
  });
  return by;
}

function simpleLeaderboard(participants) {
  return [...participants]
    .sort((a, b) => (b.running_total - a.running_total) || (b.x_count - a.x_count) || (b.ten_count - a.ten_count))
    .map((p, idx) => ({ ...p, rank: idx + 1, category_rank: idx + 1 }));
}

// League event (public scoring page).
export function buildLeagueEventData(raw, { rosterBadges = new Map(), now = new Date() } = {}) {
  if (!raw || !raw.event) return { success: false, error: "Event not found" };
  const ev = { ...raw.event };
  ev.midpoint_end = Math.floor((ev.ends_per_round || 10) / 2) + 1;
  Object.assign(ev, leagueEventLockFields(ev, now));

  const participants = (raw.participants || []).map(p => {
    const name = archerDirectory.display(p.name);
    return { ...p, name, avatar_id: rosterBadges.get(archerDirectory.key(name)) || p.avatar_id || null };
  });
  participants.sort((a, b) => (Number(a.bale_number) - Number(b.bale_number)) || String(a.position).localeCompare(String(b.position)));

  const eventScores = scoresWithArrays(raw.scores);
  const byPart = groupScores(eventScores, participants.map(p => p.id));

  const enrichedParticipants = participants.map(p =>
    enrichParticipant(p, byPart[p.id] || [], ev.arrows_per_end, { bow_category: p.bow_category || "BAREBOW" })
  );

  const totalEndsPerArcher = (ev.rounds || 1) * (ev.ends_per_round || 10);
  ev.all_scores_filled = enrichedParticipants.length > 0 && enrichedParticipants.every(p => p.ends_completed >= totalEndsPerArcher);
  ev.is_finished = Boolean(ev.is_locked || ev.status === "COMPLETED" || ev.all_scores_filled);

  const categoryRankCounters = { BAREBOW: 0, OLYMPIC_RECURVE: 0, TRADITIONAL: 0, COMPOUND: 0 };
  const leaderboard = [...enrichedParticipants].sort((a, b) => {
    if (b.running_total !== a.running_total) return b.running_total - a.running_total;
    if (b.x_count !== a.x_count) return b.x_count - a.x_count;
    if (b.ten_count !== a.ten_count) return b.ten_count - a.ten_count;
    return String(a.designation || "").localeCompare(String(b.designation || ""));
  }).map((p, idx) => {
    const cat = p.bow_category || "BAREBOW";
    categoryRankCounters[cat] = (categoryRankCounters[cat] || 0) + 1;
    return { ...p, rank: idx + 1, category_rank: categoryRankCounters[cat] };
  });

  const leaderboardByCategory = {
    BAREBOW: leaderboard.filter(p => (p.bow_category || "BAREBOW") === "BAREBOW"),
    OLYMPIC_RECURVE: leaderboard.filter(p => p.bow_category === "OLYMPIC_RECURVE"),
    TRADITIONAL: leaderboard.filter(p => p.bow_category === "TRADITIONAL"),
    COMPOUND: leaderboard.filter(p => p.bow_category === "COMPOUND")
  };

  const groups = (raw.groups || []).map(g => ({ ...g, bales: Array.isArray(g.bales) ? g.bales.map(Number) : [] }));
  groups.sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
  if (groups.length === 0) {
    const baleSet = new Set();
    participants.forEach(p => { if (p.bale_number) baleSet.add(Number(p.bale_number)); });
    const bales = Array.from(baleSet).sort((a, b) => a - b);
    const step = Math.max(1, Number(ev.bales_per_group) || 2);
    for (let i = 0; i < bales.length; i += step) {
      const groupBales = bales.slice(i, i + step);
      const gNum = Math.floor(i / step) + 1;
      const baleLabel = groupBales.length > 1 ? `Bales ${groupBales.join(" & ")}` : `Bale ${groupBales[0]}`;
      groups.push({
        id: "grp_" + ev.id + "_" + gNum,
        event_id: ev.id,
        name: `Scoring Group ${gNum} (${baleLabel})`,
        bales: groupBales,
        nominated_scorer: "",
        current_round: 1,
        current_end: 1
      });
    }
    if (groups.length === 0) {
      groups.push({ id: "grp_" + ev.id + "_1", event_id: ev.id, name: "Scoring Group 1 (Bale 1)", bales: [1], nominated_scorer: "", current_round: 1, current_end: 1 });
    }
  }

  return {
    success: true,
    data: {
      event: ev,
      participants: enrichedParticipants,
      groups,
      leaderboard,
      leaderboard_by_category: leaderboardByCategory,
      scores: eventScores
    }
  };
}

// A league event seen from a Private Hub: only the hub's linked archers.
export function buildPrivateLeagueEventData(raw, { rosterBadges = new Map(), linkedArchers = [], now = new Date() } = {}) {
  if (!raw || !raw.event) return { success: false, error: "League event not found" };
  const rawId = raw.event.id;
  const ev = { ...raw.event };
  const notesMap = leagueNotesMap(raw.notes || []);

  ev.id = `league:${rawId}`;
  ev.raw_league_id = rawId;
  ev.is_league_synced = true;
  ev.session_category = "League";
  ev.midpoint_end = Math.floor((ev.ends_per_round || 10) / 2) + 1;
  Object.assign(ev, leagueEventLockFields(ev, now));

  const matchedParts = [];
  (raw.participants || []).forEach(p => {
    const canonical = normalizeLinkedArcherMatch(p.name, linkedArchers);
    if (canonical) matchedParts.push({ ...p, name: canonical, avatar_id: badgeFrom(rosterBadges, canonical, p.avatar_id) });
  });

  const matchedIds = new Set(matchedParts.map(p => p.id));
  const eventScores = scoresWithArrays(raw.scores).filter(s => matchedIds.has(s.participant_id));
  const byPart = groupScores(eventScores, matchedParts.map(p => p.id));

  const enrichedParticipants = matchedParts.map(p => {
    const aKey = archerDirectory.key(p.name);
    return enrichParticipant(p, (byPart[p.id] || []).sort(sortByRoundEnd), ev.arrows_per_end, {
      bow_category: "BAREBOW",
      archer_notes: notesMap[`${rawId}_${aKey}`] || ""
    });
  });

  const totalEndsPerArcher = (ev.rounds || 1) * (ev.ends_per_round || 10);
  ev.all_scores_filled = enrichedParticipants.length > 0 && enrichedParticipants.every(p => p.ends_completed >= totalEndsPerArcher);
  ev.is_finished = Boolean(ev.all_scores_filled || ev.is_locked);

  const leaderboard = simpleLeaderboard(enrichedParticipants);
  const groups = (raw.groups || []).map(g => ({ ...g, bales: Array.isArray(g.bales) ? g.bales.map(Number) : [] }));

  return {
    success: true,
    data: {
      event: ev,
      participants: enrichedParticipants,
      groups: groups.length > 0 ? groups : [{ id: `grp_${rawId}_1`, event_id: ev.id, name: "Scoring Group 1", bales: [1, 2, 3, 4, 5, 6], current_round: 1, current_end: 1 }],
      leaderboard,
      leaderboard_by_category: { BAREBOW: leaderboard, OLYMPIC_RECURVE: [], TRADITIONAL: [] },
      scores: eventScores
    }
  };
}

// A Private Hub session.
export function buildPrivateSessionData(raw, { rosterBadges = new Map() } = {}) {
  if (!raw || !raw.event) return { success: false, error: "Private session not found" };
  const ev = { ...raw.event };
  ev.midpoint_end = Math.floor((ev.ends_per_round || 10) / 2) + 1;
  ev.is_locked = false;

  const participants = (raw.participants || []).map(p => {
    const name = archerDirectory.display(p.name);
    return { ...p, name, avatar_id: badgeFrom(rosterBadges, name, p.avatar_id) };
  });
  participants.sort((a, b) => (Number(a.bale_number) - Number(b.bale_number)) || String(a.position).localeCompare(String(b.position)));

  const eventScores = scoresWithArrays(raw.scores);
  const byPart = groupScores(eventScores, participants.map(p => p.id));

  const enrichedParticipants = participants.map(p =>
    enrichParticipant(p, (byPart[p.id] || []).sort(sortByRoundEnd), ev.arrows_per_end, {
      bow_category: p.bow_category || "BAREBOW",
      archer_notes: p.archer_notes || ""
    })
  );

  const totalEndsPerArcher = (ev.rounds || 1) * (ev.ends_per_round || 10);
  ev.all_scores_filled = enrichedParticipants.length > 0 && enrichedParticipants.every(p => p.ends_completed >= totalEndsPerArcher);
  ev.is_finished = ev.all_scores_filled;

  const leaderboard = simpleLeaderboard(enrichedParticipants);
  const groups = (raw.groups || []).map(g => ({ ...g, bales: Array.isArray(g.bales) ? g.bales.map(Number) : [1] }));
  if (groups.length === 0) {
    groups.push({ id: `grp_${ev.id}_1`, event_id: ev.id, name: "Scoring Group 1 (Bale 1)", bales: [1, 2], nominated_scorer: "", current_round: 1, current_end: 1 });
  }

  return {
    success: true,
    data: {
      event: ev,
      participants: enrichedParticipants,
      groups,
      leaderboard,
      leaderboard_by_category: { BAREBOW: leaderboard, OLYMPIC_RECURVE: [], TRADITIONAL: [] },
      scores: eventScores
    }
  };
}

// ---------------------------------------------------------------------------
// Hub list cards
// endsByParticipant: participant id -> ends (from score_summary, or end scores as a fallback)
// ---------------------------------------------------------------------------

function participantSummary(p, ends, arrowsPerEnd, note) {
  const t = scoreTotals(ends, arrowsPerEnd);
  return {
    stats: t,
    card: {
      id: p.id,
      name: p.name,
      avatar_id: p.avatar_id || null,
      score: t.score,
      arrows: t.arrows,
      avg: t.arrows > 0 ? (t.score / t.arrows).toFixed(2) : null,
      xs: t.xs,
      tens: t.tens,
      archer_notes: note
    }
  };
}

export function buildPrivateSessionCard(ev, parts = [], endsByParticipant = {}, { rosterBadges = new Map() } = {}) {
  const cat = ev.session_category || "Practice";
  const people = parts
    .map(p => {
      const name = archerDirectory.display(p.name);
      return { ...p, name, avatar_id: badgeFrom(rosterBadges, name, p.avatar_id) };
    })
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));

  let completedEndsCount = 0;
  const participantSummaries = [];
  people.forEach(p => {
    const { stats, card } = participantSummary(p, endsByParticipant[p.id] || [], ev.arrows_per_end, String(p.archer_notes || "").trim());
    completedEndsCount += stats.completedEnds;
    if (stats.arrows > 0 || card.archer_notes) participantSummaries.push(card);
  });

  const totalExpectedEnds = people.length * (ev.rounds || 1) * (ev.ends_per_round || 10);
  return {
    ...ev,
    start_time: ev.start_time || "18:00",
    session_category: cat,
    distance: ev.distance || "18m",
    target_face: ev.target_face || "Multi-color face",
    swap_top_bottom: Boolean(ev.swap_top_bottom),
    participant_count: participantSummaries.length || people.length,
    participant_summaries: participantSummaries,
    group_count: 1,
    all_scores_filled: people.length > 0 && completedEndsCount >= totalExpectedEnds,
    is_locked: false
  };
}

// A league event as a Private Hub card, or null when none of the hub's archers shot in it.
export function buildSyncedLeagueCard(ev, parts = [], endsByParticipant = {}, { rosterBadges = new Map(), linkedArchers = [], notesMap = {}, now = new Date() } = {}) {
  if (isTestLeagueEventName(ev.name)) return null;
  const participantSummaries = [];
  let completedEndsCount = 0;
  let activeCount = 0;
  parts.forEach(p => {
    const canonicalName = normalizeLinkedArcherMatch(p.name, linkedArchers);
    if (!canonicalName) return;
    const note = notesMap[`${ev.id}_${archerDirectory.key(canonicalName)}`] || "";
    const person = { ...p, name: canonicalName, avatar_id: badgeFrom(rosterBadges, canonicalName, p.avatar_id) };
    const { stats, card } = participantSummary(person, endsByParticipant[p.id] || [], ev.arrows_per_end, note);
    if (stats.arrows > 0 || note) {
      activeCount++;
      completedEndsCount += stats.completedEnds;
      participantSummaries.push(card);
    }
  });
  if (participantSummaries.length === 0) return null;

  const totalExpectedEnds = activeCount * (ev.rounds || 1) * (ev.ends_per_round || 10);
  return {
    ...ev,
    id: `league:${ev.id}`,
    raw_league_id: ev.id,
    is_league_synced: true,
    start_time: ev.start_time || "18:00",
    session_category: "League",
    distance: "18m",
    target_face: "Multi-color face",
    swap_top_bottom: Boolean(ev.swap_top_bottom),
    participant_count: participantSummaries.length,
    participant_summaries: participantSummaries,
    group_count: 1,
    all_scores_filled: activeCount > 0 && completedEndsCount >= totalExpectedEnds,
    ...leagueEventLockFields(ev, now)
  };
}

export function buildLeagueHubCard(ev, participantCount = 0, now = new Date()) {
  return {
    ...ev,
    participant_count: Number(participantCount) || 0,
    ...leagueEventLockFields(ev, now)
  };
}

// ---------------------------------------------------------------------------
// Analytics (Private Hub progression charts)
// ---------------------------------------------------------------------------

const VALUE_MAP_USAA = { X: 10, "10": 10, "9": 9, "8": 8, "7": 7, "6": 6, "5": 5, "4": 4, "3": 3, "2": 2, "1": 1, M: 0 };
const VALUE_MAP_NFAA = { X: 5, "5": 5, "4": 4, "3": 3, "2": 2, "1": 1, M: 0 };

// events: [{ id, date, ... }], participants: [{ id, event_id, name, ... }],
// endsByParticipant: participant id -> ends.
export function buildArcherAnalytics({ events = [], participants = [], endsByParticipant = {}, rosterBadges = new Map() }) {
  const sortedEvents = [...events].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const eventMap = {};
  sortedEvents.forEach(e => { eventMap[e.id] = e; });

  const archerSessionsMap = {};
  participants.forEach(p => {
    const ev = eventMap[p.event_id];
    if (!ev) return;
    const pScores = (endsByParticipant[p.id] || [])
      .map(s => ({ ...s, arrows: parseArrows(s) }))
      .filter(s => s.arrows.length > 0)
      .sort(sortByRoundEnd);
    if (pScores.length === 0) return;

    const normName = archerDirectory.display(p.name);
    const key = archerDirectory.key(normName);
    if (!archerSessionsMap[key]) {
      archerSessionsMap[key] = {
        name: normName,
        avatar_id: badgeFrom(rosterBadges, normName, p.avatar_id),
        bow_category: p.bow_category || "BAREBOW",
        sessions: []
      };
    }

    const isNfaa = String(ev.scoring_type || "").startsWith("NFAA");
    const valMap = isNfaa ? VALUE_MAP_NFAA : VALUE_MAP_USAA;
    const maxArrowVal = isNfaa ? 5 : 10;

    let totalScore = 0, totalArrows = 0, totalXs = 0, totalTens = 0;
    const ringCounts = { X: 0, "10": 0, "9": 0, "8": 0, "7": 0, "6": 0, "5": 0, "4": 0, "3": 0, "2": 0, "1": 0, M: 0 };
    const colorCounts = { Gold: 0, Red: 0, Blue: 0, Black: 0, White: 0, Miss: 0 };
    const arrowValues = [];
    const endDetails = [];

    pScores.forEach(s => {
      totalScore += Number(s.end_total) || 0;
      totalXs += Number(s.x_count) || 0;
      totalTens += Number(s.ten_count) || 0;
      totalArrows += s.arrows.length;

      const endArrowVals = [];
      s.arrows.forEach(a => {
        const cleanA = String(a).toUpperCase();
        const val = valMap[cleanA] ?? 0;
        arrowValues.push(val);
        endArrowVals.push(val);
        if (ringCounts[cleanA] !== undefined) ringCounts[cleanA]++;
        if (cleanA === "X" || cleanA === "10" || cleanA === "9") colorCounts.Gold++;
        else if (cleanA === "8" || cleanA === "7") colorCounts.Red++;
        else if (cleanA === "6" || cleanA === "5") colorCounts.Blue++;
        else if (cleanA === "4" || cleanA === "3") colorCounts.Black++;
        else if (cleanA === "2" || cleanA === "1") colorCounts.White++;
        else colorCounts.Miss++;
      });

      endDetails.push({
        round_number: s.round_number,
        end_number: s.end_number,
        arrows: s.arrows,
        arrow_values: endArrowVals,
        end_total: s.end_total,
        end_avg: s.arrows.length > 0 ? Number((s.end_total / s.arrows.length).toFixed(2)) : 0,
        x_count: s.x_count,
        ten_count: s.ten_count
      });
    });

    const avgPerArrow = totalArrows > 0 ? Number((totalScore / totalArrows).toFixed(2)) : 0;
    const normalized300 = totalArrows > 0 ? Math.round((totalScore / totalArrows) * 30) : 0;
    const maxPossible = totalArrows * maxArrowVal;

    let arrowStdDev = 0;
    if (arrowValues.length > 1) {
      const mean = totalScore / arrowValues.length;
      const variance = arrowValues.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / arrowValues.length;
      arrowStdDev = Number(Math.sqrt(variance).toFixed(2));
    }

    const effectiveNote = String(p.archer_notes || "").trim();
    archerSessionsMap[key].sessions.push({
      event_id: ev.id,
      event_name: ev.name,
      date: ev.date,
      session_category: ev.session_category || "Practice",
      distance: ev.distance || "18m",
      target_face: ev.target_face || "Multi-color face",
      notes: effectiveNote,
      archer_notes: effectiveNote,
      scoring_type: ev.scoring_type,
      ends_per_round: ev.ends_per_round,
      arrows_per_end: ev.arrows_per_end,
      ends_shot: pScores.length,
      arrows_shot: totalArrows,
      total_score: totalScore,
      max_possible: maxPossible,
      normalized_300: normalized300,
      avg_per_arrow: avgPerArrow,
      x_count: totalXs,
      golds_10s: totalTens,
      gold_9plus_count: colorCounts.Gold,
      gold_pct: totalArrows > 0 ? Number(((colorCounts.Gold / totalArrows) * 100).toFixed(1)) : 0,
      ten_pct: totalArrows > 0 ? Number(((totalTens / totalArrows) * 100).toFixed(1)) : 0,
      arrow_std_dev: arrowStdDev,
      ring_counts: ringCounts,
      color_counts: colorCounts,
      ends: endDetails
    });
  });

  const archersAnalytics = {};
  for (const [key, data] of Object.entries(archerSessionsMap)) {
    const sessions = data.sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.event_id).localeCompare(String(b.event_id)));
    sessions.forEach((sess, idx) => {
      const windowSlice = sessions.slice(Math.max(0, idx - 2), idx + 1);
      const winArrows = windowSlice.reduce((s, x) => s + x.arrows_shot, 0);
      const winScore = windowSlice.reduce((s, x) => s + x.total_score, 0);
      sess.rolling_3_avg = winArrows > 0 ? Number((winScore / winArrows).toFixed(2)) : sess.avg_per_arrow;
    });
    archersAnalytics[key] = { name: data.name, avatar_id: data.avatar_id, bow_category: data.bow_category, sessions };
  }

  return { archers: archersAnalytics, total_events: sortedEvents.length };
}

// ---------------------------------------------------------------------------
// Paging: merge several newest-first streams into one, a page at a time.
//
// sources: [{ fetchMore: async () => ({ items, done }) }]. Each source returns
// its items newest first; a fetch may return no items without being done.
// compare(a, b) < 0 when a comes first. On a tie the earlier source wins.
// skip(item, emitted) drops an item (e.g. a duplicate of one already shown).
// ---------------------------------------------------------------------------

export function createMergedPager(sources, { compare = sortEventsNewestFirst, skip = () => false, maxFetchesPerPage = 50 } = {}) {
  const state = sources.map(s => ({ source: s, buffer: [], done: false }));
  const emitted = [];

  async function fill(st) {
    let guard = 0;
    while (st.buffer.length === 0 && !st.done) {
      const res = await st.source.fetchMore();
      st.buffer.push(...((res && res.items) || []));
      st.done = Boolean(!res || res.done);
      if (++guard >= maxFetchesPerPage) break;
    }
  }

  return {
    emitted,
    get hasMore() {
      return state.some(st => st.buffer.length > 0 || !st.done);
    },
    async next(count) {
      const page = [];
      while (page.length < count) {
        await Promise.all(state.map(fill));
        let best = null;
        state.forEach(st => {
          if (st.buffer.length === 0) return;
          if (!best || compare(st.buffer[0], best.buffer[0]) < 0) best = st;
        });
        if (!best) break;
        const item = best.buffer.shift();
        if (skip(item, emitted)) continue;
        emitted.push(item);
        page.push(item);
      }
      return page;
    }
  };
}
