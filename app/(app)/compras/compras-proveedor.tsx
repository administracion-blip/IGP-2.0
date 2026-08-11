import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
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
import * as XLSX from 'xlsx';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { InputFecha } from '../../components/InputFecha';
import { useComprasProveedorCache } from '../../contexts/ComprasProveedorCache';
import {
  CompraLinea,
  COLUMNAS,
  getCompraCellValue,
  fechaLineaISO,
  albaranKey,
  albaranLabel,
  idNorm,
  toggleInList,
  toggleGrupoFamilias,
  ComprasFiltroDropdown,
  GruposFamiliasChips,
  FiltroDropdownKey,
  OpcionFiltro,
  styles,
  TOOLBAR_ICON_SIZE,
  ComprasToolbarIconBtn,
  ComprasToolbarFiltrosBtn,
  ComprasToolbarSyncBtn,
} from './comprasProveedorShared';
import { apiFetch } from '../../utils/api';
import { useGruposFamilias } from '../../hooks/useGruposFamilias';
import { useAuth } from '../../contexts/AuthContext';
import {
  DIAS_CARGA_COMPRAS,
  rangoApiDesdeFiltroFechas,
  rangoComprasDefault,
} from '../../lib/comprasProveedorRango';

type SyncOpcion = number | 'completo';

const OPCIONES_SYNC: { id: SyncOpcion; titulo: string; subtitulo: string; icono: React.ComponentProps<typeof MaterialIcons>['name'] }[] = [
  { id: 20, titulo: 'Últimos 20 días', subtitulo: 'Rápida — uso habitual', icono: 'bolt' },
  { id: 60, titulo: 'Últimos 60 días', subtitulo: 'Recomendada', icono: 'sync' },
  { id: 90, titulo: 'Últimos 90 días', subtitulo: 'Trimestre', icono: 'history' },
  { id: 120, titulo: 'Últimos 120 días', subtitulo: 'Rango amplio (más lenta)', icono: 'date-range' },
  { id: 'completo', titulo: 'Sincronización completa', subtitulo: 'Desde 2025-01-01 (puede tardar varios minutos)', icono: 'cloud-download' },
];

export default function ComprasProveedorScreen() {
  const router = useRouter();
  const { width: winWidth } = useWindowDimensions();

  const { compras: items, loading, error, lastFetch, rangoCargado, recargar } = useComprasProveedorCache();

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState('');
  const [menuSyncVisible, setMenuSyncVisible] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [modalFiltrosVisible, setModalFiltrosVisible] = useState(false);
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [selAlbaranes, setSelAlbaranes] = useState<string[]>([]);
  const [selProductos, setSelProductos] = useState<string[]>([]);
  const [selProveedores, setSelProveedores] = useState<string[]>([]);
  const [selFamilias, setSelFamilias] = useState<string[]>([]);
  const [selAlmacenes, setSelAlmacenes] = useState<string[]>([]);
  const [filtroDropdownId, setFiltroDropdownId] = useState<FiltroDropdownKey | null>(null);
  const { grupos, crearGrupo, borrarGrupo } = useGruposFamilias();
  const { hasPermiso } = useAuth();
  const puedeInformeIa = hasPermiso('ia.informes') && hasPermiso('ia.informe_compras');

  /** Clave del filtro de fechas ya pedido a la API (evita refetch al cerrar el modal sin cambios). */
  const filtroFechasApiKeyRef = useRef('|');

  const aplicarCargaPorFiltroFechas = useCallback(
    async (desde: string, hasta: string) => {
      const key = `${(desde || '').trim()}|${(hasta || '').trim()}`;
      if (filtroFechasApiKeyRef.current === key) return;
      const { dateFrom, dateTo } = rangoApiDesdeFiltroFechas(desde, hasta);
      const result = await recargar({ dateFrom, dateTo, force: true });
      // ok = cargado; skipped = encolado tras la carga en curso (el cache lo ejecuta al terminar).
      if (result.ok || result.skipped) filtroFechasApiKeyRef.current = key;
    },
    [recargar],
  );

  const cerrarModalFiltros = useCallback(() => {
    setModalFiltrosVisible(false);
    setFiltroDropdownId(null);
    void aplicarCargaPorFiltroFechas(fechaDesde, fechaHasta);
  }, [aplicarCargaPorFiltroFechas, fechaDesde, fechaHasta]);

  const sincronizar = useCallback(async (opcion: SyncOpcion) => {
    setMenuSyncVisible(false);
    setSyncing(true);
    setSyncResult('');
    try {
      const bodyPayload: Record<string, string> = {};
      if (opcion === 'completo') {
        bodyPayload.dateFrom = '2025-01-01';
      } else {
        bodyPayload.dateFrom = new Date(Date.now() - opcion * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
      }
      const res = await apiFetch('/api/agora/purchases/sync', {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
        timeoutMs: 0,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al sincronizar');
      setSyncResult(
        `Sincronizado: ${data.totalUpserted ?? 0} líneas (${data.dateFrom} → ${data.dateTo}, ${data.daysProcessed ?? 0} días)` +
        (data.errors?.length ? ` · ${data.errors.length} errores` : '')
      );
      const { dateFrom, dateTo } = rangoApiDesdeFiltroFechas(fechaDesde, fechaHasta);
      filtroFechasApiKeyRef.current = `${fechaDesde.trim()}|${fechaHasta.trim()}`;
      await recargar({ dateFrom, dateTo, force: true });
    } catch (err: any) {
      setSyncResult(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }, [recargar, fechaDesde, fechaHasta]);

  useEffect(() => {
    const { dateFrom, dateTo } = rangoComprasDefault(DIAS_CARGA_COMPRAS);
    recargar({ dateFrom, dateTo });
  }, [recargar]);

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
    const isoDesde = /^\d{4}-\d{2}-\d{2}$/.test(fechaDesde.trim()) ? fechaDesde.trim() : null;
    const isoHasta = /^\d{4}-\d{2}-\d{2}$/.test(fechaHasta.trim()) ? fechaHasta.trim() : null;
    if (isoDesde) {
      list = list.filter((it) => {
        const f = fechaLineaISO(it);
        return f !== '' && f >= isoDesde;
      });
    }
    if (isoHasta) {
      list = list.filter((it) => {
        const f = fechaLineaISO(it);
        return f !== '' && f <= isoHasta;
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
    if (/^\d{4}-\d{2}-\d{2}$/.test(fechaDesde.trim())) n += 1;
    if (/^\d{4}-\d{2}-\d{2}$/.test(fechaHasta.trim())) n += 1;
    n += selAlbaranes.length + selProductos.length + selProveedores.length + selFamilias.length + selAlmacenes.length;
    return n;
  }, [fechaDesde, fechaHasta, selAlbaranes, selProductos, selProveedores, selFamilias, selAlmacenes]);

  const hayBusquedaOFiltros = busqueda.trim().length > 0 || filtrosActivosCount > 0;

  const totalesFiltrados = useMemo(() => {
    let sumCant = 0;
    let sumImporte = 0;
    filtrados.forEach((it) => {
      const q = Number(it.Quantity);
      if (!Number.isNaN(q)) sumCant += q;
      const t = Number(it.TotalAmount);
      if (!Number.isNaN(t)) sumImporte += t;
    });
    return { sumCant, sumImporte };
  }, [filtrados]);

  const limpiarFiltrosAvanzados = useCallback(() => {
    setFechaDesde('');
    setFechaHasta('');
    setSelAlbaranes([]);
    setSelProductos([]);
    setSelProveedores([]);
    setSelFamilias([]);
    setSelAlmacenes([]);
    setFiltroDropdownId(null);
    aplicarCargaPorFiltroFechas('', '');
  }, [aplicarCargaPorFiltroFechas]);

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

  useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1);
  }, [totalPages, page]);

  const totalWidth = COLUMNAS.reduce((s, c) => s + c.width, 0);

  const exportarExcel = useCallback(() => {
    if (filtrados.length === 0) return;
    const headers = COLUMNAS.map((c) => c.label);
    const rows = filtrados.map((item) => COLUMNAS.map((col) => getCompraCellValue(item, col)));
    const data: string[][] = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Compras');
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `compras_proveedor_${stamp}.xlsx`;
    if (Platform.OS === 'web') {
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}${fname}`;
      FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 })
        .then(() =>
          Sharing.shareAsync(fileUri, {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            dialogTitle: fname,
          })
        )
        .catch(() => {});
    }
  }, [filtrados]);

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
            {lastFetch ? ` · Última carga: ${new Date(lastFetch).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : ''}
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
          <ComprasToolbarFiltrosBtn
            activeCount={filtrosActivosCount}
            onPress={() => {
              setFiltroDropdownId(null);
              setModalFiltrosVisible(true);
            }}
          />
          <Text style={styles.resultCount}>
            {filtrados.length !== items.length ? `${filtrados.length} de ` : ''}{items.length} registros
            {rangoCargado && !rangoCargado.all && rangoCargado.dateFrom && rangoCargado.dateTo
              ? ` · ${rangoCargado.dateFrom.split('-').reverse().join('/')}–${rangoCargado.dateTo.split('-').reverse().join('/')}`
              : rangoCargado?.all
                ? ' · histórico completo'
                : ''}
          </Text>
        </View>
        <View style={styles.toolbarRight}>
          {puedeInformeIa ? (
            <ComprasToolbarIconBtn
              tooltip="Informe IA: variaciones de compras vs periodo anterior"
              onPress={() => router.push('/informes-ia?fuente=compras_variaciones')}
              accessibilityLabel="Informe IA de compras"
              variant="neutral"
            >
              <MaterialIcons name="auto-awesome" size={TOOLBAR_ICON_SIZE} color="#7c3aed" />
            </ComprasToolbarIconBtn>
          ) : null}
          <ComprasToolbarIconBtn
            tooltip="Resumen por empresa y proveedor (importes por periodo)"
            onPress={() => router.push('/compras/compras-proveedor-resumen')}
            accessibilityLabel="Resumen por empresa y proveedor"
            variant="neutral"
          >
            <MaterialIcons name="account-tree" size={TOOLBAR_ICON_SIZE} color="#475569" />
          </ComprasToolbarIconBtn>
          <ComprasToolbarIconBtn
            tooltip="Conciliación de albaranes con facturas de gasto"
            onPress={() => router.push('/compras/conciliacion-facturas')}
            accessibilityLabel="Conciliación con facturas"
            variant="neutral"
          >
            <MaterialIcons name="fact-check" size={TOOLBAR_ICON_SIZE} color="#475569" />
          </ComprasToolbarIconBtn>
          <ComprasToolbarIconBtn
            tooltip="Última compra por producto (una fila por artículo)"
            onPress={() => router.push('/compras/compras-proveedor-ultimo')}
            accessibilityLabel="Última compra por producto"
            variant="neutral"
          >
            <MaterialIcons name="layers" size={TOOLBAR_ICON_SIZE} color="#475569" />
          </ComprasToolbarIconBtn>
          <ComprasToolbarIconBtn
            tooltip="Exportar resultados filtrados a Excel"
            onPress={exportarExcel}
            disabled={filtrados.length === 0}
            accessibilityLabel="Exportar Excel"
            variant="outline"
          >
            <MaterialIcons
              name="table-chart"
              size={TOOLBAR_ICON_SIZE}
              color={filtrados.length === 0 ? '#cbd5e1' : '#0ea5e9'}
            />
          </ComprasToolbarIconBtn>
          <ComprasToolbarIconBtn
            tooltip={loading ? 'Cargando datos del servidor…' : 'Recargar datos desde el servidor'}
            onPress={() => {
              const { dateFrom, dateTo } = rangoApiDesdeFiltroFechas(fechaDesde, fechaHasta);
              recargar({ dateFrom, dateTo, force: true });
            }}
            disabled={loading}
            accessibilityLabel="Recargar"
            variant="outline"
          >
            {loading ? (
              <ActivityIndicator size="small" color="#0ea5e9" />
            ) : (
              <MaterialIcons name="refresh" size={TOOLBAR_ICON_SIZE} color="#0ea5e9" />
            )}
          </ComprasToolbarIconBtn>
          <ComprasToolbarSyncBtn syncing={syncing} onPress={() => setMenuSyncVisible(true)} />
        </View>
      </View>

      {hayBusquedaOFiltros ? (
        <View style={styles.toolbarResumenFiltrados}>
          <MaterialIcons name="functions" size={15} color="#b45309" />
          <Text style={styles.toolbarResumenFiltradosText}>
            Vista filtrada — Cantidad total:{' '}
            <Text style={styles.toolbarResumenFiltradosStrong}>
              {totalesFiltrados.sumCant.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}
            </Text>
            {' · Importe total: '}
            <Text style={styles.toolbarResumenFiltradosStrong}>
              {totalesFiltrados.sumImporte.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
              €
            </Text>
            {filtrados.length > 0 ? ` (${filtrados.length} líneas)` : ''}
          </Text>
        </View>
      ) : null}

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

      <Modal visible={modalFiltrosVisible} transparent animationType="fade" onRequestClose={cerrarModalFiltros}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={cerrarModalFiltros}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalFiltrosWrap}>
            <View style={styles.modalFiltrosCard}>
              <View style={styles.modalFiltrosHeader}>
                <Text style={styles.modalFiltrosTitle}>Filtros</Text>
                <TouchableOpacity onPress={cerrarModalFiltros} hitSlop={8}>
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
                  Formato dd/mm/aaaa. Al pulsar Listo se cargan del servidor las compras de ese rango (no solo los últimos 90 días). Deja vacío un extremo para no acotar por ese lado; las líneas sin fecha de albarán quedan excluidas del rango.
                </Text>
                <View style={styles.modalFiltrosFechasRow}>
                  <View style={styles.modalFiltrosFechaField}>
                    <Text style={styles.modalFiltrosLabel}>Desde</Text>
                    <InputFecha
                      valueIso={fechaDesde}
                      onChangeIso={setFechaDesde}
                      placeholder="dd/mm/aaaa"
                      style={styles.modalFiltrosInput}
                    />
                  </View>
                  <View style={styles.modalFiltrosFechaField}>
                    <Text style={styles.modalFiltrosLabel}>Hasta</Text>
                    <InputFecha
                      valueIso={fechaHasta}
                      onChangeIso={setFechaHasta}
                      placeholder="dd/mm/aaaa"
                      style={styles.modalFiltrosInput}
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
                  <React.Fragment key={sec.key}>
                    {sec.key === 'fam' ? (
                      <GruposFamiliasChips
                        grupos={grupos}
                        familiasSeleccionadas={selFamilias}
                        onToggleGrupo={(ids) => setSelFamilias((p) => toggleGrupoFamilias(p, ids))}
                        onCrearGrupo={(nombre) => crearGrupo(nombre, selFamilias)}
                        onBorrarGrupo={borrarGrupo}
                      />
                    ) : null}
                    <ComprasFiltroDropdown
                      title={sec.title}
                      options={sec.opts}
                      value={sec.sel}
                      onToggleId={(id) => sec.setSel((p) => toggleInList(p, id))}
                      fieldKey={sec.key}
                      openKey={filtroDropdownId}
                      setOpenKey={setFiltroDropdownId}
                    />
                  </React.Fragment>
                ))}
              </ScrollView>
              <View style={styles.modalFiltrosFooter}>
                <TouchableOpacity style={styles.modalFiltrosLimpiar} onPress={limpiarFiltrosAvanzados}>
                  <Text style={styles.modalFiltrosLimpiarText}>Limpiar filtros</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalFiltrosCerrar} onPress={cerrarModalFiltros}>
                  <Text style={styles.modalFiltrosCerrarText}>Listo</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={menuSyncVisible} transparent animationType="fade" onRequestClose={() => setMenuSyncVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setMenuSyncVisible(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.syncMenuWrap}>
            <View style={styles.syncMenuCard}>
              <View style={styles.syncMenuHeader}>
                <MaterialIcons name="sync" size={18} color="#0ea5e9" />
                <Text style={styles.syncMenuTitle}>Sincronizar compras</Text>
                <TouchableOpacity onPress={() => setMenuSyncVisible(false)} hitSlop={8}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              {OPCIONES_SYNC.map((op) => (
                <TouchableOpacity
                  key={String(op.id)}
                  style={[styles.syncMenuRow, op.id === 'completo' && styles.syncMenuRowFull]}
                  onPress={() => sincronizar(op.id)}
                  activeOpacity={0.7}
                >
                  <View style={styles.syncMenuIconBox}>
                    <MaterialIcons name={op.icono} size={18} color="#0ea5e9" />
                  </View>
                  <View style={styles.syncMenuRowTextWrap}>
                    <Text style={styles.syncMenuRowTitle}>{op.titulo}</Text>
                    <Text style={styles.syncMenuRowSub}>{op.subtitulo}</Text>
                  </View>
                  <MaterialIcons name="chevron-right" size={20} color="#cbd5e1" />
                </TouchableOpacity>
              ))}
              <View style={styles.syncMenuHint}>
                <MaterialIcons name="info-outline" size={14} color="#b45309" />
                <Text style={styles.syncMenuHintText}>
                  Cuanto mayor sea el rango, más tarda la sincronización con Ágora. Para el uso diario suele bastar con 20 o 60 días.
                </Text>
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
                        {getCompraCellValue(item, col)}
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

