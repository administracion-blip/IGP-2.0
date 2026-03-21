import { View, Text, StyleSheet } from 'react-native';
import { labelEstado, colorEstado } from '../utils/facturacion';

export function BadgeEstado({ estado, compact }: { estado: string; compact?: boolean }) {
  const { bg, text } = colorEstado(estado);
  return (
    <View style={[styles.badge, compact && styles.badgeCompact, { backgroundColor: bg }]}>
      <Text style={[styles.text, compact && styles.textCompact, { color: text }]}>{labelEstado(estado)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  badgeCompact: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  text: {
    fontSize: 11,
    fontWeight: '600',
  },
  textCompact: {
    fontSize: 9,
    fontWeight: '600',
    lineHeight: 13,
  },
});
