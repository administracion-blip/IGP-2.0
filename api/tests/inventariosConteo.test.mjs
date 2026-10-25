/**
 * Abrir un conteo copia el stock teórico y quien solo cuenta no lo recibe.
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
const { abrirConteo } = await import('../lib/inventarios/conteo.js');
const { default: inventariosRouter } = await import('../routes/inventarios.js');

const CONTADOR = { sub: '000020', email: 'contador@test', rol: 'Contador' };
const COMPRAS = { sub: '000021', email: 'compras@test', rol: 'Compras' };

let servidor = null;
let base = '';
let usuarioActual = CONTADOR;
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
  const res = await fetch(base + ruta);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

beforeEach(() => {
  usuarioActual = CONTADOR;
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.inventarios, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'WarehouseId-Clave-index': { hashKey: 'WarehouseId', rangeKey: 'Clave' } },
  });
  db.instalar(docClient);
  db.sembrar(tables.usuarios, { id_usuario: CONTADOR.sub, Rol: 'Contador', Locales: [], Email: CONTADOR.email });
  db.sembrar(tables.usuarios, { id_usuario: COMPRAS.sub, Rol: 'Compras', Locales: [], Email: COMPRAS.email });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Contador', SK: 'PERMISO#inventario.contar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Compras', SK: 'PERMISO#inventario.gestionar' });
  db.sembrar(tables.agoraProducts, {
    PK: 'GLOBAL', SK: '1367', Id: '1367', Name: 'BOT JOHNNIE WALKER RED',
    FamilyId: '12', FamilyName: 'BOT WHISKYS', FormatoBaseNombre: 'Unidad', Active: true,
  });
  db.sembrar(tables.agoraProducts, {
    PK: 'GLOBAL', SK: '999', Id: '999', Name: 'Otra cosa',
    FamilyId: '99', FamilyName: 'OTRA', FormatoBaseNombre: 'Unidad', Active: true,
  });
  db.sembrar(tables.agoraProducts, {
    PK: 'GLOBAL', SK: '50', Id: '50', Name: 'Inactivo',
    FamilyId: '12', FamilyName: 'BOT WHISKYS', Active: false,
  });
  invalidarContextoAcceso();
});

test('el conteo guarda el teórico con decimales y no llama a escribir en Ágora', async () => {
  const plantilla = await crearPlantilla({
    warehouseId: '1',
    nombre: 'Botellas',
    modo: 'familias',
    miembros: [{ id: '12', nombre: 'BOT WHISKYS' }],
  }, 'compras@test');
  const llamadas = [];
  const inventario = await abrirConteo({
    warehouseId: '1',
    fecha: '2026-10-25',
    employeeId: '42',
    employeeNombre: 'Ana',
    plantillaId: plantilla.plantillaId,
  }, 'contador@test', {
    exportStocks: async (opts) => {
      llamadas.push(opts);
      return [{ ProductId: 1367, Quantity: '203,5' }];
    },
  });
  assert.deepEqual(llamadas, [{ warehouseId: '000001' }]);
  assert.equal(inventario.lineas.length, 1);
  assert.equal(inventario.lineas[0].productId, '1367');
  assert.equal(inventario.lineas[0].stockTeorico, 203.5);
  assert.equal(inventario.lineas[0].stockReal, null);
  assert.equal(inventario.lineas[0].botellasAbiertas, 0);
  assert.equal(inventario.lineas[0].unidad, 'Unidad');
  assert.equal(db.operaciones.some((op) => op.tipo === 'ScanCommand'), false);

  usuarioActual = CONTADOR;
  const ciego = await api('GET', `/api/inventarios/${inventario.inventarioId}`);
  assert.equal(ciego.status, 200);
  assert.equal(ciego.body.lineas[0].stockReal, null);
  assert.equal('stockTeorico' in ciego.body.lineas[0], false);

  usuarioActual = COMPRAS;
  const revision = await api('GET', `/api/inventarios/${inventario.inventarioId}`);
  assert.equal(revision.body.lineas[0].stockTeorico, 203.5);
});

test('si Ágora no devuelve el stock, no se crea el inventario', async () => {
  const plantilla = await crearPlantilla({
    warehouseId: '1', nombre: 'Botellas', modo: 'familias', miembros: [{ id: '12', nombre: 'BOT WHISKYS' }],
  }, 'compras@test');
  await assert.rejects(
    () => abrirConteo({
      warehouseId: '1', fecha: '2026-10-25', employeeId: '42', employeeNombre: 'Ana',
      plantillaId: plantilla.plantillaId,
    }, 'contador@test', {
      exportStocks: async () => { throw new Error('token secreto de Ágora'); },
    }),
    (err) => err.status === 502 && err.message === 'No se ha podido leer el stock de Ágora',
  );
  assert.equal(db.listar(tables.inventarios).some((it) => String(it.PK).startsWith('INV#')), false);
});
