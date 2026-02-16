import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
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
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx';
import { ICONS, ICON_SIZE } from '../constants/icons';
import { formatId6 } from '../utils/idFormat';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const DEFAULT_COL_WIDTH = 90;
const MIN_COL_WIDTH = 40;
const MAX_TEXT_LENGTH = 30;
const PAGE_SIZE = 50;

// Atributos exactos de la tabla igp_Empresas en AWS (clave de partición id_empresa; mismo orden que api/server.js TABLE_EMPRESAS_ATTRS).
const ATRIBUTOS_TABLA_EMPRESAS = ['id_empresa', 'Nombre', 'Cif', 'Iban', 'IbanAlternativo', 'Direccion', 'Cp', 'Municipio', 'Provincia', 'Email', 'Telefono', 'Tipo de recibo', 'Vencimiento', 'Etiqueta', 'Cuenta contable', 'Administrador', 'Sede', 'CCC'] as const;

const ORDEN_COLUMNAS = [...ATRIBUTOS_TABLA_EMPRESAS];

/** Campos obligatorios: se validan al guardar y el label muestra asterisco (*) */
const CAMPOS_OBLIGATORIOS = ['Nombre', 'Cif'] as const;

const CAMPOS_FORM: { key: (typeof ATRIBUTOS_TABLA_EMPRESAS)[number]; label: string; required?: boolean }[] = [
  { key: 'Nombre', label: 'Nombre', required: true },
  { key: 'Cif', label: 'CIF', required: true },
  { key: 'Iban', label: 'IBAN' },
  { key: 'IbanAlternativo', label: 'IBAN alternativo' },
  { key: 'Direccion', label: 'Dirección' },
  { key: 'Cp', label: 'CP' },
  { key: 'Municipio', label: 'Municipio' },
  { key: 'Provincia', label: 'Provincia' },
  { key: 'Email', label: 'Email' },
  { key: 'Telefono', label: 'Teléfono' },
  { key: 'Tipo de recibo', label: 'Tipo de recibo' },
  { key: 'Vencimiento', label: 'Vencimiento' },
  { key: 'Etiqueta', label: 'Etiqueta' },
  { key: 'Cuenta contable', label: 'Cuenta contable' },
  { key: 'Administrador', label: 'Administrador' },
  { key: 'Sede', label: 'Sede' },
  { key: 'CCC', label: 'CCC' },
];

const INITIAL_FORM = Object.fromEntries(
  CAMPOS_FORM.map((c) => [c.key, c.key === 'Etiqueta' ? ([] as string[]) : ''])
) as Record<(typeof ATRIBUTOS_TABLA_EMPRESAS)[number], string | string[]>;

type Empresa = Record<string, string | number | undefined>;

function truncar(val: string): string {
  if (val.length <= MAX_TEXT_LENGTH) return val;
  return val.slice(0, MAX_TEXT_LENGTH - 3) + '…';
}

export default function EmpresasScreen() {
  const router = useRouter();
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ Nombre: 220 });
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [modalNuevoVisible, setModalNuevoVisible] = useState(false);
  const [editingEmpresaId, setEditingEmpresaId] = useState<string | null>(null);
  const [formNuevo, setFormNuevo] = useState<Record<string, string | string[]>>(INITIAL_FORM);
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [modalImportVisible, setModalImportVisible] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [etiquetaDraft, setEtiquetaDraft] = useState('');
  const [cifChecking, setCifChecking] = useState(false);
  const [cifExists, setCifExists] = useState(false);
  const [cifCheckError, setCifCheckError] = useState<string | null>(null);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);
  const cifDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const valorEnLocal = useCallback((local: Empresa, key: string) => {
    if (local[key] !== undefined && local[key] !== null) return local[key];
    const found = Object.keys(local).find((k) => k.toLowerCase() === key.toLowerCase());
    return found != null ? local[found] : undefined;
  }, []);

  const abrirModalNuevo = () => {
    setEditingEmpresaId(null);
    setFormNuevo(INITIAL_FORM);
    setEtiquetaDraft('');
    setCifExists(false);
    setCifCheckError(null);
    setModalNuevoVisible(true);
    setErrorForm(null);
  };
  const abrirModalEditar = (empresa: Empresa) => {
    const form: Record<string, string | string[]> = { ...INITIAL_FORM };
    for (const key of CAMPOS_FORM.map((c) => c.key)) {
      const v = valorEnLocal(empresa, key);
      if (key === 'Etiqueta') {
        form[key] = Array.isArray(v) ? [...v] : v != null && v !== '' ? [String(v).trim()] : [];
      } else {
        form[key] = v != null ? String(v) : '';
      }
    }
    setFormNuevo(form);
    setEtiquetaDraft('');
    const idVal = valorEnLocal(empresa, 'id_empresa');
    setEditingEmpresaId(idVal != null ? String(idVal) : null);
    setCifExists(false);
    setCifCheckError(null);
    setModalNuevoVisible(true);
    setErrorForm(null);
  };
  const cerrarModalNuevo = () => {
    setModalNuevoVisible(false);
    setFormNuevo(INITIAL_FORM);
    setEtiquetaDraft('');
    setEditingEmpresaId(null);
    setCifExists(false);
    setCifCheckError(null);
    setErrorForm(null);
  };

  const agregarEtiqueta = useCallback(() => {
    const t = etiquetaDraft.trim();
    if (!t) return;
    setFormNuevo((prev) => ({
      ...prev,
      Etiqueta: [...(Array.isArray(prev.Etiqueta) ? prev.Etiqueta : []), t],
    }));
    setEtiquetaDraft('');
  }, [etiquetaDraft]);

  const quitarEtiqueta = useCallback((idx: number) => {
    setFormNuevo((prev) => {
      const list = Array.isArray(prev.Etiqueta) ? prev.Etiqueta : [];
      return { ...prev, Etiqueta: list.filter((_, i) => i !== idx) };
    });
  }, []);

  const handleCifChange = useCallback(
    (value: string) => {
      setFormNuevo((prev) => ({ ...prev, Cif: value }));
      setCifCheckError(null);
      setCifExists(false);
      if (cifDebounceRef.current) clearTimeout(cifDebounceRef.current);
      const cif = value.trim();
      if (!cif) return;
      cifDebounceRef.current = setTimeout(async () => {
        setCifChecking(true);
        try {
          const params = new URLSearchParams({ cif });
          if (editingEmpresaId) params.set('excludeId', editingEmpresaId);
          const res = await fetch(`${API_URL}/api/empresas/check-cif?${params.toString()}`);
          const data = await res.json();
          if (!res.ok) {
            setCifCheckError(data.error || 'No se pudo comprobar el CIF');
            setCifExists(false);
          } else {
            setCifExists(Boolean(data.exists));
          }
        } catch (e) {
          setCifCheckError(e instanceof Error ? e.message : 'No se pudo comprobar el CIF');
          setCifExists(false);
        } finally {
          setCifChecking(false);
        }
      }, 400);
    },
    [editingEmpresaId]
  );

  const cerrarModalImport = () => {
    setModalImportVisible(false);
    setImportError(null);
    setImportMessage(null);
  };

  const fetchCpAndFill = useCallback((cp: string) => {
    const normalized = cp?.trim().replace(/\s/g, '') || '';
    if (normalized.length !== 5 || !/^\d{5}$/.test(normalized)) return;
    fetch(`${API_URL}/api/codigo-postal?cp=${encodeURIComponent(normalized)}`)
      .then((r) => r.json())
      .then((data: { municipio?: string; provincia?: string }) => {
        const municipio = data.municipio?.trim() || '';
        const provincia = data.provincia?.trim() || '';
        if (municipio || provincia) {
          setFormNuevo((prev) => ({
            ...prev,
            Municipio: municipio || prev.Municipio,
            Provincia: provincia || prev.Provincia,
          }));
        }
      })
      .catch(() => {});
  }, []);

  const handleCpBlur = useCallback(() => {
    const cp = formNuevo.Cp;
    fetchCpAndFill(typeof cp === 'string' ? cp : '');
  }, [formNuevo.Cp, fetchCpAndFill]);

  const handleCpChange = useCallback(
    (t: string) => {
      setFormNuevo((prev) => ({ ...prev, Cp: t }));
      const normalized = t.trim().replace(/\s/g, '');
      if (normalized.length === 5 && /^\d{5}$/.test(normalized)) fetchCpAndFill(normalized);
    },
    [fetchCpAndFill]
  );

  const ordenarPorId = useCallback((lista: Empresa[]) => {
    return [...lista].sort((a, b) => {
      const idA = valorEnLocal(a, 'id_empresa');
      const idB = valorEnLocal(b, 'id_empresa');
      const na = typeof idA === 'number' ? idA : parseInt(String(idA ?? 0).replace(/^0+/, ''), 10) || 0;
      const nb = typeof idB === 'number' ? idB : parseInt(String(idB ?? 0).replace(/^0+/, ''), 10) || 0;
      return na - nb;
    });
  }, [valorEnLocal]);

  const refetchEmpresas = useCallback(() => {
    fetch(`${API_URL}/api/empresas`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setEmpresas(ordenarPorId(data.empresas || []));
      })
      .catch((e) => setError(e.message || 'Error de conexión'));
  }, [ordenarPorId]);

  const descargarModeloExcel = useCallback(() => {
    const headers = [...ORDEN_COLUMNAS];
    const rows = empresas.map((e) =>
      ORDEN_COLUMNAS.map((col) => {
        const v = valorEnLocal(e, col);
        if (col.startsWith('id_')) return formatId6(v ?? '');
        if (col === 'Etiqueta') return Array.isArray(v) ? v.join(', ') : v != null ? String(v) : '';
        return v ?? '';
      })
    );
    const data = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Empresas');
    if (Platform.OS === 'web') {
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'empresas_modelo.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}empresas_modelo.xlsx`;
      FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 })
        .then(() => Sharing.shareAsync(fileUri, { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dialogTitle: 'Guardar empresas_modelo.xlsx' }))
        .catch(() => setImportError('No se pudo guardar el archivo'));
    }
  }, [empresas, valorEnLocal]);

  const importarExcel = useCallback(async () => {
    setImportError(null);
    setImportMessage(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const uri = result.assets[0].uri;
      setImporting(true);
      const response = await fetch(uri);
      const arrayBuffer = await response.arrayBuffer();
      const wb = XLSX.read(arrayBuffer, { type: 'array' });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<string[]>(firstSheet, { header: 1 });
      if (!raw.length) {
        setImportError('El archivo está vacío');
        return;
      }
      const headers = raw[0].map((h) => String(h ?? '').trim());
      const expected = [...ORDEN_COLUMNAS];
      if (headers.length !== expected.length || headers.some((h, i) => h !== expected[i])) {
        setImportError(`El archivo debe tener exactamente las mismas columnas y en el mismo orden: ${expected.join(', ')}`);
        return;
      }
      const dataRows = raw.slice(1).filter((row) => row && row.some((c) => c != null && String(c).trim() !== ''));
      const idColIndex = expected.indexOf('id_empresa');
      let nextIdNum = 1;
      try {
        const resList = await fetch(`${API_URL}/api/empresas`);
        const dataList = await resList.json();
        const currentList = (dataList.empresas || []) as Empresa[];
        if (currentList.length > 0) {
          const ids = currentList.map((e) => {
            const v = valorEnLocal(e, 'id_empresa');
            const n = typeof v === 'number' ? v : parseInt(String(v ?? 0).replace(/^0+/, ''), 10);
            return Number.isNaN(n) ? 0 : n;
          });
          nextIdNum = Math.max(0, ...ids) + 1;
        }
      } catch {
        /* usar 1 como siguiente id si falla la petición */
      }
      let ok = 0;
      let fail = 0;
      for (const row of dataRows) {
        const body: Record<string, string | string[]> = {};
        expected.forEach((col, i) => {
          const rawVal = row[i] != null ? String(row[i]).trim() : '';
          if (col === 'Etiqueta') {
            body[col] = rawVal ? rawVal.split(',').map((s) => s.trim()).filter(Boolean) : [];
          } else {
            body[col] = rawVal;
          }
        });
        const idEmptyOrZero =
          !body.id_empresa ||
          body.id_empresa === '' ||
          (parseInt(String(body.id_empresa).replace(/^0+/, ''), 10) || 0) === 0;
        if (idColIndex >= 0 && idEmptyOrZero) {
          body.id_empresa = formatId6(nextIdNum);
          nextIdNum += 1;
        } else if (body.id_empresa) {
          body.id_empresa = formatId6(typeof body.id_empresa === 'string' ? body.id_empresa : String(body.id_empresa));
          const parsed = parseInt(String(body.id_empresa).replace(/^0+/, ''), 10);
          if (!Number.isNaN(parsed)) nextIdNum = Math.max(nextIdNum, parsed + 1);
        }
        try {
          const res = await fetch(`${API_URL}/api/empresas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (res.ok && !data.error) ok++;
          else fail++;
        } catch {
          fail++;
        }
      }
      setImportMessage(`${ok} registro(s) importados correctamente${fail > 0 ? `; ${fail} fallaron` : ''}.`);
      refetchEmpresas();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Error al leer el archivo');
    } finally {
      setImporting(false);
    }
  }, [refetchEmpresas, valorEnLocal]);

  const guardarNuevo = async () => {
    const isEdit = editingEmpresaId != null;
    for (const key of CAMPOS_OBLIGATORIOS) {
      const val = formNuevo[key];
      const str = typeof val === 'string' ? val : '';
      if (!str.trim()) {
        const label = CAMPOS_FORM.find((c) => c.key === key)?.label ?? key;
        setErrorForm(`${label} es obligatorio`);
        return;
      }
    }
    if (cifExists) {
      setErrorForm('CIF ya existe');
      return;
    }
    setErrorForm(null);
    setGuardando(true);
    try {
      const body: Record<string, string | number | string[]> = {};
      for (const key of ATRIBUTOS_TABLA_EMPRESAS) {
        if (key === 'id_empresa') body[key] = isEdit ? editingEmpresaId! : próximoId;
        else if (key === 'Etiqueta') body[key] = Array.isArray(formNuevo.Etiqueta) ? formNuevo.Etiqueta : [];
        else body[key] = (formNuevo[key] ?? '') as string;
      }
      const res = await fetch(`${API_URL}/api/empresas`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al guardar');
        return;
      }
      refetchEmpresas();
      setSelectedRowIndex(null);
      cerrarModalNuevo();
    } catch (e) {
      setErrorForm('No se pudo conectar con el servidor');
    } finally {
      setGuardando(false);
    }
  };

  const borrarSeleccionado = async () => {
    if (selectedRowIndex == null) return;
    const empresa = empresasPagina[selectedRowIndex];
    const id = valorEnLocal(empresa, 'id_empresa');
    const idStr = id != null ? String(id) : '';
    if (!idStr) return;
    setGuardando(true);
    try {
      const res = await fetch(`${API_URL}/api/empresas`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_empresa: idStr }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al borrar');
        return;
      }
      refetchEmpresas();
      setSelectedRowIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const próximoId = (() => {
    if (!empresas.length) return formatId6(1);
    const ids = empresas.map((u) => {
      const v = valorEnLocal(u, 'id_empresa');
      const n = typeof v === 'number' ? v : parseInt(String(v ?? 0).replace(/^0+/, ''), 10);
      return Number.isNaN(n) ? 0 : n;
    });
    return formatId6(Math.max(0, ...ids) + 1);
  })();

  const seleccionarFila = (idx: number) => {
    setSelectedRowIndex((prev) => (prev === idx ? null : idx));
  };

  const toolbarBtns = [
    { id: 'crear', label: 'Crear registro', icon: ICONS.add },
    { id: 'editar', label: 'Editar', icon: ICONS.edit },
    { id: 'borrar', label: 'Borrar', icon: ICONS.delete },
  ];

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? DEFAULT_COL_WIDTH, [columnWidths]);

  // Columnas siempre definidas aunque no haya filas (igual que Usuarios/Locales)
  const columnas = useMemo(() => [...ORDEN_COLUMNAS], []);

  const valorCelda = useCallback((empresa: Empresa, col: string) => {
    if (col === 'Etiqueta') {
      const key = Object.keys(empresa).find((k) => k.toLowerCase() === 'etiqueta');
      const raw = key != null ? empresa[key] : empresa.Etiqueta ?? empresa.Alias;
      if (raw == null) return '—';
      if (Array.isArray(raw)) return raw.length ? raw.join(', ') : '—';
      return String(raw);
    }
    if (col.startsWith('id_')) {
      const key = Object.keys(empresa).find((k) => k.toLowerCase() === col.toLowerCase());
      const raw = key != null ? empresa[key] : empresa[col as keyof Empresa];
      return raw != null ? formatId6(raw) : '—';
    }
    // Resolver valor por clave (soporta distinta capitalización desde API/DynamoDB)
    const key = Object.keys(empresa).find((k) => k.toLowerCase() === col.toLowerCase());
    const raw = key != null ? empresa[key] : empresa[col as keyof Empresa];
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') return String(raw);
    return '—';
  }, []);

  const empresasFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return empresas;
    return empresas.filter((u) => {
      return columnas.some((col) => {
        const val = valorCelda(u, col);
        return val !== '—' && val.toLowerCase().includes(q);
      });
    });
  }, [empresas, filtroBusqueda, columnas, valorCelda]);

  const totalFiltrados = empresasFiltrados.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltrados / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);

  const empresasPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return empresasFiltrados.slice(start, start + PAGE_SIZE);
  }, [empresasFiltrados, pageIndexClamped]);

  useEffect(() => {
    setPageIndex((prev) => (prev >= totalPages ? Math.max(0, totalPages - 1) : prev));
  }, [totalPages]);

  useEffect(() => {
    setPageIndex(0);
  }, [filtroBusqueda]);

  const goPrevPage = () => {
    setPageIndex((p) => Math.max(0, p - 1));
    setSelectedRowIndex(null);
  };
  const goNextPage = () => {
    setPageIndex((p) => Math.min(totalPages - 1, p + 1));
    setSelectedRowIndex(null);
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/empresas`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setEmpresas(ordenarPorId(data.empresas || []));
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Error de conexión');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ordenarPorId]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !resizingCol) return;
    const handleMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const delta = e.clientX - r.startX;
      const next = Math.max(MIN_COL_WIDTH, r.startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [r.col]: next }));
    };
    const handleUp = () => {
      resizeRef.current = null;
      setResizingCol(null);
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [resizingCol]);

  const handleResizeStart = (col: string, e: { nativeEvent?: { clientX: number }; clientX?: number }) => {
    if (Platform.OS !== 'web') return;
    const clientX = e.nativeEvent?.clientX ?? (e as { clientX: number }).clientX ?? 0;
    resizeRef.current = { col, startX: clientX, startWidth: getColWidth(col) };
    setResizingCol(col);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando empresas…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color="#f87171" />
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Empresas</Text>
      </View>

      <View style={styles.toolbarRow}>
        <View style={styles.toolbar}>
          {toolbarBtns.map((btn) => (
            <View
              key={btn.id}
              style={styles.toolbarBtnWrap}
              {...(Platform.OS === 'web'
                ? ({
                    onMouseEnter: () => setHoveredBtn(btn.id),
                    onMouseLeave: () => setHoveredBtn(null),
                  } as object)
                : {})}
            >
              {hoveredBtn === btn.id && (
                <View style={styles.tooltip}>
                  <Text style={styles.tooltipText}>{btn.label}</Text>
                </View>
              )}
              <TouchableOpacity
                style={[
                  styles.toolbarBtn,
                  (btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null && styles.toolbarBtnDisabled,
                ]}
                onPress={() => {
                  if (btn.id === 'crear') abrirModalNuevo();
                  if (btn.id === 'editar' && selectedRowIndex != null) abrirModalEditar(empresasPagina[selectedRowIndex]);
                  if (btn.id === 'borrar' && selectedRowIndex != null) borrarSeleccionado();
                }}
                disabled={guardando || ((btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null)}
                accessibilityLabel={btn.label}
              >
                <MaterialIcons name={btn.icon} size={ICON_SIZE} color={guardando || ((btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null) ? '#94a3b8' : '#0ea5e9'} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar en la tabla…"
            placeholderTextColor="#94a3b8"
          />
        </View>
        <View
          style={styles.toolbarBtnWrap}
          {...(Platform.OS === 'web'
            ? ({
                onMouseEnter: () => setHoveredBtn('importar'),
                onMouseLeave: () => setHoveredBtn(null),
              } as object)
            : {})}
        >
          {hoveredBtn === 'importar' && (
            <View style={styles.tooltip}>
              <Text style={styles.tooltipText}>Importar</Text>
            </View>
          )}
          <TouchableOpacity
            style={styles.toolbarBtn}
            onPress={() => {
              setModalImportVisible(true);
              setImportError(null);
              setImportMessage(null);
            }}
            disabled={guardando || importing}
            accessibilityLabel="Importar"
          >
            <MaterialIcons name="upload-file" size={ICON_SIZE} color={guardando || importing ? '#94a3b8' : '#0ea5e9'} />
          </TouchableOpacity>
        </View>
        <View
          style={styles.toolbarBtnWrap}
          {...(Platform.OS === 'web'
            ? ({
                onMouseEnter: () => setHoveredBtn('edicion-rapida'),
                onMouseLeave: () => setHoveredBtn(null),
              } as object)
            : {})}
        >
          {hoveredBtn === 'edicion-rapida' && (
            <View style={styles.tooltip}>
              <Text style={styles.tooltipText}>Edición rápida</Text>
            </View>
          )}
          <TouchableOpacity
            style={[styles.toolbarBtn, selectedRowIndex == null && styles.toolbarBtnDisabled]}
            onPress={() => {
              if (selectedRowIndex != null) abrirModalEditar(empresasPagina[selectedRowIndex]);
            }}
            disabled={guardando || selectedRowIndex == null}
            accessibilityLabel="Edición rápida"
          >
            <MaterialIcons
              name="speed"
              size={ICON_SIZE}
              color={guardando || selectedRowIndex == null ? '#94a3b8' : '#0ea5e9'}
            />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.subtitleRow}>
        <Text style={styles.subtitle}>
          {totalFiltrados === 0
            ? '0 registros'
            : totalPages > 1
              ? `${pageIndexClamped * PAGE_SIZE + 1}–${Math.min((pageIndexClamped + 1) * PAGE_SIZE, totalFiltrados)} de ${totalFiltrados} registro${totalFiltrados !== 1 ? 's' : ''}`
              : `${totalFiltrados} registro${totalFiltrados !== 1 ? 's' : ''}`}
        </Text>
        {totalPages > 1 && (
          <View style={styles.pagination}>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped <= 0 && styles.pageBtnDisabled]}
              onPress={goPrevPage}
              disabled={pageIndexClamped <= 0}
              accessibilityLabel="Página anterior"
            >
              <MaterialIcons name="chevron-left" size={20} color={pageIndexClamped <= 0 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
            <Text style={styles.pageText}>
              Página {pageIndexClamped + 1} de {totalPages}
            </Text>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped >= totalPages - 1 && styles.pageBtnDisabled]}
              onPress={goNextPage}
              disabled={pageIndexClamped >= totalPages - 1}
              accessibilityLabel="Página siguiente"
            >
              <MaterialIcons name="chevron-right" size={20} color={pageIndexClamped >= totalPages - 1 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      <ScrollView horizontal style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.table}>
          <View style={styles.rowHeader}>
            {columnas.map((col) => (
              <View key={col} style={[styles.cellHeader, { width: getColWidth(col) }]}>
                <Text style={styles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">
                  {col}
                </Text>
                {Platform.OS === 'web' && (
                  <View
                    style={styles.resizeHandle}
                    {...({
                      onMouseDown: (e: { nativeEvent?: { clientX: number }; clientX?: number }) =>
                        handleResizeStart(col, e),
                    } as object)}
                  />
                )}
              </View>
            ))}
          </View>
          {empresasPagina.map((empresa, idx) => (
            <TouchableOpacity
              key={idx}
              style={[styles.row, selectedRowIndex === idx && styles.rowSelected]}
              onPress={() => seleccionarFila(idx)}
              activeOpacity={0.8}
            >
              {columnas.map((col) => {
                const raw = valorCelda(empresa, col);
                const text = col === 'Nombre' ? raw : raw.length > MAX_TEXT_LENGTH ? truncar(raw) : raw;
                return (
                  <View key={col} style={[styles.cell, { width: getColWidth(col) }]}>
                    <Text style={styles.cellText} numberOfLines={1} ellipsizeMode="tail">
                      {text}
                    </Text>
                  </View>
                );
              })}
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      <Modal visible={modalNuevoVisible} transparent animationType="fade" onRequestClose={cerrarModalNuevo}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView style={styles.modalContentWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardTouch}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{editingEmpresaId != null ? 'Editar registro' : 'Nuevo registro'}</Text>
                  <TouchableOpacity onPress={cerrarModalNuevo} style={styles.modalClose}>
                    <MaterialIcons name="close" size={22} color="#64748b" />
                  </TouchableOpacity>
                </View>
                <View style={styles.modalBodyRow}>
                  <View style={styles.modalIdSide}>
                    <Text style={styles.modalIdLabel}>ID</Text>
                    <Text style={styles.modalIdValue}>{formatId6(editingEmpresaId ?? próximoId)}</Text>
                  </View>
                  <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                    {CAMPOS_FORM.map((campo) =>
                      campo.key === 'Etiqueta' ? (
                        <View key={campo.key} style={styles.formGroup}>
                          <Text style={styles.formLabel}>{campo.label}{campo.required ? ' *' : ''}</Text>
                          <View style={styles.etiquetasWrap}>
                            {(Array.isArray(formNuevo.Etiqueta) ? formNuevo.Etiqueta : []).map((tag, idx) => (
                              <View key={idx} style={styles.etiquetaChip}>
                                <Text style={styles.etiquetaChipText} numberOfLines={1}>
                                  {tag}
                                </Text>
                                <TouchableOpacity
                                  onPress={() => quitarEtiqueta(idx)}
                                  style={styles.etiquetaChipRemove}
                                  hitSlop={6}
                                  accessibilityLabel="Quitar etiqueta"
                                >
                                  <MaterialIcons name="close" size={14} color="#64748b" />
                                </TouchableOpacity>
                              </View>
                            ))}
                            <TextInput
                              style={styles.etiquetaInput}
                              value={etiquetaDraft}
                              onChangeText={(t) => {
                                if (t.includes(',')) {
                                  const parts = t.split(',').map((s) => s.trim()).filter(Boolean);
                                  if (parts.length) {
                                    setFormNuevo((prev) => ({
                                      ...prev,
                                      Etiqueta: [...(Array.isArray(prev.Etiqueta) ? prev.Etiqueta : []), ...parts],
                                    }));
                                    setEtiquetaDraft('');
                                  }
                                } else setEtiquetaDraft(t);
                              }}
                              onSubmitEditing={agregarEtiqueta}
                              onBlur={agregarEtiqueta}
                              placeholder="Añadir etiqueta (Enter o coma)"
                              placeholderTextColor="#94a3b8"
                              autoCapitalize="none"
                            />
                          </View>
                        </View>
                      ) : (
                        <View key={campo.key} style={styles.formGroup}>
                          <Text style={styles.formLabel}>{campo.label}{campo.required ? ' *' : ''}</Text>
                          <TextInput
                            style={styles.formInput}
                            value={(formNuevo[campo.key] ?? '') as string}
                            onChangeText={
                              campo.key === 'Cp'
                                ? handleCpChange
                                : campo.key === 'Cif'
                                  ? handleCifChange
                                  : (t) => setFormNuevo((prev) => ({ ...prev, [campo.key]: t }))
                            }
                            onBlur={campo.key === 'Cp' ? handleCpBlur : undefined}
                            placeholder={`${campo.label}…`}
                            placeholderTextColor="#94a3b8"
                            autoCapitalize={campo.key === 'Iban' || campo.key === 'IbanAlternativo' ? 'none' : 'words'}
                          />
                          {campo.key === 'Cif' && (
                            <View style={styles.formHelpWrap}>
                              {cifChecking ? (
                                <Text style={styles.formHelpText}>Comprobando CIF…</Text>
                              ) : cifExists ? (
                                <Text style={styles.formErrorText}>CIF ya existe</Text>
                              ) : cifCheckError ? (
                                <Text style={styles.formErrorText}>{cifCheckError}</Text>
                              ) : null}
                            </View>
                          )}
                        </View>
                      )
                    )}
                  </ScrollView>
                </View>
                {errorForm ? <Text style={styles.modalError}>{errorForm}</Text> : null}
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalFooterBtn} onPress={guardarNuevo} accessibilityLabel={editingEmpresaId != null ? 'Guardar' : 'Añadir'} disabled={guardando}>
                    {guardando ? <ActivityIndicator size="small" color="#0ea5e9" /> : <MaterialIcons name={editingEmpresaId != null ? 'save' : ICONS.add} size={ICON_SIZE} color="#0ea5e9" />}
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalImportVisible} transparent animationType="fade" onRequestClose={cerrarModalImport}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalContentWrap}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Importar datos</Text>
                <TouchableOpacity onPress={cerrarModalImport} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={styles.modalBody}>
                <Text style={styles.importHelpText}>
                  Descargue el archivo modelo con la estructura y datos actuales, o importe un Excel con las mismas columnas y en el mismo orden para evitar errores.
                </Text>
                <View style={styles.importButtonsRow}>
                  <TouchableOpacity
                    style={styles.importOptionBtn}
                    onPress={descargarModeloExcel}
                    disabled={importing}
                    accessibilityLabel="Descargar archivo modelo"
                  >
                    <MaterialIcons name="download" size={22} color="#0ea5e9" />
                    <Text style={styles.importOptionLabel}>Descargar archivo modelo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.importOptionBtn}
                    onPress={importarExcel}
                    disabled={importing}
                    accessibilityLabel="Importar Excel"
                  >
                    {importing ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <MaterialIcons name="upload-file" size={22} color="#0ea5e9" />
                    )}
                    <Text style={styles.importOptionLabel}>Importar Excel</Text>
                  </TouchableOpacity>
                </View>
                {importError ? <Text style={styles.modalError}>{importError}</Text> : null}
                {importMessage ? <Text style={styles.importSuccessText}>{importMessage}</Text> : null}
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  errorText: { fontSize: 12, color: '#f87171', textAlign: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 140, maxWidth: 280, height: 32, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 8 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 12, color: '#334155', paddingVertical: 0 },
  toolbarBtnWrap: { position: 'relative' },
  tooltip: { position: 'absolute', bottom: '100%', alignSelf: 'center', marginBottom: 4, backgroundColor: '#334155', paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4, zIndex: 10 },
  tooltipText: { fontSize: 9, color: '#f8fafc', fontWeight: '400' },
  toolbarBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  toolbarBtnDisabled: { opacity: 0.6 },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 12,
    flexWrap: 'wrap',
  },
  subtitle: { fontSize: 12, color: '#64748b' },
  pagination: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pageBtn: { padding: 4 },
  pageBtnDisabled: { opacity: 0.5 },
  pageText: { fontSize: 11, color: '#64748b', marginHorizontal: 4 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20 },
  table: { minWidth: '100%', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' },
  rowHeader: { flexDirection: 'row', backgroundColor: '#e2e8f0', borderBottomWidth: 1, borderBottomColor: '#cbd5e1' },
  cellHeader: { minWidth: MIN_COL_WIDTH, paddingVertical: 6, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#cbd5e1', position: 'relative' },
  cellHeaderText: { fontSize: 11, fontWeight: '600', color: '#334155' },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize' as 'pointer',
  },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', backgroundColor: '#fff' },
  rowSelected: { backgroundColor: '#e0f2fe' },
  cell: { minWidth: MIN_COL_WIDTH, paddingVertical: 4, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  cellText: { fontSize: 11, color: '#475569' },
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalContentWrap: { width: '100%', maxWidth: 420, padding: 24, alignItems: 'center' },
  modalCardTouch: { width: '100%' },
  modalCard: { width: '100%', backgroundColor: 'rgba(255, 255, 255, 0.9)', borderRadius: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#334155' },
  modalClose: { padding: 4 },
  modalBodyRow: { flexDirection: 'row' },
  modalIdSide: { width: 56, paddingVertical: 12, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#e2e8f0', alignItems: 'center', justifyContent: 'flex-start' },
  modalIdLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', marginBottom: 2 },
  modalIdValue: { fontSize: 14, fontWeight: '600', color: '#334155' },
  modalBody: { flex: 1, maxHeight: 400, paddingHorizontal: 16, paddingVertical: 12 },
  formGroup: { marginBottom: 8 },
  formLabel: { fontSize: 10, fontWeight: '500', color: '#475569', marginBottom: 2 },
  formInput: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, fontSize: 13, color: '#334155' },
  formHelpWrap: { marginTop: 4 },
  formHelpText: { fontSize: 10, color: '#64748b' },
  formErrorText: { fontSize: 10, color: '#f87171' },
  etiquetasWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, minHeight: 36 },
  etiquetaChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#e2e8f0', borderRadius: 6, paddingLeft: 8, paddingVertical: 4, maxWidth: 160 },
  etiquetaChipText: { fontSize: 12, color: '#334155', flex: 1 },
  etiquetaChipRemove: { padding: 2 },
  etiquetaInput: { flex: 1, minWidth: 120, fontSize: 13, color: '#334155', paddingVertical: 4, paddingHorizontal: 4 },
  modalError: { fontSize: 11, color: '#f87171', paddingHorizontal: 20, paddingVertical: 4 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  modalFooterBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  importHelpText: { fontSize: 12, color: '#475569', marginBottom: 16, lineHeight: 18 },
  importButtonsRow: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  importOptionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  importOptionLabel: { fontSize: 12, color: '#334155', fontWeight: '500' },
  importSuccessText: { fontSize: 11, color: '#22c55e', paddingHorizontal: 20, paddingVertical: 4 },
});
