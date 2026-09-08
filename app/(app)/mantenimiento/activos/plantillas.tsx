import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Modal,
  TouchableOpacity,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { TablaBasica } from '../../../components/TablaBasica';
import { useConfirmar } from '../../../hooks/useConfirmar';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../../constants/layout';
import { colors, inputCursorProps, statusColors } from '../../../constants/theme';
import { apiFetch, errorMessage } from '../../../utils/api';
import { EditorPlantilla, VistaHtmlPlantilla } from '../../../components/activos/EditorPlantilla';
import { CUERPO_PLANTILLA_DEFAULT, renderCuerpoPlantilla, sanitizarHtmlPlantilla } from '../../../lib/activosPlantilla';
import type { CategoriaActivo, PlantillaEntregaActivo } from '../../../types/activos';

const COLS = ['Nombre', 'Categorías'];

async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || fallback);
  return data;
}

export default function ActivosPlantillasScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackPanels, isCompact } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();

  const puedeVer = hasPermiso('activos.ver') || hasPermiso('activos.crear') || hasPermiso('activos.editar');
  const puedeCrear = hasPermiso('activos.crear');
  const puedeEditar = hasPermiso('activos.editar');
  const puedeBorrar = hasPermiso('activos.borrar');
  const puedeEscribir = puedeCrear || puedeEditar || puedeBorrar;

  const [plantillas, setPlantillas] = useState<PlantillaEntregaActivo[]>([]);
  const [categorias, setCategorias] = useState<CategoriaActivo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [modal, setModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [cuerpo, setCuerpo] = useState(CUERPO_PLANTILLA_DEFAULT);
  const [catIds, setCatIds] = useState<string[]>([]);
  const [errorForm, setErrorForm] = useState<string | null>(null);

  const preview = useMemo(() => renderCuerpoPlantilla(cuerpo), [cuerpo]);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rp, rc] = await Promise.all([
        apiFetch('/api/activos/plantillas?soloActivas=1&limite=200'),
        apiFetch('/api/activos/categorias?soloActivas=1&limite=200'),
      ]);
      const dp = await jsonOrThrow<{ plantillas?: PlantillaEntregaActivo[] }>(rp, 'No se pudieron cargar las plantillas');
      const dc = await jsonOrThrow<{ categorias?: CategoriaActivo[] }>(rc, 'No se pudieron cargar las categorías');
      setPlantillas(dp.plantillas || []);
      setCategorias((dc.categorias || []).filter((c) => c.activo !== false));
    } catch (e) {
      setError(errorMessage(e, 'No se pudieron cargar las plantillas'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (puedeVer) void cargar();
  }, [cargar, puedeVer]);

  const filtradas = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return plantillas;
    return plantillas.filter((p) => {
      const cats = (p.categorias || []).map((c) => c.nombre).join(' ');
      return `${p.nombre} ${cats}`.toLowerCase().includes(q);
    });
  }, [plantillas, filtro]);

  const abrirCrear = async () => {
    if (!puedeCrear) {
      await confirmar('Sin permiso', 'Necesitas el permiso de crear para añadir plantillas.');
      return;
    }
    setErrorForm(null);
    setEditId(null);
    setNombre('');
    setCuerpo(CUERPO_PLANTILLA_DEFAULT);
    setCatIds([]);
    setSelected(null);
    setModal(true);
  };

  const abrirEditar = async (index: number) => {
    if (!puedeEditar) {
      await confirmar('Sin permiso', 'Necesitas el permiso de editar para cambiar plantillas.');
      return;
    }
    const p = filtradas[index];
    if (!p) return;
    setErrorForm(null);
    setEditId(p.plantilla_id);
    setNombre(p.nombre);
    setCuerpo(p.cuerpo || CUERPO_PLANTILLA_DEFAULT);
    setCatIds(p.categoria_ids || []);
    setModal(true);
  };

  const pedirBaja = async (index: number) => {
    if (!puedeBorrar) {
      await confirmar('Sin permiso', 'Necesitas el permiso de borrar para quitar plantillas.');
      return;
    }
    const p = filtradas[index];
    if (!p) return;
    const ok = await confirmar(
      'Dar de baja plantilla',
      `Se ocultará «${p.nombre}» y se desasignará de las categorías.`,
      { confirmarLabel: 'Dar de baja', variant: 'danger' },
    );
    if (!ok) return;
    setGuardando(true);
    try {
      const res = await apiFetch(`/api/activos/plantillas/${p.plantilla_id}/baja`, { method: 'POST' });
      await jsonOrThrow(res, 'No se pudo dar de baja');
      setSelected(null);
      await cargar();
    } catch (e) {
      setError(errorMessage(e, 'No se pudo dar de baja'));
    } finally {
      setGuardando(false);
    }
  };

  const toggleCat = (id: string) => {
    setCatIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const guardar = async () => {
    setErrorForm(null);
    if (!nombre.trim()) {
      setErrorForm('El nombre es obligatorio');
      return;
    }
    if (!cuerpo.trim()) {
      setErrorForm('El texto de la plantilla no puede quedar vacío');
      return;
    }
    setGuardando(true);
    try {
      const body = { nombre: nombre.trim(), cuerpo: sanitizarHtmlPlantilla(cuerpo.trim()), categoria_ids: catIds };
      const res = await apiFetch(editId ? `/api/activos/plantillas/${editId}` : '/api/activos/plantillas', {
        method: editId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await jsonOrThrow(res, 'No se pudo guardar la plantilla');
      setModal(false);
      await cargar();
    } catch (e) {
      setErrorForm(errorMessage(e, 'No se pudo guardar la plantilla'));
    } finally {
      setGuardando(false);
    }
  };

  if (!puedeVer) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.vacio}>No tienes permiso para ver las plantillas de entrega.</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <TablaBasica<PlantillaEntregaActivo>
        title="Plantillas de entrega"
        onBack={() => router.push('/mantenimiento/activos' as never)}
        columnas={COLS}
        datos={filtradas}
        getValorCelda={(item, col) => {
          if (col === 'Nombre') return item.nombre;
          const noms = (item.categorias || []).map((c) => c.nombre);
          return noms.length ? noms.join(', ') : 'Sin asignar';
        }}
        loading={loading}
        error={error}
        onRetry={cargar}
        filtroBusqueda={filtro}
        onFiltroChange={setFiltro}
        selectedRowIndex={selected}
        onSelectRow={setSelected}
        onCrear={abrirCrear}
        onEditar={() => selected != null && void abrirEditar(selected)}
        onBorrar={() => selected != null && void pedirBaja(selected)}
        guardando={guardando}
        hideToolbarActions={!puedeEscribir}
        toolbarCrearLabel="Nueva plantilla"
        emptyMessage="No hay plantillas. Crea una para PDA, uniforme u otras categorías."
        emptyFilterMessage="Ninguna plantilla coincide"
        getRowKey={(item) => item.plantilla_id}
        defaultColWidth={220}
      />

      <Modal visible={modal} transparent animationType="fade" onRequestClose={() => setModal(false)}>
        <Pressable style={styles.overlay}>
          <KeyboardAvoidingView style={styles.center} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Pressable style={[styles.card, shouldStackPanels && styles.cardAncho]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{editId ? 'Editar plantilla' : 'Nueva plantilla'}</Text>
                <TouchableOpacity onPress={() => setModal(false)} style={styles.close} accessibilityLabel="Cerrar">
                  <MaterialIcons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
                <Text style={styles.label}>Nombre *</Text>
                <TextInput
                  style={styles.input}
                  value={nombre}
                  onChangeText={setNombre}
                  placeholder="Entrega de uniforme, PDA…"
                  placeholderTextColor={colors.textMuted}
                  {...inputCursorProps}
                />

                <Text style={styles.label}>Texto *</Text>
                <EditorPlantilla
                  html={cuerpo}
                  onChange={setCuerpo}
                  revision={editId || 'nueva'}
                />

                <Text style={styles.label}>Categorías que usan esta plantilla</Text>
                <View style={styles.chips}>
                  {categorias.map((c) => {
                    const on = catIds.includes(c.categoria_id);
                    return (
                      <TouchableOpacity
                        key={c.categoria_id}
                        style={[styles.chip, on && styles.chipOn]}
                        onPress={() => toggleCat(c.categoria_id)}
                      >
                        <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>
                          {c.prefijo_etiqueta} · {c.nombre}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                  {categorias.length === 0 ? (
                    <Text style={styles.hint}>Crea categorías en el catálogo para asignarlas aquí.</Text>
                  ) : null}
                </View>

                <Text style={styles.label}>Vista previa</Text>
                <View style={styles.preview}>
                  <VistaHtmlPlantilla html={preview} />
                </View>
              </ScrollView>
              {errorForm ? <Text style={styles.err}>{errorForm}</Text> : null}
              <View style={styles.footer}>
                <TouchableOpacity style={[styles.btn, isCompact && styles.btnTactil]} onPress={() => setModal(false)}>
                  <Text style={styles.btnTxt}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnPri, isCompact && styles.btnTactil]}
                  onPress={() => void guardar()}
                  disabled={guardando}
                >
                  <Text style={styles.btnPriTxt}>{guardando ? 'Guardando…' : 'Guardar'}</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc' },
  vacio: { padding: 16, color: colors.textMuted },
  overlay: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.45)', justifyContent: 'center' },
  center: { flex: 1, justifyContent: 'center', padding: 16 },
  card: {
    width: '100%',
    maxWidth: 720,
    maxHeight: '92%',
    backgroundColor: '#fff',
    borderRadius: 16,
    alignSelf: 'center',
    overflow: 'hidden',
  },
  cardAncho: { maxWidth: '100%' },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: colors.textPrimary },
  close: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 20, paddingVertical: 14 },
  label: { fontSize: 11, fontWeight: '600', color: colors.textSecondary, marginBottom: 4, marginTop: 10 },
  hint: { fontSize: 12, color: colors.textMuted, marginBottom: 6 },
  input: {
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 8,
    backgroundColor: colors.bgSubtle,
    color: colors.textPrimary,
  },
  cuerpo: { minHeight: 180, textAlignVertical: 'top', paddingTop: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  chip: {
    minHeight: 36,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  chipOn: { backgroundColor: colors.accentMuted, borderColor: colors.accent },
  chipTxt: { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  chipTxtOn: { color: colors.accentPressed, fontWeight: '700' },
  preview: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    backgroundColor: '#fff',
    marginBottom: 8,
  },
  previewTxt: { fontSize: 13, color: colors.textPrimary, lineHeight: 20 },
  err: { color: statusColors.danger.text, fontSize: 12, paddingHorizontal: 20, paddingBottom: 6 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  btn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgSubtle },
  btnTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 20 },
  btnTxt: { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  btnPri: { backgroundColor: colors.accent, borderColor: colors.accent },
  btnPriTxt: { fontSize: 13, color: '#fff', fontWeight: '600' },
});
