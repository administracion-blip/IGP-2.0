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
import type { UseAcuerdoPagoReturn } from '../hooks/useAcuerdoPago';
import { ACCIONES_IMAGEN } from '../hooks/useAcuerdoPago';
import { esJustificanteS3, justificanteAbrible, justificanteIcono, justificanteNombre, abrirJustificante } from '../types/acuerdo';

type Props = {
  /** Bag completo devuelto por `useAcuerdoPago`. */
  pago: UseAcuerdoPagoReturn;
  /** Layout estrecho (panel detalle en vista compacta). */
  isCompact?: boolean;
};

/**
 * Modal de creación / edición de "pago por imagen" (justificantes con
 * importe, locales, acciones y descripción) asociado a un acuerdo.
 *
 * Toda la lógica vive en `useAcuerdoPago`; este componente solo renderiza.
 * Los estilos replican los del archivo principal (`acuerdos.tsx`) para
 * mantener consistencia visual; al separarse, el modal queda autocontenido
 * sin acoplarse al StyleSheet del padre.
 */
export function AcuerdoPagoModal({ pago, isCompact }: Props) {
  const {
    modalVisible,
    editSK,
    form,
    setForm,
    files,
    guardando,
    subiendoArchivo,
    errorArchivo,
    quitarArchivo,
    localDropdownOpen,
    setLocalDropdownOpen,
    localSearch,
    setLocalSearch,
    accionDropdownOpen,
    setAccionDropdownOpen,
    locales,
    localesFiltrados,
    localNombre,
    cerrarModal,
    guardar,
    handleFileSelect,
  } = pago;

  return (
    <Modal visible={modalVisible} transparent animationType="fade">
      <Pressable
        style={styles.overlay}
        onPress={(e) => {
          if (e.target === e.currentTarget) cerrarModal();
        }}
      >
        <View style={[styles.modal, isCompact && { width: '95%' }]}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>
              {editSK ? 'Editar Pago por Imagen' : 'Nuevo Pago por Imagen'}
            </Text>

            <Text style={styles.label}>Local</Text>
            <TouchableOpacity
              style={styles.input}
              onPress={() => {
                setLocalSearch('');
                setLocalDropdownOpen((o) => !o);
              }}
            >
              <Text
                style={form.Locales.length > 0 ? styles.inputValueText : styles.inputPlaceholderText}
                numberOfLines={2}
              >
                {form.Locales.length > 0
                  ? form.Locales.map((id) => localNombre(id)).join(', ')
                  : 'Seleccionar locales…'}
              </Text>
            </TouchableOpacity>
            {localDropdownOpen && (
              <View style={styles.localDropdown}>
                <TextInput
                  style={[
                    styles.input,
                    styles.localDropdownSearch,
                  ]}
                  placeholder="Buscar local…"
                  placeholderTextColor="#94a3b8"
                  value={localSearch}
                  onChangeText={setLocalSearch}
                  autoFocus
                />
                <TouchableOpacity
                  style={styles.selectAllItem}
                  onPress={() => {
                    const ids = locales.map((l) => l.id).filter(Boolean);
                    setForm((f) => ({ ...f, Locales: ids }));
                  }}
                >
                  <Text style={styles.selectAllItemText}>Seleccionar todos</Text>
                </TouchableOpacity>
                <ScrollView
                  style={styles.localDropdownList}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                >
                  {localesFiltrados.map((l) => {
                    const selected = form.Locales.includes(l.id);
                    return (
                      <TouchableOpacity
                        key={l.id}
                        style={[styles.localDropdownItem, selected && { backgroundColor: '#e0f2fe' }]}
                        onPress={() => {
                          setForm((f) => ({
                            ...f,
                            Locales: selected ? f.Locales.filter((x) => x !== l.id) : [...f.Locales, l.id],
                          }));
                        }}
                      >
                        <Text style={styles.localDropdownItemText} numberOfLines={1}>
                          {selected ? '✓ ' : ''}
                          {l.nombre || l.id}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            )}

            <Text style={styles.label}>Acción</Text>
            <TouchableOpacity style={styles.input} onPress={() => setAccionDropdownOpen((o) => !o)}>
              <Text
                style={form.Acciones.length > 0 ? styles.inputValueText : styles.inputPlaceholderText}
                numberOfLines={2}
              >
                {form.Acciones.length > 0 ? form.Acciones.join(', ') : 'Seleccionar acciones…'}
              </Text>
            </TouchableOpacity>
            {accionDropdownOpen && (
              <View style={styles.productoDropdown}>
                <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                  {ACCIONES_IMAGEN.map((ac) => {
                    const selected = form.Acciones.includes(ac);
                    return (
                      <TouchableOpacity
                        key={ac}
                        style={[styles.productoDropdownItem, selected && { backgroundColor: '#e0f2fe' }]}
                        onPress={() => {
                          setForm((f) => ({
                            ...f,
                            Acciones: selected ? f.Acciones.filter((x) => x !== ac) : [...f.Acciones, ac],
                          }));
                        }}
                      >
                        <Text style={styles.productoDropdownItemText}>
                          {selected ? '✓ ' : ''}
                          {ac}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            )}

            <Text style={styles.label}>Importe (€)</Text>
            <TextInput
              style={styles.input}
              value={form.Importe}
              onChangeText={(v) => setForm((f) => ({ ...f, Importe: v }))}
              keyboardType="numeric"
              placeholder="0,00"
              placeholderTextColor="#94a3b8"
            />

            <Text style={styles.label}>Justificante</Text>
            <TouchableOpacity
              style={[styles.input, { flexDirection: 'row', alignItems: 'center', gap: 6 }, subiendoArchivo && { opacity: 0.6 }]}
              onPress={handleFileSelect}
              disabled={subiendoArchivo}
            >
              {subiendoArchivo ? (
                <ActivityIndicator size="small" color="#0ea5e9" />
              ) : (
                <MaterialIcons name="attach-file" size={16} color="#64748b" />
              )}
              <Text style={styles.inputPlaceholderText}>
                {subiendoArchivo ? 'Subiendo…' : 'Adjuntar archivos…'}
              </Text>
            </TouchableOpacity>
            {errorArchivo ? (
              <Text style={styles.errorText}>{errorArchivo}</Text>
            ) : null}
            {files.length > 0 && (
              <View style={{ gap: 4, marginBottom: 12, marginTop: 4 }}>
                {files.map((f, i) => {
                  const nombre = justificanteNombre(f);
                  const abrible = justificanteAbrible(f);
                  const icono = justificanteIcono(f);
                  return (
                    <View
                      key={esJustificanteS3(f) ? f.fileKey : `legacy-${i}`}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}
                    >
                      <MaterialIcons name={icono.name} size={14} color={icono.color} />
                      {abrible ? (
                        <TouchableOpacity
                          style={{ flex: 1 }}
                          onPress={() => abrirJustificante(f)}
                        >
                          <Text style={{ fontSize: 12, color: '#0ea5e9', textDecorationLine: 'underline' }} numberOfLines={1}>
                            {nombre}
                          </Text>
                        </TouchableOpacity>
                      ) : (
                        <Text style={{ fontSize: 12, color: '#334155', flex: 1 }} numberOfLines={1}>
                          {nombre}
                        </Text>
                      )}
                      <TouchableOpacity onPress={() => quitarArchivo(i)}>
                        <MaterialIcons name="close" size={14} color="#ef4444" />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}

            <Text style={styles.label}>Descripción</Text>
            <TextInput
              style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
              value={form.Descripcion}
              onChangeText={(v) => setForm((f) => ({ ...f, Descripcion: v }))}
              multiline
              placeholder="Descripción del pago…"
              placeholderTextColor="#94a3b8"
            />

            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.cancelBtn} onPress={cerrarModal}>
                <Text style={styles.cancelBtnText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveBtn, (guardando || subiendoArchivo) && { opacity: 0.6 }]}
                onPress={guardar}
                disabled={guardando || subiendoArchivo}
              >
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
  inputValueText: { fontSize: 14, color: '#334155' },
  inputPlaceholderText: { fontSize: 14, color: '#94a3b8' },
  errorText: { fontSize: 12, color: '#ef4444', marginTop: 6 },
  localDropdown: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    marginTop: 4,
    maxHeight: 150,
    overflow: 'hidden',
  },
  localDropdownSearch: {
    marginBottom: 0,
    borderWidth: 0,
    borderBottomWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 6,
    fontSize: 13,
  },
  localDropdownList: { maxHeight: 96 },
  selectAllItem: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  selectAllItemText: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  productoDropdown: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    marginTop: 4,
    maxHeight: 220,
    overflow: 'hidden',
  },
  localDropdownItem: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    flexDirection: 'row',
    alignItems: 'center',
  },
  localDropdownItemText: { fontSize: 12, color: '#334155', flex: 1 },
  productoDropdownItem: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    flexDirection: 'row',
    alignItems: 'center',
  },
  productoDropdownItemText: { fontSize: 13, color: '#334155', flex: 1 },
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
