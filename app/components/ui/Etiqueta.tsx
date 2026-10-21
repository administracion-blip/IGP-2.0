import { StyleSheet, Text, View } from 'react-native';
import { fontFamily, fontSizes, radius, statusColors, typography, SPACING } from '../../constants/theme';

type Tono = keyof typeof statusColors;

type Props = {
  texto: string;
  tono?: Tono;
};

export function Etiqueta({ texto, tono = 'neutral' }: Props) {
  const paleta = statusColors[tono];
  return (
    <View style={[styles.base, { backgroundColor: paleta.bg }]}>
      <Text style={[styles.texto, { color: paleta.text }]} numberOfLines={1}>
        {texto}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  texto: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes.badge,
    fontWeight: typography.boton.fontWeight,
  },
});
