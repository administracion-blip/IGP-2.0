import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

export default function CoverManagerScreen() {
  const router = useRouter();
  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Cover Manager</Text>
      </View>
      <View style={styles.emptyBox}>
        <MaterialIcons name="schedule" size={48} color="#cbd5e1" />
        <Text style={styles.emptyText}>
          La integración con Cover Manager estará disponible próximamente.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 10 },
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
  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  emptyText: { fontSize: 14, color: '#64748b', textAlign: 'center', maxWidth: 360 },
});
