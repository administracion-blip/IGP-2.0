/**
 * Mystery, incidencias sin local, negociaciones y acuerdos por su GSI.
 * Lo que no tiene gsi no entra en el resultado.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-lecturas-indice';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { aplicarClavesGsi, clavesMysteryGuest, clavesMantenimiento, clavesNegociacionMeta } = await import('../lib/clavesIndice.js');
const { default: mysteryRouter } = await import('../routes/mysteryGuest.js');
const { default: mantenimientoRouter } = await import('../routes/mantenimiento.js');
const { default: mayoristaRouter } = await import('../routes/mayorista.js');
const { resolveTotalAportacionUnitaria } = await import('../lib/pedidos/rappelAcuerdo.js');

const db = crearDynamoMemoria();
db.crearTabla(tables.locales, { hashKey: 'id_Locales' }, [
  { id_Locales: '000010', nombre: 'Bar Centro' },
]);
db.crearTabla(tables.mysteryGuest, {
  hashKey: 'ud_mysteryguest',
  indices: { 'Local-Fecha-index': { hashKey: 'gsi_local', rangeKey: 'gsi_fecha' } },
}, [
  aplicarClavesGsi({
    ud_mysteryguest: 'en', FechaDia: '2026-09-10', LocalId: '000010', CreadoEn: '1',
  }, clavesMysteryGuest({ FechaDia: '2026-09-10', LocalId: '000010' })),
  { ud_mysteryguest: 'sin', FechaDia: '2026-09-10', LocalId: '000010', CreadoEn: '2' },
]);
db.crearTabla(tables.mantenimiento, {
  hashKey: 'PK',
  rangeKey: 'SK',
  indices: { 'Tipo-Fecha-index': { hashKey: 'gsi_tipo', rangeKey: 'gsi_fecha' } },
}, [
  aplicarClavesGsi({
    PK: 'LOCAL#000010', SK: 'INC#1', tipo: 'INC', id_incidencia: 'inc-ok',
    fecha_creacion: '2026-09-01T10:00:00.000Z', local_id: '000010', estado: 'Nuevo',
  }, clavesMantenimiento({ tipo: 'INC', fecha_creacion: '2026-09-01T10:00:00.000Z' })),
  {
    PK: 'LOCAL#000010', SK: 'INC#2', tipo: 'INC', id_incidencia: 'inc-sin',
    fecha_creacion: '2026-09-02T10:00:00.000Z', local_id: '000010', estado: 'Nuevo',
  },
]);
db.crearTabla(tables.negociaciones, {
  hashKey: 'PK',
  rangeKey: 'SK',
  indices: { 'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' } },
}, [
  aplicarClavesGsi({
    PK: 'N1', SK: 'META', id: 'N1', nombre: 'Trato', fecha: '2026-09-01', estado: 'borrador',
  }, clavesNegociacionMeta({ SK: 'META', fecha: '2026-09-01' })),
  { PK: 'N1', SK: 'L#1', entityType: 'LINEA', producto_id: 'P1' },
]);
db.crearTabla(tables.acuerdos, { hashKey: 'PK', rangeKey: 'SK' }, [
  { PK: 'A1', SK: 'META', Estado: 'Activo', FechaInicio: '2026-01-01', FechaFin: '2026-12-31' },
  { PK: 'A2', SK: 'META', Estado: 'Activo', FechaInicio: '2026-01-01', FechaFin: '2026-12-31' },
]);
db.crearTabla(tables.acuerdosDetalles, {
  hashKey: 'PK',
  rangeKey: 'SK',
  indices: { 'Producto-index': { hashKey: 'gsi_producto' } },
}, [
  { PK: 'A1', SK: '00010', ProductId: '00010', gsi_producto: '10', Aportacion: 2, Rappel: 0, DescuentoExtra: 0 },
  { PK: 'A2', SK: '00010', ProductId: '00010', Aportacion: 9, Rappel: 0, DescuentoExtra: 0 },
]);
db.instalar(docClient);
invalidarMaestroLocales();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { sub: '000001', rol: 'Administrador' };
  next();
});
app.use('/api', mysteryRouter);
app.use('/api', mantenimientoRouter);
app.use('/api', mayoristaRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function get(ruta) {
  const res = await fetch(base + ruta);
  return { status: res.status, body: await res.json() };
}

test('mystery guest solo devuelve el local y el día que están en el índice', async () => {
  const { status, body } = await get('/api/mystery-guest?fechaDesde=2026-09-01&fechaHasta=2026-09-30');
  assert.equal(status, 200);
  assert.deepEqual(body.valoraciones.map((v) => v.id_MisteryGuest), ['en']);
});

test('incidencias sin local salen del índice Tipo-Fecha', async () => {
  const { status, body } = await get('/api/mantenimiento/incidencias');
  assert.equal(status, 200);
  assert.deepEqual(body.incidencias.map((i) => i.id_incidencia), ['inc-ok']);
});

test('el listado de negociaciones solo incluye el META indexado', async () => {
  const { status, body } = await get('/api/mayorista/negociaciones');
  assert.equal(status, 200);
  assert.deepEqual(body.negociaciones.map((n) => n.id), ['N1']);
});

test('el rappel de un producto no suma el detalle que no está en el índice', async () => {
  assert.equal(await resolveTotalAportacionUnitaria('00010', '2026-06-01'), 2);
  assert.equal(await resolveTotalAportacionUnitaria('999', '2026-06-01'), 0);
});
