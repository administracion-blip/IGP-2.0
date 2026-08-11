import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  isBcryptHash,
  hashPassword,
  verifyPassword,
} from '../lib/password.js';

test('isBcryptHash reconoce hashes bcrypt y rechaza plaintext', () => {
  assert.equal(isBcryptHash('$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012'), true);
  assert.equal(isBcryptHash('$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012'), true);
  assert.equal(isBcryptHash('$2y$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012'), true);
  assert.equal(isBcryptHash('secreto'), false);
  assert.equal(isBcryptHash(''), false);
  assert.equal(isBcryptHash(null), false);
  assert.equal(isBcryptHash(undefined), false);
  assert.equal(isBcryptHash(123), false);
});

test('hashPassword + verifyPassword bcrypt OK / KO', async () => {
  const hashed = await hashPassword('MiClaveSegura1');
  assert.equal(isBcryptHash(hashed), true);

  const ok = await verifyPassword('MiClaveSegura1', hashed);
  assert.equal(ok.ok, true);
  assert.equal(ok.legacy, false);

  const ko = await verifyPassword('otra', hashed);
  assert.equal(ko.ok, false);
  assert.equal(ko.legacy, false);
});

test('plaintext legacy correcto → ok true, legacy true', async () => {
  const r = await verifyPassword('plain-secret', 'plain-secret');
  assert.equal(r.ok, true);
  assert.equal(r.legacy, true);
});

test('plaintext legacy incorrecto → ok false', async () => {
  const r = await verifyPassword('wrong-pass', 'plain-secret');
  assert.equal(r.ok, false);
  assert.equal(r.legacy, true);
});

test('plaintext legacy con longitudes distintas → ok false', async () => {
  const r = await verifyPassword('corto', 'mucho-mas-largo');
  assert.equal(r.ok, false);
  assert.equal(r.legacy, true);
});

test('verifyPassword no lanza con inputs raros/vacíos', async () => {
  const cases = [
    [null, 'x'],
    ['x', null],
    [undefined, undefined],
    ['', ''],
    ['a', ''],
    ['', 'a'],
    [1, 2],
  ];
  for (const [plain, stored] of cases) {
    const r = await verifyPassword(plain, stored);
    assert.equal(r.ok, false);
  }
});
