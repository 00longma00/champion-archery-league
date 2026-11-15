import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { computeEventLockStatus, leagueEventLockFields } from '../event-lock.js';

const require = createRequire(import.meta.url);
const scoringDB = require('../scoring-db.js');

test('league event is unlocked within 8 hours of its scheduled start', () => {
  const now = new Date(2026, 10, 8, 23, 0); // Nov 8 2026, 11:00 PM local
  const fields = leagueEventLockFields({ date: '2026-11-08', start_time: '18:00', status: 'ON' }, now);
  assert.equal(fields.is_locked, false);
  assert.equal(fields.ms_remaining, 3 * 60 * 60 * 1000);
});

test('league event locks automatically once 8 hours have passed (status still open)', () => {
  const now = new Date(2026, 10, 14, 12, 0); // a week later
  const fields = leagueEventLockFields({ date: '2026-11-08', start_time: '6:00 PM', status: 'ON' }, now);
  assert.equal(fields.is_locked, true);
  assert.equal(fields.ms_remaining, 0);
  assert.ok(fields.lock_deadline_display, 'banner needs a deadline to display');
  assert.equal(new Date(fields.lock_deadline_iso).getTime(), new Date(2026, 10, 9, 2, 0).getTime());
});

test('COMPLETED status locks immediately, even before the deadline', () => {
  const now = new Date(2026, 10, 8, 19, 0);
  assert.equal(leagueEventLockFields({ date: '2026-11-08', start_time: '18:00', status: 'COMPLETED' }, now).is_locked, true);
});

test('missing start_time defaults to 18:00', () => {
  const now = new Date(2026, 10, 9, 1, 59);
  assert.equal(leagueEventLockFields({ date: '2026-11-08' }, now).is_locked, false);
  assert.equal(leagueEventLockFields({ date: '2026-11-08' }, new Date(2026, 10, 9, 2, 1)).is_locked, true);
});

test('browser lock helper agrees with the server implementation', () => {
  for (const [date, time] of [['2020-01-01', '18:00'], ['2099-12-31', '7:30 PM'], ['2026-11-08', '12 AM']]) {
    const a = computeEventLockStatus(date, time);
    const b = scoringDB.computeEventLockStatus(date, time);
    assert.equal(a.is_locked, b.is_locked);
    assert.equal(a.lock_deadline_iso, b.lock_deadline_iso);
  }
});

test('private session stays open for 48 hours after creation, then locks', async () => {
  const { privateLockAt, privateEventLockFields } = await import('../event-lock.js');
  const created = new Date(2026, 10, 8, 10, 0);
  const ev = { date: '2026-10-01', lock_at: privateLockAt(created) }; // logging an old practice is fine
  assert.equal(privateEventLockFields(ev, new Date(2026, 10, 10, 9, 59)).is_locked, false);
  assert.equal(privateEventLockFields(ev, new Date(2026, 10, 10, 10, 0)).is_locked, true);
  // Firestore Timestamp shape
  assert.equal(privateEventLockFields({ lock_at: { toDate: () => ev.lock_at } }, created).is_locked, false);
});

test('private session without lock_at counts as locked (matches the rules)', async () => {
  const { privateEventLockFields } = await import('../event-lock.js');
  assert.equal(privateEventLockFields({ date: '2026-11-08' }).is_locked, true);
});
