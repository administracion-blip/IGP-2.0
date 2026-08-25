import { View, Text, StyleSheet } from 'react-native';
import { formatExcesoBadge } from '../utils/facturacion';

/**
 * Badge de aviso sobre estado `pagada`/`cobrada` cuando queda exceso pendiente.
 * No introduce estado `pagada_exceso`: solo señal visual.
 */
export function BadgeExceso({
  importe,
  compact,
}: {
  importe: number;
  compact?: boolean;
}) {
  if (!(Number(importe) > 0.001)) return null;
  return (
    <View style={[styles.badge, compact && styles.badgeCompact]}>
      <Text style={[styles.text, compact && styles.textCompact]}>
        {formatExcesoBadge(importe)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
    alignSelf: 'flex-start',
  },
  badgeCompact: {
    paddingHorizontal: 5,
    paddingVertical: 0,
    borderRadius: 4,
  },
  text: {
    fontSize: 11,
    fontWeight: '700',
    color: '#dc2626',
  },
  textCompact: {
    fontSize: 8,
    fontWeight: '700',
    lineHeight: 12,
    color: '#dc2626',
  },
});
