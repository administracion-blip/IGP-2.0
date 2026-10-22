/**
 * PUT /api/agora/formas-pago/:agoraId cambia `arquear`/`canonico` del maestro y con
 * ello los descuadres de arqueo de todos los locales: un autenticado sin
 * formas_pago.editar ni cierres.ver no puede tocarlo.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-formas-pago';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { default: agoraRouter } = await import('../routes/agora.js');

const CAMARERO = { sub: '000070', email: 'camarero@grupo.test', rol: 'Camarero' };
const MAESTROS = { sub: '000071', email: 'maestros@grupo.test', rol: 'Maestros' };
const CIERRES = { sub: '000072', email: 'cierres@grupo.test', rol: 'Cierres' };
const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };

const PERMISOS = {
  Camarero: ['planning_dia.arqueo', 'pedidos.ver'],
  Maestros: ['formas_pago.editar'],
  Cierres: ['cierres.ver'],
};

let usuarioActual = CAMARERO;
let servidor = null;
let base = '';
let db = null;

async function put(agoraId, usuario, body) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
    app.use('/api', agoraRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(`${base}/api/agora/formas-pago/${agoraId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.formasPago, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const [rol, lista] of Object.entries(PERMISOS)) {
    for (const p of lista) db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${p}` });
  }
  db.sembrar(tables.formasPago, { PK: 'PM', SK: '7', nombre: 'Tarjeta', canonico: 'Tarjeta', arquear: true, orden: 2 });
}

test('formas-pago PUT: autenticado sin formas_pago.editar ni cierres.ver, 403 y el maestro no cambia', async () => {
  montar();
  const r = await put('7', CAMARERO, { arquear: false, canonico: 'Efectivo' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Permiso insuficiente');
  const forma = db.obtener(tables.formasPago, { PK: 'PM', SK: '7' });
  assert.equal(forma.arquear, true);
  assert.equal(forma.canonico, 'Tarjeta');
  assert.ok(db.operaciones.every((o) => ['GetCommand', 'QueryCommand'].includes(o.tipo)), 'solo lecturas de permisos');
});

test('formas-pago PUT: pasa con formas_pago.editar, con cierres.ver y como Administrador', async () => {
  for (const u of [MAESTROS, CIERRES, ADMIN]) {
    montar();
    const r = await put('7', u, { arquear: false });
    assert.equal(r.status, 200, u.rol);
    assert.equal(db.obtener(tables.formasPago, { PK: 'PM', SK: '7' }).arquear, false, u.rol);
  }
});
