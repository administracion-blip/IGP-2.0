import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { HubNavCard, HubNavGrid } from '../../components/ui/HubNavCard';
import { useHubNavGrid } from '../../hooks/useHubNavGrid';
import { hubAccentById } from '../../lib/hubNavAccent';
import {
  colors,
  fontFamily,
  fontSizes,
  typography,
  SPACING,
} from '../../constants/theme';

type AccesoModulo = {
  id: string;
  label: string;
  descripcion: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  ruta: string;
  permiso: string;
};

const ACCESOS: AccesoModulo[] = [
  {
    id: 'mantenimiento',
    label: 'Mantenimiento',
    descripcion: 'Incidencias, reparaciones programadas y seguimiento de averías',
    icon: 'build',
    ruta: '/mantenimiento/incidencias',
    permiso: 'mantenimiento.ver',
  },
  {
    id: 'limpieza',
    label: 'Limpieza',
    descripcion: 'Checklists de limpieza recurrente con evidencia para APPCC',
    icon: 'cleaning-services',
    ruta: '/mantenimiento/limpieza',
    permiso: 'limpieza.ver',
  },
  {
    id: 'activos',
    label: 'Activos',
    descripcion: 'Inventario de dispositivos, maquinaria y material: qué hay, dónde y en qué estado',
    icon: 'devices',
    ruta: '/mantenimiento/activos',
    permiso: 'activos.ver',
  },
];

export default function MantenimientoHubScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { cardWidth, compact } = useHubNavGrid();

  const accesos = useMemo(
    () =>
      ACCESOS.filter((a) => hasPermiso(a.permiso)).sort((a, b) =>
        a.label.localeCompare(b.label, 'es'),
      ),
    [hasPermiso],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mantenimiento</Text>
      <Text style={styles.subtitle}>Incidencias, limpieza e inventario de activos. Selecciona un área.</Text>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
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
        {accesos.length === 0 ? (
          <Text style={styles.vacio}>No tienes permisos asignados en este módulo.</Text>
        ) : null}
              </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: SPACING.lg, backgroundColor: colors.surface },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: fontSizes[20],
    fontWeight: typography.titulo.fontWeight,
    color: colors.textStrong,
    marginBottom: SPACING.xs,
  },
  subtitle: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[14],
    color: colors.textMuted,
    lineHeight: 20,
    marginBottom: SPACING.lg,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: SPACING.xl },
  vacio: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[13],
    color: colors.textMuted,
    fontStyle: 'italic',
    marginTop: SPACING.sm,
  },
});
