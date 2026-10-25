/**
 * Lo pedido y no entregado resta de la siguiente propuesta, en la misma unidad de compra.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { buildLineaPedido } = await import('../lib/mia/motor.js');
const { cargarEnCamino, claveEnCamino, pendienteDeLinea } = await import('../lib/mia/enCamino.js');

test('pendienteDeLinea es lo pedido menos lo entregado', () => {
  assert.equal(pendienteDeLinea({ cantidadPedida: 7, cantidadEntregada: 2 }), 5);
  assert.equal(pendienteDeLinea({ cantidadPedida: 7 }), 7);
  assert.equal(pendienteDeLinea({ cantidadPedida: 7, cantidadEntregada: 9 }), 0);
  assert.equal(pendienteDeLinea({ cantidadPedida: 7, omitida: true, cantidadEntregada: 0 }), 0);
});

test('con stock en camino se pide menos, hasta el máximo', () => {
  const built = buildLineaPedido({
    productId: '501',
    config: { Quantity: 25, plazoProveedorDias: 2, frecuenciaPedidoDias: 7 },
    agora: { CostPrice: 2, Name: 'Tónica' },
    ultima: { SupplierId: '12', SupplierName: 'Bebidas SL' },
    warehouseId: '000101',
    demandaBaseTotal: 70,
    demandaAjustada: 80,
    consumoDiario: 10,
    colchonDias: 1,
    proveedoresCfg: new Map(),
    modoDemanda: 'directo',
    enCamino: 10,
  });
  assert.equal(built.linea.maximo, 100);
  assert.equal(built.linea.enCamino, 10);
  assert.equal(built.linea.qty, 65, 'máximo 100 − stock 25 − en camino 10');
});

test('cargarEnCamino suma solo pedidos aprobados de la misma unidad', async () => {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.miaInformes, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'WarehouseId-CreadoEn-index': { hashKey: 'WarehouseId', rangeKey: 'CreadoEn' },
    },
  });
  db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);

  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#ok',
    SK: 'META',
    informeId: 'ok',
    WarehouseId: '000001',
    CreadoEn: '2026-10-25T18:00:00.000Z',
    estado: 'aprobado',
    agoraPurchaseOrderIds: { '20': { serie: 'MIA', number: 11, ok: true } },
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#ok', SK: 'LINE#20#6740', productId: '6740', proveedorId: '20',
    purchaseUnitId: '185', cantidadPedida: 7, cantidadEntregada: 2,
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#ok', SK: 'LINE#20#2736', productId: '2736', proveedorId: '20',
    purchaseUnitId: '1', cantidadPedida: 4,
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#ok', SK: 'LINE#99#6740', productId: '6740', proveedorId: '99',
    purchaseUnitId: '185', cantidadPedida: 9,
  });
  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#calc',
    SK: 'META',
    informeId: 'calc',
    WarehouseId: '000001',
    CreadoEn: '2026-10-26T18:00:00.000Z',
    estado: 'calculado',
    agoraPurchaseOrderIds: { '20': { serie: 'MIA', number: 12, ok: true } },
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#calc', SK: 'LINE#20#6740', productId: '6740', proveedorId: '20',
    purchaseUnitId: '185', cantidadPedida: 20,
  });

  const mapa = await cargarEnCamino('1');
  assert.equal(mapa.get(claveEnCamino('6740', '185')), 5);
  assert.equal(mapa.get(claveEnCamino('2736', '1')), 4);
  assert.equal(mapa.get(claveEnCamino('6740', '1')), undefined);
  assert.equal(db.operaciones.some((op) => op.tipo === 'ScanCommand'), false);
});
