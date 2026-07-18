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
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { BadgeEstado } from '../../components/BadgeEstado';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { SelectorDesplegableMulti } from '../../components/SelectorDesplegableMulti';
import {
  colorEstado,
  ESTADOS_IN,
  formatMoneda,
  FORMAS_PAGO,
  labelFormaPago,
  mapTipoReciboToFormaPago,
  resolveMetodoPagoParaEnvio,
} from '../../utils/facturacion';
import type { FacturaListado } from '../../types/factura';
import {
  formatFecha,
  fechaEmisionFacturaAIso,
  textoFechaContabilizacionGasto,
} from '../../utils/formatFecha';
import { hoyISO } from '../../utils/facturaFormLogic';
import { getTipoReciboFromEmpresasList, listProveedoresNoTransferenciaRemesa, filtrarFacturasPorColaPago, type EmpresaConTipoRecibo, type FiltroColaPago } from '../../utils/empresaTipoRecibo';
import { useLocalToast } from '../../components/Toast';
import { useConfirmar } from '../../hooks/useConfirmar';
import { ModalDetallePagosTabla } from '../../components/ModalDetallePagosTabla';
import { FacturaDetalleModal } from '../../components/FacturaDetalleModal';
import { apiFetch } from '../../utils/api';
import { ESTADOS_FACTURA_REMESABLES, esFacturaSeleccionableEnListado } from '../../lib/remesas';
import { descargarAdjuntoFacturaRecibida } from '../../lib/descargarAdjuntoFactura';
import { textoTrimestreFactura, trimestreDesdeFechaEmision } from '../../lib/idDocumentoFactura';

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

function trimestreComparable(raw: string | undefined | null): string {
  const t = trimestreDesdeFechaEmision(raw);
  if (!t) return '';
  return `${t.anio}-${t.trimestre}`;
}

/** T1 azul · T2 amarillo · T3 verde · T4 morado (tonos pastel). */
function estiloChipTrimestre(trimestre: number): { bg: string; text: string; border: string } {
  switch (trimestre) {
    case 1:
      return { bg: '#dbeafe', text: '#1e40af', border: '#bfdbfe' };
    case 2:
      return { bg: '#fef9c3', text: '#854d0e', border: '#fde68a' };
    case 3:
      return { bg: '#dcfce7', text: '#166534', border: '#bbf7d0' };
    case 4:
      return { bg: '#ede9fe', text: '#5b21b6', border: '#ddd6fe' };
    default:
      return { bg: '#f1f5f9', text: '#64748b', border: '#e2e8f0' };
  }
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
function tipoIvaImplicitoPct(f: FacturaListado): number | null {
  const base = Number(f.base_imponible) || 0;
  const iva = Number(f.total_iva) || 0;
  if (base === 0) return null;
  return Math.round((10000 * iva) / base) / 100;
}

function formatoTipoIvaPct(f: FacturaListado): string {
  const p = tipoIvaImplicitoPct(f);
  if (p == null) return '—';
  const s = Number.isInteger(p) ? String(p) : p.toFixed(2).replace('.', ',');
  return `${s} %`;
}

type TabEstado = 'todas' | (typeof ESTADOS_IN)[number];

const TABS: { key: TabEstado; label: string }[] = [
  { key: 'todas', label: 'Todas' },
  { key: 'borrador', label: 'Borrador' },
  { key: 'pendiente_revision', label: 'Pte. revisión' },
  { key: 'pendiente_pago', label: 'Pte. pago' },
  { key: 'parcialmente_pagada', label: 'Parcial pagada' },
  { key: 'vencida', label: 'Vencida' },
  { key: 'pagada', label: 'Pagada' },
  { key: 'anulada', label: 'Anulada' },
];

const ESTADOS_GASTO_CHIP = new Set<string>(ESTADOS_IN);

const FILTER_FIELD_HEIGHT = 32;

function empresaFiltroKey(f: FacturaListado): string {
  const id = String(f.emisor_id ?? '').trim();
  if (id) return id;
  return String(f.emisor_nombre ?? '').trim();
}

function pastelChipEstado(key: TabEstado): { bg: string; text: string; border: string } {
  if (key === 'todas') return { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1' };
  const { bg, text } = colorEstado(key);
  const border = key === 'parcialmente_pagada' ? '#fed7aa' : bg;
  return { bg, text, border };
}

const COLUMNAS = [
  'id_factura',
  'fecha_emision',
  'trimestre',
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
  'fecha_contabilizacion',
] as const;

const COL_LABELS: Record<string, string> = {
  id_factura: 'ID',
  fecha_emision: 'Fecha',
  trimestre: 'Trimestre',
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
  id_factura: 74,
  fecha_emision: 82,
  trimestre: 72,
  fecha_contabilizacion: 180,
  emisor_nombre: 150,
  empresa_nombre: 140,
  empresa_cif: 92,
  numero_factura_proveedor: 118,
  base_imponible: 88,
  iva_tipo: 48,
  total_iva: 68,
  total_retencion: 80,
  total_factura: 88,
  estado: 100,
  pagado: 108,
  saldo_pendiente: 88,
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
  { id: 'validar', icon: 'task-alt', label: 'Validar revisión', permiso: 'facturacion.emitir', needsSelection: true },
  { id: 'borrar', icon: 'delete-outline', label: 'Borrar', permiso: 'facturacion.editar', needsSelection: true },
  { id: 'pagar', icon: 'payments', label: 'Pagar', permiso: 'facturacion.cobrar_pagar', needsSelection: true },
  { id: 'refresh', icon: 'refresh', label: 'Actualizar', permiso: '', needsSelection: false },
  { id: 'ver_doc', icon: 'download', label: 'Descargar documento', permiso: '', needsSelection: true },
];

export default function FacturasGastoScreen() {
  const router = useRouter();
  const searchParams = useLocalSearchParams<{ modalFactura?: string; maestroActualizado?: string }>();
  const { hasPermiso, user } = useAuth();
  const { width: winW } = useWindowDimensions();
  const layoutSplit = Platform.OS === 'web' && winW >= 1024;
  const { show: showToast, ToastView } = useLocalToast();
  const { confirmar, ConfirmarView } = useConfirmar();

  const [facturas, setFacturas] = useState<FacturaListado[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tabActivo, setTabActivo] = useState<TabEstado>('todas');
  const [busqueda, setBusqueda] = useState('');
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [empresasFiltroIds, setEmpresasFiltroIds] = useState<string[]>([]);
  const [anioFiltro, setAnioFiltro] = useState(() => String(new Date().getFullYear()));
  const [filtroColaPago, setFiltroColaPago] = useState<FiltroColaPago>('todos');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalFacturaId, setModalFacturaId] = useState<string | null>(null);
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
  const [empresasCatalogo, setEmpresasCatalogo] = useState<EmpresaConTipoRecibo[]>([]);

  const [modalDetallePagosVisible, setModalDetallePagosVisible] = useState(false);
  const [detallePagosLoading, setDetallePagosLoading] = useState(false);
  const [detallePagosError, setDetallePagosError] = useState<string | null>(null);
  const [detallePagosLista, setDetallePagosLista] = useState<Record<string, unknown>[]>([]);
  const [detallePagosFactura, setDetallePagosFactura] = useState<FacturaListado | null>(null);

  const [modoSeleccion, setModoSeleccion] = useState(false);
  const [selectedMultiIds, setSelectedMultiIds] = useState<Set<string>>(new Set());
  const [modalRemesa, setModalRemesa] = useState(false);
  const [remesaNombre, setRemesaNombre] = useState('');
  const [remesaFechaEjecucion, setRemesaFechaEjecucion] = useState('');
  const [resyncMaestroToken, setResyncMaestroToken] = useState(0);
  const maestroToastRef = useRef(false);

  const puedeModoSeleccion = hasPermiso('facturacion.emitir') || hasPermiso('remesas.gestionar');

  const fetchFacturas = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch(`/api/facturacion/facturas?tipo=IN`)
      .then((r) => {
        if (!r.ok) throw new Error(`Error ${r.status}`);
        return r.json();
      })
      .then((data) => setFacturas(data.facturas || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchFacturas(); }, [fetchFacturas]);

  // Refrescar al volver de la ficha completa: sin esto el listado mostraba
  // datos antiguos tras guardar y parecía que el cambio no se había guardado.
  const primerFocoListado = useRef(true);
  useFocusEffect(
    useCallback(() => {
      const modalId = (
        Array.isArray(searchParams.modalFactura)
          ? searchParams.modalFactura[0]
          : searchParams.modalFactura
      )?.trim() ?? '';
      const maestroOk = (
        Array.isArray(searchParams.maestroActualizado)
          ? searchParams.maestroActualizado[0]
          : searchParams.maestroActualizado
      ) === '1';

      if (modalId || maestroOk) {
        if (modalId) {
          setModalFacturaId(modalId);
          setSelectedId(modalId);
        }
        if (maestroOk) {
          setResyncMaestroToken((t) => t + 1);
          if (!maestroToastRef.current) {
            maestroToastRef.current = true;
            showToast(
              'Maestro actualizado',
              'Revisa empresa o proveedor en la factura si cambió algún dato.',
              'info',
            );
            setTimeout(() => {
              maestroToastRef.current = false;
            }, 800);
          }
        }
        router.replace('/facturacion/facturas-gasto' as never);
      }

      if (primerFocoListado.current) {
        primerFocoListado.current = false;
        if (modalId || maestroOk) fetchFacturas();
        return;
      }
      fetchFacturas();
    }, [fetchFacturas, searchParams.modalFactura, searchParams.maestroActualizado, router, showToast]),
  );

  useEffect(() => {
    apiFetch('/api/empresas')
      .then((r) => r.json())
      .then((d) => {
        const raw: unknown[] = d.empresas ?? d ?? [];
        setEmpresasCatalogo(
          raw.map((item): EmpresaConTipoRecibo => {
            const e = (item ?? {}) as Record<string, unknown>;
            const tipoReciboRaw = e['Tipo de recibo'];
            return {
              id_empresa: e.id_empresa != null ? String(e.id_empresa) : '',
              Cif: e.Cif != null ? String(e.Cif).trim() : e.cif != null ? String(e.cif).trim() : '',
              tipoRecibo: tipoReciboRaw != null ? String(tipoReciboRaw).trim() : undefined,
              'Tipo de recibo': typeof tipoReciboRaw === 'string' ? tipoReciboRaw : undefined,
            };
          }),
        );
      })
      .catch(() => {});
  }, []);

  const toggleSort = useCallback((col: string) => {
    if (sortCol === col) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }, [sortCol]);

  const empresasFiltroOpciones = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of facturas) {
      const key = empresaFiltroKey(f);
      const nombre = String(f.emisor_nombre || '—').trim();
      if (key) map.set(key, nombre);
    }
    return [...map.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], 'es'))
      .map(([id, titulo]) => ({ id, titulo, icono: 'business' as const }));
  }, [facturas]);

  const aniosFiltroOpciones = useMemo(() => {
    const set = new Set<number>();
    set.add(new Date().getFullYear());
    for (const f of facturas) {
      const iso = fechaEmisionComparable(f.fecha_emision);
      if (!iso || iso.length < 4) continue;
      const y = parseInt(iso.slice(0, 4), 10);
      if (Number.isFinite(y) && y >= 2000 && y <= 2100) set.add(y);
    }
    return [...set]
      .sort((a, b) => b - a)
      .map((y) => ({ id: String(y), titulo: String(y), icono: 'calendar-today' as const }));
  }, [facturas]);

  const facturasBaseFiltradas = useMemo(() => {
    let list = facturas;
    if (anioFiltro) {
      list = list.filter((f) => {
        const iso = fechaEmisionComparable(f.fecha_emision);
        return iso.length >= 4 && iso.slice(0, 4) === anioFiltro;
      });
    }
    if (empresasFiltroIds.length > 0) {
      const set = new Set(empresasFiltroIds);
      list = list.filter((f) => set.has(empresaFiltroKey(f)));
    }
    if (fechaDesde) {
      list = list.filter((f) => (fechaEmisionComparable(f.fecha_emision) || '') >= fechaDesde);
    }
    if (fechaHasta) {
      list = list.filter((f) => (fechaEmisionComparable(f.fecha_emision) || '') <= fechaHasta);
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
    return list;
  }, [facturas, anioFiltro, empresasFiltroIds, fechaDesde, fechaHasta, busqueda]);

  const conteosPorTab = useMemo(() => {
    const counts = Object.fromEntries(TABS.map((t) => [t.key, 0])) as Record<TabEstado, number>;
    counts.todas = facturasBaseFiltradas.length;
    for (const f of facturasBaseFiltradas) {
      const estado = String(f.estado ?? '').trim();
      if (ESTADOS_GASTO_CHIP.has(estado)) {
        counts[estado as TabEstado] += 1;
      }
    }
    return counts;
  }, [facturasBaseFiltradas]);

  const filtradas = useMemo(() => {
    let list = facturasBaseFiltradas;
    if (tabActivo !== 'todas') list = list.filter((f) => f.estado === tabActivo);
    list = filtrarFacturasPorColaPago(list, filtroColaPago, empresasCatalogo);
    if (sortCol) {
      list = [...list].sort((a, b) => {
        if (sortCol === 'fecha_emision') {
          const fa = fechaEmisionComparable(a.fecha_emision);
          const fb = fechaEmisionComparable(b.fecha_emision);
          const cmp = fa.localeCompare(fb);
          return sortDir === 'desc' ? -cmp : cmp;
        }
        if (sortCol === 'trimestre') {
          const cmp = trimestreComparable(a.fecha_emision).localeCompare(trimestreComparable(b.fecha_emision));
          return sortDir === 'desc' ? -cmp : cmp;
        }
        if (sortCol === 'fecha_contabilizacion') {
          const fa = String(a.fecha_contabilizacion || a.creado_en || '');
          const fb = String(b.fecha_contabilizacion || b.creado_en || '');
          const cmp = fa.localeCompare(fb);
          return sortDir === 'desc' ? -cmp : cmp;
        }
        if (sortCol === 'iva_tipo') {
          const pa = tipoIvaImplicitoPct(a);
          const pb = tipoIvaImplicitoPct(b);
          const na = pa ?? -1;
          const nb = pb ?? -1;
          const cmp = na - nb;
          return sortDir === 'desc' ? -cmp : cmp;
        }
        if (sortCol === 'pagado') {
          const na = Number(a.total_cobrado ?? 0);
          const nb = Number(b.total_cobrado ?? 0);
          const cmp = na - nb;
          return sortDir === 'desc' ? -cmp : cmp;
        }
        const va = (a as Record<string, unknown>)[sortCol] ?? '';
        const vb = (b as Record<string, unknown>)[sortCol] ?? '';
        const numA = typeof va === 'number' ? va : parseFloat(String(va));
        const numB = typeof vb === 'number' ? vb : parseFloat(String(vb));
        let cmp: number;
        if (!isNaN(numA) && !isNaN(numB)) cmp = numA - numB;
        else cmp = String(va).localeCompare(String(vb), 'es', { sensitivity: 'base' });
        return sortDir === 'desc' ? -cmp : cmp;
      });
    }
    return list;
  }, [facturasBaseFiltradas, tabActivo, filtroColaPago, empresasCatalogo, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtradas.length / PAGE_SIZE));
  const pageClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const paginadas = filtradas.slice(pageClamped * PAGE_SIZE, (pageClamped + 1) * PAGE_SIZE);

  useEffect(() => {
    setPageIndex(0);
    setSelectedId(null);
  }, [tabActivo, busqueda, fechaDesde, fechaHasta, empresasFiltroIds, anioFiltro, filtroColaPago]);

  const selectedFactura: FacturaListado | null = useMemo(
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

  const getCellValue = (f: FacturaListado, col: string): string => {
    if (col === 'fecha_contabilizacion') {
      return textoFechaContabilizacionGasto({
        fechaContabilizacion: f.fecha_contabilizacion,
        contabilizadoPor: f.contabilizado_por,
        creadoEn: f.creado_en,
      });
    }
    if (col === 'trimestre') return textoTrimestreFactura(f.fecha_emision);
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

  const abrirModalDetallePagos = useCallback((factura: FacturaListado) => {
    setDetallePagosFactura(factura);
    setModalDetallePagosVisible(true);
    setDetallePagosLoading(true);
    setDetallePagosError(null);
    setDetallePagosLista([]);
    apiFetch(`/api/facturacion/facturas/${factura.id_factura}/pagos`)
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
    setPagoFechaEditadaManual(false);
    setPagoImporte(String(selectedFactura.saldo_pendiente ?? 0));
    setPagoReferencia('');

    const tipoRecibo = getTipoReciboFromEmpresasList(empresasCatalogo, selectedFactura.empresa_id);
    const { clave, otroTexto } = mapTipoReciboToFormaPago(tipoRecibo);
    setPagoMetodo(clave);
    setPagoMetodoOtro(clave === 'otro' ? otroTexto : '');

    const hoy = hoyISO();
    const fechaFactura = fechaEmisionFacturaAIso(selectedFactura.fecha_emision ?? '') ?? hoy;
    setPagoFecha(clave === 'tarjeta' ? fechaFactura : hoy);

    setModalPagar(true);
  };

  const onCambiarMetodoPago = (m: string) => {
    setPagoMetodo(m);
    if (m !== 'otro') setPagoMetodoOtro('');
    if (!selectedFactura || pagoFechaEditadaManual) return;
    const hoy = hoyISO();
    const fechaFactura = fechaEmisionFacturaAIso(selectedFactura.fecha_emision ?? '') ?? hoy;
    setPagoFecha(m === 'tarjeta' ? fechaFactura : hoy);
  };

  const verDocumento = async () => {
    if (!selectedFactura) return;
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${selectedFactura.id_factura}/adjuntos`);
      const data = await res.json();
      const adjuntos = data.adjuntos ?? [];
      if (adjuntos.length === 0) {
        showToast('Sin documento', 'Esta factura no tiene documento adjunto', 'warning');
        return;
      }
      await descargarAdjuntoFacturaRecibida(selectedFactura.id_factura, adjuntos[0].id);
      showToast('Descargado', 'Documento guardado con id_Documento', 'success');
    } catch (e) {
      showToast('Error', (e as Error).message || 'No se pudo descargar el documento', 'error');
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
    if (id === 'validar') { handleValidarRevision(); return; }
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
    await ejecutarValidacionOEmision('emitir');
  };

  const handleValidarRevision = async () => {
    if (!selectedFactura) return;
    if (selectedFactura.estado !== 'pendiente_revision') {
      showToast('Aviso', 'Solo facturas pendientes de revisión (p. ej. importadas por OCR)', 'warning');
      return;
    }
    await ejecutarValidacionOEmision('validar');
  };

  const ejecutarValidacionOEmision = async (modo: 'emitir' | 'validar') => {
    if (!selectedFactura) return;
    setProcesando(true);
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${selectedFactura.id_factura}/emitir`, {
        method: 'POST',
        body: JSON.stringify({
          usuario_id: user?.id_usuario ?? '',
          usuario_nombre: user?.Nombre ?? '',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const detalle = Array.isArray(data.errores) ? data.errores.join(' · ') : (data.error || 'Error');
        throw new Error(detalle);
      }
      fetchFacturas();
      setSelectedId(null);
      showToast(
        modo === 'validar' ? 'Validada' : 'Emitida',
        modo === 'validar'
          ? 'La factura ya está pendiente de pago'
          : 'Factura emitida correctamente',
        'success',
      );
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error al procesar la factura', 'error');
    } finally {
      setProcesando(false);
    }
  };

  const handleBorrarDefinitivo = async () => {
    if (!selectedFactura) return;
    setProcesando(true);
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${selectedFactura.id_factura}`, {
        method: 'DELETE',
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
    const fechaIso = pagoFecha.trim();
    if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) { showToast('Aviso', 'Indica una fecha válida', 'warning'); return; }
    const metodoEnvio = resolveMetodoPagoParaEnvio(pagoMetodo, pagoMetodoOtro);
    if (metodoEnvio == null) {
      showToast('Aviso', 'Describe el método de pago si eliges «Otro»', 'warning');
      return;
    }
    setProcesando(true);
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${selectedFactura.id_factura}/pagos`, {
        method: 'POST',
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
    if (modoSeleccion && btn.needsSelection) return true;
    if (btn.needsSelection && selectedId == null) return true;
    if (btn.id === 'emitir' && selectedFactura?.estado !== 'borrador') return true;
    if (btn.id === 'validar' && selectedFactura?.estado !== 'pendiente_revision') return true;
    if (btn.id === 'pagar' && selectedFactura && (selectedFactura.estado === 'anulada' || selectedFactura.estado === 'pagada' || selectedFactura.estado === 'borrador')) return true;
    return false;
  };

  const facturasSeleccionadas = useMemo(
    () => filtradas.filter((f) => selectedMultiIds.has(f.id_factura)),
    [filtradas, selectedMultiIds],
  );

  const facturasSeleccionadasRemesa = useMemo(
    () => facturasSeleccionadas.filter((f) => ESTADOS_FACTURA_REMESABLES.has(f.estado || '')),
    [facturasSeleccionadas],
  );

  const facturasSeleccionadasRevision = useMemo(
    () => facturasSeleccionadas.filter((f) => f.estado === 'pendiente_revision'),
    [facturasSeleccionadas],
  );

  const sociedadRemesa = useMemo(() => {
    const ids = new Set(facturasSeleccionadasRemesa.map((f) => f.emisor_id).filter(Boolean));
    if (ids.size !== 1) return null;
    const f0 = facturasSeleccionadasRemesa[0];
    return {
      id: String(f0?.emisor_id || ''),
      nombre: String(f0?.emisor_nombre || ''),
    };
  }, [facturasSeleccionadasRemesa]);

  const proveedoresNoTransferenciaRemesa = useMemo(
    () => listProveedoresNoTransferenciaRemesa(facturasSeleccionadasRemesa, empresasCatalogo),
    [facturasSeleccionadasRemesa, empresasCatalogo],
  );

  const toggleSeleccionMulti = (id: string) => {
    setSelectedMultiIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const entrarModoSeleccionConFactura = (id: string, estado?: string | null) => {
    if (!puedeModoSeleccion) return;
    setModoSeleccion(true);
    if (esFacturaSeleccionableEnListado(estado)) {
      setSelectedMultiIds((prev) => new Set(prev).add(id));
    }
  };

  const abrirModalCrearRemesa = () => {
    if (facturasSeleccionadasRemesa.length === 0) {
      showToast('Aviso', 'Selecciona facturas pendientes de pago, parcialmente pagadas o vencidas', 'warning');
      return;
    }
    if (!sociedadRemesa) {
      showToast('Aviso', 'Todas las facturas deben ser de la misma empresa (sociedad ordenante)', 'warning');
      return;
    }
    const hoy = new Date();
    const defNombre = `Pagos proveedores ${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}`;
    setRemesaNombre(defNombre);
    setRemesaFechaEjecucion('');
    setModalRemesa(true);
  };

  const crearRemesa = async () => {
    if (!sociedadRemesa || facturasSeleccionadasRemesa.length === 0) return;
    const nombre = remesaNombre.trim();
    if (!nombre) {
      showToast('Aviso', 'Indica un nombre para la remesa', 'warning');
      return;
    }

    if (proveedoresNoTransferenciaRemesa.length > 0) {
      const lista = proveedoresNoTransferenciaRemesa
        .slice(0, 5)
        .map((p) => `· ${p.nombre} (${p.tipoReciboLabel})`)
        .join('\n');
      const extra = proveedoresNoTransferenciaRemesa.length > 5
        ? `\n… y ${proveedoresNoTransferenciaRemesa.length - 5} más`
        : '';
      const ok = await confirmar(
        'Tipo de recibo distinto de transferencia',
        `${proveedoresNoTransferenciaRemesa.length} proveedor${proveedoresNoTransferenciaRemesa.length !== 1 ? 'es' : ''} no tienen «Transferencia» en su ficha:\n\n${lista}${extra}\n\nPuedes crear la remesa igualmente. ¿Continuar?`,
        { confirmarLabel: 'Crear remesa' },
      );
      if (!ok) return;
    }

    setProcesando(true);
    try {
      const res = await apiFetch('/api/remesas', {
        method: 'POST',
        body: JSON.stringify({
          nombre,
          sociedadId: sociedadRemesa.id,
          facturaIds: facturasSeleccionadasRemesa.map((f) => f.id_factura),
          fechaEjecucion: remesaFechaEjecucion || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al crear remesa');
      setModalRemesa(false);
      setModoSeleccion(false);
      setSelectedMultiIds(new Set());
      if (data.excluidas?.length) {
        showToast('Remesa creada', `${data.excluidas.length} factura(s) excluida(s)`, 'warning');
      } else {
        showToast('Remesa creada', 'Redirigiendo al detalle…', 'success');
      }
      router.push(`/facturacion/remesas/${data.remesa.remesaId}` as never);
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'No se pudo crear la remesa', 'error');
    } finally {
      setProcesando(false);
    }
  };

  const validarRevisionMasiva = async () => {
    const ids = facturasSeleccionadasRevision.map((f) => f.id_factura);
    if (ids.length === 0) {
      showToast('Aviso', 'Selecciona facturas en «Pte. revisión»', 'warning');
      return;
    }
    setProcesando(true);
    try {
      const res = await apiFetch('/api/facturacion/facturas/validar-revision', {
        method: 'POST',
        body: JSON.stringify({
          facturaIds: ids,
          usuario_id: user?.id_usuario ?? '',
          usuario_nombre: user?.Nombre ?? '',
        }),
        timeoutMs: 120_000,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al validar');
      fetchFacturas();
      setSelectedMultiIds(new Set());
      if (data.fallidas > 0) {
        const detalle = (data.detalleFallidas || [])
          .slice(0, 3)
          .map((x: { id_factura: string; motivo: string }) => `${x.id_factura}: ${x.motivo}`)
          .join('\n');
        showToast(
          'Validación parcial',
          `${data.validadas} validada(s), ${data.fallidas} con error.${detalle ? ` ${detalle}` : ''}`,
          'warning',
        );
      } else {
        showToast('Validadas', `${data.validadas} factura(s) pendientes de pago`, 'success');
      }
      if (data.validadas > 0 && data.fallidas === 0) {
        setModoSeleccion(false);
      }
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error al validar revisiones', 'error');
    } finally {
      setProcesando(false);
    }
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
        <View style={styles.headerActions}>
          {hasPermiso('remesas.ver') ? (
            <TouchableOpacity
              style={styles.masivoBtnHeader}
              onPress={() => router.push('/facturacion/remesas' as never)}
            >
              <MaterialIcons name="account-balance" size={16} color="#0ea5e9" />
              <Text style={styles.headerActionText}>Remesas de pago</Text>
            </TouchableOpacity>
          ) : null}
          {hasPermiso('facturacion.crear') ? (
            <TouchableOpacity
              style={styles.registroMasivoBtnHeader}
              onPress={() => router.push('/facturacion/registro-masivo' as any)}
            >
              <MaterialIcons name="upload-file" size={16} color="#5b21b6" />
              <Text style={styles.registroMasivoBtnText}>Registro masivo</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <View style={styles.filtrosRow}>
        {empresasFiltroOpciones.length > 0 ? (
          <SelectorDesplegableMulti
            style={styles.empresaFiltroSelector}
            placeholder="Todas las empresas"
            icono="business"
            tituloLista="Filtrar por empresa"
            iconoLista="business"
            buscador
            buscadorPlaceholder="Buscar empresa…"
            valorIds={empresasFiltroIds}
            opciones={empresasFiltroOpciones}
            onChange={setEmpresasFiltroIds}
            vacioTexto="No hay empresas en el listado."
          />
        ) : null}
        <SelectorDesplegable
          style={styles.anioFiltroSelector}
          placeholder="Año"
          icono="calendar-today"
          tituloLista="Filtrar por año"
          iconoLista="calendar-today"
          valorId={anioFiltro}
          opciones={aniosFiltroOpciones}
          onSeleccionar={setAnioFiltro}
        />
      </View>

      {/* Chips de estado */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabsContent}>
        {TABS.map((t) => {
          const pastel = pastelChipEstado(t.key);
          const activo = tabActivo === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={[
                styles.estadoChip,
                { backgroundColor: pastel.bg, borderColor: activo ? pastel.text : pastel.border },
                activo && styles.estadoChipActive,
              ]}
              onPress={() => setTabActivo(t.key)}
              activeOpacity={0.7}
            >
              <Text style={[styles.estadoChipText, { color: pastel.text }, activo && styles.estadoChipTextActive]}>
                {t.label}
              </Text>
              <View style={[styles.estadoChipCount, { backgroundColor: activo ? pastel.text : 'rgba(15, 23, 42, 0.08)' }]}>
                <Text style={[styles.estadoChipCountText, { color: activo ? '#fff' : pastel.text }]}>
                  {conteosPorTab[t.key]}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Filtro cola de pago (forma de pago / tipo de recibo) */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabsContent}>
        {([
          { id: 'todos' as FiltroColaPago, label: 'Todos los métodos' },
          { id: 'cola_transferencia' as FiltroColaPago, label: 'Cola transferencia' },
          { id: 'otro_metodo' as FiltroColaPago, label: 'Otros métodos' },
        ]).map((f) => {
          const activo = filtroColaPago === f.id;
          return (
            <TouchableOpacity
              key={f.id}
              style={[
                styles.colaPagoChip,
                activo && styles.colaPagoChipActive,
              ]}
              onPress={() => setFiltroColaPago(f.id)}
              activeOpacity={0.7}
            >
              <MaterialIcons
                name={f.id === 'cola_transferencia' ? 'account-balance' : f.id === 'otro_metodo' ? 'credit-card' : 'filter-list'}
                size={14}
                color={activo ? '#0369a1' : '#64748b'}
              />
              <Text style={[styles.colaPagoChipText, activo && styles.colaPagoChipTextActive]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          );
        })}
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
          {puedeModoSeleccion ? (
            <>
              <View
                style={styles.toolbarBtnWrap}
                {...(Platform.OS === 'web' ? { onMouseEnter: () => setHoveredBtn('sel_mode'), onMouseLeave: () => setHoveredBtn(null) } as object : {})}
              >
                {hoveredBtn === 'sel_mode' && (
                  <View style={styles.tooltip}><Text style={styles.tooltipText}>Selección múltiple</Text></View>
                )}
                <TouchableOpacity
                  style={[styles.toolbarBtn, modoSeleccion && styles.toolbarBtnActive]}
                  onPress={() => {
                    setModoSeleccion((m) => !m);
                    if (modoSeleccion) setSelectedMultiIds(new Set());
                  }}
                >
                  <MaterialIcons name="checklist" size={18} color={modoSeleccion ? '#fff' : '#0ea5e9'} />
                </TouchableOpacity>
              </View>
              {modoSeleccion ? (
                <View style={styles.modoSeleccionAcciones}>
                  {hasPermiso('facturacion.emitir') ? (
                    <TouchableOpacity
                      style={[
                        styles.validarMasivoBtn,
                        facturasSeleccionadasRevision.length === 0 && styles.toolbarBtnDisabled,
                      ]}
                      onPress={validarRevisionMasiva}
                      disabled={facturasSeleccionadasRevision.length === 0 || procesando}
                    >
                      <MaterialIcons name="task-alt" size={16} color="#fff" />
                      <Text style={styles.validarMasivoBtnText}>
                        Validar revisión ({facturasSeleccionadasRevision.length})
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                  {hasPermiso('remesas.gestionar') ? (
                    <TouchableOpacity
                      style={[
                        styles.remesaCrearBtn,
                        facturasSeleccionadasRemesa.length === 0 && styles.toolbarBtnDisabled,
                      ]}
                      onPress={abrirModalCrearRemesa}
                      disabled={facturasSeleccionadasRemesa.length === 0 || procesando}
                    >
                      <MaterialIcons name="account-balance" size={16} color="#fff" />
                      <Text style={styles.remesaCrearBtnText}>
                        Crear remesa ({facturasSeleccionadasRemesa.length})
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
            </>
          ) : null}
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
          <View style={styles.dateFilterCell}>
            <InputFecha
              compact
              valueIso={fechaDesde}
              onChangeIso={setFechaDesde}
              placeholder="Desde"
              style={styles.dateFilterInput}
            />
          </View>
          <View style={styles.dateFilterCell}>
            <InputFecha
              compact
              valueIso={fechaHasta}
              onChangeIso={setFechaHasta}
              placeholder="Hasta"
              style={styles.dateFilterInput}
            />
          </View>
        </View>
      </View>

      {/* Resumen rápido */}
      {filtradas.length > 0 && (
        <View style={styles.resumenRow}>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Total gastos</Text>
            <Text style={[styles.resumenVal, { color: '#dc2626' }]}>
              {formatMoneda(filtradas.reduce((s: number, f: FacturaListado) => s + (Number(f.total_factura) || 0), 0))}
            </Text>
          </View>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Pendiente pago</Text>
            <Text style={[styles.resumenVal, { color: '#b45309' }]}>
              {formatMoneda(filtradas.reduce((s: number, f: FacturaListado) => s + (Number(f.saldo_pendiente) || 0), 0))}
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
              <View style={styles.actionHeaderCell} />
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
                    <MaterialIcons name={sortDir === 'asc' ? 'arrow-upward' : 'arrow-downward'} size={10} color="#334155" />
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
                      {facturas.length === 0
                        ? 'No hay facturas de gasto'
                        : busqueda.trim() || fechaDesde || fechaHasta || empresasFiltroIds.length > 0 || tabActivo !== 'todas' || filtroColaPago !== 'todos'
                          ? 'Ningún resultado con los filtros aplicados'
                          : `No hay facturas de gasto en ${anioFiltro}`}
                    </Text>
                  </View>
                </View>
              ) : (
                paginadas.map((f) => {
                  const seleccionable = esFacturaSeleccionableEnListado(f.estado);
                  return (
                  <Pressable
                    key={f.id_factura}
                    style={[
                      styles.row,
                      selectedId === f.id_factura && !modoSeleccion && styles.rowSelected,
                      modoSeleccion && selectedMultiIds.has(f.id_factura) && styles.rowSelected,
                    ]}
                    onPress={() => {
                      if (modoSeleccion) {
                        if (seleccionable) toggleSeleccionMulti(f.id_factura);
                        return;
                      }
                      setSelectedId(selectedId === f.id_factura ? null : f.id_factura);
                    }}
                    onLongPress={() => entrarModoSeleccionConFactura(f.id_factura, f.estado)}
                    delayLongPress={450}
                  >
                    <View style={styles.actionCell}>
                      {modoSeleccion ? (
                        <Pressable
                          hitSlop={8}
                          onPress={(e) => {
                            absorberClickFila(e);
                            if (seleccionable) toggleSeleccionMulti(f.id_factura);
                          }}
                          style={styles.actionBtn}
                        >
                          <MaterialIcons
                            name={selectedMultiIds.has(f.id_factura) ? 'check-box' : 'check-box-outline-blank'}
                            size={18}
                            color={seleccionable ? '#0ea5e9' : '#cbd5e1'}
                          />
                        </Pressable>
                      ) : (
                      <Pressable
                        hitSlop={8}
                        accessibilityLabel="Ver detalle y documento"
                        onPress={(e) => {
                          absorberClickFila(e);
                          setSelectedId(f.id_factura);
                          setModalFacturaId(f.id_factura);
                        }}
                        style={styles.actionBtn}
                      >
                        <MaterialIcons name="vertical-split" size={16} color="#0369a1" />
                      </Pressable>
                      )}
                    </View>
                    {COLUMNAS.map((col) => {
                      if (col === 'trimestre') {
                        const t = trimestreDesdeFechaEmision(f.fecha_emision);
                        const label = textoTrimestreFactura(f.fecha_emision);
                        const chip = t ? estiloChipTrimestre(t.trimestre) : null;
                        return (
                          <View key={col} style={[styles.cell, { width: getColWidth(col) }]}>
                            {chip ? (
                              <View style={[styles.trimestreChip, { backgroundColor: chip.bg, borderColor: chip.border }]}>
                                <Text style={[styles.trimestreChipText, { color: chip.text }]} numberOfLines={1}>
                                  {label}
                                </Text>
                              </View>
                            ) : (
                              <Text style={styles.cellText}>{label}</Text>
                            )}
                          </View>
                        );
                      }
                      if (col === 'estado') {
                        return (
                          <View key={col} style={[styles.cell, { width: getColWidth(col) }]}>
                            <BadgeEstado estado={f.estado ?? ''} compact />
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
                          <Text
                            style={[
                              styles.cellText,
                              isMoneda && styles.cellTextRight,
                              col === 'total_factura' && styles.cellTextBold,
                              col === 'numero_factura_proveedor' && styles.cellTextBold,
                            ]}
                            numberOfLines={1}
                            ellipsizeMode="tail"
                          >
                            {getCellValue(f, col)}
                          </Text>
                        </View>
                      );
                    })}
                  </Pressable>
                  );
                })
              )}
            </ScrollView>
          </View>
        </ScrollView>
          </View>
        </View>
      </View>

      {/* Modal detalle + previsualización del documento */}
      <FacturaDetalleModal
        apiUrl={API_URL}
        facturaId={modalFacturaId}
        tipoFactura="IN"
        puedeEditar={hasPermiso('facturacion.editar')}
        usuarioId={user?.id_usuario}
        usuarioNombre={user?.Nombre}
        onClose={() => setModalFacturaId(null)}
        onGuardado={fetchFacturas}
        resyncMaestroToken={resyncMaestroToken}
        onAbrirCompleto={(id) =>
          router.push(`/facturacion/factura-detalle?id=${id}&modo=editar&tipo=IN` as never)
        }
      />

      {/* Modal crear remesa */}
      <Modal visible={modalRemesa} transparent animationType="fade" onRequestClose={() => !procesando && setModalRemesa(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => !procesando && setModalRemesa(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Crear remesa de pago</Text>
            <Text style={styles.modalLabel}>
              {facturasSeleccionadasRemesa.length} factura(s) · Sociedad: {sociedadRemesa?.nombre || '—'}
            </Text>
            {proveedoresNoTransferenciaRemesa.length > 0 ? (
              <View style={styles.modalAvisoTipoRecibo}>
                <MaterialIcons name="warning-amber" size={18} color="#b45309" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.modalAvisoTipoReciboTitulo}>
                    {proveedoresNoTransferenciaRemesa.length} proveedor{proveedoresNoTransferenciaRemesa.length !== 1 ? 'es' : ''} sin tipo de recibo «Transferencia»
                  </Text>
                  {proveedoresNoTransferenciaRemesa.slice(0, 4).map((p) => (
                    <Text key={p.key} style={styles.modalAvisoTipoReciboLinea} numberOfLines={1}>
                      · {p.nombre} — {p.tipoReciboLabel}
                    </Text>
                  ))}
                  {proveedoresNoTransferenciaRemesa.length > 4 ? (
                    <Text style={styles.modalAvisoTipoReciboLinea}>
                      … y {proveedoresNoTransferenciaRemesa.length - 4} más
                    </Text>
                  ) : null}
                  <Text style={styles.modalAvisoTipoReciboPie}>
                    Puedes crear la remesa igualmente; revisa la ficha del proveedor si procede.
                  </Text>
                </View>
              </View>
            ) : null}
            <Text style={styles.modalFieldLabel}>Nombre de la remesa *</Text>
            <TextInput
              style={styles.modalInput}
              value={remesaNombre}
              onChangeText={setRemesaNombre}
              placeholder="Pagos proveedores…"
              placeholderTextColor="#94a3b8"
            />
            <Text style={styles.modalFieldLabel}>Fecha ejecución en banco (opcional)</Text>
            <InputFecha valueIso={remesaFechaEjecucion} onChangeIso={setRemesaFechaEjecucion} placeholder="Vacío = Ahora" />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnCancel} onPress={() => setModalRemesa(false)} disabled={procesando}>
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtnConfirm, procesando && styles.modalBtnDisabled]}
                onPress={crearRemesa}
                disabled={procesando}
              >
                {procesando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalBtnConfirmText}>Crear remesa</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

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
            <Text style={styles.modalLabel}>Factura: {selectedFactura?.id_factura} — Saldo: {selectedFactura ? formatMoneda(Number(selectedFactura.saldo_pendiente) || 0) : ''}</Text>

            <Text style={styles.modalFieldLabel}>Fecha del pago *</Text>
            <InputFecha
              valueIso={pagoFecha}
              onChangeIso={(v) => {
                setPagoFecha(v);
                setPagoFechaEditadaManual(true);
              }}
              placeholder="dd/mm/aaaa"
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
            <SelectorDesplegable
              icono="payments"
              tituloLista="Método de pago"
              iconoLista="payments"
              valorId={pagoMetodo}
              opciones={FORMAS_PAGO.map((m) => ({ id: m, titulo: labelFormaPago(m), icono: 'payments' as const }))}
              onSeleccionar={(id) => onCambiarMetodoPago(id)}
            />
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
      {ConfirmarView}
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
    flexShrink: 1,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  headerActionText: { fontSize: 11, color: '#0ea5e9', fontWeight: '500' },
  masivoBtnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    borderRadius: 6,
    backgroundColor: '#f0f9ff',
  },
  registroMasivoBtnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#ddd6fe',
    borderRadius: 6,
    backgroundColor: '#ede9fe',
  },
  registroMasivoBtnText: { fontSize: 11, color: '#5b21b6', fontWeight: '500' },
  backBtn: { padding: 4 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },

  filtrosRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  empresaFiltroSelector: { flex: 1, minWidth: 200, maxWidth: 360 },
  anioFiltroSelector: { width: 132, minWidth: 120, maxWidth: 160 },

  tabsScroll: { maxHeight: 40, marginBottom: 8 },
  tabsContent: { flexDirection: 'row', gap: 6, paddingRight: 8 },
  colaPagoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
  },
  colaPagoChipActive: {
    borderColor: '#7dd3fc',
    backgroundColor: '#e0f2fe',
  },
  colaPagoChipText: { fontSize: 11, fontWeight: '500', color: '#64748b' },
  colaPagoChipTextActive: { color: '#0369a1', fontWeight: '600' },
  estadoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  estadoChipActive: {
    borderWidth: 2,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  estadoChipText: { fontSize: 11, fontWeight: '500' },
  estadoChipTextActive: { fontWeight: '700' },
  estadoChipCount: {
    minWidth: 20,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  estadoChipCountText: { fontSize: 10, fontWeight: '700' },

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
  toolbarBtnActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  remesaCrearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0369a1',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  remesaCrearBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  modoSeleccionAcciones: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  validarMasivoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#16a34a',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  validarMasivoBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },

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
  dateFilterCell: {
    width: 130,
    height: FILTER_FIELD_HEIGHT,
  },
  dateFilterInput: {
    width: '100%',
    height: FILTER_FIELD_HEIGHT,
    minHeight: FILTER_FIELD_HEIGHT,
    fontSize: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },

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
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRightWidth: 1,
    borderRightColor: '#cbd5e1',
    position: 'relative' as const,
  },
  cellHeaderText: { fontSize: 10, fontWeight: '600', color: '#334155', lineHeight: 12 },
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
  actionHeaderCell: { width: 40, flexShrink: 0 },
  actionCell: { width: 40, flexShrink: 0, alignItems: 'center', justifyContent: 'center', paddingVertical: 2 },
  actionBtn: {
    padding: 5,
    borderRadius: 6,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  cell: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 2,
    paddingHorizontal: 5,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    justifyContent: 'center',
  },
  cellRight: { alignItems: 'flex-end' as const },
  cellText: {
    fontSize: 10,
    color: '#475569',
    lineHeight: 13,
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : {}),
  },
  cellTextRight: { textAlign: 'right' as const, alignSelf: 'stretch' as const },
  cellTextBold: { fontWeight: '700', color: '#334155' },
  trimestreChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  trimestreChipText: {
    fontSize: 10,
    fontWeight: '600',
    lineHeight: 13,
  },
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
  modalAvisoTipoRecibo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 12,
    padding: 10,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
  },
  modalAvisoTipoReciboTitulo: { fontSize: 12, fontWeight: '700', color: '#b45309', marginBottom: 4 },
  modalAvisoTipoReciboLinea: { fontSize: 11, color: '#92400e', lineHeight: 16 },
  modalAvisoTipoReciboPie: { fontSize: 11, color: '#78716c', marginTop: 6, fontStyle: 'italic' },
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
