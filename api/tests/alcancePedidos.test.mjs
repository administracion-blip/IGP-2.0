/**
 * Aislamiento por local en pedidos: un pedido es de quien tenga su local DESTINO
 * (`LocalId`) o el local dueño de su almacén ORIGEN (`AlmacenOrigenId`, vía mapa
 * local ↔ almacén). Así el almacén (DISTRIBUIDORA, dueña del Almacén General)
 * prepara los pedidos de todos los locales sin tenerlos en su lista.
 *
 * Escrituras: bloquean siempre. Listados e informes: siguen `ALCANCE_MODO_LECTURAS`.
 */

import test, { after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alcance-pedidos';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { olvidarAlmacenGeneralCacheado } = await import('../lib/pedidos/almacenGeneral.js');
const { default: pedidosRouter } = await import('../routes/pedidos.js');
const { aplicarClavesGsi, clavesPedido } = await import('../lib/clavesIndice.js');

/** Encargado de Bar Norte (destino de PED-2). */
const LOCAL_NORTE = { sub: '000090', email: 'norte@grupo.test', rol: 'Local' };
/** Almacén: solo DISTRIBUIDORA, dueña del Almacén General (origen de todos los pedidos). */
const ALMACENERO = { sub: '000091', email: 'almacen@grupo.test', rol: 'SuperUser' };
/** Bar Este: ni destino ni origen de PED-1 / PED-2. */
const INTRUSO = { sub: '000092', email: 'este@grupo.test', rol: 'Local' };

const MODO_ORIGINAL = process.env.ALCANCE_MODO_LECTURAS;
function modo(valor) {
  if (valor === undefined) delete process.env.ALCANCE_MODO_LECTURAS;
  else process.env.ALCANCE_MODO_LECTURAS = valor;
}
afterEach(() => modo(MODO_ORIGINAL));

let usuarioActual = LOCAL_NORTE;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
    app.use('/api', pedidosRouter);
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

async function conAvisos(fn) {
  const avisos = [];
  const original = console.warn;
  console.warn = (...args) => {
    if (args[0] === '[alcance] denegaría') avisos.push(args[1]);
  };
  try {
    return { r: await fn(), avisos };
  } finally {
    console.warn = original;
  }
}

let db = null;

function linea(pedidoId, idx) {
  return {
    PedidoId: pedidoId, LineaIndex: String(idx), ProductId: `P${idx}`, ProductoNombre: `Producto ${idx}`,
    Cantidad: 2, PrecioUnitario: 1, PrecioVenta: 1, TotalLinea: 2, TotalRappel: 1, Preparada: false,
  };
}

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.pedidos, {
    hashKey: 'Id',
    indices: {
      'Estado-Fecha-index': { hashKey: 'gsi_estado', rangeKey: 'gsi_fecha' },
      'Local-Fecha-index': { hashKey: 'gsi_local', rangeKey: 'gsi_fecha' },
    },
  });
  db.crearTabla(tables.pedidosLineas, { hashKey: 'PedidoId', rangeKey: 'LineaIndex' });
  db.instalar(docClient);
  for (const p of ['pedidos.borrar', 'pedidos.borrar_enviado', 'pedidos.editar_enviado']) {
    for (const rol of ['Local', 'SuperUser']) db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${p}` });
  }
  db.sembrar(tables.almacenes, { Id: '1', Nombre: 'ALMACEN GENERAL' });
  db.sembrar(tables.almacenes, { Id: '2', Nombre: 'Almacen Norte' });
  db.sembrar(tables.locales, { id_Locales: '000001', nombre: 'DISTRIBUIDORA', empresa: 'Central SL', 'almacen origen': 'ALMACEN GENERAL' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Norte', empresa: 'Norte SL', 'almacen origen': 'Almacen Norte' });
  db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur', empresa: 'Sur SL' });
  db.sembrar(tables.locales, { id_Locales: '000030', nombre: 'Bar Este', empresa: 'Este SL' });
  db.sembrar(tables.usuarios, { id_usuario: '000090', Email: LOCAL_NORTE.email, Rol: 'Local', Local: ['Bar Norte'] });
  db.sembrar(tables.usuarios, { id_usuario: '000091', Email: ALMACENERO.email, Rol: 'SuperUser', Local: ['DISTRIBUIDORA'] });
  db.sembrar(tables.usuarios, { id_usuario: '000092', Email: INTRUSO.email, Rol: 'Local', Local: ['Bar Este'] });
  // PED-1: de Bar Sur, sale del Almacén General y ya está enviado al almacén.
  sembrarPedido({ Id: 'PED-1', LocalId: '000020', AlmacenOrigenId: '1', Estado: 'Enviado', Fecha: '2026-10-01', Notas: '' });
  db.sembrar(tables.pedidosLineas, linea('PED-1', 0));
  db.sembrar(tables.pedidosLineas, linea('PED-1', 1));
  // PED-2: de Bar Norte, en borrador.
  sembrarPedido({ Id: 'PED-2', LocalId: '000010', AlmacenOrigenId: '1', Estado: 'Borrador', Fecha: '2026-10-02', Notas: '' });
  db.sembrar(tables.pedidosLineas, linea('PED-2', 0));
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  olvidarAlmacenGeneralCacheado();
}

function sembrarPedido(item) {
  aplicarClavesGsi(item, clavesPedido(item));
  db.sembrar(tables.pedidos, item);
}

function pedido(id) {
  return db.obtener(tables.pedidos, { Id: id });
}

// ─── El almacén (solo origen) prepara ───

test('el almacén, solo con el local origen, prepara un pedido de otro local hasta completarlo', async () => {
  montar();
  for (const idx of ['0', '1']) {
    const r = await api('PUT', '/api/pedidos/PED-1/lineas', { LineaIndex: idx, Preparada: true }, ALMACENERO);
    assert.equal(r.status, 200, `línea ${idx}`);
  }
  assert.equal(pedido('PED-1').Estado, 'Completado');
  modo('bloquear');
  const lista = await api('GET', '/api/pedidos', undefined, ALMACENERO);
  assert.deepEqual(lista.body.pedidos.map((p) => p.Id).sort(), ['PED-1', 'PED-2']);
  assert.equal((await api('GET', '/api/pedidos/PED-1/lineas', undefined, ALMACENERO)).status, 200);
});

test('el almacén crea pedidos para cualquier local desde su almacén', async () => {
  montar();
  const r = await api('POST', '/api/pedidos', { Fecha: '2026-10-03', LocalId: '000030', AlmacenOrigenId: '1' }, ALMACENERO);
  assert.equal(r.status, 200);
});

// ─── Sin destino ni origen: 403 y sin cambios ───

test('usuario sin destino ni origen: editar, borrar y tocar líneas da 403 y nada cambia', async () => {
  montar();
  const pedidosAntes = db.listar(tables.pedidos);
  const lineasAntes = db.listar(tables.pedidosLineas);
  const ataques = [
    ['PUT', '/api/pedidos', { Id: 'PED-1', Notas: 'cambiado', Estado: 'Completado' }],
    ['DELETE', '/api/pedidos', { Id: 'PED-1' }],
    ['POST', '/api/pedidos/PED-1/lineas', { ProductId: 'PX', Cantidad: 9, PrecioUnitario: 1 }],
    ['PUT', '/api/pedidos/PED-1/lineas', { LineaIndex: '0', Preparada: true }],
    ['PUT', '/api/pedidos/PED-1/lineas', { LineaIndex: '0', Cantidad: 99 }],
    ['DELETE', '/api/pedidos/PED-1/lineas', { LineaIndex: '0' }],
  ];
  for (const [metodo, ruta, cuerpo] of ataques) {
    const r = await api(metodo, ruta, cuerpo, INTRUSO);
    assert.equal(r.status, 403, `${metodo} ${ruta} ${JSON.stringify(cuerpo)}`);
    assert.equal(r.body.error, 'No tienes acceso a este local');
  }
  assert.deepEqual(db.listar(tables.pedidos), pedidosAntes);
  assert.deepEqual(db.listar(tables.pedidosLineas), lineasAntes);
});

test('crear un pedido cuyo destino no es suyo y cuyo origen tampoco: 403 sin escribir', async () => {
  montar();
  const r = await api('POST', '/api/pedidos', { Fecha: '2026-10-03', LocalId: '000020', AlmacenOrigenId: '1' }, INTRUSO);
  assert.equal(r.status, 403);
  assert.equal(db.listar(tables.pedidos).length, 2);
  assert.equal((await api('POST', '/api/pedidos', { Fecha: '2026-10-03', LocalId: '000030', AlmacenOrigenId: '1' }, INTRUSO)).status, 200);
});

test('mover un pedido propio a otro local (sin ser dueño del origen): 403 y el local no cambia', async () => {
  montar();
  const r = await api('PUT', '/api/pedidos', { Id: 'PED-2', LocalId: '000020' }, LOCAL_NORTE);
  assert.equal(r.status, 403);
  assert.equal(pedido('PED-2').LocalId, '000010');
  const ok = await api('PUT', '/api/pedidos', { Id: 'PED-2', Notas: 'dos cajas' }, LOCAL_NORTE);
  assert.equal(ok.status, 200);
  assert.equal(pedido('PED-2').Notas, 'dos cajas');
});

// ─── Carrera entre leer y escribir ───

test('si el pedido cambia de local entre la lectura y la escritura: 409 y no se aplica la edición', async () => {
  montar();
  db.interceptar('UpdateCommand', tables.pedidos, async () => {
    db.sembrar(tables.pedidos, { ...pedido('PED-2'), LocalId: '000020' });
  });
  const r = await api('PUT', '/api/pedidos', { Id: 'PED-2', Notas: 'colada' }, LOCAL_NORTE);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'El pedido ha cambiado, vuelve a cargarlo');
  assert.equal(pedido('PED-2').LocalId, '000020');
  assert.equal(pedido('PED-2').Notas, '');
});

test('pedido sin AlmacenOrigenId: la condición lo acepta si sigue sin él', async () => {
  montar();
  sembrarPedido({ Id: 'PED-4', LocalId: '000010', Estado: 'Borrador', Fecha: '2026-10-06', Notas: '' });
  const r = await api('PUT', '/api/pedidos', { Id: 'PED-4', Notas: 'ok' }, LOCAL_NORTE);
  assert.equal(r.status, 200);
  assert.equal(pedido('PED-4').Notas, 'ok');
});

// ─── Marcar traspasos exportados ───

test('marcar traspasos con un pedido ajeno en la lista: 403 sin marcar ninguno, tampoco el propio', async () => {
  montar();
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#pedidos.exportar_traspaso' });
  const r = await api('POST', '/api/pedidos/traspaso-export/marcar', { pedidoIds: ['PED-2', 'PED-1'] }, LOCAL_NORTE);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'No tienes acceso a este local');
  assert.equal(pedido('PED-1').TraspasoExportadoEn, undefined);
  assert.equal(pedido('PED-2').TraspasoExportadoEn, undefined);

  const ok = await api('POST', '/api/pedidos/traspaso-export/marcar', { pedidoIds: ['PED-2', 'NO-EXISTE'] }, LOCAL_NORTE);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.marcados, 1);
  assert.ok(pedido('PED-2').TraspasoExportadoEn);
});

// ─── Devoluciones: el local que devuelve tiene que ser suyo ───

const OFICINA = { sub: '000093', email: 'oficina@grupo.test', rol: 'SuperUser' };

function sembrarDevolucionNorte() {
  db.sembrar(tables.usuarios, { id_usuario: '000093', Email: OFICINA.email, Rol: 'SuperUser', Local: [] });
  // PED-3: devolución de Bar Norte desde su almacén al General.
  db.sembrar(tables.pedidos, {
    Id: 'PED-3', LocalId: '000010', AlmacenOrigenId: '2', AlmacenDestinoId: '1',
    Tipo: 'Devolucion', Estado: 'Borrador', Fecha: '2026-10-04', Notas: '',
  });
}

test('crear una devolución a nombre de otro local desde su almacén: 403 sin escribir', async () => {
  montar();
  const ataque = { Fecha: '2026-10-05', Tipo: 'Devolucion', LocalId: '000020', AlmacenOrigenId: '2', AlmacenDestinoId: '1' };
  const r = await api('POST', '/api/pedidos', ataque, LOCAL_NORTE);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'No tienes acceso a este local');
  assert.equal(db.listar(tables.pedidos).length, 2);

  const propia = await api('POST', '/api/pedidos', { ...ataque, LocalId: '000010' }, LOCAL_NORTE);
  assert.equal(propia.status, 200);
  assert.equal(propia.body.pedido.Tipo, 'Devolucion');
});

test('editar para dejar una devolución a nombre de otro local: 403 y el pedido no cambia', async () => {
  montar();
  sembrarDevolucionNorte();
  const ataques = [
    { Id: 'PED-3', LocalId: '000020' },
    { Id: 'PED-2', LocalId: '000020', AlmacenOrigenId: '2', AlmacenDestinoId: '1', Tipo: 'Devolucion' },
  ];
  for (const cuerpo of ataques) {
    const r = await api('PUT', '/api/pedidos', cuerpo, LOCAL_NORTE);
    assert.equal(r.status, 403, JSON.stringify(cuerpo));
  }
  assert.equal(pedido('PED-3').LocalId, '000010');
  assert.equal(pedido('PED-2').LocalId, '000010');
  assert.equal(pedido('PED-2').Tipo, undefined);
});

test('convertir una devolución desde su almacén en pedido: es venta entre locales y pide el permiso', async () => {
  montar();
  sembrarDevolucionNorte();
  const r = await api('PUT', '/api/pedidos', { Id: 'PED-3', Tipo: 'Pedido' }, LOCAL_NORTE);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /almacén de otro local/);
  assert.equal(pedido('PED-3').Tipo, 'Devolucion');
});

test('editar su devolución sin cambiar el movimiento sigue funcionando; el global la mueve', async () => {
  montar();
  sembrarDevolucionNorte();
  const ok = await api('PUT', '/api/pedidos', { Id: 'PED-3', Notas: 'tres cajas' }, LOCAL_NORTE);
  assert.equal(ok.status, 200);
  assert.equal(pedido('PED-3').Notas, 'tres cajas');
  const global = await api('PUT', '/api/pedidos', { Id: 'PED-3', LocalId: '000020' }, OFICINA);
  assert.equal(global.status, 200);
  assert.equal(pedido('PED-3').LocalId, '000020');
});

// ─── Lecturas ───

test('listado y líneas en observar: todo + aviso', async () => {
  montar();
  modo(undefined);
  const lista = await conAvisos(() => api('GET', '/api/pedidos', undefined, INTRUSO));
  assert.equal(lista.r.status, 200);
  assert.deepEqual(lista.r.body.pedidos.map((p) => p.Id).sort(), ['PED-1', 'PED-2']);
  assert.equal(lista.avisos.length, 1);
  assert.equal(lista.avisos[0].ruta, '/api/pedidos');
  assert.equal(lista.avisos[0].locales.length, 2);

  const lineas = await conAvisos(() => api('GET', '/api/pedidos/PED-1/lineas', undefined, INTRUSO));
  assert.equal(lineas.r.status, 200);
  assert.equal(lineas.r.body.lineas.length, 2);
  assert.equal(lineas.avisos.length, 1);
});

test('listado y líneas en bloquear: solo destino u origen; el resto 403', async () => {
  montar();
  modo('bloquear');
  assert.deepEqual((await api('GET', '/api/pedidos', undefined, INTRUSO)).body.pedidos, []);
  assert.deepEqual((await api('GET', '/api/pedidos', undefined, LOCAL_NORTE)).body.pedidos.map((p) => p.Id), ['PED-2']);
  for (const ruta of ['/api/pedidos/PED-1/lineas', '/api/pedidos/PED-1/details']) {
    const r = await api('GET', ruta, undefined, INTRUSO);
    assert.equal(r.status, 403, ruta);
    assert.equal(r.body.lineas ?? r.body.details, undefined);
  }
  assert.equal((await api('GET', '/api/pedidos/PED-2/details', undefined, LOCAL_NORTE)).status, 200);
});

test('informe de abonos/ventas: observar todo + aviso; bloquear solo destino u origen', async () => {
  montar();
  const ruta = '/api/pedidos/abonos?empresa=Sur%20SL&anio=2026&modo=abonos';
  modo(undefined);
  const obs = await conAvisos(() => api('GET', ruta, undefined, INTRUSO));
  assert.deepEqual(obs.r.body.pedidos.map((p) => p.Id), ['PED-1']);
  assert.equal(obs.avisos.length, 1);
  modo('bloquear');
  const r = await api('GET', ruta, undefined, INTRUSO);
  assert.deepEqual(r.body.pedidos, []);
  assert.equal(r.body.total, 0);
  assert.deepEqual((await api('GET', ruta, undefined, ALMACENERO)).body.pedidos.map((p) => p.Id), ['PED-1']);
});
