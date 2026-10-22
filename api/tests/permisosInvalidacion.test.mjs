/**
 * Conceder o retirar un permiso tiene que surtir efecto en la siguiente petición,
 * no cuando caduque la caché de permisos por rol (60 s).
 *
 * El doble no invalida la caché en las escrituras: si a una ruta de permisos o
 * roles le faltara `invalidarPermisosRol`, estas pruebas lo verían.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-invalidacion';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { signToken } = await import('../lib/jwt.js');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { requireAuth, requirePermission, hasPermission } = await import('../middleware/auth.js');
const { eliminarRol } = await import('../lib/roles.js');
const { default: permisosRouter } = await import('../routes/permisos.js');
const { default: rolesRouter } = await import('../routes/roles.js');

const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };
const LOCAL = { sub: '000009', email: 'local@grupo.test', rol: 'Local' };
const ENCARGADO = { sub: '000012', email: 'encargado@grupo.test', rol: 'Encargado' };

let servidor = null;
let base = '';

async function api(metodo, ruta, usuario, cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.get('/api/prueba-cajas', requireAuth, requirePermission('cajas.ver'), (_req, res) => res.json({ ok: true }));
    app.use('/api', permisosRouter);
    app.use('/api', rolesRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${signToken(usuario)}`,
      ...(cuerpo && { 'Content-Type': 'application/json' }),
    },
    ...(cuerpo && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  for (const u of [ADMIN, LOCAL, ENCARGADO]) {
    db.sembrar(tables.usuarios, { id_usuario: u.sub, Email: u.email, Rol: u.rol });
  }
  invalidarContextoAcceso();
  db.instalar(docClient);
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'META', nombre: 'Local' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#cajas.ver' });
  // «Encargado» es un rol legacy: filas PERMISO# sin META.
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Encargado', SK: 'PERMISO#pedidos.ver' });
  return db;
}

test('DELETE /api/permisos: la siguiente petición ya da 403', async () => {
  montar();
  assert.equal((await api('GET', '/api/prueba-cajas', LOCAL)).status, 200);

  const baja = await api('DELETE', '/api/permisos', ADMIN, { rol: 'Local', permiso: 'cajas.ver' });
  assert.equal(baja.status, 200, JSON.stringify(baja.body));

  assert.equal((await api('GET', '/api/prueba-cajas', LOCAL)).status, 403);
});

test('POST /api/permisos: la siguiente petición ya da 200', async () => {
  montar();
  assert.equal((await api('GET', '/api/prueba-cajas', ENCARGADO)).status, 403);

  const alta = await api('POST', '/api/permisos', ADMIN, { rol: 'Encargado', permiso: 'cajas.ver' });
  assert.equal(alta.status, 200, JSON.stringify(alta.body));

  assert.equal((await api('GET', '/api/prueba-cajas', ENCARGADO)).status, 200);
});

test('POST /api/roles clonando permisos sobre un rol legacy en uso: surte efecto ya', async () => {
  montar();
  assert.equal((await api('GET', '/api/prueba-cajas', ENCARGADO)).status, 403);

  const alta = await api('POST', '/api/roles', ADMIN, { nombre: 'Encargado', clonarDe: 'Local' });
  assert.equal(alta.status, 201, JSON.stringify(alta.body));

  assert.equal((await api('GET', '/api/prueba-cajas', ENCARGADO)).status, 200);
});

test('eliminarRol: los permisos cacheados del rol borrado dejan de valer', async () => {
  const db = montar();
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Temporal', SK: 'PERMISO#cajas.ver' });
  const temporal = { sub: '000099', rol: 'Temporal' };
  assert.equal(await hasPermission(temporal, 'cajas.ver'), true);

  await eliminarRol('Temporal');

  assert.equal(await hasPermission(temporal, 'cajas.ver'), false);
});
