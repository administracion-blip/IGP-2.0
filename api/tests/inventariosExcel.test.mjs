/**
 * El Excel de inventario copia la plantilla de Ágora y solo rellena el stock real.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import ExcelJS from 'exceljs';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-inventario';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { bufferInventario } = await import('../lib/inventarios/excel.js');
const { crearPlantilla } = await import('../lib/inventarios/plantillas.js');
const { crearInventario, cambiarEstado } = await import('../lib/inventarios/inventarios.js');
const { default: inventariosRouter } = await import('../routes/inventarios.js');

const CONTADOR = { sub: '000020', email: 'contador@test', rol: 'Contador' };
const COMPRAS = { sub: '000021', email: 'compras@test', rol: 'Compras', Nombre: 'Ana Compras' };

let servidor = null;
let base = '';
let usuarioActual = COMPRAS;
let db = null;

async function api(metodo, ruta, cuerpo) {
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  const tipo = res.headers.get('content-type') || '';
  if (tipo.includes('spreadsheetml')) {
    return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers, body: {} };
  }
  return { status: res.status, body: await res.json().catch(() => ({})), buffer: null, headers: res.headers };
}

async function hojaDe(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.getWorksheet('Inventario');
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
    indices: { 'WarehouseId-Clave-index': { hashKey: 'WarehouseId', rangeKey: 'Clave' } },
  });
  db.instalar(docClient);
  db.sembrar(tables.usuarios, { id_usuario: CONTADOR.sub, Rol: 'Contador', Locales: [], Email: CONTADOR.email });
  db.sembrar(tables.usuarios, { id_usuario: COMPRAS.sub, Rol: 'Compras', Locales: [], Email: COMPRAS.email, Nombre: 'Ana Compras' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Contador', SK: 'PERMISO#inventario.contar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Compras', SK: 'PERMISO#inventario.gestionar' });
  invalidarContextoAcceso();
});

test('el Excel tiene las columnas de la plantilla y no redondea el stock real', async () => {
  const buffer = await bufferInventario({
    lineas: [
      {
        productId: '1367',
        familiaNombre: 'BOT WHISKYS',
        nombre: 'BOT JOHNNIE WALKER RED',
        unidad: 'Unidad',
        stockTeorico: 203.5,
        stockReal: 8.75,
      },
      {
        productId: '50',
        familiaNombre: 'OTRA',
        nombre: 'Sin contar',
        unidad: '',
        stockTeorico: 0,
        stockReal: null,
      },
    ],
  });
  const hoja = await hojaDe(buffer);
  assert.ok(hoja);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((c) => hoja.getCell(1, c).value),
    ['Id', 'Familia', 'Nombre', 'Ubicación', 'Código Barras', 'Unidad', 'Stock Teórico (Uds. Venta)', 'Stock Real (Uds. Venta)'],
  );
  assert.equal(hoja.getCell('A2').value, 1367);
  assert.equal(hoja.getCell('B2').value, 'BOT WHISKYS');
  assert.equal(hoja.getCell('C2').value, 'BOT JOHNNIE WALKER RED');
  assert.equal(hoja.getCell('D2').value, null);
  assert.equal(hoja.getCell('E2').value, null);
  assert.equal(hoja.getCell('F2').value, 'Unidad');
  assert.equal(hoja.getCell('G2').value, 203.5);
  assert.equal(hoja.getCell('H2').value, 8.75);
  assert.equal(hoja.getCell('H3').value, null);
  assert.equal(hoja.getCell('I2').value, null);
});

test('descargar pasa a exportado, la segunda vez avisa y luego se puede marcar importado', async () => {
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

  const plantilla = await crearPlantilla({
    warehouseId: '1',
    nombre: 'Botellas',
    modo: 'familias',
    miembros: [{ id: '12', nombre: 'BOT WHISKYS' }],
  }, 'compras@test');
  const creado = await crearInventario({
    warehouseId: '1',
    fecha: '2026-10-25',
    employeeId: '42',
    employeeNombre: 'Ana',
    plantillaId: plantilla.plantillaId,
    lineas: [{
      productId: '1367',
      nombre: 'BOT JOHNNIE WALKER RED',
      familiaNombre: 'BOT WHISKYS',
      unidad: 'Unidad',
      stockTeorico: 203,
      stockReal: 10.5,
      botellasAbiertas: 0,
    }],
  }, 'compras@test');
  await cambiarEstado(creado.inventarioId, 'contado', 'compras@test');
  await cambiarEstado(creado.inventarioId, 'revisado', 'compras@test');

  const primero = await api('GET', `/api/inventarios/${creado.inventarioId}/excel`);
  assert.equal(primero.status, 200);
  assert.match(primero.headers.get('content-disposition') || '', /Inventario-2026-10-25\.xlsx/);
  const hoja = await hojaDe(primero.buffer);
  assert.equal(hoja.getCell('H2').value, 10.5);
  assert.equal(hoja.getCell('D2').value, null);
  assert.equal(hoja.getCell('G2').value, 203);

  const trasPrimero = await api('GET', `/api/inventarios/${creado.inventarioId}`);
  assert.equal(trasPrimero.body.estado, 'exportado');
  assert.equal(trasPrimero.body.exportaciones, 1);
  assert.equal(trasPrimero.body.ultimaExportacionPor, 'Ana Compras (compras@test)');
  assert.equal(trasPrimero.body.lineas[0].stockTeorico, 203);

  const aviso = await api('GET', `/api/inventarios/${creado.inventarioId}/excel`);
  assert.equal(aviso.status, 409);
  assert.match(aviso.body.error, /ya se exportó/);

  const segundo = await api('GET', `/api/inventarios/${creado.inventarioId}/excel?repetir=1`);
  assert.equal(segundo.status, 200);
  assert.equal((await api('GET', `/api/inventarios/${creado.inventarioId}`)).body.exportaciones, 2);

  const importado = await api('PATCH', `/api/inventarios/${creado.inventarioId}/estado`, { estado: 'importado' });
  assert.equal(importado.status, 200);
  assert.equal(importado.body.estado, 'importado');
  assert.equal(importado.body.estadoPor, 'Ana Compras (compras@test)');
  assert.ok(importado.body.estadoEn);
  assert.equal((await api('GET', `/api/inventarios/${creado.inventarioId}/excel?repetir=1`)).status, 409);

  usuarioActual = CONTADOR;
  const otro = await crearInventario({
    warehouseId: '1',
    fecha: '2026-10-26',
    employeeId: '42',
    employeeNombre: 'Ana',
    plantillaId: plantilla.plantillaId,
    lineas: [{ productId: '1367', nombre: 'BOT', stockTeorico: 1, stockReal: 1 }],
  }, 'compras@test');
  await cambiarEstado(otro.inventarioId, 'contado', 'compras@test');
  await cambiarEstado(otro.inventarioId, 'revisado', 'compras@test');
  assert.equal((await api('GET', `/api/inventarios/${otro.inventarioId}/excel`)).status, 403);
  assert.equal(db.operaciones.some((op) => op.tipo === 'ScanCommand'), false);
});
