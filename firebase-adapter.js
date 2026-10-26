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
  
  // App Config & Status
  let config = { leagueTime: "6:00 PM", defaultStatus: "PENDING" };
  let event = { status: "PENDING" };
  try {
    const snap = await getDoc(doc(db, "app_state", "current"));
    if (snap.exists()) {
      const data = snap.data();
      if (data.config) config = { ...config, ...data.config };
      if (data.event) event = { ...event, ...data.event };
    }
  } catch (e) {
    console.error("Error reading app_state:", e);
  }

  // Roster
  const archers = [];
  try {
    const rosterSnap = await getDocs(collection(db, "roster"));
    rosterSnap.forEach(d => archers.push(d.data()));
  } catch (e) {
    console.error("Error reading roster:", e);
  }

  // RSVPs for upcoming Sunday
  const rsvps = [];
  try {
    const rsvpSnap = await getDocs(collection(db, "rsvps"));
    rsvpSnap.forEach(d => {
      const r = d.data();
      if (r.date === currentSunday) {
        rsvps.push(r);
      }
    });
  } catch (e) {
    console.error("Error reading rsvps:", e);
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
  const id = `${currentSunday}_${cleanName.toLowerCase()}`;
  const now = new Date().toISOString();

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
  const rosterRef = doc(db, "roster", cleanName.toLowerCase());
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
  const eventsSnap = await getDocs(collection(db, "scoring_events"));
  const pSnap = await getDocs(collection(db, "event_participants"));
  const gSnap = await getDocs(collection(db, "scoring_groups"));

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
  const rosterSnap = await getDocs(collection(db, "roster"));
  const roster = [];
  rosterSnap.forEach(d => roster.push(d.data()));

  const sunday = getUpcomingSundayStr();
  const yesArchers = [];
  try {
    const rsvpSnap = await getDocs(collection(db, "rsvps"));
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

  return {
    success: true,
    events,
    roster,
    rsvpImport: {
      date: sunday,
      yesArchers,
      allArchers: roster.map(r => ({
        name: r.name,
        bow_category: r.bowCategory || 'BAREBOW',
        avatar_id: r.avatarId,
        custom_title: r.customTitle
      }))
    }
  };
}

// 5. Scoring: Get Event Data (Full participants, scores, leaderboard)
export async function getEventData(eventId) {
  const evSnap = await getDoc(doc(db, "scoring_events", eventId));
  if (!evSnap.exists()) return { success: false, error: 'Event not found' };
  const ev = evSnap.data();

  ev.midpoint_end = Math.floor((ev.ends_per_round || 10) / 2) + 1;
  ev.is_locked = ev.status === 'COMPLETED';

  // Participants
  const pQuery = query(collection(db, "event_participants"), where("event_id", "==", eventId));
  const pSnap = await getDocs(pQuery);
  const participants = [];
  pSnap.forEach(d => participants.push(d.data()));
  participants.sort((a, b) => (Number(a.bale_number) - Number(b.bale_number)) || String(a.position).localeCompare(String(b.position)));

  // Scores
  const sQuery = query(collection(db, "end_scores"), where("event_id", "==", eventId));
  const sSnap = await getDocs(sQuery);
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
    const gQuery = query(collection(db, "scoring_groups"), where("event_id", "==", eventId));
    const gSnap = await getDocs(gQuery);
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
    for (let idx = 0; idx < participants.length; idx++) {
      const p = participants[idx];
      const pId = p.id || (`p_${eventId}_${idx}`);
      const bNum = Number(p.bale_number) || 1;
      await setDoc(doc(db, "event_participants", pId), {
        id: pId,
        event_id: eventId,
        name: p.name || 'Archer',
        bow_category: p.bow_category || 'BAREBOW',
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

    for (let idx = 0; idx < participants.length; idx++) {
      const p = participants[idx];
      const pId = p.id || (`p_${eventId}_${idx}_${Date.now()}`);
      keepIds.add(pId);
      const bNum = Number(p.bale_number) || 1;
      const resolvedGroupId = baleToGroupId[bNum] || p.group_id || (`grp_${eventId}_1`);
      await setDoc(doc(db, "event_participants", pId), {
        ...p,
        id: pId,
        event_id: eventId,
        bale_number: bNum,
        group_id: resolvedGroupId,
        sort_order: idx
      }, { merge: true });
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

