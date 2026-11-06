/**
 * Cálculo de stock máximo: previsión día a día, tramo congelado,
 * máximo final, redondeo y simulación sin guardar.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-calculo-mia';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { invalidarPermisosRol } = await import('../lib/permisos/cachePermisos.js');
const { fechaComparacion } = await import('../lib/agora/objetivoMensual.js');
const { guardarTramos, elegirTramo } = await import('../lib/mia/tramos.js');
const { crearConteoStock, marcarPedidoProveedor, MENSAJE_RECALCULO_BLOQUEADO } = await import('../lib/mia/conteoStock.js');
const {
  resolverRangoPrevision,
  fechaCalendarioMadrid,
  sumarDiasIso,
  calcularConteo,
  AVISO_SIN_MAXIMO,
  AVISO_SIN_CONTAR,
} = await import('../lib/mia/calculoStock.js');
const { default: miaRouter } = await import('../routes/mia.js');

const COMPRADOR = { sub: '000080', email: 'compras@grupo.test', rol: 'SuperUser' };
const CAMARERO = { sub: '000082', email: 'sala@grupo.test', rol: 'Camarero' };
const OFICINA = { sub: '000081', email: 'oficina@grupo.test', rol: 'SuperUser' };

const TRAMOS_GLOBAL = [
  { desde: 0, hasta: 100, multiplicador: 1 },
  { desde: 100, hasta: null, multiplicador: 2 },
];

let usuarioActual = COMPRADOR;
let servidor = null;
let base = '';
let db = null;

async function asegurarServidor() {
  if (servidor) return;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = usuarioActual;
    req.log = { info() {}, error() {}, warn() {} };
    next();
  });
  app.use('/api', miaRouter);
  servidor = http.createServer(app);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  base = `http://127.0.0.1:${servidor.address().port}`;
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.salesCloseOuts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.gestionFestivos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaConfigProducto, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaInformes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const p of ['ver', 'calcular']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#SuperUser', SK: `PERMISO#mia.${p}` });
  }
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Camarero', SK: 'PERMISO#mia.ver' });
  db.sembrar(tables.almacenes, { Id: '101', Nombre: 'Almacen Centro' });
  db.sembrar(tables.almacenes, { Id: '202', Nombre: 'Almacen Sur' });
  db.sembrar(tables.almacenes, { Id: '303', Nombre: 'Almacen Isla' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', agoraCode: '101', sede: 'Grupo Paripe', 'almacen origen': 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000011', nombre: 'Bar Terraza', agoraCode: '102', sede: 'Grupo Paripe', 'almacen origen': 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur', agoraCode: '202', sede: 'Grupo Paripe Madrid', 'almacen origen': 'Almacen Sur' });
  db.sembrar(tables.usuarios, { id_usuario: '000080', Email: COMPRADOR.email, Rol: 'SuperUser', Local: ['Bar Centro'] });
  db.sembrar(tables.usuarios, { id_usuario: '000081', Email: OFICINA.email, Rol: 'SuperUser', Local: [] });
  db.sembrar(tables.usuarios, { id_usuario: '000082', Email: CAMARERO.email, Rol: 'Camarero', Local: ['Bar Centro'] });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  invalidarPermisosRol();
}

function cierre(pk, fecha, amount) {
  return { PK: pk, SK: `${fecha}#1#1`, InvoicePayments: [{ Amount: amount }] };
}

function config(warehouseId, productId, campos) {
  db.sembrar(tables.miaConfigProducto, {
    PK: `WAREHOUSE#${warehouseId}`,
    SK: `PRODUCT#${productId}`,
    WarehouseId: warehouseId,
    ProductId: productId,
    ...campos,
  });
}

async function api(metodo, ruta, cuerpo, usuario = COMPRADOR) {
  await asegurarServidor();
  usuarioActual = usuario;
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function metaDe(id) {
  return db.obtener(tables.miaInformes, { PK: `INFORME#${id}`, SK: 'META' });
}

test('el inicio por defecto es el día siguiente a la fecha del conteo', () => {
  const r = resolverRangoPrevision({ creadoEn: '2026-01-31T10:00:00.000Z' });
  assert.equal(r.fechaConteo, '2026-01-31');
  assert.equal(r.inicio, '2026-02-01');
  assert.equal(r.inicioEsManana, true);
  assert.notEqual(r.inicio, r.fechaConteo);
  assert.equal(r.fin, '2026-02-07');

  const noche = resolverRangoPrevision({ creadoEn: '2026-01-31T23:30:00.000Z' });
  assert.equal(noche.fechaConteo, '2026-02-01');
  assert.equal(noche.inicio, '2026-02-02');

  const enElDia = resolverRangoPrevision({
    creadoEn: '2026-01-31T10:00:00.000Z',
    semanasDesde: '2026-01-31',
    semanasHasta: '2026-02-02',
  });
  assert.equal(enElDia.inicio, enElDia.fechaConteo);
  assert.equal(enElDia.fin, '2026-02-02');
  assert.equal(enElDia.inicioEsManana, false);
});

test('el límite del tramo es exclusive y 0 entra en el primero', () => {
  assert.equal(elegirTramo(0, TRAMOS_GLOBAL).multiplicador, 1);
  assert.equal(elegirTramo(99.99, TRAMOS_GLOBAL).multiplicador, 1);
  assert.equal(elegirTramo(100, TRAMOS_GLOBAL).multiplicador, 2);
});

test('calcular sin semanas usa mañana respecto a la fecha del conteo', async () => {
  montar();
  await guardarTramos(null, [{ desde: 0, hasta: null, multiplicador: 1 }]);
  const { meta } = await crearConteoStock({ informeId: 'fechas', warehouseId: '101', lineas: [] });
  const r = await api('POST', '/api/mia/conteos/fechas/calcular', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const manana = sumarDiasIso(fechaCalendarioMadrid(meta.creadoEn), 1);
  assert.equal(r.body.inicioEsManana, true);
  assert.equal(r.body.fechaConteo, fechaCalendarioMadrid(meta.creadoEn));
  assert.equal(r.body.rangoDesde, manana);
  assert.equal(r.body.rangoHasta, sumarDiasIso(manana, 6));
  assert.equal(metaDe('fechas').rangoDesde, manana);
});

test('un rango que cruza dos meses suma los días comparables de cada local', async () => {
  montar();
  await guardarTramos(null, [{ desde: 0, hasta: null, multiplicador: 1.5 }]);
  await guardarTramos('101', [{ desde: 0, hasta: null, multiplicador: 9 }]);
  const festivo = '2026-01-31';
  const comp = '2025-12-20';
  db.sembrar(tables.gestionFestivos, { PK: festivo, SK: '0', FechaComparativa: comp });
  db.sembrar(tables.salesCloseOuts, cierre('101', comp, 10));
  db.sembrar(tables.salesCloseOuts, cierre('102', comp, 20));
  db.sembrar(tables.salesCloseOuts, cierre('101', fechaComparacion('2026-02-01'), 30));
  db.sembrar(tables.salesCloseOuts, cierre('102', fechaComparacion('2026-02-01'), 40));
  db.sembrar(tables.salesCloseOuts, cierre('101', fechaComparacion('2026-02-02'), 1));
  db.sembrar(tables.salesCloseOuts, cierre('102', fechaComparacion('2026-02-02'), 2));
  db.sembrar(tables.salesCloseOuts, cierre('101', '2025-06-15', 9999));
  db.sembrar(tables.salesCloseOuts, cierre('101', fechaComparacion(festivo), 9999));
  config('000101', '501', { maximo: 10, formatoCompra: 6 });
  config('000101', '503', { maximo: 0 });
  config('000101', '504', { maximo: 20 });
  config('000101', '505', { maximo: 100 });
  config('000101', '506', { maximo: 10, formatoCompra: 6 });

  await crearConteoStock({
    informeId: 'cruce',
    warehouseId: '101',
    semanasDesde: '2026-01-31',
    semanasHasta: '2026-02-02',
    lineas: [
      { productId: '501', nombre: 'Tonica', proveedorId: '42', stockReal: 4 },
      { productId: '502', nombre: 'Sin tope', proveedorId: '42', stockReal: 3 },
      { productId: '503', nombre: 'Cero', proveedorId: '42', stockReal: 0 },
      { productId: '504', nombre: 'Sin contar', proveedorId: '42', stockReal: null },
      { productId: '505', nombre: 'Manual', proveedorId: '42', stockReal: 1, maximoManual: true, maximoFinal: 8 },
      { productId: '506', nombre: 'Cantidad fija', proveedorId: '42', stockReal: 0, cantidadManual: true, cantidadPedida: 3 },
    ],
  });

  const r = await api('POST', '/api/mia/conteos/cruce/calcular', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.previsionImporte, 103);
  assert.equal(r.body.rangoDesde, '2026-01-31');
  assert.equal(r.body.rangoHasta, '2026-02-02');
  assert.equal(r.body.multiplicador, 1.5);
  assert.equal(r.body.tramoDesde, 0);
  assert.equal(r.body.tramoHasta, null);
  assert.equal(r.body.lineasSinMaximo, 1);
  const fechas = [...new Set(r.body.desglose.map((d) => d.fecha))].sort();
  assert.deepEqual(fechas, ['2026-01-31', '2026-02-01', '2026-02-02']);
  assert.equal(r.body.desglose.length, 6);
  assert.equal(r.body.desglose.find((d) => d.fecha === festivo && d.localId === '000010').fechaComparativa, comp);

  const porId = Object.fromEntries(r.body.lineas.map((ln) => [ln.productId, ln]));
  assert.equal(porId['501'].maximoFinal, 15);
  assert.equal(porId['501'].cantidadPedida, 12);
  assert.equal(porId['502'].cantidadPedida, 0);
  assert.equal(porId['502'].maximoFinal, null);
  assert.equal(porId['502'].aviso, AVISO_SIN_MAXIMO);
  assert.equal(porId['503'].maximoFinal, 0);
  assert.equal(porId['503'].aviso, null);
  assert.equal(porId['504'].aviso, AVISO_SIN_CONTAR);
  assert.equal(porId['504'].cantidadPedida, 0);
  assert.equal(porId['504'].maximoFinal, 30);
  assert.equal(porId['505'].maximoFinal, 8);
  assert.equal(porId['505'].cantidadPedida, 7);
  assert.equal(porId['506'].maximoFinal, 15);
  assert.equal(porId['506'].cantidadPedida, 3);
  assert.equal(metaDe('cruce').lineasSinMaximo, 1);
  assert.equal(metaDe('cruce').multiplicador, 1.5);
});

test('recalcular en Generado deja el multiplicador nuevo; Pedido o Confirmado lo impide', async () => {
  montar();
  await guardarTramos(null, [{ desde: 0, hasta: null, multiplicador: 1.5 }]);
  config('000101', '501', { maximo: 10, formatoCompra: 6 });
  await crearConteoStock({
    informeId: 're',
    warehouseId: '101',
    semanasDesde: '2026-03-02',
    semanasHasta: '2026-03-08',
    lineas: [{ productId: '501', nombre: 'Tonica', proveedorId: '42', stockReal: 4 }],
  });
  assert.equal((await api('POST', '/api/mia/conteos/re/calcular', {})).body.multiplicador, 1.5);

  await guardarTramos(null, [{ desde: 0, hasta: null, multiplicador: 3 }]);
  const segundo = await api('POST', '/api/mia/conteos/re/calcular', {});
  assert.equal(segundo.status, 200, JSON.stringify(segundo.body));
  assert.equal(segundo.body.multiplicador, 3);
  assert.equal(segundo.body.lineas[0].maximoFinal, 30);
  assert.equal(segundo.body.lineas[0].cantidadPedida, 30);
  assert.equal(metaDe('re').multiplicador, 3);

  await marcarPedidoProveedor('re', '42', { estado: 'confirmado', serie: 'MIA', number: 1 });
  await guardarTramos(null, [{ desde: 0, hasta: null, multiplicador: 4 }]);
  const tercero = await api('POST', '/api/mia/conteos/re/calcular', {});
  assert.equal(tercero.status, 409);
  assert.equal(tercero.body.error, MENSAJE_RECALCULO_BLOQUEADO);
  assert.equal(metaDe('re').multiplicador, 3);
  const linea = db.listar(tables.miaInformeLineas).find((ln) => ln.productId === '501');
  assert.equal(linea.maximoFinal, 30);
  assert.equal(linea.cantidadPedida, 30);
});

test('simular no escribe y un almacén sin local deja la previsión a 0', async () => {
  montar();
  await guardarTramos(null, [{ desde: 0, hasta: null, multiplicador: 1.5 }]);
  await guardarTramos('101', [{ desde: 0, hasta: null, multiplicador: 9 }]);
  config('000101', '501', { maximo: 10, formatoCompra: 6 });
  config('000303', '501', { maximo: 10 });
  await crearConteoStock({
    informeId: 'sim',
    warehouseId: '101',
    semanasDesde: '2026-03-02',
    semanasHasta: '2026-03-08',
    lineas: [{ productId: '501', nombre: 'Tonica', proveedorId: '42', stockReal: 4 }],
  });
  await crearConteoStock({
    informeId: 'isla',
    warehouseId: '303',
    semanasDesde: '2026-03-02',
    semanasHasta: '2026-03-08',
    lineas: [{ productId: '501', nombre: 'Tonica', proveedorId: '42', stockReal: 2 }],
  });
  const primero = await api('POST', '/api/mia/conteos/sim/calcular', {});
  assert.equal(primero.body.multiplicador, 1.5);
  const congelado = metaDe('sim');

  await guardarTramos(null, [{ desde: 0, hasta: null, multiplicador: 4 }]);
  const sim = await api('POST', '/api/mia/conteos/sim/simular', {});
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  assert.equal(sim.body.multiplicador, 4);
  assert.equal(metaDe('sim').multiplicador, 1.5);
  assert.equal(metaDe('sim').calculadoEn, congelado.calculadoEn);
  const otraSemana = await api('POST', '/api/mia/conteos/sim/simular', {
    semanasDesde: '2026-03-16',
    semanasHasta: '2026-03-22',
  });
  assert.equal(otraSemana.status, 200, JSON.stringify(otraSemana.body));
  assert.equal(otraSemana.body.rangoDesde, '2026-03-16');
  assert.equal(otraSemana.body.rangoHasta, '2026-03-22');
  assert.equal(metaDe('sim').semanasDesde, '2026-03-02');
  assert.equal(metaDe('sim').multiplicador, 1.5);
  const linea = db.listar(tables.miaInformeLineas).find((ln) => ln.informeId === 'sim');
  assert.equal(linea.maximoFinal, 15);

  const prueba = await api('POST', '/api/mia/conteos/sim/simular', { previsionImporte: 50 });
  assert.equal(prueba.body.multiplicador, 4);
  assert.equal(prueba.body.previsionImporte, 50);
  assert.equal(metaDe('sim').previsionImporte, congelado.previsionImporte);

  const isla = await calcularConteo('isla');
  assert.equal(isla.previsionImporte, 0);
  assert.equal(isla.previsionAviso, null);
  assert.equal(isla.multiplicador, 4);
  assert.equal(metaDe('isla').previsionImporte, 0);
});

test('sin permiso o con almacén ajeno: 403 y no calcula', async () => {
  montar();
  await guardarTramos('101', [{ desde: 0, hasta: null, multiplicador: 1.5 }]);
  await crearConteoStock({
    informeId: 'mio',
    warehouseId: '101',
    semanasDesde: '2026-03-02',
    semanasHasta: '2026-03-08',
    lineas: [{ productId: '501', nombre: 'Tonica', proveedorId: '42', stockReal: 4 }],
  });
  await crearConteoStock({
    informeId: 'sur',
    warehouseId: '202',
    semanasDesde: '2026-03-02',
    semanasHasta: '2026-03-08',
    lineas: [{ productId: '501', nombre: 'Tonica', proveedorId: '42', stockReal: 4 }],
  });
  const permiso = await api('POST', '/api/mia/conteos/mio/calcular', {}, CAMARERO);
  assert.equal(permiso.status, 403);
  assert.equal(permiso.body.error, 'Permiso insuficiente');
  const ajeno = await api('POST', '/api/mia/conteos/sur/calcular', {});
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.body.error, 'No tienes acceso a este local');
  const simAjeno = await api('POST', '/api/mia/conteos/sur/simular', {});
  assert.equal(simAjeno.status, 403);
  assert.equal(metaDe('mio').multiplicador, null);
  assert.equal(metaDe('sur').multiplicador, null);
});
