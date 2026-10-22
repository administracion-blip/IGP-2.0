/**
 * Alta de factura (`POST /facturacion/facturas`): nunca queda una cabecera sin
 * todas sus líneas.
 *
 * - Hasta 100 operaciones (cabecera + líneas): una sola TransactWrite. Si falla,
 *   no se escribe nada.
 * - Más de 100: primero las líneas en lote y, solo si se escriben todas, la
 *   cabecera. Si no, no hay cabecera (las líneas sueltas no se ven: solo se leen
 *   por id_factura).
 *
 * Una cabecera huérfana sería una venta emitible con un total que no cuadra o,
 * en gastos, una factura que hace que el reintento tome el número siguiente y
 * duplique la deuda. En ningún fallo se responde 200 ni se audita la creación.
 */

import test, { after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import { createRequire } from 'node:module';

const Tesseract = createRequire(import.meta.url)('tesseract.js');
Tesseract.createWorker = async () => ({
  recognize: async () => ({ data: { text: '' } }),
  terminate: async () => {},
});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alta-de-factura';

const { montarEscenario, tables, serie } = await import('./escenarioFacturacion.mjs');
const { docClient } = await import('../lib/db.js');
const { logger } = await import('../lib/logger.js');
const { fijarEsperaReintentos } = await import('../lib/dynamo/lotes.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };
const MENSAJE_LINEAS = 'No se han podido guardar todas las líneas de la factura';
const MENSAJE_FACTURA = 'No se ha podido guardar la factura';

let db;
let servidor = null;
let base = '';
let restaurarEspera;
let enviarOriginal;

beforeEach(() => {
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.sembrar(tables.usuarios, { id_usuario: '000001', Email: ADMIN.email, Rol: 'Administrador' });
  db.sembrar(tables.facturasSeries, serie('FMI'));
  db.sembrar(tables.facturasSeries, serie('FG', { tipo: 'IN' }));
  enviarOriginal = docClient.send;
  restaurarEspera = fijarEsperaReintentos(async () => {});
});

afterEach(() => {
  docClient.send = enviarOriginal;
  restaurarEspera();
});

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function api(metodo, ruta, cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = ADMIN;
      next();
    });
    app.use('/api', facturacionRouter);
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

function cuerpoFactura(numLineas, extra = {}) {
  return {
    tipo: 'OUT',
    serie: 'FMI',
    emisor_id: '000001',
    emisor_nombre: 'Central',
    emisor_cif: 'A11111111',
    empresa_nombre: 'Cliente',
    empresa_cif: 'B22222222',
    fecha_emision: new Date().toISOString().slice(0, 10),
    lineas: Array.from({ length: numLineas }, (_, i) => ({
      descripcion: `Línea ${i + 1}`,
      cantidad: 1,
      precio_unitario: 10,
      tipo_iva: 21,
    })),
    ...extra,
  };
}

const crear = (numLineas, extra) => api('POST', '/api/facturacion/facturas', cuerpoFactura(numLineas, extra));

/** Throttling que no cesa sobre las últimas `n` líneas de cada lote. */
function lineasQueNoSeEscriben(n) {
  const enviar = docClient.send;
  docClient.send = async (cmd) => {
    const pet = cmd?.constructor?.name === 'BatchWriteCommand' && cmd.input.RequestItems[tables.facturasLineas];
    if (!pet) return enviar(cmd);
    const corte = Math.max(0, pet.length - n);
    if (corte > 0) {
      await enviar({ constructor: cmd.constructor, input: { RequestItems: { [tables.facturasLineas]: pet.slice(0, corte) } } });
    }
    return { UnprocessedItems: { [tables.facturasLineas]: pet.slice(corte) } };
  };
}

function falloTransaccion() {
  db.interceptar('TransactWriteCommand', undefined, async () => {
    throw Object.assign(new Error('Throughput exceeded'), { name: 'ProvisionedThroughputExceededException' });
  });
}

async function conLogErrores(fn) {
  const registros = [];
  const original = logger.error;
  logger.error = (...args) => {
    registros.push(args);
  };
  try {
    return { r: await fn(), registros };
  } finally {
    logger.error = original;
  }
}

const tipos = (tipo) => db.operaciones.filter((o) => o.tipo === tipo);
const auditorias = () => db.listar(tables.facturasAuditoria);

// ─── Hasta 100 operaciones: una transacción ───

test('alta con 30 líneas: una sola TransactWrite con cabecera y líneas, 200 y auditoría', async () => {
  const r = await crear(30);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ['factura', 'lineas', 'ok']);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.lineas.length, 30);
  const id = r.body.factura.id_factura;
  assert.equal(tipos('TransactWriteCommand').length, 1);
  assert.equal(tipos('BatchWriteCommand').length, 0);
  assert.ok(db.obtener(tables.facturas, { id_factura: id }));
  assert.equal(db.listar(tables.facturasLineas).filter((l) => l.id_factura === id).length, 30);
  assert.equal(auditorias().filter((a) => a.id_factura === id && a.accion === 'creacion').length, 1);
});

test('99 líneas (100 operaciones) siguen yendo en una sola transacción', async () => {
  const r = await crear(99);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(tipos('TransactWriteCommand').length, 1);
  assert.equal(tipos('BatchWriteCommand').length, 0);
  assert.equal(db.listar(tables.facturasLineas).length, 99);
});

test('si la transacción falla: 500, ni cabecera ni líneas, log con la factura y sin auditoría', async () => {
  falloTransaccion();
  const { r, registros } = await conLogErrores(() => crear(30));
  assert.equal(r.status, 500);
  assert.equal(r.body.error, MENSAJE_FACTURA);
  assert.equal(r.body.ok, undefined);
  assert.equal(db.listar(tables.facturas).length, 0);
  assert.equal(db.listar(tables.facturasLineas).length, 0);
  assert.equal(auditorias().length, 0);
  const registro = registros.find(([, msg]) => /no se ha podido guardar la factura/.test(String(msg)));
  assert.ok(registro, 'se registra el fallo');
  assert.ok(registro[0].id_factura);
});

// ─── Más de 100: líneas en lote y cabecera al final ───

test('alta con 120 líneas: lotes de líneas y la cabecera después, 200 y auditoría', async () => {
  const r = await crear(120);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(tipos('BatchWriteCommand').map((o) => o.peticiones), [25, 25, 25, 25, 20]);
  assert.equal(tipos('TransactWriteCommand').length, 0);
  const ultimoLote = db.operaciones.findLastIndex((o) => o.tipo === 'BatchWriteCommand');
  const cabecera = db.operaciones.findIndex((o) => o.tipo === 'PutCommand' && o.tabla === tables.facturas);
  assert.ok(cabecera > ultimoLote, 'la cabecera se escribe después de todas las líneas');
  assert.equal(db.listar(tables.facturasLineas).length, 120);
  assert.equal(auditorias().length, 1);
});

test('más de 100 líneas con líneas sin escribir: 500, sin cabecera, log con las pendientes y sin auditoría', async () => {
  lineasQueNoSeEscriben(3);
  const { r, registros } = await conLogErrores(() => crear(120));
  assert.equal(r.status, 500);
  assert.equal(r.body.error, MENSAJE_LINEAS);
  assert.equal(db.listar(tables.facturas).length, 0, 'no queda cabecera huérfana');
  assert.equal(auditorias().length, 0);
  const registro = registros.find(([, msg]) => /no se han podido guardar todas las líneas/.test(String(msg)));
  assert.ok(registro, 'se registra el fallo de las líneas');
  assert.ok(registro[0].id_factura);
  // Las 3 últimas del primer lote nunca se escriben y los lotes siguientes ni se intentan.
  const esperadas = Array.from({ length: 98 }, (_, i) => `L${String(23 + i).padStart(3, '0')}`);
  assert.deepEqual(registro[0].lineasPendientes, esperadas);
  assert.equal(db.listar(tables.facturasLineas).length, 22);
});

test('más de 100 líneas y falla la cabecera: 500, sin cabecera ni auditoría', async () => {
  db.interceptar('PutCommand', tables.facturas, async () => {
    throw Object.assign(new Error('Fallo de red simulado'), { name: 'NetworkingError' });
  });
  const { r, registros } = await conLogErrores(() => crear(120));
  assert.equal(r.status, 500);
  assert.equal(r.body.error, MENSAJE_FACTURA);
  assert.equal(db.listar(tables.facturas).length, 0);
  assert.equal(auditorias().length, 0);
  assert.ok(registros.some(([ctx, msg]) => ctx?.id_factura && /no la cabecera/.test(String(msg))));
});

// ─── Gasto: el reintento conserva el número ───

test('gasto (IN): si el primer intento falla, el reintento obtiene el mismo número', async () => {
  falloTransaccion();
  const gasto = { tipo: 'IN', serie: 'FG' };
  const fallido = await conLogErrores(() => crear(3, gasto));
  assert.equal(fallido.r.status, 500);
  assert.equal(db.listar(tables.facturas).length, 0);

  const reintento = await crear(3, gasto);
  assert.equal(reintento.status, 200, JSON.stringify(reintento.body));
  assert.equal(reintento.body.factura.numero, 1, 'no salta al N+1 por una cabecera huérfana');

  const siguiente = await crear(3, gasto);
  assert.equal(siguiente.body.factura.numero, 2, 'la numeración avanza solo con facturas guardadas');
  assert.equal(db.listar(tables.facturas).length, 2);
});
