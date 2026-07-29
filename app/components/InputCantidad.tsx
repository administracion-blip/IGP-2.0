import { Platform, StyleSheet, TextInput, TouchableOpacity, View, type TextStyle, type ViewStyle } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../constants/layout';

function parseCantidad(valor: string): number {
  const n = parseFloat(String(valor ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Texto visible: enteros sin decimales; decimales con coma. */
function formatCantidad(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(n).replace('.', ',');
}

function sanitizarEntrada(texto: string): string {
  return texto.replace(/[^\d.,]/g, '');
}

type Props = {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  /** Incremento/decremento con las flechas (por defecto 1). */
  paso?: number;
  min?: number;
  style?: ViewStyle;
  inputStyle?: TextStyle;
  disabled?: boolean;
};

/**
 * Cantidad con entrada manual y botones +/-. Pensado para líneas de pedido:
 * el stepper sube/baja de uno en uno; el teclado sigue admitiendo decimales.
 */
export function InputCantidad({
  value,
  onChangeText,
  placeholder = '0',
  paso = 1,
  min = 0,
  style,
  inputStyle,
  disabled = false,
}: Props) {
  const actual = parseCantidad(value);
  const puedeBajar = !disabled && actual > min;

  const ajustar = (delta: number) => {
    if (disabled) return;
    const siguiente = Math.max(min, actual + delta);
    onChangeText(formatCantidad(siguiente));
  };

  return (
    <View style={[styles.contenedor, disabled && styles.contenedorDisabled, style]}>
      <TouchableOpacity
        style={[styles.boton, !puedeBajar && styles.botonDisabled]}
        onPress={() => ajustar(-paso)}
        disabled={!puedeBajar}
        accessibilityRole="button"
        accessibilityLabel="Reducir cantidad"
        activeOpacity={0.7}
      >
        <MaterialIcons name="remove" size={20} color={puedeBajar ? '#475569' : '#cbd5e1'} />
      </TouchableOpacity>
      <TextInput
        style={[styles.input, inputStyle]}
        value={value}
        onChangeText={(v) => onChangeText(sanitizarEntrada(v))}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
        keyboardType="decimal-pad"
        editable={!disabled}
        selectTextOnFocus
        {...(Platform.OS === 'android' ? { textAlignVertical: 'center' as const } : {})}
      />
      <TouchableOpacity
        style={[styles.boton, disabled && styles.botonDisabled]}
        onPress={() => ajustar(paso)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Aumentar cantidad"
        activeOpacity={0.7}
      >
        <MaterialIcons name="add" size={20} color={disabled ? '#cbd5e1' : '#475569'} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  contenedor: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: MIN_TOUCH,
    minWidth: 168,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  contenedorDisabled: {
    backgroundColor: '#f8fafc',
    opacity: 0.7,
  },
  boton: {
    width: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
    borderColor: '#e2e8f0',
  },
  botonDisabled: {
    backgroundColor: '#f1f5f9',
  },
  input: {
    flex: 1,
    minWidth: 52,
    paddingHorizontal: 6,
    fontSize: 15,
    fontWeight: '600',
    color: '#334155',
    textAlign: 'center',
    borderWidth: 0,
    backgroundColor: 'transparent',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
});
