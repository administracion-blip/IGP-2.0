/**
 * Inventarios: plantillas, cabecera, líneas con decimales y los dos permisos.
 * No llama a Ágora.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-inventario';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { default: inventariosRouter } = await import('../routes/inventarios.js');
const { DEFINICION_TABLA_INVENTARIOS, NOMBRE_TABLA_INVENTARIOS } = await import('../scripts/crear-tabla-inventarios.mjs');

const CONTADOR = { sub: '000020', email: 'contador@test', rol: 'Contador' };
const COMPRAS = { sub: '000021', email: 'compras@test', rol: 'Compras' };
const LOCAL = { sub: '000022', email: 'local@test', rol: 'Local' };

let servidor = null;
let base = '';
let usuarioActual = COMPRAS;
let db = null;

async function api(metodo, ruta, cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      req.log = { info() {}, error() {}, warn() {} };
      next();
    });
    app.use('/api', inventariosRouter);
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

beforeEach(() => {
  usuarioActual = COMPRAS;
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.inventarios, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'WarehouseId-Clave-index': { hashKey: 'WarehouseId', rangeKey: 'Clave' },
    },
  });
  db.instalar(docClient);
  db.sembrar(tables.usuarios, { id_usuario: CONTADOR.sub, Rol: 'Contador', Locales: [], Email: CONTADOR.email });
  db.sembrar(tables.usuarios, { id_usuario: COMPRAS.sub, Rol: 'Compras', Locales: [], Email: COMPRAS.email });
  db.sembrar(tables.usuarios, { id_usuario: LOCAL.sub, Rol: 'Local', Locales: [], Email: LOCAL.email });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Contador', SK: 'PERMISO#inventario.contar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Compras', SK: 'PERMISO#inventario.gestionar' });
  invalidarContextoAcceso();
});

function sinScan() {
  assert.equal(db.operaciones.some((op) => op.tipo === 'ScanCommand'), false);
}

test('la tabla nueva es Igp_Inventarios, con PK/SK y el índice de almacén', () => {
  assert.equal(NOMBRE_TABLA_INVENTARIOS, 'Igp_Inventarios');
  assert.equal(DEFINICION_TABLA_INVENTARIOS.TableName, 'Igp_Inventarios');
  assert.deepEqual(
    DEFINICION_TABLA_INVENTARIOS.KeySchema.map((k) => `${k.AttributeName}:${k.KeyType}`),
    ['PK:HASH', 'SK:RANGE'],
  );
  const gsi = DEFINICION_TABLA_INVENTARIOS.GlobalSecondaryIndexes[0];
  assert.equal(gsi.IndexName, 'WarehouseId-Clave-index');
  assert.deepEqual(
    gsi.KeySchema.map((k) => `${k.AttributeName}:${k.KeyType}`),
    ['WarehouseId:HASH', 'Clave:RANGE'],
  );
});

test('sin permiso no se crea una plantilla; quien cuenta tampoco', async () => {
  usuarioActual = LOCAL;
  const sin = await api('POST', '/api/inventarios/plantillas', {
    warehouseId: '1', nombre: 'Botellas', modo: 'familias', miembros: [],
  });
  assert.equal(sin.status, 403);

  usuarioActual = CONTADOR;
  const cuenta = await api('POST', '/api/inventarios/plantillas', {
    warehouseId: '1', nombre: 'Botellas', modo: 'familias', miembros: [],
  });
  assert.equal(cuenta.status, 403);
  assert.equal(cuenta.body.error, 'Permiso insuficiente');

  const familias = await api('GET', '/api/inventarios/familias');
  assert.equal(familias.status, 403);
});

test('plantilla por almacén: familias, listado y borrado', async () => {
  const creada = await api('POST', '/api/inventarios/plantillas', {
    warehouseId: '1',
    nombre: 'Botellas',
    modo: 'familias',
    miembros: [{ id: '12', nombre: 'BOT WHISKYS' }],
  });
  assert.equal(creada.status, 201);
  assert.equal(creada.body.warehouseId, '000001');
  assert.equal(creada.body.numMiembros, 1);
  assert.deepEqual(creada.body.miembros, [{ id: '12', nombre: 'BOT WHISKYS' }]);

  const otra = await api('POST', '/api/inventarios/plantillas', {
    warehouseId: '2', nombre: 'Otra', modo: 'productos', miembros: [{ id: '1367', nombre: 'Whisky' }],
  });
  assert.equal(otra.status, 201);

  const lista = await api('GET', '/api/inventarios/plantillas?warehouseId=1');
  assert.equal(lista.status, 200);
  assert.deepEqual(lista.body.plantillas.map((p) => p.nombre), ['Botellas']);
  assert.equal(lista.body.plantillas[0].miembros, undefined);
  assert.equal(lista.body.plantillas[0].numMiembros, 1);

  const una = await api('GET', `/api/inventarios/plantillas/${creada.body.plantillaId}`);
  assert.equal(una.body.modo, 'familias');

  const mixta = await api('PUT', `/api/inventarios/plantillas/${creada.body.plantillaId}`, {
    modo: 'productos',
  });
  assert.equal(mixta.status, 400);

  const editada = await api('PUT', `/api/inventarios/plantillas/${creada.body.plantillaId}`, {
    miembros: [{ id: '12', nombre: 'BOT WHISKYS' }, { id: '13', nombre: 'GINEBRAS' }],
  });
  assert.equal(editada.status, 200);
  assert.equal(editada.body.numMiembros, 2);
  assert.deepEqual(editada.body.miembros.map((m) => m.id), ['12', '13']);

  const borrada = await api('DELETE', `/api/inventarios/plantillas/${creada.body.plantillaId}`);
  assert.equal(borrada.status, 200);
  const yaNo = await api('GET', `/api/inventarios/plantillas/${creada.body.plantillaId}`);
  assert.equal(yaNo.status, 404);
  sinScan();
});

test('el stock real se guarda con decimales y el conteo no cambia el teórico', async () => {
  const plantilla = await api('POST', '/api/inventarios/plantillas', {
    warehouseId: '1', nombre: 'Botellas', modo: 'familias', miembros: [{ id: '12', nombre: 'BOT WHISKYS' }],
  });
  const creado = await api('POST', '/api/inventarios', {
    warehouseId: '1',
    fecha: '2026-10-25',
    employeeId: '42',
    employeeNombre: 'Ana',
    plantillaId: plantilla.body.plantillaId,
    lineas: [{
      productId: '1367',
      nombre: 'BOT JOHNNIE WALKER RED',
      familiaNombre: 'BOT WHISKYS',
      unidad: 'Unidad',
      stockTeorico: 203,
      stockReal: '10,5',
      botellasAbiertas: '0,25',
    }],
  });
  assert.equal(creado.status, 201);
  assert.equal(creado.body.estado, 'borrador');
  assert.equal(creado.body.warehouseId, '000001');
  const linea = creado.body.lineas[0];
  assert.equal(linea.stockTeorico, 203);
  assert.equal(linea.stockReal, 10.5);
  assert.equal(linea.botellasAbiertas, 0.25);
  assert.equal(creado.body.lineas[0].codigoBarras, undefined);
  assert.equal(creado.body.lineas[0].ubicacion, undefined);

  usuarioActual = CONTADOR;
  const contada = await api('PUT', `/api/inventarios/${creado.body.inventarioId}/lineas/1367`, {
    stockTeorico: 1,
    stockReal: 8.75,
    botellasAbiertas: 0.9,
  });
  assert.equal(contada.status, 200);
  assert.equal(contada.body.stockTeorico, 203);
  assert.equal(contada.body.stockReal, 8.75);
  assert.equal(contada.body.botellasAbiertas, 0.9);

  const mala = await api('PUT', `/api/inventarios/${creado.body.inventarioId}/lineas/1367`, {
    botellasAbiertas: 0.33,
  });
  assert.equal(mala.status, 400);

  const contado = await api('PATCH', `/api/inventarios/${creado.body.inventarioId}/estado`, { estado: 'contado' });
  assert.equal(contado.status, 200);
  assert.equal(contado.body.estado, 'contado');

  const noRevisa = await api('PATCH', `/api/inventarios/${creado.body.inventarioId}/estado`, { estado: 'revisado' });
  assert.equal(noRevisa.status, 403);

  usuarioActual = COMPRAS;
  const revisado = await api('PATCH', `/api/inventarios/${creado.body.inventarioId}/estado`, { estado: 'revisado' });
  assert.equal(revisado.status, 200);
  const exportado = await api('PATCH', `/api/inventarios/${creado.body.inventarioId}/estado`, { estado: 'exportado' });
  assert.equal(exportado.status, 200);
  const importado = await api('PATCH', `/api/inventarios/${creado.body.inventarioId}/estado`, { estado: 'importado' });
  assert.equal(importado.status, 200);

  const bloqueada = await api('PUT', `/api/inventarios/${creado.body.inventarioId}/lineas/1367`, { stockReal: 1 });
  assert.equal(bloqueada.status, 409);

  const lista = await api('GET', '/api/inventarios?warehouseId=1');
  assert.equal(lista.body.inventarios.length, 1);
  assert.equal(lista.body.inventarios[0].estado, 'importado');
  assert.equal(lista.body.inventarios[0].lineas, undefined);
  sinScan();
});

test('un conteo que llega tarde no reabre un inventario importado', async () => {
  const plantilla = await api('POST', '/api/inventarios/plantillas', {
    warehouseId: '1', nombre: 'Botellas', modo: 'familias', miembros: [],
  });
  const creado = await api('POST', '/api/inventarios', {
    warehouseId: '1',
    fecha: '2026-10-25',
    employeeId: '42',
    employeeNombre: 'Ana',
    plantillaId: plantilla.body.plantillaId,
    lineas: [{ productId: '1367', nombre: 'Whisky', stockTeorico: 203, stockReal: 10.5, botellasAbiertas: 0.25 }],
  });
  const id = creado.body.inventarioId;
  db.interceptar('UpdateCommand', tables.inventarios, () => {
    const clave = { PK: `INV#${id}`, SK: 'META' };
    const meta = db.obtener(tables.inventarios, clave);
    db.sembrar(tables.inventarios, { ...meta, estado: 'importado' });
  });
  usuarioActual = CONTADOR;
  const tarde = await api('PUT', `/api/inventarios/${id}/lineas/1367`, { stockReal: 1, stockTeorico: 0 });
  assert.equal(tarde.status, 409);
  usuarioActual = COMPRAS;
  const leido = await api('GET', `/api/inventarios/${id}`);
  assert.equal(leido.body.estado, 'importado');
  assert.equal(leido.body.lineas[0].stockReal, 10.5);
  assert.equal(leido.body.lineas[0].stockTeorico, 203);
});

test('borrar no se lleva un inventario que acaba de marcarse importado', async () => {
  const plantilla = await api('POST', '/api/inventarios/plantillas', {
    warehouseId: '1', nombre: 'Botellas', modo: 'familias', miembros: [],
  });
  const creado = await api('POST', '/api/inventarios', {
    warehouseId: '1',
    fecha: '2026-10-25',
    employeeId: '42',
    employeeNombre: 'Ana',
    plantillaId: plantilla.body.plantillaId,
    lineas: [{ productId: '1367', nombre: 'Whisky', stockTeorico: 203, stockReal: 4 }],
  });
  const id = creado.body.inventarioId;
  for (const estado of ['contado', 'revisado', 'exportado']) {
    const paso = await api('PATCH', `/api/inventarios/${id}/estado`, { estado });
    assert.equal(paso.status, 200, paso.body.error);
  }
  db.interceptar('DeleteCommand', tables.inventarios, (entrada) => {
    if (entrada.Key?.SK !== 'META') return;
    const meta = db.obtener(tables.inventarios, entrada.Key);
    db.sembrar(tables.inventarios, { ...meta, estado: 'importado' });
  });
  const borrado = await api('DELETE', `/api/inventarios/${id}`);
  assert.equal(borrado.status, 409);
  const leido = await api('GET', `/api/inventarios/${id}`);
  assert.equal(leido.body.estado, 'importado');
  assert.equal(leido.body.lineas[0].productId, '1367');
});

test('si se corta el guardado de una plantilla, no se quedan las familias a cero', async () => {
  const creada = await api('POST', '/api/inventarios/plantillas', {
    warehouseId: '1',
    nombre: 'Botellas',
    modo: 'familias',
    miembros: [{ id: '12', nombre: 'BOT WHISKYS' }, { id: '13', nombre: 'GINEBRAS' }],
  });
  db.interceptar('PutCommand', tables.inventarios, (entrada) => {
    if (entrada.Item?.SK === 'FAMILIA#14') throw new Error('corte');
  });
  const rota = await api('PUT', `/api/inventarios/plantillas/${creada.body.plantillaId}`, {
    miembros: [
      { id: '14', nombre: 'RONES' },
      { id: '12', nombre: 'BOT WHISKYS' },
      { id: '13', nombre: 'GINEBRAS' },
    ],
  });
  assert.equal(rota.status, 400);
  const leida = await api('GET', `/api/inventarios/plantillas/${creada.body.plantillaId}`);
  assert.deepEqual(leida.body.miembros.map((m) => m.id), ['12', '13']);
});
