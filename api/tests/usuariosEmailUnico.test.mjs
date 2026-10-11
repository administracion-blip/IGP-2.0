/**
 * Dos usuarios no pueden compartir email. El login se queda con el primer usuario
 * que devuelve el índice por email y la recuperación de contraseña exige uno solo:
 * con usuarios.crear o usuarios.editar bastaba con dar a otra ficha el email de un
 * Administrador para dejarlo sin poder entrar.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-email-unico';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { default: usuariosRouter } = await import('../routes/usuarios.js');

const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };
const GESTOR = { sub: '000005', email: 'gestor@grupo.test', rol: 'Gestor' };

let usuarioActual = ADMIN;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario = ADMIN) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual) req.user = usuarioActual;
      next();
    });
    app.use('/api', usuariosRouter);
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
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const rol of ['Administrador', 'Gestor', 'Local']) {
    db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: 'META', nombre: rol });
  }
  for (const permiso of ['usuarios.ver', 'usuarios.crear', 'usuarios.editar']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#Gestor', SK: `PERMISO#${permiso}` });
  }
  db.sembrar(tables.usuarios, { id_usuario: '000001', Email: 'jefe@grupo.test', Password: 'hash-admin', Rol: 'Administrador' });
  db.sembrar(tables.usuarios, { id_usuario: '000007', Email: 'ana@grupo.test', Password: 'hash-ana', Rol: 'Local', Nombre: 'Ana' });
  return db;
}

const conEmail = (db, email) => db.listar(tables.usuarios).filter((u) => u.Email === email);

test('alta con el email de un Administrador (aunque cambien mayúsculas y espacios): 409 y no se crea', async () => {
  const db = montar();
  const r = await api('POST', '/api/usuarios', { id_usuario: '50', Email: '  JEFE@Grupo.test ', Password: 'secreta123', Rol: 'Local' }, GESTOR);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Ya existe otro usuario con el email jefe@grupo\.test/);
  assert.equal(db.obtener(tables.usuarios, { id_usuario: '000050' }), null);
  assert.equal(conEmail(db, 'jefe@grupo.test').length, 1);
});

test('editar otra ficha poniéndole el email de un Administrador: 409 y no cambia', async () => {
  const db = montar();
  const r = await api('PUT', '/api/usuarios', { id_usuario: '000007', Email: 'Jefe@grupo.test' }, GESTOR);
  assert.equal(r.status, 409);
  assert.equal(db.obtener(tables.usuarios, { id_usuario: '000007' }).Email, 'ana@grupo.test');
  assert.equal(conEmail(db, 'jefe@grupo.test').length, 1);
});

test('editar una ficha conservando su propio email sigue funcionando', async () => {
  const db = montar();
  const r = await api('PUT', '/api/usuarios', { id_usuario: '000007', Email: ' ANA@grupo.test', Telefono: '600' }, GESTOR);
  assert.equal(r.status, 200, r.body?.error);
  const ana = db.obtener(tables.usuarios, { id_usuario: '000007' });
  assert.equal(ana.Email, 'ana@grupo.test');
  assert.equal(ana.Telefono, '600');
});

test('cambiar a un email libre y crear con email libre siguen funcionando', async () => {
  const db = montar();
  assert.equal((await api('PUT', '/api/usuarios', { id_usuario: '000007', Email: 'ana.nueva@grupo.test' }, GESTOR)).status, 200);
  assert.equal(db.obtener(tables.usuarios, { id_usuario: '000007' }).Email, 'ana.nueva@grupo.test');
  const alta = await api('POST', '/api/usuarios', { id_usuario: '60', Email: 'Nuevo@Grupo.test', Password: 'secreta123', Rol: 'Local' }, GESTOR);
  assert.equal(alta.status, 200, alta.body?.error);
  assert.equal(db.obtener(tables.usuarios, { id_usuario: '000060' }).Email, 'nuevo@grupo.test');
});

test('un duplicado que ya existiera no impide editar el resto de la ficha', async () => {
  const db = montar();
  db.sembrar(tables.usuarios, { id_usuario: '000008', Email: 'ana@grupo.test', Password: 'h', Rol: 'Local' });
  const r = await api('PUT', '/api/usuarios', { id_usuario: '000008', Email: 'ana@grupo.test', Nombre: 'Ana B' }, GESTOR);
  assert.equal(r.status, 200, r.body?.error);
  assert.equal(db.obtener(tables.usuarios, { id_usuario: '000008' }).Nombre, 'Ana B');
});
