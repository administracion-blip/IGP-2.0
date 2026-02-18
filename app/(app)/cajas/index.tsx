import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

const OPCIONES = [
  {
    id: 'cierres-teoricos',
    label: 'Cierres de ventas teóricas',
    icon: 'receipt-long' as const,
    descripcion: 'Cierres teóricos de ventas',
  },
  {
    id: 'arqueo-caja',
    label: 'Arqueo de Caja',
    icon: 'account-balance-wallet' as const,
    descripcion: 'Arqueo y conteo de caja',
  },
];

export default function CajasIndexScreen() {
  const router = useRouter();

  function handleSeleccionar(id: string) {
    if (id === 'cierres-teoricos') router.push('/cajas/cierres-teoricos');
    if (id === 'arqueo-caja') router.push('/cajas/arqueo-caja');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Cajas</Text>
      <Text style={styles.subtitle}>Selecciona una opción</Text>

      <View style={styles.grid}>
        {OPCIONES.map((opcion) => (
          <TouchableOpacity
            key={opcion.id}
            style={styles.card}
            onPress={() => handleSeleccionar(opcion.id)}
            activeOpacity={0.7}
          >
            <View style={styles.cardLeft}>
              <MaterialIcons name={opcion.icon} size={24} color="#0ea5e9" />
              <Text style={styles.cardLabel}>{opcion.label}</Text>
            </View>
            <Text style={styles.cardDescripcion} numberOfLines={2}>
              {opcion.descripcion}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 10,
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
    marginBottom: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  card: {
    width: '47%',
    minWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 10,
  },
  cardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  cardLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: '#334155',
  },
  cardDescripcion: {
    flex: 1,
    fontSize: 12,
    fontWeight: '400',
    fontStyle: 'italic',
    color: '#94a3b8',
    marginLeft: 8,
    textAlign: 'right',
  },
});
