/**
 * Los listados de cierres consultan por PK (agoraCode) y rango de SK.
 * Un cierre cuyo workplace no está en el maestro no aparece: no hay Scan.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-cierres';
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
const { default: agoraRouter } = await import('../routes/agora.js');

const db = crearDynamoMemoria();
db.crearTabla(tables.locales, { hashKey: 'id_Locales' }, [
  { id_Locales: '000001', nombre: 'Bar Uno', agoraCode: 'WP1' },
]);
db.crearTabla(tables.salesCloseOuts, { hashKey: 'PK', rangeKey: 'SK' }, [
  {
    PK: 'WP1',
    SK: '2026-10-12#1#1',
    PosId: '1',
    PosName: 'Barra',
    InvoicePayments: [{ Amount: 10 }],
  },
  {
    PK: 'WP1',
    SK: '2026-01-02#1#1',
    PosId: '1',
    PosName: 'Barra',
    InvoicePayments: [{ Amount: 5 }],
  },
  {
    PK: 'HUERFANO',
    SK: '2026-10-12#1#1',
    PosId: '9',
    PosName: 'Fuera',
    InvoicePayments: [{ Amount: 50 }],
  },
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

async function get(ruta) {
  const res = await fetchReal(base + ruta);
  return { status: res.status, body: await res.json() };
}

test('el día pedido solo trae los cierres del local del maestro', async () => {
  const { status, body } = await get('/api/agora/closeouts?businessDay=2026-10-12');
  assert.equal(status, 200);
  assert.deepEqual(body.closeouts.map((c) => c.PK), ['WP1']);
  assert.equal(String(body.closeouts[0].SK).startsWith('2026-10-12'), true);
});

test('el total del día ignora el workplace que no está en el maestro', async () => {
  const { status, body } = await get('/api/agora/closeouts/totals-by-local?businessDay=2026-10-12');
  assert.equal(status, 200);
  assert.equal(body.totals.length, 1);
  assert.equal(body.totals[0].local, 'Bar Uno');
  assert.equal(body.totals[0].total, 10);
});

test('el acumulado del año suma los meses del local y no el cierre huérfano', async () => {
  const { status, body } = await get('/api/agora/closeouts/totals-by-local-ytd?year=2026');
  assert.equal(status, 200);
  assert.equal(body.totals.length, 1);
  assert.equal(body.totals[0].total, 15);

  const mes = await get('/api/agora/closeouts/totals-by-month?year=2026');
  assert.equal(mes.status, 200);
  assert.equal(mes.body.months.find((m) => m.month === 10).total, 10);
  assert.equal(mes.body.months.find((m) => m.month === 1).total, 5);

  const home = await get('/api/agora/closeouts/dashboard-home?dateTo=2026-10-12');
  assert.equal(home.status, 200);
  assert.equal(home.body.totalsTicker.length, 1);
  assert.equal(home.body.totalsTicker[0].total, 10);
  assert.equal(home.body.ytdCurrent.totals[0].total, 15);
});
