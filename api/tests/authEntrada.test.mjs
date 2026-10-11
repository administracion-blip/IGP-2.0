/**
 * S-13: login, forgot-password y reset-password ante entradas hostiles.
 *
 * - Tipos raros en el cuerpo (número, objeto, array) → 400, no 500.
 * - Usuario inexistente y contraseña mala responden igual y cuestan lo mismo
 *   (bcrypt contra un hash ficticio), para no enumerar cuentas.
 * - forgot-password responde lo mismo exista o no el email.
 * - Las tres rutas tienen limitador de intentos.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-auth-entrada';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { hashPassword } = await import('../lib/password.js');
const { establecerTransporteEmail } = await import('../lib/email.js');
const { crearLimitadoresAuth } = await import('../lib/seguridad/limitadoresAuth.js');
const { default: authRouter } = await import('../routes/auth.js');

const EMAIL = 'local@grupo.test';
const PASSWORD = 'Contraseña-larga-1';

const servidores = [];

async function arrancar({ limitadores } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { warn() {}, error() {}, info() {} };
    next();
  });
  if (limitadores) {
    app.post('/api/login', limitadores.login);
    app.post('/api/forgot-password', limitadores.forgotPassword);
    app.post('/api/reset-password', limitadores.resetPassword);
  }
  app.use('/api', authRouter);
  const servidor = http.createServer(app);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  servidores.push(servidor);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  return async (ruta, cuerpo) => {
    const res = await fetch(base + ruta, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

const enviados = [];
const appPublicPrevia = process.env.APP_PUBLIC_URL;
const smtpPrevio = process.env.SMTP_USER;
process.env.APP_PUBLIC_URL = 'https://erp.grupo.test';
process.env.SMTP_USER = 'smtp@grupo.test';
establecerTransporteEmail({ sendMail: async (m) => { enviados.push(m); return {}; } });

after(() => {
  establecerTransporteEmail(null);
  if (appPublicPrevia === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = appPublicPrevia;
  if (smtpPrevio === undefined) delete process.env.SMTP_USER;
  else process.env.SMTP_USER = smtpPrevio;
  for (const s of servidores) {
    s.closeAllConnections?.();
    s.close();
  }
});

async function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.instalar(docClient);
  db.sembrar(tables.usuarios, {
    id_usuario: '000002', Email: EMAIL, Nombre: 'Ana', Rol: 'Local', Password: await hashPassword(PASSWORD),
  });
  return db;
}

const api = await arrancar();

test('login: email o password que no son texto → 400 (antes 500)', async () => {
  await montar();
  for (const cuerpo of [
    { email: 123, password: PASSWORD },
    { email: { $ne: '' }, password: PASSWORD },
    { email: [EMAIL], password: PASSWORD },
    { email: EMAIL, password: { $gt: '' } },
    { email: EMAIL, password: 12345678 },
    { email: EMAIL, password: [PASSWORD] },
  ]) {
    const r = await api('/api/login', cuerpo);
    assert.equal(r.status, 400, JSON.stringify(cuerpo));
    assert.equal(r.body.error, 'Faltan email o password');
  }
});

test('reset-password y forgot-password: tipos raros → 400', async () => {
  await montar();
  for (const cuerpo of [
    { email: { a: 1 }, token: 'x'.repeat(64), password: 'Nueva-clave-1' },
    { email: EMAIL, token: ['x'], password: 'Nueva-clave-1' },
    { email: EMAIL, token: 'x'.repeat(64), password: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
  ]) {
    const r = await api('/api/reset-password', cuerpo);
    assert.equal(r.status, 400, JSON.stringify(cuerpo));
  }
  const f = await api('/api/forgot-password', { email: { $ne: '' } });
  assert.equal(f.status, 400);
});

async function duracionMediana(fn, veces = 3) {
  const tiempos = [];
  for (let i = 0; i < veces; i += 1) {
    const t0 = process.hrtime.bigint();
    await fn();
    tiempos.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return tiempos.sort((a, b) => a - b)[Math.floor(veces / 2)];
}

test('usuario inexistente y contraseña mala: misma respuesta y coste comparable (bcrypt ficticio)', async () => {
  await montar();
  const mala = await api('/api/login', { email: EMAIL, password: 'no-es-la-buena' });
  const inexistente = await api('/api/login', { email: 'nadie@grupo.test', password: 'no-es-la-buena' });
  assert.equal(mala.status, 401);
  assert.deepEqual(inexistente, mala);

  const tMala = await duracionMediana(() => api('/api/login', { email: EMAIL, password: 'no-es-la-buena' }));
  const tInexistente = await duracionMediana(() => api('/api/login', { email: 'nadie@grupo.test', password: 'x' }));
  // Sin el hash ficticio el inexistente responde en ~1 ms frente a decenas del bcrypt.
  assert.ok(tInexistente > tMala * 0.4, `inexistente ${tInexistente} ms vs contraseña mala ${tMala} ms`);
});

test('forgot-password responde lo mismo exista o no el email', async () => {
  const db = await montar();
  enviados.length = 0;
  const existe = await api('/api/forgot-password', { email: EMAIL });
  const noExiste = await api('/api/forgot-password', { email: 'nadie@grupo.test' });
  assert.equal(existe.status, 200);
  assert.deepEqual(noExiste, existe);
  assert.equal(enviados.length, 1);
  assert.ok(db.obtener(tables.usuarios, { id_usuario: '000002' }).ResetTokenHash);
});

test('login, forgot-password y reset-password tienen limitador de intentos (429)', async () => {
  await montar();
  const limitada = await arrancar({
    limitadores: crearLimitadoresAuth({
      RATE_LIMIT_LOGIN_MAX: '2',
      RATE_LIMIT_FORGOT_MAX: '2',
      RATE_LIMIT_RESET_MAX: '2',
    }),
  });
  const casos = [
    ['/api/login', { email: EMAIL, password: 'mala-mala' }],
    ['/api/forgot-password', { email: EMAIL }],
    ['/api/reset-password', { email: EMAIL, token: 'y'.repeat(64), password: 'Nueva-clave-1' }],
  ];
  for (const [ruta, cuerpo] of casos) {
    await limitada(ruta, cuerpo);
    await limitada(ruta, cuerpo);
    const tercera = await limitada(ruta, cuerpo);
    assert.equal(tercera.status, 429, ruta);
    assert.match(tercera.body.error, /Demasiad/);
  }
});
