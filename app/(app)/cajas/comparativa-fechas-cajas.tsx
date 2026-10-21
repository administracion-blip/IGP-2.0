import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
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
import { InputFecha } from '../../components/InputFecha';
import { apiFetch } from '../../utils/api';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';


const PAGE_SIZE = 50;
const COLUMNAS = ['PK / FechaComparativa', 'PK', 'FechaComparativa', 'Festivo', 'NombreFestivo'];

const DIAS_ABREV = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function diaContraido(fecha: string | undefined): string {
  if (!fecha || typeof fecha !== 'string') return '—';
  const s = fecha.trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '—';
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  if (isNaN(d.getTime())) return '—';
  return DIAS_ABREV[d.getDay()] ?? '—';
}

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
  const [filtroAño, setFiltroAño] = useState<string | null>(null);
  const [filtroMes, setFiltroMes] = useState<string | null>(null);
  const [modalFiltroAño, setModalFiltroAño] = useState(false);
  const [modalFiltroMes, setModalFiltroMes] = useState(false);
  const [modoEdicion, setModoEdicion] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, { FechaComparativa: string; Festivo: boolean; NombreFestivo: string }>>({});
  const editValuesRef = useRef<typeof editValues>({});
  const [savingRows, setSavingRows] = useState<Set<string>>(new Set());

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch('/api/gestion-festivos')
      .then((res) => res.json())
      .then((data: { registros?: Registro[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          setRegistros([]);
        } else {
          setError(null);
          const list = Array.isArray(data.registros) ? data.registros : [];
          setRegistros([...list].sort((a, b) => String(a.PK ?? a.FechaComparativa ?? '').localeCompare(String(b.PK ?? b.FechaComparativa ?? ''))));
        }
      })
      .catch((e) => {
        setError(e.message || 'Error de conexión');
        setRegistros([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const valorCelda = useCallback((item: Registro, col: string): string => {
    if (col === 'PK / FechaComparativa') {
      const pkRaw = valorPorColumna(item, 'PK');
      const fechaRaw = valorPorColumna(item, 'FechaComparativa');
      const diaPk = diaContraido(pkRaw != null ? String(pkRaw) : undefined);
      const diaFecha = diaContraido(fechaRaw != null ? String(fechaRaw) : undefined);
      if (diaPk === '—' && diaFecha === '—') return '—';
      return `${diaPk} / ${diaFecha}`;
    }
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
        NombreFestivo: formNombreFestivo.trim(),
      };
      if (editingId) body.id = editingId;

      const res = await apiFetch('/api/gestion-festivos', {
        method: editingId ? 'PUT' : 'POST',
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
      const res = await apiFetch(`/api/gestion-festivos?id=${encodeURIComponent(String(id))}`, { method: 'DELETE' });
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
          const res = await apiFetch('/api/gestion-festivos', {
            method: 'PUT',
            body: JSON.stringify({
              id,
              FechaComparativa: fecha || id.split('#')[0],
              Festivo: festivo,
              NombreFestivo: nombre,
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
      setErrorGenerar('Indica una fecha válida (dd/mm/aaaa)');
      return;
    }
    if (fechaDesde > fechaHasta) {
      setErrorGenerar('Fecha desde debe ser <= fecha hasta');
      return;
    }
    setErrorGenerar(null);
    setGenerandoRango(true);
    try {
      const res = await apiFetch('/api/gestion-festivos/generar-rango', {
        method: 'POST',
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
      const fecha = String(item.Fecha ?? item.PK ?? '');
      // Rosa de la fila de hoy; no hay token.
      if (fecha === hoy) return { backgroundColor: '#fce7f3' };
      return undefined;
    },
    [hoy]
  );

  const getItemId = useCallback((item: Registro): string => {
    return String(valorPorColumna(item, 'id') ?? '');
  }, []);

  const handleEditChange = useCallback((id: string, field: 'FechaComparativa' | 'Festivo' | 'NombreFestivo', value: string | boolean) => {
    const row = { ...(editValuesRef.current[id] ?? { FechaComparativa: '', Festivo: false, NombreFestivo: '' }), [field]: value };
    const next = { ...editValuesRef.current, [id]: row };
    editValuesRef.current = next;
    setEditValues(next);
  }, []);

  const guardarFilaInline = useCallback(async (id: string, overrideVals?: { FechaComparativa: string; Festivo: boolean; NombreFestivo: string }) => {
    const vals = overrideVals ?? editValuesRef.current[id];
    if (!vals) return;
    setSavingRows((prev) => new Set(prev).add(id));
    try {
      const res = await apiFetch('/api/gestion-festivos', {
        method: 'PUT',
        body: JSON.stringify({
          id,
          FechaComparativa: vals.FechaComparativa,
          Festivo: vals.Festivo,
          NombreFestivo: vals.NombreFestivo.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Error al guardar');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setSavingRows((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const initEditValues = useCallback(() => {
    const vals: Record<string, { FechaComparativa: string; Festivo: boolean; NombreFestivo: string }> = {};
    registros.forEach((r) => {
      const id = getItemId(r);
      if (!id) return;
      const festivoRaw = valorPorColumna(r, 'Festivo');
      vals[id] = {
        FechaComparativa: String(valorPorColumna(r, 'FechaComparativa') ?? r.PK ?? ''),
        Festivo: festivoRaw === true || festivoRaw === 'true' || String(festivoRaw).toLowerCase() === 'true',
        NombreFestivo: String(valorPorColumna(r, 'NombreFestivo') ?? ''),
      };
    });
    editValuesRef.current = vals;
    setEditValues(vals);
  }, [registros, getItemId]);

  const toggleModoEdicion = useCallback(() => {
    if (!modoEdicion) {
      initEditValues();
    } else {
      refetch();
    }
    setModoEdicion((v) => !v);
  }, [modoEdicion, initEditValues, refetch]);

  const renderCeldaEditable = useCallback((item: Registro, col: string, _defaultText: string): React.ReactNode | null => {
    if (!modoEdicion) return null;
    const id = getItemId(item);
    if (!id) return null;
    const vals = editValues[id];
    if (!vals) return null;
    const saving = savingRows.has(id);

    if (col === 'FechaComparativa') {
      return (
        <TextInput
          style={styles.editInput}
          value={vals.FechaComparativa}
          onChangeText={(t) => handleEditChange(id, 'FechaComparativa', t)}
          onBlur={() => guardarFilaInline(id)}
          editable={!saving}
          selectTextOnFocus
        />
      );
    }
    if (col === 'Festivo') {
      return (
        <TouchableOpacity
          style={[styles.editFestivoBadge, vals.Festivo ? styles.editFestivoSi : styles.editFestivoNo]}
          onPress={() => {
            const newFestivo = !vals.Festivo;
            const newVals = { ...vals, Festivo: newFestivo };
            handleEditChange(id, 'Festivo', newFestivo);
            guardarFilaInline(id, newVals);
          }}
          disabled={saving}
        >
          <Text style={[styles.editFestivoText, vals.Festivo ? styles.editFestivoTextSi : styles.editFestivoTextNo]}>
            {vals.Festivo ? 'Sí' : 'No'}
          </Text>
        </TouchableOpacity>
      );
    }
    if (col === 'NombreFestivo') {
      return (
        <TextInput
          style={styles.editInput}
          value={vals.NombreFestivo}
          onChangeText={(t) => handleEditChange(id, 'NombreFestivo', t)}
          onBlur={() => guardarFilaInline(id)}
          editable={!saving}
          placeholder="Anotación"
          placeholderTextColor={colors.textMuted}
          selectTextOnFocus
        />
      );
    }
    return null;
  }, [modoEdicion, editValues, savingRows, getItemId, handleEditChange, guardarFilaInline]);

  const añosDisponibles = useMemo(() => {
    const años = new Set<string>();
    registros.forEach((r) => {
      const fecha = String(r.Fecha ?? r.PK ?? '');
      const m = fecha.match(/^(\d{4})-\d{2}-\d{2}$/);
      if (m) años.add(m[1]);
    });
    return [...años].sort((a, b) => b.localeCompare(a));
  }, [registros]);

  const mesesNombres: Record<string, string> = {
    '01': 'Enero', '02': 'Febrero', '03': 'Marzo', '04': 'Abril', '05': 'Mayo', '06': 'Junio',
    '07': 'Julio', '08': 'Agosto', '09': 'Septiembre', '10': 'Octubre', '11': 'Noviembre', '12': 'Diciembre',
  };

  const registrosFiltrados = useMemo(() => {
    let list = registros;
    if (filtroAño) {
      list = list.filter((r) => {
        const fecha = String(r.Fecha ?? r.PK ?? '');
        return fecha.startsWith(filtroAño + '-');
      });
    }
    if (filtroMes) {
      list = list.filter((r) => {
        const fecha = String(r.Fecha ?? r.PK ?? '');
        const m = fecha.match(/^\d{4}-(\d{2})-\d{2}$/);
        return m && m[1] === filtroMes;
      });
    }
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) =>
      COLUMNAS.some((col) => {
        const val = valorCelda(r, col);
        return val !== '—' && val.toLowerCase().includes(q);
      })
    );
  }, [registros, filtroBusqueda, filtroAño, filtroMes, valorCelda]);

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
        extraToolbarLeft={
          <View style={styles.filtrosToolbar}>
            <TouchableOpacity
              style={[styles.btnFiltro, filtroAño && styles.btnFiltroActivo]}
              onPress={() => setModalFiltroAño(true)}
            >
              <MaterialIcons name="calendar-today" size={14} color={filtroAño ? colors.surface : colors.textMuted} />
              <Text style={[styles.btnFiltroText, filtroAño && styles.btnFiltroTextActivo]}>
                Año {filtroAño ?? 'Todos'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btnFiltro, filtroMes && styles.btnFiltroActivo]}
              onPress={() => setModalFiltroMes(true)}
            >
              <MaterialIcons name="date-range" size={14} color={filtroMes ? colors.surface : colors.textMuted} />
              <Text style={[styles.btnFiltroText, filtroMes && styles.btnFiltroTextActivo]}>
                Mes {filtroMes ? mesesNombres[filtroMes] : 'Todos'}
              </Text>
            </TouchableOpacity>
          </View>
        }
        extraToolbarRight={
          <View style={styles.toolbarRightGroup}>
            <TouchableOpacity
              style={[styles.btnEdicion, modoEdicion && styles.btnEdicionActivo]}
              onPress={toggleModoEdicion}
              disabled={registros.length === 0}
            >
              <MaterialIcons name="edit" size={16} color={modoEdicion ? colors.surface : colors.accent} />
              <Text style={[styles.btnEdicionText, modoEdicion && styles.btnEdicionTextActivo]}>
                {modoEdicion ? 'Terminar edición' : 'Editar tabla'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnGenerar} onPress={abrirModalGenerar} disabled={guardando}>
              <MaterialIcons name="add-circle-outline" size={18} color={colors.success} />
              <Text style={styles.btnGenerarText}>Generar registros</Text>
            </TouchableOpacity>
          </View>
        }
        renderCell={renderCeldaEditable}
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
        getColumnCellStyle={(col) =>
          col === 'PK'
            ? { cell: styles.cellPk, text: styles.cellPkText }
            : undefined
        }
        dense
      />

      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={cerrarModal}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView style={styles.modalWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{editingId ? 'Editar registro' : 'Nuevo registro'}</Text>
                <TouchableOpacity onPress={cerrarModal} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Fecha comparativa *</Text>
                  <InputFecha
                    valueIso={formFechaComparativa}
                    onChangeIso={setFormFechaComparativa}
                    placeholder="dd/mm/aaaa"
                    style={styles.formInput}
                  />
                </View>
                <View style={styles.formGroup}>
                  <View style={styles.formRowSwitch}>
                    <Text style={[styles.formLabel, styles.formLabelInRow]}>Festivo</Text>
                    <Switch
                      value={formFestivo}
                      onValueChange={setFormFestivo}
                      trackColor={{ false: colors.border, true: colors.accent }}
                      thumbColor={colors.surface}
                      style={styles.switch}
                    />
                  </View>
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Nombre / anotación</Text>
                  <TextInput
                    style={styles.formInput}
                    value={formNombreFestivo}
                    onChangeText={setFormNombreFestivo}
                    placeholder="Nombre del festivo o anotación del día"
                    placeholderTextColor={colors.textMuted}
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
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <MaterialIcons name="save" size={20} color={colors.accent} />
                  )}
                  <Text style={styles.modalBtnText}>{editingId ? 'Guardar' : 'Crear'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalFiltroAño} transparent animationType="fade" onRequestClose={() => setModalFiltroAño(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setModalFiltroAño(false)}>
          <TouchableOpacity style={styles.modalFiltroWrap} activeOpacity={1} onPress={() => {}}>
          <View style={styles.modalFiltroCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Filtrar por año</Text>
              <TouchableOpacity onPress={() => setModalFiltroAño(false)} style={styles.modalClose}>
                <MaterialIcons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalFiltroList}>
              <TouchableOpacity
                style={[styles.modalFiltroItem, !filtroAño && styles.modalFiltroItemActivo]}
                onPress={() => { setFiltroAño(null); setModalFiltroAño(false); setPageIndex(0); }}
              >
                <Text style={[styles.modalFiltroItemText, !filtroAño && styles.modalFiltroItemTextActivo]}>Todos</Text>
              </TouchableOpacity>
              {añosDisponibles.map((año) => (
                <TouchableOpacity
                  key={año}
                  style={[styles.modalFiltroItem, filtroAño === año && styles.modalFiltroItemActivo]}
                  onPress={() => { setFiltroAño(año); setModalFiltroAño(false); setPageIndex(0); }}
                >
                  <Text style={[styles.modalFiltroItemText, filtroAño === año && styles.modalFiltroItemTextActivo]}>{año}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalFiltroMes} transparent animationType="fade" onRequestClose={() => setModalFiltroMes(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setModalFiltroMes(false)}>
          <TouchableOpacity style={styles.modalFiltroWrap} activeOpacity={1} onPress={() => {}}>
          <View style={styles.modalFiltroCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Filtrar por mes</Text>
              <TouchableOpacity onPress={() => setModalFiltroMes(false)} style={styles.modalClose}>
                <MaterialIcons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalFiltroList}>
              <TouchableOpacity
                style={[styles.modalFiltroItem, !filtroMes && styles.modalFiltroItemActivo]}
                onPress={() => { setFiltroMes(null); setModalFiltroMes(false); setPageIndex(0); }}
              >
                <Text style={[styles.modalFiltroItemText, !filtroMes && styles.modalFiltroItemTextActivo]}>Todos</Text>
              </TouchableOpacity>
              {(Object.keys(mesesNombres) as string[]).map((mes) => (
                <TouchableOpacity
                  key={mes}
                  style={[styles.modalFiltroItem, filtroMes === mes && styles.modalFiltroItemActivo]}
                  onPress={() => { setFiltroMes(mes); setModalFiltroMes(false); setPageIndex(0); }}
                >
                  <Text style={[styles.modalFiltroItemText, filtroMes === mes && styles.modalFiltroItemTextActivo]}>
                    {mesesNombres[mes]}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalGenerarVisible} transparent animationType="fade" onRequestClose={() => setModalGenerarVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setModalGenerarVisible(false)}>
          <KeyboardAvoidingView style={styles.modalWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TouchableOpacity style={styles.modalCard} activeOpacity={1} onPress={() => {}}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Generar registros por rango</Text>
                <TouchableOpacity onPress={() => setModalGenerarVisible(false)} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Fecha desde *</Text>
                  <InputFecha
                    valueIso={fechaDesde}
                    onChangeIso={setFechaDesde}
                    placeholder="dd/mm/aaaa"
                    style={styles.formInput}
                  />
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Fecha hasta *</Text>
                  <InputFecha
                    valueIso={fechaHasta}
                    onChangeIso={setFechaHasta}
                    placeholder="dd/mm/aaaa"
                    style={styles.formInput}
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
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <MaterialIcons name="play-arrow" size={20} color={colors.accent} />
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

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1 },
  cellPk: { backgroundColor: colors.navActive },
  cellPkText: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  filtrosToolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  btnGenerar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: statusColors.success.bg,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: '#86efac',
  },
  btnGenerarText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.success },
  btnFiltro: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    height: 28,
    justifyContent: 'center',
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnFiltroActivo: { backgroundColor: colors.accent, borderColor: colors.accent },
  btnFiltroText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight, color: colors.textMuted },
  btnFiltroTextActivo: { color: colors.surface },
  modalFiltroWrap: { width: '100%', maxWidth: 280, alignItems: 'center' },
  modalFiltroCard: { width: '100%', backgroundColor: colors.surface, borderRadius: radius.lg, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 8, overflow: 'hidden' },
  modalFiltroList: { maxHeight: 320, paddingVertical: SPACING.sm },
  modalFiltroItem: { paddingVertical: SPACING.md, paddingHorizontal: 20 },
  modalFiltroItemActivo: { backgroundColor: colors.accentMuted },
  modalFiltroItemText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary },
  modalFiltroItemTextActivo: { color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  /** Más oscuro que colors.overlay. */
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalWrap: { width: '100%', maxWidth: 420, padding: SPACING.xl, alignItems: 'center' },
  modalCard: { width: '100%', backgroundColor: colors.surface, borderRadius: radius.xl, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: SPACING.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalTitle: { fontSize: fontSizes[18], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  modalClose: { padding: SPACING.xs },
  modalBody: { paddingHorizontal: 20, paddingVertical: SPACING.lg, maxHeight: 400 },
  formGroup: { marginBottom: SPACING.md },
  formRowSwitch: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  formLabelInRow: { marginBottom: 0 },
  formLabel: { fontSize: fontSizes[12], fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight, color: colors.textPrimary, marginBottom: SPACING.xs },
  formInput: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO, paddingHorizontal: SPACING.md, paddingVertical: 10, fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary },
  formInputDisabled: { backgroundColor: colors.navActive, color: colors.textMuted },
  switch: { transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] },
  formError: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, paddingHorizontal: 20, paddingVertical: SPACING.sm },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 20, paddingVertical: SPACING.lg, borderTopWidth: 1, borderTopColor: colors.border },
  modalBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: 10, paddingHorizontal: SPACING.lg, backgroundColor: colors.accentMuted, borderRadius: radius.md, borderWidth: 1, borderColor: colors.accent },
  modalBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.accent },
  toolbarRightGroup: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  btnEdicion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: colors.accentMuted,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  btnEdicionActivo: { backgroundColor: colors.accent },
  btnEdicionText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.accent },
  btnEdicionTextActivo: { color: colors.surface },
  editInput: {
    fontFamily: fontFamily.regular, fontSize: fontSizes.badge,
    color: colors.textPrimary,
    backgroundColor: colors.accentMuted,
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: radius.sm,
    paddingHorizontal: SPACING.xs,
    paddingVertical: 1,
  },
  editInputDisabled: {
    backgroundColor: colors.navActive,
    borderColor: colors.border,
    color: colors.textMuted,
  },
  editFestivoBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: radius.md,
    alignSelf: 'flex-start',
  },
  editFestivoSi: { backgroundColor: statusColors.success.bg },
  editFestivoNo: { backgroundColor: colors.navActive },
  editFestivoText: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  editFestivoTextSi: { color: colors.success },
  editFestivoTextNo: { color: colors.textMuted },
});
