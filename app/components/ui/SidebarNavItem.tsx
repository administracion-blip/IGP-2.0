import type { ComponentProps } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors, iconSize, MIN_TOUCH, radius, sidebar, typography } from '../../constants/theme';
import { SoftPulseBorderWrap } from './SoftPulseBorderWrap';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

const FAV_PINK = '#f9a8d4';
/** Texto de módulos inactivos. */
const MODULO_NAV_COLOR = '#0f172a';
const MODULO_ICON_IDLE = '#94a3b8';
const MODULO_ACTIVE_BG = '#e0f2fe';
const MODULO_ACTIVE_FG = '#0369a1';
const MODULO_HOVER_BG = '#f8fafc';

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
  const iconColor = accentFavoritos
    ? FAV_PINK
    : active
      ? MODULO_ACTIVE_FG
      : MODULO_ICON_IDLE;
  const textWeight = accentFavoritos ? (active ? '600' : typography.nav.fontWeight) : '400';

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
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: sidebar.itemHeight,
    marginHorizontal: 6,
    marginVertical: 1,
    paddingHorizontal: 8,
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
    backgroundColor: MODULO_ACTIVE_BG,
  },
  itemHover: {
    backgroundColor: MODULO_HOVER_BG,
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
    color: MODULO_NAV_COLOR,
    fontWeight: '400',
  },
  labelActiveModulo: {
    color: MODULO_ACTIVE_FG,
    fontWeight: '500',
  },
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
