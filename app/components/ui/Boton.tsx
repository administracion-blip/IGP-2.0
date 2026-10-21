import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fontSizes, radius, typography, MIN_TOUCH, SPACING } from '../../constants/theme';

type Variante = 'primario' | 'secundario' | 'peligro' | 'texto';

type Props = {
  titulo: string;
  onPress: () => void;
  variante?: Variante;
  disabled?: boolean;
  cargando?: boolean;
  /** Icono u otro nodo a la izquierda del título. */
  icono?: ReactNode;
  accessibilityLabel?: string;
};

const FONDO: Record<Variante, string> = {
  primario: colors.accent,
  secundario: colors.surface,
  peligro: colors.danger,
  texto: 'transparent',
};

const FONDO_PULSADO: Record<Variante, string> = {
  primario: colors.accentPressed,
  secundario: colors.navPressed,
  peligro: colors.danger,
  texto: colors.accentMuted,
};

const TEXTO: Record<Variante, string> = {
  primario: colors.surface,
  secundario: colors.textStrong,
  peligro: colors.surface,
  texto: colors.accentPressed,
};

export function Boton({
  titulo,
  onPress,
  variante = 'primario',
  disabled,
  cargando,
  icono,
  accessibilityLabel,
}: Props) {
  const bloqueado = disabled || cargando;
  const colorTexto = TEXTO[variante];
  return (
    <Pressable
      onPress={onPress}
      disabled={bloqueado}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? titulo}
      accessibilityState={{ disabled: !!bloqueado, busy: !!cargando }}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: pressed ? FONDO_PULSADO[variante] : FONDO[variante],
          borderWidth: variante === 'secundario' ? 1 : 0,
        },
        bloqueado && styles.off,
      ]}
    >
      {cargando ? (
        <ActivityIndicator color={colorTexto} />
      ) : (
        <View style={styles.fila}>
          {icono}
          <Text style={[styles.texto, { color: colorTexto }]} numberOfLines={1}>
            {titulo}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.lg,
    borderRadius: radius.md,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Un solo uso: el botón desactivado se atenúa sin un token de opacidad. */
  off: { opacity: 0.5 },
  fila: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  texto: {
    ...typography.boton,
    fontSize: fontSizes[14],
  },
});
