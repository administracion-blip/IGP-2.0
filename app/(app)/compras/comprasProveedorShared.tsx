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

/** Tamaño unificado de iconos en la toolbar compacta de compras. */
export const TOOLBAR_ICON_SIZE = 17;

const IS_WEB = Platform.OS === 'web';

export type CompraLinea = {
  PK: string;
  SK: string;
  AlbaranSerie: string;
  AlbaranNumero: string;
  AlbaranFecha: string;
  SupplierDocumentNumber: string;
  Confirmed: boolean;
  Invoiced: boolean;
  SupplierId: string;
  SupplierName: string;
  SupplierCif: string;
  WarehouseId: string;
  WarehouseName: string;
  LineIndex: number;
  ProductId: string;
  ProductName: string;
  Quantity: number;
  Price: number;
  DiscountRate: number;
  CashDiscount: number;
  TotalAmount: number;
  VatRate: number;
  SurchargeRate: number;
  PurchaseUnitName: string;
  FamilyId: string;
  FamilyName: string;
  LotNumber: string;
  LineNotes: string;
  syncedAt: string;
};

export const COLUMNAS: { key: keyof CompraLinea | 'AlbaranRef'; label: string; width: number; align?: 'right' | 'center' }[] = [
  { key: 'AlbaranFecha', label: 'Fecha', width: 100 },
  { key: 'AlbaranRef', label: 'Albarán', width: 110 },
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

export function idNorm(id: string | undefined): string {
  const t = (id ?? '').toString().trim();
  return t || '__sin_id__';
}

export function toggleInList(list: string[], id: string): string[] {
  if (list.includes(id)) return list.filter((x) => x !== id);
  return [...list, id];
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

export type OpcionFiltro = { id: string; label: string };

export type FiltroDropdownKey = 'alb' | 'prod' | 'prov' | 'fam' | 'alm';

export const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0', gap: 10 },
  backBtn: { padding: 4 },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  headerSubtitle: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 6, gap: 8, flexWrap: 'wrap' },
  toolbarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 200 },
  toolbarRight: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, gap: 6, flex: 1, maxWidth: 400 },
  searchInput: { flex: 1, fontSize: 13, color: '#334155', outlineStyle: 'none' as any },
  resultCount: { fontSize: 12, color: '#94a3b8', flexShrink: 0 },
  /** Resumen Σ cantidad / Σ importe cuando hay búsqueda o filtros (solo compras a proveedor). */
  toolbarResumenFiltrados: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: '#fffbeb',
    borderBottomWidth: 1,
    borderBottomColor: '#fde68a',
  },
  toolbarResumenFiltradosText: { fontSize: 11, color: '#78350f', lineHeight: 16 },
  toolbarResumenFiltradosStrong: { fontWeight: '700', color: '#0f172a' },
  reloadBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  exportExcelBtnDisabled: { borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  reloadBtnText: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  exportExcelBtnTextDisabled: { color: '#cbd5e1' },
  syncBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#0ea5e9' },
  syncBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  syncFullBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  syncFullBtnText: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  navSecondaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#94a3b8', backgroundColor: '#f8fafc' },
  navSecondaryBtnText: { fontSize: 12, fontWeight: '600', color: '#475569' },
  syncResultBar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 16, marginBottom: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0' },
  syncResultBarError: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  syncResultText: { flex: 1, fontSize: 12, color: '#16a34a' },
  syncResultTextError: { color: '#dc2626' },
  errorBar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 16, marginBottom: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fecaca' },
  errorText: { flex: 1, fontSize: 12, color: '#dc2626' },
  tableWrap: { flex: 1 },
  tableHeader: { flexDirection: 'row', borderBottomWidth: 2, borderBottomColor: '#e2e8f0', backgroundColor: '#f8fafc', paddingVertical: 8, paddingHorizontal: 8 },
  thCell: { paddingHorizontal: 6 },
  thText: { fontSize: 12, fontWeight: '700', color: '#475569' },
  tableBody: { flex: 1 },
  row: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  rowAlt: { backgroundColor: '#fafbfc' },
  cell: { paddingHorizontal: 6, justifyContent: 'center' },
  cellText: { fontSize: 12, color: '#334155' },
  textRight: { textAlign: 'right' },
  textCenter: { textAlign: 'center' },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center', maxWidth: 360 },
  pagination: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, gap: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  pageBtn: { padding: 4 },
  pageText: { fontSize: 12, color: '#64748b' },
  filtrosBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    backgroundColor: '#f0f9ff',
    flexShrink: 0,
  },
  filtrosBtnActive: { backgroundColor: '#0ea5e9', borderColor: '#0284c7' },
  filtrosBtnText: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  filtrosBtnTextActive: { color: '#fff' },
  /** Contenedor icono + tooltip (web hover). */
  toolbarBtnWrap: {
    position: 'relative' as const,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible' as const,
  },
  /** Etiqueta amarilla al pasar el ratón (solo web). */
  toolbarTooltip: {
    position: 'absolute',
    bottom: '100%',
    alignSelf: 'center',
    marginBottom: 4,
    backgroundColor: '#fef9c3',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#fde047',
    maxWidth: 280,
    zIndex: 1000,
    ...(IS_WEB && { boxShadow: '0 1px 4px rgba(0,0,0,0.1)' } as object),
  },
  toolbarTooltipText: { fontSize: 11, color: '#713f12', lineHeight: 15, fontWeight: '500', textAlign: 'center' },
  toolbarIconBtn: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
  },
  toolbarIconBtnOutline: {
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
  },
  toolbarIconBtnOutlineDisabled: {
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    opacity: 0.85,
  },
  toolbarIconBtnPrimary: {
    backgroundColor: '#0ea5e9',
    borderColor: '#0284c7',
  },
  toolbarIconBtnPrimaryDisabled: {
    opacity: 0.65,
  },
  toolbarIconBtnNeutral: {
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
  },
  filtrosIconBtn: {
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
  },
  filtrosIconBtnActive: {
    backgroundColor: '#0ea5e9',
    borderColor: '#0284c7',
  },
  filtrosBadge: {
    position: 'absolute',
    top: -5,
    right: -7,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filtrosBadgeText: { fontSize: 9, fontWeight: '700', color: '#fff', lineHeight: 12 },
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
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  modalFiltrosHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  modalFiltrosTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a' },
  modalFiltrosScroll: { maxHeight: 420 },
  modalFiltrosScrollContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  modalFiltrosSectionTitle: { fontSize: 13, fontWeight: '700', color: '#334155', marginBottom: 6 },
  modalFiltrosHint: { fontSize: 11, color: '#94a3b8', marginBottom: 10, lineHeight: 16 },
  modalFiltrosFechasRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  modalFiltrosFechaField: { flex: 1, minWidth: 0 },
  modalFiltrosLabel: { fontSize: 11, fontWeight: '600', color: '#64748b', marginBottom: 4 },
  modalFiltrosInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#334155',
    backgroundColor: '#fff',
  },
  modalFiltrosBlock: { marginBottom: 18, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  dropdownTriggerText: { flex: 1, fontSize: 13, color: '#334155', fontWeight: '500' },
  dropdownPanel: {
    marginTop: 6,
    maxHeight: 220,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#fafafa',
  },
  dropdownRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  dropdownRowOn: { backgroundColor: '#f0f9ff' },
  dropdownRowText: { flex: 1, fontSize: 12, color: '#475569' },
  dropdownRowTextOn: { color: '#0c4a6e', fontWeight: '600' },
  dropdownSearch: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  dropdownEmpty: { padding: 12, fontSize: 12, color: '#94a3b8', textAlign: 'center', fontStyle: 'italic' },
  dropdownMore: { padding: 10, fontSize: 11, color: '#64748b', textAlign: 'center', fontStyle: 'italic', backgroundColor: '#f8fafc', borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  modalFiltrosFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#fafafa',
  },
  modalFiltrosLimpiar: { paddingVertical: 8, paddingHorizontal: 12 },
  modalFiltrosLimpiarText: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  modalFiltrosCerrar: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  modalFiltrosCerrarText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});

type ToolbarIconVariant = 'outline' | 'primary' | 'neutral';

/** Botón compacto solo icono; en web muestra tooltip amarillo al pasar el ratón. */
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
            color={activeCount > 0 ? '#fff' : '#0ea5e9'}
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
  const tooltip = syncing ? 'Sincronizando con Ágora…' : 'Sincronizar últimos 60 días desde Ágora';
  return (
    <ComprasToolbarIconBtn
      tooltip={tooltip}
      onPress={onPress}
      disabled={Boolean(disabled) || syncing}
      accessibilityLabel={syncing ? 'Sincronizando' : 'Sincronizar 60 días'}
      variant="primary"
    >
      {syncing ? (
        <ActivityIndicator size="small" color="#fff" />
      ) : (
        <MaterialIcons name="sync" size={TOOLBAR_ICON_SIZE} color="#fff" />
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
        <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={22} color="#64748b" />
      </TouchableOpacity>
      {open ? (
        <>
          <TextInput
            style={styles.dropdownSearch}
            value={searchQ}
            onChangeText={setSearchQ}
            placeholder={`Buscar en ${title.toLowerCase()}…`}
            placeholderTextColor="#94a3b8"
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
                    <MaterialIcons name={active ? 'check-box' : 'check-box-outline-blank'} size={20} color={active ? '#0ea5e9' : '#94a3b8'} />
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
