import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { HubNavCard, HubNavGrid } from '../../../components/ui/HubNavCard';
import { useHubNavGrid } from '../../../hooks/useHubNavGrid';
import { hubAccentById } from '../../../lib/hubNavAccent';
import {
  colors,
  fontFamily,
  fontSizes,
  typography,
  SPACING,
} from '../../../constants/theme';

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
    id: 'registros',
    label: 'Checklist de hoy',
    descripcion: 'Limpiezas programadas por local: completar con foto',
    icon: 'checklist',
    ruta: '/mantenimiento/limpieza/registros',
    permiso: 'limpieza.ver',
  },
  {
    id: 'calendario',
    label: 'Calendario',
    descripcion: 'Vista mes/semana/día de las limpiezas programadas',
    icon: 'calendar-month',
    ruta: '/mantenimiento/limpieza/calendario',
    permiso: 'limpieza.ver',
  },
  {
    id: 'maestros',
    label: 'Tipos y objetos',
    descripcion: 'Catálogo de tipos y unidades físicas de cada local',
    icon: 'category',
    ruta: '/mantenimiento/limpieza/maestros',
    permisosAny: ['limpieza.catalogo', 'limpieza.programar'],
  },
  {
    id: 'programacion',
    label: 'Programación',
    descripcion: 'Reglas de frecuencia por objeto y generación de registros',
    icon: 'event-repeat',
    ruta: '/mantenimiento/limpieza/programacion',
    permiso: 'limpieza.programar',
  },
];

export default function LimpiezaHubScreen() {
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

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/mantenimiento' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Limpieza</Text>
          <Text style={styles.subtitle}>Checklists de limpieza recurrente con evidencia (foto + firma) para APPCC.</Text>
        </View>
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
        {accesos.length === 0 ? (
          <Text style={styles.vacio}>No tienes permisos de limpieza asignados.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, padding: SPACING.lg, backgroundColor: colors.surface },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.lg, gap: 10 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { fontSize: fontSizes[20], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, lineHeight: 20, marginTop: 2 },
  scrollContent: { paddingBottom: SPACING.xl },
  vacio: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, padding: SPACING.lg, marginTop: SPACING.sm },
});
