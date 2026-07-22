import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { HubNavCard, HubNavGrid } from '../components/ui/HubNavCard';
import { useHubNavGrid } from '../hooks/useHubNavGrid';

type TablaHub = {
  id: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  descripcion: string;
  permiso: string;
  accentBg: string;
  accentFg: string;
};

const TABLAS: TablaHub[] = [
  { id: 'usuarios', label: 'Usuarios', icon: 'people', descripcion: 'Cuentas y permisos de acceso', permiso: 'usuarios.ver', accentBg: '#e0f2fe', accentFg: '#0ea5e9' },
  { id: 'locales', label: 'Locales', icon: 'store', descripcion: 'Sedes y puntos de venta', permiso: 'locales.ver', accentBg: '#dcfce7', accentFg: '#16a34a' },
  { id: 'almacenes', label: 'Almacenes', icon: 'local-shipping', descripcion: 'Almacenes y depósitos', permiso: 'almacenes.ver', accentBg: '#ede9fe', accentFg: '#7c3aed' },
  { id: 'empresas', label: 'Empresas', icon: 'business', descripcion: 'Listado de empresas', permiso: 'empresas.ver', accentBg: '#ccfbf1', accentFg: '#0d9488' },
  { id: 'productos', label: 'Productos', icon: 'inventory', descripcion: 'Carta y stock', permiso: 'productos.ver', accentBg: '#e0e7ff', accentFg: '#4f46e5' },
  { id: 'puntos-venta', label: 'Puntos de Venta', icon: 'storefront', descripcion: 'Puntos de venta y TPV', permiso: 'puntos_venta.ver', accentBg: '#cffafe', accentFg: '#0891b2' },
  { id: 'artistas', label: 'Artistas', icon: 'mic', descripcion: 'Actuaciones y programación', permiso: 'actuaciones.ver', accentBg: '#fce7f3', accentFg: '#db2777' },
  { id: 'personal', label: 'Personal', icon: 'badge', descripcion: 'Empleados (Factorial HR)', permiso: 'personal.ver', accentBg: '#d1fae5', accentFg: '#059669' },
  { id: 'usuarios-agora', label: 'Usuarios Ágora', icon: 'person-pin', descripcion: 'Maestro de usuarios de Ágora', permiso: 'usuarios_agora.ver', accentBg: '#dbeafe', accentFg: '#2563eb' },
  { id: 'formas-pago', label: 'Formas de Pago', icon: 'account-balance-wallet', descripcion: 'Formas de pago de Ágora y arqueo', permiso: 'cierres.ver', accentBg: '#ffedd5', accentFg: '#d97706' },
];

export default function BaseDatosScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { cardWidth, compact } = useHubNavGrid();

  function handleSeleccionar(id: string) {
    if (id === 'usuarios') router.push('/usuarios');
    if (id === 'locales') router.push('/locales');
    if (id === 'almacenes') router.push('/almacenes');
    if (id === 'empresas') router.push('/empresas');
    if (id === 'productos') router.push('/productos');
    if (id === 'puntos-venta') router.push('/puntos-venta');
    if (id === 'artistas') router.push('/actuaciones/artistas');
    if (id === 'personal') router.push('/personal');
    if (id === 'usuarios-agora') router.push('/usuarios-agora');
    if (id === 'formas-pago') router.push('/formas-pago');
  }

  const tablasVisibles = useMemo(
    () =>
      TABLAS.filter((tabla) => hasPermiso(tabla.permiso)).sort((a, b) =>
        a.label.localeCompare(b.label, 'es'),
      ),
    [hasPermiso],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Base de Datos</Text>
      <Text style={styles.subtitle}>Selecciona una tabla para gestionar sus datos</Text>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
        <HubNavGrid>
          {tablasVisibles.map((tabla) => (
            <HubNavCard
              key={tabla.id}
              label={tabla.label}
              description={tabla.descripcion}
              icon={tabla.icon}
              accentBg={tabla.accentBg}
              accentFg={tabla.accentFg}
              width={cardWidth}
              compact={compact}
              onPress={() => handleSeleccionar(tabla.id)}
            />
          ))}
        </HubNavGrid>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#ffffff' },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748b', marginBottom: 16 },
});
