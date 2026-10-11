/**
 * [SEC S-08] Remesas por sociedad: un usuario restringido a la sociedad Norte no
 * crea, edita, genera, ejecuta ni anula remesas de la sociedad Sur, ni mete en
 * su remesa facturas de otra sociedad.
 *
 * Escrituras: bloquean siempre. Lecturas (listado y detalle): en modo 'observar'
 * (por defecto) se sirven y avisan; con ALCANCE_MODO_LECTURAS=bloquear se filtran.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alcance-remesas';

const { montarEscenario, tables, local, EMPRESA_NORTE, EMPRESA_SUR } = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: remesasRouter } = await import('../routes/remesas.js');

const ROL = 'Administracion';
const PERMISOS = ['remesas.ver', 'remesas.gestionar', 'facturacion.cobrar_pagar'];
const NORTE = { sub: 'u-norte', id_usuario: 'u-norte', email: 'norte@grupo.test', rol: ROL };
const ADMIN = { sub: 'u-admin', email: 'admin@grupo.test', rol: 'Administrador' };
const MENSAJE = 'No tienes acceso a esa sociedad';

const IBAN_NORTE = 'ES6621000418401234567891';
const IBAN_SUR = 'ES7921000813610123456789';
const IBAN_PROVEEDOR = 'ES9121000418450200051332';

let db;
let usuario = NORTE;
const avisos = [];
const warnOriginal = console.warn;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = usuario;
  next();
});
app.use('/api', remesasRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

async function api(metodo, ruta, cuerpo) {
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  const texto = await res.text();
  let body = {};
  try { body = JSON.parse(texto); } catch { /* fichero */ }
  return { status: res.status, body };
}

function facturaIn(id, emisor) {
  return {
    id_factura: id, tipo: 'IN', estado: 'pendiente_pago', emisor_id: emisor,
    empresa_id: '000010', empresa_cif: 'B12345678', empresa_nombre: 'Proveedor S.L.',
    numero_factura: id, total_factura: 100, total_cobrado: 0, saldo_pendiente: 100, version: 1,
  };
}

function remesa(id, sociedadId, cuenta, factura) {
  return {
    remesaId: id, nombre: `Remesa ${id}`, banco: 'BBVA_FIT', estado: 'Borrador', sociedadId,
    sociedadNombre: sociedadId, sociedadCif: `B${sociedadId}`, cuentaOrdenante: cuenta, sufijoOrdenante: '',
    fechaEjecucion: '', excluidas: [], importeTotal: 100, creadoEn: `2026-10-0${sociedadId === EMPRESA_SUR ? 2 : 1}`,
    lineas: [{
      id_factura: factura, importe: 100, importeMaximo: 100, saldoPendiente: 100,
      ibanBeneficiario: IBAN_PROVEEDOR, nombreBeneficiario: 'Proveedor S.L.', concepto: factura,
    }],
  };
}

beforeEach(() => {
  delete process.env.ALCANCE_MODO_LECTURAS;
  usuario = NORTE;
  avisos.length = 0;
  console.warn = (...args) => {
    if (args[0] === '[alcance] denegaría') avisos.push(args[1]);
    else warnOriginal(...args);
  };
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.remesas, { hashKey: 'remesaId' });
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.bankAccounts, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'EmpresaId-Iban-index': { hashKey: 'empresaId', rangeKey: 'iban' } },
  });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.locales, local('000020', 'Local Sur', EMPRESA_SUR));
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: NORTE.email, Local: ['Local Norte'], Rol: ROL });
  for (const p of PERMISOS) db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: `PERMISO#${p}` });
  db.sembrar(tables.empresas, { id_empresa: EMPRESA_NORTE, Nombre: 'Norte', Cif: 'B00000002', IbanPredeterminado: IBAN_NORTE });
  db.sembrar(tables.empresas, { id_empresa: EMPRESA_SUR, Nombre: 'Sur', Cif: 'B00000003', IbanPredeterminado: IBAN_SUR });
  db.sembrar(tables.empresas, { id_empresa: '000010', Nombre: 'Proveedor S.L.', Cif: 'B12345678', IbanPredeterminado: IBAN_PROVEEDOR });
  for (const [iban, empresaId] of [[IBAN_NORTE, EMPRESA_NORTE], [IBAN_SUR, EMPRESA_SUR], [IBAN_PROVEEDOR, '000010']]) {
    db.sembrar(tables.bankAccounts, { PK: `ACCOUNT#${iban}`, SK: 'META', iban, empresaId, activa: true });
  }
  db.sembrar(tables.facturas, facturaIn('F-NORTE', EMPRESA_NORTE));
  db.sembrar(tables.facturas, facturaIn('F-NORTE-2', EMPRESA_NORTE));
  db.sembrar(tables.facturas, facturaIn('F-SUR', EMPRESA_SUR));
  db.sembrar(tables.facturas, facturaIn('F-SUR-LIBRE', EMPRESA_SUR));
  db.sembrar(tables.remesas, remesa('R-NORTE', EMPRESA_NORTE, IBAN_NORTE, 'F-NORTE'));
  db.sembrar(tables.remesas, remesa('R-SUR', EMPRESA_SUR, IBAN_SUR, 'F-SUR'));
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  console.warn = warnOriginal;
  servidor.closeAllConnections?.();
  servidor.close();
});

const remesaGuardada = (id) => db.obtener(tables.remesas, { remesaId: id });

test('crear remesa de una sociedad ajena: 403 y no se crea; en la propia, sí', async () => {
  const ajena = await api('POST', '/api/remesas', { nombre: 'X', sociedadId: EMPRESA_SUR, facturaIds: ['F-SUR'] });
  assert.equal(ajena.status, 403);
  assert.equal(ajena.body.error, MENSAJE);
  assert.equal(db.listar(tables.remesas).length, 2);

  const propia = await api('POST', '/api/remesas', { nombre: 'N', sociedadId: EMPRESA_NORTE, facturaIds: ['F-NORTE-2'] });
  assert.equal(propia.status, 201, JSON.stringify(propia.body));
});

test('acciones sobre una remesa de otra sociedad: 403 y la remesa no cambia ni se paga nada', async () => {
  const antes = remesaGuardada('R-SUR');
  const ataques = [
    ['PATCH', '/api/remesas/R-SUR', { nombre: 'Robada' }],
    ['PATCH', '/api/remesas/R-SUR', { anadirFacturaIds: ['F-NORTE-2'] }],
    ['PATCH', '/api/remesas/R-SUR', { quitarFacturaIds: ['F-SUR'] }],
    ['PATCH', '/api/remesas/R-SUR', { accion: 'reabrir' }],
    ['POST', '/api/remesas/R-SUR/revalidar', {}],
    ['GET', '/api/remesas/R-SUR/fichero'],
    ['POST', '/api/remesas/R-SUR/ejecutar', { fecha: '2026-10-11' }],
    ['POST', '/api/remesas/R-SUR/anular', {}],
  ];
  for (const [metodo, ruta, cuerpo] of ataques) {
    const r = await api(metodo, ruta, cuerpo);
    assert.equal(r.status, 403, `${metodo} ${ruta} ${JSON.stringify(cuerpo)}`);
    assert.equal(r.body.error, MENSAJE);
  }
  assert.deepEqual(remesaGuardada('R-SUR'), antes);
  assert.equal(db.listar(tables.facturasPagos).length, 0);
  assert.equal(avisos.length, 0, 'una escritura no observa: bloquea');
});

test('remesa propia: editar y anular siguen funcionando', async () => {
  assert.equal((await api('PATCH', '/api/remesas/R-NORTE', { nombre: 'Nueva' })).status, 200);
  assert.equal(remesaGuardada('R-NORTE').nombre, 'Nueva');
  assert.equal((await api('POST', '/api/remesas/R-NORTE/anular', {})).status, 200);
  assert.equal(remesaGuardada('R-NORTE').estado, 'Anulada');
});

test('añadir a la remesa propia una factura de otra sociedad: queda excluida y no entra en las líneas', async () => {
  const r = await api('PATCH', '/api/remesas/R-NORTE', { anadirFacturaIds: ['F-SUR-LIBRE'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const guardada = remesaGuardada('R-NORTE');
  assert.deepEqual(guardada.lineas.map((l) => l.id_factura), ['F-NORTE']);
  assert.ok(guardada.excluidas.some((e) => e.id_factura === 'F-SUR-LIBRE' && /sociedad ordenante/.test(e.motivo)));
});

test('un administrador opera sobre cualquier sociedad', async () => {
  usuario = ADMIN;
  assert.equal((await api('PATCH', '/api/remesas/R-SUR', { nombre: 'Admin' })).status, 200);
  assert.equal((await api('POST', '/api/remesas/R-SUR/anular', {})).status, 200);
  assert.equal(remesaGuardada('R-SUR').estado, 'Anulada');
});

test('lecturas en modo observar: listado y detalle se sirven y avisan por la sociedad ajena', async () => {
  const lista = await api('GET', '/api/remesas');
  assert.deepEqual(lista.body.items.map((r) => r.remesaId).sort(), ['R-NORTE', 'R-SUR']);
  assert.deepEqual(avisos, [{ ruta: '/api/remesas', usuario: 'u-norte', empresa: EMPRESA_SUR }]);
  avisos.length = 0;
  const detalle = await api('GET', '/api/remesas/R-SUR');
  assert.equal(detalle.status, 200);
  assert.equal(avisos.length, 1);
});

test('lecturas en modo bloquear: el listado solo trae las suyas y el detalle ajeno es 403', async () => {
  process.env.ALCANCE_MODO_LECTURAS = 'bloquear';
  const lista = await api('GET', '/api/remesas');
  assert.deepEqual(lista.body.items.map((r) => r.remesaId), ['R-NORTE']);
  const detalle = await api('GET', '/api/remesas/R-SUR');
  assert.equal(detalle.status, 403);
  assert.equal(detalle.body.error, MENSAJE);
  assert.equal((await api('GET', '/api/remesas/R-NORTE')).status, 200);
});
