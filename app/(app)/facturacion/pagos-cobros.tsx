import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { formatMoneda, labelFormaPago } from '../../utils/facturacion';
import { InputFecha } from '../../components/InputFecha';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const PAGE_SIZE = 50;

function isoToDmy(iso: string): string {
  if (!iso || iso.length < 10) return '—';
  const [y, m, d] = iso.substring(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function dmyToIso(dmy: string): string {
  if (!dmy) return '';
  const m = dmy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dmy)) return dmy;
  return '';
}
const MIN_COL_WIDTH = 60;

type Pago = {
  id_pago: string;
  id_factura: string;
  fecha: string;
  importe: number;
  metodo_pago: string;
  referencia: string;
  observaciones: string;
  creado_por: string;
};

const COLUMNAS = [
  { key: 'id_factura', label: 'Factura' },
  { key: 'id_pago', label: 'ID Pago' },
  { key: 'fecha', label: 'Fecha' },
  { key: 'importe', label: 'Importe' },
  { key: 'metodo_pago', label: 'Método pago' },
  { key: 'referencia', label: 'Referencia' },
  { key: 'observaciones', label: 'Observaciones' },
  { key: 'creado_por', label: 'Creado por' },
] as const;

const DEFAULT_WIDTHS: Record<string, number> = {
  id_factura: 130,
  id_pago: 110,
  fecha: 100,
  importe: 110,
  metodo_pago: 120,
  referencia: 140,
  observaciones: 180,
  creado_por: 120,
};

export default function PagosCobrosScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();

  const [pagos, setPagos] = useState<Pago[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ ...DEFAULT_WIDTHS });
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);

  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  if (!hasPermiso('facturacion.cobrar_pagar')) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock" size={48} color="#94a3b8" />
        <Text style={styles.errorText}>No tienes permiso para acceder a esta sección</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => router.push('/facturacion' as any)}>
          <Text style={styles.retryBtnText}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    fetch(`${API_URL}/api/facturacion/pagos`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setPagos(data.pagos || []);
      })
      .catch((e) => setError(e?.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  const pagosFiltrados = useMemo(() => {
    let resultado = pagos;
    if (filtroBusqueda.trim()) {
      const q = filtroBusqueda.trim().toLowerCase();
      resultado = resultado.filter(
        (p) =>
          (p.id_factura || '').toLowerCase().includes(q) ||
          (p.id_pago || '').toLowerCase().includes(q) ||
          (p.referencia || '').toLowerCase().includes(q) ||
          (p.observaciones || '').toLowerCase().includes(q) ||
          (p.creado_por || '').toLowerCase().includes(q) ||
          (p.metodo_pago || '').toLowerCase().includes(q)
      );
    }
    const isoDesde = dmyToIso(fechaDesde);
    const isoHasta = dmyToIso(fechaHasta);
    if (isoDesde) resultado = resultado.filter((p) => (p.fecha || '') >= isoDesde);
    if (isoHasta) resultado = resultado.filter((p) => (p.fecha || '') <= isoHasta);
    return resultado;
  }, [pagos, filtroBusqueda, fechaDesde, fechaHasta]);

  const totalImporteFiltrado = useMemo(
    () => pagosFiltrados.reduce((sum, p) => sum + (p.importe ?? 0), 0),
    [pagosFiltrados]
  );

  const totalRegistros = pagosFiltrados.length;
  const totalPages = Math.max(1, Math.ceil(totalRegistros / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const pagosPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return pagosFiltrados.slice(start, start + PAGE_SIZE);
  }, [pagosFiltrados, pageIndexClamped]);

  useEffect(() => {
    setPageIndex((p) => (p >= totalPages ? Math.max(0, totalPages - 1) : p));
  }, [totalPages]);

  useEffect(() => {
    setPageIndex(0);
    setSelectedId(null);
  }, [filtroBusqueda, fechaDesde, fechaHasta]);

  const goPrevPage = () => { setPageIndex((p) => Math.max(0, p - 1)); setSelectedId(null); };
  const goNextPage = () => { setPageIndex((p) => Math.min(totalPages - 1, p + 1)); setSelectedId(null); };

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? 120, [columnWidths]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !resizingCol) return;
    const handleMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const delta = e.clientX - r.startX;
      const next = Math.max(MIN_COL_WIDTH, r.startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [r.col]: next }));
    };
    const handleUp = () => { resizeRef.current = null; setResizingCol(null); };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => { document.removeEventListener('mousemove', handleMove); document.removeEventListener('mouseup', handleUp); };
  }, [resizingCol]);

  const handleResizeStart = (col: string, e: { nativeEvent?: { clientX: number }; clientX?: number }) => {
    if (Platform.OS !== 'web') return;
    const clientX = e.nativeEvent?.clientX ?? (e as { clientX: number }).clientX ?? 0;
    resizeRef.current = { col, startX: clientX, startWidth: getColWidth(col) };
    setResizingCol(col);
  };

  const valorCelda = useCallback((item: Pago, col: string): string => {
    switch (col) {
      case 'id_factura': return item.id_factura || '—';
      case 'id_pago': return item.id_pago || '—';
      case 'fecha': return isoToDmy(item.fecha);
      case 'importe': return formatMoneda(item.importe ?? 0);
      case 'metodo_pago': return labelFormaPago(item.metodo_pago || '');
      case 'referencia': return item.referencia || '—';
      case 'observaciones': return item.observaciones || '—';
      case 'creado_por': return item.creado_por || '—';
      default: return '—';
    }
  }, []);

  if (loading && pagos.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando pagos y cobros…</Text>
      </View>
    );
  }

  if (error && pagos.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.push('/facturacion' as any)} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <Text style={styles.title}>Pagos y cobros</Text>
        </View>
        <View style={styles.center}>
          <MaterialIcons name="error-outline" size={48} color="#f87171" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/facturacion' as any)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Pagos y cobros</Text>
      </View>

      <View style={styles.toolbarRow}>
        <View
          style={styles.toolbarBtnWrap}
          {...(Platform.OS === 'web'
            ? ({ onMouseEnter: () => setHoveredBtn('refresh'), onMouseLeave: () => setHoveredBtn(null) } as object)
            : {})}
        >
          {hoveredBtn === 'refresh' && (
            <View style={styles.tooltip}><Text style={styles.tooltipText}>Actualizar</Text></View>
          )}
          <TouchableOpacity style={styles.toolbarBtn} onPress={refetch} disabled={loading} accessibilityLabel="Actualizar">
            <MaterialIcons name="refresh" size={18} color={loading ? '#94a3b8' : '#0ea5e9'} />
          </TouchableOpacity>
        </View>

        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar…"
            placeholderTextColor="#94a3b8"
          />
        </View>

        <View style={styles.fechaFilterWrap}>
          <Text style={styles.fechaLabel}>Desde</Text>
          <InputFecha value={fechaDesde} onChange={setFechaDesde} format="dmy" placeholder="dd/mm/aaaa" style={styles.fechaInput} />
          <Text style={styles.fechaLabel}>Hasta</Text>
          <InputFecha value={fechaHasta} onChange={setFechaHasta} format="dmy" placeholder="dd/mm/aaaa" style={styles.fechaInput} />
        </View>
      </View>

      <View style={styles.subtitleRow}>
        <Text style={styles.subtitle}>
          {totalRegistros === 0
            ? '0 registros'
            : totalPages > 1
              ? `${pageIndexClamped * PAGE_SIZE + 1}–${Math.min((pageIndexClamped + 1) * PAGE_SIZE, totalRegistros)} de ${totalRegistros} registro${totalRegistros !== 1 ? 's' : ''}`
              : `${totalRegistros} registro${totalRegistros !== 1 ? 's' : ''}`}
        </Text>
        {totalPages > 1 && (
          <View style={styles.pagination}>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped <= 0 && styles.pageBtnDisabled]}
              onPress={goPrevPage}
              disabled={pageIndexClamped <= 0}
            >
              <MaterialIcons name="chevron-left" size={20} color={pageIndexClamped <= 0 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
            <Text style={styles.pageText}>Página {pageIndexClamped + 1} de {totalPages}</Text>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped >= totalPages - 1 && styles.pageBtnDisabled]}
              onPress={goNextPage}
              disabled={pageIndexClamped >= totalPages - 1}
            >
              <MaterialIcons name="chevron-right" size={20} color={pageIndexClamped >= totalPages - 1 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      <View style={styles.tableWrapper}>
        <ScrollView horizontal style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <View style={styles.table}>
            <View style={styles.rowHeader}>
              {COLUMNAS.map((col) => (
                <View key={col.key} style={[styles.cellHeader, { width: getColWidth(col.key) }, col.key === 'importe' && styles.cellHeaderRight]}>
                  <Text style={[styles.cellHeaderText, col.key === 'importe' && styles.cellHeaderTextRight]} numberOfLines={1} ellipsizeMode="tail">{col.label}</Text>
                  {Platform.OS === 'web' && (
                    <View
                      style={styles.resizeHandle}
                      {...({ onMouseDown: (e: { nativeEvent?: { clientX: number }; clientX?: number }) => handleResizeStart(col.key, e) } as object)}
                    />
                  )}
                </View>
              ))}
            </View>

            <ScrollView
              style={styles.tableBody}
              contentContainerStyle={styles.tableBodyContent}
              showsVerticalScrollIndicator
              nestedScrollEnabled
            >
              {pagosPagina.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={styles.emptyText}>
                    {pagos.length === 0 ? 'No hay pagos ni cobros registrados' : 'Sin resultados para el filtro aplicado'}
                  </Text>
                </View>
              ) : (
                pagosPagina.map((item) => (
                  <TouchableOpacity
                    key={item.id_pago}
                    style={[styles.row, selectedId === item.id_pago && styles.rowSelected]}
                    onPress={() => setSelectedId(selectedId === item.id_pago ? null : item.id_pago)}
                    activeOpacity={0.8}
                  >
                    {COLUMNAS.map((col) => (
                      <View key={col.key} style={[styles.cell, { width: getColWidth(col.key) }, col.key === 'importe' && styles.cellRight]}>
                        <Text style={[styles.cellText, col.key === 'importe' && styles.cellTextRight]} numberOfLines={1} ellipsizeMode="tail">
                          {valorCelda(item, col.key)}
                        </Text>
                      </View>
                    ))}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>

            {pagosFiltrados.length > 0 && (
              <View style={styles.summaryRow}>
                {COLUMNAS.map((col) => (
                  <View key={col.key} style={[styles.summaryCell, { width: getColWidth(col.key) }, col.key === 'importe' && styles.cellRight]}>
                    {col.key === 'importe' ? (
                      <Text style={styles.summaryValue}>{formatMoneda(totalImporteFiltrado)}</Text>
                    ) : col.key === 'id_factura' ? (
                      <Text style={styles.summaryLabel}>Total</Text>
                    ) : null}
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  errorText: { fontSize: 12, color: '#f87171', textAlign: 'center' },
  retryBtn: { paddingVertical: 8, paddingHorizontal: 16, backgroundColor: '#fef2f2', borderRadius: 8 },
  retryBtnText: { fontSize: 12, color: '#dc2626', fontWeight: '600' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },

  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12, flexWrap: 'wrap' },
  toolbarBtnWrap: { position: 'relative' },
  tooltip: {
    position: 'absolute',
    bottom: '100%',
    alignSelf: 'center',
    marginBottom: 4,
    backgroundColor: '#334155',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
    zIndex: 10,
  },
  tooltipText: { fontSize: 9, color: '#f8fafc', fontWeight: '400' },
  toolbarBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  toolbarBtnDisabled: { opacity: 0.6 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 140,
    maxWidth: 280,
    height: 32,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
  },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 12, color: '#334155', paddingVertical: 0 },

  fechaFilterWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fechaLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  fechaInput: { fontSize: 11, paddingVertical: 3, paddingHorizontal: 6, minHeight: 28, color: '#334155', width: 110 },

  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 12,
    flexWrap: 'wrap',
  },
  subtitle: { fontSize: 14, color: '#64748b' },
  pagination: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pageBtn: { padding: 4 },
  pageBtnDisabled: { opacity: 0.5 },
  pageText: { fontSize: 11, color: '#64748b', marginHorizontal: 4 },

  tableWrapper: { flex: 1, minHeight: 0 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20 },
  table: {
    minWidth: '100%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  rowHeader: { flexDirection: 'row', backgroundColor: '#e2e8f0', borderBottomWidth: 1, borderBottomColor: '#cbd5e1' },
  cellHeader: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRightWidth: 1,
    borderRightColor: '#cbd5e1',
    position: 'relative',
  },
  cellHeaderText: { fontSize: 11, fontWeight: '600', color: '#334155' },
  cellHeaderRight: { alignItems: 'flex-end' },
  cellHeaderTextRight: { textAlign: 'right' },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize' as 'pointer',
  },
  tableBody: { flex: 1 },
  tableBodyContent: { paddingBottom: 0 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', backgroundColor: '#fff' },
  rowSelected: { backgroundColor: '#e0f2fe' },
  cell: { minWidth: MIN_COL_WIDTH, paddingVertical: 4, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#e2e8f0', justifyContent: 'center' },
  cellRight: { alignItems: 'flex-end' },
  cellText: { fontSize: 11, color: '#475569' },
  cellTextRight: { textAlign: 'right', alignSelf: 'stretch' },
  emptyRow: { padding: 24, alignItems: 'center' },
  emptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },

  summaryRow: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    borderTopWidth: 2,
    borderTopColor: '#cbd5e1',
  },
  summaryCell: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    justifyContent: 'center',
  },
  summaryLabel: { fontSize: 11, fontWeight: '700', color: '#334155' },
  summaryValue: { fontSize: 11, fontWeight: '700', color: '#0ea5e9', textAlign: 'right', alignSelf: 'stretch' },
});
