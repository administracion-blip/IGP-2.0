/**
 * Interpretación de apoyo del dictado: gpt-4o-mini solo cuando las reglas dudan.
 * El modelo se simula. Las frases son las de la prueba real del conteo.
 * Una propuesta rellena la línea y la deja pendiente: no escribe el conteo.
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
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { crearPlantilla } = await import('../lib/inventarios/plantillas.js');
const { crearInventario } = await import('../lib/inventarios/inventarios.js');
const { crearRouterDictado } = await import('../routes/inventariosDictado.js');
const { listarAlias } = await import('../lib/inventarios/dictado/alias.js');
const { crearFormato } = await import('../lib/inventarios/dictado/formatos.js');
const {
  configurarInterpretacionIa,
  restablecerInterpretacionIa,
  proponerInterpretacion,
  mensajeUsuario,
  listaCerrada,
  debeConsultarIa,
} = await import('../lib/inventarios/dictado/interpretarIa.js');
const { parsearDictado } = await import('../lib/inventarios/dictado/parser.js');

const CONTADOR = { sub: '000020', email: 'contador@test', rol: 'Contador', Nombre: 'Ana' };
const T = () => tables.inventarios;

let servidor = null;
let base = '';
let db = null;
let plantillaId = null;
let llamadasIa = [];
let responder = () => null;

const PRODUCTOS = [
  ['826', 'BALLANTINES 10'],
  ['1350', 'BOT BALLANTINES'],
  ['827', 'BALLANTINES 12'],
  ['464', 'SEAGRAMS'],
  ['749', 'LEGENDARIO'],
  ['566', 'COCA COLA'],
  ['900', 'FANTA NARANJA'],
];

function lineaInv(productId, nombre, extra = {}) {
  return { productId, nombre, familiaNombre: 'BOT', unidad: 'Unidad', stockTeorico: 50, ...extra };
}

async function api(metodo, ruta, cuerpo) {
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const ruta = (id, resto = '') => `/api/inventarios/${id}/dictado${resto}`;
const dictar = (id, texto) => api('POST', ruta(id, '/interpretar'), { texto });

function lineaConteo(id, productId) {
  return db.obtener(T(), { PK: `INV#${id}`, SK: `LINE#${productId}` });
}

async function nuevoInventario(nombres) {
  const lineas = nombres.map(([productId, nombre, extra]) => lineaInv(productId, nombre, extra));
  const inv = await crearInventario({
    warehouseId: '1',
    fecha: '2026-11-02',
    employeeId: '42',
    employeeNombre: 'Ana',
    plantillaId,
    lineas,
  }, 'compras@test');
  return inv.inventarioId;
}

beforeEach(async () => {
  llamadasIa = [];
  responder = () => null;
  configurarInterpretacionIa(async (ctx) => {
    llamadasIa.push(ctx);
    return responder(ctx);
  });
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
  db.sembrar(tables.usuarios, { id_usuario: CONTADOR.sub, Rol: CONTADOR.rol, Locales: [], Email: CONTADOR.email });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Contador', SK: 'PERMISO#inventario.contar' });
  db.sembrar(tables.almacenes, { Id: '1', Nombre: 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro' });
  for (const [id, nombre] of PRODUCTOS) {
    db.sembrar(tables.agoraProducts, {
      PK: 'GLOBAL', SK: id, Id: id, Name: nombre, FamilyId: '12', FamilyName: 'BOT', FormatoBaseNombre: 'Unidad', Active: true,
    });
  }
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = CONTADOR;
      req.log = { info() {}, error() {}, warn() {} };
      next();
    });
    app.use('/api', crearRouterDictado({ exportStocks: async () => [] }));
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const plantilla = await crearPlantilla({
    nombre: 'Barra', modo: 'familias', miembros: [{ id: '12', nombre: 'BOT' }],
  }, 'compras@test');
  plantillaId = plantilla.plantillaId;
});

after(() => {
  restablecerInterpretacionIa();
  servidor?.closeAllConnections?.();
  servidor?.close();
});

test('el mensaje de la IA solo lleva id y nombre de la plantilla', () => {
  const lista = listaCerrada([
    { productId: '749', nombre: 'LEGENDARIO', stockTeorico: 50, stockReal: 3 },
  ]);
  const mensaje = mensajeUsuario({ texto: 'Legendario, cinco', productos: lista });
  assert.equal(mensaje.includes('749'), true);
  assert.equal(mensaje.includes('LEGENDARIO'), true);
  assert.equal(/stockTeorico|stockReal|teórico/i.test(mensaje), false);
  assert.equal(/"stockTeorico"/.test(JSON.stringify(lista)), false);
});

test('un id que no está en la plantilla se ignora', async () => {
  configurarInterpretacionIa(async () => ({ productId: '9999', cantidad: 4, modo: 'sumar' }));
  const propuesta = await proponerInterpretacion({
    texto: 'xyz inventado 4',
    productos: [{ productId: '566', nombre: 'COCA COLA', stockTeorico: 9 }],
  });
  assert.equal(propuesta.productId, null);
  assert.equal(propuesta.cantidad, 4);
  assert.equal(JSON.stringify(propuesta).includes('stockTeorico'), false);
});

test('Legendario, cinco lo resuelven las reglas y no llama a la IA', async () => {
  const id = await nuevoInventario([['749', 'LEGENDARIO']]);
  const r = await dictar(id, 'Legendario, cinco');
  assert.equal(r.status, 201);
  const [l] = r.body.lineas;
  assert.equal(l.productId, '749');
  assert.equal(l.cantidad.total, 5);
  assert.equal(l.confirmar, false);
  assert.equal(l.motivos.includes('propuesto_ia'), false);
  assert.equal(llamadasIa.length, 0);
  assert.equal(lineaConteo(id, '749').stockReal ?? null, null);
});

test('Seagrams va a BOT SEAGRAMS y se aplica solo aunque el catálogo tenga más', async () => {
  db.sembrar(tables.agoraProducts, {
    PK: 'GLOBAL', SK: '464', Id: '464', Name: 'SEAGRAMS', FamilyId: '12', FamilyName: 'BOT', FormatoBaseNombre: 'Unidad', Active: true,
  });
  db.sembrar(tables.agoraProducts, {
    PK: 'GLOBAL', SK: '465', Id: '465', Name: 'CHUPITO SEAGRAMS', FamilyId: '12', FamilyName: 'BOT', FormatoBaseNombre: 'Unidad', Active: true,
  });
  const id = await nuevoInventario([['1351', 'BOT SEAGRAMS']]);
  db.sembrar(T(), {
    PK: 'ALIAS#GLOBAL', SK: 'TXT#seagrams', texto: 'seagrams', productId: '464', productoNombre: 'SEAGRAMS', usos: 3,
  });
  const r = await dictar(id, 'Seagrams catorce');
  const [l] = r.body.lineas;
  assert.equal(l.productId, '1351');
  assert.equal(l.cantidad.total, 14);
  assert.equal(l.confirmar, false);
  assert.equal(llamadasIa.length, 0);
  assert.equal(lineaConteo(id, '464'), null);
});

test('dos Ballantines en la plantilla dejan Bot Ballantines ambiguo', async () => {
  const id = await nuevoInventario([
    ['1350', 'BOT BALLANTINES'],
    ['826', 'BALLANTINES 10'],
  ]);
  const r = await dictar(id, 'Bot Ballantines 14');
  const [l] = r.body.lineas;
  assert.equal(l.productId, null);
  assert.equal(l.confirmar, true);
  assert.ok(l.motivos.includes('marca_ambigua'));
  assert.equal(llamadasIa.length, 0);
});

test('Valentine lo propone la IA y queda pendiente; si no hay propuesta, no está en la plantilla', async () => {
  const id = await nuevoInventario([['826', 'BALLANTINES 10']]);
  responder = ({ texto }) => (
    /valentine/i.test(texto) ? { productId: '826', cantidad: 15, modo: 'sumar' } : null
  );
  const vale = await dictar(id, 'Valentine 10, 15');
  const [sugerida] = vale.body.lineas;
  assert.equal(sugerida.productId, '826');
  assert.equal(sugerida.cantidad.total, 15);
  assert.equal(sugerida.confirmar, true);
  assert.ok(sugerida.motivos.includes('propuesto_ia'));
  assert.equal(sugerida.motivos.includes('no_en_plantilla'), false);
  assert.equal(lineaConteo(id, '826').stockReal ?? null, null);

  const nada = await dictar(id, 'Kahlua tres');
  const [vacia] = nada.body.lineas;
  assert.equal(vacia.productId, null);
  assert.equal(vacia.confirmar, true);
  assert.ok(vacia.motivos.includes('no_en_plantilla'));
  assert.ok(llamadasIa.some((c) => /kahlua/i.test(c.texto)));
});

test('Seagrams catorce ya contado pide confirmar sin llamar a la IA', async () => {
  const id = await nuevoInventario([['464', 'SEAGRAMS', { stockReal: 2, botellasAbiertas: 0 }]]);
  const r = await dictar(id, 'Seagrams catorce');
  const [l] = r.body.lineas;
  assert.equal(l.productId, '464');
  assert.equal(l.cantidad.total, 14);
  assert.equal(l.confirmar, true);
  assert.ok(l.motivos.includes('ya_contado'));
  assert.equal(l.motivos.includes('propuesto_ia'), false);
  assert.equal(llamadasIa.length, 0);
  assert.equal(lineaConteo(id, '464').stockReal, 2);
});

test('Bot Ballantines 14 no se aplica si hay varios Ballantines', async () => {
  const id = await nuevoInventario([
    ['1350', 'BOT BALLANTINES'],
    ['826', 'BALLANTINES 10'],
    ['827', 'BALLANTINES 12'],
  ]);
  const r = await dictar(id, 'Bot Ballantines 14');
  const [l] = r.body.lineas;
  assert.equal(l.productId, null);
  assert.equal(l.confirmar, true);
  assert.ok(l.motivos.includes('marca_ambigua'));
  assert.equal(l.motivos.includes('propuesto_ia'), false);
  assert.equal(llamadasIa.length, 0);
  assert.equal(lineaConteo(id, '1350').stockReal ?? null, null);
  assert.equal(lineaConteo(id, '826').stockReal ?? null, null);
});

test('Bot Ballantines 14 se puede aplicar si es el único Ballantines', async () => {
  const id = await nuevoInventario([['1350', 'BOT BALLANTINES']]);
  const r = await dictar(id, 'Bot Ballantines 14');
  const [l] = r.body.lineas;
  assert.equal(l.productId, '1350');
  assert.equal(l.cantidad.total, 14);
  assert.equal(l.confirmar, false);
  assert.equal(llamadasIa.length, 0);
});

test('Valentine 10, 15 queda como sugerencia pendiente', async () => {
  const id = await nuevoInventario([['826', 'BALLANTINES 10'], ['827', 'BALLANTINES 12']]);
  responder = () => ({ productId: '826', cantidad: 15, modo: 'sumar' });
  const r = await dictar(id, 'Valentine 10, 15');
  const [l] = r.body.lineas;
  assert.equal(l.productId, '826');
  assert.equal(l.cantidad.total, 15);
  assert.equal(l.confirmar, true);
  assert.ok(l.motivos.includes('propuesto_ia'));
  assert.equal(lineaConteo(id, '826').stockReal ?? null, null);
  assert.equal(/stockTeorico/.test(llamadasIa[0].mensaje), false);
});

test('tres filas de diez cajas por 24 = 720, pendiente de confirmar', async () => {
  const id = await nuevoInventario([['566', 'COCA COLA']]);
  responder = ({ texto }) => (
    /tres filas de diez cajas por 24/i.test(texto)
      ? { productId: '566', cantidad: 720, modo: 'sumar' }
      : null
  );
  const r = await dictar(id, 'tres filas de diez cajas por 24');
  const [l] = r.body.lineas;
  assert.equal(l.cantidad.total, 720);
  assert.equal(l.productId, '566');
  assert.equal(l.confirmar, true);
  assert.ok(l.motivos.includes('propuesto_ia'));
  assert.equal(lineaConteo(id, '566').stockReal ?? null, null);
});

test('multiplícalo por 24 continúa la frase anterior y queda pendiente', async () => {
  const id = await nuevoInventario([['566', 'COCA COLA']]);
  responder = ({ texto, anterior }) => {
    if (!/multipl/i.test(texto)) return null;
    assert.match(String(anterior), /coca-cola/i);
    return { productId: '566', cantidad: 720, modo: 'sumar' };
  };
  await dictar(id, 'Coca-Cola, tengo tres filas de diez cajas');
  const r = await dictar(id, 'multiplícalo por 24');
  const [l] = r.body.lineas;
  assert.equal(l.productId, '566');
  assert.equal(l.cantidad.total, 720);
  assert.equal(l.confirmar, true);
  assert.ok(l.motivos.includes('propuesto_ia'));
  assert.equal(lineaConteo(id, '566').stockReal ?? null, null);
});

test('Fanta naranja, dos por ocho por veinticuatro queda en 384 pendiente', async () => {
  const id = await nuevoInventario([['900', 'FANTA NARANJA']]);
  responder = () => ({ productId: '900', cantidad: 384, modo: 'sumar' });
  const r = await dictar(id, 'Fanta naranja, dos por ocho por veinticuatro');
  const [l] = r.body.lineas;
  assert.equal(l.productId, '900');
  assert.equal(l.cantidad.total, 384);
  assert.equal(l.confirmar, true);
  assert.equal(lineaConteo(id, '900').stockReal ?? null, null);
});

test('10 filas por 10 cajas por 24 no enseña el alias envenenado al confirmar', async () => {
  const id = await nuevoInventario([['566', 'COCA COLA']]);
  responder = () => ({ productId: '566', cantidad: 2400, modo: 'sumar' });
  const r = await dictar(id, '10 filas por 10 cajas por 24');
  const [l] = r.body.lineas;
  assert.equal(l.cantidad.total, 2400);
  assert.equal(l.confirmar, true);
  const conf = await api('PATCH', ruta(id, `/lineas/${l.n}`), { estado: 'confirmada' });
  assert.equal(conf.status, 200);
  assert.equal(conf.body.aliasAprendido, false);
  assert.equal(conf.body.aliasMotivo, 'alias_no_valido');
  assert.equal((await listarAlias()).length, 0);
  assert.equal(lineaConteo(id, '566').stockReal ?? null, null);
});

test('la cantidad siguiente no se aplica al producto que la IA ha corregido', async () => {
  const id = await nuevoInventario([['826', 'BALLANTINES 10'], ['749', 'LEGENDARIO']]);
  responder = ({ texto }) => (
    /valentine/i.test(texto) ? { productId: '826', cantidad: 15, modo: 'sumar' } : null
  );
  const r = await dictar(id, 'Valentine 10, 15, más dos');
  const [primera, segunda] = r.body.lineas;
  assert.equal(primera.productId, '826');
  assert.equal(primera.confirmar, true);
  assert.equal(segunda.productId, '826');
  assert.equal(segunda.cantidad.total, 2);
  assert.equal(segunda.confirmar, true);
  assert.equal(lineaConteo(id, '826').stockReal ?? null, null);
  assert.equal(lineaConteo(id, '749').stockReal ?? null, null);
});

test('varias cajas de una marca ambigua no usan el formato de un Ballantines concreto', async () => {
  const id = await nuevoInventario([
    ['1350', 'BOT BALLANTINES'],
    ['826', 'BALLANTINES 10'],
  ]);
  await crearFormato('1350', { unidadesCaja: 6 }, 'ana');
  await crearFormato('826', { unidadesCaja: 24 }, 'ana');
  const r = await dictar(id, '3 cajas de Bot Ballantines');
  const [l] = r.body.lineas;
  assert.equal(l.productId, null);
  assert.ok(l.motivos.includes('marca_ambigua'));
  assert.equal(l.cantidad, null);
  assert.equal(llamadasIa.length, 0);
});

test('un alias de cuenta que ya existía no suma usos al confirmar', async () => {
  const id = await nuevoInventario([['566', 'COCA COLA']]);
  db.sembrar(T(), {
    PK: 'ALIAS#GLOBAL',
    SK: 'TXT#10 filas por 10 cajas por',
    texto: '10 filas por 10 cajas por',
    textoOriginal: '10 filas por 10 cajas por',
    productId: '566',
    productoNombre: 'COCA COLA',
    usos: 4,
  });
  responder = () => ({ productId: '566', cantidad: 2400, modo: 'sumar' });
  const r = await dictar(id, '10 filas por 10 cajas por 24');
  const conf = await api('PATCH', ruta(id, `/lineas/${r.body.lineas[0].n}`), { estado: 'confirmada' });
  assert.equal(conf.body.aliasMotivo, 'alias_no_valido');
  assert.equal((await listarAlias())[0].usos, 4);
});

test('debeConsultarIa no se dispara en un acierto ni en una marca ambigua', () => {
  const limpio = parsearDictado('Legendario, cinco').ordenes[0];
  assert.equal(debeConsultarIa({ orden: limpio, productId: '749', motivos: [] }), false);
  const marca = parsearDictado('Bot Ballantines 14').ordenes[0];
  assert.equal(debeConsultarIa({ orden: marca, productId: null, motivos: ['ambiguo', 'marca_ambigua'] }), false);
  const cuenta = parsearDictado('tres filas de diez cajas por 24').ordenes[0];
  assert.equal(debeConsultarIa({ orden: cuenta, productId: null, motivos: cuenta.motivos }), true);
});
