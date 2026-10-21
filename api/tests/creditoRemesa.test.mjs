/**
 * Crédito sin aplicar para una remesa: función pura, sin DynamoDB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { agruparCreditoSinAplicar } = await import('../lib/facturacion/creditoRemesa.js');

function factura(id, extra = {}) {
  return {
    id_factura: id,
    tipo: 'IN',
    estado: 'pendiente_pago',
    emisor_id: '000001',
    emisor_cif: 'A00000001',
    emisor_nombre: 'Sociedad A',
    empresa_id: '000010',
    empresa_cif: 'B11111111',
    empresa_nombre: 'Proveedor Uno',
    numero_factura: `N-${id}`,
    numero_factura_proveedor: `P-${id}`,
    fecha_emision: '2026-03-01',
    total_factura: 100,
    total_cobrado: 0,
    saldo_pendiente: 100,
    ...extra,
  };
}

const VACIO = { grupos: [], total: 0 };

test('exceso de otra factura del mismo par sí', () => {
  const ancla = factura('SEL');
  const exceso = factura('EXC', {
    estado: 'pagada',
    total_factura: 100,
    total_cobrado: 130,
    saldo_pendiente: 0,
    exceso_pendiente: 0,
    fecha_emision: '2026-01-15',
    numero_factura_proveedor: 'F-EXC',
  });
  const aplicado = factura('CERO', {
    estado: 'pagada',
    total_cobrado: 100,
    saldo_pendiente: 0,
    exceso_pendiente: 25,
  });
  const r = agruparCreditoSinAplicar([ancla], [exceso, exceso, aplicado, ancla]);
  assert.equal(r.grupos.length, 1);
  assert.equal(r.grupos[0].proveedorNombre, 'Proveedor Uno');
  assert.equal(r.grupos[0].sociedadNombre, 'Sociedad A');
  assert.deepEqual(r.grupos[0].lineas, [
    { id_factura: 'EXC', numero: 'F-EXC', motivo: 'exceso', importe: 30 },
  ]);
  assert.equal(r.grupos[0].total, 30);
  assert.equal(r.total, 30);
});

test('otro proveedor no', () => {
  const ancla = factura('SEL');
  const otro = factura('OTRO', {
    empresa_cif: 'B99999999',
    empresa_id: '000099',
    empresa_nombre: 'Otro proveedor',
    estado: 'pagada',
    total_cobrado: 150,
    saldo_pendiente: 0,
  });
  const otraSociedad = factura('SOC', {
    emisor_cif: 'A99999999',
    emisor_id: '000008',
    emisor_nombre: 'Otra sociedad',
    estado: 'pagada',
    total_cobrado: 180,
    saldo_pendiente: 0,
  });
  assert.deepEqual(agruparCreditoSinAplicar([ancla], [otro, otraSociedad]), VACIO);
});

test('abono con saldo negativo sí', () => {
  const ancla = factura('SEL');
  const abono = factura('AB', {
    es_abono: true,
    total_factura: -50,
    total_cobrado: 0,
    saldo_pendiente: -50,
    numero_factura_proveedor: '',
    numero_factura: 'AB-1',
    fecha_emision: '2026-02-01',
  });
  const r = agruparCreditoSinAplicar([ancla], [abono]);
  assert.deepEqual(r.grupos[0].lineas, [
    { id_factura: 'AB', numero: 'AB-1', motivo: 'abono', importe: 50 },
  ]);
  assert.equal(r.total, 50);
});

test('abono ya a saldo 0 no', () => {
  const ancla = factura('SEL');
  const abono = factura('AB', {
    es_abono: true,
    total_factura: -50,
    total_cobrado: 0,
    saldo_pendiente: 0,
    estado: 'pagada',
  });
  assert.deepEqual(agruparCreditoSinAplicar([ancla], [abono]), VACIO);
});

test('anulada no', () => {
  const ancla = factura('SEL');
  const anulada = factura('AN', {
    estado: 'anulada',
    total_factura: 100,
    total_cobrado: 140,
    saldo_pendiente: 0,
  });
  const abonoAnulado = factura('ABN', {
    estado: 'anulada',
    es_abono: true,
    total_factura: -40,
    saldo_pendiente: -40,
  });
  const anclaAnulada = factura('SEL-AN', { estado: 'anulada' });
  const exceso = factura('EXC', { estado: 'pagada', total_cobrado: 120, saldo_pendiente: 0 });
  assert.deepEqual(agruparCreditoSinAplicar([ancla], [anulada, abonoAnulado]), VACIO);
  assert.deepEqual(agruparCreditoSinAplicar([anclaAnulada], [exceso]), VACIO);
});

test('prioridad abono si saldo negativo y total negativo', () => {
  const ancla = factura('SEL');
  const abono = factura('AB', {
    total_factura: -100,
    total_cobrado: 0,
    saldo_pendiente: -40,
    fecha_emision: '2026-04-01',
  });
  const r = agruparCreditoSinAplicar([ancla], [abono]);
  assert.equal(r.grupos[0].lineas.length, 1);
  assert.equal(r.grupos[0].lineas[0].motivo, 'abono');
  assert.equal(r.grupos[0].lineas[0].importe, 40);

  const marca = factura('MARCA', {
    es_abono: true,
    total_factura: 100,
    total_cobrado: 130,
    saldo_pendiente: -20,
    estado: 'pagada',
  });
  const rMarca = agruparCreditoSinAplicar([ancla], [marca]);
  assert.equal(rMarca.grupos[0].lineas[0].motivo, 'abono');
  assert.equal(rMarca.grupos[0].lineas[0].importe, 20);
});

test('importe absoluto', () => {
  const ancla = factura('SEL');
  const abono = factura('AB', {
    total_factura: -12.34,
    total_cobrado: 0,
    saldo_pendiente: -12.34,
  });
  const r = agruparCreditoSinAplicar([ancla], [abono]);
  assert.equal(r.grupos[0].lineas[0].importe, 12.34);
  assert.ok(r.grupos[0].lineas[0].importe > 0);
  assert.equal(r.grupos[0].total, 12.34);
  assert.equal(r.total, 12.34);
});

test('no devuelve crédito de una sociedad no permitida', () => {
  const empresasOk = new Set(['000001']);
  const ancla = factura('SEL');
  const ajena = factura('AJ', {
    emisor_id: '000002',
    estado: 'pagada',
    total_cobrado: 180,
    saldo_pendiente: 0,
  });
  assert.deepEqual(agruparCreditoSinAplicar([ancla], [ajena], empresasOk), VACIO);
  assert.deepEqual(
    agruparCreditoSinAplicar([factura('FORB', { emisor_id: '000009' })], [ajena], empresasOk),
    VACIO,
  );
});

test('borrador no; grupos por proveedor y líneas por fecha', () => {
  const anclaAlfa = factura('A', {
    empresa_nombre: 'Alfa',
    empresa_cif: 'B22222222',
    empresa_id: '000020',
  });
  const anclaBeta = factura('B', {
    empresa_nombre: 'Beta',
    empresa_cif: 'B33333333',
    empresa_id: '000030',
    emisor_nombre: 'Sociedad B',
    emisor_cif: 'A00000002',
    emisor_id: '000002',
  });
  const borrador = factura('BOR', {
    estado: 'borrador',
    total_cobrado: 150,
    saldo_pendiente: 0,
    empresa_nombre: 'Alfa',
    empresa_cif: 'B22222222',
    empresa_id: '000020',
  });
  const excesoTarde = factura('A2', {
    empresa_nombre: 'Alfa',
    empresa_cif: 'B22222222',
    empresa_id: '000020',
    estado: 'pagada',
    total_cobrado: 110,
    saldo_pendiente: 0,
    fecha_emision: '2026-05-01',
    numero_factura_proveedor: 'Tarde',
  });
  const abonoPronto = factura('A1', {
    empresa_nombre: 'Alfa',
    empresa_cif: 'B22222222',
    empresa_id: '000020',
    es_abono: true,
    total_factura: -8,
    total_cobrado: 0,
    saldo_pendiente: -8,
    fecha_emision: '2026-01-02',
    numero_factura_proveedor: 'Pronto',
  });
  const excesoBeta = factura('B1', {
    empresa_nombre: 'Beta',
    empresa_cif: 'B33333333',
    empresa_id: '000030',
    emisor_nombre: 'Sociedad B',
    emisor_cif: 'A00000002',
    emisor_id: '000002',
    estado: 'pagada',
    total_cobrado: 140,
    saldo_pendiente: 0,
    fecha_emision: '2026-06-01',
    numero_factura_proveedor: 'BETA-1',
  });

  const r = agruparCreditoSinAplicar(
    [anclaBeta, anclaAlfa],
    [borrador, excesoTarde, excesoBeta, abonoPronto],
  );
  assert.deepEqual(r.grupos.map((g) => g.proveedorNombre), ['Alfa', 'Beta']);
  assert.equal(r.grupos[0].sociedadNombre, 'Sociedad A');
  assert.deepEqual(r.grupos[0].lineas.map((l) => l.id_factura), ['A1', 'A2']);
  assert.deepEqual(r.grupos[0].lineas.map((l) => l.motivo), ['abono', 'exceso']);
  assert.equal(r.grupos[0].total, 18);
  assert.equal(r.grupos[1].total, 40);
  assert.equal(r.grupos[1].sociedadNombre, 'Sociedad B');
  assert.equal(r.total, 58);
});
