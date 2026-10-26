import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Modal,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useRouter, useLocalSearchParams } from 'expo-router';
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
import { MIN_TOUCH } from '../../constants/layout';
import { MaterialIcons } from '@expo/vector-icons';
import { TablaBasica } from '../../components/TablaBasica';
import { InputFecha } from '../../components/InputFecha';
import { InputCantidad } from '../../components/InputCantidad';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { useProductosCache } from '../../contexts/ProductosCache';
import { useAuth } from '../../contexts/AuthContext';
import { fetchPorcentajeBeneficio, aplicarPorcentajeBeneficio } from '../../lib/personalizacion';
import { siguienteIdParaNuevoPedido } from '../../lib/pedidosId';
import {
  avisoFacturacionSalida,
  buscarLocalPorId,
  idAlmacenGeneral,
  localDeAlmacen,
} from '../../lib/pedidosEntreLocales';
import { apiFetch } from '../../utils/api';
import { anioEnCurso, urlPedidosPorAnio } from '../../lib/rangoAnioListado';
import { SelectorAnioListado } from '../../components/SelectorAnioListado';
import { BotonPrincipal } from '../../components/ui/BotonPrincipal';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatCreadoEn } from '../../utils/formatFecha';
import {
  CeldaFacturacionPedido,
  COLUMNA_FACTURACION,
} from '../../components/compras/CeldaFacturacionPedido';
import { BadgeFormato, useMapaFormatosBase } from '../../components/compras/BadgeFormato';
import { EtiquetaZona, ordenarLineasPorZona, useMapaZonas } from '../../components/compras/EtiquetaZona';
import { estadoFacturacionPedido } from '../../lib/comprasFacturacion';
import NuevoPedidoModal from '../../components/compras/NuevoPedidoModal';

const COLUMNAS = ['Id', 'Fecha', 'CreadoEn', 'LocalId', 'Local', 'AlmacenOrigen', 'AlmacenDestino', 'TotalAlbaran', 'Estado', COLUMNA_FACTURACION] as const;
const COLUMNAS_TABLA: string[] = [...COLUMNAS];
const COLUMNAS_MONEDA = ['TotalAlbaran'];
const ESTADOS = ['Borrador', 'Pendiente', 'Enviado', 'Exportado', 'Completado'] as const;

const COLOR_ESTADO: Record<string, { fondo: string; texto: string; franja: string }> = {
  Borrador: { fondo: '#f1f5f9', texto: '#64748b', franja: '#94a3b8' },
  Pendiente: { fondo: '#fef3c7', texto: '#b45309', franja: '#d97706' },
  Enviado: { fondo: '#e0f2fe', texto: '#0369a1', franja: '#0284c7' },
  Exportado: { fondo: '#f3e8ff', texto: '#7e22ce', franja: '#9333ea' },
  Completado: { fondo: '#dcfce7', texto: '#15803d', franja: '#16a34a' },
};

function fechaIsoLocal(d: Date): string {
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

function lunesDeSemanaIso(d: Date): string {
  const copia = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dia = copia.getDay();
  const retroceso = dia === 0 ? 6 : dia - 1;
  copia.setDate(copia.getDate() - retroceso);
  return fechaIsoLocal(copia);
}

function parseAlmacenesOrigen(val: string | number | undefined): string[] {
  if (val == null || String(val).trim() === '') return [];
  return String(val)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

type Pedido = Record<string, string | number | undefined>;
type Local = Record<string, string | number | undefined>;
type Almacen = Record<string, string | number | undefined>;

function valorEnLocal(item: Pedido | Local | Almacen, key: string): string | number | undefined {
  if (item[key] !== undefined && item[key] !== null) return item[key];
  const found = Object.keys(item).find((k) => k.toLowerCase() === key.toLowerCase());
  return found != null ? item[found] : undefined;
}

function fechaPedidoIso(p: Pedido): string {
  const fecha = String(valorEnLocal(p, 'Fecha') ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (fecha) return fecha[1];
  const creado = String(valorEnLocal(p, 'CreadoEn') ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return creado ? creado[1] : '';
}

function formatFecha(fecha: string | number | undefined): string {
  if (fecha == null || String(fecha).trim() === '') return '—';
  const s = String(fecha).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  }
  return s;
}

function formatMoneda(val: string | number | undefined): string {
  if (val == null || String(val).trim() === '') return '—';
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  if (Number.isNaN(n)) return String(val);
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

function fechaToIso(val: string): string {
  const s = val.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    let y = m[3];
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo}-${d}`;
  }
  return s;
}

/** Fecha de hoy en ISO yyyy-mm-dd. */
function fechaHoyIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Normaliza valor de API al ISO del formulario. */
function itemFechaToFormIso(fecha: string | number | undefined): string {
  if (fecha == null || String(fecha).trim() === '') return '';
  const iso = fechaToIso(String(fecha).trim());
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
}

/**
 * Precio de venta de una línea. Si la línea trae `PrecioVenta` (precio CONGELADO
 * en el momento de crearse, con el % de beneficio de entonces), se usa tal cual
 * para que el importe del albarán no cambie al variar el % global. Para líneas
 * antiguas sin ese campo, se aplica el % vigente como antes.
 */
function precioVentaCongelado(
  l: Record<string, string | number | undefined>,
  porcentajeBeneficio: number,
): number {
  const pv = l.PrecioVenta;
  if (pv != null && String(pv).trim() !== '' && Number.isFinite(Number(pv))) return Number(pv);
  return aplicarPorcentajeBeneficio(Number(l.PrecioUnitario ?? 0), porcentajeBeneficio);
}

export default function PedidosScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ crear?: string; vista?: string }>();
  const { localPermitido, hasPermiso } = useAuth();
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [locales, setLocales] = useState<Local[]>([]);
  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [filtroEstado, setFiltroEstado] = useState<string | null>(null);
  const [anioListado, setAnioListado] = useState(anioEnCurso);
  /** Motivo por el que no se puede tocar un pedido ya facturado. */
  const [avisoFacturado, setAvisoFacturado] = useState<string | null>(null);

  const [modalFormVisible, setModalFormVisible] = useState(false);
  const [nuevoPedidoVisible, setNuevoPedidoVisible] = useState(false);
  const [editingPedidoId, setEditingPedidoId] = useState<string | null>(null);
  const [form, setForm] = useState({
    Id: '',
    LocalId: '',
    AlmacenOrigenId: '',
    AlmacenDestinoId: '',
    TotalAlbaran: '',
    Fecha: '',
    Estado: 'Borrador',
    Notas: '',
  });
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);

  const [modalBorrarVisible, setModalBorrarVisible] = useState(false);
  const [pedidoABorrar, setPedidoABorrar] = useState<Pedido | null>(null);
  const [borrando, setBorrando] = useState(false);

  const [pedidoParaLineas, setPedidoParaLineas] = useState<Pedido | null>(null);
  const [lineas, setLineas] = useState<Record<string, string | number>[]>([]);
  const [loadingLineas, setLoadingLineas] = useState(false);
  const [editModeLineas, setEditModeLineas] = useState(false);
  const [lineasEditValues, setLineasEditValues] = useState<Record<string, string>>({});
  const [guardandoCantidades, setGuardandoCantidades] = useState(false);
  const [guardandoPreparada, setGuardandoPreparada] = useState<string | null>(null);
  const [borrandoLinea, setBorrandoLinea] = useState<string | null>(null);
  const [modalLineaFormVisible, setModalLineaFormVisible] = useState(false);
  const [formLinea, setFormLinea] = useState({ ProductId: '', ProductoNombre: '', Cantidad: '', PrecioUnitario: '', Iva: '', TotalRappel: '' });
  const [guardandoLinea, setGuardandoLinea] = useState(false);
  const { productos, productosIgp: productosIgpCache, loading: loadingProductosCache, lastFetch: productosLastFetch, recargar: recargarProductos } = useProductosCache();
  const formatos = useMapaFormatosBase(productos);
  const zonas = useMapaZonas(productos);
  const lineasPorZona = useMemo(() => ordenarLineasPorZona(lineas, zonas), [lineas, zonas]);
  const productosIgp = productosIgpCache as Record<string, string | number | boolean>[];
  const loadingProductos = loadingProductosCache;
  const [porcentajeBeneficio, setPorcentajeBeneficio] = useState(0);
  const [loadingRappelPreview, setLoadingRappelPreview] = useState(false);
  const [rappelPreviewInfo, setRappelPreviewInfo] = useState<{ unitaria: number; sinAcuerdo: boolean } | null>(null);

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    Promise.all([
      apiFetch(urlPedidosPorAnio(anioListado)).then((r) => r.json()),
      apiFetch('/api/locales').then((r) => r.json()),
      apiFetch('/api/almacenes').then((r) => r.json()),
    ])
      .then(([dataPedidos, dataLocales, dataAlmacenes]) => {
        if (dataPedidos.error) setError(dataPedidos.error);
        else setPedidos(dataPedidos.pedidos || []);
        const allLocales: Local[] = dataLocales.locales || [];
        setLocales(allLocales.filter((l) => localPermitido(String((l as Record<string, unknown>).nombre ?? (l as Record<string, unknown>).Nombre ?? '').trim())));
        setAlmacenes(dataAlmacenes.almacenes || []);
      })
      .catch((e) => setError(e.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [localPermitido, anioListado]);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  useEffect(() => {
    fetchPorcentajeBeneficio().then(setPorcentajeBeneficio);
  }, []);

  useEffect(() => {
    if (!modalLineaFormVisible) {
      setRappelPreviewInfo(null);
      return;
    }
    const pedidoId = pedidoParaLineas ? String(valorEnLocal(pedidoParaLineas, 'Id') ?? '').trim() : '';
    const productId = formLinea.ProductId.trim();
    if (!pedidoId || !productId) {
      setRappelPreviewInfo(null);
      setFormLinea((f) => (f.TotalRappel ? { ...f, TotalRappel: '' } : f));
      return;
    }
    const cantidad = formLinea.Cantidad || '0';
    let cancelled = false;
    setLoadingRappelPreview(true);
    apiFetch(
      `/api/pedidos/${encodeURIComponent(pedidoId)}/rappel-preview?productId=${encodeURIComponent(productId)}&cantidad=${encodeURIComponent(cantidad)}`,
    )
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (!data?.ok) {
          setRappelPreviewInfo(null);
          return;
        }
        const unitaria = Number(data.totalAportacionUnitaria ?? 0);
        const total = Number(data.totalRappel ?? 0);
        setRappelPreviewInfo({ unitaria, sinAcuerdo: unitaria <= 0 });
        setFormLinea((f) => ({ ...f, TotalRappel: String(total) }));
      })
      .catch(() => {
        if (!cancelled) setRappelPreviewInfo(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingRappelPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modalLineaFormVisible, pedidoParaLineas, formLinea.ProductId, formLinea.Cantidad]);

  useEffect(() => {
    if (pedidoParaLineas && !productosLastFetch) {
      recargarProductos();
    }
  }, [pedidoParaLineas, productosLastFetch, recargarProductos]);

  const nombresPorLocalId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const loc of locales) {
      const id = String(valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'Id_Locales') ?? valorEnLocal(loc, 'Id') ?? '').trim();
      const nombre = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id) || '—').trim();
      if (id) map[id] = nombre;
    }
    return map;
  }, [locales]);

  /** Locales del desplegable ordenados por nombre (español). */
  const localesOrdenados = useMemo(() => {
    return [...locales].sort((a, b) => {
      const na = String(valorEnLocal(a, 'nombre') ?? valorEnLocal(a, 'Nombre') ?? '').trim();
      const nb = String(valorEnLocal(b, 'nombre') ?? valorEnLocal(b, 'Nombre') ?? '').trim();
      return na.localeCompare(nb, 'es', { sensitivity: 'base' });
    });
  }, [locales]);

  const nombresPorAlmacenId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const alm of almacenes) {
      const id = String(valorEnLocal(alm, 'Id') ?? '').trim();
      const nombre = String((valorEnLocal(alm, 'Nombre') ?? id) || '—').trim();
      if (id) {
        map[id] = nombre;
        const idNum = id.replace(/^0+/, '') || '0';
        if (idNum !== id) map[idNum] = nombre;
      }
    }
    return map;
  }, [almacenes]);

  const almacenesPorLocalId = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const loc of locales) {
      const id = String(valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'Id_Locales') ?? valorEnLocal(loc, 'Id') ?? '').trim();
      const almacenOrig = valorEnLocal(loc, 'almacen origen') ?? valorEnLocal(loc, 'Almacen origen');
      const nombres = parseAlmacenesOrigen(almacenOrig);
      if (id) map[id] = nombres;
    }
    return map;
  }, [locales]);

  const almacenGeneralId = useMemo(() => idAlmacenGeneral(almacenes), [almacenes]);

  /** El maestro está cargado pero ningún almacén se llama «Almacén General». */
  const generalNoIdentificado = almacenes.length > 0 && !almacenGeneralId;

  const totalAlbaranCalculado = useMemo(() => {
    if (editingPedidoId == null) return 0;
    const pedidoIdForm = form.Id.trim();
    const pedidoIdLineas = pedidoParaLineas ? String(valorEnLocal(pedidoParaLineas, 'Id') ?? '').trim() : '';
    if (pedidoIdForm !== pedidoIdLineas || lineas.length === 0) return parseFloat(form.TotalAlbaran) || 0;
    return lineas.reduce((sum, l) => {
      const cant = Number(l.Cantidad ?? 0);
      const precio = precioVentaCongelado(l, porcentajeBeneficio);
      return sum + cant * precio;
    }, 0);
  }, [editingPedidoId, form.Id, form.TotalAlbaran, pedidoParaLineas, lineas, porcentajeBeneficio]);

  const almacenesDestinoParaLocal = useMemo(() => {
    const localId = form.LocalId.trim();
    if (!localId) return [];
    const nombresPermitidos = almacenesPorLocalId[localId] ?? [];
    if (nombresPermitidos.length === 0) return [];
    return almacenes.filter((alm) => {
      const nombre = String(valorEnLocal(alm, 'Nombre') ?? '').trim();
      return nombresPermitidos.some((n) => n === nombre || nombre.toLowerCase().includes(n.toLowerCase()));
    });
  }, [form.LocalId, almacenesPorLocalId, almacenes]);

  /**
   * Cambiar el origen a (o desde) el almacén de otro local cambia quién factura
   * a quién al cerrar el mes, así que solo se ofrece con el permiso del envío
   * entre locales; el resto ve fijo el origen que ya tiene el pedido.
   */
  const puedeEnviarEntreLocales = hasPermiso('pedidos.crear_entre_locales');

  /**
   * Opciones de origen al editar. Con el permiso, todos los almacenes. Sin él,
   * el origen que ya tiene el pedido y el Almacén General: el backend solo
   * rechaza *mover* el origen a un almacén que no sea el central, así que
   * devolver al general un pedido con el origen mal puesto es legítimo y sería
   * un error impedirlo (además de dejar al usuario sin salida).
   */
  const almacenesOrigenEdicion = useMemo(() => {
    if (puedeEnviarEntreLocales) return almacenes;
    const fijo = form.AlmacenOrigenId.trim();
    const permitidos = new Set([fijo, almacenGeneralId].filter(Boolean));
    if (permitidos.size === 0) return almacenes;
    const opciones = almacenes.filter((alm) => permitidos.has(String(valorEnLocal(alm, 'Id') ?? '').trim()));
    // El origen guardado puede no estar en el maestro (almacén borrado o
    // renombrado en Ágora): se pinta igualmente, para no dejar la lista vacía.
    if (fijo && !opciones.some((alm) => String(valorEnLocal(alm, 'Id') ?? '').trim() === fijo)) {
      return [{ Id: fijo, Nombre: `Almacén ${fijo}` } as Almacen, ...opciones];
    }
    return opciones;
  }, [puedeEnviarEntreLocales, almacenes, form.AlmacenOrigenId, almacenGeneralId]);

  /** El origen guardado no aparece en el maestro de almacenes. */
  const origenFueraDeMaestro = useMemo(() => {
    const fijo = form.AlmacenOrigenId.trim();
    if (!fijo || almacenes.length === 0) return false;
    return !almacenes.some((alm) => String(valorEnLocal(alm, 'Id') ?? '').trim() === fijo);
  }, [form.AlmacenOrigenId, almacenes]);

  /** El origen es el almacén central: ni genera factura ni hay nada que advertir. */
  const origenEsGeneral = almacenGeneralId !== '' && form.AlmacenOrigenId.trim() === almacenGeneralId;

  /** Local que sirve la mercancía según el almacén de origen elegido. */
  const localOrigenPedido = useMemo(
    () => localDeAlmacen(form.AlmacenOrigenId, locales, almacenes),
    [form.AlmacenOrigenId, locales, almacenes],
  );

  /**
   * Aviso de facturación cuando el origen no es el Almacén General: ese pedido
   * entra en la facturación mensual de ventas internas entre sociedades.
   */
  const avisoOrigenPedido = useMemo(() => {
    const origenId = form.AlmacenOrigenId.trim();
    if (!origenId || (almacenGeneralId && origenId === almacenGeneralId)) return null;
    return avisoFacturacionSalida({
      localOrigen: localOrigenPedido,
      localDestino: buscarLocalPorId(form.LocalId, locales),
      localOrigenDesconocido: !localOrigenPedido,
    });
  }, [form.AlmacenOrigenId, form.LocalId, almacenGeneralId, localOrigenPedido, locales]);

  // Si el usuario no puede ver completados, se excluyen de TODA la pantalla
  // (también del chip "Todos" y de los conteos), no solo del filtro.
  const puedeVerCompletados = hasPermiso('pedidos.ver_completados');
  const pedidosVisibles = useMemo(
    () =>
      puedeVerCompletados
        ? pedidos
        : pedidos.filter((p) => String(valorEnLocal(p, 'Estado') ?? '') !== 'Completado'),
    [pedidos, puedeVerCompletados],
  );

  // Conteo por estado para los chips (sobre los pedidos visibles según permiso).
  const conteosEstado = useMemo(() => {
    const c: Record<string, number> = { __todos: pedidosVisibles.length };
    for (const p of pedidosVisibles) {
      const e = String(valorEnLocal(p, 'Estado') ?? '').trim();
      if (e) c[e] = (c[e] ?? 0) + 1;
    }
    return c;
  }, [pedidosVisibles]);

  const pedidosFiltrados = useMemo(() => {
    const base = filtroEstado
      ? pedidosVisibles.filter((p) => String(valorEnLocal(p, 'Estado') ?? '') === filtroEstado)
      : pedidosVisibles;
    const q = filtroBusqueda.trim().toLowerCase();
    const filtered = q
      ? base.filter((p) => {
          const partes = COLUMNAS.map((c) => {
            if (c === 'Local') {
              const localId = String(valorEnLocal(p, 'LocalId') ?? '').trim();
              return localId ? (nombresPorLocalId[localId] ?? '') : '';
            }
            if (c === 'AlmacenOrigen') {
              const id = String(valorEnLocal(p, 'AlmacenOrigenId') ?? '').trim();
              return id ? (nombresPorAlmacenId[id] ?? nombresPorAlmacenId[id.replace(/^0+/, '') || '0'] ?? '') : '';
            }
            if (c === 'AlmacenDestino') {
              const id = String(valorEnLocal(p, 'AlmacenDestinoId') ?? '').trim();
              return id ? (nombresPorAlmacenId[id] ?? nombresPorAlmacenId[id.replace(/^0+/, '') || '0'] ?? '') : '';
            }
            return String(valorEnLocal(p, c) ?? '');
          });
          return partes.join(' ').toLowerCase().includes(q);
        })
      : base;
    return [...filtered].sort((a, b) => {
      const ca = String(valorEnLocal(a, 'CreadoEn') ?? '').trim();
      const cb = String(valorEnLocal(b, 'CreadoEn') ?? '').trim();
      return ca.localeCompare(cb);
    });
  }, [pedidosVisibles, filtroEstado, filtroBusqueda, nombresPorLocalId, nombresPorAlmacenId]);

  const getValorCelda = useCallback((item: Pedido, col: string): string => {
    const v = valorEnLocal(item, col);
    if (col === COLUMNA_FACTURACION) return estadoFacturacionPedido(item).texto;
    if (col === 'TotalAlbaran') return formatMoneda(v);
    if (col === 'Fecha') return formatFecha(v);
    if (col === 'CreadoEn') return formatCreadoEn(v);
    if (col === 'Local') {
      const localId = String(valorEnLocal(item, 'LocalId') ?? '').trim();
      return localId ? (nombresPorLocalId[localId] ?? '—') : '—';
    }
    if (col === 'AlmacenOrigen') {
      const id = String(valorEnLocal(item, 'AlmacenOrigenId') ?? '').trim();
      if (!id) return '—';
      const nombre = nombresPorAlmacenId[id] ?? nombresPorAlmacenId[id.replace(/^0+/, '') || '0'];
      return nombre || '—';
    }
    if (col === 'AlmacenDestino') {
      const id = String(valorEnLocal(item, 'AlmacenDestinoId') ?? '').trim();
      if (!id) return '—';
      const nombre = nombresPorAlmacenId[id] ?? nombresPorAlmacenId[id.replace(/^0+/, '') || '0'];
      return nombre || '—';
    }
    if (col === 'Estado') {
      const est = v != null ? String(v) : '—';
      const esDevolucion = String(valorEnLocal(item, 'Tipo') ?? '').trim() === 'Devolucion';
      return esDevolucion ? `Devolución · ${est}` : est;
    }
    return v != null ? String(v) : '—';
  }, [nombresPorLocalId, nombresPorAlmacenId]);

  const idsPedidos = useMemo(
    () => pedidos.map((p) => String(valorEnLocal(p, 'Id') ?? '')),
    [pedidos],
  );

  const proximoId = useMemo(
    () => siguienteIdParaNuevoPedido(form.Fecha, idsPedidos),
    [form.Fecha, idsPedidos],
  );

  useEffect(() => {
    if (!modalFormVisible || editingPedidoId != null) return;
    setForm((f) => (f.Id === proximoId ? f : { ...f, Id: proximoId }));
  }, [proximoId, modalFormVisible, editingPedidoId]);

  // La creación de pedidos se hace con el componente compartido NuevoPedidoModal
  // (mismo flujo que en la vista de almacén): formulario + alta de líneas.
  const abrirModalCrear = () => {
    setNuevoPedidoVisible(true);
  };

  const autoCrearDone = useRef(false);
  const abrirLineasTrasPedido = useRef(false);

  useEffect(() => {
    if (params.crear === '1' && !loading && !autoCrearDone.current) {
      autoCrearDone.current = true;
      setNuevoPedidoVisible(true);
    }
  }, [params.crear, loading]);

  useEffect(() => {
    if (abrirLineasTrasPedido.current && pedidoParaLineas && !loadingLineas) {
      abrirLineasTrasPedido.current = false;
      setModalLineaFormVisible(true);
    }
  }, [pedidoParaLineas, loading, loadingLineas]);

  const abrirModalEditar = (item: Pedido) => {
    const id = valorEnLocal(item, 'Id');
    setEditingPedidoId(id != null ? String(id) : null);
    const fecha = valorEnLocal(item, 'Fecha');
    const fechaIso = itemFechaToFormIso(fecha != null ? String(fecha) : undefined);
    setForm({
      Id: id != null ? String(id) : '',
      LocalId: valorEnLocal(item, 'LocalId') != null ? String(valorEnLocal(item, 'LocalId')) : '',
      AlmacenOrigenId: valorEnLocal(item, 'AlmacenOrigenId') != null ? String(valorEnLocal(item, 'AlmacenOrigenId')) : '',
      AlmacenDestinoId: valorEnLocal(item, 'AlmacenDestinoId') != null ? String(valorEnLocal(item, 'AlmacenDestinoId')) : '',
      TotalAlbaran: valorEnLocal(item, 'TotalAlbaran') != null ? String(valorEnLocal(item, 'TotalAlbaran')) : '0',
      Fecha: fechaIso || fechaHoyIso(),
      Estado: valorEnLocal(item, 'Estado') != null ? String(valorEnLocal(item, 'Estado')) : 'Borrador',
      Notas: valorEnLocal(item, 'Notas') != null ? String(valorEnLocal(item, 'Notas')) : '',
    });
    setErrorForm(null);
    setModalFormVisible(true);
  };

  const cerrarModalForm = () => {
    setModalFormVisible(false);
    setEditingPedidoId(null);
    setErrorForm(null);
  };

  const guardar = async () => {
    const id = form.Id.trim();
    if (!id) {
      setErrorForm('Id es obligatorio');
      return;
    }
    if (!form.LocalId.trim()) {
      setErrorForm('Selecciona un local.');
      return;
    }
    if (!form.AlmacenOrigenId.trim()) {
      setErrorForm('Selecciona un almacén de origen.');
      return;
    }
    if (!form.AlmacenDestinoId.trim()) {
      if (form.LocalId.trim() && almacenesDestinoParaLocal.length === 0) {
        setErrorForm('Este local no tiene almacenes de destino configurados.');
      } else {
        setErrorForm('Selecciona un almacén de destino.');
      }
      return;
    }
    const fechaIso = form.Fecha.trim();
    if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) {
      setErrorForm('Indica una fecha válida (dd/mm/aaaa).');
      return;
    }
    setErrorForm(null);
    setGuardando(true);
    try {
      const body = {
        Id: id,
        LocalId: form.LocalId.trim(),
        AlmacenOrigenId: form.AlmacenOrigenId.trim(),
        AlmacenDestinoId: form.AlmacenDestinoId.trim(),
        TotalAlbaran: totalAlbaranCalculado,
        Fecha: fechaIso,
        Estado: form.Estado || 'Borrador',
        Notas: form.Notas.trim(),
      };
      const res = await apiFetch('/api/pedidos', {
        method: editingPedidoId != null ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al guardar');
        return;
      }
      const esCreacion = editingPedidoId == null;
      cerrarModalForm();

      if (esCreacion) {
        abrirLineasTrasPedido.current = true;
        // El Id definitivo lo asigna el servidor (correlativo atómico); usamos el
        // pedido devuelto para que las líneas se asocien al Id correcto.
        const nuevoPedido = (data.pedido ?? { ...body }) as Pedido;
        setPedidoParaLineas(nuevoPedido);
        setLineas([]);
        setFormLinea({ ProductId: '', ProductoNombre: '', Cantidad: '', PrecioUnitario: '', Iva: '', TotalRappel: '' });
      } else {
        setSelectedRowIndex(null);
      }
      refetch();
    } catch (e) {
      setErrorForm('No se pudo conectar con el servidor');
    } finally {
      setGuardando(false);
    }
  };

  const abrirModalBorrar = (item: Pedido) => {
    setPedidoABorrar(item);
    setModalBorrarVisible(true);
  };

  const cerrarModalBorrar = () => {
    setModalBorrarVisible(false);
    setPedidoABorrar(null);
  };

  const confirmarBorrar = async () => {
    if (!pedidoABorrar) return;
    const id = valorEnLocal(pedidoABorrar, 'Id');
    const idStr = id != null ? String(id) : '';
    if (!idStr) return;
    setBorrando(true);
    try {
      const res = await apiFetch('/api/pedidos', {
        method: 'DELETE',
        body: JSON.stringify({ Id: idStr }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al borrar');
        return;
      }
      const borradoId = idStr.trim();
      if (
        pedidoParaLineas &&
        String(valorEnLocal(pedidoParaLineas, 'Id') ?? '').trim() === borradoId
      ) {
        setPedidoParaLineas(null);
        setLineas([]);
        setEditModeLineas(false);
        setLineasEditValues({});
        setModalLineaFormVisible(false);
        setFormLinea({ ProductId: '', ProductoNombre: '', Cantidad: '', PrecioUnitario: '', Iva: '', TotalRappel: '' });
      }
      refetch();
      setSelectedRowIndex(null);
      cerrarModalBorrar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setBorrando(false);
    }
  };

  const fetchLineas = useCallback(async (pedidoId: string) => {
    setLoadingLineas(true);
    try {
      const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`);
      const data = await res.json();
      setLineas(Array.isArray(data.lineas) ? data.lineas : []);
    } catch {
      setLineas([]);
    } finally {
      setLoadingLineas(false);
    }
  }, []);

  const handleSelectRow = useCallback(
    (index: number | null) => {
      setSelectedRowIndex(index);
      setEditModeLineas(false);
      setLineasEditValues({});
      if (index == null) {
        setPedidoParaLineas(null);
        setLineas([]);
        setModalLineaFormVisible(false);
        setFormLinea({ ProductId: '', ProductoNombre: '', Cantidad: '', PrecioUnitario: '', Iva: '', TotalRappel: '' });
      } else {
        const sel = pedidosFiltrados[index];
        if (sel) {
          setPedidoParaLineas(sel);
          fetchLineas(String(valorEnLocal(sel, 'Id') ?? ''));
        }
      }
    },
    [pedidosFiltrados, fetchLineas]
  );

  // Al cambiar de chip de estado, limpiamos la selección porque el índice de
  // fila apunta al listado filtrado y dejaría de ser válido.
  const cambiarFiltroEstado = useCallback(
    (estado: string | null) => {
      setFiltroEstado((actual) => (actual === estado ? actual : estado));
      handleSelectRow(null);
    },
    [handleSelectRow]
  );

  const entrarModoEditarLineas = useCallback(() => {
    const vals: Record<string, string> = {};
    lineas.forEach((l) => {
      vals[String(l.LineaIndex ?? '')] = String(l.Cantidad ?? '');
    });
    setLineasEditValues(vals);
    setEditModeLineas(true);
  }, [lineas]);

  const cancelarEdicionLineas = useCallback(() => {
    setEditModeLineas(false);
    setLineasEditValues({});
  }, []);

  const guardarCantidadesLineas = useCallback(async () => {
    if (!pedidoParaLineas) return;
    const pedidoId = String(valorEnLocal(pedidoParaLineas, 'Id') ?? '');
    if (!pedidoId) return;
    setGuardandoCantidades(true);
    try {
      const toUpdate = lineas.filter((l) => {
        const key = String(l.LineaIndex ?? '');
        const orig = String(l.Cantidad ?? '');
        const edit = lineasEditValues[key] ?? orig;
        return edit !== orig;
      });
      for (const l of toUpdate) {
        const key = String(l.LineaIndex ?? '');
        const cant = parseFloat(String(lineasEditValues[key] ?? l.Cantidad ?? '0').replace(',', '.')) || 0;
        const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`, {
          method: 'PUT',
          body: JSON.stringify({ LineaIndex: key, Cantidad: cant }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Error al actualizar línea');
      }
      setEditModeLineas(false);
      setLineasEditValues({});
      fetchLineas(pedidoId);
      refetch();
    } catch (e) {
      alert((e as Error).message || 'Error al guardar cantidades');
    } finally {
      setGuardandoCantidades(false);
    }
  }, [pedidoParaLineas, lineas, lineasEditValues, fetchLineas, refetch]);

  const handleAddLinea = useCallback(async () => {
    if (!pedidoParaLineas) return;
    const pedidoId = String(valorEnLocal(pedidoParaLineas, 'Id') ?? '');
    if (!pedidoId) return;
    if (!formLinea.ProductId?.trim()) {
      alert('Selecciona un producto');
      return;
    }
    const cant = parseFloat(String(formLinea.Cantidad).replace(',', '.')) || 0;
    const precio = parseFloat(String(formLinea.PrecioUnitario).replace(',', '.')) || 0;
    const ivaPct = parseFloat(String(formLinea.Iva).replace(',', '.')) || 0;
    const vatRate = ivaPct / 100;
    const totalRappel = parseFloat(String(formLinea.TotalRappel).replace(',', '.')) || 0;
    setGuardandoLinea(true);
    try {
      const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`, {
        method: 'POST',
        body: JSON.stringify({
          ProductId: formLinea.ProductId,
          ProductoNombre: formLinea.ProductoNombre,
          Cantidad: cant,
          PrecioUnitario: precio,
          TotalLinea: cant * precio,
          VatRate: vatRate,
          TotalRappel: totalRappel,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error al crear línea');
      setFormLinea({ ProductId: '', ProductoNombre: '', Cantidad: '', PrecioUnitario: '', Iva: '', TotalRappel: '' });
      fetchLineas(pedidoId);
      refetch();
    } catch (e) {
      alert((e as Error).message || 'Error al añadir línea');
    } finally {
      setGuardandoLinea(false);
    }
  }, [pedidoParaLineas, formLinea, fetchLineas, refetch]);

  const handleDeleteLinea = useCallback(async (lineaIndex: string) => {
    if (!pedidoParaLineas) return;
    const pedidoId = String(valorEnLocal(pedidoParaLineas, 'Id') ?? '');
    if (!pedidoId) return;
    setBorrandoLinea(lineaIndex);
    try {
      const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`, {
        method: 'DELETE',
        body: JSON.stringify({ LineaIndex: lineaIndex }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error al borrar línea');
      fetchLineas(pedidoId);
      refetch();
    } catch (e) {
      alert((e as Error).message || 'Error al borrar línea');
    } finally {
      setBorrandoLinea(null);
    }
  }, [pedidoParaLineas, fetchLineas, refetch]);

  const togglePreparadaLinea = useCallback(async (lineaIndex: string) => {
    if (!pedidoParaLineas) return;
    const pedidoId = String(valorEnLocal(pedidoParaLineas, 'Id') ?? '');
    if (!pedidoId) return;
    const linea = lineas.find((l) => String(l.LineaIndex ?? '') === lineaIndex);
    if (!linea) return;
    const nuevoValor = !linea.Preparada;
    setGuardandoPreparada(lineaIndex);
    try {
      const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`, {
        method: 'PUT',
        body: JSON.stringify({ LineaIndex: lineaIndex, Preparada: nuevoValor }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error al actualizar preparada');
      await fetchLineas(pedidoId);
      const lineasTrasToggle = lineas.map((l) => (String(l.LineaIndex) === lineaIndex ? { ...l, Preparada: nuevoValor } : l));
      const todasPreparadas = lineasTrasToggle.length > 0 && lineasTrasToggle.every((l) => !!l.Preparada);
      const estadoActual = String(valorEnLocal(pedidoParaLineas, 'Estado') ?? '');
      if (todasPreparadas) {
        await apiFetch('/api/pedidos', {
          method: 'PUT',
          body: JSON.stringify({ Id: pedidoId, Estado: 'Completado' }),
        });
        setPedidoParaLineas((p) => (p ? { ...p, Estado: 'Completado' } : null));
        refetch();
      } else if (estadoActual === 'Completado') {
        await apiFetch('/api/pedidos', {
          method: 'PUT',
          body: JSON.stringify({ Id: pedidoId, Estado: 'Pendiente' }),
        });
        setPedidoParaLineas((p) => (p ? { ...p, Estado: 'Pendiente' } : null));
        refetch();
      }
    } catch (e) {
      alert((e as Error).message || 'Error al marcar preparada');
    } finally {
      setGuardandoPreparada(null);
    }
  }, [pedidoParaLineas, lineas, fetchLineas, refetch]);

  const enviarPedido = useCallback(async () => {
    if (!pedidoParaLineas) return;
    const pedidoId = String(valorEnLocal(pedidoParaLineas, 'Id') ?? '');
    if (!pedidoId) return;
    try {
      const res = await apiFetch('/api/pedidos', {
        method: 'PUT',
        body: JSON.stringify({ Id: pedidoId, Estado: 'Enviado' }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error al enviar pedido');
      setPedidoParaLineas((p) => (p ? { ...p, Estado: 'Enviado' } : null));
      refetch();
    } catch (e) {
      alert((e as Error).message || 'Error al enviar pedido');
    }
  }, [pedidoParaLineas, refetch]);

  const estadoPedidoActual = pedidoParaLineas ? String(valorEnLocal(pedidoParaLineas, 'Estado') ?? '') : '';
  const pedidoEnviado = estadoPedidoActual === 'Enviado';
  // Enviar solo saca un borrador hacia almacén. En Completado (y el resto) no
  // debe reaparecer: volver a Enviado borra CompletadoEn.
  const puedeEnviar = estadoPedidoActual === 'Borrador';
  const puedeEditarEnviado = hasPermiso('pedidos.editar_enviado');
  const puedeBorrarEnviado = hasPermiso('pedidos.borrar_enviado');
  /**
   * Un pedido ya facturado tiene el importe congelado: el backend rechaza
   * cualquier escritura sobre sus líneas, así que sus acciones se deshabilitan
   * en vez de dejar que el usuario descubra el 409 al guardar.
   */
  const facturacionPedidoActual = estadoFacturacionPedido(pedidoParaLineas);
  const pedidoActualFacturado = facturacionPedidoActual.estado === 'facturado';
  // En borrador el local sigue armando el pedido. Fuera de borrador, Editar y
  // Añadir línea solo existen con el permiso de almacén. Facturado, nunca.
  const puedeTocarLineas = !pedidoActualFacturado && (estadoPedidoActual === 'Borrador' || puedeEditarEnviado);
  const bloqueadoBorrar = (pedidoEnviado && !puedeBorrarEnviado) || pedidoActualFacturado;

  // Hay un pedido recién creado (Borrador) con líneas que aún no se ha enviado a
  // almacén. Al salir avisamos para ofrecer marcarlo como Enviado.
  const hayBorradorSinEnviar = !!pedidoParaLineas && estadoPedidoActual === 'Borrador' && lineas.length > 0;

  const navigation = useNavigation();
  const permitirSalida = useRef(false);
  // confirmSalida: 'cerrar' (cerrar el detalle a pantalla completa) o 'nav' (back/pop pendiente).
  const [confirmSalida, setConfirmSalida] = useState<{ tipo: 'cerrar' } | { tipo: 'nav'; action: unknown } | null>(null);
  const [enviandoSalida, setEnviandoSalida] = useState(false);

  const cerrarDetalle = useCallback(() => {
    handleSelectRow(null);
  }, [handleSelectRow]);

  const solicitarCerrarDetalle = useCallback(() => {
    if (hayBorradorSinEnviar) {
      setConfirmSalida({ tipo: 'cerrar' });
      return;
    }
    cerrarDetalle();
  }, [hayBorradorSinEnviar, cerrarDetalle]);

  // Intercepta el back/pop del stack mientras haya un borrador sin enviar.
  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e: { preventDefault: () => void; data: { action: unknown } }) => {
      if (permitirSalida.current || !hayBorradorSinEnviar) return;
      e.preventDefault();
      setConfirmSalida({ tipo: 'nav', action: e.data.action });
    });
    return sub;
  }, [navigation, hayBorradorSinEnviar]);

  const resolverSalida = useCallback(async (enviar: boolean) => {
    const accion = confirmSalida;
    if (enviar) {
      setEnviandoSalida(true);
      try {
        await enviarPedido();
      } finally {
        setEnviandoSalida(false);
      }
    }
    setConfirmSalida(null);
    if (!accion) return;
    if (accion.tipo === 'cerrar') {
      cerrarDetalle();
    } else if (accion.tipo === 'nav') {
      permitirSalida.current = true;
      (navigation as unknown as { dispatch: (a: unknown) => void }).dispatch(accion.action);
    }
  }, [confirmSalida, enviarPedido, cerrarDetalle, navigation]);

  const cancelarSalida = useCallback(() => {
    setConfirmSalida(null);
  }, []);

  const handleCrear = () => abrirModalCrear();
  /**
   * El backend rechaza con un 409 cualquier cambio en un pedido ya facturado.
   * Se corta antes de abrir el formulario y se dice por qué: si el usuario
   * rellena el modal y el error salta al guardar, la culpa parece de la app.
   */
  const bloqueoFacturacion = (item: Pedido): boolean => {
    const facturacion = estadoFacturacionPedido(item);
    if (facturacion.estado !== 'facturado') return false;
    setAvisoFacturado(facturacion.detalle);
    return true;
  };
  const handleEditar = (item: Pedido) => {
    const est = String(valorEnLocal(item, 'Estado') ?? '');
    if (est === 'Enviado' && !puedeEditarEnviado) return;
    if (bloqueoFacturacion(item)) return;
    abrirModalEditar(item);
  };
  const handleBorrar = (item: Pedido) => {
    const est = String(valorEnLocal(item, 'Estado') ?? '');
    if (est === 'Enviado' && !puedeBorrarEnviado) return;
    if (bloqueoFacturacion(item)) return;
    abrirModalBorrar(item);
  };

  const { shouldStackPanels, shouldStackToolbar, shouldUseComfortableTable, isDesktop } = useBreakpoint();
  const insets = useSafeAreaInsets();
  const vistaParam = Array.isArray(params.vista) ? params.vista[0] : params.vista;
  const moduloTarjetas = vistaParam === 'tarjetas';

  const volverAtras = useCallback(() => router.back(), [router]);
  const getColumnCellStyleTabla = useCallback(
    (col: string) => col === 'TotalAlbaran' ? { text: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight } } : undefined,
    [],
  );
  const renderCellTabla = useCallback(
    (item: Pedido, col: string) =>
      col === COLUMNA_FACTURACION ? (
        <CeldaFacturacionPedido pedido={item} comodo={shouldUseComfortableTable} />
      ) : null,
    [shouldUseComfortableTable],
  );
  const getRowStyleTabla = useCallback(
    (item: Pedido) => String(valorEnLocal(item, 'Estado') ?? '') === 'Completado' ? { backgroundColor: statusColors.success.bg } : undefined,
    [],
  );
  const getRowKeyTabla = useCallback(
    (p: Pedido, idx: number) => String(valorEnLocal(p, 'Id') ?? '') || `sin-id-${idx}`,
    [],
  );
  // Tabla de líneas estirada cuando hay espacio horizontal (tablet/escritorio horizontal).
  const isWide = !shouldStackPanels && !moduloTarjetas;
  const hacerPedidoEscritorio = moduloTarjetas && isDesktop;
  // Hacer pedido en escritorio abre el detalle al lado. En móvil y tablet, a pantalla completa.
  const detalleComoModal = moduloTarjetas ? !isDesktop : shouldStackPanels;

  const renderLineasTable = (stretchWide: boolean) => (
    <View style={[styles.lineasTable, stretchWide && styles.lineasTableWide]}>
      <View style={styles.lineasTableHeader}>
        <View style={styles.lineasColPreparada}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'center' }]}>✓</Text></View>
        <View style={styles.lineasColCantidad}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'center' }]}>Cantidad</Text></View>
        <View style={styles.lineasColArticulo}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'center' }]}>Artículo</Text></View>
        <View style={styles.lineasColPrecio}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'right' }]}>Precio</Text></View>
        <View style={styles.lineasColIva}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'right' }]}>IVA</Text></View>
        <View style={styles.lineasColTotalRappel}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, styles.lineasHeaderTwoLines, { textAlign: 'right' }]}>Total{'\n'}Rappel</Text></View>
        <View style={styles.lineasColTotal}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'right' }]}>Total</Text></View>
        <View style={styles.lineasColId}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'center' }]}>ID</Text></View>
        <View style={styles.lineasColDelete}><Text style={styles.lineasTableCell}>{' '}</Text></View>
      </View>
      {lineas.length === 0 ? (
        <View style={styles.lineasTableEmpty}>
          <Text style={styles.lineasEmpty}>No hay líneas</Text>
        </View>
      ) : (
        lineasPorZona.map((l, idx) => {
          const key = String(l.LineaIndex ?? idx);
          const cantEdit = lineasEditValues[key] ?? String(l.Cantidad ?? '');
          const cant = editModeLineas ? (parseFloat(String(cantEdit).replace(',', '.')) || 0) : Number(l.Cantidad ?? 0);
          const precio = precioVentaCongelado(l, porcentajeBeneficio);
          const total = cant * precio;
          const totalRappel = Number(l.TotalRappel ?? 0);
          const iva = l.VatRate != null ? `${Number(l.VatRate) * 100}%` : '—';
          const preparada = !!l.Preparada;
          return (
            <View key={key} style={styles.lineasTableRow}>
              <View style={styles.lineasColPreparada}>
                <TouchableOpacity
                  onPress={() => togglePreparadaLinea(key)}
                  disabled={guardandoPreparada !== null || pedidoActualFacturado}
                  style={[styles.lineasCheckBtn, preparada && styles.lineasCheckBtnActive]}
                >
                  {guardandoPreparada === key ? (
                    <ActivityIndicator size="small" color={preparada ? colors.surface : colors.accent} />
                  ) : (
                    <MaterialIcons
                      name={preparada ? 'check-circle' : 'check-circle-outline'}
                      size={22}
                      color={pedidoActualFacturado ? '#d1d5db' : preparada ? colors.success : colors.textMuted}
                    />
                  )}
                </TouchableOpacity>
              </View>
              <View style={styles.lineasColCantidad}>
                {editModeLineas ? (
                  <TextInput
                    style={[styles.lineasTableCell, styles.lineasCellCantidad, styles.lineasEditInput]}
                    value={cantEdit}
                    onChangeText={(v) => setLineasEditValues((prev) => ({ ...prev, [key]: v }))}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor={colors.textMuted}
                  />
                ) : (
                  <Text style={[styles.lineasTableCell, styles.lineasCellCantidad]}>{String(cant)}</Text>
                )}
              </View>
              <View style={[styles.lineasColArticulo, preparada && styles.lineasColArticuloPreparada]} {...(Platform.OS === 'web' ? { title: String(l.ProductoNombre || l.ProductId || '—') } : {})}>
                <View style={styles.lineasArticulo}>
                  <EtiquetaZona zona={zonas.get(String(l.ProductId ?? '').trim())} size={26} />
                  <Text style={[styles.lineasTableCell, preparada && styles.lineasCellArticuloPreparada, styles.lineasArticuloNombre]} numberOfLines={1}>{String(l.ProductoNombre || l.ProductId || '—')}</Text>
                  <BadgeFormato nombre={formatos.get(String(l.ProductId ?? '').trim())} />
                </View>
              </View>
              <View style={styles.lineasColPrecio}><Text style={[styles.lineasTableCell, { textAlign: 'right' }]}>{formatMoneda(precio)}</Text></View>
              <View style={styles.lineasColIva}><Text style={[styles.lineasTableCell, { textAlign: 'right' }]}>{iva}</Text></View>
              <View style={styles.lineasColTotalRappel}><Text style={[styles.lineasTableCell, { textAlign: 'right' }, totalRappel > 0 && styles.lineasCellRappelAbono]}>{totalRappel > 0 ? `-${formatMoneda(totalRappel)}` : formatMoneda(0)}</Text></View>
              <View style={styles.lineasColTotal}><Text style={[styles.lineasTableCell, styles.lineasCellTotal]}>{formatMoneda(total)}</Text></View>
              <View style={styles.lineasColId}>
                <View style={styles.lineasCellIdBadge}>
                  <Text style={styles.lineasCellIdText} numberOfLines={1}>{String(l.ProductId ?? '—')}</Text>
                </View>
              </View>
              <View style={styles.lineasColDelete}>
                <TouchableOpacity
                  onPress={() => handleDeleteLinea(key)}
                  disabled={borrandoLinea !== null || bloqueadoBorrar}
                  style={styles.lineasDeleteBtn}
                >
                  {borrandoLinea === key ? (
                    <ActivityIndicator size="small" color={colors.danger} />
                  ) : (
                    <MaterialIcons name="delete-outline" size={18} color={bloqueadoBorrar ? '#d1d5db' : colors.danger} />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          );
        })
      )}
    </View>
  );

  // Chips de estado con conteo. "Completado" solo se muestra con permiso y se
  // resalta en verde (coherente con el resaltado de fila de la tabla).
  const chipsEstadoDef: { key: string | null; label: string; count: number; completado?: boolean }[] = [
    { key: null, label: 'Todos', count: conteosEstado.__todos ?? 0 },
    ...ESTADOS.filter((e) => e !== 'Completado').map((e) => ({
      key: e,
      label: e,
      count: conteosEstado[e] ?? 0,
    })),
    ...(puedeVerCompletados
      ? [{ key: 'Completado', label: 'Completado', count: conteosEstado.Completado ?? 0, completado: true }]
      : []),
  ];

  const pedidosRecientes = useMemo(
    () => [...pedidosFiltrados].map((p, index) => ({ p, index })).reverse(),
    [pedidosFiltrados],
  );
  const gruposHacerPedido = useMemo(() => {
    const ahora = new Date();
    const hoy = fechaIsoLocal(ahora);
    const lunes = lunesDeSemanaIso(ahora);
    const hoyItems: typeof pedidosRecientes = [];
    const semanaItems: typeof pedidosRecientes = [];
    const anteriores: typeof pedidosRecientes = [];
    for (const item of pedidosRecientes) {
      const fecha = fechaPedidoIso(item.p);
      if (fecha === hoy) hoyItems.push(item);
      else if (fecha > hoy || (fecha !== '' && fecha >= lunes && fecha < hoy)) semanaItems.push(item);
      else anteriores.push(item);
    }
    return [
      { titulo: 'Hoy', items: hoyItems },
      { titulo: 'Esta semana', items: semanaItems },
      { titulo: 'Anteriores', items: anteriores },
    ].filter((grupo) => grupo.items.length > 0);
  }, [pedidosRecientes]);

  const nombreAlmacen = useCallback((idRaw: string | number | undefined) => {
    const id = String(idRaw ?? '').trim();
    if (!id) return '—';
    return nombresPorAlmacenId[id] ?? nombresPorAlmacenId[id.replace(/^0+/, '') || '0'] ?? id;
  }, [nombresPorAlmacenId]);

  const pintarChipEstado = (
    c: { key: string | null; label: string; count: number; completado?: boolean },
    coloreados: boolean,
  ) => {
    const activo = filtroEstado === c.key;
    const tono = c.key ? COLOR_ESTADO[c.key] : undefined;
    const conColor = coloreados && !!tono;
    return (
      <TouchableOpacity
        key={c.key ?? '__todos'}
        style={[
          styles.chipEstado,
          !conColor && c.completado && styles.chipEstadoCompletado,
          !conColor && activo && (c.completado ? styles.chipEstadoCompletadoActivo : styles.chipEstadoActivo),
          conColor && tono && {
            backgroundColor: activo ? tono.franja : tono.fondo,
            borderColor: tono.franja,
          },
        ]}
        onPress={() => cambiarFiltroEstado(c.key)}
        activeOpacity={0.7}
      >
        <Text
          style={[
            styles.chipEstadoText,
            !conColor && c.completado && styles.chipEstadoTextCompletado,
            !conColor && activo && styles.chipEstadoTextActivo,
            conColor && tono && { color: activo ? '#ffffff' : tono.texto },
          ]}
        >
          {c.label}
        </Text>
        <View style={[
          styles.chipEstadoBadge,
          activo && styles.chipEstadoBadgeActivo,
          conColor && !activo && tono && { backgroundColor: tono.franja },
        ]}>
          <Text style={[
            styles.chipEstadoBadgeText,
            (activo || (conColor && !activo)) && styles.chipEstadoBadgeTextActivo,
          ]}>
            {c.count}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const chipsEstado = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chipsEstadoScroll}
      contentContainerStyle={styles.chipsEstadoRow}
    >
      {chipsEstadoDef.map((c) => pintarChipEstado(c, false))}
    </ScrollView>
  );

  const pintarTarjetaPedido = (p: Pedido, index: number) => {
    const id = String(valorEnLocal(p, 'Id') ?? '');
    const localId = String(valorEnLocal(p, 'LocalId') ?? '').trim();
    const local = localId ? (nombresPorLocalId[localId] ?? '—') : '—';
    const estado = String(valorEnLocal(p, 'Estado') ?? '');
    const tono = COLOR_ESTADO[estado] ?? COLOR_ESTADO.Borrador;
    const numLineas = Number(valorEnLocal(p, 'LineasTotal'));
    const textoLineas = Number.isFinite(numLineas)
      ? `${numLineas} ${numLineas === 1 ? 'línea' : 'líneas'}`
      : '—';
    const seleccionada = selectedRowIndex === index;
    return (
      <TouchableOpacity
        key={id || `sin-id-${index}`}
        style={[
          styles.cardPedido,
          styles.cardPedidoFranja,
          seleccionada && styles.cardPedidoSel,
          { borderLeftColor: tono.franja },
        ]}
        onPress={() => handleSelectRow(index)}
        activeOpacity={0.7}
      >
        <View style={styles.cardPedidoTop}>
          <Text style={styles.cardPedidoId} numberOfLines={1}>{id || '—'}</Text>
          <View style={[styles.cardEstadoChip, { backgroundColor: tono.fondo }]}>
            <Text style={[styles.cardEstadoChipText, { color: tono.texto }]}>{estado || '—'}</Text>
          </View>
        </View>
        <Text style={styles.cardPedidoLocal} numberOfLines={1}>{local}</Text>
        <Text style={styles.cardPedidoRuta} numberOfLines={1}>
          {nombreAlmacen(valorEnLocal(p, 'AlmacenOrigenId'))} → {nombreAlmacen(valorEnLocal(p, 'AlmacenDestinoId'))}
        </Text>
        <Text style={styles.cardPedidoLineas}>{textoLineas}</Text>
        <View style={styles.cardPedidoPie}>
          <Text style={styles.cardPedidoFecha}>{formatFecha(valorEnLocal(p, 'Fecha'))}</Text>
          <Text style={styles.cardPedidoTotal}>{formatMoneda(valorEnLocal(p, 'TotalAlbaran'))}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <View style={[styles.mainRow, !isWide && !hacerPedidoEscritorio && styles.mainRowColumn]}>
        <View style={styles.pedidosSection}>
          {/* Encima de la tabla: si va debajo, con una lista larga el usuario
              pulsa «Editar», no pasa nada y el motivo queda fuera de pantalla. */}
          {avisoFacturado ? (
            <View style={[styles.avisoFacturadoBox, styles.avisoFacturadoBoxTop]}>
              <MaterialIcons name="lock-outline" size={16} color={statusColors.warning.text} />
              <Text style={styles.avisoFacturadoText}>{avisoFacturado}</Text>
              <TouchableOpacity
                onPress={() => setAvisoFacturado(null)}
                style={styles.avisoFacturadoCerrar}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityLabel="Cerrar aviso"
              >
                <MaterialIcons name="close" size={16} color={statusColors.warning.text} />
              </TouchableOpacity>
            </View>
          ) : null}
          {shouldStackToolbar && !(moduloTarjetas || shouldStackPanels) ? (
            <View style={styles.anioApilado}>
              <SelectorAnioListado
                label="Año"
                estirar
                valorId={anioListado}
                onChange={setAnioListado}
              />
            </View>
          ) : null}
          {moduloTarjetas ? (
            <View style={[styles.listaMovil, styles.fondoPantalla]}>
              <View style={styles.listaMovilHeader}>
                <TouchableOpacity onPress={volverAtras} style={styles.listaMovilBack} accessibilityLabel="Volver">
                  <MaterialIcons name="arrow-back" size={22} color="#334155" />
                </TouchableOpacity>
                <View style={styles.listaMovilTituloWrap}>
                  <Text style={styles.listaMovilTitulo}>Hacer pedido</Text>
                  <Text style={styles.listaMovilSub}>Crear un pedido y enviarlo al almacén</Text>
                </View>
                {hacerPedidoEscritorio ? (
                  <BotonPrincipal titulo="Nuevo pedido" onPress={handleCrear} />
                ) : null}
                <TouchableOpacity onPress={refetch} style={styles.listaMovilBack} accessibilityLabel="Recargar">
                  <MaterialIcons name="refresh" size={22} color="#0ea5e9" />
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.listaMovilBuscar}
                value={filtroBusqueda}
                onChangeText={setFiltroBusqueda}
                placeholder="Buscar pedido, local o estado"
                placeholderTextColor="#94a3b8"
              />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.chipsEstadoScroll}
                contentContainerStyle={styles.chipsEstadoRow}
              >
                <SelectorAnioListado
                  valorId={anioListado}
                  onChange={setAnioListado}
                  style={styles.anioEnFila}
                />
                {chipsEstadoDef.map((c) => pintarChipEstado(c, true))}
              </ScrollView>
              {loading ? (
                <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: SPACING.xl }} />
              ) : error ? (
                <View style={styles.listaMovilCentro}>
                  <Text style={styles.listaMovilVacio}>{error}</Text>
                  <TouchableOpacity onPress={refetch} style={styles.listaMovilReintentar}>
                    <Text style={styles.listaMovilReintentarText}>Reintentar</Text>
                  </TouchableOpacity>
                </View>
              ) : pedidosRecientes.length === 0 ? (
                <Text style={styles.listaMovilVacio}>
                  {filtroBusqueda.trim() || filtroEstado ? 'Ningún pedido coincide con el filtro' : 'No hay pedidos'}
                </Text>
              ) : (
                <ScrollView
                  contentContainerStyle={[
                    styles.listaMovilScroll,
                    !hacerPedidoEscritorio && styles.listaMovilScrollFab,
                  ]}
                  keyboardShouldPersistTaps="handled"
                >
                  {hacerPedidoEscritorio
                    ? pedidosRecientes.map(({ p, index }) => pintarTarjetaPedido(p, index))
                    : gruposHacerPedido.map((grupo) => (
                      <View key={grupo.titulo} style={styles.grupoPedidos}>
                        <Text style={styles.grupoPedidosTitulo}>{grupo.titulo}</Text>
                        {grupo.items.map(({ p, index }) => pintarTarjetaPedido(p, index))}
                      </View>
                    ))}
                </ScrollView>
              )}
              {hacerPedidoEscritorio ? null : (
                <View style={[styles.fabWrap, { bottom: Math.max(insets.bottom, SPACING.lg) }]} pointerEvents="box-none">
                  <BotonPrincipal variante="flotante" titulo="Nuevo pedido" onPress={handleCrear} />
                </View>
              )}
            </View>
          ) : shouldStackPanels ? (
            <View style={styles.listaMovil}>
              <View style={styles.listaMovilHeader}>
                <TouchableOpacity onPress={volverAtras} style={styles.listaMovilBack} accessibilityLabel="Volver">
                  <MaterialIcons name="arrow-back" size={22} color="#334155" />
                </TouchableOpacity>
                <View style={{ flex: 1 }}>
                  <Text style={styles.listaMovilTitulo}>{moduloTarjetas ? 'Hacer pedido' : 'Pedidos'}</Text>
                  <Text style={styles.listaMovilSub}>Crear un pedido y enviarlo al almacén</Text>
                </View>
                <TouchableOpacity onPress={refetch} style={styles.listaMovilBack} accessibilityLabel="Recargar">
                  <MaterialIcons name="refresh" size={22} color="#0ea5e9" />
                </TouchableOpacity>
              </View>
              <TouchableOpacity style={styles.listaMovilNuevo} onPress={handleCrear} activeOpacity={0.8}>
                <MaterialIcons name="add" size={20} color="#0f172a" />
                <Text style={styles.listaMovilNuevoText}>Nuevo pedido</Text>
              </TouchableOpacity>
              <SelectorAnioListado label="Año" estirar valorId={anioListado} onChange={setAnioListado} />
              <View style={styles.chipsEstadoEnLista}>{chipsEstado}</View>
              <TextInput
                style={styles.listaMovilBuscar}
                value={filtroBusqueda}
                onChangeText={setFiltroBusqueda}
                placeholder="Buscar pedido, local o estado"
                placeholderTextColor="#94a3b8"
              />
              {loading ? (
                <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 24 }} />
              ) : error ? (
                <View style={styles.listaMovilCentro}>
                  <Text style={styles.listaMovilVacio}>{error}</Text>
                  <TouchableOpacity onPress={refetch} style={styles.listaMovilReintentar}>
                    <Text style={styles.listaMovilReintentarText}>Reintentar</Text>
                  </TouchableOpacity>
                </View>
              ) : pedidosFiltrados.length === 0 ? (
                <Text style={styles.listaMovilVacio}>
                  {filtroBusqueda.trim() ? 'Ningún pedido coincide con el filtro' : 'No hay pedidos'}
                </Text>
              ) : (
                <ScrollView contentContainerStyle={styles.listaMovilScroll} keyboardShouldPersistTaps="handled">
                  {[...pedidosFiltrados].map((p, index) => ({ p, index })).reverse().map(({ p, index }) => {
                    const id = String(valorEnLocal(p, 'Id') ?? '');
                    const localId = String(valorEnLocal(p, 'LocalId') ?? '').trim();
                    const local = localId ? (nombresPorLocalId[localId] ?? '—') : '—';
                    const estado = String(valorEnLocal(p, 'Estado') ?? '');
                    return (
                      <TouchableOpacity
                        key={id || `sin-id-${index}`}
                        style={styles.cardPedido}
                        onPress={() => handleSelectRow(index)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.cardPedidoTop}>
                          <Text style={styles.cardPedidoId} numberOfLines={1}>{id}</Text>
                          <Text style={styles.cardPedidoEstado}>{estado || '—'}</Text>
                        </View>
                        <Text style={styles.cardPedidoLocal} numberOfLines={1}>{local}</Text>
                        <Text style={styles.cardPedidoFecha} numberOfLines={1}>
                          {formatFecha(valorEnLocal(p, 'Fecha'))} · {formatMoneda(valorEnLocal(p, 'TotalAlbaran'))}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}
            </View>
          ) : (
          <TablaBasica<Pedido>
            extraToolbarLeft={chipsEstado}
            extraToolbarRight={
              shouldStackToolbar ? undefined : (
                <SelectorAnioListado valorId={anioListado} onChange={setAnioListado} />
              )
            }
            title="Pedidos"
            onBack={volverAtras}
            columnas={COLUMNAS_TABLA}
            defaultColWidth={76}
            datos={pedidosFiltrados}
            virtualizada
            getRowKey={getRowKeyTabla}
            getValorCelda={getValorCelda}
            loading={loading}
            error={error}
            onRetry={refetch}
            filtroBusqueda={filtroBusqueda}
            onFiltroChange={setFiltroBusqueda}
            selectedRowIndex={selectedRowIndex}
            onSelectRow={handleSelectRow}
            onCrear={handleCrear}
            onEditar={handleEditar}
            onBorrar={handleBorrar}
            columnasMoneda={COLUMNAS_MONEDA}
            getColumnCellStyle={getColumnCellStyleTabla}
            renderCell={renderCellTabla}
            getRowStyle={getRowStyleTabla}
            emptyMessage="No hay pedidos"
            emptyFilterMessage="Ningún pedido coincide con el filtro"
          />
          )}
        </View>
        {(() => {
          const contenidoDetalle = (
          <View style={[styles.lineasSection, !isWide && !hacerPedidoEscritorio && styles.lineasSectionColumn, hacerPedidoEscritorio && styles.lineasSectionHacer]}>
          <View style={styles.lineasPanelHeader}>
            <Text style={styles.lineasPanelTitle} numberOfLines={1} ellipsizeMode="tail">
              Detalle del pedido
              {pedidoParaLineas ? (() => {
                const id = String(valorEnLocal(pedidoParaLineas, 'Id') ?? '');
                const localId = String(valorEnLocal(pedidoParaLineas, 'LocalId') ?? '').trim();
                const nombreLocal = localId ? (nombresPorLocalId[localId] ?? '') : '';
                return ` — ${id}${nombreLocal ? ` — ${nombreLocal}` : ''}`;
              })() : ''}
            </Text>
            {pedidoParaLineas && (
              <Text style={styles.lineasPanelTotal}>
                {formatMoneda(valorEnLocal(pedidoParaLineas, 'TotalAlbaran'))}
              </Text>
            )}
          </View>
          {pedidoActualFacturado ? (
            <View style={styles.avisoFacturadoBox}>
              <MaterialIcons name="lock-outline" size={16} color={statusColors.warning.text} />
              <Text style={styles.avisoFacturadoText}>{facturacionPedidoActual.detalle}</Text>
            </View>
          ) : null}
          {!pedidoParaLineas ? (
            <Text style={styles.lineasEmptyHint}>Selecciona un pedido para ver sus líneas</Text>
          ) : loadingLineas ? (
            <ActivityIndicator size="small" color={colors.accent} style={{ marginVertical: SPACING.xl }} />
          ) : (
            <>
            <View style={styles.lineasEditBar}>
              {!editModeLineas ? (
                <>
                  {puedeTocarLineas ? (
                    <TouchableOpacity style={styles.lineasEditarBtn} onPress={entrarModoEditarLineas} disabled={loadingLineas || lineas.length === 0}>
                      <MaterialIcons name="edit" size={14} color={colors.accent} />
                      <Text style={styles.lineasEditarBtnText}>Editar</Text>
                    </TouchableOpacity>
                  ) : null}
                  {puedeTocarLineas ? (
                    <TouchableOpacity style={styles.lineasAddBtn} onPress={() => setModalLineaFormVisible(true)} disabled={loadingLineas || modalLineaFormVisible}>
                      <MaterialIcons name="add" size={14} color={modalLineaFormVisible ? colors.textMuted : colors.success} />
                      <Text style={[styles.lineasAddBtnText, modalLineaFormVisible && { color: colors.textMuted }]}>Añadir línea</Text>
                    </TouchableOpacity>
                  ) : null}
                  {puedeEnviar && isWide ? (
                    <TouchableOpacity style={styles.enviarPedidoBtn} onPress={enviarPedido}>
                      <MaterialIcons name="send" size={14} color="#9a3412" />
                      <Text style={styles.enviarPedidoBtnText}>Enviar pedido</Text>
                    </TouchableOpacity>
                  ) : null}
                </>
              ) : (
                <View style={styles.lineasEditActions}>
                  <TouchableOpacity style={styles.lineasGuardarBtn} onPress={guardarCantidadesLineas} disabled={guardandoCantidades}>
                    {guardandoCantidades ? <ActivityIndicator size="small" color={colors.surface} /> : <MaterialIcons name="check" size={14} color={colors.surface} />}
                    <Text style={styles.lineasGuardarBtnText}>{guardandoCantidades ? 'Guardando...' : 'Guardar'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.lineasCancelarBtn} onPress={cancelarEdicionLineas} disabled={guardandoCantidades}>
                    <MaterialIcons name="close" size={14} color={colors.textMuted} />
                    <Text style={styles.lineasCancelarBtnText}>Cancelar</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
            <ScrollView style={[styles.lineasList, detalleComoModal && styles.lineasListFull]} showsVerticalScrollIndicator>
              {isWide ? (
                renderLineasTable(true)
              ) : lineas.length === 0 ? (
                <Text style={styles.lineasEmpty}>No hay líneas</Text>
              ) : (
                lineasPorZona.map((l, idx) => {
                  const key = String(l.LineaIndex ?? idx);
                  const nombre = String(l.ProductoNombre || l.ProductId || '—');
                  const cantTexto = lineasEditValues[key] ?? String(l.Cantidad ?? '');
                  return (
                    <View key={key} style={styles.lineaMovil}>
                      {editModeLineas ? (
                        <InputCantidad
                          value={cantTexto}
                          onChangeText={(v) => setLineasEditValues((prev) => ({ ...prev, [key]: v }))}
                          compacto
                          sinPasos
                          style={styles.lineaMovilCantidadInput}
                        />
                      ) : (
                        <Text style={styles.lineaMovilCantidad}>{String(l.Cantidad ?? 0)}</Text>
                      )}
                      <Text style={styles.lineaMovilNombre} numberOfLines={2}>{nombre}</Text>
                    </View>
                  );
                })
              )}
            </ScrollView>
            {!isWide && pedidoParaLineas && puedeEnviar && !editModeLineas ? (
              <TouchableOpacity style={styles.enviarFijo} onPress={enviarPedido} activeOpacity={0.8}>
                <MaterialIcons name="send" size={18} color="#fff" />
                <Text style={styles.enviarFijoText}>Enviar pedido</Text>
              </TouchableOpacity>
            ) : null}
            </>
          )}
          {pedidoParaLineas && modalLineaFormVisible && (
            <View style={styles.lineaForm}>
              <View style={styles.lineaFormProductoRow}>
                <View style={[styles.formGroup, styles.formGroupProductoLinea]}>
                  <Text style={[styles.formLabel, styles.lineaFormLabelLinea]}>Producto</Text>
                  <SelectorDesplegable
                    placeholder="Buscar producto…"
                    icono="inventory-2"
                    tituloLista="Selecciona un producto"
                    iconoLista="inventory-2"
                    loading={loadingProductos}
                    buscador
                    buscadorPlaceholder="Buscar producto…"
                    valorId={formLinea.ProductId || null}
                    opciones={productosIgp.map((prod, idx) => {
                      const idProd = String(valorEnLocal(prod as Pedido, 'Id') ?? '').trim();
                      const nombre = String((valorEnLocal(prod as Pedido, 'Name') ?? valorEnLocal(prod as Pedido, 'Nombre') ?? idProd) || '—').trim();
                      return {
                        id: idProd || `p-${idx}`,
                        titulo: nombre || idProd || '—',
                        subtitulo: idProd ? `ID ${idProd}` : undefined,
                        icono: 'inventory-2' as const,
                      };
                    })}
                    onSeleccionar={(id) => {
                      const prod = productosIgp.find((p) => String(valorEnLocal(p as Pedido, 'Id') ?? '').trim() === id);
                      if (!prod) return;
                      const nombre = String((valorEnLocal(prod as Pedido, 'Name') ?? valorEnLocal(prod as Pedido, 'Nombre') ?? id) || '—').trim();
                      const costPrice = valorEnLocal(prod as Pedido, 'CostPrice');
                      const precioStr = costPrice != null ? String(costPrice) : '';
                      const purchaseVat = valorEnLocal(prod as Pedido, 'ultimo_iva_compra');
                      const fallbackVat = valorEnLocal(prod as Pedido, 'VatPercent');
                      const ivaStr = purchaseVat != null ? String(purchaseVat) : (fallbackVat != null ? String(fallbackVat) : '');
                      setFormLinea((f) => ({
                        ...f,
                        ProductId: id,
                        ProductoNombre: nombre,
                        PrecioUnitario: precioStr,
                        Iva: ivaStr,
                      }));
                    }}
                  />
                </View>
                <View style={styles.formGroupCantidadLinea}>
                  <Text style={[styles.formLabel, styles.lineaFormLabelLinea]}>Cantidad</Text>
                  <InputCantidad
                    value={formLinea.Cantidad}
                    onChangeText={(v) => setFormLinea((f) => ({ ...f, Cantidad: v }))}
                    placeholder="0"
                    style={styles.lineaFormCantidadMatch}
                  />
                </View>
              </View>
              <View style={styles.lineaFormValoresRow}>
                <View style={[styles.formGroup, styles.formGroupFlex]}>
                  <Text style={styles.formLabel}>Precio unitario</Text>
                  <TextInput
                    style={[styles.formInput, styles.formInputPrecioReadonly, styles.formInputCompact]}
                    value={
                      formLinea.PrecioUnitario
                        ? formatMoneda(aplicarPorcentajeBeneficio(Number(formLinea.PrecioUnitario), porcentajeBeneficio))
                        : ''
                    }
                    editable={false}
                    placeholder="Selecciona producto"
                    placeholderTextColor={colors.textMuted}
                  />
                </View>
                <View style={[styles.formGroup, styles.formGroupFlex]}>
                  <Text style={styles.formLabel}>IVA %</Text>
                  <TextInput
                    style={[styles.formInput, styles.formInputPrecioReadonly, styles.formInputCompact]}
                    value={formLinea.Iva ? `${formLinea.Iva} %` : ''}
                    editable={false}
                    placeholder="Selecciona producto"
                    placeholderTextColor={colors.textMuted}
                  />
                </View>
                <View style={[styles.formGroup, styles.formGroupFlex]}>
                  <Text style={styles.formLabel}>Total Rappel</Text>
                  <TextInput
                    style={[styles.formInput, styles.formInputPrecioReadonly, styles.formInputCompact]}
                    value={
                      loadingRappelPreview
                        ? '…'
                        : Number(formLinea.TotalRappel) > 0
                          ? `-${formatMoneda(Number(formLinea.TotalRappel))}`
                          : formLinea.ProductId
                            ? formatMoneda(0)
                            : ''
                    }
                    editable={false}
                    placeholder="Según acuerdo activo"
                    placeholderTextColor={colors.textMuted}
                  />
                </View>
              </View>
              {formLinea.ProductId && !loadingRappelPreview && rappelPreviewInfo?.sinAcuerdo ? (
                <Text style={styles.rappelHintWarn}>
                  Sin acuerdo activo para este producto en la fecha del pedido
                </Text>
              ) : null}
              {formLinea.ProductId && !loadingRappelPreview && rappelPreviewInfo && rappelPreviewInfo.unitaria > 0 ? (
                <Text style={styles.rappelHintOk}>
                  Abono -{formatMoneda(rappelPreviewInfo.unitaria)}/ud (aportación + rappel + dto.)
                </Text>
              ) : null}
              <View style={styles.lineaFormBtns}>
                <TouchableOpacity style={styles.modalBtn} onPress={handleAddLinea} disabled={guardandoLinea || !formLinea.ProductId?.trim()}>
                  {guardandoLinea ? (
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <MaterialIcons name="save" size={20} color={colors.accent} />
                  )}
                  <Text style={styles.modalBtnText}>Guardar</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          </View>
          );
          return detalleComoModal && pedidoParaLineas ? (
            <View style={[styles.detallePantalla, moduloTarjetas && styles.fondoPantalla]}>
              <View style={styles.detalleFullscreenBar}>
                <TouchableOpacity onPress={solicitarCerrarDetalle} style={styles.detalleVolverBtn} activeOpacity={0.7}>
                  <MaterialIcons name="arrow-back" size={20} color="#334155" />
                  <Text style={styles.detalleVolverText}>Volver a pedidos</Text>
                </TouchableOpacity>
              </View>
              {contenidoDetalle}
            </View>
          ) : detalleComoModal ? null : (
            contenidoDetalle
          );
          })()}
      </View>

      <Modal visible={modalFormVisible} transparent animationType="fade" onRequestClose={cerrarModalForm}>
        {/* El fondo no cierra el formulario (evita perder datos); usar la X o Cancelar. */}
        <Pressable style={styles.modalOverlay}>
          <KeyboardAvoidingView style={styles.modalWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{editingPedidoId ? 'Editar pedido' : 'Nuevo pedido'}</Text>
                <TouchableOpacity onPress={cerrarModalForm} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>{editingPedidoId ? 'Id' : 'Id (se asignará al guardar)'}</Text>
                  <TextInput
                    style={[styles.formInput, styles.formInputDisabled]}
                    value={form.Id}
                    placeholder={`PED-${new Date().getFullYear()}-00001`}
                    placeholderTextColor={colors.textMuted}
                    editable={false}
                  />
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Local *</Text>
                  <SelectorDesplegable
                    placeholder="— Seleccionar local —"
                    icono="store"
                    tituloLista="Selecciona un local"
                    iconoLista="store"
                    valorId={form.LocalId || null}
                    opciones={localesOrdenados.map((loc, idx) => {
                      const idLoc = String(valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'Id_Locales') ?? '').trim();
                      const nombre = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? idLoc) || '—').trim();
                      return {
                        id: idLoc || `loc-${idx}`,
                        titulo: nombre || idLoc || '—',
                        icono: 'store' as const,
                      };
                    })}
                    onSeleccionar={(id) => setForm((f) => ({ ...f, LocalId: id, AlmacenDestinoId: '' }))}
                  />
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Almacén origen *</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow}>
                    {editingPedidoId != null ? (
                      <>
                        {almacenesOrigenEdicion.map((alm) => {
                          const idAlm = String(valorEnLocal(alm, 'Id') ?? '').trim();
                          const nombre = String((valorEnLocal(alm, 'Nombre') ?? idAlm) || '—').trim();
                          const sel = idAlm !== '' && form.AlmacenOrigenId === idAlm;
                          return (
                            <TouchableOpacity
                              key={idAlm || nombre}
                              style={[styles.pickerChip, sel && styles.pickerChipActive]}
                              // Sin permiso de envío entre locales el origen es fijo: no se puede
                              // deseleccionar y dejar el pedido sin origen.
                              onPress={() =>
                                setForm((f) => ({
                                  ...f,
                                  AlmacenOrigenId: sel && puedeEnviarEntreLocales ? '' : idAlm,
                                }))
                              }
                            >
                              <Text style={[styles.pickerChipText, sel && styles.pickerChipTextActive]} numberOfLines={1}>
                                {nombre || idAlm || '—'}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </>
                    ) : (
                      (almacenGeneralId
                        ? almacenes.filter((alm) => String(valorEnLocal(alm, 'Id') ?? '').trim() === almacenGeneralId)
                        : almacenes
                      ).map((alm) => {
                          const idAlm = String(valorEnLocal(alm, 'Id') ?? '').trim();
                          const nombre = String((valorEnLocal(alm, 'Nombre') ?? idAlm) || '—').trim();
                          const sel = idAlm !== '' && form.AlmacenOrigenId === idAlm;
                          return (
                            <TouchableOpacity
                              key={idAlm || nombre}
                              style={[styles.pickerChip, sel && styles.pickerChipActive]}
                              onPress={() => setForm((f) => ({ ...f, AlmacenOrigenId: sel ? '' : idAlm }))}
                            >
                              <Text style={[styles.pickerChipText, sel && styles.pickerChipTextActive]} numberOfLines={1}>
                                {nombre || idAlm || '—'}
                              </Text>
                            </TouchableOpacity>
                          );
                        })
                    )}
                  </ScrollView>
                  {/* Solo cuando hay algo que advertir: con el origen ya en el
                      almacén central no hay factura de por medio ni alternativa
                      que explicar. */}
                  {editingPedidoId != null && !puedeEnviarEntreLocales && !origenEsGeneral ? (
                    <Text style={styles.formHint}>
                      {almacenGeneralId
                        ? 'Sin el permiso de envíos entre locales solo puedes devolver el origen al Almacén General: cambiarlo al almacén de otro local crearía una factura entre sociedades.'
                        : 'El origen no se puede cambiar sin el permiso de envíos entre locales: hacerlo puede crear o quitar una factura entre sociedades.'}
                    </Text>
                  ) : null}
                  {editingPedidoId != null && origenFueraDeMaestro ? (
                    <Text style={styles.formAvisoFactura}>
                      El almacén de origen de este pedido no está en el maestro de almacenes, así que no se
                      puede saber qué local sirvió la mercancía y la facturación mensual lo dejará fuera.
                      Revísalo en Almacenes.
                    </Text>
                  ) : null}
                  {editingPedidoId == null && generalNoIdentificado ? (
                    <Text style={styles.formAvisoFactura}>
                      No hay ningún almacén llamado «Almacén General» en el maestro, así que no se ha podido
                      preseleccionar el origen habitual: elígelo a mano. Si el almacén elegido no es el central,
                      el pedido generará factura entre sociedades y se rechazará sin el permiso de envíos entre
                      locales. Revisa el nombre del almacén central en Almacenes.
                    </Text>
                  ) : null}
                  {avisoOrigenPedido ? (
                    <Text
                      style={avisoOrigenPedido.tono === 'aviso' ? styles.formAvisoFactura : styles.formHint}
                    >
                      {avisoOrigenPedido.texto}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Almacén destino *</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow}>
                    {almacenesDestinoParaLocal.map((alm) => {
                      const idAlm = String(valorEnLocal(alm, 'Id') ?? '').trim();
                      const nombre = String((valorEnLocal(alm, 'Nombre') ?? idAlm) || '—').trim();
                      const sel = idAlm !== '' && form.AlmacenDestinoId === idAlm;
                      return (
                        <TouchableOpacity
                          key={idAlm || nombre}
                          style={[styles.pickerChip, sel && styles.pickerChipActive]}
                          onPress={() => setForm((f) => ({ ...f, AlmacenDestinoId: sel ? '' : idAlm }))}
                        >
                          <Text style={[styles.pickerChipText, sel && styles.pickerChipTextActive]} numberOfLines={1}>
                            {nombre || idAlm || '—'}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Total albarán</Text>
                  <TextInput
                    style={[styles.formInput, styles.formInputPrecioReadonly]}
                    value={formatMoneda(totalAlbaranCalculado)}
                    editable={false}
                    placeholder="0"
                    placeholderTextColor={colors.textMuted}
                  />
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Fecha *</Text>
                  <InputFecha
                    valueIso={form.Fecha}
                    onChangeIso={(v) => setForm((f) => ({ ...f, Fecha: v }))}
                    placeholder="dd/mm/aaaa"
                    style={styles.formInput}
                  />
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Estado</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow}>
                    {ESTADOS.map((est) => {
                      const sel = form.Estado === est;
                      return (
                        <TouchableOpacity
                          key={est}
                          style={[styles.pickerChip, sel && styles.pickerChipActive]}
                          onPress={() => setForm((f) => ({ ...f, Estado: est }))}
                        >
                          <Text style={[styles.pickerChipText, sel && styles.pickerChipTextActive]}>{est}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Notas</Text>
                  <TextInput
                    style={[styles.formInput, styles.formInputMultiline]}
                    value={form.Notas}
                    onChangeText={(v) => setForm((f) => ({ ...f, Notas: v }))}
                    placeholder="Observaciones"
                    placeholderTextColor={colors.textMuted}
                    multiline
                  />
                </View>
              </ScrollView>
              {errorForm ? <Text style={styles.formError}>{errorForm}</Text> : null}
              <View style={styles.modalFooter}>
                <TouchableOpacity style={styles.modalBtn} onPress={guardar} disabled={guardando}>
                  {guardando ? (
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <MaterialIcons name="save" size={20} color={colors.accent} />
                  )}
                  <Text style={styles.modalBtnText}>{editingPedidoId ? 'Guardar' : 'Crear'}</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      <NuevoPedidoModal
        visible={nuevoPedidoVisible}
        onClose={() => setNuevoPedidoVisible(false)}
        onCreado={refetch}
      />

      <Modal visible={modalBorrarVisible} transparent animationType="fade" onRequestClose={cerrarModalBorrar}>
        <Pressable style={styles.modalOverlay} onPress={cerrarModalBorrar}>
          <Pressable style={styles.modalCardBorrar} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Borrar pedido</Text>
              <TouchableOpacity onPress={cerrarModalBorrar} style={styles.modalClose}>
                <MaterialIcons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <View style={styles.modalBody}>
              {pedidoABorrar && (
                <Text style={styles.modalBorrarText}>
                  ¿Borrar el pedido <Text style={styles.modalBorrarId}>{String(valorEnLocal(pedidoABorrar, 'Id'))}</Text>?
                  Esta acción no se puede deshacer.
                </Text>
              )}
            </View>
            <View style={styles.modalFooter}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnCancel]} onPress={cerrarModalBorrar}>
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnDanger]}
                onPress={confirmarBorrar}
                disabled={borrando}
              >
                {borrando ? (
                  <ActivityIndicator size="small" color={colors.surface} />
                ) : (
                  <MaterialIcons name="delete" size={20} color={colors.surface} />
                )}
                <Text style={styles.modalBtnDangerText}>Borrar</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!confirmSalida} transparent animationType="fade" onRequestClose={cancelarSalida}>
        <Pressable style={styles.modalOverlay} onPress={cancelarSalida}>
          <Pressable style={styles.modalCardBorrar} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pedido sin enviar</Text>
              <TouchableOpacity onPress={cancelarSalida} style={styles.modalClose}>
                <MaterialIcons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <View style={styles.modalBody}>
              <Text style={styles.modalBorrarText}>
                Este pedido sigue en <Text style={styles.modalBorrarId}>Borrador</Text> y los compañeros de
                almacén no lo verán hasta que lo marques como <Text style={styles.modalBorrarId}>Enviado</Text>.
                {'\n\n'}¿Quieres enviarlo ahora?
              </Text>
            </View>
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnCancel]}
                onPress={() => resolverSalida(false)}
                disabled={enviandoSalida}
              >
                <Text style={styles.modalBtnCancelText}>Dejar en borrador</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtn} onPress={() => resolverSalida(true)} disabled={enviandoSalida}>
                {enviandoSalida ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <MaterialIcons name="send" size={18} color={colors.accent} />
                )}
                <Text style={styles.modalBtnText}>Enviar a almacén</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, position: 'relative' },
  mainRow: {
    flex: 1,
    flexDirection: 'row',
    minHeight: 0,
  },
  mainRowColumn: { flexDirection: 'column' },
  pedidosSection: { flex: 1, minWidth: 0, minHeight: 0 },
  anioApilado: { marginBottom: SPACING.sm, alignSelf: 'stretch' },
  lineasSection: {
    flex: 1,
    minWidth: 280,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    backgroundColor: '#fafafa',
  },
  lineasSectionColumn: {
    borderLeftWidth: 0,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    minWidth: 0,
  },
  lineasSectionHacer: {
    minWidth: 0,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    borderTopWidth: 0,
    backgroundColor: '#ffffff',
  },
  lineasPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  lineasPanelTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, flex: 1 },
  lineasPanelTotal: { fontVariant: ['tabular-nums'], fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  lineasEmptyHint: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center', paddingVertical: SPACING.xl, paddingHorizontal: SPACING.lg },
  detalleFullscreen: { flex: 1, backgroundColor: colors.surface },
  detalleFullscreenBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  detalleVolverBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: SPACING.xs, paddingHorizontal: SPACING.xs },
  detalleVolverText: { fontSize: fontSizes[16], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.accent },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalWrap: { width: '100%', maxWidth: 420, padding: SPACING.xl, alignItems: 'center' },
  modalCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    overflow: 'hidden',
  },
  modalCardBorrar: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface,
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
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: { fontSize: fontSizes[18], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  modalClose: { padding: SPACING.xs },
  modalBody: { paddingHorizontal: 20, paddingVertical: SPACING.lg, maxHeight: 400 },
  formGroup: { marginBottom: SPACING.md },
  formRow: { flexDirection: 'row', gap: SPACING.md, marginBottom: SPACING.md },
  formGroupFlex: { flex: 1, marginBottom: 0 },
  formLabel: { fontSize: fontSizes[12], fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight, color: colors.textPrimary, marginBottom: SPACING.xs },
  formInput: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    fontFamily: fontFamily.regular, fontSize: fontSizes[14],
    color: colors.textPrimary,
  },
  formInputCompact: { paddingVertical: SPACING.xs, minHeight: 36 },
  formInputDisabled: { backgroundColor: colors.navActive, color: colors.textMuted },
  formInputPrecioReadonly: { backgroundColor: '#fafbfc', color: colors.textMuted },
  formInputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  rappelHintOk: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.success, marginTop: 6 },
  rappelHintWarn: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.warning, marginTop: 6 },
  formHint: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: 6, lineHeight: 17 },
  formAvisoFactura: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes[12],
    fontWeight: typography.nav.fontWeight,
    color: statusColors.warning.text,
    backgroundColor: statusColors.warning.bg,
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: RADIO_MEDIO,
    padding: 10,
    marginTop: 6,
    lineHeight: 17,
  },
  avisoFacturadoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 6,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 10,
    backgroundColor: statusColors.warning.bg,
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: RADIO_MEDIO,
  },
  avisoFacturadoBoxTop: { marginTop: 0, marginBottom: 6 },
  avisoFacturadoText: { flex: 1, minWidth: 0, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: statusColors.warning.text, lineHeight: 17 },
  avisoFacturadoCerrar: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  formError: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, paddingHorizontal: 20, paddingVertical: SPACING.sm },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.md,
    paddingHorizontal: 20,
    paddingVertical: SPACING.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: 10,
    paddingHorizontal: SPACING.lg,
    backgroundColor: colors.accentMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  modalBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.accent },
  modalBtnCancel: { backgroundColor: colors.bg, borderColor: colors.border },
  modalBtnCancelText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  modalBtnDanger: { backgroundColor: colors.danger, borderColor: colors.danger },
  modalBtnDangerText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  modalBorrarText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary, lineHeight: 22 },
  modalBorrarId: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  pickerRow: { flexDirection: 'row', marginTop: SPACING.xs },
  pickerChip: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    marginRight: SPACING.sm,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pickerChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  pickerChipText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted },
  pickerChipTextActive: { color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  chipsEstadoScroll: { width: '100%', minHeight: MIN_TOUCH, flexGrow: 0 },
  chipsEstadoRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 6 },
  chipsEstadoEnLista: { flexGrow: 0, flexShrink: 0, alignSelf: 'stretch', minHeight: MIN_TOUCH },
  chipEstado: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 6,
    minHeight: MIN_TOUCH,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipEstadoActivo: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipEstadoCompletado: { backgroundColor: '#f0fdf4', borderColor: '#86efac' },
  chipEstadoCompletadoActivo: { backgroundColor: colors.success, borderColor: colors.success },
  chipEstadoText: { fontSize: fontSizes[13], color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  chipEstadoTextCompletado: { color: statusColors.success.text },
  chipEstadoTextActivo: { color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  chipEstadoBadge: {
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    alignItems: 'center',
  },
  chipEstadoBadgeActivo: { backgroundColor: 'rgba(255,255,255,0.3)' },
  chipEstadoBadgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  chipEstadoBadgeTextActivo: { color: colors.surface },
  lineasEditBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.lg, paddingVertical: 6, gap: 6 },
  lineasEditarBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingVertical: SPACING.xs, paddingHorizontal: SPACING.sm, backgroundColor: colors.accentMuted, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.accent },
  lineasEditarBtnText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.accent },
  lineasEditActions: { flexDirection: 'row', gap: 6 },
  lineasGuardarBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingVertical: SPACING.xs, paddingHorizontal: SPACING.sm, backgroundColor: colors.success, borderRadius: radius.sm },
  lineasGuardarBtnText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  lineasCancelarBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingVertical: SPACING.xs, paddingHorizontal: SPACING.sm, backgroundColor: colors.navActive, borderRadius: radius.sm },
  lineasCancelarBtnText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  lineasEditInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingVertical: SPACING.xs, paddingHorizontal: 6, backgroundColor: colors.surface },
  lineasList: { flex: 1, maxHeight: 300, marginBottom: SPACING.md, paddingHorizontal: SPACING.lg },
  lineasListFull: { maxHeight: undefined },
  lineasEmpty: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center', paddingVertical: 20 },
  lineasTable: { minWidth: 520 },
  lineasTableWide: { width: '100%', minWidth: 0, alignSelf: 'stretch' },
  lineasTableHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingHorizontal: SPACING.sm, borderBottomWidth: 2, borderBottomColor: colors.border, backgroundColor: colors.bg },
  lineasTableHeaderCell: { fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  lineasHeaderTwoLines: { lineHeight: 14 },
  lineasTableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingHorizontal: SPACING.sm, borderBottomWidth: 1, borderBottomColor: colors.navActive },
  lineasTableCell: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary },
  lineasCellCantidad: { textAlign: 'center', fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: '#E91E63' },
  lineasCellTotal: { fontVariant: ['tabular-nums'], textAlign: 'right', fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  lineasCellRappelAbono: { fontVariant: ['tabular-nums'], color: colors.danger, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  lineasColPreparada: { width: 44, alignItems: 'center', justifyContent: 'center' },
  lineasCheckBtn: { padding: SPACING.xs },
  lineasCheckBtnActive: {},
  lineasColCantidad: { width: 52 },
  lineasColId: { width: 60, alignItems: 'center', justifyContent: 'center' },
  lineasColDelete: { width: 36, alignItems: 'center', justifyContent: 'center' },
  lineasDeleteBtn: { padding: SPACING.xs },
  lineasColArticulo: { flex: 1, minWidth: 120 },
  lineasArticulo: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm, minWidth: 0 },
  lineasArticuloNombre: { flexShrink: 1 },
  lineasColArticuloPreparada: { backgroundColor: statusColors.success.bg },
  lineasCellArticuloPreparada: { color: colors.success, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  lineasCellIdBadge: { backgroundColor: '#dbeafe', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm, alignSelf: 'center' },
  lineasCellIdText: { fontSize: fontSizes.badge, color: '#1e40af', fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  lineasColPrecio: { width: 70 },
  lineasColIva: { width: 44 },
  lineasColTotal: { width: 78 },
  lineasColTotalRappel: { width: 66 },
  lineasTableEmpty: { paddingVertical: SPACING.xl },
  lineasAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    backgroundColor: statusColors.success.bg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#86efac',
  },
  lineasAddBtnText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.success },
  enviarPedidoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    backgroundColor: '#fed7aa',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#fdba74',
  },
  enviarPedidoBtnText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: '#9a3412' },
  btnDisabledOpacity: { opacity: 0.5 },
  lineaForm: {
    marginTop: SPACING.sm,
    paddingTop: 12,
    paddingBottom: 12,
    paddingHorizontal: SPACING.lg,
    marginHorizontal: 0,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.navActive,
  },
  lineaFormProductoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
    alignItems: 'flex-start',
    marginBottom: SPACING.md,
  },
  lineaFormLabelLinea: {
    minHeight: 16,
    lineHeight: 16,
  },
  lineaFormCantidadMatch: {
    minHeight: 40,
  },
  formGroupProductoLinea: {
    flex: 1,
    minWidth: 160,
    marginBottom: 0,
  },
  lineaFormValoresRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
    alignItems: 'flex-end',
  },
  formGroupCantidadLinea: {
    width: 168,
    minWidth: 168,
    flexShrink: 0,
    marginBottom: 0,
  },
  lineaFormBtns: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.md, justifyContent: 'flex-end' },
  listaMovil: { flex: 1, position: 'relative', backgroundColor: '#e8eef5', padding: SPACING.lg, gap: SPACING.md },
  fondoPantalla: { backgroundColor: '#ffffff' },
  listaMovilHeader: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  listaMovilBack: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  listaMovilTituloWrap: { flex: 1, minWidth: 0 },
  listaMovilTitulo: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  listaMovilSub: { fontSize: 13, color: '#64748b' },
  listaMovilNuevo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: MIN_TOUCH,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e7edf4',
  },
  listaMovilNuevoText: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  listaMovilBuscar: {
    minHeight: MIN_TOUCH,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e7edf4',
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    fontSize: 15,
    color: '#334155',
  },
  listaMovilScroll: { gap: SPACING.sm, paddingBottom: SPACING.xl },
  listaMovilScrollFab: { paddingBottom: 96 },
  anioEnFila: { width: 120, minWidth: 0, maxWidth: 120 },
  fabWrap: { position: 'absolute', right: SPACING.lg },
  grupoPedidos: { gap: SPACING.sm },
  grupoPedidosTitulo: {
    fontSize: fontSizes[13],
    fontFamily: fontFamily.bold,
    fontWeight: '700',
    color: '#64748b',
    marginTop: SPACING.xs,
  },
  listaMovilCentro: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  listaMovilVacio: { fontSize: 14, color: '#64748b', textAlign: 'center', marginTop: 12 },
  listaMovilReintentar: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  listaMovilReintentarText: { fontSize: 14, fontWeight: '600', color: '#0ea5e9' },
  cardPedido: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e7edf4',
    padding: 14,
    gap: 4,
  },
  cardPedidoFranja: { borderLeftWidth: 4 },
  cardPedidoSel: { backgroundColor: '#fdf2f8', borderColor: '#f9a8d4' },
  cardEstadoChip: {
    borderRadius: radius.pill,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    flexShrink: 0,
  },
  cardEstadoChipText: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: '700' },
  cardPedidoTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  cardPedidoId: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '700', color: '#0f172a' },
  cardPedidoEstado: { fontSize: 12, fontWeight: '700', color: '#b45309' },
  cardPedidoLocal: { fontSize: 15, color: '#334155' },
  cardPedidoRuta: { fontSize: fontSizes[13], color: '#64748b' },
  cardPedidoLineas: { fontSize: fontSizes[13], color: '#64748b' },
  cardPedidoPie: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: SPACING.sm, marginTop: SPACING.xs },
  cardPedidoFecha: { fontSize: 13, color: '#64748b', flexShrink: 1 },
  cardPedidoTotal: { fontSize: fontSizes[20], fontFamily: fontFamily.bold, fontWeight: '700', color: '#0f172a' },
  detallePantalla: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    backgroundColor: '#e8eef5',
    padding: 16,
  },
  lineaMovil: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e7edf4',
    backgroundColor: '#fff',
  },
  lineaMovilCantidad: { fontSize: 17, fontWeight: '700', color: '#0f172a', minWidth: 28, textAlign: 'right' },
  lineaMovilCantidadInput: { flexShrink: 0 },
  lineaMovilNombre: { flex: 1, fontSize: 15, color: '#334155', fontWeight: '500' },
  enviarFijo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: MIN_TOUCH,
    marginTop: 8,
    borderRadius: 12,
    backgroundColor: '#16a34a',
  },
  enviarFijoText: { fontSize: 16, fontWeight: '700', color: '#fff' },
});
