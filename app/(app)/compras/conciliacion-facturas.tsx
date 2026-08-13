/**
 * Conciliación compras ↔ facturas de gasto.
 *
 * Cruza los albaranes de entrada de Ágora (Igp_ComprasAProveedor, vía
 * ComprasProveedorCache) con las facturas de gasto de IGP
 * (GET /api/facturacion/facturas?tipo=IN) agrupando por proveedor (CIF
 * normalizado, con fallback a nombre). Para cada proveedor compara el total
 * de albaranes del periodo con las facturas registradas y señala descuadres,
 * albaranes sin factura y facturas sin albarán.
 *
 * OJO — convención del modelo de facturas IN (ver factura-detalle.tsx):
 * `emisor_*` es la sociedad del GRUPO receptora del gasto y `empresa_*` es
 * el PROVEEDOR. Por eso aquí el proveedor de una factura de gasto se lee de
 * `empresa_cif` / `empresa_nombre` (no de emisor_*).
 *
 * Vínculo documental: el nº de documento del proveedor en el albarán
 * (SupplierDocumentNumber) se cruza con el nº de factura de proveedor de la
 * factura de gasto (numero_factura_proveedor).
 *
 * Importes del albarán: el TotalAmount de cada línea de Ágora es SIN impuestos
 * (el IVA va aparte en VatRate). El total con IVA del albarán sale de
 * AlbaranGrossAmount (Totals.GrossAmount del documento) y la base de
 * AlbaranNetAmount; si faltan (filas antiguas), se estiman desde las líneas.
 * La diferencia se calcula siempre con importes finales (albaranes con IVA
 * contra total factura); la base imponible se muestra como dato informativo.
 */
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  StyleSheet,
  TextInput,
  Modal,
  Linking,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useLocalToast } from '../../components/Toast';
import { useConfirmar } from '../../hooks/useConfirmar';
import * as XLSX from 'xlsx';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { useComprasProveedorCache } from '../../contexts/ComprasProveedorCache';
import { DIAS_CARGA_COMPRAS, rangoComprasDefault } from '../../lib/comprasProveedorRango';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatMoneda } from '../../utils/formatMoneda';
import { labelEstado, colorEstado } from '../../utils/facturacion';
import type { FacturaListado } from '../../types/factura';
import {
  CompraLinea,
  albaranKey,
  albaranLabel,
  fechaLineaISO,
  idNorm,
  styles,
  TOOLBAR_ICON_SIZE,
  ComprasToolbarIconBtn,
} from './comprasProveedorShared';
import { generarPdfsConciliacionDiferenciasPorEmpresa } from '../../lib/conciliacionDiferenciasPdf';

/**
 * Umbral absoluto (€) para considerar que albaranes y facturas «cuadran».
 * Por debajo o igual → cuadra (y puede promoverse a validada).
 */
const UMBRAL_CUADRA_EUR = 5;

/** Normaliza CIF/NIF para comparar (solo A–Z0–9, mayúsculas). Igual que en resumen. */
function normalizeCif(val: unknown): string {
  return String(val ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

function normNombre(val: unknown): string {
  return String(val ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Normaliza números de documento (albarán ↔ nº factura proveedor). */
function normDoc(val: unknown): string {
  return String(val ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

function formatFechaCorta(iso: string): string {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Paleta pastel estable para chips de empresa del grupo. */
const EMPRESA_CHIP_PASTEL: ReadonlyArray<{ bg: string; text: string }> = [
  { bg: '#e0f2fe', text: '#0369a1' }, // sky
  { bg: '#dcfce7', text: '#15803d' }, // green
  { bg: '#fef3c7', text: '#b45309' }, // amber
  { bg: '#fce7f3', text: '#be185d' }, // pink
  { bg: '#ede9fe', text: '#6d28d9' }, // violet
  { bg: '#ffedd5', text: '#c2410c' }, // orange
  { bg: '#ccfbf1', text: '#0f766e' }, // teal
  { bg: '#e0e7ff', text: '#3730a3' }, // indigo
  { bg: '#f3e8ff', text: '#7e22ce' }, // purple
  { bg: '#ecfccb', text: '#4d7c0f' }, // lime
];

const EMPRESA_CHIP_SIN = { bg: '#f1f5f9', text: '#64748b' };

/**
 * Color pastel determinista. Clave = nombre normalizado (prioridad) para que
 * el mismo rótulo en albaranes y facturas comparta color aunque el CIF
 * resuelto difiera (almacén vs emisor).
 */
function colorChipEmpresa(empresaCif: string, empresaNombre: string): { bg: string; text: string } {
  const nombre = (empresaNombre || '').trim();
  if (!nombre || nombre === 'Sin empresa') return EMPRESA_CHIP_SIN;
  const key = normNombre(nombre) || normalizeCif(empresaCif);
  if (!key) return EMPRESA_CHIP_SIN;
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return EMPRESA_CHIP_PASTEL[h % EMPRESA_CHIP_PASTEL.length];
}

function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

type PeriodoChip = { id: string; label: string };
const PERIODOS: PeriodoChip[] = [
  { id: 'mes', label: 'Este mes' },
  { id: 'mes_ant', label: 'Mes anterior' },
  { id: 'trimestre', label: 'Trimestre' },
  { id: 'anio', label: 'Este año' },
];

function rangoPeriodo(id: string): { desde: string; hasta: string } {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = hoy.getMonth();
  if (id === 'mes') {
    return { desde: isoLocal(new Date(y, m, 1)), hasta: isoLocal(new Date(y, m + 1, 0)) };
  }
  if (id === 'mes_ant') {
    return { desde: isoLocal(new Date(y, m - 1, 1)), hasta: isoLocal(new Date(y, m, 0)) };
  }
  if (id === 'trimestre') {
    const qStart = Math.floor(m / 3) * 3;
    return { desde: isoLocal(new Date(y, qStart, 1)), hasta: isoLocal(new Date(y, qStart + 3, 0)) };
  }
  return { desde: isoLocal(new Date(y, 0, 1)), hasta: isoLocal(new Date(y, 11, 31)) };
}

type AlbaranResumen = {
  key: string;
  label: string;
  fechaIso: string;
  numDoc: string;
  /** CIF empresa del grupo ('' si no resuelve). */
  empresaCif: string;
  /** Nombre empresa del grupo (o «Sin empresa»). */
  empresaNombre: string;
  /** Base imponible del albarán (sin IVA). */
  total: number;
  /** Total del albarán con IVA (GrossAmount del documento o estimado por líneas). */
  totalConIva: number;
  numLineas: number;
  vinculado: boolean;
  /** Líneas de producto del albarán (para el modal de detalle). */
  lineas: CompraLinea[];
};

type FacturaResumen = {
  id: string;
  numero: string;
  numeroProveedor: string;
  fechaIso: string;
  /** CIF empresa del grupo ('' si no resuelve). */
  empresaCif: string;
  /** Nombre empresa del grupo (o «Sin empresa»). */
  empresaNombre: string;
  estado: string;
  base: number;
  total: number;
  vinculada: boolean;
};

type EstadoConciliacion = 'cuadra' | 'validada' | 'leve' | 'descuadre' | 'sin_factura' | 'sin_albaran';

type NodoProveedor = {
  key: string;
  nombre: string;
  cif: string;
  /** Empresa del grupo predominante (CIF normalizado; '' si no resuelve). */
  empresaCif: string;
  /** Nombre de la empresa del grupo (o «Sin empresa»). */
  empresaNombre: string;
  albaranes: AlbaranResumen[];
  facturas: FacturaResumen[];
  /** Suma de albaranes sin IVA (base). */
  totalAlbaranesBase: number;
  /** Suma de albaranes con IVA. */
  totalAlbaranesConIva: number;
  totalFacturasBase: number;
  totalFacturasTotal: number;
  /** Diferencia albaranes con IVA − total facturas (importes finales). */
  dif: number;
  estado: EstadoConciliacion;
};

type EstadoMeta = {
  label: string;
  bg: string;
  text: string;
  orden: number;
  borderColor?: string;
  borderWidth?: number;
  boxShadow?: string;
};

const ESTADO_META: Record<EstadoConciliacion, EstadoMeta> = {
  descuadre: { label: 'Descuadre', bg: '#fee2e2', text: '#b91c1c', orden: 0 },
  sin_factura: { label: 'Sin factura', bg: '#ffedd5', text: '#c2410c', orden: 1 },
  sin_albaran: { label: 'Sin albarán', bg: '#e2e8f0', text: '#475569', orden: 2 },
  leve: { label: 'Dif. leve', bg: '#fef3c7', text: '#b45309', orden: 3 },
  cuadra: { label: 'Cuadra', bg: '#d1fae5', text: '#047857', orden: 4 },
  validada: {
    label: 'Validada',
    bg: '#065f46',
    text: '#ecfdf5',
    orden: 5,
    borderColor: '#34d399',
    borderWidth: 2,
    boxShadow: '0 0 0 1px #34d399, 0 0 8px rgba(52, 211, 153, 0.65)',
  },
};

type FiltroEstado = 'todos' | 'diferencias' | 'sin_factura' | 'sin_albaran' | 'cuadra' | 'validada';
const FILTROS_ESTADO: { id: FiltroEstado; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'diferencias', label: 'Con diferencias' },
  { id: 'sin_factura', label: 'Sin factura' },
  { id: 'sin_albaran', label: 'Sin albarán' },
  { id: 'cuadra', label: 'Cuadran' },
  { id: 'validada', label: 'Validadas' },
];

type Almacen = Record<string, string | number | undefined>;
type Empresa = Record<string, string | number | undefined>;

/** Ids especiales del filtro de empresa (el resto son `cif:<CIF>`). */
const EMPRESA_TODAS = 'todas';
const EMPRESA_SIN = 'sin';

function absorberClickFila(e: { stopPropagation?: () => void; nativeEvent?: { stopPropagation?: () => void } }) {
  if (typeof e.stopPropagation === 'function') e.stopPropagation();
  const ne = e.nativeEvent;
  if (ne && typeof ne.stopPropagation === 'function') ne.stopPropagation();
}

export default function ConciliacionFacturasScreen() {
  const router = useRouter();
  const { hasPermiso, user } = useAuth();
  const { shouldStackPanels } = useBreakpoint();
  const { show: showToast, ToastView } = useLocalToast();
  const { confirmar, ConfirmarView } = useConfirmar();
  const { compras, loading: loadingCompras, recargar } = useComprasProveedorCache();

  const [facturas, setFacturas] = useState<FacturaListado[]>([]);
  const [loadingFacturas, setLoadingFacturas] = useState(true);
  const [errorFacturas, setErrorFacturas] = useState<string | null>(null);

  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [maestrosLoading, setMaestrosLoading] = useState(true);

  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [periodoActivo, setPeriodoActivo] = useState<string | null>(null);
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>('todos');
  const [empresaFiltro, setEmpresaFiltro] = useState<string>(EMPRESA_TODAS);
  const [busqueda, setBusqueda] = useState('');
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  const [albaranModal, setAlbaranModal] = useState<AlbaranResumen | null>(null);
  /** Id de la factura cuyo adjunto se está resolviendo (spinner en la fila). */
  const [abriendoDocId, setAbriendoDocId] = useState<string | null>(null);
  const [seleccionRevision, setSeleccionRevision] = useState<Set<string>>(new Set());
  const [validandoRevision, setValidandoRevision] = useState(false);

  const puedeValidarRevision = hasPermiso('facturacion.emitir');

  // ── Comparador albaranes ↔ factura (modal dividido) ──
  const { width: winW, height: winH } = useWindowDimensions();
  const comparadorApilado = winW < 900;
  const [comparador, setComparador] = useState<NodoProveedor | null>(null);
  const [compFacturaId, setCompFacturaId] = useState<string | null>(null);
  const [compPreviewUrl, setCompPreviewUrl] = useState<string | null>(null);
  const [compPreviewLoading, setCompPreviewLoading] = useState(false);
  const [compPreviewError, setCompPreviewError] = useState<string | null>(null);
  const [exportandoPdf, setExportandoPdf] = useState(false);
  const exportandoPdfRef = useRef(false);

  const abrirComparador = useCallback((p: NodoProveedor) => {
    setComparador(p);
    // Por defecto, la primera factura vinculada; si no hay, la primera.
    const f = p.facturas.find((x) => x.vinculada) ?? p.facturas[0];
    setCompFacturaId(f ? f.id : null);
  }, []);

  const cerrarComparador = useCallback(() => {
    setComparador(null);
    setCompFacturaId(null);
    setCompPreviewUrl(null);
    setCompPreviewError(null);
  }, []);

  // Carga el adjunto de la factura seleccionada en el comparador.
  useEffect(() => {
    if (!comparador || !compFacturaId) {
      setCompPreviewUrl(null);
      setCompPreviewError(null);
      return;
    }
    let cancelado = false;
    setCompPreviewLoading(true);
    setCompPreviewUrl(null);
    setCompPreviewError(null);
    apiFetch(`/api/facturacion/facturas/${compFacturaId}/adjuntos`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelado) return;
        const url: string | undefined = (data.adjuntos ?? [])[0]?.url;
        if (url) setCompPreviewUrl(url);
        else setCompPreviewError('Esta factura no tiene documento adjunto.');
      })
      .catch((e: unknown) => {
        if (!cancelado) setCompPreviewError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelado) setCompPreviewLoading(false);
      });
    return () => {
      cancelado = true;
    };
  }, [comparador, compFacturaId]);

  /**
   * Abre el documento adjunto de la factura (mismo endpoint que "Ver documento"
   * en facturas de gasto). Si no tiene adjunto, se abre la ficha de la factura.
   */
  const abrirDocumentoFactura = useCallback(async (facturaId: string) => {
    setAbriendoDocId(facturaId);
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${facturaId}/adjuntos`);
      const data = await res.json();
      const url: string | undefined = (data.adjuntos ?? [])[0]?.url;
      if (url) {
        if (Platform.OS === 'web') window.open(url, '_blank');
        else await Linking.openURL(url);
        return;
      }
      router.push(`/facturacion/factura-detalle?id=${facturaId}&modo=editar&tipo=IN` as never);
    } catch {
      router.push(`/facturacion/factura-detalle?id=${facturaId}&modo=editar&tipo=IN` as never);
    } finally {
      setAbriendoDocId(null);
    }
  }, [router]);

  useEffect(() => {
    const { dateFrom, dateTo } = rangoComprasDefault(DIAS_CARGA_COMPRAS);
    recargar({ dateFrom, dateTo });
  }, [recargar]);

  useEffect(() => {
    let activo = true;
    setMaestrosLoading(true);
    Promise.all([
      apiFetch('/api/almacenes').then((r) => r.json()).catch(() => ({ almacenes: [] })),
      apiFetch('/api/empresas').then((r) => r.json()).catch(() => ({ empresas: [] })),
    ])
      .then(([alm, emp]) => {
        if (!activo) return;
        setAlmacenes(Array.isArray(alm?.almacenes) ? alm.almacenes : Array.isArray(alm) ? alm : []);
        setEmpresas(Array.isArray(emp?.empresas) ? emp.empresas : Array.isArray(emp) ? emp : []);
      })
      .finally(() => {
        if (activo) setMaestrosLoading(false);
      });
    return () => {
      activo = false;
    };
  }, []);

  /**
   * Resolución de empresa del grupo (mismo criterio que compras-proveedor-resumen):
   * el almacén del albarán se cruza por CIF con el maestro de empresas; la
   * factura de gasto se resuelve por su emisor (CIF o nombre de la sociedad).
   */
  const resolverEmpresaGrupo = useMemo(() => {
    const empresaPorCif = new Map<string, string>();
    const cifPorNombreEmpresa = new Map<string, string>();
    empresas.forEach((e) => {
      const cif = normalizeCif(e.Cif ?? e.cif);
      const nombre = String(e.Nombre ?? e.nombre ?? '').trim();
      if (!cif || !nombre) return;
      if (!empresaPorCif.has(cif)) empresaPorCif.set(cif, nombre);
      const nom = normNombre(nombre);
      if (nom && !cifPorNombreEmpresa.has(nom)) cifPorNombreEmpresa.set(nom, cif);
    });
    const cifPorAlmacenId = new Map<string, string>();
    const cifPorAlmacenNombre = new Map<string, string>();
    almacenes.forEach((a) => {
      const cif = normalizeCif(a.Cif ?? a.cif);
      if (!cif) return;
      const id = idNorm(a.Id != null ? String(a.Id) : undefined);
      if (id !== '__sin_id__') cifPorAlmacenId.set(id, cif);
      const nom = normNombre(a.Nombre ?? a.nombre);
      if (nom) cifPorAlmacenNombre.set(nom, cif);
    });
    return {
      /** CIF de la empresa asociada al almacén del albarán ('' si no resuelve). */
      cifDeCompra(it: CompraLinea): string {
        const wid = idNorm(it.WarehouseId);
        return cifPorAlmacenId.get(wid) || cifPorAlmacenNombre.get(normNombre(it.WarehouseName)) || '';
      },
      /** CIF de la sociedad receptora de la factura ('' si no es del grupo). */
      cifDeFactura(f: FacturaListado): string {
        const cif = normalizeCif(f.emisor_cif);
        if (cif && empresaPorCif.has(cif)) return cif;
        return cifPorNombreEmpresa.get(normNombre(f.emisor_nombre)) || '';
      },
      empresaPorCif,
    };
  }, [almacenes, empresas]);

  const empresaOpciones = useMemo(() => {
    // Solo sociedades con Sede informada (mismo criterio que el formulario de
    // facturas para la receptora del gasto). La resolución del cruce sigue
    // usando el maestro completo.
    const vistos = new Set<string>();
    const opts: { id: string; titulo: string; subtitulo: string }[] = [];
    empresas.forEach((e) => {
      const sede = String(e.Sede ?? e.sede ?? '').trim();
      if (!sede) return;
      const cif = normalizeCif(e.Cif ?? e.cif);
      const nombre = String(e.Nombre ?? e.nombre ?? '').trim();
      if (!cif || !nombre || vistos.has(cif)) return;
      vistos.add(cif);
      opts.push({ id: `cif:${cif}`, titulo: nombre, subtitulo: cif });
    });
    opts.sort((a, b) => a.titulo.localeCompare(b.titulo, 'es'));
    return [
      { id: EMPRESA_TODAS, titulo: 'Todas las empresas' },
      ...opts,
      { id: EMPRESA_SIN, titulo: 'Sin empresa asociada' },
    ];
  }, [empresas]);

  const cargarFacturas = useCallback(() => {
    setLoadingFacturas(true);
    setErrorFacturas(null);
    apiFetch('/api/facturacion/facturas?tipo=IN')
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
        setFacturas(Array.isArray(data.facturas) ? data.facturas : []);
      })
      .catch((e) => setErrorFacturas(errorMessage(e, 'No se pudieron cargar las facturas de gasto')))
      .finally(() => setLoadingFacturas(false));
  }, []);

  useEffect(() => {
    cargarFacturas();
  }, [cargarFacturas]);

  const proveedores = useMemo<NodoProveedor[]>(() => {
    const isoDesde = /^\d{4}-\d{2}-\d{2}$/.test(fechaDesde.trim()) ? fechaDesde.trim() : null;
    const isoHasta = /^\d{4}-\d{2}-\d{2}$/.test(fechaHasta.trim()) ? fechaHasta.trim() : null;
    const enRango = (iso: string) => {
      if (isoDesde && (iso === '' || iso < isoDesde)) return false;
      if (isoHasta && (iso === '' || iso > isoHasta)) return false;
      return true;
    };

    const cifFiltro = empresaFiltro.startsWith('cif:') ? empresaFiltro.slice(4) : null;
    const pasaEmpresa = (cifResuelto: string): boolean => {
      if (empresaFiltro === EMPRESA_TODAS) return true;
      if (empresaFiltro === EMPRESA_SIN) return cifResuelto === '';
      return cifResuelto === cifFiltro;
    };

    const nombreEmpresaGrupo = (cif: string): string =>
      cif ? resolverEmpresaGrupo.empresaPorCif.get(cif) || cif : 'Sin empresa';

    /** Orden: empresa (Sin empresa al final) → fecha asc → desempate estable. */
    const cmpEmpresaFecha = (
      a: { fechaIso: string; empresaNombre: string },
      b: { fechaIso: string; empresaNombre: string },
      desempate: () => number,
    ): number => {
      const aSin = !a.empresaNombre || a.empresaNombre === 'Sin empresa';
      const bSin = !b.empresaNombre || b.empresaNombre === 'Sin empresa';
      if (aSin !== bSin) return aSin ? 1 : -1;
      if (!aSin) {
        const ce = a.empresaNombre.localeCompare(b.empresaNombre, 'es');
        if (ce !== 0) return ce;
      }
      const cf = a.fechaIso.localeCompare(b.fechaIso);
      if (cf !== 0) return cf;
      return desempate();
    };

    type AcumAlbaran = {
      label: string;
      fechaIso: string;
      numDoc: string;
      empresaCif: string;
      empresaNombre: string;
      /** Suma de TotalAmount de líneas (sin IVA). */
      sumLineas: number;
      /** Suma de líneas con IVA estimado (TotalAmount × (1 + IVA + recargo)). */
      sumLineasConIva: number;
      /** Totales a nivel de documento de Ágora, si la fila los trae. */
      netDoc: number | null;
      grossDoc: number | null;
      numLineas: number;
      lineas: CompraLinea[];
    };
    type Acum = {
      nombre: string;
      cif: string;
      albMap: Map<string, AcumAlbaran>;
      facturas: FacturaResumen[];
      /** Contador de CIF de empresa del grupo ('' = sin resolver) para elegir la predominante. */
      empresaCifCount: Map<string, number>;
    };
    const provMap = new Map<string, Acum>();

    const claveProveedor = (cif: string, nombre: string): string => {
      const c = normalizeCif(cif);
      if (c) return `cif:${c}`;
      const n = normNombre(nombre);
      return n ? `nom:${n}` : '__sin_proveedor__';
    };

    const getAcum = (key: string, nombre: string, cif: string): Acum => {
      let acum = provMap.get(key);
      if (!acum) {
        acum = { nombre, cif, albMap: new Map(), facturas: [], empresaCifCount: new Map() };
        provMap.set(key, acum);
      }
      if (!acum.nombre && nombre) acum.nombre = nombre;
      if (!acum.cif && cif) acum.cif = cif;
      return acum;
    };

    const contarEmpresa = (acum: Acum, empCif: string) => {
      acum.empresaCifCount.set(empCif, (acum.empresaCifCount.get(empCif) || 0) + 1);
    };

    compras.forEach((it: CompraLinea) => {
      const fecha = fechaLineaISO(it);
      if (!enRango(fecha)) return;
      const empCifCompra = resolverEmpresaGrupo.cifDeCompra(it);
      if (!pasaEmpresa(empCifCompra)) return;
      const nombre = String(it.SupplierName ?? '').trim();
      const key = claveProveedor(it.SupplierCif ?? '', nombre);
      const acum = getAcum(key, nombre, String(it.SupplierCif ?? '').trim());
      contarEmpresa(acum, empCifCompra);
      const aKey = albaranKey(it);
      let alb = acum.albMap.get(aKey);
      if (!alb) {
        alb = {
          label: albaranLabel(it),
          fechaIso: fecha,
          numDoc: String(it.SupplierDocumentNumber ?? '').trim(),
          empresaCif: empCifCompra,
          empresaNombre: nombreEmpresaGrupo(empCifCompra),
          sumLineas: 0,
          sumLineasConIva: 0,
          netDoc: null,
          grossDoc: null,
          numLineas: 0,
          lineas: [],
        };
        acum.albMap.set(aKey, alb);
      }
      alb.lineas.push(it);
      const importe = Number(it.TotalAmount);
      const neto = Number.isNaN(importe) ? 0 : importe;
      const vat = Number(it.VatRate) || 0;
      const surcharge = Number(it.SurchargeRate) || 0;
      alb.sumLineas += neto;
      alb.sumLineasConIva += neto * (1 + vat + surcharge);
      // Los totales de documento vienen repetidos en cada línea; basta capturarlos una vez.
      if (alb.grossDoc == null && it.AlbaranGrossAmount != null && !Number.isNaN(Number(it.AlbaranGrossAmount))) {
        alb.grossDoc = Number(it.AlbaranGrossAmount);
      }
      if (alb.netDoc == null && it.AlbaranNetAmount != null && !Number.isNaN(Number(it.AlbaranNetAmount))) {
        alb.netDoc = Number(it.AlbaranNetAmount);
      }
      alb.numLineas += 1;
    });

    facturas.forEach((f) => {
      if (f.estado === 'anulada') return;
      const fecha = String(f.fecha_emision ?? '').slice(0, 10);
      if (!enRango(fecha)) return;
      const empCifFactura = resolverEmpresaGrupo.cifDeFactura(f);
      if (!pasaEmpresa(empCifFactura)) return;
      // En facturas IN el proveedor va en empresa_* (emisor_* es la sociedad del grupo).
      const nombre = String(f.empresa_nombre ?? '').trim();
      const key = claveProveedor(f.empresa_cif ?? '', nombre);
      const acum = getAcum(key, nombre, String(f.empresa_cif ?? '').trim());
      contarEmpresa(acum, empCifFactura);
      acum.facturas.push({
        id: f.id_factura,
        numero: String(f.numero_factura ?? '—'),
        numeroProveedor: String(f.numero_factura_proveedor ?? '').trim(),
        fechaIso: fecha,
        empresaCif: empCifFactura,
        empresaNombre: nombreEmpresaGrupo(empCifFactura),
        estado: String(f.estado ?? ''),
        base: Number(f.base_imponible) || 0,
        total: Number(f.total_factura) || 0,
        vinculada: false,
      });
    });

    const nodos: NodoProveedor[] = [];
    provMap.forEach((acum, key) => {
      // Vínculo documental por nº de documento del proveedor.
      const docsFacturas = new Set(acum.facturas.map((f) => normDoc(f.numeroProveedor)).filter(Boolean));
      const docsAlbaranes = new Set<string>();
      const albaranes: AlbaranResumen[] = Array.from(acum.albMap.entries()).map(([aKey, a]) => {
        const nd = normDoc(a.numDoc);
        if (nd) docsAlbaranes.add(nd);
        return {
          key: aKey,
          label: a.label,
          fechaIso: a.fechaIso,
          numDoc: a.numDoc,
          empresaCif: a.empresaCif,
          empresaNombre: a.empresaNombre,
          // Preferir los totales del documento (incluyen descuentos a pie); si no, líneas.
          total: a.netDoc ?? a.sumLineas,
          totalConIva: a.grossDoc ?? a.sumLineasConIva,
          numLineas: a.numLineas,
          vinculado: nd !== '' && docsFacturas.has(nd),
          lineas: a.lineas,
        };
      });
      albaranes.sort((a, b) =>
        cmpEmpresaFecha(a, b, () => a.label.localeCompare(b.label, 'es')),
      );
      const facturasProv = acum.facturas.map((f) => ({
        ...f,
        vinculada: normDoc(f.numeroProveedor) !== '' && docsAlbaranes.has(normDoc(f.numeroProveedor)),
      }));
      facturasProv.sort((a, b) =>
        cmpEmpresaFecha(a, b, () => a.numero.localeCompare(b.numero, 'es')),
      );

      const totalAlbaranesBase = albaranes.reduce((s, a) => s + a.total, 0);
      const totalAlbaranesConIva = albaranes.reduce((s, a) => s + a.totalConIva, 0);
      const totalFacturasBase = facturasProv.reduce((s, f) => s + f.base, 0);
      const totalFacturasTotal = facturasProv.reduce((s, f) => s + f.total, 0);

      // La diferencia se calcula siempre con importes finales: albaranes con
      // IVA contra total factura (la base se muestra solo como información).
      const dif = totalAlbaranesConIva - totalFacturasTotal;
      const abs = Math.abs(dif);

      let estado: EstadoConciliacion;
      if (facturasProv.length === 0) estado = 'sin_factura';
      else if (albaranes.length === 0) estado = 'sin_albaran';
      else if (abs <= UMBRAL_CUADRA_EUR) estado = 'cuadra';
      else if (abs <= Math.max(totalAlbaranesConIva, totalFacturasTotal) * 0.01) estado = 'leve';
      else estado = 'descuadre';

      // Cuadra + facturas y ninguna en pte. revisión → validada (derivado, sin API).
      if (
        estado === 'cuadra' &&
        facturasProv.length >= 1 &&
        !facturasProv.some((f) => f.estado === 'pendiente_revision')
      ) {
        estado = 'validada';
      }

      // Empresa del grupo: si hay filtro concreto, esa; si no, la predominante por conteo.
      let empresaCif = '';
      if (cifFiltro) {
        empresaCif = cifFiltro;
      } else if (empresaFiltro === EMPRESA_SIN) {
        empresaCif = '';
      } else {
        let bestCif = '';
        let bestN = -1;
        acum.empresaCifCount.forEach((n, c) => {
          // Preferir CIF resuelto ante empate con «sin empresa».
          if (n > bestN || (n === bestN && c !== '' && bestCif === '')) {
            bestCif = c;
            bestN = n;
          }
        });
        empresaCif = bestCif;
      }
      const empresaNombre = empresaCif
        ? resolverEmpresaGrupo.empresaPorCif.get(empresaCif) || empresaCif
        : 'Sin empresa';

      nodos.push({
        key,
        nombre: acum.nombre || acum.cif || 'Proveedor sin identificar',
        cif: acum.cif,
        empresaCif,
        empresaNombre,
        albaranes,
        facturas: facturasProv,
        totalAlbaranesBase,
        totalAlbaranesConIva,
        totalFacturasBase,
        totalFacturasTotal,
        dif,
        estado,
      });
    });

    nodos.sort((a, b) => {
      const oa = ESTADO_META[a.estado].orden;
      const ob = ESTADO_META[b.estado].orden;
      if (oa !== ob) return oa - ob;
      return Math.abs(b.dif) - Math.abs(a.dif);
    });
    return nodos;
  }, [compras, facturas, fechaDesde, fechaHasta, empresaFiltro, resolverEmpresaGrupo]);

  const visibles = useMemo(() => {
    const q = normNombre(busqueda);
    return proveedores.filter((p) => {
      if (filtroEstado === 'diferencias' && p.estado !== 'descuadre' && p.estado !== 'leve') return false;
      if (filtroEstado === 'sin_factura' && p.estado !== 'sin_factura') return false;
      if (filtroEstado === 'sin_albaran' && p.estado !== 'sin_albaran') return false;
      if (filtroEstado === 'cuadra' && p.estado !== 'cuadra') return false;
      if (filtroEstado === 'validada' && p.estado !== 'validada') return false;
      if (q && !normNombre(p.nombre).includes(q) && !normalizeCif(p.cif).includes(normalizeCif(busqueda))) return false;
      return true;
    });
  }, [proveedores, filtroEstado, busqueda]);

  const facturaAProveedor = useMemo(() => {
    const map = new Map<string, { estado: EstadoConciliacion; nombre: string }>();
    for (const p of proveedores) {
      for (const f of p.facturas) {
        if (f.estado === 'pendiente_revision') {
          map.set(f.id, { estado: p.estado, nombre: p.nombre });
        }
      }
    }
    return map;
  }, [proveedores]);

  useEffect(() => {
    setSeleccionRevision((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (facturaAProveedor.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [facturaAProveedor]);

  const toggleSeleccionFactura = useCallback((id: string) => {
    setSeleccionRevision((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const validarRevisionSeleccionadas = useCallback(async () => {
    const ids = [...seleccionRevision];
    if (ids.length === 0) {
      showToast('Aviso', 'Selecciona facturas en «Pte. revisión»', 'warning');
      return;
    }

    const conDescuadre = ids.filter((id) => {
      const info = facturaAProveedor.get(id);
      return info && (info.estado === 'descuadre' || info.estado === 'leve');
    });

    if (conDescuadre.length > 0) {
      const nombres = [...new Set(conDescuadre.map((id) => facturaAProveedor.get(id)?.nombre).filter(Boolean))].slice(0, 3);
      const ok = await confirmar(
        'Validar con descuadre',
        `${conDescuadre.length} factura${conDescuadre.length !== 1 ? 's' : ''} pertenecen a proveedores con diferencias en la conciliación${
          nombres.length ? ` (${nombres.join(', ')}${conDescuadre.length > 3 ? '…' : ''})` : ''
        }.\n\n¿Validar revisión igualmente? Las facturas pasarán a pendiente de pago.`,
        { confirmarLabel: 'Validar igualmente' },
      );
      if (!ok) return;
    }

    setValidandoRevision(true);
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
      cargarFacturas();
      setSeleccionRevision(new Set());
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
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'Error al validar revisiones', 'error');
    } finally {
      setValidandoRevision(false);
    }
  }, [seleccionRevision, facturaAProveedor, confirmar, showToast, user, cargarFacturas]);

  const resumen = useMemo(() => {
    const r = { cuadran: 0, validadas: 0, diferencias: 0, sinFactura: 0, sinAlbaran: 0, totalAlb: 0, totalFact: 0 };
    proveedores.forEach((p) => {
      if (p.estado === 'cuadra') r.cuadran += 1;
      else if (p.estado === 'validada') r.validadas += 1;
      else if (p.estado === 'sin_factura') r.sinFactura += 1;
      else if (p.estado === 'sin_albaran') r.sinAlbaran += 1;
      else r.diferencias += 1;
      r.totalAlb += p.totalAlbaranesConIva;
      r.totalFact += p.totalFacturasTotal;
    });
    return r;
  }, [proveedores]);

  const aplicarPeriodo = useCallback((id: string) => {
    if (periodoActivo === id) {
      setPeriodoActivo(null);
      setFechaDesde('');
      setFechaHasta('');
      return;
    }
    const r = rangoPeriodo(id);
    setPeriodoActivo(id);
    setFechaDesde(r.desde);
    setFechaHasta(r.hasta);
  }, [periodoActivo]);

  const toggleAbierto = useCallback((key: string) => {
    setAbiertos((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const exportarExcel = useCallback(() => {
    if (visibles.length === 0) return;
    const resumenRows: (string | number)[][] = [
      ['Proveedor', 'CIF', 'Nº albaranes', 'Albaranes base', 'Albaranes c/IVA', 'Nº facturas', 'Fact. base imponible', 'Fact. total', 'Diferencia', 'Comparado', 'Estado'],
    ];
    const detalleRows: (string | number)[][] = [
      ['Proveedor', 'Tipo', 'Fecha', 'Documento', 'Nº doc. proveedor', 'Base', 'Total c/IVA', 'Estado', 'Vinculado'],
    ];
    visibles.forEach((p) => {
      resumenRows.push([
        p.nombre, p.cif, p.albaranes.length, p.totalAlbaranesBase, p.totalAlbaranesConIva, p.facturas.length,
        p.totalFacturasBase, p.totalFacturasTotal, p.dif,
        'Alb. c/IVA ↔ total factura',
        ESTADO_META[p.estado].label,
      ]);
      p.albaranes.forEach((a) => {
        detalleRows.push([p.nombre, 'Albarán', formatFechaCorta(a.fechaIso), a.label, a.numDoc, a.total, a.totalConIva, '', a.vinculado ? 'Sí' : 'No']);
      });
      p.facturas.forEach((f) => {
        detalleRows.push([p.nombre, 'Factura', formatFechaCorta(f.fechaIso), f.numero, f.numeroProveedor, f.base, f.total, labelEstado(f.estado), f.vinculada ? 'Sí' : 'No']);
      });
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumenRows), 'Resumen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detalleRows), 'Detalle');
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `conciliacion_compras_facturas_${stamp}.xlsx`;
    if (Platform.OS === 'web') {
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}${fname}`;
      FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 })
        .then(() =>
          Sharing.shareAsync(fileUri, {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            dialogTitle: fname,
          }),
        )
        .catch(() => {});
    }
  }, [visibles]);

  /**
   * Nodos con diferencias (descuadre/leve) según periodo, empresa y búsqueda —
   * independiente del chip de estado de la lista (para no omitir incidencias).
   */
  const nodosDiferenciasPdf = useMemo(() => {
    const q = normNombre(busqueda);
    return proveedores.filter((p) => {
      if (p.estado !== 'descuadre' && p.estado !== 'leve') return false;
      if (q && !normNombre(p.nombre).includes(q) && !normalizeCif(p.cif).includes(normalizeCif(busqueda))) {
        return false;
      }
      return true;
    });
  }, [proveedores, busqueda]);

  const exportarPdfDiferencias = useCallback(async () => {
    if (exportandoPdfRef.current) return;
    if (nodosDiferenciasPdf.length === 0) {
      showToast('Sin diferencias', 'No hay proveedores con descuadre o diferencia leve para este periodo y filtros.', 'warning');
      return;
    }
    exportandoPdfRef.current = true;
    setExportandoPdf(true);
    try {
      const partesCtx: string[] = [];
      if (empresaFiltro === EMPRESA_SIN) partesCtx.push('Empresa: sin empresa');
      else if (empresaFiltro !== EMPRESA_TODAS) {
        const op = empresaOpciones.find((o) => o.id === empresaFiltro);
        partesCtx.push(`Empresa: ${op?.label || empresaFiltro}`);
      }
      if (busqueda.trim()) {
        const q = busqueda.trim();
        const n = nodosDiferenciasPdf.length;
        if (n === 1) {
          const p = nodosDiferenciasPdf[0];
          const nombre = (p.nombre || '').trim() || 'Proveedor';
          const cif = (p.cif || '').trim();
          partesCtx.push(cif ? `Proveedor: ${nombre} · CIF ${cif}` : `Proveedor: ${nombre}`);
        } else {
          partesCtx.push(`Proveedores filtrados por «${q}» (${n})`);
        }
      }
      const pdfs = await generarPdfsConciliacionDiferenciasPorEmpresa({
        fechaDesde,
        fechaHasta,
        contextoFiltro: partesCtx.length ? partesCtx.join(' · ') : undefined,
        nodos: nodosDiferenciasPdf.map((p) => ({
          nombre: p.nombre,
          cif: p.cif,
          empresaCif: p.empresaCif,
          empresaNombre: p.empresaNombre,
          estado: p.estado as 'descuadre' | 'leve',
          estadoLabel: ESTADO_META[p.estado].label,
          dif: p.dif,
          totalAlbaranesBase: p.totalAlbaranesBase,
          totalAlbaranesConIva: p.totalAlbaranesConIva,
          totalFacturasBase: p.totalFacturasBase,
          totalFacturasTotal: p.totalFacturasTotal,
          albaranes: p.albaranes,
          facturas: p.facturas,
        })),
      });
      if (pdfs.length === 0) {
        showToast('Sin diferencias', 'No hay datos para exportar por empresa.', 'warning');
        return;
      }
      if (Platform.OS === 'web') {
        for (let i = 0; i < pdfs.length; i += 1) {
          pdfs[i].doc.save(pdfs[i].filename);
          if (i < pdfs.length - 1) {
            await new Promise<void>((r) => setTimeout(r, 350));
          }
        }
      } else {
        const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
        for (const { doc, filename } of pdfs) {
          const dataUri = doc.output('datauristring');
          const base64 = dataUri.split(',')[1] || '';
          const fileUri = `${cacheDir}${filename}`;
          await FileSystemLegacy.writeAsStringAsync(fileUri, base64, {
            encoding: FileSystemLegacy.EncodingType.Base64,
          });
          await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: filename });
        }
      }
      const n = pdfs.length;
      showToast(
        'PDF generado',
        n === 1
          ? 'Se ha generado 1 PDF'
          : `Se han generado ${n} PDFs (uno por empresa)`,
        'success',
      );
    } catch (e: unknown) {
      showToast('Error', e instanceof Error ? e.message : 'No se pudo generar el PDF', 'error');
    } finally {
      exportandoPdfRef.current = false;
      setExportandoPdf(false);
    }
  }, [nodosDiferenciasPdf, fechaDesde, fechaHasta, empresaFiltro, empresaOpciones, busqueda, showToast]);

  const cargando = (loadingCompras && compras.length === 0) || loadingFacturas;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>Conciliación compras ↔ facturas</Text>
          <Text style={styles.headerSubtitle}>
            Albaranes de Ágora contrastados con facturas de gasto, por proveedor
          </Text>
        </View>
        <ComprasToolbarIconBtn
          tooltip="Exportar conciliación a Excel"
          onPress={exportarExcel}
          disabled={visibles.length === 0}
          accessibilityLabel="Exportar Excel"
          variant="outline"
        >
          <MaterialIcons name="table-chart" size={TOOLBAR_ICON_SIZE} color={visibles.length === 0 ? '#cbd5e1' : '#0ea5e9'} />
        </ComprasToolbarIconBtn>
        <ComprasToolbarIconBtn
          tooltip="PDF diferencias (economato)"
          onPress={exportarPdfDiferencias}
          disabled={exportandoPdf || nodosDiferenciasPdf.length === 0}
          accessibilityLabel="PDF diferencias economato"
          variant="outline"
        >
          {exportandoPdf ? (
            <ActivityIndicator size="small" color="#dc2626" />
          ) : (
            <MaterialIcons
              name="picture-as-pdf"
              size={TOOLBAR_ICON_SIZE}
              color={nodosDiferenciasPdf.length === 0 ? '#cbd5e1' : '#dc2626'}
            />
          )}
        </ComprasToolbarIconBtn>
        <ComprasToolbarIconBtn
          tooltip="Recargar albaranes y facturas"
          onPress={() => { recargar({ force: true }); cargarFacturas(); }}
          disabled={cargando}
          accessibilityLabel="Recargar"
          variant="outline"
        >
          {cargando ? (
            <ActivityIndicator size="small" color="#0ea5e9" />
          ) : (
            <MaterialIcons name="refresh" size={TOOLBAR_ICON_SIZE} color="#0ea5e9" />
          )}
        </ComprasToolbarIconBtn>
      </View>

      {/* Filtros */}
      <View style={local.filtros}>
        <View style={local.chipsRow}>
          {PERIODOS.map((p) => {
            const activo = periodoActivo === p.id;
            return (
              <TouchableOpacity
                key={p.id}
                style={[local.chip, activo && local.chipActivo]}
                onPress={() => aplicarPeriodo(p.id)}
                activeOpacity={0.7}
              >
                <Text style={[local.chipText, activo && local.chipTextActivo]}>{p.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <View style={local.fechasRow}>
          <View style={local.fechaField}>
            <Text style={local.fechaLabel}>Desde</Text>
            <InputFecha
              valueIso={fechaDesde}
              onChangeIso={(v) => { setFechaDesde(v); setPeriodoActivo(null); }}
              placeholder="dd/mm/aaaa"
              style={local.fechaInput}
            />
          </View>
          <View style={local.fechaField}>
            <Text style={local.fechaLabel}>Hasta</Text>
            <InputFecha
              valueIso={fechaHasta}
              onChangeIso={(v) => { setFechaHasta(v); setPeriodoActivo(null); }}
              placeholder="dd/mm/aaaa"
              style={local.fechaInput}
            />
          </View>
          <SelectorDesplegable
            label="Empresa"
            placeholder="Todas las empresas"
            icono="business"
            opciones={empresaOpciones}
            valorId={empresaFiltro}
            onSeleccionar={setEmpresaFiltro}
            tituloLista="Empresa receptora"
            iconoLista="business"
            loading={maestrosLoading}
            buscador
            buscadorPlaceholder="Buscar empresa…"
            style={{ minWidth: 190 }}
          />
          <View style={[local.fechaField, { flexGrow: 1, minWidth: 160 }]}>
            <Text style={local.fechaLabel}>Proveedor</Text>
            <TextInput
              style={local.buscarInput}
              placeholder="Buscar por nombre o CIF…"
              placeholderTextColor="#94a3b8"
              value={busqueda}
              onChangeText={setBusqueda}
            />
          </View>
        </View>
        <View style={local.chipsRow}>
          {FILTROS_ESTADO.map((f) => {
            const activo = filtroEstado === f.id;
            return (
              <TouchableOpacity
                key={f.id}
                style={[local.chip, activo && local.chipActivo]}
                onPress={() => setFiltroEstado(f.id)}
                activeOpacity={0.7}
              >
                <Text style={[local.chipText, activo && local.chipTextActivo]}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Banner resumen */}
      <View style={local.totalBanner}>
        <MaterialIcons name="fact-check" size={16} color="#0369a1" />
        <Text style={local.totalBannerText}>
          Albaranes: <Text style={local.totalBannerStrong}>{formatMoneda(resumen.totalAlb)}</Text>
          {'  ·  '}Facturas: <Text style={local.totalBannerStrong}>{formatMoneda(resumen.totalFact)}</Text>
          {'  ·  '}
          <Text style={{ color: '#047857' }}>{resumen.cuadran} cuadran</Text>
          {' · '}
          <Text style={{ color: '#065f46' }}>{resumen.validadas} validadas</Text>
          {' · '}
          <Text style={{ color: '#b91c1c' }}>{resumen.diferencias} con diferencias</Text>
          {' · '}
          <Text style={{ color: '#c2410c' }}>{resumen.sinFactura} sin factura</Text>
          {' · '}
          <Text style={{ color: '#475569' }}>{resumen.sinAlbaran} sin albarán</Text>
        </Text>
      </View>

      {errorFacturas ? (
        <View style={local.errorBanner}>
          <MaterialIcons name="error-outline" size={16} color="#b91c1c" />
          <Text style={local.errorBannerText}>{errorFacturas}</Text>
          <TouchableOpacity onPress={cargarFacturas}>
            <Text style={local.errorBannerRetry}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {puedeValidarRevision && seleccionRevision.size > 0 ? (
        <View style={local.validarBar}>
          <MaterialIcons name="task-alt" size={18} color="#0369a1" />
          <Text style={local.validarBarText}>
            {seleccionRevision.size} factura{seleccionRevision.size !== 1 ? 's' : ''} seleccionada{seleccionRevision.size !== 1 ? 's' : ''}
          </Text>
          <TouchableOpacity
            style={local.validarBarBtnSec}
            onPress={() => setSeleccionRevision(new Set())}
            disabled={validandoRevision}
          >
            <Text style={local.validarBarBtnSecText}>Deseleccionar</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[local.validarBarBtn, validandoRevision && local.validarBarBtnDisabled]}
            onPress={validarRevisionSeleccionadas}
            disabled={validandoRevision}
          >
            {validandoRevision ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialIcons name="check-circle" size={16} color="#fff" />
            )}
            <Text style={local.validarBarBtnText}>Validar revisión</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Listado */}
      {cargando ? (
        <View style={local.emptyWrap}>
          <ActivityIndicator size="large" color="#0ea5e9" />
          <Text style={local.emptyText}>Cargando albaranes y facturas…</Text>
        </View>
      ) : visibles.length === 0 ? (
        <View style={local.emptyWrap}>
          <MaterialIcons name="inbox" size={48} color="#cbd5e1" />
          <Text style={local.emptyText}>No hay proveedores para el periodo y filtros seleccionados.</Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
          {visibles.map((p) => {
            const abierto = abiertos.has(p.key);
            const meta = ESTADO_META[p.estado];
            const difColor = Math.abs(p.dif) <= UMBRAL_CUADRA_EUR ? '#047857' : p.dif > 0 ? '#b91c1c' : '#b45309';
            return (
              <View key={p.key} style={local.provBlock}>
                <TouchableOpacity style={local.provHeader} onPress={() => toggleAbierto(p.key)} activeOpacity={0.7}>
                  <MaterialIcons name={abierto ? 'expand-more' : 'chevron-right'} size={22} color="#0f172a" />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={local.provNombreRow}>
                      <Text style={local.provNombre} numberOfLines={1}>{p.nombre}</Text>
                      <TouchableOpacity
                        style={local.compareBtn}
                        onPress={(e) => {
                          e.stopPropagation();
                          abrirComparador(p);
                        }}
                        hitSlop={6}
                        accessibilityLabel="Comparar albaranes con factura"
                      >
                        <MaterialIcons name="vertical-split" size={15} color="#0369a1" />
                      </TouchableOpacity>
                    </View>
                    <Text style={local.provMeta} numberOfLines={1}>
                      {p.cif ? `${p.cif} · ` : ''}{p.albaranes.length} alb. · {p.facturas.length} fact.
                    </Text>
                  </View>
                  <View style={local.provImportes}>
                    <Text style={local.provImporteLinea}>
                      Alb: <Text style={local.provImporteStrong}>{formatMoneda(p.totalAlbaranesConIva)}</Text>
                      <Text style={local.provImporteVs}> · base {formatMoneda(p.totalAlbaranesBase)}</Text>
                    </Text>
                    <Text style={local.provImporteLinea}>
                      Fact: <Text style={local.provImporteStrong}>{formatMoneda(p.totalFacturasTotal)}</Text>
                      <Text style={local.provImporteVs}> · base {formatMoneda(p.totalFacturasBase)}</Text>
                    </Text>
                    <Text style={[local.provImporteLinea, { color: difColor, fontWeight: '700' }]}>
                      Dif: {formatMoneda(p.dif)}
                    </Text>
                  </View>
                  <View
                    style={[
                      local.badge,
                      { backgroundColor: meta.bg },
                      meta.borderColor
                        ? {
                            borderWidth: meta.borderWidth ?? 2,
                            borderColor: meta.borderColor,
                            ...(Platform.OS === 'web'
                              ? { boxShadow: meta.boxShadow }
                              : {
                                  shadowColor: meta.borderColor,
                                  shadowOpacity: 0.65,
                                  shadowRadius: 8,
                                  shadowOffset: { width: 0, height: 0 },
                                }),
                          }
                        : null,
                    ]}
                  >
                    <Text style={[local.badgeText, { color: meta.text }]}>{meta.label}</Text>
                  </View>
                </TouchableOpacity>

                {abierto ? (
                  <View style={local.detalle}>
                    <View style={[local.detalleCols, shouldStackPanels && local.detalleColsStack]}>
                      {/* Albaranes */}
                      <View style={[local.detalleCol, !shouldStackPanels && local.detalleColSide]}>
                        <Text style={local.detalleTitulo}>Albaranes ({p.albaranes.length})</Text>
                        {(() => {
                          const listaAlb = p.albaranes.length === 0 ? (
                            <Text style={local.detalleVacio}>Sin albaranes en el periodo.</Text>
                          ) : p.albaranes.map((a) => (
                            <TouchableOpacity
                              key={a.key}
                              style={local.detalleRow}
                              onPress={() => setAlbaranModal(a)}
                              activeOpacity={0.6}
                            >
                              <Text style={local.detalleFecha}>{formatFechaCorta(a.fechaIso)}</Text>
                              <MaterialIcons name="receipt" size={14} color="#94a3b8" />
                              <Text style={local.detalleDoc} numberOfLines={1}>
                                {a.label}{a.numDoc ? `  ·  Nº doc: ${a.numDoc}` : ''}
                              </Text>
                              <View style={local.empresaCol}>
                                {(() => {
                                  const chip = colorChipEmpresa(a.empresaCif, a.empresaNombre);
                                  return (
                                    <View style={[local.empresaChip, { backgroundColor: chip.bg }]}>
                                      <Text style={[local.empresaChipText, { color: chip.text }]} numberOfLines={1}>
                                        {a.empresaNombre || 'Sin empresa'}
                                      </Text>
                                    </View>
                                  );
                                })()}
                              </View>
                              <View style={local.detalleRowSpacer} />
                              {a.vinculado ? (
                                <MaterialIcons name="link" size={15} color="#047857" />
                              ) : null}
                              <Text style={local.detalleImporte}>
                                {formatMoneda(a.total)} <Text style={local.detalleImporteSec}>/ {formatMoneda(a.totalConIva)}</Text>
                              </Text>
                            </TouchableOpacity>
                          ));
                          if (p.albaranes.length === 0) return listaAlb;
                          return shouldStackPanels ? (
                            <View style={local.detalleGrid}>{listaAlb}</View>
                          ) : (
                            <ScrollView style={[local.detalleColScroll, local.detalleGrid]} nestedScrollEnabled>
                              {listaAlb}
                            </ScrollView>
                          );
                        })()}
                        {p.albaranes.length > 0 ? (
                          <Text style={local.detalleNota}>Importes de albarán: base sin IVA / total con IVA. Toca un albarán para ver sus productos.</Text>
                        ) : null}
                      </View>

                      {/* Facturas de gasto */}
                      <View style={[
                        local.detalleCol,
                        !shouldStackPanels && local.detalleColSide,
                        !shouldStackPanels && local.detalleColDivider,
                        shouldStackPanels && local.detalleColStackGap,
                      ]}>
                        <Text style={local.detalleTitulo}>Facturas de gasto ({p.facturas.length})</Text>
                        {(() => {
                          const listaFact = p.facturas.length === 0 ? (
                            <Text style={local.detalleVacio}>Sin facturas de gasto en el periodo.</Text>
                          ) : p.facturas.map((f) => {
                            const c = colorEstado(f.estado);
                            const esPteRevision = f.estado === 'pendiente_revision';
                            const seleccionada = seleccionRevision.has(f.id);
                            return (
                              <View key={f.id} style={local.detalleRow}>
                                {puedeValidarRevision ? (
                                  esPteRevision ? (
                                    <TouchableOpacity
                                      style={local.detalleCheckbox}
                                      onPress={(e) => {
                                        absorberClickFila(e);
                                        toggleSeleccionFactura(f.id);
                                      }}
                                      hitSlop={6}
                                      accessibilityLabel={seleccionada ? 'Desmarcar factura' : 'Marcar para validar revisión'}
                                    >
                                      <MaterialIcons
                                        name={seleccionada ? 'check-box' : 'check-box-outline-blank'}
                                        size={18}
                                        color={seleccionada ? '#0ea5e9' : '#cbd5e1'}
                                      />
                                    </TouchableOpacity>
                                  ) : (
                                    <View style={local.detalleCheckbox} />
                                  )
                                ) : null}
                                <TouchableOpacity
                                  style={local.detalleRowMain}
                                  onPress={() => abrirDocumentoFactura(f.id)}
                                  disabled={abriendoDocId === f.id}
                                  activeOpacity={0.6}
                                >
                                  <Text style={local.detalleFecha}>{formatFechaCorta(f.fechaIso)}</Text>
                                  {abriendoDocId === f.id ? (
                                    <ActivityIndicator size={14} color="#0ea5e9" />
                                  ) : (
                                    <MaterialIcons name="description" size={14} color="#94a3b8" />
                                  )}
                                  <Text style={local.detalleDoc} numberOfLines={1}>
                                    {f.numero}{f.numeroProveedor ? `  ·  Nº prov: ${f.numeroProveedor}` : ''}
                                  </Text>
                                  <View style={local.empresaCol}>
                                    {(() => {
                                      const chip = colorChipEmpresa(f.empresaCif, f.empresaNombre);
                                      return (
                                        <View style={[local.empresaChip, { backgroundColor: chip.bg }]}>
                                          <Text style={[local.empresaChipText, { color: chip.text }]} numberOfLines={1}>
                                            {f.empresaNombre || 'Sin empresa'}
                                          </Text>
                                        </View>
                                      );
                                    })()}
                                  </View>
                                  <View style={local.detalleRowSpacer} />
                                  {f.vinculada ? (
                                    <MaterialIcons name="link" size={15} color="#047857" />
                                  ) : null}
                                  <View style={[local.badgeMini, { backgroundColor: c.bg }]}>
                                    <Text style={[local.badgeMiniText, { color: c.text }]}>{labelEstado(f.estado)}</Text>
                                  </View>
                                  <Text style={local.detalleImporte}>
                                    {formatMoneda(f.base)} <Text style={local.detalleImporteSec}>/ {formatMoneda(f.total)}</Text>
                                  </Text>
                                </TouchableOpacity>
                              </View>
                            );
                          });
                          if (p.facturas.length === 0) return listaFact;
                          return shouldStackPanels ? (
                            <View style={local.detalleGrid}>{listaFact}</View>
                          ) : (
                            <ScrollView style={[local.detalleColScroll, local.detalleGrid]} nestedScrollEnabled>
                              {listaFact}
                            </ScrollView>
                          );
                        })()}
                        {p.facturas.length > 0 ? (
                          <Text style={local.detalleNota}>
                            Importes de factura: base imponible / total con IVA. Toca una factura para abrir su documento adjunto.
                            {puedeValidarRevision ? ' Marca las pendientes de revisión para validarlas desde conciliación.' : ''}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  </View>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Modal detalle albarán (productos, cantidades, formatos y precios) */}
      <Modal visible={albaranModal !== null} transparent animationType="fade" onRequestClose={() => setAlbaranModal(null)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setAlbaranModal(null)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={local.modalWrap}>
            <View style={local.modalCard}>
              {albaranModal ? (() => {
                const first = albaranModal.lineas[0];
                return (
                  <>
                    <View style={local.modalHeader}>
                      <View style={{ flex: 1 }}>
                        <Text style={local.modalTitle}>Albarán {albaranModal.label} · {formatFechaCorta(albaranModal.fechaIso)}</Text>
                        <Text style={local.modalSubtitle} numberOfLines={1}>
                          {String(first?.SupplierName ?? '—')} · {String(first?.WarehouseName ?? '—')}
                        </Text>
                      </View>
                      <TouchableOpacity onPress={() => setAlbaranModal(null)} hitSlop={8}>
                        <MaterialIcons name="close" size={22} color="#64748b" />
                      </TouchableOpacity>
                    </View>

                    <ScrollView style={{ maxHeight: 360 }} horizontal>
                      <View>
                        <View style={local.modalThRow}>
                          <Text style={[local.modalTh, { width: 200 }]}>Producto</Text>
                          <Text style={[local.modalTh, { width: 70, textAlign: 'right' }]}>Cant.</Text>
                          <Text style={[local.modalTh, { width: 70 }]}>Formato</Text>
                          <Text style={[local.modalTh, { width: 90, textAlign: 'right' }]}>Precio</Text>
                          <Text style={[local.modalTh, { width: 60, textAlign: 'right' }]}>IVA</Text>
                          <Text style={[local.modalTh, { width: 100, textAlign: 'right' }]}>Total</Text>
                        </View>
                        <ScrollView style={{ maxHeight: 320 }}>
                          {albaranModal.lineas.map((l, i) => (
                            <View key={`${l.PK}-${l.SK}`} style={[local.modalTr, i % 2 === 1 && local.modalTrAlt]}>
                              <Text style={[local.modalTd, { width: 200 }]} numberOfLines={2}>{String(l.ProductName ?? l.ProductId ?? '—')}</Text>
                              <Text style={[local.modalTd, { width: 70, textAlign: 'right' }]}>{Number(l.Quantity) || 0}</Text>
                              <Text style={[local.modalTd, { width: 70 }]} numberOfLines={1}>{String(l.PurchaseUnitName ?? '')}</Text>
                              <Text style={[local.modalTd, { width: 90, textAlign: 'right' }]}>{formatMoneda(l.Price)}</Text>
                              <Text style={[local.modalTd, { width: 60, textAlign: 'right' }]}>{Number(l.VatRate) ? `${(Number(l.VatRate) * 100).toFixed(0)}%` : '—'}</Text>
                              <Text style={[local.modalTd, { width: 100, textAlign: 'right' }]}>{formatMoneda(l.TotalAmount)}</Text>
                            </View>
                          ))}
                        </ScrollView>
                      </View>
                    </ScrollView>

                    <View style={local.modalFooter}>
                      <Text style={local.modalFooterMeta} numberOfLines={1}>
                        Nº doc.: {String(first?.SupplierDocumentNumber ?? '—')}   ·   {first?.Confirmed ? 'Confirmado ✓' : 'Sin confirmar'}   ·   {first?.Invoiced ? 'Facturado ✓' : 'No facturado'}
                      </Text>
                      <Text style={local.modalFooterTotal}>
                        Base: {formatMoneda(albaranModal.total)}   ·   Total c/IVA: {formatMoneda(albaranModal.totalConIva)}
                      </Text>
                    </View>
                  </>
                );
              })() : null}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Modal comparador: albaranes (izquierda) ↔ documento de factura (derecha) */}
      <Modal visible={comparador !== null} transparent animationType="fade" onRequestClose={cerrarComparador}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={cerrarComparador}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => {}}
            style={[local.compWrap, { maxHeight: winH * 0.92 }]}
          >
            <View style={local.compCard}>
              {comparador ? (
                <>
                  <View style={local.modalHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={local.modalTitle} numberOfLines={1}>{comparador.nombre}</Text>
                      <Text style={local.modalSubtitle} numberOfLines={1}>
                        {comparador.cif ? `${comparador.cif} · ` : ''}
                        Alb: {formatMoneda(comparador.totalAlbaranesConIva)} · Fact: {formatMoneda(comparador.totalFacturasTotal)} · Dif: {formatMoneda(comparador.dif)}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={cerrarComparador} hitSlop={8}>
                      <MaterialIcons name="close" size={22} color="#64748b" />
                    </TouchableOpacity>
                  </View>

                  <View style={[local.compBody, comparadorApilado && { flexDirection: 'column' }]}>
                    {/* Izquierda: desglose de productos por albarán */}
                    <View style={[local.compPanel, comparadorApilado && local.compPanelApilado]}>
                      <Text style={local.compPanelTitle}>Albaranes ({comparador.albaranes.length})</Text>
                      <ScrollView style={{ flex: 1 }}>
                        {comparador.albaranes.length === 0 ? (
                          <Text style={local.detalleVacio}>Sin albaranes en el periodo.</Text>
                        ) : comparador.albaranes.map((a) => (
                          <View key={a.key} style={local.compAlbBlock}>
                            <View style={local.compAlbHeader}>
                              <MaterialIcons name="receipt" size={13} color="#0369a1" />
                              <Text style={local.compAlbTitulo} numberOfLines={1}>
                                {a.label} · {formatFechaCorta(a.fechaIso)}{a.numDoc ? ` · Nº ${a.numDoc}` : ''}
                              </Text>
                              <Text style={local.compAlbTotal}>{formatMoneda(a.totalConIva)}</Text>
                            </View>
                            {a.lineas.map((l, i) => (
                              <View key={`${l.PK}-${l.SK}`} style={[local.compLineaRow, i % 2 === 1 && local.modalTrAlt]}>
                                <Text style={local.compLineaProducto} numberOfLines={1}>
                                  {String(l.ProductName ?? l.ProductId ?? '—')}
                                </Text>
                                <Text style={local.compLineaDato}>
                                  {Number(l.Quantity) || 0}{l.PurchaseUnitName ? ` ${String(l.PurchaseUnitName)}` : ''}
                                </Text>
                                <Text style={[local.compLineaDato, { width: 74 }]}>{formatMoneda(l.Price)}</Text>
                                <Text style={[local.compLineaDato, { width: 80, fontWeight: '600', color: '#0f172a' }]}>
                                  {formatMoneda(l.TotalAmount)}
                                </Text>
                              </View>
                            ))}
                          </View>
                        ))}
                      </ScrollView>
                      <Text style={local.compPanelPie}>
                        Líneas a precio sin IVA · Total albaranes c/IVA: {formatMoneda(comparador.totalAlbaranesConIva)}
                      </Text>
                    </View>

                    {/* Derecha: previsualización del documento de la factura */}
                    <View style={[local.compPanel, comparadorApilado && local.compPanelApilado]}>
                      <Text style={local.compPanelTitle}>Factura ({comparador.facturas.length})</Text>
                      {comparador.facturas.length > 1 ? (
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
                          <View style={local.compFactChips}>
                            {comparador.facturas.map((f) => (
                              <TouchableOpacity
                                key={f.id}
                                style={[local.chip, compFacturaId === f.id && local.chipActivo]}
                                onPress={() => setCompFacturaId(f.id)}
                              >
                                <Text style={[local.chipText, compFacturaId === f.id && local.chipTextActivo]} numberOfLines={1}>
                                  {f.numeroProveedor || f.numero} · {formatMoneda(f.total)}
                                </Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                        </ScrollView>
                      ) : null}
                      <View style={local.compPreviewBox}>
                        {comparador.facturas.length === 0 ? (
                          <View style={local.compPreviewCentro}>
                            <MaterialIcons name="description" size={40} color="#cbd5e1" />
                            <Text style={local.detalleVacio}>Sin facturas de gasto en el periodo.</Text>
                          </View>
                        ) : compPreviewLoading ? (
                          <View style={local.compPreviewCentro}>
                            <ActivityIndicator size="large" color="#0ea5e9" />
                          </View>
                        ) : compPreviewError ? (
                          <View style={local.compPreviewCentro}>
                            <MaterialIcons name="error-outline" size={36} color="#f87171" />
                            <Text style={[local.detalleVacio, { textAlign: 'center' }]}>{compPreviewError}</Text>
                            {compFacturaId ? (
                              <TouchableOpacity
                                style={local.compAbrirBtn}
                                onPress={() => router.push(`/facturacion/factura-detalle?id=${compFacturaId}&modo=editar&tipo=IN` as never)}
                              >
                                <Text style={local.compAbrirBtnText}>Abrir ficha de la factura</Text>
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        ) : compPreviewUrl && Platform.OS === 'web' ? (
                          <iframe
                            src={compPreviewUrl}
                            style={{ width: '100%', height: '100%', border: 'none' } as React.CSSProperties}
                            title="Documento de la factura"
                          />
                        ) : compPreviewUrl ? (
                          <View style={local.compPreviewCentro}>
                            <Text style={local.detalleVacio}>Previsualización disponible solo en web.</Text>
                            <TouchableOpacity style={local.compAbrirBtn} onPress={() => Linking.openURL(compPreviewUrl)}>
                              <Text style={local.compAbrirBtnText}>Abrir documento</Text>
                            </TouchableOpacity>
                          </View>
                        ) : null}
                      </View>
                    </View>
                  </View>
                </>
              ) : null}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
      {ToastView}
      {ConfirmarView}
    </View>
  );
}

const local = StyleSheet.create({
  filtros: { paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipActivo: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc' },
  chipText: { fontSize: 12, color: '#475569', fontWeight: '500' },
  chipTextActivo: { color: '#0369a1', fontWeight: '700' },
  fechasRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' },
  fechaField: { gap: 2 },
  fechaLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  fechaInput: { minWidth: 130, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  buscarInput: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: '#0f172a',
  },

  totalBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 8,
    flexWrap: 'wrap',
  },
  totalBannerText: { fontSize: 13, color: '#1e3a8a', flexShrink: 1 },
  totalBannerStrong: { fontWeight: '700', color: '#0369a1' },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
  },
  errorBannerText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  errorBannerRetry: { fontSize: 12, fontWeight: '700', color: '#0ea5e9' },

  validarBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 6,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 8,
    flexWrap: 'wrap',
  },
  validarBarText: { flex: 1, fontSize: 13, fontWeight: '600', color: '#0369a1', minWidth: 120 },
  validarBarBtnSec: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
  },
  validarBarBtnSecText: { fontSize: 12, fontWeight: '500', color: '#64748b' },
  validarBarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  validarBarBtnDisabled: { opacity: 0.7 },
  validarBarBtnText: { fontSize: 12, fontWeight: '600', color: '#fff' },

  provBlock: { marginHorizontal: 12, marginTop: 8, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, overflow: 'hidden', backgroundColor: '#fff' },
  provHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 10, backgroundColor: '#f8fafc' },
  provNombre: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  provMeta: { fontSize: 11, color: '#94a3b8', marginTop: 1 },
  provImportes: { alignItems: 'flex-end', gap: 1 },
  provImporteLinea: { fontSize: 12, color: '#475569' },
  provImporteStrong: { fontWeight: '600', color: '#0f172a' },
  provImporteVs: { fontSize: 10, color: '#94a3b8' },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, marginLeft: 4 },
  badgeText: { fontSize: 11, fontWeight: '700' },

  detalle: { paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#f1f5f9' },
  detalleCols: { flexDirection: 'row', alignItems: 'flex-start', gap: 0 },
  detalleColsStack: { flexDirection: 'column' },
  detalleCol: { flex: 1, minWidth: 0 },
  detalleColSide: { paddingHorizontal: 4 },
  detalleColDivider: { borderLeftWidth: 1, borderLeftColor: '#e2e8f0', paddingLeft: 12 },
  detalleColStackGap: { marginTop: 10 },
  /** Scroll independiente por columna en layout 50/50 (no rompe el ScrollView padre). */
  detalleColScroll: { maxHeight: 280 },
  /** Contenedor tipo cuadrícula (albaranes y facturas). */
  detalleGrid: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  detalleTitulo: { fontSize: 12, fontWeight: '700', color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 },
  detalleVacio: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', paddingVertical: 4 },
  detalleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  detalleCheckbox: { width: 28, alignItems: 'center', justifyContent: 'center' },
  detalleRowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  detalleFecha: { fontSize: 12, color: '#64748b', width: 76 },
  detalleDoc: {
    flexGrow: 0,
    flexShrink: 1,
    maxWidth: '30%',
    fontSize: 12.5,
    color: '#334155',
    minWidth: 0,
  },
  /** Empuja importes/estado a la derecha tras la columna de empresa. */
  detalleRowSpacer: { flex: 1, minWidth: 8 },
  /** Columna fija de empresa (alineación vertical entre filas). */
  empresaCol: {
    width: 132,
    flexShrink: 0,
    paddingHorizontal: 4,
    justifyContent: 'center',
  },
  empresaChip: {
    alignSelf: 'stretch',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  empresaChipText: { fontSize: 10, fontWeight: '600' },
  detalleImporte: { fontSize: 12.5, fontWeight: '600', color: '#0f172a', textAlign: 'right' },
  detalleImporteSec: { fontWeight: '400', color: '#94a3b8', fontSize: 11.5 },
  badgeMini: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  badgeMiniText: { fontSize: 10, fontWeight: '700' },
  detalleNota: { fontSize: 11, color: '#94a3b8', marginTop: 6, fontStyle: 'italic' },

  modalWrap: { width: '100%', maxWidth: 640, maxHeight: '88%' },
  modalCard: { width: '100%', backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#e2e8f0' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  modalSubtitle: { fontSize: 12, color: '#64748b', marginTop: 2 },
  modalThRow: { flexDirection: 'row', backgroundColor: '#f8fafc', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTh: { fontSize: 11, fontWeight: '700', color: '#64748b' },
  modalTr: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center' },
  modalTrAlt: { backgroundColor: '#f8fafc' },
  modalTd: { fontSize: 12, color: '#334155' },
  modalFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0', backgroundColor: '#f8fafc', flexWrap: 'wrap' },
  modalFooterMeta: { fontSize: 12, color: '#64748b', flex: 1 },
  modalFooterTotal: { fontSize: 13, fontWeight: '700', color: '#0369a1' },

  provNombreRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  compareBtn: {
    padding: 4,
    borderRadius: 6,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },

  compWrap: { width: '96%', maxWidth: 1200, flex: 1, alignSelf: 'center' },
  compCard: { flex: 1, backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#e2e8f0' },
  compBody: { flex: 1, flexDirection: 'row', gap: 0 },
  compPanel: { flex: 1, minWidth: 0, padding: 12, borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  compPanelApilado: { borderRightWidth: 0, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  compPanelTitle: { fontSize: 12, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 6 },
  compPanelPie: { fontSize: 11, color: '#94a3b8', fontStyle: 'italic', marginTop: 6 },

  compAlbBlock: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, marginBottom: 8, overflow: 'hidden' },
  compAlbHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 7, backgroundColor: '#f0f9ff' },
  compAlbTitulo: { flex: 1, fontSize: 12, fontWeight: '600', color: '#0f172a' },
  compAlbTotal: { fontSize: 12, fontWeight: '700', color: '#0369a1' },
  compLineaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 5 },
  compLineaProducto: { flex: 1, fontSize: 11.5, color: '#334155' },
  compLineaDato: { fontSize: 11.5, color: '#64748b', width: 70, textAlign: 'right' },

  compFactChips: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  compPreviewBox: { flex: 1, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#f8fafc' },
  compPreviewCentro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 20 },
  compAbrirBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: '#0ea5e9' },
  compAbrirBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },
});
