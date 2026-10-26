const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { readDB, writeDB, getUpcomingSunday } = require('./db');
const { sendSaturdayReminders } = require('./notifier');
const scoringDB = require('./scoring-db');

// Load environment variables if .env exists
if (fs.existsSync(path.join(__dirname, '.env'))) {
  const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2] || '';
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      process.env[key] = value.trim();
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json());
// Serve clean landing page with direct links (manual click so archers bookmark new URL)
app.get(['/', '/index.html', '/scoring.html', '/scoring'], (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Archery League Has Moved</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap');
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4">
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 text-center space-y-6 shadow-2xl">
    <div class="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center mx-auto text-2xl shadow-lg shadow-amber-500/10">
      <i class="fa-solid fa-bullseye"></i>
    </div>
    
    <div class="space-y-2">
      <span class="text-[11px] font-bold uppercase tracking-wider text-amber-400 bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">
        Website Moved to Cloud
      </span>
      <h1 class="text-xl sm:text-2xl font-black text-white">Archery League Night</h1>
      <p class="text-xs text-slate-400 leading-relaxed">
        Our attendance tracker and tournament scoring app has permanently migrated to GitHub Pages &amp; Firebase.
      </p>
      <div class="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl text-[11px] text-amber-200 text-left flex items-start gap-2.5 mt-2">
        <i class="fa-solid fa-bookmark text-amber-400 mt-0.5 shrink-0"></i>
        <span><strong>Please update your bookmarks:</strong> This local server will be decommissioned soon. Please bookmark the new link below!</span>
      </div>
    </div>

    <div class="pt-2 space-y-2.5">
      <a href="https://00longma00.github.io/champion-archery-league/"
        class="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black py-3 px-4 rounded-xl text-xs shadow-lg shadow-amber-500/20 transition flex items-center justify-center gap-2">
        <i class="fa-solid fa-calendar-check"></i>
        <span>RSVP &amp; Attendance Tracker</span>
        <i class="fa-solid fa-arrow-right ml-1 text-[10px]"></i>
      </a>

      <a href="https://00longma00.github.io/champion-archery-league/scoring.html"
        class="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold py-2.5 px-4 rounded-xl text-xs border border-slate-700 transition flex items-center justify-center gap-2">
        <i class="fa-solid fa-calculator text-amber-400"></i>
        <span>Live Tournament Scoring &amp; Leaderboards</span>
      </a>
    </div>

    <div class="pt-2 border-t border-slate-800/80 text-[11px] text-slate-500 font-mono">
      https://00longma00.github.io/champion-archery-league/
    </div>
  </div>
</body>
</html>`);
});

app.use(express.static(path.join(__dirname, 'public')));

// Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// GET /api/state - Return current upcoming Sunday info, RSVP roster, and current archers
app.get('/api/state', (req, res) => {
  const db = readDB();
  const nextSunday = getUpcomingSunday();
  
  if (!db.events[nextSunday]) {
    db.events[nextSunday] = {
      date: nextSunday,
      status: 'PENDING',
      note: ''
    };
    writeDB(db);
  }

  const currentEvent = db.events[nextSunday];
  const rsvps = db.rsvps[nextSunday] || [];
  
  // Public archers list: expose names, hide emails for security/privacy
  const archers = (db.archers || []).map(a => ({
    name: a.name,
    avatarId: a.avatarId || null,
    bowCategory: scoringDB.normalizeBowCategory(a.bowCategory || 'BAREBOW'),
    customTitle: a.customTitle || null,
    hasEmail: !!a.email,
    remindMe: !!a.remindMe
  }));

  res.json({
    upcomingSunday: nextSunday,
    event: currentEvent,
    config: {
      leagueTime: db.config.leagueTime || '7:00 PM'
    },
    rsvps: rsvps,
    archers: archers
  });
});

// POST /api/rsvp - Submit or update RSVP
app.post('/api/rsvp', (req, res) => {
  const { name, status, note, email, remindMe, avatarId, customTitle, bowCategory } = req.body;
  if (!name || !status) {
    return res.status(400).json({ error: 'Name and status (YES or NO) are required.' });
  }

  const cleanName = String(name).trim();
  const upperStatus = String(status).toUpperCase();
  if (!['YES', 'NO'].includes(upperStatus)) {
    return res.status(400).json({ error: 'Status must be YES or NO.' });
  }
  const validStatus = upperStatus;
  const cleanNote = note ? String(note).trim().slice(0, 150) : '';
  const cleanAvatarId = avatarId ? String(avatarId).trim().slice(0, 40) : undefined;
  const cleanCustomTitle = customTitle !== undefined ? String(customTitle).trim().slice(0, 45) : undefined;
  const cleanBowCategory = bowCategory ? scoringDB.normalizeBowCategory(bowCategory) : undefined;

  const db = readDB();
  const nextSunday = getUpcomingSunday();
  const MAX_ARCHERS = 50;

  // Check archer roster or enforce maximum limit
  let archer = (db.archers || []).find(a => a.name.toLowerCase() === cleanName.toLowerCase());
  if (!archer) {
    if ((db.archers || []).length >= MAX_ARCHERS) {
      return res.status(400).json({ error: `League roster is full (maximum ${MAX_ARCHERS} archers allowed).` });
    }
    archer = {
      id: Date.now().toString(),
      name: cleanName,
      avatarId: cleanAvatarId || null,
      bowCategory: cleanBowCategory || 'BAREBOW',
      customTitle: cleanCustomTitle || null,
      email: email ? String(email).trim().toLowerCase() : '',
      remindMe: remindMe !== false,
      createdAt: new Date().toISOString()
    };
    if (!db.archers) db.archers = [];
    db.archers.push(archer);
  } else {
    if (email !== undefined && String(email).trim() !== '') {
      archer.email = String(email).trim().toLowerCase();
    }
    if (remindMe !== undefined) archer.remindMe = !!remindMe;
    if (cleanAvatarId) archer.avatarId = cleanAvatarId;
    if (cleanBowCategory) archer.bowCategory = cleanBowCategory;
    else if (!archer.bowCategory) archer.bowCategory = 'BAREBOW';
    if (cleanCustomTitle !== undefined) {
      archer.customTitle = cleanCustomTitle || null;
    }
  }

  if (!db.rsvps[nextSunday]) {
    db.rsvps[nextSunday] = [];
  }

  // Update existing RSVP or push new
  const existingIndex = db.rsvps[nextSunday].findIndex(r => r.archerName.toLowerCase() === cleanName.toLowerCase());
  const rsvpObj = {
    archerName: cleanName,
    avatarId: archer.avatarId || null,
    bowCategory: archer.bowCategory || 'BAREBOW',
    customTitle: archer.customTitle || null,
    status: validStatus,
    note: cleanNote,
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    db.rsvps[nextSunday][existingIndex] = rsvpObj;
  } else {
    db.rsvps[nextSunday].push(rsvpObj);
  }

  // Keep avatar, bowCategory, and custom title consistent across all RSVP records for this archer
  Object.keys(db.rsvps).forEach(dateKey => {
    (db.rsvps[dateKey] || []).forEach(r => {
      if (r.archerName && r.archerName.toLowerCase() === cleanName.toLowerCase()) {
        r.avatarId = archer.avatarId || null;
        r.bowCategory = archer.bowCategory || 'BAREBOW';
        r.customTitle = archer.customTitle || null;
      }
    });
  });

  writeDB(db);

  res.json({
    success: true,
    rsvp: rsvpObj,
    archer: {
      name: archer.name,
      avatarId: archer.avatarId || null,
      bowCategory: archer.bowCategory || 'BAREBOW',
      customTitle: archer.customTitle || null,
      hasEmail: !!archer.email,
      remindMe: !!archer.remindMe
    }
  });
});

// POST /api/admin/status - Update status (ON, OFF, PENDING) and league time (open to all)
app.post('/api/admin/status', (req, res) => {
  const { status, note, leagueTime } = req.body;
  const db = readDB();

  const nextSunday = getUpcomingSunday();
  if (status !== undefined && status !== null && status !== '') {
    if (!['ON', 'OFF', 'PENDING'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be ON, OFF, or PENDING.' });
    }
  }

  if (leagueTime !== undefined && String(leagueTime).trim()) {
    db.config.leagueTime = String(leagueTime).trim();
  }

  if (!db.events[nextSunday]) {
    db.events[nextSunday] = { date: nextSunday };
  }

  if (status) {
    db.events[nextSunday].status = status;
  }
  if (note !== undefined) {
    db.events[nextSunday].note = String(note).trim().slice(0, 200);
  }
  db.events[nextSunday].updatedAt = new Date().toISOString();

  writeDB(db);

  res.json({ success: true, event: db.events[nextSunday], config: db.config });
});

// POST /api/admin/test-remind - Manually test Saturday reminders (open)
app.post('/api/admin/test-remind', async (req, res) => {
  try {
    const result = await sendSaturdayReminders();
    res.json({ success: true, message: `Dispatched reminders to ${result.count} archers.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Saturday Cron Schedule: Runs every Saturday at 10:00 AM local time
cron.schedule('0 10 * * 6', () => {
  console.log('[Cron] Running scheduled Saturday 10:00 AM attendance reminder check...');
  sendSaturdayReminders().catch(err => console.error('[Cron] Error in reminder job:', err));
});

// ============================================================================
// ARCHERY LEAGUE SCORING API ROUTES (/api/scoring/*)
// ============================================================================

    // GET /api/scoring/events - List all scoring events + current RSVP roster for quick import
app.get('/api/scoring/events', (req, res) => {
  try {
    const events = scoringDB.listEvents();
    const db = readDB();
    const nextSunday = getUpcomingSunday();
    const dates = Object.keys(db.rsvps || {}).sort().reverse();
    const latestRsvpDate = db.rsvps[nextSunday] && db.rsvps[nextSunday].length > 0
      ? nextSunday
      : (dates[0] || nextSunday);

    const archerByName = {};
    (db.archers || []).forEach(a => {
      archerByName[a.name.toLowerCase()] = a;
    });

    const yesRsvps = ((db.rsvps && db.rsvps[latestRsvpDate]) || [])
      .filter(r => r.status === 'YES')
      .map(r => {
        const known = archerByName[(r.archerName || '').toLowerCase()];
        return {
          name: r.archerName,
          avatar_id: r.avatarId || (known && known.avatarId) || null,
          bow_category: scoringDB.normalizeBowCategory(r.bowCategory || (known && known.bowCategory) || 'BAREBOW'),
          custom_title: r.customTitle || (known && known.customTitle) || null
        };
      });

    const allArchersMap = new Map();
    (db.archers || []).forEach(a => {
      const k = (a.name || '').trim().toLowerCase();
      if (k) {
        allArchersMap.set(k, {
          name: a.name,
          avatar_id: a.avatarId || null,
          bow_category: scoringDB.normalizeBowCategory(a.bowCategory || 'BAREBOW'),
          custom_title: a.customTitle || null
        });
      }
    });

    if (typeof scoringDB.listKnownParticipants === 'function') {
      scoringDB.listKnownParticipants().forEach(hp => {
        const k = (hp.name || '').trim().toLowerCase();
        if (k && !allArchersMap.has(k)) {
          allArchersMap.set(k, {
            name: hp.name,
            avatar_id: hp.avatar_id || null,
            bow_category: scoringDB.normalizeBowCategory(hp.bow_category || 'BAREBOW'),
            custom_title: hp.custom_title || null
          });
        }
      });
    }

    const allArchers = Array.from(allArchersMap.values());

    res.json({
      events,
      formats: scoringDB.SCORING_FORMATS,
      categories: scoringDB.BOW_CATEGORIES,
      rsvpImport: {
        date: latestRsvpDate,
        upcomingSunday: nextSunday,
        yesArchers: yesRsvps,
        allArchers
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scoring/events - Create a new League Scoring Event
app.post('/api/scoring/events', (req, res) => {
  try {
    const fullEvent = scoringDB.createEvent(req.body || {});
    res.json({ success: true, data: fullEvent });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/scoring/events/:id - Get full state of a scoring event
app.get('/api/scoring/events/:id', (req, res) => {
  try {
    const fullEvent = scoringDB.getFullEvent(req.params.id);
    if (!fullEvent) return res.status(404).json({ error: 'Scoring event not found.' });
    res.json({ success: true, data: fullEvent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/scoring/events/:id - Update event format/status settings
app.patch('/api/scoring/events/:id', (req, res) => {
  try {
    const fullEvent = scoringDB.updateEventSettings(req.params.id, req.body || {});
    res.json({ success: true, data: fullEvent });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/scoring/events/:id - Delete a scoring event
app.delete('/api/scoring/events/:id', (req, res) => {
  try {
    scoringDB.deleteEvent(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/scoring/events/:id/assign - Save participants, bales, positions, and scoring groups
app.post('/api/scoring/events/:id/assign', (req, res) => {
  try {
    const fullEvent = scoringDB.saveParticipantsAndGroups(req.params.id, req.body || {});
    res.json({ success: true, data: fullEvent });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/scoring/groups/:groupId/state - Nominate scorer or update group's active round/end
app.post('/api/scoring/groups/:groupId/state', (req, res) => {
  try {
    const fullEvent = scoringDB.updateGroupState(req.params.groupId, req.body || {});
    res.json({ success: true, data: fullEvent });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/scoring/events/:id/score - Submit or update an archer's end score
app.post('/api/scoring/events/:id/score', (req, res) => {
  try {
    const fullEvent = scoringDB.submitEndScore(req.params.id, req.body || {});
    res.json({ success: true, data: fullEvent });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Serve the League Scoring App on /league and /scoring
app.get(['/league', '/league/*', '/scoring', '/scoring/*'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scoring.html'));
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Bind strictly to 127.0.0.1 for local isolation & secure tunneling
app.listen(PORT, '127.0.0.1', () => {
  console.log(`🎯 Archery League Attendance Server running on http://127.0.0.1:${PORT}`);
});
