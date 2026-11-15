import test from 'node:test';
import assert from 'node:assert/strict';
import { ArcherDirectory, cleanArcherName, nameKey } from '../archer-names.js';

test('Nov 8 short names resolve to the full names used in earlier events', () => {
  const dir = new ArcherDirectory();
  const nov8 = ['Alex', 'Jay Liu', 'Long', 'Max', 'Weijia', 'tz'];
  assert.deepEqual(nov8.map(n => dir.display(n)),
    ['Alex Grossman', 'Jay Liu', 'Long Ma', 'Maxwell Shepherd', 'Weijia Li', 'TZ']);
  assert.equal(dir.key('Max'), dir.key('Maxwell Shepherd'));
  assert.equal(dir.key('tz'), dir.key('TZ'));
});

test('known typos fold into the right archer', () => {
  const dir = new ArcherDirectory();
  assert.equal(dir.display('Alex Grossmanx'), 'Alex Grossman');
  assert.equal(dir.display('Xianchuu'), 'Xianchu Chen');
  assert.equal(dir.display('Ling Fangng'), 'Ling Fang');
  assert.equal(dir.display('Qihuanan'), 'Qihuan Aixinjueluo');
  assert.equal(dir.display('Magnur Gilmutdin'), 'Maginur Gilmitdinova');
  assert.equal(dir.display('Jiajia'), 'Weijia Li');
  assert.equal(dir.display('Joy'), 'Joy Lin');
});

test('Joyce stays a different archer from Joy Lin', () => {
  const dir = new ArcherDirectory();
  assert.equal(dir.display('Joyce'), 'Joyce');
  assert.notEqual(dir.key('Joyce'), dir.key('Joy'));
});

test('matching ignores case and extra spaces', () => {
  const dir = new ArcherDirectory();
  assert.equal(cleanArcherName('  maxwell   shepherd '), 'maxwell shepherd');
  assert.equal(nameKey('  Maxwell   SHEPHERD '), 'maxwell shepherd');
  assert.equal(dir.display('  LONG '), 'Long Ma');
});

test('unknown names are kept as typed, never guessed', () => {
  const dir = new ArcherDirectory();
  assert.equal(dir.resolve('Sam'), null);
  assert.equal(dir.display(' Sam '), 'Sam');
  assert.equal(dir.display(''), '');
});

test('roster names are learned without overriding the confirmed links', () => {
  const dir = new ArcherDirectory();
  dir.learn([{ name: 'Long' }, { name: 'Sam Zhang' }, { name: 'tz' }, 'Jay Liu']);
  assert.equal(dir.display('Long'), 'Long Ma');
  assert.equal(dir.display('sam zhang'), 'Sam Zhang');
  assert.equal(dir.display('tz'), 'TZ');
  assert.ok(dir.names().includes('Sam Zhang'));
  assert.ok(!dir.names().includes('Long'));
});

test('roster docs can add their own aliases', () => {
  const dir = new ArcherDirectory();
  dir.learn([{ name: 'Valerie Smith', aliases: ['Val'] }]);
  assert.equal(dir.display('Val'), 'Valerie Smith');
  // A name that already belongs to someone is never re-pointed.
  dir.learn([{ name: 'Somebody Else', aliases: ['Long'] }]);
  assert.equal(dir.display('Long'), 'Long Ma');
});

test('suggests existing archers for names it does not know', () => {
  const dir = new ArcherDirectory();
  dir.learn(['Sam Zhang', 'Jason Feng', 'Tom Burlington', 'Joyce']);
  assert.deepEqual(dir.suggest('Sam'), ['Sam Zhang']);
  assert.deepEqual(dir.suggest('jasn feng'), ['Jason Feng']);
  assert.ok(dir.suggest('Maxw').includes('Maxwell Shepherd'));
  assert.deepEqual(dir.suggest('Max'), [], 'known names need no suggestion');
  assert.deepEqual(dir.suggest('Zed'), []);
  assert.deepEqual(dir.suggest('S'), []);
});

test('saves reuse the existing roster doc for the same archer', () => {
  const dir = new ArcherDirectory();
  const roster = [{ id: 'long', name: 'Long' }, { id: 'jay liu', name: 'Jay Liu' }];
  assert.equal(dir.rosterDocId('Long Ma', roster), 'long');
  assert.equal(dir.rosterDocId('long', roster), 'long');
  assert.equal(dir.rosterDocId('Jay Liu', roster), 'jay liu');
  assert.equal(dir.rosterDocId('Sam Zhang', roster), 'sam zhang');
});

test('keysFor lists every key old data may be stored under', () => {
  const dir = new ArcherDirectory();
  assert.deepEqual(dir.keysFor('Long Ma').sort(), ['long', 'long ma']);
  assert.deepEqual(dir.keysFor('Sam'), ['sam']);
});
