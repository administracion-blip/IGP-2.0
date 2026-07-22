import type { ComponentProps, ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';

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
  accentBg = '#e0f2fe',
  accentFg = '#0ea5e9',
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
  const iconBg = isAccent ? '#fed7aa' : accentBg;
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
        <MaterialIcons name="chevron-right" size={compact ? 20 : 22} color="#cbd5e1" />
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  cardAccent: {
    backgroundColor: '#fffbeb',
    borderColor: '#fdba74',
  },
  cardCompact: {
    gap: 10,
    padding: 12,
    borderRadius: 10,
  },
  cardDisabled: {
    opacity: 0.45,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    position: 'relative',
  },
  iconWrapCompact: {
    width: 40,
    height: 40,
    borderRadius: 10,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#dc2626',
    borderWidth: 2,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#fff',
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 2,
  },
  titleCompact: {
    fontSize: 14,
    marginBottom: 1,
  },
  titleAccent: {
    color: '#0f172a',
  },
  desc: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
  },
  descCompact: {
    fontSize: 12,
    lineHeight: 16,
  },
  descAccent: {
    color: '#78716c',
  },
});
