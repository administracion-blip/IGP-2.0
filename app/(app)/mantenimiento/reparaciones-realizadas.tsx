import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
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
  Image,
  type ImageStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useMantenimientoLocales, valorEnLocal } from './LocalesContext';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const DEFAULT_COL_WIDTH = 90;
const MIN_COL_WIDTH = 40;
const MAX_TEXT_LENGTH = 30;
const PAGE_SIZE = 50;

const COLUMNAS_INCIDENCIAS = [
  'fecha_creacion',
  'espera',
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

function calcularDiasEspera(fechaCreacion: string | undefined): number {
  if (!fechaCreacion) return 0;
  const creacion = new Date(fechaCreacion);
  if (isNaN(creacion.getTime())) return 0;
  const ahora = new Date();
  return Math.floor((ahora.getTime() - creacion.getTime()) / (1000 * 60 * 60 * 24));
}

function estilosEstado(estado: string | undefined): { backgroundColor: string; color: string } {
  const e = (estado ?? '').toString().trim();
  switch (e) {
    case 'Nuevo':
    case 'NUEVA':
      return { backgroundColor: '#dbeafe', color: '#1e40af' };
    case 'Programado':
      return { backgroundColor: '#fef3c7', color: '#b45309' };
    case 'Reparacion':
      return { backgroundColor: '#d1fae5', color: '#047857' };
    case 'CANCELADA':
      return { backgroundColor: '#fee2e2', color: '#b91c1c' };
    default:
      return { backgroundColor: '#f1f5f9', color: '#475569' };
  }
}

function headerLabel(col: string): string {
  if (col === 'nombre_local') return 'Local';
  if (col === 'fecha_programada') return 'Fecha programada';
  return col.replace(/_/g, ' ');
}

/** Convierte dd/mm/yyyy (o vacío) a yyyy-mm-dd para comparaciones y filtros. */
function parseDdMmYyyyToIso(s: string): { ok: true; iso: string } | { ok: false; error: string } {
  const t = s.trim();
  if (!t) return { ok: true, iso: '' };
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return { ok: false, error: 'Usa dd/mm/aaaa (ej. 14/04/2026)' };
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const yy = parseInt(m[3], 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return { ok: false, error: 'Fecha no válida' };
  const d = new Date(yy, mm - 1, dd);
  if (d.getFullYear() !== yy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return { ok: false, error: 'Fecha no válida' };
  return { ok: true, iso: `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}` };
}

function isoYyyyMmDdToDdMmYyyy(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, mo, da] = iso.split('-');
  return `${da}/${mo}/${y}`;
}

function cumpleRangoFechaCompletada(inc: Incidencia, desdeIso: string, hastaIso: string): boolean {
  if (!desdeIso.trim() && !hastaIso.trim()) return true;
  const fc = inc.fecha_completada;
  if (fc === undefined || fc === null || String(fc).trim() === '') return false;
  const d = new Date(fc as string);
  if (isNaN(d.getTime())) return false;
  if (desdeIso.trim()) {
    const start = new Date(desdeIso.trim() + 'T00:00:00');
    if (d < start) return false;
  }
  if (hastaIso.trim()) {
    const end = new Date(hastaIso.trim() + 'T23:59:59.999');
    if (d > end) return false;
  }
  return true;
}

function filtrarIncidenciasReparadas(
  list: Incidencia[],
  idsLocalesSeleccionados: string[],
  desdeIso: string,
  hastaIso: string,
  busquedaLower: string,
  valorCeldaFn: (inc: Incidencia, col: string) => string,
): Incidencia[] {
  let out = list;
  if (idsLocalesSeleccionados.length > 0) {
    const permitidos = new Set(idsLocalesSeleccionados);
    out = out.filter((i) => permitidos.has((i.local_id ?? '').toString().trim()));
  }
  out = out.filter((i) => cumpleRangoFechaCompletada(i, desdeIso, hastaIso));
  if (busquedaLower) {
    out = out.filter((inc) =>
      COLUMNAS_INCIDENCIAS.some((col) => {
        const val = valorCeldaFn(inc, col);
        return val !== '—' && val.toLowerCase().includes(busquedaLower);
      }),
    );
  }
  return out;
}

export default function ReparacionesRealizadasScreen() {
  const router = useRouter();
  const { locales } = useMantenimientoLocales();
  const [incidencias, setIncidencias] = useState<Incidencia[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [localFiltroIds, setLocalFiltroIds] = useState<string[]>([]);
  const [fechaDesdeIso, setFechaDesdeIso] = useState('');
  const [fechaHastaIso, setFechaHastaIso] = useState('');
  const [viewMode, setViewMode] = useState<'tabla' | 'deck'>('tabla');
  const [modalFiltrosVisible, setModalFiltrosVisible] = useState(false);
  const [draftLocalIds, setDraftLocalIds] = useState<string[]>([]);
  const [draftFechaDesde, setDraftFechaDesde] = useState('');
  const [draftFechaHasta, setDraftFechaHasta] = useState('');
  const [modalFiltroError, setModalFiltroError] = useState('');
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    titulo: 140,
    descripcion: 160,
    fecha_creacion: 130,
    nombre_local: 120,
    espera: 80,
  });
  const [pageIndex, setPageIndex] = useState(0);
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  const mapLocalIdToNombre = useMemo(() => {
    const m: Record<string, string> = {};
    locales.forEach((loc) => {
      const id = valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'id_locales') ?? '';
      const nombre = valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id;
      if (id) m[id] = nombre;
    });
    return m;
  }, [locales]);

  const todosLosIdsLocales = useMemo(
    () =>
      locales
        .map((loc) => valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'id_locales') ?? '')
        .filter(Boolean),
    [locales],
  );

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    fetch(`${API_URL}/api/mantenimiento/incidencias`)
      .then((res) => res.json())
      .then((data: { incidencias?: Incidencia[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        const all = data.incidencias || [];
        const permitidas = all.filter((i) => {
          const lid = (i.local_id ?? '').toString().trim();
          return !lid || lid in mapLocalIdToNombre;
        });
        const reparadas = permitidas.filter((i) => (i.estado ?? '').toString() === 'Reparacion');
        reparadas.sort((a, b) => {
          const fa = (a.fecha_completada ?? a.fecha_creacion ?? '').toString();
          const fb = (b.fecha_completada ?? b.fecha_creacion ?? '').toString();
          return fb.localeCompare(fa);
        });
        setIncidencias(reparadas);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [mapLocalIdToNombre]);

  useFocusEffect(
    useCallback(() => {
      setPageIndex(0);
      refetch();
    }, [refetch])
  );

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? DEFAULT_COL_WIDTH, [columnWidths]);

  const valorCelda = useCallback(
    (inc: Incidencia, col: string): string => {
      if (col === 'espera') {
        const estado = (inc.estado ?? '').toString();
        let dias: number;
        if (estado === 'Reparacion' && inc.fecha_completada) {
          const creacion = new Date(inc.fecha_creacion as string);
          const completada = new Date(inc.fecha_completada as string);
          dias = Math.floor((completada.getTime() - creacion.getTime()) / (1000 * 60 * 60 * 24));
        } else {
          dias = calcularDiasEspera(inc.fecha_creacion as string);
        }
        return dias === 0 ? 'Hoy' : dias === 1 ? '1 día' : `${dias} días`;
      }
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

  const incidenciasFiltradas = useMemo(
    () =>
      filtrarIncidenciasReparadas(
        incidencias,
        localFiltroIds,
        fechaDesdeIso,
        fechaHastaIso,
        filtroBusqueda.trim().toLowerCase(),
        valorCelda,
      ),
    [incidencias, localFiltroIds, fechaDesdeIso, fechaHastaIso, filtroBusqueda, valorCelda],
  );

  const incidenciasAgrupadasPorLocal = useMemo(() => {
    const byLocalId = new Map<string, Incidencia[]>();
    incidenciasFiltradas.forEach((inc) => {
      const localId = (inc.local_id ?? '').toString().trim() || '_sin_local';
      if (!byLocalId.has(localId)) byLocalId.set(localId, []);
      byLocalId.get(localId)!.push(inc);
    });
    return Array.from(byLocalId.entries()).map(([localId, incs]) => ({
      localId,
      nombreLocal: localId === '_sin_local' ? 'Sin local' : (mapLocalIdToNombre[localId] ?? localId),
      incidencias: incs,
    }));
  }, [incidenciasFiltradas, mapLocalIdToNombre]);

  const columnas = useMemo(() => [...COLUMNAS_INCIDENCIAS], []);
  const totalFiltrados = incidenciasFiltradas.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltrados / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);

  const incidenciasPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return incidenciasFiltradas.slice(start, start + PAGE_SIZE);
  }, [incidenciasFiltradas, pageIndexClamped]);

  const hayFiltrosActivos =
    localFiltroIds.length > 0 || fechaDesdeIso.trim() !== '' || fechaHastaIso.trim() !== '';

  const abrirModalFiltros = () => {
    setDraftLocalIds([...localFiltroIds]);
    setDraftFechaDesde(isoYyyyMmDdToDdMmYyyy(fechaDesdeIso));
    setDraftFechaHasta(isoYyyyMmDdToDdMmYyyy(fechaHastaIso));
    setModalFiltroError('');
    setModalFiltrosVisible(true);
  };

  const toggleDraftLocal = (id: string) => {
    setDraftLocalIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleSeleccionarTodosLocales = () => {
    setDraftLocalIds((prev) => (prev.length === todosLosIdsLocales.length ? [] : [...todosLosIdsLocales]));
  };

  const aplicarFiltrosModal = () => {
    const fd = parseDdMmYyyyToIso(draftFechaDesde);
    if (!fd.ok) {
      setModalFiltroError(fd.error);
      return;
    }
    const fh = parseDdMmYyyyToIso(draftFechaHasta);
    if (!fh.ok) {
      setModalFiltroError(fh.error);
      return;
    }
    if (fd.iso && fh.iso && fd.iso > fh.iso) {
      setModalFiltroError('La fecha Desde no puede ser posterior a Hasta');
      return;
    }
    setModalFiltroError('');
    const idsNormalized =
      todosLosIdsLocales.length > 0 && draftLocalIds.length === todosLosIdsLocales.length ? [] : [...draftLocalIds];
    setLocalFiltroIds(idsNormalized);
    setFechaDesdeIso(fd.iso);
    setFechaHastaIso(fh.iso);
    setPageIndex(0);
    setModalFiltrosVisible(false);
  };

  const limpiarFiltrosModal = () => {
    setDraftLocalIds([]);
    setDraftFechaDesde('');
    setDraftFechaHasta('');
    setLocalFiltroIds([]);
    setFechaDesdeIso('');
    setFechaHastaIso('');
    setModalFiltroError('');
    setPageIndex(0);
    setModalFiltrosVisible(false);
  };

  const goPrevPage = useCallback(() => setPageIndex((p) => Math.max(0, p - 1)), []);
  const goNextPage = useCallback(() => setPageIndex((p) => Math.min(totalPages - 1, p + 1)), [totalPages]);

  useEffect(() => {
    setPageIndex((prev) => (prev >= totalPages ? Math.max(0, totalPages - 1) : prev));
  }, [totalPages]);

  useEffect(() => {
    setPageIndex(0);
  }, [filtroBusqueda]);

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

  const renderCeldaEspera = (inc: Incidencia) => {
    const raw = valorCelda(inc, 'espera');
    const estado = (inc.estado ?? '').toString();
    let dias: number;
    if (estado === 'Reparacion' && inc.fecha_completada) {
      const creacion = new Date(inc.fecha_creacion as string);
      const completada = new Date(inc.fecha_completada as string);
      dias = Math.floor((completada.getTime() - creacion.getTime()) / (1000 * 60 * 60 * 24));
    } else {
      dias = calcularDiasEspera(inc.fecha_creacion as string);
    }
    const alerta = dias > 7 && (estado === 'Nuevo' || estado === 'Programado');
    return (
      <View
        style={[
          styles.cell,
          { width: getColWidth('espera'), flexDirection: 'row', alignItems: 'center', gap: 4 },
          alerta && { backgroundColor: '#fef2f2' },
        ]}
      >
        {alerta && <MaterialIcons name="warning" size={14} color="#dc2626" />}
        <Text style={[styles.cellText, alerta && { color: '#dc2626', fontWeight: '700' }]} numberOfLines={1} ellipsizeMode="tail">
          {raw}
        </Text>
      </View>
    );
  };

  const renderTabla = () => (
    <ScrollView horizontal style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.table}>
        <View style={styles.rowHeader}>
          {columnas.map((col) => (
            <View key={col} style={[styles.cellHeader, { width: getColWidth(col) }]}>
              <Text style={styles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">
                {headerLabel(col)}
              </Text>
              {Platform.OS === 'web' && (
                <View
                  style={styles.resizeHandle}
                  onMouseDown={(e: { nativeEvent?: { clientX: number }; clientX?: number }) => handleResizeStart(col, e)}
                />
              )}
            </View>
          ))}
        </View>
        {incidenciasPagina.map((inc, idx) => (
          <View key={`${inc.id_incidencia ?? idx}-${inc.fecha_creacion}`} style={styles.row}>
            {columnas.map((col) => {
              const raw = valorCelda(inc, col);
              const text = col === 'titulo' || col === 'descripcion' ? (raw.length > MAX_TEXT_LENGTH ? truncar(raw) : raw) : raw;
              const esEstado = col === 'estado';
              const estadoStyles = esEstado ? estilosEstado(inc.estado as string) : null;
              if (col === 'espera') return <React.Fragment key="espera">{renderCeldaEspera(inc)}</React.Fragment>;
              return (
                <View
                  key={col}
                  style={[
                    styles.cell,
                    { width: getColWidth(col) },
                    estadoStyles && { backgroundColor: estadoStyles.backgroundColor, borderRadius: 6 },
                  ]}
                >
                  <Text style={[styles.cellText, estadoStyles && { color: estadoStyles.color, fontWeight: '600' }]} numberOfLines={1} ellipsizeMode="tail">
                    {text}
                  </Text>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Reparaciones realizadas</Text>
        <TouchableOpacity style={styles.refreshBtn} onPress={refetch} disabled={loading} accessibilityLabel="Actualizar">
          {loading ? <ActivityIndicator size="small" color="#0ea5e9" /> : <MaterialIcons name="refresh" size={22} color="#0ea5e9" />}
        </TouchableOpacity>
      </View>
      <Text style={styles.subtitle}>Incidencias con estado Reparacion.</Text>

      <View style={styles.toolbarRow}>
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
        <TouchableOpacity
          style={[styles.filterBtn, hayFiltrosActivos && styles.filterBtnActive]}
          onPress={abrirModalFiltros}
          activeOpacity={0.7}
          accessibilityLabel="Filtros por fechas y local"
        >
          <MaterialIcons name="filter-list" size={20} color={hayFiltrosActivos ? '#fff' : '#0ea5e9'} />
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
      </View>

      {error && (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.subtitleRow}>
        <Text style={styles.subtitleTable}>
          {totalFiltrados === 0
            ? '0 registros'
            : totalPages > 1
              ? `${pageIndexClamped * PAGE_SIZE + 1}–${Math.min((pageIndexClamped + 1) * PAGE_SIZE, totalFiltrados)} de ${totalFiltrados} registro${totalFiltrados !== 1 ? 's' : ''}`
              : `${totalFiltrados} registro${totalFiltrados !== 1 ? 's' : ''}`}
        </Text>
        {viewMode === 'tabla' && totalPages > 1 && (
          <View style={styles.pagination}>
            <TouchableOpacity style={[styles.pageBtn, pageIndexClamped <= 0 && styles.pageBtnDisabled]} onPress={goPrevPage} disabled={pageIndexClamped <= 0}>
              <MaterialIcons name="chevron-left" size={20} color={pageIndexClamped <= 0 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
            <Text style={styles.pageText}>
              Página {pageIndexClamped + 1} de {totalPages}
            </Text>
            <TouchableOpacity style={[styles.pageBtn, pageIndexClamped >= totalPages - 1 && styles.pageBtnDisabled]} onPress={goNextPage} disabled={pageIndexClamped >= totalPages - 1}>
              <MaterialIcons name="chevron-right" size={20} color={pageIndexClamped >= totalPages - 1 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {loading && incidencias.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0ea5e9" />
          <Text style={styles.loadingText}>Cargando…</Text>
        </View>
      ) : viewMode === 'tabla' ? (
        renderTabla()
      ) : (
        <ScrollView style={styles.deckScrollWrap} contentContainerStyle={styles.deckScrollContent} showsVerticalScrollIndicator>
          {incidenciasAgrupadasPorLocal.length === 0 ? (
            <View style={styles.deckEmpty}>
              <Text style={styles.deckEmptyText}>No hay registros</Text>
            </View>
          ) : (
            incidenciasAgrupadasPorLocal.map((grupo) => (
              <View key={grupo.localId} style={styles.deckGroup}>
                <View style={styles.deckGroupHeader}>
                  <Text style={styles.deckGroupTitle}>{grupo.nombreLocal}</Text>
                  <View style={styles.deckGroupBadge}>
                    <Text style={styles.deckGroupBadgeText}>
                      {grupo.incidencias.length} {grupo.incidencias.length === 1 ? 'reparación' : 'reparaciones'}
                    </Text>
                  </View>
                </View>
                <View style={styles.deckGroupCards}>
                  {grupo.incidencias.map((inc, idx) => {
                    const prioridad = (inc.prioridad_reportada ?? '—').toString().trim().toLowerCase();
                    const prioridadLabel = prioridad && prioridad !== '—' ? prioridad.charAt(0).toUpperCase() + prioridad.slice(1) : '—';
                    const prioridadBg = getPrioridadColor(inc.prioridad_reportada as string);
                    const diasEspera = valorCelda(inc, 'espera');
                    return (
                      <View key={String(inc.id_incidencia ?? idx)} style={[styles.deckCard, styles.deckCardThird]}>
                        <View style={styles.deckCardTitleBar}>
                          <Text style={styles.deckCardTitleText} numberOfLines={2}>
                            {(inc.titulo ?? '—').toString()}
                          </Text>
                          <View style={[styles.deckPriorityBadge, { backgroundColor: prioridadBg }]}>
                            <Text style={styles.deckPriorityBadgeText}>{prioridadLabel}</Text>
                          </View>
                        </View>
                        <View style={styles.deckCardBody}>
                          <View style={styles.deckCardLine}>
                            <View style={styles.deckCardCell}>
                              <Text style={styles.deckLabel}>Creación</Text>
                              <Text style={styles.deckValue}>{formatearFecha(inc.fecha_creacion as string)}</Text>
                            </View>
                            <View style={styles.deckCardCell}>
                              <Text style={styles.deckLabel}>Reparado</Text>
                              <Text style={styles.deckValue}>{inc.fecha_completada ? formatearFecha(inc.fecha_completada as string) : '—'}</Text>
                            </View>
                          </View>
                          <View style={styles.deckCardLine}>
                            <View style={styles.deckCardCell}>
                              <Text style={styles.deckLabel}>Espera</Text>
                              <Text style={styles.deckValue}>{diasEspera}</Text>
                            </View>
                            <View style={styles.deckCardCell}>
                              <Text style={styles.deckLabel}>Zona</Text>
                              <Text style={styles.deckValue}>{(inc.zona ?? '—').toString()}</Text>
                            </View>
                          </View>
                          <View style={[styles.deckCardLine, styles.deckCardLineFixed]}>
                            <View style={styles.deckCardCellDesc}>
                              <Text style={styles.deckLabel}>Descripción</Text>
                              <Text style={[styles.deckValue, styles.deckValueDesc]}>{(inc.descripcion ?? '—').toString()}</Text>
                            </View>
                          </View>
                        </View>
                        <View style={styles.deckCardFotos}>
                          {[0, 1, 2].map((i) => {
                            const fotos = Array.isArray(inc.fotos) ? inc.fotos : [];
                            const uri = fotos[i];
                            if (uri && typeof uri === 'string') {
                              return (
                                <View key={i} style={styles.deckFotoThumbWrap}>
                                  <Image source={{ uri }} style={styles.deckFotoThumbH as ImageStyle} resizeMode="cover" />
                                </View>
                              );
                            }
                            return (
                              <View key={i} style={[styles.deckFotoThumbH, styles.deckFotoPlaceholder]}>
                                <MaterialIcons name="image-not-supported" size={20} color="#cbd5e1" />
                              </View>
                            );
                          })}
                        </View>
                      </View>
                    );
                  })}
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}

      <Modal
        visible={modalFiltrosVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setModalFiltroError('');
          setModalFiltrosVisible(false);
        }}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => {
            setModalFiltroError('');
            setModalFiltrosVisible(false);
          }}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalContentWrap}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Filtros</Text>
                <TouchableOpacity
                  onPress={() => {
                    setModalFiltroError('');
                    setModalFiltrosVisible(false);
                  }}
                  style={styles.modalClose}
                >
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                <View style={styles.modalBody}>
                  <Text style={styles.modalHint}>
                    El rango Desde / Hasta filtra únicamente por fecha completada (cuando se marcó la reparación). Formato dd/mm/aaaa. Locales: sin marcar ninguno se muestran todos.
                  </Text>
                  {modalFiltroError ? (
                    <View style={styles.modalErrorWrap}>
                      <MaterialIcons name="error-outline" size={18} color="#dc2626" />
                      <Text style={styles.modalErrorText}>{modalFiltroError}</Text>
                    </View>
                  ) : null}
                  <View style={styles.modalField}>
                    <Text style={styles.modalLabel}>Desde (fecha completada)</Text>
                    <TextInput
                      style={styles.modalInput}
                      value={draftFechaDesde}
                      onChangeText={(t) => {
                        setModalFiltroError('');
                        setDraftFechaDesde(t);
                      }}
                      placeholder="dd/mm/aaaa"
                      placeholderTextColor="#94a3b8"
                    />
                  </View>
                  <View style={styles.modalField}>
                    <Text style={styles.modalLabel}>Hasta (fecha completada)</Text>
                    <TextInput
                      style={styles.modalInput}
                      value={draftFechaHasta}
                      onChangeText={(t) => {
                        setModalFiltroError('');
                        setDraftFechaHasta(t);
                      }}
                      placeholder="dd/mm/aaaa"
                      placeholderTextColor="#94a3b8"
                    />
                  </View>
                  <View style={styles.modalField}>
                    <Text style={styles.modalLabel}>
                      Locales{' '}
                      <Text style={styles.modalLabelMuted}>
                        ({draftLocalIds.length === 0 ? 'todos' : `${draftLocalIds.length} seleccionado${draftLocalIds.length !== 1 ? 's' : ''}`})
                      </Text>
                    </Text>
                    <View style={styles.localesList}>
                      <TouchableOpacity style={styles.localeRowAll} onPress={toggleSeleccionarTodosLocales} activeOpacity={0.7}>
                        <MaterialIcons
                          name={draftLocalIds.length === todosLosIdsLocales.length && todosLosIdsLocales.length > 0 ? 'check-box' : 'check-box-outline-blank'}
                          size={20}
                          color="#0ea5e9"
                        />
                        <Text style={styles.localeRowAllText}>Seleccionar todos</Text>
                      </TouchableOpacity>
                      <ScrollView style={styles.localesScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {locales.map((loc) => {
                          const id = valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'id_locales') ?? '';
                          const nombre = valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id;
                          const selected = draftLocalIds.includes(id);
                          return (
                            <TouchableOpacity
                              key={id || nombre}
                              style={[styles.localeRow, selected && styles.localeRowSelected]}
                              onPress={() => {
                                setModalFiltroError('');
                                toggleDraftLocal(id);
                              }}
                              activeOpacity={0.7}
                            >
                              <MaterialIcons
                                name={selected ? 'check-box' : 'check-box-outline-blank'}
                                size={20}
                                color={selected ? '#0ea5e9' : '#94a3b8'}
                              />
                              <Text style={[styles.localeRowText, selected && styles.localeRowTextSelected]} numberOfLines={1}>
                                {nombre || id}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>
                    </View>
                  </View>
                  <View style={styles.modalFooter}>
                    <TouchableOpacity style={styles.modalBtnLimpiar} onPress={limpiarFiltrosModal}>
                      <Text style={styles.modalBtnLimpiarText}>Limpiar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.modalBtnAplicar} onPress={aplicarFiltrosModal}>
                      <Text style={styles.modalBtnAplicarText}>Aplicar</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </ScrollView>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  backBtn: { padding: 4 },
  refreshBtn: { padding: 4, marginLeft: 'auto' },
  title: { fontSize: 18, fontWeight: '700', color: '#334155', flex: 1 },
  subtitle: { fontSize: 13, color: '#64748b', lineHeight: 18, marginBottom: 8 },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 120, maxWidth: 320, height: 36, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 8 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 13, color: '#334155', paddingVertical: 0 },
  filterBtn: { padding: 8, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  filterBtnActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  viewModeWrap: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, overflow: 'hidden' },
  viewModeBtn: { padding: 8, backgroundColor: '#fff' },
  viewModeBtnActive: { backgroundColor: '#e0f2fe' },
  errorWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  errorText: { fontSize: 12, color: '#f87171', flex: 1 },
  retryBtn: { paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#fef2f2', borderRadius: 8 },
  retryBtnText: { fontSize: 12, color: '#dc2626', fontWeight: '600' },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 12, flexWrap: 'wrap' },
  subtitleTable: { fontSize: 12, color: '#64748b' },
  pagination: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pageBtn: { padding: 4 },
  pageBtnDisabled: { opacity: 0.5 },
  pageText: { fontSize: 11, color: '#64748b', marginHorizontal: 4 },
  center: { paddingVertical: 24, alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20 },
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
  cell: { minWidth: MIN_COL_WIDTH, paddingVertical: 4, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  cellText: { fontSize: 11, color: '#475569' },
  deckScrollWrap: { flex: 1 },
  deckScrollContent: { paddingBottom: 24 },
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
  },
  deckGroupTitle: { fontSize: 15, fontWeight: '700', color: '#334155' },
  deckGroupBadge: { backgroundColor: '#e2e8f0', paddingVertical: 2, paddingHorizontal: 6, borderRadius: 10 },
  deckGroupBadgeText: { fontSize: 10, fontWeight: '600', color: '#000' },
  deckGroupCards: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  deckCardThird: { width: '21%', minWidth: 104 },
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
  deckPriorityBadge: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, flexShrink: 0 },
  deckPriorityBadgeText: { fontSize: 10, fontWeight: '700', color: '#fff' },
  deckCardBody: { padding: 12, paddingBottom: 8 },
  deckCardLine: { flexDirection: 'row', gap: 12, marginBottom: 6 },
  deckCardLineFixed: { minHeight: 36 },
  deckCardCell: { flex: 1, minWidth: 0 },
  deckCardCellDesc: { flex: 1, minWidth: 0 },
  deckLabel: { fontSize: 9, fontWeight: '700', color: '#64748b', marginBottom: 1, textTransform: 'uppercase', letterSpacing: 0.2 },
  deckValue: { fontSize: 11, color: '#334155' },
  deckValueDesc: { lineHeight: 16, color: '#475569', fontSize: 11 },
  deckCardFotos: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    backgroundColor: '#fafafa',
  },
  deckFotoThumbWrap: { borderRadius: 6, overflow: 'hidden' },
  deckFotoThumbH: { width: 40, height: 40, borderRadius: 6, backgroundColor: '#e2e8f0' },
  deckFotoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalContentWrap: { width: '100%', maxWidth: 400, padding: 24, alignItems: 'center' },
  modalScroll: { maxHeight: 400 },
  modalCard: { width: '100%', backgroundColor: '#fff', borderRadius: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#334155' },
  modalClose: { padding: 4 },
  modalBody: { padding: 20 },
  modalHint: { fontSize: 12, color: '#64748b', marginBottom: 14, lineHeight: 18 },
  modalErrorWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8 },
  modalErrorText: { flex: 1, fontSize: 12, color: '#dc2626' },
  modalField: { marginBottom: 14 },
  modalLabel: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 6 },
  modalLabelMuted: { fontWeight: '400', color: '#94a3b8' },
  modalInput: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, fontSize: 14, color: '#334155', backgroundColor: '#fff' },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 8 },
  modalBtnLimpiar: { paddingVertical: 10, paddingHorizontal: 16, backgroundColor: '#f1f5f9', borderRadius: 10 },
  modalBtnLimpiarText: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  modalBtnAplicar: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#0ea5e9', borderRadius: 10 },
  modalBtnAplicarText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  localesList: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' },
  localeRowAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f0f9ff',
  },
  localeRowAllText: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  localesScroll: { maxHeight: 220 },
  localeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  localeRowSelected: { backgroundColor: '#f0f9ff' },
  localeRowText: { flex: 1, fontSize: 13, color: '#334155' },
  localeRowTextSelected: { color: '#0ea5e9', fontWeight: '500' },
});
