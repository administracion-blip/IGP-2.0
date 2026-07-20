import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { useMantenimientoLocales, valorEnLocal } from '../LocalesContext';
import { useAuth } from '../../../contexts/AuthContext';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { apiFetch } from '../../../utils/api';

type Tipo = { id_tipo: string; nombre: string };
type Objeto = {
  id_objeto: string;
  local_id: string;
  tipo_objeto_id: string | null;
  nombre: string;
  ubicacion: string;
  codigo: string;
  activo: boolean;
};

export default function ObjetosLimpiezaScreen() {
  const router = useRouter();
  const { locales, loading: loadingLocales } = useMantenimientoLocales();
  const { hasPermiso } = useAuth();
  const puedeEditar = hasPermiso('limpieza.catalogo') || hasPermiso('limpieza.programar');

  const [localId, setLocalId] = useState('');
  const [tipos, setTipos] = useState<Tipo[]>([]);
  const [objetos, setObjetos] = useState<Objeto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modalVisible, setModalVisible] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [tipoObjetoId, setTipoObjetoId] = useState('');
  const [nombre, setNombre] = useState('');
  const [ubicacion, setUbicacion] = useState('');
  const [codigo, setCodigo] = useState('');
  const [activo, setActivo] = useState(true);

  const localesOpciones = useMemo(
    () => locales.map((l) => ({
      id: valorEnLocal(l, 'id_Locales') ?? valorEnLocal(l, 'id_locales') ?? '',
      titulo: valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? '',
      icono: 'store' as const,
    })).filter((o) => o.id),
    [locales],
  );

  useEffect(() => {
    if (!localId && localesOpciones.length > 0) setLocalId(localesOpciones[0].id);
  }, [localesOpciones, localId]);

  useEffect(() => {
    apiFetch('/api/limpieza/tipos?solo_activos=1')
      .then((res) => res.json())
      .then((data: { tipos?: Tipo[] }) => setTipos(data.tipos || []))
      .catch(() => setTipos([]));
  }, []);

  const cargar = useCallback(() => {
    if (!localId) return;
    setLoading(true);
    setError(null);
    apiFetch(`/api/limpieza/objetos?local_id=${encodeURIComponent(localId)}`)
      .then((res) => res.json())
      .then((data: { objetos?: Objeto[]; error?: string }) => {
        if (data.error) { setError(data.error); return; }
        setObjetos(data.objetos || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [localId]);

  useFocusEffect(useCallback(() => { cargar(); }, [cargar]));

  const nombreTipo = useCallback((id: string | null) => tipos.find((t) => t.id_tipo === id)?.nombre ?? (id ?? '—'), [tipos]);

  const abrirNuevo = () => {
    setEditId(null);
    setTipoObjetoId(tipos[0]?.id_tipo ?? '');
    setNombre('');
    setUbicacion('');
    setCodigo('');
    setActivo(true);
    setModalVisible(true);
  };

  const abrirEditar = (o: Objeto) => {
    setEditId(o.id_objeto);
    setTipoObjetoId(o.tipo_objeto_id ?? '');
    setNombre(o.nombre ?? '');
    setUbicacion(o.ubicacion ?? '');
    setCodigo(o.codigo ?? '');
    setActivo(o.activo !== false);
    setModalVisible(true);
  };

  const guardar = async () => {
    if (!tipoObjetoId) { setError('Selecciona el tipo (cómo se limpia)'); return; }
    if (!nombre.trim()) { setError('El nombre es obligatorio'); return; }
    setGuardando(true);
    setError(null);
    const payload = {
      local_id: localId,
      tipo_objeto_id: tipoObjetoId,
      nombre: nombre.trim(),
      ubicacion: ubicacion.trim(),
      codigo: codigo.trim(),
      activo,
    };
    try {
      const res = await apiFetch(
        editId ? `/api/limpieza/objetos/${localId}/${editId}` : '/api/limpieza/objetos',
        { method: editId ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al guardar'); return; }
      setModalVisible(false);
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const borrar = async (o: Objeto) => {
    setError(null);
    try {
      const res = await apiFetch(`/api/limpieza/objetos/${localId}/${o.id_objeto}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al borrar'); return; }
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Objetos por local</Text>
      </View>

      {loadingLocales ? (
        <View style={styles.center}><ActivityIndicator size="small" color="#0ea5e9" /></View>
      ) : (
        <>
          <SelectorDesplegable
            style={{ marginBottom: 12 }}
            placeholder="Selecciona local"
            icono="store"
            tituloLista="Local"
            iconoLista="store"
            valorId={localId}
            opciones={localesOpciones}
            onSeleccionar={setLocalId}
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={styles.listHeader}>
            <Text style={styles.sectionTitle}>Objetos físicos de este local</Text>
            {puedeEditar ? (
              <TouchableOpacity style={styles.addBtn} onPress={abrirNuevo} disabled={!localId || tipos.length === 0}>
                <MaterialIcons name="add" size={18} color="#fff" />
                <Text style={styles.addBtnText}>Nuevo</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {tipos.length === 0 ? (
            <Text style={styles.vacio}>Crea primero tipos en el catálogo (cómo se limpia).</Text>
          ) : null}

          {loading ? (
            <View style={styles.center}><ActivityIndicator size="large" color="#0ea5e9" /></View>
          ) : (
            <ScrollView contentContainerStyle={styles.list}>
              {objetos.length === 0 ? (
                <Text style={styles.vacio}>Sin objetos en este local. Añade, por ejemplo, «Nevera Cocina 1».</Text>
              ) : objetos.map((o) => (
                <View key={o.id_objeto} style={styles.card}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle}>{o.nombre}</Text>
                    <Text style={styles.cardMeta}>
                      {nombreTipo(o.tipo_objeto_id)}
                      {o.ubicacion ? ` · ${o.ubicacion}` : ''}
                      {o.codigo ? ` · ${o.codigo}` : ''}
                      {o.activo === false ? ' · inactivo' : ''}
                    </Text>
                  </View>
                  {puedeEditar ? (
                    <>
                      <TouchableOpacity onPress={() => abrirEditar(o)} style={styles.iconBtn}>
                        <MaterialIcons name="edit" size={18} color="#0ea5e9" />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => borrar(o)} style={styles.iconBtn}>
                        <MaterialIcons name="delete" size={18} color="#dc2626" />
                      </TouchableOpacity>
                    </>
                  ) : null}
                </View>
              ))}
            </ScrollView>
          )}
        </>
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
              <Text style={styles.label}>Tipo (cómo se limpia)</Text>
              <SelectorDesplegable
                placeholder="Selecciona tipo"
                icono="inventory-2"
                tituloLista="Tipo del catálogo"
                valorId={tipoObjetoId}
                opciones={tipos.map((t) => ({ id: t.id_tipo, titulo: t.nombre, icono: 'cleaning-services' as const }))}
                onSeleccionar={setTipoObjetoId}
              />

              <Text style={styles.label}>Nombre *</Text>
              <TextInput style={styles.input} value={nombre} onChangeText={setNombre} placeholder="Nevera Cocina 1" placeholderTextColor="#94a3b8" />

              <Text style={styles.label}>Ubicación</Text>
              <TextInput style={styles.input} value={ubicacion} onChangeText={setUbicacion} placeholder="Cocina, Barra, Almacén…" placeholderTextColor="#94a3b8" />

              <Text style={styles.label}>Código / etiqueta (opcional)</Text>
              <TextInput style={styles.input} value={codigo} onChangeText={setCodigo} placeholder="NEV-COC-01" placeholderTextColor="#94a3b8" />

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
  center: { paddingVertical: 24, alignItems: 'center' },
  errorText: { fontSize: 12, color: '#dc2626', marginBottom: 8 },
  listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#334155' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#0ea5e9', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  list: { gap: 8, paddingBottom: 20 },
  vacio: { fontSize: 13, color: '#94a3b8', paddingVertical: 8, lineHeight: 19 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, padding: 12, gap: 4 },
  cardTitle: { fontSize: 14, fontWeight: '600', color: '#334155' },
  cardMeta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  iconBtn: { padding: 6 },
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 500, maxHeight: '85%', backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#334155' },
  modalScroll: { padding: 16 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 6, marginTop: 10 },
  input: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, fontSize: 14, color: '#334155', backgroundColor: '#fff', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  saveBtn: { backgroundColor: '#0ea5e9', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 20, marginBottom: 10 },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
