/**
 * Lecturas por local según `ALCANCE_MODO_LECTURAS` (`lib/alcanceLecturas.js` y
 * `requireLocalLectura`): 'observar' sirve todo y avisa; 'bloquear' filtra o da 403.
 */

import test, { after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-lecturas';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales, modoLecturas } = await import('../lib/alcance.js');
const { filtrarLecturaPorLocal, permiteLecturaLocal, workplacesLectura } = await import('../lib/alcanceLecturas.js');
const { requireLocalLectura, desde } = await import('../middleware/alcance.js');

const ENCARGADO = { sub: '000050', email: 'local@grupo.test', rol: 'Local' };
const OFICINA = { sub: '000051', email: 'oficina@grupo.test', rol: 'SuperUser' };
const SIN_LOCALES_EN_MAESTRO = { sub: '000052', email: 'raro@grupo.test', rol: 'Local' };

const MODO_ORIGINAL = process.env.ALCANCE_MODO_LECTURAS;
function modo(valor) {
  if (valor === undefined) delete process.env.ALCANCE_MODO_LECTURAS;
  else process.env.ALCANCE_MODO_LECTURAS = valor;
}
afterEach(() => modo(MODO_ORIGINAL));

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.sembrar(tables.locales, { id_Locales: '000001', nombre: 'PARIPE', agoraCode: '101' });
  db.sembrar(tables.locales, { id_Locales: '000002', nombre: 'SUR', agoraCode: '202' });
  db.sembrar(tables.usuarios, { id_usuario: '000050', Email: 'local@grupo.test', Rol: 'Local', Local: ['PARIPE'] });
  db.sembrar(tables.usuarios, { id_usuario: '000051', Email: 'oficina@grupo.test', Rol: 'SuperUser', Local: [] });
  db.sembrar(tables.usuarios, { id_usuario: '000052', Email: 'raro@grupo.test', Rol: 'Local', Local: ['NO EXISTE'] });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  return db;
}

async function conAvisos(fn) {
  const avisos = [];
  const original = console.warn;
  console.warn = (...args) => avisos.push(args);
  try {
    return { resultado: await fn(), avisos };
  } finally {
    console.warn = original;
  }
}

const peticion = (user) => ({ user, method: 'GET', originalUrl: '/api/x?workplaceId=202' });
const FILAS = [{ PK: '101', importe: 1 }, { PK: '202', importe: 2 }];
const refFila = (f) => ({ workplaceId: f.PK });

test('modoLecturas: por defecto observar; solo «bloquear» bloquea', () => {
  modo(undefined);
  assert.equal(modoLecturas(), 'observar');
  modo('cualquiera');
  assert.equal(modoLecturas(), 'observar');
  modo(' Bloquear ');
  assert.equal(modoLecturas(), 'bloquear');
});

test('filtrarLecturaPorLocal en observar: devuelve todo y avisa sin datos del registro', async () => {
  montar();
  modo(undefined);
  const { resultado, avisos } = await conAvisos(() => filtrarLecturaPorLocal(peticion(ENCARGADO), FILAS, refFila));
  assert.equal(resultado.length, 2);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0][0], '[alcance] denegaría');
  assert.deepEqual(avisos[0][1], { ruta: '/api/x', usuario: '000050', locales: ['202'] });
});

test('filtrarLecturaPorLocal en bloquear: solo los del propio local, sin aviso', async () => {
  montar();
  modo('bloquear');
  const { resultado, avisos } = await conAvisos(() => filtrarLecturaPorLocal(peticion(ENCARGADO), FILAS, refFila));
  assert.deepEqual(resultado.map((f) => f.PK), ['101']);
  assert.equal(avisos.length, 0);
});

test('filtrarLecturaPorLocal: global e interno no se filtran en ningún modo', async () => {
  montar();
  modo('bloquear');
  assert.equal((await filtrarLecturaPorLocal(peticion(OFICINA), FILAS, refFila)).length, 2);
  assert.equal((await filtrarLecturaPorLocal({ isInternal: true }, FILAS, refFila)).length, 2);
});

test('permiteLecturaLocal: observar deja pasar con aviso; bloquear deniega el ajeno', async () => {
  montar();
  modo(undefined);
  const obs = await conAvisos(() => permiteLecturaLocal(peticion(ENCARGADO), { workplaceId: '202' }));
  assert.equal(obs.resultado, true);
  assert.equal(obs.avisos.length, 1);
  modo('bloquear');
  assert.equal(await permiteLecturaLocal(peticion(ENCARGADO), { workplaceId: '202' }), false);
  assert.equal(await permiteLecturaLocal(peticion(ENCARGADO), { workplaceId: '101' }), true);
  assert.equal(await permiteLecturaLocal(peticion(OFICINA), { workplaceId: '202' }), true);
});

test('workplacesLectura en bloquear: interseca, la lista vacía pasa a los suyos y sin ninguno es null', async () => {
  montar();
  modo('bloquear');
  assert.deepEqual(await workplacesLectura(peticion(ENCARGADO), ['101', '202']), ['101']);
  assert.deepEqual(await workplacesLectura(peticion(ENCARGADO), []), ['101']);
  assert.equal(await workplacesLectura(peticion(ENCARGADO), ['202']), null);
  assert.equal(await workplacesLectura(peticion(SIN_LOCALES_EN_MAESTRO), []), null);
  assert.deepEqual(await workplacesLectura(peticion(OFICINA), []), []);
});

test('workplacesLectura en observar: devuelve lo pedido y avisa (vacía = todos)', async () => {
  montar();
  modo(undefined);
  const ajeno = await conAvisos(() => workplacesLectura(peticion(ENCARGADO), ['101', '202']));
  assert.deepEqual(ajeno.resultado, ['101', '202']);
  assert.deepEqual(ajeno.avisos[0][1].locales, ['202']);
  const todos = await conAvisos(() => workplacesLectura(peticion(ENCARGADO), []));
  assert.deepEqual(todos.resultado, []);
  assert.deepEqual(todos.avisos[0][1].locales, ['*']);
  const propio = await conAvisos(() => workplacesLectura(peticion(ENCARGADO), ['101']));
  assert.equal(propio.avisos.length, 0);
});

// ─── requireLocalLectura ───

let usuarioActual = ENCARGADO;
let servidor = null;
let base = '';

async function get(ruta, usuario) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
    app.get('/lectura', requireLocalLectura(desde.query('workplaceId')), (_req, res) => res.json({ ok: true }));
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta);
  return res.status;
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

test('requireLocalLectura: el modo se lee en cada petición', async () => {
  montar();
  modo(undefined);
  const obs = await conAvisos(() => get('/lectura?workplaceId=202', ENCARGADO));
  assert.equal(obs.resultado, 200);
  assert.equal(obs.avisos.length, 1);
  assert.deepEqual(obs.avisos[0][1], { ruta: '/lectura', usuario: '000050', locales: ['202'] });

  modo('bloquear');
  assert.equal(await get('/lectura?workplaceId=202', ENCARGADO), 403);
  assert.equal(await get('/lectura', ENCARGADO), 403);
  assert.equal(await get('/lectura?workplaceId=101', ENCARGADO), 200);
  assert.equal(await get('/lectura?workplaceId=202', OFICINA), 200);
});
