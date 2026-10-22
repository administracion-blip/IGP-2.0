/**
 * Sincronizaciones manuales de Ágora: un usuario autenticado sin el permiso de
 * sincronización no puede lanzarlas. El planificador (req.isInternal) y el
 * Administrador sí pasan.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-sync-agora';
// Sin credenciales de Ágora, pasar el permiso deja la petición en la validación del handler (400/500).
delete process.env.AGORA_BASE_URL;
delete process.env.AGORA_API_BASE_URL;
delete process.env.AGORA_API_TOKEN;

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { default: agoraRouter } = await import('../routes/agora.js');

const CAMARERO = { sub: '000060', email: 'camarero@grupo.test', rol: 'Local' };
const OFICINA = { sub: '000061', email: 'oficina@grupo.test', rol: 'Oficina' };
const AJUSTES = { sub: '000062', email: 'ajustes@grupo.test', rol: 'Ajustes' };
const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };
const INTERNO = Symbol('interno');

const PERMISOS = {
  Local: ['cierres.ver', 'pedidos.ver', 'usuarios_agora.ver'],
  Oficina: ['usuarios_agora.sincronizar', 'formas_pago.editar'],
  Ajustes: [
    'ajustes.sincronizaciones.agora_usuarios',
    'ajustes.sincronizaciones.closeouts',
    'ajustes.sincronizaciones.ventas_producto',
  ],
};

let usuarioActual = CAMARERO;
let servidor = null;
let base = '';
let db = null;

async function api(ruta, usuario, body = {}) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual === INTERNO) req.isInternal = true;
      else req.user = usuarioActual;
      req.log = { info() {}, error() {}, warn() {} };
      next();
    });
    app.use('/api', agoraRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const [rol, lista] of Object.entries(PERMISOS)) {
    for (const p of lista) db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${p}` });
  }
}

function soloLecturasDePermisos() {
  return db.operaciones.every((o) => ['GetCommand', 'QueryCommand'].includes(o.tipo));
}

// Cuerpos que, superado el permiso, fallan en validación sin escribir nada.
const USERS = ['/api/agora/users/sync', { force: true }];
const PAYMENT = ['/api/agora/payment-methods/sync', {}];
const SALES = ['/api/agora/sales-lines/sync', { businessDay: 'no-es-fecha' }];
const SALES_FULL = ['/api/agora/sales-lines/full-sync', { fechaInicio: 'no-es-fecha' }];

test('users/sync: autenticado sin permiso de sincronización, 403 sin tocar Ágora ni Dynamo', async () => {
  montar();
  const r = await api(USERS[0], CAMARERO, USERS[1]);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Permiso insuficiente');
  assert.ok(soloLecturasDePermisos());
});

test('users/sync: pasa con usuarios_agora.sincronizar o ajustes.sincronizaciones.agora_usuarios', async () => {
  montar();
  for (const u of [OFICINA, AJUSTES, ADMIN, INTERNO]) {
    const r = await api(USERS[0], u, USERS[1]);
    assert.equal(r.status, 400, `debe llegar al handler (${String(u.rol || 'interno')})`);
    assert.match(r.body.error, /AGORA_API_BASE_URL/);
  }
});

test('payment-methods/sync: con solo cierres.ver, 403 sin escribir', async () => {
  montar();
  const r = await api(PAYMENT[0], CAMARERO, PAYMENT[1]);
  assert.equal(r.status, 403);
  assert.ok(soloLecturasDePermisos());
});

test('payment-methods/sync: pasa con formas_pago.editar o ajustes.sincronizaciones.closeouts', async () => {
  montar();
  for (const u of [OFICINA, AJUSTES, ADMIN, INTERNO]) {
    const r = await api(PAYMENT[0], u, PAYMENT[1]);
    assert.notEqual(r.status, 403, `no debe rechazar por permiso (${String(u.rol || 'interno')})`);
    assert.notEqual(r.status, 401);
  }
});

test('sales-lines/sync y full-sync: exigen ajustes.sincronizaciones.ventas_producto', async () => {
  montar();
  for (const [ruta, body] of [SALES, SALES_FULL]) {
    assert.equal((await api(ruta, CAMARERO, body)).status, 403, ruta);
    assert.equal((await api(ruta, OFICINA, body)).status, 403, ruta);
    assert.ok(soloLecturasDePermisos());
    for (const u of [AJUSTES, ADMIN, INTERNO]) {
      assert.equal((await api(ruta, u, body)).status, 400, `${ruta} (${String(u.rol || 'interno')})`);
    }
  }
});
