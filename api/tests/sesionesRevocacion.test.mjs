/**
 * S-10: un JWT deja de valer en cuanto la ficha del usuario cambia lo que firmó.
 *
 * El token lleva `tv` (tokenVersion) y el rol. `requireAuth` los contrasta con la
 * ficha (vía el contexto de acceso cacheado): usuario borrado, rol cambiado,
 * contraseña restablecida o «cerrar sesiones» → 401. Los tokens emitidos antes
 * de existir `tv` siguen valiendo mientras la versión sea 0.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-sesiones';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { signToken, signSystemToken } = await import('../lib/jwt.js');
const { hashPassword } = await import('../lib/password.js');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { requireAuth, SESION_CADUCADA } = await import('../middleware/auth.js');
const { default: authRouter } = await import('../routes/auth.js');
const { default: usuariosRouter } = await import('../routes/usuarios.js');

const ADMIN = { id_usuario: '000001', Email: 'jefe@grupo.test', Rol: 'Administrador' };
const VICTIMA = { id_usuario: '000002', Email: 'local@grupo.test', Rol: 'Local' };
const GESTOR = { id_usuario: '000003', Email: 'gestor@grupo.test', Rol: 'Gestor' };
const PASSWORD = 'Contraseña-larga-1';

let servidor = null;
let base = '';

async function arrancar() {
  if (servidor) return;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { warn() {}, error() {}, info() {} };
    next();
  });
  app.use('/api', authRouter);
  app.use('/api', requireAuth);
  app.get('/api/ping', (req, res) => res.json({ ok: true, sub: req.user.sub }));
  app.use('/api', usuariosRouter);
  servidor = http.createServer(app);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  base = `http://127.0.0.1:${servidor.address().port}`;
}

async function api(metodo, ruta, { token, cuerpo } = {}) {
  await arrancar();
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function montar({ tokenVersionVictima } = {}) {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  const hash = await hashPassword(PASSWORD);
  for (const u of [ADMIN, VICTIMA, GESTOR]) {
    db.sembrar(tables.usuarios, { ...u, Password: hash, Nombre: u.Email, Local: [] });
  }
  if (tokenVersionVictima !== undefined) {
    const v = db.obtener(tables.usuarios, { id_usuario: VICTIMA.id_usuario });
    db.sembrar(tables.usuarios, { ...v, tokenVersion: tokenVersionVictima });
  }
  for (const rol of ['Local', 'Gestor', 'SuperUser']) {
    db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: 'META', nombre: rol });
  }
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Gestor', SK: 'PERMISO#usuarios.editar' });
  invalidarContextoAcceso();
  return db;
}

async function login(usuario) {
  const r = await api('POST', '/api/login', { cuerpo: { email: usuario.Email, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

function tokenSinTv(usuario) {
  return signToken({ sub: usuario.id_usuario, email: usuario.Email, rol: usuario.Rol });
}

function cuerpoPut(usuario, cambios = {}) {
  return { id_usuario: usuario.id_usuario, Email: usuario.Email, Nombre: usuario.Email, ...cambios };
}

function assertCaducada(r) {
  assert.equal(r.status, 401);
  assert.equal(r.body.error, SESION_CADUCADA);
}

test('el login firma tv = tokenVersion y ese token entra', async () => {
  await montar({ tokenVersionVictima: 4 });
  const token = await login(VICTIMA);
  const [, payload] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).tv, 4);
  const r = await api('GET', '/api/ping', { token });
  assert.equal(r.status, 200);
});

test('token de un usuario borrado → 401', async () => {
  await montar();
  const token = await login(VICTIMA);
  assert.equal((await api('GET', '/api/ping', { token })).status, 200);

  const adminToken = await login(ADMIN);
  const borrado = await api('DELETE', `/api/usuarios?id_usuario=${VICTIMA.id_usuario}`, { token: adminToken });
  assert.equal(borrado.status, 200);

  assertCaducada(await api('GET', '/api/ping', { token }));
});

test('tras cambiar el rol, el token anterior → 401 y la versión sube', async () => {
  const db = await montar();
  const token = await login(VICTIMA);
  const adminToken = await login(ADMIN);

  const put = await api('PUT', '/api/usuarios', { token: adminToken, cuerpo: cuerpoPut(VICTIMA, { Rol: 'SuperUser' }) });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.usuario.tokenVersion, undefined, 'la respuesta no expone tokenVersion');
  assert.equal(db.obtener(tables.usuarios, { id_usuario: VICTIMA.id_usuario }).tokenVersion, 1);

  assertCaducada(await api('GET', '/api/ping', { token }));
});

test('el rol del token tiene que coincidir con el de la ficha (aunque tv cuadre)', async () => {
  await montar();
  const falso = signToken({ sub: VICTIMA.id_usuario, email: VICTIMA.Email, rol: 'Administrador', tv: 0 });
  assertCaducada(await api('GET', '/api/ping', { token: falso }));
});

test('cambiar la contraseña desde la ficha revoca; editar solo locales no, y conserva tokenVersion', async () => {
  const db = await montar({ tokenVersionVictima: 2 });
  const token = await login(VICTIMA);
  const adminToken = await login(ADMIN);

  const locales = await api('PUT', '/api/usuarios', { token: adminToken, cuerpo: cuerpoPut(VICTIMA, { Local: ['Bar Centro'] }) });
  assert.equal(locales.status, 200, JSON.stringify(locales.body));
  assert.equal(db.obtener(tables.usuarios, { id_usuario: VICTIMA.id_usuario }).tokenVersion, 2);
  assert.equal((await api('GET', '/api/ping', { token })).status, 200);

  const pass = await api('PUT', '/api/usuarios', { token: adminToken, cuerpo: cuerpoPut(VICTIMA, { Password: 'Otra-clave-larga-2' }) });
  assert.equal(pass.status, 200);
  assert.equal(db.obtener(tables.usuarios, { id_usuario: VICTIMA.id_usuario }).tokenVersion, 3);
  assertCaducada(await api('GET', '/api/ping', { token }));
});

test('el PUT no pisa un «cerrar sesiones» hecho entre su lectura y su escritura', async () => {
  const db = await montar();
  const adminToken = await login(ADMIN);
  db.interceptar('PutCommand', tables.usuarios, async () => {
    const v = db.obtener(tables.usuarios, { id_usuario: VICTIMA.id_usuario });
    db.sembrar(tables.usuarios, { ...v, tokenVersion: 1 });
  });
  const r = await api('PUT', '/api/usuarios', { token: adminToken, cuerpo: cuerpoPut(VICTIMA, { Local: ['Bar Centro'] }) });
  assert.equal(r.status, 409);
  assert.equal(db.obtener(tables.usuarios, { id_usuario: VICTIMA.id_usuario }).tokenVersion, 1);
});

test('tras restablecer la contraseña por enlace, el token anterior → 401', async () => {
  const db = await montar();
  const token = await login(VICTIMA);
  const resetToken = crypto.randomBytes(32).toString('hex');
  const v = db.obtener(tables.usuarios, { id_usuario: VICTIMA.id_usuario });
  db.sembrar(tables.usuarios, {
    ...v,
    ResetTokenHash: crypto.createHash('sha256').update(resetToken).digest('hex'),
    ResetTokenExp: Date.now() + 60_000,
  });

  const r = await api('POST', '/api/reset-password', {
    cuerpo: { email: VICTIMA.Email, token: resetToken, password: 'Nueva-clave-larga-3' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.obtener(tables.usuarios, { id_usuario: VICTIMA.id_usuario }).tokenVersion, 1);

  assertCaducada(await api('GET', '/api/ping', { token }));
});

test('token antiguo sin tv: vale con tokenVersion ausente o 0', async () => {
  await montar();
  assert.equal((await api('GET', '/api/ping', { token: tokenSinTv(VICTIMA) })).status, 200);
  await montar({ tokenVersionVictima: 0 });
  assert.equal((await api('GET', '/api/ping', { token: tokenSinTv(VICTIMA) })).status, 200);
});

test('token antiguo sin tv con tokenVersion 1 → 401', async () => {
  await montar({ tokenVersionVictima: 1 });
  assertCaducada(await api('GET', '/api/ping', { token: tokenSinTv(VICTIMA) }));
});

test('POST /usuarios/:id/cerrar-sesiones revoca; el login posterior vuelve a entrar', async () => {
  await montar();
  const token = await login(VICTIMA);
  const adminToken = await login(ADMIN);

  const r = await api('POST', `/api/usuarios/${VICTIMA.id_usuario}/cerrar-sesiones`, { token: adminToken });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assertCaducada(await api('GET', '/api/ping', { token }));

  const nuevo = await login(VICTIMA);
  assert.equal((await api('GET', '/api/ping', { token: nuevo })).status, 200);
});

test('cerrar-sesiones: sin usuarios.editar 403, un no admin no cierra las de un Administrador, 404 si no existe', async () => {
  await montar();
  const victimaToken = await login(VICTIMA);
  const gestorToken = await login(GESTOR);
  const adminToken = await login(ADMIN);

  const sinPermiso = await api('POST', `/api/usuarios/${ADMIN.id_usuario}/cerrar-sesiones`, { token: victimaToken });
  assert.equal(sinPermiso.status, 403);

  const contraAdmin = await api('POST', `/api/usuarios/${ADMIN.id_usuario}/cerrar-sesiones`, { token: gestorToken });
  assert.equal(contraAdmin.status, 403);
  assert.equal((await api('GET', '/api/ping', { token: adminToken })).status, 200);

  const ok = await api('POST', `/api/usuarios/${VICTIMA.id_usuario}/cerrar-sesiones`, { token: gestorToken });
  assert.equal(ok.status, 200);

  const noExiste = await api('POST', '/api/usuarios/999999/cerrar-sesiones', { token: adminToken });
  assert.equal(noExiste.status, 404);
});

function lecturasFicha(db) {
  return db.operaciones.filter((o) => o.tipo === 'GetCommand' && o.tabla === tables.usuarios).length;
}

test('caché con tv viejo: un token con tv mayor (login en otra instancia) relee y entra; el viejo → 401 sin leer', async () => {
  const db = await montar();
  const viejo = await login(VICTIMA);
  assert.equal((await api('GET', '/api/ping', { token: viejo })).status, 200);

  // Revocación hecha por otro proceso: la ficha sube a 1 y esta caché no se entera.
  const v = db.obtener(tables.usuarios, { id_usuario: VICTIMA.id_usuario });
  db.sembrar(tables.usuarios, { ...v, tokenVersion: 1 });
  const nuevo = signToken({ sub: VICTIMA.id_usuario, email: VICTIMA.Email, rol: VICTIMA.Rol, tv: 1 });
  assert.equal((await api('GET', '/api/ping', { token: nuevo })).status, 200);

  const antes = lecturasFicha(db);
  assertCaducada(await api('GET', '/api/ping', { token: viejo }));
  assert.equal(lecturasFicha(db), antes, 'un tv menor no fuerza lectura');
});

test('el login invalida el contexto: tras revocar en otro proceso, el token del login nuevo entra', async () => {
  const db = await montar();
  const viejo = await login(VICTIMA);
  assert.equal((await api('GET', '/api/ping', { token: viejo })).status, 200);
  const v = db.obtener(tables.usuarios, { id_usuario: VICTIMA.id_usuario });
  db.sembrar(tables.usuarios, { ...v, tokenVersion: 1 });

  const nuevo = await login(VICTIMA);
  assert.equal((await api('GET', '/api/ping', { token: nuevo })).status, 200);
  assertCaducada(await api('GET', '/api/ping', { token: viejo }));
});

test('el token de sistema del informe diario no depende de igp_usuarios', async () => {
  await montar();
  const r = await api('GET', '/api/ping', { token: signSystemToken('informes') });
  assert.equal(r.status, 200);
  assert.equal(r.body.sub, 'sistema-informes');

  const imitado = signToken({ sub: 'sistema-informes', email: 'x', rol: 'Administrador' });
  assertCaducada(await api('GET', '/api/ping', { token: imitado }));
});
