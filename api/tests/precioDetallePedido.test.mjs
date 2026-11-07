/**
 * Detalles de pedidos no vuelve a aplicar el beneficio sobre un total que ya lo incluye.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { importesDetallePedido } from '../../app/lib/precioDetallePedido.js';

test('una línea con precio de venta guardado no aplica el beneficio otra vez', () => {
  const linea = {
    PrecioUnitario: 10,
    PrecioVenta: 11,
    Cantidad: 2,
    TotalLinea: 22,
  };
  const visto = importesDetallePedido(linea, 10);
  assert.equal(visto.precio, 11);
  assert.equal(visto.total, 22);
  const conOtroPorcentaje = importesDetallePedido(linea, 20);
  assert.equal(conOtroPorcentaje.precio, 11);
  assert.equal(conOtroPorcentaje.total, 22);
});

test('una línea antigua sin PrecioVenta aplica el porcentaje vigente una sola vez', () => {
  const linea = { PrecioUnitario: 10, Cantidad: 2, TotalLinea: 20 };
  const visto = importesDetallePedido(linea, 10);
  assert.equal(visto.precio, 11);
  assert.equal(visto.total, 22);
});
