/**
 * S-16 en las rutas: editar un pago, editar la factura o anularla mientras entra
 * otro pago ya no pisa el total_cobrado escrito por el otro.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import { createRequire } from 'node:module';

const Tesseract = createRequire(import.meta.url)('tesseract.js');
Tesseract.createWorker = async () => ({
  recognize: async () => ({ data: { text: '' } }),
  terminate: async () => {},
});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-edicion-concurrente';

const { montarEscenario, tables, local, EMPRESA_NORTE } = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { registrarPagoFactura } = await import('../lib/facturacion/registrarPago.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const ROL = 'Administracion';
const PERMISOS = ['facturacion.cobrar_pagar', 'facturacion.editar', 'facturacion.anular'];
const NORTE = { sub: 'u-norte', email: 'norte@grupo.test', rol: ROL };

let db;
let servidor = null;
let base = '';

beforeEach(() => {
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.remesas, { hashKey: 'remesaId' });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: NORTE.email, Local: ['Local Norte'], Rol: ROL });
  for (const p of PERMISOS) db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: `PERMISO#${p}` });
  db.sembrar(tables.facturas, {
    id_factura: 'F-1',
    tipo: 'IN',
    emisor_id: EMPRESA_NORTE,
    estado: 'parcialmente_pagada',
    total_factura: 100,
    total_cobrado: 10,
    saldo_pendiente: 90,
    version: 3,
  });
  db.sembrar(tables.facturasPagos, { id_factura: 'F-1', id_pago: 'P001', importe: 10, metodo_pago: 'transferencia', fecha: '2026-10-01' });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function api(metodo, ruta, cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = NORTE;
      next();
    });
    app.use('/api', facturacionRouter);
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

const otroPago = () => registrarPagoFactura({ id_factura: 'F-1', fecha: '2026-10-02', importe: 30, metodo_pago: 'transferencia' });
const factura = () => db.obtener(tables.facturas, { id_factura: 'F-1' });

test('editar un pago mientras entra otro: se relee y el total suma el pago editado y el nuevo', async () => {
  db.interceptar('TransactWriteCommand', undefined, otroPago);
  const r = await api('PUT', '/api/facturacion/pagos/F-1/P001', { fecha: '2026-10-01', importe: 15, metodo_pago: 'transferencia' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.listar(tables.facturasPagos).length, 2);
  assert.equal(factura().total_cobrado, 45);
  assert.equal(factura().saldo_pendiente, 55);
});

test('editar las líneas de la factura mientras entra un pago: el saldo se recalcula con el pago nuevo', async () => {
  db.interceptar('PutCommand', tables.facturas, otroPago);
  const r = await api('PUT', '/api/facturacion/facturas/F-1', {
    lineas: [{ descripcion: 'Servicio', cantidad: 1, precio_unitario: 200, tipo_iva: 0 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const f = factura();
  assert.equal(f.total_factura, 200);
  assert.equal(f.total_cobrado, 40);
  assert.equal(f.saldo_pendiente, 160);
  assert.equal(r.body.factura.total_cobrado, 40);
});

test('anular mientras entra un pago: 409 y el pago no se pierde', async () => {
  db.interceptar('PutCommand', tables.facturas, otroPago);
  const r = await api('POST', '/api/facturacion/facturas/F-1/anular', { motivo: 'error' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'La factura ha cambiado, vuelve a intentarlo');
  assert.equal(factura().estado, 'parcialmente_pagada');
  assert.equal(factura().total_cobrado, 40);
});

/** Lecturas de facturas/pagos hechas después del primer intento de escritura de la factura. */
async function lecturasTrasPrimerIntento(accion) {
  const { docClient } = await import('../lib/db.js');
  const enviar = docClient.send;
  const lecturas = [];
  let escrito = false;
  docClient.send = async (cmd) => {
    const nombre = cmd?.constructor?.name;
    const tabla = cmd?.input?.TableName;
    if (nombre === 'TransactWriteCommand' || (nombre === 'PutCommand' && tabla === tables.facturas)) escrito = true;
    else if (escrito && ['GetCommand', 'QueryCommand'].includes(nombre)
      && [tables.facturas, tables.facturasPagos].includes(tabla)) lecturas.push(cmd.input);
    return enviar.call(docClient, cmd);
  };
  try {
    return { r: await accion(), lecturas };
  } finally {
    docClient.send = enviar;
  }
}

test('al reintentar editar un pago o la factura se relee con ConsistentRead', async () => {
  db.interceptar('TransactWriteCommand', undefined, otroPago);
  const pago = await lecturasTrasPrimerIntento(() => api('PUT', '/api/facturacion/pagos/F-1/P001', {
    fecha: '2026-10-01', importe: 15, metodo_pago: 'transferencia',
  }));
  assert.equal(pago.r.status, 200);
  assert.ok(pago.lecturas.length >= 2);
  assert.ok(pago.lecturas.every((l) => l.ConsistentRead === true), JSON.stringify(pago.lecturas));

  db.interceptar('PutCommand', tables.facturas, otroPago);
  const edicion = await lecturasTrasPrimerIntento(() => api('PUT', '/api/facturacion/facturas/F-1', { observaciones: 'x' }));
  assert.equal(edicion.r.status, 200);
  const relecturas = edicion.lecturas.filter((l) => l.TableName === tables.facturas);
  assert.ok(relecturas.length >= 1);
  assert.ok(relecturas.every((l) => l.ConsistentRead === true));
});

test('check-vencimientos: si un pago la deja pagada entre el Scan y el Update, no se marca vencida (omitida)', async () => {
  db.sembrar(tables.facturas, { ...factura(), fecha_vencimiento: '2020-01-01' });
  db.interceptar('UpdateCommand', tables.facturas, () => registrarPagoFactura({
    id_factura: 'F-1', fecha: '2026-10-02', importe: 90, metodo_pago: 'transferencia',
  }));
  const r = await api('POST', '/api/facturacion/check-vencimientos');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.actualizadas, 0);
  assert.equal(r.body.omitidas, 1);
  assert.equal(factura().estado, 'pagada');
  assert.equal(factura().saldo_pendiente, 0);
});

test('check-vencimientos sin carrera marca vencida y sube la versión', async () => {
  db.sembrar(tables.facturas, { ...factura(), fecha_vencimiento: '2020-01-01' });
  const r = await api('POST', '/api/facturacion/check-vencimientos');
  assert.equal(r.body.actualizadas, 1);
  assert.equal(r.body.omitidas, 0);
  assert.equal(factura().estado, 'vencida');
  assert.equal(factura().version, 4);
});

test('un Update de factura entre la lectura y el Put de un pago: el pago relee y no pisa el Update', async () => {
  const { docClient } = await import('../lib/db.js');
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const { updateFacturaVersionado } = await import('../lib/facturacion/versionFactura.js');
  // Factura antigua sin version: el Update se la crea y el Put condicionado a
  // attribute_not_exists(version) tiene que fallar y releer.
  const { version: _v, ...sinVersion } = factura();
  db.sembrar(tables.facturas, sinVersion);
  db.interceptar('TransactWriteCommand', undefined, () => docClient.send(new UpdateCommand(updateFacturaVersionado({
    Key: { id_factura: 'F-1' },
    UpdateExpression: 'SET adjuntos = :adj',
    ExpressionAttributeValues: { ':adj': [{ id: 'a1' }] },
  }))));
  await otroPago();
  const f = factura();
  assert.deepEqual(f.adjuntos, [{ id: 'a1' }]);
  assert.equal(f.total_cobrado, 40);
  assert.equal(f.version, 3);
});

test('updateFacturaVersionado: sin version pasa a 2, con version suma 1, respeta REMOVE', async () => {
  const { updateFacturaVersionado } = await import('../lib/facturacion/versionFactura.js');
  const p = updateFacturaVersionado({
    Key: { id_factura: 'F-1' },
    UpdateExpression: 'SET a = :a REMOVE b',
    ExpressionAttributeValues: { ':a': 1 },
  });
  assert.equal(p.UpdateExpression, 'SET a = :a, #ver = if_not_exists(#ver, :verUno) + :verUno REMOVE b');
  assert.equal(p.TableName, tables.facturas);
  assert.equal(p.ExpressionAttributeValues[':verUno'], 1);
});

test('ningún UpdateCommand sobre la tabla de facturas se salta la subida de versión', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const raiz = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const ficheros = [
    ...readdirSync(join(raiz, 'routes')).map((f) => join(raiz, 'routes', f)),
    ...readdirSync(join(raiz, 'lib', 'facturacion')).map((f) => join(raiz, 'lib', 'facturacion', f)),
  ].filter((f) => f.endsWith('.js'));
  assert.ok(ficheros.some((f) => f.endsWith('facturacion.js')));
  const sinVersion = ficheros.filter((f) => /new UpdateCommand\(\{\s*TableName:\s*tables\.facturas\s*,/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(sinVersion, []);
});

test('sin concurrencia, editar pago y anular siguen funcionando y suben la versión', async () => {
  const r = await api('PUT', '/api/facturacion/pagos/F-1/P001', { fecha: '2026-10-01', importe: 20, metodo_pago: 'transferencia' });
  assert.equal(r.status, 200);
  assert.equal(factura().total_cobrado, 20);
  assert.equal(factura().version, 4);
  const a = await api('POST', '/api/facturacion/facturas/F-1/anular', { motivo: 'error' });
  assert.equal(a.status, 200);
  assert.equal(factura().estado, 'anulada');
  assert.equal(factura().version, 5);
});
