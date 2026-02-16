import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Modal,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { ICONS, ICON_SIZE } from '../constants/icons';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const DEFAULT_COL_WIDTH = 120;
const MIN_COL_WIDTH = 60;
const MAX_TEXT_LENGTH = 30;
const PAGE_SIZE = 50;

const COLUMNAS_PERMISOS = ['rol', 'permiso'] as const;

const ROLES_OPCIONES = ['Administrador', 'SuperUser', 'Administracion', 'Local', 'Socio'] as const;
const PERMISOS_CODIGOS = [
  'base_datos.ver',
  'mantenimiento.ver',
  'compras.ver',
  'cajas.ver',
  'cashflow.ver',
  'actuaciones.ver',
  'rrpp.ver',
  'mystery_guest.ver',
  'reservas.ver',
] as const;

const PERMISOS_LABELS: Record<string, string> = {
  'base_datos.ver': 'Base de datos',
  'mantenimiento.ver': 'Mantenimiento',
  'compras.ver': 'Compras',
  'cajas.ver': 'Cajas',
  'cashflow.ver': 'Cashflow',
  'actuaciones.ver': 'Actuaciones',
  'rrpp.ver': 'Rrpp',
  'mystery_guest.ver': 'Mystery Guest',
  'reservas.ver': 'Reservas',
};

type ItemPermiso = { rol: string; permiso: string };

function truncar(val: string): string {
  if (val.length <= MAX_TEXT_LENGTH) return val;
  return val.slice(0, MAX_TEXT_LENGTH - 3) + '…';
}

export default function PermisosScreen() {
  const router = useRouter();
  const [items, setItems] = useState<ItemPermiso[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ rol: 140, permiso: 160 });
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingItem, setEditingItem] = useState<ItemPermiso | null>(null);
  const [formRol, setFormRol] = useState('');
  const [formPermiso, setFormPermiso] = useState('');
  const [formPermisos, setFormPermisos] = useState<string[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    fetch(`${API_URL}/api/permisos/todos`)
      .then((res) => res.json())
      .then((data: { items?: ItemPermiso[]; error?: string }) => {
        if (data.error) setError(data.error);
        else setItems(data.items || []);
      })
      .catch((e) => setError(e?.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const abrirModalNuevo = () => {
    setEditingItem(null);
    setFormRol(ROLES_OPCIONES[0]);
    setFormPermiso('');
    setFormPermisos([]);
    setModalVisible(true);
    setErrorForm(null);
  };

  const abrirModalEditar = (item: ItemPermiso) => {
    setEditingItem(item);
    setFormRol(item.rol);
    setFormPermiso(item.permiso);
    setFormPermisos([]);
    setModalVisible(true);
    setErrorForm(null);
  };

  const cerrarModal = () => {
    setModalVisible(false);
    setEditingItem(null);
    setErrorForm(null);
  };

  const togglePermiso = (codigo: string) => {
    setFormPermisos((prev) =>
      prev.includes(codigo) ? prev.filter((p) => p !== codigo) : [...prev, codigo]
    );
  };

  const seleccionarTodosPermisos = () => {
    setFormPermisos([...PERMISOS_CODIGOS]);
  };

  const quitarTodosPermisos = () => {
    setFormPermisos([]);
  };

  const guardar = async () => {
    const rol = formRol.trim();
    if (!rol) {
      setErrorForm('El rol es obligatorio');
      return;
    }
    setErrorForm(null);
    setGuardando(true);
    try {
      if (editingItem) {
        const permiso = formPermiso.trim();
        if (!permiso) {
          setErrorForm('El permiso es obligatorio');
          setGuardando(false);
          return;
        }
        if (editingItem.rol !== rol || editingItem.permiso !== permiso) {
          const delRes = await fetch(`${API_URL}/api/permisos`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rol: editingItem.rol, permiso: editingItem.permiso }),
          });
          if (!delRes.ok) {
            const data = await delRes.json();
            setErrorForm(data.error || 'Error al actualizar');
            setGuardando(false);
            return;
          }
        }
        if (editingItem.rol === rol && editingItem.permiso === permiso) {
          cerrarModal();
          setGuardando(false);
          return;
        }
        const res = await fetch(`${API_URL}/api/permisos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rol, permiso }),
        });
        const data = await res.json();
        if (!res.ok) {
          setErrorForm(data.error || 'Error al guardar');
          setGuardando(false);
          return;
        }
      } else {
        if (formPermisos.length === 0) {
          setErrorForm('Selecciona al menos un permiso');
          setGuardando(false);
          return;
        }
        let failed = false;
        for (const permiso of formPermisos) {
          const res = await fetch(`${API_URL}/api/permisos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rol, permiso }),
          });
          const data = await res.json();
          if (!res.ok) {
            setErrorForm(data.error || `Error al guardar ${permiso}`);
            failed = true;
            break;
          }
        }
        if (failed) {
          setGuardando(false);
          return;
        }
      }
      refetch();
      setSelectedRowIndex(null);
      cerrarModal();
    } catch (e) {
      setErrorForm('No se pudo conectar con el servidor');
    } finally {
      setGuardando(false);
    }
  };

  const borrarSeleccionado = async () => {
    if (selectedRowIndex == null) return;
    const item = itemsFiltrados[selectedRowIndex];
    if (!item) return;
    setGuardando(true);
    try {
      const res = await fetch(`${API_URL}/api/permisos`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rol: item.rol, permiso: item.permiso }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al borrar');
        return;
      }
      refetch();
      setSelectedRowIndex(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const toolbarBtns = [
    { id: 'crear', label: 'Crear registro', icon: ICONS.add },
    { id: 'editar', label: 'Editar', icon: ICONS.edit },
    { id: 'borrar', label: 'Borrar', icon: ICONS.delete },
  ];

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? DEFAULT_COL_WIDTH, [columnWidths]);
  const columnas = useMemo(() => [...COLUMNAS_PERMISOS], []);

  const valorCelda = useCallback((item: ItemPermiso, col: string) => {
    const v = col === 'rol' ? item.rol : item.permiso;
    return (v ?? '').toString().trim() || '—';
  }, []);

  const itemsFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (x) =>
        (x.rol || '').toLowerCase().includes(q) || (x.permiso || '').toLowerCase().includes(q)
    );
  }, [items, filtroBusqueda]);

  const totalRegistros = itemsFiltrados.length;
  const totalPages = Math.max(1, Math.ceil(totalRegistros / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const itemsPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return itemsFiltrados.slice(start, start + PAGE_SIZE);
  }, [itemsFiltrados, pageIndexClamped]);

  useEffect(() => {
    setPageIndex((p) => (p >= totalPages ? Math.max(0, totalPages - 1) : p));
  }, [totalPages]);
  useEffect(() => {
    setPageIndex(0);
  }, [filtroBusqueda]);

  const goPrevPage = () => {
    setPageIndex((p) => Math.max(0, p - 1));
    setSelectedRowIndex(null);
  };
  const goNextPage = () => {
    setPageIndex((p) => Math.min(totalPages - 1, p + 1));
    setSelectedRowIndex(null);
  };

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

  if (loading && items.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando permisos…</Text>
      </View>
    );
  }

  if (error && items.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <Text style={styles.title}>Permisos</Text>
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
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Permisos</Text>
      </View>

      <View style={styles.toolbarRow}>
        <View style={styles.toolbar}>
          {toolbarBtns.map((btn) => (
            <View
              key={btn.id}
              style={styles.toolbarBtnWrap}
              {...(Platform.OS === 'web'
                ? ({ onMouseEnter: () => setHoveredBtn(btn.id), onMouseLeave: () => setHoveredBtn(null) } as object)
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
                  if (btn.id === 'crear') abrirModalNuevo();
                  if (btn.id === 'editar' && selectedRowIndex != null) abrirModalEditar(itemsPagina[selectedRowIndex]);
                  if (btn.id === 'borrar' && selectedRowIndex != null) borrarSeleccionado();
                }}
                disabled={guardando || ((btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null)}
                accessibilityLabel={btn.label}
              >
                <MaterialIcons
                  name={btn.icon}
                  size={ICON_SIZE}
                  color={
                    guardando || ((btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null)
                      ? '#94a3b8'
                      : '#0ea5e9'
                  }
                />
              </TouchableOpacity>
            </View>
          ))}
        </View>
        <View
          style={styles.toolbarBtnWrap}
          {...(Platform.OS === 'web'
            ? ({ onMouseEnter: () => setHoveredBtn('actualizar'), onMouseLeave: () => setHoveredBtn(null) } as object)
            : {})}
        >
          {hoveredBtn === 'actualizar' && (
            <View style={styles.tooltip}>
              <Text style={styles.tooltipText}>Actualizar</Text>
            </View>
          )}
          <TouchableOpacity
            style={styles.toolbarBtn}
            onPress={refetch}
            disabled={loading}
            accessibilityLabel="Actualizar"
          >
            <MaterialIcons name="refresh" size={ICON_SIZE} color={loading ? '#94a3b8' : '#0ea5e9'} />
          </TouchableOpacity>
        </View>
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

      <ScrollView horizontal style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.table}>
          <View style={styles.rowHeader}>
            {columnas.map((col) => (
              <View key={col} style={[styles.cellHeader, { width: getColWidth(col) }]}>
                <Text style={styles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">
                  {col}
                </Text>
                {Platform.OS === 'web' && (
                  <View
                    style={styles.resizeHandle}
                    onMouseDown={(e: { nativeEvent?: { clientX: number }; clientX?: number }) =>
                      handleResizeStart(col, e)
                    }
                  />
                )}
              </View>
            ))}
          </View>
          {itemsPagina.map((item, idx) => (
            <TouchableOpacity
              key={`${item.rol}-${item.permiso}-${idx}`}
              style={[styles.row, selectedRowIndex === idx && styles.rowSelected]}
              onPress={() => setSelectedRowIndex(selectedRowIndex === idx ? null : idx)}
              activeOpacity={0.8}
            >
              {columnas.map((col) => {
                const raw = valorCelda(item, col);
                const text = raw.length > MAX_TEXT_LENGTH ? truncar(raw) : raw;
                return (
                  <View key={col} style={[styles.cell, { width: getColWidth(col) }]}>
                    <Text style={styles.cellText} numberOfLines={1} ellipsizeMode="tail">
                      {text}
                    </Text>
                  </View>
                );
              })}
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={cerrarModal}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView
            style={styles.modalContentWrap}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardTouch}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <View>
                    <Text style={styles.modalTitle}>
                      {editingItem ? 'Editar permiso' : 'Nuevo permiso'}
                    </Text>
                    <Text style={styles.modalSubtitle}>
                      Asigna un permiso de acceso a un rol.
                    </Text>
                  </View>
                  <TouchableOpacity onPress={cerrarModal} style={styles.modalClose}>
                    <MaterialIcons name="close" size={22} color="#64748b" />
                  </TouchableOpacity>
                </View>
                <View style={styles.modalBody}>
                  <View style={styles.modalBodyRow}>
                    <View style={styles.modalBodyColLeft}>
                      <Text style={styles.formLabel}>Rol</Text>
                      <View style={[styles.selectBox, styles.selectBoxRol]}>
                        <View style={styles.rolesGrid}>
                          {ROLES_OPCIONES.map((r) => (
                            <TouchableOpacity
                              key={r}
                              style={[styles.selectOption, formRol === r && styles.selectOptionSelected]}
                              onPress={() => setFormRol(r)}
                              activeOpacity={0.7}
                            >
                              <Text style={[styles.selectOptionText, formRol === r && styles.selectOptionTextSelected]}>
                                {r}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      </View>
                    </View>
                    <View style={styles.modalBodyColRight}>
                      <View style={styles.formLabelRow}>
                        <Text style={styles.formLabel}>
                          {editingItem ? 'Permiso' : 'Permisos (selección múltiple)'}
                        </Text>
                        {!editingItem && (
                          <View style={styles.formLabelActions}>
                            <TouchableOpacity onPress={seleccionarTodosPermisos} style={styles.linkBtn}>
                              <Text style={styles.linkBtnText}>Seleccionar todos</Text>
                            </TouchableOpacity>
                            <Text style={styles.formLabelDot}>·</Text>
                            <TouchableOpacity onPress={quitarTodosPermisos} style={styles.linkBtn}>
                              <Text style={styles.linkBtnText}>Quitar todos</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </View>
                      <View style={styles.selectBox}>
                        <ScrollView style={styles.permisosListScroll} nestedScrollEnabled showsVerticalScrollIndicator>
                          <View style={styles.permisosListInner}>
                            {PERMISOS_CODIGOS.map((p) => {
                              const selected = editingItem ? formPermiso === p : formPermisos.includes(p);
                              return (
                                <TouchableOpacity
                                  key={p}
                                  style={[styles.selectOptionRow, selected && styles.selectOptionSelected]}
                                  onPress={() =>
                                    editingItem ? setFormPermiso(p) : togglePermiso(p)
                                  }
                                  activeOpacity={0.7}
                                >
                                  {!editingItem && (
                                    <View style={[styles.checkbox, selected && styles.checkboxChecked]}>
                                      {selected ? (
                                        <MaterialIcons name="check" size={14} color="#fff" />
                                      ) : null}
                                    </View>
                                  )}
                                  <Text style={[styles.selectOptionText, selected && styles.selectOptionTextSelected]} numberOfLines={1}>
                                    {PERMISOS_LABELS[p] ?? p}
                                  </Text>
                                  <Text style={styles.selectOptionCode} numberOfLines={1}>{p}</Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        </ScrollView>
                      </View>
                      {!editingItem && formPermisos.length > 0 && (
                        <Text style={styles.formHint}>
                          {formPermisos.length} permiso{formPermisos.length !== 1 ? 's' : ''} seleccionado{formPermisos.length !== 1 ? 's' : ''}. Se crearán {formPermisos.length} registro{formPermisos.length !== 1 ? 's' : ''} para el rol «{formRol}».
                        </Text>
                      )}
                    </View>
                  </View>
                </View>
                {errorForm ? <View style={styles.modalErrorWrap}><MaterialIcons name="error-outline" size={16} color="#dc2626" /><Text style={styles.modalError}>{errorForm}</Text></View> : null}
                <View style={styles.modalFooter}>
                  <TouchableOpacity
                    style={styles.modalFooterBtnSecondary}
                    onPress={cerrarModal}
                    disabled={guardando}
                    accessibilityLabel="Cancelar"
                  >
                    <Text style={styles.modalFooterBtnSecondaryText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalFooterBtnPrimary, guardando && styles.modalFooterBtnDisabled]}
                    onPress={guardar}
                    disabled={guardando}
                    accessibilityLabel={editingItem ? 'Guardar' : 'Añadir'}
                  >
                    {guardando ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <MaterialIcons name={editingItem ? 'save' : ICONS.add} size={ICON_SIZE} color="#fff" />
                        <Text style={styles.modalFooterBtnPrimaryText}>{editingItem ? 'Guardar' : 'Añadir'}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>
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
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize' as 'pointer',
  },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', backgroundColor: '#fff' },
  rowSelected: { backgroundColor: '#e0f2fe' },
  cell: { minWidth: MIN_COL_WIDTH, paddingVertical: 4, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  cellText: { fontSize: 11, color: '#475569' },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalContentWrap: { width: '100%', maxWidth: 720, padding: 24, alignItems: 'center' },
  modalCardTouch: { width: '100%' },
  modalCard: {
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#334155', marginBottom: 4 },
  modalSubtitle: { fontSize: 13, color: '#64748b', lineHeight: 18 },
  modalClose: { padding: 4, marginTop: -4 },
  modalBody: { paddingHorizontal: 24, paddingVertical: 20 },
  modalBodyRow: { flexDirection: 'row', gap: 24, alignItems: 'stretch', minHeight: 320 },
  modalBodyColLeft: { width: '38%', minWidth: 0, flexDirection: 'column' },
  modalBodyColRight: { flex: 1, minWidth: 0, flexDirection: 'column' },
  formGroup: { marginBottom: 20 },
  formLabel: { fontSize: 12, fontWeight: '600', color: '#334155', marginBottom: 8 },
  formLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 6 },
  formLabelActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  linkBtn: { paddingVertical: 2, paddingHorizontal: 4 },
  linkBtnText: { fontSize: 11, color: '#0ea5e9', fontWeight: '500' },
  formLabelDot: { fontSize: 11, color: '#94a3b8' },
  formHint: { fontSize: 11, color: '#64748b', marginTop: 8, lineHeight: 16 },
  selectBox: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 12,
  },
  selectBoxRol: { flex: 1, minHeight: 280 },
  rolesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  selectOption: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    minWidth: '30%',
  },
  permisosListInner: { gap: 6 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  selectOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  selectOptionSelected: {
    backgroundColor: '#e0f2fe',
    borderColor: '#0ea5e9',
    borderWidth: 1,
  },
  selectOptionText: { fontSize: 13, color: '#334155', fontWeight: '500', flex: 1 },
  selectOptionTextSelected: { color: '#0369a1', fontWeight: '600' },
  selectOptionCode: { fontSize: 11, color: '#94a3b8', marginLeft: 8 },
  permisosListScroll: { flex: 1, minHeight: 260, maxHeight: 320 },
  modalErrorWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#fef2f2',
    marginHorizontal: 24,
    marginBottom: 8,
    borderRadius: 8,
  },
  modalError: { fontSize: 12, color: '#dc2626', flex: 1 },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  modalFooterBtnSecondary: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  modalFooterBtnSecondaryText: { fontSize: 14, color: '#64748b', fontWeight: '500' },
  modalFooterBtnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#0ea5e9',
  },
  modalFooterBtnPrimaryText: { fontSize: 14, color: '#fff', fontWeight: '600' },
  modalFooterBtnDisabled: { opacity: 0.7 },
});
