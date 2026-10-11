/**
 * [SEC S-08] Ataques por sociedad en Refacturación: un usuario restringido a la
 * sociedad Norte no crea, reasigna, borra ni emite líneas de la sociedad Sur.
 * La sede emisora del grupo vale siempre para quien tiene refacturacion.gestionar.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alcance';

const {
  montarEscenario, tables, local, empresa, serie, EMPRESA_CENTRAL, EMPRESA_NORTE, EMPRESA_SUR,
} = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: refacturacionRouter } = await import('../routes/refacturacion.js');

const ROL = 'Administracion';
const PERMISOS = ['refacturacion.gestionar', 'refacturacion.ver'];
const NORTE = { sub: 'u-norte', email: 'norte@grupo.test', rol: ROL };

let db;
let servidor = null;
let base = '';
const avisos = [];
const warnOriginal = console.warn;

function linea(id, empresaId) {
  return {
    PK: `SOCIEDAD#${empresaId}`,
    SK: `LINEA#2026-01-01T00:00:00.000Z#${id}`,
    id_linea: id,
    estado: 'pendiente',
    creado_en: '2026-01-01T00:00:00.000Z',
    empresa_destino_id: empresaId,
    descripcion: 'Material',
    cantidad: 1,
    precio_base_unitario: 100,
    precio_refacturado_unitario: 105,
    tipo_iva: 21,
    descuento: 0,
  };
}

beforeEach(() => {
  delete process.env.ALCANCE_MODO_LECTURAS;
  avisos.length = 0;
  console.warn = (...args) => {
    if (args[0] === '[alcance] denegaría') avisos.push(args[1]);
    else warnOriginal(...args);
  };
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.refacturaciones, { hashKey: 'PK', rangeKey: 'SK' });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.locales, local('000020', 'Local Sur', EMPRESA_SUR));
  db.sembrar(tables.empresas, empresa(EMPRESA_CENTRAL, 'Central', { Sede: 'GRUPO PARIPE' }));
  db.sembrar(tables.empresas, empresa(EMPRESA_NORTE, 'Norte'));
  db.sembrar(tables.empresas, empresa(EMPRESA_SUR, 'Sur'));
  db.sembrar(tables.facturasSeries, serie('REF'));
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: NORTE.email, Local: ['Local Norte'], Rol: ROL });
  for (const p of PERMISOS) db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: `PERMISO#${p}` });
  db.sembrar(tables.refacturaciones, linea('L-NORTE', EMPRESA_NORTE));
  db.sembrar(tables.refacturaciones, linea('L-SUR', EMPRESA_SUR));
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  console.warn = warnOriginal;
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
    app.use('/api', refacturacionRouter);
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

const lineasDe = (empresaId) => db.listar(tables.refacturaciones).filter((l) => l.PK === `SOCIEDAD#${empresaId}`);

test('PATCH reasignando una línea propia a otra sociedad: 403 y la línea no se mueve', async () => {
  const r = await api('PATCH', '/api/refacturacion/lineas/L-NORTE', {
    empresa_destino_id: EMPRESA_NORTE,
    empresa_destino_id_nueva: EMPRESA_SUR,
  });
  assert.equal(r.status, 403);
  assert.deepEqual(lineasDe(EMPRESA_NORTE).map((l) => l.id_linea), ['L-NORTE']);
  assert.deepEqual(lineasDe(EMPRESA_SUR).map((l) => l.id_linea), ['L-SUR']);
});

test('PATCH y DELETE de una línea de otra sociedad: 404 sin cambios', async () => {
  const patch = await api('PATCH', '/api/refacturacion/lineas/L-SUR', {
    empresa_destino_id: EMPRESA_SUR,
    estado: 'descartada',
  });
  assert.equal(patch.status, 404);
  const del = await api('DELETE', `/api/refacturacion/lineas/L-SUR?empresa_destino_id=${EMPRESA_SUR}`);
  assert.equal(del.status, 404);
  assert.equal(lineasDe(EMPRESA_SUR)[0].estado, 'pendiente');
});

test('POST con una línea a otra sociedad: 403 y no se guarda ninguna', async () => {
  const r = await api('POST', '/api/refacturacion/lineas', {
    lineas: [
      { empresa_destino_id: EMPRESA_NORTE, descripcion: 'A', cantidad: 1, precio_base_unitario: 10 },
      { empresa_destino_id: EMPRESA_SUR, descripcion: 'B', cantidad: 1, precio_base_unitario: 10 },
    ],
  });
  assert.equal(r.status, 403);
  assert.equal(db.listar(tables.refacturaciones).length, 2);
});

test('emitir desde la sede a la sociedad propia: OK aunque la sede no esté en sus locales', async () => {
  const r = await api('POST', '/api/refacturacion/emitir', {
    emisor_id: EMPRESA_CENTRAL,
    empresa_destino_id: EMPRESA_NORTE,
    serie: 'REF',
    lineas_ids: ['L-NORTE'],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.factura.emisor_id, EMPRESA_CENTRAL);
  assert.equal(lineasDe(EMPRESA_NORTE)[0].estado, 'refacturada');
});

test('emitir a otra sociedad o desde una sociedad ajena que no es sede: 403 sin factura', async () => {
  const aSur = await api('POST', '/api/refacturacion/emitir', {
    emisor_id: EMPRESA_CENTRAL,
    empresa_destino_id: EMPRESA_SUR,
    serie: 'REF',
    lineas_ids: ['L-SUR'],
  });
  assert.equal(aSur.status, 403);
  const desdeSur = await api('POST', '/api/refacturacion/emitir', {
    emisor_id: EMPRESA_SUR,
    empresa_destino_id: EMPRESA_NORTE,
    serie: 'REF',
    lineas_ids: ['L-NORTE'],
  });
  assert.equal(desdeSur.status, 403);
  assert.equal(db.listar(tables.facturas).length, 0);
  assert.equal(lineasDe(EMPRESA_SUR)[0].estado, 'pendiente');
  assert.equal(lineasDe(EMPRESA_NORTE)[0].estado, 'pendiente');
});

test('GET en modo observar: devuelve todas las líneas y avisa', async () => {
  const todas = await api('GET', '/api/refacturacion/lineas');
  assert.deepEqual(todas.body.lineas.map((l) => l.id_linea).sort(), ['L-NORTE', 'L-SUR']);
  const sur = await api('GET', `/api/refacturacion/lineas?empresa_destino_id=${EMPRESA_SUR}`);
  assert.deepEqual(sur.body.lineas.map((l) => l.id_linea), ['L-SUR']);
  assert.deepEqual(avisos, [
    { ruta: '/api/refacturacion/lineas', usuario: 'u-norte', empresa: EMPRESA_SUR },
    { ruta: '/api/refacturacion/lineas', usuario: 'u-norte', empresa: EMPRESA_SUR },
  ]);
});

test('GET en modo bloquear: solo las líneas de sus sociedades', async () => {
  process.env.ALCANCE_MODO_LECTURAS = 'bloquear';
  const todas = await api('GET', '/api/refacturacion/lineas');
  assert.deepEqual(todas.body.lineas.map((l) => l.id_linea), ['L-NORTE']);
  const sur = await api('GET', `/api/refacturacion/lineas?empresa_destino_id=${EMPRESA_SUR}`);
  assert.deepEqual(sur.body.lineas, []);
  assert.equal(avisos.length, 0);
});
