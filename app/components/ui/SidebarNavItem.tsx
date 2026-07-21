import type { ComponentProps } from 'react';
import { useEffect, useRef } from 'react';
import { Pressable, Text, View, StyleSheet, Animated, Easing, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors, iconSize, MIN_TOUCH, radius, sidebar, typography } from '../../constants/theme';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

const FAV_PINK = '#f9a8d4';
const FAV_PINK_BORDER = '#fbcfe8';
const FAV_PINK_GLOW = 'rgba(251, 207, 232, 0.65)';

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
 * Ítem de navegación lateral. Iconos slate; activo con fondo sutil (no azul).
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
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!accentFavoritos) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [accentFavoritos, pulse]);

  const borderColor = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(251, 207, 232, 0.35)', 'rgba(244, 114, 182, 0.95)'],
  });

  const shadowOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.15, 0.45],
  });

  const iconColor = accentFavoritos
    ? FAV_PINK
    : active
      ? colors.textPrimary
      : colors.textSecondary;
  const textWeight = active ? '600' : typography.nav.fontWeight;

  const resolvedIcon = accentFavoritos ? 'star' : icon;

  const itemInner = (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.item,
        collapsed && styles.itemCollapsed,
        active && styles.itemActive,
        accentFavoritos && styles.itemFavoritos,
        pressed && !active && styles.itemPressed,
        pressed && active && styles.itemActivePressed,
      ]}
    >
      <View style={[styles.iconWrap, collapsed && styles.iconWrapCollapsed]}>
        <MaterialIcons name={resolvedIcon} size={iconSize.nav} color={iconColor} />
      </View>
      {!collapsed ? (
        <Text
          style={[
            styles.label,
            { fontWeight: textWeight },
            active && styles.labelActive,
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
    <Animated.View
      style={[
        styles.favGlowWrap,
        collapsed && styles.favGlowWrapCollapsed,
        { borderColor },
        Platform.OS !== 'web'
          ? { shadowOpacity, shadowColor: FAV_PINK, shadowOffset: { width: 0, height: 0 }, shadowRadius: 8, elevation: 3 }
          : ({ boxShadow: `0 0 10px ${FAV_PINK_GLOW}` } as object),
      ]}
    >
      {itemInner}
    </Animated.View>
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
  labelFavoritos: {
    color: '#be185d',
  },
  favGlowWrap: {
    marginHorizontal: 4,
    marginVertical: 2,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: FAV_PINK_BORDER,
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
