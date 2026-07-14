import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { Acuerdo } from '../types/acuerdo';
import type { UseAcuerdoNotasReturn } from '../hooks/useAcuerdoNotas';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { NotasTimeline } from './NotasTimeline';

type Props = {
  notas: UseAcuerdoNotasReturn;
  seleccionado: Acuerdo | null;
  puedeEditar?: boolean;
};

/**
 * Modal flotante con timeline de notas (más reciente arriba) y formulario para añadir.
 */
export function AcuerdoNotasModal({ notas, seleccionado, puedeEditar = true }: Props) {
  const { shouldStackPanels } = useBreakpoint();
  const { height: winH } = useWindowDimensions();
  const {
    visible,
    nuevaNota,
    setNuevaNota,
    error,
    guardando,
    lineas,
    cerrar,
    añadirNota,
  } = notas;

  const fullScreen = shouldStackPanels;

  return (
    <Modal visible={visible} transparent={!fullScreen} animationType="fade" onRequestClose={cerrar}>
      <Pressable
        style={[styles.overlay, fullScreen && styles.overlayFull]}
        onPress={(e) => {
          if (e.target === e.currentTarget) cerrar();
        }}
      >
        <View
          style={[
            styles.card,
            fullScreen && styles.cardFull,
            !fullScreen && { maxHeight: Platform.OS === 'web' ? ('85vh' as unknown as number) : winH * 0.85 },
          ]}
        >
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Historial de notas</Text>
              {seleccionado ? (
                <Text style={styles.subtitle}>
                  {seleccionado.Marca || seleccionado.Nombre || seleccionado.PK}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={cerrar} style={styles.closeBtn} disabled={guardando}>
              <MaterialIcons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.timelineScroll}
            contentContainerStyle={styles.timelineContent}
            keyboardShouldPersistTaps="handled"
          >
            <NotasTimeline items={lineas} />
          </ScrollView>

          {puedeEditar ? (
            <View style={styles.footer}>
              <TextInput
                style={styles.input}
                multiline
                value={nuevaNota}
                onChangeText={setNuevaNota}
                placeholder="Escribe una nueva nota…"
                placeholderTextColor="#94a3b8"
                editable={!guardando}
                textAlignVertical="top"
              />
              <Text style={styles.hint}>La fecha de hoy se añade automáticamente al guardar.</Text>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <View style={styles.actions}>
                <TouchableOpacity style={styles.btnGhost} onPress={cerrar} disabled={guardando}>
                  <Text style={styles.btnGhostText}>Cerrar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btnPrimary, (!nuevaNota.trim() || guardando) && styles.btnDisabled]}
                  onPress={añadirNota}
                  disabled={!nuevaNota.trim() || guardando}
                >
                  {guardando ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <MaterialIcons name="add" size={18} color="#fff" />
                      <Text style={styles.btnPrimaryText}>Añadir nota</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <View style={styles.footer}>
              <TouchableOpacity style={styles.btnGhost} onPress={cerrar}>
                <Text style={styles.btnGhostText}>Cerrar</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  overlayFull: {
    padding: 0,
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    width: '100%',
    maxWidth: 520,
    overflow: 'hidden',
    flexDirection: 'column',
  },
  cardFull: {
    maxWidth: '100%',
    maxHeight: '100%',
    flex: 1,
    borderRadius: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  closeBtn: { padding: 4 },
  title: { fontSize: 16, fontWeight: '700', color: '#1e293b' },
  subtitle: { fontSize: 12, color: '#64748b', marginTop: 2 },
  timelineScroll: { flexGrow: 1, flexShrink: 1 },
  timelineContent: { paddingHorizontal: 20, paddingVertical: 12 },
  footer: {
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: '#f8fafc',
  },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#334155',
    backgroundColor: '#fff',
    minHeight: 72,
    maxHeight: 120,
  },
  hint: { fontSize: 11, color: '#94a3b8', marginTop: 6 },
  error: { fontSize: 12, color: '#dc2626', marginTop: 6 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  btnGhost: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  btnGhostText: { fontSize: 14, fontWeight: '600', color: '#475569' },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: '#6366f1',
    minWidth: 130,
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  btnPrimaryText: { fontSize: 14, fontWeight: '600', color: '#fff' },
});
