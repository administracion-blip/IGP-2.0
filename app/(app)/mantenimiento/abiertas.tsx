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
  type ImageStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { ICONS, ICON_SIZE } from '../../constants/icons';
import { useLocalesPermitidos, valorEnLocal } from '../../contexts/LocalesContext';
import { apiFetch } from '../../utils/api';
import {
  incidenciaEstaProgramada,
  getPrioridadColor,
  getPrioridadLabel,
  getPrioridadOrden,
  contarUrgentes,
  formatearFechaIncidencia,
} from '../../lib/mantenimientoIncidenciaUi';
import {
  cierreSinFacturaDeParte,
  facturaMantenimientoDeParte,
} from '../../lib/mantenimientoFacturacion';
import { MantenimientoIncidenciaCard } from '../../components/mantenimiento/MantenimientoIncidenciaCard';
import {
  MantenimientoIncidenciaDetalleModal,
  type MantenimientoIncidenciaDetalle,
  type LineaValoracionDetalle,
} from '../../components/mantenimiento/MantenimientoIncidenciaDetalleModal';
import {
  MantenimientoLocalColumnBoard,
  type MantenimientoBoardColumn,
} from '../../components/mantenimiento/MantenimientoLocalColumnBoard';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { BREAKPOINTS } from '../../constants/layout';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

function resolverUriFoto(uri: string): string {
  const u = uri.trim();
  if (u.startsWith('http') || u.startsWith('data:')) return u;
  return `${API_URL}${u.startsWith('/') ? '' : '/'}${u}`;
}

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

function fotosIncidencia(inc: Incidencia): string[] {
  if (!Array.isArray(inc.fotos)) return [];
  return inc.fotos.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}

function incidenciaKey(inc: Incidencia): string {
  return `${(inc.local_id ?? '').toString().trim()}-${(inc.id_incidencia ?? '').toString().trim()}-${(inc.fecha_creacion ?? '').toString().trim()}`;
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
    factura: facturaMantenimientoDeParte(inc),
    cierre: cierreSinFacturaDeParte(inc),
  };
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

const CHARS_PER_LINE_DESC = 100;
const AVG_CHAR_WIDTH_PX = 7;

function defaultExpandedKey(columns: MantenimientoBoardColumn<Incidencia>[]): string | null {
  if (columns.length === 0) return null;
  const conUrgente = columns.find((c) => (c.urgentCount ?? 0) > 0);
  return conUrgente?.key ?? columns[0].key;
}

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
  const { width, height } = useBreakpoint();
  const isAccordionMode = width < BREAKPOINTS.tablet;
  // 1280 px: columnas del tablero; no está en los breakpoints de layout.
  const boardCols = width >= 1280 ? 6 : 4;
  const photoExpandedSize = useMemo(() => ({
    width: Math.min(width * 0.9, 900),
    height: Math.min(height * 0.85, 700),
  }), [width, height]);
  const [incidencias, setIncidencias] = useState<Incidencia[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    titulo: 140,
    descripcion: 160,
    fecha_creacion: 130,
    nombre_local: 120,
  });
  const { locales } = useLocalesPermitidos();
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
  const [detalleIncidencia, setDetalleIncidencia] = useState<MantenimientoIncidenciaDetalle | null>(null);
  const [programandoIncidencia, setProgramandoIncidencia] = useState(false);
  const [marcandoReparadoKey, setMarcandoReparadoKey] = useState<string | null>(null);
  const [dragOverCalendarIso, setDragOverCalendarIso] = useState<string | null>(null);
  const [expandedLocals, setExpandedLocals] = useState<Set<string>>(new Set());
  const [soloProgramadas, setSoloProgramadas] = useState(false);
  const [programadasDiaModalIso, setProgramadasDiaModalIso] = useState<string | null>(null);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  const refetchIncidencias = useCallback(() => {
    setError(null);
    apiFetch('/api/mantenimiento/incidencias')
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
          setIncidencias(abiertas.filter((i) => {
            const lid = (i.local_id ?? '').toString().trim();
            return !lid || lid in mapLocalIdToNombre;
          }));
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [mapLocalIdToNombre]);

  const assignarFechaProgramada = useCallback(
    async (payload: { local_id: string; id_incidencia: string; fecha_creacion: string }, fechaProgramada: string) => {
      if (isDateInPast(fechaProgramada)) return;
      setProgramandoIncidencia(true);
      setError(null);
      try {
        const res = await apiFetch('/api/mantenimiento/incidencias', {
          method: 'PATCH',
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
        const res = await apiFetch('/api/mantenimiento/incidencias', {
          method: 'PATCH',
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
        const res = await apiFetch('/api/mantenimiento/incidencias', {
          method: 'PATCH',
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
    let lista = incidencias;
    if (soloProgramadas) {
      lista = lista.filter(
        (inc) =>
          inc.fecha_programada != null &&
          String(inc.fecha_programada).trim() !== '' &&
          (inc.estado ?? '').toString() === 'Programado',
      );
    } else {
      lista = lista.filter((inc) => {
        const estado = (inc.estado ?? '').toString();
        return estado !== 'Programado' && estado !== 'Reparacion';
      });
    }
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return lista;
    return lista.filter((inc) =>
      COLUMNAS_INCIDENCIAS.some((col) => {
        const val = valorCelda(inc, col);
        return val !== '—' && val.toLowerCase().includes(q);
      })
    );
  }, [incidencias, filtroBusqueda, valorCelda, soloProgramadas]);

  const totalFiltrados = incidenciasFiltrados.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltrados / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);

  const incidenciasPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return incidenciasFiltrados.slice(start, start + PAGE_SIZE);
  }, [incidenciasFiltrados, pageIndexClamped]);

  const columnasPorLocal = useMemo((): MantenimientoBoardColumn<Incidencia>[] => {
    const byLocal = new Map<string, Incidencia[]>();
    const ordenadas = [...incidenciasFiltrados].sort(
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
  }, [incidenciasFiltrados, mapLocalIdToNombre]);

  const columnKeysSig = useMemo(
    () => columnasPorLocal.map((c) => c.key).join('|'),
    [columnasPorLocal],
  );

  useEffect(() => {
    if (!isAccordionMode) {
      setExpandedLocals(new Set());
      return;
    }
    if (!columnKeysSig) return;
    const key = defaultExpandedKey(columnasPorLocal);
    setExpandedLocals(key ? new Set([key]) : new Set());
  }, [isAccordionMode, columnKeysSig, columnasPorLocal, filtroBusqueda, soloProgramadas]);

  const toggleLocalExpand = useCallback((key: string) => {
    setExpandedLocals((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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

  const incidenciasPorDiaProgramada = useMemo(() => {
    const map = new Map<string, Incidencia[]>();
    incidencias.forEach((inc) => {
      const fp = inc.fecha_programada;
      if (fp === undefined || fp === null || String(fp).trim() === '') return;
      const str = String(fp).trim();
      const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
      const iso = match ? match[1] : null;
      if (!iso) return;
      if (!map.has(iso)) map.set(iso, []);
      map.get(iso)!.push(inc);
    });
    return map;
  }, [incidencias]);

  const programadasDiaAgrupadasPorLocal = useMemo(() => {
    if (!programadasDiaModalIso) return [] as { localId: string; nombreLocal: string; incidencias: Incidencia[] }[];
    const list = incidenciasPorDiaProgramada.get(programadasDiaModalIso) ?? [];
    const byLocal = new Map<string, Incidencia[]>();
    list.forEach((inc) => {
      const localId = (inc.local_id ?? '').toString().trim() || '_sin_local';
      if (!byLocal.has(localId)) byLocal.set(localId, []);
      byLocal.get(localId)!.push(inc);
    });
    return Array.from(byLocal.entries()).map(([localId, incidenciasGrupo]) => ({
      localId,
      nombreLocal: localId === '_sin_local' ? 'Sin local' : (mapLocalIdToNombre[localId] ?? localId),
      incidencias: incidenciasGrupo,
    }));
  }, [programadasDiaModalIso, incidenciasPorDiaProgramada, mapLocalIdToNombre]);

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
        const res = await apiFetch('/api/mantenimiento/incidencias', {
          method: 'DELETE',
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

  const renderIncidenciaCard = useCallback(
    (inc: Incidencia) => {
      const key = incidenciaKey(inc);
      const localId = (inc.local_id ?? '').toString().trim();
      const localNombre = localId ? (mapLocalIdToNombre[localId] ?? localId) : 'Sin local';
      const estadoVal = (inc.estado_valoracion ?? '').toString().toUpperCase();
      const reparado = estadoVal === 'REPARADO' || estadoVal === 'VALORADO';
      const fotos = fotosIncidencia(inc);
      const tieneProgramada =
        inc.fecha_programada != null && String(inc.fecha_programada).trim() !== '';
      const estadoTxt = (inc.estado ?? '—').toString();

      const cardContent = (
        <>
          <MantenimientoIncidenciaCard
            titulo={(inc.titulo ?? '—').toString()}
            descripcion={(inc.descripcion ?? '').toString() || undefined}
            categoria={(inc.categoria ?? '—').toString()}
            zona={(inc.zona ?? '—').toString()}
            prioridadColor={getPrioridadColor(inc.prioridad_reportada as string)}
            prioridadLabel={getPrioridadLabel(inc.prioridad_reportada as string)}
            fotos={fotos}
            reparado={reparado}
            puedeReparar={incidenciaEstaProgramada(inc)}
            fechaCompletada={inc.fecha_completada ? String(inc.fecha_completada) : undefined}
            valoracionTotal={inc.valoracion_total != null ? Number(inc.valoracion_total) : null}
            marcando={marcandoReparadoKey === key}
            onReparar={() => void marcarReparado(inc)}
            onVerDetalle={() => setDetalleIncidencia(incidenciaADetalle(inc, localNombre))}
            onFotoPress={(uri) => setExpandedPhotoUri(uri)}
            resolverUriFoto={resolverUriFoto}
            formatearFecha={formatearFechaIncidencia}
          />
          <View style={styles.cardExtras}>
            <View style={styles.cardExtrasRow}>
              {tieneProgramada ? (
                <View style={styles.cardProgramado}>
                  <Text style={styles.cardProgramadoText}>
                    Programado: {formatearSoloFecha(inc.fecha_programada as string)}
                  </Text>
                </View>
              ) : (
                <View style={styles.cardExtrasSpacer} />
              )}
              <View style={styles.cardEstado}>
                <Text style={styles.cardEstadoText}>{estadoTxt}</Text>
              </View>
            </View>
            {tieneProgramada && !reparado ? (
              <TouchableOpacity
                onPress={() => quitarFechaProgramada(inc)}
                disabled={programandoIncidencia}
                style={styles.cardDeshacerBtn}
                activeOpacity={0.7}
              >
                <MaterialIcons name="undo" size={12} color={colors.danger} />
                <Text style={styles.cardDeshacerText}>Quitar programación</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </>
      );

      if (Platform.OS === 'web') {
        const dragPayload = {
          local_id: (inc.local_id ?? '').toString(),
          id_incidencia: (inc.id_incidencia ?? '').toString(),
          fecha_creacion: (inc.fecha_creacion ?? '').toString(),
        };
        return createElement(
          'div',
          {
            draggable: true,
            onDragStart: (e: React.DragEvent<HTMLDivElement>) => {
              e.dataTransfer.setData('application/json', JSON.stringify(dragPayload));
              e.dataTransfer.effectAllowed = 'move';
            },
            style: { width: '100%', cursor: 'grab', boxSizing: 'border-box' },
          },
          cardContent,
        );
      }

      return cardContent;
    },
    [
      mapLocalIdToNombre,
      marcandoReparadoKey,
      marcarReparado,
      programandoIncidencia,
      quitarFechaProgramada,
    ],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.loadingText}>Cargando incidencias…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color={colors.danger} />
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
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Incidencias abiertas</Text>
      </View>

      <View style={styles.toolbarRow}>
        <TouchableOpacity
          style={styles.reportarBtn}
          onPress={() => router.push('/mantenimiento/reportar')}
        >
          <MaterialIcons name={ICONS.add} size={ICON_SIZE} color={colors.accent} />
          <Text style={styles.reportarBtnText}>Reportar incidencia</Text>
        </TouchableOpacity>
        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color={colors.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar en la tabla…"
            placeholderTextColor={colors.textMuted}
          />
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={() => { setLoading(true); refetchIncidencias(); }}>
          <MaterialIcons name="refresh" size={ICON_SIZE} color={colors.accent} />
        </TouchableOpacity>
        <View style={styles.viewModeWrap}>
          <TouchableOpacity
            style={[styles.viewModeBtn, viewMode === 'tabla' && styles.viewModeBtnActive]}
            onPress={() => setViewMode('tabla')}
            accessibilityLabel="Vista tabla"
          >
            <MaterialIcons name="view-list" size={20} color={viewMode === 'tabla' ? colors.accent : colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.viewModeBtn, viewMode === 'deck' && styles.viewModeBtnActive]}
            onPress={() => setViewMode('deck')}
            accessibilityLabel="Vista tarjetas"
          >
            <MaterialIcons name="view-module" size={20} color={viewMode === 'deck' ? colors.accent : colors.textMuted} />
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={[styles.filterProgramadasBtn, soloProgramadas && styles.filterProgramadasBtnActive]}
          onPress={() => setSoloProgramadas((v) => !v)}
          activeOpacity={0.7}
          accessibilityLabel="Filtrar solo programadas"
        >
          <MaterialIcons name="event-available" size={18} color={soloProgramadas ? colors.surface : colors.accent} />
          <Text style={[styles.filterProgramadasText, soloProgramadas && styles.filterProgramadasTextActive]}>
            Programadas
          </Text>
        </TouchableOpacity>
        {multiSelectMode && (
          <TouchableOpacity style={styles.cancelSelectBtn} onPress={salirMultiSelect}>
            <MaterialIcons name="close" size={ICON_SIZE} color={colors.textMuted} />
            <Text style={styles.cancelSelectBtnText}>Cancelar selección</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.deleteBtn, (!haySeleccion || guardando) && styles.deleteBtnDisabled]}
          onPress={abrirModalBorrar}
          disabled={!haySeleccion || guardando}
          accessibilityLabel="Borrar incidencia"
        >
          <MaterialIcons name={ICONS.delete} size={ICON_SIZE} color={!haySeleccion || guardando ? colors.textMuted : colors.danger} />
        </TouchableOpacity>
      </View>

      {viewMode === 'deck' && (
        <View style={styles.calendarAboveCount}>
          <View style={styles.calendarCard}>
            <>
              <View style={styles.calendarHeader}>
                <TouchableOpacity onPress={() => { const ws = getWeekStart(calendarDate); ws.setDate(ws.getDate() - 7); setCalendarDate(ws); }}>
                  <MaterialIcons name="chevron-left" size={24} color={colors.textPrimary} />
                </TouchableOpacity>
                <Text style={styles.calendarTitle}>
                  {(() => {
                    const ws = getWeekStart(calendarDate);
                    const we = new Date(ws); we.setDate(we.getDate() + 6);
                    return `${ws.getDate()} ${MESES[ws.getMonth()]} - ${we.getDate()} ${MESES[we.getMonth()]} ${we.getFullYear()}`;
                  })()}
                </Text>
                <TouchableOpacity onPress={() => { const ws = getWeekStart(calendarDate); ws.setDate(ws.getDate() + 7); setCalendarDate(ws); }}>
                  <MaterialIcons name="chevron-right" size={24} color={colors.textPrimary} />
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
                  const programadasListBtn = (
                    <TouchableOpacity
                      style={styles.calendarDayListBtn}
                      onPress={() => setProgramadasDiaModalIso(iso)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityLabel="Ver listado de reparaciones programadas este día"
                    >
                      <MaterialIcons name="format-list-bulleted" size={14} color="#86198f" />
                    </TouchableOpacity>
                  );
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
                          {Platform.OS === 'web'
                            ? createElement(
                                'div',
                                {
                                  onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
                                  onClick: (e: React.MouseEvent) => e.stopPropagation(),
                                  style: { marginTop: SPACING.xs, alignSelf: 'center' },
                                },
                                programadasListBtn
                              )
                            : programadasListBtn}
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
                      style={{ flex: 1, minWidth: 0, display: 'flex', alignSelf: 'stretch', border: `0.5px solid ${colors.navActive}`, boxSizing: 'border-box', borderRadius: RADIO_MEDIO, overflow: 'hidden' }}
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
              <MaterialIcons name="chevron-left" size={20} color={pageIndexClamped <= 0 ? colors.textMuted : colors.accent} />
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
              <MaterialIcons name="chevron-right" size={20} color={pageIndexClamped >= totalPages - 1 ? colors.textMuted : colors.accent} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {viewMode === 'deck' ? (
        columnasPorLocal.length === 0 ? (
          <View style={styles.deckEmpty}>
            <Text style={styles.deckEmptyText}>No hay incidencias</Text>
          </View>
        ) : (
          <ScrollView
            style={styles.boardScrollWrap}
            contentContainerStyle={styles.boardScrollContent}
            showsVerticalScrollIndicator
          >
            <MantenimientoLocalColumnBoard
              columns={columnasPorLocal}
              mode={isAccordionMode ? 'accordion' : 'board'}
              boardCols={boardCols}
              expandedKeys={expandedLocals}
              onToggleExpand={toggleLocalExpand}
              renderCard={renderIncidenciaCard}
              getItemKey={(inc) => incidenciaKey(inc)}
              summary={{
                locales: columnasPorLocal.length,
                total: incidenciasFiltrados.length,
                itemSingular: 'incidencia',
                itemPlural: 'incidencias',
              }}
            />
          </ScrollView>
        )
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
                  color={selectedIndices.size === incidenciasPagina.length && incidenciasPagina.length > 0 ? colors.accent : colors.textMuted}
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
                    color={selectedIndices.has(idx) ? colors.accent : colors.textMuted}
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

      <Modal
        visible={programadasDiaModalIso !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setProgramadasDiaModalIso(null)}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setProgramadasDiaModalIso(null)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalProgramadasWrap}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle} numberOfLines={2}>
                  Reparaciones programadas — {programadasDiaModalIso ? formatearSoloFecha(programadasDiaModalIso) : ''}
                </Text>
                <TouchableOpacity onPress={() => setProgramadasDiaModalIso(null)} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              <ScrollView
                style={styles.modalProgramadasScroll}
                contentContainerStyle={styles.modalProgramadasScrollContent}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
              >
                {programadasDiaAgrupadasPorLocal.map((grupo, gi) => (
                  <View
                    key={grupo.localId}
                    style={[styles.modalProgramadasGroup, gi === 0 && styles.modalProgramadasGroupFirst]}
                  >
                    <View style={styles.modalProgramadasGroupHeader}>
                      <Text style={styles.modalProgramadasGroupTitle}>{grupo.nombreLocal}</Text>
                      <View style={styles.modalProgramadasGroupBadge}>
                        <Text style={styles.modalProgramadasGroupBadgeText}>
                          {grupo.incidencias.length} {grupo.incidencias.length === 1 ? 'reparación' : 'reparaciones'}
                        </Text>
                      </View>
                    </View>
                    {grupo.incidencias.map((inc, i) => {
                      const prioridadRaw = (inc.prioridad_reportada ?? '—').toString().trim();
                      const prioridadKey = prioridadRaw.toLowerCase();
                      const prioridadLabel =
                        prioridadKey && prioridadKey !== '—'
                          ? prioridadKey.charAt(0).toUpperCase() + prioridadKey.slice(1)
                          : '—';
                      const prioridadColor = getPrioridadColor(prioridadRaw);
                      const fotosRaw = Array.isArray(inc.fotos)
                        ? inc.fotos.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
                        : [];
                      const urisMini = fotosRaw.slice(0, 3).map((raw) => resolverUriFoto(raw));
                      const estadoTxt = (inc.estado ?? '—').toString().trim() || '—';
                      const zonaTxt = (inc.zona ?? '').toString().trim() || '—';
                      return (
                        <View
                          key={`${String(inc.local_id)}-${String(inc.id_incidencia)}-${String(inc.fecha_creacion)}-${i}`}
                          style={styles.modalProgramadasRow}
                        >
                          <View style={styles.modalProgramadasRowFotosCol}>
                            {[0, 1, 2].map((idx) => {
                              const uri = urisMini[idx];
                              if (uri) {
                                const thumb = (
                                  <TouchableOpacity
                                    onPress={() => setExpandedPhotoUri(uri)}
                                    style={styles.modalProgramadasFotoThumbWrap}
                                    activeOpacity={0.8}
                                    accessibilityLabel="Ampliar foto"
                                  >
                                    <Image
                                      source={{ uri }}
                                      style={styles.modalProgramadasFotoThumb as ImageStyle}
                                      resizeMode="cover"
                                    />
                                  </TouchableOpacity>
                                );
                                return Platform.OS === 'web' ? (
                                  createElement(
                                    'div',
                                    {
                                      key: `f-${idx}`,
                                      onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
                                      onClick: (e: React.MouseEvent) => e.stopPropagation(),
                                      style: { display: 'flex' },
                                    },
                                    thumb
                                  )
                                ) : (
                                  <React.Fragment key={`f-${idx}`}>{thumb}</React.Fragment>
                                );
                              }
                              return <View key={`e-${idx}`} style={[styles.modalProgramadasFotoThumb, styles.modalProgramadasFotoEmpty]} />;
                            })}
                          </View>
                          <View style={styles.modalProgramadasRowTextCol}>
                            <Text style={styles.modalProgramadasTitulo} numberOfLines={2}>
                              {(inc.titulo ?? '—').toString()}
                            </Text>
                            <View style={styles.modalProgramadasRowChips}>
                              <Text style={styles.modalProgramadasZonaInline} numberOfLines={1}>
                                {zonaTxt}
                              </Text>
                              <View style={styles.modalProgramadasEstadoPill}>
                                <Text style={styles.modalProgramadasEstadoPillText} numberOfLines={1}>
                                  {estadoTxt}
                                </Text>
                              </View>
                              <View style={[styles.modalProgramadasPrioridadPill, { backgroundColor: prioridadColor }]}>
                                <Text style={styles.modalProgramadasPrioridadPillText} numberOfLines={1}>
                                  {prioridadLabel}
                                </Text>
                              </View>
                            </View>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ))}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalBorrarVisible} transparent animationType="fade" onRequestClose={cerrarModalBorrar}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={cerrarModalBorrar}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalContentWrap}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{incidenciasToDelete.length === 1 ? 'Borrar Incidencia' : 'Borrar Incidencias'}</Text>
                <TouchableOpacity onPress={cerrarModalBorrar} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color={colors.textMuted} />
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

      <MantenimientoIncidenciaDetalleModal
        visible={detalleIncidencia !== null}
        detalle={detalleIncidencia}
        onClose={() => setDetalleIncidencia(null)}
        resolverUriFoto={resolverUriFoto}
        onFotoPress={setExpandedPhotoUri}
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
              <MaterialIcons name="close" size={28} color={colors.surface} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, textAlign: 'center' },
  retryBtn: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg, backgroundColor: colors.accent, borderRadius: RADIO_MEDIO },
  retryBtnText: { fontSize: fontSizes[12], color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.xs, gap: SPACING.sm },
  backBtn: { padding: SPACING.xs },
  title: { fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.sm, gap: SPACING.md },
  reportarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  reportarBtnText: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 140, maxWidth: 280, height: 32, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO, paddingHorizontal: SPACING.sm },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textPrimary, paddingVertical: 0 },
  refreshBtn: { padding: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.bg },
  viewModeWrap: { flexDirection: 'row', alignItems: 'center', gap: 0, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: 'hidden' },
  viewModeBtn: { padding: 6, backgroundColor: colors.bg },
  viewModeBtnActive: { backgroundColor: colors.accentMuted },
  deleteBtn: { padding: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: statusColors.danger.bg },
  deleteBtnDisabled: { opacity: 0.6 },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
    gap: SPACING.md,
    flexWrap: 'wrap',
  },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  pagination: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  pageBtn: { padding: SPACING.xs },
  pageBtnDisabled: { opacity: 0.5 },
  pageText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginHorizontal: SPACING.xs },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20 },
  calendarAboveCount: { width: '100%', paddingBottom: 6 },
  calendarCard: {
    width: '100%',
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: SPACING.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  calendarHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.xs },
  calendarTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, flex: 1, textAlign: 'center' },
  calendarDayDragOver: { backgroundColor: '#fbcfe8', borderColor: '#db2777', borderWidth: 2 },
  // 5 px; radius.sm es 6.
  calendarDayBadge: { backgroundColor: colors.border, borderRadius: 5, paddingVertical: 2, paddingHorizontal: SPACING.xs, alignSelf: 'center', marginBottom: 2 },
  calendarDayBadgeToday: { backgroundColor: colors.accent },
  calendarDayBadgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, lineHeight: 14, fontVariant: ['tabular-nums'] },
  calendarDayBadgeTextToday: { color: colors.surface },
  calendarDayPast: { opacity: 0.5 },
  calendarDayTotalLabel: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: '#c026d3', marginTop: 0, marginBottom: 0, lineHeight: 12, textAlign: 'center' },
  calendarDayPorLocal: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginTop: 0, marginBottom: 0, lineHeight: 10, textAlign: 'center' },
  calendarDayListBtn: {
    marginTop: SPACING.xs,
    padding: SPACING.xs,
    borderRadius: radius.sm,
    backgroundColor: '#fae8ff',
    borderWidth: 1,
    borderColor: '#e9d5ff',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  calendarWeekRow: { flexDirection: 'row', gap: 6 },
  calendarWeekDayCol: { flex: 1, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 6, backgroundColor: colors.bg, borderRadius: RADIO_MEDIO, borderWidth: 0.5, borderColor: colors.navActive, overflow: 'hidden' },
  calendarWeekDayLabel: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, marginBottom: 6 },
  deckEmpty: { padding: SPACING.xl, alignItems: 'center' },
  deckEmptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted },
  boardScrollWrap: { flex: 1 },
  boardScrollContent: { flexGrow: 1, paddingBottom: SPACING.xl, paddingHorizontal: SPACING.xs },
  cardExtras: {
    marginTop: 6,
    gap: 6,
  },
  cardExtrasRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  cardExtrasSpacer: {
    flex: 1,
    minWidth: 0,
  },
  cardProgramado: {
    paddingVertical: 3,
    paddingHorizontal: SPACING.sm,
    backgroundColor: statusColors.success.bg,
    borderRadius: radius.sm,
    flexShrink: 1,
    minWidth: 0,
  },
  cardProgramadoText: { fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: '#166534' },
  cardDeshacerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 5,
    paddingHorizontal: 7,
    backgroundColor: statusColors.danger.bg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  cardDeshacerText: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.danger },
  cardEstado: {
    paddingVertical: 2,
    paddingHorizontal: 6,
    backgroundColor: colors.navActive,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    flexShrink: 0,
  },
  cardEstadoText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  // Más oscuro que colors.overlay (visor de foto).
  photoOverlay: { flex: 1, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' },
  photoOverlayWeb: Platform.OS === 'web' ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 } : {},
  photoExpandedWrap: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', position: 'absolute' as const, left: 0, right: 0, top: 0, bottom: 0 },
  photoExpandedTouch: { justifyContent: 'center', alignItems: 'center' },
  photoExpanded: { maxWidth: '100%', maxHeight: '100%' },
  // 24 px, por encima de radius.xl (16). Velado más oscuro que colors.overlay.
  photoCloseBtn: { position: 'absolute', top: 16, right: 16, padding: SPACING.sm, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 24 },
  table: { minWidth: '100%', borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO, overflow: 'hidden', backgroundColor: colors.surface },
  rowHeader: { flexDirection: 'row', backgroundColor: colors.border, borderBottomWidth: 1, borderBottomColor: colors.borderStrong },
  cellHeader: { minWidth: MIN_COL_WIDTH, paddingVertical: 6, paddingHorizontal: SPACING.sm, borderRightWidth: 1, borderRightColor: colors.borderStrong, position: 'relative' },
  cellHeaderText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize' as 'pointer',
  },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  rowSelected: { backgroundColor: colors.accentMuted },
  cell: { minWidth: MIN_COL_WIDTH, paddingVertical: SPACING.xs, paddingHorizontal: SPACING.sm, borderRightWidth: 1, borderRightColor: colors.border },
  cellCheckbox: { width: 40, minWidth: 40, alignItems: 'center', justifyContent: 'center' },
  cellText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textPrimary },
  filterProgramadasBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  filterProgramadasBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterProgramadasText: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  filterProgramadasTextActive: { color: colors.surface },
  cancelSelectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  cancelSelectBtnText: { fontSize: fontSizes[12], color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  // Más oscuro que colors.overlay.
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalContentWrap: { width: '100%', maxWidth: 360, padding: SPACING.xl, alignItems: 'center' },
  modalProgramadasWrap: { width: '100%', maxWidth: 560, padding: SPACING.xl, alignItems: 'center', maxHeight: '92%' as const },
  modalProgramadasScroll: { maxHeight: 420 },
  modalProgramadasScrollContent: { paddingHorizontal: SPACING.lg, paddingBottom: SPACING.lg },
  modalProgramadasGroup: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  modalProgramadasGroupFirst: { marginTop: 0, paddingTop: 0, borderTopWidth: 0 },
  modalProgramadasGroupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm, paddingHorizontal: 2, gap: SPACING.sm },
  modalProgramadasGroupTitle: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text, flex: 1, minWidth: 0 },
  modalProgramadasGroupBadge: { backgroundColor: colors.accentMuted, paddingHorizontal: SPACING.sm, paddingVertical: 3, borderRadius: RADIO_MEDIO, flexShrink: 0 },
  modalProgramadasGroupBadgeText: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  modalProgramadasRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
  },
  modalProgramadasRowFotosCol: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    flexShrink: 0,
    width: 128,
    justifyContent: 'flex-start',
  },
  modalProgramadasRowTextCol: { flex: 1, minWidth: 0, justifyContent: 'center', gap: 6 },
  modalProgramadasTitulo: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, lineHeight: 18 },
  modalProgramadasRowChips: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  modalProgramadasZonaInline: {
    fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize,
    color: colors.textMuted,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 48,
    marginRight: 2,
  },
  modalProgramadasEstadoPill: {
    paddingVertical: 3,
    paddingHorizontal: SPACING.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.navActive,
    borderWidth: 1,
    borderColor: colors.border,
    flexShrink: 0,
    maxWidth: '100%',
  },
  modalProgramadasEstadoPillText: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  modalProgramadasPrioridadPill: {
    paddingVertical: 3,
    paddingHorizontal: SPACING.sm,
    borderRadius: radius.sm,
    flexShrink: 0,
    maxWidth: '100%',
  },
  modalProgramadasPrioridadPillText: { fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface },
  modalProgramadasFotoThumbWrap: { borderRadius: radius.sm, overflow: 'hidden' },
  modalProgramadasFotoThumb: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: colors.border },
  modalProgramadasFotoEmpty: {
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    backgroundColor: colors.bg,
  },
  modalCard: { width: '100%', backgroundColor: colors.surface, borderRadius: radius.xl, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: SPACING.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalTitle: { fontSize: fontSizes[18], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  modalClose: { padding: SPACING.xs },
  modalBody: { padding: 20 },
  modalMessage: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary, marginBottom: 20, lineHeight: 20 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACING.md },
  modalBtnNo: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: colors.navActive, borderRadius: radius.md },
  modalBtnNoText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  modalBtnSi: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: colors.danger, borderRadius: radius.md },
  modalBtnSiText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
});
