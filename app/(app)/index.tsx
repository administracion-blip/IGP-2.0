import { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform, Animated, ScrollView, useWindowDimensions } from 'react-native';
import WeatherWidget from '../components/WeatherWidget';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch } from '../utils/api';

/** Ancho máximo del contenido en tablet / web ancha (márgenes laterales automáticos). */
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
  return d.toISOString().slice(0, 10);
}

function formatBusinessDayToLabel(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

type TotalByLocal = { local: string; total: number; workplaceId: string };

function TickerMarquee({ totals, formatMoneda }: { totals: TotalByLocal[]; formatMoneda: (v: number) => string }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    if (contentWidth <= 0 || totals.length === 0) return;
    translateX.setValue(0);
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, {
          toValue: -contentWidth,
          duration: 20000,
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [contentWidth, totals.length, translateX]);

  const renderItems = (offset: number) =>
    totals.map((item, idx) => (
      <View key={`${item.workplaceId}-${offset}-${idx}`} style={styles.tickerItem}>
        <Text style={styles.tickerItemLocal}>{item.local}</Text>
        <Text style={styles.tickerItemTotal}>{formatMoneda(item.total)}</Text>
      </View>
    ));

  return (
    <View style={styles.tickerMarqueeWrap}>
      <View style={styles.tickerMarqueeClip}>
        <Animated.View style={[styles.tickerMarqueeContent, { transform: [{ translateX }] }]}>
          <View style={styles.tickerMarqueeSegment} onLayout={(e) => setContentWidth(e.nativeEvent.layout.width)}>
            {renderItems(0)}
          </View>
          <View style={styles.tickerMarqueeSegment}>
            {renderItems(1)}
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

export default function AppHome() {
  const { width: windowWidth } = useWindowDimensions();
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
    windowWidth >= 768
      ? [styles.homeInner, { maxWidth: HOME_CONTENT_MAX_WIDTH }]
      : styles.homeInner;

  return (
    <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
      <View style={homeInnerStyle}>
        <View style={styles.welcome}>
          <Text style={styles.title}>Bienvenido</Text>
          <Text style={styles.subtitle}>
            Usa el menú lateral para acceder a Base de Datos y más opciones.
          </Text>
        </View>

        <WeatherWidget />

        <View style={styles.tickerBar}>
          <View style={styles.tickerLabel}>
            <Text style={styles.tickerLabelText}>Facturación {formatBusinessDayToLabel(yesterday)}</Text>
          </View>
          {loading ? (
            <View style={styles.tickerContent}>
              <ActivityIndicator size="small" color="#86efac" />
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
            <TickerMarquee totals={totals} formatMoneda={formatMoneda} />
          )}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: { flex: 1 },
  scrollContent: {
    padding: 12,
    paddingBottom: 32,
    alignItems: 'center',
    flexGrow: 1,
  },
  homeInner: {
    width: '100%',
    alignSelf: 'center',
  },
  tickerBar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    backgroundColor: '#0f172a',
    borderRadius: 8,
    marginBottom: 16,
    overflow: 'hidden',
    minHeight: 52,
    ...(Platform.OS === 'web' && { boxShadow: '0 2px 8px rgba(15,23,42,0.3)' } as object),
  },
  tickerLabel: {
    flexShrink: 0,
    maxWidth: '42%',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  tickerLabelText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
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
  },
  tickerMarqueeContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  tickerMarqueeSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    flexWrap: 'nowrap',
    paddingRight: 8,
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
  tickerItemLocal: {
    fontSize: 15,
    fontWeight: '600',
    color: '#f8fafc',
    marginRight: 10,
    flexShrink: 0,
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
    letterSpacing: 0.8,
  },
  tickerItemTotal: {
    fontSize: 15,
    fontWeight: '700',
    color: '#86efac',
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
    letterSpacing: 0.8,
  },
  tickerError: {
    fontSize: 14,
    color: '#fca5a5',
  },
  tickerEmpty: {
    fontSize: 14,
    color: '#94a3b8',
    fontStyle: 'italic',
  },
  welcome: {
    paddingBottom: 12,
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    lineHeight: 20,
  },
});
