import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { hubTileSideSize } from '../../constants/layout';
import HubTile from '../../components/HubTile';

/**
 * Hub del módulo "Planning del día": accesos rápidos a las acciones
 * operativas del día a día (mañana → cierre). Cada tarjeta enlaza a una
 * pantalla existente filtrada por su permiso granular para no duplicar
 * lógica ni acoplar este hub al resto de módulos.
 */
type Tarjeta = {
  id: string;
  label: string;
  descripcion: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  ruta: string;
  permiso: string;
  variant?: 'default' | 'accent';
};

const TARJETAS: Tarjeta[] = [
  {
    id: 'cuadrante',
    label: 'Cuadrante de personal',
    descripcion: 'Turnos vs fichajes (Factorial HR) por local y fechas',
    icon: 'groups',
    ruta: '/planning-dia/cuadrante',
    permiso: 'planning_dia.ver',
  },
  {
    id: 'almacen',
    label: 'Preparar pedidos',
    descripcion: 'Almacén: preparar los pedidos enviados por los locales',
    icon: 'inventory-2',
    ruta: '/compras/almacen',
    permiso: 'pedidos.preparar',
    variant: 'accent',
  },
  {
    id: 'actuaciones',
    label: 'Actuaciones del día',
    descripcion: 'Músicos del día, firma, observaciones y valoración',
    icon: 'mic',
    ruta: '/planning-dia/actuaciones',
    permiso: 'actuaciones.ver',
  },
  {
    id: 'arqueo-caja',
    label: 'Arqueo de Caja',
    descripcion: 'Cuadrar y cerrar caja al final del día',
    icon: 'account-balance-wallet',
    ruta: '/cajas/arqueo-caja',
    permiso: 'cierres.ver',
  },
];

export default function PlanningDiaIndexScreen() {
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
          <Text style={styles.title}>Planning del día</Text>
          <Text style={styles.subtitle}>Acciones rápidas del día a día</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {visibles.length === 0 ? (
          <View style={styles.emptyBox}>
            <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
            <Text style={styles.emptyText}>
              No tienes permisos para acceder a las acciones del día.
            </Text>
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
                variant={t.variant}
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
});
