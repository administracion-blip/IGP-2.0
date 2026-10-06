import test from 'node:test';
import { strict as assert } from 'node:assert';
import { nombreFormatoBase, pickAllowedFields } from '../lib/dynamo/agoraProducts.js';

test('el formato cuyo id coincide con la base gana sobre el resto', () => {
  const nombre = nombreFormatoBase({
    Name: 'Coca-Cola',
    BaseSaleFormatId: 15,
    AdditionalSaleFormats: [
      { Id: 15, Name: 'Botellín', Ratio: 1 },
      { Id: 88, Name: 'Caja 24', Ratio: 24 },
    ],
  });
  assert.equal(nombre, 'Botellín');
});

test('si el id base no está en la lista, usa el único formato de una unidad', () => {
  const nombre = nombreFormatoBase({
    Name: 'CASERA',
    BaseSaleFormatId: 563,
    AdditionalSaleFormats: [
      { Id: 7206, Name: 'BOT CASERA 1.5L', Ratio: 1 },
      { Id: 7207, Name: 'VASO CASERA 1.5L', Ratio: 0.22 },
    ],
  });
  assert.equal(nombre, 'BOT CASERA 1.5L');
});

test('varios formatos de una unidad no se adivinan', () => {
  const nombre = nombreFormatoBase({
    Name: 'MARTINI PROSECCO',
    BaseSaleFormatId: 878,
    AdditionalSaleFormats: [
      { Id: 1, Name: 'BOT. MARTINI PROSECO', Ratio: 1 },
      { Id: 2, Name: 'COPA MARTINI PROSECO', Ratio: 1 },
    ],
  });
  assert.equal(nombre, '');
});

test('si no hay un formato único se conserva un nombre ya guardado', () => {
  const nombre = nombreFormatoBase({
    Name: 'MARTINI PROSECCO',
    BaseSaleFormatId: 878,
    FormatoBaseNombre: 'Botella',
    AdditionalSaleFormats: [
      { Id: 1, Name: 'BOT. MARTINI PROSECO', Ratio: 1 },
      { Id: 2, Name: 'COPA MARTINI PROSECO', Ratio: 1 },
    ],
  });
  assert.equal(nombre, 'Botella');
});

test('sin formatos con nombre no hay etiqueta, tampoco el id', () => {
  assert.equal(nombreFormatoBase({ Name: 'COCA-COLA', BaseSaleFormatId: 87 }), '');
});

test('un nombre igual al del producto no se muestra', () => {
  assert.equal(
    nombreFormatoBase({
      Name: 'COCA-COLA',
      BaseSaleFormatId: 87,
      AdditionalSaleFormats: [{ Id: 1, Name: 'COCA-COLA', Ratio: 1 }],
    }),
    '',
  );
});

test('pickAllowedFields guarda el nombre y no el listado de formatos', () => {
  const picked = pickAllowedFields({
    Id: 1,
    Name: 'CASERA',
    BaseSaleFormatId: 563,
    CostPrice: 2,
    AdditionalSaleFormats: [
      { Id: 7206, Name: 'BOT CASERA 1.5L', Ratio: 1 },
      { Id: 7207, Name: 'VASO CASERA 1.5L', Ratio: 0.22 },
    ],
  });
  assert.equal(picked.FormatoBaseNombre, 'BOT CASERA 1.5L');
  assert.equal(picked.AdditionalSaleFormats, undefined);
});

test('un nombre ya guardado se conserva al leer el producto', () => {
  const picked = pickAllowedFields({
    Id: 1,
    Name: 'CASERA',
    BaseSaleFormatId: 563,
    FormatoBaseNombre: 'BOT CASERA 1.5L',
  });
  assert.equal(picked.FormatoBaseNombre, 'BOT CASERA 1.5L');
});
