/**
 * S-23: los secretos se comparan en tiempo constante y sin lanzar.
 *
 * `===` sobre un secreto corta en el primer carácter distinto: midiendo el
 * tiempo de respuesta se puede adivinar byte a byte. `safeEqual` usa
 * `crypto.timingSafeEqual` y devuelve `false` (sin excepción) ante longitudes
 * distintas o valores que no son cadenas.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-safe-equal';

const { safeEqual } = await import('../lib/seguridad/safeEqual.js');
const { requireAuth } = await import('../middleware/auth.js');
const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { rotarTokenIcs, validarTokenIcs } = await import('../lib/tasks/vencimientosIcs.js');

test('safeEqual: iguales true; distintos, otra longitud, vacíos o no cadenas false sin lanzar', () => {
  assert.equal(safeEqual('secreto-largo', 'secreto-largo'), true);
  assert.equal(safeEqual('ñandú-€', 'ñandú-€'), true);
  assert.equal(safeEqual('secreto-largo', 'secreto-largX'), false);
  assert.equal(safeEqual('secreto', 'secreto-largo'), false);
  assert.equal(safeEqual('é', 'ee'), false, 'misma longitud en caracteres, distinta en bytes');
  assert.equal(safeEqual('', ''), false);
  for (const raro of [undefined, null, 123, ['secreto'], { toString: () => 'secreto' }, Buffer.from('secreto')]) {
    assert.equal(safeEqual(raro, 'secreto'), false);
    assert.equal(safeEqual('secreto', raro), false);
  }
});

function pasaComoInterno(secreto) {
  const req = { method: 'POST', originalUrl: '/api/agora/users/sync', headers: { 'x-internal-secret': secreto } };
  let paso = false;
  let estado = null;
  const res = { status(s) { estado = s; return { json: () => {} }; } };
  requireAuth(req, res, () => { paso = true; });
  return { paso, estado, interno: req.isInternal === true };
}

test('x-internal-secret: solo el valor exacto entra como interno', () => {
  const anterior = process.env.INTERNAL_SYNC_SECRET;
  process.env.INTERNAL_SYNC_SECRET = 'secreto-interno-de-prueba-largo';
  try {
    assert.equal(pasaComoInterno('secreto-interno-de-prueba-largo').interno, true);
    for (const malo of [
      'secreto-interno-de-prueba-larg',
      'secreto-interno-de-prueba-largoX',
      'Secreto-interno-de-prueba-largo',
      '',
      ['secreto-interno-de-prueba-largo'],
      undefined,
    ]) {
      const r = pasaComoInterno(malo);
      assert.equal(r.interno, false, JSON.stringify(malo));
      assert.equal(r.estado, 401);
    }
  } finally {
    if (anterior === undefined) delete process.env.INTERNAL_SYNC_SECRET;
    else process.env.INTERNAL_SYNC_SECRET = anterior;
  }
});

test('token ICS: el correcto vale; uno alterado, truncado o de otro usuario no', async () => {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  const { token } = await rotarTokenIcs({ usuarioId: '000002' });
  const { token: otro } = await rotarTokenIcs({ usuarioId: '000003' });

  assert.deepEqual(await validarTokenIcs(token), { ok: true, usuarioId: '000002' });
  const ultimo = token.at(-1) === 'A' ? 'B' : 'A';
  assert.equal((await validarTokenIcs(token.slice(0, -1) + ultimo)).ok, false);
  assert.equal((await validarTokenIcs(token.slice(0, -2))).ok, false);
  const ajeno = `000002.${otro.split('.')[1]}`;
  assert.equal((await validarTokenIcs(ajeno)).ok, false);
});
