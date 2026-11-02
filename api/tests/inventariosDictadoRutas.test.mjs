/**
 * Rutas del dictado por voz del conteo (fase 4): interpretar, editar, aplicar (idempotente),
 * sesión, formatos y alias. Dynamo en memoria; el teórico de Ágora se simula (solo lectura).
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import ExcelJS from 'exceljs';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-inventario';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { crearPlantilla } = await import('../lib/inventarios/plantillas.js');
const { crearInventario, cambiarEstado, obtenerInventario } = await import('../lib/inventarios/inventarios.js');
const { bufferInventario } = await import('../lib/inventarios/excel.js');
const sesion = await import('../lib/inventarios/dictado/sesion.js');
const { crearRouterDictado } = await import('../routes/inventariosDictado.js');
const { default: inventariosRouter } = await import('../routes/inventarios.js');

const CONTADOR = { sub: '000020', email: 'contador@test', rol: 'Contador', Nombre: 'Ana' };
const CONTADOR2 = { sub: '000023', email: 'luis@test', rol: 'Contador', Nombre: 'Luis' };
const COMPRAS = { sub: '000021', email: 'compras@test', rol: 'Compras' };
const NADIE = { sub: '000024', email: 'nadie@test', rol: 'Nadie' };
const AJENO = { sub: '000025', email: 'ajeno@test', rol: 'Contador' };

const T = () => tables.inventarios;

let servidor = null;
let base = '';
let usuarioActual = CONTADOR;
let db = null;
let plantilla = null;
let llamadasStock = [];
let stockFalla = false;
/** Todo lo que ha recibido alguien que solo cuenta. */
const respuestasContar = [];

async function api(metodo, ruta, cuerpo, usuario = usuarioActual) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual) req.user = usuarioActual;
      req.log = { info() {}, error() {}, warn() {} };
      next();
    });
    app.use('/api', crearRouterDictado({
      exportStocks: async (opts) => {
        llamadasStock.push(opts);
        if (stockFalla) throw new Error('token secreto de Ágora');
        return [{ ProductId: 400, Quantity: 9 }];
      },
    }));
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
  const r = { status: res.status, body: await res.json().catch(() => ({})) };
  if (usuario?.rol === 'Contador') respuestasContar.push({ ruta, body: r.body });
  return r;
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

beforeEach(async () => {
  usuarioActual = CONTADOR;
  llamadasStock = [];
  stockFalla = false;
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(T(), {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'WarehouseId-Clave-index': { hashKey: 'WarehouseId', rangeKey: 'Clave' } },
  });
  db.instalar(docClient);
  for (const u of [CONTADOR, CONTADOR2, COMPRAS, NADIE]) {
    db.sembrar(tables.usuarios, { id_usuario: u.sub, Rol: u.rol, Locales: [], Email: u.email });
  }
  db.sembrar(tables.usuarios, { id_usuario: AJENO.sub, Rol: AJENO.rol, Local: ['Bar Sur'], Email: AJENO.email });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Contador', SK: 'PERMISO#inventario.contar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Compras', SK: 'PERMISO#inventario.gestionar' });
  db.sembrar(tables.almacenes, { Id: '1', Nombre: 'Almacen Centro' });
  db.sembrar(tables.almacenes, { Id: '202', Nombre: 'Almacen Sur' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur', 'almacen origen': 'Almacen Sur' });
  const producto = (id, nombre, activo = true) => db.sembrar(tables.agoraProducts, {
    PK: 'GLOBAL', SK: id, Id: id, Name: nombre, FamilyId: '12', FamilyName: 'BOT', FormatoBaseNombre: 'Unidad', Active: activo,
  });
  producto('200', 'ROKU GIN 70CL');
  producto('1367', 'JOHNNIE WALKER');
  producto('300', 'LARIOS GIN');
  producto('400', 'COCA COLA 35CL');
  producto('50', 'BOMBAY SAPPHIRE', false);
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  plantilla = await crearPlantilla({
    nombre: 'Barra', modo: 'familias', miembros: [{ id: '12', nombre: 'BOT' }],
  }, 'compras@test');
});

function lineaInv(productId, nombre, stockTeorico, extra = {}) {
  return { productId, nombre, familiaNombre: 'BOT', unidad: 'Unidad', stockTeorico, ...extra };
}

async function nuevoInventario() {
  const inv = await crearInventario({
    warehouseId: '1',
    fecha: '2026-11-02',
    employeeId: '42',
    employeeNombre: 'Ana',
    plantillaId: plantilla.plantillaId,
    lineas: [
      lineaInv('200', 'ROKU GIN 70CL', 7),
      lineaInv('1367', 'JOHNNIE WALKER', 203, { stockReal: 0, botellasAbiertas: 0.5 }),
      lineaInv('300', 'LARIOS GIN', 4),
      lineaInv('50', 'BOMBAY SAPPHIRE', 2),
    ],
  }, 'compras@test');
  return inv.inventarioId;
}

const ruta = (id, resto = '') => `/api/inventarios/${id}/dictado${resto}`;
const dictar = (id, texto, usuario) => api('POST', ruta(id, '/interpretar'), { texto }, usuario);
const aplicar = (id, lineas, usuario) => api('POST', ruta(id, '/aplicar'), { lineas }, usuario);
const patch = (id, n, cuerpo, usuario) => api('PATCH', ruta(id, `/lineas/${n}`), cuerpo, usuario);

function lineaConteo(id, productId) {
  return db.obtener(T(), { PK: `INV#${id}`, SK: `LINE#${productId}` });
}

function clavesProhibidas(valor, ruta = '') {
  if (valor == null || typeof valor !== 'object') return [];
  return Object.entries(valor).flatMap(([k, v]) => [
    ...(k === 'stockTeorico' ? [`${ruta}${k}`] : []),
    ...clavesProhibidas(v, `${ruta}${k}.`),
  ]);
}

// ─── Permisos y alcance ───

test('401 sin usuario, 403 sin permiso y 403 con un almacén no permitido', async () => {
  const id = await nuevoInventario();
  assert.equal((await api('GET', ruta(id), undefined, null)).status, 401);

  for (const [m, r, c] of [
    ['GET', ruta(id)],
    ['POST', ruta(id, '/interpretar'), { texto: 'Roku 7' }],
    ['POST', ruta(id, '/aplicar'), { lineas: [1] }],
    ['GET', '/api/inventarios/dictado/formatos?productIds=200'],
    ['GET', '/api/inventarios/dictado/alias'],
  ]) {
    const res = await api(m, r, c, NADIE);
    assert.equal(res.status, 403, `${m} ${r}`);
  }

  for (const [m, r, c] of [
    ['GET', ruta(id)],
    ['POST', ruta(id, '/interpretar'), { texto: 'Roku 7' }],
    ['PATCH', ruta(id, '/lineas/1'), { estado: 'confirmada' }],
    ['POST', ruta(id, '/aplicar'), { lineas: [1] }],
    ['POST', ruta(id, '/pausar')],
  ]) {
    const res = await api(m, r, c, AJENO);
    assert.equal(res.status, 403, `${m} ${r}`);
    assert.equal(res.body.error, 'Sin acceso a este almacén');
  }
  assert.equal(db.listar(T()).some((it) => String(it.SK).startsWith('DICTADO#')), false);
});

// ─── Interpretar ───

test('interpretar crea líneas con producto, conteo actual y previsto; sin producto usa la última', async () => {
  const id = await nuevoInventario();
  const sinNada = await dictar(id, 'ahora son 10', CONTADOR);
  assert.equal(sinNada.status, 201);
  assert.equal(sinNada.body.lineas[0].productId, null);
  assert.equal(sinNada.body.lineas[0].confirmar, true);
  assert.ok(sinNada.body.lineas[0].motivos.includes('sin_producto'));
  assert.equal((await patch(id, 1, { estado: 'descartada' }, CONTADOR)).status, 200);

  const r = await dictar(id, 'Roku 7', CONTADOR);
  assert.equal(r.status, 201);
  assert.equal(r.body.sesion.estado, 'activa');
  const [l] = r.body.lineas;
  assert.equal(l.n, 2);
  assert.equal(l.productId, '200');
  assert.equal(l.productoNombre, 'ROKU GIN 70CL');
  assert.equal(l.modo, 'sumar');
  assert.equal(l.confirmar, false);
  assert.equal(l.estado, 'pendiente');
  assert.deepEqual(l.cantidad, { total: 7, stockReal: 7, botellasAbiertas: 0 });
  assert.deepEqual(l.conteoActual, { stockReal: null, botellasAbiertas: 0, contado: false });
  assert.deepEqual(l.previsto, { total: 7, stockReal: 7, botellasAbiertas: 0 });

  const ultima = await dictar(id, 'ahora son 10', CONTADOR);
  assert.equal(ultima.body.lineas[0].productId, '200');
  assert.equal(ultima.body.lineas[0].modo, 'reemplazar');

  const largo = await dictar(id, 'x'.repeat(2001), CONTADOR);
  assert.equal(largo.status, 400);

  const sesion = await api('GET', ruta(id), undefined, CONTADOR);
  assert.equal(sesion.status, 200);
  assert.deepEqual(sesion.body.lineas.map((x) => [x.n, x.estado]), [[1, 'descartada'], [2, 'pendiente'], [3, 'pendiente']]);
});

test('pausa y sigue cambian la sesión y no crean líneas; cerrar bloquea interpretar', async () => {
  const id = await nuevoInventario();
  const r = await dictar(id, 'Roku 1, pausa', CONTADOR);
  assert.equal(r.body.lineas.length, 1);
  assert.equal(r.body.sesion.estado, 'pausada');
  const s = await dictar(id, 'sigue', CONTADOR);
  assert.equal(s.status, 200);
  assert.equal(s.body.lineas.length, 0);
  assert.equal(s.body.sesion.estado, 'activa');
  assert.equal((await api('POST', ruta(id, '/pausar'), undefined, CONTADOR)).body.sesion.estado, 'pausada');
  assert.equal((await api('POST', ruta(id, '/reanudar'), undefined, CONTADOR)).body.sesion.estado, 'activa');
  assert.equal((await api('POST', ruta(id, '/cerrar'), undefined, CONTADOR)).body.sesion.estado, 'cerrada');
  assert.equal((await dictar(id, 'Roku 2', CONTADOR)).status, 409);
});

test('una línea dudosa no se aplica sin confirmar', async () => {
  const id = await nuevoInventario();
  const r = await dictar(id, 'Rokku 7', CONTADOR);
  const [l] = r.body.lineas;
  assert.equal(l.productId, '200');
  assert.equal(l.confirmar, true);
  assert.ok(l.motivos.includes('aproximado'));
  const a = await aplicar(id, [l.n], CONTADOR);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.aplicadas, []);
  assert.equal(a.body.rechazadas[0].motivo, 'requiere_confirmacion');
  assert.equal(lineaConteo(id, '200').stockReal, undefined);

  assert.equal((await patch(id, l.n, { estado: 'confirmada' }, CONTADOR)).status, 200);
  const b = await aplicar(id, [l.n], CONTADOR);
  assert.equal(b.body.aplicadas[0].stockReal, 7);
  assert.equal(lineaConteo(id, '200').stockReal, 7);
});

test('producto ya contado exige confirmar; suma con botella 0,50 + 0,75 = 1 + 0,25', async () => {
  const id = await nuevoInventario();
  const r = await dictar(id, 'Johnnie 0,75', CONTADOR);
  const [l] = r.body.lineas;
  assert.equal(l.productId, '1367');
  assert.equal(l.modo, 'sumar');
  assert.equal(l.confirmar, true);
  assert.ok(l.motivos.includes('ya_contado'));
  assert.deepEqual(l.conteoActual, { stockReal: 0, botellasAbiertas: 0.5, contado: true });
  assert.deepEqual(l.previsto, { total: 1.25, stockReal: 1, botellasAbiertas: 0.25 });

  assert.equal((await aplicar(id, [l.n], CONTADOR)).body.rechazadas[0].motivo, 'requiere_confirmacion');
  await patch(id, l.n, { estado: 'confirmada' }, CONTADOR);
  const a = await aplicar(id, [l.n], CONTADOR);
  assert.deepEqual(a.body.aplicadas.map((x) => [x.stockReal, x.botellasAbiertas, x.yaAplicada]), [[1, 0.25, false]]);
  const linea = lineaConteo(id, '1367');
  assert.equal(linea.stockReal, 1);
  assert.equal(linea.botellasAbiertas, 0.25);
  assert.equal(linea.stockTeorico, 203);
});

test('reemplazar y borrar', async () => {
  const id = await nuevoInventario();
  await dictar(id, 'Roku 7', CONTADOR);
  await aplicar(id, [1], CONTADOR);

  const r = await dictar(id, 'Roku ahora son 4', CONTADOR);
  assert.equal(r.body.lineas[0].modo, 'reemplazar');
  assert.ok(r.body.lineas[0].motivos.includes('ya_contado'));
  await patch(id, 2, { estado: 'confirmada' }, CONTADOR);
  await aplicar(id, [2], CONTADOR);
  assert.equal(lineaConteo(id, '200').stockReal, 4);

  const b = await dictar(id, 'borra Roku', CONTADOR);
  assert.equal(b.body.lineas[0].modo, 'borrar');
  assert.equal(b.body.lineas[0].confirmar, true);
  await patch(id, 3, { estado: 'confirmada' }, CONTADOR);
  const a = await aplicar(id, [3], CONTADOR);
  assert.deepEqual([a.body.aplicadas[0].stockReal, a.body.aplicadas[0].botellasAbiertas], [null, 0]);
  const linea = lineaConteo(id, '200');
  assert.equal(linea.stockReal, undefined);
  assert.equal(linea.botellasAbiertas, 0);
  const inv = await api('GET', `/api/inventarios/${id}`, undefined, CONTADOR);
  assert.equal(inv.body.lineas.find((x) => x.productId === '200').stockReal, null);
});

test('una suma que deja el total negativo se rechaza', async () => {
  const id = await nuevoInventario();
  const r = await dictar(id, 'quita 3 a Roku', CONTADOR);
  assert.ok(r.body.lineas[0].motivos.includes('total_negativo'));
  await patch(id, 1, { estado: 'confirmada' }, CONTADOR);
  assert.equal((await aplicar(id, [1], CONTADOR)).body.rechazadas[0].motivo, 'total_negativo');
  assert.equal(lineaConteo(id, '200').stockReal, undefined);
});

// ─── Idempotencia ───

test('idempotencia: dos veces seguidas, en paralelo y [n, n] suman una sola vez', async () => {
  const id = await nuevoInventario();
  const r = await dictar(id, 'Roku 3. Larios 2. Coca cola 4', CONTADOR);
  assert.deepEqual(r.body.lineas.map((l) => [l.n, l.productId, l.confirmar]), [[1, '200', false], [2, '300', false], [3, '400', false]]);
  assert.equal(r.body.lineas[2].enConteo, false);

  const a1 = await aplicar(id, [1], CONTADOR);
  const a2 = await aplicar(id, [1], CONTADOR);
  assert.equal(a1.body.aplicadas[0].yaAplicada, false);
  assert.equal(a2.status, 200);
  assert.equal(a2.body.aplicadas[0].yaAplicada, true);
  assert.equal(a2.body.aplicadas[0].stockReal, 3);
  assert.equal(lineaConteo(id, '200').stockReal, 3);

  const [p1, p2] = await Promise.all([aplicar(id, [2], CONTADOR), aplicar(id, [2], CONTADOR)]);
  assert.equal(p1.status, 200);
  assert.equal(p2.status, 200);
  assert.deepEqual([p1.body.aplicadas[0].yaAplicada, p2.body.aplicadas[0].yaAplicada].sort(), [false, true]);
  assert.equal(lineaConteo(id, '300').stockReal, 2);

  const doble = await aplicar(id, [3, 3], CONTADOR);
  assert.equal(doble.body.aplicadas.length, 1);
  assert.equal(lineaConteo(id, '400').stockReal, 4);
  assert.equal(lineaConteo(id, '400').stockTeorico, 9);
  assert.deepEqual(llamadasStock, [{ warehouseId: '000001' }]);
  const otra = await aplicar(id, [3], CONTADOR);
  assert.equal(otra.body.aplicadas[0].yaAplicada, true);
  assert.equal(lineaConteo(id, '400').stockReal, 4);

  const dictado = db.obtener(T(), { PK: `INV#${id}`, SK: 'DICTADO#000020#LINEA#000003' });
  assert.equal(dictado.estado, 'aplicada');
  assert.deepEqual([dictado.aplicado.stockReal, dictado.aplicado.botellasAbiertas], [4, 0]);
});

test('si otro cuenta el producto entre la lectura y la transacción, se rechaza ya_contado sin perder su escritura', async () => {
  const id = await nuevoInventario();
  await dictar(id, 'Roku 3', CONTADOR);
  let primera = true;
  // El gancho de PutCommand de LINE# simula que otro guarda la línea a mano justo antes.
  db.interceptar('PutCommand', T(), async () => {
    if (!primera) return;
    primera = false;
    const actual = db.obtener(T(), { PK: `INV#${id}`, SK: 'LINE#200' });
    db.sembrar(T(), { ...actual, stockReal: 10 });
  });
  const a = await aplicar(id, [1], CONTADOR);
  assert.deepEqual(a.body.aplicadas, []);
  assert.equal(a.body.rechazadas[0].motivo, 'ya_contado');
  assert.equal(lineaConteo(id, '200').stockReal, 10);

  await patch(id, 1, { estado: 'confirmada' }, CONTADOR);
  const b = await aplicar(id, [1], CONTADOR);
  assert.equal(b.body.aplicadas[0].stockReal, 13);
  assert.equal(lineaConteo(id, '200').stockReal, 13);
});

test('dentro de un dictado, la segunda orden del mismo producto pide confirmar y prevé sobre la primera', async () => {
  const id = await nuevoInventario();
  const r = await dictar(id, 'Roku 3, Roku 2', CONTADOR);
  const [l1, l2] = r.body.lineas;
  assert.equal(l1.confirmar, false);
  assert.equal(l2.confirmar, true);
  assert.ok(l2.motivos.includes('ya_contado'));
  assert.ok(l2.motivos.includes('repetido_en_dictado'));
  assert.deepEqual(l2.conteoActual, { stockReal: null, botellasAbiertas: 0, contado: false });
  assert.equal(l2.previsto.total, 5);

  const a = await aplicar(id, [1, 2], CONTADOR);
  assert.deepEqual(a.body.aplicadas.map((x) => [x.n, x.stockReal]), [[1, 3]]);
  assert.deepEqual(a.body.rechazadas.map((x) => [x.n, x.motivo]), [[2, 'requiere_confirmacion']]);
  await patch(id, 2, { estado: 'confirmada' }, CONTADOR);
  const b = await aplicar(id, [2], CONTADOR);
  assert.equal(b.body.aplicadas[0].stockReal, 5);
  assert.equal(lineaConteo(id, '200').stockReal, 5);

  // Una línea sin aplicar en la sesión también marca la siguiente del mismo producto.
  await dictar(id, 'Larios 1', CONTADOR);
  const c = await dictar(id, 'Larios 2', CONTADOR);
  assert.ok(c.body.lineas[0].motivos.includes('repetido_en_dictado'));
  assert.equal(c.body.lineas[0].confirmar, true);
});

test('interpretar con idEnvio crea las líneas una sola vez, también en paralelo', async () => {
  const id = await nuevoInventario();
  const a = await api('POST', ruta(id, '/interpretar'), { texto: 'Roku 3, Larios 2', idEnvio: 'grab-1' }, CONTADOR);
  const b = await api('POST', ruta(id, '/interpretar'), { texto: 'Roku 3, Larios 2', idEnvio: 'grab-1' }, CONTADOR);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.repetido, true);
  assert.deepEqual(b.body.lineas.map((l) => [l.n, l.productId, l.idEnvio]), [[1, '200', 'grab-1'], [2, '300', 'grab-1']]);

  const [p, q] = await Promise.all([
    api('POST', ruta(id, '/interpretar'), { texto: 'Coca cola 1', idEnvio: 'grab-2' }, CONTADOR),
    api('POST', ruta(id, '/interpretar'), { texto: 'Coca cola 1', idEnvio: 'grab-2' }, CONTADOR),
  ]);
  assert.deepEqual([p.status, q.status].sort(), [200, 201]);
  assert.deepEqual(p.body.lineas.map((l) => l.n), q.body.lineas.map((l) => l.n));
  const sesion = await api('GET', ruta(id), undefined, CONTADOR);
  assert.deepEqual(sesion.body.lineas.map((l) => l.n), [1, 2, 3]);

  const otro = await api('POST', ruta(id, '/interpretar'), { texto: 'Coca cola 1', idEnvio: 'grab-2' }, CONTADOR2);
  assert.equal(otro.status, 201, 'el idEnvio es por usuario');
  assert.equal((await api('POST', ruta(id, '/interpretar'), { texto: 'Roku 1', idEnvio: 'a#b' }, CONTADOR)).status, 400);
});

test('redondeo: 0,90 + 0,25 pide confirmar, el previsto ya dice 1,10 y confirmada guarda 1 + 0,10', async () => {
  const id = await nuevoInventario();
  await api('PUT', `/api/inventarios/${id}/lineas/1367`, { stockReal: 0, botellasAbiertas: 0.9 }, CONTADOR);
  const r = await dictar(id, 'Johnnie 0,25', CONTADOR);
  const [l] = r.body.lineas;
  assert.ok(l.motivos.includes('redondeo'));
  assert.equal(l.confirmar, true);
  assert.deepEqual(l.previsto, { total: 1.1, stockReal: 1, botellasAbiertas: 0.1 });
  assert.equal((await aplicar(id, [l.n], CONTADOR)).body.rechazadas[0].motivo, 'requiere_confirmacion');
  assert.equal(lineaConteo(id, '1367').botellasAbiertas, 0.9);
  await patch(id, l.n, { estado: 'confirmada' }, CONTADOR);
  const a = await aplicar(id, [l.n], CONTADOR);
  assert.deepEqual([a.body.aplicadas[0].stockReal, a.body.aplicadas[0].botellasAbiertas], [1, 0.1]);
  assert.deepEqual([lineaConteo(id, '1367').stockReal, lineaConteo(id, '1367').botellasAbiertas], [1, 0.1]);
});

test('redondeo en aplicar y en el PATCH de cantidad', async () => {
  const id = await nuevoInventario();
  // Línea pendiente sin confirmar cuyo total no cabe en las fracciones (no la crearía interpretar).
  const [creada] = await sesion.anadirLineas(id, CONTADOR.sub, [{
    texto: 'Larios 0,3', productId: '300', productoNombre: 'LARIOS GIN',
    cantidad: { total: 0.3, stockReal: 0, botellasAbiertas: 0.25 }, modo: 'sumar', motivos: [], confirmar: false,
  }], 'Ana');
  const a = await aplicar(id, [creada.n], CONTADOR);
  assert.equal(a.body.rechazadas[0].motivo, 'redondeo');
  assert.equal(lineaConteo(id, '300').stockReal, undefined);

  await dictar(id, 'Roku 1', CONTADOR);
  const conConfirmar = await patch(id, 2, { cantidad: 0.3, estado: 'confirmada' }, CONTADOR);
  assert.equal(conConfirmar.status, 400);
  assert.equal(conConfirmar.body.code, 'redondeo');
  const p = await patch(id, 2, { cantidad: 0.3 }, CONTADOR);
  assert.equal(p.status, 200);
  assert.equal(p.body.linea.confirmar, true);
  assert.ok(p.body.linea.motivos.includes('redondeo'));
  assert.deepEqual(p.body.previsto, { total: 0.25, stockReal: 0, botellasAbiertas: 0.25 });
});

test('errores de una línea no paran el lote: producto no añadible y Ágora caída', async () => {
  const id = await nuevoInventario();
  await dictar(id, 'Roku 3. Coca cola 4', COMPRAS);
  await cambiarEstado(id, 'contado', 'compras@test');
  await cambiarEstado(id, 'revisado', 'compras@test');
  const a = await aplicar(id, [1, 2], COMPRAS);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.aplicadas.map((x) => [x.n, x.stockReal]), [[1, 3]]);
  assert.deepEqual(a.body.rechazadas.map((x) => [x.n, x.motivo]), [[2, 'producto_no_anadible']]);
  assert.equal(lineaConteo(id, '400'), null);

  const otro = await nuevoInventario();
  await dictar(otro, 'Coca cola 4. Larios 2', CONTADOR);
  stockFalla = true;
  const b = await aplicar(otro, [1, 2], CONTADOR);
  stockFalla = false;
  assert.deepEqual(b.body.rechazadas.map((x) => [x.n, x.motivo]), [[1, 'agora_no_disponible']]);
  assert.deepEqual(b.body.aplicadas.map((x) => [x.n, x.stockReal]), [[2, 2]]);
  assert.equal(JSON.stringify(b.body).includes('token'), false);
  const c = await aplicar(otro, [1], CONTADOR);
  assert.equal(c.body.aplicadas[0].stockReal, 4);
});

test('borrar un producto que no está en el conteo se rechaza', async () => {
  const id = await nuevoInventario();
  const r = await dictar(id, 'borra Coca cola', CONTADOR);
  assert.equal(r.body.lineas[0].modo, 'borrar');
  const a = await aplicar(id, [1], CONTADOR);
  assert.equal(a.body.rechazadas[0].motivo, 'no_en_conteo');
  assert.equal(lineaConteo(id, '400'), null);
  assert.equal(db.obtener(T(), { PK: `INV#${id}`, SK: 'DICTADO#000020#LINEA#000001' }).estado, 'pendiente');
});

// ─── Alias ───

test('confirmar con producto activo aprende alias y luego suma uso; inactivo no aprende', async () => {
  const id = await nuevoInventario();
  await dictar(id, 'Rokku 5', CONTADOR);
  const c1 = await patch(id, 1, { estado: 'confirmada' }, CONTADOR);
  assert.equal(c1.status, 200);
  assert.equal(c1.body.aliasAprendido, true);
  assert.deepEqual(c1.body.alias, { texto: 'rokku', productId: '200', usos: 1 });

  const r2 = await dictar(id, 'Rokku 2', CONTADOR);
  assert.equal(r2.body.lineas[0].via, 'alias');
  // La línea 1 (Roku) sigue confirmada sin aplicar: la nueva pide confirmar por eso, no por el alias.
  assert.deepEqual(r2.body.lineas[0].motivos, ['repetido_en_dictado']);
  const c2 = await patch(id, 2, { estado: 'confirmada' }, CONTADOR);
  assert.equal(c2.body.aliasUsoSumado, true);
  const lista = await api('GET', '/api/inventarios/dictado/alias', undefined, CONTADOR);
  assert.deepEqual(lista.body.alias.map((a) => [a.texto, a.productId, a.usos]), [['rokku', '200', 2]]);

  const b = await dictar(id, 'Bombay 3', CONTADOR);
  assert.equal(b.body.lineas[0].productId, null);
  const c3 = await patch(id, 3, { productId: '50', estado: 'confirmada' }, CONTADOR);
  assert.equal(c3.status, 200);
  assert.equal(c3.body.linea.estado, 'confirmada');
  assert.equal(c3.body.linea.productId, '50');
  assert.equal(c3.body.aliasAprendido, false);
  assert.equal(c3.body.aliasMotivo, 'producto_inactivo');
  assert.equal(db.obtener(T(), { PK: 'ALIAS#GLOBAL', SK: 'TXT#bombay' }), null);

  assert.equal((await api('DELETE', '/api/inventarios/dictado/alias/rokku', undefined, CONTADOR)).status, 403);
  assert.equal((await api('DELETE', '/api/inventarios/dictado/alias/rokku', undefined, COMPRAS)).status, 200);
  assert.equal(db.obtener(T(), { PK: 'ALIAS#GLOBAL', SK: 'TXT#rokku' }), null);
});

test('alias (a): solo hacia candidatos del almacén, estén o no en el conteo', async () => {
  const id = await nuevoInventario();
  await dictar(id, 'Rokku 1', CONTADOR);
  const c = await patch(id, 1, { productId: '400', estado: 'confirmada' }, CONTADOR);
  assert.equal(c.body.aliasAprendido, true);
  assert.equal(db.obtener(T(), { PK: 'ALIAS#GLOBAL', SK: 'TXT#rokku' }).productId, '400');

  await dictar(id, 'Bombay 1', CONTADOR);
  const i = await patch(id, 2, { productId: '50', estado: 'confirmada' }, CONTADOR);
  assert.equal(i.body.aliasMotivo, 'producto_inactivo');
  assert.equal(db.obtener(T(), { PK: 'ALIAS#GLOBAL', SK: 'TXT#bombay' }), null);
});

test('alias (b): quien solo cuenta no reasigna un alias de otro producto activo; gestionar sí', async () => {
  const id = await nuevoInventario();
  await dictar(id, 'Rokku 5', CONTADOR);
  assert.equal((await patch(id, 1, { estado: 'confirmada' }, CONTADOR)).body.aliasAprendido, true);

  await dictar(id, 'Rokku 1', CONTADOR);
  const c = await patch(id, 2, { productId: '300', estado: 'confirmada' }, CONTADOR);
  assert.equal(c.status, 200);
  assert.equal(c.body.linea.estado, 'confirmada');
  assert.equal(c.body.linea.productId, '300');
  assert.equal(c.body.aliasAprendido, false);
  assert.equal(c.body.aliasMotivo, 'alias_existente');
  const alias = db.obtener(T(), { PK: 'ALIAS#GLOBAL', SK: 'TXT#rokku' });
  assert.deepEqual([alias.productId, alias.usos], ['200', 1]);

  await dictar(id, 'Rokku 1', COMPRAS);
  const g = await patch(id, 1, { productId: '300', estado: 'confirmada' }, COMPRAS);
  assert.equal(g.body.aliasAprendido, true);
  assert.equal(db.obtener(T(), { PK: 'ALIAS#GLOBAL', SK: 'TXT#rokku' }).productId, '300');
});

test('PATCH: otro producto y cantidad nueva repartida', async () => {
  const id = await nuevoInventario();
  await dictar(id, 'Roku 3', CONTADOR);
  const p = await patch(id, 1, { productId: '300', cantidad: 2.5 }, CONTADOR);
  assert.equal(p.status, 200);
  assert.equal(p.body.linea.productId, '300');
  assert.equal(p.body.linea.productoNombre, 'LARIOS GIN');
  assert.deepEqual(p.body.linea.cantidad, { total: 2.5, stockReal: 2, botellasAbiertas: 0.5 });
  assert.equal(p.body.linea.confirmar, true);
  assert.equal((await patch(id, 1, { productId: '999' }, CONTADOR)).status, 404);
  assert.equal((await patch(id, 1, { estado: 'aplicada' }, CONTADOR)).status, 400);
  const c = await patch(id, 1, { estado: 'confirmada' }, CONTADOR);
  assert.equal(c.body.aliasAprendido, true);
  await aplicar(id, [1], CONTADOR);
  assert.deepEqual([lineaConteo(id, '300').stockReal, lineaConteo(id, '300').botellasAbiertas], [2, 0.5]);
  assert.equal((await patch(id, 1, { estado: 'pendiente' }, CONTADOR)).status, 409);
});

// ─── Estados del inventario ───

test('importado → 409; quien cuenta con el inventario revisado → 403', async () => {
  const id = await nuevoInventario();
  await dictar(id, 'Roku 1', CONTADOR);
  await cambiarEstado(id, 'contado', 'compras@test');
  await cambiarEstado(id, 'revisado', 'compras@test');
  assert.equal((await dictar(id, 'Roku 2', CONTADOR)).status, 403);
  assert.equal((await aplicar(id, [1], CONTADOR)).status, 403);
  assert.equal((await patch(id, 1, { estado: 'confirmada' }, CONTADOR)).status, 403);
  assert.equal((await dictar(id, 'Roku 2', COMPRAS)).status, 201);

  await cambiarEstado(id, 'exportado', 'compras@test');
  await cambiarEstado(id, 'importado', 'compras@test');
  assert.equal((await dictar(id, 'Roku 2', CONTADOR)).status, 409);
  assert.equal((await dictar(id, 'Roku 2', COMPRAS)).status, 409);
  assert.equal((await aplicar(id, [1], COMPRAS)).status, 409);
  assert.equal(lineaConteo(id, '200').stockReal, undefined);
});

// ─── Formatos ───

test('formatos: contar crea, no edita ni borra; gestionar edita; el dictado los usa', async () => {
  const id = await nuevoInventario();
  const c = await api('POST', '/api/inventarios/dictado/formatos', { productId: '200', unidadesCaja: 6 }, CONTADOR);
  assert.equal(c.status, 201);
  assert.deepEqual(c.body, { productId: '200', unidadesCaja: 6 });
  assert.equal((await api('POST', '/api/inventarios/dictado/formatos', { productId: '200', unidadesCaja: 8 }, CONTADOR)).status, 409);
  assert.equal((await api('PUT', '/api/inventarios/dictado/formatos/200', { unidadesCaja: 12 }, CONTADOR)).status, 403);
  assert.equal((await api('DELETE', '/api/inventarios/dictado/formatos/200', undefined, CONTADOR)).status, 403);
  const e = await api('PUT', '/api/inventarios/dictado/formatos/200', { unidadesCaja: 12 }, COMPRAS);
  assert.equal(e.status, 200);
  assert.equal(e.body.unidadesCaja, 12);

  const g = await api('GET', '/api/inventarios/dictado/formatos?productIds=200,1367', undefined, CONTADOR);
  assert.deepEqual(g.body.formatos, [{ productId: '200', unidadesCaja: 12 }]);
  const muchos = Array.from({ length: 201 }, (_, i) => `p${i}`).join(',');
  assert.equal((await api('GET', `/api/inventarios/dictado/formatos?productIds=${muchos}`, undefined, CONTADOR)).status, 400);

  const r = await dictar(id, 'Roku 2 cajas', CONTADOR);
  assert.equal(r.body.lineas[0].cantidad.total, 24);
  assert.equal(r.body.lineas[0].faltaFormato, undefined);
  const sinFormato = await dictar(id, 'Larios 2 cajas', CONTADOR);
  assert.deepEqual(sinFormato.body.lineas[0].faltaFormato, { productId: '300' });
  assert.equal(sinFormato.body.lineas[0].confirmar, true);
  const ultima = await dictar(id, 'ahora son 3 cajas', CONTADOR);
  assert.deepEqual(ultima.body.lineas[0].faltaFormato, { productId: '300' });
  await api('POST', '/api/inventarios/dictado/formatos', { productId: '300', unidadesCaja: 6 }, CONTADOR);
  const conFormato = await dictar(id, 'ahora son 3 cajas', CONTADOR);
  assert.equal(conFormato.body.lineas[0].productId, '300');
  assert.equal(conFormato.body.lineas[0].cantidad.total, 18);

  assert.equal((await api('DELETE', '/api/inventarios/dictado/formatos/200', undefined, COMPRAS)).status, 200);
  assert.equal(db.obtener(T(), { PK: 'FORMATO#GLOBAL', SK: 'PROD#200' }), null);
});

// ─── Dos usuarios ───

test('dos usuarios del mismo inventario no se pisan', async () => {
  const id = await nuevoInventario();
  const a = await dictar(id, 'Roku 2', CONTADOR);
  const b = await dictar(id, 'Larios 5', CONTADOR2);
  assert.equal(a.body.lineas[0].n, 1);
  assert.equal(b.body.lineas[0].n, 1);
  const sa = await api('GET', ruta(id), undefined, CONTADOR);
  const sb = await api('GET', ruta(id), undefined, CONTADOR2);
  assert.deepEqual(sa.body.lineas.map((l) => l.productId), ['200']);
  assert.deepEqual(sb.body.lineas.map((l) => l.productId), ['300']);
  assert.equal(sb.body.sesion.usuarioId, '000023');

  await aplicar(id, [1], CONTADOR2);
  assert.equal(lineaConteo(id, '300').stockReal, 5);
  assert.equal(lineaConteo(id, '200').stockReal, undefined);
  const sa2 = await api('GET', ruta(id), undefined, CONTADOR);
  assert.equal(sa2.body.lineas[0].estado, 'pendiente');
  assert.equal(db.listar(T()).some((it) => String(it.SK).includes('contador@test')), false);
});

// ─── Excel ───

async function filasExcel(inventarioId) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await bufferInventario(await obtenerInventario(inventarioId)));
  const filas = [];
  wb.getWorksheet('Inventario').eachRow((fila) => filas.push(fila.values));
  return filas;
}

test('el Excel tras aplicar por dictado es igual que tras el mismo conteo con PUT /lineas', async () => {
  const porDictado = await nuevoInventario();
  const aMano = await nuevoInventario();

  await dictar(porDictado, 'Roku 7. Johnnie 0,75', CONTADOR);
  await patch(porDictado, 2, { estado: 'confirmada' }, CONTADOR);
  const a = await aplicar(porDictado, [1, 2], CONTADOR);
  assert.equal(a.body.aplicadas.length, 2);

  assert.equal((await api('PUT', `/api/inventarios/${aMano}/lineas/200`, { stockReal: 7, botellasAbiertas: 0 }, CONTADOR)).status, 200);
  assert.equal((await api('PUT', `/api/inventarios/${aMano}/lineas/1367`, { stockReal: 1, botellasAbiertas: 0.25 }, CONTADOR)).status, 200);

  assert.deepEqual(await filasExcel(porDictado), await filasExcel(aMano));
  const sinId = (inv) => inv.lineas;
  assert.deepEqual(sinId(await obtenerInventario(porDictado)), sinId(await obtenerInventario(aMano)));
});

// ─── Montaje ───

test('las rutas nuevas no capturan las de inventarios.js ni al revés', async () => {
  const id = await nuevoInventario();
  const inv = await api('GET', `/api/inventarios/${id}`, undefined, COMPRAS);
  assert.equal(inv.status, 200);
  assert.equal(inv.body.lineas.find((l) => l.productId === '200').stockTeorico, 7);
  const lista = await api('GET', '/api/inventarios?warehouseId=1', undefined, COMPRAS);
  assert.equal(lista.body.inventarios.length, 1);
  const productos = await api('GET', '/api/inventarios/productos', undefined, CONTADOR);
  assert.equal(productos.status, 200);
  assert.ok(productos.body.productos.length > 0);

  const alias = await api('GET', '/api/inventarios/dictado/alias', undefined, CONTADOR);
  assert.deepEqual(alias.body, { alias: [] });
  const formatos = await api('GET', '/api/inventarios/dictado/formatos', undefined, CONTADOR);
  assert.deepEqual(formatos.body, { formatos: [] });
  const sesion = await api('GET', ruta(id), undefined, CONTADOR);
  assert.deepEqual(sesion.body, { sesion: null, lineas: [] });

  const linea = await api('PUT', `/api/inventarios/${id}/lineas/200`, { stockReal: 2 }, COMPRAS);
  assert.equal(linea.status, 200);
  assert.equal(linea.body.stockTeorico, 7);
});

test('ninguna respuesta a quien solo cuenta lleva stockTeorico', async () => {
  const id = await nuevoInventario();
  await dictar(id, 'Roku 3. Johnnie 1. Coca cola 2', CONTADOR);
  await patch(id, 2, { estado: 'confirmada' }, CONTADOR);
  await aplicar(id, [1, 2, 3], CONTADOR);
  await aplicar(id, [1, 2, 3], CONTADOR);
  await api('GET', ruta(id), undefined, CONTADOR);
  assert.ok(respuestasContar.length > 20);
  const dictado = respuestasContar.filter((r) => r.ruta.includes('/dictado'));
  for (const r of dictado) {
    assert.deepEqual(clavesProhibidas(r.body), [], r.ruta);
    assert.equal(JSON.stringify(r.body).includes('stockTeorico'), false, r.ruta);
  }
  for (const r of respuestasContar) assert.equal(JSON.stringify(r.body).includes('stockTeorico'), false, r.ruta);
});
