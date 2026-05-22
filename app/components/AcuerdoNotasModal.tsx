import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { Acuerdo } from '../types/acuerdo';
import type { UseAcuerdoNotasReturn } from '../hooks/useAcuerdoNotas';
import { NOTAS_CONTENIDO_FONT_SIZE } from '../lib/acuerdoNotas';

type Props = {
  /** Bag completo devuelto por `useAcuerdoNotas`. */
  notas: UseAcuerdoNotasReturn;
  /** Acuerdo activo. Solo se usa para mostrar el subtítulo (Marca / Nombre / PK). */
  seleccionado: Acuerdo | null;
};

/**
 * Modal de edición de notas de un acuerdo.
 *
 * En web usa un `contentEditable` que mantiene el formato (fechas resaltadas);
 * en nativo usa un `TextInput` multiline con onKeyPress para Ctrl+espacio.
 * Toda la lógica vive en `useAcuerdoNotas`; este componente solo es vista.
 */
export function AcuerdoNotasModal({ notas, seleccionado }: Props) {
  const {
    visible,
    draft,
    setDraft,
    error,
    guardando,
    editorWebRef,
    cerrar,
    guardar,
    handleKeyPress,
    handleWebKeyDown,
  } = notas;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={cerrar}
    >
      <Pressable
        style={styles.overlay}
        onPress={(e) => {
          if (e.target === e.currentTarget) cerrar();
        }}
      >
        <View style={styles.card}>
          <Text style={styles.title}>Notas del acuerdo</Text>
          {seleccionado ? (
            <Text style={styles.subtitle}>
              {seleccionado.Marca || seleccionado.Nombre || seleccionado.PK}
            </Text>
          ) : null}
          {Platform.OS === 'web' ? (
            <>
              {/* eslint-disable-next-line react/no-unknown-property -- DOM web */}
              <div
                ref={editorWebRef}
                contentEditable={!guardando}
                suppressContentEditableWarning
                onInput={(e) => setDraft((e.target as HTMLDivElement).innerText)}
                onKeyDown={handleWebKeyDown}
                className="acuerdos-notas-editor"
                style={{
                  minHeight: 160,
                  maxHeight: 320,
                  overflow: 'auto',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: '#e2e8f0',
                  borderRadius: 8,
                  padding: 12,
                  fontSize: NOTAS_CONTENIDO_FONT_SIZE,
                  color: '#334155',
                  outline: 'none',
                  whiteSpace: 'pre-wrap',
                  backgroundColor: '#f8fafc',
                }}
              />
              <Text style={styles.hint}>
                Ctrl+espacio: inserta la fecha (azul, pequeña, negrita y cursiva), « - » y el cursor a la derecha para escribir.
              </Text>
            </>
          ) : (
            <>
              <TextInput
                style={styles.input}
                multiline
                value={draft}
                onChangeText={setDraft}
                placeholder="Observaciones… (Ctrl+espacio: fecha dd/mm/aaaa - y escribe después del guion)"
                placeholderTextColor="#94a3b8"
                editable={!guardando}
                textAlignVertical="top"
                onKeyPress={handleKeyPress}
              />
              <Text style={styles.hint}>
                Ctrl+espacio inserta la fecha, guion y espacio; escribe a continuación.
              </Text>
            </>
          )}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.btnGhost}
              onPress={cerrar}
              disabled={guardando}
            >
              <Text style={styles.btnGhostText}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.btnPrimary}
              onPress={guardar}
              disabled={guardando}
            >
              {guardando ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.btnPrimaryText}>Guardar</Text>
              )}
            </TouchableOpacity>
          </View>
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
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '100%',
    maxWidth: 480,
  },
  title: { fontSize: 16, fontWeight: '700', color: '#1e293b', marginBottom: 4 },
  subtitle: { fontSize: 12, color: '#64748b', marginBottom: 14 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 11,
    color: '#334155',
    backgroundColor: '#fff',
    minHeight: 160,
    maxHeight: 320,
    textAlignVertical: 'top',
  },
  hint: { fontSize: 11, color: '#94a3b8', marginTop: 6, lineHeight: 16 },
  error: { fontSize: 12, color: '#dc2626', marginTop: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 14 },
  btnGhost: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  btnGhostText: { fontSize: 14, fontWeight: '600', color: '#475569' },
  btnPrimary: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: '#6366f1',
    minWidth: 100,
    alignItems: 'center',
  },
  btnPrimaryText: { fontSize: 14, fontWeight: '600', color: '#fff' },
});
