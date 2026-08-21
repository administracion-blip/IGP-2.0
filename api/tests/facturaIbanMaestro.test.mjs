/**
 * IBAN que se congela al emitir una factura.
 *
 * La cuenta predeterminada del maestro es la fuente de verdad para emitir,
 * remesar y pagar, así que el IBAN que llegue en el cuerpo de la petición no
 * puede mandar: si lo hiciera, se podría emitir una factura contra una cuenta
 * que ya no se usa. Emisor y receptor se resuelven cada uno con su propio
 * `id_empresa` y el valor del cuerpo solo entra cuando esa empresa no tiene
 * ninguna cuenta.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const {
  buscarEmpresaPorIdEmpresa,
  ibanPredeterminadoPorIdEmpresa,
  ibansCongeladosDeFactura,
} = await import('../lib/facturacion/ibanCongelado.js');

const IBAN_EMISOR_MAESTRO = 'ES9121000418450200051332';
const IBAN_RECEPTOR_MAESTRO = 'ES6621000418401234567891';
const IBAN_DEL_CUERPO = 'PT50000201231234567890154';

/** Maestro de empresas con los `id_empresa` guardados con ceros a la izquierda. */
function maestro({ emisora = {}, receptora = {} } = {}) {
  const db = montarEscenario();
  db.sembrar(tables.empresas, { id_empresa: '000001', Nombre: 'Central', Cif: 'A11111111', ...emisora });
  db.sembrar(tables.empresas, { id_empresa: '000050', Nombre: 'Proveedor', Cif: 'B22222222', ...receptora });
  return db;
}

/** Cuerpo del alta de factura, con IBAN puestos a mano en la petición. */
function cuerpo(extra = {}) {
  return {
    emisor_id: '000001',
    emisor_iban: IBAN_DEL_CUERPO,
    empresa_id: '000050',
    empresa_iban: IBAN_DEL_CUERPO,
    ...extra,
  };
}

test('la cuenta predeterminada del maestro pisa el IBAN que venga en la petición', async () => {
  maestro({
    emisora: { IbanPredeterminado: IBAN_EMISOR_MAESTRO },
    receptora: { IbanPredeterminado: IBAN_RECEPTOR_MAESTRO },
  });
  const ibans = await ibansCongeladosDeFactura(cuerpo());
  assert.equal(ibans.emisor_iban, IBAN_EMISOR_MAESTRO);
  assert.equal(ibans.empresa_iban, IBAN_RECEPTOR_MAESTRO);
});

test('emisor y receptor no se cruzan: cada uno se resuelve con su id_empresa', async () => {
  maestro({
    emisora: { IbanPredeterminado: IBAN_EMISOR_MAESTRO },
    receptora: { IbanPredeterminado: IBAN_RECEPTOR_MAESTRO },
  });
  const ibans = await ibansCongeladosDeFactura(cuerpo());
  assert.notEqual(ibans.emisor_iban, ibans.empresa_iban);
});

test('una empresa sin cuenta en el maestro cae al IBAN del cuerpo', async () => {
  maestro({ emisora: { IbanPredeterminado: IBAN_EMISOR_MAESTRO } });
  const ibans = await ibansCongeladosDeFactura(cuerpo());
  assert.equal(ibans.emisor_iban, IBAN_EMISOR_MAESTRO);
  assert.equal(ibans.empresa_iban, IBAN_DEL_CUERPO);
});

test('sin cuenta en el maestro ni en el cuerpo, el IBAN queda vacío', async () => {
  maestro();
  const ibans = await ibansCongeladosDeFactura({ emisor_id: '000001', empresa_id: '000050' });
  assert.equal(ibans.emisor_iban, '');
  assert.equal(ibans.empresa_iban, '');
});

test('el id sin ceros a la izquierda encuentra igual la empresa del maestro', async () => {
  maestro({
    emisora: { IbanPredeterminado: IBAN_EMISOR_MAESTRO },
    receptora: { IbanPredeterminado: IBAN_RECEPTOR_MAESTRO },
  });
  const ibans = await ibansCongeladosDeFactura(cuerpo({ emisor_id: '1', empresa_id: '50' }));
  assert.equal(ibans.emisor_iban, IBAN_EMISOR_MAESTRO);
  assert.equal(ibans.empresa_iban, IBAN_RECEPTOR_MAESTRO);
});

test('una empresa que no está en el maestro se paga con lo que trae la petición', async () => {
  maestro();
  const ibans = await ibansCongeladosDeFactura(cuerpo({ emisor_id: '009999', empresa_id: '009998' }));
  assert.equal(ibans.emisor_iban, IBAN_DEL_CUERPO);
  assert.equal(ibans.empresa_iban, IBAN_DEL_CUERPO);
});

test('durante la escritura dual, el campo viejo Iban sigue valiendo como maestro', async () => {
  maestro({ emisora: { Iban: IBAN_EMISOR_MAESTRO } });
  const ibans = await ibansCongeladosDeFactura(cuerpo());
  assert.equal(ibans.emisor_iban, IBAN_EMISOR_MAESTRO);
});

test('el puntero del maestro se limpia de guiones y del prefijo IBAN', async () => {
  maestro({ emisora: { IbanPredeterminado: 'IBANES91-2100-0418-4502-0005-1332' } });
  const ibans = await ibansCongeladosDeFactura(cuerpo());
  assert.equal(ibans.emisor_iban, IBAN_EMISOR_MAESTRO);
});

test('sin id_empresa no se lee el maestro y manda lo que trae la petición', async () => {
  maestro({ emisora: { IbanPredeterminado: IBAN_EMISOR_MAESTRO } });
  const ibans = await ibansCongeladosDeFactura({ emisor_iban: IBAN_DEL_CUERPO, empresa_iban: '' });
  assert.equal(ibans.emisor_iban, IBAN_DEL_CUERPO);
  assert.equal(ibans.empresa_iban, '');
});

test('la caché no cruza empresas: cada id devuelve su cuenta', async () => {
  maestro({
    emisora: { IbanPredeterminado: IBAN_EMISOR_MAESTRO },
    receptora: { IbanPredeterminado: IBAN_RECEPTOR_MAESTRO },
  });
  const cache = new Map();
  assert.equal(await ibanPredeterminadoPorIdEmpresa('000001', cache), IBAN_EMISOR_MAESTRO);
  assert.equal(await ibanPredeterminadoPorIdEmpresa('000050', cache), IBAN_RECEPTOR_MAESTRO);
  assert.equal(await ibanPredeterminadoPorIdEmpresa('000001', cache), IBAN_EMISOR_MAESTRO);
});

test('buscarEmpresaPorIdEmpresa devuelve null sin id y con id inexistente', async () => {
  maestro();
  assert.equal(await buscarEmpresaPorIdEmpresa(''), null);
  assert.equal(await buscarEmpresaPorIdEmpresa('009999'), null);
});
