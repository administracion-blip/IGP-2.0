import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { TablaBasica } from '../../components/TablaBasica';
import { errorMessage } from '../../utils/api';
import { useAuth } from '../../contexts/AuthContext';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  typography,
  SPACING,
} from '../../constants/theme';
import {
  type Franja,
  type PlantillaFranjas,
  obtenerPlantillasFranjas,
  crearPlantillaFranjas,
  actualizarPlantillaFranjas,
  borrarPlantillaFranjas,
} from '../../lib/ventasPorHoraApi';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const COLUMNAS = ['Nombre', 'Nº franjas', 'Franjas'];

function resumenFranjas(franjas: Franja[]): string {
  if (franjas.length === 0) return '—';
  return franjas.map((f) => (f.etiqueta ? `${f.etiqueta} ${f.desde}-${f.hasta}` : `${f.desde}-${f.hasta}`)).join(', ');
}

export default function FranjasHorariasScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const puedeEditar = hasPermiso('franjas.editar');
  const [plantillas, setPlantillas] = useState<PlantillaFranjas[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState('');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [formNombre, setFormNombre] = useState('');
  const [formFranjas, setFormFranjas] = useState<Franja[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const cargar = useCallback(() => {
    setLoading(true);
    obtenerPlantillasFranjas()
      .then((p) => { setPlantillas(p); setError(null); })
      .catch((e) => setError(errorMessage(e, 'Error al cargar plantillas')))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const datos = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return plantillas;
    return plantillas.filter((p) => p.nombre.toLowerCase().includes(q));
  }, [plantillas, filtro]);

  const getValorCelda = useCallback((item: PlantillaFranjas, col: string): string => {
    if (col === 'Nombre') return item.nombre;
    if (col === 'Nº franjas') return String(item.franjas.length);
    if (col === 'Franjas') return resumenFranjas(item.franjas);
    return '';
  }, []);

  const abrirCrear = useCallback(() => {
    setEditId(null);
    setFormNombre('');
    setFormFranjas([{ desde: '', hasta: '', etiqueta: '' }]);
    setFormError(null);
    setModalOpen(true);
  }, []);

  const abrirEditar = useCallback((item: PlantillaFranjas) => {
    setEditId(item.plantillaId);
    setFormNombre(item.nombre);
    setFormFranjas(item.franjas.length > 0 ? item.franjas.map((f) => ({ ...f, etiqueta: f.etiqueta ?? '' })) : [{ desde: '', hasta: '', etiqueta: '' }]);
    setFormError(null);
    setModalOpen(true);
  }, []);

  const borrar = useCallback(async (item: PlantillaFranjas) => {
    setGuardando(true);
    try {
      await borrarPlantillaFranjas(item.plantillaId);
      setSelectedIndex(null);
      cargar();
    } catch (e) {
      setError(errorMessage(e, 'Error al borrar'));
    } finally {
      setGuardando(false);
    }
  }, [cargar]);

  const setFranja = useCallback((idx: number, campo: keyof Franja, valor: string) => {
    setFormFranjas((prev) => prev.map((f, i) => (i === idx ? { ...f, [campo]: valor } : f)));
  }, []);

  const addFranja = useCallback(() => {
    setFormFranjas((prev) => [...prev, { desde: '', hasta: '', etiqueta: '' }]);
  }, []);

  const removeFranja = useCallback((idx: number) => {
    setFormFranjas((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const guardar = useCallback(async () => {
    const nombre = formNombre.trim();
    if (!nombre) { setFormError('El nombre es obligatorio'); return; }
    const franjasLimpias: Franja[] = [];
    for (const f of formFranjas) {
      const desde = f.desde.trim();
      const hasta = f.hasta.trim();
      if (!desde && !hasta && !(f.etiqueta ?? '').trim()) continue; // fila vacía: se ignora
      if (!HHMM_RE.test(desde) || !HHMM_RE.test(hasta)) {
        setFormError('Cada franja necesita "desde" y "hasta" en formato HH:MM (00:00–23:59)');
        return;
      }
      const etiqueta = (f.etiqueta ?? '').trim();
      franjasLimpias.push(etiqueta ? { desde, hasta, etiqueta } : { desde, hasta });
    }
    if (franjasLimpias.length === 0) { setFormError('Añade al menos una franja'); return; }
    setGuardando(true);
    setFormError(null);
    try {
      if (editId) {
        await actualizarPlantillaFranjas(editId, nombre, franjasLimpias);
      } else {
        await crearPlantillaFranjas(nombre, franjasLimpias);
      }
      setModalOpen(false);
      setSelectedIndex(null);
      cargar();
    } catch (e) {
      setFormError(errorMessage(e, 'Error al guardar'));
    } finally {
      setGuardando(false);
    }
  }, [formNombre, formFranjas, editId, cargar]);

  return (
    <View style={styles.container}>
      <TablaBasica<PlantillaFranjas>
        title="Plantillas de franjas horarias"
        onBack={() => router.back()}
        columnas={COLUMNAS}
        datos={datos}
        getValorCelda={getValorCelda}
        loading={loading}
        error={error}
        onRetry={cargar}
        filtroBusqueda={filtro}
        onFiltroChange={setFiltro}
        selectedRowIndex={selectedIndex}
        onSelectRow={setSelectedIndex}
        onCrear={abrirCrear}
        onEditar={abrirEditar}
        onBorrar={borrar}
        guardando={guardando}
        hideToolbarActions={!puedeEditar}
        emptyMessage={puedeEditar ? 'No hay plantillas. Crea la primera.' : 'No hay plantillas.'}
        toolbarCrearLabel="Crear plantilla"
      />

      <Modal visible={modalOpen} transparent animationType="fade" onRequestClose={() => !guardando && setModalOpen(false)}>
        <Pressable style={styles.overlay} onPress={() => !guardando && setModalOpen(false)}>
          <Pressable onPress={() => {}} style={styles.modal}>
            <Text style={styles.modalTitle}>{editId ? 'Editar plantilla' : 'Crear plantilla'}</Text>

            <Text style={styles.label}>Nombre</Text>
            <TextInput
              style={styles.input}
              value={formNombre}
              onChangeText={setFormNombre}
              placeholder="Ej. Restaurante entre semana"
              placeholderTextColor={colors.textMuted}
            />

            <View style={styles.franjasHeader}>
              <Text style={styles.label}>Franjas</Text>
              <TouchableOpacity style={styles.addBtn} onPress={addFranja}>
                <MaterialIcons name="add" size={16} color={colors.accent} />
                <Text style={styles.addBtnText}>Añadir franja</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.franjasScroll} nestedScrollEnabled>
              {formFranjas.map((f, idx) => (
                <View key={idx} style={styles.franjaRow}>
                  <View style={styles.franjaCol}>
                    <Text style={styles.franjaLabel}>Desde</Text>
                    <TextInput
                      style={styles.inputSmall}
                      value={f.desde}
                      onChangeText={(v) => setFranja(idx, 'desde', v)}
                      placeholder="12:00"
                      placeholderTextColor={colors.borderStrong}
                      maxLength={5}
                    />
                  </View>
                  <View style={styles.franjaCol}>
                    <Text style={styles.franjaLabel}>Hasta</Text>
                    <TextInput
                      style={styles.inputSmall}
                      value={f.hasta}
                      onChangeText={(v) => setFranja(idx, 'hasta', v)}
                      placeholder="16:00"
                      placeholderTextColor={colors.borderStrong}
                      maxLength={5}
                    />
                  </View>
                  <View style={styles.franjaColWide}>
                    <Text style={styles.franjaLabel}>Etiqueta (opcional)</Text>
                    <TextInput
                      style={styles.inputSmall}
                      value={f.etiqueta ?? ''}
                      onChangeText={(v) => setFranja(idx, 'etiqueta', v)}
                      placeholder="Comida"
                      placeholderTextColor={colors.borderStrong}
                    />
                  </View>
                  <TouchableOpacity style={styles.removeBtn} onPress={() => removeFranja(idx)} accessibilityLabel="Quitar franja">
                    <MaterialIcons name="delete-outline" size={18} color={colors.danger} />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>

            {formError ? <Text style={styles.formError}>{formError}</Text> : null}

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => !guardando && setModalOpen(false)} disabled={guardando}>
                <Text style={styles.cancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.saveBtn, guardando && styles.saveBtnDisabled]} onPress={guardar} disabled={guardando}>
                {guardando ? <ActivityIndicator size="small" color={colors.surface} /> : <Text style={styles.saveText}>Guardar</Text>}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1 },
  /** Más claro que colors.overlay. */
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.3)', padding: 20 },
  modal: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: 20, width: '100%', maxWidth: 560, maxHeight: '85%' },
  modalTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, marginBottom: SPACING.md },
  label: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, marginBottom: SPACING.xs },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    fontFamily: fontFamily.regular, fontSize: fontSizes[13],
    color: colors.textPrimary,
    marginBottom: SPACING.md,
  },
  franjasHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  addBtnText: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  franjasScroll: { maxHeight: 260 },
  franjaRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginBottom: SPACING.sm },
  franjaCol: { width: 64 },
  franjaColWide: { flex: 1, minWidth: 0 },
  franjaLabel: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginBottom: 2 },
  inputSmall: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 5, // 5 px; radius.sm es 6
    paddingHorizontal: 6,
    paddingVertical: SPACING.xs,
    fontFamily: fontFamily.regular, fontSize: fontSizes[12],
    color: colors.textPrimary,
  },
  removeBtn: { padding: 6, marginBottom: 1 },
  formError: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, marginTop: SPACING.sm },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: SPACING.lg },
  cancelBtn: { paddingVertical: 10, paddingHorizontal: SPACING.lg, borderRadius: RADIO_MEDIO, backgroundColor: colors.navActive },
  cancelText: { fontSize: fontSizes[13], color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  saveBtn: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: RADIO_MEDIO, backgroundColor: colors.accent, minWidth: 90, alignItems: 'center' },
  saveBtnDisabled: { opacity: 0.6 },
  saveText: { fontSize: fontSizes[13], color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
});
