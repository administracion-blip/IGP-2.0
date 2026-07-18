import type { ReactNode, ComponentProps } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors, SPACING } from '../../constants/theme';
type IconName = ComponentProps<typeof MaterialIcons>['name'];

type Props = {
  icon?: IconName;
  mensaje: string;
  /** Acción opcional (p. ej. botón) renderizada debajo del mensaje */
  accion?: ReactNode;
};

export function EstadoVacio({ icon = 'inbox', mensaje, accion }: Props) {
  return (
    <View style={styles.wrap}>
      <MaterialIcons name={icon} size={32} color={colors.textMuted} />
      <Text style={styles.mensaje}>{mensaje}</Text>
      {accion ?? null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.xl,
    paddingHorizontal: SPACING.lg,
  },
  mensaje: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
