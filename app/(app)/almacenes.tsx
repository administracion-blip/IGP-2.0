import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Modal,
  Platform,
  KeyboardAvoidingView,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { ICONS, ICON_SIZE } from '../constants/icons';
import { erpTableStyles } from '../constants/erpTableStyles';
import { colors, iconSize } from '../constants/theme';
import { EstadoVacio } from '../components/ui/EstadoVacio';
import { formatId6 } from '../utils/idFormat';
import { apiFetch } from '../utils/api';

const DEFAULT_COL_WIDTH = 90;
const MIN_COL_WIDTH = 40;
const MAX_TEXT_LENGTH = 30;

const ATRIBUTOS_TABLA_ALMACENES = ['Id', 'Nombre', 'NombreFiscal', 'Cif', 'Descripcion', 'Direccion'] as const;
const COL_LOCALES_ASIGNADOS = 'Locales asignados';
const ORDEN_COLUMNAS = [...ATRIBUTOS_TABLA_ALMACENES, COL_LOCALES_ASIGNADOS];

const COL_LABELS: Record<string, string> = {
  Id: 'ID',
  Nombre: 'Nombre',
  NombreFiscal: 'Nombre fiscal',
  Cif: 'CIF',
  Descripcion: 'Descripción',
  Direccion: 'Dirección',
  [COL_LOCALES_ASIGNADOS]: 'Locales asignados',
};

function labelColumna(col: string): string {
  return (COL_LABELS[col] ?? col).toUpperCase();
}

function parseAlmacenesOrigen(val: string | number | undefined): string[] {
  if (val == null || String(val).trim() === '') return [];
  return String(val)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const CAMPOS_FORM: { key: (typeof ATRIBUTOS_TABLA_ALMACENES)[number]; label: string }[] = [
  { key: 'Nombre', label: 'Nombre' },
  { key: 'NombreFiscal', label: 'Nombre fiscal' },
  { key: 'Cif', label: 'CIF' },
  { key: 'Descripcion', label: 'Descripción' },
  { key: 'Direccion', label: 'Dirección' },
];

const INITIAL_FORM = Object.fromEntries(CAMPOS_FORM.map((c) => [c.key, ''])) as Record<
  (typeof ATRIBUTOS_TABLA_ALMACENES)[number],
  string
>;

type Almacen = Record<string, string | number | undefined>;
type Local = Record<string, string | number | undefined>;

type ToolbarBtnId = 'editar' | 'borrar' | 'sync';

const TOOLBAR_SECUNDARIOS: {
  id: ToolbarBtnId;
  label: string;
  icon: ComponentProps<typeof MaterialIcons>['name'];
}[] = [
  { id: 'editar', label: 'Editar', icon: ICONS.edit },
  { id: 'borrar', label: 'Borrar', icon: ICONS.delete },
  { id: 'sync', label: 'Sincronizar desde Ágora', icon: 'sync' },
];

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
  const [sincronizando, setSincronizando] = useState(false);
  const [locales, setLocales] = useState<Local[]>([]);
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
    const idVal = valorEnLocal(almacen, 'Id');
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
      const idA = valorEnLocal(a, 'Id');
      const idB = valorEnLocal(b, 'Id');
      const na = typeof idA === 'number' ? idA : parseInt(String(idA ?? 0).replace(/^0+/, ''), 10) || 0;
      const nb = typeof idB === 'number' ? idB : parseInt(String(idB ?? 0).replace(/^0+/, ''), 10) || 0;
      return na - nb;
    });
  }, [valorEnLocal]);

  const refetchLocales = useCallback(() => {
    apiFetch('/api/locales')
      .then((res) => res.json())
      .then((data) => {
        if (data.error) return;
        setLocales(data.locales || []);
      })
      .catch(() => setLocales([]));
  }, []);

  const refetchAlmacenes = useCallback(() => {
    apiFetch('/api/almacenes')
      .then((res) => res.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setAlmacenes(ordenarPorId(data.almacenes || []));
      })
      .catch((e) => setError(e.message || 'Error de conexión'));
    refetchLocales();
  }, [ordenarPorId, refetchLocales]);

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
        if (key === 'Id') body[key] = editingAlmacenId != null ? editingAlmacenId : próximoId;
        else body[key] = formNuevo[key] ?? '';
      }
      const res = await apiFetch('/api/almacenes', {
        method: editingAlmacenId != null ? 'PUT' : 'POST',
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
    } catch {
      setErrorForm('No se pudo conectar con el servidor');
    } finally {
      setGuardando(false);
    }
  };

  const sincronizarAlmacenes = async () => {
    setSincronizando(true);
    try {
      const res = await apiFetch('/api/agora/warehouses/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al sincronizar');
        return;
      }
      refetchAlmacenes();
      setSelectedRowIndex(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setSincronizando(false);
    }
  };

  const borrarSeleccionado = async () => {
    if (selectedRowIndex == null) return;
    const almacen = almacenesFiltrados[selectedRowIndex];
    const id = valorEnLocal(almacen, 'Id');
    const idStr = id != null ? String(id) : '';
    if (!idStr) return;
    setGuardando(true);
    try {
      const res = await apiFetch('/api/almacenes', {
        method: 'DELETE',
        body: JSON.stringify({ Id: idStr }),
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
      const v = valorEnLocal(u, 'Id');
      const n = typeof v === 'number' ? v : parseInt(String(v ?? 0).replace(/^0+/, ''), 10);
      return Number.isNaN(n) ? 0 : n;
    });
    return formatId6(Math.max(0, ...ids) + 1);
  }, [almacenes, valorEnLocal]);

  const seleccionarFila = (idx: number) => {
    setSelectedRowIndex((prev) => (prev === idx ? null : idx));
  };

  const localesPorAlmacen = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const alm of almacenes) {
      const nombreAlm = String(alm.Nombre ?? alm.Id ?? '').trim();
      if (!nombreAlm) continue;
      const localesConEsteAlm = locales.filter((loc) => {
        const almacenesOrig = parseAlmacenesOrigen(valorEnLocal(loc, 'Almacen origen') ?? valorEnLocal(loc, 'almacen origen'));
        return almacenesOrig.includes(nombreAlm);
      });
      const nombresLocales = localesConEsteAlm
        .map((l) => String(valorEnLocal(l, 'Nombre') ?? valorEnLocal(l, 'nombre') ?? '').trim())
        .filter(Boolean);
      map.set(nombreAlm, nombresLocales);
    }
    return map;
  }, [almacenes, locales, valorEnLocal]);

  const getColWidth = useCallback(
    (col: string) => columnWidths[col] ?? (col === COL_LOCALES_ASIGNADOS ? 180 : DEFAULT_COL_WIDTH),
    [columnWidths],
  );
  const columnas = useMemo(() => [...ORDEN_COLUMNAS], []);

  const valorCelda = useCallback(
    (almacen: Almacen, col: string) => {
      if (col === COL_LOCALES_ASIGNADOS) {
        const nombreAlm = String(almacen.Nombre ?? almacen.Id ?? '').trim();
        const list = localesPorAlmacen.get(nombreAlm) ?? [];
        return list.length > 0 ? list.join(', ') : '—';
      }
      if (col === 'Id' || col.startsWith('id_')) {
        const key = Object.keys(almacen).find((k) => k.toLowerCase() === col.toLowerCase());
        const raw = key != null ? almacen[key] : almacen[col as keyof Almacen];
        return raw != null ? formatId6(raw) : '—';
      }
      const key = Object.keys(almacen).find((k) => k.toLowerCase() === col.toLowerCase());
      const raw = key != null ? almacen[key] : almacen[col as keyof Almacen];
      if (raw !== undefined && raw !== null && String(raw).trim() !== '') return String(raw);
      return '—';
    },
    [localesPorAlmacen],
  );

  const almacenesFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return almacenes;
    return almacenes.filter((u) =>
      columnas.some((col) => {
        const val = valorCelda(u, col);
        return val !== '—' && val.toLowerCase().includes(q);
      }),
    );
  }, [almacenes, filtroBusqueda, columnas, valorCelda]);

  const filaSeleccionDisabled = selectedRowIndex == null;
  const toolbarBusy = guardando || sincronizando;

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/almacenes')
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
    refetchLocales();
  }, [refetchLocales]);

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
      <View style={erpTableStyles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={erpTableStyles.loadingText}>Cargando almacenes…</Text>
      </View>
    );
  }

  if (error && almacenes.length === 0) {
    return (
      <View style={erpTableStyles.center}>
        <MaterialIcons name="error-outline" size={48} color={colors.danger} />
        <Text style={erpTableStyles.errorText}>{error}</Text>
        <TouchableOpacity style={erpTableStyles.btnPrimary} onPress={refetchAlmacenes}>
          <MaterialIcons name="refresh" size={iconSize.chip} color={colors.surface} />
          <Text style={erpTableStyles.btnPrimaryText}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={erpTableStyles.screen}>
      <View style={erpTableStyles.headerRow}>
        <Pressable onPress={() => router.back()} style={erpTableStyles.backBtn} accessibilityLabel="Volver">
          <MaterialIcons name="arrow-back" size={iconSize.tab} color={colors.textPrimary} />
        </Pressable>
        <Text style={erpTableStyles.title}>Almacenes</Text>
      </View>

      <View style={erpTableStyles.subtitleRow}>
        <Text style={erpTableStyles.subtitle}>
          {almacenesFiltrados.length} almacén{almacenesFiltrados.length === 1 ? '' : 'es'}
          {filtroBusqueda.trim() ? ` · filtrado de ${almacenes.length}` : ''}
        </Text>
      </View>

      <View style={erpTableStyles.toolbarRow}>
        <View style={erpTableStyles.toolbar}>
          <TouchableOpacity
            style={erpTableStyles.btnPrimary}
            onPress={abrirModalNuevo}
            disabled={toolbarBusy}
            accessibilityLabel="Nuevo almacén"
          >
            <MaterialIcons name={ICONS.add} size={iconSize.chip} color={colors.surface} />
            <Text style={erpTableStyles.btnPrimaryText}>Nuevo almacén</Text>
          </TouchableOpacity>

          {TOOLBAR_SECUNDARIOS.map((btn) => {
            const needsRow = btn.id === 'editar' || btn.id === 'borrar';
            const disabled = toolbarBusy || (needsRow && filaSeleccionDisabled);
            return (
              <View
                key={btn.id}
                style={erpTableStyles.toolbarBtnWrap}
                {...(Platform.OS === 'web'
                  ? ({
                      onMouseEnter: () => setHoveredBtn(btn.id),
                      onMouseLeave: () => setHoveredBtn(null),
                    } as object)
                  : {})}
              >
                {hoveredBtn === btn.id ? (
                  <View style={erpTableStyles.tooltip}>
                    <Text style={erpTableStyles.tooltipText}>{btn.label}</Text>
                  </View>
                ) : null}
                <TouchableOpacity
                  style={[erpTableStyles.toolbarBtn, disabled && erpTableStyles.toolbarBtnDisabled]}
                  onPress={() => {
                    if (btn.id === 'editar' && selectedRowIndex != null) {
                      abrirModalEditar(almacenesFiltrados[selectedRowIndex]);
                    }
                    if (btn.id === 'borrar' && selectedRowIndex != null) borrarSeleccionado();
                    if (btn.id === 'sync') sincronizarAlmacenes();
                  }}
                  disabled={disabled}
                  accessibilityLabel={btn.label}
                >
                  {btn.id === 'sync' && sincronizando ? (
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  ) : (
                    <MaterialIcons
                      name={btn.icon}
                      size={ICON_SIZE}
                      color={disabled ? colors.textMuted : colors.textSecondary}
                    />
                  )}
                </TouchableOpacity>
              </View>
            );
          })}
        </View>

        <View style={[erpTableStyles.searchWrap, erpTableStyles.searchWrapFlex]}>
          <MaterialIcons name="search" size={iconSize.chip} color={colors.textSecondary} style={erpTableStyles.searchIcon} />
          <TextInput
            style={erpTableStyles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar…"
            placeholderTextColor={colors.textMuted}
          />
        </View>
      </View>

      <ScrollView
        style={erpTableStyles.scrollVertical}
        contentContainerStyle={erpTableStyles.scrollVerticalContent}
        showsVerticalScrollIndicator
      >
        <ScrollView
          horizontal
          style={erpTableStyles.scrollTable}
          contentContainerStyle={erpTableStyles.scrollTableContent}
          showsHorizontalScrollIndicator
        >
          <View style={erpTableStyles.table}>
            <View style={erpTableStyles.rowHeader}>
              {columnas.map((col, colIdx) => (
                <View
                  key={col}
                  style={[
                    erpTableStyles.cellHeader,
                    colIdx === columnas.length - 1 && erpTableStyles.cellHeaderLast,
                    { width: getColWidth(col), minWidth: MIN_COL_WIDTH },
                  ]}
                >
                  <Text style={erpTableStyles.cellHeaderText} numberOfLines={1}>
                    {labelColumna(col)}
                  </Text>
                  {Platform.OS === 'web' ? (
                    <View
                      style={erpTableStyles.resizeHandle}
                      {...({
                        onMouseDown: (e: { nativeEvent?: { clientX: number }; clientX?: number }) =>
                          handleResizeStart(col, e),
                      } as object)}
                    />
                  ) : null}
                </View>
              ))}
            </View>

            {almacenesFiltrados.length === 0 ? (
              <EstadoVacio
                icon="local-shipping"
                mensaje={
                  filtroBusqueda.trim()
                    ? 'No hay almacenes que coincidan con la búsqueda.'
                    : 'No hay almacenes registrados.'
                }
                accion={
                  !filtroBusqueda.trim() ? (
                    <TouchableOpacity style={erpTableStyles.btnPrimary} onPress={abrirModalNuevo}>
                      <MaterialIcons name={ICONS.add} size={iconSize.chip} color={colors.surface} />
                      <Text style={erpTableStyles.btnPrimaryText}>Nuevo almacén</Text>
                    </TouchableOpacity>
                  ) : undefined
                }
              />
            ) : (
              almacenesFiltrados.map((almacen, idx) => (
                <TouchableOpacity
                  key={valorCelda(almacen, 'Id') + '-' + idx}
                  style={[
                    erpTableStyles.row,
                    idx === almacenesFiltrados.length - 1 && erpTableStyles.rowLast,
                    selectedRowIndex === idx && erpTableStyles.rowSelected,
                  ]}
                  onPress={() => seleccionarFila(idx)}
                  activeOpacity={0.7}
                >
                  {columnas.map((col, colIdx) => (
                    <View
                      key={col}
                      style={[
                        erpTableStyles.cell,
                        colIdx === columnas.length - 1 && erpTableStyles.cellLast,
                        { width: getColWidth(col), minWidth: MIN_COL_WIDTH },
                      ]}
                    >
                      <Text style={erpTableStyles.cellText} numberOfLines={1} ellipsizeMode="tail">
                        {truncar(valorCelda(almacen, col))}
                      </Text>
                    </View>
                  ))}
                </TouchableOpacity>
              ))
            )}
          </View>
        </ScrollView>
      </ScrollView>

      <Modal visible={modalNuevoVisible} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={erpTableStyles.modalOverlay}
        >
          <View style={erpTableStyles.modalContent}>
            <Text style={erpTableStyles.modalTitle}>
              {editingAlmacenId != null ? 'Editar almacén' : 'Nuevo almacén'}
            </Text>
            {CAMPOS_FORM.map(({ key, label }) => (
              <View key={key} style={erpTableStyles.formRow}>
                <Text style={erpTableStyles.formLabel}>{label}</Text>
                <TextInput
                  style={erpTableStyles.formInput}
                  value={formNuevo[key] ?? ''}
                  onChangeText={(t) => setFormNuevo((prev) => ({ ...prev, [key]: t }))}
                  placeholder={label}
                  placeholderTextColor={colors.textMuted}
                />
              </View>
            ))}
            {errorForm ? <Text style={erpTableStyles.errorForm}>{errorForm}</Text> : null}
            <View style={erpTableStyles.modalButtons}>
              <TouchableOpacity style={erpTableStyles.modalBtnCancel} onPress={cerrarModalNuevo} disabled={guardando}>
                <Text style={erpTableStyles.modalBtnCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={erpTableStyles.modalBtnSave} onPress={guardarNuevo} disabled={guardando}>
                {guardando ? (
                  <ActivityIndicator size="small" color={colors.surface} />
                ) : (
                  <Text style={erpTableStyles.modalBtnSaveText}>Guardar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
