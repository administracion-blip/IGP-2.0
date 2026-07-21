import { useEffect, useRef, type ReactNode } from 'react';
import { View, StyleSheet, Animated, Easing, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

const RAINBOW = ['#22d3ee', '#a78bfa', '#fde047', '#f472b6', '#38bdf8', '#22d3ee'];

type Props = {
  children: ReactNode;
  borderRadius?: number;
  borderWidth?: number;
  /** Colores del gradiente que recorre el borde. Por defecto arcoíris. */
  colors?: string[];
  /** Color del resplandor exterior (boxShadow en web). */
  glowColor?: string;
  /** Fondo del recuadro interior (detrás del contenido). */
  innerBackground?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Borde animado tipo haz de luz / láser recorriendo el perímetro.
 * Web, móvil y tablet (gradiente rotatorio recortado por overflow).
 */
export function LaserBorderWrap({
  children,
  borderRadius = 8,
  borderWidth = 2,
  colors,
  glowColor = 'rgba(56, 189, 248, 0.35)',
  innerBackground = '#fbbf24',
  style,
}: Props) {
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 2800,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const beamSize = 220;
  const gradientColors = (colors && colors.length >= 2 ? colors : RAINBOW) as [string, string, ...string[]];
  const gradientLocations =
    gradientColors === RAINBOW ? [0, 0.2, 0.45, 0.65, 0.85, 1] : undefined;

  return (
    <View
      style={[
        styles.wrap,
        { borderRadius, padding: borderWidth },
        Platform.OS === 'web' ? ({ boxShadow: `0 0 10px ${glowColor}` } as object) : null,
        style,
      ]}
    >
      <Animated.View
        style={[
          styles.beam,
          {
            width: beamSize,
            height: beamSize,
            marginLeft: -beamSize / 2,
            marginTop: -beamSize / 2,
            transform: [{ rotate }],
          },
        ]}
      >
        <LinearGradient
          colors={gradientColors}
          locations={gradientLocations}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      <View
        style={[
          styles.inner,
          { borderRadius: Math.max(0, borderRadius - borderWidth), backgroundColor: innerBackground },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: 'hidden',
    position: 'relative',
  },
  beam: {
    position: 'absolute',
    left: '50%',
    top: '50%',
  },
  inner: {
    overflow: 'hidden',
  },
});
