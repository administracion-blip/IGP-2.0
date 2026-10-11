/**
 * S-04: ejecución atómica/idempotente de remesas.
 *
 * 1) Reclamo concurrente con Update+ConditionExpression — solo un ganador.
 * 2) registrarPagoFactura con la misma idempotencyKey no duplica pagos.
 * 3) POST /remesas/:id/ejecutar: segundo intento → 409 sin nuevo pago.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-remesas';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { docClient } = await import('../lib/db.js');
const { registrarPagoFactura } = await import('../lib/facturacion/registrarPago.js');
const { default: remesasRouter } = await import('../routes/remesas.js');

const ADMIN = { email: 'jefe@grupo.test', rol: 'Administrador', id_usuario: 'U-1', Nombre: 'Jefe' };

let usuarioActual = ADMIN;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario = ADMIN) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual) req.user = usuarioActual;
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

function escenarioRemesas() {
  const db = montarEscenario();
  db.crearTabla(tables.remesas, { hashKey: 'remesaId' });
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.facturasAuditoria, { hashKey: 'id_entrada' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  return db;
}

/** Mismo Update condicional que POST /remesas/:id/ejecutar [SEC S-04]. */
function claimRemesa(remesaId, ts = '2026-08-11T12:00:00.000Z') {
  return docClient.send(
    new UpdateCommand({
      TableName: tables.remesas,
      Key: { remesaId },
      UpdateExpression: 'SET estado = :ejecutada, ejecutadaEn = :ts, actualizadoEn = :ts',
      ConditionExpression: 'estado = :generada OR estado = :borrador',
      ExpressionAttributeValues: {
        ':ejecutada': 'Ejecutada',
        ':generada': 'Generada',
        ':borrador': 'Borrador',
        ':ts': ts,
      },
    }),
  );
}

function sembrarFacturaPendiente(db, id_factura, { total = 100, cobrado = 0 } = {}) {
  const saldo = Math.round((total - cobrado) * 100) / 100;
  db.sembrar(tables.facturas, {
    id_factura,
    tipo: 'IN',
    emisor_id: '000001',
    empresa_iban: 'ES9121000418450200051332',
    total_factura: total,
    total_cobrado: cobrado,
    saldo_pendiente: saldo,
    estado: cobrado > 0 ? 'parcialmente_pagada' : 'pendiente_pago',
  });
}

function sembrarRemesa(db, remesaId, lineas, estado = 'Generada') {
  db.sembrar(tables.remesas, {
    remesaId,
    estado,
    sociedadId: '000001',
    sociedadNombre: 'Central',
    lineas,
    importeTotal: lineas.reduce((s, l) => s + (Number(l.importe) || 0), 0),
  });
}

// ─── Reclamo atómico ───

test('dos Update concurrentes de reclamo: solo uno gana; el segundo ConditionalCheckFailed', async () => {
  const db = escenarioRemesas();
  const remesaId = 'REM-CLAIM-1';
  db.sembrar(tables.remesas, { remesaId, estado: 'Generada' });

  const [r1, r2] = await Promise.allSettled([claimRemesa(remesaId), claimRemesa(remesaId)]);

  const ok = [r1, r2].filter((r) => r.status === 'fulfilled');
  const fail = [r1, r2].filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'solo un reclamo debe tener éxito');
  assert.equal(fail.length, 1);
  assert.equal(fail[0].reason?.name, 'ConditionalCheckFailedException');

  const item = db.obtener(tables.remesas, { remesaId });
  assert.equal(item.estado, 'Ejecutada');
  assert.ok(item.ejecutadaEn);
});

test('reclamo falla si la remesa ya está Ejecutada o Anulada', async () => {
  const db = escenarioRemesas();
  db.sembrar(tables.remesas, { remesaId: 'REM-EJ', estado: 'Ejecutada' });
  db.sembrar(tables.remesas, { remesaId: 'REM-AN', estado: 'Anulada' });

  await assert.rejects(() => claimRemesa('REM-EJ'), { name: 'ConditionalCheckFailedException' });
  await assert.rejects(() => claimRemesa('REM-AN'), { name: 'ConditionalCheckFailedException' });
});

// ─── Idempotencia de pagos ───

test('registrarPagoFactura con la misma idempotencyKey no duplica', async () => {
  const db = escenarioRemesas();
  const id_factura = 'FAC-IDEM-1';
  sembrarFacturaPendiente(db, id_factura, { total: 80 });

  const key = 'remesa:REM-1:FAC-IDEM-1';
  const opts = {
    id_factura,
    fecha: '2026-08-11',
    importe: 80,
    metodo_pago: 'remesa',
    referencia: 'Remesa REM-1',
    usuario_id: 'U-1',
    usuario_nombre: 'Jefe',
    idempotencyKey: key,
  };

  const primero = await registrarPagoFactura(opts);
  assert.equal(primero.ok, true);
  assert.equal(primero.idempotent, undefined);
  assert.equal(primero.pago.idempotency_key, key);

  const segundo = await registrarPagoFactura(opts);
  assert.equal(segundo.ok, true);
  assert.equal(segundo.idempotent, true);
  assert.equal(segundo.pago.id_pago, primero.pago.id_pago);

  const pagos = db.listar(tables.facturasPagos).filter((p) => p.id_factura === id_factura);
  assert.equal(pagos.length, 1, 'no debe crearse un segundo pago');

  const factura = db.obtener(tables.facturas, { id_factura });
  assert.equal(factura.total_cobrado, 80);
  assert.equal(factura.estado, 'pagada');
});

// ─── Endpoint ejecutar ───

test('POST ejecutar reclama y paga; un segundo POST concurrente/reintento da 409 sin duplicar', async () => {
  const db = escenarioRemesas();
  const remesaId = 'REM-EJE-1';
  const id_factura = 'FAC-EJE-1';
  sembrarFacturaPendiente(db, id_factura, { total: 50 });
  sembrarRemesa(db, remesaId, [{ id_factura, importe: 50, concepto: 'Pago proveedor' }], 'Generada');

  const primera = await api('POST', `/api/remesas/${remesaId}/ejecutar`, { fecha: '2026-08-11' });
  assert.equal(primera.status, 200, primera.body?.error || 'ok');
  assert.equal(primera.body.ok, true);
  assert.equal(primera.body.remesa.estado, 'Ejecutada');
  assert.equal(primera.body.pagos?.length, 1);

  const segunda = await api('POST', `/api/remesas/${remesaId}/ejecutar`, { fecha: '2026-08-11' });
  assert.equal(segunda.status, 409);
  assert.match(String(segunda.body.error || ''), /ya está ejecutada/i);

  const pagos = db.listar(tables.facturasPagos).filter((p) => p.id_factura === id_factura);
  assert.equal(pagos.length, 1);
  assert.equal(pagos[0].idempotency_key, `remesa:${remesaId}:${id_factura}`);

  const remesa = db.obtener(tables.remesas, { remesaId });
  assert.equal(remesa.estado, 'Ejecutada');
  assert.equal(remesa.lineasPendientesPago, undefined);
});

/** Hace que cada escritura de pago de `idFactura` choque con otra (o falle con `error`). */
function romperPagosDe(db, idFactura, error) {
  const enviar = docClient.send;
  docClient.send = async (cmd) => {
    const items = cmd?.constructor?.name === 'TransactWriteCommand' ? cmd.input.TransactItems : [];
    const deLaFactura = items.some((it) => it.Put?.TableName === tables.facturas && it.Put.Item.id_factura === idFactura);
    if (deLaFactura) {
      if (error) throw error;
      const f = db.obtener(tables.facturas, { id_factura: idFactura });
      db.sembrar(tables.facturas, { ...f, version: (f.version || 1) + 1 });
    }
    return enviar(cmd);
  };
  return () => { docClient.send = enviar; };
}

test('una línea con 409 FACTURA_CAMBIADA no corta las demás; se reanuda pagando solo la pendiente', async () => {
  const db = escenarioRemesas();
  const remesaId = 'REM-PARCIAL';
  sembrarFacturaPendiente(db, 'FAC-A', { total: 40 });
  sembrarFacturaPendiente(db, 'FAC-B', { total: 60 });
  sembrarRemesa(db, remesaId, [
    { id_factura: 'FAC-A', importe: 40 },
    { id_factura: 'FAC-B', importe: 60 },
  ]);

  const restaurar = romperPagosDe(db, 'FAC-A');
  let primera;
  try {
    primera = await api('POST', `/api/remesas/${remesaId}/ejecutar`, { fecha: '2026-08-11' });
  } finally {
    restaurar();
  }
  assert.equal(primera.status, 409);
  assert.equal(primera.body.code, 'REMESA_EJECUCION_PARCIAL');
  assert.match(primera.body.error, /1 de 2 pago/);
  assert.equal(primera.body.pagos.length, 1);
  assert.deepEqual(primera.body.fallidas, [
    { id_factura: 'FAC-A', error: 'La factura ha cambiado, vuelve a intentarlo', code: 'FACTURA_CAMBIADA' },
  ]);
  assert.deepEqual(primera.body.remesa.lineasPendientesPago, ['FAC-A']);
  assert.equal(db.obtener(tables.facturas, { id_factura: 'FAC-B' }).estado, 'pagada');
  assert.equal(db.obtener(tables.facturas, { id_factura: 'FAC-A' }).total_cobrado, 0);
  const guardada = db.obtener(tables.remesas, { remesaId });
  assert.equal(guardada.estado, 'Ejecutada');
  assert.deepEqual(guardada.lineasPendientesPago, ['FAC-A']);

  const segunda = await api('POST', `/api/remesas/${remesaId}/ejecutar`, { fecha: '2026-08-11' });
  assert.equal(segunda.status, 200, JSON.stringify(segunda.body));
  assert.deepEqual(segunda.body.pagos.map((p) => p.id_factura), ['FAC-A']);
  assert.equal(segunda.body.remesa.lineasPendientesPago, undefined);
  assert.equal(db.obtener(tables.remesas, { remesaId }).lineasPendientesPago, undefined);
  assert.equal(db.listar(tables.facturasPagos).filter((p) => p.id_factura === 'FAC-B').length, 1);
  assert.equal(db.obtener(tables.facturas, { id_factura: 'FAC-A' }).estado, 'pagada');

  const tercera = await api('POST', `/api/remesas/${remesaId}/ejecutar`, { fecha: '2026-08-11' });
  assert.equal(tercera.status, 409);
  assert.match(tercera.body.error, /ya está ejecutada/);
});

test('un error interno en una línea sale genérico en fallidas, sin detalle técnico', async () => {
  const db = escenarioRemesas();
  sembrarFacturaPendiente(db, 'FAC-X', { total: 10 });
  sembrarFacturaPendiente(db, 'FAC-Y', { total: 20 });
  sembrarRemesa(db, 'REM-500', [{ id_factura: 'FAC-X', importe: 10 }, { id_factura: 'FAC-Y', importe: 20 }]);
  const restaurar = romperPagosDe(db, 'FAC-Y', Object.assign(new Error('ProvisionedThroughputExceeded arn:aws:dynamodb:...'), {
    name: 'ProvisionedThroughputExceededException', $metadata: { httpStatusCode: 400 },
  }));
  let r;
  try {
    r = await api('POST', '/api/remesas/REM-500/ejecutar', { fecha: '2026-08-11' });
  } finally {
    restaurar();
  }
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.fallidas, [{ id_factura: 'FAC-Y', error: 'Error interno del servidor' }]);
  assert.deepEqual(db.obtener(tables.remesas, { remesaId: 'REM-500' }).lineasPendientesPago, ['FAC-Y']);
});
