/**
 * Verificación del ejemplo numérico del módulo mayorista.
 * Ejecutar: node api/lib/mayorista/calculos.selftest.js
 */
import { recalcularLinea, agregarTotales, round2 } from './calculos.js';

function assertClose(actual, expected, label, tol = 0.02) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label}: esperado ${expected}, obtenido ${actual}`);
  }
}

// Mk.% virtual: se aporta PVP; el % se deriva. No se reescribe PVP desde pct.
const linea = recalcularLinea({
  precioCompra: 10,
  descuentoImporte: 1.5,
  cantidad: 100,
  pvpUnitario: 7.5,
  aportacionUnitaria: 2.5,
  tasaCapital: 0.08,
  diasCobro: 365,
});

// PMR = Cn − aportación = 8.5 − 2.5 = 6.0
// Mk% = (7.5 / 6.0 − 1) × 100 = 25 ; NETO ud = 7.5 − 6.0 = 1.5 → × 100 = 150
assertClose(linea.coste_neto, 8.5, 'Cn');
assertClose(linea.pmr, 6.0, 'PMR');
assertClose(linea.pvp_unitario, 7.5, 'PVP');
assertClose(linea.pct_ganancia, 25, 'Mk.% virtual');
assertClose(linea.aportacion_asignada, 250, 'Aportación asignada');
assertClose(linea.beneficio_neto, 150, 'Beneficio neto');

// Cambiar coste no debe reescribir PVP
const trasCoste = recalcularLinea({
  precioCompra: 12,
  descuentoImporte: 0,
  cantidad: 1,
  pvpUnitario: 7.5,
  aportacionUnitaria: 2.5,
});
assertClose(trasCoste.pvp_unitario, 7.5, 'PVP intacto tras coste');
assertClose(trasCoste.pmr, 9.5, 'PMR tras coste');
assertClose(trasCoste.pct_ganancia, round2((7.5 / 9.5 - 1) * 100), 'Mk.% recalculado');

const tot = agregarTotales([{ ...linea, cantidad: 100 }]);
assertClose(tot.venta_total, 750, 'Venta total');
assertClose(tot.beneficio_neto, 150, 'Beneficio neto total');
assertClose(tot.margen_pct, 20, 'Margen');

console.log('OK mayorista calculos.selftest');
