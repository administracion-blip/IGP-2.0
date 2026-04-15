import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  useWindowDimensions,
  Modal,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type CompraLinea = {
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

const COLUMNAS: { key: keyof CompraLinea | 'AlbaranRef'; label: string; width: number; align?: 'right' | 'center' }[] = [
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

function fechaLineaISO(item: CompraLinea): string {
  const s = (item.AlbaranFecha || '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function albaranKey(item: CompraLinea): string {
  return `${String(item.AlbaranSerie ?? '')}\u0001${String(item.AlbaranNumero ?? '')}`;
}

function albaranLabel(item: CompraLinea): string {
  const s = String(item.AlbaranSerie ?? '').trim();
  const n = String(item.AlbaranNumero ?? '').trim();
  if (!s && !n) return '—';
  return `${s}-${n}`;
}

function idNorm(id: string | undefined): string {
  const t = (id ?? '').toString().trim();
  return t || '__sin_id__';
}

function toggleInList(list: string[], id: string): string[] {
  if (list.includes(id)) return list.filter((x) => x !== id);
  return [...list, id];
}

/** Devuelve yyyy-mm-dd o null si el texto no es una fecha válida dd/mm/yyyy */
function parseDdMmYyyyToIso(s: string): string | null {
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

type OpcionFiltro = { id: string; label: string };

type FiltroDropdownKey = 'alb' | 'prod' | 'prov' | 'fam' | 'alm';

function ComprasFiltroDropdown({
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

export default function ComprasProveedorScreen() {
  const router = useRouter();
  const { width: winWidth } = useWindowDimensions();

  const [items, setItems] = useState<CompraLinea[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [lastLoad, setLastLoad] = useState<Date | null>(null);
  const [modalFiltrosVisible, setModalFiltrosVisible] = useState(false);
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [selAlbaranes, setSelAlbaranes] = useState<string[]>([]);
  const [selProductos, setSelProductos] = useState<string[]>([]);
  const [selProveedores, setSelProveedores] = useState<string[]>([]);
  const [selFamilias, setSelFamilias] = useState<string[]>([]);
  const [selAlmacenes, setSelAlmacenes] = useState<string[]>([]);
  const [filtroDropdownId, setFiltroDropdownId] = useState<FiltroDropdownKey | null>(null);

  const cargarDatos = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/agora/purchases`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al cargar datos');
      setItems(data.items || []);
      setLastLoad(new Date());
    } catch (err: any) {
      setError(err.message || 'Error de conexión');
    } finally {
      setLoading(false);
    }
  }, []);

  const sincronizar = useCallback(async (fullSync = false) => {
    setSyncing(true);
    setSyncResult('');
    try {
      const bodyPayload: Record<string, string> = {};
      if (fullSync) bodyPayload.dateFrom = '2025-01-01';
      const res = await fetch(`${API_URL}/api/agora/purchases/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al sincronizar');
      setSyncResult(
        `Sincronizado: ${data.totalUpserted ?? 0} líneas (${data.dateFrom} → ${data.dateTo}, ${data.daysProcessed ?? 0} días)` +
        (data.errors?.length ? ` · ${data.errors.length} errores` : '')
      );
      await cargarDatos();
    } catch (err: any) {
      setSyncResult(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }, [cargarDatos]);

  useEffect(() => {
    cargarDatos();
  }, [cargarDatos]);

  const opcionesFiltros = useMemo(() => {
    const albaranes = new Map<string, string>();
    const productos = new Map<string, string>();
    const proveedores = new Map<string, string>();
    const familias = new Map<string, string>();
    const almacenes = new Map<string, string>();
    items.forEach((it) => {
      const ak = albaranKey(it);
      if (!albaranes.has(ak)) albaranes.set(ak, albaranLabel(it));
      const pid = idNorm(it.ProductId as string);
      const plab = (it.ProductName || it.ProductId || '—').toString();
      if (!productos.has(pid)) productos.set(pid, plab);
      const sid = idNorm(it.SupplierId as string);
      const slab = (it.SupplierName || it.SupplierId || '—').toString();
      if (!proveedores.has(sid)) proveedores.set(sid, slab);
      const fid = idNorm(it.FamilyId as string);
      const flab = (it.FamilyName || it.FamilyId || '—').toString();
      if (!familias.has(fid)) familias.set(fid, flab);
      const wid = idNorm(it.WarehouseId as string);
      const wlab = (it.WarehouseName || it.WarehouseId || '—').toString();
      if (!almacenes.has(wid)) almacenes.set(wid, wlab);
    });
    const sortOpt = (a: OpcionFiltro, b: OpcionFiltro) => a.label.localeCompare(b.label, 'es');
    return {
      albaranes: Array.from(albaranes.entries()).map(([id, label]) => ({ id, label })).sort(sortOpt),
      productos: Array.from(productos.entries()).map(([id, label]) => ({ id, label })).sort(sortOpt),
      proveedores: Array.from(proveedores.entries()).map(([id, label]) => ({ id, label })).sort(sortOpt),
      familias: Array.from(familias.entries()).map(([id, label]) => ({ id, label })).sort(sortOpt),
      almacenes: Array.from(almacenes.entries()).map(([id, label]) => ({ id, label })).sort(sortOpt),
    };
  }, [items]);

  const filtrados = useMemo(() => {
    let list = items;
    const isoDesde = parseDdMmYyyyToIso(fechaDesde);
    const isoHasta = parseDdMmYyyyToIso(fechaHasta);
    if (isoDesde) {
      list = list.filter((it) => {
        const f = fechaLineaISO(it);
        return !f || f >= isoDesde;
      });
    }
    if (isoHasta) {
      list = list.filter((it) => {
        const f = fechaLineaISO(it);
        return !f || f <= isoHasta;
      });
    }
    if (selAlbaranes.length > 0) {
      const setA = new Set(selAlbaranes);
      list = list.filter((it) => setA.has(albaranKey(it)));
    }
    if (selProductos.length > 0) {
      const setP = new Set(selProductos);
      list = list.filter((it) => setP.has(idNorm(it.ProductId as string)));
    }
    if (selProveedores.length > 0) {
      const setS = new Set(selProveedores);
      list = list.filter((it) => setS.has(idNorm(it.SupplierId as string)));
    }
    if (selFamilias.length > 0) {
      const setF = new Set(selFamilias);
      list = list.filter((it) => setF.has(idNorm(it.FamilyId as string)));
    }
    if (selAlmacenes.length > 0) {
      const setW = new Set(selAlmacenes);
      list = list.filter((it) => setW.has(idNorm(it.WarehouseId as string)));
    }
    if (!busqueda.trim()) return list;
    const q = busqueda.trim().toLowerCase();
    return list.filter((item) =>
      (item.ProductName || '').toLowerCase().includes(q) ||
      (item.ProductId || '').toLowerCase().includes(q) ||
      (item.SupplierName || '').toLowerCase().includes(q) ||
      (item.AlbaranNumero || '').toLowerCase().includes(q) ||
      (item.FamilyName || '').toLowerCase().includes(q) ||
      (item.WarehouseName || '').toLowerCase().includes(q) ||
      (item.AlbaranSerie || '').toLowerCase().includes(q)
    );
  }, [
    items,
    busqueda,
    fechaDesde,
    fechaHasta,
    selAlbaranes,
    selProductos,
    selProveedores,
    selFamilias,
    selAlmacenes,
  ]);

  const filtrosActivosCount = useMemo(() => {
    let n = 0;
    if (parseDdMmYyyyToIso(fechaDesde)) n += 1;
    if (parseDdMmYyyyToIso(fechaHasta)) n += 1;
    n += selAlbaranes.length + selProductos.length + selProveedores.length + selFamilias.length + selAlmacenes.length;
    return n;
  }, [fechaDesde, fechaHasta, selAlbaranes, selProductos, selProveedores, selFamilias, selAlmacenes]);

  const limpiarFiltrosAvanzados = useCallback(() => {
    setFechaDesde('');
    setFechaHasta('');
    setSelAlbaranes([]);
    setSelProductos([]);
    setSelProveedores([]);
    setSelFamilias([]);
    setSelAlmacenes([]);
    setFiltroDropdownId(null);
  }, []);

  const PAGE_SIZE = 100;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(filtrados.length / PAGE_SIZE));
  const paginados = useMemo(
    () => filtrados.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filtrados, page]
  );

  useEffect(() => {
    setPage(0);
  }, [busqueda, fechaDesde, fechaHasta, selAlbaranes, selProductos, selProveedores, selFamilias, selAlmacenes]);

  const totalWidth = COLUMNAS.reduce((s, c) => s + c.width, 0);

  const getCellValue = (item: CompraLinea, col: typeof COLUMNAS[number]) => {
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
    const val = (item as any)[col.key];
    return val != null ? String(val) : '';
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>Compras a Proveedor</Text>
          <Text style={styles.headerSubtitle}>
            {items.length} líneas
            {lastLoad ? ` · Última carga: ${lastLoad.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </Text>
        </View>
      </View>

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <View style={styles.toolbarLeft}>
          <View style={styles.searchWrap}>
            <MaterialIcons name="search" size={18} color="#94a3b8" />
            <TextInput
              style={styles.searchInput}
              value={busqueda}
              onChangeText={setBusqueda}
              placeholder="Buscar producto, proveedor, albarán…"
              placeholderTextColor="#94a3b8"
            />
            {busqueda.length > 0 && (
              <TouchableOpacity onPress={() => setBusqueda('')} hitSlop={8}>
                <MaterialIcons name="close" size={16} color="#94a3b8" />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={[styles.filtrosBtn, filtrosActivosCount > 0 && styles.filtrosBtnActive]}
            onPress={() => {
              setFiltroDropdownId(null);
              setModalFiltrosVisible(true);
            }}
            activeOpacity={0.75}
          >
            <MaterialIcons name="filter-list" size={20} color={filtrosActivosCount > 0 ? '#fff' : '#0ea5e9'} />
            <Text style={[styles.filtrosBtnText, filtrosActivosCount > 0 && styles.filtrosBtnTextActive]}>
              Filtros{filtrosActivosCount > 0 ? ` (${filtrosActivosCount})` : ''}
            </Text>
          </TouchableOpacity>
          <Text style={styles.resultCount}>
            {filtrados.length !== items.length ? `${filtrados.length} de ` : ''}{items.length} registros
          </Text>
        </View>
        <View style={styles.toolbarRight}>
          <TouchableOpacity style={styles.reloadBtn} onPress={cargarDatos} disabled={loading}>
            {loading ? (
              <ActivityIndicator size="small" color="#0ea5e9" />
            ) : (
              <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
            )}
            <Text style={styles.reloadBtnText}>Recargar</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.syncBtn} onPress={() => sincronizar(false)} disabled={syncing}>
            {syncing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialIcons name="sync" size={20} color="#fff" />
            )}
            <Text style={styles.syncBtnText}>{syncing ? 'Sincronizando…' : 'Sincronizar (60 días)'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.syncFullBtn} onPress={() => sincronizar(true)} disabled={syncing}>
            <MaterialIcons name="cloud-download" size={18} color="#0ea5e9" />
            <Text style={styles.syncFullBtnText}>Sync completo</Text>
          </TouchableOpacity>
        </View>
      </View>

      {syncResult ? (
        <View style={[styles.syncResultBar, syncResult.startsWith('Error') && styles.syncResultBarError]}>
          <MaterialIcons name={syncResult.startsWith('Error') ? 'error-outline' : 'check-circle'} size={16} color={syncResult.startsWith('Error') ? '#dc2626' : '#16a34a'} />
          <Text style={[styles.syncResultText, syncResult.startsWith('Error') && styles.syncResultTextError]}>{syncResult}</Text>
          <TouchableOpacity onPress={() => setSyncResult('')} hitSlop={8}>
            <MaterialIcons name="close" size={14} color="#94a3b8" />
          </TouchableOpacity>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBar}>
          <MaterialIcons name="error-outline" size={16} color="#dc2626" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Modal visible={modalFiltrosVisible} transparent animationType="fade" onRequestClose={() => setModalFiltrosVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setModalFiltrosVisible(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalFiltrosWrap}>
            <View style={styles.modalFiltrosCard}>
              <View style={styles.modalFiltrosHeader}>
                <Text style={styles.modalFiltrosTitle}>Filtros</Text>
                <TouchableOpacity onPress={() => setModalFiltrosVisible(false)} hitSlop={8}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <ScrollView
                style={styles.modalFiltrosScroll}
                contentContainerStyle={styles.modalFiltrosScrollContent}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
              >
                <Text style={styles.modalFiltrosSectionTitle}>Rango de fechas (albarán)</Text>
                <Text style={styles.modalFiltrosHint}>
                  Formato dd/mm/aaaa. Deja vacío un extremo para no acotar por ese lado. Solo se filtra si la fecha es válida.
                </Text>
                <View style={styles.modalFiltrosFechasRow}>
                  <View style={styles.modalFiltrosFechaField}>
                    <Text style={styles.modalFiltrosLabel}>Desde</Text>
                    <TextInput
                      style={styles.modalFiltrosInput}
                      value={fechaDesde}
                      onChangeText={setFechaDesde}
                      placeholder="01/01/2026"
                      placeholderTextColor="#94a3b8"
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType={Platform.OS === 'web' ? 'default' : 'numbers-and-punctuation'}
                    />
                  </View>
                  <View style={styles.modalFiltrosFechaField}>
                    <Text style={styles.modalFiltrosLabel}>Hasta</Text>
                    <TextInput
                      style={styles.modalFiltrosInput}
                      value={fechaHasta}
                      onChangeText={setFechaHasta}
                      placeholder="31/12/2026"
                      placeholderTextColor="#94a3b8"
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType={Platform.OS === 'web' ? 'default' : 'numbers-and-punctuation'}
                    />
                  </View>
                </View>

                {(
                  [
                    { key: 'alb' as const, title: 'Albarán', opts: opcionesFiltros.albaranes, sel: selAlbaranes, setSel: setSelAlbaranes },
                    { key: 'prod' as const, title: 'Producto', opts: opcionesFiltros.productos, sel: selProductos, setSel: setSelProductos },
                    { key: 'prov' as const, title: 'Proveedor', opts: opcionesFiltros.proveedores, sel: selProveedores, setSel: setSelProveedores },
                    { key: 'fam' as const, title: 'Familia', opts: opcionesFiltros.familias, sel: selFamilias, setSel: setSelFamilias },
                    { key: 'alm' as const, title: 'Almacén', opts: opcionesFiltros.almacenes, sel: selAlmacenes, setSel: setSelAlmacenes },
                  ] as const
                ).map((sec) => (
                  <ComprasFiltroDropdown
                    key={sec.key}
                    title={sec.title}
                    options={sec.opts}
                    value={sec.sel}
                    onToggleId={(id) => sec.setSel((p) => toggleInList(p, id))}
                    fieldKey={sec.key}
                    openKey={filtroDropdownId}
                    setOpenKey={setFiltroDropdownId}
                  />
                ))}
              </ScrollView>
              <View style={styles.modalFiltrosFooter}>
                <TouchableOpacity style={styles.modalFiltrosLimpiar} onPress={limpiarFiltrosAvanzados}>
                  <Text style={styles.modalFiltrosLimpiarText}>Limpiar filtros</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalFiltrosCerrar} onPress={() => setModalFiltrosVisible(false)}>
                  <Text style={styles.modalFiltrosCerrarText}>Listo</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Table */}
      <ScrollView style={styles.tableWrap} horizontal>
        <View style={{ minWidth: Math.max(totalWidth, winWidth - 40) }}>
          {/* Table Header */}
          <View style={styles.tableHeader}>
            {COLUMNAS.map((col) => (
              <View key={col.key} style={[styles.thCell, { width: col.width }]}>
                <Text style={[styles.thText, col.align === 'right' && styles.textRight, col.align === 'center' && styles.textCenter]} numberOfLines={1}>
                  {col.label}
                </Text>
              </View>
            ))}
          </View>

          {/* Table Body */}
          <ScrollView style={styles.tableBody}>
            {loading && items.length === 0 ? (
              <View style={styles.emptyWrap}>
                <ActivityIndicator size="large" color="#0ea5e9" />
                <Text style={styles.emptyText}>Cargando datos…</Text>
              </View>
            ) : paginados.length === 0 ? (
              <View style={styles.emptyWrap}>
                <MaterialIcons name="inbox" size={48} color="#cbd5e1" />
                <Text style={styles.emptyText}>
                  {items.length === 0
                    ? 'No hay datos. Pulsa "Sincronizar Ágora" para importar albaranes de entrada.'
                    : filtrosActivosCount > 0 || busqueda.trim()
                      ? 'Sin resultados con los filtros o la búsqueda actuales.'
                      : 'Sin resultados para la búsqueda.'}
                </Text>
              </View>
            ) : (
              paginados.map((item, rowIdx) => (
                <View key={`${item.PK}-${item.SK}`} style={[styles.row, rowIdx % 2 === 1 && styles.rowAlt]}>
                  {COLUMNAS.map((col) => (
                    <View key={col.key} style={[styles.cell, { width: col.width }]}>
                      <Text
                        style={[styles.cellText, col.align === 'right' && styles.textRight, col.align === 'center' && styles.textCenter]}
                        numberOfLines={1}
                      >
                        {getCellValue(item, col)}
                      </Text>
                    </View>
                  ))}
                </View>
              ))
            )}
          </ScrollView>

          {/* Pagination */}
          {totalPages > 1 && (
            <View style={styles.pagination}>
              <TouchableOpacity onPress={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={styles.pageBtn}>
                <MaterialIcons name="chevron-left" size={20} color={page === 0 ? '#cbd5e1' : '#0ea5e9'} />
              </TouchableOpacity>
              <Text style={styles.pageText}>
                Pág. {page + 1} de {totalPages}
              </Text>
              <TouchableOpacity onPress={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={styles.pageBtn}>
                <MaterialIcons name="chevron-right" size={20} color={page >= totalPages - 1 ? '#cbd5e1' : '#0ea5e9'} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0', gap: 10 },
  backBtn: { padding: 4 },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  headerSubtitle: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, gap: 12, flexWrap: 'wrap' },
  toolbarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 200 },
  toolbarRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, gap: 6, flex: 1, maxWidth: 400 },
  searchInput: { flex: 1, fontSize: 13, color: '#334155', outlineStyle: 'none' as any },
  resultCount: { fontSize: 12, color: '#94a3b8', flexShrink: 0 },
  reloadBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  reloadBtnText: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  syncBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#0ea5e9' },
  syncBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  syncFullBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  syncFullBtnText: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
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
