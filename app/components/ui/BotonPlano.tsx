import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH, SPACING } from '../../constants/layout';
import { fontFamily, fontSizes, radius } from '../../constants/theme';

export type VarianteBotonPlano = 'gris' | 'azul';

type Props = {
  titulo: string;
  onPress: () => void;
  variante?: VarianteBotonPlano;
  /** Nombre de MaterialIcons, a la izquierda del título. */
  icono?: keyof typeof MaterialIcons.glyphMap;
  /** Borde gris discontinuo, para «Añadir producto». */
  discontinuo?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Botón secundario, sin animación. Al pulsar baja la opacidad; desactivado, aún más.
 */
export function BotonPlano({
  titulo,
  onPress,
  variante = 'gris',
  icono,
  discontinuo = false,
  disabled = false,
  accessibilityLabel,
  style,
}: Props) {
  const azul = variante === 'azul';
  const color = azul ? '#0ea5e9' : '#475569';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? titulo}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.base,
        azul ? styles.azul : styles.gris,
        discontinuo && styles.discontinuo,
        { opacity: disabled ? 0.4 : pressed ? 0.55 : 1 },
        style,
      ]}
    >
      <View style={styles.fila}>
        {icono ? <MaterialIcons name={icono} size={18} color={color} /> : null}
        <Text style={[styles.texto, { color }]} numberOfLines={1}>
          {titulo}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignSelf: 'flex-start',
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gris: {
    backgroundColor: '#ffffff',
    borderColor: '#cbd5e1',
  },
  azul: {
    backgroundColor: '#ffffff',
    borderColor: '#0ea5e9',
  },
  discontinuo: {
    borderStyle: 'dashed',
    borderColor: '#94a3b8',
    backgroundColor: '#ffffff',
  },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  texto: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[14],
    fontWeight: '600',
  },
});
