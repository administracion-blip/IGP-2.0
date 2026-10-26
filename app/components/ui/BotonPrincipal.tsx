import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { MIN_TOUCH, SPACING } from '../../constants/layout';
import { fontFamily, fontSizes, radius } from '../../constants/theme';

export type EstadoBotonPrincipal = 'idle' | 'enviando' | 'ok';
export type VarianteBotonPrincipal = 'principal' | 'flotante';

type Props = {
  titulo: string;
  onPress: () => void;
  /** Franja blanca que cruza el botón. Se apaga con «reducir movimiento». */
  brillo?: boolean;
  estado?: EstadoBotonPrincipal;
  /** `flotante`: botón redondo con anillo de pulso, para «Nuevo pedido». */
  variante?: VarianteBotonPrincipal;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

const ROSA = ['#ec4899', '#f43f5e'] as const;
const VERDE = ['#22c55e', '#16a34a'] as const;
const TAM_FAB = 56;
const RADIO_FAB = TAM_FAB / 2;

/**
 * Botón de acción principal (degradado rosa, resplandor, brillo y estados de envío).
 * La variante flotante es el FAB redondo. No cambia datos: solo presentación.
 */
export function BotonPrincipal({
  titulo,
  onPress,
  brillo = false,
  estado = 'idle',
  variante = 'principal',
  disabled = false,
  accessibilityLabel,
  style,
}: Props) {
  const flotante = variante === 'flotante';
  const bloqueado = disabled || estado === 'enviando' || estado === 'ok';
  const [reducir, setReducir] = useState(false);
  const [ancho, setAncho] = useState(0);

  const escala = useRef(new Animated.Value(1)).current;
  const brilloX = useRef(new Animated.Value(0)).current;
  const pulso = useRef(new Animated.Value(0)).current;
  const checkEscala = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let vivo = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((valor) => {
        if (vivo) setReducir(!!valor);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (valor) => {
      setReducir(!!valor);
    });
    return () => {
      vivo = false;
      sub.remove();
    };
  }, []);

  const mostrarBrillo = brillo && !reducir;
  const mostrarPulso = flotante && !reducir && estado !== 'ok';

  useEffect(() => {
    if (!mostrarBrillo) return;
    brilloX.setValue(0);
    const anim = Animated.loop(
      Animated.timing(brilloX, {
        toValue: 1,
        duration: 3000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [mostrarBrillo, brilloX]);

  useEffect(() => {
    if (!mostrarPulso) {
      pulso.setValue(0);
      return;
    }
    const anim = Animated.loop(
      Animated.timing(pulso, {
        toValue: 1,
        duration: 1400,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [mostrarPulso, pulso]);

  useEffect(() => {
    if (estado !== 'ok') {
      checkEscala.setValue(0);
      return;
    }
    if (reducir) {
      checkEscala.setValue(1);
      return;
    }
    checkEscala.setValue(0);
    const anim = Animated.sequence([
      Animated.spring(checkEscala, { toValue: 1.2, useNativeDriver: true, speed: 18, bounciness: 6 }),
      Animated.spring(checkEscala, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 4 }),
    ]);
    anim.start();
    return () => anim.stop();
  }, [estado, reducir, checkEscala]);

  const recorrido = brilloX.interpolate({
    inputRange: [0, 1],
    outputRange: [-(ancho + TAM_FAB), ancho + TAM_FAB],
  });
  const pulsoEscala = pulso.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const pulsoOpacidad = pulso.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] });

  const colores = estado === 'ok' ? VERDE : ROSA;
  const radio = flotante ? RADIO_FAB : radius.lg;
  const resplandor =
    Platform.OS === 'ios'
      ? {
          shadowColor: '#f43f5e',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.35,
          shadowRadius: 18,
        }
      : ({ boxShadow: '0 6px 18px rgba(244,63,94,.35)' } as object);

  const pulsar = () => {
    Animated.spring(escala, { toValue: 0.94, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  };
  const soltar = () => {
    Animated.spring(escala, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 6 }).start();
  };

  const etiqueta = estado === 'enviando' ? 'Enviando…' : titulo;

  let contenido = (
    <Text style={styles.texto}>{titulo}</Text>
  );
  if (estado === 'enviando') {
    contenido = (
      <View style={styles.fila}>
        <ActivityIndicator color="#ffffff" />
        {flotante ? null : <Text style={styles.texto}>Enviando…</Text>}
      </View>
    );
  } else if (estado === 'ok') {
    contenido = (
      <Animated.View style={{ transform: [{ scale: checkEscala }] }}>
        <MaterialIcons name="check" size={flotante ? 28 : 22} color="#ffffff" />
      </Animated.View>
    );
  } else if (flotante) {
    contenido = <MaterialIcons name="add" size={28} color="#ffffff" />;
  }

  return (
    <View
      style={[
        styles.envoltorio,
        flotante && styles.envoltorioFab,
        { backgroundColor: estado === 'ok' ? '#16a34a' : '#ec4899' },
        resplandor,
        disabled && estado === 'idle' && styles.off,
        style,
      ]}
    >
      {mostrarPulso ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.anillo,
            { opacity: pulsoOpacidad, transform: [{ scale: pulsoEscala }] },
          ]}
        />
      ) : null}
      <Animated.View style={{ transform: [{ scale: escala }] }}>
        <Pressable
          onPress={onPress}
          onPressIn={bloqueado ? undefined : pulsar}
          onPressOut={bloqueado ? undefined : soltar}
          disabled={bloqueado}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? etiqueta}
          accessibilityState={{ disabled: bloqueado, busy: estado === 'enviando' }}
          onLayout={(e) => {
            const siguiente = Math.round(e.nativeEvent.layout.width);
            setAncho((actual) => (actual === siguiente ? actual : siguiente));
          }}
        >
          <LinearGradient
            colors={colores}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[styles.cara, flotante ? styles.caraFab : null, { borderRadius: radio }]}
          >
            {mostrarBrillo ? (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.franja,
                  { transform: [{ translateX: recorrido }, { rotate: '-24deg' }] },
                ]}
              />
            ) : null}
            {contenido}
          </LinearGradient>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  envoltorio: {
    alignSelf: 'flex-start',
    borderRadius: radius.lg,
  },
  envoltorioFab: {
    width: TAM_FAB,
    height: TAM_FAB,
    borderRadius: RADIO_FAB,
    alignItems: 'center',
    justifyContent: 'center',
  },
  anillo: {
    position: 'absolute',
    width: TAM_FAB,
    height: TAM_FAB,
    borderRadius: RADIO_FAB,
    borderWidth: 2,
    borderColor: '#f43f5e',
    backgroundColor: 'transparent',
  },
  cara: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  caraFab: {
    width: TAM_FAB,
    height: TAM_FAB,
    paddingHorizontal: 0,
    paddingVertical: 0,
    borderRadius: RADIO_FAB,
  },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  texto: {
    color: '#ffffff',
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[14],
    fontWeight: '600',
  },
  franja: {
    position: 'absolute',
    top: -SPACING.xl,
    left: 0,
    width: 36,
    height: 96,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  off: { opacity: 0.5 },
});
