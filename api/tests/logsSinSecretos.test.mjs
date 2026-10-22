/**
 * S-21: el log de acceso HTTP no puede contener el JWT, las cookies, la API key
 * de integraciones ni el secreto interno; los objetos con credenciales que se
 * pasen al logger tampoco. Se usa la configuración real de lib/logger.js
 * (OPCIONES_LOGGER y opcionesLogHttp, la misma que monta server.js).
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import { Writable } from 'node:stream';
import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { OPCIONES_LOGGER, opcionesLogHttp } from '../lib/logger.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMDAwMDEifQ.firma-secreta-del-jwt';
const API_KEY = 'igp_live_clave-de-integracion-1234567890';
const SECRETO_INTERNO = 'secreto-interno-de-sincronizacion-abcdef123456';
const TOKEN_ICS = 'token-del-feed-ics-987654';

function crearLogger() {
  const lineas = [];
  const destino = new Writable({
    write(chunk, _enc, cb) {
      lineas.push(String(chunk));
      cb();
    },
  });
  return { logger: pino({ ...OPCIONES_LOGGER, level: 'info' }, destino), lineas };
}

const servidores = [];
after(() => {
  for (const s of servidores) {
    s.closeAllConnections?.();
    s.close();
  }
});

async function peticionLogueada(ruta, headers) {
  const { logger, lineas } = crearLogger();
  const app = express();
  app.use(pinoHttp(opcionesLogHttp(logger)));
  app.get(/.*/, (_req, res) => res.json({ ok: true }));
  const servidor = http.createServer(app);
  servidores.push(servidor);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  const res = await fetch(`http://127.0.0.1:${servidor.address().port}${ruta}`, { headers });
  assert.equal(res.status, 200);
  await new Promise((r) => setImmediate(r));
  return lineas;
}

test('log de acceso: X-Internal-Secret, Authorization, Cookie y X-Api-Key salen como ***', async () => {
  const lineas = await peticionLogueada('/api/me', {
    'X-Internal-Secret': SECRETO_INTERNO,
    Authorization: `Bearer ${JWT}`,
    Cookie: `sesion=${JWT}`,
    'X-Api-Key': API_KEY,
  });

  const salida = lineas.join('');
  assert.ok(salida.includes('/api/me'), 'el log de acceso sigue registrando la ruta');
  assert.ok(salida.includes('"method":"GET"'));
  assert.ok(!salida.includes(SECRETO_INTERNO), 'el secreto interno no debe aparecer');
  assert.ok(!salida.includes(JWT), 'el JWT no debe aparecer');
  assert.ok(!salida.includes('firma-secreta'), 'ni un trozo del JWT');
  assert.ok(!salida.includes(API_KEY), 'la API key no debe aparecer');
  const entrada = JSON.parse(lineas.find((l) => l.includes('/api/me')));
  assert.equal(entrada.req.headers['x-internal-secret'], '***');
  assert.equal(entrada.req.headers.authorization, '***');
  assert.equal(entrada.req.headers.cookie, '***');
  assert.equal(entrada.req.headers['x-api-key'], '***');
});

test('log de acceso: el ?token= de la URL se oculta y el resto de la URL se conserva', async () => {
  const lineas = await peticionLogueada(`/api/public/ics?token=${TOKEN_ICS}&local=1`, {});
  const salida = lineas.join('');
  assert.ok(!salida.includes(TOKEN_ICS), 'el token de la URL no debe aparecer');
  const entrada = JSON.parse(lineas.find((l) => l.includes('/api/public/ics')));
  assert.equal(entrada.req.url, '/api/public/ics?token=***&local=1');
  assert.equal(entrada.req.query.token, '***');
  assert.equal(entrada.req.query.local, '1');
});

test('logger: cabeceras sensibles dentro de objetos con headers salen como ***', () => {
  const { logger, lineas } = crearLogger();
  logger.warn({
    headers: { 'x-internal-secret': SECRETO_INTERNO, accept: 'application/json' },
    peticion: {
      url: 'http://127.0.0.1:3002/api/sync',
      headers: { 'x-internal-secret': SECRETO_INTERNO, authorization: `Bearer ${JWT}`, cookie: `sesion=${JWT}` },
    },
  }, 'sync');
  const entrada = JSON.parse(lineas[0]);
  assert.equal(entrada.headers['x-internal-secret'], '***');
  assert.equal(entrada.headers.accept, 'application/json');
  assert.equal(entrada.peticion.headers['x-internal-secret'], '***');
  assert.equal(entrada.peticion.headers.authorization, '***');
  assert.equal(entrada.peticion.headers.cookie, '***');
  assert.ok(!lineas[0].includes(SECRETO_INTERNO));
  assert.ok(!lineas[0].includes(JWT));
});

test('logger: las cabeceras de salida con mayúsculas (X-Internal-Secret, Authorization) también salen como ***', () => {
  const { logger, lineas } = crearLogger();
  logger.warn({
    headers: { 'X-Internal-Secret': SECRETO_INTERNO, 'Content-Type': 'application/json' },
    peticion: { headers: { 'X-Internal-Secret': SECRETO_INTERNO, Authorization: `Bearer ${JWT}` } },
  }, 'salida');
  const entrada = JSON.parse(lineas[0]);
  assert.equal(entrada.headers['X-Internal-Secret'], '***');
  assert.equal(entrada.headers['Content-Type'], 'application/json');
  assert.equal(entrada.peticion.headers['X-Internal-Secret'], '***');
  assert.equal(entrada.peticion.headers.Authorization, '***');
  assert.ok(!lineas[0].includes(SECRETO_INTERNO));
  assert.ok(!lineas[0].includes(JWT));
});

test('logger: los campos de credenciales se censuran y los útiles se conservan', () => {
  const { logger, lineas } = crearLogger();
  logger.info({ id_usuario: '000001', password: 'Secreta123!', body: { password: 'otra', email: 'a@b.c' }, apiKey: API_KEY, longitud: 40 }, 'prueba');
  const entrada = JSON.parse(lineas[0]);
  assert.equal(entrada.id_usuario, '000001');
  assert.equal(entrada.longitud, 40);
  assert.equal(entrada.password, '***');
  assert.equal(entrada.body.password, '***');
  assert.equal(entrada.body.email, 'a@b.c');
  assert.equal(entrada.apiKey, '***');
  assert.ok(!lineas[0].includes('Secreta123!'));
  assert.ok(!lineas[0].includes(API_KEY));
});

test('logger: la cabecera Api-Token de Ágora en un objeto de petición se censura', () => {
  const { logger, lineas } = crearLogger();
  logger.warn({ peticion: { url: 'https://agora/api/import/', headers: { 'api-token': API_KEY, accept: 'application/json' } } }, 'ágora');
  const entrada = JSON.parse(lineas[0]);
  assert.equal(entrada.peticion.headers['api-token'], '***');
  assert.equal(entrada.peticion.headers.accept, 'application/json');
  assert.ok(!lineas[0].includes(API_KEY));
});
