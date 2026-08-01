/** Helpers UI para compensación entre facturas de gasto. */

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
