/**
 * Documento de conteo por stock máximo: cabecera, líneas y un estado por proveedor.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { crearConteoStock, listarPedidosProveedor, marcarPedidoProveedor } = await import('../lib/mia/conteoStock.js');

function preparar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.miaInformes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  return db;
}

const LINEAS = [
  { productId: '501', nombre: 'Tónica', proveedorId: '42', proveedorNombre: 'Mahou', stockReal: 4, maximo: 12, cantidadPedida: 8 },
  { productId: '502', nombre: 'Hielo', proveedorId: 'SIN_PROVEEDOR', proveedorNombre: '', stockReal: null, maximo: 40 },
];

test('crear guarda el tipo, el stock vacío como null y un pedido generado por proveedor', async () => {
  const db = preparar();
  const { meta, pedidos } = await crearConteoStock({
    informeId: 'c1',
    warehouseId: '20',
    semanasDesde: '2026-11-02',
    semanasHasta: '2026-11-08',
    ficheroNombre: 'inventario_almacen.xlsx',
    lineas: LINEAS,
    previsionImporte: 28450,
    multiplicador: 2,
    previsionAviso: null,
  });
  assert.equal(meta.tipo, 'stock_maximo');
  assert.equal(meta.WarehouseId, '000020');
  assert.equal(meta.previsionImporte, 28450);
  assert.equal(meta.multiplicador, 2);
  assert.equal(pedidos.length, 2);
  assert.ok(pedidos.every((p) => p.estado === 'generado' && p.number == null));

  const hielo = db.obtener(tables.miaInformeLineas, { PK: 'INFORME#c1', SK: 'LINE#SIN_PROVEEDOR#502' });
  assert.equal(hielo.stockReal, null);
  const tonica = db.obtener(tables.miaInformeLineas, { PK: 'INFORME#c1', SK: 'LINE#42#501' });
  assert.equal(tonica.stockReal, 4);
  assert.equal((await listarPedidosProveedor('c1')).length, 2);
});

test('el pedido pasa a pedido solo con serie y número, y no vuelve atrás', async () => {
  preparar();
  await crearConteoStock({ informeId: 'c1', warehouseId: '1', lineas: LINEAS });
  await assert.rejects(
    marcarPedidoProveedor('c1', '42', { estado: 'pedido' }),
    /serie y número/,
  );
  const marcado = await marcarPedidoProveedor('c1', '42', { estado: 'pedido', serie: 'MIA', number: 7, importe: 120 });
  assert.equal(marcado.estado, 'pedido');
  assert.equal(marcado.number, 7);
  await assert.rejects(
    marcarPedidoProveedor('c1', '42', { estado: 'generado' }),
    /No se puede pasar/,
  );
  const confirmado = await marcarPedidoProveedor('c1', '42', { estado: 'confirmado', serie: 'MIA', number: 7 });
  assert.equal(confirmado.estado, 'confirmado');
});
