import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { deriveHubKey, generateSaltHex, sha256Hex } from '../hub-keys.js';

test('hub key is PBKDF2-SHA256, 50000 rounds, hex salt: same as the old password_hash', async () => {
  const salt = '00112233445566778899aabbccddeeff';
  const expected = nodeCrypto.pbkdf2Sync('arrow123', Buffer.from(salt, 'hex'), 50000, 32, 'sha256').toString('hex');
  assert.equal(await deriveHubKey('arrow123', salt), expected);
  assert.notEqual(await deriveHubKey('arrow124', salt), expected);
});

test('sha256Hex is lowercase hex of the UTF-8 text (what the rules compare)', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('salts are random 16-byte hex', () => {
  const a = generateSaltHex();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, generateSaltHex());
});
