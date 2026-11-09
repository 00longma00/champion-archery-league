# Archery Tools Top Banner & Groupwise Scoring Integration

A dedicated, slim utility banner bar positioned above the main header across both the League RSVP and Tournament/Practice Scoring pages, providing archers with 1-click access to the league's archery tool ecosystem: the League RSVP Tracker, Live Tournament Scoring, My Private Hub, and the external Groupwise AI target photo scoring tool.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural and UX choices have been confirmed through Phase 1 clarification:

- **Dedicated Top Banner Bar**: Rather than a crowded drop-down menu inside the header, a sleek, compact utility bar sits directly at the very top of the page above the header on both mobile and desktop viewports, clearly establishing the "Archery Tools" suite without interfering with the existing title, logo, or action buttons.
- **Full Site Consistency**: The banner will be integrated into both the main League RSVP page (`index.html`) and the Scoring & Practice Hub page (`scoring.html`), as well as their production mirrors in `public/` and `docs/`.
- **External Link Handling**: The link to **Groupwise** (`https://archery.mshep.com/`) will open securely in a new tab (`target="_blank" rel="noopener noreferrer"`) and feature an arrow-up-right external indicator icon so archers know they are launching a companion tool.
- **Active State Recognition**: The banner dynamically recognizes the current active tool (e.g. highlighting "RSVP Tracker" on `index.html` or "Live Scoring" / "My Private Hub" on `scoring.html`), giving shooters a clear sense of orientation across the entire toolset.

---

## 1. Overview & Core Concept

- **What It Does**: Introduces a unified top utility strip across the application with curated links to essential archery tools:
  1. **RSVP Tracker**: Sunday night attendance and roster lineup.
  2. **Live Scoring**: Official bale scorecards, arrow keypad, and league leaderboards.
  3. **My Private Hub**: Personal practice scorecards, arrow volume analytics, and performance insights.
  4. **Groupwise (External)**: Maxwell Shepherd's AI target photo analyzer (`archery.mshep.com`) for automated arrow hole scoring, group size, and center drift calculations.
- **Target Audience / Persona**: Archery league shooters, club members, and practice archers who want quick, effortless switching between attendance tracking, live competition scoring, personal training logs, and target face grouping analysis.
- **Key Value**: Consolidates separate tools into a seamless archery portal. Archers no longer need to remember disparate URLs or navigate complex nested menus to log their groups or check into league night.

---

## 2. User Experience & Visual Design

### Key User Flows

1. **Viewing Available Archery Tools**: When an archer lands on the RSVP page or the Scoring Hub, they immediately notice a slender top bar labeled "ARCHERY TOOLS" with distinct, tap-friendly tool pills/links.
2. **Launching Groupwise**:
   - The user clicks or taps **"Groupwise (Target AI)"** with an arrow-up-right icon.
   - The browser opens `https://archery.mshep.com/` in a new tab without disturbing active scorecards or RSVP form state.
   - Hovering over the link reveals a helpful tooltip: *"Analyze target photos, arrow grouping & automatic scoring"*.
3. **Switching Between Internal Tools**:
   - On the RSVP page, clicking **"My Private Hub"** takes the shooter straight into `scoring.html?mode=private`.
   - On the Scoring page, clicking **"RSVP Tracker"** returns them to `index.html`.
   - On mobile screens, the banner provides smooth horizontal scroll without wrapping awkwardly or breaking the 15% sticky height limit.

### Visual Identity & Theme

- **Aesthetic Direction**: Clean, athletic, precision-engineered utility styling inspired by modern sports timing and tournament scoring consoles. Matches the existing crisp daylight / light theme overrides and dark-mode foundation.
- **Color Palette & Contrast**:
  - *Utility Bar Canvas*: Subdued neutral slate surface (`bg-slate-100/90 dark:bg-slate-950/80` with a clean hairline border `border-b border-slate-200/80 dark:border-slate-800/80` and subtle backdrop blur).
  - *Brand Tag*: Crisp micro-label with target insignia (`text-amber-600 dark:text-amber-400 font-extrabold uppercase tracking-wider`).
  - *Active Link*: Bold high-contrast accent (`text-slate-900 bg-white dark:text-amber-300 dark:bg-slate-800/90 shadow-sm`).
  - *Inactive Links*: Refined slate text (`text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors`).
  - *External Groupwise Accent*: Distinctive cyan/teal target ring cue (`text-teal-600 dark:text-teal-400 font-semibold`) signaling external target grouping analysis.
- **Typography & Hierarchy**:
  - Font family: `Plus Jakarta Sans` for labels, maintaining consistency with existing headings.
  - Sizing: Compact `text-[11px]` to `text-xs` single-line controls (`whitespace-nowrap shrink-0`) adhering to the Universal Frontend Design Constitution.
- **Interactive Feedback**:
  - Fast 150ms hover/tap color transitions (`cubic-bezier(0.16, 1, 0.3, 1)`).
  - Minimum touch target height ($\ge 40\text{px}$ container with `py-1.5 px-3` interactive touch boundaries).

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Dedicated Top Utility Strip vs. Dropdown Menu**
  - *Chosen Approach*: A dedicated horizontal top strip located above the primary header.
  - *Why*: Archery shooters often operate smartphones with finger tabs or quivers on the shooting line; dropdown menus require an extra tap to open, are prone to accidental dismissal, and hide secondary tools. A top bar exposes tool availability at a glance.
  - *Trade-off*: Takes ~36px of vertical height, which is kept ultra-compact to ensure it stays well within the 15% mobile viewport cap.
- **Decision 2: Comprehensive Tool Representation**
  - *Chosen Approach*: Include all four core destinations in the top strip: **RSVP Tracker**, **Live Scoring**, **My Private Hub**, and **Groupwise (Target AI)**.
  - *Why*: Creates an intuitive, predictable mental model where shooters can navigate between all league and personal shooting workflows from any page.
- **Decision 3: Multi-File Synchronous Deployment**
  - *Chosen Approach*: Update the top bar uniformly in `index.html`, `scoring.html`, `public/index.html`, `public/scoring.html`, `docs/index.html`, and `docs/scoring.html`.
  - *Why*: Express statically serves from `public/`, while GitHub Pages or standalone mirrors rely on root or `docs/`. Synchronizing all files prevents broken navigation across hosting configurations.

---

## 4. Technical Architecture & Data Strategy

### System Component Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│                        TOP UTILITY BANNER BAR                          │
│ 🎯 ARCHERY TOOLS │ [RSVP] │ [Live Scoring] │ [Private Hub] │ [Groupwise ↗] │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       EXISTING MAIN HEADER                             │
│ [Crest Logo] Champion Archery League          [Status / Header Action] │
└────────────────────────────────────────────────────────────────────────┘
            │                                               │
            ▼                                               ▼
┌───────────────────────────────┐               ┌────────────────────────┐
│    LOCAL ARCHERY SUITE        │               │   EXTERNAL TOOL        │
│ • index.html (RSVP / Roster)  │               │ • archery.mshep.com    │
│ • scoring.html (Tournament)   │               │   (Photo Target &      │
│ • scoring.html?mode=private   │               │    Arrow Group Drift)  │
│   (Practice & Insights)       │               │   target="_blank"      │
└───────────────────────────────┘               └────────────────────────┘
```

### Banner Markup Specification

```html
<!-- Archery Tools Utility Top Bar -->
<nav id="archery-tools-bar" aria-label="Archery Tools Navigation" class="w-full bg-slate-100/95 dark:bg-slate-950/90 border-b border-slate-200/90 dark:border-slate-800/80 text-xs py-1.5 px-3 sm:px-6">
  <div class="max-w-5xl mx-auto flex items-center justify-between gap-3 overflow-x-auto no-scrollbar">
    <div class="flex items-center gap-2 shrink-0">
      <span class="inline-flex items-center justify-center w-5 h-5 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[11px] font-black">
        <i class="fa-solid fa-crosshairs"></i>
      </span>
      <span class="font-extrabold tracking-wider uppercase text-[10px] text-slate-500 dark:text-slate-400">
        Archery Tools
      </span>
    </div>
    <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
      <!-- RSVP Tracker -->
      <a href="index.html" class="tool-link px-2.5 py-1 rounded-md font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition flex items-center gap-1.5">
        <i class="fa-solid fa-calendar-check text-emerald-500 text-[11px]"></i>
        <span>RSVP Tracker</span>
      </a>
      <!-- Live Scoring -->
      <a href="scoring.html" class="tool-link px-2.5 py-1 rounded-md font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition flex items-center gap-1.5">
        <i class="fa-solid fa-bullseye text-amber-500 text-[11px]"></i>
        <span>Live Scoring</span>
      </a>
      <!-- My Private Hub -->
      <a href="scoring.html?mode=private" class="tool-link px-2.5 py-1 rounded-md font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition flex items-center gap-1.5">
        <i class="fa-solid fa-user-shield text-sky-500 text-[11px]"></i>
        <span>My Private Hub</span>
      </a>
      <!-- Divider -->
      <span class="h-3.5 w-px bg-slate-300 dark:bg-slate-800 mx-0.5" aria-hidden="true"></span>
      <!-- Groupwise External Link -->
      <a href="https://archery.mshep.com/" target="_blank" rel="noopener noreferrer" title="Groupwise: AI photo target analysis & arrow grouping" class="tool-link px-2.5 py-1 rounded-md font-semibold text-teal-700 dark:text-teal-300 bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/30 transition flex items-center gap-1.5">
        <i class="fa-solid fa-circle-dot text-teal-500 text-[11px]"></i>
        <span>Group wise</span>
        <i class="fa-solid fa-arrow-up-right-from-square text-[9px] opacity-75"></i>
      </a>
    </div>
  </div>
</nav>
```

### Verification & Testing Plan

1. **Syntax & Server Build**: Run `npm run build` and `npm run lint` (`node --check server.js db.js scoring-db.js ai-insights.js ai-avatar.js`) to ensure zero errors.
2. **Automated Test Suite**: Run `npm test` to verify existing RSVP, avatar, and scoring test suites pass cleanly without regression.
3. **Responsive Visual Check**:
   - Verify that the banner renders cleanly at the very top of both `index.html` and `scoring.html`.
   - Test on mobile widths ($375\text{px}$) to confirm smooth horizontal touch scrolling without clipping or vertical layout breaks.
   - Verify that clicking "Group wise" opens `https://archery.mshep.com/` in a new browser tab with proper security attributes (`rel="noopener noreferrer"`).
   - Verify that navigating between "RSVP Tracker", "Live Scoring", and "My Private Hub" transitions properly without breaking state.
