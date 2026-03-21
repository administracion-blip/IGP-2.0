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
  Platform,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { useAuth } from '../../contexts/AuthContext';
import { formatMoneda, labelEstado } from '../../utils/facturacion';

import { API_BASE_URL as API_URL } from '../../utils/apiBaseUrl';

type Actuacion = {
  id_actuacion: string;
  id_artista: string;
  artista_nombre_snapshot?: string;
  fecha: string;
  hora_inicio?: string;
  hora_fin?: string;
  franja?: string;
  tipo_dia?: string;
  importe_previsto?: number;
  importe_final?: number;
  estado?: string;
  id_local?: string;
  local_nombre_snapshot?: string;
  id_factura_gasto?: string;
  observaciones?: string;
};

type FacturaOpt = {
  id_factura: string;
  numero_factura: string;
  proveedor: string;
  fecha_emision: string;
  total_factura: number;
  estado: string;
};

export default function ProgramacionScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [actuaciones, setActuaciones] = useState<Actuacion[]>([]);
  const [artistas, setArtistas] = useState<{ id_artista: string; nombre_artistico: string }[]>([]);
  const [locales, setLocales] = useState<{ id_Locales: string; nombre?: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [modalAsoc, setModalAsoc] = useState(false);
  const [facturas, setFacturas] = useState<FacturaOpt[]>([]);
  const [loadingFac, setLoadingFac] = useState(false);
  const [qFac, setQFac] = useState('');
  const [elegida, setElegida] = useState<FacturaOpt | null>(null);

  const [modalAct, setModalAct] = useState(false);
  const [form, setForm] = useState<Partial<Actuacion>>({});
  const [saving, setSaving] = useState(false);

  const fetchAll = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (fechaDesde) qs.set('fechaDesde', fechaDesde);
    if (fechaHasta) qs.set('fechaHasta', fechaHasta);
    Promise.all([
      fetch(`${API_URL}/api/actuaciones?${qs}`).then((r) => r.json()),
      fetch(`${API_URL}/api/artistas`).then((r) => r.json()),
      fetch(`${API_URL}/api/locales?minimal=1`).then((r) => r.json()),
    ])
      .then(([a, ar, loc]) => {
        setActuaciones(a.actuaciones || []);
        setArtistas((ar.artistas || []).map((x: { id_artista: string; nombre_artistico: string }) => ({
          id_artista: x.id_artista,
          nombre_artistico: x.nombre_artistico,
        })));
        setLocales(loc.locales || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fechaDesde, fechaHasta]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  function toggleSel(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function buscarFacturas() {
    setLoadingFac(true);
    try {
      const qs = new URLSearchParams();
      if (qFac.trim()) qs.set('q', qFac.trim());
      const r = await fetch(`${API_URL}/api/actuaciones/facturas-gasto-asociables?${qs}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      setFacturas(d.facturas || []);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Error');
    } finally {
      setLoadingFac(false);
    }
  }

  useEffect(() => {
    if (modalAsoc) buscarFacturas();
  }, [modalAsoc]);

  async function confirmarAsociacion() {
    if (!elegida || selected.size === 0) {
      Alert.alert('Selecciona actuaciones y una factura');
      return;
    }
    try {
      const r = await fetch(`${API_URL}/api/actuaciones/asociar-factura`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids_actuacion: [...selected],
          id_factura: elegida.id_factura,
          usuario_id: user?.id_usuario,
          usuario_nombre: user?.Nombre,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      Alert.alert('OK', `Asociadas ${d.actualizadas} actuaciones`);
      setModalAsoc(false);
      setSelected(new Set());
      setElegida(null);
      fetchAll();
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Error');
    }
  }

  async function calcularImporte() {
    if (!form.id_artista || !form.fecha) return;
    try {
      const r = await fetch(`${API_URL}/api/actuaciones/calcular-importe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_artista: form.id_artista,
          fecha: form.fecha,
          hora_inicio: form.hora_inicio || '22:00',
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      setForm((f) => ({
        ...f,
        franja: d.franja,
        tipo_dia: d.tipo_dia,
        importe_previsto: d.importe_previsto,
        importe_final: d.importe_previsto ?? f.importe_final,
      }));
    } catch {
      /* noop */
    }
  }

  async function guardarActuacion() {
    if (!form.id_artista || !form.fecha) {
      Alert.alert('Artista y fecha obligatorios');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`${API_URL}/api/actuaciones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_artista: form.id_artista,
          fecha: form.fecha,
          hora_inicio: form.hora_inicio || '22:00',
          hora_fin: form.hora_fin || '',
          id_local: form.id_local || '',
          importe_previsto: form.importe_previsto,
          importe_final: form.importe_final ?? form.importe_previsto,
          estado: form.estado || 'pendiente',
          observaciones: form.observaciones || '',
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      setModalAct(false);
      setForm({});
      fetchAll();
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Error');
    } finally {
      setSaving(false);
    }
  }

  async function subirFirma(idAct: string) {
    const pick = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true });
    if (pick.canceled || !pick.assets?.[0]) return;
    const asset = pick.assets[0];
    const formData = new FormData();
    formData.append('file', {
      uri: asset.uri,
      name: asset.name || 'firma.png',
      type: asset.mimeType || 'image/png',
    } as unknown as Blob);
    const r = await fetch(`${API_URL}/api/actuaciones/item/${idAct}/firma`, { method: 'POST', body: formData });
    const d = await r.json();
    if (!r.ok) Alert.alert('Error', d.error || 'No se pudo subir');
    else {
      Alert.alert('OK', 'Firma guardada');
      fetchAll();
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Programación</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => { setForm({ fecha: new Date().toISOString().slice(0, 10), hora_inicio: '22:00', estado: 'pendiente' }); setModalAct(true); }}>
          <MaterialIcons name="add" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      <View style={styles.filters}>
        <TextInput style={styles.fInput} placeholder="Desde yyyy-mm-dd" value={fechaDesde} onChangeText={setFechaDesde} placeholderTextColor="#94a3b8" />
        <TextInput style={styles.fInput} placeholder="Hasta yyyy-mm-dd" value={fechaHasta} onChangeText={setFechaHasta} placeholderTextColor="#94a3b8" />
        <TouchableOpacity style={styles.fBtn} onPress={fetchAll}>
          <Text style={styles.fBtnText}>Filtrar</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.toolbar}>
        <TouchableOpacity
          style={[styles.asocBtn, selected.size === 0 && styles.asocBtnOff]}
          disabled={selected.size === 0}
          onPress={() => setModalAsoc(true)}
        >
          <MaterialIcons name="link" size={18} color="#fff" />
          <Text style={styles.asocBtnText}>Asociar ({selected.size})</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color="#0ea5e9" />
      ) : (
        <ScrollView style={styles.scroll}>
          {actuaciones.map((a) => {
            const sel = selected.has(a.id_actuacion);
            return (
              <TouchableOpacity
                key={a.id_actuacion}
                style={[styles.row, sel && styles.rowSel]}
                onPress={() => toggleSel(a.id_actuacion)}
                onLongPress={() => subirFirma(a.id_actuacion)}
                delayLongPress={500}
                activeOpacity={0.8}
              >
                <MaterialIcons name={sel ? 'check-box' : 'check-box-outline-blank'} size={22} color={sel ? '#0ea5e9' : '#94a3b8'} />
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text style={styles.rowTitle}>{a.artista_nombre_snapshot || '—'} · {a.fecha}</Text>
                  <Text style={styles.rowSub}>
                    {a.local_nombre_snapshot || 'Sin local'} · {formatMoneda(a.importe_final ?? 0)} · {a.estado || '—'}
                  </Text>
                  {a.id_factura_gasto ? <Text style={styles.rowFact}>Factura: {a.id_factura_gasto.slice(0, 8)}…</Text> : null}
                </View>
                <TouchableOpacity
                  onPress={(e: { stopPropagation?: () => void }) => {
                    e.stopPropagation?.();
                    subirFirma(a.id_actuacion);
                  }}
                  hitSlop={12}
                >
                  <MaterialIcons name="draw" size={20} color="#64748b" />
                </TouchableOpacity>
              </TouchableOpacity>
            );
          })}
          {actuaciones.length === 0 ? <Text style={styles.empty}>No hay actuaciones en el rango.</Text> : null}
        </ScrollView>
      )}

      <Text style={styles.hint}>Pulsa la fila para seleccionar. Icono dibujo o pulsación larga: subir firma.</Text>

      <Modal visible={modalAsoc} animationType="slide" transparent onRequestClose={() => setModalAsoc(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pago asociado</Text>
              <TouchableOpacity onPress={() => setModalAsoc(false)}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.input}
              placeholder="Buscar número, proveedor, CIF…"
              value={qFac}
              onChangeText={setQFac}
              onSubmitEditing={buscarFacturas}
            />
            <TouchableOpacity style={styles.fBtn} onPress={buscarFacturas}>
              <Text style={styles.fBtnText}>Buscar facturas músicos</Text>
            </TouchableOpacity>
            {loadingFac ? <ActivityIndicator color="#0ea5e9" style={{ marginVertical: 12 }} /> : null}
            <ScrollView style={{ maxHeight: 280 }}>
              {facturas.map((f) => (
                <TouchableOpacity
                  key={f.id_factura}
                  style={[styles.facRow, elegida?.id_factura === f.id_factura && styles.facRowOn]}
                  onPress={() => setElegida(f)}
                >
                  <Text style={styles.facTitle}>{f.numero_factura || '—'} · {f.proveedor}</Text>
                  <Text style={styles.facSub}>
                    {String(f.fecha_emision).slice(0, 10)} · {formatMoneda(f.total_factura)} · {labelEstado(f.estado)}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.saveBtn} onPress={confirmarAsociacion}>
              <Text style={styles.saveBtnText}>Confirmar asociación</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={modalAct} animationType="slide" transparent onRequestClose={() => setModalAct(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Nueva actuación</Text>
              <TouchableOpacity onPress={() => setModalAct(false)}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ padding: 16 }} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>Artista</Text>
              <ScrollView horizontal style={{ marginBottom: 8 }}>
                {artistas.map((ar) => (
                  <TouchableOpacity
                    key={ar.id_artista}
                    style={[styles.chip, form.id_artista === ar.id_artista && styles.chipOn]}
                    onPress={() => setForm((f) => ({ ...f, id_artista: ar.id_artista }))}
                  >
                    <Text style={styles.chipText}>{ar.nombre_artistico}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <Text style={styles.label}>Fecha (yyyy-mm-dd)</Text>
              <TextInput
                style={styles.input}
                value={form.fecha || ''}
                onChangeText={(t) => setForm((f) => ({ ...f, fecha: t }))}
                placeholder="2026-03-21"
              />
              <Text style={styles.label}>Hora inicio</Text>
              <TextInput
                style={styles.input}
                value={form.hora_inicio || ''}
                onChangeText={(t) => setForm((f) => ({ ...f, hora_inicio: t }))}
                placeholder="22:00"
              />
              <TouchableOpacity style={styles.fBtn} onPress={calcularImporte}>
                <Text style={styles.fBtnText}>Calcular importe sugerido</Text>
              </TouchableOpacity>
              <Text style={styles.label}>Importe previsto / final</Text>
              <TextInput
                style={styles.input}
                keyboardType="decimal-pad"
                value={form.importe_final != null ? String(form.importe_final) : form.importe_previsto != null ? String(form.importe_previsto) : ''}
                onChangeText={(t) =>
                  setForm((f) => ({ ...f, importe_final: parseFloat(t.replace(',', '.')) || 0, importe_previsto: f.importe_previsto }))
                }
              />
              <Text style={styles.label}>Local</Text>
              <ScrollView horizontal>
                {locales.map((loc) => (
                  <TouchableOpacity
                    key={loc.id_Locales}
                    style={[styles.chip, form.id_local === loc.id_Locales && styles.chipOn]}
                    onPress={() => setForm((f) => ({ ...f, id_local: loc.id_Locales }))}
                  >
                    <Text style={styles.chipText} numberOfLines={1}>{loc.nombre || loc.id_Locales}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity style={styles.saveBtn} onPress={guardarActuacion} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Crear actuación</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#e2e8f0', padding: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  backBtn: { padding: 4 },
  title: { flex: 1, fontSize: 20, fontWeight: '700', color: '#334155' },
  addBtn: { backgroundColor: '#0ea5e9', borderRadius: 10, padding: 8 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  fInput: {
    flex: 1,
    minWidth: 120,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === 'ios' ? 8 : 4,
    fontSize: 12,
  },
  fBtn: { backgroundColor: '#f1f5f9', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, alignSelf: 'flex-start' },
  fBtnText: { color: '#0369a1', fontWeight: '600', fontSize: 12 },
  toolbar: { marginBottom: 8 },
  asocBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#059669', alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  asocBtnOff: { opacity: 0.45 },
  asocBtnText: { color: '#fff', fontWeight: '700' },
  scroll: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  rowSel: { borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  rowTitle: { fontSize: 14, fontWeight: '600', color: '#334155' },
  rowSub: { fontSize: 11, color: '#64748b', marginTop: 2 },
  rowFact: { fontSize: 10, color: '#059669', marginTop: 2 },
  empty: { textAlign: 'center', color: '#94a3b8', marginTop: 20, fontStyle: 'italic' },
  hint: { fontSize: 10, color: '#94a3b8', marginTop: 8, fontStyle: 'italic' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 16 },
  modalCard: { backgroundColor: '#fff', borderRadius: 14, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', padding: 14, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#334155' },
  input: {
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    backgroundColor: '#f8fafc',
  },
  facRow: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  facRowOn: { backgroundColor: '#e0f2fe' },
  facTitle: { fontSize: 13, fontWeight: '600', color: '#334155' },
  facSub: { fontSize: 11, color: '#64748b', marginTop: 2 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 4, marginTop: 8 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0', marginRight: 6 },
  chipOn: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  chipText: { fontSize: 11, color: '#334155' },
  saveBtn: { backgroundColor: '#0ea5e9', margin: 16, borderRadius: 10, padding: 14, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '700' },
});
