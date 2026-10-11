/**
 * `GET /api/permisos?rol=` solo deja consultar los permisos del propio rol.
 *
 * La matriz completa dice qué rol puede hacer qué (facturar, pagar, ver datos de
 * empleados…): a quien no gestiona permisos le sirve para elegir a quién
 * suplantar o a quién pedir una acción. Los permisos de otro rol exigen
 * Administrador o `permisos.ver`.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-permisos';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { signToken } = await import('../lib/jwt.js');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { default: permisosRouter } = await import('../routes/permisos.js');

const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };
const LOCAL = { sub: '000009', email: 'local@grupo.test', rol: 'Local' };
const GESTOR = { sub: '000005', email: 'gestor@grupo.test', rol: 'Gestor permisos' };

let servidor = null;
let base = '';

async function api(ruta, usuario) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use('/api', permisosRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, { headers: { Authorization: `Bearer ${signToken(usuario)}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  // requireAuth contrasta el token con la ficha: los usuarios tienen que existir.
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  for (const u of [ADMIN, LOCAL, GESTOR]) {
    db.sembrar(tables.usuarios, { id_usuario: u.sub, Email: u.email, Rol: u.rol });
  }
  invalidarContextoAcceso();
  db.instalar(docClient);
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#cajas.ver' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#SuperUser', SK: 'PERMISO#facturacion.pagar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Gestor permisos', SK: 'PERMISO#permisos.ver' });
  return db;
}

test('sin permisos.ver no se leen los permisos de otro rol', async () => {
  montar();
  const r = await api('/api/permisos?rol=SuperUser', LOCAL);
  assert.equal(r.status, 403);
  assert.equal(r.body.permisos, undefined);
});

test('los permisos del propio rol se siguen leyendo sin permiso especial', async () => {
  montar();
  const r = await api('/api/permisos?rol=Local', LOCAL);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.permisos, ['cajas.ver']);

  const sinRol = await api('/api/permisos', LOCAL);
  assert.equal(sinRol.status, 200);
  assert.deepEqual(sinRol.body.permisos, []);
});

test('con permisos.ver o como Administrador se leen los de cualquier rol', async () => {
  montar();
  const gestor = await api('/api/permisos?rol=SuperUser', GESTOR);
  assert.equal(gestor.status, 200);
  assert.deepEqual(gestor.body.permisos, ['facturacion.pagar']);

  const admin = await api('/api/permisos?rol=SuperUser', ADMIN);
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.body.permisos, ['facturacion.pagar']);
});
