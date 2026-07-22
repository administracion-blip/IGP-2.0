import { useEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, Animated, Easing, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { radius } from '../../constants/theme';

export type SoftPulsePreset = 'favoritos' | 'ia';

const PRESETS: Record<
  SoftPulsePreset,
  { border: string; pulseFrom: string; pulseTo: string; glow: string; shadow: string }
> = {
  favoritos: {
    border: '#fbcfe8',
    pulseFrom: 'rgba(251, 207, 232, 0.35)',
    pulseTo: 'rgba(244, 114, 182, 0.95)',
    glow: 'rgba(251, 207, 232, 0.65)',
    shadow: '#f9a8d4',
  },
  ia: {
    border: '#fde68a',
    pulseFrom: 'rgba(254, 243, 199, 0.35)',
    pulseTo: 'rgba(245, 158, 11, 0.85)',
    glow: 'rgba(253, 224, 138, 0.65)',
    shadow: '#fcd34d',
  },
};

type Props = {
  children: ReactNode;
  preset?: SoftPulsePreset;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
};

/** Borde parpadeante suave (mismo efecto que Favoritos en sidebar). */
export function SoftPulseBorderWrap({
  children,
  preset = 'favoritos',
  borderRadius = radius.sm,
  style,
}: Props) {
  const theme = PRESETS[preset];
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
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
  }, [pulse]);

  const borderColor = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [theme.pulseFrom, theme.pulseTo],
  });

  const shadowOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.15, 0.45],
  });

  return (
    <Animated.View
      style={[
        styles.wrap,
        { borderRadius, borderColor },
        Platform.OS !== 'web'
          ? {
              shadowOpacity,
              shadowColor: theme.shadow,
              shadowOffset: { width: 0, height: 0 },
              shadowRadius: 8,
              elevation: 3,
            }
          : ({ boxShadow: `0 0 10px ${theme.glow}` } as object),
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1.5,
    borderColor: PRESETS.favoritos.border,
  },
});
