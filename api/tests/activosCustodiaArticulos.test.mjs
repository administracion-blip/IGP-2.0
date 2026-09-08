import test from 'node:test';
import { strict as assert } from 'node:assert';
import { agruparCustodiaPorArticulo } from '../lib/activos/custodiaArticulos.js';
import { localImputadoDe, mismoLocalImputado } from '../lib/activos/localImputado.js';

const asignado = {
  asset_id: 'a1',
  modelo_id: 'm1',
  marca: 'Cañizares',
  nombre_modelo: 'Dido 2026',
  categoria_id: 'cat-1',
  granularidad: 'lote',
  cantidad: 2,
  atributos: { talla: 'XL' },
  estado: 'asignado',
  custodio_id: '123',
  custodio_nombre: 'JAVIER JIMENEZ',
  id_local: '000123',
  local_nombre: 'DISTRIBUIDORA',
  local_imputado_id: '000124',
  local_imputado_nombre: 'BAR X',
};

test('agrupa por artículo: suma unidades y lista custodios con local imputado', () => {
  const [articulo] = agruparCustodiaPorArticulo([
    asignado,
    { ...asignado, asset_id: 'a2', cantidad: 5, custodio_id: '456', custodio_nombre: 'ANA LOPEZ' },
  ]);
  assert.equal(articulo.modelo_id, 'm1');
  assert.equal(articulo.cantidad, 7);
  assert.equal(articulo.foto_url, undefined, 'la foto la resuelve el servicio');
  assert.deepEqual(articulo.custodios.map((c) => c.employee_nombre), ['ANA LOPEZ', 'JAVIER JIMENEZ']);
  assert.deepEqual(articulo.custodios[1], {
    employee_id: '123',
    employee_nombre: 'JAVIER JIMENEZ',
    cantidad: 2,
    talla: 'XL',
    id_local: '000123',
    local_nombre: 'DISTRIBUIDORA',
    local_imputado_id: '000124',
    local_imputado_nombre: 'BAR X',
  });
});

test('agrupa por artículo: mismo trabajador con dos tallas son dos líneas', () => {
  const [articulo] = agruparCustodiaPorArticulo([
    asignado,
    { ...asignado, asset_id: 'a2', cantidad: 1, atributos: { talla: 'M' } },
  ]);
  assert.equal(articulo.cantidad, 3);
  assert.deepEqual(articulo.custodios.map((c) => c.talla), ['M', 'XL']);
});

test('agrupa por artículo: el mismo trabajador con distinto local imputado no se junta', () => {
  const [articulo] = agruparCustodiaPorArticulo([
    asignado,
    { ...asignado, asset_id: 'a2', cantidad: 3, local_imputado_id: '000999', local_imputado_nombre: 'BAR Z' },
  ]);
  assert.equal(articulo.custodios.length, 2);
  assert.deepEqual(
    articulo.custodios.map((c) => [c.local_imputado_id, c.cantidad]),
    [['000124', 2], ['000999', 3]],
  );
});

test('agrupa por artículo: ignora lo que no está en custodia y ordena por marca y modelo', () => {
  const articulos = agruparCustodiaPorArticulo([
    { ...asignado, asset_id: 'z1', modelo_id: 'm2', marca: 'Adidas', nombre_modelo: 'Polo' },
    asignado,
    { ...asignado, asset_id: 'x1', modelo_id: 'm3', custodio_id: '', cantidad: 4 },
    { ...asignado, asset_id: 'x2', modelo_id: 'm4', cantidad: 0 },
  ]);
  assert.deepEqual(articulos.map((a) => a.modelo_id), ['m2', 'm1']);
});

test('local imputado: sin campo se imputa al local del activo', () => {
  const legado = { id_local: '000123', local_nombre: 'DISTRIBUIDORA' };
  assert.equal(localImputadoDe(legado), '000123');
  assert.equal(localImputadoDe(asignado), '000124');
  const [articulo] = agruparCustodiaPorArticulo([{ ...asignado, local_imputado_id: null, local_imputado_nombre: null }]);
  assert.equal(articulo.custodios[0].local_imputado_id, '000123');
  assert.equal(articulo.custodios[0].local_imputado_nombre, 'DISTRIBUIDORA');
});

test('fusión de lotes: solo si coincide el local imputado', () => {
  assert.equal(mismoLocalImputado(asignado, '000124'), true);
  assert.equal(mismoLocalImputado(asignado, '000123'), false);
  // Fila antigua sin local imputado: se fusiona con una entrega al propio local.
  const legado = { id_local: '000123' };
  assert.equal(mismoLocalImputado(legado, '000123'), true);
  assert.equal(mismoLocalImputado(legado, '000124'), false);
});
