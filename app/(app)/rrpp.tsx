import { View, Text, StyleSheet } from 'react-native';

export default function RrppScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>RRPP</Text>
      <Text style={styles.subtitle}>
        Relaciones públicas y promoción.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748b', lineHeight: 20 },
});
