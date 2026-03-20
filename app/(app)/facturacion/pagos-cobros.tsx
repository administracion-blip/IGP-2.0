/**
 * Pantalla mínima para la ruta /facturacion/pagos-cobros (menú superior).
 * El detalle por factura se gestiona con modales en facturas-venta / facturas-gasto.
 */
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

export default function PagosCobrosScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/facturacion' as never)} style={styles.backBtn} accessibilityLabel="Volver">
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Pagos y cobros</Text>
      </View>
      <View style={styles.card}>
        <MaterialIcons name="account-balance-wallet" size={40} color="#94a3b8" style={styles.icon} />
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
  container: { flex: 1, padding: 16, backgroundColor: '#f8fafc' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  backBtn: { padding: 4 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 20,
  },
  icon: { alignSelf: 'center', marginBottom: 12 },
  lead: { fontSize: 14, color: '#475569', lineHeight: 22, marginBottom: 10 },
  muted: { fontSize: 12, color: '#94a3b8', lineHeight: 18, fontStyle: 'italic' },
});
