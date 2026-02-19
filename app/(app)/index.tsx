import { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform, Animated, ScrollView } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

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

function getLastYearSameDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function formatBusinessDayToLabel(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function calcVariacionPct(actual: number, anterior: number): number | null {
  if (anterior === 0) return actual > 0 ? 100 : null;
  return Math.round(((actual - anterior) / anterior) * 1000) / 10;
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

function VariacionBadge({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const sube = pct > 0;
  const color = sube ? '#22c55e' : '#f87171';
  const icon = sube ? 'trending-up' : 'trending-down';
  const sign = pct > 0 ? '+' : '';
  return (
    <View style={[styles.variacionBadge, { backgroundColor: sube ? 'rgba(34,197,94,0.2)' : 'rgba(248,113,113,0.2)' }]}>
      <MaterialIcons name={icon} size={14} color={color} style={styles.variacionIcon} />
      <Text style={[styles.variacionText, { color }]}>{sign}{pct}%</Text>
    </View>
  );
}

export default function AppHome() {
  const [totals, setTotals] = useState<TotalByLocal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ytdTotals, setYtdTotals] = useState<TotalByLocal[]>([]);
  const [ytdLastYearTotals, setYtdLastYearTotals] = useState<TotalByLocal[]>([]);
  const [ytdLoading, setYtdLoading] = useState(true);
  const [ytdError, setYtdError] = useState<string | null>(null);
  const yesterday = getYesterdayYYYYMMDD();
  const lastYearSameDate = getLastYearSameDate(yesterday);
  const currentYear = new Date().getFullYear();
  const lastYear = currentYear - 1;

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
    const dateTo = yesterday;
    const dateToLastYear = lastYearSameDate;
    Promise.all([
      fetch(`${API_URL}/api/agora/closeouts/totals-by-local-ytd?year=${currentYear}&dateTo=${dateTo}`).then((r) => r.json()),
      fetch(`${API_URL}/api/agora/closeouts/totals-by-local-ytd?year=${lastYear}&dateTo=${dateToLastYear}`).then((r) => r.json()),
    ])
      .then(([dataCur, dataLast]) => {
        if (dataCur.error) {
          setYtdError(dataCur.error);
          setYtdTotals([]);
          setYtdLastYearTotals([]);
        } else {
          setYtdTotals(dataCur.totals || []);
          setYtdLastYearTotals(dataLast.totals || []);
        }
      })
      .catch((err) => {
        setYtdError(err.message || 'Error al cargar');
        setYtdTotals([]);
        setYtdLastYearTotals([]);
      })
      .finally(() => setYtdLoading(false));
  }, [currentYear, yesterday, lastYearSameDate]);

  const ytdTotalGeneral = ytdTotals.reduce((s, t) => s + t.total, 0);
  const ytdLastYearTotalGeneral = ytdLastYearTotals.reduce((s, t) => s + t.total, 0);
  const variacionGeneral = calcVariacionPct(ytdTotalGeneral, ytdLastYearTotalGeneral);

  const byWorkplaceId = new Map<string, TotalByLocal>();
  for (const t of ytdLastYearTotals) byWorkplaceId.set(t.workplaceId, t);
  const localesConComparacion = ytdTotals.map((t) => {
    const last = byWorkplaceId.get(t.workplaceId);
    const lastTotal = last?.total ?? 0;
    const pct = calcVariacionPct(t.total, lastTotal);
    return { ...t, lastYearTotal: lastTotal, variacionPct: pct };
  });

  return (
    <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
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
          <Text style={styles.ytdTitle}>Facturación {currentYear} hasta {formatBusinessDayToLabel(yesterday)}</Text>
          {ytdLoading ? (
            <ActivityIndicator size="small" color="#86efac" style={styles.ytdLoader} />
          ) : ytdError ? (
            <Text style={styles.ytdError}>{ytdError}</Text>
          ) : (
            <>
              <View style={styles.ytdGeneralRow}>
                <Text style={styles.ytdGeneralLabel}>Total</Text>
                <View style={styles.ytdGeneralRight}>
                  <Text style={styles.ytdGeneralTotal}>{formatMoneda(ytdTotalGeneral)}</Text>
                  <VariacionBadge pct={variacionGeneral} />
                </View>
              </View>
              <Text style={styles.ytdComparacionLabel}>vs. mismo periodo {lastYear}</Text>
              <View style={styles.ytdList}>
                {localesConComparacion.length === 0 ? (
                  <Text style={styles.ytdEmpty}>Sin datos por local</Text>
                ) : (
                [...localesConComparacion].sort((a, b) => a.local.localeCompare(b.local)).map((item, idx) => (
                  <View key={item.workplaceId || idx} style={styles.ytdRow}>
                    <View style={styles.ytdLocalWrap}>
                      <Text style={styles.ytdLocal}>{item.local}</Text>
                    </View>
                    <View style={styles.ytdRowRight}>
                      <Text style={styles.ytdTotal}>{formatMoneda(item.total)}</Text>
                      <VariacionBadge pct={item.variacionPct} />
                    </View>
                  </View>
                ))
                )}
              </View>
            </>
          )}
        </View>
      </View>

      <View style={styles.welcome}>
        <Text style={styles.title}>Bienvenido</Text>
        <Text style={styles.subtitle}>
          Usa el menú lateral para acceder a Base de Datos y más opciones.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 32 },
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
  variacionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 8,
  },
  variacionIcon: { marginRight: 2 },
  variacionText: { fontSize: 12, fontWeight: '700' },
  widgetsRow: {
    flexDirection: 'row',
    marginBottom: 16,
    alignItems: 'flex-start',
    alignSelf: 'stretch',
  },
  ytdWidget: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    padding: 14,
    minWidth: 280,
    alignSelf: 'stretch',
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
  ytdGeneralRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 0,
    marginBottom: 4,
    borderBottomWidth: 2,
    borderBottomColor: 'rgba(134,239,172,0.3)',
  },
  ytdGeneralLabel: { fontSize: 14, fontWeight: '600', color: '#94a3b8' },
  ytdGeneralRight: { flexDirection: 'row', alignItems: 'center' },
  ytdGeneralTotal: {
    fontSize: 18,
    fontWeight: '700',
    color: '#86efac',
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
  },
  ytdComparacionLabel: {
    fontSize: 11,
    color: '#64748b',
    marginBottom: 8,
    fontStyle: 'italic',
  },
  ytdList: { gap: 6 },
  ytdRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 0,
    gap: 40,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  ytdRowRight: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  ytdLocalWrap: { flexShrink: 0 },
  ytdLocal: {
    fontSize: 14,
    color: '#f8fafc',
    fontWeight: '600',
    marginRight: 32,
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
    paddingVertical: 24,
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
