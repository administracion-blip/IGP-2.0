/**
 * Pantalla mínima para la ruta /facturacion/pagos-cobros (menú superior).
 * El detalle por factura se gestiona con modales en facturas-venta / facturas-gasto.
 */
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  shadow,
  typography,
  SPACING,
} from '../../constants/theme';

export default function PagosCobrosScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/facturacion' as never)} style={styles.backBtn} accessibilityLabel="Volver">
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Pagos y cobros</Text>
      </View>
      <View style={styles.card}>
        <MaterialIcons name="account-balance-wallet" size={40} color={colors.textMuted} style={styles.icon} />
        <Text style={styles.lead}>
          Consulta los movimientos desde el cuadro de mando o revisa el detalle por factura en las listas de facturas emitidas y recibidas.
        </Text>
        <Text style={styles.muted}>
          El listado global de movimientos puede ampliarse aquí en el futuro. El detalle de cobros y pagos por factura está disponible con el icono junto a la columna «Pagado».
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: SPACING.lg, backgroundColor: colors.bg },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.lg },
  backBtn: { padding: SPACING.xs },
  title: { ...typography.titulo },
  card: {
    ...shadow.card,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20, // sin token: entre SPACING.lg (16) y SPACING.xl (24)
  },
  icon: { alignSelf: 'center', marginBottom: SPACING.md },
  lead: { ...typography.cuerpo, lineHeight: 22, marginBottom: 10 }, // 10 y 22 sin token
  muted: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[12],
    color: colors.textMuted,
    lineHeight: 18,
    fontStyle: 'italic',
  },
});
