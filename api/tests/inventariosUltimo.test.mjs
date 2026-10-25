/**
 * Lectura del último inventario importado de un almacén.
 * No escribe, no lee líneas y no toca MIA.
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
const { crearPlantilla } = await import('../lib/inventarios/plantillas.js');
const { crearInventario, cambiarEstado } = await import('../lib/inventarios/inventarios.js');
const { default: inventariosRouter } = await import('../routes/inventarios.js');

const CONTADOR = { sub: '000020', email: 'contador@test', rol: 'Contador' };
const COMPRAS = { sub: '000021', email: 'compras@test', rol: 'Compras' };
const AJENO = { sub: '000022', email: 'ajeno@test', rol: 'Ajeno' };

let servidor = null;
let base = '';
let usuarioActual = COMPRAS;
let db = null;

async function api(metodo, ruta) {
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
  const res = await fetch(base + ruta, { method: metodo });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function hasta(id, estadoFinal) {
  const orden = ['contado', 'revisado', 'exportado', 'importado'];
  for (const estado of orden) {
    await cambiarEstado(id, estado, 'compras@test');
    if (estado === estadoFinal) return;
  }
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
  db.sembrar(tables.usuarios, { id_usuario: COMPRAS.sub, Rol: 'Compras', Locales: [], Email: COMPRAS.email });
  db.sembrar(tables.usuarios, { id_usuario: AJENO.sub, Rol: 'Ajeno', Locales: [], Email: AJENO.email });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Contador', SK: 'PERMISO#inventario.contar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Compras', SK: 'PERMISO#inventario.gestionar' });
  invalidarContextoAcceso();
});

test('el último importado es el de fecha más reciente, aunque haya un conteo posterior', async () => {
  const plantilla = await crearPlantilla({
    warehouseId: '1',
    nombre: 'Botellas',
    modo: 'familias',
    miembros: [{ id: '12', nombre: 'BOT WHISKYS' }],
  }, 'compras@test');

  async function abrir(fecha) {
    return crearInventario({
      warehouseId: '1',
      fecha,
      employeeId: '42',
      employeeNombre: 'Ana',
      plantillaId: plantilla.plantillaId,
      lineas: [{ productId: '1367', nombre: 'BOT', stockTeorico: 203, stockReal: 10.5 }],
    }, 'compras@test');
  }

  const viejo = await abrir('2026-10-01');
  const medio = await abrir('2026-10-10');
  const reciente = await abrir('2026-10-20');
  const mismoDiaPrimero = await abrir('2026-10-10');
  await hasta(viejo.inventarioId, 'importado');
  await hasta(medio.inventarioId, 'importado');
  await hasta(reciente.inventarioId, 'contado');
  await hasta(mismoDiaPrimero.inventarioId, 'importado');

  const desde = db.operaciones.length;
  const res = await api('GET', '/api/inventarios/ultimo?warehouseId=1');
  const nuevas = db.operaciones.slice(desde);
  assert.equal(res.status, 200);
  assert.equal(res.body.warehouseId, '000001');
  assert.equal(res.body.inventario.inventarioId, mismoDiaPrimero.inventarioId);
  assert.equal(res.body.inventario.fecha, '2026-10-10');
  assert.equal(res.body.inventario.estado, 'importado');
  assert.ok(res.body.inventario.estadoEn);
  assert.equal(res.body.inventario.lineas, undefined);
  assert.equal(JSON.stringify(res.body).includes('stockTeorico'), false);
  assert.equal(nuevas.some((op) => op.tipo === 'ScanCommand'), false);
  assert.equal(
    nuevas.some((op) => op.tabla === tables.inventarios && op.tipo !== 'QueryCommand'),
    false,
  );

  const vacio = await api('GET', '/api/inventarios/ultimo?warehouseId=2');
  assert.equal(vacio.status, 200);
  assert.equal(vacio.body.inventario, null);
  assert.equal((await api('GET', '/api/inventarios/ultimo')).status, 400);

  usuarioActual = CONTADOR;
  const contador = await api('GET', '/api/inventarios/ultimo?warehouseId=1');
  assert.equal(contador.status, 200);
  assert.equal(contador.body.inventario.fecha, '2026-10-10');

  usuarioActual = AJENO;
  assert.equal((await api('GET', '/api/inventarios/ultimo?warehouseId=1')).status, 403);
});
