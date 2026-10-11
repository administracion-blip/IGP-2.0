/**
 * Incidencias de mantenimiento y Mystery Guest exigen el permiso de su pantalla.
 * Antes cualquier usuario autenticado podía listar todas las incidencias del grupo,
 * crearlas en cualquier local, cambiarles fecha o estado, borrarlas, y leer o dar
 * de alta auditorías de Mystery Guest.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-mantenimiento-mystery';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { default: mantenimientoRouter } = await import('../routes/mantenimiento.js');
const { default: mysteryGuestRouter } = await import('../routes/mysteryGuest.js');
const { mgTodosLosIdsPregunta } = await import('../lib/mysteryGuestCuestionario.js');

const ENCARGADO = { sub: '000009', email: 'encargado@grupo.test', rol: 'Local' };
const TECNICO = { sub: '000012', email: 'tecnico@grupo.test', rol: 'Mantenimiento' };
const ADMINISTRACION = { sub: '000002', email: 'admon@grupo.test', rol: 'Administracion' };
const REPORTERO = { sub: '000013', email: 'reporta@grupo.test', rol: 'Reportero' };
const SOCIO = { sub: '000014', email: 'socio@grupo.test', rol: 'Socio' };

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
    app.use('/api', mantenimientoRouter);
    app.use('/api', mysteryGuestRouter);
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

const FECHA_INC = '2026-09-01T10:00:00.000Z';
const CLAVE_INC = { PK: 'LOCAL#000010', SK: `INC#${FECHA_INC}#inc-1` };
const REF_INC = { local_id: '000010', id_incidencia: 'inc-1', fecha_creacion: FECHA_INC };

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.mantenimiento, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.mysteryGuest, { hashKey: 'ud_mysteryguest' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const permiso of ['mantenimiento.ver', 'mantenimiento.crear', 'mantenimiento.editar']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#Mantenimiento', SK: `PERMISO#${permiso}` });
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#Administracion', SK: `PERMISO#${permiso}` });
  }
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Administracion', SK: 'PERMISO#mantenimiento.borrar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Reportero', SK: 'PERMISO#mantenimiento.crear' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#planning_dia.ver' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Socio', SK: 'PERMISO#mystery_guest.ver' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro' });
  db.sembrar(tables.mantenimiento, {
    ...CLAVE_INC,
    tipo: 'INC',
    id_incidencia: 'inc-1',
    fecha_creacion: FECHA_INC,
    local_id: '000010',
    zona: 'barra',
    categoria: 'otros',
    titulo: 'Grifo roto',
    estado: 'Programado',
    fecha_programada: '2099-01-01',
  });
  db.sembrar(tables.mysteryGuest, { ud_mysteryguest: 'mg-1', Fecha: '2026-09-01', FechaDia: '2026-09-01', LocalId: '000010' });
  return db;
}

const NUEVA = { local_id: '000010', zona: 'barra', categoria: 'otros', titulo: 'Cámara no enfría' };

// ─── Mantenimiento ───

test('sin permisos de mantenimiento ninguna ruta de incidencias responde', async () => {
  const db = montar();
  const antes = db.listar(tables.mantenimiento);
  const peticiones = [
    ['GET', '/api/mantenimiento/incidencias', undefined],
    ['POST', '/api/mantenimiento/incidencias', NUEVA],
    ['POST', '/api/mantenimiento/incidencias/similares', NUEVA],
    ['POST', '/api/mantenimiento/incidencias/lote', { ...NUEVA, local_ids: ['000010'], fechas_programadas: ['2099-02-01'] }],
    ['PATCH', '/api/mantenimiento/incidencias', { ...REF_INC, fecha_programada: null }],
    ['DELETE', '/api/mantenimiento/incidencias', REF_INC],
  ];
  for (const [metodo, ruta, cuerpo] of peticiones) {
    const r = await api(metodo, ruta, cuerpo, ENCARGADO);
    assert.equal(r.status, 403, `${metodo} ${ruta}`);
    assert.equal(r.body.incidencias, undefined);
  }
  assert.deepEqual(db.listar(tables.mantenimiento), antes);
});

test('el rol de mantenimiento lista, crea, programa en lote y edita incidencias', async () => {
  const db = montar();
  const lista = await api('GET', '/api/mantenimiento/incidencias', undefined, TECNICO);
  assert.equal(lista.status, 200);
  assert.equal(lista.body.incidencias.length, 1);

  assert.equal((await api('POST', '/api/mantenimiento/incidencias/similares', NUEVA, TECNICO)).status, 200);
  assert.equal((await api('POST', '/api/mantenimiento/incidencias', NUEVA, TECNICO)).status, 200);
  const lote = await api('POST', '/api/mantenimiento/incidencias/lote', { ...NUEVA, local_ids: ['000010'], fechas_programadas: ['2099-02-01'] }, TECNICO);
  assert.equal(lote.status, 200);
  assert.equal(lote.body.creados, 1);

  const desprogramar = await api('PATCH', '/api/mantenimiento/incidencias', { ...REF_INC, fecha_programada: null }, TECNICO);
  assert.equal(desprogramar.status, 200);
  assert.equal(db.obtener(tables.mantenimiento, CLAVE_INC).estado, 'Nuevo');
});

test('borrar una incidencia exige mantenimiento.borrar', async () => {
  const db = montar();
  assert.equal((await api('DELETE', '/api/mantenimiento/incidencias', REF_INC, TECNICO)).status, 403);
  assert.ok(db.obtener(tables.mantenimiento, CLAVE_INC));
  assert.equal((await api('DELETE', '/api/mantenimiento/incidencias', REF_INC, ADMINISTRACION)).status, 200);
  assert.equal(db.obtener(tables.mantenimiento, CLAVE_INC), null);
});

test('con solo mantenimiento.crear (Reportar incidencia del planning) se reporta y se ve el listado, pero no se edita', async () => {
  const db = montar();
  assert.equal((await api('POST', '/api/mantenimiento/incidencias/similares', NUEVA, REPORTERO)).status, 200);
  assert.equal((await api('POST', '/api/mantenimiento/incidencias', NUEVA, REPORTERO)).status, 200);
  assert.equal((await api('GET', '/api/mantenimiento/incidencias', undefined, REPORTERO)).status, 200);
  assert.equal((await api('PATCH', '/api/mantenimiento/incidencias', { ...REF_INC, fecha_programada: null }, REPORTERO)).status, 403);
  assert.equal(db.obtener(tables.mantenimiento, CLAVE_INC).estado, 'Programado');
});

// ─── Mystery Guest ───

function respuestasCompletas() {
  return Object.fromEntries(mgTodosLosIdsPregunta().map((id) => [id, 4]));
}

test('sin mystery_guest.ver no se leen ni se crean auditorías', async () => {
  const db = montar();
  const leer = await api('GET', '/api/mystery-guest?fechaDesde=2026-09-01&fechaHasta=2026-09-30', undefined, ENCARGADO);
  assert.equal(leer.status, 403);
  assert.equal(leer.body.valoraciones, undefined);
  const crear = await api('POST', '/api/mystery-guest', { Fecha: '2026-09-02T20:00:00.000Z', LocalId: '000010', Respuestas: respuestasCompletas() }, ENCARGADO);
  assert.equal(crear.status, 403);
  assert.equal(db.listar(tables.mysteryGuest).length, 1);
});

test('con mystery_guest.ver se leen y se crean auditorías', async () => {
  const db = montar();
  const leer = await api('GET', '/api/mystery-guest?fechaDesde=2026-09-01&fechaHasta=2026-09-30', undefined, SOCIO);
  assert.equal(leer.status, 200);
  assert.equal(leer.body.valoraciones.length, 1);
  const crear = await api('POST', '/api/mystery-guest', { Fecha: '2026-09-02T20:00:00.000Z', LocalId: '000010', Respuestas: respuestasCompletas() }, SOCIO);
  assert.equal(crear.status, 200);
  assert.equal(db.listar(tables.mysteryGuest).length, 2);
});
