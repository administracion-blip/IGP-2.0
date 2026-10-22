import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
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
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useMantenimientoLocales, valorEnLocal } from './LocalesContext';
import { useAuth } from '../../contexts/AuthContext';
import { ICONS, ICON_SIZE } from '../../constants/icons';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';
import {
  ERP_LIST_HEADER_TEXT_PROPS,
  ERP_LIST_MIN_COL_WIDTH,
  erpListTableStyles,
} from '../../constants/erpListTableStyles';
import { apiFetch } from '../../utils/api';
import { InputFecha } from '../../components/InputFecha';
import { MantenimientoFiltrosBar } from '../../components/mantenimiento/MantenimientoFiltrosBar';
import { PrioridadIncidenciaBadge } from '../../components/mantenimiento/PrioridadIncidenciaBadge';
import { MantenimientoFotosGaleriaModal } from '../../components/mantenimiento/MantenimientoFotosGaleriaModal';
import {
  facturaMantenimientoDeParte,
  labelPeriodoCorto,
  parteFacturado,
} from '../../lib/mantenimientoFacturacion';
import {
  type ChipPeriodoMantenimiento,
  extraerFechaIsoIncidencia,
  filtrarIncidenciasMantenimiento,
  filtrosPorDefecto,
  isDateInPast,
  calcularContadoresMantenimiento,
} from '../../lib/mantenimientoFiltros';

const DEFAULT_COL_WIDTH = 90;
const PAGE_SIZE = 50;
const TABLE_FONT_SIZE = 11;
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type Incidencia = Record<string, string | number | string[] | undefined>;

function resolverUriFoto(uri: string): string {
  const u = uri.trim();
  if (u.startsWith('http') || u.startsWith('data:')) return u;
  return `${API_URL}${u.startsWith('/') ? '' : '/'}${u}`;
}

function fotosIncidencia(inc: Incidencia): string[] {
  if (!Array.isArray(inc.fotos)) return [];
  return inc.fotos.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}

function nombreUsuarioVisible(
  idUsuario: string | undefined,
  mapaUsuarios: Record<string, string>,
  usuarioLogin: { id_usuario?: string; Nombre?: string; email?: string } | null,
): string {
  const id = (idUsuario ?? '').toString().trim();
  if (!id) return '—';
  if (usuarioLogin?.id_usuario === id) {
    const nomLogin = (usuarioLogin.Nombre ?? '').trim();
    if (nomLogin) return nomLogin;
    if (usuarioLogin.email) return usuarioLogin.email;
  }
  return mapaUsuarios[id] ?? id;
}

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

const COL_LABELS: Record<(typeof COLUMNAS_INCIDENCIAS)[number], string> = {
  fecha_creacion: 'Fecha creación',
  espera: 'Espera',
  fecha_programada: 'Fecha programada',
  fecha_completada: 'Fecha completada',
  estado_valoracion: 'Estado valoración',
  local_id: 'ID local',
  nombre_local: 'Local',
  zona: 'Zona',
  categoria: 'Categoría',
  titulo: 'Título',
  descripcion: 'Descripción',
  prioridad_reportada: 'Prioridad',
  estado: 'Estado',
  creado_por_id_usuario: 'Creado por',
  fotos: 'Fotos',
  id_incidencia: 'ID incidencia',
};

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

/** Colores pastel por estado: fondo claro + texto más oscuro del mismo tono */
function estilosEstado(estado: string | undefined): { backgroundColor: string; color: string } {
  const e = (estado ?? '').toString().trim();
  switch (e) {
    case 'Nuevo':
    case 'NUEVA':
      return { backgroundColor: '#dbeafe', color: '#1e40af' };
    case 'Programado':
      return { backgroundColor: statusColors.warning.bg, color: statusColors.warning.text };
    case 'Reparacion':
      return { backgroundColor: '#d1fae5', color: '#047857' };
    case 'CANCELADA':
      return { backgroundColor: statusColors.danger.bg, color: statusColors.danger.text };
    default:
      return { backgroundColor: colors.navActive, color: colors.textPrimary };
  }
}

export default function MantenimientoScreen() {
  const router = useRouter();
  const { user, hasPermiso } = useAuth();
  const { locales } = useMantenimientoLocales();
  const [countAbiertas, setCountAbiertas] = useState<number | null>(null);
  const [incidencias, setIncidencias] = useState<Incidencia[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    titulo: 140,
    descripcion: 160,
    fecha_creacion: 130,
    nombre_local: 120,
    espera: 80,
  });
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [incidenciasToDelete, setIncidenciasToDelete] = useState<{ local_id: string; id_incidencia: string; fecha_creacion: string }[]>(
    [],
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [modalBorrarVisible, setModalBorrarVisible] = useState(false);
  const [modalEditarVisible, setModalEditarVisible] = useState(false);
  const [editTitulo, setEditTitulo] = useState('');
  const [editDescripcion, setEditDescripcion] = useState('');
  const [editZona, setEditZona] = useState('');
  const [editPrioridad, setEditPrioridad] = useState('');
  const [editFechaProgramada, setEditFechaProgramada] = useState('');
  const [editFechaProgramadaInicial, setEditFechaProgramadaInicial] = useState('');
  const [mapaUsuarios, setMapaUsuarios] = useState<Record<string, string>>({});
  const [modalFotos, setModalFotos] = useState<{ fotos: string[]; titulo: string } | null>(null);
  const [fechaDesdeFiltro, setFechaDesdeFiltro] = useState(() => filtrosPorDefecto().fechaDesde);
  const [fechaHastaFiltro, setFechaHastaFiltro] = useState(() => filtrosPorDefecto().fechaHasta);
  const [chipPeriodoFiltro, setChipPeriodoFiltro] = useState<ChipPeriodoMantenimiento>(() => filtrosPorDefecto().chipPeriodo);
  const [localIdsFiltro, setLocalIdsFiltro] = useState<string[]>([]);
  const [estadosFiltro, setEstadosFiltro] = useState<string[]>([]);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  const ZONAS_EDIT = ['barra', 'cocina', 'baños', 'almacén', 'sala', 'terraza', 'otros'] as const;
  const PRIORIDADES_EDIT = ['baja', 'media', 'alta', 'urgente'] as const;

  const mapLocalIdToNombre = useMemo(() => {
    const m: Record<string, string> = {};
    locales.forEach((loc) => {
      const id = valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'id_locales') ?? '';
      const nombre = valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id;
      if (id) m[id] = nombre;
    });
    return m;
  }, [locales]);

  const opcionesLocalesFiltro = useMemo(
    () =>
      locales
        .map((loc) => {
          const id = (valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'id_locales') ?? '').toString();
          const nombre = (valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id).toString();
          return id ? { id, nombre } : null;
        })
        .filter((x): x is { id: string; nombre: string } => x !== null),
    [locales],
  );

  const incidenciasFiltradas = useMemo(
    () =>
      filtrarIncidenciasMantenimiento(incidencias, {
        fechaDesde: fechaDesdeFiltro,
        fechaHasta: fechaHastaFiltro,
        chipPeriodo: chipPeriodoFiltro,
        localIds: localIdsFiltro,
        estados: estadosFiltro,
      }),
    [incidencias, fechaDesdeFiltro, fechaHastaFiltro, chipPeriodoFiltro, localIdsFiltro, estadosFiltro],
  );

  const contadoresFiltros = useMemo(
    () =>
      calcularContadoresMantenimiento(incidencias, {
        fechaDesde: fechaDesdeFiltro,
        fechaHasta: fechaHastaFiltro,
        chipPeriodo: chipPeriodoFiltro,
        localIds: localIdsFiltro,
        estados: estadosFiltro,
      }),
    [
      incidencias,
      fechaDesdeFiltro,
      fechaHastaFiltro,
      chipPeriodoFiltro,
      localIdsFiltro,
      estadosFiltro,
    ],
  );

  useEffect(() => {
    setPageIndex(0);
    setSelectedRowIndex(null);
    setMultiSelectMode(false);
    setSelectedIndices(new Set());
  }, [fechaDesdeFiltro, fechaHastaFiltro, chipPeriodoFiltro, localIdsFiltro, estadosFiltro]);

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    apiFetch('/api/mantenimiento/incidencias')
      .then((res) => res.json())
      .then((data: { incidencias?: Incidencia[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        const all = data.incidencias || [];
        const list = all.filter((i) => {
          const lid = (i.local_id ?? '').toString().trim();
          return !lid || lid in mapLocalIdToNombre;
        });
        setIncidencias(list);
        const abiertas = list.filter(
          (i: Incidencia) => (i.estado ?? '').toString().trim() === 'Nuevo',
        );
        setCountAbiertas(abiertas.length);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [mapLocalIdToNombre]);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  useEffect(() => {
    apiFetch('/api/usuarios')
      .then((res) => res.json())
      .then((data: { usuarios?: Record<string, string | number | undefined>[] }) => {
        const map: Record<string, string> = {};
        for (const u of data.usuarios ?? []) {
          const id = String(u.id_usuario ?? u.id_Usuario ?? '').trim();
          const nombre = String(u.Nombre ?? u.nombre ?? '').trim();
          const email = String(u.email ?? u.Email ?? '').trim();
          if (id) map[id] = nombre || email || id;
        }
        setMapaUsuarios(map);
      })
      .catch(() => setMapaUsuarios({}));
  }, []);

  const badgeColor = countAbiertas === 0 ? '#22c55e' : colors.danger;

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
      if (col === 'creado_por_id_usuario') {
        return nombreUsuarioVisible(inc.creado_por_id_usuario as string, mapaUsuarios, user);
      }
      if (col === 'fotos') {
        const n = fotosIncidencia(inc).length;
        if (n === 0) return '—';
        return `${n} foto${n !== 1 ? 's' : ''}`;
      }
      const key = Object.keys(inc).find((k) => k.toLowerCase() === col.toLowerCase());
      const raw = key != null ? inc[key] : inc[col];
      if (raw !== undefined && raw !== null && String(raw).trim() !== '') return String(raw);
      return '—';
    },
    [mapLocalIdToNombre, mapaUsuarios, user]
  );

  const cellTextStyle = useMemo(
    () => [erpListTableStyles.cellText, { fontFamily: fontFamily.regular, fontSize: TABLE_FONT_SIZE, lineHeight: TABLE_FONT_SIZE + 3 }],
    [],
  );

  const columnas = useMemo(() => [...COLUMNAS_INCIDENCIAS], []);
  const totalRegistros = incidenciasFiltradas.length;
  const totalPages = Math.max(1, Math.ceil(totalRegistros / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const incidenciasPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return incidenciasFiltradas.slice(start, start + PAGE_SIZE);
  }, [incidenciasFiltradas, pageIndexClamped]);

  const goPrevPage = useCallback(() => {
    setPageIndex((p) => Math.max(0, p - 1));
    setSelectedRowIndex(null);
    setMultiSelectMode(false);
    setSelectedIndices(new Set());
  }, []);
  const goNextPage = useCallback(() => {
    setPageIndex((p) => Math.min(totalPages - 1, p + 1));
    setSelectedRowIndex(null);
    setMultiSelectMode(false);
    setSelectedIndices(new Set());
  }, [totalPages]);

  const seleccionarFila = useCallback((idx: number) => {
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
  }, [multiSelectMode]);

  const activarMultiSelect = useCallback((idx: number) => {
    setMultiSelectMode(true);
    setSelectedIndices(new Set([idx]));
    setSelectedRowIndex(null);
  }, []);

  const salirMultiSelect = useCallback(() => {
    setMultiSelectMode(false);
    setSelectedIndices(new Set());
    setSelectedRowIndex(null);
  }, []);

  const toggleSeleccionTodas = useCallback(() => {
    if (selectedIndices.size === incidenciasPagina.length) {
      setSelectedIndices(new Set());
    } else {
      setSelectedIndices(new Set(incidenciasPagina.map((_, i) => i)));
    }
  }, [incidenciasPagina, selectedIndices.size]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !resizingCol) return;
    const handleMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const delta = e.clientX - r.startX;
      const next = Math.max(ERP_LIST_MIN_COL_WIDTH, r.startWidth + delta);
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

  const incSeleccionada =
    !multiSelectMode && selectedRowIndex !== null ? incidenciasPagina[selectedRowIndex] : null;
  const incidenciasSeleccionadasCount = multiSelectMode ? selectedIndices.size : selectedRowIndex !== null ? 1 : 0;
  const haySeleccion = incidenciasSeleccionadasCount > 0;

  const facturaIncSeleccionada = useMemo(
    () => (incSeleccionada ? facturaMantenimientoDeParte(incSeleccionada) : null),
    [incSeleccionada],
  );

  /**
   * Partes facturados dentro de la selección. El backend rechaza borrarlos y
   * cambiarles la fecha, así que la acción no se ofrece en lugar de dejar que
   * el usuario reciba un error del servidor.
   */
  const seleccionFacturadaCount = useMemo(() => {
    const seleccionadas = multiSelectMode
      ? [...selectedIndices].map((idx) => incidenciasPagina[idx])
      : incSeleccionada
        ? [incSeleccionada]
        : [];
    return seleccionadas.filter((inc) => inc != null && parteFacturado(inc)).length;
  }, [multiSelectMode, selectedIndices, incidenciasPagina, incSeleccionada]);

  const cerrarModalBorrar = useCallback(() => {
    setModalBorrarVisible(false);
    setIncidenciasToDelete([]);
  }, []);

  const abrirModalBorrar = useCallback(() => {
    const items: { local_id: string; id_incidencia: string; fecha_creacion: string }[] = [];
    if (multiSelectMode) {
      selectedIndices.forEach((idx) => {
        const inc = incidenciasPagina[idx];
        const localId = (inc?.local_id ?? '').toString().trim();
        const idIncidencia = (inc?.id_incidencia ?? '').toString().trim();
        const fechaCreacion = (inc?.fecha_creacion ?? '').toString().trim();
        if (localId && idIncidencia && fechaCreacion) items.push({ local_id: localId, id_incidencia: idIncidencia, fecha_creacion: fechaCreacion });
      });
    } else if (selectedRowIndex !== null) {
      const inc = incidenciasPagina[selectedRowIndex];
      const localId = (inc?.local_id ?? '').toString().trim();
      const idIncidencia = (inc?.id_incidencia ?? '').toString().trim();
      const fechaCreacion = (inc?.fecha_creacion ?? '').toString().trim();
      if (localId && idIncidencia && fechaCreacion) items.push({ local_id: localId, id_incidencia: idIncidencia, fecha_creacion: fechaCreacion });
    }
    if (items.length === 0) return;
    setIncidenciasToDelete(items);
    setModalBorrarVisible(true);
  }, [multiSelectMode, selectedIndices, selectedRowIndex, incidenciasPagina]);

  const ejecutarBorrado = useCallback(async () => {
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
      refetch();
      setSelectedRowIndex(null);
      salirMultiSelect();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  }, [incidenciasToDelete, cerrarModalBorrar, refetch, salirMultiSelect]);

  const abrirModalEditar = useCallback(() => {
    if (!incSeleccionada) return;
    setEditTitulo((incSeleccionada.titulo ?? '').toString());
    setEditDescripcion((incSeleccionada.descripcion ?? '').toString());
    setEditZona((incSeleccionada.zona ?? '').toString().toLowerCase());
    setEditPrioridad((incSeleccionada.prioridad_reportada ?? '').toString().toLowerCase());
    const fp = extraerFechaIsoIncidencia(incSeleccionada, 'fecha_programada') ?? '';
    setEditFechaProgramada(fp);
    setEditFechaProgramadaInicial(fp);
    setModalEditarVisible(true);
  }, [incSeleccionada]);

  const ejecutarEdicion = useCallback(async () => {
    if (!incSeleccionada) return;
    const localId = (incSeleccionada.local_id ?? '').toString().trim();
    const idIncidencia = (incSeleccionada.id_incidencia ?? '').toString().trim();
    const fechaCreacion = (incSeleccionada.fecha_creacion ?? '').toString().trim();
    if (!localId || !idIncidencia || !fechaCreacion) return;
    if (!editTitulo.trim()) { setError('El título es obligatorio'); return; }
    const fpTrim = editFechaProgramada.trim();
    if (fpTrim && isDateInPast(fpTrim)) {
      setError('La fecha programada no puede ser anterior a hoy');
      return;
    }
    setModalEditarVisible(false);
    setGuardando(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        local_id: localId,
        id_incidencia: idIncidencia,
        fecha_creacion: fechaCreacion,
        editar_campos: true,
        titulo: editTitulo.trim(),
        descripcion: editDescripcion.trim(),
        zona: editZona,
        prioridad_reportada: editPrioridad,
      };
      if (!facturaIncSeleccionada && fpTrim !== editFechaProgramadaInicial) {
        payload.fecha_programada = fpTrim || null;
      }
      const res = await apiFetch('/api/mantenimiento/incidencias', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al editar'); return; }
      setSelectedRowIndex(null);
      salirMultiSelect();
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  }, [
    incSeleccionada,
    editTitulo,
    editDescripcion,
    editZona,
    editPrioridad,
    editFechaProgramada,
    editFechaProgramadaInicial,
    facturaIncSeleccionada,
    refetch,
    salirMultiSelect,
  ]);

  const toolbarBtns = [
    { id: 'crear', label: 'Reportar incidencia', icon: ICONS.add, onPress: () => router.push('/mantenimiento/reportar') },
    {
      id: 'editar',
      label: 'Editar',
      icon: ICONS.edit,
      disabled: multiSelectMode || !incSeleccionada || guardando,
      onPress: abrirModalEditar,
    },
    {
      id: 'borrar',
      label: 'Borrar',
      icon: ICONS.delete,
      disabled: !haySeleccion || guardando || seleccionFacturadaCount > 0,
      onPress: abrirModalBorrar,
    },
  ];

  const tituloBorrarModal = useMemo(() => {
    if (incidenciasToDelete.length !== 1) return '';
    const t = incidenciasToDelete[0];
    const inc = incidenciasPagina.find(
      (i) =>
        (i.local_id ?? '').toString().trim() === t.local_id &&
        (i.id_incidencia ?? '').toString().trim() === t.id_incidencia &&
        (i.fecha_creacion ?? '').toString().trim() === t.fecha_creacion
    );
    return (inc?.titulo ?? '').toString();
  }, [incidenciasToDelete, incidenciasPagina]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/mantenimiento' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Mantenimiento</Text>
          <Text style={styles.subtitle}>Opciones de mantenimiento del sistema.</Text>
        </View>
      </View>

      <View style={styles.buttonsRow}>
        <TouchableOpacity style={styles.btn} onPress={() => router.push('/mantenimiento/reportar')} activeOpacity={0.7}>
          <MaterialIcons name="add-circle-outline" size={22} color={colors.accent} />
          <Text style={styles.btnText}>Reportar incidencia</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnWithBadge]} onPress={() => router.push('/mantenimiento/abiertas')} activeOpacity={0.7}>
          <MaterialIcons name="list-alt" size={22} color={colors.accent} />
          <Text style={styles.btnText}>Incidencias abiertas</Text>
          {countAbiertas !== null && (
            <View style={[styles.badge, { backgroundColor: badgeColor }]} pointerEvents="none">
              <Text style={styles.badgeText}>{countAbiertas}</Text>
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={() => router.push('/mantenimiento/programadas-hoy')} activeOpacity={0.7}>
          <MaterialIcons name="today" size={22} color={colors.accent} />
          <Text style={styles.btnText}>Reparaciones de hoy</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={() => router.push('/mantenimiento/reparaciones-realizadas')} activeOpacity={0.7}>
          <MaterialIcons name="check-circle-outline" size={22} color={colors.accent} />
          <Text style={styles.btnText}>Reparaciones realizadas</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={() => router.push('/mantenimiento/recurrentes')} activeOpacity={0.7}>
          <MaterialIcons name="event-repeat" size={22} color={colors.accent} />
          <Text style={styles.btnText}>Reparaciones recurrentes</Text>
        </TouchableOpacity>
        {hasPermiso('mantenimiento.facturar') ? (
          <TouchableOpacity style={styles.btn} onPress={() => router.push('/mantenimiento/facturacion' as never)} activeOpacity={0.7}>
            <MaterialIcons name="receipt-long" size={22} color={colors.accent} />
            <Text style={styles.btnText}>Facturación mensual</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.toolbarRow}>
        <View style={styles.toolbar}>
          {toolbarBtns.map((btn) => (
            <TouchableOpacity
              key={btn.id}
              style={[styles.toolbarBtn, btn.disabled && styles.toolbarBtnDisabled]}
              onPress={() => {
                if (btn.disabled) return;
                if ('onPress' in btn && typeof btn.onPress === 'function') btn.onPress();
              }}
              disabled={btn.disabled}
              accessibilityLabel={btn.label}
            >
              <MaterialIcons name={btn.icon} size={ICON_SIZE} color={btn.disabled ? colors.textMuted : colors.accent} />
            </TouchableOpacity>
          ))}
          {multiSelectMode && (
            <TouchableOpacity style={styles.cancelSelectBtn} onPress={salirMultiSelect}>
              <MaterialIcons name="close" size={ICON_SIZE} color={colors.textMuted} />
              <Text style={styles.cancelSelectBtnText}>Cancelar selección</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.toolbarBtn} onPress={refetch} disabled={loading} accessibilityLabel="Actualizar">
            {loading ? <ActivityIndicator size="small" color={colors.accent} /> : <MaterialIcons name="refresh" size={ICON_SIZE} color={colors.accent} />}
          </TouchableOpacity>
        </View>
        {seleccionFacturadaCount > 0 ? (
          <View style={styles.facturadoAviso}>
            <MaterialIcons name="receipt-long" size={14} color="#0f766e" />
            <Text style={styles.facturadoAvisoText}>
              {seleccionFacturadaCount === 1
                ? 'La incidencia seleccionada ya está facturada: no se puede borrar ni cambiar su fecha programada.'
                : `${seleccionFacturadaCount} incidencias seleccionadas ya están facturadas: no se pueden borrar ni cambiar de fecha.`}
            </Text>
          </View>
        ) : null}
      </View>

      {error && (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      )}

      <MantenimientoFiltrosBar
        fechaDesde={fechaDesdeFiltro}
        fechaHasta={fechaHastaFiltro}
        onFechaDesdeChange={setFechaDesdeFiltro}
        onFechaHastaChange={setFechaHastaFiltro}
        chipPeriodo={chipPeriodoFiltro}
        onChipPeriodoChange={setChipPeriodoFiltro}
        localIds={localIdsFiltro}
        onLocalIdsChange={setLocalIdsFiltro}
        locales={opcionesLocalesFiltro}
        estados={estadosFiltro}
        onEstadosChange={setEstadosFiltro}
        totalFiltrado={incidenciasFiltradas.length}
        totalSinFiltrar={incidencias.length}
        contadores={contadoresFiltros}
      />

      <View style={styles.subtitleRow}>
        <Text style={styles.subtitleTable}>
          {totalRegistros === 0 ? '0 registros' : totalPages > 1 ? `${pageIndexClamped * PAGE_SIZE + 1}–${Math.min((pageIndexClamped + 1) * PAGE_SIZE, totalRegistros)} de ${totalRegistros} registro${totalRegistros !== 1 ? 's' : ''}` : `${totalRegistros} registro${totalRegistros !== 1 ? 's' : ''}`}
        </Text>
        {totalPages > 1 && (
          <View style={styles.pagination}>
            <TouchableOpacity style={[styles.pageBtn, pageIndexClamped <= 0 && styles.pageBtnDisabled]} onPress={goPrevPage} disabled={pageIndexClamped <= 0}>
              <MaterialIcons name="chevron-left" size={20} color={pageIndexClamped <= 0 ? colors.textMuted : colors.accent} />
            </TouchableOpacity>
            <Text style={styles.pageText}>Página {pageIndexClamped + 1} de {totalPages}</Text>
            <TouchableOpacity style={[styles.pageBtn, pageIndexClamped >= totalPages - 1 && styles.pageBtnDisabled]} onPress={goNextPage} disabled={pageIndexClamped >= totalPages - 1}>
              <MaterialIcons name="chevron-right" size={20} color={pageIndexClamped >= totalPages - 1 ? colors.textMuted : colors.accent} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {loading && incidencias.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.loadingText}>Cargando incidencias…</Text>
        </View>
      ) : (
        <View style={erpListTableStyles.tableOuter}>
          <View style={erpListTableStyles.tableWrapper}>
            <ScrollView
              horizontal
              style={[erpListTableStyles.scroll, erpListTableStyles.scrollTable, erpListTableStyles.tableScrollLtr]}
              contentContainerStyle={erpListTableStyles.scrollContent}
              showsHorizontalScrollIndicator
            >
              <View style={erpListTableStyles.table}>
                <View style={erpListTableStyles.rowHeader}>
                  {multiSelectMode ? (
                    <TouchableOpacity
                      style={[erpListTableStyles.cellHeader, erpListTableStyles.cellCheckbox]}
                      onPress={toggleSeleccionTodas}
                      activeOpacity={0.7}
                    >
                      <MaterialIcons
                        name={
                          selectedIndices.size === incidenciasPagina.length && incidenciasPagina.length > 0
                            ? 'check-box'
                            : 'check-box-outline-blank'
                        }
                        size={18}
                        color={
                          selectedIndices.size === incidenciasPagina.length && incidenciasPagina.length > 0
                            ? colors.accent
                            : colors.textMuted
                        }
                      />
                    </TouchableOpacity>
                  ) : null}
                  {columnas.map((col) => (
                    <View key={col} style={[erpListTableStyles.cellHeader, { width: getColWidth(col) }]}>
                      <Text style={[erpListTableStyles.cellHeaderText, styles.tableHeaderText]} {...ERP_LIST_HEADER_TEXT_PROPS}>
                        {COL_LABELS[col]}
                      </Text>
                      {Platform.OS === 'web' && (
                        <View
                          style={erpListTableStyles.resizeHandle}
                          onMouseDown={(e: { nativeEvent?: { clientX: number }; clientX?: number }) =>
                            handleResizeStart(col, e)
                          }
                        />
                      )}
                    </View>
                  ))}
                </View>

                <ScrollView
                  style={erpListTableStyles.tableBodyScroll}
                  contentContainerStyle={erpListTableStyles.tableBodyContent}
                  showsVerticalScrollIndicator
                  nestedScrollEnabled
                >
                  {incidenciasPagina.length === 0 ? (
                    <View style={erpListTableStyles.row}>
                      <View style={erpListTableStyles.cellEmpty}>
                        <Text style={erpListTableStyles.cellEmptyText}>
                          {incidencias.length === 0
                            ? 'No hay incidencias registradas.'
                            : 'Ninguna incidencia coincide con los filtros aplicados.'}
                        </Text>
                      </View>
                    </View>
                  ) : (
                    incidenciasPagina.map((inc, idx) => {
                      const isSelected = multiSelectMode ? selectedIndices.has(idx) : selectedRowIndex === idx;
                      return (
                        <TouchableOpacity
                          key={`${inc.id_incidencia ?? idx}-${inc.fecha_creacion}`}
                          style={[erpListTableStyles.row, isSelected && erpListTableStyles.rowSelected]}
                          onPress={() => seleccionarFila(idx)}
                          onLongPress={() => activarMultiSelect(idx)}
                          delayLongPress={400}
                          activeOpacity={0.8}
                        >
                          {multiSelectMode ? (
                            <View style={erpListTableStyles.cellCheckbox}>
                              <MaterialIcons
                                name={selectedIndices.has(idx) ? 'check-box' : 'check-box-outline-blank'}
                                size={18}
                                color={selectedIndices.has(idx) ? colors.accent : colors.textMuted}
                              />
                            </View>
                          ) : null}
                          {columnas.map((col) => {
                            const text = valorCelda(inc, col);
                            const esEstado = col === 'estado';
                            const estadoStyles = esEstado ? estilosEstado(inc.estado as string) : null;
                            const esNegrita = col === 'nombre_local' || col === 'titulo';
                            const cellTextBase = [
                              cellTextStyle,
                              esNegrita && styles.cellTextBold,
                              estadoStyles && { color: estadoStyles.color, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
                            ];

                            if (col === 'espera') {
                              const estado = (inc.estado ?? '').toString();
                              let dias: number;
                              if (estado === 'Reparacion' && inc.fecha_completada) {
                                const creacion = new Date(inc.fecha_creacion as string);
                                const completada = new Date(inc.fecha_completada as string);
                                dias = Math.floor(
                                  (completada.getTime() - creacion.getTime()) / (1000 * 60 * 60 * 24),
                                );
                              } else {
                                dias = calcularDiasEspera(inc.fecha_creacion as string);
                              }
                              const alerta = dias > 7 && (estado === 'Nuevo' || estado === 'Programado');
                              return (
                                <View
                                  key={col}
                                  style={[
                                    erpListTableStyles.cell,
                                    { width: getColWidth(col), flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
                                    alerta && { backgroundColor: statusColors.danger.bg },
                                  ]}
                                >
                                  {alerta ? <MaterialIcons name="warning" size={14} color={colors.danger} /> : null}
                                  <Text
                                    style={[
                                      cellTextStyle,
                                      { flex: 1 },
                                      alerta && { color: colors.danger, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
                                    ]}
                                  >
                                    {text}
                                  </Text>
                                </View>
                              );
                            }

                            if (col === 'prioridad_reportada') {
                              return (
                                <View key={col} style={[erpListTableStyles.cell, { width: getColWidth(col) }]}>
                                  <PrioridadIncidenciaBadge prioridad={inc.prioridad_reportada as string} compact />
                                </View>
                              );
                            }

                            if (col === 'fotos') {
                              const listaFotos = fotosIncidencia(inc);
                              return (
                                <View key={col} style={[erpListTableStyles.cell, { width: getColWidth(col), alignItems: 'center' }]}>
                                  {listaFotos.length > 0 ? (
                                    <TouchableOpacity
                                      style={styles.fotosIconBtn}
                                      onPress={(e) => {
                                        e.stopPropagation?.();
                                        setModalFotos({
                                          fotos: listaFotos,
                                          titulo: (inc.titulo ?? '').toString(),
                                        });
                                      }}
                                      accessibilityLabel={`Ver ${listaFotos.length} fotos`}
                                    >
                                      <MaterialIcons name="photo-library" size={18} color={colors.accent} />
                                      <Text style={styles.fotosIconCount}>{listaFotos.length}</Text>
                                    </TouchableOpacity>
                                  ) : (
                                    <Text style={cellTextStyle}>—</Text>
                                  )}
                                </View>
                              );
                            }

                            return (
                              <View
                                key={col}
                                style={[
                                  erpListTableStyles.cell,
                                  { width: getColWidth(col) },
                                  estadoStyles && {
                                    backgroundColor: estadoStyles.backgroundColor,
                                    borderRadius: radius.sm,
                                  },
                                ]}
                              >
                                <Text style={cellTextBase} numberOfLines={col === 'descripcion' ? 2 : 1}>
                                  {text}
                                </Text>
                              </View>
                            );
                          })}
                        </TouchableOpacity>
                      );
                    })
                  )}
                </ScrollView>
              </View>
            </ScrollView>
          </View>
        </View>
      )}

      <Modal visible={modalBorrarVisible} transparent animationType="fade" onRequestClose={cerrarModalBorrar}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={cerrarModalBorrar}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalContentWrap}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  {incidenciasToDelete.length === 1 ? 'Borrar incidencia' : 'Borrar incidencias'}
                </Text>
                <TouchableOpacity onPress={cerrarModalBorrar} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              <View style={styles.modalBody}>
                <Text style={styles.modalMessage}>
                  {incidenciasToDelete.length === 1
                    ? tituloBorrarModal.trim()
                      ? `¿Estás seguro de que deseas borrar la incidencia «${tituloBorrarModal}»?`
                      : '¿Estás seguro de que deseas borrar esta incidencia?'
                    : `¿Estás seguro de que deseas borrar las ${incidenciasToDelete.length} incidencias seleccionadas?`}
                </Text>
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalBtnNo} onPress={cerrarModalBorrar}>
                    <Text style={styles.modalBtnNoText}>No</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.modalBtnSi} onPress={ejecutarBorrado} disabled={guardando}>
                    <Text style={styles.modalBtnSiText}>Sí, borrar</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalEditarVisible} transparent animationType="fade" onRequestClose={() => setModalEditarVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setModalEditarVisible(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalEditWrap}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Editar incidencia</Text>
                <TouchableOpacity onPress={() => setModalEditarVisible(false)} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.modalEditScroll} keyboardShouldPersistTaps="handled">
                <View style={styles.modalBody}>
                  <View style={styles.modalField}>
                    <Text style={styles.modalLabel}>Título *</Text>
                    <TextInput style={styles.modalInput} value={editTitulo} onChangeText={setEditTitulo} placeholder="Título" placeholderTextColor={colors.textMuted} />
                  </View>
                  <View style={styles.modalField}>
                    <Text style={styles.modalLabel}>Descripción</Text>
                    <TextInput style={[styles.modalInput, styles.modalTextArea]} value={editDescripcion} onChangeText={setEditDescripcion} placeholder="Descripción" placeholderTextColor={colors.textMuted} multiline numberOfLines={3} />
                  </View>
                  <View style={styles.modalField}>
                    <Text style={styles.modalLabel}>Zona</Text>
                    <View style={styles.modalSelectWrap}>
                      {ZONAS_EDIT.map((z) => (
                        <TouchableOpacity key={z} style={[styles.modalOptionBtn, editZona === z && styles.modalOptionBtnSelected]} onPress={() => setEditZona(z)}>
                          <Text style={[styles.modalOptionText, editZona === z && styles.modalOptionTextSelected]}>{z}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                  <View style={styles.modalField}>
                    <Text style={styles.modalLabel}>Prioridad</Text>
                    <View style={styles.modalSelectWrap}>
                      {PRIORIDADES_EDIT.map((p) => (
                        <TouchableOpacity key={p} style={[styles.modalOptionBtn, editPrioridad === p && styles.modalOptionBtnSelected]} onPress={() => setEditPrioridad(p)}>
                          <Text style={[styles.modalOptionText, editPrioridad === p && styles.modalOptionTextSelected]}>{p}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                  <View style={styles.modalField}>
                    <Text style={styles.modalLabel}>Fecha programada</Text>
                    {facturaIncSeleccionada ? (
                      <View style={styles.modalFacturadaBox}>
                        <MaterialIcons name="receipt-long" size={16} color="#0f766e" />
                        <Text style={styles.modalFacturadaText}>
                          {`Reparación facturada${facturaIncSeleccionada.periodo ? ` en ${labelPeriodoCorto(facturaIncSeleccionada.periodo)}` : ''}: su fecha programada ya no se puede cambiar, porque el desplazamiento se cobró con el reparto de ese día. El resto de campos sí se pueden corregir.`}
                        </Text>
                      </View>
                    ) : (
                      <>
                        <View style={styles.modalFechaRow}>
                          <View style={styles.modalFechaInput}>
                            <InputFecha
                              compact
                              valueIso={editFechaProgramada}
                              onChangeIso={setEditFechaProgramada}
                              placeholder="Sin programar"
                            />
                          </View>
                          {editFechaProgramada.trim() !== '' && (
                            <TouchableOpacity
                              style={styles.modalQuitarFechaBtn}
                              onPress={() => setEditFechaProgramada('')}
                            >
                              <MaterialIcons name="event-busy" size={18} color={colors.textMuted} />
                              <Text style={styles.modalQuitarFechaText}>Quitar</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                        <Text style={styles.modalHint}>Opcional. Debe ser hoy o una fecha futura.</Text>
                      </>
                    )}
                  </View>
                  <View style={styles.modalFooter}>
                    <TouchableOpacity style={styles.modalBtnNo} onPress={() => setModalEditarVisible(false)}>
                      <Text style={styles.modalBtnNoText}>Cancelar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.modalBtnGuardar} onPress={ejecutarEdicion} disabled={guardando}>
                      {guardando ? <ActivityIndicator size="small" color={colors.surface} /> : <Text style={styles.modalBtnGuardarText}>Guardar</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              </ScrollView>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <MantenimientoFotosGaleriaModal
        visible={modalFotos !== null}
        fotos={modalFotos?.fotos ?? []}
        titulo={modalFotos?.titulo}
        onClose={() => setModalFotos(null)}
        resolverUriFoto={resolverUriFoto}
      />
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;
/** Entre radius.lg (12) y radius.xl (16). */
const RADIO_TARJETA = 14;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10, minHeight: 0 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.lg, gap: 10 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { fontSize: fontSizes[20], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, lineHeight: 20, marginTop: 2 },
  buttonsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.md, overflow: 'visible', marginBottom: SPACING.lg },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    alignSelf: 'flex-start',
  },
  btnText: { fontSize: fontSizes[14], fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight, color: colors.accent },
  btnWithBadge: { position: 'relative', overflow: 'visible' },
  badge: {
    position: 'absolute',
    top: -14,
    right: -14,
    minWidth: 29,
    height: 29,
    borderRadius: RADIO_TARJETA,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.sm, gap: SPACING.md },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolbarBtn: { padding: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.bg },
  toolbarBtnDisabled: { opacity: 0.6 },
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
  facturadoAviso: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#f0fdfa',
    borderWidth: 1,
    borderColor: '#99f6e4',
    borderRadius: RADIO_MEDIO,
  },
  facturadoAvisoText: { flex: 1, minWidth: 0, fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: '#0f766e', lineHeight: 15 },
  errorWrap: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.sm },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, flex: 1 },
  retryBtn: { paddingVertical: 6, paddingHorizontal: SPACING.md, backgroundColor: statusColors.danger.bg, borderRadius: RADIO_MEDIO },
  retryBtnText: { fontSize: fontSizes[12], color: colors.danger, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm, gap: SPACING.md, flexWrap: 'wrap' },
  subtitleTable: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  pagination: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  pageBtn: { padding: SPACING.xs },
  pageBtnDisabled: { opacity: 0.5 },
  pageText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginHorizontal: SPACING.xs, fontVariant: ['tabular-nums'] },
  center: { paddingVertical: SPACING.xl, alignItems: 'center', gap: 10 },
  loadingText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  tableHeaderText: { fontFamily: fontFamily.regular, fontSize: TABLE_FONT_SIZE, lineHeight: TABLE_FONT_SIZE + 3 },
  cellTextBold: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  fotosIconBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.accentMuted,
  },
  fotosIconCount: { fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text, fontVariant: ['tabular-nums'] },
  /** Más oscuro que colors.overlay. */
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalContentWrap: { width: '100%', maxWidth: 360, padding: SPACING.xl, alignItems: 'center' },
  modalEditWrap: { width: '100%', maxWidth: 480, padding: SPACING.xl, alignItems: 'center' },
  modalEditScroll: { maxHeight: 500 },
  modalCard: { width: '100%', backgroundColor: colors.surface, borderRadius: radius.xl, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: SPACING.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalTitle: { fontSize: fontSizes[18], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  modalClose: { padding: SPACING.xs },
  modalBody: { padding: 20 },
  modalMessage: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary, marginBottom: 20, lineHeight: 20 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACING.md, marginTop: SPACING.sm },
  modalBtnNo: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: colors.navActive, borderRadius: radius.md },
  modalBtnNoText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  modalBtnSi: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: colors.danger, borderRadius: radius.md },
  modalBtnSiText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  modalBtnGuardar: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: colors.accent, borderRadius: radius.md },
  modalBtnGuardarText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  modalField: { marginBottom: 14 },
  modalLabel: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, marginBottom: 6 },
  modalInput: { borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO, paddingVertical: 10, paddingHorizontal: SPACING.md, fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary, backgroundColor: colors.surface },
  modalTextArea: { minHeight: 60, textAlignVertical: 'top' },
  modalSelectWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  modalOptionBtn: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO },
  modalOptionBtnSelected: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  modalOptionText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textPrimary },
  modalOptionTextSelected: { color: colors.accent, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  modalFechaRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  modalFechaInput: { flex: 1, minWidth: 140 },
  modalQuitarFechaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 10,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.navActive,
  },
  modalQuitarFechaText: { fontSize: fontSizes[12], color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  modalFacturadaBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 10,
    backgroundColor: '#f0fdfa',
    borderWidth: 1,
    borderColor: '#99f6e4',
    borderRadius: RADIO_MEDIO,
  },
  modalFacturadaText: { flex: 1, minWidth: 0, fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: '#0f766e', lineHeight: 16 },
  modalHint: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginTop: SPACING.xs },
});
