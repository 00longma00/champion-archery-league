import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBaleCapacities,
  baleCapacity,
  archersAtATime,
  toggleBaleCapacity,
  positionsForBale,
  distributeToBales,
  singleLineCapacity,
  overCapacityBales,
  allowedPositions
} from '../bale-capacity.js';

test('bales default to 4 archers; exceptions hold 2', () => {
  assert.equal(baleCapacity({}, 1), 4);
  assert.equal(baleCapacity(undefined, 1), 4);
  assert.equal(baleCapacity({ 3: 2 }, 3), 2);
  assert.equal(baleCapacity({ 3: 2 }, '3'), 2);
  assert.equal(archersAtATime({ 3: 2 }, 3), 1);
  assert.equal(archersAtATime({ 3: 2 }, 1), 2);
});

test('normalizeBaleCapacities keeps only valid exceptions', () => {
  assert.deepEqual(normalizeBaleCapacities({ 1: 4, 2: 2, x: 2, 0: 2, 5: '2', 6: 7 }), { 2: 2, 5: 2 });
  assert.deepEqual(normalizeBaleCapacities(null), {});
});

test('toggleBaleCapacity switches a bale between 4 and 2 without mutating', () => {
  const start = { 2: 2 };
  const on = toggleBaleCapacity(start, 4);
  assert.deepEqual(on, { 2: 2, 4: 2 });
  assert.deepEqual(start, { 2: 2 });
  assert.deepEqual(toggleBaleCapacity(on, 2), { 4: 2 });
});

test('positionsForBale: normal bale uses A/B then AB/CD', () => {
  assert.deepEqual(positionsForBale(2, 4).map(s => s.position), ['A', 'B']);
  assert.deepEqual(positionsForBale(2, 4).map(s => s.initial_target), ['Top', 'Bottom']);
  const four = positionsForBale(4, 4);
  assert.deepEqual(four.map(s => s.position), ['A', 'B', 'C', 'D']);
  assert.deepEqual(four.map(s => s.shooting_line), ['AB', 'AB', 'CD', 'CD']);
});

test('positionsForBale: 1-at-a-time bale alternates A (AB) and C (CD)', () => {
  const two = positionsForBale(2, 2);
  assert.deepEqual(two.map(s => s.position), ['A', 'C']);
  assert.deepEqual(two.map(s => s.shooting_line), ['AB', 'CD']);
  assert.deepEqual(two.map(s => s.lane), ['Left', 'Left']);
  assert.deepEqual(positionsForBale(2, 2, true).map(s => s.initial_target), ['Bottom', 'Top']);
  assert.deepEqual(positionsForBale(1, 2).map(s => s.position), ['A']);
});

test('distributeToBales fills one line first, respecting small bales', () => {
  // Bale 2 takes 1 at a time.
  assert.deepEqual(distributeToBales(5, [1, 2, 3], { 2: 2 }), [1, 1, 2, 3, 3]);
  // Then the alternating line, round-robin, within limits.
  const ten = distributeToBales(10, [1, 2, 3], { 2: 2 });
  const counts = ten.reduce((m, b) => ({ ...m, [b]: (m[b] || 0) + 1 }), {});
  assert.deepEqual(counts, { 1: 4, 2: 2, 3: 4 });
});

test('distributeToBales spreads archers past capacity so they show as over', () => {
  const out = distributeToBales(4, [1], { 1: 2 });
  assert.equal(out.length, 4);
  assert.deepEqual(overCapacityBales(out, { 1: 2 }), [{ bale: 1, count: 4, capacity: 2 }]);
  assert.deepEqual(distributeToBales(3, [], {}), []);
});

test('singleLineCapacity and allowedPositions', () => {
  assert.equal(singleLineCapacity([1, 2, 3], { 2: 2 }), 5);
  assert.deepEqual(allowedPositions(2), ['A', 'C']);
  assert.deepEqual(allowedPositions(4), ['A', 'B', 'C', 'D']);
});

test('overCapacityBales flags only bales over their own limit', () => {
  assert.deepEqual(overCapacityBales([1, 1, 1, 2, 2, 2], { 1: 2 }), [{ bale: 1, count: 3, capacity: 2 }]);
});
