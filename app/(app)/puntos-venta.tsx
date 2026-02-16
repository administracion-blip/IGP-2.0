import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  PanResponder,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const DEFAULT_COL_WIDTH = 100;
const MIN_COL_WIDTH = 50;
const MAX_COL_WIDTH = 280;
const PAGE_SIZE = 50;

type PuntoVentaItem = { Id?: number | string; Nombre?: string; Tipo?: string; Local?: string; Grupo?: string; Activo?: boolean };

const COLUMNAS: (keyof PuntoVentaItem)[] = ['Activo', 'Id', 'Nombre', 'Tipo', 'Local', 'Grupo'];

const ACTIVO_COL_WIDTH = 40;

function getValorCelda(item: PuntoVentaItem, col: string): string {
  if (col === 'Activo') return '';
  const v = item[col as keyof PuntoVentaItem];
  if (v == null || v === '') return '—';
  return String(v);
}

function isActivo(item: PuntoVentaItem): boolean {
  return item.Activo !== false;
}

export default function PuntosVentaScreen() {
  const router = useRouter();
  const [saleCenters, setSaleCenters] = useState<PuntoVentaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [currentPage, setCurrentPage] = useState(1);
  const resizeStartWidth = useRef(0);
  const resizeCol = useRef<string | null>(null);

  const refetch = useCallback((silent = false) => {
    if (!silent) { setLoading(true); setError(null); }
    fetch(`${API_URL}/api/agora/sale-centers`)
      .then((res) => res.json())
      .then((data: { saleCenters?: PuntoVentaItem[]; error?: string }) => {
        if (data.error) {
          if (!silent) setError(data.error);
          setSaleCenters([]);
        } else {
          setSaleCenters(Array.isArray(data.saleCenters) ? data.saleCenters : []);
        }
      })
      .catch((e) => {
        if (!silent) setError(e.message || 'Error de conexión');
        setSaleCenters([]);
      })
      .finally(() => { if (!silent) setLoading(false); });
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Sync al abrir la pantalla (en segundo plano) para mantener datos actualizados
  useEffect(() => {
    fetch(`${API_URL}/api/agora/sale-centers/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((res) => res.json())
      .then((data: { ok?: boolean }) => {
        if (data.ok) refetch(true);
      })
      .catch(() => {});
  }, [refetch]);

  const columnas = COLUMNAS;

  const filtrados = useMemo(() => {
    let list = saleCenters;
    const q = filtroBusqueda.trim().toLowerCase();
    if (q) {
      list = list.filter((item) =>
        columnas.some((col) => {
          const val = getValorCelda(item, col);
          return val !== '—' && val.toLowerCase().includes(q);
        })
      );
    }
    list = [...list].sort((a, b) => {
      const localA = String(a.Local ?? '').localeCompare(String(b.Local ?? ''), undefined, { sensitivity: 'base' });
      if (localA !== 0) return localA;
      return String(a.Nombre ?? '').localeCompare(String(b.Nombre ?? ''), undefined, { sensitivity: 'base' });
    });
    return list;
  }, [saleCenters, filtroBusqueda, columnas]);

  const totalPages = Math.max(1, Math.ceil(filtrados.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtrados.slice(start, start + PAGE_SIZE);
  }, [filtrados, safePage]);

  const contentBasedWidths = useMemo(() => {
    const out: Record<string, number> = {};
    const CHAR = 6, PAD = 12;
    for (const col of columnas) {
      if (col === 'Activo') {
        out[col] = ACTIVO_COL_WIDTH;
        continue;
      }
      let maxLen = col.length;
      for (const item of paginated) {
        const val = getValorCelda(item, col);
        if (val.length > maxLen) maxLen = val.length;
      }
      const w = PAD + maxLen * CHAR;
      out[col] = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, w));
    }
    return out;
  }, [paginated, columnas]);

  const getColWidth = useCallback((col: string): number => {
    if (colWidths[col] != null) return colWidths[col];
    return contentBasedWidths[col] ?? DEFAULT_COL_WIDTH;
  }, [colWidths, contentBasedWidths]);

  const tableMinWidth = useMemo(() => {
    return columnas.reduce((sum, col) => sum + (colWidths[col] ?? contentBasedWidths[col] ?? DEFAULT_COL_WIDTH), 0);
  }, [colWidths, contentBasedWidths, columnas]);

  const createResizePanResponder = useCallback((col: string) => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        resizeCol.current = col;
        resizeStartWidth.current = colWidths[col] ?? contentBasedWidths[col] ?? DEFAULT_COL_WIDTH;
      },
      onPanResponderMove: (_, gestureState) => {
        if (resizeCol.current === null) return;
        const w = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, resizeStartWidth.current + gestureState.dx));
        setColWidths((prev) => ({ ...prev, [resizeCol.current!]: w }));
      },
      onPanResponderRelease: () => { resizeCol.current = null; },
    });
  }, [colWidths, contentBasedWidths]);

  const resizePanResponders = useMemo(
    () => Object.fromEntries(columnas.map((col) => [col, createResizePanResponder(col)])),
    [createResizePanResponder, columnas]
  );

  useEffect(() => { setCurrentPage((p) => (p > totalPages ? totalPages : p)); }, [totalPages]);

  const toggleActivo = useCallback((item: PuntoVentaItem, newActivo: boolean) => {
    const id = item.Id ?? item.id;
    if (id == null) return;
    setSaleCenters((prev) =>
      prev.map((p) => (String(p.Id ?? p.id) === String(id) ? { ...p, Activo: newActivo } : p))
    );
    fetch(`${API_URL}/api/agora/sale-centers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: String(id), Activo: newActivo }),
    })
      .then((res) => res.json())
      .then((data: { ok?: boolean; error?: string }) => {
        if (!data.ok && data.error) {
          setSaleCenters((prev) =>
            prev.map((p) => (String(p.Id ?? p.id) === String(id) ? { ...p, Activo: !newActivo } : p))
          );
        }
      })
      .catch(() => {
        setSaleCenters((prev) =>
          prev.map((p) => (String(p.Id ?? p.id) === String(id) ? { ...p, Activo: !newActivo } : p))
        );
      });
  }, []);

  if (loading && saleCenters.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando puntos de venta…</Text>
      </View>
    );
  }

  if (error && saleCenters.length === 0) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color="#f87171" />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => refetch()}>
          <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
          <Text style={styles.retryBtnText}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Puntos de Venta</Text>
      </View>

      <View style={styles.toolbarRow}>
        <TouchableOpacity style={styles.syncBtn} onPress={() => refetch()} accessibilityLabel="Refrescar">
          <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
          <Text style={styles.syncBtnText}>Refrescar</Text>
        </TouchableOpacity>
        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar en la tabla…"
            placeholderTextColor="#94a3b8"
          />
        </View>
      </View>

      <Text style={styles.subtitle}>
        {filtrados.length === 0 ? '0 puntos de venta' : `${filtrados.length} punto${filtrados.length !== 1 ? 's' : ''} de venta`}
        {filtrados.length > 0 && <Text style={styles.subtitlePage}> · Página {safePage} de {totalPages}</Text>}
      </Text>

      <View style={styles.tableWrap}>
        <ScrollView horizontal style={styles.scroll} contentContainerStyle={[styles.scrollContent, { minWidth: tableMinWidth }]} showsHorizontalScrollIndicator>
          <View style={[styles.table, { minWidth: tableMinWidth }]}>
            <View style={styles.rowHeader}>
                {columnas.map((col, colIdx) => (
                  <View key={col} style={[styles.cellHeader, styles.cellCentered, { width: getColWidth(col) }, colIdx === columnas.length - 1 && styles.cellLast]}>
                    <Text style={styles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">{col}</Text>
                    {colIdx < columnas.length - 1 ? <View style={styles.resizeHandle} {...(resizePanResponders[col]?.panHandlers ?? {})} /> : null}
                  </View>
                ))}
              </View>
              {filtrados.length === 0 ? (
                <View style={[styles.row, styles.rowEmpty, { minWidth: tableMinWidth }]}>
                  <View style={[styles.cellEmpty, { width: tableMinWidth }]}>
                    <Text style={styles.cellEmptyText}>
                      {saleCenters.length === 0 ? 'No hay puntos de venta. Comprueba la conexión con Ágora (export-master WorkplacesSummary).' : 'Ningún resultado con el filtro'}
                    </Text>
                  </View>
                </View>
              ) : (
                paginated.map((item, idx) => {
                  const activo = isActivo(item);
                  return (
                    <View key={`${item.Id ?? item.id ?? idx}-${idx}`} style={[styles.row, !activo && styles.rowInactiva]}>
                      {columnas.map((col, colIdx) => (
                        <View key={col} style={[styles.cell, styles.cellCentered, { width: getColWidth(col) }, colIdx === columnas.length - 1 && styles.cellLast]}>
                          {col === 'Activo' ? (
                            <TouchableOpacity
                              style={styles.checkboxTouch}
                              onPress={() => toggleActivo(item, !activo)}
                              accessibilityLabel={activo ? 'Desactivar' : 'Activar'}
                              accessibilityRole="checkbox"
                            >
                              <MaterialIcons
                                name={activo ? 'check-box' : 'check-box-outline-blank'}
                                size={16}
                                color={activo ? '#0ea5e9' : '#94a3b8'}
                              />
                            </TouchableOpacity>
                          ) : (
                            <Text style={[styles.cellText, !activo && styles.cellTextInactiva]} numberOfLines={1} ellipsizeMode="tail">{getValorCelda(item, col)}</Text>
                          )}
                        </View>
                      ))}
                    </View>
                  );
                })
              )}
            </View>
        </ScrollView>
      </View>

      {filtrados.length > PAGE_SIZE ? (
        <View style={styles.paginationRow}>
          <TouchableOpacity style={[styles.pageBtn, safePage <= 1 && styles.pageBtnDisabled]} onPress={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>
            <MaterialIcons name="chevron-left" size={20} color={safePage <= 1 ? '#94a3b8' : '#334155'} />
            <Text style={[styles.pageBtnText, safePage <= 1 && styles.pageBtnTextDisabled]}>Anterior</Text>
          </TouchableOpacity>
          <Text style={styles.pageInfo}>{(safePage - 1) * PAGE_SIZE + 1}-{Math.min(safePage * PAGE_SIZE, filtrados.length)} de {filtrados.length}</Text>
          <TouchableOpacity style={[styles.pageBtn, safePage >= totalPages && styles.pageBtnDisabled]} onPress={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}>
            <Text style={[styles.pageBtnText, safePage >= totalPages && styles.pageBtnTextDisabled]}>Siguiente</Text>
            <MaterialIcons name="chevron-right" size={20} color={safePage >= totalPages ? '#94a3b8' : '#334155'} />
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  errorText: { fontSize: 12, color: '#f87171', textAlign: 'center' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, padding: 8, backgroundColor: '#f8fafc', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  retryBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12 },
  syncBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  syncBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 140, maxWidth: 280, height: 32, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 8 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 12, color: '#334155', paddingVertical: 0 },
  subtitle: { fontSize: 12, color: '#64748b', marginBottom: 8 },
  subtitlePage: { fontSize: 11, color: '#94a3b8' },
  paginationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 12, marginBottom: 8 },
  pageBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, backgroundColor: '#f8fafc' },
  pageBtnDisabled: { opacity: 0.6 },
  pageBtnText: { fontSize: 12, color: '#334155', fontWeight: '500' },
  pageBtnTextDisabled: { color: '#94a3b8' },
  pageInfo: { fontSize: 12, color: '#64748b' },
  tableWrap: { flex: 1, minHeight: 120, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#f8fafc' },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20, flexGrow: 1 },
  table: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff', alignSelf: 'flex-start' },
  rowHeader: { flexDirection: 'row', backgroundColor: '#e2e8f0', borderBottomWidth: 1, borderBottomColor: '#cbd5e1' },
  cellHeader: { minWidth: MIN_COL_WIDTH, paddingVertical: 2, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: '#cbd5e1', position: 'relative' },
  resizeHandle: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 10, backgroundColor: 'rgba(0,0,0,0.04)', cursor: 'col-resize' },
  cellHeaderText: { fontSize: 10, fontWeight: '600', color: '#334155' },
  cellLast: { borderRightWidth: 0 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', backgroundColor: '#fff' },
  rowInactiva: { backgroundColor: '#f1f5f9' },
  rowEmpty: {},
  cell: { minWidth: MIN_COL_WIDTH, paddingVertical: 2, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  cellCentered: { justifyContent: 'center', alignItems: 'center' },
  cellText: { fontSize: 10, color: '#475569', textAlign: 'center' },
  cellTextInactiva: { color: '#94a3b8' },
  checkboxTouch: { padding: 2 },
  cellEmpty: { paddingVertical: 28, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  cellEmptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', textAlign: 'center' },
});
