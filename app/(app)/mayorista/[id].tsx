import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Platform,
  Modal,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useProductosCache } from '../../contexts/ProductosCache';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { InputFecha } from '../../components/InputFecha';
import { estiloCampoFechaCompacto } from '../../components/RangoFechas';
import { apiFetch } from '../../utils/api';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { DocumentoProveedorPreview } from '../../components/mayorista/DocumentoProveedorPreview';
import { PostitTooltip } from '../../components/PostitTooltip';
import { LaserBorderWrap } from '../../components/ui/LaserBorderWrap';
import { useAppDialog } from '../../components/AppDialog';
import { useLocalToast } from '../../components/Toast';
import { formatEur, recalcularLineaUx, round2 } from '../../lib/mayoristaCalculos';
import { buildNombreOperacion } from '../../lib/mayoristaReferencia';
import { formatFecha } from '../../utils/formatFecha';

const KPI_AYUDAS: Record<string, string> = {
  Coste: 'Suma del coste neto de compra de todas las líneas (precio negociado × cantidad).',
  Venta: 'Importe total de venta al cliente (PVP unitario × cantidad de cada línea).',
  'Benef. com.': 'Beneficio comercial antes de descontar el coste financiero por aportación de acuerdos.',
  'Benef. neto': 'Beneficio comercial menos el coste financiero del capital inmovilizado.',
  Aportación: 'Dinero aportado por acuerdos comerciales vigentes aplicado en las líneas.',
  'Coste fin.': 'Coste del interés sobre la aportación hasta la fecha de cobro del acuerdo.',
  Markup: 'Porcentaje de beneficio comercial sobre el coste total de la operación.',
  Margen: 'Porcentaje de beneficio comercial sobre el importe total de venta.',
  'Rentab.': 'Rentabilidad neta sobre coste: beneficio neto dividido entre el coste total.',
};

const AYUDA_MARGEN_SCOSTE =
  'Porcentaje de beneficio sobre el coste que se aplica por defecto al añadir nuevas líneas de producto.';
const AYUDA_INTERES_SAPORT =
  'Tasa anual de interés sobre el dinero aportado por acuerdos comerciales hasta su fecha de cobro.';

type Cliente = { id: string; nombre: string; cif?: string; alias?: string };
type PrecioProv = {
  proveedor_id: string | null;
  proveedor_nombre: string;
  albaran_ref: string;
  albaran_fecha: string;
  price: number;
  discount_rate: number;
  cn: number;
  mejor_precio?: boolean;
  product_name?: string | null;
};
type AcuerdoVigente = {
  vigente: boolean;
  aportacion_unitaria: number;
  acuerdo_id: string | null;
  acuerdo_fecha_fin: string | null;
  acuerdo_marca: string | null;
};
type Linea = {
  id_linea: string;
  producto_id: string;
  product_name: string;
  marca?: string | null;
  proveedor_id?: string | null;
  proveedor_nombre?: string | null;
  albaran_ref?: string | null;
  albaran_fecha?: string | null;
  precio_albaran_original?: number | null;
  precio_compra_operacion?: number | null;
  es_precio_negociado?: boolean;
  descuento?: number;
  cantidad: number;
  pct_ganancia: number;
  pvp_unitario: number;
  tasa_capital?: number;
  aportacion_vigente?: boolean;
  aportacion_unitaria?: number;
  aportacion_asignada?: number;
  dias_cobro?: number;
  coste_neto?: number;
  pmr?: number;
  coste_financiero?: number;
  beneficio_comercial?: number;
  beneficio_neto?: number;
  alerta_nivel?: string;
  perdida_estimada?: number;
  alerta_aceptada?: boolean;
  /** IVA de compra del artículo (ultimo_iva_compra). */
  ultimo_iva_compra?: number | null;
  _modo_edicion?: 'pct' | 'pvp';
  _histPvp?: number | null;
};
type Negociacion = {
  id: string;
  numero_operacion?: number;
  nombre?: string;
  cliente_id?: string;
  cliente_nombre?: string;
  recogida_empresa_id?: string;
  recogida_empresa_nombre?: string;
  recogida_fecha?: string;
  recogida_hora?: string;
  fecha?: string;
  estado?: string;
  pct_ganancia_defecto?: number;
  tasa_capital?: number;
  coste_total?: number;
  venta_total?: number;
  beneficio_comercial?: number;
  aportacion_total?: number;
  coste_financiero_total?: number;
  beneficio_neto?: number;
  markup_pct?: number;
  margen_pct?: number;
  rentabilidad_neta_pct?: number;
  semaforo?: string;
};

function validarAntesConfirmar(neg: Negociacion, lineas: Linea[]): string[] {
  const errores: string[] = [];
  if (!String(neg.cliente_id || '').trim()) errores.push('Cliente es obligatorio.');
  if (!String(neg.nombre || '').trim()) errores.push('Referencia es obligatoria.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(neg.fecha || ''))) errores.push('Fecha es obligatoria.');
  if (!String(neg.recogida_empresa_id || '').trim()) errores.push('Recogida en es obligatorio.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(neg.recogida_fecha || ''))) errores.push('Fecha recogida es obligatoria.');
  if (lineas.length === 0) errores.push('Debe haber al menos una línea de producto.');

  for (const l of lineas) {
    const provNombre = String(l.proveedor_nombre || '').trim();
    const provId = String(l.proveedor_id || '').trim();
    if (!provNombre && !provId) {
      errores.push(`Línea «${l.product_name || l.producto_id}»: falta proveedor.`);
    }
  }

  return errores;
}

function validarAntesGuardar(neg: Negociacion, lineas: Linea[]): string[] {
  const errores: string[] = [];
  if (!String(neg.cliente_id || '').trim()) errores.push('Cliente es obligatorio.');
  if (lineas.length === 0) errores.push('Debe haber al menos una línea de producto.');
  return errores;
}

/** Avisos no bloqueantes: proveedor de línea ≠ recogida en. */
function avisosProveedorRecogida(neg: Negociacion, lineas: Linea[]): string[] {
  const avisos: string[] = [];
  const recogidaNombre = String(neg.recogida_empresa_nombre || '').trim().toLowerCase();
  const recogidaId = String(neg.recogida_empresa_id || '').trim();
  if (!recogidaId && !recogidaNombre) return avisos;

  for (const l of lineas) {
    const provNombre = String(l.proveedor_nombre || '').trim().toLowerCase();
    const provId = String(l.proveedor_id || '').trim();
    if (!provNombre && !provId) continue;
    const coincideId = Boolean(recogidaId && provId && recogidaId === provId);
    const coincideNombre = Boolean(recogidaNombre && provNombre && recogidaNombre === provNombre);
    if (!coincideId && !coincideNombre) {
      avisos.push(
        `Línea «${l.product_name || l.producto_id}»: el proveedor «${l.proveedor_nombre || '—'}» no coincide con recogida en «${neg.recogida_empresa_nombre || '—'}».`,
      );
    }
  }
  return avisos;
}

function hoyIsoLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function negociacionNuevaVacia(
  cfg: { pct_ganancia_defecto: number; tasa_capital_default: number },
  numeroOperacion?: number,
): Negociacion {
  const fecha = hoyIsoLocal();
  const numero = numeroOperacion;
  return {
    id: '',
    estado: 'borrador',
    fecha,
    numero_operacion: numero,
    nombre: buildNombreOperacion(numero, '', fecha),
    pct_ganancia_defecto: cfg.pct_ganancia_defecto ?? 0,
    tasa_capital: cfg.tasa_capital_default ?? 0.08,
    cliente_id: '',
    cliente_nombre: '',
    recogida_empresa_id: '',
    recogida_empresa_nombre: '',
    recogida_fecha: '',
    recogida_hora: '',
  };
}

function estadoLabel(s?: string) {
  if (s === 'confirmada') return 'Confirmada';
  if (s === 'facturada') return 'Facturada';
  if (s === 'pagada') return 'Pagada';
  return 'Borrador';
}

/** Tasa almacenada como fracción (0.08) ↔ % en UI (8). */
function tasaToPct(t?: number | null) {
  const n = Number(t);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 10000) / 100);
}
function pctToTasa(raw: string) {
  const n = parseFloat(String(raw).replace(',', '.'));
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

function normalizarHoraInput(raw: string) {
  const t = raw.trim();
  if (!t) return '';
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t.slice(0, 5);
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

function productoIdDe(p: Record<string, unknown>) {
  return String(p.Id ?? p.id ?? p.Code ?? p.code ?? p.id_producto ?? '').trim();
}
function productoNombreDe(p: Record<string, unknown>) {
  return String(p.Name ?? p.Nombre ?? p.nombre ?? p.ProductName ?? p.Description ?? productoIdDe(p)).trim();
}
function ivaCompraDeProducto(p: Record<string, unknown> | undefined | null): number | null {
  if (!p) return null;
  const raw = p.ultimo_iva_compra ?? p.ULTIMO_IVA_COMPRA ?? p.PurchaseVatPercent ?? p.VatPercent;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function formatIvaPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)}%`;
}

function recalcLineaFields(
  cur: Linea,
  neg: Negociacion | null,
  cfg: { tasa_capital_default: number },
): Linea {
  const pc = round2(Number(cur.precio_compra_operacion ?? cur.precio_albaran_original) || 0);
  const ux = recalcularLineaUx({
    precioCompra: pc,
    descuentoImporte: Number(cur.descuento) || 0,
    cantidad: Number(cur.cantidad) || 0,
    pctGanancia: Number(cur.pct_ganancia),
    pvpUnitario: Number(cur.pvp_unitario),
    aportacionUnitaria: Number(cur.aportacion_unitaria) || 0,
    tasaCapital: Number(cur.tasa_capital ?? neg?.tasa_capital ?? cfg.tasa_capital_default),
    diasCobro: Number(cur.dias_cobro) || 0,
    modoEdicion: 'pvp',
  });
  return {
    ...cur,
    precio_compra_operacion: pc,
    coste_neto: round2(ux.coste_neto),
    pmr: round2(ux.pmr),
    pct_ganancia: ux.pct_ganancia,
    // Mk.% virtual: se deriva; el PVP del input no se reescribe desde el %.
    pvp_unitario: round2(ux.pvp_unitario),
    aportacion_asignada: ux.aportacion_asignada,
    coste_financiero: ux.coste_financiero,
    beneficio_comercial: ux.beneficio_comercial,
    beneficio_neto: ux.beneficio_neto,
    alerta_nivel: ux.alerta_nivel,
    perdida_estimada: ux.perdida_estimada,
  };
}

function mergeAcuerdoEnLinea(
  l: Linea,
  acuerdo: AcuerdoVigente,
  diasCobro: number,
  neg: Negociacion | null,
  cfg: { tasa_capital_default: number },
): Linea {
  return recalcLineaFields({
    ...l,
    aportacion_vigente: acuerdo.vigente,
    aportacion_unitaria: Number(acuerdo.aportacion_unitaria) || 0,
    dias_cobro: diasCobro,
    marca: acuerdo.acuerdo_marca || l.marca,
  }, neg, cfg);
}

export default function MayoristaDetalleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { productosIgp, loading: loadingProductos, recargar: recargarProductos, lastFetch } = useProductosCache();
  const puedeEditar = hasPermiso('mayorista.editar');
  const puedeConfirmar = hasPermiso('mayorista.confirmar');
  const puedeCrear = hasPermiso('mayorista.crear');
  const puedeExportar = hasPermiso('mayorista.exportar');
  const { shouldStackPanels } = useBreakpoint();
  const { aviso, avisoErrores, confirmar: confirmarDialog, dialog } = useAppDialog();
  const { show: showToast, ToastView } = useLocalToast();

  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [neg, setNeg] = useState<Negociacion | null>(null);
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [config, setConfig] = useState({ pct_ganancia_defecto: 0, tasa_capital_default: 0.08 });

  const [prodModal, setProdModal] = useState(false);
  const [prodQ, setProdQ] = useState('');
  const [provModalIdx, setProvModalIdx] = useState<number | null>(null);
  const [provPrecios, setProvPrecios] = useState<PrecioProv[]>([]);
  const [provLoading, setProvLoading] = useState(false);
  const nombreManualRef = useRef(false);
  const esNuevo = id === 'nuevo';

  const esBorrador = esNuevo || neg?.estado === 'borrador';
  const esConfirmada = !esNuevo && neg?.estado === 'confirmada';
  const esFacturada = !esNuevo && neg?.estado === 'facturada';
  const editable = esNuevo ? (puedeCrear || puedeEditar) : Boolean(esBorrador && puedeEditar);

  useEffect(() => {
    if (!lastFetch) void recargarProductos();
  }, [lastFetch, recargarProductos]);

  const catalogoProductos = useMemo(
    () => productosIgp.map((p) => ({
      id: productoIdDe(p as Record<string, unknown>),
      nombre: productoNombreDe(p as Record<string, unknown>),
      ultimo_iva_compra: ivaCompraDeProducto(p as Record<string, unknown>),
    })).filter((p) => p.id),
    [productosIgp],
  );

  const ivaPorProductoId = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const p of catalogoProductos) m.set(p.id, p.ultimo_iva_compra);
    return m;
  }, [catalogoProductos]);

  const ivaDeLinea = useCallback((l: Linea): number | null => {
    if (l.ultimo_iva_compra != null && Number.isFinite(Number(l.ultimo_iva_compra))) {
      return Number(l.ultimo_iva_compra);
    }
    return ivaPorProductoId.get(String(l.producto_id || '')) ?? null;
  }, [ivaPorProductoId]);

  const prodHits = useMemo(() => {
    const qq = prodQ.trim().toLowerCase();
    if (!qq) return catalogoProductos.slice(0, 50);
    return catalogoProductos
      .filter((p) => p.nombre.toLowerCase().includes(qq) || p.id.toLowerCase().includes(qq))
      .slice(0, 50);
  }, [catalogoProductos, prodQ]);

  const cargar = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      if (esNuevo) {
        if (!puedeCrear) {
          setError('No tienes permiso para crear operaciones.');
          setNeg(null);
          setLineas([]);
          return;
        }
        const [rCli, rCfg, rNum] = await Promise.all([
          apiFetch('/api/mayorista/clientes'),
          apiFetch('/api/mayorista/config'),
          apiFetch('/api/mayorista/negociaciones/siguiente-numero'),
        ]);
        const dCli = await rCli.json();
        const dCfg = await rCfg.json();
        const dNum = await rNum.json();
        const cfg = dCfg.config
          ? {
              pct_ganancia_defecto: Number.isFinite(Number(dCfg.config.pct_ganancia_defecto))
                ? Number(dCfg.config.pct_ganancia_defecto)
                : 0,
              tasa_capital_default: Number(dCfg.config.tasa_capital_default) || 0.08,
            }
          : { pct_ganancia_defecto: 0, tasa_capital_default: 0.08 };
        const numeroOperacion = rNum.ok && dNum.numero_operacion != null
          ? Number(dNum.numero_operacion)
          : undefined;
        setConfig(cfg);
        setClientes(dCli.clientes || []);
        nombreManualRef.current = false;
        setNeg(negociacionNuevaVacia(cfg, numeroOperacion));
        setLineas([]);
        return;
      }

      const [rNeg, rCli, rCfg] = await Promise.all([
        apiFetch(`/api/mayorista/negociaciones/${id}`),
        apiFetch('/api/mayorista/clientes'),
        apiFetch('/api/mayorista/config'),
      ]);
      const dNeg = await rNeg.json();
      const dCli = await rCli.json();
      const dCfg = await rCfg.json();
      if (!rNeg.ok) { setError(dNeg.error || 'No se pudo cargar'); return; }
      const negLoaded = dNeg.negociacion as Negociacion;
      if (negLoaded?.numero_operacion) {
        const esperado = buildNombreOperacion(negLoaded.numero_operacion, negLoaded.cliente_nombre, negLoaded.fecha);
        nombreManualRef.current = Boolean(negLoaded.nombre && negLoaded.nombre !== esperado);
      } else {
        nombreManualRef.current = false;
      }
      setNeg(negLoaded);
      setLineas(dNeg.lineas || []);
      setClientes(dCli.clientes || []);
      if (dCfg.config) setConfig(dCfg.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setLoading(false);
    }
  }, [id, esNuevo, puedeCrear]);

  useEffect(() => { void cargar(); }, [cargar]);

  const refrescarHistorico = useCallback(async (lista: Linea[], negId: string) => {
    const out = [...lista];
    await Promise.all(out.map(async (l, i) => {
      if (!l.producto_id) return;
      try {
        const q = new URLSearchParams({ excluirNegociacionId: negId });
        if (l.proveedor_id) q.set('proveedorId', l.proveedor_id);
        const r = await apiFetch(`/api/mayorista/productos/${encodeURIComponent(l.producto_id)}/ultima-venta?${q}`);
        const d = await r.json();
        out[i] = { ...out[i], _histPvp: d.encontrada ? Number(d.venta?.pvp_unitario) : null };
      } catch {
        out[i] = { ...out[i], _histPvp: null };
      }
    }));
    setLineas(out);
  }, []);

  useEffect(() => {
    if (neg?.id && lineas.length) void refrescarHistorico(lineas, neg.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neg?.id]);

  const kpisLocales = useMemo(() => {
    let coste = 0;
    let venta = 0;
    let benef = 0;
    let aport = 0;
    let fin = 0;
    for (const l of lineas) {
      const ux = recalcularLineaUx({
        precioCompra: Number(l.precio_compra_operacion ?? l.precio_albaran_original) || 0,
        descuentoImporte: Number(l.descuento) || 0,
        cantidad: Number(l.cantidad) || 0,
        pctGanancia: Number(l.pct_ganancia),
        pvpUnitario: Number(l.pvp_unitario),
        aportacionUnitaria: Number(l.aportacion_unitaria) || 0,
        tasaCapital: Number(l.tasa_capital ?? neg?.tasa_capital ?? config.tasa_capital_default),
        diasCobro: Number(l.dias_cobro) || 0,
        modoEdicion: 'pvp',
      });
      coste += ux.coste_neto * (Number(l.cantidad) || 0);
      venta += ux.pvp_unitario * (Number(l.cantidad) || 0);
      benef += ux.beneficio_comercial;
      aport += ux.aportacion_asignada;
      fin += ux.coste_financiero;
    }
    const neto = benef - fin;
    return {
      coste_total: coste,
      venta_total: venta,
      beneficio_comercial: benef,
      aportacion_total: aport,
      coste_financiero_total: fin,
      beneficio_neto: neto,
      markup_pct: coste > 0 ? (benef / coste) * 100 : 0,
      margen_pct: venta > 0 ? (benef / venta) * 100 : 0,
      rentabilidad_neta_pct: coste > 0 ? (neto / coste) * 100 : 0,
    };
  }, [lineas, neg?.tasa_capital, config.tasa_capital_default]);

  const patchLinea = (idx: number, patch: Partial<Linea>) => {
    setLineas((prev) => {
      const next = [...prev];
      next[idx] = recalcLineaFields({ ...next[idx], ...patch }, neg, config);
      return next;
    });
  };

  const fetchAcuerdoProducto = useCallback(async (productId: string, fecha: string) => {
    const r = await apiFetch(
      `/api/mayorista/productos/${encodeURIComponent(productId)}/acuerdo-vigente?fecha=${encodeURIComponent(fecha)}`,
    );
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'No se pudo resolver acuerdo');
    return d as { acuerdo: AcuerdoVigente; dias_cobro: number };
  }, []);

  const refrescarAcuerdosLineas = useCallback(async (fecha: string, base?: Linea[]) => {
    const lista = base ?? lineas;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || lista.length === 0) return lista;
    const out = await Promise.all(lista.map(async (l) => {
      if (!l.producto_id) return l;
      try {
        const { acuerdo, dias_cobro } = await fetchAcuerdoProducto(l.producto_id, fecha);
        return mergeAcuerdoEnLinea(l, acuerdo, dias_cobro, neg, config);
      } catch {
        return l;
      }
    }));
    setLineas(out);
    return out;
  }, [lineas, neg, config, fetchAcuerdoProducto]);

  const acuerdoInitRef = useRef(false);
  useEffect(() => {
    if (loading || acuerdoInitRef.current || !editable || !neg?.fecha || lineas.length === 0) return;
    acuerdoInitRef.current = true;
    void refrescarAcuerdosLineas(neg.fecha);
  }, [loading, editable, neg?.fecha, lineas.length, refrescarAcuerdosLineas]);

  const abrirModalProveedor = async (idx: number) => {
    const l = lineas[idx];
    if (!l?.producto_id) return;
    setProvModalIdx(idx);
    setProvLoading(true);
    setProvPrecios([]);
    try {
      const r = await apiFetch(`/api/mayorista/productos/${encodeURIComponent(l.producto_id)}/precios-proveedor`);
      const d = await r.json();
      if (!r.ok) { aviso(d.error || 'No se pudieron cargar precios'); setProvModalIdx(null); return; }
      setProvPrecios(d.precios || []);
    } catch (e) {
      aviso(e instanceof Error ? e.message : 'Error al cargar proveedores');
      setProvModalIdx(null);
    } finally {
      setProvLoading(false);
    }
  };

  const seleccionarProveedor = (p: PrecioProv) => {
    if (provModalIdx == null) return;
    const idx = provModalIdx;
    const cn = round2(Number(p.cn) || 0);
    patchLinea(idx, {
      proveedor_id: p.proveedor_id,
      proveedor_nombre: p.proveedor_nombre,
      albaran_ref: p.albaran_ref,
      albaran_fecha: p.albaran_fecha,
      precio_albaran_original: cn,
      precio_compra_operacion: cn,
      es_precio_negociado: false,
      descuento: 0,
      _modo_edicion: 'pvp',
    });
    setProvModalIdx(null);
    setProvPrecios([]);
  };

  const anadirProducto = async (prod: { id: string; nombre: string; ultimo_iva_compra?: number | null }) => {
    setProdModal(false);
    setProdQ('');
    try {
      const r = await apiFetch(`/api/mayorista/productos/${encodeURIComponent(prod.id)}/precios-proveedor`);
      const d = await r.json();
      const precios: PrecioProv[] = d.precios || [];
      const mejor = precios.find((p) => p.mejor_precio) || precios[0];
      const cn = round2(mejor?.cn ?? 0);
      const iva = prod.ultimo_iva_compra ?? ivaPorProductoId.get(prod.id) ?? null;
      let nueva: Linea = {
        id_linea: `tmp-${Date.now()}`,
        producto_id: prod.id,
        product_name: mejor?.product_name || prod.nombre,
        proveedor_id: mejor?.proveedor_id ?? null,
        proveedor_nombre: mejor?.proveedor_nombre ?? null,
        albaran_ref: mejor?.albaran_ref ?? null,
        albaran_fecha: mejor?.albaran_fecha ?? null,
        precio_albaran_original: cn,
        precio_compra_operacion: cn,
        es_precio_negociado: false,
        descuento: 0,
        cantidad: 1,
        pct_ganancia: 0,
        // Mk.% virtual: PVP inicial = coste; el % se deriva al recalcular.
        pvp_unitario: cn,
        tasa_capital: neg?.tasa_capital,
        aportacion_vigente: false,
        aportacion_unitaria: 0,
        dias_cobro: 0,
        ultimo_iva_compra: iva,
        _modo_edicion: 'pvp',
      };
      nueva = recalcLineaFields(nueva, neg, config);
      const fecha = neg?.fecha || '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        try {
          const { acuerdo, dias_cobro } = await fetchAcuerdoProducto(prod.id, fecha);
          nueva = mergeAcuerdoEnLinea(nueva, acuerdo, dias_cobro, neg, config);
        } catch { /* sin acuerdo */ }
      }
      setLineas((prev) => [...prev, nueva]);
      if (neg?.id) void refrescarHistorico([...lineas, nueva], neg.id);
      if (!mejor) aviso('Producto añadido sin precio de compra. Elige proveedor o indica el coste a mano.');
    } catch (e) {
      aviso(e instanceof Error ? e.message : 'No se pudieron cargar precios');
    }
  };

  const payloadCabecera = () => ({
    cliente_id: neg?.cliente_id,
    cliente_nombre: neg?.cliente_nombre,
    recogida_empresa_id: neg?.recogida_empresa_id,
    recogida_empresa_nombre: neg?.recogida_empresa_nombre,
    recogida_fecha: neg?.recogida_fecha,
    recogida_hora: neg?.recogida_hora,
    fecha: neg?.fecha,
    nombre: neg?.nombre,
    nombre_manual: nombreManualRef.current,
    pct_ganancia_defecto: neg?.pct_ganancia_defecto ?? config.pct_ganancia_defecto ?? 0,
    tasa_capital: neg?.tasa_capital,
    lineas: lineas.map((l) => ({
      ...l,
      ultimo_iva_compra: ivaDeLinea(l),
      _modo_edicion: 'pvp' as const,
    })),
  });

  const aceptarAvisosProveedor = async (n: Negociacion, lista: Linea[], accion: 'guardar' | 'confirmar') => {
    const avisos = avisosProveedorRecogida(n, lista);
    if (!avisos.length) return true;
    return confirmarDialog(
      accion === 'guardar' ? 'Guardar con avisos' : 'Confirmar con avisos',
      'Hay líneas cuyo proveedor no coincide con «Recogida en». ¿Continuar de todos modos?',
      { confirmLabel: accion === 'guardar' ? 'Guardar igual' : 'Confirmar igual', errores: avisos },
    );
  };

  const persistirBorrador = async (): Promise<{ negociacion: Negociacion; lineas: Linea[] } | null> => {
    if (!neg) return null;
    const body = JSON.stringify(payloadCabecera());
    const r = esNuevo || !neg.id
      ? await apiFetch('/api/mayorista/negociaciones', { method: 'POST', body })
      : await apiFetch(`/api/mayorista/negociaciones/${neg.id}`, { method: 'PUT', body });
    const d = await r.json();
    if (!r.ok) {
      setError(d.error || 'Error al guardar');
      return null;
    }
    return { negociacion: d.negociacion as Negociacion, lineas: (d.lineas || []) as Linea[] };
  };

  const guardar = async () => {
    if (!neg || !esBorrador) return;
    if (esNuevo && !puedeCrear) {
      aviso('No tienes permiso para crear operaciones.');
      return;
    }
    const erroresVal = validarAntesGuardar(neg, lineas);
    if (erroresVal.length) {
      avisoErrores('No se puede guardar', erroresVal);
      return;
    }
    const okAvisos = await aceptarAvisosProveedor(neg, lineas, 'guardar');
    if (!okAvisos) return;

    setGuardando(true);
    setError(null);
    try {
      const saved = await persistirBorrador();
      if (!saved) return;
      setNeg(saved.negociacion);
      setLineas(saved.lineas);
      if (saved.negociacion?.id) void refrescarHistorico(saved.lineas, saved.negociacion.id);
      showToast('Guardado', 'Operación guardada correctamente.', 'success');
      if (esNuevo && saved.negociacion?.id) {
        router.replace(`/mayorista/${saved.negociacion.id}` as never);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const confirmar = async () => {
    if (!neg || !esBorrador) return;
    if (esNuevo && !puedeCrear) {
      aviso('No tienes permiso para crear operaciones.');
      return;
    }
    const erroresVal = validarAntesConfirmar(neg, lineas);
    if (erroresVal.length) {
      avisoErrores('No se puede confirmar', erroresVal);
      return;
    }
    const okAvisos = await aceptarAvisosProveedor(neg, lineas, 'confirmar');
    if (!okAvisos) return;

    setGuardando(true);
    setError(null);
    try {
      const saved = await persistirBorrador();
      if (!saved) return;
      const negId = saved.negociacion.id;
      const lineasSrv = saved.lineas;
      setNeg(saved.negociacion);
      setLineas(lineasSrv);

      const rojos = lineasSrv.filter((l) => l.alerta_nivel === 'rojo');
      if (rojos.length) {
        const perdida = rojos.reduce((s, l) => s + (Number(l.perdida_estimada) || 0), 0);
        const ok = await confirmarDialog(
          'Confirmar operación',
          `Vas a vender por debajo de coste en ${rojos.length} línea(s). Pérdida estimada ${formatEur(perdida)}. ¿Confirmar?`,
          { confirmLabel: 'Confirmar', destructive: true },
        );
        if (!ok) {
          if (esNuevo && negId) router.replace(`/mayorista/${negId}` as never);
          return;
        }
      }

      const r = await apiFetch(`/api/mayorista/negociaciones/${negId}/confirmar`, {
        method: 'POST',
        body: JSON.stringify({ lineas_alerta_aceptada: rojos.map((l) => l.id_linea) }),
      });
      const d = await r.json();
      if (!r.ok) {
        if (esNuevo && negId) router.replace(`/mayorista/${negId}` as never);
        aviso(d.error || 'No se pudo confirmar');
        return;
      }
      setNeg(d.negociacion);
      setLineas(d.lineas || []);
      showToast('Confirmada', 'La operación ha sido confirmada.', 'success');
      if (esNuevo && negId) router.replace(`/mayorista/${negId}` as never);
    } catch (e) {
      aviso(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const duplicar = async () => {
    if (!neg) return;
    try {
      const r = await apiFetch(`/api/mayorista/negociaciones/${neg.id}/duplicar`, { method: 'POST', body: '{}' });
      const d = await r.json();
      if (!r.ok) { aviso(d.error || 'No se pudo duplicar'); return; }
      router.replace(`/mayorista/${d.negociacion.id}` as never);
    } catch (e) {
      aviso(e instanceof Error ? e.message : 'Error');
    }
  };

  const facturar = async () => {
    if (!neg?.id || neg.estado !== 'confirmada' || !puedeEditar) return;
    const ok = await confirmarDialog(
      'Marcar como facturada',
      `¿Marcar «${neg.nombre || neg.id}» como facturada?`,
      { confirmLabel: 'Facturar' },
    );
    if (!ok) return;
    setGuardando(true);
    try {
      const r = await apiFetch(`/api/mayorista/negociaciones/${neg.id}/facturar`, { method: 'POST', body: '{}' });
      const d = await r.json();
      if (!r.ok) { aviso(d.error || 'No se pudo facturar'); return; }
      setNeg(d.negociacion);
      setLineas(d.lineas || []);
      showToast('Facturada', 'Operación marcada como facturada.', 'success');
    } catch (e) {
      aviso(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const marcarPagada = async () => {
    if (!neg?.id || neg.estado !== 'facturada' || !puedeEditar) return;
    const ok = await confirmarDialog(
      'Marcar como pagada',
      `¿Marcar «${neg.nombre || neg.id}» como pagada?`,
      { confirmLabel: 'Marcar pagada' },
    );
    if (!ok) return;
    setGuardando(true);
    try {
      const r = await apiFetch(`/api/mayorista/negociaciones/${neg.id}/pagar`, { method: 'POST', body: '{}' });
      const d = await r.json();
      if (!r.ok) { aviso(d.error || 'No se pudo marcar como pagada'); return; }
      setNeg(d.negociacion);
      setLineas(d.lineas || []);
      showToast('Pagada', 'Operación marcada como pagada.', 'success');
    } catch (e) {
      aviso(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  };

  const semColor = neg?.semaforo === 'verde' ? '#16a34a' : neg?.semaforo === 'ambar' ? '#d97706' : '#dc2626';
  const clientesOpts = useMemo(
    () => clientes.map((c) => ({
      id: c.id,
      titulo: c.nombre || c.id,
      subtitulo: [c.cif ? `CIF ${c.cif}` : '', c.alias].filter(Boolean).join(' · ') || undefined,
      icono: 'business' as const,
    })),
    [clientes],
  );

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color="#0ea5e9" size="large" /></View>;
  }
  const volver = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/mayorista' as never);
  };

  if (!neg) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error || 'Operación no encontrada'}</Text>
        <TouchableOpacity onPress={volver}><Text style={styles.link}>Volver</Text></TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={volver} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>{neg.nombre || 'Operación'}</Text>
          <View style={styles.headerMeta}>
            <Text style={styles.headerMetaText}>{estadoLabel(neg.estado)}</Text>
            <View style={[styles.dotSem, { backgroundColor: semColor }]} />
            <Text style={styles.headerMetaText}>Rentab. {kpisLocales.rentabilidad_neta_pct.toFixed(1)}%</Text>
          </View>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBar}>
          <MaterialIcons name="error-outline" size={14} color="#dc2626" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.detailInfoSection}>
          <View style={styles.infoRowSingle}>
            <View style={[styles.infoCell, styles.infoCellCliente]}>
              <Text style={styles.detailInfoLabel}>Cliente</Text>
              <SelectorDesplegable
                compact
                placeholder="Empresa…"
                icono="business"
                tituloLista="Cliente (empresa)"
                buscador
                buscadorPlaceholder="Nombre o CIF…"
                valorId={neg.cliente_id || ''}
                opciones={clientesOpts}
                onSeleccionar={(cid) => {
                  const c = clientes.find((x) => x.id === cid);
                  setNeg((n) => {
                    if (!n) return n;
                    const next = { ...n, cliente_id: cid, cliente_nombre: c?.nombre || '' };
                    if (!nombreManualRef.current) {
                      next.nombre = buildNombreOperacion(n.numero_operacion, c?.nombre, n.fecha);
                    }
                    return next;
                  });
                }}
                disabled={!editable}
              />
            </View>
            <View style={[styles.infoCell, styles.infoCellRef]}>
              <Text style={styles.detailInfoLabel}>Referencia</Text>
              <TextInput
                style={styles.inputCompact}
                value={neg.nombre || ''}
                editable={editable}
                onChangeText={(v) => {
                  nombreManualRef.current = true;
                  setNeg((n) => (n ? { ...n, nombre: v } : n));
                }}
                placeholder="Nombre op."
                placeholderTextColor="#94a3b8"
              />
            </View>
            <View style={[styles.infoCell, styles.infoCellFecha]}>
              <Text style={styles.detailInfoLabel}>Fecha</Text>
              <InputFecha
                compact
                valueIso={neg.fecha || ''}
                onChangeIso={(f) => {
                  setNeg((n) => {
                    if (!n) return n;
                    const next = { ...n, fecha: f };
                    if (!nombreManualRef.current) {
                      next.nombre = buildNombreOperacion(n.numero_operacion, n.cliente_nombre, f);
                    }
                    return next;
                  });
                  if (editable && lineas.length > 0) void refrescarAcuerdosLineas(f);
                }}
                style={[estiloCampoFechaCompacto, styles.inputFechaToolbar]}
                editable={editable}
              />
            </View>
            <View style={[styles.infoCell, styles.infoCellPct]}>
              <PostitTooltip text={AYUDA_MARGEN_SCOSTE}>
                <Text style={[styles.detailInfoLabel, styles.detailInfoLabelHighlight]} numberOfLines={1}>Margen s/coste</Text>
              </PostitTooltip>
              <TextInput
                style={[styles.inputCompact, styles.inputHighlight]}
                keyboardType="decimal-pad"
                value={String(neg.pct_ganancia_defecto ?? config.pct_ganancia_defecto ?? 0)}
                editable={editable}
                onChangeText={(v) => setNeg((n) => (n ? { ...n, pct_ganancia_defecto: parseFloat(v.replace(',', '.')) || 0 } : n))}
              />
            </View>
            <View style={[styles.infoCell, styles.infoCellPct]}>
              <PostitTooltip text={AYUDA_INTERES_SAPORT}>
                <Text style={[styles.detailInfoLabel, styles.detailInfoLabelHighlight]} numberOfLines={1}>Interés s/aport.</Text>
              </PostitTooltip>
              <TextInput
                style={[styles.inputCompact, styles.inputHighlight]}
                keyboardType="decimal-pad"
                value={tasaToPct(neg.tasa_capital)}
                editable={editable}
                onChangeText={(v) => setNeg((n) => (n ? { ...n, tasa_capital: pctToTasa(v) } : n))}
              />
            </View>
          </View>
          <View style={[styles.infoRowSingle, styles.infoRowRecogida]}>
            <View style={[styles.infoCell, styles.infoCellCliente]}>
              <Text style={styles.detailInfoLabel}>Recogida en</Text>
              <SelectorDesplegable
                compact
                placeholder="Empresa…"
                icono="store"
                tituloLista="Empresa de recogida"
                buscador
                buscadorPlaceholder="Nombre o CIF…"
                valorId={neg.recogida_empresa_id || ''}
                opciones={clientesOpts}
                onSeleccionar={(eid) => {
                  const e = clientes.find((x) => x.id === eid);
                  setNeg((n) => (n ? {
                    ...n,
                    recogida_empresa_id: eid,
                    recogida_empresa_nombre: e?.nombre || '',
                  } : n));
                }}
                disabled={!editable}
              />
            </View>
            <View style={[styles.infoCell, styles.infoCellFechaRec]}>
              <Text style={styles.detailInfoLabel}>Fecha recogida</Text>
              <InputFecha
                compact
                valueIso={neg.recogida_fecha || ''}
                onChangeIso={(f) => setNeg((n) => (n ? { ...n, recogida_fecha: f } : n))}
                style={[estiloCampoFechaCompacto, styles.inputFechaToolbar]}
                editable={editable}
              />
            </View>
            <View style={[styles.infoCell, styles.infoCellHora]}>
              <Text style={styles.detailInfoLabel}>Hora</Text>
              <TextInput
                style={styles.inputCompact}
                value={neg.recogida_hora || ''}
                editable={editable}
                placeholder="HH:mm"
                placeholderTextColor="#94a3b8"
                keyboardType={Platform.OS === 'web' ? 'default' : 'numbers-and-punctuation'}
                maxLength={5}
                onChangeText={(v) => setNeg((n) => (n ? { ...n, recogida_hora: v } : n))}
                onBlur={() => {
                  setNeg((n) => (n ? { ...n, recogida_hora: normalizarHoraInput(n.recogida_hora || '') } : n));
                }}
                {...(Platform.OS === 'web' ? { type: 'time' as const } : {})}
              />
            </View>
          </View>
        </View>

        <View style={styles.totalesSection}>
          <View style={styles.totalesRow}>
            <TotalMini label="Coste" value={formatEur(kpisLocales.coste_total)} hint={KPI_AYUDAS.Coste} />
            <TotalMini label="Venta" value={formatEur(kpisLocales.venta_total)} accent hint={KPI_AYUDAS.Venta} />
            <TotalMini label="Benef. com." value={formatEur(kpisLocales.beneficio_comercial)} glowValue={kpisLocales.beneficio_comercial} hint={KPI_AYUDAS['Benef. com.']} />
            <TotalMini label="Benef. neto" value={formatEur(kpisLocales.beneficio_neto)} positive hint={KPI_AYUDAS['Benef. neto']} />
            <TotalMini label="Aportación" value={formatEur(kpisLocales.aportacion_total)} hint={KPI_AYUDAS.Aportación} />
            <TotalMini label="Coste fin." value={formatEur(kpisLocales.coste_financiero_total)} hint={KPI_AYUDAS['Coste fin.']} />
            <TotalMini label="Markup" value={`${kpisLocales.markup_pct.toFixed(1)}%`} hint={KPI_AYUDAS.Markup} />
            <TotalMini label="Margen" value={`${kpisLocales.margen_pct.toFixed(1)}%`} glowValue={kpisLocales.margen_pct} hint={KPI_AYUDAS.Margen} />
            <TotalMini label="Rentab." value={`${kpisLocales.rentabilidad_neta_pct.toFixed(2)}%`} hint={KPI_AYUDAS['Rentab.']} />
          </View>
        </View>

        <View style={[styles.splitRow, shouldStackPanels && styles.splitRowStack]}>
          <View style={styles.panelLineas}>
            <View style={styles.detailProductsHeader}>
              <Text style={styles.detailProductsSectionTitle}>
                Líneas de producto ({lineas.length})
              </Text>
              {editable ? (
                <TouchableOpacity
                  style={styles.detailAddBtn}
                  onPress={() => { setProdQ(''); setProdModal(true); if (!lastFetch) void recargarProductos(); }}
                >
                  <MaterialIcons name="add" size={14} color="#0ea5e9" />
                  <Text style={styles.detailAddBtnText}>Añadir</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {lineas.length === 0 ? (
              <Text style={styles.detailEmpty}>Sin productos. Pulsa Añadir para empezar.</Text>
            ) : (
              <View style={styles.detailTableWrap}>
                <View style={styles.detailTableHeader}>
                  <View style={styles.colProd}><Text style={styles.detailTableHeaderText}>Producto</Text></View>
                  <View style={styles.colProv}><Text style={styles.detailTableHeaderText}>Proveedor</Text></View>
                  <View style={styles.colNum}><Text style={styles.detailTableHeaderText}>Coste</Text></View>
                  <View style={styles.colNumSm}><Text style={styles.detailTableHeaderText}>Cant.</Text></View>
                  <View style={styles.colNum}><Text style={[styles.detailTableHeaderText, styles.pmrHeaderText]}>PMR</Text></View>
                  <View style={styles.colNumSm}><Text style={styles.detailTableHeaderText}>Mk.%</Text></View>
                  <View style={styles.colNum}><Text style={styles.detailTableHeaderText}>PVP</Text></View>
                  <View style={styles.colAport}><Text style={styles.detailTableHeaderText}>Aport.</Text></View>
                  <View style={styles.colNum}><Text style={styles.detailTableHeaderText}>Neto</Text></View>
                  <View style={styles.colAct} />
                </View>
                {lineas.map((l, idx) => {
                  const hist = l._histPvp;
                  const pvp = Number(l.pvp_unitario) || 0;
                  let histColor = '#94a3b8';
                  if (hist != null && Number.isFinite(hist)) {
                    if (pvp < hist - 0.0001) histColor = '#dc2626';
                    else if (pvp > hist + 0.0001) histColor = '#16a34a';
                  }
                  const aportUd = Number(l.aportacion_unitaria) || 0;
                  return (
                    <View
                      key={l.id_linea}
                      style={[styles.detailTableRow, l.alerta_nivel === 'rojo' && styles.detailTableRowDanger]}
                    >
                      <View style={styles.colProd}>
                        <Text style={styles.cellName} numberOfLines={1}>{l.product_name || l.producto_id}</Text>
                        <Text style={styles.cellMeta} numberOfLines={1}>
                          #{l.producto_id}
                          {(() => {
                            const iva = ivaDeLinea(l);
                            return iva != null ? ` · IVA ${formatIvaPct(iva)}` : '';
                          })()}
                          {l.alerta_nivel === 'rojo' ? ' · bajo coste' : ''}
                        </Text>
                      </View>
                      <View style={styles.colProv}>
                        <TouchableOpacity
                          style={styles.provBtn}
                          onPress={() => { if (editable) void abrirModalProveedor(idx); }}
                          disabled={!editable}
                          {...(Platform.OS === 'web' && l.proveedor_nombre ? { title: l.proveedor_nombre } : {})}
                        >
                          <Text style={[styles.provBtnText, editable && styles.provBtnTextLink]} numberOfLines={2}>
                            {l.proveedor_nombre || 'Elegir…'}
                          </Text>
                          {l.albaran_fecha ? (
                            <Text style={styles.cellMeta} numberOfLines={1}>{formatFecha(l.albaran_fecha)}</Text>
                          ) : null}
                        </TouchableOpacity>
                      </View>
                      <View style={styles.colNum}>
                        <CellInput
                          numericValue={l.precio_compra_operacion}
                          format="fixed2"
                          editable={editable}
                          onCommit={(n) => patchLinea(idx, { precio_compra_operacion: n, es_precio_negociado: true, _modo_edicion: 'pvp' })}
                        />
                      </View>
                      <View style={styles.colNumSm}>
                        <CellInput
                          numericValue={l.cantidad}
                          format="plain"
                          editable={editable}
                          narrow
                          onCommit={(n) => patchLinea(idx, { cantidad: n, _modo_edicion: 'pvp' })}
                        />
                      </View>
                      <View style={styles.colNum}>
                        <Text style={[styles.detailTableCell, styles.pmrCellText]} numberOfLines={1}>
                          {formatEur(Number(l.pmr ?? ((Number(l.coste_neto) || 0) - (Number(l.aportacion_unitaria) || 0))))}
                        </Text>
                      </View>
                      <View style={styles.colNumSm}>
                        <Text style={[styles.detailTableCell, styles.mkVirtualCell]} numberOfLines={1}>
                          {Number.isFinite(Number(l.pct_ganancia)) ? Number(l.pct_ganancia).toFixed(2) : '—'}
                        </Text>
                      </View>
                      <View style={styles.colNum}>
                        <CellInput
                          numericValue={l.pvp_unitario}
                          format="fixed2"
                          editable={editable}
                          onCommit={(n) => patchLinea(idx, { pvp_unitario: n, _modo_edicion: 'pvp' })}
                        />
                      </View>
                      <View style={styles.colAport}>
                        <Text style={[styles.detailTableCell, l.aportacion_vigente && styles.aportActiva]} numberOfLines={1}>
                          {aportUd > 0 ? formatEur(aportUd, 2) : '—'}
                        </Text>
                        {l.aportacion_vigente && l.dias_cobro ? (
                          <Text style={styles.cellMeta}>{l.dias_cobro}d</Text>
                        ) : null}
                      </View>
                      <View style={styles.colNum}>
                        <Text style={[styles.detailTableCell, { fontWeight: '700', color: (l.beneficio_neto || 0) >= 0 ? '#16a34a' : '#dc2626' }]} numberOfLines={1}>
                          {formatEur(l.beneficio_neto)}
                        </Text>
                      </View>
                      <View style={styles.colAct}>
                        <TouchableOpacity
                          style={styles.rowIconBtn}
                          onPress={async () => {
                            try {
                              const q = new URLSearchParams({ excluirNegociacionId: neg.id });
                              if (l.proveedor_id) q.set('proveedorId', String(l.proveedor_id));
                              const r = await apiFetch(`/api/mayorista/productos/${encodeURIComponent(l.producto_id)}/ultima-venta?${q}`);
                              const d = await r.json();
                              if (!d.encontrada) aviso('No hay venta anterior de este producto.');
                              else {
                                const v = d.venta;
                                aviso(`Última op. ${formatFecha(v.fecha)}\n${v.proveedor_nombre || '—'}\nPVP ${formatEur(v.pvp_unitario)}`);
                              }
                              patchLinea(idx, { _histPvp: d.encontrada ? Number(d.venta?.pvp_unitario) : null });
                            } catch {
                              aviso('No se pudo consultar el histórico');
                            }
                          }}
                        >
                          <MaterialIcons name="history" size={14} color={histColor} />
                        </TouchableOpacity>
                        {editable ? (
                          <TouchableOpacity
                            style={styles.rowIconBtn}
                            onPress={() => setLineas((prev) => prev.filter((_, i) => i !== idx))}
                          >
                            <MaterialIcons name="delete-outline" size={14} color="#ef4444" />
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
          <View style={[styles.panelPreview, shouldStackPanels && styles.panelPreviewStack]}>
            <DocumentoProveedorPreview
              neg={neg}
              lineas={lineas.map((l) => ({
                ...l,
                ultimo_iva_compra: ivaDeLinea(l),
              }))}
              puedeExportar={puedeExportar}
            />
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        {editable ? (
          <TouchableOpacity style={styles.cancelBtn} onPress={guardar} disabled={guardando}>
            {guardando ? <ActivityIndicator color="#64748b" size="small" /> : (
              <>
                <MaterialIcons name="save" size={14} color="#64748b" />
                <Text style={styles.cancelBtnText}>Guardar</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
        {puedeCrear && !esNuevo && neg.id ? (
          <TouchableOpacity style={styles.cancelBtn} onPress={duplicar}>
            <MaterialIcons name="content-copy" size={14} color="#64748b" />
            <Text style={styles.cancelBtnText}>Duplicar</Text>
          </TouchableOpacity>
        ) : null}
        {esBorrador && puedeConfirmar && (esNuevo ? puedeCrear : true) ? (
          <TouchableOpacity style={styles.saveBtn} onPress={confirmar} disabled={guardando}>
            <MaterialIcons name="check-circle" size={14} color="#fff" />
            <Text style={styles.saveBtnText}>Confirmar</Text>
          </TouchableOpacity>
        ) : null}
        {esConfirmada && puedeEditar ? (
          <TouchableOpacity style={styles.saveBtn} onPress={facturar} disabled={guardando}>
            {guardando ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <MaterialIcons name="receipt-long" size={14} color="#fff" />
                <Text style={styles.saveBtnText}>Marcar facturada</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
        {esFacturada && puedeEditar ? (
          <TouchableOpacity style={[styles.saveBtn, styles.saveBtnPagada]} onPress={marcarPagada} disabled={guardando}>
            {guardando ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <MaterialIcons name="payments" size={14} color="#fff" />
                <Text style={styles.saveBtnText}>Marcar pagada</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Modal productos */}
      <Modal visible={prodModal} transparent animationType="fade" onRequestClose={() => setProdModal(false)}>
        <View style={styles.overlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Añadir producto</Text>
                <Text style={styles.modalSub}>Productos IGP · {catalogoProductos.length} refs.</Text>
              </View>
              <TouchableOpacity onPress={() => setProdModal(false)} style={styles.backBtn}>
                <MaterialIcons name="close" size={20} color="#64748b" />
              </TouchableOpacity>
            </View>
            <View style={styles.searchWrap}>
              <MaterialIcons name="search" size={18} color="#94a3b8" />
              <TextInput
                style={styles.searchInput}
                placeholder="Buscar por nombre o ID…"
                placeholderTextColor="#94a3b8"
                value={prodQ}
                onChangeText={setProdQ}
                autoFocus
              />
            </View>
            {loadingProductos && catalogoProductos.length === 0 ? (
              <ActivityIndicator style={{ marginVertical: 24 }} color="#0ea5e9" />
            ) : (
              <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                {prodHits.length === 0 ? (
                  <Text style={styles.emptySub}>
                    {catalogoProductos.length === 0
                      ? 'No hay productos con IGP activo. Márcalos en Productos Ágora.'
                      : 'Ningún resultado para esa búsqueda.'}
                  </Text>
                ) : prodHits.map((p) => (
                  <TouchableOpacity key={p.id} style={styles.prodHit} onPress={() => anadirProducto(p)} activeOpacity={0.7}>
                    <View style={styles.prodIcon}>
                      <MaterialIcons name="liquor" size={14} color="#0ea5e9" />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.prodHitTitle} numberOfLines={2}>{p.nombre}</Text>
                      <Text style={styles.prodHitId}>ID {p.id}</Text>
                    </View>
                    <MaterialIcons name="chevron-right" size={20} color="#cbd5e1" />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Modal selector proveedor */}
      <Modal visible={provModalIdx != null} transparent animationType="fade" onRequestClose={() => setProvModalIdx(null)}>
        <View style={styles.overlay}>
          <View style={[styles.modalCard, styles.provModalCard]}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.modalTitle}>Elegir proveedor</Text>
                <Text style={styles.modalSub} numberOfLines={1}>
                  {provModalIdx != null ? (lineas[provModalIdx]?.product_name || lineas[provModalIdx]?.producto_id) : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setProvModalIdx(null)} style={styles.backBtn}>
                <MaterialIcons name="close" size={20} color="#64748b" />
              </TouchableOpacity>
            </View>
            {provLoading ? (
              <ActivityIndicator style={{ marginVertical: 24 }} color="#0ea5e9" />
            ) : provPrecios.length === 0 ? (
              <Text style={styles.emptySub}>No hay compras registradas para este producto.</Text>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.provTable}>
                  <View style={styles.provTableHeader}>
                    <Text style={[styles.provTh, styles.provColNombre]}>Proveedor</Text>
                    <Text style={[styles.provTh, styles.provColFecha]}>Últ. compra</Text>
                    <Text style={[styles.provTh, styles.provColAlb]}>Albarán</Text>
                    <Text style={[styles.provTh, styles.provColNum]}>Precio</Text>
                    <Text style={[styles.provTh, styles.provColNum]}>Dto %</Text>
                    <Text style={[styles.provTh, styles.provColNum]}>Coste neto</Text>
                  </View>
                  {provPrecios.map((p, i) => (
                    <TouchableOpacity
                      key={`${p.proveedor_id}-${i}`}
                      style={[styles.provTableRow, p.mejor_precio && styles.provTableRowBest]}
                      onPress={() => seleccionarProveedor(p)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.provTd, styles.provColNombre]} numberOfLines={2}>{p.proveedor_nombre || '—'}</Text>
                      <Text style={[styles.provTd, styles.provColFecha]}>{formatFecha(p.albaran_fecha)}</Text>
                      <Text style={[styles.provTd, styles.provColAlb]} numberOfLines={1}>{p.albaran_ref || '—'}</Text>
                      <Text style={[styles.provTd, styles.provColNum]}>{formatEur(p.price, 4)}</Text>
                      <Text style={[styles.provTd, styles.provColNum]}>{((p.discount_rate || 0) * 100).toFixed(1)}%</Text>
                      <Text style={[styles.provTd, styles.provColNum, { fontWeight: '700' }]}>{formatEur(p.cn, 4)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
      {dialog}
      {ToastView}
    </View>
  );
}

const GLOW_SETS = {
  verde: { colors: ['#22c55e', '#86efac', '#16a34a', '#4ade80', '#22c55e'], glow: 'rgba(34,197,94,0.55)' },
  rojo: { colors: ['#ef4444', '#fca5a5', '#b91c1c', '#f87171', '#ef4444'], glow: 'rgba(239,68,68,0.55)' },
  ambar: { colors: ['#eab308', '#fde047', '#ca8a04', '#facc15', '#eab308'], glow: 'rgba(234,179,8,0.6)' },
};

function glowKey(v: number): keyof typeof GLOW_SETS {
  if (v > 0.0001) return 'verde';
  if (v < -0.0001) return 'rojo';
  return 'ambar';
}

function TotalMini({
  label, value, accent, positive, hint, glowValue,
}: {
  label: string;
  value: string;
  accent?: boolean;
  positive?: boolean;
  hint?: string;
  /** Si se define, envuelve la tarjeta con un haz de luz verde/rojo/amarillo según el signo. */
  glowValue?: number;
}) {
  const inner = (
    <View style={[styles.totalCard, accent && styles.totalCardAccent]}>
      <Text style={styles.totalCardTitle} numberOfLines={1}>{label}</Text>
      <Text
        style={[
          styles.totalCardValue,
          positive && styles.totalCardPositive,
          accent && styles.totalCardAccentValue,
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
  let card: ReactNode = inner;
  if (glowValue !== undefined) {
    const set = GLOW_SETS[glowKey(glowValue)];
    card = (
      <LaserBorderWrap
        borderRadius={6}
        borderWidth={2}
        colors={set.colors}
        glowColor={set.glow}
        innerBackground="#f8fafc"
        style={styles.totalCardWrap}
      >
        {inner}
      </LaserBorderWrap>
    );
  }
  if (!hint) return card;
  return (
    <PostitTooltip text={hint} style={styles.totalCardWrap}>
      {card}
    </PostitTooltip>
  );
}

function CellInput({
  numericValue,
  onCommit,
  editable,
  narrow,
  format = 'plain',
  debounceMs = 280,
}: {
  numericValue: number | null | undefined;
  onCommit: (n: number) => void;
  editable?: boolean;
  narrow?: boolean;
  /** fixed2: muestra 2 decimales al salir (coste, PVP, mk.%). plain: tal cual (cant.). */
  format?: 'fixed2' | 'plain';
  debounceMs?: number;
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const displayFromProp = useMemo(() => {
    if (numericValue == null || !Number.isFinite(Number(numericValue))) return '';
    const n = Number(numericValue);
    if (format === 'fixed2') return round2(n).toFixed(2);
    const s = String(n);
    return s.includes('.') ? s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : s;
  }, [numericValue, format]);

  useEffect(() => {
    if (!focused) setDraft(displayFromProp);
  }, [displayFromProp, focused]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const parseDraft = (raw: string): number | null => {
    const t = raw.trim().replace(',', '.');
    if (t === '' || t === '-' || t === '.' || t === '-.') return null;
    const n = parseFloat(t);
    if (!Number.isFinite(n)) return null;
    return format === 'fixed2' ? round2(n) : n;
  };

  const formatDraftDisplay = (n: number) => {
    if (format === 'fixed2') return round2(n).toFixed(2);
    const s = String(n);
    return s.includes('.') ? s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : s;
  };

  const commitDraft = (raw: string) => {
    const parsed = parseDraft(raw);
    if (parsed === null) return;
    onCommitRef.current(parsed);
  };

  const scheduleCommit = (raw: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commitDraft(raw), debounceMs);
  };

  const handleFocus = () => {
    setFocused(true);
    setDraft(displayFromProp);
  };

  const handleBlur = () => {
    setFocused(false);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const parsed = parseDraft(draft);
    if (parsed !== null) {
      onCommitRef.current(parsed);
      setDraft(formatDraftDisplay(parsed));
    } else {
      setDraft(displayFromProp);
    }
  };

  const handleChange = (v: string) => {
    const cleaned = v.replace(/[^\d.,\-]/g, '');
    setDraft(cleaned);
    scheduleCommit(cleaned);
  };

  return (
    <TextInput
      style={[styles.cantidadInput, narrow && styles.cantidadInputNarrow, !editable && styles.inputReadonly]}
      value={focused ? draft : displayFromProp}
      editable={editable}
      keyboardType="decimal-pad"
      onFocus={handleFocus}
      onBlur={handleBlur}
      onChangeText={handleChange}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 12,
  },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  headerMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  headerMetaText: { fontSize: 12, color: '#64748b' },
  dotSem: { width: 7, height: 7, borderRadius: 4 },
  scroll: { paddingBottom: 72 },
  detailInfoSection: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  infoRowSingle: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    flexWrap: 'nowrap',
  },
  infoRowRecogida: { marginTop: 6 },
  infoCell: { gap: 2, minWidth: 0 },
  infoCellCliente: { flex: 2.2, minWidth: 120 },
  infoCellRef: { flex: 1.4, minWidth: 90 },
  infoCellFecha: { flex: 1, minWidth: 136, maxWidth: 152, flexShrink: 0 },
  infoCellFechaRec: { flex: 1, minWidth: 136, maxWidth: 160, flexShrink: 0 },
  infoCellHora: { width: 80, flexShrink: 0 },
  infoCellPct: { width: 72, flexShrink: 0 },
  detailInfoLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
  },
  detailInfoLabelHighlight: { color: '#b45309' },
  inputCompact: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontSize: 12,
    color: '#334155',
    minHeight: 28,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  inputHighlight: {
    backgroundColor: '#fffbeb',
    borderColor: '#fcd34d',
  },
  inputFechaToolbar: {
    overflow: 'visible' as const,
    minWidth: 120,
  },
  inputReadonly: { opacity: 0.65 },
  totalesSection: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  totalesRow: { flexDirection: 'row', gap: 4, flexWrap: 'nowrap' },
  totalCardWrap: { flex: 1, minWidth: 0 },
  totalCard: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 4,
    minWidth: 0,
  },
  totalCardAccent: { backgroundColor: '#f0f9ff', borderColor: '#bae6fd' },
  totalCardTitle: { fontSize: 8, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  totalCardValue: { fontSize: 12, fontWeight: '800', color: '#0f172a' },
  totalCardPositive: { color: '#16a34a' },
  totalCardAccentValue: { color: '#0369a1' },
  splitRow: { flexDirection: 'row', minHeight: 460, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  splitRowStack: { flexDirection: 'column', minHeight: undefined },
  panelLineas: { flex: 1, minWidth: 0, borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  panelPreview: { flex: 1, minWidth: 0, minHeight: 420 },
  panelPreviewStack: { minHeight: 360, borderTopWidth: 1, borderTopColor: '#e2e8f0', borderRightWidth: 0 },
  detailProductsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  detailProductsSectionTitle: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  detailAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    borderStyle: 'dashed',
  },
  detailAddBtnText: { fontSize: 11, color: '#0ea5e9', fontWeight: '600' },
  detailEmpty: {
    fontSize: 13,
    color: '#94a3b8',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 20,
    paddingHorizontal: 14,
  },
  detailTableWrap: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    marginHorizontal: 8,
    marginBottom: 8,
  },
  detailTableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 4,
  },
  detailTableHeaderText: { fontSize: 9, fontWeight: '700', color: '#475569', textTransform: 'uppercase' },
  detailTableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 4,
  },
  detailTableRowDanger: { backgroundColor: '#fff7f7' },
  detailTableCell: { fontSize: 10, color: '#334155' },
  pmrHeaderText: { color: '#0ea5e9' },
  pmrCellText: { color: '#0ea5e9', fontWeight: '700' },
  mkVirtualCell: { fontWeight: '600', color: '#64748b', textAlign: 'center' },
  colProd: { flex: 2.2, minWidth: 0 },
  colProv: { flex: 2, minWidth: 0 },
  colNum: { width: 52, flexShrink: 0, alignItems: 'center' },
  colNumSm: { width: 48, flexShrink: 0, alignItems: 'center' },
  colAport: { width: 44, flexShrink: 0, alignItems: 'flex-end' },
  colAct: { width: 40, flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 1 },
  cellName: { fontSize: 11, fontWeight: '600', color: '#0f172a' },
  cellMeta: { fontSize: 9, color: '#94a3b8', marginTop: 1 },
  provBtn: { paddingVertical: 2, paddingHorizontal: 2, borderRadius: 4 },
  provBtnText: { fontSize: 10, color: '#334155', lineHeight: 13 },
  provBtnTextLink: { color: '#0369a1', textDecorationLine: 'underline' },
  aportActiva: { color: '#16a34a', fontWeight: '600' },
  cantidadInput: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
    fontSize: 11,
    color: '#334155',
    textAlign: 'center',
    width: '100%',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  cantidadInputNarrow: { maxWidth: 48 },
  rowIconBtn: { padding: 4 },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  cancelBtnText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  saveBtnPagada: { backgroundColor: '#7c3aed' },
  saveBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 14,
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#fef2f2',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: { color: '#dc2626', fontSize: 12, flex: 1 },
  link: { color: '#0ea5e9', fontWeight: '600' },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    width: '90%',
    maxWidth: 560,
    maxHeight: '85%',
    padding: 16,
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a' },
  modalSub: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 13,
    color: '#334155',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  prodHit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  prodIcon: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  prodHitTitle: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  prodHitId: { fontSize: 10, color: '#94a3b8', marginTop: 1 },
  emptySub: { fontSize: 12, color: '#94a3b8', textAlign: 'center', paddingHorizontal: 16, paddingVertical: 16 },
  provModalCard: { maxWidth: 720, width: '95%' },
  provTable: { minWidth: 660 },
  provTableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f8fafc',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 6,
  },
  provTableRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 6,
    alignItems: 'center',
  },
  provTableRowBest: { backgroundColor: '#f0fdf4' },
  provTh: { fontSize: 10, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  provTd: { fontSize: 12, color: '#334155' },
  provColNombre: { width: 160 },
  provColFecha: { width: 72 },
  provColAlb: { width: 88 },
  provColNum: { width: 72, textAlign: 'right' },
});
