import { type ComponentProps } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colores, peso, radios } from './tokens';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

type Props = {
  titulo: string;
  onPress: () => void;
  variante: 'primario' | 'secundario';
  alto?: number;
  radio?: number;
  disabled?: boolean;
  cargando?: boolean;
  icono?: IconName;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

export function BotonPrevision({
  titulo,
  onPress,
  variante,
  alto = 36,
  radio = radios.control,
  disabled,
  cargando,
  icono,
  style,
  accessibilityLabel,
}: Props) {
  const primario = variante === 'primario';
  const bloqueado = disabled || cargando;
  const colorTexto = primario ? colores.textoSobreAcento : colores.texto;
  return (
    <TouchableOpacity
      style={[
        styles.base,
        {
          minHeight: alto,
          height: alto,
          borderRadius: radio,
          backgroundColor: primario ? colores.acento : colores.superficie,
          borderWidth: primario ? 0 : 1,
          borderColor: colores.borde,
        },
        bloqueado && styles.off,
        style,
      ]}
      onPress={onPress}
      disabled={bloqueado}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? titulo}
      accessibilityState={{ disabled: !!bloqueado, busy: !!cargando }}
    >
      {cargando ? (
        <ActivityIndicator size="small" color={colorTexto} />
      ) : (
        <>
          {icono ? <MaterialIcons name={icono} size={16} color={colorTexto} /> : null}
          <Text
            style={[
              styles.texto,
              { color: colorTexto, fontWeight: primario ? peso.semibold : peso.medio },
            ]}
            numberOfLines={1}
          >
            {titulo}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
  },
  texto: { fontSize: 13 },
  off: { opacity: 0.45 },
});
