/**
 * Importar el Excel de conteo (fase 2). No calcula previsión ni multiplicador.
 * Rechaza tipo, hoja, cabeceras, fichero sin conteos, permiso y almacén ajeno.
 * Un Id repetido se avisa y se queda la primera fila.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import ExcelJS from 'exceljs';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-importar-mia';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { invalidarPermisosRol } = await import('../lib/permisos/cachePermisos.js');
const { CABECERAS } = await import('../lib/inventarios/excel.js');
const {
  MENSAJE_NO_XLSX,
  MENSAJE_SIN_HOJA,
  MENSAJE_CABECERAS,
  MENSAJE_SIN_CONTADAS,
  precioDeUltimaCompra,
} = await import('../lib/mia/importarExcel.js');
const { upsertConfigProducto } = await import('../lib/mia/configProducto.js');
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
  db.crearTabla(tables.comprasProveedor, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'ProductId-AlbaranFecha-index': { hashKey: 'ProductId', rangeKey: 'AlbaranFecha' },
    },
  });
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
  for (const [id, nombre] of [['501', 'Tonica'], ['502', 'Agua'], ['503', 'Cola'], ['504', 'Zumo']]) {
    db.sembrar(tables.agoraProducts, { PK: 'GLOBAL', SK: id, Id: Number(id), Name: nombre });
  }
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  invalidarPermisosRol();
}

async function excel(filas, { hoja = 'Inventario', cabeceras = CABECERAS } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(hoja);
  ws.addRow(cabeceras);
  for (const fila of filas) ws.addRow(fila);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function postFichero(buf, { nombre = 'conteo.xlsx', warehouseId = '101', usuario = COMPRADOR } = {}) {
  await asegurarServidor();
  usuarioActual = usuario;
  const fd = new FormData();
  fd.append('warehouseId', String(warehouseId));
  fd.append('semanasDesde', '2026-11-02');
  fd.append('semanasHasta', '2026-11-08');
  fd.append('fichero', new Blob([buf]), nombre);
  const res = await fetch(`${base}/api/mia/conteos/importar`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function metas() {
  return db.listar(tables.miaInformes).filter((it) => it.SK === 'META');
}

test('importa el conteo, avisa duplicados y no calcula previsión', async () => {
  montar();
  const buf = await excel([
    [501, 'Bebidas', 'Tonica', null, null, 'ud', 10, 4],
    [502, 'Bebidas', 'Agua', null, null, 'ud', 8, 0],
    [503, 'Bebidas', 'Cola', null, null, 'ud', 3, null],
    [504, 'Bebidas', 'Zumo', null, null, 'ud', 2, '1,5'],
    [999, 'Bebidas', 'Fantasma', null, null, 'ud', 1, 2],
    [501, 'Bebidas', 'Tonica', null, null, 'ud', 10, 9],
  ]);
  const r = await postFichero(buf);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.lineasContadas, 3);
  assert.deepEqual(r.body.desconocidos, ['999']);
  assert.deepEqual(r.body.duplicados, ['501']);
  assert.match(r.body.avisoDuplicados, /primera fila/);
  assert.equal(r.body.multiplicador, null);
  assert.equal(r.body.previsionImporte, null);

  const meta = metas()[0];
  assert.equal(meta.tipo, 'stock_maximo');
  assert.equal(meta.multiplicador, null);
  assert.equal(meta.previsionImporte, null);
  assert.equal(meta.tramoDesde, null);
  assert.equal(meta.previsionAviso, null);
  assert.equal(meta.WarehouseId, '000101');

  const lineas = db.listar(tables.miaInformeLineas);
  const stock = (id) => lineas.find((ln) => ln.productId === id)?.stockReal;
  assert.equal(stock('501'), 4);
  assert.equal(stock('502'), 0);
  assert.equal(lineas.some((ln) => ln.productId === '503'), false);
  assert.equal(stock('504'), 1.5);
  assert.equal(lineas.length, 3);
  assert.equal(lineas.some((ln) => ln.productId === '999'), false);
  assert.equal(lineas.filter((ln) => ln.productId === '501').length, 1);
  assert.equal(lineas.find((ln) => ln.productId === '501').proveedorId, 'SIN_PROVEEDOR');
});

test('rechaza lo que no es xlsx, sin hoja, con cabeceras distintas o sin líneas contadas', async () => {
  montar();
  const noExcel = await postFichero(Buffer.from('esto no es un excel'), { nombre: 'conteo.xlsx' });
  assert.equal(noExcel.status, 400);
  assert.equal(noExcel.body.error, MENSAJE_NO_XLSX);

  const csv = await postFichero(Buffer.from('Id,Nombre\n1,Agua\n'), { nombre: 'conteo.csv' });
  assert.equal(csv.status, 400);
  assert.equal(csv.body.error, MENSAJE_NO_XLSX);

  const sinHoja = await postFichero(await excel([[501, 'Bebidas', 'Tonica', null, null, 'ud', 1, 1]], { hoja: 'Datos' }));
  assert.equal(sinHoja.status, 400);
  assert.equal(sinHoja.body.error, MENSAJE_SIN_HOJA);

  const cab = CABECERAS.map((h, i) => (i === 0 ? 'Codigo' : h));
  const mal = await postFichero(await excel([[501, 'Bebidas', 'Tonica', null, null, 'ud', 1, 1]], { cabeceras: cab }));
  assert.equal(mal.status, 400);
  assert.equal(mal.body.error, MENSAJE_CABECERAS);

  const vacio = await postFichero(await excel([[501, 'Bebidas', 'Tonica', null, null, 'ud', 3, null]]));
  assert.equal(vacio.status, 400);
  assert.equal(vacio.body.error, MENSAJE_SIN_CONTADAS);

  const desconocido = await postFichero(await excel([[999, 'Bebidas', 'Fantasma', null, null, 'ud', 1, 2]]));
  assert.equal(desconocido.status, 400);
  assert.equal(desconocido.body.error, MENSAJE_SIN_CONTADAS);
  assert.deepEqual(desconocido.body.desconocidos, ['999']);

  const grande = await postFichero(Buffer.alloc(5 * 1024 * 1024 + 1, 1));
  assert.equal(grande.status, 400);
  assert.match(grande.body.error, /tamaño máximo/);

  assert.equal(metas().length, 0);
});

test('sin permiso mia.calcular: 403 y no guarda', async () => {
  montar();
  const buf = await excel([[501, 'Bebidas', 'Tonica', null, null, 'ud', 10, 4]]);
  const r = await postFichero(buf, { usuario: CAMARERO });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Permiso insuficiente');
  assert.equal(metas().length, 0);
});

test('copia el proveedor de la ficha o de la última compra, y la unidad del formato base', async () => {
  montar();
  await upsertConfigProducto({
    warehouseId: '101',
    productId: '501',
    proveedorId: '42',
    proveedorNombre: 'Distrib',
    purchaseUnitId: '10',
    purchaseUnitName: 'Botella',
  });
  db.sembrar(tables.comprasProveedor, {
    PK: 'ALB#1',
    SK: 'L1',
    ProductId: '502',
    AlbaranFecha: '2026-10-01',
    SupplierId: '77',
    SupplierName: 'Bebidas Norte',
    WarehouseId: '000101',
    Confirmed: true,
  });
  db.sembrar(tables.agoraProducts, {
    PK: 'GLOBAL',
    SK: '504',
    Id: 504,
    Name: 'Zumo',
    BaseSaleFormatId: 8,
    FormatoBaseNombre: 'Lata',
  });
  const buf = await excel([
    [501, 'Bebidas', 'Tonica', null, null, 'ud', 10, 4],
    [502, 'Bebidas', 'Agua', null, null, 'ud', 8, 1],
    [503, 'Bebidas', 'Cola', null, null, 'ud', 3, 2],
    [504, 'Bebidas', 'Zumo', null, null, 'ud', 2, 1],
  ]);
  const r = await postFichero(buf);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const lineas = db.listar(tables.miaInformeLineas);
  const de = (id) => lineas.find((ln) => ln.productId === id);
  assert.equal(de('501').proveedorId, '42');
  assert.equal(de('501').proveedorNombre, 'Distrib');
  assert.equal(de('501').purchaseUnitId, '10');
  assert.equal(de('501').unit, 'Botella');
  assert.equal(de('501').SK, 'LINE#42#501');
  assert.equal(de('502').proveedorId, '77');
  assert.equal(de('502').proveedorNombre, 'Bebidas Norte');
  assert.equal(de('503').proveedorId, 'SIN_PROVEEDOR');
  assert.equal(de('504').proveedorId, 'SIN_PROVEEDOR');
  assert.equal(de('504').purchaseUnitId, '8');
  assert.equal(de('504').unit, 'Lata');
});

test('el precio de la última compra solo entra si la unidad coincide', () => {
  const ultima = {
    PurchaseUnitId: '10',
    Price: 2,
    DiscountRate: 0.1,
    CashDiscount: 1.2,
    Quantity: 6,
  };
  const misma = precioDeUltimaCompra('10', ultima);
  assert.equal(misma.costeUnitario, 2);
  assert.equal(misma.discountRate, 0.1);
  assert.equal(misma.cashDiscountUnitario, 0.2);
  assert.equal(precioDeUltimaCompra('8', ultima).costeUnitario, null);
  assert.equal(precioDeUltimaCompra('10', { ...ultima, DiscountRate: 1 }).costeUnitario, null);
});

test('almacén fuera del filtro del usuario: 403 y no guarda', async () => {
  montar();
  const buf = await excel([[501, 'Bebidas', 'Tonica', null, null, 'ud', 10, 4]]);
  const r = await postFichero(buf, { warehouseId: '202' });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error, 'No tienes acceso a este local');
  assert.equal(metas().length, 0);
});
