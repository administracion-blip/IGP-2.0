/**
 * Agenda de Inicio: semana tipo Google Calendar (rejilla horaria) o mes con
 * tareas, reuniones y proyectos. Reutiliza las APIs ya filtradas por servidor;
 * el color distingue el tipo, no el departamento.
 */
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
  Platform,
  Modal,
  Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../constants/layout';
import { tasksUi } from '../constants/tasksUiTokens';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useAccesoTasks } from '../hooks/useAccesoTasks';
import { puedeEditarProyectos, puedeGestionarReuniones, puedeVerProyectos, puedeVerReuniones } from '../lib/tasksAcceso';
import { AltaHuecoAgenda, type HuecoAgenda } from './tasks/AltaHuecoAgenda';
import { desplazarTramo } from './tasks/InputHora';
import { BotonCrearAgendaInicio } from './tasks/BotonCrearAgendaInicio';
import { ContadorChecklist } from './tasks/ContadorChecklist';
import { hoyIso } from '../lib/tasksUi';
import {
  addDaysIso,
  addMonthsIso,
  agruparPorDia,
  asignarCarriles,
  celdasCalendarioMes,
  diaNumero,
  diasDeSemana,
  diasEntreIso,
  etiquetaMes,
  etiquetaSemana,
  fechaLimiteCalendario,
  inicioMesIso,
  itemCubreDia,
  lunesDeSemanaIso,
  recortarTramoARango,
  tramoProyecto,
  weekdayHeaderEs,
  weekdayShortEs,
  weekdayUltraEs,
} from '../lib/tasksCalendario';
import { apiFetch, errorMessage } from '../utils/api';
import { formatFecha } from '../utils/formatFecha';
import type { ChecklistItem, Proyecto, Reunion, Tarea } from '../types/tasks';

type TipoArrastrable = 'tarea' | 'reunion';

type PayloadDragAgenda = {
  tipo: TipoArrastrable;
  id: string;
  clave: string;
};

function esPayloadDrag(valor: unknown): valor is PayloadDragAgenda {
  if (!valor || typeof valor !== 'object') return false;
  const o = valor as Record<string, unknown>;
  return (
    (o.tipo === 'tarea' || o.tipo === 'reunion') &&
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.clave === 'string' &&
    o.clave.length > 0
  );
}

function payloadDesdeRaw(raw: string): PayloadDragAgenda | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return esPayloadDrag(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function payloadDesdeEvent(e: DragEvent<HTMLDivElement>): PayloadDragAgenda | null {
  return (
    payloadDesdeRaw(e.dataTransfer.getData('application/json')) ??
    payloadDesdeRaw(e.dataTransfer.getData('text/plain'))
  );
}

const COL_MIN = 132;
const GAP_SEMANA = 6;
const ANCHO_ETIQUETA_HORA = 84;
const ANCHO_SEMANA_MOVIL = ANCHO_ETIQUETA_HORA + 7 * COL_MIN + 6 * GAP_SEMANA;
const MAX_PUNTOS = 3;
const LIMITE_TAREAS = 50;
const MAX_PAGINAS_TAREAS = 10;
const LIMITE_REUNIONES = 100;
const TOPE_CARRILES = 3;
const ALTO_CARRIL_SEMANA = 22;
const ALTO_CARRIL_MES = 18;
const GAP_CARRIL = 3;
const ALTO_OVERFLOW = 14;
const PAD_BANDA = 4;
const PAD_BANDA_MES = 2;

/** Rejilla horaria visible (Google Calendar). */
const HORA_VISTA_INICIO = 8;
const HORA_VISTA_FIN = 22;
const ALTO_HORA = 48;
const ALTO_BLOQUE_MIN = 22;
const ALTO_OJO_BLOQUE = 28;
const MINUTOS_DIA_INICIO = HORA_VISTA_INICIO * 60;
const MINUTOS_DIA_FIN = HORA_VISTA_FIN * 60;
const ALTO_REJILLA = (HORA_VISTA_FIN - HORA_VISTA_INICIO) * ALTO_HORA;
/** Hueco para que la etiqueta de las 08:00 no quede recortada por el scroll. */
const PAD_REJILLA_TOP = 14;
const PAD_REJILLA_BOTTOM = 10;
const ALTO_REJILLA_CAJA = ALTO_REJILLA + PAD_REJILLA_TOP + PAD_REJILLA_BOTTOM;
const HORAS_ETIQUETA = Array.from(
  { length: HORA_VISTA_FIN - HORA_VISTA_INICIO + 1 },
  (_, i) => HORA_VISTA_INICIO + i,
);

export type TipoAgendaInicio = 'tarea' | 'reunion' | 'proyecto';

export const COLOR_AGENDA: Record<TipoAgendaInicio, string> = {
  tarea: '#ca8a04',
  reunion: '#7c3aed',
  proyecto: '#db2777',
};

const COLOR_TAREA_HECHA = '#94a3b8';
const FONDO_TAREA_HECHA = '#f1f5f9';
const TEXTO_TAREA_HECHA = '#64748b';

const FONDO_AGENDA: Record<TipoAgendaInicio, string> = {
  tarea: '#fefce8',
  reunion: '#f5f3ff',
  proyecto: '#fdf2f8',
};

const ETIQUETA_TIPO: Record<TipoAgendaInicio, string> = {
  tarea: 'Tarea',
  reunion: 'Reunión',
  proyecto: 'Proyecto',
};

type ItemAgenda = {
  clave: string;
  tipo: TipoAgendaInicio;
  /** `id_tarea` o `id_reunion` (en proyectos, `id_proyecto`). */
  id: string;
  titulo: string;
  fecha: string;
  /** Fin inclusive del tramo; solo si hay más de un día. */
  fechaFin?: string;
  meta?: string;
  ruta: string;
  /** Tarea cerrada (`estado === 'hecha'`). Se pinta en gris y tachada. */
  hecho?: boolean;
  /** Estado de la tarea, para saber si se puede pasar a hecha. */
  estado?: string;
  /** `permisos_fila.editar === true`. Proyectos siempre `false`. */
  puedeMover: boolean;
  horaInicio?: string;
  horaFin?: string;
  descripcion?: string;
  /** Lista de comprobación. Solo en tareas. */
  checklist?: ChecklistItem[];
};

type BloqueEmpaquetado = {
  item: ItemAgenda;
  top: number;
  height: number;
  carril: number;
  nCarriles: number;
};

function esArrastrable(item: ItemAgenda): boolean {
  return (item.tipo === 'tarea' || item.tipo === 'reunion') && item.puedeMover;
}

function tieneTramoHorario(item: ItemAgenda): boolean {
  const hi = (item.horaInicio ?? '').trim();
  const hf = (item.horaFin ?? '').trim();
  return Boolean(hi && hf);
}

/** Cabe en la rejilla 08:00–22:00. Fuera de esa ventana va a «Todo el día». */
function cabeEnRejilla(item: ItemAgenda): boolean {
  if (!tieneTramoHorario(item)) return false;
  const inicio = minutosDeHhmm(item.horaInicio!);
  const fin = minutosDeHhmm(item.horaFin!);
  if (inicio == null || fin == null || fin <= inicio) return false;
  return fin > MINUTOS_DIA_INICIO && inicio < MINUTOS_DIA_FIN;
}

function minutosDeHhmm(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return h * 60 + min;
}

function etiquetaTramo(item: ItemAgenda): string | null {
  const hi = (item.horaInicio ?? '').trim();
  const hf = (item.horaFin ?? '').trim();
  if (!hi || !hf) return null;
  return `${hi}–${hf}`;
}

function compararPorHoraInicio(a: ItemAgenda, b: ItemAgenda): number {
  const ha = (a.horaInicio ?? '').trim();
  const hb = (b.horaInicio ?? '').trim();
  if (ha && !hb) return -1;
  if (!ha && hb) return 1;
  if (ha && hb && ha !== hb) return ha < hb ? -1 : 1;
  return a.titulo.localeCompare(b.titulo, 'es');
}

function empaquetarBloquesDia(items: ItemAgenda[]): BloqueEmpaquetado[] {
  const conHora: Array<{ item: ItemAgenda; inicio: number; fin: number }> = [];
  for (const item of items) {
    if (!tieneTramoHorario(item)) continue;
    const inicio = minutosDeHhmm(item.horaInicio!);
    const fin = minutosDeHhmm(item.horaFin!);
    if (inicio == null || fin == null || fin <= inicio) continue;
    conHora.push({ item, inicio, fin });
  }

  conHora.sort((a, b) => {
    if (a.inicio !== b.inicio) return a.inicio - b.inicio;
    return b.fin - b.inicio - (a.fin - a.inicio);
  });

  const finCarril: number[] = [];
  const conCarril: Array<{ item: ItemAgenda; inicio: number; fin: number; carril: number }> = [];

  for (const t of conHora) {
    let puesto = -1;
    for (let i = 0; i < finCarril.length; i += 1) {
      if (finCarril[i] <= t.inicio) {
        puesto = i;
        break;
      }
    }
    if (puesto === -1) {
      puesto = finCarril.length;
      finCarril.push(t.fin);
    } else {
      finCarril[puesto] = t.fin;
    }
    conCarril.push({ ...t, carril: puesto });
  }

  // Agrupar solapes para repartir ancho (nCarriles del cluster).
  const resultados: BloqueEmpaquetado[] = [];
  let i = 0;
  while (i < conCarril.length) {
    let clusterFin = conCarril[i].fin;
    let j = i + 1;
    let maxCarril = conCarril[i].carril;
    while (j < conCarril.length && conCarril[j].inicio < clusterFin) {
      clusterFin = Math.max(clusterFin, conCarril[j].fin);
      maxCarril = Math.max(maxCarril, conCarril[j].carril);
      j += 1;
    }
    const nCarriles = maxCarril + 1;
    for (let k = i; k < j; k += 1) {
      const t = conCarril[k];
      const inicioVis = Math.max(t.inicio, MINUTOS_DIA_INICIO);
      const finVis = Math.min(t.fin, MINUTOS_DIA_FIN);
      const top = ((inicioVis - MINUTOS_DIA_INICIO) / 60) * ALTO_HORA;
      let height = Math.max(ALTO_BLOQUE_MIN, ((finVis - inicioVis) / 60) * ALTO_HORA);
      if (top + height > ALTO_REJILLA) height = Math.max(ALTO_BLOQUE_MIN, ALTO_REJILLA - top);
      resultados.push({
        item: t.item,
        top,
        height,
        carril: t.carril,
        nCarriles,
      });
    }
    i = j;
  }

  return resultados;
}

type BarraEmpaquetada = {
  item: ItemAgenda;
  carril: number;
  indiceInicio: number;
  span: number;
  continuaIzq: boolean;
  continuaDer: boolean;
};

function fechaDeReunion(r: Reunion): string | null {
  const iso = (r.fecha ?? '').trim().slice(0, 10);
  return fechaLimiteCalendario(iso);
}

function isoDiaMes(iso: string): string {
  return `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;
}

function nCarrilesDe(barras: BarraEmpaquetada[]): number {
  return barras.reduce((max, b) => Math.max(max, b.carril + 1), 0);
}

function alturaBanda(nCarriles: number, overflow: number, altoCarril: number, compacta?: boolean): number {
  if (nCarriles === 0 && overflow === 0) return 0;
  const pad = compacta ? PAD_BANDA_MES : PAD_BANDA;
  const cuerpo = nCarriles > 0 ? nCarriles * altoCarril + Math.max(0, nCarriles - 1) * GAP_CARRIL : 0;
  const extra = overflow > 0 ? ALTO_OVERFLOW + (nCarriles > 0 ? 2 : 0) : 0;
  return pad + cuerpo + extra + pad;
}

function empaquetarBarras(items: ItemAgenda[], lunes: string): { barras: BarraEmpaquetada[]; overflow: number } {
  const domingo = addDaysIso(lunes, 6);
  const recortados: Array<{
    item: ItemAgenda;
    desde: string;
    hasta: string;
    continuaIzq: boolean;
    continuaDer: boolean;
  }> = [];
  for (const item of items) {
    if (!item.fechaFin) continue;
    const r = recortarTramoARango(item.fecha, item.fechaFin, lunes, domingo);
    if (!r) continue;
    recortados.push({ item, ...r });
  }
  const { asignados, overflow } = asignarCarriles(recortados, TOPE_CARRILES);
  return {
    overflow,
    barras: asignados.map((a) => ({
      item: a.item,
      carril: a.carril,
      indiceInicio: diasEntreIso(lunes, a.desde),
      span: diasEntreIso(a.desde, a.hasta) + 1,
      continuaIzq: a.continuaIzq,
      continuaDer: a.continuaDer,
    })),
  };
}

function colorPuntoDia(item: ItemAgenda): string {
  if (item.hecho) return COLOR_TAREA_HECHA;
  return COLOR_AGENDA[item.tipo];
}

function itemsDeFuentes({
  tareas,
  tareasHechas,
  reuniones,
  proyectos,
  incluirTareas,
  incluirReuniones,
  incluirProyectos,
}: {
  tareas: Tarea[];
  tareasHechas: Tarea[];
  reuniones: Reunion[];
  proyectos: Proyecto[];
  incluirTareas: boolean;
  incluirReuniones: boolean;
  incluirProyectos: boolean;
}): { conFecha: ItemAgenda[]; sinFecha: ItemAgenda[] } {
  const conFecha: ItemAgenda[] = [];
  const sinFecha: ItemAgenda[] = [];

  if (incluirTareas) {
    for (const t of [...tareas, ...tareasHechas]) {
      if (t.estado === 'cancelada') continue;
      const hecho = t.estado === 'hecha';
      const hi = (t.hora_inicio ?? '').trim();
      const hf = (t.hora_fin ?? '').trim();
      const item: ItemAgenda = {
        clave: `tarea:${t.id_tarea}`,
        tipo: 'tarea',
        id: t.id_tarea,
        titulo: t.titulo,
        fecha: fechaLimiteCalendario(t.fecha_limite) ?? '',
        meta: t.proyecto_nombre?.trim() || undefined,
        ruta: `/proyectos/tarea/${encodeURIComponent(t.id_tarea)}`,
        hecho,
        estado: t.estado,
        puedeMover: t.permisos_fila?.editar === true,
        horaInicio: hi || undefined,
        horaFin: hf || undefined,
        descripcion: t.descripcion?.trim() || undefined,
        checklist: t.checklist,
      };
      if (item.fecha) conFecha.push(item);
      else if (!hecho) sinFecha.push(item);
    }
  }

  if (incluirReuniones) {
    for (const r of reuniones) {
      if (r.estado === 'cancelada') continue;
      const fecha = fechaDeReunion(r);
      if (!fecha) continue;
      const ini = (r.hora_inicio ?? '').trim();
      const fin = (r.hora_fin ?? '').trim();
      const desc = (r.orden_del_dia ?? r.resumen ?? '').trim();
      conFecha.push({
        clave: `reunion:${r.id_reunion}`,
        tipo: 'reunion',
        id: r.id_reunion,
        titulo: r.titulo,
        fecha,
        meta: r.local_nombre?.trim() || undefined,
        ruta: `/reuniones/${encodeURIComponent(r.id_reunion)}`,
        puedeMover: r.permisos_fila?.editar === true,
        horaInicio: ini || undefined,
        horaFin: fin || undefined,
        descripcion: desc || undefined,
      });
    }
  }

  if (incluirProyectos) {
    for (const p of proyectos) {
      if (p.estado === 'cancelado') continue;
      const tramo = tramoProyecto(p.fecha_inicio, p.fecha_fin_prevista);
      const esTramo = Boolean(tramo && tramo.desde !== tramo.hasta);
      const item: ItemAgenda = {
        clave: `proyecto:${p.id_proyecto}`,
        tipo: 'proyecto',
        id: p.id_proyecto,
        titulo: p.nombre,
        fecha: tramo?.desde ?? '',
        fechaFin: esTramo && tramo ? tramo.hasta : undefined,
        meta: esTramo && tramo
          ? `${isoDiaMes(tramo.desde)} – ${isoDiaMes(tramo.hasta)}`
          : fechaLimiteCalendario(p.fecha_fin_prevista)
            ? 'Fin previsto'
            : tramo
              ? 'Inicio'
              : undefined,
        ruta: `/proyectos/${encodeURIComponent(p.id_proyecto)}`,
        puedeMover: false,
        descripcion: p.descripcion?.trim() || undefined,
      };
      if (item.fecha) conFecha.push(item);
      else sinFecha.push(item);
    }
  }

  return { conFecha, sinFecha };
}

function BotonMarcarRealizada({
  onPress,
  disabled,
}: {
  onPress: () => void;
  disabled?: boolean;
}) {
  const pulso = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulso, {
          toValue: 0.72,
          duration: 900,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(pulso, {
          toValue: 1,
          duration: 900,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulso]);

  return (
    <Animated.View style={{ opacity: disabled ? 1 : pulso }}>
      <TouchableOpacity
        onPress={onPress}
        disabled={disabled}
        style={styles.btnRealizada}
        accessibilityRole="button"
        accessibilityLabel="Marcar como realizada"
      >
        {disabled ? (
          <ActivityIndicator size="small" color="#ffffff" />
        ) : (
          <MaterialIcons name="check-circle" size={18} color="#ffffff" />
        )}
        <Text style={styles.btnRealizadaTexto}>Marcar como realizada</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function PopoverVistaItem({
  item,
  onCerrar,
  onMarcarCasilla,
  onMarcarRealizada,
}: {
  item: ItemAgenda;
  onCerrar: () => void;
  /** Marca o desmarca una casilla. Solo si la tarea se puede editar. */
  onMarcarCasilla?: (casillaId: string, hecho: boolean) => Promise<void>;
  /** Cierra la tarea. Solo si se puede editar y aún no está hecha. */
  onMarcarRealizada?: () => Promise<void>;
}) {
  const { isCompact } = useBreakpoint();
  const [casillaEnCurso, setCasillaEnCurso] = useState<string | null>(null);
  const [errorCasillas, setErrorCasillas] = useState<string | null>(null);
  const [marcandoRealizada, setMarcandoRealizada] = useState(false);
  const [errorRealizada, setErrorRealizada] = useState<string | null>(null);
  const tramo = etiquetaTramo(item);
  const etiquetaFecha =
    item.tipo === 'reunion' ? 'Fecha' : item.tipo === 'proyecto' ? 'Fecha' : 'Fecha de vencimiento';
  const casillas = [...(item.checklist ?? [])].sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  const puedeMarcar = item.tipo === 'tarea' && item.puedeMover && Boolean(onMarcarCasilla);
  const puedeRealizar =
    item.tipo === 'tarea' &&
    (item.estado === 'pendiente' || item.estado === 'en_curso') &&
    item.puedeMover &&
    Boolean(onMarcarRealizada);

  const marcarRealizada = async () => {
    if (!onMarcarRealizada || !puedeRealizar || marcandoRealizada) return;
    setMarcandoRealizada(true);
    setErrorRealizada(null);
    try {
      await onMarcarRealizada();
    } catch (e) {
      setErrorRealizada(errorMessage(e, 'No se pudo marcar la tarea como realizada'));
      setMarcandoRealizada(false);
    }
  };

  const alternar = async (casilla: ChecklistItem) => {
    if (!onMarcarCasilla || !puedeMarcar || casillaEnCurso) return;
    setCasillaEnCurso(casilla.id);
    setErrorCasillas(null);
    try {
      await onMarcarCasilla(casilla.id, !casilla.hecho);
    } catch (e) {
      setErrorCasillas(errorMessage(e, 'No se pudo actualizar la lista de comprobación'));
    } finally {
      setCasillaEnCurso(null);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCerrar}>
      <Pressable style={styles.popoverOverlay} onPress={onCerrar} accessibilityLabel="Cerrar vista previa">
        <Pressable style={styles.popoverCard} onPress={() => {}}>
          <View style={styles.popoverHeader}>
            <Text style={styles.popoverTitulo} numberOfLines={3}>
              {item.titulo}
            </Text>
            <TouchableOpacity
              onPress={onCerrar}
              style={styles.popoverCerrar}
              accessibilityLabel="Cerrar"
              hitSlop={8}
            >
              <MaterialIcons name="close" size={20} color="#64748b" />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.popoverScroll} contentContainerStyle={styles.popoverScrollContent}>
            <Text style={styles.popoverDesc}>
              {item.descripcion?.trim() || 'Sin descripción'}
            </Text>
            <View style={styles.popoverFila}>
              <Text style={styles.popoverLabel}>{etiquetaFecha}</Text>
              <Text style={styles.popoverValor}>{formatFecha(item.fecha)}</Text>
            </View>
            <View style={styles.popoverFila}>
              <Text style={styles.popoverLabel}>Tramo</Text>
              <Text style={styles.popoverValor}>
                {tramo ? `${(item.horaInicio ?? '').trim()} – ${(item.horaFin ?? '').trim()}` : 'Sin hora'}
              </Text>
            </View>
            {casillas.length > 0 ? (
              <View style={styles.popoverLista}>
                <View style={styles.popoverListaCabecera}>
                  <Text style={styles.popoverLabel}>Lista de comprobación</Text>
                  <ContadorChecklist checklist={casillas} />
                </View>
                {casillas.map((casilla) => (
                  <TouchableOpacity
                    key={casilla.id}
                    style={[styles.popoverCasilla, isCompact && styles.popoverCasillaTactil]}
                    onPress={() => void alternar(casilla)}
                    disabled={!puedeMarcar || casillaEnCurso != null}
                    accessibilityLabel={casilla.hecho ? 'Desmarcar el elemento' : 'Marcar el elemento'}
                  >
                    {casillaEnCurso === casilla.id ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <MaterialIcons
                        name={casilla.hecho ? 'check-box' : 'check-box-outline-blank'}
                        size={20}
                        color={casilla.hecho ? '#16a34a' : '#94a3b8'}
                      />
                    )}
                    <Text style={[styles.popoverCasillaTexto, casilla.hecho && styles.popoverCasillaHecha]}>
                      {casilla.texto}
                    </Text>
                  </TouchableOpacity>
                ))}
                {errorCasillas ? <Text style={styles.popoverError}>{errorCasillas}</Text> : null}
              </View>
            ) : null}
          </ScrollView>
          {puedeRealizar ? (
            <View style={styles.popoverAccion}>
              <BotonMarcarRealizada onPress={() => void marcarRealizada()} disabled={marcandoRealizada} />
              {errorRealizada ? <Text style={styles.popoverError}>{errorRealizada}</Text> : null}
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function BotonOjo({
  compacto,
  onPress,
}: {
  compacto?: boolean;
  onPress: () => void;
}) {
  const lado = compacto ? ALTO_OJO_BLOQUE : MIN_TOUCH;
  return (
    <TouchableOpacity
      onPress={() => {
        onPress();
      }}
      style={[styles.ojoBtn, { width: lado, height: lado, minWidth: lado, minHeight: lado }]}
      hitSlop={compacto ? 6 : 4}
      accessibilityLabel="Ver detalle"
      accessibilityRole="button"
    >
      <MaterialIcons name="visibility" size={compacto ? 16 : 18} color="#64748b" />
    </TouchableOpacity>
  );
}

function PastillaAgenda({
  item,
  onAbrir,
  onVistaPrevia,
  arrastrable,
  arrastrando,
  recienSoltada,
  onDragStart,
  onDragEnd,
}: {
  item: ItemAgenda;
  onAbrir: () => void;
  onVistaPrevia: () => void;
  arrastrable?: boolean;
  arrastrando?: boolean;
  recienSoltada?: boolean;
  onDragStart?: (payload: PayloadDragAgenda) => void;
  onDragEnd?: () => void;
}) {
  const hecho = Boolean(item.hecho);
  const color = hecho ? COLOR_TAREA_HECHA : COLOR_AGENDA[item.tipo];
  const fondo = hecho ? FONDO_TAREA_HECHA : FONDO_AGENDA[item.tipo];
  const tramo = etiquetaTramo(item);
  const cuerpo = (
    <View
      style={[
        styles.pill,
        { backgroundColor: fondo },
        arrastrando && styles.pillArrastrando,
        recienSoltada && styles.pillRecienSoltada,
      ]}
    >
      <TouchableOpacity
        style={styles.pillToque}
        onPress={onAbrir}
        activeOpacity={0.75}
        accessibilityLabel={`${ETIQUETA_TIPO[item.tipo]}: ${item.titulo}`}
      >
        <View style={[styles.pillFranja, { backgroundColor: color }]} />
        <View style={styles.pillCuerpo}>
          <Text style={[styles.pillTitulo, hecho && styles.pillHecho]} numberOfLines={2}>
            {item.titulo}
          </Text>
          <View style={styles.pillMetaFila}>
            <Text
              style={[styles.pillMeta, styles.pillMetaTexto, { color }, hecho && styles.pillHecho]}
              numberOfLines={1}
            >
              {ETIQUETA_TIPO[item.tipo]}
              {tramo ? ` · ${tramo}` : ''}
              {item.meta ? ` · ${item.meta}` : ''}
            </Text>
            <ContadorChecklist checklist={item.checklist} compacto />
          </View>
        </View>
      </TouchableOpacity>
      {item.tipo === 'tarea' || item.tipo === 'reunion' ? (
        <BotonOjo onPress={onVistaPrevia} />
      ) : null}
    </View>
  );

  if (Platform.OS !== 'web' || !arrastrable) return cuerpo;
  if (item.tipo !== 'tarea' && item.tipo !== 'reunion') return cuerpo;

  const payload: PayloadDragAgenda = { tipo: item.tipo, id: item.id, clave: item.clave };
  return createElement(
    'div',
    {
      draggable: true,
      onDragStart: (e: DragEvent<HTMLDivElement>) => {
        e.stopPropagation();
        const raw = JSON.stringify(payload);
        e.dataTransfer.setData('application/json', raw);
        e.dataTransfer.setData('text/plain', raw);
        e.dataTransfer.effectAllowed = 'move';
        e.currentTarget.style.cursor = 'grabbing';
        onDragStart?.(payload);
      },
      onDragEnd: () => {
        onDragEnd?.();
      },
      style: {
        width: '100%',
        cursor: arrastrando ? 'grabbing' : 'grab',
        boxSizing: 'border-box',
        transition: 'opacity 180ms ease, transform 220ms ease',
        transform: recienSoltada ? 'scale(1.03)' : 'scale(1)',
      },
    },
    cuerpo,
  );
}

function BloqueHorario({
  bloque,
  arrastrable,
  arrastrando,
  recienSoltada,
  onAbrir,
  onVistaPrevia,
  onDragStart,
  onDragEnd,
}: {
  bloque: BloqueEmpaquetado;
  arrastrable: boolean;
  arrastrando: boolean;
  recienSoltada: boolean;
  onAbrir: () => void;
  onVistaPrevia: () => void;
  onDragStart?: (payload: PayloadDragAgenda) => void;
  onDragEnd?: () => void;
}) {
  const { item, top, height, carril, nCarriles } = bloque;
  const hecho = Boolean(item.hecho);
  const color = hecho ? COLOR_TAREA_HECHA : COLOR_AGENDA[item.tipo];
  const fondo = hecho ? FONDO_TAREA_HECHA : FONDO_AGENDA[item.tipo];
  const tramo = etiquetaTramo(item);
  const anchoPct = 100 / nCarriles;
  const compacto = height < 36;
  const mostrarTramo = height >= 28 && Boolean(tramo);
  const estiloPos = {
    position: 'absolute' as const,
    top: top + PAD_REJILLA_TOP,
    height,
    left: `${carril * anchoPct}%`,
    width: `${anchoPct}%`,
    boxSizing: 'border-box' as const,
  };

  const interior = (
    <>
      <TouchableOpacity
        style={styles.bloqueToque}
        onPress={onAbrir}
        activeOpacity={0.8}
        accessibilityLabel={`${ETIQUETA_TIPO[item.tipo]}: ${item.titulo}${tramo ? `, ${tramo}` : ''}`}
      >
        <View style={styles.bloqueTituloFila}>
          <Text
            style={[styles.bloqueTitulo, styles.bloqueTituloTexto, hecho && styles.pillHecho]}
            numberOfLines={compacto ? 1 : 2}
          >
            {item.titulo}
            {compacto && mostrarTramo ? ` ${tramo}` : ''}
          </Text>
          <ContadorChecklist checklist={item.checklist} compacto />
        </View>
        {!compacto && mostrarTramo ? (
          <Text style={[styles.bloqueHora, hecho && styles.pillHecho]} numberOfLines={1}>
            {tramo}
          </Text>
        ) : null}
      </TouchableOpacity>
      <BotonOjo compacto onPress={onVistaPrevia} />
    </>
  );

  if (Platform.OS !== 'web' || !arrastrable || (item.tipo !== 'tarea' && item.tipo !== 'reunion')) {
    return (
      <View
        style={[
          styles.bloque,
          estiloPos,
          { backgroundColor: fondo, borderLeftColor: color },
          arrastrando && styles.pillArrastrando,
          recienSoltada && styles.pillRecienSoltada,
        ]}
      >
        {interior}
      </View>
    );
  }

  const payload: PayloadDragAgenda = { tipo: item.tipo, id: item.id, clave: item.clave };
  return createElement(
    'div',
    {
      draggable: true,
      onDragStart: (e: DragEvent<HTMLDivElement>) => {
        e.stopPropagation();
        const raw = JSON.stringify(payload);
        e.dataTransfer.setData('application/json', raw);
        e.dataTransfer.setData('text/plain', raw);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart?.(payload);
      },
      onDragEnd: () => onDragEnd?.(),
      style: {
        ...estiloPos,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: fondo,
        borderRadius: 4,
        border: `1px solid ${tasksUi.color.bordeSutil}`,
        borderLeft: `3px solid ${color}`,
        overflow: 'hidden',
        paddingRight: 2,
        zIndex: 2,
        cursor: arrastrando ? 'grabbing' : 'grab',
        opacity: arrastrando ? 0.4 : 1,
        outline: recienSoltada ? `1px solid ${tasksUi.color.acento}` : undefined,
      },
    },
    interior,
  );
}

function EnvolverSemana({
  movil,
  embebido,
  children,
}: {
  movil: boolean;
  embebido: boolean;
  children: ReactNode;
}) {
  if (!movil) return children;
  return (
    <ScrollView horizontal style={[styles.semanaScroll, embebido && styles.semanaScrollEmbebida]}>
      {children}
    </ScrollView>
  );
}

function EnvolverMes({
  embebido,
  children,
}: {
  embebido: boolean;
  children: ReactNode;
}) {
  if (!embebido) return children;
  return (
    <ScrollView style={styles.mesScrollEmbebido} nestedScrollEnabled>
      {children}
    </ScrollView>
  );
}

function ZonaDropDia({
  iso,
  children,
  estiloWeb,
  onEnter,
  onLeave,
  onSoltar,
  horaAlSoltar,
}: {
  iso: string;
  children: ReactNode;
  estiloWeb?: CSSProperties;
  onEnter: (iso: string) => void;
  onLeave: (iso: string, related: EventTarget | null, current: EventTarget) => void;
  /** Si viene, la Y del suelto fija la hora. `null` = todo el día. Sin callback, solo cambia la fecha. */
  horaAlSoltar?: (offsetY: number) => string | null;
  onSoltar: (iso: string, payload: PayloadDragAgenda, horaInicio?: string | null) => void;
}) {
  if (Platform.OS !== 'web') return children;
  return createElement(
    'div',
    {
      onDragOver: (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onEnter(iso);
      },
      onDragLeave: (e: DragEvent<HTMLDivElement>) => {
        onLeave(iso, e.relatedTarget, e.currentTarget);
      },
      onDrop: (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const payload = payloadDesdeEvent(e);
        if (!payload) return;
        if (!horaAlSoltar) {
          onSoltar(iso, payload);
          return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        onSoltar(iso, payload, horaAlSoltar(e.clientY - rect.top));
      },
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignSelf: 'stretch',
        boxSizing: 'border-box',
        minWidth: 0,
        ...estiloWeb,
      },
    },
    children,
  );
}

function BarraTramo({
  titulo,
  indiceInicio,
  span,
  carril,
  alto,
  paddingTop,
  continuaIzq,
  continuaDer,
  compacta,
  columnasFijas,
  offsetIzq = 0,
  onAbrir,
}: {
  titulo: string;
  indiceInicio: number;
  span: number;
  carril: number;
  alto: number;
  paddingTop: number;
  continuaIzq: boolean;
  continuaDer: boolean;
  compacta?: boolean;
  columnasFijas?: boolean;
  offsetIzq?: number;
  onAbrir: () => void;
}) {
  const resto = 7 - indiceInicio - span;
  const hueco = compacta ? 0 : GAP_SEMANA;
  const cuerpo = (
    <View
      style={[
        styles.barraCuerpo,
        continuaIzq && styles.barraContinuaIzq,
        continuaDer && styles.barraContinuaDer,
      ]}
    >
      <Text style={[styles.barraTitulo, compacta && styles.barraTituloMes]} numberOfLines={1}>
        {titulo}
      </Text>
    </View>
  );

  if (columnasFijas) {
    return (
      <TouchableOpacity
        onPress={onAbrir}
        activeOpacity={0.75}
        accessibilityLabel={`Proyecto: ${titulo}`}
        style={{
          position: 'absolute',
          left: offsetIzq + indiceInicio * (COL_MIN + GAP_SEMANA),
          width: span * COL_MIN + Math.max(0, span - 1) * GAP_SEMANA,
          top: paddingTop + carril * (alto + GAP_CARRIL),
          height: alto,
          paddingLeft: continuaIzq ? 0 : 3,
          paddingRight: continuaDer ? 0 : 3,
          justifyContent: 'center',
        }}
      >
        {cuerpo}
      </TouchableOpacity>
    );
  }

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: offsetIzq,
        right: 0,
        top: paddingTop + carril * (alto + GAP_CARRIL),
        height: alto,
        flexDirection: 'row',
        gap: hueco,
      }}
    >
      {indiceInicio > 0 ? <View style={{ flex: indiceInicio }} pointerEvents="none" /> : null}
      <TouchableOpacity
        onPress={onAbrir}
        activeOpacity={0.75}
        accessibilityLabel={`Proyecto: ${titulo}`}
        style={{
          flex: span,
          minWidth: 0,
          minHeight: alto,
          paddingLeft: continuaIzq ? 0 : 3,
          paddingRight: continuaDer ? 0 : 3,
          justifyContent: 'center',
        }}
      >
        {cuerpo}
      </TouchableOpacity>
      {resto > 0 ? <View style={{ flex: resto }} pointerEvents="none" /> : null}
    </View>
  );
}

function BandaCarriles({
  barras,
  overflow,
  altoCarril,
  compacta,
  columnasFijas,
  conGutterHoras,
  onAbrir,
}: {
  barras: BarraEmpaquetada[];
  overflow: number;
  altoCarril: number;
  compacta?: boolean;
  columnasFijas?: boolean;
  /** Semana: deja hueco a la izquierda alineado con la columna de horas. */
  conGutterHoras?: boolean;
  onAbrir: (item: ItemAgenda) => void;
}) {
  const n = nCarrilesDe(barras);
  const height = alturaBanda(n, overflow, altoCarril, compacta);
  if (height === 0) return null;
  const pad = compacta ? PAD_BANDA_MES : PAD_BANDA;
  const offsetIzq = conGutterHoras ? ANCHO_ETIQUETA_HORA : 0;
  return (
    <View
      style={[styles.bandaCarriles, compacta && styles.bandaCarrilesMes, { height }]}
      pointerEvents="box-none"
    >
      {barras.map((b) => (
        <BarraTramo
          key={b.item.clave}
          titulo={b.item.titulo}
          indiceInicio={b.indiceInicio}
          span={b.span}
          carril={b.carril}
          alto={altoCarril}
          paddingTop={pad}
          continuaIzq={b.continuaIzq}
          continuaDer={b.continuaDer}
          compacta={compacta}
          columnasFijas={columnasFijas}
          offsetIzq={offsetIzq}
          onAbrir={() => onAbrir(b.item)}
        />
      ))}
      {overflow > 0 ? (
        <Text
          pointerEvents="none"
          style={[styles.masProyectos, { bottom: Math.max(0, pad - 1), left: offsetIzq + 8 }]}
        >
          +{overflow} {overflow === 1 ? 'proyecto' : 'proyectos'}
        </Text>
      ) : null}
    </View>
  );
}

export function CalendarioInicio({ embebido = false }: { embebido?: boolean } = {}) {
  const router = useRouter();
  const acceso = useAccesoTasks();
  const { isPhone, isPortrait, isCompact, shouldStackToolbar } = useBreakpoint();

  const puedeTareas = puedeVerProyectos(acceso);
  const puedeReuniones = puedeVerReuniones(acceso);

  const [vista, setVista] = useState<'semana' | 'mes'>('semana');
  const [ancla, setAncla] = useState(hoyIso);
  const [diaSeleccionado, setDiaSeleccionado] = useState<string | null>(null);

  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [tareasHechas, setTareasHechas] = useState<Tarea[]>([]);
  const [reuniones, setReuniones] = useState<Reunion[]>([]);
  const [proyectos, setProyectos] = useState<Proyecto[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuCrearAbierto, setMenuCrearAbierto] = useState(false);
  const [avisoCalendario, setAvisoCalendario] = useState<string | null>(null);
  const [claveArrastrando, setClaveArrastrando] = useState<string | null>(null);
  const [isoDragOver, setIsoDragOver] = useState<string | null>(null);
  const [claveRecienSoltada, setClaveRecienSoltada] = useState<string | null>(null);
  const [vistaPrevia, setVistaPrevia] = useState<ItemAgenda | null>(null);
  const [huecoAlta, setHuecoAlta] = useState<HuecoAgenda | null>(null);
  const [minutosAhora, setMinutosAhora] = useState(() => {
    const ahora = new Date();
    return ahora.getHours() * 60 + ahora.getMinutes();
  });
  const seqReuniones = useRef(0);
  const seqHechas = useRef(0);
  const arrastro = useRef(false);
  const ignoraClickCelda = useRef(false);
  const timerSoltada = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqMove = useRef(new Map<string, number>());
  const rejillaScrollRef = useRef<ScrollView>(null);
  const [reservaBarra, setReservaBarra] = useState(0);
  const tareasRef = useRef(tareas);
  const tareasHechasRef = useRef(tareasHechas);
  const reunionesRef = useRef(reuniones);
  tareasRef.current = tareas;
  tareasHechasRef.current = tareasHechas;
  reunionesRef.current = reuniones;

  const hoy = hoyIso();
  const lunes = lunesDeSemanaIso(ancla);
  const rango = useMemo(() => {
    if (vista === 'semana') {
      return { desde: lunes, hasta: addDaysIso(lunes, 6) };
    }
    const celdas = celdasCalendarioMes(ancla);
    return { desde: celdas[0]?.iso ?? inicioMesIso(ancla), hasta: celdas[celdas.length - 1]?.iso ?? ancla };
  }, [vista, ancla, lunes]);

  const cargarBase = useCallback(async () => {
    if (acceso.permisosCargando || !puedeTareas) {
      setTareas([]);
      setProyectos([]);
      return;
    }
    setCargando(true);
    setError(null);
    try {
      const [tareasAcc, proyectosAcc] = await Promise.all([
        (async () => {
          const acumuladas: Tarea[] = [];
          let cursor: string | null = null;
          for (let i = 0; i < MAX_PAGINAS_TAREAS; i += 1) {
            const query = new URLSearchParams({ limite: String(LIMITE_TAREAS) });
            if (cursor) query.set('cursor', cursor);
            const res = await apiFetch(`/api/tareas/mias?${query.toString()}`);
            const data = (await res.json().catch(() => ({}))) as {
              tareas?: Tarea[];
              cursor?: string | null;
              error?: string;
            };
            if (!res.ok) throw new Error(data.error || 'No se pudieron cargar tus tareas');
            acumuladas.push(...(Array.isArray(data.tareas) ? data.tareas : []));
            cursor = data.cursor ?? null;
            if (!cursor) break;
          }
          return acumuladas;
        })(),
        (async () => {
          const res = await apiFetch('/api/proyectos/mios');
          const data = (await res.json().catch(() => ({}))) as {
            proyectos?: Proyecto[];
            error?: string;
          };
          if (!res.ok) throw new Error(data.error || 'No se pudieron cargar tus proyectos');
          return Array.isArray(data.proyectos) ? data.proyectos : [];
        })(),
      ]);
      setTareas(tareasAcc);
      setProyectos(proyectosAcc);
    } catch (e) {
      console.error('[inicio] fallo al cargar tareas o proyectos', e);
      setError(errorMessage(e, 'No se pudo cargar la agenda'));
    } finally {
      setCargando(false);
    }
  }, [acceso.permisosCargando, puedeTareas]);

  const cargarReuniones = useCallback(async () => {
    if (acceso.permisosCargando || !puedeReuniones) {
      setReuniones([]);
      return;
    }
    const seq = (seqReuniones.current += 1);
    try {
      const acumuladas: Reunion[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 3; i += 1) {
        const query = new URLSearchParams({
          limite: String(LIMITE_REUNIONES),
          desde: rango.desde,
          hasta: rango.hasta,
        });
        if (cursor) query.set('cursor', cursor);
        const res = await apiFetch(`/api/reuniones?${query.toString()}`);
        const data = (await res.json().catch(() => ({}))) as {
          reuniones?: Reunion[];
          cursor?: string | null;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || 'No se pudieron cargar las reuniones');
        acumuladas.push(...(Array.isArray(data.reuniones) ? data.reuniones : []));
        cursor = data.cursor ?? null;
        if (!cursor) break;
      }
      if (seq === seqReuniones.current) setReuniones(acumuladas);
    } catch (e) {
      if (seq !== seqReuniones.current) return;
      console.error('[inicio] fallo al cargar reuniones', e);
      setError(errorMessage(e, 'No se pudieron cargar las reuniones'));
    }
  }, [acceso.permisosCargando, puedeReuniones, rango.desde, rango.hasta]);

  const cargarHechas = useCallback(async () => {
    if (acceso.permisosCargando || !puedeTareas) {
      setTareasHechas([]);
      return;
    }
    const seq = (seqHechas.current += 1);
    try {
      const acumuladas: Tarea[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < MAX_PAGINAS_TAREAS; i += 1) {
        const query = new URLSearchParams({
          incluir_hechas: '1',
          desde: rango.desde,
          hasta: rango.hasta,
          limite: String(LIMITE_TAREAS),
        });
        if (cursor) query.set('cursor', cursor);
        const res = await apiFetch(`/api/tareas/mias?${query.toString()}`);
        const data = (await res.json().catch(() => ({}))) as {
          tareas?: Tarea[];
          cursor?: string | null;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || 'No se pudieron cargar las tareas hechas');
        acumuladas.push(...(Array.isArray(data.tareas) ? data.tareas : []));
        cursor = data.cursor ?? null;
        if (!cursor) break;
      }
      if (seq === seqHechas.current) setTareasHechas(acumuladas);
    } catch (e) {
      if (seq !== seqHechas.current) return;
      console.error('[inicio] fallo al cargar tareas hechas', e);
      setError(errorMessage(e, 'No se pudieron cargar las tareas hechas'));
    }
  }, [acceso.permisosCargando, puedeTareas, rango.desde, rango.hasta]);

  useFocusEffect(
    useCallback(() => {
      if (embebido) return;
      void cargarBase();
      void cargarHechas();
    }, [embebido, cargarBase, cargarHechas]),
  );

  // En el panel de la cabecera no hay pantalla enfocada: carga al abrir y al cambiar de semana o mes.
  useEffect(() => {
    if (!embebido) return;
    void cargarBase();
    void cargarHechas();
  }, [embebido, cargarBase, cargarHechas]);

  useEffect(() => {
    void cargarReuniones();
  }, [cargarReuniones]);

  useEffect(() => {
    const id = setInterval(() => {
      const ahora = new Date();
      setMinutosAhora(ahora.getHours() * 60 + ahora.getMinutes());
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const { conFecha, sinFecha } = useMemo(
    () =>
      itemsDeFuentes({
        tareas,
        tareasHechas,
        reuniones,
        proyectos,
        incluirTareas: puedeTareas,
        incluirReuniones: puedeReuniones,
        incluirProyectos: puedeTareas,
      }),
    [tareas, tareasHechas, reuniones, proyectos, puedeTareas, puedeReuniones],
  );

  const puntuales = useMemo(() => conFecha.filter((i) => !i.fechaFin), [conFecha]);
  const porDiaPuntuales = useMemo(() => agruparPorDia(puntuales), [puntuales]);
  const porDiaCubierto = useMemo(() => {
    const map = new Map<string, ItemAgenda[]>();
    let cur = rango.desde;
    while (cur <= rango.hasta) {
      const delDia = conFecha.filter((item) => itemCubreDia(item, cur));
      if (delDia.length) map.set(cur, delDia);
      cur = addDaysIso(cur, 1);
    }
    return map;
  }, [conFecha, rango.desde, rango.hasta]);
  const empaquetadoSemana = useMemo(() => empaquetarBarras(conFecha, lunes), [conFecha, lunes]);

  const bloquesPorDia = useMemo(() => {
    const map = new Map<string, BloqueEmpaquetado[]>();
    for (const iso of diasDeSemana(lunes)) {
      const delDia = (porDiaPuntuales.get(iso) ?? []).filter(cabeEnRejilla);
      map.set(iso, empaquetarBloquesDia(delDia));
    }
    return map;
  }, [porDiaPuntuales, lunes]);

  const todoElDiaPorDia = useMemo(() => {
    const map = new Map<string, ItemAgenda[]>();
    for (const iso of diasDeSemana(lunes)) {
      const delDia = (porDiaPuntuales.get(iso) ?? []).filter((i) => !cabeEnRejilla(i));
      map.set(iso, delDia);
    }
    return map;
  }, [porDiaPuntuales, lunes]);

  useEffect(() => {
    if (vista !== 'mes') return;
    if (diaSeleccionado && diaSeleccionado.slice(0, 7) !== inicioMesIso(ancla).slice(0, 7)) {
      setDiaSeleccionado(null);
    }
  }, [vista, ancla, diaSeleccionado]);

  const semanas = useMemo(() => {
    const celdas = celdasCalendarioMes(ancla);
    const filas: { iso: string; delMes: boolean }[][] = [];
    for (let i = 0; i < celdas.length; i += 7) filas.push(celdas.slice(i, i + 7));
    return filas;
  }, [ancla]);

  const empaquetadoMes = useMemo(
    () => semanas.map((fila) => empaquetarBarras(conFecha, fila[0]?.iso ?? lunes)),
    [semanas, conFecha, lunes],
  );

  const abrir = (item: ItemAgenda) => router.push(item.ruta as never);

  const marcarSoltada = useCallback((clave: string) => {
    setClaveRecienSoltada(clave);
    if (timerSoltada.current) clearTimeout(timerSoltada.current);
    timerSoltada.current = setTimeout(() => {
      setClaveRecienSoltada(null);
      timerSoltada.current = null;
    }, 220);
  }, []);

  useEffect(
    () => () => {
      if (timerSoltada.current) clearTimeout(timerSoltada.current);
    },
    [],
  );

  const iniciarArrastre = useCallback((payload: PayloadDragAgenda) => {
    arrastro.current = true;
    setClaveArrastrando(payload.clave);
    setVistaPrevia(null);
  }, []);

  const terminarArrastre = useCallback(() => {
    setClaveArrastrando(null);
    setIsoDragOver(null);
    setTimeout(() => {
      arrastro.current = false;
    }, 300);
  }, []);

  const abrirTrasDrag = useCallback((item: ItemAgenda) => {
    ignoraClickCelda.current = true;
    setTimeout(() => {
      ignoraClickCelda.current = false;
    }, 0);
    if (arrastro.current) return;
    router.push(item.ruta as never);
  }, [router]);

  const entrarDrop = useCallback((iso: string) => {
    setIsoDragOver(iso);
  }, []);

  const salirDrop = useCallback((iso: string, related: EventTarget | null, current: EventTarget) => {
    const relatedNode = related as Node | null;
    const caja = current as Node;
    if (relatedNode && typeof caja.contains === 'function' && caja.contains(relatedNode)) return;
    setIsoDragOver((prev) => (prev === iso ? null : prev));
  }, []);

  const seleccionarDiaSiVisible = useCallback(
    (destinoIso: string) => {
      if (vista !== 'mes') return;
      if (destinoIso.slice(0, 7) !== inicioMesIso(ancla).slice(0, 7)) return;
      setDiaSeleccionado(destinoIso);
    },
    [vista, ancla],
  );

  const moverFechaAgenda = useCallback(
    async (payload: PayloadDragAgenda, destinoIso: string, horaInicio?: string | null) => {
      setIsoDragOver(null);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(destinoIso)) return;

      const claveMove = `${payload.tipo}:${payload.id}`;
      const reservarSeq = () => {
        const seq = (seqMove.current.get(claveMove) ?? 0) + 1;
        seqMove.current.set(claveMove, seq);
        return () => seqMove.current.get(claveMove) === seq;
      };

      const horasNuevas = (inicioPrev: string, finPrev: string) => {
        if (horaInicio === undefined) return null;
        if (horaInicio === null) return { hora_inicio: '', hora_fin: '' };
        return desplazarTramo(horaInicio, inicioPrev, finPrev);
      };

      if (payload.tipo === 'tarea') {
        const t =
          tareasRef.current.find((x) => x.id_tarea === payload.id) ??
          tareasHechasRef.current.find((x) => x.id_tarea === payload.id);
        if (!t) return;
        const fechaDisplay = fechaLimiteCalendario(t.fecha_limite) ?? '';
        const hiPrev = (t.hora_inicio ?? '').trim();
        const hfPrev = (t.hora_fin ?? '').trim();
        const horas = horasNuevas(hiPrev, hfPrev);
        const mismaFecha = fechaDisplay === destinoIso;
        const mismasHoras = !horas || (horas.hora_inicio === hiPrev && horas.hora_fin === hfPrev);
        if (mismaFecha && mismasHoras) return;
        const esUltimo = reservarSeq();

        const snapshotFecha = t.fecha_limite;
        const parchear = (lista: Tarea[]) =>
          lista.map((x) =>
            x.id_tarea === t.id_tarea
              ? { ...x, fecha_limite: destinoIso, ...(horas ?? {}) }
              : x,
          );
        const restaurar = (lista: Tarea[]) =>
          lista.map((x) =>
            x.id_tarea === t.id_tarea
              ? { ...x, fecha_limite: snapshotFecha, hora_inicio: t.hora_inicio, hora_fin: t.hora_fin }
              : x,
          );
        const fusionar = (actualizada: Tarea) => (lista: Tarea[]) =>
          lista.map((x) => (x.id_tarea === actualizada.id_tarea ? { ...x, ...actualizada } : x));

        const cuerpo: Record<string, string> = {};
        if (!mismaFecha) cuerpo.fecha_limite = destinoIso;
        if (horas && !mismasHoras) {
          cuerpo.hora_inicio = horas.hora_inicio;
          cuerpo.hora_fin = horas.hora_fin;
        }

        setAvisoCalendario(null);
        setTareas(parchear);
        setTareasHechas(parchear);
        seleccionarDiaSiVisible(destinoIso);
        marcarSoltada(payload.clave);

        try {
          const res = await apiFetch(`/api/tareas/${encodeURIComponent(t.id_tarea)}`, {
            method: 'PATCH',
            body: JSON.stringify(cuerpo),
          });
          const data = (await res.json().catch(() => ({}))) as { tarea?: Tarea; error?: string };
          if (!res.ok) throw new Error(data.error || 'No se pudo cambiar la fecha de la tarea');
          if (!esUltimo()) return;
          if (data.tarea) {
            setTareas(fusionar(data.tarea));
            setTareasHechas(fusionar(data.tarea));
          }
        } catch (e) {
          if (!esUltimo()) return;
          setTareas(restaurar);
          setTareasHechas(restaurar);
          setAvisoCalendario(errorMessage(e, 'No se pudo cambiar la fecha de la tarea'));
        }
        return;
      }

      const r = reunionesRef.current.find((x) => x.id_reunion === payload.id);
      if (!r) return;
      const fechaDisplay = fechaDeReunion(r) ?? '';
      const hiPrev = (r.hora_inicio ?? '').trim();
      const hfPrev = (r.hora_fin ?? '').trim();
      const horas = horasNuevas(hiPrev, hfPrev);
      const mismaFecha = fechaDisplay === destinoIso;
      const mismasHoras = !horas || (horas.hora_inicio === hiPrev && horas.hora_fin === hfPrev);
      if (mismaFecha && mismasHoras) return;
      const esUltimo = reservarSeq();

      const snapshotFecha = r.fecha;
      const cuerpo: Record<string, string> = {};
      if (!mismaFecha) cuerpo.fecha = destinoIso;
      if (horas && !mismasHoras) {
        cuerpo.hora_inicio = horas.hora_inicio;
        cuerpo.hora_fin = horas.hora_fin;
      }

      setAvisoCalendario(null);
      setReuniones((lista) =>
        lista.map((x) => (x.id_reunion === r.id_reunion ? { ...x, fecha: destinoIso, ...(horas ?? {}) } : x)),
      );
      seleccionarDiaSiVisible(destinoIso);
      marcarSoltada(payload.clave);

      try {
        const res = await apiFetch(`/api/reuniones/${encodeURIComponent(r.id_reunion)}`, {
          method: 'PATCH',
          body: JSON.stringify(cuerpo),
        });
        const data = (await res.json().catch(() => ({}))) as {
          reunion?: Reunion;
          error?: string;
          mensaje?: string;
        };
        if (!res.ok) throw new Error(data.error || data.mensaje || 'No se pudo cambiar la fecha de la reunión');
        if (!esUltimo()) return;
        if (data.reunion) {
          setReuniones((lista) =>
            lista.map((x) => (x.id_reunion === data.reunion!.id_reunion ? { ...x, ...data.reunion } : x)),
          );
        }
      } catch (e) {
        if (!esUltimo()) return;
        setReuniones((lista) =>
          lista.map((x) =>
            x.id_reunion === r.id_reunion
              ? { ...x, fecha: snapshotFecha, hora_inicio: r.hora_inicio, hora_fin: r.hora_fin }
              : x,
          ),
        );
        setAvisoCalendario(errorMessage(e, 'No se pudo cambiar la fecha de la reunión'));
      }
    },
    [marcarSoltada, seleccionarDiaSiVisible],
  );

  const soltarEnDia = useCallback(
    (iso: string, payload: PayloadDragAgenda, horaInicio?: string | null) => {
      ignoraClickCelda.current = true;
      setTimeout(() => {
        ignoraClickCelda.current = false;
      }, 0);
      terminarArrastre();
      void moverFechaAgenda(payload, iso, horaInicio);
    },
    [moverFechaAgenda, terminarArrastre],
  );

  const puedeCrearEnHueco = puedeEditarProyectos(acceso) || puedeGestionarReuniones(acceso);

  const abrirHueco = (iso: string, horaInicio: string, x: number, y: number) => {
    if (!puedeCrearEnHueco || arrastro.current || ignoraClickCelda.current) return;
    setHuecoAlta({ iso, horaInicio, x, y });
  };

  const horaDesdePulsacion = (y: number) => {
    const indice = Math.floor((y - PAD_REJILLA_TOP) / ALTO_HORA);
    const hora = Math.min(HORA_VISTA_FIN - 1, Math.max(HORA_VISTA_INICIO, HORA_VISTA_INICIO + indice));
    return `${String(hora).padStart(2, '0')}:00`;
  };

  const yEnColumna = (e: {
    nativeEvent: { locationY: number; pageY: number };
    currentTarget: unknown;
  }) => {
    const nativo = e.nativeEvent as { locationY: number; pageY: number; clientY?: number; target?: EventTarget | null };
    const nodo = (nativo.target ?? e.currentTarget) as HTMLElement | null;
    const clientY = nativo.clientY ?? nativo.pageY;
    if (nodo && typeof nodo.getBoundingClientRect === 'function' && typeof clientY === 'number') {
      const origen = typeof nativo.clientY === 'number' ? clientY : clientY - (typeof window !== 'undefined' ? window.scrollY : 0);
      return origen - nodo.getBoundingClientRect().top;
    }
    return nativo.locationY;
  };

  const pintarPastilla = (item: ItemAgenda) => (
    <PastillaAgenda
      key={item.clave}
      item={item}
      arrastrable={esArrastrable(item)}
      arrastrando={claveArrastrando === item.clave}
      recienSoltada={claveRecienSoltada === item.clave}
      onDragStart={iniciarArrastre}
      onDragEnd={terminarArrastre}
      onAbrir={() => abrirTrasDrag(item)}
      onVistaPrevia={() => {
        ignoraClickCelda.current = true;
        setTimeout(() => {
          ignoraClickCelda.current = false;
        }, 0);
        setVistaPrevia(item);
      }}
    />
  );

  const recargarAgenda = useCallback(() => {
    void cargarBase();
    void cargarHechas();
    void cargarReuniones();
  }, [cargarBase, cargarHechas, cargarReuniones]);

  const marcarRealizadaVista = useCallback(async (tareaId: string) => {
    const res = await apiFetch(`/api/tareas/${encodeURIComponent(tareaId)}/estado`, {
      method: 'POST',
      body: JSON.stringify({ estado: 'hecha' }),
    });
    const data = (await res.json().catch(() => ({}))) as { tarea?: Tarea; error?: string };
    if (!res.ok || !data.tarea) {
      throw new Error(data.error || 'No se pudo marcar la tarea como realizada');
    }
    const hecha = data.tarea;
    setTareas((lista) => lista.filter((t) => t.id_tarea !== tareaId));
    setTareasHechas((lista) => [hecha, ...lista.filter((t) => t.id_tarea !== tareaId)]);
    setVistaPrevia(null);
  }, []);

  const marcarCasillaVista = useCallback(async (tareaId: string, casillaId: string, hecho: boolean) => {
    const res = await apiFetch(
      `/api/tareas/${encodeURIComponent(tareaId)}/checklist/${encodeURIComponent(casillaId)}`,
      { method: 'PATCH', body: JSON.stringify({ hecho }) },
    );
    const data = (await res.json().catch(() => ({}))) as { tarea?: Tarea; error?: string };
    if (!res.ok || !data.tarea) {
      throw new Error(data.error || 'No se pudo actualizar la lista de comprobación');
    }
    const checklist = data.tarea.checklist ?? [];
    const aplicar = (lista: Tarea[]) =>
      lista.map((t) => (t.id_tarea === tareaId ? { ...t, checklist } : t));
    setTareas(aplicar);
    setTareasHechas(aplicar);
    setVistaPrevia((prev) =>
      prev && prev.tipo === 'tarea' && prev.id === tareaId ? { ...prev, checklist } : prev,
    );
  }, []);

  const medirBarraRejilla = useCallback(() => {
    if (Platform.OS !== 'web') return;
    const inst = rejillaScrollRef.current as unknown as {
      getScrollableNode?: () => HTMLElement;
    } | null;
    const desdeRef = inst?.getScrollableNode?.() ?? (inst as unknown as HTMLElement | null);
    const nodo =
      desdeRef && typeof desdeRef.offsetWidth === 'number'
        ? desdeRef
        : document.querySelector<HTMLElement>('[data-testid="rejilla-semana"]');
    if (!nodo) return;
    const ancho = Math.max(0, nodo.offsetWidth - nodo.clientWidth);
    setReservaBarra((prev) => (prev === ancho ? prev : ancho));
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || vista !== 'semana') return;
    medirBarraRejilla();
    window.addEventListener('resize', medirBarraRejilla);
    return () => window.removeEventListener('resize', medirBarraRejilla);
  }, [vista, medirBarraRejilla, cargando]);

  const ir = (delta: number) => {
    if (vista === 'semana') setAncla(addDaysIso(lunesDeSemanaIso(ancla), delta * 7));
    else {
      setAncla(addMonthsIso(inicioMesIso(ancla), delta));
      setDiaSeleccionado(null);
    }
  };

  if (acceso.permisosCargando) return null;
  if (!puedeTareas && !puedeReuniones) return null;

  const tituloRango = vista === 'semana' ? etiquetaSemana(lunes) : etiquetaMes(ancla);
  const esPeriodoActual =
    vista === 'semana'
      ? lunesDeSemanaIso(ancla) === lunesDeSemanaIso(hoy)
      : inicioMesIso(ancla) === inicioMesIso(hoy);
  const tituloBloque = esPeriodoActual
    ? vista === 'semana'
      ? 'Esta semana'
      : 'Este mes'
    : 'Agenda';
  const semanaMovil = isPhone && isPortrait;
  const diasSemana = diasDeSemana(lunes);

  return (
    <View style={[styles.card, embebido && styles.cardEmbebida]}>
      {menuCrearAbierto ? (
        <Pressable
          style={styles.menuOverlay}
          onPress={() => setMenuCrearAbierto(false)}
          accessibilityLabel="Cerrar menú crear"
        />
      ) : null}

      {vistaPrevia ? (
        <PopoverVistaItem
          key={vistaPrevia.clave}
          item={vistaPrevia}
          onCerrar={() => setVistaPrevia(null)}
          onMarcarCasilla={
            vistaPrevia.tipo === 'tarea' && vistaPrevia.puedeMover
              ? (casillaId, hecho) => marcarCasillaVista(vistaPrevia.id, casillaId, hecho)
              : undefined
          }
          onMarcarRealizada={
            vistaPrevia.tipo === 'tarea' &&
            vistaPrevia.puedeMover &&
            (vistaPrevia.estado === 'pendiente' || vistaPrevia.estado === 'en_curso')
              ? () => marcarRealizadaVista(vistaPrevia.id)
              : undefined
          }
        />
      ) : null}

      {huecoAlta ? (
        <AltaHuecoAgenda
          hueco={huecoAlta}
          acceso={acceso}
          onCerrar={() => setHuecoAlta(null)}
          onCreada={(aviso) => {
            setHuecoAlta(null);
            recargarAgenda();
            setAvisoCalendario(aviso ?? null);
          }}
        />
      ) : null}

      <View style={[styles.toolbar, styles.toolbarSobre, shouldStackToolbar && styles.toolbarWrap]}>
        <Text style={styles.tituloBloque}>{tituloBloque}</Text>
        <View style={styles.rango}>
          <TouchableOpacity
            style={styles.rangoBtn}
            onPress={() => ir(-1)}
            accessibilityLabel={vista === 'semana' ? 'Semana anterior' : 'Mes anterior'}
          >
            <MaterialIcons name="chevron-left" size={22} color={tasksUi.color.textoPrimario} />
          </TouchableOpacity>
          <Text style={styles.rangoTexto} numberOfLines={1}>
            {tituloRango}
          </Text>
          <TouchableOpacity
            style={styles.rangoBtn}
            onPress={() => ir(1)}
            accessibilityLabel={vista === 'semana' ? 'Semana siguiente' : 'Mes siguiente'}
          >
            <MaterialIcons name="chevron-right" size={22} color={tasksUi.color.textoPrimario} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.hoyBtn} onPress={() => setAncla(hoyIso())} accessibilityLabel="Ir a hoy">
            <Text style={styles.hoyTexto}>Hoy</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.viewModeWrap}>
          {(
            [
              ['semana', 'calendar-view-week', 'Semana'],
              ['mes', 'calendar-month', 'Mes'],
            ] as const
          ).map(([id, icono, etiqueta]) => {
            const activo = vista === id;
            return (
              <TouchableOpacity
                key={id}
                style={[styles.viewModeBtn, activo && styles.viewModeBtnActive, isCompact && styles.viewModeBtnTactil]}
                onPress={() => setVista(id)}
                accessibilityLabel={`Vista ${etiqueta}`}
                accessibilityState={{ selected: activo }}
              >
                <MaterialIcons name={icono} size={20} color={activo ? tasksUi.color.acentoTexto : tasksUi.color.textoTerciario} />
                <Text style={[styles.viewModeTexto, activo && styles.viewModeTextoActivo]}>{etiqueta}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <BotonCrearAgendaInicio
          acceso={acceso}
          compact={isCompact || shouldStackToolbar}
          menuAbierto={menuCrearAbierto}
          onMenuCambio={setMenuCrearAbierto}
          onRecargar={recargarAgenda}
          onAvisoCalendario={setAvisoCalendario}
        />
      </View>

      <View style={[styles.cuerpoAgenda, embebido && styles.cuerpoAgendaEmbebido]}>
      <View style={styles.leyenda}>
        {(
          [
            puedeTareas ? 'tarea' : null,
            puedeReuniones ? 'reunion' : null,
            puedeTareas ? 'proyecto' : null,
          ] as const
        )
          .filter((tipo): tipo is TipoAgendaInicio => tipo != null)
          .map((tipo) => (
            <View key={tipo} style={styles.leyendaItem}>
              <View style={[styles.leyendaPunto, { backgroundColor: COLOR_AGENDA[tipo] }]} />
              <Text style={styles.leyendaTexto}>{ETIQUETA_TIPO[tipo]}</Text>
            </View>
          ))}
      </View>

      {avisoCalendario ? (
        <TouchableOpacity style={styles.aviso} onPress={() => setAvisoCalendario(null)}>
          <Text style={styles.avisoTexto}>{avisoCalendario}</Text>
        </TouchableOpacity>
      ) : null}

      {error ? (
        <TouchableOpacity
          style={styles.aviso}
          onPress={() => {
            recargarAgenda();
          }}
        >
          <Text style={styles.avisoTexto}>{error}</Text>
          <Text style={styles.avisoAccion}>Reintentar</Text>
        </TouchableOpacity>
      ) : null}

      {cargando && conFecha.length === 0 && sinFecha.length === 0 ? (
        <View style={styles.centro}>
          <ActivityIndicator size="small" color="#0ea5e9" />
          <Text style={styles.centroTexto}>Cargando la agenda…</Text>
        </View>
      ) : vista === 'semana' ? (
        <EnvolverSemana movil={semanaMovil} embebido={embebido}>
        <View
          style={[
            styles.semanaCuerpo,
            semanaMovil ? { width: ANCHO_SEMANA_MOVIL } : styles.semanaCuerpoEscritorio,
            embebido && !semanaMovil && styles.semanaCuerpoEmbebida,
            embebido && semanaMovil && styles.semanaCuerpoEmbebidaMovil,
          ]}
        >
          <BandaCarriles
            barras={empaquetadoSemana.barras}
            overflow={empaquetadoSemana.overflow}
            altoCarril={ALTO_CARRIL_SEMANA}
            columnasFijas={semanaMovil}
            conGutterHoras
            onAbrir={abrir}
          />

          {/* Cabecera de días. El padding derecho reserva el hueco de la barra de la rejilla. */}
          <View
            style={[
              styles.semanaCabecera,
              semanaMovil && styles.semanaFilaMovil,
              reservaBarra > 0 && { paddingRight: reservaBarra },
            ]}
          >
            <View style={styles.gutterHora} />
            <View style={[styles.semanaDias, semanaMovil && styles.semanaDiasMovil]}>
              {diasSemana.map((iso) => {
                const esHoy = iso === hoy;
                const delDiaTodos = porDiaCubierto.get(iso) ?? [];
                return (
                  <View
                    key={`h-${iso}`}
                    style={[styles.colHeaderSemana, semanaMovil && styles.colMovil]}
                  >
                    <Text style={styles.colDow}>{weekdayShortEs(iso).toUpperCase()}</Text>
                    <View style={[styles.colNumWrap, esHoy && styles.colNumHoy]}>
                      <Text style={[styles.colNum, esHoy && styles.colNumTextoHoy]}>{diaNumero(iso)}</Text>
                    </View>
                    {esHoy ? <View style={styles.colHoyLinea} /> : <View style={styles.colHoyLineaHueco} />}
                    {delDiaTodos.length > 0 ? <Text style={styles.colCount}>{delDiaTodos.length}</Text> : null}
                  </View>
                );
              })}
            </View>
          </View>

          {/* Franja todo el día */}
          <View
            style={[
              styles.todoElDiaFila,
              semanaMovil && styles.semanaFilaMovil,
              reservaBarra > 0 && { paddingRight: reservaBarra },
            ]}
          >
            <View style={styles.gutterHora}>
              <Text style={styles.todoElDiaLabel} numberOfLines={1}>
                Todo el día
              </Text>
            </View>
            <View style={[styles.semanaDias, semanaMovil && styles.semanaDiasMovil]}>
              {diasSemana.map((iso) => {
                const items = todoElDiaPorDia.get(iso) ?? [];
                const sobre = isoDragOver === iso;
                return (
                  <ZonaDropDia
                    key={`td-${iso}`}
                    iso={iso}
                    estiloWeb={semanaMovil ? { width: COL_MIN, flex: '0 0 auto' } : { flex: 1 }}
                    onEnter={entrarDrop}
                    onLeave={salirDrop}
                    horaAlSoltar={() => null}
                    onSoltar={soltarEnDia}
                  >
                    <Pressable
                      style={[
                        styles.todoElDiaCol,
                        semanaMovil && styles.colMovil,
                        sobre && styles.colDragOver,
                      ]}
                      onPress={(e) => abrirHueco(iso, '', e.nativeEvent.pageX, e.nativeEvent.pageY)}
                    >
                      {items.map((item) => pintarPastilla(item))}
                    </Pressable>
                  </ZonaDropDia>
                );
              })}
            </View>
          </View>

          {/* Rejilla horaria */}
          <ScrollView
            ref={rejillaScrollRef}
            style={[styles.rejillaScroll, embebido ? styles.rejillaScrollEmbebida : styles.rejillaScrollInicio]}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            onLayout={medirBarraRejilla}
          >
            <View style={[styles.rejillaFila, semanaMovil && styles.semanaFilaMovil, { minHeight: ALTO_REJILLA_CAJA }]}>
              <View style={[styles.gutterHora, { height: ALTO_REJILLA_CAJA }]}>
                {HORAS_ETIQUETA.map((h) => (
                  <Text
                    key={h}
                    style={[
                      styles.horaEtiqueta,
                      {
                        top:
                          ((h - HORA_VISTA_INICIO) / (HORA_VISTA_FIN - HORA_VISTA_INICIO)) * ALTO_REJILLA +
                          PAD_REJILLA_TOP -
                          8,
                      },
                    ]}
                  >
                    {`${String(h).padStart(2, '0')}:00`}
                  </Text>
                ))}
              </View>
              <View style={[styles.semanaDias, semanaMovil && styles.semanaDiasMovil, { height: ALTO_REJILLA_CAJA }]}>
                {diasSemana.map((iso) => {
                  const bloques = bloquesPorDia.get(iso) ?? [];
                  const sobre = isoDragOver === iso;
                  return (
                    <ZonaDropDia
                      key={`g-${iso}`}
                      iso={iso}
                      estiloWeb={
                        semanaMovil
                          ? { width: COL_MIN, flex: '0 0 auto', height: ALTO_REJILLA_CAJA }
                          : { flex: 1, height: ALTO_REJILLA_CAJA }
                      }
                      onEnter={entrarDrop}
                      onLeave={salirDrop}
                      horaAlSoltar={horaDesdePulsacion}
                      onSoltar={soltarEnDia}
                    >
                      <Pressable
                        style={[
                          styles.colRejilla,
                          semanaMovil && styles.colMovil,
                          sobre && styles.colDragOver,
                          { height: ALTO_REJILLA_CAJA },
                        ]}
                        onPress={(e) =>
                          abrirHueco(
                            iso,
                            horaDesdePulsacion(yEnColumna(e)),
                            e.nativeEvent.pageX,
                            e.nativeEvent.pageY,
                          )
                        }
                      >
                        {Array.from({ length: HORA_VISTA_FIN - HORA_VISTA_INICIO }, (_, i) => (
                          <View
                            key={i}
                            pointerEvents="none"
                            style={[styles.lineaHora, { top: i * ALTO_HORA + PAD_REJILLA_TOP }]}
                          />
                        ))}
                        {iso === hoy &&
                        minutosAhora >= MINUTOS_DIA_INICIO &&
                        minutosAhora < MINUTOS_DIA_FIN ? (
                          <View
                            pointerEvents="none"
                            style={[
                              styles.lineaAhora,
                              {
                                top:
                                  ((minutosAhora - MINUTOS_DIA_INICIO) / 60) * ALTO_HORA +
                                  PAD_REJILLA_TOP,
                              },
                            ]}
                          >
                            <View style={styles.lineaAhoraPunto} />
                          </View>
                        ) : null}
                        {bloques.map((b) => (
                          <BloqueHorario
                            key={b.item.clave}
                            bloque={b}
                            arrastrable={esArrastrable(b.item)}
                            arrastrando={claveArrastrando === b.item.clave}
                            recienSoltada={claveRecienSoltada === b.item.clave}
                            onAbrir={() => abrirTrasDrag(b.item)}
                            onVistaPrevia={() => {
                              ignoraClickCelda.current = true;
                              setTimeout(() => {
                                ignoraClickCelda.current = false;
                              }, 0);
                              setVistaPrevia(b.item);
                            }}
                            onDragStart={iniciarArrastre}
                            onDragEnd={terminarArrastre}
                          />
                        ))}
                      </Pressable>
                    </ZonaDropDia>
                  );
                })}
              </View>
            </View>
          </ScrollView>
        </View>
        </EnvolverSemana>
      ) : (
        <EnvolverMes embebido={embebido}>
        <View style={styles.mesWrap}>
          <View style={styles.mesCabecera}>
            {diasDeSemana(lunesDeSemanaIso(hoy)).map((iso) => (
              <Text key={iso} style={styles.mesDow}>
                {weekdayShortEs(iso).toUpperCase()}
              </Text>
            ))}
          </View>
          <View style={styles.mesMarco}>
            {semanas.map((fila, iFila) => {
              const pack = empaquetadoMes[iFila] ?? { barras: [], overflow: 0 };
              const altoBanda = alturaBanda(nCarrilesDe(pack.barras), pack.overflow, ALTO_CARRIL_MES, true);
              return (
                <View
                  key={fila[0]?.iso ?? iFila}
                  style={[
                    styles.mesFila,
                    iFila === semanas.length - 1 && styles.mesFilaUltima,
                    altoBanda > 0 && { minHeight: 56 + altoBanda },
                  ]}
                >
                  {fila.map(({ iso, delMes }, iCol) => {
                    const delDia = porDiaCubierto.get(iso) ?? [];
                    const citas = delDia.filter((item) => item.tipo !== 'proyecto');
                    const chips = citas.slice(0, 2);
                    const resto = citas.length - chips.length;
                    const esHoy = iso === hoy;
                    const seleccionado = iso === diaSeleccionado;
                    const sobre = isoDragOver === iso;
                    return (
                      <ZonaDropDia
                        key={iso}
                        iso={iso}
                        estiloWeb={{ flex: 1 }}
                        onEnter={entrarDrop}
                        onLeave={salirDrop}
                        onSoltar={soltarEnDia}
                      >
                        <TouchableOpacity
                          style={[
                            styles.celda,
                            iCol === fila.length - 1 && styles.celdaUltima,
                            !delMes && styles.celdaFuera,
                            seleccionado && styles.celdaSel,
                            sobre && styles.celdaDragOver,
                            altoBanda > 0 && { paddingBottom: altoBanda },
                            { flex: 1 },
                          ]}
                          onPress={() => {
                            if (ignoraClickCelda.current) return;
                            if (!delMes) {
                              setAncla(iso);
                              setDiaSeleccionado(iso);
                              return;
                            }
                            setDiaSeleccionado(seleccionado ? null : iso);
                          }}
                          accessibilityLabel={`${weekdayHeaderEs(iso)}, ${delDia.length} elementos`}
                        >
                          <View style={[styles.mesNumWrap, esHoy && styles.colNumHoy]}>
                            <Text
                              style={[
                                styles.mesNum,
                                esHoy && styles.colNumTextoHoy,
                                !delMes && !esHoy && styles.celdaNumFuera,
                              ]}
                            >
                              {diaNumero(iso)}
                            </Text>
                          </View>
                          <View style={styles.chipsMes}>
                            {chips.map((item) => (
                              <View key={item.clave} style={styles.chipMes}>
                                <View style={[styles.chipMesBarra, { backgroundColor: colorPuntoDia(item) }]} />
                                <Text style={styles.chipMesTexto} numberOfLines={1}>
                                  {item.titulo}
                                </Text>
                              </View>
                            ))}
                            {resto > 0 ? <Text style={styles.masPuntos}>+{resto}</Text> : null}
                          </View>
                        </TouchableOpacity>
                      </ZonaDropDia>
                    );
                  })}
                  {altoBanda > 0 ? (
                    <View style={styles.mesBandaAbs} pointerEvents="box-none">
                      <BandaCarriles
                        barras={pack.barras}
                        overflow={pack.overflow}
                        altoCarril={ALTO_CARRIL_MES}
                        compacta
                        onAbrir={abrir}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
          {diaSeleccionado ? (
            <ZonaDropDia
              iso={diaSeleccionado}
              onEnter={entrarDrop}
              onLeave={salirDrop}
              onSoltar={soltarEnDia}
            >
              <View style={[styles.diaPanel, isoDragOver === diaSeleccionado && styles.diaPanelDragOver]}>
                <Text style={styles.diaPanelTitulo}>
                  {weekdayHeaderEs(diaSeleccionado)}
                  {diaSeleccionado === hoy ? ' · Hoy' : ''}
                </Text>
                {(porDiaCubierto.get(diaSeleccionado) ?? []).length === 0 ? (
                  <Text style={styles.vacioDia}>Nada este día.</Text>
                ) : (
                  <View style={styles.diaLista}>
                    {[...(porDiaCubierto.get(diaSeleccionado) ?? [])]
                      .sort(compararPorHoraInicio)
                      .map((item) => pintarPastilla(item))}
                  </View>
                )}
              </View>
            </ZonaDropDia>
          ) : (
            <Text style={styles.pistaMes}>Toca un día para ver el detalle.</Text>
          )}
        </View>
        </EnvolverMes>
      )}

      {sinFecha.length > 0 ? (
        <View style={styles.cajon}>
          <Text style={styles.cajonTitulo}>Sin fecha ({sinFecha.length})</Text>
          <ScrollView horizontal contentContainerStyle={styles.cajonLista} showsHorizontalScrollIndicator={false}>
            {sinFecha.map((item) => (
              <View key={item.clave} style={styles.cajonItem}>
                {pintarPastilla(item)}
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'relative',
    width: '100%',
    backgroundColor: tasksUi.color.superficie,
    borderRadius: tasksUi.radius.contenedor,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    padding: 12,
    gap: 10,
  },
  cardEmbebida: {
    flex: 1,
    minHeight: 0,
    borderWidth: 0,
    borderRadius: 0,
    paddingTop: 4,
  },
  menuOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
  },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toolbarSobre: {
    position: 'relative',
    zIndex: 30,
    ...(Platform.OS === 'web' ? {} : { elevation: 30 }),
  },
  toolbarWrap: { flexWrap: 'wrap' },
  cuerpoAgenda: { position: 'relative', zIndex: 0, gap: 10 },
  cuerpoAgendaEmbebido: { flex: 1, minHeight: 0 },
  tituloBloque: { ...tasksUi.tipo.tituloSeccion },
  rango: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minWidth: 200 },
  rangoBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: tasksUi.radius.control,
    backgroundColor: tasksUi.color.superficie,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rangoTexto: { ...tasksUi.tipo.dato, minWidth: 110, textAlign: 'center' },
  hoyBtn: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: tasksUi.radius.control,
    backgroundColor: tasksUi.color.acentoSuave,
    borderWidth: 1,
    borderColor: tasksUi.color.acentoSuave,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hoyTexto: { fontSize: 13, fontWeight: '600', color: tasksUi.color.acentoTexto },
  viewModeWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    borderRadius: tasksUi.radius.control,
    overflow: 'hidden',
  },
  viewModeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: tasksUi.color.superficie,
  },
  viewModeBtnTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 14 },
  viewModeBtnActive: { backgroundColor: tasksUi.color.acentoSuave },
  viewModeTexto: { fontSize: 13, fontWeight: '500', color: tasksUi.color.textoTerciario },
  viewModeTextoActivo: { color: tasksUi.color.acentoTexto, fontWeight: '600' },

  leyenda: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  leyendaItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  leyendaPunto: { width: 8, height: 8, borderRadius: 4 },
  leyendaTexto: { ...tasksUi.tipo.etiqueta, color: tasksUi.color.textoSecundario },

  aviso: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  avisoTexto: { flex: 1, ...tasksUi.tipo.etiqueta, color: tasksUi.color.peligro },
  avisoAccion: { ...tasksUi.tipo.etiqueta, fontWeight: '600', color: tasksUi.color.acento },
  centro: { alignItems: 'center', gap: 8, paddingVertical: 20 },
  centroTexto: { fontSize: 13, color: tasksUi.color.textoSecundario },

  semanaScroll: {},
  semanaScrollEmbebida: { flex: 1, minHeight: 0 },
  mesScrollEmbebido: { flex: 1, minHeight: 0 },
  semanaCuerpo: { flexDirection: 'column', gap: 4 },
  semanaCuerpoEmbebida: { flex: 1, minHeight: 0, width: '100%' },
  semanaCuerpoEmbebidaMovil: { flex: 1, minHeight: 0 },
  semanaCuerpoEscritorio: { flexGrow: 1, width: '100%' },
  semanaFilaMovil: { width: ANCHO_SEMANA_MOVIL },
  semanaCabecera: {
    flexDirection: 'row',
    alignItems: 'stretch',
    width: '100%',
  },
  semanaDias: {
    flex: 1,
    flexDirection: 'row',
    gap: GAP_SEMANA,
    minWidth: 0,
  },
  semanaDiasMovil: {
    flex: 0,
    width: 7 * COL_MIN + 6 * GAP_SEMANA,
  },
  todoElDiaFila: {
    flexDirection: 'row',
    alignItems: 'stretch',
    width: '100%',
    minHeight: 44,
  },
  todoElDiaLabel: {
    ...tasksUi.tipo.micro,
    fontWeight: '600',
    color: tasksUi.color.textoTerciario,
    textAlign: 'right',
    paddingRight: 14,
    paddingTop: 4,
  },
  todoElDiaCol: {
    flex: 1,
    minWidth: 0,
    gap: 4,
    padding: 4,
    borderRadius: 10,
    backgroundColor: '#eef1f6',
    minHeight: 32,
  },
  rejillaScroll: {
    backgroundColor: 'transparent',
  },
  rejillaScrollInicio: {
    maxHeight: ALTO_REJILLA_CAJA,
  },
  rejillaScrollEmbebida: {
    flex: 1,
    minHeight: 0,
  },
  rejillaFila: {
    flexDirection: 'row',
    width: '100%',
  },
  gutterHora: {
    width: ANCHO_ETIQUETA_HORA,
    flexShrink: 0,
    position: 'relative',
    overflow: 'hidden',
  },
  horaEtiqueta: {
    position: 'absolute',
    right: 14,
    ...tasksUi.tipo.micro,
    color: tasksUi.color.textoTerciario,
    fontWeight: '600',
  },
  colHeaderSemana: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    gap: 2,
    paddingVertical: 4,
    backgroundColor: 'transparent',
  },
  colDow: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
    color: tasksUi.color.textoTerciario,
  },
  colNumWrap: {
    minWidth: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  colNumHoy: { backgroundColor: '#0ea5e9' },
  colNum: { fontSize: 22, fontWeight: '700', color: '#0f172a', lineHeight: 26 },
  colNumTextoHoy: { color: '#ffffff' },
  colHoyLinea: {
    width: 36,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#0ea5e9',
    marginTop: 2,
  },
  colHoyLineaHueco: { width: 36, height: 2, marginTop: 2 },
  colRejilla: {
    flex: 1,
    minWidth: 0,
    position: 'relative',
    overflow: 'hidden',
  },
  lineaHora: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: '#e7ebf0',
  },
  lineaAhora: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: '#f43f5e',
    zIndex: 4,
  },
  lineaAhoraPunto: {
    position: 'absolute',
    left: -3,
    top: -3,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#f43f5e',
  },
  bloque: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderLeftWidth: 3,
    borderRadius: 12,
    overflow: 'hidden',
    paddingRight: 2,
    zIndex: 2,
  },
  bloqueToque: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  bloqueTituloFila: { flexDirection: 'row', alignItems: 'flex-start', gap: 4 },
  bloqueTitulo: {
    ...tasksUi.tipo.micro,
    fontWeight: '700',
    color: tasksUi.color.textoPrimario,
    lineHeight: 14,
  },
  bloqueTituloTexto: { flex: 1, minWidth: 0 },
  bloqueHora: {
    ...tasksUi.tipo.micro,
    fontWeight: '500',
    marginTop: 1,
    color: tasksUi.color.textoTerciario,
  },

  bandaCarriles: {
    position: 'relative',
    width: '100%',
    backgroundColor: tasksUi.color.superficieHundida,
    borderRadius: tasksUi.radius.contenedor,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
  },
  bandaCarrilesMes: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
  },
  mesBandaAbs: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1,
  },
  barraCuerpo: {
    flex: 1,
    minWidth: 0,
    backgroundColor: FONDO_AGENDA.proyecto,
    borderWidth: 1,
    borderColor: '#f9a8d4',
    borderRadius: 8,
    justifyContent: 'center',
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  barraContinuaIzq: {
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderLeftWidth: 0,
  },
  barraContinuaDer: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    borderRightWidth: 0,
  },
  barraTitulo: { ...tasksUi.tipo.etiqueta, fontWeight: '600', color: COLOR_AGENDA.proyecto },
  barraTituloMes: { fontSize: 12, lineHeight: 16 },
  masProyectos: {
    position: 'absolute',
    left: 8,
    right: 8,
    ...tasksUi.tipo.micro,
    fontWeight: '600',
    color: COLOR_AGENDA.proyecto,
  },
  colMovil: { width: COL_MIN, flex: 0 },
  colHoy: { borderColor: tasksUi.color.acentoSuave, backgroundColor: tasksUi.color.acentoSuave },
  colDragOver: {
    backgroundColor: tasksUi.color.acentoSuave,
    borderColor: tasksUi.color.acento,
  },
  colDia: { ...tasksUi.tipo.micro, fontWeight: '600', color: tasksUi.color.textoSecundario },
  colDiaHoy: { color: tasksUi.color.acentoTexto },
  badgeHoy: { ...tasksUi.tipo.micro, fontWeight: '600', color: tasksUi.color.acentoTexto },
  colCount: { marginLeft: 'auto', ...tasksUi.tipo.micro, fontWeight: '600', color: tasksUi.color.textoTerciario },

  mesWrap: { gap: 8 },
  mesCabecera: { flexDirection: 'row' },
  mesDow: {
    flex: 1,
    textAlign: 'left',
    paddingLeft: 6,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
    color: tasksUi.color.textoTerciario,
  },
  mesMarco: {
    borderRadius: tasksUi.radius.contenedor,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  mesFila: {
    position: 'relative',
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e7ebf0',
  },
  mesFilaUltima: { borderBottomWidth: 0 },
  celda: {
    flex: 1,
    minHeight: 88,
    minWidth: 0,
    paddingVertical: 6,
    paddingHorizontal: 4,
    alignItems: 'flex-start',
    gap: 4,
    backgroundColor: 'transparent',
  },
  celdaUltima: {},
  celdaFuera: { opacity: 0.45 },
  celdaHoy: {},
  celdaSel: {
    borderWidth: 1,
    borderColor: '#0ea5e9',
    borderRadius: 10,
  },
  celdaDragOver: {
    backgroundColor: tasksUi.color.acentoSuave,
    borderRadius: 10,
  },
  diaPanelDragOver: {
    backgroundColor: tasksUi.color.acentoSuave,
    borderColor: tasksUi.color.acento,
  },
  mesNumWrap: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mesNum: { fontSize: 16, fontWeight: '700', color: '#0f172a', lineHeight: 20 },
  celdaNum: { fontSize: 13, fontWeight: '600', color: tasksUi.color.textoPrimario },
  celdaNumHoy: { color: tasksUi.color.acentoTexto },
  celdaNumFuera: { color: tasksUi.color.textoTerciario },
  chipsMes: { alignSelf: 'stretch', gap: 3, minWidth: 0 },
  chipMes: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'stretch',
    minWidth: 0,
    backgroundColor: '#f8fafc',
    borderRadius: 6,
    overflow: 'hidden',
    paddingRight: 4,
  },
  chipMesBarra: { width: 3, alignSelf: 'stretch', minHeight: 16 },
  chipMesTexto: { flex: 1, minWidth: 0, fontSize: 11, fontWeight: '600', color: '#0f172a' },
  puntos: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 8 },
  punto: { width: 7, height: 7, borderRadius: 4 },
  masPuntos: { fontSize: 11, fontWeight: '600', color: tasksUi.color.textoSecundario },
  celdaCount: { ...tasksUi.tipo.micro, color: tasksUi.color.textoSecundario },
  diaPanel: {
    backgroundColor: tasksUi.color.superficie,
    borderRadius: 12,
    padding: 10,
    gap: 8,
  },
  diaPanelTitulo: { ...tasksUi.tipo.tituloSeccion },
  diaLista: { gap: 6 },
  vacioDia: { fontSize: 13, color: tasksUi.color.textoSecundario },
  pistaMes: { ...tasksUi.tipo.etiqueta, textAlign: 'center' },

  cajon: { gap: 6 },
  cajonTitulo: { ...tasksUi.tipo.etiqueta },
  cajonLista: { gap: 8, paddingBottom: 2 },
  cajonItem: { width: 220 },

  pill: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: tasksUi.color.superficie,
    borderRadius: 12,
    overflow: 'hidden',
    minHeight: 36,
  },
  pillToque: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  pillFranja: { width: 3 },
  pillCuerpo: { flex: 1, minWidth: 0, paddingHorizontal: 7, paddingVertical: 5, gap: 2 },
  pillTitulo: { ...tasksUi.tipo.etiqueta, fontWeight: '600', color: tasksUi.color.textoPrimario, lineHeight: 16 },
  pillMetaFila: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pillMeta: { ...tasksUi.tipo.micro, fontWeight: '500' },
  pillMetaTexto: { flexShrink: 1 },
  pillHecho: { color: TEXTO_TAREA_HECHA, textDecorationLine: 'line-through' },
  pillArrastrando: { opacity: 0.4 },
  pillRecienSoltada: { borderColor: tasksUi.color.acento },

  ojoBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },

  popoverOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    zIndex: 100,
  },
  popoverCard: {
    width: '100%',
    maxWidth: 360,
    maxHeight: '80%',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    padding: 14,
    gap: 10,
    ...(Platform.OS === 'web'
      ? ({ boxShadow: '0 12px 32px rgba(0,0,0,0.18)' } as object)
      : { elevation: 16 }),
  },
  popoverHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  popoverTitulo: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: tasksUi.color.textoPrimario,
  },
  popoverAccion: { gap: 6 },
  btnRealizada: {
    minHeight: MIN_TOUCH,
    borderRadius: 10,
    backgroundColor: '#16a34a',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14,
  },
  btnRealizadaTexto: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  popoverCerrar: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -6,
    marginRight: -6,
  },
  popoverScroll: { flexGrow: 0, maxHeight: 420 },
  popoverScrollContent: { gap: 10 },
  popoverLista: { gap: 4, marginTop: 2 },
  popoverListaCabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 2,
  },
  popoverCasilla: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 4 },
  popoverCasillaTactil: { minHeight: MIN_TOUCH, alignItems: 'center' },
  popoverCasillaTexto: { flex: 1, fontSize: 14, color: tasksUi.color.textoPrimario, lineHeight: 20 },
  popoverCasillaHecha: {
    color: tasksUi.color.textoTerciario,
    textDecorationLine: 'line-through',
  },
  popoverError: { fontSize: 12, color: tasksUi.color.peligro },
  popoverDesc: {
    fontSize: 13,
    lineHeight: 18,
    color: tasksUi.color.textoSecundario,
  },
  popoverFila: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  popoverLabel: {
    ...tasksUi.tipo.micro,
    fontWeight: '600',
    color: tasksUi.color.textoTerciario,
  },
  popoverValor: {
    ...tasksUi.tipo.etiqueta,
    fontWeight: '600',
    color: tasksUi.color.textoPrimario,
  },
});
