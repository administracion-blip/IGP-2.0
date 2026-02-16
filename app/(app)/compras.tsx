import { View, Text, StyleSheet } from 'react-native';

export default function ComprasScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Compras</Text>
      <Text style={styles.subtitle}>
        Gestión de compras y proveedores.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748b', lineHeight: 20 },
});
