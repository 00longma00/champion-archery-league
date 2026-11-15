# Archery League Attendance Tracker

A clean, mobile-responsive attendance tracker for weekly Sunday night archery league events.

## Features
- **Upcoming Sunday Event Banner:** Countdown clock and Sunday date generator.
- **League Status Indicator:** Organizer-controlled status badge (`LEAGUE IS ON`, `STATUS PENDING`, `LEAGUE IS OFF`) with custom announcements/notes.
- **RSVP Form:** Fast 1-click **Yes / Maybe / No** attendance submission with optional notes.
- **Live Scoring Hub:** Target bale assignments, on-screen target keypad, live leaderboard, and private practice hub.
- **Zero Cloud Server Setup:** Runs seamlessly with Express and Firebase.

## Archer Names
Each archer is shown and saved under one full name, whatever was typed ("Max" → "Maxwell Shepherd"), including in past events and the Private Hub. Unknown names are kept as typed, and the RSVP and Add Archer forms suggest close matches ("Did you mean Sam Zhang?").

To link a new nickname or fix a typo, either add it to `KNOWN_ARCHER_ALIASES` in `archer-names.js` (then copy the file to `public/` and `docs/`), or give the archer's document in the Firestore `roster` collection an `aliases` array, e.g. `["Sam"]`.

## Archer Badges
Every archer wears one of 18 preset badges, the same one on every event. Returning archers keep the badge they picked or last wore; new archers are given one nobody wears yet (the least-used one once all 18 are taken). Archers can change theirs on the RSVP page with **Change Badge**.

`node scripts/assign-avatars.mjs` previews giving badges to existing roster entries; add `--write` to save them. It only fills in missing badges and never replaces one an archer already has.

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
