/**
 * Modal de gestión de agrupaciones de locales para el widget de Objetivos.
 * Permite crear/editar (nombre, color, locales) y borrar agrupaciones.
 */
import { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import {
  type AgrupacionObjetivo,
  COLORES_AGRUPACION,
  nuevoIdAgrupacion,
} from '../../hooks/useAgrupacionesObjetivos';

type LocalSel = {
  id_Locales?: string;
  nombre?: string;
  Nombre?: string;
  agoraCode?: string;
  AgoraCode?: string;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  locales: LocalSel[];
  agrupaciones: AgrupacionObjetivo[];
  onGuardar: (a: AgrupacionObjetivo) => Promise<void>;
  onBorrar: (id: string) => Promise<void>;
};

function nombreLocal(l: LocalSel): string {
  return String(l.nombre ?? l.Nombre ?? l.agoraCode ?? l.AgoraCode ?? '—').trim();
}

export function AgrupacionesObjetivosModal({
  visible,
  onClose,
  locales,
  agrupaciones,
  onGuardar,
  onBorrar,
}: Props) {
  const [editando, setEditando] = useState<AgrupacionObjetivo | null>(null);
  const [nombre, setNombre] = useState('');
  const [color, setColor] = useState<string>(COLORES_AGRUPACION[0]);
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set());
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localesOrdenados = useMemo(
    () =>
      [...locales]
        .filter((l) => (l.id_Locales ?? '').toString().trim())
        .sort((a, b) => nombreLocal(a).localeCompare(nombreLocal(b), 'es', { sensitivity: 'base' })),
    [locales],
  );

  const nombrePorId = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of locales) {
      const id = String(l.id_Locales ?? '').trim();
      if (id) m.set(id, nombreLocal(l));
    }
    return m;
  }, [locales]);

  const abrirNueva = () => {
    setEditando({ id: nuevoIdAgrupacion(), nombre: '', localIds: [], color: COLORES_AGRUPACION[0], orden: agrupaciones.length });
    setNombre('');
    setColor(COLORES_AGRUPACION[0]);
    setSeleccionados(new Set());
    setError(null);
  };

  const abrirEdicion = (a: AgrupacionObjetivo) => {
    setEditando(a);
    setNombre(a.nombre);
    setColor(a.color);
    setSeleccionados(new Set(a.localIds));
    setError(null);
  };

  const cerrarFormulario = () => {
    setEditando(null);
    setError(null);
  };

  const toggleLocal = (id: string) => {
    setSeleccionados((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  };

  const guardar = async () => {
    if (!editando) return;
    const nombreLimpio = nombre.trim();
    if (!nombreLimpio) {
      setError('Indica un nombre para la agrupación');
      return;
    }
    if (seleccionados.size === 0) {
      setError('Selecciona al menos un local');
      return;
    }
    setGuardando(true);
    try {
      await onGuardar({
        ...editando,
        nombre: nombreLimpio,
        color,
        localIds: [...seleccionados],
      });
      cerrarFormulario();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  };

  const borrar = async (id: string) => {
    setGuardando(true);
    try {
      await onBorrar(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al borrar');
    } finally {
      setGuardando(false);
    }
  };

  const handleClose = () => {
    if (guardando) return;
    cerrarFormulario();
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable style={styles.overlay} onPress={handleClose}>
        <Pressable style={styles.modal} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>Agrupaciones de locales</Text>
            <TouchableOpacity onPress={handleClose} disabled={guardando}>
              <MaterialIcons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <MaterialIcons name="error-outline" size={16} color="#dc2626" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {!editando ? (
            <>
              <ScrollView style={styles.lista} nestedScrollEnabled>
                {agrupaciones.length === 0 ? (
                  <Text style={styles.vacio}>Aún no hay agrupaciones. Crea la primera para sumar los objetivos de varios locales.</Text>
                ) : (
                  agrupaciones.map((a) => (
                    <View key={a.id} style={styles.itemRow}>
                      <View style={[styles.colorDot, { backgroundColor: a.color }]} />
                      <View style={styles.itemTextCol}>
                        <Text style={styles.itemNombre} numberOfLines={1}>{a.nombre}</Text>
                        <Text style={styles.itemMeta} numberOfLines={1}>
                          {a.localIds.length} {a.localIds.length === 1 ? 'local' : 'locales'}
                          {a.localIds.length > 0
                            ? ` · ${a.localIds.map((id) => nombrePorId.get(id) ?? '—').join(', ')}`
                            : ''}
                        </Text>
                      </View>
                      <TouchableOpacity style={styles.iconBtn} onPress={() => abrirEdicion(a)} disabled={guardando}>
                        <MaterialIcons name="edit" size={18} color="#0369a1" />
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.iconBtn} onPress={() => borrar(a.id)} disabled={guardando}>
                        <MaterialIcons name="delete-outline" size={18} color="#dc2626" />
                      </TouchableOpacity>
                    </View>
                  ))
                )}
              </ScrollView>
              <TouchableOpacity style={styles.nuevaBtn} onPress={abrirNueva} disabled={guardando}>
                <MaterialIcons name="add" size={18} color="#fff" />
                <Text style={styles.nuevaBtnText}>Nueva agrupación</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.label}>Nombre</Text>
              <TextInput
                style={styles.input}
                value={nombre}
                onChangeText={setNombre}
                placeholder="Ej. Calle Moras"
                placeholderTextColor="#94a3b8"
              />

              <Text style={styles.label}>Color</Text>
              <View style={styles.coloresRow}>
                {COLORES_AGRUPACION.map((c) => (
                  <TouchableOpacity
                    key={c}
                    style={[styles.colorSwatch, { backgroundColor: c }, color === c && styles.colorSwatchSel]}
                    onPress={() => setColor(c)}
                  >
                    {color === c ? <MaterialIcons name="check" size={14} color="#fff" /> : null}
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.label}>Locales ({seleccionados.size})</Text>
              <ScrollView style={styles.localesScroll} nestedScrollEnabled>
                {localesOrdenados.map((l) => {
                  const id = String(l.id_Locales ?? '').trim();
                  const checked = seleccionados.has(id);
                  return (
                    <TouchableOpacity key={id} style={styles.checkRow} onPress={() => toggleLocal(id)}>
                      <MaterialIcons
                        name={checked ? 'check-box' : 'check-box-outline-blank'}
                        size={20}
                        color={checked ? '#0ea5e9' : '#cbd5e1'}
                      />
                      <Text style={[styles.checkText, checked && styles.checkTextSel]}>{nombreLocal(l)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              <View style={styles.formActions}>
                <TouchableOpacity style={styles.cancelBtn} onPress={cerrarFormulario} disabled={guardando}>
                  <Text style={styles.cancelBtnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.guardarBtn} onPress={guardar} disabled={guardando}>
                  {guardando ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.guardarBtnText}>Guardar</Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.35)', padding: 16 },
  modal: { backgroundColor: '#fff', borderRadius: 14, padding: 16, width: '100%', maxWidth: 460, maxHeight: '85%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { fontSize: 15, fontWeight: '700', color: '#334155' },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fef2f2', borderRadius: 8, padding: 8, marginBottom: 10 },
  errorText: { fontSize: 12, color: '#dc2626', flex: 1 },
  lista: { maxHeight: 280 },
  vacio: { fontSize: 12, color: '#64748b', paddingVertical: 12, lineHeight: 18 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  colorDot: { width: 12, height: 12, borderRadius: 6 },
  itemTextCol: { flex: 1, minWidth: 0 },
  itemNombre: { fontSize: 13, fontWeight: '600', color: '#334155' },
  itemMeta: { fontSize: 10, color: '#94a3b8' },
  iconBtn: { padding: 6 },
  nuevaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 12,
  },
  nuevaBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginTop: 10, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#334155',
  },
  coloresRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  colorSwatch: { width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  colorSwatchSel: { borderWidth: 2, borderColor: '#334155' },
  localesScroll: { maxHeight: 220, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, padding: 4 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 4 },
  checkText: { fontSize: 13, color: '#475569' },
  checkTextSel: { color: '#0369a1', fontWeight: '600' },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  cancelBtn: { paddingVertical: 9, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  cancelBtnText: { fontSize: 13, color: '#64748b', fontWeight: '600' },
  guardarBtn: { paddingVertical: 9, paddingHorizontal: 20, borderRadius: 8, backgroundColor: '#0ea5e9', minWidth: 90, alignItems: 'center' },
  guardarBtnText: { fontSize: 13, color: '#fff', fontWeight: '600' },
});
