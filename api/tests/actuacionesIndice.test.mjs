/**
 * Actuaciones por Listado-Fecha y Artista-Fecha. Lo que no tiene gsi no sale.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-actuaciones-indice';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { aplicarClavesGsi, clavesActuacion } = await import('../lib/clavesIndice.js');
const { default: actuacionesRouter } = await import('../routes/artistasActuaciones.js');

function actuacion(campos, { sellar = true } = {}) {
  const item = {
    id_local: '000010',
    estado: 'pendiente',
    hora_inicio: '22:00',
    ...campos,
  };
  if (sellar) aplicarClavesGsi(item, clavesActuacion(item));
  return item;
}

const db = crearDynamoMemoria();
db.crearTabla(tables.locales, { hashKey: 'id_Locales' }, [
  { id_Locales: '000010', nombre: 'Bar Norte' },
]);
db.crearTabla(tables.artistas, { hashKey: 'id_artista' }, [
  { id_artista: 'art-1', nombre_artistico: 'Trío' },
]);
db.crearTabla(tables.actuaciones, {
  hashKey: 'id_actuacion',
  indices: {
    'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' },
    'Artista-Fecha-index': { hashKey: 'gsi_artista', rangeKey: 'gsi_fecha' },
  },
}, [
  actuacion({ id_actuacion: 'DIA', fecha: '2026-10-12', id_artista: 'art-1', valoracion: 2 }),
  actuacion({ id_actuacion: 'OTRO-DIA', fecha: '2026-10-13', id_artista: 'art-1', hora_inicio: '23:00' }),
  actuacion({ id_actuacion: 'MISMA', fecha: '2026-10-12', id_artista: 'art-1', hora_inicio: '22:00', valoracion: 2 }),
  actuacion({
    id_actuacion: 'SIN-GSI',
    fecha: '2026-10-12',
    id_artista: 'art-1',
    valoracion: 5,
  }, { sellar: false }),
]);
db.instalar(docClient);
invalidarMaestroLocales();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { sub: '000001', rol: 'Administrador' };
  next();
});
app.use('/api', actuacionesRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function llamar(metodo, ruta, body) {
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

test('el listado y el total del día ignoran la actuación sin gsi', async () => {
  const lista = await llamar('GET', '/api/actuaciones?fechaDesde=2026-10-12&fechaHasta=2026-10-12');
  assert.equal(lista.status, 200);
  assert.deepEqual(lista.body.actuaciones.map((a) => a.id_actuacion).sort(), ['DIA', 'MISMA']);

  const total = await llamar('GET', '/api/actuaciones/dia/total?fecha=2026-10-12');
  assert.equal(total.body.total, 2);
});

test('el conflicto de artista sale del índice Artista-Fecha', async () => {
  const r = await llamar('POST', '/api/actuaciones/conflicto-artista', {
    id_actuacion: 'DIA',
    id_artista: 'art-1',
    fecha: '2026-10-12',
    hora_inicio: '22:00',
  });
  assert.equal(r.body.conflicto, true);
  assert.equal(r.body.otro.id_actuacion, 'MISMA');
});

test('la media no cuenta la valoración que no está en el índice', async () => {
  const r = await llamar('PUT', '/api/actuaciones/item/DIA', { valoracion: 4, forzar_conflicto: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const artista = db.obtener(tables.artistas, { id_artista: 'art-1' });
  assert.equal(artista.valoracion_media, 3);
  assert.equal(artista.valoracion_total, 2);
});
