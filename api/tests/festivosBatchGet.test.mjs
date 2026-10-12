/**
 * Los festivos del rango se leen con BatchGet { PK: fecha, SK: '0' }.
 * PK=GLOBAL es informativo y no cambia la comparativa.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-festivos';
delete process.env.AGORA_BASE_URL;
process.env.AGORA_API_BASE_URL = 'http://agora.falso';
process.env.AGORA_API_TOKEN = 'token-de-prueba';

const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, opciones) => {
  const u = String(url);
  if (!u.startsWith('http://agora.falso')) return fetchReal(url, opciones);
  return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { loadFestivosByFecha } = await import('../lib/agora/objetivoMensual.js');
const { default: agoraRouter } = await import('../routes/agora.js');

const db = crearDynamoMemoria();
db.crearTabla(tables.locales, { hashKey: 'id_Locales' }, [
  { id_Locales: '000001', nombre: 'Bar Uno', agoraCode: 'WP1' },
]);
db.crearTabla(tables.salesCloseOuts, { hashKey: 'PK', rangeKey: 'SK' }, [
  { PK: 'WP1', SK: '2026-10-12#1#1', PosId: '1', PosName: 'Barra', InvoicePayments: [{ Amount: 10 }] },
  { PK: 'WP1', SK: '2025-10-12#1#1', PosId: '1', PosName: 'Barra', InvoicePayments: [{ Amount: 99 }] },
]);
db.crearTabla(tables.gestionFestivos, { hashKey: 'PK', rangeKey: 'SK' }, [
  { PK: '2026-10-12', SK: '0', FechaComparativa: '2025-12-20', Festivo: true, NombreFestivo: 'Puente' },
  { PK: '2026-10-12', SK: 'otro', FechaComparativa: '2025-10-12', Festivo: true, NombreFestivo: 'No es la clave' },
  { PK: 'GLOBAL', SK: 'f1', FechaComparativa: '2025-10-12', Festivo: true, NombreFestivo: 'Navidad informativa' },
]);
db.instalar(docClient);
invalidarMaestroLocales();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { sub: '000001', rol: 'Administrador' };
  next();
});
app.use('/api', agoraRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
  globalThis.fetch = fetchReal;
});

test('loadFestivosByFecha solo devuelve la clave del día', async () => {
  const map = await loadFestivosByFecha('2026-10-12', '2026-10-12');
  assert.equal(map.size, 1);
  assert.equal(map.get('2026-10-12').FechaComparativa, '2025-12-20');
  assert.equal(map.has('GLOBAL'), false);
});

test('cajas/top usa el festivo SK 0 y no el GLOBAL', async () => {
  const res = await fetchReal(`${base}/api/cajas/top?dateFrom=2026-10-12&dateTo=2026-10-12&workplaceIds=WP1`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const objetivo = (body.objetivos || []).find((o) => o.workplaceId === 'WP1');
  assert.ok(objetivo, JSON.stringify(body.objetivos));
  assert.equal(objetivo.real, 10);
  assert.equal(objetivo.comparativa, 0);
});
