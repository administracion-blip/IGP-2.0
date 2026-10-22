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
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalesPermitidos, valorEnLocal } from '../../../contexts/LocalesContext';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { RangoFechas } from '../../../components/RangoFechas';
import { apiFetch } from '../../../utils/api';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../../constants/theme';

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
  const { locales, loading: loadingLocales } = useLocalesPermitidos();

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
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Programación de limpieza</Text>
      </View>

      {loadingLocales ? (
        <View style={styles.center}><ActivityIndicator size="small" color={colors.accent} /></View>
      ) : (
        <>
          <SelectorDesplegable
            style={{ marginBottom: SPACING.md }}
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
              {generando ? <ActivityIndicator size="small" color={colors.surface} /> : (
                <><MaterialIcons name="playlist-add-check" size={18} color={colors.surface} /><Text style={styles.genBtnText}>Generar desde reglas activas</Text></>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.listHeader}>
            <Text style={styles.sectionTitle}>Reglas de frecuencia</Text>
            <TouchableOpacity style={styles.addBtn} onPress={abrirNuevo} disabled={objetos.length === 0}>
              <MaterialIcons name="add" size={18} color={colors.surface} />
              <Text style={styles.addBtnText}>Nueva regla</Text>
            </TouchableOpacity>
          </View>
          {objetos.length === 0 ? (
            <Text style={styles.vacio}>Crea primero objetos de este local en «Tipos y objetos».</Text>
          ) : null}

          {loading ? (
            <View style={styles.center}><ActivityIndicator size="small" color={colors.accent} /></View>
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
                    <MaterialIcons name="edit" size={18} color={colors.accent} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => borrar(r)} style={styles.iconBtn}>
                    <MaterialIcons name="delete" size={18} color={colors.danger} />
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
                <MaterialIcons name="close" size={22} color={colors.textMuted} />
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
                placeholderTextColor={colors.textMuted}
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
                  <TextInput style={styles.input} value={cadaNDias} onChangeText={setCadaNDias} keyboardType="number-pad" placeholder="2" placeholderTextColor={colors.textMuted} />
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
                {guardando ? <ActivityIndicator size="small" color={colors.surface} /> : <Text style={styles.saveBtnText}>Guardar</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;
/** Entre radius.lg (12) y radius.xl (16). */
const RADIO_TARJETA = 14;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: SPACING.md },
  backBtn: { padding: SPACING.xs },
  title: { flex: 1, fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  center: { paddingVertical: SPACING.xl, alignItems: 'center' },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, marginBottom: SPACING.sm },
  infoText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.success, marginBottom: SPACING.sm },
  genCard: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, marginBottom: SPACING.lg },
  genTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, marginBottom: SPACING.sm },
  genBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.accent, borderRadius: RADIO_MEDIO, paddingVertical: 10, marginTop: SPACING.md },
  genBtnText: { color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontSize: fontSizes[13] },
  listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm },
  sectionTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, backgroundColor: colors.accent, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md, borderRadius: RADIO_MEDIO },
  addBtnText: { color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontSize: fontSizes[13] },
  list: { gap: SPACING.sm, paddingBottom: 20 },
  vacio: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, paddingVertical: SPACING.sm },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: SPACING.md, gap: SPACING.xs },
  cardTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  cardMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: 2 },
  iconBtn: { padding: 6 },
  // Más oscuro que colors.overlay.
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 500, maxHeight: '85%', backgroundColor: colors.surface, borderRadius: RADIO_TARJETA, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: SPACING.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  modalScroll: { padding: SPACING.lg },
  label: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, marginBottom: 6, marginTop: 10 },
  ayuda: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginTop: 6, lineHeight: 15 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO, paddingVertical: 10, paddingHorizontal: SPACING.md, fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary, backgroundColor: colors.surface },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  chipActive: { borderColor: '#7dd3fc', backgroundColor: colors.accentMuted },
  chipText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  chipTextActive: { color: statusColors.info.text, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  saveBtn: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: SPACING.md, alignItems: 'center', marginTop: 20, marginBottom: 10 },
  saveBtnText: { color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontSize: fontSizes[14] },
});
