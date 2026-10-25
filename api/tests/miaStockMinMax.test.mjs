/**
 * MIA fase 1: stock mínimo/máximo con plazo y frecuencia.
 *
 *   consumoDiario = demanda ajustada SIN colchón / días del periodo
 *   mínimo = consumoDiario × (plazo + colchón)
 *   máximo = consumoDiario × (plazo + frecuencia + colchón)
 *   aPedir = max(0, máximo − stock − enCamino), redondeado al formato de compra
 *
 * Sin plazo o sin frecuencia: fórmula clásica y mínimo/máximo/semáforo a null.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const {
  aplicarColchon,
  calcularMinMax,
  factorColchon,
  redondearCantidadCompra,
  resolverPlazoFrecuencia,
  semaforoStock,
} = await import('../lib/mia/demanda.js');
const { buildLineaPedido } = await import('../lib/mia/motor.js');
const { recalcTotales } = await import('../lib/mia/informes.js');
const { upsertConfigProducto, CONFIG_PRESERVE_KEYS } = await import('../lib/mia/configProducto.js');
const {
  PK_MIA_PROVEEDORES,
  claveProveedor,
  listProveedoresConfig,
  mapaProveedoresConfig,
  upsertProveedorConfig,
} = await import('../lib/mia/proveedoresConfig.js');

const sendOriginal = docClient.send;
after(() => {
  docClient.send = sendOriginal;
});

function base(overrides = {}) {
  return {
    productId: '501',
    config: { Quantity: 0 },
    agora: { CostPrice: 2, Name: 'Tónica' },
    ultima: { SupplierId: '12', SupplierName: 'Bebidas SL' },
    warehouseId: '000101',
    demandaBaseTotal: 70,
    demandaAjustada: 70,
    consumoDiario: 10,
    colchonDias: 0,
    proveedoresCfg: new Map(),
    modoDemanda: 'directo',
    ...overrides,
  };
}

// ─── Funciones puras ─────────────────────────────────────────────────────────

test('consumoDiario: quitar el colchón deshace exactamente aplicarColchon', () => {
  const n = 7;
  const c = 2;
  const sinColchon = 70;
  const conColchon = aplicarColchon(sinColchon, n, c);
  assert.equal(conColchon, 90);
  assert.equal(conColchon / factorColchon(n, c) / n, 10);
  assert.equal(factorColchon(0, 3), 1);
});

test('mínimo y máximo: el colchón entra en los dos; sin plazo o frecuencia, null', () => {
  assert.deepEqual(
    calcularMinMax({ consumoDiario: 10, plazoDias: 2, frecuenciaDias: 7, colchonDias: 1 }),
    { minimo: 30, maximo: 100 },
  );
  assert.equal(calcularMinMax({ consumoDiario: 10, plazoDias: 2, frecuenciaDias: null, colchonDias: 1 }), null);
  assert.equal(calcularMinMax({ consumoDiario: 10, plazoDias: null, frecuenciaDias: 7, colchonDias: 1 }), null);
  assert.deepEqual(
    calcularMinMax({ consumoDiario: 10, plazoDias: 0, frecuenciaDias: 0, colchonDias: 0 }),
    { minimo: 0, maximo: 0 },
    'plazo 0 es un valor válido, no «sin plazo»',
  );
});

test('semáforo: rojo bajo mínimo, verde entre mínimo y máximo (ambos incluidos), azul sobre máximo', () => {
  assert.equal(semaforoStock(29, 30, 100), 'rojo');
  assert.equal(semaforoStock(30, 30, 100), 'verde');
  assert.equal(semaforoStock(100, 30, 100), 'verde');
  assert.equal(semaforoStock(101, 30, 100), 'azul');
  assert.equal(semaforoStock(5, null, null), null);
});

test('plazo y frecuencia: el del producto gana campo a campo al del proveedor', () => {
  const prov = { plazoDias: 3, frecuenciaDias: 7 };
  assert.deepEqual(resolverPlazoFrecuencia({}, prov), { plazoDias: 3, frecuenciaDias: 7 });
  assert.deepEqual(
    resolverPlazoFrecuencia({ plazoProveedorDias: 1 }, prov),
    { plazoDias: 1, frecuenciaDias: 7 },
  );
  assert.deepEqual(
    resolverPlazoFrecuencia({ plazoProveedorDias: 0, frecuenciaPedidoDias: 14 }, prov),
    { plazoDias: 0, frecuenciaDias: 14 },
  );
  assert.deepEqual(resolverPlazoFrecuencia({}, null), { plazoDias: null, frecuenciaDias: null });
});

// ─── Línea de pedido ─────────────────────────────────────────────────────────

test('con plazo y frecuencia pide hasta el máximo y rellena los campos nuevos', () => {
  const proveedoresCfg = new Map([['12', { plazoDias: 2, frecuenciaDias: 7 }]]);
  const built = buildLineaPedido(base({ config: { Quantity: 25 }, colchonDias: 1, proveedoresCfg }));
  const l = built.linea;
  assert.equal(l.minimo, 30);
  assert.equal(l.maximo, 100);
  assert.equal(l.qty, 75, 'máximo 100 − stock 25 − en camino 0');
  assert.equal(l.costeLinea, 150);
  assert.equal(l.consumoDiario, 10);
  assert.equal(l.enCamino, 0);
  assert.equal(l.semaforo, 'rojo');
  assert.equal(l.plazoDias, 2);
  assert.equal(l.frecuenciaDias, 7);
});

test('el SupplierId con ceros a la izquierda encuentra la config del proveedor', () => {
  const proveedoresCfg = new Map([['12', { plazoDias: 2, frecuenciaDias: 7 }]]);
  const built = buildLineaPedido(base({ ultima: { SupplierId: '000012' }, proveedoresCfg }));
  assert.equal(built.linea.maximo, 90);
});

test('la línea guarda qtyCalculada, que el ajuste manual no pisa', () => {
  const built = buildLineaPedido(base({ config: { Quantity: 20 }, demandaAjustada: 90 }));
  assert.equal(built.linea.qtyCalculada, 70);
});

test('el ruido de coma flotante al quitar el colchón no sube una unidad', () => {
  assert.equal(redondearCantidadCompra(75.00000000000003, null), 75);
  assert.equal(redondearCantidadCompra(72.00000000000001, 24), 72);
  assert.equal(redondearCantidadCompra(75.01, null), 76);
  assert.equal(redondearCantidadCompra(1e-12, null), 0);
  // 7 días con 1 de colchón: 70 → 80 → 70/7 = 10 sin ruido apreciable.
  const consumo = aplicarColchon(70, 7, 1) / factorColchon(7, 1) / 7;
  const mm = calcularMinMax({ consumoDiario: consumo, plazoDias: 2, frecuenciaDias: 5, colchonDias: 1 });
  assert.equal(redondearCantidadCompra(mm.maximo, null), 80);
});

test('redondea al formato de compra', () => {
  const built = buildLineaPedido(base({
    config: { Quantity: 25, plazoProveedorDias: 2, frecuenciaPedidoDias: 7, formatoCompra: 24 },
    colchonDias: 1,
  }));
  assert.equal(built.linea.qty, 96, '75 → siguiente múltiplo de 24');
});

test('stock por encima del máximo: línea guardada con aPedir 0 y semáforo azul', () => {
  const built = buildLineaPedido(base({
    config: { Quantity: 120, plazoProveedorDias: 2, frecuenciaPedidoDias: 7 },
    colchonDias: 1,
  }));
  assert.ok(built, 'la línea con 0 se guarda para ver el semáforo');
  assert.equal(built.linea.qty, 0);
  assert.equal(built.linea.costeLinea, 0);
  assert.equal(built.linea.semaforo, 'azul');
});

test('stock entre mínimo y máximo: pide hasta el máximo y semáforo verde', () => {
  const built = buildLineaPedido(base({
    config: { Quantity: 50, plazoProveedorDias: 2, frecuenciaPedidoDias: 7 },
    colchonDias: 1,
  }));
  assert.equal(built.linea.qty, 50);
  assert.equal(built.linea.semaforo, 'verde');
});

test('sin plazo ni frecuencia: fórmula clásica (demanda ajustada − stock) y campos a null', () => {
  const built = buildLineaPedido(base({ config: { Quantity: 20 }, demandaAjustada: 90 }));
  const l = built.linea;
  assert.equal(l.qty, 70);
  assert.equal(l.minimo, null);
  assert.equal(l.maximo, null);
  assert.equal(l.semaforo, null);
  assert.equal(l.enCamino, 0);
});

test('fórmula clásica con stock suficiente: línea con 0 y sin semáforo', () => {
  const built = buildLineaPedido(base({ config: { Quantity: 200 }, demandaAjustada: 90 }));
  assert.equal(built.linea.qty, 0);
  assert.equal(built.linea.semaforo, null);
});

test('producto sin demanda ni stock: no genera línea', () => {
  const built = buildLineaPedido(base({ config: { Quantity: 0 }, demandaAjustada: 0, consumoDiario: 0 }));
  assert.equal(built, null);
});

// ─── Totales ─────────────────────────────────────────────────────────────────

test('totales: las líneas con 0 no cuentan, igual que en la aprobación', () => {
  const t = recalcTotales([
    { qty: 10, cantidadPedida: 10, costeLinea: 20 },
    { qty: 5, cantidadPedida: 5, costeLinea: 7.5, omitida: true },
    { qty: 0, cantidadPedida: 0, costeLinea: 0 },
    { qty: 0, cantidadPedida: 0, costeLinea: 0 },
  ]);
  assert.equal(t.lineas, 2, 'cuenta las líneas con cantidad, omitidas incluidas');
  assert.equal(t.lineasSinPedido, 2);
  assert.equal(t.productosConPedido, 1);
  assert.equal(t.unidadesPedido, 10);
  assert.equal(t.costeTotal, 20);
});

test('totales de un informe antiguo (todas las líneas con cantidad) no cambian', () => {
  const t = recalcTotales([
    { qty: 3, cantidadPedida: 3, costeLinea: 6 },
    { qty: 4, cantidadPedida: 4, costeLinea: 8, omitida: true },
  ]);
  assert.equal(t.lineas, 2);
  assert.equal(t.lineasSinPedido, 0);
  assert.equal(t.productosConPedido, 1);
  assert.equal(t.costeTotal, 6);
});

// ─── Persistencia ────────────────────────────────────────────────────────────

test('config de producto: plazo y frecuencia se guardan, se validan y vacío los quita', async () => {
  assert.ok(CONFIG_PRESERVE_KEYS.includes('plazoProveedorDias'));
  assert.ok(CONFIG_PRESERVE_KEYS.includes('frecuenciaPedidoDias'));

  const db = crearDynamoMemoria();
  db.crearTabla(tables.miaConfigProducto, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);

  const item = await upsertConfigProducto({
    warehouseId: '101',
    productId: '501',
    plazoProveedorDias: '2',
    frecuenciaPedidoDias: 7,
  });
  assert.equal(item.plazoProveedorDias, 2);
  assert.equal(item.frecuenciaPedidoDias, 7);

  await assert.rejects(
    upsertConfigProducto({ warehouseId: '101', productId: '501', plazoProveedorDias: 'abc' }),
    (err) => err.status === 400,
  );
  await assert.rejects(
    upsertConfigProducto({ warehouseId: '101', productId: '501', frecuenciaPedidoDias: -1 }),
    (err) => err.status === 400,
  );

  const sinPlazo = await upsertConfigProducto({
    warehouseId: '101',
    productId: '501',
    plazoProveedorDias: '',
  });
  assert.equal(sinPlazo.plazoProveedorDias, undefined);
  assert.equal(sinPlazo.frecuenciaPedidoDias, 7, 'el campo que no viene se conserva');
});

test('config de proveedor: Igp_Ajustes con PK mia_proveedores y SK = id sin ceros', async () => {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.sembrar(tables.ajustes, { PK: 'MIA_GRUPOS_FAMILIAS', SK: 'g1', nombre: 'Bebidas' });
  db.instalar(docClient);

  assert.equal(claveProveedor('000012'), '12');
  assert.equal(claveProveedor('SIN_PROVEEDOR'), '');

  await upsertProveedorConfig(
    { proveedorId: '000012', proveedorNombre: 'Bebidas SL', plazoDias: '2', frecuenciaDias: 7 },
    { email: 'compras@grupo.test' },
  );
  const guardado = db.obtener(tables.ajustes, { PK: PK_MIA_PROVEEDORES, SK: '12' });
  assert.equal(guardado.plazoDias, 2);
  assert.equal(guardado.frecuenciaDias, 7);
  assert.equal(guardado.actualizadoPor, 'compras@grupo.test');

  const lista = await listProveedoresConfig();
  assert.deepEqual(lista.map((p) => p.proveedorId), ['12'], 'no mezcla otras PK de Igp_Ajustes');

  const mapa = await mapaProveedoresConfig();
  assert.deepEqual(mapa.get('12').plazoDias, 2);

  await upsertProveedorConfig({ proveedorId: '12', frecuenciaDias: 14 });
  const parcial = db.obtener(tables.ajustes, { PK: PK_MIA_PROVEEDORES, SK: '12' });
  assert.equal(parcial.frecuenciaDias, 14);
  assert.equal(parcial.plazoDias, 2, 'el campo que no viene se conserva');
  assert.equal(parcial.proveedorNombre, 'Bebidas SL', 'sin nombre no borra el guardado');

  await upsertProveedorConfig({ proveedorId: '12', plazoDias: '' });
  assert.equal(db.obtener(tables.ajustes, { PK: PK_MIA_PROVEEDORES, SK: '12' }).plazoDias, null);

  await assert.rejects(upsertProveedorConfig({ proveedorId: '' }), (err) => err.status === 400);
  await assert.rejects(
    upsertProveedorConfig({ proveedorId: '12', plazoDias: 'x' }),
    (err) => err.status === 400,
  );
});
