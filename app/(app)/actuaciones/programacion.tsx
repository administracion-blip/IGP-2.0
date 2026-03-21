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
import { ActuacionesCalendario } from '../../components/actuaciones/ActuacionesCalendario';
import { FirmaEnPantallaModal } from '../../components/FirmaEnPantallaModal';
import { buildFirmaFormData } from '../../utils/uploadFirmaPng';
import { empresaTieneEtiquetaMusicos } from '../../utils/etiquetaMusicos';

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
  /** Clave S3 de la imagen de firma (vacío si no hay firma) */
  firma_artista_key?: string;
  fecha_firma?: string;
};

type FacturaOpt = {
  id_factura: string;
  numero_factura: string;
  proveedor: string;
  fecha_emision: string;
  total_factura: number;
  base_imponible?: number | null;
  empresa_id?: string;
  estado: string;
};

type LocalOpt = { id_Locales: string; nombre?: string; sede?: string };

const COLUMNAS = ['Sel', 'Fecha', 'Hora', 'Local', 'Artista', 'Importe', 'Estado', 'Firma', 'Pago'] as const;

/** true si la fecha de actuación (ISO) es hoy o anterior (no futura) */
function fechaActuacionPermiteFirma(fechaIso: string | undefined): boolean {
  if (!fechaIso || fechaIso.length < 10) return false;
  const actuacion = fechaIso.slice(0, 10);
  const ahora = new Date();
  const y = ahora.getFullYear();
  const m = String(ahora.getMonth() + 1).padStart(2, '0');
  const d = String(ahora.getDate()).padStart(2, '0');
  const hoy = `${y}-${m}-${d}`;
  return actuacion <= hoy;
}

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
    case 'Firma':
      return a.firma_artista_key?.trim() ? 'Sí' : 'No';
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
  /** Vacío = todos los locales; si no, solo actuaciones de esos ids */
  const [filtroLocalesIds, setFiltroLocalesIds] = useState<string[]>([]);

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
  /** Filtro opcional por empresa (proveedor con etiqueta MUSICOS) */
  const [empresaAsocId, setEmpresaAsocId] = useState('');
  const [asocEmpresaDropdownOpen, setAsocEmpresaDropdownOpen] = useState(false);
  const [qProveedorAsoc, setQProveedorAsoc] = useState('');
  const [empresasMusicos, setEmpresasMusicos] = useState<{ id_empresa: string; nombre: string; cif: string }[]>([]);
  const [loadingEmpresasAsoc, setLoadingEmpresasAsoc] = useState(false);

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

  const mostrarSeccionFirma = useMemo(
    () =>
      !!(
        form.id_actuacion &&
        form.id_artista?.trim() &&
        fechaActuacionPermiteFirma(form.fecha)
      ),
    [form.id_actuacion, form.id_artista, form.fecha]
  );

  useEffect(() => {
    if (!mostrarSeccionFirma && modalFirma) setModalFirma(false);
  }, [mostrarSeccionFirma, modalFirma]);

  const resumenLocalesGen = useMemo(() => {
    if (localesN.length === 0) return '';
    if (localesN.length === 1) {
      const loc = localesParipe.find((l) => l.id_Locales === localesN[0]);
      return loc?.nombre?.trim() || localesN[0];
    }
    return `${localesN.length} locales seleccionados`;
  }, [localesN, localesParipe]);

  const textoFiltroLocal = useMemo(() => {
    if (filtroLocalesIds.length === 0) return 'Todos los locales';
    if (filtroLocalesIds.length === 1) {
      const loc = localesParipe.find((l) => l.id_Locales === filtroLocalesIds[0]);
      return loc?.nombre?.trim() || filtroLocalesIds[0];
    }
    return `${filtroLocalesIds.length} locales`;
  }, [filtroLocalesIds, localesParipe]);

  /** Suma importes (final o previsto) de las actuaciones marcadas en Sel */
  const sumaImportesSeleccionadas = useMemo(() => {
    let s = 0;
    let any = false;
    for (const a of actuaciones) {
      if (!selectedIds.has(a.id_actuacion)) continue;
      const v =
        a.importe_final != null && !Number.isNaN(Number(a.importe_final))
          ? Number(a.importe_final)
          : a.importe_previsto != null && !Number.isNaN(Number(a.importe_previsto))
            ? Number(a.importe_previsto)
            : null;
      if (v != null) {
        s += v;
        any = true;
      }
    }
    return any ? s : null;
  }, [actuaciones, selectedIds]);

  const comparacionAsoc = useMemo(() => {
    if (sumaImportesSeleccionadas == null || elegida == null) return null;
    const base = elegida.base_imponible;
    if (base == null || Number.isNaN(Number(base))) return null;
    const diff = sumaImportesSeleccionadas - Number(base);
    const ok = Math.abs(diff) < 0.02;
    return { diff, ok };
  }, [sumaImportesSeleccionadas, elegida]);

  const empresasMusicosFiltradas = useMemo(() => {
    const q = qProveedorAsoc.trim().toLowerCase();
    if (!q) return empresasMusicos;
    return empresasMusicos.filter(
      (e) =>
        e.nombre.toLowerCase().includes(q) ||
        (e.cif && e.cif.toLowerCase().includes(q)) ||
        e.id_empresa.toLowerCase().includes(q),
    );
  }, [empresasMusicos, qProveedorAsoc]);

  function toggleFiltroLocal(id: string) {
    setFiltroLocalesIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  }

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
    if (filtroLocalesIds.length > 0) qs.set('id_locales', filtroLocalesIds.join(','));
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
  }, [fechaDesde, fechaHasta, filtroLocalesIds]);

  const buscarFacturas = useCallback(async () => {
    if (!empresaAsocId.trim()) {
      setFacturas([]);
      setLoadingFac(false);
      return;
    }
    setLoadingFac(true);
    try {
      const qs = new URLSearchParams();
      if (qFac.trim()) qs.set('q', qFac.trim());
      qs.set('empresa_id', empresaAsocId.trim());
      const r = await fetch(`${API_URL}/api/actuaciones/facturas-gasto-asociables?${qs}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      setFacturas(d.facturas || []);
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setLoadingFac(false);
    }
  }, [qFac, empresaAsocId, showToast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!modalAsoc) return;
    void buscarFacturas();
  }, [modalAsoc, buscarFacturas]);

  useEffect(() => {
    if (!modalAsoc) return;
    setLoadingEmpresasAsoc(true);
    fetch(`${API_URL}/api/empresas`)
      .then((r) => r.json())
      .then((d) => {
        const raw = (d.empresas || []) as {
          id_empresa?: string;
          Nombre?: string;
          Cif?: string;
          Etiqueta?: unknown;
        }[];
        const filtradas = raw
          .filter((e) => empresaTieneEtiquetaMusicos(e.Etiqueta))
          .map((e) => ({
            id_empresa: String(e.id_empresa ?? '').trim(),
            nombre: String(e.Nombre ?? '').trim() || String(e.id_empresa ?? ''),
            cif: String(e.Cif ?? '').trim(),
          }))
          .filter((e) => e.id_empresa !== '');
        filtradas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
        setEmpresasMusicos(filtradas);
      })
      .catch(() => setEmpresasMusicos([]))
      .finally(() => setLoadingEmpresasAsoc(false));
  }, [modalAsoc]);

  const empresaAsocInitRef = useRef(false);
  /** Al cambiar de proveedor, quitar factura elegida; el listado se recarga vía `buscarFacturas` (deps del efecto del modal). */
  useEffect(() => {
    if (!modalAsoc) {
      empresaAsocInitRef.current = false;
      return;
    }
    if (!empresaAsocInitRef.current) {
      empresaAsocInitRef.current = true;
      return;
    }
    setElegida(null);
  }, [empresaAsocId, modalAsoc]);

  function cerrarModalAsoc() {
    setModalAsoc(false);
    setElegida(null);
    setQFac('');
    setQProveedorAsoc('');
    setEmpresaAsocId('');
    setAsocEmpresaDropdownOpen(false);
  }

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
      cerrarModalAsoc();
      setSelectedIds(new Set());
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
          if (col === 'Firma') return { cell: { width: 56, minWidth: 52, maxWidth: 60 } };
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
          if (col === 'Firma') {
            const ok = !!item.firma_artista_key?.trim();
            return (
              <View style={styles.firmaCell}>
                <MaterialIcons
                  name={ok ? 'check-circle' : 'radio-button-unchecked'}
                  size={12}
                  color={ok ? '#16a34a' : '#cbd5e1'}
                />
                <Text style={[styles.firmaBadgeText, ok ? styles.firmaSi : styles.firmaNo]} numberOfLines={1}>
                  {ok ? 'Sí' : 'No'}
                </Text>
              </View>
            );
          }
          if (col === 'Pago') {
            const t = item.pago_asociado_numero_factura || item.id_factura_gasto;
            return <Text style={styles.cellSmall} numberOfLines={1}>{t ? String(t).slice(0, 14) + (String(t).length > 14 ? '…' : '') : '—'}</Text>;
          }
          return null;
        }}
        hideSearch
        extraToolbarLeft={
          <View style={styles.filtersWrap}>
            <View style={styles.filtersRowTop}>
              <View style={styles.toolbarSearchWrap}>
                <MaterialIcons name="search" size={18} color="#64748b" style={styles.toolbarSearchIcon} />
                <TextInput
                  style={styles.toolbarSearchInput}
                  value={filtroBusqueda}
                  onChangeText={setFiltroBusqueda}
                  placeholder="Buscar en la tabla…"
                  placeholderTextColor="#94a3b8"
                />
              </View>
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
                        style={[styles.filterToolbarOpt, filtroLocalesIds.length === 0 && styles.filterToolbarOptOn]}
                        onPress={() => {
                          setFiltroLocalesIds([]);
                        }}
                      >
                        <Text style={styles.filterToolbarOptText}>Todos los locales</Text>
                        {filtroLocalesIds.length === 0 ? (
                          <MaterialIcons name="check-box" size={18} color="#0ea5e9" />
                        ) : (
                          <MaterialIcons name="check-box-outline-blank" size={18} color="#94a3b8" />
                        )}
                      </TouchableOpacity>
                      {localesParipe.map((loc) => {
                        const sel = filtroLocalesIds.includes(loc.id_Locales);
                        return (
                          <TouchableOpacity
                            key={loc.id_Locales}
                            style={[styles.filterToolbarOpt, sel && styles.filterToolbarOptOn]}
                            onPress={() => toggleFiltroLocal(loc.id_Locales)}
                          >
                            <Text style={styles.filterToolbarOptText} numberOfLines={2}>
                              {loc.nombre || loc.id_Locales}
                            </Text>
                            <MaterialIcons
                              name={sel ? 'check-box' : 'check-box-outline-blank'}
                              size={18}
                              color={sel ? '#0ea5e9' : '#94a3b8'}
                            />
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
        rightPanel={<ActuacionesCalendario actuaciones={actuaciones} />}
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

      <Modal visible={modalAsoc} transparent animationType="fade" onRequestClose={cerrarModalAsoc}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pago asociado</Text>
              <TouchableOpacity onPress={cerrarModalAsoc}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <View style={styles.modalBodyPadded}>
              <Text style={styles.label}>Proveedor (etiqueta MUSICOS)</Text>
              <View style={styles.asocEmpresaDropdownWrap}>
                <TouchableOpacity
                  style={styles.asocDropdownTrigger}
                  onPress={() => setAsocEmpresaDropdownOpen((v) => !v)}
                  activeOpacity={0.75}
                >
                  <View style={styles.asocTriggerTextCol}>
                    <Text style={styles.asocDropdownTriggerText} numberOfLines={1}>
                      {empresaAsocId
                        ? empresasMusicos.find((e) => e.id_empresa === empresaAsocId)?.nombre || empresaAsocId
                        : 'Selecciona proveedor…'}
                    </Text>
                    {empresaAsocId ? (
                      <Text style={styles.asocTriggerCif} numberOfLines={1}>
                        {empresasMusicos.find((e) => e.id_empresa === empresaAsocId)?.cif || ''}
                      </Text>
                    ) : null}
                  </View>
                  <MaterialIcons name={asocEmpresaDropdownOpen ? 'expand-less' : 'expand-more'} size={20} color="#64748b" />
                </TouchableOpacity>
                {asocEmpresaDropdownOpen ? (
                  <View style={styles.asocDropdownList}>
                    <TextInput
                      style={styles.asocProveedorSearch}
                      placeholder="Buscar por nombre o CIF…"
                      placeholderTextColor="#94a3b8"
                      value={qProveedorAsoc}
                      onChangeText={setQProveedorAsoc}
                    />
                    <ScrollView style={styles.asocDropdownScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {loadingEmpresasAsoc ? (
                        <View style={styles.asocDropdownOpt}>
                          <ActivityIndicator color="#0ea5e9" />
                        </View>
                      ) : empresasMusicosFiltradas.length === 0 ? (
                        <View style={styles.asocDropdownOpt}>
                          <Text style={styles.asocDropdownOptHint}>Ningún proveedor coincide</Text>
                        </View>
                      ) : (
                        empresasMusicosFiltradas.map((e) => {
                          const sel = empresaAsocId === e.id_empresa;
                          return (
                            <TouchableOpacity
                              key={e.id_empresa}
                              style={[styles.asocDropdownOpt, sel && styles.asocDropdownOptOn]}
                              onPress={() => {
                                setEmpresaAsocId(e.id_empresa);
                                setAsocEmpresaDropdownOpen(false);
                                setQProveedorAsoc('');
                              }}
                            >
                              <View style={styles.asocDropdownOptCol}>
                                <Text style={styles.asocDropdownOptText} numberOfLines={2}>
                                  {e.nombre}
                                </Text>
                                {e.cif ? <Text style={styles.asocDropdownCif}>{e.cif}</Text> : null}
                              </View>
                              {sel ? <MaterialIcons name="check" size={16} color="#0ea5e9" /> : null}
                            </TouchableOpacity>
                          );
                        })
                      )}
                    </ScrollView>
                  </View>
                ) : null}
              </View>

              <Text style={[styles.label, { marginTop: 12 }]}>Facturas recibidas pendientes (según proveedor)</Text>
              <View style={styles.asocFacListBox}>
                {!empresaAsocId ? (
                  <Text style={styles.asocFacListEmpty}>
                    Elige un proveedor arriba para cargar sus facturas pendientes de pago o revisión.
                  </Text>
                ) : (
                  <>
                    <View style={styles.asocFacSearchRow}>
                      <TextInput
                        style={styles.asocFacSearchInput}
                        placeholder="Filtrar nº, CIF…"
                        placeholderTextColor="#94a3b8"
                        value={qFac}
                        onChangeText={setQFac}
                        onSubmitEditing={buscarFacturas}
                      />
                      <TouchableOpacity style={styles.asocFacSearchBtn} onPress={buscarFacturas}>
                        <Text style={styles.asocFacSearchBtnText}>Buscar</Text>
                      </TouchableOpacity>
                    </View>
                    {loadingFac ? <ActivityIndicator color="#0ea5e9" style={{ marginVertical: 10 }} /> : null}
                    <ScrollView style={styles.asocFacScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {facturas.length === 0 && !loadingFac ? (
                        <Text style={styles.asocFacListEmpty}>No hay facturas pendientes para este proveedor.</Text>
                      ) : (
                        facturas.map((f) => (
                          <TouchableOpacity
                            key={f.id_factura}
                            style={[styles.facRow, elegida?.id_factura === f.id_factura && styles.facRowOn]}
                            onPress={() => setElegida(f)}
                          >
                            <Text style={styles.facTitle}>{f.numero_factura || '—'} · {f.proveedor}</Text>
                            <Text style={styles.facSub}>
                              {String(f.fecha_emision).slice(0, 10)} · Total {formatMoneda(f.total_factura)}
                              {f.base_imponible != null && !Number.isNaN(Number(f.base_imponible))
                                ? ` · Base ${formatMoneda(Number(f.base_imponible))}`
                                : ''}{' '}
                              · {labelEstado(f.estado)}
                            </Text>
                          </TouchableOpacity>
                        ))
                      )}
                    </ScrollView>
                  </>
                )}
              </View>

              <View style={styles.asocCompareBox}>
                <Text style={styles.asocCompareTitle}>Importes seleccionados</Text>
                <View style={styles.asocCompareRow}>
                  <Text style={styles.asocCompareLabel}>Suma actuaciones (Sel)</Text>
                  <Text style={styles.asocCompareVal}>
                    {sumaImportesSeleccionadas != null ? formatMoneda(sumaImportesSeleccionadas) : '—'}
                  </Text>
                </View>
                {elegida ? (
                  <>
                    <View style={styles.asocCompareRow}>
                      <Text style={styles.asocCompareLabel}>Base imponible factura</Text>
                      <Text style={styles.asocCompareVal}>
                        {elegida.base_imponible != null && !Number.isNaN(Number(elegida.base_imponible))
                          ? formatMoneda(Number(elegida.base_imponible))
                          : '—'}
                      </Text>
                    </View>
                    {comparacionAsoc ? (
                      <Text
                        style={[
                          styles.asocCompareDiff,
                          comparacionAsoc.ok ? styles.asocCompareOk : styles.asocCompareWarn,
                        ]}
                      >
                        Diferencia (actuaciones − base){' '}
                        {formatMoneda(comparacionAsoc.diff)}
                        {comparacionAsoc.ok ? ' · Coincide' : ''}
                      </Text>
                    ) : elegida.base_imponible == null ? (
                      <Text style={styles.asocCompareHint}>La factura no tiene base imponible registrada.</Text>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.asocCompareHint}>
                    {empresaAsocId
                      ? 'Elige una factura en el listado superior para comparar con la base imponible.'
                      : 'Selecciona proveedor y una factura para comparar importes.'}
                  </Text>
                )}
              </View>

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
              {mostrarSeccionFirma ? (
                <>
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
                </>
              ) : form.id_actuacion && (!form.id_artista?.trim() || !fechaActuacionPermiteFirma(form.fecha)) ? (
                <Text style={styles.firmaBloqueadaHint}>
                  {!form.id_artista?.trim()
                    ? 'Asigna un artista para poder registrar la firma.'
                    : 'La firma solo está disponible cuando la fecha de la actuación sea hoy o una fecha pasada (no futura).'}
                </Text>
              ) : null}
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
  filtersWrap: { flexDirection: 'column', gap: 8, flex: 1, minWidth: 0, width: '100%', overflow: 'visible', zIndex: 1 },
  filtersRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    width: '100%',
  },
  toolbarSearchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 140,
    maxWidth: 320,
    height: 32,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
  },
  toolbarSearchIcon: { marginRight: 6 },
  toolbarSearchInput: { flex: 1, fontSize: 12, color: '#334155', paddingVertical: 0 },
  filtersRowBottom: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    width: '100%',
  },
  filterLabelInline: { fontSize: 11, fontWeight: '700', color: '#64748b', marginRight: -2 },
  filterLocalDropdownWrap: {
    minWidth: 140,
    maxWidth: 220,
    flexGrow: 1,
    flexShrink: 1,
    zIndex: 9998,
    elevation: 24,
    overflow: 'visible',
  },
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
    maxHeight: 220,
    zIndex: 10000,
    elevation: 28,
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
  firmaBloqueadaHint: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 10,
    lineHeight: 18,
    fontStyle: 'italic',
  },
  firmaCell: { flexDirection: 'row', alignItems: 'center', gap: 2, justifyContent: 'center' },
  firmaBadgeText: { fontSize: 8, lineHeight: 10 },
  firmaSi: { color: '#15803d', fontWeight: '700' },
  firmaNo: { color: '#94a3b8', fontWeight: '600' },
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
  asocEmpresaDropdownWrap: { marginBottom: 4, zIndex: 5 },
  asocTriggerTextCol: { flex: 1, paddingRight: 8, minWidth: 0 },
  asocTriggerCif: { fontSize: 11, color: '#0ea5e9', fontWeight: '600', marginTop: 2 },
  asocDropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  asocDropdownTriggerText: { fontSize: 13, color: '#334155', flex: 1, paddingRight: 8 },
  asocProveedorSearch: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    backgroundColor: '#fff',
    color: '#334155',
  },
  asocDropdownList: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    maxHeight: 200,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  asocDropdownScroll: { maxHeight: 132 },
  asocDropdownOpt: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f5f9',
  },
  asocDropdownOptCol: { flex: 1, minWidth: 0, paddingRight: 6 },
  asocDropdownCif: { fontSize: 10, color: '#0ea5e9', fontWeight: '600', marginTop: 2 },
  asocDropdownOptOn: { backgroundColor: '#f0f9ff' },
  asocDropdownOptText: { fontSize: 12, color: '#334155' },
  asocDropdownOptHint: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  asocFacListBox: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#fafafa',
    padding: 8,
    minHeight: 120,
  },
  asocFacListEmpty: { fontSize: 12, color: '#64748b', lineHeight: 18, paddingVertical: 8 },
  asocFacSearchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  asocFacSearchInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    backgroundColor: '#fff',
    color: '#334155',
  },
  asocFacSearchBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#e0f2fe',
  },
  asocFacSearchBtnText: { color: '#0369a1', fontWeight: '700', fontSize: 12 },
  asocFacScroll: { maxHeight: 220 },
  asocCompareBox: {
    marginTop: 12,
    marginBottom: 8,
    padding: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  asocCompareTitle: { fontSize: 11, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: 8 },
  asocCompareRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  asocCompareLabel: { fontSize: 13, color: '#475569', flex: 1 },
  asocCompareVal: { fontSize: 13, fontWeight: '700', color: '#334155' },
  asocCompareDiff: { fontSize: 12, fontWeight: '600', marginTop: 4 },
  asocCompareOk: { color: '#15803d' },
  asocCompareWarn: { color: '#c2410c' },
  asocCompareHint: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', marginTop: 4 },
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
