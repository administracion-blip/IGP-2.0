import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Easing,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useHubNavGrid } from '../hooks/useHubNavGrid';
import { MIN_TOUCH } from '../constants/layout';
import { tasksUi } from '../constants/tasksUiTokens';
import { rangoMesHastaAyerJornada } from '../lib/jornadaNegocio';
import {
  fetchTopCamarerosPlanning,
  getTopCamarerosPlanningCached,
  type TopCamarerosPlanningRow,
} from '../lib/topCamarerosPlanningCache';
import { apiFetch } from '../utils/api';

type LocalItem = {
  id_Locales?: string;
  nombre?: string;
  Nombre?: string;
};

type Props = {
  localId?: string | null;
  filtrarPorLocal?: boolean;
  localIndex?: number;
  width?: `${number}%` | '100%';
  style?: StyleProp<ViewStyle>;
};

const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function labelRangoFechas(dateFrom: string, dateTo: string): string {
  const [, mFrom, dFrom] = dateFrom.split('-').map(Number);
  const [, mTo, dTo] = dateTo.split('-').map(Number);
  const mes = MESES_CORTO[(mTo || 1) - 1] ?? '';
  if (dateFrom === dateTo) return `${dTo} ${mes}`;
  if (mFrom === mTo) return `${dFrom}–${dTo} ${mes}`;
  const mesFrom = MESES_CORTO[(mFrom || 1) - 1] ?? '';
  return `${dFrom} ${mesFrom} – ${dTo} ${mes}`;
}

const MEDAL_COLORS = {
  1: '#eab308',
  2: '#94a3b8',
  3: '#b45309',
} as const;

function GoldMedalIcon({ size }: { size: number }) {
  const shine = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(shine, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(shine, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [shine]);

  const opacity = shine.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1] });
  const scale = shine.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  return (
    <Animated.View style={{ opacity, transform: [{ scale }] }}>
      <MaterialIcons name="emoji-events" size={size} color={MEDAL_COLORS[1]} />
    </Animated.View>
  );
}

function RankMedal({ rank, compact }: { rank: number; compact: boolean }) {
  const size = compact ? 14 : 16;
  if (rank === 1) return <GoldMedalIcon size={size} />;
  if (rank === 2 || rank === 3) {
    return <MaterialIcons name="emoji-events" size={size} color={MEDAL_COLORS[rank]} />;
  }
  return null;
}

export function TopCamarerosPlanningCard({
  localId,
  filtrarPorLocal = false,
  localIndex = 0,
  width = '100%',
  style,
}: Props) {
  const { hasPermiso, localPermitido } = useAuth();
  const { compact } = useHubNavGrid();
  const puedeVer = hasPermiso('top.ver');

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [filas, setFilas] = useState<TopCamarerosPlanningRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sinDatosRango, setSinDatosRango] = useState(false);
  const [subtitulo, setSubtitulo] = useState('');

  const rango = useMemo(() => rangoMesHastaAyerJornada(), []);

  const localesPermitidos = useMemo(() => {
    return locales
      .filter((l) => {
        const nombre = String(l.nombre ?? l.Nombre ?? '').trim();
        return nombre ? localPermitido(nombre) : true;
      })
      .sort((a, b) => {
        const na = String(a.nombre ?? a.Nombre ?? '').trim();
        const nb = String(b.nombre ?? b.Nombre ?? '').trim();
        return na.localeCompare(nb, 'es', { sensitivity: 'base' });
      });
  }, [locales, localPermitido]);

  const localActivoId = useMemo(() => {
    if (filtrarPorLocal && localId) {
      return String(localId).trim();
    }
    if (localesPermitidos.length === 0) return null;
    const idx = Math.min(Math.max(0, localIndex), localesPermitidos.length - 1);
    return String(localesPermitidos[idx]?.id_Locales ?? '').trim() || null;
  }, [filtrarPorLocal, localId, localIndex, localesPermitidos]);

  const nombreLocal = useMemo(() => {
    if (!localActivoId) return null;
    const loc = localesPermitidos.find((l) => String(l.id_Locales ?? '').trim() === localActivoId);
    if (!loc) return null;
    return String(loc.nombre ?? loc.Nombre ?? '').trim() || null;
  }, [localActivoId, localesPermitidos]);

  const cargarLocales = useCallback(async () => {
    try {
      const res = await apiFetch('/api/locales');
      const data = await res.json();
      setLocales(Array.isArray(data.locales) ? data.locales : []);
    } catch {
      setLocales([]);
    }
  }, []);

  const aplicarDatos = useCallback((data: NonNullable<Awaited<ReturnType<typeof fetchTopCamarerosPlanning>>>) => {
    if (!data) {
      setFilas([]);
      return;
    }
    setSinDatosRango(Boolean(data.sinDatos));
    setSubtitulo(
      data.sinDatos
        ? 'Sin datos hasta ayer'
        : labelRangoFechas(data.dateFrom, data.dateTo),
    );
    setFilas((data.camareros || []).slice(0, 3));
  }, []);

  const cargarTop = useCallback(async () => {
    if (!puedeVer) {
      setLoading(false);
      setFilas([]);
      return;
    }
    if (rango.sinDatos) {
      setSinDatosRango(true);
      setFilas([]);
      setSubtitulo('Sin datos hasta ayer');
      setLoading(false);
      return;
    }
    if (filtrarPorLocal && !localId) {
      setLoading(true);
      setFilas([]);
      setSubtitulo('Cargando local…');
      return;
    }
    if (!localActivoId) {
      setLoading(false);
      setFilas([]);
      setSubtitulo('Local no disponible');
      return;
    }

    const cached = getTopCamarerosPlanningCached(localActivoId);
    if (cached) {
      aplicarDatos(cached);
      setLoading(false);
      void fetchTopCamarerosPlanning(localActivoId, { force: true }).then((fresh) => {
        if (fresh) aplicarDatos(fresh);
      });
      return;
    }

    setLoading(true);
    setSinDatosRango(false);
    setSubtitulo(labelRangoFechas(rango.dateFrom, rango.dateTo));

    const data = await fetchTopCamarerosPlanning(localActivoId);
    aplicarDatos(data);
    setLoading(false);
  }, [puedeVer, rango, filtrarPorLocal, localId, localActivoId, aplicarDatos]);

  useFocusEffect(
    useCallback(() => {
      void cargarLocales();
    }, [cargarLocales]),
  );

  useFocusEffect(
    useCallback(() => {
      void cargarTop();
    }, [cargarTop]),
  );

  useEffect(() => {
    void cargarTop();
  }, [cargarTop, localId, localIndex, localActivoId]);

  if (!puedeVer) return null;

  const titulo = nombreLocal ? `Top camareros · ${nombreLocal}` : 'Top camareros';

  return (
    <View style={[styles.card, compact && styles.cardCompact, { width }, style]}>
      <View style={[styles.iconWrap, compact && styles.iconWrapCompact]}>
        {loading ? (
          <ActivityIndicator size="small" color={tasksUi.color.acento} />
        ) : (
          <MaterialIcons name="emoji-events" size={compact ? 22 : 26} color={tasksUi.color.acento} />
        )}
      </View>

      <View style={styles.body}>
        <Text style={[styles.title, compact && styles.titleCompact]} numberOfLines={1}>
          {titulo}
        </Text>
        <Text style={[styles.desc, compact && styles.descCompact]} numberOfLines={1}>
          {subtitulo || labelRangoFechas(rango.dateFrom, rango.dateTo)}
        </Text>

        {loading ? (
          <Text style={[styles.hint, compact && styles.hintCompact]}>Cargando ranking…</Text>
        ) : sinDatosRango ? (
          <Text style={[styles.hint, compact && styles.hintCompact]}>Sin datos hasta ayer</Text>
        ) : filas.length === 0 ? (
          <Text style={[styles.hint, compact && styles.hintCompact]}>Sin ventas en el periodo</Text>
        ) : (
          <View style={styles.list}>
            {filas.map((f) => (
              <View key={`${f.rank}-${f.userName}`} style={styles.row}>
                <View style={[styles.rankCell, compact && styles.rankCellCompact]}>
                  <RankMedal rank={f.rank} compact={compact} />
                </View>
                <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={1}>
                  {f.userName}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 14,
    backgroundColor: tasksUi.color.superficie,
    borderRadius: tasksUi.radius.contenedor,
    padding: 16,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    minHeight: MIN_TOUCH + 24,
    alignSelf: 'stretch',
  },
  cardCompact: {
    gap: 10,
    padding: 12,
    borderRadius: tasksUi.radius.contenedor,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: tasksUi.color.acentoSuave,
  },
  iconWrapCompact: {
    width: 40,
    height: 40,
    borderRadius: 10,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 4,
    justifyContent: 'center',
  },
  title: {
    ...tasksUi.tipo.tituloSeccion,
  },
  titleCompact: {
    fontSize: 14,
  },
  desc: {
    ...tasksUi.tipo.etiqueta,
  },
  descCompact: {
    fontSize: 11,
    lineHeight: 14,
  },
  hint: {
    ...tasksUi.tipo.etiqueta,
    marginTop: 4,
  },
  hintCompact: {
    fontSize: 11,
  },
  list: {
    marginTop: 2,
    gap: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 20,
  },
  rankCell: {
    width: 22,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  rankCellCompact: {
    width: 20,
  },
  name: {
    flex: 1,
    ...tasksUi.tipo.etiqueta,
    color: tasksUi.color.textoSecundario,
    minWidth: 0,
  },
  nameCompact: {
    fontSize: 11,
  },
});
