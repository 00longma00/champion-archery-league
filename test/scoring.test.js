const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCORING_FORMATS,
  BOW_CATEGORIES,
  normalizeBowCategory,
  computeEventLockStatus,
  normalizeAndSortArrows,
  computeAutoAssignments,
  computeDefaultGroups,
  getPositionDefaults
} = require('../scoring-db');

test('normalizeAndSortArrows sorts USAA 10-Ring arrows in descending order and calculates totals', () => {
  // USAA 10-Ring: 'X' > '10' > '9' > '8' > ... > '1' > 'M'
  const arrows = ['9', 'X', 'M', '10', '7'];
  const result = normalizeAndSortArrows(arrows, 'USAA_10', 5);

  assert.deepEqual(result.sorted, ['X', '10', '9', '7', 'M'], 'Arrows should sort X -> 10 -> 9 -> 7 -> M');
  // X = 10, 10 = 10, 9 = 9, 7 = 7, M = 0 => 36
  assert.equal(result.endTotal, 36, 'End total must equal sum of arrow values');
  assert.equal(result.xCount, 1, 'X count should be 1');
  assert.equal(result.tenCount, 2, 'Ten count should count both X and 10');
});

test('normalizeAndSortArrows handles max arrows truncation and case normalization', () => {
  // Input with lowercase and extra arrows exceeding maxArrows limit (3 arrows)
  const arrows = ['x', '10', '9', '8'];
  const result = normalizeAndSortArrows(arrows, 'USAA_10', 3);

  assert.equal(result.sorted.length, 3, 'Should cap arrows to maxArrows');
  assert.deepEqual(result.sorted, ['X', '10', '9']);
  assert.equal(result.endTotal, 29);
  assert.equal(result.xCount, 1);
  assert.equal(result.tenCount, 2);
});

test('normalizeAndSortArrows filters out invalid keys and handles empty or non-array inputs', () => {
  const dirty = ['10', 'INVALID', null, undefined, '', 'M', '99', 'X'];
  const result = normalizeAndSortArrows(dirty, 'USAA_10', 5);

  assert.deepEqual(result.sorted, ['X', '10', 'M'], 'Should discard invalid keys');
  assert.equal(result.endTotal, 20);

  const empty = normalizeAndSortArrows([], 'USAA_10', 3);
  assert.deepEqual(empty.sorted, []);
  assert.equal(empty.endTotal, 0);
  assert.equal(empty.xCount, 0);
  assert.equal(empty.tenCount, 0);

  const nonArray = normalizeAndSortArrows(null, 'USAA_10', 3);
  assert.deepEqual(nonArray.sorted, []);
  assert.equal(nonArray.endTotal, 0);
});

test('normalizeAndSortArrows supports NFAA 5-Spot format scoring rules', () => {
  // NFAA 5-Spot: X=5, 5=5, 4=4, M=0; other numbers like 9 or 8 are invalid
  const arrows = ['5', 'X', '4', '9', 'M'];
  const result = normalizeAndSortArrows(arrows, 'NFAA_5SPOT', 5);

  assert.deepEqual(result.sorted, ['X', '5', '4', 'M'], 'Should keep only valid NFAA 5-Spot keys');
  // X(5) + 5(5) + 4(4) + M(0) = 14
  assert.equal(result.endTotal, 14);
  assert.equal(result.xCount, 1);
  // Max arrow value in NFAA 5-Spot is 5, so X and 5 both count towards tenCount/top ring
  assert.equal(result.tenCount, 2);
});

test('normalizeAndSortArrows supports NFAA Single-Spot and Blueface formats', () => {
  const arrows = ['X', '5', '3', '1', 'M'];
  const single = normalizeAndSortArrows(arrows, 'NFAA_SINGLE', 5);
  assert.deepEqual(single.sorted, ['X', '5', '3', '1', 'M']);
  assert.equal(single.endTotal, 14);
  assert.equal(single.xCount, 1);

  const blueface = normalizeAndSortArrows(['5', 'X', '4'], 'NFAA_BLUEFACE', 3);
  assert.deepEqual(blueface.sorted, ['X', '5', '4']);
  assert.equal(blueface.endTotal, 14);
});

test('normalizeBowCategory normalizes known variants and defaults to BAREBOW', () => {
  assert.equal(normalizeBowCategory('recurve'), 'OLYMPIC_RECURVE');
  assert.equal(normalizeBowCategory('OLYMPIC_RECURVE'), 'OLYMPIC_RECURVE');
  assert.equal(normalizeBowCategory('Olympic Recurve'), 'OLYMPIC_RECURVE');
  assert.equal(normalizeBowCategory('FSLR'), 'OLYMPIC_RECURVE');

  assert.equal(normalizeBowCategory('compound'), 'COMPOUND');
  assert.equal(normalizeBowCategory('FS'), 'COMPOUND');
  assert.equal(normalizeBowCategory('BHFS'), 'COMPOUND');

  assert.equal(normalizeBowCategory('trad'), 'TRADITIONAL');
  assert.equal(normalizeBowCategory('traditional'), 'TRADITIONAL');

  assert.equal(normalizeBowCategory('barebow'), 'BAREBOW');
  assert.equal(normalizeBowCategory('unknown_equipment'), 'BAREBOW');
  assert.equal(normalizeBowCategory(''), 'BAREBOW');
  assert.equal(normalizeBowCategory(null), 'BAREBOW');
});

test('getPositionDefaults provides correct lane and line metadata for positions A through D', () => {
  // <= 2 archers on bale
  const defA2 = getPositionDefaults('A', 2);
  assert.equal(defA2.shooting_line, 'AB');
  assert.equal(defA2.lane, 'Left');
  assert.equal(defA2.initial_target, 'Top');

  const defB2 = getPositionDefaults('B', 2);
  assert.equal(defB2.shooting_line, 'AB');
  assert.equal(defB2.lane, 'Right');
  assert.equal(defB2.initial_target, 'Bottom');

  // > 2 archers on bale (4-archer matrix)
  const defA4 = getPositionDefaults('A', 4);
  assert.equal(defA4.initial_target, 'Top');
  assert.equal(defA4.shooting_line, 'AB');

  const defC4 = getPositionDefaults('C', 4);
  assert.equal(defC4.shooting_line, 'CD');
  assert.equal(defC4.lane, 'Left');
  assert.equal(defC4.initial_target, 'Bottom');

  const defD4 = getPositionDefaults('D', 4);
  assert.equal(defD4.shooting_line, 'CD');
  assert.equal(defD4.lane, 'Right');
  assert.equal(defD4.initial_target, 'Bottom');
});

test('computeAutoAssignments distributes up to 2 archers per bale correctly', () => {
  const participants = [
    { id: 'p1', name: 'Archer 1' },
    { id: 'p2', name: 'Archer 2' },
    { id: 'p3', name: 'Archer 3' }
  ];

  const assigned = computeAutoAssignments(participants, 6, true);
  assert.equal(assigned.length, 3);

  // Archer 1: Bale 1, Position A (Left, Top)
  assert.equal(assigned[0].bale_number, 1);
  assert.equal(assigned[0].position, 'A');
  assert.equal(assigned[0].lane, 'Left');
  assert.equal(assigned[0].initial_target, 'Top');

  // Archer 2: Bale 1, Position B (Right, Bottom)
  assert.equal(assigned[1].bale_number, 1);
  assert.equal(assigned[1].position, 'B');
  assert.equal(assigned[1].lane, 'Right');
  assert.equal(assigned[1].initial_target, 'Bottom');

  // Archer 3: Bale 2, Position A (Left, Top)
  assert.equal(assigned[2].bale_number, 2);
  assert.equal(assigned[2].position, 'A');
});

test('computeAutoAssignments handles 3-4 archers per bale using AB/CD matrix', () => {
  // If maxBales is 2, 5 archers exceeds 2 * maxBales (4), switching to 3-4 archers per bale mode
  const participants = [
    { id: 'p1', name: 'Archer 1' },
    { id: 'p2', name: 'Archer 2' },
    { id: 'p3', name: 'Archer 3' },
    { id: 'p4', name: 'Archer 4' },
    { id: 'p5', name: 'Archer 5' }
  ];

  const assigned = computeAutoAssignments(participants, 2, true);
  assert.equal(assigned.length, 5);

  const bale1 = assigned.filter(a => a.bale_number === 1);
  const bale2 = assigned.filter(a => a.bale_number === 2);

  assert.ok(bale1.length >= 2, 'Bale 1 should have participants');
  assert.ok(bale2.length >= 2, 'Bale 2 should have participants');
  assert.ok(assigned.some(a => a.position === 'C'), 'Should assign position C when bale exceeds 2 archers');
});

test('computeDefaultGroups pairs adjacent active bales when <= 2 archers per bale', () => {
  const participants = [
    { id: 'p1', bale_number: 1 },
    { id: 'p2', bale_number: 1 },
    { id: 'p3', bale_number: 2 },
    { id: 'p4', bale_number: 3 }
  ];

  const groups = computeDefaultGroups(participants);
  assert.ok(Array.isArray(groups));
  assert.equal(groups.length, 2, 'Should create 2 groups for bales [1, 2] and [3]');
  assert.deepEqual(groups[0].bales, [1, 2]);
  assert.deepEqual(groups[1].bales, [3]);
});

test('computeEventLockStatus calculates deadline and locked boolean accurately', () => {
  // Past date: should be locked
  const pastStatus = computeEventLockStatus('2020-01-01', '18:00');
  assert.equal(pastStatus.is_locked, true);
  assert.equal(pastStatus.ms_remaining, 0);

  // Far future date: should not be locked
  const futureStatus = computeEventLockStatus('2099-12-31', '18:00');
  assert.equal(futureStatus.is_locked, false);
  assert.ok(futureStatus.ms_remaining > 0);
  assert.ok(futureStatus.scheduled_start_iso);
  assert.ok(futureStatus.lock_deadline_iso);
});
