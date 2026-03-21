import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  ActivityIndicator,
  Platform,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { useAuth } from '../../contexts/AuthContext';
import { useLocalToast } from '../../components/Toast';
import { TablaBasica } from '../../components/TablaBasica';
import { FechaInputDmy } from '../../components/FechaInputDmy';
import { formatFecha } from '../../utils/formatFecha';
import { formatMoneda, labelEstado } from '../../utils/facturacion';
import { API_BASE_URL as API_URL } from '../../utils/apiBaseUrl';
import { ICON_SIZE } from '../../constants/icons';
import { FirmaEnPantallaModal } from '../../components/FirmaEnPantallaModal';
import { buildFirmaFormData } from '../../utils/uploadFirmaPng';

type Actuacion = {
  id_actuacion: string;
  id_artista?: string;
  artista_nombre_snapshot?: string;
  fecha: string;
  hora_inicio?: string;
  hora_fin?: string;
  franja?: string;
  tipo_dia?: string;
  importe_previsto?: number | null;
  importe_final?: number | null;
  estado?: string;
  id_local?: string;
  local_nombre_snapshot?: string;
  id_factura_gasto?: string;
  observaciones?: string;
  pago_asociado_numero_factura?: string;
  pago_asociado_proveedor?: string;
  pago_asociado_fecha?: string;
  pago_asociado_importe?: number | null;
  pago_asociado_estado?: string;
};

type FacturaOpt = {
  id_factura: string;
  numero_factura: string;
  proveedor: string;
  fecha_emision: string;
  total_factura: number;
  estado: string;
};

type LocalOpt = { id_Locales: string; nombre?: string; sede?: string };

const COLUMNAS = ['Sel', 'Fecha', 'Hora', 'Local', 'Artista', 'Importe', 'Estado', 'Pago'] as const;

type ConflictoOtro = {
  id_actuacion: string;
  fecha: string;
  hora_inicio: string;
  id_local: string;
  local_nombre_snapshot: string;
  estado: string;
  id_artista: string;
  artista_nombre_snapshot: string;
};

function getValorCelda(a: Actuacion, col: string): string {
  switch (col) {
    case 'Sel':
      return '';
    case 'Fecha':
      return a.fecha ? formatFecha(a.fecha) : '—';
    case 'Hora':
      return a.hora_inicio || '—';
    case 'Local':
      return a.local_nombre_snapshot?.trim() || a.id_local || '—';
    case 'Artista':
      return a.artista_nombre_snapshot?.trim() || (a.id_artista ? '—' : '(hueco)');
    case 'Importe':
      return a.importe_final != null ? String(a.importe_final) : a.importe_previsto != null ? String(a.importe_previsto) : '—';
    case 'Estado':
      return a.estado || '—';
    case 'Pago':
      return a.pago_asociado_numero_factura?.trim() || a.id_factura_gasto ? 'Sí' : '—';
    default:
      return '—';
  }
}

export default function ProgramacionScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { show: showToast, ToastView } = useLocalToast();
  const [actuaciones, setActuaciones] = useState<Actuacion[]>([]);
  const [artistas, setArtistas] = useState<{ id_artista: string; nombre_artistico: string }[]>([]);
  const [localesParipe, setLocalesParipe] = useState<LocalOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [filtroLocal, setFiltroLocal] = useState('');
  const [filtroEstado, setFiltroEstado] = useState('');

  const [modalNuevos, setModalNuevos] = useState(false);
  const [fechaIniN, setFechaIniN] = useState('');
  const [fechaFinN, setFechaFinN] = useState('');
  /** Locales seleccionados para generar huecos (multi-selección). */
  const [localesN, setLocalesN] = useState<string[]>([]);
  const [horasN, setHorasN] = useState<string[]>(['22:00']);
  const [generando, setGenerando] = useState(false);
  /** Desplegable de locales en «Nuevos registros base». */
  const [localesGenDropdownOpen, setLocalesGenDropdownOpen] = useState(false);
  /** Desplegable de filtro por local en la barra. */
  const [filtroLocalDropdownOpen, setFiltroLocalDropdownOpen] = useState(false);

  const [modalAsoc, setModalAsoc] = useState(false);
  const [facturas, setFacturas] = useState<FacturaOpt[]>([]);
  const [loadingFac, setLoadingFac] = useState(false);
  const [qFac, setQFac] = useState('');
  const [elegida, setElegida] = useState<FacturaOpt | null>(null);

  const [modalEdit, setModalEdit] = useState(false);
  const [form, setForm] = useState<Partial<Actuacion>>({});
  const [saving, setSaving] = useState(false);
  /** Desplegable de artista en modal editar. */
  const [artistaEditDropdownOpen, setArtistaEditDropdownOpen] = useState(false);
  const [modalFirma, setModalFirma] = useState(false);
  const [firmaSubiendo, setFirmaSubiendo] = useState(false);

  const [conflictoOpen, setConflictoOpen] = useState(false);
  const [conflictoOtro, setConflictoOtro] = useState<ConflictoOtro | null>(null);
  const [pendingPutBody, setPendingPutBody] = useState<Record<string, unknown> | null>(null);
  /** Evita recalcular importe al abrir el modal (se mantienen valores de BD). */
  const skipImporteCalcOnceRef = useRef(false);

  const listaFiltrada = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return actuaciones;
    return actuaciones.filter((a) =>
      COLUMNAS.some((col) => getValorCelda(a, col).toLowerCase().includes(q))
    );
  }, [actuaciones, filtroBusqueda]);

  const resumenLocalesGen = useMemo(() => {
    if (localesN.length === 0) return '';
    if (localesN.length === 1) {
      const loc = localesParipe.find((l) => l.id_Locales === localesN[0]);
      return loc?.nombre?.trim() || localesN[0];
    }
    return `${localesN.length} locales seleccionados`;
  }, [localesN, localesParipe]);

  const textoFiltroLocal = useMemo(() => {
    if (!filtroLocal) return 'Todos los locales';
    const loc = localesParipe.find((l) => l.id_Locales === filtroLocal);
    return loc?.nombre?.trim() || filtroLocal;
  }, [filtroLocal, localesParipe]);

  /** Rojo = importe editado mayor al sugerido; verde = menor; neutro = igual o sin sugerido. */
  const importeComparacion = useMemo(() => {
    const sug = form.importe_previsto;
    if (sug == null || Number.isNaN(Number(sug))) return 'neutral' as const;
    const nSug = Number(sug);
    const edit =
      form.importe_final != null && !Number.isNaN(Number(form.importe_final))
        ? Number(form.importe_final)
        : nSug;
    if (Math.abs(edit - nSug) < 0.01) return 'neutral' as const;
    return edit > nSug ? ('mayor' as const) : ('menor' as const);
  }, [form.importe_previsto, form.importe_final]);

  const fetchAll = useCallback(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (fechaDesde) qs.set('fechaDesde', fechaDesde);
    if (fechaHasta) qs.set('fechaHasta', fechaHasta);
    if (filtroLocal) qs.set('id_local', filtroLocal);
    if (filtroEstado) qs.set('estado', filtroEstado);
    Promise.all([
      fetch(`${API_URL}/api/actuaciones?${qs}`).then((r) => r.json()),
      fetch(`${API_URL}/api/artistas`).then((r) => r.json()),
      fetch(`${API_URL}/api/locales?grupoParipe=1`).then((r) => r.json()),
    ])
      .then(([a, ar, locP]) => {
        if (a.error) setError(a.error);
        setActuaciones(a.actuaciones || []);
        setArtistas(
          (ar.artistas || []).map((x: { id_artista: string; nombre_artistico: string }) => ({
            id_artista: x.id_artista,
            nombre_artistico: x.nombre_artistico,
          }))
        );
        setLocalesParipe(locP.locales || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de red'))
      .finally(() => setLoading(false));
  }, [fechaDesde, fechaHasta, filtroLocal, filtroEstado]);

  const buscarFacturas = useCallback(async () => {
    setLoadingFac(true);
    try {
      const qs = new URLSearchParams();
      if (qFac.trim()) qs.set('q', qFac.trim());
      const r = await fetch(`${API_URL}/api/actuaciones/facturas-gasto-asociables?${qs}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      setFacturas(d.facturas || []);
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setLoadingFac(false);
    }
  }, [qFac, showToast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (modalAsoc) void buscarFacturas();
  }, [modalAsoc, buscarFacturas]);

  function toggleSel(id: string) {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function confirmarAsociacion() {
    if (!elegida || selectedIds.size === 0) {
      showToast('Selección', 'Elige actuaciones (columna Sel) y una factura.', 'warning');
      return;
    }
    try {
      const r = await fetch(`${API_URL}/api/actuaciones/asociar-factura`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids_actuacion: [...selectedIds],
          id_factura: elegida.id_factura,
          usuario_id: user?.id_usuario,
          usuario_nombre: user?.Nombre,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      showToast('Asociado', `${d.actualizadas} actuaciones actualizadas.`, 'success');
      setModalAsoc(false);
      setSelectedIds(new Set());
      setElegida(null);
      fetchAll();
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  /** Importe sugerido automático al cambiar artista, fecha u hora (no al abrir con datos de BD). */
  useEffect(() => {
    if (!modalEdit) return;
    if (!form.id_artista || !form.fecha) return;
    if (skipImporteCalcOnceRef.current) {
      skipImporteCalcOnceRef.current = false;
      return;
    }
    const hora = form.hora_inicio || '22:00';
    const ac = new AbortController();
    (async () => {
      try {
        const r = await fetch(`${API_URL}/api/actuaciones/calcular-importe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id_artista: form.id_artista,
            fecha: form.fecha,
            hora_inicio: hora,
          }),
          signal: ac.signal,
        });
        const d = await r.json();
        if (!r.ok || ac.signal.aborted) return;
        setForm((f) => ({
          ...f,
          franja: d.franja,
          tipo_dia: d.tipo_dia,
          importe_previsto: d.importe_previsto ?? null,
          importe_final: d.importe_previsto != null ? d.importe_previsto : null,
        }));
      } catch {
        /* abort o red */
      }
    })();
    return () => ac.abort();
  }, [modalEdit, form.id_artista, form.fecha, form.hora_inicio]);

  async function ejecutarPut(id: string, body: Record<string, unknown>, forzar?: boolean) {
    const r = await fetch(`${API_URL}/api/actuaciones/item/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forzar ? { ...body, forzar_conflicto: true } : body),
    });
    const d = await r.json();
    if (r.status === 409 && d.conflicto && d.otro) {
      setConflictoOtro(d.otro);
      setPendingPutBody(body);
      setConflictoOpen(true);
      return false;
    }
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return true;
  }

  async function guardarEdicion() {
    if (!form.id_actuacion) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        id_artista: form.id_artista ?? '',
        artista_nombre_snapshot: form.artista_nombre_snapshot ?? '',
        fecha: form.fecha,
        hora_inicio: form.hora_inicio || '22:00',
        hora_fin: form.hora_fin ?? '',
        id_local: form.id_local ?? '',
        local_nombre_snapshot: form.local_nombre_snapshot ?? '',
        importe_previsto: form.importe_previsto ?? null,
        importe_final: form.importe_final ?? null,
        estado: form.estado ?? 'pendiente',
        observaciones: form.observaciones ?? '',
      };
      const ok = await ejecutarPut(form.id_actuacion, body);
      if (ok) {
        showToast('Guardado', 'Actuación actualizada.', 'success');
        cerrarModalEdit();
        setForm({});
        fetchAll();
      }
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function conflictoGuardarIgual() {
    if (!form.id_actuacion || !pendingPutBody) return;
    setSaving(true);
    try {
      const r = await fetch(`${API_URL}/api/actuaciones/item/${form.id_actuacion}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...pendingPutBody, forzar_conflicto: true }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      showToast('Guardado', 'Actuación guardada.', 'success');
      setConflictoOpen(false);
      setConflictoOtro(null);
      setPendingPutBody(null);
      cerrarModalEdit();
      setForm({});
      fetchAll();
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function conflictoMoverAqui() {
    if (!form.id_actuacion || !conflictoOtro || !form.id_artista) return;
    setSaving(true);
    try {
      const r = await fetch(`${API_URL}/api/actuaciones/mover-artista-aqui`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_vaciar: conflictoOtro.id_actuacion,
          id_asignar: form.id_actuacion,
          id_artista: form.id_artista,
          importe_previsto: form.importe_previsto,
          importe_final: form.importe_final,
          observaciones: form.observaciones ?? '',
          estado: form.estado ?? 'pendiente',
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      showToast('Listo', 'Artista movido a esta actuación.', 'success');
      setConflictoOpen(false);
      setConflictoOtro(null);
      setPendingPutBody(null);
      cerrarModalEdit();
      setForm({});
      fetchAll();
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setSaving(false);
    }
  }

  function abrirNuevosRegistros() {
    setFechaIniN(new Date().toISOString().slice(0, 10));
    setFechaFinN(new Date().toISOString().slice(0, 10));
    setLocalesN([]);
    setLocalesGenDropdownOpen(false);
    setHorasN(['22:00']);
    setModalNuevos(true);
  }

  function toggleLocalGenerar(id: string) {
    setLocalesN((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function seleccionarTodosLocalesGen() {
    setLocalesN(localesParipe.map((l) => l.id_Locales));
  }

  function quitarTodosLocalesGen() {
    setLocalesN([]);
  }

  async function confirmarGenerarBase() {
    if (localesN.length === 0 || !fechaIniN || !fechaFinN || horasN.length === 0) {
      showToast('Datos incompletos', 'Indica fechas, al menos un local y al menos una hora.', 'warning');
      return;
    }
    setGenerando(true);
    try {
      const r = await fetch(`${API_URL}/api/actuaciones/generar-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fecha_inicio: fechaIniN,
          fecha_fin: fechaFinN,
          id_locales: localesN,
          horas: horasN.map((h) => h.trim()).filter(Boolean),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      showToast('Generado', `${d.creadas} registros creados.`, 'success');
      setModalNuevos(false);
      fetchAll();
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setGenerando(false);
    }
  }

  function abrirEditar(item: Actuacion) {
    setForm({ ...item });
    setArtistaEditDropdownOpen(false);
    skipImporteCalcOnceRef.current = !!(item.id_artista && item.fecha);
    setModalEdit(true);
  }

  function cerrarModalEdit() {
    setArtistaEditDropdownOpen(false);
    setModalFirma(false);
    setModalEdit(false);
  }

  async function subirFirmaArchivo(idAct: string) {
    const pick = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true });
    if (pick.canceled || !pick.assets?.[0]) return;
    const asset = pick.assets[0];
    const formData = new FormData();
    formData.append('file', {
      uri: asset.uri,
      name: asset.name || 'firma.png',
      type: asset.mimeType || 'image/png',
    } as unknown as Blob);
    const r = await fetch(`${API_URL}/api/actuaciones/item/${idAct}/firma`, { method: 'POST', body: formData });
    const d = await r.json();
    if (!r.ok) showToast('Error', d.error || 'No se pudo subir', 'error');
    else {
      showToast('OK', 'Firma guardada', 'success');
      fetchAll();
    }
  }

  async function enviarFirmaDesdePantalla(idAct: string, base64Raw: string) {
    setFirmaSubiendo(true);
    try {
      const formData = await buildFirmaFormData(base64Raw);
      const r = await fetch(`${API_URL}/api/actuaciones/item/${idAct}/firma`, { method: 'POST', body: formData });
      const d = await r.json();
      if (!r.ok) showToast('Error', d.error || 'No se pudo subir', 'error');
      else {
        showToast('OK', 'Firma guardada', 'success');
        setModalFirma(false);
        fetchAll();
      }
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setFirmaSubiendo(false);
    }
  }

  async function borrarActuacion(item: Actuacion) {
    try {
      const r = await fetch(`${API_URL}/api/actuaciones/item/${item.id_actuacion}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      showToast('Eliminado', 'Actuación eliminada.', 'success');
      setSelectedRowIndex(null);
      fetchAll();
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  return (
    <View style={styles.screenWrap}>
      {ToastView}
      <TablaBasica<Actuacion>
        title="Actuaciones — planificación"
        onBack={() => router.back()}
        columnas={[...COLUMNAS]}
        datos={listaFiltrada}
        getValorCelda={getValorCelda}
        loading={loading}
        error={error}
        onRetry={fetchAll}
        filtroBusqueda={filtroBusqueda}
        onFiltroChange={setFiltroBusqueda}
        selectedRowIndex={selectedRowIndex}
        onSelectRow={setSelectedRowIndex}
        toolbarCrearLabel="Nuevos registros base"
        onCrear={abrirNuevosRegistros}
        onEditar={(item) => abrirEditar(item)}
        onBorrar={(item) => borrarActuacion(item)}
        guardando={saving || generando}
        emptyMessage="No hay actuaciones. Pulsa + para nuevos registros base."
        emptyFilterMessage="Ningún resultado con el filtro"
        defaultColWidth={88}
        dense
        columnasMoneda={['Importe']}
        getColumnCellStyle={(col) => {
          if (col === 'Sel') return { cell: { width: 44, minWidth: 44, maxWidth: 48 } };
          if (col === 'Fecha') return { cell: { minWidth: 96 } };
          if (col === 'Local') return { cell: { minWidth: 100 } };
          return undefined;
        }}
        renderCell={(item, col) => {
          if (col === 'Sel') {
            const on = selectedIds.has(item.id_actuacion);
            return (
              <TouchableOpacity
                onPress={() => toggleSel(item.id_actuacion)}
                style={styles.selCell}
                hitSlop={8}
                accessibilityLabel="Seleccionar para asociar factura"
              >
                <MaterialIcons name={on ? 'check-box' : 'check-box-outline-blank'} size={20} color={on ? '#0ea5e9' : '#94a3b8'} />
              </TouchableOpacity>
            );
          }
          if (col === 'Artista') {
            const nombre = item.artista_nombre_snapshot?.trim();
            if (!item.id_artista) {
              return (
                <TouchableOpacity
                  style={styles.huecoBadge}
                  onPress={() => abrirEditar(item)}
                  activeOpacity={0.75}
                  hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                  accessibilityLabel="Hueco: editar actuación"
                >
                  <Text style={styles.huecoBadgeText}>(hueco)</Text>
                </TouchableOpacity>
              );
            }
            return (
              <Text style={styles.cellSmall} numberOfLines={2}>
                {nombre || '—'}
              </Text>
            );
          }
          if (col === 'Importe') {
            const v = item.importe_final ?? item.importe_previsto;
            return (
              <Text style={[styles.cellMoney, v == null && styles.cellMuted]}>
                {v != null ? formatMoneda(v) : '—'}
              </Text>
            );
          }
          if (col === 'Pago') {
            const t = item.pago_asociado_numero_factura || item.id_factura_gasto;
            return <Text style={styles.cellSmall} numberOfLines={1}>{t ? String(t).slice(0, 14) + (String(t).length > 14 ? '…' : '') : '—'}</Text>;
          }
          return null;
        }}
        extraToolbarLeft={
          <View style={styles.filtersWrap}>
            <View style={styles.filtersRowTop}>
              <TextInput
                style={[styles.fInputEstado, styles.fInput]}
                placeholder="Estado (ej. pendiente)"
                value={filtroEstado}
                onChangeText={setFiltroEstado}
                placeholderTextColor="#94a3b8"
              />
            </View>
            <View style={styles.filtersRowBottom}>
              <Text style={styles.filterLabelInline}>Local</Text>
              <View style={styles.filterLocalDropdownWrap}>
                <TouchableOpacity
                  style={styles.filterToolbarTrigger}
                  onPress={() => setFiltroLocalDropdownOpen((v) => !v)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.filterToolbarTriggerText} numberOfLines={1}>
                    {textoFiltroLocal}
                  </Text>
                  <MaterialIcons name={filtroLocalDropdownOpen ? 'expand-less' : 'expand-more'} size={20} color="#64748b" />
                </TouchableOpacity>
                {filtroLocalDropdownOpen ? (
                  <View style={styles.filterToolbarList}>
                    <ScrollView style={styles.filterToolbarScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      <TouchableOpacity
                        style={[styles.filterToolbarOpt, !filtroLocal && styles.filterToolbarOptOn]}
                        onPress={() => {
                          setFiltroLocal('');
                          setFiltroLocalDropdownOpen(false);
                        }}
                      >
                        <Text style={styles.filterToolbarOptText}>Todos los locales</Text>
                        {!filtroLocal ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                      </TouchableOpacity>
                      {localesParipe.map((loc) => {
                        const sel = filtroLocal === loc.id_Locales;
                        return (
                          <TouchableOpacity
                            key={loc.id_Locales}
                            style={[styles.filterToolbarOpt, sel && styles.filterToolbarOptOn]}
                            onPress={() => {
                              setFiltroLocal(loc.id_Locales);
                              setFiltroLocalDropdownOpen(false);
                            }}
                          >
                            <Text style={styles.filterToolbarOptText} numberOfLines={2}>
                              {loc.nombre || loc.id_Locales}
                            </Text>
                            {sel ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
                ) : null}
              </View>
              <Text style={styles.filterLabelInline}>Desde</Text>
              <FechaInputDmy
                style={[styles.fInput, styles.fInputFecha]}
                placeholder="dd/mm/yyyy"
                valueIso={fechaDesde}
                onChangeIso={setFechaDesde}
              />
              <Text style={styles.filterLabelInline}>Hasta</Text>
              <FechaInputDmy
                style={[styles.fInput, styles.fInputFecha]}
                placeholder="dd/mm/yyyy"
                valueIso={fechaHasta}
                onChangeIso={setFechaHasta}
              />
              <TouchableOpacity style={styles.fBtn} onPress={fetchAll}>
                <Text style={styles.fBtnText}>Filtrar</Text>
              </TouchableOpacity>
            </View>
          </View>
        }
        extraToolbarRight={
          <View style={styles.toolbarRight}>
            <TouchableOpacity
              style={[styles.asocBtn, selectedIds.size === 0 && styles.asocBtnOff]}
              disabled={selectedIds.size === 0}
              onPress={() => setModalAsoc(true)}
            >
              <MaterialIcons name="link" size={ICON_SIZE - 2} color="#fff" />
              <Text style={styles.asocBtnText}>Asociar ({selectedIds.size})</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.refreshBtn} onPress={fetchAll} disabled={loading}>
              {loading ? <ActivityIndicator size="small" color="#0ea5e9" /> : <MaterialIcons name="refresh" size={ICON_SIZE} color="#0ea5e9" />}
            </TouchableOpacity>
          </View>
        }
      />

      <Modal visible={modalNuevos} transparent animationType="fade" onRequestClose={() => setModalNuevos(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Nuevos registros base</Text>
              <TouchableOpacity onPress={() => setModalNuevos(false)}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>Fecha inicio</Text>
              <FechaInputDmy style={styles.input} valueIso={fechaIniN} onChangeIso={setFechaIniN} />
              <Text style={styles.label}>Fecha final</Text>
              <FechaInputDmy style={styles.input} valueIso={fechaFinN} onChangeIso={setFechaFinN} />
              <Text style={styles.label}>Locales (GRUPO PARIPE)</Text>
              {localesParipe.length === 0 ? (
                <Text style={styles.hint}>No hay locales con sede grupo Paripe. Revisa Locales / Sede.</Text>
              ) : (
                <View style={styles.fieldDropdown}>
                  <TouchableOpacity
                    style={styles.dropdownTrigger}
                    onPress={() => setLocalesGenDropdownOpen((v) => !v)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[styles.dropdownTriggerText, !resumenLocalesGen && styles.dropdownPlaceholder]}
                      numberOfLines={2}
                    >
                      {resumenLocalesGen || 'Selecciona uno o más locales…'}
                    </Text>
                    <MaterialIcons name={localesGenDropdownOpen ? 'expand-less' : 'expand-more'} size={22} color="#64748b" />
                  </TouchableOpacity>
                  {localesGenDropdownOpen ? (
                    <View style={styles.dropdownList}>
                      <View style={styles.dropdownToolbar}>
                        <TouchableOpacity onPress={seleccionarTodosLocalesGen}>
                          <Text style={styles.localesGenLink}>Todos</Text>
                        </TouchableOpacity>
                        <Text style={styles.localesGenSep}>·</Text>
                        <TouchableOpacity onPress={quitarTodosLocalesGen}>
                          <Text style={styles.localesGenLink}>Ninguno</Text>
                        </TouchableOpacity>
                        <View style={{ flex: 1 }} />
                        <Text style={styles.dropdownCount}>
                          {localesN.length} marcado{localesN.length !== 1 ? 's' : ''}
                        </Text>
                      </View>
                      <ScrollView style={styles.dropdownScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {localesParipe.map((loc) => {
                          const on = localesN.includes(loc.id_Locales);
                          return (
                            <TouchableOpacity
                              key={loc.id_Locales}
                              style={[styles.dropdownOption, on && styles.dropdownOptionSelected]}
                              onPress={() => toggleLocalGenerar(loc.id_Locales)}
                              activeOpacity={0.7}
                            >
                              <MaterialIcons
                                name={on ? 'check-box' : 'check-box-outline-blank'}
                                size={20}
                                color={on ? '#0ea5e9' : '#94a3b8'}
                                style={{ marginRight: 10 }}
                              />
                              <Text style={[styles.dropdownOptionText, on && styles.dropdownOptionTextSelected]} numberOfLines={2}>
                                {loc.nombre || loc.id_Locales}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>
                    </View>
                  ) : null}
                </View>
              )}
              <Text style={styles.label}>Horas</Text>
              {horasN.map((h, idx) => (
                <View key={idx} style={styles.horaRow}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    value={h}
                    onChangeText={(t) => {
                      const n = [...horasN];
                      n[idx] = t;
                      setHorasN(n);
                    }}
                    placeholder="16:00"
                  />
                  <TouchableOpacity onPress={() => setHorasN(horasN.filter((_, i) => i !== idx))}>
                    <MaterialIcons name="delete-outline" size={22} color="#dc2626" />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity style={styles.addHora} onPress={() => setHorasN([...horasN, '22:00'])}>
                <Text style={styles.addHoraText}>+ Añadir hora</Text>
              </TouchableOpacity>
              <Pressable
                style={[styles.saveBtn, generando && styles.saveBtnDis]}
                onPress={confirmarGenerarBase}
                disabled={generando}
              >
                {generando ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Generar registros</Text>}
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={modalAsoc} transparent animationType="fade" onRequestClose={() => setModalAsoc(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pago asociado</Text>
              <TouchableOpacity onPress={() => setModalAsoc(false)}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <View style={styles.modalBodyPadded}>
              <TextInput
                style={styles.input}
                placeholder="Buscar número, proveedor, CIF…"
                value={qFac}
                onChangeText={setQFac}
                onSubmitEditing={buscarFacturas}
              />
              <TouchableOpacity style={styles.fBtn} onPress={buscarFacturas}>
                <Text style={styles.fBtnText}>Buscar facturas músicos</Text>
              </TouchableOpacity>
              {loadingFac ? <ActivityIndicator color="#0ea5e9" style={{ marginVertical: 12 }} /> : null}
              <ScrollView style={{ maxHeight: 280 }}>
                {facturas.map((f) => (
                  <TouchableOpacity
                    key={f.id_factura}
                    style={[styles.facRow, elegida?.id_factura === f.id_factura && styles.facRowOn]}
                    onPress={() => setElegida(f)}
                  >
                    <Text style={styles.facTitle}>{f.numero_factura || '—'} · {f.proveedor}</Text>
                    <Text style={styles.facSub}>
                      {String(f.fecha_emision).slice(0, 10)} · {formatMoneda(f.total_factura)} · {labelEstado(f.estado)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity style={styles.saveBtn} onPress={confirmarAsociacion}>
                <Text style={styles.saveBtnText}>Confirmar asociación</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={modalEdit} transparent animationType="fade" onRequestClose={cerrarModalEdit}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Editar actuación</Text>
              <TouchableOpacity onPress={cerrarModalEdit}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>Artista</Text>
              <View style={styles.editArtistaDropdownWrap}>
                <TouchableOpacity
                  style={styles.editDropdownTrigger}
                  onPress={() => setArtistaEditDropdownOpen((v) => !v)}
                  activeOpacity={0.75}
                >
                  <Text style={styles.editDropdownTriggerText} numberOfLines={2}>
                    {!form.id_artista
                      ? '(sin asignar)'
                      : artistas.find((a) => a.id_artista === form.id_artista)?.nombre_artistico ||
                        form.artista_nombre_snapshot?.trim() ||
                        form.id_artista}
                  </Text>
                  <MaterialIcons name={artistaEditDropdownOpen ? 'expand-less' : 'expand-more'} size={22} color="#64748b" />
                </TouchableOpacity>
                {artistaEditDropdownOpen ? (
                  <View style={styles.editDropdownList}>
                    <ScrollView
                      style={styles.editDropdownScroll}
                      nestedScrollEnabled
                      keyboardShouldPersistTaps="handled"
                    >
                      <TouchableOpacity
                        style={[styles.editDropdownOpt, !form.id_artista && styles.editDropdownOptOn]}
                        onPress={() => {
                          setForm((f) => ({
                            ...f,
                            id_artista: '',
                            artista_nombre_snapshot: '',
                            importe_previsto: null,
                            importe_final: null,
                            franja: undefined,
                            tipo_dia: undefined,
                          }));
                          setArtistaEditDropdownOpen(false);
                        }}
                      >
                        <Text style={styles.editDropdownOptText}>(sin asignar)</Text>
                        {!form.id_artista ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                      </TouchableOpacity>
                      {artistas.map((ar) => {
                        const sel = form.id_artista === ar.id_artista;
                        return (
                          <TouchableOpacity
                            key={ar.id_artista}
                            style={[styles.editDropdownOpt, sel && styles.editDropdownOptOn]}
                            onPress={() => {
                              setForm((f) => ({
                                ...f,
                                id_artista: ar.id_artista,
                                artista_nombre_snapshot: ar.nombre_artistico,
                              }));
                              setArtistaEditDropdownOpen(false);
                            }}
                          >
                            <Text style={styles.editDropdownOptText} numberOfLines={2}>
                              {ar.nombre_artistico}
                            </Text>
                            {sel ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
                ) : null}
              </View>
              <Text style={styles.label}>Fecha</Text>
              <FechaInputDmy
                style={styles.input}
                valueIso={form.fecha || ''}
                onChangeIso={(iso) => setForm((f) => ({ ...f, fecha: iso }))}
              />
              <Text style={styles.label}>Hora inicio</Text>
              <TextInput
                style={styles.input}
                value={form.hora_inicio || ''}
                onChangeText={(t) => setForm((f) => ({ ...f, hora_inicio: t }))}
              />
              <Text style={styles.hintImporte}>
                El importe se calcula al elegir artista, fecha y hora. Puedes cambiarlo; se marca en rojo si supera el
                sugerido y en verde si es inferior.
              </Text>
              <Text style={styles.label}>Importe (editable)</Text>
              {form.importe_previsto != null ? (
                <Text style={styles.importeSugeridoLine}>
                  Sugerido (tarifa): <Text style={styles.importeSugeridoVal}>{formatMoneda(form.importe_previsto)}</Text>
                </Text>
              ) : null}
              <TextInput
                style={[
                  styles.input,
                  importeComparacion === 'mayor' && styles.importeInputMayor,
                  importeComparacion === 'menor' && styles.importeInputMenor,
                ]}
                keyboardType="decimal-pad"
                value={
                  form.importe_final != null
                    ? String(form.importe_final)
                    : form.importe_previsto != null
                      ? String(form.importe_previsto)
                      : ''
                }
                onChangeText={(t) => {
                  const s = t.replace(',', '.').trim();
                  if (s === '') {
                    setForm((f) => ({ ...f, importe_final: null }));
                    return;
                  }
                  const n = parseFloat(s);
                  setForm((f) => ({
                    ...f,
                    importe_final: Number.isNaN(n) ? null : n,
                  }));
                }}
              />
              <Text style={styles.label}>Local</Text>
              <Text style={styles.localReadonly}>{form.local_nombre_snapshot || form.id_local || '—'}</Text>
              <Text style={styles.label}>Observaciones</Text>
              <TextInput
                style={[styles.input, { minHeight: 64 }]}
                multiline
                value={form.observaciones || ''}
                onChangeText={(t) => setForm((f) => ({ ...f, observaciones: t }))}
              />
              <View style={styles.firmaRow}>
                <TouchableOpacity
                  style={[styles.firmaBtnHalf, !form.id_actuacion && styles.firmaBtnDis]}
                  onPress={() => form.id_actuacion && setModalFirma(true)}
                  disabled={!form.id_actuacion}
                  activeOpacity={0.82}
                >
                  <MaterialIcons name="draw" size={22} color={form.id_actuacion ? '#0369a1' : '#94a3b8'} />
                  <Text style={[styles.firmaBtnHalfTitle, !form.id_actuacion && styles.firmaBtnTitleDis]}>
                    Firmar en pantalla
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.firmaBtnHalf, !form.id_actuacion && styles.firmaBtnDis]}
                  onPress={() => form.id_actuacion && subirFirmaArchivo(form.id_actuacion)}
                  disabled={!form.id_actuacion}
                  activeOpacity={0.82}
                >
                  <MaterialIcons name="folder-open" size={22} color={form.id_actuacion ? '#0369a1' : '#94a3b8'} />
                  <Text style={[styles.firmaBtnHalfTitle, !form.id_actuacion && styles.firmaBtnTitleDis]}>
                    Subir imagen
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.firmaBtnHint}>
                Dibuja la firma en el recuadro o elige un archivo PNG/JPG desde el dispositivo.
              </Text>
              <Pressable style={[styles.saveBtn, saving && styles.saveBtnDis]} onPress={guardarEdicion} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Guardar</Text>}
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={conflictoOpen} transparent animationType="fade" onRequestClose={() => setConflictoOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.conflictoCard}>
            <MaterialIcons name="warning" size={40} color="#f59e0b" style={{ alignSelf: 'center' }} />
            <Text style={styles.conflictoTitle}>Conflicto de artista detectado</Text>
            <Text style={styles.conflictoText}>
              Este artista ya tiene otra actuación asignada en esa fecha y franja horaria.
            </Text>
            {conflictoOtro ? (
              <View style={styles.conflictoBox}>
                <Text style={styles.conflictoSub}>Registro existente</Text>
                <Text style={styles.conflictoDetail}>{conflictoOtro.artista_nombre_snapshot || conflictoOtro.id_artista}</Text>
                <Text style={styles.conflictoDetail}>{formatFecha(conflictoOtro.fecha)} · {conflictoOtro.hora_inicio}</Text>
                <Text style={styles.conflictoDetail}>{conflictoOtro.local_nombre_snapshot || conflictoOtro.id_local}</Text>
                <Text style={styles.conflictoDetail}>Estado: {conflictoOtro.estado} · id: {conflictoOtro.id_actuacion.slice(0, 8)}…</Text>
              </View>
            ) : null}
            {form.fecha ? (
              <View style={styles.conflictoBox}>
                <Text style={styles.conflictoSub}>Registro actual</Text>
                <Text style={styles.conflictoDetail}>{formatFecha(form.fecha)} · {form.hora_inicio}</Text>
                <Text style={styles.conflictoDetail}>{form.local_nombre_snapshot || form.id_local}</Text>
              </View>
            ) : null}
            <View style={styles.conflictoBtns}>
              <TouchableOpacity style={styles.cbCancel} onPress={() => { setConflictoOpen(false); setPendingPutBody(null); }}>
                <Text style={styles.cbCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.cbPrimary} onPress={conflictoGuardarIgual}>
                <Text style={styles.cbPrimaryText}>Guardar igualmente</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.cbMover} onPress={conflictoMoverAqui}>
              <Text style={styles.cbMoverText}>Mover artista aquí</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <FirmaEnPantallaModal
        visible={modalFirma}
        uploading={firmaSubiendo}
        onClose={() => {
          if (!firmaSubiendo) setModalFirma(false);
        }}
        onConfirm={(base64Png) => {
          if (form.id_actuacion) void enviarFirmaDesdePantalla(form.id_actuacion, base64Png);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screenWrap: { flex: 1, backgroundColor: '#f8fafc' },
  filtersWrap: { flexDirection: 'column', gap: 8, flex: 1, minWidth: 0, width: '100%' },
  filtersRowTop: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  filtersRowBottom: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    width: '100%',
  },
  fInputEstado: { flex: 1, minWidth: 160, maxWidth: 360 },
  filterLabelInline: { fontSize: 11, fontWeight: '700', color: '#64748b', marginRight: -2 },
  filterLocalDropdownWrap: { minWidth: 140, maxWidth: 220, flexGrow: 1, flexShrink: 1, zIndex: 10 },
  filterToolbarTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  filterToolbarTriggerText: { fontSize: 12, color: '#334155', flex: 1, paddingRight: 6 },
  filterToolbarList: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '100%',
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#fff',
    maxHeight: 200,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
  },
  filterToolbarScroll: { maxHeight: 200 },
  filterToolbarOpt: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f5f9',
  },
  filterToolbarOptOn: { backgroundColor: '#f0f9ff' },
  filterToolbarOptText: { fontSize: 12, color: '#334155', flex: 1, paddingRight: 8 },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginRight: 6,
    backgroundColor: '#fff',
  },
  filterChipOn: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  filterChipText: { fontSize: 11, color: '#334155', maxWidth: 120 },
  fInputFecha: { width: 118, minWidth: 118 },
  fInput: {
    width: 100,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === 'ios' ? 8 : 4,
    fontSize: 12,
  },
  fBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f1f5f9', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  fBtnText: { color: '#0369a1', fontWeight: '600', fontSize: 12 },
  toolbarRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  asocBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#059669', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  asocBtnOff: { opacity: 0.45 },
  asocBtnText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  refreshBtn: { padding: 6, borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0' },
  selCell: { alignItems: 'center', justifyContent: 'center' },
  cellMoney: { fontSize: 11, color: '#334155', textAlign: 'right' },
  cellMuted: { color: '#94a3b8' },
  cellSmall: { fontSize: 11, color: '#475569' },
  huecoBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#ffedd5',
    borderWidth: 1,
    borderColor: '#fdba74',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  huecoBadgeText: { fontSize: 8, fontWeight: '700', color: '#9a3412', lineHeight: 11 },
  editArtistaDropdownWrap: { marginBottom: 4, zIndex: 30, position: 'relative' },
  editDropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  editDropdownTriggerText: { fontSize: 14, color: '#334155', flex: 1, paddingRight: 8 },
  editDropdownList: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    maxHeight: 220,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  editDropdownScroll: { maxHeight: 220 },
  editDropdownOpt: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f5f9',
  },
  editDropdownOptOn: { backgroundColor: '#f0f9ff' },
  editDropdownOptText: { fontSize: 14, color: '#334155', flex: 1, paddingRight: 8 },
  firmaRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
    alignItems: 'stretch',
  },
  firmaBtnHalf: {
    flex: 1,
    minHeight: 72,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#7dd3fc',
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: 4,
  },
  firmaBtnHalfTitle: { fontSize: 13, fontWeight: '700', color: '#0369a1', textAlign: 'center' },
  firmaBtnDis: { opacity: 0.55, borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  firmaBtnTitle: { fontSize: 15, fontWeight: '700', color: '#0369a1', textAlign: 'center' },
  firmaBtnTitleDis: { color: '#94a3b8' },
  firmaBtnHint: { fontSize: 11, color: '#64748b', textAlign: 'center', marginTop: 8 },
  hintImporte: { fontSize: 10, color: '#94a3b8', lineHeight: 14, marginTop: 6, marginBottom: 2 },
  importeSugeridoLine: { fontSize: 11, color: '#64748b', marginBottom: 4, marginTop: 2 },
  importeSugeridoVal: { fontWeight: '700', color: '#334155' },
  importeInputMayor: { borderColor: '#ef4444', color: '#dc2626', backgroundColor: '#fef2f2' },
  importeInputMenor: { borderColor: '#22c55e', color: '#16a34a', backgroundColor: '#f0fdf4' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    backgroundColor: '#fff',
    borderRadius: 14,
    maxHeight: '92%',
    overflow: 'hidden',
  },
  modalBodyPadded: { paddingHorizontal: 16, paddingBottom: 16 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#334155' },
  modalScroll: { padding: 16, maxHeight: 480 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 4, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    backgroundColor: '#f8fafc',
    color: '#334155',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginRight: 6,
  },
  fieldDropdown: { marginBottom: 4, zIndex: 2 },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  dropdownTriggerText: { fontSize: 14, color: '#334155', flex: 1, paddingRight: 8 },
  dropdownPlaceholder: { color: '#94a3b8' },
  dropdownList: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  dropdownToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  dropdownCount: { fontSize: 11, color: '#64748b' },
  dropdownScroll: { maxHeight: 220 },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f5f9',
  },
  dropdownOptionSelected: { backgroundColor: '#f0f9ff' },
  dropdownOptionText: { fontSize: 13, color: '#334155', flex: 1 },
  dropdownOptionTextSelected: { color: '#0369a1', fontWeight: '600' },
  localesGenLink: { fontSize: 12, fontWeight: '600', color: '#0369a1' },
  localesGenSep: { color: '#94a3b8', fontSize: 12 },
  chipOn: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  chipText: { fontSize: 11, color: '#334155' },
  horaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  addHora: { padding: 10, alignItems: 'center' },
  addHoraText: { color: '#0ea5e9', fontWeight: '600', fontSize: 13 },
  hint: { fontSize: 11, color: '#94a3b8', marginBottom: 8 },
  saveBtn: { backgroundColor: '#0ea5e9', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 16 },
  saveBtnDis: { opacity: 0.6 },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  facRow: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  facRowOn: { backgroundColor: '#e0f2fe' },
  facTitle: { fontSize: 13, fontWeight: '600', color: '#334155' },
  facSub: { fontSize: 11, color: '#64748b', marginTop: 2 },
  localReadonly: { fontSize: 14, color: '#64748b', paddingVertical: 8 },
  conflictoCard: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 20,
    alignSelf: 'center',
  },
  conflictoTitle: { fontSize: 17, fontWeight: '700', color: '#334155', textAlign: 'center', marginTop: 8 },
  conflictoText: { fontSize: 14, color: '#64748b', textAlign: 'center', marginTop: 8, lineHeight: 20 },
  conflictoBox: { marginTop: 12, padding: 12, backgroundColor: '#f8fafc', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  conflictoSub: { fontSize: 11, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: 6 },
  conflictoDetail: { fontSize: 13, color: '#334155', marginBottom: 4 },
  conflictoBtns: { flexDirection: 'row', gap: 10, marginTop: 16, justifyContent: 'flex-end', flexWrap: 'wrap' },
  cbCancel: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  cbCancelText: { color: '#475569', fontWeight: '600' },
  cbPrimary: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, backgroundColor: '#0ea5e9' },
  cbPrimaryText: { color: '#fff', fontWeight: '700' },
  cbMover: { marginTop: 10, paddingVertical: 12, alignItems: 'center', borderRadius: 8, borderWidth: 1, borderColor: '#f59e0b', backgroundColor: '#fffbeb' },
  cbMoverText: { color: '#b45309', fontWeight: '700' },
});
