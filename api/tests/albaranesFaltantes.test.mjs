/**
 * Albaranes que faltan en facturas IN: saneado del array, PUT de la factura
 * (también tras validarla) y comprobación del nº de documento contra Ágora.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';
import { createRequire } from 'node:module';

const Tesseract = createRequire(import.meta.url)('tesseract.js');
Tesseract.createWorker = async () => ({
  recognize: async () => ({ data: { text: '' } }),
  terminate: async () => {},
});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-albaranes-faltantes';
delete process.env.AGORA_BASE_URL;
process.env.AGORA_API_BASE_URL = 'http://agora.falso';
process.env.AGORA_API_TOKEN = 'token-de-prueba';

const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, opciones) => {
  const u = String(url);
  if (!u.startsWith('http://agora.falso')) return fetchReal(url, opciones);
  return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { montarEscenario, tables, local, EMPRESA_NORTE } = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { aplicarClavesFactura } = await import('../lib/facturacion/clavesIndice.js');
const { aplicarClavesGsi, clavesComprasProveedor } = await import('../lib/clavesIndice.js');
const { sanitizeAlbaranesFaltantes, normDocProveedor } = await import('../lib/facturacion/albaranesFaltantes.js');
const { invalidarCacheComprobacionAlbaranes } = await import('../lib/compras/albaranesFaltantesComprobar.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');
const { default: agoraRouter } = await import('../routes/agora.js');

const ROL = 'Administracion';
const PERMISOS = ['facturacion.emitir', 'facturacion.ver', 'compras_proveedor.ver'];
const NORTE = { sub: 'u-norte', email: 'norte@grupo.test', Nombre: 'Norte', rol: ROL };
const SIN_PERMISOS = { sub: 'u-nadie', email: 'nadie@grupo.test', rol: 'Nadie' };
const ANIO = 2025;

let db;
let usuario = NORTE;
let servidor = null;
let base = '';

function factura(id, campos = {}) {
  return aplicarClavesFactura({
    id_factura: id,
    tipo: 'IN',
    emisor_id: EMPRESA_NORTE,
    estado: 'pendiente_pago',
    fecha_emision: `${ANIO}-03-15`,
    empresa_cif: 'B11111111',
    empresa_nombre: 'Proveedor Uno',
    total_factura: 100,
    version: 1,
    ...campos,
  });
}

function compra(pk, sk, campos) {
  const item = {
    PK: pk,
    SK: sk,
    AlbaranFecha: `${ANIO}-03-10`,
    AlbaranSerie: 'AC',
    AlbaranNumero: '5929',
    SupplierCif: 'B11111111',
    SupplierName: 'Proveedor Uno',
    SupplierDocumentNumber: 'F26 004418',
    WarehouseId: '000006',
    WarehouseName: 'Almacén Sur',
    Quantity: 1,
    ...campos,
  };
  return aplicarClavesGsi(item, clavesComprasProveedor(item.AlbaranFecha));
}

beforeEach(() => {
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.remesas, {
    hashKey: 'remesaId',
    indices: {
      'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' },
      'Activa-index': { hashKey: 'gsi_activa', rangeKey: 'gsi_fecha' },
    },
  });
  db.crearTabla(tables.comprasProveedor, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Mes-Fecha-index': { hashKey: 'gsi_mes', rangeKey: 'gsi_fecha' },
      'ProductId-AlbaranFecha-index': { hashKey: 'ProductId', rangeKey: 'AlbaranFecha' },
    },
  });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: NORTE.email, Local: ['Local Norte'], Rol: ROL });
  for (const p of PERMISOS) db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: `PERMISO#${p}` });

  db.sembrar(tables.facturas, factura('F-VAL'));
  db.sembrar(tables.facturas, factura('F-ANU', { estado: 'anulada' }));
  db.sembrar(tables.facturas, factura('F-OUT', { tipo: 'OUT', estado: 'emitida' }));

  // Albarán AC-5929 de Proveedor Uno en el almacén de Sur, con dos líneas.
  db.sembrar(tables.comprasProveedor, compra('AC-5929', '1', {}));
  db.sembrar(tables.comprasProveedor, compra('AC-5929', '2', {}));
  // Mismo nº de documento, pero de otro proveedor: no debe contar.
  db.sembrar(tables.comprasProveedor, compra('AC-7000', '1', {
    AlbaranNumero: '7000',
    SupplierCif: 'B22222222',
    SupplierName: 'Proveedor Dos',
    SupplierDocumentNumber: 'F26-004418',
    WarehouseId: '000005',
    WarehouseName: 'Almacén Norte',
  }));
  // Mismo proveedor sin CIF en la línea se cruza por nombre solo si la consulta no trae CIF.
  db.sembrar(tables.comprasProveedor, compra('AC-8000', '1', {
    AlbaranNumero: '8000',
    AlbaranFecha: `${ANIO}-05-02`,
    SupplierCif: '',
    SupplierName: 'Proveedor Tres',
    SupplierDocumentNumber: 'ALB/77',
    WarehouseId: '5',
    WarehouseName: 'Otro nombre',
  }));

  usuario = NORTE;
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  invalidarCacheComprobacionAlbaranes();
});

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
  globalThis.fetch = fetchReal;
});

async function api(metodo, ruta, cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuario;
      next();
    });
    app.use('/api', agoraRouter);
    app.use('/api', facturacionRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetchReal(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const leerFactura = (id) => db.obtener(tables.facturas, { id_factura: id });

// ─── Saneado ───

const CTX = { ahoraIso: '2026-10-19T10:00:00.000Z', creado_por: 'Norte', creado_por_id: 'u-norte' };

test('normDocProveedor deja solo letras/dígitos en mayúsculas', () => {
  assert.equal(normDocProveedor(' f26 004-418/a.b '), 'F26004418AB');
  assert.equal(normDocProveedor('F26 004418'), normDocProveedor('F26-004418'));
});

test('sanitize calcula numero_norm, pone id y creado_* del servidor en items nuevos', () => {
  const r = sanitizeAlbaranesFaltantes([{
    numero_doc_proveedor: ' F26 004418 ',
    fecha_albaran: '2025-03-10T00:00:00Z',
    importe: '12,345',
    nota: 'No llegó',
    creado_por_id: 'otro-usuario',
    creado_por: 'Impostor',
    estado: 'raro',
  }], CTX);
  assert.equal(r.ok, true);
  const [it] = r.items;
  assert.match(it.id, /^[0-9a-f-]{36}$/);
  assert.equal(it.numero_doc_proveedor, 'F26 004418');
  assert.equal(it.numero_norm, 'F26004418');
  assert.equal(it.fecha_albaran, '2025-03-10');
  assert.equal(it.importe, 12.35);
  assert.equal(it.estado, 'pendiente');
  assert.equal(it.resuelta_por, null);
  assert.equal(it.resuelta_en, null);
  assert.equal(it.en_otra_empresa, null);
  assert.equal(it.creado_en, CTX.ahoraIso);
  assert.equal(it.creado_por, 'Norte');
  assert.equal(it.creado_por_id, 'u-norte');
});

test('sanitize conserva creado_* guardados de un item existente y resuelve con fecha', () => {
  const previos = [{ id: 'a1', creado_en: '2026-01-01T00:00:00.000Z', creado_por: 'Ana', creado_por_id: 'u-ana' }];
  const r = sanitizeAlbaranesFaltantes([{
    id: 'a1',
    numero_doc_proveedor: 'X1',
    creado_por_id: 'u-falso',
    estado: 'resuelta',
    resuelta_por: 'auto',
    importe: '',
    en_otra_empresa: { empresa_cif: 'B1', empresa_nombre: 'Sur', almacen: 'A', fecha: '2025-01-02' },
  }], { ...CTX, previos });
  assert.equal(r.ok, true);
  const [it] = r.items;
  assert.equal(it.creado_por_id, 'u-ana');
  assert.equal(it.creado_por, 'Ana');
  assert.equal(it.creado_en, '2026-01-01T00:00:00.000Z');
  assert.equal(it.estado, 'resuelta');
  assert.equal(it.resuelta_por, 'auto');
  assert.equal(it.resuelta_en, CTX.ahoraIso);
  assert.equal(it.importe, null);
  assert.deepEqual(it.en_otra_empresa, { empresa_cif: 'B1', empresa_nombre: 'Sur', almacen: 'A', fecha: '2025-01-02' });
});

test('sanitize rechaza duplicados normalizados, límites y datos inválidos', () => {
  const dup = sanitizeAlbaranesFaltantes([{ numero_doc_proveedor: 'F26 004418' }, { numero_doc_proveedor: 'f26-004418' }], CTX);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /ya está anotado/);

  const muchos = Array.from({ length: 101 }, (_, i) => ({ numero_doc_proveedor: `N${i}` }));
  assert.equal(sanitizeAlbaranesFaltantes(muchos, CTX).ok, false);
  assert.equal(sanitizeAlbaranesFaltantes(muchos.slice(0, 100), CTX).ok, true);

  assert.equal(sanitizeAlbaranesFaltantes([{ numero_doc_proveedor: '' }], CTX).ok, false);
  assert.equal(sanitizeAlbaranesFaltantes([{ numero_doc_proveedor: '--' }], CTX).ok, false);
  assert.equal(sanitizeAlbaranesFaltantes([{ numero_doc_proveedor: 'X'.repeat(61) }], CTX).ok, false);
  assert.equal(sanitizeAlbaranesFaltantes([{ numero_doc_proveedor: 'X', nota: 'n'.repeat(301) }], CTX).ok, false);
  assert.equal(sanitizeAlbaranesFaltantes([{ numero_doc_proveedor: 'X', fecha_albaran: '10/03/2025' }], CTX).ok, false);
  assert.equal(sanitizeAlbaranesFaltantes({}, CTX).ok, false);
  assert.deepEqual(sanitizeAlbaranesFaltantes(null, CTX), { ok: true, items: [] });
});

// ─── PUT /facturacion/facturas/:id/albaranes-faltantes ───

test('PUT se permite en una factura IN ya validada y sube la versión', async () => {
  const r = await api('PUT', '/api/facturacion/facturas/F-VAL/albaranes-faltantes', {
    albaranes_faltantes: [{ numero_doc_proveedor: 'F26 004418', creado_por_id: 'falso' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.albaranes_faltantes.length, 1);
  assert.equal(r.body.albaranes_faltantes[0].numero_norm, 'F26004418');
  assert.equal(r.body.albaranes_faltantes[0].creado_por_id, 'u-norte');
  const f = leerFactura('F-VAL');
  assert.deepEqual(f.albaranes_faltantes, r.body.albaranes_faltantes);
  assert.equal(f.version, 2);
  assert.equal(r.body.version, 2);
});

test('PUT con version correcta guarda y devuelve version+1; con version vieja, 409 FACTURA_CAMBIADA', async () => {
  const ruta = '/api/facturacion/facturas/F-VAL/albaranes-faltantes';
  const ok = await api('PUT', ruta, { version: 1, albaranes_faltantes: [{ numero_doc_proveedor: 'A1' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.version, 2);
  assert.equal(leerFactura('F-VAL').version, 2);

  const vieja = await api('PUT', ruta, { version: 1, albaranes_faltantes: [{ numero_doc_proveedor: 'B2' }] });
  assert.equal(vieja.status, 409);
  assert.equal(vieja.body.code, 'FACTURA_CAMBIADA');
  assert.equal(vieja.body.error, 'La factura ha cambiado, vuelve a intentarlo');
  const f = leerFactura('F-VAL');
  assert.equal(f.version, 2);
  assert.equal(f.albaranes_faltantes[0].numero_norm, 'A1');

  const sigue = await api('PUT', ruta, { version: 2, albaranes_faltantes: [{ numero_doc_proveedor: 'B2' }] });
  assert.equal(sigue.status, 200, JSON.stringify(sigue.body));
  assert.equal(sigue.body.version, 3);

  const mala = await api('PUT', ruta, { version: 'x', albaranes_faltantes: [] });
  assert.equal(mala.status, 400);
});

test('PUT con version 1 en una factura antigua sin version la acepta y la deja en 2', async () => {
  const sinVersion = factura('F-ANT');
  delete sinVersion.version;
  db.sembrar(tables.facturas, sinVersion);
  const r = await api('PUT', '/api/facturacion/facturas/F-ANT/albaranes-faltantes', {
    version: 1,
    albaranes_faltantes: [{ numero_doc_proveedor: 'A1' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.version, 2);
  assert.equal(leerFactura('F-ANT').version, 2);
});

test('PUT rechaza factura anulada (409), tipo OUT (400), inexistente (404) y duplicados (400)', async () => {
  const cuerpo = { albaranes_faltantes: [{ numero_doc_proveedor: 'A1' }] };
  const anulada = await api('PUT', '/api/facturacion/facturas/F-ANU/albaranes-faltantes', cuerpo);
  assert.equal(anulada.status, 409);
  const out = await api('PUT', '/api/facturacion/facturas/F-OUT/albaranes-faltantes', cuerpo);
  assert.equal(out.status, 400);
  const nada = await api('PUT', '/api/facturacion/facturas/F-NADA/albaranes-faltantes', cuerpo);
  assert.equal(nada.status, 404);
  const dup = await api('PUT', '/api/facturacion/facturas/F-VAL/albaranes-faltantes', {
    albaranes_faltantes: [{ numero_doc_proveedor: 'A-1' }, { numero_doc_proveedor: 'a1' }],
  });
  assert.equal(dup.status, 400);
  assert.equal(leerFactura('F-ANU').albaranes_faltantes, undefined);
  assert.equal(leerFactura('F-OUT').albaranes_faltantes, undefined);
  assert.equal(leerFactura('F-VAL').albaranes_faltantes, undefined);
});

test('PUT sin facturacion.emitir: 403', async () => {
  usuario = SIN_PERMISOS;
  const r = await api('PUT', '/api/facturacion/facturas/F-VAL/albaranes-faltantes', { albaranes_faltantes: [] });
  assert.equal(r.status, 403);
});

test('GET /facturacion/facturas?tipo=IN devuelve albaranes_faltantes', async () => {
  await api('PUT', '/api/facturacion/facturas/F-VAL/albaranes-faltantes', {
    albaranes_faltantes: [{ numero_doc_proveedor: 'ALB/77' }],
  });
  const r = await api('GET', `/api/facturacion/facturas?tipo=IN&fechaDesde=${ANIO}-03-01&fechaHasta=${ANIO}-03-31`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const f = r.body.facturas.find((x) => x.id_factura === 'F-VAL');
  assert.ok(f);
  assert.equal(f.albaranes_faltantes[0].numero_norm, 'ALB77');
  assert.equal(f.version, 2);
});

// ─── POST /compras/albaranes-faltantes/comprobar ───

test('comprobar: coincide con el mismo proveedor, agrupa líneas y devuelve el almacén sin empresa', async () => {
  const r = await api('POST', '/api/compras/albaranes-faltantes/comprobar', {
    consultas: [{
      proveedor_cif: 'b-11111111',
      proveedor_nombre: 'Proveedor Uno',
      anio: ANIO,
      numeros: ['F26-004418', 'NO-EXISTE', 'f26004418', ''],
    }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.resultados, [
    {
      proveedor_cif: 'b-11111111',
      proveedor_nombre: 'Proveedor Uno',
      anio: ANIO,
      numero_norm: 'F26004418',
      coincidencias: [{
        warehouse_id: '000006',
        almacen: 'Almacén Sur',
        fecha: `${ANIO}-03-10`,
        albaran: 'AC-5929',
        numero_doc_proveedor: 'F26 004418',
      }],
    },
    {
      proveedor_cif: 'b-11111111',
      proveedor_nombre: 'Proveedor Uno',
      anio: ANIO,
      numero_norm: 'NOEXISTE',
      coincidencias: [],
    },
  ]);
});

test('comprobar: el mismo número de otro proveedor no cuenta; sin CIF cruza por nombre', async () => {
  const r = await api('POST', '/api/compras/albaranes-faltantes/comprobar', {
    consultas: [
      { proveedor_cif: 'B33333333', proveedor_nombre: 'Proveedor Uno', anio: ANIO, numeros: ['F26 004418'] },
      { proveedor_cif: '', proveedor_nombre: 'proveedor tres', anio: ANIO, numeros: ['alb 77'] },
      { proveedor_cif: 'B22222222', proveedor_nombre: '', anio: ANIO + 0, numeros: ['F26004418'] },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [otroCif, porNombre, dos] = r.body.resultados;
  assert.deepEqual(otroCif.coincidencias, []);
  assert.equal(porNombre.coincidencias.length, 1);
  assert.equal(porNombre.coincidencias[0].albaran, 'AC-8000');
  assert.equal(porNombre.coincidencias[0].warehouse_id, '5');
  assert.equal(porNombre.coincidencias[0].almacen, 'Otro nombre');
  assert.equal(porNombre.coincidencias[0].empresa_cif, undefined);
  assert.equal(dos.coincidencias.length, 1);
  assert.equal(dos.coincidencias[0].albaran, 'AC-7000');
  assert.equal(dos.coincidencias[0].warehouse_id, '000005');
});

test('comprobar: un albarán con líneas en almacenes distintos da una coincidencia por almacén', async () => {
  db.sembrar(tables.comprasProveedor, compra('AC-5929', '3', { WarehouseId: '000005', WarehouseName: 'Almacén Norte' }));
  const r = await api('POST', '/api/compras/albaranes-faltantes/comprobar', {
    consultas: [{ proveedor_cif: 'B11111111', proveedor_nombre: '', anio: ANIO, numeros: ['F26004418'] }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [res] = r.body.resultados;
  assert.deepEqual(res.coincidencias.map((c) => [c.albaran, c.warehouse_id]), [['AC-5929', '000005'], ['AC-5929', '000006']]);
});

test('comprobar: una consulta inválida no tumba el lote', async () => {
  const anioActual = new Date().getUTCFullYear();
  const r = await api('POST', '/api/compras/albaranes-faltantes/comprobar', {
    consultas: [
      { proveedor_cif: '', proveedor_nombre: '', anio: ANIO, numeros: ['F26004418', 'f26-004418', 'Z9'] },
      { proveedor_cif: 'B11111111', proveedor_nombre: '', anio: ANIO, numeros: ['F26 004418'] },
      { proveedor_cif: 'B11111111', proveedor_nombre: '', anio: 1999, numeros: ['Q1'] },
      { proveedor_cif: 'B11111111', proveedor_nombre: '', anio: anioActual + 2, numeros: ['Q2'] },
      { proveedor_cif: 'B11111111', proveedor_nombre: '', anio: ANIO, numeros: 'X' },
      { proveedor_cif: 'B11111111', proveedor_nombre: '', anio: ANIO, numeros: Array.from({ length: 101 }, (_, i) => `N${i}`) },
      'no soy un objeto',
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const { resultados } = r.body;
  const invalidas = resultados.filter((x) => x.error === 'consulta_invalida');
  assert.ok(invalidas.every((x) => Array.isArray(x.coincidencias) && x.coincidencias.length === 0));
  assert.deepEqual(resultados.slice(0, 2).map((x) => x.numero_norm), ['F26004418', 'Z9']);
  assert.equal(resultados[0].error, 'consulta_invalida');
  const valida = resultados[2];
  assert.equal(valida.error, undefined);
  assert.equal(valida.coincidencias.length, 1);
  assert.equal(valida.coincidencias[0].albaran, 'AC-5929');
  assert.deepEqual(resultados.slice(3, 5).map((x) => [x.numero_norm, x.error]), [['Q1', 'consulta_invalida'], ['Q2', 'consulta_invalida']]);
  // numeros 'X' (no array) no da nada; los 101 sí salen, todos marcados.
  assert.equal(resultados.length, 5 + 101);
});

test('comprobar: valida el lote y el permiso', async () => {
  const anioActual = new Date().getUTCFullYear();
  const consulta = (extra) => ({ proveedor_cif: 'B11111111', proveedor_nombre: '', anio: ANIO, numeros: ['X'], ...extra });
  const casos = [
    {},
    { consultas: 'x' },
    { consultas: [] },
    { consultas: Array.from({ length: 51 }, () => consulta()) },
  ];
  for (const cuerpo of casos) {
    const r = await api('POST', '/api/compras/albaranes-faltantes/comprobar', cuerpo);
    assert.equal(r.status, 400, JSON.stringify(cuerpo).slice(0, 120));
  }
  const ok = await api('POST', '/api/compras/albaranes-faltantes/comprobar', { consultas: [consulta({ anio: anioActual + 1 })] });
  assert.equal(ok.status, 200);

  usuario = SIN_PERMISOS;
  const sin = await api('POST', '/api/compras/albaranes-faltantes/comprobar', { consultas: [consulta()] });
  assert.equal(sin.status, 403);
});

test('comprobar: cachea las compras del año (no repite las 12 queries) y no escanea maestros', async () => {
  const { docClient } = await import('../lib/db.js');
  const enviar = docClient.send;
  let queries = 0;
  let scans = 0;
  docClient.send = async (cmd) => {
    if (cmd?.constructor?.name === 'QueryCommand' && cmd.input.TableName === tables.comprasProveedor) queries += 1;
    if (cmd?.constructor?.name === 'ScanCommand' && [tables.almacenes, tables.empresas].includes(cmd.input.TableName)) scans += 1;
    return enviar.call(docClient, cmd);
  };
  try {
    const cuerpo = { consultas: [{ proveedor_cif: 'B11111111', proveedor_nombre: '', anio: ANIO, numeros: ['F26004418'] }] };
    await api('POST', '/api/compras/albaranes-faltantes/comprobar', cuerpo);
    const primera = queries;
    assert.ok(primera >= 12);
    await api('POST', '/api/compras/albaranes-faltantes/comprobar', cuerpo);
    assert.equal(queries, primera);
    assert.equal(scans, 0);
  } finally {
    docClient.send = enviar;
  }
});
