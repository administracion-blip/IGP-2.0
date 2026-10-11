/**
 * Aislamiento por local en cajas: cierres, sincronizaciones, arqueos, revisión,
 * efectivo a ingresar y movimientos. Cada prueba es un ataque: un usuario con
 * permiso de rol intenta actuar sobre un local que no está en su lista.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-cajas';
// Las URL firmadas de S3 se calculan en local; con credenciales ficticias no se busca proveedor.
if (!process.env.AWS_ACCESS_KEY_ID) {
  process.env.AWS_ACCESS_KEY_ID = 'clave-de-prueba';
  process.env.AWS_SECRET_ACCESS_KEY = 'secreto-de-prueba';
}
// Sin credenciales de Ágora las exportaciones fallan en local y la sync responde 0 cierres.
delete process.env.AGORA_BASE_URL;
delete process.env.AGORA_API_BASE_URL;
delete process.env.AGORA_API_TOKEN;

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: agoraRouter } = await import('../routes/agora.js');
const { default: arqueosRouter } = await import('../routes/arqueosReales.js');
const { default: movimientosRouter } = await import('../routes/movimientosCaja.js');

// Local con PARIPE (101); SuperUser restringido a PARIPE; oficina global (Local vacío).
const LOCAL_PARIPE = { sub: '000050', email: 'paripe@grupo.test', rol: 'Local' };
const SUPER_PARIPE = { sub: '000051', email: 'super@grupo.test', rol: 'SuperUser' };

const PERMISOS = {
  Local: ['cierres.crear', 'cierres.editar', 'cierres.sincronizar', 'planning_dia.arqueo', 'planning_dia.ver', 'pedidos.ver'],
  SuperUser: [
    'cierres.ver', 'cierres.crear', 'cierres.editar', 'cierres.borrar', 'cierres.sincronizar',
    'cajas.ver', 'planning_dia.arqueo', 'rrhh.horas', 'ajustes.sincronizaciones.closeouts',
  ],
};

let usuarioActual = LOCAL_PARIPE;
let servidor = null;
let base = '';
let db = null;

async function api(metodo, ruta, usuario, body) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      req.log = { info() {}, error() {}, warn() {} };
      next();
    });
    app.use('/api', agoraRouter);
    app.use('/api', arqueosRouter);
    app.use('/api', movimientosRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.empresas, { hashKey: 'id_empresa' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.salesCloseOuts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.arqueosReales, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.jornadasLocal, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.movimientosCaja, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const [rol, lista] of Object.entries(PERMISOS)) {
    for (const p of lista) db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${p}` });
  }
  db.sembrar(tables.locales, { id_Locales: '000001', nombre: 'PARIPE', agoraCode: '101', id_empresa: '000010', empresa: 'Norte SL' });
  db.sembrar(tables.locales, { id_Locales: '000002', nombre: 'SUR', agoraCode: '202', id_empresa: '000020', empresa: 'Sur SL' });
  db.sembrar(tables.usuarios, { id_usuario: '000050', Email: 'paripe@grupo.test', Rol: 'Local', Local: ['PARIPE'] });
  db.sembrar(tables.usuarios, { id_usuario: '000051', Email: 'super@grupo.test', Rol: 'SuperUser', Local: ['PARIPE'] });
  db.sembrar(tables.salesCloseOuts, { PK: '101', SK: '2026-10-01#1#1', BusinessDay: '2026-10-01' });
  db.sembrar(tables.salesCloseOuts, { PK: '202', SK: '2026-10-01#1#1', BusinessDay: '2026-10-01' });
  for (const pk of ['101', '202']) {
    db.sembrar(tables.arqueosReales, { PK: pk, SK: '2026-10-01#1', BusinessDay: '2026-10-01', PosId: '1', estado: 'cerrado' });
    db.sembrar(tables.jornadasLocal, { PK: pk, SK: '2026-10-01', estado: 'cerrada' });
  }
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  return db;
}

// ─── Cierres (POST/PUT/DELETE /agora/closeouts) ───

test('cierres: Local de PARIPE no borra un cierre de otro workplace', async () => {
  montar();
  const r = await api('DELETE', '/api/agora/closeouts?PK=202&SK=2026-10-01%231%231', SUPER_PARIPE);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'No tienes acceso a este local');
  assert.ok(db.obtener(tables.salesCloseOuts, { PK: '202', SK: '2026-10-01#1#1' }), 'el cierre sigue');

  const local = await api('DELETE', '/api/agora/closeouts?PK=202&SK=2026-10-01%231%231', LOCAL_PARIPE);
  assert.equal(local.status, 403);
  assert.ok(db.obtener(tables.salesCloseOuts, { PK: '202', SK: '2026-10-01#1#1' }));
});

test('cierres: sin cierres.borrar no se borra ni en el propio local', async () => {
  montar();
  const r = await api('DELETE', '/api/agora/closeouts?PK=101&SK=2026-10-01%231%231', LOCAL_PARIPE);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Permiso insuficiente');
  assert.ok(db.obtener(tables.salesCloseOuts, { PK: '101', SK: '2026-10-01#1#1' }));
});

test('cierres: SuperUser con PARIPE borra el cierre de PARIPE', async () => {
  montar();
  const r = await api('DELETE', '/api/agora/closeouts?PK=101&SK=2026-10-01%231%231', SUPER_PARIPE);
  assert.equal(r.status, 200);
  assert.equal(db.obtener(tables.salesCloseOuts, { PK: '101', SK: '2026-10-01#1#1' }), null);
});

test('cierres: crear y editar solo en el propio local', async () => {
  montar();
  const alta = { PK: '202', BusinessDay: '2026-10-02', PosId: '1', Number: '1' };
  assert.equal((await api('POST', '/api/agora/closeouts', LOCAL_PARIPE, alta)).status, 403);
  assert.equal(db.obtener(tables.salesCloseOuts, { PK: '202', SK: '2026-10-02#1#1' }), null);
  assert.equal((await api('POST', '/api/agora/closeouts', LOCAL_PARIPE, { ...alta, PK: '101' })).status, 200);

  const edicion = { PK: '202', SK: '2026-10-01#1#1', BusinessDay: '2026-09-30', PosId: '1', Number: '1' };
  assert.equal((await api('PUT', '/api/agora/closeouts', LOCAL_PARIPE, edicion)).status, 403);
  assert.ok(db.obtener(tables.salesCloseOuts, { PK: '202', SK: '2026-10-01#1#1' }), 'no se movió');
  assert.equal((await api('PUT', '/api/agora/closeouts', LOCAL_PARIPE, { ...edicion, PK: '101' })).status, 200);
});

// ─── Sincronizaciones de cierres ───

function escrituras() {
  return db.operaciones.filter((o) => ['DeleteCommand', 'BatchWriteCommand', 'PutCommand', 'UpdateCommand'].includes(o.tipo));
}

test('full-sync: SuperUser restringido recibe 403 y no se borra nada', async () => {
  montar();
  const r = await api('POST', '/api/agora/closeouts/full-sync', SUPER_PARIPE, { dateFrom: '2026-10-05', dateTo: '2026-10-05' });
  assert.equal(r.status, 403);
  assert.equal(escrituras().length, 0);
  assert.equal(db.listar(tables.salesCloseOuts).length, 2);
});

test('full-sync: sin ajustes.sincronizaciones.closeouts, 403 aunque tenga cierres.sincronizar', async () => {
  montar();
  const r = await api('POST', '/api/agora/closeouts/full-sync', LOCAL_PARIPE, { dateFrom: '2026-10-05', dateTo: '2026-10-05' });
  assert.equal(r.status, 403);
  assert.equal(db.listar(tables.salesCloseOuts).length, 2);
});

test('sync: Local sin workplaces 403; con workplace ajeno 403; con el suyo pasa', async () => {
  montar();
  assert.equal((await api('POST', '/api/agora/closeouts/sync', LOCAL_PARIPE, { businessDay: '2026-10-01' })).status, 403);
  assert.equal((await api('POST', '/api/agora/closeouts/sync', LOCAL_PARIPE, { businessDay: '2026-10-01', workplaces: [] })).status, 403);
  assert.equal(
    (await api('POST', '/api/agora/closeouts/sync', LOCAL_PARIPE, { businessDay: '2026-10-01', workplaces: '202' })).status,
    403,
  );
  // Mismo formato que arqueo-caja.tsx: `workplaces` como cadena con el agoraCode.
  const propio = await api('POST', '/api/agora/closeouts/sync', LOCAL_PARIPE, { businessDay: '2026-10-01', workplaces: '101' });
  assert.equal(propio.status, 200);
  assert.equal(propio.body.ok, true);
  assert.equal(db.listar(tables.salesCloseOuts).length, 2);
});

test('complete-fields: restringido sin workplaceId o con uno ajeno, 403', async () => {
  montar();
  assert.equal((await api('POST', '/api/agora/closeouts/complete-fields', SUPER_PARIPE, {})).status, 403);
  assert.equal((await api('POST', '/api/agora/closeouts/complete-fields', SUPER_PARIPE, { workplaceId: '202' })).status, 403);
  assert.equal((await api('POST', '/api/agora/closeouts/complete-fields', LOCAL_PARIPE, { workplaceId: '101', limit: 1 })).status, 200);
});

// ─── Arqueos reales y jornada ───

test('arqueos: PUT de un arqueo de otro local, 403 y no se escribe', async () => {
  montar();
  const body = { PK: '202', BusinessDay: '2026-10-02', PosId: '1', realPorMetodo: { Efectivo: 1 } };
  const r = await api('PUT', '/api/cajas/arqueos-reales', LOCAL_PARIPE, body);
  assert.equal(r.status, 403);
  assert.equal(db.obtener(tables.arqueosReales, { PK: '202', SK: '2026-10-02#1' }), null);
  // Con workplaceId en vez de PK, igual.
  const alt = await api('PUT', '/api/cajas/arqueos-reales', LOCAL_PARIPE, { ...body, PK: undefined, workplaceId: '202' });
  assert.equal(alt.status, 403);
  assert.equal(escrituras().length, 0);
});

test('arqueos: lecturas, estado y cierre de jornada solo del propio local', async () => {
  montar();
  assert.equal((await api('GET', '/api/cajas/arqueos-reales?workplaceId=202', LOCAL_PARIPE)).status, 403);
  assert.equal((await api('GET', '/api/cajas/arqueos-reales?workplaceId=101', LOCAL_PARIPE)).status, 200);
  assert.equal(
    (await api('GET', '/api/cajas/arqueos-reales/compare?workplaceId=202&businessDay=2026-10-01&posId=1', LOCAL_PARIPE)).status,
    403,
  );
  assert.equal((await api('GET', '/api/cajas/jornada?workplaceId=202&businessDay=2026-10-01', LOCAL_PARIPE)).status, 403);
  const estado = { workplaceId: '202', businessDay: '2026-10-01', posId: '1', estado: 'borrador' };
  assert.equal((await api('POST', '/api/cajas/arqueos-reales/estado', LOCAL_PARIPE, estado)).status, 403);
  assert.equal((await api('POST', '/api/cajas/jornada/cerrar', LOCAL_PARIPE, { PK: '202', businessDay: '2026-10-01' })).status, 403);
  assert.equal(escrituras().length, 0);
});

test('arqueos: reabrir jornada exige cierres.ver (Local no puede ni en su local)', async () => {
  montar();
  const r = await api('POST', '/api/cajas/jornada/reabrir', LOCAL_PARIPE, { workplaceId: '101', businessDay: '2026-10-01' });
  assert.equal(r.status, 403);
  assert.equal(db.obtener(tables.jornadasLocal, { PK: '101', SK: '2026-10-01' }).estado, 'cerrada');

  assert.equal(
    (await api('POST', '/api/cajas/jornada/reabrir', SUPER_PARIPE, { workplaceId: '202', businessDay: '2026-10-01' })).status,
    403,
  );
  assert.equal(db.obtener(tables.jornadasLocal, { PK: '202', SK: '2026-10-01' }).estado, 'cerrada');
  const ok = await api('POST', '/api/cajas/jornada/reabrir', SUPER_PARIPE, { workplaceId: '101', businessDay: '2026-10-01' });
  assert.equal(ok.status, 200);
  assert.equal(db.obtener(tables.jornadasLocal, { PK: '101', SK: '2026-10-01' }).estado, 'abierta');
});

test('arqueos: marcar revisado exige cierres.ver y el local', async () => {
  montar();
  const body = { workplaceId: '101', businessDay: '2026-10-01', posId: '1', revisado: true };
  assert.equal((await api('POST', '/api/cajas/arqueos-reales/revisado', LOCAL_PARIPE, body)).status, 403);
  assert.equal(
    (await api('POST', '/api/cajas/arqueos-reales/revisado', SUPER_PARIPE, { ...body, workplaceId: '202' })).status,
    403,
  );
  assert.notEqual(db.obtener(tables.arqueosReales, { PK: '202', SK: '2026-10-01#1' }).revisado, true);
  assert.equal((await api('POST', '/api/cajas/arqueos-reales/revisado', SUPER_PARIPE, body)).status, 200);
});

test('arqueos: DELETE exige cierres.borrar y el local', async () => {
  montar();
  assert.equal((await api('DELETE', '/api/cajas/arqueos-reales?PK=101&SK=2026-10-01%231', LOCAL_PARIPE)).status, 403);
  assert.equal((await api('DELETE', '/api/cajas/arqueos-reales?PK=202&SK=2026-10-01%231', SUPER_PARIPE)).status, 403);
  assert.ok(db.obtener(tables.arqueosReales, { PK: '202', SK: '2026-10-01#1' }));
  assert.equal((await api('DELETE', '/api/cajas/arqueos-reales?PK=101&SK=2026-10-01%231', SUPER_PARIPE)).status, 200);
});

test('arqueos: ticket-image-url de otro local o de anon, 403', async () => {
  montar();
  const ajeno = await api('GET', '/api/cajas/arqueos-reales/ticket-image-url?key=arqueos-tickets/202/2026-10-01/x.jpg', LOCAL_PARIPE);
  assert.equal(ajeno.status, 403);
  const anon = await api('GET', '/api/cajas/arqueos-reales/ticket-image-url?key=arqueos-tickets/anon/x.jpg', LOCAL_PARIPE);
  assert.equal(anon.status, 403);
  const propio = await api('GET', '/api/cajas/arqueos-reales/ticket-image-url?key=arqueos-tickets/101/2026-10-01/x.jpg', LOCAL_PARIPE);
  assert.equal(propio.status, 200);
  assert.ok(propio.body.url);
});

// Boletas antiguas subidas sin local: viven en arqueos-tickets/anon/ y solo el registro
// que las referencia dice de qué local son.
const TICKET_ANON_101 = 'arqueos-tickets/anon/boleta-101.jpg';
const TICKET_ANON_202 = 'arqueos-tickets/anon/boleta-202.jpg';

function sembrarArqueosConBoletaAnon() {
  db.sembrar(tables.arqueosReales, {
    PK: '101', SK: '2026-09-01#1', BusinessDay: '2026-09-01', PosId: '1',
    tarjetaLineas: [{ id: 'l1', importe: '10', imagenKey: TICKET_ANON_101 }],
  });
  db.sembrar(tables.arqueosReales, {
    PK: '202', SK: '2026-09-01#1', BusinessDay: '2026-09-01', PosId: '1',
    tarjetaLineas: [{ id: 'l1', importe: '20', imagenKey: TICKET_ANON_202 }],
  });
}

function urlTicket(key, pk, sk) {
  const q = new URLSearchParams({ key });
  if (pk !== undefined) q.set('pk', pk);
  if (sk !== undefined) q.set('sk', sk);
  return `/api/cajas/arqueos-reales/ticket-image-url?${q}`;
}

test('arqueos: ticket anon con pk/sk del arqueo propio que la contiene, 200', async () => {
  montar();
  sembrarArqueosConBoletaAnon();
  const r = await api('GET', urlTicket(TICKET_ANON_101, '101', '2026-09-01#1'), LOCAL_PARIPE);
  assert.equal(r.status, 200);
  assert.ok(r.body.url);
});

test('arqueos: ticket anon de un arqueo ajeno, 403 (aunque pk/sk sean correctos)', async () => {
  montar();
  sembrarArqueosConBoletaAnon();
  const r = await api('GET', urlTicket(TICKET_ANON_202, '202', '2026-09-01#1'), LOCAL_PARIPE);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'No tienes acceso a este local');
});

test('arqueos: ticket anon que no está en el arqueo propio indicado, 403', async () => {
  montar();
  sembrarArqueosConBoletaAnon();
  // Arqueo propio como tapadera para leer la boleta de SUR.
  const ajena = await api('GET', urlTicket(TICKET_ANON_202, '101', '2026-09-01#1'), LOCAL_PARIPE);
  assert.equal(ajena.status, 403);
  // Registro propio que no existe.
  const inexistente = await api('GET', urlTicket(TICKET_ANON_101, '101', '2026-09-02#1'), LOCAL_PARIPE);
  assert.equal(inexistente.status, 403);
});

test('arqueos: ticket anon sin pk o sin sk, 403', async () => {
  montar();
  sembrarArqueosConBoletaAnon();
  assert.equal((await api('GET', urlTicket(TICKET_ANON_101), LOCAL_PARIPE)).status, 403);
  assert.equal((await api('GET', urlTicket(TICKET_ANON_101, '101'), LOCAL_PARIPE)).status, 403);
  assert.equal((await api('GET', urlTicket(TICKET_ANON_101, undefined, '2026-09-01#1'), LOCAL_PARIPE)).status, 403);
});

test('arqueos: clave con workplace ignora pk/sk (ajena sigue 403 aunque pk sea propio)', async () => {
  montar();
  sembrarArqueosConBoletaAnon();
  const ajena = await api('GET', urlTicket('arqueos-tickets/202/2026-09-01/x.jpg', '101', '2026-09-01#1'), LOCAL_PARIPE);
  assert.equal(ajena.status, 403);
  const propia = await api('GET', urlTicket('arqueos-tickets/101/2026-09-01/x.jpg', '202', 'no-existe'), LOCAL_PARIPE);
  assert.equal(propia.status, 200);
});

test('anon: el alcance global sigue sin necesitar pk/sk', async () => {
  montar();
  const oficina = { sub: '000053', email: 'oficina@grupo.test', rol: 'SuperUser' };
  db.sembrar(tables.usuarios, { id_usuario: '000053', Email: 'oficina@grupo.test', Rol: 'SuperUser', Local: [] });
  assert.equal((await api('GET', urlTicket(TICKET_ANON_202), oficina)).status, 200);
  const justif = await api('GET', '/api/cajas/movimientos/justificante-url?key=cajas-movimientos/anon/x.jpg', oficina);
  assert.equal(justif.status, 200);
});

test('arqueos: OCR sin workplaceId o con uno ajeno, 403 para restringidos', async () => {
  montar();
  const enviar = async (campos) => {
    usuarioActual = LOCAL_PARIPE;
    const form = new FormData();
    for (const [k, v] of Object.entries(campos)) form.append(k, v);
    form.append('imagen', new Blob([Buffer.from('no-es-imagen')], { type: 'image/jpeg' }), 't.jpg');
    const res = await fetch(`${base}/api/cajas/arqueos-reales/ocr-ticket`, { method: 'POST', body: form });
    return res.status;
  };
  await api('GET', '/api/cajas/jornada?workplaceId=101&businessDay=2026-10-01', LOCAL_PARIPE); // arranca el servidor
  assert.equal(await enviar({ businessDay: '2026-10-01' }), 403);
  assert.equal(await enviar({ workplaceId: '202', businessDay: '2026-10-01' }), 403);
});

test('revisión de cajas: cierres.ver e intersección de workplaceIds', async () => {
  montar();
  const q = 'dateFrom=2026-10-01&dateTo=2026-10-01';
  assert.equal((await api('GET', `/api/cajas/revision?${q}&workplaceIds=101`, LOCAL_PARIPE)).status, 403);
  assert.equal((await api('GET', `/api/cajas/revision?${q}&workplaceIds=202`, SUPER_PARIPE)).status, 403);
  const r = await api('GET', `/api/cajas/revision?${q}&workplaceIds=101,202`, SUPER_PARIPE);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.locales.map((l) => l.workplaceId), ['101']);
});

// ─── Efectivo a ingresar (IBAN de sociedades) ───

const IBAN_NORTE = 'ES9121000418450200051332';
const IBAN_SUR = 'ES7921000813610123456789';

function sembrarEfectivo() {
  db.sembrar(tables.empresas, { id_empresa: '000010', Nombre: 'Norte SL', IbanPredeterminado: IBAN_NORTE });
  db.sembrar(tables.empresas, { id_empresa: '000020', Nombre: 'Sur SL', IbanPredeterminado: IBAN_SUR });
  for (const pk of ['101', '202']) {
    db.sembrar(tables.arqueosReales, {
      PK: pk, SK: '2026-10-03#1', BusinessDay: '2026-10-03', PosId: '1', realPorMetodo: { Efectivo: 100 },
    });
  }
}

test('efectivo a ingresar: el IBAN de una sociedad ajena no sale aunque se pida su local', async () => {
  montar();
  sembrarEfectivo();
  const q = 'dateFrom=2026-10-03&dateTo=2026-10-03';
  const r = await api('GET', `/api/cajas/efectivo-ingresar?${q}&workplaceIds=101,202`, SUPER_PARIPE);
  assert.equal(r.status, 200);
  const texto = JSON.stringify(r.body);
  assert.ok(texto.includes(IBAN_NORTE));
  assert.ok(!texto.includes(IBAN_SUR), 'no debe aparecer el IBAN de la sociedad de SUR');
  assert.deepEqual(r.body.sociedades.flatMap((s) => s.locales.map((l) => l.workplaceId)), ['101']);

  assert.equal((await api('GET', `/api/cajas/efectivo-ingresar?${q}&workplaceIds=202`, SUPER_PARIPE)).status, 403);
  assert.equal((await api('GET', `/api/cajas/efectivo-ingresar?${q}&workplaceIds=101`, LOCAL_PARIPE)).status, 403);
});

// ─── Movimientos de caja ───

test('movimientos: DELETE de otro local, 403 y el movimiento sigue', async () => {
  montar();
  db.sembrar(tables.movimientosCaja, { PK: '202', SK: '2026-10-01#1#retirada#m1', tipo: 'retirada', importe: 50 });
  const r = await api('DELETE', '/api/cajas/movimientos?PK=202&SK=2026-10-01%231%23retirada%23m1', LOCAL_PARIPE);
  assert.equal(r.status, 403);
  assert.ok(db.obtener(tables.movimientosCaja, { PK: '202', SK: '2026-10-01#1#retirada#m1' }));
});

test('movimientos: listar, crear y editar solo en el propio local', async () => {
  montar();
  assert.equal((await api('GET', '/api/cajas/movimientos?workplaceId=202&businessDay=2026-10-01', LOCAL_PARIPE)).status, 403);
  assert.equal((await api('GET', '/api/cajas/movimientos?workplaceId=101&businessDay=2026-10-01', LOCAL_PARIPE)).status, 200);
  const mov = { workplaceId: '202', businessDay: '2026-10-01', posId: '1', tipo: 'retirada', importe: '10' };
  assert.equal((await api('POST', '/api/cajas/movimientos', LOCAL_PARIPE, mov)).status, 403);
  assert.equal((await api('PUT', '/api/cajas/movimientos', LOCAL_PARIPE, { ...mov, workplaceId: undefined, PK: '202' })).status, 403);
  assert.equal(db.listar(tables.movimientosCaja).length, 0);
  assert.equal((await api('POST', '/api/cajas/movimientos', LOCAL_PARIPE, { ...mov, workplaceId: '101' })).status, 200);
});

test('movimientos: justificante-url de otro local o de anon, 403', async () => {
  montar();
  const ajeno = await api('GET', '/api/cajas/movimientos/justificante-url?key=cajas-movimientos/202/2026-10-01/x.jpg', LOCAL_PARIPE);
  assert.equal(ajeno.status, 403);
  const anon = await api('GET', '/api/cajas/movimientos/justificante-url?key=cajas-movimientos/anon/x.jpg', LOCAL_PARIPE);
  assert.equal(anon.status, 403);
  const propio = await api('GET', '/api/cajas/movimientos/justificante-url?key=cajas-movimientos/101/2026-10-01/x.jpg', LOCAL_PARIPE);
  assert.equal(propio.status, 200);
});

const JUSTIF_ANON_101 = 'cajas-movimientos/anon/justif-101.jpg';
const JUSTIF_ANON_202 = 'cajas-movimientos/anon/justif-202.jpg';
const SK_MOV = '2026-09-01#1#retirada#m1';

function sembrarMovimientosConJustificanteAnon() {
  db.sembrar(tables.movimientosCaja, { PK: '101', SK: SK_MOV, tipo: 'retirada', importe: 5, justificanteKey: JUSTIF_ANON_101 });
  db.sembrar(tables.movimientosCaja, { PK: '202', SK: SK_MOV, tipo: 'retirada', importe: 7, justificanteKey: JUSTIF_ANON_202 });
}

function urlJustificante(key, pk, sk) {
  const q = new URLSearchParams({ key });
  if (pk !== undefined) q.set('pk', pk);
  if (sk !== undefined) q.set('sk', sk);
  return `/api/cajas/movimientos/justificante-url?${q}`;
}

test('movimientos: justificante anon con pk/sk del movimiento propio que lo contiene, 200', async () => {
  montar();
  sembrarMovimientosConJustificanteAnon();
  const r = await api('GET', urlJustificante(JUSTIF_ANON_101, '101', SK_MOV), LOCAL_PARIPE);
  assert.equal(r.status, 200);
  assert.ok(r.body.url);
});

test('movimientos: justificante anon de un movimiento ajeno, 403', async () => {
  montar();
  sembrarMovimientosConJustificanteAnon();
  assert.equal((await api('GET', urlJustificante(JUSTIF_ANON_202, '202', SK_MOV), LOCAL_PARIPE)).status, 403);
});

test('movimientos: justificante anon que no es el del movimiento propio indicado, 403', async () => {
  montar();
  sembrarMovimientosConJustificanteAnon();
  assert.equal((await api('GET', urlJustificante(JUSTIF_ANON_202, '101', SK_MOV), LOCAL_PARIPE)).status, 403);
  assert.equal((await api('GET', urlJustificante(JUSTIF_ANON_101, '101', 'otro-sk'), LOCAL_PARIPE)).status, 403);
});

test('movimientos: justificante anon sin pk o sin sk, 403', async () => {
  montar();
  sembrarMovimientosConJustificanteAnon();
  assert.equal((await api('GET', urlJustificante(JUSTIF_ANON_101), LOCAL_PARIPE)).status, 403);
  assert.equal((await api('GET', urlJustificante(JUSTIF_ANON_101, '101'), LOCAL_PARIPE)).status, 403);
  assert.equal((await api('GET', urlJustificante(JUSTIF_ANON_101, undefined, SK_MOV), LOCAL_PARIPE)).status, 403);
});

test('movimientos: sin permiso de arqueo, 403 aunque sea su local', async () => {
  montar();
  const sinArqueo = { sub: '000052', email: 'mkt@grupo.test', rol: 'Marketing' };
  db.sembrar(tables.usuarios, { id_usuario: '000052', Email: 'mkt@grupo.test', Rol: 'Marketing', Local: ['PARIPE'] });
  const r = await api('GET', '/api/cajas/movimientos?workplaceId=101&businessDay=2026-10-01', sinArqueo);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Permiso insuficiente');
});
