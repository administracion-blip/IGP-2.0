import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { SubmoduloTabs } from '../SubmoduloTabs';

type Acceso = {
  id: string;
  label: string;
  descripcion: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  ruta: string;
  permiso: string;
};

const ACCESOS: Acceso[] = [
  {
    id: 'registros',
    label: 'Checklist de hoy',
    descripcion: 'Limpiezas programadas por local: completar con foto y firma',
    icon: 'checklist',
    ruta: '/mantenimiento/limpieza/registros',
    permiso: 'limpieza.ver',
  },
  {
    id: 'programacion',
    label: 'Programación',
    descripcion: 'Reglas de frecuencia por local y generación de registros',
    icon: 'event-repeat',
    ruta: '/mantenimiento/limpieza/programacion',
    permiso: 'limpieza.programar',
  },
  {
    id: 'catalogo',
    label: 'Catálogo de objetos',
    descripcion: 'Neveras, congeladores, freidoras… con procedimiento y productos',
    icon: 'inventory-2',
    ruta: '/mantenimiento/limpieza/catalogo',
    permiso: 'limpieza.catalogo',
  },
];

export default function LimpiezaHubScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const accesos = ACCESOS.filter((a) => hasPermiso(a.permiso));

  return (
    <View style={styles.container}>
      <SubmoduloTabs activo="limpieza" />
      <Text style={styles.title}>Limpieza</Text>
      <Text style={styles.subtitle}>Checklists de limpieza recurrente con evidencia (foto + firma) para APPCC.</Text>

      <ScrollView contentContainerStyle={styles.grid}>
        {accesos.map((a) => (
          <TouchableOpacity key={a.id} style={styles.card} onPress={() => router.push(a.ruta as never)} activeOpacity={0.8}>
            <View style={styles.cardIcon}>
              <MaterialIcons name={a.icon} size={26} color="#0ea5e9" />
            </View>
            <Text style={styles.cardLabel}>{a.label}</Text>
            <Text style={styles.cardDesc}>{a.descripcion}</Text>
          </TouchableOpacity>
        ))}
        {accesos.length === 0 ? (
          <Text style={styles.vacio}>No tienes permisos de limpieza asignados.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748b', lineHeight: 20, marginBottom: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: {
    width: 240,
    padding: 16,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    gap: 8,
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardLabel: { fontSize: 15, fontWeight: '700', color: '#334155' },
  cardDesc: { fontSize: 12, color: '#64748b', lineHeight: 17 },
  vacio: { fontSize: 13, color: '#94a3b8', padding: 16 },
});
