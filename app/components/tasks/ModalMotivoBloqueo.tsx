/**
 * Motivo del bloqueo de una tarea. El backend rechaza con `400` un bloqueo sin
 * motivo, así que aquí se exige antes de llamar.
 */
import { useEffect, useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { estilosFormTasks as form, estilosModalTasks as modal } from './estilosTasks';

export function ModalMotivoBloqueo({
  visible,
  titulo,
  guardando = false,
  error = null,
  onCancelar,
  onConfirmar,
}: {
  visible: boolean;
  /** Título de la tarea que se va a bloquear, para no bloquear a ciegas. */
  titulo?: string;
  guardando?: boolean;
  error?: string | null;
  onCancelar: () => void;
  onConfirmar: (motivo: string) => void;
}) {
  const { isCompact } = useBreakpoint();
  const [motivo, setMotivo] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setMotivo('');
      setAviso(null);
    }
  }, [visible]);

  function confirmar() {
    const texto = motivo.trim();
    if (!texto) {
      setAviso('Indica el motivo del bloqueo');
      return;
    }
    setAviso(null);
    onConfirmar(texto);
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancelar}>
      <Pressable style={modal.overlay}>
        <Pressable style={modal.confirmCard}>
          <MaterialIcons name="block" size={32} color="#d97706" style={modal.confirmIcono} />
          <Text style={modal.confirmTitle}>Bloquear la tarea</Text>
          {titulo ? (
            <Text style={modal.confirmText}>
              <Text style={modal.confirmDestacado}>{titulo}</Text> quedará bloqueada hasta que alguien
              la desbloquee.
            </Text>
          ) : null}
          <View style={styles.campo}>
            <Text style={form.label}>Motivo *</Text>
            <TextInput
              style={[form.input, form.inputMultilinea]}
              value={motivo}
              onChangeText={setMotivo}
              placeholder="¿Qué impide avanzar?"
              placeholderTextColor="#94a3b8"
              multiline
              editable={!guardando}
              autoFocus
            />
          </View>
          {aviso || error ? <Text style={modal.error}>{aviso ?? error}</Text> : null}
          <View style={modal.confirmBotones}>
            <TouchableOpacity
              style={[modal.btn, isCompact && modal.btnTactil]}
              onPress={onCancelar}
              disabled={guardando}
            >
              <Text style={modal.btnText}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[modal.btn, modal.btnPeligro, isCompact && modal.btnTactil]}
              onPress={confirmar}
              disabled={guardando}
            >
              {guardando ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text style={modal.btnTextPeligro}>Bloquear</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  campo: { width: '100%' },
});
