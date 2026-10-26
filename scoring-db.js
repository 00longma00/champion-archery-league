const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { readDB, writeDB } = require('./db');

const DB_PATH = path.join(__dirname, 'league_scoring.db');
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode and foreign keys for race-condition-free concurrent writes
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS scoring_events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL DEFAULT '18:00',
    status TEXT NOT NULL DEFAULT 'SETUP',
    max_bales INTEGER NOT NULL DEFAULT 6,
    rounds INTEGER NOT NULL DEFAULT 1,
    ends_per_round INTEGER NOT NULL DEFAULT 10,
    arrows_per_end INTEGER NOT NULL DEFAULT 3,
    scoring_type TEXT NOT NULL DEFAULT 'USAA_10',
    swap_top_bottom INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scoring_groups (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    bales_json TEXT NOT NULL DEFAULT '[]',
    nominated_scorer TEXT DEFAULT '',
    current_round INTEGER NOT NULL DEFAULT 1,
    current_end INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES scoring_events(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS event_participants (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    bow_category TEXT NOT NULL DEFAULT 'BAREBOW',
    avatar_id TEXT DEFAULT NULL,
    custom_title TEXT DEFAULT NULL,
    bale_number INTEGER NOT NULL DEFAULT 1,
    position TEXT NOT NULL DEFAULT 'A',
    shooting_line TEXT NOT NULL DEFAULT 'AB',
    lane TEXT NOT NULL DEFAULT 'Left',
    initial_target TEXT NOT NULL DEFAULT 'Top',
    group_id TEXT DEFAULT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (event_id) REFERENCES scoring_events(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS end_scores (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    round_number INTEGER NOT NULL DEFAULT 1,
    end_number INTEGER NOT NULL DEFAULT 1,
    arrows_json TEXT NOT NULL DEFAULT '[]',
    end_total INTEGER NOT NULL DEFAULT 0,
    x_count INTEGER NOT NULL DEFAULT 0,
    ten_count INTEGER NOT NULL DEFAULT 0,
    scored_by TEXT DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(event_id, participant_id, round_number, end_number),
    FOREIGN KEY (event_id) REFERENCES scoring_events(id) ON DELETE CASCADE,
    FOREIGN KEY (participant_id) REFERENCES event_participants(id) ON DELETE CASCADE
  );
`);

// Safe migrations for existing SQLite databases
function ensureColumn(tableName, colName, colDef) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!cols.some(c => c.name === colName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colDef}`);
  }
}
ensureColumn('scoring_events', 'start_time', "TEXT NOT NULL DEFAULT '18:00'");
ensureColumn('event_participants', 'bow_category', "TEXT NOT NULL DEFAULT 'BAREBOW'");

const BOW_CATEGORIES = {
  BAREBOW: { id: 'BAREBOW', label: 'Barebow', shortLabel: 'Barebow' },
  OLYMPIC_RECURVE: { id: 'OLYMPIC_RECURVE', label: 'Olympic Recurve', shortLabel: 'Olympic Recurve' },
  TRADITIONAL: { id: 'TRADITIONAL', label: 'Traditional', shortLabel: 'Traditional' },
  COMPOUND: { id: 'COMPOUND', label: 'Compound', shortLabel: 'Compound' }
};

function normalizeBowCategory(cat) {
  const upper = String(cat || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (upper === 'OLYMPIC_RECURVE' || upper === 'OLYMPIC' || upper === 'RECURVE' || upper === 'FSLR') return 'OLYMPIC_RECURVE';
  if (upper === 'TRADITIONAL' || upper === 'TRADITION' || upper === 'TRAD') return 'TRADITIONAL';
  if (upper === 'COMPOUND' || upper === 'FS' || upper === 'BHFS') return 'COMPOUND';
  return 'BAREBOW';
}

function computeEventLockStatus(dateStr, startTimeStr = '18:00') {
  const parts = String(dateStr || '').split('-').map(Number);
  const year = parts[0] || new Date().getFullYear();
  const month = (parts[1] || 1) - 1;
  const day = parts[2] || 1;

  let hours = 18;
  let minutes = 0;
  const rawTime = String(startTimeStr || '18:00').trim();
  const match = rawTime.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (match) {
    let h = parseInt(match[1], 10);
    const m = match[2] ? parseInt(match[2], 10) : 0;
    const ampm = match[3] ? match[3].toUpperCase() : '';
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    hours = Math.min(23, Math.max(0, h));
    minutes = Math.min(59, Math.max(0, m));
  }

  const scheduledStart = new Date(year, month, day, hours, minutes, 0, 0);
  const lockDeadline = new Date(scheduledStart.getTime() + 8 * 60 * 60 * 1000); // +8 hours
  const now = new Date();
  const isLocked = now.getTime() > lockDeadline.getTime();

  return {
    scheduled_start_iso: scheduledStart.toISOString(),
    lock_deadline_iso: lockDeadline.toISOString(),
    lock_deadline_display: lockDeadline.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }),
    is_locked: isLocked,
    ms_remaining: Math.max(0, lockDeadline.getTime() - now.getTime())
  };
}

// Scoring format definitions & helpers
const SCORING_FORMATS = {
  USAA_10: {
    id: 'USAA_10',
    label: 'USAA 10-Ring (X, 10..1, M)',
    validKeys: ['X', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1', 'M'],
    valueMap: { 'X': 10, '10': 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2, '1': 1, 'M': 0 },
    sortRank: { 'X': 11, '10': 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2, '1': 1, 'M': 0 },
    maxArrowValue: 10
  },
  NFAA_5SPOT: {
    id: 'NFAA_5SPOT',
    label: 'NFAA 5-Spot (X=5, 5, 4, M)',
    validKeys: ['X', '5', '4', 'M'],
    valueMap: { 'X': 5, '5': 5, '4': 4, 'M': 0 },
    sortRank: { 'X': 6, '5': 5, '4': 4, 'M': 0 },
    maxArrowValue: 5
  },
  NFAA_SINGLE: {
    id: 'NFAA_SINGLE',
    label: 'NFAA Single-Spot (X=5, 5..1, M)',
    validKeys: ['X', '5', '4', '3', '2', '1', 'M'],
    valueMap: { 'X': 5, '5': 5, '4': 4, '3': 3, '2': 2, '1': 1, 'M': 0 },
    sortRank: { 'X': 6, '5': 5, '4': 4, '3': 3, '2': 2, '1': 1, 'M': 0 },
    maxArrowValue: 5
  },
  NFAA_BLUEFACE: {
    id: 'NFAA_BLUEFACE',
    label: 'NFAA Blueface 300 (X=5, 5..1, M)',
    validKeys: ['X', '5', '4', '3', '2', '1', 'M'],
    valueMap: { 'X': 5, '5': 5, '4': 4, '3': 3, '2': 2, '1': 1, 'M': 0 },
    sortRank: { 'X': 6, '5': 5, '4': 4, '3': 3, '2': 2, '1': 1, 'M': 0 },
    defaultEnds: 12,
    defaultArrows: 5,
    maxArrowValue: 5
  }
};

function normalizeAndSortArrows(arrows, scoringType = 'USAA_10', maxArrows = 5) {
  const format = SCORING_FORMATS[scoringType] || SCORING_FORMATS.USAA_10;
  if (!Array.isArray(arrows)) return { sorted: [], endTotal: 0, xCount: 0, tenCount: 0 };

  const cleaned = arrows
    .map(a => String(a || '').trim().toUpperCase())
    .filter(a => format.validKeys.includes(a))
    .slice(0, maxArrows);

  // Official USAA/NFAA descending arrow sort (X -> 10 -> 9 ... -> M)
  cleaned.sort((a, b) => (format.sortRank[b] ?? -1) - (format.sortRank[a] ?? -1));

  let endTotal = 0;
  let xCount = 0;
  let tenCount = 0;

  for (const arrow of cleaned) {
    const val = format.valueMap[arrow] || 0;
    endTotal += val;
    if (arrow === 'X') {
      xCount += 1;
      tenCount += 1;
    } else if (val === format.maxArrowValue) {
      tenCount += 1;
    }
  }

  return {
    sorted: cleaned,
    endTotal,
    xCount,
    tenCount
  };
}

/**
 * Official USA Archery / NFAA Auto-Assign Bales Algorithm
 * - 1-2 archers per bale (up to 2 * maxBales):
 *   Distributes evenly so each bale has up to 2 archers (Position A = Left, Position B = Right, Line = AB).
 *   If swapTopBottom is enabled, defaults A = Top, B = Bottom so midpoint swap applies cleanly.
 * - 3-4 archers per bale (exceeding 2 * maxBales, up to 4 * maxBales):
 *   Assigns using standard AB/CD matrix:
 *     A: Top-Left (Line AB)
 *     B: Top-Right (Line AB)
 *     C: Bottom-Left (Line CD)
 *     D: Bottom-Right (Line CD)
 */
function computeAutoAssignments(participantList, maxBales = 6, swapTopBottom = true) {
  const count = participantList.length;
  if (count === 0) return [];

  const cappedBales = Math.max(1, Math.min(6, parseInt(maxBales, 10) || 6));
  const twoPerBaleCapacity = cappedBales * 2;
  const results = [];

  if (count <= twoPerBaleCapacity) {
    // 1-2 archers per bale mode:
    // Use enough bales so no bale exceeds 2 archers, distributing evenly across active bales
    const activeBales = Math.min(cappedBales, Math.max(1, Math.ceil(count / 2)));
    // First pass: put 1 archer on each active bale (Position A), second pass: Position B
    // Wait: if we have e.g. 6 archers and 6 maxBales, should we put 2 archers on 3 bales or 1 archer on 6 bales?
    // In club/league nights, 2 archers per bale is standard (A and B share a bale), or distribute across bales.
    // Let's check the spec:
    // "1–2 archers per bale (up to 12 archers across 6 bales):
    //  Distribute evenly so each bale has up to 2 archers before overflows occur.
    //  Assign Position A = Left, Position B = Right (Single shooting line)."
    // If we pair archers 2 per bale first (or spread evenly across activeBales where activeBales = ceil(count / 2) or min(cappedBales, count)):
    //Wait: if 8 archers and 6 bales, pairing 2 per bale uses 4 bales (1A, 1B, 2A, 2B, 3A, 3B, 4A, 4B) — or spreading across 6 bales gives Bales 1-2 with 2 archers and Bales 3-6 with 1 archer.
    // Pairing 2 per bale (Bale 1: A, B; Bale 2: A, B...) is the most practical on a range (fewer targets to set up and every bale has 2 archers for top/bottom swap!).
    // Wait: what if someone wants them spread across all bales or paired 2 per bale?
    // Let's re-read carefully:
    // "Distribute evenly so each bale has up to 2 archers before overflows occur. Assign Position A = Left, Position B = Right (Single shooting line)."
    // Notice "before overflows occur" means: each bale gets up to 2 archers (A and B) BEFORE overflowing into C and D!
    // And pairing 2 archers per bale (1A, 1B, 2A, 2B, 3A, 3B...) ensures each bale has BOTH a Top (A) and Bottom (B) archer for the midpoint target swap!
    // Wait — what if there is an odd number of archers, e.g., 5 archers? Bale 1 (1A, 1B), Bale 2 (2A, 2B), Bale 3 (3A).
    for (let i = 0; i < count; i++) {
      const baleNumber = Math.floor(i / 2) + 1;
      const isSecond = (i % 2) === 1;
      const position = isSecond ? 'B' : 'A';
      const lane = isSecond ? 'Right' : 'Left';
      const initialTarget = isSecond ? 'Bottom' : 'Top';
      results.push({
        ...participantList[i],
        bale_number: baleNumber,
        position,
        shooting_line: 'AB',
        lane,
        initial_target: initialTarget
      });
    }
  } else {
    // 3-4 archers per bale mode (AB/CD matrix)
    // Distribute across cappedBales so bales have 3-4 archers each
    const activeBales = Math.min(cappedBales, Math.ceil(count / 4) > 0 ? Math.max(Math.ceil(count / 4), Math.min(cappedBales, Math.ceil(count / 3))) : cappedBales);
    // Actually, when count > 2 * cappedBales (e.g. 13..24 across 6 bales), all cappedBales are used!
    // Let's fill bales round-robin or bale-by-bale up to 4 per bale:
    // Round-robin by position (all A's, then B's, then C's, then D's) OR fill up to 4 per bale?
    // Wait: if you have 16 archers on 6 bales:
    // Round-robin across the 6 bales (or filling bales of 4/3):
    // In USA Archery / NFAA, distributing evenly across the 6 bales means 4 bales have 3 archers (A, B, C) and 2 bales have 2 archers (A, B), OR 4 bales have 4 archers (A, B, C, D).
    // Let's distribute evenly across `cappedBales` bales so bale sizes differ by at most 1 (e.g., 16 archers across 6 bales -> bales 1-4 get 3 archers, bales 5-6 get 2 archers; or fill sequential slots).
    const posConfig = {
      0: { position: 'A', shooting_line: 'AB', lane: 'Left', initial_target: 'Top' },
      1: { position: 'B', shooting_line: 'AB', lane: 'Right', initial_target: 'Top' },
      2: { position: 'C', shooting_line: 'CD', lane: 'Left', initial_target: 'Bottom' },
      3: { position: 'D', shooting_line: 'CD', lane: 'Right', initial_target: 'Bottom' }
    };

    // Distribute evenly across cappedBales so every bale gets A, then B, then C, then D
    // Wait: if we sort the assigned slots by bale_number then position, then assign archers in order:
    const basePerBale = Math.floor(count / cappedBales);
    const extraBales = count % cappedBales;
    let archerIdx = 0;
    for (let b = 1; b <= cappedBales; b++) {
      const archersOnThisBale = Math.min(4, basePerBale + (b <= extraBales ? 1 : 0));
      for (let s = 0; s < archersOnThisBale && archerIdx < count; s++) {
        const cfg = posConfig[s] || posConfig[3];
        results.push({
          ...participantList[archerIdx],
          bale_number: b,
          position: cfg.position,
          shooting_line: cfg.shooting_line,
          lane: cfg.lane,
          initial_target: cfg.initial_target
        });
        archerIdx++;
      }
    }
    // If count > 4 * cappedBales (overflow safety), put remaining on last bale
    while (archerIdx < count) {
      const s = archerIdx % 4;
      const cfg = posConfig[s];
      results.push({
        ...participantList[archerIdx],
        bale_number: cappedBales,
        position: cfg.position,
        shooting_line: cfg.shooting_line,
        lane: cfg.lane,
        initial_target: cfg.initial_target
      });
      archerIdx++;
    }
  }

  return results;
}

/**
 * Default Scoring Groups Generator
 * - If max archers on any bale <= 2: pairs adjacent active bales (e.g. Bale 1 & 2, Bale 3 & 4, Bale 5 & 6)
 * - If any bale has 3-4 archers: 1 bale per Scoring Group (e.g. Group 1: Bale 1, Group 2: Bale 2...)
 */
function computeDefaultGroups(participants) {
  const baleCounts = {};
  for (const p of participants) {
    const b = Number(p.bale_number) || 1;
    baleCounts[b] = (baleCounts[b] || 0) + 1;
  }

  const activeBales = Object.keys(baleCounts).map(Number).sort((a, b) => a - b);
  if (activeBales.length === 0) {
    return [{ name: 'Scoring Group 1 (Bales 1 & 2)', bales: [1, 2] }];
  }

  const maxOnAnyBale = Math.max(...Object.values(baleCounts));
  const groups = [];

  if (maxOnAnyBale <= 2) {
    // Pair adjacent active bales (2 bales per group)
    for (let i = 0; i < activeBales.length; i += 2) {
      const pair = activeBales.slice(i, i + 2);
      const groupNum = groups.length + 1;
      const baleLabel = pair.length === 2 ? `Bales ${pair[0]} & ${pair[1]}` : `Bale ${pair[0]}`;
      groups.push({
        name: `Scoring Group ${groupNum} (${baleLabel})`,
        bales: pair
      });
    }
  } else {
    // 1 bale per group when 3-4 archers are on a bale
    activeBales.forEach((baleNum, idx) => {
      groups.push({
        name: `Scoring Group ${idx + 1} (Bale ${baleNum})`,
        bales: [baleNum]
      });
    });
  }

  return groups;
}

// Position metadata helper when user manually changes position A/B/C/D
function getPositionDefaults(position, totalOnBale = 2) {
  const pos = String(position || 'A').toUpperCase();
  if (totalOnBale <= 2) {
    if (pos === 'A') return { shooting_line: 'AB', lane: 'Left', initial_target: 'Top' };
    if (pos === 'B') return { shooting_line: 'AB', lane: 'Right', initial_target: 'Bottom' };
  }
  switch (pos) {
    case 'A': return { shooting_line: 'AB', lane: 'Left', initial_target: 'Top' };
    case 'B': return { shooting_line: 'AB', lane: 'Right', initial_target: 'Top' };
    case 'C': return { shooting_line: 'CD', lane: 'Left', initial_target: 'Bottom' };
    case 'D': return { shooting_line: 'CD', lane: 'Right', initial_target: 'Bottom' };
    default: return { shooting_line: 'AB', lane: 'Left', initial_target: 'Top' };
  }
}

// Database CRUD functions
function listEvents() {
  const events = db.prepare(`
    SELECT * FROM scoring_events
    ORDER BY date DESC, created_at DESC
  `).all();

  return events.map(ev => {
    const pCount = db.prepare(`SELECT COUNT(*) as cnt FROM event_participants WHERE event_id = ?`).get(ev.id)?.cnt || 0;
    const gCount = db.prepare(`SELECT COUNT(*) as cnt FROM scoring_groups WHERE event_id = ?`).get(ev.id)?.cnt || 0;
    const lockInfo = computeEventLockStatus(ev.date, ev.start_time || '18:00');

    // Check if all ends are scored for all participants
    const totalExpectedEnds = pCount * (ev.rounds || 1) * (ev.ends_per_round || 10);
    let completedEndsCount = 0;
    if (pCount > 0) {
      const allScores = db.prepare(`SELECT arrows_json FROM end_scores WHERE event_id = ?`).all(ev.id);
      for (const s of allScores) {
        try {
          const arr = JSON.parse(s.arrows_json || '[]');
          if (arr.length >= (ev.arrows_per_end || 3)) completedEndsCount++;
        } catch (e) {}
      }
    }
    const allScoresFilled = pCount > 0 && completedEndsCount >= totalExpectedEnds;

    return {
      ...ev,
      start_time: ev.start_time || '18:00',
      swap_top_bottom: Boolean(ev.swap_top_bottom),
      participant_count: pCount,
      group_count: gCount,
      all_scores_filled: allScoresFilled,
      ...lockInfo
    };
  });
}

function getFullEvent(eventId) {
  const event = db.prepare(`SELECT * FROM scoring_events WHERE id = ?`).get(eventId);
  if (!event) return null;

  event.start_time = event.start_time || '18:00';
  event.swap_top_bottom = Boolean(event.swap_top_bottom);
  event.format_info = SCORING_FORMATS[event.scoring_type] || SCORING_FORMATS.USAA_10;
  event.midpoint_end = Math.floor(event.ends_per_round / 2) + 1;
  Object.assign(event, computeEventLockStatus(event.date, event.start_time));

  const groups = db.prepare(`
    SELECT * FROM scoring_groups
    WHERE event_id = ?
    ORDER BY id ASC
  `).all(eventId).map(g => ({
    ...g,
    bales: JSON.parse(g.bales_json || '[]')
  }));

  const participants = db.prepare(`
    SELECT * FROM event_participants
    WHERE event_id = ?
    ORDER BY bale_number ASC, position ASC, sort_order ASC, name ASC
  `).all(eventId);

  const scores = db.prepare(`
    SELECT * FROM end_scores
    WHERE event_id = ?
    ORDER BY round_number ASC, end_number ASC
  `).all(eventId).map(s => ({
    ...s,
    arrows: JSON.parse(s.arrows_json || '[]')
  }));

  // Map scores by participant
  const scoresByParticipant = {};
  for (const p of participants) {
    scoresByParticipant[p.id] = [];
  }
  for (const s of scores) {
    if (!scoresByParticipant[s.participant_id]) {
      scoresByParticipant[s.participant_id] = [];
    }
    scoresByParticipant[s.participant_id].push(s);
  }

  // Enrich participants with running totals and build leaderboard
  const enrichedParticipants = participants.map(p => {
    const pScores = scoresByParticipant[p.id] || [];
    let runningTotal = 0;
    let totalXs = 0;
    let totalTens = 0;
    let arrowsShot = 0;
    let endsCompleted = 0;

    for (const s of pScores) {
      if (s.arrows && s.arrows.length > 0) {
        runningTotal += s.end_total;
        totalXs += s.x_count;
        totalTens += s.ten_count;
        arrowsShot += s.arrows.length;
        if (s.arrows.length >= event.arrows_per_end) {
          endsCompleted += 1;
        }
      }
    }

    const bowCat = normalizeBowCategory(p.bow_category);
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

  const totalEndsPerArcher = (event.rounds || 1) * (event.ends_per_round || 10);
  const allScoresFilled = enrichedParticipants.length > 0 && enrichedParticipants.every(p => p.ends_completed >= totalEndsPerArcher);
  event.all_scores_filled = allScoresFilled;
  event.is_finished = Boolean(event.is_locked || event.status === 'COMPLETED' || allScoresFilled);

  // Leaderboard sorted by Running Score DESC, X-Count DESC, 10-Count DESC, Bale/Pos ASC
  const categoryRankCounters = { BAREBOW: 0, OLYMPIC_RECURVE: 0, TRADITIONAL: 0 };
  const leaderboard = [...enrichedParticipants].sort((a, b) => {
    if (b.running_total !== a.running_total) return b.running_total - a.running_total;
    if (b.x_count !== a.x_count) return b.x_count - a.x_count;
    if (b.ten_count !== a.ten_count) return b.ten_count - a.ten_count;
    return a.designation.localeCompare(b.designation);
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
    BAREBOW: leaderboard.filter(p => p.bow_category === 'BAREBOW'),
    OLYMPIC_RECURVE: leaderboard.filter(p => p.bow_category === 'OLYMPIC_RECURVE'),
    TRADITIONAL: leaderboard.filter(p => p.bow_category === 'TRADITIONAL')
  };

  return {
    event,
    groups,
    participants: enrichedParticipants,
    leaderboard,
    leaderboard_by_category: leaderboardByCategory,
    scores
  };
}

function createEvent(payload) {
  const now = new Date().toISOString();
  const id = 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const name = String(payload.name || 'Sunday League Night').trim();
  const date = String(payload.date || new Date().toISOString().slice(0, 10)).trim();
  const startTime = String(payload.start_time || '18:00').trim();
  const maxBales = Math.max(1, Math.min(6, parseInt(payload.max_bales, 10) || 6));
  const rounds = Math.max(1, Math.min(4, parseInt(payload.rounds, 10) || 1));
  const endsPerRound = Math.max(1, Math.min(30, parseInt(payload.ends_per_round, 10) || 10));
  const arrowsPerEnd = [3, 5].includes(parseInt(payload.arrows_per_end, 10)) ? parseInt(payload.arrows_per_end, 10) : 3;
  const scoringType = SCORING_FORMATS[payload.scoring_type] ? payload.scoring_type : 'USAA_10';
  const swapTopBottom = payload.swap_top_bottom !== false ? 1 : 0;

  db.prepare(`
    INSERT INTO scoring_events (
      id, name, date, start_time, status, max_bales, rounds, ends_per_round, arrows_per_end, scoring_type, swap_top_bottom, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'SETUP', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, date, startTime, maxBales, rounds, endsPerRound, arrowsPerEnd, scoringType, swapTopBottom, now, now);

  // If initial participants provided, auto-assign and create default groups
  if (Array.isArray(payload.participants) && payload.participants.length > 0) {
    saveParticipantsAndGroups(id, {
      participants: payload.participants,
      autoAssign: true,
      defaultGroups: true
    });
  }

  return getFullEvent(id);
}

function updateEventSettings(eventId, payload) {
  const existing = db.prepare(`SELECT * FROM scoring_events WHERE id = ?`).get(eventId);
  if (!existing) throw new Error('Event not found');

  const name = payload.name !== undefined ? String(payload.name).trim() : existing.name;
  const date = payload.date !== undefined ? String(payload.date).trim() : existing.date;
  const startTime = payload.start_time !== undefined ? String(payload.start_time).trim() : (existing.start_time || '18:00');
  const status = payload.status !== undefined ? String(payload.status).trim() : existing.status;
  const maxBales = payload.max_bales !== undefined ? Math.max(1, Math.min(6, parseInt(payload.max_bales, 10) || 6)) : existing.max_bales;
  const rounds = payload.rounds !== undefined ? Math.max(1, Math.min(4, parseInt(payload.rounds, 10) || 1)) : existing.rounds;
  const endsPerRound = payload.ends_per_round !== undefined ? Math.max(1, Math.min(30, parseInt(payload.ends_per_round, 10) || 10)) : existing.ends_per_round;
  const arrowsPerEnd = payload.arrows_per_end !== undefined ? ([3, 5].includes(parseInt(payload.arrows_per_end, 10)) ? parseInt(payload.arrows_per_end, 10) : 3) : existing.arrows_per_end;
  const scoringType = payload.scoring_type !== undefined && SCORING_FORMATS[payload.scoring_type] ? payload.scoring_type : existing.scoring_type;
  const swapTopBottom = payload.swap_top_bottom !== undefined ? (payload.swap_top_bottom ? 1 : 0) : existing.swap_top_bottom;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE scoring_events
    SET name = ?, date = ?, start_time = ?, status = ?, max_bales = ?, rounds = ?, ends_per_round = ?, arrows_per_end = ?, scoring_type = ?, swap_top_bottom = ?, updated_at = ?
    WHERE id = ?
  `).run(name, date, startTime, status, maxBales, rounds, endsPerRound, arrowsPerEnd, scoringType, swapTopBottom, now, eventId);

  return getFullEvent(eventId);
}

function saveParticipantsAndGroups(eventId, { participants, groups, autoAssign = false, defaultGroups = false }) {
  const event = db.prepare(`SELECT * FROM scoring_events WHERE id = ?`).get(eventId);
  if (!event) throw new Error('Event not found');

  const now = new Date().toISOString();
  const existingParticipants = db.prepare(`SELECT * FROM event_participants WHERE event_id = ?`).all(eventId);
  const existingByName = {};
  const existingById = {};
  for (const ep of existingParticipants) {
    existingByName[ep.name.toLowerCase()] = ep;
    existingById[ep.id] = ep;
  }

  // Also load global archer profiles from data.json + historical event_participants as fallback
  const rosterDb = readDB();
  const rosterByName = {};
  (rosterDb.archers || []).forEach(a => {
    rosterByName[a.name.toLowerCase()] = a;
  });

  const histRows = db.prepare(`
    SELECT name, bow_category, avatar_id, custom_title
    FROM event_participants
    ORDER BY rowid DESC
  `).all();
  const histByName = {};
  for (const hr of histRows) {
    const k = (hr.name || '').toLowerCase();
    if (k && !histByName[k]) {
      histByName[k] = hr;
    }
  }

  let preparedList = (participants || []).map((p, idx) => {
    const cleanName = String(p.name || '').trim();
    const key = cleanName.toLowerCase();
    const matched = (p.id && existingById[p.id]) || existingByName[key];
    const rosterProfile = rosterByName[key];
    const histProfile = histByName[key];

    const resolvedBowCategory = normalizeBowCategory(
      p.bow_category ||
      (matched && matched.bow_category) ||
      (rosterProfile && rosterProfile.bowCategory) ||
      (histProfile && histProfile.bow_category) ||
      'BAREBOW'
    );
    const resolvedAvatarId =
      p.avatar_id ||
      (matched && matched.avatar_id) ||
      (rosterProfile && rosterProfile.avatarId) ||
      (histProfile && histProfile.avatar_id) ||
      null;
    const resolvedCustomTitle =
      p.custom_title !== undefined
        ? p.custom_title
        : ((matched && matched.custom_title !== undefined)
            ? matched.custom_title
            : ((rosterProfile && rosterProfile.customTitle !== undefined)
                ? rosterProfile.customTitle
                : (histProfile ? histProfile.custom_title : null)));

    return {
      id: matched ? matched.id : ('p_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).slice(2, 5)),
      name: rosterProfile ? rosterProfile.name : cleanName,
      bow_category: resolvedBowCategory,
      avatar_id: resolvedAvatarId,
      custom_title: resolvedCustomTitle,
      bale_number: Number(p.bale_number) || (matched ? matched.bale_number : 1),
      position: String(p.position || (matched ? matched.position : 'A')).toUpperCase(),
      shooting_line: p.shooting_line || (matched ? matched.shooting_line : 'AB'),
      lane: p.lane || (matched ? matched.lane : 'Left'),
      initial_target: p.initial_target || (matched ? matched.initial_target : 'Top'),
      group_id: p.group_id !== undefined ? p.group_id : (matched ? matched.group_id : null),
      sort_order: idx
    };
  }).filter(p => p.name.length > 0);

  if (autoAssign) {
    preparedList = computeAutoAssignments(preparedList, event.max_bales, Boolean(event.swap_top_bottom));
  }

  // Determine groups
  let groupSpecs = groups;
  if (defaultGroups || !Array.isArray(groupSpecs) || groupSpecs.length === 0) {
    const existingGroups = db.prepare(`SELECT * FROM scoring_groups WHERE event_id = ? ORDER BY id ASC`).all(eventId);
    if (!defaultGroups && existingGroups.length > 0 && !Array.isArray(groups)) {
      groupSpecs = existingGroups.map(g => ({
        id: g.id,
        name: g.name,
        bales: JSON.parse(g.bales_json || '[]'),
        nominated_scorer: g.nominated_scorer,
        current_round: g.current_round,
        current_end: g.current_end
      }));
    } else {
      groupSpecs = computeDefaultGroups(preparedList);
    }
  }

  // Save groups and map bales -> group_id
  db.exec('BEGIN');
  try {
    const existingGroups = db.prepare(`SELECT * FROM scoring_groups WHERE event_id = ?`).all(eventId);
    const existingGroupMap = {};
    for (const eg of existingGroups) {
      existingGroupMap[eg.id] = eg;
    }

    // Clear old groups and re-insert (preserving IDs and nominated_scorer when possible)
    db.prepare(`DELETE FROM scoring_groups WHERE event_id = ?`).run(eventId);

    const baleToGroupId = {};
    const savedGroups = [];

    groupSpecs.forEach((g, idx) => {
      const gId = g.id && existingGroupMap[g.id] ? g.id : `grp_${eventId}_${idx + 1}`;
      const prev = existingGroupMap[gId];
      const balesArr = Array.isArray(g.bales) ? g.bales.map(Number).filter(Boolean) : [];
      const gName = String(g.name || `Scoring Group ${idx + 1}`).trim();
      const scorer = g.nominated_scorer !== undefined ? String(g.nominated_scorer).trim() : (prev ? prev.nominated_scorer : '');
      const curRound = g.current_round || (prev ? prev.current_round : 1);
      const curEnd = g.current_end || (prev ? prev.current_end : 1);

      db.prepare(`
        INSERT INTO scoring_groups (id, event_id, name, bales_json, nominated_scorer, current_round, current_end, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(gId, eventId, gName, JSON.stringify(balesArr), scorer, curRound, curEnd, now);

      for (const b of balesArr) {
        baleToGroupId[b] = gId;
      }
      savedGroups.push({ id: gId, bales: balesArr });
    });

    // Remove participants no longer in list
    const keepIds = new Set(preparedList.map(p => p.id));
    for (const ep of existingParticipants) {
      if (!keepIds.has(ep.id)) {
        db.prepare(`DELETE FROM event_participants WHERE id = ?`).run(ep.id);
      }
    }

    // Upsert participants
    const upsertParticipant = db.prepare(`
      INSERT INTO event_participants (
        id, event_id, name, bow_category, avatar_id, custom_title, bale_number, position, shooting_line, lane, initial_target, group_id, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        bow_category = excluded.bow_category,
        avatar_id = excluded.avatar_id,
        custom_title = excluded.custom_title,
        bale_number = excluded.bale_number,
        position = excluded.position,
        shooting_line = excluded.shooting_line,
        lane = excluded.lane,
        initial_target = excluded.initial_target,
        group_id = excluded.group_id,
        sort_order = excluded.sort_order
    `);

    preparedList.forEach((p, idx) => {
      const assignedGroupId = baleToGroupId[p.bale_number] || (savedGroups[0] ? savedGroups[0].id : null);
      upsertParticipant.run(
        p.id,
        eventId,
        p.name,
        normalizeBowCategory(p.bow_category),
        p.avatar_id || null,
        p.custom_title || null,
        p.bale_number,
        p.position,
        p.shooting_line,
        p.lane,
        p.initial_target,
        assignedGroupId,
        idx
      );
    });

    db.prepare(`UPDATE scoring_events SET updated_at = ? WHERE id = ?`).run(now, eventId);
    db.exec('COMMIT');

    // Sync each participant's bow_category, avatar_id, and custom_title back to global data.json roster
    let rosterChanged = false;
    if (!rosterDb.archers) rosterDb.archers = [];
    for (const p of preparedList) {
      const key = p.name.toLowerCase();
      let archer = rosterDb.archers.find(a => a.name.toLowerCase() === key);
      const normCat = normalizeBowCategory(p.bow_category);
      if (!archer) {
        archer = {
          id: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 5),
          name: p.name,
          avatarId: p.avatar_id || null,
          bowCategory: normCat,
          customTitle: p.custom_title || null,
          email: '',
          remindMe: false,
          createdAt: now
        };
        rosterDb.archers.push(archer);
        rosterByName[key] = archer;
        rosterChanged = true;
      } else {
        if (p.bow_category && archer.bowCategory !== normCat) {
          archer.bowCategory = normCat;
          rosterChanged = true;
        }
        if (p.avatar_id && archer.avatarId !== p.avatar_id) {
          archer.avatarId = p.avatar_id;
          rosterChanged = true;
        }
        if (p.custom_title !== undefined && p.custom_title !== null && archer.customTitle !== p.custom_title) {
          archer.customTitle = p.custom_title;
          rosterChanged = true;
        }
      }
      // Keep RSVP entries in sync
      if (rosterDb.rsvps) {
        Object.keys(rosterDb.rsvps).forEach(dateKey => {
          (rosterDb.rsvps[dateKey] || []).forEach(r => {
            if (r.archerName && r.archerName.toLowerCase() === key) {
              if (archer.avatarId && r.avatarId !== archer.avatarId) {
                r.avatarId = archer.avatarId;
                rosterChanged = true;
              }
              if (archer.bowCategory && r.bowCategory !== archer.bowCategory) {
                r.bowCategory = archer.bowCategory;
                rosterChanged = true;
              }
            }
          });
        });
      }
    }
    if (rosterChanged) {
      writeDB(rosterDb);
    }
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getFullEvent(eventId);
}

function updateGroupState(groupId, { nominated_scorer, current_round, current_end }) {
  const group = db.prepare(`SELECT * FROM scoring_groups WHERE id = ?`).get(groupId);
  if (!group) throw new Error('Scoring group not found');

  const scorer = nominated_scorer !== undefined ? String(nominated_scorer).trim() : group.nominated_scorer;
  const roundNum = current_round !== undefined ? Math.max(1, parseInt(current_round, 10) || 1) : group.current_round;
  const endNum = current_end !== undefined ? Math.max(1, parseInt(current_end, 10) || 1) : group.current_end;

  db.prepare(`
    UPDATE scoring_groups
    SET nominated_scorer = ?, current_round = ?, current_end = ?
    WHERE id = ?
  `).run(scorer, roundNum, endNum, groupId);

  return getFullEvent(group.event_id);
}

function submitEndScore(eventId, { participant_id, round_number = 1, end_number = 1, arrows = [], scored_by = '' }) {
  const event = db.prepare(`SELECT * FROM scoring_events WHERE id = ?`).get(eventId);
  if (!event) throw new Error('Event not found');

  const lockInfo = computeEventLockStatus(event.date, event.start_time || '18:00');
  if (lockInfo.is_locked) {
    throw new Error(`Scoring is locked! Scores cannot be changed more than 8 hours after the scheduled event start time (${lockInfo.lock_deadline_display}).`);
  }

  const participant = db.prepare(`SELECT * FROM event_participants WHERE id = ? AND event_id = ?`).get(participant_id, eventId);
  if (!participant) throw new Error('Participant not found in this event');

  const roundNum = Math.max(1, Math.min(event.rounds, parseInt(round_number, 10) || 1));
  const endNum = Math.max(1, Math.min(event.ends_per_round, parseInt(end_number, 10) || 1));

  const { sorted, endTotal, xCount, tenCount } = normalizeAndSortArrows(
    arrows,
    event.scoring_type,
    event.arrows_per_end
  );

  const now = new Date().toISOString();
  const scoreId = `scr_${eventId}_${participant_id}_r${roundNum}_e${endNum}`;

  db.prepare(`
    INSERT INTO end_scores (
      id, event_id, participant_id, round_number, end_number, arrows_json, end_total, x_count, ten_count, scored_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, participant_id, round_number, end_number) DO UPDATE SET
      arrows_json = excluded.arrows_json,
      end_total = excluded.end_total,
      x_count = excluded.x_count,
      ten_count = excluded.ten_count,
      scored_by = excluded.scored_by,
      updated_at = excluded.updated_at
  `).run(
    scoreId,
    eventId,
    participant_id,
    roundNum,
    endNum,
    JSON.stringify(sorted),
    endTotal,
    xCount,
    tenCount,
    String(scored_by || '').trim(),
    now
  );

  db.prepare(`UPDATE scoring_events SET updated_at = ? WHERE id = ?`).run(now, eventId);

  return getFullEvent(eventId);
}

function deleteEvent(eventId) {
  db.prepare(`DELETE FROM scoring_events WHERE id = ?`).run(eventId);
  return { success: true };
}

function listKnownParticipants() {
  const rows = db.prepare(`
    SELECT name, bow_category, avatar_id, custom_title
    FROM event_participants
    ORDER BY rowid DESC
  `).all();
  const seen = new Set();
  const result = [];
  for (const r of rows) {
    const k = String(r.name || '').trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      result.push({
        name: String(r.name).trim(),
        bow_category: normalizeBowCategory(r.bow_category || 'BAREBOW'),
        avatar_id: r.avatar_id || null,
        custom_title: r.custom_title || null
      });
    }
  }
  return result;
}

module.exports = {
  SCORING_FORMATS,
  BOW_CATEGORIES,
  normalizeBowCategory,
  computeEventLockStatus,
  normalizeAndSortArrows,
  computeAutoAssignments,
  computeDefaultGroups,
  getPositionDefaults,
  listEvents,
  listKnownParticipants,
  getFullEvent,
  createEvent,
  updateEventSettings,
  saveParticipantsAndGroups,
  updateGroupState,
  submitEndScore,
  deleteEvent
};
