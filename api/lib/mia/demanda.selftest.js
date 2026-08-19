/**
 * Selftest MIA demanda / redondeo.
 * Ejecutar: node api/lib/mia/demanda.selftest.js
 */
import {
  addDaysIso,
  mediaPorWeekday,
  demandaBaseRango,
  aplicarColchon,
  redondearCantidadCompra,
  weekdayOfIso,
} from './demanda.js';

function assertClose(actual, expected, label, tol = 0.001) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label}: esperado ${expected}, obtenido ${actual}`);
  }
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: esperado ${expected}, obtenido ${actual}`);
  }
}

// Redondeo
assertEq(redondearCantidadCompra(0, 6), 0, 'qty 0');
assertEq(redondearCantidadCompra(1.1, null), 2, 'ceil sin pack');
assertEq(redondearCantidadCompra(12, 6), 12, 'múltiplo exacto');
assertEq(redondearCantidadCompra(13, 6), 18, 'ceil a pack 6');
assertEq(redondearCantidadCompra(0.1, 12), 12, 'mínimo un pack');

// Weekday media: 4 lunes con 10,10,10,10 → media 10
const fechaDesde = '2026-08-10'; // lunes
assertEq(weekdayOfIso(fechaDesde), 1, 'lunes');
const map = new Map();
for (let w = 1; w <= 4; w += 1) {
  map.set(addDaysIso(fechaDesde, -7 * w), 10);
}
const medias = mediaPorWeekday(map, fechaDesde, 4);
assertClose(medias[1], 10, 'media lunes');
assertClose(medias[2], 0, 'media martes sin datos');

// Un lunes con 40 y tres con 0 → media 10
const map2 = new Map([[addDaysIso(fechaDesde, -7), 40]]);
const medias2 = mediaPorWeekday(map2, fechaDesde, 4);
assertClose(medias2[1], 10, 'media con huecos=0');

const base = demandaBaseRango(medias, '2026-08-10', '2026-08-16'); // lun–dom
assertEq(base.porDia.length, 7, '7 días');
assertClose(base.total, 10, 'solo lunes aporta');

assertClose(aplicarColchon(10, 7, 1), 10 * (8 / 7), 'colchón 1 día');

console.log('OK mia demanda.selftest');
