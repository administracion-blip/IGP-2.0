import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { hubTileSideSize } from '../../constants/layout';
import HubTile from '../../components/HubTile';

type Tarjeta = {
  id: string;
  label: string;
  descripcion: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  ruta: string;
  permiso: string;
};

const TARJETAS: Tarjeta[] = [
  {
    id: 'cover-manager',
    label: 'Cover Manager',
    descripcion: 'Gestión de reservas (integración próximamente)',
    icon: 'event-available',
    ruta: '/reservas/cover-manager',
    permiso: 'reservas.ver',
  },
  {
    id: 'activaciones',
    label: 'Activaciones de marca',
    descripcion: 'Campañas y activaciones de marcas de bebidas',
    icon: 'celebration',
    ruta: '/reservas/activaciones',
    permiso: 'activaciones.ver',
  },
];

export default function ReservasIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { width, height } = useBreakpoint();
  const tileSize = hubTileSideSize(width, height);

  const visibles = TARJETAS.filter((t) => hasPermiso(t.permiso));

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Reservas</Text>
          <Text style={styles.subtitle}>Reservas y activaciones de marca</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {visibles.length === 0 ? (
          <View style={styles.emptyBox}>
            <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
            <Text style={styles.emptyText}>No tienes permisos para acceder a este módulo.</Text>
          </View>
        ) : (
          <View style={styles.grid}>
            {visibles.map((t) => (
              <HubTile
                key={t.id}
                label={t.label}
                description={t.descripcion}
                icon={t.icon}
                size={tileSize}
                onPress={() => router.push(t.ruta as never)}
                favorito={{ route: t.ruta, label: t.label, icon: t.icon, permiso: t.permiso }}
              />
            ))}
          </View>
        )}
      </ScrollView>
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
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 2 },
  scrollContent: { paddingBottom: 24 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
});
