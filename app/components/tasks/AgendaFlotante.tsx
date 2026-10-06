/**
 * Agenda de la cabecera: el mismo calendario de inicio, en un panel, para
 * consultar o apuntar sin salir de la pantalla actual.
 */
import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { BotonIconoCabecera } from '../ui/BotonIconoCabecera';
import { MIN_TOUCH } from '../../constants/layout';
import { colors, radius, shadowCard, SPACING, typography } from '../../constants/theme';
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
              <Text style={styles.panelTitulo}>Agenda</Text>
              <TouchableOpacity onPress={cerrar} style={styles.cerrarBtn} accessibilityLabel="Cerrar agenda">
                <MaterialIcons name="close" size={20} color={colors.textSecondary} />
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
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.sm,
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
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadowCard(),
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
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  panelTitulo: {
    ...typography.subtitulo,
    fontSize: 15,
  },
  cerrarBtn: {
    minWidth: MIN_TOUCH - 8,
    minHeight: MIN_TOUCH - 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cuerpo: { flex: 1, minHeight: 0 },
});
