import { TouchableOpacity, StyleSheet, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useFavoritos, type Favorito } from '../hooks/useFavoritos';

type Props = {
  favorito: Favorito;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * Estrella para marcar/desmarcar un submódulo como favorito.
 * Detiene la propagación para no disparar la navegación de la tarjeta contenedora.
 */
export function EstrellaFavorito({ favorito, size = 20, style }: Props) {
  const { esFavorito, toggleFavorito } = useFavoritos();
  const activo = esFavorito(favorito.route);

  const onPress = (e: GestureResponderEvent) => {
    e?.stopPropagation?.();
    toggleFavorito(favorito);
  };

  return (
    <TouchableOpacity
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={[styles.btn, style]}
      activeOpacity={0.6}
      accessibilityLabel={activo ? 'Quitar de favoritos' : 'Añadir a favoritos'}
    >
      <MaterialIcons name={activo ? 'star' : 'star-border'} size={size} color={activo ? '#f59e0b' : '#cbd5e1'} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: { padding: 2 },
});
