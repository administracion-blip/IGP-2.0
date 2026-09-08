import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { HubNavCard, HubNavGrid } from '../../../components/ui/HubNavCard';
import { useHubNavGrid } from '../../../hooks/useHubNavGrid';
import { hubAccentById } from '../../../lib/hubNavAccent';
import { colors, radius, typography } from '../../../constants/theme';
import { MIN_TOUCH as TOUCH } from '../../../constants/layout';

type Acceso = {
  id: string;
  label: string;
  descripcion: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  ruta: string;
  permisosAny?: string[];
  permiso?: string;
};

const ACCESOS: Acceso[] = [
  {
    id: 'listado',
    label: 'Listado de activos',
    descripcion: 'Filtra por local, categoría y estado. Busca por etiqueta o serie',
    icon: 'inventory-2',
    ruta: '/mantenimiento/activos/listado',
    permiso: 'activos.ver',
  },
  {
    id: 'pendientes',
    label: 'Pendientes de verificar',
    descripcion: 'Etiquetas pegadas que aún no se han comprobado en el aparato',
    icon: 'qr-code-scanner',
    ruta: '/mantenimiento/activos/listado?pendientes=1',
    permiso: 'activos.ver',
  },
  {
    id: 'custodia',
    label: 'Custodia',
    descripcion: 'Qué tiene cada trabajador y quién tiene cada prenda',
    icon: 'assignment-ind',
    ruta: '/mantenimiento/activos/custodia',
    permiso: 'activos.ver',
  },
  {
    id: 'catalogo',
    label: 'Catálogo',
    descripcion: 'Modelos, stock y dar de alta prendas o aparatos',
    icon: 'category',
    ruta: '/mantenimiento/activos/catalogo',
    permisosAny: ['activos.ver', 'activos.crear', 'activos.editar'],
  },
  {
    id: 'plantillas',
    label: 'Plantillas de entrega',
    descripcion: 'Texto del acta, asignable a PDA, uniforme u otras categorías',
    icon: 'description',
    ruta: '/mantenimiento/activos/plantillas',
    permisosAny: ['activos.ver', 'activos.crear', 'activos.editar'],
  },
];

export default function ActivosHubScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { cardWidth, compact } = useHubNavGrid();

  const accesos = useMemo(() => {
    const filtrados = ACCESOS.filter((a) => {
      if (a.permisosAny?.length) return a.permisosAny.some((p) => hasPermiso(p));
      return a.permiso ? hasPermiso(a.permiso) : false;
    });
    return filtrados.sort((a, b) => a.label.localeCompare(b.label, 'es'));
  }, [hasPermiso]);

  if (!hasPermiso('activos.ver') && accesos.length === 0) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Activos</Text>
        <Text style={styles.vacio}>No tienes permiso para ver el inventario de activos.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => router.push('/mantenimiento' as never)}
          style={styles.backBtn}
          accessibilityLabel="Volver a Mantenimiento"
        >
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Activos</Text>
          <Text style={styles.subtitle}>
            Inventario del parque: qué hay, en qué local está y en qué estado.
          </Text>
        </View>
        {hasPermiso('activos.ver') ? (
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={() => router.push('/mantenimiento/activos/listado?buscar=1' as never)}
            accessibilityRole="button"
            accessibilityLabel="Buscar por etiqueta o serie"
          >
            <MaterialIcons name="search" size={20} color="#fff" />
            <Text style={styles.scanTitle}>Buscar</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
        <HubNavGrid>
          {accesos.map((a) => {
            const accent = hubAccentById(a.id);
            return (
              <HubNavCard
                key={a.id}
                label={a.label}
                description={a.descripcion}
                icon={a.icon}
                accentBg={accent.accentBg}
                accentFg={accent.accentFg}
                width={cardWidth}
                compact={compact}
                onPress={() => router.push(a.ruta as never)}
              />
            );
          })}
        </HubNavGrid>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: colors.surface },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 10 },
  backBtn: {
    width: TOUCH,
    height: TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { ...typography.titulo, color: '#0f172a' },
  subtitle: { ...typography.cuerpo, color: colors.textSecondary, marginTop: 2 },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: TOUCH,
    paddingHorizontal: 14,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  scanTitle: { color: '#fff', fontSize: 14, fontWeight: '700' },
  scrollContent: { paddingBottom: 24 },
  vacio: { fontSize: 14, color: colors.textMuted, marginTop: 12 },
});
