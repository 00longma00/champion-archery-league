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
Every archer wears one of 18 preset badges, the same one on every event. Returning archers keep the badge they picked or last wore; new archers are given a random one nobody wears yet (a random least-used one once all 18 are taken). Archers can change theirs on the RSVP page with **Change Badge**.

`node scripts/assign-avatars.mjs` previews giving badges to existing roster entries; add `--write` to save them. It only fills in missing badges and never replaces one an archer already has.

## Bale Limits
A bale takes 2 archers at a time, and up to 4 when the AB and CD lines alternate. A bale with room for only 1 archer at a time can be marked **Max 2**: tap the **Max 4** button under the bale when creating an event, or the bale's chip under **Max Archers per Bale** in Setup. Its archers shoot as A (AB line) and C (CD line). Auto-assign fills bales within their limits, and a bale over its limit is flagged. The create form remembers which bales were marked on that device.

The limits live in `bale-capacity.js` (copy it to `public/` and `docs/` after editing) and are saved on the event as `bale_capacities`, e.g. `{ "3": 2 }`.

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

## Private Hub sign-in and data protection

Only a browser that has signed in with a hub's password can change or delete that hub's data. Firestore enforces this, not just the app, so the data is protected even from someone using the browser console or the API.

- **How it works:** each browser gets a hidden Firebase anonymous account. Signing in turns the password into a key (PBKDF2, in the browser) and registers that account as a hub member. `firestore.rules` accepts the registration only if the key's sha256 matches the hub's `key_hash` in `private_hub_keys`, which nobody can read. The password itself never leaves the browser.
- **Day to day:** sign in once per device and you stay signed in. The lock button signs that device out. Private data is still readable by anyone, as before.
- **Forgotten password or lost phone:** run `node scripts/hub-admin.mjs reset <hub id> <new password>`. It prints three fields to set in the Firebase console, and every device then needs the new password.

### One-time rollout (in this order)

1. In the Firebase console, go to **Authentication → Sign-in method** and enable **Anonymous**. Click **Get started** first if Authentication was never set up.
2. Publish the site with this code. It still works with the old data and the old rules.
3. Run `node scripts/hub-admin.mjs migrate` to see the plan, then `node scripts/hub-admin.mjs migrate --write`. This moves each hub's old public `password_hash` out of sight and lists any hubs or documents that would end up read-only.
4. Immediately run `firebase deploy --only firestore:rules`.
5. Sign in to your hub once. That first sign-in replaces the key carried over from the old public hash, so a copy of that hash stops working. Every other owner should also sign in soon after the rollout.

## Speed and Firebase usage

Pages read as little from Firestore as they can, which keeps them fast and well inside the free plan's 50,000 reads a day.

- **Event pages update live.** An open event listens for changes instead of re-downloading everything every 10 seconds, so other devices' scores appear right away and only changed documents are read. A page hidden for more than 2 minutes lets go and catches up when shown again. The RSVP page skips its 20-second refresh while hidden.
- **Saving an end is one round trip.** The end score and the archer's summary are written together in one batch. The 8-hour lock is enforced by `firestore.rules`, so there is no read first.
- **Lists load a page at a time.** League events and Private Hub sessions are read newest first, a page at a time, as you page through them.
- **Score summaries.** Each archer's entry in an event (`event_participants`, `private_participants`) keeps `score_summary`, a copy of their ends. The Private Hub list and analytics read these instead of every end score. Entries without one are read from their end scores once and the summary is saved then (for league nights, only once the night is locked). `end_scores` and `private_end_scores` remain the source of truth for the event page.

### Deploy after updating

Publish the site, then run:

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

The new rule lets a locked league archer's missing `score_summary` be filled in once (nothing else about a locked event can change). The new index (`private_events` by `hub_id`, then `date` newest first) pages the Private Hub. Until the index is built, the Private Hub reads its session list in full and still works.

## Tests

```bash
npm test                          # unit tests (no Firebase needed)
cd test/rules && npm install && npm test   # emulator tests: security rules and firebase-adapter.js end to end (needs Java)
```
