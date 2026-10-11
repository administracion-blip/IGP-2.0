/**
 * S-21: el log de acceso HTTP no puede contener el JWT, las cookies ni la API key
 * de integraciones; los objetos con credenciales que se pasen al logger tampoco.
 * Se usa la misma configuración que lib/logger.js y el mismo serializer de server.js.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import { Writable } from 'node:stream';
import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { OPCIONES_LOGGER } from '../lib/logger.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMDAwMDEifQ.firma-secreta-del-jwt';
const API_KEY = 'igp_live_clave-de-integracion-1234567890';

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

let servidor = null;
after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

test('log de acceso: sin Authorization, Cookie ni X-Api-Key; sí método, url e id', async () => {
  const { logger, lineas } = crearLogger();
  const app = express();
  app.use(pinoHttp({
    logger,
    serializers: {
      req(req) {
        const base = req.raw && typeof req.raw === 'object'
          ? pino.stdSerializers.req(req.raw)
          : { method: req.method, url: req.url };
        return { ...base, id: req.id };
      },
    },
  }));
  app.get('/api/me', (_req, res) => res.json({ ok: true }));
  servidor = http.createServer(app);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));

  const res = await fetch(`http://127.0.0.1:${servidor.address().port}/api/me`, {
    headers: { Authorization: `Bearer ${JWT}`, Cookie: `sesion=${JWT}`, 'X-Api-Key': API_KEY },
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setImmediate(r));

  const salida = lineas.join('');
  assert.ok(salida.includes('/api/me'), 'el log de acceso sigue registrando la ruta');
  assert.ok(salida.includes('"method":"GET"'));
  assert.ok(!salida.includes(JWT), 'el JWT no debe aparecer');
  assert.ok(!salida.includes('firma-secreta'), 'ni un trozo del JWT');
  assert.ok(!salida.includes(API_KEY), 'la API key no debe aparecer');
  const entrada = JSON.parse(lineas.find((l) => l.includes('/api/me')));
  assert.equal(entrada.req.headers.authorization, '[Redacted]');
  assert.equal(entrada.req.headers['x-api-key'], '[Redacted]');
});

test('logger: los campos de credenciales se censuran y los útiles se conservan', () => {
  const { logger, lineas } = crearLogger();
  logger.info({ id_usuario: '000001', password: 'Secreta123!', body: { password: 'otra', email: 'a@b.c' }, apiKey: API_KEY, longitud: 40 }, 'prueba');
  const entrada = JSON.parse(lineas[0]);
  assert.equal(entrada.id_usuario, '000001');
  assert.equal(entrada.longitud, 40);
  assert.equal(entrada.password, '[Redacted]');
  assert.equal(entrada.body.password, '[Redacted]');
  assert.equal(entrada.apiKey, '[Redacted]');
  assert.ok(!lineas[0].includes('Secreta123!'));
  assert.ok(!lineas[0].includes(API_KEY));
});
