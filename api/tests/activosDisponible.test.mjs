import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  acumularDisponiblePorModelo,
  acumularDisponiblePorTalla,
  tallasDesdeMapa,
  unidadesDisponiblesAlmacen,
} from '../lib/activos/stockDisponible.js';

test('disponible: unidad en almacén cuenta 1; entregada o con custodio no', () => {
  assert.equal(unidadesDisponiblesAlmacen({ estado: 'en_almacen', granularidad: 'unidad' }), 1);
  assert.equal(unidadesDisponiblesAlmacen({ estado: 'en_almacen', custodio_id: 'emp-1', granularidad: 'unidad' }), 0);
  assert.equal(unidadesDisponiblesAlmacen({ estado: 'asignado', granularidad: 'unidad' }), 0);
  assert.equal(unidadesDisponiblesAlmacen({ estado: 'en_almacen', granularidad: 'lote', cantidad: 8 }), 8);
  assert.equal(unidadesDisponiblesAlmacen({ estado: 'en_almacen', granularidad: 'lote', cantidad: 0 }), 0);
});

test('acumula por modelo: lotes suman tallas; entregado no entra', () => {
  const mapa = acumularDisponiblePorModelo([
    { modelo_id: 'm1', estado: 'en_almacen', granularidad: 'lote', cantidad: 3 },
    { modelo_id: 'm1', estado: 'en_almacen', granularidad: 'lote', cantidad: 2 },
    { modelo_id: 'm1', estado: 'asignado', custodio_id: 'x', granularidad: 'lote', cantidad: 10 },
    { modelo_id: 'm2', estado: 'en_almacen', granularidad: 'unidad' },
  ]);
  assert.equal(mapa.get('m1'), 5);
  assert.equal(mapa.get('m2'), 1);
});

test('acumula por talla: suma mismas tallas; sin talla no entra', () => {
  const mapa = acumularDisponiblePorTalla([
    { modelo_id: 'm1', estado: 'en_almacen', granularidad: 'lote', cantidad: 3, atributos: { talla: 'M' } },
    { modelo_id: 'm1', estado: 'en_almacen', granularidad: 'lote', cantidad: 2, atributos: { talla: 'M' } },
    { modelo_id: 'm1', estado: 'en_almacen', granularidad: 'lote', cantidad: 4, atributos: { talla: 'L' } },
    { modelo_id: 'm1', estado: 'asignado', granularidad: 'lote', cantidad: 9, atributos: { talla: 'S' } },
    { modelo_id: 'm2', estado: 'en_almacen', granularidad: 'unidad' },
  ]);
  const m1 = tallasDesdeMapa(mapa.get('m1'));
  assert.deepEqual(m1.sort((a, b) => a.talla.localeCompare(b.talla)), [
    { talla: 'L', cantidad: 4 },
    { talla: 'M', cantidad: 5 },
  ]);
  assert.equal(mapa.has('m2'), false);
});
