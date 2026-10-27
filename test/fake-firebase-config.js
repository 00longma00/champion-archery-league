// In-memory stand-in for firebase-config.js so the adapter can be tested under Node without a live Firestore.
// Mirrors the Firestore behaviours the adapter depends on, including the ones that make writes fail.

export const store = new Map(); // "collection/id" -> data
export const db = { fake: true };

export function resetStore(seed = {}) {
  store.clear();
  for (const [coll, docs] of Object.entries(seed)) {
    for (const [id, data] of Object.entries(docs)) store.set(`${coll}/${id}`, structuredClone(data));
  }
}

export function getCollection(coll) {
  const out = {};
  for (const [path, data] of store) {
    const [c, id] = path.split('/');
    if (c === coll) out[id] = data;
  }
  return out;
}

function validateId(id) {
  // The server rejects these IDs, failing the write (or the whole batch)
  if (id === '.' || id === '..' || /^__.*__$/.test(id)) {
    throw new Error(`Invalid document ID: "${id}"`);
  }
}

function validateData(value, field = '') {
  if (value === undefined) throw new Error(`Unsupported field value: undefined (found in field ${field})`);
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) validateData(v, field ? `${field}.${k}` : k);
  }
}

export function collection(_db, coll) {
  return { type: 'collection', coll };
}

export function doc(_db, ...segments) {
  for (const s of segments) {
    if (typeof s !== 'string' || s === '') throw new Error('Function doc() cannot be called with an empty path.');
  }
  const parts = segments.join('/').split('/').filter(Boolean);
  if (parts.length % 2 !== 0) {
    throw new Error(`Invalid document reference. Document references must have an even number of segments, but ${parts.join('/')} has ${parts.length}.`);
  }
  if (parts.length !== 2) throw new Error('Fake Firestore only supports top-level collections');
  return { type: 'doc', coll: parts[0], id: parts[1], path: parts.join('/') };
}

export function where(field, op, value) {
  if (op !== '==') throw new Error('Fake Firestore only supports == filters');
  return { field, value };
}

export function query(collRef, ...filters) {
  return { type: 'query', coll: collRef.coll, filters };
}

export function orderBy() {
  throw new Error('orderBy not supported by fake Firestore');
}

export function onSnapshot() {
  throw new Error('onSnapshot not supported by fake Firestore');
}

function snapshotDoc(coll, id, data) {
  return {
    id,
    ref: { type: 'doc', coll, id, path: `${coll}/${id}` },
    exists: () => data !== undefined,
    data: () => (data === undefined ? undefined : structuredClone(data))
  };
}

export async function getDoc(ref) {
  return snapshotDoc(ref.coll, ref.id, store.get(ref.path));
}

export async function getDocs(q) {
  const filters = q.filters || [];
  const docs = Object.entries(getCollection(q.coll))
    .filter(([, data]) => filters.every(f => data[f.field] === f.value))
    .map(([id, data]) => snapshotDoc(q.coll, id, data));
  return { docs, size: docs.length, forEach: fn => docs.forEach(fn) };
}

function applySet(ref, data, options) {
  const prev = store.get(ref.path);
  const next = options && options.merge && prev ? { ...prev, ...data } : { ...data };
  store.set(ref.path, structuredClone(next));
}

function applyUpdate(ref, fields) {
  const prev = store.get(ref.path);
  if (!prev) throw new Error(`No document to update: ${ref.path}`);
  const next = structuredClone(prev);
  for (const [k, v] of Object.entries(fields)) {
    const keys = k.split('.');
    let target = next;
    keys.slice(0, -1).forEach(key => { target[key] = target[key] || {}; target = target[key]; });
    target[keys[keys.length - 1]] = v;
  }
  store.set(ref.path, next);
}

export async function setDoc(ref, data, options) {
  validateData(data);
  validateId(ref.id);
  applySet(ref, data, options);
}

export async function updateDoc(ref, fields) {
  validateData(fields);
  validateId(ref.id);
  applyUpdate(ref, fields);
}

export async function deleteDoc(ref) {
  store.delete(ref.path);
}

export function writeBatch() {
  const ops = [];
  return {
    set(ref, data, options) { validateData(data); ops.push(() => applySet(ref, data, options)); ops[ops.length - 1].ref = ref; return this; },
    update(ref, fields) { validateData(fields); ops.push(() => applyUpdate(ref, fields)); ops[ops.length - 1].ref = ref; return this; },
    delete(ref) { ops.push(() => store.delete(ref.path)); ops[ops.length - 1].ref = ref; return this; },
    async commit() {
      // Atomic: validate every op before applying any, and roll back if one fails mid-way
      ops.forEach(op => validateId(op.ref.id));
      const snapshot = new Map(store);
      try {
        ops.forEach(op => op());
      } catch (e) {
        store.clear();
        snapshot.forEach((v, k) => store.set(k, v));
        throw e;
      }
    }
  };
}
