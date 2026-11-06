# Archery League Attendance Tracker

A clean, mobile-responsive attendance tracker for weekly Sunday night archery league events.

## Features
- **Upcoming Sunday Event Banner:** Countdown clock and Sunday date generator.
- **League Status Indicator:** Organizer-controlled status badge (`LEAGUE IS ON`, `STATUS PENDING`, `LEAGUE IS OFF`) with custom announcements/notes.
- **RSVP Form:** Fast 1-click **Yes / Maybe / No** attendance submission with optional notes.
- **Live Scoring Hub:** Target bale assignments, on-screen target keypad, live leaderboard, and private practice hub.
- **Zero Cloud Server Setup:** Runs seamlessly with Express and Firebase.

## Quick Start (Run Locally)

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   Copy `.env.example` to `.env` and configure:
   - `ADMIN_PIN`: Secret PIN for the Organizer button (default `1234`).
   - `LEAGUE_TIME`: Default league time (e.g. 7:00 PM).

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
