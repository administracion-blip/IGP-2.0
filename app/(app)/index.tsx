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
import WeatherWidget from '../components/WeatherWidget';
import { CalendarioInicio } from '../components/CalendarioInicio';
import { useAuth } from '../contexts/AuthContext';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { apiFetch } from '../utils/api';

/** Ancho máximo del contenido en tablet / web ancha (márgenes laterales automáticos). */
const HOME_CONTENT_MAX_WIDTH = 1120;

const CARD_SHADOW =
  Platform.OS === 'web'
    ? ({ boxShadow: '0 8px 24px rgba(15,23,42,0.06)' } as object)
    : {
        shadowColor: '#0f172a',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.06,
        shadowRadius: 24,
        elevation: 2,
      };

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
  return d.toISOString().slice(0, 10);
}

function formatBusinessDayToLabel(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

type TotalByLocal = { local: string; total: number; workplaceId: string };

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

  const medido = trackWidth > 0 && clipWidth > 0;
  const cabeEnFila = !isCompact && medido && trackWidth + 24 <= clipWidth;
  const usarMarquee = isCompact || (medido && !cabeEnFila);
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
        <Text style={styles.tickerItemTotal}>{formatMoneda(item.total)}</Text>
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

  const homeInnerStyle = !isPhone
    ? [styles.homeInner, { maxWidth: HOME_CONTENT_MAX_WIDTH }]
    : styles.homeInner;

  return (
    <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
      <View style={homeInnerStyle}>
        <WeatherWidget />

        <View style={styles.tickerShell}>
          <View style={styles.tickerBar}>
            <View style={styles.tickerLabel}>
              <Text style={styles.tickerLabelText}>Facturación {formatBusinessDayToLabel(yesterday)}</Text>
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
  scrollView: { flex: 1, backgroundColor: '#f8fafc' },
  scrollContent: {
    padding: 12,
    paddingBottom: 32,
    alignItems: 'center',
    flexGrow: 1,
    backgroundColor: '#f8fafc',
  },
  homeInner: {
    width: '100%',
    alignSelf: 'center',
  },
  tickerShell: {
    width: '100%',
    marginBottom: 16,
    borderRadius: 16,
    ...CARD_SHADOW,
  },
  tickerBar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    minHeight: 52,
    overflow: 'hidden',
  },
  tickerLabel: {
    flexShrink: 0,
    maxWidth: '42%',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  tickerLabelText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    ...(Platform.OS === 'web'
      ? ({ fontFamily: '"Courier New", Courier, monospace' } as object)
      : { fontFamily: 'monospace' }),
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
    paddingRight: 8,
  },
  tickerFilaFija: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    flexWrap: 'nowrap',
    paddingHorizontal: 12,
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
    marginRight: 24,
  },
  tickerItemFijo: {
    marginRight: 0,
  },
  tickerItemLocal: {
    fontSize: 15,
    fontWeight: '600',
    color: '#334155',
    marginRight: 10,
    flexShrink: 0,
    ...(Platform.OS === 'web'
      ? ({ fontFamily: '"Courier New", Courier, monospace' } as object)
      : { fontFamily: 'monospace' }),
    letterSpacing: 0.8,
  },
  tickerItemTotal: {
    fontSize: 15,
    fontWeight: '800',
    color: '#16a34a',
    letterSpacing: 0.3,
  },
  tickerError: {
    fontSize: 14,
    color: '#ef4444',
  },
  tickerEmpty: {
    fontSize: 14,
    color: '#94a3b8',
    fontStyle: 'italic',
  },
});
