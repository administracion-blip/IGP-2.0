import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, View, StyleSheet, Platform, type View as ViewType } from 'react-native';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { colores, radios, sombraMenu } from './tokens';

export type AnclaMenu = { x: number; y: number; w: number; h: number };

export function useAnclaMenu() {
  const ref = useRef<ViewType>(null);
  const [abierto, setAbierto] = useState(false);
  const [ancla, setAncla] = useState<AnclaMenu | null>(null);

  const abrir = useCallback(() => {
    const node = ref.current;
    if (!node?.measureInWindow) {
      setAbierto(true);
      return;
    }
    node.measureInWindow((x, y, w, h) => {
      setAncla({ x, y, w, h });
      setAbierto(true);
    });
  }, []);

  const cerrar = useCallback(() => setAbierto(false), []);

  const toggle = useCallback(() => {
    if (abierto) cerrar();
    else abrir();
  }, [abierto, abrir, cerrar]);

  return { ref, abierto, ancla, abrir, cerrar, toggle };
}

type Props = {
  visible: boolean;
  ancla: AnclaMenu | null;
  onClose: () => void;
  ancho?: number;
  children: ReactNode;
};

/**
 * Menú flotante anclado al control, en un Modal para quedar por encima del
 * scroll y del sidebar. Sombra solo aquí (hoja flotante).
 */
export function MenuAnclado({ visible, ancla, onClose, ancho = 300, children }: Props) {
  const { width, height } = useBreakpoint();
  if (!visible || !ancla) return null;

  const menuW = Math.min(ancho, Math.max(160, width - 16));
  let left = ancla.x;
  if (left + menuW > width - 8) left = Math.max(8, width - menuW - 8);

  const debajo = height - (ancla.y + ancla.h);
  const abrirArriba = debajo < 260 && ancla.y > debajo;
  const maxAlto = Math.min(440, Math.max(160, (abrirArriba ? ancla.y : debajo) - 16));
  const top = abrirArriba ? undefined : ancla.y + ancla.h + 4;
  const bottom = abrirArriba ? height - ancla.y + 4 : undefined;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.raiz} pointerEvents="box-none">
        <Pressable style={styles.fondo} onPress={onClose} accessibilityLabel="Cerrar menú" />
        <View
          style={[
            styles.menu,
            { width: menuW, maxHeight: maxAlto, left, top, bottom },
          ]}
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1 },
  fondo: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 80,
    ...(Platform.OS === 'web' ? ({ cursor: 'default' } as object) : null),
  },
  menu: {
    position: 'absolute',
    zIndex: 81,
    backgroundColor: colores.superficie,
    borderRadius: radios.superficie,
    borderWidth: 1,
    borderColor: colores.borde,
    overflow: 'hidden',
    ...sombraMenu,
    ...(Platform.OS !== 'web' ? { elevation: 12 } : null),
  },
});
