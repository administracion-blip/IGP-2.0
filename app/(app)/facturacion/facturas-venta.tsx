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
  Pressable,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import {
  formatMoneda,
  labelEstado,
  FORMAS_PAGO,
  labelFormaPago,
  mapTipoReciboToFormaPago,
  resolveMetodoPagoParaEnvio,
} from '../../utils/facturacion';
import { fechaEmisionFacturaADmy, fechaEmisionFacturaAIso } from '../../utils/formatFecha';
import { getTipoReciboFromEmpresasList, type EmpresaConTipoRecibo } from '../../utils/empresaTipoRecibo';
import { BadgeEstado } from '../../components/BadgeEstado';
import { InputFecha } from '../../components/InputFecha';
import { useLocalToast } from '../../components/Toast';
import { ModalDetallePagosTabla } from '../../components/ModalDetallePagosTabla';
import { FacturaVentaDetallePanel } from '../../components/FacturaVentaDetallePanel';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

/** Fecha emisión factura (varios formatos BD) → dd/mm/aaaa para tabla */
function fechaEmisionCelda(raw: string | undefined): string {
  if (!raw?.trim()) return '—';
  const iso = fechaEmisionFacturaAIso(raw.trim());
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function dmyToIso(dmy: string): string {
  if (!dmy) return '';
  const m = dmy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dmy)) return dmy;
  return '';
}

function hoyDmy(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/** Evita que el click del icono dispare la selección de fila (p. ej. en web). */
function absorberClickFila(e: { stopPropagation?: () => void; nativeEvent?: { stopPropagation?: () => void } }) {
  if (typeof e.stopPropagation === 'function') e.stopPropagation();
  const ne = e.nativeEvent;
  if (ne && typeof ne.stopPropagation === 'function') ne.stopPropagation();
}

const PAGE_SIZE = 50;
const MIN_COL_WIDTH = 60;

/** Clave estable para filtrar por emisor (id o nombre si no hay id). */
function getEmisorKey(f: { emisor_id?: string; emisor_nombre?: string }): string {
  const id = String(f.emisor_id || '').trim();
  if (id) return id;
  const n = String(f.emisor_nombre || '').trim();
  return n ? `nom:${n}` : '';
}

type Factura = {
  id_factura: string;
  numero_factura: string;
  fecha_emision: string;
  emisor_id?: string;
  emisor_nombre: string;
  empresa_nombre: string;
  empresa_cif: string;
  empresa_id?: string;
  base_imponible: number;
  total_iva: number;
  total_retencion?: number;
  total_factura: number;
  estado: string;
  total_cobrado?: number;
  saldo_pendiente: number;
  impuestos_resumen?: string;
};

const COLUMNAS = [
  { key: 'fecha_emision', label: 'Fecha' },
  { key: 'numero_factura', label: 'Nº Factura' },
  { key: 'emisor_nombre', label: 'Emisor' },
  { key: 'empresa_nombre', label: 'Receptor' },
  { key: 'total_factura', label: 'Total' },
  { key: 'estado', label: 'Estado' },
  { key: 'id_factura', label: 'ID' },
  { key: 'impuestos_resumen', label: 'Impuestos' },
  { key: 'base_imponible', label: 'Base imp.' },
  { key: 'total_iva', label: 'IVA' },
  { key: 'total_retencion', label: 'Retención' },
  { key: 'pagado', label: 'Pagado' },
  { key: 'saldo_pendiente', label: 'Saldo pte.' },
] as const;

const DEFAULT_WIDTHS: Record<string, number> = {
  fecha_emision: 82,
  numero_factura: 116,
  emisor_nombre: 132,
  empresa_nombre: 132,
  total_factura: 82,
  estado: 100,
  id_factura: 82,
  impuestos_resumen: 100,
  base_imponible: 82,
  total_iva: 74,
  total_retencion: 74,
  pagado: 100,
  saldo_pendiente: 92,
};

const TABS_ESTADO = [
  { key: '', label: 'Todas' },
  { key: 'borrador', label: 'Borrador' },
  { key: 'emitida', label: 'Emitida' },
  { key: 'parcialmente_cobrada', label: 'Parcial cobrada' },
  { key: 'cobrada', label: 'Cobrada' },
  { key: 'vencida', label: 'Vencida' },
  { key: 'anulada', label: 'Anulada' },
] as const;

export default function FacturasVentaScreen() {
  const router = useRouter();
  const { hasPermiso, user } = useAuth();
  const { width: winW } = useWindowDimensions();
  const layoutSplit = Platform.OS === 'web' && winW >= 1024;

  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [filtroEstado, setFiltroEstado] = useState('');
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ ...DEFAULT_WIDTHS });
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [operando, setOperando] = useState(false);
  const [sortCol, setSortCol] = useState<string>('fecha_emision');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filtroEmisorId, setFiltroEmisorId] = useState('');
  const [emisorModalOpen, setEmisorModalOpen] = useState(false);

  const [modalAnularVisible, setModalAnularVisible] = useState(false);
  const [modalCobrarVisible, setModalCobrarVisible] = useState(false);
  const [cobroImporte, setCobroImporte] = useState('');
  const [cobroFecha, setCobroFecha] = useState('');
  const [cobroMetodo, setCobroMetodo] = useState<string>('transferencia');
  const [cobroMetodoOtro, setCobroMetodoOtro] = useState('');
  const [cobroFechaEditadaManual, setCobroFechaEditadaManual] = useState(false);
  const [cobroMetodoDropdownOpen, setCobroMetodoDropdownOpen] = useState(false);
  const [cobroReferencia, setCobroReferencia] = useState('');
  const [errorModal, setErrorModal] = useState<string | null>(null);
  const [haySeries, setHaySeries] = useState(true);
  const [empresasCatalogo, setEmpresasCatalogo] = useState<EmpresaConTipoRecibo[]>([]);

  const [modalDetallePagosVisible, setModalDetallePagosVisible] = useState(false);
  const [detallePagosLoading, setDetallePagosLoading] = useState(false);
  const [detallePagosError, setDetallePagosError] = useState<string | null>(null);
  const [detallePagosLista, setDetallePagosLista] = useState<Record<string, unknown>[]>([]);
  const [detallePagosFactura, setDetallePagosFactura] = useState<Factura | null>(null);

  const { show: showToast, ToastView } = useLocalToast();

  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/facturacion/series`)
      .then((r) => r.json())
      .then((d) => {
        const all = d.series ?? d ?? [];
        setHaySeries(all.some((s: any) => s.tipo === 'OUT'));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`${API_URL}/api/empresas`)
      .then((r) => r.json())
      .then((d) => {
        const raw: unknown[] = d.empresas ?? d ?? [];
        setEmpresasCatalogo(
          raw.map((e: any) => ({
            id_empresa: e.id_empresa ?? '',
            tipoRecibo: e['Tipo de recibo'] != null ? String(e['Tipo de recibo']).trim() : undefined,
            'Tipo de recibo': e['Tipo de recibo'],
          })),
        );
      })
      .catch(() => {});
  }, []);

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    fetch(`${API_URL}/api/facturacion/facturas?tipo=OUT`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setFacturas(data.facturas || []);
      })
      .catch((e) => setError(e?.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  const emisoresOpciones = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of facturas) {
      const key = getEmisorKey(f);
      if (!key) continue;
      const label = String(f.emisor_nombre || '').trim() || key;
      if (!m.has(key)) m.set(key, label);
    }
    return [...m.entries()]
      .map(([id, nombre]) => ({ id, nombre }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }, [facturas]);

  const toggleSort = useCallback((col: string) => {
    if (sortCol === col) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }, [sortCol]);

  const facturasFiltradas = useMemo(() => {
    let resultado = facturas;
    if (filtroEmisorId) {
      resultado = resultado.filter((f) => getEmisorKey(f) === filtroEmisorId);
    }
    if (filtroEstado) resultado = resultado.filter((f) => f.estado === filtroEstado);
    if (filtroBusqueda.trim()) {
      const q = filtroBusqueda.trim().toLowerCase();
      resultado = resultado.filter(
        (f) =>
          (f.numero_factura || '').toLowerCase().includes(q) ||
          (f.emisor_nombre || '').toLowerCase().includes(q) ||
          (f.empresa_nombre || '').toLowerCase().includes(q) ||
          (f.empresa_cif || '').toLowerCase().includes(q)
      );
    }
    const isoDesde = dmyToIso(fechaDesde);
    const isoHasta = dmyToIso(fechaHasta);
    if (isoDesde) resultado = resultado.filter((f) => f.fecha_emision >= isoDesde);
    if (isoHasta) resultado = resultado.filter((f) => f.fecha_emision <= isoHasta);

    if (sortCol) {
      resultado = [...resultado].sort((a, b) => {
        if (sortCol === 'pagado') {
          const na = Number((a as Factura).total_cobrado ?? 0);
          const nb = Number((b as Factura).total_cobrado ?? 0);
          const cmp = na - nb;
          return sortDir === 'desc' ? -cmp : cmp;
        }
        const va = (a as any)[sortCol] ?? '';
        const vb = (b as any)[sortCol] ?? '';
        const numA = typeof va === 'number' ? va : parseFloat(va);
        const numB = typeof vb === 'number' ? vb : parseFloat(vb);
        let cmp: number;
        if (!isNaN(numA) && !isNaN(numB)) cmp = numA - numB;
        else cmp = String(va).localeCompare(String(vb), 'es', { sensitivity: 'base' });
        return sortDir === 'desc' ? -cmp : cmp;
      });
    }
    return resultado;
  }, [facturas, filtroEmisorId, filtroEstado, filtroBusqueda, fechaDesde, fechaHasta, sortCol, sortDir]);

  const totalRegistros = facturasFiltradas.length;
  const totalPages = Math.max(1, Math.ceil(totalRegistros / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const facturasPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return facturasFiltradas.slice(start, start + PAGE_SIZE);
  }, [facturasFiltradas, pageIndexClamped]);

  useEffect(() => {
    setPageIndex((p) => (p >= totalPages ? Math.max(0, totalPages - 1) : p));
  }, [totalPages]);

  useEffect(() => {
    setPageIndex(0);
    setSelectedId(null);
  }, [filtroBusqueda, filtroEstado, fechaDesde, fechaHasta, filtroEmisorId]);

  const goPrevPage = () => { setPageIndex((p) => Math.max(0, p - 1)); setSelectedId(null); };
  const goNextPage = () => { setPageIndex((p) => Math.min(totalPages - 1, p + 1)); setSelectedId(null); };

  const selectedFactura = useMemo(
    () => (selectedId ? facturasPagina.find((f) => f.id_factura === selectedId) ?? null : null),
    [selectedId, facturasPagina]
  );

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? 120, [columnWidths]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !resizingCol) return;
    const handleMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const delta = e.clientX - r.startX;
      const next = Math.max(MIN_COL_WIDTH, r.startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [r.col]: next }));
    };
    const handleUp = () => { resizeRef.current = null; setResizingCol(null); };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => { document.removeEventListener('mousemove', handleMove); document.removeEventListener('mouseup', handleUp); };
  }, [resizingCol]);

  const handleResizeStart = (col: string, e: { nativeEvent?: { clientX: number }; clientX?: number }) => {
    if (Platform.OS !== 'web') return;
    const clientX = e.nativeEvent?.clientX ?? (e as { clientX: number }).clientX ?? 0;
    resizeRef.current = { col, startX: clientX, startWidth: getColWidth(col) };
    setResizingCol(col);
  };

  const handleCrear = () => {
    if (!haySeries) {
      showToast('Sin series', 'No hay series de facturación configuradas para ventas. Ve a Facturación > Series para crear al menos una serie de tipo OUT.', 'warning');
      return;
    }
    router.push('/facturacion/factura-detalle?tipo=OUT&modo=crear' as any);
  };
  const handleEditar = () => {
    if (!selectedId) return;
    router.push(`/facturacion/factura-detalle?id=${selectedId}&modo=editar` as any);
  };

  const handleDuplicar = async () => {
    if (!selectedId) return;
    setOperando(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedId}/duplicar`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Error al duplicar'); return; }
      refetch();
      setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setOperando(false);
    }
  };

  const handleEmitir = async () => {
    if (!selectedId) return;
    setOperando(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedId}/emitir`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Error al emitir'); return; }
      refetch();
      setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setOperando(false);
    }
  };

  const abrirModalAnular = () => { if (!selectedId) return; setErrorModal(null); setModalAnularVisible(true); };
  const confirmarAnular = async () => {
    if (!selectedId) return;
    setOperando(true);
    setErrorModal(null);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedId}/anular`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setErrorModal(data.error || 'Error al anular'); setOperando(false); return; }
      setModalAnularVisible(false);
      refetch();
      setSelectedId(null);
    } catch (e) {
      setErrorModal(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setOperando(false);
    }
  };

  const abrirModalCobrar = () => {
    if (!selectedFactura) return;
    setErrorModal(null);
    setCobroMetodoDropdownOpen(false);
    setCobroFechaEditadaManual(false);
    setCobroImporte(selectedFactura.saldo_pendiente > 0 ? String(selectedFactura.saldo_pendiente) : '');
    setCobroReferencia('');

    const tipoRecibo = getTipoReciboFromEmpresasList(empresasCatalogo, selectedFactura.empresa_id);
    const { clave, otroTexto } = mapTipoReciboToFormaPago(tipoRecibo);
    setCobroMetodo(clave);
    setCobroMetodoOtro(clave === 'otro' ? otroTexto : '');

    const hoy = hoyDmy();
    const fechaFactura = fechaEmisionFacturaADmy(selectedFactura.fecha_emision, hoy);
    setCobroFecha(clave === 'tarjeta' ? fechaFactura : hoy);

    setModalCobrarVisible(true);
  };

  const aplicarFechaSegunMetodo = (metodo: string, fechaFacturaDmy: string, hoy: string) => {
    if (metodo === 'tarjeta') return fechaFacturaDmy;
    return hoy;
  };

  const onCambiarMetodoCobro = (m: string) => {
    setCobroMetodo(m);
    setCobroMetodoDropdownOpen(false);
    if (m !== 'otro') setCobroMetodoOtro('');
    if (!selectedFactura || cobroFechaEditadaManual) return;
    const hoy = hoyDmy();
    const fechaFactura = fechaEmisionFacturaADmy(selectedFactura.fecha_emision, hoy);
    setCobroFecha(aplicarFechaSegunMetodo(m, fechaFactura, hoy));
  };

  const abrirModalDetallePagos = useCallback((factura: Factura) => {
    setDetallePagosFactura(factura);
    setModalDetallePagosVisible(true);
    setDetallePagosLoading(true);
    setDetallePagosError(null);
    setDetallePagosLista([]);
    fetch(`${API_URL}/api/facturacion/facturas/${factura.id_factura}/pagos`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Error al cargar cobros');
        setDetallePagosLista(Array.isArray(data.pagos) ? data.pagos : []);
      })
      .catch((err) => setDetallePagosError(err instanceof Error ? err.message : 'Error de conexión'))
      .finally(() => setDetallePagosLoading(false));
  }, []);

  const cerrarModalDetallePagos = useCallback(() => {
    setModalDetallePagosVisible(false);
    setDetallePagosFactura(null);
    setDetallePagosError(null);
    setDetallePagosLista([]);
  }, []);

  const confirmarCobro = async () => {
    if (!selectedId) return;
    const importe = parseFloat(cobroImporte);
    if (isNaN(importe) || importe <= 0) { setErrorModal('El importe debe ser mayor que 0'); return; }
    const fechaIso = dmyToIso(cobroFecha);
    if (!fechaIso) { setErrorModal('Indica una fecha válida'); return; }
    const metodoEnvio = resolveMetodoPagoParaEnvio(cobroMetodo, cobroMetodoOtro);
    if (metodoEnvio == null) {
      setErrorModal('Describe el método de pago (campo obligatorio si eliges «Otro»)');
      return;
    }
    setOperando(true);
    setErrorModal(null);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedId}/pagos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fecha: fechaIso,
          importe,
          metodo_pago: metodoEnvio,
          referencia: cobroReferencia.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setErrorModal(data.error || 'Error al registrar cobro'); setOperando(false); return; }
      setModalCobrarVisible(false);
      refetch();
      setSelectedId(null);
    } catch (e) {
      setErrorModal(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setOperando(false);
    }
  };

  const toolbarBtns: { id: string; label: string; icon: React.ComponentProps<typeof MaterialIcons>['name']; permiso: string; needsSelection: boolean }[] = [
    { id: 'crear', label: 'Crear', icon: 'add-circle-outline', permiso: 'facturacion.crear', needsSelection: false },
    { id: 'editar', label: 'Editar', icon: 'edit', permiso: 'facturacion.editar', needsSelection: true },
    { id: 'duplicar', label: 'Duplicar', icon: 'content-copy', permiso: 'facturacion.crear', needsSelection: true },
    { id: 'emitir', label: 'Emitir', icon: 'send', permiso: 'facturacion.emitir', needsSelection: true },
    { id: 'anular', label: 'Anular', icon: 'block', permiso: 'facturacion.anular', needsSelection: true },
    { id: 'cobrar', label: 'Cobrar', icon: 'payments', permiso: 'facturacion.cobrar_pagar', needsSelection: true },
  ];

  const handleToolbarPress = (id: string) => {
    if (id === 'crear') handleCrear();
    else if (id === 'editar') handleEditar();
    else if (id === 'duplicar') handleDuplicar();
    else if (id === 'emitir') handleEmitir();
    else if (id === 'anular') abrirModalAnular();
    else if (id === 'cobrar') abrirModalCobrar();
  };

  const valorCelda = useCallback((item: Factura, col: string): string => {
    switch (col) {
      case 'id_factura': return (item.id_factura || '').substring(0, 8) + '…';
      case 'numero_factura': return item.numero_factura || '—';
      case 'fecha_emision': return fechaEmisionCelda(item.fecha_emision);
      case 'emisor_nombre': return item.emisor_nombre || '—';
      case 'empresa_nombre': return item.empresa_nombre || '—';
      case 'impuestos_resumen': return (item.impuestos_resumen || '').trim() || '—';
      case 'base_imponible': return formatMoneda(item.base_imponible ?? 0);
      case 'total_iva': return formatMoneda(item.total_iva ?? 0);
      case 'total_retencion': return formatMoneda(Number(item.total_retencion ?? 0));
      case 'total_factura': return formatMoneda(item.total_factura ?? 0);
      case 'pagado': return formatMoneda(Number(item.total_cobrado ?? 0));
      case 'saldo_pendiente': return formatMoneda(item.saldo_pendiente ?? 0);
      case 'estado': return labelEstado(item.estado);
      default: return '—';
    }
  }, []);

  if (loading && facturas.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando facturas…</Text>
      </View>
    );
  }

  if (error && facturas.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.push('/facturacion' as any)} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <Text style={styles.title}>Facturas emitidas</Text>
        </View>
        <View style={styles.center}>
          <MaterialIcons name="error-outline" size={48} color="#f87171" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/facturacion' as any)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Facturas emitidas</Text>
      </View>

      {/* Tabs de estado */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabsContent}>
        {TABS_ESTADO.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, filtroEstado === tab.key && styles.tabActive]}
            onPress={() => setFiltroEstado(tab.key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, filtroEstado === tab.key && styles.tabTextActive]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {emisoresOpciones.length > 0 ? (
        <TouchableOpacity
          style={styles.emisorFilterBtn}
          onPress={() => setEmisorModalOpen(true)}
          activeOpacity={0.7}
        >
          <MaterialIcons name="storefront" size={18} color="#0369a1" />
          <Text style={styles.emisorFilterBtnText} numberOfLines={1}>
            {filtroEmisorId
              ? emisoresOpciones.find((e) => e.id === filtroEmisorId)?.nombre ?? 'Emisor'
              : 'Todos los emisores'}
          </Text>
          <MaterialIcons name="arrow-drop-down" size={22} color="#64748b" />
        </TouchableOpacity>
      ) : null}

      <Modal visible={emisorModalOpen} transparent animationType="fade" onRequestClose={() => setEmisorModalOpen(false)}>
        <Pressable style={styles.emisorModalBackdrop} onPress={() => setEmisorModalOpen(false)}>
          <Pressable style={styles.emisorModalSheet}>
            <Text style={styles.emisorModalTitle}>Filtrar por emisor</Text>
            <ScrollView style={styles.emisorModalList} keyboardShouldPersistTaps="handled">
              <TouchableOpacity
                style={[styles.emisorModalRow, !filtroEmisorId && styles.emisorModalRowActive]}
                onPress={() => {
                  setFiltroEmisorId('');
                  setEmisorModalOpen(false);
                }}
              >
                <MaterialIcons name="layers" size={18} color="#64748b" />
                <Text style={styles.emisorModalRowText}>Todos los emisores</Text>
                {!filtroEmisorId ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
              </TouchableOpacity>
              {emisoresOpciones.map((e) => (
                <TouchableOpacity
                  key={e.id}
                  style={[styles.emisorModalRow, filtroEmisorId === e.id && styles.emisorModalRowActive]}
                  onPress={() => {
                    setFiltroEmisorId(e.id);
                    setEmisorModalOpen(false);
                  }}
                >
                  <MaterialIcons name="business" size={18} color="#64748b" />
                  <Text style={styles.emisorModalRowText} numberOfLines={2}>{e.nombre}</Text>
                  {filtroEmisorId === e.id ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.emisorModalClose} onPress={() => setEmisorModalOpen(false)}>
              <Text style={styles.emisorModalCloseText}>Cerrar</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Toolbar */}
      <View style={styles.toolbarRow}>
        <View style={styles.toolbar}>
          {toolbarBtns.filter((b) => hasPermiso(b.permiso)).map((btn) => {
            const disabled = operando || (btn.needsSelection && !selectedId);
            return (
              <View
                key={btn.id}
                style={styles.toolbarBtnWrap}
                {...(Platform.OS === 'web'
                  ? ({ onMouseEnter: () => setHoveredBtn(btn.id), onMouseLeave: () => setHoveredBtn(null) } as object)
                  : {})}
              >
                {hoveredBtn === btn.id && (
                  <View style={styles.tooltip}>
                    <Text style={styles.tooltipText}>{btn.label}</Text>
                  </View>
                )}
                <TouchableOpacity
                  style={[styles.toolbarBtn, disabled && styles.toolbarBtnDisabled]}
                  onPress={() => handleToolbarPress(btn.id)}
                  disabled={disabled}
                  accessibilityLabel={btn.label}
                >
                  <MaterialIcons name={btn.icon} size={18} color={disabled ? '#94a3b8' : '#0ea5e9'} />
                </TouchableOpacity>
              </View>
            );
          })}
        </View>

        <View
          style={styles.toolbarBtnWrap}
          {...(Platform.OS === 'web'
            ? ({ onMouseEnter: () => setHoveredBtn('refresh'), onMouseLeave: () => setHoveredBtn(null) } as object)
            : {})}
        >
          {hoveredBtn === 'refresh' && (
            <View style={styles.tooltip}><Text style={styles.tooltipText}>Actualizar</Text></View>
          )}
          <TouchableOpacity style={styles.toolbarBtn} onPress={refetch} disabled={loading} accessibilityLabel="Actualizar">
            <MaterialIcons name="refresh" size={18} color={loading ? '#94a3b8' : '#0ea5e9'} />
          </TouchableOpacity>
        </View>

        {Platform.OS === 'web' && hasPermiso('facturacion.ver') && (
          <View
            style={styles.toolbarBtnWrap}
            {...({ onMouseEnter: () => setHoveredBtn('excel'), onMouseLeave: () => setHoveredBtn(null) } as object)}
          >
            {hoveredBtn === 'excel' && (
              <View style={styles.tooltip}><Text style={styles.tooltipText}>Exportar Excel</Text></View>
            )}
            <TouchableOpacity
              style={styles.toolbarBtn}
              onPress={async () => {
                const { exportarFacturasVentaExcel } = await import('../../utils/exportFacturasExcel');
                exportarFacturasVentaExcel(facturasFiltradas);
              }}
              accessibilityLabel="Exportar Excel"
            >
              <MaterialIcons name="file-download" size={18} color="#059669" />
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar…"
            placeholderTextColor="#94a3b8"
          />
        </View>

        <View style={styles.fechaFilterWrap}>
          <Text style={styles.fechaLabel}>Desde</Text>
          <InputFecha value={fechaDesde} onChange={setFechaDesde} format="dmy" placeholder="dd/mm/aaaa" style={styles.fechaInput} />
          <Text style={styles.fechaLabel}>Hasta</Text>
          <InputFecha value={fechaHasta} onChange={setFechaHasta} format="dmy" placeholder="dd/mm/aaaa" style={styles.fechaInput} />
        </View>
      </View>

      {/* Resumen rápido */}
      {facturasFiltradas.length > 0 && (
        <View style={styles.resumenRow}>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Total facturado</Text>
            <Text style={[styles.resumenVal, { color: '#059669' }]}>
              {formatMoneda(facturasFiltradas.reduce((s, f) => s + (f.total_factura ?? 0), 0))}
            </Text>
          </View>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Pendiente cobro</Text>
            <Text style={[styles.resumenVal, { color: '#b45309' }]}>
              {formatMoneda(facturasFiltradas.reduce((s, f) => s + (f.saldo_pendiente ?? 0), 0))}
            </Text>
          </View>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Facturas</Text>
            <Text style={styles.resumenVal}>{facturasFiltradas.length}</Text>
          </View>
        </View>
      )}

      {/* Subtítulo con paginación */}
      <View style={styles.subtitleRow}>
        <Text style={styles.subtitle}>
          {totalRegistros === 0
            ? '0 registros'
            : totalPages > 1
              ? `${pageIndexClamped * PAGE_SIZE + 1}–${Math.min((pageIndexClamped + 1) * PAGE_SIZE, totalRegistros)} de ${totalRegistros} registro${totalRegistros !== 1 ? 's' : ''}`
              : `${totalRegistros} registro${totalRegistros !== 1 ? 's' : ''}`}
        </Text>
        {totalPages > 1 && (
          <View style={styles.pagination}>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped <= 0 && styles.pageBtnDisabled]}
              onPress={goPrevPage}
              disabled={pageIndexClamped <= 0}
            >
              <MaterialIcons name="chevron-left" size={20} color={pageIndexClamped <= 0 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
            <Text style={styles.pageText}>Página {pageIndexClamped + 1} de {totalPages}</Text>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped >= totalPages - 1 && styles.pageBtnDisabled]}
              onPress={goNextPage}
              disabled={pageIndexClamped >= totalPages - 1}
            >
              <MaterialIcons name="chevron-right" size={20} color={pageIndexClamped >= totalPages - 1 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Tabla + panel detalle */}
      <View style={[styles.tableSplitWrap, layoutSplit ? styles.tableSplitRow : styles.tableSplitCol]}>
        <ScrollView
          horizontal
          style={[styles.scroll, styles.scrollTable, styles.tableScrollLtr]}
          contentContainerStyle={styles.scrollContent}
        >
          <View style={styles.table}>
            <View style={styles.rowHeader}>
              {COLUMNAS.map((col) => (
                <TouchableOpacity
                  key={col.key}
                  style={[styles.cellHeader, { width: getColWidth(col.key) }]}
                  onPress={() => toggleSort(col.key)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">{col.label}</Text>
                  {sortCol === col.key && (
                    <MaterialIcons name={sortDir === 'asc' ? 'arrow-upward' : 'arrow-downward'} size={10} color="#334155" />
                  )}
                  {Platform.OS === 'web' && (
                    <View
                      style={styles.resizeHandle}
                      {...({
                        onMouseDown: (e: { nativeEvent?: { clientX: number }; clientX?: number }) =>
                          handleResizeStart(col.key, e),
                      } as object)}
                    />
                  )}
                </TouchableOpacity>
              ))}
            </View>

            {facturasPagina.length === 0 ? (
              <View style={styles.emptyRow}>
                <Text style={styles.emptyText}>
                  {facturas.length === 0 ? 'No hay facturas' : 'Sin resultados para el filtro aplicado'}
                </Text>
              </View>
            ) : (
              facturasPagina.map((item) => (
                <Pressable
                  key={item.id_factura}
                  style={[styles.row, selectedId === item.id_factura && styles.rowSelected]}
                  onPress={() => setSelectedId(selectedId === item.id_factura ? null : item.id_factura)}
                >
                  {COLUMNAS.map((col) => (
                    <View key={col.key} style={[styles.cell, { width: getColWidth(col.key) }]}>
                      {col.key === 'estado' ? (
                        <BadgeEstado estado={item.estado} compact />
                      ) : col.key === 'pagado' ? (
                        <View style={styles.cellPagadoRow}>
                          <Text style={[styles.cellText, styles.cellTextFlex]} numberOfLines={1} ellipsizeMode="tail">
                            {valorCelda(item, col.key)}
                          </Text>
                          <Pressable
                            hitSlop={8}
                            accessibilityLabel="Ver detalle de cobros"
                            onPress={(e) => {
                              absorberClickFila(e as { stopPropagation?: () => void; nativeEvent?: { stopPropagation?: () => void } });
                              abrirModalDetallePagos(item);
                            }}
                            style={styles.cellPagadoIconBtn}
                          >
                            <MaterialIcons name="receipt-long" size={16} color="#0369a1" />
                          </Pressable>
                        </View>
                      ) : (
                        <Text style={styles.cellText} numberOfLines={col.key === 'impuestos_resumen' ? 2 : 1} ellipsizeMode="tail">
                          {valorCelda(item, col.key)}
                        </Text>
                      )}
                    </View>
                  ))}
                </Pressable>
              ))
            )}
          </View>
        </ScrollView>

        <View
          style={[
            styles.detailPanel,
            layoutSplit && styles.detailPanelFlex,
            layoutSplit ? styles.detailPanelSide : styles.detailPanelStack,
          ]}
        >
          <Text style={styles.detailPanelTitle}>Detalle</Text>
          <FacturaVentaDetallePanel
            apiUrl={API_URL}
            facturaId={selectedId}
            compactPanel
            puedeEditar={hasPermiso('facturacion.editar')}
            usuarioId={user?.id_usuario}
            usuarioNombre={user?.Nombre}
            onGuardado={refetch}
            onAbrirCompleto={(id) => router.push(`/facturacion/factura-detalle?id=${id}&modo=editar&tipo=OUT` as any)}
          />
        </View>
      </View>

      {/* Modal confirmar anulación */}
      <Modal visible={modalAnularVisible} transparent animationType="fade" onRequestClose={() => setModalAnularVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView style={styles.modalContentWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardTouch}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <View>
                    <Text style={styles.modalTitle}>Anular factura</Text>
                    <Text style={styles.modalSubtitle}>
                      ¿Seguro que deseas anular la factura {selectedFactura?.numero_factura}? Esta acción no se puede deshacer.
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => setModalAnularVisible(false)} style={styles.modalClose}>
                    <MaterialIcons name="close" size={22} color="#64748b" />
                  </TouchableOpacity>
                </View>
                {errorModal && (
                  <View style={styles.modalErrorWrap}>
                    <MaterialIcons name="error-outline" size={16} color="#dc2626" />
                    <Text style={styles.modalError}>{errorModal}</Text>
                  </View>
                )}
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalFooterBtnSecondary} onPress={() => setModalAnularVisible(false)} disabled={operando}>
                    <Text style={styles.modalFooterBtnSecondaryText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalFooterBtnDanger, operando && styles.modalFooterBtnDisabled]}
                    onPress={confirmarAnular}
                    disabled={operando}
                  >
                    {operando ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <MaterialIcons name="block" size={18} color="#fff" />
                        <Text style={styles.modalFooterBtnDangerText}>Anular</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>

      {/* Modal cobrar */}
      <Modal visible={modalCobrarVisible} transparent animationType="fade" onRequestClose={() => setModalCobrarVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView style={styles.modalContentWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardTouch}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <View>
                    <Text style={styles.modalTitle}>Registrar cobro</Text>
                    <Text style={styles.modalSubtitle}>Factura {selectedFactura?.numero_factura}</Text>
                  </View>
                  <TouchableOpacity onPress={() => setModalCobrarVisible(false)} style={styles.modalClose}>
                    <MaterialIcons name="close" size={22} color="#64748b" />
                  </TouchableOpacity>
                </View>
                <View style={styles.modalBody}>
                  <Text style={styles.formLabel}>Fecha del cobro *</Text>
                  <InputFecha
                    value={cobroFecha}
                    onChange={(v) => {
                      setCobroFecha(v);
                      setCobroFechaEditadaManual(true);
                    }}
                    format="dmy"
                  />
                  <Text style={styles.formLabel}>Importe (€)</Text>
                  <TextInput
                    style={styles.formInput}
                    value={cobroImporte}
                    onChangeText={setCobroImporte}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor="#94a3b8"
                  />
                  <Text style={styles.formLabel}>Método de pago</Text>
                  <TouchableOpacity
                    style={styles.modalSelect}
                    onPress={() => setCobroMetodoDropdownOpen(!cobroMetodoDropdownOpen)}
                  >
                    <Text style={styles.modalSelectText}>{labelFormaPago(cobroMetodo)}</Text>
                    <MaterialIcons name={cobroMetodoDropdownOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" />
                  </TouchableOpacity>
                  {cobroMetodoDropdownOpen && (
                    <View style={styles.dropdown}>
                      {FORMAS_PAGO.map((m) => (
                        <TouchableOpacity
                          key={m}
                          style={[styles.dropdownItem, cobroMetodo === m && styles.dropdownItemActive]}
                          onPress={() => onCambiarMetodoCobro(m)}
                        >
                          <Text style={[styles.dropdownItemText, cobroMetodo === m && styles.dropdownItemTextActive]}>
                            {labelFormaPago(m)}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  {cobroMetodo === 'otro' && (
                    <>
                      <Text style={styles.formLabel}>Describe el método *</Text>
                      <TextInput
                        style={styles.formInput}
                        value={cobroMetodoOtro}
                        onChangeText={setCobroMetodoOtro}
                        placeholder="Ej. Cheque, PayPal…"
                        placeholderTextColor="#94a3b8"
                      />
                    </>
                  )}
                  <Text style={styles.formLabel}>Referencia (opcional)</Text>
                  <TextInput
                    style={styles.formInput}
                    value={cobroReferencia}
                    onChangeText={setCobroReferencia}
                    placeholder="Nº transferencia, recibo…"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                {errorModal && (
                  <View style={styles.modalErrorWrap}>
                    <MaterialIcons name="error-outline" size={16} color="#dc2626" />
                    <Text style={styles.modalError}>{errorModal}</Text>
                  </View>
                )}
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalFooterBtnSecondary} onPress={() => setModalCobrarVisible(false)} disabled={operando}>
                    <Text style={styles.modalFooterBtnSecondaryText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalFooterBtnPrimary, operando && styles.modalFooterBtnDisabled]}
                    onPress={confirmarCobro}
                    disabled={operando}
                  >
                    {operando ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <MaterialIcons name="payments" size={18} color="#fff" />
                        <Text style={styles.modalFooterBtnPrimaryText}>Cobrar</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalDetallePagosVisible} transparent animationType="fade" onRequestClose={cerrarModalDetallePagos}>
        <Pressable style={styles.modalDetalleOverlay} onPress={cerrarModalDetallePagos}>
          <Pressable style={[styles.modalContent, styles.modalDetalleModal]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalDetalleHeaderRow}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={styles.modalDetalleTitle}>Cobros registrados</Text>
                <Text style={styles.modalDetalleSubtitle} numberOfLines={3}>
                  {detallePagosFactura?.numero_factura
                    ? `Nº factura: ${detallePagosFactura.numero_factura}`
                    : detallePagosFactura?.id_factura
                      ? `ID: ${detallePagosFactura.id_factura}`
                      : ''}
                  {detallePagosFactura?.empresa_nombre ? ` · ${detallePagosFactura.empresa_nombre}` : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={cerrarModalDetallePagos} style={styles.modalDetalleClose} accessibilityLabel="Cerrar">
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>

            <ModalDetallePagosTabla
              loading={detallePagosLoading}
              loadingText="Cargando cobros…"
              error={detallePagosError}
              emptyText="No hay cobros registrados"
              pagos={detallePagosLista}
              totalLabel="Total cobrado"
            />
          </Pressable>
        </Pressable>
      </Modal>

      {ToastView}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  errorText: { fontSize: 12, color: '#f87171', textAlign: 'center' },
  retryBtn: { paddingVertical: 8, paddingHorizontal: 16, backgroundColor: '#fef2f2', borderRadius: 8 },
  retryBtnText: { fontSize: 12, color: '#dc2626', fontWeight: '600' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },

  resumenRow: { flexDirection: 'row', gap: 12, marginBottom: 8, flexWrap: 'wrap' },
  resumenItem: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  resumenLabel: { fontSize: 10, color: '#94a3b8' },
  resumenVal: { fontSize: 14, fontWeight: '700', color: '#334155' },

  tabsScroll: { marginBottom: 8, flexGrow: 0 },
  tabsContent: { gap: 6, paddingVertical: 2 },
  tab: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  tabActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  tabText: { fontSize: 12, color: '#64748b', fontWeight: '500' },
  tabTextActive: { color: '#fff', fontWeight: '600' },

  emisorFilterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
    backgroundColor: '#f0f9ff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#bae6fd',
    alignSelf: 'stretch',
  },
  emisorFilterBtnText: { flex: 1, fontSize: 14, fontWeight: '600', color: '#0c4a6e' },
  emisorModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  emisorModalSheet: {
    backgroundColor: '#fff',
    borderRadius: 12,
    maxHeight: '70%',
    padding: 16,
    ...(Platform.OS === 'web' ? { boxShadow: '0 8px 32px rgba(0,0,0,0.12)' } as object : {}),
  },
  emisorModalTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a', marginBottom: 12 },
  emisorModalList: { maxHeight: 360 },
  emisorModalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  emisorModalRowActive: { backgroundColor: '#f0f9ff', borderColor: '#bae6fd' },
  emisorModalRowText: { flex: 1, fontSize: 14, color: '#334155' },
  emisorModalClose: { marginTop: 8, paddingVertical: 10, alignItems: 'center' },
  emisorModalCloseText: { fontSize: 14, fontWeight: '600', color: '#0ea5e9' },

  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12, flexWrap: 'wrap' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolbarBtnWrap: { position: 'relative' },
  tooltip: {
    position: 'absolute',
    bottom: '100%',
    alignSelf: 'center',
    marginBottom: 4,
    backgroundColor: '#334155',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
    zIndex: 10,
  },
  tooltipText: { fontSize: 9, color: '#f8fafc', fontWeight: '400' },
  toolbarBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  toolbarBtnDisabled: { opacity: 0.6 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 140,
    maxWidth: 280,
    height: 32,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
  },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 12, color: '#334155', paddingVertical: 0 },

  fechaFilterWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fechaLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  fechaInput: { fontSize: 11, paddingVertical: 3, paddingHorizontal: 6, minHeight: 28, color: '#334155', width: 110 },

  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 12,
    flexWrap: 'wrap',
  },
  subtitle: { fontSize: 14, color: '#64748b' },
  pagination: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pageBtn: { padding: 4 },
  pageBtnDisabled: { opacity: 0.5 },
  pageText: { fontSize: 11, color: '#64748b', marginHorizontal: 4 },

  tableSplitWrap: { flex: 1, minHeight: 0 },
  tableSplitRow: { flexDirection: 'row', alignItems: 'stretch' },
  tableSplitCol: { flexDirection: 'column' },
  detailPanel: {
    backgroundColor: '#f8fafc',
    borderColor: '#e2e8f0',
  },
  detailPanelFlex: {
    flex: 1,
    minHeight: 0,
    maxWidth: 360,
  },
  detailPanelSide: {
    width: 360,
    flexShrink: 0,
    alignSelf: 'stretch',
    borderLeftWidth: 1,
    minHeight: 220,
  },
  detailPanelStack: {
    width: '100%',
    maxHeight: 380,
    borderTopWidth: 1,
  },
  detailPanelTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 3,
  },

  scroll: { flex: 1, minWidth: 0 },
  scrollTable: { flex: 1, minWidth: 0 },
  /** Orden fijo de columnas (fecha a la izquierda); evita que en RTL se invierta el orden */
  tableScrollLtr: { direction: 'ltr' },
  scrollContent: { paddingBottom: 20 },
  table: {
    minWidth: '100%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    direction: 'ltr',
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e2e8f0',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
  },
  cellHeader: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRightWidth: 1,
    borderRightColor: '#cbd5e1',
    position: 'relative',
  },
  cellHeaderText: { fontSize: 9, fontWeight: '600', color: '#334155', lineHeight: 11 },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize' as 'pointer',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  rowSelected: { backgroundColor: '#e0f2fe' },
  cell: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 2,
    paddingHorizontal: 5,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    justifyContent: 'center',
  },
  cellPagadoRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 },
  cellTextFlex: { flex: 1, minWidth: 0 },
  cellPagadoIconBtn: { padding: 2 },
  cellText: { fontSize: 9, color: '#475569', lineHeight: 12, ...(Platform.OS === 'android' ? { includeFontPadding: false } : {}) },
  emptyRow: { padding: 24, alignItems: 'center' },
  emptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },

  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  /** Misma base que facturas recibidas: overlay + tarjeta compacta para detalle de cobros */
  modalDetalleOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '90%',
    maxWidth: 400,
  },
  modalDetalleModal: { maxWidth: 480 },
  modalDetalleHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  modalDetalleTitle: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 4 },
  modalDetalleSubtitle: { fontSize: 12, color: '#64748b', lineHeight: 18 },
  modalDetalleClose: { padding: 4, marginTop: -4 },
  modalContentWrap: { width: '100%', maxWidth: 480, padding: 24, alignItems: 'center' },
  modalCardTouch: { width: '100%' },
  modalCard: {
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#334155', marginBottom: 4 },
  modalSubtitle: { fontSize: 13, color: '#64748b', lineHeight: 18 },
  modalClose: { padding: 4, marginTop: -4 },
  modalBody: { paddingHorizontal: 24, paddingVertical: 20, gap: 12 },
  formLabel: { fontSize: 12, fontWeight: '600', color: '#334155', marginBottom: 4 },
  formInput: {
    fontSize: 13,
    color: '#334155',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
  },
  modalSelect: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#f8fafc',
  },
  modalSelectText: { fontSize: 13, color: '#334155' },
  dropdown: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#fff',
    marginBottom: 4,
    maxHeight: 200,
  },
  dropdownItem: { paddingHorizontal: 12, paddingVertical: 8 },
  dropdownItemActive: { backgroundColor: '#e0f2fe' },
  dropdownItemText: { fontSize: 12, color: '#334155' },
  dropdownItemTextActive: { color: '#0369a1', fontWeight: '600' },
  modalErrorWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#fef2f2',
    marginHorizontal: 24,
    marginBottom: 8,
    borderRadius: 8,
  },
  modalError: { fontSize: 12, color: '#dc2626', flex: 1 },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  modalFooterBtnSecondary: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  modalFooterBtnSecondaryText: { fontSize: 14, color: '#64748b', fontWeight: '500' },
  modalFooterBtnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#0ea5e9',
  },
  modalFooterBtnPrimaryText: { fontSize: 14, color: '#fff', fontWeight: '600' },
  modalFooterBtnDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#dc2626',
  },
  modalFooterBtnDangerText: { fontSize: 14, color: '#fff', fontWeight: '600' },
  modalFooterBtnDisabled: { opacity: 0.7 },
});
