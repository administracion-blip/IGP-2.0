import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { HubNavCard, HubNavGrid } from '../../components/ui/HubNavCard';
import { useHubNavGrid } from '../../hooks/useHubNavGrid';
import { hubAccentById } from '../../lib/hubNavAccent';

type Acceso = {
  id: string;
  label: string;
  descripcion: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  ruta: string;
  permiso: string;
};

const ACCESOS: Acceso[] = [
  {
    id: 'entradas',
    label: 'Entradas online',
    descripcion: 'Emitir entradas, sync Ágora y envío por WhatsApp',
    icon: 'confirmation-number',
    ruta: '/rrpp/entradas',
    permiso: 'entradas.ver',
  },
  {
    id: 'entradas-config',
    label: 'Configuración Ágora',
    descripcion: 'URL, token y tipos de entrada por local',
    icon: 'settings',
    ruta: '/rrpp/entradas/config',
    permiso: 'entradas.configurar',
  },
];

export default function RrppHubScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { cardWidth, compact } = useHubNavGrid();

  const accesos = useMemo(() => {
    const filtrados = ACCESOS.filter((a) => hasPermiso(a.permiso));
    return filtrados.sort((a, b) => a.label.localeCompare(b.label, 'es'));
  }, [hasPermiso]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => router.push('/recursos-humanos' as never)}
          style={styles.backBtn}
          accessibilityLabel="Volver a Recursos Humanos"
        >
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>RRPP</Text>
          <Text style={styles.subtitle}>
            Entradas online, sincronización con Ágora y herramientas de relaciones públicas.
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
        {accesos.length === 0 ? (
          <View style={styles.emptyBox}>
            <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
            <Text style={styles.emptyText}>No tienes permisos para acceder a RRPP.</Text>
          </View>
        ) : (
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
  subtitle: { fontSize: 14, color: '#64748b', lineHeight: 20, marginTop: 2 },
  scrollContent: { paddingBottom: 24 },
  emptyBox: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 10,
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },
});
