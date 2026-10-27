// Tests for firebase-adapter.js against an in-memory Firestore (test/fake-firebase-config.js).
// Run with: npm test    (set ADAPTER_SOURCE=<path> to test a different copy of the adapter)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterSource = process.env.ADAPTER_SOURCE || path.join(ROOT, 'firebase-adapter.js');

// The real firebase-config.js loads the SDK from gstatic over https, which Node can't import,
// so run a copy of the adapter next to the fake config instead.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archery-adapter-test-'));
fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"type":"module"}');
fs.copyFileSync(path.join(ROOT, 'test', 'fake-firebase-config.js'), path.join(tmpDir, 'firebase-config.js'));
fs.copyFileSync(adapterSource, path.join(tmpDir, 'firebase-adapter.js'));
const fake = await import(pathToFileURL(path.join(tmpDir, 'firebase-config.js')).href);
const adapter = await import(pathToFileURL(path.join(tmpDir, 'firebase-adapter.js')).href);

const EVENT = { id: 'evt_1', name: 'Sunday Night League', date: '2026-10-25' };

beforeEach(() => fake.resetStore());

test('rosterDocId keeps existing lowercased IDs and makes invalid IDs safe', () => {
  assert.equal(adapter.rosterDocId('  TZ '), 'tz');
  assert.equal(adapter.rosterDocId('Alex Grossman'), 'alex grossman');
  assert.equal(adapter.rosterDocId('AC/DC'), 'ac_dc');
  assert.equal(adapter.rosterDocId('..'), 'name-..');
  assert.equal(adapter.rosterDocId('__x__'), 'name-__x__');
  assert.equal(adapter.rosterDocId('   '), null);
});

test('createScoringEvent handles walk-in names containing "/"', async () => {
  await adapter.createScoringEvent({
    event: EVENT,
    participants: [{ name: 'AC/DC', bow_category: 'COMPOUND', bale_number: 1, position: 'A' }]
  });
  const roster = fake.getCollection('roster');
  assert.deepEqual(roster['ac_dc'], { name: 'AC/DC', bowCategory: 'COMPOUND' });
  assert.equal(Object.keys(fake.getCollection('event_participants')).length, 1);
});

test('createScoringEvent writes nothing if any write fails', async () => {
  await assert.rejects(adapter.createScoringEvent({
    event: EVENT,
    participants: [
      { name: 'Val', bale_number: 1 },
      { id: '..', name: 'Bad Id', bale_number: 1 }
    ]
  }));
  assert.deepEqual(fake.getCollection('scoring_events'), {});
  assert.deepEqual(fake.getCollection('scoring_groups'), {});
  assert.deepEqual(fake.getCollection('event_participants'), {});
  assert.deepEqual(fake.getCollection('roster'), {});
});

test('createScoringEvent does not overwrite an existing archer\'s roster profile', async () => {
  fake.resetStore({ roster: { tz: { name: 'TZ', bowCategory: 'OLYMPIC_RECURVE', avatarId: 'corgi_dog' } } });
  await adapter.createScoringEvent({
    event: EVENT,
    participants: [{ name: 'tz', bow_category: 'BAREBOW', avatar_id: 'husky_dog', bale_number: 1 }]
  });
  assert.deepEqual(fake.getCollection('roster'), {
    tz: { name: 'TZ', bowCategory: 'OLYMPIC_RECURVE', avatarId: 'corgi_dog' }
  });
  // The event itself still records the category shot that night
  assert.equal(Object.values(fake.getCollection('event_participants'))[0].bow_category, 'BAREBOW');
});

test('createScoringEvent never adds placeholder or alias names to the roster', async () => {
  await adapter.createScoringEvent({
    event: EVENT,
    participants: [
      { bale_number: 1 },
      { name: '   ', bale_number: 1 },
      { name: 'Wei', bale_number: 2 }
    ]
  });
  assert.deepEqual(fake.getCollection('roster'), {});
  const names = Object.values(fake.getCollection('event_participants')).map(p => p.name).sort();
  assert.deepEqual(names, ['Archer', 'Archer', 'Wei']);
});

test('saveBaleAssignments only adds archers newly added to the event to the roster', async () => {
  fake.resetStore({
    scoring_events: { evt_old: { id: 'evt_old', date: '2025-03-02', status: 'COMPLETED' } },
    scoring_groups: { g_old: { id: 'g_old', event_id: 'evt_old', bales: [1] } },
    event_participants: {
      p1: { id: 'p1', event_id: 'evt_old', name: 'Removed Archer', bale_number: 1, position: 'A' },
      p2: { id: 'p2', event_id: 'evt_old', name: 'Dropped', bale_number: 1, position: 'B' }
    }
  });
  const res = await adapter.saveBaleAssignments('evt_old', {
    participants: [
      { id: 'p1', event_id: 'evt_old', name: 'Removed Archer', bale_number: 1, position: 'A' },
      { name: 'New Walkin', bow_category: 'TRADITIONAL', bale_number: 2, position: 'A' }
    ],
    groups: [{ id: 'g1', bales: [1, 2] }],
    balesPerGroup: 2
  });
  assert.equal(res.success, true);
  assert.deepEqual(fake.getCollection('roster'), {
    'new walkin': { name: 'New Walkin', bowCategory: 'TRADITIONAL' }
  });
  assert.deepEqual(Object.keys(fake.getCollection('scoring_groups')), ['g1']);
  const participants = fake.getCollection('event_participants');
  assert.equal(participants.p2, undefined);
  assert.equal(Object.keys(participants).length, 2);
  assert.equal(fake.getCollection('scoring_events').evt_old.bales_per_group, 2);
});

test('submitRsvp handles names containing "/"', async () => {
  await adapter.submitRsvp({ name: 'Sam/Jo', status: 'YES', bowCategory: 'COMPOUND' });
  assert.equal(fake.getCollection('roster')['sam_jo'].name, 'Sam/Jo');
  assert.equal(Object.keys(fake.getCollection('rsvps')).length, 1);
});

test('getScoringEventsHub uses the latest event for non-roster archers and leaves unknown categories null', async () => {
  fake.resetStore({
    roster: { tz: { name: 'TZ' } },
    scoring_events: {
      e_old: { id: 'e_old', date: '2025-01-05' },
      e_new: { id: 'e_new', date: '2026-10-18' }
    },
    // Older record listed first so "first seen wins" would pick the wrong one
    event_participants: {
      a: { id: 'a', event_id: 'e_old', name: 'Walker', bow_category: 'TRADITIONAL' },
      b: { id: 'b', event_id: 'e_new', name: 'Walker', bow_category: 'BAREBOW' },
      c: { id: 'c', event_id: 'e_new', name: 'NoCat' },
      d: { id: 'd', event_id: 'e_new', name: 'Wei', bow_category: 'BAREBOW' }
    }
  });
  const hub = await adapter.getScoringEventsHub();
  const byName = Object.fromEntries(hub.rsvpImport.allArchers.map(a => [a.name, a]));
  assert.deepEqual(Object.keys(byName).sort(), ['NoCat', 'TZ', 'Walker']);
  assert.equal(byName.Walker.bow_category, 'BAREBOW');
  assert.equal(byName.NoCat.bow_category, null);
  assert.equal(byName.TZ.bow_category, null);
});

test('public/ and docs/ copies match the root adapter and config', () => {
  for (const file of ['firebase-adapter.js', 'firebase-config.js']) {
    const root = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    for (const dir of ['public', 'docs']) {
      assert.equal(fs.readFileSync(path.join(ROOT, dir, file), 'utf-8'), root, `${dir}/${file} differs from ${file}`);
    }
  }
});
