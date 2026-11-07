# Unit & Regression Testing Suite for Archery League Tracker

A native, zero-dependency unit and regression testing suite to validate archery scoring computations, arrow sorting/tallying, bale assignments, and RSVP/attendance scheduling.

### User Review & Critical Decisions

> [!IMPORTANT]
> The following technical choices were confirmed during interactive clarification:
> - **Test Framework**: Node.js native test runner (`node:test` + `node:assert/strict`) — zero extra dependencies, instant execution, and native TAP/spec reporting.
> - **Core Coverage Scope**: Archery scoring and round calculation logic (`scoring-db.js`) + RSVP and attendance scheduling logic (`db.js`), joining the existing avatar test suite (`test/avatar.test.js`).
> - **Script Execution**: Package script configured to execute all test files across the `test/` directory (`npm test`).

- **Confirmed Decision 1**: Use `node:test` and `node:assert/strict` across all test suites for zero dependency footprint.
- **Confirmed Decision 2**: Isolate test databases by using in-memory or isolated temp fixtures so testing never pollutes production/dev sqlite or data files.
- **Confirmed Decision 3**: Upgrade `package.json` test script to `node --test 'test/**/*.test.js'` to discover all unit tests automatically.

---

### 1. Overview & Core Concept

- **What It Does**: Establishes a modular unit and regression test suite that runs with `npm test`, testing edge cases in arrow score aggregation, official USAA/NFAA descending sorts, X/10 counts, bale target assignments, RSVP upcoming Sunday date calculations, and JSON store integrity.
- **Target Audience / Persona**: Developers, league managers, and contributors pushing updates or tuning scoring rules without fearing silent regressions in round totals, handicaps, or schedule dates.
- **Key Value**: Provides sub-second feedback on code changes, guaranteeing that tournament scores and attendance records remain mathematically correct and resistant to regressions.

---

### 2. User Experience & Developer Workflow

- **Key Developer Flow**:
  1. Contributor modifies scoring rules or calendar scheduling logic.
  2. Runs `npm test` from root.
  3. Node's test runner executes all test suites (`test/avatar.test.js`, `test/scoring.test.js`, `test/rsvp.test.js`).
  4. Instant pass/fail report with clear assertion diffs if regressions occur.
- **Failure Diagnostics**:
  - Clear assertion failure messages detailing expected arrow totals, tie-breakers, or expected Sunday ISO format strings.
  - Zero state pollution: each test suite cleans up any temporary state cleanly.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Built-in `node:test` vs. External Runner (Vitest/Jest)**
  - *Chosen Approach*: `node:test` with `node:assert/strict`.
  - *Why*: Built directly into Node.js 18+, runs in ~200ms with zero extra `node_modules` overhead, and requires no transpiler configuration.
  - *Alternatives Considered*: Vitest or Jest were considered, but would introduce 50+ MB of additional dependencies without added benefit for pure backend logic.
- **Decision 2: Unit Test File Organization**
  - *Chosen Approach*: Separate dedicated test files:
    - `test/avatar.test.js`: Existing SVG avatar generator tests.
    - `test/scoring.test.js`: Arrow normalization, sorting, X/10 tallying, bow category normalization, and bale auto-assignments.
    - `test/rsvp.test.js`: `getUpcomingSunday` calendar logic, edge conditions (leap years, month rollovers, Sunday execution), and `readDB`/`writeDB` fallback resilience.
  - *Why*: Granular modularity allows running individual suites (`npm test test/scoring.test.js`) or the full suite (`npm test`).

---

### 4. Technical Architecture & Test Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                       npm test                              │
│             (node --test 'test/**/*.test.js')               │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
       ┌───────▼──────────────┐       ┌───────▼──────────────┐
       │ test/scoring.test.js │       │   test/rsvp.test.js  │
       └───────┬──────────────┘       └───────┬──────────────┘
               │                              │
       ┌───────▼──────────────┐       ┌───────▼──────────────┐
       │    scoring-db.js     │       │        db.js         │
       │ - normalizeAndSort   │       │ - getUpcomingSunday  │
       │ - USAA_10, NFAA_5    │       │ - readDB / writeDB   │
       │ - Bale auto-assign   │       │ - Default fallback   │
       │ - Category mapping   │       │                      │
       └──────────────────────┘       └──────────────────────┘
```

#### Detailed Test Matrices

1. **`test/scoring.test.js`**:
   - **Arrow Normalization & Sorting**:
     - Correct descending sort for USAA 10-Ring: `['9', 'X', 'M', '10', '7']` -> `['X', '10', '9', '7', 'M']`.
     - Value aggregation: End totals matching expected points (`X` = 10, `10` = 10, `M` = 0).
     - X-count and 10-count: `X` increments both `xCount` and `tenCount`; `10` increments `tenCount`.
     - NFAA 5-Spot format: `X` = 5, `5` = 5, `4` = 4, `M` = 0; invalid keys stripped.
     - Truncation to max arrows per end (e.g. max 3 arrows or 5 arrows).
     - Edge cases: Empty array, malformed strings, lowercase strings ('x' -> 'X'), unknown characters ('Z', '?').
   - **Bow Category Normalization**:
     - Standard categories: Recurve, Compound, Barebow, Longbow, Traditional, Bowhunter.
     - Case and space insensitivity (' compound ' -> 'COMPOUND').
     - Unknown defaults to 'BAREBOW'.
   - **Bale Auto-Assignments (`computeAutoAssignments`)**:
     - 2 archers per bale distribution (Lines A & B, Left & Right).
     - Target face assignment (Top vs Bottom swap logic).
     - Exceeding bale capacity behavior.

2. **`test/rsvp.test.js`**:
   - **Upcoming Sunday Calculation (`getUpcomingSunday`)**:
     - When called on a Monday, returns the upcoming Sunday date `YYYY-MM-DD`.
     - When called on a Saturday, returns the next day (Sunday).
     - When called on a Sunday, returns the current Sunday date (idempotent for event day).
     - Month transition: Last week of month rolling into the 1st week of next month.
     - Year transition: Late December rolling into January.
   - **DB Resilience (`readDB` / `writeDB`)**:
     - Default data structure validation when reading non-existent file.
     - Serialization and schema verification for config, archers, events, and rsvps.

3. **`package.json`**:
   - Update script `"test": "node --test 'test/**/*.test.js'"` for comprehensive multi-suite execution.
