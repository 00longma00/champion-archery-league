// Firebase Backend Adapter for Archery League
import { 
  db, 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  where, 
  orderBy,
  onSnapshot,
  app
} from "./firebase-config.js";
import { writeBatch, limit, startAfter, deleteField, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { deriveHubKey, generateSaltHex, sha256Hex, HUB_KEY_VERSION } from "./hub-keys.js";
import { leagueEventLockFields, computeEventLockStatus } from "./event-lock.js";
import { archerDirectory } from "./archer-names.js";
import { normalizeBaleCapacities } from "./bale-capacity.js";
import { isPresetAvatar, leastUsedAvatar, planArcherAvatars, rosterAvatarsByArcher } from "./archer-avatars.js";
import {
  chunk,
  parseArrows,
  normalizeLinkedArcherMatch,
  leagueNotesMap,
  linkedArcherNames,
  isTestLeagueEventName,
  sortEventsNewestFirst,
  buildScoreSummary,
  summaryEnds,
  upsertScore,
  buildLeagueEventData,
  buildPrivateLeagueEventData,
  buildPrivateSessionData,
  buildPrivateSessionCard,
  buildSyncedLeagueCard,
  buildLeagueHubCard,
  buildArcherAnalytics,
  createMergedPager
} from "./scoring-data.js";

// Same SDK version as firebase-config.js; loaded only when the Private Hub needs it.
const FIREBASE_AUTH_URL = "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// Roster docs as { id: <doc id>, ...fields }, teaching the name directory as they load.
// The latest list is cached briefly so pages that refresh every few seconds can show
// each archer's badge without re-reading the roster each time.
let rosterCache = null;
let rosterCacheAt = 0;
const ROSTER_CACHE_MS = 5 * 60 * 1000;

function rosterDocsFrom(snap) {
  const docs = [];
  if (snap) snap.forEach(d => docs.push({ ...d.data(), id: d.id }));
  archerDirectory.learn(docs);
  rosterCache = docs;
  rosterCacheAt = Date.now();
  return docs;
}

async function loadRosterDocs() {
  if (rosterCache && Date.now() - rosterCacheAt < ROSTER_CACHE_MS) return rosterCache;
  return rosterDocsFrom(await getDocs(collection(db, "roster")));
}

function forgetRosterCache() {
  rosterCache = null;
}

// The badge an archer wore most recently in a league, from past event participants.
async function previousBadgeFor(name, rosterDocs) {
  const [pSnap, evSnap] = await Promise.all([
    getDocs(collection(db, "event_participants")),
    getDocs(collection(db, "scoring_events"))
  ]);
  const dates = {};
  evSnap.forEach(d => { dates[d.id] = d.data().date || ""; });
  const pastEntries = [];
  pSnap.forEach(d => {
    const p = d.data();
    pastEntries.push({ name: p.name, avatar_id: p.avatar_id, date: dates[p.event_id] || "" });
  });
  const plan = planArcherAvatars({ roster: rosterDocs, pastEntries, assignNewSince: "9999-12-31" });
  const entry = plan.get(archerDirectory.key(name));
  return entry ? entry.avatarId : null;
}

// One roster entry per archer, under their full name. Older docs saved under a
// short name ("long") fold into the same archer; the first non-empty field wins.
function rosterByArcher(rosterDocs) {
  const byKey = new Map();
  rosterDocs.forEach(({ id, ...r }) => {
    const name = archerDirectory.display(r.name || id);
    const key = archerDirectory.key(name);
    if (!key) return;
    const merged = byKey.get(key) || { name };
    for (const [field, value] of Object.entries(r)) {
      if (field !== 'name' && (merged[field] === undefined || merged[field] === null || merged[field] === '')) merged[field] = value;
    }
    byKey.set(key, merged);
  });
  return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Latest RSVP per archer, under their full name ("Long" and "Long Ma" are one person).
function latestRsvpPerArcher(rsvps) {
  const byKey = new Map();
  rsvps.forEach(r => {
    const archerName = archerDirectory.display(r.archerName);
    const key = archerDirectory.key(archerName);
    const prev = byKey.get(key);
    if (!prev || String(r.updatedAt || '') >= String(prev.updatedAt || '')) byKey.set(key, { ...r, archerName });
  });
  return Array.from(byKey.values());
}

// Helper: Calculate next upcoming Sunday
export function getUpcomingSundayStr() {
  const now = new Date();
  const day = now.getDay(); // 0 is Sunday
  const daysUntilSunday = (7 - day) % 7;
  const target = new Date(now);
  target.setDate(now.getDate() + daysUntilSunday);
  const yyyy = target.getFullYear();
  const mm = String(target.getMonth() + 1).padStart(2, '0');
  const dd = String(target.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 1. Get State for index.html (Roster, Config, RSVPs for upcoming Sunday)
export async function getAppState() {
  const currentSunday = getUpcomingSundayStr();
  
  // Fetch App Config, Roster, and upcoming Sunday RSVPs in parallel
  let config = { leagueTime: "6:00 PM", defaultStatus: "PENDING" };
  let event = { status: "PENDING" };
  let archers = [];
  let rsvps = [];

  const [stateSnap, rosterDocs, rsvpSnap] = await Promise.all([
    getDoc(doc(db, "app_state", "current")).catch(e => { console.error("Error reading app_state:", e); return null; }),
    loadRosterDocs().catch(e => { console.error("Error reading roster:", e); return []; }),
    getDocs(query(collection(db, "rsvps"), where("date", "==", currentSunday))).catch(e => { console.error("Error reading rsvps:", e); return null; })
  ]);

  if (stateSnap && stateSnap.exists()) {
    const data = stateSnap.data();
    if (data.config) config = { ...config, ...data.config };
    if (data.event) event = { ...event, ...data.event };
  }
  archers = rosterByArcher(rosterDocs);
  if (rsvpSnap) {
    rsvpSnap.forEach(d => rsvps.push(d.data()));
  }
  rsvps = latestRsvpPerArcher(rsvps);

  // Count archers who have checked in (RSVP YES) for upcoming session
  const checkedInCount = rsvps.filter(r => r.status === 'YES').length;

  // After previous session completes / if nobody has checked in for this session, set status to PENDING
  if (checkedInCount === 0) {
    const previousStatus = event.status;
    event.status = 'PENDING';
    event.date = currentSunday;
    // Auto-sync PENDING status to Firestore if it was previously set to ON or from a previous date
    if (stateSnap && stateSnap.exists() && (previousStatus !== 'PENDING' || stateSnap.data().event?.date !== currentSunday)) {
      updateDoc(doc(db, "app_state", "current"), {
        "event.status": "PENDING",
        "event.date": currentSunday,
        "event.updatedAt": new Date().toISOString()
      }).catch(err => console.warn("Auto-sync pending status to Firestore:", err));
    }
  }

  return {
    upcomingSunday: currentSunday,
    config,
    event,
    archers,
    rsvps
  };
}

// 2. Submit / Update RSVP
export async function submitRsvp({ name, status, avatarId, bowCategory }) {
  const currentSunday = getUpcomingSundayStr();
  const now = new Date().toISOString();
  const MAX_RSVPS = 50;

  const [rosterSnap, rsvpDateSnap] = await Promise.all([
    getDocs(collection(db, "roster")),
    getDocs(query(collection(db, "rsvps"), where("date", "==", currentSunday)))
  ]);
  const rosterDocs = rosterDocsFrom(rosterSnap);

  // Save under the archer's full name ("Long" -> "Long Ma").
  const cleanName = archerDirectory.display(name);
  const cleanLower = archerDirectory.key(cleanName);
  if (!cleanLower) throw new Error('Please enter your name.');

  // Update this archer's existing RSVP for the Sunday, even if it was saved under a short name.
  let id = `${currentSunday}_${cleanLower}`;
  rsvpDateSnap.forEach(d => {
    if (archerDirectory.key(d.data().archerName) === cleanLower) id = d.id;
  });

  // Enforce upper limit of 50 RSVPs for the upcoming session and 50 archers in roster
  if (!rsvpDateSnap.docs.some(d => d.id === id) && rsvpDateSnap.size >= MAX_RSVPS) {
    throw new Error(`Maximum RSVP limit reached (${MAX_RSVPS} RSVPs allowed per session).`);
  }

  const rosterId = archerDirectory.rosterDocId(cleanName, rosterDocs);
  const rosterRef = doc(db, "roster", rosterId);
  if (!rosterDocs.some(r => r.id === rosterId) && rosterDocs.length >= MAX_RSVPS) {
    throw new Error(`League roster is full (maximum ${MAX_RSVPS} archers allowed).`);
  }

  // Badge: the one picked on the form, else the archer's own, else the one they wore
  // before, else one nobody on the roster wears yet.
  const finalAvatarId = isPresetAvatar(avatarId)
    ? avatarId
    : rosterAvatarsByArcher(rosterDocs).get(cleanLower)
      || await previousBadgeFor(cleanName, rosterDocs)
      || leastUsedAvatar(rosterDocs.map(r => r.avatarId));

  // Save/update RSVP
  const rsvpPayload = {
    date: currentSunday,
    archerName: cleanName,
    status,
    avatarId: finalAvatarId,
    bowCategory: bowCategory || 'BAREBOW',
    note: '',
    updatedAt: now
  };
  await setDoc(doc(db, "rsvps", id), rsvpPayload, { merge: true });

  // Update Roster profile so chosen avatar/bow persist
  const updateData = {
    name: cleanName,
    avatarId: finalAvatarId,
    bowCategory: bowCategory || 'BAREBOW'
  };

  await setDoc(rosterRef, updateData, { merge: true });
  forgetRosterCache();

  return { success: true };
}

// 3. Update Admin Status (ON/OFF/PENDING, league time)
export async function updateAdminStatus({ status, leagueTime }) {
  const currentSunday = getUpcomingSundayStr();
  const now = new Date().toISOString();

  const update = {
    "config.leagueTime": leagueTime || "6:00 PM",
    "event.status": status || "PENDING",
    "event.date": currentSunday,
    "event.updatedAt": now
  };
  await updateDoc(doc(db, "app_state", "current"), update);
  return { success: true };
}

// ============================================================================
// SHARED READ HELPERS (paging, `in` queries, score summaries)
// ============================================================================

// Documents whose `field` is one of `values`, read 30 values per query.
async function docsWhereIn(collName, field, values) {
  const uniq = [...new Set((values || []).filter(v => v !== undefined && v !== null && v !== ""))];
  const snaps = await Promise.all(chunk(uniq, 30).map(part =>
    getDocs(query(collection(db, collName), where(field, "in", part)))
  ));
  const out = [];
  snaps.forEach(s => s.forEach(d => out.push({ id: d.id, ...d.data() })));
  return out;
}

// Summaries rebuilt while reading, waiting to be saved: { coll, id, summary }.
// They are saved only after the page's reads are done (flushScoreSummaries),
// never while its queries are still running.
let summaryQueue = [];
let summarySaves = Promise.resolve();

// Saves the queued summaries in background batches, one per collection, so a
// device that may not write one collection (a Private Hub it is not signed in
// to) still saves the other. Failures only mean the summary is rebuilt next time.
function flushScoreSummaries() {
  const queued = summaryQueue;
  summaryQueue = [];
  if (queued.length === 0) return summarySaves;
  const byColl = {};
  queued.forEach(q => { (byColl[q.coll] = byColl[q.coll] || []).push(q); });
  const commits = [];
  Object.values(byColl).forEach(list => {
    chunk(list, 400).forEach(part => {
      const batch = writeBatch(db);
      part.forEach(q => batch.update(doc(db, q.coll, q.id), { score_summary: q.summary }));
      commits.push(batch.commit().catch(err => console.debug("Score summaries not saved:", err && err.code)));
    });
  });
  summarySaves = Promise.all([summarySaves, ...commits]).then(() => {});
  return summarySaves;
}

// Resolves once every summary save started so far has finished (used by tests).
export function scoreSummariesSaved() {
  return summarySaves;
}

// participant id -> ends. Ends come from each participant's `score_summary`; a
// participant without one is read from its end scores once, and its summary is
// queued to be saved (when `shouldSave(p)` says so) so the next load skips that.
async function endsForParticipants(parts, scoresColl, partsColl, shouldSave = () => false) {
  const ends = {};
  const missing = [];
  parts.forEach(p => {
    const fromSummary = summaryEnds(p);
    if (fromSummary) ends[p.id] = fromSummary;
    else missing.push(p);
  });
  if (missing.length === 0) return ends;

  const scores = await docsWhereIn(scoresColl, "participant_id", missing.map(p => p.id));
  const byPart = {};
  scores.forEach(s => { (byPart[s.participant_id] = byPart[s.participant_id] || []).push(s); });
  missing.forEach(p => {
    const own = (byPart[p.id] || []).filter(s => !s.event_id || !p.event_id || s.event_id === p.event_id);
    ends[p.id] = own;
    if (shouldSave(p) && !summaryQueue.some(q => q.coll === partsColl && q.id === p.id)) {
      summaryQueue.push({ coll: partsColl, id: p.id, summary: buildScoreSummary(own) });
    }
  });
  return ends;
}

const byDateDesc = (a, b) => String(b.date || "").localeCompare(String(a.date || ""));

// One newest-first stream of events, read `batchSize` at a time with a cursor.
// If the query needs an index that is not deployed yet, the whole list is read
// once and served from memory instead, so the page keeps working.
function pagedEventSource({ makeQuery, fallbackQuery, enrich, batchSize = 10 }) {
  let cursor = null;
  let done = false;
  let rest = null;
  return {
    async fetchMore() {
      if (done) return { items: [], done: true };
      let events;
      if (rest) {
        events = rest.splice(0, batchSize);
        done = rest.length === 0;
      } else {
        try {
          const snap = await getDocs(makeQuery(cursor ? [startAfter(cursor), limit(batchSize)] : [limit(batchSize)]));
          events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          if (snap.docs.length) cursor = snap.docs[snap.docs.length - 1];
          done = snap.docs.length < batchSize;
        } catch (err) {
          if (cursor || !err || err.code !== "failed-precondition") throw err;
          console.warn("Firestore index not deployed yet; loading the full list instead.", err.message);
          const snap = await getDocs(fallbackQuery());
          rest = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byDateDesc);
          events = rest.splice(0, batchSize);
          done = rest.length === 0;
        }
      }
      return { items: events.length ? await enrich(events) : [], done };
    }
  };
}

function hubPage(pager, firstEvents, extra) {
  flushScoreSummaries();
  return {
    success: true,
    events: firstEvents,
    hasMore: pager.hasMore,
    // Next `count` events, and whether any remain after them.
    async loadMore(count = 10) {
      const events = await pager.next(count);
      flushScoreSummaries();
      return { events, hasMore: pager.hasMore };
    },
    ...extra
  };
}

async function countParticipants(eventId) {
  const q = query(collection(db, "event_participants"), where("event_id", "==", eventId));
  try {
    return (await getCountFromServer(q)).data().count;
  } catch (e) {
    return (await getDocs(q)).size;
  }
}

// A participant from the page, without what the page computed or the stored score
// summary (which only score saves write), so a bale save cannot overwrite it.
function participantFields(p) {
  const { score_summary, scores, running_total, x_count, ten_count, pure_ten_count, nine_count, arrow_std_dev, arrows_shot, ends_completed, avg_per_arrow, designation, rank, category_rank, ...rest } = p || {};
  return rest;
}

// 4. Scoring: List Events Hub
export async function getScoringEventsHub({ pageSize = 10 } = {}) {
  const sunday = getUpcomingSundayStr();
  const now = new Date();
  const batchSize = Math.min(30, Math.max(5, pageSize));
  const source = pagedEventSource({
    batchSize,
    makeQuery: page => query(collection(db, "scoring_events"), orderBy("date", "desc"), ...page),
    fallbackQuery: () => collection(db, "scoring_events"),
    enrich: async events => {
      const counts = await Promise.all(events.map(ev => countParticipants(ev.id).catch(() => 0)));
      return events.map((ev, i) => buildLeagueHubCard(ev, counts[i], now)).sort(sortEventsNewestFirst);
    }
  });
  const pager = createMergedPager([source], { compare: byDateDesc });

  const [firstEvents, rosterDocs, rsvpSnap] = await Promise.all([
    pager.next(pageSize),
    loadRosterDocs(),
    getDocs(query(collection(db, "rsvps"), where("date", "==", sunday))).catch(() => null)
  ]);

  // Roster and RSVPs for the event creator, one entry per archer under their full name.
  const roster = rosterByArcher(rosterDocs);
  const badgePlan = planArcherAvatars({ roster: rosterDocs, pastEntries: [], assignNewSince: '9999-12-31' });
  const badgeOf = (name) => (badgePlan.get(archerDirectory.key(name)) || {}).avatarId || null;

  const yesRsvps = [];
  if (rsvpSnap) rsvpSnap.forEach(d => { const r = d.data(); if (r.date === sunday) yesRsvps.push(r); });
  const yesArchers = latestRsvpPerArcher(yesRsvps)
    .filter(r => r.status === 'YES')
    .map(r => ({
      name: r.archerName,
      bow_category: r.bowCategory || 'BAREBOW',
      avatar_id: badgeOf(r.archerName) || r.avatarId
    }));

  const allArchers = roster
    .map(r => ({ name: r.name, bow_category: r.bowCategory || 'BAREBOW', avatar_id: badgeOf(r.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return hubPage(pager, firstEvents, {
    roster,
    rsvpImport: { date: sunday, yesArchers, allArchers }
  });
}

// Where an event page's documents live, and how they become the page's data.
function eventPlan(eventId, { hubId = null, linkedArchers = [] } = {}) {
  const id = String(eventId || "");
  if (hubId && id.startsWith("league:")) {
    const rawId = id.replace(/^league:/, "");
    const names = linkedArcherNames(linkedArchers);
    return {
      key: id,
      refs: {
        event: doc(db, "scoring_events", rawId),
        participants: query(collection(db, "event_participants"), where("event_id", "==", rawId)),
        scores: query(collection(db, "end_scores"), where("event_id", "==", rawId)),
        groups: query(collection(db, "scoring_groups"), where("event_id", "==", rawId)),
        notes: query(collection(db, "private_league_notes"), where("hub_id", "==", hubId))
      },
      build: (raw, rosterBadges) => buildPrivateLeagueEventData(raw, { rosterBadges, linkedArchers: names })
    };
  }
  if (hubId) {
    return {
      key: id,
      refs: {
        event: doc(db, "private_events", id),
        participants: query(collection(db, "private_participants"), where("event_id", "==", id)),
        scores: query(collection(db, "private_end_scores"), where("event_id", "==", id)),
        groups: query(collection(db, "private_groups"), where("event_id", "==", id))
      },
      build: (raw, rosterBadges) => buildPrivateSessionData(raw, { rosterBadges })
    };
  }
  return {
    key: id,
    refs: {
      event: doc(db, "scoring_events", id),
      participants: query(collection(db, "event_participants"), where("event_id", "==", id)),
      scores: query(collection(db, "end_scores"), where("event_id", "==", id)),
      groups: query(collection(db, "scoring_groups"), where("event_id", "==", id))
    },
    build: (raw, rosterBadges) => buildLeagueEventData(raw, { rosterBadges })
  };
}

const docList = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));

async function fetchEvent(plan) {
  const { refs } = plan;
  const [evSnap, pSnap, sSnap, gSnap, nSnap, rosterDocs] = await Promise.all([
    getDoc(refs.event),
    getDocs(refs.participants),
    getDocs(refs.scores),
    getDocs(refs.groups),
    refs.notes ? getDocs(refs.notes) : Promise.resolve(null),
    loadRosterDocs().catch(() => [])
  ]);
  const raw = {
    event: evSnap.exists() ? { id: evSnap.id, ...evSnap.data() } : null,
    participants: docList(pSnap),
    scores: docList(sSnap),
    groups: docList(gSnap),
    notes: nSnap ? docList(nSnap) : []
  };
  return plan.build(raw, rosterAvatarsByArcher(rosterDocs));
}

// 5. Scoring: Get Event Data (Full participants, scores, leaderboard)
export async function getEventData(eventId) {
  return fetchEvent(eventPlan(eventId));
}

// The event page currently kept up to date by subscribeToEvent (at most one).
let liveEvent = null;

// Live event page: calls onData({ success, data }) with the first full load and
// again whenever any score, archer, group or the event itself changes. After the
// first load only changed documents are read. Returns a function that stops it.
// Private Hub pages pass { hubId, linkedArchers }.
export function subscribeToEvent(eventId, { hubId = null, linkedArchers = [] } = {}, onData = () => {}, onError = () => {}) {
  const plan = eventPlan(eventId, { hubId, linkedArchers });
  const raw = { event: undefined, participants: undefined, scores: undefined, groups: undefined, notes: plan.refs.notes ? undefined : [] };
  const live = { key: plan.key, raw, rosterBadges: null, build: () => plan.build(raw, live.rosterBadges || new Map()) };
  let stopped = false;
  let scheduled = false;
  const ready = () => live.rosterBadges && Object.values(raw).every(v => v !== undefined);
  const emit = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!stopped && ready()) onData(live.build());
    });
  };
  const fail = err => { if (!stopped) onError(err); };

  loadRosterDocs().catch(() => []).then(docs => { live.rosterBadges = rosterAvatarsByArcher(docs); emit(); });
  const unsubs = [
    onSnapshot(plan.refs.event, s => { raw.event = s.exists() ? { id: s.id, ...s.data() } : null; emit(); }, fail),
    onSnapshot(plan.refs.participants, s => { raw.participants = docList(s); emit(); }, fail),
    onSnapshot(plan.refs.scores, s => { raw.scores = docList(s); emit(); }, fail),
    onSnapshot(plan.refs.groups, s => { raw.groups = docList(s); emit(); }, fail)
  ];
  if (plan.refs.notes) unsubs.push(onSnapshot(plan.refs.notes, s => { raw.notes = docList(s); emit(); }, fail));

  // The lock is time-based, so re-check it every minute (no reads needed).
  let wasLocked = null;
  const lockTimer = setInterval(() => {
    if (!raw.event) return;
    const locked = leagueEventLockFields(raw.event).is_locked;
    if (wasLocked !== null && locked !== wasLocked) emit();
    wasLocked = locked;
  }, 60 * 1000);

  liveEvent = live;
  return () => {
    stopped = true;
    clearInterval(lockTimer);
    unsubs.forEach(u => u());
    if (liveEvent === live) liveEvent = null;
  };
}

// Save one end in a single round trip: the end score and the archer's updated
// summary go in one batch. The lock is enforced by firestore.rules, so there is
// no read first. Returns the refreshed event page when it is being kept live.
async function saveEndScore({ scoresColl, partsColl, scoreId, score, participantId, partFields, liveKeys, deniedMessage }) {
  const live = liveEvent && liveKeys.includes(liveEvent.key) && Array.isArray(liveEvent.raw.scores) ? liveEvent : null;
  let summary = deleteField(); // unknown here: drop it so lists rebuild it from the end scores
  if (live) {
    const own = upsertScore(live.raw.scores.filter(s => s.participant_id === participantId), score);
    summary = buildScoreSummary(own);
  }
  const batch = writeBatch(db);
  batch.set(doc(db, scoresColl, scoreId), score, { merge: true });
  batch.set(doc(db, partsColl, participantId), { ...partFields, score_summary: summary }, { merge: true });
  try {
    await batch.commit();
  } catch (err) {
    if (err && err.code === "permission-denied") throw new Error(deniedMessage);
    throw err;
  }
  if (!live) return { success: true };
  live.raw.scores = upsertScore(live.raw.scores, score);
  if (Array.isArray(live.raw.participants)) {
    live.raw.participants = live.raw.participants.map(p => p.id === participantId ? { ...p, score_summary: summary } : p);
  }
  const res = live.build();
  return res.success ? { success: true, data: res.data } : { success: true };
}

// 6. Scoring: Submit End Score
export async function submitEndScore({ eventId, participantId, roundNumber, endNumber, arrows, endTotal, xCount, tenCount, scoredBy }) {
  const id = `es_${eventId}_${participantId}_${roundNumber}_${endNumber}`;
  const score = {
    id,
    event_id: eventId,
    participant_id: participantId,
    round_number: roundNumber,
    end_number: endNumber,
    arrows,
    arrows_json: JSON.stringify(arrows),
    end_total: endTotal,
    x_count: xCount,
    ten_count: tenCount,
    scored_by: scoredBy,
    updated_at: new Date().toISOString()
  };
  return saveEndScore({
    scoresColl: "end_scores",
    partsColl: "event_participants",
    scoreId: id,
    score,
    participantId,
    partFields: { event_id: eventId },
    liveKeys: [eventId, `league:${eventId}`],
    deniedMessage: "Scoring is locked! Scores cannot be changed more than 8 hours after the scheduled event start time."
  });
}


// 7. Scoring: Create Event
export async function createScoringEvent({ event, participants, groups }) {
  const now = new Date().toISOString();
  const todayPrefix = now.slice(0, 10);
  const targetDate = event.date || todayPrefix;
  const MAX_SESSIONS_PER_DAY = 5;

  // Enforce upper limit of 5 sessions created per day (by event date or creation date)
  const existingEventsSnap = await getDocs(collection(db, "scoring_events"));
  let sameTargetDateCount = 0;
  let createdTodayCount = 0;
  existingEventsSnap.forEach(d => {
    const ev = d.data();
    if (ev.date === targetDate) sameTargetDateCount++;
    if (ev.created_at && String(ev.created_at).startsWith(todayPrefix)) createdTodayCount++;
  });

  if (sameTargetDateCount >= MAX_SESSIONS_PER_DAY || createdTodayCount >= MAX_SESSIONS_PER_DAY) {
    throw new Error(`Daily limit reached: A maximum of ${MAX_SESSIONS_PER_DAY} sessions can be created in one day.`);
  }

  const eventId = event.id || ('evt_' + Date.now());
  const balesPerGroup = Math.max(1, Number(event.bales_per_group) || 2);

  // Clean payload: Firestore rejects undefined values
  const eventData = {
    id: eventId,
    name: event.name || 'Sunday Night League',
    date: event.date || now.slice(0, 10),
    start_time: event.start_time || '18:00',
    max_bales: Number(event.max_bales) || 6,
    bales_per_group: balesPerGroup,
    bale_capacities: normalizeBaleCapacities(event.bale_capacities),
    rounds: Number(event.rounds) || 1,
    ends_per_round: Number(event.ends_per_round) || 10,
    arrows_per_end: Number(event.arrows_per_end) || 3,
    scoring_type: event.scoring_type || 'USAA_10',
    swap_top_bottom: event.swap_top_bottom ? 1 : 0,
    status: event.status || 'SETUP',
    created_at: now,
    updated_at: now
  };
  // Firestore rules use lock_at to reject writes once scoring has closed.
  eventData.lock_at = lockAtFor(eventData.date, eventData.start_time);
  if (leagueEventLockFields(eventData).is_locked) {
    throw new Error("Can't create a league session whose scoring window (8 hours after start) has already closed.");
  }
  await setDoc(doc(db, "scoring_events", eventId), eventData);

  // Construct and save initial groups so they exist immediately in Firestore
  const baleSet = new Set();
  (participants || []).forEach(p => { if (p.bale_number) baleSet.add(Number(p.bale_number)); });
  const bales = Array.from(baleSet).sort((a, b) => a - b);
  if (bales.length === 0) bales.push(1);

  const baleToGroupId = {};
  if (Array.isArray(groups) && groups.length > 0) {
    for (let idx = 0; idx < groups.length; idx++) {
      const g = groups[idx];
      const gId = g.id || ('grp_' + eventId + '_' + (idx + 1));
      const gBales = Array.isArray(g.bales) ? g.bales.map(Number) : [];
      gBales.forEach(b => { baleToGroupId[b] = gId; });
      await setDoc(doc(db, "scoring_groups", gId), {
        id: gId,
        event_id: eventId,
        name: g.name || (`Scoring Group ${idx + 1}`),
        bales: gBales,
        nominated_scorer: g.nominated_scorer || '',
        current_round: 1,
        current_end: 1
      });
    }
  } else {
    for (let i = 0; i < bales.length; i += balesPerGroup) {
      const groupBales = bales.slice(i, i + balesPerGroup);
      const gNum = Math.floor(i / balesPerGroup) + 1;
      const gId = 'grp_' + eventId + '_' + gNum;
      const baleLabel = groupBales.length > 1 ? `Bales ${groupBales.join(' & ')}` : `Bale ${groupBales[0]}`;
      groupBales.forEach(b => { baleToGroupId[b] = gId; });
      await setDoc(doc(db, "scoring_groups", gId), {
        id: gId,
        event_id: eventId,
        name: `Scoring Group ${gNum} (${baleLabel})`,
        bales: groupBales,
        nominated_scorer: '',
        current_round: 1,
        current_end: 1
      });
    }
  }

  if (participants && participants.length > 0) {
    const rosterDocs = rosterDocsFrom(await getDocs(collection(db, "roster")));
    let rosterCount = rosterDocs.length;
    const knownRosterIds = new Set(rosterDocs.map(r => r.id));
    const rosterBadges = rosterAvatarsByArcher(rosterDocs);
    const usedBadges = Array.from(rosterBadges.values());
    // The archer's own badge, else the one they came in with, else one nobody wears yet.
    const badgeFor = (name, incoming) => {
      const key = archerDirectory.key(name);
      if (!rosterBadges.has(key)) {
        const badge = isPresetAvatar(incoming) ? incoming : leastUsedAvatar(usedBadges);
        rosterBadges.set(key, badge);
        usedBadges.push(badge);
      }
      return rosterBadges.get(key);
    };

    for (let idx = 0; idx < participants.length; idx++) {
      const p = participants[idx];
      const pId = p.id || (`p_${eventId}_${idx}`);
      const bNum = Number(p.bale_number) || 1;
      const cleanName = archerDirectory.display(p.name) || 'Archer';
      const avatarId = badgeFor(cleanName, p.avatar_id);
      const bowCat = p.bow_category || 'BAREBOW';
      await setDoc(doc(db, "event_participants", pId), {
        id: pId,
        event_id: eventId,
        name: cleanName,
        bow_category: bowCat,
        avatar_id: avatarId,
        bale_number: bNum,
        position: p.position || 'A',
        shooting_line: p.shooting_line || 'AB',
        lane: p.lane || 'Left',
        initial_target: p.initial_target || 'Top',
        group_id: p.group_id || baleToGroupId[bNum] || ('grp_' + eventId + '_1'),
        sort_order: idx
      });
      // Also persist participant to global roster so walk-in archers who didn't RSVP are saved for future sessions (capped at 50)
      if (cleanName) {
        // Reuse the archer's existing roster doc (e.g. "long" for Long Ma)
        const rKey = archerDirectory.rosterDocId(cleanName, rosterDocs);
        if (knownRosterIds.has(rKey) || rosterCount < 50) {
          const rosterUpdate = {
            name: cleanName,
            bowCategory: bowCat
          };
          if (avatarId) rosterUpdate.avatarId = avatarId;
          await setDoc(doc(db, "roster", rKey), rosterUpdate, { merge: true });
          forgetRosterCache();
          if (!knownRosterIds.has(rKey)) {
            knownRosterIds.add(rKey);
            rosterCount++;
          }
        }
      }
    }
  }

  return { success: true, eventId };
}

// Timestamp after which Firestore rules refuse league scoring writes.
function lockAtFor(date, startTime) {
  return new Date(computeEventLockStatus(date, startTime || '18:00').lock_deadline_iso);
}

// 8. Scoring: Update Event Settings
export async function updateScoringEvent(eventId, fields) {
  const now = new Date().toISOString();
  const update = { ...fields, updated_at: now };
  if (fields.date !== undefined || fields.start_time !== undefined) {
    const snap = await getDoc(doc(db, "scoring_events", eventId));
    const current = snap.exists() ? snap.data() : {};
    update.lock_at = lockAtFor(fields.date ?? current.date, fields.start_time ?? current.start_time);
  }
  await updateDoc(doc(db, "scoring_events", eventId), update);
  return { success: true };
}

// 9. Scoring: Delete Event
export async function deleteScoringEvent(eventId) {
  await deleteDoc(doc(db, "scoring_events", eventId));
  // Delete associated participants
  const pSnap = await getDocs(query(collection(db, "event_participants"), where("event_id", "==", eventId)));
  for (const d of pSnap.docs) { await deleteDoc(d.ref); }
  // Delete associated groups
  const gSnap = await getDocs(query(collection(db, "scoring_groups"), where("event_id", "==", eventId)));
  for (const d of gSnap.docs) { await deleteDoc(d.ref); }
  // Delete associated scores
  const sSnap = await getDocs(query(collection(db, "end_scores"), where("event_id", "==", eventId)));
  for (const d of sSnap.docs) { await deleteDoc(d.ref); }
  return { success: true };
}

// Event fields a bale save changes, or null when it changes none.
function baleEventUpdate(balesPerGroup, baleCapacities) {
  const update = {};
  if (balesPerGroup !== undefined) update.bales_per_group = Number(balesPerGroup) || 2;
  if (baleCapacities !== undefined) update.bale_capacities = normalizeBaleCapacities(baleCapacities);
  if (Object.keys(update).length === 0) return null;
  update.updated_at = new Date().toISOString();
  return update;
}

// 10. Scoring: Save Bale & Group Assignments
export async function saveBaleAssignments(eventId, { participants, groups, balesPerGroup, baleCapacities }) {
  const eventUpdate = baleEventUpdate(balesPerGroup, baleCapacities);
  if (eventUpdate) await updateDoc(doc(db, "scoring_events", eventId), eventUpdate);

  const baleToGroupId = {};
  if (Array.isArray(groups)) {
    // Delete old groups for this event and write new ones
    const oldGSnap = await getDocs(query(collection(db, "scoring_groups"), where("event_id", "==", eventId)));
    for (const d of oldGSnap.docs) {
      await deleteDoc(d.ref);
    }

    for (let idx = 0; idx < groups.length; idx++) {
      const g = groups[idx];
      const gId = g.id || (`grp_${eventId}_${idx + 1}`);
      const gBales = Array.isArray(g.bales) ? g.bales.map(Number) : [];
      gBales.forEach(b => { baleToGroupId[b] = gId; });
      await setDoc(doc(db, "scoring_groups", gId), {
        id: gId,
        event_id: eventId,
        name: g.name || (`Scoring Group ${idx + 1}`),
        bales: gBales,
        nominated_scorer: g.nominated_scorer || '',
        current_round: g.current_round || 1,
        current_end: g.current_end || 1
      });
    }
  }

  if (Array.isArray(participants)) {
    const oldPSnap = await getDocs(query(collection(db, "event_participants"), where("event_id", "==", eventId)));
    const keepIds = new Set();

    const rosterDocs = rosterDocsFrom(await getDocs(collection(db, "roster")));
    let rosterCount = rosterDocs.length;
    const knownRosterIds = new Set(rosterDocs.map(r => r.id));
    const rosterBadges = rosterAvatarsByArcher(rosterDocs);
    const usedBadges = Array.from(rosterBadges.values());
    // The archer's own badge, else the one they came in with, else one nobody wears yet.
    const badgeFor = (name, incoming) => {
      const key = archerDirectory.key(name);
      if (!rosterBadges.has(key)) {
        const badge = isPresetAvatar(incoming) ? incoming : leastUsedAvatar(usedBadges);
        rosterBadges.set(key, badge);
        usedBadges.push(badge);
      }
      return rosterBadges.get(key);
    };

    for (let idx = 0; idx < participants.length; idx++) {
      const p = participants[idx];
      const pId = p.id || (`p_${eventId}_${idx}_${Date.now()}`);
      keepIds.add(pId);
      const bNum = Number(p.bale_number) || 1;
      const resolvedGroupId = baleToGroupId[bNum] || p.group_id || (`grp_${eventId}_1`);
      const cleanName = archerDirectory.display(p.name) || 'Archer';
      const avatarId = badgeFor(cleanName, p.avatar_id);
      const bowCat = p.bow_category || 'BAREBOW';
      await setDoc(doc(db, "event_participants", pId), {
        ...participantFields(p),
        id: pId,
        event_id: eventId,
        name: cleanName,
        bow_category: bowCat,
        avatar_id: avatarId,
        bale_number: bNum,
        group_id: resolvedGroupId,
        sort_order: idx
      }, { merge: true });

      // Also persist participant to global roster so walk-in archers who didn't RSVP are saved for future sessions (capped at 50)
      if (cleanName) {
        // Reuse the archer's existing roster doc (e.g. "long" for Long Ma)
        const rKey = archerDirectory.rosterDocId(cleanName, rosterDocs);
        if (knownRosterIds.has(rKey) || rosterCount < 50) {
          const rosterUpdate = {
            name: cleanName,
            bowCategory: bowCat
          };
          if (avatarId) rosterUpdate.avatarId = avatarId;
          await setDoc(doc(db, "roster", rKey), rosterUpdate, { merge: true });
          forgetRosterCache();
          if (!knownRosterIds.has(rKey)) {
            knownRosterIds.add(rKey);
            rosterCount++;
          }
        }
      }
    }

    // Delete removed participants
    for (const d of oldPSnap.docs) {
      if (!keepIds.has(d.id)) {
        await deleteDoc(d.ref);
      }
    }
  }
  return await getEventData(eventId);
}

// 11. Scoring: Update Group State (Nominated Scorer, Active Round/End)
export async function updateScoringGroupState(groupId, fields) {
  await setDoc(doc(db, "scoring_groups", groupId), fields, { merge: true });
  return { success: true };
}

// ============================================================================
// MY PRIVATE HUB — MULTI-TENANT SPACES, PRACTICE SCORING & LEAGUE AUTO-SYNC
// ============================================================================

function slugifyHubId(name) {
  const clean = String(name || "").trim().toLowerCase();
  if (
    clean === "long & weijia" ||
    clean === "long and weijia" ||
    clean === "my private hub" ||
    clean === "long_weijia" ||
    clean === "long" ||
    clean === "weijia"
  ) {
    return "long_weijia";
  }
  return clean.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "hub_" + Date.now();
}

export async function listPrivateHubSpaces() {
  const snap = await getDocs(collection(db, "private_hubs"));
  const spaces = [];
  snap.forEach(d => {
    const data = d.data();
    spaces.push({
      id: data.id || d.id,
      name: data.name || d.id,
      linked_archers: linkedArcherNames(data.linked_archers),
      passkeys: Array.isArray(data.passkeys) ? data.passkeys : []
    });
  });
  return spaces;
}

// ---------------------------------------------------------------------------
// Device access. Firestore only lets a browser change a hub's data once that
// browser has proved it knows the hub password: each browser gets a hidden
// Firebase anonymous account, and signing in with the password registers that
// account as a member of the hub (private_hub_keys/{hubId}/members/{uid}).
// The rules accept the registration only if sha256(key) matches the hub's
// unreadable key_hash, and only while its `generation` matches the hub's.
// Rotating the key bumps the generation, which signs out every other device.
// ---------------------------------------------------------------------------
let hubAuthPromise = null;

function loadHubAuth() {
  if (!hubAuthPromise) {
    hubAuthPromise = import(FIREBASE_AUTH_URL)
      .then(async mod => {
        const auth = mod.getAuth(app);
        await auth.authStateReady();
        return { auth, mod };
      })
      .catch(err => {
        hubAuthPromise = null;
        throw err;
      });
  }
  return hubAuthPromise;
}

async function hubAuthUser() {
  const { auth, mod } = await loadHubAuth();
  if (auth.currentUser) return auth.currentUser;
  try {
    return (await mod.signInAnonymously(auth)).user;
  } catch (err) {
    if (err && (err.code === "auth/operation-not-allowed" || err.code === "auth/admin-restricted-operation")) {
      throw new Error("Private Hub sign-in isn't switched on yet. Ask the league admin to enable Anonymous sign-in in Firebase Authentication.");
    }
    throw err;
  }
}

function hubKeysRef(hubId) {
  return doc(db, "private_hub_keys", hubId);
}

function hubMemberRef(hubId, uid) {
  return doc(db, "private_hub_keys", hubId, "members", uid);
}

function isPermissionDenied(err) {
  return Boolean(err && err.code === "permission-denied");
}

function hubSummary(data, fallbackId) {
  return {
    id: data.id || fallbackId,
    name: data.name,
    linked_archers: linkedArcherNames(Array.isArray(data.linked_archers) ? data.linked_archers : ["Long", "Weijia"]),
    passkeys: Array.isArray(data.passkeys) ? data.passkeys : []
  };
}

// Hubs get a `generation` when they are secured (new hubs, or by
// `node scripts/hub-admin.mjs migrate`). Until then they work the old way.
function isSecuredHub(data) {
  return Boolean(data) && typeof data.generation === "number";
}

async function registerHubDevice(hubId, key, generation) {
  const user = await hubAuthUser();
  await setDoc(hubMemberRef(hubId, user.uid), {
    key,
    generation,
    registered_at: new Date().toISOString()
  });
}

// New salt and key for the hub; this device stays signed in, all others are
// signed out. Used to retire keys carried over from the old public hash.
async function rotateHubKey(hubId, password, generation) {
  const user = await hubAuthUser();
  const salt = generateSaltHex();
  const key = await deriveHubKey(password, salt);
  const next = generation + 1;
  const now = new Date().toISOString();
  const batch = writeBatch(db);
  batch.update(doc(db, "private_hubs", hubId), { salt, generation: next, key_version: HUB_KEY_VERSION, updated_at: now });
  batch.set(hubKeysRef(hubId), { key_hash: await sha256Hex(key) });
  batch.set(hubMemberRef(hubId, user.uid), { key, generation: next, registered_at: now });
  await batch.commit();
}

// Is this browser allowed to change the hub's data? { ok: true } if so.
export async function checkPrivateHubDevice(hubId) {
  const snap = await getDoc(doc(db, "private_hubs", hubId));
  if (!snap.exists()) return { ok: false, reason: "missing" };
  const hub = snap.data();
  if (!isSecuredHub(hub)) return { ok: true, legacy: true };
  const user = await hubAuthUser();
  const member = await getDoc(hubMemberRef(hubId, user.uid));
  if (member.exists() && member.data().generation === hub.generation) return { ok: true };
  return { ok: false, reason: "device" };
}

// Lock: this browser can no longer change the hub until the password is entered again.
export async function forgetPrivateHubDevice(hubId) {
  if (!hubId) return;
  try {
    const { auth } = await loadHubAuth();
    if (auth.currentUser) await deleteDoc(hubMemberRef(hubId, auth.currentUser.uid));
  } catch (err) {
    console.warn("Could not sign this device out of the hub", err);
  }
}

export async function registerPrivateHubSpace({ name, password, linkedArchers = [] }) {
  const cleanName = String(name || "My Private Hub").trim();
  const hubId = slugifyHubId(cleanName);
  const ref = doc(db, "private_hubs", hubId);
  const existing = await getDoc(ref);
  if (existing.exists()) {
    const data = existing.data();
    if (isSecuredHub(data) || data.password_hash) {
      throw new Error(`Hub "${cleanName}" is already registered. Please switch to "Sign In" and enter your password.`);
    }
    throw new Error(`Hub "${cleanName}" already exists but has no password. Ask the league admin to set one.`);
  }

  const defaultArchers = linkedArcherNames(
    Array.isArray(linkedArchers) && linkedArchers.length > 0
      ? linkedArchers
      : hubId === "long_weijia"
      ? ["Long", "Weijia"]
      : [cleanName]
  );

  const user = await hubAuthUser();
  const salt = generateSaltHex();
  const key = await deriveHubKey(password, salt);
  const now = new Date().toISOString();
  const payload = {
    id: hubId,
    name: cleanName,
    salt,
    generation: 1,
    key_version: HUB_KEY_VERSION,
    linked_archers: defaultArchers,
    passkeys: [],
    created_at: now,
    updated_at: now
  };

  // Hub, its secret key hash and this device's membership are created together.
  const batch = writeBatch(db);
  batch.set(ref, payload);
  batch.set(hubKeysRef(hubId), { key_hash: await sha256Hex(key) });
  batch.set(hubMemberRef(hubId, user.uid), { key, generation: 1, registered_at: now });
  try {
    await batch.commit();
  } catch (err) {
    if (isPermissionDenied(err)) {
      throw new Error(`Hub "${cleanName}" is already registered. Please switch to "Sign In" and enter your password.`);
    }
    throw err;
  }
  return { success: true, hub: hubSummary(payload, hubId) };
}

export async function loginPrivateHubSpace({ nameOrId, password }) {
  const hubId = slugifyHubId(nameOrId);
  let snap = await getDoc(doc(db, "private_hubs", hubId));

  if (!snap.exists()) {
    // Also search by display name case-insensitively
    const allSnap = await getDocs(collection(db, "private_hubs"));
    allSnap.forEach(d => {
      const data = d.data();
      if (String(data.name || "").trim().toLowerCase() === String(nameOrId || "").trim().toLowerCase()) {
        snap = d;
      }
    });
  }

  if (!snap || !snap.exists()) {
    throw new Error("Hub not found. If this is your first time, use the 'First-Time Sign Up' tab to set up your password.");
  }

  const data = snap.data();
  const id = data.id || snap.id;
  const key = await deriveHubKey(password, data.salt || "");

  if (!isSecuredHub(data)) {
    // Not migrated yet: the old in-browser check.
    if (!data.password_hash) {
      throw new Error("This hub has no password yet. Ask the league admin to set one.");
    }
    if (key !== data.password_hash) {
      throw new Error("Incorrect password. Please try again.");
    }
    return { success: true, hub: hubSummary(data, id) };
  }

  // Firestore checks the password: it refuses the registration if the key is wrong.
  try {
    await registerHubDevice(id, key, data.generation);
  } catch (err) {
    if (isPermissionDenied(err)) throw new Error("Incorrect password. Please try again.");
    throw err;
  }

  if ((Number(data.key_version) || 1) < HUB_KEY_VERSION) {
    try {
      await rotateHubKey(id, password, data.generation);
    } catch (err) {
      console.warn("Could not replace the hub's old key", err);
    }
  }

  return { success: true, hub: hubSummary(data, id) };
}

export async function registerPrivateHubPasskey(hubId, deviceLabel = "Phone") {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error("Passkeys / Biometrics are not supported on this browser.");
  }
  const ref = doc(db, "private_hubs", hubId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Hub not found.");
  const hub = snap.data();

  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  const userIdBytes = new TextEncoder().encode(hubId);

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: {
        name: "Archery Private Hub",
        id: window.location.hostname
      },
      user: {
        id: userIdBytes,
        name: hub.name || hubId,
        displayName: hub.name || hubId
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },  // ES256
        { type: "public-key", alg: -257 } // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred"
      },
      timeout: 60000
    }
  });

  const credIdBase64 = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
  const passkeys = Array.isArray(hub.passkeys) ? [...hub.passkeys] : [];
  passkeys.push({
    credential_id: credIdBase64,
    device_name: deviceLabel,
    created_at: new Date().toISOString()
  });

  await updateDoc(ref, {
    passkeys,
    updated_at: new Date().toISOString()
  });

  return {
    success: true,
    credential_id: credIdBase64,
    passkeys
  };
}

export async function loginPrivateHubWithPasskey(hubIdInput = null) {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error("Biometric login is not supported on this browser.");
  }

  let allowCredentials = [];
  let targetHubDoc = null;

  if (hubIdInput) {
    const cleanId = slugifyHubId(hubIdInput);
    const snap = await getDoc(doc(db, "private_hubs", cleanId));
    if (snap.exists()) {
      targetHubDoc = snap.data();
      const pks = Array.isArray(targetHubDoc.passkeys) ? targetHubDoc.passkeys : [];
      allowCredentials = pks.map(pk => ({
        type: "public-key",
        id: Uint8Array.from(atob(pk.credential_id), c => c.charCodeAt(0))
      }));
    }
  }

  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);

  const publicKeyOptions = {
    challenge,
    rpId: window.location.hostname,
    userVerification: "required",
    timeout: 60000
  };
  if (allowCredentials.length > 0) {
    publicKeyOptions.allowCredentials = allowCredentials;
  }

  const assertion = await navigator.credentials.get({ publicKey: publicKeyOptions });
  const credIdBase64 = btoa(String.fromCharCode(...new Uint8Array(assertion.rawId)));

  // Match credential against private_hubs
  const allSnap = await getDocs(collection(db, "private_hubs"));
  let matchedHub = null;
  allSnap.forEach(d => {
    const data = d.data();
    const pks = Array.isArray(data.passkeys) ? data.passkeys : [];
    if (pks.some(pk => pk.credential_id === credIdBase64)) {
      matchedHub = data;
    }
  });

  if (!matchedHub && targetHubDoc) {
    matchedHub = targetHubDoc;
  }
  if (!matchedHub) {
    throw new Error("No Private Hub matched this passkey. Please sign in with your password once and enable quick unlock.");
  }

  return {
    success: true,
    hub: {
      id: matchedHub.id,
      name: matchedHub.name,
      linked_archers: linkedArcherNames(Array.isArray(matchedHub.linked_archers) ? matchedHub.linked_archers : ["Long", "Weijia"]),
      passkeys: Array.isArray(matchedHub.passkeys) ? matchedHub.passkeys : []
    }
  };
}

// List Private Hub Events + Auto-Synced League Events for this Hub's Linked Archers,
// newest first, a page at a time (loadMore for the next ones).
export async function getPrivateScoringEventsHub(hubId = "long_weijia", linkedArchers = ["Long", "Weijia"], { pageSize = 10 } = {}) {
  linkedArchers = linkedArcherNames(linkedArchers);
  const now = new Date();
  const batchSize = Math.min(30, Math.max(5, pageSize));
  const [rosterDocs, notesSnap] = await Promise.all([
    loadRosterDocs().catch(() => []),
    getDocs(query(collection(db, "private_league_notes"), where("hub_id", "==", hubId))).catch(() => null)
  ]);
  const rosterBadges = rosterAvatarsByArcher(rosterDocs);
  const notesMap = leagueNotesMap(notesSnap ? docList(notesSnap) : []);

  const privateSource = pagedEventSource({
    batchSize,
    makeQuery: page => query(collection(db, "private_events"), where("hub_id", "==", hubId), orderBy("date", "desc"), ...page),
    fallbackQuery: () => query(collection(db, "private_events"), where("hub_id", "==", hubId)),
    enrich: async events => {
      const parts = (await docsWhereIn("private_participants", "event_id", events.map(e => e.id))).filter(p => !p.hub_id || p.hub_id === hubId);
      const ends = await endsForParticipants(parts, "private_end_scores", "private_participants", () => true);
      return events.map(ev => buildPrivateSessionCard(ev, parts.filter(p => p.event_id === ev.id), ends, { rosterBadges }));
    }
  });

  const leagueSource = pagedEventSource({
    batchSize,
    makeQuery: page => query(collection(db, "scoring_events"), orderBy("date", "desc"), ...page),
    fallbackQuery: () => collection(db, "scoring_events"),
    enrich: async events => {
      const real = events.filter(e => !isTestLeagueEventName(e.name));
      const parts = (await docsWhereIn("event_participants", "event_id", real.map(e => e.id)))
        .filter(p => normalizeLinkedArcherMatch(p.name, linkedArchers));
      // Only a locked event's summary is final, so only those are saved from here.
      const locked = new Set(real.filter(e => leagueEventLockFields(e, now).is_locked).map(e => e.id));
      const ends = await endsForParticipants(parts, "end_scores", "event_participants", p => locked.has(p.event_id));
      return real
        .map(ev => buildSyncedLeagueCard(ev, parts.filter(p => p.event_id === ev.id), ends, { rosterBadges, linkedArchers, notesMap, now }))
        .filter(Boolean);
    }
  });

  // A league night the hub already logged as its own League session is shown once.
  const pager = createMergedPager([privateSource, leagueSource], {
    compare: byDateDesc,
    skip: (item, emitted) => item.is_league_synced
      && emitted.some(e => !e.is_league_synced && e.session_category === "League" && e.date === item.date)
  });
  const firstEvents = await pager.next(pageSize);

  const rosterMap = new Map();
  rosterByArcher(rosterDocs).forEach(r => {
    rosterMap.set(archerDirectory.key(r.name), {
      name: r.name,
      bow_category: r.bowCategory || "BAREBOW",
      avatar_id: r.avatarId || null
    });
  });
  const yesArchers = linkedArchers.map(name =>
    rosterMap.get(archerDirectory.key(name)) || { name, bow_category: "BAREBOW", avatar_id: null }
  );

  return hubPage(pager, firstEvents, {
    roster: Array.from(rosterMap.values()),
    rsvpImport: {
      date: new Date().toISOString().slice(0, 10),
      yesArchers,
      allArchers: Array.from(rosterMap.values())
    }
  });
}

export async function getPrivateEventData(eventId, hubId = "long_weijia", linkedArchers = ["Long", "Weijia"]) {
  return fetchEvent(eventPlan(eventId, { hubId, linkedArchers }));
}

export async function createPrivateScoringEvent(hubId = "long_weijia", { event, participants, groups }) {
  const now = new Date().toISOString();
  const eventId = event.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const balesPerGroup = Math.max(1, Number(event.bales_per_group) || 2);

  const eventData = {
    id: eventId,
    hub_id: hubId,
    name: event.name || "WA 18m Practice Session",
    date: event.date || now.slice(0, 10),
    start_time: event.start_time || "18:00",
    session_category: event.session_category || "Practice",
    distance: event.distance || "18m",
    target_face: event.target_face || "Multi-color face",
    notes: event.notes || "",
    max_bales: Number(event.max_bales) || 2,
    bales_per_group: balesPerGroup,
    bale_capacities: normalizeBaleCapacities(event.bale_capacities),
    rounds: Number(event.rounds) || 1,
    ends_per_round: Number(event.ends_per_round) || 10,
    arrows_per_end: Number(event.arrows_per_end) || 3,
    scoring_type: event.scoring_type || "USAA_10",
    swap_top_bottom: event.swap_top_bottom ? 1 : 0,
    status: "SETUP",
    created_at: now,
    updated_at: now
  };
  await setDoc(doc(db, "private_events", eventId), eventData);

  const baleSet = new Set();
  (participants || []).forEach(p => { if (p.bale_number) baleSet.add(Number(p.bale_number)); });
  const bales = Array.from(baleSet).sort((a, b) => a - b);
  if (bales.length === 0) bales.push(1);

  const baleToGroupId = {};
  for (let i = 0; i < bales.length; i += balesPerGroup) {
    const groupBales = bales.slice(i, i + balesPerGroup);
    const gNum = Math.floor(i / balesPerGroup) + 1;
    const gId = `grp_${eventId}_${gNum}`;
    const baleLabel = groupBales.length > 1 ? `Bales ${groupBales.join(" & ")}` : `Bale ${groupBales[0]}`;
    groupBales.forEach(b => { baleToGroupId[b] = gId; });
    await setDoc(doc(db, "private_groups", gId), {
      id: gId,
      hub_id: hubId,
      event_id: eventId,
      name: `Scoring Group ${gNum} (${baleLabel})`,
      bales: groupBales,
      bales_json: JSON.stringify(groupBales),
      nominated_scorer: "",
      current_round: 1,
      current_end: 1,
      created_at: now
    });
  }

  if (Array.isArray(participants)) {
    for (let idx = 0; idx < participants.length; idx++) {
      const p = participants[idx];
      const pId = p.id || `p_${eventId}_${idx}`;
      const bNum = Number(p.bale_number) || 1;
      await setDoc(doc(db, "private_participants", pId), {
        id: pId,
        hub_id: hubId,
        event_id: eventId,
        name: archerDirectory.display(p.name) || "Archer",
        bow_category: p.bow_category || "BAREBOW",
        avatar_id: p.avatar_id || null,
        archer_notes: p.archer_notes || "",
        bale_number: bNum,
        position: p.position || "A",
        shooting_line: p.shooting_line || "AB",
        lane: p.lane || "Left",
        initial_target: p.initial_target || "Top",
        group_id: p.group_id || baleToGroupId[bNum] || `grp_${eventId}_1`,
        sort_order: idx
      });
    }
  }

  return { success: true, eventId };
}

export async function submitPrivateEndScore(hubId = "long_weijia", { eventId, participantId, roundNumber, endNumber, arrows, endTotal, xCount, tenCount, scoredBy }) {
  const cleanEventId = String(eventId || "").replace(/^league:/, "");
  if (String(eventId || "").startsWith("league:")) {
    return await submitEndScore({
      eventId: cleanEventId,
      participantId,
      roundNumber,
      endNumber,
      arrows,
      endTotal,
      xCount,
      tenCount,
      scoredBy
    });
  }

  const id = `scr_${cleanEventId}_${participantId}_r${roundNumber}_e${endNumber}`;
  const score = {
    id,
    hub_id: hubId,
    event_id: cleanEventId,
    participant_id: participantId,
    round_number: roundNumber,
    end_number: endNumber,
    arrows,
    arrows_json: JSON.stringify(arrows),
    end_total: endTotal,
    x_count: xCount,
    ten_count: tenCount,
    scored_by: scoredBy || "",
    updated_at: new Date().toISOString()
  };
  return saveEndScore({
    scoresColl: "private_end_scores",
    partsColl: "private_participants",
    scoreId: id,
    score,
    participantId,
    partFields: { hub_id: hubId, event_id: cleanEventId },
    liveKeys: [cleanEventId],
    deniedMessage: "This device is not signed in to the Private Hub. Unlock the hub again, then save."
  });
}

export async function updatePrivateScoringEvent(eventId, fields) {
  const now = new Date().toISOString();
  await updateDoc(doc(db, "private_events", eventId), {
    ...fields,
    updated_at: now
  });
  return { success: true };
}

export async function deletePrivateScoringEvent(eventId) {
  await deleteDoc(doc(db, "private_events", eventId));
  const pSnap = await getDocs(query(collection(db, "private_participants"), where("event_id", "==", eventId)));
  for (const d of pSnap.docs) { await deleteDoc(d.ref); }
  const gSnap = await getDocs(query(collection(db, "private_groups"), where("event_id", "==", eventId)));
  for (const d of gSnap.docs) { await deleteDoc(d.ref); }
  const sSnap = await getDocs(query(collection(db, "private_end_scores"), where("event_id", "==", eventId)));
  for (const d of sSnap.docs) { await deleteDoc(d.ref); }
  return { success: true };
}

export async function savePrivateBaleAssignments(hubId = "long_weijia", eventId, { participants, groups, balesPerGroup, baleCapacities }, linkedArchers = ["Long", "Weijia"]) {
  linkedArchers = linkedArcherNames(linkedArchers);
  const eventUpdate = baleEventUpdate(balesPerGroup, baleCapacities);
  if (eventUpdate) await updateDoc(doc(db, "private_events", eventId), eventUpdate);

  const baleToGroupId = {};
  if (Array.isArray(groups)) {
    const oldGSnap = await getDocs(query(collection(db, "private_groups"), where("event_id", "==", eventId)));
    for (const d of oldGSnap.docs) { await deleteDoc(d.ref); }

    for (let idx = 0; idx < groups.length; idx++) {
      const g = groups[idx];
      const gId = g.id || `grp_${eventId}_${idx + 1}`;
      const gBales = Array.isArray(g.bales) ? g.bales.map(Number) : [1];
      gBales.forEach(b => { baleToGroupId[b] = gId; });
      await setDoc(doc(db, "private_groups", gId), {
        id: gId,
        hub_id: hubId,
        event_id: eventId,
        name: g.name || `Scoring Group ${idx + 1}`,
        bales: gBales,
        bales_json: JSON.stringify(gBales),
        nominated_scorer: g.nominated_scorer || "",
        current_round: g.current_round || 1,
        current_end: g.current_end || 1
      });
    }
  }

  if (Array.isArray(participants)) {
    const oldPSnap = await getDocs(query(collection(db, "private_participants"), where("event_id", "==", eventId)));
    const keepIds = new Set();

    for (let idx = 0; idx < participants.length; idx++) {
      const p = participants[idx];
      const pId = p.id || `p_${eventId}_${idx}_${Date.now()}`;
      keepIds.add(pId);
      const bNum = Number(p.bale_number) || 1;
      await setDoc(doc(db, "private_participants", pId), {
        ...participantFields(p),
        id: pId,
        hub_id: hubId,
        event_id: eventId,
        name: archerDirectory.display(p.name) || "Archer",
        bow_category: p.bow_category || "BAREBOW",
        archer_notes: p.archer_notes || "",
        bale_number: bNum,
        group_id: baleToGroupId[bNum] || p.group_id || `grp_${eventId}_1`,
        sort_order: idx
      }, { merge: true });
    }

    for (const d of oldPSnap.docs) {
      if (!keepIds.has(d.id)) {
        await deleteDoc(d.ref);
      }
    }
  }

  return await getPrivateEventData(eventId, hubId, linkedArchers);
}

export async function updatePrivateParticipantNote(hubId = "long_weijia", eventId, { participantId, archerName, archerNotes = "" }, linkedArchers = ["Long", "Weijia"]) {
  linkedArchers = linkedArcherNames(linkedArchers);
  const cleanNote = String(archerNotes || "").trim();
  const now = new Date().toISOString();

  if (String(eventId || "").startsWith("league:")) {
    const rawId = String(eventId).replace(/^league:/, "");
    const aKey = archerDirectory.key(archerName || "Long");
    const docId = `${hubId}_${rawId}_${aKey}`;
    await setDoc(doc(db, "private_league_notes", docId), {
      hub_id: hubId,
      league_event_id: rawId,
      archer_key: aKey,
      archer_notes: cleanNote,
      updated_at: now
    }, { merge: true });
    return await getPrivateEventData(eventId, hubId, linkedArchers);
  }

  await updateDoc(doc(db, "private_participants", participantId), {
    archer_notes: cleanNote
  });
  await updateDoc(doc(db, "private_events", eventId), {
    updated_at: now
  });
  return await getPrivateEventData(eventId, hubId, linkedArchers);
}

export async function getPrivateAnalyticsData(hubId = "long_weijia", linkedArchers = ["Long", "Weijia"]) {
  linkedArchers = linkedArcherNames(linkedArchers);
  const now = new Date();
  const [rosterDocs, privEvSnap, privPartSnap, leagueEvSnap, leaguePartSnap, leagueNotesSnap] = await Promise.all([
    loadRosterDocs().catch(() => []),
    getDocs(query(collection(db, "private_events"), where("hub_id", "==", hubId))),
    getDocs(query(collection(db, "private_participants"), where("hub_id", "==", hubId))),
    getDocs(collection(db, "scoring_events")),
    getDocs(collection(db, "event_participants")),
    getDocs(query(collection(db, "private_league_notes"), where("hub_id", "==", hubId)))
  ]);
  const rosterBadges = rosterAvatarsByArcher(rosterDocs);
  const notesMap = leagueNotesMap(docList(leagueNotesSnap));

  const events = [];
  const privateDatesSet = new Set();
  docList(privEvSnap).forEach(e => {
    privateDatesSet.add(`${e.session_category || "Practice"}_${e.date}`);
    events.push(e);
  });
  const privateParts = docList(privPartSnap).map(p => ({ ...p, name: archerDirectory.display(p.name) }));

  // League events the hub's archers shot in (not test events, not already logged privately).
  const leagueEvents = docList(leagueEvSnap).filter(lev => !isTestLeagueEventName(lev.name) && !privateDatesSet.has(`League_${lev.date}`));
  const leagueById = new Map(leagueEvents.map(e => [e.id, e]));
  const leagueParts = docList(leaguePartSnap).filter(lp => leagueById.has(lp.event_id) && normalizeLinkedArcherMatch(lp.name, linkedArchers));

  const [privateEnds, leagueEnds] = await Promise.all([
    endsForParticipants(privateParts, "private_end_scores", "private_participants", () => true),
    endsForParticipants(leagueParts, "end_scores", "event_participants",
      p => leagueEventLockFields(leagueById.get(p.event_id) || {}, now).is_locked)
  ]);

  const participants = [...privateParts];
  const endsByParticipant = { ...privateEnds };
  leagueEvents.forEach(lev => {
    const lParts = leagueParts.filter(lp => lp.event_id === lev.id);
    if (!lParts.some(lp => (leagueEnds[lp.id] || []).some(s => parseArrows(s).length > 0))) return;
    const syncedEvId = `league:${lev.id}`;
    events.push({ ...lev, id: syncedEvId, session_category: "League", distance: "18m", target_face: "Multi-color face", is_league_synced: true });
    lParts.forEach(lp => {
      const dispName = normalizeLinkedArcherMatch(lp.name, linkedArchers) || lp.name;
      const key = `league:${lp.id}`;
      participants.push({
        ...lp,
        id: key,
        name: dispName,
        event_id: syncedEvId,
        archer_notes: notesMap[`${lev.id}_${archerDirectory.key(dispName)}`] || ""
      });
      endsByParticipant[key] = leagueEnds[lp.id] || [];
    });
  });

  flushScoreSummaries();
  return buildArcherAnalytics({ events, participants, endsByParticipant, rosterBadges });
}

// ============================================================================
// SITE FEEDBACK — FREE-FORM TEXT (MAX 500 CHARS, MAX 20 PER DAY)
// ============================================================================
export const FEEDBACK_DAILY_LIMIT = 20;
export const FEEDBACK_MAX_CHARS = 500;

function getLocalTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function getFeedbackDailyStatus() {
  const today = getLocalTodayStr();
  const q = query(collection(db, "feedback"), where("date", "==", today));
  const snap = await getDocs(q);
  const count = snap.size;
  return {
    date: today,
    count,
    limit: FEEDBACK_DAILY_LIMIT,
    remaining: Math.max(0, FEEDBACK_DAILY_LIMIT - count)
  };
}

export async function submitSiteFeedback({ message, page = "unknown" }) {
  const cleanMsg = String(message || "").trim();
  if (!cleanMsg) {
    throw new Error("Please enter a feedback message before submitting.");
  }
  if (cleanMsg.length > FEEDBACK_MAX_CHARS) {
    throw new Error(`Feedback is limited to ${FEEDBACK_MAX_CHARS} characters (currently ${cleanMsg.length}).`);
  }

  const status = await getFeedbackDailyStatus();
  if (status.count >= FEEDBACK_DAILY_LIMIT) {
    throw new Error(`Daily feedback limit reached (${FEEDBACK_DAILY_LIMIT} per day). Please try again tomorrow!`);
  }

  const now = new Date().toISOString();
  const id = `fb_${status.date}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await setDoc(doc(db, "feedback", id), {
    id,
    date: status.date,
    message: cleanMsg,
    page: String(page || "unknown").slice(0, 60),
    created_at: now
  });

  const newCount = status.count + 1;
  return {
    success: true,
    id,
    date: status.date,
    count: newCount,
    limit: FEEDBACK_DAILY_LIMIT,
    remaining: Math.max(0, FEEDBACK_DAILY_LIMIT - newCount)
  };
}



