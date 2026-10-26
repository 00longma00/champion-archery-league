/**
 * Archery League Web App Backend
 * Google Apps Script backend for attendance, roster, and live scoring.
 */

const SHEET_NAMES = {
  CONFIG: 'Config',
  ROSTER: 'Roster',
  RSVPS: 'RSVPs',
  EVENTS: 'ScoringEvents',
  PARTICIPANTS: 'EventParticipants',
  END_SCORES: 'EndScores'
};

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sheet.appendRow(headers);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function initDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  getOrCreateSheet(ss, SHEET_NAMES.CONFIG, ['key', 'value']);
  getOrCreateSheet(ss, SHEET_NAMES.ROSTER, ['id', 'name', 'email', 'remindMe', 'avatarId', 'bowCategory', 'customTitle', 'createdAt']);
  getOrCreateSheet(ss, SHEET_NAMES.RSVPS, ['date', 'archerName', 'status', 'note', 'updatedAt']);
  getOrCreateSheet(ss, SHEET_NAMES.EVENTS, ['id', 'name', 'date', 'start_time', 'status', 'max_bales', 'rounds', 'ends_per_round', 'arrows_per_end', 'scoring_type', 'swap_top_bottom', 'created_at', 'updated_at']);
  getOrCreateSheet(ss, SHEET_NAMES.PARTICIPANTS, ['id', 'event_id', 'name', 'bow_category', 'avatar_id', 'custom_title', 'bale_number', 'position', 'shooting_line', 'lane', 'initial_target', 'group_id', 'sort_order']);
  getOrCreateSheet(ss, SHEET_NAMES.END_SCORES, ['id', 'event_id', 'participant_id', 'round_number', 'end_number', 'arrows_json', 'end_total', 'x_count', 'ten_count', 'scored_by', 'updated_at']);
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getRowsAsObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  const results = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = row[j];
    }
    results.push(obj);
  }
  return results;
}

function doGet(e) {
  try {
    initDatabase();
    const params = (e && e.parameter) || {};
    const action = params.action || 'getRoster';
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (action === 'getState' || action === 'state' || action === 'getRoster') {
      const rosterSheet = ss.getSheetByName(SHEET_NAMES.ROSTER);
      const rsvpSheet = ss.getSheetByName(SHEET_NAMES.RSVPS);
      const configSheet = ss.getSheetByName(SHEET_NAMES.CONFIG);

      const archers = getRowsAsObjects(rosterSheet);
      const rsvps = getRowsAsObjects(rsvpSheet);
      const configRows = getRowsAsObjects(configSheet);
      const config = {
        adminPin: '7394',
        leagueTime: '6:00 PM',
        defaultStatus: 'PENDING'
      };
      configRows.forEach(r => { config[r.key] = r.value; });

      // Find latest Sunday from RSVPs or default to upcoming
      let latestSunday = getUpcomingSundayStr();
      const dates = rsvps.map(r => r.date).filter(Boolean).sort().reverse();
      if (dates.length > 0) latestSunday = dates[0];

      const sundayRsvps = rsvps.filter(r => r.date === latestSunday);

      const sundayEvent = {
        date: latestSunday,
        status: config.defaultStatus || 'ON',
        note: '',
        leagueTime: config.leagueTime || '6:00 PM'
      };

      return jsonResponse({
        success: true,
        sundayDate: latestSunday,
        event: sundayEvent,
        config: config,
        archers: archers,
        rsvps: sundayRsvps,
        allRsvps: rsvps
      });
    }

    // 2. GET Scoring Events Hub (used by scoring.html hub view)
    if (action === 'getEvents' || action === 'scoringEvents') {
      const eventsSheet = ss.getSheetByName(SHEET_NAMES.EVENTS);
      const participantsSheet = ss.getSheetByName(SHEET_NAMES.PARTICIPANTS);
      const rosterSheet = ss.getSheetByName(SHEET_NAMES.ROSTER);
      const rsvpSheet = ss.getSheetByName(SHEET_NAMES.RSVPS);

      const events = getRowsAsObjects(eventsSheet);
      const allParticipants = getRowsAsObjects(participantsSheet);
      const archers = getRowsAsObjects(rosterSheet);
      const rsvps = getRowsAsObjects(rsvpSheet);

      events.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

      // Map participant count onto events
      const eventList = events.map(ev => {
        const pList = allParticipants.filter(p => String(p.event_id) === String(ev.id));
        return {
          ...ev,
          participant_count: pList.length,
          group_count: Math.ceil(pList.length / 4) || 1,
          all_scores_filled: true,
          is_locked: ev.status === 'COMPLETED'
        };
      });

      let latestDate = getUpcomingSundayStr();
      const dates = rsvps.map(r => r.date).filter(Boolean).sort().reverse();
      if (dates.length > 0) latestDate = dates[0];
      const latestRsvps = rsvps.filter(r => r.date === latestDate && r.status === 'YES');

      return jsonResponse({
        success: true,
        events: eventList,
        formats: {
          USAA_10: { id: 'USAA_10', label: 'USAA 10-Ring (X, 10..1, M)', validKeys: ['X', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1', 'M'] },
          NFAA_5SPOT: { id: 'NFAA_5SPOT', label: 'NFAA 5-Spot (X=5, 5, 4, M)', validKeys: ['X', '5', '4', 'M'] },
          NFAA_SINGLE: { id: 'NFAA_SINGLE', label: 'NFAA Single-Spot (X=5, 5..1, M)', validKeys: ['X', '5', '4', '3', '2', '1', 'M'] },
          NFAA_BLUEFACE: { id: 'NFAA_BLUEFACE', label: 'NFAA Blueface 300 (X=5, 5..1, M)', validKeys: ['X', '5', '4', '3', '2', '1', 'M'], defaultEnds: 12, defaultArrows: 5 }
        },
        categories: {
          BAREBOW: { id: 'BAREBOW', label: 'Barebow', shortLabel: 'Barebow' },
          OLYMPIC_RECURVE: { id: 'OLYMPIC_RECURVE', label: 'Olympic Recurve', shortLabel: 'Olympic Recurve' },
          TRADITIONAL: { id: 'TRADITIONAL', label: 'Traditional', shortLabel: 'Traditional' },
          COMPOUND: { id: 'COMPOUND', label: 'Compound', shortLabel: 'Compound' }
        },
        rsvpImport: {
          date: latestDate,
          upcomingSunday: latestDate,
          yesArchers: latestRsvps.map(r => ({
            name: r.archerName,
            avatar_id: null,
            bow_category: 'BAREBOW',
            custom_title: null
          })),
          allArchers: archers.map(a => ({
            name: a.name,
            avatar_id: a.avatarId || null,
            bow_category: a.bowCategory || 'BAREBOW',
            custom_title: a.customTitle || null
          }))
        }
      });
    }

    // 3. GET Single Event Data (used when scoring or viewing an event)
    if (action === 'getEventData') {
      const eventId = params.eventId;
      if (!eventId) return jsonResponse({ success: false, error: 'Missing eventId' });

      const eventsSheet = ss.getSheetByName(SHEET_NAMES.EVENTS);
      const participantsSheet = ss.getSheetByName(SHEET_NAMES.PARTICIPANTS);
      const endScoresSheet = ss.getSheetByName(SHEET_NAMES.END_SCORES);

      const events = getRowsAsObjects(eventsSheet);
      const ev = events.find(x => String(x.id) === String(eventId));
      if (!ev) return jsonResponse({ success: false, error: 'Event not found' });

      ev.midpoint_end = Math.floor((ev.ends_per_round || 10) / 2) + 1;
      ev.is_locked = ev.status === 'COMPLETED';

      const allParticipants = getRowsAsObjects(participantsSheet);
      const participants = allParticipants
        .filter(p => String(p.event_id) === String(eventId))
        .sort((a, b) => (Number(a.bale_number) - Number(b.bale_number)) || String(a.position).localeCompare(String(b.position)));

      const allScores = getRowsAsObjects(endScoresSheet);
      const eventScores = allScores
        .filter(s => String(s.event_id) === String(eventId))
        .map(s => {
          let arrows = [];
          try {
            arrows = typeof s.arrows_json === 'string' ? JSON.parse(s.arrows_json || '[]') : (s.arrows_json || []);
          } catch (e) {
            arrows = [];
          }
          return {
            ...s,
            arrows: arrows
          };
        });

      // Construct groups by bales
      const baleSet = new Set();
      participants.forEach(p => { if (p.bale_number) baleSet.add(Number(p.bale_number)); });
      const bales = Array.from(baleSet).sort((a, b) => a - b);

      const groups = [];
      for (let i = 0; i < bales.length; i += 2) {
        const groupBales = bales.slice(i, i + 2);
        groups.push({
          id: 'grp_' + ev.id + '_' + (Math.floor(i / 2) + 1),
          event_id: ev.id,
          name: 'Bales ' + groupBales.join(' & '),
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
          name: 'Main Group',
          bales: [1],
          nominated_scorer: '',
          current_round: 1,
          current_end: 1
        });
      }

      return jsonResponse({
        success: true,
        data: {
          event: ev,
          participants: participants,
          groups: groups,
          scores: eventScores
        }
      });
    }

    return jsonResponse({ success: true, message: 'Archery League API Ready' });
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

function doPost(e) {
  try {
    initDatabase();
    let body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    const action = body.action;
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // 1. Bulk Ingestion Action (Used for initial migration)
    if (action === 'bulkImport') {
      const { roster, rsvps, events, participants, endScores } = body.data || {};

      if (roster && roster.length > 0) {
        const sheet = getOrCreateSheet(ss, SHEET_NAMES.ROSTER);
        sheet.clearContents();
        sheet.appendRow(['id', 'name', 'email', 'remindMe', 'avatarId', 'bowCategory', 'customTitle', 'createdAt']);
        roster.forEach(r => sheet.appendRow([r.id, r.name, r.email || '', r.remindMe ? true : false, r.avatarId || '', r.bowCategory || 'BAREBOW', r.customTitle || '', r.createdAt || '']));
      }

      if (rsvps && rsvps.length > 0) {
        const sheet = getOrCreateSheet(ss, SHEET_NAMES.RSVPS);
        sheet.clearContents();
        sheet.appendRow(['date', 'archerName', 'status', 'note', 'updatedAt']);
        rsvps.forEach(r => sheet.appendRow([r.date, r.archerName, r.status, r.note || '', r.updatedAt || '']));
      }

      if (events && events.length > 0) {
        const sheet = getOrCreateSheet(ss, SHEET_NAMES.EVENTS);
        sheet.clearContents();
        sheet.appendRow(['id', 'name', 'date', 'start_time', 'status', 'max_bales', 'rounds', 'ends_per_round', 'arrows_per_end', 'scoring_type', 'swap_top_bottom', 'created_at', 'updated_at']);
        events.forEach(ev => sheet.appendRow([ev.id, ev.name, ev.date, ev.start_time || '18:00', ev.status || 'COMPLETED', ev.max_bales || 6, ev.rounds || 1, ev.ends_per_round || 10, ev.arrows_per_end || 3, ev.scoring_type || 'USAA_10', ev.swap_top_bottom || 1, ev.created_at || '', ev.updated_at || '']));
      }

      if (participants && participants.length > 0) {
        const sheet = getOrCreateSheet(ss, SHEET_NAMES.PARTICIPANTS);
        sheet.clearContents();
        sheet.appendRow(['id', 'event_id', 'name', 'bow_category', 'avatar_id', 'custom_title', 'bale_number', 'position', 'shooting_line', 'lane', 'initial_target', 'group_id', 'sort_order']);
        // Batch append rows in chunks for high performance
        const rows = participants.map(p => [p.id, p.event_id, p.name, p.bow_category || 'BAREBOW', p.avatar_id || '', p.custom_title || '', p.bale_number || 1, p.position || 'A', p.shooting_line || 'AB', p.lane || 'Left', p.initial_target || 'Top', p.group_id || '', p.sort_order || 0]);
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          sheet.getRange(sheet.getLastRow() + 1, 1, chunk.length, chunk[0].length).setValues(chunk);
        }
      }

      if (endScores && endScores.length > 0) {
        const sheet = getOrCreateSheet(ss, SHEET_NAMES.END_SCORES);
        sheet.clearContents();
        sheet.appendRow(['id', 'event_id', 'participant_id', 'round_number', 'end_number', 'arrows_json', 'end_total', 'x_count', 'ten_count', 'scored_by', 'updated_at']);
        const rows = endScores.map(s => [s.id, s.event_id, s.participant_id, s.round_number || 1, s.end_number || 1, s.arrows_json || '[]', s.end_total || 0, s.x_count || 0, s.ten_count || 0, s.scored_by || '', s.updated_at || '']);
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          sheet.getRange(sheet.getLastRow() + 1, 1, chunk.length, chunk[0].length).setValues(chunk);
        }
      }

      return jsonResponse({ success: true, message: 'Bulk import successful' });
    }

    // 2. RSVP Action
    if (action === 'setRsvp') {
      const { date, archerName, status, note } = body;
      const sheet = ss.getSheetByName(SHEET_NAMES.RSVPS);
      const values = sheet.getDataRange().getValues();
      let foundIndex = -1;
      for (let i = 1; i < values.length; i++) {
        if (values[i][0] === date && String(values[i][1]).toLowerCase() === String(archerName).toLowerCase()) {
          foundIndex = i + 1;
          break;
        }
      }
      const now = new Date().toISOString();
      if (foundIndex > 0) {
        sheet.getRange(foundIndex, 3, 1, 3).setValues([[status, note || '', now]]);
      } else {
        sheet.appendRow([date, archerName, status, note || '', now]);
      }
      return jsonResponse({ success: true });
    }

    // 3. Submit End Score
    if (action === 'submitEndScore') {
      const { eventId, participantId, roundNumber, endNumber, arrows, endTotal, xCount, tenCount, scoredBy } = body;
      const sheet = ss.getSheetByName(SHEET_NAMES.END_SCORES);
      const id = 'es_' + eventId + '_' + participantId + '_' + roundNumber + '_' + endNumber;
      const values = sheet.getDataRange().getValues();
      let foundIndex = -1;
      for (let i = 1; i < values.length; i++) {
        if (values[i][0] === id) {
          foundIndex = i + 1;
          break;
        }
      }
      const now = new Date().toISOString();
      const arrowsJson = JSON.stringify(arrows || []);
      if (foundIndex > 0) {
        sheet.getRange(foundIndex, 6, 1, 6).setValues([[arrowsJson, endTotal || 0, xCount || 0, tenCount || 0, scoredBy || '', now]]);
      } else {
        sheet.appendRow([id, eventId, participantId, roundNumber || 1, endNumber || 1, arrowsJson, endTotal || 0, xCount || 0, tenCount || 0, scoredBy || '', now]);
      }
      return jsonResponse({ success: true });
    }

    // 4. Create Event (from scoring.html modal)
    if (action === 'createEvent') {
      const { event, participants } = body;
      const eventsSheet = ss.getSheetByName(SHEET_NAMES.EVENTS);
      const participantsSheet = ss.getSheetByName(SHEET_NAMES.PARTICIPANTS);
      const now = new Date().toISOString();
      const eventId = event.id || ('evt_' + Date.now());

      eventsSheet.appendRow([
        eventId,
        event.name,
        event.date,
        event.start_time || '18:00',
        event.status || 'SETUP',
        event.max_bales || 6,
        event.rounds || 1,
        event.ends_per_round || 10,
        event.arrows_per_end || 3,
        event.scoring_type || 'USAA_10',
        event.swap_top_bottom ? 1 : 0,
        now,
        now
      ]);

      if (participants && participants.length > 0) {
        const rows = participants.map((p, idx) => [
          p.id || ('p_' + eventId + '_' + idx),
          eventId,
          p.name,
          p.bow_category || 'BAREBOW',
          p.avatar_id || '',
          p.custom_title || '',
          p.bale_number || 1,
          p.position || 'A',
          p.shooting_line || 'AB',
          p.lane || 'Left',
          p.initial_target || 'Top',
          p.group_id || '',
          idx
        ]);
        participantsSheet.getRange(participantsSheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
      }

      return jsonResponse({ success: true, eventId: eventId });
    }

    // 5. Update Status & Time (from index.html admin bar)
    if (action === 'updateAdminStatus') {
      const { status, note, leagueTime, date } = body;
      const rsvpSheet = ss.getSheetByName(SHEET_NAMES.RSVPS);
      const configSheet = ss.getSheetByName(SHEET_NAMES.CONFIG);
      const now = new Date().toISOString();

      if (leagueTime) {
        const cfgVals = configSheet.getDataRange().getValues();
        let ltIdx = -1;
        for (let i = 1; i < cfgVals.length; i++) {
          if (cfgVals[i][0] === 'leagueTime') { ltIdx = i + 1; break; }
        }
        if (ltIdx > 0) configSheet.getRange(ltIdx, 2).setValue(leagueTime);
        else configSheet.appendRow(['leagueTime', leagueTime]);
      }
      return jsonResponse({ success: true });
    }

    return jsonResponse({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}
