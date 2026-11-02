/**
 * Claves y almacenamiento del dictado por voz en Igp_Inventarios: alias y formatos
 * globales y sesiones por usuario colgadas del inventario. Dynamo en memoria.
 * No se guarda stock teórico ni audio; la lectura del inventario no ve nada del dictado.
 */

import test, { beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import ExcelJS from 'exceljs';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-inventario';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const claves = await import('../lib/inventarios/claves.js');
const { listarAlias, guardarAlias, sumarUso, borrarAlias } = await import('../lib/inventarios/dictado/alias.js');
const {
  obtenerFormatos, crearFormato, editarFormato, borrarFormato,
} = await import('../lib/inventarios/dictado/formatos.js');
const sesion = await import('../lib/inventarios/dictado/sesion.js');
const { parsearDictado } = await import('../lib/inventarios/dictado/parser.js');
const {
  obtenerInventario, borrarInventario, listarInventarios,
} = await import('../lib/inventarios/inventarios.js');
const { listarLecturas } = await import('../lib/inventarios/lectura.js');
const { listarFotos } = await import('../lib/inventarios/fotos.js');
const { bufferInventario } = await import('../lib/inventarios/excel.js');

const T = () => tables.inventarios;
const PRODUCTOS = [
  { productId: '1367', nombre: 'Johnnie Walker' },
  { productId: '200', nombre: 'Roku' },
  { productId: '300', nombre: 'Larios 12', activo: false },
];

let db = null;

function preparar({ paginaTam = 0 } = {}) {
  db = crearDynamoMemoria({ paginaTam });
  db.crearTabla(T(), {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'WarehouseId-Clave-index': { hashKey: 'WarehouseId', rangeKey: 'Clave' } },
  });
  db.instalar(docClient);
  db.sembrar(T(), {
    PK: 'INV#inv1', SK: 'META', WarehouseId: '000001', Clave: 'INV#2026-10-26#inv1',
    inventarioId: 'inv1', fecha: '2026-10-26', estado: 'borrador',
    employeeId: '42', plantillaId: 'p1', creadoEn: '2026-10-26T08:00:00.000Z', actualizadoEn: '2026-10-26T08:00:00.000Z',
  });
  db.sembrar(T(), {
    PK: 'INV#inv1', SK: 'LINE#1367', productId: '1367', nombre: 'Johnnie Walker',
    stockTeorico: 203, stockReal: 5, botellasAbiertas: 0.5,
  });
  db.sembrar(T(), {
    PK: 'INV#inv1', SK: 'LINE#200', productId: '200', nombre: 'Roku', stockTeorico: 7, botellasAbiertas: 0,
  });
}

async function rejecta(promesa, status, mensaje) {
  await assert.rejects(promesa, (err) => {
    assert.equal(err.status, status, err.message);
    if (mensaje) assert.equal(err.message, mensaje);
    return true;
  });
}

function lineaDe(textoDictado) {
  const [orden] = parsearDictado(textoDictado).ordenes;
  return { texto: textoDictado, orden, cantidad: orden.cantidad, modo: 'sumar', productId: '200', productoNombre: 'Roku' };
}

const PROHIBIDOS = /teorico|exportstocks|audio/i;

function buscarProhibidos(valor, ruta = '') {
  if (valor == null || typeof valor !== 'object') return [];
  return Object.entries(valor).flatMap(([k, v]) => [
    ...(PROHIBIDOS.test(k) ? [`${ruta}${k}`] : []),
    ...buscarProhibidos(v, `${ruta}${k}.`),
  ]);
}

beforeEach(() => preparar());

// ─── Claves ───

test('claves del dictado', () => {
  assert.equal(claves.pkAliasGlobal(), 'ALIAS#GLOBAL');
  assert.equal(claves.skAlias('  Coca-Cola  '), 'TXT#coca cola');
  assert.throws(() => claves.skAlias('¡¿!'), (e) => e.status === 400);
  assert.equal(claves.skAlias('a'.repeat(200)).length, 'TXT#'.length + 80);
  assert.equal(claves.pkFormatoGlobal(), 'FORMATO#GLOBAL');
  assert.equal(claves.skFormato('1367'), 'PROD#1367');
  assert.throws(() => claves.skFormato('a#b'), (e) => e.status === 400);
  assert.equal(claves.skDictadoMeta('000020'), 'DICTADO#000020#META');
  assert.equal(claves.skDictadoLinea('000020', 7), 'DICTADO#000020#LINEA#000007');
  assert.equal(claves.prefijoDictado('000020'), 'DICTADO#000020#');
  assert.throws(() => claves.skDictadoLinea('000020', 0), (e) => e.status === 400);
  assert.throws(() => claves.skDictadoLinea('000020', 1.5), (e) => e.status === 400);
});

test('usuarioSegmento: id tal cual; email a hash estable sin #', () => {
  assert.equal(claves.usuarioSegmento('000020'), '000020');
  const a = claves.usuarioSegmento('contador@test.com');
  const b = claves.usuarioSegmento('contador@test.com');
  assert.equal(a, b);
  assert.match(a, /^U[0-9a-f]{24}$/);
  assert.equal(a.includes('#'), false);
  assert.notEqual(claves.usuarioSegmento('otro@test.com'), a);
  assert.equal(claves.usuarioSegmento('Ana López'), claves.usuarioSegmento('Ana López'));
  assert.equal(claves.usuarioSegmento(a), a, 'idempotente');
  assert.equal(claves.skDictadoMeta('contador@test.com'), `DICTADO#${a}#META`);
  assert.throws(() => claves.usuarioSegmento('  '), (e) => e.status === 400);
});

// ─── Alias ───

test('alias a producto inactivo o inexistente se rechaza', async () => {
  const msg = 'El alias debe apuntar a un producto activo del almacén.';
  await rejecta(guardarAlias('larios', '300', 'ana', { productosActivos: PRODUCTOS }), 400, msg);
  await rejecta(guardarAlias('larios', '999', 'ana', { productosActivos: PRODUCTOS }), 400, msg);
  await rejecta(guardarAlias('larios', '200', 'ana'), 400, msg);
  await rejecta(guardarAlias(' ¡! ', '200', 'ana', { productosActivos: PRODUCTOS }), 400);
  assert.equal(db.listar(T()).filter((it) => it.PK === 'ALIAS#GLOBAL').length, 0);
});

test('alias: mismo producto suma usos; otro producto sobrescribe y reinicia usos', async () => {
  const a1 = await guardarAlias('Jonnie', '1367', 'ana', { productosActivos: PRODUCTOS });
  assert.equal(a1.texto, 'jonnie');
  assert.equal(a1.usos, 1);
  assert.equal(a1.productoNombre, 'Johnnie Walker');
  const a2 = await guardarAlias('JONNIE', '1367', 'luis', { productosActivos: PRODUCTOS });
  assert.equal(a2.usos, 2);
  assert.equal(a2.creadoPor, 'ana');
  assert.equal(a2.actualizadoPor, 'luis');

  const a3 = await guardarAlias('jonnie', '200', 'eva', { productosActivos: PRODUCTOS });
  assert.equal(a3.productId, '200');
  assert.equal(a3.productoNombre, 'Roku');
  assert.equal(a3.usos, 1);
  assert.equal(a3.creadoPor, 'ana');
  assert.equal(a3.creadoEn, a1.creadoEn);
  assert.equal(a3.actualizadoPor, 'eva');

  const item = db.obtener(T(), { PK: 'ALIAS#GLOBAL', SK: 'TXT#jonnie' });
  assert.equal(item.WarehouseId, undefined);
  assert.equal(item.Clave, undefined);
});

test('alias: el número solo vale si está en el producto; una cuenta no se guarda', async () => {
  const productos = [
    ...PRODUCTOS,
    { productId: '818', nombre: '818 Tequila' },
    { productId: '826', nombre: 'Ballantines 10' },
  ];
  const msg = 'Ese alias no se puede guardar: parece una cuenta o es demasiado largo.';
  await rejecta(guardarAlias('10 filas por 10 cajas por', '200', 'ana', { productosActivos: productos }), 400, msg);
  await rejecta(guardarAlias('multiplícalo por 24', '200', 'ana', { productosActivos: productos }), 400, msg);
  await rejecta(guardarAlias('cuatro filas', '200', 'ana', { productosActivos: productos }), 400, msg);
  await rejecta(guardarAlias('a'.repeat(41), '200', 'ana', { productosActivos: productos }), 400, msg);
  await rejecta(guardarAlias('coca 3', '200', 'ana', { productosActivos: productos }), 400, msg);
  assert.equal(db.listar(T()).filter((it) => it.PK === 'ALIAS#GLOBAL').length, 0);

  const tequila = await guardarAlias('818', '818', 'ana', { productosActivos: productos });
  assert.equal(tequila.texto, '818');
  assert.equal(tequila.productId, '818');
  const ballantines = await guardarAlias('Ballantines 10', '826', 'ana', { productosActivos: productos });
  assert.equal(ballantines.texto, 'ballantines 10');
  assert.equal(ballantines.productId, '826');
});

test('alias: sumarUso, listar (paginado) y borrar idempotente', async () => {
  preparar({ paginaTam: 1 });
  assert.equal(await sumarUso('no existe'), false);
  assert.equal(await sumarUso(''), false);
  assert.equal(db.obtener(T(), { PK: 'ALIAS#GLOBAL', SK: 'TXT#no existe' }), null);

  await guardarAlias('jonnie', '1367', 'ana', { productosActivos: PRODUCTOS });
  await guardarAlias('roku gin', '200', 'ana', { productosActivos: PRODUCTOS });
  assert.equal(await sumarUso('Jonnie'), true);
  const lista = await listarAlias();
  assert.equal(lista.length, 2);
  assert.deepEqual(lista.map((a) => [a.texto, a.productId, a.usos]).sort(), [['jonnie', '1367', 2], ['roku gin', '200', 1]]);

  await borrarAlias('Jonnie');
  await borrarAlias('Jonnie');
  assert.deepEqual((await listarAlias()).map((a) => a.texto), ['roku gin']);
});

// ─── Formatos ───

test('formatos: crear, repetido 409 sin sobrescribir, editar, borrar', async () => {
  const f = await crearFormato('1367', { unidadesCaja: 24 }, 'ana');
  assert.deepEqual(f, { productId: '1367', unidadesCaja: 24 });
  await rejecta(crearFormato('1367', { unidadesCaja: 6, unidadesPack: 2 }, 'luis'), 409, 'Ese producto ya tiene formato de caja.');
  const guardado = db.obtener(T(), { PK: 'FORMATO#GLOBAL', SK: 'PROD#1367' });
  assert.equal(guardado.unidadesCaja, 24);
  assert.equal(guardado.quien, 'ana');
  assert.equal(guardado.WarehouseId, undefined);

  await rejecta(editarFormato('999', { unidadesCaja: 6 }, 'luis'), 404);
  assert.equal(db.obtener(T(), { PK: 'FORMATO#GLOBAL', SK: 'PROD#999' }), null);

  const e = await editarFormato('1367', { unidadesCaja: 12, unidadesPack: 6 }, 'luis');
  assert.deepEqual(e, { productId: '1367', unidadesCaja: 12, unidadesPack: 6 });
  await borrarFormato('1367');
  await borrarFormato('1367');
  assert.equal(db.obtener(T(), { PK: 'FORMATO#GLOBAL', SK: 'PROD#1367' }), null);
});

test('formatos: validaciones', async () => {
  for (const datos of [
    {}, null, { unidadesCaja: 0 }, { unidadesCaja: 1001 }, { unidadesCaja: 2.5 }, { unidadesCaja: '24x' },
    { unidadesCaja: true }, { unidadesCaja: 24, unidadesPack: 0 }, { unidadesCaja: 24, unidadesPack: 1.5 },
  ]) {
    await rejecta(crearFormato('1367', datos, 'ana'), 400);
  }
  await rejecta(crearFormato('a#b', { unidadesCaja: 24 }, 'ana'), 400);
  assert.deepEqual(await crearFormato('1367', { unidadesCaja: '24', unidadesPack: '' }, 'ana'), { productId: '1367', unidadesCaja: 24 });
  assert.deepEqual(await crearFormato('200', { unidadesCaja: 1000, unidadesPack: 1 }, 'ana'), { productId: '200', unidadesCaja: 1000, unidadesPack: 1 });
});

test('obtenerFormatos: BatchGet por lotes, ignora inválidos y ausentes', async () => {
  await crearFormato('1367', { unidadesCaja: 24 }, 'ana');
  await crearFormato('200', { unidadesCaja: 6, unidadesPack: 3 }, 'ana');
  const ids = ['1367', '200', '200', 'a#b', '', null, ...Array.from({ length: 150 }, (_, i) => `x${i}`)];
  const antes = db.operaciones.length;
  const mapa = await obtenerFormatos(ids);
  assert.deepEqual([...mapa.entries()].sort(), [['1367', { unidadesCaja: 24 }], ['200', { unidadesCaja: 6, unidadesPack: 3 }]]);
  const lotes = db.operaciones.slice(antes).filter((o) => o.tipo === 'BatchGetCommand');
  assert.equal(lotes.length, 2);
  assert.ok(lotes.every((o) => o.claves <= 100));
  assert.equal((await obtenerFormatos([])).size, 0);
  assert.equal((await obtenerFormatos(undefined)).size, 0);
});

// ─── Sesión ───

test('dos usuarios del mismo inventario no se pisan', async () => {
  preparar({ paginaTam: 2 });
  const a = await sesion.anadirLineas('inv1', '000020', [lineaDe('Roku 7'), lineaDe('Roku 3')], 'Ana');
  const b = await sesion.anadirLineas('inv1', 'luis@test.com', [lineaDe('Roku 1')], 'Luis');
  const a2 = await sesion.anadirLineas('inv1', '000020', [lineaDe('Roku 2')], 'Ana');
  assert.deepEqual(a.map((l) => l.n), [1, 2]);
  assert.deepEqual(b.map((l) => l.n), [1]);
  assert.deepEqual(a2.map((l) => l.n), [3]);

  const sa = await sesion.obtenerSesion('inv1', '000020');
  const sb = await sesion.obtenerSesion('inv1', 'luis@test.com');
  assert.deepEqual(sa.lineas.map((l) => [l.n, l.texto]), [[1, 'Roku 7'], [2, 'Roku 3'], [3, 'Roku 2']]);
  assert.deepEqual(sb.lineas.map((l) => [l.n, l.texto]), [[1, 'Roku 1']]);
  assert.equal(sa.meta.estado, 'activa');
  assert.equal(sa.meta.siguiente, 3);
  assert.equal(sa.meta.usuarioId, '000020');
  assert.equal(sb.meta.usuarioId, 'luis@test.com');
  assert.equal(sb.meta.usuarioNombre, 'Luis');
  assert.equal(sa.lineas[0].estado, 'pendiente');
  assert.deepEqual(sa.lineas[0].cantidad, { total: 7, stockReal: 7, botellasAbiertas: 0 });
  assert.deepEqual(await sesion.obtenerSesion('inv1', 'nadie'), { meta: null, lineas: [] });
});

test('dos anadirLineas en paralelo del mismo usuario no repiten n', async () => {
  const lote = (k, p) => Array.from({ length: k }, (_, i) => lineaDe(`Roku ${p}${i}`));
  const [x, y, z] = await Promise.all([
    sesion.anadirLineas('inv1', '000020', lote(5, 'a'), 'Ana'),
    sesion.anadirLineas('inv1', '000020', lote(3, 'b'), 'Ana'),
    sesion.anadirLineas('inv1', '000020', lote(4, 'c'), 'Ana'),
  ]);
  const ns = [...x, ...y, ...z].map((l) => l.n).sort((p, q) => p - q);
  assert.deepEqual(ns, Array.from({ length: 12 }, (_, i) => i + 1));
  const s = await sesion.obtenerSesion('inv1', '000020');
  assert.equal(s.lineas.length, 12);
  assert.equal(s.meta.siguiente, 12);
});

test('límites de anadirLineas e inventario inexistente', async () => {
  await rejecta(sesion.anadirLineas('nope', '000020', [lineaDe('Roku 7')], 'Ana'), 404, 'Inventario no encontrado.');
  assert.equal(db.listar(T()).some((it) => it.PK === 'INV#nope'), false);
  await rejecta(sesion.anadirLineas('inv1', '000020', [], 'Ana'), 400);
  await rejecta(sesion.anadirLineas('inv1', '000020', Array.from({ length: 51 }, () => lineaDe('Roku 1')), 'Ana'), 400);
  await rejecta(sesion.anadirLineas('inv1', '000020', [{ texto: 'x'.repeat(2001) }], 'Ana'), 400);
  await rejecta(sesion.anadirLineas('inv1', '000020', [{ texto: 'Roku', modo: 'multiplicar' }], 'Ana'), 400);
  await rejecta(sesion.anadirLineas('inv1', '000020', [{ texto: 'Roku', cantidad: { total: 1, stockReal: 1, botellasAbiertas: 0.3 } }], 'Ana'), 400);
  await rejecta(sesion.anadirLineas('inv1', '  ', [lineaDe('Roku 7')], 'Ana'), 400);
  await rejecta(sesion.anadirLineas('a#b', '000020', [lineaDe('Roku 7')], 'Ana'), 400);
  // Una validación fallida no consume números.
  const [l] = await sesion.anadirLineas('inv1', '000020', [lineaDe('Roku 7')], 'Ana');
  assert.equal(l.n, 1);
  // Un usuario con «#» no parte la clave: va como hash.
  await sesion.anadirLineas('inv1', 'a#b', [lineaDe('Roku 7')], 'Ana');
  const sks = db.listar(T()).map((it) => it.SK).filter((sk) => sk.startsWith('DICTADO#U'));
  assert.equal(sks.length, 2);
  assert.ok(sks.every((sk) => /^DICTADO#U[0-9a-f]{24}#(META|LINEA#\d{6})$/.test(sk)));
});

test('si el inventario desaparece entre la comprobación y la escritura, 404 y sin líneas', async () => {
  // El Put de la línea dentro de la transacción dispara el gancho antes de comprobar condiciones.
  db.interceptar('PutCommand', T(), async () => {
    await docClient.send(new DeleteCommand({ TableName: T(), Key: { PK: 'INV#inv1', SK: 'META' } }));
  });
  await rejecta(sesion.anadirLineas('inv1', '000020', [lineaDe('Roku 7')], 'Ana'), 404, 'Inventario no encontrado.');
  assert.equal(db.listar(T()).some((it) => String(it.SK).includes('#LINEA#')), false);
});

test('lista blanca: nunca se guarda stock teórico ni audio', async () => {
  const orden = { ...parsearDictado('Roku 7').ordenes[0], stockTeorico: 99, teorico: 1 };
  orden.cantidad = { ...orden.cantidad, stockTeorico: 203 };
  orden.alternativas = [{ textoProducto: 'Roku', cantidad: null, stockTeorico: 5 }];
  const [l] = await sesion.anadirLineas('inv1', '000020', [{
    texto: 'Roku 7',
    orden,
    productId: '200',
    productoNombre: 'Roku',
    cantidad: { total: 7, stockReal: 7, botellasAbiertas: 0, stockTeorico: 203 },
    modo: 'sumar',
    stockTeorico: 203,
    teorico: 203,
    exportStocks: [{ ProductId: 200, Quantity: 7 }],
    audio: 'UklGR...',
    audioBase64: 'xxx',
    WarehouseId: '000001',
    Clave: 'INV#x',
    estado: 'aplicada',
    n: 999,
  }], 'Ana');
  assert.equal(l.n, 1);
  assert.equal(l.estado, 'pendiente');

  await sesion.actualizarLinea('inv1', '000020', 1, {
    estado: 'confirmada', stockTeorico: 1, teorico: 1, audio: 'x', texto: 'otro', n: 5,
    cantidad: { total: 8, stockReal: 8, botellasAbiertas: 0, stockTeorico: 1 },
  }, 'Ana');

  const dictado = db.listar(T()).filter((it) => String(it.SK).startsWith('DICTADO#'));
  assert.equal(dictado.length, 2);
  for (const it of dictado) {
    assert.deepEqual(buscarProhibidos(it), []);
    assert.equal(it.WarehouseId, undefined);
    assert.equal(it.Clave, undefined);
    const permitidos = it.SK.endsWith('#META') ? sesion.CAMPOS_META : sesion.CAMPOS_LINEA;
    assert.deepEqual(Object.keys(it).filter((k) => !permitidos.includes(k)), []);
  }
  const linea = dictado.find((it) => it.SK.includes('#LINEA#'));
  assert.equal(linea.texto, 'Roku 7');
  assert.equal(linea.n, 1);
  assert.equal(linea.orden.textoOriginal, undefined);
  assert.deepEqual(linea.cantidad, { total: 8, stockReal: 8, botellasAbiertas: 0 });
});

test('transiciones de estado de las líneas', async () => {
  await sesion.anadirLineas('inv1', '000020', [lineaDe('Roku 1'), lineaDe('Roku 2'), lineaDe('Roku 3')], 'Ana');
  const act = (n, cambios) => sesion.actualizarLinea('inv1', '000020', n, cambios, 'Ana');

  assert.equal((await act(1, { estado: 'confirmada' })).estado, 'confirmada');
  assert.equal((await act(1, { estado: 'pendiente' })).estado, 'pendiente');
  assert.equal((await act(1, { estado: 'confirmada' })).estado, 'confirmada');
  assert.equal((await act(1, { estado: 'aplicada' })).estado, 'aplicada');
  for (const estado of ['pendiente', 'confirmada', 'descartada', 'aplicada']) {
    await rejecta(act(1, { estado }), 409);
  }
  await rejecta(act(1, { productoNombre: 'otro' }), 409);

  assert.equal((await sesion.descartarLinea('inv1', '000020', 2, 'Ana')).estado, 'descartada');
  await rejecta(act(2, { estado: 'confirmada' }), 409);
  await rejecta(act(2, { estado: 'aplicada' }), 409);
  assert.equal((await act(2, { estado: 'pendiente' })).estado, 'pendiente');

  assert.equal((await act(3, { estado: 'aplicada' })).estado, 'aplicada');
  await rejecta(act(3, { estado: 'inventado' }), 409);
  const l = await act(2, { productId: '1367', productoNombre: 'Johnnie Walker', modo: 'reemplazar', motivos: ['ambiguo'], confirmar: true });
  assert.equal(l.productId, '1367');
  assert.equal(l.modo, 'reemplazar');
  assert.deepEqual(l.motivos, ['ambiguo']);
  await rejecta(act(2, { estado: 'inventado' }), 400);
  await rejecta(act(2, { confirmar: 'si' }), 400);
  await rejecta(act(99, { estado: 'confirmada' }), 404, 'Línea de dictado no encontrada.');
  await rejecta(sesion.actualizarLinea('inv1', 'luis', 2, { estado: 'confirmada' }, 'Luis'), 404);
});

test('pausar, reanudar y cerrar la sesión sin borrar líneas', async () => {
  await rejecta(sesion.pausarSesion('inv1', '000020'), 404, 'Sesión de dictado no encontrada.');
  await sesion.anadirLineas('inv1', '000020', [lineaDe('Roku 1')], 'Ana');
  assert.equal((await sesion.pausarSesion('inv1', '000020')).estado, 'pausada');
  assert.equal((await sesion.pausarSesion('inv1', '000020')).estado, 'pausada');
  assert.equal((await sesion.reanudarSesion('inv1', '000020')).estado, 'activa');
  assert.equal((await sesion.cerrarSesion('inv1', '000020')).estado, 'cerrada');
  await rejecta(sesion.pausarSesion('inv1', '000020'), 409);
  await rejecta(sesion.anadirLineas('inv1', '000020', [lineaDe('Roku 2')], 'Ana'), 409, 'La sesión de dictado está cerrada.');
  const s = await sesion.obtenerSesion('inv1', '000020');
  assert.equal(s.meta.estado, 'cerrada');
  assert.equal(s.meta.siguiente, 1);
  assert.equal(s.lineas.length, 1);
  assert.equal((await sesion.reanudarSesion('inv1', '000020')).estado, 'activa');
  const [l] = await sesion.anadirLineas('inv1', '000020', [lineaDe('Roku 2')], 'Ana');
  assert.equal(l.n, 2);
});

// ─── Integración con la lectura del inventario ───

async function filasExcel(inventario) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await bufferInventario(inventario));
  const filas = [];
  wb.getWorksheet('Inventario').eachRow((fila) => filas.push(fila.values));
  return filas;
}

test('la lectura del inventario y el Excel no ven el dictado, alias ni formatos', async () => {
  const antes = await obtenerInventario('inv1');
  const excelAntes = await filasExcel(antes);
  const listadoAntes = await listarInventarios('000001');
  const lecturasAntes = await listarLecturas('inv1');
  const fotosAntes = await listarFotos('inv1');

  await sesion.anadirLineas('inv1', '000020', [lineaDe('Roku 7'), lineaDe('Johnnie 3')], 'Ana');
  await sesion.anadirLineas('inv1', 'luis@test.com', [lineaDe('Roku 1')], 'Luis');
  await guardarAlias('jonnie', '1367', 'ana', { productosActivos: PRODUCTOS });
  await crearFormato('1367', { unidadesCaja: 24 }, 'ana');

  const despues = await obtenerInventario('inv1');
  assert.deepEqual(despues, antes);
  assert.deepEqual(despues.lineas.map((l) => l.productId).sort(), ['1367', '200']);
  assert.doesNotMatch(JSON.stringify(despues), /DICTADO#|ALIAS|FORMATO|TXT#|PROD#/);
  assert.deepEqual(await filasExcel(despues), excelAntes);
  assert.deepEqual(await listarInventarios('000001'), listadoAntes);
  assert.deepEqual(await listarLecturas('inv1'), lecturasAntes);
  assert.deepEqual(await listarFotos('inv1'), fotosAntes);
});

test('borrar el inventario se lleva las sesiones de dictado', async () => {
  await sesion.anadirLineas('inv1', '000020', [lineaDe('Roku 7')], 'Ana');
  await sesion.anadirLineas('inv1', 'luis@test.com', [lineaDe('Roku 1')], 'Luis');
  await guardarAlias('jonnie', '1367', 'ana', { productosActivos: PRODUCTOS });
  await crearFormato('1367', { unidadesCaja: 24 }, 'ana');
  await borrarInventario('inv1');
  const restos = db.listar(T());
  assert.equal(restos.some((it) => it.PK === 'INV#inv1'), false);
  assert.equal(restos.filter((it) => it.PK === 'ALIAS#GLOBAL' || it.PK === 'FORMATO#GLOBAL').length, 2);
});
