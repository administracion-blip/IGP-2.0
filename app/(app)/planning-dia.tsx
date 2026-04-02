import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

type AccionRapida = {
  id: string;
  label: string;
  descripcion: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  ruta: string;
};

const ACCIONES: AccionRapida[] = [
  {
    id: 'nuevo-pedido',
    label: 'Nuevo Pedido',
    descripcion: 'Crear un pedido de compra a proveedor',
    icon: 'add-shopping-cart',
    ruta: '/compras/pedidos?crear=1',
  },
  {
    id: 'reportar-incidencia',
    label: 'Reportar Incidencia',
    descripcion: 'Abrir un parte de mantenimiento',
    icon: 'report-problem',
    ruta: '/mantenimiento/reportar',
  },
];

export default function PlanningDiaScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Planning del Día</Text>
          <Text style={styles.subtitle}>Acciones rápidas del día a día</Text>
        </View>
      </View>

      <View style={styles.grid}>
        {ACCIONES.map((accion) => (
          <TouchableOpacity
            key={accion.id}
            style={styles.card}
            activeOpacity={0.7}
            onPress={() => router.push(accion.ruta as any)}
          >
            <View style={styles.cardIconWrap}>
              <MaterialIcons name={accion.icon} size={32} color="#0ea5e9" />
            </View>
            <Text style={styles.cardLabel}>{accion.label}</Text>
            <Text style={styles.cardDesc}>{accion.descripcion}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#fff' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 24 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#94a3b8', marginTop: 2 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  card: {
    width: 220,
    padding: 20,
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    gap: 8,
  },
  cardIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  cardLabel: { fontSize: 15, fontWeight: '600', color: '#334155', textAlign: 'center' },
  cardDesc: { fontSize: 12, color: '#64748b', textAlign: 'center' },
});
