import { View, Text, StyleSheet } from 'react-native';
import type { AlbaranFaltante } from '../../types/albaranesFaltantes';
import { estadoLabelFila } from '../../lib/albaranesFaltantes';

const TONOS = {
  pendiente: { bg: '#fef3c7', text: '#b45309' },
  otra: { bg: '#ffedd5', text: '#c2410c' },
  resuelta: { bg: '#dcfce7', text: '#15803d' },
} as const;

/** Pastilla de estado: Pendiente (ámbar), En otra empresa (naranja), Resuelta (verde). */
export function PastillaAlbaranFaltante({
  estado,
  resueltaPor,
  enOtraEmpresa,
}: {
  estado: AlbaranFaltante['estado'];
  resueltaPor: AlbaranFaltante['resuelta_por'];
  enOtraEmpresa: AlbaranFaltante['en_otra_empresa'];
}) {
  const tono = estado === 'resuelta' ? TONOS.resuelta : enOtraEmpresa ? TONOS.otra : TONOS.pendiente;
  return (
    <View style={[styles.pill, { backgroundColor: tono.bg }]}>
      <Text style={[styles.pillText, { color: tono.text }]} numberOfLines={1}>
        {estadoLabelFila({ estado, resueltaPor, enOtraEmpresa })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, alignSelf: 'flex-start', maxWidth: 260 },
  pillText: { fontSize: 11, fontWeight: '700' },
});
