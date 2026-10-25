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
const { buildPurchaseOrderPayload } = await import('../lib/agora/purchaseOrdersImport.js');

const COMPRADOR = { sub: '000080', email: 'compras@grupo.test', rol: 'SuperUser' };
const JEFE = { sub: '000082', email: 'jefe@grupo.test', rol: 'Direccion' };
const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };

/** Llamadas a Ágora interceptadas: cuerpo de cada import. */
let llamadasAgora = [];
const fetchOriginal = globalThis.fetch;
/** Maestros que devuelve el export-master simulado (solo lectura). */
const MAESTROS = {
  Warehouses: [{
    Id: 101, Name: 'Almacen Centro', Street: 'C/ Mayor 1', City: 'Granada', Region: 'Granada', ZipCode: '18001',
    FiscalInfo: { UseInDocuments: true, FiscalName: 'Centro SL', Cif: 'B00000001' },
  }],
  Suppliers: [{
    Id: 42, FiscalName: 'Bebidas SL', BusinessName: 'Bebidas', Cif: 'B00000042', Street: '', City: 'Atarfe',
    Region: 'Granada', ZipCode: '18230', AccountCode: '', ApplySurcharge: false, Email: 'x@y.test',
  }],
  Vats: [{ Id: 3, Name: 'Reducido (10%)', VatRate: 0.1, SurchargeRate: 0.014, Enabled: true }],
};
let maestrosFallan = false;
const json = (cuerpo, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith(process.env.AGORA_BASE_URL)) {
    if (u.includes('/api/export-master/')) {
      if (maestrosFallan) return json({ error: 'caído' }, 500);
      const filtro = new URL(u).searchParams.get('filter');
      return json({ [filtro]: MAESTROS[filtro] || [] });
    }
    llamadasAgora.push(JSON.parse(init.body));
    return json({});
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
  db.crearTabla(tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#SuperUser', SK: 'PERMISO#mia.aprobar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Direccion', SK: 'PERMISO#mia.aprobar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Direccion', SK: 'PERMISO#mia.confirmar_agora' });
  db.sembrar(tables.almacenes, { Id: '000101', Nombre: 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro' });
  for (const [id, email, rol] of [['000080', COMPRADOR.email, 'SuperUser'], ['000082', JEFE.email, 'Direccion']]) {
    db.sembrar(tables.usuarios, { id_usuario: id, Email: email, Rol: rol, Local: ['Bar Centro'] });
  }
  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#inf-1', SK: 'META', informeId: 'inf-1', WarehouseId: '000101', estado: 'calculado',
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#inf-1', SK: 'LINE#00042#501', informeId: 'inf-1', proveedorId: '00042', proveedorNombre: 'Bebidas SL', productId: '501', nombre: 'Tónica', qty: 2, cantidadPedida: 2, costeUnitario: 1, purchaseUnitId: '185', unit: 'caja 25 ud.',
  });
  db.sembrar(tables.agoraProducts, { PK: 'GLOBAL', SK: '501', Id: 501, Name: 'Tónica', VatId: 3 });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

const meta = () => db.obtener(tables.miaInformes, { PK: 'INFORME#inf-1', SK: 'META' });

const IVA_LINEA = { vatId: 3, vatRate: 0.1, surchargeRate: 0.014 };
const CAJA = { purchaseUnitId: 185, purchaseUnitName: 'caja 25 ud.' };

test('la línea tiene la forma del export (PCFI 2757), con la unidad de compra del producto y sin total', () => {
  const po = buildPurchaseOrderPayload({
    serie: 'MIA',
    warehouseId: 1,
    supplierId: 20,
    lines: [
      { productId: '6740', productName: '  vaso plastico conico ', orderedQuantity: 1, price: 0.92, ...CAJA, ...IVA_LINEA },
      { productId: 100, productName: 'Agua', orderedQuantity: 1, price: 1, ...CAJA, ...IVA_LINEA },
    ],
  });
  assert.deepEqual(po.Lines.map((l) => l.Index), [0, 1]);
  assert.deepEqual(po.Lines[0], {
    Index: 0,
    ProductId: 6740,
    ProductName: 'vaso plastico conico',
    PurchaseUnitId: 185,
    PurchaseUnitName: 'caja 25 ud.',
    VatId: 3,
    VatRate: 0.1,
    SurchargeRate: 0.014,
    OrderedQuantity: 1,
    DeliveredQuantity: 0,
    DiscountRate: 0,
    CashDiscount: 0,
    Price: 0.92,
  });
  for (const clave of ['Product', 'PurchaseUnit', 'FamilyId', 'FamilyName', 'ProductSupplierReference', 'TotalAmount']) {
    assert.equal(clave in po.Lines[0], false, clave);
  }
});

test('sin impuesto el payload falla y no se llama a Ágora', () => {
  assert.throws(
    () => buildPurchaseOrderPayload({
      serie: 'MIA',
      warehouseId: 1,
      supplierId: 20,
      lines: [{ productId: 6740, productName: 'vaso', orderedQuantity: 1, price: 0.92, ...CAJA }],
    }),
    (err) => err.status === 400 && /no tiene impuesto/.test(err.message),
  );
});

test('sin unidad de compra el payload falla y no se llama a Ágora', () => {
  assert.throws(
    () => buildPurchaseOrderPayload({
      serie: 'MIA',
      warehouseId: 1,
      supplierId: 20,
      lines: [{ productId: 6740, productName: 'vaso', orderedQuantity: 1, price: 0.92, ...IVA_LINEA }],
    }),
    (err) => err.status === 400 && /unidad de compra/.test(err.message),
  );
});

test('sin nombre de producto el payload falla y no hay nada que enviar a Ágora', () => {
  assert.throws(
    () => buildPurchaseOrderPayload({
      serie: 'MIA',
      warehouseId: 1,
      supplierId: 20,
      lines: [{ productId: 2736, orderedQuantity: 7, price: 0.92 }],
    }),
    (err) => err.status === 400 && /no tiene nombre/.test(err.message),
  );
});

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

test('Warehouse y Supplier van completos desde los maestros de Ágora, como en el export', async () => {
  const r = await api('POST', '/api/mia/informes/inf-1/aprobar', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const po = llamadasAgora[0].PurchaseOrders[0];
  assert.deepEqual(po.Warehouse, {
    Id: 101, Name: 'Almacen Centro', Street: 'C/ Mayor 1', City: 'Granada', Region: 'Granada',
    ZipCode: '18001', Cif: 'B00000001', FiscalName: 'Centro SL',
  });
  assert.deepEqual(po.Supplier, {
    Id: 42, FiscalName: 'Bebidas SL', Cif: 'B00000042', Street: '', City: 'Atarfe', Region: 'Granada',
    ZipCode: '18230', ApplySurcharge: false, AccountCode: '',
  });
  assert.equal(po.Serie, 'MIA');
  assert.equal(po.Lines[0].Index, 0);
  assert.equal(po.Lines[0].VatId, 3);
  assert.equal(po.Lines[0].VatRate, 0.1);
  assert.equal(po.Lines[0].SurchargeRate, 0.014);
  assert.equal(po.Lines[0].PurchaseUnitId, 185);
  assert.equal(po.Lines[0].PurchaseUnitName, 'caja 25 ud.');
  assert.equal('PurchaseUnit' in po.Lines[0], false);
});

test('si el maestro de impuestos no responde, no se llama a Ágora y el informe sigue editable', async () => {
  maestrosFallan = true;
  try {
    const r = await api('POST', '/api/mia/informes/inf-1/aprobar', {});
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.equal(llamadasAgora.length, 0);
    assert.equal(meta().estado, 'calculado');
  } finally {
    maestrosFallan = false;
  }
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
