import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { EstrellaFavorito } from './EstrellaFavorito';
import type { Favorito } from '../hooks/useFavoritos';

type HubTileProps = {
  label: string;
  description: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  onPress: () => void;
  size: number;
  variant?: 'default' | 'accent';
  /** Si se indica, muestra la estrella de favorito en la esquina del tile. */
  favorito?: Favorito;
};

/**
 * Tile compacto para hubs operativos (tablet/móvil).
 * Cuadro estrecho; icono, título y descripción mantienen tamaño legible.
 */
export default function HubTile({
  label,
  description,
  icon,
  onPress,
  size,
  variant = 'default',
  favorito,
}: HubTileProps) {
  const accent = variant === 'accent';

  return (
    <TouchableOpacity
      style={[
        styles.tile,
        { width: size, minHeight: size },
        accent && styles.tileAccent,
      ]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      {favorito ? <EstrellaFavorito favorito={favorito} style={styles.favBtn} /> : null}
      <View style={[styles.iconWrap, accent && styles.iconWrapAccent]}>
        <MaterialIcons name={icon} size={32} color={accent ? '#0f172a' : '#0ea5e9'} />
      </View>
      <Text style={[styles.label, accent && styles.labelAccent]} numberOfLines={2}>
        {label}
      </Text>
      <Text
        style={[styles.description, accent && styles.descriptionAccent]}
        numberOfLines={3}
      >
        {description}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: '#ffffff',
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  favBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    zIndex: 2,
  },
  tileAccent: {
    backgroundColor: '#ffedd5',
    borderColor: '#fdba74',
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 14,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapAccent: {
    backgroundColor: '#fed7aa',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#334155',
    textAlign: 'center',
    lineHeight: 18,
    width: '100%',
  },
  labelAccent: {
    color: '#0f172a',
    fontWeight: '700',
  },
  description: {
    fontSize: 12,
    fontWeight: '400',
    fontStyle: 'italic',
    color: '#94a3b8',
    textAlign: 'center',
    lineHeight: 16,
    width: '100%',
  },
  descriptionAccent: {
    color: '#78716c',
  },
});
