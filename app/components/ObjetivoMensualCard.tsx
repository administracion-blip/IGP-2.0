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
import { useBreakpoint } from '../hooks/useBreakpoint';
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

function formatPct(pct: number): string {
  const s = Number.isInteger(pct) ? String(pct) : pct.toFixed(1).replace('.', ',');
  return `${s} %`;
}

type Props = {
  localIndex: number;
  onLocalIndexChange: (idx: number) => void;
};

export function ObjetivoMensualCard({ localIndex, onLocalIndexChange }: Props) {
  const { isPhone, shouldStackToolbar } = useBreakpoint();
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
      <View style={[styles.card, styles.cardLoading]}>
        <ActivityIndicator size="small" color="#0ea5e9" />
        <Text style={styles.loadingText}>Objetivo mensual…</Text>
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

  const prev = () => onLocalIndexChange(idx <= 0 ? locales.length - 1 : idx - 1);
  const next = () => onLocalIndexChange(idx >= locales.length - 1 ? 0 : idx + 1);

  return (
    <View style={[styles.card, isPhone && styles.cardPhone]}>
      {multi ? (
        <TouchableOpacity
          style={styles.navBtn}
          onPress={prev}
          accessibilityLabel="Local anterior"
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <MaterialIcons name="chevron-left" size={28} color="#64748b" />
        </TouchableOpacity>
      ) : null}

      <View style={styles.body}>
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.localNombre} numberOfLines={1}>{loc.nombre}</Text>
            <Text style={styles.periodo}>{labelPeriodo(data.mes)}</Text>
          </View>
          {multi ? (
            <Text style={styles.posicion}>{idx + 1}/{locales.length}</Text>
          ) : null}
        </View>

        <View style={[styles.progressRow, shouldStackToolbar && styles.progressRowStack]}>
          <View style={styles.trackWrap}>
            <View style={styles.track}>
              <View style={[styles.mark100, { left: `${(100 / 120) * 100}%` }]} />
              <View style={[styles.fill, { width: `${barWidth}%`, backgroundColor: barColor }]} />
            </View>
          </View>
          <Text
            style={[styles.pctText, tienePct && { color: barColor }]}
            accessibilityLabel={tienePct ? `Consecución ${formatPct(pct)}` : 'Sin datos de consecución'}
          >
            {tienePct ? formatPct(pct) : 'Sin datos'}
          </Text>
        </View>
      </View>

      {multi ? (
        <TouchableOpacity
          style={styles.navBtn}
          onPress={next}
          accessibilityLabel="Local siguiente"
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <MaterialIcons name="chevron-right" size={28} color="#64748b" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 12,
    paddingHorizontal: 8,
    marginBottom: 12,
    minHeight: 88,
    maxHeight: 110,
    gap: 4,
  },
  cardLoading: {
    justifyContent: 'center',
  },
  cardPhone: {
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  loadingText: {
    fontSize: 12,
    color: '#64748b',
    marginLeft: 8,
  },
  navBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  localNombre: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
  },
  periodo: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  posicion: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94a3b8',
    paddingTop: 2,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  progressRowStack: {
    flexWrap: 'wrap',
  },
  trackWrap: {
    flex: 1,
    minWidth: 80,
  },
  track: {
    height: 10,
    backgroundColor: '#f1f5f9',
    borderRadius: 5,
    overflow: 'hidden',
    position: 'relative',
  },
  mark100: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    marginLeft: -1,
    backgroundColor: '#64748b',
    zIndex: 2,
  },
  fill: {
    height: '100%',
    borderRadius: 5,
  },
  pctText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#64748b',
    minWidth: 72,
    textAlign: 'right',
  },
});
