import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildCouponPayload,
  validateAgoraBaseUrl,
} from '../lib/agora/couponsImport.js';

test('validateAgoraBaseUrl acepta http(s) y quita slash final', () => {
  assert.equal(validateAgoraBaseUrl('https://pos.ejemplo.com/'), 'https://pos.ejemplo.com');
  assert.equal(validateAgoraBaseUrl('http://192.168.1.10:8080'), 'http://192.168.1.10:8080');
});

test('validateAgoraBaseUrl rechaza protocolos / URLs inválidas', () => {
  assert.throws(() => validateAgoraBaseUrl('ftp://x.com'), /http o https/);
  assert.throws(() => validateAgoraBaseUrl('not-a-url'), /no es una URL válida/);
  assert.throws(() => validateAgoraBaseUrl(''), /obligatorio/);
  assert.throws(() => validateAgoraBaseUrl('https://user:pass@host.com'), /usuario\/contraseña/);
});

test('buildCouponPayload mínimo: SettingsId, Code, CreatedAt', () => {
  const c = buildCouponPayload({
    settingsId: 100,
    code: '7M6WMA0U',
    createdAt: '2022-01-20T11:00:00',
  });
  assert.deepEqual(c, {
    SettingsId: 100,
    Code: '7M6WMA0U',
    CreatedAt: '2022-01-20T11:00:00',
  });
  assert.ok(!('ValidUntil' in c));
  assert.ok(!('ValidFrom' in c));
  assert.ok(!('PrintAtPosId' in c));
});

test('buildCouponPayload con ValidUntil (sin vacíos)', () => {
  const c = buildCouponPayload({
    settingsId: '100',
    code: 'ABCD1234',
    createdAt: '2022-01-20T11:00:00',
    validUntil: '2026-12-31',
    validFrom: '',
    validTo: null,
    printAtPosId: '',
  });
  assert.equal(c.ValidUntil, '2026-12-31');
  assert.ok(!('ValidFrom' in c));
  assert.ok(!('ValidTo' in c));
  assert.ok(!('PrintAtPosId' in c));
});

test('buildCouponPayload con ValidFrom+ValidTo e PrintAtPosId', () => {
  const c = buildCouponPayload({
    settingsId: 100,
    code: 'KLADKP1',
    createdAt: '2022-01-20T11:00:00',
    validFrom: '2023-01-09T23:00:00',
    validTo: '2023-01-10T03:00:00',
    printAtPosId: 1,
  });
  assert.equal(c.ValidFrom, '2023-01-09T23:00:00');
  assert.equal(c.ValidTo, '2023-01-10T03:00:00');
  assert.equal(c.PrintAtPosId, 1);
  assert.ok(!('ValidUntil' in c));
});

test('buildCouponPayload rechaza XOR validez y campos incompletos', () => {
  assert.throws(
    () =>
      buildCouponPayload({
        settingsId: 1,
        code: 'X',
        createdAt: '2022-01-01T00:00:00',
        validUntil: '2026-01-01',
        validFrom: '2026-01-01T00:00:00',
        validTo: '2026-01-02T00:00:00',
      }),
    /no se puede combinar/,
  );
  assert.throws(
    () =>
      buildCouponPayload({
        settingsId: 1,
        code: 'X',
        createdAt: '2022-01-01T00:00:00',
        validFrom: '2026-01-01T00:00:00',
      }),
    /juntos/,
  );
  assert.throws(
    () => buildCouponPayload({ settingsId: 0, code: 'X', createdAt: 't' }),
    /SettingsId/,
  );
});
