import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { SoftPulseBorderWrap } from '../ui/SoftPulseBorderWrap';
import { ICON_SIZE } from '../../constants/icons';
import { MIN_TOUCH } from '../../constants/layout';
import { colors, radius } from '../../constants/theme';

const ROSA_BG = '#fce7f3';
const ROSA_FG = '#be185d';

type Props = {
  unidades: number;
  onPress: () => void;
  compact?: boolean;
};

/** Cesta de entrega: inactiva si está vacía; rosa + borde láser (como Favoritos) si hay prendas. */
export function BotonCestaActivos({ unidades, onPress, compact }: Props) {
  const activo = unidades > 0;
  const btn = (
    <TouchableOpacity
      disabled={!activo}
      onPress={onPress}
      style={[styles.btn, activo ? styles.btnOn : styles.btnOff, compact && styles.tactil]}
      accessibilityLabel="Cesta de entrega"
      accessibilityState={{ disabled: !activo }}
    >
      <MaterialIcons name="shopping-cart" size={ICON_SIZE} color={activo ? ROSA_FG : colors.textMuted} />
      <Text style={[styles.txt, activo ? styles.txtOn : styles.txtOff]}>
        {activo ? `Cesta (${unidades})` : 'Cesta'}
      </Text>
    </TouchableOpacity>
  );
  if (!activo) return btn;
  return (
    <SoftPulseBorderWrap preset="favoritos" borderRadius={radius.md}>
      {btn}
    </SoftPulseBorderWrap>
  );
}

const styles = StyleSheet.create({
  btn: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  tactil: { minHeight: MIN_TOUCH },
  btnOff: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    opacity: 0.65,
  },
  btnOn: {
    backgroundColor: ROSA_BG,
  },
  txt: { fontSize: 13, fontWeight: '700' },
  txtOff: { color: colors.textMuted },
  txtOn: { color: ROSA_FG },
});
