import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Platform,
  ScrollView,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch } from '../utils/api';

type TotalByLocal = { local: string; total: number; workplaceId: string };
type MonthTotal = { month: number; monthLabel: string; total: number };

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

function VariacionBadge({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const sube = pct > 0;
  const color = sube ? '#16a34a' : '#dc2626';
  const icon = sube ? 'trending-up' : 'trending-down';
  const sign = pct > 0 ? '+' : '';
  return (
    <View style={[styles.variacionBadge, { backgroundColor: sube ? '#dcfce7' : '#fef2f2' }]}>
      <MaterialIcons name={icon} size={14} color={color} style={styles.variacionIcon} />
      <Text style={[styles.variacionText, { color }]}>{sign}{pct}%</Text>
    </View>
  );
}

/** Facturación YTD por local con variación vs mismo periodo del año anterior. */
export function FacturacionYtdWidget() {
  const { width: windowWidth } = useWindowDimensions();
  const { localPermitido } = useAuth();
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
  const goYearForward = useCallback(
    () => setSelectedYear((y) => Math.min(y + 1, realCurrentYear)),
    [realCurrentYear],
  );

  useEffect(() => {
    let cancelled = false;
    setYtdLoading(true);
    setYtdError(null);
    apiFetch(`/api/agora/closeouts/dashboard-home?dateTo=${encodeURIComponent(dateTo)}`)
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
            setYtdTotals([]);
            setYtdLastYearTotals([]);
            setYtdMonthly([]);
            setYtdMonthlyLastYear([]);
            return;
          }
          setYtdTotals((data.ytdCurrent?.totals || []).filter((t) => localPermitido(t.local)));
          setYtdLastYearTotals((data.ytdLastYear?.totals || []).filter((t) => localPermitido(t.local)));
          setYtdMonthly(data.monthsCurrent?.months || []);
          setYtdMonthlyLastYear(data.monthsLastYear?.months || []);
        },
      )
      .catch((err) => {
        if (!cancelled) {
          setYtdError(err instanceof Error ? err.message : 'Error al cargar');
          setYtdTotals([]);
          setYtdLastYearTotals([]);
          setYtdMonthly([]);
          setYtdMonthlyLastYear([]);
        }
      })
      .finally(() => {
        if (!cancelled) setYtdLoading(false);
      });
    return () => {
      cancelled = true;
    };
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

  const lastMonthInRange = isCurrentYear ? parseInt(yesterday.slice(5, 7), 10) || 12 : 12;
  const byMonthLastYear = new Map<number, number>();
  for (const m of ytdMonthlyLastYear) byMonthLastYear.set(m.month, m.total);
  const mesesConComparacion = ytdMonthly
    .filter((m) => m.month <= lastMonthInRange)
    .map((m) => {
      const lastTotal = byMonthLastYear.get(m.month) ?? 0;
      const pct = calcVariacionPct(m.total, lastTotal);
      return { ...m, lastYearTotal: lastTotal, variacionPct: pct };
    });

  return (
    <View style={styles.ytdWidget}>
      <View style={styles.ytdTitleRow}>
        <TouchableOpacity onPress={goYearBack} style={styles.ytdYearBtn} activeOpacity={0.6}>
          <MaterialIcons name="chevron-left" size={20} color="#64748b" />
        </TouchableOpacity>
        <Text style={styles.ytdTitle}>
          Facturación {selectedYear}
          {isCurrentYear ? ` hasta ${formatBusinessDayToLabel(yesterday)}` : ' (año completo)'}
        </Text>
        <TouchableOpacity
          onPress={goYearForward}
          style={[styles.ytdYearBtn, isCurrentYear && styles.ytdYearBtnDisabled]}
          activeOpacity={isCurrentYear ? 1 : 0.6}
          disabled={isCurrentYear}
        >
          <MaterialIcons name="chevron-right" size={20} color={isCurrentYear ? '#cbd5e1' : '#64748b'} />
        </TouchableOpacity>
      </View>
      {ytdLoading ? (
        <ActivityIndicator size="small" color="#0ea5e9" style={styles.ytdLoader} />
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
          <View
            style={[
              styles.ytdGrid,
              windowWidth >= 1024 ? styles.ytdGrid3 : windowWidth >= 640 ? styles.ytdGrid2 : styles.ytdGrid1,
            ]}
          >
            {localesConComparacion.length === 0 ? (
              <Text style={styles.ytdEmpty}>Sin datos por local</Text>
            ) : (
              [...localesConComparacion]
                .sort((a, b) => a.local.localeCompare(b.local))
                .map((item, idx) => (
                  <View
                    key={item.workplaceId || idx}
                    style={[
                      styles.ytdCard,
                      windowWidth >= 1024
                        ? styles.ytdCard3
                        : windowWidth >= 640
                          ? styles.ytdCard2
                          : styles.ytdCard1,
                    ]}
                  >
                    <Text style={styles.ytdCardLocal} numberOfLines={1}>
                      {item.local}
                    </Text>
                    <View style={styles.ytdCardRow}>
                      <Text style={styles.ytdCardTotal}>{formatMoneda(item.total)}</Text>
                      <VariacionBadge pct={item.variacionPct} />
                    </View>
                    <Text style={styles.ytdCardLastYear}>
                      {lastYear}: {formatMoneda(item.lastYearTotal)}
                    </Text>
                  </View>
                ))
            )}
          </View>
          {mesesConComparacion.length > 0 ? (
            <>
              <Text style={styles.ytdMonthlyTitle}>Facturación por mes</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator
                style={styles.ytdMonthlyScroll}
                contentContainerStyle={styles.ytdMonthlyContent}
              >
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
          ) : null}
        </>
      )}
    </View>
  );
}

const mono = Platform.OS === 'web'
  ? ({ fontFamily: '"Courier New", Courier, monospace' } as object)
  : { fontFamily: 'monospace' };

const styles = StyleSheet.create({
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
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    marginBottom: 16,
    alignSelf: 'stretch',
    overflow: 'hidden',
    ...(Platform.OS === 'web' && { boxShadow: '0 1px 4px rgba(15,23,42,0.06)' } as object),
  },
  ytdTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    flex: 1,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    ...mono,
  },
  ytdLoader: { marginVertical: 12 },
  ytdGeneralRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    marginBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  ytdGeneralLabel: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  ytdGeneralRight: { flexDirection: 'row', alignItems: 'center' },
  ytdGeneralTotal: {
    fontSize: 18,
    fontWeight: '700',
    color: '#334155',
    ...mono,
  },
  ytdComparacionLabel: {
    fontSize: 11,
    color: '#94a3b8',
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
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
  },
  ytdCard1: { width: '100%' },
  ytdCard2: { width: '48.5%' } as object,
  ytdCard3: { width: '32%' } as object,
  ytdCardLocal: {
    fontSize: 12,
    color: '#334155',
    fontWeight: '700',
    marginBottom: 4,
    ...mono,
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
    color: '#0f172a',
    ...mono,
    letterSpacing: 0.8,
  },
  ytdCardLastYear: {
    fontSize: 10,
    color: '#94a3b8',
  },
  ytdError: {
    fontSize: 12,
    color: '#dc2626',
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
    backgroundColor: '#f8fafc',
    borderRadius: 6,
    padding: 10,
    minWidth: 88,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    gap: 4,
  },
  ytdMonthLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
  },
  ytdMonthTotal: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    ...mono,
  },
  ytdMonthLastYear: {
    fontSize: 9,
    color: '#94a3b8',
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
});
