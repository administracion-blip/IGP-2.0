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
import { MaterialIcons } from '@expo/vector-icons';
import { useMantenimientoLocales, valorEnLocal } from '../LocalesContext';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { RangoFechas } from '../../../components/RangoFechas';
import { apiFetch } from '../../../utils/api';

type Regla = {
  id_regla: string;
  local_id: string;
  objeto_id?: string | null;
  tipo_objeto_id: string;
  nombre_tarea?: string | null;
  frecuencia: string;
  cada_n_dias?: number | null;
  dias_semana?: boolean[];
  rol_responsable?: string | null;
  hora_limite?: string | null;
  activo?: boolean;
};
type Tipo = { id_tipo: string; nombre: string };
type Objeto = { id_objeto: string; nombre: string; ubicacion?: string; tipo_objeto_id?: string | null; activo?: boolean };

const FRECUENCIAS = ['diaria', 'cada_n_dias', 'semanal', 'mensual', 'trimestral', 'anual', 'personalizada'] as const;
const FREQ_LABEL: Record<string, string> = {
  diaria: 'Diaria',
  cada_n_dias: 'Cada N días',
  semanal: 'Semanal (elige días)',
  mensual: 'Mensual',
  trimestral: 'Trimestral',
  anual: 'Anual',
  personalizada: 'Días concretos',
};
const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
/** Frecuencias donde el día de semana define el patrón directamente. */
const CON_DIAS_SEMANA = ['semanal', 'personalizada'];
/** Frecuencias periódicas donde el día de semana es opcional (reparto de carga). */
const PERIODICAS = ['mensual', 'trimestral', 'anual'];

function hoyIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function ProgramacionLimpiezaScreen() {
  const router = useRouter();
  const { locales, loading: loadingLocales } = useMantenimientoLocales();

  const [localId, setLocalId] = useState('');
  const [tipos, setTipos] = useState<Tipo[]>([]);
  const [objetos, setObjetos] = useState<Objeto[]>([]);
  const [reglas, setReglas] = useState<Regla[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [modalVisible, setModalVisible] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [objetoId, setObjetoId] = useState('');
  const [nombreTarea, setNombreTarea] = useState('');
  const [frecuencia, setFrecuencia] = useState<string>('diaria');
  const [cadaNDias, setCadaNDias] = useState('2');
  const [diasSemana, setDiasSemana] = useState<boolean[]>([false, false, false, false, false, false, false]);
  const [activo, setActivo] = useState(true);

  const [genDesde, setGenDesde] = useState(hoyIso());
  const [genHasta, setGenHasta] = useState(hoyIso());
  const [generando, setGenerando] = useState(false);

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

  const cargarReglas = useCallback(() => {
    if (!localId) return;
    setLoading(true);
    setError(null);
    apiFetch(`/api/limpieza/reglas?local_id=${encodeURIComponent(localId)}`)
      .then((res) => res.json())
      .then((data: { reglas?: Regla[]; error?: string }) => {
        if (data.error) { setError(data.error); return; }
        setReglas(data.reglas || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [localId]);

  useEffect(() => { cargarReglas(); }, [cargarReglas]);

  useEffect(() => {
    if (!localId) { setObjetos([]); return; }
    apiFetch(`/api/limpieza/objetos?local_id=${encodeURIComponent(localId)}&solo_activos=1`)
      .then((res) => res.json())
      .then((data: { objetos?: Objeto[] }) => setObjetos(Array.isArray(data.objetos) ? data.objetos : []))
      .catch(() => setObjetos([]));
  }, [localId]);

  const nombreTipo = useCallback((id: string) => tipos.find((t) => t.id_tipo === id)?.nombre ?? id, [tipos]);
  const objetoLabel = useCallback((o: Objeto) => (o.ubicacion ? `${o.nombre} · ${o.ubicacion}` : o.nombre), []);
  const nombreObjeto = useCallback((r: Regla) => {
    const o = objetos.find((x) => x.id_objeto === r.objeto_id);
    if (o) return objetoLabel(o);
    return nombreTipo(r.tipo_objeto_id);
  }, [objetos, objetoLabel, nombreTipo]);

  const abrirNuevo = () => {
    setEditId(null);
    setObjetoId(objetos[0]?.id_objeto ?? '');
    setNombreTarea('');
    setFrecuencia('diaria');
    setCadaNDias('2');
    setDiasSemana([false, false, false, false, false, false, false]);
    setActivo(true);
    setModalVisible(true);
  };

  const abrirEditar = (r: Regla) => {
    setEditId(r.id_regla);
    setObjetoId(r.objeto_id ?? '');
    setNombreTarea(r.nombre_tarea ?? '');
    setFrecuencia(r.frecuencia);
    setCadaNDias(String(r.cada_n_dias ?? 2));
    setDiasSemana(Array.isArray(r.dias_semana) && r.dias_semana.length === 7 ? r.dias_semana : [false, false, false, false, false, false, false]);
    setActivo(r.activo !== false);
    setModalVisible(true);
  };

  const usaDiasSemana = CON_DIAS_SEMANA.includes(frecuencia) || PERIODICAS.includes(frecuencia);
  const algunDia = diasSemana.some(Boolean);

  const guardar = async () => {
    if (!objetoId) { setError('Selecciona un objeto del local'); return; }
    if (CON_DIAS_SEMANA.includes(frecuencia) && !algunDia) {
      setError('Marca al menos un día de la semana');
      return;
    }
    setGuardando(true);
    setError(null);
    const payload = {
      local_id: localId,
      objeto_id: objetoId,
      nombre_tarea: nombreTarea.trim() || undefined,
      frecuencia,
      cada_n_dias: frecuencia === 'cada_n_dias' ? Number(cadaNDias) || 1 : undefined,
      dias_semana: usaDiasSemana && algunDia ? diasSemana : undefined,
      activo,
    };
    try {
      const res = await apiFetch(
        editId ? `/api/limpieza/reglas/${localId}/${editId}` : '/api/limpieza/reglas',
        { method: editId ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al guardar'); return; }
      setModalVisible(false);
      cargarReglas();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const borrar = async (r: Regla) => {
    setError(null);
    try {
      const res = await apiFetch(`/api/limpieza/reglas/${localId}/${r.id_regla}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al borrar'); return; }
      cargarReglas();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    }
  };

  const generar = async () => {
    setGenerando(true);
    setError(null);
    setInfo(null);
    try {
      const res = await apiFetch('/api/limpieza/registros/generar', {
        method: 'POST',
        body: JSON.stringify({ local_id: localId, desde: genDesde, hasta: genHasta }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al generar'); return; }
      setInfo(`Registros generados: ${data.creados} nuevos, ${data.existentes} ya existían.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGenerando(false);
    }
  };

  const resumenFrecuencia = (r: Regla) => {
    const dias = (r.dias_semana ?? []).map((v, i) => (v ? DIAS[i] : null)).filter(Boolean).join(', ');
    if (r.frecuencia === 'cada_n_dias') return `cada ${r.cada_n_dias ?? '?'} días`;
    if (CON_DIAS_SEMANA.includes(r.frecuencia)) return dias || FREQ_LABEL[r.frecuencia] || r.frecuencia;
    if (PERIODICAS.includes(r.frecuencia) && dias) return `${FREQ_LABEL[r.frecuencia]} · ${dias}`;
    return FREQ_LABEL[r.frecuencia] || r.frecuencia;
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Programación de limpieza</Text>
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
          {info ? <Text style={styles.infoText}>{info}</Text> : null}

          {/* Generar registros */}
          <View style={styles.genCard}>
            <Text style={styles.genTitle}>Generar registros</Text>
            <RangoFechas
              desdeIso={genDesde}
              hastaIso={genHasta}
              onChangeDesde={setGenDesde}
              onChangeHasta={setGenHasta}
            />
            <TouchableOpacity style={styles.genBtn} onPress={generar} disabled={generando || !localId}>
              {generando ? <ActivityIndicator size="small" color="#fff" /> : (
                <><MaterialIcons name="playlist-add-check" size={18} color="#fff" /><Text style={styles.genBtnText}>Generar desde reglas activas</Text></>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.listHeader}>
            <Text style={styles.sectionTitle}>Reglas de frecuencia</Text>
            <TouchableOpacity style={styles.addBtn} onPress={abrirNuevo} disabled={objetos.length === 0}>
              <MaterialIcons name="add" size={18} color="#fff" />
              <Text style={styles.addBtnText}>Nueva regla</Text>
            </TouchableOpacity>
          </View>
          {objetos.length === 0 ? (
            <Text style={styles.vacio}>Crea primero objetos de este local en «Tipos y objetos».</Text>
          ) : null}

          {loading ? (
            <View style={styles.center}><ActivityIndicator size="small" color="#0ea5e9" /></View>
          ) : (
            <ScrollView contentContainerStyle={styles.list}>
              {reglas.length === 0 ? (
                <Text style={styles.vacio}>Sin reglas para este local.</Text>
              ) : reglas.map((r) => (
                <View key={r.id_regla} style={styles.card}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle}>{nombreObjeto(r)}{r.nombre_tarea ? ` — ${r.nombre_tarea}` : ''}</Text>
                    <Text style={styles.cardMeta}>
                      {resumenFrecuencia(r)}{r.activo === false ? ' · inactiva' : ''}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => abrirEditar(r)} style={styles.iconBtn}>
                    <MaterialIcons name="edit" size={18} color="#0ea5e9" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => borrar(r)} style={styles.iconBtn}>
                    <MaterialIcons name="delete" size={18} color="#dc2626" />
                  </TouchableOpacity>
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
              <Text style={styles.modalTitle}>{editId ? 'Editar regla' : 'Nueva regla'}</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>Objeto a limpiar</Text>
              <SelectorDesplegable
                placeholder="Selecciona objeto"
                icono="inventory-2"
                tituloLista="Objeto del local"
                buscador
                buscadorPlaceholder="Buscar objeto…"
                valorId={objetoId}
                opciones={objetos.map((o) => ({ id: o.id_objeto, titulo: objetoLabel(o), icono: 'kitchen' as const }))}
                onSeleccionar={setObjetoId}
              />

              <Text style={styles.label}>Nombre de la tarea (opcional)</Text>
              <TextInput
                style={styles.input}
                value={nombreTarea}
                onChangeText={setNombreTarea}
                placeholder="Repaso diario, Limpieza profunda…"
                placeholderTextColor="#94a3b8"
              />

              <Text style={styles.label}>Frecuencia</Text>
              <View style={styles.chipsWrap}>
                {FRECUENCIAS.map((f) => (
                  <TouchableOpacity key={f} style={[styles.chip, frecuencia === f && styles.chipActive]} onPress={() => setFrecuencia(f)}>
                    <Text style={[styles.chipText, frecuencia === f && styles.chipTextActive]}>{FREQ_LABEL[f]}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {frecuencia === 'cada_n_dias' ? (
                <>
                  <Text style={styles.label}>Cada cuántos días</Text>
                  <TextInput style={styles.input} value={cadaNDias} onChangeText={setCadaNDias} keyboardType="number-pad" placeholder="2" placeholderTextColor="#94a3b8" />
                </>
              ) : null}

              {usaDiasSemana ? (
                <>
                  <Text style={styles.label}>
                    {CON_DIAS_SEMANA.includes(frecuencia) ? 'Días de la semana' : 'Día de la semana (opcional)'}
                  </Text>
                  <View style={styles.chipsWrap}>
                    {DIAS.map((d, i) => (
                      <TouchableOpacity key={d} style={[styles.chip, diasSemana[i] && styles.chipActive]} onPress={() => setDiasSemana((arr) => arr.map((v, j) => j === i ? !v : v))}>
                        <Text style={[styles.chipText, diasSemana[i] && styles.chipTextActive]}>{d}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {PERIODICAS.includes(frecuencia) ? (
                    <Text style={styles.ayuda}>
                      {algunDia
                        ? 'Se creará 1 limpieza por periodo, en el día elegido con menos carga de trabajo.'
                        : 'Sin día: se usará el mismo día del mes que la fecha "Desde" al generar.'}
                    </Text>
                  ) : null}
                </>
              ) : null}

              <View style={styles.switchRow}>
                <Text style={styles.label}>Activa</Text>
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
  infoText: { fontSize: 12, color: '#16a34a', marginBottom: 8 },
  genCard: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, padding: 14, marginBottom: 16 },
  genTitle: { fontSize: 14, fontWeight: '700', color: '#334155', marginBottom: 8 },
  genBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#0ea5e9', borderRadius: 8, paddingVertical: 10, marginTop: 12 },
  genBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#334155' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#0ea5e9', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  list: { gap: 8, paddingBottom: 20 },
  vacio: { fontSize: 13, color: '#94a3b8', paddingVertical: 8 },
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
  ayuda: { fontSize: 11, color: '#64748b', marginTop: 6, lineHeight: 15 },
  input: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, fontSize: 14, color: '#334155', backgroundColor: '#fff', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  chipActive: { borderColor: '#7dd3fc', backgroundColor: '#e0f2fe' },
  chipText: { fontSize: 12, color: '#64748b' },
  chipTextActive: { color: '#0369a1', fontWeight: '600' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  saveBtn: { backgroundColor: '#0ea5e9', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 20, marginBottom: 10 },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
