import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { KeyboardTypeOptions } from 'react-native';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import type { CampoEmpresa, UseCrearEmpresaModalReturn } from '../../hooks/useCrearEmpresaModal';
import { CampoTipoReciboEmpresa } from '../CampoTipoReciboEmpresa';

type Campo = {
  key: CampoEmpresa;
  label: string;
  placeholder?: string;
  required?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'words' | 'characters';
  ancho?: 'completo';
  ayuda?: string;
};

type Seccion = {
  titulo: string;
  campos: Campo[];
  /** Muestra el aviso de revisión cuando los campos vienen prellenados del OCR. */
  avisaPrefillOcr?: boolean;
};

const SECCIONES: Seccion[] = [
  {
    titulo: 'Identificación',
    campos: [
      { key: 'Nombre', label: 'Nombre fiscal', placeholder: 'Razón social', required: true, ancho: 'completo' },
      {
        key: 'Sede',
        label: 'Sede',
        placeholder: 'Sede',
        ayuda: 'No escribas "Grupo Paripe" en un proveedor: esa sede lo colaría en el selector de sociedades del grupo.',
      },
      { key: 'Etiqueta', label: 'Etiquetas', placeholder: 'Separadas por comas', autoCapitalize: 'none' },
    ],
  },
  {
    titulo: 'Dirección',
    avisaPrefillOcr: true,
    campos: [
      { key: 'Direccion', label: 'Dirección', placeholder: 'Calle y número', ancho: 'completo' },
      { key: 'Cp', label: 'Código postal', placeholder: '28001', keyboardType: 'number-pad' },
      { key: 'Municipio', label: 'Municipio', placeholder: 'Municipio' },
      { key: 'Provincia', label: 'Provincia', placeholder: 'Provincia' },
    ],
  },
  {
    titulo: 'Contacto',
    campos: [
      { key: 'Email', label: 'Email', placeholder: 'correo@empresa.com', keyboardType: 'email-address', autoCapitalize: 'none' },
      { key: 'Telefono', label: 'Teléfono', placeholder: '600 000 000', keyboardType: 'phone-pad' },
    ],
  },
  {
    titulo: 'Datos bancarios',
    campos: [
      { key: 'Iban', label: 'IBAN', placeholder: 'ES00 0000 0000 0000 0000 0000', autoCapitalize: 'characters' },
      { key: 'IbanAlternativo', label: 'IBAN alternativo', placeholder: 'IBAN secundario', autoCapitalize: 'characters' },
      { key: 'CCC', label: 'CCC', placeholder: 'Cuenta de cotización', autoCapitalize: 'characters' },
    ],
  },
  {
    titulo: 'Administrativos',
    campos: [
      { key: 'Tipo de recibo', label: 'Tipo de recibo' },
      { key: 'Vencimiento', label: 'Vencimiento', placeholder: '30 días' },
      { key: 'Cuenta contable', label: 'Cuenta contable', placeholder: '400000001' },
      { key: 'Administrador', label: 'Administrador', placeholder: 'Persona de contacto' },
    ],
  },
];

/**
 * Modal de creación de empresa en el maestro `igp_Empresas` desde el flujo de
 * OCR del registro masivo. Permite rellenar todos los atributos de la tabla
 * para no tener que completar la ficha después en el maestro.
 *
 * Toda la lógica vive en `useCrearEmpresaModal`; este componente solo
 * renderiza la UI a partir del estado expuesto por el hook.
 */
export function CrearEmpresaModal({ modal }: { modal: UseCrearEmpresaModalReturn }) {
  const { height, isPhone, isCompact, shouldStackPanels } = useBreakpoint();
  const dosColumnas = !isPhone && !shouldStackPanels;
  const anchoCampo = dosColumnas ? '48%' : '100%';

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
          <View
            style={[
              styles.modalCard,
              { maxWidth: dosColumnas ? 720 : 460, maxHeight: Math.max(320, height * 0.85) },
            ]}
          >
            <Text style={styles.modalTitle}>Nueva empresa</Text>
            <Text style={styles.modalSubtitle}>
              Se creará un registro en el maestro de empresas con el CIF detectado por OCR. Completa
              los datos que conozcas; podrás editarlos más adelante en el maestro.
            </Text>

            <View style={styles.readonlyRow}>
              <View style={styles.readonlyBox}>
                <Text style={styles.modalFieldLabel}>ID asignado</Text>
                <Text style={styles.readonlyValue}>{modal.form.id_empresa || '—'}</Text>
              </View>
              <View style={styles.readonlyBox}>
                <Text style={styles.modalFieldLabel}>CIF</Text>
                <Text style={styles.readonlyValue}>{modal.cif || '—'}</Text>
              </View>
            </View>

            <ScrollView
              style={styles.modalScroll}
              contentContainerStyle={styles.modalScrollContent}
              keyboardShouldPersistTaps="handled"
            >
              {SECCIONES.map((seccion) => (
                <View key={seccion.titulo} style={styles.seccion}>
                  <Text style={styles.seccionTitulo}>{seccion.titulo}</Text>
                  {seccion.avisaPrefillOcr && modal.direccionDesdeOcr ? (
                    <Text style={styles.seccionNota}>Datos sugeridos por OCR, revísalos.</Text>
                  ) : null}
                  <View style={styles.camposWrap}>
                    {seccion.campos.map((campo) => (
                      <View
                        key={campo.key}
                        style={[
                          styles.campo,
                          { width: campo.ancho === 'completo' ? '100%' : anchoCampo },
                        ]}
                      >
                        <Text style={styles.modalFieldLabel}>
                          {campo.label}
                          {campo.required ? ' *' : ''}
                        </Text>
                        {campo.key === 'Tipo de recibo' ? (
                          <CampoTipoReciboEmpresa
                            value={modal.form[campo.key]}
                            onChange={(stored) => modal.setCampo(campo.key, stored)}
                            inputStyle={[styles.modalInput, isCompact && styles.inputTactil]}
                            otroInputStyle={[styles.modalInput, isCompact && styles.inputTactil]}
                          />
                        ) : (
                          <TextInput
                            style={[styles.modalInput, isCompact && styles.inputTactil]}
                            value={modal.form[campo.key]}
                            onChangeText={(t) => modal.setCampo(campo.key, t)}
                            placeholder={campo.placeholder}
                            placeholderTextColor="#94a3b8"
                            keyboardType={campo.keyboardType}
                            autoCapitalize={campo.autoCapitalize ?? 'words'}
                            autoFocus={campo.key === 'Nombre' && Platform.OS === 'web'}
                          />
                        )}
                        {campo.ayuda ? <Text style={styles.campoAyuda}>{campo.ayuda}</Text> : null}
                      </View>
                    ))}
                  </View>
                </View>
              ))}
            </ScrollView>

            {modal.error ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorBannerText}>{modal.error}</Text>
              </View>
            ) : null}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtnSecondary, isCompact && styles.btnTactil]}
                onPress={modal.cerrar}
              >
                <Text style={styles.modalBtnSecondaryText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalBtnPrimary,
                  isCompact && styles.btnTactil,
                  modal.guardando && { opacity: 0.7 },
                ]}
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
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    zIndex: 2,
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 6 },
  modalSubtitle: { fontSize: 11, color: '#64748b', marginBottom: 10, lineHeight: 16 },
  readonlyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  readonlyBox: {
    flexGrow: 1,
    minWidth: 120,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#f8fafc',
  },
  readonlyValue: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  modalScroll: { flexShrink: 1 },
  modalScrollContent: { paddingBottom: 4 },
  seccion: { marginBottom: 12 },
  seccionTitulo: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  seccionNota: { fontSize: 11, color: '#b45309', marginBottom: 8, lineHeight: 15 },
  camposWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  campo: { marginBottom: 2 },
  campoAyuda: { fontSize: 10, color: '#94a3b8', marginTop: 4, lineHeight: 14 },
  modalFieldLabel: { fontSize: 11, color: '#64748b', marginBottom: 4, fontWeight: '500' },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  inputTactil: { minHeight: MIN_TOUCH },
  errorBanner: {
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  errorBannerText: { fontSize: 12, color: '#b91c1c', lineHeight: 16 },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
  },
  btnTactil: { minHeight: MIN_TOUCH, justifyContent: 'center' },
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
