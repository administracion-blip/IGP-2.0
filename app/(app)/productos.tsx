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
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx';
import { ICONS, ICON_SIZE } from '../constants/icons';
import { formatId6 } from '../utils/idFormat';
import { TablaBasica } from '../components/TablaBasica';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const PAGE_SIZE = 50;
const MAX_TEXT_LENGTH = 30;

/** Orden preferido para columnas (el resto se añade alfabéticamente) */
const PREFERRED_COLS = ['id_producto', 'Identificacion', 'Nombre', 'CostoPrecio'];
const COLUMNAS_DEFAULT = ['id_producto', 'Identificacion', 'Nombre', 'CostoPrecio'];

/** Columnas preferidas para Productos Ágora (solo campos permitidos por API) */
const PREFERRED_COLS_AGORA = ['Id', 'IGP', 'Name', 'CostPrice', 'BaseSaleFormatId', 'FamilyId', 'VatId'];

const DEFAULT_COL_WIDTH = 90;
const MAX_TEXT_LENGTH_TABLE = 30;

type Producto = Record<string, unknown>;

/** Obtiene las columnas a partir de los datos devueltos por la API */
function columnasFromProductos(
  productos: Producto[],
  preferred = PREFERRED_COLS,
  fallback = COLUMNAS_DEFAULT
): string[] {
  const keySet = new Set<string>();
  for (const p of productos) {
    if (p && typeof p === 'object') {
      for (const k of Object.keys(p)) keySet.add(k);
    }
  }
  const keys = Array.from(keySet);
  const ordered: string[] = [];
  for (const preferredCol of preferred) {
    const found = keys.find((k) => k.toLowerCase() === preferredCol.toLowerCase());
    if (found) ordered.push(found);
  }
  for (const k of keys.sort()) {
    if (!ordered.includes(k)) ordered.push(k);
  }
  return ordered.length ? ordered : [...fallback];
}

function truncar(val: string, max = MAX_TEXT_LENGTH_TABLE): string {
  if (val.length <= max) return val;
  return val.slice(0, max - 3) + '…';
}

function valorPorColumna(item: Producto, col: string): unknown {
  if (item[col] !== undefined && item[col] !== null) return item[col];
  const key = Object.keys(item).find((k) => k.toLowerCase() === col.toLowerCase());
  return key != null ? item[key] : undefined;
}

export default function ProductosScreen() {
  const router = useRouter();
  const [productos, setProductos] = useState<Producto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [modalNuevoVisible, setModalNuevoVisible] = useState(false);
  const [editingProductoId, setEditingProductoId] = useState<string | null>(null);
  const [formNuevo, setFormNuevo] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [modalImportVisible, setModalImportVisible] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [tabActivo, setTabActivo] = useState<'productos' | 'agora'>('productos');
  const [productosAgora, setProductosAgora] = useState<Producto[]>([]);
  const [loadingAgora, setLoadingAgora] = useState(false);
  const [syncingAgora, setSyncingAgora] = useState(false);
  const [errorAgora, setErrorAgora] = useState<string | null>(null);
  const [filtroAgora, setFiltroAgora] = useState('');
  const [pageIndexAgora, setPageIndexAgora] = useState(0);

  const valorEnLocal = useCallback((item: Producto, key: string): string => {
    const raw = valorPorColumna(item, key);
    if (raw === undefined || raw === null) return '—';
    if (Array.isArray(raw)) return raw.length ? String(raw.join(', ')) : '—';
    if (typeof raw === 'object') return JSON.stringify(raw).slice(0, MAX_TEXT_LENGTH);
    return String(raw);
  }, []);

  const ordenarPorId = useCallback((lista: Producto[]) => {
    return [...lista].sort((a, b) => {
      const idA = valorPorColumna(a, 'id_producto');
      const idB = valorPorColumna(b, 'id_producto');
      const na = typeof idA === 'number' ? idA : parseInt(String(idA ?? 0).replace(/^0+/, ''), 10) || 0;
      const nb = typeof idB === 'number' ? idB : parseInt(String(idB ?? 0).replace(/^0+/, ''), 10) || 0;
      return na - nb;
    });
  }, []);

  const refetchProductosAgora = useCallback(() => {
    setLoadingAgora(true);
    setErrorAgora(null);
    fetch(`${API_URL}/api/agora/products`)
      .then((res) => res.json())
      .then((data: { productos?: Producto[]; error?: string }) => {
        if (data.error) {
          setErrorAgora(data.error);
          setProductosAgora([]);
        } else {
          setErrorAgora(null);
          const list = Array.isArray(data.productos) ? data.productos : [];
          setProductosAgora(
            [...list].sort((a, b) => {
              const idA = valorPorColumna(a, 'Id') ?? valorPorColumna(a, 'id');
              const idB = valorPorColumna(b, 'Id') ?? valorPorColumna(b, 'id');
              const na = typeof idA === 'number' ? idA : parseInt(String(idA ?? 0).replace(/^0+/, ''), 10) || 0;
              const nb = typeof idB === 'number' ? idB : parseInt(String(idB ?? 0).replace(/^0+/, ''), 10) || 0;
              return na - nb;
            })
          );
        }
      })
      .catch((e) => {
        setErrorAgora(e.message || 'Error de conexión');
        setProductosAgora([]);
      })
      .finally(() => setLoadingAgora(false));
  }, []);

  const toggleAgoraProductIGP = useCallback(
    async (producto: Producto) => {
      const id = valorPorColumna(producto, 'Id') ?? valorPorColumna(producto, 'id') ?? valorPorColumna(producto, 'Code');
      if (id == null) return;
      const idStr = String(id);
      const actual = valorPorColumna(producto, 'IGP');
      const nuevoVal = actual === true || actual === 'true' ? false : true;
      try {
        const res = await fetch(`${API_URL}/api/agora/products/${encodeURIComponent(idStr)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ IGP: nuevoVal }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          setProductosAgora((prev) =>
            prev.map((p) => {
              const pid = valorPorColumna(p, 'Id') ?? valorPorColumna(p, 'id') ?? valorPorColumna(p, 'Code');
              if (pid != null && String(pid) === idStr) return { ...p, IGP: nuevoVal };
              return p;
            })
          );
        }
      } catch {
        setErrorAgora('Error al actualizar IGP');
      }
    },
    []
  );

  const syncProductosAgora = useCallback(() => {
    setSyncingAgora(true);
    setErrorAgora(null);
    fetch(`${API_URL}/api/agora/products/sync?force=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((res) => res.json())
      .then((data: { ok?: boolean; added?: number; updated?: number; unchanged?: number; fetched?: number; error?: string }) => {
        if (data.error) {
          setErrorAgora(data.error);
        } else if (data.ok) {
          if ((data.added ?? 0) > 0 || (data.updated ?? 0) > 0) {
            refetchProductosAgora();
          }
        }
      })
      .catch((e) => setErrorAgora(e.message || 'Error al sincronizar'))
      .finally(() => setSyncingAgora(false));
  }, [refetchProductosAgora]);

  const refetchProductos = useCallback(() => {
    setRefreshing(true);
    fetch(`${API_URL}/api/productos`)
      .then((res) => res.json())
      .then((data: { productos?: Producto[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          setProductos([]);
        } else {
          setError(null);
          setProductos(ordenarPorId(Array.isArray(data.productos) ? data.productos : []));
        }
      })
      .catch((e) => {
        setError(e.message || 'Error de conexión');
        setProductos([]);
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, [ordenarPorId]);

  /** Columnas derivadas de los campos que devuelve la tabla igp_Productos */
  const columnas = useMemo(
    () => (productos.length > 0 ? columnasFromProductos(productos) : [...COLUMNAS_DEFAULT]),
    [productos]
  );

  /** Columnas para Productos Ágora */
  const columnasAgora = useMemo(
    () =>
      productosAgora.length > 0
        ? columnasFromProductos(productosAgora, PREFERRED_COLS_AGORA, ['Id', 'IGP', 'Name', 'CostPrice'])
        : ['Id', 'IGP', 'Name', 'CostPrice'],
    [productosAgora]
  );

  const valorCeldaAgora = useCallback((item: Producto, col: string) => {
    const raw = valorPorColumna(item, col);
    if (raw === undefined || raw === null) return '—';
    if (Array.isArray(raw)) return raw.length ? String(raw.join(', ')) : '—';
    if (typeof raw === 'object') return JSON.stringify(raw).slice(0, MAX_TEXT_LENGTH_TABLE);
    if (col === 'Price' || col === 'CostPrice') {
      const n = parseFloat(String(raw));
      if (!Number.isNaN(n)) return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    }
    const str = String(raw);
    if (col === 'Id' || col === 'id') return formatId6(str);
    return str;
  }, []);

  const productosAgoraFiltrados = useMemo(() => {
    const q = filtroAgora.trim().toLowerCase();
    if (!q) return productosAgora;
    return productosAgora.filter((p) =>
      columnasAgora.some((col) => {
        const val = valorCeldaAgora(p, col);
        return val !== '—' && val.toLowerCase().includes(q);
      })
    );
  }, [productosAgora, filtroAgora, columnasAgora, valorCeldaAgora]);

  const totalFiltradosAgora = productosAgoraFiltrados.length;
  const totalPagesAgora = Math.max(1, Math.ceil(totalFiltradosAgora / PAGE_SIZE));
  const pageIndexClampedAgora = Math.min(Math.max(0, pageIndexAgora), totalPagesAgora - 1);

  const productosAgoraPagina = useMemo(() => {
    const start = pageIndexClampedAgora * PAGE_SIZE;
    return productosAgoraFiltrados.slice(start, start + PAGE_SIZE);
  }, [productosAgoraFiltrados, pageIndexClampedAgora]);

  const valorCelda = useCallback(
    (item: Producto, col: string) => {
      const raw = valorEnLocal(item, col);
      if (col.toLowerCase() === 'id_producto' && raw !== '—') return formatId6(raw);
      return raw;
    },
    [valorEnLocal]
  );

  const abrirModalNuevo = () => {
    setEditingProductoId(null);
    setFormNuevo(Object.fromEntries(columnas.map((c) => [c, ''])));
    setModalNuevoVisible(true);
    setErrorForm(null);
  };

  const abrirModalEditar = (producto: Producto) => {
    const form: Record<string, string> = {};
    for (const c of columnas) {
      const v = valorPorColumna(producto, c);
      form[c] = v != null && v !== '' ? String(v) : '';
    }
    setFormNuevo(form);
    const idVal = valorPorColumna(producto, 'id_producto');
    setEditingProductoId(idVal != null ? String(idVal) : null);
    setModalNuevoVisible(true);
    setErrorForm(null);
  };

  const cerrarModalNuevo = () => {
    setModalNuevoVisible(false);
    setFormNuevo({});
    setEditingProductoId(null);
    setErrorForm(null);
  };

  const cerrarModalImport = () => {
    setModalImportVisible(false);
    setImportError(null);
    setImportMessage(null);
  };

  const guardarNuevo = async () => {
    const isEdit = editingProductoId != null;
    const nombreKey = Object.keys(formNuevo).find((k) => k.toLowerCase() === 'nombre');
    if (!nombreKey || !String(formNuevo[nombreKey] ?? '').trim()) {
      setErrorForm('Nombre es obligatorio');
      return;
    }
    setErrorForm(null);
    setGuardando(true);
    try {
      const body: Record<string, string> = {
        ...formNuevo,
        id_producto: isEdit ? editingProductoId! : próximoId,
      };
      const res = await fetch(`${API_URL}/api/productos`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al guardar');
        return;
      }
      refetchProductos();
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
    const item = productosPagina[selectedRowIndex] as Producto;
    const idVal = valorPorColumna(item, 'id_producto');
    const idStr = idVal != null ? String(idVal) : '';
    if (!idStr) return;
    setGuardando(true);
    try {
      const res = await fetch(`${API_URL}/api/productos`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_producto: idStr }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al borrar');
        return;
      }
      refetchProductos();
      setSelectedRowIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const próximoId = (() => {
    if (!productos.length) return formatId6(1);
    const ids = productos.map((p) => {
      const v = valorPorColumna(p, 'id_producto');
      const n = typeof v === 'number' ? v : parseInt(String(v ?? 0).replace(/^0+/, ''), 10);
      return Number.isNaN(n) ? 0 : n;
    });
    return formatId6(Math.max(0, ...ids) + 1);
  })();

  const descargarModeloExcel = useCallback(() => {
    const headers = [...columnas];
    const rows = productos.map((p) =>
      headers.map((col) => {
        const v = valorPorColumna(p, col);
        if (col.toLowerCase() === 'id_producto') return formatId6(typeof v === 'string' || typeof v === 'number' ? v : '');
        return v != null && typeof v !== 'object' ? String(v) : '';
      })
    );
    const data = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Productos');
    if (Platform.OS === 'web') {
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'productos_modelo.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}productos_modelo.xlsx`;
      FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 })
        .then(() =>
          Sharing.shareAsync(fileUri, {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            dialogTitle: 'Guardar productos_modelo.xlsx',
          })
        )
        .catch(() => setImportError('No se pudo guardar el archivo'));
    }
  }, [productos, columnas]);

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
      const raw = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
      if (!raw.length) {
        setImportError('El archivo está vacío');
        return;
      }
      const headers = raw[0].map((h) => String(h ?? '').trim());
      const expected = [...columnas];
      if (headers.length !== expected.length || headers.some((h, i) => h !== expected[i])) {
        setImportError(`El archivo debe tener las columnas en este orden: ${expected.join(', ')}`);
        return;
      }
      const dataRows = raw.slice(1).filter((row) => row && row.some((c) => c != null && String(c).trim() !== ''));
      const idColIndex = expected.indexOf('id_producto');
      let nextIdNum = 1;
      try {
        const resList = await fetch(`${API_URL}/api/productos`);
        const dataList = await resList.json();
        const currentList = (dataList.productos || []) as Producto[];
        if (currentList.length > 0) {
          const ids = currentList.map((p) => {
            const v = valorPorColumna(p, 'id_producto');
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
        const body: Record<string, string> = {};
        expected.forEach((col, i) => {
          body[col] = row[i] != null ? String(row[i]).trim() : '';
        });
        const nombreKey = expected.find((k) => k.toLowerCase() === 'nombre');
        if (!nombreKey || !String(body[nombreKey] ?? '').trim()) {
          fail++;
          continue;
        }
        const idEmptyOrZero =
          !body.id_producto?.trim() ||
          (parseInt(String(body.id_producto).replace(/^0+/, ''), 10) || 0) === 0;
        if (idColIndex >= 0 && idEmptyOrZero) {
          body.id_producto = formatId6(nextIdNum);
          nextIdNum += 1;
        } else if (body.id_producto?.trim()) {
          body.id_producto = formatId6(body.id_producto);
          const parsed = parseInt(String(body.id_producto).replace(/^0+/, ''), 10);
          if (!Number.isNaN(parsed)) nextIdNum = Math.max(nextIdNum, parsed + 1);
        }
        try {
          const res = await fetch(`${API_URL}/api/productos`, {
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
      setImportMessage(`${ok} registro(s) importados${fail > 0 ? `; ${fail} fallaron` : ''}.`);
      refetchProductos();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Error al leer el archivo');
    } finally {
      setImporting(false);
    }
  }, [refetchProductos, columnas]);

  const productosFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return productos;
    return productos.filter((p) =>
      columnas.some((col) => {
        const val = valorCelda(p, col);
        return val !== '—' && val.toLowerCase().includes(q);
      })
    );
  }, [productos, filtroBusqueda, columnas, valorCelda]);

  const totalFiltrados = productosFiltrados.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltrados / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);

  const productosPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return productosFiltrados.slice(start, start + PAGE_SIZE);
  }, [productosFiltrados, pageIndexClamped]);

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
    setPageIndexAgora((prev) => (prev >= totalPagesAgora ? Math.max(0, totalPagesAgora - 1) : prev));
  }, [totalPagesAgora]);

  useEffect(() => {
    setPageIndexAgora(0);
  }, [filtroAgora]);

  const goPrevPageAgora = () => setPageIndexAgora((p) => Math.max(0, p - 1));
  const goNextPageAgora = () => setPageIndexAgora((p) => Math.min(totalPagesAgora - 1, p + 1));

  useEffect(() => {
    if (tabActivo === 'agora') {
      // Solo cargar desde DynamoDB (rápido). Sync solo cuando el usuario pulse "Sincronizar"
      refetchProductosAgora();
    }
  }, [tabActivo, refetchProductosAgora]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${API_URL}/api/productos`)
      .then((res) => res.json())
      .then((data: { productos?: Producto[]; error?: string }) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
          setProductos([]);
        } else {
          setError(null);
          setProductos(ordenarPorId(Array.isArray(data.productos) ? data.productos : []));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Error de conexión');
        setProductos([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ordenarPorId]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Productos</Text>
        <View style={styles.tabBar}>
          <TouchableOpacity
            style={[styles.tab, tabActivo === 'productos' && styles.tabActive]}
            onPress={() => setTabActivo('productos')}
          >
            <Text style={[styles.tabText, tabActivo === 'productos' && styles.tabTextActive]}>Productos</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, tabActivo === 'agora' && styles.tabActive]}
            onPress={() => setTabActivo('agora')}
          >
            <Text style={[styles.tabText, tabActivo === 'agora' && styles.tabTextActive]}>Productos Ágora</Text>
          </TouchableOpacity>
        </View>
      </View>

      {tabActivo === 'productos' && (
        <TablaBasica<Producto>
          hideHeader
          title="Productos"
        onBack={() => router.back()}
        columnas={columnas}
        datos={productosPagina}
        getValorCelda={valorCelda}
        loading={loading}
        error={error}
        onRetry={refetchProductos}
        filtroBusqueda={filtroBusqueda}
        onFiltroChange={setFiltroBusqueda}
        selectedRowIndex={selectedRowIndex}
        onSelectRow={setSelectedRowIndex}
        onCrear={abrirModalNuevo}
        onEditar={(item) => abrirModalEditar(item)}
        onBorrar={borrarSeleccionado}
        guardando={guardando}
        showImport
        onImportClick={() => {
          setModalImportVisible(true);
          setImportError(null);
          setImportMessage(null);
        }}
        importing={importing}
        paginacion={{
          totalRegistros: totalFiltrados,
          pageSize: PAGE_SIZE,
          pageIndex,
          onPrevPage: goPrevPage,
          onNextPage: goNextPage,
        }}
        emptyMessage="No hay productos en la tabla"
        emptyFilterMessage="Ningún resultado con el filtro"
        columnasMoneda={['CostoPrecio']}
        />
      )}

      {tabActivo === 'agora' && (
        <View style={styles.agoraContent}>
          <View style={styles.agoraToolbar}>
            <TouchableOpacity
              style={styles.reloadBtn}
              onPress={refetchProductosAgora}
              disabled={loadingAgora}
              accessibilityLabel="Recargar"
            >
              {loadingAgora ? (
                <ActivityIndicator size="small" color="#0ea5e9" />
              ) : (
                <MaterialIcons name="refresh" size={22} color="#0ea5e9" />
              )}
              <Text style={styles.reloadBtnText}>Recargar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.reloadBtn}
              onPress={syncProductosAgora}
              disabled={syncingAgora}
              accessibilityLabel="Sincronizar desde Ágora"
            >
              {syncingAgora ? (
                <ActivityIndicator size="small" color="#0ea5e9" />
              ) : (
                <MaterialIcons name="sync" size={22} color="#0ea5e9" />
              )}
              <Text style={styles.reloadBtnText}>Sincronizar</Text>
            </TouchableOpacity>
            <View style={styles.searchWrap}>
              <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
              <TextInput
                style={styles.searchInput}
                value={filtroAgora}
                onChangeText={setFiltroAgora}
                placeholder="Buscar en la tabla…"
                placeholderTextColor="#94a3b8"
              />
            </View>
          </View>
          {loadingAgora && productosAgora.length === 0 ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color="#0ea5e9" />
              <Text style={styles.loadingText}>Cargando productos Ágora…</Text>
            </View>
          ) : errorAgora && productosAgora.length === 0 ? (
            <View style={styles.center}>
              <MaterialIcons name="error-outline" size={48} color="#f87171" />
              <Text style={styles.errorText}>{errorAgora}</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={refetchProductosAgora}>
                <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
                <Text style={styles.retryBtnText}>Reintentar</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Text style={styles.subtitle}>
                {productosAgoraFiltrados.length} registro{productosAgoraFiltrados.length !== 1 ? 's' : ''}
                {totalPagesAgora > 1 && ` · Página ${pageIndexClampedAgora + 1} de ${totalPagesAgora}`}
              </Text>
              <ScrollView horizontal style={styles.scroll} contentContainerStyle={[styles.scrollContent, { flexGrow: 1 }]}>
                <View style={[styles.table, styles.tableAgora, { minWidth: columnasAgora.reduce((w, c) => w + (c === 'IGP' ? 56 : c === 'Name' ? 180 : DEFAULT_COL_WIDTH), 0) }]}>
                  <View style={styles.rowHeaderAgora}>
                    {columnasAgora.map((col) => (
                      <View key={col} style={[styles.cellHeaderAgora, { width: col === 'IGP' ? 56 : col === 'Name' ? 180 : DEFAULT_COL_WIDTH }]}>
                        <Text style={styles.cellHeaderTextAgora} numberOfLines={1} ellipsizeMode="tail">{col}</Text>
                      </View>
                    ))}
                  </View>
                  <ScrollView style={styles.agoraBodyScroll} nestedScrollEnabled>
                  {productosAgoraPagina.map((p, idx) => {
                    const rowId = valorPorColumna(p, 'Id') ?? valorPorColumna(p, 'id');
                    return (
                    <TouchableOpacity
                      key={rowId != null ? String(rowId) : `page-${pageIndexClampedAgora}-${idx}`}
                      style={styles.rowAgora}
                      onPress={() => {}}
                      activeOpacity={0.7}
                    >
                      {columnasAgora.map((col) => {
                        const isMoneda = col === 'CostPrice';
                        const isIGP = col === 'IGP';
                        const colWidth = isIGP ? 56 : col === 'Name' ? 180 : DEFAULT_COL_WIDTH;
                        const igpVal = isIGP && (valorPorColumna(p, 'IGP') === true || valorPorColumna(p, 'IGP') === 'true');
                        if (isIGP) {
                          return (
                            <TouchableOpacity
                              key={col}
                              style={[styles.cellAgora, styles.cellIGP, { width: colWidth }]}
                              onPress={() => toggleAgoraProductIGP(p)}
                              activeOpacity={0.7}
                            >
                              <MaterialIcons
                                name={igpVal ? 'check-box' : 'check-box-outline-blank'}
                                size={18}
                                color={igpVal ? '#0ea5e9' : '#94a3b8'}
                              />
                            </TouchableOpacity>
                          );
                        }
                        return (
                          <View
                            key={col}
                            style={[
                              styles.cellAgora,
                              { width: colWidth },
                              isMoneda && styles.cellRight,
                            ]}
                          >
                            <Text style={[styles.cellTextAgora, isMoneda && styles.cellTextRight]} numberOfLines={1} ellipsizeMode="tail">
                              {truncar(valorCeldaAgora(p, col))}
                            </Text>
                          </View>
                        );
                      })}
                    </TouchableOpacity>
                  );
                  })}
                  </ScrollView>
                </View>
              </ScrollView>
              {totalPagesAgora > 1 && (
                <View style={styles.paginacionAgora}>
                  <TouchableOpacity
                    style={[styles.pagBtn, pageIndexClampedAgora === 0 && styles.pagBtnDisabled]}
                    onPress={goPrevPageAgora}
                    disabled={pageIndexClampedAgora === 0}
                  >
                    <MaterialIcons name="chevron-left" size={20} color={pageIndexClampedAgora === 0 ? '#94a3b8' : '#0ea5e9'} />
                    <Text style={[styles.pagBtnText, pageIndexClampedAgora === 0 && styles.pagBtnTextDisabled]}>Anterior</Text>
                  </TouchableOpacity>
                  <Text style={styles.pagInfo}>
                    {pageIndexClampedAgora * PAGE_SIZE + 1}-{Math.min((pageIndexClampedAgora + 1) * PAGE_SIZE, totalFiltradosAgora)} de {totalFiltradosAgora}
                  </Text>
                  <TouchableOpacity
                    style={[styles.pagBtn, pageIndexClampedAgora >= totalPagesAgora - 1 && styles.pagBtnDisabled]}
                    onPress={goNextPageAgora}
                    disabled={pageIndexClampedAgora >= totalPagesAgora - 1}
                  >
                    <Text style={[styles.pagBtnText, pageIndexClampedAgora >= totalPagesAgora - 1 && styles.pagBtnTextDisabled]}>Siguiente</Text>
                    <MaterialIcons name="chevron-right" size={20} color={pageIndexClampedAgora >= totalPagesAgora - 1 ? '#94a3b8' : '#0ea5e9'} />
                  </TouchableOpacity>
                </View>
              )}
              {productosAgoraFiltrados.length === 0 && (
                <Text style={styles.emptyText}>
                  {filtroAgora.trim()
                    ? 'Ningún resultado con el filtro'
                    : 'No hay productos. Pulsa Sincronizar para cargar desde Ágora a DynamoDB.'}
                </Text>
              )}
            </>
          )}
        </View>
      )}

      <Modal visible={modalNuevoVisible} transparent animationType="fade" onRequestClose={cerrarModalNuevo}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView style={styles.modalContentWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardTouch}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{editingProductoId != null ? 'Editar registro' : 'Nuevo registro'}</Text>
                  <TouchableOpacity onPress={cerrarModalNuevo} style={styles.modalClose}>
                    <MaterialIcons name="close" size={22} color="#64748b" />
                  </TouchableOpacity>
                </View>
                <View style={styles.modalBodyRow}>
                  <View style={styles.modalIdSide}>
                    <Text style={styles.modalIdLabel}>ID</Text>
                    <Text style={styles.modalIdValue}>{formatId6(editingProductoId ?? próximoId)}</Text>
                  </View>
                  <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                    {columnas.map((col) => {
                      if (col.toLowerCase() === 'id_producto') return null;
                      const isNumeric =
                        col.toLowerCase().includes('precio') ||
                        col.toLowerCase().includes('costo') ||
                        col.toLowerCase().includes('precio');
                      return (
                        <View key={col} style={styles.formGroup}>
                          <Text style={styles.formLabel}>{col}</Text>
                          <TextInput
                            style={styles.formInput}
                            value={formNuevo[col] ?? ''}
                            onChangeText={(t) => setFormNuevo((prev) => ({ ...prev, [col]: t }))}
                            placeholder={`${col}…`}
                            placeholderTextColor="#94a3b8"
                            keyboardType={isNumeric ? 'decimal-pad' : 'default'}
                          />
                        </View>
                      );
                    })}
                  </ScrollView>
                </View>
                {errorForm ? <Text style={styles.modalError}>{errorForm}</Text> : null}
                <View style={styles.modalFooter}>
                  <TouchableOpacity
                    style={styles.modalFooterBtn}
                    onPress={guardarNuevo}
                    accessibilityLabel={editingProductoId != null ? 'Guardar' : 'Añadir'}
                    disabled={guardando}
                  >
                    {guardando ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <MaterialIcons name={editingProductoId != null ? 'save' : ICONS.add} size={ICON_SIZE} color="#0ea5e9" />
                    )}
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
                  Descargue el archivo modelo con la estructura y datos actuales, o importe un Excel con las columnas en este orden: {COLUMNAS_DEFAULT.join(', ')}.
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
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155', flex: 1 },
  tabBar: { flexDirection: 'row', gap: 4 },
  tab: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#f1f5f9' },
  tabActive: { backgroundColor: '#0ea5e9' },
  tabText: { fontSize: 13, color: '#64748b', fontWeight: '500' },
  tabTextActive: { color: '#fff' },
  agoraContent: { flex: 1 },
  agoraToolbar: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12 },
  reloadBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#f1f5f9', borderRadius: 8 },
  reloadBtnText: { fontSize: 13, color: '#0ea5e9', fontWeight: '500' },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: 8, paddingHorizontal: 10 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: 13, color: '#334155' },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20 },
  table: { backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  tableAgora: { flex: 1 },
  rowHeader: { flexDirection: 'row', backgroundColor: '#f1f5f9', borderBottomWidth: 2, borderBottomColor: '#e2e8f0' },
  cellHeader: { paddingVertical: 10, paddingHorizontal: 10 },
  cellHeaderText: { fontSize: 11, fontWeight: '600', color: '#334155' },
  row: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e2e8f0' },
  cell: { paddingVertical: 8, paddingHorizontal: 10 },
  cellIGP: { alignItems: 'center', justifyContent: 'center' },
  cellText: { fontSize: 12, color: '#334155' },
  rowHeaderAgora: { flexDirection: 'row', backgroundColor: '#f1f5f9', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  cellHeaderAgora: { paddingVertical: 5, paddingHorizontal: 6 },
  cellHeaderTextAgora: { fontSize: 9, fontWeight: '600', color: '#334155' },
  agoraBodyScroll: { flex: 1, minHeight: 200 },
  rowAgora: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e2e8f0' },
  cellAgora: { paddingVertical: 4, paddingHorizontal: 6 },
  cellTextAgora: { fontSize: 10, color: '#334155' },
  cellRight: { alignItems: 'flex-end' },
  cellTextRight: { textAlign: 'right' },
  subtitle: { fontSize: 12, color: '#64748b', marginBottom: 6 },
  emptyText: { fontSize: 12, color: '#94a3b8', textAlign: 'center', marginTop: 12 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  errorText: { fontSize: 12, color: '#f87171', textAlign: 'center' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, padding: 8, backgroundColor: '#f8fafc', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  retryBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },
  paginacionAgora: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 12, paddingVertical: 8 },
  pagBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#f1f5f9', borderRadius: 8 },
  pagBtnDisabled: { opacity: 0.6 },
  pagBtnText: { fontSize: 13, color: '#0ea5e9', fontWeight: '500' },
  pagBtnTextDisabled: { color: '#94a3b8' },
  pagInfo: { fontSize: 12, color: '#64748b' },
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
  modalError: { fontSize: 11, color: '#f87171', paddingHorizontal: 20, paddingVertical: 4 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  modalFooterBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  importHelpText: { fontSize: 12, color: '#475569', marginBottom: 16, lineHeight: 18 },
  importButtonsRow: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  importOptionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  importOptionLabel: { fontSize: 12, color: '#334155', fontWeight: '500' },
  importSuccessText: { fontSize: 11, color: '#22c55e', paddingHorizontal: 20, paddingVertical: 4 },
});
