/**
 * Maestro igp_Productos: las escrituras exigen productos.editar, el alta sin
 * identificador ya no pisa el producto 000001 y del cuerpo solo se guardan los
 * campos del maestro (antes se copiaba cualquier clave que mandase el cliente).
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-del-maestro-productos';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { default: productosRouter } = await import('../routes/productos.js');

const ADMINISTRACION = { sub: '000002', email: 'admon@grupo.test', rol: 'Administracion' };
const ENCARGADO = { sub: '000009', email: 'encargado@grupo.test', rol: 'Local' };

let usuarioActual = ADMINISTRACION;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual) req.user = usuarioActual;
      next();
    });
    app.use('/api', productosRouter);
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

const ORIGINAL = { id_producto: '000001', nombre: 'Cerveza', referencia: 'CER', precio_venta: '2.5', tipo_iva: '10' };

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.productos, { hashKey: 'id_producto' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Administracion', SK: 'PERMISO#productos.editar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#productos.ver' });
  db.sembrar(tables.productos, ORIGINAL);
  return db;
}

test('sin productos.editar no se crea, edita ni borra un producto', async () => {
  const db = montar();
  assert.equal((await api('POST', '/api/productos', { id_producto: '2', nombre: 'X' }, ENCARGADO)).status, 403);
  assert.equal(db.obtener(tables.productos, { id_producto: '000002' }), null);
  assert.equal((await api('PUT', '/api/productos', { id_producto: '000001', nombre: 'Gratis', precio_venta: '0' }, ENCARGADO)).status, 403);
  assert.equal((await api('DELETE', '/api/productos', { id_producto: '000001' }, ENCARGADO)).status, 403);
  assert.deepEqual(db.obtener(tables.productos, { id_producto: '000001' }), ORIGINAL);
  assert.equal((await api('GET', '/api/productos', undefined, ENCARGADO)).status, 200);
});

test('un alta sin id_producto responde 400 y no toca el producto 000001', async () => {
  const db = montar();
  const r = await api('POST', '/api/productos', { nombre: 'Pisador', precio_venta: '0' }, ADMINISTRACION);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /id_producto/);
  assert.deepEqual(db.obtener(tables.productos, { id_producto: '000001' }), ORIGINAL);
});

test('un alta con un id ya existente responde 409 sin pisarlo', async () => {
  const db = montar();
  const r = await api('POST', '/api/productos', { id_producto: '1', nombre: 'Pisador', precio_venta: '0' }, ADMINISTRACION);
  assert.equal(r.status, 409);
  assert.deepEqual(db.obtener(tables.productos, { id_producto: '000001' }), ORIGINAL);
});

test('las claves fuera del maestro no se guardan en el alta ni en la edición', async () => {
  const db = montar();
  const alta = await api('POST', '/api/productos', {
    id_producto: '2', nombre: 'Vino', precio_venta: 4, tipo_iva: 21, Rol: 'Administrador', __proto__x: 'x',
  }, ADMINISTRACION);
  assert.equal(alta.status, 200);
  assert.deepEqual(db.obtener(tables.productos, { id_producto: '000002' }), {
    id_producto: '000002', nombre: 'Vino', precio_venta: '4', tipo_iva: '21',
  });

  const edicion = await api('PUT', '/api/productos', {
    id_producto: '000001', nombre: 'Cerveza', precio_venta: '3', coste_oculto: '0',
  }, ADMINISTRACION);
  assert.equal(edicion.status, 200);
  assert.deepEqual(db.obtener(tables.productos, { id_producto: '000001' }), { ...ORIGINAL, precio_venta: '3' });
});

test('editar un producto inexistente responde 404 y no lo crea', async () => {
  const db = montar();
  const r = await api('PUT', '/api/productos', { id_producto: '000099', nombre: 'Nuevo' }, ADMINISTRACION);
  assert.equal(r.status, 404);
  assert.equal(db.obtener(tables.productos, { id_producto: '000099' }), null);
});

test('con productos.editar se borra un producto', async () => {
  const db = montar();
  assert.equal((await api('DELETE', '/api/productos', { id_producto: '000001' }, ADMINISTRACION)).status, 200);
  assert.equal(db.obtener(tables.productos, { id_producto: '000001' }), null);
});
