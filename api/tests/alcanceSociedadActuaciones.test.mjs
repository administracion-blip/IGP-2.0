/**
 * [SEC S-08] asociar-factura: un usuario restringido al Local Norte (sociedad
 * Norte) no asocia facturas de otra sociedad ni marca actuaciones de otro local.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alcance';

const { montarEscenario, tables, local, empresa, EMPRESA_NORTE, EMPRESA_SUR } = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: actuacionesRouter } = await import('../routes/artistasActuaciones.js');

const ROL = 'Administracion';
const NORTE = { sub: 'u-norte', email: 'norte@grupo.test', rol: ROL };
const PROVEEDOR = '000050';

let db;
let servidor = null;
let base = '';

function facturaIn(id, emisor) {
  return {
    id_factura: id,
    tipo: 'IN',
    estado: 'pendiente_pago',
    emisor_id: emisor,
    empresa_id: PROVEEDOR,
    empresa_nombre: 'Banda',
    total_factura: 300,
  };
}

beforeEach(() => {
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.actuaciones, { hashKey: 'id_actuacion' });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.locales, local('000020', 'Local Sur', EMPRESA_SUR));
  db.sembrar(tables.empresas, empresa(PROVEEDOR, 'Banda', { Etiqueta: ['Músicos'] }));
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: NORTE.email, Local: ['Local Norte'], Rol: ROL });
  db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: 'PERMISO#actuaciones.facturacion' });
  db.sembrar(tables.facturas, facturaIn('F-NORTE', EMPRESA_NORTE));
  db.sembrar(tables.facturas, facturaIn('F-SUR', EMPRESA_SUR));
  db.sembrar(tables.actuaciones, { id_actuacion: 'A-NORTE', id_local: '000010', estado: 'firmada' });
  db.sembrar(tables.actuaciones, { id_actuacion: 'A-SUR', id_local: '000020', estado: 'firmada' });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function asociar(cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = NORTE;
      next();
    });
    app.use('/api', actuacionesRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(`${base}/api/actuaciones/asociar-factura`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const estadoDe = (id) => db.obtener(tables.actuaciones, { id_actuacion: id }).estado;

test('con una actuación de un local ajeno: 403 y no se marca ninguna', async () => {
  const r = await asociar({ id_factura: 'F-NORTE', ids_actuacion: ['A-NORTE', 'A-SUR'] });
  assert.equal(r.status, 403);
  assert.equal(estadoDe('A-NORTE'), 'firmada');
  assert.equal(estadoDe('A-SUR'), 'firmada');
});

test('con una factura de otra sociedad: 404 sin tocar la actuación', async () => {
  const r = await asociar({ id_factura: 'F-SUR', ids_actuacion: ['A-NORTE'] });
  assert.equal(r.status, 404);
  assert.equal(estadoDe('A-NORTE'), 'firmada');
});

test('factura y actuación propias: se asocian', async () => {
  const r = await asociar({ id_factura: 'F-NORTE', ids_actuacion: ['A-NORTE'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.actualizadas, 1);
  assert.equal(estadoDe('A-NORTE'), 'asociada');
  assert.equal(db.obtener(tables.actuaciones, { id_actuacion: 'A-NORTE' }).id_factura_gasto, 'F-NORTE');
});
