/**
 * Suma y reparto manual de una selección de facturas contra un movimiento.
 * El alta real sigue siendo POST /api/banca/conciliacion/aplicar.
 */
import type { FacturaListado } from '../types/factura';
import type { MovimientoBanca } from '../types/banca';
import type { SugerenciaConciliacion, SugerenciasDeFactura } from '../types/conciliacion';
import { aCentimos } from './conciliacion';

/** Mismos estados que admite el motor de conciliación. */
export const ESTADOS_CONCILIABLES = new Set([
  'pendiente_revision',
  'pendiente_pago',
  'parcialmente_pagada',
  'emitida',
  'parcialmente_cobrada',
  'vencida',
]);

export type MovimientoConciliable = MovimientoBanca & { conciliadoCentimos?: number };

export function sumaSeleccion(facturas: FacturaListado[]): { n: number; total: number; pendiente: number } {
  let total = 0;
  let pendiente = 0;
  for (const f of facturas) {
    total += Number(f.total_factura) || 0;
    pendiente += Number(f.saldo_pendiente) || 0;
  }
  return { n: facturas.length, total, pendiente };
}

export function saldoPositivoCentimos(f: FacturaListado): number {
  const c = aCentimos(Number(f.saldo_pendiente) || 0);
  return c > 1 ? c : 0;
}

export function facturasConciliables(facturas: FacturaListado[]): FacturaListado[] {
  return facturas.filter(
    (f) => ESTADOS_CONCILIABLES.has(String(f.estado || '')) && saldoPositivoCentimos(f) > 0,
  );
}

/** Id de la sociedad emisora si todas las facturas útiles son de la misma. */
export function emisorComun(facturas: FacturaListado[]): string | null {
  const ids = new Set(facturas.map((f) => String(f.emisor_id || '').trim()).filter(Boolean));
  if (ids.size !== 1) return null;
  return [...ids][0];
}

/** Texto para desactivar Conciliar. Null si se puede abrir el selector. */
export function motivoNoConciliar(facturas: FacturaListado[]): string | null {
  if (facturas.length === 0) return 'Marca al menos una factura';
  const utiles = facturasConciliables(facturas);
  if (utiles.length === 0) return 'Ninguna tiene saldo pendiente';
  if (!emisorComun(utiles)) return 'Elige facturas de la misma empresa';
  return null;
}

export function libreCentimos(m: MovimientoConciliable): number {
  const total = Math.abs(m.importeCentimos || aCentimos(m.importe));
  const usado = Math.max(0, Math.trunc(Number(m.conciliadoCentimos) || 0));
  return Math.max(0, total - usado);
}

/** Gasto solo con cargos (negativo). Venta solo con abonos (positivo). */
export function signoCompatibleSeleccion(tipo: 'IN' | 'OUT', m: MovimientoConciliable): boolean {
  const c = m.importeCentimos || aCentimos(m.importe);
  if (!c) return false;
  return tipo === 'IN' ? c < 0 : c > 0;
}

/**
 * Arma la misma forma que una sugerencia del motor, con el pendiente de cada
 * factura y sin pasarse de lo que queda libre en el movimiento.
 */
export function construirEntradaManual(
  tipo: 'IN' | 'OUT',
  facturas: FacturaListado[],
  mov: MovimientoConciliable,
): SugerenciasDeFactura {
  const utiles = facturasConciliables(facturas);
  const conciliable = libreCentimos(mov);
  let restante = conciliable;
  const filas = utiles.map((f) => {
    const saldoC = saldoPositivoCentimos(f);
    const asignado = Math.min(saldoC, Math.max(0, restante));
    restante -= asignado;
    const numero = tipo === 'IN'
      ? (f.numero_factura_proveedor || f.numero_factura || f.id_factura)
      : (f.numero_factura || f.id_factura);
    return {
      id_factura: f.id_factura,
      tipo,
      estado: f.estado,
      numero,
      emisor_id: f.emisor_id,
      emisor_nombre: f.emisor_nombre,
      empresa_nombre: f.empresa_nombre,
      empresa_cif: f.empresa_cif,
      fecha_emision: f.fecha_emision,
      saldoPendiente: saldoC / 100,
      saldoPendienteCentimos: saldoC,
      asignado: asignado / 100,
      asignadoCentimos: asignado,
      restoFactura: (saldoC - asignado) / 100,
      restoFacturaCentimos: saldoC - asignado,
      pendienteRevision: f.estado === 'pendiente_revision',
    };
  });
  const asignadoTotal = filas.reduce((s, f) => s + f.asignadoCentimos, 0);
  const importeCentimos = mov.importeCentimos || aCentimos(mov.importe);
  const sugerencia: SugerenciaConciliacion = {
    clave: `${mov.movementHash}:manual`,
    tipo: 'combinacion',
    movementHash: mov.movementHash,
    cuentaRef: mov.cuentaRef || '',
    fechaOperacion: mov.fechaOperacion || '',
    importe: Number(mov.importe) || importeCentimos / 100,
    importeCentimos,
    conciliable: conciliable / 100,
    conciliableCentimos: conciliable,
    asignado: asignadoTotal / 100,
    asignadoCentimos: asignadoTotal,
    restoMovimiento: (conciliable - asignadoTotal) / 100,
    restoMovimientoCentimos: conciliable - asignadoTotal,
    puntuacion: 0,
    nivel: 'baja',
    motivos: ['Varias facturas elegidas a mano'],
    facturas: filas,
    movimiento: {
      concepto: mov.concepto,
      conceptoNormalizado: mov.conceptoNormalizado,
      nif: mov.nif,
      referencia1: mov.referencia1,
      referencia2: mov.referencia2,
      numeroDocumento: mov.numeroDocumento,
      empresaId: mov.empresaId,
      empresaNombre: mov.empresaNombre,
      iban: mov.iban,
      fechaValor: mov.fechaValor,
      formatoOrigen: mov.formatoOrigen,
      nombreFichero: mov.nombreFichero,
      estadoConciliacion: mov.estadoConciliacion,
    },
  };
  return {
    id_factura: utiles[0]?.id_factura || facturas[0]?.id_factura || '',
    mejorNivel: 'baja',
    mejorPuntuacion: 0,
    sugerencias: [sugerencia],
  };
}
