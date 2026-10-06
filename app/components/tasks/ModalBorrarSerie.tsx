/**
 * Borrado de una ficha suelta o de una fecha dentro de una repetición.
 * En una serie pregunta si se borra solo esa fecha o también las posteriores.
 */
import { ActivityIndicator, Modal, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { estilosModalTasks as modal } from './estilosTasks';
import { useBreakpoint } from '../../hooks/useBreakpoint';

type Alcance = 'esta' | 'posteriores';

type Props = {
  visible: boolean;
  nombre: string;
  esSerie: boolean;
  detalleSinSerie: string;
  ocupado: boolean;
  error: string | null;
  onCerrar: () => void;
  onConfirmar: (alcance: Alcance) => void;
};

export function ModalBorrarSerie({
  visible,
  nombre,
  esSerie,
  detalleSinSerie,
  ocupado,
  error,
  onCerrar,
  onConfirmar,
}: Props) {
  const { isCompact } = useBreakpoint();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCerrar}>
      <Pressable style={modal.overlay} onPress={() => !ocupado && onCerrar()}>
        <Pressable style={modal.confirmCard}>
          <MaterialIcons name="warning" size={36} color="#d97706" style={modal.confirmIcono} />
          <Text style={modal.confirmTitle}>{esSerie ? 'Borrar una repetición' : 'Borrar'}</Text>
          <Text style={modal.confirmText}>
            <Text style={modal.confirmDestacado}>{nombre}</Text>
            {esSerie
              ? ' forma parte de una repetición. Las fechas anteriores se quedan.'
              : ` ${detalleSinSerie}`}
          </Text>
          {error ? <Text style={{ color: '#b91c1c', textAlign: 'center', fontSize: 13 }}>{error}</Text> : null}
          <View style={[modal.confirmBotones, { flexWrap: 'wrap' }]}>
            <TouchableOpacity
              style={[modal.btn, isCompact && modal.btnTactil]}
              onPress={onCerrar}
              disabled={ocupado}
            >
              <Text style={modal.btnText}>Cancelar</Text>
            </TouchableOpacity>
            {esSerie ? (
              <TouchableOpacity
                style={[modal.btn, modal.btnPeligro, isCompact && modal.btnTactil]}
                onPress={() => onConfirmar('posteriores')}
                disabled={ocupado}
              >
                <Text style={modal.btnTextPeligro}>Esta y las posteriores</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[modal.btn, modal.btnPeligro, isCompact && modal.btnTactil]}
              onPress={() => onConfirmar('esta')}
              disabled={ocupado}
            >
              {ocupado ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text style={modal.btnTextPeligro}>{esSerie ? 'Solo esta' : 'Borrar'}</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
