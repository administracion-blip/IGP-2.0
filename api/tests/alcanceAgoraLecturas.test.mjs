/**
 * Lecturas de agora.js por local en los dos modos de `ALCANCE_MODO_LECTURAS`:
 * 'observar' (por defecto) sirve todo y avisa; 'bloquear' filtra o da 403.
 * SuperUser restringido a PARIPE (101) intenta leer SUR (202).
 */

import test, { after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-agora';
delete process.env.AGORA_BASE_URL;
process.env.AGORA_API_BASE_URL = 'http://agora.falso';
process.env.AGORA_API_TOKEN = 'token-de-prueba';

// Ágora falso: registra cada llamada y responde sin facturas.
const llamadasAgora = [];
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, opciones) => {
  const u = String(url);
  if (!u.startsWith('http://agora.falso')) return fetchReal(url, opciones);
  llamadasAgora.push(new URL(u));
  return new Response(JSON.stringify({ Invoices: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: agoraRouter } = await import('../routes/agora.js');

const LOCAL_PARIPE = { sub: '000050', email: 'paripe@grupo.test', rol: 'Local' };
const SUPER_PARIPE = { sub: '000051', email: 'super@grupo.test', rol: 'SuperUser' };
const OFICINA = { sub: '000053', email: 'oficina@grupo.test', rol: 'SuperUser' };

const PERMISOS = {
  Local: ['cierres.crear', 'cierres.editar', 'cierres.sincronizar', 'planning_dia.arqueo', 'planning_dia.ver', 'pedidos.ver', 'objetivos.ver'],
  SuperUser: ['cierres.ver', 'excepciones.ver', 'cajas.ver', 'planning_dia.arqueo', 'rrhh.horas', 'objetivos.ver'],
};

const MODO_ORIGINAL = process.env.ALCANCE_MODO_LECTURAS;
function modo(valor) {
  if (valor === undefined) delete process.env.ALCANCE_MODO_LECTURAS;
  else process.env.ALCANCE_MODO_LECTURAS = valor;
}
afterEach(() => modo(MODO_ORIGINAL));

let usuarioActual = LOCAL_PARIPE;
let servidor = null;
let base = '';

async function get(ruta, usuario) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
    app.use('/api', agoraRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetchReal(base + ruta);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
  globalThis.fetch = fetchReal;
});

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.salesCloseOuts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.saleCenters, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.agoraUsuarios, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const [rol, lista] of Object.entries(PERMISOS)) {
    for (const p of lista) db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${p}` });
  }
  db.sembrar(tables.locales, { id_Locales: '000001', nombre: 'PARIPE', agoraCode: '101' });
  db.sembrar(tables.locales, { id_Locales: '000002', nombre: 'SUR', agoraCode: '202' });
  db.sembrar(tables.usuarios, { id_usuario: '000050', Email: 'paripe@grupo.test', Rol: 'Local', Local: ['PARIPE'] });
  db.sembrar(tables.usuarios, { id_usuario: '000051', Email: 'super@grupo.test', Rol: 'SuperUser', Local: ['PARIPE'] });
  db.sembrar(tables.usuarios, { id_usuario: '000053', Email: 'oficina@grupo.test', Rol: 'SuperUser', Local: [] });
  db.sembrar(tables.salesCloseOuts, { PK: '101', SK: '2026-10-01#1#1', BusinessDay: '2026-10-01', InvoicePayments: [{ Amount: 10 }] });
  db.sembrar(tables.salesCloseOuts, { PK: '202', SK: '2026-10-01#1#1', BusinessDay: '2026-10-01', InvoicePayments: [{ Amount: 20 }] });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  llamadasAgora.length = 0;
  return db;
}

async function conAvisos(fn) {
  const avisos = [];
  const original = console.warn;
  console.warn = (...args) => {
    if (args[0] === '[alcance] denegaría') avisos.push(args[1]);
  };
  try {
    return { r: await fn(), avisos };
  } finally {
    console.warn = original;
  }
}

// ─── GET /agora/closeouts ───

test('closeouts: sin cierres.ver, 403 (Local no entra a Cierres teóricos)', async () => {
  montar();
  const r = await get('/api/agora/closeouts', LOCAL_PARIPE);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Permiso insuficiente');
});

test('closeouts en observar: todo, con aviso del local ajeno', async () => {
  montar();
  const { r, avisos } = await conAvisos(() => get('/api/agora/closeouts', SUPER_PARIPE));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.closeouts.map((c) => c.PK).sort(), ['101', '202']);
  assert.deepEqual(avisos, [{ ruta: '/api/agora/closeouts', usuario: '000051', locales: ['202'] }]);
  const ajeno = await conAvisos(() => get('/api/agora/closeouts?workplaceId=202', SUPER_PARIPE));
  assert.equal(ajeno.r.status, 200);
  assert.equal(ajeno.avisos.length, 1);
});

test('closeouts en bloquear: solo el propio local; workplaceId ajeno 403', async () => {
  montar();
  modo('bloquear');
  const r = await get('/api/agora/closeouts', SUPER_PARIPE);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.closeouts.map((c) => c.PK), ['101']);
  assert.equal((await get('/api/agora/closeouts?workplaceId=202', SUPER_PARIPE)).status, 403);
  assert.equal((await get('/api/agora/closeouts?workplaceId=101', SUPER_PARIPE)).status, 200);
  const oficina = await get('/api/agora/closeouts', OFICINA);
  assert.equal(oficina.body.closeouts.length, 2);
});

// ─── Totales ───

test('totals-by-local-range: ajeno pasa con aviso en observar y es 403 en bloquear', async () => {
  montar();
  const q = 'dateFrom=2026-10-01&dateTo=2026-10-01';
  const obs = await conAvisos(() => get(`/api/agora/closeouts/totals-by-local-range?workplaceId=202&${q}`, LOCAL_PARIPE));
  assert.equal(obs.r.status, 200);
  assert.equal(obs.avisos.length, 1);
  modo('bloquear');
  assert.equal((await get(`/api/agora/closeouts/totals-by-local-range?workplaceId=202&${q}`, LOCAL_PARIPE)).status, 403);
  const propio = await get(`/api/agora/closeouts/totals-by-local-range?workplaceId=101&${q}`, LOCAL_PARIPE);
  assert.equal(propio.status, 200);
  assert.deepEqual(propio.body.totals, { '2026-10-01': 10 });
});

test('totals-by-local: observar devuelve los dos locales; bloquear solo el propio', async () => {
  montar();
  const obs = await conAvisos(() => get('/api/agora/closeouts/totals-by-local?businessDay=2026-10-01', SUPER_PARIPE));
  assert.deepEqual(obs.r.body.totals.map((t) => t.workplaceId).sort(), ['101', '202']);
  assert.equal(obs.avisos.length, 1);
  modo('bloquear');
  const r = await get('/api/agora/closeouts/totals-by-local?businessDay=2026-10-01', SUPER_PARIPE);
  assert.deepEqual(r.body.totals.map((t) => t.workplaceId), ['101']);
});

test('totales anuales de grupo (ytd y por mes) no se recortan ni en bloquear', async () => {
  montar();
  modo('bloquear');
  const ytd = await get('/api/agora/closeouts/totals-by-local-ytd?year=2026', LOCAL_PARIPE);
  assert.equal(ytd.status, 200);
  assert.deepEqual(ytd.body.totals.map((t) => t.workplaceId).sort(), ['101', '202']);
  const mes = await get('/api/agora/closeouts/totals-by-month?year=2026', LOCAL_PARIPE);
  assert.equal(mes.body.months[9].total, 30);
});

// ─── Facturas de Ágora ───

const RANGO = 'dateFrom=2026-10-01&dateTo=2026-10-01&refresh=1';

function workplacesPedidosAAgora() {
  return llamadasAgora.map((u) => u.searchParams.get('workplaces'));
}

test('payments-review: sin cierres.ver 403 sin llamar a Ágora', async () => {
  montar();
  const r = await get(`/api/agora/invoices/payments-review?${RANGO}`, LOCAL_PARIPE);
  assert.equal(r.status, 403);
  assert.equal(llamadasAgora.length, 0);
});

test('payments-review en bloquear: sin lista consulta solo el suyo; ajeno 403 sin llamar a Ágora', async () => {
  montar();
  modo('bloquear');
  assert.equal((await get(`/api/agora/invoices/payments-review?${RANGO}`, SUPER_PARIPE)).status, 200);
  assert.deepEqual(workplacesPedidosAAgora(), ['101']);
  llamadasAgora.length = 0;
  assert.equal((await get(`/api/agora/invoices/payments-review?${RANGO}&workplaceIds=202`, SUPER_PARIPE)).status, 403);
  assert.equal(llamadasAgora.length, 0);
  assert.equal((await get(`/api/agora/invoices/payments-review?${RANGO}&workplaceIds=101,202`, SUPER_PARIPE)).status, 200);
  assert.deepEqual(workplacesPedidosAAgora(), ['101']);
});

test('payments-review en observar: consulta lo pedido y avisa', async () => {
  montar();
  const { r, avisos } = await conAvisos(() => get(`/api/agora/invoices/payments-review?${RANGO}&workplaceIds=202`, SUPER_PARIPE));
  assert.equal(r.status, 200);
  assert.deepEqual(workplacesPedidosAAgora(), ['202']);
  assert.deepEqual(avisos[0].locales, ['202']);
});

test('exceptions: sin excepciones.ver 403 sin llamar a Ágora', async () => {
  montar();
  assert.equal((await get(`/api/agora/invoices/exceptions?${RANGO}`, LOCAL_PARIPE)).status, 403);
  assert.equal(llamadasAgora.length, 0);
});

test('exceptions: observar consulta todos con aviso; bloquear solo los suyos o 403', async () => {
  montar();
  const obs = await conAvisos(() => get(`/api/agora/invoices/exceptions?${RANGO}`, SUPER_PARIPE));
  assert.equal(obs.r.status, 200);
  assert.deepEqual(workplacesPedidosAAgora(), [null]);
  assert.deepEqual(obs.avisos[0].locales, ['*']);
  llamadasAgora.length = 0;
  modo('bloquear');
  assert.equal((await get(`/api/agora/invoices/exceptions?${RANGO}`, SUPER_PARIPE)).status, 200);
  assert.deepEqual(workplacesPedidosAAgora(), ['101']);
  llamadasAgora.length = 0;
  assert.equal((await get(`/api/agora/invoices/exceptions?${RANGO}&workplaceIds=202`, SUPER_PARIPE)).status, 403);
  assert.equal(llamadasAgora.length, 0);
  assert.equal((await get(`/api/agora/invoices/exceptions?${RANGO}`, OFICINA)).status, 200);
});

test('sales-by-hour: ajeno con aviso en observar; 403 en bloquear sin llamar a Ágora', async () => {
  montar();
  const obs = await conAvisos(() => get('/api/agora/invoices/sales-by-hour?workplaceId=202&businessDay=2026-10-01&refresh=1', LOCAL_PARIPE));
  assert.equal(obs.r.status, 200);
  assert.equal(obs.avisos.length, 1);
  llamadasAgora.length = 0;
  modo('bloquear');
  const r = await get('/api/agora/invoices/sales-by-hour?workplaceId=202&businessDay=2026-10-01&refresh=1', LOCAL_PARIPE);
  assert.equal(r.status, 403);
  assert.equal(llamadasAgora.length, 0);
  assert.equal((await get('/api/agora/invoices/sales-by-hour?workplaceId=101&businessDay=2026-10-01&refresh=1', LOCAL_PARIPE)).status, 200);
});
