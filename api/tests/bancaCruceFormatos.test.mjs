/**
 * Cruce de formatos: el mismo extracto leído en Norma 43 y en el Excel del banco.
 *
 * Es la garantía de que la ingesta no duplica. Un mismo apunte se descarga unas
 * veces en Q43 y otras en Excel, y la huella se calcula solo con datos que
 * traen los dos formatos (cuenta, fecha de operación, importe en céntimos y el
 * ordinal que separa apuntes idénticos del mismo día). Si las dos lecturas no
 * dieran exactamente las mismas huellas, el movimiento entraría dos veces y la
 * conciliación propondría pagar la misma factura dos veces.
 *
 * El caso que se fija es el que rompía: un Norma 43 que trae la misma cuenta
 * partida en dos bloques 11/33 con fechas que se tocan, frente a un único Excel
 * del periodo completo.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import ExcelJS from 'exceljs';
import { parsearN43 } from '../lib/n43/index.js';
import { adaptarN43 } from '../lib/banca/canonico.js';
import { leerBbvaXlsx } from '../lib/banca/bbvaXlsx.js';

/** CCC 2100 0418 45 0200051332, el del ejemplo del ISO 13616. */
const ENTIDAD = '2100';
const OFICINA = '0418';
const CUENTA = '0200051332';
const IBAN = 'ES9121000418450200051332';

// --- Norma 43 -------------------------------------------------------------

/** Escribe tramos [desde, hasta, valor] (1-indexados, inclusive) sobre un registro de 80. */
function reg(...tramos) {
  const buf = Array(80).fill(' ');
  for (const [desde, hasta, valor] of tramos) {
    const largo = hasta - desde + 1;
    const v = String(valor).slice(0, largo).padEnd(largo, ' ');
    for (let i = 0; i < largo; i += 1) buf[desde - 1 + i] = v[i];
  }
  return buf.join('');
}

function num(valor, largo) {
  return String(valor).padStart(largo, '0');
}

function cabecera({ desde, hasta, saldoCentimos }) {
  return reg(
    [1, 2, '11'], [3, 6, ENTIDAD], [7, 10, OFICINA], [11, 20, CUENTA],
    [21, 26, desde], [27, 32, hasta], [33, 33, '2'],
    [34, 47, num(saldoCentimos, 14)], [48, 50, '978'], [51, 51, '3'],
    [52, 77, 'HOSTELERIA DEL SUR SL'],
  );
}

function apunte({ fecha, clave, centimos, concepto }) {
  return reg(
    [1, 2, '22'], [3, 6, ENTIDAD], [7, 10, OFICINA], [11, 16, fecha], [17, 22, fecha],
    [23, 24, '03'], [25, 27, '001'], [28, 28, clave], [29, 42, num(centimos, 14)],
    [43, 52, '0000000001'], [53, 64, concepto.slice(0, 12)], [65, 80, concepto.slice(12)],
  );
}

function finalCuenta({ apuntesDebe, totalDebeCentimos, apuntesHaber, totalHaberCentimos, saldoCentimos }) {
  return reg(
    [1, 2, '33'], [3, 6, ENTIDAD], [7, 10, OFICINA], [11, 20, CUENTA],
    [21, 25, num(apuntesDebe, 5)], [26, 39, num(totalDebeCentimos, 14)],
    [40, 44, num(apuntesHaber, 5)], [45, 58, num(totalHaberCentimos, 14)],
    [59, 59, '2'], [60, 73, num(saldoCentimos, 14)], [74, 76, '978'],
  );
}

/**
 * El extracto de febrero en Norma 43, partido en dos bloques de la misma cuenta
 * que se tocan el día 15. El apunte de -50 € del día 15 aparece una vez en cada
 * bloque: son dos cargos legítimos y tienen que sobrevivir los dos.
 */
function ficheroN43() {
  const lineas = [
    cabecera({ desde: '260201', hasta: '260215', saldoCentimos: 100000 }),
    apunte({ fecha: '260210', clave: '1', centimos: 10000, concepto: 'RECIBO IBERDROLA' }),
    apunte({ fecha: '260215', clave: '1', centimos: 5000, concepto: 'COMISION MANTEN' }),
    finalCuenta({
      apuntesDebe: 2, totalDebeCentimos: 15000, apuntesHaber: 0, totalHaberCentimos: 0,
      saldoCentimos: 85000,
    }),
    cabecera({ desde: '260215', hasta: '260228', saldoCentimos: 85000 }),
    apunte({ fecha: '260215', clave: '1', centimos: 5000, concepto: 'COMISION MANTEN' }),
    apunte({ fecha: '260220', clave: '2', centimos: 30000, concepto: 'TRANSF CLIENTE' }),
    finalCuenta({
      apuntesDebe: 1, totalDebeCentimos: 5000, apuntesHaber: 1, totalHaberCentimos: 30000,
      saldoCentimos: 110000,
    }),
  ];
  lineas.push(reg([1, 2, '88'], [3, 20, '9'.repeat(18)], [21, 26, num(lineas.length + 1, 6)]));
  return Buffer.from(lineas.join('\r\n'), 'latin1');
}

// --- Excel de BBVA --------------------------------------------------------

const CABECERA_XLSX = [
  'F. CONTABLE', 'F. VALOR', 'CÓDIGO', 'CONCEPTO', 'BENEFICIARIO/ORDENANTE',
  'OBSERVACIONES', 'IMPORTE', 'SALDO', 'DIVISA', 'OFICINA', 'REMESA',
];

/** En el extracto de BBVA las dos primeras columnas van vacías. */
const COL_PRIMERA = 3;

/** Los mismos cuatro apuntes, como los lista BBVA: del más reciente al más antiguo. */
const FILAS_XLSX = [
  { fecha: '20/02/2026', concepto: 'TRANSFERENCIAS', importe: 300, saldo: 1100 },
  { fecha: '15/02/2026', concepto: 'COMISIONES', importe: -50, saldo: 800 },
  { fecha: '15/02/2026', concepto: 'COMISIONES', importe: -50, saldo: 850 },
  { fecha: '10/02/2026', concepto: 'ADEUDOS POR DOMICILIACIONES', importe: -100, saldo: 900 },
];

async function ficheroXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Historico');
  const pon = (fila, columna, valor) => {
    if (valor === '' || valor == null) return;
    ws.getCell(fila, columna).value = valor;
  };

  let f = 5;
  pon(f, COL_PRIMERA, 'Movimientos');
  f += 2;
  for (const [nombre, valor] of [
    ['Titular', 'HOSTELERIA DEL SUR SL'],
    ['Cuenta', IBAN],
    ['Divisa', 'EUR'],
    ['Periodo', '01/02/2026-28/02/2026'],
  ]) {
    pon(f, COL_PRIMERA, nombre);
    pon(f, COL_PRIMERA + 3, valor);
    f += 1;
  }

  f += 1;
  CABECERA_XLSX.forEach((nombre, i) => pon(f, COL_PRIMERA + i, nombre));
  f += 1;

  for (const m of FILAS_XLSX) {
    [m.fecha, m.fecha, '00317', m.concepto, '', '', m.importe, m.saldo, 'EUR', '6051', '']
      .forEach((valor, i) => pon(f, COL_PRIMERA + i, valor));
    f += 1;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- El cruce -------------------------------------------------------------

function huellas(extracto) {
  return extracto.cuentas.flatMap((c) => c.movimientos.map((m) => m.movementHash)).sort();
}

test('el mismo extracto en Norma 43 y en Excel produce exactamente las mismas huellas', async () => {
  const n43 = adaptarN43(parsearN43(ficheroN43()));
  const xlsx = await leerBbvaXlsx(await ficheroXlsx());

  // Los dos leen los cuatro apuntes y ninguno colapsa el par idéntico del día 15.
  assert.equal(n43.cuentas.reduce((n, c) => n + c.movimientos.length, 0), 4);
  assert.equal(xlsx.cuentas[0].movimientos.length, 4);
  assert.equal(new Set(huellas(n43)).size, 4);

  assert.deepEqual(huellas(n43), huellas(xlsx));
});

test('los dos formatos coinciden en la cuenta, la fecha y el importe en céntimos de cada apunte', async () => {
  const n43 = adaptarN43(parsearN43(ficheroN43()));
  const xlsx = await leerBbvaXlsx(await ficheroXlsx());

  const resumir = (extracto) => extracto.cuentas
    .flatMap((c) => c.movimientos)
    .map((m) => `${m.cuentaRef}|${m.fechaOperacion}|${m.importeCentimos}|${m.ordinal}`)
    .sort();

  assert.deepEqual(resumir(n43), resumir(xlsx));
  // Y el par de comisiones idénticas se distingue por el ordinal, no por otra cosa.
  assert.ok(resumir(n43).includes(`${IBAN}|2026-02-15|-5000|1`));
  assert.ok(resumir(n43).includes(`${IBAN}|2026-02-15|-5000|2`));
});
