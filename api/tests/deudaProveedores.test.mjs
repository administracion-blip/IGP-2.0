/**
 * Deuda con proveedores por HTTP: lecturas por índice (sin Scan), exclusiones,
 * deuda anterior al rango, intragrupo y alcance por sociedad.
 */

import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createRequire } from 'node:module';

const Tesseract = createRequire(import.meta.url)('tesseract.js');
Tesseract.createWorker = async () => ({
  recognize: async () => ({ data: { text: '' } }),
  terminate: async () => {},
});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-la-deuda-de-proveedores';

const { montarEscenario, tables, local, EMPRESA_NORTE, EMPRESA_SUR } = await import('./escenarioFacturacion.mjs');
const { docClient } = await import('../lib/db.js');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { aplicarClavesFactura, aplicarClavesRemesa } = await import('../lib/facturacion/clavesIndice.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const CIF_NORTE = 'B000002000';
const CIF_SUR = 'B000003000';
const USUARIOS = {
  admin: { sub: 'u-admin', email: 'admin@grupo.test', rol: 'Administrador' },
  norte: { sub: 'u-norte', email: 'norte@grupo.test', rol: 'Administracion' },
  sin: { sub: 'u-sin', email: 'sin@grupo.test', rol: 'Camarero' },
};

let db;
let servidor = null;
let base = '';
let comandos = [];

const EMISORES = {
  [EMPRESA_NORTE]: { emisor_cif: CIF_NORTE, emisor_nombre: 'Norte SL' },
  [EMPRESA_SUR]: { emisor_cif: CIF_SUR, emisor_nombre: 'Sur SL' },
};

function factura(id, emisor, extra = {}) {
  const total = extra.total_factura ?? 100;
  const cobrado = extra.total_cobrado ?? 0;
  return aplicarClavesFactura({
    id_factura: id,
    tipo: 'IN',
    estado: 'pendiente_pago',
    emisor_id: emisor,
    ...EMISORES[emisor],
    empresa_cif: 'B11111111',
    empresa_nombre: 'Proveedor Uno',
    fecha_emision: '2026-03-10',
    total_factura: total,
    total_cobrado: cobrado,
    saldo_pendiente: total - cobrado,
    ...extra,
  });
}

beforeEach(() => {
  db = montarEscenario({ paginaTam: 2 });
  db.crearTabla(tables.remesas, {
    hashKey: 'remesaId',
    indices: {
      'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' },
      'Activa-index': { hashKey: 'gsi_activa', rangeKey: 'gsi_fecha' },
    },
  });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.locales, local('000020', 'Local Sur', EMPRESA_SUR));
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: USUARIOS.norte.email, Local: ['Local Norte'], Rol: 'Administracion' });
  db.sembrar(tables.usuarios, { id_usuario: 'u-sin', Email: USUARIOS.sin.email, Local: ['Local Norte'], Rol: 'Camarero' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Administracion', SK: 'PERMISO#facturacion.ver' });
  invalidarContextoAcceso();
  invalidarMaestroLocales();

  // Proveedor Uno (Norte)
  db.sembrar(tables.facturas, factura('F1', EMPRESA_NORTE, { fecha_vencimiento: '2020-01-01' }));
  db.sembrar(tables.facturas, factura('F2', EMPRESA_NORTE, {
    estado: 'pagada', fecha_emision: '2026-02-01', total_factura: 50, total_cobrado: 50,
  }));
  db.sembrar(tables.facturas, factura('F3', EMPRESA_NORTE, { estado: 'anulada', total_factura: 999 }));
  db.sembrar(tables.facturas, factura('F4', EMPRESA_NORTE, { estado: 'borrador', total_factura: 999 }));
  db.sembrar(tables.facturas, factura('FANT', EMPRESA_NORTE, {
    fecha_emision: '2025-11-01', total_factura: 300, fecha_vencimiento: '2099-12-31',
  }));
  db.sembrar(tables.facturas, factura('FANT-PAG', EMPRESA_NORTE, {
    estado: 'pagada', fecha_emision: '2025-10-01', total_factura: 40, total_cobrado: 40,
  }));
  db.sembrar(tables.facturas, factura('FUERA', EMPRESA_NORTE, { fecha_emision: '2026-08-01', total_factura: 77 }));
  db.sembrar(tables.facturas, factura('OUT1', EMPRESA_NORTE, {
    tipo: 'OUT', estado: 'vencida', fecha_emision: '2025-12-01', total_factura: 500,
  }));
  db.sembrar(tables.facturas, factura('OUT2', EMPRESA_NORTE, {
    tipo: 'OUT', estado: 'emitida', fecha_emision: '2026-03-01', total_factura: 700,
  }));
  // Proveedor Dos (Sur)
  db.sembrar(tables.facturas, factura('F5', EMPRESA_SUR, {
    empresa_cif: 'B22222222', empresa_nombre: 'Proveedor Dos', fecha_emision: '2026-04-01',
    total_factura: 1000, fecha_vencimiento: '2099-12-31',
  }));
  // Intragrupo: Norte recibe de Sur (le debemos 200) y Sur recibe de Norte (nos debe 80).
  db.sembrar(tables.facturas, factura('G1', EMPRESA_NORTE, {
    empresa_cif: CIF_SUR, empresa_id: EMPRESA_SUR, empresa_nombre: 'Sur SL', fecha_emision: '2026-05-01', total_factura: 200,
  }));
  db.sembrar(tables.facturas, factura('G2', EMPRESA_SUR, {
    empresa_cif: CIF_NORTE, empresa_id: EMPRESA_NORTE, empresa_nombre: 'Norte SL', fecha_emision: '2026-05-02', total_factura: 80,
  }));

  db.sembrar(tables.remesas, aplicarClavesRemesa({
    remesaId: 'R1', nombre: 'Remesa junio', estado: 'Borrador', creadoEn: '2026-06-01T10:00:00.000Z',
    lineas: [{ id_factura: 'F1' }],
  }));

  comandos = [];
  const enviar = docClient.send;
  docClient.send = (cmd) => {
    comandos.push({ tipo: cmd?.constructor?.name, tabla: cmd?.input?.TableName, indice: cmd?.input?.IndexName });
    return enviar(cmd);
  };
});

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function api(ruta, quien = 'admin') {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = USUARIOS[req.headers['x-test-user'] || 'admin'];
      next();
    });
    app.use('/api', facturacionRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, { headers: { 'x-test-user': quien } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const RANGO = 'fechaDesde=2026-01-01&fechaHasta=2026-06-30';
const sinScanEnFacturacion = () => comandos.filter(
  (c) => c.tipo === 'ScanCommand' && (c.tabla === tables.facturas || c.tabla === tables.remesas),
);

test('resumen: rango por Tipo-Fecha, exclusiones, deuda anterior, orden, kpis y antigüedad', async () => {
  const r = await api(`/api/facturacion/deuda-proveedores?${RANGO}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rango, { desde: '2026-01-01', hasta: '2026-06-30' });
  assert.equal(r.body.tolerancia, 10);
  assert.deepEqual(r.body.facturas, []);
  assert.deepEqual(r.body.sociedades.map((s) => s.id), [EMPRESA_NORTE, EMPRESA_SUR]);

  assert.deepEqual(r.body.proveedores.map((p) => p.clave), ['CIF:B22222222', 'CIF:B11111111', `CIF:${CIF_SUR}`, `CIF:${CIF_NORTE}`]);
  const uno = r.body.proveedores[1];
  assert.equal(uno.facturado, 150);
  assert.equal(uno.pagado, 50);
  assert.equal(uno.pendiente, 100);
  assert.equal(uno.vencido, 100);
  assert.equal(uno.numFacturas, 2);
  assert.equal(uno.numVencidas, 1);
  assert.deepEqual(uno.anterior, { pendiente: 300, vencido: 0, numFacturas: 1 });
  assert.equal(uno.estado, 'vencido');
  assert.equal(uno.intragrupo, null);
  assert.equal(uno.vencimientoMasAntiguo, '2020-01-01');

  assert.deepEqual(r.body.kpis, {
    facturado: 1430, pagado: 50, pendiente: 1380, vencido: 100,
    numFacturas: 5, numProveedores: 4, pendienteAnterior: 300, vencidoAnterior: 0,
  });
  assert.deepEqual(r.body.antiguedad, {
    noVencido: 1580, d0_30: 0, d31_60: 0, d61_90: 0, d90mas: 100, numSinVencimiento: 2,
  });

  const indices = new Set(comandos.filter((c) => c.tabla === tables.facturas).map((c) => c.indice));
  assert.deepEqual([...indices].sort(), ['Estado-Fecha-index', 'Tipo-Fecha-index']);
  assert.equal(comandos.filter((c) => c.tipo === 'ScanCommand').length, 0);
});

test('incluirFacturas=1 devuelve las facturas con remesa activa y marca de anterior', async () => {
  const r = await api(`/api/facturacion/deuda-proveedores?${RANGO}&incluirFacturas=1&proveedor=uno`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.proveedores.map((p) => p.clave), ['CIF:B11111111']);
  assert.equal(r.body.kpis.numProveedores, 1);
  const ids = r.body.facturas.map((f) => f.id_factura).sort();
  assert.deepEqual(ids, ['F1', 'F2', 'FANT']);
  const f1 = r.body.facturas.find((f) => f.id_factura === 'F1');
  assert.deepEqual(f1.remesaActiva, { remesaId: 'R1', nombre: 'Remesa junio', estado: 'Borrador' });
  assert.equal(f1.vencida, true);
  assert.equal(f1.tramo, 'd90mas');
  assert.equal(r.body.facturas.find((f) => f.id_factura === 'FANT').anteriorAlPeriodo, true);
});

test('fechas inválidas, incompletas o rango de más de 3 años → 400 sin leer', async () => {
  for (const q of [
    'fechaDesde=2026-06-01&fechaHasta=2026-01-01',
    'fechaDesde=2026-02-30&fechaHasta=2026-03-01',
    'fechaDesde=2026-01-01',
    'fechaDesde=2020-01-01&fechaHasta=2026-01-01',
  ]) {
    const r = await api(`/api/facturacion/deuda-proveedores?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(typeof r.body.error, 'string');
  }
  const largo = await api('/api/facturacion/deuda-proveedores?fechaDesde=2020-01-01&fechaHasta=2026-01-01');
  assert.match(largo.body.error, /3 años/);
  assert.equal(comandos.filter((c) => c.tabla === tables.facturas).length, 0);
});

test('detalle por CIF: sin OUT del mismo CIF, orden y remesa activa', async () => {
  const r = await api(`/api/facturacion/deuda-proveedores/facturas?clave=CIF:B11111111&${RANGO}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.facturas.map((f) => f.id_factura), ['F1', 'FANT', 'F2']);
  assert.equal(r.body.facturas[0].remesaActiva.remesaId, 'R1');
  assert.equal(r.body.proveedor.pendiente, 100);
  assert.equal(r.body.proveedor.anterior.pendiente, 300);
  assert.equal(r.body.intragrupo, null);
  const indices = new Set(comandos.filter((c) => c.tabla === tables.facturas).map((c) => c.indice));
  assert.deepEqual([...indices].sort(), ['Estado-Fecha-index', 'Tipo-Fecha-index'], 'mismas lecturas que el resumen');
  assert.equal(comandos.filter((c) => c.tipo === 'ScanCommand').length, 0);
});

test('detalle y tarjeta del resumen dan el mismo intragrupo aunque la contraparte no compre al proveedor', async () => {
  const [A, B, D] = ['000031', '000032', '000033'];
  const soc = {
    [A]: { emisor_cif: 'B000031000', emisor_nombre: 'A SL' },
    [B]: { emisor_cif: 'B000032000', emisor_nombre: 'B SL' },
    [D]: { emisor_cif: 'B000033000', emisor_nombre: 'D SL' },
  };
  const contraparte = (id) => ({ empresa_id: id, empresa_cif: soc[id].emisor_cif, empresa_nombre: soc[id].emisor_nombre });
  db.sembrar(tables.facturas, factura('AB1', A, { ...soc[A], ...contraparte(B), total_factura: 100 }));
  db.sembrar(tables.facturas, factura('BD1', B, { ...soc[B], ...contraparte(D), total_factura: 50 }));
  db.sembrar(tables.facturas, factura('DX1', D, {
    ...soc[D], empresa_cif: 'B33333333', empresa_nombre: 'Proveedor Tres', total_factura: 20,
  }));
  const claveB = `CIF:${soc[B].emisor_cif}`;

  const r = await api(`/api/facturacion/deuda-proveedores?${RANGO}`);
  const tarjeta = r.body.proveedores.find((p) => p.clave === claveB);
  assert.deepEqual(tarjeta.intragrupo, { sociedadId: B, leDebemos: 100, nosDebe: 50, neto: -50, nosDebeParcial: false });

  const d = await api(`/api/facturacion/deuda-proveedores/facturas?clave=${claveB}&${RANGO}`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.deepEqual(d.body.proveedor, tarjeta);
  assert.deepEqual(d.body.facturas.map((f) => f.id_factura), ['AB1']);
  assert.deepEqual(d.body.intragrupo.leDebemos.map((f) => f.id_factura), ['AB1']);
  assert.deepEqual(d.body.intragrupo.nosDebe.map((f) => f.id_factura), ['BD1']);
  assert.deepEqual(sinScanEnFacturacion(), []);
});

test('detalle sin clave → 400', async () => {
  const r = await api(`/api/facturacion/deuda-proveedores/facturas?${RANGO}`);
  assert.equal(r.status, 400);
});

test('intragrupo A↔B sin filtro de sociedad', async () => {
  const r = await api(`/api/facturacion/deuda-proveedores?${RANGO}`);
  const sur = r.body.proveedores.find((p) => p.clave === `CIF:${CIF_SUR}`);
  assert.deepEqual(sur.intragrupo, { sociedadId: EMPRESA_SUR, leDebemos: 200, nosDebe: 80, neto: -120, nosDebeParcial: false });
  const norte = r.body.proveedores.find((p) => p.clave === `CIF:${CIF_NORTE}`);
  assert.deepEqual(norte.intragrupo, { sociedadId: EMPRESA_NORTE, leDebemos: 80, nosDebe: 200, neto: 120, nosDebeParcial: false });

  const d = await api(`/api/facturacion/deuda-proveedores/facturas?clave=CIF:${CIF_SUR}&${RANGO}`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.deepEqual(d.body.facturas.map((f) => f.id_factura), ['G1']);
  assert.deepEqual(d.body.intragrupo.leDebemos.map((f) => f.id_factura), ['G1']);
  assert.deepEqual(d.body.intragrupo.nosDebe.map((f) => f.id_factura), ['G2']);
  assert.deepEqual(d.body.proveedor.intragrupo, sur.intragrupo);
});

test('intragrupo con emisorId: solo la sociedad elegida', async () => {
  const r = await api(`/api/facturacion/deuda-proveedores?${RANGO}&emisorId=2`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.proveedores.map((p) => p.clave), ['CIF:B11111111', `CIF:${CIF_SUR}`]);
  assert.equal(r.body.sociedades.length, 2, 'las sociedades se calculan antes de filtrar por emisor');
  const sur = r.body.proveedores.find((p) => p.clave === `CIF:${CIF_SUR}`);
  assert.deepEqual(sur.intragrupo, { sociedadId: EMPRESA_SUR, leDebemos: 200, nosDebe: 80, neto: -120, nosDebeParcial: false });

  const conSur = await api(`/api/facturacion/deuda-proveedores?${RANGO}&emisorId=${EMPRESA_SUR}`);
  const norte = conSur.body.proveedores.find((p) => p.clave === `CIF:${CIF_NORTE}`);
  assert.deepEqual(norte.intragrupo, { sociedadId: EMPRESA_NORTE, leDebemos: 80, nosDebe: 200, neto: 120, nosDebeParcial: false });
});

test('alcance: un usuario de Norte no ve importes de Sur y el nos debe queda parcial', async () => {
  const r = await api(`/api/facturacion/deuda-proveedores?${RANGO}`, 'norte');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.sociedades.map((s) => s.id), [EMPRESA_NORTE]);
  assert.deepEqual(r.body.proveedores.map((p) => p.clave), ['CIF:B11111111', `CIF:${CIF_SUR}`]);
  assert.equal(r.body.kpis.facturado, 350);
  const sur = r.body.proveedores.find((p) => p.clave === `CIF:${CIF_SUR}`);
  assert.deepEqual(sur.intragrupo, { sociedadId: EMPRESA_SUR, leDebemos: 200, nosDebe: 0, neto: -200, nosDebeParcial: true });

  const ajeno = await api(`/api/facturacion/deuda-proveedores/facturas?clave=CIF:B22222222&${RANGO}`, 'norte');
  assert.equal(ajeno.status, 200);
  assert.deepEqual(ajeno.body.facturas, []);
  assert.equal(ajeno.body.proveedor.pendiente, 0);
  assert.equal(ajeno.body.proveedor.facturado, 0);

  const d = await api(`/api/facturacion/deuda-proveedores/facturas?clave=CIF:${CIF_SUR}&${RANGO}`, 'norte');
  assert.deepEqual(d.body.facturas.map((f) => f.id_factura), ['G1']);
  assert.deepEqual(d.body.intragrupo.nosDebe, []);
  assert.equal(d.body.proveedor.intragrupo.nosDebeParcial, true);

  assert.deepEqual(sinScanEnFacturacion(), []);
});

test('sin facturacion.ver → 403 en ambos endpoints', async () => {
  const r = await api(`/api/facturacion/deuda-proveedores?${RANGO}`, 'sin');
  assert.equal(r.status, 403);
  const d = await api(`/api/facturacion/deuda-proveedores/facturas?clave=CIF:B11111111&${RANGO}`, 'sin');
  assert.equal(d.status, 403);
});
