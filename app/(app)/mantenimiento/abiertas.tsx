import React, { useEffect, useState, useRef, useCallback, useMemo, createElement } from 'react';
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
  Image,
  useWindowDimensions,
  type ImageStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { ICONS, ICON_SIZE } from '../../constants/icons';
import { useMantenimientoLocales, valorEnLocal } from './LocalesContext';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const DEFAULT_COL_WIDTH = 90;
const MIN_COL_WIDTH = 40;
const MAX_TEXT_LENGTH = 30;
const PAGE_SIZE = 50;

const COLUMNAS_INCIDENCIAS = [
  'fecha_creacion',
  'fecha_programada',
  'fecha_completada',
  'estado_valoracion',
  'local_id',
  'nombre_local',
  'zona',
  'categoria',
  'titulo',
  'descripcion',
  'prioridad_reportada',
  'estado',
  'creado_por_id_usuario',
  'fotos',
  'id_incidencia',
] as const;

type Incidencia = Record<string, string | number | string[] | undefined>;

function truncar(val: string): string {
  if (val.length <= MAX_TEXT_LENGTH) return val;
  return val.slice(0, MAX_TEXT_LENGTH - 3) + '…';
}

function formatearFecha(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${dd}/${mm}/${yy} ${hh}:${min}:${ss}`;
  } catch {
    return String(iso);
  }
}

function formatearSoloFecha(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const s = String(iso).trim();
    const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[3]}/${match[2]}/${match[1]}`;
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear();
    return `${dd}/${mm}/${yy}`;
  } catch {
    return String(iso);
  }
}

function getWeekStart(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

const PRIORIDAD_COLOR: Record<string, string> = {
  urgente: '#dc2626',
  alta: '#ea580c',
  media: '#eab308',
  baja: '#16a34a',
};
function getPrioridadColor(p: string | undefined): string {
  if (!p) return '#94a3b8';
  const key = (p ?? '').toString().trim().toLowerCase();
  return PRIORIDAD_COLOR[key] ?? '#94a3b8';
}

const CHARS_PER_LINE_DESC = 100;
const AVG_CHAR_WIDTH_PX = 7;

function isDateInPast(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return true;
  const d = new Date(iso + 'T12:00:00');
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d.getTime() < hoy.getTime();
}

export default function IncidenciasAbiertasScreen() {
  const router = useRouter();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const photoExpandedSize = useMemo(() => ({
    width: Math.min(windowWidth * 0.9, 900),
    height: Math.min(windowHeight * 0.85, 700),
  }), [windowWidth, windowHeight]);
  const [incidencias, setIncidencias] = useState<Incidencia[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    titulo: 140,
    descripcion: 160,
    fecha_creacion: 130,
    nombre_local: 120,
  });
  const { locales } = useMantenimientoLocales();
  const mapLocalIdToNombre = useMemo(() => {
    const m: Record<string, string> = {};
    locales.forEach((loc) => {
      const id = valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'id_locales') ?? '';
      const nombre = valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id;
      if (id) m[id] = nombre;
    });
    return m;
  }, [locales]);
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [guardando, setGuardando] = useState(false);
  const [modalBorrarVisible, setModalBorrarVisible] = useState(false);
  const [incidenciasToDelete, setIncidenciasToDelete] = useState<{ local_id: string; id_incidencia: string; fecha_creacion: string }[]>([]);
  const [viewMode, setViewMode] = useState<'tabla' | 'deck'>('deck');
  const [calendarDate, setCalendarDate] = useState(() => new Date());
  const [expandedPhotoUri, setExpandedPhotoUri] = useState<string | null>(null);
  const [programandoIncidencia, setProgramandoIncidencia] = useState(false);
  const [marcandoReparadoKey, setMarcandoReparadoKey] = useState<string | null>(null);
  const [dragOverCalendarIso, setDragOverCalendarIso] = useState<string | null>(null);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  const refetchIncidencias = useCallback(() => {
    setError(null);
    fetch(`${API_URL}/api/mantenimiento/incidencias`)
      .then(async (res) => {
        const text = await res.text();
        if (!res.ok) {
          throw new Error(res.status === 404 ? `API no encontrada (404). Comprueba que el API esté en marcha en ${API_URL}` : `Error ${res.status}: ${text || res.statusText || 'Error de servidor'}`);
        }
        try {
          return JSON.parse(text) as { incidencias?: Incidencia[]; error?: string };
        } catch {
          throw new Error('Respuesta inválida del servidor');
        }
      })
      .then((data) => {
        if (data.error) setError(data.error);
        else {
          const list = data.incidencias || [];
          const abiertas = list.filter(
            (i) =>
              (i.estado ?? '') !== 'CANCELADA' &&
              ((i.estado_valoracion ?? '') as string).toString().toUpperCase() !== 'REPARADO'
          );
          setIncidencias(abiertas);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  const assignarFechaProgramada = useCallback(
    async (payload: { local_id: string; id_incidencia: string; fecha_creacion: string }, fechaProgramada: string) => {
      if (isDateInPast(fechaProgramada)) return;
      setProgramandoIncidencia(true);
      setError(null);
      try {
        const res = await fetch(`${API_URL}/api/mantenimiento/incidencias`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, fecha_programada: fechaProgramada }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? 'Error al programar');
          return;
        }
        refetchIncidencias();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error de conexión');
      } finally {
        setProgramandoIncidencia(false);
      }
    },
    [refetchIncidencias]
  );

  const quitarFechaProgramada = useCallback(
    async (inc: Incidencia) => {
      const localId = (inc.local_id ?? '').toString().trim();
      const idIncidencia = (inc.id_incidencia ?? '').toString().trim();
      const fechaCreacion = (inc.fecha_creacion ?? '').toString().trim();
      if (!localId || !idIncidencia || !fechaCreacion) return;
      setProgramandoIncidencia(true);
      setError(null);
      try {
        const res = await fetch(`${API_URL}/api/mantenimiento/incidencias`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ local_id: localId, id_incidencia: idIncidencia, fecha_creacion: fechaCreacion, fecha_programada: null }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? 'Error al quitar programación');
          return;
        }
        refetchIncidencias();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error de conexión');
      } finally {
        setProgramandoIncidencia(false);
      }
    },
    [refetchIncidencias]
  );

  const marcarReparado = useCallback(
    async (inc: Incidencia) => {
      const localId = (inc.local_id ?? '').toString().trim();
      const idIncidencia = (inc.id_incidencia ?? '').toString().trim();
      const fechaCreacion = (inc.fecha_creacion ?? '').toString().trim();
      if (!localId || !idIncidencia || !fechaCreacion) return;
      const key = `${localId}-${idIncidencia}-${fechaCreacion}`;
      setMarcandoReparadoKey(key);
      setError(null);
      try {
        const res = await fetch(`${API_URL}/api/mantenimiento/incidencias`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ local_id: localId, id_incidencia: idIncidencia, fecha_creacion: fechaCreacion, marcar_reparado: true }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? 'Error al marcar como reparado');
          return;
        }
        refetchIncidencias();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error de conexión');
      } finally {
        setMarcandoReparadoKey(null);
      }
    },
    [refetchIncidencias]
  );

  useEffect(() => {
    refetchIncidencias();
  }, [refetchIncidencias]);

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? DEFAULT_COL_WIDTH, [columnWidths]);

  const valorCelda = useCallback(
    (inc: Incidencia, col: string): string => {
      if (col === 'fecha_creacion') return formatearFecha(inc.fecha_creacion as string);
      if (col === 'fecha_programada') return formatearSoloFecha(inc.fecha_programada as string);
      if (col === 'fecha_completada') return inc.fecha_completada ? formatearFecha(inc.fecha_completada as string) : '—';
      if (col === 'estado_valoracion') return (inc.estado_valoracion ?? '').toString().trim() || '—';
      if (col === 'nombre_local') {
        const localId = (inc.local_id ?? '').toString().trim();
        return localId ? (mapLocalIdToNombre[localId] ?? localId) : '—';
      }
      if (col === 'fotos') {
        const fotos = inc.fotos;
        if (!Array.isArray(fotos) || fotos.length === 0) return '—';
        return `${fotos.length} foto${fotos.length !== 1 ? 's' : ''}`;
      }
      const key = Object.keys(inc).find((k) => k.toLowerCase() === col.toLowerCase());
      const raw = key != null ? inc[key] : inc[col];
      if (raw !== undefined && raw !== null && String(raw).trim() !== '') return String(raw);
      return '—';
    },
    [mapLocalIdToNombre]
  );

  const incidenciasFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return incidencias;
    return incidencias.filter((inc) =>
      COLUMNAS_INCIDENCIAS.some((col) => {
        const val = valorCelda(inc, col);
        return val !== '—' && val.toLowerCase().includes(q);
      })
    );
  }, [incidencias, filtroBusqueda, valorCelda]);

  const totalFiltrados = incidenciasFiltrados.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltrados / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);

  const incidenciasPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return incidenciasFiltrados.slice(start, start + PAGE_SIZE);
  }, [incidenciasFiltrados, pageIndexClamped]);

  const incidenciasAgrupadasPorLocal = useMemo(() => {
    const byLocalId = new Map<string, Incidencia[]>();
    incidenciasFiltrados.forEach((inc) => {
      const localId = (inc.local_id ?? '').toString().trim() || '_sin_local';
      if (!byLocalId.has(localId)) byLocalId.set(localId, []);
      byLocalId.get(localId)!.push(inc);
    });
    return Array.from(byLocalId.entries()).map(([localId, incidencias]) => ({
      localId,
      nombreLocal: localId === '_sin_local' ? 'Sin local' : (mapLocalIdToNombre[localId] ?? localId),
      incidencias,
    }));
  }, [incidenciasFiltrados, mapLocalIdToNombre]);

  const programadasPorDia = useMemo(() => {
    const map = new Map<string, { total: number; porLocal: Array<{ nombre: string; count: number }> }>();
    incidencias.forEach((inc) => {
      const fp = inc.fecha_programada;
      if (fp === undefined || fp === null || String(fp).trim() === '') return;
      const str = String(fp).trim();
      const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
      const iso = match ? match[1] : null;
      if (!iso) return;
      const localId = (inc.local_id ?? '').toString().trim();
      const nombreLocal = localId ? (mapLocalIdToNombre[localId] ?? localId) : 'Sin local';
      if (!map.has(iso)) map.set(iso, { total: 0, porLocal: [] });
      const entry = map.get(iso)!;
      entry.total += 1;
      const existing = entry.porLocal.find((p) => p.nombre === nombreLocal);
      if (existing) existing.count += 1;
      else entry.porLocal.push({ nombre: nombreLocal, count: 1 });
    });
    return map;
  }, [incidencias, mapLocalIdToNombre]);

  useEffect(() => {
    setPageIndex((prev) => (prev >= totalPages ? Math.max(0, totalPages - 1) : prev));
  }, [totalPages]);

  useEffect(() => {
    setPageIndex(0);
  }, [filtroBusqueda]);

  const goPrevPage = () => {
    setPageIndex((p) => Math.max(0, p - 1));
    setSelectedRowIndex(null);
    setSelectedIndices(new Set());
  };
  const goNextPage = () => {
    setPageIndex((p) => Math.min(totalPages - 1, p + 1));
    setSelectedRowIndex(null);
    setSelectedIndices(new Set());
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

  const seleccionarFila = (idx: number) => {
    if (multiSelectMode) {
      setSelectedIndices((prev) => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      });
    } else {
      setSelectedRowIndex((prev) => (prev === idx ? null : idx));
    }
  };

  const activarMultiSelect = (idx: number) => {
    setMultiSelectMode(true);
    setSelectedIndices(new Set([idx]));
    setSelectedRowIndex(null);
  };

  const salirMultiSelect = () => {
    setMultiSelectMode(false);
    setSelectedIndices(new Set());
    setSelectedRowIndex(null);
  };

  const toggleSeleccionTodas = () => {
    if (selectedIndices.size === incidenciasPagina.length) {
      setSelectedIndices(new Set());
    } else {
      setSelectedIndices(new Set(incidenciasPagina.map((_, i) => i)));
    }
  };

  const incidenciasSeleccionadas = multiSelectMode ? selectedIndices.size : (selectedRowIndex != null ? 1 : 0);
  const haySeleccion = incidenciasSeleccionadas > 0;

  const abrirModalBorrar = () => {
    const items: { local_id: string; id_incidencia: string; fecha_creacion: string }[] = [];
    if (multiSelectMode) {
      selectedIndices.forEach((idx) => {
        const inc = incidenciasPagina[idx];
        const localId = (inc.local_id ?? '').toString().trim();
        const idIncidencia = (inc.id_incidencia ?? '').toString().trim();
        const fechaCreacion = (inc.fecha_creacion ?? '').toString().trim();
        if (localId && idIncidencia && fechaCreacion) items.push({ local_id: localId, id_incidencia: idIncidencia, fecha_creacion: fechaCreacion });
      });
    } else if (selectedRowIndex != null) {
      const inc = incidenciasPagina[selectedRowIndex];
      const localId = (inc.local_id ?? '').toString().trim();
      const idIncidencia = (inc.id_incidencia ?? '').toString().trim();
      const fechaCreacion = (inc.fecha_creacion ?? '').toString().trim();
      if (localId && idIncidencia && fechaCreacion) items.push({ local_id: localId, id_incidencia: idIncidencia, fecha_creacion: fechaCreacion });
    }
    if (items.length === 0) return;
    setIncidenciasToDelete(items);
    setModalBorrarVisible(true);
  };

  const cerrarModalBorrar = () => {
    setModalBorrarVisible(false);
    setIncidenciasToDelete([]);
  };

  const ejecutarBorrado = async () => {
    if (incidenciasToDelete.length === 0) return;
    const items = [...incidenciasToDelete];
    cerrarModalBorrar();
    setGuardando(true);
    setError(null);
    try {
      for (const payload of items) {
        const res = await fetch(`${API_URL}/api/mantenimiento/incidencias`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? 'Error al borrar');
          return;
        }
      }
      refetchIncidencias();
      setSelectedRowIndex(null);
      salirMultiSelect();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const columnas = useMemo(() => [...COLUMNAS_INCIDENCIAS], []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando incidencias…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color="#f87171" />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => { setLoading(true); setError(null); refetchIncidencias(); }}>
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
        <Text style={styles.title}>Incidencias abiertas</Text>
      </View>

      <View style={styles.toolbarRow}>
        <TouchableOpacity
          style={styles.reportarBtn}
          onPress={() => router.push('/mantenimiento/reportar')}
        >
          <MaterialIcons name={ICONS.add} size={ICON_SIZE} color="#0ea5e9" />
          <Text style={styles.reportarBtnText}>Reportar incidencia</Text>
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
        <TouchableOpacity style={styles.refreshBtn} onPress={() => { setLoading(true); refetchIncidencias(); }}>
          <MaterialIcons name="refresh" size={ICON_SIZE} color="#0ea5e9" />
        </TouchableOpacity>
        <View style={styles.viewModeWrap}>
          <TouchableOpacity
            style={[styles.viewModeBtn, viewMode === 'tabla' && styles.viewModeBtnActive]}
            onPress={() => setViewMode('tabla')}
            accessibilityLabel="Vista tabla"
          >
            <MaterialIcons name="view-list" size={20} color={viewMode === 'tabla' ? '#0ea5e9' : '#94a3b8'} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.viewModeBtn, viewMode === 'deck' && styles.viewModeBtnActive]}
            onPress={() => setViewMode('deck')}
            accessibilityLabel="Vista tarjetas"
          >
            <MaterialIcons name="view-module" size={20} color={viewMode === 'deck' ? '#0ea5e9' : '#94a3b8'} />
          </TouchableOpacity>
        </View>
        {multiSelectMode && (
          <TouchableOpacity style={styles.cancelSelectBtn} onPress={salirMultiSelect}>
            <MaterialIcons name="close" size={ICON_SIZE} color="#64748b" />
            <Text style={styles.cancelSelectBtnText}>Cancelar selección</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.deleteBtn, (!haySeleccion || guardando) && styles.deleteBtnDisabled]}
          onPress={abrirModalBorrar}
          disabled={!haySeleccion || guardando}
          accessibilityLabel="Borrar incidencia"
        >
          <MaterialIcons name={ICONS.delete} size={ICON_SIZE} color={!haySeleccion || guardando ? '#94a3b8' : '#dc2626'} />
        </TouchableOpacity>
      </View>

      {viewMode === 'deck' && (
        <View style={styles.calendarAboveCount}>
          <View style={styles.calendarCard}>
            <>
              <View style={styles.calendarHeader}>
                <TouchableOpacity onPress={() => { const ws = getWeekStart(calendarDate); ws.setDate(ws.getDate() - 7); setCalendarDate(ws); }}>
                  <MaterialIcons name="chevron-left" size={24} color="#334155" />
                </TouchableOpacity>
                <Text style={styles.calendarTitle}>
                  {(() => {
                    const ws = getWeekStart(calendarDate);
                    const we = new Date(ws); we.setDate(we.getDate() + 6);
                    return `${ws.getDate()} ${MESES[ws.getMonth()]} - ${we.getDate()} ${MESES[we.getMonth()]} ${we.getFullYear()}`;
                  })()}
                </Text>
                <TouchableOpacity onPress={() => { const ws = getWeekStart(calendarDate); ws.setDate(ws.getDate() + 7); setCalendarDate(ws); }}>
                  <MaterialIcons name="chevron-right" size={24} color="#334155" />
                </TouchableOpacity>
              </View>
              <View style={styles.calendarWeekRow}>
                {DIAS_SEMANA.map((nombre, i) => {
                  const ws = getWeekStart(calendarDate);
                  const d = new Date(ws);
                  d.setDate(ws.getDate() + i);
                  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                  const isPast = isDateInPast(iso);
                  const dropHandlersWeek = Platform.OS === 'web'
                    ? {
                        onDragOver: (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); e.dataTransfer.dropEffect = isPast ? 'none' : 'move'; },
                        onDrop: (e: React.DragEvent<HTMLDivElement>) => {
                          e.preventDefault();
                          setDragOverCalendarIso(null);
                          if (isPast || programandoIncidencia) return;
                          const raw = e.dataTransfer.getData('application/json');
                          if (!raw) return;
                          try {
                            const payload = JSON.parse(raw) as { local_id: string; id_incidencia: string; fecha_creacion: string };
                            if (payload.local_id && payload.id_incidencia && payload.fecha_creacion) assignarFechaProgramada(payload, iso);
                          } catch {}
                        },
                      }
                    : {};
                  const programadasWeek = programadasPorDia.get(iso);
                  const isTodayWeek = (() => { const t = new Date(); return t.getFullYear() === d.getFullYear() && t.getMonth() === d.getMonth() && t.getDate() === d.getDate(); })();
                  const isDragOverWeek = Platform.OS === 'web' && dragOverCalendarIso === iso && !isPast;
                  const weekDayContent = (
                    <View style={[styles.calendarWeekDayCol, isPast && styles.calendarDayPast, isDragOverWeek && styles.calendarDayDragOver]}>
                      <Text style={styles.calendarWeekDayLabel}>{nombre}</Text>
                      <View style={[styles.calendarDayBadge, isTodayWeek && styles.calendarDayBadgeToday]}>
                        <Text style={[styles.calendarDayBadgeText, isTodayWeek && styles.calendarDayBadgeTextToday]}>{d.getDate()}</Text>
                      </View>
                      {programadasWeek && programadasWeek.total > 0 && (
                        <>
                          <Text style={[styles.calendarDayTotalLabel, isPast && styles.calendarDayPast]} numberOfLines={1} ellipsizeMode="tail">Total Rep: {programadasWeek.total}</Text>
                          <Text style={[styles.calendarDayPorLocal, isPast && styles.calendarDayPast]} numberOfLines={2} ellipsizeMode="tail">
                            {programadasWeek.porLocal.map((p) => `${p.nombre}:${p.count}`).join(' ')}
                          </Text>
                        </>
                      )}
                    </View>
                  );
                  const dropHandlersWeekWithDragOver = Platform.OS === 'web'
                    ? {
                        ...dropHandlersWeek,
                        onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
                          dropHandlersWeek.onDragOver?.(e);
                          if (!isPast) setDragOverCalendarIso(iso);
                        },
                        onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
                          const rect = e.currentTarget;
                          const related = e.relatedTarget as Node | null;
                          if (!related || !rect.contains(related)) setDragOverCalendarIso(null);
                        },
                      }
                    : dropHandlersWeek;
                  return Platform.OS === 'web' ? (
                    <div
                      key={`${nombre}-${iso}`}
                      {...dropHandlersWeekWithDragOver}
                      style={{ flex: 1, minWidth: 0, display: 'flex', alignSelf: 'stretch', border: '0.5px solid #f1f5f9', boxSizing: 'border-box', borderRadius: 8, overflow: 'hidden' }}
                    >
                      {weekDayContent}
                    </div>
                  ) : (
                    React.cloneElement(weekDayContent, { key: `${nombre}-${iso}` })
                  );
                })}
              </View>
            </>
          </View>
        </View>
      )}

      <View style={styles.subtitleRow}>
        <Text style={styles.subtitle}>
          {totalFiltrados === 0
            ? '0 registros'
            : totalPages > 1
              ? `${pageIndexClamped * PAGE_SIZE + 1}–${Math.min((pageIndexClamped + 1) * PAGE_SIZE, totalFiltrados)} de ${totalFiltrados} registro${totalFiltrados !== 1 ? 's' : ''}`
              : `${totalFiltrados} registro${totalFiltrados !== 1 ? 's' : ''}`}
        </Text>
        {totalPages > 1 && (
          <View style={styles.pagination}>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped <= 0 && styles.pageBtnDisabled]}
              onPress={goPrevPage}
              disabled={pageIndexClamped <= 0}
              accessibilityLabel="Página anterior"
            >
              <MaterialIcons name="chevron-left" size={20} color={pageIndexClamped <= 0 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
            <Text style={styles.pageText}>
              Página {pageIndexClamped + 1} de {totalPages}
            </Text>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped >= totalPages - 1 && styles.pageBtnDisabled]}
              onPress={goNextPage}
              disabled={pageIndexClamped >= totalPages - 1}
              accessibilityLabel="Página siguiente"
            >
              <MaterialIcons name="chevron-right" size={20} color={pageIndexClamped >= totalPages - 1 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {viewMode === 'deck' ? (
        <ScrollView style={styles.deckScrollWrap} contentContainerStyle={styles.deckScrollContent} showsVerticalScrollIndicator>
          <View style={styles.deckAndCalendarRow}>
          <ScrollView style={styles.deckColumn} contentContainerStyle={styles.deckContent} showsVerticalScrollIndicator>
            <View style={styles.deckContentInner}>
            {incidenciasAgrupadasPorLocal.length === 0 ? (
              <View style={styles.deckEmpty}>
                <Text style={styles.deckEmptyText}>No hay incidencias</Text>
              </View>
            ) : (
              incidenciasAgrupadasPorLocal.map((grupo) => (
                <View key={grupo.localId} style={styles.deckGroup}>
                  <View style={styles.deckGroupHeader}>
                    <Text style={styles.deckGroupTitle}>{grupo.nombreLocal}</Text>
                    <View style={styles.deckGroupBadge}>
                      <Text style={styles.deckGroupBadgeText}>
                        {grupo.incidencias.length} {grupo.incidencias.length === 1 ? 'incidencia' : 'incidencias'}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.deckGroupCards}>
                  {grupo.incidencias.map((inc, idx) => {
                    const prioridad = (inc.prioridad_reportada ?? '—').toString().trim().toLowerCase();
                    const prioridadLabel = prioridad && prioridad !== '—' ? prioridad.charAt(0).toUpperCase() + prioridad.slice(1) : '—';
                    const prioridadBg = getPrioridadColor(inc.prioridad_reportada as string);
                    const dragPayload = Platform.OS === 'web' ? {
                      local_id: (inc.local_id ?? '').toString(),
                      id_incidencia: (inc.id_incidencia ?? '').toString(),
                      fecha_creacion: (inc.fecha_creacion ?? '').toString(),
                    } : null;
                    const cardContent = (
                      <>
                        <View style={styles.deckCardTitleBar}>
                          <Text style={styles.deckCardTitleText}>{(inc.titulo ?? '—').toString()}</Text>
                          <View style={[styles.deckPriorityBadge, { backgroundColor: prioridadBg }]}>
                            <Text style={styles.deckPriorityBadgeText}>{prioridadLabel}</Text>
                          </View>
                        </View>
                        <View style={styles.deckCardBody}>
                          <View style={styles.deckCardLine}>
                            <View style={styles.deckCardCell}>
                              <Text style={styles.deckLabel}>Fecha creación</Text>
                              <Text style={styles.deckValue}>{formatearFecha(inc.fecha_creacion as string)}</Text>
                            </View>
                            <View style={styles.deckCardCell}>
                              <Text style={styles.deckLabel}>Local</Text>
                              <Text style={styles.deckValue}>{valorCelda(inc, 'nombre_local')}</Text>
                            </View>
                          </View>
                          <View style={[styles.deckCardLine, styles.deckCardLineFixed]}>
                            <View style={styles.deckCardCellDesc}>
                              <Text style={styles.deckLabel}>Descripción</Text>
                              <Text style={[styles.deckValue, styles.deckValueDesc]}>
                                {(inc.descripcion ?? '—').toString()}
                              </Text>
                            </View>
                          </View>
                        </View>
                        <View style={styles.deckCardFotos}>
                          {[0, 1, 2].map((i) => {
                            const fotos = Array.isArray(inc.fotos) ? inc.fotos : [];
                            const uri = fotos[i];
                            if (uri && typeof uri === 'string') {
                              return (
                                <TouchableOpacity
                                  key={i}
                                  onPress={() => {
                                  const resolvedUri = uri.startsWith('http') || uri.startsWith('data:')
                                    ? uri
                                    : `${API_URL}${uri.startsWith('/') ? '' : '/'}${uri}`;
                                  setExpandedPhotoUri(resolvedUri);
                                }}
                                  style={styles.deckFotoThumbWrap}
                                  activeOpacity={0.8}
                                >
                                  <View style={styles.deckFotoThumbInner}>
                                    <Image source={{ uri }} style={styles.deckFotoThumbH as ImageStyle} resizeMode="cover" />
                                  </View>
                                </TouchableOpacity>
                              );
                            }
                            return (
                              <View key={i} style={[styles.deckFotoThumbH, styles.deckFotoPlaceholder]}>
                                <MaterialIcons name="image-not-supported" size={20} color="#cbd5e1" />
                              </View>
                            );
                          })}
                        </View>
                        <View style={styles.deckCardProgramadoRow}>
                          {inc.fecha_programada != null && String(inc.fecha_programada).trim() !== '' ? (
                            <View style={styles.deckCardProgramado}>
                              <Text style={styles.deckCardProgramadoText}>Programado: {formatearSoloFecha(inc.fecha_programada as string)}</Text>
                            </View>
                          ) : null}
                          <View style={[styles.deckCardBotonesRightWrap, (inc.estado_valoracion ?? '').toString().toUpperCase() === 'REPARADO' && styles.deckCardBotonesCenter]}>
                            <View style={styles.deckCardReparadoWrap}>
                              {(inc.estado_valoracion ?? '').toString().toUpperCase() === 'REPARADO' ? (
                                <View style={styles.deckCardReparadoRow}>
                                  <MaterialIcons name="check-circle" size={12} color="#0f766e" />
                                  <Text style={styles.deckCardReparadoText}>
                                    Reparado {inc.fecha_completada ? formatearFecha(inc.fecha_completada as string) : ''}
                                  </Text>
                                </View>
                              ) : (
                                <TouchableOpacity
                                  onPress={() => marcarReparado(inc)}
                                  disabled={marcandoReparadoKey === `${(inc.local_id ?? '').toString().trim()}-${(inc.id_incidencia ?? '').toString().trim()}-${(inc.fecha_creacion ?? '').toString().trim()}`}
                                  style={styles.deckCardReparadoBtn}
                                  activeOpacity={0.7}
                                >
                                  {marcandoReparadoKey === `${(inc.local_id ?? '').toString().trim()}-${(inc.id_incidencia ?? '').toString().trim()}-${(inc.fecha_creacion ?? '').toString().trim()}` ? (
                                    <ActivityIndicator size="small" color="#0f766e" />
                                  ) : (
                                    <>
                                      <MaterialIcons name="build" size={10} color="#0f766e" />
                                      <Text style={styles.deckCardReparadoBtnText}>Reparado</Text>
                                    </>
                                  )}
                                </TouchableOpacity>
                              )}
                            </View>
                            {inc.fecha_programada != null && String(inc.fecha_programada).trim() !== '' && (inc.estado_valoracion ?? '').toString().toUpperCase() !== 'REPARADO' ? (
                              <TouchableOpacity
                                onPress={() => quitarFechaProgramada(inc)}
                                disabled={programandoIncidencia}
                                style={styles.deckCardDeshacerBtn}
                                activeOpacity={0.7}
                              >
                                <MaterialIcons name="undo" size={10} color="#dc2626" />
                                <Text style={styles.deckCardDeshacerText}>Deshacer</Text>
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        </View>
                        <View style={styles.deckCardEstado}>
                          <Text style={styles.deckCardEstadoText}>{(inc.estado ?? '—').toString()}</Text>
                        </View>
                      </>
                    );
                    if (Platform.OS === 'web' && dragPayload) {
                      return (
                        <div
                          key={String(inc.id_incidencia ?? idx)}
                          draggable
                          onDragStart={(e: React.DragEvent<HTMLDivElement>) => {
                            e.dataTransfer.setData('application/json', JSON.stringify(dragPayload));
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          style={{
                            width: '21%',
                            minWidth: 104,
                            marginBottom: 12,
                            cursor: 'grab',
                            boxSizing: 'border-box',
                          }}
                        >
                          <View style={styles.deckCard}>{cardContent}</View>
                        </div>
                      );
                    }
                    return (
                      <View key={String(inc.id_incidencia ?? idx)} style={[styles.deckCard, styles.deckCardThird]}>
                        {cardContent}
                      </View>
                    );
                  })}
                  </View>
                </View>
              ))
            )}
            </View>
          </ScrollView>
        </View>
        </ScrollView>
      ) : (
      <ScrollView horizontal style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.table}>
          <View style={styles.rowHeader}>
            {multiSelectMode && (
              <TouchableOpacity
                style={[styles.cellHeader, styles.cellCheckbox]}
                onPress={toggleSeleccionTodas}
                activeOpacity={0.7}
              >
                <MaterialIcons
                  name={selectedIndices.size === incidenciasPagina.length && incidenciasPagina.length > 0 ? 'check-box' : 'check-box-outline-blank'}
                  size={20}
                  color={selectedIndices.size === incidenciasPagina.length && incidenciasPagina.length > 0 ? '#0ea5e9' : '#94a3b8'}
                />
              </TouchableOpacity>
            )}
            {columnas.map((col) => (
              <View key={col} style={[styles.cellHeader, { width: getColWidth(col) }]}>
                <Text style={styles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">
                  {col === 'nombre_local' ? 'Local' : col === 'fecha_programada' ? 'Fecha programada' : col.replace(/_/g, ' ')}
                </Text>
                {Platform.OS === 'web' && (
                  <View
                    style={styles.resizeHandle}
                    {...({
                      onMouseDown: (e: { nativeEvent?: { clientX: number }; clientX?: number }) =>
                        handleResizeStart(col, e),
                    } as object)}
                  />
                )}
              </View>
            ))}
          </View>
          {incidenciasPagina.map((inc, idx) => {
            const isSelected = multiSelectMode ? selectedIndices.has(idx) : selectedRowIndex === idx;
            return (
            <TouchableOpacity
              key={String(inc.id_incidencia ?? idx)}
              style={[styles.row, isSelected && styles.rowSelected]}
              onPress={() => seleccionarFila(idx)}
              onLongPress={() => activarMultiSelect(idx)}
              delayLongPress={400}
              activeOpacity={0.8}
            >
              {multiSelectMode && (
                <View style={[styles.cell, styles.cellCheckbox]}>
                  <MaterialIcons
                    name={selectedIndices.has(idx) ? 'check-box' : 'check-box-outline-blank'}
                    size={20}
                    color={selectedIndices.has(idx) ? '#0ea5e9' : '#94a3b8'}
                  />
                </View>
              )}
              {columnas.map((col) => {
                const raw = valorCelda(inc, col);
                const text = col === 'titulo' || col === 'descripcion' ? (raw.length > MAX_TEXT_LENGTH ? truncar(raw) : raw) : raw;
                return (
                  <View key={col} style={[styles.cell, { width: getColWidth(col) }]}>
                    <Text style={styles.cellText} numberOfLines={1} ellipsizeMode="tail">
                      {text}
                    </Text>
                  </View>
                );
              })}
            </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>
      )}

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

      <Modal visible={modalBorrarVisible} transparent animationType="fade" onRequestClose={cerrarModalBorrar}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={cerrarModalBorrar}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalContentWrap}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{incidenciasToDelete.length === 1 ? 'Borrar Incidencia' : 'Borrar Incidencias'}</Text>
                <TouchableOpacity onPress={cerrarModalBorrar} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={styles.modalBody}>
                <Text style={styles.modalMessage}>
                  {incidenciasToDelete.length === 1
                    ? '¿Estás seguro de que deseas borrar esta incidencia?'
                    : `¿Estás seguro de que deseas borrar las ${incidenciasToDelete.length} incidencias seleccionadas?`}
                </Text>
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalBtnNo} onPress={cerrarModalBorrar}>
                    <Text style={styles.modalBtnNoText}>No</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.modalBtnSi} onPress={ejecutarBorrado} disabled={guardando}>
                    <Text style={styles.modalBtnSiText}>Sí</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </TouchableOpacity>
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
  retryBtn: { paddingVertical: 8, paddingHorizontal: 16, backgroundColor: '#0ea5e9', borderRadius: 8 },
  retryBtnText: { fontSize: 12, color: '#fff', fontWeight: '600' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12 },
  reportarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
  },
  reportarBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '600' },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 140, maxWidth: 280, height: 32, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 8 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 12, color: '#334155', paddingVertical: 0 },
  refreshBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  viewModeWrap: { flexDirection: 'row', alignItems: 'center', gap: 0, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, overflow: 'hidden' },
  viewModeBtn: { padding: 6, backgroundColor: '#f8fafc' },
  viewModeBtnActive: { backgroundColor: '#e0f2fe' },
  deleteBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#fef2f2' },
  deleteBtnDisabled: { opacity: 0.6 },
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
  deckScrollWrap: { flex: 1 },
  deckScrollContent: { flexGrow: 1, paddingBottom: 40 },
  deckAndCalendarRow: { flex: 1, flexDirection: 'row' },
  deckColumn: { flex: 1, minWidth: 0 },
  calendarAboveCount: { width: '100%', paddingBottom: 6 },
  deckContent: { paddingBottom: 24, paddingHorizontal: 4, alignItems: 'flex-start' },
  deckContentInner: { width: '100%' },
  calendarCard: {
    width: '100%',
    alignSelf: 'stretch',
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  calendarHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  calendarTitle: { fontSize: 16, fontWeight: '600', color: '#334155', flex: 1, textAlign: 'center' },
  calendarDayDragOver: { backgroundColor: '#fbcfe8', borderColor: '#db2777', borderWidth: 2 },
  calendarDayBadge: { backgroundColor: '#e2e8f0', borderRadius: 5, paddingVertical: 2, paddingHorizontal: 4, alignSelf: 'center', marginBottom: 2 },
  calendarDayBadgeToday: { backgroundColor: '#0ea5e9' },
  calendarDayBadgeText: { fontSize: 11, fontWeight: '700', color: '#475569', lineHeight: 14 },
  calendarDayBadgeTextToday: { color: '#fff' },
  calendarDayPast: { opacity: 0.5 },
  calendarDayTotalLabel: { fontSize: 9, fontWeight: '700', color: '#c026d3', marginTop: 0, marginBottom: 0, lineHeight: 12, textAlign: 'center' },
  calendarDayPorLocal: { fontSize: 8, color: '#64748b', marginTop: 0, marginBottom: 0, lineHeight: 10, textAlign: 'center' },
  calendarWeekRow: { flexDirection: 'row', gap: 6 },
  calendarWeekDayCol: { flex: 1, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 6, backgroundColor: '#f8fafc', borderRadius: 8, borderWidth: 0.5, borderColor: '#f1f5f9', overflow: 'hidden' },
  calendarWeekDayLabel: { fontSize: 12, fontWeight: '600', color: '#64748b', marginBottom: 6 },
  calendarWeekDayNum: { fontSize: 18, fontWeight: '700', color: '#334155' },
  deckEmpty: { padding: 24, alignItems: 'center' },
  deckEmptyText: { fontSize: 13, color: '#94a3b8' },
  deckGroup: { marginBottom: 12 },
  deckGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    paddingVertical: 4,
    paddingHorizontal: 12,
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#0ea5e9',
    height: 20,
  },
  deckGroupTitle: { fontSize: 15, fontWeight: '700', color: '#334155' },
  deckGroupBadge: { backgroundColor: '#e2e8f0', paddingVertical: 2, paddingHorizontal: 6, borderRadius: 10 },
  deckGroupBadgeText: { fontSize: 10, fontWeight: '600', color: '#000' },
  deckGroupCards: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  deckCardThird: { width: '21%', minWidth: 104 },
  deckCardDraggableCursor: Platform.OS === 'web' ? { cursor: 'pointer' } : {},
  deckCard: {
    position: 'relative',
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 3,
  },
  deckCardTitleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: '#e2e8f0',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  deckCardTitleText: { fontSize: 11, fontWeight: '700', color: '#334155', flex: 1, minWidth: 0 },
  deckPriorityBadge: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    flexShrink: 0,
  },
  deckPriorityBadgeText: { fontSize: 10, fontWeight: '700', color: '#fff' },
  deckCardBody: { padding: 14, paddingTop: 10, paddingRight: 72, paddingBottom: 8 },
  deckCardLine: { flexDirection: 'row', gap: 12, marginBottom: 6 },
  deckCardLineFixed: { minHeight: 40 },
  deckCardCell: { flex: 1, minWidth: 0 },
  deckCardCellDesc: { flex: 1, minWidth: 0 },
  deckCardFotos: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    backgroundColor: '#fafafa',
  },
  deckCardBottomRow: { position: 'absolute', bottom: 6, left: 8, right: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  deckCardBottomSpacer: { flex: 1 },
  deckCardBottomCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  deckCardProgramadoRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  deckCardProgramado: { paddingVertical: 4, paddingHorizontal: 8, backgroundColor: '#dcfce7', borderRadius: 6 },
  deckCardProgramadoText: { fontSize: 10, fontWeight: '700', color: '#166534' },
  deckCardDeshacerBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 5, paddingHorizontal: 7, backgroundColor: '#fef2f2', borderRadius: 6, borderWidth: 1, borderColor: '#fecaca' },
  deckCardDeshacerText: { fontSize: 9, fontWeight: '600', color: '#dc2626' },
  deckCardBotonesRightWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginRight: 6 },
  deckCardBotonesCenter: { justifyContent: 'center' },
  deckCardReparadoWrap: { marginTop: -2 },
  deckCardReparadoRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  deckCardReparadoText: { fontSize: 9, fontWeight: '600', color: '#0d9488' },
  deckCardReparadoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 5,
    paddingHorizontal: 7,
    backgroundColor: '#f0fdfa',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#99f6e4',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 4,
  },
  deckCardReparadoBtnText: { fontSize: 9, fontWeight: '600', color: '#0f766e' },
  deckCardEstadoWrap: { flex: 1, alignItems: 'flex-end', justifyContent: 'center' },
  deckCardEstado: {
    paddingVertical: 2,
    paddingHorizontal: 6,
    backgroundColor: '#f1f5f9',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  deckCardEstadoText: { fontSize: 9, fontWeight: '600', color: '#64748b' },
  deckFotoThumbWrap: { borderRadius: 6, overflow: 'hidden' },
  deckFotoThumbInner: { borderRadius: 6, overflow: 'hidden' },
  deckFotoThumbH: { width: 40, height: 40, borderRadius: 6, backgroundColor: '#e2e8f0' },
  deckLabel: { fontSize: 9, fontWeight: '700', color: '#64748b', marginBottom: 1, textTransform: 'uppercase', letterSpacing: 0.2 },
  deckValue: { fontSize: 11, color: '#334155' },
  deckValueTitle: { fontWeight: '600', color: '#0f172a', fontSize: 11 },
  deckValueDesc: { lineHeight: 16, color: '#475569', fontSize: 11 },
  deckFotoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  photoOverlay: { flex: 1, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' },
  photoOverlayWeb: Platform.OS === 'web' ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 } : {},
  photoExpandedWrap: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', position: 'absolute' as const, left: 0, right: 0, top: 0, bottom: 0 },
  photoExpandedTouch: { justifyContent: 'center', alignItems: 'center' },
  photoExpanded: { maxWidth: '100%', maxHeight: '100%' },
  photoCloseBtn: { position: 'absolute', top: 16, right: 16, padding: 8, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 24 },
  table: { minWidth: '100%', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' },
  rowHeader: { flexDirection: 'row', backgroundColor: '#e2e8f0', borderBottomWidth: 1, borderBottomColor: '#cbd5e1' },
  cellHeader: { minWidth: MIN_COL_WIDTH, paddingVertical: 6, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#cbd5e1', position: 'relative' },
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
  cellCheckbox: { width: 40, minWidth: 40, alignItems: 'center', justifyContent: 'center' },
  cellText: { fontSize: 11, color: '#475569' },
  cancelSelectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
  },
  cancelSelectBtnText: { fontSize: 12, color: '#64748b', fontWeight: '500' },
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalContentWrap: { width: '100%', maxWidth: 360, padding: 24, alignItems: 'center' },
  modalCard: { width: '100%', backgroundColor: '#fff', borderRadius: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#334155' },
  modalClose: { padding: 4 },
  modalBody: { padding: 20 },
  modalMessage: { fontSize: 14, color: '#475569', marginBottom: 20, lineHeight: 20 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  modalBtnNo: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#f1f5f9', borderRadius: 10 },
  modalBtnNoText: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  modalBtnSi: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#dc2626', borderRadius: 10 },
  modalBtnSiText: { fontSize: 14, fontWeight: '600', color: '#fff' },
});
