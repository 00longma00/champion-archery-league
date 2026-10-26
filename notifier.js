const nodemailer = require('nodemailer');
const { readDB, getUpcomingSunday } = require('./db');

function createTransporter() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    console.warn('[Notifier] SMTP_USER or SMTP_PASS not set. Email dispatch disabled.');
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: user,
      pass: pass
    }
  });
}

async function sendSaturdayReminders() {
  const db = readDB();
  const transporter = createTransporter();
  const nextSunday = getUpcomingSunday();
  const event = db.events[nextSunday] || { status: 'PENDING' };
  const currentRsvps = db.rsvps[nextSunday] || [];
  const respondedNames = new Set(currentRsvps.map(r => r.archerName.toLowerCase()));

  // Filter archers who want reminders and haven't responded yet
  const targets = (db.archers || []).filter(a => {
    return a.email && a.remindMe !== false && !respondedNames.has(a.name.toLowerCase());
  });

  if (targets.length === 0) {
    console.log('[Notifier] No archers need a reminder for', nextSunday);
    return { count: 0 };
  }

  const publicUrl = process.env.PUBLIC_URL || 'http://localhost:3456';
  const statusLabel = event.status === 'ON' ? '✅ League is ON' : (event.status === 'OFF' ? '❌ League is OFF' : '⏳ Status: PENDING');

  console.log(`[Notifier] Sending reminders to ${targets.length} archers for ${nextSunday}...`);

  for (const archer of targets) {
    const mailOptions = {
      from: process.env.SMTP_FROM || `"Archery League Tracker" <${process.env.SMTP_USER}>`,
      to: archer.email,
      subject: `🎯 Sunday Archery League RSVP (${nextSunday})`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #0f172a; margin-top: 0;">🎯 Archery League Attendance Check</h2>
          <p>Hi <strong>${archer.name}</strong>,</p>
          <p>League is coming up this <strong>Sunday (${nextSunday})</strong> at <strong>${db.config.leagueTime || '7:00 PM'}</strong>.</p>
          <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px; margin: 16px 0; border-radius: 4px;">
            <strong>Current League Status:</strong> ${statusLabel}
          </div>
          <p>Please take 5 seconds to let everyone know if you can make it:</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${publicUrl}" style="background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; display: inline-block;">
              Submit Your RSVP Now
            </a>
          </div>
          <p style="color: #64748b; font-size: 13px; line-height: 1.5;">
            You are receiving this reminder because your email was added to the Archery League roster. You can update notification preferences on the website.
          </p>
        </div>
      `
    };

    if (transporter) {
      try {
        await transporter.sendMail(mailOptions);
        console.log(`[Notifier] Sent reminder to ${archer.name} (${archer.email})`);
      } catch (err) {
        console.error(`[Notifier] Failed sending to ${archer.email}:`, err.message);
      }
    } else {
      console.log(`[Notifier] [DRY RUN] Would send email to ${archer.name} (${archer.email})`);
    }
  }

  return { count: targets.length };
}

module.exports = {
  sendSaturdayReminders
};
