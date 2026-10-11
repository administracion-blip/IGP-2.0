/**
 * S-12: el enlace de recuperación no se construye con un `Origin` arbitrario.
 *
 * Quien pide la recuperación controla la cabecera `Origin`. Si el correo usara
 * esa base, la víctima recibiría desde nuestro remitente un enlace a un dominio
 * del atacante con su token de reset dentro.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-reset';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { establecerTransporteEmail } = await import('../lib/email.js');
const { default: authRouter } = await import('../routes/auth.js');

const EMAIL = 'local@grupo.test';
const GENERICA = 'Si el email está registrado, recibirás un correo con instrucciones para restablecer tu contraseña.';

let enviados = [];
let servidor = null;
let base = '';
const entornoPrevio = {
  SMTP_USER: process.env.SMTP_USER,
  APP_PUBLIC_URL: process.env.APP_PUBLIC_URL,
  NODE_ENV: process.env.NODE_ENV,
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
};

async function pedir(origin) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.log = { warn() {}, error() {}, info() {} };
      next();
    });
    app.use('/api', authRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(`${base}/api/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin && { Origin: origin }) },
    body: JSON.stringify({ email: EMAIL }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.instalar(docClient);
  db.sembrar(tables.usuarios, { id_usuario: '000002', Email: EMAIL, Nombre: 'Ana' });
  return db;
}

beforeEach(() => {
  enviados = [];
  establecerTransporteEmail({ sendMail: async (m) => { enviados.push(m); return {}; } });
  process.env.SMTP_USER = 'smtp@grupo.test';
  delete process.env.APP_PUBLIC_URL;
  process.env.NODE_ENV = 'production';
  process.env.CORS_ALLOWED_ORIGINS = 'https://erp.grupo.test';
});

after(() => {
  establecerTransporteEmail(null);
  for (const [k, v] of Object.entries(entornoPrevio)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  servidor?.closeAllConnections?.();
  servidor?.close();
});

test('Origin falso sin APP_PUBLIC_URL: no se envía correo, no se guarda token y la respuesta es la genérica', async () => {
  const db = montar();
  const errores = [];
  const consolaPrevia = console.error;
  console.error = (...args) => errores.push(args.join(' '));
  let r;
  try {
    r = await pedir('https://phishing.example');
  } finally {
    console.error = consolaPrevia;
  }
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, message: GENERICA });
  assert.equal(enviados.length, 0);
  assert.equal(db.obtener(tables.usuarios, { id_usuario: '000002' }).ResetTokenHash, undefined);
  assert.ok(errores.some((e) => e.includes('APP_PUBLIC_URL no configurada y Origin no permitido')));
});

test('sin Origin ni APP_PUBLIC_URL tampoco se envía (antes salía un enlace relativo)', async () => {
  montar();
  const consolaPrevia = console.error;
  console.error = () => {};
  try {
    const r = await pedir(null);
    assert.deepEqual(r.body, { ok: true, message: GENERICA });
  } finally {
    console.error = consolaPrevia;
  }
  assert.equal(enviados.length, 0);
});

test('con APP_PUBLIC_URL se usa siempre esa base, aunque el Origin sea otro', async () => {
  montar();
  process.env.APP_PUBLIC_URL = 'https://erp.grupo.test/';
  const r = await pedir('https://phishing.example');
  assert.deepEqual(r.body, { ok: true, message: GENERICA });
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].text, /https:\/\/erp\.grupo\.test\/reset-password\?token=/);
  assert.doesNotMatch(enviados[0].html + enviados[0].text, /phishing/);
});

test('sin APP_PUBLIC_URL vale un Origin de la lista blanca de CORS', async () => {
  montar();
  const r = await pedir('https://erp.grupo.test');
  assert.deepEqual(r.body, { ok: true, message: GENERICA });
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].text, /^.*https:\/\/erp\.grupo\.test\/reset-password\?token=/m);
});
