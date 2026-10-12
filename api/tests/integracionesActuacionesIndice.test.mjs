/**
 * La API externa de actuaciones pagina el GSI Listado-Fecha.
 * El cursor antiguo (fecha + hora + id) sigue saltando por ese orden.
 * Un rango de más de 366 días responde 400.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-integraciones';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { aplicarClavesGsi, clavesActuacion } = await import('../lib/clavesIndice.js');
const { default: integracionesRouter } = await import('../routes/integraciones.js');

const API_KEY = 'clave-de-prueba-actuaciones';

function actuacion(campos, { sellar = true } = {}) {
  const item = {
    id_local: '000010',
    local_nombre_snapshot: 'Bar Norte',
    artista_nombre_snapshot: 'Trío',
    hora_inicio: '22:00',
    ...campos,
  };
  if (sellar) aplicarClavesGsi(item, clavesActuacion(item));
  return item;
}

const db = crearDynamoMemoria({ paginaTam: 1 });
db.crearTabla(tables.integracionesApi, {
  hashKey: 'id_clave',
  indices: { GsiKeyHash: { hashKey: 'key_hash' } },
}, [{
  id_clave: 'k1',
  key_hash: crypto.createHash('sha256').update(API_KEY).digest('hex'),
  activa: true,
  scopes: ['actuaciones:read'],
  key_prefix: 'cla',
}]);
db.crearTabla(tables.actuaciones, {
  hashKey: 'id_actuacion',
  indices: {
    'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' },
    'Artista-Fecha-index': { hashKey: 'gsi_artista', rangeKey: 'gsi_fecha' },
  },
}, [
  actuacion({ id_actuacion: 'B', fecha: '2026-10-12', hora_inicio: '22:00', id_artista: 'art-1' }),
  actuacion({ id_actuacion: 'A', fecha: '2026-10-12', hora_inicio: '21:00', id_artista: 'art-1' }),
  actuacion({ id_actuacion: 'C', fecha: '2026-10-13', hora_inicio: '10:00', id_artista: 'art-1' }),
  actuacion({ id_actuacion: 'FUERA', fecha: '2026-11-02', id_artista: 'art-1' }),
  actuacion({ id_actuacion: 'HUECO', fecha: '2026-10-12', hora_inicio: '20:00', id_artista: '', artista_nombre_snapshot: '' }),
  actuacion({ id_actuacion: 'SIN-GSI', fecha: '2026-10-12', hora_inicio: '18:00', id_artista: 'art-1' }, { sellar: false }),
]);
db.instalar(docClient);

const app = express();
app.use('/api', integracionesRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function get(ruta) {
  const res = await fetch(base + ruta, { headers: { 'X-Api-Key': API_KEY } });
  return { status: res.status, body: await res.json() };
}

const rango = '/api/integraciones/v1/actuaciones?fechaDesde=2026-10-01&fechaHasta=2026-10-31';

test('la primera página trae el orden del índice y deja fuera hueco, otro mes y sin gsi', async () => {
  const { status, body } = await get(`${rango}&limit=2`);
  assert.equal(status, 200);
  assert.deepEqual(body.data.map((a) => a.id_actuacion), ['A', 'B']);
  assert.ok(body.nextCursor);

  const siguiente = await get(`${rango}&limit=2&cursor=${encodeURIComponent(body.nextCursor)}`);
  assert.equal(siguiente.status, 200);
  assert.deepEqual(siguiente.body.data.map((a) => a.id_actuacion), ['C']);
  assert.equal(siguiente.body.nextCursor, null);
});

test('un cursor v1 sigue saltando por fecha, hora e id', async () => {
  const v1 = Buffer.from(JSON.stringify({
    fecha: '2026-10-12',
    hora_inicio: '21:00',
    id_actuacion: 'A',
  }), 'utf8').toString('base64url');
  const { status, body } = await get(`${rango}&limit=10&cursor=${encodeURIComponent(v1)}`);
  assert.equal(status, 200);
  assert.deepEqual(body.data.map((a) => a.id_actuacion), ['B', 'C']);
});

test('un rango de más de 366 días responde 400', async () => {
  const { status, body } = await get(
    '/api/integraciones/v1/actuaciones?fechaDesde=2026-01-01&fechaHasta=2027-01-02',
  );
  assert.equal(status, 400);
  assert.match(body.error, /366/);
});
