# Streamlined Private Hub Practice Setup

Simplified and accelerated session creation in the Private Hub by defaulting to a single bale, automatically selecting only the archers linked to the currently logged-in private hub space, and stripping away complex league multi-bale grids, scorer ratios, and RSVP import tools.

### Confirmed Product & Design Decisions

- **Single Bale Default**: Practice sessions in Private Hub mode now default to 1 bale (Bale 1) with automated line, lane, and target assignment (Positions 1A, 1B). Multi-bale configuration grids (bales 1–6) and scorer-to-bale ratios are hidden in private mode.
- **Automatic Archer Pre-population**: Opening "New Session" in the Private Hub immediately pre-populates the participant roster with the archers linked to the active hub (`activePrivateHub.linked_archers`), with their saved bow category and avatar already configured.
- **Streamlined UI**: Extraneous Sunday League tools (6-bale selector grid, scorer ratio dropdown, shuffle toggle, RSVP import button, and bulk roster selector) are hidden in private mode. Archers have individual checkboxes to toggle who is shooting today.

---

### Implementation Summary

1. **Modal HTML Structure (`scoring.html`, `public/scoring.html`, `docs/scoring.html`)**:
   - Added semantic container IDs (`create-ev-bales-setup-section`, `create-ev-randomize-section`) and added a dedicated `create-ev-private-bale-notice` banner indicating single-bale assignment.
   - Identified action buttons (`btn-create-auto-assign`, `btn-create-bulk-select`, `btn-create-add-archer`, `btn-create-rsvps`) for clean mode-specific toggling.
2. **Context-Aware Dynamic Chrome (`applyModeUIChrome`)**:
   - In Private Hub mode: Hides the 6-bale grid, max bale inputs, scorer ratios, and RSVP tools; shows the Bale 1 notice; relabels CTA button to "Start Practice Session".
   - In Public League mode: Retains all original multi-bale drag-and-drop dropzones, capacity checks, and RSVP import tools.
3. **Automated Roster Population (`openCreateEventModal`)**:
   - Automatically initializes `createEventParticipantsDraft` with the active hub's linked archers (`activePrivateHub.linked_archers`), resolving historical avatars and bow categories.
   - Sets default `max_bales = 1` and `bales_per_group = 1`.
4. **Streamlined Bale 1 Participant Roster (`renderCreateEventParticipantsList`)**:
   - Renders a clean list of hub archers on Bale 1 with checkboxes to easily select who is shooting or sitting out.
   - Dynamically updates target position indicators (`1A (Top)`, `1B (Bottom)`) based on active selections.
5. **Session Creation Handler (`handleCreateEventSubmit`)**:
   - Directly assigns selected archers to Bale 1 with correct target positions, submitting to `createPrivateScoringEvent` and opening the scoring workspace without multi-bale overhead.
6. **Parity & Verification**:
   - Kept `scoring.html`, `public/scoring.html`, and `docs/scoring.html` in exact file parity.
   - Ran all unit tests (21/21 passed) and validated syntax with `compile_applet` and `lint_applet`.
