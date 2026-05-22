import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';

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
};

const TARJETAS: Tarjeta[] = [
  {
    id: 'cuadrante',
    label: 'Cuadrante de personal',
    icon: 'groups',
    descripcion: 'Turnos vs fichajes (Factorial HR) por local y fechas',
    ruta: '/planning-dia/cuadrante',
    permiso: 'planning_dia.ver',
  },
  {
    id: 'pedidos',
    label: 'Pedidos',
    icon: 'local-shipping',
    descripcion: 'Lanzar y revisar pedidos del día a proveedores',
    ruta: '/compras/pedidos',
    permiso: 'pedidos.ver',
  },
  {
    id: 'actuaciones',
    label: 'Actuaciones del día',
    icon: 'mic',
    descripcion: 'Conciertos, artistas y previsión de facturación del día',
    ruta: '/actuaciones',
    permiso: 'actuaciones.ver',
  },
  {
    id: 'arqueo-caja',
    label: 'Arqueo de Caja',
    icon: 'account-balance-wallet',
    descripcion: 'Cuadrar y cerrar caja al final del día',
    ruta: '/cajas/arqueo-caja',
    permiso: 'cierres.ver',
  },
];

export default function PlanningDiaIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();

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

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
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
              <TouchableOpacity
                key={t.id}
                style={styles.card}
                onPress={() => router.push(t.ruta as never)}
                activeOpacity={0.7}
              >
                <View style={styles.cardLeft}>
                  <MaterialIcons name={t.icon} size={24} color="#0ea5e9" />
                  <Text style={styles.cardLabel}>{t.label}</Text>
                </View>
                <Text style={styles.cardDescripcion} numberOfLines={2}>
                  {t.descripcion}
                </Text>
              </TouchableOpacity>
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
  cardLabel: { fontSize: 15, fontWeight: '500', color: '#334155' },
  cardDescripcion: {
    flex: 1,
    fontSize: 12,
    fontWeight: '400',
    fontStyle: 'italic',
    color: '#94a3b8',
    marginLeft: 8,
    textAlign: 'right',
  },

  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
});
