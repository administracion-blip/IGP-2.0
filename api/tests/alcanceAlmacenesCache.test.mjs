/**
 * El mapa local ↔ almacén que decide el alcance por almacén se cachea 60 s: dos
 * peticiones seguidas no vuelven a escanear igp_Locales ni igp_Almacenes. Crear,
 * editar o borrar un almacén (o un local) lo invalida en el acto.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-cache-almacenes';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: miaRouter } = await import('../routes/mia.js');
const { default: almacenesRouter } = await import('../routes/almacenes.js');

const COMPRADOR = { sub: '000080', email: 'compras@grupo.test', rol: 'SuperUser' };

let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = COMPRADOR;
      req.log = { info() {}, error() {}, warn() {} };
      next();
    });
    app.use('/api', miaRouter);
    app.use('/api', almacenesRouter);
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

let db = null;

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaConfigProducto, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const p of ['mia.configurar', 'almacenes.crear', 'almacenes.editar', 'almacenes.borrar']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#SuperUser', SK: `PERMISO#${p}` });
  }
  db.sembrar(tables.almacenes, { Id: '000101', Nombre: 'Almacen Centro' });
  // «Almacen Nuevo» todavía no existe en el maestro.
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro, Almacen Nuevo' });
  db.sembrar(tables.usuarios, { id_usuario: '000080', Email: COMPRADOR.email, Rol: 'SuperUser', Local: ['Bar Centro'] });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
}

const escaneos = (tabla) => db.operaciones.filter((o) => o.tipo === 'ScanCommand' && o.tabla === tabla).length;
const config = (warehouseId) => api('PUT', '/api/mia/config', { warehouseId, productId: 'P1', colchon: 1 });

test('dos peticiones seguidas no repiten el Scan del mapa local ↔ almacén', async () => {
  montar();
  assert.equal((await config('101')).status, 200);
  const almacenes = escaneos(tables.almacenes);
  const locales = escaneos(tables.locales);
  assert.equal(almacenes, 1);
  assert.equal((await config('101')).status, 200);
  assert.equal(escaneos(tables.almacenes), almacenes);
  assert.equal(escaneos(tables.locales), locales);
});

test('crear un almacén invalida el mapa: el nuevo almacén de su local se permite en el acto', async () => {
  montar();
  assert.equal((await config('303')).status, 403);
  assert.equal((await api('POST', '/api/almacenes', { Id: '303', Nombre: 'Almacen Nuevo' })).status, 200);
  assert.equal((await config('303')).status, 200);
});

test('borrar un almacén invalida el mapa: deja de permitirse', async () => {
  montar();
  assert.equal((await config('101')).status, 200);
  assert.equal((await api('DELETE', '/api/almacenes?Id=000101')).status, 200);
  assert.equal((await config('101')).status, 403);
});

test('cambiar un local (invalidarMaestroLocales) también invalida el mapa', async () => {
  montar();
  assert.equal((await config('101')).status, 200);
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': '' });
  invalidarMaestroLocales();
  assert.equal((await config('101')).status, 403);
});
