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
  onSnapshot 
} from "./firebase-config.js";

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
  const archers = [];
  const rsvps = [];

  const [stateSnap, rosterSnap, rsvpSnap] = await Promise.all([
    getDoc(doc(db, "app_state", "current")).catch(e => { console.error("Error reading app_state:", e); return null; }),
    getDocs(collection(db, "roster")).catch(e => { console.error("Error reading roster:", e); return null; }),
    getDocs(query(collection(db, "rsvps"), where("date", "==", currentSunday))).catch(e => { console.error("Error reading rsvps:", e); return null; })
  ]);

  if (stateSnap && stateSnap.exists()) {
    const data = stateSnap.data();
    if (data.config) config = { ...config, ...data.config };
    if (data.event) event = { ...event, ...data.event };
  }
  if (rosterSnap) {
    rosterSnap.forEach(d => archers.push(d.data()));
  }
  if (rsvpSnap) {
    rsvpSnap.forEach(d => rsvps.push(d.data()));
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
export async function submitRsvp({ name, status, avatarId, bowCategory, customTitle, email, remindMe }) {
  const currentSunday = getUpcomingSundayStr();
  const cleanName = name.trim();
  const cleanLower = cleanName.toLowerCase();
  const id = `${currentSunday}_${cleanLower}`;
  const now = new Date().toISOString();
  const MAX_RSVPS = 50;

  // Enforce upper limit of 50 RSVPs for the upcoming session and 50 archers in roster
  const existingRsvpSnap = await getDoc(doc(db, "rsvps", id));
  if (!existingRsvpSnap.exists()) {
    const rsvpDateSnap = await getDocs(query(collection(db, "rsvps"), where("date", "==", currentSunday)));
    if (rsvpDateSnap.size >= MAX_RSVPS) {
      throw new Error(`Maximum RSVP limit reached (${MAX_RSVPS} RSVPs allowed per session).`);
    }
  }

  const rosterRef = doc(db, "roster", cleanLower);
  const existingRosterSnap = await getDoc(rosterRef);
  if (!existingRosterSnap.exists()) {
    const allRosterSnap = await getDocs(collection(db, "roster"));
    if (allRosterSnap.size >= MAX_RSVPS) {
      throw new Error(`League roster is full (maximum ${MAX_RSVPS} archers allowed).`);
    }
  }

  // Save/update RSVP
  await setDoc(doc(db, "rsvps", id), {
    date: currentSunday,
    archerName: cleanName,
    status,
    avatarId: avatarId || null,
    bowCategory: bowCategory || 'BAREBOW',
    customTitle: customTitle || null,
    note: '',
    updatedAt: now
  }, { merge: true });

  // Update Roster profile so chosen avatar/bow persist
  const updateData = {
    name: cleanName,
    avatarId: avatarId || null,
    bowCategory: bowCategory || 'BAREBOW',
    customTitle: customTitle || null
  };
  if (email !== undefined) updateData.email = email;
  if (remindMe !== undefined) updateData.remindMe = remindMe;

  await setDoc(rosterRef, updateData, { merge: true });

  return { success: true };
}

// 3. Update Admin Status (ON/OFF/PENDING, league time)
export async function updateAdminStatus({ status, leagueTime }) {
  const currentSunday = getUpcomingSundayStr();
  const now = new Date().toISOString();

  const update = {
    "config.leagueTime": leagueTime || "6:00 PM",
    "event.status": status || "PENDING",
    "event.updatedAt": now
  };
  await updateDoc(doc(db, "app_state", "current"), update);
  return { success: true };
}

// 4. Scoring: List Events Hub
export async function getScoringEventsHub() {
  const sunday = getUpcomingSundayStr();
  const [eventsSnap, pSnap, gSnap, rosterSnap, rsvpSnap] = await Promise.all([
    getDocs(collection(db, "scoring_events")),
    getDocs(collection(db, "event_participants")),
    getDocs(collection(db, "scoring_groups")),
    getDocs(collection(db, "roster")),
    getDocs(query(collection(db, "rsvps"), where("date", "==", sunday))).catch(() => ({ forEach: () => {} }))
  ]);

  const participantsByEvent = {};
  pSnap.forEach(d => {
    const p = d.data();
    if (p.event_id) {
      if (!participantsByEvent[p.event_id]) participantsByEvent[p.event_id] = [];
      participantsByEvent[p.event_id].push(p);
    }
  });

  const groupsByEvent = {};
  gSnap.forEach(d => {
    const g = d.data();
    if (g.event_id) {
      if (!groupsByEvent[g.event_id]) groupsByEvent[g.event_id] = [];
      groupsByEvent[g.event_id].push(g);
    }
  });

  const events = [];
  eventsSnap.forEach(d => {
    const ev = d.data();
    const pList = participantsByEvent[ev.id] || [];
    const gList = groupsByEvent[ev.id] || [];
    const baleSet = new Set();
    pList.forEach(p => { if (p.bale_number) baleSet.add(Number(p.bale_number)); });
    const step = Math.max(1, Number(ev.bales_per_group) || 2);
    const groupCount = gList.length > 0 ? gList.length : Math.max(1, Math.ceil(baleSet.size / step));

    events.push({
      ...ev,
      participant_count: pList.length,
      group_count: groupCount,
      is_locked: ev.status === 'COMPLETED'
    });
  });
  // Sort by date descending; if same date, sort by created_at / id descending
  events.sort((a, b) => {
    const dateComp = (b.date || '').localeCompare(a.date || '');
    if (dateComp !== 0) return dateComp;
    return (b.created_at || b.id || '').localeCompare(a.created_at || a.id || '');
  });

  // Get current roster and RSVPs for event creator modal
  const roster = [];
  rosterSnap.forEach(d => roster.push(d.data()));
  roster.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const yesArchers = [];
  try {
    rsvpSnap.forEach(d => {
      const r = d.data();
      if (r.date === sunday && r.status === 'YES') {
        yesArchers.push({
          name: r.archerName,
          bow_category: r.bowCategory || 'BAREBOW',
          avatar_id: r.avatarId,
          custom_title: r.customTitle
        });
      }
    });
  } catch (e) {}

  // Merge roster + any historical event_participants so archers who participated without RSVPing are always included
  const allArchersMap = new Map();
  roster.forEach(r => {
    const clean = String(r.name || '').trim();
    const key = clean.toLowerCase();
    if (key) {
      allArchersMap.set(key, {
        name: clean,
        bow_category: r.bowCategory || 'BAREBOW',
        avatar_id: r.avatarId || null,
        custom_title: r.customTitle || null
      });
    }
  });
  const aliasSkip = new Set([
    'long ma', 'weijia li', 'ling fang', 'ling fangng',
    'xianchu chen', 'xianchuu', 'alex grossman', 'alex grossmanx',
    'maxwell shepherd', 'wei', 'qihuanan', 'qihuan aixinjueluo', 'magnur gilmutdin', 'joy'
  ]);
  pSnap.forEach(d => {
    const p = d.data();
    const clean = String(p.name || '').trim();
    const key = clean.toLowerCase();
    if (key && !allArchersMap.has(key) && !aliasSkip.has(key)) {
      allArchersMap.set(key, {
        name: clean,
        bow_category: p.bow_category || 'BAREBOW',
        avatar_id: p.avatar_id || null,
        custom_title: p.custom_title || null
      });
    }
  });

  const allArchers = Array.from(allArchersMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  return {
    success: true,
    events,
    roster,
    rsvpImport: {
      date: sunday,
      yesArchers,
      allArchers
    }
  };
}

// 5. Scoring: Get Event Data (Full participants, scores, leaderboard)
export async function getEventData(eventId) {
  const [evSnap, pSnap, sSnap, gSnap] = await Promise.all([
    getDoc(doc(db, "scoring_events", eventId)),
    getDocs(query(collection(db, "event_participants"), where("event_id", "==", eventId))),
    getDocs(query(collection(db, "end_scores"), where("event_id", "==", eventId))),
    getDocs(query(collection(db, "scoring_groups"), where("event_id", "==", eventId)))
  ]);
  if (!evSnap.exists()) return { success: false, error: 'Event not found' };
  const ev = evSnap.data();

  ev.midpoint_end = Math.floor((ev.ends_per_round || 10) / 2) + 1;
  ev.is_locked = ev.status === 'COMPLETED';

  // Participants
  const participants = [];
  pSnap.forEach(d => participants.push(d.data()));
  participants.sort((a, b) => (Number(a.bale_number) - Number(b.bale_number)) || String(a.position).localeCompare(String(b.position)));

  // Scores
  const eventScores = [];
  sSnap.forEach(d => {
    const s = d.data();
    eventScores.push({
      ...s,
      arrows: Array.isArray(s.arrows) ? s.arrows : (typeof s.arrows_json === 'string' ? JSON.parse(s.arrows_json || '[]') : [])
    });
  });

  const scoresByParticipant = {};
  participants.forEach(p => { scoresByParticipant[p.id] = []; });
  eventScores.forEach(s => {
    if (!scoresByParticipant[s.participant_id]) scoresByParticipant[s.participant_id] = [];
    scoresByParticipant[s.participant_id].push(s);
  });

  const enrichedParticipants = participants.map(p => {
    const pScores = scoresByParticipant[p.id] || [];
    let runningTotal = 0;
    let totalXs = 0;
    let totalTens = 0;
    let arrowsShot = 0;
    let endsCompleted = 0;

    pScores.forEach(s => {
      if (s.arrows && s.arrows.length > 0) {
        runningTotal += Number(s.end_total) || 0;
        totalXs += Number(s.x_count) || 0;
        totalTens += Number(s.ten_count) || 0;
        arrowsShot += s.arrows.length;
        if (s.arrows.length >= (ev.arrows_per_end || 3)) {
          endsCompleted += 1;
        }
      }
    });

    const bowCat = p.bow_category || 'BAREBOW';
    return {
      ...p,
      bow_category: bowCat,
      designation: `${p.bale_number}${p.position}`,
      running_total: runningTotal,
      x_count: totalXs,
      ten_count: totalTens,
      arrows_shot: arrowsShot,
      ends_completed: endsCompleted,
      avg_per_arrow: arrowsShot > 0 ? (runningTotal / arrowsShot).toFixed(2) : '0.00',
      scores: pScores
    };
  });

  const totalEndsPerArcher = (ev.rounds || 1) * (ev.ends_per_round || 10);
  const allScoresFilled = enrichedParticipants.length > 0 && enrichedParticipants.every(p => p.ends_completed >= totalEndsPerArcher);
  ev.all_scores_filled = allScoresFilled;
  ev.is_finished = Boolean(ev.is_locked || ev.status === 'COMPLETED' || allScoresFilled);

  const categoryRankCounters = { BAREBOW: 0, OLYMPIC_RECURVE: 0, TRADITIONAL: 0, COMPOUND: 0 };
  const leaderboard = [...enrichedParticipants].sort((a, b) => {
    if (b.running_total !== a.running_total) return b.running_total - a.running_total;
    if (b.x_count !== a.x_count) return b.x_count - a.x_count;
    if (b.ten_count !== a.ten_count) return b.ten_count - a.ten_count;
    return String(a.designation || '').localeCompare(String(b.designation || ''));
  }).map((p, idx) => {
    const cat = p.bow_category || 'BAREBOW';
    categoryRankCounters[cat] = (categoryRankCounters[cat] || 0) + 1;
    return {
      ...p,
      rank: idx + 1,
      category_rank: categoryRankCounters[cat]
    };
  });

  const leaderboardByCategory = {
    BAREBOW: leaderboard.filter(p => (p.bow_category || 'BAREBOW') === 'BAREBOW'),
    OLYMPIC_RECURVE: leaderboard.filter(p => p.bow_category === 'OLYMPIC_RECURVE'),
    TRADITIONAL: leaderboard.filter(p => p.bow_category === 'TRADITIONAL'),
    COMPOUND: leaderboard.filter(p => p.bow_category === 'COMPOUND')
  };

    // Groupings: Load from scoring_groups collection first, or generate based on event.bales_per_group
    const groups = [];
    gSnap.forEach(d => {
      const g = d.data();
      groups.push({
        ...g,
        bales: Array.isArray(g.bales) ? g.bales.map(Number) : []
      });
    });
    groups.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));

    if (groups.length === 0) {
      const baleSet = new Set();
      participants.forEach(p => { if (p.bale_number) baleSet.add(Number(p.bale_number)); });
      const bales = Array.from(baleSet).sort((a, b) => a - b);
      const step = Math.max(1, Number(ev.bales_per_group) || 2);
      for (let i = 0; i < bales.length; i += step) {
        const groupBales = bales.slice(i, i + step);
        const gNum = Math.floor(i / step) + 1;
        const baleLabel = groupBales.length > 1 ? `Bales ${groupBales.join(' & ')}` : `Bale ${groupBales[0]}`;
        groups.push({
          id: 'grp_' + ev.id + '_' + gNum,
          event_id: ev.id,
          name: `Scoring Group ${gNum} (${baleLabel})`,
          bales: groupBales,
          nominated_scorer: '',
          current_round: 1,
          current_end: 1
        });
      }
      if (groups.length === 0) {
        groups.push({
          id: 'grp_' + ev.id + '_1',
          event_id: ev.id,
          name: 'Scoring Group 1 (Bale 1)',
          bales: [1],
          nominated_scorer: '',
          current_round: 1,
          current_end: 1
        });
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

// 6. Scoring: Submit End Score
export async function submitEndScore({ eventId, participantId, roundNumber, endNumber, arrows, endTotal, xCount, tenCount, scoredBy }) {
  const id = `es_${eventId}_${participantId}_${roundNumber}_${endNumber}`;
  const now = new Date().toISOString();
  await setDoc(doc(db, "end_scores", id), {
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
    updated_at: now
  }, { merge: true });
  return { success: true };
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
    rounds: Number(event.rounds) || 1,
    ends_per_round: Number(event.ends_per_round) || 10,
    arrows_per_end: Number(event.arrows_per_end) || 3,
    scoring_type: event.scoring_type || 'USAA_10',
    swap_top_bottom: event.swap_top_bottom ? 1 : 0,
    status: event.status || 'SETUP',
    created_at: now,
    updated_at: now
  };
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
    const rosterSnap = await getDocs(collection(db, "roster"));
    let rosterCount = rosterSnap.size;
    const knownRosterIds = new Set();
    rosterSnap.forEach(d => knownRosterIds.add(d.id));

    for (let idx = 0; idx < participants.length; idx++) {
      const p = participants[idx];
      const pId = p.id || (`p_${eventId}_${idx}`);
      const bNum = Number(p.bale_number) || 1;
      const cleanName = String(p.name || 'Archer').trim();
      const bowCat = p.bow_category || 'BAREBOW';
      await setDoc(doc(db, "event_participants", pId), {
        id: pId,
        event_id: eventId,
        name: cleanName,
        bow_category: bowCat,
        avatar_id: p.avatar_id || null,
        custom_title: p.custom_title || null,
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
        const rKey = cleanName.toLowerCase();
        if (knownRosterIds.has(rKey) || rosterCount < 50) {
          const rosterUpdate = {
            name: cleanName,
            bowCategory: bowCat
          };
          if (p.avatar_id) rosterUpdate.avatarId = p.avatar_id;
          if (p.custom_title) rosterUpdate.customTitle = p.custom_title;
          await setDoc(doc(db, "roster", rKey), rosterUpdate, { merge: true });
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

// 8. Scoring: Update Event Settings
export async function updateScoringEvent(eventId, fields) {
  const now = new Date().toISOString();
  await updateDoc(doc(db, "scoring_events", eventId), {
    ...fields,
    updated_at: now
  });
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

// 10. Scoring: Save Bale & Group Assignments
export async function saveBaleAssignments(eventId, { participants, groups, balesPerGroup }) {
  if (balesPerGroup !== undefined) {
    await updateDoc(doc(db, "scoring_events", eventId), {
      bales_per_group: Number(balesPerGroup) || 2,
      updated_at: new Date().toISOString()
    });
  }

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

    const rosterSnap = await getDocs(collection(db, "roster"));
    let rosterCount = rosterSnap.size;
    const knownRosterIds = new Set();
    rosterSnap.forEach(d => knownRosterIds.add(d.id));

    for (let idx = 0; idx < participants.length; idx++) {
      const p = participants[idx];
      const pId = p.id || (`p_${eventId}_${idx}_${Date.now()}`);
      keepIds.add(pId);
      const bNum = Number(p.bale_number) || 1;
      const resolvedGroupId = baleToGroupId[bNum] || p.group_id || (`grp_${eventId}_1`);
      const cleanName = String(p.name || 'Archer').trim();
      const bowCat = p.bow_category || 'BAREBOW';
      await setDoc(doc(db, "event_participants", pId), {
        ...p,
        id: pId,
        event_id: eventId,
        name: cleanName,
        bow_category: bowCat,
        bale_number: bNum,
        group_id: resolvedGroupId,
        sort_order: idx
      }, { merge: true });

      // Also persist participant to global roster so walk-in archers who didn't RSVP are saved for future sessions (capped at 50)
      if (cleanName) {
        const rKey = cleanName.toLowerCase();
        if (knownRosterIds.has(rKey) || rosterCount < 50) {
          const rosterUpdate = {
            name: cleanName,
            bowCategory: bowCat
          };
          if (p.avatar_id) rosterUpdate.avatarId = p.avatar_id;
          if (p.custom_title) rosterUpdate.customTitle = p.custom_title;
          await setDoc(doc(db, "roster", rKey), rosterUpdate, { merge: true });
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

async function hashPasswordPBKDF2(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(password || "")),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const saltBytes = new Uint8Array(
    (saltHex.match(/.{1,2}/g) || []).map(b => parseInt(b, 16))
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 50000,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(derivedBits))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateSaltHex() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

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
      linked_archers: Array.isArray(data.linked_archers) ? data.linked_archers : [],
      passkeys: Array.isArray(data.passkeys) ? data.passkeys : []
    });
  });
  return spaces;
}

export async function registerPrivateHubSpace({ name, password, linkedArchers = [] }) {
  const cleanName = String(name || "My Private Hub").trim();
  const hubId = slugifyHubId(cleanName);
  const ref = doc(db, "private_hubs", hubId);
  const existing = await getDoc(ref);
  if (existing.exists() && existing.data().password_hash) {
    throw new Error(`Hub "${cleanName}" is already registered. Please switch to "Sign In" and enter your password.`);
  }

  const salt = generateSaltHex();
  const passwordHash = await hashPasswordPBKDF2(password, salt);
  const defaultArchers =
    Array.isArray(linkedArchers) && linkedArchers.length > 0
      ? linkedArchers
      : hubId === "long_weijia"
      ? ["Long", "Weijia"]
      : [cleanName];

  const payload = {
    id: hubId,
    name: cleanName,
    salt,
    password_hash: passwordHash,
    linked_archers: defaultArchers,
    passkeys: existing.exists() && Array.isArray(existing.data().passkeys) ? existing.data().passkeys : [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  await setDoc(ref, payload, { merge: true });
  return {
    success: true,
    hub: {
      id: hubId,
      name: cleanName,
      linked_archers: defaultArchers,
      passkeys: payload.passkeys
    }
  };
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
  const computedHash = await hashPasswordPBKDF2(password, data.salt || "");
  if (computedHash !== data.password_hash) {
    throw new Error("Incorrect password. Please try again.");
  }

  return {
    success: true,
    hub: {
      id: data.id || snap.id,
      name: data.name,
      linked_archers: Array.isArray(data.linked_archers) ? data.linked_archers : ["Long", "Weijia"],
      passkeys: Array.isArray(data.passkeys) ? data.passkeys : []
    }
  };
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
      linked_archers: Array.isArray(matchedHub.linked_archers) ? matchedHub.linked_archers : ["Long", "Weijia"],
      passkeys: Array.isArray(matchedHub.passkeys) ? matchedHub.passkeys : []
    }
  };
}

function normalizeLinkedArcherMatch(participantName, linkedArchers = ["Long", "Weijia"]) {
  const raw = String(participantName || "").trim().toLowerCase();
  if (!raw) return null;
  for (const arch of linkedArchers) {
    const cleanArch = String(arch || "").trim();
    const lowerArch = cleanArch.toLowerCase();
    if (
      raw === lowerArch ||
      (lowerArch === "long" && raw === "long ma") ||
      (lowerArch === "weijia" && (raw === "weijia li" || raw === "jiajia"))
    ) {
      return cleanArch;
    }
  }
  return null;
}

function isTestLeagueEventName(name) {
  const n = String(name || "").trim().toLowerCase();
  return n.startsWith("test") || n.includes("testing");
}

// List Private Hub Events + Auto-Synced League Events for this Hub's Linked Archers
export async function getPrivateScoringEventsHub(hubId = "long_weijia", linkedArchers = ["Long", "Weijia"]) {
  const [
    privEvSnap,
    privPartSnap,
    privGrpSnap,
    privScoreSnap,
    leagueEvSnap,
    leaguePartSnap,
    leagueScoreSnap,
    leagueNotesSnap,
    rosterSnap
  ] = await Promise.all([
    getDocs(query(collection(db, "private_events"), where("hub_id", "==", hubId))),
    getDocs(query(collection(db, "private_participants"), where("hub_id", "==", hubId))),
    getDocs(query(collection(db, "private_groups"), where("hub_id", "==", hubId))),
    getDocs(query(collection(db, "private_end_scores"), where("hub_id", "==", hubId))),
    getDocs(collection(db, "scoring_events")),
    getDocs(collection(db, "event_participants")),
    getDocs(collection(db, "end_scores")),
    getDocs(query(collection(db, "private_league_notes"), where("hub_id", "==", hubId))),
    getDocs(collection(db, "roster"))
  ]);

  const notesMap = {};
  leagueNotesSnap.forEach(d => {
    const n = d.data();
    notesMap[`${n.league_event_id}_${String(n.archer_key || "").toLowerCase()}`] = n.archer_notes || "";
  });

  // Group private participants, groups, and scores by event_id
  const privPartsByEvent = {};
  privPartSnap.forEach(d => {
    const p = d.data();
    if (!privPartsByEvent[p.event_id]) privPartsByEvent[p.event_id] = [];
    privPartsByEvent[p.event_id].push(p);
  });
  Object.values(privPartsByEvent).forEach(arr =>
    arr.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
  );

  const privGroupsByEvent = {};
  privGrpSnap.forEach(d => {
    const g = d.data();
    if (!privGroupsByEvent[g.event_id]) privGroupsByEvent[g.event_id] = [];
    privGroupsByEvent[g.event_id].push(g);
  });

  const privScoresByEvent = {};
  privScoreSnap.forEach(d => {
    const s = d.data();
    if (!privScoresByEvent[s.event_id]) privScoresByEvent[s.event_id] = [];
    privScoresByEvent[s.event_id].push(s);
  });

  const privateEvents = [];
  const privateDatesSet = new Set();

  privEvSnap.forEach(d => {
    const ev = d.data();
    const cat = ev.session_category || "Practice";
    privateDatesSet.add(`${cat}_${ev.date}`);

    const parts = privPartsByEvent[ev.id] || [];
    const scores = privScoresByEvent[ev.id] || [];
    const groups = privGroupsByEvent[ev.id] || [];

    const byPart = {};
    let completedEndsCount = 0;
    scores.forEach(s => {
      const arr = Array.isArray(s.arrows)
        ? s.arrows
        : typeof s.arrows_json === "string"
        ? JSON.parse(s.arrows_json || "[]")
        : [];
      if (!byPart[s.participant_id]) byPart[s.participant_id] = { score: 0, arrows: 0, xs: 0, tens: 0 };
      if (arr.length >= (ev.arrows_per_end || 3)) completedEndsCount++;
      byPart[s.participant_id].score += Number(s.end_total) || 0;
      byPart[s.participant_id].arrows += arr.length;
      byPart[s.participant_id].xs += Number(s.x_count) || 0;
      byPart[s.participant_id].tens += Number(s.ten_count) || 0;
    });

    const participantSummaries = [];
    parts.forEach(p => {
      const st = byPart[p.id] || { score: 0, arrows: 0, xs: 0, tens: 0 };
      const effectiveNote = String(p.archer_notes || "").trim();
      if (st.arrows > 0 || effectiveNote) {
        participantSummaries.push({
          id: p.id,
          name: p.name,
          avatar_id: p.avatar_id,
          score: st.score,
          arrows: st.arrows,
          avg: st.arrows > 0 ? (st.score / st.arrows).toFixed(2) : null,
          xs: st.xs,
          tens: st.tens,
          archer_notes: effectiveNote
        });
      }
    });

    const totalExpectedEnds = parts.length * (ev.rounds || 1) * (ev.ends_per_round || 10);
    const allScoresFilled = parts.length > 0 && completedEndsCount >= totalExpectedEnds;

    privateEvents.push({
      ...ev,
      start_time: ev.start_time || "18:00",
      session_category: cat,
      distance: ev.distance || "18m",
      target_face: ev.target_face || "Multi-color face",
      swap_top_bottom: Boolean(ev.swap_top_bottom),
      participant_count: participantSummaries.length || parts.length,
      participant_summaries: participantSummaries,
      group_count: groups.length || 1,
      all_scores_filled: allScoresFilled,
      is_locked: false
    });
  });

  // Merge Automatic Sunday League Events for Linked Archers
  const leaguePartsByEvent = {};
  leaguePartSnap.forEach(d => {
    const p = d.data();
    if (!leaguePartsByEvent[p.event_id]) leaguePartsByEvent[p.event_id] = [];
    leaguePartsByEvent[p.event_id].push(p);
  });

  const leagueScoresByEvent = {};
  leagueScoreSnap.forEach(d => {
    const s = d.data();
    if (!leagueScoresByEvent[s.event_id]) leagueScoresByEvent[s.event_id] = [];
    leagueScoresByEvent[s.event_id].push(s);
  });

  const syncedLeagueEvents = [];
  leagueEvSnap.forEach(d => {
    const ev = d.data();
    if (isTestLeagueEventName(ev.name)) return;
    if (privateDatesSet.has(`League_${ev.date}`)) return;

    const allParts = leaguePartsByEvent[ev.id] || [];
    const matchedParts = [];
    allParts.forEach(p => {
      const canonicalName = normalizeLinkedArcherMatch(p.name, linkedArchers);
      if (canonicalName) {
        matchedParts.push({ ...p, canonicalName });
      }
    });
    if (matchedParts.length === 0) return;

    const evScores = leagueScoresByEvent[ev.id] || [];
    const byPart = {};
    evScores.forEach(s => {
      const arr = Array.isArray(s.arrows)
        ? s.arrows
        : typeof s.arrows_json === "string"
        ? JSON.parse(s.arrows_json || "[]")
        : [];
      if (!byPart[s.participant_id]) byPart[s.participant_id] = { score: 0, arrows: 0, xs: 0, tens: 0, completedEnds: 0 };
      if (arr.length >= (ev.arrows_per_end || 3)) byPart[s.participant_id].completedEnds++;
      byPart[s.participant_id].score += Number(s.end_total) || 0;
      byPart[s.participant_id].arrows += arr.length;
      byPart[s.participant_id].xs += Number(s.x_count) || 0;
      byPart[s.participant_id].tens += Number(s.ten_count) || 0;
    });

    const participantSummaries = [];
    let completedEndsCount = 0;
    let activeCount = 0;

    matchedParts.forEach(p => {
      const st = byPart[p.id] || { score: 0, arrows: 0, xs: 0, tens: 0, completedEnds: 0 };
      const aKey = p.canonicalName.toLowerCase();
      const savedNote = notesMap[`${ev.id}_${aKey}`] || "";
      if (st.arrows > 0 || savedNote) {
        activeCount++;
        completedEndsCount += st.completedEnds;
        participantSummaries.push({
          id: p.id,
          name: p.canonicalName,
          avatar_id: p.avatar_id || (aKey === "long" ? "bengal_cat" : aKey === "weijia" ? "devon_rex_cat" : null),
          score: st.score,
          arrows: st.arrows,
          avg: st.arrows > 0 ? (st.score / st.arrows).toFixed(2) : null,
          xs: st.xs,
          tens: st.tens,
          archer_notes: savedNote
        });
      }
    });

    if (participantSummaries.length === 0) return;
    const totalExpectedEnds = activeCount * (ev.rounds || 1) * (ev.ends_per_round || 10);
    const allScoresFilled = activeCount > 0 && completedEndsCount >= totalExpectedEnds;

    syncedLeagueEvents.push({
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
      all_scores_filled: allScoresFilled,
      is_locked: false
    });
  });

  const combinedEvents = [...privateEvents, ...syncedLeagueEvents].sort((a, b) => {
    const dc = String(b.date || "").localeCompare(String(a.date || ""));
    if (dc !== 0) return dc;
    return String(b.created_at || b.id || "").localeCompare(String(a.created_at || a.id || ""));
  });

  const rosterMap = new Map();
  rosterSnap.forEach(d => {
    const r = d.data();
    if (r.name) {
      rosterMap.set(r.name.trim().toLowerCase(), {
        name: r.name.trim(),
        bow_category: r.bowCategory || "BAREBOW",
        avatar_id: r.avatarId || null,
        custom_title: r.customTitle || null
      });
    }
  });

  const yesArchers = linkedArchers.map(name => {
    const key = String(name || "").trim().toLowerCase();
    return (
      rosterMap.get(key) || {
        name,
        bow_category: "BAREBOW",
        avatar_id: key === "long" ? "bengal_cat" : key === "weijia" ? "devon_rex_cat" : null,
        custom_title: null
      }
    );
  });

  return {
    success: true,
    events: combinedEvents,
    roster: Array.from(rosterMap.values()),
    rsvpImport: {
      date: new Date().toISOString().slice(0, 10),
      yesArchers,
      allArchers: Array.from(rosterMap.values())
    }
  };
}

export async function getPrivateEventData(eventId, hubId = "long_weijia", linkedArchers = ["Long", "Weijia"]) {
  if (String(eventId || "").startsWith("league:")) {
    const rawId = String(eventId).replace(/^league:/, "");
    const evSnap = await getDoc(doc(db, "scoring_events", rawId));
    if (!evSnap.exists()) return { success: false, error: "League event not found" };
    const ev = evSnap.data();

    const [pSnap, gSnap, sSnap, notesSnap] = await Promise.all([
      getDocs(query(collection(db, "event_participants"), where("event_id", "==", rawId))),
      getDocs(query(collection(db, "scoring_groups"), where("event_id", "==", rawId))),
      getDocs(query(collection(db, "end_scores"), where("event_id", "==", rawId))),
      getDocs(query(collection(db, "private_league_notes"), where("hub_id", "==", hubId)))
    ]);

    const notesMap = {};
    notesSnap.forEach(d => {
      const n = d.data();
      notesMap[`${n.league_event_id}_${String(n.archer_key || "").toLowerCase()}`] = n.archer_notes || "";
    });

    ev.id = `league:${rawId}`;
    ev.raw_league_id = rawId;
    ev.is_league_synced = true;
    ev.session_category = "League";
    ev.midpoint_end = Math.floor((ev.ends_per_round || 10) / 2) + 1;
    ev.is_locked = false;

    const matchedParts = [];
    pSnap.forEach(d => {
      const p = d.data();
      const canonical = normalizeLinkedArcherMatch(p.name, linkedArchers);
      if (canonical) {
        matchedParts.push({ ...p, name: canonical });
      }
    });

    const scoresByPart = {};
    matchedParts.forEach(p => { scoresByPart[p.id] = []; });
    const eventScores = [];
    sSnap.forEach(d => {
      const s = d.data();
      const arr = Array.isArray(s.arrows)
        ? s.arrows
        : typeof s.arrows_json === "string"
        ? JSON.parse(s.arrows_json || "[]")
        : [];
      const item = { ...s, arrows: arr };
      if (scoresByPart[s.participant_id]) {
        scoresByPart[s.participant_id].push(item);
        eventScores.push(item);
      }
    });

    const enrichedParticipants = matchedParts.map(p => {
      const pScores = (scoresByPart[p.id] || []).sort((a, b) => (a.round_number - b.round_number) || (a.end_number - b.end_number));
      let runningTotal = 0, totalXs = 0, totalTens = 0, arrowsShot = 0, endsCompleted = 0;
      pScores.forEach(s => {
        if (s.arrows && s.arrows.length > 0) {
          runningTotal += Number(s.end_total) || 0;
          totalXs += Number(s.x_count) || 0;
          totalTens += Number(s.ten_count) || 0;
          arrowsShot += s.arrows.length;
          if (s.arrows.length >= (ev.arrows_per_end || 3)) endsCompleted++;
        }
      });
      const aKey = p.name.toLowerCase();
      return {
        ...p,
        bow_category: "BAREBOW",
        archer_notes: notesMap[`${rawId}_${aKey}`] || "",
        designation: `${p.bale_number || 1}${p.position || "A"}`,
        running_total: runningTotal,
        x_count: totalXs,
        ten_count: totalTens,
        arrows_shot: arrowsShot,
        ends_completed: endsCompleted,
        avg_per_arrow: arrowsShot > 0 ? (runningTotal / arrowsShot).toFixed(2) : "0.00",
        scores: pScores
      };
    });

    const totalEndsPerArcher = (ev.rounds || 1) * (ev.ends_per_round || 10);
    ev.all_scores_filled = enrichedParticipants.length > 0 && enrichedParticipants.every(p => p.ends_completed >= totalEndsPerArcher);
    ev.is_finished = ev.all_scores_filled;

    const leaderboard = [...enrichedParticipants]
      .sort((a, b) => (b.running_total - a.running_total) || (b.x_count - a.x_count) || (b.ten_count - a.ten_count))
      .map((p, idx) => ({ ...p, rank: idx + 1, category_rank: idx + 1 }));

    const groups = [];
    gSnap.forEach(d => {
      const g = d.data();
      groups.push({
        ...g,
        bales: Array.isArray(g.bales) ? g.bales.map(Number) : []
      });
    });

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

  const evSnap = await getDoc(doc(db, "private_events", eventId));
  if (!evSnap.exists()) return { success: false, error: "Private session not found" };
  const ev = evSnap.data();
  ev.midpoint_end = Math.floor((ev.ends_per_round || 10) / 2) + 1;
  ev.is_locked = false;

  const [pSnap, gSnap, sSnap] = await Promise.all([
    getDocs(query(collection(db, "private_participants"), where("event_id", "==", eventId))),
    getDocs(query(collection(db, "private_groups"), where("event_id", "==", eventId))),
    getDocs(query(collection(db, "private_end_scores"), where("event_id", "==", eventId)))
  ]);

  const participants = [];
  pSnap.forEach(d => participants.push(d.data()));
  participants.sort((a, b) => (Number(a.bale_number) - Number(b.bale_number)) || String(a.position).localeCompare(String(b.position)));

  const scoresByParticipant = {};
  participants.forEach(p => { scoresByParticipant[p.id] = []; });
  const eventScores = [];
  sSnap.forEach(d => {
    const s = d.data();
    const arr = Array.isArray(s.arrows)
      ? s.arrows
      : typeof s.arrows_json === "string"
      ? JSON.parse(s.arrows_json || "[]")
      : [];
    const item = { ...s, arrows: arr };
    eventScores.push(item);
    if (!scoresByParticipant[s.participant_id]) scoresByParticipant[s.participant_id] = [];
    scoresByParticipant[s.participant_id].push(item);
  });

  const enrichedParticipants = participants.map(p => {
    const pScores = (scoresByParticipant[p.id] || []).sort((a, b) => (a.round_number - b.round_number) || (a.end_number - b.end_number));
    let runningTotal = 0, totalXs = 0, totalTens = 0, arrowsShot = 0, endsCompleted = 0;
    pScores.forEach(s => {
      if (s.arrows && s.arrows.length > 0) {
        runningTotal += Number(s.end_total) || 0;
        totalXs += Number(s.x_count) || 0;
        totalTens += Number(s.ten_count) || 0;
        arrowsShot += s.arrows.length;
        if (s.arrows.length >= (ev.arrows_per_end || 3)) endsCompleted++;
      }
    });
    return {
      ...p,
      bow_category: p.bow_category || "BAREBOW",
      archer_notes: p.archer_notes || "",
      designation: `${p.bale_number || 1}${p.position || "A"}`,
      running_total: runningTotal,
      x_count: totalXs,
      ten_count: totalTens,
      arrows_shot: arrowsShot,
      ends_completed: endsCompleted,
      avg_per_arrow: arrowsShot > 0 ? (runningTotal / arrowsShot).toFixed(2) : "0.00",
      scores: pScores
    };
  });

  const totalEndsPerArcher = (ev.rounds || 1) * (ev.ends_per_round || 10);
  ev.all_scores_filled = enrichedParticipants.length > 0 && enrichedParticipants.every(p => p.ends_completed >= totalEndsPerArcher);
  ev.is_finished = ev.all_scores_filled;

  const leaderboard = [...enrichedParticipants]
    .sort((a, b) => (b.running_total - a.running_total) || (b.x_count - a.x_count) || (b.ten_count - a.ten_count))
    .map((p, idx) => ({ ...p, rank: idx + 1, category_rank: idx + 1 }));

  const groups = [];
  gSnap.forEach(d => {
    const g = d.data();
    groups.push({
      ...g,
      bales: Array.isArray(g.bales) ? g.bales.map(Number) : [1]
    });
  });

  if (groups.length === 0) {
    groups.push({
      id: `grp_${ev.id}_1`,
      event_id: ev.id,
      name: "Scoring Group 1 (Bale 1)",
      bales: [1, 2],
      nominated_scorer: "",
      current_round: 1,
      current_end: 1
    });
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
        name: String(p.name || "Archer").trim(),
        bow_category: p.bow_category || "BAREBOW",
        avatar_id: p.avatar_id || null,
        custom_title: p.custom_title || null,
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
  const now = new Date().toISOString();
  await setDoc(doc(db, "private_end_scores", id), {
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
    updated_at: now
  }, { merge: true });
  return { success: true };
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

export async function savePrivateBaleAssignments(hubId = "long_weijia", eventId, { participants, groups, balesPerGroup }, linkedArchers = ["Long", "Weijia"]) {
  if (balesPerGroup !== undefined) {
    await updateDoc(doc(db, "private_events", eventId), {
      bales_per_group: Number(balesPerGroup) || 2,
      updated_at: new Date().toISOString()
    });
  }

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
        ...p,
        id: pId,
        hub_id: hubId,
        event_id: eventId,
        name: String(p.name || "Archer").trim(),
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
  const cleanNote = String(archerNotes || "").trim();
  const now = new Date().toISOString();

  if (String(eventId || "").startsWith("league:")) {
    const rawId = String(eventId).replace(/^league:/, "");
    const aKey = String(archerName || "long").trim().toLowerCase();
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

const VALUE_MAP_USAA = { X: 10, "10": 10, "9": 9, "8": 8, "7": 7, "6": 6, "5": 5, "4": 4, "3": 3, "2": 2, "1": 1, M: 0 };
const VALUE_MAP_NFAA = { X: 5, "5": 5, "4": 4, "3": 3, "2": 2, "1": 1, M: 0 };

export async function getPrivateAnalyticsData(hubId = "long_weijia", linkedArchers = ["Long", "Weijia"]) {
  const [
    privEvSnap,
    privPartSnap,
    privScoreSnap,
    leagueEvSnap,
    leaguePartSnap,
    leagueScoreSnap,
    leagueNotesSnap
  ] = await Promise.all([
    getDocs(query(collection(db, "private_events"), where("hub_id", "==", hubId))),
    getDocs(query(collection(db, "private_participants"), where("hub_id", "==", hubId))),
    getDocs(query(collection(db, "private_end_scores"), where("hub_id", "==", hubId))),
    getDocs(collection(db, "scoring_events")),
    getDocs(collection(db, "event_participants")),
    getDocs(collection(db, "end_scores")),
    getDocs(query(collection(db, "private_league_notes"), where("hub_id", "==", hubId)))
  ]);

  const notesMap = {};
  leagueNotesSnap.forEach(d => {
    const n = d.data();
    notesMap[`${n.league_event_id}_${String(n.archer_key || "").toLowerCase()}`] = n.archer_notes || "";
  });

  const events = [];
  const privateDatesSet = new Set();
  privEvSnap.forEach(d => {
    const e = d.data();
    privateDatesSet.add(`${e.session_category || "Practice"}_${e.date}`);
    events.push(e);
  });

  const participants = [];
  privPartSnap.forEach(d => participants.push(d.data()));

  const scores = [];
  privScoreSnap.forEach(d => {
    const s = d.data();
    scores.push({
      ...s,
      arrows: Array.isArray(s.arrows) ? s.arrows : JSON.parse(s.arrows_json || "[]")
    });
  });

  // Merge live League events
  const lPartsByEv = {};
  leaguePartSnap.forEach(d => {
    const p = d.data();
    if (!lPartsByEv[p.event_id]) lPartsByEv[p.event_id] = [];
    lPartsByEv[p.event_id].push(p);
  });
  const lScoresByEv = {};
  leagueScoreSnap.forEach(d => {
    const s = d.data();
    if (!lScoresByEv[s.event_id]) lScoresByEv[s.event_id] = [];
    lScoresByEv[s.event_id].push({
      ...s,
      arrows: Array.isArray(s.arrows) ? s.arrows : JSON.parse(s.arrows_json || "[]")
    });
  });

  leagueEvSnap.forEach(d => {
    const lev = d.data();
    if (isTestLeagueEventName(lev.name)) return;
    if (privateDatesSet.has(`League_${lev.date}`)) return;

    const lParts = (lPartsByEv[lev.id] || []).filter(lp => Boolean(normalizeLinkedArcherMatch(lp.name, linkedArchers)));
    if (lParts.length === 0) return;

    const lScores = lScoresByEv[lev.id] || [];
    const hasArrows = lScores.some(ls => lParts.some(lp => lp.id === ls.participant_id) && ls.arrows && ls.arrows.length > 0);
    if (!hasArrows) return;

    const syncedEvId = `league:${lev.id}`;
    events.push({
      ...lev,
      id: syncedEvId,
      session_category: "League",
      distance: "18m",
      target_face: "Multi-color face",
      is_league_synced: true
    });

    lParts.forEach(lp => {
      const dispName = normalizeLinkedArcherMatch(lp.name, linkedArchers) || lp.name;
      const aKey = dispName.toLowerCase();
      participants.push({
        ...lp,
        name: dispName,
        event_id: syncedEvId,
        archer_notes: notesMap[`${lev.id}_${aKey}`] || ""
      });
    });

    lScores.forEach(ls => {
      if (lParts.some(lp => lp.id === ls.participant_id)) {
        scores.push({
          ...ls,
          event_id: syncedEvId
        });
      }
    });
  });

  events.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const eventMap = {};
  events.forEach(e => { eventMap[e.id] = e; });

  const scoresByPart = {};
  scores.forEach(s => {
    if (!scoresByPart[s.participant_id]) scoresByPart[s.participant_id] = [];
    scoresByPart[s.participant_id].push(s);
  });

  const archerSessionsMap = {};
  participants.forEach(p => {
    const ev = eventMap[p.event_id];
    if (!ev) return;
    const pScores = (scoresByPart[p.id] || [])
      .filter(s => s.arrows && s.arrows.length > 0)
      .sort((a, b) => (a.round_number - b.round_number) || (a.end_number - b.end_number));
    if (pScores.length === 0) return;

    const normName = String(p.name || "").trim();
    const key = normName.toLowerCase();
    if (!archerSessionsMap[key]) {
      archerSessionsMap[key] = {
        name: normName,
        avatar_id: p.avatar_id || (key === "long" ? "bengal_cat" : key === "weijia" ? "devon_rex_cat" : null),
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
    archersAnalytics[key] = {
      name: data.name,
      avatar_id: data.avatar_id,
      bow_category: data.bow_category,
      sessions
    };
  }

  return {
    archers: archersAnalytics,
    total_events: events.length
  };
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



