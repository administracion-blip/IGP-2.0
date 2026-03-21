import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

export default function ActuacionesIndexScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Actuaciones</Text>
      <Text style={styles.subtitle}>Artistas y programación de actuaciones.</Text>

      <TouchableOpacity style={styles.card} onPress={() => router.push('/actuaciones/artistas' as any)} activeOpacity={0.8}>
        <MaterialIcons name="person" size={28} color="#0ea5e9" />
        <View style={styles.cardText}>
          <Text style={styles.cardTitle}>Artistas</Text>
          <Text style={styles.cardDesc}>Fichas, tarifas, contacto e imagen</Text>
        </View>
        <MaterialIcons name="chevron-right" size={22} color="#94a3b8" />
      </TouchableOpacity>

      <TouchableOpacity style={styles.card} onPress={() => router.push('/actuaciones/programacion' as any)} activeOpacity={0.8}>
        <MaterialIcons name="event" size={28} color="#0ea5e9" />
        <View style={styles.cardText}>
          <Text style={styles.cardTitle}>Programación</Text>
          <Text style={styles.cardDesc}>Actuaciones, firma y asociación a facturas</Text>
        </View>
        <MaterialIcons name="chevron-right" size={22} color="#94a3b8" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#e2e8f0' },
  title: { fontSize: 22, fontWeight: '700', color: '#334155', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748b', marginBottom: 20 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardText: { flex: 1 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#334155' },
  cardDesc: { fontSize: 12, color: '#64748b', marginTop: 2 },
});
