import { View, Text, StyleSheet } from 'react-native';

export default function CashflowScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Cashflow</Text>
      <Text style={styles.subtitle}>
        Flujo de caja y tesorería.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748b', lineHeight: 20 },
});
