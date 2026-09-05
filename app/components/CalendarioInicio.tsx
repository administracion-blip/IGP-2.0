/**
 * Agenda de Inicio: semana (por defecto) o mes con las tareas, reuniones y
 * proyectos visibles para quien entra. Reutiliza las APIs ya filtradas por
 * servidor; el color distingue el tipo, no el departamento.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../constants/layout';
import { tasksUi } from '../constants/tasksUiTokens';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useAccesoTasks } from '../hooks/useAccesoTasks';
import { puedeVerProyectos, puedeVerReuniones } from '../lib/tasksAcceso';
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
  weekdayUltraEs,
} from '../lib/tasksCalendario';
import { apiFetch, errorMessage } from '../utils/api';
import type { Proyecto, Reunion, Tarea } from '../types/tasks';

const COL_MIN = 132;
const GAP_SEMANA = 6;
const ANCHO_SEMANA_MOVIL = 7 * COL_MIN + 6 * GAP_SEMANA;
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

export type TipoAgendaInicio = 'tarea' | 'reunion' | 'proyecto';

export const COLOR_AGENDA: Record<TipoAgendaInicio, string> = {
  tarea: '#ca8a04',
  reunion: '#7c3aed',
  proyecto: '#db2777',
};

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
  titulo: string;
  fecha: string;
  /** Fin inclusive del tramo; solo si hay más de un día. */
  fechaFin?: string;
  meta?: string;
  ruta: string;
};

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

function itemsDeFuentes({
  tareas,
  reuniones,
  proyectos,
  incluirTareas,
  incluirReuniones,
  incluirProyectos,
}: {
  tareas: Tarea[];
  reuniones: Reunion[];
  proyectos: Proyecto[];
  incluirTareas: boolean;
  incluirReuniones: boolean;
  incluirProyectos: boolean;
}): { conFecha: ItemAgenda[]; sinFecha: ItemAgenda[] } {
  const conFecha: ItemAgenda[] = [];
  const sinFecha: ItemAgenda[] = [];

  if (incluirTareas) {
    for (const t of tareas) {
      const item: ItemAgenda = {
        clave: `tarea:${t.id_tarea}`,
        tipo: 'tarea',
        titulo: t.titulo,
        fecha: fechaLimiteCalendario(t.fecha_limite) ?? '',
        meta: t.proyecto_nombre?.trim() || undefined,
        ruta: `/proyectos/tarea/${encodeURIComponent(t.id_tarea)}`,
      };
      if (item.fecha) conFecha.push(item);
      else sinFecha.push(item);
    }
  }

  if (incluirReuniones) {
    for (const r of reuniones) {
      if (r.estado === 'cancelada') continue;
      const fecha = fechaDeReunion(r);
      if (!fecha) continue;
      const ini = (r.hora_inicio ?? '').trim();
      const fin = (r.hora_fin ?? '').trim();
      conFecha.push({
        clave: `reunion:${r.id_reunion}`,
        tipo: 'reunion',
        titulo: r.titulo,
        fecha,
        meta: ini && fin ? `${ini} – ${fin}` : ini || undefined,
        ruta: `/reuniones/${encodeURIComponent(r.id_reunion)}`,
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
      };
      if (item.fecha) conFecha.push(item);
      else sinFecha.push(item);
    }
  }

  return { conFecha, sinFecha };
}

function PastillaAgenda({ item, onAbrir }: { item: ItemAgenda; onAbrir: () => void }) {
  const color = COLOR_AGENDA[item.tipo];
  return (
    <TouchableOpacity
      style={[styles.pill, { backgroundColor: FONDO_AGENDA[item.tipo] }]}
      onPress={onAbrir}
      activeOpacity={0.75}
      accessibilityLabel={`${ETIQUETA_TIPO[item.tipo]}: ${item.titulo}`}
    >
      <View style={[styles.pillFranja, { backgroundColor: color }]} />
      <View style={styles.pillCuerpo}>
        <Text style={styles.pillTitulo} numberOfLines={2}>
          {item.titulo}
        </Text>
        <Text style={[styles.pillMeta, { color }]} numberOfLines={1}>
          {ETIQUETA_TIPO[item.tipo]}
          {item.meta ? ` · ${item.meta}` : ''}
        </Text>
      </View>
    </TouchableOpacity>
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
  /** Semana móvil: columnas de ancho fijo + gap, no flex. */
  columnasFijas?: boolean;
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
          left: indiceInicio * (COL_MIN + GAP_SEMANA),
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
        left: 0,
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
  onAbrir,
}: {
  barras: BarraEmpaquetada[];
  overflow: number;
  altoCarril: number;
  compacta?: boolean;
  columnasFijas?: boolean;
  onAbrir: (item: ItemAgenda) => void;
}) {
  const n = nCarrilesDe(barras);
  const height = alturaBanda(n, overflow, altoCarril, compacta);
  if (height === 0) return null;
  const pad = compacta ? PAD_BANDA_MES : PAD_BANDA;
  return (
    <View style={[styles.bandaCarriles, compacta && styles.bandaCarrilesMes, { height }]} pointerEvents="box-none">
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
          onAbrir={() => onAbrir(b.item)}
        />
      ))}
      {overflow > 0 ? (
        <Text
          pointerEvents="none"
          style={[styles.masProyectos, { bottom: Math.max(0, pad - 1) }]}
        >
          +{overflow} {overflow === 1 ? 'proyecto' : 'proyectos'}
        </Text>
      ) : null}
    </View>
  );
}

export function CalendarioInicio() {
  const router = useRouter();
  const acceso = useAccesoTasks();
  const { isPhone, isPortrait, isCompact, shouldStackToolbar } = useBreakpoint();

  const puedeTareas = puedeVerProyectos(acceso);
  const puedeReuniones = puedeVerReuniones(acceso);

  const [vista, setVista] = useState<'semana' | 'mes'>('semana');
  const [ancla, setAncla] = useState(hoyIso);
  const [diaSeleccionado, setDiaSeleccionado] = useState<string | null>(null);

  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [reuniones, setReuniones] = useState<Reunion[]>([]);
  const [proyectos, setProyectos] = useState<Proyecto[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqReuniones = useRef(0);

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

  useFocusEffect(
    useCallback(() => {
      void cargarBase();
    }, [cargarBase]),
  );

  useEffect(() => {
    void cargarReuniones();
  }, [cargarReuniones]);

  const { conFecha, sinFecha } = useMemo(
    () =>
      itemsDeFuentes({
        tareas,
        reuniones,
        proyectos,
        incluirTareas: puedeTareas,
        incluirReuniones: puedeReuniones,
        incluirProyectos: puedeTareas,
      }),
    [tareas, reuniones, proyectos, puedeTareas, puedeReuniones],
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

  return (
    <View style={styles.card}>
      <View style={[styles.toolbar, shouldStackToolbar && styles.toolbarWrap]}>
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
      </View>

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

      {error ? (
        <TouchableOpacity
          style={styles.aviso}
          onPress={() => {
            void cargarBase();
            void cargarReuniones();
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
        <ScrollView
          horizontal={isPhone && isPortrait}
          style={styles.semanaScroll}
          contentContainerStyle={[
            styles.semanaCuerpo,
            isPhone && isPortrait ? { width: ANCHO_SEMANA_MOVIL } : styles.semanaCuerpoEscritorio,
          ]}
        >
          <BandaCarriles
            barras={empaquetadoSemana.barras}
            overflow={empaquetadoSemana.overflow}
            altoCarril={ALTO_CARRIL_SEMANA}
            columnasFijas={isPhone && isPortrait}
            onAbrir={abrir}
          />
          <View style={[styles.semanaFila, isPhone && isPortrait && styles.semanaFilaMovil]}>
            {diasDeSemana(lunes).map((iso) => {
              const delDiaPuntuales = porDiaPuntuales.get(iso) ?? [];
              const delDiaTodos = porDiaCubierto.get(iso) ?? [];
              const esHoy = iso === hoy;
              return (
                <View
                  key={iso}
                  style={[styles.col, isPhone && isPortrait && styles.colMovil, esHoy && styles.colHoy]}
                >
                  <View style={styles.colHeader}>
                    <Text style={[styles.colDia, esHoy && styles.colDiaHoy]}>{weekdayHeaderEs(iso)}</Text>
                    {esHoy ? <Text style={styles.badgeHoy}>Hoy</Text> : null}
                    {delDiaTodos.length > 0 ? <Text style={styles.colCount}>{delDiaTodos.length}</Text> : null}
                  </View>
                  <ScrollView style={styles.colLista} contentContainerStyle={styles.colListaContent} nestedScrollEnabled>
                    {delDiaPuntuales.map((item) => (
                      <PastillaAgenda key={item.clave} item={item} onAbrir={() => abrir(item)} />
                    ))}
                  </ScrollView>
                </View>
              );
            })}
          </View>
        </ScrollView>
      ) : (
        <View style={styles.mesWrap}>
          <View style={styles.mesCabecera}>
            {diasDeSemana(lunesDeSemanaIso(hoy)).map((iso) => (
              <Text key={iso} style={styles.mesDow}>
                {weekdayUltraEs(iso)}
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
                    const colores = [...new Set(delDia.map((it) => COLOR_AGENDA[it.tipo]))];
                    const visibles = colores.slice(0, MAX_PUNTOS);
                    const extra = colores.length - visibles.length;
                    const esHoy = iso === hoy;
                    const seleccionado = iso === diaSeleccionado;
                    return (
                      <TouchableOpacity
                        key={iso}
                        style={[
                          styles.celda,
                          iCol === fila.length - 1 && styles.celdaUltima,
                          !delMes && styles.celdaFuera,
                          esHoy && styles.celdaHoy,
                          seleccionado && styles.celdaSel,
                          altoBanda > 0 && { paddingBottom: altoBanda },
                        ]}
                        onPress={() => {
                          if (!delMes) {
                            setAncla(iso);
                            setDiaSeleccionado(iso);
                            return;
                          }
                          setDiaSeleccionado(seleccionado ? null : iso);
                        }}
                        accessibilityLabel={`${weekdayHeaderEs(iso)}, ${delDia.length} elementos`}
                      >
                        <Text style={[styles.celdaNum, esHoy && styles.celdaNumHoy, !delMes && styles.celdaNumFuera]}>
                          {diaNumero(iso)}
                        </Text>
                        <View style={styles.puntos}>
                          {visibles.map((c) => (
                            <View key={c} style={[styles.punto, { backgroundColor: c }]} />
                          ))}
                          {extra > 0 ? <Text style={styles.masPuntos}>+{extra}</Text> : null}
                        </View>
                        {delDia.length > 0 ? <Text style={styles.celdaCount}>·{delDia.length}</Text> : null}
                      </TouchableOpacity>
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
            <View style={styles.diaPanel}>
              <Text style={styles.diaPanelTitulo}>
                {weekdayHeaderEs(diaSeleccionado)}
                {diaSeleccionado === hoy ? ' · Hoy' : ''}
              </Text>
              {(porDiaCubierto.get(diaSeleccionado) ?? []).length === 0 ? (
                <Text style={styles.vacioDia}>Nada este día.</Text>
              ) : (
                <View style={styles.diaLista}>
                  {(porDiaCubierto.get(diaSeleccionado) ?? []).map((item) => (
                    <PastillaAgenda key={item.clave} item={item} onAbrir={() => abrir(item)} />
                  ))}
                </View>
              )}
            </View>
          ) : (
            <Text style={styles.pistaMes}>Toca un día para ver el detalle.</Text>
          )}
        </View>
      )}

      {sinFecha.length > 0 ? (
        <View style={styles.cajon}>
          <Text style={styles.cajonTitulo}>Sin fecha ({sinFecha.length})</Text>
          <ScrollView horizontal contentContainerStyle={styles.cajonLista} showsHorizontalScrollIndicator={false}>
            {sinFecha.map((item) => (
              <View key={item.clave} style={styles.cajonItem}>
                <PastillaAgenda item={item} onAbrir={() => abrir(item)} />
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    backgroundColor: tasksUi.color.superficie,
    borderRadius: tasksUi.radius.contenedor,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    padding: 12,
    gap: 10,
  },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toolbarWrap: { flexWrap: 'wrap' },
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
  semanaCuerpo: { flexDirection: 'column', gap: 6 },
  semanaCuerpoEscritorio: { flexGrow: 1, width: '100%' },
  semanaFila: { flexDirection: 'row', gap: GAP_SEMANA, minHeight: 220, width: '100%' },
  semanaFilaMovil: { width: ANCHO_SEMANA_MOVIL },
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
    borderRadius: tasksUi.radius.control,
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
  col: {
    flex: 1,
    minWidth: 0,
    backgroundColor: tasksUi.color.superficie,
    borderRadius: tasksUi.radius.contenedor,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    overflow: 'hidden',
  },
  colMovil: { width: COL_MIN, flex: 0 },
  colHoy: { borderColor: tasksUi.color.acentoSuave, backgroundColor: tasksUi.color.acentoSuave },
  colHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: tasksUi.color.bordeSutil,
  },
  colDia: { ...tasksUi.tipo.micro, fontWeight: '600', color: tasksUi.color.textoSecundario },
  colDiaHoy: { color: tasksUi.color.acentoTexto },
  badgeHoy: { ...tasksUi.tipo.micro, fontWeight: '600', color: tasksUi.color.acentoTexto },
  colCount: { marginLeft: 'auto', ...tasksUi.tipo.micro, fontWeight: '600', color: tasksUi.color.textoTerciario },
  colLista: { maxHeight: 220 },
  colListaContent: { padding: 6, gap: 6 },

  mesWrap: { gap: 8 },
  mesCabecera: { flexDirection: 'row' },
  mesDow: { flex: 1, textAlign: 'center', ...tasksUi.tipo.micro, fontWeight: '600', color: tasksUi.color.textoTerciario },
  mesMarco: {
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    borderRadius: tasksUi.radius.contenedor,
    overflow: 'hidden',
    backgroundColor: tasksUi.color.superficie,
  },
  mesFila: {
    position: 'relative',
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: tasksUi.color.bordeSutil,
  },
  mesFilaUltima: { borderBottomWidth: 0 },
  celda: {
    flex: 1,
    minHeight: 56,
    minWidth: 0,
    paddingVertical: 6,
    paddingHorizontal: 2,
    alignItems: 'center',
    gap: 3,
    borderRightWidth: 1,
    borderRightColor: tasksUi.color.bordeSutil,
    backgroundColor: tasksUi.color.superficie,
  },
  celdaUltima: { borderRightWidth: 0 },
  celdaFuera: { backgroundColor: tasksUi.color.superficieHundida },
  celdaHoy: { backgroundColor: tasksUi.color.acentoSuave },
  celdaSel: { backgroundColor: tasksUi.color.acentoSuave },
  celdaNum: { fontSize: 13, fontWeight: '600', color: tasksUi.color.textoPrimario },
  celdaNumHoy: { color: tasksUi.color.acentoTexto },
  celdaNumFuera: { color: tasksUi.color.textoTerciario },
  puntos: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 8 },
  punto: { width: 7, height: 7, borderRadius: 4 },
  masPuntos: { fontSize: 9, fontWeight: '600', color: tasksUi.color.textoSecundario },
  celdaCount: { ...tasksUi.tipo.micro, color: tasksUi.color.textoSecundario },
  diaPanel: {
    backgroundColor: tasksUi.color.superficie,
    borderRadius: tasksUi.radius.contenedor,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
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
    borderRadius: tasksUi.radius.contenedor,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    overflow: 'hidden',
    minHeight: 36,
  },
  pillFranja: { width: 3 },
  pillCuerpo: { flex: 1, minWidth: 0, paddingHorizontal: 7, paddingVertical: 5, gap: 2 },
  pillTitulo: { ...tasksUi.tipo.etiqueta, fontWeight: '600', color: tasksUi.color.textoPrimario, lineHeight: 16 },
  pillMeta: { ...tasksUi.tipo.micro, fontWeight: '500' },
});
