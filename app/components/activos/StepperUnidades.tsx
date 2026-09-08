import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { colors, radius } from '../../constants/theme';

type Props = {
  valor: number;
  min?: number;
  max: number;
  onChange: (n: number) => void;
  /** Muestra «/ max» a la derecha del número. */
  mostrarMax?: boolean;
};

/** Selector − / + de unidades con zonas táctiles cómodas. */
export function StepperUnidades({ valor, min = 0, max, onChange, mostrarMax = true }: Props) {
  const puedeBajar = valor > min;
  const puedeSubir = valor < max;
  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={[styles.btn, !puedeBajar && styles.btnOff]}
        onPress={() => puedeBajar && onChange(valor - 1)}
        disabled={!puedeBajar}
        accessibilityLabel="Quitar una unidad"
      >
        <MaterialIcons name="remove" size={20} color={puedeBajar ? colors.textPrimary : colors.textMuted} />
      </TouchableOpacity>
      <View style={styles.valorBox}>
        <Text style={styles.valor}>{valor}</Text>
        {mostrarMax ? <Text style={styles.max}>/ {max}</Text> : null}
      </View>
      <TouchableOpacity
        style={[styles.btn, !puedeSubir && styles.btnOff]}
        onPress={() => puedeSubir && onChange(valor + 1)}
        disabled={!puedeSubir}
        accessibilityLabel="Añadir una unidad"
      >
        <MaterialIcons name="add" size={20} color={puedeSubir ? colors.textPrimary : colors.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  btn: {
    minWidth: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnOff: { opacity: 0.4 },
  valorBox: { minWidth: 46, alignItems: 'center', justifyContent: 'center' },
  valor: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  max: { fontSize: 11, color: colors.textMuted },
});
