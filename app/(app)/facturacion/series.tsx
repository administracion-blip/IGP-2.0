import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Modal,
  TouchableOpacity,
  Switch,
  Platform,
  Pressable,
  KeyboardAvoidingView,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { ICONS, ICON_SIZE } from '../../constants/icons';
import { TablaBasica } from '../../components/TablaBasica';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type Serie = {
  serie: string;
  descripcion: string;
  tipo: 'OUT' | 'IN';
  prefijo_formato: string;
  ultimo_numero: number;
  activa: boolean;
  notas?: string;
  reinicio_anual?: boolean;
  num_digitos?: number;
  ultimo_anio?: number;
};

type FormSerie = {
  serie: string;
  descripcion: string;
  tipo: 'OUT' | 'IN';
  prefijo_formato: string;
  activa: boolean;
  notas: string;
  reinicio_anual: boolean;
  num_digitos: number;
};

const COLUMNAS = ['serie', 'descripcion', 'tipo', 'formato', 'ultimo_numero', 'activa'];

const INITIAL_FORM: FormSerie = {
  serie: '',
  descripcion: '',
  tipo: 'OUT',
  prefijo_formato: '',
  activa: true,
  reinicio_anual: true,
  num_digitos: 6,
  notas: '',
};

export default function SeriesScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();

  const [series, setSeries] = useState<Serie[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [modalVisible, setModalVisible] = useState(false);
  const [editingMode, setEditingMode] = useState(false);
  const [form, setForm] = useState<FormSerie>(INITIAL_FORM);
  const [errorForm, setErrorForm] = useState<string | null>(null);

  const [confirmDeleteVisible, setConfirmDeleteVisible] = useState(false);
  const [serieToDelete, setSerieToDelete] = useState<Serie | null>(null);

  const permitido = hasPermiso('facturacion.series');

  const fetchSeries = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/api/facturacion/series`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setSeries(data.series || []);
      })
      .catch((e) => setError(e.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchSeries();
  }, [fetchSeries]);

  const seriesFiltradas = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return series;
    return series.filter((s) =>
      COLUMNAS.some((col) => getValorCelda(s, col).toLowerCase().includes(q))
    );
  }, [series, filtroBusqueda]);

  const abrirCrear = useCallback(() => {
    setForm(INITIAL_FORM);
    setEditingMode(false);
    setErrorForm(null);
    setModalVisible(true);
  }, []);

  const abrirEditar = useCallback((item: Serie) => {
    setForm({
      serie: item.serie,
      descripcion: item.descripcion,
      tipo: item.tipo,
      prefijo_formato: item.prefijo_formato,
      activa: item.activa,
      notas: item.notas || '',
      reinicio_anual: item.reinicio_anual !== false,
      num_digitos: item.num_digitos || 6,
    });
    setEditingMode(true);
    setErrorForm(null);
    setModalVisible(true);
  }, []);

  const cerrarModal = useCallback(() => {
    if (!guardando) {
      setModalVisible(false);
      setErrorForm(null);
    }
  }, [guardando]);

  const guardar = useCallback(async () => {
    if (!form.serie.trim()) {
      setErrorForm('El código de serie es obligatorio');
      return;
    }
    if (!form.descripcion.trim()) {
      setErrorForm('La descripción es obligatoria');
      return;
    }
    setGuardando(true);
    setErrorForm(null);
    try {
      const method = editingMode ? 'PUT' : 'POST';
      const res = await fetch(`${API_URL}/api/facturacion/series`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, prefijo_formato: `${form.serie}-{YYYY}-` }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al guardar');
        return;
      }
      fetchSeries();
      setSelectedRowIndex(null);
      cerrarModal();
    } catch (e) {
      setErrorForm(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  }, [form, editingMode, fetchSeries, cerrarModal]);

  const solicitarBorrado = useCallback((item: Serie) => {
    setSerieToDelete(item);
    setConfirmDeleteVisible(true);
  }, []);

  const confirmarBorrado = useCallback(async () => {
    if (!serieToDelete) return;
    setGuardando(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/series`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serie: serieToDelete.serie }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al borrar');
      } else {
        fetchSeries();
        setSelectedRowIndex(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
      setConfirmDeleteVisible(false);
      setSerieToDelete(null);
    }
  }, [serieToDelete, fetchSeries]);

  const cancelarBorrado = useCallback(() => {
    setConfirmDeleteVisible(false);
    setSerieToDelete(null);
  }, []);

  if (!permitido) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock" size={48} color="#94a3b8" />
        <Text style={styles.noPermisoText}>No tienes permiso para acceder a esta sección</Text>
        <TouchableOpacity style={styles.backLink} onPress={() => router.push('/facturacion')}>
          <MaterialIcons name="arrow-back" size={18} color="#0ea5e9" />
          <Text style={styles.backLinkText}>Volver a facturación</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <TablaBasica<Serie>
        title="Series de facturación"
        onBack={() => router.push('/facturacion')}
        columnas={COLUMNAS}
        datos={seriesFiltradas}
        getValorCelda={getValorCelda}
        loading={loading}
        error={error}
        onRetry={fetchSeries}
        filtroBusqueda={filtroBusqueda}
        onFiltroChange={setFiltroBusqueda}
        selectedRowIndex={selectedRowIndex}
        onSelectRow={setSelectedRowIndex}
        onCrear={abrirCrear}
        onEditar={(item) => abrirEditar(item)}
        onBorrar={(item) => solicitarBorrado(item)}
        guardando={guardando}
        emptyMessage="No hay series configuradas"
        emptyFilterMessage="Ninguna serie coincide con el filtro"
        renderCell={(item, col, defaultText) => {
          if (col === 'activa') {
            const activa = item.activa;
            return (
              <View style={[styles.badge, activa ? styles.badgeActiva : styles.badgeInactiva]}>
                <Text style={[styles.badgeText, activa ? styles.badgeTextoActiva : styles.badgeTextoInactiva]}>
                  {activa ? 'Activa' : 'Inactiva'}
                </Text>
              </View>
            );
          }
          if (col === 'tipo') {
            const isOut = item.tipo === 'OUT';
            return (
              <View style={[styles.badge, isOut ? styles.badgeTipoOut : styles.badgeTipoIn]}>
                <Text style={[styles.badgeText, isOut ? styles.badgeTextoOut : styles.badgeTextoIn]}>
                  {item.tipo}
                </Text>
              </View>
            );
          }
          return null;
        }}
        extraToolbarRight={
          <TouchableOpacity
            style={styles.refreshBtn}
            onPress={fetchSeries}
            disabled={loading}
            accessibilityLabel="Refrescar"
          >
            {loading ? (
              <ActivityIndicator size="small" color="#0ea5e9" />
            ) : (
              <MaterialIcons name="refresh" size={ICON_SIZE} color="#0ea5e9" />
            )}
          </TouchableOpacity>
        }
      />

      {/* Modal crear / editar */}
      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={cerrarModal}>
        <Pressable style={styles.modalOverlay} onPress={cerrarModal}>
          <KeyboardAvoidingView
            style={styles.modalCenter}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <Pressable style={styles.modalCardTouch} onPress={(e) => e.stopPropagation()}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>
                    {editingMode ? 'Editar serie' : 'Nueva serie'}
                  </Text>
                  <TouchableOpacity onPress={cerrarModal} style={styles.modalClose} disabled={guardando}>
                    <MaterialIcons name="close" size={22} color="#64748b" />
                  </TouchableOpacity>
                </View>
                <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Código de serie *</Text>
                    <TextInput
                      style={[styles.formInput, editingMode && styles.formInputReadonly]}
                      value={form.serie}
                      onChangeText={(t) => setForm((p) => ({ ...p, serie: t }))}
                      placeholder="Ej: FV, FR, GA…"
                      placeholderTextColor="#94a3b8"
                      editable={!guardando && !editingMode}
                      autoCapitalize="characters"
                    />
                  </View>
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Descripción *</Text>
                    <TextInput
                      style={styles.formInput}
                      value={form.descripcion}
                      onChangeText={(t) => setForm((p) => ({ ...p, descripcion: t }))}
                      placeholder="Descripción de la serie"
                      placeholderTextColor="#94a3b8"
                      editable={!guardando}
                    />
                  </View>
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Tipo</Text>
                    <View style={styles.chipsRow}>
                      {(['OUT', 'IN'] as const).map((tipo) => (
                        <TouchableOpacity
                          key={tipo}
                          style={[styles.chip, form.tipo === tipo && styles.chipSelected]}
                          onPress={() => setForm((p) => ({ ...p, tipo }))}
                          disabled={guardando}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[styles.chipText, form.tipo === tipo && styles.chipTextSelected]}
                          >
                            {tipo === 'OUT' ? 'OUT (Emitida)' : 'IN (Recibida)'}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Formato de numeración (auto)</Text>
                    <View style={styles.formatPreview}>
                      <Text style={styles.formatPreviewText}>
                        {form.serie || '??'}-{new Date().getFullYear()}-{'0'.repeat(form.num_digitos || 6).slice(0, -1)}1
                      </Text>
                    </View>
                    <Text style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                      Se genera como: Código serie + Año de factura + Nº correlativo
                    </Text>
                  </View>
                  <View style={styles.formGroupRow}>
                    <Text style={styles.formLabel}>Activa</Text>
                    <Switch
                      value={form.activa}
                      onValueChange={(v) => setForm((p) => ({ ...p, activa: v }))}
                      disabled={guardando}
                      trackColor={{ false: '#e2e8f0', true: '#0ea5e9' }}
                      thumbColor="#fff"
                    />
                  </View>
                  <View style={styles.formGroup}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text style={styles.formLabel}>Reinicio anual</Text>
                      <Switch
                        value={form.reinicio_anual}
                        onValueChange={(v) => setForm((p) => ({ ...p, reinicio_anual: v }))}
                        disabled={guardando}
                        trackColor={{ false: '#e2e8f0', true: '#0ea5e9' }}
                        thumbColor="#fff"
                      />
                    </View>
                    <Text style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                      El contador se reinicia a 1 cada año nuevo
                    </Text>
                  </View>
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Nº dígitos</Text>
                    <TextInput
                      style={styles.formInput}
                      value={String(form.num_digitos)}
                      onChangeText={(t) => setForm((p) => ({ ...p, num_digitos: parseInt(t) || 4 }))}
                      keyboardType="number-pad"
                      editable={!guardando}
                      placeholder="6"
                      placeholderTextColor="#94a3b8"
                    />
                    <Text style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                      Ej: 6 → 000001, 4 → 0001
                    </Text>
                  </View>
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Notas</Text>
                    <TextInput
                      style={[styles.formInput, styles.formInputMultiline]}
                      value={form.notas}
                      onChangeText={(t) => setForm((p) => ({ ...p, notas: t }))}
                      placeholder="Notas adicionales…"
                      placeholderTextColor="#94a3b8"
                      editable={!guardando}
                      multiline
                      numberOfLines={3}
                      textAlignVertical="top"
                    />
                  </View>
                </ScrollView>
                {errorForm ? <Text style={styles.modalError}>{errorForm}</Text> : null}
                <View style={styles.modalFooter}>
                  <TouchableOpacity
                    style={styles.modalFooterBtn}
                    onPress={cerrarModal}
                    disabled={guardando}
                  >
                    <Text style={styles.modalFooterBtnText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalFooterBtn, styles.modalFooterBtnPrimary]}
                    onPress={guardar}
                    disabled={guardando}
                  >
                    {guardando ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.modalFooterBtnTextPrimary}>
                        {editingMode ? 'Guardar' : 'Crear'}
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      {/* Modal confirmación borrado */}
      <Modal visible={confirmDeleteVisible} transparent animationType="fade" onRequestClose={cancelarBorrado}>
        <Pressable style={styles.modalOverlay} onPress={cancelarBorrado}>
          <Pressable style={styles.confirmCard} onPress={(e) => e.stopPropagation()}>
            <MaterialIcons name="warning" size={36} color="#f59e0b" style={{ alignSelf: 'center' }} />
            <Text style={styles.confirmTitle}>Eliminar serie</Text>
            <Text style={styles.confirmText}>
              ¿Estás seguro de que quieres eliminar la serie{' '}
              <Text style={{ fontWeight: '700' }}>{serieToDelete?.serie}</Text>?{'\n'}
              Esta acción no se puede deshacer.
            </Text>
            <View style={styles.confirmButtons}>
              <TouchableOpacity
                style={styles.modalFooterBtn}
                onPress={cancelarBorrado}
                disabled={guardando}
              >
                <Text style={styles.modalFooterBtnText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalFooterBtn, styles.modalFooterBtnDanger]}
                onPress={confirmarBorrado}
                disabled={guardando}
              >
                {guardando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalFooterBtnTextDanger}>Eliminar</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function getValorCelda(item: Serie, col: string): string {
  switch (col) {
    case 'serie':
      return item.serie ?? '—';
    case 'descripcion':
      return item.descripcion ?? '—';
    case 'tipo':
      return item.tipo ?? '—';
    case 'formato':
      return `${item.serie}-${new Date().getFullYear()}-${'0'.repeat(item.num_digitos || 6).slice(0, -1)}N`;
    case 'ultimo_numero':
      return item.ultimo_numero != null ? String(item.ultimo_numero) : '0';
    case 'activa':
      return item.activa ? 'Activa' : 'Inactiva';
    default:
      return '—';
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 20 },
  noPermisoText: { fontSize: 14, color: '#64748b', textAlign: 'center' },
  backLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  backLinkText: { fontSize: 13, color: '#0ea5e9', fontWeight: '500' },

  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 10, fontWeight: '600' },
  badgeActiva: { backgroundColor: '#dcfce7' },
  badgeInactiva: { backgroundColor: '#fee2e2' },
  badgeTextoActiva: { color: '#16a34a' },
  badgeTextoInactiva: { color: '#dc2626' },
  badgeTipoOut: { backgroundColor: '#dbeafe' },
  badgeTipoIn: { backgroundColor: '#fef3c7' },
  badgeTextoOut: { color: '#2563eb' },
  badgeTextoIn: { color: '#b45309' },

  refreshBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
  },

  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalCenter: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    padding: 20,
  },
  modalCardTouch: { width: '100%', maxWidth: 440 },
  modalCard: {
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#334155' },
  modalClose: { padding: 4 },
  modalBody: { paddingHorizontal: 20, paddingVertical: 16, maxHeight: 420 },

  formGroup: { marginBottom: 12 },
  formGroupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  formLabel: { fontSize: 11, fontWeight: '500', color: '#475569', marginBottom: 4 },
  formInput: {
    fontSize: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
    backgroundColor: '#fff',
    color: '#334155',
  },
  formInputReadonly: { backgroundColor: '#f1f5f9', color: '#94a3b8' },
  formatPreview: {
    padding: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
    backgroundColor: '#f0f9ff',
  },
  formatPreviewText: { fontSize: 13, fontWeight: '600', color: '#0369a1', fontFamily: Platform.OS === 'web' ? 'monospace' : undefined },
  formInputMultiline: { minHeight: 64, textAlignVertical: 'top' },

  chipsRow: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    alignItems: 'center',
  },
  chipSelected: {
    borderColor: '#0ea5e9',
    backgroundColor: '#e0f2fe',
  },
  chipText: { fontSize: 12, fontWeight: '500', color: '#64748b' },
  chipTextSelected: { color: '#0ea5e9', fontWeight: '600' },

  modalError: { fontSize: 11, color: '#f87171', paddingHorizontal: 20, paddingBottom: 4 },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  modalFooterBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
  },
  modalFooterBtnText: { fontSize: 12, fontWeight: '500', color: '#64748b' },
  modalFooterBtnPrimary: {
    backgroundColor: '#0ea5e9',
    borderColor: '#0ea5e9',
  },
  modalFooterBtnTextPrimary: { fontSize: 12, fontWeight: '600', color: '#fff' },
  modalFooterBtnDanger: {
    backgroundColor: '#ef4444',
    borderColor: '#ef4444',
  },
  modalFooterBtnTextDanger: { fontSize: 12, fontWeight: '600', color: '#fff' },

  confirmCard: {
    width: '90%',
    maxWidth: 380,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    gap: 12,
  },
  confirmTitle: { fontSize: 16, fontWeight: '700', color: '#334155', textAlign: 'center' },
  confirmText: { fontSize: 13, color: '#475569', textAlign: 'center', lineHeight: 20 },
  confirmButtons: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginTop: 4,
  },
});
