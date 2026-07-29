import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import type { KeyboardTypeOptions } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import type { CampoEmpresa, UseCrearEmpresaModalReturn } from '../../hooks/useCrearEmpresaModal';
import { CampoTipoReciboEmpresa } from '../CampoTipoReciboEmpresa';
import { CampoEtiquetasEmpresa } from '../CampoEtiquetasEmpresa';
import { PreviewDocumentoArchivo } from '../PreviewDocumentoArchivo';
import type { EmpresaConTipoRecibo } from '../../utils/empresaTipoRecibo';

type Campo = {
  key: Exclude<CampoEmpresa, 'Etiqueta'>;
  label: string;
  placeholder?: string;
  required?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'words' | 'characters';
  ancho?: 'completo';
  ayuda?: string;
};

type CampoEtiquetas = {
  key: 'Etiqueta';
  label: string;
  ancho?: 'completo';
  required?: boolean;
  ayuda?: string;
};

type CampoSeccion = Campo | CampoEtiquetas;

type Seccion = {
  titulo: string;
  campos: CampoSeccion[];
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
      { key: 'Etiqueta', label: 'Etiquetas', ancho: 'completo' },
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

function PanelPreviewFactura({
  documento,
  apilado,
}: {
  documento: NonNullable<UseCrearEmpresaModalReturn['documentoPreview']>;
  apilado: boolean;
}) {
  const esPdf = documento.tipo.includes('pdf');

  return (
    <View style={[styles.panelPreview, apilado && styles.panelPreviewApilado]}>
      <View style={styles.previewHeader}>
        <MaterialIcons
          name={esPdf ? 'picture-as-pdf' : 'image'}
          size={16}
          color={esPdf ? '#dc2626' : '#0ea5e9'}
        />
        <Text style={styles.previewNombre} numberOfLines={1}>
          {documento.nombre || 'Documento'}
        </Text>
        {Platform.OS === 'web' ? (
          <TouchableOpacity
            style={styles.previewAbrirBtn}
            onPress={() => Linking.openURL(documento.previewUrl)}
            accessibilityLabel="Abrir documento en nueva pestaña"
          >
            <MaterialIcons name="open-in-new" size={14} color="#0369a1" />
            <Text style={styles.previewAbrirText}>Abrir</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <View style={[styles.previewBox, apilado && styles.previewBoxApilado]}>
        <PreviewDocumentoArchivo archivo={documento} tituloIframe="Factura OCR" />
      </View>
    </View>
  );
}

/**
 * Modal de creación de empresa en el maestro `igp_Empresas` desde el flujo de
 * OCR del registro masivo. En pantallas anchas muestra el formulario y la
 * factura OCR lado a lado para contrastar datos.
 */
export function CrearEmpresaModal({
  modal,
  empresasMaestro,
}: {
  modal: UseCrearEmpresaModalReturn;
  empresasMaestro?: EmpresaConTipoRecibo[] | null;
}) {
  const { width: winW, height: winH } = useWindowDimensions();
  const { isCompact } = useBreakpoint();
  const apilado = winW < 900;
  const conPreview = Boolean(modal.documentoPreview?.previewUrl);
  const dosColumnasForm = winW >= 768 && !apilado;
  const anchoCampo = dosColumnasForm ? '48%' : '100%';

  const formulario = (
    <>
      <Text style={styles.modalSubtitle}>
        Se creará un registro en el maestro con el CIF detectado por OCR. Contrastar con la factura
        {conPreview ? ' (panel derecho)' : ''}.
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
                  style={[styles.campo, { width: campo.ancho === 'completo' ? '100%' : anchoCampo }]}
                >
                  <Text style={styles.modalFieldLabel}>
                    {campo.label}
                    {'required' in campo && campo.required ? ' *' : ''}
                  </Text>
                  {campo.key === 'Etiqueta' ? (
                    <CampoEtiquetasEmpresa
                      value={modal.etiquetas}
                      onChange={modal.setEtiquetas}
                      empresas={empresasMaestro}
                      compact={isCompact}
                      inputStyle={[styles.modalInput, isCompact && styles.inputTactil]}
                    />
                  ) : campo.key === 'Tipo de recibo' ? (
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
                      placeholder={'placeholder' in campo ? campo.placeholder : undefined}
                      placeholderTextColor="#94a3b8"
                      keyboardType={'keyboardType' in campo ? campo.keyboardType : undefined}
                      autoCapitalize={'autoCapitalize' in campo ? campo.autoCapitalize ?? 'words' : 'words'}
                      autoFocus={campo.key === 'Nombre' && Platform.OS === 'web'}
                    />
                  )}
                  {'ayuda' in campo && campo.ayuda ? (
                    <Text style={styles.campoAyuda}>{campo.ayuda}</Text>
                  ) : null}
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
          style={[styles.modalBtnPrimary, isCompact && styles.btnTactil, modal.guardando && { opacity: 0.7 }]}
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
    </>
  );

  return (
    <Modal visible={modal.visible} transparent animationType="fade" onRequestClose={modal.cerrar}>
      <KeyboardAvoidingView style={styles.modalKb} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={modal.cerrar}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => {}}
            style={[
              styles.modalWrap,
              {
                maxWidth: conPreview && !apilado ? 1200 : 720,
                maxHeight: Math.max(320, winH * 0.94),
              },
            ]}
          >
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Nueva empresa</Text>
                <TouchableOpacity onPress={modal.cerrar} hitSlop={10} accessibilityLabel="Cerrar">
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>

              <View style={[styles.modalBody, apilado && styles.modalBodyApilado]}>
                <View style={[styles.panelForm, conPreview && !apilado && styles.panelFormSplit]}>
                  {formulario}
                </View>
                {conPreview && modal.documentoPreview ? (
                  <PanelPreviewFactura documento={modal.documentoPreview} apilado={apilado} />
                ) : null}
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
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
    padding: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalWrap: { width: '96%', flex: 1, alignSelf: 'center' },
  modalCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#334155' },
  modalBody: { flex: 1, flexDirection: 'row', minHeight: 0 },
  modalBodyApilado: { flexDirection: 'column' },
  panelForm: { flex: 1, minWidth: 0, padding: 16 },
  panelFormSplit: {
    flex: 1.15,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  panelPreview: { flex: 1, minWidth: 0, padding: 12, backgroundColor: '#fff' },
  panelPreviewApilado: {
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    maxHeight: 360,
    flexGrow: 0,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  previewNombre: { flex: 1, fontSize: 12, fontWeight: '600', color: '#334155' },
  previewAbrirBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  previewAbrirText: { fontSize: 11, fontWeight: '600', color: '#0369a1' },
  previewBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#e2e8f0',
    minHeight: 200,
  },
  previewBoxApilado: { minHeight: 280 },
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
    backgroundColor: '#fff',
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
    backgroundColor: '#fff',
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
