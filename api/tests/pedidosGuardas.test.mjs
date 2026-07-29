/**
 * Pruebas de las guardas de `api/routes/pedidos.js` frente a la facturación
 * mensual del almacén.
 *
 * Lo que se comprueba aquí es una sola cosa dicha de varias formas: que ninguna
 * escritura de este router pueda cambiar el importe o el periodo de un pedido ya
 * facturado, ni siquiera cuando la factura se escribe **entre** la lectura de la
 * guarda y la escritura. Ese hueco es el que se cuela a las 06:00 del día 1, que
 * es a la vez la hora del trabajo programado y la hora de cierre de los locales.
 *
 * El router se monta en un servidor de verdad para probar también los códigos de
 * estado, que son lo que el frontend traduce a un mensaje.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

// El router arrastra el middleware de autenticación, que exige un secreto de
// firma al cargarse. Aquí no se firma ningún token: `req.user` se inyecta directo.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-pedidos';

const {
  montarEscenario,
  tables,
  empresa,
  local,
  almacen,
  pedido,
  lineaPedido,
  EMPRESA_NORTE,
  EMPRESA_SUR,
} = await import('./escenarioFacturacion.mjs');

const { default: pedidosRouter } = await import('../routes/pedidos.js');
const { olvidarAlmacenGeneralCacheado } = await import('../lib/pedidos/almacenGeneral.js');

/** Administrador: `hasPermission` lo da por bueno sin leer la tabla de permisos. */
const ADMIN = { email: 'jefe@grupo.test', rol: 'Administrador' };
/** Encargado sin ningún permiso concedido: el que las guardas de permiso frenan. */
const ENCARGADO = { email: 'encargado@grupo.test', rol: 'Encargado' };

/**
 * Marca tal como la escribe el generador: un UUID y el periodo. **Sin número**,
 * porque los documentos generados nacen en borrador y el número se reserva al
 * emitirlos: sembrarlo aquí a mano tapaba que el mensaje de rechazo iba a nombrar
 * un UUID ilegible.
 */
const FACTURA = {
  factura_ventas_id: '9a1f6ba9-1508-4c2f-9d3f-2b1c5e0f7a41',
  factura_ventas_periodo: '2026-06',
  factura_ventas_fecha: '2026-07-01T06:00:00.000Z',
  factura_ventas_ejecucion: 'ejecucion-1',
  factura_ventas_id_empresa: '000001',
};

let usuarioActual = ADMIN;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario = ADMIN) {
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
  return { status: res.status, body: await res.json() };
}

after(() => {
  // `fetch` deja las conexiones abiertas: sin cerrarlas el proceso no termina.
  servidor?.closeAllConnections?.();
  servidor?.close();
});

/**
 * Grupo mínimo: Almacén General, un almacén de local y dos locales de sociedades
 * distintas. La caché del criterio del Almacén General vive en el módulo, así que
 * se olvida en cada prueba para que una no herede el maestro de la anterior.
 */
function escenario(opciones) {
  olvidarAlmacenGeneralCacheado();
  const db = montarEscenario(opciones);
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.acuerdos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.acuerdosDetalles, { hashKey: 'PK', rangeKey: 'SK' });
  db.sembrar(tables.almacenes, almacen('ALM-GEN', 'ALMACEN GENERAL'));
  db.sembrar(tables.almacenes, almacen('ALM-NORTE', 'Almacen Norte'));
  db.sembrar(tables.locales, local('000010', 'Bar Norte', EMPRESA_NORTE, ['Almacen Norte']));
  db.sembrar(tables.locales, local('000020', 'Bar Sur', EMPRESA_SUR));
  db.sembrar(tables.empresas, empresa(EMPRESA_NORTE, 'Norte'));
  db.sembrar(tables.empresas, empresa(EMPRESA_SUR, 'Sur'));
  return db;
}

/** Marca el pedido como facturado, que es lo que hace el reclamo del generador. */
function facturar(db, id, marca = FACTURA) {
  const actual = db.obtener(tables.pedidos, { Id: id });
  db.sembrar(tables.pedidos, { ...actual, ...marca });
}

/**
 * Cuela la factura justo antes de la escritura indicada, para simular el reclamo
 * del generador entre la guarda y la escritura.
 *
 * Devuelve la comprobación de que el gatillo saltó: si un refactor cambia la
 * operación con la que el handler escribe, la prueba lo dice en vez de pasar (o
 * fallar) por un motivo que no tiene nada que ver con la carrera.
 */
function facturarAntesDe(db, operacion, tabla, id = 'PED-1') {
  let salto = false;
  db.interceptar(operacion, tabla, () => {
    salto = true;
    facturar(db, id);
  });
  return () => assert.ok(salto, `no se interceptó ${operacion} sobre ${tabla}: la prueba ya no comprueba la carrera`);
}

// ─── Crítico 1: PUT /pedidos no puede pisar la marca ───

test('el PUT rechaza la edición si la factura se escribe entre la lectura y la escritura', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { Estado: 'Enviado', Notas: '' }));
  // El generador reclama el pedido justo después de que la guarda leyera limpio.
  const comprobarGatillo = facturarAntesDe(db, 'UpdateCommand', tables.pedidos);

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', Notas: 'Falta una caja' });
  comprobarGatillo();
  assert.equal(r.status, 409);
  assert.match(r.body.error, /factura de venta de mercancía de junio de 2026/, 'el mensaje sitúa el documento');

  const guardado = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.equal(guardado.factura_ventas_id, FACTURA.factura_ventas_id, 'la marca sigue puesta');
  assert.equal(guardado.Notas, '', 'la edición no se ha aplicado');
});

test('el PUT no revierte el contador de líneas ni la exportación que escriba otro proceso', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { Estado: 'Enviado', Notas: '', lineas_rev: 7 }));
  // Mientras el encargado escribía la nota, el almacén añadió una línea y otro
  // usuario exportó el traspaso. Reconstruir el ítem entero borraba las dos cosas.
  db.interceptar('UpdateCommand', tables.pedidos, () => {
    const actual = db.obtener(tables.pedidos, { Id: 'PED-1' });
    db.sembrar(tables.pedidos, { ...actual, lineas_rev: 8, TraspasoExportadoEn: '2026-07-01T08:00:00.000Z' });
  });

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', Notas: 'Falta una caja' });
  assert.equal(r.status, 200);
  const guardado = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.equal(guardado.Notas, 'Falta una caja');
  assert.equal(guardado.lineas_rev, 8, 'el contador de revisión no se pisa');
  assert.equal(guardado.TraspasoExportadoEn, '2026-07-01T08:00:00.000Z');
});

test('el PUT sobre un pedido que desaparece a la vez devuelve 404 y no lo resucita', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { Estado: 'Enviado' }));
  // Otro usuario lo borra mientras se editaba: crear la tabla de nuevo la vacía.
  db.interceptar('UpdateCommand', tables.pedidos, () => db.crearTabla(tables.pedidos, { hashKey: 'Id' }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', Notas: 'Nota' });
  assert.equal(r.status, 404);
  assert.equal(db.listar(tables.pedidos).length, 0);
});

test('una edición normal escribe exactamente los mismos campos que antes', async () => {
  const db = escenario();
  const original = {
    Id: 'PED-1',
    LocalId: '000010',
    AlmacenOrigenId: 'ALM-GEN',
    AlmacenDestinoId: 'ALM-NORTE',
    TotalAlbaran: 12.5,
    Fecha: '2026-06-10',
    Estado: 'Borrador',
    Tipo: 'Pedido',
    Notas: '',
    CreadoEn: '2026-06-10T08:00:00.000Z',
    CreadoPor: 'bar@grupo.test',
    lineas_rev: 3,
  };
  db.sembrar(tables.pedidos, original);

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', Notas: 'Falta una caja', TotalAlbaran: '30,5' });
  assert.equal(r.status, 200);
  const guardado = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.deepEqual(guardado, { ...original, Notas: 'Falta una caja', TotalAlbaran: 30 });
  assert.deepEqual(r.body.pedido, guardado, 'la respuesta es el pedido tal como quedó');
});

test('sacar el pedido de completado le sigue quitando la fecha de completado', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { CompletadoPor: 'almacen@grupo.test' }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', Estado: 'Pendiente' });
  assert.equal(r.status, 200);
  const guardado = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.equal(guardado.Estado, 'Pendiente');
  assert.equal(guardado.CompletadoEn, undefined);
  assert.equal(guardado.CompletadoPor, undefined);
});

test('completar desde el PUT congela la sociedad del local y conserva la fecha existente', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { Estado: 'Pendiente', CompletadoEn: undefined }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', Estado: 'Completado' });
  assert.equal(r.status, 200);
  const guardado = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.equal(guardado.factura_id_empresa_local, EMPRESA_NORTE);
  assert.ok(guardado.CompletadoEn, 'se fecha al completar');

  // Una segunda edición no vuelve a fecharlo ni cambia la sociedad congelada.
  await api('PUT', '/api/pedidos', { Id: 'PED-1', Estado: 'Completado', Notas: 'ok' });
  const otra = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.equal(otra.CompletadoEn, guardado.CompletadoEn);
  assert.equal(otra.factura_id_empresa_local, EMPRESA_NORTE);
});

// ─── Crítico 3: la sociedad congelada no sobrevive a un cambio de local ───

test('cambiar el local de un pedido completado recongela la sociedad del local nuevo', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { factura_id_empresa_local: EMPRESA_NORTE }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', LocalId: '000020' });
  assert.equal(r.status, 200);
  const guardado = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.equal(guardado.LocalId, '000020');
  assert.equal(guardado.factura_id_empresa_local, EMPRESA_SUR, 'la sociedad es la del local nuevo');
});

test('cambiar el local de un pedido sin completar borra la sociedad congelada', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { Estado: 'Pendiente', factura_id_empresa_local: EMPRESA_NORTE }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', LocalId: '000020' });
  assert.equal(r.status, 200);
  assert.equal(
    db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_id_empresa_local,
    undefined,
    'volverá a congelarse cuando el almacén lo complete',
  );
});

test('si el local nuevo no tiene sociedad, la congelada del anterior no se queda', async () => {
  const db = escenario();
  db.sembrar(tables.locales, local('000030', 'Bar Este', ''));
  db.sembrar(tables.pedidos, pedido('PED-1', { factura_id_empresa_local: EMPRESA_NORTE }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', LocalId: '000030' });
  assert.equal(r.status, 200);
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_id_empresa_local, undefined);
});

// ─── Crítico 2: las escrituras de línea se reclaman antes de escribir ───

test('no se puede cambiar una línea si la factura llega entre la guarda y la escritura', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { lineas_rev: 7 }));
  db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', '0', { Cantidad: 2, TotalLinea: 20 }));
  const comprobarGatillo = facturarAntesDe(db, 'UpdateCommand', tables.pedidos);

  const r = await api('PUT', '/api/pedidos/PED-1/lineas', { LineaIndex: '0', Cantidad: 99 });
  comprobarGatillo();
  assert.equal(r.status, 409);
  assert.match(r.body.error, /junio de 2026/);

  const linea = db.obtener(tables.pedidosLineas, { PedidoId: 'PED-1', LineaIndex: '0' });
  assert.equal(linea.Cantidad, 2, 'la línea no se ha reescrito');
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).lineas_rev, 7, 'el contador no se mueve');
});

test('no se puede añadir una línea si la factura llega entre la guarda y la escritura', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { lineas_rev: 7 }));
  db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', '0'));
  const comprobarGatillo = facturarAntesDe(db, 'UpdateCommand', tables.pedidos);

  const r = await api('POST', '/api/pedidos/PED-1/lineas', { ProductId: 'P1', Cantidad: 5, PrecioUnitario: 1 });
  comprobarGatillo();
  assert.equal(r.status, 409);
  assert.equal(db.listar(tables.pedidosLineas).length, 1, 'la línea nueva no se escribe');
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).lineas_rev, 7);
});

test('no se puede borrar una línea si la factura llega entre la guarda y la escritura', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { lineas_rev: 7 }));
  db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', '0'));
  const comprobarGatillo = facturarAntesDe(db, 'UpdateCommand', tables.pedidos);

  const r = await api('DELETE', '/api/pedidos/PED-1/lineas', { LineaIndex: '0' });
  comprobarGatillo();
  assert.equal(r.status, 409);
  assert.equal(db.listar(tables.pedidosLineas).length, 1, 'la línea sigue ahí');
});

test('borrar el pedido no deja una factura sin pedido si se factura a la vez', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1'));
  db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', '0'));
  // Se reclama justo antes del borrado de la cabecera, que es lo primero que se
  // borra: si esa escritura no fuera condicional, la marca desaparecería con ella
  // y el barrido de reconciliación no podría liberar la factura.
  const comprobarGatillo = facturarAntesDe(db, 'DeleteCommand', tables.pedidos);

  const r = await api('DELETE', '/api/pedidos', { Id: 'PED-1' });
  comprobarGatillo();
  assert.equal(r.status, 409);
  assert.match(r.body.error, /junio de 2026/);
  const guardado = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.ok(guardado, 'la cabecera con la marca sigue ahí');
  assert.equal(guardado.factura_ventas_id, FACTURA.factura_ventas_id);
  assert.equal(db.listar(tables.pedidosLineas).length, 1, 'las líneas de la factura siguen existiendo');
});

test('borrar un pedido sin facturar se lleva la cabecera y sus líneas', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1'));
  db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', '0'));
  db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', '1'));

  const r = await api('DELETE', '/api/pedidos', { Id: 'PED-1' });
  assert.equal(r.status, 200);
  assert.equal(db.listar(tables.pedidos).length, 0);
  assert.equal(db.listar(tables.pedidosLineas).length, 0);
});

test('desmarcar una línea no descompleta un pedido que se factura a la vez', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { CompletadoEn: '2026-06-12T10:00:00.000Z' }));
  db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', '0', { Preparada: true }));
  // La marca aparece después del reclamo de la línea y después de que el recálculo
  // del estado leyera la cabecera: solo la condición de su escritura lo frena.
  const comprobarGatillo = facturarAntesDe(db, 'QueryCommand', tables.pedidosLineas);

  const r = await api('PUT', '/api/pedidos/PED-1/lineas', { LineaIndex: '0', Preparada: false });
  comprobarGatillo();
  assert.equal(r.status, 200, 'la línea sí se escribió: cuando se reclamó no había factura');
  const guardado = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.equal(guardado.Estado, 'Completado', 'el estado no se toca');
  assert.equal(
    guardado.CompletadoEn,
    '2026-06-12T10:00:00.000Z',
    'la fecha que decide el mes facturado sigue intacta',
  );
});

// ─── Sin marca, el comportamiento es el de siempre ───

test('sin factura, cada escritura de línea sube el contador antes y después', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { Estado: 'Borrador', lineas_rev: undefined }));
  const rev = () => db.obtener(tables.pedidos, { Id: 'PED-1' }).lineas_rev;

  const alta = await api('POST', '/api/pedidos/PED-1/lineas', { ProductId: 'P1', Cantidad: 2, PrecioUnitario: 10 });
  assert.equal(alta.status, 200);
  assert.equal(rev(), 2, 'la ausencia es el 0 inicial: reclamo y sello');

  await api('PUT', '/api/pedidos/PED-1/lineas', { LineaIndex: '0', Cantidad: 3 });
  assert.equal(rev(), 4);

  await api('DELETE', '/api/pedidos/PED-1/lineas', { LineaIndex: '0' });
  assert.equal(rev(), 6);
  assert.equal(db.listar(tables.pedidosLineas).length, 0);
});

/**
 * La invariante que hace utilizable el contador: cambia **después** de la última
 * escritura de contenido. Se comprueba con lo que vería el generador que lee
 * demasiado pronto —la cabecera ya reclamada y la línea todavía vieja—, que es el
 * revés que no cerraba subir el contador solo antes.
 */
for (const [titulo, operacion, metodo, cuerpo] of [
  ['al añadirla', 'PutCommand', 'POST', { ProductId: 'P1', Cantidad: 5, PrecioUnitario: 1 }],
  ['al cambiarla', 'PutCommand', 'PUT', { LineaIndex: '0', Cantidad: 5 }],
  ['al borrarla', 'DeleteCommand', 'DELETE', { LineaIndex: '0' }],
]) {
  test(`el contador cambia después de escribir el contenido de la línea (${titulo})`, async () => {
    const db = escenario();
    db.sembrar(tables.pedidos, pedido('PED-1', { Estado: 'Borrador', lineas_rev: 7 }));
    db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', '0', { Cantidad: 2 }));
    let revLeidaPorElGenerador = null;
    db.interceptar(operacion, tables.pedidosLineas, () => {
      revLeidaPorElGenerador = db.obtener(tables.pedidos, { Id: 'PED-1' }).lineas_rev;
    });

    const r = await api(metodo, '/api/pedidos/PED-1/lineas', cuerpo);
    assert.equal(r.status, 200);
    assert.notEqual(revLeidaPorElGenerador, null, `no se interceptó ${operacion}: la prueba no comprueba nada`);
    assert.notEqual(
      db.obtener(tables.pedidos, { Id: 'PED-1' }).lineas_rev,
      revLeidaPorElGenerador,
      'un reclamo con el contador leído antes de la escritura tiene que fallar',
    );
  });
}

test('una línea de un pedido que no existe se sigue escribiendo, sin inventar cabecera', async () => {
  const db = escenario();

  const r = await api('POST', '/api/pedidos/PED-HUERFANO/lineas', { ProductId: 'P1', Cantidad: 1, PrecioUnitario: 1 });
  assert.equal(r.status, 200);
  assert.equal(db.listar(tables.pedidosLineas).length, 1);
  assert.equal(db.listar(tables.pedidos).length, 0, 'no se crea un pedido fantasma con solo Id y contador');
});

test('preparar todas las líneas completa el pedido y congela la sociedad del local', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { Estado: 'Enviado', CompletadoEn: undefined }));
  db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', '0', { Preparada: false }));

  const r = await api('PUT', '/api/pedidos/PED-1/lineas', { LineaIndex: '0', Preparada: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.estadoPedido, 'Completado');
  const guardado = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.equal(guardado.factura_id_empresa_local, EMPRESA_NORTE);
  assert.ok(guardado.CompletadoEn);
});

test('con el pedido ya facturado, las guardas rechazan sin llegar a escribir', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { ...FACTURA, lineas_rev: 7 }));
  db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', '0'));

  for (const [metodo, ruta, cuerpo] of [
    ['PUT', '/api/pedidos', { Id: 'PED-1', Notas: 'x' }],
    ['DELETE', '/api/pedidos', { Id: 'PED-1' }],
    ['POST', '/api/pedidos/PED-1/lineas', { ProductId: 'P1', Cantidad: 1, PrecioUnitario: 1 }],
    ['PUT', '/api/pedidos/PED-1/lineas', { LineaIndex: '0', Cantidad: 9 }],
    ['DELETE', '/api/pedidos/PED-1/lineas', { LineaIndex: '0' }],
  ]) {
    const r = await api(metodo, ruta, cuerpo);
    assert.equal(r.status, 409, `${metodo} ${ruta}`);
    assert.match(r.body.error, /la factura de venta de mercancía de junio de 2026/);
    assert.doesNotMatch(r.body.error, /9a1f6ba9/, 'el UUID no le dice nada a quien prepara pedidos');
  }
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).lineas_rev, 7);
  assert.equal(db.listar(tables.pedidosLineas).length, 1);
});

test('el mensaje distingue la venta del abono de rappel y nombra los dos', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', {
    ...FACTURA,
    factura_rappel_id: 'e2b9c1d4-77aa-4f01-8c22-9f0e5d3b1a60',
    factura_rappel_periodo: '2026-07',
  }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', Notas: 'x' });
  assert.equal(r.status, 409);
  assert.equal(
    r.body.error,
    'Este pedido ya está facturado en la factura de venta de mercancía de junio de 2026'
      + ' y el abono de rappel de julio de 2026; para cambiarlo hay que rectificar esos documentos.',
  );
});

test('con número de factura, el mensaje lo prefiere al periodo', async () => {
  const db = escenario();
  // Hoy nadie lo escribe (el documento nace en borrador), pero si algún día se
  // escribe al emitir, el mensaje debe usarlo: es la referencia que ve el usuario.
  db.sembrar(tables.pedidos, pedido('PED-1', { ...FACTURA, factura_ventas_numero: 'FMI-2026-000123' }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', Notas: 'x' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /factura de venta de mercancía FMI-2026-000123/);
});

test('sin número ni periodo, el mensaje cae al identificador', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { factura_rappel_id: 'F-UUID-9' }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', Notas: 'x' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /abono de rappel F-UUID-9/);
});

test('una marca presente pero vacía bloquea igual y dice qué la bloquea', async () => {
  const db = escenario();
  // No es alcanzable por código: es que la guarda y la condición de la escritura
  // tienen que rechazar lo mismo. Si la guarda lo diera por bueno, el pedido
  // rechazaría cada intento con un genérico «recárgalo e inténtalo de nuevo».
  db.sembrar(tables.pedidos, pedido('PED-1', { factura_ventas_id: '', factura_ventas_periodo: '2026-06' }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', Notas: 'x' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /factura de venta de mercancía de junio de 2026/);
  assert.doesNotMatch(r.body.error, /inténtalo de nuevo/);
});

// ─── Almacén General: un solo criterio, con caché y a prueba de averías ───

test('el criterio del Almacén General se lee una vez y se reutiliza', async () => {
  const db = escenario();
  const escaneos = () => db.operaciones.filter((o) => o.tipo === 'ScanCommand' && o.tabla === tables.almacenes).length;

  const primero = await api('POST', '/api/pedidos', { Fecha: '2026-06-10', LocalId: '000010', AlmacenOrigenId: 'ALM-GEN' });
  assert.equal(primero.status, 200);
  const trasPrimero = escaneos();
  assert.ok(trasPrimero > 0, 'la primera vez sí lee el maestro');

  const segundo = await api('POST', '/api/pedidos', { Fecha: '2026-06-10', LocalId: '000010', AlmacenOrigenId: 'ALM-GEN' });
  assert.equal(segundo.status, 200);
  assert.equal(escaneos(), trasPrimero, 'el segundo pedido no vuelve a escanear el maestro');
});

test('servir desde el almacén de otro local sigue exigiendo permiso', async () => {
  escenario();

  const r = await api(
    'POST',
    '/api/pedidos',
    { Fecha: '2026-06-10', LocalId: '000020', AlmacenOrigenId: 'ALM-NORTE' },
    ENCARGADO,
  );
  assert.equal(r.status, 403);
  assert.match(r.body.error, /permiso/);
});

test('devolver mercancía al Almacén General no exige permiso', async () => {
  escenario();

  const r = await api(
    'POST',
    '/api/pedidos',
    { Fecha: '2026-06-10', LocalId: '000010', Tipo: 'Devolucion', AlmacenOrigenId: 'ALM-NORTE', AlmacenDestinoId: 'ALM-GEN' },
    ENCARGADO,
  );
  assert.equal(r.status, 200);
});

test('un maestro sin Almacén General exige el permiso: es el lado seguro', async () => {
  const db = escenario();
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.sembrar(tables.almacenes, almacen('ALM-NORTE', 'Almacen Norte'));

  const r = await api(
    'POST',
    '/api/pedidos',
    { Fecha: '2026-06-10', LocalId: '000010', AlmacenOrigenId: 'ALM-GEN' },
    ENCARGADO,
  );
  assert.equal(r.status, 403);
});

test('si el maestro de almacenes no se puede leer, el pedido se crea igual', async () => {
  const db = escenario();
  db.interceptar('ScanCommand', tables.almacenes, () => {
    throw new Error('ProvisionedThroughputExceededException');
  });

  const r = await api(
    'POST',
    '/api/pedidos',
    { Fecha: '2026-06-10', LocalId: '000010', AlmacenOrigenId: 'ALM-NORTE' },
    ENCARGADO,
  );
  assert.equal(r.status, 200, 'una avería del maestro no puede parar el almacén');
});

test('una avería del maestro no provoca un escaneo por pedido', async () => {
  const db = escenario();
  const escaneos = () => db.operaciones.filter((o) => o.tipo === 'ScanCommand' && o.tabla === tables.almacenes).length;
  // El gatillo solo salta una vez, así que se rompe la tabla para que fallen todos.
  db.interceptar('ScanCommand', tables.almacenes, () => {
    throw new Error('ProvisionedThroughputExceededException');
  });

  const alta = { Fecha: '2026-06-10', LocalId: '000010', AlmacenOrigenId: 'ALM-NORTE' };
  assert.equal((await api('POST', '/api/pedidos', alta, ENCARGADO)).status, 200);
  const trasPrimero = escaneos();
  assert.ok(trasPrimero > 0, 'el primer alta sí intenta leer el maestro');
  assert.equal((await api('POST', '/api/pedidos', alta, ENCARGADO)).status, 200);
  assert.equal(escaneos(), trasPrimero, 'el fallo se recuerda unos segundos en vez de reintentar en cada alta');
});

// ─── El permiso interlocal en la edición ───

test('mover el origen a un almacén de local exige el permiso también al editar', async () => {
  const db = escenario();
  db.sembrar(tables.pedidos, pedido('PED-1', { Estado: 'Borrador', AlmacenOrigenId: 'ALM-GEN' }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', AlmacenOrigenId: 'ALM-NORTE' }, ENCARGADO);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /permiso/);
  assert.equal(
    db.obtener(tables.pedidos, { Id: 'PED-1' }).AlmacenOrigenId,
    'ALM-GEN',
    'el origen no se ha movido',
  );
});

test('editar otras cosas de un pedido interlocal ya creado no pide ese permiso', async () => {
  const db = escenario();
  // El pedido ya sale del almacén de un local: lo creó quien podía. Prepararlo,
  // anotarlo o completarlo es operativa normal y no debe dar un rechazo espurio.
  db.sembrar(tables.pedidos, pedido('PED-1', { Estado: 'Borrador', AlmacenOrigenId: 'ALM-NORTE', Notas: '' }));

  const r = await api('PUT', '/api/pedidos', { Id: 'PED-1', Notas: 'Van dos cajas' }, ENCARGADO);
  assert.equal(r.status, 200);
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).Notas, 'Van dos cajas');
});
