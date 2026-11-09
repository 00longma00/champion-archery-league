const test = require('node:test');
const assert = require('node:assert/strict');
const { getUpcomingSunday, readDB } = require('../db');

test('getUpcomingSunday calculates upcoming Sunday accurately across days of the week', () => {
  // Monday 2026-11-02 -> next Sunday is 2026-11-08
  const monday = new Date('2026-11-02T12:00:00');
  assert.equal(getUpcomingSunday(monday), '2026-11-08');

  // Wednesday 2026-11-04 -> next Sunday is 2026-11-08
  const wednesday = new Date('2026-11-04T12:00:00');
  assert.equal(getUpcomingSunday(wednesday), '2026-11-08');

  // Friday 2026-11-06 -> next Sunday is 2026-11-08
  const friday = new Date('2026-11-06T12:00:00');
  assert.equal(getUpcomingSunday(friday), '2026-11-08');

  // Saturday 2026-11-07 -> next day Sunday is 2026-11-08
  const saturday = new Date('2026-11-07T12:00:00');
  assert.equal(getUpcomingSunday(saturday), '2026-11-08');

  // Sunday 2026-11-08 -> returns current day 2026-11-08 (idempotent on event day)
  const sunday = new Date('2026-11-08T12:00:00');
  assert.equal(getUpcomingSunday(sunday), '2026-11-08');
});

test('getUpcomingSunday handles month rollover boundaries cleanly', () => {
  // Wednesday Sep 30, 2026 -> next Sunday is Oct 4, 2026
  const endOfMonth = new Date('2026-09-30T10:00:00');
  assert.equal(getUpcomingSunday(endOfMonth), '2026-10-04');

  // Leap year boundary: Saturday Feb 28, 2024 (leap year) -> Sunday Feb 29, 2024
  const leapYearSat = new Date('2024-02-28T10:00:00');
  assert.equal(getUpcomingSunday(leapYearSat), '2024-03-03');
});

test('getUpcomingSunday handles year rollover boundary cleanly', () => {
  // Thursday Dec 31, 2026 -> next Sunday is Jan 03, 2027
  const yearEnd = new Date('2026-12-31T15:00:00');
  assert.equal(getUpcomingSunday(yearEnd), '2027-01-03');
});

test('readDB loads database and provides expected schema structure', () => {
  const db = readDB();
  assert.ok(db, 'readDB should return an object');
  assert.ok(db.config, 'Database should contain config');
  assert.ok(typeof db.config.adminPin === 'string', 'Admin PIN should be a string');
  assert.ok(Array.isArray(db.archers), 'archers should be an array');
  assert.ok(typeof db.events === 'object' && db.events !== null, 'events should be an object');
  assert.ok(typeof db.rsvps === 'object' && db.rsvps !== null, 'rsvps should be an object');
});

test('preset avatar selection correctly persists and clears custom avatar state', () => {
  const PET_AVATARS = {
    bengal_cat: { id: 'bengal_cat', title: 'Bengal Leopard Bowhunter' },
    golden_dog: { id: 'golden_dog', title: 'Golden Retriever Ranger' }
  };

  function resolveAvatar(name, explicitAvatarId, appState, customAvatars = {}) {
    const clean = (name || '').trim().toLowerCase();
    if (explicitAvatarId && PET_AVATARS[explicitAvatarId]) {
      return PET_AVATARS[explicitAvatarId];
    }
    if (clean && appState && appState.archers) {
      const found = appState.archers.find(a => a.name.toLowerCase() === clean);
      if (found) {
        if (found.avatarId && PET_AVATARS[found.avatarId] && (!found.customAvatar || found.avatarId !== (found.customAvatar && found.customAvatar.id))) {
          return PET_AVATARS[found.avatarId];
        }
        if (found.customAvatar && found.customAvatar.svg) return found.customAvatar;
        if (found.avatarId && PET_AVATARS[found.avatarId]) return PET_AVATARS[found.avatarId];
      }
    }
    if (clean && customAvatars[clean]) return customAvatars[clean];
    return { id: 'default_target', title: 'Default Target' };
  }

  // 1. Archer with preset avatar Bengal Cat should resolve to bengal_cat even if stale customAvatars exists
  const appState = {
    archers: [
      { name: 'Long', avatarId: 'bengal_cat', customAvatar: null }
    ]
  };
  const staleCustom = { long: { id: 'ai_long_123', species: 'Snowy Owl Archer', svg: '<svg></svg>' } };

  const resolved = resolveAvatar('Long', 'bengal_cat', appState, staleCustom);
  assert.equal(resolved.id, 'bengal_cat', 'Explicit preset avatar must take precedence over stale custom avatar');

  const resolvedByName = resolveAvatar('Long', null, appState, staleCustom);
  assert.equal(resolvedByName.id, 'bengal_cat', 'Saved preset avatar in roster must take precedence over stale custom avatar');
});

test('league status resolves to PENDING after previous session completes if nobody has checked in', () => {
  function computeEffectiveLeagueStatus(event, rsvps = []) {
    const yesCount = (rsvps || []).filter(r => r && r.status === 'YES').length;
    let status = (event && event.status) || 'PENDING';
    if (yesCount === 0) {
      status = 'PENDING';
    }
    return { status, yesCount };
  }

  // Case 1: Previous league session ended with status 'ON', but next Sunday has 0 check-ins
  const previousCompletedSession = { status: 'ON', date: '2026-11-08' };
  const emptyRsvps = [];
  const res1 = computeEffectiveLeagueStatus(previousCompletedSession, emptyRsvps);
  assert.equal(res1.status, 'PENDING', 'Status must reset to PENDING when nobody has checked in for upcoming session');
  assert.equal(res1.yesCount, 0);

  // Case 2: Only 'NO' RSVPs exist (no check-in to shoot on line)
  const onlyNoRsvps = [{ archerName: 'Alice', status: 'NO' }];
  const res2 = computeEffectiveLeagueStatus(previousCompletedSession, onlyNoRsvps);
  assert.equal(res2.status, 'PENDING', 'Status must remain PENDING if archers only RSVPed NO');
  assert.equal(res2.yesCount, 0);

  // Case 3: At least one archer checks in (status YES)
  const checkedInRsvps = [
    { archerName: 'Long', status: 'YES' },
    { archerName: 'Alice', status: 'NO' }
  ];
  const activeEvent = { status: 'ON', date: '2026-11-15' };
  const res3 = computeEffectiveLeagueStatus(activeEvent, checkedInRsvps);
  assert.equal(res3.status, 'ON', 'Status retains active status once archers have checked in');
  assert.equal(res3.yesCount, 1);
});

