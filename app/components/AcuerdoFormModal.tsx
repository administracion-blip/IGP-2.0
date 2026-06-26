import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from './InputFecha';
import { SelectorDesplegable } from './SelectorDesplegable';
import type { UseAcuerdosFormReturn } from '../hooks/useAcuerdosForm';
import { ESTADOS_ACUERDO } from '../hooks/useAcuerdosForm';

type Props = {
  /** Bag completo devuelto por `useAcuerdosForm`. */
  formAcuerdo: UseAcuerdosFormReturn;
  /** Layout estrecho (panel detalle en vista compacta). */
  isCompact?: boolean;
};

/**
 * Modal de creación / edición de un acuerdo. Solo vista; toda la lógica vive
 * en `useAcuerdosForm`. Los estilos replican los del archivo principal
 * (`acuerdos.tsx`) para mantener consistencia visual.
 */
export function AcuerdoFormModal({ formAcuerdo, isCompact }: Props) {
  const {
    modalVisible,
    editId,
    form,
    setForm,
    formPK,
    guardando,
    empresas,
    loadingEmpresas,
    cerrar,
    guardar,
  } = formAcuerdo;

  return (
    <Modal visible={modalVisible} transparent animationType="fade">
      <Pressable
        style={styles.overlay}
        onPress={(e) => {
          if (e.target === e.currentTarget) cerrar();
        }}
      >
        <View style={[styles.modal, isCompact && { width: '95%' }]}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{editId ? 'Editar Acuerdo' : 'Nuevo Acuerdo'}</Text>

            <Text style={styles.label}>Identificador (PK) *</Text>
            <TextInput
              style={[styles.input, styles.inputReadonly]}
              value={formPK}
              editable={false}
              selectTextOnFocus={false}
            />

            <Text style={styles.label}>Nombre del acuerdo</Text>
            <TextInput
              style={styles.input}
              value={form.Nombre}
              onChangeText={(v) => setForm((f) => ({ ...f, Nombre: v }))}
              placeholder="Ej: Acuerdo Coca-Cola 2025"
              placeholderTextColor="#94a3b8"
            />

            <SelectorDesplegable
              label="Marca"
              icono="business"
              placeholder="Seleccionar marca…"
              tituloLista="Selecciona una empresa"
              iconoLista="business"
              loading={loadingEmpresas}
              vacioTexto="No hay empresas disponibles."
              buscador
              buscadorPlaceholder="Buscar empresa…"
              style={styles.selectorMarca}
              valorId={form.Marca || ''}
              opciones={empresas.map((e, i) => {
                const alias = String(e.Alias || e.Nombre || '');
                return {
                  id: alias || String(e.Cif || e.id_empresa || i),
                  titulo: alias || '—',
                };
              })}
              onSeleccionar={(id) => setForm((f) => ({ ...f, Marca: id }))}
            />

            <View style={styles.row2}>
              <View style={styles.row2col}>
                <Text style={styles.label}>Fecha inicio</Text>
                <InputFecha
                  style={styles.input}
                  valueIso={form.FechaInicio}
                  onChangeIso={(iso) => setForm((f) => ({ ...f, FechaInicio: iso }))}
                />
              </View>
              <View style={styles.row2col}>
                <Text style={styles.label}>Fecha fin</Text>
                <InputFecha
                  style={styles.input}
                  valueIso={form.FechaFin}
                  onChangeIso={(iso) => setForm((f) => ({ ...f, FechaFin: iso }))}
                />
              </View>
            </View>

            <Text style={styles.label}>Contacto</Text>
            <TextInput
              style={styles.input}
              value={form.Contacto}
              onChangeText={(v) => setForm((f) => ({ ...f, Contacto: v }))}
              placeholder="Nombre del contacto"
              placeholderTextColor="#94a3b8"
            />

            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Teléfono</Text>
                <TextInput
                  style={styles.input}
                  value={form.Telefono}
                  onChangeText={(v) => setForm((f) => ({ ...f, Telefono: v }))}
                  placeholder="Ej: 612345678"
                  placeholderTextColor="#94a3b8"
                  keyboardType="phone-pad"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  style={styles.input}
                  value={form.Email}
                  onChangeText={(v) => setForm((f) => ({ ...f, Email: v }))}
                  placeholder="email@ejemplo.com"
                  placeholderTextColor="#94a3b8"
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>
            </View>

            <Text style={styles.label}>Estado</Text>
            <View style={styles.estadoRow}>
              {ESTADOS_ACUERDO.map((e) => (
                <TouchableOpacity
                  key={e}
                  style={[styles.estadoChip, form.Estado === e && styles.estadoChipActive]}
                  onPress={() => setForm((f) => ({ ...f, Estado: e }))}
                >
                  <Text style={[styles.estadoChipText, form.Estado === e && styles.estadoChipTextActive]}>
                    {e}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>Notas</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={form.Notas}
              onChangeText={(v) => setForm((f) => ({ ...f, Notas: v }))}
              multiline
              numberOfLines={3}
              placeholder="Observaciones…"
              placeholderTextColor="#94a3b8"
            />

            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.cancelBtn} onPress={cerrar}>
                <Text style={styles.cancelBtnText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.saveBtn}
                onPress={guardar}
                disabled={guardando || !formPK.trim()}
              >
                {guardando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <MaterialIcons name="check" size={18} color="#fff" />
                )}
                <Text style={styles.saveBtnText}>{guardando ? 'Guardando…' : 'Guardar'}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  modal: { backgroundColor: '#fff', borderRadius: 14, width: '90%', maxWidth: 560, maxHeight: '90%', padding: 20 },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a', marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 4, marginTop: 10 },
  input: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: '#334155',
  },
  inputReadonly: { backgroundColor: '#e2e8f0', color: '#64748b' },
  inputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  selectorMarca: { marginTop: 10 },
  row2: { flexDirection: 'row', gap: 10 },
  row2col: { flex: 1 },
  estadoRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  estadoChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  estadoChipActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  estadoChipText: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  estadoChipTextActive: { color: '#fff' },
  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
  cancelBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#f1f5f9' },
  cancelBtnText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  saveBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
});
