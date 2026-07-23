import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { getPrioridadLabel, getPrioridadPastel } from '../../lib/mantenimientoIncidenciaUi';

type Props = {
  prioridad?: string;
  compact?: boolean;
};

export function PrioridadIncidenciaBadge({ prioridad, compact }: Props) {
  const label = getPrioridadLabel(prioridad);
  if (label === '—') {
    return <Text style={styles.vacio}>—</Text>;
  }
  const pastel = getPrioridadPastel(prioridad);
  return (
    <View style={[styles.badge, { backgroundColor: pastel.bg }, compact && styles.badgeCompact]}>
      <MaterialIcons name={pastel.icon} size={compact ? 12 : 13} color={pastel.color} />
      <Text style={[styles.label, { color: pastel.color }, compact && styles.labelCompact]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 3,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 999,
  },
  badgeCompact: { paddingVertical: 1, paddingHorizontal: 5 },
  label: { fontSize: 11, fontWeight: '700' },
  labelCompact: { fontSize: 10 },
  vacio: { fontSize: 11, color: '#94a3b8' },
});
