/**
 * Modal de gestión de agrupaciones de familias Ágora para MIA.
 * Crear/editar (nombre, familias, activo) y borrar con confirmación.
 */
import { useEffect, useMemo, useState } from 'react';
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
  Switch,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useConfirmar } from '../../hooks/useConfirmar';
import { MIN_TOUCH } from '../../constants/layout';
import type { MiaFamilia, MiaGrupoFamilias } from '../../hooks/useMiaGruposFamilias';

type Props = {
  visible: boolean;
  onClose: () => void;
  grupos: MiaGrupoFamilias[];
  familias: MiaFamilia[];
  loading?: boolean;
  onGuardar: (input: {
    id?: string;
    nombre: string;
    familiaIds: string[];
    orden?: number;
    activo?: boolean;
  }) => Promise<void>;
  onBorrar: (id: string) => Promise<void>;
};

export function MiaGruposFamiliasModal({
  visible,
  onClose,
  grupos,
  familias,
  loading = false,
  onGuardar,
  onBorrar,
}: Props) {
  const { confirmar, ConfirmarView } = useConfirmar();
  const [editando, setEditando] = useState<MiaGrupoFamilias | null>(null);
  const [esNuevo, setEsNuevo] = useState(false);
  const [nombre, setNombre] = useState('');
  const [activo, setActivo] = useState(true);
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set());
  const [filtroFam, setFiltroFam] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setEditando(null);
      setEsNuevo(false);
      setError(null);
      setFiltroFam('');
    }
  }, [visible]);

  const familiasOrdenadas = useMemo(() => {
    const q = filtroFam.trim().toLowerCase();
    const list = [...familias].sort((a, b) =>
      a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }),
    );
    if (!q) return list;
    return list.filter(
      (f) => f.nombre.toLowerCase().includes(q) || f.id.toLowerCase().includes(q),
    );
  }, [familias, filtroFam]);

  const nombrePorId = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of familias) m.set(f.id, f.nombre || f.id);
    return m;
  }, [familias]);

  const abrirNueva = () => {
    setEditando({
      id: '',
      nombre: '',
      familiaIds: [],
      orden: grupos.length,
      activo: true,
    });
    setEsNuevo(true);
    setNombre('');
    setActivo(true);
    setSeleccionados(new Set());
    setFiltroFam('');
    setError(null);
  };

  const abrirEdicion = (g: MiaGrupoFamilias) => {
    setEditando(g);
    setEsNuevo(false);
    setNombre(g.nombre);
    setActivo(g.activo !== false);
    setSeleccionados(new Set(g.familiaIds));
    setFiltroFam('');
    setError(null);
  };

  const cerrarFormulario = () => {
    setEditando(null);
    setEsNuevo(false);
    setError(null);
  };

  const toggleFamilia = (id: string) => {
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
      setError('Selecciona al menos una familia');
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      await onGuardar({
        ...(esNuevo || !editando.id ? {} : { id: editando.id }),
        nombre: nombreLimpio,
        familiaIds: [...seleccionados],
        orden: editando.orden,
        activo,
      });
      cerrarFormulario();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  };

  const borrar = async (g: MiaGrupoFamilias) => {
    const ok = await confirmar(
      'Borrar agrupación',
      `¿Eliminar «${g.nombre}»? Esta acción no se puede deshacer.`,
      { confirmarLabel: 'Borrar', variant: 'danger' },
    );
    if (!ok) return;
    setGuardando(true);
    setError(null);
    try {
      await onBorrar(g.id);
      if (editando?.id === g.id) cerrarFormulario();
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
            <Text style={styles.title}>Agrupaciones de familias</Text>
            <TouchableOpacity onPress={handleClose} disabled={guardando} style={styles.iconBtn}>
              <MaterialIcons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <MaterialIcons name="error-outline" size={16} color="#dc2626" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {loading && !editando ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color="#0ea5e9" />
              <Text style={styles.vacio}>Cargando…</Text>
            </View>
          ) : !editando ? (
            <>
              <ScrollView style={styles.lista} nestedScrollEnabled>
                {grupos.length === 0 ? (
                  <Text style={styles.vacio}>
                    Aún no hay agrupaciones. Crea la primera para filtrar productos por familias
                    Ágora en el cálculo MIA.
                  </Text>
                ) : (
                  grupos.map((g) => (
                    <View key={g.id} style={styles.itemRow}>
                      <View style={styles.itemTextCol}>
                        <View style={styles.itemTitleRow}>
                          <Text style={styles.itemNombre} numberOfLines={1}>
                            {g.nombre}
                          </Text>
                          {g.activo === false ? (
                            <Text style={styles.badgeInactivo}>Inactiva</Text>
                          ) : null}
                        </View>
                        <Text style={styles.itemMeta} numberOfLines={2}>
                          {g.familiaIds.length}{' '}
                          {g.familiaIds.length === 1 ? 'familia' : 'familias'}
                          {g.familiaIds.length > 0
                            ? ` · ${g.familiaIds
                                .slice(0, 4)
                                .map((id) => nombrePorId.get(id) ?? id)
                                .join(', ')}${g.familiaIds.length > 4 ? '…' : ''}`
                            : ''}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={styles.iconBtn}
                        onPress={() => abrirEdicion(g)}
                        disabled={guardando}
                      >
                        <MaterialIcons name="edit" size={18} color="#0369a1" />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.iconBtn}
                        onPress={() => {
                          void borrar(g);
                        }}
                        disabled={guardando}
                      >
                        <MaterialIcons name="delete-outline" size={18} color="#dc2626" />
                      </TouchableOpacity>
                    </View>
                  ))
                )}
              </ScrollView>
              <TouchableOpacity
                style={[styles.nuevaBtn, guardando && styles.btnDisabled]}
                onPress={abrirNueva}
                disabled={guardando}
              >
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
                placeholder="Ej. Bebidas frías"
                placeholderTextColor="#94a3b8"
                editable={!guardando}
              />

              <View style={styles.activoRow}>
                <Text style={styles.labelInline}>Activa</Text>
                <Switch
                  value={activo}
                  onValueChange={setActivo}
                  disabled={guardando}
                  trackColor={{ false: '#cbd5e1', true: '#7dd3fc' }}
                  thumbColor={activo ? '#0ea5e9' : '#f8fafc'}
                />
              </View>

              <Text style={styles.label}>Familias ({seleccionados.size})</Text>
              <TextInput
                style={[styles.input, styles.filtroInput]}
                value={filtroFam}
                onChangeText={setFiltroFam}
                placeholder="Buscar familia…"
                placeholderTextColor="#94a3b8"
                editable={!guardando}
              />
              <ScrollView style={styles.familiasScroll} nestedScrollEnabled>
                {familiasOrdenadas.length === 0 ? (
                  <Text style={styles.vacio}>
                    {familias.length === 0
                      ? 'No hay familias disponibles desde Ágora.'
                      : 'Ninguna familia coincide con la búsqueda.'}
                  </Text>
                ) : (
                  familiasOrdenadas.map((f) => {
                    const checked = seleccionados.has(f.id);
                    return (
                      <TouchableOpacity
                        key={f.id}
                        style={[styles.checkRow, { minHeight: MIN_TOUCH }]}
                        onPress={() => toggleFamilia(f.id)}
                        disabled={guardando}
                      >
                        <MaterialIcons
                          name={checked ? 'check-box' : 'check-box-outline-blank'}
                          size={20}
                          color={checked ? '#0ea5e9' : '#cbd5e1'}
                        />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            style={[styles.checkText, checked && styles.checkTextSel]}
                            numberOfLines={1}
                          >
                            {f.nombre}
                          </Text>
                          {f.nombre !== f.id ? (
                            <Text style={styles.checkId} numberOfLines={1}>
                              {f.id}
                            </Text>
                          ) : null}
                        </View>
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>

              <View style={styles.formActions}>
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={cerrarFormulario}
                  disabled={guardando}
                >
                  <Text style={styles.cancelBtnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.guardarBtn, guardando && styles.btnDisabled]}
                  onPress={() => {
                    void guardar();
                  }}
                  disabled={guardando}
                >
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
      {ConfirmarView}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    padding: 16,
  },
  modal: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    width: '100%',
    maxWidth: 520,
    maxHeight: '90%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  title: { fontSize: 15, fontWeight: '700', color: '#334155' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    padding: 8,
    marginBottom: 10,
  },
  errorText: { fontSize: 12, color: '#dc2626', flex: 1 },
  loadingWrap: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  lista: { maxHeight: 320 },
  vacio: { fontSize: 12, color: '#64748b', paddingVertical: 12, lineHeight: 18 },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  itemTextCol: { flex: 1, minWidth: 0 },
  itemTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  itemNombre: { fontSize: 13, fontWeight: '600', color: '#334155', flexShrink: 1 },
  badgeInactivo: {
    fontSize: 10,
    fontWeight: '700',
    color: '#b45309',
    backgroundColor: '#fef3c7',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
  itemMeta: { fontSize: 10, color: '#94a3b8', marginTop: 2 },
  iconBtn: { padding: 6, minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, justifyContent: 'center', alignItems: 'center' },
  nuevaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 12,
    minHeight: MIN_TOUCH,
  },
  nuevaBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginTop: 10, marginBottom: 4 },
  labelInline: { fontSize: 12, fontWeight: '600', color: '#475569' },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#334155',
  },
  filtroInput: { marginBottom: 6 },
  activoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingVertical: 4,
  },
  familiasScroll: {
    maxHeight: 240,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 4,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  checkText: { fontSize: 13, color: '#475569' },
  checkTextSel: { color: '#0369a1', fontWeight: '600' },
  checkId: { fontSize: 10, color: '#94a3b8' },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  cancelBtn: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
  },
  cancelBtnText: { fontSize: 13, color: '#64748b', fontWeight: '600' },
  guardarBtn: {
    paddingVertical: 9,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
    minWidth: 90,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TOUCH,
  },
  guardarBtnText: { fontSize: 13, color: '#fff', fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
});
