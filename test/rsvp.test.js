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
