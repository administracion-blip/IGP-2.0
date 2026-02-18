import { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform, Animated } from 'react-native';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

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
  }, [contentWidth, totals.length]);

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
  const [totals, setTotals] = useState<TotalByLocal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ytdTotals, setYtdTotals] = useState<TotalByLocal[]>([]);
  const [ytdLoading, setYtdLoading] = useState(true);
  const [ytdError, setYtdError] = useState<string | null>(null);
  const yesterday = getYesterdayYYYYMMDD();
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    fetch(`${API_URL}/api/agora/closeouts/totals-by-local?businessDay=${yesterday}`)
      .then((res) => res.json())
      .then((data: { totals?: TotalByLocal[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          setTotals([]);
        } else {
          setTotals(data.totals || []);
        }
      })
      .catch((err) => {
        setError(err.message || 'Error al cargar');
        setTotals([]);
      })
      .finally(() => setLoading(false));
  }, [yesterday]);

  useEffect(() => {
    fetch(`${API_URL}/api/agora/closeouts/totals-by-local-ytd?year=${currentYear}`)
      .then((res) => res.json())
      .then((data: { totals?: TotalByLocal[]; error?: string }) => {
        if (data.error) {
          setYtdError(data.error);
          setYtdTotals([]);
        } else {
          setYtdTotals(data.totals || []);
        }
      })
      .catch((err) => {
        setYtdError(err.message || 'Error al cargar');
        setYtdTotals([]);
      })
      .finally(() => setYtdLoading(false));
  }, [currentYear]);

  return (
    <View style={styles.container}>
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

      <View style={styles.widgetsRow}>
        <View style={styles.ytdWidget}>
          <Text style={styles.ytdTitle}>Facturación {currentYear}</Text>
          {ytdLoading ? (
            <ActivityIndicator size="small" color="#86efac" style={styles.ytdLoader} />
          ) : ytdError ? (
            <Text style={styles.ytdError}>{ytdError}</Text>
          ) : ytdTotals.length === 0 ? (
            <Text style={styles.ytdEmpty}>Sin datos del año</Text>
          ) : (
            <View style={styles.ytdList}>
              {[...ytdTotals].sort((a, b) => a.local.localeCompare(b.local)).map((item, idx) => (
                <View key={item.workplaceId || idx} style={styles.ytdRow}>
                  <Text style={styles.ytdLocal}>{item.local}</Text>
                  <Text style={styles.ytdTotal}>{formatMoneda(item.total)}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </View>

      <View style={styles.welcome}>
        <Text style={styles.title}>Bienvenido</Text>
        <Text style={styles.subtitle}>
          Usa el menú lateral para acceder a Base de Datos y más opciones.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 12,
  },
  tickerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 8,
    marginBottom: 16,
    overflow: 'hidden',
    minHeight: 52,
    ...(Platform.OS === 'web' && { boxShadow: '0 2px 8px rgba(15,23,42,0.3)' } as object),
  },
  tickerLabel: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
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
    justifyContent: 'center',
    gap: 24,
    paddingRight: 24,
  },
  tickerContent: {
    flex: 1,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  tickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  tickerItemLocal: {
    fontSize: 15,
    fontWeight: '600',
    color: '#f8fafc',
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
  widgetsRow: {
    flexDirection: 'row',
    marginBottom: 16,
    alignItems: 'flex-start',
  },
  ytdWidget: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    padding: 14,
    minWidth: 280,
    maxWidth: 360,
    overflow: 'hidden',
    ...(Platform.OS === 'web' && { boxShadow: '0 2px 8px rgba(15,23,42,0.3)' } as object),
  },
  ytdTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#94a3b8',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
  },
  ytdLoader: { marginVertical: 12 },
  ytdList: { gap: 6 },
  ytdRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  ytdLocal: {
    fontSize: 14,
    color: '#f8fafc',
    fontWeight: '600',
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
    letterSpacing: 0.8,
  },
  ytdTotal: {
    fontSize: 14,
    fontWeight: '700',
    color: '#86efac',
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
    letterSpacing: 0.8,
  },
  ytdError: {
    fontSize: 12,
    color: '#fca5a5',
  },
  ytdEmpty: {
    fontSize: 12,
    color: '#94a3b8',
    fontStyle: 'italic',
  },
  welcome: {
    flex: 1,
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
