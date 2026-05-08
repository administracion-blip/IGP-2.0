import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

/**
 * Entrada del módulo "Planning del día": accesos a herramientas del planning.
 */
export default function PlanningDiaIndexScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Planning del día</Text>
          <Text style={styles.subtitle}>Herramientas de planificación operativa</Text>
        </View>
      </View>

      <TouchableOpacity
        style={styles.card}
        onPress={() => router.push('/planning-dia/cuadrante' as never)}
        activeOpacity={0.75}
      >
        <View style={styles.cardIconWrap}>
          <MaterialIcons name="groups" size={28} color="#0ea5e9" />
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.cardTitle}>Cuadrante de personal</Text>
          <Text style={styles.cardDesc}>
            Turnos planificados vs fichajes reales (Factorial HR), por local y fechas · costes
          </Text>
        </View>
        <MaterialIcons name="chevron-right" size={22} color="#94a3b8" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#f1f5f9' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 10 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 4 },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  cardIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flex: 1 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a', marginBottom: 4 },
  cardDesc: { fontSize: 13, color: '#64748b', lineHeight: 18 },
});
