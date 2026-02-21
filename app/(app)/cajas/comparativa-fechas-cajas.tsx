import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Modal,
  Platform,
  KeyboardAvoidingView,
  Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx';
import { TablaBasica } from '../../components/TablaBasica';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const PAGE_SIZE = 50;
const COLUMNAS = ['PK', 'FechaComparativa', 'Festivo', 'NombreFestivo'];

type Registro = Record<string, unknown>;

function mesEnCurso(): { inicio: string; fin: string } {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = String(hoy.getMonth() + 1).padStart(2, '0');
  const ultimoDia = new Date(y, hoy.getMonth() + 1, 0).getDate();
  return {
    inicio: `${y}-${m}-01`,
    fin: `${y}-${m}-${String(ultimoDia).padStart(2, '0')}`,
  };
}

function valorPorColumna(item: Registro, col: string): unknown {
  if (item[col] !== undefined && item[col] !== null) return item[col];
  const key = Object.keys(item).find((k) => k.toLowerCase() === col.toLowerCase());
  return key != null ? item[key] : undefined;
}

export default function ComparativaFechasCajasScreen() {
  const router = useRouter();
  const [registros, setRegistros] = useState<Registro[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formFechaComparativa, setFormFechaComparativa] = useState('');
  const [formFestivo, setFormFestivo] = useState(false);
  const [formNombreFestivo, setFormNombreFestivo] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [modalGenerarVisible, setModalGenerarVisible] = useState(false);
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [generandoRango, setGenerandoRango] = useState(false);
  const [errorGenerar, setErrorGenerar] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/api/gestion-festivos`)
      .then((res) => res.json())
      .then((data: { registros?: Registro[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          setRegistros([]);
        } else {
          setError(null);
          const list = Array.isArray(data.registros) ? data.registros : [];
          setRegistros([...list].sort((a, b) => String(b.FechaComparativa ?? b.PK ?? '').localeCompare(String(a.FechaComparativa ?? a.PK ?? ''))));
        }
      })
      .catch((e) => {
        setError(e.message || 'Error de conexión');
        setRegistros([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const valorCelda = useCallback((item: Registro, col: string): string => {
    const raw = valorPorColumna(item, col);
    if (raw === undefined || raw === null) return '—';
    if (col === 'Festivo') {
      const v = raw === true || raw === 'true' || String(raw).toLowerCase() === 'true';
      return v ? 'Sí' : 'No';
    }
    if (Array.isArray(raw)) return raw.length ? String(raw.join(', ')) : '—';
    if (typeof raw === 'object') return JSON.stringify(raw).slice(0, 30);
    return String(raw);
  }, []);

  const abrirModalNuevo = () => {
    setEditingId(null);
    setFormFechaComparativa('');
    setFormFestivo(false);
    setFormNombreFestivo('');
    setErrorForm(null);
    setModalVisible(true);
  };

  const abrirModalEditar = (item: Registro) => {
    const id = valorPorColumna(item, 'id');
    const festivoRaw = valorPorColumna(item, 'Festivo');
    const esFestivo = festivoRaw === true || festivoRaw === 'true' || String(festivoRaw).toLowerCase() === 'true';
    setEditingId(id != null ? String(id) : null);
    setFormFechaComparativa(String(valorPorColumna(item, 'FechaComparativa') ?? item.PK ?? ''));
    setFormFestivo(esFestivo);
    setFormNombreFestivo(String(valorPorColumna(item, 'NombreFestivo') ?? ''));
    setErrorForm(null);
    setModalVisible(true);
  };

  const cerrarModal = () => {
    setModalVisible(false);
    setEditingId(null);
    setErrorForm(null);
  };

  const guardar = async () => {
    const fechaComparativa = formFechaComparativa.trim();
    if (!fechaComparativa) {
      setErrorForm('FechaComparativa obligatoria');
      return;
    }
    setErrorForm(null);
    setGuardando(true);
    try {
      const body: Record<string, unknown> = {
        FechaComparativa: fechaComparativa,
        Festivo: formFestivo,
        NombreFestivo: formFestivo ? formNombreFestivo.trim() : '',
      };
      if (editingId) body.id = editingId;

      const res = await fetch(`${API_URL}/api/gestion-festivos`, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al guardar');
        return;
      }
      refetch();
      setSelectedRowIndex(null);
      cerrarModal();
    } catch (e) {
      setErrorForm(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const borrarSeleccionado = async (item: Registro) => {
    const id = valorPorColumna(item, 'id');
    if (!id) return;
    setGuardando(true);
    try {
      const res = await fetch(`${API_URL}/api/gestion-festivos?id=${encodeURIComponent(String(id))}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al borrar');
        return;
      }
      refetch();
      setSelectedRowIndex(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const exportarExcel = useCallback(() => {
    const headers = ['id', 'PK', 'FechaComparativa', 'Festivo', 'NombreFestivo'];
    const rows = registros.map((r) => {
      const id = valorPorColumna(r, 'id');
      const pk = valorPorColumna(r, 'PK');
      const fecha = valorPorColumna(r, 'FechaComparativa') ?? pk;
      const festivoRaw = valorPorColumna(r, 'Festivo');
      const festivo = festivoRaw === true || festivoRaw === 'true' || String(festivoRaw).toLowerCase() === 'true';
      const nombre = valorPorColumna(r, 'NombreFestivo');
      return [id ?? '', pk ?? '', fecha ?? '', festivo ? 'Sí' : 'No', nombre ?? ''];
    });
    const data = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ComparativaFechas');
    if (Platform.OS === 'web') {
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'comparativa-fechas-cajas.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}comparativa-fechas-cajas.xlsx`;
      FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 })
        .then(() =>
          Sharing.shareAsync(fileUri, {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            dialogTitle: 'Exportar comparativa-fechas-cajas.xlsx',
          })
        )
        .catch(() => setError('No se pudo exportar el archivo'));
    }
  }, [registros]);

  const importarExcel = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const uri = result.assets[0].uri;
      setImporting(true);
      setError(null);
      const response = await fetch(uri);
      const arrayBuffer = await response.arrayBuffer();
      const wb = XLSX.read(arrayBuffer, { type: 'array' });
      const raw = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
      if (!raw.length) {
        setError('El archivo está vacío');
        return;
      }
      const headers = (raw[0] ?? []).map((h) => String(h ?? '').trim());
      const idIdx = headers.findIndex((h) => h.toLowerCase() === 'id');
      const fechaIdx = headers.findIndex((h) => h.toLowerCase() === 'fechacomparativa');
      const festivoIdx = headers.findIndex((h) => h.toLowerCase() === 'festivo');
      const nombreIdx = headers.findIndex((h) => h.toLowerCase() === 'nombrefestivo');
      if (idIdx < 0) {
        setError('El archivo debe tener columna id (formato PK#SK, ej: 2025-01-01#0)');
        return;
      }
      const dataRows = raw.slice(1).filter((row) => row && row[idIdx] != null && String(row[idIdx]).trim() !== '');
      let ok = 0;
      let fail = 0;
      for (const row of dataRows) {
        const id = String(row[idIdx] ?? '').trim();
        if (!id) continue;
        const fecha = fechaIdx >= 0 && row[fechaIdx] != null ? String(row[fechaIdx]).trim() : '';
        const festivoVal = festivoIdx >= 0 ? String(row[festivoIdx] ?? '').toLowerCase() : '';
        const festivo = festivoVal === 'sí' || festivoVal === 'si' || festivoVal === 'true' || festivoVal === '1' || festivoVal === 'yes';
        const nombre = nombreIdx >= 0 ? String(row[nombreIdx] ?? '').trim() : '';
        try {
          const res = await fetch(`${API_URL}/api/gestion-festivos`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id,
              FechaComparativa: fecha || id.split('#')[0],
              Festivo: festivo,
              NombreFestivo: festivo ? nombre : '',
            }),
          });
          if (res.ok) ok++;
          else fail++;
        } catch {
          fail++;
        }
      }
      refetch();
      setError(null);
      if (fail > 0) setError(`Importados: ${ok}. Fallos: ${fail}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al importar');
    } finally {
      setImporting(false);
    }
  }, [refetch]);

  const abrirModalGenerar = () => {
    const mes = mesEnCurso();
    setFechaDesde(mes.inicio);
    setFechaHasta(mes.fin);
    setErrorGenerar(null);
    setModalGenerarVisible(true);
  };

  const generarRango = async () => {
    if (!fechaDesde || !fechaHasta || !/^\d{4}-\d{2}-\d{2}$/.test(fechaDesde) || !/^\d{4}-\d{2}-\d{2}$/.test(fechaHasta)) {
      setErrorGenerar('Indica fecha desde y hasta (YYYY-MM-DD)');
      return;
    }
    if (fechaDesde > fechaHasta) {
      setErrorGenerar('Fecha desde debe ser <= fecha hasta');
      return;
    }
    setErrorGenerar(null);
    setGenerandoRango(true);
    try {
      const res = await fetch(`${API_URL}/api/gestion-festivos/generar-rango`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom: fechaDesde, dateTo: fechaHasta }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorGenerar(data.error || 'Error al generar');
        return;
      }
      refetch();
      setModalGenerarVisible(false);
    } catch (e) {
      setErrorGenerar(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGenerandoRango(false);
    }
  };

  const hoy = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const getRowStyle = useCallback(
    (item: Registro) => {
      const fecha = String(item.FechaComparativa ?? item.PK ?? '');
      if (fecha === hoy) return { backgroundColor: '#fce7f3' };
      return undefined;
    },
    [hoy]
  );

  const registrosFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return registros;
    return registros.filter((r) =>
      COLUMNAS.some((col) => {
        const val = valorCelda(r, col);
        return val !== '—' && val.toLowerCase().includes(q);
      })
    );
  }, [registros, filtroBusqueda, valorCelda]);

  const totalPages = Math.max(1, Math.ceil(registrosFiltrados.length / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const registrosPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return registrosFiltrados.slice(start, start + PAGE_SIZE);
  }, [registrosFiltrados, pageIndexClamped]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    setPageIndex((p) => (p >= totalPages ? Math.max(0, totalPages - 1) : p));
  }, [totalPages]);

  useEffect(() => {
    setPageIndex(0);
  }, [filtroBusqueda]);

  return (
    <View style={styles.container}>
      <View style={styles.generarRow}>
        <TouchableOpacity style={styles.btnGenerar} onPress={abrirModalGenerar} disabled={guardando}>
          <MaterialIcons name="add-circle-outline" size={20} color="#0ea5e9" />
          <Text style={styles.btnGenerarText}>Generar registros</Text>
        </TouchableOpacity>
      </View>
      <TablaBasica<Registro>
        title="Comparativa Fechas Cajas"
        onBack={() => router.back()}
        columnas={COLUMNAS}
        datos={registrosPagina}
        getValorCelda={valorCelda}
        loading={loading}
        error={error}
        onRetry={refetch}
        filtroBusqueda={filtroBusqueda}
        onFiltroChange={setFiltroBusqueda}
        selectedRowIndex={selectedRowIndex}
        onSelectRow={setSelectedRowIndex}
        onCrear={abrirModalNuevo}
        onEditar={(item) => abrirModalEditar(item)}
        onBorrar={borrarSeleccionado}
        guardando={guardando}
        showExport
        onExportClick={exportarExcel}
        showImport
        onImportClick={importarExcel}
        importing={importing}
        paginacion={{
          totalRegistros: registrosFiltrados.length,
          pageSize: PAGE_SIZE,
          pageIndex,
          onPrevPage: () => {
            setPageIndex((p) => Math.max(0, p - 1));
            setSelectedRowIndex(null);
          },
          onNextPage: () => {
            setPageIndex((p) => Math.min(totalPages - 1, p + 1));
            setSelectedRowIndex(null);
          },
        }}
        emptyMessage="No hay registros. Pulsa Crear para añadir."
        emptyFilterMessage="Ningún resultado con el filtro"
        getRowStyle={getRowStyle}
        dense
      />

      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={cerrarModal}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView style={styles.modalWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{editingId ? 'Editar registro' : 'Nuevo registro'}</Text>
                <TouchableOpacity onPress={cerrarModal} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Fecha comparativa *</Text>
                  <TextInput
                    style={styles.formInput}
                    value={formFechaComparativa}
                    onChangeText={setFormFechaComparativa}
                    placeholder="Ej: 2025-01-15 o texto descriptivo"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                <View style={styles.formGroup}>
                  <View style={styles.formRowSwitch}>
                    <Text style={[styles.formLabel, styles.formLabelInRow]}>Festivo</Text>
                    <Switch
                      value={formFestivo}
                      onValueChange={setFormFestivo}
                      trackColor={{ false: '#e2e8f0', true: '#0ea5e9' }}
                      thumbColor="#fff"
                      style={styles.switch}
                    />
                  </View>
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Nombre festivo</Text>
                  <TextInput
                    style={[styles.formInput, !formFestivo && styles.formInputDisabled]}
                    value={formNombreFestivo}
                    onChangeText={setFormNombreFestivo}
                    placeholder={formFestivo ? 'Nombre del festivo' : 'Activa Festivo para editar'}
                    placeholderTextColor="#94a3b8"
                    editable={formFestivo}
                  />
                </View>
              </ScrollView>
              {errorForm ? <Text style={styles.formError}>{errorForm}</Text> : null}
              <View style={styles.modalFooter}>
                <TouchableOpacity
                  style={styles.modalBtn}
                  onPress={guardar}
                  disabled={guardando}
                >
                  {guardando ? (
                    <ActivityIndicator size="small" color="#0ea5e9" />
                  ) : (
                    <MaterialIcons name="save" size={20} color="#0ea5e9" />
                  )}
                  <Text style={styles.modalBtnText}>{editingId ? 'Guardar' : 'Crear'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalGenerarVisible} transparent animationType="fade" onRequestClose={() => setModalGenerarVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setModalGenerarVisible(false)}>
          <KeyboardAvoidingView style={styles.modalWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TouchableOpacity style={styles.modalCard} activeOpacity={1} onPress={() => {}}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Generar registros por rango</Text>
                <TouchableOpacity onPress={() => setModalGenerarVisible(false)} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Fecha desde *</Text>
                  <TextInput
                    style={styles.formInput}
                    value={fechaDesde}
                    onChangeText={setFechaDesde}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Fecha hasta *</Text>
                  <TextInput
                    style={styles.formInput}
                    value={fechaHasta}
                    onChangeText={setFechaHasta}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
              </ScrollView>
              {errorGenerar ? <Text style={styles.formError}>{errorGenerar}</Text> : null}
              <View style={styles.modalFooter}>
                <TouchableOpacity
                  style={styles.modalBtn}
                  onPress={generarRango}
                  disabled={generandoRango}
                >
                  {generandoRango ? (
                    <ActivityIndicator size="small" color="#0ea5e9" />
                  ) : (
                    <MaterialIcons name="play-arrow" size={20} color="#0ea5e9" />
                  )}
                  <Text style={styles.modalBtnText}>Generar</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  generarRow: { flexDirection: 'row', marginBottom: 8 },
  btnGenerar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#f0f9ff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#0ea5e9',
  },
  btnGenerarText: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalWrap: { width: '100%', maxWidth: 420, padding: 24, alignItems: 'center' },
  modalCard: { width: '100%', backgroundColor: '#fff', borderRadius: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#334155' },
  modalClose: { padding: 4 },
  modalBody: { paddingHorizontal: 20, paddingVertical: 16, maxHeight: 400 },
  formGroup: { marginBottom: 12 },
  formRowSwitch: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  formLabelInRow: { marginBottom: 0 },
  formLabel: { fontSize: 12, fontWeight: '500', color: '#475569', marginBottom: 4 },
  formInput: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#334155' },
  formInputDisabled: { backgroundColor: '#f1f5f9', color: '#94a3b8' },
  switch: { transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] },
  formError: { fontSize: 12, color: '#dc2626', paddingHorizontal: 20, paddingVertical: 8 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  modalBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: '#f0f9ff', borderRadius: 10, borderWidth: 1, borderColor: '#0ea5e9' },
  modalBtnText: { fontSize: 14, fontWeight: '600', color: '#0ea5e9' },
});
