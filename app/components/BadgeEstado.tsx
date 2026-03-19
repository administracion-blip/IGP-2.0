import { View, Text, StyleSheet } from 'react-native';
import { labelEstado, colorEstado } from '../utils/facturacion';

export function BadgeEstado({ estado }: { estado: string }) {
  const { bg, text } = colorEstado(estado);
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.text, { color: text }]}>{labelEstado(estado)}</Text>
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
  text: {
    fontSize: 11,
    fontWeight: '600',
  },
});
