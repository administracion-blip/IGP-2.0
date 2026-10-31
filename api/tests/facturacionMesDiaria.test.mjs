/**
 * Facturación diaria del mes: solo locales asignados, sede Grupo Paripe por
 * defecto, y el objetivo del día comparable (FechaComparativa si existe).
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { fechaComparacion } = await import('../lib/agora/objetivoMensual.js');
const { buildFacturacionMesDiaria } = await import('../lib/agora/facturacionMesDiaria.js');

function mesCerrado() {
  const d = new Date();
  d.setDate(15);
  d.setMonth(d.getMonth() - 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function iso(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cierre(pk, fecha, amount) {
  return { PK: pk, SK: `${fecha}#1#1`, InvoicePayments: [{ Amount: amount }] };
}

const pasado = mesCerrado();
const dia10 = iso(pasado.year, pasado.month, 10);
const dia11 = iso(pasado.year, pasado.month, 11);
const yoy11 = fechaComparacion(dia11);
const compForzada = '2020-03-03';

const db = crearDynamoMemoria();
db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
db.crearTabla(tables.salesCloseOuts, { hashKey: 'PK', rangeKey: 'SK' });
db.crearTabla(tables.gestionFestivos, { hashKey: 'PK', rangeKey: 'SK' });

db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Norte', agoraCode: '101', sede: 'GRUPO PARIPE' });
db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur', agoraCode: '202', sede: 'Grupo Paripe Madrid' });
db.sembrar(tables.locales, { id_Locales: '000030', nombre: 'Bar Franquicia', agoraCode: '303', sede: 'FRANQUICIA' });
db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Rol: 'Local', Local: ['Bar Norte', 'Bar Franquicia'] });
db.sembrar(tables.usuarios, { id_usuario: 'u-admin', Rol: 'Administrador', Local: [] });

db.sembrar(tables.salesCloseOuts, cierre('101', dia10, 100));
db.sembrar(tables.salesCloseOuts, cierre('202', dia10, 50));
db.sembrar(tables.salesCloseOuts, cierre('303', dia10, 80));
db.sembrar(tables.salesCloseOuts, cierre('101', compForzada, 40));
db.sembrar(tables.salesCloseOuts, cierre('101', fechaComparacion(dia10), 999));
db.sembrar(tables.salesCloseOuts, cierre('101', dia11, 10));
db.sembrar(tables.salesCloseOuts, cierre('101', yoy11, 7));
db.sembrar(tables.gestionFestivos, { PK: dia10, SK: '0', FechaComparativa: compForzada });

db.instalar(docClient);
invalidarMaestroLocales();
invalidarContextoAcceso();

const norte = { sub: 'u-norte', rol: 'Local' };

test('sin localIds solo suma locales asignados con sede Grupo Paripe', async () => {
  const r = await buildFacturacionMesDiaria(norte, pasado);
  const d10 = r.dias.find((d) => d.fecha === dia10);
  const d11 = r.dias.find((d) => d.fecha === dia11);
  assert.equal(d10.real, 100);
  assert.equal(d10.objetivo, 40);
  assert.equal(d11.real, 10);
  assert.equal(d11.objetivo, 7);
  assert.equal(r.dias.length, new Date(pasado.year, pasado.month, 0).getDate());
  assert.equal(r.ultimoDiaConDatos, dia11);
  assert.equal(r.totalReal, 110);
  assert.equal(r.objetivoAHoy, 47);
  assert.equal(r.diferenciaRitmo, 63);
  assert.equal(r.consecucionPct, Math.round((110 / 47) * 1000) / 10);
});

test('un id no asignado se ignora; si no queda ninguno, 403', async () => {
  const mezcla = await buildFacturacionMesDiaria(norte, { ...pasado, localIds: '000010,000020' });
  assert.equal(mezcla.dias.find((d) => d.fecha === dia10).real, 100);

  await assert.rejects(
    () => buildFacturacionMesDiaria(norte, { ...pasado, localIds: '000020' }),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => buildFacturacionMesDiaria(norte, { ...pasado, localIds: 'abc' }),
    (err) => err.status === 403,
  );
});

test('con localIds sí entra un local asignado aunque no sea sede Grupo Paripe', async () => {
  const r = await buildFacturacionMesDiaria(norte, { ...pasado, localIds: '30' });
  assert.equal(r.dias.find((d) => d.fecha === dia10).real, 80);
});

test('un mes futuro responde 400 y un mes pasado incluye el mes completo', async () => {
  await assert.rejects(
    () => buildFacturacionMesDiaria(norte, { year: 2099, month: 1 }),
    (err) => err.status === 400,
  );
  await assert.rejects(
    () => buildFacturacionMesDiaria(norte, { year: 'no', month: 1 }),
    (err) => err.status === 400,
  );
  const r = await buildFacturacionMesDiaria(norte, pasado);
  assert.equal(r.dias.at(-1).fecha, iso(pasado.year, pasado.month, r.dias.length));
  assert.equal(r.objetivoMes, r.objetivoAHoy);
});

test('en el mes en curso el real de hoy no entra en el total', async () => {
  const ahora = new Date();
  const hoy = ahora.toISOString().slice(0, 10);
  const ayerDate = new Date(ahora);
  ayerDate.setDate(ayerDate.getDate() - 1);
  const ayer = ayerDate.toISOString().slice(0, 10);
  db.sembrar(tables.salesCloseOuts, cierre('101', hoy, 500));
  if (ayer.slice(0, 7) === hoy.slice(0, 7)) {
    db.sembrar(tables.salesCloseOuts, cierre('101', ayer, 20));
  }
  const r = await buildFacturacionMesDiaria(norte, { year: ahora.getFullYear(), month: ahora.getMonth() + 1 });
  const filaHoy = r.dias.find((d) => d.fecha === hoy);
  if (filaHoy) assert.equal(filaHoy.real, 0);
  if (ayer.slice(0, 7) === hoy.slice(0, 7)) {
    assert.equal(r.dias.find((d) => d.fecha === ayer).real, 20);
    assert.ok(r.totalReal >= 20);
    assert.ok(!r.dias.some((d) => d.fecha > ayer && d.real !== 0));
  } else {
    assert.equal(r.totalReal, 0);
    assert.equal(r.ultimoDiaConDatos, null);
  }
});
