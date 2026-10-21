import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, type DimensionValue } from 'react-native';
import { colors, duration, radius, MIN_TOUCH } from '../../constants/theme';

type Props = {
  ancho?: DimensionValue;
  alto?: number;
  radio?: number;
};

export function Skeleton({ ancho = '100%', alto = MIN_TOUCH, radio = radius.md }: Props) {
  const opacidad = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulso = Animated.loop(
      Animated.sequence([
        Animated.timing(opacidad, {
          // Un solo uso: el hueso baja a esta opacidad; no hay token de opacidad.
          toValue: 0.45,
          duration: duration.normal * 4,
          useNativeDriver: true,
        }),
        Animated.timing(opacidad, {
          toValue: 1,
          duration: duration.normal * 4,
          useNativeDriver: true,
        }),
      ])
    );
    pulso.start();
    return () => pulso.stop();
  }, [opacidad]);

  return (
    <Animated.View
      accessibilityRole="progressbar"
      style={[styles.base, { width: ancho, height: alto, borderRadius: radio, opacity: opacidad }]}
    />
  );
}

const styles = StyleSheet.create({
  base: { backgroundColor: colors.border },
});
