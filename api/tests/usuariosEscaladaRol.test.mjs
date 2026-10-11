/**
 * Solo un Administrador puede conceder el rol Administrador o tocar a quien ya
 * lo tiene. Tener `usuarios.crear` / `usuarios.editar` / `usuarios.borrar` no
 * basta: si no, cualquiera con esos permisos se harÃ­a Administrador a sÃ­ mismo
 * o le cambiarÃ­a la contraseÃ±a a uno para entrar con su cuenta.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-escalada-de-rol';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { default: usuariosRouter } = await import('../routes/usuarios.js');
const { puedeGestionarRol } = await import('../lib/roles.js');

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
  for (const permiso of ['usuarios.ver', 'usuarios.crear', 'usuarios.editar', 'usuarios.borrar']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#Gestor', SK: `PERMISO#${permiso}` });
  }
  db.sembrar(tables.usuarios, { id_usuario: '000001', Email: 'jefe@grupo.test', Password: 'hash-admin', Rol: 'Administrador' });
  db.sembrar(tables.usuarios, { id_usuario: '000005', Email: 'gestor@grupo.test', Password: 'hash-gestor', Rol: 'Gestor' });
  db.sembrar(tables.usuarios, { id_usuario: '000007', Email: 'ana@grupo.test', Password: 'hash-ana', Rol: 'Local', Nombre: 'Ana' });
  return db;
}

const ficha = (db, id) => db.obtener(tables.usuarios, { id_usuario: id });

test('un no-admin con usuarios.editar no puede subirse a Administrador', async () => {
  const db = montar();
  const r = await api('PUT', '/api/usuarios', { id_usuario: '000005', Email: 'gestor@grupo.test', Rol: 'Administrador' }, GESTOR);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Administrador/);
  assert.equal(ficha(db, '000005').Rol, 'Gestor');
});

test('un no-admin no puede dar el rol Administrador a otro usuario', async () => {
  const db = montar();
  const r = await api('PUT', '/api/usuarios', { id_usuario: '000007', Email: 'ana@grupo.test', Rol: ' Administrador ' }, GESTOR);
  assert.equal(r.status, 403);
  assert.equal(ficha(db, '000007').Rol, 'Local');
});

test('un no-admin no puede crear un usuario Administrador', async () => {
  const db = montar();
  const r = await api('POST', '/api/usuarios', { id_usuario: '50', Email: 'x@grupo.test', Password: 'secreta123', Rol: 'Administrador' }, GESTOR);
  assert.equal(r.status, 403);
  assert.equal(ficha(db, '000050'), null);
});

test('un no-admin no puede editar a un Administrador, ni siquiera sin tocar el rol', async () => {
  const db = montar();
  const antes = { ...ficha(db, '000001') };
  for (const cuerpo of [
    { id_usuario: '000001', Email: 'jefe@grupo.test', Password: 'nueva-clave-123' },
    { id_usuario: '000001', Email: 'otro@grupo.test' },
    { id_usuario: '000001', Email: 'jefe@grupo.test', Rol: 'Local' },
  ]) {
    const r = await api('PUT', '/api/usuarios', cuerpo, GESTOR);
    assert.equal(r.status, 403, JSON.stringify(cuerpo));
  }
  assert.deepEqual(ficha(db, '000001'), antes);
});

test('un no-admin no puede borrar a un Administrador', async () => {
  const db = montar();
  const r = await api('DELETE', '/api/usuarios', { id_usuario: '000001' }, GESTOR);
  assert.equal(r.status, 403);
  assert.ok(ficha(db, '000001'));
});

test('un Administrador puede asignar el rol Administrador', async () => {
  const db = montar();
  const r = await api('PUT', '/api/usuarios', { id_usuario: '000007', Email: 'ana@grupo.test', Rol: 'Administrador' }, ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.usuario.Rol, 'Administrador');
  assert.equal(ficha(db, '000007').Rol, 'Administrador');
});

test('un Administrador puede editar y borrar a otro Administrador', async () => {
  const db = montar();
  db.sembrar(tables.usuarios, { id_usuario: '000002', Email: 'otro@grupo.test', Password: 'h', Rol: 'Administrador' });
  const ed = await api('PUT', '/api/usuarios', { id_usuario: '000002', Email: 'otro@grupo.test', Telefono: '600' }, ADMIN);
  assert.equal(ed.status, 200);
  const del = await api('DELETE', '/api/usuarios', { id_usuario: '000002' }, ADMIN);
  assert.equal(del.status, 200);
  assert.equal(ficha(db, '000002'), null);
});

test('un no-admin sigue pudiendo gestionar usuarios normales', async () => {
  const db = montar();
  const ed = await api('PUT', '/api/usuarios', { id_usuario: '000007', Email: 'ana@grupo.test', Telefono: '611' }, GESTOR);
  assert.equal(ed.status, 200);
  assert.equal(ed.body.usuario.Telefono, '611');
  assert.equal(ed.body.usuario.Rol, 'Local');
  assert.equal(ed.body.usuario.Password, undefined);

  const alta = await api('POST', '/api/usuarios', { id_usuario: '60', Email: 'b@grupo.test', Password: 'secreta123', Rol: 'Local' }, GESTOR);
  assert.equal(alta.status, 200);
  assert.equal(ficha(db, '000060').Rol, 'Local');

  const del = await api('DELETE', '/api/usuarios', { id_usuario: '000060' }, GESTOR);
  assert.equal(del.status, 200);
  assert.equal(ficha(db, '000060'), null);
});

test('PUT de un usuario inexistente devuelve 404 y no lo crea (usuarios.editar no sirve para crear)', async () => {
  const db = montar();
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Editor', SK: 'PERMISO#usuarios.editar' });
  const EDITOR = { sub: '000006', email: 'editor@grupo.test', rol: 'Editor' };
  const antes = db.listar(tables.usuarios).length;
  const r = await api('PUT', '/api/usuarios', {
    id_usuario: '000099', Email: 'colado@grupo.test', Password: 'secreta123', Rol: 'Local',
  }, EDITOR);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Usuario no encontrado');
  assert.equal(ficha(db, '000099'), null);
  assert.equal(db.listar(tables.usuarios).length, antes);
});

test('puedeGestionarRol: matriz de decisiones', () => {
  assert.equal(puedeGestionarRol(ADMIN, 'Administrador', 'Administrador').ok, true);
  assert.equal(puedeGestionarRol(GESTOR, 'Local', 'Local').ok, true);
  assert.equal(puedeGestionarRol(GESTOR, undefined, 'Local').ok, true);
  assert.equal(puedeGestionarRol(GESTOR, 'Administrador', 'Local').status, 403);
  assert.equal(puedeGestionarRol(GESTOR, '', 'Administrador').status, 403);
  assert.equal(puedeGestionarRol(undefined, 'Administrador', null).ok, false);
});
