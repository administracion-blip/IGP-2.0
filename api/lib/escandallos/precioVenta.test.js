import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickMainPrice } from './precioVenta.js';

describe('pickMainPrice', () => {
  const prices = [
    { PriceListId: 1, MainPrice: 10.5 },
    { PriceListId: 7, MainPrice: 12 },
  ];

  it('match por PriceListId string/number', () => {
    assert.equal(pickMainPrice(prices, 7), 12);
    assert.equal(pickMainPrice(prices, '7'), 12);
    assert.equal(pickMainPrice(prices, '1'), 10.5);
  });

  it('sin match → null (no inventa tarifa)', () => {
    assert.equal(pickMainPrice(prices, 99), null);
    assert.equal(pickMainPrice(prices, '99'), null);
  });

  it('priceListId null y una sola tarifa con MainPrice>0', () => {
    assert.equal(pickMainPrice([{ PriceListId: 3, MainPrice: 8 }], null), 8);
  });

  it('priceListId null y varias tarifas → null', () => {
    assert.equal(pickMainPrice(prices, null), null);
  });

  it('MainPrice <= 0 en única tarifa sin priceListId → null', () => {
    assert.equal(pickMainPrice([{ PriceListId: 1, MainPrice: 0 }], null), null);
  });
});
