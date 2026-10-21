import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radius, shadow, SPACING } from '../../constants/theme';

type Props = {
  children: ReactNode;
  /** La sombra solo en tarjetas flotantes. En lista basta el borde. */
  elevada?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Tarjeta({ children, elevada, style }: Props) {
  return <View style={[styles.base, elevada && shadow.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: SPACING.lg,
  },
});
