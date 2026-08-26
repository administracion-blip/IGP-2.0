import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clavesIdProducto,
  construirMapaNombresAgora,
  planRefrescoNombres,
} from '../lib/escandallos/refrescarNombresDesdeAgora.js';

describe('clavesIdProducto', () => {
  it('incluye id crudo y sin ceros', () => {
    assert.deepEqual(new Set(clavesIdProducto('01744')), new Set(['01744', '1744']));
    assert.deepEqual(clavesIdProducto('1744'), ['1744']);
  });
});

describe('construirMapaNombresAgora / planRefrescoNombres', () => {
  const productos = [
    { Id: 1744, Name: 'CROQUETAS RABO DE TORO NUEVO' },
    { Id: '0099', Name: 'Aceite nuevo' },
    { id: 12, Nombre: 'sin name field' },
  ];

  it('indexa por Id y Name de Ágora', () => {
    const mapa = construirMapaNombresAgora(productos);
    assert.equal(mapa.get('1744'), 'CROQUETAS RABO DE TORO NUEVO');
    assert.equal(mapa.get('0099'), 'Aceite nuevo');
    assert.equal(mapa.get('99'), 'Aceite nuevo');
    assert.equal(mapa.get('12'), 'sin name field');
  });

  it('propone cambio de plato e ingrediente si el snapshot diverge', () => {
    const mapa = construirMapaNombresAgora(productos);
    const plan = planRefrescoNombres(
      [
        {
          productoId: '1744',
          nombre: 'CROQUETAS RABO DE TORO',
          ingredientes: [
            { ingredienteId: '99', nombre: 'Aceite viejo' },
            { ingredienteId: '12', nombre: 'sin name field' },
          ],
        },
      ],
      mapa,
    );
    assert.equal(plan.length, 2);
    assert.ok(plan.some((c) => c.tipo === 'meta' && c.nombre === 'CROQUETAS RABO DE TORO NUEVO'));
    assert.ok(plan.some((c) => c.tipo === 'ing' && c.nombre === 'Aceite nuevo'));
  });

  it('no toca recetas cuyo nombre ya coincide, ni IDs que no están en Ágora', () => {
    const mapa = construirMapaNombresAgora(productos);
    const plan = planRefrescoNombres(
      [
        {
          productoId: '1744',
          nombre: 'CROQUETAS RABO DE TORO NUEVO',
          ingredientes: [{ ingredienteId: '9999', nombre: 'Fantasma' }],
        },
      ],
      mapa,
    );
    assert.deepEqual(plan, []);
  });
});
