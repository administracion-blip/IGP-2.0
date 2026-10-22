import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import {
  colors,
  fontFamily,
  fontSizes,
  typography,
  SPACING,
} from '../../constants/theme';

export default function CoverManagerScreen() {
  const router = useRouter();
  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Cover Manager</Text>
      </View>
      <View style={styles.emptyBox}>
        <MaterialIcons name="schedule" size={48} color={colors.borderStrong} />
        <Text style={styles.emptyText}>
          La integración con Cover Manager estará disponible próximamente.
        </Text>
      </View>
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
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
  title: {
    fontFamily: fontFamily.bold,
    fontSize: fontSizes[20],
    fontWeight: typography.titulo.fontWeight,
    color: colors.textPrimary,
  },
  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.md, padding: SPACING.xl },
  emptyText: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[14],
    color: colors.textMuted,
    textAlign: 'center',
    maxWidth: 360,
  },
});
