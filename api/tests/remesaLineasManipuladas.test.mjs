/**
 * El IBAN y el importe que acaban en el fichero BBVA no los decide el cliente.
 *
 * En el PATCH de líneas solo cuentan `importe` (acotado al máximo guardado) y
 * `concepto` de facturas que ya están en la remesa. Y antes de generar el
 * fichero o ejecutar, cada línea se recalcula desde la factura y el maestro:
 * aunque la línea guardada estuviera manipulada, el dinero va a la cuenta del
 * proveedor y nunca por encima del pendiente.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import ExcelJS from 'exceljs';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-remesas';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { default: remesasRouter } = await import('../routes/remesas.js');
const { normalizarLineasEntrada } = await import('../lib/remesas/recalcularLineas.js');

const ADMIN = { email: 'jefe@grupo.test', rol: 'Administrador', id_usuario: 'U-1', Nombre: 'Jefe' };

const IBAN_ORDENANTE = 'ES6621000418401234567891';
const IBAN_PROVEEDOR = 'ES9121000418450200051332';
const IBAN_ATACANTE = 'ES7921000813610123456789';

let servidor = null;
let base = '';

async function arrancar() {
  if (servidor) return;
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

async function api(metodo, ruta, cuerpo) {
  await arrancar();
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Lee las líneas de beneficiario del Excel BBVA FIT (desde la fila 12: nombre, cuenta, importe). */
async function descargarFichero(remesaId) {
  await arrancar();
  const res = await fetch(`${base}/api/remesas/${remesaId}/fichero`);
  if (!res.ok) return { status: res.status, body: await res.json().catch(() => ({})) };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('Remesa Transferencia SEPA');
  const lineas = [];
  for (let fila = 12; ; fila += 1) {
    const cuenta = ws.getCell(fila, 2).value;
    if (!cuenta) break;
    lineas.push({ cuenta: String(cuenta), importe: Number(ws.getCell(fila, 3).value) });
  }
  return { status: res.status, lineas };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function escenario() {
  const db = montarEscenario();
  db.crearTabla(tables.remesas, { hashKey: 'remesaId' });
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.sembrar(tables.empresas, { id_empresa: '000001', Nombre: 'Central', Cif: 'B00000001', IbanPredeterminado: IBAN_ORDENANTE });
  db.sembrar(tables.empresas, { id_empresa: '000010', Nombre: 'Proveedor S.L.', Cif: 'B12345678', IbanPredeterminado: IBAN_PROVEEDOR });
  for (const [id, pendiente] of [['FAC-1', 100], ['FAC-2', 60]]) {
    db.sembrar(tables.facturas, {
      id_factura: id,
      tipo: 'IN',
      estado: 'pendiente_pago',
      emisor_id: '000001',
      empresa_id: '000010',
      empresa_cif: 'B12345678',
      empresa_nombre: 'Proveedor S.L.',
      numero_factura: id,
      total_factura: pendiente,
      total_cobrado: 0,
      saldo_pendiente: pendiente,
    });
  }
  return db;
}

async function crearRemesa() {
  const r = await api('POST', '/api/remesas', {
    nombre: 'Remesa prueba',
    sociedadId: '000001',
    facturaIds: ['FAC-1', 'FAC-2'],
  });
  assert.equal(r.status, 201, r.body?.error);
  return r.body.remesa;
}

test('PATCH con IBAN e importe máximo manipulados: se ignoran y el fichero paga al proveedor', async () => {
  const db = escenario();
  const remesa = await crearRemesa();

  const r = await api('PATCH', `/api/remesas/${remesa.remesaId}`, {
    lineas: [
      { ...remesa.lineas[0], ibanBeneficiario: IBAN_ATACANTE, importeMaximo: 99999, saldoPendiente: 99999, importe: 99999, proveedorNombre: 'Atacante' },
      { ...remesa.lineas[1], ibanBeneficiario: IBAN_ATACANTE },
      { id_factura: 'FAC-INVENTADA', ibanBeneficiario: IBAN_ATACANTE, importe: 5000, importeMaximo: 5000 },
    ],
  });
  assert.equal(r.status, 200, r.body?.error);

  const guardada = db.obtener(tables.remesas, { remesaId: remesa.remesaId });
  assert.deepEqual(guardada.lineas.map((l) => l.id_factura), ['FAC-1', 'FAC-2'], 'la línea desconocida no entra');
  for (const l of guardada.lineas) {
    assert.equal(l.ibanBeneficiario, IBAN_PROVEEDOR);
    assert.equal(l.proveedorNombre, 'Proveedor S.L.');
  }
  assert.equal(guardada.lineas[0].importe, 100, 'el importe se acota al máximo guardado');
  assert.equal(guardada.lineas[0].importeMaximo, 100);
  assert.equal(guardada.importeTotal, 160);

  const fichero = await descargarFichero(remesa.remesaId);
  assert.equal(fichero.status, 200);
  assert.deepEqual(fichero.lineas, [
    { cuenta: IBAN_PROVEEDOR, importe: 100 },
    { cuenta: IBAN_PROVEEDOR, importe: 60 },
  ]);
});

test('línea guardada manipulada: el fichero se recalcula desde la factura y el maestro', async () => {
  const db = escenario();
  const remesa = await crearRemesa();
  const guardada = db.obtener(tables.remesas, { remesaId: remesa.remesaId });
  db.sembrar(tables.remesas, {
    ...guardada,
    lineas: guardada.lineas.map((l) => ({ ...l, ibanBeneficiario: IBAN_ATACANTE, importe: 99999, importeMaximo: 99999 })),
  });

  const fichero = await descargarFichero(remesa.remesaId);
  assert.equal(fichero.status, 200);
  assert.deepEqual(fichero.lineas, [
    { cuenta: IBAN_PROVEEDOR, importe: 100 },
    { cuenta: IBAN_PROVEEDOR, importe: 60 },
  ]);
  const tras = db.obtener(tables.remesas, { remesaId: remesa.remesaId });
  assert.equal(tras.estado, 'Generada');
  assert.equal(tras.importeTotal, 160);
  assert.ok(tras.lineas.every((l) => l.ibanBeneficiario === IBAN_PROVEEDOR));
});

test('si una factura ya no es pagable: 409 pidiendo revalidar, sin fichero ni pagos', async () => {
  const db = escenario();
  const remesa = await crearRemesa();
  const fac2 = db.obtener(tables.facturas, { id_factura: 'FAC-2' });
  db.sembrar(tables.facturas, { ...fac2, estado: 'pagada', saldo_pendiente: 0, total_cobrado: 60 });

  const fichero = await descargarFichero(remesa.remesaId);
  assert.equal(fichero.status, 409);
  assert.match(fichero.body.error, /Revalida/);
  assert.equal(db.obtener(tables.remesas, { remesaId: remesa.remesaId }).estado, 'Borrador');

  const ejecutar = await api('POST', `/api/remesas/${remesa.remesaId}/ejecutar`, { fecha: '2026-08-11' });
  assert.equal(ejecutar.status, 409);
  assert.match(ejecutar.body.error, /Revalida/);
  assert.equal(db.listar(tables.facturasPagos).length, 0);
  assert.equal(db.obtener(tables.remesas, { remesaId: remesa.remesaId }).estado, 'Borrador');
});

test('la edición legítima de importe y concepto sigue funcionando', async () => {
  const db = escenario();
  const remesa = await crearRemesa();
  const lineas = remesa.lineas.map((l) =>
    l.id_factura === 'FAC-1' ? { ...l, importe: 40, concepto: 'Pago parcial' } : l,
  );
  const r = await api('PATCH', `/api/remesas/${remesa.remesaId}`, { lineas });
  assert.equal(r.status, 200, r.body?.error);
  assert.equal(r.body.remesa.lineas[0].importe, 40);
  assert.equal(r.body.remesa.lineas[0].concepto, 'Pago parcial');
  assert.equal(r.body.remesa.importeTotal, 100);

  const fichero = await descargarFichero(remesa.remesaId);
  assert.deepEqual(fichero.lineas, [
    { cuenta: IBAN_PROVEEDOR, importe: 40 },
    { cuenta: IBAN_PROVEEDOR, importe: 60 },
  ]);

  const ejecutar = await api('POST', `/api/remesas/${remesa.remesaId}/ejecutar`, { fecha: '2026-08-11' });
  assert.equal(ejecutar.status, 200, ejecutar.body?.error);
  assert.equal(ejecutar.body.pagos.length, 2);
  assert.equal(db.obtener(tables.facturas, { id_factura: 'FAC-1' }).total_cobrado, 40);
});

test('quitar y añadir facturas por sus vías propias sigue funcionando', async () => {
  const db = escenario();
  const remesa = await crearRemesa();
  const quitar = await api('PATCH', `/api/remesas/${remesa.remesaId}`, { quitarFacturaIds: ['FAC-2'] });
  assert.equal(quitar.status, 200, quitar.body?.error);
  assert.deepEqual(quitar.body.remesa.lineas.map((l) => l.id_factura), ['FAC-1']);

  const anadir = await api('PATCH', `/api/remesas/${remesa.remesaId}`, { anadirFacturaIds: ['FAC-2'] });
  assert.equal(anadir.status, 200, anadir.body?.error);
  const fac2 = anadir.body.remesa.lineas.find((l) => l.id_factura === 'FAC-2');
  assert.equal(fac2.ibanBeneficiario, IBAN_PROVEEDOR);
  assert.equal(db.obtener(tables.remesas, { remesaId: remesa.remesaId }).importeTotal, 160);
});

test('facturas repetidas en facturaIds o anadirFacturaIds generan una sola línea', async () => {
  const db = escenario();
  const r = await api('POST', '/api/remesas', {
    nombre: 'Remesa duplicada',
    sociedadId: '000001',
    facturaIds: ['FAC-1', 'FAC-1', ' FAC-1 '],
  });
  assert.equal(r.status, 201, r.body?.error);
  assert.deepEqual(r.body.remesa.lineas.map((l) => l.id_factura), ['FAC-1']);
  assert.equal(r.body.remesa.importeTotal, 100);

  const anadir = await api('PATCH', `/api/remesas/${r.body.remesa.remesaId}`, {
    anadirFacturaIds: [' FAC-1 ', 'FAC-2', 'FAC-2 '],
  });
  assert.equal(anadir.status, 200, anadir.body?.error);
  const guardada = db.obtener(tables.remesas, { remesaId: r.body.remesa.remesaId });
  assert.deepEqual(guardada.lineas.map((l) => l.id_factura), ['FAC-1', 'FAC-2']);
  assert.equal(guardada.importeTotal, 160);
});

test('líneas duplicadas inyectadas en BD: 409 en fichero y ejecutar, sin pagos', async () => {
  const db = escenario();
  const remesa = await crearRemesa();
  const guardada = db.obtener(tables.remesas, { remesaId: remesa.remesaId });
  const fac1 = guardada.lineas.find((l) => l.id_factura === 'FAC-1');
  db.sembrar(tables.remesas, { ...guardada, lineas: [fac1, { ...fac1 }] });

  const fichero = await descargarFichero(remesa.remesaId);
  assert.equal(fichero.status, 409);
  assert.match(fichero.body.error, /Revalida/);
  assert.deepEqual(fichero.body.invalidas, [{ id_factura: 'FAC-1', motivo: 'Factura duplicada en la remesa' }]);
  assert.equal(db.obtener(tables.remesas, { remesaId: remesa.remesaId }).estado, 'Borrador');

  const ejecutar = await api('POST', `/api/remesas/${remesa.remesaId}/ejecutar`, { fecha: '2026-08-11' });
  assert.equal(ejecutar.status, 409);
  assert.equal(db.listar(tables.facturasPagos).length, 0);
  assert.equal(db.obtener(tables.remesas, { remesaId: remesa.remesaId }).estado, 'Borrador');
});

test('normalizarLineasEntrada: solo importe y concepto, acotado a [0, importeMaximo]', () => {
  const existentes = [{ id_factura: 'A', ibanBeneficiario: IBAN_PROVEEDOR, importe: 50, importeMaximo: 50, concepto: 'c' }];
  const [l] = normalizarLineasEntrada([{ id_factura: 'A', importe: -10, ibanBeneficiario: IBAN_ATACANTE, importeMaximo: 1e6 }], existentes);
  assert.equal(l.importe, 0);
  assert.equal(l.importeMaximo, 50);
  assert.equal(l.ibanBeneficiario, IBAN_PROVEEDOR);
  assert.deepEqual(normalizarLineasEntrada([{ id_factura: 'B', importe: 1 }], existentes), []);
  assert.equal(normalizarLineasEntrada(undefined, existentes), existentes);
  assert.equal(normalizarLineasEntrada([{ id_factura: 'A' }, { id_factura: 'A', importe: 1 }], existentes).length, 1);
});