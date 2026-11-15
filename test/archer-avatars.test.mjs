import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_AVATAR_IDS, leastUsedAvatar, planArcherAvatars, rosterAvatarsByArcher, isPresetAvatar } from '../archer-avatars.js';

const history = [
  { name: 'Maxwell Shepherd', avatar_id: 'husky_dog', date: '2026-10-24' },
  { name: 'Max', avatar_id: null, date: '2026-11-08' },
  { name: 'TZ', avatar_id: 'corgi_dog', date: '2026-10-24' },
  { name: 'tz', avatar_id: 'default_target', date: '2026-11-08' },
  { name: 'Val', avatar_id: 'corgi_dog', date: '2026-10-24' },
  { name: 'Long Ma', avatar_id: 'bengal_cat', date: '2026-10-24' },
  { name: 'Jay Liu', avatar_id: null, date: '2026-11-08' },
  { name: 'Tim Shi', avatar_id: null, date: '2026-10-24' },
  { name: 'Rex', avatar_id: null, date: '2026-03-22' }
];
const roster = [
  { name: 'Long', avatarId: 'bengal_cat' },
  { name: 'tz', avatarId: 'default_target' },
  { name: 'Max', avatarId: null },
  { name: 'Alex', avatarId: 'golden_dog' }
];

test('returning archers get back the badge they used before', () => {
  const plan = planArcherAvatars({ roster, pastEntries: history });
  assert.equal(plan.get('maxwell shepherd').avatarId, 'husky_dog');
  assert.equal(plan.get('maxwell shepherd').source, 'previous');
  assert.equal(plan.get('tz').avatarId, 'corgi_dog', 'the plain target is not a badge');
  assert.equal(plan.get('long ma').avatarId, 'bengal_cat');
  assert.equal(plan.get('alex grossman').source, 'picked');
});

test('a badge picked on the RSVP page wins over an older one', () => {
  const plan = planArcherAvatars({
    roster: [{ name: 'Maxwell Shepherd', avatarId: 'samoyed_dog' }],
    pastEntries: [{ name: 'Max', avatar_id: 'husky_dog', date: '2026-10-24' }]
  });
  assert.equal(plan.get('maxwell shepherd').avatarId, 'samoyed_dog');
});

test('shared badges from the past are kept as they were', () => {
  const plan = planArcherAvatars({ roster, pastEntries: history });
  assert.equal(plan.get('tz').avatarId, 'corgi_dog');
  assert.equal(plan.get('val').avatarId, 'corgi_dog');
});

test('archers without a badge get unused ones, most recently active first', () => {
  const plan = planArcherAvatars({ roster, pastEntries: history });
  const taken = ['husky_dog', 'corgi_dog', 'bengal_cat', 'golden_dog'];
  const jay = plan.get('jay liu').avatarId;
  const tim = plan.get('tim shi').avatarId;
  assert.ok(isPresetAvatar(jay) && !taken.includes(jay));
  assert.ok(isPresetAvatar(tim) && !taken.includes(tim) && tim !== jay);
  assert.equal(jay, PRESET_AVATAR_IDS.find(id => !taken.includes(id)), 'Jay (Nov 8) picks before Tim (Oct 24)');
  assert.equal(plan.get('jay liu').source, 'assigned');
});

test('archers not seen since the cutoff wait until they come back', () => {
  const plan = planArcherAvatars({ roster, pastEntries: history, assignNewSince: '2026-08-17' });
  assert.equal(plan.get('rex').avatarId, null);
  assert.ok(plan.get('jay liu').avatarId);
});

test('once all 18 badges are used, the least-used one is reused', () => {
  const all = [...PRESET_AVATAR_IDS, ...PRESET_AVATAR_IDS.filter(id => id !== 'poodle_dog')];
  assert.equal(leastUsedAvatar(all), 'poodle_dog');
  assert.equal(leastUsedAvatar([]), PRESET_AVATAR_IDS[0]);
  assert.equal(leastUsedAvatar(['tabby_cat']), 'calico_cat');
});

test('roster badges are looked up by any spelling of the name', () => {
  const byKey = rosterAvatarsByArcher(roster);
  assert.equal(byKey.get('long ma'), 'bengal_cat');
  assert.equal(byKey.get('alex grossman'), 'golden_dog');
  assert.equal(byKey.has('tz'), false, 'default_target is not a badge');
});
