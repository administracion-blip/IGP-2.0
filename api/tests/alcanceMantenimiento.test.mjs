/**
 * Aislamiento por local en incidencias de mantenimiento. Un técnico con todos los
 * permisos de mantenimiento pero solo con «Bar Centro» intenta crear, programar en
 * lote, editar, borrar y listar incidencias de «Bar Sur».
 *
 * Escrituras: bloquean siempre. Lecturas: siguen `ALCANCE_MODO_LECTURAS`.
 */

import test, { after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alcance-mantenimiento';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: mantenimientoRouter } = await import('../routes/mantenimiento.js');

const TECNICO_CENTRO = { sub: '000060', email: 'tecnico@grupo.test', rol: 'Mantenimiento' };
const OFICINA = { sub: '000061', email: 'oficina@grupo.test', rol: 'Mantenimiento' };

const MODO_ORIGINAL = process.env.ALCANCE_MODO_LECTURAS;
function modo(valor) {
  if (valor === undefined) delete process.env.ALCANCE_MODO_LECTURAS;
  else process.env.ALCANCE_MODO_LECTURAS = valor;
}
afterEach(() => modo(MODO_ORIGINAL));

let usuarioActual = TECNICO_CENTRO;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario = TECNICO_CENTRO) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
    app.use('/api', mantenimientoRouter);
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

async function conAvisos(fn) {
  const avisos = [];
  const original = console.warn;
  console.warn = (...args) => {
    if (args[0] === '[alcance] denegaría') avisos.push(args[1]);
  };
  try {
    return { r: await fn(), avisos };
  } finally {
    console.warn = original;
  }
}

const FECHA = '2026-09-01T10:00:00.000Z';
const CLAVE_CENTRO = { PK: 'LOCAL#000010', SK: `INC#${FECHA}#inc-centro` };
const CLAVE_SUR = { PK: 'LOCAL#000020', SK: `INC#${FECHA}#inc-sur` };
const REF_CENTRO = { local_id: '000010', id_incidencia: 'inc-centro', fecha_creacion: FECHA };
const REF_SUR = { local_id: '000020', id_incidencia: 'inc-sur', fecha_creacion: FECHA };
const NUEVA = { zona: 'barra', categoria: 'otros', titulo: 'Cámara no enfría' };

let db = null;

function incidencia(clave, localId, id) {
  return {
    ...clave,
    tipo: 'INC',
    id_incidencia: id,
    fecha_creacion: FECHA,
    local_id: localId,
    zona: 'barra',
    categoria: 'otros',
    titulo: 'Cámara no enfría',
    estado: 'Programado',
    fecha_programada: '2099-01-01',
  };
}

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.mantenimiento, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const p of ['ver', 'crear', 'editar', 'borrar']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#Mantenimiento', SK: `PERMISO#mantenimiento.${p}` });
  }
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro' });
  db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur' });
  db.sembrar(tables.usuarios, { id_usuario: '000060', Email: TECNICO_CENTRO.email, Rol: 'Mantenimiento', Local: ['Bar Centro'] });
  db.sembrar(tables.usuarios, { id_usuario: '000061', Email: OFICINA.email, Rol: 'Mantenimiento', Local: [] });
  db.sembrar(tables.mantenimiento, incidencia(CLAVE_CENTRO, '000010', 'inc-centro'));
  db.sembrar(tables.mantenimiento, incidencia(CLAVE_SUR, '000020', 'inc-sur'));
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  return db;
}

// ─── Escrituras: bloquean ───

test('crear una incidencia en un local ajeno: 403 y no se escribe (local_id o id_Locales)', async () => {
  montar();
  const antes = db.listar(tables.mantenimiento);
  for (const cuerpo of [{ ...NUEVA, local_id: '000020' }, { ...NUEVA, id_Locales: '000020' }]) {
    const r = await api('POST', '/api/mantenimiento/incidencias', cuerpo);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'No tienes acceso a este local');
  }
  assert.deepEqual(db.listar(tables.mantenimiento), antes);
});

test('similares de un local ajeno: 403 sin devolver sus incidencias', async () => {
  montar();
  const r = await api('POST', '/api/mantenimiento/incidencias/similares', { ...NUEVA, local_id: '000020' });
  assert.equal(r.status, 403);
  assert.equal(r.body.similares, undefined);
});

test('lote con un local ajeno: 403 y no se escribe ninguna incidencia, tampoco las del propio', async () => {
  montar();
  const antes = db.listar(tables.mantenimiento);
  const r = await api('POST', '/api/mantenimiento/incidencias/lote', {
    ...NUEVA,
    local_ids: ['000010', '000020'],
    fechas_programadas: ['2099-02-01', '2099-02-08'],
  });
  assert.equal(r.status, 403);
  assert.deepEqual(db.listar(tables.mantenimiento), antes);
});

test('editar una incidencia de un local ajeno: 403 y queda igual (programar, campos, cronómetro)', async () => {
  montar();
  const antes = db.obtener(tables.mantenimiento, CLAVE_SUR);
  for (const cambio of [
    { fecha_programada: null },
    { editar_campos: true, titulo: 'Cambiado' },
    { iniciar_trabajo: true },
    { marcar_reparado: true },
  ]) {
    const r = await api('PATCH', '/api/mantenimiento/incidencias', { ...REF_SUR, ...cambio });
    assert.equal(r.status, 403, JSON.stringify(cambio));
  }
  assert.deepEqual(db.obtener(tables.mantenimiento, CLAVE_SUR), antes);
});

test('borrar una incidencia de un local ajeno: 403 y sigue ahí', async () => {
  montar();
  const r = await api('DELETE', '/api/mantenimiento/incidencias', REF_SUR);
  assert.equal(r.status, 403);
  assert.ok(db.obtener(tables.mantenimiento, CLAVE_SUR));
});

test('en su propio local crea, programa en lote, edita y borra', async () => {
  montar();
  assert.equal((await api('POST', '/api/mantenimiento/incidencias', { ...NUEVA, local_id: '000010' })).status, 200);
  const lote = await api('POST', '/api/mantenimiento/incidencias/lote', { ...NUEVA, local_ids: ['000010'], fechas_programadas: ['2099-02-01'] });
  assert.equal(lote.status, 200);
  assert.equal(lote.body.creados, 1);
  assert.equal((await api('PATCH', '/api/mantenimiento/incidencias', { ...REF_CENTRO, fecha_programada: null })).status, 200);
  assert.equal(db.obtener(tables.mantenimiento, CLAVE_CENTRO).estado, 'Nuevo');
  assert.equal((await api('DELETE', '/api/mantenimiento/incidencias', REF_CENTRO)).status, 200);
  assert.equal(db.obtener(tables.mantenimiento, CLAVE_CENTRO), null);
});

test('con alcance global (Local vacío) escribe en cualquier local', async () => {
  montar();
  assert.equal((await api('PATCH', '/api/mantenimiento/incidencias', { ...REF_SUR, fecha_programada: null }, OFICINA)).status, 200);
  assert.equal(db.obtener(tables.mantenimiento, CLAVE_SUR).estado, 'Nuevo');
});

// ─── Lecturas: modo observación / bloqueo ───

test('listado en observar: devuelve todo y avisa del local ajeno', async () => {
  montar();
  modo(undefined);
  const { r, avisos } = await conAvisos(() => api('GET', '/api/mantenimiento/incidencias'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.incidencias.map((i) => i.id_incidencia).sort(), ['inc-centro', 'inc-sur']);
  assert.deepEqual(avisos, [{ ruta: '/api/mantenimiento/incidencias', usuario: '000060', locales: ['000020'] }]);

  const ajeno = await conAvisos(() => api('GET', '/api/mantenimiento/incidencias?local_id=000020'));
  assert.equal(ajeno.r.status, 200);
  assert.deepEqual(ajeno.r.body.incidencias.map((i) => i.id_incidencia), ['inc-sur']);
  assert.equal(ajeno.avisos.length, 1);
});

test('listado en bloquear: solo su local; local_id ajeno 403', async () => {
  montar();
  modo('bloquear');
  const r = await api('GET', '/api/mantenimiento/incidencias');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.incidencias.map((i) => i.id_incidencia), ['inc-centro']);
  const ajeno = await api('GET', '/api/mantenimiento/incidencias?local_id=000020');
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.body.incidencias, undefined);
  const propio = await api('GET', '/api/mantenimiento/incidencias?local_id=000010');
  assert.deepEqual(propio.body.incidencias.map((i) => i.id_incidencia), ['inc-centro']);

  const global = await api('GET', '/api/mantenimiento/incidencias', undefined, OFICINA);
  assert.equal(global.body.incidencias.length, 2);
});
