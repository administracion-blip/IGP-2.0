import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Modal,
  Pressable,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as XLSX from 'xlsx';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useProductosCache } from '../contexts/ProductosCache';
import { calcTiempoRestante } from '../lib/acuerdosFechas';
import { InputFecha } from '../components/InputFecha';
import { ComprasProveedorModal } from '../components/ComprasProveedorModal';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const W = {
  id: 58,
  producto: 168,
  acord: 62,
  compr: 62,
  rest: 64,
  pct: 48,
  vigencia: 152,
  pCompra: 74,
  pmr: 74,
  acciones: 40,
} as const;

const TABLE_MIN_WIDTH =
  W.id +
  W.producto +
  W.acord +
  W.compr +
  W.rest +
  W.pct +
  W.vigencia +
  W.pCompra +
  W.pmr +
  W.acciones;

type Linea = {
  PK: string;
  SK?: string;
  ProductId: string;
  ProductName: string;
  Cantidad: number;
  acuerdoPK: string;
  MarcaAcuerdo: string;
  NombreAcuerdo: string;
  FechaInicioAcuerdo?: string;
  FechaFinAcuerdo?: string;
  Compradas: number;
  Restante: number;
  Porcentaje: number;
  Aportacion?: number;
  Rappel?: number;
  DescuentoExtra?: number;
};

function fmtQty(n: number) {
  if (n == null || Number.isNaN(n)) return '0';
  return Number(n).toLocaleString('es-ES', { maximumFractionDigits: 2 });
}

function formatMoneda(n: number | null | undefined): string {
  if (n == null) return '0,00 €';
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function textoRestanteDetalle(d: { Restante: number }) {
  const r = d.Restante || 0;
  if (r > 0) return `-${r.toLocaleString('es-ES')}`;
  if (r < 0) return `+${Math.abs(r).toLocaleString('es-ES')}`;
  return r.toLocaleString('es-ES');
}

function colorRestante(r: number) {
  if (r > 0) return '#ef4444';
  if (r < 0) return '#16a34a';
  return '#0f172a';
}

function parseDecimalInput(s: string): number | null {
  const t = s.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isNaN(n) ? null : n;
}

function computePmr(row: Linea, costPriceMap: Record<string, number>): number {
  const totalAport =
    (Number(row.Aportacion) || 0) + (Number(row.Rappel) || 0) + (Number(row.DescuentoExtra) || 0);
  const cost = costPriceMap[row.ProductId] || 0;
  return cost - totalAport;
}

const EXCEL_HEADERS = [
  'Marca',
  'Acuerdo',
  'ID producto',
  'Producto',
  'Acord.',
  'Compr.',
  'Rest.',
  '%',
  'Fin vigencia',
  'Vigencia',
  'P. compra (€)',
  'PMR (€)',
] as const;

export default function AcuerdosProductosActivosScreen() {
  const router = useRouter();
  const { productosIgp } = useProductosCache();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [items, setItems] = useState<Linea[]>([]);
  const itemsRef = useRef<Linea[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const [meta, setMeta] = useState({ totalLineas: 0, acuerdosActivosConProductos: 0 });
  const [busqueda, setBusqueda] = useState('');

  const [filtroNombreProducto, setFiltroNombreProducto] = useState('');
  const [restMin, setRestMin] = useState('');
  const [restMax, setRestMax] = useState('');
  const [vigenciaFinDesde, setVigenciaFinDesde] = useState('');
  const [vigenciaFinHasta, setVigenciaFinHasta] = useState('');
  const [pmrMin, setPmrMin] = useState('');
  const [pmrMax, setPmrMax] = useState('');
  const [showFiltrosModal, setShowFiltrosModal] = useState(false);
  const [comprasModalVisible, setComprasModalVisible] = useState(false);
  const [comprasModalRow, setComprasModalRow] = useState<Linea | null>(null);

  const costPriceMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of (productosIgp || []) as Record<string, unknown>[]) {
      const id = String(p.Id ?? p.id ?? '').trim();
      const cost = Number(p.CostPrice ?? p.costPrice ?? 0) || 0;
      if (id) map[id] = cost;
    }
    return map;
  }, [productosIgp]);

  const filtrosAvanzadosActivos = useMemo(() => {
    return (
      filtroNombreProducto.trim() !== '' ||
      restMin.trim() !== '' ||
      restMax.trim() !== '' ||
      vigenciaFinDesde.trim() !== '' ||
      vigenciaFinHasta.trim() !== '' ||
      pmrMin.trim() !== '' ||
      pmrMax.trim() !== ''
    );
  }, [
    filtroNombreProducto,
    restMin,
    restMax,
    vigenciaFinDesde,
    vigenciaFinHasta,
    pmrMin,
    pmrMax,
  ]);

  const limpiarFiltrosAvanzados = useCallback(() => {
    setFiltroNombreProducto('');
    setRestMin('');
    setRestMax('');
    setVigenciaFinDesde('');
    setVigenciaFinHasta('');
    setPmrMin('');
    setPmrMax('');
  }, []);

  const cargar = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background === true;
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/acuerdos/productos-activos`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al cargar');
      setItems(Array.isArray(data.items) ? data.items : []);
      setMeta({
        totalLineas: data.totalLineas ?? 0,
        acuerdosActivosConProductos: data.acuerdosActivosConProductos ?? 0,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error de red';
      setError(msg);
      if (!background) setItems([]);
    } finally {
      if (background) setRefreshing(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    cargar({ background: false });
  }, [cargar]);

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return items;
    return items.filter((row) => {
      const marca = (row.MarcaAcuerdo || '').toLowerCase();
      const nombre = (row.NombreAcuerdo || '').toLowerCase();
      const prod = (row.ProductName || '').toLowerCase();
      const pid = (row.ProductId || '').toLowerCase();
      return marca.includes(q) || nombre.includes(q) || prod.includes(q) || pid.includes(q);
    });
  }, [items, busqueda]);

  const filtradosFinales = useMemo(() => {
    let rows = filtrados;
    const np = filtroNombreProducto.trim().toLowerCase();
    if (np) {
      rows = rows.filter((r) => (r.ProductName || '').toLowerCase().includes(np));
    }
    const rMin = parseDecimalInput(restMin);
    const rMax = parseDecimalInput(restMax);
    if (rMin !== null) rows = rows.filter((r) => (r.Restante ?? 0) >= rMin);
    if (rMax !== null) rows = rows.filter((r) => (r.Restante ?? 0) <= rMax);
    if (vigenciaFinDesde.trim()) {
      rows = rows.filter((r) => {
        const f = (r.FechaFinAcuerdo || '').trim();
        return f && f >= vigenciaFinDesde.trim();
      });
    }
    if (vigenciaFinHasta.trim()) {
      rows = rows.filter((r) => {
        const f = (r.FechaFinAcuerdo || '').trim();
        return f && f <= vigenciaFinHasta.trim();
      });
    }
    const pmrLo = parseDecimalInput(pmrMin);
    const pmrHi = parseDecimalInput(pmrMax);
    if (pmrLo !== null || pmrHi !== null) {
      rows = rows.filter((r) => {
        const pmr = computePmr(r, costPriceMap);
        if (pmrLo !== null && pmr < pmrLo) return false;
        if (pmrHi !== null && pmr > pmrHi) return false;
        return true;
      });
    }
    return rows;
  }, [
    filtrados,
    filtroNombreProducto,
    restMin,
    restMax,
    vigenciaFinDesde,
    vigenciaFinHasta,
    pmrMin,
    pmrMax,
    costPriceMap,
  ]);

  const grupos = useMemo(() => {
    const map = new Map<string, Linea[]>();
    for (const row of filtradosFinales) {
      const m = row.MarcaAcuerdo || '—';
      if (!map.has(m)) map.set(m, []);
      map.get(m)!.push(row);
    }
    const marcas = [...map.keys()].sort((a, b) => a.localeCompare(b, 'es'));
    return marcas.map((marca) => ({
      marca,
      rows: (map.get(marca) || []).sort((a, b) =>
        (a.ProductName || a.ProductId || '').localeCompare(b.ProductName || b.ProductId || '', 'es'),
      ),
    }));
  }, [filtradosFinales]);

  const buildExportRows = useCallback(() => {
    return filtradosFinales.map((row) => {
      const tr = calcTiempoRestante(row.FechaFinAcuerdo || '');
      const cost = costPriceMap[row.ProductId] || 0;
      const pmr = computePmr(row, costPriceMap);
      return [
        row.MarcaAcuerdo || '',
        row.NombreAcuerdo || '',
        row.ProductId,
        row.ProductName || '',
        row.Cantidad ?? 0,
        row.Compradas ?? 0,
        row.Restante ?? 0,
        row.Porcentaje ?? 0,
        row.FechaFinAcuerdo || '',
        tr.texto,
        Math.round(cost * 100) / 100,
        Math.round(pmr * 100) / 100,
      ];
    });
  }, [filtradosFinales, costPriceMap]);

  const exportarExcel = useCallback(() => {
    if (filtradosFinales.length === 0) return;
    const data = [EXCEL_HEADERS as unknown as string[], ...buildExportRows().map((r) => r.map((c) => c))];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Productos activos');
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `productos_acuerdos_activos_${stamp}.xlsx`;
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
        .then(() => Sharing.shareAsync(fileUri, { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dialogTitle: fname }))
        .catch(() => {});
    }
  }, [filtradosFinales, buildExportRows]);

  const exportarPDF = useCallback(async () => {
    if (filtradosFinales.length === 0) return;
    const { jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    let y = 12;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Productos en acuerdos activos', 14, y);
    y += 6;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(80);
    doc.text(`Generado: ${new Date().toLocaleString('es-ES')} · ${filtradosFinales.length} línea(s)`, 14, y);
    y += 5;
    if (busqueda.trim() || filtrosAvanzadosActivos) {
      const parts: string[] = [];
      if (busqueda.trim()) parts.push(`Búsqueda: "${busqueda.trim()}"`);
      if (filtrosAvanzadosActivos) parts.push('Filtros avanzados aplicados');
      doc.text(parts.join(' · '), 14, y);
      y += 5;
    }
    doc.setTextColor(0);

    const body = buildExportRows().map((r) => [
      String(r[0]),
      String(r[1]).slice(0, 24),
      String(r[2]),
      String(r[3]).slice(0, 28),
      String(r[4]),
      String(r[5]),
      String(r[6]),
      `${Number(r[7]).toFixed(1)}%`,
      String(r[8]),
      String(r[9]).slice(0, 20),
      Number(r[10]).toFixed(2),
      Number(r[11]).toFixed(2),
    ]);

    autoTable(doc, {
      startY: y,
      head: [EXCEL_HEADERS as unknown as string[]],
      body,
      theme: 'striped',
      styles: { fontSize: 6, cellPadding: 1 },
      headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold' },
      margin: { left: 10, right: 10 },
      tableWidth: pageW - 20,
    });

    const fname = `productos_acuerdos_activos_${new Date().toISOString().slice(0, 10)}.pdf`;
    if (Platform.OS === 'web') doc.save(fname);
    else {
      const dataUri = doc.output('datauristring');
      const base64 = dataUri.split(',')[1] || '';
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}${fname}`;
      FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 })
        .then(() => Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: fname }))
        .catch(() => {});
    }
  }, [filtradosFinales, buildExportRows, busqueda, filtrosAvanzadosActivos]);

  const hayFiltroCliente = busqueda.trim() !== '' || filtrosAvanzadosActivos;
  const mostrandoParcial =
    !loading && !error && items.length > 0 && filtradosFinales.length < items.length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Volver">
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Productos en acuerdos activos</Text>
          {!loading && !error ? (
            <Text style={styles.headerSub}>
              {meta.totalLineas} líneas · {meta.acuerdosActivosConProductos} acuerdos con productos
              {mostrandoParcial ? ` · Mostrando ${filtradosFinales.length} de ${items.length}` : null}
              {refreshing ? ' · Actualizando…' : null}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          onPress={() => cargar({ background: itemsRef.current.length > 0 })}
          style={styles.refreshBtn}
          accessibilityLabel="Actualizar"
        >
          {refreshing ? (
            <ActivityIndicator size="small" color="#0ea5e9" />
          ) : (
            <MaterialIcons name="refresh" size={22} color="#64748b" />
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.searchRow}>
        <MaterialIcons name="search" size={20} color="#94a3b8" />
        <TextInput
          style={styles.searchInput}
          placeholder="Buscar marca, acuerdo, producto o código…"
          placeholderTextColor="#94a3b8"
          value={busqueda}
          onChangeText={setBusqueda}
        />
        {busqueda ? (
          <TouchableOpacity onPress={() => setBusqueda('')} hitSlop={8}>
            <MaterialIcons name="close" size={20} color="#94a3b8" />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[styles.iconToolBtn, filtrosAvanzadosActivos && styles.iconToolBtnActive]}
          onPress={() => setShowFiltrosModal(true)}
          accessibilityLabel="Filtros avanzados"
        >
          <MaterialIcons name="tune" size={22} color={filtrosAvanzadosActivos ? '#0369a1' : '#64748b'} />
          {filtrosAvanzadosActivos ? <View style={styles.filterBadge} /> : null}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.iconToolBtn, filtradosFinales.length === 0 && styles.iconToolBtnDisabled]}
          onPress={exportarExcel}
          disabled={filtradosFinales.length === 0}
          accessibilityLabel="Descargar Excel"
        >
          <MaterialIcons name="table-chart" size={22} color={filtradosFinales.length === 0 ? '#cbd5e1' : '#16a34a'} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.iconToolBtn, filtradosFinales.length === 0 && styles.iconToolBtnDisabled]}
          onPress={exportarPDF}
          disabled={filtradosFinales.length === 0}
          accessibilityLabel="Descargar PDF"
        >
          <MaterialIcons name="picture-as-pdf" size={22} color={filtradosFinales.length === 0 ? '#cbd5e1' : '#ef4444'} />
        </TouchableOpacity>
      </View>

      {hayFiltroCliente && !loading ? (
        <View style={styles.filterHintRow}>
          <MaterialIcons name="filter-list" size={16} color="#64748b" />
          <Text style={styles.filterHintText}>
            Vista filtrada: {filtradosFinales.length} línea{filtradosFinales.length === 1 ? '' : 's'}
          </Text>
        </View>
      ) : null}

      <Modal visible={showFiltrosModal} transparent animationType="fade" onRequestClose={() => setShowFiltrosModal(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowFiltrosModal(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Filtros</Text>
              <TouchableOpacity onPress={() => setShowFiltrosModal(false)} hitSlop={8}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={styles.modalLabel}>Nombre de producto (contiene)</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="Texto en nombre de producto…"
                placeholderTextColor="#94a3b8"
                value={filtroNombreProducto}
                onChangeText={setFiltroNombreProducto}
              />

              <Text style={styles.modalLabel}>Restante (uds.)</Text>
              <View style={styles.modalRow2}>
                <View style={styles.modalRow2col}>
                  <Text style={styles.modalMini}>Mín.</Text>
                  <TextInput
                    style={styles.modalInput}
                    placeholder="—"
                    placeholderTextColor="#94a3b8"
                    value={restMin}
                    onChangeText={setRestMin}
                    keyboardType="decimal-pad"
                  />
                </View>
                <View style={styles.modalRow2col}>
                  <Text style={styles.modalMini}>Máx.</Text>
                  <TextInput
                    style={styles.modalInput}
                    placeholder="—"
                    placeholderTextColor="#94a3b8"
                    value={restMax}
                    onChangeText={setRestMax}
                    keyboardType="decimal-pad"
                  />
                </View>
              </View>

              <Text style={styles.modalLabel}>Fin de vigencia (fecha acuerdo)</Text>
              <View style={styles.modalFechaRow}>
                <View style={styles.modalFechaCol}>
                  <Text style={styles.modalMini}>Desde</Text>
                  <InputFecha value={vigenciaFinDesde} onChange={setVigenciaFinDesde} placeholder="Desde" />
                </View>
                <View style={styles.modalFechaCol}>
                  <Text style={styles.modalMini}>Hasta</Text>
                  <InputFecha value={vigenciaFinHasta} onChange={setVigenciaFinHasta} placeholder="Hasta" />
                </View>
              </View>

              <Text style={styles.modalLabel}>PMR (€)</Text>
              <View style={styles.modalRow2}>
                <View style={styles.modalRow2col}>
                  <Text style={styles.modalMini}>Mín.</Text>
                  <TextInput
                    style={styles.modalInput}
                    placeholder="—"
                    placeholderTextColor="#94a3b8"
                    value={pmrMin}
                    onChangeText={setPmrMin}
                    keyboardType="decimal-pad"
                  />
                </View>
                <View style={styles.modalRow2col}>
                  <Text style={styles.modalMini}>Máx.</Text>
                  <TextInput
                    style={styles.modalInput}
                    placeholder="—"
                    placeholderTextColor="#94a3b8"
                    value={pmrMax}
                    onChangeText={setPmrMax}
                    keyboardType="decimal-pad"
                  />
                </View>
              </View>
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnGhost} onPress={limpiarFiltrosAvanzados}>
                <Text style={styles.modalBtnGhostText}>Limpiar filtros</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnPrimary} onPress={() => setShowFiltrosModal(false)}>
                <Text style={styles.modalBtnPrimaryText}>Aplicar</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {error ? (
        <View style={styles.errorBar}>
          <MaterialIcons name="error-outline" size={18} color="#dc2626" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {loading && items.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#0ea5e9" />
          <Text style={styles.loadingText}>Cargando productos…</Text>
        </View>
      ) : filtradosFinales.length === 0 ? (
        <View style={styles.centered}>
          <MaterialIcons name="inventory-2" size={48} color="#cbd5e1" />
          <Text style={styles.emptyText}>
            {items.length === 0
              ? 'No hay productos en acuerdos activos.'
              : 'Ninguna línea coincide con los filtros.'}
          </Text>
        </View>
      ) : (
        <ScrollView style={styles.scrollOuter} contentContainerStyle={styles.scrollOuterContent}>
          <ScrollView horizontal showsHorizontalScrollIndicator style={styles.hScroll}>
            <View style={[styles.tableWrap, { minWidth: TABLE_MIN_WIDTH }]}>
              <View style={styles.tableHeader}>
                <Text style={[styles.th, { width: W.id }]}>ID</Text>
                <Text style={[styles.th, { width: W.producto }]}>Producto</Text>
                <Text style={[styles.th, { width: W.acord, textAlign: 'center' }]}>Acord.</Text>
                <Text style={[styles.th, { width: W.compr, textAlign: 'center' }]}>Compr.</Text>
                <Text style={[styles.th, { width: W.rest, textAlign: 'center' }]}>Rest.</Text>
                <Text style={[styles.th, { width: W.pct, textAlign: 'center' }]}>%</Text>
                <Text style={[styles.th, { width: W.vigencia }]}>Vigencia</Text>
                <Text style={[styles.th, { width: W.pCompra, textAlign: 'center' }]}>P. compra</Text>
                <Text style={[styles.th, { width: W.pmr, textAlign: 'center' }]}>PMR</Text>
                <Text style={[styles.th, { width: W.acciones, textAlign: 'center' }]} />
              </View>

              {grupos.map((g) => (
                <View key={g.marca}>
                  <View style={styles.marcaBand}>
                    <Text style={styles.marcaBandText} numberOfLines={1}>
                      {g.marca}
                    </Text>
                    <Text style={styles.marcaBandCount}>{g.rows.length} prod.</Text>
                  </View>
                  {g.rows.map((row, idx) => {
                    const tr = calcTiempoRestante(row.FechaFinAcuerdo || '');
                    const pctColor = row.Porcentaje >= 80 ? '#16a34a' : '#ef4444';
                    const totalAport =
                      (Number(row.Aportacion) || 0) +
                      (Number(row.Rappel) || 0) +
                      (Number(row.DescuentoExtra) || 0);
                    const cost = costPriceMap[row.ProductId] || 0;
                    const pmr = cost - totalAport;
                    return (
                      <View
                        key={`${row.acuerdoPK}-${row.ProductId}-${row.SK || idx}`}
                        style={[styles.tr, idx % 2 === 1 && styles.trAlt]}
                      >
                        <Text style={[styles.td, { width: W.id, fontSize: 9, color: '#64748b' }]} numberOfLines={1}>
                          {row.ProductId}
                        </Text>
                        <Text style={[styles.td, { width: W.producto }]} numberOfLines={2}>
                          {row.ProductName || row.ProductId}
                        </Text>
                        <Text style={[styles.td, { width: W.acord, textAlign: 'center', fontWeight: '600' }]}>
                          {fmtQty(row.Cantidad)}
                        </Text>
                        <Text style={[styles.td, { width: W.compr, textAlign: 'center', fontWeight: '600' }]}>
                          {(row.Compradas || 0).toLocaleString('es-ES')}
                        </Text>
                        <Text
                          style={[
                            styles.td,
                            {
                              width: W.rest,
                              textAlign: 'center',
                              fontWeight: (row.Restante || 0) !== 0 ? '600' : '400',
                              color: colorRestante(row.Restante || 0),
                            },
                          ]}
                        >
                          {textoRestanteDetalle(row)}
                        </Text>
                        <Text
                          style={[styles.td, { width: W.pct, textAlign: 'center', fontWeight: '700', color: pctColor }]}
                        >
                          {row.Porcentaje?.toFixed(1)}%
                        </Text>
                        <Text
                          style={[
                            styles.td,
                            { width: W.vigencia, fontSize: 9, lineHeight: 12 },
                            tr.vencido && { color: '#ef4444' },
                          ]}
                          numberOfLines={3}
                        >
                          {tr.texto}
                        </Text>
                        <Text style={[styles.td, { width: W.pCompra, textAlign: 'center', fontWeight: '700' }]}>
                          {formatMoneda(cost)}
                        </Text>
                        <Text style={[styles.td, { width: W.pmr, textAlign: 'center', fontWeight: '700', color: '#0d9488' }]}>
                          {formatMoneda(pmr)}
                        </Text>
                        <TouchableOpacity
                          style={{ width: W.acciones, alignItems: 'center', justifyContent: 'center' }}
                          onPress={() => { setComprasModalRow(row); setComprasModalVisible(true); }}
                        >
                          <MaterialIcons name="local-shipping" size={16} color="#0284c7" />
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
        </ScrollView>
      )}

      {comprasModalRow && (
        <ComprasProveedorModal
          visible={comprasModalVisible}
          onClose={() => { setComprasModalVisible(false); setComprasModalRow(null); }}
          productName={comprasModalRow.ProductName || comprasModalRow.ProductId}
          productId={comprasModalRow.ProductId}
          fechaInicio={comprasModalRow.FechaInicioAcuerdo || ''}
          fechaFin={comprasModalRow.FechaFinAcuerdo || ''}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 8,
  },
  backBtn: { padding: 8 },
  refreshBtn: { padding: 8 },
  headerCenter: { flex: 1, minWidth: 0 },
  headerTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a' },
  headerSub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    flexWrap: 'wrap',
  },
  searchInput: { flex: 1, minWidth: 120, fontSize: 14, color: '#334155', paddingVertical: 6 },
  iconToolBtn: {
    padding: 8,
    borderRadius: 8,
    position: 'relative',
  },
  iconToolBtnActive: { backgroundColor: '#e0f2fe' },
  iconToolBtnDisabled: { opacity: 0.5 },
  filterBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#0284c7',
  },
  filterHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: '#f1f5f9',
  },
  filterHintText: { fontSize: 12, color: '#475569' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    maxHeight: '88%',
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a' },
  modalScroll: { maxHeight: 420, paddingHorizontal: 16, paddingTop: 8 },
  modalLabel: { fontSize: 12, fontWeight: '600', color: '#475569', marginTop: 10, marginBottom: 4 },
  modalMini: { fontSize: 10, color: '#94a3b8', marginBottom: 2 },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  modalRow2: { flexDirection: 'row', gap: 10 },
  modalRow2col: { flex: 1 },
  modalFechaRow: { flexDirection: 'row', gap: 10, marginBottom: 4 },
  modalFechaCol: { flex: 1 },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  modalBtnGhost: { paddingVertical: 10, paddingHorizontal: 12 },
  modalBtnGhostText: { fontSize: 14, color: '#64748b', fontWeight: '600' },
  modalBtnPrimary: {
    backgroundColor: '#0ea5e9',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  modalBtnPrimaryText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    margin: 12,
    padding: 10,
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: { flex: 1, fontSize: 13, color: '#b91c1c' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 12 },
  loadingText: { fontSize: 14, color: '#64748b' },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },
  scrollOuter: { flex: 1 },
  scrollOuterContent: { flexGrow: 1, paddingBottom: 24 },
  hScroll: { flex: 1 },
  tableWrap: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    marginHorizontal: 12,
    marginTop: 8,
    backgroundColor: '#fff',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f8fafc',
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    alignItems: 'center',
  },
  th: { fontSize: 9, fontWeight: '700', color: '#475569', textTransform: 'uppercase' },
  marcaBand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#e0f2fe',
    borderBottomWidth: 1,
    borderBottomColor: '#bae6fd',
  },
  marcaBandText: { fontSize: 13, fontWeight: '800', color: '#0369a1', flex: 1 },
  marcaBandCount: { fontSize: 11, fontWeight: '600', color: '#0284c7' },
  tr: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  trAlt: { backgroundColor: '#fafafa' },
  td: { fontSize: 10, color: '#334155' },
});
