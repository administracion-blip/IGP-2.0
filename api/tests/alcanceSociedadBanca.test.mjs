/**
 * [SEC S-08] Ataques por sociedad en Banca: un usuario restringido a la sociedad
 * Norte no borra, importa ni asigna cuentas de la sociedad Sur.
 *
 * Lecturas (movimientos y cargas): en 'observar' (por defecto) devuelven todo y
 * avisan; con ALCANCE_MODO_LECTURAS=bloquear filtran o dan 404.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import { S3Client } from '@aws-sdk/client-s3';

// Si una guarda fallase, el original no debe llegar al bucket real.
S3Client.prototype.send = async () => ({});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alcance';

const { montarEscenario, tables, local, empresa, EMPRESA_NORTE, EMPRESA_SUR } = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: bancaRouter } = await import('../routes/banca.js');

const ROL = 'Administracion';
const PERMISOS = ['banca.ver', 'banca.importar', 'empresas.editar'];
const NORTE = { sub: 'u-norte', email: 'norte@grupo.test', rol: ROL };

const IBAN_SUR = 'ES9121000418450200051332';
const IBAN_NORTE = 'ES1000492352082414205416';

let db;
let servidor = null;
let base = '';
const avisos = [];
const warnOriginal = console.warn;

function cuenta(iban, empresaId) {
  return { iban, cuentaRef: iban, empresaId, pendienteAsignar: !empresaId };
}

function movimiento(iban, empresaId, n, hashFichero) {
  return {
    PK: `ACCOUNT#${iban}`,
    SK: `TXN#2026-02-1${n}#h${n}`,
    fechaOperacion: `2026-02-1${n}`,
    estadoConciliacion: 'pendiente',
    hashFichero,
    ...(empresaId && { empresaId }),
  };
}

beforeEach(() => {
  delete process.env.ALCANCE_MODO_LECTURAS;
  avisos.length = 0;
  console.warn = (...args) => {
    if (args[0] === '[alcance] denegaría') avisos.push(args[1]);
    else warnOriginal(...args);
  };
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.bankAccounts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.bankFiles, { hashKey: 'hashFichero' });
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
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: NORTE.email, Local: ['Local Norte'], Rol: ROL });
  for (const p of PERMISOS) db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: `PERMISO#${p}` });
  db.sembrar(tables.bankAccounts, { PK: `ACCOUNT#${IBAN_SUR}`, SK: 'META', iban: IBAN_SUR, empresaId: EMPRESA_SUR });
  db.sembrar(tables.bankAccounts, { PK: `ACCOUNT#${IBAN_NORTE}`, SK: 'META', iban: IBAN_NORTE, empresaId: EMPRESA_NORTE });

  db.sembrar(tables.bankFiles, { hashFichero: 'F-SUR', estado: 'cargado', importadoEn: '2026-03-01', cuentas: [cuenta(IBAN_SUR, EMPRESA_SUR)] });
  db.sembrar(tables.bankFiles, { hashFichero: 'F-NORTE', estado: 'cargado', importadoEn: '2026-03-02', cuentas: [cuenta(IBAN_NORTE, EMPRESA_NORTE)] });
  db.sembrar(tables.bankFiles, {
    hashFichero: 'F-MIXTO',
    estado: 'cargado',
    importadoEn: '2026-03-03',
    s3Key: 'banca/extractos/F-MIXTO.n43',
    cuentas: [cuenta(IBAN_NORTE, EMPRESA_NORTE), cuenta(IBAN_SUR, EMPRESA_SUR)],
  });
  db.sembrar(tables.bankMovements, movimiento(IBAN_SUR, EMPRESA_SUR, 1, 'F-SUR'));
  db.sembrar(tables.bankMovements, movimiento(IBAN_NORTE, EMPRESA_NORTE, 2, 'F-NORTE'));
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  console.warn = warnOriginal;
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function api(metodo, ruta, { json, form } = {}) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = NORTE;
      next();
    });
    app.use('/api', bancaRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    ...(json !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) }),
    ...(form && { body: form }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// --- Escrituras -----------------------------------------------------------

test('DELETE de la carga de otra sociedad: 404 y la carga y sus movimientos siguen', async () => {
  const r = await api('DELETE', '/api/banca/ficheros/F-SUR');
  assert.equal(r.status, 404);
  assert.ok(db.obtener(tables.bankFiles, { hashFichero: 'F-SUR' }));
  assert.equal(db.listar(tables.bankMovements).filter((m) => m.hashFichero === 'F-SUR').length, 1);
});

test('DELETE de una carga con una cuenta propia y otra ajena: 403 sin borrar nada', async () => {
  const r = await api('DELETE', '/api/banca/ficheros/F-MIXTO');
  assert.equal(r.status, 403);
  assert.ok(db.obtener(tables.bankFiles, { hashFichero: 'F-MIXTO' }));
});

test('DELETE de la carga propia sigue funcionando', async () => {
  const r = await api('DELETE', '/api/banca/ficheros/F-NORTE');
  assert.equal(r.status, 200);
  assert.equal(r.body.movimientosBorrados, 1);
  assert.equal(db.obtener(tables.bankFiles, { hashFichero: 'F-NORTE' }), null);
});

test('asignar-cuenta a una sociedad ajena: 404 sin tocar maestro ni carga', async () => {
  db.sembrar(tables.bankFiles, {
    hashFichero: 'F-PEND',
    estado: 'pendiente_cuenta',
    cuentas: [cuenta('ES7921000813610123456789', '')],
  });
  db.sembrar(tables.empresas, empresa(EMPRESA_SUR, 'Sur'));
  const r = await api('POST', '/api/banca/ficheros/F-PEND/asignar-cuenta', {
    json: { empresaId: EMPRESA_SUR, iban: 'ES7921000813610123456789', predeterminada: false },
  });
  assert.equal(r.status, 404);
  assert.equal(db.obtener(tables.bankFiles, { hashFichero: 'F-PEND' }).cuentas[0].pendienteAsignar, true);
  assert.equal(db.obtener(tables.bankAccounts, { PK: 'ACCOUNT#ES7921000813610123456789', SK: 'META' }), null);
});

/** Norma 43 mínimo de la cuenta de Sur (CCC 2100 0418 45 0200051332). */
function n43Sur() {
  const reg = (...tramos) => {
    const buf = Array(80).fill(' ');
    for (const [desde, hasta, valor] of tramos) {
      const v = String(valor).slice(0, hasta - desde + 1).padEnd(hasta - desde + 1, ' ');
      for (let i = 0; i < v.length; i += 1) buf[desde - 1 + i] = v[i];
    }
    return buf.join('');
  };
  const num = (v, n) => String(v).padStart(n, '0');
  const lineas = [
    reg([1, 2, '11'], [3, 6, '2100'], [7, 10, '0418'], [11, 20, '0200051332'], [21, 26, '260201'],
      [27, 32, '260228'], [33, 33, '2'], [34, 47, num(100000, 14)], [48, 50, '978'], [51, 51, '3'],
      [52, 77, 'HOSTELERIA DEL SUR SL']),
    reg([1, 2, '22'], [3, 6, '2100'], [7, 10, '0418'], [11, 16, '260210'], [17, 22, '260210'],
      [23, 24, '03'], [25, 27, '001'], [28, 28, '1'], [29, 42, num(10000, 14)],
      [43, 52, '0000000001'], [53, 64, 'RECIBO LUZ']),
    reg([1, 2, '33'], [3, 6, '2100'], [7, 10, '0418'], [11, 20, '0200051332'], [21, 25, num(1, 5)],
      [26, 39, num(10000, 14)], [40, 44, num(0, 5)], [45, 58, num(0, 14)], [59, 59, '2'],
      [60, 73, num(90000, 14)], [74, 76, '978']),
  ];
  lineas.push(reg([1, 2, '88'], [3, 20, '9'.repeat(18)], [21, 26, num(lineas.length + 1, 6)]));
  return Buffer.from(lineas.join('\r\n'), 'latin1');
}

test('importar un extracto de una cuenta de otra sociedad: 403 sin escribir nada', async () => {
  const antes = db.listar(tables.bankMovements).length;
  const form = new FormData();
  form.append('file', new Blob([n43Sur()]), 'extracto.n43');
  const r = await api('POST', '/api/banca/importar', { form });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(db.listar(tables.bankMovements).length, antes);
  assert.equal(db.listar(tables.bankFiles).length, 3);
});

// --- Lecturas -------------------------------------------------------------

test('modo observar: cargas, detalle y movimientos ajenos se sirven y avisan', async () => {
  const lista = await api('GET', '/api/banca/ficheros');
  assert.deepEqual(lista.body.ficheros.map((f) => f.hashFichero).sort(), ['F-MIXTO', 'F-NORTE', 'F-SUR']);
  assert.equal(lista.body.ficheros.find((f) => f.hashFichero === 'F-MIXTO').cuentas.length, 2);
  assert.deepEqual(avisos, [{ ruta: '/api/banca/ficheros', usuario: 'u-norte', empresa: EMPRESA_SUR }]);

  avisos.length = 0;
  const detalle = await api('GET', '/api/banca/ficheros/F-SUR');
  assert.equal(detalle.status, 200);
  assert.equal(avisos.length, 1);

  avisos.length = 0;
  const porEmpresa = await api('GET', `/api/banca/movimientos?empresaId=${EMPRESA_SUR}`);
  assert.equal(porEmpresa.body.movimientos.length, 1);
  const porEstado = await api('GET', '/api/banca/movimientos?estado=pendiente');
  assert.equal(porEstado.body.movimientos.length, 2);
  assert.equal(avisos.length, 2);
  assert.ok(avisos.every((a) => a.empresa === EMPRESA_SUR && a.usuario === 'u-norte'));
});

test('modo bloquear: cargas y movimientos ajenos se filtran y el detalle da 404', async () => {
  process.env.ALCANCE_MODO_LECTURAS = 'bloquear';

  const lista = await api('GET', '/api/banca/ficheros');
  assert.deepEqual(lista.body.ficheros.map((f) => f.hashFichero).sort(), ['F-MIXTO', 'F-NORTE']);
  const mixto = lista.body.ficheros.find((f) => f.hashFichero === 'F-MIXTO');
  assert.deepEqual(mixto.cuentas.map((c) => c.empresaId), [EMPRESA_NORTE]);

  assert.equal((await api('GET', '/api/banca/ficheros/F-SUR')).status, 404);
  const detalleMixto = await api('GET', '/api/banca/ficheros/F-MIXTO');
  assert.equal(detalleMixto.status, 200);
  assert.equal(detalleMixto.body.fichero.cuentas.length, 1);
  assert.equal(detalleMixto.body.urlOriginal, '', 'el original trae la cuenta ajena');

  assert.deepEqual((await api('GET', `/api/banca/movimientos?empresaId=${EMPRESA_SUR}`)).body.movimientos, []);
  assert.deepEqual((await api('GET', `/api/banca/movimientos?iban=${IBAN_SUR}`)).body.movimientos, []);
  const propios = await api('GET', `/api/banca/movimientos?iban=${IBAN_NORTE}`);
  assert.equal(propios.body.movimientos.length, 1);
  const porEstado = await api('GET', '/api/banca/movimientos?estado=pendiente');
  assert.deepEqual(porEstado.body.movimientos.map((m) => m.empresaId), [EMPRESA_NORTE]);
  assert.equal(avisos.length, 0);
});
