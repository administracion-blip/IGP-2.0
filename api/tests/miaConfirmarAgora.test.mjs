/**
 * S-14: aprobar un informe de MIA crea el pedido en Ágora como borrador. Enviarlo
 * ya 'Confirmed' exige `mia.confirmar_agora`; sin él, 403 y no se llama a Ágora
 * ni cambia el informe (no se degrada a borrador en silencio).
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-mia-confirmar';
process.env.AGORA_BASE_URL = 'http://agora.prueba.test';
process.env.AGORA_API_TOKEN = 'token-de-prueba';
delete process.env.AGORA_API_BASE_URL;
delete process.env.AGORA_PURCHASE_ORDER_SERIE;

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: miaRouter } = await import('../routes/mia.js');

const COMPRADOR = { sub: '000080', email: 'compras@grupo.test', rol: 'SuperUser' };
const JEFE = { sub: '000082', email: 'jefe@grupo.test', rol: 'Direccion' };
const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };

/** Llamadas a Ágora interceptadas: cuerpo de cada import. */
let llamadasAgora = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith(process.env.AGORA_BASE_URL)) {
    llamadasAgora.push(JSON.parse(init.body));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return fetchOriginal(url, init);
};

let usuarioActual = COMPRADOR;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario = COMPRADOR) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      req.log = { info() {}, error() {}, warn() {} };
      next();
    });
    app.use('/api', miaRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetchOriginal(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  globalThis.fetch = fetchOriginal;
  servidor?.closeAllConnections?.();
  servidor?.close();
});

let db = null;

beforeEach(() => {
  llamadasAgora = [];
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaInformes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#SuperUser', SK: 'PERMISO#mia.aprobar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Direccion', SK: 'PERMISO#mia.aprobar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Direccion', SK: 'PERMISO#mia.confirmar_agora' });
  db.sembrar(tables.almacenes, { Id: '101', Nombre: 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro' });
  for (const [id, email, rol] of [['000080', COMPRADOR.email, 'SuperUser'], ['000082', JEFE.email, 'Direccion']]) {
    db.sembrar(tables.usuarios, { id_usuario: id, Email: email, Rol: rol, Local: ['Bar Centro'] });
  }
  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#inf-1', SK: 'META', informeId: 'inf-1', WarehouseId: '000101', estado: 'calculado',
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#inf-1', SK: 'LINE#00042#501', informeId: 'inf-1', proveedorId: '00042', productId: '501', qty: 2, cantidadPedida: 2, costeUnitario: 1,
  });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

const meta = () => db.obtener(tables.miaInformes, { PK: 'INFORME#inf-1', SK: 'META' });

test('sin mia.confirmar_agora, pedir Confirmed: 403 en español, sin llamar a Ágora y el informe queda igual', async () => {
  const antes = meta();
  const r = await api('POST', '/api/mia/informes/inf-1/aprobar', { statusAgora: 'Confirmed' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /confirmado/);
  assert.equal(llamadasAgora.length, 0);
  assert.deepEqual(meta(), antes);
});

test('sin indicar estado: el pedido se crea en Ágora como borrador', async () => {
  const r = await api('POST', '/api/mia/informes/inf-1/aprobar', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(llamadasAgora.length, 1);
  assert.equal(llamadasAgora[0].PurchaseOrders[0].Status, 'Draft');
  assert.equal(meta().statusAgora, 'Draft');
});

test('un valor de estado desconocido también va como borrador', async () => {
  const r = await api('POST', '/api/mia/informes/inf-1/aprobar', { statusAgora: 'Sent' });
  assert.equal(r.status, 200);
  assert.equal(llamadasAgora[0].PurchaseOrders[0].Status, 'Draft');
});

test('con mia.confirmar_agora: el pedido se crea en Ágora confirmado', async () => {
  const r = await api('POST', '/api/mia/informes/inf-1/aprobar', { statusAgora: 'Confirmed' }, JEFE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(llamadasAgora.length, 1);
  assert.equal(llamadasAgora[0].PurchaseOrders[0].Status, 'Confirmed');
  assert.equal(meta().statusAgora, 'Confirmed');
});

test('Administrador puede confirmar sin fila de permiso', async () => {
  const r = await api('POST', '/api/mia/informes/inf-1/aprobar', { statusAgora: 'Confirmed' }, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(llamadasAgora[0].PurchaseOrders[0].Status, 'Confirmed');
});
