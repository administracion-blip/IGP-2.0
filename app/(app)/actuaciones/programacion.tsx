import { useEffect, useState, useCallback, useMemo, useRef, type ReactNode, type RefObject } from 'react';
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
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useLocalToast } from '../../components/Toast';
import { useConfirmar } from '../../hooks/useConfirmar';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { formatFecha } from '../../utils/formatFecha';
import { formatMoneda, labelEstado } from '../../utils/facturacion';
import { MIN_TOUCH } from '../../constants/layout';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';
import { ActuacionesCalendario } from '../../components/actuaciones/ActuacionesCalendario';
import { FirmaEnPantallaModal } from '../../components/FirmaEnPantallaModal';
import { buildFirmaFormData } from '../../utils/uploadFirmaPng';
import { empresaTieneEtiquetaMusicos } from '../../utils/etiquetaMusicos';
import { apiFetch } from '../../utils/api';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { fechaComparacionParaObjetivo, type FestivoGestionRow } from '../../utils/objetivosComparativa';
import {
  puedeProgramacionActuaciones,
  puedeCrearActuacion,
  puedeEditarActuacion,
  puedeBorrarActuacion,
  puedeFacturacionActuaciones,
  puedeFirmarActuacion,
} from '../../lib/permisosModulos';

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

type LocalOpt = {
  id_Locales: string;
  nombre?: string;
  sede?: string;
  agoraCode?: string;
  AgoraCode?: string;
  ratio_musicos?: number | string | null;
};

/** Campos buscables (incluye fecha/local aunque no se muestren en la fila). */
const CAMPOS_BUSQUEDA = ['Fecha', 'Local', 'Hora', 'Artista', 'Importe', 'Estado', 'Firma', 'Pago'] as const;

const MESES_NOMBRE = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
] as const;
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;
const DIAS_NOMBRE = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'] as const;

type ModoPeriodo = 'semana' | 'mes';

/** Rango ISO del mes natural (mes 1–12). */
function rangoMesCalendario(anio: number, mes: number): { from: string; to: string } {
  const m = String(mes).padStart(2, '0');
  const from = `${anio}-${m}-01`;
  const lastDay = new Date(anio, mes, 0).getDate();
  const to = `${anio}-${m}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

function sumarDiasIso(iso: string, n: number): string {
  const t = new Date(`${iso}T12:00:00.000Z`).getTime() + n * 864e5;
  return new Date(t).toISOString().slice(0, 10);
}

/** Semana lunes–domingo o mes natural que contiene `iso`. */
function rangoPeriodo(modo: ModoPeriodo, iso: string): { desde: string; hasta: string } {
  if (modo === 'semana') {
    const lunes = sumarDiasIso(iso, 1 - diaSemanaIso(iso));
    return { desde: lunes, hasta: sumarDiasIso(lunes, 6) };
  }
  const [y, m] = iso.split('-').map(Number);
  const r = rangoMesCalendario(y, m);
  return { desde: r.from, hasta: r.to };
}

function desplazarPeriodo(modo: ModoPeriodo, desde: string, delta: number): { desde: string; hasta: string } {
  if (modo === 'semana') return rangoPeriodo('semana', sumarDiasIso(desde, 7 * delta));
  const [y, m] = desde.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return rangoPeriodo('mes', `${ny}-${String(nm).padStart(2, '0')}-01`);
}

/** «Semana del 19 – 25 oct» o «Octubre 2026». */
function etiquetaPeriodo(modo: ModoPeriodo, desde: string, hasta: string): string {
  const [ya, ma, da] = desde.split('-').map(Number);
  if (modo === 'mes') return `${MESES_NOMBRE[ma - 1] ?? ''} ${ya}`;
  const [yb, mb, db] = hasta.split('-').map(Number);
  if (ya === yb && ma === mb) return `Semana del ${da} – ${db} ${MESES_CORTOS[mb - 1] ?? ''}`;
  const anioA = ya !== yb ? ` ${ya}` : '';
  const anioB = ya !== yb ? ` ${yb}` : '';
  return `Semana del ${da} ${MESES_CORTOS[ma - 1] ?? ''}${anioA} – ${db} ${MESES_CORTOS[mb - 1] ?? ''}${anioB}`;
}

/** «Miércoles 1 oct». */
function cabeceraDia(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  if (!m || !d) return iso || '—';
  return `${DIAS_NOMBRE[diaSemanaIso(iso) % 7]} ${d} ${MESES_CORTOS[m - 1] ?? ''}`;
}

type GrupoDiaLocal = {
  clave: string;
  fecha: string;
  localNombre: string;
  idLocal: string;
  items: Actuacion[];
};

/** Bloque que registra su offset vertical dentro del ScrollView y lo borra al desmontarse. */
function BloqueMedido({
  clave,
  offsets,
  onMedido,
  children,
}: {
  clave: string;
  offsets: RefObject<Record<string, number>>;
  onMedido: (clave: string) => void;
  children: ReactNode;
}) {
  useEffect(
    () => () => {
      delete offsets.current[clave];
    },
    [clave, offsets]
  );
  return (
    <View
      onLayout={(e) => {
        offsets.current[clave] = e.nativeEvent.layout.y;
        onMedido(clave);
      }}
    >
      {children}
    </View>
  );
}

/** Sobre TotalFacturadoComparativa bruta para referencia neta (aprox. −10% impuestos); igual que el calendario. */
const FACTOR_NETO_COMPARATIVA = 0.9;

/** Clave de agrupación objetivo/gasto: fecha (YYYY-MM-DD) + local. */
function claveFechaLocal(fecha: string | undefined, idLocal: string | undefined): string {
  return `${String(fecha || '').slice(0, 10)}|${String(idLocal || '').trim()}`;
}

/** Importe de una actuación (final o previsto); null si no hay ninguno. */
function importeActuacion(a: Actuacion): number | null {
  if (a.importe_final != null && !Number.isNaN(Number(a.importe_final))) return Number(a.importe_final);
  if (a.importe_previsto != null && !Number.isNaN(Number(a.importe_previsto))) return Number(a.importe_previsto);
  return null;
}

/** Color del % de gasto según el ratio_musicos del local (verde ≤ ratio, ámbar ≤ ratio+1, rojo > ratio+1). */
function colorPctGasto(pct: number, ratio: number | null): string {
  if (ratio == null || Number.isNaN(ratio)) return colors.textPrimary;
  if (pct <= ratio) return colors.success;
  if (pct <= ratio + 1) return colors.warning;
  return colors.danger;
}

/** Días ISO para «Generar huecos»: 1 = lunes … 7 = domingo. */
const DIAS_SEMANA_GEN: { dia: number; letra: string; nombre: string; plural: string }[] = [
  { dia: 1, letra: 'L', nombre: 'lunes', plural: 'lunes' },
  { dia: 2, letra: 'M', nombre: 'martes', plural: 'martes' },
  { dia: 3, letra: 'X', nombre: 'miércoles', plural: 'miércoles' },
  { dia: 4, letra: 'J', nombre: 'jueves', plural: 'jueves' },
  { dia: 5, letra: 'V', nombre: 'viernes', plural: 'viernes' },
  { dia: 6, letra: 'S', nombre: 'sábado', plural: 'sábados' },
  { dia: 7, letra: 'D', nombre: 'domingo', plural: 'domingos' },
];
const TODOS_DIAS_GEN = [1, 2, 3, 4, 5, 6, 7];

function diaSemanaIso(fechaIso: string): number {
  return new Date(`${fechaIso}T12:00:00.000Z`).getUTCDay() || 7;
}

/** Fechas YYYY-MM-DD del rango [ini, fin] cuyo día de la semana está en `dias`. */
function fechasGenerarHuecos(ini: string, fin: string, dias: number[]): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ini) || !/^\d{4}-\d{2}-\d{2}$/.test(fin) || ini > fin) return [];
  const out: string[] = [];
  let t = new Date(`${ini}T12:00:00.000Z`).getTime();
  const end = new Date(`${fin}T12:00:00.000Z`).getTime();
  while (t <= end && out.length < 1000) {
    const f = new Date(t).toISOString().slice(0, 10);
    if (dias.includes(diaSemanaIso(f))) out.push(f);
    t += 864e5;
  }
  return out;
}

type FiltroLista = 'todas' | 'sinArtista' | 'sinFirmar';

const FILTROS_LISTA: { id: FiltroLista; label: string }[] = [
  { id: 'todas', label: 'Todas' },
  { id: 'sinArtista', label: 'Sin artista' },
  { id: 'sinFirmar', label: 'Sin firmar' },
];

function actuacionCoincideFiltro(a: Actuacion, filtro: FiltroLista): boolean {
  if (filtro === 'sinArtista') return !a.id_artista;
  if (filtro === 'sinFirmar') return !!a.id_artista && !a.firma_artista_key?.trim();
  return true;
}

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

function getValorCeldaActuacion(a: Actuacion, col: string): string {
  switch (col) {
    case 'Fecha':
      return a.fecha ? formatFecha(a.fecha) : '—';
    case 'Hora':
      return a.hora_inicio || '—';
    case 'Local':
      return a.local_nombre_snapshot?.trim() || a.id_local || '—';
    case 'Artista':
      return a.artista_nombre_snapshot?.trim() || (a.id_artista ? '—' : 'Sin artista');
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

/** Texto usuario → "HH:MM" válido (24 h) o null */
function parseHoraHHMM(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export default function ProgramacionScreen() {
  const router = useRouter();
  const { user, hasPermiso } = useAuth();
  const puedeVer = puedeProgramacionActuaciones(hasPermiso);
  const puedeCrear = puedeCrearActuacion(hasPermiso);
  const puedeEditar = puedeEditarActuacion(hasPermiso);
  const puedeBorrar = puedeBorrarActuacion(hasPermiso);
  const puedeFacturacion = puedeFacturacionActuaciones(hasPermiso);
  const puedeFirmar = puedeFirmarActuacion(hasPermiso);
  const { show: showToast, ToastView } = useLocalToast();
  const { confirmar, ConfirmarView } = useConfirmar();
  const { shouldStackToolbar, shouldStackPanels, isDesktop, isPhone } = useBreakpoint();
  const altoControl = isDesktop ? 36 : MIN_TOUCH;
  const [actuaciones, setActuaciones] = useState<Actuacion[]>([]);
  const [artistas, setArtistas] = useState<{ id_artista: string; nombre_artistico: string }[]>([]);
  const [localesParipe, setLocalesParipe] = useState<LocalOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [filtroLista, setFiltroLista] = useState<FiltroLista>('todas');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** Modo «Seleccionar para pago»: muestra checkboxes en filas con artista. */
  const [modoSeleccion, setModoSeleccion] = useState(false);

  const jornadaHoy = useMemo(() => fechaJornadaNegocioIso(), []);
  const periodoInicial = useMemo(() => rangoPeriodo('semana', jornadaHoy), [jornadaHoy]);
  const [modoPeriodo, setModoPeriodo] = useState<ModoPeriodo>('semana');
  const [fechaDesde, setFechaDesde] = useState(periodoInicial.desde);
  const [fechaHasta, setFechaHasta] = useState(periodoInicial.hasta);
  /** Rango `desde|hasta` de los datos ya cargados (evita hacer scroll sobre datos del periodo anterior). */
  const [rangoCargado, setRangoCargado] = useState('');
  /** Día elegido en el calendario. */
  const [diaSeleccionado, setDiaSeleccionado] = useState<string | undefined>(undefined);
  /** Día al que hay que desplazar la lista cuando haya datos y medidas. */
  const [diaScrollPendiente, setDiaScrollPendiente] = useState<string | null>(null);
  const listaScrollRef = useRef<ScrollView>(null);
  const offsetsTarjetasRef = useRef<Record<string, number>>({});
  /** Vacío = todos los locales; si no, solo actuaciones de esos ids */
  const [filtroLocalesIds, setFiltroLocalesIds] = useState<string[]>([]);

  const [modalNuevos, setModalNuevos] = useState(false);
  const [fechaIniN, setFechaIniN] = useState('');
  const [fechaFinN, setFechaFinN] = useState('');
  /** Locales seleccionados para generar huecos (multi-selección). */
  const [localesN, setLocalesN] = useState<string[]>([]);
  const [horasN, setHorasN] = useState<string[]>(['22:00']);
  const [diasSemanaN, setDiasSemanaN] = useState<number[]>(TODOS_DIAS_GEN);
  /** Texto del campo antes de pulsar «Añadir» (chips de horas en modal generar base). */
  const [horaBorradorN, setHoraBorradorN] = useState('');
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
  const [empresasMusicos, setEmpresasMusicos] = useState<{ id_empresa: string; nombre: string; cif: string }[]>([]);
  const [loadingEmpresasAsoc, setLoadingEmpresasAsoc] = useState(false);

  const [modalEdit, setModalEdit] = useState(false);
  const [form, setForm] = useState<Partial<Actuacion>>({});
  const [saving, setSaving] = useState(false);
  /** Confirmación in-app antes de desasociar factura (mismo patrón que otros modales de la pantalla). */
  const [modalDesasocConfirmOpen, setModalDesasocConfirmOpen] = useState(false);
  /** Borrar varias actuaciones marcadas en Sel (toolbar Borrar). */
  const [modalBorrarMultipleOpen, setModalBorrarMultipleOpen] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const [modalFirma, setModalFirma] = useState(false);
  /** «Firmar» desde la lista: abrir la firma en cuanto el modal de edición tenga la actuación cargada. */
  const [firmaPendiente, setFirmaPendiente] = useState(false);
  /** El modal de edición se abrió desde «Firmar» de la lista (se cierra al guardar la firma). */
  const firmaDesdeListaRef = useRef(false);
  /** Solo se aplica la respuesta de la última llamada a fetchAll. */
  const reqIdRef = useRef(0);
  const [firmaSubiendo, setFirmaSubiendo] = useState(false);

  const [conflictoOpen, setConflictoOpen] = useState(false);
  const [conflictoOtro, setConflictoOtro] = useState<ConflictoOtro | null>(null);
  const [pendingPutBody, setPendingPutBody] = useState<Record<string, unknown> | null>(null);
  /** Evita recalcular importe al abrir el modal (se mantienen valores de BD). */
  const skipImporteCalcOnceRef = useRef(false);

  /** Objetivo neto (comparativa Agora × 0,9) por clave fecha|local. */
  const [objetivosPorClave, setObjetivosPorClave] = useState<Record<string, number | null>>({});
  const [loadingObjetivos, setLoadingObjetivos] = useState(false);

  const listaFiltrada = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    let list = actuaciones;
    if (filtroLista !== 'todas') {
      list = list.filter((a) => actuacionCoincideFiltro(a, filtroLista));
    }
    if (!q) return list;
    return list.filter((a) =>
      CAMPOS_BUSQUEDA.some((col) => getValorCeldaActuacion(a, col).toLowerCase().includes(q))
    );
  }, [actuaciones, filtroBusqueda, filtroLista]);

  /** Lista ordenada por fecha ↑ → local (alfabético) ↑ → hora ↑ (base del «merge» visual por grupo). */
  const listaOrdenada = useMemo(() => {
    const nombreLocal = (a: Actuacion) => (a.local_nombre_snapshot?.trim() || a.id_local || '').toLowerCase();
    return [...listaFiltrada].sort((a, b) => {
      const fa = String(a.fecha || '').slice(0, 10);
      const fb = String(b.fecha || '').slice(0, 10);
      if (fa !== fb) return fa < fb ? -1 : 1;
      const la = nombreLocal(a);
      const lb = nombreLocal(b);
      const cmpLocal = la.localeCompare(lb, 'es', { sensitivity: 'base' });
      if (cmpLocal !== 0) return cmpLocal;
      const ha = String(a.hora_inicio || '').trim();
      const hb = String(b.hora_inicio || '').trim();
      if (ha === hb) return 0;
      if (!ha) return 1;
      if (!hb) return -1;
      return ha < hb ? -1 : 1;
    });
  }, [listaFiltrada]);

  /** Una tarjeta por fecha|local, en el orden de `listaOrdenada`. */
  const gruposLista = useMemo((): GrupoDiaLocal[] => {
    const out: GrupoDiaLocal[] = [];
    let actual: GrupoDiaLocal | null = null;
    for (const a of listaOrdenada) {
      const key = claveFechaLocal(a.fecha, a.id_local);
      if (!actual || actual.clave !== key) {
        actual = {
          clave: key,
          fecha: String(a.fecha || '').slice(0, 10),
          localNombre: a.local_nombre_snapshot?.trim() || a.id_local || 'Sin local',
          idLocal: String(a.id_local || '').trim(),
          items: [],
        };
        out.push(actual);
      }
      actual.items.push(a);
    }
    return out;
  }, [listaOrdenada]);

  /** Gasto real (suma de importes) por grupo fecha|local, sobre TODAS las actuaciones (no solo filtradas). */
  const gastoPorClave = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of actuaciones) {
      const v = importeActuacion(a);
      if (v == null) continue;
      const key = claveFechaLocal(a.fecha, a.id_local);
      m.set(key, (m.get(key) ?? 0) + v);
    }
    return m;
  }, [actuaciones]);

  const agoraPorLocalId = useMemo(() => {
    const m: Record<string, string> = {};
    for (const l of localesParipe) {
      const id = String(l.id_Locales || '').trim();
      const code = String(l.agoraCode ?? l.AgoraCode ?? '').trim();
      if (id && code) m[id] = code;
    }
    return m;
  }, [localesParipe]);

  const ratioPorLocalId = useMemo(() => {
    const m: Record<string, number | null> = {};
    for (const l of localesParipe) {
      const id = String(l.id_Locales || '').trim();
      if (!id) continue;
      const raw = l.ratio_musicos;
      const n = raw == null || raw === '' ? null : Number(raw);
      m[id] = n != null && !Number.isNaN(n) ? n : null;
    }
    return m;
  }, [localesParipe]);

  const resumenKpi = useMemo(() => {
    let importe = 0;
    let huecos = 0;
    let firmadas = 0;
    for (const a of actuaciones) {
      const v = a.importe_final ?? a.importe_previsto;
      if (v != null && !Number.isNaN(Number(v))) importe += Number(v);
      if (!a.id_artista) huecos++;
      if (a.firma_artista_key?.trim()) firmadas++;
    }
    return {
      total: actuaciones.length,
      huecos,
      firmadas,
      importe: Math.round(importe * 100) / 100,
    };
  }, [actuaciones]);

  const mostrarSeccionFirma = useMemo(
    () =>
      puedeFirmar &&
      !!(
        form.id_actuacion &&
        form.id_artista?.trim() &&
        fechaActuacionPermiteFirma(form.fecha)
      ),
    [puedeFirmar, form.id_actuacion, form.id_artista, form.fecha]
  );

  useEffect(() => {
    if (!mostrarSeccionFirma && modalFirma) setModalFirma(false);
  }, [mostrarSeccionFirma, modalFirma]);

  useEffect(() => {
    if (!firmaPendiente) return;
    if (!modalEdit) {
      setFirmaPendiente(false);
      return;
    }
    if (!mostrarSeccionFirma) return;
    // iOS no presenta un segundo Modal mientras el primero aún se está mostrando.
    const t = setTimeout(
      () => {
        setFirmaPendiente(false);
        setModalFirma(true);
      },
      Platform.OS === 'ios' ? 450 : 0
    );
    return () => clearTimeout(t);
  }, [firmaPendiente, modalEdit, mostrarSeccionFirma]);

  const resumenLocalesGen = useMemo(() => {
    if (localesN.length === 0) return '';
    if (localesN.length === 1) {
      const loc = localesParipe.find((l) => l.id_Locales === localesN[0]);
      return loc?.nombre?.trim() || localesN[0];
    }
    return `${localesN.length} locales seleccionados`;
  }, [localesN, localesParipe]);

  const fechasGenN = useMemo(
    () => fechasGenerarHuecos(fechaIniN, fechaFinN, diasSemanaN),
    [fechaIniN, fechaFinN, diasSemanaN]
  );

  const resumenGenerarHuecos = useMemo(() => {
    if (diasSemanaN.length === 0) return 'Marca al menos un día de la semana.';
    if (!fechaIniN || !fechaFinN || fechaIniN > fechaFinN) return 'Indica un rango de fechas válido.';
    if (fechasGenN.length === 0) return 'El rango no contiene ninguno de los días marcados.';
    const porDia = new Map<number, number>();
    for (const f of fechasGenN) {
      const d = diaSemanaIso(f);
      porDia.set(d, (porDia.get(d) ?? 0) + 1);
    }
    const partes = DIAS_SEMANA_GEN.filter((d) => porDia.has(d.dia)).map((d) => {
      const n = porDia.get(d.dia) ?? 0;
      return `${n} ${n === 1 ? d.nombre : d.plural}`;
    });
    const detalleDias =
      diasSemanaN.length === 7
        ? `${fechasGenN.length} día${fechasGenN.length !== 1 ? 's' : ''}`
        : partes.length > 1
          ? `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`
          : partes[0];
    const nHoras = horasN.length;
    const nLocales = localesN.length;
    const total = fechasGenN.length * nHoras * nLocales;
    return `Se crearán ${total} hueco${total !== 1 ? 's' : ''}: ${detalleDias}, ${nHoras} hora${
      nHoras !== 1 ? 's' : ''
    }, ${nLocales} local${nLocales !== 1 ? 'es' : ''}.`;
  }, [diasSemanaN, fechaIniN, fechaFinN, fechasGenN, horasN.length, localesN.length]);

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

  function toggleFiltroLocal(id: string) {
    setFiltroLocalesIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  }

  function aplicarPeriodo(r: { desde: string; hasta: string }) {
    setFechaDesde(r.desde);
    setFechaHasta(r.hasta);
  }

  function cambiarModoPeriodo(modo: ModoPeriodo) {
    if (modo === modoPeriodo) return;
    const ancla = jornadaHoy >= fechaDesde && jornadaHoy <= fechaHasta ? jornadaHoy : fechaDesde;
    setModoPeriodo(modo);
    aplicarPeriodo(rangoPeriodo(modo, ancla));
  }

  function moverPeriodo(delta: number) {
    aplicarPeriodo(desplazarPeriodo(modoPeriodo, fechaDesde, delta));
  }

  function irAHoy() {
    aplicarPeriodo(rangoPeriodo(modoPeriodo, jornadaHoy));
  }

  const textoPeriodo = useMemo(
    () => etiquetaPeriodo(modoPeriodo, fechaDesde, fechaHasta),
    [modoPeriodo, fechaDesde, fechaHasta]
  );

  const seleccionarDiaCalendario = useCallback(
    (iso: string) => {
      setDiaSeleccionado(iso);
      if (iso < fechaDesde || iso > fechaHasta) {
        const r = rangoPeriodo(modoPeriodo, iso);
        setFechaDesde(r.desde);
        setFechaHasta(r.hasta);
      }
      setDiaScrollPendiente(iso);
    },
    [fechaDesde, fechaHasta, modoPeriodo]
  );

  /** Desplaza la lista a la primera tarjeta del día pendiente cuando los datos del periodo y su medida están listos. */
  const intentarScrollDia = useCallback(() => {
    const iso = diaScrollPendiente;
    if (!iso || loading || rangoCargado !== `${fechaDesde}|${fechaHasta}`) return;
    const grupo = gruposLista.find((g) => g.fecha === iso) ?? gruposLista.find((g) => g.fecha > iso);
    if (!grupo) {
      setDiaScrollPendiente(null);
      return;
    }
    const y = offsetsTarjetasRef.current[grupo.clave];
    if (y == null) return;
    listaScrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
    setDiaScrollPendiente(null);
  }, [diaScrollPendiente, loading, rangoCargado, fechaDesde, fechaHasta, gruposLista]);

  useEffect(() => {
    intentarScrollDia();
  }, [intentarScrollDia]);

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
    const reqId = ++reqIdRef.current;
    const vigente = () => reqId === reqIdRef.current;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (fechaDesde) qs.set('fechaDesde', fechaDesde);
    if (fechaHasta) qs.set('fechaHasta', fechaHasta);
    if (filtroLocalesIds.length > 0) qs.set('id_locales', filtroLocalesIds.join(','));
    Promise.all([
      apiFetch(`/api/actuaciones?${qs}`).then((r) => r.json()),
      apiFetch('/api/artistas').then((r) => r.json()),
      apiFetch('/api/locales?grupoParipe=1').then((r) => r.json()),
    ])
      .then(([a, ar, locP]) => {
        if (!vigente()) return;
        if (a.error) setError(a.error);
        setActuaciones(a.actuaciones || []);
        setRangoCargado(`${fechaDesde}|${fechaHasta}`);
        setArtistas(
          (ar.artistas || []).map((x: { id_artista: string; nombre_artistico: string }) => ({
            id_artista: x.id_artista,
            nombre_artistico: x.nombre_artistico,
          }))
        );
        setLocalesParipe(locP.locales || []);
      })
      .catch((e) => {
        if (vigente()) setError(e instanceof Error ? e.message : 'Error de red');
      })
      .finally(() => {
        if (vigente()) setLoading(false);
      });
  }, [fechaDesde, fechaHasta, filtroLocalesIds]);

  /** Cambiar periodo o local invalida la selección. */
  useEffect(() => {
    setSelectedIds(new Set());
    setModoSeleccion(false);
  }, [fechaDesde, fechaHasta, filtroLocalesIds]);

  /** La selección nunca incluye filas ocultas por filtro, búsqueda o recarga. */
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visibles = new Set(listaFiltrada.map((a) => a.id_actuacion));
      let cambia = false;
      const n = new Set<string>();
      for (const id of prev) {
        if (visibles.has(id)) n.add(id);
        else cambia = true;
      }
      return cambia ? n : prev;
    });
  }, [listaFiltrada]);

  const seleccionTieneHuecos = useMemo(
    () => actuaciones.some((a) => selectedIds.has(a.id_actuacion) && !a.id_artista),
    [actuaciones, selectedIds]
  );

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
      const r = await apiFetch(`/api/actuaciones/facturas-gasto-asociables?${qs}`);
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

  /** Carga el objetivo neto (comparativa Agora × 0,9) por fecha|local para todas las actuaciones visibles. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fechas = new Set<string>();
      const localIds = new Set<string>();
      for (const a of actuaciones) {
        const f = String(a.fecha || '').slice(0, 10);
        const lid = String(a.id_local || '').trim();
        if (f) fechas.add(f);
        if (lid) localIds.add(lid);
      }
      if (fechas.size === 0 || localIds.size === 0) {
        if (!cancelled) setObjetivosPorClave({});
        return;
      }
      setLoadingObjetivos(true);
      let festivosByFecha: Record<string, FestivoGestionRow> = {};
      try {
        const fr = await apiFetch('/api/gestion-festivos');
        const fd = await fr.json();
        const list = Array.isArray(fd.registros) ? fd.registros : [];
        festivosByFecha = Object.fromEntries(
          list
            .filter((f: FestivoGestionRow) => f.PK || f.FechaComparativa)
            .map((f: FestivoGestionRow) => [String(f.PK ?? f.FechaComparativa ?? '').slice(0, 10), f]),
        );
      } catch {
        festivosByFecha = {};
      }
      const fechaToComp: Record<string, string> = {};
      let minComp = '';
      let maxComp = '';
      for (const f of fechas) {
        const fc = fechaComparacionParaObjetivo(f, festivosByFecha);
        fechaToComp[f] = fc;
        if (!minComp || fc < minComp) minComp = fc;
        if (!maxComp || fc > maxComp) maxComp = fc;
      }
      const out: Record<string, number | null> = {};
      await Promise.all(
        [...localIds].map(async (lid) => {
          const wp = agoraPorLocalId[lid];
          if (!wp) {
            for (const f of fechas) out[claveFechaLocal(f, lid)] = null;
            return;
          }
          try {
            const url = `/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(wp)}&dateFrom=${minComp}&dateTo=${maxComp}`;
            const r = await apiFetch(url);
            const d = (await r.json()) as { totals?: Record<string, number> };
            const totals = d.totals ?? {};
            for (const f of fechas) {
              const raw = totals[fechaToComp[f]];
              out[claveFechaLocal(f, lid)] =
                raw == null || Number.isNaN(Number(raw)) ? null : Number(raw) * FACTOR_NETO_COMPARATIVA;
            }
          } catch {
            for (const f of fechas) out[claveFechaLocal(f, lid)] = null;
          }
        }),
      );
      if (!cancelled) {
        setObjetivosPorClave(out);
        setLoadingObjetivos(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actuaciones, agoraPorLocalId]);

  useEffect(() => {
    if (!modalAsoc) return;
    void buscarFacturas();
  }, [modalAsoc, buscarFacturas]);

  useEffect(() => {
    if (!modalAsoc) return;
    setLoadingEmpresasAsoc(true);
    apiFetch('/api/empresas')
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
    setEmpresaAsocId('');
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
      showToast('Selección', 'Marca actuaciones en la lista y elige una factura.', 'warning');
      return;
    }
    if (seleccionTieneHuecos) {
      showToast('Selección', 'Quita los huecos para asociar pago.', 'warning');
      return;
    }
    try {
      const r = await apiFetch('/api/actuaciones/asociar-factura', {
        method: 'POST',
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
      setModoSeleccion(false);
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
        const r = await apiFetch('/api/actuaciones/calcular-importe', {
          method: 'POST',
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
    const r = await apiFetch(`/api/actuaciones/item/${id}`, {
      method: 'PUT',
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

  /** Cuerpo PUT para quitar la vinculación con factura de gasto (misma forma que un hueco nuevo). */
  const bodyDesasociarFactura = useCallback((): Record<string, unknown> => {
    return {
      id_factura_gasto: '',
      pago_asociado_numero_factura: '',
      pago_asociado_proveedor: '',
      pago_asociado_fecha: '',
      pago_asociado_importe: null,
      pago_asociado_estado: '',
      fecha_asociacion_pago: '',
      usuario_asociacion_pago: '',
      estado: 'pendiente',
    };
  }, []);

  const actuacionTieneFacturaAsociada = useMemo(() => {
    const idFac = String(form.id_factura_gasto ?? '').trim();
    const st = String(form.estado ?? '').trim().toLowerCase();
    return Boolean(idFac) || st === 'asociada';
  }, [form.id_factura_gasto, form.estado]);

  function abrirConfirmDesasociar() {
    if (!form.id_actuacion) return;
    setModalDesasocConfirmOpen(true);
  }

  function cerrarConfirmDesasociar() {
    setModalDesasocConfirmOpen(false);
  }

  function confirmarDesasociarDesdeModal() {
    setModalDesasocConfirmOpen(false);
    void ejecutarDesasociarFactura();
  }

  async function ejecutarDesasociarFactura() {
    if (!form.id_actuacion) return;
    setSaving(true);
    try {
      const ok = await ejecutarPut(form.id_actuacion, bodyDesasociarFactura());
      if (ok) {
        showToast('Desasociado', 'La actuación ya no está vinculada a la factura.', 'success');
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
      const r = await apiFetch(`/api/actuaciones/item/${form.id_actuacion}`, {
        method: 'PUT',
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
      const r = await apiFetch('/api/actuaciones/mover-artista-aqui', {
        method: 'POST',
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
    setFechaIniN(jornadaHoy);
    setFechaFinN(jornadaHoy);
    setLocalesN([]);
    setLocalesGenDropdownOpen(false);
    setHorasN(['22:00']);
    setDiasSemanaN(TODOS_DIAS_GEN);
    setHoraBorradorN('');
    setModalNuevos(true);
  }

  function añadirHoraDesdeBorrador() {
    const parsed = parseHoraHHMM(horaBorradorN);
    if (!parsed) {
      showToast('Hora no válida', 'Usa el formato HH:MM (ej. 22:00).', 'warning');
      return;
    }
    if (horasN.includes(parsed)) {
      showToast('Duplicada', 'Esa hora ya está en la lista.', 'warning');
      return;
    }
    setHorasN([...horasN, parsed]);
    setHoraBorradorN('');
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

  function toggleDiaSemanaGen(dia: number) {
    setDiasSemanaN((prev) =>
      prev.includes(dia) ? prev.filter((d) => d !== dia) : [...prev, dia].sort((a, b) => a - b)
    );
  }

  async function confirmarGenerarBase() {
    if (localesN.length === 0 || !fechaIniN || !fechaFinN || horasN.length === 0) {
      showToast('Datos incompletos', 'Indica fechas, al menos un local y al menos una hora.', 'warning');
      return;
    }
    if (diasSemanaN.length === 0) {
      showToast('Datos incompletos', 'Marca al menos un día de la semana.', 'warning');
      return;
    }
    if (fechasGenN.length === 0) {
      showToast('Sin días', 'El rango no contiene ninguno de los días de la semana marcados.', 'warning');
      return;
    }
    setGenerando(true);
    try {
      const r = await apiFetch('/api/actuaciones/generar-base', {
        method: 'POST',
        body: JSON.stringify({
          fecha_inicio: fechaIniN,
          fecha_fin: fechaFinN,
          id_locales: localesN,
          horas: horasN.map((h) => h.trim()).filter(Boolean),
          dias_semana: diasSemanaN,
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
    skipImporteCalcOnceRef.current = !!(item.id_artista && item.fecha);
    firmaDesdeListaRef.current = false;
    setModalEdit(true);
  }

  function cerrarModalEdit() {
    firmaDesdeListaRef.current = false;
    setModalFirma(false);
    setModalDesasocConfirmOpen(false);
    setModalEdit(false);
  }

  /** Tras firmar: refleja la firma en el formulario (para que Guardar no pise el estado) o cierra si se vino de «Firmar». */
  function aplicarFirmaGuardada(idAct: string, d: { firma_artista_key?: string; actuacion?: Partial<Actuacion> }) {
    if (firmaDesdeListaRef.current) {
      cerrarModalEdit();
      setForm({});
      return;
    }
    const act = d.actuacion;
    setForm((f) =>
      f.id_actuacion !== idAct
        ? f
        : {
            ...f,
            firma_artista_key: act?.firma_artista_key ?? d.firma_artista_key ?? f.firma_artista_key,
            fecha_firma: act?.fecha_firma ?? f.fecha_firma,
            estado: act?.estado ?? f.estado,
          }
    );
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
    const r = await apiFetch(`/api/actuaciones/item/${idAct}/firma`, { method: 'POST', body: formData });
    const d = await r.json();
    if (!r.ok) showToast('Error', d.error || 'No se pudo subir', 'error');
    else {
      showToast('OK', 'Firma guardada', 'success');
      aplicarFirmaGuardada(idAct, d);
      fetchAll();
    }
  }

  async function enviarFirmaDesdePantalla(idAct: string, base64Raw: string) {
    setFirmaSubiendo(true);
    try {
      const formData = await buildFirmaFormData(base64Raw);
      const r = await apiFetch(`/api/actuaciones/item/${idAct}/firma`, { method: 'POST', body: formData });
      const d = await r.json();
      if (!r.ok) showToast('Error', d.error || 'No se pudo subir', 'error');
      else {
        showToast('OK', 'Firma guardada', 'success');
        setModalFirma(false);
        aplicarFirmaGuardada(idAct, d);
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
      const r = await apiFetch(`/api/actuaciones/item/${item.id_actuacion}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      showToast('Eliminado', 'Actuación eliminada.', 'success');
      setSelectedIds((prev) => {
        if (!prev.has(item.id_actuacion)) return prev;
        const n = new Set(prev);
        n.delete(item.id_actuacion);
        return n;
      });
      fetchAll();
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  async function pedirBorrarActuacion(item: Actuacion) {
    const hora = item.hora_inicio?.trim();
    const local = item.local_nombre_snapshot?.trim() || item.id_local || '';
    const quien = item.artista_nombre_snapshot?.trim();
    const detalle = [
      item.fecha ? cabeceraDia(String(item.fecha).slice(0, 10)) : '',
      hora ? `a las ${hora}` : '',
      local ? `en ${local}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const ok = await confirmar(
      'Eliminar actuación',
      `Se eliminará ${quien ? `la actuación de ${quien}` : 'el hueco'}${detalle ? ` del ${detalle}` : ''}. Esta acción no se puede deshacer.`,
      { confirmarLabel: 'Eliminar', variant: 'danger' }
    );
    if (ok) void borrarActuacion(item);
  }

  function firmarDesdeLista(item: Actuacion) {
    abrirEditar(item);
    firmaDesdeListaRef.current = true;
    setFirmaPendiente(true);
  }

  function cancelarSeleccion() {
    setSelectedIds(new Set());
    setModoSeleccion(false);
  }

  function marcarHuecosVisibles() {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      for (const a of listaFiltrada) if (!a.id_artista) n.add(a.id_actuacion);
      return n;
    });
  }

  async function confirmarBorrarMultiple() {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      setModalBorrarMultipleOpen(false);
      return;
    }
    setBorrando(true);
    try {
      for (const id of ids) {
        const r = await apiFetch(`/api/actuaciones/item/${id}`, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `Error al borrar actuación`);
      }
      const n = ids.length;
      showToast('Eliminado', n === 1 ? 'Actuación eliminada.' : `${n} actuaciones eliminadas.`, 'success');
      setModalBorrarMultipleOpen(false);
      setSelectedIds(new Set());
      setModoSeleccion(false);
      fetchAll();
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setBorrando(false);
    }
  }

  /** Spinner de sección solo al cambiar de periodo o sin datos; al refrescar se mantiene la lista visible. */
  const cargandoPeriodo = loading && (rangoCargado !== `${fechaDesde}|${fechaHasta}` || actuaciones.length === 0);

  const calendario = (
    <ActuacionesCalendario
      actuaciones={actuaciones}
      locales={localesParipe}
      diaSeleccionado={diaSeleccionado}
      onSeleccionarDia={seleccionarDiaCalendario}
      mesReferencia={
        diaSeleccionado && diaSeleccionado >= fechaDesde && diaSeleccionado <= fechaHasta
          ? diaSeleccionado
          : jornadaHoy >= fechaDesde && jornadaHoy <= fechaHasta
            ? jornadaHoy
            : fechaDesde
      }
      notaPie={modoPeriodo === 'semana' ? 'Solo se marcan los días de la semana cargada' : undefined}
    />
  );

  return (
    <View style={styles.screenWrap}>
      {ToastView}
      {!puedeVer ? (
        <View style={styles.sinPermisoBox}>
          <MaterialIcons name="lock-outline" size={28} color={colors.textMuted} />
          <Text style={styles.sinPermisoText}>No tienes permiso para ver la programación de actuaciones.</Text>
        </View>
      ) : (
      <>
      <View style={[styles.topBar, shouldStackToolbar && styles.topBarStack]}>
        <View style={styles.topBarGrupo}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={[styles.iconBtn, { width: altoControl, height: altoControl }]}
            accessibilityLabel="Volver"
          >
            <MaterialIcons name="arrow-back" size={22} color={colors.textStrong} />
          </TouchableOpacity>
          <Text style={styles.topBarTitle}>Planificación</Text>
        </View>

        <View style={[styles.topBarGrupo, styles.topBarFiltros, shouldStackToolbar && styles.topBarFiltrosStack]}>
          <View style={styles.filterLocalDropdownWrap}>
            <TouchableOpacity
              style={[styles.filterToolbarTrigger, { minHeight: altoControl }]}
              onPress={() => setFiltroLocalDropdownOpen((v) => !v)}
              activeOpacity={0.7}
              accessibilityLabel="Filtrar por local"
            >
              <MaterialIcons name="place" size={16} color={colors.textMuted} />
              <Text style={styles.filterToolbarTriggerText} numberOfLines={1}>
                {textoFiltroLocal}
              </Text>
              <MaterialIcons name={filtroLocalDropdownOpen ? 'expand-less' : 'expand-more'} size={20} color={colors.textMuted} />
            </TouchableOpacity>
            {filtroLocalDropdownOpen ? (
              <View style={styles.filterToolbarList}>
                <ScrollView style={styles.filterToolbarScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  <TouchableOpacity
                    style={[styles.filterToolbarOpt, filtroLocalesIds.length === 0 && styles.filterToolbarOptOn]}
                    onPress={() => setFiltroLocalesIds([])}
                  >
                    <Text style={styles.filterToolbarOptText}>Todos los locales</Text>
                    {filtroLocalesIds.length === 0 ? (
                      <MaterialIcons name="check-box" size={18} color={colors.accent} />
                    ) : (
                      <MaterialIcons name="check-box-outline-blank" size={18} color={colors.textMuted} />
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
                          color={sel ? colors.accent : colors.textMuted}
                        />
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
          </View>

          <View style={styles.periodoNav}>
            <View style={styles.segmentado}>
              {(['semana', 'mes'] as const).map((m) => {
                const on = modoPeriodo === m;
                return (
                  <TouchableOpacity
                    key={m}
                    style={[styles.segmentoOpt, { minHeight: altoControl - 4 }, on && styles.segmentoOptOn]}
                    onPress={() => cambiarModoPeriodo(m)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[styles.segmentoText, on && styles.segmentoTextOn]}>
                      {m === 'semana' ? 'Semana' : 'Mes'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity
              style={[styles.iconBtn, { width: altoControl, height: altoControl }]}
              onPress={() => moverPeriodo(-1)}
              accessibilityLabel={modoPeriodo === 'semana' ? 'Semana anterior' : 'Mes anterior'}
            >
              <MaterialIcons name="chevron-left" size={22} color={colors.textStrong} />
            </TouchableOpacity>
            <Text style={styles.periodoTexto} numberOfLines={1}>
              {textoPeriodo}
            </Text>
            <TouchableOpacity
              style={[styles.iconBtn, { width: altoControl, height: altoControl }]}
              onPress={() => moverPeriodo(1)}
              accessibilityLabel={modoPeriodo === 'semana' ? 'Semana siguiente' : 'Mes siguiente'}
            >
              <MaterialIcons name="chevron-right" size={22} color={colors.textStrong} />
            </TouchableOpacity>
            <TouchableOpacity style={[styles.hoyLink, { minHeight: altoControl }]} onPress={irAHoy}>
              <Text style={styles.hoyLinkText}>Hoy</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={[styles.topBarGrupo, !shouldStackToolbar && styles.topBarAcciones]}>
          {puedeCrear ? (
            <TouchableOpacity
              style={[styles.btnSecundario, { minHeight: altoControl }]}
              onPress={abrirNuevosRegistros}
              disabled={generando}
            >
              <MaterialIcons name="add" size={18} color={colors.textStrong} />
              <Text style={styles.btnSecundarioText}>Generar huecos</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={[styles.iconBtn, styles.iconBtnBorde, { width: altoControl, height: altoControl }]}
            onPress={fetchAll}
            disabled={loading}
            accessibilityLabel="Actualizar"
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <MaterialIcons name="refresh" size={20} color={colors.accent} />
            )}
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.resumen}>
        <View>
          <Text style={styles.resumenHuecos}>
            {resumenKpi.huecos} {resumenKpi.huecos === 1 ? 'hueco' : 'huecos'}
          </Text>
          <Text style={styles.resumenSub}>
            de {resumenKpi.total} {resumenKpi.total === 1 ? 'actuación' : 'actuaciones'}
          </Text>
        </View>
        <Text style={styles.resumenItem}>
          <Text style={styles.resumenCifra}>{resumenKpi.firmadas}</Text>
          <Text style={styles.resumenEtiqueta}> {resumenKpi.firmadas === 1 ? 'firmada' : 'firmadas'}</Text>
        </Text>
        <Text style={styles.resumenItem}>
          <Text style={styles.resumenCifra}>{formatMoneda(resumenKpi.importe)}</Text>
          <Text style={styles.resumenEtiqueta}> importe previsto</Text>
        </Text>
      </View>

      {error ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorBarText}>{error}</Text>
          <TouchableOpacity onPress={fetchAll} disabled={loading} hitSlop={8}>
            <Text style={styles.errorBarRetry}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={[styles.herramientas, shouldStackToolbar && styles.herramientasStack]}>
        <View style={[styles.buscador, { height: altoControl }]}>
          <MaterialIcons name="search" size={18} color={colors.textMuted} />
          <TextInput
            style={styles.buscadorInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar artista, local, hora…"
            placeholderTextColor={colors.textMuted}
          />
        </View>
        <View style={styles.segmentado}>
          {FILTROS_LISTA.map((f) => {
            const on = filtroLista === f.id;
            return (
              <TouchableOpacity
                key={f.id}
                style={[styles.segmentoOpt, styles.segmentoOptPeq, { minHeight: altoControl - 4 }, on && styles.segmentoOptOn]}
                onPress={() => setFiltroLista(f.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
              >
                <Text style={[styles.segmentoText, on && styles.segmentoTextOn]}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {puedeFacturacion || puedeBorrar ? (
          <View style={[styles.herramientasAcciones, !shouldStackToolbar && styles.herramientasAccionesDer]}>
            {modoSeleccion ? (
              <>
                {puedeBorrar ? (
                  <TouchableOpacity style={[styles.btnTexto, { minHeight: altoControl }]} onPress={marcarHuecosVisibles}>
                    <Text style={styles.btnTextoEnlace}>Marcar huecos visibles</Text>
                  </TouchableOpacity>
                ) : null}
                {puedeFacturacion && seleccionTieneHuecos ? (
                  <Text style={styles.ayudaSeleccion}>Quita los huecos para asociar pago</Text>
                ) : null}
                {puedeFacturacion ? (
                  <TouchableOpacity
                    style={[
                      styles.btnPrimario,
                      { minHeight: altoControl },
                      (selectedIds.size === 0 || seleccionTieneHuecos) && styles.btnOff,
                    ]}
                    disabled={selectedIds.size === 0 || seleccionTieneHuecos}
                    onPress={() => setModalAsoc(true)}
                  >
                    <MaterialIcons name="link" size={18} color={colors.surface} />
                    <Text style={styles.btnPrimarioText}>Asociar pago ({selectedIds.size})</Text>
                  </TouchableOpacity>
                ) : null}
                {puedeBorrar ? (
                  <TouchableOpacity
                    style={[styles.btnPeligro, { minHeight: altoControl }, selectedIds.size === 0 && styles.btnOff]}
                    disabled={selectedIds.size === 0 || borrando}
                    onPress={() => setModalBorrarMultipleOpen(true)}
                  >
                    <MaterialIcons name="delete-outline" size={18} color={colors.danger} />
                    <Text style={styles.btnPeligroText}>Borrar ({selectedIds.size})</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={[styles.btnTexto, { minHeight: altoControl }]} onPress={cancelarSeleccion}>
                  <Text style={styles.btnTextoText}>Cancelar</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity
                style={[styles.btnSecundario, { minHeight: altoControl }]}
                onPress={() => setModoSeleccion(true)}
              >
                <MaterialIcons name="check-box-outline-blank" size={18} color={colors.textStrong} />
                <Text style={styles.btnSecundarioText}>Seleccionar</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : null}
      </View>

      <View style={[styles.cuerpo, shouldStackPanels && styles.cuerpoStack]}>
        <View style={shouldStackPanels ? styles.listaColStack : styles.listaCol}>
        <ScrollView
          ref={listaScrollRef}
          style={styles.listaScrollInner}
          contentContainerStyle={styles.listaContenido}
          keyboardShouldPersistTaps="handled"
        >
          {cargandoPeriodo ? (
            <View style={styles.estadoBox}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : actuaciones.length === 0 ? (
            error ? null : (
              <View style={styles.tarjetaVacia}>
                <MaterialIcons name="event-busy" size={28} color={colors.textMuted} />
                <Text style={styles.tarjetaVaciaText}>
                  No hay actuaciones en este periodo. Pulsa «Generar huecos» para crear las horas.
                </Text>
              </View>
            )
          ) : gruposLista.length === 0 ? (
            <View style={styles.tarjetaVacia}>
              <MaterialIcons name="filter-list-off" size={28} color={colors.textMuted} />
              <Text style={styles.tarjetaVaciaText}>Ningún resultado con el filtro</Text>
            </View>
          ) : (
            gruposLista.map((g) => {
              const objetivo = objetivosPorClave[g.clave];
              const gasto = gastoPorClave.get(g.clave) ?? null;
              const pct = objetivo != null && objetivo > 0 && gasto != null ? (gasto / objetivo) * 100 : null;
              const ratio = ratioPorLocalId[g.idLocal] ?? null;
              const esHoy = g.fecha === jornadaHoy;
              const objetivoCargando = objetivo === undefined && loadingObjetivos;
              return (
                <BloqueMedido key={g.clave} clave={g.clave} offsets={offsetsTarjetasRef} onMedido={intentarScrollDia}>
                  <View style={[styles.tarjeta, esHoy && styles.tarjetaHoy]}>
                    <View style={styles.tarjetaCab}>
                      <View style={styles.tarjetaCabIzq}>
                        <Text style={styles.tarjetaDia}>{cabeceraDia(g.fecha)}</Text>
                        {esHoy ? (
                          <View style={styles.etiquetaHoy}>
                            <Text style={styles.etiquetaHoyText}>Hoy</Text>
                          </View>
                        ) : null}
                      </View>
                      <Text style={styles.tarjetaLocal} numberOfLines={1}>
                        {g.localNombre}
                      </Text>
                    </View>
                    {objetivoCargando || objetivo != null || gasto != null ? (
                      <View style={styles.tarjetaSub}>
                        <Text style={styles.tarjetaSubText} numberOfLines={1}>
                          {objetivoCargando ? (
                            'Objetivo …'
                          ) : objetivo != null ? (
                            <>
                              Objetivo del día {formatMoneda(objetivo)}
                              {pct != null ? (
                                <>
                                  {' · gasto artistas '}
                                  <Text style={[styles.tarjetaSubPct, { color: colorPctGasto(pct, ratio) }]}>
                                    {pct.toFixed(1).replace('.', ',')}%
                                  </Text>
                                </>
                              ) : null}
                            </>
                          ) : null}
                        </Text>
                        {gasto != null ? <Text style={styles.tarjetaGasto}>{formatMoneda(gasto)}</Text> : null}
                      </View>
                    ) : null}
                    {g.items.map((act) => {
                      const conArtista = !!act.id_artista;
                      const firmada = !!act.firma_artista_key?.trim();
                      const asociada = String(act.estado || '').trim().toLowerCase() === 'asociada';
                      const sel = selectedIds.has(act.id_actuacion);
                      const mostrarCheck = modoSeleccion;
                      const puedeFirmarFila =
                        puedeFirmar && conArtista && !firmada && fechaActuacionPermiteFirma(act.fecha);
                      const importe = act.importe_final ?? act.importe_previsto;
                      const pago = act.pago_asociado_numero_factura?.trim();
                      return (
                        <Pressable
                          key={act.id_actuacion}
                          style={({ pressed }) => [
                            styles.fila,
                            sel && styles.filaSel,
                            pressed && (puedeEditar || mostrarCheck) && styles.filaPressed,
                          ]}
                          onPress={() => {
                            if (mostrarCheck) toggleSel(act.id_actuacion);
                            else if (puedeEditar) abrirEditar(act);
                          }}
                          disabled={!puedeEditar && !mostrarCheck}
                          accessibilityRole="button"
                          accessibilityLabel={
                            conArtista
                              ? `${act.hora_inicio || ''} ${act.artista_nombre_snapshot || ''}`.trim()
                              : `${act.hora_inicio || ''} sin artista`.trim()
                          }
                        >
                          {mostrarCheck ? (
                            <View style={styles.filaCheck}>
                              <MaterialIcons
                                name={sel ? 'check-box' : 'check-box-outline-blank'}
                                size={22}
                                color={sel ? colors.accent : colors.textMuted}
                              />
                            </View>
                          ) : null}
                          <Text style={styles.filaHora}>{act.hora_inicio?.trim() || '—'}</Text>
                          {conArtista ? (
                            <View style={styles.filaCentro}>
                              <View style={styles.filaLinea}>
                                <Text style={styles.filaNombre} numberOfLines={1}>
                                  {act.artista_nombre_snapshot?.trim() || '—'}
                                </Text>
                                <Text style={styles.filaImporte}>
                                  {importe != null ? formatMoneda(importe) : '—'}
                                </Text>
                                {firmada ? (
                                  <View style={[styles.pastilla, styles.pastillaFirmada]}>
                                    <Text style={[styles.pastillaText, styles.pastillaFirmadaText]}>Firmada</Text>
                                  </View>
                                ) : asociada ? (
                                  <View style={[styles.pastilla, styles.pastillaAsociada]}>
                                    <Text style={[styles.pastillaText, styles.pastillaAsociadaText]}>Asociada</Text>
                                  </View>
                                ) : (
                                  <View style={[styles.pastilla, styles.pastillaPendiente]}>
                                    <Text style={[styles.pastillaText, styles.pastillaPendienteText]}>Pendiente</Text>
                                  </View>
                                )}
                              </View>
                              {pago ? <Text style={styles.filaPago}>Pago {pago}</Text> : null}
                            </View>
                          ) : (
                            <View style={styles.filaCentro}>
                              <Text style={styles.filaSinArtista}>Sin artista</Text>
                            </View>
                          )}
                          <View style={styles.filaAcciones}>
                            {!conArtista && puedeEditar ? (
                              <TouchableOpacity
                                style={[styles.btnAsignar, isPhone && { minHeight: MIN_TOUCH }]}
                                onPress={() => abrirEditar(act)}
                              >
                                <Text style={styles.btnAsignarText}>Asignar artista</Text>
                              </TouchableOpacity>
                            ) : null}
                            {puedeFirmarFila ? (
                              <TouchableOpacity
                                style={[styles.accionTexto, isPhone && { minHeight: MIN_TOUCH }]}
                                onPress={() => firmarDesdeLista(act)}
                              >
                                <Text style={styles.accionTextoFirmar}>Firmar</Text>
                              </TouchableOpacity>
                            ) : null}
                            {puedeBorrar ? (
                              <TouchableOpacity
                                style={[styles.iconBtn, { width: isPhone ? MIN_TOUCH : 32, height: isPhone ? MIN_TOUCH : 32 }]}
                                onPress={() => void pedirBorrarActuacion(act)}
                                accessibilityLabel="Eliminar actuación"
                              >
                                <MaterialIcons name="delete-outline" size={18} color={colors.textMuted} />
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                </BloqueMedido>
              );
            })
          )}
          {shouldStackPanels ? <View style={[styles.panelCalendario, styles.panelCalendarioStack]}>{calendario}</View> : null}
        </ScrollView>
        </View>
        {!shouldStackPanels ? <View style={styles.panelCalendario}>{calendario}</View> : null}
      </View>

      <Modal visible={modalNuevos} transparent animationType="fade" onRequestClose={() => setModalNuevos(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Generar huecos</Text>
              <TouchableOpacity onPress={() => setModalNuevos(false)}>
                <MaterialIcons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>Fecha inicio</Text>
              <InputFecha style={styles.input} valueIso={fechaIniN} onChangeIso={setFechaIniN} />
              <Text style={styles.label}>Fecha final</Text>
              <InputFecha style={styles.input} valueIso={fechaFinN} onChangeIso={setFechaFinN} />
              <Text style={styles.label}>Días de la semana</Text>
              <View style={styles.diasSemanaRow}>
                {DIAS_SEMANA_GEN.map((d) => {
                  const on = diasSemanaN.includes(d.dia);
                  return (
                    <Pressable
                      key={d.dia}
                      style={[styles.diaSemanaBtn, on && styles.diaSemanaBtnOn]}
                      onPress={() => toggleDiaSemanaGen(d.dia)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={d.nombre}
                    >
                      <Text style={[styles.diaSemanaBtnText, on && styles.diaSemanaBtnTextOn]}>{d.letra}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.diasSemanaAtajos}>
                <TouchableOpacity onPress={() => setDiasSemanaN(TODOS_DIAS_GEN)}>
                  <Text style={styles.localesGenLink}>Todos</Text>
                </TouchableOpacity>
                <Text style={styles.localesGenSep}>·</Text>
                <TouchableOpacity onPress={() => setDiasSemanaN([1, 2, 3, 4, 5])}>
                  <Text style={styles.localesGenLink}>Entre semana</Text>
                </TouchableOpacity>
                <Text style={styles.localesGenSep}>·</Text>
                <TouchableOpacity onPress={() => setDiasSemanaN([6, 7])}>
                  <Text style={styles.localesGenLink}>Fin de semana</Text>
                </TouchableOpacity>
              </View>
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
                    <MaterialIcons name={localesGenDropdownOpen ? 'expand-less' : 'expand-more'} size={22} color={colors.textMuted} />
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
                                color={on ? colors.accent : colors.textMuted}
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
              <View style={styles.horasSectionBox}>
                <View style={styles.horasChipsWrap}>
                  {horasN.map((h, idx) => (
                    <View key={`${h}-${idx}`} style={styles.horaChip}>
                      <MaterialIcons name="schedule" size={16} color={statusColors.info.text} />
                      <Text style={styles.horaChipText}>{h}</Text>
                      <TouchableOpacity
                        onPress={() => setHorasN(horasN.filter((_, i) => i !== idx))}
                        hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                        accessibilityLabel={`Quitar hora ${h}`}
                      >
                        <MaterialIcons name="close" size={18} color={statusColors.info.text} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
                <View style={styles.horaInputRow}>
                  <TextInput
                    style={styles.horaInputHora}
                    value={horaBorradorN}
                    onChangeText={setHoraBorradorN}
                    placeholder="HH:MM"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="default"
                    onSubmitEditing={añadirHoraDesdeBorrador}
                    returnKeyType="done"
                  />
                  <Pressable
                    style={({ pressed }) => [
                      styles.horaAddBtn,
                      !horaBorradorN.trim() && styles.horaAddBtnDisabled,
                      pressed && horaBorradorN.trim() ? { opacity: 0.88 } : null,
                    ]}
                    onPress={añadirHoraDesdeBorrador}
                    disabled={!horaBorradorN.trim()}
                    accessibilityRole="button"
                    accessibilityLabel="Añadir hora"
                  >
                    <View style={styles.horaAddBtnInner}>
                      <MaterialIcons name="add" size={18} color={colors.surface} />
                      <Text style={styles.horaAddBtnText}>Añadir</Text>
                    </View>
                  </Pressable>
                </View>
              </View>
              <View style={styles.resumenGenBox}>
                <Text style={styles.resumenGenText}>{resumenGenerarHuecos}</Text>
              </View>
              <Pressable
                style={[styles.saveBtn, (generando || fechasGenN.length === 0) && styles.saveBtnDis]}
                onPress={confirmarGenerarBase}
                disabled={generando || fechasGenN.length === 0}
              >
                {generando ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.saveBtnText}>Generar registros</Text>}
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
                <MaterialIcons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <View style={styles.modalBodyPadded}>
              <SelectorDesplegable
                label="Proveedor (etiqueta MUSICOS)"
                icono="local-shipping"
                placeholder="Selecciona proveedor…"
                tituloLista="Selecciona proveedor"
                iconoLista="local-shipping"
                loading={loadingEmpresasAsoc}
                buscador
                buscadorPlaceholder="Buscar por nombre o CIF…"
                vacioTexto="Ningún proveedor coincide"
                valorId={empresaAsocId || ''}
                opciones={empresasMusicos.map((e) => ({
                  id: e.id_empresa,
                  titulo: e.nombre,
                  subtitulo: e.cif || undefined,
                  icono: 'local-shipping' as const,
                }))}
                onSeleccionar={(id) => setEmpresaAsocId(id)}
              />

              <Text style={[styles.label, { marginTop: SPACING.md }]}>Facturas recibidas pendientes (según proveedor)</Text>
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
                        placeholderTextColor={colors.textMuted}
                        value={qFac}
                        onChangeText={setQFac}
                        onSubmitEditing={buscarFacturas}
                      />
                      <TouchableOpacity style={styles.asocFacSearchBtn} onPress={buscarFacturas}>
                        <Text style={styles.asocFacSearchBtnText}>Buscar</Text>
                      </TouchableOpacity>
                    </View>
                    {loadingFac ? <ActivityIndicator color={colors.accent} style={{ marginVertical: 10 }} /> : null}
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
                  <Text style={styles.asocCompareLabel}>Suma actuaciones seleccionadas</Text>
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
              <Text style={styles.modalTitle}>{puedeEditar ? 'Editar actuación' : 'Actuación'}</Text>
              <TouchableOpacity onPress={cerrarModalEdit}>
                <MaterialIcons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <SelectorDesplegable
                label="Artista"
                icono="person"
                placeholder="(sin asignar)"
                tituloLista="Selecciona artista"
                iconoLista="person"
                buscador
                buscadorPlaceholder="Buscar artista…"
                disabled={!puedeEditar}
                valorId={form.id_artista || ''}
                opciones={[
                  { id: '', titulo: '(sin asignar)' },
                  ...artistas.map((ar) => ({
                    id: ar.id_artista,
                    titulo: ar.nombre_artistico,
                    icono: 'person' as const,
                  })),
                ]}
                onSeleccionar={(id) => {
                  if (!id) {
                    setForm((f) => ({
                      ...f,
                      id_artista: '',
                      artista_nombre_snapshot: '',
                      importe_previsto: null,
                      importe_final: null,
                      franja: undefined,
                      tipo_dia: undefined,
                    }));
                    return;
                  }
                  const ar = artistas.find((a) => a.id_artista === id);
                  setForm((f) => ({
                    ...f,
                    id_artista: id,
                    artista_nombre_snapshot: ar?.nombre_artistico ?? f.artista_nombre_snapshot,
                  }));
                }}
              />
              <Text style={styles.label}>Fecha</Text>
              <InputFecha
                style={styles.input}
                valueIso={form.fecha || ''}
                editable={puedeEditar}
                onChangeIso={(iso) => setForm((f) => ({ ...f, fecha: iso }))}
              />
              <Text style={styles.label}>Hora inicio</Text>
              <TextInput
                style={styles.input}
                editable={puedeEditar}
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
                editable={puedeEditar}
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
                editable={puedeEditar}
                value={form.observaciones || ''}
                onChangeText={(t) => setForm((f) => ({ ...f, observaciones: t }))}
              />
              {actuacionTieneFacturaAsociada && puedeFacturacion ? (
                <View style={styles.desasocBox}>
                  <View style={styles.desasocRow}>
                    <View style={styles.desasocTextCol}>
                      <Text style={styles.desasocTitle}>Factura de gasto asociada</Text>
                      {form.pago_asociado_numero_factura?.trim() ? (
                        <Text style={styles.desasocLine} numberOfLines={2}>
                          Nº: {form.pago_asociado_numero_factura}
                          {form.pago_asociado_proveedor?.trim() ? ` · ${form.pago_asociado_proveedor}` : ''}
                        </Text>
                      ) : (
                        <Text style={styles.desasocLine} numberOfLines={1}>
                          Nº: —
                        </Text>
                      )}
                      {form.id_factura_gasto?.trim() ? (
                        <Text style={styles.desasocMeta} numberOfLines={1}>
                          ID factura: {String(form.id_factura_gasto).slice(0, 12)}
                          {String(form.id_factura_gasto).length > 12 ? '…' : ''}
                        </Text>
                      ) : (
                        <Text style={styles.desasocMeta} numberOfLines={1}>
                          ID factura: —
                        </Text>
                      )}
                    </View>
                    <TouchableOpacity
                      style={[styles.desasocBtn, saving && styles.desasocBtnDis]}
                      onPress={abrirConfirmDesasociar}
                      disabled={saving}
                      activeOpacity={0.85}
                    >
                      <MaterialIcons name="link-off" size={16} color={statusColors.warning.text} />
                      <Text style={styles.desasocBtnText} numberOfLines={2}>
                        Desasociar factura
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
              {mostrarSeccionFirma ? (
                <>
                  <View style={styles.firmaRow}>
                    <TouchableOpacity
                      style={[styles.firmaBtnHalf, !form.id_actuacion && styles.firmaBtnDis]}
                      onPress={() => form.id_actuacion && setModalFirma(true)}
                      disabled={!form.id_actuacion}
                      activeOpacity={0.82}
                    >
                      <MaterialIcons name="draw" size={22} color={form.id_actuacion ? statusColors.info.text : colors.textMuted} />
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
                      <MaterialIcons name="folder-open" size={22} color={form.id_actuacion ? statusColors.info.text : colors.textMuted} />
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
              {puedeEditar ? (
                <Pressable style={[styles.saveBtn, saving && styles.saveBtnDis]} onPress={guardarEdicion} disabled={saving}>
                  {saving ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.saveBtnText}>Guardar</Text>}
                </Pressable>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={modalDesasocConfirmOpen}
        transparent
        animationType="fade"
        onRequestClose={cerrarConfirmDesasociar}
      >
        <Pressable style={styles.desasocConfirmOverlay} onPress={cerrarConfirmDesasociar}>
          <Pressable style={styles.desasocConfirmCard} onPress={(e) => e.stopPropagation()}>
            <MaterialIcons name="link-off" size={36} color={colors.warning} style={{ alignSelf: 'center' }} />
            <Text style={styles.desasocConfirmTitle}>Desasociar factura</Text>
            <Text style={styles.desasocConfirmText}>
              Se quitará la vinculación con la factura de gasto. El estado de la actuación pasará a{' '}
              <Text style={{ fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight }}>pendiente</Text>.
            </Text>
            <View style={styles.desasocConfirmBtns}>
              <TouchableOpacity style={styles.cbCancel} onPress={cerrarConfirmDesasociar} disabled={saving}>
                <Text style={styles.cbCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.desasocConfirmBtnOk}
                onPress={confirmarDesasociarDesdeModal}
                disabled={saving}
              >
                <Text style={styles.desasocConfirmBtnOkText}>Desasociar</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={modalBorrarMultipleOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !borrando && setModalBorrarMultipleOpen(false)}
      >
        <Pressable style={styles.desasocConfirmOverlay} onPress={() => !borrando && setModalBorrarMultipleOpen(false)}>
          <Pressable style={styles.desasocConfirmCard} onPress={(e) => e.stopPropagation()}>
            <MaterialIcons name="delete-outline" size={36} color={colors.danger} style={{ alignSelf: 'center' }} />
            <Text style={styles.desasocConfirmTitle}>Eliminar actuaciones</Text>
            <Text style={styles.desasocConfirmText}>
              Se eliminarán{' '}
              <Text style={{ fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight }}>
                {selectedIds.size} {selectedIds.size === 1 ? 'actuación' : 'actuaciones'}
              </Text>{' '}
              seleccionada{selectedIds.size === 1 ? '' : 's'}. Esta acción no se puede deshacer.
            </Text>
            <View style={styles.desasocConfirmBtns}>
              <TouchableOpacity
                style={styles.cbCancel}
                onPress={() => setModalBorrarMultipleOpen(false)}
                disabled={borrando}
              >
                <Text style={styles.cbCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.borrarMultiConfirmBtnOk}
                onPress={() => void confirmarBorrarMultiple()}
                disabled={borrando}
              >
                {borrando ? (
                  <ActivityIndicator color={colors.surface} />
                ) : (
                  <Text style={styles.borrarMultiConfirmBtnOkText}>Eliminar</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
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
              <TouchableOpacity
                style={[styles.cbCancel, styles.conflictoBtnCol]}
                onPress={() => {
                  setConflictoOpen(false);
                  setPendingPutBody(null);
                }}
              >
                <Text style={styles.cbCancelText} numberOfLines={2}>
                  Cancelar
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.cbGuardarIgual, styles.conflictoBtnCol]} onPress={conflictoGuardarIgual}>
                <MaterialIcons name="warning" size={18} color={colors.surface} style={styles.cbGuardarIgualIcon} />
                <Text style={styles.cbGuardarIgualText} numberOfLines={2}>
                  Guardar igualmente
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.cbMover, styles.conflictoBtnCol]} onPress={conflictoMoverAqui}>
                <Text style={styles.cbMoverText} numberOfLines={2}>
                  Mover artista aquí
                </Text>
              </TouchableOpacity>
            </View>
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
      {ConfirmarView}
      </>
      )}
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;
/** Entre radius.lg (12) y radius.xl (16). */
const RADIO_TARJETA = 14;

const styles = StyleSheet.create({
  screenWrap: { flex: 1, minHeight: 0, backgroundColor: colors.bg },
  sinPermisoBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: 24 },
  sinPermisoText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center' },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    position: 'relative',
    zIndex: 30,
    elevation: 30,
  },
  topBarStack: { flexDirection: 'column', alignItems: 'stretch', gap: SPACING.sm },
  topBarGrupo: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  topBarTitle: { fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  topBarFiltros: { flexWrap: 'wrap', gap: SPACING.md, position: 'relative', zIndex: 31 },
  topBarFiltrosStack: { alignItems: 'stretch' },
  topBarAcciones: { marginLeft: 'auto' },
  iconBtn: { alignItems: 'center', justifyContent: 'center', borderRadius: RADIO_MEDIO },
  iconBtnBorde: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  periodoNav: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, flexWrap: 'wrap' },
  periodoTexto: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong, minWidth: 150, textAlign: 'center' },
  hoyLink: { justifyContent: 'center', paddingHorizontal: SPACING.sm },
  hoyLinkText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  segmentado: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.navActive,
    borderRadius: RADIO_MEDIO,
    padding: 2,
  },
  segmentoOpt: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  segmentoOptPeq: { paddingHorizontal: 10 },
  segmentoOptOn: { backgroundColor: colors.surface, borderColor: colors.border },
  segmentoText: { fontSize: fontSizes[13], fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight, color: colors.textMuted },
  segmentoTextOn: { color: colors.textStrong, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  btnSecundario: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  btnSecundarioText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong },
  btnPrimario: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accent,
  },
  btnPrimarioText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  btnPeligro: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: colors.surface,
  },
  btnPeligroText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.danger },
  btnTexto: { justifyContent: 'center', paddingHorizontal: SPACING.sm },
  btnTextoText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  btnTextoEnlace: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  ayudaSeleccion: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.warning },
  btnOff: { opacity: 0.45 },

  resumen: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: 28,
    paddingHorizontal: SPACING.lg,
    paddingTop: 16,
    paddingBottom: 8,
  },
  /** 26 px: entre fontSizes[24] y fontSizes[30]. */
  resumenHuecos: { fontSize: 26, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.warning, fontVariant: ['tabular-nums'] },
  resumenSub: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: 2 },
  resumenItem: { paddingBottom: 2 },
  resumenCifra: { fontSize: 17, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong, fontVariant: ['tabular-nums'] },
  resumenEtiqueta: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted },

  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.md,
    marginHorizontal: 16,
    marginTop: SPACING.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIO_MEDIO,
    backgroundColor: statusColors.danger.bg,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorBarText: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger },
  errorBarRetry: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.danger },

  herramientas: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  herramientasStack: { flexDirection: 'column', alignItems: 'stretch' },
  herramientasAcciones: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm },
  herramientasAccionesDer: { marginLeft: 'auto' },
  buscador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 200,
    maxWidth: 320,
    flexGrow: 1,
    flexShrink: 1,
    paddingHorizontal: 10,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  buscadorInput: { flex: 1, minWidth: 0, fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textStrong, paddingVertical: 0 },

  cuerpo: {
    flex: 1,
    minHeight: 0,
    flexDirection: 'row',
    gap: 16,
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.lg,
    position: 'relative',
    zIndex: 0,
  },
  cuerpoStack: { flexDirection: 'column' },
  listaCol: { flexGrow: 62, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  listaColStack: { flex: 1, minHeight: 0 },
  listaScrollInner: { flex: 1 },
  listaContenido: { paddingTop: 4, paddingBottom: SPACING.lg },
  estadoBox: { paddingVertical: 48, alignItems: 'center', justifyContent: 'center' },
  tarjetaVacia: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 32,
    paddingHorizontal: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
  },
  tarjetaVaciaText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center' },
  tarjeta: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: SPACING.md,
    overflow: 'hidden',
  },
  tarjetaHoy: { borderColor: colors.accent },
  tarjetaCab: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingTop: 12,
  },
  tarjetaCabIzq: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flexShrink: 0 },
  tarjetaDia: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  etiquetaHoy: { backgroundColor: colors.accentMuted, borderRadius: radius.pill, paddingHorizontal: SPACING.sm, paddingVertical: 2 },
  etiquetaHoyText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  tarjetaLocal: { flexShrink: 1, fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, textAlign: 'right' },
  tarjetaSub: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingTop: 2,
  },
  tarjetaSubText: { flex: 1, minWidth: 0, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  tarjetaSubPct: { fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  tarjetaGasto: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong, fontVariant: ['tabular-nums'] },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    minHeight: 56,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    marginTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: colors.navActive,
  },
  filaSel: { backgroundColor: colors.accentMuted },
  filaPressed: { backgroundColor: colors.bg },
  filaCheck: { width: 24, alignItems: 'center' },
  filaHora: { width: 44, fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, fontVariant: ['tabular-nums'] },
  filaCentro: { flex: 1, minWidth: 0 },
  filaLinea: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 10, rowGap: 4 },
  filaNombre: { flexShrink: 1, fontSize: fontSizes[16], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong },
  filaImporte: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, fontVariant: ['tabular-nums'] },
  filaPago: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginTop: 2 },
  filaSinArtista: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted },
  filaAcciones: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, flexShrink: 0 },
  pastilla: { borderRadius: radius.pill, paddingHorizontal: SPACING.sm, paddingVertical: 2 },
  pastillaText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  pastillaFirmada: { backgroundColor: statusColors.success.bg },
  pastillaFirmadaText: { color: colors.success },
  pastillaAsociada: { backgroundColor: colors.accentMuted },
  pastillaAsociadaText: { color: statusColors.info.text },
  pastillaPendiente: { backgroundColor: colors.navActive },
  pastillaPendienteText: { color: colors.textPrimary },
  btnAsignar: {
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surface,
  },
  btnAsignarText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.warning },
  accionTexto: { justifyContent: 'center', minHeight: 34, paddingHorizontal: SPACING.sm },
  accionTextoFirmar: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },

  panelCalendario: {
    flexGrow: 38,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: SPACING.md,
    overflow: 'hidden',
  },
  panelCalendarioStack: { flex: 0, height: 560, marginTop: SPACING.xs },

  filterLocalDropdownWrap: {
    minWidth: 180,
    maxWidth: 260,
    flexGrow: 1,
    flexShrink: 1,
    position: 'relative',
    zIndex: 40,
    elevation: 40,
    overflow: 'visible',
  },
  filterToolbarTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
  },
  filterToolbarTriggerText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textStrong, flex: 1 },
  filterToolbarList: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '100%',
    marginTop: SPACING.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.surface,
    maxHeight: 260,
    zIndex: 41,
    ...(Platform.OS === 'web'
      ? ({ boxShadow: '0 8px 24px rgba(15, 23, 42, 0.08)' } as object)
      : { elevation: 41, shadowColor: colors.textStrong, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.08, shadowRadius: 16 }),
  },
  filterToolbarScroll: { maxHeight: 250 },
  filterToolbarOpt: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH,
    paddingVertical: 10,
    paddingHorizontal: SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.navActive,
  },
  filterToolbarOptOn: { backgroundColor: colors.accentMuted },
  filterToolbarOptText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, flex: 1, paddingRight: SPACING.sm },
  firmaRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: SPACING.md,
    alignItems: 'stretch',
  },
  firmaBtnHalf: {
    flex: 1,
    minHeight: 72,
    paddingVertical: SPACING.md,
    paddingHorizontal: 10,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: '#7dd3fc',
    backgroundColor: colors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: SPACING.xs,
  },
  firmaBtnHalfTitle: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text, textAlign: 'center' },
  firmaBtnDis: { opacity: 0.55, borderColor: colors.border, backgroundColor: colors.bg },
  firmaBtnTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text, textAlign: 'center' },
  firmaBtnTitleDis: { color: colors.textMuted },
  firmaBtnHint: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, textAlign: 'center', marginTop: SPACING.sm },
  firmaBloqueadaHint: {
    fontFamily: fontFamily.regular, fontSize: fontSizes[12],
    color: colors.textMuted,
    marginTop: 10,
    lineHeight: 18,
    fontStyle: 'italic',
  },
  hintImporte: { fontFamily: fontFamily.regular, fontSize: fontSizes.badge, color: colors.textMuted, lineHeight: 14, marginTop: 6, marginBottom: 2 },
  importeSugeridoLine: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginBottom: SPACING.xs, marginTop: 2 },
  importeSugeridoVal: { fontVariant: ['tabular-nums'], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  importeInputMayor: { borderColor: colors.danger, color: colors.danger, backgroundColor: statusColors.danger.bg },
  importeInputMenor: { borderColor: '#22c55e', color: colors.success, backgroundColor: '#f0fdf4' },
  /** Más oscuro que colors.overlay. */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: RADIO_TARJETA,
    maxHeight: '92%',
    overflow: 'hidden',
  },
  modalBodyPadded: { paddingHorizontal: SPACING.lg, paddingBottom: SPACING.lg },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalTitle: { fontSize: 17, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  modalScroll: { padding: SPACING.lg, maxHeight: 480 },
  label: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, marginBottom: SPACING.xs, marginTop: SPACING.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    padding: 10,
    fontFamily: fontFamily.regular, fontSize: fontSizes[14],
    backgroundColor: colors.bg,
    color: colors.textPrimary,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: 6,
  },
  fieldDropdown: { marginBottom: SPACING.xs, zIndex: 2 },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.md,
    paddingHorizontal: 14,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
  },
  dropdownTriggerText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary, flex: 1, paddingRight: SPACING.sm },
  dropdownPlaceholder: { color: colors.textMuted },
  dropdownList: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  dropdownToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  dropdownCount: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted },
  dropdownScroll: { maxHeight: 220 },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.navActive,
  },
  dropdownOptionSelected: { backgroundColor: colors.accentMuted },
  dropdownOptionText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, flex: 1 },
  dropdownOptionTextSelected: { color: statusColors.info.text, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  localesGenLink: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  localesGenSep: { color: colors.textMuted, fontFamily: fontFamily.regular, fontSize: fontSizes[12] },
  diasSemanaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  diaSemanaBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  diaSemanaBtnOn: { backgroundColor: colors.accentMuted, borderColor: colors.accent },
  diaSemanaBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  diaSemanaBtnTextOn: { color: statusColors.info.text },
  diasSemanaAtajos: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: SPACING.sm, marginBottom: SPACING.xs },
  resumenGenBox: {
    backgroundColor: colors.bg,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    padding: SPACING.md,
    marginTop: SPACING.md,
  },
  resumenGenText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textStrong },
  chipOn: { backgroundColor: colors.accentMuted, borderColor: colors.accent },
  chipText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textPrimary },
  horasSectionBox: {
    backgroundColor: colors.navActive,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    marginBottom: SPACING.xs,
  },
  horasChipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginBottom: 10,
  },
  horaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accentMuted,
    borderWidth: 1,
    borderColor: '#7dd3fc',
    borderRadius: RADIO_MEDIO,
    paddingVertical: 6,
    paddingHorizontal: 10,
    gap: 6,
  },
  horaChipText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  horaInputRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  horaInputHora: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    paddingHorizontal: 10,
    fontFamily: fontFamily.regular, fontSize: fontSizes[13],
    backgroundColor: colors.surface,
    color: colors.textPrimary,
  },
  horaAddBtn: {
    backgroundColor: colors.accent,
    borderRadius: RADIO_MEDIO,
    paddingVertical: 10,
    paddingHorizontal: SPACING.md,
    justifyContent: 'center',
  },
  horaAddBtnDisabled: { opacity: 0.45 },
  horaAddBtnInner: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  horaAddBtnText: { color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontSize: fontSizes[13] },
  hint: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginBottom: SPACING.sm },
  saveBtn: { backgroundColor: colors.accent, borderRadius: radius.md, padding: 14, alignItems: 'center', marginTop: SPACING.lg },
  saveBtnDis: { opacity: 0.6 },
  saveBtnText: { color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontSize: fontSizes[16] },
  facRow: { padding: SPACING.md, borderBottomWidth: 1, borderBottomColor: colors.navActive },
  facRowOn: { backgroundColor: colors.accentMuted },
  facTitle: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  facSub: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginTop: 2 },
  asocFacListBox: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: '#fafafa',
    padding: SPACING.sm,
    minHeight: 120,
  },
  asocFacListEmpty: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, lineHeight: 18, paddingVertical: SPACING.sm },
  asocFacSearchRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: 6 },
  asocFacSearchInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 10,
    fontFamily: fontFamily.regular, fontSize: fontSizes[13],
    backgroundColor: colors.surface,
    color: colors.textPrimary,
  },
  asocFacSearchBtn: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accentMuted,
  },
  asocFacSearchBtnText: { color: statusColors.info.text, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontSize: fontSizes[12] },
  asocFacScroll: { maxHeight: 220 },
  asocCompareBox: {
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
    padding: SPACING.md,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  asocCompareTitle: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, textTransform: 'uppercase', marginBottom: SPACING.sm },
  asocCompareRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  asocCompareLabel: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, flex: 1 },
  asocCompareVal: { fontVariant: ['tabular-nums'], fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  asocCompareDiff: { fontVariant: ['tabular-nums'], fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, marginTop: SPACING.xs },
  asocCompareOk: { color: statusColors.success.text },
  asocCompareWarn: { color: '#c2410c' },
  asocCompareHint: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, fontStyle: 'italic', marginTop: SPACING.xs },
  localReadonly: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, paddingVertical: SPACING.sm },
  desasocBox: {
    marginTop: SPACING.sm,
    marginBottom: SPACING.xs,
    paddingVertical: 10,
    paddingHorizontal: SPACING.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#fde68a',
    backgroundColor: statusColors.warning.bg,
  },
  desasocRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  desasocTextCol: { flex: 1, minWidth: 0 },
  desasocTitle: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: '#92400e', marginBottom: SPACING.xs },
  desasocLine: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: '#78350f', marginBottom: 2 },
  desasocMeta: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: '#a16207' },
  desasocBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    gap: 6,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 10,
    maxWidth: 132,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: '#fbbf24',
    backgroundColor: '#fff7ed',
  },
  desasocBtnDis: { opacity: 0.55 },
  desasocBtnText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.warning.text, flexShrink: 1 },
  desasocConfirmOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    padding: 20,
  },
  desasocConfirmCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: colors.surface,
    borderRadius: RADIO_TARJETA,
    padding: 20,
  },
  /** 17 px: entre fontSizes[16] y fontSizes[18]. */
  desasocConfirmTitle: {
    fontSize: 17,
    fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
  desasocConfirmText: {
    fontFamily: fontFamily.regular, fontSize: fontSizes[14],
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 20,
  },
  desasocConfirmBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 20,
    flexWrap: 'wrap',
  },
  desasocConfirmBtnOk: {
    paddingVertical: 10,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.warning,
    borderWidth: 1,
    borderColor: colors.warning,
    minWidth: 120,
    alignItems: 'center',
  },
  desasocConfirmBtnOkText: { fontSize: fontSizes[14], color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  borrarMultiConfirmBtnOk: {
    paddingVertical: 10,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.danger,
    borderWidth: 1,
    borderColor: statusColors.danger.text,
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  borrarMultiConfirmBtnOkText: { fontSize: fontSizes[14], color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  conflictoCard: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: colors.surface,
    borderRadius: RADIO_TARJETA,
    padding: 20,
    alignSelf: 'center',
  },
  conflictoTitle: { fontSize: 17, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, textAlign: 'center', marginTop: SPACING.sm },
  conflictoText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center', marginTop: SPACING.sm, lineHeight: 20 },
  conflictoBox: { marginTop: SPACING.md, padding: SPACING.md, backgroundColor: colors.bg, borderRadius: RADIO_MEDIO, borderWidth: 1, borderColor: colors.border },
  conflictoSub: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, textTransform: 'uppercase', marginBottom: 6 },
  conflictoDetail: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, marginBottom: SPACING.xs },
  conflictoBtns: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginTop: SPACING.lg,
    alignItems: 'stretch',
    flexWrap: 'nowrap',
    justifyContent: 'space-between',
  },
  conflictoBtnCol: { flex: 1, minWidth: 0, justifyContent: 'center' },
  cbCancel: { paddingVertical: 10, paddingHorizontal: SPACING.sm, borderRadius: RADIO_MEDIO, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  cbCancelText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontSize: fontSizes[12], textAlign: 'center' },
  cbGuardarIgual: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.danger,
    borderWidth: 1,
    borderColor: statusColors.danger.text,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
  },
  cbGuardarIgualIcon: { flexShrink: 0 },
  cbGuardarIgualText: { color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontSize: fontSizes[12], textAlign: 'center', flexShrink: 1 },
  cbMover: {
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: '#f59e0b',
    backgroundColor: statusColors.warning.bg,
  },
  cbMoverText: { color: statusColors.warning.text, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontSize: fontSizes[12], textAlign: 'center' },
});
