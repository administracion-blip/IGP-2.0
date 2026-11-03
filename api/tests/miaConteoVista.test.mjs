/**
 * Vista del conteo de stock máximo: lista, edición manual y alcance.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-conteo-mia';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { invalidarPermisosRol } = await import('../lib/permisos/cachePermisos.js');
const {
  MENSAJE_CANTIDAD_FORMATO,
  MENSAJE_CANTIDAD_NEGATIVA,
  MENSAJE_RECALCULO_BLOQUEADO,
  crearConteoStock,
  marcarPedidoProveedor,
} = await import('../lib/mia/conteoStock.js');
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
  db.crearTabla(tables.miaInformes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const p of ['ver', 'calcular']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#SuperUser', SK: `PERMISO#mia.${p}` });
  }
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Camarero', SK: 'PERMISO#mia.ver' });
  db.sembrar(tables.almacenes, { Id: '101', Nombre: 'Almacen Centro' });
  db.sembrar(tables.almacenes, { Id: '202', Nombre: 'Almacen Sur' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur', 'almacen origen': 'Almacen Sur' });
  db.sembrar(tables.usuarios, { id_usuario: '000080', Email: COMPRADOR.email, Rol: 'SuperUser', Local: ['Bar Centro'] });
  db.sembrar(tables.usuarios, { id_usuario: '000082', Email: CAMARERO.email, Rol: 'Camarero', Local: ['Bar Centro'] });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  invalidarPermisosRol();
}

function linea(productId) {
  return db.listar(tables.miaInformeLineas).find((ln) => ln.productId === productId);
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

test('la lista solo trae conteos de stock máximo, con su estado', async () => {
  montar();
  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#viejo', SK: 'META', informeId: 'viejo', tipo: 'consumo',
    WarehouseId: '000101', warehouseId: '000101', estado: 'calculado',
    creadoEn: '2026-01-01T00:00:00.000Z',
  });
  await crearConteoStock({
    informeId: 'c1',
    warehouseId: '101',
    ficheroNombre: 'conteo.xlsx',
    idsDesconocidos: ['999'],
    duplicados: ['501'],
    multiplicador: 1,
    lineas: [
      { productId: '501', nombre: 'Tonica', proveedorId: '42', proveedorNombre: 'Distrib', stockReal: 4, maximo: 10, formatoCompra: 6, cantidadPedida: 6 },
      { productId: '502', nombre: 'Agua', proveedorId: '42', stockReal: null, cantidadPedida: 0 },
    ],
  });
  const lista = await api('GET', '/api/mia/conteos?warehouseId=101');
  assert.equal(lista.status, 200, JSON.stringify(lista.body));
  assert.deepEqual(lista.body.conteos.map((c) => c.informeId), ['c1']);
  assert.equal(lista.body.conteos[0].estado, 'generado');
  assert.equal(lista.body.conteos[0].ficheroNombre, 'conteo.xlsx');

  const detalle = await api('GET', '/api/mia/conteos/c1');
  assert.equal(detalle.status, 200, JSON.stringify(detalle.body));
  assert.deepEqual(detalle.body.desconocidos, ['999']);
  assert.deepEqual(detalle.body.duplicados, ['501']);
  assert.deepEqual(detalle.body.sinContar.map((ln) => ln.productId), ['502']);
  assert.equal(detalle.body.editable, true);
  const tonica = detalle.body.lineas.find((ln) => ln.productId === '501');
  assert.equal(tonica.cantidadCalculada, 6);
  assert.equal(tonica.maximoCalculado, 10);
});

test('guarda decimales múltiplos del formato, marca el máximo manual y restaura el calculado', async () => {
  montar();
  await crearConteoStock({
    informeId: 'c1',
    warehouseId: '101',
    multiplicador: 1,
    lineas: [
      { productId: '501', nombre: 'Tonica', proveedorId: '42', proveedorNombre: 'Distrib', stockReal: 4, maximo: 10, formatoCompra: 6, cantidadPedida: 6 },
      { productId: '503', nombre: 'Copa', proveedorId: '7', proveedorNombre: 'Bodega', stockReal: 0, maximo: 1, formatoCompra: 0.5, cantidadPedida: 1 },
    ],
  });

  const ok = await api('PUT', '/api/mia/conteos/c1/lineas', {
    lineas: [
      { productId: '501', proveedorId: '42', cantidadManual: true, cantidadPedida: 12, maximoManual: true, maximoFinal: '15,5' },
      { productId: '503', proveedorId: '7', cantidadManual: true, cantidadPedida: '1,5', maximoManual: false },
    ],
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(linea('501').cantidadPedida, 12);
  assert.equal(linea('501').cantidadManual, true);
  assert.equal(linea('501').maximoFinal, 15.5);
  assert.equal(linea('501').maximoManual, true);
  assert.equal(linea('501').maximo, 10);
  assert.equal(linea('503').cantidadPedida, 1.5);

  const noMultiplo = await api('PUT', '/api/mia/conteos/c1/lineas', {
    lineas: [
      { productId: '501', proveedorId: '42', cantidadManual: true, cantidadPedida: 7, maximoManual: true, maximoFinal: 15.5 },
      { productId: '503', proveedorId: '7', cantidadManual: true, cantidadPedida: 1.5, maximoManual: false },
    ],
  });
  assert.equal(noMultiplo.status, 400);
  assert.equal(noMultiplo.body.error, MENSAJE_CANTIDAD_FORMATO);
  assert.equal(noMultiplo.body.indice, 0);
  assert.equal(linea('501').cantidadPedida, 12);
  assert.equal(linea('503').cantidadPedida, 1.5);

  const negativa = await api('PUT', '/api/mia/conteos/c1/lineas', {
    lineas: [{ productId: '503', proveedorId: '7', cantidadManual: true, cantidadPedida: -1, maximoManual: false }],
  });
  assert.equal(negativa.status, 400);
  assert.equal(negativa.body.error, MENSAJE_CANTIDAD_NEGATIVA);
  assert.equal(linea('503').cantidadPedida, 1.5);

  const quitada = await api('PUT', '/api/mia/conteos/c1/lineas', {
    lineas: [{ productId: '501', proveedorId: '42', omitida: true, maximoManual: true, maximoFinal: 15.5 }],
  });
  assert.equal(quitada.status, 200, JSON.stringify(quitada.body));
  assert.equal(linea('501').omitida, true);
  assert.equal(linea('501').cantidadPedida, 0);
  assert.equal(linea('501').cantidadManual, true);

  const restaurada = await api('PUT', '/api/mia/conteos/c1/lineas', {
    lineas: [{ productId: '501', proveedorId: '42', cantidadManual: false, maximoManual: false, omitida: false }],
  });
  assert.equal(restaurada.status, 200, JSON.stringify(restaurada.body));
  assert.equal(linea('501').omitida, false);
  assert.equal(linea('501').cantidadManual, false);
  assert.equal(linea('501').maximoManual, false);
  assert.equal(linea('501').cantidadPedida, 6);
  assert.equal(linea('501').maximoFinal, 10);
});

test('un proveedor en Pedido bloquea el guardado y un almacén ajeno responde 403', async () => {
  montar();
  await crearConteoStock({
    informeId: 'c1',
    warehouseId: '101',
    multiplicador: 1,
    lineas: [
      { productId: '501', nombre: 'Tonica', proveedorId: '42', stockReal: 4, maximo: 10, formatoCompra: 6, cantidadPedida: 6 },
    ],
  });
  await marcarPedidoProveedor('c1', '42', { estado: 'pedido', serie: 'MIA', number: 8 });
  const bloqueado = await api('PUT', '/api/mia/conteos/c1/lineas', {
    lineas: [{ productId: '501', proveedorId: '42', cantidadManual: true, cantidadPedida: 12, maximoManual: false }],
  });
  assert.equal(bloqueado.status, 409);
  assert.equal(bloqueado.body.error, MENSAJE_RECALCULO_BLOQUEADO);
  assert.equal(linea('501').cantidadPedida, 6);

  const lista = await api('GET', '/api/mia/conteos?warehouseId=101');
  assert.equal(lista.body.conteos[0].estado, 'pedido');

  const ajeno = await api('GET', '/api/mia/conteos?warehouseId=202');
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.body.error, 'No tienes acceso a este local');
  const sinPermiso = await api('PUT', '/api/mia/conteos/c1/lineas', {
    lineas: [{ productId: '501', proveedorId: '42', cantidadManual: true, cantidadPedida: 12, maximoManual: false }],
  }, CAMARERO);
  assert.equal(sinPermiso.status, 403);
  assert.equal(sinPermiso.body.error, 'Permiso insuficiente');
  assert.equal(linea('501').cantidadPedida, 6);
});
