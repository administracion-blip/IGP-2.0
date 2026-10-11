/**
 * Capa central de alcance por local (`lib/alcance.js` + `middleware/alcance.js`).
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alcance';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const {
  cargarAlcance,
  permiteLocal,
  intersecarLocales,
  permiteEmpresa,
  filtrarPorLocal,
  asegurarLocal,
  invalidarMaestroLocales,
} = await import('../lib/alcance.js');
const { requireLocal, requireLocales, requireAlcanceGlobal, desde } = await import('../middleware/alcance.js');

const PARIPE = { id_Locales: '000001', nombre: 'PARIPE', agoraCode: '101', id_empresa: '000010', empresa: 'Norte SL' };
const SUR = { id_Locales: '000002', nombre: 'SUR', agoraCode: '202', id_empresa: '000020', empresa: 'Sur SL' };
const SEDE = { id_Locales: '000003', nombre: 'SEDE CENTRAL', agoraCode: '', id_empresa: '000010', empresa: 'Norte SL' };

const ENCARGADO = { sub: '000050', email: 'local@grupo.test', rol: 'Local' };
const OFICINA = { sub: '000051', email: 'oficina@grupo.test', rol: 'SuperUser' };
const BORRADO = { sub: '000099', email: 'borrado@grupo.test', rol: 'Local' };
const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const l of [PARIPE, SUR, SEDE]) db.sembrar(tables.locales, l);
  db.sembrar(tables.usuarios, { id_usuario: '000050', Email: 'local@grupo.test', Rol: 'Local', Local: ['paripe '] });
  db.sembrar(tables.usuarios, { id_usuario: '000051', Email: 'oficina@grupo.test', Rol: 'SuperUser', Local: [] });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  return db;
}

test('usuario borrado (token vivo, ficha inexistente): restringido sin locales', async () => {
  montar();
  const alcance = await cargarAlcance({ user: BORRADO });
  assert.equal(alcance.global, false);
  assert.equal(alcance.localIds.size, 0);
  assert.equal(permiteLocal(alcance, { workplaceId: '101' }), false);
});

test('Local con ["paripe "] coincide con PARIPE (mayúsculas y espacios)', async () => {
  montar();
  const alcance = await cargarAlcance({ user: ENCARGADO });
  assert.equal(alcance.global, false);
  assert.equal(permiteLocal(alcance, { workplaceId: '101' }), true);
  assert.equal(permiteLocal(alcance, { idLocal: '1' }), true);
  assert.equal(permiteLocal(alcance, { nombre: ' Paripe' }), true);
  assert.equal(permiteLocal(alcance, { workplaceId: '202' }), false);
  assert.equal(permiteEmpresa(alcance, '10'), true);
  assert.equal(permiteEmpresa(alcance, '000020'), false);
  assert.deepEqual(intersecarLocales(alcance, ['101', '202']), ['101']);
  assert.deepEqual(
    filtrarPorLocal(alcance, [{ wp: '101' }, { wp: '202' }], (x) => ({ workplaceId: x.wp })),
    [{ wp: '101' }],
  );
});

test('workplaceId desconocido en el maestro: denegado a restringidos, pasa a globales', async () => {
  montar();
  const restringido = await cargarAlcance({ user: ENCARGADO });
  assert.equal(permiteLocal(restringido, { workplaceId: '999' }), false);
  assert.equal(permiteLocal(restringido, { idLocal: 'abc' }), false);
  assert.equal(permiteLocal(restringido, {}), false);
  const global = await cargarAlcance({ user: ADMIN });
  assert.equal(permiteLocal(global, { workplaceId: '999' }), true);
});

test('isInternal y Administrador: global sin leer DynamoDB', async () => {
  const db = montar();
  const antes = db.operaciones.length;
  assert.equal((await cargarAlcance({ isInternal: true })).global, true);
  assert.equal((await cargarAlcance({ user: ADMIN })).global, true);
  assert.equal(db.operaciones.length, antes);
});

test('Locales vacío: global', async () => {
  montar();
  assert.equal((await cargarAlcance({ user: OFICINA })).global, true);
});

test('el alcance se memoriza por petición', async () => {
  const db = montar();
  const req = { user: ENCARGADO };
  await cargarAlcance(req);
  const tras = db.operaciones.length;
  await cargarAlcance(req);
  assert.equal(db.operaciones.length, tras);
});

test('asegurarLocal lanza 403; en modo observar solo avisa', async () => {
  montar();
  await assert.rejects(
    () => asegurarLocal({ user: ENCARGADO }, { workplaceId: '202' }),
    (err) => err.status === 403 && err.message === 'No tienes acceso a este local',
  );
  const avisos = [];
  const original = console.warn;
  console.warn = (m) => avisos.push(m);
  try {
    await asegurarLocal({ user: ENCARGADO, method: 'GET', originalUrl: '/x' }, { workplaceId: '202' }, { modo: 'observar' });
  } finally {
    console.warn = original;
  }
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /^\[alcance\] denegaría/);
});

// ─── Middlewares ───

let usuarioActual = ENCARGADO;
let servidor = null;
let base = '';

async function api(metodo, ruta, usuario, body) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual === 'interno') req.isInternal = true;
      else req.user = usuarioActual;
      next();
    });
    app.get('/uno', requireLocal(desde.query('workplaceId')), (_req, res) => res.json({ ok: true }));
    app.post(
      '/varios',
      requireLocales(desde.body('workplaces'), { obligatorio: true }),
      (req, res) => res.json({ locales: req.alcanceLocales }),
    );
    app.get('/s3', requireLocal(desde.claveS3('pref/', 1)), (_req, res) => res.json({ ok: true }));
    app.post('/global', requireAlcanceGlobal(), (_req, res) => res.json({ ok: true }));
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

test('requireLocal: propio 200, ajeno 403 con el texto estándar, sin valor 403', async () => {
  montar();
  assert.equal((await api('GET', '/uno?workplaceId=101', ENCARGADO)).status, 200);
  const ajeno = await api('GET', '/uno?workplaceId=202', ENCARGADO);
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.body.error, 'No tienes acceso a este local');
  assert.equal((await api('GET', '/uno', ENCARGADO)).status, 403);
  assert.equal((await api('GET', '/uno?workplaceId=101&workplaceId=202', ENCARGADO)).status, 403);
  assert.equal((await api('GET', '/uno?workplaceId=202', ADMIN)).status, 200);
});

test('requireLocales: interseca, vacío obligatorio 403 a restringidos, globales tal cual', async () => {
  montar();
  assert.deepEqual((await api('POST', '/varios', ENCARGADO, { workplaces: ['101', '202'] })).body.locales, ['101']);
  assert.equal((await api('POST', '/varios', ENCARGADO, { workplaces: '202' })).status, 403);
  assert.equal((await api('POST', '/varios', ENCARGADO, {})).status, 403);
  assert.deepEqual((await api('POST', '/varios', 'interno', {})).body.locales, []);
  assert.deepEqual((await api('POST', '/varios', OFICINA, { workplaces: '101,202' })).body.locales, ['101', '202']);
});

test('desde.claveS3: segmento de local; carpetas ajenas o anon solo globales', async () => {
  montar();
  assert.equal((await api('GET', '/s3?key=pref/101/x.jpg', ENCARGADO)).status, 200);
  assert.equal((await api('GET', '/s3?key=pref/202/x.jpg', ENCARGADO)).status, 403);
  assert.equal((await api('GET', '/s3?key=pref/anon/x.jpg', ENCARGADO)).status, 403);
  assert.equal((await api('GET', '/s3?key=otro/101/x.jpg', ENCARGADO)).status, 403);
  assert.equal((await api('GET', '/s3?key=pref/anon/x.jpg', ADMIN)).status, 200);
});

test('requireAlcanceGlobal: restringido 403, Locales vacío e interno pasan', async () => {
  montar();
  assert.equal((await api('POST', '/global', ENCARGADO, {})).status, 403);
  assert.equal((await api('POST', '/global', OFICINA, {})).status, 200);
  assert.equal((await api('POST', '/global', 'interno', {})).status, 200);
});
