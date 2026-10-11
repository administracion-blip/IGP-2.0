/**
 * S-19: el texto crudo de Ágora no llega al cliente en respuestas 200
 * (aviso de centros de venta en sale-centers/sync, agoraResultados de MIA).
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-fugas-agora';
delete process.env.AGORA_BASE_URL;
delete process.env.AGORA_PURCHASE_ORDER_SERIE;
process.env.AGORA_API_BASE_URL = 'http://agora.falso';
process.env.AGORA_API_TOKEN = 'token-de-prueba';

const DETALLE = 'detalle-interno-de-agora-xyz';
let importaciones = 0;
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, opciones) => {
  const u = String(url);
  if (!u.startsWith('http://agora.falso')) return fetchReal(url, opciones);
  const json = (cuerpo, status = 200) =>
    new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('filter=SaleCenters')) return json({ message: DETALLE }, 400);
  // Los proveedores se envían ordenados: el primero entra y el segundo lo rechaza Ágora.
  if (u.endsWith('/api/import/')) {
    importaciones += 1;
    return importaciones === 1 ? json({ ok: 1 }) : json({ message: DETALLE, interno: DETALLE }, 400);
  }
  return json({});
};

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { aprobarInformeMia } = await import('../lib/mia/aprobar.js');
const { default: agoraRouter } = await import('../routes/agora.js');

const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };
let db;
let servidor = null;

beforeEach(() => {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.saleCenters, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(tables.miaInformes, { hashKey: 'PK', rangeKey: 'SK' });
  if (tables.miaInformeLineas !== tables.miaInformes) {
    db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  }
  db.instalar(docClient);
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
  globalThis.fetch = fetchReal;
});

test('sale-centers/sync: si fallan los centros de venta, el aviso no copia el texto de Ágora', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = ADMIN;
    next();
  });
  app.use('/api', agoraRouter);
  servidor = http.createServer(app);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  const res = await fetchReal(`http://127.0.0.1:${servidor.address().port}/api/agora/sale-centers/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.priceListsWarning, 'Ágora rechazó la operación');
  assert.doesNotMatch(JSON.stringify(body), new RegExp(DETALLE));
});

test('MIA aprobar: el proveedor rechazado por Ágora no lleva agoraBody y se limpian los antiguos', async () => {
  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#I1',
    SK: 'META',
    informeId: 'I1',
    estado: 'calculado',
    warehouseId: '000005',
    agoraResultados: [{ proveedorId: '000999', ok: false, error: 'viejo', agoraBody: { interno: DETALLE } }],
  });
  for (const [prov, prod] of [['000101', '11'], ['000102', '12']]) {
    db.sembrar(tables.miaInformeLineas, {
      PK: 'INFORME#I1', SK: `LINE#${prov}#${prod}`, proveedorId: prov, productId: prod, cantidadPedida: 2,
    });
  }

  const r = await aprobarInformeMia('I1', { usuario: ADMIN });
  const fallido = r.agoraResultados.find((x) => x.proveedorId === '000102');
  assert.equal(fallido.ok, false);
  assert.equal(fallido.error, 'Ágora rechazó la operación');
  assert.equal(fallido.agoraStatus, 400);
  assert.ok(r.agoraResultados.some((x) => x.proveedorId === '000101' && x.ok));
  assert.ok(r.agoraResultados.every((x) => !('agoraBody' in x)), JSON.stringify(r.agoraResultados));
  assert.doesNotMatch(JSON.stringify(r), new RegExp(DETALLE));
  const guardado = db.obtener(tables.miaInformes, { PK: 'INFORME#I1', SK: 'META' });
  assert.doesNotMatch(JSON.stringify(guardado), new RegExp(DETALLE));
});
