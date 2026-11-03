/**
 * Flujo de stock máximo, de punta a punta, con Ágora mockeado.
 * Importar → calcular → editar → aprobar → sync de entregas.
 * Al lado, un informe de consumo ya aprobado: la sync lo sigue leyendo
 * y la aprobación vieja no acepta el conteo nuevo.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import ExcelJS from 'exceljs';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-el-flujo-de-stock-maximo';

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
const { CABECERAS } = await import('../lib/inventarios/excel.js');
const { PK_CONTADOR, SK_CONTADOR } = await import('../lib/mia/contadorPedido.js');
const { prepararLineasConteo } = await import('../lib/mia/importarExcel.js');
const { upsertConfigProducto } = await import('../lib/mia/configProducto.js');
const { guardarTramos } = await import('../lib/mia/tramos.js');
const { crearConteoStock, guardarLineasConteo, leerConteo, skPedidoProveedor } = await import('../lib/mia/conteoStock.js');
const { calcularConteo } = await import('../lib/mia/calculoStock.js');
const { aprobarPedidoProveedor } = await import('../lib/mia/aprobarConteo.js');
const { aprobarInformeMia } = await import('../lib/mia/aprobar.js');
const { syncEntregasAlmacen } = await import('../lib/mia/syncEntregas.js');
const { pkInforme, skInformeLinea } = await import('../lib/mia/keys.js');

let db = null;

after(() => {
  globalThis.fetch = fetchReal;
});

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaConfigProducto, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaInformes, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'WarehouseId-CreadoEn-index': { hashKey: 'WarehouseId', rangeKey: 'CreadoEn' } },
  });
  db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.sembrar(tables.almacenes, { Id: '000101', Nombre: 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro' });
  db.sembrar(tables.agoraProducts, { PK: 'GLOBAL', SK: '501', Id: 501, Name: 'Tonica', VatId: 1 });
  db.sembrar(tables.ajustes, { PK: PK_CONTADOR, SK: SK_CONTADOR, ultimo: 7, serie: 'MIA' });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
}

function maestros() {
  return async () => ({
    warehouse: { Id: 101, Name: 'Almacen Centro' },
    suppliers: new Map([[42, { Id: 42, FiscalName: 'Distrib' }]]),
    vats: new Map([[1, { Id: 1, VatRate: 21, SurchargeRate: 0 }]]),
  });
}

async function excelConteo() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Inventario');
  ws.addRow(CABECERAS);
  ws.addRow([501, 'Bebidas', 'Tonica', null, null, 'ud', 10, 4]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** El Excel no trae proveedor ni unidad. Se copian de la config, con la clave de línea nueva. */
async function copiarProveedorYUnidad(informeId) {
  const PK = pkInforme(informeId);
  const vieja = db.obtener(tables.miaInformeLineas, { PK, SK: skInformeLinea('SIN_PROVEEDOR', '501') });
  const nueva = {
    ...vieja,
    SK: skInformeLinea('42', '501'),
    proveedorId: '42',
    proveedorNombre: 'Distrib',
    purchaseUnitId: '10',
    unit: 'Botella',
  };
  await docClient.send(new DeleteCommand({
    TableName: tables.miaInformeLineas,
    Key: { PK, SK: vieja.SK },
  }));
  await docClient.send(new PutCommand({ TableName: tables.miaInformeLineas, Item: nueva }));

  const hijo = db.obtener(tables.miaInformes, { PK, SK: skPedidoProveedor('SIN_PROVEEDOR') });
  await docClient.send(new DeleteCommand({
    TableName: tables.miaInformes,
    Key: { PK, SK: hijo.SK },
  }));
  await docClient.send(new PutCommand({
    TableName: tables.miaInformes,
    Item: {
      ...hijo,
      SK: skPedidoProveedor('42'),
      proveedorId: '42',
      proveedorNombre: 'Distrib',
      estado: 'generado',
    },
  }));
}

test('importar, calcular, editar, aprobar y sincronizar no toca el informe de consumo', async () => {
  montar();
  await guardarTramos(null, [{ desde: 0, hasta: null, multiplicador: 1 }]);
  await upsertConfigProducto({
    warehouseId: '101',
    productId: '501',
    maximo: 12,
    formatoCompra: 6,
    purchaseUnitId: '10',
    purchaseUnitName: 'Botella',
    proveedorId: '42',
    proveedorNombre: 'Distrib',
  });

  const preparado = await prepararLineasConteo(await excelConteo());
  assert.equal(preparado.lineas[0].proveedorId, 'SIN_PROVEEDOR');
  assert.equal(preparado.lineasContadas, 1);
  const guardado = await crearConteoStock({
    warehouseId: '101',
    semanasDesde: '2026-11-02',
    semanasHasta: '2026-11-08',
    ficheroNombre: 'conteo.xlsx',
    lineas: preparado.lineas,
    lineasLeidas: preparado.lineasLeidas,
    idsDesconocidos: preparado.desconocidos,
    duplicados: preparado.duplicados,
  });
  const informeId = guardado.meta.informeId;
  assert.equal(guardado.meta.multiplicador ?? null, null);

  await copiarProveedorYUnidad(informeId);

  const calculado = await calcularConteo(informeId);
  assert.equal(calculado.multiplicador, 1);
  assert.equal(calculado.lineasSinMaximo, 0);
  assert.equal(calculado.lineas[0].cantidadPedida, 12);

  await guardarLineasConteo(informeId, [{
    productId: '501',
    proveedorId: '42',
    omitida: false,
    cantidadManual: true,
    cantidadPedida: 6,
    maximoManual: false,
  }]);
  const editado = await leerConteo(informeId);
  assert.equal(editado.lineas[0].cantidadPedida, 6);
  assert.equal(editado.lineas[0].cantidadManual, true);

  await assert.rejects(
    () => aprobarInformeMia(informeId),
    (err) => {
      assert.equal(err.status, 409);
      return true;
    },
  );

  const payloads = [];
  const enviado = await aprobarPedidoProveedor(informeId, '42', {
    importar: async (payload) => {
      payloads.push(payload);
      return { status: 200 };
    },
    cargarMaestros: maestros(),
  });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].Serie, 'MIA');
  assert.equal(payloads[0].Number, 8);
  assert.equal(payloads[0].Status, 'Draft');
  assert.equal(payloads[0].Lines[0].OrderedQuantity, 6);
  assert.equal(enviado.estado, 'pedido');

  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#inf-consumo',
    SK: 'META',
    informeId: 'inf-consumo',
    WarehouseId: '000101',
    CreadoEn: '2026-10-25T18:00:00.000Z',
    estado: 'aprobado',
    aprobadoEn: '2026-10-25T16:00:00.000Z',
    agoraPurchaseOrderIds: { 20: { serie: 'MIA', number: 3, ok: true } },
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#inf-consumo',
    SK: 'LINE#20#6740',
    informeId: 'inf-consumo',
    productId: '6740',
    proveedorId: '20',
    purchaseUnitId: '185',
    cantidadPedida: 1,
  });

  const dias = [];
  const out = await syncEntregasAlmacen('101', {
    exportPurchaseOrders: async (dia) => {
      dias.push(dia);
      const PurchaseOrders = [];
      if (dia === enviado.fecha) {
        PurchaseOrders.push({
          Serie: 'MIA',
          Number: enviado.number,
          Lines: [{ ProductId: 501, PurchaseUnitId: 10, DeliveredQuantity: 4 }],
        });
      }
      if (dia === '2026-10-25') {
        PurchaseOrders.push({
          Serie: 'MIA',
          Number: 3,
          Lines: [{ ProductId: 6740, PurchaseUnitId: 185, DeliveredQuantity: 1 }],
        });
      }
      return { PurchaseOrders };
    },
  });

  assert.ok(dias.includes(enviado.fecha));
  assert.ok(dias.includes('2026-10-25'));
  const nueva = db.obtener(tables.miaInformeLineas, { PK: pkInforme(informeId), SK: skInformeLinea('42', '501') });
  const vieja = db.obtener(tables.miaInformeLineas, { PK: 'INFORME#inf-consumo', SK: 'LINE#20#6740' });
  const metaVieja = db.obtener(tables.miaInformes, { PK: 'INFORME#inf-consumo', SK: 'META' });
  assert.equal(nueva.cantidadEntregada, 4);
  assert.equal(vieja.cantidadEntregada, 1);
  assert.equal(metaVieja.estado, 'aprobado');
  assert.ok(out.lineasActualizadas >= 2);
});
