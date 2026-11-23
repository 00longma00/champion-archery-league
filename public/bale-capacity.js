// Per-bale archer limits, shared by the scoring page (browser ES module).
//
// A normal bale takes 2 archers at a time (A & B on the AB line) and up to 4
// when the lines alternate (C & D shoot on the CD line). Some bales only have
// room for 1 archer at a time, so they hold 2 at most: A on the AB line and C
// on the CD line. Events store only those exceptions, as
// `bale_capacities: { "<bale number>": 2 }`.

export const DEFAULT_BALE_CAPACITY = 4;
export const SINGLE_BALE_CAPACITY = 2;

// Keeps only valid exceptions, keyed by bale number as a string.
export function normalizeBaleCapacities(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    const bale = Number(key);
    if (Number.isInteger(bale) && bale > 0 && Number(value) === SINGLE_BALE_CAPACITY) {
      out[String(bale)] = SINGLE_BALE_CAPACITY;
    }
  }
  return out;
}

export function baleCapacity(capacities, bale) {
  return normalizeBaleCapacities(capacities)[String(Number(bale))] || DEFAULT_BALE_CAPACITY;
}

// How many archers shoot on the bale at the same time (one line).
export function archersAtATime(capacities, bale) {
  return baleCapacity(capacities, bale) / 2;
}

// Returns a copy with the bale switched between 4 (default) and 2.
export function toggleBaleCapacity(capacities, bale) {
  const next = normalizeBaleCapacities(capacities);
  const key = String(Number(bale));
  if (next[key]) delete next[key];
  else next[key] = SINGLE_BALE_CAPACITY;
  return next;
}

// Positions for `count` archers on one bale. `flip` starts the first line on
// the Bottom target instead of the Top one.
export function positionsForBale(count, capacity = DEFAULT_BALE_CAPACITY, flip = false) {
  const first = flip ? 'Bottom' : 'Top';
  const second = flip ? 'Top' : 'Bottom';
  const A = { position: 'A', shooting_line: 'AB', lane: 'Left' };
  const B = { position: 'B', shooting_line: 'AB', lane: 'Right' };
  const C = { position: 'C', shooting_line: 'CD', lane: 'Left' };
  const D = { position: 'D', shooting_line: 'CD', lane: 'Right' };
  let slots;
  if (capacity === SINGLE_BALE_CAPACITY) {
    // One archer per line: AB line then CD line.
    slots = [{ ...A, initial_target: first }, { ...C, initial_target: second }];
  } else if (count <= 2) {
    // One line, both archers together, one per target.
    slots = [{ ...A, initial_target: first }, { ...B, initial_target: second }];
  } else {
    slots = [
      { ...A, initial_target: first }, { ...B, initial_target: first },
      { ...C, initial_target: second }, { ...D, initial_target: second }
    ];
  }
  // Archers past the limit reuse the last slot; the page flags the bale as over capacity.
  return Array.from({ length: count }, (_, i) => ({ ...(slots[i] || slots[slots.length - 1]) }));
}

// Picks a bale for each of `count` archers. Bales fill one line first, in
// order (1A, 1B, 2A, 2B, ...), then the alternating line round-robin, so no
// bale goes over its limit while another still has room. Archers beyond the
// total capacity are spread round-robin and show up as over capacity.
export function distributeToBales(count, bales, capacities) {
  const list = (bales || []).map(Number).filter(b => b > 0);
  if (count <= 0 || list.length === 0) return [];
  const caps = list.map(b => baleCapacity(capacities, b));
  const filled = list.map(() => 0);
  const out = [];
  // Line 1
  for (let i = 0; i < list.length && out.length < count; i++) {
    while (filled[i] < caps[i] / 2 && out.length < count) { filled[i]++; out.push(list[i]); }
  }
  // Alternating line
  let progress = true;
  while (out.length < count && progress) {
    progress = false;
    for (let i = 0; i < list.length && out.length < count; i++) {
      if (filled[i] < caps[i]) { filled[i]++; out.push(list[i]); progress = true; }
    }
  }
  // Over capacity
  for (let i = 0; out.length < count; i = (i + 1) % list.length) out.push(list[i]);
  return out;
}

// Archers that fit across the bales at once without alternating lines.
export function singleLineCapacity(bales, capacities) {
  return (bales || []).reduce((sum, b) => sum + archersAtATime(capacities, b), 0);
}

// Bales holding more archers than allowed: [{ bale, count, capacity }].
export function overCapacityBales(baleNumbers, capacities) {
  const counts = {};
  (baleNumbers || []).forEach(b => { const n = Number(b) || 1; counts[n] = (counts[n] || 0) + 1; });
  return Object.keys(counts).map(Number).sort((a, b) => a - b)
    .map(bale => ({ bale, count: counts[bale], capacity: baleCapacity(capacities, bale) }))
    .filter(r => r.count > r.capacity);
}

// Valid positions on a bale, for position pickers.
export function allowedPositions(capacity) {
  return capacity === SINGLE_BALE_CAPACITY ? ['A', 'C'] : ['A', 'B', 'C', 'D'];
}
