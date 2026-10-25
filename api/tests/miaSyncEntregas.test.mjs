/**
 * La cantidad entregada de Ágora se guarda en la línea.
 * Una llamada de export por día, sin Scan y sin tocar la cabecera.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { syncEntregasAlmacen } = await import('../lib/mia/syncEntregas.js');

function preparar(db) {
  db.crearTabla(tables.miaInformes, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'WarehouseId-CreadoEn-index': { hashKey: 'WarehouseId', rangeKey: 'CreadoEn' },
    },
  });
  db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
}

test('syncEntregasAlmacen escribe la cantidad entregada y no toca la cabecera', async () => {
  const db = crearDynamoMemoria();
  preparar(db);
  const meta = {
    PK: 'INFORME#inf-a',
    SK: 'META',
    informeId: 'inf-a',
    WarehouseId: '000001',
    CreadoEn: '2026-10-25T18:00:00.000Z',
    estado: 'aprobado',
    aprobadoEn: '2026-10-25T16:00:00.000Z',
    agoraPurchaseOrderIds: {
      '20': { serie: 'MIA', number: 941449357, ok: true },
      '21': { serie: 'MIA', number: 941449358, ok: true },
    },
    totales: { costeTotal: 1 },
  };
  db.sembrar(tables.miaInformes, meta);
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#inf-a',
    SK: 'LINE#20#6740',
    informeId: 'inf-a',
    productId: '6740',
    proveedorId: '20',
    purchaseUnitId: '185',
    cantidadPedida: 1,
  });
  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#inf-calc',
    SK: 'META',
    informeId: 'inf-calc',
    WarehouseId: '000001',
    CreadoEn: '2026-10-25T19:00:00.000Z',
    estado: 'calculado',
    agoraPurchaseOrderIds: { '20': { serie: 'MIA', number: 1, ok: true } },
  });

  const dias = [];
  const out = await syncEntregasAlmacen('1', {
    exportPurchaseOrders: async (dia) => {
      dias.push(dia);
      return {
        PurchaseOrders: [
          {
            Serie: 'MIA',
            Number: 941449357,
            Lines: [
              { ProductId: 6740, PurchaseUnitId: 185, DeliveredQuantity: 1 },
              { ProductId: 9999, PurchaseUnitId: 1, DeliveredQuantity: 4 },
            ],
          },
          {
            Serie: 'MIA',
            Number: 941449358,
            Lines: [],
          },
        ],
      };
    },
  });

  assert.deepEqual(dias, ['2026-10-25']);
  assert.equal(out.lineasActualizadas, 1);
  assert.equal(out.lineasNoEncontradas, 1);
  assert.equal(out.pedidosEncontrados, 2);
  assert.equal(db.operaciones.some((op) => op.tipo === 'ScanCommand'), false);
  assert.equal(
    db.operaciones.some((op) => op.tipo === 'PutCommand' && op.tabla === tables.miaInformes),
    false,
  );

  const linea = db.obtener(tables.miaInformeLineas, { PK: 'INFORME#inf-a', SK: 'LINE#20#6740' });
  assert.equal(linea.cantidadEntregada, 1);
  assert.equal(linea.cantidadPedida, 1);
  assert.deepEqual(db.obtener(tables.miaInformes, { PK: 'INFORME#inf-a', SK: 'META' }), meta);
});

test('syncEntregasAlmacen consulta como máximo los días pedidos, los más recientes', async () => {
  const db = crearDynamoMemoria();
  preparar(db);
  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#nuevo',
    SK: 'META',
    informeId: 'nuevo',
    WarehouseId: '000001',
    CreadoEn: '2026-10-25T18:00:00.000Z',
    estado: 'aprobado',
    aprobadoEn: '2026-10-25T16:00:00.000Z',
    agoraPurchaseOrderIds: { '20': { serie: 'MIA', number: 2, ok: true } },
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#nuevo',
    SK: 'LINE#20#6740',
    productId: '6740',
    proveedorId: '20',
    cantidadPedida: 1,
  });
  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#viejo',
    SK: 'META',
    informeId: 'viejo',
    WarehouseId: '000001',
    CreadoEn: '2026-10-20T18:00:00.000Z',
    estado: 'aprobado_parcial',
    aprobadoEn: '2026-10-20T16:00:00.000Z',
    agoraPurchaseOrderIds: { '20': { serie: 'MIA', number: 1, ok: true } },
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#viejo',
    SK: 'LINE#20#2736',
    productId: '2736',
    proveedorId: '20',
    cantidadPedida: 7,
  });

  const dias = [];
  await syncEntregasAlmacen('000001', {
    maxDias: 1,
    exportPurchaseOrders: async (dia) => {
      dias.push(dia);
      return {
        PurchaseOrders: [
          { Serie: 'MIA', Number: 2, Lines: [{ ProductId: 6740, DeliveredQuantity: 3 }] },
          { Serie: 'MIA', Number: 1, Lines: [{ ProductId: 2736, DeliveredQuantity: 7 }] },
        ],
      };
    },
  });

  assert.deepEqual(dias, ['2026-10-25']);
  const nueva = db.obtener(tables.miaInformeLineas, { PK: 'INFORME#nuevo', SK: 'LINE#20#6740' });
  const vieja = db.obtener(tables.miaInformeLineas, { PK: 'INFORME#viejo', SK: 'LINE#20#2736' });
  assert.equal(nueva.cantidadEntregada, 3);
  assert.equal(vieja.cantidadEntregada, undefined);
  assert.equal(db.operaciones.some((op) => op.tipo === 'ScanCommand'), false);
});

test('syncEntregasAlmacen usa la fecha de cada pedido, también en un aprobado parcial', async () => {
  const db = crearDynamoMemoria();
  preparar(db);
  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#parcial',
    SK: 'META',
    informeId: 'parcial',
    WarehouseId: '000001',
    CreadoEn: '2026-10-20T10:00:00.000Z',
    estado: 'aprobado_parcial',
    agoraPurchaseOrderIds: {
      '20': { serie: 'MIA', number: 10, date: '2026-10-20', ok: true },
      '21': { serie: 'MIA', number: 11, date: '2026-10-25', ok: true },
    },
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#parcial',
    SK: 'LINE#20#2736',
    productId: '2736',
    proveedorId: '20',
    cantidadPedida: 7,
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#parcial',
    SK: 'LINE#21#6740',
    productId: '6740',
    proveedorId: '21',
    cantidadPedida: 1,
  });

  const dias = [];
  const out = await syncEntregasAlmacen('000001', {
    exportPurchaseOrders: async (dia) => {
      dias.push(dia);
      return {
        PurchaseOrders: [
          { Serie: 'MIA', Number: 10, Lines: [{ ProductId: 2736, DeliveredQuantity: 2 }] },
          { Serie: 'MIA', Number: 11, Lines: [{ ProductId: 6740, DeliveredQuantity: 1 }] },
        ],
      };
    },
  });

  assert.deepEqual(dias, ['2026-10-25', '2026-10-20']);
  assert.equal(out.sinFecha, 0);
  assert.equal(out.lineasActualizadas, 2);
  assert.equal(
    db.obtener(tables.miaInformeLineas, { PK: 'INFORME#parcial', SK: 'LINE#20#2736' }).cantidadEntregada,
    2,
  );
});

test('exportPurchaseOrders pide PurchaseOrders del business-day', async () => {
  process.env.AGORA_BASE_URL = 'https://agora.test';
  process.env.AGORA_API_TOKEN = 'test-token';
  const original = globalThis.fetch;
  /** @type {string[]} */
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(init.headers['Api-Token'], 'test-token');
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const { exportPurchaseOrders } = await import('../lib/agora/client.js');
    const data = await exportPurchaseOrders('2026-10-25');
    assert.deepEqual(data, {});
    assert.equal(urls.length, 1);
    const url = new URL(urls[0]);
    assert.equal(url.searchParams.get('filter'), 'PurchaseOrders');
    assert.equal(url.searchParams.get('business-day'), '2026-10-25');
    assert.equal(url.searchParams.get('include-processed'), 'true');
  } finally {
    globalThis.fetch = original;
  }
});
