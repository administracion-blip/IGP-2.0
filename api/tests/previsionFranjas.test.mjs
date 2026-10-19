/**
 * Previsión de ventas por franjas: horas de cada franja, fecha comparativa,
 * personal sugerido, alcance por local, persistencia en Igp_VentasHora y escenarios.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-prevision';
process.env.ALCANCE_MODO_LECTURAS = 'bloquear';
delete process.env.AGORA_BASE_URL;
process.env.AGORA_API_BASE_URL = 'http://agora.falso';
process.env.AGORA_API_TOKEN = 'token-de-prueba';

// Ágora falso: facturas por `${workplace}|${business-day}`.
const FACTURAS = {
  '101|2024-10-02': [
    { Date: '2024-10-02T18:30:00', Totals: { GrossAmount: 100 } },
    { Date: '2024-10-02T22:10:00', Totals: { GrossAmount: 50 } },
    { Date: '2024-10-03T01:00:00', Totals: { GrossAmount: 30 } },
    { Date: '2024-10-02T12:00:00', Totals: { GrossAmount: 20 } },
    { Date: '2024-10-02T19:00:00', Totals: { GrossAmount: -5 } },
    { Totals: { GrossAmount: 99 } },
  ],
  '101|2025-10-02': [{ Date: '2025-10-02 18:00:00', Totals: { GrossAmount: 120 } }],
  '202|2024-10-02': [{ Date: '2024-10-02T19:00:00', Totals: { GrossAmount: 500 } }],
};
const llamadasAgora = [];
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, opciones) => {
  const u = new URL(String(url));
  if (u.origin !== 'http://agora.falso') return fetchReal(url, opciones);
  const clave = `${u.searchParams.get('workplaces')}|${u.searchParams.get('business-day')}`;
  llamadasAgora.push(clave);
  return new Response(JSON.stringify({ Invoices: FACTURAS[clave] || [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const franjasLib = await import('../lib/prevision/franjas.js');
const { fechaComparacion } = await import('../lib/agora/objetivoMensual.js');
const store = await import('../lib/agora/ventasHoraStore.js');
const { default: previsionRouter } = await import('../routes/prevision.js');

const {
  horasDeFranja,
  personalSugerido,
  resolverFechaComparativa,
  calcularDia,
  prepararFranjas,
  fechaAnioAnterior,
} = franjasLib;

// ─── Puro ───

test('18:01–21:00 incluye la hora 18 (inicio redondeado a la hora, fin exclusivo)', () => {
  assert.deepEqual(horasDeFranja({ desde: '18:01', hasta: '21:00' }), [18, 19, 20]);
  assert.deepEqual(horasDeFranja({ desde: '18:00', hasta: '21:30' }), [18, 19, 20, 21]);
});

test('21:01–00:00 cruza la medianoche: 21, 22, 23', () => {
  assert.deepEqual(horasDeFranja({ desde: '21:01', hasta: '00:00' }), [21, 22, 23]);
  assert.deepEqual(horasDeFranja({ desde: '22:00', hasta: '02:00' }), [22, 23, 0, 1]);
});

test('00:01–09:00 incluye 0..8', () => {
  assert.deepEqual(horasDeFranja({ desde: '00:01', hasta: '09:00' }), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(horasDeFranja({ desde: '25:00', hasta: '09:00' }), []);
});

test('franjas encadenadas a media hora no duplican la hora intermedia', () => {
  assert.deepEqual(horasDeFranja({ desde: '13:00', hasta: '16:30' }), [13, 14, 15, 16]);
  assert.deepEqual(horasDeFranja({ desde: '16:31', hasta: '20:00' }), [17, 18, 19]);
  assert.deepEqual(horasDeFranja({ desde: '16:30', hasta: '20:00' }), [17, 18, 19]);
});

test('personal sugerido = ceil(importe / (objetivo × horas)); 0 sin importe', () => {
  assert.equal(personalSugerido(100, 40, 3), 1);
  assert.equal(personalSugerido(121, 40, 3), 2);
  assert.equal(personalSugerido(0, 40, 3), 0);
  assert.equal(personalSugerido(100, 0, 3), 0);
});

test('fecha comparativa: festivo ISO válido; si no, el mismo día del año anterior', () => {
  assert.deepEqual(
    resolverFechaComparativa('2025-12-24', { FechaComparativa: '2024-12-20', Festivo: true, NombreFestivo: 'Nochebuena' }),
    { fechaComparativa: '2024-12-20', origenComparativa: 'festivo', festivo: { nombre: 'Nochebuena' } },
  );
  const sinFestivo = resolverFechaComparativa('2025-10-02', { FechaComparativa: 'no-es-fecha', Festivo: false });
  assert.equal(sinFestivo.fechaComparativa, '2024-10-02');
  assert.equal(sinFestivo.origenComparativa, 'anio_anterior');
  assert.equal(sinFestivo.festivo, null);
  for (const f of ['2025-10-02', '2024-02-29', '2026-01-01', '2026-03-29']) {
    assert.equal(fechaAnioAnterior(f), fechaComparacion(f), f);
  }
});

test('comparativa >= fecha → día no válido (comparativa_no_anterior)', () => {
  const franjas = prepararFranjas([{ desde: '18:00', hasta: '21:00' }]);
  const dia = calcularDia({
    fecha: '2025-10-03',
    hoyJornada: '2026-10-14',
    franjas,
    objetivo: 40,
    comparativa: { fechaComparativa: '2025-10-03', origenComparativa: 'festivo', festivo: null },
    datoComparativa: { porHora: { 18: 100 }, totalDia: 100, nFacturas: 1 },
    datoReal: undefined,
  });
  assert.equal(dia.valida, false);
  assert.equal(dia.motivo, 'comparativa_no_anterior');
  assert.equal(dia.totalPrevisto, 0);
});

test('agregarFacturasPorHora: ignora sin hora o bruto <= 0, mismo criterio que sales-by-hour', () => {
  const r = store.agregarFacturasPorHora(FACTURAS['101|2024-10-02']);
  assert.deepEqual(r.porHora, { 1: 30, 12: 20, 18: 100, 22: 50 });
  assert.equal(r.totalDia, 200);
  assert.equal(r.nFacturas, 4);
});

// ─── Router ───

const LOCAL_PARIPE = { sub: '000050', email: 'paripe@grupo.test', rol: 'Local' };
const OFICINA = { sub: '000053', email: 'oficina@grupo.test', rol: 'SuperUser' };
const OTRO_OFICINA = { sub: '000054', email: 'otra@grupo.test', rol: 'SuperUser' };
const MARKETING = { sub: '000055', email: 'mk@grupo.test', rol: 'Marketing' };

const PERMISOS = {
  Local: ['prevision.ver'],
  SuperUser: ['prevision.ver', 'prevision.escenarios_globales', 'ajustes.sincronizaciones.ventas_hora'],
};

let usuarioActual = LOCAL_PARIPE;
let servidor = null;
let base = '';
let db = null;

async function pedir(metodo, ruta, usuario, cuerpo) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
    app.use('/api', previsionRouter);
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

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
  globalThis.fetch = fetchReal;
});

beforeEach(() => {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.franjasHorarias, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.gestionFestivos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.ventasHora, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.previsionEscenarios, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  for (const [rol, lista] of Object.entries(PERMISOS)) {
    for (const p of lista) db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${p}` });
  }
  db.sembrar(tables.locales, { id_Locales: '000001', nombre: 'PARIPE', agoraCode: '101' });
  db.sembrar(tables.locales, { id_Locales: '000002', nombre: 'SUR', agoraCode: '202' });
  db.sembrar(tables.usuarios, { id_usuario: '000050', Email: 'paripe@grupo.test', Rol: 'Local', Local: ['PARIPE'] });
  db.sembrar(tables.usuarios, { id_usuario: '000053', Email: 'oficina@grupo.test', Rol: 'SuperUser', Local: [] });
  db.sembrar(tables.usuarios, { id_usuario: '000054', Email: 'otra@grupo.test', Rol: 'SuperUser', Local: [] });
  db.sembrar(tables.usuarios, { id_usuario: '000055', Email: 'mk@grupo.test', Rol: 'Marketing', Local: [] });
  db.sembrar(tables.franjasHorarias, {
    PK: 'GLOBAL',
    SK: 'p_1',
    nombre: 'Noche',
    franjas: [
      { desde: '18:01', hasta: '21:00', etiqueta: 'Tarde' },
      { desde: '21:01', hasta: '00:00' },
      { desde: '00:01', hasta: '09:00', etiqueta: 'Madrugada' },
    ],
  });
  db.sembrar(tables.gestionFestivos, { PK: '2025-10-03', SK: '0', FechaComparativa: '2025-10-05', Festivo: true, NombreFestivo: 'Fiesta local' });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  store._reiniciarEstadoVentasHora();
  llamadasAgora.length = 0;
});

const PETICION = {
  fechaDesde: '2025-10-01',
  fechaHasta: '2025-10-03',
  diasExcluidos: [],
  plantillaId: 'p_1',
  objetivoEurEmpHora: 40,
};

test('calcular: previsión por franjas desde la comparativa, real de días pasados y motivos', async () => {
  const r = await pedir('POST', '/api/prevision-franjas/calcular', OFICINA, { ...PETICION, workplaceIds: ['101'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.plantilla.franjas.map((f) => [f.label, f.horas]), [
    ['Tarde (18:01–21:00)', 3],
    ['21:01–00:00', 3],
    ['Madrugada (00:01–09:00)', 9],
  ]);
  assert.equal(r.body.pendientes, 0);
  const [local] = r.body.locales;
  assert.equal(local.nombre, 'PARIPE');
  assert.equal(local.idLocal, '000001');
  const [d1, d2, d3] = local.dias;

  assert.equal(d1.fecha, '2025-10-01');
  assert.equal(d1.valida, false);
  assert.equal(d1.motivo, 'sin_ventas');

  assert.equal(d2.valida, true);
  assert.equal(d2.pasado, true);
  assert.equal(d2.fechaComparativa, '2024-10-02');
  assert.equal(d2.origenComparativa, 'anio_anterior');
  assert.deepEqual(d2.celdas, [
    { previsto: 100, personal: 1, real: 120, desvioPct: 0.2 },
    { previsto: 50, personal: 1, real: 0, desvioPct: -1 },
    { previsto: 30, personal: 1, real: 0, desvioPct: -1 },
  ]);
  assert.equal(d2.totalPrevisto, 180);
  assert.equal(d2.totalReal, 120);
  assert.equal(d2.fueraDeFranjas, 20);

  assert.equal(d3.valida, false);
  assert.equal(d3.motivo, 'comparativa_no_anterior');
  assert.equal(d3.origenComparativa, 'festivo');
  assert.deepEqual(d3.festivo, { nombre: 'Fiesta local' });

  assert.deepEqual(local.kpis, {
    ventaPrevista: 180,
    ventaRealPasados: 120,
    desvioPct: round4(120 / 180 - 1),
    franjaMasFuerte: { label: 'Tarde (18:01–21:00)', importe: 100 },
    diaMasFuerte: { fecha: '2025-10-02', importe: 180 },
    picoPersonal: { fecha: '2025-10-02', label: 'Tarde (18:01–21:00)', personas: 1 },
  });

  // Los días cerrados quedan guardados: el segundo cálculo no llama a Ágora.
  assert.ok(db.obtener(tables.ventasHora, { PK: '101', SK: '2024-10-02' }));
  llamadasAgora.length = 0;
  const r2 = await pedir('POST', '/api/prevision-franjas/calcular', OFICINA, { ...PETICION, workplaceIds: ['101'] });
  assert.equal(r2.status, 200);
  assert.deepEqual(llamadasAgora, []);
  assert.deepEqual(r2.body.locales[0].dias[1].celdas, d2.celdas);
});

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

test('alcance: un usuario restringido no recibe locales ajenos', async () => {
  const r = await pedir('POST', '/api/prevision-franjas/calcular', LOCAL_PARIPE, { ...PETICION, workplaceIds: ['101', '202'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.locales.map((l) => l.workplaceId), ['101']);
  assert.ok(!llamadasAgora.some((c) => c.startsWith('202|')));

  const ajeno = await pedir('POST', '/api/prevision-franjas/calcular', LOCAL_PARIPE, { ...PETICION, workplaceIds: ['202'] });
  assert.equal(ajeno.status, 403);
  const vacio = await pedir('POST', '/api/prevision-franjas/calcular', LOCAL_PARIPE, { ...PETICION, workplaceIds: [] });
  assert.equal(vacio.status, 403);

  const global = await pedir('POST', '/api/prevision-franjas/calcular', OFICINA, { ...PETICION, workplaceIds: ['101', '202'] });
  assert.deepEqual(global.body.locales.map((l) => l.workplaceId), ['101', '202']);
});

test('calcular: sin prevision.ver 403; validaciones de rango, objetivo y plantilla', async () => {
  assert.equal((await pedir('POST', '/api/prevision-franjas/calcular', MARKETING, { ...PETICION, workplaceIds: ['101'] })).status, 403);
  const malos = [
    { fechaDesde: '2025-10-05', fechaHasta: '2025-10-01' },
    { fechaDesde: '2025-01-01', fechaHasta: '2025-03-31' },
    { objetivoEurEmpHora: 0 },
    { fechaDesde: '2025-02-30' },
  ];
  for (const m of malos) {
    const r = await pedir('POST', '/api/prevision-franjas/calcular', OFICINA, { ...PETICION, ...m, workplaceIds: ['101'] });
    assert.equal(r.status, 400, JSON.stringify(m));
  }
  const sinPlantilla = await pedir('POST', '/api/prevision-franjas/calcular', OFICINA, { ...PETICION, plantillaId: 'nope', workplaceIds: ['101'] });
  assert.equal(sinPlantilla.status, 404);
});

test('calcular: los días excluidos no aparecen', async () => {
  const r = await pedir('POST', '/api/prevision-franjas/calcular', OFICINA, {
    ...PETICION,
    diasExcluidos: ['2025-10-01', '2025-10-03'],
    workplaceIds: ['101'],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.locales[0].dias.map((d) => d.fecha), ['2025-10-02']);
});

test('Ágora falló en la comparativa → error_agora; sin real si el real falló', () => {
  const dia = calcularDia({
    fecha: '2025-10-02',
    hoyJornada: '2026-10-14',
    franjas: prepararFranjas([{ desde: '18:00', hasta: '21:00' }]),
    objetivo: 40,
    comparativa: resolverFechaComparativa('2025-10-02', null),
    datoComparativa: { error: true },
    datoReal: { error: true },
  });
  assert.equal(dia.motivo, 'error_agora');
  assert.equal(dia.totalReal, null);
  assert.equal(dia.celdas[0].real, null);
});

test('maxFetch: lo que excede queda pendiente y se avisa', async () => {
  const datos = await store.obtenerVentasHora(
    [
      { workplaceId: '101', businessDay: '2024-10-02' },
      { workplaceId: '202', businessDay: '2024-10-02' },
      { workplaceId: '101', businessDay: '2099-01-01' },
    ],
    { maxFetch: 1, hoyJornada: '2026-10-14' },
  );
  assert.equal(datos.get('101|2024-10-02').totalDia, 200);
  assert.deepEqual(datos.get('202|2024-10-02'), { pendiente: true });
  assert.equal(datos.get('101|2099-01-01').noCerrado, true);
  assert.deepEqual(llamadasAgora, ['101|2024-10-02']);
});

test('sin tabla Igp_VentasHora: consulta Ágora en vivo y no guarda', async () => {
  db.interceptar('BatchGetCommand', undefined, () => {
    throw Object.assign(new Error('Requested resource not found'), { name: 'ResourceNotFoundException' });
  });
  const avisos = [];
  const original = console.warn;
  console.warn = (...a) => avisos.push(a.join(' '));
  try {
    const datos = await store.obtenerVentasHora([{ workplaceId: '101', businessDay: '2024-10-02' }], { hoyJornada: '2026-10-14' });
    assert.equal(datos.get('101|2024-10-02').totalDia, 200);
  } finally {
    console.warn = original;
  }
  assert.equal(db.listar(tables.ventasHora).length, 0);
  assert.ok(avisos.some((a) => a.includes('no existe')));
  assert.equal(store.ventasHoraSinTabla(), true);
});

// ─── Escenarios ───

const ESCENARIO = {
  nombre: 'Octubre',
  fechaDesde: '2025-10-01',
  fechaHasta: '2025-10-31',
  diasExcluidos: ['2025-10-12'],
  workplaceIds: ['101', '202'],
  plantillaId: 'p_1',
  objetivoEurEmpHora: 45,
};

test('escenarios propios: solo el dueño los ve y edita; el PK sale del token', async () => {
  const creado = await pedir('POST', '/api/prevision-franjas/escenarios', OFICINA, { ...ESCENARIO, PK: 'USER#000054' });
  assert.equal(creado.status, 201, JSON.stringify(creado.body));
  assert.equal(creado.body.escenario.ambito, 'propio');
  const id = creado.body.escenario.id;
  assert.ok(db.obtener(tables.previsionEscenarios, { PK: 'USER#000053', SK: `ESC#${id}` }));

  const mios = await pedir('GET', '/api/prevision-franjas/escenarios', OFICINA);
  assert.deepEqual(mios.body.escenarios.map((e) => e.id), [id]);
  const ajenos = await pedir('GET', '/api/prevision-franjas/escenarios', OTRO_OFICINA);
  assert.deepEqual(ajenos.body.escenarios, []);

  const editarAjeno = await pedir('PUT', '/api/prevision-franjas/escenarios', OTRO_OFICINA, { ...ESCENARIO, id, ambito: 'propio', nombre: 'X' });
  assert.equal(editarAjeno.status, 404);
  const borrarAjeno = await pedir('DELETE', `/api/prevision-franjas/escenarios?id=${id}&ambito=propio`, OTRO_OFICINA);
  assert.equal(borrarAjeno.status, 404);

  const editado = await pedir('PUT', '/api/prevision-franjas/escenarios', OFICINA, { ...ESCENARIO, id, ambito: 'propio', nombre: 'Octubre v2' });
  assert.equal(editado.status, 200);
  assert.equal(editado.body.escenario.nombre, 'Octubre v2');
  assert.equal(editado.body.escenario.creadoPor, '000053');

  const borrado = await pedir('DELETE', `/api/prevision-franjas/escenarios?id=${id}&ambito=propio`, OFICINA);
  assert.equal(borrado.status, 200);
  assert.equal(db.listar(tables.previsionEscenarios).length, 0);
});

test('escenarios globales: escribir exige prevision.escenarios_globales; restringidos ven solo sus locales', async () => {
  const sinPermiso = await pedir('POST', '/api/prevision-franjas/escenarios', LOCAL_PARIPE, { ...ESCENARIO, ambito: 'global' });
  assert.equal(sinPermiso.status, 403);
  const ok = await pedir('POST', '/api/prevision-franjas/escenarios', OFICINA, { ...ESCENARIO, ambito: 'global' });
  assert.equal(ok.status, 201);
  const id = ok.body.escenario.id;

  const local = await pedir('GET', '/api/prevision-franjas/escenarios', LOCAL_PARIPE);
  assert.equal(local.body.escenarios.length, 1);
  assert.equal(local.body.escenarios[0].ambito, 'global');
  assert.deepEqual(local.body.escenarios[0].workplaceIds, ['101']);

  assert.equal((await pedir('DELETE', `/api/prevision-franjas/escenarios?id=${id}&ambito=global`, LOCAL_PARIPE)).status, 403);
  assert.equal((await pedir('DELETE', `/api/prevision-franjas/escenarios?id=${id}&ambito=global`, OTRO_OFICINA)).status, 200);
});

test('escenarios: validación de tamaños', async () => {
  const largo = await pedir('POST', '/api/prevision-franjas/escenarios', OFICINA, { ...ESCENARIO, nombre: 'x'.repeat(81) });
  assert.equal(largo.status, 400);
  const muchos = Array.from({ length: 101 }, (_, i) => `W${i}`);
  const lista = await pedir('POST', '/api/prevision-franjas/escenarios', OFICINA, { ...ESCENARIO, workplaceIds: muchos });
  assert.equal(lista.status, 400);
  const ambito = await pedir('POST', '/api/prevision-franjas/escenarios', OFICINA, { ...ESCENARIO, ambito: 'todos' });
  assert.equal(ambito.status, 400);
});

// ─── Sincronización ───

test('ventas-hora/sync: exige permiso y alcance global; guarda solo días cerrados', async () => {
  const cuerpo = { fechaDesde: '2024-10-02', fechaHasta: '2024-10-02' };
  assert.equal((await pedir('POST', '/api/prevision-franjas/ventas-hora/sync', LOCAL_PARIPE, cuerpo)).status, 403);
  const r = await pedir('POST', '/api/prevision-franjas/ventas-hora/sync', OFICINA, cuerpo);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.traidos, 2);
  assert.equal(db.obtener(tables.ventasHora, { PK: '202', SK: '2024-10-02' }).totalDia, 500);

  llamadasAgora.length = 0;
  const otra = await pedir('POST', '/api/prevision-franjas/ventas-hora/sync', OFICINA, cuerpo);
  assert.equal(otra.body.existentes, 2);
  assert.deepEqual(llamadasAgora, []);
  const forzada = await pedir('POST', '/api/prevision-franjas/ventas-hora/sync', OFICINA, { ...cuerpo, force: true });
  assert.equal(forzada.body.traidos, 2);

  const largo = await pedir('POST', '/api/prevision-franjas/ventas-hora/sync', OFICINA, { fechaDesde: '2024-01-01', fechaHasta: '2024-03-01' });
  assert.equal(largo.status, 400);
});
