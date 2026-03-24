import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
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
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { BadgeEstado } from '../../components/BadgeEstado';
import { InputFecha } from '../../components/InputFecha';
import {
  formatMoneda,
  FORMAS_PAGO,
  labelFormaPago,
  mapTipoReciboToFormaPago,
  resolveMetodoPagoParaEnvio,
  type Factura,
} from '../../utils/facturacion';
import {
  formatFecha,
  fechaEmisionFacturaADmy,
  fechaEmisionFacturaAIso,
  textoFechaContabilizacionGasto,
} from '../../utils/formatFecha';
import { getTipoReciboFromEmpresasList, type EmpresaConTipoRecibo } from '../../utils/empresaTipoRecibo';
import { useLocalToast } from '../../components/Toast';
import { ModalDetallePagosTabla } from '../../components/ModalDetallePagosTabla';
import { FacturaVentaDetallePanel } from '../../components/FacturaVentaDetallePanel';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';
const PAGE_SIZE = 50;

/** Fecha emisión en BD (varios formatos) → dd/mm/aaaa para listado */
function formatFechaEmisionCelda(raw: string): string {
  if (!raw?.trim()) return '—';
  const iso = fechaEmisionFacturaAIso(raw.trim());
  return iso ? formatFecha(iso) : '—';
}

function fechaEmisionComparable(s: string | undefined | null): string {
  if (s == null || String(s).trim() === '') return '';
  return fechaEmisionFacturaAIso(String(s).trim()) ?? '';
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
function absorberClickFila(e: import('react-native').GestureResponderEvent) {
  const ev = e as unknown as { stopPropagation?: () => void; nativeEvent?: { stopPropagation?: () => void } };
  if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
  const ne = ev.nativeEvent;
  if (ne && typeof ne.stopPropagation === 'function') ne.stopPropagation();
}

const MIN_COL_WIDTH = 40;

/** % IVA efectivo desde base y cuota (cabecera). */
function tipoIvaImplicitoPct(f: Factura): number | null {
  const base = Number(f.base_imponible) || 0;
  const iva = Number(f.total_iva) || 0;
  if (base <= 0) return null;
  return Math.round((10000 * iva) / base) / 100;
}

function formatoTipoIvaPct(f: Factura): string {
  const p = tipoIvaImplicitoPct(f);
  if (p == null) return '—';
  const s = Number.isInteger(p) ? String(p) : p.toFixed(2).replace('.', ',');
  return `${s} %`;
}

type TabEstado = 'todas' | 'borrador' | 'pendiente_revision' | 'pendiente_pago' | 'parcialmente_pagada' | 'pagada' | 'anulada';

const TABS: { key: TabEstado; label: string }[] = [
  { key: 'todas', label: 'Todas' },
  { key: 'borrador', label: 'Borrador' },
  { key: 'pendiente_revision', label: 'Pte. revisión' },
  { key: 'pendiente_pago', label: 'Pte. pago' },
  { key: 'parcialmente_pagada', label: 'Parcial pagada' },
  { key: 'pagada', label: 'Pagada' },
  { key: 'anulada', label: 'Anulada' },
];

const COLUMNAS = [
  'id_factura',
  'fecha_emision',
  'fecha_contabilizacion',
  'emisor_nombre',
  'empresa_nombre',
  'empresa_cif',
  'numero_factura_proveedor',
  'base_imponible',
  'iva_tipo',
  'total_iva',
  'total_retencion',
  'total_factura',
  'estado',
  'pagado',
  'saldo_pendiente',
] as const;

const COL_LABELS: Record<string, string> = {
  id_factura: 'ID',
  fecha_emision: 'Fecha',
  fecha_contabilizacion: 'F. contabilización',
  emisor_nombre: 'Empresa',
  empresa_nombre: 'Proveedor',
  empresa_cif: 'CIF',
  numero_factura_proveedor: 'Nº Factura Prov.',
  base_imponible: 'Base Imp.',
  iva_tipo: '% IVA',
  total_iva: 'IVA €',
  total_retencion: 'Retención',
  total_factura: 'Total',
  estado: 'Estado',
  pagado: 'Pagado',
  saldo_pendiente: 'Saldo Pte.',
};

const DEFAULT_WIDTHS: Record<string, number> = {
  id_factura: 80,
  fecha_emision: 90,
  fecha_contabilizacion: 210,
  emisor_nombre: 170,
  empresa_nombre: 160,
  empresa_cif: 100,
  numero_factura_proveedor: 130,
  base_imponible: 95,
  iva_tipo: 52,
  total_iva: 72,
  total_retencion: 88,
  total_factura: 95,
  estado: 110,
  pagado: 120,
  saldo_pendiente: 95,
};

const MONEDA_COLS = new Set([
  'base_imponible',
  'total_iva',
  'total_retencion',
  'total_factura',
  'pagado',
  'saldo_pendiente',
]);

type ToolbarBtn = {
  id: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  permiso: string;
  needsSelection: boolean;
};

const TOOLBAR_BUTTONS: ToolbarBtn[] = [
  { id: 'crear', icon: 'add', label: 'Crear', permiso: 'facturacion.crear', needsSelection: false },
  { id: 'editar', icon: 'edit', label: 'Editar', permiso: 'facturacion.editar', needsSelection: true },
  { id: 'emitir', icon: 'send', label: 'Emitir', permiso: 'facturacion.emitir', needsSelection: true },
  { id: 'borrar', icon: 'delete-outline', label: 'Borrar', permiso: 'facturacion.editar', needsSelection: true },
  { id: 'pagar', icon: 'payments', label: 'Pagar', permiso: 'facturacion.cobrar_pagar', needsSelection: true },
  { id: 'refresh', icon: 'refresh', label: 'Actualizar', permiso: '', needsSelection: false },
  { id: 'ver_doc', icon: 'description', label: 'Ver documento', permiso: '', needsSelection: true },
];

export default function FacturasGastoScreen() {
  const router = useRouter();
  const { hasPermiso, user } = useAuth();
  const { width: winW } = useWindowDimensions();
  const layoutSplit = Platform.OS === 'web' && winW >= 1024;
  const { show: showToast, ToastView } = useLocalToast();

  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tabActivo, setTabActivo] = useState<TabEstado>('todas');
  const [busqueda, setBusqueda] = useState('');
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<string>('fecha_emision');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [procesando, setProcesando] = useState(false);

  const [modalBorrar, setModalBorrar] = useState(false);
  const [modalPagar, setModalPagar] = useState(false);
  const [pagoImporte, setPagoImporte] = useState('');
  const [pagoFecha, setPagoFecha] = useState('');
  const [pagoMetodo, setPagoMetodo] = useState('transferencia');
  const [pagoMetodoOtro, setPagoMetodoOtro] = useState('');
  const [pagoFechaEditadaManual, setPagoFechaEditadaManual] = useState(false);
  const [pagoReferencia, setPagoReferencia] = useState('');
  const [metodoDropdownOpen, setMetodoDropdownOpen] = useState(false);
  const [empresasCatalogo, setEmpresasCatalogo] = useState<EmpresaConTipoRecibo[]>([]);

  const [modalDetallePagosVisible, setModalDetallePagosVisible] = useState(false);
  const [detallePagosLoading, setDetallePagosLoading] = useState(false);
  const [detallePagosError, setDetallePagosError] = useState<string | null>(null);
  const [detallePagosLista, setDetallePagosLista] = useState<Record<string, unknown>[]>([]);
  const [detallePagosFactura, setDetallePagosFactura] = useState<Factura | null>(null);

  const fetchFacturas = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/api/facturacion/facturas?tipo=IN`)
      .then((r) => {
        if (!r.ok) throw new Error(`Error ${r.status}`);
        return r.json();
      })
      .then((data) => setFacturas(data.facturas || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchFacturas(); }, [fetchFacturas]);

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

  const toggleSort = useCallback((col: string) => {
    if (sortCol === col) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }, [sortCol]);

  const filtradas = useMemo(() => {
    let list = facturas;
    if (tabActivo !== 'todas') list = list.filter((f) => f.estado === tabActivo);
    const isoDesde = dmyToIso(fechaDesde);
    const isoHasta = dmyToIso(fechaHasta);
    if (isoDesde) {
      list = list.filter((f) => (fechaEmisionComparable(f.fecha_emision) || '') >= isoDesde);
    }
    if (isoHasta) {
      list = list.filter((f) => (fechaEmisionComparable(f.fecha_emision) || '') <= isoHasta);
    }
    if (busqueda.trim()) {
      const q = busqueda.toLowerCase();
      list = list.filter((f) =>
        f.emisor_nombre?.toLowerCase().includes(q) ||
        f.emisor_cif?.toLowerCase().includes(q) ||
        f.empresa_nombre?.toLowerCase().includes(q) ||
        f.empresa_cif?.toLowerCase().includes(q) ||
        f.numero_factura_proveedor?.toLowerCase().includes(q) ||
        f.id_factura?.toLowerCase().includes(q)
      );
    }
    if (sortCol) {
      list = [...list].sort((a, b) => {
        if (sortCol === 'fecha_emision') {
          const fa = fechaEmisionComparable((a as Factura).fecha_emision);
          const fb = fechaEmisionComparable((b as Factura).fecha_emision);
          const cmp = fa.localeCompare(fb);
          return sortDir === 'desc' ? -cmp : cmp;
        }
        if (sortCol === 'fecha_contabilizacion') {
          const fa = String((a as Factura).fecha_contabilizacion || (a as Factura).creado_en || '');
          const fb = String((b as Factura).fecha_contabilizacion || (b as Factura).creado_en || '');
          const cmp = fa.localeCompare(fb);
          return sortDir === 'desc' ? -cmp : cmp;
        }
        if (sortCol === 'iva_tipo') {
          const pa = tipoIvaImplicitoPct(a as Factura);
          const pb = tipoIvaImplicitoPct(b as Factura);
          const na = pa ?? -1;
          const nb = pb ?? -1;
          const cmp = na - nb;
          return sortDir === 'desc' ? -cmp : cmp;
        }
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
    return list;
  }, [facturas, tabActivo, busqueda, fechaDesde, fechaHasta, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtradas.length / PAGE_SIZE));
  const pageClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const paginadas = filtradas.slice(pageClamped * PAGE_SIZE, (pageClamped + 1) * PAGE_SIZE);

  useEffect(() => { setPageIndex(0); setSelectedId(null); }, [tabActivo, busqueda, fechaDesde, fechaHasta]);

  const selectedFactura: Factura | null = useMemo(
    () => (selectedId ? filtradas.find((f) => f.id_factura === selectedId) ?? null : null),
    [selectedId, filtradas],
  );

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? DEFAULT_WIDTHS[col] ?? 90, [columnWidths]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !resizingCol) return;
    const handleMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const next = Math.max(MIN_COL_WIDTH, r.startWidth + (e.clientX - r.startX));
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

  const getCellValue = (f: Factura, col: string): string => {
    if (col === 'fecha_contabilizacion') {
      return textoFechaContabilizacionGasto({
        fechaContabilizacion: f.fecha_contabilizacion,
        contabilizadoPor: f.contabilizado_por,
        creadoEn: f.creado_en,
      });
    }
    if (col === 'iva_tipo') return formatoTipoIvaPct(f);
    if (col === 'total_retencion') return formatMoneda(Number(f.total_retencion ?? 0));
    if (col === 'pagado') return formatMoneda(Number(f.total_cobrado ?? 0));
    const val = (f as Record<string, unknown>)[col];
    if (val == null) return '';
    if (MONEDA_COLS.has(col)) return formatMoneda(Number(val));
    if (col === 'fecha_emision' && typeof val === 'string') return formatFechaEmisionCelda(val);
    if (col === 'emisor_nombre') {
      const t = String(val ?? '').trim();
      return t || '—';
    }
    return String(val);
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
        if (!r.ok) throw new Error(data.error || 'Error al cargar pagos');
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

  const abrirModalPagar = () => {
    if (!selectedFactura) return;
    setMetodoDropdownOpen(false);
    setPagoFechaEditadaManual(false);
    setPagoImporte(String(selectedFactura.saldo_pendiente ?? 0));
    setPagoReferencia('');

    const tipoRecibo = getTipoReciboFromEmpresasList(empresasCatalogo, selectedFactura.empresa_id);
    const { clave, otroTexto } = mapTipoReciboToFormaPago(tipoRecibo);
    setPagoMetodo(clave);
    setPagoMetodoOtro(clave === 'otro' ? otroTexto : '');

    const hoy = hoyDmy();
    const fechaFactura = fechaEmisionFacturaADmy(selectedFactura.fecha_emision, hoy);
    setPagoFecha(clave === 'tarjeta' ? fechaFactura : hoy);

    setModalPagar(true);
  };

  const onCambiarMetodoPago = (m: string) => {
    setPagoMetodo(m);
    setMetodoDropdownOpen(false);
    if (m !== 'otro') setPagoMetodoOtro('');
    if (!selectedFactura || pagoFechaEditadaManual) return;
    const hoy = hoyDmy();
    const fechaFactura = fechaEmisionFacturaADmy(selectedFactura.fecha_emision, hoy);
    setPagoFecha(m === 'tarjeta' ? fechaFactura : hoy);
  };

  const verDocumento = async () => {
    if (!selectedFactura) return;
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedFactura.id_factura}/adjuntos`);
      const data = await res.json();
      const adjuntos = data.adjuntos ?? [];
      if (adjuntos.length === 0) {
        showToast('Sin documento', 'Esta factura no tiene documento adjunto', 'warning');
        return;
      }
      const url = adjuntos[0].url;
      if (url && Platform.OS === 'web') {
        window.open(url, '_blank');
      } else {
        showToast('Info', 'Abre la factura en modo edición para ver adjuntos', 'info');
      }
    } catch {
      showToast('Error', 'No se pudo obtener el documento', 'error');
    }
  };

  const handleToolbar = (id: string) => {
    if (id === 'refresh') { fetchFacturas(); return; }
    if (id === 'crear') { router.push('/facturacion/factura-detalle?tipo=IN&modo=crear' as never); return; }
    if (id === 'ver_doc') { verDocumento(); return; }
    if (!selectedFactura) return;
    if (id === 'editar') {
      router.push(`/facturacion/factura-detalle?id=${selectedFactura.id_factura}&modo=editar&tipo=IN` as never);
      return;
    }
    if (id === 'emitir') { handleEmitir(); return; }
    if (id === 'pagar') {
      abrirModalPagar();
      return;
    }
    if (id === 'borrar') { setModalBorrar(true); return; }
  };

  const handleEmitir = async () => {
    if (!selectedFactura) return;
    if (selectedFactura.estado !== 'borrador') {
      showToast('Aviso', 'Solo se pueden emitir facturas en borrador', 'warning');
      return;
    }
    setProcesando(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedFactura.id_factura}/emitir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al emitir');
      fetchFacturas();
      setSelectedId(null);
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error al emitir la factura', 'error');
    } finally {
      setProcesando(false);
    }
  };

  const handleBorrarDefinitivo = async () => {
    if (!selectedFactura) return;
    setProcesando(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedFactura.id_factura}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usuario_id: user?.id_usuario ?? '',
          usuario_nombre: user?.Nombre ?? '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al eliminar la factura');
      setModalBorrar(false);
      showToast('Factura eliminada', 'La factura de gasto se ha borrado del sistema.', 'success');
      fetchFacturas();
      setSelectedId(null);
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'No se pudo eliminar la factura', 'error');
    } finally {
      setProcesando(false);
    }
  };

  const handlePagar = async () => {
    if (!selectedFactura) return;
    const importe = parseFloat(pagoImporte.replace(',', '.'));
    if (!importe || importe <= 0) { showToast('Aviso', 'El importe debe ser mayor que 0', 'warning'); return; }
    const fechaIso = dmyToIso(pagoFecha);
    if (!fechaIso) { showToast('Aviso', 'Indica una fecha válida', 'warning'); return; }
    const metodoEnvio = resolveMetodoPagoParaEnvio(pagoMetodo, pagoMetodoOtro);
    if (metodoEnvio == null) {
      showToast('Aviso', 'Describe el método de pago si eliges «Otro»', 'warning');
      return;
    }
    setProcesando(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedFactura.id_factura}/pagos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fecha: fechaIso,
          importe,
          metodo_pago: metodoEnvio,
          referencia: pagoReferencia.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al registrar pago');
      setModalPagar(false);
      fetchFacturas();
      setSelectedId(null);
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error al registrar el pago', 'error');
    } finally {
      setProcesando(false);
    }
  };

  const isBtnDisabled = (btn: ToolbarBtn) => {
    if (procesando) return true;
    if (btn.needsSelection && selectedId == null) return true;
    if (btn.id === 'emitir' && selectedFactura?.estado !== 'borrador') return true;
    if (btn.id === 'pagar' && selectedFactura && (selectedFactura.estado === 'anulada' || selectedFactura.estado === 'pagada' || selectedFactura.estado === 'borrador')) return true;
    return false;
  };

  const subtitleText = filtradas.length === 0
    ? '0 facturas'
    : totalPages > 1
      ? `${pageClamped * PAGE_SIZE + 1}–${Math.min((pageClamped + 1) * PAGE_SIZE, filtradas.length)} de ${filtradas.length} factura${filtradas.length !== 1 ? 's' : ''}`
      : `${filtradas.length} factura${filtradas.length !== 1 ? 's' : ''}`;

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
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color="#f87171" />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={fetchFacturas}>
          <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
          <Text style={styles.retryBtnText}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/facturacion' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Facturas de gasto</Text>
        {hasPermiso('facturacion.crear') && (
          <TouchableOpacity
            style={styles.masivoBtnHeader}
            onPress={() => router.push('/facturacion/registro-masivo' as any)}
          >
            <MaterialIcons name="upload-file" size={16} color="#0ea5e9" />
            <Text style={{ fontSize: 11, color: '#0ea5e9', fontWeight: '500' }}>Registro masivo</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabsContent}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tab, tabActivo === t.key && styles.tabActive]}
            onPress={() => setTabActivo(t.key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, tabActivo === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Toolbar */}
      <View style={styles.toolbarRow}>
        <View style={styles.toolbar}>
          {TOOLBAR_BUTTONS.filter((b) => hasPermiso(b.permiso)).map((btn) => {
            const disabled = isBtnDisabled(btn);
            return (
              <View
                key={btn.id}
                style={styles.toolbarBtnWrap}
                {...(Platform.OS === 'web' ? { onMouseEnter: () => setHoveredBtn(btn.id), onMouseLeave: () => setHoveredBtn(null) } as object : {})}
              >
                {hoveredBtn === btn.id && (
                  <View style={styles.tooltip}>
                    <Text style={styles.tooltipText}>{btn.label}</Text>
                  </View>
                )}
                <TouchableOpacity
                  style={[styles.toolbarBtn, disabled && styles.toolbarBtnDisabled]}
                  onPress={() => handleToolbar(btn.id)}
                  disabled={disabled}
                >
                  <MaterialIcons name={btn.icon} size={18} color={disabled ? '#94a3b8' : '#0ea5e9'} />
                </TouchableOpacity>
              </View>
            );
          })}
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
                const { exportarFacturasGastoExcel } = await import('../../utils/exportFacturasExcel');
                exportarFacturasGastoExcel(filtradas);
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
            value={busqueda}
            onChangeText={setBusqueda}
            placeholder="Buscar proveedor, CIF, nº…"
            placeholderTextColor="#94a3b8"
          />
        </View>

        <View style={styles.dateFilters}>
          <InputFecha value={fechaDesde} onChange={setFechaDesde} format="dmy" placeholder="dd/mm/aaaa" />
          <InputFecha value={fechaHasta} onChange={setFechaHasta} format="dmy" placeholder="dd/mm/aaaa" />
        </View>
      </View>

      {/* Resumen rápido */}
      {filtradas.length > 0 && (
        <View style={styles.resumenRow}>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Total gastos</Text>
            <Text style={[styles.resumenVal, { color: '#dc2626' }]}>
              {formatMoneda(filtradas.reduce((s: number, f: any) => s + (f.total_factura ?? 0), 0))}
            </Text>
          </View>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Pendiente pago</Text>
            <Text style={[styles.resumenVal, { color: '#b45309' }]}>
              {formatMoneda(filtradas.reduce((s: number, f: any) => s + (f.saldo_pendiente ?? 0), 0))}
            </Text>
          </View>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Facturas</Text>
            <Text style={styles.resumenVal}>{filtradas.length}</Text>
          </View>
        </View>
      )}

      {/* Subtitle + pagination */}
      <View style={styles.subtitleRow}>
        <Text style={styles.subtitle}>{subtitleText}</Text>
        {totalPages > 1 && (
          <View style={styles.pagination}>
            <TouchableOpacity
              style={[styles.pageBtn, pageClamped <= 0 && styles.pageBtnDisabled]}
              onPress={() => { setPageIndex((p) => p - 1); setSelectedId(null); }}
              disabled={pageClamped <= 0}
            >
              <MaterialIcons name="chevron-left" size={20} color={pageClamped <= 0 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
            <Text style={styles.pageText}>Página {pageClamped + 1} de {totalPages}</Text>
            <TouchableOpacity
              style={[styles.pageBtn, pageClamped >= totalPages - 1 && styles.pageBtnDisabled]}
              onPress={() => { setPageIndex((p) => p + 1); setSelectedId(null); }}
              disabled={pageClamped >= totalPages - 1}
            >
              <MaterialIcons name="chevron-right" size={20} color={pageClamped >= totalPages - 1 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Tabla + panel detalle */}
      <View style={[styles.tableSplitWrap, layoutSplit ? styles.tableSplitRow : styles.tableSplitCol]}>
        <View style={styles.tableOuter}>
          <View style={styles.tableWrapper}>
        <ScrollView
          horizontal
          style={[styles.scroll, styles.scrollTable, styles.tableScrollLtr]}
          contentContainerStyle={styles.scrollContent}
          showsHorizontalScrollIndicator
        >
          <View style={styles.table}>
            {/* Header row */}
            <View style={styles.rowHeader}>
              {COLUMNAS.map((col) => (
                <TouchableOpacity
                  key={col}
                  style={[styles.cellHeader, { width: getColWidth(col) }, MONEDA_COLS.has(col) && styles.cellHeaderRight]}
                  onPress={() => toggleSort(col)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.cellHeaderText, MONEDA_COLS.has(col) && styles.cellHeaderTextRight]} numberOfLines={1} ellipsizeMode="tail">
                    {COL_LABELS[col] || col}
                  </Text>
                  {sortCol === col && (
                    <MaterialIcons name={sortDir === 'asc' ? 'arrow-upward' : 'arrow-downward'} size={12} color="#334155" />
                  )}
                  {Platform.OS === 'web' && (
                    <View
                      style={styles.resizeHandle}
                      {...({ onMouseDown: (e: { nativeEvent?: { clientX: number }; clientX?: number }) => handleResizeStart(col, e) } as object)}
                    />
                  )}
                </TouchableOpacity>
              ))}
            </View>

            {/* Body */}
            <ScrollView style={styles.tableBodyScroll} contentContainerStyle={styles.tableBodyContent} showsVerticalScrollIndicator nestedScrollEnabled>
              {paginadas.length === 0 ? (
                <View style={styles.row}>
                  <View style={styles.cellEmpty}>
                    <Text style={styles.cellEmptyText}>
                      {busqueda.trim() || fechaDesde || fechaHasta || tabActivo !== 'todas'
                        ? 'Ningún resultado con los filtros aplicados'
                        : 'No hay facturas de gasto'}
                    </Text>
                  </View>
                </View>
              ) : (
                paginadas.map((f) => (
                  <Pressable
                    key={f.id_factura}
                    style={[styles.row, selectedId === f.id_factura && styles.rowSelected]}
                    onPress={() => setSelectedId(selectedId === f.id_factura ? null : f.id_factura)}
                  >
                    {COLUMNAS.map((col) => {
                      if (col === 'estado') {
                        return (
                          <View key={col} style={[styles.cell, { width: getColWidth(col) }]}>
                            <BadgeEstado estado={f.estado} compact />
                          </View>
                        );
                      }
                      if (col === 'pagado') {
                        return (
                          <View key={col} style={[styles.cell, { width: getColWidth(col) }, styles.cellRight]}>
                            <View style={styles.cellPagadoRow}>
                              <Text style={[styles.cellText, styles.cellTextRight, styles.cellTextFlex]} numberOfLines={1} ellipsizeMode="tail">
                                {getCellValue(f, col)}
                              </Text>
                              <Pressable
                                hitSlop={8}
                                accessibilityLabel="Ver detalle de pagos"
                                onPress={(e) => {
                                  absorberClickFila(e);
                                  abrirModalDetallePagos(f);
                                }}
                                style={styles.cellPagadoIconBtn}
                              >
                                <MaterialIcons name="receipt-long" size={16} color="#0369a1" />
                              </Pressable>
                            </View>
                          </View>
                        );
                      }
                      const isMoneda = MONEDA_COLS.has(col);
                      return (
                        <View key={col} style={[styles.cell, { width: getColWidth(col) }, isMoneda && styles.cellRight]}>
                          <Text style={[styles.cellText, isMoneda && styles.cellTextRight]} numberOfLines={1} ellipsizeMode="tail">
                            {getCellValue(f, col)}
                          </Text>
                        </View>
                      );
                    })}
                  </Pressable>
                ))
              )}
            </ScrollView>
          </View>
        </ScrollView>
          </View>
        </View>

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
            tipoFactura="IN"
            puedeEditar={hasPermiso('facturacion.editar')}
            usuarioId={user?.id_usuario}
            usuarioNombre={user?.Nombre}
            onGuardado={fetchFacturas}
            onAbrirCompleto={(id) =>
              router.push(`/facturacion/factura-detalle?id=${id}&modo=editar&tipo=IN` as never)
            }
          />
        </View>
      </View>

      {/* Modal Borrar (solo facturas IN; eliminación definitiva) */}
      <Modal visible={modalBorrar} transparent animationType="fade" onRequestClose={() => !procesando && setModalBorrar(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => !procesando && setModalBorrar(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Eliminar factura de gasto</Text>
            <Text style={styles.modalWarningTitle}>Esta acción no se puede deshacer</Text>
            <Text style={styles.modalLabel}>
              Se borrará la factura <Text style={styles.modalStrong}>{selectedFactura?.id_factura}</Text>
              {selectedFactura?.empresa_nombre ? (
                <> ({selectedFactura.empresa_nombre})</>
              ) : null}
              , incluyendo líneas, pagos asociados y documentos en almacenamiento.
            </Text>
            <Text style={styles.modalLabelMuted}>
              Si solo quieres dejar constancia contable sin borrar el registro, usa «Anular» en lugar de eliminar.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnCancel} onPress={() => setModalBorrar(false)} disabled={procesando}>
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtnDanger, procesando && styles.modalBtnDisabled]}
                onPress={handleBorrarDefinitivo}
                disabled={procesando}
              >
                {procesando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalBtnDangerText}>Eliminar definitivamente</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Modal Pagar */}
      <Modal visible={modalPagar} transparent animationType="fade" onRequestClose={() => setModalPagar(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => !procesando && setModalPagar(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Registrar pago</Text>
            <Text style={styles.modalLabel}>Factura: {selectedFactura?.id_factura} — Saldo: {selectedFactura ? formatMoneda(selectedFactura.saldo_pendiente) : ''}</Text>

            <Text style={styles.modalFieldLabel}>Fecha del pago *</Text>
            <InputFecha
              value={pagoFecha}
              onChange={(v) => {
                setPagoFecha(v);
                setPagoFechaEditadaManual(true);
              }}
              format="dmy"
            />

            <Text style={styles.modalFieldLabel}>Importe</Text>
            <TextInput
              style={styles.modalInput}
              value={pagoImporte}
              onChangeText={setPagoImporte}
              placeholder="0,00"
              placeholderTextColor="#94a3b8"
              keyboardType="decimal-pad"
            />

            <Text style={styles.modalFieldLabel}>Método de pago</Text>
            <TouchableOpacity style={styles.modalSelect} onPress={() => setMetodoDropdownOpen(!metodoDropdownOpen)}>
              <Text style={styles.modalSelectText}>{labelFormaPago(pagoMetodo)}</Text>
              <MaterialIcons name={metodoDropdownOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" />
            </TouchableOpacity>
            {metodoDropdownOpen && (
              <View style={styles.dropdown}>
                {FORMAS_PAGO.map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[styles.dropdownItem, pagoMetodo === m && styles.dropdownItemActive]}
                    onPress={() => onCambiarMetodoPago(m)}
                  >
                    <Text style={[styles.dropdownItemText, pagoMetodo === m && styles.dropdownItemTextActive]}>{labelFormaPago(m)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {pagoMetodo === 'otro' && (
              <>
                <Text style={styles.modalFieldLabel}>Describe el método *</Text>
                <TextInput
                  style={styles.modalInput}
                  value={pagoMetodoOtro}
                  onChangeText={setPagoMetodoOtro}
                  placeholder="Ej. Cheque, PayPal…"
                  placeholderTextColor="#94a3b8"
                />
              </>
            )}

            <Text style={styles.modalFieldLabel}>Referencia (opcional)</Text>
            <TextInput
              style={styles.modalInput}
              value={pagoReferencia}
              onChangeText={setPagoReferencia}
              placeholder="Nº transferencia, cheque…"
              placeholderTextColor="#94a3b8"
            />

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnCancel} onPress={() => setModalPagar(false)} disabled={procesando}>
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtnConfirm, procesando && styles.modalBtnDisabled]} onPress={handlePagar} disabled={procesando}>
                {procesando ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.modalBtnConfirmText}>Pagar</Text>}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={modalDetallePagosVisible} transparent animationType="fade" onRequestClose={cerrarModalDetallePagos}>
        <Pressable style={styles.modalOverlay} onPress={cerrarModalDetallePagos}>
          <Pressable style={[styles.modalContent, styles.modalDetalleModal]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalDetalleHeaderRow}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={styles.modalDetalleTitle}>Pagos registrados</Text>
                <Text style={styles.modalDetalleSubtitle} numberOfLines={3}>
                  {detallePagosFactura?.numero_factura_proveedor
                    ? `Factura proveedor: ${detallePagosFactura.numero_factura_proveedor}`
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
              loadingText="Cargando pagos…"
              error={detallePagosError}
              emptyText="No hay pagos registrados"
              pagos={detallePagosLista}
              totalLabel="Total pagado"
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
  resumenRow: { flexDirection: 'row', gap: 12, marginBottom: 8, flexWrap: 'wrap' },
  resumenItem: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  resumenLabel: { fontSize: 10, color: '#94a3b8' },
  resumenVal: { fontSize: 14, fontWeight: '700', color: '#334155' },
  loadingText: { fontSize: 12, color: '#64748b' },
  errorText: { fontSize: 12, color: '#f87171', textAlign: 'center' },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    padding: 8,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  retryBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },

  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  masivoBtnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    borderRadius: 6,
    backgroundColor: '#f0f9ff',
  },
  backBtn: { padding: 4 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },

  tabsScroll: { maxHeight: 36, marginBottom: 8 },
  tabsContent: { flexDirection: 'row', gap: 4 },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  tabActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  tabText: { fontSize: 11, fontWeight: '500', color: '#64748b' },
  tabTextActive: { color: '#fff', fontWeight: '600' },

  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 10, flexWrap: 'wrap' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolbarBtnWrap: { position: 'relative' as const },
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
  toolbarBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
  },
  toolbarBtnDisabled: { opacity: 0.5 },

  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 140,
    maxWidth: 260,
    height: 32,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
  },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 12, color: '#334155', paddingVertical: 0 },

  dateFilters: { flexDirection: 'row', alignItems: 'center', gap: 6 },

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

  tableSplitWrap: { flex: 1, minHeight: 0 },
  tableSplitRow: { flexDirection: 'row', alignItems: 'stretch' },
  tableSplitCol: { flexDirection: 'column' },
  tableOuter: { flex: 1, minWidth: 0, minHeight: 0 },
  tableWrapper: { flex: 1, minHeight: 0 },
  scroll: { flex: 1, minWidth: 0 },
  scrollTable: { flex: 1, minWidth: 0 },
  /** Orden fijo de columnas (ID primero); evita que en RTL el ID quede al final */
  tableScrollLtr: { direction: 'ltr' },
  detailPanel: {
    backgroundColor: '#f8fafc',
    borderColor: '#e2e8f0',
  },
  detailPanelFlex: {
    flex: 1,
    minHeight: 0,
  },
  detailPanelSide: {
    width: 400,
    flexShrink: 0,
    alignSelf: 'stretch',
    borderLeftWidth: 1,
    minHeight: 280,
  },
  detailPanelStack: {
    width: '100%',
    maxHeight: 440,
    borderTopWidth: 1,
  },
  detailPanelTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  scrollContent: { paddingBottom: 20 },
  table: {
    flex: 1,
    minWidth: '100%' as unknown as number,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    direction: 'ltr',
  },
  tableBodyScroll: { flex: 1 },
  tableBodyContent: { paddingBottom: 20 },

  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e2e8f0',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
  },
  cellHeader: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRightWidth: 1,
    borderRightColor: '#cbd5e1',
    position: 'relative' as const,
  },
  cellHeaderText: { fontSize: 10, fontWeight: '600', color: '#334155', lineHeight: 13 },
  cellHeaderRight: { alignItems: 'flex-end' as const },
  cellHeaderTextRight: { textAlign: 'right' as const },
  resizeHandle: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
    width: 6,
    height: '100%' as unknown as number,
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
    paddingVertical: 4,
    paddingHorizontal: 7,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    justifyContent: 'center',
  },
  cellRight: { alignItems: 'flex-end' as const },
  cellText: {
    fontSize: 10,
    color: '#475569',
    lineHeight: 14,
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : {}),
  },
  cellTextRight: { textAlign: 'right' as const, alignSelf: 'stretch' as const },
  cellEmpty: {
    flex: 1,
    paddingVertical: 24,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellEmptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },

  modalOverlay: {
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
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 12 },
  modalWarningTitle: { fontSize: 13, fontWeight: '700', color: '#b45309', marginBottom: 8 },
  modalLabel: { fontSize: 12, color: '#64748b', marginBottom: 12, lineHeight: 18 },
  modalLabelMuted: { fontSize: 11, color: '#94a3b8', marginBottom: 4, lineHeight: 16, fontStyle: 'italic' },
  modalStrong: { fontWeight: '700', color: '#334155' },
  modalFieldLabel: { fontSize: 11, fontWeight: '600', color: '#334155', marginBottom: 4, marginTop: 8 },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  modalSelect: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#f8fafc',
  },
  modalSelectText: { fontSize: 13, color: '#334155' },
  dropdown: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#fff',
    marginTop: 4,
    maxHeight: 180,
  },
  dropdownItem: { paddingHorizontal: 12, paddingVertical: 8 },
  dropdownItemActive: { backgroundColor: '#e0f2fe' },
  dropdownItemText: { fontSize: 12, color: '#334155' },
  dropdownItemTextActive: { color: '#0ea5e9', fontWeight: '600' },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 16,
  },
  modalBtnCancel: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  modalBtnCancelText: { fontSize: 13, color: '#64748b', fontWeight: '500' },
  modalBtnConfirm: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  modalBtnConfirmText: { fontSize: 13, color: '#fff', fontWeight: '600' },
  modalBtnDanger: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#dc2626',
  },
  modalBtnDangerText: { fontSize: 13, color: '#fff', fontWeight: '600' },
  modalBtnDisabled: { opacity: 0.6 },

  modalDetalleModal: { maxWidth: 480 },
  modalDetalleHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  modalDetalleTitle: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 4 },
  modalDetalleSubtitle: { fontSize: 12, color: '#64748b', lineHeight: 18 },
  modalDetalleClose: { padding: 4, marginTop: -4 },

  cellPagadoRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, justifyContent: 'flex-end' },
  cellTextFlex: { flex: 1, minWidth: 0 },
  cellPagadoIconBtn: { padding: 2 },
});
