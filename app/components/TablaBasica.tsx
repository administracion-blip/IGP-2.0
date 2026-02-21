/**
 * TablaBasica: componente reutilizable para pantallas de listado CRUD
 * (Empresas, Productos, Usuarios, etc.). Incluye:
 * - Cabecera con botón atrás y título
 * - Toolbar: Crear, Editar, Borrar, búsqueda, opcional Importar
 * - Tabla con columnas redimensionables (web), selección de fila y paginación opcional
 * - Los modales de Crear/Editar e Importar quedan en la pantalla que usa el componente.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Platform,
  Modal,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { ICONS, ICON_SIZE } from '../constants/icons';

const DEFAULT_COL_WIDTH = 90;
const DENSE_COL_WIDTH = 72;
const MIN_COL_WIDTH = 40;
const MAX_TEXT_LENGTH = 30;

function truncar(val: string): string {
  if (val.length <= MAX_TEXT_LENGTH) return val;
  return val.slice(0, MAX_TEXT_LENGTH - 3) + '…';
}

export type PaginacionProps = {
  totalRegistros: number;
  pageSize: number;
  pageIndex: number;
  onPrevPage: () => void;
  onNextPage: () => void;
};

export type TablaBasicaProps<T = Record<string, unknown>> = {
  /** Título de la pantalla */
  title: string;
  /** Callback al pulsar atrás */
  onBack: () => void;
  /** Nombres de columnas (orden de la tabla) */
  columnas: string[];
  /** Filas a mostrar (ya filtradas/paginadas por la pantalla) */
  datos: T[];
  /** Obtener valor mostrado por celda (y para búsqueda en pantalla) */
  getValorCelda: (item: T, col: string) => string;
  /** Estado de carga inicial */
  loading?: boolean;
  /** Mensaje de error (si no hay datos) */
  error?: string | null;
  /** Reintentar carga */
  onRetry?: () => void;
  /** Búsqueda: valor controlado */
  filtroBusqueda: string;
  onFiltroChange: (value: string) => void;
  /** Índice de fila seleccionada (en `datos`) */
  selectedRowIndex: number | null;
  onSelectRow: (index: number | null) => void;
  /** Acciones toolbar */
  onCrear: () => void;
  onEditar: (item: T) => void;
  onBorrar: (item: T) => void;
  /** Deshabilitar botones mientras se guarda */
  guardando?: boolean;
  /** Mostrar botón Importar y callback */
  showImport?: boolean;
  onImportClick?: () => void;
  importing?: boolean;
  /** Mostrar botón Exportar Excel y callback */
  showExport?: boolean;
  onExportClick?: () => void;
  /** Paginación opcional: si se pasa, se muestra "X–Y de Z" y anterior/siguiente */
  paginacion?: PaginacionProps;
  /** Mensaje cuando no hay datos en la tabla */
  emptyMessage?: string;
  /** Mensaje cuando el filtro no devuelve resultados */
  emptyFilterMessage?: string;
  /** Nombres de columnas con formato moneda (alineación derecha) */
  columnasMoneda?: string[];
  /** Ocultar cabecera (botón atrás + título) para usar cabecera personalizada */
  hideHeader?: boolean;
  /** Estilo opcional por fila (ej. resaltar fecha de hoy) */
  getRowStyle?: (item: T, index: number) => ViewStyle | undefined;
  /** Modo compacto: filas y tipografía más pequeñas */
  dense?: boolean;
  /** Contenido extra a la derecha del toolbar (ej. botón Generar) */
  extraToolbarRight?: React.ReactNode;
  /** Contenido extra entre los botones de acción y la búsqueda (ej. filtros Año/Mes) */
  extraToolbarLeft?: React.ReactNode;
};

export function TablaBasica<T = Record<string, unknown>>(props: TablaBasicaProps<T>) {
  const {
    title,
    onBack,
    columnas,
    datos,
    getValorCelda,
    loading = false,
    error = null,
    onRetry,
    filtroBusqueda,
    onFiltroChange,
    selectedRowIndex,
    onSelectRow,
    onCrear,
    onEditar,
    onBorrar,
    guardando = false,
    showImport = false,
    onImportClick,
    importing = false,
    showExport = false,
    onExportClick,
    paginacion,
    emptyMessage = 'No hay registros',
    emptyFilterMessage = 'Ningún resultado con el filtro',
    columnasMoneda = [],
    hideHeader = false,
    getRowStyle,
    dense = false,
    extraToolbarRight,
    extraToolbarLeft,
  } = props;

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  const hasImportExport = showImport || showExport;

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? (dense ? DENSE_COL_WIDTH : DEFAULT_COL_WIDTH), [columnWidths, dense]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !resizingCol) return;
    const handleMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const delta = e.clientX - r.startX;
      const next = Math.max(MIN_COL_WIDTH, r.startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [r.col]: next }));
    };
    const handleUp = () => {
      resizeRef.current = null;
      setResizingCol(null);
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [resizingCol]);

  const handleResizeStart = (col: string, e: { nativeEvent?: { clientX: number }; clientX?: number }) => {
    if (Platform.OS !== 'web') return;
    const clientX = e.nativeEvent?.clientX ?? (e as { clientX: number }).clientX ?? 0;
    resizeRef.current = { col, startX: clientX, startWidth: getColWidth(col) };
    setResizingCol(col);
  };

  const toolbarBtns = [
    { id: 'crear', label: 'Crear registro', icon: ICONS.add },
    { id: 'editar', label: 'Editar', icon: ICONS.edit },
    { id: 'borrar', label: 'Borrar', icon: ICONS.delete },
  ];

  const totalRegistros = paginacion?.totalRegistros ?? datos.length;
  const totalPages = paginacion
    ? Math.max(1, Math.ceil(paginacion.totalRegistros / paginacion.pageSize))
    : 1;
  const pageIndexClamped = paginacion
    ? Math.min(Math.max(0, paginacion.pageIndex), totalPages - 1)
    : 0;
  const subtitleText =
    totalRegistros === 0
      ? '0 registros'
      : paginacion && totalPages > 1
        ? `${pageIndexClamped * paginacion.pageSize + 1}–${Math.min(
            (pageIndexClamped + 1) * paginacion.pageSize,
            paginacion.totalRegistros
          )} de ${paginacion.totalRegistros} registro${paginacion.totalRegistros !== 1 ? 's' : ''}`
        : `${totalRegistros} registro${totalRegistros !== 1 ? 's' : ''}`;

  const seleccionarFila = (idx: number) => {
    onSelectRow(selectedRowIndex === idx ? null : idx);
  };

  const editDisabled = guardando || selectedRowIndex == null;
  const deleteDisabled = guardando || selectedRowIndex == null;

  if (loading && datos.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando…</Text>
      </View>
    );
  }

  if (error != null && error !== '' && datos.length === 0) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color="#f87171" />
        <Text style={styles.errorText}>{error}</Text>
        {onRetry && (
          <TouchableOpacity style={styles.retryBtn} onPress={onRetry}>
            <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {!hideHeader && (
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <Text style={styles.title}>{title}</Text>
        </View>
      )}

      <View style={styles.toolbarRow}>
        <View style={styles.toolbar}>
          {toolbarBtns.map((btn) => (
            <View
              key={btn.id}
              style={styles.toolbarBtnWrap}
              {...(Platform.OS === 'web'
                ? ({
                    onMouseEnter: () => setHoveredBtn(btn.id),
                    onMouseLeave: () => setHoveredBtn(null),
                  } as object)
                : {})}
            >
              {hoveredBtn === btn.id && (
                <View style={styles.tooltip}>
                  <Text style={styles.tooltipText}>{btn.label}</Text>
                </View>
              )}
              <TouchableOpacity
                style={[
                  styles.toolbarBtn,
                  (btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null && styles.toolbarBtnDisabled,
                ]}
                onPress={() => {
                  if (btn.id === 'crear') onCrear();
                  if (btn.id === 'editar' && selectedRowIndex != null) onEditar(datos[selectedRowIndex]);
                  if (btn.id === 'borrar' && selectedRowIndex != null) onBorrar(datos[selectedRowIndex]);
                }}
                disabled={
                  guardando ||
                  ((btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null)
                }
                accessibilityLabel={btn.label}
              >
                <MaterialIcons
                  name={btn.icon}
                  size={ICON_SIZE}
                  color={
                    guardando || (btn.id === 'editar' && editDisabled) || (btn.id === 'borrar' && deleteDisabled)
                      ? '#94a3b8'
                      : '#0ea5e9'
                  }
                />
              </TouchableOpacity>
            </View>
          ))}
        </View>
        {extraToolbarLeft ? <View style={styles.extraToolbarLeft}>{extraToolbarLeft}</View> : null}
        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={onFiltroChange}
            placeholder="Buscar en la tabla…"
            placeholderTextColor="#94a3b8"
          />
        </View>
        {hasImportExport && (
          <View style={styles.toolbarBtnWrap}>
            <View
              style={styles.importExportDropdownWrap}
              {...(Platform.OS === 'web'
                ? ({
                    onMouseEnter: () => setHoveredBtn('importexport'),
                    onMouseLeave: () => setHoveredBtn(null),
                  } as object)
                : {})}
            >
              {hoveredBtn === 'importexport' && !importExportOpen && (
                <View style={styles.tooltip}>
                  <Text style={styles.tooltipText}>Importar / Exportar Excel</Text>
                </View>
              )}
              <TouchableOpacity
                style={styles.toolbarBtn}
                onPress={() => setImportExportOpen((v) => !v)}
                disabled={guardando || importing}
                accessibilityLabel="Importar / Exportar Excel"
              >
                <MaterialIcons
                  name="import-export"
                  size={ICON_SIZE}
                  color={guardando || importing ? '#94a3b8' : '#0ea5e9'}
                />
              </TouchableOpacity>
            </View>
            <Modal
              visible={importExportOpen}
              transparent
              animationType="fade"
              onRequestClose={() => setImportExportOpen(false)}
            >
              <TouchableOpacity
                style={styles.importExportModalOverlay}
                activeOpacity={1}
                onPress={() => setImportExportOpen(false)}
              >
                <View style={styles.importExportModalContent}>
                  <View style={styles.importExportMenu}>
                    {showExport && onExportClick && (
                      <TouchableOpacity
                        style={[styles.importExportItem, (showExport && showImport) && styles.importExportItemBorder]}
                        onPress={() => {
                          setImportExportOpen(false);
                          onExportClick();
                        }}
                        disabled={guardando}
                        activeOpacity={0.7}
                      >
                        <MaterialIcons name="download" size={18} color="#0ea5e9" />
                        <Text style={styles.importExportItemText}>Exportar Excel</Text>
                      </TouchableOpacity>
                    )}
                    {showImport && onImportClick && (
                      <TouchableOpacity
                        style={styles.importExportItem}
                        onPress={() => {
                          setImportExportOpen(false);
                          onImportClick();
                        }}
                        disabled={guardando || importing}
                        activeOpacity={0.7}
                      >
                        <MaterialIcons name="upload-file" size={18} color="#0ea5e9" />
                      <Text style={styles.importExportItemText}>Importar Excel</Text>
                    </TouchableOpacity>
                  )}
                  </View>
                </View>
              </TouchableOpacity>
            </Modal>
          </View>
        )}
        {extraToolbarRight ? <View style={styles.extraToolbarRight}>{extraToolbarRight}</View> : null}
      </View>

      <View style={styles.subtitleRow}>
        <Text style={styles.subtitle}>{subtitleText}</Text>
        {paginacion && totalPages > 1 && (
          <View style={styles.pagination}>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped <= 0 && styles.pageBtnDisabled]}
              onPress={paginacion.onPrevPage}
              disabled={pageIndexClamped <= 0}
              accessibilityLabel="Página anterior"
            >
              <MaterialIcons
                name="chevron-left"
                size={20}
                color={pageIndexClamped <= 0 ? '#94a3b8' : '#0ea5e9'}
              />
            </TouchableOpacity>
            <Text style={styles.pageText}>
              Página {pageIndexClamped + 1} de {totalPages}
            </Text>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped >= totalPages - 1 && styles.pageBtnDisabled]}
              onPress={paginacion.onNextPage}
              disabled={pageIndexClamped >= totalPages - 1}
              accessibilityLabel="Página siguiente"
            >
              <MaterialIcons
                name="chevron-right"
                size={20}
                color={pageIndexClamped >= totalPages - 1 ? '#94a3b8' : '#0ea5e9'}
              />
            </TouchableOpacity>
          </View>
        )}
      </View>

      <View style={styles.tableWrapper}>
        <ScrollView
          horizontal
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsHorizontalScrollIndicator
        >
          <View style={styles.table}>
            <View style={[styles.rowHeader, dense && styles.rowHeaderDense]}>
              {columnas.map((col) => {
                const isMoneda = columnasMoneda.some((c) => c.toLowerCase() === col.toLowerCase());
                return (
                <View key={col} style={[styles.cellHeader, dense && styles.cellHeaderDense, { width: getColWidth(col) }, isMoneda && styles.cellHeaderRight]}>
                  <Text style={[styles.cellHeaderText, dense && styles.cellHeaderTextDense, isMoneda && styles.cellHeaderTextRight]} numberOfLines={1} ellipsizeMode="tail">
                    {col}
                  </Text>
                  {Platform.OS === 'web' && (
                    <View
                      style={styles.resizeHandle}
                      {...({
                        onMouseDown: (e: {
                          nativeEvent?: { clientX: number };
                          clientX?: number;
                        }) => handleResizeStart(col, e),
                      } as object)}
                    />
                  )}
                </View>
              );})}
            </View>
            <ScrollView
              style={styles.tableBodyScroll}
              contentContainerStyle={styles.tableBodyContent}
              showsVerticalScrollIndicator
              nestedScrollEnabled
            >
              {datos.length === 0 ? (
                <View style={styles.row}>
                  <View style={styles.cellEmpty}>
                    <Text style={styles.cellEmptyText}>
                      {filtroBusqueda.trim() ? emptyFilterMessage : emptyMessage}
                    </Text>
                  </View>
                </View>
              ) : (
                datos.map((item, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={[
                      styles.row,
                      dense && styles.rowDense,
                      selectedRowIndex === idx && styles.rowSelected,
                      getRowStyle?.(item, idx),
                    ]}
                    onPress={() => seleccionarFila(idx)}
                    activeOpacity={0.8}
                  >
                    {columnas.map((col) => {
                      const raw = getValorCelda(item, col);
                      const text = raw.length > MAX_TEXT_LENGTH ? truncar(raw) : raw;
                      const isMoneda = columnasMoneda.some((c) => c.toLowerCase() === col.toLowerCase());
                      return (
                        <View key={col} style={[styles.cell, dense && styles.cellDense, { width: getColWidth(col) }, isMoneda && styles.cellRight]}>
                          <Text style={[styles.cellText, dense && styles.cellTextDense, isMoneda && styles.cellTextRight]} numberOfLines={1} ellipsizeMode="tail">
                            {text}
                          </Text>
                        </View>
                      );
                    })}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
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
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    padding: 8,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  retryBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  searchWrap: {
    flex: 1,
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
  toolbarBtnWrap: { position: 'relative' },
  extraToolbarLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  extraToolbarRight: { marginLeft: 4 },
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
  toolbarBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
  },
  toolbarBtnDisabled: { opacity: 0.6 },
  importExportDropdownWrap: { position: 'relative' },
  importExportModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 100,
    paddingRight: 20,
  },
  importExportModalContent: { alignItems: 'flex-end' },
  importExportMenu: {
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 8,
    minWidth: 160,
  },
  importExportItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  importExportItemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  importExportItemText: { fontSize: 13, color: '#334155', fontWeight: '500' },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 12,
    flexWrap: 'wrap',
  },
  subtitle: { fontSize: 12, color: '#64748b' },
  pagination: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pageBtn: { padding: 4 },
  pageBtnDisabled: { opacity: 0.5 },
  pageText: { fontSize: 11, color: '#64748b', marginHorizontal: 4 },
  tableWrapper: { flex: 1, minHeight: 0 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20 },
  table: {
    flex: 1,
    minWidth: '100%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  tableBodyScroll: { flex: 1 },
  tableBodyContent: { paddingBottom: 20 },
  rowHeader: {
    flexDirection: 'row',
    backgroundColor: '#e2e8f0',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
  },
  rowHeaderDense: { minHeight: 20 },
  cellHeader: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRightWidth: 1,
    borderRightColor: '#cbd5e1',
    position: 'relative',
  },
  cellHeaderText: { fontSize: 11, fontWeight: '600', color: '#334155' },
  cellHeaderTextDense: { fontSize: 9 },
  cellHeaderDense: { paddingVertical: 2, paddingHorizontal: 6 },
  cellHeaderTextRight: { textAlign: 'right' },
  cellHeaderRight: { alignItems: 'flex-end' },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize' as 'pointer',
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  rowDense: { minHeight: 18 },
  rowSelected: { backgroundColor: '#e0f2fe' },
  cell: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
  },
  cellDense: { paddingVertical: 1, paddingHorizontal: 6 },
  cellRight: { alignItems: 'flex-end' },
  cellText: { fontSize: 11, color: '#475569' },
  cellTextDense: { fontSize: 9 },
  cellTextRight: { textAlign: 'right', alignSelf: 'stretch' },
  cellEmpty: {
    flex: 1,
    paddingVertical: 24,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellEmptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
});
