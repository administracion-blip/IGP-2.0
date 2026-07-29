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
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import {
  formatMoneda,
  labelEstado,
  colorEstado,
  ESTADOS_OUT,
  FORMAS_PAGO,
  labelFormaPago,
  mapTipoReciboToFormaPago,
  resolveMetodoPagoParaEnvio,
} from '../../utils/facturacion';
import type { FacturaListado, SerieFactura } from '../../types/factura';
import { fechaEmisionFacturaAIso, formatFechaPagoRow } from '../../utils/formatFecha';
import { hoyISO } from '../../utils/facturaFormLogic';
import { getTipoReciboFromEmpresasList, type EmpresaConTipoRecibo } from '../../utils/empresaTipoRecibo';
import { resolverIbanBeneficiarioFactura } from '../../lib/resolverIbanFactura';
import { BadgeEstado } from '../../components/BadgeEstado';
import { BadgeAbono } from '../../components/BadgeAbono';
import { InputFecha } from '../../components/InputFecha';
import { DatosParaPago, RegistrarPagoModal, type RegistrarPagoPayloadFactura } from '../../components/RegistrarPagoModal';
import { useConfirmar } from '../../hooks/useConfirmar';
import { buildConceptoRemesaFacturaRecibida } from '../../lib/conceptoRemesa';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { SelectorDesplegableMulti } from '../../components/SelectorDesplegableMulti';
import { useLocalToast } from '../../components/Toast';
import { ModalDetallePagosTabla } from '../../components/ModalDetallePagosTabla';
import {
  actualizarPagoFactura,
  eliminarPagoFactura,
  fetchPagosFactura,
  pagoRecordToInitial,
  type PagoDetalleRow,
} from '../../lib/pagosFacturaDetalle';
import { FacturaDetalleModal } from '../../components/FacturaDetalleModal';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { apiFetch } from '../../utils/api';
import { buildEmpresasDesdeFacturasHref } from '../../lib/navegacionEmpresas';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

/** Fecha emisión factura (varios formatos BD) → dd/mm/aaaa para tabla */
function fechaEmisionCelda(raw: string | undefined): string {
  if (!raw?.trim()) return '—';
  const iso = fechaEmisionFacturaAIso(raw.trim());
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
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

/** Clave estable para filtrar por receptor/cliente. */
function getReceptorKey(f: { empresa_id?: string; empresa_nombre?: string }): string {
  const id = String(f.empresa_id || '').trim();
  if (id) return id;
  const n = String(f.empresa_nombre || '').trim();
  return n ? `nom:${n}` : '';
}

function fechaEmisionComparable(s: string | undefined | null): string {
  if (!s?.trim()) return '';
  return fechaEmisionFacturaAIso(s.trim()) || '';
}

type TabEstado = 'todas' | (typeof ESTADOS_OUT)[number];

const TABS: { key: TabEstado; label: string }[] = [
  { key: 'todas', label: 'Todas' },
  { key: 'borrador', label: 'Borrador' },
  { key: 'emitida', label: 'Emitida' },
  { key: 'parcialmente_cobrada', label: 'Parcial cobrada' },
  { key: 'cobrada', label: 'Cobrada' },
  { key: 'vencida', label: 'Vencida' },
  { key: 'anulada', label: 'Anulada' },
];

const ESTADOS_VENTA_CHIP = new Set<string>(ESTADOS_OUT);

function pastelChipEstado(key: TabEstado): { bg: string; text: string; border: string } {
  if (key === 'todas') return { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1' };
  const { bg, text } = colorEstado(key);
  const border = key === 'parcialmente_cobrada' ? '#fed7aa' : bg;
  return { bg, text, border };
}

type ToolbarBtn = {
  id: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  permiso: string;
  needsSelection: boolean;
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

export default function FacturasVentaScreen() {
  const router = useRouter();
  const searchParams = useLocalSearchParams<{ modalFactura?: string; maestroActualizado?: string }>();
  const { hasPermiso, user } = useAuth();
  const { width: winW } = useWindowDimensions();
  const { shouldStackToolbar } = useBreakpoint();
  const layoutSplit = Platform.OS === 'web' && winW >= 1024;

  const [facturas, setFacturas] = useState<FacturaListado[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalFacturaId, setModalFacturaId] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [tabActivo, setTabActivo] = useState<TabEstado>('todas');
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ ...DEFAULT_WIDTHS });
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [operando, setOperando] = useState(false);
  const [sortCol, setSortCol] = useState<string>('fecha_emision');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [emisoresFiltroIds, setEmisoresFiltroIds] = useState<string[]>([]);
  const [receptoresFiltroIds, setReceptoresFiltroIds] = useState<string[]>([]);
  const [anioFiltro, setAnioFiltro] = useState(() => String(new Date().getFullYear()));

  const [modalAnularVisible, setModalAnularVisible] = useState(false);
  const [modalCobrarVisible, setModalCobrarVisible] = useState(false);
  const [cobroImporte, setCobroImporte] = useState('');
  const [cobroFecha, setCobroFecha] = useState('');
  const [cobroMetodo, setCobroMetodo] = useState<string>('transferencia');
  const [cobroMetodoOtro, setCobroMetodoOtro] = useState('');
  const [cobroFechaEditadaManual, setCobroFechaEditadaManual] = useState(false);
  const [cobroReferencia, setCobroReferencia] = useState('');
  const [errorModal, setErrorModal] = useState<string | null>(null);
  const [haySeries, setHaySeries] = useState(true);
  const [empresasCatalogo, setEmpresasCatalogo] = useState<EmpresaConTipoRecibo[]>([]);
  const [resyncMaestroToken, setResyncMaestroToken] = useState(0);
  const maestroToastRef = useRef(false);

  const [modalDetallePagosVisible, setModalDetallePagosVisible] = useState(false);
  const [detallePagosLoading, setDetallePagosLoading] = useState(false);
  const [detallePagosError, setDetallePagosError] = useState<string | null>(null);
  const [detallePagosLista, setDetallePagosLista] = useState<PagoDetalleRow[]>([]);
  const [detallePagosFactura, setDetallePagosFactura] = useState<FacturaListado | null>(null);
  const [procesandoPagoDetalleId, setProcesandoPagoDetalleId] = useState<string | null>(null);
  const [pagoDetalleEditando, setPagoDetalleEditando] = useState<PagoDetalleRow | null>(null);
  const [modalEditarPagoDetalle, setModalEditarPagoDetalle] = useState(false);
  const [guardandoPagoDetalle, setGuardandoPagoDetalle] = useState(false);

  const puedeGestionarPagos = hasPermiso('facturacion.cobrar_pagar');

  const { show: showToast, ToastView } = useLocalToast();
  const { confirmar, ConfirmarView } = useConfirmar();

  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    apiFetch('/api/facturacion/series')
      .then((r) => r.json())
      .then((d) => {
        const all = d.series ?? d ?? [];
        setHaySeries(all.some((s: SerieFactura) => s.tipo === 'OUT'));
      })
      .catch(() => {});
  }, []);

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
              Iban: e.Iban != null ? String(e.Iban).trim() : e.iban != null ? String(e.iban).trim() : '',
              IbanAlternativo:
                e.IbanAlternativo != null
                  ? String(e.IbanAlternativo).trim()
                  : e.ibanAlternativo != null
                    ? String(e.ibanAlternativo).trim()
                    : '',
              tipoRecibo: tipoReciboRaw != null ? String(tipoReciboRaw).trim() : undefined,
              'Tipo de recibo': typeof tipoReciboRaw === 'string' ? tipoReciboRaw : undefined,
            };
          }),
        );
      })
      .catch(() => {});
  }, []);

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    apiFetch(`/api/facturacion/facturas?tipo=OUT`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setFacturas(data.facturas || []);
      })
      .catch((e) => setError(e?.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

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
              'Revisa emisor o receptor en la factura si cambió algún dato.',
              'info',
            );
            setTimeout(() => {
              maestroToastRef.current = false;
            }, 800);
          }
        }
        router.replace('/facturacion/facturas-venta' as never);
      }

      if (primerFocoListado.current) {
        primerFocoListado.current = false;
        if (modalId || maestroOk) refetch();
        return;
      }
      refetch();
    }, [refetch, searchParams.modalFactura, searchParams.maestroActualizado, router, showToast]),
  );

  const emisoresOpciones = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of facturas) {
      const key = getEmisorKey(f);
      if (!key) continue;
      const label = String(f.emisor_nombre || '').trim() || key;
      if (!m.has(key)) m.set(key, label);
    }
    return [...m.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], 'es'))
      .map(([id, titulo]) => ({ id, titulo, icono: 'business' as const }));
  }, [facturas]);

  const receptoresOpciones = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of facturas) {
      const key = getReceptorKey(f);
      if (!key) continue;
      const label = String(f.empresa_nombre || '').trim() || key;
      if (!m.has(key)) m.set(key, label);
    }
    return [...m.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], 'es'))
      .map(([id, titulo]) => ({ id, titulo, icono: 'person' as const }));
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

  const toggleSort = useCallback((col: string) => {
    if (sortCol === col) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }, [sortCol]);

  const facturasBaseFiltradas = useMemo(() => {
    let resultado = facturas;
    if (anioFiltro) {
      resultado = resultado.filter((f) => {
        const iso = fechaEmisionComparable(f.fecha_emision);
        return iso.length >= 4 && iso.slice(0, 4) === anioFiltro;
      });
    }
    if (emisoresFiltroIds.length > 0) {
      const set = new Set(emisoresFiltroIds);
      resultado = resultado.filter((f) => set.has(getEmisorKey(f)));
    }
    if (receptoresFiltroIds.length > 0) {
      const set = new Set(receptoresFiltroIds);
      resultado = resultado.filter((f) => set.has(getReceptorKey(f)));
    }
    if (filtroBusqueda.trim()) {
      const q = filtroBusqueda.trim().toLowerCase();
      resultado = resultado.filter(
        (f) =>
          (f.numero_factura || '').toLowerCase().includes(q) ||
          (f.emisor_nombre || '').toLowerCase().includes(q) ||
          (f.empresa_nombre || '').toLowerCase().includes(q) ||
          (f.empresa_cif || '').toLowerCase().includes(q) ||
          (f.id_factura || '').toLowerCase().includes(q),
      );
    }
    if (fechaDesde) {
      resultado = resultado.filter((f) => (fechaEmisionComparable(f.fecha_emision) || '') >= fechaDesde);
    }
    if (fechaHasta) {
      resultado = resultado.filter((f) => (fechaEmisionComparable(f.fecha_emision) || '') <= fechaHasta);
    }
    return resultado;
  }, [facturas, anioFiltro, emisoresFiltroIds, receptoresFiltroIds, filtroBusqueda, fechaDesde, fechaHasta]);

  const conteosPorTab = useMemo(() => {
    const counts = Object.fromEntries(TABS.map((t) => [t.key, 0])) as Record<TabEstado, number>;
    counts.todas = facturasBaseFiltradas.length;
    for (const f of facturasBaseFiltradas) {
      const estado = String(f.estado ?? '').trim();
      if (ESTADOS_VENTA_CHIP.has(estado)) {
        counts[estado as TabEstado] += 1;
      }
    }
    return counts;
  }, [facturasBaseFiltradas]);

  const facturasFiltradas = useMemo(() => {
    let resultado = facturasBaseFiltradas;
    if (tabActivo !== 'todas') resultado = resultado.filter((f) => f.estado === tabActivo);

    if (sortCol) {
      resultado = [...resultado].sort((a, b) => {
        if (sortCol === 'fecha_emision') {
          const fa = fechaEmisionComparable(a.fecha_emision);
          const fb = fechaEmisionComparable(b.fecha_emision);
          const cmp = fa.localeCompare(fb);
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
    return resultado;
  }, [facturasBaseFiltradas, tabActivo, sortCol, sortDir]);

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
  }, [filtroBusqueda, tabActivo, fechaDesde, fechaHasta, emisoresFiltroIds, receptoresFiltroIds, anioFiltro]);

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
    router.push(`/facturacion/factura-detalle?id=${selectedId}&modo=editar&tipo=OUT` as never);
  };

  const handleDuplicar = async () => {
    if (!selectedId) return;
    setOperando(true);
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${selectedId}/duplicar`, { method: 'POST' });
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
      const res = await apiFetch(`/api/facturacion/facturas/${selectedId}/emitir`, { method: 'POST' });
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
      const res = await apiFetch(`/api/facturacion/facturas/${selectedId}/anular`, { method: 'POST' });
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
    setCobroFechaEditadaManual(false);
    setCobroImporte((selectedFactura.saldo_pendiente ?? 0) > 0 ? String(selectedFactura.saldo_pendiente) : '');
    setCobroReferencia('');

    const tipoRecibo = getTipoReciboFromEmpresasList(empresasCatalogo, selectedFactura.empresa_id);
    const { clave, otroTexto } = mapTipoReciboToFormaPago(tipoRecibo);
    setCobroMetodo(clave);
    setCobroMetodoOtro(clave === 'otro' ? otroTexto : '');

    const hoy = hoyISO();
    const fechaFactura = fechaEmisionFacturaAIso(selectedFactura.fecha_emision ?? '') ?? hoy;
    setCobroFecha(clave === 'tarjeta' ? fechaFactura : hoy);

    setModalCobrarVisible(true);
  };

  const aplicarFechaSegunMetodo = (metodo: string, fechaFacturaIso: string, hoy: string) => {
    if (metodo === 'tarjeta') return fechaFacturaIso;
    return hoy;
  };

  const onCambiarMetodoCobro = (m: string) => {
    setCobroMetodo(m);
    if (m !== 'otro') setCobroMetodoOtro('');
    if (!selectedFactura || cobroFechaEditadaManual) return;
    const hoy = hoyISO();
    const fechaFactura = fechaEmisionFacturaAIso(selectedFactura.fecha_emision ?? '') ?? hoy;
    setCobroFecha(aplicarFechaSegunMetodo(m, fechaFactura, hoy));
  };

  const recargarDetallePagos = useCallback(async (idFactura: string) => {
    setDetallePagosLoading(true);
    setDetallePagosError(null);
    try {
      const pagos = await fetchPagosFactura(idFactura);
      setDetallePagosLista(pagos);
    } catch (err) {
      setDetallePagosError(err instanceof Error ? err.message : 'Error de conexión');
    } finally {
      setDetallePagosLoading(false);
    }
  }, []);

  const abrirModalDetallePagos = useCallback((factura: FacturaListado) => {
    setDetallePagosFactura(factura);
    setModalDetallePagosVisible(true);
    setDetallePagosError(null);
    setDetallePagosLista([]);
    void recargarDetallePagos(factura.id_factura);
  }, [recargarDetallePagos]);

  const cerrarModalDetallePagos = useCallback(() => {
    setModalDetallePagosVisible(false);
    setDetallePagosFactura(null);
    setDetallePagosError(null);
    setDetallePagosLista([]);
    setPagoDetalleEditando(null);
    setModalEditarPagoDetalle(false);
    setProcesandoPagoDetalleId(null);
  }, []);

  const sincronizarFacturaTrasPago = useCallback((facturaActualizada: FacturaListado | null) => {
    refetch();
    if (facturaActualizada && detallePagosFactura?.id_factura === facturaActualizada.id_factura) {
      setDetallePagosFactura((prev) => (prev ? { ...prev, ...facturaActualizada } : prev));
    }
  }, [detallePagosFactura?.id_factura, refetch]);

  const handleEditarPagoDetalle = useCallback((pago: PagoDetalleRow) => {
    setPagoDetalleEditando(pago);
    setModalEditarPagoDetalle(true);
  }, []);

  const handleBorrarPagoDetalle = useCallback(async (pago: PagoDetalleRow) => {
    if (!detallePagosFactura?.id_factura || !pago.id_pago) return;
    const importeTxt = formatMoneda(Number(pago.importe ?? 0));
    const ok = await confirmar(
      'Eliminar cobro',
      `¿Eliminar el cobro de ${importeTxt} del ${formatFechaPagoRow(String(pago.fecha ?? ''))}?`,
    );
    if (!ok) return;
    setProcesandoPagoDetalleId(String(pago.id_pago));
    try {
      const factura = await eliminarPagoFactura(
        detallePagosFactura.id_factura,
        String(pago.id_pago),
        { id: user?.id_usuario, nombre: user?.Nombre },
      );
      showToast('Eliminado', 'Cobro eliminado correctamente', 'success');
      sincronizarFacturaTrasPago(factura);
      await recargarDetallePagos(detallePagosFactura.id_factura);
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'No se pudo eliminar el cobro', 'error');
    } finally {
      setProcesandoPagoDetalleId(null);
    }
  }, [
    detallePagosFactura?.id_factura,
    confirmar,
    user?.id_usuario,
    user?.Nombre,
    showToast,
    sincronizarFacturaTrasPago,
    recargarDetallePagos,
  ]);

  const guardarEdicionPagoDetalle = useCallback(async (payload: RegistrarPagoPayloadFactura) => {
    if (!detallePagosFactura?.id_factura || !pagoDetalleEditando?.id_pago) return;
    setGuardandoPagoDetalle(true);
    try {
      const { factura } = await actualizarPagoFactura(
        detallePagosFactura.id_factura,
        String(pagoDetalleEditando.id_pago),
        payload,
        { id: user?.id_usuario, nombre: user?.Nombre },
      );
      showToast('Guardado', 'Cobro actualizado correctamente', 'success');
      setModalEditarPagoDetalle(false);
      setPagoDetalleEditando(null);
      sincronizarFacturaTrasPago(factura);
      await recargarDetallePagos(detallePagosFactura.id_factura);
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'No se pudo actualizar el cobro', 'error');
    } finally {
      setGuardandoPagoDetalle(false);
    }
  }, [
    detallePagosFactura?.id_factura,
    pagoDetalleEditando?.id_pago,
    user?.id_usuario,
    user?.Nombre,
    showToast,
    sincronizarFacturaTrasPago,
    recargarDetallePagos,
  ]);

  const confirmarCobro = async () => {
    if (!selectedId) return;
    const importe = parseFloat(cobroImporte);
    if (isNaN(importe) || importe <= 0) { setErrorModal('El importe debe ser mayor que 0'); return; }
    const fechaIso = cobroFecha.trim();
    if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) { setErrorModal('Indica una fecha válida'); return; }
    const metodoEnvio = resolveMetodoPagoParaEnvio(cobroMetodo, cobroMetodoOtro);
    if (metodoEnvio == null) {
      setErrorModal('Describe el método de pago (campo obligatorio si eliges «Otro»)');
      return;
    }
    setOperando(true);
    setErrorModal(null);
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${selectedId}/pagos`, {
        method: 'POST',
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

  const toolbarBtns: ToolbarBtn[] = [
    { id: 'crear', label: 'Crear', icon: 'add-circle-outline', permiso: 'facturacion.crear', needsSelection: false },
    { id: 'editar', label: 'Editar', icon: 'edit', permiso: 'facturacion.editar', needsSelection: true },
    { id: 'duplicar', label: 'Duplicar', icon: 'content-copy', permiso: 'facturacion.crear', needsSelection: true },
    { id: 'emitir', label: 'Emitir', icon: 'send', permiso: 'facturacion.emitir', needsSelection: true },
    { id: 'anular', label: 'Anular', icon: 'block', permiso: 'facturacion.anular', needsSelection: true },
    { id: 'cobrar', label: 'Cobrar', icon: 'payments', permiso: 'facturacion.cobrar_pagar', needsSelection: true },
  ];

  const isBtnDisabled = (btn: ToolbarBtn) => {
    if (operando) return true;
    if (btn.needsSelection && !selectedId) return true;
    const est = selectedFactura?.estado;
    if (btn.id === 'editar' && est && est !== 'borrador') return true;
    if (btn.id === 'emitir' && est !== 'borrador') return true;
    if (btn.id === 'anular' && (!est || est === 'anulada')) return true;
    if (
      btn.id === 'cobrar'
      && est
      && (est === 'anulada' || est === 'cobrada' || est === 'borrador')
    ) return true;
    return false;
  };

  const handleToolbarPress = (id: string) => {
    if (id === 'crear') handleCrear();
    else if (id === 'editar') handleEditar();
    else if (id === 'duplicar') handleDuplicar();
    else if (id === 'emitir') handleEmitir();
    else if (id === 'anular') abrirModalAnular();
    else if (id === 'cobrar') abrirModalCobrar();
  };

  const valorCelda = useCallback((item: FacturaListado, col: string): string => {
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
      case 'estado': return labelEstado(item.estado ?? '');
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
        <View style={styles.headerActions}>
          {hasPermiso('empresas.ver') ? (
            <TouchableOpacity
              style={styles.empresasBtnHeader}
              onPress={() => router.push(buildEmpresasDesdeFacturasHref('OUT') as never)}
              accessibilityLabel="Ir al maestro de empresas"
            >
              <MaterialIcons name="business" size={16} color="#0ea5e9" />
              <Text style={styles.headerActionText}>Empresas</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <View style={[styles.filtrosRow, shouldStackToolbar && styles.filtrosRowStacked]}>
        {emisoresOpciones.length > 0 ? (
          <SelectorDesplegableMulti
            style={styles.filtroSelector}
            placeholder="Todos los emisores"
            icono="storefront"
            tituloLista="Filtrar por emisor"
            iconoLista="storefront"
            buscador
            buscadorPlaceholder="Buscar emisor…"
            valorIds={emisoresFiltroIds}
            opciones={emisoresOpciones}
            onChange={setEmisoresFiltroIds}
            vacioTexto="No hay emisores en el listado."
          />
        ) : null}
        {receptoresOpciones.length > 0 ? (
          <SelectorDesplegableMulti
            style={styles.filtroSelector}
            placeholder="Todos los clientes"
            icono="person"
            tituloLista="Filtrar por cliente"
            iconoLista="person"
            buscador
            buscadorPlaceholder="Buscar cliente…"
            valorIds={receptoresFiltroIds}
            opciones={receptoresOpciones}
            onChange={setReceptoresFiltroIds}
            vacioTexto="No hay clientes en el listado."
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

      {/* Chips de estado con conteos */}
      <View style={[styles.estadoTabsRow, shouldStackToolbar && styles.estadoTabsRowStacked]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.estadoTabsScroll}
          contentContainerStyle={styles.tabsContent}
        >
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
      </View>

      {/* Toolbar */}
      <View style={[styles.toolbarRow, shouldStackToolbar && styles.toolbarRowStacked]}>
        <View style={styles.toolbar}>
          {toolbarBtns.filter((b) => hasPermiso(b.permiso)).map((btn) => {
            const disabled = isBtnDisabled(btn);
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
            placeholder="Nº, cliente, CIF, ID…"
            placeholderTextColor="#94a3b8"
          />
        </View>

        <View style={styles.fechaFilterWrap}>
          <Text style={styles.fechaLabel}>Desde</Text>
          <InputFecha valueIso={fechaDesde} onChangeIso={setFechaDesde} placeholder="dd/mm/aaaa" style={styles.fechaInput} />
          <Text style={styles.fechaLabel}>Hasta</Text>
          <InputFecha valueIso={fechaHasta} onChangeIso={setFechaHasta} placeholder="dd/mm/aaaa" style={styles.fechaInput} />
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
              <View style={styles.actionHeaderCell} />
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
                  {facturas.length === 0
                    ? 'No hay facturas'
                    : filtroBusqueda.trim() || fechaDesde || fechaHasta || emisoresFiltroIds.length > 0 || receptoresFiltroIds.length > 0 || tabActivo !== 'todas'
                      ? 'Sin resultados para el filtro aplicado'
                      : `No hay facturas emitidas en ${anioFiltro}`}
                </Text>
              </View>
            ) : (
              facturasPagina.map((item) => (
                <Pressable
                  key={item.id_factura}
                  style={[styles.row, selectedId === item.id_factura && styles.rowSelected]}
                  onPress={() => setSelectedId(selectedId === item.id_factura ? null : item.id_factura)}
                >
                  <View style={styles.actionCell}>
                    <Pressable
                      hitSlop={8}
                      accessibilityLabel="Ver detalle y documento"
                      onPress={(e) => {
                        absorberClickFila(e as { stopPropagation?: () => void; nativeEvent?: { stopPropagation?: () => void } });
                        setSelectedId(item.id_factura);
                        setModalFacturaId(item.id_factura);
                      }}
                      style={styles.actionBtn}
                    >
                      <MaterialIcons name="vertical-split" size={16} color="#0369a1" />
                    </Pressable>
                  </View>
                  {COLUMNAS.map((col) => (
                    <View key={col.key} style={[styles.cell, { width: getColWidth(col.key) }]}>
                      {col.key === 'estado' ? (
                        <BadgeEstado estado={item.estado ?? ''} compact />
                      ) : col.key === 'numero_factura' && item.es_abono ? (
                        /* Un abono no es una factura: se distingue sin abrir el detalle */
                        <View style={styles.cellAbonoRow}>
                          <Text style={[styles.cellText, styles.cellTextFlex]} numberOfLines={1} ellipsizeMode="tail">
                            {valorCelda(item, col.key)}
                          </Text>
                          <BadgeAbono compact />
                        </View>
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
      </View>

      {/* Modal detalle + previsualización del documento */}
      <FacturaDetalleModal
        apiUrl={API_URL}
        facturaId={modalFacturaId}
        tipoFactura="OUT"
        puedeEditar={hasPermiso('facturacion.editar')}
        usuarioId={user?.id_usuario}
        usuarioNombre={user?.Nombre}
        onClose={() => setModalFacturaId(null)}
        onGuardado={refetch}
        resyncMaestroToken={resyncMaestroToken}
        onAbrirCompleto={(id) => router.push(`/facturacion/factura-detalle?id=${id}&modo=editar&tipo=OUT` as any)}
      />

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

      {/* Modal cobrar — mismo diseño que Registrar pago (facturas recibidas) */}
      <Modal visible={modalCobrarVisible} transparent animationType="fade" onRequestClose={() => setModalCobrarVisible(false)}>
        <Pressable style={styles.modalDetalleOverlay} onPress={() => !operando && setModalCobrarVisible(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitleForm}>Registrar cobro</Text>
            {selectedFactura?.emisor_nombre ? (
              <View style={styles.modalEmpresaChipRow}>
                <Text style={styles.modalEmpresaChipLabel}>Empresa</Text>
                <View style={styles.modalEmpresaChip}>
                  <Text style={styles.modalEmpresaChipText} numberOfLines={1}>
                    {selectedFactura.emisor_nombre}
                  </Text>
                </View>
              </View>
            ) : null}
            <Text style={styles.modalLabel}>
              Factura: {selectedFactura?.numero_factura || selectedFactura?.id_factura} — Saldo:{' '}
              {selectedFactura ? formatMoneda(Number(selectedFactura.saldo_pendiente) || 0) : ''}
            </Text>

            <DatosParaPago
              datosPago={selectedFactura ? (() => {
                const { iban, ibanAlternativo } = resolverIbanBeneficiarioFactura(
                  {
                    empresa_iban: selectedFactura.emisor_iban,
                    empresa_iban_alternativo: selectedFactura.emisor_iban_alternativo,
                    empresa_id: selectedFactura.emisor_id,
                    empresa_cif: selectedFactura.emisor_cif,
                  },
                  empresasCatalogo,
                );
                return {
                  beneficiario: selectedFactura.emisor_nombre ?? '',
                  iban,
                  ibanAlternativo,
                  concepto: buildConceptoRemesaFacturaRecibida({
                    numeroFactura: selectedFactura.numero_factura,
                    proveedorNombre: selectedFactura.empresa_nombre,
                    observaciones: selectedFactura.observaciones,
                  }),
                };
              })() : undefined}
            />

            <View style={[styles.modalPagoFechaMetodoRow, shouldStackToolbar && styles.modalPagoFechaMetodoRowStacked]}>
              <View style={styles.modalPagoFechaCell}>
                <Text style={styles.modalFieldLabelInline}>Fecha del cobro *</Text>
                <InputFecha
                  compact
                  valueIso={cobroFecha}
                  onChangeIso={(v) => {
                    setCobroFecha(v);
                    setCobroFechaEditadaManual(true);
                  }}
                  placeholder="dd/mm/aaaa"
                  style={styles.modalDateFilterInput}
                />
              </View>
              <View style={styles.modalPagoMetodoCell}>
                <Text style={styles.modalFieldLabelInline}>Método de pago</Text>
                <SelectorDesplegable
                  compact
                  icono="payments"
                  tituloLista="Método de pago"
                  iconoLista="payments"
                  valorId={cobroMetodo}
                  opciones={FORMAS_PAGO.map((m) => ({ id: m, titulo: labelFormaPago(m), icono: 'payments' as const }))}
                  onSeleccionar={(id) => onCambiarMetodoCobro(id)}
                />
              </View>
            </View>

            <Text style={styles.modalFieldLabel}>Importe</Text>
            <TextInput
              style={styles.modalInput}
              value={cobroImporte}
              onChangeText={setCobroImporte}
              placeholder="0,00"
              placeholderTextColor="#94a3b8"
              keyboardType="decimal-pad"
            />

            {cobroMetodo === 'otro' && (
              <>
                <Text style={styles.modalFieldLabel}>Describe el método *</Text>
                <TextInput
                  style={styles.modalInput}
                  value={cobroMetodoOtro}
                  onChangeText={setCobroMetodoOtro}
                  placeholder="Ej. Cheque, PayPal…"
                  placeholderTextColor="#94a3b8"
                />
              </>
            )}

            <Text style={styles.modalFieldLabel}>Referencia (opcional)</Text>
            <TextInput
              style={styles.modalInput}
              value={cobroReferencia}
              onChangeText={setCobroReferencia}
              placeholder="Nº transferencia, recibo…"
              placeholderTextColor="#94a3b8"
            />

            {errorModal ? <Text style={styles.modalErrorInline}>{errorModal}</Text> : null}

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnCancel} onPress={() => setModalCobrarVisible(false)} disabled={operando}>
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtnConfirm, operando && styles.modalBtnDisabled]}
                onPress={confirmarCobro}
                disabled={operando}
              >
                {operando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalBtnConfirmText}>Cobrar</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
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
              puedeGestionar={puedeGestionarPagos}
              procesandoPagoId={procesandoPagoDetalleId}
              onEditar={puedeGestionarPagos ? handleEditarPagoDetalle : undefined}
              onBorrar={puedeGestionarPagos ? handleBorrarPagoDetalle : undefined}
            />
          </Pressable>
        </Pressable>
      </Modal>

      <RegistrarPagoModal
        visible={modalEditarPagoDetalle}
        onClose={() => {
          if (!guardandoPagoDetalle) {
            setModalEditarPagoDetalle(false);
            setPagoDetalleEditando(null);
          }
        }}
        modo="factura"
        variant="cobro"
        initial={pagoDetalleEditando ? pagoRecordToInitial(pagoDetalleEditando) : undefined}
        submitting={guardandoPagoDetalle}
        tituloPersonalizado="Editar cobro"
        textoBotonPersonalizado="Guardar cambios"
        onValidationError={(titulo, mensaje) => showToast(titulo, mensaje, 'warning')}
        onSubmit={guardarEdicionPagoDetalle}
      />

      {ToastView}
      {ConfirmarView}
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
  empresasBtnHeader: {
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
  backBtn: { padding: 4 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },

  resumenRow: { flexDirection: 'row', gap: 12, marginBottom: 8, flexWrap: 'wrap' },
  resumenItem: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  resumenLabel: { fontSize: 10, color: '#94a3b8' },
  resumenVal: { fontSize: 14, fontWeight: '700', color: '#334155' },

  filtrosRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  filtrosRowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  filtroSelector: { flex: 1, minWidth: 180, maxWidth: 320 },
  anioFiltroSelector: { width: 132, minWidth: 120, maxWidth: 160 },

  estadoTabsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  estadoTabsRowStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  estadoTabsScroll: {
    flex: 1,
    minWidth: 0,
    maxHeight: 32,
  },
  tabsContent: { flexDirection: 'row', gap: 4, paddingRight: 4, alignItems: 'center' },
  estadoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  estadoChipActive: {
    borderWidth: 1.5,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  estadoChipText: { fontSize: 10, fontWeight: '500' },
  estadoChipTextActive: { fontWeight: '700' },
  estadoChipCount: {
    minWidth: 18,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  estadoChipCountText: { fontSize: 9, fontWeight: '700' },

  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12, flexWrap: 'wrap' },
  toolbarRowStacked: { flexDirection: 'column', alignItems: 'stretch' },
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
  toolbarBtnDisabled: { opacity: 0.5 },
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

  fechaFilterWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
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
  cellPagadoRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 },
  cellAbonoRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 },
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
  modalTitleForm: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 8 },
  modalLabel: { fontSize: 12, color: '#64748b', marginBottom: 12, lineHeight: 18 },
  modalFieldLabel: { fontSize: 11, fontWeight: '600', color: '#334155', marginBottom: 4, marginTop: 8 },
  modalFieldLabelInline: { fontSize: 11, fontWeight: '600', color: '#334155', marginBottom: 4 },
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
  modalErrorInline: { fontSize: 12, color: '#dc2626', marginTop: 8 },
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
  modalBtnDisabled: { opacity: 0.6 },
  modalEmpresaChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
    marginTop: 2,
    flexWrap: 'wrap',
  },
  modalEmpresaChipLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
  },
  modalEmpresaChip: {
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    maxWidth: '100%',
  },
  modalEmpresaChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0369a1',
  },
  modalSubtitle: { fontSize: 13, color: '#64748b', lineHeight: 18 },
  modalClose: { padding: 4, marginTop: -4 },
  modalBody: { paddingHorizontal: 24, paddingVertical: 20, gap: 12 },
  formLabel: { fontSize: 12, fontWeight: '600', color: '#334155', marginBottom: 4 },
  formLabelInline: { fontSize: 12, fontWeight: '600', color: '#334155', marginBottom: 4 },
  modalPagoFechaMetodoRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginTop: 8,
  },
  modalPagoFechaMetodoRowStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  modalPagoFechaCell: {
    width: 130,
  },
  modalPagoMetodoCell: {
    flex: 1,
    minWidth: 0,
  },
  modalDateFilterInput: {
    width: '100%',
    height: 32,
    minHeight: 32,
    fontSize: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
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
