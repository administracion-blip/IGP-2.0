import type { ComponentProps } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors, iconSize, MIN_TOUCH, radius, sidebar, SPACING, typography } from '../../constants/theme';
import { SoftPulseBorderWrap } from './SoftPulseBorderWrap';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

/** Rosa de Favoritos; no hay token de ese matiz. */
const FAV_PINK = '#f9a8d4';

type Props = {
  label: string;
  icon: IconName;
  active?: boolean;
  collapsed?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  /** Estrella rosa pastel con borde parpadeante suave (entrada Favoritos). */
  accentFavoritos?: boolean;
};

/**
 * Ítem de navegación lateral. Módulos: activo sky; Favoritos: rosa + SoftPulse.
 */
export function SidebarNavItem({
  label,
  icon,
  active = false,
  collapsed = false,
  onPress,
  accessibilityLabel,
  accentFavoritos = false,
}: Props) {
  const iconColor = accentFavoritos ? FAV_PINK : active ? colors.accent : colors.textMuted;
  const textWeight = accentFavoritos
    ? active
      ? typography.subtitulo.fontWeight
      : typography.nav.fontWeight
    : typography.cuerpo.fontWeight;

  const resolvedIcon = accentFavoritos ? 'star' : icon;

  const itemInner = (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.item,
        collapsed && styles.itemCollapsed,
        !accentFavoritos && active && styles.itemActive,
        accentFavoritos && styles.itemFavoritos,
        !accentFavoritos && !active && (pressed || hovered) && styles.itemHover,
      ]}
    >
      {!accentFavoritos && active ? <View style={styles.activeBar} /> : null}
      <View style={[styles.iconWrap, collapsed && styles.iconWrapCollapsed]}>
        <MaterialIcons name={resolvedIcon} size={iconSize.nav} color={iconColor} />
      </View>
      {!collapsed ? (
        <Text
          style={[
            styles.label,
            !accentFavoritos && styles.labelModulo,
            !accentFavoritos && active && styles.labelActiveModulo,
            accentFavoritos && { fontWeight: textWeight },
            accentFavoritos && styles.labelFavoritos,
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      ) : null}
    </Pressable>
  );

  if (!accentFavoritos) return itemInner;

  return (
    <SoftPulseBorderWrap
      preset="favoritos"
      borderRadius={radius.sm}
      style={[styles.favGlowWrap, collapsed && styles.favGlowWrapCollapsed]}
    >
      {itemInner}
    </SoftPulseBorderWrap>
  );
}

const styles = StyleSheet.create({
  item: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: sidebar.itemHeight,
    marginHorizontal: 6,
    marginVertical: 1,
    paddingHorizontal: SPACING.sm,
    borderRadius: radius.sm,
  },
  itemCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    alignSelf: 'center',
  },
  itemActive: {
    backgroundColor: colors.accentMuted,
  },
  /** Barra del ítem activo. Un solo uso: no hay token de 3 px. */
  activeBar: {
    position: 'absolute',
    left: 0,
    top: SPACING.sm,
    bottom: SPACING.sm,
    width: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  itemHover: {
    backgroundColor: colors.bg,
  },
  iconWrap: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconWrapCollapsed: {
    width: MIN_TOUCH,
  },
  label: {
    ...typography.nav,
    color: colors.textSecondary,
    marginLeft: 6,
    flex: 1,
  },
  labelModulo: {
    color: colors.textStrong,
    fontWeight: typography.cuerpo.fontWeight,
  },
  labelActiveModulo: {
    color: colors.accent,
    fontWeight: typography.nav.fontWeight,
  },
  /** Texto de Favoritos. Un solo uso: no hay token de ese rosa. */
  labelFavoritos: {
    color: '#be185d',
  },
  favGlowWrap: {
    marginHorizontal: 4,
    marginVertical: 2,
  },
  favGlowWrapCollapsed: {
    marginHorizontal: 2,
    alignSelf: 'center',
  },
  itemFavoritos: {
    marginHorizontal: 0,
    marginVertical: 0,
  },
});
