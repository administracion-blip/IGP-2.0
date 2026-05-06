import React, { useEffect, useState, useCallback, useMemo } from 'react';
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
  parseDdMmYyyyToIso,
  ultimaCompraPorProducto,
  ComprasFiltroDropdown,
  FiltroDropdownKey,
  OpcionFiltro,
  styles,
  TOOLBAR_ICON_SIZE,
  ComprasToolbarIconBtn,
  ComprasToolbarFiltrosBtn,
} from './comprasProveedorShared';

export default function ComprasProveedorUltimoScreen() {
  const router = useRouter();
  const { width: winWidth } = useWindowDimensions();

  const { compras, loading, error, lastFetch, recargar } = useComprasProveedorCache();

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

  useEffect(() => {
    recargar();
  }, [recargar]);

  /** Una fila por ProductId: última compra (según fecha de albarán). */
  const itemsBase = useMemo(
    () => ultimaCompraPorProducto(compras as unknown as CompraLinea[]),
    [compras]
  );

  const opcionesFiltros = useMemo(() => {
    const albaranes = new Map<string, string>();
    const productos = new Map<string, string>();
    const proveedores = new Map<string, string>();
    const familias = new Map<string, string>();
    const almacenes = new Map<string, string>();
    itemsBase.forEach((it) => {
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
  }, [itemsBase]);

  const filtrados = useMemo(() => {
    let list = itemsBase;
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
    itemsBase,
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

  const exportarExcel = useCallback(() => {
    if (filtrados.length === 0) return;
    const headers = COLUMNAS.map((c) => c.label);
    const rows = filtrados.map((item) => COLUMNAS.map((col) => getCompraCellValue(item, col)));
    const data: string[][] = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Última compra');
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `ultima_compra_por_producto_${stamp}.xlsx`;
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
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>Última compra por producto</Text>
          <Text style={styles.headerSubtitle}>
            {itemsBase.length} productos · {compras.length} líneas en caché
            {lastFetch ? ` · Última carga: ${new Date(lastFetch).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </Text>
        </View>
      </View>

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
            {filtrados.length !== itemsBase.length ? `${filtrados.length} de ` : ''}{itemsBase.length} productos
          </Text>
        </View>
        <View style={styles.toolbarRight}>
          <ComprasToolbarIconBtn
            tooltip="Vista completa: todas las líneas de compra"
            onPress={() => router.push('/compras/compras-proveedor')}
            accessibilityLabel="Vista completa de compras"
            variant="neutral"
          >
            <MaterialIcons name="list" size={TOOLBAR_ICON_SIZE} color="#475569" />
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
            onPress={() => recargar({ force: true })}
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
        </View>
      </View>

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

      <ScrollView style={styles.tableWrap} horizontal>
        <View style={{ minWidth: Math.max(totalWidth, winWidth - 40) }}>
          <View style={styles.tableHeader}>
            {COLUMNAS.map((col) => (
              <View key={col.key} style={[styles.thCell, { width: col.width }]}>
                <Text style={[styles.thText, col.align === 'right' && styles.textRight, col.align === 'center' && styles.textCenter]} numberOfLines={1}>
                  {col.label}
                </Text>
              </View>
            ))}
          </View>

          <ScrollView style={styles.tableBody}>
            {loading && itemsBase.length === 0 ? (
              <View style={styles.emptyWrap}>
                <ActivityIndicator size="large" color="#0ea5e9" />
                <Text style={styles.emptyText}>Cargando datos…</Text>
              </View>
            ) : paginados.length === 0 ? (
              <View style={styles.emptyWrap}>
                <MaterialIcons name="inbox" size={48} color="#cbd5e1" />
                <Text style={styles.emptyText}>
                  {itemsBase.length === 0
                    ? 'No hay datos. Vuelve a "Compras a Proveedor" y sincroniza con Ágora para traer albaranes.'
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
