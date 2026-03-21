/**
 * Única fuente de verdad para lógica pura del formulario de factura (fechas, líneas, totales, payload de líneas).
 * No altera el contrato API; los componentes siguen montando el body completo como hasta ahora.
 */
import { calcularLinea, calcularTotales, round2, type Factura, type LineaFactura } from './facturacion';

/** Texto fijo en líneas sintéticas cuando solo existen importes en cabecera (p. ej. OCR sin `facturasLineas`). */
export const DESCRIPCION_LINEA_SINTETICA_CABECERA =
  'Importe total sin desglose de líneas guardado (reconstruido desde la cabecera de la factura)';

export function hoyISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isoToDmy(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const [y, m, d] = iso.substring(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export function dmyToIso(dmy: string): string {
  if (!dmy) return '';
  const m = dmy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return dmy;
}

export function hoyDmy(): string {
  return isoToDmy(hoyISO());
}

/** Vencimiento = fecha emisión + plazo según condiciones (contado = +0 días). */
export function calcularFechaVencimientoDmy(fechaEmisionDmy: string, condicion: string): string {
  const iso = dmyToIso(fechaEmisionDmy);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  if (isNaN(base.getTime())) return '';
  let dias = 0;
  if (condicion === '15 días') dias = 15;
  else if (condicion === '30 días') dias = 30;
  else if (condicion === '60 días') dias = 60;
  else if (condicion === '90 días') dias = 90;
  base.setDate(base.getDate() + dias);
  const ry = base.getFullYear();
  const rm = String(base.getMonth() + 1).padStart(2, '0');
  const rd = String(base.getDate()).padStart(2, '0');
  return `${rd}/${rm}/${ry}`;
}

export const emptyLinea = (): LineaFactura => ({
  descripcion: '',
  cantidad: 1,
  precio_unitario: 0,
  descuento_pct: 0,
  tipo_iva: 21,
  retencion_pct: 0,
});

function numLinea(v: unknown, def = 0): number {
  if (v === null || v === undefined || v === '') return def;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : def;
}

/**
 * Normaliza una línea tal como viene de Dynamo/API (strings numéricos, tipos sueltos).
 */
export function normalizeLineaFromApi(raw: unknown): LineaFactura {
  const r = raw as Record<string, unknown>;
  const cant = numLinea(r.cantidad, 1);
  return {
    id_linea: r.id_linea != null ? String(r.id_linea) : undefined,
    producto_id: r.producto_id != null ? String(r.producto_id) : undefined,
    producto_ref: r.producto_ref != null ? String(r.producto_ref) : undefined,
    descripcion: String(r.descripcion ?? ''),
    cantidad: cant === 0 ? 1 : cant,
    precio_unitario: round2(numLinea(r.precio_unitario)),
    descuento_pct: round2(numLinea(r.descuento_pct)),
    tipo_iva: round2(numLinea(r.tipo_iva, 21)),
    iva_nombre: r.iva_nombre != null ? String(r.iva_nombre) : undefined,
    retencion_pct: round2(numLinea(r.retencion_pct)),
    base_linea: r.base_linea != null ? round2(numLinea(r.base_linea)) : undefined,
    iva_linea: r.iva_linea != null ? round2(numLinea(r.iva_linea)) : undefined,
    retencion_linea: r.retencion_linea != null ? round2(numLinea(r.retencion_linea)) : undefined,
    total_linea: r.total_linea != null ? round2(numLinea(r.total_linea)) : undefined,
  };
}

/**
 * Una línea coherente con la cabecera cuando no hay filas en `facturasLineas`.
 * Si `base_imponible <= 0`, no se infieren porcentajes (evita división por cero / % inválidos).
 */
export function lineaSinteticaDesdeCabecera(
  f: Pick<Factura, 'base_imponible' | 'total_iva' | 'total_retencion' | 'total_factura' | 'impuestos_resumen'>,
): LineaFactura {
  const base = round2(numLinea(f.base_imponible));
  const iva = round2(numLinea(f.total_iva));
  const ret = round2(numLinea(f.total_retencion));
  let tipoIva = 0;
  let retPct = 0;
  if (base > 0) {
    tipoIva = round2((100 * iva) / base);
    retPct = round2((100 * ret) / base);
  }
  const resumen = String(f.impuestos_resumen ?? '').trim();
  const descripcion = resumen
    ? `${DESCRIPCION_LINEA_SINTETICA_CABECERA} · ${resumen}`
    : DESCRIPCION_LINEA_SINTETICA_CABECERA;
  return {
    descripcion,
    cantidad: 1,
    precio_unitario: base,
    descuento_pct: 0,
    tipo_iva: tipoIva,
    retencion_pct: retPct,
  };
}

function cabeceraTieneImportes(
  f: Pick<Factura, 'base_imponible' | 'total_iva' | 'total_retencion' | 'total_factura'>,
): boolean {
  return (
    numLinea(f.base_imponible) !== 0 ||
    numLinea(f.total_iva) !== 0 ||
    numLinea(f.total_retencion) !== 0 ||
    numLinea(f.total_factura) !== 0
  );
}

/**
 * Líneas para el formulario: prioriza `lineas` del GET; si viene vacío pero la cabecera tiene importes,
 * usa una línea sintética alineada con la cabecera (mismos criterios que el listado agregado).
 */
export function hydrateLineasDesdeFactura(
  factura: Pick<Factura, 'base_imponible' | 'total_iva' | 'total_retencion' | 'total_factura' | 'impuestos_resumen'>,
  lineasRaw: unknown[] | null | undefined,
): LineaFactura[] {
  const raw = Array.isArray(lineasRaw) ? lineasRaw : [];
  if (raw.length > 0) {
    return raw.map(normalizeLineaFromApi);
  }
  if (cabeceraTieneImportes(factura)) {
    return [lineaSinteticaDesdeCabecera(factura)];
  }
  return [emptyLinea()];
}

/** Números: acepta coma decimal; alineado entre ficha y panel. */
export function updateLineaInArray(
  lineas: LineaFactura[],
  idx: number,
  field: keyof LineaFactura,
  value: string,
): LineaFactura[] {
  const copy = [...lineas];
  const numFields: (keyof LineaFactura)[] = ['cantidad', 'precio_unitario', 'descuento_pct', 'tipo_iva', 'retencion_pct'];
  if (numFields.includes(field)) {
    const n = value === '' ? 0 : parseFloat(String(value).replace(',', '.')) || 0;
    (copy[idx] as Record<string, unknown>)[field] = n;
  } else {
    (copy[idx] as Record<string, unknown>)[field] = value;
  }
  return copy;
}

export function addLineaToArray(lineas: LineaFactura[]): LineaFactura[] {
  return [...lineas, emptyLinea()];
}

export function removeLineaFromArray(lineas: LineaFactura[], idx: number): LineaFactura[] {
  if (lineas.length <= 1) return [emptyLinea()];
  return lineas.filter((_, i) => i !== idx);
}

export function lineasPayloadForApi(lineas: LineaFactura[]) {
  return lineas.map((l) => ({ ...l, ...calcularLinea(l) }));
}

export function totalesFromLineas(lineas: LineaFactura[]) {
  return calcularTotales(lineas);
}
