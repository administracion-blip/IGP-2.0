import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATRIBUTOS_GSI_FACTURA,
  aplicarClavesFactura,
  aplicarClavesPago,
  aplicarClavesRemesa,
  clavesIndiceFactura,
  clavesIndicePago,
  clavesIndiceRemesa,
  conClavesFactura,
  conClavesRemesa,
} from '../lib/facturacion/clavesIndice.js';
import { updateFacturaVersionado } from '../lib/facturacion/versionFactura.js';

const FACTURA_LLENA = {
  tipo: ' in ',
  estado: ' pendiente_pago ',
  fecha_emision: '2026-03-15',
  creado_en: '2026-01-01T00:00:00.000Z',
  empresa_cif: ' b-12.345.678 ',
  emisor_id: '7',
  emisor_cif: 'A11111111',
  serie: ' FR ',
  rappel_periodo: '2026-03',
  mantenimiento_periodo: '2026-02',
  ventas_internas_periodo: '2026-01',
};

test('factura completa: tipo, estado, fecha, CIF, emisor, serie y rappel', () => {
  const { poner, quitar } = clavesIndiceFactura(FACTURA_LLENA);
  assert.equal(poner.gsi_tipo, 'IN');
  assert.equal(poner.gsi_estado, 'pendiente_pago');
  assert.equal(poner.gsi_fecha, '2026-03-15');
  assert.equal(poner.gsi_proveedor, 'B12345678');
  assert.equal(poner.gsi_emisor, '000007');
  assert.equal(poner.gsi_serie, 'FR');
  assert.equal(poner.gsi_periodo, 'rappel#2026-03');
  assert.deepEqual(quitar, []);
});

test('sin fecha_emision usa creado_en; sin ninguna fecha válida no hay gsi_fecha y el resto sí', () => {
  const conCreado = clavesIndiceFactura({
    tipo: 'OUT',
    estado: 'borrador',
    fecha_emision: '31/12/2026',
    creado_en: '2026-08-11T22:00:00.000Z',
  });
  assert.equal(conCreado.poner.gsi_fecha, '2026-08-11');
  assert.equal(conCreado.poner.gsi_tipo, 'OUT');

  const sinFecha = clavesIndiceFactura({
    tipo: 'IN',
    estado: 'borrador',
    fecha_emision: '',
    creado_en: 'ayer',
    serie: '   ',
  });
  assert.equal(sinFecha.poner.gsi_fecha, undefined);
  assert.equal(sinFecha.poner.gsi_tipo, 'IN');
  assert.equal(sinFecha.poner.gsi_estado, 'borrador');
  assert.ok(sinFecha.quitar.includes('gsi_fecha'));
  assert.ok(sinFecha.quitar.includes('gsi_serie'));
  for (const valor of Object.values(sinFecha.poner)) assert.notEqual(valor, '');
});

test('fechas imposibles y cadenas vacías no se escriben', () => {
  const { poner, quitar } = clavesIndiceFactura({
    tipo: '',
    estado: '   ',
    fecha_emision: '2026-02-30',
    creado_en: '2026-13-01T00:00:00.000Z',
    empresa_cif: '---',
    emisor_id: '',
    emisor_cif: '  ',
    serie: '',
  });
  assert.deepEqual(poner, {});
  assert.deepEqual([...quitar].sort(), [...ATRIBUTOS_GSI_FACTURA].sort());
});

test('emisor: el id gana al CIF; sin id se usa CIF#; sin ninguno se omite', () => {
  assert.equal(clavesIndiceFactura({ emisor_id: '12', emisor_cif: 'B99999999' }).poner.gsi_emisor, '000012');
  assert.equal(clavesIndiceFactura({ emisor_id: '', emisor_cif: ' b 99999999 ' }).poner.gsi_emisor, 'CIF#B99999999');
  assert.equal(clavesIndiceFactura({ emisor_cif: '' }).poner.gsi_emisor, undefined);
});

test('periodo: rappel gana a mantenimiento y este a ventas internas', () => {
  assert.equal(
    clavesIndiceFactura({
      rappel_periodo: '2026-08',
      mantenimiento_periodo: '2026-07',
      ventas_internas_periodo: '2026-06',
    }).poner.gsi_periodo,
    'rappel#2026-08',
  );
  assert.equal(
    clavesIndiceFactura({ mantenimiento_periodo: '2026-07', ventas_internas_periodo: '2026-06' }).poner.gsi_periodo,
    'mantenimiento#2026-07',
  );
  assert.equal(
    clavesIndiceFactura({ ventas_internas_periodo: '2026-06' }).poner.gsi_periodo,
    'ventas_internas#2026-06',
  );
  assert.equal(
    clavesIndiceFactura({
      rappel_periodo: '2026-13',
      mantenimiento_periodo: 'no-es-periodo',
      ventas_internas_periodo: '2025-12',
    }).poner.gsi_periodo,
    'ventas_internas#2025-12',
  );
  assert.equal(clavesIndiceFactura({ rappel_periodo: '' }).poner.gsi_periodo, undefined);
});

test('aplicarClavesFactura borra una clave vacía que ya estuviera en el ítem', () => {
  const item = {
    tipo: 'IN',
    estado: 'borrador',
    fecha_emision: '',
    creado_en: '',
    gsi_fecha: '',
    gsi_tipo: '',
    gsi_periodo: 'rappel#2020-01',
  };
  aplicarClavesFactura(item);
  assert.equal(item.gsi_tipo, 'IN');
  assert.equal(item.gsi_estado, 'borrador');
  assert.equal('gsi_fecha' in item, false);
  assert.equal('gsi_periodo' in item, false);
  assert.equal(item.gsi_fecha, undefined);
});

test('pago: listado fijo y fecha solo si es ISO', () => {
  const bien = clavesIndicePago({ fecha: '2026-04-02T11:00:00.000Z' });
  assert.equal(bien.poner.gsi_listado, 'PAGO');
  assert.equal(bien.poner.gsi_fecha, '2026-04-02');
  assert.deepEqual(bien.quitar, []);

  const sinFecha = clavesIndicePago({ fecha: '02/04/2026' });
  assert.equal(sinFecha.poner.gsi_listado, 'PAGO');
  assert.equal(sinFecha.poner.gsi_fecha, undefined);
  assert.deepEqual(sinFecha.quitar, ['gsi_fecha']);

  const item = { fecha: '', gsi_fecha: '2020-01-01' };
  aplicarClavesPago(item);
  assert.equal(item.gsi_listado, 'PAGO');
  assert.equal('gsi_fecha' in item, false);
});

test('remesa activa en borrador, generada y ejecutada con pendientes', () => {
  for (const estado of ['Borrador', 'Generada']) {
    const { poner, quitar } = clavesIndiceRemesa({ estado, creadoEn: '2026-05-01T08:00:00.000Z' });
    assert.equal(poner.gsi_listado, 'REMESA');
    assert.equal(poner.gsi_activa, 'ACTIVA');
    assert.equal(poner.gsi_fecha, '2026-05-01');
    assert.deepEqual(quitar, []);
  }
  const conPendientes = clavesIndiceRemesa({
    estado: 'Ejecutada',
    lineasPendientesPago: ['FAC-1'],
    creadoEn: '2026-05-02T08:00:00.000Z',
  });
  assert.equal(conPendientes.poner.gsi_activa, 'ACTIVA');
});

test('remesa ejecutada sin pendientes, anulada o sin fecha no deja clave vacía', () => {
  for (const remesa of [
    { estado: 'Ejecutada', lineasPendientesPago: [], creadoEn: '2026-05-03T00:00:00.000Z' },
    { estado: 'Ejecutada', creadoEn: '2026-05-03T00:00:00.000Z' },
    { estado: 'Anulada', creadoEn: '2026-05-03T00:00:00.000Z' },
  ]) {
    const { poner, quitar } = clavesIndiceRemesa(remesa);
    assert.equal(poner.gsi_listado, 'REMESA');
    assert.equal(poner.gsi_activa, undefined);
    assert.equal(poner.gsi_fecha, '2026-05-03');
    assert.deepEqual(quitar, ['gsi_activa']);
  }

  const sinFecha = clavesIndiceRemesa({ estado: 'Borrador', creadoEn: '' });
  assert.equal(sinFecha.poner.gsi_listado, 'REMESA');
  assert.equal(sinFecha.poner.gsi_activa, 'ACTIVA');
  assert.equal(sinFecha.poner.gsi_fecha, undefined);
  assert.deepEqual(sinFecha.quitar, ['gsi_fecha']);

  const item = { estado: 'Anulada', creadoEn: 'no', gsi_activa: 'ACTIVA', gsi_fecha: '' };
  aplicarClavesRemesa(item);
  assert.equal(item.gsi_listado, 'REMESA');
  assert.equal('gsi_activa' in item, false);
  assert.equal('gsi_fecha' in item, false);
});

test('el update de factura mete SET/REMOVE y la versión queda antes del REMOVE', () => {
  const envuelto = updateFacturaVersionado(conClavesFactura({
    UpdateExpression: 'SET estado = :e',
    ExpressionAttributeNames: { '#estado': 'estado' },
    ExpressionAttributeValues: { ':e': 'vencida' },
  }, {
    tipo: 'IN',
    estado: 'vencida',
    fecha_emision: 'no-vale',
    creado_en: '',
    serie: '',
  }));
  assert.match(envuelto.UpdateExpression, /^SET estado = :e,/);
  const ver = envuelto.UpdateExpression.indexOf('#ver');
  const rem = envuelto.UpdateExpression.search(/\bREMOVE\b/);
  assert.ok(ver > 0 && ver < rem);
  assert.equal(envuelto.ExpressionAttributeNames['#estado'], 'estado');
  assert.equal(envuelto.ExpressionAttributeNames['#ver'], 'version');
  const puestos = new Set(Object.values(envuelto.ExpressionAttributeNames));
  assert.ok(puestos.has('gsi_tipo'));
  assert.ok(puestos.has('gsi_estado'));
  assert.ok(puestos.has('gsi_fecha'));
  for (const valor of Object.values(envuelto.ExpressionAttributeValues)) {
    assert.notEqual(valor, '');
  }
});

test('el update de remesa antepone SET a un REMOVE y quita gsi_activa si ya no está activa', () => {
  const params = conClavesRemesa({
    UpdateExpression: 'REMOVE procesandoToken, procesandoDesde',
    ExpressionAttributeValues: { ':tok': 't' },
  }, {
    estado: 'Ejecutada',
    lineasPendientesPago: [],
    creadoEn: '2026-04-01T10:00:00.000Z',
  });
  assert.match(params.UpdateExpression, /^SET /);
  assert.match(params.UpdateExpression, /\bREMOVE\b/);
  assert.match(params.UpdateExpression, /procesandoToken/);
  assert.match(params.UpdateExpression, /procesandoDesde/);
  const aliasActiva = Object.entries(params.ExpressionAttributeNames).find(([, attr]) => attr === 'gsi_activa')[0];
  const aliasListado = Object.entries(params.ExpressionAttributeNames).find(([, attr]) => attr === 'gsi_listado')[0];
  assert.match(params.UpdateExpression, new RegExp(`REMOVE[^]*${aliasActiva}`));
  assert.match(params.UpdateExpression, new RegExp(`SET[^]*${aliasListado} =`));
  for (const valor of Object.values(params.ExpressionAttributeValues)) {
    assert.notEqual(valor, '');
  }
});
