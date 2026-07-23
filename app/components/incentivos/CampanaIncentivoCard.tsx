import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { formatFecha } from '../../utils/formatFecha';
import { formatMoneda } from '../../utils/formatMoneda';
import {
  colorEstadoCampana,
  etiquetaTipoIncentivo,
  formatValorIncentivoDisplay,
} from '../../lib/incentivosProducto';
import { campanaPendienteRevisionRrhh, estadoEfectivoCampana } from '../../lib/campanaEstado';
import type { Campana, TipoIncentivo } from '../../types/incentivosProducto';

type Props = {
  campana: Campana;
  localesMap: Record<string, string>;
  costeIncentivo?: number | null;
  cargandoResultado?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
};

export function resumenLocalesCampana(c: Campana, localesMap: Record<string, string>): string {
  const nombres = (c.locales || [])
    .map((id) => localesMap[id] || id)
    .slice(0, 2);
  const extra = (c.locales?.length || 0) - nombres.length;
  const txt = nombres.join(', ');
  return extra > 0 ? `${txt} +${extra}` : txt || '—';
}

export function CampanaIncentivoCard({
  campana,
  localesMap,
  costeIncentivo = null,
  cargandoResultado = false,
  onPress,
  style,
}: Props) {
  const estado = estadoEfectivoCampana(campana);
  const ec = colorEstadoCampana(estado);
  const pendienteRrhh = campanaPendienteRevisionRrhh(campana);

  const content = (
    <>
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <Text style={styles.cardTitle} numberOfLines={1}>{campana.nombre}</Text>
          <View style={[styles.badge, { backgroundColor: ec + '18', borderColor: ec }]}>
            <Text style={[styles.badgeText, { color: ec }]}>{estado}</Text>
          </View>
        </View>
        {onPress ? (
          <MaterialIcons name="chevron-right" size={20} color="#cbd5e1" />
        ) : null}
      </View>
      <View style={styles.cardBody}>
        <View style={styles.cardField}>
          <Text style={styles.cardFieldLabel}>Periodo</Text>
          <Text style={styles.cardFieldValue}>
            {formatFecha(campana.fechaInicio)} — {formatFecha(campana.fechaFin)}
          </Text>
        </View>
        <View style={styles.cardField}>
          <Text style={styles.cardFieldLabel}>Locales</Text>
          <Text style={styles.cardFieldValue} numberOfLines={1}>
            {resumenLocalesCampana(campana, localesMap)}
          </Text>
        </View>
        <View style={styles.cardField}>
          <Text style={styles.cardFieldLabel}>Productos</Text>
          <Text style={styles.cardFieldValue}>{campana.productos?.length || 0}</Text>
        </View>
        <View style={styles.cardField}>
          <Text style={styles.cardFieldLabel}>Incentivo</Text>
          <Text style={styles.cardFieldValue} numberOfLines={1}>
            {etiquetaTipoIncentivo(campana.tipoIncentivo as TipoIncentivo)} ·{' '}
            {formatValorIncentivoDisplay(campana.tipoIncentivo as TipoIncentivo, campana.valorIncentivo)}
          </Text>
        </View>
        <View style={styles.cardField}>
          <Text style={styles.cardFieldLabel}>Total incentivo</Text>
          {cargandoResultado ? (
            <ActivityIndicator size="small" color="#94a3b8" />
          ) : costeIncentivo != null ? (
            <Text style={[styles.cardFieldValue, styles.cardFieldIncentivo]}>
              {formatMoneda(costeIncentivo)}
            </Text>
          ) : (
            <Text style={[styles.cardFieldValue, styles.cardFieldEmpty]}>Sin datos</Text>
          )}
        </View>
      </View>
    </>
  );

  if (onPress) {
    return (
      <TouchableOpacity
        activeOpacity={0.75}
        onPress={onPress}
        style={[styles.card, pendienteRrhh && styles.cardPendienteRrhh, style]}
      >
        {content}
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.card, pendienteRrhh && styles.cardPendienteRrhh, style]}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
    flex: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  cardPendienteRrhh: {
    borderWidth: 2,
    borderColor: '#d97706',
    backgroundColor: '#fffbeb',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a', flexShrink: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1, flexShrink: 0 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: 8 },
  cardField: { minWidth: 84, marginRight: 8 },
  cardFieldLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#94a3b8',
    textTransform: 'uppercase',
    marginBottom: 1,
  },
  cardFieldValue: { fontSize: 13, color: '#334155' },
  cardFieldIncentivo: { fontWeight: '800', color: '#0f172a' },
  cardFieldEmpty: { color: '#94a3b8', fontStyle: 'italic' },
});
