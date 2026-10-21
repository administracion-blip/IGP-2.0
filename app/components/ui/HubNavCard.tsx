import type { ComponentProps, ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

type IconName = ComponentProps<typeof MaterialIcons>['name'];

export type HubNavCardProps = {
  label: string;
  description?: string;
  icon: IconName;
  accentBg?: string;
  accentFg?: string;
  /** Tarjeta naranja (p. ej. Preparar pedidos). */
  variant?: 'default' | 'accent';
  width?: `${number}%` | '100%';
  compact?: boolean;
  disabled?: boolean;
  onPress: () => void;
  /** Contenido entre texto y chevron (p. ej. estrella favorito). */
  trailing?: ReactNode;
  showChevron?: boolean;
  badgeCount?: number;
  style?: StyleProp<ViewStyle>;
};

export function HubNavGrid({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.grid, style]}>{children}</View>;
}

export function HubNavCard({
  label,
  description,
  icon,
  accentBg = colors.accentMuted,
  accentFg = colors.accent,
  variant = 'default',
  width,
  compact = false,
  disabled = false,
  onPress,
  trailing,
  showChevron = true,
  badgeCount,
  style,
}: HubNavCardProps) {
  const isAccent = variant === 'accent';
  const iconBg = isAccent ? '#ffedd5' : accentBg;
  const iconFg = isAccent ? '#c2410c' : accentFg;
  const iconSize = compact ? 22 : 26;

  return (
    <TouchableOpacity
      style={[
        styles.card,
        isAccent && styles.cardAccent,
        compact && styles.cardCompact,
        width != null && { width },
        { minHeight: compact ? MIN_TOUCH + 8 : MIN_TOUCH + 24 },
        disabled && styles.cardDisabled,
        style,
      ]}
      onPress={onPress}
      activeOpacity={disabled ? 1 : 0.75}
      disabled={disabled}
      accessibilityLabel={description ? `${label}. ${description}` : label}
    >
      <View style={[styles.iconWrap, compact && styles.iconWrapCompact, { backgroundColor: iconBg }]}>
        <MaterialIcons name={icon} size={iconSize} color={iconFg} />
        {badgeCount != null && badgeCount > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badgeCount > 9 ? '9+' : badgeCount}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, compact && styles.titleCompact, isAccent && styles.titleAccent]} numberOfLines={1}>
          {label}
        </Text>
        {description ? (
          <Text
            style={[styles.desc, compact && styles.descCompact, isAccent && styles.descAccent]}
            numberOfLines={compact ? 1 : 2}
          >
            {description}
          </Text>
        ) : null}
      </View>
      {trailing}
      {showChevron ? (
        <MaterialIcons name="chevron-right" size={compact ? 20 : 22} color={colors.borderStrong} />
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14, // sin token: entre SPACING.md (12) y SPACING.lg (16)
    backgroundColor: colors.surface,
    borderRadius: RADIO_MEDIO,
    padding: SPACING.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardAccent: {
    backgroundColor: statusColors.warning.bg,
    borderColor: '#fde68a', // borde ámbar, sin token
  },
  cardCompact: {
    gap: 10, // sin token
    padding: SPACING.md,
    borderRadius: RADIO_MEDIO,
  },
  cardDisabled: {
    opacity: 0.45,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    position: 'relative',
  },
  iconWrapCompact: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: radius.pill,
    backgroundColor: statusColors.danger.bg,
    borderWidth: 1,
    borderColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xs,
  },
  badgeText: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes.badge,
    fontWeight: typography.boton.fontWeight,
    color: colors.danger,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[16],
    fontWeight: typography.boton.fontWeight,
    lineHeight: 20,
    color: colors.textStrong,
    marginBottom: 2,
  },
  titleCompact: {
    fontSize: fontSizes[14],
    marginBottom: 1,
  },
  titleAccent: {
    color: colors.textStrong,
  },
  desc: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[13],
    color: colors.textMuted,
    lineHeight: 18,
  },
  descCompact: {
    fontSize: fontSizes[12],
    lineHeight: 16,
  },
  descAccent: {
    color: colors.textMuted,
  },
});
