import React, { useCallback, useEffect, useState, useMemo, useRef, createElement } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  Image,
  Modal,
  Pressable,
  Platform,
  useWindowDimensions,
  type ImageStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useMantenimientoLocales, valorEnLocal } from './LocalesContext';
import { apiFetch } from '../../utils/api';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { BREAKPOINTS } from '../../constants/layout';
import {
  getPrioridadOrden,
  getPrioridadColor,
  getPrioridadLabel,
  contarUrgentes,
  formatearFechaIncidencia,
  incidenciaEstaProgramada,
} from '../../lib/mantenimientoIncidenciaUi';
import { MantenimientoIncidenciaCard } from '../../components/mantenimiento/MantenimientoIncidenciaCard';
import {
  MantenimientoIncidenciaDetalleModal,
  type MantenimientoIncidenciaDetalle,
  type LineaValoracionDetalle,
} from '../../components/mantenimiento/MantenimientoIncidenciaDetalleModal';
import {
  MantenimientoValoracionModal,
  type LineaValoracionInput,
} from '../../components/mantenimiento/MantenimientoValoracionModal';
import {
  MantenimientoLocalColumnBoard,
  type MantenimientoBoardColumn,
} from '../../components/mantenimiento/MantenimientoLocalColumnBoard';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

function resolverUriFoto(uri: string): string {
  const u = uri.trim();
  if (u.startsWith('http') || u.startsWith('data:')) return u;
  return `${API_URL}${u.startsWith('/') ? '' : '/'}${u}`;
}

type Incidencia = Record<string, string | number | string[] | undefined>;

function getHoyISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function addDaysISO(iso: string, delta: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function esHoy(iso: string): boolean {
  return iso === getHoyISO();
}

function labelFechaCorta(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const mes = MESES_CORTO[(m || 1) - 1] ?? '';
  return `${d} ${mes} ${y}`;
}

function labelFechaLarga(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${dd}/${mm}/${y}`;
}

function labelDiaSemana(iso: string): string {
  const d = isoADate(iso);
  return d.toLocaleDateString('es-ES', { weekday: 'long' });
}

function labelFechaConDia(iso: string): string {
  const dia = labelDiaSemana(iso);
  const diaCap = dia.charAt(0).toUpperCase() + dia.slice(1);
  return `${diaCap} · ${labelFechaLarga(iso)}`;
}

function extraerFechaProgramada(inc: Incidencia): string {
  const fp = (inc.fecha_programada ?? '').toString().trim();
  const match = fp.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function isoADate(iso: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date();
}

function incidenciaKey(inc: Incidencia): string {
  return `${(inc.local_id ?? '').toString().trim()}-${(inc.id_incidencia ?? '').toString().trim()}-${(inc.fecha_creacion ?? '').toString().trim()}`;
}

function fotosIncidencia(inc: Incidencia): string[] {
  if (!Array.isArray(inc.fotos)) return [];
  return inc.fotos.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}

function incidenciaADetalle(inc: Incidencia, localNombre: string): MantenimientoIncidenciaDetalle {
  return {
    titulo: (inc.titulo ?? '—').toString(),
    descripcion: (inc.descripcion ?? '').toString().trim() || undefined,
    categoria: (inc.categoria ?? '').toString().trim() || undefined,
    zona: (inc.zona ?? '').toString().trim() || undefined,
    localNombre,
    prioridad: (inc.prioridad_reportada ?? '').toString().trim() || undefined,
    estado: (inc.estado ?? '').toString().trim() || undefined,
    estadoValoracion: (inc.estado_valoracion ?? '').toString().trim() || undefined,
    fechaCreacion: inc.fecha_creacion ? String(inc.fecha_creacion) : undefined,
    fechaProgramada: inc.fecha_programada ? String(inc.fecha_programada) : undefined,
    fechaCompletada: inc.fecha_completada ? String(inc.fecha_completada) : undefined,
    idIncidencia: inc.id_incidencia ? String(inc.id_incidencia) : undefined,
    fotos: fotosIncidencia(inc),
    valoracionLineas: Array.isArray(inc.valoracion_lineas)
      ? (inc.valoracion_lineas as unknown as LineaValoracionDetalle[])
      : [],
    valoracionBase: inc.valoracion_base != null ? Number(inc.valoracion_base) : null,
    valoracionIva: inc.valoracion_iva != null ? Number(inc.valoracion_iva) : null,
    valoracionTotal: inc.valoracion_total != null ? Number(inc.valoracion_total) : null,
  };
}

/** Clave del local a expandir por defecto: el que tenga urgentes, o el primero. */
function defaultExpandedKey(columns: MantenimientoBoardColumn<Incidencia>[]): string | null {
  if (columns.length === 0) return null;
  const conUrgente = columns.find((c) => (c.urgentCount ?? 0) > 0);
  return conUrgente?.key ?? columns[0].key;
}

export default function ProgramadasHoyScreen() {
  const router = useRouter();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { width } = useBreakpoint();
  const photoExpandedSize = useMemo(
    () => ({
      width: Math.min(windowWidth * 0.9, 900),
      height: Math.min(windowHeight * 0.85, 700),
    }),
    [windowWidth, windowHeight],
  );
  const { locales } = useMantenimientoLocales();
  const [fechaSeleccionada, setFechaSeleccionada] = useState(getHoyISO);
  const [todasIncidencias, setTodasIncidencias] = useState<Incidencia[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [marcandoReparadoKey, setMarcandoReparadoKey] = useState<string | null>(null);
  const [valorandoInc, setValorandoInc] = useState<Incidencia | null>(null);
  const [guardandoValoracion, setGuardandoValoracion] = useState(false);
  const [errorValoracion, setErrorValoracion] = useState<string | null>(null);
  const [expandedPhotoUri, setExpandedPhotoUri] = useState<string | null>(null);
  const [detalleIncidencia, setDetalleIncidencia] = useState<MantenimientoIncidenciaDetalle | null>(null);
  const [expandedLocals, setExpandedLocals] = useState<Set<string>>(new Set());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const webDateInputRef = useRef<HTMLInputElement>(null);

  const isAccordionMode = width < BREAKPOINTS.tablet;
  const boardCols = width >= 1280 ? 6 : 4;

  const mapLocalIdToNombre = useMemo(() => {
    const m: Record<string, string> = {};
    locales.forEach((loc) => {
      const id = valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'id_locales') ?? '';
      const nombre = valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id;
      if (id) m[id] = nombre;
    });
    return m;
  }, [locales]);

  const refetch = useCallback(() => {
    apiFetch('/api/mantenimiento/incidencias')
      .then((res) => res.json())
      .then((data: { incidencias?: Incidencia[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        const list = data.incidencias || [];
        setTodasIncidencias(list.filter((i) => {
          const lid = (i.local_id ?? '').toString().trim();
          return !lid || lid in mapLocalIdToNombre;
        }));
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, [mapLocalIdToNombre]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refetch();
  }, [refetch]);

  const abrirValoracion = useCallback((inc: Incidencia) => {
    setErrorValoracion(null);
    setValorandoInc(inc);
  }, []);

  const guardarValoracion = useCallback(
    async (lineas: LineaValoracionInput[]) => {
      const inc = valorandoInc;
      if (!inc) return;
      const localId = (inc.local_id ?? '').toString().trim();
      const idIncidencia = (inc.id_incidencia ?? '').toString().trim();
      const fechaCreacion = (inc.fecha_creacion ?? '').toString().trim();
      if (!localId || !idIncidencia || !fechaCreacion) return;
      const key = incidenciaKey(inc);
      setGuardandoValoracion(true);
      setMarcandoReparadoKey(key);
      setErrorValoracion(null);
      try {
        const res = await apiFetch('/api/mantenimiento/incidencias', {
          method: 'PATCH',
          body: JSON.stringify({
            local_id: localId,
            id_incidencia: idIncidencia,
            fecha_creacion: fechaCreacion,
            valorar: true,
            lineas,
          }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setErrorValoracion(data.error ?? 'Error al guardar la valoración');
          return;
        }
        setValorandoInc(null);
        refetch();
      } catch (e) {
        setErrorValoracion(e instanceof Error ? e.message : 'Error de conexión');
      } finally {
        setGuardandoValoracion(false);
        setMarcandoReparadoKey(null);
      }
    },
    [valorandoInc, refetch],
  );

  const incidencias = useMemo(() => {
    return todasIncidencias.filter((i) => {
      if ((i.estado ?? '') === 'CANCELADA') return false;
      return extraerFechaProgramada(i) === fechaSeleccionada;
    });
  }, [todasIncidencias, fechaSeleccionada]);

  const tituloPantalla = esHoy(fechaSeleccionada)
    ? 'Reparaciones programadas hoy'
    : `Reparaciones · ${labelFechaCorta(fechaSeleccionada)}`;

  const columnas = useMemo((): MantenimientoBoardColumn<Incidencia>[] => {
    const byLocal = new Map<string, Incidencia[]>();
    const ordenadas = [...incidencias].sort(
      (a, b) => getPrioridadOrden(a.prioridad_reportada as string) - getPrioridadOrden(b.prioridad_reportada as string),
    );
    ordenadas.forEach((inc) => {
      const localId = (inc.local_id ?? '').toString().trim() || '_sin_local';
      if (!byLocal.has(localId)) byLocal.set(localId, []);
      byLocal.get(localId)!.push(inc);
    });
    return Array.from(byLocal.entries())
      .map(([localId, items]) => ({
        key: localId,
        title: localId === '_sin_local' ? 'Sin local' : (mapLocalIdToNombre[localId] ?? localId),
        count: items.length,
        urgentCount: contarUrgentes(items.map((i) => ({ prioridad: i.prioridad_reportada as string }))),
        items,
      }))
      .sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }));
  }, [incidencias, mapLocalIdToNombre]);

  const columnKeysSig = useMemo(
    () => columnas.map((c) => c.key).join('|'),
    [columnas],
  );

  useEffect(() => {
    if (!isAccordionMode) {
      setExpandedLocals(new Set());
      return;
    }
    if (!columnKeysSig) return;
    const key = defaultExpandedKey(columnas);
    setExpandedLocals(key ? new Set([key]) : new Set());
  }, [fechaSeleccionada, isAccordionMode, columnKeysSig, columnas]);

  const toggleLocalExpand = useCallback((key: string) => {
    setExpandedLocals((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const abrirSelectorFecha = useCallback(() => {
    if (Platform.OS === 'web') {
      const input = webDateInputRef.current;
      if (!input) return;
      try {
        if (typeof input.showPicker === 'function') input.showPicker();
        else input.click();
      } catch {
        input.click();
      }
    } else {
      setShowDatePicker(true);
    }
  }, []);

  const handleDatePickerChange = useCallback((_ev: unknown, selected?: Date) => {
    if (Platform.OS === 'android') setShowDatePicker(false);
    if (!selected) return;
    const y = selected.getFullYear();
    const m = String(selected.getMonth() + 1).padStart(2, '0');
    const d = String(selected.getDate()).padStart(2, '0');
    setFechaSeleccionada(`${y}-${m}-${d}`);
  }, []);

  const handleWebDateChange = useCallback((e: { target: { value: string } }) => {
    const v = e.target.value?.trim();
    if (v) setFechaSeleccionada(v);
  }, []);

  const renderIncidenciaCard = useCallback(
    (inc: Incidencia) => {
      const key = incidenciaKey(inc);
      const estadoVal = (inc.estado_valoracion ?? '').toString().toUpperCase();
      const reparado = estadoVal === 'REPARADO' || estadoVal === 'VALORADO';
      const totalVal = inc.valoracion_total != null ? Number(inc.valoracion_total) : null;
      const localId = (inc.local_id ?? '').toString().trim();
      const localNombre = localId ? (mapLocalIdToNombre[localId] ?? localId) : 'Sin local';
      return (
        <MantenimientoIncidenciaCard
          titulo={(inc.titulo ?? '—').toString()}
          descripcion={(inc.descripcion ?? '').toString() || undefined}
          categoria={(inc.categoria ?? '—').toString()}
          zona={(inc.zona ?? '—').toString()}
          prioridadColor={getPrioridadColor(inc.prioridad_reportada as string)}
          prioridadLabel={getPrioridadLabel(inc.prioridad_reportada as string)}
          fotos={fotosIncidencia(inc)}
          reparado={reparado}
          puedeReparar={incidenciaEstaProgramada(inc)}
          fechaCompletada={inc.fecha_completada ? String(inc.fecha_completada) : undefined}
          valoracionTotal={totalVal}
          marcando={marcandoReparadoKey === key}
          onReparar={() => abrirValoracion(inc)}
          onVerDetalle={() => setDetalleIncidencia(incidenciaADetalle(inc, localNombre))}
          onFotoPress={setExpandedPhotoUri}
          resolverUriFoto={resolverUriFoto}
          formatearFecha={formatearFechaIncidencia}
        />
      );
    },
    [marcandoReparadoKey, abrirValoracion, mapLocalIdToNombre],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando reparaciones…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={styles.headerNav}>
          <TouchableOpacity
            onPress={() => setFechaSeleccionada((f) => addDaysISO(f, -1))}
            style={styles.headerNavBtn}
            accessibilityLabel="Día anterior"
          >
            <MaterialIcons name="chevron-left" size={24} color="#334155" />
          </TouchableOpacity>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.title} numberOfLines={1}>{tituloPantalla}</Text>
            <View style={styles.headerDateRow}>
              {!esHoy(fechaSeleccionada) && (
                <TouchableOpacity
                  onPress={() => setFechaSeleccionada(getHoyISO())}
                  hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                >
                  <Text style={styles.hoyLink}>Ir a hoy</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.calBtn}
                onPress={abrirSelectorFecha}
                hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                accessibilityLabel="Seleccionar fecha"
              >
                <MaterialIcons name="calendar-today" size={16} color="#0ea5e9" />
                <Text style={styles.headerDateText}>{labelFechaConDia(fechaSeleccionada)}</Text>
              </TouchableOpacity>
              {Platform.OS === 'web' ? (
                createElement('input', {
                  ref: webDateInputRef,
                  type: 'date',
                  value: fechaSeleccionada,
                  onChange: handleWebDateChange,
                  style: {
                    position: 'absolute',
                    opacity: 0,
                    width: 0,
                    height: 0,
                    pointerEvents: 'none',
                  },
                  tabIndex: -1,
                  'aria-hidden': true,
                })
              ) : null}
            </View>
          </View>
          <TouchableOpacity
            onPress={() => setFechaSeleccionada((f) => addDaysISO(f, 1))}
            style={styles.headerNavBtn}
            accessibilityLabel="Día siguiente"
          >
            <MaterialIcons name="chevron-right" size={24} color="#334155" />
          </TouchableOpacity>
        </View>
      </View>

      {error ? (
        <View style={styles.errorWrap}>
          <MaterialIcons name="error-outline" size={32} color="#dc2626" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#0ea5e9']} />}
        >
          {columnas.length === 0 ? (
            <View style={styles.empty}>
              <MaterialIcons name="today" size={48} color="#94a3b8" />
              <Text style={styles.emptyTitle}>
                {esHoy(fechaSeleccionada)
                  ? 'No hay reparaciones programadas para hoy'
                  : `No hay reparaciones programadas para el ${labelFechaLarga(fechaSeleccionada)}`}
              </Text>
              <Text style={styles.emptySub}>
                {esHoy(fechaSeleccionada)
                  ? 'Las incidencias programadas para hoy aparecerán aquí, agrupadas por local.'
                  : 'Usa las flechas para consultar otros días. Las reparaciones aparecen agrupadas por local.'}
              </Text>
            </View>
          ) : (
            <MantenimientoLocalColumnBoard
              columns={columnas}
              mode={isAccordionMode ? 'accordion' : 'board'}
              boardCols={boardCols}
              expandedKeys={expandedLocals}
              onToggleExpand={toggleLocalExpand}
              renderCard={renderIncidenciaCard}
              getItemKey={(inc) => incidenciaKey(inc)}
              summary={{ locales: columnas.length, total: incidencias.length }}
            />
          )}
        </ScrollView>
      )}

      <MantenimientoIncidenciaDetalleModal
        visible={detalleIncidencia !== null}
        detalle={detalleIncidencia}
        onClose={() => setDetalleIncidencia(null)}
        resolverUriFoto={resolverUriFoto}
        onFotoPress={setExpandedPhotoUri}
      />

      <MantenimientoValoracionModal
        visible={valorandoInc !== null}
        titulo={valorandoInc ? (valorandoInc.titulo ?? '').toString() : undefined}
        guardando={guardandoValoracion}
        error={errorValoracion}
        onClose={() => {
          if (!guardandoValoracion) {
            setValorandoInc(null);
            setErrorValoracion(null);
          }
        }}
        onGuardar={guardarValoracion}
      />

      <Modal visible={expandedPhotoUri !== null} transparent animationType="fade" onRequestClose={() => setExpandedPhotoUri(null)}>
        <TouchableOpacity
          style={[styles.photoOverlay, Platform.OS === 'web' && styles.photoOverlayWeb]}
          activeOpacity={1}
          onPress={() => setExpandedPhotoUri(null)}
        >
          <View style={styles.photoExpandedWrap} pointerEvents="box-none">
            {expandedPhotoUri ? (
              <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} style={styles.photoExpandedTouch}>
                {Platform.OS === 'web' ? (
                  createElement('img', {
                    src: expandedPhotoUri,
                    alt: 'Foto ampliada',
                    style: {
                      maxWidth: '90vw',
                      maxHeight: '85vh',
                      width: photoExpandedSize.width,
                      height: photoExpandedSize.height,
                      objectFit: 'contain',
                    },
                    onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
                  })
                ) : (
                  <Image
                    key={expandedPhotoUri}
                    source={{ uri: expandedPhotoUri }}
                    style={[styles.photoExpanded as ImageStyle, { width: photoExpandedSize.width, height: photoExpandedSize.height }]}
                    resizeMode="contain"
                  />
                )}
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.photoCloseBtn} onPress={() => setExpandedPhotoUri(null)}>
              <MaterialIcons name="close" size={28} color="#fff" />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {showDatePicker && Platform.OS === 'android' ? (
        <DateTimePicker
          value={isoADate(fechaSeleccionada)}
          mode="date"
          display="default"
          onChange={handleDatePickerChange}
        />
      ) : null}

      {showDatePicker && Platform.OS === 'ios' ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setShowDatePicker(false)}>
          <Pressable style={styles.datePickerOverlay} onPress={() => setShowDatePicker(false)}>
            <Pressable style={styles.datePickerSheet} onPress={(e) => e.stopPropagation()}>
              <DateTimePicker
                value={isoADate(fechaSeleccionada)}
                mode="date"
                display="spinner"
                onChange={handleDatePickerChange}
              />
              <TouchableOpacity style={styles.datePickerOk} onPress={() => setShowDatePicker(false)}>
                <MaterialIcons name="check" size={24} color="#0ea5e9" />
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { fontSize: 14, color: '#64748b' },
  header: { flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  backBtn: { padding: 4, marginRight: 4 },
  headerNav: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  headerNavBtn: { padding: 4 },
  headerTitleWrap: { flex: 1, alignItems: 'center', minWidth: 0, gap: 2 },
  title: { fontSize: 16, fontWeight: '700', color: '#334155', textAlign: 'center' },
  headerDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 2,
  },
  hoyLink: { fontSize: 11, fontWeight: '600', color: '#0ea5e9' },
  calBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  headerDateText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
  },
  datePickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  datePickerSheet: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
  },
  datePickerOk: {
    alignSelf: 'center',
    marginTop: 8,
    padding: 8,
  },
  errorWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 12 },
  errorText: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
  retryBtn: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#f1f5f9', borderRadius: 10 },
  retryBtnText: { fontSize: 14, fontWeight: '600', color: '#0ea5e9' },
  scroll: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 24 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#64748b' },
  emptySub: { fontSize: 13, color: '#94a3b8', textAlign: 'center', maxWidth: 280 },
  photoOverlay: { flex: 1, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' },
  photoOverlayWeb: Platform.OS === 'web' ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 } : {},
  photoExpandedWrap: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute' as const,
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  photoExpandedTouch: { justifyContent: 'center', alignItems: 'center' },
  photoExpanded: { maxWidth: '100%', maxHeight: '100%' },
  photoCloseBtn: { position: 'absolute', top: 16, right: 16, padding: 8, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 24 },
});
