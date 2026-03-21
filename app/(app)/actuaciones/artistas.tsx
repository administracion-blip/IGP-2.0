import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  ActivityIndicator,
  Switch,
  Platform,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { useLocalToast } from '../../components/Toast';
import { API_BASE_URL as API_URL } from '../../utils/apiBaseUrl';

const ESTILOS_OPTS = [
  'pop', 'rock', 'flamenco', 'rumba', 'jazz', 'latina', 'electronica', 'comercial', 'urbana', 'versiones', 'chill', 'tributo',
];
const TIPO_OPTS = ['solista', 'duo', 'trio', 'banda', 'dj', 'tributo', 'animacion', 'espectaculo'];
const TIPO_DIA_TARIFA = ['laborable', 'fin_semana', 'festivo'];
const FRANJA_TARIFA = ['mañana', 'tarde', 'noche'];

type TarifaRow = { codigo?: string; tipo_dia: string; franja: string; importe: number };
type Artista = {
  id_artista: string;
  nombre_artistico: string;
  componentes?: number;
  estilos_musicales?: string[];
  tipo_artista?: string[];
  imagen_key?: string;
  activo?: boolean;
  telefono_contacto?: string;
  email_contacto?: string;
  observaciones?: string;
  tarifas?: TarifaRow[];
};

const emptyArtista = (): Partial<Artista> => ({
  nombre_artistico: '',
  componentes: 1,
  estilos_musicales: [],
  tipo_artista: [],
  activo: true,
  telefono_contacto: '',
  email_contacto: '',
  observaciones: '',
  tarifas: [],
});

export default function ArtistasScreen() {
  const router = useRouter();
  const { show: showToast, ToastView } = useLocalToast();
  const [lista, setLista] = useState<Artista[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Artista> | null>(null);
  const [saving, setSaving] = useState(false);
  const [tarifas, setTarifas] = useState<TarifaRow[]>([]);
  const [modalError, setModalError] = useState<string | null>(null);

  const fetchLista = useCallback(() => {
    setLoading(true);
    fetch(`${API_URL}/api/artistas`)
      .then((r) => r.json())
      .then((d) => setLista(d.artistas || []))
      .catch(() => setLista([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchLista();
  }, [fetchLista]);

  function abrirNuevo() {
    setEditing(emptyArtista());
    setTarifas([]);
    setModalError(null);
    setModalOpen(true);
  }

  function abrirEditar(a: Artista) {
    setEditing({ ...a });
    setTarifas(Array.isArray(a.tarifas) ? [...a.tarifas] : []);
    setModalError(null);
    setModalOpen(true);
  }

  function cerrarModal() {
    setModalOpen(false);
    setModalError(null);
  }

  async function guardar() {
    if (!editing?.nombre_artistico?.trim()) {
      const msg = 'Indica el nombre artístico del artista o grupo.';
      setModalError(msg);
      showToast('Falta el nombre', msg, 'warning');
      return;
    }
    setModalError(null);
    setSaving(true);
    const tarifasLimpias = tarifas.map((t) => {
      const imp = Number(t.importe);
      return {
        ...(t.codigo != null && String(t.codigo).trim() !== '' ? { codigo: String(t.codigo).trim() } : {}),
        tipo_dia: t.tipo_dia || 'laborable',
        franja: t.franja || 'noche',
        importe: Number.isFinite(imp) ? Math.round(imp * 100) / 100 : 0,
      };
    });
    const body: Record<string, unknown> = {
      nombre_artistico: editing.nombre_artistico,
      componentes: Number(editing.componentes) || 1,
      estilos_musicales: Array.isArray(editing.estilos_musicales) ? editing.estilos_musicales : [],
      tipo_artista: Array.isArray(editing.tipo_artista) ? editing.tipo_artista : [],
      imagen_key: editing.imagen_key ?? '',
      activo: editing.activo !== false,
      telefono_contacto: editing.telefono_contacto ?? '',
      email_contacto: editing.email_contacto ?? '',
      observaciones: editing.observaciones ?? '',
      tarifas: tarifasLimpias,
    };
    try {
      const isNew = !editing.id_artista;
      const url = isNew
        ? `${API_URL}/api/artistas`
        : `${API_URL}/api/artistas/${editing.id_artista}`;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let data: { error?: string } = {};
      try {
        data = text ? (JSON.parse(text) as { error?: string }) : {};
      } catch {
        throw new Error(text?.slice(0, 200) || `Respuesta no válida (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(data.error || `Error al guardar (HTTP ${res.status})`);
      setModalOpen(false);
      setModalError(null);
      showToast('Artista guardado', 'Los datos se han guardado correctamente.', 'success');
      fetchLista();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error desconocido';
      const hint =
        /fetch|NetworkError|Failed to fetch|aborted/i.test(msg)
          ? ` No se pudo conectar con ${API_URL}. Comprueba que el API esté en marcha y que EXPO_PUBLIC_API_URL sea correcto.`
          : '';
      setModalError(msg + hint);
      showToast('No se pudo guardar', msg + hint, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function subirImagen(idArtista: string) {
    const pick = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true });
    if (pick.canceled || !pick.assets?.[0]) return;
    const asset = pick.assets[0];
    const form = new FormData();
    form.append('file', {
      uri: asset.uri,
      name: asset.name || 'imagen.jpg',
      type: asset.mimeType || 'image/jpeg',
    } as unknown as Blob);
    const res = await fetch(`${API_URL}/api/artistas/${idArtista}/imagen`, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) {
      showToast('Error', data.error || 'No se pudo subir', 'error');
      return;
    }
    showToast('OK', 'Imagen guardada', 'success');
    fetchLista();
  }

  function toggleEstilo(e: string) {
    if (!editing) return;
    const cur = new Set(editing.estilos_musicales || []);
    if (cur.has(e)) cur.delete(e);
    else cur.add(e);
    setEditing({ ...editing, estilos_musicales: [...cur] });
  }

  function toggleTipo(e: string) {
    if (!editing) return;
    const cur = new Set(editing.tipo_artista || []);
    if (cur.has(e)) cur.delete(e);
    else cur.add(e);
    setEditing({ ...editing, tipo_artista: [...cur] });
  }

  return (
    <View style={styles.container}>
      {ToastView}
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Artistas</Text>
        <TouchableOpacity style={styles.addBtn} onPress={abrirNuevo}>
          <MaterialIcons name="add" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color="#0ea5e9" />
      ) : (
        <ScrollView style={styles.scroll}>
          {lista.map((a) => (
            <TouchableOpacity key={a.id_artista} style={styles.row} onPress={() => abrirEditar(a)} activeOpacity={0.75}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{a.nombre_artistico}</Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {a.activo === false ? 'Inactivo · ' : ''}
                  {Array.isArray(a.tipo_artista) ? a.tipo_artista.join(', ') : '—'}
                </Text>
              </View>
              <MaterialIcons name="edit" size={20} color="#64748b" />
            </TouchableOpacity>
          ))}
          {lista.length === 0 ? <Text style={styles.empty}>No hay artistas. Pulsa + para crear.</Text> : null}
        </ScrollView>
      )}

      <Modal visible={modalOpen} animationType="slide" transparent onRequestClose={cerrarModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editing?.id_artista ? 'Editar artista' : 'Nuevo artista'}</Text>
              <TouchableOpacity onPress={cerrarModal}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              <Text style={styles.label}>Nombre artístico *</Text>
              <TextInput
                style={[styles.input, modalError ? styles.inputError : undefined]}
                value={editing?.nombre_artistico || ''}
                onChangeText={(t) => {
                  setModalError(null);
                  editing && setEditing({ ...editing, nombre_artistico: t });
                }}
                placeholder="Nombre o grupo"
              />
              <Text style={styles.label}>Componentes</Text>
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                value={String(editing?.componentes ?? 1)}
                onChangeText={(t) => editing && setEditing({ ...editing, componentes: parseInt(t, 10) || 1 })}
              />
              <Text style={styles.label}>Estilos musicales</Text>
              <View style={styles.chips}>
                {ESTILOS_OPTS.map((e) => (
                  <TouchableOpacity
                    key={e}
                    style={[styles.chip, (editing?.estilos_musicales || []).includes(e) && styles.chipOn]}
                    onPress={() => toggleEstilo(e)}
                  >
                    <Text style={[styles.chipText, (editing?.estilos_musicales || []).includes(e) && styles.chipTextOn]}>{e}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.label}>Tipo artista</Text>
              <View style={styles.chips}>
                {TIPO_OPTS.map((e) => (
                  <TouchableOpacity
                    key={e}
                    style={[styles.chip, (editing?.tipo_artista || []).includes(e) && styles.chipOn]}
                    onPress={() => toggleTipo(e)}
                  >
                    <Text style={[styles.chipText, (editing?.tipo_artista || []).includes(e) && styles.chipTextOn]}>{e}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.rowBetween}>
                <Text style={styles.label}>Activo</Text>
                <Switch
                  value={editing?.activo !== false}
                  onValueChange={(v) => editing && setEditing({ ...editing, activo: v })}
                />
              </View>
              <Text style={styles.label}>Teléfono</Text>
              <TextInput
                style={styles.input}
                value={editing?.telefono_contacto || ''}
                onChangeText={(t) => editing && setEditing({ ...editing, telefono_contacto: t })}
                keyboardType="phone-pad"
              />
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                value={editing?.email_contacto || ''}
                onChangeText={(t) => editing && setEditing({ ...editing, email_contacto: t })}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <Text style={styles.label}>Observaciones</Text>
              <TextInput
                style={[styles.input, { minHeight: 72 }]}
                multiline
                value={editing?.observaciones || ''}
                onChangeText={(t) => editing && setEditing({ ...editing, observaciones: t })}
              />

              <Text style={styles.label}>Tarifas (tipo día + franja + importe)</Text>
              {tarifas.map((tr, idx) => (
                <View key={idx} style={styles.tarifaRow}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 40 }}>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {TIPO_DIA_TARIFA.map((td) => (
                        <TouchableOpacity
                          key={td}
                          style={[styles.miniChip, tr.tipo_dia === td && styles.chipOn]}
                          onPress={() => {
                            const n = [...tarifas];
                            n[idx] = { ...n[idx], tipo_dia: td };
                            setTarifas(n);
                          }}
                        >
                          <Text style={styles.chipText}>{td}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </ScrollView>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 40 }}>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {FRANJA_TARIFA.map((fr) => (
                        <TouchableOpacity
                          key={fr}
                          style={[styles.miniChip, tr.franja === fr && styles.chipOn]}
                          onPress={() => {
                            const n = [...tarifas];
                            n[idx] = { ...n[idx], franja: fr };
                            setTarifas(n);
                          }}
                        >
                          <Text style={styles.chipText}>{fr}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </ScrollView>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    keyboardType="decimal-pad"
                    placeholder="Importe €"
                    value={String(tr.importe ?? '')}
                    onChangeText={(t) => {
                      const n = [...tarifas];
                      n[idx] = { ...n[idx], importe: parseFloat(t.replace(',', '.')) || 0 };
                      setTarifas(n);
                    }}
                  />
                  <TouchableOpacity onPress={() => setTarifas(tarifas.filter((_, i) => i !== idx))}>
                    <MaterialIcons name="delete-outline" size={22} color="#dc2626" />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity style={styles.addTarifa} onPress={() => setTarifas([...tarifas, { tipo_dia: 'laborable', franja: 'noche', importe: 0 }])}>
                <Text style={styles.addTarifaText}>+ Añadir tarifa</Text>
              </TouchableOpacity>

              {editing?.id_artista ? (
                <TouchableOpacity style={styles.imgBtn} onPress={() => subirImagen(editing.id_artista!)}>
                  <MaterialIcons name="image" size={20} color="#0369a1" />
                  <Text style={styles.imgBtnText}>Subir / cambiar imagen</Text>
                </TouchableOpacity>
              ) : null}

              {modalError ? (
                <View style={styles.errorBanner}>
                  <MaterialIcons name="error-outline" size={18} color="#b91c1c" />
                  <Text style={styles.errorBannerText}>{modalError}</Text>
                </View>
              ) : null}

              <Pressable
                style={({ pressed }) => [styles.saveBtn, saving && styles.saveBtnDisabled, pressed && !saving && styles.saveBtnPressed]}
                onPress={() => guardar()}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="Guardar artista"
              >
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Guardar</Text>}
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#e2e8f0', padding: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  backBtn: { padding: 4 },
  title: { flex: 1, fontSize: 20, fontWeight: '700', color: '#334155' },
  addBtn: { backgroundColor: '#0ea5e9', borderRadius: 10, padding: 8 },
  scroll: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  rowTitle: { fontSize: 15, fontWeight: '600', color: '#334155' },
  rowSub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  empty: { textAlign: 'center', color: '#94a3b8', marginTop: 24, fontStyle: 'italic' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '92%', paddingBottom: 24 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#334155' },
  modalScroll: { padding: 16 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 4, marginTop: 10 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    fontSize: 14,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  chipText: { fontSize: 11, color: '#64748b' },
  chipTextOn: { color: '#0369a1', fontWeight: '600' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  tarifaRow: { marginBottom: 10, gap: 6 },
  miniChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: '#e2e8f0' },
  addTarifa: { padding: 10, alignItems: 'center' },
  addTarifaText: { color: '#0ea5e9', fontWeight: '600', fontSize: 13 },
  imgBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, padding: 10, backgroundColor: '#f0f9ff', borderRadius: 8 },
  imgBtnText: { color: '#0369a1', fontWeight: '600' },
  saveBtn: { backgroundColor: '#0ea5e9', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 12 },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnPressed: { opacity: 0.85 },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  inputError: { borderColor: '#f87171', backgroundColor: '#fff7ed' },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorBannerText: { flex: 1, fontSize: 12, color: '#991b1b', lineHeight: 18 },
});
