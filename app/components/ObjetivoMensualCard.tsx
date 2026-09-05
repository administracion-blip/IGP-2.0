import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useHubNavGrid } from '../hooks/useHubNavGrid';
import { MIN_TOUCH } from '../constants/layout';
import { tasksUi } from '../constants/tasksUiTokens';
import { apiFetch } from '../utils/api';
import { formatMoneda } from '../utils/formatMoneda';
import {
  accentForPct,
  colorConsecucion,
  formatPctConsecucion,
  labelPeriodoMensual,
} from '../lib/objetivoConsecucionCardUi';

export type ObjetivoMensualLocal = {
  localId: string;
  nombre: string;
  pctConsecucion: number | null;
  sinDatos: boolean;
  objetivoHoy?: number | null;
  desvioAcumulado?: number;
  extraPorDia?: number;
};

export type ObjetivoMensualCardData = {
  mes: string;
  hastaFecha: string;
  jornadaHoy?: string;
  diasRestantes?: number;
  locales: ObjetivoMensualLocal[];
};

type Props = {
  localIndex: number;
  onLocalIndexChange: (idx: number) => void;
  width?: `${number}%` | '100%';
  style?: StyleProp<ViewStyle>;
  onLocalesLoaded?: (locales: ObjetivoMensualLocal[]) => void;
};

export function ObjetivoMensualCard({
  localIndex,
  onLocalIndexChange,
  width = '100%',
  style,
  onLocalesLoaded,
}: Props) {
  const { compact } = useHubNavGrid();
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

  useEffect(() => {
    if (data?.locales?.length) {
      onLocalesLoaded?.(data.locales);
    }
  }, [data, onLocalesLoaded]);

  if (loading) {
    return (
      <View style={[styles.card, compact && styles.cardCompact, { width }, style]}>
        <View style={[styles.iconWrap, compact && styles.iconWrapCompact, { backgroundColor: tasksUi.color.acentoSuave }]}>
          <ActivityIndicator size="small" color={tasksUi.color.acento} />
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

  const objetivoHoy = loc.objetivoHoy ?? null;
  const extraPorDia = loc.extraPorDia ?? 0;
  const diasRestantes = data.diasRestantes ?? 0;
  const alDia = extraPorDia <= 0;
  const mostrarLineaInfo = objetivoHoy != null || diasRestantes > 0;

  return (
    <View style={[styles.card, compact && styles.cardCompact, { width }, style]}>
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
          {labelPeriodoMensual(data.mes)}
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
            accessibilityLabel={tienePct ? `Consecución ${formatPctConsecucion(pct)}` : 'Sin datos de consecución'}
          >
            {tienePct ? formatPctConsecucion(pct) : 'Sin datos'}
          </Text>
        </View>

        {mostrarLineaInfo ? (
          <View style={styles.infoRow}>
            {objetivoHoy != null ? (
              <Text style={styles.infoObjetivo} numberOfLines={1}>
                Objetivo hoy{' '}
                <Text style={styles.infoObjetivoValor}>{formatMoneda(objetivoHoy)}</Text>
              </Text>
            ) : null}

            {!alDia ? (
              <View style={styles.chipDesvio}>
                <Text style={styles.chipDesvioText}>+{formatMoneda(extraPorDia)}/día</Text>
              </View>
            ) : tienePct ? (
              <View style={styles.chipAlDia}>
                <MaterialIcons name="check" size={12} color="#059669" />
                <Text style={styles.chipAlDiaText}>Al día</Text>
              </View>
            ) : null}

            {diasRestantes > 0 ? (
              <Text style={styles.infoDias} numberOfLines={1}>
                {diasRestantes} {diasRestantes === 1 ? 'día rest.' : 'días rest.'}
              </Text>
            ) : null}
          </View>
        ) : null}
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
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
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
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: tasksUi.radius.contenedor,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tasksUi.color.superficieHundida,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
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
    justifyContent: 'center',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    ...tasksUi.tipo.tituloSeccion,
    flex: 1,
    minWidth: 0,
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
  posBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: tasksUi.radius.pildora,
    backgroundColor: tasksUi.color.superficieHundida,
    flexShrink: 0,
  },
  posBadgeText: {
    ...tasksUi.tipo.micro,
    fontWeight: '600',
    color: tasksUi.color.textoSecundario,
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
    height: 5,
    backgroundColor: tasksUi.color.superficieHundida,
    borderRadius: tasksUi.radius.pildora,
    overflow: 'hidden',
    position: 'relative',
  },
  mark100: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    marginLeft: -0.5,
    backgroundColor: tasksUi.color.textoTerciario,
    zIndex: 2,
  },
  fill: {
    height: '100%',
    borderRadius: tasksUi.radius.pildora,
  },
  pctText: {
    fontSize: 16,
    fontWeight: '600',
    color: tasksUi.color.textoSecundario,
    minWidth: 64,
    textAlign: 'right',
    flexShrink: 0,
    ...tasksUi.tabularNums,
  },
  pctTextCompact: {
    fontSize: 14,
    minWidth: 56,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  infoObjetivo: {
    ...tasksUi.tipo.etiqueta,
    color: tasksUi.color.textoSecundario,
    flexShrink: 1,
  },
  infoObjetivoValor: {
    fontWeight: '600',
    color: tasksUi.color.textoPrimario,
  },
  chipDesvio: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: tasksUi.radius.pildora,
    backgroundColor: tasksUi.color.peligroSuave,
    flexShrink: 0,
  },
  chipDesvioText: {
    ...tasksUi.tipo.micro,
    fontWeight: '600',
    color: tasksUi.color.peligro,
  },
  chipAlDia: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: tasksUi.radius.pildora,
    backgroundColor: tasksUi.color.exitoSuave,
    flexShrink: 0,
  },
  chipAlDiaText: {
    ...tasksUi.tipo.micro,
    fontWeight: '600',
    color: tasksUi.color.exito,
  },
  infoDias: {
    ...tasksUi.tipo.etiqueta,
    flexShrink: 0,
  },
});
