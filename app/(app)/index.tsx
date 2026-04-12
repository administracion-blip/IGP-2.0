import { useEffect, useState, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform, Animated, ScrollView, useWindowDimensions, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import WeatherWidget from '../components/WeatherWidget';
import { useAuth } from '../contexts/AuthContext';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

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

function calcVariacionPct(actual: number, anterior: number): number | null {
  if (anterior === 0) return actual > 0 ? 100 : null;
  return Math.round(((actual - anterior) / anterior) * 1000) / 10;
}

type TotalByLocal = { local: string; total: number; workplaceId: string };
type MonthTotal = { month: number; monthLabel: string; total: number };

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
  const { width: windowWidth } = useWindowDimensions();
  const { localPermitido } = useAuth();
  const [totals, setTotals] = useState<TotalByLocal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ytdTotals, setYtdTotals] = useState<TotalByLocal[]>([]);
  const [ytdLastYearTotals, setYtdLastYearTotals] = useState<TotalByLocal[]>([]);
  const [ytdMonthly, setYtdMonthly] = useState<MonthTotal[]>([]);
  const [ytdMonthlyLastYear, setYtdMonthlyLastYear] = useState<MonthTotal[]>([]);
  const [ytdLoading, setYtdLoading] = useState(true);
  const [ytdError, setYtdError] = useState<string | null>(null);
  const yesterday = getYesterdayYYYYMMDD();
  const realCurrentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(realCurrentYear);
  const isCurrentYear = selectedYear === realCurrentYear;
  const dateTo = isCurrentYear ? yesterday : `${selectedYear}-12-31`;
  const lastYear = selectedYear - 1;

  const goYearBack = useCallback(() => setSelectedYear((y) => y - 1), []);
  const goYearForward = useCallback(() => setSelectedYear((y) => Math.min(y + 1, realCurrentYear)), [realCurrentYear]);

  // Ticker de ayer: siempre fijo al día anterior
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/api/agora/closeouts/dashboard-home?dateTo=${encodeURIComponent(yesterday)}`)
      .then((res) => res.json())
      .then((data: { error?: string; totalsTicker?: TotalByLocal[] }) => {
        if (cancelled) return;
        if (data.error) { setError(data.error); setTotals([]); return; }
        setTotals((data.totalsTicker || []).filter((t) => localPermitido(t.local)));
      })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : 'Error al cargar'); setTotals([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [yesterday, localPermitido]);

  // Widget YTD: reacciona al año seleccionado
  useEffect(() => {
    let cancelled = false;
    setYtdLoading(true);
    setYtdError(null);
    fetch(`${API_URL}/api/agora/closeouts/dashboard-home?dateTo=${encodeURIComponent(dateTo)}`)
      .then((res) => res.json())
      .then(
        (data: {
          error?: string;
          ytdCurrent?: { totals?: TotalByLocal[] };
          ytdLastYear?: { totals?: TotalByLocal[] };
          monthsCurrent?: { months?: MonthTotal[] };
          monthsLastYear?: { months?: MonthTotal[] };
        }) => {
          if (cancelled) return;
          if (data.error) {
            setYtdError(data.error);
            setYtdTotals([]); setYtdLastYearTotals([]); setYtdMonthly([]); setYtdMonthlyLastYear([]);
            return;
          }
          setYtdTotals((data.ytdCurrent?.totals || []).filter((t) => localPermitido(t.local)));
          setYtdLastYearTotals((data.ytdLastYear?.totals || []).filter((t) => localPermitido(t.local)));
          setYtdMonthly(data.monthsCurrent?.months || []);
          setYtdMonthlyLastYear(data.monthsLastYear?.months || []);
        }
      )
      .catch((err) => {
        if (!cancelled) {
          setYtdError(err instanceof Error ? err.message : 'Error al cargar');
          setYtdTotals([]); setYtdLastYearTotals([]); setYtdMonthly([]); setYtdMonthlyLastYear([]);
        }
      })
      .finally(() => { if (!cancelled) setYtdLoading(false); });
    return () => { cancelled = true; };
  }, [dateTo, localPermitido]);

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

  const lastMonthInRange = isCurrentYear ? (parseInt(yesterday.slice(5, 7), 10) || 12) : 12;
  const byMonthLastYear = new Map<number, number>();
  for (const m of ytdMonthlyLastYear) byMonthLastYear.set(m.month, m.total);
  const mesesConComparacion = ytdMonthly
    .filter((m) => m.month <= lastMonthInRange)
    .map((m) => {
      const lastTotal = byMonthLastYear.get(m.month) ?? 0;
      const pct = calcVariacionPct(m.total, lastTotal);
      return { ...m, lastYearTotal: lastTotal, variacionPct: pct };
    });

  const homeInnerStyle =
    windowWidth >= 768
      ? [styles.homeInner, { maxWidth: HOME_CONTENT_MAX_WIDTH }]
      : styles.homeInner;

  return (
    <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
      <View style={homeInnerStyle}>
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

      <View style={styles.ytdWidget}>
        <View style={styles.ytdTitleRow}>
          <TouchableOpacity onPress={goYearBack} style={styles.ytdYearBtn} activeOpacity={0.6}>
            <MaterialIcons name="chevron-left" size={20} color="#94a3b8" />
          </TouchableOpacity>
          <Text style={styles.ytdTitle}>
            Facturación {selectedYear}{isCurrentYear ? ` hasta ${formatBusinessDayToLabel(yesterday)}` : ' (año completo)'}
          </Text>
          <TouchableOpacity onPress={goYearForward} style={[styles.ytdYearBtn, isCurrentYear && styles.ytdYearBtnDisabled]} activeOpacity={isCurrentYear ? 1 : 0.6} disabled={isCurrentYear}>
            <MaterialIcons name="chevron-right" size={20} color={isCurrentYear ? '#334155' : '#94a3b8'} />
          </TouchableOpacity>
        </View>
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
            <View style={[styles.ytdGrid, windowWidth >= 1024 ? styles.ytdGrid3 : windowWidth >= 640 ? styles.ytdGrid2 : styles.ytdGrid1]}>
              {localesConComparacion.length === 0 ? (
                <Text style={styles.ytdEmpty}>Sin datos por local</Text>
              ) : (
                [...localesConComparacion].sort((a, b) => a.local.localeCompare(b.local)).map((item, idx) => (
                  <View key={item.workplaceId || idx} style={[styles.ytdCard, windowWidth >= 1024 ? styles.ytdCard3 : windowWidth >= 640 ? styles.ytdCard2 : styles.ytdCard1]}>
                    <Text style={styles.ytdCardLocal} numberOfLines={1}>{item.local}</Text>
                    <View style={styles.ytdCardRow}>
                      <Text style={styles.ytdCardTotal}>{formatMoneda(item.total)}</Text>
                      <VariacionBadge pct={item.variacionPct} />
                    </View>
                    <Text style={styles.ytdCardLastYear}>{lastYear}: {formatMoneda(item.lastYearTotal)}</Text>
                  </View>
                ))
              )}
            </View>
            {mesesConComparacion.length > 0 && (
              <>
                <Text style={styles.ytdMonthlyTitle}>Facturación por mes</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator style={styles.ytdMonthlyScroll} contentContainerStyle={styles.ytdMonthlyContent}>
                  {mesesConComparacion.map((m) => (
                    <View key={m.month} style={styles.ytdMonthCard}>
                      <Text style={styles.ytdMonthLabel}>{m.monthLabel}</Text>
                      <Text style={styles.ytdMonthTotal}>{formatMoneda(m.total)}</Text>
                      <VariacionBadge pct={m.variacionPct} />
                      <Text style={styles.ytdMonthLastYear}>
                        {m.monthLabel} {lastYear}: {formatMoneda(m.lastYearTotal)}
                      </Text>
                    </View>
                  ))}
                </ScrollView>
              </>
            )}
          </>
        )}
      </View>

      <View style={styles.welcome}>
        <Text style={styles.title}>Bienvenido</Text>
        <Text style={styles.subtitle}>
          Usa el menú lateral para acceder a Base de Datos y más opciones.
        </Text>
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
  container: {
    flex: 1,
    padding: 12,
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
  ytdWidget: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    padding: 14,
    marginBottom: 16,
    alignSelf: 'stretch',
    overflow: 'hidden',
    ...(Platform.OS === 'web' && { boxShadow: '0 2px 8px rgba(15,23,42,0.3)' } as object),
  },
  ytdTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#94a3b8',
    flex: 1,
    textAlign: 'center',
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
  ytdGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  ytdGrid1: { gap: 6 },
  ytdGrid2: { gap: 8 },
  ytdGrid3: { gap: 8 },
  ytdCard: {
    backgroundColor: 'rgba(30,41,59,0.7)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(134,239,172,0.12)',
    padding: 10,
  },
  ytdCard1: { width: '100%' },
  ytdCard2: { width: '48.5%' } as any,
  ytdCard3: { width: '32%' } as any,
  ytdCardLocal: {
    fontSize: 12,
    color: '#f8fafc',
    fontWeight: '700',
    marginBottom: 4,
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
    letterSpacing: 0.6,
  },
  ytdCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  ytdCardTotal: {
    fontSize: 14,
    fontWeight: '700',
    color: '#86efac',
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
    letterSpacing: 0.8,
  },
  ytdCardLastYear: {
    fontSize: 10,
    color: '#64748b',
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
  ytdMonthlyTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    marginTop: 14,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  ytdMonthlyScroll: {
    marginHorizontal: -14,
    maxHeight: 110,
  },
  ytdMonthlyContent: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 4,
  },
  ytdMonthCard: {
    backgroundColor: 'rgba(15,23,42,0.6)',
    borderRadius: 6,
    padding: 10,
    minWidth: 88,
    borderWidth: 1,
    borderColor: 'rgba(134,239,172,0.15)',
    alignItems: 'center',
    gap: 4,
  },
  ytdMonthLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
  },
  ytdMonthTotal: {
    fontSize: 13,
    fontWeight: '700',
    color: '#86efac',
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
  },
  ytdMonthLastYear: {
    fontSize: 9,
    color: '#64748b',
    marginTop: 2,
    textAlign: 'center',
  },
  ytdTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 4,
  },
  ytdYearBtn: {
    padding: 4,
    borderRadius: 4,
  },
  ytdYearBtnDisabled: {
    opacity: 0.3,
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
