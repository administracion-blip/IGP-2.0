import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { obtenerFilasObjetivos } from '../../lib/objetivosFilasApi';
import { API_BASE_URL as API_URL } from '../../utils/apiBaseUrl';
import { formatMoneda } from '../../utils/facturacion';
import { formatId6 } from '../../utils/idFormat';

type ActuacionDia = {
  id_actuacion: string;
  fecha?: string;
  hora_inicio?: string;
  artista_nombre_snapshot?: string;
  local_nombre_snapshot?: string;
  id_local?: string;
  importe_previsto?: number | null;
  importe_final?: number | null;
};

type LocalParipe = {
  id_Locales?: string;
  nombre?: string;
  Nombre?: string;
  agoraCode?: string;
  AgoraCode?: string;
};

function num(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function addDaysIso(iso: string, delta: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

function formatFechaLargaEs(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const meses = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const d = new Date(iso + 'T12:00:00');
  const dayName = dias[d.getDay()] ?? '';
  const cap = dayName ? dayName.charAt(0).toUpperCase() + dayName.slice(1) : '';
  return `${cap}, ${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

/** Minutos desde medianoche para ordenar conciertos (menor = más arriba). Sin hora válida al final. */
function minutosHoraInicio(hora: string | undefined): number {
  const s = String(hora ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 24 * 60 + 999;
  const hh = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return hh * 60 + mm;
}

/** Importe a pagar por actuación: final si existe, si no previsto. */
function importeMusicoActuacion(a: ActuacionDia): number {
  if (a.importe_final != null && !Number.isNaN(Number(a.importe_final))) return num(a.importe_final);
  return num(a.importe_previsto);
}

export default function ActuacionesIndexScreen() {
  const router = useRouter();
  const { width: winWidth } = useWindowDimensions();
  const isNarrow = winWidth < 900;

  const [diaSeleccionado, setDiaSeleccionado] = useState<string>(() => fechaJornadaNegocioIso());
  const [actuaciones, setActuaciones] = useState<ActuacionDia[]>([]);
  const [localesParipe, setLocalesParipe] = useState<LocalParipe[]>([]);
  const [previsionPorWorkplace, setPrevisionPorWorkplace] = useState<Record<string, number>>({});
  const [loadingActs, setLoadingActs] = useState(true);
  const [loadingPrev, setLoadingPrev] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diaSeleccionadoRef = useRef(diaSeleccionado);
  diaSeleccionadoRef.current = diaSeleccionado;

  const locPorIdLocal = useMemo(() => {
    const m = new Map<string, LocalParipe>();
    for (const l of localesParipe) {
      const id = formatId6(String(l.id_Locales ?? ''));
      if (id) m.set(id, l);
    }
    return m;
  }, [localesParipe]);

  const cargarLocales = useCallback(() => {
    fetch(`${API_URL}/api/locales?grupoParipe=1`)
      .then((r) => r.json())
      .then((d: { locales?: LocalParipe[] }) => setLocalesParipe(Array.isArray(d.locales) ? d.locales : []))
      .catch(() => setLocalesParipe([]));
  }, []);

  const cargarActuacionesDia = useCallback(async (fecha: string) => {
    setLoadingActs(true);
    setError(null);
    const qs = new URLSearchParams();
    qs.set('fechaDesde', fecha);
    qs.set('fechaHasta', fecha);
    try {
      const r = await fetch(`${API_URL}/api/actuaciones?${qs.toString()}`);
      const d = await r.json();
      if (d.error) setError(d.error);
      setActuaciones(Array.isArray(d.actuaciones) ? d.actuaciones : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
      setActuaciones([]);
    } finally {
      setLoadingActs(false);
    }
  }, []);

  const cargarPrevisiones = useCallback(
    async (fecha: string, acts: ActuacionDia[]) => {
      const workplaceIds = new Set<string>();
      for (const a of acts) {
        const idLoc = formatId6(String(a.id_local ?? ''));
        const loc = locPorIdLocal.get(idLoc);
        const wp = (loc?.agoraCode ?? loc?.AgoraCode ?? '').toString().trim();
        if (wp) workplaceIds.add(wp);
      }
      if (workplaceIds.size === 0) {
        setPrevisionPorWorkplace({});
        return;
      }
      setLoadingPrev(true);
      const next: Record<string, number> = {};
      try {
        await Promise.all(
          [...workplaceIds].map(async (wp) => {
            try {
              const filas = await obtenerFilasObjetivos(API_URL, wp, fecha, fecha);
              const fila = filas.find((x) => x.Fecha === fecha);
              next[wp] = fila?.TotalFacturadoComparativa ?? 0;
            } catch {
              next[wp] = 0;
            }
          }),
        );
        setPrevisionPorWorkplace(next);
      } finally {
        setLoadingPrev(false);
      }
    },
    [locPorIdLocal],
  );

  /** Al volver a esta pantalla (p. ej. desde Programación), recarga actuaciones del día actual. */
  useFocusEffect(
    useCallback(() => {
      cargarLocales();
      void cargarActuacionesDia(diaSeleccionadoRef.current);
    }, [cargarLocales, cargarActuacionesDia]),
  );

  useEffect(() => {
    void cargarActuacionesDia(diaSeleccionado);
  }, [diaSeleccionado, cargarActuacionesDia]);

  useEffect(() => {
    if (loadingActs) return;
    void cargarPrevisiones(diaSeleccionado, actuaciones);
  }, [diaSeleccionado, actuaciones, loadingActs, localesParipe, cargarPrevisiones]);

  const agrupado = useMemo(() => {
    const map = new Map<
      string,
      { idKey: string; nombreLocal: string; workplaceId: string; acts: ActuacionDia[] }
    >();
    for (const a of actuaciones) {
      const idKey = formatId6(String(a.id_local ?? ''));
      const loc = idKey ? locPorIdLocal.get(idKey) : undefined;
      const nombreLocal =
        (a.local_nombre_snapshot?.trim() ||
          loc?.nombre ||
          loc?.Nombre ||
          idKey ||
          'Local')?.toString() ?? 'Local';
      const workplaceId = (loc?.agoraCode ?? loc?.AgoraCode ?? '').toString().trim();
      if (!map.has(idKey || '_')) {
        map.set(idKey || '_', {
          idKey: idKey || '_',
          nombreLocal,
          workplaceId,
          acts: [],
        });
      }
      map.get(idKey || '_')!.acts.push(a);
    }
    const list = [...map.values()];
    list.sort((a, b) =>
      a.nombreLocal.localeCompare(b.nombreLocal, 'es', { sensitivity: 'base' }),
    );
    for (const g of list) {
      g.acts.sort(
        (x, y) => minutosHoraInicio(x.hora_inicio) - minutosHoraInicio(y.hora_inicio),
      );
    }
    return list;
  }, [actuaciones, locPorIdLocal]);

  const totalDiaMusico = useMemo(
    () => actuaciones.reduce((s, a) => s + importeMusicoActuacion(a), 0),
    [actuaciones],
  );

  const panelDia = (
    <View style={[styles.panelDerecha, isNarrow && styles.panelDerechaNarrow]}>
      <View style={styles.fechaNav}>
        <TouchableOpacity
          onPress={() => setDiaSeleccionado((d) => addDaysIso(d, -1))}
          style={styles.fechaNavBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <MaterialIcons name="chevron-left" size={26} color="#0ea5e9" />
        </TouchableOpacity>
        <View style={styles.fechaNavCenter}>
          <Text style={styles.fechaNavTitulo} numberOfLines={2}>
            {formatFechaLargaEs(diaSeleccionado)}
          </Text>
          <TouchableOpacity onPress={() => setDiaSeleccionado(fechaJornadaNegocioIso())} style={styles.hoyLink}>
            <Text style={styles.hoyLinkText}>Hoy</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={() => setDiaSeleccionado((d) => addDaysIso(d, 1))}
          style={styles.fechaNavBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <MaterialIcons name="chevron-right" size={26} color="#0ea5e9" />
        </TouchableOpacity>
      </View>

      <View style={styles.totalDiaRow}>
        <Text style={styles.totalDiaLabel}>TOTAL DEL DÍA</Text>
        <Text style={styles.totalDiaValor}>
          {loadingActs ? '…' : formatMoneda(totalDiaMusico)}
        </Text>
      </View>
      {loadingPrev && !loadingActs && agrupado.length > 0 ? (
        <Text style={styles.hintPrevision}>Actualizando previsión de facturación (Agora)…</Text>
      ) : null}

      {error ? <Text style={styles.panelError}>{error}</Text> : null}

      {loadingActs ? (
        <View style={styles.panelLoading}>
          <ActivityIndicator color="#0ea5e9" />
        </View>
      ) : (
        <ScrollView
          style={styles.listaScroll}
          contentContainerStyle={styles.listaScrollContent}
          showsVerticalScrollIndicator
          nestedScrollEnabled
        >
          {agrupado.length === 0 ? (
            <Text style={styles.listaVacia}>No hay actuaciones este día.</Text>
          ) : (
            agrupado.map((grupo) => {
              const gastoLocal = grupo.acts.reduce((s, a) => s + importeMusicoActuacion(a), 0);
              const prev = grupo.workplaceId ? previsionPorWorkplace[grupo.workplaceId] : undefined;
              const prevNum = prev ?? 0;
              const ratioPct =
                prevNum > 0 && gastoLocal >= 0 ? (gastoLocal / prevNum) * 100 : null;

              return (
                <View key={grupo.idKey} style={styles.bloqueLocal}>
                  <View style={styles.localHeaderRow}>
                    <View style={styles.localHeaderIzq}>
                      <MaterialIcons name="place" size={18} color="#0ea5e9" />
                      <Text style={styles.localNombre} numberOfLines={1}>
                        {grupo.nombreLocal.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.localPrev}>{formatMoneda(prevNum)}</Text>
                    {ratioPct != null ? (
                      <View style={styles.ratioBadge}>
                        <Text style={styles.ratioBadgeText}>{ratioPct.toFixed(1)}%</Text>
                      </View>
                    ) : (
                      <View style={styles.ratioBadgeMuted}>
                        <Text style={styles.ratioBadgeTextMuted}>—</Text>
                      </View>
                    )}
                    <Text style={styles.localGasto}>{formatMoneda(gastoLocal)}</Text>
                  </View>
                  <Text style={styles.localSubLabel}>
                    Previsión · ratio gasto/previsión · total músicos
                  </Text>

                  {grupo.acts.map((a) => {
                    const imp = importeMusicoActuacion(a);
                    const hora = a.hora_inicio?.trim() || '—';
                    const art = a.artista_nombre_snapshot?.trim() || '—';
                    const inicial = art.charAt(0).toUpperCase() || '?';
                    return (
                      <View key={a.id_actuacion} style={styles.filaAct}>
                        <Text style={styles.filaHora}>{hora}</Text>
                        <View style={styles.avatar}>
                          <Text style={styles.avatarText}>{inicial}</Text>
                        </View>
                        <View style={styles.filaTextos}>
                          <Text style={styles.filaArtista} numberOfLines={2}>
                            {art}
                          </Text>
                        </View>
                        <Text style={styles.filaImporte}>{formatMoneda(imp)}</Text>
                      </View>
                    );
                  })}
                </View>
              );
            })
          )}
        </ScrollView>
      )}
    </View>
  );

  const menuIzquierda = (
    <View style={[styles.columnaIzq, isNarrow && styles.columnaIzqNarrow]}>
      <Text style={styles.title}>Actuaciones</Text>
      <Text style={styles.subtitle}>Artistas y programación de actuaciones.</Text>

      <TouchableOpacity
        style={styles.card}
        onPress={() => router.push('/actuaciones/artistas' as any)}
        activeOpacity={0.8}
      >
        <MaterialIcons name="person" size={26} color="#0ea5e9" />
        <View style={styles.cardText}>
          <Text style={styles.cardTitle}>Artistas</Text>
          <Text style={styles.cardDesc}>Fichas, tarifas, contacto e imagen</Text>
        </View>
        <MaterialIcons name="chevron-right" size={22} color="#94a3b8" />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.card}
        onPress={() => router.push('/actuaciones/programacion' as any)}
        activeOpacity={0.8}
      >
        <MaterialIcons name="event" size={26} color="#0ea5e9" />
        <View style={styles.cardText}>
          <Text style={styles.cardTitle}>Programación</Text>
          <Text style={styles.cardDesc}>Actuaciones, firma y asociación a facturas</Text>
        </View>
        <MaterialIcons name="chevron-right" size={22} color="#94a3b8" />
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.outer}>
      <View style={[styles.mainRow, isNarrow && styles.mainRowNarrow]}>
        {menuIzquierda}
        {panelDia}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    minHeight: 0,
    padding: 12,
    backgroundColor: '#e2e8f0',
  },
  mainRow: {
    flex: 1,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'stretch',
    minHeight: 0,
    width: '100%',
  },
  mainRowNarrow: { flexDirection: 'column' },
  columnaIzq: {
    flex: 4,
    maxWidth: 420,
    minWidth: 260,
    flexShrink: 0,
  },
  columnaIzqNarrow: {
    flex: 0,
    maxWidth: '100%',
    minWidth: 0,
    width: '100%',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#334155', marginBottom: 2 },
  subtitle: { fontSize: 13, color: '#64748b', marginBottom: 12 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardText: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#334155' },
  cardDesc: { fontSize: 11, color: '#64748b', marginTop: 2 },
  panelDerecha: {
    flex: 6,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  panelDerechaNarrow: { flex: 1, minHeight: 0 },
  fechaNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    gap: 4,
  },
  fechaNavBtn: { padding: 4 },
  fechaNavCenter: { flex: 1, alignItems: 'center', minWidth: 0 },
  fechaNavTitulo: {
    fontSize: 14,
    fontWeight: '600',
    color: '#334155',
    textAlign: 'center',
  },
  hoyLink: { marginTop: 2 },
  hoyLinkText: { fontSize: 12, color: '#0ea5e9', fontWeight: '600' },
  totalDiaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  totalDiaLabel: { fontSize: 13, fontWeight: '700', color: '#64748b' },
  totalDiaValor: { fontSize: 18, fontWeight: '700', color: '#0ea5e9' },
  panelError: { color: '#b91c1c', fontSize: 12, marginBottom: 6 },
  panelLoading: { paddingVertical: 24, alignItems: 'center' },
  listaScroll: { flex: 1, minHeight: 0 },
  listaScrollContent: { paddingBottom: 12, flexGrow: 1 },
  listaVacia: {
    fontSize: 13,
    color: '#94a3b8',
    fontStyle: 'italic',
    paddingVertical: 12,
  },
  bloqueLocal: {
    marginBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    paddingBottom: 8,
  },
  localHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    marginBottom: 2,
  },
  localHeaderIzq: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flex: 1,
    minWidth: 120,
  },
  localNombre: { fontSize: 13, fontWeight: '800', color: '#0369a1', flex: 1 },
  localPrev: { fontSize: 12, fontWeight: '600', color: '#334155' },
  ratioBadge: {
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  ratioBadgeText: { fontSize: 11, fontWeight: '700', color: '#0369a1' },
  ratioBadgeMuted: {
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  ratioBadgeTextMuted: { fontSize: 11, color: '#94a3b8' },
  localGasto: { fontSize: 14, fontWeight: '700', color: '#0ea5e9', marginLeft: 'auto' },
  localSubLabel: {
    fontSize: 9,
    color: '#94a3b8',
    marginBottom: 6,
  },
  hintPrevision: {
    fontSize: 10,
    color: '#94a3b8',
    fontStyle: 'italic',
    marginBottom: 6,
    textAlign: 'center',
  },
  filaAct: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingLeft: 2,
  },
  filaHora: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0ea5e9',
    width: 42,
    flexShrink: 0,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: { fontSize: 14, fontWeight: '700', color: '#0369a1' },
  filaTextos: { flex: 1, minWidth: 0 },
  filaArtista: { fontSize: 13, fontWeight: '600', color: '#1e293b' },
  filaImporte: { fontSize: 13, fontWeight: '700', color: '#0f172a', flexShrink: 0 },
});
