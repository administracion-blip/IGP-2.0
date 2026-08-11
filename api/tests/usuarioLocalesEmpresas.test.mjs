/**
 * [SEC S-08] Empresas permitidas del usuario según Locales (aislamiento facturación).
 *
 * Admin / Locales vacío → sin restricción (null).
 * Locales concretos → Set de id_empresa de esos locales.
 * facturaEmisorPermitido: fail-closed sin emisor_id.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

const {
  montarEscenario,
  tables,
  local,
  EMPRESA_NORTE,
  EMPRESA_SUR,
} = await import('./escenarioFacturacion.mjs');

const {
  empresasPermitidasDelUsuario,
  facturaEmisorPermitido,
} = await import('../lib/usuarioLocales.js');

function escenario() {
  const db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.locales, local('000020', 'Local Sur', EMPRESA_SUR));
  return db;
}

test('Admin → null (sin restricción)', async () => {
  escenario();
  const r = await empresasPermitidasDelUsuario({ email: 'jefe@grupo.test', rol: 'Administrador' });
  assert.equal(r, null);
});

test('sin user → Set vacío', async () => {
  escenario();
  const r = await empresasPermitidasDelUsuario(null);
  assert.ok(r instanceof Set);
  assert.equal(r.size, 0);
});

test('Locales vacío → null (rol de grupo)', async () => {
  const db = escenario();
  db.sembrar(tables.usuarios, {
    id_usuario: 'u-vacio',
    Email: 'grupo@test.com',
    Local: [],
    Rol: 'Encargado',
  });
  const r = await empresasPermitidasDelUsuario({ email: 'grupo@test.com', rol: 'Encargado' });
  assert.equal(r, null);
});

test('Locales con un local → Set con su id_empresa', async () => {
  const db = escenario();
  db.sembrar(tables.usuarios, {
    id_usuario: 'u-norte',
    Email: 'norte@grupo.test',
    Local: ['Local Norte'],
    Rol: 'Encargado',
  });
  const r = await empresasPermitidasDelUsuario({ email: 'norte@grupo.test', rol: 'Encargado' });
  assert.ok(r instanceof Set);
  assert.deepEqual([...r].sort(), [EMPRESA_NORTE]);
});

test('facturaEmisorPermitido: null = todo; Set filtra; sin emisor = false', () => {
  assert.equal(facturaEmisorPermitido({ emisor_id: EMPRESA_SUR }, null), true);

  const set = new Set([EMPRESA_NORTE]);
  assert.equal(facturaEmisorPermitido({ emisor_id: EMPRESA_NORTE }, set), true);
  assert.equal(facturaEmisorPermitido({ emisor_id: EMPRESA_SUR }, set), false);
  assert.equal(facturaEmisorPermitido({ emisor_id: '' }, set), false);
  assert.equal(facturaEmisorPermitido({}, set), false);
  assert.equal(facturaEmisorPermitido(null, set), false);
});
