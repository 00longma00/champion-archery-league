# Archery League Attendance Tracker

A clean, mobile-responsive attendance tracker for weekly Sunday night archery league events.

## Features
- **Upcoming Sunday Event Banner:** Countdown clock and Sunday date generator.
- **League Status Indicator:** Organizer-controlled status badge (`LEAGUE IS ON`, `STATUS PENDING`, `LEAGUE IS OFF`) with custom announcements/notes.
- **RSVP Form:** Fast 1-click **Yes / Maybe / No** attendance submission with optional notes.
- **Email Reminders:** Archers can opt in to receive an automated Saturday morning email reminder (10:00 AM) if they haven't submitted their RSVP yet.
- **Gmail SMTP Integration:** Sends reminders directly through your Gmail account using a standard Google App Password.
- **Zero Cloud Database Dependencies:** Data stored cleanly in `data.json` on your local hardware.

## Quick Start (Run Locally)

1. **Install dependencies:**
   ```bash
   cd archery-league
   npm install express nodemailer node-cron
   ```

2. **Configure environment:**
   Copy `.env.example` to `.env` and configure:
   - `ADMIN_PIN`: Secret PIN for the Organizer button (default `1234`).
   - `SMTP_USER`: Your Gmail address (e.g. `yourname@gmail.com`).
   - `SMTP_PASS`: Your 16-character Google App Password.
   - `PUBLIC_URL`: Your public Cloudflare Tunnel URL.

3. **Start the server:**
   ```bash
   npm start
   # or: node server.js
   ```
   Open `http://127.0.0.1:3456` in your browser.

## Exposing Publicly via Free Cloudflare Tunnel

To share securely with other archers over HTTPS without port-forwarding:
```bash
cloudflared tunnel --url http://127.0.0.1:3456
```
Copy the generated `https://<random-id>.trycloudflare.com` URL and share it with your group!
