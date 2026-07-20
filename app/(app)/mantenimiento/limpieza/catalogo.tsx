import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Modal,
  Switch,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { apiFetch } from '../../../utils/api';

type ProductoDosis = { producto: string; dosis: string; epi: string };
type TipoLimpieza = {
  id_tipo: string;
  nombre: string;
  descripcion_procedimiento?: string;
  productos_y_dosis?: ProductoDosis[];
  requiere_vaciado_previo?: boolean;
  frecuencia_por_defecto?: string;
  activo?: boolean;
};

const FRECUENCIAS = ['diaria', 'cada_n_dias', 'semanal', 'mensual', 'trimestral', 'anual', 'personalizada'] as const;

export default function CatalogoLimpiezaScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const puedeEditar = hasPermiso('limpieza.catalogo');

  const [tipos, setTipos] = useState<TipoLimpieza[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modalVisible, setModalVisible] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [procedimiento, setProcedimiento] = useState('');
  const [productos, setProductos] = useState<ProductoDosis[]>([]);
  const [requiereVaciado, setRequiereVaciado] = useState(false);
  const [frecuencia, setFrecuencia] = useState<string>('diaria');
  const [activo, setActivo] = useState(true);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch('/api/limpieza/tipos')
      .then((res) => res.json())
      .then((data: { tipos?: TipoLimpieza[]; error?: string }) => {
        if (data.error) { setError(data.error); return; }
        setTipos(data.tipos || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  useFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  const abrirNuevo = () => {
    setEditId(null);
    setNombre('');
    setProcedimiento('');
    setProductos([]);
    setRequiereVaciado(false);
    setFrecuencia('diaria');
    setActivo(true);
    setModalVisible(true);
  };

  const abrirEditar = (t: TipoLimpieza) => {
    setEditId(t.id_tipo);
    setNombre(t.nombre ?? '');
    setProcedimiento(t.descripcion_procedimiento ?? '');
    setProductos(Array.isArray(t.productos_y_dosis) ? t.productos_y_dosis : []);
    setRequiereVaciado(Boolean(t.requiere_vaciado_previo));
    setFrecuencia(t.frecuencia_por_defecto ?? 'diaria');
    setActivo(t.activo !== false);
    setModalVisible(true);
  };

  const guardar = async () => {
    if (!nombre.trim()) { setError('El nombre es obligatorio'); return; }
    setGuardando(true);
    setError(null);
    const payload = {
      nombre: nombre.trim(),
      descripcion_procedimiento: procedimiento.trim(),
      productos_y_dosis: productos.filter((p) => p.producto.trim()),
      requiere_vaciado_previo: requiereVaciado,
      frecuencia_por_defecto: frecuencia,
      activo,
    };
    try {
      const res = await apiFetch(
        editId ? `/api/limpieza/tipos/${editId}` : '/api/limpieza/tipos',
        { method: editId ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al guardar'); return; }
      setModalVisible(false);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const borrar = async (t: TipoLimpieza) => {
    setError(null);
    try {
      const res = await apiFetch(`/api/limpieza/tipos/${t.id_tipo}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al borrar'); return; }
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Catálogo de objetos a limpiar</Text>
        {puedeEditar ? (
          <TouchableOpacity style={styles.addBtn} onPress={abrirNuevo}>
            <MaterialIcons name="add" size={18} color="#fff" />
            <Text style={styles.addBtnText}>Nuevo</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color="#0ea5e9" /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {tipos.length === 0 ? (
            <Text style={styles.vacio}>No hay objetos en el catálogo todavía.</Text>
          ) : tipos.map((t) => (
            <View key={t.id_tipo} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{t.nombre}</Text>
                  <Text style={styles.cardMeta}>
                    {(t.frecuencia_por_defecto ?? 'diaria').replace(/_/g, ' ')}
                    {t.requiere_vaciado_previo ? ' · requiere vaciado previo' : ''}
                    {t.activo === false ? ' · inactivo' : ''}
                  </Text>
                </View>
                {puedeEditar ? (
                  <View style={styles.cardActions}>
                    <TouchableOpacity onPress={() => abrirEditar(t)} style={styles.iconBtn}>
                      <MaterialIcons name="edit" size={18} color="#0ea5e9" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => borrar(t)} style={styles.iconBtn}>
                      <MaterialIcons name="delete" size={18} color="#dc2626" />
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
              {t.descripcion_procedimiento ? (
                <Text style={styles.cardProc} numberOfLines={3}>{t.descripcion_procedimiento}</Text>
              ) : null}
              {Array.isArray(t.productos_y_dosis) && t.productos_y_dosis.length > 0 ? (
                <View style={styles.prodWrap}>
                  {t.productos_y_dosis.map((p, i) => (
                    <Text key={i} style={styles.prodChip}>{p.producto}{p.dosis ? ` · ${p.dosis}` : ''}</Text>
                  ))}
                </View>
              ) : null}
            </View>
          ))}
        </ScrollView>
      )}

      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={() => setModalVisible(false)}>
        <View style={styles.overlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editId ? 'Editar objeto' : 'Nuevo objeto'}</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>Nombre *</Text>
              <TextInput style={styles.input} value={nombre} onChangeText={setNombre} placeholder="Nevera, Congelador…" placeholderTextColor="#94a3b8" />

              <Text style={styles.label}>Procedimiento de limpieza</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={procedimiento}
                onChangeText={setProcedimiento}
                placeholder="Pasos comunes de limpieza para este objeto…"
                placeholderTextColor="#94a3b8"
                multiline
              />

              <View style={styles.prodHeader}>
                <Text style={styles.label}>Productos y dosis</Text>
                <TouchableOpacity onPress={() => setProductos((p) => [...p, { producto: '', dosis: '', epi: '' }])}>
                  <MaterialIcons name="add-circle-outline" size={20} color="#0ea5e9" />
                </TouchableOpacity>
              </View>
              {productos.map((p, i) => (
                <View key={i} style={styles.prodRow}>
                  <TextInput style={[styles.input, styles.prodInput]} value={p.producto} onChangeText={(v) => setProductos((arr) => arr.map((x, j) => j === i ? { ...x, producto: v } : x))} placeholder="Producto" placeholderTextColor="#94a3b8" />
                  <TextInput style={[styles.input, styles.prodInput]} value={p.dosis} onChangeText={(v) => setProductos((arr) => arr.map((x, j) => j === i ? { ...x, dosis: v } : x))} placeholder="Dosis / EPI" placeholderTextColor="#94a3b8" />
                  <TouchableOpacity onPress={() => setProductos((arr) => arr.filter((_, j) => j !== i))} style={styles.iconBtn}>
                    <MaterialIcons name="close" size={18} color="#dc2626" />
                  </TouchableOpacity>
                </View>
              ))}

              <Text style={styles.label}>Frecuencia por defecto</Text>
              <View style={styles.chipsWrap}>
                {FRECUENCIAS.map((f) => (
                  <TouchableOpacity key={f} style={[styles.chip, frecuencia === f && styles.chipActive]} onPress={() => setFrecuencia(f)}>
                    <Text style={[styles.chipText, frecuencia === f && styles.chipTextActive]}>{f.replace(/_/g, ' ')}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.switchRow}>
                <Text style={styles.label}>Requiere vaciado previo</Text>
                <Switch value={requiereVaciado} onValueChange={setRequiereVaciado} />
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.label}>Activo</Text>
                <Switch value={activo} onValueChange={setActivo} />
              </View>

              <TouchableOpacity style={styles.saveBtn} onPress={guardar} disabled={guardando}>
                {guardando ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.saveBtnText}>Guardar</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  backBtn: { padding: 4 },
  title: { flex: 1, fontSize: 18, fontWeight: '700', color: '#334155' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#0ea5e9', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  errorText: { fontSize: 12, color: '#dc2626', marginBottom: 8 },
  center: { paddingVertical: 40, alignItems: 'center' },
  list: { gap: 10, paddingBottom: 20 },
  vacio: { fontSize: 13, color: '#94a3b8', padding: 16 },
  card: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, padding: 14 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#334155' },
  cardMeta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  cardActions: { flexDirection: 'row', gap: 4 },
  iconBtn: { padding: 6 },
  cardProc: { fontSize: 13, color: '#475569', marginTop: 8, lineHeight: 18 },
  prodWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  prodChip: { fontSize: 11, color: '#0369a1', backgroundColor: '#e0f2fe', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999 },
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 520, maxHeight: '85%', backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#334155' },
  modalScroll: { padding: 16 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 6, marginTop: 10 },
  input: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, fontSize: 14, color: '#334155', backgroundColor: '#fff', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) },
  textArea: { minHeight: 70, textAlignVertical: 'top' },
  prodHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  prodRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  prodInput: { flex: 1, marginTop: 0 },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  chipActive: { borderColor: '#7dd3fc', backgroundColor: '#e0f2fe' },
  chipText: { fontSize: 12, color: '#64748b' },
  chipTextActive: { color: '#0369a1', fontWeight: '600' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  saveBtn: { backgroundColor: '#0ea5e9', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 20, marginBottom: 10 },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
