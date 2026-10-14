/**
 * Cálculo de la deuda con proveedores sin DynamoDB: claves, tolerancia,
 * tramos de antigüedad, abonos y fechas.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const {
  claveProveedor,
  estadoDeuda,
  tramoAntiguedad,
  diaAnterior,
  hoyMadridIso,
  superaRangoMaximo,
  facturaDeuda,
  agregarDeudaProveedores,
} = await import('../lib/facturacion/deudaProveedores.js');

const HOY = '2026-06-15';

function inFactura(id, extra = {}) {
  return {
    id_factura: id,
    tipo: 'IN',
    estado: 'pendiente_pago',
    emisor_id: '000001',
    emisor_cif: 'A00000001',
    emisor_nombre: 'Sociedad A',
    empresa_cif: 'B11111111',
    empresa_nombre: 'Proveedor Uno',
    fecha_emision: '2026-03-01',
    total_factura: 100,
    total_cobrado: 0,
    saldo_pendiente: 100,
    ...extra,
  };
}

test('claveProveedor normaliza el CIF y cae a id y a nombre', () => {
  assert.equal(claveProveedor({ empresa_cif: ' b-1111.1111 ', empresa_id: '7' }), 'CIF:B11111111');
  assert.equal(claveProveedor({ empresa_cif: '', empresa_id: ' 000007 ', empresa_nombre: 'X' }), 'ID:000007');
  assert.equal(claveProveedor({ empresa_nombre: '  Bar Pepe  ' }), 'NOM:bar pepe');
  assert.equal(claveProveedor({}), 'NOM:');
});

test('estadoDeuda: la tolerancia de 10 € es inclusiva en ambos sentidos', () => {
  assert.equal(estadoDeuda({ diferencia: 10, anteriorPendiente: 0, vencido: 0 }), 'cuadrado');
  assert.equal(estadoDeuda({ diferencia: -10, anteriorPendiente: 0, vencido: 0 }), 'cuadrado');
  assert.equal(estadoDeuda({ diferencia: 10.01, anteriorPendiente: 0, vencido: 0 }), 'pendiente');
  assert.equal(estadoDeuda({ diferencia: -10.01, anteriorPendiente: 0, vencido: 0 }), 'pendiente');
  assert.equal(estadoDeuda({ diferencia: 50, anteriorPendiente: 0, vencido: 20 }), 'vencido');
  assert.equal(estadoDeuda({ diferencia: 0, anteriorPendiente: 5000, vencido: 0 }), 'pendiente');
});

test('saldoAFavor solo con diferencia por debajo de -10 y fuera de tolerancia', () => {
  const agg = (pagado) => agregarDeudaProveedores({
    periodo: [inFactura('F1', { total_cobrado: pagado, saldo_pendiente: 100 - pagado })],
    hoy: HOY,
  }).proveedores[0];
  assert.equal(agg(110).estado, 'cuadrado');
  assert.equal(agg(110).saldoAFavor, false);
  const sobrepago = agg(110.01);
  assert.equal(sobrepago.estado, 'pendiente');
  assert.equal(sobrepago.saldoAFavor, true);
  assert.equal(agg(89.99).saldoAFavor, false);
});

test('una deuda anterior grande impide el cuadrado aunque el periodo cuadre', () => {
  const p = agregarDeudaProveedores({
    periodo: [inFactura('F1', { total_cobrado: 100, saldo_pendiente: 0, estado: 'pagada' })],
    anteriores: [inFactura('F0', { fecha_emision: '2025-01-01', saldo_pendiente: 800, total_factura: 800 })],
    hoy: HOY,
  }).proveedores[0];
  assert.equal(p.diferencia, 0);
  assert.deepEqual(p.anterior, { pendiente: 800, vencido: 0, numFacturas: 1 });
  assert.equal(p.estado, 'pendiente');
});

test('tramos de antigüedad en los límites', () => {
  const venc = (dias) => {
    const d = new Date(Date.UTC(2026, 5, 15 - dias));
    return { fecha_vencimiento: d.toISOString().slice(0, 10) };
  };
  assert.equal(tramoAntiguedad(venc(0), HOY), 'no_vencido');
  assert.equal(tramoAntiguedad(venc(-5), HOY), 'no_vencido');
  assert.equal(tramoAntiguedad(venc(1), HOY), 'd0_30');
  assert.equal(tramoAntiguedad(venc(30), HOY), 'd0_30');
  assert.equal(tramoAntiguedad(venc(31), HOY), 'd31_60');
  assert.equal(tramoAntiguedad(venc(60), HOY), 'd31_60');
  assert.equal(tramoAntiguedad(venc(61), HOY), 'd61_90');
  assert.equal(tramoAntiguedad(venc(90), HOY), 'd61_90');
  assert.equal(tramoAntiguedad(venc(91), HOY), 'd90mas');
  assert.equal(tramoAntiguedad({}, HOY), 'no_vencido');
  assert.equal(tramoAntiguedad({ fecha_vencimiento: '14/06/2026' }, HOY), 'd0_30');
});

test('sin vencimiento cuenta como no vencido y suma numSinVencimiento', () => {
  const r = agregarDeudaProveedores({
    periodo: [inFactura('F1'), inFactura('F2', { fecha_vencimiento: '2026-01-01', saldo_pendiente: 40 })],
    hoy: HOY,
  });
  assert.equal(r.antiguedad.noVencido, 100);
  assert.equal(r.antiguedad.d90mas, 40);
  assert.equal(r.antiguedad.numSinVencimiento, 1);
  assert.equal(r.kpis.vencido, 40);
  assert.equal(r.proveedores[0].vencimientoMasAntiguo, '2026-01-01');
});

test('un abono resta del pendiente y no entra en la antigüedad', () => {
  const r = agregarDeudaProveedores({
    periodo: [
      inFactura('F1'),
      inFactura('AB1', { total_factura: -30, saldo_pendiente: -30, fecha_vencimiento: '2026-01-01' }),
    ],
    hoy: HOY,
  });
  const p = r.proveedores[0];
  assert.equal(p.facturado, 70);
  assert.equal(p.pendiente, 70);
  assert.equal(p.numPendientes, 1);
  assert.equal(p.vencido, 0);
  assert.equal(r.antiguedad.noVencido, 100);
  assert.equal(r.antiguedad.d90mas, 0);
  assert.equal(facturaDeuda(inFactura('AB1', { total_factura: -30, saldo_pendiente: -30 }), { hoy: HOY }).es_abono, true);
});

test('diaAnterior cruza año y respeta bisiestos', () => {
  assert.equal(diaAnterior('2026-01-01'), '2025-12-31');
  assert.equal(diaAnterior('2024-03-01'), '2024-02-29');
  assert.equal(diaAnterior('2026-03-01'), '2026-02-28');
});

test('hoyMadridIso usa la hora de Madrid', () => {
  assert.equal(hoyMadridIso(new Date('2026-06-14T22:30:00Z')), '2026-06-15');
  assert.equal(hoyMadridIso(new Date('2026-01-01T22:59:00Z')), '2026-01-01');
});

test('superaRangoMaximo: tres años exactos valen, un día más no', () => {
  assert.equal(superaRangoMaximo('2023-01-01', '2026-01-01'), false);
  assert.equal(superaRangoMaximo('2023-01-01', '2026-01-02'), true);
});

test('facturaDeuda normaliza fecha dd/mm/aaaa y calcula vencida', () => {
  const f = facturaDeuda(inFactura('F1', { fecha_emision: '05/02/2026', fecha_vencimiento: '2026-06-05' }), {
    hoy: HOY, desde: '2026-03-01',
  });
  assert.equal(f.fecha_emision, '2026-02-05');
  assert.equal(f.vencida, true);
  assert.equal(f.diasVencida, 10);
  assert.equal(f.tramo, 'd0_30');
  assert.equal(f.anteriorAlPeriodo, true);
  assert.equal(f.remesaActiva, null);
});
