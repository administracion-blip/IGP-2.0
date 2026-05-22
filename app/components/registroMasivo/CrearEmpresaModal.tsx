import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { UseCrearEmpresaModalReturn } from '../../hooks/useCrearEmpresaModal';

/**
 * Modal de creación rápida de empresa en el maestro `igp_Empresas` desde
 * el flujo de OCR del registro masivo.
 *
 * Toda la lógica vive en `useCrearEmpresaModal`; este componente solo
 * renderiza la UI a partir del estado expuesto por el hook.
 */
export function CrearEmpresaModal({ modal }: { modal: UseCrearEmpresaModalReturn }) {
  return (
    <Modal
      visible={modal.visible}
      transparent
      animationType="fade"
      onRequestClose={modal.cerrar}
    >
      <KeyboardAvoidingView
        style={styles.modalKb}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFillObject}
            activeOpacity={1}
            onPress={modal.cerrar}
          />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Nueva empresa</Text>
            <Text style={styles.modalSubtitle}>
              Se creará un registro en el maestro de empresas con el CIF detectado por OCR.
            </Text>
            <Text style={styles.modalCifLabel}>
              CIF: <Text style={styles.modalCifValue}>{modal.cif || '—'}</Text>
            </Text>
            <Text style={styles.modalFieldLabel}>Nombre fiscal *</Text>
            <TextInput
              style={styles.modalInput}
              value={modal.nombre}
              onChangeText={modal.setNombre}
              placeholder="Razón social"
              placeholderTextColor="#94a3b8"
              autoFocus={Platform.OS === 'web'}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnSecondary} onPress={modal.cerrar}>
                <Text style={styles.modalBtnSecondaryText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtnPrimary, modal.guardando && { opacity: 0.7 }]}
                onPress={modal.guardar}
                disabled={modal.guardando}
              >
                {modal.guardando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalBtnPrimaryText}>Guardar empresa</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalKb: { flex: 1 },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    zIndex: 2,
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 6 },
  modalSubtitle: { fontSize: 11, color: '#64748b', marginBottom: 10, lineHeight: 16 },
  modalCifLabel: { fontSize: 12, color: '#64748b', marginBottom: 10 },
  modalCifValue: { fontWeight: '700', color: '#0f172a' },
  modalFieldLabel: { fontSize: 11, color: '#64748b', marginBottom: 4, fontWeight: '500' },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#334155',
    marginBottom: 16,
    backgroundColor: '#f8fafc',
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  modalBtnSecondary: { paddingVertical: 8, paddingHorizontal: 12 },
  modalBtnSecondaryText: { fontSize: 13, color: '#64748b', fontWeight: '500' },
  modalBtnPrimary: {
    backgroundColor: '#059669',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    minWidth: 120,
    alignItems: 'center',
  },
  modalBtnPrimaryText: { fontSize: 13, color: '#fff', fontWeight: '600' },
});
