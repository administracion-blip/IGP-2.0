import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateIngrediente } from '../lib/escandallos/store.js';

const base = { ingredienteId: '99', cantidad: 1, unidad: 'KG' };

describe('validateIngrediente coste_manual', () => {
  it('incluye coste_manual solo si es número > 0', () => {
    const conOverride = validateIngrediente({ ...base, coste_manual: 1.25 }, '1744', 0);
    assert.equal(conOverride.coste_manual, 1.25);

    const vacios = [undefined, null, '', 0];
    for (const coste_manual of vacios) {
      const ing = validateIngrediente({ ...base, coste_manual }, '1744', 0);
      assert.equal(Object.hasOwn(ing, 'coste_manual'), false);
    }
  });

  it('rechaza coste_manual que no sea número >= 0', () => {
    for (const coste_manual of [-1, 'abc']) {
      assert.throws(
        () => validateIngrediente({ ...base, coste_manual }, '1744', 2),
        (err) => err.status === 400 && /ingredientes\[2\]: coste_manual/.test(err.message),
      );
    }
  });
});
