import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

export default function ArqueoCajaScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Arqueo de Caja</Text>
      </View>

      <View style={styles.placeholder}>
        <MaterialIcons name="account-balance-wallet" size={48} color="#cbd5e1" />
        <Text style={styles.placeholderText}>Arqueo de Caja</Text>
        <Text style={styles.placeholderSub}>Contenido en desarrollo</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  placeholderText: { fontSize: 16, fontWeight: '600', color: '#64748b' },
  placeholderSub: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
});
