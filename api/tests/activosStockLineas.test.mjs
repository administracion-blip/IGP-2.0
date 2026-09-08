import test from 'node:test';
import { strict as assert } from 'node:assert';
import { lineasDisponibles } from '../lib/activos/stockDisponible.js';

const enAlmacen = {
  asset_id: 'a1',
  etiqueta_legible: 'CAMI-00042',
  id_local: '000123',
  local_nombre: 'DISTRIBUIDORA',
  granularidad: 'lote',
  cantidad: 12,
  atributos: { talla: 'XL' },
  estado: 'en_almacen',
  numero_serie: null,
};

test('líneas de stock: solo lo libre en almacén, con talla y unidades', () => {
  const lineas = lineasDisponibles([
    enAlmacen,
    { ...enAlmacen, asset_id: 'a2', estado: 'asignado', custodio_id: 'e1' },
    { ...enAlmacen, asset_id: 'a3', custodio_id: 'e1' },
    { ...enAlmacen, asset_id: 'a4', cantidad: 0 },
    { ...enAlmacen, asset_id: 'a5', estado: 'baja' },
  ]);
  assert.equal(lineas.length, 1);
  assert.deepEqual(lineas[0], {
    asset_id: 'a1',
    etiqueta_legible: 'CAMI-00042',
    id_local: '000123',
    local_nombre: 'DISTRIBUIDORA',
    granularidad: 'lote',
    talla: 'XL',
    numero_serie: null,
    disponibles: 12,
  });
});

test('líneas de stock: unidad serializada cuenta 1 y talla queda a null', () => {
  const [linea] = lineasDisponibles([
    {
      asset_id: 'u1',
      etiqueta_legible: 'PDA-0001',
      id_local: '000123',
      local_nombre: 'BAR X',
      granularidad: 'unidad',
      numero_serie: 'SN-9',
      estado: 'en_almacen',
      atributos: {},
    },
  ]);
  assert.equal(linea.disponibles, 1);
  assert.equal(linea.talla, null);
  assert.equal(linea.numero_serie, 'SN-9');
});

test('líneas de stock: ordena por local y luego por talla', () => {
  const lineas = lineasDisponibles([
    { ...enAlmacen, asset_id: 'b', local_nombre: 'BAR X', atributos: { talla: 'M' } },
    { ...enAlmacen, asset_id: 'c', local_nombre: 'BAR X', atributos: { talla: 'L' } },
    { ...enAlmacen, asset_id: 'a', local_nombre: 'ALMACÉN', atributos: { talla: 'S' } },
  ]);
  assert.deepEqual(lineas.map((l) => l.asset_id), ['a', 'c', 'b']);
});

test('líneas de stock: total es la suma de unidades disponibles', () => {
  const lineas = lineasDisponibles([
    enAlmacen,
    { ...enAlmacen, asset_id: 'a2', cantidad: 2 },
  ]);
  assert.equal(lineas.reduce((n, l) => n + l.disponibles, 0), 14);
});
