/**
 * Fotos dobles del conteo: como máximo 6, a S3, y un importado no las admite.
 * S3 va simulado. No llama a Ágora.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-inventario';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { configurarAlmacenAdjuntos } = await import('../lib/tasks/adjuntos.js');
const { prepararFoto, confirmarFoto, listarFotos, borrarFoto } = await import('../lib/inventarios/fotos.js');
const { default: inventariosRouter } = await import('../routes/inventarios.js');

const CONTADOR = { sub: '000020', email: 'contador@test', rol: 'Contador' };
const NADIE = { sub: '000099', email: 'nadie@test', rol: 'Nadie' };

let servidor = null;
let base = '';
let usuarioActual = CONTADOR;
let db = null;
let bucket = null;
let restaurar = null;

async function api(metodo, ruta, cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      req.log = { info() {}, error() {}, warn() {} };
      next();
    });
    app.use('/api', inventariosRouter);
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

function sembrarInventario(estado = 'borrador') {
  db.sembrar(tables.inventarios, {
    PK: 'INV#inv1',
    SK: 'META',
    WarehouseId: '000001',
    Clave: 'INV#2026-10-26#inv1',
    inventarioId: 'inv1',
    fecha: '2026-10-26',
    employeeId: '42',
    employeeNombre: 'Ana',
    plantillaId: 'p1',
    plantillaNombre: 'Botellas',
    estado,
    creadoEn: '2026-10-26T10:00:00.000Z',
    actualizadoEn: '2026-10-26T10:00:00.000Z',
  });
}

after(() => {
  restaurar?.();
  servidor?.closeAllConnections?.();
  servidor?.close();
});

beforeEach(() => {
  usuarioActual = CONTADOR;
  db = crearDynamoMemoria();
  bucket = new Map();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.inventarios, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'WarehouseId-Clave-index': { hashKey: 'WarehouseId', rangeKey: 'Clave' } },
  });
  db.instalar(docClient);
  db.sembrar(tables.usuarios, { id_usuario: CONTADOR.sub, Rol: 'Contador', Locales: [], Email: CONTADOR.email });
  db.sembrar(tables.usuarios, { id_usuario: NADIE.sub, Rol: 'Nadie', Locales: [], Email: NADIE.email });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Contador', SK: 'PERMISO#inventario.contar' });
  invalidarContextoAcceso();
  restaurar?.();
  restaurar = configurarAlmacenAdjuntos({
    urlSubida: async ({ key }) => `https://bucket.test/${key}?firma=subida`,
    urlLectura: async ({ key }) => `https://bucket.test/${key}?firma=lectura`,
    cabecera: async ({ key }) => bucket.get(key) || null,
    borrar: async ({ key }) => { bucket.delete(key); },
  });
  sembrarInventario();
});

test('sin permiso no se prepara una foto', async () => {
  usuarioActual = NADIE;
  const res = await api('POST', '/api/inventarios/inv1/fotos/preparar', {
    numero: 1, posicion: 'frente', nombre: 'frente.jpg', contentType: 'image/jpeg', tamano: 1000,
  });
  assert.equal(res.status, 403);
});

test('la foto se prepara bajo inventarios/<id>/fotos/<n>/ y se confirma al estar en S3', async () => {
  const preparada = await prepararFoto({
    inventarioId: 'inv1',
    numero: 1,
    posicion: 'frente',
    nombre: 'frente.jpg',
    contentType: 'image/jpeg',
    tamano: 1200,
  });
  assert.equal(preparada.numero, 1);
  assert.equal(preparada.posicion, 'frente');
  assert.ok(preparada.s3Key.startsWith('inventarios/inv1/fotos/1/frente-'));
  assert.ok(preparada.uploadUrl.includes(preparada.s3Key));

  await assert.rejects(
    () => confirmarFoto({ inventarioId: 'inv1', numero: 1, posicion: 'frente', s3Key: preparada.s3Key }, 'contador@test'),
    (err) => err.status === 409,
  );

  bucket.set(preparada.s3Key, { tamano: 900, contentType: 'image/jpeg' });
  const confirmada = await confirmarFoto({
    inventarioId: 'inv1', numero: 1, posicion: 'frente', s3Key: preparada.s3Key,
  }, 'contador@test');
  assert.equal(confirmada.tamano, 900);
  assert.equal(confirmada.stockTeorico, undefined);

  const lista = await listarFotos('inv1');
  assert.equal(lista.length, 1);
  assert.equal(lista[0].url.includes('firma=lectura'), true);
  assert.equal(lista[0].stockTeorico, undefined);
  assert.equal(db.operaciones.some((op) => op.tipo === 'ScanCommand' && op.tabla === tables.inventarios), false);

  const ajena = await assert.rejects(
    () => confirmarFoto({
      inventarioId: 'inv1', numero: 1, posicion: 'superior', s3Key: 'inventarios/otro/fotos/1/superior-x.jpg',
    }, 'contador@test'),
    (err) => err.status === 400,
  );
  assert.equal(ajena, undefined);
});

test('como máximo 6 fotos y un importado no admite ni borrar', async () => {
  for (let n = 1; n <= 6; n += 1) {
    const preparada = await prepararFoto({
      inventarioId: 'inv1', numero: n, posicion: 'frente',
      nombre: 'frente.jpg', contentType: 'image/jpeg', tamano: 500,
    });
    bucket.set(preparada.s3Key, { tamano: 500, contentType: 'image/jpeg' });
    await confirmarFoto({
      inventarioId: 'inv1', numero: n, posicion: 'frente', s3Key: preparada.s3Key,
    }, 'contador@test');
  }
  await assert.rejects(
    () => prepararFoto({
      inventarioId: 'inv1', numero: 7, posicion: 'frente',
      nombre: 'frente.jpg', contentType: 'image/jpeg', tamano: 500,
    }),
    (err) => err.status === 400,
  );

  await borrarFoto({ inventarioId: 'inv1', numero: 6, posicion: 'frente' });
  assert.equal((await listarFotos('inv1')).some((f) => f.numero === 6), false);

  sembrarInventario('importado');
  await assert.rejects(
    () => prepararFoto({
      inventarioId: 'inv1', numero: 6, posicion: 'frente',
      nombre: 'frente.jpg', contentType: 'image/jpeg', tamano: 500,
    }),
    (err) => err.status === 409 && err.message === 'El inventario importado no admite fotos',
  );
  await assert.rejects(
    () => borrarFoto({ inventarioId: 'inv1', numero: 1, posicion: 'frente' }),
    (err) => err.status === 409,
  );
});
