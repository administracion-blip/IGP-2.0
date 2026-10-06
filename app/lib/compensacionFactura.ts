/** Helpers UI para compensación entre facturas de gasto. */

import { formatFecha } from '../utils/formatFecha';

export type CompensacionDetalle = {
  id_factura: string;
  numero?: string;
  fecha_emision?: string;
};

export type LineaCompensacionVisible = {
  principal: string;
  id: string;
};

/** Número y fecha de la factura cruzada; el id queda aparte. */
export function lineasDetalleCompensacion(
  detalles: CompensacionDetalle[] | null | undefined,
): LineaCompensacionVisible[] {
  if (!Array.isArray(detalles) || detalles.length === 0) return [];
  return detalles.map((d) => {
    const numero = String(d.numero ?? '').trim();
    const fechaRaw = String(d.fecha_emision ?? '').trim();
    const fecha = fechaRaw ? formatFecha(fechaRaw) : '';
    const fechaTxt = fecha && fecha !== '—' ? fecha : '';
    const principal = [numero, fechaTxt].filter(Boolean).join(' · ');
    return {
      principal: principal || 'Factura vinculada',
      id: String(d.id_factura ?? '').trim(),
    };
  });
}

/** Nota escrita a mano, sin el texto automático «Compensación con: …». */
export function notaAparteDeCompensacion(observaciones: string | null | undefined): string {
  const texto = String(observaciones ?? '').trim();
  if (!texto) return '';
  const corte = texto.split(' · Compensación con');
  if (corte.length > 1) return corte[0].trim();
  if (/^Compensación con\b/i.test(texto)) return '';
  return texto;
}

export type FacturaCompensableRow = {
  id_factura: string;
  numero_factura?: string;
  numero_factura_proveedor?: string;
  empresa_nombre?: string;
  emisor_nombre?: string;
  fecha_emision?: string;
  saldo_pendiente?: number;
  etiqueta?: string;
};

export function capacidadCompensacion(saldo: number | null | undefined): number {
  return Math.round(Math.abs(Number(saldo) || 0) * 100) / 100;
}

/** Importe máximo compensable dado saldo origen y facturas destino seleccionadas. */
export function maxImporteCompensacion(
  saldoOrigen: number,
  destinos: FacturaCompensableRow[],
  idsSeleccionados: string[],
): number {
  const capOrigen = capacidadCompensacion(saldoOrigen);
  const sel = new Set(idsSeleccionados);
  const capDest = destinos
    .filter((f) => sel.has(f.id_factura))
    .reduce((s, f) => s + capacidadCompensacion(f.saldo_pendiente), 0);
  return Math.round(Math.min(capOrigen, capDest) * 100) / 100;
}

export function esMetodoCompensacion(metodo: string | undefined | null): boolean {
  return String(metodo ?? '').trim().toLowerCase() === 'compensacion';
}
