import { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Pressable,
  StyleSheet,
} from 'react-native';

export type ConfirmarOpciones = {
  confirmarLabel?: string;
  cancelarLabel?: string;
  variant?: 'default' | 'danger';
};

type ConfirmarState = {
  titulo: string;
  mensaje: string;
  confirmarLabel: string;
  cancelarLabel: string;
  variant: 'default' | 'danger';
};

/**
 * Modal de confirmación in-app (web/tablet/móvil).
 * Sustituye window.confirm / Alert.alert para feedback coherente con IGP.
 */
export function useConfirmar() {
  const [state, setState] = useState<ConfirmarState | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const confirmar = useCallback(
    (titulo: string, mensaje: string, opciones?: ConfirmarOpciones): Promise<boolean> =>
      new Promise((resolve) => {
        resolverRef.current = resolve;
        setState({
          titulo,
          mensaje,
          confirmarLabel: opciones?.confirmarLabel ?? 'Confirmar',
          cancelarLabel: opciones?.cancelarLabel ?? 'Cancelar',
          variant: opciones?.variant ?? 'default',
        });
      }),
    [],
  );

  const cerrar = useCallback((ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setState(null);
  }, []);

  const ConfirmarView = state ? (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => cerrar(false)}
    >
      <Pressable style={styles.overlay} onPress={() => cerrar(false)}>
        <Pressable style={styles.box} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.titulo}>{state.titulo}</Text>
          <Text style={styles.mensaje}>{state.mensaje}</Text>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.btnCancel} onPress={() => cerrar(false)}>
              <Text style={styles.btnCancelText}>{state.cancelarLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={state.variant === 'danger' ? styles.btnDanger : styles.btnConfirm}
              onPress={() => cerrar(true)}
            >
              <Text style={styles.btnConfirmText}>{state.confirmarLabel}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  ) : null;

  return { confirmar, ConfirmarView };
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  box: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    maxWidth: 420,
    width: '100%',
  },
  titulo: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 8,
  },
  mensaje: {
    fontSize: 14,
    color: '#475569',
    lineHeight: 20,
    marginBottom: 20,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  btnCancel: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
  },
  btnCancelText: {
    color: '#475569',
    fontWeight: '600',
    fontSize: 14,
  },
  btnConfirm: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  btnDanger: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#dc2626',
  },
  btnConfirmText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
});
