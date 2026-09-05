import { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Platform,
  Animated,
  ScrollView,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import WeatherWidget from '../components/WeatherWidget';
import { CalendarioInicio } from '../components/CalendarioInicio';
import { tasksUi } from '../constants/tasksUiTokens';
import { SPACING } from '../constants/layout';
import { useAuth } from '../contexts/AuthContext';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { apiFetch } from '../utils/api';
import { fechaLocalIso } from '../lib/jornadaNegocio';

const DIAS_SEMANA_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] as const;
const MESES_CORTO_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;

/** Ancho máximo del contenido en tablet nativa. En web los widgets usan todo el ancho. */
const HOME_CONTENT_MAX_WIDTH = 1120;

function formatMoneda(value: string | number): string {
  if (value === '' || value === '—' || value == null) return '—';
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.').replace(/\s/g, ''));
  if (Number.isNaN(n) || n === 0) return '—';
  const parts = n.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

function getYesterdayYYYYMMDD(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return fechaLocalIso(d);
}

function weekdayEsFromIso(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return DIAS_SEMANA_ES[d.getDay()] ?? '';
}

function formatBusinessDayToLabel(iso: string): string {
  const [, m, d] = iso.split('-');
  const weekday = weekdayEsFromIso(iso);
  const mes = MESES_CORTO_ES[Number(m) - 1] ?? m;
  const dia = String(Number(d));
  return weekday ? `${weekday} ${dia} ${mes}` : `${dia} ${mes}`;
}

type TotalByLocal = { local: string; total: number; workplaceId: string; totalAnterior?: number };
type ComparativaTicker = 'subida' | 'bajada' | 'igual' | null;

function comparativaTicker(total: number, totalAnterior?: number): ComparativaTicker {
  if (totalAnterior == null || typeof totalAnterior !== 'number' || !Number.isFinite(totalAnterior)) {
    return null;
  }
  const delta = total - totalAnterior;
  if (Math.abs(delta) < 0.005) return 'igual';
  return delta > 0 ? 'subida' : 'bajada';
}

function pctComparativa(total: number, totalAnterior: number): number | null {
  if (Math.abs(totalAnterior) < 0.005) return null;
  return ((total - totalAnterior) / totalAnterior) * 100;
}

function TickerItemComparativa({
  total,
  totalAnterior,
}: {
  total: number;
  totalAnterior?: number;
}) {
  const tipo = comparativaTicker(total, totalAnterior);
  if (!tipo || totalAnterior == null) return null;
  const cfg =
    tipo === 'subida'
      ? { bg: tasksUi.color.exitoSuave, fg: tasksUi.color.exito }
      : tipo === 'bajada'
        ? { bg: tasksUi.color.peligroSuave, fg: tasksUi.color.peligro }
        : { bg: tasksUi.color.superficieHundida, fg: tasksUi.color.textoSecundario };
  const pct = tipo === 'igual' ? null : pctComparativa(total, totalAnterior);
  const textoPct = pct != null ? `${Math.round(Math.abs(pct))} %` : null;

  return (
    <View style={[styles.tickerBadge, { backgroundColor: cfg.bg }]}>
      {tipo === 'igual' ? (
        <Text style={[styles.tickerBadgeText, { color: cfg.fg }]}>igual</Text>
      ) : (
        <>
          <MaterialIcons
            name={tipo === 'subida' ? 'arrow-upward' : 'arrow-downward'}
            size={13}
            color={cfg.fg}
          />
          {textoPct ? (
            <Text style={[styles.tickerBadgeText, { color: cfg.fg }]}>{textoPct}</Text>
          ) : null}
        </>
      )}
    </View>
  );
}

function TickerFacturacion({
  totals,
  formatMoneda,
  isCompact,
}: {
  totals: TotalByLocal[];
  formatMoneda: (v: number) => string;
  isCompact: boolean;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const [trackWidth, setTrackWidth] = useState(0);
  const [clipWidth, setClipWidth] = useState(0);
  const [segmentWidth, setSegmentWidth] = useState(0);

  // Siempre loop (también si caben). isCompact se mantiene en el contrato del ticker.
  const usarMarquee = true;
  const anchoLoop = segmentWidth > 0 ? segmentWidth : trackWidth;

  useEffect(() => {
    if (!usarMarquee || anchoLoop <= 0 || totals.length === 0) {
      translateX.setValue(0);
      return;
    }
    translateX.setValue(0);
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, {
          toValue: -anchoLoop,
          duration: 20000,
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [usarMarquee, anchoLoop, totals.length, translateX]);

  const renderItems = (offset: string, fijo?: boolean) =>
    totals.map((item, idx) => (
      <View
        key={`${item.workplaceId}-${offset}-${idx}`}
        style={[styles.tickerItem, fijo && styles.tickerItemFijo]}
      >
        <Text style={styles.tickerItemLocal}>{item.local}</Text>
        <Text style={styles.tickerItemImporte}>{formatMoneda(item.total)}</Text>
        <TickerItemComparativa total={item.total} totalAnterior={item.totalAnterior} />
      </View>
    ));

  return (
    <View style={styles.tickerMarqueeWrap}>
      <View
        style={styles.tickerMarqueeClip}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          if (w > 0) setClipWidth(w);
        }}
      >
        <View
          pointerEvents="none"
          style={styles.tickerMedidor}
          onLayout={(e) => {
            const w = e.nativeEvent.layout.width;
            if (w > 0) setTrackWidth(w);
          }}
        >
          {renderItems('m', true)}
        </View>
        {usarMarquee ? (
          <Animated.View style={[styles.tickerMarqueeContent, { transform: [{ translateX }] }]}>
            <View
              style={styles.tickerMarqueeSegment}
              onLayout={(e) => {
                const w = e.nativeEvent.layout.width;
                if (w > 0) setSegmentWidth(w);
              }}
            >
              {renderItems('0')}
            </View>
            <View style={styles.tickerMarqueeSegment}>{renderItems('1')}</View>
          </Animated.View>
        ) : (
          <View style={styles.tickerFilaFija}>{renderItems('f', true)}</View>
        )}
      </View>
    </View>
  );
}

export default function AppHome() {
  const { isPhone, isCompact } = useBreakpoint();
  const { localPermitido } = useAuth();
  const [totals, setTotals] = useState<TotalByLocal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const yesterday = getYesterdayYYYYMMDD();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch(`/api/agora/closeouts/dashboard-home?dateTo=${encodeURIComponent(yesterday)}`)
      .then((res) => res.json())
      .then((data: { error?: string; totalsTicker?: TotalByLocal[] }) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
          setTotals([]);
          return;
        }
        setTotals((data.totalsTicker || []).filter((t) => localPermitido(t.local)));
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Error al cargar');
          setTotals([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [yesterday, localPermitido]);

  const homeInnerStyle =
    !isPhone && Platform.OS !== 'web'
      ? [styles.homeInner, { maxWidth: HOME_CONTENT_MAX_WIDTH }]
      : styles.homeInner;

  return (
    <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
      <View style={homeInnerStyle}>
        <WeatherWidget />

        <View style={styles.tickerShell}>
          <View style={styles.tickerBar}>
            <View style={[styles.tickerLabel, isPhone && styles.tickerLabelPhone]}>
              {isPhone ? (
                <>
                  <Text style={styles.tickerLabelText}>Facturación</Text>
                  <Text style={styles.tickerLabelFecha}>{formatBusinessDayToLabel(yesterday)}</Text>
                </>
              ) : (
                <Text style={styles.tickerLabelText}>Facturación · {formatBusinessDayToLabel(yesterday)}</Text>
              )}
            </View>
            {loading ? (
              <View style={styles.tickerContent}>
                <ActivityIndicator size="small" color="#0ea5e9" />
              </View>
            ) : error ? (
              <View style={styles.tickerContent}>
                <Text style={styles.tickerError}>{error}</Text>
              </View>
            ) : totals.length === 0 ? (
              <View style={styles.tickerContent}>
                <Text style={styles.tickerEmpty}>Sin datos del día anterior</Text>
              </View>
            ) : (
              <TickerFacturacion totals={totals} formatMoneda={formatMoneda} isCompact={isCompact} />
            )}
          </View>
        </View>

        <CalendarioInicio />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: { flex: 1, backgroundColor: tasksUi.color.fondoApp },
  scrollContent: {
    padding: SPACING.xl,
    paddingBottom: tasksUi.space[6],
    alignItems: 'center',
    flexGrow: 1,
    backgroundColor: tasksUi.color.fondoApp,
  },
  homeInner: {
    width: '100%',
    alignSelf: 'center',
    gap: SPACING.xl,
  },
  tickerShell: {
    width: '100%',
    borderRadius: tasksUi.radius.contenedor,
  },
  tickerBar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    backgroundColor: tasksUi.color.superficie,
    borderRadius: tasksUi.radius.contenedor,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    minHeight: 52,
    overflow: 'hidden',
  },
  tickerLabel: {
    flexShrink: 0,
    maxWidth: '42%',
    paddingHorizontal: tasksUi.space[3],
    paddingVertical: tasksUi.space[3],
    borderRightWidth: 1,
    borderRightColor: tasksUi.color.bordeSutil,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  tickerLabelPhone: {
    maxWidth: 118,
  },
  tickerLabelText: {
    ...tasksUi.tipo.tituloSeccion,
  },
  tickerLabelFecha: {
    ...tasksUi.tipo.etiqueta,
    marginTop: 2,
  },
  tickerMarqueeWrap: {
    flex: 1,
    flexDirection: 'row',
    alignSelf: 'stretch',
  },
  tickerMarqueeClip: {
    flex: 1,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'flex-start',
    position: 'relative',
  },
  tickerMedidor: {
    position: 'absolute',
    left: 0,
    top: 0,
    opacity: 0,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexWrap: 'nowrap',
  },
  tickerMarqueeContent: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    justifyContent: 'flex-start',
  },
  tickerMarqueeSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    flexWrap: 'nowrap',
    paddingRight: tasksUi.space[2],
  },
  tickerFilaFija: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    flexWrap: 'nowrap',
    paddingHorizontal: tasksUi.space[3],
  },
  tickerContent: {
    flex: 1,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  tickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    marginRight: SPACING.xl,
  },
  tickerItemFijo: {
    marginRight: 0,
  },
  tickerItemLocal: {
    ...tasksUi.tipo.etiqueta,
    marginRight: 10,
    flexShrink: 0,
  },
  tickerItemImporte: {
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 24,
    color: tasksUi.color.textoPrimario,
    marginRight: 10,
    flexShrink: 0,
    ...tasksUi.tabularNums,
  },
  tickerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    flexShrink: 0,
    marginRight: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: tasksUi.radius.pildora,
  },
  tickerBadgeText: {
    ...tasksUi.tipo.etiqueta,
    fontWeight: '600',
    color: tasksUi.color.textoSecundario,
    ...tasksUi.tabularNums,
  },
  tickerError: {
    ...tasksUi.tipo.cuerpo,
    color: tasksUi.color.peligro,
  },
  tickerEmpty: {
    ...tasksUi.tipo.cuerpo,
    color: tasksUi.color.textoTerciario,
  },
});
