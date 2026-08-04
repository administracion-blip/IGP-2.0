import { View, Text, StyleSheet } from 'react-native';

/**
 * Indicador secundario (info/azul) de factura IN incluida en remesa activa.
 * No sustituye a `BadgeEstado` (estado de pago/documento).
 */
export function BadgeEnRemesa({ compact }: { compact?: boolean }) {
  return (
    <View style={[styles.badge, compact && styles.badgeCompact]}>
      <Text style={[styles.text, compact && styles.textCompact]}>En remesa</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bfdbfe',
    backgroundColor: '#dbeafe',
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
    color: '#1d4ed8',
  },
  textCompact: {
    fontSize: 8,
    fontWeight: '700',
    lineHeight: 12,
  },
});
