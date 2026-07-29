import { View, Text, StyleSheet } from 'react-native';

/**
 * Un abono es un documento distinto de una factura: se marca en cabeceras y
 * listados para no confundirlos al revisar la contabilidad. Lleva borde y tono
 * rojo (importes en negativo) para no parecerse a los estados de `BadgeEstado`.
 */
export function BadgeAbono({ compact }: { compact?: boolean }) {
  return (
    <View style={[styles.badge, compact && styles.badgeCompact]}>
      <Text style={[styles.text, compact && styles.textCompact]}>Abono</Text>
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
    backgroundColor: '#fee2e2',
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
    color: '#b91c1c',
  },
  textCompact: {
    fontSize: 8,
    fontWeight: '700',
    lineHeight: 12,
  },
});
