/**
 * Respuesta por voz a la pregunta abierta: «el 10», «sí» y «no».
 * No crea una segunda línea. Un conteo nuevo no se confunde con la respuesta.
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
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { crearPlantilla } = await import('../lib/inventarios/plantillas.js');
const { crearInventario } = await import('../lib/inventarios/inventarios.js');
const { crearRouterDictado } = await import('../routes/inventariosDictado.js');
const { resolverRespuesta, motivosTrasElegir, confirmarTrasElegir } = await import('../lib/inventarios/dictado/respuestaVoz.js');

const CONTADOR = { sub: '000020', email: 'contador@test', rol: 'Contador', Nombre: 'Ana' };
const T = () => tables.inventarios;

let servidor = null;
let base = '';
let db = null;
let plantillaId = null;

const CANDIDATOS = [
  { productId: '826', nombre: 'BALLANTINES 10' },
  { productId: '827', nombre: 'BALLANTINES 12' },
];

function lineaInv(productId, nombre, extra = {}) {
  return { productId, nombre, familiaNombre: 'BOT', unidad: 'Unidad', stockTeorico: 50, ...extra };
}

async function api(metodo, ruta, cuerpo) {
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const ruta = (id, resto = '') => `/api/inventarios/${id}/dictado${resto}`;
const dictar = (id, texto) => api('POST', ruta(id, '/interpretar'), { texto });

function lineaConteo(id, productId) {
  return db.obtener(T(), { PK: `INV#${id}`, SK: `LINE#${productId}` });
}

async function nuevoInventario(nombres) {
  const inv = await crearInventario({
    warehouseId: '1',
    fecha: '2026-11-02',
    employeeId: '42',
    employeeNombre: 'Ana',
    plantillaId,
    lineas: nombres.map(([productId, nombre, extra]) => lineaInv(productId, nombre, extra)),
  }, 'compras@test');
  return inv.inventarioId;
}

beforeEach(async () => {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(T(), {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'WarehouseId-Clave-index': { hashKey: 'WarehouseId', rangeKey: 'Clave' } },
  });
  db.instalar(docClient);
  db.sembrar(tables.usuarios, { id_usuario: CONTADOR.sub, Rol: CONTADOR.rol, Locales: [], Email: CONTADOR.email });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Contador', SK: 'PERMISO#inventario.contar' });
  db.sembrar(tables.almacenes, { Id: '1', Nombre: 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro' });
  for (const [id, nombre] of [['826', 'BALLANTINES 10'], ['827', 'BALLANTINES 12'], ['1350', 'BOT BALLANTINES'], ['566', 'COCA COLA']]) {
    db.sembrar(tables.agoraProducts, {
      PK: 'GLOBAL', SK: id, Id: id, Name: nombre, FamilyId: '12', FamilyName: 'BOT', FormatoBaseNombre: 'Unidad', Active: true,
    });
  }
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = CONTADOR;
      req.log = { info() {}, error() {}, warn() {} };
      next();
    });
    app.use('/api', crearRouterDictado({ exportStocks: async () => [] }));
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const plantilla = await crearPlantilla({
    nombre: 'Barra', modo: 'familias', miembros: [{ id: '12', nombre: 'BOT' }],
  }, 'compras@test');
  plantillaId = plantilla.plantillaId;
});

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

test('el 10, el diez y el 12 eligen un candidato; un número suelto o Larios 3 no', () => {
  assert.equal(resolverRespuesta('el 10', { candidatos: CANDIDATOS }).productId, '826');
  assert.equal(resolverRespuesta('el diez', { candidatos: CANDIDATOS }).productId, '826');
  assert.equal(resolverRespuesta('el 12', { candidatos: CANDIDATOS }).productId, '827');
  assert.equal(resolverRespuesta('10', { candidatos: CANDIDATOS }), null);
  assert.equal(resolverRespuesta('Larios 3', { candidatos: CANDIDATOS }), null);
  assert.deepEqual(resolverRespuesta('sí', { candidatos: CANDIDATOS }), { tipo: 'si' });
  assert.deepEqual(resolverRespuesta('no', { candidatos: CANDIDATOS }), { tipo: 'no' });
});

test('elegir un producto ya contado sigue pidiendo confirmar', () => {
  const motivos = motivosTrasElegir(['ambiguo', 'marca_ambigua'], { yaContado: true });
  assert.deepEqual(motivos, ['ya_contado']);
  assert.equal(confirmarTrasElegir({ productId: '826', modo: 'sumar', cantidad: { total: 14 } }, motivos), true);
  assert.equal(confirmarTrasElegir({ productId: '826', modo: 'sumar', cantidad: { total: 14 } }, []), false);
});

test('«el 10» resuelve la pregunta y no crea otra línea', async () => {
  const id = await nuevoInventario([['826', 'BALLANTINES 10'], ['827', 'BALLANTINES 12'], ['1350', 'BOT BALLANTINES']]);
  const pregunta = await dictar(id, 'Bot Ballantines 14');
  assert.equal(pregunta.body.lineas[0].productId, null);
  assert.equal(pregunta.body.lineas[0].confirmar, true);
  const r = await dictar(id, 'el 10');
  assert.equal(r.body.lineas.length, 1);
  assert.equal(r.body.lineas[0].n, pregunta.body.lineas[0].n);
  assert.equal(r.body.lineas[0].productId, '826');
  assert.equal(r.body.lineas[0].cantidad.total, 14);
  assert.equal(r.body.lineas[0].confirmar, false);
  assert.equal(lineaConteo(id, '826').stockReal ?? null, null);
  const sesion = await api('GET', ruta(id));
  assert.equal(sesion.body.lineas.length, 1);
});

test('«el 10» de un Ballantines ya contado queda pendiente', async () => {
  const id = await nuevoInventario([
    ['826', 'BALLANTINES 10', { stockReal: 2, botellasAbiertas: 0 }],
    ['827', 'BALLANTINES 12'],
    ['1350', 'BOT BALLANTINES'],
  ]);
  await dictar(id, 'Bot Ballantines 14');
  const r = await dictar(id, 'el 10');
  assert.equal(r.body.lineas[0].productId, '826');
  assert.equal(r.body.lineas[0].confirmar, true);
  assert.equal(lineaConteo(id, '826').stockReal, 2);
});

test('«sí» deja lista la línea ya contada y se aplica con las reglas de siempre', async () => {
  const id = await nuevoInventario([['566', 'COCA COLA', { stockReal: 2, botellasAbiertas: 0 }]]);
  const previa = await dictar(id, 'Coca-Cola 3');
  assert.equal(previa.body.lineas[0].confirmar, true);
  assert.equal(previa.body.lineas[0].productId, '566');
  const r = await dictar(id, 'sí');
  assert.equal(r.body.lineas.length, 1);
  assert.equal(r.body.lineas[0].n, previa.body.lineas[0].n);
  assert.equal(r.body.lineas[0].confirmar, false);
  const ap = await api('POST', ruta(id, '/aplicar'), { lineas: [r.body.lineas[0].n] });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.aplicadas.length, 1);
  assert.equal(lineaConteo(id, '566').stockReal, 5);
});

test('«sí» sin producto no crea una línea ni aplica', async () => {
  const id = await nuevoInventario([['566', 'COCA COLA']]);
  const previa = await dictar(id, 'Phantom tres');
  assert.equal(previa.body.lineas[0].productId, null);
  const r = await dictar(id, 'sí');
  assert.deepEqual(r.body.lineas, []);
  assert.match(String(r.body.aviso), /pendiente/);
  const sesion = await api('GET', ruta(id));
  assert.equal(sesion.body.lineas.length, 1);
  assert.equal(sesion.body.lineas[0].estado, 'pendiente');
});

test('«no» descarta la pregunta', async () => {
  const id = await nuevoInventario([['826', 'BALLANTINES 10'], ['827', 'BALLANTINES 12'], ['1350', 'BOT BALLANTINES']]);
  const pregunta = await dictar(id, 'Bot Ballantines 14');
  const r = await dictar(id, 'no');
  assert.equal(r.body.lineas[0].n, pregunta.body.lineas[0].n);
  assert.equal(r.body.lineas[0].estado, 'descartada');
  const sesion = await api('GET', ruta(id));
  assert.equal(sesion.body.lineas.length, 1);
});

test('un producto nuevo no se confunde con la respuesta a la pregunta', async () => {
  const id = await nuevoInventario([
    ['826', 'BALLANTINES 10'],
    ['827', 'BALLANTINES 12'],
    ['1350', 'BOT BALLANTINES'],
    ['566', 'COCA COLA'],
  ]);
  const pregunta = await dictar(id, 'Bot Ballantines 14');
  const r = await dictar(id, 'Coca-Cola 2');
  assert.equal(r.body.lineas.length, 1);
  assert.equal(r.body.lineas[0].productId, '566');
  assert.notEqual(r.body.lineas[0].n, pregunta.body.lineas[0].n);
  const sesion = await api('GET', ruta(id));
  const abierta = sesion.body.lineas.find((l) => l.n === pregunta.body.lineas[0].n);
  assert.equal(abierta.productId, null);
  assert.equal(abierta.estado, 'pendiente');
});
