/**
 * Las escrituras de los maestros de locales, almacenes y festivos exigen el permiso
 * de su pantalla. Antes cualquier usuario autenticado (p. ej. un encargado de local)
 * podía crear, editar o borrar locales y almacenes, o reescribir los festivos que
 * usan los objetivos de caja.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-maestros-permisos';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { default: localesRouter } = await import('../routes/locales.js');
const { default: almacenesRouter } = await import('../routes/almacenes.js');
const { default: festivosRouter } = await import('../routes/festivos.js');

const ADMINISTRACION = { sub: '000002', email: 'admon@grupo.test', rol: 'Administracion' };
const ENCARGADO = { sub: '000009', email: 'encargado@grupo.test', rol: 'Local' };
const GESTOR_USUARIOS = { sub: '000010', email: 'gestor@grupo.test', rol: 'Gestor' };
const CAJAS = { sub: '000011', email: 'cajas@grupo.test', rol: 'Cajas' };

let usuarioActual = ADMINISTRACION;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual) req.user = usuarioActual;
      next();
    });
    app.use('/api', localesRouter);
    app.use('/api', almacenesRouter);
    app.use('/api', festivosRouter);
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

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(tables.gestionFestivos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const permiso of [
    'locales.crear', 'locales.editar', 'locales.borrar',
    'almacenes.crear', 'almacenes.editar', 'almacenes.borrar',
  ]) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#Administracion', SK: `PERMISO#${permiso}` });
  }
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#locales.ver' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#almacenes.ver' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Gestor', SK: 'PERMISO#usuarios.crear' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Cajas', SK: 'PERMISO#comparativa.ver' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', agoraCode: '7', empresa: 'Norte' });
  db.sembrar(tables.almacenes, { Id: '000001', Nombre: 'General' });
  db.sembrar(tables.gestionFestivos, { PK: 'GLOBAL', SK: 'f1', FechaComparativa: '2026-12-25', Festivo: true, NombreFestivo: 'Navidad' });
  return db;
}

// ─── Locales ───

test('sin locales.* no se crea, edita ni borra un local', async () => {
  const db = montar();
  const crear = await api('POST', '/api/locales', { id_Locales: '20', Nombre: 'Intruso' }, ENCARGADO);
  assert.equal(crear.status, 403);
  assert.equal(db.obtener(tables.locales, { id_Locales: '000020' }), null);

  const editar = await api('PUT', '/api/locales', { id_Locales: '000010', Nombre: 'Bar Centro', AgoraCode: '999' }, ENCARGADO);
  assert.equal(editar.status, 403);
  const borrar = await api('DELETE', '/api/locales', { id_Locales: '000010' }, ENCARGADO);
  assert.equal(borrar.status, 403);
  assert.equal(db.obtener(tables.locales, { id_Locales: '000010' }).agoraCode, '7');
});

test('sin sesión no se escribe en locales', async () => {
  montar();
  assert.equal((await api('POST', '/api/locales', { Nombre: 'X' }, null)).status, 401);
});

test('con locales.crear / editar / borrar el maestro funciona como antes', async () => {
  const db = montar();
  const crear = await api('POST', '/api/locales', { id_Locales: '20', Nombre: 'Nuevo', AgoraCode: '12' }, ADMINISTRACION);
  assert.equal(crear.status, 200);
  assert.equal(db.obtener(tables.locales, { id_Locales: '000020' }).agoraCode, '12');

  const editar = await api('PUT', '/api/locales', { id_Locales: '000020', Nombre: 'Nuevo 2' }, ADMINISTRACION);
  assert.equal(editar.status, 200);
  assert.equal(db.obtener(tables.locales, { id_Locales: '000020' }).nombre, 'Nuevo 2');

  const borrar = await api('DELETE', '/api/locales', { id_Locales: '000020' }, ADMINISTRACION);
  assert.equal(borrar.status, 200);
  assert.equal(db.obtener(tables.locales, { id_Locales: '000020' }), null);
});

test('la creación rápida desde Usuarios funciona con usuarios.crear, pero solo guarda nombre y sede', async () => {
  const db = montar();
  const r = await api('POST', '/api/locales', {
    id_Locales: '21',
    Nombre: 'Terraza',
    Sede: 'Grupo Paripe',
    AgoraCode: '7',
    id_empresa: '3',
  }, GESTOR_USUARIOS);
  assert.equal(r.status, 200);
  const guardado = db.obtener(tables.locales, { id_Locales: '000021' });
  assert.equal(guardado.nombre, 'Terraza');
  assert.equal(guardado.sede, 'Grupo Paripe');
  assert.equal(guardado.agoraCode, '');
  assert.equal(guardado.id_empresa, '');

  assert.equal((await api('PUT', '/api/locales', { id_Locales: '000021', Nombre: 'Otro' }, GESTOR_USUARIOS)).status, 403);
  assert.equal((await api('DELETE', '/api/locales', { id_Locales: '000021' }, GESTOR_USUARIOS)).status, 403);
});

test('PUT de un local inexistente devuelve 404 y no lo crea (locales.editar no sirve para crear)', async () => {
  const db = montar();
  const r = await api('PUT', '/api/locales', { id_Locales: '000099', Nombre: 'Colado', AgoraCode: '5' }, ADMINISTRACION);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Local no encontrado');
  assert.equal(db.obtener(tables.locales, { id_Locales: '000099' }), null);
  assert.equal(db.listar(tables.locales).length, 1);
});

test('el listado de locales sigue abierto a cualquier usuario autenticado', async () => {
  montar();
  const r = await api('GET', '/api/locales', undefined, ENCARGADO);
  assert.equal(r.status, 200);
  assert.equal(r.body.locales.length, 1);
});

// ─── Almacenes ───

test('sin almacenes.* no se crea, edita ni borra un almacén', async () => {
  const db = montar();
  assert.equal((await api('POST', '/api/almacenes', { Id: '2', Nombre: 'X' }, ENCARGADO)).status, 403);
  assert.equal(db.obtener(tables.almacenes, { Id: '000002' }), null);
  assert.equal((await api('PUT', '/api/almacenes', { Id: '000001', Nombre: 'Pisado' }, ENCARGADO)).status, 403);
  assert.equal((await api('DELETE', '/api/almacenes', { Id: '000001' }, ENCARGADO)).status, 403);
  assert.equal(db.obtener(tables.almacenes, { Id: '000001' }).Nombre, 'General');
  assert.equal((await api('GET', '/api/almacenes', undefined, ENCARGADO)).status, 200);
});

test('con almacenes.crear / editar / borrar el maestro funciona como antes', async () => {
  const db = montar();
  assert.equal((await api('POST', '/api/almacenes', { Id: '2', Nombre: 'Bebidas' }, ADMINISTRACION)).status, 200);
  assert.equal((await api('PUT', '/api/almacenes', { Id: '000002', Nombre: 'Bebidas 2' }, ADMINISTRACION)).status, 200);
  assert.equal(db.obtener(tables.almacenes, { Id: '000002' }).Nombre, 'Bebidas 2');
  assert.equal((await api('DELETE', '/api/almacenes', { Id: '000002' }, ADMINISTRACION)).status, 200);
  assert.equal(db.obtener(tables.almacenes, { Id: '000002' }), null);
});

test('POST de almacén con un Id ya usado devuelve 409 y no pisa el existente', async () => {
  const db = montar();
  const r = await api('POST', '/api/almacenes', { Id: '1', Nombre: 'Pisado', Cif: 'B000' }, ADMINISTRACION);
  assert.equal(r.status, 409);
  assert.deepEqual(db.obtener(tables.almacenes, { Id: '000001' }), { Id: '000001', Nombre: 'General' });
});

test('POST de almacén sin Id devuelve 400 y no escribe nada', async () => {
  const db = montar();
  for (const Id of [undefined, '', '  ']) {
    const r = await api('POST', '/api/almacenes', { Id, Nombre: 'Sin id' }, ADMINISTRACION);
    assert.equal(r.status, 400);
  }
  assert.equal(db.obtener(tables.almacenes, { Id: '000000' }), null);
  assert.equal(db.listar(tables.almacenes).length, 1);
});

test('PUT de un almacén inexistente devuelve 404 y no lo crea (almacenes.editar no sirve para crear)', async () => {
  const db = montar();
  const r = await api('PUT', '/api/almacenes', { Id: '000077', Nombre: 'Colado' }, ADMINISTRACION);
  assert.equal(r.status, 404);
  assert.equal(db.obtener(tables.almacenes, { Id: '000077' }), null);
  assert.equal(db.listar(tables.almacenes).length, 1);
});

// ─── Festivos ───

test('sin comparativa.ver no se escriben festivos', async () => {
  const db = montar();
  assert.equal((await api('POST', '/api/gestion-festivos', { FechaComparativa: '2026-01-01' }, ENCARGADO)).status, 403);
  assert.equal((await api('PUT', '/api/gestion-festivos', { id: 'GLOBAL#f1', FechaComparativa: '2026-12-25', Festivo: false }, ENCARGADO)).status, 403);
  assert.equal((await api('DELETE', '/api/gestion-festivos?id=GLOBAL%23f1', undefined, ENCARGADO)).status, 403);
  assert.equal((await api('POST', '/api/gestion-festivos/generar-rango', { dateFrom: '2026-01-01', dateTo: '2026-01-02' }, ENCARGADO)).status, 403);
  assert.equal(db.obtener(tables.gestionFestivos, { PK: 'GLOBAL', SK: 'f1' }).Festivo, true);
  assert.equal(db.listar(tables.gestionFestivos).length, 1);
  assert.equal((await api('GET', '/api/gestion-festivos', undefined, ENCARGADO)).status, 200);
});

test('con comparativa.ver (pantalla Comparativa fechas) se escriben festivos', async () => {
  const db = montar();
  const editar = await api('PUT', '/api/gestion-festivos', { id: 'GLOBAL#f1', FechaComparativa: '2026-12-25', Festivo: false }, CAJAS);
  assert.equal(editar.status, 200);
  assert.equal(db.obtener(tables.gestionFestivos, { PK: 'GLOBAL', SK: 'f1' }).Festivo, false);
  assert.equal((await api('POST', '/api/gestion-festivos/generar-rango', { dateFrom: '2026-01-01', dateTo: '2026-01-02' }, CAJAS)).status, 200);
  assert.equal((await api('DELETE', '/api/gestion-festivos?id=GLOBAL%23f1', undefined, CAJAS)).status, 200);
});
