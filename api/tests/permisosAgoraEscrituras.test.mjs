/**
 * Sincronizaciones y escrituras de agora.js que antes no pedían permiso.
 * Sin permiso: 403 y ni se llama a Ágora ni se escribe. Con permiso, Administrador
 * o llamada interna del scheduler: pasa.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-escrituras-agora';
delete process.env.AGORA_BASE_URL;
process.env.AGORA_API_BASE_URL = 'http://agora.falso';
process.env.AGORA_API_TOKEN = 'token-de-prueba';

const llamadasAgora = [];
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, opciones) => {
  const u = String(url);
  if (!u.startsWith('http://agora.falso')) return fetchReal(url, opciones);
  llamadasAgora.push(u);
  return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { INTERNAL_SYNC_POST_PATHS } = await import('../lib/internalSync.js');
const { default: agoraRouter } = await import('../routes/agora.js');

const LOCAL = { sub: '000050', email: 'local@grupo.test', rol: 'Local' };
const SUPER = { sub: '000051', email: 'super@grupo.test', rol: 'SuperUser' };
const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };
const INTERNO = 'interno';

// Como en la BD real: Local ve productos/puntos de venta/almacenes pero no los edita.
const PERMISOS = {
  Local: ['productos.ver', 'puntos_venta.ver', 'almacenes.ver', 'planning_dia.ver'],
  SuperUser: ['productos.ver', 'productos.editar', 'objetivos.ver', 'puntos_venta.editar', 'almacenes.sincronizar'],
};

let usuarioActual = LOCAL;
let servidor = null;
let base = '';
let db = null;

async function api(metodo, ruta, usuario, body) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual === INTERNO) req.isInternal = true;
      else req.user = usuarioActual;
      next();
    });
    app.use('/api', agoraRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetchReal(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
  globalThis.fetch = fetchReal;
});

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.saleCenters, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.franjasHorarias, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.instalar(docClient);
  for (const [rol, lista] of Object.entries(PERMISOS)) {
    for (const p of lista) db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${p}` });
  }
  db.sembrar(tables.agoraProducts, { PK: 'GLOBAL', SK: '7', Id: 7, Nombre: 'Caña', IGP: false });
  db.sembrar(tables.saleCenters, { PK: 'GLOBAL', SK: '3', Id: 3, Nombre: 'Barra', Activo: true });
  db.sembrar(tables.franjasHorarias, { PK: 'GLOBAL', SK: 'p_1', nombre: 'Tarde', franjas: [] });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  llamadasAgora.length = 0;
  return db;
}

function escrituras() {
  return db.operaciones.filter((o) => ['DeleteCommand', 'BatchWriteCommand', 'PutCommand', 'UpdateCommand'].includes(o.tipo));
}

function sinEfecto(r) {
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Permiso insuficiente');
  assert.equal(llamadasAgora.length, 0, 'no se llama a Ágora');
  assert.equal(escrituras().length, 0, 'no se escribe nada');
}

// ─── Sincronizaciones ───

test('sale-centers/sync: sin puntos_venta.editar 403 sin llamar a Ágora; con él, admin o interno pasa', async () => {
  montar();
  sinEfecto(await api('POST', '/api/agora/sale-centers/sync', LOCAL, {}));
  for (const quien of [SUPER, ADMIN, INTERNO]) {
    llamadasAgora.length = 0;
    const r = await api('POST', '/api/agora/sale-centers/sync', quien, {});
    assert.notEqual(r.status, 403);
    assert.ok(llamadasAgora.length > 0, 'llega a Ágora');
  }
});

test('warehouses/sync: sin permiso de sync 403 sin llamar a Ágora; con él, admin o interno pasa', async () => {
  montar();
  sinEfecto(await api('POST', '/api/agora/warehouses/sync', LOCAL));
  for (const quien of [SUPER, ADMIN, INTERNO]) {
    llamadasAgora.length = 0;
    const r = await api('POST', '/api/agora/warehouses/sync', quien);
    assert.equal(r.status, 200);
    assert.equal(llamadasAgora.length, 1);
  }
});

test('el scheduler entra como interno en warehouses/sync', () => {
  assert.ok(INTERNAL_SYNC_POST_PATHS.has('/api/agora/warehouses/sync'));
});

test('purchases/sync: sin permiso de sync de compras 403 sin llamar a Ágora ni purgar', async () => {
  montar();
  sinEfecto(await api('POST', '/api/agora/purchases/sync', LOCAL, {}));
  sinEfecto(await api('POST', '/api/agora/purchases/sync', SUPER, {}));
  assert.ok(INTERNAL_SYNC_POST_PATHS.has('/api/agora/purchases/sync'));
});

// ─── Escrituras ───

test('sale-centers PATCH: sin puntos_venta.editar 403 y no cambia Activo', async () => {
  montar();
  sinEfecto(await api('PATCH', '/api/agora/sale-centers', LOCAL, { id: '3', Activo: false }));
  assert.equal(db.obtener(tables.saleCenters, { PK: 'GLOBAL', SK: '3' }).Activo, true);
  assert.equal((await api('PATCH', '/api/agora/sale-centers', SUPER, { id: '3', Activo: false })).status, 200);
  assert.equal(db.obtener(tables.saleCenters, { PK: 'GLOBAL', SK: '3' }).Activo, false);
});

test('products PATCH (ficha, IGP y zona): sin productos.editar 403', async () => {
  montar();
  sinEfecto(await api('PATCH', '/api/agora/products/7', LOCAL, { Nombre: 'Otro' }));
  sinEfecto(await api('PATCH', '/api/agora/products/igp/batch', LOCAL, { updates: [{ id: '7', IGP: true }] }));
  sinEfecto(await api('PATCH', '/api/agora/products/zona/batch', LOCAL, { ids: ['7'], Zona: 'B' }));
  assert.equal(db.obtener(tables.agoraProducts, { PK: 'GLOBAL', SK: '7' }).IGP, false);

  assert.equal((await api('PATCH', '/api/agora/products/igp/batch', SUPER, { updates: [{ id: '7', IGP: true }] })).status, 200);
  assert.equal(db.obtener(tables.agoraProducts, { PK: 'GLOBAL', SK: '7' }).IGP, true);
  assert.equal((await api('PATCH', '/api/agora/products/zona/batch', ADMIN, { ids: ['7'], Zona: 'B' })).status, 200);
  assert.equal(db.obtener(tables.agoraProducts, { PK: 'GLOBAL', SK: '7' }).Zona, 'B');
});

test('franjas-plantillas: crear, editar y borrar exigen objetivos.ver', async () => {
  montar();
  const plantilla = { nombre: 'Noche', franjas: [{ desde: '20:00', hasta: '23:00' }] };
  const sinPermiso = { sub: '000060', email: 'mkt@grupo.test', rol: 'Marketing' };
  sinEfecto(await api('POST', '/api/agora/franjas-plantillas', sinPermiso, plantilla));
  sinEfecto(await api('PUT', '/api/agora/franjas-plantillas', sinPermiso, { ...plantilla, plantillaId: 'p_1' }));
  sinEfecto(await api('DELETE', '/api/agora/franjas-plantillas?plantillaId=p_1', sinPermiso));
  assert.equal(db.obtener(tables.franjasHorarias, { PK: 'GLOBAL', SK: 'p_1' }).nombre, 'Tarde');

  assert.equal((await api('POST', '/api/agora/franjas-plantillas', SUPER, plantilla)).status, 200);
  assert.equal((await api('PUT', '/api/agora/franjas-plantillas', SUPER, { ...plantilla, plantillaId: 'p_1' })).status, 200);
  assert.equal(db.obtener(tables.franjasHorarias, { PK: 'GLOBAL', SK: 'p_1' }).nombre, 'Noche');
  assert.equal((await api('DELETE', '/api/agora/franjas-plantillas?plantillaId=p_1', SUPER)).status, 200);
  assert.equal(db.obtener(tables.franjasHorarias, { PK: 'GLOBAL', SK: 'p_1' }), null);
});
