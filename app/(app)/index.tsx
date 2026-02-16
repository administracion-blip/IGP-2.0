import { View, Text, StyleSheet } from 'react-native';

export default function AppHome() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Bienvenido</Text>
      <Text style={styles.subtitle}>
        Usa el menú lateral para acceder a Base de Datos y más opciones.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    lineHeight: 20,
  },
});
