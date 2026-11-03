/**
 * Aprobación de un proveedor del conteo. Ágora entra solo como mock.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-aprobar-conteo';

const fetchReal = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = String(input && typeof input === 'object' && 'url' in input ? input.url : input);
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
    return fetchReal(input, init);
  }
  throw new Error(`No se llama a Ágora en los tests: ${url}`);
};

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { invalidarPermisosRol } = await import('../lib/permisos/cachePermisos.js');
const { PK_CONTADOR, SK_CONTADOR } = await import('../lib/mia/contadorPedido.js');
const {
  MENSAJE_AGORA,
  MENSAJE_EN_CURSO,
  MENSAJE_LINEAS,
  aprobarPedidoProveedor,
} = await import('../lib/mia/aprobarConteo.js');
const { crearConteoStock } = await import('../lib/mia/conteoStock.js');
const { syncEntregasAlmacen } = await import('../lib/mia/syncEntregas.js');
const { default: miaRouter } = await import('../routes/mia.js');

const COMPRADOR = { sub: '000080', email: 'compras@grupo.test', rol: 'SuperUser' };

let usuarioActual = COMPRADOR;
let servidor = null;
let base = '';
let db = null;

async function asegurarServidor() {
  if (servidor) return;
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

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
  globalThis.fetch = fetchReal;
});

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaInformes, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'WarehouseId-CreadoEn-index': { hashKey: 'WarehouseId', rangeKey: 'CreadoEn' } },
  });
  db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const p of ['ver', 'aprobar']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#SuperUser', SK: `PERMISO#mia.${p}` });
  }
  db.sembrar(tables.almacenes, { Id: '000101', Nombre: 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro' });
  db.sembrar(tables.usuarios, { id_usuario: '000080', Email: COMPRADOR.email, Rol: 'SuperUser', Local: ['Bar Centro'] });
  db.sembrar(tables.agoraProducts, { PK: 'GLOBAL', SK: '501', Id: 501, Name: 'Tonica', VatId: 1 });
  db.sembrar(tables.agoraProducts, { PK: 'GLOBAL', SK: '502', Id: 502, Name: 'Agua', VatId: 1 });
  db.sembrar(tables.ajustes, { PK: PK_CONTADOR, SK: SK_CONTADOR, ultimo: 7, serie: 'MIA' });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  invalidarPermisosRol();
}

function maestros() {
  return async () => ({
    warehouse: { Id: 101, Name: 'Almacen Centro' },
    suppliers: new Map([[42, { Id: 42, FiscalName: 'Distrib' }]]),
    vats: new Map([[1, { Id: 1, VatRate: 21, SurchargeRate: 0 }]]),
  });
}

function hijo(proveedorId = '42') {
  return db.obtener(tables.miaInformes, { PK: 'INFORME#c1', SK: `PROV#${proveedorId}` });
}

async function conteoBase(lineas) {
  await crearConteoStock({
    informeId: 'c1',
    warehouseId: '101',
    multiplicador: 1,
    lineas,
  });
}

const LINEA_OK = {
  productId: '501',
  nombre: 'Tonica',
  proveedorId: '42',
  proveedorNombre: 'Distrib',
  stockReal: 4,
  maximo: 10,
  formatoCompra: 6,
  cantidadPedida: 6,
  purchaseUnitId: '10',
  unit: 'Botella',
  costeUnitario: 2,
};

test('un borrador lleva serie MIA y el número del contador; dos a la vez solo envían uno', async () => {
  montar();
  await conteoBase([LINEA_OK]);
  const payloads = [];
  const importar = async (payload) => {
    payloads.push(payload);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: 200 };
  };
  const [a, b] = await Promise.all([
    aprobarPedidoProveedor('c1', '42', { importar, cargarMaestros: maestros() }).then((r) => ({ ok: true, r })).catch((err) => ({ ok: false, err })),
    aprobarPedidoProveedor('c1', '42', { importar, cargarMaestros: maestros() }).then((r) => ({ ok: true, r })).catch((err) => ({ ok: false, err })),
  ]);
  const bien = [a, b].filter((x) => x.ok);
  const mal = [a, b].filter((x) => !x.ok);
  assert.equal(bien.length, 1);
  assert.equal(mal.length, 1);
  assert.equal(mal[0].err.status, 409);
  assert.equal(mal[0].err.message, MENSAJE_EN_CURSO);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].Serie, 'MIA');
  assert.equal(payloads[0].Number, 8);
  assert.equal(payloads[0].Status, 'Draft');
  assert.equal(payloads[0].Lines.length, 1);
  assert.equal(hijo().estado, 'pedido');
  assert.equal(hijo().serie, 'MIA');
  assert.equal(hijo().number, 8);
});

test('una línea sin unidad o sin cantidad no envía y Ágora caído devuelve el hijo a Generado', async () => {
  montar();
  await conteoBase([{ ...LINEA_OK, purchaseUnitId: '', unit: '' }]);
  let llamadas = 0;
  const importar = async () => {
    llamadas += 1;
    return { status: 200 };
  };
  await assert.rejects(
    () => aprobarPedidoProveedor('c1', '42', { importar, cargarMaestros: maestros() }),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.message, MENSAJE_LINEAS);
      assert.equal(err.lineas[0].nombre, 'Tonica');
      assert.match(err.lineas[0].error, /unidad de compra/);
      return true;
    },
  );
  assert.equal(llamadas, 0);
  assert.equal(hijo().estado, 'generado');

  await crearConteoStock({
    informeId: 'c-qty',
    warehouseId: '101',
    lineas: [{ ...LINEA_OK, cantidadPedida: 0 }],
  });
  await assert.rejects(
    () => aprobarPedidoProveedor('c-qty', '42', { importar, cargarMaestros: maestros() }),
    (err) => {
      assert.match(err.lineas[0].error, /cantidad/);
      return true;
    },
  );
  assert.equal(llamadas, 0);
  assert.equal(db.obtener(tables.miaInformes, { PK: 'INFORME#c-qty', SK: 'PROV#42' }).estado, 'generado');

  await crearConteoStock({
    informeId: 'c-agora',
    warehouseId: '101',
    lineas: [LINEA_OK],
  });
  const cae = async () => {
    llamadas += 1;
    throw new Error('red');
  };
  await assert.rejects(
    () => aprobarPedidoProveedor('c-agora', '42', { importar: cae, cargarMaestros: maestros() }),
    (err) => {
      assert.equal(err.message, MENSAJE_AGORA);
      return true;
    },
  );
  assert.equal(llamadas, 1);
  assert.equal(db.obtener(tables.miaInformes, { PK: 'INFORME#c-agora', SK: 'PROV#42' }).estado, 'generado');
  assert.equal(db.obtener(tables.miaInformes, { PK: 'INFORME#c-agora', SK: 'PROV#42' }).number ?? null, null);
});

test('Confirmed pasa el hijo a Confirmado y sin permiso la ruta no envía', async () => {
  montar();
  await conteoBase([LINEA_OK]);
  const hecho = await aprobarPedidoProveedor('c1', '42', {
    statusAgora: 'Confirmed',
    importar: async (payload) => {
      assert.equal(payload.Status, 'Confirmed');
      return { status: 200 };
    },
    cargarMaestros: maestros(),
  });
  assert.equal(hecho.estado, 'confirmado');
  assert.equal(hijo().estado, 'confirmado');
  assert.equal(hijo().number, 8);

  await crearConteoStock({
    informeId: 'c2',
    warehouseId: '101',
    lineas: [{ ...LINEA_OK, proveedorId: '7', proveedorNombre: 'Bodega' }],
  });
  await asegurarServidor();
  const res = await fetch(`${base}/api/mia/conteos/c2/proveedores/7/aprobar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statusAgora: 'Confirmed' }),
  });
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.match(body.error, /confirmado/);
  assert.equal(db.obtener(tables.miaInformes, { PK: 'INFORME#c2', SK: 'PROV#7' }).estado, 'generado');
});

test('la sync lee el hijo del conteo y sigue leyendo el informe antiguo', async () => {
  montar();
  await conteoBase([LINEA_OK]);
  const enviado = await aprobarPedidoProveedor('c1', '42', {
    importar: async () => ({ status: 200 }),
    cargarMaestros: maestros(),
  });
  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#inf-a',
    SK: 'META',
    informeId: 'inf-a',
    WarehouseId: '000101',
    CreadoEn: '2026-10-25T18:00:00.000Z',
    estado: 'aprobado',
    aprobadoEn: '2026-10-25T16:00:00.000Z',
    agoraPurchaseOrderIds: { '20': { serie: 'MIA', number: 3, ok: true } },
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#inf-a',
    SK: 'LINE#20#6740',
    informeId: 'inf-a',
    productId: '6740',
    proveedorId: '20',
    purchaseUnitId: '185',
    cantidadPedida: 1,
  });
  const dias = [];
  const out = await syncEntregasAlmacen('101', {
    exportPurchaseOrders: async (dia) => {
      dias.push(dia);
      return {
        PurchaseOrders: [
          {
            Serie: 'MIA',
            Number: enviado.number,
            Lines: [{ ProductId: 501, PurchaseUnitId: 10, DeliveredQuantity: 4 }],
          },
          {
            Serie: 'MIA',
            Number: 3,
            Lines: [{ ProductId: 6740, PurchaseUnitId: 185, DeliveredQuantity: 1 }],
          },
        ],
      };
    },
  });
  assert.ok(dias.includes(enviado.fecha));
  assert.ok(dias.includes('2026-10-25'));
  const nueva = db.obtener(tables.miaInformeLineas, { PK: 'INFORME#c1', SK: 'LINE#42#501' });
  const vieja = db.obtener(tables.miaInformeLineas, { PK: 'INFORME#inf-a', SK: 'LINE#20#6740' });
  assert.equal(nueva.cantidadEntregada, 4);
  assert.equal(vieja.cantidadEntregada, 1);
  assert.ok(out.lineasActualizadas >= 2);
});
