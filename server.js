const express = require('express');
const path = require('path');
const fs = require('fs');
const { readDB, writeDB, getUpcomingSunday } = require('./db');
const scoringDB = require('./scoring-db');
const { generateArcheryInsights } = require('./ai-insights');
const { generateAIAvatar, generateProceduralAvatar } = require('./ai-avatar');

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
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Security Headers (compatible with iframe embedding)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
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
  
  // Set league status to pending after previous session completed if nobody has checked in (RSVP YES)
  const yesCount = rsvps.filter(r => r.status === 'YES').length;
  if (yesCount === 0 && currentEvent.status !== 'PENDING') {
    currentEvent.status = 'PENDING';
    writeDB(db);
  }
  
  const customAvatars = db.customAvatars || {};

  // Public archers list
  const archers = (db.archers || []).map(a => {
    const isCustom = a.avatarId && (a.avatarId.startsWith('ai_') || a.avatarId.startsWith('custom_'));
    const custom = (isCustom || !a.avatarId) ? (a.customAvatar || customAvatars[a.name.toLowerCase()] || null) : null;
    return {
      name: a.name,
      avatarId: a.avatarId || (custom ? custom.id : null),
      customAvatar: custom,
      bowCategory: scoringDB.normalizeBowCategory(a.bowCategory || 'BAREBOW')
    };
  });

  res.json({
    upcomingSunday: nextSunday,
    event: currentEvent,
    config: {
      leagueTime: db.config.leagueTime || '7:00 PM'
    },
    rsvps: rsvps,
    archers: archers,
    customAvatars: customAvatars
  });
});

// POST /api/rsvp - Submit or update RSVP
app.post('/api/rsvp', (req, res) => {
  const { name, status, note, avatarId, bowCategory, customAvatar } = req.body;
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
  let cleanAvatarId = avatarId ? String(avatarId).trim().slice(0, 80) : undefined;
  const cleanBowCategory = bowCategory ? scoringDB.normalizeBowCategory(bowCategory) : undefined;

  const db = readDB();
  if (!db.customAvatars) db.customAvatars = {};

  const isCustomId = cleanAvatarId && (cleanAvatarId.startsWith('ai_') || cleanAvatarId.startsWith('custom_'));
  let finalCustom = (isCustomId || (!cleanAvatarId && customAvatar)) && customAvatar && typeof customAvatar === 'object' && customAvatar.svg
    ? customAvatar
    : null;

  if (finalCustom) {
    db.customAvatars[cleanName.toLowerCase()] = finalCustom;
    cleanAvatarId = finalCustom.id || `custom_${cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  } else {
    delete db.customAvatars[cleanName.toLowerCase()];
  }

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
      customAvatar: finalCustom,
      bowCategory: cleanBowCategory || 'BAREBOW',
      createdAt: new Date().toISOString()
    };
    if (!db.archers) db.archers = [];
    db.archers.push(archer);
  } else {
    if (cleanAvatarId !== undefined) archer.avatarId = cleanAvatarId;
    archer.customAvatar = finalCustom;
    if (cleanBowCategory) archer.bowCategory = cleanBowCategory;
    else if (!archer.bowCategory) archer.bowCategory = 'BAREBOW';
  }

  if (!db.rsvps[nextSunday]) {
    db.rsvps[nextSunday] = [];
  }

  // Update existing RSVP or push new
  const existingIndex = db.rsvps[nextSunday].findIndex(r => r.archerName.toLowerCase() === cleanName.toLowerCase());
  if (existingIndex < 0 && db.rsvps[nextSunday].length >= MAX_ARCHERS) {
    return res.status(400).json({ error: `Maximum RSVP limit reached (${MAX_ARCHERS} RSVPs allowed per session).` });
  }
  const rsvpObj = {
    archerName: cleanName,
    avatarId: archer.avatarId || null,
    customAvatar: archer.customAvatar || null,
    bowCategory: archer.bowCategory || 'BAREBOW',
    status: validStatus,
    note: cleanNote,
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    db.rsvps[nextSunday][existingIndex] = rsvpObj;
  } else {
    db.rsvps[nextSunday].push(rsvpObj);
  }

  // Keep avatar and bowCategory consistent across all RSVP records for this archer
  Object.keys(db.rsvps).forEach(dateKey => {
    (db.rsvps[dateKey] || []).forEach(r => {
      if (r.archerName && r.archerName.toLowerCase() === cleanName.toLowerCase()) {
        r.avatarId = archer.avatarId || null;
        r.customAvatar = archer.customAvatar || null;
        r.bowCategory = archer.bowCategory || 'BAREBOW';
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
      customAvatar: archer.customAvatar || null,
      bowCategory: archer.bowCategory || 'BAREBOW'
    }
  });
});

// POST /api/avatar/generate - Generate AI Mascot Avatar via Gemini Free Tier
app.post('/api/avatar/generate', async (req, res) => {
  try {
    const { prompt, name } = req.body || {};
    const result = await generateAIAvatar({ prompt, name });
    res.json(result);
  } catch (_err) {
    const fallbackAvatar = generateProceduralAvatar(req.body?.prompt, req.body?.name || 'Archer');
    res.json({ success: true, source: 'procedural-fallback', model: 'procedural-engine', avatar: fallbackAvatar });
  }
});

// POST /api/avatar/save - Persist custom avatar for an archer by name
app.post('/api/avatar/save', (req, res) => {
  try {
    const { name, avatar } = req.body || {};
    if (!name || !avatar || !avatar.svg) {
      return res.status(400).json({ error: 'Name and avatar object with SVG are required' });
    }
    const cleanName = String(name).trim();
    const db = readDB();
    if (!db.customAvatars) db.customAvatars = {};
    db.customAvatars[cleanName.toLowerCase()] = avatar;

    let archer = (db.archers || []).find(a => a.name.toLowerCase() === cleanName.toLowerCase());
    if (archer) {
      archer.customAvatar = avatar;
      archer.avatarId = avatar.id;
    }
    writeDB(db);
    res.json({ success: true, avatar });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/avatar/:name - Fetch stored avatar for an archer
app.get('/api/avatar/:name', (req, res) => {
  try {
    const cleanName = String(req.params.name).trim().toLowerCase();
    const db = readDB();
    const customAvatars = db.customAvatars || {};
    const archer = (db.archers || []).find(a => a.name.toLowerCase() === cleanName);
    const avatar = (archer && archer.customAvatar) || customAvatars[cleanName] || null;
    if (!avatar) return res.status(404).json({ error: 'No custom avatar found for this archer' });
    res.json({ success: true, avatar });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    const customAvatars = db.customAvatars || {};

    const yesRsvps = ((db.rsvps && db.rsvps[latestRsvpDate]) || [])
      .filter(r => r.status === 'YES')
      .map(r => {
        const k = (r.archerName || '').trim().toLowerCase();
        const known = archerByName[k];
        const custom = r.customAvatar || (known && known.customAvatar) || customAvatars[k] || null;
        return {
          name: r.archerName,
          avatar_id: r.avatarId || (known && known.avatarId) || (custom ? custom.id : null),
          custom_avatar: custom,
          bow_category: scoringDB.normalizeBowCategory(r.bowCategory || (known && known.bowCategory) || 'BAREBOW')
        };
      });

    const allArchersMap = new Map();
    (db.archers || []).forEach(a => {
      const k = (a.name || '').trim().toLowerCase();
      if (k) {
        const custom = a.customAvatar || customAvatars[k] || null;
        allArchersMap.set(k, {
          name: a.name,
          avatar_id: a.avatarId || (custom ? custom.id : null),
          custom_avatar: custom,
          bow_category: scoringDB.normalizeBowCategory(a.bowCategory || 'BAREBOW')
        });
      }
    });

    if (typeof scoringDB.listKnownParticipants === 'function') {
      scoringDB.listKnownParticipants().forEach(hp => {
        const k = (hp.name || '').trim().toLowerCase();
        if (k && !allArchersMap.has(k)) {
          const custom = customAvatars[k] || null;
          allArchersMap.set(k, {
            name: hp.name,
            avatar_id: hp.avatar_id || (custom ? custom.id : null),
            custom_avatar: custom,
            bow_category: scoringDB.normalizeBowCategory(hp.bow_category || 'BAREBOW')
          });
        }
      });
    }

    const allArchers = Array.from(allArchersMap.values());

    res.json({
      events,
      formats: scoringDB.SCORING_FORMATS,
      categories: scoringDB.BOW_CATEGORIES,
      customAvatars,
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

// POST /api/scoring/ai-insights - AI-powered archery insights based on 14-day vs 3-month performance
app.post('/api/scoring/ai-insights', async (req, res) => {
  try {
    const result = await generateArcheryInsights(req.body || {});
    res.json(result);
  } catch (_err) {
    res.json({
      success: true,
      source: 'analytics-fallback',
      model: 'archery-analytics-engine',
      insights: {
        headline: 'Archery analytics engine ready. Log practice and league ends to reveal training trajectories.',
        formTrajectory: 'Solidifying Baseline',
        trajectoryColor: 'sky',
        comparison14dVs3m: {
          scoringDelta: 'Consistent baseline metrics established across recent sessions.',
          volumeAndRhythm: 'Active participation maintained across league calendar.',
          groupingAndSpread: 'Grouping consistency tracking active.'
        },
        environmentBreakdown: {
          practiceVsLeague: 'Balanced session focus between training ends and competition rounds.'
        },
        keyStrengths: [
          'Consistent stance and shoulder alignment.',
          'Committed session logging for progressive analysis.'
        ],
        actionableFocusAreas: [
          {
            title: 'Blank-Bale Expansion Rhythm',
            description: 'Execute continuous back expansion through shot completion.',
            targetMetric: 'Focus 15 arrows per practice on smooth follow-through.'
          }
        ],
        coachQuote: 'The arrow does not lie: trust your process and execute smoothly.'
      }
    });
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

// Bind to 0.0.0.0 for container hosting
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎯 Archery League Attendance Server running on http://0.0.0.0:${PORT}`);
});
