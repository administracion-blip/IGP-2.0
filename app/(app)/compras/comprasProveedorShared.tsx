import React, { useEffect, useState, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { CompraLinea, FiltroDropdownKey, OpcionFiltro } from '../../types/compras';
import type { GrupoFamilias } from '../../hooks/useGruposFamilias';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';

export type { CompraLinea, FiltroDropdownKey, OpcionFiltro };

/** Tamaño unificado de iconos en la toolbar compacta de compras. */
export const TOOLBAR_ICON_SIZE = 17;

const IS_WEB = Platform.OS === 'web';

export const COLUMNAS: { key: keyof CompraLinea | 'AlbaranRef'; label: string; width: number; align?: 'right' | 'center' }[] = [
  { key: 'AlbaranFecha', label: 'Fecha', width: 100 },
  { key: 'AlbaranRef', label: 'Albarán', width: 110 },
  { key: 'SupplierDocumentNumber', label: 'Nº doc. prov.', width: 130 },
  { key: 'SupplierName', label: 'Proveedor', width: 180 },
  { key: 'ProductName', label: 'Producto', width: 200 },
  { key: 'ProductId', label: 'ID Prod.', width: 80 },
  { key: 'Quantity', label: 'Cantidad', width: 80, align: 'right' },
  { key: 'PurchaseUnitName', label: 'Unidad', width: 80 },
  { key: 'Price', label: 'Precio', width: 90, align: 'right' },
  { key: 'DiscountRate', label: 'Dto. %', width: 70, align: 'right' },
  { key: 'TotalAmount', label: 'Total', width: 100, align: 'right' },
  { key: 'VatRate', label: 'IVA %', width: 70, align: 'right' },
  { key: 'FamilyName', label: 'Familia', width: 130 },
  { key: 'WarehouseName', label: 'Almacén', width: 130 },
  { key: 'Confirmed', label: 'Confirm.', width: 80, align: 'center' },
  { key: 'Invoiced', label: 'Facturado', width: 80, align: 'center' },
];

const COLUMNAS_CELDA_NEGRITA = new Set<string>(['SupplierDocumentNumber', 'Quantity']);

export function isCompraColNegrita(key: string): boolean {
  return COLUMNAS_CELDA_NEGRITA.has(key);
}

function formatFecha(iso: string): string {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatMoneda(n: number | null | undefined): string {
  if (n == null) return '';
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatPct(n: number | null | undefined): string {
  if (n == null || n === 0) return '';
  return (n * 100).toFixed(1) + '%';
}

export function getCompraCellValue(item: CompraLinea, col: (typeof COLUMNAS)[number]): string {
  if (col.key === 'AlbaranRef') return `${item.AlbaranSerie}-${item.AlbaranNumero}`;
  if (col.key === 'AlbaranFecha') return formatFecha(item.AlbaranFecha);
  if (col.key === 'Price' || col.key === 'TotalAmount' || col.key === 'CashDiscount') return formatMoneda(item[col.key] as number);
  if (col.key === 'DiscountRate' || col.key === 'VatRate' || col.key === 'SurchargeRate') return formatPct(item[col.key] as number);
  if (col.key === 'Quantity') {
    const v = item.Quantity;
    return v != null ? v.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 3 }) : '';
  }
  if (col.key === 'Confirmed') return item.Confirmed ? 'Sí' : 'No';
  if (col.key === 'Invoiced') return item.Invoiced ? 'Sí' : 'No';
  const val = (item as Record<string, unknown>)[col.key as string];
  return val != null ? String(val) : '';
}

export function fechaLineaISO(item: CompraLinea): string {
  const s = (item.AlbaranFecha || '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

export function albaranKey(item: CompraLinea): string {
  return `${String(item.AlbaranSerie ?? '')}\u0001${String(item.AlbaranNumero ?? '')}`;
}

export function albaranLabel(item: CompraLinea): string {
  const s = String(item.AlbaranSerie ?? '').trim();
  const n = String(item.AlbaranNumero ?? '').trim();
  if (!s && !n) return '—';
  return `${s}-${n}`;
}

export { normDocProveedor } from '../../utils/docProveedor';

/**
 * Etiqueta de albarán con el nº de documento del proveedor cuando existe
 * (`AC-5838 · an16048149`). Solo para desplegables de listado: en conciliación
 * y resumen el nº de documento ya se pinta aparte.
 */
export function albaranLabelConDoc(item: CompraLinea): string {
  const base = albaranLabel(item);
  const doc = String(item.SupplierDocumentNumber ?? '').trim();
  return doc ? `${base} · ${doc}` : base;
}

export function idNorm(id: string | undefined): string {
  const t = (id ?? '').toString().trim();
  return t || '__sin_id__';
}

export function toggleInList(list: string[], id: string): string[] {
  if (list.includes(id)) return list.filter((x) => x !== id);
  return [...list, id];
}

/**
 * Alterna un grupo completo de ids en una lista: si todos los ids del grupo ya
 * están presentes, los quita; si no, añade los que falten. Permite combinar
 * varios grupos de familias sin perder lo ya seleccionado.
 */
export function toggleGrupoFamilias(current: string[], groupIds: string[]): string[] {
  if (groupIds.length === 0) return current;
  const set = new Set(current);
  const allPresent = groupIds.every((id) => set.has(id));
  if (allPresent) groupIds.forEach((id) => set.delete(id));
  else groupIds.forEach((id) => set.add(id));
  return Array.from(set);
}

/** Devuelve yyyy-mm-dd o null si el texto no es una fecha válida dd/mm/yyyy */
export function parseDdMmYyyyToIso(s: string): string | null {
  const t = s.trim().replace(/\s/g, '');
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const yyyy = parseInt(m[3], 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(yyyy, mm - 1, dd);
  if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** True si la línea `a` es más reciente que `b` (fecha albarán, syncedAt, albarán, SK). */
export function isCompraLineaNewer(a: CompraLinea, b: CompraLinea): boolean {
  const fa = fechaLineaISO(a);
  const fb = fechaLineaISO(b);
  if (fa && fb) {
    if (fa !== fb) return fa > fb;
  } else if (fa && !fb) return true;
  else if (!fa && fb) return false;
  else {
    const sa = a.syncedAt ? Date.parse(a.syncedAt) : 0;
    const sb = b.syncedAt ? Date.parse(b.syncedAt) : 0;
    if (sa !== sb) return sa > sb;
  }
  const ak = albaranKey(a).localeCompare(albaranKey(b), 'es');
  if (ak !== 0) return ak > 0;
  return String(a.SK ?? '') > String(b.SK ?? '');
}

/** Una fila por ProductId: la compra más reciente según fecha de albarán (y desempates). */
export function ultimaCompraPorProducto(items: CompraLinea[]): CompraLinea[] {
  const map = new Map<string, CompraLinea>();
  for (const it of items) {
    const pid = idNorm(it.ProductId as string);
    const cur = map.get(pid);
    if (!cur) {
      map.set(pid, it);
      continue;
    }
    if (isCompraLineaNewer(it, cur)) map.set(pid, it);
  }
  return Array.from(map.values());
}

/** Normaliza la unidad de compra para agrupar (minúsculas y sin espacios sobrantes). */
export function normUnidad(u: string | null | undefined): string {
  return (u ?? '').toString().trim().toLowerCase();
}

/** Precio neto unitario realmente pagado: precio bruto menos el descuento de línea. */
export function precioNetoUnitario(it: CompraLinea): number {
  const p = Number(it.Price);
  const d = Number(it.DiscountRate);
  const precio = Number.isNaN(p) ? 0 : p;
  const dto = Number.isNaN(d) ? 0 : d;
  return precio * (1 - dto);
}

/**
 * Línea de última compra enriquecida con la variación de precio neto respecto a
 * la compra inmediatamente anterior del MISMO producto y MISMA unidad de compra.
 */
export type CompraConVariacion = CompraLinea & {
  _precioActual: number;
  _precioAnterior: number | null;
  _fechaAnterior: string | null;
  _deltaAbs: number | null;
  _deltaPct: number | null;
};

/**
 * Una fila por (ProductId + unidad de compra): la última compra de ese formato,
 * con la variación de precio neto frente a la compra anterior del mismo formato.
 * Agrupar por unidad evita comparar formatos distintos (p. ej. caja vs kg) y
 * que una subida quede oculta al cambiar de formato en la última compra.
 */
export function ultimaCompraConVariacionPorUnidad(items: CompraLinea[]): CompraConVariacion[] {
  const grupos = new Map<string, CompraLinea[]>();
  for (const it of items) {
    const key = `${idNorm(it.ProductId as string)}\u0001${normUnidad(it.PurchaseUnitName)}`;
    const arr = grupos.get(key);
    if (arr) arr.push(it);
    else grupos.set(key, [it]);
  }
  const out: CompraConVariacion[] = [];
  for (const lineas of grupos.values()) {
    let ultima: CompraLinea | null = null;
    let anterior: CompraLinea | null = null;
    for (const it of lineas) {
      if (!ultima || isCompraLineaNewer(it, ultima)) {
        anterior = ultima;
        ultima = it;
      } else if (!anterior || isCompraLineaNewer(it, anterior)) {
        anterior = it;
      }
    }
    if (!ultima) continue;
    const pNew = precioNetoUnitario(ultima);
    const pOld = anterior ? precioNetoUnitario(anterior) : null;
    const deltaAbs = pOld != null ? pNew - pOld : null;
    const deltaPct = pOld != null && pOld !== 0 ? (pNew - pOld) / pOld : null;
    out.push({
      ...(ultima as CompraLinea),
      _precioActual: pNew,
      _precioAnterior: pOld,
      _fechaAnterior: anterior ? fechaLineaISO(anterior) : null,
      _deltaAbs: deltaAbs,
      _deltaPct: deltaPct,
    });
  }
  return out;
}

const MESES_ABREV = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "2026-02-12" → "feb 2026". Cadena vacía si no hay fecha válida. */
export function formatMesAnio(iso: string | null | undefined): string {
  const m = (iso || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return '';
  const mes = parseInt(m[2], 10);
  if (mes < 1 || mes > 12) return '';
  return `${MESES_ABREV[mes - 1]} ${m[1]}`;
}

/** Clasificación + texto de la variación de precio para pintar el badge/Excel. */
export function variacionInfo(item: CompraConVariacion): {
  kind: 'up' | 'down' | 'flat' | 'none';
  pctText: string;
  fechaCambio: string;
} {
  const d = item._deltaPct;
  if (d == null) return { kind: 'none', pctText: '—', fechaCambio: '' };
  const pct = d * 100;
  const kind = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
  const sign = kind === 'up' ? '+' : kind === 'down' ? '−' : '';
  const pctText = `${sign}${Math.abs(pct).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  return { kind, pctText, fechaCambio: formatMesAnio(fechaLineaISO(item)) };
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;
/** Entre radius.lg (12) y radius.xl (16). */
const RADIO_TARJETA = 14;

export const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
    gap: 10,
  },
  backBtn: {
    width: 36,
    height: 36,
    padding: 0,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontSize: fontSizes[20], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, lineHeight: 26, color: colors.textStrong },
  headerSubtitle: { fontSize: fontSizes[12], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textMuted, marginTop: 2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.md, paddingVertical: 6, gap: SPACING.sm, flexWrap: 'wrap' },
  toolbarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 200 },
  toolbarRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, flexShrink: 1 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
    flex: 1,
    maxWidth: 400,
  },
  searchInput: { flex: 1, fontSize: fontSizes[12], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textPrimary },
  resultCount: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, flexShrink: 0 },
  /** Resumen Σ cantidad / Σ importe cuando hay búsqueda o filtros (solo compras a proveedor). */
  toolbarResumenFiltrados: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: SPACING.md,
    paddingVertical: 5,
    backgroundColor: statusColors.warning.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  toolbarResumenFiltradosText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: '#78350f', lineHeight: 16 },
  toolbarResumenFiltradosStrong: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  reloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: 6,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  exportExcelBtnDisabled: { borderColor: colors.border, backgroundColor: colors.bg },
  reloadBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  exportExcelBtnTextDisabled: { color: colors.borderStrong },
  syncBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingVertical: 6, paddingHorizontal: SPACING.md, borderRadius: RADIO_MEDIO, backgroundColor: colors.accent },
  syncBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  syncFullBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  syncFullBtnText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  navSecondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  navSecondaryBtnText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  syncResultBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: SPACING.xs,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    backgroundColor: statusColors.success.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  syncResultBarError: { backgroundColor: statusColors.danger.bg, borderColor: colors.border },
  syncResultText: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.success },
  syncResultTextError: { color: colors.danger },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: SPACING.xs,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    backgroundColor: statusColors.danger.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  errorText: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger },
  tableWrap: { flex: 1 },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
  },
  thCell: { paddingHorizontal: 6 },
  thText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, lineHeight: 14, letterSpacing: 0.1, color: colors.textMuted },
  tableBody: { flex: 1 },
  row: {
    flexDirection: 'row',
    minHeight: 40,
    paddingVertical: 6,
    paddingHorizontal: SPACING.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowAlt: { backgroundColor: colors.bg },
  cell: { paddingHorizontal: 6, justifyContent: 'center' },
  cellText: { fontSize: fontSizes[12], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, lineHeight: 16, color: colors.textPrimary },
  cellTextBold: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  textRight: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  textCenter: { textAlign: 'center' },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: SPACING.md },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center', maxWidth: 360 },
  pagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.sm,
    gap: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  pageBtn: { padding: SPACING.xs },
  pageText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  filtrosBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexShrink: 0,
  },
  filtrosBtnActive: { backgroundColor: colors.accentMuted, borderColor: colors.accentMuted },
  filtrosBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  filtrosBtnTextActive: { color: statusColors.info.text },
  /** Contenedor icono + tooltip (web hover). */
  toolbarBtnWrap: {
    position: 'relative' as const,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible' as const,
  },
  /** Tooltip oscuro al pasar el ratón (solo web), mismo cromado que TablaBasica. */
  toolbarTooltip: {
    position: 'absolute',
    bottom: '100%',
    alignSelf: 'center',
    marginBottom: SPACING.xs,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.textPrimary,
    maxWidth: 280,
    zIndex: 1000,
    ...(IS_WEB && { boxShadow: '0 1px 4px rgba(0,0,0,0.1)' } as object),
  },
  toolbarTooltipText: { fontSize: typography.etiqueta.fontSize, color: colors.bg, lineHeight: 15, fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, textAlign: 'center' },
  toolbarIconBtn: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  toolbarIconBtnOutline: {
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  toolbarIconBtnOutlineDisabled: {
    borderColor: colors.border,
    backgroundColor: colors.surface,
    opacity: 0.85,
  },
  toolbarIconBtnPrimary: {
    backgroundColor: colors.accent,
    borderColor: colors.accentPressed,
  },
  toolbarIconBtnPrimaryDisabled: {
    opacity: 0.65,
  },
  toolbarIconBtnNeutral: {
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filtrosIconBtn: {
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filtrosIconBtnActive: {
    backgroundColor: colors.accentMuted,
    borderColor: colors.accentMuted,
  },
  filtrosBadge: {
    position: 'absolute',
    top: -5,
    right: -7,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filtrosBadgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface, lineHeight: 12 },
  iconBtnInner: { position: 'relative' as const, alignItems: 'center', justifyContent: 'center' },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    padding: 16,
  },
  modalFiltrosWrap: { width: '100%', maxWidth: 520, maxHeight: '88%' as const },
  modalFiltrosCard: {
    width: '100%',
    maxHeight: '100%',
    backgroundColor: colors.surface,
    borderRadius: RADIO_TARJETA,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalFiltrosHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  modalFiltrosTitle: {
    fontSize: 17, // entre fontSizes[16] y [18]
    fontFamily: fontFamily.semibold,
    fontWeight: typography.boton.fontWeight,
    color: colors.textStrong,
  },
  modalFiltrosScroll: { maxHeight: 420 },
  modalFiltrosScrollContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: SPACING.sm },
  modalFiltrosSectionTitle: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, marginBottom: 6 },
  modalFiltrosHint: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginBottom: 10, lineHeight: 16 },
  modalFiltrosFechasRow: { flexDirection: 'row', gap: SPACING.md, marginBottom: 16 },
  modalFiltrosFechaField: { flex: 1, minWidth: 0 },
  modalFiltrosLabel: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, marginBottom: SPACING.xs },
  modalFiltrosInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: SPACING.sm,
    fontFamily: fontFamily.regular, fontSize: fontSizes[14],
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  modalFiltrosBlock: { marginBottom: 18, paddingBottom: SPACING.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    backgroundColor: colors.surface,
  },
  dropdownTriggerText: { flex: 1, fontSize: fontSizes[13], color: colors.textPrimary, fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight },
  dropdownPanel: {
    marginTop: 6,
    maxHeight: 220,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
  },
  dropdownRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dropdownRowOn: { backgroundColor: colors.accentMuted },
  dropdownRowText: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textPrimary },
  dropdownRowTextOn: { color: statusColors.info.text, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  dropdownSearch: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[12],
    fontWeight: typography.cuerpo.fontWeight,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  dropdownEmpty: { padding: SPACING.md, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, textAlign: 'center', fontStyle: 'italic' },
  dropdownMore: {
    padding: 10,
    fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize,
    color: colors.textPrimary,
    textAlign: 'center',
    fontStyle: 'italic',
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalFiltrosFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: SPACING.md,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  modalFiltrosLimpiar: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md },
  modalFiltrosLimpiarText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  modalFiltrosCerrar: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accent,
  },
  modalFiltrosCerrarText: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface },
  // --- Menú de sincronización (elegir rango de días) ---
  syncMenuWrap: { width: '100%', maxWidth: 360 },
  syncMenuCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: RADIO_TARJETA,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  syncMenuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  syncMenuTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong, flex: 1 },
  syncMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  syncMenuRowFull: { backgroundColor: colors.bg },
  syncMenuIconBox: {
    width: 34,
    height: 34,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncMenuRowTextWrap: { flex: 1, minWidth: 0 },
  syncMenuRowTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong },
  syncMenuRowSub: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginTop: 1 },
  syncMenuHint: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: statusColors.warning.bg,
  },
  syncMenuHintText: { flex: 1, fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: '#78350f', lineHeight: 15 },
  // --- Badge de variación de precio (vista última compra) ---
  variacionWrap: { alignItems: 'flex-end', justifyContent: 'center', gap: 1 },
  variacionCell: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2 },
  variacionText: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  variacionFecha: { fontSize: fontSizes.badge, color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  variacionUp: { color: colors.danger },
  variacionDown: { color: colors.success },
  variacionFlat: { color: colors.textMuted },
  variacionNone: { color: colors.borderStrong },
  // --- Botón "historial" en la fila + modal de historial de compras del producto ---
  histIconBtn: { padding: SPACING.xs, borderRadius: radius.sm },
  histModalWrap: { width: '100%', maxWidth: 640, maxHeight: '88%' as const },
  histModalSubtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: 2 },
  histChipsRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  histChip: {
    paddingVertical: 6,
    paddingHorizontal: SPACING.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  histChipActive: { backgroundColor: colors.accentMuted, borderColor: colors.accentMuted },
  histChipText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  histChipTextActive: { color: statusColors.info.text },
  histHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  histHeaderText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textMuted },
  histScroll: { maxHeight: 380 },
  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 40,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  histRowAlt: { backgroundColor: colors.bg },
  histColFecha: { width: 84, fontSize: fontSizes[12], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textPrimary },
  histColProv: { flex: 1, fontSize: fontSizes[12], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textPrimary, paddingRight: SPACING.sm },
  histColCant: { fontVariant: ['tabular-nums'], width: 92, fontSize: fontSizes[12], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textPrimary },
  histColPrecio: { fontVariant: ['tabular-nums'], width: 78, fontSize: fontSizes[12], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textPrimary, textAlign: 'right' },
  histColDelta: { width: 70, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 1 },
  histDeltaText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  histEmpty: { padding: SPACING.xl, fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, textAlign: 'center', fontStyle: 'italic' },
  // --- Grupos de familias personalizados (chips en el modal de filtros) ---
  grupoFamWrap: { marginBottom: 18, paddingBottom: SPACING.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  grupoFamHint: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginBottom: SPACING.sm, lineHeight: 15 },
  grupoFamChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, alignItems: 'center' },
  grupoFamChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  grupoFamChipActive: { backgroundColor: colors.accentMuted, borderColor: colors.accentMuted },
  grupoFamChipText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  grupoFamChipTextActive: { color: statusColors.info.text },
  grupoFamChipDelete: { padding: 2, borderRadius: RADIO_MEDIO },
  grupoFamAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  grupoFamAddBtnDisabled: { borderColor: colors.border, backgroundColor: colors.bg },
  grupoFamAddText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  grupoFamAddTextDisabled: { color: colors.borderStrong },
  grupoFamCrearRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: SPACING.sm },
  grupoFamInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: SPACING.sm,
    fontFamily: fontFamily.regular, fontSize: fontSizes[13],
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  grupoFamCrearBtn: { paddingVertical: SPACING.sm, paddingHorizontal: 14, borderRadius: RADIO_MEDIO, backgroundColor: colors.accent },
  grupoFamCrearBtnDisabled: { backgroundColor: colors.borderStrong },
  grupoFamCrearBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface },
  grupoFamCancelarBtn: { paddingVertical: SPACING.sm, paddingHorizontal: 10 },
  grupoFamCancelarText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  grupoFamVacio: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, fontStyle: 'italic' },
});

type ToolbarIconVariant = 'outline' | 'primary' | 'neutral';

/** Botón compacto solo icono; en web muestra tooltip al pasar el ratón. */
export function ComprasToolbarIconBtn({
  tooltip,
  onPress,
  disabled,
  accessibilityLabel,
  variant = 'outline',
  children,
}: {
  tooltip: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
  variant?: ToolbarIconVariant;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const showTip = IS_WEB && hover && tooltip.length > 0;

  const variantStyles: object[] = [styles.toolbarIconBtn];
  if (variant === 'primary') {
    variantStyles.push(styles.toolbarIconBtnPrimary);
    if (disabled) variantStyles.push(styles.toolbarIconBtnPrimaryDisabled);
  } else if (variant === 'neutral') {
    variantStyles.push(styles.toolbarIconBtnNeutral);
  } else {
    variantStyles.push(styles.toolbarIconBtnOutline);
    if (disabled) variantStyles.push(styles.toolbarIconBtnOutlineDisabled);
  }

  return (
    <View
      style={styles.toolbarBtnWrap}
      {...(IS_WEB
        ? ({
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
          } as object)
        : {})}
    >
      {showTip ? (
        <View style={styles.toolbarTooltip} pointerEvents="none">
          <Text style={styles.toolbarTooltipText}>{tooltip}</Text>
        </View>
      ) : null}
      <TouchableOpacity
        style={variantStyles}
        onPress={onPress}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={tooltip}
        activeOpacity={0.75}
      >
        {children}
      </TouchableOpacity>
    </View>
  );
}

/** Filtros: icono + badge con contador; tooltip describe filtros activos. */
export function ComprasToolbarFiltrosBtn({
  activeCount,
  onPress,
}: {
  activeCount: number;
  onPress: () => void;
}) {
  const [hover, setHover] = useState(false);
  const showTip = IS_WEB && hover;
  const tooltip =
    activeCount > 0 ? `Filtros (${activeCount} activos)` : 'Filtros avanzados (fechas, albarán, producto…)';

  return (
    <View
      style={styles.toolbarBtnWrap}
      {...(IS_WEB
        ? ({
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
          } as object)
        : {})}
    >
      {showTip ? (
        <View style={styles.toolbarTooltip} pointerEvents="none">
          <Text style={styles.toolbarTooltipText}>{tooltip}</Text>
        </View>
      ) : null}
      <TouchableOpacity
        style={[styles.toolbarIconBtn, styles.filtrosIconBtn, activeCount > 0 && styles.filtrosIconBtnActive]}
        onPress={onPress}
        accessibilityLabel={tooltip}
        activeOpacity={0.75}
      >
        <View style={styles.iconBtnInner}>
          <MaterialIcons
            name="filter-list"
            size={TOOLBAR_ICON_SIZE}
            color={activeCount > 0 ? statusColors.info.text : colors.textPrimary}
          />
          {activeCount > 0 ? (
            <View style={styles.filtrosBadge}>
              <Text style={styles.filtrosBadgeText}>{activeCount > 99 ? '99+' : String(activeCount)}</Text>
            </View>
          ) : null}
        </View>
      </TouchableOpacity>
    </View>
  );
}

/** Variante sync: icono o spinner; tooltip dinámico. */
export function ComprasToolbarSyncBtn({
  syncing,
  onPress,
  disabled,
}: {
  syncing: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  const tooltip = syncing ? 'Sincronizando con Ágora…' : 'Sincronizar con Ágora — elegir rango';
  return (
    <ComprasToolbarIconBtn
      tooltip={tooltip}
      onPress={onPress}
      disabled={Boolean(disabled) || syncing}
      accessibilityLabel={syncing ? 'Sincronizando' : 'Sincronizar con Ágora'}
      variant="primary"
    >
      {syncing ? (
        <ActivityIndicator size="small" color={colors.surface} />
      ) : (
        <MaterialIcons name="sync" size={TOOLBAR_ICON_SIZE} color={colors.surface} />
      )}
    </ComprasToolbarIconBtn>
  );
}

export function ComprasFiltroDropdown({
  title,
  options,
  value,
  onToggleId,
  fieldKey,
  openKey,
  setOpenKey,
}: {
  title: string;
  options: OpcionFiltro[];
  value: string[];
  onToggleId: (id: string) => void;
  fieldKey: FiltroDropdownKey;
  openKey: FiltroDropdownKey | null;
  setOpenKey: (k: FiltroDropdownKey | null) => void;
}) {
  const open = openKey === fieldKey;
  const [searchQ, setSearchQ] = useState('');
  const prevOpen = useRef(open);
  useEffect(() => {
    if (!open && prevOpen.current) setSearchQ('');
    prevOpen.current = open;
  }, [open]);

  const MAX_VISIBLE = 80;
  const filtered = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    const selectedSet = new Set(value);
    const selectedFirst: OpcionFiltro[] = [];
    const rest: OpcionFiltro[] = [];
    const base = q
      ? options.filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q))
      : options;
    base.forEach((o) => {
      if (selectedSet.has(o.id)) selectedFirst.push(o);
      else rest.push(o);
    });
    return { selected: selectedFirst, rest, totalMatches: base.length };
  }, [options, searchQ, value]);

  const visibleRest = filtered.rest.slice(0, MAX_VISIBLE - filtered.selected.length);
  const visibleAll = [...filtered.selected, ...visibleRest];
  const hiddenCount = filtered.totalMatches - visibleAll.length;

  const summary =
    value.length === 0
      ? `Elegir… (${options.length} opciones)`
      : `${value.length} seleccionado${value.length === 1 ? '' : 's'}`;
  return (
    <View style={styles.modalFiltrosBlock}>
      <Text style={styles.modalFiltrosSectionTitle}>{title}</Text>
      <TouchableOpacity
        style={styles.dropdownTrigger}
        onPress={() => setOpenKey(open ? null : fieldKey)}
        activeOpacity={0.75}
      >
        <Text style={styles.dropdownTriggerText} numberOfLines={1}>
          {summary}
        </Text>
        <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={22} color={colors.textMuted} />
      </TouchableOpacity>
      {open ? (
        <>
          <TextInput
            style={styles.dropdownSearch}
            value={searchQ}
            onChangeText={setSearchQ}
            placeholder={`Buscar en ${title.toLowerCase()}…`}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ScrollView style={styles.dropdownPanel} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {visibleAll.length === 0 ? (
              <Text style={styles.dropdownEmpty}>Sin coincidencias</Text>
            ) : (
              visibleAll.map((o) => {
                const active = value.includes(o.id);
                return (
                  <TouchableOpacity
                    key={o.id}
                    style={[styles.dropdownRow, active && styles.dropdownRowOn]}
                    onPress={() => onToggleId(o.id)}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name={active ? 'check-box' : 'check-box-outline-blank'} size={20} color={active ? colors.accent : colors.textMuted} />
                    <Text style={[styles.dropdownRowText, active && styles.dropdownRowTextOn]} numberOfLines={3}>
                      {o.label}
                    </Text>
                  </TouchableOpacity>
                );
              })
            )}
            {hiddenCount > 0 ? (
              <Text style={styles.dropdownMore}>
                +{hiddenCount} opciones más. Escribe para acotar.
              </Text>
            ) : null}
          </ScrollView>
        </>
      ) : null}
    </View>
  );
}

/**
 * Chips de grupos de familias personalizados. Cada chip aplica/alterna sus
 * familias sobre la selección actual. El botón "Guardar grupo" crea un grupo
 * con las familias que el usuario tenga marcadas en ese momento.
 */
export function GruposFamiliasChips({
  grupos,
  familiasSeleccionadas,
  onToggleGrupo,
  onCrearGrupo,
  onBorrarGrupo,
}: {
  grupos: GrupoFamilias[];
  familiasSeleccionadas: string[];
  onToggleGrupo: (familiaIds: string[]) => void;
  onCrearGrupo: (nombre: string) => void;
  onBorrarGrupo: (id: string) => void;
}) {
  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState('');
  const puedeGuardar = familiasSeleccionadas.length > 0;

  const confirmar = () => {
    if (!nombre.trim()) return;
    onCrearGrupo(nombre);
    setNombre('');
    setCreando(false);
  };

  return (
    <View style={styles.grupoFamWrap}>
      <Text style={styles.modalFiltrosSectionTitle}>Grupos de familias</Text>
      <Text style={styles.grupoFamHint}>
        Toca un grupo para aplicar sus familias de una vez. Para crear uno nuevo, marca familias abajo y pulsa «Guardar grupo».
      </Text>
      <View style={styles.grupoFamChipsRow}>
        {grupos.length === 0 ? (
          <Text style={styles.grupoFamVacio}>Sin grupos guardados todavía.</Text>
        ) : (
          grupos.map((g) => {
            const activo =
              g.familiaIds.length > 0 && g.familiaIds.every((id) => familiasSeleccionadas.includes(id));
            return (
              <View key={g.id} style={[styles.grupoFamChip, activo && styles.grupoFamChipActive]}>
                <TouchableOpacity onPress={() => onToggleGrupo(g.familiaIds)} activeOpacity={0.7}>
                  <Text style={[styles.grupoFamChipText, activo && styles.grupoFamChipTextActive]}>
                    {g.nombre} ({g.familiaIds.length})
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.grupoFamChipDelete}
                  onPress={() => onBorrarGrupo(g.id)}
                  hitSlop={6}
                  accessibilityLabel={`Borrar grupo ${g.nombre}`}
                >
                  <MaterialIcons name="close" size={14} color={activo ? statusColors.info.text : colors.textMuted} />
                </TouchableOpacity>
              </View>
            );
          })
        )}
        {!creando ? (
          <TouchableOpacity
            style={[styles.grupoFamAddBtn, !puedeGuardar && styles.grupoFamAddBtnDisabled]}
            onPress={() => puedeGuardar && setCreando(true)}
            disabled={!puedeGuardar}
            activeOpacity={0.7}
          >
            <MaterialIcons name="add" size={16} color={puedeGuardar ? colors.accent : colors.borderStrong} />
            <Text style={[styles.grupoFamAddText, !puedeGuardar && styles.grupoFamAddTextDisabled]}>
              Guardar grupo
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {creando ? (
        <View style={styles.grupoFamCrearRow}>
          <TextInput
            style={styles.grupoFamInput}
            value={nombre}
            onChangeText={setNombre}
            placeholder={`Nombre del grupo (${familiasSeleccionadas.length} familias)`}
            placeholderTextColor={colors.textMuted}
            autoFocus
            onSubmitEditing={confirmar}
            autoCapitalize="sentences"
          />
          <TouchableOpacity
            style={[styles.grupoFamCrearBtn, !nombre.trim() && styles.grupoFamCrearBtnDisabled]}
            onPress={confirmar}
            disabled={!nombre.trim()}
          >
            <Text style={styles.grupoFamCrearBtnText}>Guardar</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.grupoFamCancelarBtn}
            onPress={() => {
              setCreando(false);
              setNombre('');
            }}
          >
            <Text style={styles.grupoFamCancelarText}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}
