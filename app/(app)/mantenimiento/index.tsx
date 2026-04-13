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
import { ICONS, ICON_SIZE } from '../../constants/icons';

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

/** Colores pastel por estado: fondo claro + texto más oscuro del mismo tono */
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

export default function MantenimientoScreen() {
  const router = useRouter();
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
  const [pageIndex, setPageIndex] = useState(0);
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [modalBorrarVisible, setModalBorrarVisible] = useState(false);
  const [modalEditarVisible, setModalEditarVisible] = useState(false);
  const [editTitulo, setEditTitulo] = useState('');
  const [editDescripcion, setEditDescripcion] = useState('');
  const [editZona, setEditZona] = useState('');
  const [editPrioridad, setEditPrioridad] = useState('');
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
        const list = all.filter((i) => {
          const lid = (i.local_id ?? '').toString().trim();
          return !lid || lid in mapLocalIdToNombre;
        });
        setIncidencias(list);
        const abiertas = list.filter(
          (i: Incidencia) =>
            (i.estado ?? '') !== 'CANCELADA' &&
            ((i.estado_valoracion ?? '') as string).toString().toUpperCase() !== 'REPARADO'
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

  const badgeColor = countAbiertas === 0 ? '#22c55e' : '#dc2626';

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

  const columnas = useMemo(() => [...COLUMNAS_INCIDENCIAS], []);
  const totalRegistros = incidencias.length;
  const totalPages = Math.max(1, Math.ceil(totalRegistros / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const incidenciasPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return incidencias.slice(start, start + PAGE_SIZE);
  }, [incidencias, pageIndexClamped]);

  const goPrevPage = useCallback(() => {
    setPageIndex((p) => Math.max(0, p - 1));
    setSelectedRowIndex(null);
  }, []);
  const goNextPage = useCallback(() => {
    setPageIndex((p) => Math.min(totalPages - 1, p + 1));
    setSelectedRowIndex(null);
  }, [totalPages]);

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

  const incSeleccionada = selectedRowIndex !== null ? incidenciasPagina[selectedRowIndex] : null;
  const haySeleccion = incSeleccionada !== null;

  const abrirModalBorrar = useCallback(() => {
    if (!incSeleccionada) return;
    setModalBorrarVisible(true);
  }, [incSeleccionada]);

  const ejecutarBorrado = useCallback(async () => {
    if (!incSeleccionada) return;
    const localId = (incSeleccionada.local_id ?? '').toString().trim();
    const idIncidencia = (incSeleccionada.id_incidencia ?? '').toString().trim();
    const fechaCreacion = (incSeleccionada.fecha_creacion ?? '').toString().trim();
    if (!localId || !idIncidencia || !fechaCreacion) return;
    setModalBorrarVisible(false);
    setGuardando(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/mantenimiento/incidencias`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ local_id: localId, id_incidencia: idIncidencia, fecha_creacion: fechaCreacion }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al borrar'); return; }
      setSelectedRowIndex(null);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  }, [incSeleccionada, refetch]);

  const abrirModalEditar = useCallback(() => {
    if (!incSeleccionada) return;
    setEditTitulo((incSeleccionada.titulo ?? '').toString());
    setEditDescripcion((incSeleccionada.descripcion ?? '').toString());
    setEditZona((incSeleccionada.zona ?? '').toString().toLowerCase());
    setEditPrioridad((incSeleccionada.prioridad_reportada ?? '').toString().toLowerCase());
    setModalEditarVisible(true);
  }, [incSeleccionada]);

  const ejecutarEdicion = useCallback(async () => {
    if (!incSeleccionada) return;
    const localId = (incSeleccionada.local_id ?? '').toString().trim();
    const idIncidencia = (incSeleccionada.id_incidencia ?? '').toString().trim();
    const fechaCreacion = (incSeleccionada.fecha_creacion ?? '').toString().trim();
    if (!localId || !idIncidencia || !fechaCreacion) return;
    if (!editTitulo.trim()) { setError('El título es obligatorio'); return; }
    setModalEditarVisible(false);
    setGuardando(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/mantenimiento/incidencias`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          local_id: localId,
          id_incidencia: idIncidencia,
          fecha_creacion: fechaCreacion,
          editar_campos: true,
          titulo: editTitulo.trim(),
          descripcion: editDescripcion.trim(),
          zona: editZona,
          prioridad_reportada: editPrioridad,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al editar'); return; }
      setSelectedRowIndex(null);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  }, [incSeleccionada, editTitulo, editDescripcion, editZona, editPrioridad, refetch]);

  const toolbarBtns = [
    { id: 'crear', label: 'Reportar incidencia', icon: ICONS.add, onPress: () => router.push('/mantenimiento/reportar') },
    { id: 'editar', label: 'Editar', icon: ICONS.edit, disabled: !haySeleccion || guardando, onPress: abrirModalEditar },
    { id: 'borrar', label: 'Borrar', icon: ICONS.delete, disabled: !haySeleccion || guardando, onPress: abrirModalBorrar },
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mantenimiento</Text>
      <Text style={styles.subtitle}>Opciones de mantenimiento del sistema.</Text>

      <View style={styles.buttonsRow}>
        <TouchableOpacity style={styles.btn} onPress={() => router.push('/mantenimiento/reportar')} activeOpacity={0.7}>
          <MaterialIcons name="add-circle-outline" size={22} color="#0ea5e9" />
          <Text style={styles.btnText}>Reportar incidencia</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnWithBadge]} onPress={() => router.push('/mantenimiento/abiertas')} activeOpacity={0.7}>
          <MaterialIcons name="list-alt" size={22} color="#0ea5e9" />
          <Text style={styles.btnText}>Incidencias abiertas</Text>
          {countAbiertas !== null && (
            <View style={[styles.badge, { backgroundColor: badgeColor }]} pointerEvents="none">
              <Text style={styles.badgeText}>{countAbiertas}</Text>
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={() => router.push('/mantenimiento/programadas-hoy')} activeOpacity={0.7}>
          <MaterialIcons name="today" size={22} color="#0ea5e9" />
          <Text style={styles.btnText}>Reparaciones de hoy</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={() => router.push('/mantenimiento/reparaciones-realizadas')} activeOpacity={0.7}>
          <MaterialIcons name="check-circle-outline" size={22} color="#0ea5e9" />
          <Text style={styles.btnText}>Reparaciones realizadas</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={() => router.push('/mantenimiento/recurrentes')} activeOpacity={0.7}>
          <MaterialIcons name="event-repeat" size={22} color="#0ea5e9" />
          <Text style={styles.btnText}>Reparaciones recurrentes</Text>
        </TouchableOpacity>
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
              <MaterialIcons name={btn.icon} size={ICON_SIZE} color={btn.disabled ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.toolbarBtn} onPress={refetch} disabled={loading} accessibilityLabel="Actualizar">
            {loading ? <ActivityIndicator size="small" color="#0ea5e9" /> : <MaterialIcons name="refresh" size={ICON_SIZE} color="#0ea5e9" />}
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
          {totalRegistros === 0 ? '0 registros' : totalPages > 1 ? `${pageIndexClamped * PAGE_SIZE + 1}–${Math.min((pageIndexClamped + 1) * PAGE_SIZE, totalRegistros)} de ${totalRegistros} registro${totalRegistros !== 1 ? 's' : ''}` : `${totalRegistros} registro${totalRegistros !== 1 ? 's' : ''}`}
        </Text>
        {totalPages > 1 && (
          <View style={styles.pagination}>
            <TouchableOpacity style={[styles.pageBtn, pageIndexClamped <= 0 && styles.pageBtnDisabled]} onPress={goPrevPage} disabled={pageIndexClamped <= 0}>
              <MaterialIcons name="chevron-left" size={20} color={pageIndexClamped <= 0 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
            <Text style={styles.pageText}>Página {pageIndexClamped + 1} de {totalPages}</Text>
            <TouchableOpacity style={[styles.pageBtn, pageIndexClamped >= totalPages - 1 && styles.pageBtnDisabled]} onPress={goNextPage} disabled={pageIndexClamped >= totalPages - 1}>
              <MaterialIcons name="chevron-right" size={20} color={pageIndexClamped >= totalPages - 1 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {loading && incidencias.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0ea5e9" />
          <Text style={styles.loadingText}>Cargando incidencias…</Text>
        </View>
      ) : (
        <ScrollView horizontal style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <View style={styles.table}>
            <View style={styles.rowHeader}>
              {columnas.map((col) => (
                <View key={col} style={[styles.cellHeader, { width: getColWidth(col) }]}>
                  <Text style={styles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">
                    {col.replace(/_/g, ' ')}
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
              <TouchableOpacity
                key={`${inc.id_incidencia ?? idx}-${inc.fecha_creacion}`}
                style={[styles.row, selectedRowIndex === idx && styles.rowSelected]}
                onPress={() => setSelectedRowIndex(selectedRowIndex === idx ? null : idx)}
                activeOpacity={0.8}
              >
                {columnas.map((col) => {
                  const raw = valorCelda(inc, col);
                  const text = col === 'titulo' || col === 'descripcion' ? (raw.length > MAX_TEXT_LENGTH ? truncar(raw) : raw) : raw;
                  const esEstado = col === 'estado';
                  const estadoStyles = esEstado ? estilosEstado(inc.estado as string) : null;

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
                    const alerta = dias > 7 && (estado === 'Nuevo' || estado === 'Programado');
                    return (
                      <View
                        key={col}
                        style={[
                          styles.cell,
                          { width: getColWidth(col), flexDirection: 'row', alignItems: 'center', gap: 4 },
                          alerta && { backgroundColor: '#fef2f2' },
                        ]}
                      >
                        {alerta && <MaterialIcons name="warning" size={14} color="#dc2626" />}
                        <Text
                          style={[styles.cellText, alerta && { color: '#dc2626', fontWeight: '700' }]}
                          numberOfLines={1}
                          ellipsizeMode="tail"
                        >
                          {text}
                        </Text>
                      </View>
                    );
                  }

                  return (
                    <View
                      key={col}
                      style={[
                        styles.cell,
                        { width: getColWidth(col) },
                        estadoStyles && { backgroundColor: estadoStyles.backgroundColor, borderRadius: 6 },
                      ]}
                    >
                      <Text
                        style={[styles.cellText, estadoStyles && { color: estadoStyles.color, fontWeight: '600' }]}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                      >
                        {text}
                      </Text>
                    </View>
                  );
                })}
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}

      <Modal visible={modalBorrarVisible} transparent animationType="fade" onRequestClose={() => setModalBorrarVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setModalBorrarVisible(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalContentWrap}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Borrar incidencia</Text>
                <TouchableOpacity onPress={() => setModalBorrarVisible(false)} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={styles.modalBody}>
                <Text style={styles.modalMessage}>
                  ¿Estás seguro de que deseas borrar la incidencia «{incSeleccionada ? (incSeleccionada.titulo ?? '').toString() : ''}»?
                </Text>
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalBtnNo} onPress={() => setModalBorrarVisible(false)}>
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
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.modalEditScroll} keyboardShouldPersistTaps="handled">
                <View style={styles.modalBody}>
                  <View style={styles.modalField}>
                    <Text style={styles.modalLabel}>Título *</Text>
                    <TextInput style={styles.modalInput} value={editTitulo} onChangeText={setEditTitulo} placeholder="Título" placeholderTextColor="#94a3b8" />
                  </View>
                  <View style={styles.modalField}>
                    <Text style={styles.modalLabel}>Descripción</Text>
                    <TextInput style={[styles.modalInput, styles.modalTextArea]} value={editDescripcion} onChangeText={setEditDescripcion} placeholder="Descripción" placeholderTextColor="#94a3b8" multiline numberOfLines={3} />
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
                  <View style={styles.modalFooter}>
                    <TouchableOpacity style={styles.modalBtnNo} onPress={() => setModalEditarVisible(false)}>
                      <Text style={styles.modalBtnNoText}>Cancelar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.modalBtnGuardar} onPress={ejecutarEdicion} disabled={guardando}>
                      {guardando ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.modalBtnGuardarText}>Guardar</Text>}
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
  title: { fontSize: 20, fontWeight: '700', color: '#334155', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748b', lineHeight: 20, marginBottom: 16 },
  buttonsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, overflow: 'visible', marginBottom: 16 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  btnText: { fontSize: 14, fontWeight: '500', color: '#0ea5e9' },
  btnWithBadge: { position: 'relative', overflow: 'visible' },
  badge: {
    position: 'absolute',
    top: -14,
    right: -14,
    minWidth: 29,
    height: 29,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolbarBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  toolbarBtnDisabled: { opacity: 0.6 },
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
  rowSelected: { backgroundColor: '#e0f2fe' },
  cell: { minWidth: MIN_COL_WIDTH, paddingVertical: 4, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  cellText: { fontSize: 11, color: '#475569' },
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalContentWrap: { width: '100%', maxWidth: 360, padding: 24, alignItems: 'center' },
  modalEditWrap: { width: '100%', maxWidth: 480, padding: 24, alignItems: 'center' },
  modalEditScroll: { maxHeight: 500 },
  modalCard: { width: '100%', backgroundColor: '#fff', borderRadius: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#334155' },
  modalClose: { padding: 4 },
  modalBody: { padding: 20 },
  modalMessage: { fontSize: 14, color: '#475569', marginBottom: 20, lineHeight: 20 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 8 },
  modalBtnNo: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#f1f5f9', borderRadius: 10 },
  modalBtnNoText: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  modalBtnSi: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#dc2626', borderRadius: 10 },
  modalBtnSiText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  modalBtnGuardar: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#0ea5e9', borderRadius: 10 },
  modalBtnGuardarText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  modalField: { marginBottom: 14 },
  modalLabel: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 6 },
  modalInput: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, fontSize: 14, color: '#334155', backgroundColor: '#fff' },
  modalTextArea: { minHeight: 60, textAlignVertical: 'top' },
  modalSelectWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modalOptionBtn: { paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8 },
  modalOptionBtnSelected: { borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  modalOptionText: { fontSize: 12, color: '#475569' },
  modalOptionTextSelected: { color: '#0ea5e9', fontWeight: '500' },
});
