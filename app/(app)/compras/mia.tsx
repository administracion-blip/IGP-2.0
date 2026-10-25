/**
 * MIA — Motor Inteligente de Aprovisionamiento.
 * Paso 1: parámetros y cálculo. Paso 2: revisión, ajustes, PDF y aprobación.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Platform,
  Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { RangoFechas } from '../../components/RangoFechas';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { MiaCalendarioPedidos } from '../../components/mia/MiaCalendarioPedidos';
import { MiaGruposFamiliasModal } from '../../components/mia/MiaGruposFamiliasModal';
import { MiaProveedoresConfigModal } from '../../components/mia/MiaProveedoresConfigModal';
import { MIN_TOUCH } from '../../constants/layout';
import { miaColors, radius } from '../../constants/theme';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { generarPdfMiaInforme } from '../../lib/miaInformePdf';
import { useMiaGruposFamilias } from '../../hooks/useMiaGruposFamilias';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatMoneda } from '../../utils/formatMoneda';
import { formatFecha } from '../../utils/formatFecha';

type VistaMia = 'pedido' | 'calendario';

type AlmacenMia = {
  id: string;
  nombre: string;
  localIds: string[];
};

type MismatchResumen = {
  nombresSinAlmacen: Array<{ localId?: string; localNombre?: string; nombreAlmacen?: string }>;
  almacenesSinLocal: Array<{ id?: string; nombre?: string }>;
};

type MiaLinea = {
  productId: string;
  ProductId?: string;
  nombre?: string;
  proveedorId: string;
  proveedorNombre?: string;
  cantidadPedida: number;
  qty?: number;
  qtyCalculada?: number;
  omitida?: boolean;
  unit?: string;
  costeUnitario?: number;
  costeLinea?: number;
  stock?: number;
  consumoDiario?: number;
  minimo?: number | null;
  maximo?: number | null;
  enCamino?: number;
  semaforo?: SemaforoStock | null;
};

type SemaforoStock = 'rojo' | 'verde' | 'azul';

type MiaTotales = {
  lineas?: number;
  productosConPedido?: number;
  unidadesPedido?: number;
  costeTotal?: number;
};

type MiaFrescor = {
  stockLastOkAt?: string | null;
  stockLastError?: string | null;
  ventasLastSyncTs?: number | string | null;
  ventasLastSync?: number | string | null;
};

type MiaInforme = {
  informeId: string;
  warehouseId?: string;
  WarehouseId?: string;
  grupoFamiliaId?: string;
  grupoFamiliaNombre?: string;
  familiaIds?: string[];
  fechaDesde?: string;
  fechaHasta?: string;
  semanasHistorico?: number;
  colchonDias?: number;
  estado?: string;
  avisos?: string[];
  totales?: MiaTotales;
  frescor?: MiaFrescor;
  creadoEn?: string;
  CreadoEn?: string;
  stockSyncedAt?: string | null;
};

type InformeListItem = {
  informeId?: string;
  estado?: string;
  fechaDesde?: string;
  fechaHasta?: string;
  creadoEn?: string;
  CreadoEn?: string;
  totales?: MiaTotales;
  agoraPurchaseOrderIds?: Record<string, { serie?: string | null; number?: number | string | null }>;
};

const ESTADOS_INFORME: Array<{ id: string; label: string }> = [
  { id: 'calculado', label: 'Calculado' },
  { id: 'revisado', label: 'Revisado' },
  { id: 'aprobando', label: 'Aprobando' },
  { id: 'aprobado', label: 'Aprobado' },
  { id: 'aprobado_parcial', label: 'Aprobado parcial' },
];

const COLOR_ESTADO: Record<string, string> = {
  calculado: miaColors.info,
  revisado: miaColors.accent,
  aprobando: miaColors.warning,
  aprobado: miaColors.success,
  aprobado_parcial: miaColors.warning,
};

type DraftLinea = {
  productId: string;
  proveedorId: string;
  nombre: string;
  proveedorNombre: string;
  cantidadPedida: string;
  omitida: boolean;
  unit: string;
  costeUnitario: number;
  /** Cantidad que calculó MIA: decide qué filas oculta «Ocultar sin pedido». */
  qtyCalculada: number;
  stock: number | null;
  minimo: number | null;
  maximo: number | null;
  semaforo: SemaforoStock | null;
};

const SEMAFORO: Record<SemaforoStock, { bg: string; text: string; label: string }> = {
  rojo: { bg: miaColors.dangerMuted, text: miaColors.danger, label: 'Bajo mínimo' },
  verde: { bg: miaColors.successMuted, text: miaColors.success, label: 'Entre mínimo y máximo' },
  azul: { bg: miaColors.infoMuted, text: miaColors.info, label: 'Sobre máximo' },
};

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatCantidad(n: number | null): string {
  if (n == null) return '—';
  return n.toLocaleString('es-ES', { maximumFractionDigits: 2 });
}

const AVISO_LABEL: Record<string, string> = {
  stock_sync_error: 'Error o falta de sincronización de stock',
  stock_desactualizado: 'Stock desactualizado (más de 24 h)',
  ventas_desactualizadas: 'Ventas desactualizadas',
  pedidos_pendientes_confirmacion: 'Hay pedidos pendientes de confirmación en los locales',
  sync_stock_fallido: 'Falló la sincronización de stock al calcular',
  almacen_sin_locales: 'El almacén no tiene locales vinculados',
  ajuste_facturacion_no_disponible: 'Ajuste por facturación no disponible',
  ajuste_facturacion_parcial: 'Ajuste por facturación parcial (datos incompletos)',
  grupo_sin_productos: 'La agrupación seleccionada no tiene productos',
  grupo_sin_familias: 'La agrupación no tiene familias configuradas',
  grupo_inactivo: 'La agrupación está inactiva o no existe',
};

function addDaysIso(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function lineKey(proveedorId: string, productId: string): string {
  return `${proveedorId}#${productId}`;
}

function labelAviso(code: string): string {
  return AVISO_LABEL[code] || code;
}

function formatTs(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  const ts = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ts)) return String(value);
  return new Date(ts).toLocaleString('es-ES');
}

function formatTsLista(value: string | null | undefined): string {
  if (!value) return '—';
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  return new Date(ts).toLocaleString('es-ES', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toDraft(lineas: MiaLinea[]): DraftLinea[] {
  return (lineas || []).map((ln) => {
    const qty = Number(ln.cantidadPedida != null ? ln.cantidadPedida : ln.qty) || 0;
    return {
      productId: String(ln.productId || ln.ProductId || '').trim(),
      proveedorId: String(ln.proveedorId || 'SIN_PROVEEDOR').trim() || 'SIN_PROVEEDOR',
      nombre: String(ln.nombre || ln.productId || '').trim(),
      proveedorNombre: String(ln.proveedorNombre || ln.proveedorId || 'Sin proveedor').trim(),
      cantidadPedida: String(qty),
      omitida: ln.omitida === true,
      unit: String(ln.unit || '').trim() || 'ud',
      costeUnitario: Number(ln.costeUnitario) || 0,
      qtyCalculada: Number(ln.qtyCalculada ?? ln.qty ?? ln.cantidadPedida) || 0,
      stock: numOrNull(ln.stock),
      minimo: numOrNull(ln.minimo),
      maximo: numOrNull(ln.maximo),
      semaforo: ln.semaforo && ln.semaforo in SEMAFORO ? ln.semaforo : null,
    };
  });
}

/** Sin pedido: MIA calculó 0 y el usuario no lo ha cambiado. */
function sinPedido(d: DraftLinea): boolean {
  if (d.qtyCalculada > 0) return false;
  const qty = parseQty(d.cantidadPedida);
  return !Number.isFinite(qty) || qty <= 0;
}

function parseQty(s: string): number {
  const n = parseFloat(String(s).replace(',', '.').trim());
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function pedidosAgoraDe(it: InformeListItem): string[] {
  const raw = it.agoraPurchaseOrderIds;
  if (!raw || typeof raw !== 'object') return [];
  const partes: string[] = [];
  for (const v of Object.values(raw)) {
    const serie = String(v?.serie || '').trim();
    const number = v?.number != null && String(v.number).trim() !== '' ? String(v.number) : '';
    const texto = [serie, number].filter(Boolean).join(' ');
    if (texto) partes.push(texto);
  }
  return partes;
}

function costeDraft(d: DraftLinea): number {
  if (d.omitida) return 0;
  const qty = parseQty(d.cantidadPedida);
  if (!Number.isFinite(qty)) return 0;
  return Math.round(qty * d.costeUnitario * 100) / 100;
}

export default function MiaScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackToolbar, shouldStackPanels, isPhone } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();

  const puedeVer = hasPermiso('mia.ver');
  const puedeCalcular = hasPermiso('mia.calcular');
  const puedeAprobar = hasPermiso('mia.aprobar');
  const puedeConfigurar = hasPermiso('mia.configurar');
  const puedeAjustar = puedeCalcular || puedeAprobar;

  const jornada = fechaJornadaNegocioIso();
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [almacenes, setAlmacenes] = useState<AlmacenMia[]>([]);
  const [mismatches, setMismatches] = useState<MismatchResumen | null>(null);
  const [loadingAlmacenes, setLoadingAlmacenes] = useState(true);
  const [grupoFamiliaId, setGrupoFamiliaId] = useState<string | null>(null);
  const [modalGruposVisible, setModalGruposVisible] = useState(false);
  const {
    grupos,
    familias,
    loadingGrupos,
    loadingFamilias,
    cargarGrupos,
    cargarFamilias,
    guardarGrupo,
    borrarGrupo,
  } = useMiaGruposFamilias();

  const [fechaDesde, setFechaDesde] = useState(jornada);
  const [fechaHasta, setFechaHasta] = useState(addDaysIso(jornada, 6));
  const [semanasHistorico, setSemanasHistorico] = useState('4');
  const [colchonDias, setColchonDias] = useState('1');
  const [syncStock, setSyncStock] = useState(false);

  const [calculando, setCalculando] = useState(false);
  const [cargandoInforme, setCargandoInforme] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [aprobando, setAprobando] = useState(false);
  const [descargandoPdf, setDescargandoPdf] = useState(false);

  const [informe, setInforme] = useState<MiaInforme | null>(null);
  const [drafts, setDrafts] = useState<DraftLinea[]>([]);
  /** Último estado persistido (servidor); sirve para detectar dirty. */
  const [baseline, setBaseline] = useState<DraftLinea[]>([]);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [frescor, setFrescor] = useState<MiaFrescor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const [informesRecientes, setInformesRecientes] = useState<InformeListItem[]>([]);
  const [loadingRecientes, setLoadingRecientes] = useState(false);
  const [filtroEstado, setFiltroEstado] = useState('todos');
  const [borrandoId, setBorrandoId] = useState<string | null>(null);
  const [vista, setVista] = useState<VistaMia>('pedido');
  const [ocultarSinPedido, setOcultarSinPedido] = useState(true);
  const [modalProveedoresVisible, setModalProveedoresVisible] = useState(false);

  const opcionesAlmacen = useMemo(
    () =>
      almacenes.map((a) => ({
        id: a.id,
        titulo: a.nombre || a.id,
        subtitulo:
          a.localIds?.length > 0
            ? `${a.localIds.length} local(es)`
            : 'Sin locales vinculados',
      })),
    [almacenes],
  );

  const opcionesGrupoFamilia = useMemo(
    () =>
      grupos
        .filter((g) => g.activo !== false)
        .map((g) => ({
          id: g.id,
          titulo: g.nombre || g.id,
          subtitulo:
            g.familiaIds?.length > 0
              ? `${g.familiaIds.length} familia(s)`
              : 'Sin familias',
        })),
    [grupos],
  );

  const almacenNombre = useMemo(() => {
    const a = almacenes.find((x) => x.id === warehouseId);
    return a?.nombre || warehouseId || 'Almacén';
  }, [almacenes, warehouseId]);

  const grupoFamiliaNombre = useMemo(() => {
    const g = grupos.find((x) => x.id === grupoFamiliaId);
    return g?.nombre || grupoFamiliaId || '';
  }, [grupos, grupoFamiliaId]);

  const nombreFamiliaPorId = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of familias) m.set(f.id, f.nombre || f.id);
    return m;
  }, [familias]);

  const gruposDraft = useMemo(() => {
    const map = new Map<string, { proveedorId: string; proveedorNombre: string; lineas: DraftLinea[] }>();
    for (const d of drafts) {
      const key = d.proveedorId || 'SIN_PROVEEDOR';
      let g = map.get(key);
      if (!g) {
        g = {
          proveedorId: key,
          proveedorNombre: d.proveedorNombre || key,
          lineas: [],
        };
        map.set(key, g);
      }
      g.lineas.push(d);
    }
    return Array.from(map.values()).sort((a, b) =>
      a.proveedorNombre.localeCompare(b.proveedorNombre, 'es'),
    );
  }, [drafts]);

  const lineasSinPedido = useMemo(() => drafts.filter(sinPedido).length, [drafts]);

  const gruposVisibles = useMemo(() => {
    if (!ocultarSinPedido) return gruposDraft;
    return gruposDraft
      .map((g) => ({ ...g, lineas: g.lineas.filter((d) => !sinPedido(d)) }))
      .filter((g) => g.lineas.length > 0);
  }, [gruposDraft, ocultarSinPedido]);

  const totalesLocales = useMemo(() => {
    let productos = 0;
    let unidades = 0;
    let coste = 0;
    for (const d of drafts) {
      if (d.omitida) continue;
      const qty = parseQty(d.cantidadPedida);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      productos += 1;
      unidades += qty;
      coste += costeDraft(d);
    }
    return {
      productos,
      unidades: Math.round(unidades * 1000) / 1000,
      coste: Math.round(coste * 100) / 100,
    };
  }, [drafts]);

  const estadoInforme = String(informe?.estado || '');
  /** Solo lectura de líneas: calculado/revisado. aprobado_parcial y aprobando no editan cantidades. */
  const editable = !!informe && ['calculado', 'revisado'].includes(estadoInforme);
  /** Terminal: cerrado del todo. */
  const aprobado = estadoInforme === 'aprobado';
  /** Se puede lanzar / reintentar aprobación (no en curso ni terminal). */
  const puedeAprobarEstado =
    !!informe && ['calculado', 'revisado', 'aprobado_parcial'].includes(estadoInforme);

  const isDirty = useMemo(() => {
    if (!informe || !editable) return false;
    if (drafts.length !== baseline.length) return true;
    const map = new Map(baseline.map((b) => [lineKey(b.proveedorId, b.productId), b]));
    for (const d of drafts) {
      const b = map.get(lineKey(d.proveedorId, d.productId));
      if (!b) return true;
      if (b.omitida !== d.omitida) return true;
      if (String(d.cantidadPedida).trim() !== String(b.cantidadPedida).trim()) return true;
    }
    return false;
  }, [informe, editable, drafts, baseline]);

  const cargarAlmacenes = useCallback(async () => {
    setLoadingAlmacenes(true);
    setError(null);
    try {
      const r = await apiFetch('/api/mia/locales-almacenes');
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error || 'No se pudieron cargar los almacenes');
        setAlmacenes([]);
        return;
      }
      const list: AlmacenMia[] = (data.almacenes || []).map((a: AlmacenMia) => ({
        id: String(a.id),
        nombre: String(a.nombre || a.id),
        localIds: Array.isArray(a.localIds) ? a.localIds.map(String) : [],
      }));
      list.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      setAlmacenes(list);
      setMismatches(data.mismatches || null);
      setWarehouseId((prev) => prev || (list.length === 1 ? list[0].id : prev));
    } catch (e) {
      setError(errorMessage(e, 'Error cargando almacenes'));
    } finally {
      setLoadingAlmacenes(false);
    }
  }, []);

  const cargarGruposActivos = useCallback(async () => {
    const list = await cargarGrupos({ todos: false });
    setGrupoFamiliaId((prev) => {
      if (prev && list.some((g) => g.id === prev)) return prev;
      if (list.length === 1) return list[0].id;
      if (prev && !list.some((g) => g.id === prev)) return null;
      return prev;
    });
  }, [cargarGrupos]);

  const cargarRecientes = useCallback(async (wid: string) => {
    if (!wid) {
      setInformesRecientes([]);
      return;
    }
    setLoadingRecientes(true);
    try {
      const r = await apiFetch(`/api/mia/informes?warehouseId=${encodeURIComponent(wid)}&limit=100`);
      const data = await r.json();
      if (!r.ok || data.error) {
        setInformesRecientes([]);
        return;
      }
      setInformesRecientes(Array.isArray(data.items) ? data.items : []);
    } catch {
      setInformesRecientes([]);
    } finally {
      setLoadingRecientes(false);
    }
  }, []);

  useEffect(() => {
    if (puedeVer) cargarAlmacenes();
  }, [puedeVer, cargarAlmacenes]);

  useEffect(() => {
    if (puedeVer && vista === 'pedido') {
      void cargarGruposActivos();
      void cargarFamilias();
    }
  }, [puedeVer, vista, cargarGruposActivos, cargarFamilias]);

  useEffect(() => {
    if (warehouseId && puedeVer) cargarRecientes(warehouseId);
  }, [warehouseId, puedeVer, cargarRecientes]);

  // Al cambiar de almacén, limpia el informe abierto (los recientes se recargan arriba).
  useEffect(() => {
    setInforme(null);
    setDrafts([]);
    setBaseline([]);
    setAvisos([]);
    setFrescor(null);
    setOkMsg(null);
    setFiltroEstado('todos');
  }, [warehouseId]);

  const aplicarResultado = useCallback(
    (data: {
      informe?: MiaInforme;
      lineas?: MiaLinea[];
      avisos?: string[];
      frescor?: MiaFrescor;
    }) => {
      const meta = data.informe || null;
      const nextDrafts = toDraft(data.lineas || []);
      setInforme(meta);
      setDrafts(nextDrafts);
      setBaseline(nextDrafts.map((d) => ({ ...d })));
      setAvisos(Array.isArray(data.avisos) ? data.avisos : meta?.avisos || []);
      setFrescor(data.frescor || meta?.frescor || null);
    },
    [],
  );

  const calcular = useCallback(async () => {
    if (!puedeCalcular || !warehouseId || !grupoFamiliaId) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaDesde) || !/^\d{4}-\d{2}-\d{2}$/.test(fechaHasta)) {
      setError('Indica una fecha válida (dd/mm/aaaa)');
      return;
    }
    if (fechaDesde > fechaHasta) {
      setError('La fecha «Desde» no puede ser posterior a «Hasta».');
      return;
    }
    const sem = Math.floor(Number(semanasHistorico));
    const col = Number(colchonDias);
    if (!Number.isFinite(sem) || sem < 1) {
      setError('Semanas de histórico inválidas (mínimo 1).');
      return;
    }
    if (!Number.isFinite(col) || col < 0) {
      setError('Colchón de días inválido.');
      return;
    }

    const gfNombre =
      grupos.find((g) => g.id === grupoFamiliaId)?.nombre || grupoFamiliaNombre || undefined;

    setCalculando(true);
    setError(null);
    setOkMsg(null);
    try {
      const r = await apiFetch('/api/mia/calcular', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          warehouseId,
          grupoFamiliaId,
          ...(gfNombre ? { grupoFamiliaNombre: gfNombre } : {}),
          fechaDesde,
          fechaHasta,
          semanasHistorico: sem,
          colchonDias: col,
          syncStock,
        }),
      });
      const data = await r.json();
      if (!r.ok || data.ok === false || data.error) {
        const code = data.code || '';
        setError(
          (code && AVISO_LABEL[code]) || data.error || 'Error al calcular el pedido MIA',
        );
        return;
      }
      aplicarResultado(data);
      setOkMsg('Cálculo completado. Revisa las líneas antes de aprobar.');
      await cargarRecientes(warehouseId);
    } catch (e) {
      setError(errorMessage(e, 'Error de conexión al calcular'));
    } finally {
      setCalculando(false);
    }
  }, [
    puedeCalcular,
    warehouseId,
    grupoFamiliaId,
    grupoFamiliaNombre,
    grupos,
    fechaDesde,
    fechaHasta,
    semanasHistorico,
    colchonDias,
    syncStock,
    aplicarResultado,
    cargarRecientes,
  ]);

  const abrirInforme = useCallback(
    async (id: string) => {
      if (!id) return;
      setCargandoInforme(true);
      setError(null);
      setOkMsg(null);
      try {
        const r = await apiFetch(`/api/mia/informes/${encodeURIComponent(id)}`);
        const data = await r.json();
        if (!r.ok || data.error) {
          setError(data.error || 'No se pudo abrir el informe');
          return;
        }
        aplicarResultado(data);
        if (data.informe?.fechaDesde) setFechaDesde(data.informe.fechaDesde);
        if (data.informe?.fechaHasta) setFechaHasta(data.informe.fechaHasta);
        if (data.informe?.semanasHistorico != null) {
          setSemanasHistorico(String(data.informe.semanasHistorico));
        }
        if (data.informe?.colchonDias != null) {
          setColchonDias(String(data.informe.colchonDias));
        }
        if (data.informe?.grupoFamiliaId != null && data.informe.grupoFamiliaId !== '') {
          setGrupoFamiliaId(String(data.informe.grupoFamiliaId));
        }
      } catch (e) {
        setError(errorMessage(e, 'Error abriendo informe'));
      } finally {
        setCargandoInforme(false);
      }
    },
    [aplicarResultado],
  );

  const informesFiltrados = useMemo(() => {
    if (filtroEstado === 'todos') return informesRecientes;
    return informesRecientes.filter((it) => String(it.estado || '') === filtroEstado);
  }, [informesRecientes, filtroEstado]);

  const chipsEstado = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of informesRecientes) {
      const estado = String(it.estado || '').trim();
      if (!estado) continue;
      counts.set(estado, (counts.get(estado) || 0) + 1);
    }
    const conocidos = new Set(ESTADOS_INFORME.map((e) => e.id));
    const chips = [
      { id: 'todos', label: 'Todos', n: informesRecientes.length },
      ...ESTADOS_INFORME.map((e) => ({ id: e.id, label: e.label, n: counts.get(e.id) || 0 })),
    ];
    for (const [id, n] of counts) {
      if (!conocidos.has(id)) chips.push({ id, label: id, n });
    }
    return chips.filter((c) => c.id === 'todos' || c.id === filtroEstado || c.n > 0);
  }, [informesRecientes, filtroEstado]);

  const borrarInforme = useCallback(
    async (it: InformeListItem) => {
      const id = String(it.informeId || '').trim();
      if (!id || !puedeCalcular || borrandoId) return;
      const fechas = `${formatFecha(it.fechaDesde || '')} – ${formatFecha(it.fechaHasta || '')}`;
      const pedidos = pedidosAgoraDe(it);
      const estado = String(it.estado || '');
      const avisoAgora =
        pedidos.length > 0
          ? ` Tiene pedido en Ágora (${pedidos.join(', ')}). Ese pedido no se anula.`
          : estado === 'aprobado' || estado === 'aprobado_parcial' || estado === 'aprobando'
            ? ' Si ya creó un pedido en Ágora, ese pedido no se anula.'
            : '';
      const ok = await confirmar(
        'Borrar informe',
        `Se borrará el informe ${fechas}.${avisoAgora} Esta acción no se puede deshacer.`,
        { confirmarLabel: 'Borrar', variant: 'danger' },
      );
      if (!ok) return;
      setBorrandoId(id);
      setError(null);
      setOkMsg(null);
      try {
        const r = await apiFetch(`/api/mia/informes/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.error) {
          setError(data.error || 'No se pudo borrar el informe');
          return;
        }
        setInformesRecientes((prev) => prev.filter((x) => String(x.informeId || '') !== id));
        if (informe?.informeId === id) {
          setInforme(null);
          setDrafts([]);
          setBaseline([]);
          setAvisos([]);
          setFrescor(null);
        }
        setOkMsg('Informe borrado.');
      } catch (e) {
        setError(errorMessage(e, 'Error borrando informe'));
      } finally {
        setBorrandoId(null);
      }
    },
    [puedeCalcular, borrandoId, confirmar, informe?.informeId],
  );

  const updateDraft = useCallback((key: string, patch: Partial<DraftLinea>) => {
    setDrafts((prev) =>
      prev.map((d) => (lineKey(d.proveedorId, d.productId) === key ? { ...d, ...patch } : d)),
    );
    setOkMsg(null);
  }, []);

  const guardarAjustes = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (!informe?.informeId || !puedeAjustar || !editable) return false;
      const lineas = [];
      for (const d of drafts) {
        const qty = parseQty(d.cantidadPedida);
        if (!Number.isFinite(qty)) {
          setError(`Cantidad inválida en «${d.nombre}»`);
          return false;
        }
        lineas.push({
          productId: d.productId,
          proveedorId: d.proveedorId,
          cantidadPedida: qty,
          omitida: d.omitida,
        });
      }
      if (lineas.length === 0) {
        setError('No hay líneas para guardar');
        return false;
      }

      setGuardando(true);
      setError(null);
      if (!opts?.silent) setOkMsg(null);
      try {
        const r = await apiFetch(`/api/mia/informes/${encodeURIComponent(informe.informeId)}/lineas`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lineas }),
        });
        const data = await r.json();
        if (!r.ok || data.ok === false || data.error) {
          setError(data.error || 'No se pudieron guardar los ajustes');
          return false;
        }
        aplicarResultado(data);
        if (!opts?.silent) {
          setOkMsg(`Ajustes guardados (${data.actualizadas ?? lineas.length} líneas).`);
        }
        if (warehouseId) await cargarRecientes(warehouseId);
        return true;
      } catch (e) {
        setError(errorMessage(e, 'Error guardando ajustes'));
        return false;
      } finally {
        setGuardando(false);
      }
    },
    [informe, puedeAjustar, editable, drafts, aplicarResultado, warehouseId, cargarRecientes],
  );

  const descargarPdf = useCallback(async () => {
    if (!informe || drafts.length === 0) return;

    // Persistir cambios locales antes del PDF para que coincida con el servidor.
    if (isDirty) {
      if (!puedeAjustar || !editable) {
        setError('Guarda los ajustes antes de descargar el PDF.');
        return;
      }
      const saved = await guardarAjustes({ silent: true });
      if (!saved) return;
    }

    setDescargandoPdf(true);
    setError(null);
    try {
      const grupos = gruposDraft.map((g) => ({
        proveedorId: g.proveedorId,
        proveedorNombre: g.proveedorNombre,
        lineas: g.lineas.map((d) => ({
          productId: d.productId,
          nombre: d.nombre,
          cantidadPedida: parseQty(d.cantidadPedida) || 0,
          unit: d.unit,
          costeLinea: costeDraft(d),
          omitida: d.omitida,
        })),
      }));
      const { doc, filename } = await generarPdfMiaInforme({
        warehouseId: String(informe.warehouseId || informe.WarehouseId || warehouseId || ''),
        warehouseNombre: almacenNombre,
        fechaDesde: informe.fechaDesde || fechaDesde,
        fechaHasta: informe.fechaHasta || fechaHasta,
        informeId: informe.informeId,
        estado: informe.estado,
        grupos,
        incluirOmitidas: false,
      });
      if (Platform.OS === 'web') {
        doc.save(filename);
      } else {
        setError('La descarga de PDF está disponible en la versión web.');
      }
    } catch (e) {
      setError(errorMessage(e, 'No se pudo generar el PDF'));
    } finally {
      setDescargandoPdf(false);
    }
  }, [
    informe,
    drafts,
    gruposDraft,
    warehouseId,
    almacenNombre,
    fechaDesde,
    fechaHasta,
    isDirty,
    puedeAjustar,
    editable,
    guardarAjustes,
  ]);

  const aprobar = useCallback(async () => {
    if (!informe?.informeId || !puedeAprobar || !puedeAprobarEstado) return;
    const esReintento = estadoInforme === 'aprobado_parcial';
    const ok = await confirmar(
      esReintento ? 'Reintentar aprobación MIA' : 'Aprobar pedido MIA',
      esReintento
        ? 'Se reintentará el envío a Ágora de los proveedores pendientes o fallidos. ¿Continuar?'
        : 'Se crearán los pedidos de compra en Ágora con las líneas no omitidas. ¿Continuar?',
      { confirmarLabel: esReintento ? 'Reintentar' : 'Aprobar', variant: 'default' },
    );
    if (!ok) return;

    setAprobando(true);
    setError(null);
    setOkMsg(null);
    try {
      // Auto-guardar drafts dirty antes de aprobar (evita aprobar cantidades obsoletas).
      if (isDirty) {
        if (!puedeAjustar || !editable) {
          setError('Guarda los ajustes antes de aprobar.');
          return;
        }
        const saved = await guardarAjustes({ silent: true });
        if (!saved) return;
      }

      const r = await apiFetch(`/api/mia/informes/${encodeURIComponent(informe.informeId)}/aprobar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // force: solo reenvía proveedores pendientes/fallidos (no duplica los ya OK).
        body: JSON.stringify(esReintento ? { force: true } : {}),
      });
      const data = await r.json();

      // HTTP error (409, 400, 502…): fallo duro.
      if (!r.ok) {
        setError(data.error || 'Error al aprobar el informe');
        return;
      }

      const esParcial =
        data.parcial === true ||
        data.resumen?.estado === 'aprobado_parcial' ||
        data.informe?.estado === 'aprobado_parcial';

      // Éxito parcial (HTTP 200 + ok:false/parcial): actualizar informe y avisar, no error duro.
      if (esParcial) {
        if (data.informe) {
          setInforme(data.informe);
        } else {
          setInforme((prev) => (prev ? { ...prev, estado: 'aprobado_parcial' } : prev));
        }
        const enviados =
          typeof data.resumen?.proveedoresEnviados === 'number' ? data.resumen.proveedoresEnviados : 0;
        const fallidos =
          typeof data.resumen?.proveedoresFallidos === 'number' ? data.resumen.proveedoresFallidos : 0;
        const pendientes =
          typeof data.resumen?.proveedoresPendientes === 'number'
            ? data.resumen.proveedoresPendientes
            : 0;
        const partes = [`${enviados} enviado(s)`, `${fallidos} fallido(s)`];
        if (pendientes > 0) partes.push(`${pendientes} pendiente(s)`);
        setOkMsg(
          `Aprobación parcial: ${partes.join(', ')}. Puedes reintentar el envío de los que fallaron.`,
        );
        if (warehouseId) await cargarRecientes(warehouseId);
        return;
      }

      if (data.ok === false || data.error) {
        setError(data.error || 'Error al aprobar el informe');
        return;
      }

      if (data.informe) {
        setInforme(data.informe);
      } else {
        setInforme((prev) => (prev ? { ...prev, estado: 'aprobado' } : prev));
      }

      const enviados =
        typeof data.resumen?.proveedoresEnviados === 'number'
          ? data.resumen.proveedoresEnviados
          : Array.isArray(data.agoraResultados)
            ? data.agoraResultados.filter((x: { ok?: boolean }) => x?.ok).length
            : null;
      const omitidasAgora =
        typeof data.resumen?.lineasOmitidasAgora === 'number'
          ? data.resumen.lineasOmitidasAgora
          : Array.isArray(data.omitidasAgora)
            ? data.omitidasAgora.length
            : 0;

      if (enviados === 0) {
        setOkMsg(
          omitidasAgora > 0
            ? 'Informe aprobado. No se envió ningún pedido a Ágora (líneas sin proveedor válido).'
            : 'Informe aprobado. No se envió ningún pedido a Ágora.',
        );
      } else if (typeof enviados === 'number' && enviados > 0) {
        const fallidos =
          typeof data.resumen?.proveedoresFallidos === 'number' ? data.resumen.proveedoresFallidos : 0;
        setOkMsg(
          fallidos > 0
            ? `Informe aprobado. ${enviados} pedido(s) enviado(s) a Ágora (${fallidos} fallido(s)).`
            : `Informe aprobado. ${enviados} pedido(s) enviado(s) a Ágora.`,
        );
      } else {
        setOkMsg('Informe aprobado y enviado a Ágora.');
      }

      if (warehouseId) await cargarRecientes(warehouseId);
    } catch (e) {
      setError(errorMessage(e, 'Error aprobando informe'));
    } finally {
      setAprobando(false);
    }
  }, [
    informe,
    puedeAprobar,
    puedeAprobarEstado,
    estadoInforme,
    confirmar,
    warehouseId,
    cargarRecientes,
    isDirty,
    puedeAjustar,
    editable,
    guardarAjustes,
  ]);

  if (!puedeVer) {
    return (
      <View style={[styles.container, styles.centro]}>
        <MaterialIcons name="lock-outline" size={32} color={miaColors.textSecondary} />
        <Text style={styles.sinPermisoText}>No tienes permiso para ver MIA.</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.btnPrimary}>
          <Text style={styles.btnPrimaryText}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const busy = calculando || cargandoInforme || guardando || aprobando || descargandoPdf;
  const hayMismatch =
    (mismatches?.nombresSinAlmacen?.length || 0) > 0 ||
    (mismatches?.almacenesSinLocal?.length || 0) > 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button">
          <Text style={styles.backText}>‹ Volver</Text>
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.title}>MIA — Aprovisionamiento</Text>
          <Text style={styles.subtitle}>
            {vista === 'calendario'
              ? 'Calendario informativo de días de pedido por local y proveedor.'
              : 'Calcula el pedido sugerido por almacén, revisa cantidades y aprueba hacia Ágora.'}
          </Text>
        </View>
      </View>

      <View style={styles.vistaRow}>
        <TouchableOpacity
          style={[styles.vistaBtn, vista === 'pedido' && styles.vistaBtnActivo]}
          onPress={() => setVista('pedido')}
          accessibilityRole="button"
        >
          <MaterialIcons
            name="shopping-cart"
            size={16}
            color={vista === 'pedido' ? miaColors.accent : miaColors.textSecondary}
          />
          <Text style={[styles.vistaBtnText, vista === 'pedido' && styles.vistaBtnTextActivo]}>
            Pedido
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.vistaBtn, vista === 'calendario' && styles.vistaBtnActivo]}
          onPress={() => setVista('calendario')}
          accessibilityRole="button"
        >
          <MaterialIcons
            name="calendar-month"
            size={16}
            color={vista === 'calendario' ? miaColors.accent : miaColors.textSecondary}
          />
          <Text style={[styles.vistaBtnText, vista === 'calendario' && styles.vistaBtnTextActivo]}>
            Calendario
          </Text>
        </TouchableOpacity>
      </View>

      {vista === 'calendario' ? (
        <MiaCalendarioPedidos />
      ) : (
      <View style={styles.pedidoBody}>
        <View style={[styles.card, styles.cardOnTop, styles.paramsStrip]}>
          <Text style={[styles.stepTitle, styles.paramsTitle]}>1. Parámetros</Text>

          <View style={[styles.paramsRow, shouldStackToolbar && styles.paramsCol]}>
            <View style={[styles.fieldGrow, shouldStackToolbar && styles.fieldFull]}>
              <View style={styles.fieldLabelRow}>
                <Text style={[styles.fieldLabel, { marginBottom: 0 }]}>Almacén</Text>
                {puedeConfigurar ? (
                  <TouchableOpacity
                    onPress={() => setModalProveedoresVisible(true)}
                    style={styles.linkGestionar}
                    disabled={busy}
                  >
                    <MaterialIcons name="schedule" size={14} color={miaColors.accent} />
                    <Text style={styles.linkGestionarText}>Plazos por proveedor</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <SelectorDesplegable
                placeholder="Selecciona almacén…"
                icono="warehouse"
                opciones={opcionesAlmacen}
                valorId={warehouseId}
                onSeleccionar={setWarehouseId}
                tituloLista="Almacenes"
                iconoLista="warehouse"
                loading={loadingAlmacenes}
                buscador
                compact
              />
            </View>

            <View style={[styles.fieldGrow, shouldStackToolbar && styles.fieldFull]}>
              <View style={styles.fieldLabelRow}>
                <Text style={[styles.fieldLabel, { marginBottom: 0 }]}>Agrupación de familias</Text>
                {puedeConfigurar ? (
                  <TouchableOpacity
                    onPress={() => {
                      void (async () => {
                        setModalGruposVisible(true);
                        await Promise.all([cargarGrupos({ todos: true }), cargarFamilias()]);
                      })();
                    }}
                    style={styles.linkGestionar}
                    disabled={busy}
                  >
                    <MaterialIcons name="settings" size={14} color={miaColors.accent} />
                    <Text style={styles.linkGestionarText}>Gestionar agrupaciones</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <SelectorDesplegable
                placeholder="Selecciona agrupación…"
                icono="category"
                opciones={opcionesGrupoFamilia}
                valorId={grupoFamiliaId}
                onSeleccionar={setGrupoFamiliaId}
                tituloLista="Agrupaciones de familias"
                iconoLista="category"
                loading={loadingGrupos}
                buscador
                compact
                vacioTexto="No hay agrupaciones. Crea alguna con «Gestionar agrupaciones»"
              />
            </View>

            <View style={[styles.fieldGrow, shouldStackToolbar && styles.fieldFull]}>
              <Text style={styles.fieldLabel}>Rango objetivo</Text>
              <RangoFechas
                desdeIso={fechaDesde}
                hastaIso={fechaHasta}
                onChangeDesde={setFechaDesde}
                onChangeHasta={setFechaHasta}
                fill
              />
            </View>
          </View>

          <View style={[styles.paramsRow, shouldStackToolbar && styles.paramsCol, { marginTop: 10 }]}>
            <View style={styles.numField}>
              <Text style={styles.fieldLabel}>Semanas histórico</Text>
              <TextInput
                style={styles.inputNum}
                value={semanasHistorico}
                onChangeText={setSemanasHistorico}
                keyboardType="number-pad"
                editable={!busy}
              />
            </View>
            <View style={styles.numField}>
              <Text style={styles.fieldLabel}>Colchón (días)</Text>
              <TextInput
                style={styles.inputNum}
                value={colchonDias}
                onChangeText={setColchonDias}
                keyboardType="decimal-pad"
                editable={!busy}
              />
            </View>
            <View style={styles.switchField}>
              <Text style={styles.fieldLabel}>Sync stock al calcular</Text>
              <View style={styles.switchRow}>
                <Switch
                  value={syncStock}
                  onValueChange={setSyncStock}
                  disabled={busy}
                  trackColor={{ false: miaColors.border, true: miaColors.accentMuted }}
                  thumbColor={syncStock ? miaColors.accent : miaColors.surface}
                />
                <Text style={styles.switchHint}>{syncStock ? 'Sí' : 'No'}</Text>
              </View>
            </View>
            <TouchableOpacity
              style={[
                styles.btnPrimary,
                styles.btnCalcular,
                (!puedeCalcular || !warehouseId || !grupoFamiliaId || busy) && styles.btnDisabled,
              ]}
              onPress={calcular}
              disabled={!puedeCalcular || !warehouseId || !grupoFamiliaId || busy}
            >
              {calculando ? (
                <ActivityIndicator color={miaColors.onAccent} size="small" />
              ) : (
                <>
                  <MaterialIcons name="auto-awesome" size={18} color={miaColors.onAccent} />
                  <Text style={styles.btnPrimaryText}>Calcular</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {!puedeCalcular && (
            <Text style={styles.hintMuted}>Necesitas el permiso mia.calcular para lanzar el cálculo.</Text>
          )}

          {hayMismatch && (
            <View style={styles.warnBox}>
              <MaterialIcons name="warning-amber" size={18} color={miaColors.warning} />
              <Text style={styles.warnText}>
                Hay desajustes local↔almacén
                {mismatches?.nombresSinAlmacen?.length
                  ? ` · ${mismatches.nombresSinAlmacen.length} nombre(s) sin almacén`
                  : ''}
                {mismatches?.almacenesSinLocal?.length
                  ? ` · ${mismatches.almacenesSinLocal.length} almacén(es) sin local`
                  : ''}
                . Revisa la configuración si el cálculo no cuadra.
              </Text>
            </View>
          )}
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <MaterialIcons name="error-outline" size={18} color={miaColors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
        {okMsg ? (
          <View style={styles.okBox}>
            <MaterialIcons name="check-circle" size={18} color={miaColors.success} />
            <Text style={styles.okText}>{okMsg}</Text>
          </View>
        ) : null}

        <View style={[styles.paneles, shouldStackPanels && styles.panelesStack]}>
          <View style={styles.panel}>
            <ScrollView
              style={styles.panelScroll}
              contentContainerStyle={styles.panelContent}
              keyboardShouldPersistTaps="handled"
            >
        {warehouseId ? (
          <View>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.stepTitle}>Informes recientes</Text>
              {loadingRecientes ? <ActivityIndicator size="small" color={miaColors.accent} /> : null}
            </View>
            {informesRecientes.length === 0 && !loadingRecientes ? (
              <Text style={styles.hintMuted}>No hay informes para este almacén.</Text>
            ) : (
              <>
                <View style={styles.chipsRow}>
                  {chipsEstado.map((chip) => {
                    const activo = filtroEstado === chip.id;
                    return (
                      <TouchableOpacity
                        key={chip.id}
                        style={[styles.chip, activo && styles.chipActivo, isPhone && { minHeight: MIN_TOUCH }]}
                        onPress={() => setFiltroEstado(chip.id)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: activo }}
                      >
                        <Text style={[styles.chipText, activo && styles.chipTextActivo]}>
                          {chip.label} {chip.n}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {informesFiltrados.length === 0 ? (
                  <Text style={styles.hintMuted}>No hay informes en este estado.</Text>
                ) : (
                  informesFiltrados.map((it) => {
                    const id = String(it.informeId || '');
                    const activo = informe?.informeId === id;
                    const creado = it.creadoEn || it.CreadoEn || '';
                    const etiqueta =
                      ESTADOS_INFORME.find((e) => e.id === it.estado)?.label || it.estado || '—';
                    return (
                      <View
                        key={id}
                        style={[styles.recienteRow, activo && styles.recienteActivo]}
                      >
                        <TouchableOpacity
                          style={[styles.recienteMain, isPhone && { minHeight: MIN_TOUCH }]}
                          onPress={() => abrirInforme(id)}
                          disabled={busy || !id}
                        >
                          <Text style={styles.recienteTitle}>
                            {formatFecha(it.fechaDesde || '')} – {formatFecha(it.fechaHasta || '')}
                            {' · '}
                            <Text
                              style={[
                                styles.estadoChip,
                                { color: COLOR_ESTADO[it.estado || ''] || miaColors.textSecondary },
                              ]}
                            >
                              {etiqueta}
                            </Text>
                          </Text>
                          <Text style={styles.recienteSub}>
                            {formatTsLista(creado)}
                            {it.totales?.costeTotal != null
                              ? ` · ${formatMoneda(it.totales.costeTotal)}`
                              : ''}
                          </Text>
                        </TouchableOpacity>
                        {puedeCalcular ? (
                          <TouchableOpacity
                            style={[styles.btnBorrar, isPhone && { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH }]}
                            onPress={() => {
                              void borrarInforme(it);
                            }}
                            disabled={busy || borrandoId === id}
                            accessibilityLabel={`Borrar informe ${etiqueta}`}
                          >
                            {borrandoId === id ? (
                              <ActivityIndicator size="small" color={miaColors.danger} />
                            ) : (
                              <MaterialIcons name="delete-outline" size={20} color={miaColors.danger} />
                            )}
                          </TouchableOpacity>
                        ) : null}
                        <MaterialIcons name="chevron-right" size={22} color={miaColors.textSecondary} />
                      </View>
                    );
                  })
                )}
              </>
            )}
          </View>
        ) : (
          <View>
            <Text style={styles.stepTitle}>Informes recientes</Text>
            <Text style={styles.hintMuted}>Selecciona un almacén para ver los informes.</Text>
          </View>
        )}
            </ScrollView>
          </View>

          <View style={styles.panel}>
            <ScrollView
              style={styles.panelScroll}
              contentContainerStyle={styles.panelContent}
              keyboardShouldPersistTaps="handled"
            >
        {cargandoInforme ? (
          <View style={[styles.centro, { paddingVertical: 32 }]}>
            <ActivityIndicator color={miaColors.accent} />
            <Text style={[styles.hintMuted, { marginTop: 8 }]}>Cargando informe…</Text>
          </View>
        ) : null}

        {informe && !cargandoInforme ? (
          <View>
            <View style={[styles.cardHeaderRow, shouldStackPanels && styles.paramsCol]}>
              <View style={styles.revisionIntro}>
                <Text style={styles.stepTitle}>2. Revisión</Text>
                <View style={styles.revisionTitleRow}>
                  <Text style={styles.revisionRango}>
                    {formatFecha(informe.fechaDesde || '')} – {formatFecha(informe.fechaHasta || '')}
                  </Text>
                  <Text
                    style={[
                      styles.estadoChip,
                      { color: COLOR_ESTADO[estadoInforme] || miaColors.textSecondary },
                    ]}
                  >
                    {ESTADOS_INFORME.find((e) => e.id === estadoInforme)?.label || estadoInforme || '—'}
                  </Text>
                </View>
                <Text style={styles.hintMuted}>
                  {informe.grupoFamiliaId || informe.grupoFamiliaNombre
                    ? `Agrupación: ${
                        informe.grupoFamiliaNombre ||
                        grupos.find((g) => g.id === String(informe.grupoFamiliaId))?.nombre ||
                        String(informe.grupoFamiliaId)
                      }`
                    : 'Sin agrupación'}
                  {Array.isArray(informe.familiaIds) && informe.familiaIds.length > 0
                    ? ` · Familias: ${informe.familiaIds
                        .slice(0, 5)
                        .map((id) => nombreFamiliaPorId.get(String(id)) || String(id))
                        .join(', ')}${informe.familiaIds.length > 5 ? '…' : ''}`
                    : ''}
                </Text>
              </View>
              <View style={[styles.actionsRow, styles.actionsRight, shouldStackPanels && styles.actionsWrap]}>
                <TouchableOpacity
                  style={[
                    styles.btnSecondary,
                    isDirty && editable && styles.btnSecondaryDirty,
                    (!puedeAjustar || !editable || busy) && styles.btnDisabled,
                  ]}
                  onPress={() => {
                    void guardarAjustes();
                  }}
                  disabled={!puedeAjustar || !editable || busy}
                >
                  {guardando ? (
                    <ActivityIndicator size="small" color={miaColors.accent} />
                  ) : (
                    <>
                      <MaterialIcons name="save" size={18} color={miaColors.accent} />
                      <Text style={styles.btnSecondaryText}>
                        {isDirty ? 'Guardar ajustes*' : 'Guardar ajustes'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btnSecondary, (busy || drafts.length === 0) && styles.btnDisabled]}
                  onPress={descargarPdf}
                  disabled={busy || drafts.length === 0}
                >
                  {descargandoPdf ? (
                    <ActivityIndicator size="small" color={miaColors.accent} />
                  ) : (
                    <>
                      <MaterialIcons name="picture-as-pdf" size={18} color={miaColors.accent} />
                      <Text style={styles.btnSecondaryText}>PDF</Text>
                    </>
                  )}
                </TouchableOpacity>
                {puedeAprobar && puedeAprobarEstado ? (
                <TouchableOpacity
                  style={[
                    styles.btnSuccess,
                    (busy || totalesLocales.productos === 0) && styles.btnDisabled,
                  ]}
                  onPress={aprobar}
                  disabled={busy || totalesLocales.productos === 0}
                >
                  {aprobando ? (
                    <ActivityIndicator size="small" color={miaColors.onAccent} />
                  ) : (
                    <>
                      <MaterialIcons name="check" size={18} color={miaColors.onAccent} />
                      <Text style={styles.btnPrimaryText}>
                        {estadoInforme === 'aprobado_parcial' ? 'Reintentar' : 'Aprobar'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
                ) : null}
              </View>
            </View>

            {isDirty && editable ? (
              <Text style={styles.dirtyHint}>
                Hay cambios sin guardar. Se guardarán automáticamente al aprobar o descargar el PDF.
              </Text>
            ) : null}

            {avisos.length > 0 ? (
              <View style={styles.frescorBox}>
                {frescor ? (
                  <Text style={styles.frescorText}>
                    Stock sync: {formatTs(frescor.stockLastOkAt)}
                    {frescor.stockLastError ? ` · Err: ${frescor.stockLastError}` : ''}
                    {'\n'}Ventas sync:{' '}
                    {formatTs(frescor.ventasLastSyncTs ?? frescor.ventasLastSync)}
                  </Text>
                ) : null}
                {avisos.map((a) => (
                  <View key={a} style={styles.avisoChip}>
                    <MaterialIcons name="info-outline" size={14} color={miaColors.warning} />
                    <Text style={styles.avisoText}>{labelAviso(a)}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            <View style={styles.totalesGrid}>
              <View style={styles.totalBlock}>
                <Text style={styles.totalBlockLabel}>Productos</Text>
                <Text style={styles.totalBlockValue}>{totalesLocales.productos}</Text>
              </View>
              <View style={styles.totalBlock}>
                <Text style={styles.totalBlockLabel}>Unidades</Text>
                <Text style={styles.totalBlockValue}>{formatCantidad(totalesLocales.unidades)}</Text>
              </View>
              <View style={styles.totalBlock}>
                <Text style={styles.totalBlockLabel}>Proveedores</Text>
                <Text style={styles.totalBlockValue}>{gruposDraft.length}</Text>
              </View>
              <View style={styles.totalBlock}>
                <Text style={styles.totalBlockLabel}>Coste</Text>
                <Text style={styles.totalBlockValue}>{formatMoneda(totalesLocales.coste)}</Text>
              </View>
            </View>
            {!editable && (
                <Text style={styles.hintMuted}>
                  {aprobado
                    ? 'Informe aprobado (solo lectura).'
                    : estadoInforme === 'aprobado_parcial'
                      ? 'Aprobación parcial: líneas en solo lectura. Puedes reintentar el envío.'
                      : estadoInforme === 'aprobando'
                        ? 'Aprobación en curso…'
                        : 'No editable en este estado.'}
                </Text>
            )}

            {lineasSinPedido > 0 ? (
              <View style={styles.filtroRow}>
                <Switch
                  value={ocultarSinPedido}
                  onValueChange={setOcultarSinPedido}
                  trackColor={{ false: miaColors.border, true: miaColors.accentMuted }}
                  thumbColor={ocultarSinPedido ? miaColors.accent : miaColors.surface}
                />
                <Text style={styles.switchHint}>
                  Ocultar sin pedido ({lineasSinPedido}{' '}
                  {lineasSinPedido === 1 ? 'producto con stock suficiente' : 'productos con stock suficiente'})
                </Text>
              </View>
            ) : null}

            {gruposVisibles.length === 0 ? (
              <Text style={styles.hintMuted}>
                {gruposDraft.length === 0
                  ? 'Sin líneas de pedido en este informe.'
                  : 'No hay nada que pedir: todos los productos tienen stock suficiente.'}
              </Text>
            ) : (
              gruposVisibles.map((g) => {
                const subtotal = g.lineas.reduce((s, d) => s + costeDraft(d), 0);
                return (
                  <View key={g.proveedorId} style={styles.proveedorBlock}>
                    <View style={styles.proveedorHeader}>
                      <MaterialIcons name="local-shipping" size={18} color={miaColors.accent} />
                      <Text style={styles.proveedorTitle}>{g.proveedorNombre}</Text>
                      <Text style={styles.proveedorSub}>{formatMoneda(subtotal)}</Text>
                    </View>

                    <View style={styles.tableHead}>
                      <Text style={[styles.th, styles.colProducto]}>Producto</Text>
                      <Text style={[styles.th, styles.colStock]}>Stock</Text>
                      <Text style={[styles.th, styles.colQty]}>Cant.</Text>
                      <Text style={[styles.th, styles.colCoste]}>Coste</Text>
                      <Text style={[styles.th, styles.colOmit]}>Omitir</Text>
                    </View>

                    {g.lineas.map((d) => {
                      const key = lineKey(d.proveedorId, d.productId);
                      return (
                        <View
                          key={key}
                          style={[styles.tableRow, d.omitida && styles.tableRowOmit, shouldStackPanels && styles.tableRowStack]}
                        >
                          <View style={styles.colProducto}>
                            <View style={styles.productoTitulo}>
                              <Text style={styles.productoNombre} numberOfLines={2}>
                                {d.nombre}
                              </Text>
                              {d.productId ? (
                                <View
                                  style={styles.idBadge}
                                  accessibilityLabel={`Id de producto ${d.productId}`}
                                >
                                  <Text style={styles.idBadgeText}>{d.productId}</Text>
                                </View>
                              ) : null}
                            </View>
                            <Text style={styles.productoMeta}>
                              {d.unit} · {formatMoneda(d.costeUnitario)}/ud
                              {d.minimo != null && d.maximo != null
                                ? ` · Mín ${formatCantidad(d.minimo)} · Máx ${formatCantidad(d.maximo)}`
                                : ''}
                            </Text>
                          </View>
                          <View style={styles.colStock}>
                            {d.semaforo ? (
                              <View
                                style={[styles.stockPill, { backgroundColor: SEMAFORO[d.semaforo].bg }]}
                                accessibilityLabel={`Stock ${formatCantidad(d.stock)}: ${SEMAFORO[d.semaforo].label}`}
                              >
                                <View style={[styles.stockDot, { backgroundColor: SEMAFORO[d.semaforo].text }]} />
                                <Text style={[styles.stockPillText, { color: SEMAFORO[d.semaforo].text }]}>
                                  {formatCantidad(d.stock)}
                                </Text>
                              </View>
                            ) : (
                              <Text style={styles.stockSinSemaforo}>{formatCantidad(d.stock)}</Text>
                            )}
                          </View>
                          <TextInput
                            style={[styles.inputQty, (!editable || busy) && styles.inputDisabled]}
                            value={d.cantidadPedida}
                            onChangeText={(t) => updateDraft(key, { cantidadPedida: t })}
                            keyboardType="decimal-pad"
                            editable={editable && !busy && !d.omitida}
                          />
                          <Text style={[styles.colCoste, styles.costeCell]}>{formatMoneda(costeDraft(d))}</Text>
                          <View style={styles.colOmit}>
                            <Switch
                              value={d.omitida}
                              onValueChange={(v) => updateDraft(key, { omitida: v })}
                              disabled={!editable || busy}
                              trackColor={{ false: miaColors.border, true: miaColors.dangerMuted }}
                              thumbColor={d.omitida ? miaColors.danger : miaColors.surface}
                            />
                          </View>
                        </View>
                      );
                    })}
                  </View>
                );
              })
            )}
          </View>
        ) : !cargandoInforme ? (
          <View>
            <Text style={styles.stepTitle}>2. Revisión</Text>
            <Text style={styles.hintMuted}>Calcula un pedido o abre un informe reciente.</Text>
          </View>
        ) : null}
            </ScrollView>
          </View>
        </View>
      </View>
      )}

      {ConfirmarView}

      <MiaGruposFamiliasModal
        visible={modalGruposVisible}
        onClose={() => {
          setModalGruposVisible(false);
          void cargarGruposActivos();
        }}
        grupos={grupos}
        familias={familias}
        loading={loadingGrupos || loadingFamilias}
        onGuardar={async (input) => {
          await guardarGrupo(input);
          await cargarGrupos({ todos: true });
        }}
        onBorrar={async (id) => {
          await borrarGrupo(id);
          await cargarGrupos({ todos: true });
          setGrupoFamiliaId((prev) => (prev === id ? null : prev));
        }}
      />

      <MiaProveedoresConfigModal
        visible={modalProveedoresVisible}
        onClose={() => setModalProveedoresVisible(false)}
        warehouseId={warehouseId}
        almacenNombre={warehouseId ? almacenNombre : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: miaColors.bg },
  centro: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  sinPermisoText: { fontSize: 15, color: miaColors.textSecondary, textAlign: 'center' },
  header: {
    backgroundColor: miaColors.surface,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: miaColors.border,
  },
  backBtn: { alignSelf: 'flex-start', marginBottom: 4, minHeight: 32, justifyContent: 'center' },
  backText: { color: miaColors.accent, fontSize: 15, fontWeight: '600' },
  headerTextWrap: { gap: 2 },
  title: { fontSize: 20, fontWeight: '700', color: miaColors.text },
  subtitle: { fontSize: 13, color: miaColors.textSecondary },
  vistaRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
    backgroundColor: miaColors.bg,
  },
  vistaBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    minHeight: MIN_TOUCH,
    borderRadius: 8,
    backgroundColor: miaColors.surface,
    borderWidth: 1,
    borderColor: miaColors.border,
  },
  vistaBtnActivo: { backgroundColor: miaColors.accentMuted, borderColor: miaColors.accentBorder },
  vistaBtnText: { fontSize: 13, fontWeight: '600', color: miaColors.textSecondary },
  vistaBtnTextActivo: { color: miaColors.accent },
  pedidoBody: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 8,
    overflow: 'hidden',
  },
  paramsStrip: { paddingVertical: 10, paddingHorizontal: 12 },
  paramsTitle: { fontSize: 14, marginBottom: 6 },
  paneles: {
    flex: 1,
    minHeight: 0,
    flexDirection: 'row',
    gap: 12,
  },
  panelesStack: { flexDirection: 'column' },
  panel: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: miaColors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: miaColors.border,
    overflow: 'hidden',
  },
  panelScroll: { flex: 1 },
  panelContent: { padding: 14, paddingBottom: 28 },
  card: {
    backgroundColor: miaColors.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: miaColors.border,
  },
  cardOnTop: { position: 'relative', zIndex: 30 },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  stepTitle: { fontSize: 16, fontWeight: '700', color: miaColors.text, marginBottom: 8 },
  paramsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' },
  paramsCol: { flexDirection: 'column', alignItems: 'stretch' },
  fieldGrow: { flex: 1, minWidth: 200 },
  fieldFull: { width: '100%', minWidth: 0 },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: miaColors.textSecondary, marginBottom: 4 },
  fieldLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
    flexWrap: 'wrap',
  },
  linkGestionar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
  },
  linkGestionarText: { fontSize: 12, fontWeight: '600', color: miaColors.accent },
  numField: { width: 120 },
  inputNum: {
    height: 36,
    borderWidth: 1,
    borderColor: miaColors.border,
    borderRadius: 8,
    backgroundColor: miaColors.bg,
    paddingHorizontal: 10,
    fontSize: 14,
    color: miaColors.text,
  },
  switchField: { minWidth: 160 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 36 },
  switchHint: { fontSize: 13, color: miaColors.textSecondary },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: miaColors.accent,
    borderRadius: 10,
    paddingHorizontal: 14,
    minHeight: MIN_TOUCH,
  },
  btnCalcular: { minWidth: 130 },
  btnPrimaryText: { color: miaColors.onAccent, fontWeight: '700', fontSize: 14 },
  btnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: miaColors.accentMuted,
    borderWidth: 1,
    borderColor: miaColors.accentBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: MIN_TOUCH,
  },
  btnSecondaryText: { color: miaColors.accent, fontWeight: '700', fontSize: 13 },
  btnSecondaryDirty: {
    borderColor: miaColors.warning,
    backgroundColor: miaColors.warningMuted,
  },
  dirtyHint: { fontSize: 12, color: miaColors.warning, marginBottom: 8, marginTop: -2 },
  btnSuccess: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: miaColors.success,
    borderRadius: 10,
    paddingHorizontal: 14,
    minHeight: MIN_TOUCH,
  },
  btnDisabled: { opacity: 0.45 },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actionsRight: { justifyContent: 'flex-end', alignSelf: 'flex-start' },
  actionsWrap: { width: '100%' },
  revisionIntro: { flex: 1, minWidth: 0 },
  revisionTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  revisionRango: { fontSize: 15, fontWeight: '700', color: miaColors.text },
  hintMuted: { fontSize: 12, color: miaColors.textSecondary, marginTop: 6 },
  warnBox: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 8,
    backgroundColor: miaColors.warningMuted,
    borderColor: miaColors.warningBorder,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    alignItems: 'flex-start',
  },
  warnText: { flex: 1, fontSize: 12, color: miaColors.warning, lineHeight: 18 },
  errorBox: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: miaColors.dangerMuted,
    borderColor: miaColors.dangerBorder,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    alignItems: 'flex-start',
  },
  errorText: { flex: 1, fontSize: 13, color: miaColors.danger },
  okBox: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: miaColors.successMuted,
    borderColor: miaColors.successBorder,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    alignItems: 'flex-start',
  },
  okText: { flex: 1, fontSize: 13, color: miaColors.success },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  chip: {
    backgroundColor: miaColors.borderSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipActivo: { backgroundColor: miaColors.accent },
  chipText: { fontSize: 12, fontWeight: '700', color: miaColors.textSecondary },
  chipTextActivo: { color: miaColors.onAccent },
  recienteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: miaColors.borderSoft,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
    gap: 4,
  },
  recienteMain: { flex: 1, paddingVertical: 6 },
  btnBorrar: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recienteActivo: {
    backgroundColor: miaColors.accentMuted,
    borderLeftColor: miaColors.accent,
    marginHorizontal: -6,
    paddingHorizontal: 6,
    borderRadius: 8,
  },
  recienteTitle: { fontSize: 13, fontWeight: '600', color: miaColors.text },
  recienteSub: { fontSize: 12, color: miaColors.textSecondary, marginTop: 2 },
  estadoChip: { fontWeight: '700', color: miaColors.info, textTransform: 'capitalize' },
  frescorBox: {
    backgroundColor: miaColors.warningMuted,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    gap: 6,
  },
  frescorText: { fontSize: 12, color: miaColors.warning, lineHeight: 18 },
  avisoChip: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  avisoText: { fontSize: 12, color: miaColors.warning, flex: 1 },
  totalesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, marginBottom: 8 },
  totalBlock: {
    flexGrow: 1,
    flexBasis: '22%',
    minWidth: 88,
    backgroundColor: miaColors.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: miaColors.border,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  totalBlockLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: miaColors.textSecondary,
    textTransform: 'uppercase',
  },
  totalBlockValue: {
    fontSize: 16,
    fontWeight: '700',
    color: miaColors.text,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  proveedorBlock: { marginBottom: 14 },
  proveedorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: miaColors.bg,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 6,
  },
  proveedorTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: miaColors.text },
  proveedorSub: { fontSize: 13, fontWeight: '600', color: miaColors.accent },
  tableHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 6,
    gap: 6,
    backgroundColor: miaColors.surface,
    borderBottomWidth: 1,
    borderBottomColor: miaColors.border,
    zIndex: 2,
    position: Platform.OS === 'web' ? ('sticky' as 'relative') : 'relative',
    top: 0,
  },
  th: { fontSize: 11, fontWeight: '700', color: miaColors.textSecondary, textTransform: 'uppercase' },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: miaColors.borderSoft,
  },
  tableRowStack: { flexWrap: 'wrap' },
  tableRowOmit: { opacity: 0.55 },
  colProducto: { flex: 1, minWidth: 140 },
  colQty: { width: 72, textAlign: 'right', fontVariant: ['tabular-nums'] },
  colStock: { width: 84, alignItems: 'flex-end', textAlign: 'right' },
  stockPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  stockDot: { width: 6, height: 6, borderRadius: radius.pill },
  stockPillText: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  stockSinSemaforo: {
    fontSize: 12,
    color: miaColors.textSecondary,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  filtroRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  colCoste: { width: 88, textAlign: 'right', fontVariant: ['tabular-nums'] },
  colOmit: { width: 56, alignItems: 'center', textAlign: 'center' },
  productoTitulo: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  productoNombre: { fontSize: 13, fontWeight: '600', color: miaColors.text, flexShrink: 1 },
  idBadge: {
    backgroundColor: miaColors.accentMuted,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  idBadgeText: { fontSize: 11, fontWeight: '700', color: miaColors.accent },
  productoMeta: { fontSize: 11, color: miaColors.textSecondary, marginTop: 2 },
  inputQty: {
    width: 72,
    height: 36,
    borderWidth: 1,
    borderColor: miaColors.border,
    borderRadius: 8,
    backgroundColor: miaColors.bg,
    paddingHorizontal: 8,
    fontSize: 13,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
    color: miaColors.text,
  },
  inputDisabled: { backgroundColor: miaColors.borderSoft, color: miaColors.textSecondary },
  costeCell: { fontSize: 13, fontWeight: '600', color: miaColors.text },
});
