/**
 * Helpers puros para la conciliación interactiva albarán → factura (sesión).
 * La base imponible manda: albarán.total y factura.base (sin IVA).
 */

import type { AlbaranConciliado } from '../utils/facturacion';

export const UMBRAL_RESTO_BASE_EUR = 10;

/** albaranKey → id_factura */
export type AsignacionesSesion = Record<string, string>;

export type { AlbaranConciliado };

/** Datos mínimos de albarán para construir el body de persistencia. */
export type AlbaranDatosConciliacion = {
  key: string;
  serie: string;
  numero: string;
  fecha_albaran: string;
  base: number;
};

/** Resto base de una factura: base factura − Σ bases de albaranes asignados. */
export function restoFactura(baseFactura: number, basesAlbaranes: number[]): number {
  const suma = basesAlbaranes.reduce((acc, n) => acc + (Number(n) || 0), 0);
  return (Number(baseFactura) || 0) - suma;
}

export function restoOk(resto: number, umbral = UMBRAL_RESTO_BASE_EUR): boolean {
  return Math.abs(resto) <= umbral;
}

/** Verde si encaja en umbral; ámbar si desviación moderada; rojo si grande. */
export function colorRestoBase(resto: number, umbral = UMBRAL_RESTO_BASE_EUR): string {
  const abs = Math.abs(resto);
  if (abs <= umbral) return '#16a34a';
  if (abs <= umbral * 5) return '#d97706';
  return '#b91c1c';
}

/** Claves de albarán asignadas a una factura en la sesión. */
export function albaranKeysDeFactura(asignaciones: AsignacionesSesion, facturaId: string): string[] {
  const keys: string[] = [];
  for (const [albKey, fid] of Object.entries(asignaciones)) {
    if (fid === facturaId) keys.push(albKey);
  }
  return keys;
}

/** Quita del mapa todas las asignaciones de una factura. */
export function limpiarAsignacionesDeFactura(
  asignaciones: AsignacionesSesion,
  facturaId: string,
): AsignacionesSesion {
  let changed = false;
  const next: AsignacionesSesion = {};
  for (const [k, fid] of Object.entries(asignaciones)) {
    if (fid === facturaId) {
      changed = true;
      continue;
    }
    next[k] = fid;
  }
  return changed ? next : asignaciones;
}

/** serie/numero desde key `serie\u0001numero`. */
export function serieNumeroDesdeKey(key: string): { serie: string; numero: string } {
  const i = key.indexOf('\u0001');
  if (i < 0) return { serie: '', numero: String(key || '') };
  return { serie: key.slice(0, i), numero: key.slice(i + 1) };
}

type FacturaParaHidratar = {
  id_factura: string;
  estado?: string;
  albaranes_conciliados?: AlbaranConciliado[] | null;
};

/**
 * Construye albaranKey → id_factura desde `albaranes_conciliados` de todas las facturas.
 * Si un key aparece en dos facturas: preferir `pendiente_revision`; si empatan, `asignado_en` más reciente.
 */
export function hidratarAsignacionesDesdeFacturas(facturas: FacturaParaHidratar[]): AsignacionesSesion {
  type Cand = { facturaId: string; pteRevision: boolean; asignadoEn: string };
  const best = new Map<string, Cand>();

  for (const f of facturas) {
    const id = String(f.id_factura || '').trim();
    if (!id) continue;
    const estado = String(f.estado ?? '');
    const pteRevision = estado === 'pendiente_revision';
    const items = Array.isArray(f.albaranes_conciliados) ? f.albaranes_conciliados : [];
    for (const item of items) {
      const key = String(item?.key ?? '').trim();
      if (!key) continue;
      const cand: Cand = {
        facturaId: id,
        pteRevision,
        asignadoEn: String(item.asignado_en ?? ''),
      };
      const prev = best.get(key);
      if (!prev) {
        best.set(key, cand);
        continue;
      }
      if (cand.pteRevision && !prev.pteRevision) {
        best.set(key, cand);
      } else if (cand.pteRevision === prev.pteRevision) {
        if (cand.asignadoEn > prev.asignadoEn) best.set(key, cand);
      }
    }
  }

  const out: AsignacionesSesion = {};
  for (const [k, v] of best) out[k] = v.facturaId;
  return out;
}

type FacturaMetaConciliacion = {
  id_factura: string;
  numero_factura: string;
  fecha_factura: string;
  /** Items ya persistidos (para conservar asignado_en/por). */
  existentes?: AlbaranConciliado[] | null;
};

/**
 * Array completo de albaranes conciliados para una factura a partir del mapa de sesión.
 */
export function buildAlbaranesConciliadosParaFactura(
  facturaId: string,
  asignaciones: AsignacionesSesion,
  albaranesByKey: Map<string, AlbaranDatosConciliacion>,
  factura: FacturaMetaConciliacion,
  usuario?: { id?: string; nombre?: string },
): AlbaranConciliado[] {
  const keys = albaranKeysDeFactura(asignaciones, facturaId);
  const existentesPorKey = new Map<string, AlbaranConciliado>();
  for (const it of factura.existentes ?? []) {
    if (it?.key) existentesPorKey.set(it.key, it);
  }
  const ahora = new Date().toISOString();
  const items: AlbaranConciliado[] = [];

  for (const key of keys) {
    const datos = albaranesByKey.get(key);
    const prev = existentesPorKey.get(key);
    const sn = datos
      ? { serie: datos.serie, numero: datos.numero }
      : prev
        ? { serie: prev.serie, numero: prev.numero }
        : serieNumeroDesdeKey(key);

    items.push({
      key,
      serie: sn.serie,
      numero: sn.numero,
      fecha_albaran: datos?.fecha_albaran || prev?.fecha_albaran || '',
      base: datos?.base ?? prev?.base ?? 0,
      id_factura: factura.id_factura || facturaId,
      numero_factura: factura.numero_factura,
      fecha_factura: factura.fecha_factura,
      asignado_en: prev?.asignado_en || ahora,
      asignado_por: prev?.asignado_por || usuario?.nombre || '',
      asignado_por_id: prev?.asignado_por_id || usuario?.id || '',
    });
  }
  return items;
}

/** Estado visual del chip de factura en el comparador. */
export type ChipConciliacionTone = 'validada' | 'con_asignacion' | 'normal';

export function toneChipFacturaConciliacion(
  estado: string,
  numAsignaciones: number,
): ChipConciliacionTone {
  const e = String(estado || '').toLowerCase();
  if (e && e !== 'pendiente_revision' && e !== 'anulada' && e !== 'borrador') {
    return 'validada';
  }
  if (e === 'pendiente_revision' && numAsignaciones > 0) return 'con_asignacion';
  return 'normal';
}
