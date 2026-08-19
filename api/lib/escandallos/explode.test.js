import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { explodeDemanda } from './explode.js';

function receta(productoId, ingredientes, { activo = true, nombre = productoId } = {}) {
  return {
    meta: { productoId, nombre, udReceta: 'ud', activo },
    ingredientes,
  };
}

function ing(ingredienteId, cantidad, unidad, mermaPct = 0, nombre = ingredienteId) {
  return { ingredienteId, nombre, cantidad, unidad, mermaPct };
}

describe('explodeDemanda', () => {
  it('3466 × 10 platos sin merma', async () => {
    const getReceta = (id) =>
      id === '3466'
        ? receta('3466', [
            ing('clara', 0.06, 'L'),
            ing('yema', 0.05, 'L'),
            ing('sal', 0.002, 'kg'),
            ing('patata', 0.4, 'kg'),
            ing('jamon', 0.085, 'kg', 0, 'Jamón'),
          ])
        : null;

    const out = await explodeDemanda({
      productoId: '3466',
      unidadesPlato: 10,
      getReceta,
    });

    assert.equal(out.get('clara').cantidad, 0.6);
    assert.equal(out.get('yema').cantidad, 0.5);
    assert.equal(out.get('sal').cantidad, 0.02);
    assert.equal(out.get('patata').cantidad, 4);
    assert.equal(out.get('jamon').cantidad, 0.85);
    assert.equal(out.get('clara').unidad, 'L');
    assert.equal(out.get('sal').unidad, 'kg');
    assert.equal(out.has('3466'), false);
  });

  it('merma 10% en patata: 10 * 0.4 * 1.1 = 4.4', async () => {
    const getReceta = (id) =>
      id === '3466' ? receta('3466', [ing('patata', 0.4, 'kg', 10)]) : null;

    const out = await explodeDemanda({
      productoId: '3466',
      unidadesPlato: 10,
      getReceta,
    });

    assert.equal(out.get('patata').cantidad, 4.4);
  });

  it('sub-escandallo: salsa no entra en compras; 10 platos → 0.5 kg tomate', async () => {
    const recetas = new Map([
      [
        'plato',
        receta('plato', [ing('salsa', 0.1, 'ud')], { nombre: 'Plato' }),
      ],
      [
        'salsa',
        receta('salsa', [ing('tomate', 0.5, 'kg')], { nombre: 'Salsa' }),
      ],
    ]);

    const out = await explodeDemanda({
      productoId: 'plato',
      unidadesPlato: 10,
      getReceta: recetas,
    });

    assert.equal(out.size, 1);
    assert.equal(out.has('salsa'), false);
    assert.equal(out.get('tomate').cantidad, 0.5);
    assert.equal(out.get('tomate').unidad, 'kg');
  });

  it('ciclo A→B→A lanza escandallo_ciclo', async () => {
    const recetas = new Map([
      ['A', receta('A', [ing('B', 1, 'ud')])],
      ['B', receta('B', [ing('A', 1, 'ud')])],
    ]);

    await assert.rejects(
      () => explodeDemanda({ productoId: 'A', unidadesPlato: 1, getReceta: recetas }),
      (err) => {
        assert.equal(err.code, 'escandallo_ciclo');
        return true;
      },
    );
  });
});
