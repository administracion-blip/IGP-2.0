/**
 * `GET /usuarios`: el Scan pagina hasta el final y solo lee los atributos que se
 * devuelven. `Password` no viaja ni en la respuesta ni en la lectura.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-listado-usuarios';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { default: usuariosRouter } = await import('../routes/usuarios.js');

const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };

let servidor = null;
let base = '';

async function api(metodo, ruta) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = ADMIN;
      next();
    });
    app.use('/api', usuariosRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, { method: metodo });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function montar() {
  const db = crearDynamoMemoria({ paginaTam: 2 });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.instalar(docClient);
  db.sembrar(tables.usuarios, {
    id_usuario: '000001', Nombre: 'Jefe', Apellidos: 'Grupo', Email: 'jefe@grupo.test',
    Password: 'hash-admin', Telefono: '600', Rol: 'Administrador', Local: [], tokenVersion: 3,
  });
  db.sembrar(tables.usuarios, {
    id_usuario: '000002', Nombre: 'Ana', Email: 'ana@grupo.test', Password: 'hash-ana',
    Rol: 'Local', Local: 'Bar Norte', Departamentos: ['mkt', 'mkt', ''],
  });
  db.sembrar(tables.usuarios, {
    id_usuario: '000003', Email: 'bea@grupo.test', Password: 'hash-bea', Rol: 'Local',
    Local: [' Bar Sur ', ''], Departamentos: [],
  });
  db.sembrar(tables.usuarios, { id_usuario: '000004', Email: 'sin@grupo.test', Password: 'hash' });
  db.sembrar(tables.usuarios, { id_usuario: '000005', Email: 'ultimo@grupo.test', Password: 'hash', Rol: 'Local' });
  return db;
}

test('GET /usuarios recorre todas las páginas del Scan y no devuelve Password', async () => {
  const db = montar();
  const scans = [];
  const enviar = docClient.send;
  docClient.send = async (cmd) => {
    if (cmd?.constructor?.name === 'ScanCommand') scans.push(cmd.input);
    return enviar(cmd);
  };
  const r = await api('GET', '/api/usuarios');
  assert.equal(r.status, 200);
  // 5 usuarios con páginas de 2 → 3 lecturas encadenadas por LastEvaluatedKey.
  assert.equal(scans.length, 3);
  assert.equal(scans[0].ExclusiveStartKey, undefined);
  assert.ok(scans[1].ExclusiveStartKey && scans[2].ExclusiveStartKey);
  assert.deepEqual(r.body.usuarios.map((u) => u.id_usuario), ['000001', '000002', '000003', '000004', '000005']);
  for (const u of r.body.usuarios) assert.equal(u.Password, undefined, u.id_usuario);
  assert.equal(db.operaciones.filter((o) => o.tipo === 'ScanCommand').length, 3);
});

test('GET /usuarios proyecta exactamente los atributos devueltos (Local va con alias)', async () => {
  montar();
  let entrada = null;
  const enviar = docClient.send;
  docClient.send = async (cmd) => {
    if (cmd?.constructor?.name === 'ScanCommand') entrada ??= cmd.input;
    return enviar(cmd);
  };
  await api('GET', '/api/usuarios');
  const proyectados = entrada.ProjectionExpression.split(',').map((p) => entrada.ExpressionAttributeNames[p.trim()]);
  assert.deepEqual(
    proyectados.sort(),
    ['Apellidos', 'Departamentos', 'Email', 'Local', 'Nombre', 'Rol', 'Telefono', 'id_usuario'].sort(),
  );
  assert.ok(!entrada.ProjectionExpression.split(',').some((p) => p.trim() === 'Local'), 'Local es palabra reservada');
});

test('GET /usuarios mantiene la forma de la respuesta: Local normalizado y Departamentos solo si existe', async () => {
  montar();
  const r = await api('GET', '/api/usuarios');
  assert.deepEqual(r.body.usuarios, [
    { id_usuario: '000001', Nombre: 'Jefe', Apellidos: 'Grupo', Email: 'jefe@grupo.test', Telefono: '600', Rol: 'Administrador', Local: [] },
    { id_usuario: '000002', Nombre: 'Ana', Email: 'ana@grupo.test', Rol: 'Local', Local: ['Bar Norte'], Departamentos: ['mkt'] },
    { id_usuario: '000003', Email: 'bea@grupo.test', Rol: 'Local', Local: ['Bar Sur'], Departamentos: [] },
    { id_usuario: '000004', Email: 'sin@grupo.test', Local: [] },
    { id_usuario: '000005', Email: 'ultimo@grupo.test', Rol: 'Local', Local: [] },
  ]);
});
