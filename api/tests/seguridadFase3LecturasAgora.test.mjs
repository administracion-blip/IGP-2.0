/**
 * Fase 3.1 del plan de seguridad: las lecturas de agora.js que solo pedían sesión
 * exigen ahora su permiso (Administrador siempre pasa). dashboard-home no pide
 * permiso, pero filtra el ticker por los locales del usuario en cualquier modo y
 * solo devuelve los acumulados YTD/por meses con cajas.ver.
 */

import test, { after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-fase3-agora';
delete process.env.AGORA_BASE_URL;
process.env.AGORA_API_BASE_URL = 'http://agora.falso';
process.env.AGORA_API_TOKEN = 'token-de-prueba';

const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, opciones) => {
  const u = String(url);
  if (!u.startsWith('http://agora.falso')) return fetchReal(url, opciones);
  return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: agoraRouter } = await import('../routes/agora.js');

const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };
const SIN_PERMISOS = { sub: '000060', email: 'camarero@grupo.test', rol: 'Camarero' };
const LOCAL_PARIPE = { sub: '000061', email: 'paripe@grupo.test', rol: 'Camarero' };
const CAJAS_PARIPE = { sub: '000062', email: 'cajas@grupo.test', rol: 'Rol_cajas.ver' };
const CAJAS_TODOS = { sub: '000063', email: 'oficina@grupo.test', rol: 'Rol_cajas.ver' };

const conPermiso = (permiso) => ({ sub: '000070', email: 'p@grupo.test', rol: `Rol_${permiso}` });

const RUTAS = [
  ['/api/cajas/top?dateFrom=2026-10-12&dateTo=2026-10-12&workplaceIds=101', ['top.ver']],
  ['/api/agora/closeouts/totals-by-local-ytd?year=2026', ['cajas.ver']],
  ['/api/agora/closeouts/totals-by-month?year=2026', ['cajas.ver']],
  ['/api/agora/purchases?dateFrom=2026-10-01&dateTo=2026-10-31', ['compras_proveedor.ver']],
  ['/api/agora/purchases/por-producto?productId=10', ['compras_proveedor.ver', 'acuerdos.ver', 'escandallos.ver']],
  ['/api/agora/users', ['usuarios_agora.ver']],
  ['/api/agora/payment-methods', ['cierres.ver']],
  ['/api/agora/formas-pago', ['cierres.ver']],
  ['/api/agora/sale-centers', ['cierres.ver', 'puntos_venta.ver']],
  ['/api/agora/centros-venta', ['puntos_venta.ver']],
  ['/api/agora/locales-tarifa', ['puntos_venta.ver']],
  ['/api/agora/franjas-plantillas', ['objetivos.ver', 'prevision.ver', 'rrhh.horas']],
];

const db = crearDynamoMemoria();
db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' }, [
  { id_usuario: '000060', Email: 'camarero@grupo.test', Rol: 'Camarero', Local: [] },
  { id_usuario: '000061', Email: 'paripe@grupo.test', Rol: 'Camarero', Local: ['PARIPE'] },
  { id_usuario: '000062', Email: 'cajas@grupo.test', Rol: 'Rol_cajas.ver', Local: ['PARIPE'] },
  { id_usuario: '000063', Email: 'oficina@grupo.test', Rol: 'Rol_cajas.ver', Local: [] },
]);
db.crearTabla(tables.locales, { hashKey: 'id_Locales' }, [
  { id_Locales: '000001', nombre: 'PARIPE', agoraCode: '101' },
  { id_Locales: '000002', nombre: 'SUR', agoraCode: '202' },
]);
db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' }, [
  { PK: 'ROL#Camarero', SK: 'PERMISO#pedidos.ver' },
  { PK: 'ROL#Camarero', SK: 'PERMISO#planning_dia.arqueo' },
  ...[...new Set(RUTAS.flatMap(([, permisos]) => permisos))].map((p) => ({ PK: `ROL#Rol_${p}`, SK: `PERMISO#${p}` })),
  { PK: 'ROL#Rol_productos.sincronizar', SK: 'PERMISO#productos.sincronizar' },
  {
    PK: 'ROL#Rol_ajustes.sincronizaciones.agora_productos',
    SK: 'PERMISO#ajustes.sincronizaciones.agora_productos',
  },
]);
db.crearTabla(tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' }, [
  { PK: 'GLOBAL', SK: '10', Id: 10, Name: 'Caña' },
]);
db.crearTabla(tables.salesCloseOuts, { hashKey: 'PK', rangeKey: 'SK' }, [
  { PK: '101', SK: '2026-10-12#1#1', InvoicePayments: [{ Amount: 10 }] },
  { PK: '202', SK: '2026-10-12#1#1', InvoicePayments: [{ Amount: 20 }] },
  { PK: '101', SK: '2025-10-12#1#1', InvoicePayments: [{ Amount: 5 }] },
  // datePrev de dateTo=2026-10-12 (totalAnterior del ticker) y un día que solo cuenta en los acumulados.
  { PK: '101', SK: '2026-10-05#1#1', InvoicePayments: [{ Amount: 3 }] },
  { PK: '202', SK: '2026-10-05#1#1', InvoicePayments: [{ Amount: 7 }] },
  { PK: '101', SK: '2026-10-08#1#1', InvoicePayments: [{ Amount: 100 }] },
  // dateTo=2026-01-03: su datePrev (2025-12-27) cae en el año anterior.
  { PK: '101', SK: '2026-01-03#1#1', InvoicePayments: [{ Amount: 11 }] },
  { PK: '202', SK: '2026-01-03#1#1', InvoicePayments: [{ Amount: 22 }] },
  { PK: '101', SK: '2025-12-27#1#1', InvoicePayments: [{ Amount: 4 }] },
  { PK: '202', SK: '2025-12-27#1#1', InvoicePayments: [{ Amount: 8 }] },
]);
db.crearTabla(tables.gestionFestivos, { hashKey: 'PK', rangeKey: 'SK' });
db.crearTabla(tables.comprasProveedor, {
  hashKey: 'PK',
  rangeKey: 'SK',
  indices: {
    'Mes-Fecha-index': { hashKey: 'gsi_mes', rangeKey: 'gsi_fecha' },
    'ProductId-AlbaranFecha-index': { hashKey: 'ProductId', rangeKey: 'AlbaranFecha' },
  },
});
db.crearTabla(tables.agoraUsuarios, { hashKey: 'PK', rangeKey: 'SK' });
db.crearTabla(tables.formasPago, { hashKey: 'PK', rangeKey: 'SK' });
db.crearTabla(tables.saleCenters, { hashKey: 'PK', rangeKey: 'SK' });
db.crearTabla(tables.franjasHorarias, { hashKey: 'PK', rangeKey: 'SK' });
db.instalar(docClient);
invalidarContextoAcceso();
invalidarMaestroLocales();

const MODO_ORIGINAL = process.env.ALCANCE_MODO_LECTURAS;
afterEach(() => {
  if (MODO_ORIGINAL === undefined) delete process.env.ALCANCE_MODO_LECTURAS;
  else process.env.ALCANCE_MODO_LECTURAS = MODO_ORIGINAL;
});

let usuarioActual = ADMIN;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = usuarioActual;
  next();
});
app.use('/api', agoraRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
  globalThis.fetch = fetchReal;
});

async function get(ruta, usuario) {
  usuarioActual = usuario;
  const res = await fetchReal(base + ruta);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

for (const [ruta, permisos] of RUTAS) {
  const nombre = ruta.split('?')[0];

  test(`${nombre}: sin el permiso, 403`, async () => {
    const r = await get(ruta, SIN_PERMISOS);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, 'Permiso insuficiente');
  });

  test(`${nombre}: 200 con ${permisos.join(' o ')} y como Administrador`, async () => {
    for (const usuario of [...permisos.map(conPermiso), ADMIN]) {
      const r = await get(ruta, usuario);
      assert.equal(r.status, 200, `${usuario.rol}: ${JSON.stringify(r.body)}`);
    }
  });
}

test('el permiso de por-producto no abre el listado de compras', async () => {
  assert.equal((await get('/api/agora/purchases?dateFrom=2026-10-01&dateTo=2026-10-31', conPermiso('acuerdos.ver'))).status, 403);
  assert.equal((await get('/api/agora/purchases/por-producto?productId=10', conPermiso('acuerdos.ver'))).status, 200);
});

test('test-connection: solo Administrador (ni con todos los permisos de lectura)', async () => {
  for (const permiso of ['cierres.ver', 'puntos_venta.ver', 'usuarios_agora.ver']) {
    const r = await get('/api/agora/test-connection', conPermiso(permiso));
    assert.equal(r.status, 403, permiso);
    assert.equal(r.body.error, 'Rol insuficiente para este recurso');
  }
  assert.equal((await get('/api/agora/test-connection', SIN_PERMISOS)).status, 403);
  const admin = await get('/api/agora/test-connection', ADMIN);
  assert.notEqual(admin.status, 403);
});

// ─── agora/products en vivo ───

test('agora/products?source=agora (o force=agora) sin productos.sincronizar: 403 sin llamar a Ágora', async () => {
  let llamadasAgora = 0;
  const stub = globalThis.fetch;
  globalThis.fetch = async (url, opciones) => {
    if (String(url).startsWith('http://agora.falso')) llamadasAgora += 1;
    return stub(url, opciones);
  };
  try {
    for (const ruta of ['/api/agora/products?source=agora', '/api/agora/products?force=agora']) {
      for (const usuario of [SIN_PERMISOS, conPermiso('cierres.ver')]) {
        const r = await get(ruta, usuario);
        assert.equal(r.status, 403, `${ruta} ${usuario.rol}`);
        assert.match(r.body.error, /productos\.sincronizar o ajustes\.sincronizaciones\.agora_productos/);
      }
    }
    assert.equal(llamadasAgora, 0);
  } finally {
    globalThis.fetch = stub;
  }
});

test('agora/products?source=agora con productos.sincronizar, ajustes.sincronizaciones.agora_productos o Administrador: no 403', async () => {
  for (const usuario of [
    conPermiso('productos.sincronizar'),
    conPermiso('ajustes.sincronizaciones.agora_productos'),
    ADMIN,
  ]) {
    for (const ruta of ['/api/agora/products?source=agora', '/api/agora/products?force=agora']) {
      const r = await get(ruta, usuario);
      assert.notEqual(r.status, 403, `${ruta} ${usuario.rol}: ${JSON.stringify(r.body)}`);
      assert.equal(r.status, 200, `${ruta} ${usuario.rol}: ${JSON.stringify(r.body)}`);
    }
  }
});

test('agora/products sin source=agora: lectura desde Dynamo sigue 200 sin permiso', async () => {
  const r = await get('/api/agora/products', SIN_PERMISOS);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.productos.length, 1);
});

// ─── dashboard-home ───

const HOME = '/api/agora/closeouts/dashboard-home?dateTo=2026-10-12';
const ACUMULADOS = ['ytdCurrent', 'ytdLastYear', 'monthsCurrent', 'monthsLastYear'];

test('dashboard-home sin cajas.ver: ticker solo de su local y sin acumulados (también en observar)', async () => {
  for (const modo of [undefined, 'observar', 'bloquear']) {
    if (modo === undefined) delete process.env.ALCANCE_MODO_LECTURAS;
    else process.env.ALCANCE_MODO_LECTURAS = modo;
    const r = await get(HOME, LOCAL_PARIPE);
    assert.equal(r.status, 200, String(modo));
    assert.deepEqual(r.body.totalsTicker.map((t) => t.workplaceId), ['101'], String(modo));
    for (const clave of ACUMULADOS) assert.equal(clave in r.body, false, `${modo}: ${clave}`);
  }
});

test('dashboard-home sin permisos ni locales: ticker de todos, sin acumulados', async () => {
  const r = await get(HOME, SIN_PERMISOS);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.totalsTicker.map((t) => t.workplaceId).sort(), ['101', '202']);
  for (const clave of ACUMULADOS) assert.equal(clave in r.body, false, clave);
});

test('dashboard-home con cajas.ver: acumulados de grupo; el ticker sigue filtrado por local', async () => {
  const r = await get(HOME, CAJAS_PARIPE);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.totalsTicker.map((t) => t.workplaceId), ['101']);
  for (const clave of ACUMULADOS) assert.ok(r.body[clave], clave);
  assert.deepEqual(r.body.ytdCurrent.totals.map((t) => t.workplaceId).sort(), ['101', '202']);
  assert.equal(r.body.monthsCurrent.months[9].total, 140);
  assert.equal(r.body.ytdLastYear.totals[0].total, 5);

  const todos = await get(HOME, CAJAS_TODOS);
  assert.deepEqual(todos.body.totalsTicker.map((t) => t.workplaceId).sort(), ['101', '202']);
});

test('dashboard-home como Administrador: ticker completo y acumulados', async () => {
  const r = await get(HOME, ADMIN);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.totalsTicker.map((t) => t.workplaceId), ['202', '101']);
  for (const clave of ACUMULADOS) assert.ok(r.body[clave], clave);
});

/** Pares [PK, inicio de SK] de las consultas a cierres durante `fn`. */
async function consultasCierres(fn) {
  const consultas = [];
  const enviar = docClient.send;
  docClient.send = (cmd) => {
    if (cmd?.input?.TableName === tables.salesCloseOuts) {
      const v = cmd.input.ExpressionAttributeValues || {};
      consultas.push([v[':pk'], v[':skFrom']]);
    }
    return enviar(cmd);
  };
  try {
    const resultado = await fn();
    return { resultado, consultas: consultas.sort() };
  } finally {
    docClient.send = enviar;
  }
}

test('dashboard-home sin cajas.ver: solo consulta dateTo y datePrev de sus locales y el ticker no cambia', async () => {
  const { resultado: r, consultas } = await consultasCierres(() => get(HOME, LOCAL_PARIPE));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.totalsTicker, [{ local: 'PARIPE', total: 10, totalAnterior: 3, workplaceId: '101' }]);
  assert.deepEqual(consultas, [['101', '2026-10-05'], ['101', '2026-10-12']]);

  const conCajas = await get(HOME, CAJAS_PARIPE);
  assert.deepEqual(conCajas.body.totalsTicker, r.body.totalsTicker);
});

test('dashboard-home sin cajas.ver y alcance global: consulta solo los dos días, mismo ticker que el Administrador', async () => {
  const { resultado: r, consultas } = await consultasCierres(() => get(HOME, SIN_PERMISOS));
  assert.equal(r.status, 200);
  assert.deepEqual(consultas, [['101', '2026-10-05'], ['101', '2026-10-12'], ['202', '2026-10-05'], ['202', '2026-10-12']]);
  const admin = await get(HOME, ADMIN);
  assert.deepEqual(r.body.totalsTicker, admin.body.totalsTicker);
  assert.deepEqual(r.body.totalsTicker, [
    { local: 'SUR', total: 20, totalAnterior: 7, workplaceId: '202' },
    { local: 'PARIPE', total: 10, totalAnterior: 3, workplaceId: '101' },
  ]);
});

test('dashboard-home sin cajas.ver a principios de año: datePrev en diciembre anterior, mismo ticker que el Administrador', async () => {
  const ruta = '/api/agora/closeouts/dashboard-home?dateTo=2026-01-03';
  const { resultado: r, consultas } = await consultasCierres(() => get(ruta, SIN_PERMISOS));
  assert.equal(r.status, 200);
  assert.deepEqual(consultas, [['101', '2025-12-27'], ['101', '2026-01-03'], ['202', '2025-12-27'], ['202', '2026-01-03']]);
  const admin = await get(ruta, ADMIN);
  assert.deepEqual(r.body.totalsTicker, admin.body.totalsTicker);
  assert.deepEqual(r.body.totalsTicker, [
    { local: 'SUR', total: 22, totalAnterior: 8, workplaceId: '202' },
    { local: 'PARIPE', total: 11, totalAnterior: 4, workplaceId: '101' },
  ]);

  const { resultado: paripe, consultas: consultasParipe } = await consultasCierres(() => get(ruta, LOCAL_PARIPE));
  assert.deepEqual(consultasParipe, [['101', '2025-12-27'], ['101', '2026-01-03']]);
  assert.deepEqual(paripe.body.totalsTicker, [{ local: 'PARIPE', total: 11, totalAnterior: 4, workplaceId: '101' }]);
});

test('dashboard-home con cajas.ver: sigue consultando desde el 1 de enero del año anterior', async () => {
  const { consultas } = await consultasCierres(() => get(HOME, CAJAS_PARIPE));
  assert.deepEqual(consultas, [['101', '2025-01-01'], ['202', '2025-01-01']]);
});
