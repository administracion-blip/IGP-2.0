/**
 * Helpers puros del subdominio "registro masivo de facturas".
 *
 * Toda la lógica fiscal (recálculo de importes, desglose multitranco)
 * y formateo (color de confianza, ISO→dmy, label de método de extracción)
 * vive aquí en funciones puras. Los hooks y componentes del subdominio
 * importan desde aquí; el archivo principal `registro-masivo.tsx` no
 * mantiene ya estas funciones.
 */

import { round2 } from '../utils/facturacion';
import { fechaEmisionFacturaAIso } from '../utils/formatFecha';
import type { Borrador, LineaDesglose } from '../types/registroMasivo';

/**
 * Color del dot de confianza OCR según el nivel reportado por el API:
 * verde para 'alta', ámbar para 'media', rojo para cualquier otro caso.
 */
export function confColor(level: string): string {
  if (level === 'alta') return '#059669';
  if (level === 'media') return '#b45309';
  return '#dc2626';
}

/** Convierte una fecha ISO `YYYY-MM-DD...` a `dd/mm/yyyy` para mostrar al usuario. */
export function isoToDmy(iso: string): string {
  if (!iso || iso.length < 10) return iso || '';
  const [y, m, d] = iso.substring(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** Etiqueta legible del método de extracción reportado por el pipeline OCR. */
export function metodoExtraccionLabel(m: string | undefined): string {
  if (!m) return '';
  if (m === 'pdf_text') return 'Texto embebido (PDF)';
  if (m === 'image_ocr') return 'OCR (imagen)';
  if (m === 'pdf_ocr_fallback') return 'OCR (PDF escaneado, pág. 1)';
  return m;
}

/**
 * `true` si el desglose tiene varios tramos (más de una línea, retención,
 * recargo de equivalencia, o un total de R.E. > 0). En ese caso no tiene
 * sentido derivar un único `tipo_iva_pct` global y se trabaja por líneas.
 */
export function esDesgloseMulti(b: {
  desglose_impuestos?: LineaDesglose[];
  recargo_equivalencia_total?: number;
}): boolean {
  const arr = Array.isArray(b.desglose_impuestos) ? b.desglose_impuestos : [];
  if (arr.length > 1) return true;
  if (arr.some((x) => x.tipo === 'retencion' || x.tipo === 'recargo_equivalencia')) return true;
  if ((Number(b.recargo_equivalencia_total) || 0) > 0) return true;
  return false;
}

/**
 * Deriva el % de IVA y el % de retención a partir de los importes ya
 * calculados (base, total_iva, retención). Si hay desglose múltiple,
 * devuelve `null` para no forzar un único valor inexacto.
 */
export function derivarPctDesdeImportes(
  base: number,
  total_iva: number,
  retencion: number,
  meta?: { desglose_impuestos?: LineaDesglose[]; recargo_equivalencia_total?: number },
): { tipo_iva_pct: number | null; retencion_pct: number | null } {
  if (meta && esDesgloseMulti(meta)) {
    return { tipo_iva_pct: null, retencion_pct: null };
  }
  if (base <= 0) return { tipo_iva_pct: 21, retencion_pct: 0 };
  return {
    tipo_iva_pct: round2((100 * total_iva) / base),
    retencion_pct: round2((100 * retencion) / base),
  };
}

/** Etiqueta legible del tipo de línea fiscal. */
export function labelTipoLinea(t: string): string {
  if (t === 'iva') return 'IVA';
  if (t === 'recargo_equivalencia') return 'Rec. equiv.';
  if (t === 'retencion') return 'Retención';
  return t;
}

/**
 * Recalcula importes (IVA, retención, total) coherentes con base y % indicados.
 * Si el borrador tiene desglose múltiple y los % están en `null`, se respeta
 * el estado actual sin recalcular (el desglose manda).
 */
export function recalcImportesDesdePct(b: Borrador): Borrador {
  if (esDesgloseMulti(b) && b.tipo_iva_pct == null && b.retencion_pct == null) return b;
  const base = round2(Number(b.base_imponible) || 0);
  const pctIva = Number(b.tipo_iva_pct) || 0;
  const pctRet = Number(b.retencion_pct) || 0;
  const total_iva = round2((base * pctIva) / 100);
  const retencion = round2((base * pctRet) / 100);
  const total_factura = round2(base + total_iva - retencion);
  return { ...b, base_imponible: base, total_iva, retencion, total_factura };
}

/**
 * Datos brutos devueltos por `POST /api/facturacion/ocr/reconciliar` en el
 * campo `datos`. Todos los campos son opcionales; el merge aplica solo los
 * que estén presentes y que el usuario no haya tocado a mano.
 */
export type ReconciliacionDatos = {
  warning?: string;
  proveedor_cif?: string;
  proveedor_nombre?: string;
  empresa_id?: string;
  proveedor_en_maestros?: boolean;
  nombre_sugerido_ocr?: string;
  numero_factura_proveedor?: string;
  fecha_emision?: string;
  base_imponible?: number;
  total_iva?: number;
  retencion?: number;
  total_factura?: number;
  base_imponible_total?: number;
  recargo_equivalencia_total?: number;
  confianza?: Record<string, string>;
};

/**
 * Aplica el resultado de `/ocr/reconciliar` sobre un borrador respetando
 * los campos que el usuario haya marcado como manuales (no se pisan).
 *
 * El desglose fiscal NO se fusiona aquí: una vez que la UI tiene líneas,
 * estas son siempre fuente de verdad y el usuario las edita a mano.
 *
 * Es función pura: no muta el borrador original; devuelve uno nuevo con
 * el merge aplicado y los % derivados / importes recalculados si procede.
 */
export function mergeReconciliacion(row: Borrador, d: ReconciliacionDatos): Borrador {
  const m = row.campos_manuales || {};
  let next: Borrador = {
    ...row,
    reconciliacion_warning: typeof d.warning === 'string' ? d.warning : '',
  };
  if (!m.proveedor_cif && d.proveedor_cif != null) next.proveedor_cif = String(d.proveedor_cif);
  if (!m.proveedor_nombre && d.proveedor_nombre != null) next.proveedor_nombre = String(d.proveedor_nombre);
  if (!m.proveedor_cif && !m.proveedor_nombre && d.empresa_id != null) next.empresa_id = String(d.empresa_id);
  if (!m.proveedor_cif && !m.proveedor_nombre && typeof d.proveedor_en_maestros === 'boolean') {
    next.proveedor_en_maestros = d.proveedor_en_maestros;
  }
  if (!m.proveedor_nombre && d.nombre_sugerido_ocr != null) next.nombre_sugerido_ocr = String(d.nombre_sugerido_ocr);
  if (!m.numero_factura_proveedor && d.numero_factura_proveedor != null) {
    next.numero_factura_proveedor = String(d.numero_factura_proveedor);
  }
  if (!m.fecha_emision && d.fecha_emision != null) {
    const raw = String(d.fecha_emision).trim();
    next.fecha_emision = fechaEmisionFacturaAIso(raw) ?? raw;
  }
  if (!m.base_imponible && d.base_imponible != null) next.base_imponible = Number(d.base_imponible);
  if (!m.total_iva && d.total_iva != null) next.total_iva = Number(d.total_iva);
  if (!m.retencion && d.retencion != null) next.retencion = Number(d.retencion);
  if (!m.total_factura && d.total_factura != null) next.total_factura = Number(d.total_factura);
  if (d.base_imponible_total != null) next.base_imponible_total = Number(d.base_imponible_total);
  if (d.recargo_equivalencia_total != null) next.recargo_equivalencia_total = Number(d.recargo_equivalencia_total);
  if (d.confianza && typeof d.confianza === 'object') next.confianza = { ...next.confianza, ...d.confianza };
  const pctR = derivarPctDesdeImportes(
    Number(next.base_imponible) || 0,
    Number(next.total_iva) || 0,
    Number(next.retencion) || 0,
    next,
  );
  if (!m.tipo_iva_pct) next.tipo_iva_pct = pctR.tipo_iva_pct;
  if (!m.retencion_pct) next.retencion_pct = pctR.retencion_pct;
  if ((m.tipo_iva_pct || m.retencion_pct) && !esDesgloseMulti(next)) {
    next = recalcImportesDesdePct(next);
  }
  return next;
}

/**
 * Totales que el desglose fiscal aporta a un borrador. Se aplican como
 * `Partial<Borrador>` (con `tipo_iva_pct` siempre a `null` porque las
 * líneas son la fuente de verdad cuando hay desglose).
 */
export type DesgloseTotales = Pick<
  Borrador,
  | 'base_imponible'
  | 'base_imponible_total'
  | 'total_iva'
  | 'retencion'
  | 'recargo_equivalencia_total'
  | 'tipo_iva_pct'
  | 'retencion_pct'
  | 'total_factura'
>;

/**
 * Suma cuotas y bases del array de líneas y devuelve los totales agregados.
 * Función pura sin dependencia del modelo `Borrador`: pensada para que el
 * componente `<DesgloseFiscalEditor>` pueda calcularlos sin acoplarse al
 * estado del padre.
 */
export function calcularTotalesDesdeDesglose(lineas: LineaDesglose[]): DesgloseTotales {
  let base = 0;
  let iva = 0;
  let ret = 0;
  for (const L of lineas) {
    const bv = round2(Number(L.base) || 0);
    const cv = round2(Number(L.cuota) || 0);
    if (L.tipo === 'iva') {
      base = round2(base + bv);
      iva = round2(iva + cv);
    } else if (L.tipo === 'retencion') {
      ret = round2(ret + cv);
    }
  }
  const total_factura = round2(base + iva - ret);
  return {
    base_imponible: base,
    base_imponible_total: base,
    total_iva: iva,
    retencion: ret,
    recargo_equivalencia_total: 0,
    tipo_iva_pct: null,
    retencion_pct: ret > 0 && base > 0 ? round2((100 * ret) / base) : 0,
    total_factura,
  };
}

/**
 * Versión orientada al borrador: aplica `calcularTotalesDesdeDesglose`
 * sobre `b.desglose_impuestos` y devuelve un nuevo borrador con los
 * totales actualizados. Se mantiene como conveniencia para el código
 * que aún trabaja con `Borrador` completo.
 */
export function recalcTotalesDesdeDesglose(b: Borrador): Borrador {
  const lineas = Array.isArray(b.desglose_impuestos) ? b.desglose_impuestos : [];
  return { ...b, ...calcularTotalesDesdeDesglose(lineas) };
}
