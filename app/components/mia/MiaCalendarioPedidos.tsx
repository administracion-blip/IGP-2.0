/**
 * Calendario informativo de pedidos MIA (v1.1).
 * Solo lectura/CRUD de días de pedido por local+proveedor; no lanza cálculo ni aprobación.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  TextInput,
  Switch,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { TablaBasica } from '../TablaBasica';
import { SelectorDesplegable } from '../SelectorDesplegable';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { MIN_TOUCH } from '../../constants/layout';
import { apiFetch, errorMessage } from '../../utils/api';

const DIAS_ABREV = ['L', 'M', 'X', 'J', 'V', 'S', 'D'] as const;
const DIAS_LABEL = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'] as const;
const COLUMNAS = ['Proveedor', 'Días', 'Activo', 'Notas'] as const;
const SIN_PROVEEDOR = 'SIN_PROVEEDOR';

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = 'name' in e ? String((e as { name?: unknown }).name || '') : '';
  const msg = 'message' in e ? String((e as { message?: unknown }).message || '') : '';
  return name === 'AbortError' || /aborted|abort/i.test(msg);
}

type LocalMia = {
  id: string;
  nombre: string;
  warehouseIds: string[];
};

type CalendarioItem = {
  LocalId: string;
  LocalNombre?: string;
  ProveedorId: string;
  ProveedorNombre?: string;
  diasSemana?: boolean[];
  activo?: boolean;
  notas?: string;
};

type ProveedorOpt = { id: string; nombre: string };

function emptyDias(): boolean[] {
  return [false, false, false, false, false, false, false];
}

function normalizeDias(raw: unknown): boolean[] {
  if (!Array.isArray(raw) || raw.length !== 7) return emptyDias();
  return raw.map((d) => d === true);
}

function formatDias(dias: boolean[] | undefined): string {
  const d = normalizeDias(dias);
  const parts = DIAS_ABREV.filter((_, i) => d[i]);
  return parts.length ? parts.join(' ') : '—';
}

export function MiaCalendarioPedidos() {
  const { hasPermiso, localPermitido } = useAuth();
  const { shouldStackToolbar, isPhone } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();

  const puedeVer = hasPermiso('mia.ver');
  const puedeConfigurar = hasPermiso('mia.configurar');

  const [locales, setLocales] = useState<LocalMia[]>([]);
  const [loadingLocales, setLoadingLocales] = useState(true);
  const [localId, setLocalId] = useState<string | null>(null);

  const [items, setItems] = useState<CalendarioItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [modalVisible, setModalVisible] = useState(false);
  const [editando, setEditando] = useState<CalendarioItem | null>(null);
  const [formProveedorId, setFormProveedorId] = useState('');
  const [formProveedorNombre, setFormProveedorNombre] = useState('');
  const [formManual, setFormManual] = useState(false);
  const [formDias, setFormDias] = useState<boolean[]>(emptyDias());
  const [formActivo, setFormActivo] = useState(true);
  const [formNotas, setFormNotas] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const [proveedores, setProveedores] = useState<ProveedorOpt[]>([]);
  const [loadingProveedores, setLoadingProveedores] = useState(false);

  const localIdRef = useRef(localId);
  localIdRef.current = localId;
  const calendarioAbortRef = useRef<AbortController | null>(null);

  const opcionesLocal = useMemo(
    () =>
      locales.map((l) => ({
        id: l.id,
        titulo: l.nombre || l.id,
        subtitulo: l.warehouseIds?.length
          ? `${l.warehouseIds.length} almacén(es)`
          : 'Sin almacén vinculado',
      })),
    [locales],
  );

  const localSeleccionado = useMemo(
    () => locales.find((l) => l.id === localId) || null,
    [locales, localId],
  );

  const itemsFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const nombre = String(it.ProveedorNombre || '').toLowerCase();
      const id = String(it.ProveedorId || '').toLowerCase();
      const notas = String(it.notas || '').toLowerCase();
      const dias = formatDias(it.diasSemana).toLowerCase();
      return nombre.includes(q) || id.includes(q) || notas.includes(q) || dias.includes(q);
    });
  }, [items, filtroBusqueda]);

  const opcionesProveedor = useMemo(
    () =>
      proveedores.map((p) => ({
        id: p.id,
        titulo: p.nombre || p.id,
        subtitulo: p.id,
      })),
    [proveedores],
  );

  const cargarLocales = useCallback(async () => {
    setLoadingLocales(true);
    setError(null);
    try {
      const r = await apiFetch('/api/mia/locales-almacenes');
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error || 'No se pudieron cargar los locales');
        setLocales([]);
        return;
      }
      const list: LocalMia[] = (data.locales || [])
        .map((l: { id?: string; nombre?: string; warehouseIds?: string[] }) => ({
          id: String(l.id || '').trim(),
          nombre: String(l.nombre || '').trim(),
          warehouseIds: Array.isArray(l.warehouseIds) ? l.warehouseIds.map(String) : [],
        }))
        .filter((l: LocalMia) => l.id && l.nombre && localPermitido(l.nombre));
      list.sort((a: LocalMia, b: LocalMia) => a.nombre.localeCompare(b.nombre, 'es'));
      setLocales(list);
      setLocalId((prev) => {
        if (prev && list.some((l: LocalMia) => l.id === prev)) return prev;
        return list.length === 1 ? list[0].id : null;
      });
    } catch (e) {
      setError(errorMessage(e, 'Error cargando locales'));
      setLocales([]);
    } finally {
      setLoadingLocales(false);
    }
  }, [localPermitido]);

  const cargarCalendario = useCallback(async (lid: string) => {
    if (!lid) {
      calendarioAbortRef.current?.abort();
      calendarioAbortRef.current = null;
      setItems([]);
      setLoading(false);
      return;
    }

    calendarioAbortRef.current?.abort();
    const ac = new AbortController();
    calendarioAbortRef.current = ac;

    const sigueVigente = () => !ac.signal.aborted && localIdRef.current === lid;

    setLoading(true);
    setError(null);
    setSelectedRowIndex(null);
    try {
      const r = await apiFetch(`/api/mia/calendario?localId=${encodeURIComponent(lid)}`, {
        signal: ac.signal,
      });
      if (!sigueVigente()) return;
      const data = await r.json();
      if (!sigueVigente()) return;
      if (!r.ok || data.error) {
        setError(data.error || 'No se pudo cargar el calendario');
        setItems([]);
        return;
      }
      const list: CalendarioItem[] = Array.isArray(data.items) ? data.items : [];
      list.sort((a, b) =>
        String(a.ProveedorNombre || a.ProveedorId || '').localeCompare(
          String(b.ProveedorNombre || b.ProveedorId || ''),
          'es',
        ),
      );
      setItems(list);
    } catch (e) {
      if (!sigueVigente() || isAbortError(e)) return;
      setError(errorMessage(e, 'Error cargando calendario'));
      setItems([]);
    } finally {
      if (sigueVigente()) setLoading(false);
    }
  }, []);

  const cargarProveedores = useCallback(async (local: LocalMia | null) => {
    if (!local?.warehouseIds?.length) {
      setProveedores([]);
      return;
    }
    setLoadingProveedores(true);
    try {
      const map = new Map<string, ProveedorOpt>();
      await Promise.all(
        local.warehouseIds.map(async (wid) => {
          try {
            const r = await apiFetch(`/api/mia/config?warehouseId=${encodeURIComponent(wid)}`);
            const data = await r.json();
            if (!r.ok || data.error) return;
            for (const it of data.items || []) {
              const pid = String(it.proveedorId || '').trim();
              if (!pid || pid === SIN_PROVEEDOR) continue;
              if (!map.has(pid)) {
                map.set(pid, {
                  id: pid,
                  nombre: String(it.proveedorNombre || pid).trim() || pid,
                });
              }
            }
          } catch {
            /* ignore warehouse config errors */
          }
        }),
      );
      const list = Array.from(map.values()).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      setProveedores(list);
    } finally {
      setLoadingProveedores(false);
    }
  }, []);

  useEffect(() => {
    if (puedeVer) cargarLocales();
  }, [puedeVer, cargarLocales]);

  useEffect(() => {
    // Al cambiar de local: abortar petición anterior y limpiar UI stale
    calendarioAbortRef.current?.abort();
    setModalVisible(false);
    setEditando(null);
    setFormError(null);
    setSelectedRowIndex(null);
    setError(null);

    if (localId && puedeVer) {
      void cargarCalendario(localId);
    } else {
      setItems([]);
      setLoading(false);
    }

    return () => {
      calendarioAbortRef.current?.abort();
    };
  }, [localId, puedeVer, cargarCalendario]);

  const getValorCelda = useCallback((item: CalendarioItem, col: string) => {
    switch (col) {
      case 'Proveedor':
        return String(item.ProveedorNombre || item.ProveedorId || '—');
      case 'Días':
        return formatDias(item.diasSemana);
      case 'Activo':
        return item.activo === false ? 'No' : 'Sí';
      case 'Notas':
        return String(item.notas || '');
      default:
        return '';
    }
  }, []);

  const abrirCrear = useCallback(() => {
    if (!puedeConfigurar || !localId) return;
    setEditando(null);
    setFormProveedorId('');
    setFormProveedorNombre('');
    setFormManual(false);
    setFormDias(emptyDias());
    setFormActivo(true);
    setFormNotas('');
    setFormError(null);
    setModalVisible(true);
    void cargarProveedores(localSeleccionado);
  }, [puedeConfigurar, localId, localSeleccionado, cargarProveedores]);

  const abrirEditar = useCallback(
    (item: CalendarioItem) => {
      if (!puedeConfigurar || !localId) return;
      if (item.LocalId && item.LocalId !== localId) {
        setError('El local ha cambiado; recarga el calendario antes de editar.');
        return;
      }
      setEditando(item);
      setFormProveedorId(String(item.ProveedorId || ''));
      setFormProveedorNombre(String(item.ProveedorNombre || item.ProveedorId || ''));
      setFormManual(true);
      setFormDias(normalizeDias(item.diasSemana));
      setFormActivo(item.activo !== false);
      setFormNotas(String(item.notas || ''));
      setFormError(null);
      setModalVisible(true);
      void cargarProveedores(localSeleccionado);
    },
    [puedeConfigurar, localId, localSeleccionado, cargarProveedores],
  );

  const cerrarModal = useCallback(() => {
    if (guardando) return;
    setModalVisible(false);
    setEditando(null);
    setFormError(null);
  }, [guardando]);

  const toggleDia = useCallback((idx: number) => {
    setFormDias((prev) => {
      const next = [...prev];
      next[idx] = !next[idx];
      return next;
    });
  }, []);

  const seleccionarProveedorLista = useCallback(
    (id: string) => {
      const p = proveedores.find((x) => x.id === id);
      setFormProveedorId(id);
      setFormProveedorNombre(p?.nombre || id);
      setFormManual(false);
    },
    [proveedores],
  );

  const guardar = useCallback(async () => {
    if (!puedeConfigurar || !localId) return;
    if (editando?.LocalId && editando.LocalId !== localId) {
      setFormError('El local ha cambiado; cierra y vuelve a abrir la edición.');
      return;
    }
    const pid = formProveedorId.trim();
    if (!pid) {
      setFormError('Indica el proveedor (id).');
      return;
    }
    if (pid === SIN_PROVEEDOR) {
      setFormError('No se puede usar SIN_PROVEEDOR en el calendario.');
      return;
    }
    if (formActivo && !formDias.some(Boolean)) {
      setFormError('Si está activo, marca al menos un día de la semana.');
      return;
    }

    setGuardando(true);
    setFormError(null);
    try {
      const r = await apiFetch('/api/mia/calendario', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          localId,
          localNombre: localSeleccionado?.nombre || undefined,
          proveedorId: pid,
          proveedorNombre: formProveedorNombre.trim() || pid,
          diasSemana: formDias,
          activo: formActivo,
          notas: formNotas.trim(),
        }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setFormError(data.error || 'No se pudo guardar');
        return;
      }
      setModalVisible(false);
      setEditando(null);
      await cargarCalendario(localId);
    } catch (e) {
      setFormError(errorMessage(e, 'Error guardando calendario'));
    } finally {
      setGuardando(false);
    }
  }, [
    puedeConfigurar,
    localId,
    editando,
    localSeleccionado,
    formProveedorId,
    formProveedorNombre,
    formDias,
    formActivo,
    formNotas,
    cargarCalendario,
  ]);

  const borrar = useCallback(
    async (item: CalendarioItem) => {
      if (!puedeConfigurar || !localId) return;
      if (item.LocalId && item.LocalId !== localId) {
        setError('El local ha cambiado; recarga el calendario antes de eliminar.');
        return;
      }
      const nombre = item.ProveedorNombre || item.ProveedorId;
      const ok = await confirmar(
        'Eliminar entrada',
        `¿Eliminar el calendario de «${nombre}» en este local?`,
        { confirmarLabel: 'Eliminar', variant: 'danger' },
      );
      if (!ok) return;
      // Revalidar por si el usuario cambió de local durante el diálogo
      if (localIdRef.current !== localId || (item.LocalId && item.LocalId !== localIdRef.current)) {
        setError('El local ha cambiado; recarga el calendario antes de eliminar.');
        return;
      }
      setGuardando(true);
      setError(null);
      try {
        const r = await apiFetch(
          `/api/mia/calendario?localId=${encodeURIComponent(localId)}&proveedorId=${encodeURIComponent(item.ProveedorId)}`,
          { method: 'DELETE' },
        );
        const data = await r.json();
        if (!r.ok || data.error) {
          setError(data.error || 'No se pudo eliminar');
          return;
        }
        setSelectedRowIndex(null);
        await cargarCalendario(localId);
      } catch (e) {
        setError(errorMessage(e, 'Error eliminando entrada'));
      } finally {
        setGuardando(false);
      }
    },
    [puedeConfigurar, localId, confirmar, cargarCalendario],
  );

  if (!puedeVer) {
    return (
      <View style={[styles.wrap, styles.centro]}>
        <Text style={styles.muted}>No tienes permiso para ver el calendario MIA.</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={[styles.filtroCard, styles.filtroOnTop]}>
        <Text style={styles.hint}>
          Calendario informativo de días de pedido por proveedor. No lanza cálculos ni envíos a Ágora.
        </Text>
        <View style={[styles.filtroRow, shouldStackToolbar && styles.filtroCol]}>
          <View style={[styles.fieldGrow, shouldStackToolbar && styles.fieldFull]}>
            <Text style={styles.fieldLabel}>Local</Text>
            <SelectorDesplegable
              placeholder="Selecciona local…"
              icono="store"
              opciones={opcionesLocal}
              valorId={localId}
              onSeleccionar={setLocalId}
              tituloLista="Locales"
              iconoLista="store"
              loading={loadingLocales}
              buscador
              compact
            />
          </View>
          {!puedeConfigurar && (
            <Text style={styles.soloLectura}>
              Solo lectura (necesitas mia.configurar para crear o editar).
            </Text>
          )}
        </View>
      </View>

      {!localId ? (
        <View style={styles.centro}>
          {loadingLocales ? (
            <ActivityIndicator color="#0ea5e9" />
          ) : (
            <Text style={styles.muted}>Selecciona un local para ver su calendario de pedidos.</Text>
          )}
        </View>
      ) : (
        <View style={styles.tablaWrap}>
          <TablaBasica<CalendarioItem>
            title="Calendario de pedidos"
            onBack={() => {}}
            hideHeader
            hideToolbarActions={!puedeConfigurar}
            columnas={[...COLUMNAS]}
            datos={itemsFiltrados}
            getValorCelda={getValorCelda}
            loading={loading}
            error={error}
            onRetry={() => localId && cargarCalendario(localId)}
            filtroBusqueda={filtroBusqueda}
            onFiltroChange={setFiltroBusqueda}
            selectedRowIndex={selectedRowIndex}
            onSelectRow={setSelectedRowIndex}
            onCrear={abrirCrear}
            onEditar={abrirEditar}
            onBorrar={borrar}
            guardando={guardando}
            emptyMessage="No hay proveedores en el calendario de este local."
            emptyFilterMessage="Ninguna entrada coincide con la búsqueda."
            getColumnCellStyle={(col) => {
              if (col === 'Días') return { cell: { width: 110 } };
              if (col === 'Activo') return { cell: { width: 72 } };
              return undefined;
            }}
            renderCell={(item, col) => {
              if (col === 'Activo') {
                const on = item.activo !== false;
                return (
                  <Text style={[styles.activoText, on ? styles.activoSi : styles.activoNo]}>
                    {on ? 'Sí' : 'No'}
                  </Text>
                );
              }
              if (col === 'Proveedor') {
                return (
                  <View>
                    <Text style={styles.provNombre} numberOfLines={1}>
                      {item.ProveedorNombre || item.ProveedorId}
                    </Text>
                    {item.ProveedorNombre && item.ProveedorNombre !== item.ProveedorId ? (
                      <Text style={styles.provId} numberOfLines={1}>
                        {item.ProveedorId}
                      </Text>
                    ) : null}
                  </View>
                );
              }
              return null;
            }}
          />
        </View>
      )}

      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={cerrarModal}>
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable style={styles.modalBackdrop} onPress={cerrarModal} />
          <View style={[styles.modalCard, isPhone && styles.modalCardPhone]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editando ? 'Editar calendario' : 'Nueva entrada de calendario'}
              </Text>
              <TouchableOpacity onPress={cerrarModal} disabled={guardando} hitSlop={8}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.modalBody}
            >
              <Text style={styles.fieldLabel}>
                Local: {localSeleccionado?.nombre || localId}
              </Text>

              {editando ? (
                <View style={styles.block}>
                  <Text style={styles.fieldLabel}>Proveedor</Text>
                  <Text style={styles.provId}>{formProveedorId}</Text>
                  <TextInput
                    style={[styles.input, { marginTop: 6 }]}
                    value={formProveedorNombre}
                    onChangeText={setFormProveedorNombre}
                    placeholder="Nombre proveedor"
                    placeholderTextColor="#94a3b8"
                    editable={!guardando}
                  />
                </View>
              ) : (
                <View style={styles.block}>
                  <Text style={styles.fieldLabel}>Proveedor</Text>
                  {opcionesProveedor.length > 0 && !formManual ? (
                    <>
                      <SelectorDesplegable
                        placeholder="Selecciona proveedor…"
                        icono="local-shipping"
                        opciones={opcionesProveedor}
                        valorId={formProveedorId || null}
                        onSeleccionar={seleccionarProveedorLista}
                        tituloLista="Proveedores (config MIA)"
                        iconoLista="local-shipping"
                        loading={loadingProveedores}
                        buscador
                        compact
                      />
                      <TouchableOpacity
                        style={styles.linkBtn}
                        onPress={() => {
                          setFormManual(true);
                          setFormProveedorId('');
                          setFormProveedorNombre('');
                        }}
                      >
                        <Text style={styles.linkBtnText}>Alta manual…</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <TextInput
                        style={styles.input}
                        value={formProveedorId}
                        onChangeText={setFormProveedorId}
                        placeholder="Id proveedor"
                        placeholderTextColor="#94a3b8"
                        editable={!guardando}
                        autoCapitalize="none"
                      />
                      <TextInput
                        style={[styles.input, { marginTop: 8 }]}
                        value={formProveedorNombre}
                        onChangeText={setFormProveedorNombre}
                        placeholder="Nombre proveedor"
                        placeholderTextColor="#94a3b8"
                        editable={!guardando}
                      />
                      {opcionesProveedor.length > 0 ? (
                        <TouchableOpacity
                          style={styles.linkBtn}
                          onPress={() => {
                            setFormManual(false);
                            setFormProveedorId('');
                            setFormProveedorNombre('');
                          }}
                        >
                          <Text style={styles.linkBtnText}>Elegir de la lista…</Text>
                        </TouchableOpacity>
                      ) : loadingProveedores ? (
                        <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 8 }} />
                      ) : (
                        <Text style={styles.hintMuted}>
                          No hay proveedores en la config MIA de los almacenes del local; introduce
                          id y nombre a mano.
                        </Text>
                      )}
                    </>
                  )}
                </View>
              )}

              <View style={styles.block}>
                <Text style={styles.fieldLabel}>Días de pedido (L–D)</Text>
                <View style={styles.diasRow}>
                  {DIAS_ABREV.map((abrev, idx) => {
                    const on = formDias[idx];
                    return (
                      <TouchableOpacity
                        key={abrev}
                        style={[styles.diaChip, on && styles.diaChipOn, isPhone && { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH }]}
                        onPress={() => toggleDia(idx)}
                        disabled={guardando}
                        accessibilityLabel={DIAS_LABEL[idx]}
                      >
                        <Text style={[styles.diaChipText, on && styles.diaChipTextOn]}>{abrev}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={[styles.block, styles.switchBlock]}>
                <Text style={styles.fieldLabel}>Activo</Text>
                <View style={styles.switchRow}>
                  <Switch
                    value={formActivo}
                    onValueChange={setFormActivo}
                    disabled={guardando}
                    trackColor={{ false: '#cbd5e1', true: '#7dd3fc' }}
                    thumbColor={formActivo ? '#0ea5e9' : '#f8fafc'}
                  />
                  <Text style={styles.switchHint}>{formActivo ? 'Sí' : 'No'}</Text>
                </View>
              </View>

              <View style={styles.block}>
                <Text style={styles.fieldLabel}>Notas</Text>
                <TextInput
                  style={[styles.input, styles.inputNotas]}
                  value={formNotas}
                  onChangeText={setFormNotas}
                  placeholder="Opcional"
                  placeholderTextColor="#94a3b8"
                  editable={!guardando}
                  multiline
                />
              </View>

              {formError ? (
                <View style={styles.errorBox}>
                  <MaterialIcons name="error-outline" size={18} color="#b91c1c" />
                  <Text style={styles.errorText}>{formError}</Text>
                </View>
              ) : null}
            </ScrollView>

            <View style={[styles.modalActions, shouldStackToolbar && styles.modalActionsStack]}>
              <TouchableOpacity
                style={[styles.btnSecondary, shouldStackToolbar && styles.btnFull]}
                onPress={cerrarModal}
                disabled={guardando}
              >
                <Text style={styles.btnSecondaryText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.btnPrimary,
                  shouldStackToolbar && styles.btnFull,
                  guardando && styles.btnDisabled,
                ]}
                onPress={guardar}
                disabled={guardando}
              >
                {guardando ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.btnPrimaryText}>Guardar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 16, paddingBottom: 8, gap: 12 },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { fontSize: 14, color: '#64748b', textAlign: 'center' },
  hint: { fontSize: 13, color: '#64748b', marginBottom: 10, lineHeight: 18 },
  hintMuted: { fontSize: 12, color: '#94a3b8', marginTop: 6 },
  soloLectura: { fontSize: 12, color: '#94a3b8', alignSelf: 'flex-end', marginBottom: 4 },
  filtroCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  filtroOnTop: { position: 'relative', zIndex: 30 },
  filtroRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' },
  filtroCol: { flexDirection: 'column', alignItems: 'stretch' },
  fieldGrow: { flex: 1, minWidth: 200 },
  fieldFull: { width: '100%', minWidth: 0 },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: '#64748b', marginBottom: 4 },
  tablaWrap: { flex: 1, position: 'relative', zIndex: 0, minHeight: 280 },
  activoText: { fontWeight: '700', fontSize: 13 },
  activoSi: { color: '#16a34a' },
  activoNo: { color: '#94a3b8' },
  provNombre: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  provId: { fontSize: 11, color: '#94a3b8', marginTop: 1 },
  readonlyValue: { fontSize: 15, fontWeight: '600', color: '#0f172a' },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    padding: 16,
  },
  modalBackdrop: { ...StyleSheet.absoluteFillObject },
  modalCard: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '90%',
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
    zIndex: 2,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 16px 40px rgba(0,0,0,0.18)' }
      : { elevation: 12 }),
  },
  modalCardPhone: { maxWidth: '100%', maxHeight: '96%' },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a', flex: 1, marginRight: 8 },
  modalBody: { padding: 16, gap: 4, paddingBottom: 8 },
  block: { marginBottom: 12 },
  switchBlock: { marginBottom: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  switchHint: { fontSize: 13, color: '#475569' },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#0f172a',
    minHeight: 40,
  },
  inputNotas: { minHeight: 72, textAlignVertical: 'top' },
  diasRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  diaChip: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  diaChipOn: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  diaChipText: { fontSize: 13, fontWeight: '700', color: '#475569' },
  diaChipTextOn: { color: '#fff' },
  linkBtn: { marginTop: 8, alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  linkBtnText: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  errorBox: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    alignItems: 'flex-start',
    marginTop: 4,
  },
  errorText: { flex: 1, fontSize: 13, color: '#b91c1c' },
  modalActions: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  modalActionsStack: { flexDirection: 'column' },
  btnPrimary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
    paddingHorizontal: 14,
    minHeight: MIN_TOUCH,
  },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  btnSecondary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: MIN_TOUCH,
  },
  btnSecondaryText: { color: '#0369a1', fontWeight: '700', fontSize: 13 },
  btnFull: { width: '100%', flex: 0 },
  btnDisabled: { opacity: 0.45 },
});
