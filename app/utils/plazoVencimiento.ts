/**
 * Plazo de vencimiento de proveedor: días desde la fecha de factura (0 = contado).
 * Maestro `igp_Empresas.Vencimiento` (Number; registros antiguos en texto libre)
 * y `condiciones_pago` de factura ('contado' | '<n> días').
 */
import { hoyMadridIso } from '../lib/deudaProveedores';

export { hoyMadridIso };

export const PLAZO_MAX_DIAS = 365;

export const PLAZOS_VENCIMIENTO = [0, 15, 30, 45, 60, 90, 120] as const;

/** Misma regla que el backend: mantener ambas en sincronía. */
const RE_CONTADO = /^(?:al\s+)?contado$/;
const RE_DIAS = /^(\d{1,3})(?:d|_dias|\s+dias?(?:\s+(?:fecha\s+factura|f\.f\.|ff))?)?$/;

/** Días de plazo (0..365) o `null` si vacío / no reconocido. */
export function parseDiasPlazo(valor: unknown): number | null {
  if (typeof valor === 'number') {
    return Number.isInteger(valor) && valor >= 0 && valor <= PLAZO_MAX_DIAS ? valor : null;
  }
  if (typeof valor !== 'string') return null;
  const s = valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (RE_CONTADO.test(s)) return 0;
  const m = s.match(RE_DIAS);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= PLAZO_MAX_DIAS ? n : null;
}

/** Valor de `condiciones_pago` para un plazo: 'contado' o '<n> días'. */
export function condicionesDesdeDias(n: number): string {
  return n === 0 ? 'contado' : `${n} días`;
}

/** Etiqueta visible del plazo ('Contado', '30 días'). */
export function etiquetaPlazo(n: number): string {
  if (n === 0) return 'Contado';
  return n === 1 ? '1 día' : `${n} días`;
}

function isoAUtcMs(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '').trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : ms;
}

const MS_DIA = 86_400_000;

/** Fecha emisión + días (UTC, sin desfases horarios) → 'YYYY-MM-DD' o '' si no se puede calcular. */
export function calcularFechaVencimiento(fechaEmisionIso: string, dias: number | null | undefined): string {
  if (dias == null || !Number.isFinite(dias)) return '';
  const base = isoAUtcMs(fechaEmisionIso);
  if (base == null) return '';
  return new Date(base + dias * MS_DIA).toISOString().slice(0, 10);
}

/** Días desde `hoyIso` hasta el vencimiento (negativo = vencida). `null` si alguna fecha no es válida. */
export function diasHastaVencimiento(vencIso: string, hoyIso: string = hoyMadridIso()): number | null {
  const v = isoAUtcMs(vencIso);
  const h = isoAUtcMs(hoyIso);
  if (v == null || h == null) return null;
  return Math.round((v - h) / MS_DIA);
}

export const COLOR_VENCIDA = '#dc2626';
export const COLOR_VENCE_PRONTO = '#d97706';
export const COLOR_VENCE_GRIS = '#64748b';
/** Días hasta vencer a partir de los cuales deja de avisarse en ámbar. */
export const DIAS_AVISO_VENCIMIENTO = 7;

export type EstadoRelativoVencimiento = {
  dias: number;
  tipo: 'vencida' | 'hoy' | 'pronto' | 'futura';
  color: string;
};

/** Clasifica el vencimiento respecto a hoy (fecha natural Madrid). */
export function estadoRelativoVencimiento(
  vencIso: string,
  hoyIso: string = hoyMadridIso(),
): EstadoRelativoVencimiento | null {
  const dias = diasHastaVencimiento(vencIso, hoyIso);
  if (dias == null) return null;
  if (dias < 0) return { dias, tipo: 'vencida', color: COLOR_VENCIDA };
  if (dias === 0) return { dias, tipo: 'hoy', color: COLOR_VENCE_PRONTO };
  if (dias <= DIAS_AVISO_VENCIMIENTO) return { dias, tipo: 'pronto', color: COLOR_VENCE_PRONTO };
  return { dias, tipo: 'futura', color: COLOR_VENCE_GRIS };
}

function nDias(n: number): string {
  return n === 1 ? '1 día' : `${n} días`;
}

/** 'Vencida hace 12 días' · 'Vence hoy' · 'Vence en 3 días'. */
export function textoEstadoVencimiento(e: EstadoRelativoVencimiento): string {
  if (e.tipo === 'vencida') return `Vencida hace ${nDias(-e.dias)}`;
  if (e.tipo === 'hoy') return 'Vence hoy';
  return `Vence en ${nDias(e.dias)}`;
}

/** Versión corta para celdas: 'hace 12 días' · 'hoy' · 'en 3 días'. */
export function textoCortoEstadoVencimiento(e: EstadoRelativoVencimiento): string {
  if (e.tipo === 'vencida') return `hace ${nDias(-e.dias)}`;
  if (e.tipo === 'hoy') return 'hoy';
  return `en ${nDias(e.dias)}`;
}
