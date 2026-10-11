/**
 * Datos de empleados que salen por `/api/personal/*`.
 *
 * El listado lo usan pantallas sin permiso de Personal (selector de empleado en
 * limpieza, entrega de activos), así que sigue abierto a cualquier autenticado,
 * pero solo con lo necesario para elegir al empleado. Contacto y DNI exigen
 * `personal.ver` o `cashflow.registrar`; Seguridad Social, nacimiento, dirección
 * y demás datos personales de Factorial no salen nunca.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-personal';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { default: personalRouter } = await import('../routes/personal.js');
const { default: cuadranteRouter } = await import('../routes/cuadrante.js');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');

const CAMARERO = { sub: '000009', email: 'camarero@grupo.test', rol: 'Camarero' };
const ENCARGADO = { sub: '000010', email: 'local@grupo.test', rol: 'Local' };
const TESORERA = { sub: '000011', email: 'tesoreria@grupo.test', rol: 'Tesoreria' };
const RRHH = { sub: '000012', email: 'rrhh@grupo.test', rol: 'Administracion' };

const NUNCA = [
  'social_security_number',
  'birthday_on',
  'address_line_1',
  'address_line_2',
  'postal_code',
  'city',
  'state',
  'country',
  'nationality',
  'gender',
  'termination_reason',
  'login_email',
  'raw_factorial_json',
];
const CONTACTO = ['email', 'phone_number', 'identifier', 'identifier_type'];

let usuarioActual = CAMARERO;
let servidor = null;
let base = '';

async function api(metodo, ruta, usuario) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      req.log = { info() {}, error() {} };
      next();
    });
    app.use('/api', personalRouter);
    app.use('/api', cuadranteRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json' } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.empleados, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.instalar(docClient);
  db.sembrar(tables.locales, { id_Locales: '000001', nombre: 'Local A', agoraCode: '101' });
  db.sembrar(tables.locales, { id_Locales: '000002', nombre: 'Local B', agoraCode: '202' });
  db.sembrar(tables.usuarios, { id_usuario: '000010', Email: 'local@grupo.test', Rol: 'Local', Local: ['Local A'] });
  db.sembrar(tables.usuarios, { id_usuario: '000012', Email: 'rrhh@grupo.test', Rol: 'Administracion', Local: ['Local A'] });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#personal.ver' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#planning_dia.ver' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Tesoreria', SK: 'PERMISO#cashflow.registrar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Administracion', SK: 'PERMISO#rrhh.horas' });
  db.sembrar(tables.empleados, {
    PK: 'EMPLOYEE#77',
    SK: 'METADATA',
    employee_id: '77',
    source: 'factorial',
    first_name: 'Ana',
    last_name: 'Ruiz',
    full_name: 'Ana Ruiz',
    location_id: 5,
    company_id: 1,
    start_date: '2024-01-01',
    active: true,
    synced_at: '2026-10-01T00:00:00.000Z',
    email: 'ana@personal.test',
    login_email: 'ana.login@personal.test',
    phone_number: '600000000',
    identifier: '12345678Z',
    identifier_type: 'dni',
    social_security_number: '281234567890',
    birthday_on: '1990-05-05',
    address_line_1: 'Calle Falsa 123',
    address_line_2: '2ºB',
    postal_code: '28001',
    city: 'Madrid',
    state: 'Madrid',
    country: 'es',
    nationality: 'es',
    gender: 'female',
    termination_reason: 'n/a',
    raw_factorial_json: '{"secreto":true}',
  });
  return db;
}

function sinCampos(empleado, campos) {
  for (const campo of campos) assert.equal(empleado[campo], undefined, `${campo} no debe salir`);
}

test('sin permisos: la lista solo trae lo necesario para elegir al empleado', async () => {
  montar();
  const r = await api('GET', '/api/personal/employees', CAMARERO);
  assert.equal(r.status, 200);
  const [ana] = r.body.employees;
  assert.equal(ana.employee_id, '77');
  assert.equal(ana.full_name, 'Ana Ruiz');
  assert.equal(ana.active, true);
  sinCampos(ana, [...CONTACTO, ...NUNCA]);

  const detalle = await api('GET', '/api/personal/employees/77', CAMARERO);
  assert.equal(detalle.status, 200);
  sinCampos(detalle.body.employee, [...CONTACTO, ...NUNCA]);
});

for (const [nombre, usuario] of [['personal.ver', ENCARGADO], ['cashflow.registrar', TESORERA]]) {
  test(`con ${nombre}: contacto y DNI, pero nunca SS, nacimiento ni dirección`, async () => {
    montar();
    const r = await api('GET', '/api/personal/employees', usuario);
    const [ana] = r.body.employees;
    assert.equal(ana.email, 'ana@personal.test');
    assert.equal(ana.phone_number, '600000000');
    assert.equal(ana.identifier, '12345678Z');
    assert.equal(ana.identifier_type, 'dni');
    sinCampos(ana, NUNCA);

    const detalle = await api('GET', '/api/personal/employees/77', usuario);
    assert.equal(detalle.body.employee.identifier, '12345678Z');
    sinCampos(detalle.body.employee, NUNCA);
  });
}

test('sin permiso no se lanza la sincronización con Factorial', async () => {
  montar();
  const r = await api('POST', '/api/personal/employees/sync', CAMARERO);
  assert.equal(r.status, 403);
});

test('sin permiso no se lee el cuadrante (costes salariales)', async () => {
  montar();
  const r = await api('GET', '/api/personal/cuadrante?local_ids=000001&from=2026-10-01&to=2026-10-07', CAMARERO);
  assert.equal(r.status, 403);
});

test('con planning_dia.ver o rrhh.horas se pasa al cuadrante', async () => {
  montar();
  for (const usuario of [ENCARGADO, RRHH]) {
    const r = await api('GET', '/api/personal/cuadrante', usuario);
    assert.equal(r.status, 400, 'pasa el permiso y llega a la validación de parámetros');
  }
});

// Ningún local de prueba tiene factorial_location_id: el servicio responde 400
// nombrando el primer local que procesa, sin llamar a Factorial.
test('cuadrante: Local con A pide B,A y solo se procesa A', async () => {
  montar();
  const r = await api('GET', '/api/personal/cuadrante?local_ids=000002,000001&from=2026-10-01&to=2026-10-07', ENCARGADO);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Local A/);
  const repetido = await api('GET', '/api/personal/cuadrante?local_ids=000001&local_id=000002&from=2026-10-01&to=2026-10-07', ENCARGADO);
  assert.match(repetido.body.error, /Local A/);
});

test('cuadrante: solo locales ajenos, 403 (también con rrhh.horas)', async () => {
  montar();
  for (const usuario of [ENCARGADO, RRHH]) {
    const r = await api('GET', '/api/personal/cuadrante?local_ids=000002&from=2026-10-01&to=2026-10-07', usuario);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'No tienes acceso a este local');
  }
});
