import { Pressable, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { radius } from '../../constants/theme';

type Props = {
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
};

/**
 * Papelera plana, solo icono. Sin animación: al pulsar baja la opacidad.
 */
export function BotonPeligro({ onPress, disabled = false, accessibilityLabel = 'Eliminar' }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      style={({ pressed }) => [
        styles.base,
        { opacity: disabled ? 0.4 : pressed ? 0.55 : 1 },
      ]}
    >
      <MaterialIcons name="delete-outline" size={22} color="#dc2626" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
