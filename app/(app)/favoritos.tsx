import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useFavoritos, type Favorito } from '../hooks/useFavoritos';
import { MODULOS, moduloDeRuta, type ModuloMenu } from '../constants/modulos';
import { EstrellaFavorito } from '../components/EstrellaFavorito';
import { HubNavCard, HubNavGrid } from '../components/ui/HubNavCard';
import { useHubNavGrid } from '../hooks/useHubNavGrid';
import { hubAccentById } from '../lib/hubNavAccent';

type Grupo = { modulo: ModuloMenu; favoritos: Favorito[] };

export default function FavoritosScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { favoritos, cargado } = useFavoritos();
  const { cardWidth, compact } = useHubNavGrid();

  const grupos = useMemo<Grupo[]>(() => {
    const visibles = favoritos.filter((f) => !f.permiso || hasPermiso(f.permiso));
    const porModulo = new Map<string, Favorito[]>();
    for (const f of visibles) {
      const modulo = moduloDeRuta(f.route);
      const key = modulo?.route ?? '/';
      if (!porModulo.has(key)) porModulo.set(key, []);
      porModulo.get(key)!.push(f);
    }
    const orden = new Map(MODULOS.map((m, i) => [m.route, i] as const));
    return Array.from(porModulo.entries())
      .map(([route, favs]) => ({
        modulo: MODULOS.find((m) => m.route === route) ?? { route, label: 'Otros', icon: 'folder', permiso: null },
        favoritos: [...favs].sort((a, b) => a.label.localeCompare(b.label, 'es')),
      }))
      .sort((a, b) => (orden.get(a.modulo.route) ?? 999) - (orden.get(b.modulo.route) ?? 999));
  }, [favoritos, hasPermiso]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <MaterialIcons name="star" size={22} color="#db2777" />
        <Text style={styles.title}>Favoritos</Text>
      </View>
      <Text style={styles.subtitle}>Accesos rápidos a tus submódulos marcados con la estrella.</Text>

      {!cargado ? (
        <ActivityIndicator size="small" color="#db2777" style={{ marginTop: 24 }} />
      ) : grupos.length === 0 ? (
        <View style={styles.empty}>
          <MaterialIcons name="star-border" size={40} color="#f9a8d4" />
          <Text style={styles.emptyText}>
            Aún no tienes favoritos. Pulsa la estrella en cualquier submódulo para tenerlo aquí en acceso rápido.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
          {grupos.map((g) => (
            <View key={g.modulo.route} style={styles.grupo}>
              <View style={styles.grupoHeader}>
                <MaterialIcons name={g.modulo.icon as React.ComponentProps<typeof MaterialIcons>['name']} size={18} color="#0ea5e9" />
                <Text style={styles.grupoTitle}>{g.modulo.label}</Text>
              </View>
              <HubNavGrid>
                {g.favoritos.map((fav) => {
                  const accent = hubAccentById(fav.route);
                  return (
                    <HubNavCard
                      key={fav.route}
                      label={fav.label}
                      icon={fav.icon as React.ComponentProps<typeof MaterialIcons>['name']}
                      accentBg={accent.accentBg}
                      accentFg={accent.accentFg}
                      width={cardWidth}
                      compact={compact}
                      onPress={() => router.push(fav.route as never)}
                      trailing={<EstrellaFavorito favorito={fav} />}
                    />
                  );
                })}
              </HubNavGrid>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#ffffff' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 4, marginBottom: 16 },
  scrollContent: { paddingBottom: 24 },
  grupo: { marginBottom: 20 },
  grupoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  grupoTitle: { fontSize: 15, fontWeight: '700', color: '#334155' },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 40, paddingHorizontal: 24 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center', lineHeight: 20 },
});
