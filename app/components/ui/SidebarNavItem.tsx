import type { ComponentProps } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors, iconSize, MIN_TOUCH, radius, sidebar, typography } from '../../constants/theme';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

type Props = {
  label: string;
  icon: IconName;
  active?: boolean;
  collapsed?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
};

/**
 * Ítem de navegación lateral. Iconos slate; activo con fondo sutil (no azul).
 */
export function SidebarNavItem({
  label,
  icon,
  active = false,
  collapsed = false,
  onPress,
  accessibilityLabel,
}: Props) {
  const iconColor = active ? colors.textPrimary : colors.textSecondary;
  const textWeight = active ? '600' : typography.nav.fontWeight;

  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.item,
        collapsed && styles.itemCollapsed,
        active && styles.itemActive,
        pressed && !active && styles.itemPressed,
        pressed && active && styles.itemActivePressed,
      ]}
    >
      <View style={[styles.iconWrap, collapsed && styles.iconWrapCollapsed]}>
        <MaterialIcons name={icon} size={iconSize.nav} color={iconColor} />
      </View>
      {!collapsed ? (
        <Text
          style={[
            styles.label,
            { fontWeight: textWeight },
            active && styles.labelActive,
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      ) : null}
    </Pressable>
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
    backgroundColor: colors.navActive,
  },
  itemPressed: {
    backgroundColor: colors.navPressed,
  },
  itemActivePressed: {
    backgroundColor: colors.border,
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
  labelActive: {
    color: colors.textPrimary,
  },
});
