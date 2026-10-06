import test from 'node:test';
import { strict as assert } from 'node:assert';
import { letraZona, pickAllowedFields, hashProduct, conservarDatosLocales } from '../lib/dynamo/agoraProducts.js';

test('solo acepta una letra de la A a la Z', () => {
  assert.equal(letraZona('b'), 'B');
  assert.equal(letraZona(' Z '), 'Z');
  assert.equal(letraZona(''), '');
  assert.equal(letraZona('AB'), '');
  assert.equal(letraZona('1'), '');
});

test('guarda la zona normalizada y no la inventa si no viene', () => {
  assert.equal(pickAllowedFields({ Id: 1, Name: 'Cola', Zona: 'c' }).Zona, 'C');
  assert.equal(pickAllowedFields({ Id: 1, Name: 'Cola' }).Zona, undefined);
  assert.equal(pickAllowedFields({ Id: 1, Name: 'Cola', Zona: 'pasillo' }).Zona, undefined);
});

test('la zona no entra en el hash de Ágora', () => {
  const base = { Id: 1, Name: 'Cola', CostPrice: 1 };
  assert.equal(hashProduct(base), hashProduct({ ...base, Zona: 'B' }));
});

test('al reescribir por un cambio de Ágora se conserva la zona y el IGP', () => {
  const item = { Id: 1, Name: 'Cola nueva', CostPrice: 2 };
  conservarDatosLocales(item, { IGP: true, Zona: 'b', ultimo_iva_compra: 21 });
  assert.equal(item.Zona, 'B');
  assert.equal(item.IGP, true);
  assert.equal(item.ultimo_iva_compra, 21);
});

test('si el producto no tenía zona, la sincronización no se la pone', () => {
  const item = { Id: 1, Name: 'Cola', Zona: 'A' };
  conservarDatosLocales(item, { IGP: false });
  assert.equal(item.Zona, undefined);
  assert.equal(item.IGP, false);
});
