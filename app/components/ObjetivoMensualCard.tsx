import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useHubNavGrid } from '../hooks/useHubNavGrid';
import { MIN_TOUCH } from '../constants/layout';
import { apiFetch } from '../utils/api';

export type ObjetivoMensualLocal = {
  localId: string;
  nombre: string;
  pctConsecucion: number | null;
  sinDatos: boolean;
};

export type ObjetivoMensualCardData = {
  mes: string;
  hastaFecha: string;
  locales: ObjetivoMensualLocal[];
};

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function labelPeriodo(mes: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  if (!m) return mes;
  const y = Number(m[1]);
  const mi = Number(m[2]);
  const nombreMes = MESES[mi - 1] ?? m[2];
  return `${nombreMes} ${y} · hasta ayer`;
}

function colorConsecucion(pct: number): string {
  if (pct < 95) return '#dc2626';
  if (pct < 100) return '#d97706';
  return '#059669';
}

function accentForPct(pct: number | null, sinDatos: boolean): { bg: string; fg: string } {
  if (pct == null || sinDatos) return { bg: '#f1f5f9', fg: '#94a3b8' };
  if (pct < 95) return { bg: '#fee2e2', fg: '#dc2626' };
  if (pct < 100) return { bg: '#ffedd5', fg: '#d97706' };
  return { bg: '#dcfce7', fg: '#059669' };
}

function formatPct(pct: number): string {
  const s = Number.isInteger(pct) ? String(pct) : pct.toFixed(1).replace('.', ',');
  return `${s} %`;
}

type Props = {
  localIndex: number;
  onLocalIndexChange: (idx: number) => void;
};

export function ObjetivoMensualCard({ localIndex, onLocalIndexChange }: Props) {
  const { compact, rowSpanWidth } = useHubNavGrid();
  const [data, setData] = useState<ObjetivoMensualCardData | null>(null);
  const [loading, setLoading] = useState(true);

  const cargar = useCallback(() => {
    setLoading(true);
    apiFetch('/api/agora/closeouts/objetivo-mensual-card')
      .then(async (r) => {
        if (r.status === 403 || !r.ok) {
          setData(null);
          return;
        }
        const d = await r.json();
        if (d.error) {
          setData(null);
          return;
        }
        setData(d as ObjetivoMensualCardData);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  useFocusEffect(
    useCallback(() => {
      cargar();
    }, [cargar]),
  );

  useEffect(() => {
    if (!data?.locales?.length) return;
    if (localIndex >= data.locales.length) {
      onLocalIndexChange(0);
    }
  }, [data, localIndex, onLocalIndexChange]);

  if (loading) {
    return (
      <View style={[styles.card, compact && styles.cardCompact, { width: rowSpanWidth }]}>
        <View style={[styles.iconWrap, compact && styles.iconWrapCompact, { backgroundColor: '#e0f2fe' }]}>
          <ActivityIndicator size="small" color="#0ea5e9" />
        </View>
        <View style={styles.body}>
          <Text style={[styles.title, compact && styles.titleCompact]}>Objetivo mensual</Text>
          <Text style={[styles.desc, compact && styles.descCompact]}>Cargando consecución…</Text>
        </View>
      </View>
    );
  }

  if (!data?.locales?.length) return null;

  const locales = data.locales;
  const idx = Math.min(Math.max(0, localIndex), locales.length - 1);
  const loc = locales[idx];
  const multi = locales.length > 1;
  const pct = loc.pctConsecucion;
  const tienePct = pct != null && !loc.sinDatos;
  const barPct = tienePct ? Math.min(pct, 120) : 0;
  const barWidth = (barPct / 120) * 100;
  const barColor = tienePct ? colorConsecucion(pct) : '#cbd5e1';
  const accent = accentForPct(pct, loc.sinDatos);

  const prev = () => onLocalIndexChange(idx <= 0 ? locales.length - 1 : idx - 1);
  const next = () => onLocalIndexChange(idx >= locales.length - 1 ? 0 : idx + 1);

  return (
    <View style={[styles.card, compact && styles.cardCompact, { width: rowSpanWidth }]}>
      {multi ? (
        <TouchableOpacity
          style={[styles.navBtn, compact && styles.navBtnCompact]}
          onPress={prev}
          accessibilityLabel="Local anterior"
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <MaterialIcons name="chevron-left" size={compact ? 22 : 24} color="#64748b" />
        </TouchableOpacity>
      ) : null}

      <View style={[styles.iconWrap, compact && styles.iconWrapCompact, { backgroundColor: accent.bg }]}>
        <MaterialIcons name="flag" size={compact ? 22 : 26} color={accent.fg} />
      </View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, compact && styles.titleCompact]} numberOfLines={1}>
            {loc.nombre}
          </Text>
          {multi ? (
            <View style={styles.posBadge}>
              <Text style={styles.posBadgeText}>
                {idx + 1}/{locales.length}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.desc, compact && styles.descCompact]} numberOfLines={1}>
          {labelPeriodo(data.mes)}
        </Text>

        <View style={styles.progressRow}>
          <View style={styles.trackWrap}>
            <View style={styles.track}>
              <View style={[styles.mark100, { left: `${(100 / 120) * 100}%` }]} />
              <View style={[styles.fill, { width: `${barWidth}%`, backgroundColor: barColor }]} />
            </View>
          </View>
          <Text
            style={[styles.pctText, compact && styles.pctTextCompact, tienePct && { color: barColor }]}
            accessibilityLabel={tienePct ? `Consecución ${formatPct(pct)}` : 'Sin datos de consecución'}
          >
            {tienePct ? formatPct(pct) : 'Sin datos'}
          </Text>
        </View>
      </View>

      {multi ? (
        <TouchableOpacity
          style={[styles.navBtn, compact && styles.navBtnCompact]}
          onPress={next}
          accessibilityLabel="Local siguiente"
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <MaterialIcons name="chevron-right" size={compact ? 22 : 24} color="#64748b" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    minHeight: MIN_TOUCH + 24,
    alignSelf: 'flex-start',
  },
  cardCompact: {
    gap: 10,
    padding: 12,
    borderRadius: 10,
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flexShrink: 0,
  },
  navBtnCompact: {
    width: 28,
    height: 28,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconWrapCompact: {
    width: 40,
    height: 40,
    borderRadius: 10,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    flex: 1,
    minWidth: 0,
  },
  titleCompact: {
    fontSize: 14,
  },
  desc: {
    fontSize: 12,
    color: '#64748b',
    lineHeight: 16,
  },
  descCompact: {
    fontSize: 11,
    lineHeight: 14,
  },
  posBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flexShrink: 0,
  },
  posBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 2,
  },
  trackWrap: {
    flex: 1,
    minWidth: 60,
  },
  track: {
    height: 8,
    backgroundColor: '#f1f5f9',
    borderRadius: 4,
    overflow: 'hidden',
    position: 'relative',
  },
  mark100: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    marginLeft: -1,
    backgroundColor: '#94a3b8',
    zIndex: 2,
  },
  fill: {
    height: '100%',
    borderRadius: 4,
  },
  pctText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#64748b',
    minWidth: 64,
    textAlign: 'right',
    flexShrink: 0,
  },
  pctTextCompact: {
    fontSize: 14,
    minWidth: 56,
  },
});
