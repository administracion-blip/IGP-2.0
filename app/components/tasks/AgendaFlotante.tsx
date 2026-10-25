/**
 * Agenda de la cabecera: el mismo calendario de inicio, en un panel, para
 * consultar o apuntar sin salir de la pantalla actual.
 */
import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import * as Font from 'expo-font';
import { BotonIconoCabecera } from '../ui/BotonIconoCabecera';
import { MIN_TOUCH } from '../../constants/layout';
import { fontFamily } from '../../constants/theme';
import { tasksUi } from '../../constants/tasksUiTokens';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { CalendarioInicio } from '../CalendarioInicio';

export function AgendaFlotante() {
  const { isCompact } = useBreakpoint();
  const insets = useSafeAreaInsets();
  const [abierto, setAbierto] = useState(false);

  const cerrar = () => setAbierto(false);

  return (
    <>
      <BotonIconoCabecera nombre="calendar" etiqueta="Abrir agenda" onPress={() => setAbierto(true)} />

      <Modal visible={abierto} transparent animationType="fade" onRequestClose={cerrar}>
        <Pressable
          style={[styles.overlay, isCompact && styles.overlayPantalla]}
          onPress={cerrar}
        >
          <Pressable
            style={[
              styles.panel,
              isCompact && styles.panelPantalla,
              isCompact && { paddingTop: insets.top, paddingBottom: insets.bottom },
            ]}
            onPress={() => {}}
          >
            <View style={styles.panelHeader}>
              <Text style={[styles.panelTitulo, Font.isLoaded(fontFamily.semibold) && styles.panelTituloInter]}>
                Agenda
              </Text>
              <TouchableOpacity
                onPress={cerrar}
                style={[styles.cerrarBtn, isCompact && styles.cerrarBtnTactil]}
                accessibilityLabel="Cerrar agenda"
              >
                <MaterialIcons name="close" size={20} color={tasksUi.calendario.hoy} />
              </TouchableOpacity>
            </View>
            <View style={styles.cuerpo}>
              {abierto ? <CalendarioInicio embebido /> : null}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: tasksUi.color.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: tasksUi.space[2],
  },
  overlayPantalla: {
    paddingTop: 0,
    paddingRight: 0,
    paddingLeft: 0,
    paddingBottom: 0,
    alignItems: 'stretch',
  },
  panel: {
    width: '100%',
    maxWidth: 1040,
    height: '90%',
    maxHeight: '90%',
    backgroundColor: tasksUi.color.superficie,
    borderRadius: tasksUi.radius.contenedor,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    overflow: 'hidden',
    ...tasksUi.sombraFlotante,
  },
  panelPantalla: {
    flex: 1,
    width: '100%',
    maxWidth: '100%',
    height: '100%',
    maxHeight: '100%',
    borderRadius: 0,
    borderWidth: 0,
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: tasksUi.space[4],
    paddingVertical: tasksUi.space[2],
    borderBottomWidth: 1,
    borderBottomColor: tasksUi.color.bordeSutil,
    backgroundColor: tasksUi.color.superficie,
  },
  panelTitulo: {
    fontSize: 15,
    fontWeight: '600',
    color: tasksUi.calendario.hoy,
  },
  panelTituloInter: { fontFamily: fontFamily.semibold },
  cerrarBtn: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  cerrarBtnTactil: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH },
  cuerpo: { flex: 1, minHeight: 0 },
});
