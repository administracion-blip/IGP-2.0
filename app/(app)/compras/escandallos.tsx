import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Switch,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useProductosCache } from '../../contexts/ProductosCache';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { ComprasProveedorModal } from '../../components/ComprasProveedorModal';
import {
  SoftPulseBorderWrap,
  type SoftPulseColors,
} from '../../components/ui/SoftPulseBorderWrap';
import { ICONS, ICON_SIZE } from '../../constants/icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatMoneda } from '../../utils/formatMoneda';
import {
  UNIDADES_ESCANDALLO,
  labelUnidadEscandallo,
  normalizeUnidadEscandallo,
  stripLeadingZerosId,
  idsIgualesNorm,
} from '../../lib/escandalloUnidades';
import {
  CATEGORIAS_COSTE_ORDEN,
  categoriaCostePorId,
  categoriaCosteTeorico,
  costeTeoricoDesdeIngredientes,
  type CategoriaCosteId,
} from '../../lib/escandalloCosteCategoria';
import { isoLocal } from '../../lib/comprasProveedorRango';
import { escCampoId, useEscandalloLineasTab } from '../../hooks/useEscandalloLineasTab';

type IngredienteLista = {
  ingredienteId: string;
  cantidad: number | string;
  mermaPct?: number | string | null;
  unidad?: string;
};

type RecetaMeta = {
  productoId: string;
  nombre: string;
  udReceta: string;
  activo: boolean;
  updatedAt?: string;
  /** Presente si la lista se pidió con `conIngredientes=1`. */
  ingredientes?: IngredienteLista[];
};

type LineaForm = {
  key: string;
  ingredienteId: string;
  nombre: string;
  cantidad: string;
  unidad: string;
  mermaPct: string;
};

type FormReceta = {
  productoId: string;
  nombre: string;
  udReceta: string;
  activo: boolean;
  imagen_key: string;
  lineas: LineaForm[];
};

type CostPriceEntry = { WarehouseId?: string | number; CostPrice?: number | string };

type PriceEntry = {
  PriceListId?: string | number;
  MainPrice?: number | string;
  SaleCenterId?: string | number;
};

type ProductoCache = Record<string, unknown> & {
  Active?: boolean;
  CostPrice?: number | string;
  CostPrices?: CostPriceEntry[];
  Prices?: PriceEntry[];
};

type CompraContextoItem = {
  proveedorId?: string;
  proveedorNombre?: string;
  formatoNombre?: string;
  purchaseUnitId?: string;
  precio?: number | string | null;
  fecha?: string | null;
};

type LocalContexto = {
  id: string;
  nombre: string;
  agoraCode: string;
  priceListId?: string | null;
  saleCenterNombre?: string | null;
  sinAsignar?: boolean;
  warehouseIds?: string[];
};

/** IVA aplicado al P. venta de Ágora; el margen se calcula sobre el neto. */
const IVA_VENTA = 10;

/** Umbrales de rentabilidad del plato según % de margen sobre neto. */
const MARGEN_PCT_ALTO = 75;
const MARGEN_PCT_MEDIO = 68;
const MARGEN_PCT_BAJO = 62;

const ESCANDALLOS_LOCAL_KEY = 'escandallos:localId';

const FORM_VACIO: FormReceta = {
  productoId: '',
  nombre: '',
  udReceta: 'UD',
  activo: true,
  imagen_key: '',
  lineas: [],
};

const UNIDADES_COMPACTAS = UNIDADES_ESCANDALLO.map((u) => ({ id: u.id, titulo: u.id }));

function productoIdDe(p: Record<string, unknown>): string {
  return String(p.Id ?? p.id ?? p.Code ?? p.code ?? '').trim();
}

function productoNombreDe(p: Record<string, unknown>): string {
  return String(p.Name ?? p.Nombre ?? p.nombre ?? p.ProductName ?? productoIdDe(p)).trim();
}

function productoActivo(p: Record<string, unknown>): boolean {
  return p.Active !== false;
}

function parseDecimal(s: string): number | null {
  const n = parseFloat(String(s).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

function nuevaKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatCantidadKpi(n: number, decimales = 3): string {
  return n.toLocaleString('es-ES', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimales,
  });
}

/** De dónde sale el coste: `otroAlmacen` avisa de que no es el almacén elegido. */
type OrigenCoste = 'almacen' | 'otroAlmacen' | 'global' | 'ninguno';

function costeUnitarioConOrigen(
  p: ProductoCache | undefined,
  warehouseId: string | null,
): { coste: number; origen: OrigenCoste } {
  if (!p) return { coste: 0, origen: 'ninguno' };
  const cps = Array.isArray(p.CostPrices) ? p.CostPrices : null;
  if (warehouseId && cps?.length) {
    const hit = cps.find((cp) => idsIgualesNorm(cp.WarehouseId, warehouseId));
    if (hit != null) {
      const n = Number(hit.CostPrice);
      if (Number.isFinite(n)) return { coste: n, origen: 'almacen' };
    }
  }
  if (!warehouseId) {
    const global = Number(p.CostPrice);
    if (Number.isFinite(global) && global > 0) return { coste: global, origen: 'global' };
  }
  if (cps?.length) {
    const n = Number(cps[0].CostPrice);
    if (Number.isFinite(n)) return { coste: n, origen: warehouseId ? 'otroAlmacen' : 'global' };
  }
  const global = Number(p.CostPrice);
  return Number.isFinite(global) ? { coste: global, origen: 'global' } : { coste: 0, origen: 'ninguno' };
}

function costeUnitarioProducto(p: ProductoCache | undefined, warehouseId: string | null): number {
  return costeUnitarioConOrigen(p, warehouseId).coste;
}

/** Color del KPI Margen según rentabilidad: ≥75 verde, ≥68 ámbar, ≥62 naranja, <62 rojo. */
function estiloMargenPorPct(pct: number): {
  chip: { backgroundColor: string };
  texto: { color: string };
  pulse: SoftPulseColors;
} {
  if (pct >= MARGEN_PCT_ALTO) {
    return {
      chip: styles.kpiChipMargenAlto,
      texto: styles.kpiTextoMargenAlto,
      pulse: {
        border: '#86efac',
        pulseFrom: 'rgba(134, 239, 172, 0.35)',
        pulseTo: 'rgba(22, 163, 74, 0.95)',
        glow: 'rgba(134, 239, 172, 0.65)',
        shadow: '#4ade80',
      },
    };
  }
  if (pct >= MARGEN_PCT_MEDIO) {
    return {
      chip: styles.kpiChipMargenMedio,
      texto: styles.kpiTextoMargenMedio,
      pulse: {
        border: '#fde68a',
        pulseFrom: 'rgba(253, 230, 138, 0.35)',
        pulseTo: 'rgba(217, 119, 6, 0.95)',
        glow: 'rgba(253, 230, 138, 0.65)',
        shadow: '#fbbf24',
      },
    };
  }
  if (pct >= MARGEN_PCT_BAJO) {
    return {
      chip: styles.kpiChipMargenBajo,
      texto: styles.kpiTextoMargenBajo,
      pulse: {
        border: '#fdba74',
        pulseFrom: 'rgba(253, 186, 116, 0.35)',
        pulseTo: 'rgba(234, 88, 12, 0.95)',
        glow: 'rgba(253, 186, 116, 0.65)',
        shadow: '#fb923c',
      },
    };
  }
  return {
    chip: styles.kpiChipMargenCritico,
    texto: styles.kpiTextoMargenCritico,
    pulse: {
      border: '#fca5a5',
      pulseFrom: 'rgba(252, 165, 165, 0.35)',
      pulseTo: 'rgba(220, 38, 38, 0.95)',
      glow: 'rgba(252, 165, 165, 0.65)',
      shadow: '#f87171',
    },
  };
}

/** Precio de venta del plato según Prices[].PriceListId (= tarifa del local). */
function precioVentaProducto(
  p: ProductoCache | undefined,
  priceListId: string | null,
): { precio: number | null; tienePrices: boolean } {
  if (!p) return { precio: null, tienePrices: false };
  const prices = Array.isArray(p.Prices) ? p.Prices : null;
  if (!prices?.length) return { precio: null, tienePrices: false };

  if (priceListId) {
    const hit = prices.find(
      (pr) =>
        String(pr.PriceListId) === String(priceListId) ||
        idsIgualesNorm(pr.PriceListId, priceListId),
    );
    if (hit != null) {
      const n = Number(hit.MainPrice);
      if (Number.isFinite(n) && n > 0) return { precio: n, tienePrices: true };
    }
    // Con tarifa elegida no inventar otra
    return { precio: null, tienePrices: true };
  }

  // Sin tarifa: solo si hay exactamente un MainPrice > 0
  const positivos = prices
    .map((pr) => Number(pr.MainPrice))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (positivos.length === 1) return { precio: positivos[0], tienePrices: true };
  return { precio: null, tienePrices: true };
}

function rangoUltimos6Meses(): { fechaInicio: string; fechaFin: string } {
  const fin = new Date();
  const ini = new Date(fin);
  ini.setMonth(ini.getMonth() - 6);
  return {
    fechaInicio: isoLocal(ini),
    fechaFin: isoLocal(fin),
  };
}

function textoCompraContexto(item: CompraContextoItem | undefined): string {
  if (!item) return 'Sin compras';
  const proveedor = String(item.proveedorNombre || item.proveedorId || '').trim() || 'Proveedor';
  const formato = String(item.formatoNombre || '').trim() || '—';
  const precioNum = item.precio != null ? Number(item.precio) : NaN;
  const precioTxt = Number.isFinite(precioNum) ? formatMoneda(precioNum) : '—';
  return `${proveedor} · ${formato} · ${precioTxt}`;
}

export default function EscandallosScreen() {
  const router = useRouter();
  const { hasPermiso, localPermitido } = useAuth();
  const { shouldStackPanels, isPhone } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();
  const {
    productos,
    loading: loadingProductos,
    lastFetch: productosLastFetch,
    recargar: recargarProductos,
    error: errorProductos,
  } = useProductosCache();

  const puedeVer = hasPermiso('escandallos.ver');
  const puedeEditar = hasPermiso('escandallos.editar');
  const apilarLinea = shouldStackPanels || isPhone;
  const splitView = !shouldStackPanels;

  const [recetas, setRecetas] = useState<RecetaMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  /** `null` = Todas las categorías de coste. */
  const [filtroCategoriaCoste, setFiltroCategoriaCoste] = useState<CategoriaCosteId | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [detalleAbierto, setDetalleAbierto] = useState(false);
  const [modoNuevo, setModoNuevo] = useState(false);
  const [soloLectura, setSoloLectura] = useState(false);
  const [loadingDetalle, setLoadingDetalle] = useState(false);
  const [form, setForm] = useState<FormReceta>(FORM_VACIO);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);

  const [almacenNombres, setAlmacenNombres] = useState<Map<string, string>>(() => new Map());
  const [locales, setLocales] = useState<LocalContexto[]>([]);
  const [errorLocales, setErrorLocales] = useState(false);
  const [localId, setLocalId] = useState<string | null>(null);
  const localIdPreferidoRef = useRef<string | null>(null);
  const [preferenciaLeida, setPreferenciaLeida] = useState(false);

  const [imagenUrl, setImagenUrl] = useState<string | null>(null);
  const [imagenBusy, setImagenBusy] = useState(false);

  const [comprasCtx, setComprasCtx] = useState<Record<string, CompraContextoItem>>({});
  const [comprasModal, setComprasModal] = useState<{
    productId: string;
    productName: string;
    fechaInicio: string;
    fechaFin: string;
  } | null>(null);

  useEffect(() => {
    if (puedeVer && !productosLastFetch) void recargarProductos();
  }, [puedeVer, productosLastFetch, recargarProductos]);

  /** Nombres de almacén (Id→Nombre) normalizando ceros. */
  useEffect(() => {
    if (!puedeVer) return;
    let cancelled = false;
    apiFetch('/api/almacenes')
      .then((r) => r.json())
      .then((data: { almacenes?: Array<Record<string, unknown>> }) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const a of data.almacenes || []) {
          const id = String(a.Id ?? a.id ?? '').trim();
          const nombre = String(a.Nombre ?? a.nombre ?? '').trim();
          if (!id || !nombre) continue;
          map.set(id, nombre);
          map.set(stripLeadingZerosId(id), nombre);
        }
        // Fusionar: el contexto de almacenes puede haber resuelto antes.
        setAlmacenNombres((prev) => new Map([...prev, ...map]));
      })
      .catch(() => {
        /* silencioso: se muestra "Almacén {id}" */
      });
    return () => {
      cancelled = true;
    };
  }, [puedeVer]);

  /** Último local elegido (se restaura al montar). */
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(ESCANDALLOS_LOCAL_KEY)
      .then((v) => {
        if (cancelled) return;
        localIdPreferidoRef.current = v && v.trim() ? v.trim() : null;
      })
      .catch(() => {
        /* silencioso: se cae al primer local */
      })
      .finally(() => {
        if (!cancelled) setPreferenciaLeida(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Locales con tarifa y almacenes asociados (+ refresco de nombres). */
  useEffect(() => {
    if (!puedeVer) return;
    let cancelled = false;
    apiFetch('/api/escandallos/almacen-contexto')
      .then((r) => r.json())
      .then(
        (data: {
          locales?: LocalContexto[];
          almacenes?: Array<{ id?: string; nombre?: string }>;
          error?: string;
        }) => {
          if (cancelled) return;
          if (Array.isArray(data.almacenes) && data.almacenes.length) {
            setAlmacenNombres((prev) => {
              const next = new Map(prev);
              for (const a of data.almacenes!) {
                const id = String(a.id ?? '').trim();
                const nombre = String(a.nombre ?? '').trim();
                if (!id || !nombre) continue;
                next.set(id, nombre);
                next.set(stripLeadingZerosId(id), nombre);
              }
              return next;
            });
          }
          // Filtrar por locales del usuario antes de restaurar la preferencia guardada.
          const permitidos = (Array.isArray(data.locales) ? data.locales : []).filter((l) =>
            localPermitido(String(l.nombre ?? '').trim()),
          );
          setErrorLocales(false);
          setLocales(permitidos);
        },
      )
      .catch(() => {
        if (cancelled) return;
        setLocales([]);
        setErrorLocales(true);
      });
    return () => {
      cancelled = true;
    };
  }, [puedeVer, localPermitido]);

  /** Selección inicial: local guardado si sigue existiendo, si no el primero. */
  useEffect(() => {
    if (!preferenciaLeida || locales.length === 0) return;
    setLocalId((prev) => {
      if (prev && locales.some((l) => l.id === prev)) return prev;
      const guardado = localIdPreferidoRef.current;
      if (guardado && locales.some((l) => l.id === guardado)) return guardado;
      return locales[0]?.id ?? null;
    });
  }, [preferenciaLeida, locales]);

  useEffect(() => {
    if (!localId) return;
    localIdPreferidoRef.current = localId;
    AsyncStorage.setItem(ESCANDALLOS_LOCAL_KEY, localId).catch(() => {
      /* silencioso: solo es una preferencia */
    });
  }, [localId]);

  const fetchRecetas = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch('/api/escandallos?conIngredientes=1')
      .then((r) => r.json())
      .then((data: { recetas?: RecetaMeta[]; error?: string }) => {
        if (data.error) setError(data.error);
        else setRecetas(Array.isArray(data.recetas) ? data.recetas : []);
      })
      .catch((e) => setError(errorMessage(e, 'Error de conexión')))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (puedeVer) fetchRecetas();
  }, [puedeVer, fetchRecetas]);

  const productoById = useMemo(() => {
    const m = new Map<string, ProductoCache>();
    for (const raw of productos as ProductoCache[]) {
      const id = productoIdDe(raw);
      if (!id) continue;
      m.set(id, raw);
      const sinCeros = stripLeadingZerosId(id);
      if (sinCeros && sinCeros !== id) m.set(sinCeros, raw);
    }
    return m;
  }, [productos]);

  const getProducto = useCallback(
    (idRaw: string): ProductoCache | undefined => {
      const id = String(idRaw ?? '').trim();
      if (!id) return undefined;
      return productoById.get(id) ?? productoById.get(stripLeadingZerosId(id));
    },
    [productoById],
  );

  /** Opciones Active; el map una vez es OK — minChars evita pintar miles de filas. */
  const opcionesProductos = useMemo(() => {
    const out: Array<{ id: string; titulo: string; subtitulo: string }> = [];
    for (const raw of productos as ProductoCache[]) {
      if (!productoActivo(raw)) continue;
      const id = productoIdDe(raw);
      if (!id) continue;
      const nombre = productoNombreDe(raw);
      out.push({ id, titulo: nombre || id, subtitulo: `ID ${id}` });
    }
    return out;
  }, [productos]);

  const opcionProductoDe = useCallback(
    (id: string) => {
      const fromActive = opcionesProductos.find((o) => o.id === id || o.id === stripLeadingZerosId(id));
      if (fromActive) return fromActive;
      const p = getProducto(id);
      if (p) {
        const nombre = productoNombreDe(p);
        return { id, titulo: nombre || id, subtitulo: `ID ${id}` };
      }
      return id ? { id, titulo: id, subtitulo: `ID ${id}` } : null;
    },
    [opcionesProductos, getProducto],
  );

  const opcionesConId = useCallback(
    (selectedId?: string | null) => {
      if (!selectedId) return opcionesProductos;
      if (opcionesProductos.some((o) => o.id === selectedId)) return opcionesProductos;
      const extra = opcionProductoDe(selectedId);
      return extra ? [extra, ...opcionesProductos] : opcionesProductos;
    },
    [opcionesProductos, opcionProductoDe],
  );

  const nombreAlmacenDe = useCallback(
    (id: string) =>
      almacenNombres.get(id) || almacenNombres.get(stripLeadingZerosId(id)) || '',
    [almacenNombres],
  );

  const opcionesLocales = useMemo(
    () =>
      locales.map((l) => ({
        id: l.id,
        titulo: l.nombre || l.id,
        subtitulo:
          l.priceListId != null && String(l.priceListId).trim() !== ''
            ? `Tarifa ${String(l.priceListId).trim()}`
            : 'Sin tarifa asignada',
      })),
    [locales],
  );

  const localSeleccionado = useMemo(
    () => locales.find((l) => l.id === localId) ?? null,
    [locales, localId],
  );

  /** Almacenes del local elegido (el coste sale de sus CostPrices). */
  const almacenesLocalKey = useMemo(() => {
    const ids = localSeleccionado?.warehouseIds;
    if (!Array.isArray(ids)) return '';
    const out: string[] = [];
    for (const raw of ids) {
      const id = String(raw ?? '').trim();
      if (id && !out.includes(id)) out.push(id);
    }
    return out.join(',');
  }, [localSeleccionado]);

  const almacenesLocal = useMemo(
    () => (almacenesLocalKey ? almacenesLocalKey.split(',') : []),
    [almacenesLocalKey],
  );

  /** Al cambiar de local, el almacén de coste pasa a ser el primero del local. */
  useEffect(() => {
    const ids = almacenesLocalKey ? almacenesLocalKey.split(',') : [];
    setWarehouseId(ids[0] ?? null);
  }, [almacenesLocalKey]);

  const almacenesCoste = useMemo(
    () =>
      almacenesLocal.map((id) => {
        const nombre = nombreAlmacenDe(id);
        return {
          id,
          titulo: nombre || `Almacén ${id}`,
          subtitulo: id,
        };
      }),
    [almacenesLocal, nombreAlmacenDe],
  );

  /** Coste teórico de listado (misma fórmula que el KPI del detalle). */
  const costeTeoricoDeReceta = useCallback(
    (r: RecetaMeta): number =>
      costeTeoricoDesdeIngredientes(r.ingredientes, (id) =>
        costeUnitarioProducto(getProducto(id), warehouseId),
      ),
    [getProducto, warehouseId],
  );

  const categoriaDeReceta = useCallback(
    (r: RecetaMeta) => categoriaCosteTeorico(costeTeoricoDeReceta(r)),
    [costeTeoricoDeReceta],
  );

  const conteoPorCategoria = useMemo(() => {
    const counts: Record<CategoriaCosteId, number> = {
      muy_bajo: 0,
      bajo: 0,
      medio: 0,
      alto: 0,
      sin_coste: 0,
    };
    for (const r of recetas) {
      counts[categoriaDeReceta(r).id] += 1;
    }
    return counts;
  }, [recetas, categoriaDeReceta]);

  const recetasFiltradas = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    return recetas.filter((r) => {
      if (filtroCategoriaCoste && categoriaDeReceta(r).id !== filtroCategoriaCoste) return false;
      if (!q) return true;
      const blob = `${r.productoId} ${r.nombre} ${labelUnidadEscandallo(r.udReceta)} ${
        r.activo !== false ? 'activo' : 'inactivo'
      }`.toLowerCase();
      return blob.includes(q);
    });
  }, [recetas, filtroBusqueda, filtroCategoriaCoste, categoriaDeReceta]);

  const recetasPorProducto = useMemo(() => {
    const m = new Map<string, RecetaMeta>();
    for (const r of recetas) m.set(String(r.productoId), r);
    return m;
  }, [recetas]);

  const ingredientesIdsKey = useMemo(() => {
    const ids = [
      ...new Set(form.lineas.map((ln) => ln.ingredienteId.trim()).filter(Boolean)),
    ].sort();
    return ids.join(',');
  }, [form.lineas]);

  /** Última compra por ingrediente (debounce 300 ms). */
  useEffect(() => {
    if (!detalleAbierto) {
      setComprasCtx({});
      return;
    }
    if (!ingredientesIdsKey) {
      setComprasCtx({});
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      const qs = new URLSearchParams();
      qs.set('productIds', ingredientesIdsKey);
      if (warehouseId) qs.set('warehouseId', warehouseId);
      apiFetch(`/api/escandallos/compras-contexto?${qs.toString()}`)
        .then((r) => r.json())
        .then((data: { items?: Record<string, CompraContextoItem> }) => {
          if (!cancelled) setComprasCtx(data.items && typeof data.items === 'object' ? data.items : {});
        })
        .catch(() => {
          if (!cancelled) setComprasCtx({});
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [detalleAbierto, ingredientesIdsKey, warehouseId]);

  const kpis = useMemo(() => {
    let kgTotal = 0;
    let lTotal = 0;
    let udTotal = 0;
    let coste = 0;
    let lineasConCoste = 0;
    let lineasOtroAlmacen = 0;

    for (const ln of form.lineas) {
      const cant = parseDecimal(ln.cantidad);
      if (cant == null || cant < 0) continue;
      const ud = normalizeUnidadEscandallo(ln.unidad);
      if (ud === 'KG') kgTotal += cant;
      else if (ud === 'L') lTotal += cant;
      else if (ud === 'UD') udTotal += cant;

      const merma = parseDecimal(ln.mermaPct || '0') ?? 0;
      const prod = getProducto(ln.ingredienteId.trim());
      const { coste: unit, origen } = costeUnitarioConOrigen(prod, warehouseId);
      if (unit > 0) lineasConCoste += 1;
      if (origen === 'otroAlmacen') lineasOtroAlmacen += 1;
      coste += cant * (1 + merma / 100) * unit;
    }

    return { kgTotal, lTotal, udTotal, coste, lineasConCoste, lineasOtroAlmacen };
  }, [form.lineas, getProducto, warehouseId]);

  const ventaInfo = useMemo(() => {
    const priceListIdRaw = localSeleccionado?.priceListId;
    const priceListId =
      priceListIdRaw != null && String(priceListIdRaw).trim() !== ''
        ? String(priceListIdRaw).trim()
        : null;
    // Sin tarifa del local no inventar MainPrice (p. ej. producto con una sola tarifa).
    const bloquearSinTarifa = localSeleccionado?.sinAsignar === true || !priceListId;
    const saleCenterNombre = String(localSeleccionado?.saleCenterNombre || '').trim();
    if (!localSeleccionado || !form.productoId) {
      return {
        precio: null as number | null,
        tienePrices: false,
        sinSync: false,
        sinTarifaLocal: bloquearSinTarifa,
        priceListId,
        saleCenterNombre,
      };
    }
    const plato = getProducto(form.productoId.trim());
    const { precio: precioRaw, tienePrices } = precioVentaProducto(
      plato,
      bloquearSinTarifa ? null : priceListId,
    );
    return {
      precio: bloquearSinTarifa ? null : precioRaw,
      tienePrices,
      // Plato ausente de la cache también es falta de sincronización.
      sinSync: !tienePrices,
      sinTarifaLocal: bloquearSinTarifa,
      priceListId,
      saleCenterNombre,
    };
  }, [form.productoId, getProducto, localSeleccionado]);

  /** El P. venta de Ágora lleva IVA: margen y % se calculan sobre el neto. */
  const margenInfo = useMemo(() => {
    const precio = ventaInfo.precio;
    if (precio == null || !(precio > 0)) return null;
    const neto = precio / (1 + IVA_VENTA / 100);
    if (!(neto > 0)) return null;
    if (!(kpis.coste > 0)) return { neto, margen: null as number | null, pct: null as number | null };
    const margen = neto - kpis.coste;
    return { neto, margen, pct: (margen / neto) * 100 };
  }, [ventaInfo.precio, kpis.coste]);

  const recetaGuardada = Boolean(detalleAbierto && form.productoId && !modoNuevo);

  const cargarImagenUrl = useCallback(async (productoId: string) => {
    setImagenUrl(null);
    try {
      const res = await apiFetch(`/api/escandallos/${encodeURIComponent(productoId)}/imagen-url`);
      const data = (await res.json()) as { url?: string | null };
      setImagenUrl(data.url || null);
    } catch {
      setImagenUrl(null);
    }
  }, []);

  const cerrarDetalle = useCallback(() => {
    if (guardando) return;
    setDetalleAbierto(false);
    setModoNuevo(false);
    setErrorForm(null);
    setLoadingDetalle(false);
    setForm(FORM_VACIO);
    setImagenUrl(null);
    setImagenBusy(false);
    setComprasCtx({});
    setComprasModal(null);
  }, [guardando]);

  const abrirNuevo = useCallback(() => {
    if (!puedeEditar) return;
    setForm(FORM_VACIO);
    setModoNuevo(true);
    setSoloLectura(false);
    setErrorForm(null);
    setImagenUrl(null);
    setDetalleAbierto(true);
  }, [puedeEditar]);

  const aplicarDetalle = useCallback((data: RecetaDetalleLike, fallback?: RecetaMeta) => {
    const ings = Array.isArray(data.ingredientes) ? data.ingredientes : [];
    setForm({
      productoId: String(data.productoId ?? fallback?.productoId ?? ''),
      nombre: String(data.nombre ?? fallback?.nombre ?? ''),
      udReceta: normalizeUnidadEscandallo(data.udReceta ?? fallback?.udReceta) || 'UD',
      activo: data.activo !== false,
      imagen_key: String(data.imagen_key ?? ''),
      lineas: ings
        .slice()
        .sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0))
        .map((ing) => ({
          key: nuevaKey(),
          ingredienteId: String(ing.ingredienteId ?? ''),
          nombre: String(ing.nombre ?? ''),
          cantidad: ing.cantidad != null ? String(ing.cantidad) : '',
          unidad: normalizeUnidadEscandallo(ing.unidad) || '',
          mermaPct: ing.mermaPct != null ? String(ing.mermaPct) : '0',
        })),
    });
  }, []);

  const cargarDetalle = useCallback(
    async (item: RecetaMeta, lectura: boolean) => {
      setModoNuevo(false);
      setSoloLectura(lectura);
      setErrorForm(null);
      setImagenUrl(null);
      setForm({
        productoId: item.productoId,
        nombre: item.nombre,
        udReceta: normalizeUnidadEscandallo(item.udReceta) || 'UD',
        activo: item.activo !== false,
        imagen_key: '',
        lineas: [],
      });
      setDetalleAbierto(true);
      setLoadingDetalle(true);
      try {
        const res = await apiFetch(`/api/escandallos/${encodeURIComponent(item.productoId)}`);
        const data = (await res.json()) as RecetaDetalleLike & { error?: string };
        if (!res.ok || data.error) {
          setErrorForm(data.error || 'No se pudo cargar la receta');
          return;
        }
        aplicarDetalle(data, item);
        void cargarImagenUrl(item.productoId);
      } catch (e) {
        setErrorForm(errorMessage(e, 'Error de conexión'));
      } finally {
        setLoadingDetalle(false);
      }
    },
    [aplicarDetalle, cargarImagenUrl],
  );

  const elegirPlato = useCallback(
    (id: string) => {
      const existente = recetasPorProducto.get(id);
      if (existente) {
        void cargarDetalle(existente, !puedeEditar);
        return;
      }
      const op = opcionProductoDe(id);
      setForm((prev) => ({
        ...prev,
        productoId: id,
        nombre: op?.titulo || id,
      }));
      setErrorForm(null);
    },
    [recetasPorProducto, cargarDetalle, puedeEditar, opcionProductoDe],
  );

  const elegirIngrediente = useCallback(
    (key: string, id: string) => {
      const op = opcionProductoDe(id);
      setForm((prev) => ({
        ...prev,
        lineas: prev.lineas.map((ln) =>
          ln.key === key
            ? {
                ...ln,
                ingredienteId: id,
                nombre: op?.titulo || id,
              }
            : ln,
        ),
      }));
    },
    [opcionProductoDe],
  );

  const addLinea = useCallback((): string => {
    const key = nuevaKey();
    setForm((prev) => ({
      ...prev,
      lineas: [
        ...prev.lineas,
        { key, ingredienteId: '', nombre: '', cantidad: '', unidad: 'KG', mermaPct: '0' },
      ],
    }));
    return key;
  }, []);

  const quitarLinea = useCallback((key: string) => {
    setForm((prev) => ({ ...prev, lineas: prev.lineas.filter((ln) => ln.key !== key) }));
  }, []);

  const patchLinea = useCallback((key: string, patch: Partial<LineaForm>) => {
    setForm((prev) => ({
      ...prev,
      lineas: prev.lineas.map((ln) => (ln.key === key ? { ...ln, ...patch } : ln)),
    }));
  }, []);

  const adjuntarFoto = useCallback(() => {
    if (!puedeEditar || !recetaGuardada || !form.productoId) return;
    if (Platform.OS !== 'web') {
      setErrorForm('Adjuntar foto está disponible en web');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      setImagenBusy(true);
      setErrorForm(null);
      const fd = new FormData();
      fd.append('file', file);
      void (async () => {
        try {
          const res = await apiFetch(`/api/escandallos/${encodeURIComponent(form.productoId)}/imagen`, {
            method: 'POST',
            body: fd,
          });
          const data = (await res.json().catch(() => ({}))) as { error?: string; imagen_key?: string };
          if (!res.ok) {
            setErrorForm(data.error || 'No se pudo subir la foto');
            return;
          }
          setForm((prev) => ({ ...prev, imagen_key: String(data.imagen_key || prev.imagen_key || '') }));
          await cargarImagenUrl(form.productoId);
        } catch (e) {
          setErrorForm(errorMessage(e, 'Error al subir la foto'));
        } finally {
          setImagenBusy(false);
        }
      })();
    };
    input.click();
  }, [puedeEditar, recetaGuardada, form.productoId, cargarImagenUrl]);

  const quitarFoto = useCallback(async () => {
    if (!puedeEditar || !recetaGuardada || !form.productoId) return;
    setImagenBusy(true);
    setErrorForm(null);
    try {
      const res = await apiFetch(`/api/escandallos/${encodeURIComponent(form.productoId)}/imagen`, {
        method: 'DELETE',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErrorForm(data.error || 'No se pudo quitar la foto');
        return;
      }
      setForm((prev) => ({ ...prev, imagen_key: '' }));
      setImagenUrl(null);
    } catch (e) {
      setErrorForm(errorMessage(e, 'Error al quitar la foto'));
    } finally {
      setImagenBusy(false);
    }
  }, [puedeEditar, recetaGuardada, form.productoId]);

  const guardar = useCallback(async () => {
    if (!puedeEditar) return;
    const productoId = form.productoId.trim();
    if (!productoId) {
      setErrorForm('Elige el plato (producto de venta)');
      return;
    }
    const nombre = form.nombre.trim() || productoId;
    const udReceta = normalizeUnidadEscandallo(form.udReceta) || 'UD';
    const ingredientes: Array<{
      ingredienteId: string;
      nombre: string;
      cantidad: number;
      unidad: string;
      mermaPct: number;
      orden: number;
    }> = [];

    for (let i = 0; i < form.lineas.length; i += 1) {
      const ln = form.lineas[i];
      // Líneas vacías (p. ej. creadas con Tab): no se persisten.
      if (!ln.ingredienteId.trim()) continue;
      const unidad = normalizeUnidadEscandallo(ln.unidad);
      if (!unidad) {
        setErrorForm(`Elige unidad (kg, litro o unidad) en la línea ${i + 1}`);
        return;
      }
      const cantidad = parseDecimal(ln.cantidad);
      if (cantidad == null || cantidad < 0) {
        setErrorForm(`Cantidad no válida en la línea ${i + 1} (acepta decimales con coma)`);
        return;
      }
      const merma = parseDecimal(ln.mermaPct || '0');
      if (merma == null || merma < 0 || merma > 100) {
        setErrorForm(`Merma % de la línea ${i + 1} debe estar entre 0 y 100`);
        return;
      }
      ingredientes.push({
        ingredienteId: ln.ingredienteId.trim(),
        nombre: ln.nombre.trim() || ln.ingredienteId.trim(),
        cantidad,
        unidad,
        mermaPct: merma,
        orden: ingredientes.length + 1,
      });
    }

    if (form.activo && ingredientes.length === 0) {
      setErrorForm('Añade al menos un ingrediente o desactiva la receta');
      return;
    }

    setGuardando(true);
    setErrorForm(null);
    try {
      const res = await apiFetch(`/api/escandallos/${encodeURIComponent(productoId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          nombre,
          udReceta,
          activo: form.activo,
          ingredientes,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        imagen_key?: string;
      };
      if (!res.ok) {
        setErrorForm(data.error || 'No se pudo guardar la receta');
        return;
      }
      fetchRecetas();
      setModoNuevo(false);
      setForm((prev) => ({
        ...prev,
        nombre,
        udReceta,
        productoId,
        imagen_key: data.imagen_key != null ? String(data.imagen_key) : prev.imagen_key,
      }));
      void cargarImagenUrl(productoId);
    } catch (e) {
      setErrorForm(errorMessage(e, 'Error de conexión'));
    } finally {
      setGuardando(false);
    }
  }, [puedeEditar, form, fetchRecetas, cargarImagenUrl]);

  const solicitarBorrado = useCallback(
    async (item: RecetaMeta) => {
      if (!puedeEditar) return;
      const ok = await confirmar(
        'Eliminar receta',
        `¿Eliminar la receta de ${item.productoId} · ${item.nombre}? Esta acción no se puede deshacer.`,
        { variant: 'danger', confirmarLabel: 'Eliminar' },
      );
      if (!ok) return;
      setGuardando(true);
      try {
        const res = await apiFetch(`/api/escandallos/${encodeURIComponent(item.productoId)}`, {
          method: 'DELETE',
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setError(data.error || 'No se pudo borrar la receta');
        } else {
          if (form.productoId === item.productoId) cerrarDetalle();
          fetchRecetas();
        }
      } catch (e) {
        setError(errorMessage(e, 'Error de conexión'));
      } finally {
        setGuardando(false);
      }
    },
    [puedeEditar, confirmar, fetchRecetas, form.productoId, cerrarDetalle],
  );

  const seleccionarReceta = useCallback(
    (item: RecetaMeta) => {
      void cargarDetalle(item, !puedeEditar);
    },
    [cargarDetalle, puedeEditar],
  );

  const editable = puedeEditar && !soloLectura && !guardando && !loadingDetalle;

  const lineaKeys = useMemo(() => form.lineas.map((ln) => ln.key), [form.lineas]);
  useEscandalloLineasTab({
    enabled: editable && detalleAbierto && Platform.OS === 'web',
    lineaKeys,
    onAddLineaAlFinal: addLinea,
  });

  const costeLineaDe = useCallback(
    (ln: LineaForm): number => {
      const cant = parseDecimal(ln.cantidad);
      if (cant == null || cant < 0) return 0;
      const merma = parseDecimal(ln.mermaPct || '0') ?? 0;
      const prod = getProducto(ln.ingredienteId.trim());
      const unit = costeUnitarioProducto(prod, warehouseId);
      return cant * (1 + merma / 100) * unit;
    },
    [getProducto, warehouseId],
  );

  if (!puedeVer) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock" size={48} color="#94a3b8" />
        <Text style={styles.noPermisoText}>No tienes permiso para ver escandallos</Text>
        <TouchableOpacity
          style={styles.backLink}
          onPress={() => router.push('/compras')}
          accessibilityLabel="Volver a compras"
        >
          <MaterialIcons name="arrow-back" size={18} color="#0ea5e9" />
          <Text style={styles.backLinkText}>Volver a compras</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const renderToolbarLista = () => (
    <View style={[styles.toolbar, shouldStackPanels && styles.toolbarStack]}>
      <View style={styles.toolbarLeft}>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => router.push('/compras')}
          accessibilityLabel="Volver a compras"
        >
          <MaterialIcons name="arrow-back" size={20} color="#334155" />
        </TouchableOpacity>
        <View style={styles.toolbarTitles}>
          <Text style={styles.title}>Escandallos</Text>
          <Text style={styles.subtitle}>
            {loading ? 'Cargando…' : `${recetasFiltradas.length} receta${recetasFiltradas.length === 1 ? '' : 's'}`}
          </Text>
        </View>
      </View>
      <View style={[styles.toolbarRight, shouldStackPanels && styles.toolbarRightStack]}>
        <View style={styles.searchBox}>
          <MaterialIcons name="search" size={16} color="#94a3b8" />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar receta…"
            placeholderTextColor="#94a3b8"
            autoCorrect={false}
          />
          {filtroBusqueda ? (
            <TouchableOpacity onPress={() => setFiltroBusqueda('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MaterialIcons name="close" size={16} color="#94a3b8" />
            </TouchableOpacity>
          ) : null}
        </View>
        {puedeEditar ? (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={abrirNuevo}
            disabled={guardando}
            accessibilityLabel="Nueva receta"
          >
            <MaterialIcons name={ICONS.add} size={ICON_SIZE} color="#fff" />
            <Text style={styles.primaryBtnText}>Nueva receta</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={fetchRecetas}
          disabled={loading}
          accessibilityLabel="Refrescar"
        >
          {loading ? (
            <ActivityIndicator size="small" color="#0ea5e9" />
          ) : (
            <MaterialIcons name="refresh" size={ICON_SIZE} color="#0ea5e9" />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderFiltroCoste = () => {
    const pastillas: Array<{ id: CategoriaCosteId | null; label: string; count: number }> = [
      { id: null, label: 'Todos', count: recetas.length },
      ...CATEGORIAS_COSTE_ORDEN.map((id) => {
        const cat = categoriaCostePorId(id);
        return { id, label: cat.labelCorto, count: conteoPorCategoria[id] };
      }),
    ];
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filtroCosteScroll}
        contentContainerStyle={styles.filtroCosteRow}
        keyboardShouldPersistTaps="handled"
      >
        {pastillas.map((p) => {
          const sel = filtroCategoriaCoste === p.id;
          const colores = p.id != null ? categoriaCostePorId(p.id).colores : null;
          return (
            <TouchableOpacity
              key={p.id ?? 'todos'}
              style={[
                styles.filtroCosteChip,
                sel && styles.filtroCosteChipSel,
                sel && colores
                  ? {
                      backgroundColor: colores.backgroundColor,
                      borderColor: colores.borderColor,
                    }
                  : null,
              ]}
              onPress={() => setFiltroCategoriaCoste(p.id)}
              accessibilityLabel={`Filtrar por ${p.label}`}
              accessibilityState={{ selected: sel }}
            >
              <Text
                style={[
                  styles.filtroCosteChipText,
                  sel && styles.filtroCosteChipTextSel,
                  sel && colores ? { color: colores.color } : null,
                ]}
              >
                {`${p.label} (${p.count})`}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    );
  };

  const renderLista = () => (
    <View style={styles.panel}>
      {renderToolbarLista()}
      {renderFiltroCoste()}
      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{error}</Text>
          <TouchableOpacity onPress={fetchRecetas}>
            <Text style={styles.retryText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {loading && recetas.length === 0 ? (
        <View style={styles.listaEstado}>
          <ActivityIndicator size="large" color="#0ea5e9" />
        </View>
      ) : recetasFiltradas.length === 0 ? (
        <View style={styles.listaEstado}>
          <MaterialIcons name="restaurant-menu" size={36} color="#cbd5e1" />
          <Text style={styles.listaEstadoText}>
            {filtroBusqueda.trim() || filtroCategoriaCoste
              ? 'Ninguna receta coincide con el filtro'
              : 'No hay recetas. Pulsa crear para añadir una.'}
          </Text>
        </View>
      ) : (
        <ScrollView
          style={styles.listaScroll}
          contentContainerStyle={styles.listaScrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {recetasFiltradas.map((item) => {
            const sel = detalleAbierto && !modoNuevo && form.productoId === item.productoId;
            const on = item.activo !== false;
            const catCoste = categoriaDeReceta(item);
            const costeImp = costeTeoricoDeReceta(item);
            return (
              <TouchableOpacity
                key={item.productoId}
                style={[styles.listaRow, sel && styles.listaRowSel]}
                onPress={() => seleccionarReceta(item)}
                activeOpacity={0.7}
                accessibilityLabel={`Receta ${item.nombre}`}
              >
                <View style={styles.listaRowMain}>
                  <Text style={[styles.listaNombre, sel && styles.listaNombreSel]} numberOfLines={1}>
                    {item.nombre || '—'}
                  </Text>
                  <View style={styles.listaMetaRow}>
                    <View style={[styles.badge, on ? styles.badgeActivo : styles.badgeInactivo]}>
                      <Text
                        style={[
                          styles.badgeText,
                          on ? styles.badgeTextoActivo : styles.badgeTextoInactivo,
                        ]}
                      >
                        {on ? 'Activo' : 'Inactivo'}
                      </Text>
                    </View>
                    <Text style={styles.listaId} numberOfLines={1}>
                      ID {item.productoId} · {labelUnidadEscandallo(item.udReceta)}
                    </Text>
                  </View>
                </View>
                <View
                  style={[
                    styles.badgeCosteAlto,
                    {
                      backgroundColor: catCoste.colores.backgroundColor,
                      borderColor: catCoste.colores.borderColor,
                    },
                  ]}
                >
                  <Text style={[styles.badgeCosteLabel, { color: catCoste.colores.color }]}>
                    {catCoste.labelCorto}
                  </Text>
                  <Text style={[styles.badgeCosteImporte, { color: catCoste.colores.color }]}>
                    {costeImp > 0 ? formatMoneda(costeImp) : '—'}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );

  const renderFotoCabecera = () => {
    if (modoNuevo && !recetaGuardada) {
      return (
        <View style={styles.fotoBox}>
          <View style={styles.fotoPlaceholder}>
            <MaterialIcons name="image" size={22} color="#cbd5e1" />
          </View>
          <Text style={styles.fotoHint}>Guarda la receta antes de adjuntar foto</Text>
        </View>
      );
    }
    if (!form.productoId || !recetaGuardada) return null;

    return (
      <View style={styles.fotoBox}>
        {imagenUrl ? (
          <Image source={{ uri: imagenUrl }} style={styles.fotoThumb} resizeMode="cover" />
        ) : (
          <View style={styles.fotoPlaceholder}>
            {imagenBusy ? (
              <ActivityIndicator size="small" color="#0ea5e9" />
            ) : (
              <MaterialIcons name="image" size={22} color="#cbd5e1" />
            )}
          </View>
        )}
        {puedeEditar && !soloLectura ? (
          <View style={styles.fotoActions}>
            <TouchableOpacity
              style={styles.fotoBtn}
              onPress={adjuntarFoto}
              disabled={imagenBusy || guardando}
              accessibilityLabel="Adjuntar foto"
            >
              <Text style={styles.fotoBtnText}>Adjuntar foto</Text>
            </TouchableOpacity>
            {imagenUrl || form.imagen_key ? (
              <TouchableOpacity
                style={[styles.fotoBtn, styles.fotoBtnDanger]}
                onPress={() => void quitarFoto()}
                disabled={imagenBusy || guardando}
                accessibilityLabel="Quitar foto"
              >
                <Text style={styles.fotoBtnDangerText}>Quitar foto</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  const margenEstilo =
    margenInfo?.pct != null ? estiloMargenPorPct(margenInfo.pct) : null;
  const categoriaCosteKpi = categoriaCosteTeorico(kpis.coste);

  const renderKpis = () => (
    <View style={styles.kpiBlock}>
      <View style={styles.kpiChips}>
        <View style={styles.kpiChip}>
          <Text style={styles.kpiLabel}>Peso</Text>
          <Text style={styles.kpiValue}>
            {kpis.kgTotal > 0 ? `${formatCantidadKpi(kpis.kgTotal)} kg` : '—'}
          </Text>
        </View>
        <View style={styles.kpiChip}>
          <Text style={styles.kpiLabel}>Volumen</Text>
          <Text style={styles.kpiValue}>
            {kpis.lTotal > 0 ? `${formatCantidadKpi(kpis.lTotal)} L` : '—'}
          </Text>
        </View>
        <View style={styles.kpiChip}>
          <Text style={styles.kpiLabel}>Unidades</Text>
          <Text style={styles.kpiValue}>
            {kpis.udTotal > 0 ? `${formatCantidadKpi(kpis.udTotal, 2)} ud` : '—'}
          </Text>
        </View>
        <View style={[styles.kpiChip, styles.kpiChipCoste]}>
          <Text style={styles.kpiLabel}>Coste teórico</Text>
          <Text style={styles.kpiValue}>
            {kpis.coste > 0 ? formatMoneda(kpis.coste) : 'Sin coste'}
          </Text>
          <View
            style={[
              styles.kpiCosteCatChip,
              {
                backgroundColor: categoriaCosteKpi.colores.backgroundColor,
                borderColor: categoriaCosteKpi.colores.borderColor,
              },
            ]}
          >
            <Text style={[styles.kpiCosteCatText, { color: categoriaCosteKpi.colores.color }]}>
              {categoriaCosteKpi.labelCorto}
            </Text>
          </View>
        </View>
        {localSeleccionado ? (
          <>
            <View style={[styles.kpiChip, styles.kpiChipVenta]}>
              <Text style={styles.kpiLabel}>P. venta</Text>
              <Text style={styles.kpiValue}>
                {ventaInfo.sinSync
                  ? '—'
                  : ventaInfo.precio != null
                    ? formatMoneda(ventaInfo.precio)
                    : '—'}
              </Text>
            </View>
            {margenInfo?.margen != null && margenEstilo ? (
              <SoftPulseBorderWrap colors={margenEstilo.pulse} borderRadius={8}>
                <View style={[styles.kpiChip, styles.kpiChipMargenInner, margenEstilo.chip]}>
                  <Text style={[styles.kpiLabel, margenEstilo.texto]}>Margen</Text>
                  <Text style={[styles.kpiValue, margenEstilo.texto]}>
                    {`${formatMoneda(margenInfo.margen)}${
                      margenInfo.pct != null ? ` · ${Math.round(margenInfo.pct)}%` : ''
                    }`}
                  </Text>
                  <Text style={[styles.kpiNota, margenEstilo.texto]}>
                    {`Neto ${formatMoneda(margenInfo.neto)} (sin IVA ${IVA_VENTA}%)`}
                  </Text>
                </View>
              </SoftPulseBorderWrap>
            ) : null}
          </>
        ) : null}
      </View>
      {opcionesLocales.length > 0 ? (
        <View style={[styles.almacenRow, shouldStackPanels && styles.almacenRowStack]}>
          <SelectorDesplegable
            label="Local"
            placeholder="Local…"
            icono="storefront"
            opciones={opcionesLocales}
            valorId={localId}
            onSeleccionar={setLocalId}
            tituloLista="Local (tarifa y almacén)"
            compact
            style={styles.localSelector}
          />
          {almacenesLocal.length > 1 ? (
            <SelectorDesplegable
              label="Almacén coste"
              placeholder="CostPrice global…"
              icono="store"
              opciones={[{ id: '__global__', titulo: 'CostPrice global' }, ...almacenesCoste]}
              valorId={warehouseId ?? '__global__'}
              onSeleccionar={(id) => setWarehouseId(id === '__global__' ? null : id)}
              tituloLista="Almacén para CostPrices"
              compact
              style={styles.almacenSelector}
            />
          ) : null}
        </View>
      ) : null}
      {localSeleccionado ? (
        <>
          {ventaInfo.sinTarifaLocal ? (
            <Text style={styles.kpiNota}>Asigna la tarifa de este local en Puntos de venta</Text>
          ) : ventaInfo.sinSync ? (
            <Text style={styles.kpiNota}>Sincroniza productos Ágora para precios de venta</Text>
          ) : ventaInfo.tienePrices && ventaInfo.precio == null ? (
            <Text style={styles.kpiNota}>Sin precio para la tarifa de este local</Text>
          ) : form.productoId.trim() ? (
            <Text style={styles.kpiNota}>
              {`P. venta según tarifa ${ventaInfo.priceListId}${
                ventaInfo.saleCenterNombre ? ` · ${ventaInfo.saleCenterNombre}` : ''
              }`}
            </Text>
          ) : null}
          {almacenesLocal.length === 0 ? (
            <Text style={styles.kpiNota}>
              Este local no tiene almacén asociado: coste con CostPrice global
            </Text>
          ) : null}
          {kpis.lineasOtroAlmacen > 0 ? (
            <Text style={styles.kpiNota}>
              {`${kpis.lineasOtroAlmacen} ingrediente${
                kpis.lineasOtroAlmacen === 1 ? '' : 's'
              } sin precio en este almacén: coste de otro almacén`}
            </Text>
          ) : null}
        </>
      ) : errorLocales ? (
        <Text style={styles.kpiNota}>No se pudieron cargar los locales</Text>
      ) : (
        <Text style={styles.kpiNota}>Elige un local para ver precio de venta</Text>
      )}
    </View>
  );

  const renderLinea = (ln: LineaForm, idx: number) => {
    const costeLn = costeLineaDe(ln);
    const compra =
      comprasCtx[ln.ingredienteId.trim()] ||
      comprasCtx[stripLeadingZerosId(ln.ingredienteId.trim())];
    const webPropsCampo = (campo: 'ing' | 'cant' | 'ud' | 'merma') =>
      Platform.OS === 'web'
        ? ({ dataSet: { escCampo: escCampoId(ln.key, campo) } } as object)
        : {};
    const webNoTab = Platform.OS === 'web' ? ({ tabIndex: -1 } as object) : {};

    return (
      <View
        key={ln.key}
        style={[
          styles.tablaRow,
          apilarLinea && styles.tablaRowStack,
          idx % 2 === 1 && !apilarLinea && styles.tablaRowAlt,
          { zIndex: form.lineas.length - idx },
        ]}
      >
        <View style={[styles.tablaCellOjo, apilarLinea && styles.tablaCellOjoStack]}>
          <TouchableOpacity
            style={[styles.ojoBtn, !ln.ingredienteId.trim() && styles.ojoBtnDisabled]}
            onPress={() => {
              const id = ln.ingredienteId.trim();
              if (!id) return;
              setComprasModal({
                productId: id,
                productName: ln.nombre || id,
                ...rangoUltimos6Meses(),
              });
            }}
            disabled={!ln.ingredienteId.trim()}
            accessibilityLabel="Ver compras del ingrediente"
            {...webNoTab}
          >
            <MaterialIcons
              name="visibility"
              size={18}
              color={ln.ingredienteId.trim() ? '#0ea5e9' : '#cbd5e1'}
            />
          </TouchableOpacity>
        </View>

        <View style={[styles.tablaCellIng, apilarLinea && styles.flex1]}>
          <SelectorDesplegable
            label={apilarLinea ? `Ingrediente ${idx + 1}` : undefined}
            placeholder="Buscar ingrediente…"
            icono="inventory-2"
            opciones={opcionesConId(ln.ingredienteId)}
            valorId={ln.ingredienteId || null}
            onSeleccionar={(id) => elegirIngrediente(ln.key, id)}
            tituloLista="Ingredientes Ágora"
            buscador
            buscadorPlaceholder="Nombre o ID…"
            loading={loadingProductos}
            disabled={!editable}
            compact
            limiteResultados={80}
            minCharsBusqueda={2}
            webCampoId={editable ? escCampoId(ln.key, 'ing') : undefined}
            vacioTexto={
              errorProductos
                ? 'No se pudieron cargar los productos'
                : 'No hay productos activos'
            }
          />
          {ln.ingredienteId.trim() ? (
            <Text style={styles.lineaCompraCtx} numberOfLines={1}>
              {textoCompraContexto(compra)}
            </Text>
          ) : null}
        </View>

        <View style={[styles.tablaCellCant, apilarLinea && styles.flex1]}>
          {apilarLinea ? <Text style={styles.formLabel}>Cantidad</Text> : null}
          <TextInput
            style={[styles.tablaInput, !editable && styles.formInputReadonly]}
            value={ln.cantidad}
            onChangeText={(t) => patchLinea(ln.key, { cantidad: t })}
            placeholder="0"
            placeholderTextColor="#94a3b8"
            keyboardType="decimal-pad"
            editable={editable}
            {...webPropsCampo('cant')}
          />
        </View>

        <View style={[styles.tablaCellUd, apilarLinea && styles.flex1]}>
          <SelectorDesplegable
            label={apilarLinea ? 'Unidad' : undefined}
            placeholder="Ud"
            opciones={UNIDADES_COMPACTAS}
            valorId={ln.unidad || null}
            onSeleccionar={(id) => patchLinea(ln.key, { unidad: id })}
            tituloLista="Unidad"
            disabled={!editable}
            compact
            sinIconoTrigger
            webCampoId={editable ? escCampoId(ln.key, 'ud') : undefined}
          />
        </View>

        <View style={[styles.tablaCellMerma, apilarLinea && styles.flex1]}>
          {apilarLinea ? <Text style={styles.formLabel}>Merma %</Text> : null}
          <TextInput
            style={[styles.tablaInput, !editable && styles.formInputReadonly]}
            value={ln.mermaPct}
            onChangeText={(t) => patchLinea(ln.key, { mermaPct: t })}
            placeholder="0"
            placeholderTextColor="#94a3b8"
            keyboardType="decimal-pad"
            editable={editable}
            {...webPropsCampo('merma')}
          />
        </View>

        <View style={[styles.tablaCellCoste, apilarLinea && styles.flex1]}>
          {apilarLinea ? <Text style={styles.formLabel}>Coste</Text> : null}
          <Text style={styles.tablaCosteTxt} numberOfLines={1} accessible={false}>
            {costeLn > 0 ? formatMoneda(costeLn) : '—'}
          </Text>
        </View>

        {editable ? (
          <TouchableOpacity
            style={styles.tablaQuitar}
            onPress={() => quitarLinea(ln.key)}
            accessibilityLabel="Quitar línea"
            {...webNoTab}
          >
            <MaterialIcons name="close" size={18} color="#dc2626" />
          </TouchableOpacity>
        ) : (
          <View style={styles.tablaQuitarSpacer} />
        )}
      </View>
    );
  };

  const renderDetalle = () => {
    if (!detalleAbierto) {
      return (
        <View style={[styles.panel, styles.detalleVacio]}>
          <MaterialIcons name="menu-book" size={40} color="#cbd5e1" />
          <Text style={styles.detalleVacioTitle}>Selecciona una receta</Text>
          <Text style={styles.detalleVacioText}>
            Elige un plato a la izquierda o crea una nueva receta.
          </Text>
        </View>
      );
    }

    return (
      <KeyboardAvoidingView
        style={styles.panel}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.detalleHeader}>
          {shouldStackPanels ? (
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={cerrarDetalle}
              disabled={guardando}
              accessibilityLabel="Volver al listado"
            >
              <MaterialIcons name="arrow-back" size={20} color="#334155" />
            </TouchableOpacity>
          ) : null}
          <View style={styles.detalleHeaderTitles}>
            <Text style={styles.detalleTitle} numberOfLines={1}>
              {soloLectura ? 'Ver receta' : modoNuevo ? 'Nueva receta' : 'Editar receta'}
            </Text>
            {!modoNuevo && form.productoId ? (
              <Text style={styles.detalleSub} numberOfLines={1}>
                {form.productoId} · {form.nombre || '—'}
              </Text>
            ) : null}
          </View>
          {renderFotoCabecera()}
          {!shouldStackPanels ? (
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={cerrarDetalle}
              disabled={guardando}
              accessibilityLabel="Cerrar detalle"
            >
              <MaterialIcons name="close" size={20} color="#64748b" />
            </TouchableOpacity>
          ) : null}
        </View>

        {loadingDetalle ? (
          <View style={styles.detalleLoading}>
            <ActivityIndicator size="large" color="#0ea5e9" />
            <Text style={styles.detalleLoadingText}>Cargando receta…</Text>
          </View>
        ) : (
          <ScrollView
            style={styles.detalleScroll}
            contentContainerStyle={styles.detalleScrollContent}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
            {modoNuevo ? (
              <View style={styles.formGroup}>
                <SelectorDesplegable
                  label="Plato (producto de venta)"
                  placeholder="Buscar por nombre o ID…"
                  icono="restaurant"
                  opciones={opcionesConId(form.productoId)}
                  valorId={form.productoId || null}
                  onSeleccionar={elegirPlato}
                  tituloLista="Productos Ágora"
                  buscador
                  buscadorPlaceholder="Nombre o ID…"
                  loading={loadingProductos}
                  disabled={!editable}
                  compact
                  limiteResultados={80}
                  minCharsBusqueda={2}
                  vacioTexto={
                    errorProductos
                      ? 'No se pudieron cargar los productos'
                      : 'No hay productos. Recarga el catálogo Ágora.'
                  }
                />
              </View>
            ) : (
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>Plato</Text>
                <Text style={styles.platoFijo}>
                  {form.productoId} · {form.nombre || '—'}
                </Text>
              </View>
            )}

            <View style={[styles.formRow, apilarLinea && styles.formRowStack]}>
              <View style={[styles.formGroup, styles.flex1]}>
                <SelectorDesplegable
                  label="Ud. receta"
                  placeholder="Elige unidad…"
                  icono="straighten"
                  opciones={[...UNIDADES_ESCANDALLO]}
                  valorId={form.udReceta || null}
                  onSeleccionar={(id) => setForm((p) => ({ ...p, udReceta: id }))}
                  tituloLista="Unidad de receta"
                  disabled={!editable}
                  compact
                />
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.formLabel}>Activo</Text>
                <Switch
                  value={form.activo}
                  onValueChange={(v) => setForm((p) => ({ ...p, activo: v }))}
                  disabled={!editable}
                  trackColor={{ false: '#e2e8f0', true: '#0ea5e9' }}
                  thumbColor="#fff"
                />
              </View>
            </View>

            {renderKpis()}

            <View style={styles.lineasHeader}>
              <Text style={styles.lineasTitle}>Ingredientes</Text>
              {editable ? (
                <TouchableOpacity
                  style={styles.addLineaBtn}
                  onPress={addLinea}
                  accessibilityLabel="Añadir ingrediente"
                >
                  <MaterialIcons name="add" size={18} color="#0ea5e9" />
                  <Text style={styles.addLineaText}>Añadir línea</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {form.lineas.length === 0 ? (
              <Text style={styles.lineasVacio}>
                {editable
                  ? 'Añade ingredientes de Ágora a la receta. Con Tab en la última celda se crea una línea nueva.'
                  : 'Esta receta no tiene ingredientes.'}
              </Text>
            ) : (
              <View style={[styles.tablaWrap, apilarLinea && styles.tablaWrapStack]}>
                {!apilarLinea ? (
                  <View style={styles.tablaHead}>
                    <View style={styles.tablaCellOjo} />
                    <Text style={[styles.tablaHeadTxt, styles.tablaCellIng]}>Ingrediente</Text>
                    <Text style={[styles.tablaHeadTxt, styles.tablaCellCant]}>Cant.</Text>
                    <Text style={[styles.tablaHeadTxt, styles.tablaCellUd]}>Ud</Text>
                    <Text style={[styles.tablaHeadTxt, styles.tablaCellMerma]}>Merma</Text>
                    <Text style={[styles.tablaHeadTxt, styles.tablaCellCoste]}>Coste</Text>
                    <View style={styles.tablaQuitarSpacer} />
                  </View>
                ) : null}
                {form.lineas.map((ln, idx) => renderLinea(ln, idx))}
              </View>
            )}
          </ScrollView>
        )}

        {errorForm ? <Text style={styles.formError}>{errorForm}</Text> : null}

        <View style={styles.detalleFooter}>
          {!modoNuevo && puedeEditar && form.productoId ? (
            <TouchableOpacity
              style={[styles.footerBtn, styles.footerBtnDanger]}
              onPress={() =>
                void solicitarBorrado({
                  productoId: form.productoId,
                  nombre: form.nombre,
                  udReceta: form.udReceta,
                  activo: form.activo,
                })
              }
              disabled={guardando || loadingDetalle}
              accessibilityLabel="Borrar receta"
            >
              <MaterialIcons name={ICONS.delete} size={ICON_SIZE} color="#dc2626" />
              <Text style={styles.footerBtnDangerText}>Borrar</Text>
            </TouchableOpacity>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          <View style={styles.footerRight}>
            {shouldStackPanels ? (
              <TouchableOpacity
                style={styles.footerBtn}
                onPress={cerrarDetalle}
                disabled={guardando}
              >
                <Text style={styles.footerBtnText}>{soloLectura ? 'Cerrar' : 'Volver'}</Text>
              </TouchableOpacity>
            ) : null}
            {editable ? (
              <TouchableOpacity
                style={[styles.footerBtn, styles.footerBtnPrimary]}
                onPress={() => void guardar()}
                disabled={guardando || loadingDetalle}
              >
                {guardando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.footerBtnTextPrimary}>Guardar</Text>
                )}
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  };

  return (
    <View style={styles.container}>
      {splitView ? (
        <View style={styles.splitRow}>
          <View style={styles.splitLista}>{renderLista()}</View>
          <View style={styles.splitDetalle}>{renderDetalle()}</View>
        </View>
      ) : detalleAbierto ? (
        <View style={styles.detalleFull}>{renderDetalle()}</View>
      ) : (
        renderLista()
      )}
      {ConfirmarView}
      {comprasModal ? (
        <ComprasProveedorModal
          visible
          onClose={() => setComprasModal(null)}
          productId={comprasModal.productId}
          productName={comprasModal.productName}
          fechaInicio={comprasModal.fechaInicio}
          fechaFin={comprasModal.fechaFin}
        />
      ) : null}
    </View>
  );
}

type RecetaDetalleLike = {
  productoId?: string;
  nombre?: string;
  udReceta?: string;
  activo?: boolean;
  imagen_key?: string;
  ingredientes?: Array<{
    ingredienteId?: string;
    nombre?: string;
    cantidad?: number;
    unidad?: string;
    mermaPct?: number;
    orden?: number;
  }>;
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#e2e8f0', padding: 12 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 20 },
  noPermisoText: { fontSize: 14, color: '#64748b', textAlign: 'center' },
  backLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, minHeight: MIN_TOUCH },
  backLinkText: { fontSize: 13, color: '#0ea5e9', fontWeight: '500' },

  splitRow: { flex: 1, flexDirection: 'row', gap: 12, minHeight: 0 },
  splitLista: { flex: 1, minWidth: 0, minHeight: 0 },
  splitDetalle: { flex: 1, minWidth: 0, minHeight: 0 },
  detalleFull: { flex: 1, minHeight: 0 },

  panel: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
    minHeight: 0,
  },

  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  toolbarStack: { flexDirection: 'column', alignItems: 'stretch' },
  toolbarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  toolbarTitles: { flexShrink: 1 },
  toolbarRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
  toolbarRightStack: { justifyContent: 'flex-start' },
  title: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 12, color: '#64748b', marginTop: 1 },

  iconBtn: {
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 12,
    minHeight: MIN_TOUCH,
    borderRadius: 8,
  },
  primaryBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#fff',
    paddingHorizontal: 10,
    minHeight: MIN_TOUCH,
    minWidth: 160,
    flexGrow: 1,
    maxWidth: 280,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: '#1e293b',
    paddingVertical: Platform.OS === 'web' ? 4 : 0,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },

  filtroCosteScroll: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  filtroCosteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  filtroCosteChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
  },
  filtroCosteChipSel: {
    borderColor: '#0ea5e9',
    backgroundColor: '#f0f9ff',
  },
  filtroCosteChipText: { fontSize: 11, fontWeight: '500', color: '#64748b' },
  filtroCosteChipTextSel: { fontWeight: '700', color: '#0369a1' },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#fef2f2',
  },
  errorBannerText: { flex: 1, fontSize: 12, color: '#dc2626' },
  retryText: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },

  listaScroll: { flex: 1, position: 'relative', zIndex: 0 },
  listaScrollContent: { padding: 8, gap: 6, paddingBottom: 20 },
  listaEstado: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  listaEstadoText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  listaRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    minHeight: MIN_TOUCH,
  },
  listaRowSel: { borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  listaRowMain: { flex: 1, minWidth: 0, justifyContent: 'center', gap: 4 },
  listaNombre: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  listaNombreSel: { color: '#0369a1' },
  listaMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    minWidth: 0,
  },
  listaId: { fontSize: 11, color: '#64748b', flexShrink: 1 },
  badgeCosteAlto: {
    minWidth: 72,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  badgeCosteLabel: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  badgeCosteImporte: { fontSize: 12, fontWeight: '700', marginTop: 2 },

  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 10, fontWeight: '600' },
  badgeActivo: { backgroundColor: '#dcfce7' },
  badgeInactivo: { backgroundColor: '#fee2e2' },
  badgeTextoActivo: { color: '#16a34a' },
  badgeTextoInactivo: { color: '#dc2626' },

  detalleVacio: { alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
  detalleVacioTitle: { fontSize: 15, fontWeight: '600', color: '#334155' },
  detalleVacioText: { fontSize: 13, color: '#64748b', textAlign: 'center', maxWidth: 280 },

  detalleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  detalleHeaderTitles: { flex: 1, minWidth: 0 },
  detalleTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  detalleSub: { fontSize: 12, color: '#64748b', marginTop: 1 },

  fotoBox: { alignItems: 'center', gap: 4, maxWidth: 120 },
  fotoThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  fotoPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fotoHint: { fontSize: 10, color: '#94a3b8', textAlign: 'center', maxWidth: 110 },
  fotoActions: { flexDirection: 'column', gap: 2, alignItems: 'stretch' },
  fotoBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  fotoBtnText: { fontSize: 10, fontWeight: '600', color: '#0ea5e9', textAlign: 'center' },
  fotoBtnDanger: {},
  fotoBtnDangerText: { fontSize: 10, fontWeight: '600', color: '#dc2626', textAlign: 'center' },

  detalleLoading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  detalleLoadingText: { fontSize: 13, color: '#64748b' },
  detalleScroll: { flex: 1, position: 'relative', zIndex: 0 },
  detalleScrollContent: { padding: 12, paddingBottom: 24 },

  formGroup: { marginBottom: 12 },
  formRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 16, marginBottom: 8 },
  formRowStack: { flexDirection: 'column', alignItems: 'stretch' },
  flex1: { flex: 1 },
  formLabel: { fontSize: 11, fontWeight: '500', color: '#475569', marginBottom: 4 },
  formInputReadonly: { backgroundColor: '#f1f5f9', color: '#64748b' },
  platoFijo: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0f172a',
    paddingVertical: 8,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingBottom: 8,
    minHeight: MIN_TOUCH,
  },

  kpiBlock: { marginBottom: 12, gap: 6 },
  kpiChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kpiChip: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 88,
  },
  kpiChipCoste: { backgroundColor: '#f0f9ff', borderColor: '#bae6fd' },
  kpiCosteCatChip: {
    marginTop: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  kpiCosteCatText: { fontSize: 10, fontWeight: '700' },
  kpiChipVenta: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  kpiChipMargenInner: { borderWidth: 0 },
  kpiChipMargenAlto: { backgroundColor: '#f0fdf4' },
  kpiChipMargenMedio: { backgroundColor: '#fffbeb' },
  kpiChipMargenBajo: { backgroundColor: '#fff7ed' },
  kpiChipMargenCritico: { backgroundColor: '#fef2f2' },
  kpiTextoMargenAlto: { color: '#166534' },
  kpiTextoMargenMedio: { color: '#92400e' },
  kpiTextoMargenBajo: { color: '#9a3412' },
  kpiTextoMargenCritico: { color: '#991b1b' },
  kpiLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase' },
  kpiValue: { fontSize: 13, fontWeight: '700', color: '#0f172a', marginTop: 2 },
  kpiNota: { fontSize: 11, color: '#94a3b8' },
  almacenRow: { marginTop: 4, flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' },
  almacenRowStack: { flexDirection: 'column', alignItems: 'stretch' },
  almacenSelector: { maxWidth: 220, minWidth: 160 },
  localSelector: { maxWidth: 220, minWidth: 160 },

  lineasHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    marginBottom: 8,
  },
  lineasTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  addLineaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    minHeight: MIN_TOUCH,
  },
  addLineaText: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  lineasVacio: { fontSize: 13, color: '#64748b', marginBottom: 12 },

  tablaWrap: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    backgroundColor: '#fff',
    overflow: 'visible',
    marginBottom: 8,
  },
  tablaWrapStack: {
    borderWidth: 0,
    backgroundColor: 'transparent',
    gap: 8,
  },
  tablaHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#f1f5f9',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  tablaHeadTxt: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  tablaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
    position: 'relative',
    backgroundColor: '#fff',
  },
  tablaRowAlt: { backgroundColor: '#f8fafc' },
  tablaRowStack: {
    flexDirection: 'column',
    alignItems: 'stretch',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    borderBottomWidth: 1,
    padding: 10,
    backgroundColor: '#f8fafc',
    gap: 8,
  },
  tablaCellOjo: {
    width: MIN_TOUCH,
    flexShrink: 0,
    alignItems: 'center',
    paddingTop: 2,
  },
  tablaCellOjoStack: { alignSelf: 'flex-start' },
  tablaCellIng: { flex: 1, minWidth: 0 },
  tablaCellCant: { width: 76 },
  tablaCellUd: { width: 72 },
  tablaCellMerma: { width: 64 },
  tablaCellCoste: {
    width: 78,
    justifyContent: 'center',
    minHeight: 30,
    paddingTop: 6,
  },
  tablaInput: {
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#fff',
    color: '#334155',
    minHeight: 30,
  },
  tablaCosteTxt: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'right',
  },
  tablaQuitar: {
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  tablaQuitarSpacer: { width: MIN_TOUCH, flexShrink: 0 },
  lineaCompraCtx: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.2,
  },

  ojoBtn: {
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  ojoBtnDisabled: { opacity: 0.45 },

  formError: { fontSize: 12, color: '#dc2626', paddingHorizontal: 12, paddingBottom: 6 },
  detalleFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  footerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  footerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#fff',
    minHeight: MIN_TOUCH,
    minWidth: 88,
  },
  footerBtnText: { fontSize: 13, fontWeight: '500', color: '#64748b' },
  footerBtnPrimary: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  footerBtnTextPrimary: { fontSize: 13, fontWeight: '600', color: '#fff' },
  footerBtnDanger: { borderColor: '#fecaca', backgroundColor: '#fef2f2' },
  footerBtnDangerText: { fontSize: 13, fontWeight: '600', color: '#dc2626' },
});
