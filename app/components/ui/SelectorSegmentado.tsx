import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { MIN_TOUCH, SPACING } from '../../constants/layout';
import { fontFamily, fontSizes, radius } from '../../constants/theme';

const ROSA = ['#ec4899', '#f43f5e'] as const;
const AMBAR = ['#f59e0b', '#d97706'] as const;

export type OpcionSegmento = {
  id: string;
  titulo: string;
  icono?: keyof typeof MaterialIcons.glyphMap;
};

type Caja = { x: number; ancho: number };

type Props = {
  opciones: OpcionSegmento[];
  valorId: string;
  onCambiar: (id: string) => void;
  /** La pastilla pasa a ámbar. El selector no es un botón de acción. */
  tono?: 'rosa' | 'ambar';
  accessibilityLabel?: string;
};

/**
 * Dos o más opciones en una pista. La pastilla se desliza hasta la elegida.
 * Con «reducir movimiento» salta de sitio, sin animación.
 */
export function SelectorSegmentado({
  opciones,
  valorId,
  onCambiar,
  tono = 'rosa',
  accessibilityLabel,
}: Props) {
  const x = useRef(new Animated.Value(0)).current;
  const xInverso = useRef(Animated.multiply(x, -1)).current;
  const colocado = useRef(false);
  const [reducir, setReducir] = useState(false);
  const [cajas, setCajas] = useState<Caja[]>([]);
  const [anchoFila, setAnchoFila] = useState(0);

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

  const indice = Math.max(0, opciones.findIndex((opcion) => opcion.id === valorId));
  const caja = cajas[indice];

  useEffect(() => {
    if (!caja) return;
    if (reducir || !colocado.current) {
      x.setValue(caja.x);
      colocado.current = true;
      return;
    }
    const anim = Animated.timing(x, {
      toValue: caja.x,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [caja, reducir, x]);

  return (
    <View style={styles.pista} accessibilityRole="tablist" accessibilityLabel={accessibilityLabel}>
      <View
        style={styles.fila}
        onLayout={(e) => {
          const siguiente = Math.round(e.nativeEvent.layout.width);
          setAnchoFila((actual) => (actual === siguiente ? actual : siguiente));
        }}
      >
        {opciones.map((opcion, i) => {
          const activa = opcion.id === valorId;
          return (
            <Pressable
              key={opcion.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: activa }}
              accessibilityLabel={opcion.titulo}
              onPress={() => onCambiar(opcion.id)}
              onLayout={(e) => {
                const { x: origen, width } = e.nativeEvent.layout;
                const siguiente = { x: origen, ancho: Math.round(width) };
                setCajas((actual) => {
                  const previa = actual[i];
                  if (previa && previa.x === siguiente.x && previa.ancho === siguiente.ancho) return actual;
                  const copia = actual.slice();
                  copia[i] = siguiente;
                  return copia;
                });
              }}
              style={({ pressed }) => [styles.opcion, pressed && styles.opcionPulsada]}
            >
              {opcion.icono ? <MaterialIcons name={opcion.icono} size={18} color="#475569" /> : null}
              <Text style={[styles.texto, styles.textoPista]} numberOfLines={1}>
                {opcion.titulo}
              </Text>
            </Pressable>
          );
        })}
        {caja && caja.ancho > 0 && anchoFila > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.pastilla, { width: caja.ancho, transform: [{ translateX: x }] }]}
          >
            <LinearGradient
              colors={tono === 'ambar' ? AMBAR : ROSA}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <Animated.View
              style={[styles.rotuloBlanco, { width: anchoFila, transform: [{ translateX: xInverso }] }]}
            >
              {opciones.map((opcion) => (
                <View key={opcion.id} style={styles.opcion}>
                  {opcion.icono ? <MaterialIcons name={opcion.icono} size={18} color="#ffffff" /> : null}
                  <Text style={[styles.texto, styles.textoPastilla]} numberOfLines={1}>
                    {opcion.titulo}
                  </Text>
                </View>
              ))}
            </Animated.View>
          </Animated.View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pista: {
    alignSelf: 'stretch',
    backgroundColor: '#f1f5f9',
    borderRadius: radius.pill,
    padding: SPACING.xs,
  },
  fila: {
    flexDirection: 'row',
    position: 'relative',
  },
  pastilla: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  rotuloBlanco: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    flexDirection: 'row',
  },
  opcion: {
    flex: 1,
    minWidth: 0,
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.sm,
  },
  opcionPulsada: { opacity: 0.55 },
  texto: {
    flexShrink: 1,
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[14],
    fontWeight: '600',
  },
  textoPista: { color: '#475569' },
  textoPastilla: { color: '#ffffff' },
});
