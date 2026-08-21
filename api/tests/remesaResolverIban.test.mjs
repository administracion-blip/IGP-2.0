/**
 * Orden de preferencia del IBAN de una remesa (ordenante y beneficiario).
 *
 * El criterio es contraintuitivo y por eso se fija aquí: manda la cuenta
 * predeterminada actual del maestro de empresas, no la que quedó congelada en la
 * factura el día que se registró. El dato congelado sigue vivo como último
 * recurso, para que un hueco en el maestro no deje sin remesar una factura que
 * hoy se paga sin problemas.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  indexarEmpresas,
  resolverIbanBeneficiario,
  resolverIbanOrdenante,
} from '../lib/remesas/resolverDatos.js';

const IBAN_MAESTRO = 'ES9121000418450200051332';
const IBAN_CONGELADO = 'ES6621000418401234567891';
const IBAN_CONGELADO_ALT = 'PT50000201231234567890154';
const IBAN_MAESTRO_ALT = 'DE89370400440532013000';

/** Empresa del maestro con la cuenta predeterminada apuntada por el puntero. */
function empresa({ id = '000010', cif = 'B12345678', predeterminado, viejo, alternativo } = {}) {
  return {
    id_empresa: id,
    Cif: cif,
    Nombre: 'Proveedor S.L.',
    ...(predeterminado != null && { IbanPredeterminado: predeterminado }),
    ...(viejo != null && { Iban: viejo }),
    ...(alternativo != null && { IbanAlternativo: alternativo }),
  };
}

function factura(extra = {}) {
  return {
    empresa_id: '000010',
    empresa_cif: 'B12345678',
    empresa_iban: IBAN_CONGELADO,
    empresa_iban_alternativo: IBAN_CONGELADO_ALT,
    ...extra,
  };
}

test('beneficiario: la predeterminada del maestro manda sobre el IBAN congelado', () => {
  const idx = indexarEmpresas([empresa({ predeterminado: IBAN_MAESTRO, alternativo: IBAN_MAESTRO_ALT })]);
  const r = resolverIbanBeneficiario(factura(), idx);
  assert.equal(r.valido, true);
  assert.equal(r.iban, IBAN_MAESTRO);
});

test('beneficiario: sin cuenta en el maestro se cae al IBAN congelado de la factura', () => {
  const idx = indexarEmpresas([empresa({})]);
  const r = resolverIbanBeneficiario(factura(), idx);
  assert.equal(r.valido, true);
  assert.equal(r.iban, IBAN_CONGELADO);
});

test('beneficiario: proveedor que no está en el maestro se paga con lo congelado', () => {
  const r = resolverIbanBeneficiario(factura(), indexarEmpresas([]));
  assert.equal(r.valido, true);
  assert.equal(r.iban, IBAN_CONGELADO);
});

test('beneficiario: con el congelado inválido se usa el alternativo congelado', () => {
  const idx = indexarEmpresas([empresa({})]);
  const r = resolverIbanBeneficiario(factura({ empresa_iban: 'ES0000' }), idx);
  assert.equal(r.valido, true);
  assert.equal(r.iban, IBAN_CONGELADO_ALT);
});

test('beneficiario: el alternativo del maestro es el último recurso', () => {
  const idx = indexarEmpresas([empresa({ alternativo: IBAN_MAESTRO_ALT })]);
  const r = resolverIbanBeneficiario(
    factura({ empresa_iban: '', empresa_iban_alternativo: '' }),
    idx,
  );
  assert.equal(r.valido, true);
  assert.equal(r.iban, IBAN_MAESTRO_ALT);
});

test('beneficiario: sin empresa_id la empresa se busca por CIF', () => {
  const idx = indexarEmpresas([empresa({ predeterminado: IBAN_MAESTRO })]);
  const r = resolverIbanBeneficiario(factura({ empresa_id: '' }), idx);
  assert.equal(r.iban, IBAN_MAESTRO);
});

test('beneficiario: el puntero del maestro se limpia de guiones y del prefijo IBAN', () => {
  const idx = indexarEmpresas([empresa({ predeterminado: 'IBANES91-2100-0418-4502-0005-1332' })]);
  const r = resolverIbanBeneficiario(factura(), idx);
  assert.equal(r.valido, true);
  assert.equal(r.iban, IBAN_MAESTRO);
});

test('beneficiario: durante la escritura dual, el campo viejo Iban vale como maestro', () => {
  const idx = indexarEmpresas([empresa({ viejo: IBAN_MAESTRO })]);
  const r = resolverIbanBeneficiario(factura(), idx);
  assert.equal(r.iban, IBAN_MAESTRO);
});

test('beneficiario: sin ningún IBAN válido se excluye la factura con motivo', () => {
  const r = resolverIbanBeneficiario(
    factura({ empresa_iban: '', empresa_iban_alternativo: '' }),
    indexarEmpresas([]),
  );
  assert.equal(r.valido, false);
  assert.equal(r.iban, '');
  assert.ok(r.motivo);
});

test('beneficiario: con el CIF duplicado en el maestro solo cuenta la ficha del id', () => {
  // La pantalla resuelve por id y solo cae al CIF si no hay id. Si la remesa
  // mirase también la otra ficha, pagaría a una cuenta que el usuario no ha
  // visto en ninguna parte.
  const idx = indexarEmpresas([
    empresa({ id: '000010' }),
    empresa({ id: '000099', predeterminado: IBAN_MAESTRO }),
  ]);
  const r = resolverIbanBeneficiario(factura(), idx);
  assert.equal(r.iban, IBAN_CONGELADO);
});

test('beneficiario: el alternativo del maestro también se limpia de guiones', () => {
  const idx = indexarEmpresas([empresa({ alternativo: 'DE89-3704-0044-0532-0130-00' })]);
  const r = resolverIbanBeneficiario(
    factura({ empresa_iban: '', empresa_iban_alternativo: '' }),
    idx,
  );
  assert.equal(r.valido, true);
  assert.equal(r.iban, IBAN_MAESTRO_ALT);
});

test('beneficiario: un congelado antiguo con guiones sigue sirviendo para pagar', () => {
  const idx = indexarEmpresas([empresa({})]);
  const r = resolverIbanBeneficiario(
    factura({ empresa_iban: 'ES66-2100-0418-4012-3456-7891' }),
    idx,
  );
  assert.equal(r.valido, true);
  assert.equal(r.iban, IBAN_CONGELADO);
});

test('ordenante: la predeterminada de la sociedad manda sobre la congelada', () => {
  const sociedad = empresa({ id: '000001', cif: 'A11111111', predeterminado: IBAN_MAESTRO });
  const idx = indexarEmpresas([sociedad]);
  const r = resolverIbanOrdenante('000001', { emisor_iban: IBAN_CONGELADO }, idx);
  assert.equal(r.valido, true);
  assert.equal(r.iban, IBAN_MAESTRO);
});

test('ordenante: sociedad sin cuenta en el maestro tira de la congelada de la factura', () => {
  const idx = indexarEmpresas([empresa({ id: '000001', cif: 'A11111111' })]);
  const r = resolverIbanOrdenante('000001', { emisor_iban: IBAN_CONGELADO }, idx);
  assert.equal(r.valido, true);
  assert.equal(r.iban, IBAN_CONGELADO);
});

test('ordenante: sin sociedad ni IBAN congelado, no hay cuenta ordenante', () => {
  const r = resolverIbanOrdenante('', {}, indexarEmpresas([]));
  assert.equal(r.valido, false);
  assert.equal(r.motivo, 'Sin IBAN válido de la sociedad ordenante');
});
