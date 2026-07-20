import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '../../contexts/AuthContext';

type Submodulo = 'mantenimiento' | 'limpieza';

/**
 * Conmutador Mantenimiento | Limpieza para el contenedor común.
 * Filtra la pestaña de Limpieza por permiso `limpieza.ver`.
 */
export function SubmoduloTabs({ activo }: { activo: Submodulo }) {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const verLimpieza = hasPermiso('limpieza.ver');

  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={[styles.tab, activo === 'mantenimiento' && styles.tabActive]}
        onPress={() => activo !== 'mantenimiento' && router.replace('/mantenimiento')}
        activeOpacity={0.7}
      >
        <MaterialIcons name="build" size={16} color={activo === 'mantenimiento' ? '#0ea5e9' : '#64748b'} />
        <Text style={[styles.tabText, activo === 'mantenimiento' && styles.tabTextActive]}>Mantenimiento</Text>
      </TouchableOpacity>
      {verLimpieza ? (
        <TouchableOpacity
          style={[styles.tab, activo === 'limpieza' && styles.tabActive]}
          onPress={() => activo !== 'limpieza' && router.replace('/mantenimiento/limpieza')}
          activeOpacity={0.7}
        >
          <MaterialIcons name="cleaning-services" size={16} color={activo === 'limpieza' ? '#0ea5e9' : '#64748b'} />
          <Text style={[styles.tabText, activo === 'limpieza' && styles.tabTextActive]}>Limpieza</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  tabActive: { borderColor: '#7dd3fc', backgroundColor: '#e0f2fe' },
  tabText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  tabTextActive: { color: '#0369a1' },
});
