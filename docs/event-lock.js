// Post-event scoring lock, shared by the Firebase adapter (browser ES module).
// Mirrors computeEventLockStatus in scoring-db.js: scoring closes 8 hours after
// the scheduled start (date + start_time, interpreted in the viewer's local time).

export const LOCK_WINDOW_MS = 8 * 60 * 60 * 1000;

export function computeEventLockStatus(dateStr, startTimeStr = '18:00', now = new Date()) {
  const parts = String(dateStr || '').split('-').map(Number);
  const year = parts[0] || now.getFullYear();
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
  const lockDeadline = new Date(scheduledStart.getTime() + LOCK_WINDOW_MS);
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

// Lock fields for a league scoring event: locked once the 8-hour window has
// passed, or as soon as an admin marks it COMPLETED.
export function leagueEventLockFields(ev, now = new Date()) {
  const info = computeEventLockStatus(ev && ev.date, (ev && ev.start_time) || '18:00', now);
  return {
    ...info,
    is_locked: Boolean(info.is_locked || (ev && ev.status === 'COMPLETED'))
  };
}
