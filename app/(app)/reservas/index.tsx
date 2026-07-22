import { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { EstrellaFavorito } from '../../components/EstrellaFavorito';
import { HubNavCard, HubNavGrid } from '../../components/ui/HubNavCard';
import { useHubNavGrid } from '../../hooks/useHubNavGrid';
import { hubAccentById } from '../../lib/hubNavAccent';

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
  const { cardWidth, compact } = useHubNavGrid();

  const visibles = useMemo(
    () =>
      TARJETAS.filter((t) => hasPermiso(t.permiso)).sort((a, b) =>
        a.label.localeCompare(b.label, 'es'),
      ),
    [hasPermiso],
  );

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

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
        {visibles.length === 0 ? (
          <View style={styles.emptyBox}>
            <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
            <Text style={styles.emptyText}>No tienes permisos para acceder a este módulo.</Text>
          </View>
        ) : (
          <HubNavGrid>
            {visibles.map((t) => {
              const accent = hubAccentById(t.id);
              return (
                <HubNavCard
                  key={t.id}
                  label={t.label}
                  description={t.descripcion}
                  icon={t.icon}
                  accentBg={accent.accentBg}
                  accentFg={accent.accentFg}
                  width={cardWidth}
                  compact={compact}
                  onPress={() => router.push(t.ruta as never)}
                  trailing={
                    <EstrellaFavorito
                      favorito={{ route: t.ruta, label: t.label, icon: t.icon, permiso: t.permiso }}
                    />
                  }
                />
              );
            })}
          </HubNavGrid>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#ffffff' },
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
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 2 },
  scrollContent: { paddingBottom: 24 },
  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
});
