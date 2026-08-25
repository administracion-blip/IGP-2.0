/**
 * Nº de factura del proveedor en OCR: no confundir con CIF/NIF.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { pareceCifNifEspanol } from '../lib/empresaCif.js';
import {
  extraerNumerosFacturaCandidatos,
  parseTextoFacturaCompleto,
} from '../lib/ocrFacturaEntidades.js';
import { sanitizarNumeroFacturaProveedor } from '../lib/ocrFacturaValidacion.js';

test('pareceCifNifEspanol reconoce CIF/NIF típicos', () => {
  assert.equal(pareceCifNifEspanol('B12345674'), true);
  assert.equal(pareceCifNifEspanol('B-12345674'), true);
  assert.equal(pareceCifNifEspanol('12345678A'), true);
  assert.equal(pareceCifNifEspanol('F-2026/001'), false);
  assert.equal(pareceCifNifEspanol('AA976843'), false);
});

test('sanitizar rechaza CIF como nº de factura', () => {
  assert.equal(sanitizarNumeroFacturaProveedor('B12345674').limpio, '');
  assert.equal(sanitizarNumeroFacturaProveedor('12345678A').limpio, '');
  assert.equal(sanitizarNumeroFacturaProveedor('F-2026/001').limpio, 'F-2026/001');
  assert.equal(sanitizarNumeroFacturaProveedor('AA976843').limpio, 'AA976843');
});

test('extraer: FACTURA Nº gana sobre CIF aunque el CIF aparezca antes', () => {
  const texto = `
PROVEEDOR ACME SL
CIF: B12345674
Nº: B12345674
FACTURA Nº: F-2026/001
Base imponible 100,00
`;
  const nums = extraerNumerosFacturaCandidatos(texto, new Set(['B12345674']));
  assert.equal(nums[0], 'F-2026/001');
  assert.ok(!nums.some((n) => pareceCifNifEspanol(n)));
});

test('extraer: etiqueta CIF delante de Nº no cuenta como factura', () => {
  const texto = 'CIF Nº B87654321\nFecha 01/02/2026\nFactura: 2026/0042';
  const nums = extraerNumerosFacturaCandidatos(texto, new Set());
  assert.equal(nums[0], '2026/0042');
  assert.ok(!nums.includes('B87654321'));
});

test('parseTextoFacturaCompleto: numFacturas[0] no es el CIF del proveedor', () => {
  const texto = `
FACTURA
Emisor: DISTRIBUCIONES SUR SL
CIF B11223344
Cliente: Grupo Hostelería
Nº factura F-2026/001
Total: 121,00 €
`;
  const parsed = parseTextoFacturaCompleto(texto);
  assert.equal(parsed.numFacturas[0], 'F-2026/001');
  assert.ok(!parsed.numFacturas.some((n) => pareceCifNifEspanol(n)));
});

test('solo Nº genérico con forma CIF → lista vacía (no inventar)', () => {
  const texto = 'Nº: B99887766\nTotal 50,00';
  const nums = extraerNumerosFacturaCandidatos(texto, new Set(['B99887766']));
  assert.deepEqual(nums, []);
});
