/**
 * [SEC S-08] Empresas permitidas del usuario según Locales (aislamiento facturación).
 *
 * Admin / Locales vacío → sin restricción (null).
 * Locales concretos → Set de id_empresa de esos locales.
 * Usuario sin ficha (borrado con el token vivo) → restringido sin locales.
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
  usuarioPuedeAccederLocal,
  usuarioTieneAlcanceGlobal,
} = await import('../lib/usuarioLocales.js');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');

function escenario() {
  const db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.locales, local('000020', 'Local Sur', EMPRESA_SUR));
  invalidarContextoAcceso();
  invalidarMaestroLocales();
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
  const r = await empresasPermitidasDelUsuario({ sub: 'u-vacio', email: 'grupo@test.com', rol: 'Encargado' });
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
  const r = await empresasPermitidasDelUsuario({ sub: 'u-norte', email: 'norte@grupo.test', rol: 'Encargado' });
  assert.ok(r instanceof Set);
  assert.deepEqual([...r].sort(), [EMPRESA_NORTE]);
});

test('usuario borrado con el token vivo: sin empresas, sin locales y sin alcance global', async () => {
  escenario();
  const borrado = { sub: 'u-borrado', email: 'borrado@grupo.test', rol: 'Encargado' };

  const empresas = await empresasPermitidasDelUsuario(borrado);
  assert.ok(empresas instanceof Set, 'no debe devolver null (= sin restricción)');
  assert.equal(empresas.size, 0);
  assert.equal(facturaEmisorPermitido({ emisor_id: EMPRESA_NORTE }, empresas), false);

  assert.equal(await usuarioPuedeAccederLocal(borrado, '000010'), false);
  assert.equal(await usuarioPuedeAccederLocal(borrado, '000020'), false);
  assert.equal(await usuarioTieneAlcanceGlobal(borrado), false);
});

test('token sin id de usuario: restringido sin locales', async () => {
  const db = escenario();
  db.sembrar(tables.usuarios, { id_usuario: 'u-vacio', Email: 'grupo@test.com', Local: [], Rol: 'Encargado' });
  const sinId = { email: 'grupo@test.com', rol: 'Encargado' };
  assert.equal((await empresasPermitidasDelUsuario(sinId)).size, 0);
  assert.equal(await usuarioPuedeAccederLocal(sinId, '000010'), false);
  assert.equal(await usuarioTieneAlcanceGlobal(sinId), false);
});

test('Administrador por token sigue global aunque no tenga ficha', async () => {
  escenario();
  const admin = { sub: 'u-admin-borrado', email: 'admin@grupo.test', rol: 'Administrador' };
  assert.equal(await empresasPermitidasDelUsuario(admin), null);
  assert.equal(await usuarioPuedeAccederLocal(admin, '000020'), true);
  assert.equal(await usuarioTieneAlcanceGlobal(admin), true);
});

test('restringido a un local: accede al suyo, no al ajeno, y no es global', async () => {
  const db = escenario();
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: 'norte@grupo.test', Local: ['Local Norte'], Rol: 'Encargado' });
  const norte = { sub: 'u-norte', email: 'norte@grupo.test', rol: 'Encargado' };
  assert.equal(await usuarioPuedeAccederLocal(norte, '000010'), true);
  assert.equal(await usuarioPuedeAccederLocal(norte, 10), true);
  assert.equal(await usuarioPuedeAccederLocal(norte, '000020'), false);
  assert.equal(await usuarioTieneAlcanceGlobal(norte), false);
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
