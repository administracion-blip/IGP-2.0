/**
 * Aislamiento por local en Mystery Guest. Un auditor con mystery_guest.ver y solo
 * «Bar Centro» intenta leer y dar de alta auditorías de «Bar Sur», y sobrescribir
 * una de «Bar Sur» reutilizando su id.
 */

import test, { after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alcance-mystery';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: mysteryGuestRouter } = await import('../routes/mysteryGuest.js');
const { mgTodosLosIdsPregunta } = await import('../lib/mysteryGuestCuestionario.js');

const AUDITOR = { sub: '000070', email: 'auditor@grupo.test', rol: 'Socio' };
const OFICINA = { sub: '000071', email: 'oficina@grupo.test', rol: 'Socio' };

const MODO_ORIGINAL = process.env.ALCANCE_MODO_LECTURAS;
function modo(valor) {
  if (valor === undefined) delete process.env.ALCANCE_MODO_LECTURAS;
  else process.env.ALCANCE_MODO_LECTURAS = valor;
}
afterEach(() => modo(MODO_ORIGINAL));

let usuarioActual = AUDITOR;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario = AUDITOR) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
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

let db = null;

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.mysteryGuest, { hashKey: 'ud_mysteryguest' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Socio', SK: 'PERMISO#mystery_guest.ver' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro' });
  db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur' });
  db.sembrar(tables.usuarios, { id_usuario: '000070', Email: AUDITOR.email, Rol: 'Socio', Local: ['Bar Centro'] });
  db.sembrar(tables.usuarios, { id_usuario: '000071', Email: OFICINA.email, Rol: 'Socio', Local: [] });
  db.sembrar(tables.mysteryGuest, { ud_mysteryguest: 'mg-centro', Fecha: '2026-09-01', FechaDia: '2026-09-01', LocalId: '000010', CreadoEn: '1' });
  db.sembrar(tables.mysteryGuest, { ud_mysteryguest: 'mg-sur', Fecha: '2026-09-01', FechaDia: '2026-09-01', LocalId: '000020', CreadoEn: '2', Notas: 'original' });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
}

const RANGO = 'fechaDesde=2026-09-01&fechaHasta=2026-09-30';

function alta(campos) {
  return {
    Fecha: '2026-09-02T20:00:00.000Z',
    Respuestas: Object.fromEntries(mgTodosLosIdsPregunta().map((id) => [id, 4])),
    ...campos,
  };
}

test('alta en un local ajeno: 403 y no se escribe', async () => {
  montar();
  const r = await api('POST', '/api/mystery-guest', alta({ LocalId: '000020' }));
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'No tienes acceso a este local');
  assert.equal(db.listar(tables.mysteryGuest).length, 2);
});

test('sobrescribir por id una auditoría de un local ajeno, aunque el cuerpo diga el propio: 403 y queda igual', async () => {
  montar();
  const antes = db.obtener(tables.mysteryGuest, { ud_mysteryguest: 'mg-sur' });
  const r = await api('POST', '/api/mystery-guest', alta({ LocalId: '000010', id_MisteryGuest: 'mg-sur' }));
  assert.equal(r.status, 403);
  assert.deepEqual(db.obtener(tables.mysteryGuest, { ud_mysteryguest: 'mg-sur' }), antes);
});

test('sobrescribir por id una auditoría propia que otro mueve de local entre la lectura y el Put: 409 sin pisarla', async () => {
  montar();
  db.interceptar('PutCommand', tables.mysteryGuest, async () => {
    db.sembrar(tables.mysteryGuest, { ...db.obtener(tables.mysteryGuest, { ud_mysteryguest: 'mg-centro' }), LocalId: '000020' });
  });
  const r = await api('POST', '/api/mystery-guest', alta({ LocalId: '000010', id_MisteryGuest: 'mg-centro' }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'La auditoría ha cambiado, vuelve a cargarla');
  assert.equal(db.obtener(tables.mysteryGuest, { ud_mysteryguest: 'mg-centro' }).LocalId, '000020');
});

test('alta por id que otro crea entre la lectura y el Put: 409 sin pisarla; sin carrera se sobrescribe la propia', async () => {
  montar();
  db.interceptar('PutCommand', tables.mysteryGuest, async () => {
    db.sembrar(tables.mysteryGuest, { ud_mysteryguest: 'mg-nueva', Fecha: '2026-09-03', LocalId: '000020' });
  });
  const r = await api('POST', '/api/mystery-guest', alta({ LocalId: '000010', id_MisteryGuest: 'mg-nueva' }));
  assert.equal(r.status, 409);
  assert.equal(db.obtener(tables.mysteryGuest, { ud_mysteryguest: 'mg-nueva' }).LocalId, '000020');

  const ok = await api('POST', '/api/mystery-guest', alta({ LocalId: '000010', id_MisteryGuest: 'mg-centro', Notas: 'repaso' }));
  assert.equal(ok.status, 200);
  assert.equal(db.obtener(tables.mysteryGuest, { ud_mysteryguest: 'mg-centro' }).Notas, 'repaso');
});

test('alta en su local y con alcance global en cualquiera', async () => {
  montar();
  assert.equal((await api('POST', '/api/mystery-guest', alta({ LocalId: '000010' }))).status, 200);
  assert.equal((await api('POST', '/api/mystery-guest', alta({ LocalId: '000020' }), OFICINA)).status, 200);
  assert.equal(db.listar(tables.mysteryGuest).length, 4);
});

test('lectura en observar: todo + aviso; localId ajeno se sirve con aviso', async () => {
  montar();
  modo(undefined);
  const { r, avisos } = await conAvisos(() => api('GET', `/api/mystery-guest?${RANGO}`));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.valoraciones.map((v) => v.id_MisteryGuest), ['mg-centro', 'mg-sur']);
  assert.deepEqual(avisos, [{ ruta: '/api/mystery-guest', usuario: '000070', locales: ['000020'] }]);

  const ajeno = await conAvisos(() => api('GET', `/api/mystery-guest?${RANGO}&localId=000020`));
  assert.equal(ajeno.r.status, 200);
  assert.deepEqual(ajeno.r.body.valoraciones.map((v) => v.id_MisteryGuest), ['mg-sur']);
  assert.equal(ajeno.avisos.length, 1);
});

test('lectura en bloquear: solo su local; localId ajeno 403', async () => {
  montar();
  modo('bloquear');
  const r = await api('GET', `/api/mystery-guest?${RANGO}`);
  assert.deepEqual(r.body.valoraciones.map((v) => v.id_MisteryGuest), ['mg-centro']);
  const ajeno = await api('GET', `/api/mystery-guest?${RANGO}&localId=000020`);
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.body.valoraciones, undefined);
  const global = await api('GET', `/api/mystery-guest?${RANGO}`, undefined, OFICINA);
  assert.equal(global.body.valoraciones.length, 2);
});
