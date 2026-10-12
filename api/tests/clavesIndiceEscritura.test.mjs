/**
 * Las escrituras nuevas de factura, pago y remesa dejan los gsi_* en Dynamo.
 * Las lecturas siguen en Scan: aquí solo se comprueba lo que se guarda.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import { PutCommand } from '@aws-sdk/lib-dynamodb';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-claves-gsi';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { docClient } = await import('../lib/db.js');
const { construirFacturaConLineas } = await import('../lib/facturacion/construirFactura.js');
const { aplicarClavesFactura } = await import('../lib/facturacion/clavesIndice.js');
const { putFacturaVersionada } = await import('../lib/facturacion/versionFactura.js');
const { registrarPagoFactura } = await import('../lib/facturacion/registrarPago.js');
const { default: remesasRouter } = await import('../routes/remesas.js');

const ADMIN = { email: 'jefe@grupo.test', rol: 'Administrador', id_usuario: 'U-1', Nombre: 'Jefe' };
const IBAN_PREDETERMINADA = 'ES6621000418401234567891';
const IBAN_PROVEEDOR = 'ES9121000418450200051332';

let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = ADMIN;
      next();
    });
    app.use('/api', remesasRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function cuenta(iban, empresaId) {
  return { PK: `ACCOUNT#${iban}`, SK: 'META', iban, empresaId, activa: true };
}

function escenario() {
  const db = montarEscenario();
  db.crearTabla(tables.remesas, {
    hashKey: 'remesaId',
    indices: {
      'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' },
      'Activa-index': { hashKey: 'gsi_activa', rangeKey: 'gsi_fecha' },
    },
  });
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.bankAccounts, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'EmpresaId-Iban-index': { hashKey: 'empresaId', rangeKey: 'iban' } },
  });
  db.sembrar(tables.empresas, {
    id_empresa: '000001', Nombre: 'Central', Cif: 'B00000001', IbanPredeterminado: IBAN_PREDETERMINADA,
  });
  db.sembrar(tables.empresas, {
    id_empresa: '000010', Nombre: 'Proveedor S.L.', Cif: 'B12345678', IbanPredeterminado: IBAN_PROVEEDOR,
  });
  db.sembrar(tables.bankAccounts, cuenta(IBAN_PREDETERMINADA, '000001'));
  db.sembrar(tables.bankAccounts, cuenta(IBAN_PROVEEDOR, '000010'));
  return db;
}

test('alta de factura IN, pago y remesa guardan gsi_*; ejecutada sin pendientes pierde gsi_activa', async () => {
  const db = escenario();
  const { factura } = construirFacturaConLineas({
    id_factura: 'FAC-1',
    numero: 1,
    numero_factura: 'FR-1',
    datos: {
      tipo: 'IN',
      serie: 'FR',
      emisor_id: '000001',
      emisor_nombre: 'Central',
      emisor_cif: 'B00000001',
      empresa_id: '000010',
      empresa_nombre: 'Proveedor S.L.',
      empresa_cif: ' b-12.345.678 ',
      empresa_iban: IBAN_PROVEEDOR,
      fecha_emision: '2026-03-15',
      lineas: [{ descripcion: 'Género', cantidad: 1, precio_unitario: 100, tipo_iva: 0 }],
    },
  });
  factura.estado = 'pendiente_pago';
  aplicarClavesFactura(factura);
  await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));

  const guardada = db.obtener(tables.facturas, { id_factura: 'FAC-1' });
  assert.equal(guardada.gsi_tipo, 'IN');
  assert.equal(guardada.gsi_estado, 'pendiente_pago');
  assert.equal(guardada.gsi_fecha, '2026-03-15');
  assert.equal(guardada.gsi_proveedor, 'B12345678');
  assert.equal(guardada.gsi_emisor, '000001');
  assert.equal(guardada.gsi_serie, 'FR');
  assert.equal(guardada.gsi_periodo, undefined);

  const pago = await registrarPagoFactura({
    id_factura: 'FAC-1',
    fecha: '2026-04-02',
    importe: 40,
    metodo_pago: 'transferencia',
    usuario_id: 'U-1',
    usuario_nombre: 'Jefe',
  });
  assert.equal(pago.ok, true);
  const pagoGuardado = db.obtener(tables.facturasPagos, { id_factura: 'FAC-1', id_pago: pago.pago.id_pago });
  assert.equal(pagoGuardado.gsi_listado, 'PAGO');
  assert.equal(pagoGuardado.gsi_fecha, '2026-04-02');
  assert.equal(db.obtener(tables.facturas, { id_factura: 'FAC-1' }).gsi_estado, 'parcialmente_pagada');

  const alta = await api('POST', '/api/remesas', {
    nombre: 'Remesa marzo',
    sociedadId: '000001',
    facturaIds: ['FAC-1'],
  });
  assert.equal(alta.status, 201, alta.body?.error);
  const remesaId = alta.body.remesa.remesaId;
  const remesa = db.obtener(tables.remesas, { remesaId });
  assert.equal(remesa.gsi_listado, 'REMESA');
  assert.equal(remesa.gsi_activa, 'ACTIVA');
  assert.equal(remesa.gsi_fecha, String(remesa.creadoEn).slice(0, 10));

  const ejecutada = await api('POST', `/api/remesas/${remesaId}/ejecutar`, { fecha: '2026-08-11' });
  assert.equal(ejecutada.status, 200, ejecutada.body?.error);
  const cerrada = db.obtener(tables.remesas, { remesaId });
  assert.equal(cerrada.estado, 'Ejecutada');
  assert.equal(cerrada.lineasPendientesPago, undefined);
  assert.equal(cerrada.gsi_activa, undefined);
  assert.equal('gsi_activa' in cerrada, false);
  assert.equal(cerrada.gsi_listado, 'REMESA');
  assert.equal(db.obtener(tables.facturas, { id_factura: 'FAC-1' }).gsi_estado, 'pagada');

  const pagoRemesa = db.listar(tables.facturasPagos).find((p) => p.gsi_fecha === '2026-08-11');
  assert.equal(pagoRemesa.gsi_listado, 'PAGO');
});

test('una factura sin fecha válida no escribe gsi_fecha', async () => {
  const db = escenario();
  const sinFecha = {
    id_factura: 'F-SIN-FECHA',
    tipo: 'IN',
    estado: 'borrador',
    fecha_emision: '31/03/2026',
    creado_en: 'ayer',
    empresa_cif: '',
    emisor_id: '',
    emisor_cif: '',
    serie: '   ',
  };
  await docClient.send(new PutCommand(putFacturaVersionada(sinFecha, undefined)));
  const guardada = db.obtener(tables.facturas, { id_factura: 'F-SIN-FECHA' });
  assert.equal(guardada.gsi_tipo, 'IN');
  assert.equal(guardada.gsi_estado, 'borrador');
  assert.equal(guardada.gsi_fecha, undefined);
  assert.equal('gsi_fecha' in guardada, false);
  assert.equal('gsi_serie' in guardada, false);
  assert.equal('gsi_proveedor' in guardada, false);
  assert.equal('gsi_emisor' in guardada, false);
});
