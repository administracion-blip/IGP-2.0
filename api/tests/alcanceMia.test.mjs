/**
 * Aislamiento por local en MIA. Un comprador con todos los permisos de MIA y solo
 * «Bar Centro» (dueño del almacén 000101) intenta configurar el calendario de
 * «Bar Sur», calcular, ajustar y aprobar informes del almacén de «Bar Sur»
 * (000202), y leer ambos.
 *
 * El almacén se traduce a sus locales con el mapa local ↔ almacén (`almacen origen`).
 */

import test, { after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alcance-mia';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: miaRouter } = await import('../routes/mia.js');

const COMPRADOR = { sub: '000080', email: 'compras@grupo.test', rol: 'SuperUser' };
const OFICINA = { sub: '000081', email: 'oficina@grupo.test', rol: 'SuperUser' };

const MODO_ORIGINAL = process.env.ALCANCE_MODO_LECTURAS;
function modo(valor) {
  if (valor === undefined) delete process.env.ALCANCE_MODO_LECTURAS;
  else process.env.ALCANCE_MODO_LECTURAS = valor;
}
afterEach(() => modo(MODO_ORIGINAL));

let usuarioActual = COMPRADOR;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario = COMPRADOR) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      req.log = { info() {}, error() {}, warn() {} };
      next();
    });
    app.use('/api', miaRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function conAvisos(fn) {
  const avisos = [];
  const original = console.warn;
  console.warn = (...args) => {
    if (args[0] === '[alcance] denegaría') avisos.push(args[1]);
  };
  try {
    return { r: await fn(), avisos };
  } finally {
    console.warn = original;
  }
}

const DIAS = [true, false, false, false, false, false, false];
let db = null;

function informe(id, warehouseId) {
  return {
    PK: `INFORME#${id}`,
    SK: 'META',
    informeId: id,
    WarehouseId: warehouseId,
    estado: 'calculado',
    creadoEn: '2026-10-01T10:00:00.000Z',
  };
}

function linea(id) {
  return { PK: `INFORME#${id}`, SK: 'LINE#PROV1#P1', informeId: id, proveedorId: 'PROV1', productId: 'P1', qty: 2, cantidadPedida: 2, costeUnitario: 1 };
}

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaCalendarioPedidos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaInformes, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'WarehouseId-CreadoEn-index': { hashKey: 'WarehouseId', rangeKey: 'creadoEn' } },
  });
  db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaConfigProducto, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const p of ['ver', 'configurar', 'calcular', 'aprobar']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#SuperUser', SK: `PERMISO#mia.${p}` });
  }
  db.sembrar(tables.almacenes, { Id: '101', Nombre: 'Almacen Centro' });
  db.sembrar(tables.almacenes, { Id: '202', Nombre: 'Almacen Sur' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur', 'almacen origen': 'Almacen Sur' });
  db.sembrar(tables.usuarios, { id_usuario: '000080', Email: COMPRADOR.email, Rol: 'SuperUser', Local: ['Bar Centro'] });
  db.sembrar(tables.usuarios, { id_usuario: '000081', Email: OFICINA.email, Rol: 'SuperUser', Local: [] });
  for (const [lid, nombre] of [['000010', 'Bar Centro'], ['000020', 'Bar Sur']]) {
    db.sembrar(tables.miaCalendarioPedidos, {
      PK: `LOCAL#${lid}`, SK: 'PROVEEDOR#PROV1', LocalId: lid, LocalNombre: nombre, ProveedorId: 'PROV1', diasSemana: DIAS, activo: true,
    });
  }
  db.sembrar(tables.miaInformes, informe('inf-centro', '000101'));
  db.sembrar(tables.miaInformes, informe('inf-sur', '000202'));
  db.sembrar(tables.miaInformeLineas, linea('inf-centro'));
  db.sembrar(tables.miaInformeLineas, linea('inf-sur'));
  invalidarContextoAcceso();
  invalidarMaestroLocales();
}

// ─── Escrituras y acciones: bloquean ───

test('calendario de un local ajeno: PUT y DELETE 403 sin cambios', async () => {
  montar();
  const antes = db.listar(tables.miaCalendarioPedidos);
  const put = await api('PUT', '/api/mia/calendario', { localId: '000020', proveedorId: 'PROV2', diasSemana: DIAS });
  assert.equal(put.status, 403);
  assert.equal(put.body.error, 'No tienes acceso a este local');
  const del = await api('DELETE', '/api/mia/calendario?localId=000020&proveedorId=PROV1');
  assert.equal(del.status, 403);
  assert.deepEqual(db.listar(tables.miaCalendarioPedidos), antes);
});

test('calendario del propio local: PUT y DELETE funcionan', async () => {
  montar();
  assert.equal((await api('PUT', '/api/mia/calendario', { localId: '000010', proveedorId: 'PROV2', diasSemana: DIAS })).status, 200);
  assert.ok(db.obtener(tables.miaCalendarioPedidos, { PK: 'LOCAL#000010', SK: 'PROVEEDOR#PROV2' }));
  assert.equal((await api('DELETE', '/api/mia/calendario?localId=000010&proveedorId=PROV1')).status, 200);
  assert.equal(db.obtener(tables.miaCalendarioPedidos, { PK: 'LOCAL#000010', SK: 'PROVEEDOR#PROV1' }), null);
});

test('calcular para un almacén ajeno o sin local: 403 sin crear informe', async () => {
  montar();
  const antes = db.listar(tables.miaInformes).length;
  for (const warehouseId of ['202', '999']) {
    const r = await api('POST', '/api/mia/calcular', { warehouseId, fechaDesde: '2026-10-01', fechaHasta: '2026-10-07' });
    assert.equal(r.status, 403, warehouseId);
  }
  assert.equal(db.listar(tables.miaInformes).length, antes);
});

test('ajustar líneas y aprobar un informe de un almacén ajeno: 403 y el informe queda igual', async () => {
  montar();
  const meta = db.obtener(tables.miaInformes, { PK: 'INFORME#inf-sur', SK: 'META' });
  const lin = db.obtener(tables.miaInformeLineas, { PK: 'INFORME#inf-sur', SK: 'LINE#PROV1#P1' });
  const ajuste = await api('PATCH', '/api/mia/informes/inf-sur/lineas', { lineas: [{ productId: 'P1', proveedorId: 'PROV1', cantidadPedida: 50 }] });
  assert.equal(ajuste.status, 403);
  const aprobar = await api('POST', '/api/mia/informes/inf-sur/aprobar', {});
  assert.equal(aprobar.status, 403);
  assert.deepEqual(db.obtener(tables.miaInformes, { PK: 'INFORME#inf-sur', SK: 'META' }), meta);
  assert.deepEqual(db.obtener(tables.miaInformeLineas, { PK: 'INFORME#inf-sur', SK: 'LINE#PROV1#P1' }), lin);
});

test('ajustar líneas de un informe de su almacén funciona; con alcance global también el ajeno', async () => {
  montar();
  const propio = await api('PATCH', '/api/mia/informes/inf-centro/lineas', { lineas: [{ productId: 'P1', proveedorId: 'PROV1', cantidadPedida: 5 }] });
  assert.equal(propio.status, 200);
  assert.equal(db.obtener(tables.miaInformeLineas, { PK: 'INFORME#inf-centro', SK: 'LINE#PROV1#P1' }).cantidadPedida, 5);
  const global = await api('PATCH', '/api/mia/informes/inf-sur/lineas', { lineas: [{ productId: 'P1', proveedorId: 'PROV1', cantidadPedida: 7 }] }, OFICINA);
  assert.equal(global.status, 200);
});

test('config de producto de un almacén ajeno o sin local: PUT 403 sin escribir; el propio y el global sí', async () => {
  montar();
  for (const warehouseId of ['202', '999']) {
    const r = await api('PUT', '/api/mia/config', { warehouseId, productId: 'P1', colchon: 9 });
    assert.equal(r.status, 403, warehouseId);
    assert.equal(r.body.error, 'No tienes acceso a este local');
  }
  assert.deepEqual(db.listar(tables.miaConfigProducto), []);
  assert.equal((await api('PUT', '/api/mia/config', { productId: 'P1', colchon: 9 })).status, 400);

  assert.equal((await api('PUT', '/api/mia/config', { warehouseId: '101', productId: 'P1', colchon: 3 })).status, 200);
  assert.equal((await api('PUT', '/api/mia/config', { warehouseId: '202', productId: 'P1', colchon: 4 }, OFICINA)).status, 200);
  assert.deepEqual(db.listar(tables.miaConfigProducto).map((i) => [i.WarehouseId, i.colchon]).sort(), [['000101', 3], ['000202', 4]]);
});

test('GET config de un almacén ajeno: observar sirve con aviso; bloquear 403', async () => {
  montar();
  db.sembrar(tables.miaConfigProducto, { PK: 'WAREHOUSE#000202', SK: 'PRODUCT#P1', WarehouseId: '000202', ProductId: 'P1' });
  modo(undefined);
  const obs = await conAvisos(() => api('GET', '/api/mia/config?warehouseId=202'));
  assert.equal(obs.r.status, 200);
  assert.equal(obs.r.body.items.length, 1);
  assert.equal(obs.avisos.length, 1);
  modo('bloquear');
  const r = await api('GET', '/api/mia/config?warehouseId=202');
  assert.equal(r.status, 403);
  assert.equal(r.body.items, undefined);
  assert.equal((await api('GET', '/api/mia/config?warehouseId=202', undefined, OFICINA)).body.items.length, 1);
});

// ─── Lecturas ───

test('lecturas en observar: calendario, informes e informe ajenos se sirven con aviso', async () => {
  montar();
  modo(undefined);
  const cal = await conAvisos(() => api('GET', '/api/mia/calendario?localId=000020'));
  assert.equal(cal.r.status, 200);
  assert.equal(cal.r.body.items.length, 1);
  assert.equal(cal.avisos.length, 1);

  const inf = await conAvisos(() => api('GET', '/api/mia/informes?warehouseId=202'));
  assert.equal(inf.r.status, 200);
  assert.deepEqual(inf.r.body.items.map((i) => i.informeId), ['inf-sur']);
  assert.equal(inf.avisos.length, 1);

  const uno = await conAvisos(() => api('GET', '/api/mia/informes/inf-sur'));
  assert.equal(uno.r.status, 200);
  assert.equal(uno.avisos.length, 1);
});

test('lecturas en bloquear: local o almacén ajeno 403; propio y global sin cambios', async () => {
  montar();
  modo('bloquear');
  assert.equal((await api('GET', '/api/mia/calendario?localId=000020')).status, 403);
  assert.equal((await api('GET', '/api/mia/informes?warehouseId=202')).status, 403);
  const uno = await api('GET', '/api/mia/informes/inf-sur');
  assert.equal(uno.status, 403);
  assert.equal(uno.body.lineas, undefined);

  assert.equal((await api('GET', '/api/mia/calendario?localId=000010')).body.items.length, 1);
  assert.deepEqual((await api('GET', '/api/mia/informes?warehouseId=101')).body.items.map((i) => i.informeId), ['inf-centro']);
  assert.equal((await api('GET', '/api/mia/informes/inf-sur', undefined, OFICINA)).status, 200);
});

test('calendario por almacén: observar todo con aviso; bloquear solo sus locales', async () => {
  montar();
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Sur' });
  modo(undefined);
  const obs = await conAvisos(() => api('GET', '/api/mia/calendario?warehouseId=202'));
  assert.deepEqual(obs.r.body.items.map((i) => i.LocalId).sort(), ['000010', '000020']);
  assert.equal(obs.avisos.length, 1);
  modo('bloquear');
  const r = await api('GET', '/api/mia/calendario?warehouseId=202');
  assert.deepEqual(r.body.items.map((i) => i.LocalId), ['000010']);
});
