/**
 * Conciliación bancaria y alcance por sociedad:
 *
 * - Sugerencias: el `limite` cuenta solo los movimientos que el usuario puede
 *   ver. Antes se cortaba el barrido y después se filtraba por sociedad, así que
 *   los movimientos ajenos más recientes ocupaban el cupo del restringido.
 * - Escrituras sobre un movimiento cuya cuenta no tiene sociedad: el usuario
 *   restringido recibe 403 MOVIMIENTO_SIN_SOCIEDAD (accionable), no el 404
 *   genérico. Si el movimiento es de otra sociedad sigue siendo 404.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-conciliacion';

const { montarEscenario, tables, local, empresa, EMPRESA_NORTE, EMPRESA_SUR } = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: bancaConciliacionRouter } = await import('../routes/bancaConciliacion.js');
const { docClient } = await import('../lib/db.js');
const { MAX_PAGINAS_BARRIDO_RESTRINGIDO } = await import('../lib/banca/conciliacion/store.js');

const ROL = 'Encargado';
const PERMISOS = ['banca.ver', 'banca.importar', 'facturacion.cobrar_pagar'];
const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };
const NORTE = { sub: 'u-norte', email: 'norte@grupo.test', rol: ROL };
// Restringido a una sociedad sin movimientos.
const ESTE = { sub: 'u-este', email: 'este@grupo.test', rol: ROL };
// Restringido a un local que no existe: alcance no global y sin ninguna sociedad.
const SIN_SOCIEDADES = { sub: 'u-nada', email: 'nada@grupo.test', rol: ROL };
const EMPRESA_ESTE = '000099';

const IBAN_NORTE = 'ES1000492352082414205416';
const IBAN_SUR = 'ES9121000418450200051332';
const IBAN_SIN = 'ES7921000813610123456789';

const MENSAJE_SIN_SOCIEDAD = 'Este movimiento no tiene una cuenta con sociedad asignada; pide a un administrador que lo revise.';

let db;
let usuarioActual = NORTE;
let servidor = null;
let base = '';

function sembrarMovimiento(iban, hash, fecha, empresaId, extra = {}) {
  db.sembrar(tables.bankMovements, {
    PK: `ACCOUNT#${iban}`,
    SK: `TXN#${fecha}#${hash}`,
    cuentaRef: iban,
    movementHash: hash,
    fechaOperacion: fecha,
    estadoConciliacion: 'pendiente',
    importeCentimos: 1000,
    ...(empresaId && { empresaId }),
    ...extra,
  });
}

beforeEach(() => {
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.bankMovements, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'EmpresaId-FechaOperacion-index': { hashKey: 'empresaId', rangeKey: 'fechaOperacion' },
      'Estado-FechaOperacion-index': { hashKey: 'estadoConciliacion', rangeKey: 'fechaOperacion' },
    },
  });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.locales, local('000020', 'Local Sur', EMPRESA_SUR));
  db.sembrar(tables.empresas, empresa(EMPRESA_NORTE, 'Norte'));
  db.sembrar(tables.empresas, empresa(EMPRESA_SUR, 'Sur'));
  db.sembrar(tables.locales, local('000030', 'Local Este', EMPRESA_ESTE));
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: NORTE.email, Local: ['Local Norte'], Rol: ROL });
  db.sembrar(tables.usuarios, { id_usuario: 'u-este', Email: ESTE.email, Local: ['Local Este'], Rol: ROL });
  db.sembrar(tables.usuarios, { id_usuario: 'u-nada', Email: SIN_SOCIEDADES.email, Local: ['Local Inexistente'], Rol: ROL });
  db.sembrar(tables.usuarios, { id_usuario: '000001', Email: ADMIN.email, Rol: 'Administrador' });
  for (const p of PERMISOS) db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: `PERMISO#${p}` });
  db.sembrar(tables.facturas, { id_factura: 'F-NORTE', emisor_id: EMPRESA_NORTE, tipo: 'OUT' });

  // Más movimientos ajenos (y más recientes) que el límite del barrido.
  for (let i = 1; i <= 5; i += 1) sembrarMovimiento(IBAN_SUR, `hs${i}`, `2026-03-0${i}`, EMPRESA_SUR);
  sembrarMovimiento(IBAN_NORTE, 'hn1', '2026-02-11', EMPRESA_NORTE);
  sembrarMovimiento(IBAN_NORTE, 'hn2', '2026-02-12', EMPRESA_NORTE, { estadoConciliacion: 'parcial', conciliadoCentimos: 100 });
  sembrarMovimiento(IBAN_SIN, 'hx', '2026-02-10', '');

  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function api(metodo, ruta, cuerpo, usuario = NORTE) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
    app.use('/api', bancaConciliacionRouter);
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: err.message });
    });
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

// ─── Sugerencias: el límite se aplica tras filtrar por sociedad ───

const SUGERENCIAS = '/api/banca/conciliacion/sugerencias?tipo=OUT&desde=2026-01-01&limite=3';
const hashes = (r) => r.body.porMovimiento.map((m) => m.movementHash).sort();

test('sugerencias: con más movimientos ajenos que el límite, el restringido recibe los suyos', async () => {
  const r = await api('GET', SUGERENCIAS);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(hashes(r), ['hn1', 'hn2']);
  assert.ok(!JSON.stringify(r.body).includes(IBAN_SUR));
  assert.ok(!JSON.stringify(r.body).includes(IBAN_SIN));
});

test('sugerencias: el restringido no pasa del límite aunque tenga más movimientos propios', async () => {
  for (let i = 3; i <= 6; i += 1) sembrarMovimiento(IBAN_NORTE, `hn${i}`, `2026-02-2${i}`, EMPRESA_NORTE);
  const r = await api('GET', SUGERENCIAS);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(hashes(r), ['hn4', 'hn5', 'hn6']);
});

test('sugerencias: el Administrador mantiene el barrido de siempre (una página por estado, sin filtro)', async () => {
  // Depende del tamaño de página del doble (`montarEscenario` pagina de 2 en 2 e
  // ignora `Limit`): pendientes trae hs5 y hs4 en su única página y parciales, hn2.
  const r = await api('GET', SUGERENCIAS, undefined, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(hashes(r), ['hn2', 'hs4', 'hs5']);
  assert.equal(r.body.truncado, false);
});

test('sugerencias: restringido sin movimientos de su sociedad agota el índice y recibe [] sin truncar', async () => {
  const r = await api('GET', SUGERENCIAS, undefined, ESTE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.porMovimiento, []);
  assert.equal(r.body.truncado, false);
});

test('sugerencias: si el barrido del restringido se corta por el tope de páginas, devuelve truncado', async () => {
  // Con páginas de 2, más de 2 × MAX_PAGINAS_BARRIDO_RESTRINGIDO pendientes ajenos más recientes que los propios.
  const paginasAjenas = MAX_PAGINAS_BARRIDO_RESTRINGIDO * 2 + 5;
  for (let i = 0; i < paginasAjenas; i += 1) {
    const fecha = new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10);
    sembrarMovimiento(IBAN_SUR, `hz${i}`, fecha, EMPRESA_SUR);
  }
  const r = await api('GET', SUGERENCIAS);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.truncado, true);
  assert.ok(r.body.porMovimiento.every((m) => m.movementHash.startsWith('hn')));
});

test('sugerencias: restringido sin sociedades no consulta movimientos y recibe []', async () => {
  const consultas = [];
  const enviar = docClient.send;
  docClient.send = (cmd) => {
    if (cmd?.input?.TableName === tables.bankMovements) consultas.push(cmd.input);
    return enviar.call(docClient, cmd);
  };
  try {
    const r = await api('GET', SUGERENCIAS, undefined, SIN_SOCIEDADES);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.porMovimiento, []);
    assert.deepEqual(r.body.porFactura, []);
    assert.equal(r.body.truncado, false);
  } finally {
    docClient.send = enviar;
  }
  assert.equal(consultas.length, 0);
});

// ─── Escrituras sobre movimientos sin sociedad ───

const movimiento = (iban, hash, fechaOperacion) => ({ cuentaRef: iban, movementHash: hash, fechaOperacion });
const SIN = movimiento(IBAN_SIN, 'hx', '2026-02-10');
const SUR = movimiento(IBAN_SUR, 'hs1', '2026-03-01');
const leer = (m) => db.obtener(tables.bankMovements, { PK: `ACCOUNT#${m.cuentaRef}`, SK: `TXN#${m.fechaOperacion}#${m.movementHash}` });

const ESCRITURAS = [
  ['aplicar', 'POST', '/api/banca/conciliacion/aplicar', (m) => ({ ...m, asignaciones: [{ id_factura: 'F-NORTE', importe: 10 }] })],
  ['deshacer', 'DELETE', '/api/banca/conciliacion', (m) => ({ ...m, id_factura: 'F-NORTE' })],
  ['descartar', 'POST', '/api/banca/conciliacion/descartar', (m) => ({ ...m, id_factura: 'F-NORTE' })],
  ['ignorar', 'POST', '/api/banca/conciliacion/ignorar', (m) => ({ ...m })],
];

function conciliar(m) {
  db.sembrar(tables.bankMovements, {
    ...leer(m),
    estadoConciliacion: 'conciliado',
    conciliadoCentimos: 1000,
    conciliaciones: [{ id_factura: 'F-NORTE', id_pago: 'PAG-1', importeCentimos: 1000 }],
  });
}

for (const [nombre, metodo, ruta, cuerpo] of ESCRITURAS) {
  test(`${nombre}: movimiento sin sociedad y usuario restringido da 403 MOVIMIENTO_SIN_SOCIEDAD sin escribir`, async () => {
    if (nombre === 'deshacer') conciliar(SIN);
    const antes = structuredClone(leer(SIN));
    const r = await api(metodo, ruta, cuerpo(SIN));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'MOVIMIENTO_SIN_SOCIEDAD');
    assert.equal(r.body.error, MENSAJE_SIN_SOCIEDAD);
    assert.deepEqual(leer(SIN), antes);
  });

  test(`${nombre}: movimiento de otra sociedad sigue dando 404 genérico`, async () => {
    if (nombre === 'deshacer') conciliar(SUR);
    const antes = structuredClone(leer(SUR));
    const r = await api(metodo, ruta, cuerpo(SUR));
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.code, 'MOVIMIENTO_NO_ENCONTRADO');
    assert.equal(r.body.error, 'Movimiento bancario no encontrado');
    assert.deepEqual(leer(SUR), antes);
  });

  test(`${nombre}: el Administrador no recibe 403 ni 404 de movimiento sobre el movimiento sin sociedad`, async () => {
    if (nombre === 'deshacer') conciliar(SIN);
    const r = await api(metodo, ruta, cuerpo(SIN), ADMIN);
    assert.notEqual(r.status, 403, JSON.stringify(r.body));
    assert.notEqual(r.body.code, 'MOVIMIENTO_NO_ENCONTRADO', JSON.stringify(r.body));
    assert.notEqual(r.body.code, 'MOVIMIENTO_SIN_SOCIEDAD', JSON.stringify(r.body));
  });
}

test('movimiento inexistente: sigue dando 404 para el restringido', async () => {
  const r = await api('POST', '/api/banca/conciliacion/ignorar', movimiento(IBAN_SIN, 'no-existe', '2026-02-10'));
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'MOVIMIENTO_NO_ENCONTRADO');
});
