import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  TouchableOpacity,
  Alert,
  Platform,
  ScrollView,
} from 'react-native';

const IS_WEB = Platform.OS === 'web';

type DialogState = {
  type: 'alert' | 'confirm';
  titulo: string;
  mensaje: string;
  errores?: string[];
  confirmLabel?: string;
  destructive?: boolean;
};

export function useAppDialog() {
  const [state, setState] = useState<DialogState | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const cerrar = useCallback((result?: boolean) => {
    if (resolverRef.current) {
      resolverRef.current(result ?? false);
      resolverRef.current = null;
    }
    setState(null);
  }, []);

  const aviso = useCallback((mensaje: string, titulo = 'Operación') => {
    if (!IS_WEB) {
      Alert.alert(titulo, mensaje);
      return;
    }
    setState({ type: 'alert', titulo, mensaje });
  }, []);

  const avisoErrores = useCallback((titulo: string, errores: string[]) => {
    if (!IS_WEB) {
      Alert.alert(titulo, errores.map((e) => `• ${e}`).join('\n'));
      return;
    }
    setState({ type: 'alert', titulo, mensaje: '', errores });
  }, []);

  const confirmar = useCallback((
    titulo: string,
    mensaje: string,
    opts?: { confirmLabel?: string; destructive?: boolean; errores?: string[] },
  ): Promise<boolean> => {
    const errores = opts?.errores?.length ? opts.errores : undefined;
    const mensajeNativo = errores?.length
      ? [mensaje, '', ...errores.map((e) => `• ${e}`)].filter(Boolean).join('\n')
      : mensaje;
    if (!IS_WEB) {
      return new Promise((resolve) => {
        Alert.alert(titulo, mensajeNativo, [
          { text: 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
          {
            text: opts?.confirmLabel || 'Confirmar',
            style: opts?.destructive ? 'destructive' : 'default',
            onPress: () => resolve(true),
          },
        ]);
      });
    }
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setState({
        type: 'confirm',
        titulo,
        mensaje,
        errores,
        confirmLabel: opts?.confirmLabel,
        destructive: opts?.destructive,
      });
    });
  }, []);

  const esConfirm = state?.type === 'confirm';
  const btnConfirmBg = state?.destructive ? '#ef4444' : '#0ea5e9';

  /**
   * Nodo del diálogo (web).
   * Se renderiza como `{dialog}` para que el Modal no se desmonte al cerrar
   * (evita overlays fantasma en RN Web que bloquean la flecha atrás y otros clics).
   */
  const dialog: ReactNode = !IS_WEB ? null : (
    <Modal
      visible={Boolean(state)}
      transparent
      animationType="fade"
      onRequestClose={() => cerrar(false)}
    >
      <View style={styles.overlay}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => cerrar(false)}
          accessibilityRole="button"
          accessibilityLabel="Cerrar diálogo"
        />
        {state ? (
          <View style={styles.card} accessibilityViewIsModal>
            <Text style={styles.titulo}>{state.titulo}</Text>
            {state.mensaje ? <Text style={styles.mensaje}>{state.mensaje}</Text> : null}
            {state.errores?.length ? (
              <ScrollView style={styles.erroresScroll} nestedScrollEnabled>
                {state.errores.map((e, i) => (
                  <View key={i} style={styles.errorRow}>
                    <Text style={styles.errorBullet}>•</Text>
                    <Text style={styles.errorText}>{e}</Text>
                  </View>
                ))}
              </ScrollView>
            ) : null}
            <View style={styles.actions}>
              {esConfirm ? (
                <>
                  <TouchableOpacity style={styles.btnCancel} onPress={() => cerrar(false)}>
                    <Text style={styles.btnCancelText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btnConfirm, { backgroundColor: btnConfirmBg }]}
                    onPress={() => cerrar(true)}
                  >
                    <Text style={styles.btnConfirmText}>{state.confirmLabel || 'Confirmar'}</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity
                  style={[styles.btnConfirm, { backgroundColor: '#0ea5e9' }]}
                  onPress={() => cerrar()}
                >
                  <Text style={styles.btnConfirmText}>Aceptar</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );

  /** @deprecated Preferir `{dialog}` para no desmontar el Modal. */
  const DialogHost = useCallback(() => dialog, [dialog]);

  return { aviso, avisoErrores, confirmar, dialog, DialogHost };
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    maxWidth: 420,
    width: '100%',
    maxHeight: '80%',
    zIndex: 1,
  },
  titulo: { fontSize: 17, fontWeight: '700', color: '#0f172a', marginBottom: 10 },
  mensaje: { fontSize: 14, color: '#64748b', marginBottom: 12, lineHeight: 20 },
  erroresScroll: { maxHeight: 240, marginBottom: 16 },
  errorRow: { flexDirection: 'row', gap: 6, marginBottom: 6, alignItems: 'flex-start' },
  errorBullet: { fontSize: 14, color: '#dc2626', lineHeight: 20 },
  errorText: { flex: 1, fontSize: 14, color: '#334155', lineHeight: 20 },
  actions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  btnCancel: {
    paddingVertical: 9,
    paddingHorizontal: 18,
    backgroundColor: '#e2e8f0',
    borderRadius: 8,
  },
  btnCancelText: { fontSize: 14, fontWeight: '600', color: '#475569' },
  btnConfirm: {
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  btnConfirmText: { fontSize: 14, fontWeight: '600', color: '#fff' },
});
