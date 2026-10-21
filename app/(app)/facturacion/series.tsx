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
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';
import { TablaBasica } from '../../components/TablaBasica';
import { apiFetch } from '../../utils/api';

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;
/** Sin token: entre SPACING.lg (16) y SPACING.xl (24). */
const PADDING_MODAL = 20;
/** Ámbar más claro que colors.warning. */
const ICONO_AVISO = '#f59e0b';

/**
 * Representación completa de una serie de facturación tal como vive en la
 * tabla `Igp_FacturasSeries` (admin/edición). Es local porque hoy solo se
 * consume desde esta pantalla; si en el futuro otro módulo necesita el
 * shape completo, este tipo es candidato natural a moverse a
 * `app/types/factura.ts`.
 *
 * Relación con `SerieFactura` (en `app/types/factura.ts`): aquel es la vista
 * minimal usada por los selectores en `factura-detalle.tsx` (campos
 * opcionales, `tipo: string` tolerante). Este tipo es la fuente: campos
 * requeridos y `tipo: 'OUT' | 'IN'` estricto.
 */
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
    apiFetch('/api/facturacion/series')
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
      const res = await apiFetch('/api/facturacion/series', {
        method,
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
      const res = await apiFetch('/api/facturacion/series', {
        method: 'DELETE',
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
        <MaterialIcons name="lock" size={48} color={colors.textMuted} />
        <Text style={styles.noPermisoText}>No tienes permiso para acceder a esta sección</Text>
        <TouchableOpacity style={styles.backLink} onPress={() => router.push('/facturacion')}>
          <MaterialIcons name="arrow-back" size={18} color={colors.accent} />
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
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <MaterialIcons name="refresh" size={ICON_SIZE} color={colors.accent} />
            )}
          </TouchableOpacity>
        }
      />

      {/* Modal crear / editar */}
      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={cerrarModal}>
        {/* El fondo no cierra el formulario (evita perder datos); usar la X o Cancelar. */}
        <Pressable style={styles.modalOverlay}>
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
                    <MaterialIcons name="close" size={22} color={colors.textMuted} />
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
                      placeholderTextColor={colors.textMuted}
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
                      placeholderTextColor={colors.textMuted}
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
                    <Text style={styles.formHint}>
                      Se genera como: Código serie + Año de factura + Nº correlativo
                    </Text>
                  </View>
                  <View style={styles.formGroupRow}>
                    <Text style={styles.formLabel}>Activa</Text>
                    <Switch
                      value={form.activa}
                      onValueChange={(v) => setForm((p) => ({ ...p, activa: v }))}
                      disabled={guardando}
                      trackColor={{ false: colors.border, true: colors.accent }}
                      thumbColor={colors.surface}
                    />
                  </View>
                  <View style={styles.formGroup}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text style={styles.formLabel}>Reinicio anual</Text>
                      <Switch
                        value={form.reinicio_anual}
                        onValueChange={(v) => setForm((p) => ({ ...p, reinicio_anual: v }))}
                        disabled={guardando}
                        trackColor={{ false: colors.border, true: colors.accent }}
                        thumbColor={colors.surface}
                      />
                    </View>
                    <Text style={styles.formHint}>
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
                      placeholderTextColor={colors.textMuted}
                    />
                    <Text style={styles.formHint}>
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
                      placeholderTextColor={colors.textMuted}
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
                      <ActivityIndicator size="small" color={colors.surface} />
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
            <MaterialIcons name="warning" size={36} color={ICONO_AVISO} style={{ alignSelf: 'center' }} />
            <Text style={styles.confirmTitle}>Eliminar serie</Text>
            <Text style={styles.confirmText}>
              ¿Estás seguro de que quieres eliminar la serie{' '}
              <Text style={styles.confirmStrong}>{serieToDelete?.serie}</Text>?{'\n'}
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
                  <ActivityIndicator size="small" color={colors.surface} />
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
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: SPACING.md, padding: PADDING_MODAL },
  noPermisoText: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[14],
    color: colors.textMuted,
    textAlign: 'center',
  },
  backLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: SPACING.sm },
  backLinkText: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes[13],
    color: colors.accent,
    fontWeight: typography.nav.fontWeight,
  },

  badge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
  },
  badgeText: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes.badge,
    fontWeight: typography.boton.fontWeight,
  },
  badgeActiva: { backgroundColor: statusColors.success.bg },
  badgeInactiva: { backgroundColor: statusColors.danger.bg },
  badgeTextoActiva: { color: colors.success },
  badgeTextoInactiva: { color: colors.danger },
  badgeTipoOut: { backgroundColor: '#dbeafe' }, // azul de tipo OUT, sin token
  badgeTipoIn: { backgroundColor: statusColors.warning.bg },
  badgeTextoOut: { color: '#2563eb' }, // azul de tipo OUT, sin token
  badgeTextoIn: { color: statusColors.warning.text },

  refreshBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },

  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)', // más oscuro que colors.overlay
  },
  modalCenter: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    padding: PADDING_MODAL,
  },
  modalCardTouch: { width: '100%', maxWidth: 440 },
  modalCard: {
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: radius.xl,
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
    paddingHorizontal: PADDING_MODAL,
    paddingVertical: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[18],
    fontWeight: typography.boton.fontWeight,
    color: colors.textPrimary,
  },
  modalClose: { padding: SPACING.xs },
  modalBody: { paddingHorizontal: PADDING_MODAL, paddingVertical: SPACING.lg, maxHeight: 420 },

  formGroup: { marginBottom: SPACING.md },
  formGroupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  formLabel: {
    fontFamily: fontFamily.medium,
    fontSize: typography.etiqueta.fontSize,
    fontWeight: typography.nav.fontWeight,
    color: colors.textPrimary,
    marginBottom: SPACING.xs,
  },
  formHint: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes.badge,
    color: colors.textMuted,
    marginTop: 2,
  },
  formInput: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[12],
    padding: SPACING.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
  },
  formInputReadonly: { backgroundColor: colors.navActive, color: colors.textMuted },
  formatPreview: {
    padding: SPACING.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.accentMuted,
  },
  formatPreviewText: {
    fontSize: fontSizes[13],
    fontWeight: typography.boton.fontWeight,
    color: statusColors.info.text,
    fontFamily: Platform.OS === 'web' ? 'monospace' : fontFamily.semibold,
  },
  formInputMultiline: { minHeight: 64, textAlignVertical: 'top' },

  chipsRow: { flexDirection: 'row', gap: SPACING.sm },
  chip: {
    flex: 1,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.bg,
    alignItems: 'center',
  },
  chipSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentMuted,
  },
  chipText: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes[12],
    fontWeight: typography.nav.fontWeight,
    color: colors.textMuted,
  },
  chipTextSelected: {
    color: colors.accent,
    fontFamily: fontFamily.semibold,
    fontWeight: typography.boton.fontWeight,
  },

  modalError: {
    fontFamily: fontFamily.regular,
    fontSize: typography.etiqueta.fontSize,
    color: colors.danger,
    paddingHorizontal: PADDING_MODAL,
    paddingBottom: SPACING.xs,
  },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
    paddingHorizontal: PADDING_MODAL,
    paddingVertical: 14, // sin token: entre SPACING.md (12) y SPACING.lg (16)
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalFooterBtn: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.bg,
  },
  modalFooterBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes[12],
    fontWeight: typography.nav.fontWeight,
    color: colors.textMuted,
  },
  modalFooterBtnPrimary: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  modalFooterBtnTextPrimary: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[12],
    fontWeight: typography.boton.fontWeight,
    color: colors.surface,
  },
  modalFooterBtnDanger: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
  },
  modalFooterBtnTextDanger: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[12],
    fontWeight: typography.boton.fontWeight,
    color: colors.surface,
  },

  confirmCard: {
    width: '90%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: SPACING.xl,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    gap: SPACING.md,
  },
  confirmTitle: {
    fontFamily: fontFamily.bold,
    fontSize: fontSizes[16],
    fontWeight: typography.titulo.fontWeight,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  confirmText: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[13],
    color: colors.textPrimary,
    textAlign: 'center',
    lineHeight: 20,
  },
  confirmStrong: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  confirmButtons: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10, // sin token: entre SPACING.sm (8) y SPACING.md (12)
    marginTop: SPACING.xs,
  },
});
