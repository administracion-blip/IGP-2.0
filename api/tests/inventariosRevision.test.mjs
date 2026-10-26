/**
 * La revisión compara con el teórico ya guardado y el umbral lo pone quien gestiona.
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
const { clasificarLinea } = await import('../lib/inventarios/diferencia.js');
const { crearPlantilla } = await import('../lib/inventarios/plantillas.js');
const { crearInventario, cambiarEstado } = await import('../lib/inventarios/inventarios.js');
const { default: inventariosRouter } = await import('../routes/inventarios.js');

const CONTADOR = { sub: '000020', email: 'contador@test', rol: 'Contador' };
const COMPRAS = { sub: '000021', email: 'compras@test', rol: 'Compras' };

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
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
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
  invalidarContextoAcceso();
});

test('el semáforo usa el porcentaje guardado y el teórico de la línea', () => {
  assert.equal(clasificarLinea({ stockTeorico: 100, stockReal: 110 }, null).semaforo, 'sin-umbral');
  assert.equal(clasificarLinea({ stockTeorico: 100, stockReal: null }, 10).semaforo, 'sin-contar');
  assert.equal(clasificarLinea({ stockTeorico: 100, stockReal: 110 }, 10).semaforo, 'ok');
  assert.equal(clasificarLinea({ stockTeorico: 100, stockReal: 111 }, 10).semaforo, 'fuera');
  assert.equal(clasificarLinea({ stockTeorico: 0, stockReal: 0 }, 0).semaforo, 'ok');
  assert.equal(clasificarLinea({ stockTeorico: 0, stockReal: 1 }, 100).semaforo, 'fuera');
  const justo = clasificarLinea({ stockTeorico: 203, stockReal: 10.5 }, 5);
  assert.equal(justo.semaforo, 'fuera');
  assert.equal(justo.diferencia, 10.5 - 203);
  const conAbierta = clasificarLinea({ stockTeorico: 3, stockReal: 3, botellasAbiertas: 0.5 }, 10);
  assert.equal(conAbierta.diferencia, 0.5);
});

test('corregir una línea no toca el teórico y el umbral no tiene valor por defecto', async () => {
  const vacio = await api('GET', '/api/inventarios/umbral');
  assert.equal(vacio.status, 200);
  assert.equal(vacio.body.porcentaje, null);

  const guardado = await api('PUT', '/api/inventarios/umbral', { porcentaje: '12,5' });
  assert.equal(guardado.status, 200);
  assert.equal(guardado.body.porcentaje, 12.5);
  assert.equal((await api('GET', '/api/inventarios/umbral')).body.porcentaje, 12.5);
  assert.equal((await api('PUT', '/api/inventarios/umbral', { porcentaje: -1 })).status, 400);
  assert.equal((await api('PUT', '/api/inventarios/umbral', {})).status, 400);
  assert.equal((await api('PUT', '/api/inventarios/umbral', { porcentaje: null })).body.porcentaje, null);

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
    lineas: [{ productId: '1367', nombre: 'BOT JOHNNIE WALKER RED', stockTeorico: 203, stockReal: 10.5, botellasAbiertas: 0 }],
  }, 'compras@test');
  await cambiarEstado(creado.inventarioId, 'contado', 'compras@test');

  const corregida = await api('PUT', `/api/inventarios/${creado.inventarioId}/lineas/1367`, {
    stockReal: 200,
    botellasAbiertas: 0.25,
  });
  assert.equal(corregida.status, 200);
  assert.equal(corregida.body.stockTeorico, 203);
  assert.equal(corregida.body.stockReal, 200);

  const revisado = await api('PATCH', `/api/inventarios/${creado.inventarioId}/estado`, { estado: 'revisado' });
  assert.equal(revisado.status, 200);
  assert.equal(revisado.body.estado, 'revisado');
  assert.equal(revisado.body.lineas[0].stockTeorico, 203);

  usuarioActual = CONTADOR;
  assert.equal((await api('PUT', '/api/inventarios/umbral', { porcentaje: 5 })).status, 403);
  assert.equal((await api('PATCH', `/api/inventarios/${creado.inventarioId}/estado`, { estado: 'exportado' })).status, 403);
  assert.equal(db.operaciones.some((op) => op.tipo === 'ScanCommand'), false);
});
