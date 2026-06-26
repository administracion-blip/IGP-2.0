import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';

/**
 * Hub del módulo "Recursos Humanos": accesos a empleados (Factorial HR)
 * y cuadrante de personal (turnos planificados vs fichajes reales).
 *
 * Las pantallas concretas siguen viviendo en sus rutas originales:
 *  - Empleados: `/personal` (`app/(app)/personal.tsx`)
 *  - Cuadrante: `/planning-dia/cuadrante` (`app/(app)/planning-dia/cuadrante.tsx`)
 *
 * Cada tarjeta se filtra por su permiso granular para no romper accesos
 * existentes (Base de Datos sigue mostrando "Personal" con `personal.ver`
 * y Planning del Día sigue enlazando al cuadrante con `planning_dia.ver`).
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
    id: 'empleados',
    label: 'Empleados',
    descripcion: 'Listado de empleados sincronizados con Factorial HR',
    icon: 'badge',
    ruta: '/personal',
    permiso: 'personal.ver',
  },
  {
    id: 'cuadrante',
    label: 'Cuadrante de personal',
    descripcion: 'Turnos planificados vs fichajes reales por local y fechas · costes',
    icon: 'groups',
    ruta: '/planning-dia/cuadrante',
    permiso: 'planning_dia.ver',
  },
  {
    id: 'horas-facturacion',
    label: 'Horas por facturación',
    descripcion: 'Horas de cuadrante posibles según el facturado comparativa, por local y agrupación',
    icon: 'schedule',
    ruta: '/recursos-humanos/horas-facturacion',
    permiso: 'rrhh.horas',
  },
];

export default function RecursosHumanosIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();

  const visibles = TARJETAS.filter((t) => hasPermiso(t.permiso));

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Recursos Humanos</Text>
          <Text style={styles.subtitle}>Empleados, cuadrante y herramientas de personal</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
        {visibles.length === 0 ? (
          <View style={styles.emptyBox}>
            <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
            <Text style={styles.emptyText}>
              No tienes permisos para acceder a herramientas de Recursos Humanos.
            </Text>
          </View>
        ) : (
          visibles.map((t) => (
            <TouchableOpacity
              key={t.id}
              style={styles.card}
              onPress={() => router.push(t.ruta as never)}
              activeOpacity={0.75}
            >
              <View style={styles.cardIconWrap}>
                <MaterialIcons name={t.icon} size={28} color="#0ea5e9" />
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.cardTitle}>{t.label}</Text>
                <Text style={styles.cardDesc}>{t.descripcion}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={22} color="#94a3b8" />
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#f1f5f9' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 10 },
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
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 4 },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  cardIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flex: 1 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a', marginBottom: 4 },
  cardDesc: { fontSize: 13, color: '#64748b', lineHeight: 18 },

  emptyBox: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 40,
  },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
});
