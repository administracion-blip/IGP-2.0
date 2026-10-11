/**
 * La cuenta ordenante (desde la que sale el dinero) tiene que ser una cuenta
 * registrada de la sociedad ordenante. Antes bastaba con que el IBAN fuera
 * válido: con remesas.gestionar se podía poner cualquier cuenta en la remesa y
 * el fichero BBVA salía con ella.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-cuenta-ordenante';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { default: remesasRouter } = await import('../routes/remesas.js');

const ADMIN = { email: 'jefe@grupo.test', rol: 'Administrador', id_usuario: 'U-1', Nombre: 'Jefe' };

const IBAN_PREDETERMINADA = 'ES6621000418401234567891';
const IBAN_SEGUNDA = 'ES7921000813610123456789';
const IBAN_INACTIVA = 'ES1000492352082414205416';
const IBAN_PROVEEDOR = 'ES9121000418450200051332';
const IBAN_AJENO = 'ES8023100001180000012345';

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

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function cuenta(iban, empresaId, extra = {}) {
  return { PK: `ACCOUNT#${iban}`, SK: 'META', iban, empresaId, activa: true, ...extra };
}

function escenario() {
  const db = montarEscenario();
  db.crearTabla(tables.remesas, { hashKey: 'remesaId' });
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.bankAccounts, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'EmpresaId-Iban-index': { hashKey: 'empresaId', rangeKey: 'iban' } },
  });
  db.sembrar(tables.empresas, { id_empresa: '000001', Nombre: 'Central', Cif: 'B00000001', IbanPredeterminado: IBAN_PREDETERMINADA });
  db.sembrar(tables.empresas, { id_empresa: '000010', Nombre: 'Proveedor S.L.', Cif: 'B12345678', IbanPredeterminado: IBAN_PROVEEDOR });
  db.sembrar(tables.bankAccounts, cuenta(IBAN_PREDETERMINADA, '000001'));
  db.sembrar(tables.bankAccounts, cuenta(IBAN_SEGUNDA, '000001'));
  db.sembrar(tables.bankAccounts, cuenta(IBAN_INACTIVA, '000001', { activa: false }));
  db.sembrar(tables.bankAccounts, cuenta(IBAN_PROVEEDOR, '000010'));
  db.sembrar(tables.facturas, {
    id_factura: 'FAC-1',
    tipo: 'IN',
    estado: 'pendiente_pago',
    emisor_id: '000001',
    empresa_id: '000010',
    empresa_cif: 'B12345678',
    empresa_nombre: 'Proveedor S.L.',
    numero_factura: 'FAC-1',
    total_factura: 100,
    total_cobrado: 0,
    saldo_pendiente: 100,
  });
  return db;
}

async function crearRemesa(extra = {}) {
  return api('POST', '/api/remesas', { nombre: 'Remesa', sociedadId: '000001', facturaIds: ['FAC-1'], ...extra });
}

test('alta sin cuenta: se toma la predeterminada de la sociedad, como hasta ahora', async () => {
  escenario();
  const r = await crearRemesa();
  assert.equal(r.status, 201, r.body?.error);
  assert.equal(r.body.remesa.cuentaOrdenante, IBAN_PREDETERMINADA);
});

test('PATCH con un IBAN válido que no es de la sociedad: 400 y la cuenta no cambia', async () => {
  const db = escenario();
  const { body } = await crearRemesa();
  for (const iban of [IBAN_AJENO, IBAN_PROVEEDOR, IBAN_INACTIVA]) {
    const r = await api('PATCH', `/api/remesas/${body.remesa.remesaId}`, { cuentaOrdenante: iban });
    assert.equal(r.status, 400, iban);
    assert.match(r.body.error, /no es una cuenta registrada de la sociedad/);
  }
  assert.equal(db.obtener(tables.remesas, { remesaId: body.remesa.remesaId }).cuentaOrdenante, IBAN_PREDETERMINADA);
});

test('PATCH con otra cuenta activa de la sociedad (aunque venga con espacios): se acepta', async () => {
  const db = escenario();
  const { body } = await crearRemesa();
  const conEspacios = IBAN_SEGUNDA.replace(/(.{4})/g, '$1 ').trim();
  const r = await api('PATCH', `/api/remesas/${body.remesa.remesaId}`, { cuentaOrdenante: conEspacios });
  assert.equal(r.status, 200, r.body?.error);
  assert.equal(db.obtener(tables.remesas, { remesaId: body.remesa.remesaId }).cuentaOrdenante, IBAN_SEGUNDA);
});

test('POST con una cuenta ajena: 400 y no se crea la remesa', async () => {
  const db = escenario();
  const r = await crearRemesa({ cuentaOrdenante: IBAN_AJENO });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no es una cuenta registrada/);
  assert.equal(db.listar(tables.remesas).length, 0);
  assert.equal((await crearRemesa({ cuentaOrdenante: IBAN_SEGUNDA })).status, 201);
});

test('generar fichero con una cuenta ajena guardada: 409 y la remesa no pasa a Generada', async () => {
  const db = escenario();
  const { body } = await crearRemesa();
  const guardada = db.obtener(tables.remesas, { remesaId: body.remesa.remesaId });
  db.sembrar(tables.remesas, { ...guardada, cuentaOrdenante: IBAN_AJENO });

  await arrancar();
  const res = await fetch(`${base}/api/remesas/${body.remesa.remesaId}/fichero`);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Revisa la cuenta/);
  assert.equal(db.obtener(tables.remesas, { remesaId: body.remesa.remesaId }).estado, 'Borrador');
});

test('generar fichero con una cuenta de la sociedad sigue funcionando', async () => {
  const db = escenario();
  const { body } = await crearRemesa({ cuentaOrdenante: IBAN_SEGUNDA });
  await arrancar();
  const res = await fetch(`${base}/api/remesas/${body.remesa.remesaId}/fichero`);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  assert.equal(db.obtener(tables.remesas, { remesaId: body.remesa.remesaId }).estado, 'Generada');
});
