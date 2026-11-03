/**
 * Tramos por HTTP: guardar, marcar la fila del hueco, heredar y simular
 * la previsión del rango sin escribir.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-tramos-mia';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { invalidarPermisosRol } = await import('../lib/permisos/cachePermisos.js');
const { fechaComparacion } = await import('../lib/agora/objetivoMensual.js');
const { MENSAJE_SIN_LOCAL } = await import('../lib/mia/calculoStock.js');
const { PK_MIA_TRAMOS } = await import('../lib/mia/tramos.js');
const { default: miaRouter } = await import('../routes/mia.js');

const COMPRADOR = { sub: '000080', email: 'compras@grupo.test', rol: 'SuperUser' };
const OFICINA = { sub: '000081', email: 'oficina@grupo.test', rol: 'SuperUser' };
const CAMARERO = { sub: '000082', email: 'sala@grupo.test', rol: 'Camarero' };

const VALIDOS = [
  { desde: 0, hasta: 20000, multiplicador: 1 },
  { desde: 20000, hasta: 35000, multiplicador: 2 },
  { desde: 35000, hasta: null, multiplicador: 3 },
];

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
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.salesCloseOuts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.gestionFestivos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const p of ['ver', 'configurar', 'calcular']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#SuperUser', SK: `PERMISO#mia.${p}` });
  }
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Camarero', SK: 'PERMISO#mia.ver' });
  db.sembrar(tables.almacenes, { Id: '101', Nombre: 'Almacen Centro' });
  db.sembrar(tables.almacenes, { Id: '202', Nombre: 'Almacen Sur' });
  db.sembrar(tables.almacenes, { Id: '303', Nombre: 'Almacen Isla' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', agoraCode: '101', 'almacen origen': 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000011', nombre: 'Bar Terraza', agoraCode: '102', 'almacen origen': 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur', agoraCode: '202', 'almacen origen': 'Almacen Sur' });
  db.sembrar(tables.usuarios, { id_usuario: '000080', Email: COMPRADOR.email, Rol: 'SuperUser', Local: ['Bar Centro'] });
  db.sembrar(tables.usuarios, { id_usuario: '000081', Email: OFICINA.email, Rol: 'SuperUser', Local: [] });
  db.sembrar(tables.usuarios, { id_usuario: '000082', Email: CAMARERO.email, Rol: 'Camarero', Local: ['Bar Centro'] });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  invalidarPermisosRol();
}

function cierre(pk, fecha, amount) {
  return { PK: pk, SK: `${fecha}#1#1`, InvoicePayments: [{ Amount: amount }] };
}

function tramosGuardados() {
  return db.listar(tables.ajustes).filter((it) => it.PK === PK_MIA_TRAMOS);
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

test('guarda un conjunto válido y un hueco marca la fila sin escribir', async () => {
  montar();
  const ok = await api('PUT', '/api/mia/tramos', { tramos: VALIDOS });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ambito, 'GLOBAL');
  assert.equal(ok.body.tramos.length, 3);
  assert.equal(ok.body.tramos[2].hasta, null);

  const desorden = await api('PUT', '/api/mia/tramos', {
    tramos: [
      { desde: 150, hasta: null, multiplicador: 2 },
      { desde: 0, hasta: 100, multiplicador: 1 },
    ],
  });
  assert.equal(desorden.status, 400);
  assert.match(desorden.body.error, /hueco/);
  assert.equal(desorden.body.indice, 0);
  assert.equal(tramosGuardados().length, 3);

  const solape = await api('PUT', '/api/mia/tramos', {
    warehouseId: '101',
    tramos: [
      { desde: 0, hasta: 100, multiplicador: 1 },
      { desde: 50, hasta: null, multiplicador: 2 },
    ],
  });
  assert.equal(solape.status, 400);
  assert.match(solape.body.error, /solapan/);
  assert.equal(solape.body.indice, 1);
  assert.equal(tramosGuardados().filter((it) => String(it.SK).startsWith('000101#')).length, 0);
});

test('un almacén sin tramos hereda los globales y quitar los propios vuelve a heredar', async () => {
  montar();
  await api('PUT', '/api/mia/tramos', { tramos: VALIDOS });
  const heredado = await api('GET', '/api/mia/tramos?warehouseId=101');
  assert.equal(heredado.status, 200, JSON.stringify(heredado.body));
  assert.equal(heredado.body.heredados, true);
  assert.equal(heredado.body.tramos.length, 3);
  assert.equal(heredado.body.tramos[1].multiplicador, 2);

  const propios = await api('PUT', '/api/mia/tramos', {
    warehouseId: '101',
    tramos: [
      { desde: 0, hasta: 1000, multiplicador: 1 },
      { desde: 1000, hasta: null, multiplicador: 4 },
    ],
  });
  assert.equal(propios.status, 200, JSON.stringify(propios.body));
  assert.equal(propios.body.heredados, false);
  assert.equal(propios.body.tramos[1].multiplicador, 4);

  const quitados = await api('DELETE', '/api/mia/tramos?warehouseId=101');
  assert.equal(quitados.status, 200, JSON.stringify(quitados.body));
  assert.equal(quitados.body.heredados, true);
  assert.equal(quitados.body.tramos[1].multiplicador, 2);
  assert.equal(tramosGuardados().filter((it) => String(it.SK).startsWith('000101#')).length, 0);
  assert.equal(tramosGuardados().filter((it) => String(it.SK).startsWith('GLOBAL#')).length, 3);

  const global = await api('DELETE', '/api/mia/tramos');
  assert.equal(global.status, 400);
  assert.equal(tramosGuardados().filter((it) => String(it.SK).startsWith('GLOBAL#')).length, 3);
});

test('sin permiso o con almacén ajeno: 403 y no escribe', async () => {
  montar();
  await api('PUT', '/api/mia/tramos', { tramos: VALIDOS });
  const lectura = await api('PUT', '/api/mia/tramos', {
    warehouseId: '101',
    tramos: [{ desde: 0, hasta: null, multiplicador: 9 }],
  }, CAMARERO);
  assert.equal(lectura.status, 403);
  assert.equal(lectura.body.error, 'Permiso insuficiente');
  const ajeno = await api('GET', '/api/mia/tramos?warehouseId=202');
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.body.error, 'No tienes acceso a este local');
  const ajenoPut = await api('PUT', '/api/mia/tramos', {
    warehouseId: '202',
    tramos: [{ desde: 0, hasta: null, multiplicador: 9 }],
  });
  assert.equal(ajenoPut.status, 403);
  assert.equal(tramosGuardados().filter((it) => String(it.ambito) === '000202').length, 0);
});

test('simular devuelve la previsión del rango por local y no escribe', async () => {
  montar();
  await api('PUT', '/api/mia/tramos', {
    tramos: [
      { desde: 0, hasta: 50, multiplicador: 1 },
      { desde: 50, hasta: null, multiplicador: 2 },
    ],
  });
  const antes = tramosGuardados().length;
  const dia1 = fechaComparacion('2026-02-01');
  const dia2 = fechaComparacion('2026-02-02');
  db.sembrar(tables.salesCloseOuts, cierre('101', dia1, 30));
  db.sembrar(tables.salesCloseOuts, cierre('102', dia1, 40));
  db.sembrar(tables.salesCloseOuts, cierre('101', dia2, 1));
  db.sembrar(tables.salesCloseOuts, cierre('102', dia2, 2));
  db.sembrar(tables.salesCloseOuts, cierre('202', dia1, 999));

  const r = await api('POST', '/api/mia/tramos/simular', {
    warehouseId: '101',
    semanasDesde: '2026-02-01',
    semanasHasta: '2026-02-02',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.previsionImporte, 73);
  assert.equal(r.body.rangoDesde, '2026-02-01');
  assert.equal(r.body.rangoHasta, '2026-02-02');
  assert.equal(r.body.desglose.length, 4);
  assert.equal(r.body.multiplicador, 2);
  assert.equal(r.body.heredados, true);
  const porLocal = {};
  for (const linea of r.body.desglose) {
    porLocal[linea.localNombre] = (porLocal[linea.localNombre] || 0) + linea.importe;
  }
  assert.equal(porLocal['Bar Centro'], 31);
  assert.equal(porLocal['Bar Terraza'], 42);
  assert.equal(tramosGuardados().length, antes);

  const isla = await api('POST', '/api/mia/tramos/simular', {
    warehouseId: '303',
    semanasDesde: '2026-02-01',
    semanasHasta: '2026-02-02',
  }, OFICINA);
  assert.equal(isla.status, 200, JSON.stringify(isla.body));
  assert.equal(isla.body.previsionImporte, 0);
  assert.equal(isla.body.aviso, MENSAJE_SIN_LOCAL);
  assert.deepEqual(isla.body.desglose, []);

  const ajeno = await api('POST', '/api/mia/tramos/simular', {
    warehouseId: '202',
    semanasDesde: '2026-02-01',
    semanasHasta: '2026-02-02',
  });
  assert.equal(ajeno.status, 403);
  const sinPermiso = await api('POST', '/api/mia/tramos/simular', {
    warehouseId: '101',
    semanasDesde: '2026-02-01',
    semanasHasta: '2026-02-02',
  }, CAMARERO);
  assert.equal(sinPermiso.status, 403);
});
