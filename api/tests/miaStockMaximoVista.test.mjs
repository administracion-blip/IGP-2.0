/**
 * Vista de stock máximo: decimales, unidad real de Ágora, filtros y alcance.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-stock-maximo';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { invalidarPermisosRol } = await import('../lib/permisos/cachePermisos.js');
const {
  MENSAJE_MAXIMO,
  MENSAJE_MAXIMO_NEGATIVO,
  MENSAJE_UNIDAD,
  MENSAJE_UNIDAD_LIBRE,
} = await import('../lib/mia/stockMaximo.js');
const { default: miaRouter } = await import('../routes/mia.js');

const COMPRADOR = { sub: '000080', email: 'compras@grupo.test', rol: 'SuperUser' };
const CAMARERO = { sub: '000082', email: 'sala@grupo.test', rol: 'Camarero' };

let usuarioActual = COMPRADOR;
let servidor = null;
let base = '';
let db = null;

async function asegurarServidor() {
  if (servidor) return;
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

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaConfigProducto, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const p of ['ver', 'configurar']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#SuperUser', SK: `PERMISO#mia.${p}` });
  }
  db.sembrar(tables.almacenes, { Id: '101', Nombre: 'Almacen Centro' });
  db.sembrar(tables.almacenes, { Id: '202', Nombre: 'Almacen Sur' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur', 'almacen origen': 'Almacen Sur' });
  db.sembrar(tables.usuarios, { id_usuario: '000080', Email: COMPRADOR.email, Rol: 'SuperUser', Local: ['Bar Centro'] });
  db.sembrar(tables.usuarios, { id_usuario: '000082', Email: CAMARERO.email, Rol: 'Camarero', Local: ['Bar Centro'] });
  db.sembrar(tables.agoraProducts, {
    PK: 'GLOBAL', SK: '501', Id: 501, Name: 'Tonica', FamilyId: '01', FamilyName: 'Bebidas',
    BaseSaleFormatId: '10', FormatoBaseNombre: 'Botella',
    AdditionalSaleFormats: [{ Id: '11', Name: 'Caja' }],
  });
  db.sembrar(tables.agoraProducts, {
    PK: 'GLOBAL', SK: '502', Id: 502, Name: 'Agua', FamilyId: '01', FamilyName: 'Bebidas',
    BaseSaleFormatId: '20', FormatoBaseNombre: 'Botella',
  });
  db.sembrar(tables.agoraProducts, {
    PK: 'GLOBAL', SK: '503', Id: 503, Name: 'Pan', FamilyId: '02', FamilyName: 'Comida',
    BaseSaleFormatId: '30', FormatoBaseNombre: 'Barra',
  });
  db.sembrar(tables.miaConfigProducto, {
    PK: 'WAREHOUSE#000101', SK: 'PRODUCT#501', WarehouseId: '000101', ProductId: '501',
    Quantity: 4, maximo: 10, purchaseUnitId: '10', purchaseUnitName: 'Botella', formatoCompra: 6,
  });
  db.sembrar(tables.miaConfigProducto, {
    PK: 'WAREHOUSE#000101', SK: 'PRODUCT#502', WarehouseId: '000101', ProductId: '502', Quantity: 2,
  });
  db.sembrar(tables.miaConfigProducto, {
    PK: 'WAREHOUSE#000101', SK: 'PRODUCT#503', WarehouseId: '000101', ProductId: '503', Quantity: 8, maximo: 2,
  });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  invalidarPermisosRol();
}

async function api(metodo, ruta, cuerpo, usuario = COMPRADOR) {
  await asegurarServidor();
  usuarioActual = usuario;
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function cfg(productId) {
  return db.obtener(tables.miaConfigProducto, { PK: 'WAREHOUSE#000101', SK: `PRODUCT#${productId}` });
}

test('lista con nombre, familia y unidades, y pagina', async () => {
  montar();
  const r = await api('GET', '/api/mia/stock-maximo?warehouseId=101&limit=2');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 3);
  assert.equal(r.body.items.length, 2);
  const tonica = (await api('GET', '/api/mia/stock-maximo?warehouseId=101&q=toni')).body.items[0];
  assert.equal(tonica.nombre, 'Tonica');
  assert.equal(tonica.familiaNombre, 'Bebidas');
  assert.deepEqual(tonica.unidades.map((u) => u.id).sort(), ['10', '11']);
  const comida = await api('GET', '/api/mia/stock-maximo?warehouseId=101&familia=02');
  assert.deepEqual(comida.body.items.map((i) => i.productId), ['503']);
  const sin = await api('GET', '/api/mia/stock-maximo?warehouseId=101&sinMaximo=1');
  assert.deepEqual(sin.body.items.map((i) => i.productId), ['502']);
  assert.equal(sin.body.items[0].sinMaximo, true);
});

test('guarda decimales y la unidad de Ágora; rechaza negativo y texto libre', async () => {
  montar();
  const ok = await api('PUT', '/api/mia/stock-maximo', {
    warehouseId: '101',
    lineas: [{ productId: '501', maximo: '1,5', formatoCompra: 6, purchaseUnitId: '11', purchaseUnitName: 'Inventada' }],
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(cfg('501').maximo, 1.5);
  assert.equal(cfg('501').purchaseUnitId, '11');
  assert.equal(cfg('501').purchaseUnitName, 'Caja');

  const negativo = await api('PUT', '/api/mia/stock-maximo', {
    warehouseId: '101',
    lineas: [{ productId: '501', maximo: -0.2, formatoCompra: 6, purchaseUnitId: '11' }],
  });
  assert.equal(negativo.status, 400);
  assert.equal(negativo.body.error, MENSAJE_MAXIMO_NEGATIVO);
  assert.equal(cfg('501').maximo, 1.5);

  const basura = await api('PUT', '/api/mia/config', { warehouseId: '101', productId: '501', maximo: 'abc' });
  assert.equal(basura.status, 400);
  assert.equal(basura.body.error, MENSAJE_MAXIMO);

  const ajena = await api('PUT', '/api/mia/stock-maximo', {
    warehouseId: '101',
    lineas: [{ productId: '501', maximo: 2, purchaseUnitId: '99', purchaseUnitName: 'Saco' }],
  });
  assert.equal(ajena.status, 400);
  assert.equal(ajena.body.error, MENSAJE_UNIDAD);
  assert.equal(cfg('501').purchaseUnitId, '11');
  assert.equal(cfg('501').maximo, 1.5);

  const libre = await api('PUT', '/api/mia/config', {
    warehouseId: '101', productId: '501', purchaseUnitName: 'A mano',
  });
  assert.equal(libre.status, 400);
  assert.equal(libre.body.error, MENSAJE_UNIDAD_LIBRE);
  assert.equal(cfg('501').purchaseUnitName, 'Caja');

  const vacio = await api('PUT', '/api/mia/stock-maximo', {
    warehouseId: '101',
    lineas: [{ productId: '502', maximo: '', formatoCompra: '', purchaseUnitId: '' }],
  });
  assert.equal(vacio.status, 200, JSON.stringify(vacio.body));
  assert.equal(cfg('502').maximo, undefined);
});

test('sin permiso o con almacén ajeno: 403 y no escribe', async () => {
  montar();
  const lectura = await api('GET', '/api/mia/stock-maximo?warehouseId=101', undefined, CAMARERO);
  assert.equal(lectura.status, 403);
  assert.equal(lectura.body.error, 'Permiso insuficiente');
  const escritura = await api('PUT', '/api/mia/stock-maximo', {
    warehouseId: '101',
    lineas: [{ productId: '501', maximo: 9, purchaseUnitId: '10' }],
  }, CAMARERO);
  assert.equal(escritura.status, 403);
  const ajeno = await api('GET', '/api/mia/stock-maximo?warehouseId=202');
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.body.error, 'No tienes acceso a este local');
  const ajenoPut = await api('PUT', '/api/mia/stock-maximo', {
    warehouseId: '202',
    lineas: [{ productId: '501', maximo: 9, purchaseUnitId: '10' }],
  });
  assert.equal(ajenoPut.status, 403);
  assert.equal(cfg('501').maximo, 10);
});
