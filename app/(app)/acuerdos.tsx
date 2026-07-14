import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Modal,
  Pressable,
  ActivityIndicator,
  useWindowDimensions,
  Platform,
  Alert,
} from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialIcons } from '@expo/vector-icons';
import { useProductosCache } from '../contexts/ProductosCache';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useAuth } from '../contexts/AuthContext';
import { calcTiempoRestante } from '../lib/acuerdosFechas';
import {
  ESTADOS_FACTURACION_ACUERDO,
  FILTROS_FACTURACION,
  etiquetaEstadoFacturacion,
  estiloEstadoFacturacion,
  normalizarEstadoFacturacion,
  type EstadoFacturacionAcuerdo,
} from '../lib/acuerdosFacturacion';
import { FILTROS_ESTADO_ACUERDO } from '../lib/acuerdosEstado';
import { ComprasProveedorModal } from '../components/ComprasProveedorModal';
import { apiFetch, errorMessage } from '../utils/api';
import type {
  Acuerdo,
  DetalleProducto,
  ArchivoAcuerdo,
} from '../types/acuerdo';
import { useAcuerdoNotas } from '../hooks/useAcuerdoNotas';
import { AcuerdoNotasModal } from '../components/AcuerdoNotasModal';
import { useAcuerdoPago } from '../hooks/useAcuerdoPago';
import { AcuerdoPagoModal } from '../components/AcuerdoPagoModal';
import { useAcuerdosForm } from '../hooks/useAcuerdosForm';
import { AcuerdoFormModal } from '../components/AcuerdoFormModal';

/** Polyfill: Alert.alert no funciona en web; usa modal de confirmación */
function useConfirmDelete() {
  const [visible, setVisible] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const onConfirmRef = useRef<(() => void) | null>(null);

  const confirmDelete = useCallback((t: string, m: string, onConfirm: () => void) => {
    if (Platform.OS === 'web') {
      setTitle(t);
      setMessage(m);
      onConfirmRef.current = onConfirm;
      setVisible(true);
    } else {
      Alert.alert(t, m, [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Eliminar', style: 'destructive', onPress: onConfirm },
      ]);
    }
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirmRef.current?.();
    setVisible(false);
    onConfirmRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    setVisible(false);
    onConfirmRef.current = null;
  }, []);

  const ModalConfirm = useCallback(() => (
    <Modal visible={visible} transparent animationType="fade">
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 24 }} onPress={handleCancel}>
        <Pressable style={{ backgroundColor: "#fff", borderRadius: 12, padding: 24, maxWidth: 400, width: "100%" }} onPress={(e) => e.stopPropagation()}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#1e293b', marginBottom: 8 }}>{title}</Text>
          <Text style={{ fontSize: 15, color: '#64748b', marginBottom: 24 }}>{message}</Text>
          <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end' }}>
            <TouchableOpacity onPress={handleCancel} style={{ paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#e2e8f0', borderRadius: 8 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: '#475569' }}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleConfirm} style={{ paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#ef4444', borderRadius: 8 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: '#fff' }}>Eliminar</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  ), [visible, title, message, handleConfirm, handleCancel]);

  return { confirmDelete, ModalConfirm };
}

/** Botón de eliminación para web: usa listener DOM nativo en fase de captura para evitar que ScrollView intercepte el evento */
function WebDeleteBtn({
  productId,
  productName,
  onDelete,
  onConfirmDelete,
}: {
  productId: string;
  productName: string;
  onDelete: (id: string) => void;
  onConfirmDelete: (title: string, message: string, onConfirm: () => void) => void;
}) {
  const ref = useRef<any>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const node = (el as any)._nativeTag ?? el;
    const handler = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      const msg = `¿Quieres eliminar el producto "${productName}" del acuerdo?`;
      onConfirmDelete('Confirmar eliminación', msg, () => onDelete(productId));
    };
    node.addEventListener('click', handler, true);
    return () => node.removeEventListener('click', handler, true);
  }, [productId, productName, onDelete, onConfirmDelete]);

  return (
    <View
      ref={ref}
      role="button"
      // @ts-ignore
      tabIndex={0}
      style={{ width: 80, minWidth: 80, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, padding: 4, cursor: 'pointer' } as any}
    >
      <MaterialIcons name="close" size={14} color="#ef4444" />
      <Text style={{ fontSize: 11, color: '#ef4444', fontWeight: '500' }}>Eliminar</Text>
    </View>
  );
}

const donutStyles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingVertical: 12 },
  textWrap: { position: 'absolute', top: 0, left: 0, justifyContent: 'center', alignItems: 'center' },
  pctText: { fontSize: 20, fontWeight: '800' },
  subText: { fontSize: 10, color: '#64748b', marginTop: 2 },
  fallback: { alignItems: 'center', paddingVertical: 12 },
  fallbackPct: { fontSize: 24, fontWeight: '800' },
  fallbackSub: { fontSize: 11, color: '#64748b', marginTop: 2 },
});

/** Web: nowrap en tooltip (no está en TextStyle de RN). */
const tooltipTextWebNowrap = Platform.select({ web: { whiteSpace: 'nowrap' } as object, default: {} });

const tooltipStyles = StyleSheet.create({
  bubble: { position: 'absolute', top: '100%', left: '50%', transform: [{ translateX: -40 }], marginTop: 4, backgroundColor: '#1e293b', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, zIndex: 9999, elevation: 9999, minWidth: 80, alignItems: 'center' },
  text: { fontSize: 11, color: '#f8fafc', fontWeight: '500' },
});

function DonutChart({ porcentaje, compradas, acordado, size = 120 }: { porcentaje: number; compradas: number; acordado: number; size?: number }) {
  const isMini = size <= 64;
  const strokeWidth = isMini ? 5 : 12;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const pctVisual = Math.min(Math.max(porcentaje, 0), 100);
  const pctText = Math.max(0, porcentaje);
  const offset = circumference - (pctVisual / 100) * circumference;
  const color = porcentaje >= 80 ? '#22c55e' : '#ef4444';
  const center = size / 2;

  if (Platform.OS !== 'web') {
    return (
      <View style={donutStyles.fallback}>
        <Text style={[donutStyles.fallbackPct, { color, fontSize: isMini ? 11 : 24 }]}>{pctText.toFixed(isMini ? 0 : 1)}%</Text>
        {!isMini && <Text style={donutStyles.fallbackSub}>{compradas.toLocaleString('es-ES')} / {acordado.toLocaleString('es-ES')}</Text>}
      </View>
    );
  }

  return (
    <View style={[donutStyles.wrap, isMini && { paddingVertical: 0 }]}>
      <View style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={center} cy={center} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={strokeWidth} />
          <circle
            cx={center} cy={center} r={radius} fill="none"
            stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={offset}
            transform={`rotate(-90 ${center} ${center})`}
          />
        </svg>
        <View style={[donutStyles.textWrap, { width: size, height: size }]}>
          <Text style={[donutStyles.pctText, { color, fontSize: isMini ? 11 : 20 }]}>{pctText.toFixed(isMini ? 0 : 1)}%</Text>
          {!isMini && <Text style={donutStyles.subText}>{compradas.toLocaleString('es-ES')} / {acordado.toLocaleString('es-ES')}</Text>}
        </View>
      </View>
    </View>
  );
}

function TooltipBtn({ tooltip, children, ...props }: { tooltip: string; children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; disabled?: boolean }) {
  const [hover, setHover] = useState(false);
  const webProps = Platform.OS === 'web' ? { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } : {};
  return (
    <View style={{ position: 'relative' }} {...webProps}>
      <TouchableOpacity {...props}>{children}</TouchableOpacity>
      {hover && (
        <View style={tooltipStyles.bubble}>
          <Text style={[tooltipStyles.text, tooltipTextWebNowrap]}>{tooltip}</Text>
        </View>
      )}
    </View>
  );
}

const ACUERDOS_LAST_SELECTED_KEY = 'acuerdos-last-selected-pk';

function formatFecha(iso: string): string {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatMoneda(n: number | null | undefined): string {
  if (n == null) return '0,00 €';
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function valorEnLocal(obj: Record<string, unknown>, key: string): unknown {
  return obj[key] ?? obj[key.toLowerCase()] ?? obj[key.charAt(0).toUpperCase() + key.slice(1)];
}

export default function AcuerdosScreen() {
  const router = useRouter();
  const { localPermitido, hasPermiso } = useAuth();
  const { width: winWidth } = useWindowDimensions();
  const { productosIgp, loading: loadingProductos, recargar: recargarProductos, lastFetch: productosLastFetch } = useProductosCache();
  const { confirmDelete, ModalConfirm } = useConfirmDelete();

  const [acuerdos, setAcuerdos] = useState<Acuerdo[]>([]);
  const acuerdosRef = useRef<Acuerdo[]>([]);
  useEffect(() => {
    acuerdosRef.current = acuerdos;
  }, [acuerdos]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [seleccionado, setSeleccionado] = useState<Acuerdo | null>(null);
  const [detallesPorAcuerdo, setDetallesPorAcuerdo] = useState<Record<string, DetalleProducto[]>>({});
  const detalles = seleccionado ? (detallesPorAcuerdo[seleccionado.PK] ?? []) : [];
  const [loadingDetalles, setLoadingDetalles] = useState(false);
  const [prodDropdownOpen, setProdDropdownOpen] = useState(false);
  const [prodSearch, setProdSearch] = useState('');
  const [prodFocusedIndex, setProdFocusedIndex] = useState(0);
  const [prodPickIds, setProdPickIds] = useState<string[]>([]);
  const [addingBatchProductos, setAddingBatchProductos] = useState(false);
  const prodListScrollRef = useRef<ScrollView>(null);

  const [filtroMarca, setFiltroMarca] = useState('');
  const [filtroEstado, setFiltroEstado] = useState('Activo');
  const [filtroFacturacion, setFiltroFacturacion] = useState('');

  const [comprasModalVisible, setComprasModalVisible] = useState(false);
  const [comprasModalProduct, setComprasModalProduct] = useState<{ id: string; name: string } | null>(null);

  const cargarDetallesAcuerdoRef = useRef<string | null>(null);
  const cargarDetallesRequestIdRef = useRef<number>(0);
  const seleccionadoRef = useRef<string | null>(null);
  useEffect(() => { seleccionadoRef.current = seleccionado?.PK ?? null; }, [seleccionado]);

  // Sincronizar totales y edits cuando cambia el acuerdo seleccionado o su caché
  useEffect(() => {
    if (!seleccionado) return;
    const d = detallesPorAcuerdo[seleccionado.PK] || [];
    if (d.length === 0) {
      setTotalAcordado(0);
      setTotalCompradas(0);
      setTotalRestante(0);
      setCantidadEdits({});
      setAportacionEdits({});
      setRappelEdits({});
      setDescuentoEdits({});
      return;
    }
    const acordado = d.reduce((s, x) => s + (x.Cantidad || 0), 0);
    const compradas = d.reduce((s, x) => s + (x.Compradas || 0), 0);
    setTotalAcordado(acordado);
    setTotalCompradas(compradas);
    setTotalRestante(acordado - compradas);
    const edits: Record<string, string> = {};
    const apEdits: Record<string, string> = {};
    const raEdits: Record<string, string> = {};
    const deEdits: Record<string, string> = {};
    d.forEach((item: DetalleProducto) => {
      edits[item.ProductId] = String(item.Cantidad || 0);
      apEdits[item.ProductId] = String(item.Aportacion || 0);
      raEdits[item.ProductId] = String(item.Rappel || 0);
      deEdits[item.ProductId] = String(item.DescuentoExtra || 0);
    });
    setCantidadEdits(edits);
    setAportacionEdits(apEdits);
    setRappelEdits(raEdits);
    setDescuentoEdits(deEdits);
  }, [seleccionado?.PK, detallesPorAcuerdo]);

  useEffect(() => {
    if (seleccionado?.PK) AsyncStorage.setItem(ACUERDOS_LAST_SELECTED_KEY, seleccionado.PK);
    else AsyncStorage.removeItem(ACUERDOS_LAST_SELECTED_KEY);
  }, [seleccionado?.PK]);

  const abrirComprasProducto = useCallback((productId: string, productName: string) => {
    if (!seleccionado) return;
    setComprasModalProduct({ id: productId, name: productName });
    setComprasModalVisible(true);
  }, [seleccionado]);

  const [archivos, setArchivos] = useState<ArchivoAcuerdo[]>([]);
  const [loadingArchivos, setLoadingArchivos] = useState(false);
  const [subiendoArchivo, setSubiendoArchivo] = useState(false);

  const cargar = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background === true;
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/acuerdos');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      const items: Acuerdo[] = (data.items || []).map((a: Acuerdo) => ({
        ...a,
        EstadoFacturacion: normalizarEstadoFacturacion(a.EstadoFacturacion),
      }));
      const hoy = new Date().toISOString().slice(0, 10);
      const vencidos: Promise<void>[] = [];
      for (const a of items) {
        if (a.Estado === 'Activo' && a.FechaFin && a.FechaFin < hoy) {
          a.Estado = 'Vencido';
          vencidos.push(
            apiFetch(`/api/acuerdos/${a.PK}`, {
              method: 'PATCH',
              body: JSON.stringify({ Estado: 'Vencido' }),
            }).then(() => {}).catch(() => {})
          );
        }
      }
      if (vencidos.length > 0) await Promise.all(vencidos);
      setAcuerdos(items);
      setSeleccionado((prev) => {
        if (!prev) return null;
        const fresh = items.find((a) => a.PK === prev.PK);
        return fresh || null;
      });
      return items;
    } catch (err: unknown) {
      setError(errorMessage(err));
      return [];
    } finally {
      if (background) setRefreshing(false);
      else setLoading(false);
    }
  }, []);

  const notas = useAcuerdoNotas({
    seleccionado,
    onSaved: async () => {
      await cargar({ background: true });
    },
  });

  const pago = useAcuerdoPago({
    seleccionado,
    localPermitido,
    onError: setError,
  });

  const formAcuerdo = useAcuerdosForm({
    onError: setError,
    onSaved: async (acuerdo, isNew) => {
      const items = await cargar({ background: acuerdosRef.current.length > 0 });
      cargarTotales();
      if (isNew) {
        const a = items.find((x) => x.PK === acuerdo.PK) || acuerdo;
        setSeleccionado(a);
        cargarDetalles(a.PK, { showLoading: true });
        pago.cargar(a.PK);
        cargarArchivos(a.PK);
        pago.cargarLocales();
      }
    },
  });

  const [totalesPorAcuerdo, setTotalesPorAcuerdo] = useState<Record<string, { totalAcordado: number; totalCompradas: number; porcentaje: number }>>({});

  const cargarTotales = useCallback(async () => {
    try {
      const res = await apiFetch('/api/acuerdos/totales');
      const data = await res.json();
      if (res.ok && data.totales) setTotalesPorAcuerdo(data.totales);
    } catch (_) {}
  }, []);

  const eliminar = async (id: string) => {
    try {
      await apiFetch(`/api/acuerdos/${id}`, { method: 'DELETE' });
      await cargar({ background: acuerdosRef.current.length > 0 });
      cargarTotales();
    } catch (err: unknown) {
      setError(errorMessage(err));
    }
  };


  const resumenEstados = useMemo(() => {
    const porEstado: Record<string, number> = {
      Activo: 0,
      Vencido: 0,
      Completado: 0,
      Cancelado: 0,
    };
    const vencidosPorFacturacion: Record<EstadoFacturacionAcuerdo, number> = {
      sin_factura: 0,
      pendiente_pago: 0,
      pagado_parcial: 0,
      pagado: 0,
    };

    for (const a of acuerdos) {
      const est = a.Estado || 'Activo';
      if (est in porEstado) porEstado[est] += 1;
      if (est === 'Vencido') {
        const ef = normalizarEstadoFacturacion(a.EstadoFacturacion);
        vencidosPorFacturacion[ef] += 1;
      }
    }

    const partesVencidos = (['sin_factura', 'pendiente_pago', 'pagado_parcial', 'pagado'] as EstadoFacturacionAcuerdo[])
      .filter((k) => vencidosPorFacturacion[k] > 0)
      .map((k) => `${vencidosPorFacturacion[k]} ${etiquetaEstadoFacturacion(k).toLowerCase()}`);

    return {
      porEstado,
      total: acuerdos.length,
      vencidos: porEstado.Vencido,
      textoVencidosFacturacion: partesVencidos.join(' · '),
    };
  }, [acuerdos]);

  const conteosFacturacion = useMemo(() => {
    const base = filtroEstado
      ? acuerdos.filter((a) => a.Estado === filtroEstado)
      : acuerdos;
    const c: Record<string, number> = { '': base.length };
    for (const a of base) {
      const ef = normalizarEstadoFacturacion(a.EstadoFacturacion);
      c[ef] = (c[ef] ?? 0) + 1;
    }
    return c;
  }, [acuerdos, filtroEstado]);

  const acuerdosOrdenados = useMemo(() => {
    const q = filtroMarca.trim().toLowerCase();
    const filtered = acuerdos.filter((a) => {
      if (filtroEstado && a.Estado !== filtroEstado) return false;
      if (q && !(a.Marca || '').toLowerCase().includes(q)) return false;
      if (filtroFacturacion) {
        const ef = normalizarEstadoFacturacion(a.EstadoFacturacion);
        if (ef !== filtroFacturacion) return false;
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      const aActivo = a.Estado === 'Activo' ? 0 : 1;
      const bActivo = b.Estado === 'Activo' ? 0 : 1;
      if (aActivo !== bActivo) return aActivo - bActivo;
      return (a.FechaFin || '').localeCompare(b.FechaFin || '');
    });
  }, [acuerdos, filtroMarca, filtroEstado, filtroFacturacion]);

  const cambiarEstadoFacturacion = useCallback(async (pk: string, estado: EstadoFacturacionAcuerdo) => {
    try {
      const res = await apiFetch(`/api/acuerdos/${pk}`, {
        method: 'PATCH',
        body: JSON.stringify({
          EstadoFacturacion: estado,
          FacturacionOrigen: 'manual',
          EstadoFacturacionManual: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      await cargar({ background: acuerdosRef.current.length > 0 });
    } catch (err: unknown) {
      setError(errorMessage(err));
    }
  }, [cargar]);

  const [totalAcordado, setTotalAcordado] = useState(0);
  const [totalCompradas, setTotalCompradas] = useState(0);
  const [totalRestante, setTotalRestante] = useState(0);

  const cargarDetalles = useCallback(async (acuerdoPK: string, options?: { showLoading?: boolean }) => {
    const requestId = ++cargarDetallesRequestIdRef.current;
    cargarDetallesAcuerdoRef.current = acuerdoPK;
    const showLoading = options?.showLoading !== false;
    if (showLoading) setLoadingDetalles(true);
    try {
      const res = await apiFetch(`/api/acuerdos/${acuerdoPK}/detalles-con-compras`);
      const data = await res.json();
      if (cargarDetallesRequestIdRef.current !== requestId) return;
      if (res.ok) {
        const items = Array.isArray(data.items) ? data.items : [];
        setDetallesPorAcuerdo((prev) => {
          const existing = prev[acuerdoPK] || [];
          if (items.length === 0 && existing.length > 0) return prev;
          return { ...prev, [acuerdoPK]: items };
        });
        const ta = data.totalAcordado || 0;
        const tc = data.totalCompradas || 0;
        const pctAcuerdo = ta > 0 ? Math.round((tc / ta) * 1000) / 10 : 0;
        setTotalesPorAcuerdo((p) => ({ ...p, [acuerdoPK]: { totalAcordado: ta, totalCompradas: tc, porcentaje: pctAcuerdo } }));
        if (acuerdoPK === seleccionadoRef.current) {
          setTotalAcordado(ta);
          setTotalCompradas(tc);
          setTotalRestante(data.totalRestante || 0);
          const edits: Record<string, string> = {};
          const apEdits: Record<string, string> = {};
          const raEdits: Record<string, string> = {};
          const deEdits: Record<string, string> = {};
          items.forEach((d: DetalleProducto) => {
            edits[d.ProductId] = String(d.Cantidad || 0);
            apEdits[d.ProductId] = String(d.Aportacion || 0);
            raEdits[d.ProductId] = String(d.Rappel || 0);
            deEdits[d.ProductId] = String(d.DescuentoExtra || 0);
          });
          setCantidadEdits(edits);
          setAportacionEdits(apEdits);
          setRappelEdits(raEdits);
          setDescuentoEdits(deEdits);
        }
      }
    } catch (_) { /* silencioso */ }
    finally {
      if (cargarDetallesAcuerdoRef.current === acuerdoPK) setLoadingDetalles(false);
    }
  }, []);

  const seleccionarAcuerdo = (a: Acuerdo) => {
    if (seleccionado?.PK === a.PK) { setSeleccionado(null); return; }
    setSeleccionado(a);
    const cached = detallesPorAcuerdo[a.PK] || [];
    const tieneCache = cached.length > 0;
    if (tieneCache) {
      const newAcordado = cached.reduce((s, x) => s + (x.Cantidad || 0), 0);
      const newCompradas = cached.reduce((s, x) => s + (x.Compradas || 0), 0);
      setTotalAcordado(newAcordado);
      setTotalCompradas(newCompradas);
      setTotalRestante(newAcordado - newCompradas);
      const pctCache = newAcordado > 0 ? Math.round((newCompradas / newAcordado) * 1000) / 10 : 0;
      setTotalesPorAcuerdo((p) => ({ ...p, [a.PK]: { totalAcordado: newAcordado, totalCompradas: newCompradas, porcentaje: pctCache } }));
      const edits: Record<string, string> = {};
      const apEdits: Record<string, string> = {};
      const raEdits: Record<string, string> = {};
      const deEdits: Record<string, string> = {};
      cached.forEach((d: DetalleProducto) => {
        edits[d.ProductId] = String(d.Cantidad || 0);
        apEdits[d.ProductId] = String(d.Aportacion || 0);
        raEdits[d.ProductId] = String(d.Rappel || 0);
        deEdits[d.ProductId] = String(d.DescuentoExtra || 0);
      });
      setCantidadEdits(edits);
      setAportacionEdits(apEdits);
      setRappelEdits(raEdits);
      setDescuentoEdits(deEdits);
    }
    cargarDetalles(a.PK, { showLoading: !tieneCache });
    pago.cargar(a.PK);
    cargarArchivos(a.PK);
    pago.cargarLocales();
    if (!productosLastFetch) recargarProductos();
  };

  const addProductoDetalle = async (prod: Record<string, unknown>, opts?: { skipClose?: boolean }): Promise<boolean> => {
    if (!seleccionado) return false;
    const id = String(valorEnLocal(prod, 'Id') ?? '').trim();
    const name = String(valorEnLocal(prod, 'Name') ?? valorEnLocal(prod, 'Nombre') ?? id).trim();
    if (!id) return false;
    try {
      const res = await apiFetch(`/api/acuerdos/${seleccionado.PK}/detalles`, {
        method: 'POST',
        body: JSON.stringify({ ProductId: id, ProductName: name, Cantidad: 0 }),
      });
      if (res.ok) {
        const nuevo: DetalleProducto = {
          PK: seleccionado.PK, SK: id, ProductId: id, ProductName: name,
          Cantidad: 0, Aportacion: 0, Rappel: 0, DescuentoExtra: 0,
          Compradas: 0, Restante: 0, Porcentaje: 0,
        };
        setDetallesPorAcuerdo((prev) => ({
          ...prev,
          [seleccionado.PK]: [...(prev[seleccionado.PK] || []), nuevo].sort((a, b) => (a.ProductName || '').localeCompare(b.ProductName || '')),
        }));
        setCantidadEdits((prev) => ({ ...prev, [id]: '0' }));
        setAportacionEdits((prev) => ({ ...prev, [id]: '0' }));
        setRappelEdits((prev) => ({ ...prev, [id]: '0' }));
        setDescuentoEdits((prev) => ({ ...prev, [id]: '0' }));
        cargarTotales();
        cargarDetalles(seleccionado.PK, { showLoading: false });
        if (!opts?.skipClose) {
          setProdDropdownOpen(false);
          setProdSearch('');
          setProdPickIds([]);
        }
        return true;
      }
      return false;
    } catch (err: unknown) {
      setError(errorMessage(err));
      if (!opts?.skipClose) {
        setProdDropdownOpen(false);
        setProdSearch('');
      }
      return false;
    }
  };

  const addProductosSeleccionados = async () => {
    if (!seleccionado || prodPickIds.length === 0) return;
    const full = (productosIgp || []) as Record<string, unknown>[];
    const byId = new Map(full.map((p) => [String(valorEnLocal(p, 'Id') ?? '').trim(), p]));
    const uniq = [...new Set(prodPickIds)];
    const ya = new Set(detalles.map((d) => d.ProductId));
    setAddingBatchProductos(true);
    try {
      for (const id of uniq) {
        if (ya.has(id)) continue;
        const prod = byId.get(id);
        if (!prod) continue;
        const ok = await addProductoDetalle(prod, { skipClose: true });
        if (ok) ya.add(id);
      }
    } finally {
      setAddingBatchProductos(false);
      setProdDropdownOpen(false);
      setProdSearch('');
      setProdPickIds([]);
    }
  };

  const actualizarCantidad = async (productId: string, cantidad: number) => {
    if (!seleccionado) return;
    try {
      await apiFetch(`/api/acuerdos/${seleccionado.PK}/detalles/${productId}`, {
        method: 'PATCH',
        body: JSON.stringify({ Cantidad: cantidad }),
      });
    } catch (err: unknown) { setError(errorMessage(err)); }
  };

  const actualizarCampoDetalle = async (productId: string, campo: string, valor: number) => {
    if (!seleccionado) return;
    try {
      await apiFetch(`/api/acuerdos/${seleccionado.PK}/detalles/${productId}`, {
        method: 'PATCH',
        body: JSON.stringify({ [campo]: valor }),
      });
    } catch (err: unknown) { setError(errorMessage(err)); }
  };

  const [cantidadEdits, setCantidadEdits] = useState<Record<string, string>>({});
  const [aportacionEdits, setAportacionEdits] = useState<Record<string, string>>({});
  const [rappelEdits, setRappelEdits] = useState<Record<string, string>>({});
  const [descuentoEdits, setDescuentoEdits] = useState<Record<string, string>>({});

  const removeProductoDetalle = async (productId: string) => {
    if (!seleccionado) return;
    try {
      const res = await apiFetch(
        `/api/acuerdos/${encodeURIComponent(seleccionado.PK)}/detalles/${encodeURIComponent(productId)}`,
        { method: 'DELETE' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || `Error al eliminar producto (${res.status})`);
        return;
      }
      setDetallesPorAcuerdo((prev) => {
        const current = prev[seleccionado.PK] || [];
        const updated = current.filter((d) => d.ProductId !== productId);
        const newAcordado = updated.reduce((s, x) => s + (x.Cantidad || 0), 0);
        const newCompradas = updated.reduce((s, x) => s + (x.Compradas || 0), 0);
        setTotalAcordado(newAcordado);
        setTotalCompradas(newCompradas);
        setTotalRestante(newAcordado - newCompradas);
        const pct = newAcordado > 0 ? Math.round((newCompradas / newAcordado) * 1000) / 10 : 0;
        setTotalesPorAcuerdo((p) => ({ ...p, [seleccionado.PK]: { totalAcordado: newAcordado, totalCompradas: newCompradas, porcentaje: pct } }));
        return { ...prev, [seleccionado.PK]: updated };
      });
      setCantidadEdits((prev) => { const n = { ...prev }; delete n[productId]; return n; });
      setAportacionEdits((prev) => { const n = { ...prev }; delete n[productId]; return n; });
      setRappelEdits((prev) => { const n = { ...prev }; delete n[productId]; return n; });
      setDescuentoEdits((prev) => { const n = { ...prev }; delete n[productId]; return n; });
    } catch (err: unknown) { setError(errorMessage(err, 'Error de conexión')); }
  };

  const cargarArchivos = useCallback(async (acuerdoPK: string) => {
    setLoadingArchivos(true);
    try {
      const res = await apiFetch(`/api/acuerdos/${acuerdoPK}/files`);
      const data = await res.json();
      if (res.ok) setArchivos(data);
    } catch (_) {}
    finally { setLoadingArchivos(false); }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const [items, totalesData] = await Promise.all([
          cargar({ background: acuerdosRef.current.length > 0 }),
          (async () => {
            try {
              const res = await apiFetch('/api/acuerdos/totales');
              const data = await res.json();
              return res.ok && data.totales ? data.totales : {};
            } catch (_) { return {}; }
          })(),
        ]);
        if (cancelled) return;
        setTotalesPorAcuerdo(totalesData);
        const lastPK = await AsyncStorage.getItem(ACUERDOS_LAST_SELECTED_KEY);
        if (lastPK) {
          let a = items.find((x: Acuerdo) => x.PK === lastPK);
          if (!a) {
            try {
              const res = await apiFetch(`/api/acuerdos/${encodeURIComponent(lastPK)}`);
              const data = await res.json();
              if (res.ok && data.item) {
                const fetched = data.item as Acuerdo;
                a = fetched;
                setAcuerdos((prev) => {
                  const exists = prev.some((x) => x.PK === fetched.PK);
                  if (exists) return prev;
                  return [fetched, ...prev].sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || ''));
                });
              }
            } catch (_) {}
          }
          if (a) {
            setSeleccionado(a);
            cargarDetalles(a.PK, { showLoading: true });
            pago.cargar(a.PK);
            cargarArchivos(a.PK);
            pago.cargarLocales();
          }
        }
      })();
      return () => { cancelled = true; };
    }, [cargar, cargarTotales, cargarDetalles, pago.cargar, pago.cargarLocales, cargarArchivos])
  );

  const subirArchivo = useCallback(async () => {
    if (!seleccionado || Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
      const files = input.files;
      if (!files || files.length === 0) return;
      setSubiendoArchivo(true);
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const presignRes = await apiFetch(`/api/acuerdos/${seleccionado.PK}/files/presign-upload`, {
            method: 'POST',
            body: JSON.stringify({ fileName: file.name, contentType: file.type }),
          });
          const { uploadUrl, fileKey } = await presignRes.json();

          await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type },
            body: file,
          });

          await apiFetch(`/api/acuerdos/${seleccionado.PK}/files`, {
            method: 'POST',
            body: JSON.stringify({ fileKey, fileName: file.name, contentType: file.type, size: file.size }),
          });
        }
        await cargarArchivos(seleccionado.PK);
      } catch (err) {
        console.error('Error subiendo archivo', err);
      } finally {
        setSubiendoArchivo(false);
      }
    };
    input.click();
  }, [seleccionado, cargarArchivos]);

  const eliminarArchivo = useCallback(async (fileKey: string) => {
    if (!seleccionado) return;
    try {
      await apiFetch(`/api/acuerdos/${seleccionado.PK}/files/${encodeURIComponent(fileKey)}`, { method: 'DELETE' });
      setArchivos((prev) => prev.filter((f) => f.fileKey !== fileKey));
    } catch (err) {
      console.error('Error eliminando archivo', err);
    }
  }, [seleccionado]);

  const totalImporteImagen = useMemo(() => pago.pagosImagen.reduce((s, p) => s + (p.Importe || 0), 0), [pago.pagosImagen]);
  const totalImporteImagenRealizado = useMemo(() => pago.pagosImagen.filter((p) => p.Realizado).reduce((s, p) => s + (p.Importe || 0), 0), [pago.pagosImagen]);

  const aportacionVolumen = useMemo(() => detalles.reduce((s, d) => {
    const ta = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0);
    return s + (d.Cantidad || 0) * ta;
  }, 0), [detalles]);

  const aportacionVolumenGenerado = useMemo(() => detalles.reduce((s, d) => {
    const ta = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0);
    return s + (d.Compradas || 0) * ta;
  }, 0), [detalles]);

  const totalAcuerdo = aportacionVolumen + totalImporteImagen;
  const totalAcuerdoGenerado = aportacionVolumenGenerado + totalImporteImagenRealizado;

  const productosFiltrados = useMemo(() => {
    const q = prodSearch.trim().toLowerCase();
    const prods = (productosIgp || []) as Record<string, unknown>[];
    const asignados = new Set(detalles.map((d) => d.ProductId));
    const filtered = prods.filter((p) => {
      const id = String(valorEnLocal(p, 'Id') ?? '').trim();
      if (asignados.has(id)) return false;
      if (!q) return true;
      const name = String(valorEnLocal(p, 'Name') ?? valorEnLocal(p, 'Nombre') ?? '').toLowerCase();
      return name.includes(q) || id.toLowerCase().includes(q);
    });
    return filtered.slice(0, 50);
  }, [productosIgp, prodSearch, detalles]);

  const prodPickSet = useMemo(() => new Set(prodPickIds), [prodPickIds]);

  const costPriceMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of (productosIgp || []) as Record<string, unknown>[]) {
      const id = String(p.Id ?? p.id ?? '').trim();
      const cost = Number(p.CostPrice ?? p.costPrice ?? 0) || 0;
      if (id) map[id] = cost;
    }
    return map;
  }, [productosIgp]);

  const isCompact = winWidth < 700;

  const generarPDF = useCallback(async () => {
    if (!seleccionado) return;
    const { jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    let y = 15;

    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text(seleccionado.Marca || 'Sin marca', 14, y);
    y += 7;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100);
    doc.text(`${formatFecha(seleccionado.FechaInicio)} — ${formatFecha(seleccionado.FechaFin)}`, 14, y);
    const tr = calcTiempoRestante(seleccionado.FechaFin);
    doc.text(tr.texto, pageW - 14, y, { align: 'right' });
    y += 8;

    doc.setDrawColor(200);
    doc.line(14, y, pageW - 14, y);
    y += 6;

    doc.setTextColor(60);
    doc.setFontSize(9);
    const infoLines: [string, string][] = [
      ['PK', seleccionado.PK],
      ['Nombre', seleccionado.Nombre || '—'],
      ['Marca', seleccionado.Marca || '—'],
      ['Estado', seleccionado.Estado],
      ['Facturación', etiquetaEstadoFacturacion(normalizarEstadoFacturacion(seleccionado.EstadoFacturacion))],
    ];
    if (seleccionado.A3FacturaNumero) infoLines.push(['Nº factura', seleccionado.A3FacturaNumero]);
    if (seleccionado.FacturacionOrigen) {
      infoLines.push(['Origen fact.', seleccionado.FacturacionOrigen === 'a3' ? 'A3' : 'Manual']);
    }
    if (seleccionado.Contacto) infoLines.push(['Contacto', seleccionado.Contacto]);
    if (seleccionado.Telefono) infoLines.push(['Teléfono', seleccionado.Telefono]);
    if (seleccionado.Email) infoLines.push(['Email', seleccionado.Email]);

    const colX = 14;
    const col2X = pageW / 2 + 10;
    const half = Math.ceil(infoLines.length / 2);
    for (let i = 0; i < half; i++) {
      const left = infoLines[i];
      const right = infoLines[i + half];
      if (left) {
        doc.setFont('helvetica', 'bold');
        doc.text(`${left[0]}:`, colX, y);
        doc.setFont('helvetica', 'normal');
        doc.text(left[1], colX + 28, y);
      }
      if (right) {
        doc.setFont('helvetica', 'bold');
        doc.text(`${right[0]}:`, col2X, y);
        doc.setFont('helvetica', 'normal');
        doc.text(right[1], col2X + 28, y);
      }
      y += 5;
    }
    y += 4;

    const fmtNum = (n: number) => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    const totalesData = [
      ['Total Acuerdo', fmtNum(totalAcuerdo), 'Total Acuerdo Generado', fmtNum(totalAcuerdoGenerado)],
      ['Aport. Volumen', fmtNum(aportacionVolumen), 'Aport. Volumen Generado', fmtNum(aportacionVolumenGenerado)],
      ['Aport. Imagen', fmtNum(totalImporteImagen), 'Aport. Imagen Generada', fmtNum(totalImporteImagenRealizado)],
    ];
    autoTable(doc, {
      startY: y,
      head: [['Concepto', 'Importe', 'Concepto Generado', 'Importe Generado']],
      body: totalesData,
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'right' }, 3: { halign: 'right' } },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 8;

    const pctGlobal = totalAcordado > 0 ? (totalCompradas / totalAcordado * 100).toFixed(1) : '0.0';
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text(`Consecución global: ${pctGlobal}% — ${totalCompradas.toLocaleString('es-ES')} / ${totalAcordado.toLocaleString('es-ES')} uds.`, 14, y);
    y += 6;

    if (detalles.length > 0) {
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(15, 23, 42);
      doc.text('Productos del acuerdo', 14, y);
      y += 2;

      const prodHead = [['ID', 'Producto', 'Acordado', 'Compradas', 'Restante', '%', 'Total Aport.', 'Aportación', 'Rappel', 'Dto. extra', 'Prev. Pago', 'Prev. Confirm.']];
      const prodBody = detalles.map((d) => {
        const ta = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0);
        const rest = d.Restante || 0;
        return [
          d.ProductId,
          d.ProductName || d.ProductId,
          String(d.Cantidad || 0),
          String(d.Compradas || 0),
          rest > 0 ? `-${rest}` : rest < 0 ? `+${Math.abs(rest)}` : String(rest),
          `${(d.Porcentaje || 0).toFixed(1)}%`,
          fmtNum(ta),
          fmtNum(d.Aportacion || 0),
          fmtNum(d.Rappel || 0),
          fmtNum(d.DescuentoExtra || 0),
          fmtNum((d.Cantidad || 0) * ta),
          fmtNum((d.Compradas || 0) * ta),
        ];
      });

      const totAcord = detalles.reduce((s, d) => s + (d.Cantidad || 0), 0);
      const totComp = detalles.reduce((s, d) => s + (d.Compradas || 0), 0);
      const totRest = totAcord - totComp;
      const totTA = detalles.reduce((s, d) => s + (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0), 0);
      const totPrevPago = detalles.reduce((s, d) => { const ta = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0); return s + (d.Cantidad || 0) * ta; }, 0);
      const totPrevConf = detalles.reduce((s, d) => { const ta = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0); return s + (d.Compradas || 0) * ta; }, 0);

      prodBody.push([
        '', 'TOTAL',
        String(totAcord), String(totComp),
        totRest > 0 ? `-${totRest}` : totRest < 0 ? `+${Math.abs(totRest)}` : String(totRest),
        '', fmtNum(totTA), '', '', '',
        fmtNum(totPrevPago), fmtNum(totPrevConf),
      ]);

      autoTable(doc, {
        startY: y,
        head: prodHead,
        body: prodBody,
        theme: 'striped',
        styles: { fontSize: 7, cellPadding: 1.5 },
        headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold', fontSize: 7 },
        columnStyles: {
          0: { cellWidth: 18 },
          1: { cellWidth: 40 },
          2: { halign: 'center' },
          3: { halign: 'center' },
          4: { halign: 'center' },
          5: { halign: 'center' },
          6: { halign: 'right' },
          7: { halign: 'right' },
          8: { halign: 'right' },
          9: { halign: 'right' },
          10: { halign: 'right' },
          11: { halign: 'right' },
        },
        margin: { left: 14, right: 14 },
        didParseCell: (data: any) => {
          if (data.section === 'body' && data.row.index === prodBody.length - 1) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.fillColor = [240, 249, 255];
          }
        },
      });
      y = (doc as any).lastAutoTable.finalY + 8;
    }

    if (pago.pagosImagen.length > 0) {
      if (y > doc.internal.pageSize.getHeight() - 30) { doc.addPage(); y = 15; }
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(15, 23, 42);
      doc.text('Pagos por imagen', 14, y);
      y += 2;

      const imgHead = [['Acciones', 'Locales', 'Importe', 'Realizado', 'Descripción']];
      const imgBody = pago.pagosImagen.map((p) => [
        p.Acciones.join(', '),
        p.Locales.map((id) => pago.localNombre(id)).join(', '),
        fmtNum(p.Importe || 0),
        p.Realizado ? 'Sí' : 'No',
        p.Descripcion || '',
      ]);
      imgBody.push(['', 'TOTAL', fmtNum(totalImporteImagen), `Realizado: ${fmtNum(totalImporteImagenRealizado)}`, '']);

      autoTable(doc, {
        startY: y,
        head: imgHead,
        body: imgBody,
        theme: 'striped',
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold' },
        columnStyles: {
          2: { halign: 'right' },
          3: { halign: 'center' },
        },
        margin: { left: 14, right: 14 },
        didParseCell: (data: any) => {
          if (data.section === 'body' && data.row.index === imgBody.length - 1) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.fillColor = [240, 249, 255];
          }
        },
      });
    }

    const pageCount = doc.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(150);
      doc.text(`Generado el ${new Date().toLocaleDateString('es-ES')} — Pág. ${i}/${pageCount}`, pageW - 14, doc.internal.pageSize.getHeight() - 8, { align: 'right' });
    }

    const fileName = `Acuerdo_${(seleccionado.Marca || seleccionado.PK).replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
    if (Platform.OS === 'web') {
      doc.save(fileName);
    } else {
      const dataUri = doc.output('datauristring');
      const base64 = dataUri.split(',')[1] || '';
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}${fileName}`;
      try {
        await FileSystemLegacy.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: fileName });
      } catch {
        /* noop */
      }
    }
  }, [seleccionado, detalles, pago.pagosImagen, pago.localNombre, totalAcuerdo, totalAcuerdoGenerado, aportacionVolumen, aportacionVolumenGenerado, totalImporteImagen, totalImporteImagenRealizado, totalAcordado, totalCompradas]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Acuerdos con Marcas</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.informeBtn}
            onPress={() => router.push('/acuerdos-informe-compras' as any)}
            accessibilityLabel="Informe compras por acuerdo"
          >
            <MaterialIcons name="assessment" size={18} color="#7c3aed" />
            <Text style={styles.informeBtnText}>Informe</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.productosActivosBtn}
            onPress={() => router.push('/acuerdos-productos-activos' as any)}
            accessibilityLabel="Productos en acuerdos activos"
          >
            <MaterialIcons name="view-list" size={18} color="#0f766e" />
            <Text style={styles.productosActivosBtnText}>Activos</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.productosAgoraBtn}
            onPress={() => router.push('/productos')}
            accessibilityLabel="Productos Ágora"
          >
            <MaterialIcons name="inventory-2" size={18} color="#0369a1" />
            <Text style={styles.productosAgoraBtnText}>Ágora</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.createBtn} onPress={formAcuerdo.abrirCrear}>
            <MaterialIcons name="add" size={20} color="#fff" />
            <Text style={styles.createBtnText}>Nuevo Acuerdo</Text>
          </TouchableOpacity>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => setError('')}><MaterialIcons name="close" size={14} color="#dc2626" /></TouchableOpacity>
        </View>
      ) : null}

      {ModalConfirm()}

      <View style={styles.splitContainer}>
        {/* Lista de acuerdos */}
        <View style={[styles.list, seleccionado && !isCompact && { flex: 2 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, gap: 6, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' }}>
          <MaterialIcons name="search" size={18} color="#94a3b8" />
          <TextInput
            value={filtroMarca}
            onChangeText={setFiltroMarca}
            placeholder="Filtrar por marca…"
            placeholderTextColor="#94a3b8"
            style={{ flex: 1, fontSize: 14, color: '#1e293b', padding: 6, outlineStyle: 'none' } as any}
          />
          {refreshing ? <ActivityIndicator size="small" color="#0ea5e9" /> : null}
          {filtroMarca ? (
            <TouchableOpacity onPress={() => setFiltroMarca('')}><MaterialIcons name="close" size={16} color="#94a3b8" /></TouchableOpacity>
          ) : null}
        </View>
        {acuerdos.length > 0 ? (
          <View style={styles.resumenBar}>
            <Text style={styles.resumenBarText}>
              Activos {resumenEstados.porEstado.Activo}
              {' · '}Vencidos {resumenEstados.vencidos}
              {' · '}Completados {resumenEstados.porEstado.Completado}
              {' · '}Total {resumenEstados.total}
            </Text>
            {resumenEstados.vencidos > 0 ? (
              <TouchableOpacity
                style={styles.resumenAlerta}
                onPress={() => setFiltroEstado('Vencido')}
              >
                <MaterialIcons name="warning-amber" size={14} color="#b45309" />
                <Text style={styles.resumenAlertaText}>
                  {resumenEstados.vencidos} vencido{resumenEstados.vencidos !== 1 ? 's' : ''}
                  {resumenEstados.textoVencidosFacturacion ? `: ${resumenEstados.textoVencidosFacturacion}` : ''}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filtroFactScroll}
          contentContainerStyle={styles.filtroFactRow}
        >
          {FILTROS_ESTADO_ACUERDO.map((f) => {
            const active = filtroEstado === f.id;
            const count = f.id ? (resumenEstados.porEstado[f.id] ?? 0) : resumenEstados.total;
            const alertaVencido = f.id === 'Vencido' && resumenEstados.vencidos > 0 && !active;
            return (
              <TouchableOpacity
                key={f.id || 'todos-estado'}
                style={[
                  styles.filtroFactChip,
                  active && styles.filtroEstadoChipActive,
                  alertaVencido && styles.filtroEstadoChipAlerta,
                ]}
                onPress={() => setFiltroEstado(f.id)}
              >
                <Text style={[styles.filtroFactChipText, active && styles.filtroFactChipTextActive]}>
                  {f.label} ({count})
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filtroFactScroll}
          contentContainerStyle={styles.filtroFactRow}
        >
          {FILTROS_FACTURACION.map((f) => {
            const active = filtroFacturacion === f.id;
            const count = conteosFacturacion[f.id] ?? 0;
            return (
              <TouchableOpacity
                key={f.id || 'todas'}
                style={[styles.filtroFactChip, active && styles.filtroFactChipActive]}
                onPress={() => setFiltroFacturacion(f.id)}
              >
                <Text style={[styles.filtroFactChipText, active && styles.filtroFactChipTextActive]}>
                  {f.label}{f.id ? ` (${count})` : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.listContent}>
          {loading && acuerdos.length === 0 ? (
            <View style={styles.emptyWrap}><ActivityIndicator size="large" color="#0ea5e9" /><Text style={styles.emptyText}>Cargando…</Text></View>
          ) : acuerdos.length === 0 ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name="handshake" size={48} color="#cbd5e1" />
              <Text style={styles.emptyText}>No hay acuerdos. Crea uno pulsando "Nuevo Acuerdo".</Text>
            </View>
          ) : acuerdosOrdenados.length === 0 ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name="filter-list" size={40} color="#cbd5e1" />
              <Text style={styles.emptyText}>Ningún acuerdo coincide con los filtros.</Text>
            </View>
          ) : (
            acuerdosOrdenados.map((a) => {
              const estadoColor = a.Estado === 'Activo' ? '#16a34a' : a.Estado === 'Completado' ? '#0ea5e9' : a.Estado === 'Vencido' ? '#ef4444' : '#94a3b8';
              const ef = normalizarEstadoFacturacion(a.EstadoFacturacion);
              const efStyle = estiloEstadoFacturacion(ef);
              const isSelected = seleccionado?.PK === a.PK;
              const tr = calcTiempoRestante(a.FechaFin);
              return (
                <TouchableOpacity key={a.PK} activeOpacity={0.7} onPress={() => seleccionarAcuerdo(a)} style={[styles.card, isSelected && styles.cardSelected]}>
                  <View style={styles.cardHeader}>
                    <View style={styles.cardTitleWrap}>
                      <Text style={styles.cardTitle} numberOfLines={1}>
                        {a.Marca || '—'}
                      </Text>
                      <View style={styles.cardIdBadge}>
                        <Text style={styles.cardIdBadgeText}>{a.PK.slice(0, 8)}</Text>
                      </View>
                      <View style={[styles.badge, { backgroundColor: estadoColor + '18', borderColor: estadoColor }]}>
                        <Text style={[styles.badgeText, { color: estadoColor }]}>{a.Estado}</Text>
                      </View>
                      <View style={[styles.badge, { backgroundColor: efStyle.bg, borderColor: efStyle.border }]}>
                        <Text style={[styles.badgeText, { color: efStyle.text }]}>{etiquetaEstadoFacturacion(ef)}</Text>
                      </View>
                    </View>
                    <View style={styles.cardActions}>
                      <TooltipBtn tooltip="Editar" onPress={() => formAcuerdo.abrirEditar(a)} style={styles.cardActionBtn}>
                        <MaterialIcons name="edit" size={18} color="#64748b" />
                      </TooltipBtn>
                      <TooltipBtn
                        tooltip="Eliminar"
                        onPress={() => confirmDelete('Confirmar eliminación', `¿Quieres eliminar el acuerdo "${a.Marca || a.Nombre || a.PK}"? Esta acción no se puede deshacer.`, () => eliminar(a.PK))}
                        style={styles.cardActionBtn}
                      >
                        <MaterialIcons name="delete-outline" size={18} color="#ef4444" />
                      </TooltipBtn>
                    </View>
                  </View>
                  <View style={styles.cardBodyWithDonut}>
                    {(() => {
                      const t = totalesPorAcuerdo[a.PK];
                      const pct = t?.porcentaje ?? 0;
                      const compradas = t?.totalCompradas ?? 0;
                      const acordado = t?.totalAcordado ?? 0;
                      return (
                        <DonutChart porcentaje={pct} compradas={compradas} acordado={acordado || 1} size={56} />
                      );
                    })()}
                    <View style={styles.cardBodyInfo}>
                      <View style={styles.cardField}>
                        <Text style={styles.cardFieldLabel}>Restante</Text>
                        <Text style={[styles.cardFieldValue, styles.cardCountdown, tr.vencido && { color: '#ef4444' }]}>
                          {tr.texto}
                        </Text>
                      </View>
                      <View style={styles.cardField}>
                        <Text style={styles.cardFieldLabel}>Periodo</Text>
                        <Text style={styles.cardFieldValue}>{formatFecha(a.FechaInicio)} — {formatFecha(a.FechaFin)}</Text>
                      </View>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
        </View>

        {/* Panel lateral: Detalle del acuerdo */}
        {seleccionado && (
          <View style={[styles.detailPanel, isCompact && styles.detailPanelCompact]}>
            <ScrollView keyboardShouldPersistTaps="handled">
              {/* Cabecera */}
              <View style={styles.detailPanelHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.detailPanelTitle}>{seleccionado.Marca || 'Sin marca'}</Text>
                  {(() => {
                    const tr = calcTiempoRestante(seleccionado.FechaFin);
                    return <Text style={[styles.detailPanelCountdown, tr.vencido && { color: '#ef4444' }]}>{tr.texto}</Text>;
                  })()}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <TooltipBtn tooltip="Ver historial de notas" onPress={notas.abrir} style={{ padding: 4 }}>
                    <MaterialIcons name="note" size={20} color="#6366f1" />
                  </TooltipBtn>
                  {Platform.OS === 'web' && (
                    <TooltipBtn tooltip="Descargar PDF" onPress={generarPDF} style={{ padding: 4 }}>
                      <MaterialIcons name="picture-as-pdf" size={20} color="#ef4444" />
                    </TooltipBtn>
                  )}
                  <TouchableOpacity onPress={() => setSeleccionado(null)} style={{ padding: 4 }}>
                    <MaterialIcons name="close" size={20} color="#64748b" />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Info del acuerdo + Totales */}
              <View style={styles.detailInfoSection}>
                <View style={styles.detailInfoColumns}>
                  {/* Columna izquierda: datos del acuerdo */}
                  <View style={styles.detailInfoLeft}>
                    <View style={styles.detailInfoRow}>
                      <Text style={styles.detailInfoLabel}>PK</Text>
                      <Text style={styles.detailInfoValue} numberOfLines={1}>{seleccionado.PK}</Text>
                    </View>
                    {seleccionado.Nombre ? (
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>Nombre</Text>
                        <Text style={styles.detailInfoValue}>{seleccionado.Nombre}</Text>
                      </View>
                    ) : null}
                    <View style={styles.detailInfoRow}>
                      <Text style={styles.detailInfoLabel}>Marca</Text>
                      <Text style={styles.detailInfoValue}>{seleccionado.Marca || '—'}</Text>
                    </View>
                    <View style={styles.detailInfoRow}>
                      <Text style={styles.detailInfoLabel}>Periodo</Text>
                      <Text style={styles.detailInfoValue}>{formatFecha(seleccionado.FechaInicio)} — {formatFecha(seleccionado.FechaFin)}</Text>
                    </View>
                    <View style={styles.detailInfoRow}>
                      <Text style={styles.detailInfoLabel}>Estado</Text>
                      <Text style={[styles.detailInfoValue, { color: seleccionado.Estado === 'Activo' ? '#16a34a' : seleccionado.Estado === 'Completado' ? '#0ea5e9' : seleccionado.Estado === 'Vencido' ? '#ef4444' : '#94a3b8', fontWeight: '600' }]}>{seleccionado.Estado}</Text>
                    </View>
                    <View style={styles.detailInfoRow}>
                      <Text style={styles.detailInfoLabel}>Facturación</Text>
                      <View style={{ flex: 1, gap: 6 }}>
                        {(() => {
                          const ef = normalizarEstadoFacturacion(seleccionado.EstadoFacturacion);
                          const efStyle = estiloEstadoFacturacion(ef);
                          return (
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                              <View style={[styles.badge, { backgroundColor: efStyle.bg, borderColor: efStyle.border }]}>
                                <Text style={[styles.badgeText, { color: efStyle.text }]}>{etiquetaEstadoFacturacion(ef)}</Text>
                              </View>
                              {seleccionado.A3FacturaNumero ? (
                                <Text style={styles.detailInfoValue}>Nº {seleccionado.A3FacturaNumero}</Text>
                              ) : null}
                              {seleccionado.FacturacionOrigen ? (
                                <Text style={styles.detailFactOrigen}>
                                  ({seleccionado.FacturacionOrigen === 'a3' ? 'A3' : 'Manual'})
                                </Text>
                              ) : null}
                            </View>
                          );
                        })()}
                        {hasPermiso('acuerdos.editar') ? (
                          <View style={styles.factQuickRow}>
                            {ESTADOS_FACTURACION_ACUERDO.map((e) => {
                              const active = normalizarEstadoFacturacion(seleccionado.EstadoFacturacion) === e;
                              return (
                                <TouchableOpacity
                                  key={e}
                                  style={[styles.factQuickChip, active && styles.factQuickChipActive]}
                                  onPress={() => !active && cambiarEstadoFacturacion(seleccionado.PK, e)}
                                >
                                  <Text style={[styles.factQuickChipText, active && styles.factQuickChipTextActive]}>
                                    {etiquetaEstadoFacturacion(e)}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        ) : null}
                      </View>
                    </View>
                    {seleccionado.Contacto ? (
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>Contacto</Text>
                        <Text style={styles.detailInfoValue}>{seleccionado.Contacto}</Text>
                      </View>
                    ) : null}
                    {seleccionado.Telefono ? (
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>Teléfono</Text>
                        <Text style={styles.detailInfoValue}>{seleccionado.Telefono}</Text>
                      </View>
                    ) : null}
                    {seleccionado.Email ? (
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>Email</Text>
                        <Text style={styles.detailInfoValue}>{seleccionado.Email}</Text>
                      </View>
                    ) : null}
                    <Text style={styles.detailInfoConcat}>
                      {seleccionado.Marca || '—'} ({formatFecha(seleccionado.FechaInicio)} - {formatFecha(seleccionado.FechaFin)})
                    </Text>
                    <View style={styles.detailNotasBlock}>
                      <View style={styles.detailNotasHeader}>
                        <Text style={styles.detailInfoLabel}>Notas</Text>
                        <TouchableOpacity style={styles.detailNotasBtn} onPress={notas.abrir}>
                          <MaterialIcons name="history" size={16} color="#6366f1" />
                          <Text style={styles.detailNotasBtnText}>
                            {notas.resumen.total > 0
                              ? `Ver historial (${notas.resumen.total})`
                              : 'Ver historial'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                      {notas.resumen.total > 0 ? (
                        <Text style={styles.detailNotasPreview} numberOfLines={2}>
                          {notas.resumen.ultimaFecha ? (
                            <Text style={styles.detailNotasPreviewFecha}>{notas.resumen.ultimaFecha} — </Text>
                          ) : null}
                          {notas.resumen.ultimaTexto}
                        </Text>
                      ) : (
                        <Text style={styles.detailNotasEmpty}>Sin notas. Pulsa «Ver historial» para añadir la primera.</Text>
                      )}
                    </View>
                  </View>
                  {/* Columna derecha: donut + totales económicos */}
                  <View style={styles.detailInfoRight}>
                    {totalAcordado > 0 && (
                      <DonutChart
                        porcentaje={Math.round((totalCompradas / totalAcordado) * 1000) / 10}
                        compradas={totalCompradas}
                        acordado={totalAcordado}
                        size={100}
                      />
                    )}
                    <View style={{ flex: 1, gap: 8 }}>
                      <View style={styles.totalCard}>
                        <Text style={styles.totalCardTitle}>Total Acuerdo</Text>
                        <Text style={styles.totalCardValue}>{totalAcuerdo.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        <View style={styles.totalCardSub}>
                          <Text style={styles.totalCardSubLabel}>Aport. Volumen</Text>
                          <Text style={styles.totalCardSubValue}>{aportacionVolumen.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        </View>
                        <View style={styles.totalCardSub}>
                          <Text style={styles.totalCardSubLabel}>Aport. Imagen</Text>
                          <Text style={styles.totalCardSubValue}>{totalImporteImagen.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        </View>
                      </View>
                      <View style={[styles.totalCard, { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' }]}>
                        <Text style={[styles.totalCardTitle, { color: '#16a34a' }]}>Total Acuerdo Generado</Text>
                        <Text style={[styles.totalCardValue, { color: '#16a34a' }]}>{totalAcuerdoGenerado.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        <View style={styles.totalCardSub}>
                          <Text style={styles.totalCardSubLabel}>Aport. Volumen Gen.</Text>
                          <Text style={[styles.totalCardSubValue, { color: '#16a34a' }]}>{aportacionVolumenGenerado.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        </View>
                        <View style={styles.totalCardSub}>
                          <Text style={styles.totalCardSubLabel}>Aport. Imagen Gen.</Text>
                          <Text style={[styles.totalCardSubValue, { color: '#16a34a' }]}>{totalImporteImagenRealizado.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        </View>
                      </View>
                    </View>
                  </View>
                </View>
              </View>

              {/* Sección productos */}
              <View style={styles.detailProductsSection}>
                <View style={styles.detailProductsHeader}>
                  <Text style={styles.detailProductsSectionTitle}>Productos del acuerdo</Text>
                  <TouchableOpacity
                    style={styles.detailAddBtn}
                    onPress={() => {
                      setProdDropdownOpen((o) => {
                        const next = !o;
                        if (next) {
                          setProdSearch('');
                          setProdFocusedIndex(0);
                          setProdPickIds([]);
                        }
                        return next;
                      });
                    }}
                  >
                    <MaterialIcons name="add" size={14} color="#0ea5e9" />
                    <Text style={styles.detailAddBtnText}>Añadir</Text>
                  </TouchableOpacity>
                </View>

                {prodDropdownOpen && (
                  <View style={[styles.productoDropdown, styles.detailProdDropdown, { marginHorizontal: 14, marginBottom: 8 }]}>
                    <View style={[styles.productoDropdownSearch, styles.detailProdDropdownSearch]}>
                      <MaterialIcons name="search" size={14} color="#94a3b8" />
                      <TextInput
                        style={[styles.productoDropdownInput, styles.detailProdDropdownInput]}
                        value={prodSearch}
                        onChangeText={(v) => { setProdSearch(v); setProdFocusedIndex(0); }}
                        placeholder="Buscar producto…"
                        placeholderTextColor="#94a3b8"
                        autoFocus
                        {...(Platform.OS === 'web' ? {
                          onKeyDown: (e: any) => {
                            const list = productosFiltrados;
                            if (list.length === 0) return;
                            const key = e.key;
                            if (key === 'ArrowDown') {
                              e.preventDefault();
                              setProdFocusedIndex((i) => Math.min(i + 1, list.length - 1));
                            } else if (key === 'ArrowUp') {
                              e.preventDefault();
                              setProdFocusedIndex((i) => Math.max(i - 1, 0));
                            } else if (key === 'Enter') {
                              e.preventDefault();
                              const idx = prodFocusedIndex >= 0 && prodFocusedIndex < list.length ? prodFocusedIndex : 0;
                              addProductoDetalle(list[idx]);
                              setProdDropdownOpen(false);
                            }
                          },
                        } : {})}
                      />
                      {prodPickIds.length > 0 ? (
                        <TouchableOpacity
                          style={[styles.detailProdAddSelectedBtn, addingBatchProductos && styles.detailProdAddSelectedBtnDisabled]}
                          onPress={() => { void addProductosSeleccionados(); }}
                          disabled={addingBatchProductos}
                        >
                          {addingBatchProductos ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <Text style={styles.detailProdAddSelectedBtnText}>Añadir ({prodPickIds.length})</Text>
                          )}
                        </TouchableOpacity>
                      ) : null}
                      <TouchableOpacity onPress={() => setProdDropdownOpen(false)}><MaterialIcons name="close" size={14} color="#94a3b8" /></TouchableOpacity>
                    </View>
                    <ScrollView ref={prodListScrollRef} style={[styles.productoDropdownList, styles.detailProdDropdownList]} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                      {loadingProductos ? <ActivityIndicator size="small" color="#0ea5e9" style={{ padding: 8 }} /> : (
                        productosFiltrados.length === 0 ? <Text style={[styles.productoDropdownEmpty, styles.detailProdDropdownEmpty]}>Sin resultados</Text> :
                        productosFiltrados.map((p, i) => {
                          const id = String(valorEnLocal(p, 'Id') ?? '').trim();
                          const name = String(valorEnLocal(p, 'Name') ?? valorEnLocal(p, 'Nombre') ?? id).trim();
                          const picked = prodPickSet.has(id);
                          return (
                            <TouchableOpacity
                              key={id || i}
                              style={[styles.productoDropdownItem, styles.detailProdDropdownItem, styles.detailProdDropdownItemRow]}
                              onPress={() => {
                                setProdPickIds((prev) => {
                                  const s = new Set(prev);
                                  if (s.has(id)) s.delete(id);
                                  else s.add(id);
                                  return [...s];
                                });
                              }}
                              {...(Platform.OS === 'web' ? { title: name } : {})}
                            >
                              <MaterialIcons name={picked ? 'check-box' : 'check-box-outline-blank'} size={18} color={picked ? '#0ea5e9' : '#94a3b8'} />
                              <Text style={[styles.productoDropdownItemText, styles.detailProdDropdownItemText, styles.detailProdDropdownItemLabel]} numberOfLines={1}>{name}</Text>
                            </TouchableOpacity>
                          );
                        })
                      )}
                    </ScrollView>
                  </View>
                )}

                {/* Tabla de productos */}
                {loadingDetalles && detalles.length === 0 ? (
                  <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 20 }} />
                ) : detalles.length === 0 ? (
                  <Text style={styles.detailEmpty}>Sin productos asignados</Text>
                ) : (
                  <ScrollView horizontal style={styles.detailTableScroll} nestedScrollEnabled>
                    <View style={styles.detailTableWrap}>
                      <View style={styles.detailTableHeader}>
                        <Text style={[styles.detailTableHeaderText, { width: 60 }]}>ID</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 140 }]}>Producto</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 70, textAlign: 'center' }]}>Acordado</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 70, textAlign: 'center' }]}>Compradas</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 70, textAlign: 'center' }]}>Restante</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 55, textAlign: 'center' }]}>%</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 80, textAlign: 'center' }]}>P. Compra</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 85, textAlign: 'center' }]}>Total aport.</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 80, textAlign: 'center' }]}>PMR</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 80, textAlign: 'center' }]}>Aportación</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 80, textAlign: 'center' }]}>Rappel</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 80, textAlign: 'center' }]}>Dto. extra</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 100, textAlign: 'center' }]}>Prev. Pago</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 100, textAlign: 'center' }]}>Prev. Confirm.</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 80 }]} />
                      </View>
                      {detalles.map((d) => {
                        const pctColor = d.Porcentaje >= 80 ? '#16a34a' : '#ef4444';
                        return (
                          <View key={d.SK} style={styles.detailTableRow}>
                            <Text style={[styles.detailTableCell, { width: 60, fontSize: 10, color: '#64748b' }]} numberOfLines={1}>{d.ProductId}</Text>
                            <View style={{ width: 140, flexDirection: 'row', alignItems: 'center', gap: 4 }} {...(Platform.OS === 'web' ? { title: String(d.ProductName || d.ProductId || '') } : {})}>
                              <TouchableOpacity onPress={() => abrirComprasProducto(d.ProductId, d.ProductName || d.ProductId)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                                <MaterialIcons name="visibility" size={13} color="#0ea5e9" />
                              </TouchableOpacity>
                              <Text style={[styles.detailTableCell, { flex: 1 }]} numberOfLines={1}>{d.ProductName || d.ProductId}</Text>
                            </View>
                            <View style={{ width: 70, alignItems: 'center' }}>
                              <TextInput
                                style={styles.cantidadInput}
                                value={cantidadEdits[d.ProductId] ?? String(d.Cantidad || 0)}
                                onChangeText={(v) => setCantidadEdits((prev) => ({ ...prev, [d.ProductId]: v }))}
                                onBlur={() => {
                                  if (!seleccionado) return;
                                  const val = parseFloat(cantidadEdits[d.ProductId] || '0') || 0;
                                  actualizarCantidad(d.ProductId, val);
                                  setDetallesPorAcuerdo((prev) => {
                                    const current = prev[seleccionado.PK] || [];
                                    const updated = current.map((x) => x.ProductId === d.ProductId ? { ...x, Cantidad: val, Restante: val - x.Compradas, Porcentaje: val > 0 ? Math.round((x.Compradas / val) * 1000) / 10 : 0 } : x);
                                    const newAcordado = updated.reduce((s, x) => s + (x.Cantidad || 0), 0);
                                    const newCompradas = updated.reduce((s, x) => s + (x.Compradas || 0), 0);
                                    setTotalAcordado(newAcordado);
                                    setTotalCompradas(newCompradas);
                                    setTotalRestante(newAcordado - newCompradas);
                                    const pct = newAcordado > 0 ? Math.round((newCompradas / newAcordado) * 1000) / 10 : 0;
                                    setTotalesPorAcuerdo((p) => ({ ...p, [seleccionado.PK]: { totalAcordado: newAcordado, totalCompradas: newCompradas, porcentaje: pct } }));
                                    return { ...prev, [seleccionado.PK]: updated };
                                  });
                                }}
                                keyboardType="numeric"
                                selectTextOnFocus
                              />
                            </View>
                            <Text style={[styles.detailTableCell, { width: 70, textAlign: 'center', fontWeight: '600' }]}>{(d.Compradas || 0).toLocaleString('es-ES')}</Text>
                            <Text style={[styles.detailTableCell, { width: 70, textAlign: 'center', color: d.Restante > 0 ? '#ef4444' : (d.Restante || 0) < 0 ? '#16a34a' : '#0f172a', fontWeight: (d.Restante || 0) !== 0 ? '600' : '400' }]}>{d.Restante > 0 ? `-${d.Restante.toLocaleString('es-ES')}` : (d.Restante || 0) < 0 ? `+${Math.abs(d.Restante || 0).toLocaleString('es-ES')}` : (d.Restante || 0).toLocaleString('es-ES')}</Text>
                            <Text style={[styles.detailTableCell, { width: 55, textAlign: 'center', fontWeight: '700', color: pctColor }]}>{d.Porcentaje?.toFixed(1)}%</Text>
                            <View style={{ width: 80, alignItems: 'center', justifyContent: 'center' }}>
                              <View style={{ backgroundColor: '#f1f5f9', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                                <Text style={[styles.detailTableCell, { textAlign: 'center', fontWeight: '700', color: '#0f172a' }]}>{formatMoneda(costPriceMap[d.ProductId] || 0)}</Text>
                              </View>
                            </View>
                            <Text style={[styles.detailTableCell, { width: 85, textAlign: 'center', fontWeight: '700', color: '#0f172a' }]}>
                              {((d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0)).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €
                            </Text>
                            {(() => {
                              const totalAport = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0);
                              const costPrice = costPriceMap[d.ProductId] || 0;
                              const pmr = costPrice - totalAport;
                              return <Text style={[styles.detailTableCell, { width: 80, textAlign: 'center', fontWeight: '700', color: '#0d9488' }]}>{formatMoneda(pmr)}</Text>;
                            })()}
                            <View style={{ width: 80, alignItems: 'center' }}>
                              <TextInput
                                style={styles.cantidadInput}
                                value={aportacionEdits[d.ProductId] ?? String(d.Aportacion || 0)}
                                onChangeText={(v) => setAportacionEdits((prev) => ({ ...prev, [d.ProductId]: v }))}
                                onBlur={() => {
                                  if (!seleccionado) return;
                                  const val = parseFloat(aportacionEdits[d.ProductId] || '0') || 0;
                                  actualizarCampoDetalle(d.ProductId, 'Aportacion', val);
                                  setDetallesPorAcuerdo((prev) => ({ ...prev, [seleccionado.PK]: (prev[seleccionado.PK] || []).map((x) => x.ProductId === d.ProductId ? { ...x, Aportacion: val } : x) }));
                                }}
                                keyboardType="numeric"
                                selectTextOnFocus
                              />
                            </View>
                            <View style={{ width: 80, alignItems: 'center' }}>
                              <TextInput
                                style={styles.cantidadInput}
                                value={rappelEdits[d.ProductId] ?? String(d.Rappel || 0)}
                                onChangeText={(v) => setRappelEdits((prev) => ({ ...prev, [d.ProductId]: v }))}
                                onBlur={() => {
                                  if (!seleccionado) return;
                                  const val = parseFloat(rappelEdits[d.ProductId] || '0') || 0;
                                  actualizarCampoDetalle(d.ProductId, 'Rappel', val);
                                  setDetallesPorAcuerdo((prev) => ({ ...prev, [seleccionado.PK]: (prev[seleccionado.PK] || []).map((x) => x.ProductId === d.ProductId ? { ...x, Rappel: val } : x) }));
                                }}
                                keyboardType="numeric"
                                selectTextOnFocus
                              />
                            </View>
                            <View style={{ width: 80, alignItems: 'center' }}>
                              <TextInput
                                style={styles.cantidadInput}
                                value={descuentoEdits[d.ProductId] ?? String(d.DescuentoExtra || 0)}
                                onChangeText={(v) => setDescuentoEdits((prev) => ({ ...prev, [d.ProductId]: v }))}
                                onBlur={() => {
                                  if (!seleccionado) return;
                                  const val = parseFloat(descuentoEdits[d.ProductId] || '0') || 0;
                                  actualizarCampoDetalle(d.ProductId, 'DescuentoExtra', val);
                                  setDetallesPorAcuerdo((prev) => ({ ...prev, [seleccionado.PK]: (prev[seleccionado.PK] || []).map((x) => x.ProductId === d.ProductId ? { ...x, DescuentoExtra: val } : x) }));
                                }}
                                keyboardType="numeric"
                                selectTextOnFocus
                              />
                            </View>
                            {(() => {
                              const totalAport = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0);
                              return (
                                <>
                                  <Text style={[styles.detailTableCell, { width: 100, textAlign: 'center', fontWeight: '600' }]}>
                                    {((d.Cantidad || 0) * totalAport).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €
                                  </Text>
                                  <Text style={[styles.detailTableCell, { width: 100, textAlign: 'center', fontWeight: '600', color: '#16a34a' }]}>
                                    {((d.Compradas || 0) * totalAport).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €
                                  </Text>
                                </>
                              );
                            })()}
                            {Platform.OS === 'web' ? (
                              <WebDeleteBtn
                                productId={d.ProductId}
                                productName={d.ProductName || d.ProductId}
                                onDelete={removeProductoDetalle}
                                onConfirmDelete={confirmDelete}
                              />
                            ) : (
                              <Pressable
                                onPress={() => confirmDelete('Confirmar eliminación', `¿Quieres eliminar el producto "${d.ProductName || d.ProductId}" del acuerdo?`, () => removeProductoDetalle(d.ProductId))}
                                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                                style={({ pressed }) => ({
                                  width: 32, minWidth: 32, height: 32, alignItems: 'center', justifyContent: 'center', padding: 4,
                                  opacity: pressed ? 0.6 : 1,
                                })}
                              >
                                <MaterialIcons name="close" size={14} color="#ef4444" />
                              </Pressable>
                            )}
                          </View>
                        );
                      })}
                    </View>
                  </ScrollView>
                )}

                {/* Resumen */}
                {detalles.length > 0 && (
                  <View style={styles.detailResumen}>
                    <View style={styles.detailResumenRow}>
                      <Text style={styles.detailResumenLabel}>Productos asignados</Text>
                      <Text style={styles.detailResumenValue}>{detalles.length}</Text>
                    </View>
                    <View style={styles.detailResumenRow}>
                      <Text style={styles.detailResumenLabel}>Total acordado</Text>
                      <Text style={styles.detailResumenValue}>{totalAcordado.toLocaleString('es-ES')} uds.</Text>
                    </View>
                    <View style={styles.detailResumenRow}>
                      <Text style={styles.detailResumenLabel}>Total compradas</Text>
                      <Text style={[styles.detailResumenValue, { color: '#16a34a' }]}>{totalCompradas.toLocaleString('es-ES')} uds.</Text>
                    </View>
                    <View style={styles.detailResumenRow}>
                      <Text style={styles.detailResumenLabel}>Total restante</Text>
                      <Text style={[styles.detailResumenValue, { color: totalRestante > 0 ? '#ef4444' : totalRestante < 0 ? '#16a34a' : '#0f172a' }]}>{totalRestante > 0 ? `-${totalRestante.toLocaleString('es-ES')}` : totalRestante < 0 ? `+${Math.abs(totalRestante).toLocaleString('es-ES')}` : totalRestante.toLocaleString('es-ES')} uds.</Text>
                    </View>
                  </View>
                )}
              </View>

              {/* Sección Pagos por Imagen */}
              <View style={styles.detailProductsSection}>
                <View style={styles.detailProductsHeader}>
                  <Text style={styles.detailProductsSectionTitle}>Pagos por imagen</Text>
                  <TouchableOpacity style={styles.detailAddBtn} onPress={() => pago.abrirNuevo()}>
                    <MaterialIcons name="add" size={14} color="#0ea5e9" />
                    <Text style={styles.detailAddBtnText}>Añadir</Text>
                  </TouchableOpacity>
                </View>

                {pago.loadingPagos ? (
                  <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 12 }} />
                ) : pago.pagosImagen.length === 0 ? (
                  <Text style={styles.detailEmpty}>Sin pagos por imagen registrados</Text>
                ) : (
                  <View style={{ gap: 8, marginTop: 8 }}>
                    {pago.pagosImagen.map((p) => (
                      <View key={p.SK} style={styles.imgCard}>
                        {/* Línea 1: Acciones | Importe | Realizado | Botones */}
                        <View style={styles.imgCardLine1}>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, flex: 1 }}>
                            {p.Acciones.map((ac) => (
                              <View key={ac} style={styles.imgAccionBadge}>
                                <Text style={styles.imgAccionBadgeText}>{ac}</Text>
                              </View>
                            ))}
                          </View>
                          <Text style={styles.imgCardImporte}>{(p.Importe || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                          <TouchableOpacity
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 8 }}
                            onPress={() => pago.marcarRealizado(p.SK, !p.Realizado)}
                          >
                            <MaterialIcons name={p.Realizado ? 'check-box' : 'check-box-outline-blank'} size={18} color={p.Realizado ? '#16a34a' : '#94a3b8'} />
                            <Text style={{ fontSize: 11, color: p.Realizado ? '#16a34a' : '#94a3b8', fontWeight: '600' }}>Realizado</Text>
                          </TouchableOpacity>
                          <View style={{ flexDirection: 'row', gap: 4, marginLeft: 8 }}>
                            <TouchableOpacity onPress={() => pago.abrirEditar(p)} style={{ padding: 4 }}>
                              <MaterialIcons name="edit" size={14} color="#64748b" />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => pago.eliminar(p.SK)} style={{ padding: 4 }}>
                              <MaterialIcons name="delete-outline" size={14} color="#ef4444" />
                            </TouchableOpacity>
                          </View>
                        </View>
                        {/* Línea 2: Locales */}
                        {p.Locales.length > 0 && (
                          <Text style={styles.imgCardLocales} numberOfLines={2}>{p.Locales.map((id) => pago.localNombre(id)).join(', ')}</Text>
                        )}
                        {/* Línea 3: Descripción */}
                        {p.Descripcion ? (
                          <Text style={styles.imgCardDesc}>{p.Descripcion}</Text>
                        ) : null}
                        {p.Justificantes && p.Justificantes.length > 0 && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            <MaterialIcons name="attach-file" size={12} color="#64748b" />
                            <Text style={styles.imgCardLabel}>{p.Justificantes.length} archivo(s)</Text>
                          </View>
                        )}
                      </View>
                    ))}
                    <View style={styles.detailResumen}>
                      <View style={styles.detailResumenRow}>
                        <Text style={styles.detailResumenLabel}>Total imagen</Text>
                        <Text style={[styles.detailResumenValue, { color: '#0ea5e9' }]}>{totalImporteImagen.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                      </View>
                    </View>
                  </View>
                )}
              </View>

              {/* Sección Documentos */}
              <View style={styles.detailProductsSection}>
                <View style={styles.detailProductsHeader}>
                  <Text style={styles.detailProductsSectionTitle}>Documentos</Text>
                  <TouchableOpacity style={styles.detailAddBtn} onPress={subirArchivo} disabled={subiendoArchivo}>
                    {subiendoArchivo ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <>
                        <MaterialIcons name="upload-file" size={14} color="#0ea5e9" />
                        <Text style={styles.detailAddBtnText}>Subir archivo</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                {loadingArchivos ? (
                  <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 12 }} />
                ) : archivos.length === 0 ? (
                  <Text style={styles.detailEmpty}>Sin documentos adjuntos</Text>
                ) : (
                  <View style={{ gap: 6, marginTop: 8 }}>
                    {archivos.map((f) => {
                      const isImage = /^image\//i.test(f.contentType || '');
                      const isPdf = /\/pdf$/i.test(f.contentType || '');
                      const sizeKB = f.size ? (f.size / 1024).toFixed(1) : '?';
                      return (
                        <View key={f.fileKey} style={styles.fileCard}>
                          {isImage && f.url && (
                            <TouchableOpacity onPress={() => { if (Platform.OS === 'web') window.open(f.url!, '_blank'); }}>
                              <img src={f.url} alt={f.fileName} style={{ width: 120, height: 80, objectFit: 'cover', borderRadius: 6, marginBottom: 4 } as any} />
                            </TouchableOpacity>
                          )}
                          <View style={styles.fileCardRow}>
                            <MaterialIcons name={isImage ? 'image' : isPdf ? 'picture-as-pdf' : 'insert-drive-file'} size={18} color={isImage ? '#0ea5e9' : isPdf ? '#ef4444' : '#64748b'} />
                            <View style={{ flex: 1, marginLeft: 6 }}>
                              <Text style={styles.fileCardName} numberOfLines={1}>{f.fileName}</Text>
                              <Text style={styles.fileCardMeta}>{sizeKB} KB · {f.uploadedAt ? new Date(f.uploadedAt).toLocaleDateString('es-ES') : ''}</Text>
                            </View>
                            <TouchableOpacity onPress={() => { if (Platform.OS === 'web' && f.url) window.open(f.url, '_blank'); }} style={{ padding: 4 }}>
                              <MaterialIcons name="open-in-new" size={16} color="#0ea5e9" />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => eliminarArchivo(f.fileKey)} style={{ padding: 4 }}>
                              <MaterialIcons name="delete-outline" size={16} color="#ef4444" />
                            </TouchableOpacity>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            </ScrollView>
          </View>
        )}
      </View>

      <AcuerdoPagoModal pago={pago} isCompact={isCompact} />

      <AcuerdoFormModal formAcuerdo={formAcuerdo} isCompact={isCompact} />

      {comprasModalProduct && (
        <ComprasProveedorModal
          visible={comprasModalVisible}
          onClose={() => { setComprasModalVisible(false); setComprasModalProduct(null); }}
          productName={comprasModalProduct.name}
          productId={comprasModalProduct.id}
          fechaInicio={seleccionado?.FechaInicio || ''}
          fechaFin={seleccionado?.FechaFin || ''}
        />
      )}

      <AcuerdoNotasModal
        notas={notas}
        seleccionado={seleccionado}
        puedeEditar={hasPermiso('acuerdos.editar')}
      />

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  splitContainer: { flex: 1, flexDirection: 'row' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', gap: 12 },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: '#0f172a' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  productosActivosBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#99f6e4',
    backgroundColor: '#f0fdfa',
  },
  productosActivosBtnText: { fontSize: 12, fontWeight: '600', color: '#0f766e' },
  informeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd6fe',
    backgroundColor: '#f5f3ff',
  },
  informeBtnText: { fontSize: 12, fontWeight: '600', color: '#7c3aed' },
  productosAgoraBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
  },
  productosAgoraBtnText: { fontSize: 12, fontWeight: '600', color: '#0369a1' },
  createBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: '#0ea5e9' },
  createBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  errorBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 16, marginTop: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fecaca' },
  errorText: { fontSize: 12, color: '#dc2626', flex: 1 },
  list: { flex: 1 },
  resumenBar: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  resumenBarText: { fontSize: 12, color: '#64748b', fontWeight: '500' },
  resumenAlerta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fcd34d',
    alignSelf: 'flex-start',
  },
  resumenAlertaText: { fontSize: 12, color: '#b45309', fontWeight: '600' },
  filtroFactScroll: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  filtroFactRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8 },
  filtroFactChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#fff' },
  filtroFactChipActive: { backgroundColor: '#1e40af', borderColor: '#1e40af' },
  filtroEstadoChipActive: { backgroundColor: '#16a34a', borderColor: '#16a34a' },
  filtroEstadoChipAlerta: { borderColor: '#fca5a5', backgroundColor: '#fef2f2' },
  filtroFactChipText: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  filtroFactChipTextActive: { color: '#fff' },
  listContent: { padding: 16, gap: 12 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },

  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  cardSelected: { borderColor: '#0ea5e9', borderWidth: 2 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a', flexShrink: 1 },
  cardIdBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    flexShrink: 0,
  },
  cardIdBadgeText: { fontSize: 10, fontWeight: '700', color: '#64748b', fontFamily: Platform.select({ web: 'ui-monospace, monospace', default: 'monospace' }) },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  cardActions: { flexDirection: 'row', gap: 4 },
  cardActionBtn: { padding: 6 },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  cardBodyWithDonut: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  cardBodyInfo: { flex: 1, gap: 6 },
  miniDonutPlaceholder: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  cardField: { minWidth: 120, marginRight: 16 },
  cardFieldLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 2 },
  cardFieldValue: { fontSize: 13, color: '#334155' },
  cardCountdown: { fontWeight: '600' },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  modal: { backgroundColor: '#fff', borderRadius: 14, width: '90%', maxWidth: 560, maxHeight: '90%', padding: 20 },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a', marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 4, marginTop: 10 },
  input: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: '#334155' },
  inputReadonly: { backgroundColor: '#e2e8f0', color: '#64748b' },
  inputValueText: { fontSize: 14, color: '#334155' },
  inputPlaceholderText: { fontSize: 14, color: '#94a3b8' },
  inputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  row2: { flexDirection: 'row', gap: 10 },
  row2col: { flex: 1 },
  estadoRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  estadoChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  estadoChipActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  estadoChipText: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  estadoChipTextActive: { color: '#fff' },

  productoDropdown: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, marginTop: 4, maxHeight: 220, overflow: 'hidden' },
  productoDropdownSearch: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  productoDropdownInput: { flex: 1, fontSize: 13, color: '#334155', outlineStyle: 'none' as any },
  productoDropdownList: { maxHeight: 170 },
  productoDropdownEmpty: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', padding: 12, textAlign: 'center' },
  productoDropdownItem: { paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#f1f5f9', flexDirection: 'row', alignItems: 'center' },
  detailProdDropdown: { maxHeight: 160 },
  detailProdDropdownSearch: { paddingVertical: 4, paddingHorizontal: 8 },
  detailProdDropdownInput: { fontSize: 11 },
  detailProdDropdownList: { maxHeight: 120 },
  detailProdDropdownEmpty: { fontSize: 11, padding: 8 },
  detailProdDropdownItem: { paddingVertical: 5, paddingHorizontal: 8 },
  detailProdDropdownItemText: { fontSize: 11 },
  detailProdAddSelectedBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: '#0ea5e9',
    flexShrink: 0,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailProdAddSelectedBtnDisabled: { opacity: 0.55 },
  detailProdAddSelectedBtnText: { fontSize: 10, fontWeight: '700', color: '#fff' },
  detailProdDropdownItemRow: { gap: 6 },
  detailProdDropdownItemLabel: { flex: 1, minWidth: 0 },
  productoDropdownItemDisabled: { opacity: 0.4 },
  productoDropdownItemText: { fontSize: 13, color: '#334155', flex: 1 },

  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
  cancelBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#f1f5f9' },
  cancelBtnText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#0ea5e9' },
  saveBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },


  detailPanel: { flex: 3, backgroundColor: '#fff', borderLeftWidth: 1, borderLeftColor: '#e2e8f0' },
  detailPanelCompact: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 400, zIndex: 50, shadowColor: '#000', shadowOffset: { width: -2, height: 0 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 8 },
  detailPanelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  detailPanelTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  detailPanelCountdown: { fontSize: 12, color: '#64748b', marginTop: 2 },
  detailInfoSection: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  detailInfoColumns: { flexDirection: 'row', gap: 16 },
  detailInfoLeft: { flex: 1, minWidth: 200 },
  detailInfoRight: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  detailInfoRow: { flexDirection: 'row', marginBottom: 6 },
  detailInfoLabel: { width: 70, fontSize: 11, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', paddingTop: 2 },
  detailNotasBlock: {
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 8,
  },
  detailNotasHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  detailNotasBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: '#eef2ff',
  },
  detailNotasBtnText: { fontSize: 12, fontWeight: '600', color: '#6366f1' },
  detailNotasPreview: { fontSize: 12, color: '#475569', lineHeight: 18 },
  detailNotasPreviewFecha: { color: '#2563eb', fontWeight: '700', fontStyle: 'italic' },
  detailNotasEmpty: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  detailInfoValue: { flex: 1, fontSize: 13, color: '#334155' },
  detailFactOrigen: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  factQuickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 },
  factQuickChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  factQuickChipActive: { backgroundColor: '#1e40af', borderColor: '#1e40af' },
  factQuickChipText: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  factQuickChipTextActive: { color: '#fff' },
  detailInfoConcat: { fontSize: 12, fontStyle: 'italic', color: '#64748b', marginTop: 6, marginBottom: 10 },
  totalCard: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, padding: 8 },
  totalCardTitle: { fontSize: 9, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: 1 },
  totalCardValue: { fontSize: 15, fontWeight: '800', color: '#0f172a', marginBottom: 4 },
  totalCardSub: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  totalCardSubLabel: { fontSize: 11, color: '#94a3b8' },
  totalCardSubValue: { fontSize: 11, fontWeight: '600', color: '#334155' },
  detailProductsSection: { paddingBottom: 14 },
  detailProductsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10 },
  detailProductsSectionTitle: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  detailAddBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: '#0ea5e9', borderStyle: 'dashed' },
  detailAddBtnText: { fontSize: 11, color: '#0ea5e9', fontWeight: '600' },
  detailEmpty: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', textAlign: 'center', marginTop: 24, paddingHorizontal: 14 },
  detailTableScroll: { marginHorizontal: 14 },
  detailTableWrap: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', minWidth: 1178 },
  detailTableHeader: { flexDirection: 'row', backgroundColor: '#f8fafc', paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  detailTableHeaderText: { fontSize: 9, fontWeight: '700', color: '#475569', textTransform: 'uppercase' },
  detailTableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  detailTableCell: { fontSize: 10, color: '#334155' },
  cantidadInput: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, fontSize: 11, color: '#334155', textAlign: 'center', width: 70 },
  detailResumen: { marginHorizontal: 14, marginTop: 12, backgroundColor: '#f0f9ff', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: '#bae6fd' },
  detailResumenRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  detailResumenLabel: { fontSize: 12, color: '#0369a1', fontWeight: '500' },
  detailResumenValue: { fontSize: 14, color: '#0f172a', fontWeight: '700' },
  imgCard: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, padding: 10 },
  imgCardLine1: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  imgCardLocales: { fontSize: 12, color: '#334155', marginBottom: 2 },
  imgCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  imgCardImporte: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  imgCardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 4 },
  imgCardLabel: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  imgCardValue: { fontSize: 12, color: '#334155', flex: 1 },
  imgCardDesc: { fontSize: 12, color: '#475569', fontStyle: 'italic', marginTop: 4 },
  imgAccionBadge: { backgroundColor: '#e0f2fe', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  imgAccionBadgeText: { fontSize: 10, color: '#0369a1', fontWeight: '600' },
  fileCard: { backgroundColor: '#f8fafc', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0', padding: 8 },
  fileCardRow: { flexDirection: 'row', alignItems: 'center' },
  fileCardName: { fontSize: 12, fontWeight: '600', color: '#1e293b' },
  fileCardMeta: { fontSize: 10, color: '#94a3b8', marginTop: 1 },
});
