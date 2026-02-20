import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
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
import { formatId6 } from '../utils/idFormat';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const DEFAULT_COL_WIDTH = 90;
const MIN_COL_WIDTH = 40;
const MAX_TEXT_LENGTH = 30;

const ATRIBUTOS_TABLA_ALMACENES = ['id_Almacenes', 'Nombre', 'Descripcion', 'Direccion'] as const;
const ORDEN_COLUMNAS = [...ATRIBUTOS_TABLA_ALMACENES];

const CAMPOS_FORM: { key: (typeof ATRIBUTOS_TABLA_ALMACENES)[number]; label: string }[] = [
  { key: 'Nombre', label: 'Nombre' },
  { key: 'Descripcion', label: 'Descripción' },
  { key: 'Direccion', label: 'Dirección' },
];

const INITIAL_FORM = Object.fromEntries(CAMPOS_FORM.map((c) => [c.key, ''])) as Record<
  (typeof ATRIBUTOS_TABLA_ALMACENES)[number],
  string
>;

type Almacen = Record<string, string | number | undefined>;

function truncar(val: string): string {
  if (val.length <= MAX_TEXT_LENGTH) return val;
  return val.slice(0, MAX_TEXT_LENGTH - 3) + '…';
}

export default function AlmacenesScreen() {
  const router = useRouter();
  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ Nombre: 180 });
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [modalNuevoVisible, setModalNuevoVisible] = useState(false);
  const [editingAlmacenId, setEditingAlmacenId] = useState<string | null>(null);
  const [formNuevo, setFormNuevo] = useState<Record<string, string>>(INITIAL_FORM);
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  const valorEnLocal = useCallback((item: Almacen, key: string) => {
    if (item[key] !== undefined && item[key] !== null) return item[key];
    const found = Object.keys(item).find((k) => k.toLowerCase() === key.toLowerCase());
    return found != null ? item[found] : undefined;
  }, []);

  const abrirModalNuevo = () => {
    setEditingAlmacenId(null);
    setFormNuevo(INITIAL_FORM);
    setModalNuevoVisible(true);
    setErrorForm(null);
  };

  const abrirModalEditar = (almacen: Almacen) => {
    const form: Record<string, string> = { ...INITIAL_FORM };
    for (const key of CAMPOS_FORM.map((c) => c.key)) {
      const v = valorEnLocal(almacen, key);
      form[key] = v != null ? String(v) : '';
    }
    setFormNuevo(form);
    const idVal = valorEnLocal(almacen, 'id_Almacenes');
    setEditingAlmacenId(idVal != null ? String(idVal) : null);
    setModalNuevoVisible(true);
    setErrorForm(null);
  };

  const cerrarModalNuevo = () => {
    setModalNuevoVisible(false);
    setFormNuevo(INITIAL_FORM);
    setEditingAlmacenId(null);
    setErrorForm(null);
  };

  const ordenarPorId = useCallback((lista: Almacen[]) => {
    return [...lista].sort((a, b) => {
      const idA = valorEnLocal(a, 'id_Almacenes');
      const idB = valorEnLocal(b, 'id_Almacenes');
      const na = typeof idA === 'number' ? idA : parseInt(String(idA ?? 0).replace(/^0+/, ''), 10) || 0;
      const nb = typeof idB === 'number' ? idB : parseInt(String(idB ?? 0).replace(/^0+/, ''), 10) || 0;
      return na - nb;
    });
  }, [valorEnLocal]);

  const refetchAlmacenes = useCallback(() => {
    fetch(`${API_URL}/api/almacenes`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setAlmacenes(ordenarPorId(data.almacenes || []));
      })
      .catch((e) => setError(e.message || 'Error de conexión'));
  }, [ordenarPorId]);

  const guardarNuevo = async () => {
    if (!formNuevo.Nombre?.trim()) {
      setErrorForm('Nombre es obligatorio');
      return;
    }
    setErrorForm(null);
    setGuardando(true);
    try {
      const body: Record<string, string> = {};
      for (const key of ATRIBUTOS_TABLA_ALMACENES) {
        if (key === 'id_Almacenes') body[key] = editingAlmacenId != null ? editingAlmacenId : próximoId;
        else body[key] = formNuevo[key] ?? '';
      }
      const res = await fetch(`${API_URL}/api/almacenes`, {
        method: editingAlmacenId != null ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al guardar');
        return;
      }
      refetchAlmacenes();
      setSelectedRowIndex(null);
      cerrarModalNuevo();
    } catch (e) {
      setErrorForm('No se pudo conectar con el servidor');
    } finally {
      setGuardando(false);
    }
  };

  const borrarSeleccionado = async () => {
    if (selectedRowIndex == null) return;
    const almacen = almacenesFiltrados[selectedRowIndex];
    const id = valorEnLocal(almacen, 'id_Almacenes');
    const idStr = id != null ? String(id) : '';
    if (!idStr) return;
    setGuardando(true);
    try {
      const res = await fetch(`${API_URL}/api/almacenes`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_Almacenes: idStr }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al borrar');
        return;
      }
      refetchAlmacenes();
      setSelectedRowIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const próximoId = useMemo(() => {
    if (!almacenes.length) return formatId6(1);
    const ids = almacenes.map((u) => {
      const v = valorEnLocal(u, 'id_Almacenes');
      const n = typeof v === 'number' ? v : parseInt(String(v ?? 0).replace(/^0+/, ''), 10);
      return Number.isNaN(n) ? 0 : n;
    });
    return formatId6(Math.max(0, ...ids) + 1);
  }, [almacenes, valorEnLocal]);

  const seleccionarFila = (idx: number) => {
    setSelectedRowIndex((prev) => (prev === idx ? null : idx));
  };

  const toolbarBtns = [
    { id: 'crear', label: 'Crear registro', icon: ICONS.add },
    { id: 'editar', label: 'Editar', icon: ICONS.edit },
    { id: 'borrar', label: 'Borrar', icon: ICONS.delete },
  ];

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? DEFAULT_COL_WIDTH, [columnWidths]);
  const columnas = useMemo(() => [...ORDEN_COLUMNAS], []);

  const valorCelda = useCallback((almacen: Almacen, col: string) => {
    if (col.startsWith('id_')) {
      const key = Object.keys(almacen).find((k) => k.toLowerCase() === col.toLowerCase());
      const raw = key != null ? almacen[key] : almacen[col as keyof Almacen];
      return raw != null ? formatId6(raw) : '—';
    }
    const key = Object.keys(almacen).find((k) => k.toLowerCase() === col.toLowerCase());
    const raw = key != null ? almacen[key] : almacen[col as keyof Almacen];
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') return String(raw);
    return '—';
  }, []);

  const almacenesFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return almacenes;
    return almacenes.filter((u) =>
      columnas.some((col) => {
        const val = valorCelda(u, col);
        return val !== '—' && val.toLowerCase().includes(q);
      })
    );
  }, [almacenes, filtroBusqueda, columnas, valorCelda]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/almacenes`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setAlmacenes(ordenarPorId(data.almacenes || []));
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Error de conexión');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ordenarPorId]);

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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando almacenes…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color="#f87171" />
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Almacenes</Text>
      </View>

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
                  if (btn.id === 'crear') abrirModalNuevo();
                  if (btn.id === 'editar' && selectedRowIndex != null) abrirModalEditar(almacenesFiltrados[selectedRowIndex]);
                  if (btn.id === 'borrar' && selectedRowIndex != null) borrarSeleccionado();
                }}
                disabled={guardando || ((btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null)}
                accessibilityLabel={btn.label}
              >
                <MaterialIcons
                  name={btn.icon as any}
                  size={ICON_SIZE}
                  color={guardando || ((btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null) ? '#94a3b8' : '#0ea5e9'}
                />
              </TouchableOpacity>
            </View>
          ))}
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
      </View>

      <ScrollView horizontal style={styles.scrollTable} contentContainerStyle={styles.scrollTableContent} showsHorizontalScrollIndicator>
        <View style={styles.tableWrap}>
          <View style={styles.tableRowHeader}>
            {columnas.map((col) => (
              <View
                key={col}
                style={[styles.tableCellHeader, { width: getColWidth(col) }]}
                {...(Platform.OS === 'web' ? { onMouseDown: (e: any) => handleResizeStart(col, e) } : {})}
              >
                <Text style={styles.tableCellHeaderText}>{truncar(col)}</Text>
              </View>
            ))}
          </View>
          {almacenesFiltrados.length === 0 ? (
            <View style={styles.emptyRow}>
              <Text style={styles.emptyText}>No hay almacenes. Pulsa Crear para añadir uno.</Text>
            </View>
          ) : (
            almacenesFiltrados.map((almacen, idx) => (
              <TouchableOpacity
                key={valorCelda(almacen, 'id_Almacenes') + '-' + idx}
                style={[styles.tableRow, selectedRowIndex === idx && styles.tableRowSelected]}
                onPress={() => seleccionarFila(idx)}
                activeOpacity={0.7}
              >
                {columnas.map((col) => (
                  <View key={col} style={[styles.tableCell, { width: getColWidth(col) }]}>
                    <Text style={styles.tableCellText} numberOfLines={1}>
                      {truncar(valorCelda(almacen, col))}
                    </Text>
                  </View>
                ))}
              </TouchableOpacity>
            ))
          )}
        </View>
      </ScrollView>

      <Modal visible={modalNuevoVisible} transparent animationType="fade">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{editingAlmacenId != null ? 'Editar almacén' : 'Nuevo almacén'}</Text>
            {CAMPOS_FORM.map(({ key, label }) => (
              <View key={key} style={styles.formRow}>
                <Text style={styles.formLabel}>{label}</Text>
                <TextInput
                  style={styles.formInput}
                  value={formNuevo[key] ?? ''}
                  onChangeText={(t) => setFormNuevo((prev) => ({ ...prev, [key]: t }))}
                  placeholder={label}
                  placeholderTextColor="#94a3b8"
                />
              </View>
            ))}
            {errorForm ? <Text style={styles.errorForm}>{errorForm}</Text> : null}
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalBtnCancel} onPress={cerrarModalNuevo} disabled={guardando}>
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnSave} onPress={guardarNuevo} disabled={guardando}>
                {guardando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalBtnSaveText}>Guardar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { fontSize: 14, color: '#64748b' },
  errorText: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  backBtn: { padding: 4, marginRight: 8 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
  toolbar: { flexDirection: 'row', gap: 4 },
  toolbarBtnWrap: { position: 'relative' },
  toolbarBtn: { padding: 6 },
  toolbarBtnDisabled: { opacity: 0.5 },
  tooltip: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    marginBottom: 4,
    backgroundColor: '#334155',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    zIndex: 10,
  },
  tooltipText: { fontSize: 11, color: '#f8fafc' },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: 8, paddingHorizontal: 10 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: 14, color: '#334155' },
  scrollTable: { flex: 1 },
  scrollTableContent: { flexGrow: 1 },
  tableWrap: { backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  tableRowHeader: { flexDirection: 'row', backgroundColor: '#f1f5f9', borderBottomWidth: 2, borderBottomColor: '#e2e8f0' },
  tableCellHeader: { paddingVertical: 10, paddingHorizontal: 10 },
  tableCellHeaderText: { fontSize: 12, fontWeight: '700', color: '#475569' },
  tableRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e2e8f0' },
  tableRowSelected: { backgroundColor: '#e0f2fe' },
  tableCell: { paddingVertical: 8, paddingHorizontal: 10 },
  tableCellText: { fontSize: 13, color: '#334155' },
  emptyRow: { padding: 24, alignItems: 'center' },
  emptyText: { fontSize: 14, color: '#94a3b8', fontStyle: 'italic' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 16 },
  formRow: { marginBottom: 12 },
  formLabel: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 4 },
  formInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#334155',
  },
  errorForm: { fontSize: 12, color: '#dc2626', marginBottom: 8 },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  modalBtnCancel: { paddingVertical: 10, paddingHorizontal: 16 },
  modalBtnCancelText: { fontSize: 14, color: '#64748b' },
  modalBtnSave: {
    backgroundColor: '#0ea5e9',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    minWidth: 100,
    alignItems: 'center',
  },
  modalBtnSaveText: { fontSize: 14, fontWeight: '600', color: '#fff' },
});
