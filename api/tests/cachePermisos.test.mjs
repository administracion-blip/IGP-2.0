/**
 * Caché de permisos por rol (`api/lib/permisos/cachePermisos.js`).
 *
 * `hasPermission` corre en casi todas las peticiones: tiene que leer el rol una
 * vez, respetar los alias y no quedarse con datos viejos tras una invalidación,
 * una caducidad o un error.
 */

import test, { beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-cache-permisos';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { hasPermission, hasAnyPermission } = await import('../middleware/auth.js');
const {
  invalidarPermisosRol,
  fijarRelojCachePermisos,
  permisosRolCacheados,
  tienePermisoRol,
} = await import('../lib/permisos/cachePermisos.js');

const LOCAL = { sub: '000009', rol: 'Local' };
const MARKETING = { sub: '000010', rol: 'Marketing' };
const ADMIN = { sub: '000001', rol: 'Administrador' };

const enviarOriginal = docClient.send;
/** rol → códigos. Se lee a través de `send` sin pasar por el doble, que invalida al escribir. */
let permisos;
let consultas;
let ultimaConsulta;
let fallarSiguiente;

function stub() {
  docClient.send = async (cmd) => {
    assert.equal(cmd?.constructor?.name, 'QueryCommand');
    assert.equal(cmd.input.TableName, tables.rolesPermisos);
    consultas.push(cmd.input.ExpressionAttributeValues[':pk']);
    ultimaConsulta = cmd.input;
    if (fallarSiguiente) {
      fallarSiguiente = false;
      throw new Error('DynamoDB caído');
    }
    const rol = cmd.input.ExpressionAttributeValues[':pk'].replace(/^ROL#/, '');
    return { Items: [...(permisos.get(rol) || [])].map((c) => ({ SK: `PERMISO#${c}` })) };
  };
}

beforeEach(() => {
  permisos = new Map([
    ['Local', new Set(['cajas.ver', 'pedidos.ver'])],
    ['Marketing', new Set(['rrss.ver'])],
  ]);
  consultas = [];
  fallarSiguiente = false;
  invalidarPermisosRol();
  fijarRelojCachePermisos();
  stub();
});

afterEach(() => {
  docClient.send = enviarOriginal;
  fijarRelojCachePermisos();
  invalidarPermisosRol();
});

test('una sola Query por rol aunque se pregunten varios permisos', async () => {
  assert.equal(await hasPermission(LOCAL, 'cajas.ver'), true);
  assert.equal(await hasPermission(LOCAL, 'pedidos.ver'), true);
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), false);
  assert.deepEqual(consultas, ['ROL#Local']);
});

test('cargas concurrentes del mismo rol comparten la Query', async () => {
  const r = await Promise.all([
    hasPermission(LOCAL, 'cajas.ver'),
    hasPermission(LOCAL, 'pedidos.ver'),
    tienePermisoRol('Local', 'compras.ver'),
  ]);
  assert.deepEqual(r, [true, true, false]);
  assert.equal(consultas.length, 1);
});

test('los alias conceden el código canónico', async () => {
  assert.equal(await hasPermission(MARKETING, 'marketing.proponer'), true);
  assert.equal(await hasPermission(MARKETING, 'marketing.gestionar'), false);
});

test('Administrador siempre true sin consultar; usuario nulo false', async () => {
  assert.equal(await hasPermission(ADMIN, 'lo.que.sea'), true);
  assert.equal(await hasAnyPermission(ADMIN, 'lo.que.sea'), true);
  assert.equal(await hasPermission(null, 'cajas.ver'), false);
  assert.equal(await hasAnyPermission(null, 'cajas.ver'), false);
  assert.equal(consultas.length, 0);
});

test('hasAnyPermission carga el rol una vez y comprueba todos', async () => {
  assert.equal(await hasAnyPermission(LOCAL, 'facturacion.ver', 'compras.ver', 'pedidos.ver'), true);
  assert.equal(await hasAnyPermission(LOCAL, 'facturacion.ver', 'compras.ver'), false);
  assert.equal(await hasAnyPermission(MARKETING, 'facturacion.ver', 'marketing.proponer'), true);
  assert.equal(await hasAnyPermission(LOCAL), false);
  assert.deepEqual(consultas, ['ROL#Local', 'ROL#Marketing']);
});

test('invalidarPermisosRol hace visible un permiso nuevo', async () => {
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), false);
  permisos.get('Local').add('facturacion.ver');
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), false, 'sigue cacheado');

  invalidarPermisosRol('Marketing');
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), false, 'invalidar otro rol no afecta');

  invalidarPermisosRol('Local');
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), true);
  assert.equal(consultas.length, 2);
});

test('una carga en vuelo durante una invalidación no se cachea', async () => {
  const enVuelo = hasPermission(LOCAL, 'facturacion.ver');
  permisos.get('Local').add('facturacion.ver');
  invalidarPermisosRol('Local');
  await enVuelo;
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), true);
});

test('pasado el TTL se recarga', async () => {
  let ahora = 1_000_000;
  fijarRelojCachePermisos(() => ahora);
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), false);
  permisos.get('Local').add('facturacion.ver');

  ahora += 59_000;
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), false);
  ahora += 2_000;
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), true);
  assert.equal(consultas.length, 2);
});

test('un error en la Query se propaga y no queda cacheado', async () => {
  fallarSiguiente = true;
  await assert.rejects(hasPermission(LOCAL, 'cajas.ver'), /DynamoDB caído/);
  assert.equal(await hasPermission(LOCAL, 'cajas.ver'), true);
  assert.equal(consultas.length, 2);
});

test('el conjunto cacheado no se puede mutar y la Query es consistente', async () => {
  const codigos = await permisosRolCacheados('Local');
  assert.throws(() => codigos.add('facturacion.ver'), /inmutables/);
  assert.throws(() => codigos.delete('cajas.ver'), /inmutables/);
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), false);
  assert.equal(await hasPermission(LOCAL, 'cajas.ver'), true);
  assert.equal(ultimaConsulta.ConsistentRead, true);
});

test('el doble en memoria vacía la caché al sembrar la tabla de permisos', async () => {
  docClient.send = enviarOriginal;
  const db = crearDynamoMemoria({ paginaTam: 1 });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#cajas.ver' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'META', nombre: 'Local' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#pedidos.ver' });

  assert.equal(await hasPermission(LOCAL, 'pedidos.ver'), true, 'pagina hasta el final');
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), false);
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#facturacion.ver' });
  assert.equal(await hasPermission(LOCAL, 'facturacion.ver'), true);
});
