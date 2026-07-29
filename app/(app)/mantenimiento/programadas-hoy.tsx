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
import { useConfirmar } from '../../hooks/useConfirmar';
import { useTarifasMantenimiento } from '../../hooks/useTarifasMantenimiento';
import {
  cierreSinFacturaDeParte,
  facturaMantenimientoDeParte,
} from '../../lib/mantenimientoFacturacion';
import { BREAKPOINTS, MIN_TOUCH } from '../../constants/layout';
import {
  getPrioridadOrden,
  getPrioridadColor,
  getPrioridadLabel,
  contarUrgentes,
  formatearFechaIncidencia,
  formatearDuracionTrabajo,
  incidenciaEstaProgramada,
  segundosTrabajo,
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

/** Segundos de trabajo ya cerrados; 0 en incidencias antiguas sin el campo. */
function trabajoSegundosDe(inc: Incidencia): number {
  const n = Number(inc.trabajo_segundos);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** ISO del tramo de trabajo abierto; cadena vacía si el cronómetro está parado. */
function trabajoEnCursoDe(inc: Incidencia): string {
  return (inc.trabajo_en_curso_desde ?? '').toString().trim();
}

function fmtNum(n: number): string {
  return n.toLocaleString('es-ES', { maximumFractionDigits: 2 });
}

/**
 * Bloque `desplazamiento` de la respuesta al valorar: el viaje del técnico se
 * cobra una vez por local y día, así que el servidor lo reparte entre los partes
 * de ese día y devuelve el reparto aplicado. Solo viene cuando ha repartido.
 */
function leerRepartoDesplazamiento(data: unknown): {
  kmTotales: number | null;
  partes: number;
  kmImputados: number | null;
  importe: number | null;
} | null {
  const bloque = (data as { desplazamiento?: unknown } | null)?.desplazamiento;
  if (!bloque || typeof bloque !== 'object') return null;
  const obj = bloque as Record<string, unknown>;
  // Cero es un dato válido (un parte puede quedarse sin kilómetros al repartir).
  const num = (clave: string): number | null => {
    const n = Number(obj[clave]);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const partes = num('partes');
  const kmImputados = num('km_imputados');
  const precioKm = num('precio_km');
  const importe = num('importe_imputado');
  return {
    kmTotales: num('km_totales'),
    partes: partes != null && partes >= 1 ? Math.round(partes) : 1,
    kmImputados,
    importe:
      importe ??
      (kmImputados != null && precioKm != null
        ? Math.round(kmImputados * precioKm * 100) / 100
        : null),
  };
}

/**
 * Aviso del prorrateo tras guardar: solo se muestra si el servidor ha imputado
 * algo distinto de lo que el usuario vio en el formulario.
 */
function mensajeReparto(data: unknown, lineas: LineaValoracionInput[]): string | null {
  const reparto = leerRepartoDesplazamiento(data);
  if (!reparto) return null;
  const kmEnviados = lineas.find((l) => l.tipo === 'desplazamiento')?.cantidad ?? null;
  const kmDistintos =
    kmEnviados != null &&
    reparto.kmImputados != null &&
    Math.abs(reparto.kmImputados - kmEnviados) >= 0.01;
  if (reparto.partes <= 1 && !kmDistintos) return null;
  const imputado =
    [
      reparto.kmImputados != null ? `${fmtNum(reparto.kmImputados)} km` : null,
      reparto.importe != null ? `${fmtNum(reparto.importe)} € sin IVA` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'la parte proporcional';
  const trayecto = reparto.kmTotales != null ? ` de un viaje de ${fmtNum(reparto.kmTotales)} km` : '';
  if (reparto.partes > 1) {
    return `El desplazamiento se ha repartido entre ${reparto.partes} partes de ese día en el local: a esta reparación se le han imputado ${imputado}${trayecto}.`;
  }
  return `Desplazamiento imputado a esta reparación: ${imputado}${trayecto}.`;
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
    factura: facturaMantenimientoDeParte(inc),
    cierre: cierreSinFacturaDeParte(inc),
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
  const [avisoReparto, setAvisoReparto] = useState<string | null>(null);
  const [expandedPhotoUri, setExpandedPhotoUri] = useState<string | null>(null);
  const [detalleIncidencia, setDetalleIncidencia] = useState<MantenimientoIncidenciaDetalle | null>(null);
  const [expandedLocals, setExpandedLocals] = useState<Set<string>>(new Set());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [trabajoOcupadoKey, setTrabajoOcupadoKey] = useState<string | null>(null);
  const [errorTrabajo, setErrorTrabajo] = useState<string | null>(null);
  const { confirmar, ConfirmarView } = useConfirmar();
  const { tarifas, loading: cargandoTarifas } = useTarifasMantenimiento();
  const webDateInputRef = useRef<HTMLInputElement>(null);
  // Evita que una doble pulsación abra dos tramos antes de que el botón se bloquee.
  const trabajoEnVueloRef = useRef(false);

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

  /**
   * Km de ida desde la sede central hasta el local de la reparación que se está
   * valorando: vienen en `/api/locales?minimal=1`, que es lo que ya pide el
   * contexto, así que no hace falta pedir la ficha completa ni cachear nada
   * (una caché propia serviría kilómetros viejos si alguien los corrige).
   * `null` = local todavía no cargado; cadena vacía = local sin kilómetros
   * informados, que el técnico teclea a mano.
   */
  const kmValoracion = useMemo<string | null>(() => {
    if (!valorandoInc) return null;
    const localId = (valorandoInc.local_id ?? '').toString().trim();
    if (!localId) return '';
    const local = locales.find(
      (l) => (valorEnLocal(l, 'id_Locales') ?? '').toString().trim() === localId,
    );
    if (!local) return null;
    return (valorEnLocal(local, 'km_desplazamiento') ?? '').trim();
  }, [valorandoInc, locales]);

  /**
   * Recarga la lista y la devuelve. En modo silencioso no toca el error global
   * (que taparía la pantalla): el fallo lo comunica quien la llama.
   */
  const cargarIncidencias = useCallback(
    async (opciones?: { silencioso?: boolean }): Promise<Incidencia[] | null> => {
      const silencioso = opciones?.silencioso === true;
      try {
        const res = await apiFetch('/api/mantenimiento/incidencias');
        const data = (await res.json()) as { incidencias?: Incidencia[]; error?: string };
        if (data.error) {
          if (!silencioso) setError(data.error);
          return null;
        }
        const list = (data.incidencias || []).filter((i) => {
          const lid = (i.local_id ?? '').toString().trim();
          return !lid || lid in mapLocalIdToNombre;
        });
        setTodasIncidencias(list);
        if (!silencioso) setError(null);
        return list;
      } catch (e) {
        if (!silencioso) setError(e instanceof Error ? e.message : 'Error de conexión');
        return null;
      } finally {
        if (!silencioso) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [mapLocalIdToNombre],
  );

  const refetch = useCallback(() => {
    void cargarIncidencias();
  }, [cargarIncidencias]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refetch();
  }, [refetch]);

  /** Aplica al estado local el cronómetro que devuelve el backend, sin recargar la lista. */
  const aplicarTrabajo = useCallback(
    (key: string, trabajo: { en_curso_desde?: string | null; segundos?: number }) => {
      const segundos = Number(trabajo.segundos);
      const enCurso = (trabajo.en_curso_desde ?? '').toString().trim();
      setTodasIncidencias((prev) =>
        prev.map((i) =>
          incidenciaKey(i) === key
            ? {
                ...i,
                trabajo_segundos: Number.isFinite(segundos) && segundos > 0 ? segundos : 0,
                trabajo_en_curso_desde: enCurso || undefined,
              }
            : i,
        ),
      );
    },
    [],
  );

  const cambiarTrabajo = useCallback(
    async (
      inc: Incidencia,
      accion: 'iniciar' | 'finalizar',
    ): Promise<{ en_curso_desde?: string | null; segundos?: number } | null> => {
      const localId = (inc.local_id ?? '').toString().trim();
      const idIncidencia = (inc.id_incidencia ?? '').toString().trim();
      const fechaCreacion = (inc.fecha_creacion ?? '').toString().trim();
      if (!localId || !idIncidencia || !fechaCreacion) return null;
      if (trabajoEnVueloRef.current) return null;
      trabajoEnVueloRef.current = true;
      const key = incidenciaKey(inc);
      setTrabajoOcupadoKey(key);
      setErrorTrabajo(null);
      try {
        const res = await apiFetch('/api/mantenimiento/incidencias', {
          method: 'PATCH',
          body: JSON.stringify({
            local_id: localId,
            id_incidencia: idIncidencia,
            fecha_creacion: fechaCreacion,
            ...(accion === 'iniciar' ? { iniciar_trabajo: true } : { finalizar_trabajo: true }),
          }),
        });
        const data = (await res.json()) as {
          trabajo?: { en_curso_desde?: string | null; segundos?: number };
          error?: string;
        };
        if (!res.ok || !data.trabajo) {
          setErrorTrabajo(
            data.error ??
              (accion === 'iniciar'
                ? 'No se pudo iniciar el cronómetro'
                : 'No se pudo parar el cronómetro'),
          );
          // El servidor puede haber escrito aunque la respuesta sea de error
          // (o el cliente haber cortado por timeout): la lista manda.
          void cargarIncidencias({ silencioso: true });
          return null;
        }
        aplicarTrabajo(key, data.trabajo);
        return data.trabajo;
      } catch (e) {
        setErrorTrabajo(e instanceof Error ? e.message : 'Error de conexión');
        void cargarIncidencias({ silencioso: true });
        return null;
      } finally {
        trabajoEnVueloRef.current = false;
        setTrabajoOcupadoKey(null);
      }
    },
    [aplicarTrabajo, cargarIncidencias],
  );

  const abrirValoracion = useCallback(
    async (inc: Incidencia) => {
      if (trabajoEnVueloRef.current) {
        setErrorTrabajo('Espera a que termine la operación del cronómetro e inténtalo de nuevo');
        return;
      }
      const key = incidenciaKey(inc);
      setErrorTrabajo(null);
      setAvisoReparto(null);
      setMarcandoReparadoKey(key);
      let actual: Incidencia;
      try {
        // Nunca se decide con el estado local: una respuesta perdida del PATCH
        // dejaría un tramo abierto en el servidor y valoraríamos sin mano de obra.
        const lista = await cargarIncidencias({ silencioso: true });
        const fresca = lista?.find((i) => incidenciaKey(i) === key);
        if (!fresca) {
          setErrorTrabajo(
            'No se pudo comprobar el estado del cronómetro. Recarga e inténtalo de nuevo',
          );
          return;
        }
        actual = fresca;
      } finally {
        setMarcandoReparadoKey(null);
      }

      const enCursoDesde = trabajoEnCursoDe(actual);
      if (!enCursoDesde) {
        setErrorValoracion(null);
        setValorandoInc(actual);
        return;
      }

      // El tiempo del tramo abierto se factura: se cierra antes de valorar.
      const transcurrido = formatearDuracionTrabajo(
        segundosTrabajo(trabajoSegundosDe(actual), enCursoDesde, Date.now()),
      );
      const confirmado = await confirmar(
        'Cronómetro en marcha',
        `El cronómetro sigue en marcha (${transcurrido}). Se parará y el tiempo se pasará a la valoración.`,
        { confirmarLabel: 'Parar y valorar' },
      );
      if (!confirmado) return;
      const trabajo = await cambiarTrabajo(actual, 'finalizar');
      if (!trabajo) return;
      const segundos = Number(trabajo.segundos);
      setErrorValoracion(null);
      setValorandoInc({
        ...actual,
        trabajo_segundos: Number.isFinite(segundos) && segundos > 0 ? segundos : 0,
        trabajo_en_curso_desde: undefined,
      });
    },
    [cambiarTrabajo, cargarIncidencias, confirmar],
  );

  const guardarValoracion = useCallback(
    async (lineas: LineaValoracionInput[]) => {
      const inc = valorandoInc;
      if (!inc) return;
      const localId = (inc.local_id ?? '').toString().trim();
      const idIncidencia = (inc.id_incidencia ?? '').toString().trim();
      const fechaCreacion = (inc.fecha_creacion ?? '').toString().trim();
      if (!localId || !idIncidencia || !fechaCreacion) return;
      const key = incidenciaKey(inc);

      // No se bloquea valorar sin mano de obra (material suelto, reparaciones
      // anteriores al cronómetro), pero sí se avisa para que no sea un olvido.
      if (!lineas.some((l) => l.tipo === 'mano_obra')) {
        const seguir = await confirmar(
          'Valoración sin mano de obra',
          'Esta valoración no incluye ninguna línea de mano de obra. ¿Quieres guardarla así?',
          { confirmarLabel: 'Guardar igualmente', cancelarLabel: 'Volver' },
        );
        if (!seguir) return;
      }

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
        setAvisoReparto(mensajeReparto(data, lineas));
        setValorandoInc(null);
        refetch();
      } catch (e) {
        setErrorValoracion(e instanceof Error ? e.message : 'Error de conexión');
      } finally {
        setGuardandoValoracion(false);
        setMarcandoReparadoKey(null);
      }
    },
    [valorandoInc, refetch, confirmar],
  );

  const incidencias = useMemo(() => {
    return todasIncidencias.filter((i) => {
      if ((i.estado ?? '') === 'CANCELADA') return false;
      return extraerFechaProgramada(i) === fechaSeleccionada;
    });
  }, [todasIncidencias, fechaSeleccionada]);

  /**
   * Cronómetros en marcha fuera de la fecha visible: sin este aviso un tramo
   * olvidado sigue sumando horas sin que nadie lo vea. El más antiguo primero.
   */
  const trabajosOtrasFechas = useMemo(() => {
    return todasIncidencias
      .filter(
        (i) =>
          (i.estado ?? '') !== 'CANCELADA' &&
          trabajoEnCursoDe(i) !== '' &&
          extraerFechaProgramada(i) !== fechaSeleccionada,
      )
      .sort((a, b) => trabajoEnCursoDe(a).localeCompare(trabajoEnCursoDe(b)));
  }, [todasIncidencias, fechaSeleccionada]);

  const avisoTrabajo = useMemo(() => {
    const primero = trabajosOtrasFechas[0];
    if (!primero) return null;
    const fecha = extraerFechaProgramada(primero);
    const texto =
      trabajosOtrasFechas.length === 1
        ? `«${(primero.titulo ?? '—').toString()}» tiene el cronómetro en marcha desde el ${formatearFechaIncidencia(trabajoEnCursoDe(primero))}`
        : `${trabajosOtrasFechas.length} reparaciones tienen el cronómetro en marcha en otras fechas`;
    return { texto, fecha };
  }, [trabajosOtrasFechas]);

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
          trabajoSegundos={trabajoSegundosDe(inc)}
          trabajoEnCursoDesde={trabajoEnCursoDe(inc) || undefined}
          trabajoOcupado={trabajoOcupadoKey === key}
          onIniciarTrabajo={() => void cambiarTrabajo(inc, 'iniciar')}
          onFinalizarTrabajo={() => void cambiarTrabajo(inc, 'finalizar')}
          onReparar={() => void abrirValoracion(inc)}
          onVerDetalle={() => setDetalleIncidencia(incidenciaADetalle(inc, localNombre))}
          onFotoPress={setExpandedPhotoUri}
          resolverUriFoto={resolverUriFoto}
          formatearFecha={formatearFechaIncidencia}
        />
      );
    },
    [marcandoReparadoKey, abrirValoracion, mapLocalIdToNombre, trabajoOcupadoKey, cambiarTrabajo],
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

      {errorTrabajo ? (
        <View style={styles.avisoError}>
          <MaterialIcons name="error-outline" size={16} color="#dc2626" />
          <Text style={styles.avisoErrorText}>{errorTrabajo}</Text>
          <TouchableOpacity
            onPress={() => {
              setErrorTrabajo(null);
              onRefresh();
            }}
            style={styles.avisoAccionBtn}
            accessibilityLabel="Recargar reparaciones"
          >
            {refreshing ? (
              <ActivityIndicator size="small" color="#dc2626" />
            ) : (
              <>
                <MaterialIcons name="refresh" size={15} color="#dc2626" />
                <Text style={styles.avisoAccionText}>Recargar</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setErrorTrabajo(null)}
            style={styles.avisoCerrarBtn}
            accessibilityLabel="Cerrar aviso"
          >
            <MaterialIcons name="close" size={16} color="#dc2626" />
          </TouchableOpacity>
        </View>
      ) : null}

      {avisoReparto ? (
        <View style={styles.avisoInfo}>
          <MaterialIcons name="directions-car" size={16} color="#0369a1" />
          <Text style={styles.avisoInfoText}>{avisoReparto}</Text>
          <TouchableOpacity
            onPress={() => setAvisoReparto(null)}
            style={styles.avisoCerrarBtn}
            accessibilityLabel="Cerrar aviso"
          >
            <MaterialIcons name="close" size={16} color="#0369a1" />
          </TouchableOpacity>
        </View>
      ) : null}

      {avisoTrabajo ? (
        <View style={styles.avisoCrono}>
          <MaterialIcons name="timer" size={16} color="#b45309" />
          <Text style={styles.avisoCronoText}>{avisoTrabajo.texto}</Text>
          {avisoTrabajo.fecha ? (
            <TouchableOpacity
              onPress={() => setFechaSeleccionada(avisoTrabajo.fecha)}
              style={styles.avisoAccionBtn}
              accessibilityLabel={`Ir al ${labelFechaLarga(avisoTrabajo.fecha)}`}
            >
              <MaterialIcons name="event" size={15} color="#b45309" />
              <Text style={styles.avisoCronoAccionText}>
                Ir al {avisoTrabajo.fecha.slice(8, 10)}/{avisoTrabajo.fecha.slice(5, 7)}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

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
        trabajoSegundos={valorandoInc ? trabajoSegundosDe(valorandoInc) : 0}
        precioHora={cargandoTarifas ? null : tarifas.importeHora}
        precioKm={cargandoTarifas ? null : tarifas.precioKm}
        kmDesplazamiento={kmValoracion}
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

      {/* Último del árbol: su portal se monta después del modal de valoración
          y así el diálogo queda por encima cuando se pide confirmación. */}
      {ConfirmarView}
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
  avisoError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    paddingVertical: 8,
    paddingLeft: 10,
    paddingRight: 4,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
  },
  avisoErrorText: { flex: 1, minWidth: 0, fontSize: 12, color: '#dc2626' },
  avisoCrono: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    paddingVertical: 4,
    paddingLeft: 10,
    paddingRight: 4,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
  },
  avisoCronoText: { flex: 1, minWidth: 0, fontSize: 12, color: '#b45309' },
  avisoInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    paddingVertical: 4,
    paddingLeft: 10,
    paddingRight: 4,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 8,
  },
  avisoInfoText: { flex: 1, minWidth: 0, fontSize: 12, color: '#0369a1' },
  avisoCronoAccionText: { fontSize: 12, fontWeight: '700', color: '#b45309' },
  avisoAccionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 8,
    flexShrink: 0,
  },
  avisoAccionText: { fontSize: 12, fontWeight: '700', color: '#dc2626' },
  avisoCerrarBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
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
