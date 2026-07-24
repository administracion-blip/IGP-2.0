import React, { useEffect, useState, useCallback, useMemo, useRef, memo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Platform,
  Modal,
  Pressable,
  KeyboardAvoidingView,
  Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { formatId6 } from '../utils/idFormat';
import { SelectorDesplegable } from '../components/SelectorDesplegable';
import { useProductosCache } from '../contexts/ProductosCache';
import { useAuth } from '../contexts/AuthContext';
import { useLocalToast } from '../components/Toast';
import { apiFetch } from '../utils/api';
import { erpTableStyles } from '../constants/erpTableStyles';
import { colors, iconSize, radius, SPACING, statusColors } from '../constants/theme';
import { EstadoVacio } from '../components/ui/EstadoVacio';

const PAGE_SIZE = 50;
const MAX_TEXT_LENGTH = 30;

/** Columnas preferidas para Productos Ágora (solo campos permitidos por API) */
const PREFERRED_COLS_AGORA = ['Id', 'IGP', 'Name', 'FamilyId', 'FamilyName', 'VatId', 'VatName', 'VatPercent', 'ultimo_iva_compra', 'CostPrice', 'CostPrices', 'BaseSaleFormatId', 'Active', 'IsSoldByWeight'];

const DEFAULT_COL_WIDTH = 90;
const MAX_TEXT_LENGTH_TABLE = 30;

type Producto = Record<string, unknown>;

type FiltroOperador = 'contiene' | 'igual' | 'empieza' | 'no_contiene' | '>' | '<' | '>=' | '<=' | '!=' | 'true' | 'false';
type FiltroAvanzado = { id: string; columna: string; operador: FiltroOperador; valor: string };

const OPERADORES_TEXTO: { key: FiltroOperador; label: string }[] = [
  { key: 'contiene', label: 'contiene' },
  { key: 'igual', label: 'es igual a' },
  { key: 'empieza', label: 'empieza por' },
  { key: 'no_contiene', label: 'no contiene' },
];
const OPERADORES_NUMERICO: { key: FiltroOperador; label: string }[] = [
  { key: 'igual', label: '=' },
  { key: '>', label: '>' },
  { key: '<', label: '<' },
  { key: '>=', label: '>=' },
  { key: '<=', label: '<=' },
  { key: '!=', label: '≠' },
];
const OPERADORES_BOOL: { key: FiltroOperador; label: string }[] = [
  { key: 'true', label: 'es verdadero' },
  { key: 'false', label: 'es falso' },
];

const COLUMNAS_NUMERICAS = ['CostPrice', 'Price', 'VatPercent', 'ultimo_iva_compra'];
const COLUMNAS_BOOLEANAS = ['IGP', 'Active', 'IsSoldByWeight'];

function operadoresPorColumna(col: string) {
  if (COLUMNAS_BOOLEANAS.includes(col)) return OPERADORES_BOOL;
  if (COLUMNAS_NUMERICAS.includes(col)) return OPERADORES_NUMERICO;
  return OPERADORES_TEXTO;
}

function aplicarFiltro(item: Producto, filtro: FiltroAvanzado, valorFn: (item: Producto, col: string) => unknown): boolean {
  const raw = valorFn(item, filtro.columna);

  if (COLUMNAS_BOOLEANAS.includes(filtro.columna)) {
    const boolVal = raw === true || raw === 'true';
    return filtro.operador === 'true' ? boolVal : !boolVal;
  }

  if (COLUMNAS_NUMERICAS.includes(filtro.columna)) {
    const num = parseFloat(String(raw ?? ''));
    const target = parseFloat(filtro.valor.replace(',', '.'));
    if (Number.isNaN(num) || Number.isNaN(target)) return false;
    switch (filtro.operador) {
      case 'igual': return num === target;
      case '>': return num > target;
      case '<': return num < target;
      case '>=': return num >= target;
      case '<=': return num <= target;
      case '!=': return num !== target;
      default: return true;
    }
  }

  const str = String(raw ?? '').toLowerCase();
  const q = filtro.valor.toLowerCase();
  switch (filtro.operador) {
    case 'contiene': return str.includes(q);
    case 'igual': return str === q;
    case 'empieza': return str.startsWith(q);
    case 'no_contiene': return !str.includes(q);
    default: return true;
  }
}

/** Obtiene las columnas a partir de los datos devueltos por la API (muestreo limitado) */
function columnasFromProductos(
  productos: Producto[],
  preferred = PREFERRED_COLS_AGORA,
  fallback = ['Id', 'IGP', 'Name', 'CostPrice']
): string[] {
  const keySet = new Set<string>();
  const sample = productos.length > 20 ? productos.slice(0, 20) : productos;
  for (const p of sample) {
    if (p && typeof p === 'object') {
      for (const k of Object.keys(p)) keySet.add(k);
    }
  }
  const keys = Array.from(keySet);
  const ordered: string[] = [];
  for (const preferredCol of preferred) {
    const found = keys.find((k) => k.toLowerCase() === preferredCol.toLowerCase());
    ordered.push(found ?? preferredCol);
  }
  for (const k of keys.sort()) {
    if (!ordered.some((o) => o.toLowerCase() === k.toLowerCase())) ordered.push(k);
  }
  return ordered.length ? ordered : [...fallback];
}

function getAnchoColumna(col: string): number {
  if (col === 'IGP') return 56;
  if (col === 'Name') return 180;
  return DEFAULT_COL_WIDTH;
}

function labelColumna(col: string): string {
  return col.toUpperCase();
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

/* ─── Componente de fila memoizado ─── */
type ProductRowProps = {
  producto: Producto;
  rowId: string;
  isSelected: boolean;
  isLastRow: boolean;
  columnas: string[];
  onToggleSelect: (rowId: string, shiftKey: boolean) => void;
  onToggleIGP: (producto: Producto) => void;
  valorCelda: (item: Producto, col: string) => string;
};

const ProductRow = memo(function ProductRow({
  producto, rowId, isSelected, isLastRow, columnas, onToggleSelect, onToggleIGP, valorCelda,
}: ProductRowProps) {
  const handlePress = useCallback((e: any) => {
    if (!rowId) return;
    const shiftKey = Platform.OS === 'web' && e.nativeEvent?.shiftKey;
    onToggleSelect(rowId, shiftKey);
  }, [rowId, onToggleSelect]);

  const handleIGP = useCallback((ev: any) => {
    ev.stopPropagation();
    onToggleIGP(producto);
  }, [producto, onToggleIGP]);

  return (
    <Pressable
      style={[
        erpTableStyles.row,
        isLastRow && erpTableStyles.rowLast,
        isSelected && erpTableStyles.rowSelected,
      ]}
      onPress={handlePress}
    >
      <View style={erpTableStyles.cellCheckbox}>
        <MaterialIcons
          name={isSelected ? 'check-box' : 'check-box-outline-blank'}
          size={16}
          color={isSelected ? colors.accent : colors.border}
        />
      </View>
      {columnas.map((col, colIdx) => {
        const isLastCol = colIdx === columnas.length - 1;
        const colWidth = getAnchoColumna(col);
        const isMoneda = col === 'CostPrice';
        const isIGP = col === 'IGP';
        if (isIGP) {
          const igpVal = producto.IGP === true || producto.IGP === 'true';
          return (
            <TouchableOpacity
              key={col}
              style={[
                erpTableStyles.cell,
                isLastCol && erpTableStyles.cellLast,
                { width: colWidth, alignItems: 'center' },
              ]}
              onPress={handleIGP}
              activeOpacity={0.7}
            >
              <MaterialIcons
                name={igpVal ? 'check-box' : 'check-box-outline-blank'}
                size={18}
                color={igpVal ? colors.accent : colors.textMuted}
              />
            </TouchableOpacity>
          );
        }
        return (
          <View
            key={col}
            style={[
              erpTableStyles.cell,
              isLastCol && erpTableStyles.cellLast,
              { width: colWidth },
              isMoneda && { alignItems: 'flex-end' },
            ]}
          >
            <Text
              style={[erpTableStyles.cellText, isMoneda && erpTableStyles.cellTextRight]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {truncar(valorCelda(producto, col))}
            </Text>
          </View>
        );
      })}
    </Pressable>
  );
});

export default function ProductosScreen() {
  const router = useRouter();
  const {
    productos: productosAgora,
    loading: loadingAgora,
    syncing: syncingAgora,
    error: errorAgora,
    lastFetch,
    recargar: refetchProductosAgora,
    sincronizar: syncProductosAgoraGlobal,
    updateProductoLocal,
  } = useProductosCache();
  const { hasPermiso } = useAuth();
  const puedeSincronizar = hasPermiso('productos.sincronizar');
  const [filtroAgoraInput, setFiltroAgoraInput] = useState('');
  const [filtroAgora, setFiltroAgora] = useState('');
  const [pageIndexAgora, setPageIndexAgora] = useState(0);

  const aplicarBusqueda = useCallback(() => {
    setFiltroAgora(filtroAgoraInput);
  }, [filtroAgoraInput]);

  const limpiarBusqueda = useCallback(() => {
    setFiltroAgoraInput('');
    setFiltroAgora('');
  }, []);

  const [mostrarTodos, setMostrarTodos] = useState(false);
  const [modalFamiliasVisible, setModalFamiliasVisible] = useState(false);
  const [filtroBusquedaFamilias, setFiltroBusquedaFamilias] = useState('');
  const [filtrosAvanzados, setFiltrosAvanzados] = useState<FiltroAvanzado[]>([]);
  const [filtrosPanelOpen, setFiltrosPanelOpen] = useState(false);
  const [modalEditarVisible, setModalEditarVisible] = useState(false);
  const [productoEditando, setProductoEditando] = useState<Producto | null>(null);
  const [formName, setFormName] = useState('');
  const [formCostPrice, setFormCostPrice] = useState('');
  const [formBaseSaleFormatId, setFormBaseSaleFormatId] = useState('');
  const [formFamilyId, setFormFamilyId] = useState('');
  const [formVatId, setFormVatId] = useState('');
  const [formIGP, setFormIGP] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [errorEditar, setErrorEditar] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedRef = useRef<string | null>(null);
  const [batchUpdating, setBatchUpdating] = useState(false);

  const getProductId = useCallback((p: Producto): string => {
    const id = p.Id ?? p.id ?? p.Code ?? p.code;
    return id != null ? String(id) : '';
  }, []);

  const toggleAgoraProductIGP = useCallback(
    async (producto: Producto) => {
      const idStr = getProductId(producto);
      if (!idStr) return;
      const actual = producto.IGP === true || producto.IGP === 'true';
      const nuevoVal = !actual;
      updateProductoLocal(idStr, { IGP: nuevoVal });
      try {
        await apiFetch(`/api/agora/products/${encodeURIComponent(idStr)}`, {
          method: 'PATCH',
          body: JSON.stringify({ IGP: nuevoVal }),
        });
      } catch {
        updateProductoLocal(idStr, { IGP: !nuevoVal });
      }
    },
    [updateProductoLocal, getProductId]
  );

  const { show: showToast, ToastView } = useLocalToast();

  const batchToggleIGP = useCallback(
    async (nuevoVal: boolean) => {
      if (selectedIds.size === 0) return;
      setBatchUpdating(true);
      const ids = [...selectedIds];
      ids.forEach((id) => updateProductoLocal(id, { IGP: nuevoVal }));
      try {
        const res = await apiFetch('/api/agora/products/igp/batch', {
          method: 'PATCH',
          body: JSON.stringify({
            updates: ids.map((id) => ({ id, IGP: nuevoVal })),
          }),
        });
        const data = await res.json();
        if (data.ok) {
          if (data.totalFallidos > 0) {
            showToast(
              'Actualización parcial',
              `${data.totalActualizados} actualizados. ${data.totalFallidos} fallaron.`,
              'warning'
            );
          } else {
            showToast('IGP actualizado', `${data.totalActualizados} registro(s) actualizado(s)`, 'success');
          }
        } else {
          showToast('Error', data.error || 'Error al actualizar IGP', 'error');
        }
      } catch (e) {
        showToast('Error', e instanceof Error ? e.message : 'Error de conexión', 'error');
      }
      setSelectedIds(new Set());
      setBatchUpdating(false);
    },
    [selectedIds, updateProductoLocal, showToast]
  );

  const abrirModalEditar = useCallback((producto: Producto) => {
    setProductoEditando(producto);
    setFormName(String(producto.Name ?? ''));
    setFormCostPrice(String(producto.CostPrice ?? ''));
    setFormBaseSaleFormatId(String(producto.BaseSaleFormatId ?? ''));
    setFormFamilyId(String(producto.FamilyId ?? ''));
    setFormVatId(String(producto.VatId ?? ''));
    setFormIGP(producto.IGP === true || producto.IGP === 'true');
    setErrorEditar(null);
    setModalEditarVisible(true);
  }, []);

  const cerrarModalEditar = useCallback(() => {
    if (!guardando) {
      setModalEditarVisible(false);
      setProductoEditando(null);
      setErrorEditar(null);
    }
  }, [guardando]);

  const guardarEdicion = useCallback(async () => {
    if (!productoEditando) return;
    const id = productoEditando.Id ?? productoEditando.id;
    if (id == null) return;
    setGuardando(true);
    setErrorEditar(null);
    try {
      const costPriceNum = parseFloat(String(formCostPrice).replace(',', '.'));
      const body: Record<string, unknown> = {
        Name: formName.trim(),
        CostPrice: Number.isNaN(costPriceNum) ? 0 : costPriceNum,
        BaseSaleFormatId: formBaseSaleFormatId.trim() || null,
        FamilyId: formFamilyId.trim() || null,
        VatId: formVatId.trim() || null,
        IGP: formIGP,
      };
      const res = await apiFetch(`/api/agora/products/${encodeURIComponent(String(id))}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        await refetchProductosAgora();
        cerrarModalEditar();
      } else {
        setErrorEditar(data.error || 'Error al guardar');
      }
    } catch (e) {
      setErrorEditar(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  }, [productoEditando, formName, formCostPrice, formBaseSaleFormatId, formFamilyId, formVatId, formIGP, cerrarModalEditar, refetchProductosAgora]);

  /** Columnas para Productos Ágora */
  const columnasAgora = useMemo(
    () =>
      productosAgora.length > 0
        ? columnasFromProductos(productosAgora, PREFERRED_COLS_AGORA, ['Id', 'IGP', 'Name', 'CostPrice'])
        : ['Id', 'IGP', 'Name', 'CostPrice'],
    [productosAgora]
  );

  const familias = useMemo(() => {
    const map = new Map<string, { FamilyId: string; FamilyName: string; count: number }>();
    for (const p of productosAgora) {
      const id = String(p.FamilyId ?? '').trim();
      const name = String(p.FamilyName ?? '').trim();
      if (!id && !name) continue;
      const key = id || name;
      const existing = map.get(key);
      if (existing) {
        existing.count++;
      } else {
        map.set(key, { FamilyId: id, FamilyName: name || id, count: 1 });
      }
    }
    return [...map.values()].sort((a, b) => a.FamilyName.localeCompare(b.FamilyName, 'es'));
  }, [productosAgora]);

  const familiasFiltradas = useMemo(() => {
    const q = filtroBusquedaFamilias.trim().toLowerCase();
    if (!q) return familias;
    return familias.filter((f) => f.FamilyName.toLowerCase().includes(q) || f.FamilyId.toLowerCase().includes(q));
  }, [familias, filtroBusquedaFamilias]);

  const valorCeldaAgora = useCallback((item: Producto, col: string) => {
    const raw = item[col] ?? valorPorColumna(item, col);
    if (raw === undefined || raw === null) return '—';
    if (col === 'CostPrices' && Array.isArray(raw)) {
      if (!raw.length) return '—';
      return raw.map((cp: any) => {
        const wh = cp.WarehouseId ?? cp.warehouseId ?? '?';
        const price = Number(cp.CostPrice ?? cp.costPrice ?? 0);
        return `Alm.${wh}: ${price.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}€`;
      }).join(', ');
    }
    if (Array.isArray(raw)) return raw.length ? String(raw.join(', ')) : '—';
    if (typeof raw === 'object') return JSON.stringify(raw).slice(0, MAX_TEXT_LENGTH_TABLE);
    if (col === 'ultimo_iva_compra' || col === 'VatPercent') {
      const n = parseFloat(String(raw));
      if (!Number.isNaN(n)) return n + ' %';
    }
    if (col === 'Price' || col === 'CostPrice') {
      const n = parseFloat(String(raw));
      if (!Number.isNaN(n)) return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    }
    const str = String(raw);
    if (col === 'Id' || col === 'id') return formatId6(str);
    return str;
  }, []);

  const productosAgoraFiltrados = useMemo(() => {
    let resultado = productosAgora;
    if (!mostrarTodos) {
      resultado = resultado.filter((p) => p.IGP === true || p.IGP === 'true');
    }
    const q = filtroAgora.trim().toLowerCase();
    if (q) {
      resultado = resultado.filter((p) =>
        columnasAgora.some((col) => {
          const val = valorCeldaAgora(p, col);
          return val !== '—' && val.toLowerCase().includes(q);
        })
      );
    }
    const activos = filtrosAvanzados.filter((f) => f.columna && (COLUMNAS_BOOLEANAS.includes(f.columna) || f.valor.trim()));
    if (activos.length > 0) {
      resultado = resultado.filter((p) =>
        activos.every((f) => aplicarFiltro(p, f, valorPorColumna))
      );
    }
    return resultado;
  }, [productosAgora, mostrarTodos, filtroAgora, columnasAgora, valorCeldaAgora, filtrosAvanzados]);

  const totalFiltradosAgora = productosAgoraFiltrados.length;
  const totalPagesAgora = Math.max(1, Math.ceil(totalFiltradosAgora / PAGE_SIZE));
  const pageIndexClampedAgora = Math.min(Math.max(0, pageIndexAgora), totalPagesAgora - 1);

  const productosAgoraPagina = useMemo(() => {
    const start = pageIndexClampedAgora * PAGE_SIZE;
    return productosAgoraFiltrados.slice(start, start + PAGE_SIZE);
  }, [productosAgoraFiltrados, pageIndexClampedAgora]);

  useEffect(() => {
    setPageIndexAgora((prev) => (prev >= totalPagesAgora ? Math.max(0, totalPagesAgora - 1) : prev));
  }, [totalPagesAgora]);

  useEffect(() => {
    setPageIndexAgora(0);
  }, [filtroAgora, filtrosAvanzados]);

  const addFiltro = () => {
    const defaultCol = columnasAgora[0] || 'Id';
    const ops = operadoresPorColumna(defaultCol);
    setFiltrosAvanzados((prev) => [
      ...prev,
      { id: crypto.randomUUID(), columna: defaultCol, operador: ops[0].key, valor: '' },
    ]);
    setFiltrosPanelOpen(true);
  };

  const removeFiltro = (id: string) => {
    setFiltrosAvanzados((prev) => prev.filter((f) => f.id !== id));
  };

  const updateFiltro = (id: string, patch: Partial<FiltroAvanzado>) => {
    setFiltrosAvanzados((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        const updated = { ...f, ...patch };
        if (patch.columna && patch.columna !== f.columna) {
          const ops = operadoresPorColumna(patch.columna);
          updated.operador = ops[0].key;
          if (COLUMNAS_BOOLEANAS.includes(patch.columna)) updated.valor = '';
        }
        return updated;
      })
    );
  };

  const limpiarFiltros = () => {
    setFiltrosAvanzados([]);
    setFiltrosPanelOpen(false);
  };

  const filtrosActivos = filtrosAvanzados.filter((f) => f.columna && (COLUMNAS_BOOLEANAS.includes(f.columna) || f.valor.trim()));

  const goPrevPageAgora = () => setPageIndexAgora((p) => Math.max(0, p - 1));
  const goNextPageAgora = () => setPageIndexAgora((p) => Math.min(totalPagesAgora - 1, p + 1));

  const lastFetchLabel = useMemo(() => {
    if (!lastFetch) return null;
    const d = new Date(lastFetch);
    return `${d.toLocaleDateString('es-ES')} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
  }, [lastFetch]);

  // Memoizar estado del checkbox de cabecera
  const headerCheckState = useMemo(() => {
    if (productosAgoraPagina.length === 0) return 'none';
    const pageIds = productosAgoraPagina.map((p) => getProductId(p)).filter(Boolean);
    const allSelected = pageIds.every((id) => selectedIds.has(id));
    if (allSelected) return 'all';
    const someSelected = pageIds.some((id) => selectedIds.has(id));
    return someSelected ? 'some' : 'none';
  }, [productosAgoraPagina, selectedIds, getProductId]);

  const handleHeaderCheck = useCallback(() => {
    const pageIds = productosAgoraPagina.map((p) => getProductId(p)).filter(Boolean);
    const allSelected = headerCheckState === 'all';
    setSelectedIds((prev) => {
      const next = new Set(prev);
      pageIds.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }, [productosAgoraPagina, headerCheckState, getProductId]);

  // Memoizar IDs de filtrados para Shift+click
  const filteredIdsRef = useRef<string[]>([]);
  filteredIdsRef.current = useMemo(
    () => productosAgoraFiltrados.map((p) => getProductId(p)),
    [productosAgoraFiltrados, getProductId]
  );

  const handleToggleSelect = useCallback((rowId: string, shiftKey: boolean) => {
    if (shiftKey && lastClickedRef.current) {
      const allIds = filteredIdsRef.current;
      const fromIdx = allIds.indexOf(lastClickedRef.current);
      const toIdx = allIds.indexOf(rowId);
      if (fromIdx >= 0 && toIdx >= 0) {
        const start = Math.min(fromIdx, toIdx);
        const end = Math.max(fromIdx, toIdx);
        const rangeIds = allIds.slice(start, end + 1).filter(Boolean);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          rangeIds.forEach((id) => next.add(id));
          return next;
        });
      }
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.has(rowId) ? next.delete(rowId) : next.add(rowId);
        return next;
      });
    }
    lastClickedRef.current = rowId;
  }, []);


  const anchoTabla = 32 + columnasAgora.reduce((w, c) => w + getAnchoColumna(c), 0);

  return (
    <View style={erpTableStyles.screen}>
      <View style={erpTableStyles.headerRow}>
        <Pressable onPress={() => router.back()} style={erpTableStyles.backBtn} accessibilityLabel="Volver">
          <MaterialIcons name="arrow-back" size={iconSize.tab} color={colors.textPrimary} />
        </Pressable>
        <Text style={erpTableStyles.title}>Productos Ágora</Text>
      </View>

      <View style={styles.agoraContent}>
        <View style={erpTableStyles.toolbarRow}>
          <TouchableOpacity
            style={erpTableStyles.toolbarBtnLabeled}
            onPress={refetchProductosAgora}
            disabled={loadingAgora}
            accessibilityLabel="Recargar"
          >
            {loadingAgora ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <MaterialIcons name="refresh" size={iconSize.chip} color={colors.textSecondary} />
            )}
            <Text style={erpTableStyles.toolbarBtnLabeledText}>Recargar</Text>
          </TouchableOpacity>
          {puedeSincronizar && (
            <TouchableOpacity
              style={erpTableStyles.toolbarBtnLabeled}
              onPress={syncProductosAgoraGlobal}
              disabled={syncingAgora}
              accessibilityLabel="Sincronizar desde Ágora"
            >
              {syncingAgora ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : (
                <MaterialIcons name="sync" size={iconSize.chip} color={colors.textSecondary} />
              )}
              <Text style={erpTableStyles.toolbarBtnLabeledText}>Sincronizar</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={erpTableStyles.toolbarBtnLabeled}
            onPress={() => { setFiltroBusquedaFamilias(''); setModalFamiliasVisible(true); }}
            accessibilityLabel="Familias"
          >
            <MaterialIcons name="category" size={iconSize.chip} color={colors.textSecondary} />
            <Text style={erpTableStyles.toolbarBtnLabeledText}>Familias</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              erpTableStyles.toolbarBtnLabeled,
              filtrosActivos.length > 0 && erpTableStyles.toolbarBtnLabeledActive,
            ]}
            onPress={() => setFiltrosPanelOpen((o) => !o)}
            accessibilityLabel="Filtros"
          >
            <MaterialIcons
              name="filter-list"
              size={iconSize.chip}
              color={filtrosActivos.length > 0 ? colors.surface : colors.textSecondary}
            />
            <Text
              style={[
                erpTableStyles.toolbarBtnLabeledText,
                filtrosActivos.length > 0 && erpTableStyles.toolbarBtnLabeledTextActive,
              ]}
            >
              Filtros{filtrosActivos.length > 0 ? ` (${filtrosActivos.length})` : ''}
            </Text>
          </TouchableOpacity>
          <View style={styles.switchRow}>
            <Switch
              value={mostrarTodos}
              onValueChange={setMostrarTodos}
              trackColor={{ false: colors.border, true: statusColors.success.bg }}
              thumbColor={mostrarTodos ? colors.success : colors.surface}
            />
            <Text style={styles.switchLabel}>Mostrar todos</Text>
          </View>
          {selectedIds.size > 0 && (
            <>
              <View style={styles.selectionInfo}>
                <Text style={styles.selectionInfoText}>
                  {selectedIds.size} seleccionado{selectedIds.size !== 1 ? 's' : ''}
                </Text>
              </View>
              <TouchableOpacity
                style={[erpTableStyles.toolbarBtnLabeled, styles.batchBtnSuccess]}
                onPress={() => batchToggleIGP(true)}
                disabled={batchUpdating}
              >
                {batchUpdating ? (
                  <ActivityIndicator size="small" color={colors.surface} />
                ) : (
                  <MaterialIcons name="check-box" size={18} color={colors.surface} />
                )}
                <Text style={[erpTableStyles.toolbarBtnLabeledText, styles.batchBtnText]}>Marcar IGP</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[erpTableStyles.toolbarBtnLabeled, styles.batchBtnDanger]}
                onPress={() => batchToggleIGP(false)}
                disabled={batchUpdating}
              >
                {batchUpdating ? (
                  <ActivityIndicator size="small" color={colors.surface} />
                ) : (
                  <MaterialIcons name="check-box-outline-blank" size={18} color={colors.surface} />
                )}
                <Text style={[erpTableStyles.toolbarBtnLabeledText, styles.batchBtnText]}>Desmarcar IGP</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={erpTableStyles.toolbarBtnLabeled}
                onPress={() => setSelectedIds(new Set())}
              >
                <MaterialIcons name="deselect" size={18} color={colors.textSecondary} />
                <Text style={erpTableStyles.toolbarBtnLabeledText}>Deseleccionar</Text>
              </TouchableOpacity>
            </>
          )}
          <View style={styles.searchWrapFlex}>
            <MaterialIcons name="search" size={iconSize.chip} color={colors.textMuted} />
            <TextInput
              style={styles.searchInputFlex}
              value={filtroAgoraInput}
              onChangeText={setFiltroAgoraInput}
              placeholder="Buscar en la tabla…"
              placeholderTextColor={colors.textMuted}
              onSubmitEditing={aplicarBusqueda}
              returnKeyType="search"
              {...(Platform.OS === 'web' ? {
                onKeyDown: (e: any) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    aplicarBusqueda();
                  }
                },
              } : {})}
            />
            <TouchableOpacity style={erpTableStyles.searchBuscarBtn} onPress={aplicarBusqueda}>
              <MaterialIcons name="search" size={iconSize.chip} color={colors.surface} />
              <Text style={erpTableStyles.searchBuscarBtnText}>Buscar</Text>
            </TouchableOpacity>
            {(filtroAgoraInput || filtroAgora) ? (
              <TouchableOpacity style={styles.limpiarBusquedaBtn} onPress={limpiarBusqueda}>
                <MaterialIcons name="close" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
          {lastFetchLabel ? (
            <Text style={styles.lastFetchText}>Última carga: {lastFetchLabel}</Text>
          ) : null}
        </View>
          {filtrosPanelOpen && (
            <View style={styles.filterPanel}>
              {filtrosAvanzados.map((f) => {
                const ops = operadoresPorColumna(f.columna);
                const isBool = COLUMNAS_BOOLEANAS.includes(f.columna);
                return (
                  <View key={f.id} style={styles.filterRow}>
                    <SelectorDesplegable
                      style={styles.filterSelect}
                      placeholder="Columna"
                      tituloLista="Seleccionar columna"
                      valorId={f.columna}
                      opciones={columnasAgora.map((col) => ({ id: col, titulo: col }))}
                      onSeleccionar={(col) => updateFiltro(f.id, { columna: col })}
                    />
                    <SelectorDesplegable
                      style={styles.filterSelect}
                      placeholder="Operador"
                      tituloLista="Seleccionar operador"
                      valorId={f.operador}
                      opciones={ops.map((op) => ({ id: op.key, titulo: op.label }))}
                      onSeleccionar={(opKey) => updateFiltro(f.id, { operador: opKey as FiltroOperador })}
                    />
                    {!isBool && (
                      <TextInput
                        style={styles.filterValueInput}
                        value={f.valor}
                        onChangeText={(v) => updateFiltro(f.id, { valor: v })}
                        placeholder="Valor…"
                        placeholderTextColor={colors.textMuted}
                        keyboardType={COLUMNAS_NUMERICAS.includes(f.columna) ? 'numeric' : 'default'}
                      />
                    )}
                    <TouchableOpacity onPress={() => removeFiltro(f.id)} style={styles.filterRemoveBtn}>
                      <MaterialIcons name="close" size={16} color={colors.danger} />
                    </TouchableOpacity>
                  </View>
                );
              })}
              <View style={styles.filterActions}>
                <TouchableOpacity style={styles.filterAddBtn} onPress={addFiltro}>
                  <MaterialIcons name="add" size={16} color={colors.accent} />
                  <Text style={styles.filterAddBtnText}>Añadir filtro</Text>
                </TouchableOpacity>
                {filtrosAvanzados.length > 0 && (
                  <TouchableOpacity style={styles.filterClearBtn} onPress={limpiarFiltros}>
                    <MaterialIcons name="delete-sweep" size={16} color={colors.textMuted} />
                    <Text style={styles.filterClearBtnText}>Limpiar filtros</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}

          {!lastFetch && !loadingAgora && !errorAgora ? (
            <EstadoVacio
              icon="cloud-download"
              mensaje="Pulsa Recargar para cargar los productos desde la base de datos, o Sincronizar para descargar desde Ágora."
            />
          ) : loadingAgora && productosAgora.length === 0 ? (
            <View style={erpTableStyles.center}>
              <ActivityIndicator size="large" color={colors.accent} />
              <Text style={erpTableStyles.loadingText}>Cargando productos Ágora…</Text>
            </View>
          ) : errorAgora && productosAgora.length === 0 ? (
            <View style={erpTableStyles.center}>
              <MaterialIcons name="error-outline" size={48} color={colors.danger} />
              <Text style={erpTableStyles.errorText}>{errorAgora}</Text>
              <TouchableOpacity style={erpTableStyles.btnPrimary} onPress={refetchProductosAgora}>
                <MaterialIcons name="refresh" size={iconSize.chip} color={colors.surface} />
                <Text style={erpTableStyles.btnPrimaryText}>Reintentar</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Text style={erpTableStyles.subtitle}>
                {productosAgoraFiltrados.length} registro{productosAgoraFiltrados.length !== 1 ? 's' : ''}
                {totalPagesAgora > 1 && ` · Página ${pageIndexClampedAgora + 1} de ${totalPagesAgora}`}
              </Text>
              <ScrollView horizontal style={styles.scroll} contentContainerStyle={erpTableStyles.scrollTableContent}>
                <View style={[erpTableStyles.table, styles.tableFlex, { minWidth: anchoTabla }]}>
                  <View style={erpTableStyles.rowHeader}>
                    <TouchableOpacity style={erpTableStyles.cellCheckbox} onPress={handleHeaderCheck}>
                      <MaterialIcons
                        name={headerCheckState === 'all' ? 'check-box' : headerCheckState === 'some' ? 'indeterminate-check-box' : 'check-box-outline-blank'}
                        size={16}
                        color={colors.textSecondary}
                      />
                    </TouchableOpacity>
                    {columnasAgora.map((col, colIdx) => {
                      const isLastCol = colIdx === columnasAgora.length - 1;
                      return (
                        <View
                          key={col}
                          style={[
                            erpTableStyles.cellHeader,
                            isLastCol && erpTableStyles.cellHeaderLast,
                            { width: getAnchoColumna(col) },
                          ]}
                        >
                          <Text style={erpTableStyles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">
                            {labelColumna(col)}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                  <ScrollView style={styles.agoraBodyScroll} nestedScrollEnabled>
                  {productosAgoraPagina.map((p, idx) => {
                    const rowId = getProductId(p);
                    return (
                      <ProductRow
                        key={rowId || `page-${pageIndexClampedAgora}-${idx}`}
                        producto={p}
                        rowId={rowId}
                        isSelected={rowId ? selectedIds.has(rowId) : false}
                        isLastRow={idx === productosAgoraPagina.length - 1}
                        columnas={columnasAgora}
                        onToggleSelect={handleToggleSelect}
                        onToggleIGP={toggleAgoraProductIGP}
                        valorCelda={valorCeldaAgora}
                      />
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
                    <MaterialIcons name="chevron-left" size={20} color={pageIndexClampedAgora === 0 ? colors.textMuted : colors.accent} />
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
                    <MaterialIcons name="chevron-right" size={20} color={pageIndexClampedAgora >= totalPagesAgora - 1 ? colors.textMuted : colors.accent} />
                  </TouchableOpacity>
                </View>
              )}
              {productosAgoraFiltrados.length === 0 && (
                <Text style={erpTableStyles.emptyText}>
                  {filtroAgora.trim()
                    ? 'Ningún resultado con el filtro'
                    : 'No hay productos. Pulsa Sincronizar para cargar desde Ágora a DynamoDB.'}
                </Text>
              )}
            </>
          )}
        </View>

      {modalFamiliasVisible && (
        <Modal visible transparent animationType="fade">
          <Pressable style={styles.modalOverlay} onPress={() => setModalFamiliasVisible(false)}>
            <Pressable style={styles.familiasModalCard} onPress={(e) => e.stopPropagation()}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Familias</Text>
                <TouchableOpacity onPress={() => setModalFamiliasVisible(false)} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <View style={styles.familiasSearchWrap}>
                <MaterialIcons name="search" size={18} color={colors.textMuted} />
                <TextInput
                  style={styles.familiasSearchInput}
                  value={filtroBusquedaFamilias}
                  onChangeText={setFiltroBusquedaFamilias}
                  placeholder="Buscar familia…"
                  placeholderTextColor={colors.textMuted}
                />
                {filtroBusquedaFamilias.length > 0 && (
                  <TouchableOpacity onPress={() => setFiltroBusquedaFamilias('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <MaterialIcons name="close" size={16} color={colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
              <Text style={styles.familiasCount}>{familiasFiltradas.length} familia{familiasFiltradas.length !== 1 ? 's' : ''}</Text>
              <View style={styles.familiasTableHeader}>
                <View style={{ width: 60 }}><Text style={styles.familiasHeaderCell}>ID</Text></View>
                <View style={{ flex: 1 }}><Text style={styles.familiasHeaderCell}>Nombre</Text></View>
                <View style={{ width: 70 }}><Text style={[styles.familiasHeaderCell, { textAlign: 'right' }]}>Productos</Text></View>
              </View>
              <ScrollView style={styles.familiasBody}>
                {familiasFiltradas.length === 0 ? (
                  <Text style={styles.emptyText}>Sin resultados</Text>
                ) : (
                  familiasFiltradas.map((f) => (
                    <View key={f.FamilyId || f.FamilyName} style={styles.familiasRow}>
                      <View style={{ width: 60 }}><Text style={styles.familiasCellId}>{f.FamilyId || '—'}</Text></View>
                      <View style={{ flex: 1 }}><Text style={styles.familiasCell} numberOfLines={1}>{f.FamilyName}</Text></View>
                      <View style={{ width: 70 }}><Text style={[styles.familiasCell, { textAlign: 'right', fontWeight: '600' }]}>{f.count}</Text></View>
                    </View>
                  ))
                )}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {modalEditarVisible && <Modal visible transparent animationType="fade">
        {/* El fondo no cierra el formulario (evita perder datos); usar la X o Cancelar. */}
        <Pressable style={styles.modalOverlay}>
          <KeyboardAvoidingView style={styles.modalCenter} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Pressable style={styles.modalCardTouch} onPress={(e) => e.stopPropagation()}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Editar producto</Text>
                  <TouchableOpacity onPress={cerrarModalEditar} style={styles.modalClose} disabled={guardando}>
                    <MaterialIcons name="close" size={22} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
                <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                  <View style={styles.modalBodyRow}>
                    {productoEditando && (
                      <View style={styles.modalIdSide}>
                        <Text style={styles.modalIdLabel}>Id</Text>
                        <Text style={styles.modalIdValue}>{formatId6(String(productoEditando.Id ?? productoEditando.id ?? ''))}</Text>
                      </View>
                    )}
                    <View style={styles.modalBody}>
                      <View style={styles.formGroup}>
                        <Text style={styles.formLabel}>Name</Text>
                        <TextInput
                          style={styles.formInput}
                          value={formName}
                          onChangeText={setFormName}
                          placeholder="Nombre del producto"
                          placeholderTextColor={colors.textMuted}
                          editable={!guardando}
                        />
                      </View>
                      <View style={styles.formGroup}>
                        <Text style={styles.formLabel}>CostPrice (€)</Text>
                        <TextInput
                          style={styles.formInput}
                          value={formCostPrice}
                          onChangeText={setFormCostPrice}
                          placeholder="0.00"
                          placeholderTextColor={colors.textMuted}
                          keyboardType="decimal-pad"
                          editable={!guardando}
                        />
                      </View>
                      <View style={styles.formGroup}>
                        <Text style={styles.formLabel}>BaseSaleFormatId</Text>
                        <TextInput
                          style={styles.formInput}
                          value={formBaseSaleFormatId}
                          onChangeText={setFormBaseSaleFormatId}
                          placeholder="Opcional"
                          placeholderTextColor={colors.textMuted}
                          editable={!guardando}
                        />
                      </View>
                      <View style={styles.formGroup}>
                        <Text style={styles.formLabel}>FamilyId</Text>
                        <TextInput
                          style={styles.formInput}
                          value={formFamilyId}
                          onChangeText={setFormFamilyId}
                          placeholder="Opcional"
                          placeholderTextColor={colors.textMuted}
                          editable={!guardando}
                        />
                      </View>
                      <View style={styles.formGroup}>
                        <Text style={styles.formLabel}>VatId</Text>
                        <TextInput
                          style={styles.formInput}
                          value={formVatId}
                          onChangeText={setFormVatId}
                          placeholder="Opcional"
                          placeholderTextColor={colors.textMuted}
                          editable={!guardando}
                        />
                      </View>
                      <View style={[styles.formGroup, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
                        <Text style={styles.formLabel}>IGP</Text>
                        <Switch
                          value={formIGP}
                          onValueChange={setFormIGP}
                          disabled={guardando}
                          trackColor={{ false: colors.border, true: colors.accent }}
                          thumbColor={colors.surface}
                        />
                      </View>
                    </View>
                  </View>
                </ScrollView>
                {errorEditar ? <Text style={styles.modalError}>{errorEditar}</Text> : null}
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalFooterBtn} onPress={cerrarModalEditar} disabled={guardando}>
                    <Text style={styles.modalFooterBtnText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalFooterBtn, styles.modalFooterBtnPrimary]}
                    onPress={guardarEdicion}
                    disabled={guardando}
                  >
                    {guardando ? (
                      <ActivityIndicator size="small" color={colors.surface} />
                    ) : (
                      <Text style={styles.modalFooterBtnPrimaryText}>Guardar</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>}
      {ToastView}
    </View>
  );
}

const styles = StyleSheet.create({
  agoraContent: { flex: 1 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs + 2 },
  switchLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  searchWrapFlex: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 140,
    height: 32,
    backgroundColor: colors.bgSubtle,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: SPACING.sm,
    gap: SPACING.xs,
  },
  searchInputFlex: { flex: 1, minWidth: 80, fontSize: 12, color: colors.textPrimary, paddingVertical: 0 },
  limpiarBusquedaBtn: { padding: SPACING.xs + 2 },
  batchBtnSuccess: { backgroundColor: colors.success, borderColor: colors.success },
  batchBtnDanger: { backgroundColor: colors.danger, borderColor: colors.danger },
  batchBtnText: { color: colors.surface },
  scroll: { flex: 1 },
  tableFlex: { flex: 1 },
  agoraBodyScroll: { flex: 1, minHeight: 200 },
  selectionInfo: { backgroundColor: colors.accentMuted, borderRadius: radius.sm, paddingHorizontal: SPACING.sm + 2, paddingVertical: SPACING.xs + 2 },
  selectionInfoText: { fontSize: 12, fontWeight: '600', color: statusColors.info.text },
  lastFetchText: { fontSize: 10, color: colors.textMuted, fontStyle: 'italic' },
  paginacionAgora: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.lg, marginTop: SPACING.md, paddingVertical: SPACING.sm },
  pagBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md, backgroundColor: colors.bgSubtle, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  pagBtnDisabled: { opacity: 0.6 },
  pagBtnText: { fontSize: 13, color: colors.accent, fontWeight: '500' },
  pagBtnTextDisabled: { color: colors.textMuted },
  pagInfo: { fontSize: 12, color: colors.textSecondary },
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.overlay },
  modalCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', width: '100%', padding: SPACING.lg - 4 },
  modalCardTouch: { width: '100%' },
  modalCard: { width: '100%', backgroundColor: colors.surface, borderRadius: radius.md, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.lg - 4, paddingVertical: SPACING.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalTitle: { fontSize: 18, fontWeight: '600', color: colors.textPrimary },
  modalClose: { padding: SPACING.xs },
  modalBodyRow: { flexDirection: 'row' },
  modalIdSide: { width: 56, paddingVertical: SPACING.md, paddingHorizontal: SPACING.sm, borderRightWidth: 1, borderRightColor: colors.border, alignItems: 'center', justifyContent: 'flex-start' },
  modalIdLabel: { fontSize: 10, fontWeight: '600', color: colors.textMuted, marginBottom: 2 },
  modalIdValue: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  modalBody: { flex: 1, maxHeight: 400, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md },
  formGroup: { marginBottom: SPACING.sm },
  formLabel: { fontSize: 10, fontWeight: '500', color: colors.textSecondary, marginBottom: 2 },
  formInput: { backgroundColor: colors.bgSubtle, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: SPACING.sm + 2, paddingVertical: SPACING.xs, fontSize: 13, color: colors.textPrimary },
  modalError: { fontSize: 11, color: colors.danger, paddingHorizontal: SPACING.lg - 4, paddingVertical: SPACING.xs },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACING.xs + 2, paddingHorizontal: SPACING.lg - 4, paddingVertical: SPACING.md, borderTopWidth: 1, borderTopColor: colors.border },
  modalFooterBtn: { padding: SPACING.xs + 2, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.bgSubtle },
  modalFooterBtnPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  modalFooterBtnPrimaryText: { fontSize: 13, color: colors.surface, fontWeight: '600' },
  modalFooterBtnText: { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  emptyText: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginTop: SPACING.md },
  filterPanel: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: SPACING.md, marginBottom: SPACING.sm + 2, gap: SPACING.sm },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  filterSelect: { width: 150, flexShrink: 1 },
  filterValueInput: { flex: 1, backgroundColor: colors.bgSubtle, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: SPACING.sm + 2, paddingVertical: SPACING.xs + 2, fontSize: 12, color: colors.textPrimary, minWidth: 80 },
  filterRemoveBtn: { padding: SPACING.xs },
  filterActions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, marginTop: SPACING.xs },
  filterAddBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingVertical: SPACING.xs + 1, paddingHorizontal: SPACING.sm + 2, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.accent, borderStyle: 'dashed' },
  filterAddBtnText: { fontSize: 12, color: colors.accent, fontWeight: '600' },
  filterClearBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingVertical: SPACING.xs + 1, paddingHorizontal: SPACING.sm + 2 },
  filterClearBtnText: { fontSize: 12, color: colors.textMuted },
  familiasModalCard: { width: '90%', maxWidth: 520, maxHeight: '80%', backgroundColor: colors.surface, borderRadius: radius.md, overflow: 'hidden' },
  familiasSearchWrap: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm + 2, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bgSubtle },
  familiasSearchInput: { flex: 1, fontSize: 13, color: colors.textPrimary, paddingVertical: SPACING.xs },
  familiasCount: { fontSize: 11, color: colors.textMuted, paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm, paddingBottom: SPACING.xs },
  familiasTableHeader: { flexDirection: 'row', paddingHorizontal: SPACING.lg, paddingVertical: SPACING.xs + 2, borderBottomWidth: 1, borderBottomColor: colors.borderStrong, backgroundColor: colors.bgSubtle },
  familiasHeaderCell: { fontSize: 10, fontWeight: '600', color: colors.textSecondary, letterSpacing: 0.3, textTransform: 'uppercase' },
  familiasBody: { maxHeight: 400, paddingHorizontal: 0 },
  familiasRow: { flexDirection: 'row', paddingHorizontal: SPACING.lg, paddingVertical: SPACING.xs + 2, borderBottomWidth: 1, borderBottomColor: colors.borderStrong },
  familiasCell: { fontSize: 12, color: colors.textPrimary },
  familiasCellId: { fontSize: 11, color: colors.textSecondary, fontFamily: Platform.OS === 'web' ? 'monospace' : undefined },
});
