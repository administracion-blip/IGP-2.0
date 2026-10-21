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
  type GestureResponderEvent,
} from 'react-native';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import {
  formatMoneda,
  importeExcesoPendiente,
  labelEstado,
  colorEstado,
  ESTADOS_OUT,
  mapTipoReciboToFormaPago,
  saldoParaPago,
  tieneExcesoPendiente,
} from '../../utils/facturacion';
import type { FacturaListado, SerieFactura } from '../../types/factura';
import { fechaEmisionFacturaAIso, formatFechaPagoRow } from '../../utils/formatFecha';
import { hoyISO } from '../../utils/facturaFormLogic';
import { getTipoReciboFromEmpresasList, type EmpresaConTipoRecibo } from '../../utils/empresaTipoRecibo';
import { resolverIbanBeneficiarioFactura } from '../../lib/resolverIbanFactura';
import { BadgeEstado } from '../../components/BadgeEstado';
import { BadgeAbono } from '../../components/BadgeAbono';
import { BadgeExceso } from '../../components/BadgeExceso';
import { InputFecha } from '../../components/InputFecha';
import {
  RegistrarPagoModal,
  type RegistrarPagoInitial,
  type RegistrarPagoPayloadFactura,
} from '../../components/RegistrarPagoModal';
import { useConfirmar } from '../../hooks/useConfirmar';
import { buildConceptoRemesaFacturaRecibida } from '../../lib/conceptoRemesa';
import { SelectorAnioListado } from '../../components/SelectorAnioListado';
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
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';
import { apiFetch } from '../../utils/api';
import { anioConcreto, anioEnCurso, urlFacturasPorAnio } from '../../lib/rangoAnioListado';
import { buildEmpresasDesdeFacturasHref, consumirRetornoListadoFacturas } from '../../lib/navegacionEmpresas';
import {
  anioFiltroGuardado,
  guardarFiltrosVenta,
  leerFiltrosVenta,
  type FiltrosListadoVenta,
} from '../../lib/filtrosListadoFacturas';
import IconoSugerenciaConciliacion from '../../components/conciliacion/IconoSugerenciaConciliacion';
import { PanelMovimientosFactura } from '../../components/conciliacion/PanelMovimientosFactura';
import ConciliarMovimientoModal, {
  type ResultadoConciliacion,
} from '../../components/conciliacion/ConciliarMovimientoModal';
import ModalElegirMovimientoConciliacion from '../../components/conciliacion/ModalElegirMovimientoConciliacion';
import { BarraSeleccionFacturas } from '../../components/facturacion/BarraSeleccionFacturas';
import { indicePorFactura, queryConciliacionSugerencias } from '../../lib/conciliacion';
import type { RespuestaSugerencias, SugerenciasDeFactura } from '../../types/conciliacion';

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
function absorberClickFila(e: GestureResponderEvent) {
  const ev = e as unknown as { stopPropagation?: () => void; nativeEvent?: { stopPropagation?: () => void } };
  if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
  const ne = ev.nativeEvent;
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

function tabVentaGuardado(tab: string): TabEstado {
  if (tab === 'todas') return 'todas';
  if ((ESTADOS_OUT as readonly string[]).includes(tab)) return tab as TabEstado;
  return 'todas';
}

function pastelChipEstado(key: TabEstado): { bg: string; text: string; border: string } {
  if (key === 'todas') return { bg: colors.navActive, text: colors.textPrimary, border: colors.borderStrong };
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
  const { isDesktop, shouldStackToolbar, shouldUseComfortableTable } = useBreakpoint();
  const layoutSplit = Platform.OS === 'web' && isDesktop;

  const [facturas, setFacturas] = useState<FacturaListado[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalFacturaId, setModalFacturaId] = useState<string | null>(null);
  const filtrosIniciales = useRef<FiltrosListadoVenta | null | undefined>(undefined);
  if (filtrosIniciales.current === undefined) filtrosIniciales.current = leerFiltrosVenta();
  const filtros0 = filtrosIniciales.current;

  const [filtroBusqueda, setFiltroBusqueda] = useState(filtros0?.busqueda ?? '');
  const [busquedaFoco, setBusquedaFoco] = useState(false);
  const [tabActivo, setTabActivo] = useState<TabEstado>(tabVentaGuardado(filtros0?.tab ?? ''));
  const [fechaDesde, setFechaDesde] = useState(filtros0?.fechaDesde ?? '');
  const [fechaHasta, setFechaHasta] = useState(filtros0?.fechaHasta ?? '');
  const [pageIndex, setPageIndex] = useState(0);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ ...DEFAULT_WIDTHS });
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [operando, setOperando] = useState(false);
  const [sortCol, setSortCol] = useState<string>(filtros0?.sortCol || 'fecha_emision');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(filtros0?.sortDir === 'asc' ? 'asc' : 'desc');
  const [emisoresFiltroIds, setEmisoresFiltroIds] = useState<string[]>(filtros0?.emisoresIds ?? []);
  const [receptoresFiltroIds, setReceptoresFiltroIds] = useState<string[]>(filtros0?.receptoresIds ?? []);
  const [anioFiltro, setAnioFiltro] = useState(anioFiltroGuardado(filtros0?.anio ?? '', anioEnCurso()));

  const [modalAnularVisible, setModalAnularVisible] = useState(false);
  const [modalCobrarVisible, setModalCobrarVisible] = useState(false);
  /** El panel de movimientos tiene una conciliación en vuelo: no se puede cobrar a mano ni cerrar. */
  const [conciliandoEnPanel, setConciliandoEnPanel] = useState(false);
  const [cobroInitial, setCobroInitial] = useState<RegistrarPagoInitial>({});
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
              IbanPredeterminado:
                e.IbanPredeterminado != null ? String(e.IbanPredeterminado).trim() : '',
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
  }, [resyncMaestroToken]);

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    apiFetch(urlFacturasPorAnio('OUT', anioFiltro))
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setFacturas(data.facturas || []);
      })
      .catch((e) => setError(e?.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [anioFiltro]);

  useEffect(() => { refetch(); }, [refetch]);

  const puedeVerConciliacion = hasPermiso('banca.ver');
  const [sugerenciasPorFactura, setSugerenciasPorFactura] = useState<Map<string, SugerenciasDeFactura>>(
    () => new Map(),
  );
  const [conciliarEntrada, setConciliarEntrada] = useState<SugerenciasDeFactura | null>(null);
  const [modalMovimientos, setModalMovimientos] = useState(false);
  const [modoSeleccion, setModoSeleccion] = useState(false);
  const [selectedMultiIds, setSelectedMultiIds] = useState<Set<string>>(new Set());
  /** Solo la última carga escribe: al refrescar tras conciliar se solapan dos. */
  const sugerenciasSeqRef = useRef(0);

  /**
   * Movimientos bancarios candidatos por factura. Es una ayuda del listado: si
   * falla, no se pintan iconos y la pantalla sigue funcionando igual.
   */
  const cargarSugerencias = useCallback(() => {
    if (!puedeVerConciliacion) {
      setSugerenciasPorFactura(new Map());
      return;
    }
    const secuencia = ++sugerenciasSeqRef.current;
    apiFetch(queryConciliacionSugerencias({ tipo: 'OUT' }))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Error ${r.status}`))))
      .then((data: RespuestaSugerencias) => {
        if (secuencia !== sugerenciasSeqRef.current) return;
        setSugerenciasPorFactura(indicePorFactura(data.porFactura));
      })
      .catch(() => {
        if (secuencia !== sugerenciasSeqRef.current) return;
        setSugerenciasPorFactura(new Map());
      });
  }, [puedeVerConciliacion]);

  useEffect(() => { cargarSugerencias(); }, [cargarSugerencias]);

  /** El listado y las sugerencias tienen que ir a la vez: si cambia el saldo o el
   *  estado de una factura, las sugerencias viejas dejan de valer. */
  const refrescarListadoYSugerencias = useCallback(() => {
    refetch();
    cargarSugerencias();
  }, [refetch, cargarSugerencias]);

  const onConciliacionAplicada = useCallback(
    (resultado: ResultadoConciliacion) => {
      setConciliarEntrada(null);
      if (resultado.aplicadas.length > 0) setSelectedMultiIds(new Set());
      const total = resultado.aplicadas.reduce((acc, a) => acc + Number(a.importe || 0), 0);
      const aviso = resultado.avisos[0]?.mensaje;
      showToast(
        resultado.parcial ? 'Conciliación parcial' : 'Cobro registrado',
        `${resultado.aplicadas.length} factura${resultado.aplicadas.length === 1 ? '' : 's'} · ${formatMoneda(total)}${aviso ? ` · ${aviso}` : ''}`,
        resultado.parcial ? 'warning' : 'success',
      );
      // El saldo pendiente ha cambiado: las sugerencias viejas ya no valen.
      refrescarListadoYSugerencias();
    },
    [showToast, refrescarListadoYSugerencias],
  );

  /** Conciliar desde el modal de cobro ya registra el cobro: se cierra el modal. */
  const onCobroConciliadoDesdePanel = useCallback(
    (resumen: { importe: number; mensaje: string; requiereRevision?: boolean }) => {
      setConciliandoEnPanel(false);
      setModalCobrarVisible(false);
      showToast(
        resumen.requiereRevision ? 'Cobro registrado · revisa el movimiento' : 'Cobro registrado',
        resumen.mensaje,
        resumen.requiereRevision ? 'warning' : 'success',
      );
      refrescarListadoYSugerencias();
      setSelectedId(null);
    },
    [showToast, refrescarListadoYSugerencias],
  );

  const onSugerenciaDescartada = useCallback(
    (mensaje: string) => {
      setConciliarEntrada(null);
      showToast('Sugerencia descartada', mensaje, 'info');
      cargarSugerencias();
    },
    [showToast, cargarSugerencias],
  );

  useEffect(() => {
    guardarFiltrosVenta({
      tab: tabActivo,
      busqueda: filtroBusqueda,
      fechaDesde,
      fechaHasta,
      emisoresIds: emisoresFiltroIds,
      receptoresIds: receptoresFiltroIds,
      anio: anioFiltro,
      sortCol,
      sortDir,
    });
  }, [
    tabActivo,
    filtroBusqueda,
    fechaDesde,
    fechaHasta,
    emisoresFiltroIds,
    receptoresFiltroIds,
    anioFiltro,
    sortCol,
    sortDir,
  ]);

  // Refrescar al volver de la ficha completa: sin esto el listado mostraba
  // datos antiguos tras guardar y parecía que el cambio no se había guardado.
  const primerFocoListado = useRef(true);
  useFocusEffect(
    useCallback(() => {
      const aviso = consumirRetornoListadoFacturas('OUT');
      const modalEnUrl = (
        Array.isArray(searchParams.modalFactura)
          ? searchParams.modalFactura[0]
          : searchParams.modalFactura
      )?.trim() ?? '';
      const maestroEnUrl = (
        Array.isArray(searchParams.maestroActualizado)
          ? searchParams.maestroActualizado[0]
          : searchParams.maestroActualizado
      ) === '1';
      const modalId = modalEnUrl || aviso?.modalFactura || '';
      const maestroOk = maestroEnUrl || aviso?.maestro === true;

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
        if (modalEnUrl || maestroEnUrl) {
          router.replace('/facturacion/facturas-venta' as never);
        }
      }

      if (primerFocoListado.current) {
        primerFocoListado.current = false;
        if (modalId || maestroOk) refrescarListadoYSugerencias();
        return;
      }
      refrescarListadoYSugerencias();
    }, [refrescarListadoYSugerencias, searchParams.modalFactura, searchParams.maestroActualizado, router, showToast]),
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

  const toggleSort = useCallback((col: string) => {
    if (sortCol === col) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }, [sortCol]);

  const facturasBaseFiltradas = useMemo(() => {
    let resultado = facturas;
    const anioCliente = anioConcreto(anioFiltro);
    if (anioCliente) {
      resultado = resultado.filter((f) => {
        const iso = fechaEmisionComparable(f.fecha_emision);
        return iso.length >= 4 && iso.slice(0, 4) === anioCliente;
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

  const facturasSeleccionadas = useMemo(
    () => facturasFiltradas.filter((f) => selectedMultiIds.has(f.id_factura)),
    [facturasFiltradas, selectedMultiIds],
  );

  const toggleSeleccionMulti = (id: string) => {
    setSelectedMultiIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
      refrescarListadoYSugerencias();
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
      refrescarListadoYSugerencias();
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
      refrescarListadoYSugerencias();
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

    const tipoRecibo = getTipoReciboFromEmpresasList(empresasCatalogo, selectedFactura.empresa_id);
    const { clave, otroTexto } = mapTipoReciboToFormaPago(tipoRecibo);

    const hoy = hoyISO();
    const fechaFactura = fechaEmisionFacturaAIso(selectedFactura.fecha_emision ?? '') ?? hoy;

    setCobroInitial({
      fecha: clave === 'tarjeta' ? fechaFactura : hoy,
      metodo: clave,
      metodoOtro: clave === 'otro' ? otroTexto : '',
      referencia: '',
      importe: (() => {
        const saldo = saldoParaPago(selectedFactura);
        if (saldo > 0.001) return String(saldo);
        if (saldo < -0.001) return String(Math.abs(saldo));
        return '';
      })(),
    });
    setConciliandoEnPanel(false);
    setModalCobrarVisible(true);
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
    refrescarListadoYSugerencias();
    if (facturaActualizada && detallePagosFactura?.id_factura === facturaActualizada.id_factura) {
      setDetallePagosFactura((prev) => (prev ? { ...prev, ...facturaActualizada } : prev));
    }
  }, [detallePagosFactura?.id_factura, refrescarListadoYSugerencias]);

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
        pago,
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

  /**
   * Este cobro no manda `usuario_id` / `usuario_nombre` a propósito: la auditoría
   * del listado de venta se comporta así desde siempre y unificarlo no entra aquí.
   */
  const confirmarCobro = async (payload: RegistrarPagoPayloadFactura) => {
    if (!selectedId) return;
    setOperando(true);
    setErrorModal(null);
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${selectedId}/pagos`, {
        method: 'POST',
        body: JSON.stringify({
          fecha: payload.fecha,
          importe: payload.importe,
          metodo_pago: payload.metodo_pago,
          referencia: payload.referencia.trim() || undefined,
          observaciones: payload.observaciones,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setErrorModal(data.error || 'Error al registrar cobro'); setOperando(false); return; }
      setModalCobrarVisible(false);
      refrescarListadoYSugerencias();
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
      <View style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.loadingText}>Cargando facturas…</Text>
        </View>
      </View>
    );
  }

  if (error && facturas.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.push('/facturacion' as any)} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>Facturas emitidas</Text>
        </View>
        <View style={styles.center}>
          <MaterialIcons name="error-outline" size={48} color={colors.danger} />
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
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Facturas emitidas</Text>
        <View style={styles.headerActions}>
          {hasPermiso('empresas.ver') ? (
            <TouchableOpacity
              style={styles.empresasBtnHeader}
              onPress={() => router.push(buildEmpresasDesdeFacturasHref('OUT') as never)}
              accessibilityLabel="Ir al maestro de empresas"
            >
              <MaterialIcons name="business" size={16} color={colors.accent} />
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
        <SelectorAnioListado
          incluirTodos
          estirar={shouldStackToolbar}
          valorId={anioFiltro}
          onChange={setAnioFiltro}
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
                  <Text style={[styles.estadoChipCountText, { color: activo ? colors.surface : pastel.text }]}>
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
                  style={[
                    styles.toolbarBtn,
                    hoveredBtn === btn.id && !disabled && styles.toolbarBtnHover,
                    disabled && styles.toolbarBtnDisabled,
                  ]}
                  onPress={() => handleToolbarPress(btn.id)}
                  disabled={disabled}
                  accessibilityLabel={btn.label}
                >
                  <MaterialIcons name={btn.icon} size={18} color={disabled ? colors.textMuted : colors.accent} />
                </TouchableOpacity>
              </View>
            );
          })}
          <View
            style={styles.toolbarBtnWrap}
            {...(Platform.OS === 'web'
              ? ({ onMouseEnter: () => setHoveredBtn('sel_mode'), onMouseLeave: () => setHoveredBtn(null) } as object)
              : {})}
          >
            {hoveredBtn === 'sel_mode' && (
              <View style={styles.tooltip}><Text style={styles.tooltipText}>Selección múltiple</Text></View>
            )}
            <TouchableOpacity
              style={[
                styles.toolbarBtn,
                modoSeleccion && styles.toolbarBtnActive,
                !modoSeleccion && hoveredBtn === 'sel_mode' && styles.toolbarBtnHover,
              ]}
              onPress={() => {
                setModoSeleccion((m) => !m);
                if (modoSeleccion) setSelectedMultiIds(new Set());
              }}
              accessibilityLabel="Selección múltiple"
            >
              <MaterialIcons name="checklist" size={18} color={modoSeleccion ? colors.surface : colors.accent} />
            </TouchableOpacity>
          </View>
          {modoSeleccion ? (
            <BarraSeleccionFacturas
              facturas={facturasSeleccionadas}
              puedeConciliar={puedeGestionarPagos && puedeVerConciliacion}
              onConciliar={() => setModalMovimientos(true)}
            />
          ) : null}
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
          <TouchableOpacity
            style={[styles.toolbarBtn, hoveredBtn === 'refresh' && !loading && styles.toolbarBtnHover]}
            onPress={refrescarListadoYSugerencias}
            disabled={loading}
            accessibilityLabel="Actualizar"
          >
            <MaterialIcons name="refresh" size={18} color={loading ? colors.textMuted : colors.accent} />
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
              style={[styles.toolbarBtn, hoveredBtn === 'excel' && styles.toolbarBtnHover]}
              onPress={async () => {
                const { exportarFacturasVentaExcel } = await import('../../utils/exportFacturasExcel');
                exportarFacturasVentaExcel(facturasFiltradas);
              }}
              accessibilityLabel="Exportar Excel"
            >
              <MaterialIcons name="file-download" size={18} color={colors.success} />
            </TouchableOpacity>
          </View>
        )}

        <View style={[styles.searchWrap, busquedaFoco && styles.filtroFoco]}>
          <MaterialIcons name="search" size={18} color={colors.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            onFocus={() => setBusquedaFoco(true)}
            onBlur={() => setBusquedaFoco(false)}
            placeholder="Nº, cliente, CIF, ID…"
            placeholderTextColor={colors.textMuted}
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
            <Text style={[styles.resumenVal, { color: colors.success }]}>
              {formatMoneda(facturasFiltradas.reduce((s, f) => s + (f.total_factura ?? 0), 0))}
            </Text>
          </View>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Pendiente cobro</Text>
            <Text style={[styles.resumenVal, { color: statusColors.warning.text }]}>
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
              <MaterialIcons name="chevron-left" size={20} color={pageIndexClamped <= 0 ? colors.textMuted : colors.accent} />
            </TouchableOpacity>
            <Text style={styles.pageText}>Página {pageIndexClamped + 1} de {totalPages}</Text>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped >= totalPages - 1 && styles.pageBtnDisabled]}
              onPress={goNextPage}
              disabled={pageIndexClamped >= totalPages - 1}
            >
              <MaterialIcons name="chevron-right" size={20} color={pageIndexClamped >= totalPages - 1 ? colors.textMuted : colors.accent} />
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
              <View
                style={[styles.actionHeaderCell, puedeVerConciliacion && styles.actionHeaderCellAncha]}
              />
              {COLUMNAS.map((col) => (
                <TouchableOpacity
                  key={col.key}
                  style={[styles.cellHeader, { width: getColWidth(col.key) }]}
                  onPress={() => toggleSort(col.key)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">{col.label}</Text>
                  {sortCol === col.key && (
                    <MaterialIcons name={sortDir === 'asc' ? 'arrow-upward' : 'arrow-downward'} size={10} color={colors.textPrimary} />
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
                      : anioConcreto(anioFiltro)
                        ? `No hay facturas emitidas en ${anioFiltro}`
                        : 'No hay facturas emitidas'}
                </Text>
              </View>
            ) : (
              facturasPagina.map((item) => (
                <Pressable
                  key={item.id_factura}
                  style={[
                    styles.row,
                    ((selectedId === item.id_factura && !modoSeleccion) || (modoSeleccion && selectedMultiIds.has(item.id_factura))) && styles.rowSelected,
                  ]}
                  onPress={() => {
                    if (modoSeleccion) {
                      toggleSeleccionMulti(item.id_factura);
                      return;
                    }
                    setSelectedId(selectedId === item.id_factura ? null : item.id_factura);
                  }}
                >
                  <View style={[styles.actionCell, puedeVerConciliacion && styles.actionCellAncha]}>
                    {modoSeleccion ? (
                      <Pressable
                        hitSlop={8}
                        onPress={(e) => {
                          absorberClickFila(e);
                          toggleSeleccionMulti(item.id_factura);
                        }}
                        style={styles.actionBtn}
                      >
                        <MaterialIcons
                          name={selectedMultiIds.has(item.id_factura) ? 'check-box' : 'check-box-outline-blank'}
                          size={18}
                          color={colors.accent}
                        />
                      </Pressable>
                    ) : (
                    <Pressable
                      hitSlop={8}
                      accessibilityLabel="Ver detalle y documento"
                      onPress={(e) => {
                        absorberClickFila(e);
                        setSelectedId(item.id_factura);
                        setModalFacturaId(item.id_factura);
                      }}
                      style={styles.actionBtn}
                    >
                      <MaterialIcons name="vertical-split" size={16} color={statusColors.info.text} />
                    </Pressable>
                    )}
                    {!modoSeleccion && puedeVerConciliacion ? (
                      <IconoSugerenciaConciliacion
                        entrada={sugerenciasPorFactura.get(item.id_factura)}
                        comodo={shouldUseComfortableTable}
                        onPress={(entrada, e) => {
                          absorberClickFila(e);
                          setConciliarEntrada(entrada);
                        }}
                      />
                    ) : null}
                  </View>
                  {COLUMNAS.map((col) => (
                    <View key={col.key} style={[styles.cell, { width: getColWidth(col.key) }]}>
                      {col.key === 'estado' ? (
                        <View style={styles.estadoBadgesRow}>
                          <BadgeEstado estado={item.estado ?? ''} compact />
                          {tieneExcesoPendiente(item) ? (
                            <BadgeExceso importe={importeExcesoPendiente(item)} compact />
                          ) : null}
                        </View>
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
                              absorberClickFila(e);
                              abrirModalDetallePagos(item);
                            }}
                            style={styles.cellPagadoIconBtn}
                          >
                            <MaterialIcons name="receipt-long" size={16} color={statusColors.info.text} />
                          </Pressable>
                        </View>
                      ) : (
                        <Text
                          style={[
                            styles.cellText,
                            col.key === 'total_factura' && Number(item.total_factura) < 0 && { color: colors.danger },
                          ]}
                          numberOfLines={col.key === 'impuestos_resumen' ? 2 : 1}
                          ellipsizeMode="tail"
                        >
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

      {/* Conciliación bancaria de la factura de la fila */}
      <ModalElegirMovimientoConciliacion
        visible={modalMovimientos}
        tipo="OUT"
        facturas={facturasSeleccionadas}
        onClose={() => setModalMovimientos(false)}
        onElegido={(entrada) => {
          setModalMovimientos(false);
          setConciliarEntrada(entrada);
        }}
      />
      <ConciliarMovimientoModal
        visible={conciliarEntrada !== null}
        entrada={conciliarEntrada}
        tipo="OUT"
        puedeConciliar={puedeGestionarPagos}
        onClose={() => setConciliarEntrada(null)}
        onConciliado={onConciliacionAplicada}
        onDescartada={onSugerenciaDescartada}
      />

      {/* Modal detalle + previsualización del documento */}
      <FacturaDetalleModal
        apiUrl={API_URL}
        facturaId={modalFacturaId}
        tipoFactura="OUT"
        puedeEditar={hasPermiso('facturacion.editar')}
        usuarioId={user?.id_usuario}
        usuarioNombre={user?.Nombre}
        onClose={() => setModalFacturaId(null)}
        onGuardado={refrescarListadoYSugerencias}
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
                    <MaterialIcons name="close" size={22} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
                {errorModal && (
                  <View style={styles.modalErrorWrap}>
                    <MaterialIcons name="error-outline" size={16} color={colors.danger} />
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
                      <ActivityIndicator size="small" color={colors.surface} />
                    ) : (
                      <>
                        <MaterialIcons name="block" size={18} color={colors.surface} />
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

      {/* Modal cobrar (componente estándar del proyecto, con panel de movimientos) */}
      <RegistrarPagoModal
        visible={modalCobrarVisible}
        onClose={() => {
          if (operando) return;
          setConciliandoEnPanel(false);
          setModalCobrarVisible(false);
        }}
        modo="factura"
        variant="cobro"
        initial={cobroInitial}
        tituloPersonalizado={
          selectedFactura
            ? `Registrar cobro · Factura ${selectedFactura.numero_factura || selectedFactura.id_factura}`
              + ` — Saldo ${formatMoneda(Number(selectedFactura.saldo_pendiente) || 0)}`
            : 'Registrar cobro'
        }
        textoBotonPersonalizado="Cobrar"
        saldoOrigen={saldoParaPago(selectedFactura)}
        empresaPagadoraNombre={selectedFactura?.emisor_nombre ?? ''}
        fechaFactura={selectedFactura?.fecha_emision}
        fechaReferenciaTarjeta={
          selectedFactura
            ? fechaEmisionFacturaAIso(selectedFactura.fecha_emision ?? '') ?? undefined
            : undefined
        }
        datosPago={
          selectedFactura
            ? {
                beneficiario: selectedFactura.emisor_nombre ?? '',
                iban: resolverIbanBeneficiarioFactura(
                  {
                    empresa_iban: selectedFactura.emisor_iban,
                    empresa_iban_alternativo: selectedFactura.emisor_iban_alternativo,
                    empresa_id: selectedFactura.emisor_id,
                    empresa_cif: selectedFactura.emisor_cif,
                  },
                  empresasCatalogo,
                ),
                concepto: buildConceptoRemesaFacturaRecibida({
                  numeroFactura: selectedFactura.numero_factura,
                  proveedorNombre: selectedFactura.empresa_nombre,
                  observaciones: selectedFactura.observaciones,
                }),
              }
            : undefined
        }
        panelLateral={
          selectedFactura && String(selectedFactura.emisor_id ?? '').trim() && puedeVerConciliacion
            ? (
              <PanelMovimientosFactura
                idFactura={selectedFactura.id_factura}
                numeroFactura={selectedFactura.numero_factura?.trim() || selectedFactura.id_factura}
                empresaId={String(selectedFactura.emisor_id ?? '').trim()}
                tipo="OUT"
                fechaEmision={selectedFactura.fecha_emision}
                contraparteNombre={selectedFactura.empresa_nombre}
                saldoPendiente={Math.abs(Number(selectedFactura.saldo_pendiente ?? 0))}
                puedeConciliar={puedeGestionarPagos}
                onConciliado={onCobroConciliadoDesdePanel}
                onOcupadoChange={setConciliandoEnPanel}
              />
            )
            : undefined
        }
        bloqueadoPorPanel={conciliandoEnPanel}
        submitting={operando}
        errorExterno={errorModal ?? undefined}
        onValidationError={(titulo, mensaje) => showToast(titulo, mensaje, 'warning')}
        onSubmit={confirmarCobro}
      />

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
                <MaterialIcons name="close" size={22} color={colors.textMuted} />
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

/** Radio 8: entre `radius.sm` (6) y `radius.md` (10). No hay token. */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, margin: -10, padding: SPACING.lg, backgroundColor: colors.surface },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, textAlign: 'center' },
  retryBtn: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg, backgroundColor: statusColors.danger.bg, borderRadius: RADIO_MEDIO },
  retryBtnText: { fontSize: fontSizes[12], color: colors.danger, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.xs, gap: SPACING.sm },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
    flexShrink: 1,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  headerActionText: { fontSize: typography.etiqueta.fontSize, color: colors.accent, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  empresasBtnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.sm,
    backgroundColor: colors.accentMuted,
  },
  backBtn: { padding: SPACING.xs },
  title: { fontSize: fontSizes[20], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },

  resumenRow: { flexDirection: 'row', gap: SPACING.md, marginBottom: SPACING.sm, flexWrap: 'wrap' },
  resumenItem: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO, paddingHorizontal: 10, paddingVertical: 5 },
  resumenLabel: { fontFamily: fontFamily.regular, fontSize: fontSizes.badge, color: colors.textMuted },
  resumenVal: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },

  filtrosRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  filtrosRowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  filtroSelector: { flex: 1, minWidth: 180, maxWidth: 320 },

  estadoTabsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
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
  tabsContent: { flexDirection: 'row', gap: SPACING.xs, paddingRight: 4, alignItems: 'center' },
  estadoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  estadoChipActive: {
    borderWidth: 1.5,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  estadoChipText: { fontSize: fontSizes.badge, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  estadoChipTextActive: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  estadoChipCount: {
    minWidth: 18,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  estadoChipCountText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },

  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.sm, gap: SPACING.md, flexWrap: 'wrap' },
  toolbarRowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolbarBtnWrap: { position: 'relative' },
  tooltip: {
    position: 'absolute',
    bottom: '100%',
    alignSelf: 'center',
    marginBottom: SPACING.xs,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: radius.sm,
    zIndex: 10,
  },
  tooltipText: { fontSize: typography.etiqueta.fontSize, color: colors.bg, fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight },
  toolbarBtn: { padding: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface },
  toolbarBtnHover: { backgroundColor: colors.bg },
  toolbarBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  toolbarBtnDisabled: { opacity: 0.5 },
  filtroFoco: { borderColor: colors.accent },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 140,
    maxWidth: 280,
    height: 32,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: 8,
  },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textPrimary, paddingVertical: 0 },

  fechaFilterWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  fechaLabel: { fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  fechaInput: {
    fontFamily: fontFamily.regular,
    fontSize: typography.etiqueta.fontSize,
    paddingVertical: 3,
    paddingHorizontal: 8,
    minHeight: 32,
    height: 32,
    color: colors.textPrimary,
    width: 118,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
  },

  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
    gap: SPACING.md,
    flexWrap: 'wrap',
  },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted },
  pagination: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  pageBtn: { padding: SPACING.xs },
  pageBtnDisabled: { opacity: 0.5 },
  pageText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginHorizontal: SPACING.xs },

  tableSplitWrap: { flex: 1, minHeight: 0 },
  tableSplitRow: { flexDirection: 'row', alignItems: 'stretch' },
  tableSplitCol: { flexDirection: 'column' },
  detailPanel: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
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
    fontSize: typography.etiqueta.fontSize,
    fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight,
    color: colors.textMuted,
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
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    direction: 'ltr',
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  cellHeader: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 6,
    borderRightWidth: 0,
    position: 'relative',
  },
  cellHeaderText: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, lineHeight: 12, letterSpacing: 0.3 },
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
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowSelected: { backgroundColor: colors.accentMuted },
  actionHeaderCell: { width: 40, flexShrink: 0 },
  actionCell: { width: 40, flexShrink: 0, alignItems: 'center', justifyContent: 'center', paddingVertical: 2 },
  /** Con conciliación la celda hospeda dos iconos: detalle + movimientos candidatos. */
  actionHeaderCellAncha: { width: 70 },
  actionCellAncha: { width: 70, flexDirection: 'row', gap: SPACING.xs },
  actionBtn: {
    padding: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.accentMuted,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  cell: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 2,
    paddingHorizontal: 5,
    borderRightWidth: 0,
    justifyContent: 'center',
  },
  cellPagadoRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, flex: 1, minWidth: 0 },
  cellAbonoRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, flex: 1, minWidth: 0 },
  estadoBadgesRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.xs },
  cellTextFlex: { flex: 1, minWidth: 0 },
  cellPagadoIconBtn: { padding: 2 },
  cellText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textPrimary, lineHeight: 14, ...(Platform.OS === 'android' ? { includeFontPadding: false } : {}) },
  emptyRow: { padding: SPACING.xl, alignItems: 'center' },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, fontStyle: 'italic' },

  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)', // más oscuro que colors.overlay (0.35)
  },
  /** Misma base que facturas recibidas: overlay + tarjeta compacta para detalle de cobros */
  modalDetalleOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 20,
    width: '90%',
    maxWidth: 400,
  },
  modalDetalleModal: { maxWidth: 480 },
  modalDetalleHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  modalDetalleTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, marginBottom: SPACING.xs },
  modalDetalleSubtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, lineHeight: 18 },
  modalDetalleClose: { padding: SPACING.xs, marginTop: -4 },
  modalContentWrap: { width: '100%', maxWidth: 480, padding: SPACING.xl, alignItems: 'center' },
  modalCardTouch: { width: '100%' },
  modalCard: {
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: radius.xl,
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
    borderBottomColor: colors.border,
  },
  modalTitle: { fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, marginBottom: SPACING.xs },
  modalSubtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, lineHeight: 18 },
  modalClose: { padding: SPACING.xs, marginTop: -4 },
  modalBody: { paddingHorizontal: 24, paddingVertical: 20, gap: SPACING.md },
  formLabel: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, marginBottom: SPACING.xs },
  formLabelInline: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, marginBottom: SPACING.xs },
  formInput: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[13],
    color: colors.textPrimary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.surface,
  },
  modalErrorWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: statusColors.danger.bg,
    marginHorizontal: 24,
    marginBottom: SPACING.sm,
    borderRadius: RADIO_MEDIO,
  },
  modalError: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, flex: 1 },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: SPACING.md,
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  modalFooterBtnSecondary: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  modalFooterBtnSecondaryText: { fontSize: fontSizes[14], color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  modalFooterBtnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  modalFooterBtnPrimaryText: { fontSize: fontSizes[14], color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  modalFooterBtnDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: radius.md,
    backgroundColor: colors.danger,
  },
  modalFooterBtnDangerText: { fontSize: fontSizes[14], color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  modalFooterBtnDisabled: { opacity: 0.7 },
});
