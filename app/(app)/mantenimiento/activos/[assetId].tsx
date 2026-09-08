import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { ActivoDetallePanel } from '../../../components/activos/ActivoDetallePanel';
import { MIN_TOUCH } from '../../../constants/layout';
import { colors, radius, typography } from '../../../constants/theme';

export default function ActivoFichaScreen() {
  const router = useRouter();
  const { assetId } = useLocalSearchParams<{ assetId: string }>();
  const { hasPermiso } = useAuth();

  if (!hasPermiso('activos.ver')) {
    return (
      <View style={styles.container}>
        <Text style={styles.vacio}>No tienes permiso para ver este activo.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/mantenimiento/activos/listado' as never);
          }}
          style={styles.iconBtn}
          accessibilityLabel="Volver"
        >
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Ficha</Text>
      </View>
      <ActivoDetallePanel assetId={typeof assetId === 'string' ? assetId : null} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface, padding: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  iconBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.titulo, color: '#0f172a' },
  vacio: { padding: 16, color: colors.textMuted },
});
