import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  Pressable,
  useWindowDimensions,
  Platform,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../contexts/AuthContext';
import { InputFecha } from '../../components/InputFecha';
import {
  RegistrarPagoModal,
  type RegistrarPagoInitial,
  type RegistrarPagoPayloadFactura,
} from '../../components/RegistrarPagoModal';
import { registrarPagoFacturaApi } from '../../lib/pagosFacturaDetalle';
import { BadgeEstado } from '../../components/BadgeEstado';
import { BadgeEnRemesa } from '../../components/BadgeEnRemesa';
import { BadgeAbono } from '../../components/BadgeAbono';
import { CampoIdDocumentoFacturaRecibida } from '../../components/CampoIdDocumentoFacturaRecibida';
import { CampoIdFactura } from '../../components/CampoIdFactura';
import { CampoConceptoRemesaFacturaRecibida } from '../../components/CampoConceptoRemesaFacturaRecibida';
import { descargarAdjuntoFacturaRecibida } from '../../lib/descargarAdjuntoFactura';
import { ResumenTotales } from '../../components/ResumenTotales';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { ImporteMonedaInput } from '../../components/ImporteMonedaInput';
import {
  TIPOS_IVA,
  TIPOS_RETENCION,
  FORMAS_PAGO,
  CONDICIONES_PAGO,
  calcularLinea,
  formatMoneda,
  labelFormaPago,
  avisoSignoAbono,
  mapTipoReciboToFormaPago,
  type LineaFactura,
  type Factura,
  type EmpresaFactura,
  type SerieFactura,
  type LocalFactura,
  type ProductoFactura,
  type PagoFactura,
  type AuditoriaFactura,
} from '../../utils/facturacion';
import {
  emptyLinea,
  hoyISO,
  hydrateLineasDesdeFactura,
  lineasPayloadForApi,
} from '../../utils/facturaFormLogic';
import { useFacturaFormLogic } from '../../hooks/useFacturaFormLogic';
import { fechaEmisionFacturaAIso, formatCreadoEn, formatFechaPagoRow, textoFechaContabilizacionGasto } from '../../utils/formatFecha';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalToast, detectToastType } from '../../components/Toast';
import { MIN_TOUCH } from '../../constants/layout';
import { useConfirmar } from '../../hooks/useConfirmar';
import { apiFetch, errorMessage } from '../../utils/api';
import { resolverIbanBeneficiarioFactura } from '../../lib/resolverIbanFactura';
import { buildConceptoRemesaFacturaRecibida } from '../../lib/conceptoRemesa';
import type { EmpresaConTipoRecibo } from '../../utils/empresaTipoRecibo';
import type { RemesaActivaFactura } from '../../types/remesas';

/**
 * Crear/duplicar/rectificar responden `{ ok, factura, ... }` con el id en
 * `factura.id_entrada`; el fallback cubre respuestas antiguas con el id en la raíz.
 */
type RespuestaConFactura = {
  factura?: { id_entrada?: string; id_factura?: string };
  id_factura?: string;
};

function idFacturaDeRespuesta(data: RespuestaConFactura): string {
  return String(data.factura?.id_entrada || data.factura?.id_factura || data.id_factura || '');
}

const DATOS_EMISOR = {
  nombre: 'IPG Hostelería S.L.',
  cif: 'B12345678',
  direccion: 'Calle Ejemplo 1',
  cp: '18001',
  municipio: 'Granada',
  provincia: 'Granada',
  email: 'admin@ipg.es',
  telefono: '958 000 000',
};

export default function FacturaDetalleScreen() {
  const params = useLocalSearchParams<{ tipo: string; modo: string; id: string }>();
  const tipo = (params.tipo ?? 'OUT') as 'OUT' | 'IN';
  const modo = (params.modo ?? 'crear') as 'crear' | 'editar';
  const facturaId = params.id ?? '';
  const router = useRouter();
  const { user, hasPermiso } = useAuth();
  const { width } = useWindowDimensions();
  const isWide = width >= 768;

  const esVenta = tipo === 'OUT';
  const backPath = esVenta ? '/facturacion/facturas-venta' : '/facturacion/facturas-gasto';

  // ── State ──
  const [loading, setLoading] = useState(modo === 'editar');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const facturaForm = useFacturaFormLogic({
    modo,
    loading,
    initialFechaEmision: modo === 'crear' ? undefined : hoyISO(),
  });
  const {
    fechaEmision,
    setFechaEmision,
    fechaVencimiento,
    setFechaVencimiento,
    condicionesPago,
    setCondicionesPago,
    formaPago,
    setFormaPago,
    lineas,
    setLineas,
    totales,
    updateLinea,
    addLinea,
    removeLinea,
    markHydrationFromApi,
  } = facturaForm;

  const [estado, setEstado] = useState('borrador');
  const [saldoPendiente, setSaldoPendiente] = useState(0);
  const [numeroFactura, setNumeroFactura] = useState('');
  const [serie, setSerie] = useState('');
  const [fechaOperacion, setFechaOperacion] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [localId, setLocalId] = useState('');
  /** Solo ventas: documento que devuelve importe, con totales en negativo */
  const [esAbono, setEsAbono] = useState(false);
  /** Solo lectura: una rectificativa en negativo ya es un abono y no necesita la marca */
  const [esRectificativa, setEsRectificativa] = useState(false);
  const [numFacturaProveedor, setNumFacturaProveedor] = useState('');
  /** ISO con hora; en facturas IN lo asigna el servidor al crear */
  const [fechaContabilizacionIso, setFechaContabilizacionIso] = useState('');
  const [contabilizadoPor, setContabilizadoPor] = useState('');
  const [creadoEn, setCreadoEn] = useState('');

  // Emisor
  const [emisorId, setEmisorId] = useState('');
  const [emisorNombre, setEmisorNombre] = useState('');
  const [emisorCif, setEmisorCif] = useState('');
  const [emisorDireccion, setEmisorDireccion] = useState('');
  const [emisorCp, setEmisorCp] = useState('');
  const [emisorMunicipio, setEmisorMunicipio] = useState('');
  const [emisorProvincia, setEmisorProvincia] = useState('');
  const [emisorEmail, setEmisorEmail] = useState('');
  const [emisorIban, setEmisorIban] = useState('');
  const [emisorIbanAlt, setEmisorIbanAlt] = useState('');

  // Receptor (contraparte)
  const [empresaId, setEmpresaId] = useState('');
  const [empresaNombre, setEmpresaNombre] = useState('');
  const [empresaCif, setEmpresaCif] = useState('');
  const [empresaDireccion, setEmpresaDireccion] = useState('');
  const [empresaCp, setEmpresaCp] = useState('');
  const [empresaMunicipio, setEmpresaMunicipio] = useState('');
  const [empresaProvincia, setEmpresaProvincia] = useState('');
  const [empresaEmail, setEmpresaEmail] = useState('');
  const [empresaIban, setEmpresaIban] = useState('');
  const [empresaIbanAlt, setEmpresaIbanAlt] = useState('');

  const [pagos, setPagos] = useState<PagoFactura[]>([]);
  const [auditLog, setAuditLog] = useState<AuditoriaFactura[]>([]);
  const [version, setVersion] = useState(1);

  // ── Catalogs ──
  const [empresas, setEmpresas] = useState<EmpresaFactura[]>([]);
  const [series, setSeries] = useState<SerieFactura[]>([]);
  const [locales, setLocales] = useState<LocalFactura[]>([]);
  const [emisorSearch, setEmisorSearch] = useState('');
  const [showEmisorDropdown, setShowEmisorDropdown] = useState(false);
  const [empresaSearch, setEmpresaSearch] = useState('');
  const [showEmpresaDropdown, setShowEmpresaDropdown] = useState(false);

  // ── Product modal ──
  const [showProductModal, setShowProductModal] = useState(false);
  const [productos, setProductos] = useState<ProductoFactura[]>([]);
  const [productoSearch, setProductoSearch] = useState('');
  const [loadingProductos, setLoadingProductos] = useState(false);

  // ── Pago modal ──
  const [showPagoModal, setShowPagoModal] = useState(false);
  const [pagoInitial, setPagoInitial] = useState<RegistrarPagoInitial>({});
  const [fechaReferenciaTarjetaPago, setFechaReferenciaTarjetaPago] = useState<string | undefined>();
  const [savingPago, setSavingPago] = useState(false);

  /** Remesa Borrador/Generada que incluye esta factura IN (campo hermano del GET detalle) */
  const [remesaActiva, setRemesaActiva] = useState<RemesaActivaFactura | null>(null);
  const [quitandoRemesa, setQuitandoRemesa] = useState(false);

  // ── Email modal ──
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailDestinatario, setEmailDestinatario] = useState('');
  const [emailAsunto, setEmailAsunto] = useState('');
  const [emailCuerpo, setEmailCuerpo] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);
  // ── Adjuntos ──
  type Adjunto = { id: string; fileKey: string; nombre: string; tipo: string; size: number; url?: string; subido_en: string; subido_por: string };
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([]);
  const [subiendoAdjunto, setSubiendoAdjunto] = useState(false);
  const [descargandoAdjId, setDescargandoAdjId] = useState<string | null>(null);

  // ── Toast nativo ──
  const { show: showToast, ToastView } = useLocalToast();
  const { confirmar, ConfirmarView } = useConfirmar();
  const alertMsg = useCallback((titulo: string, msg: string) => {
    showToast(titulo, msg, detectToastType(titulo, msg));
  }, [showToast]);

  // ── Computed ──
  const seriesFiltradas = useMemo(() => series.filter((s) => s.tipo === tipo && s.activa !== false), [series, tipo]);

  const [previewNumFactura, setPreviewNumFactura] = useState('');
  useEffect(() => {
    // En ventas el número se reserva al emitir y el campo muestra «Provisional»:
    // no hay preview que mostrar, así que se evita la consulta.
    if (esVenta || !serie || !emisorId || modo === 'editar') { setPreviewNumFactura(''); return; }
    const s = series.find((x) => x.serie === serie);
    if (!s) { setPreviewNumFactura(''); return; }
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(fechaEmision) ? fechaEmision : '';
    const year = iso ? iso.substring(0, 4) : String(new Date().getFullYear());
    // La reserva real usa el año de fecha_emision: sin este parámetro el preview mentiría.
    const qs = new URLSearchParams({ serie, emisor_id: emisorId });
    if (iso) qs.set('fecha_emision', iso);
    apiFetch(`/api/facturacion/series/next-number?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        const digits = d.num_digitos || s.num_digitos || 6;
        const num = d.next_numero || 1;
        setPreviewNumFactura(`${s.serie}-${year}-${String(num).padStart(digits, '0')}`);
      })
      .catch(() => {
        const digits = s.num_digitos || 6;
        setPreviewNumFactura(`${s.serie}-${year}-${String(1).padStart(digits, '0')}`);
      });
  }, [serie, emisorId, fechaEmision, series, modo, esVenta]);

  const esEditable =
    estado !== 'anulada' && (estado === 'borrador' || tipo === 'IN');
  const esValidacionRevisionIn = tipo === 'IN' && estado === 'pendiente_revision';
  const puedeEmitir = estado === 'borrador' || esValidacionRevisionIn;
  /** El correlativo de venta se reserva al emitir: en borrador no hay número que mostrar. */
  const numeroProvisionalVenta = esVenta && estado === 'borrador' && !numeroFactura;
  /** Facturas de venta ya emitidas: mostrar el identificador interno en la ficha. */
  const mostrarIdFactura = esVenta && modo === 'editar' && !!facturaId && estado !== 'borrador';
  const puedeRegistrarPago =
    modo === 'editar' &&
    hasPermiso('facturacion.cobrar_pagar') &&
    ['emitida', 'parcialmente_cobrada', 'pendiente_pago', 'parcialmente_pagada', 'pendiente_revision'].includes(estado) &&
    !(tipo === 'IN' && !!remesaActiva);
  const puedeDuplicar = modo === 'editar';
  const puedeRectificar =
    modo === 'editar' &&
    ['emitida', 'parcialmente_cobrada', 'cobrada', 'pendiente_pago', 'parcialmente_pagada', 'pagada'].includes(estado);
  /** El signo de los totales debe cuadrar con la marca de abono o la emisión falla. */
  const avisoAbono = esVenta
    ? avisoSignoAbono({ esAbono, totalFactura: totales.total_factura, esRectificativa })
    : null;

  /** Sociedad GRUPO PARIPE: emisor en ventas y en facturas recibidas (sociedad que recibe el gasto). */
  const emisorFiltradas = useMemo(() => {
    let base = empresas.filter((e) => (e.sede || '').toUpperCase().includes('GRUPO PARIPE'));
    if (!emisorSearch.trim()) return base;
    const q = emisorSearch.toLowerCase();
    return base.filter(
      (e) => (e.nombre || '').toLowerCase().includes(q) || (e.cif || '').toLowerCase().includes(q),
    );
  }, [empresas, emisorSearch]);

  const empresasFiltradas = useMemo(() => {
    if (!empresaSearch.trim()) return empresas;
    const q = empresaSearch.toLowerCase();
    return empresas.filter(
      (e) => (e.nombre || '').toLowerCase().includes(q) || (e.cif || '').toLowerCase().includes(q),
    );
  }, [empresas, empresaSearch]);

  const empresasCatalogoPago = useMemo(
    (): EmpresaConTipoRecibo[] =>
      empresas.map((e) => ({
        id_empresa: e.id_empresa,
        Cif: e.cif,
        Iban: e.iban,
        IbanAlternativo: e.ibanAlternativo,
        tipoRecibo: e.tipoRecibo,
      })),
    [empresas],
  );

  const datosPagoModal = useMemo(() => {
    const refIban = esVenta
      ? {
          empresa_iban: emisorIban,
          empresa_iban_alternativo: emisorIbanAlt,
          empresa_id: emisorId,
          empresa_cif: emisorCif,
        }
      : {
          empresa_iban: empresaIban,
          empresa_iban_alternativo: empresaIbanAlt,
          empresa_id: empresaId,
          empresa_cif: empresaCif,
        };
    const { iban, ibanAlternativo } = resolverIbanBeneficiarioFactura(refIban, empresasCatalogoPago);
    return {
      beneficiario: esVenta ? emisorNombre : empresaNombre,
      iban,
      ibanAlternativo,
      concepto: buildConceptoRemesaFacturaRecibida({
        numeroFacturaProveedor: numFacturaProveedor,
        numeroFactura,
        proveedorNombre: empresaNombre,
        observaciones,
      }),
    };
  }, [
    esVenta,
    emisorIban,
    emisorIbanAlt,
    emisorId,
    emisorCif,
    emisorNombre,
    empresaIban,
    empresaIbanAlt,
    empresaId,
    empresaCif,
    empresaNombre,
    numFacturaProveedor,
    numeroFactura,
    observaciones,
    empresasCatalogoPago,
  ]);

  const productosFiltrados = useMemo(() => {
    if (!productoSearch.trim()) return productos;
    const q = productoSearch.toLowerCase();
    return productos.filter(
      (p) =>
        (p.nombre || '').toLowerCase().includes(q) ||
        (p.referencia || '').toLowerCase().includes(q),
    );
  }, [productos, productoSearch]);

  // ── Fetch catalogs ──
  useEffect(() => {
    apiFetch('/api/empresas').then((r) => r.json()).then((d) => {
      const raw: unknown[] = d.empresas ?? d ?? [];
      setEmpresas(raw.map((item): EmpresaFactura => {
        const e = (item ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (v == null ? '' : String(v));
        return {
          id_empresa: str(e.id_empresa),
          nombre: str(e.Nombre ?? e.nombre),
          cif: str(e.Cif ?? e.cif),
          direccion: str(e.Direccion ?? e.direccion),
          cp: str(e.Cp ?? e.cp),
          municipio: str(e.Municipio ?? e.municipio),
          provincia: str(e.Provincia ?? e.provincia),
          email: str(e.Email ?? e.email),
          iban: str(e.Iban ?? e.iban),
          ibanAlternativo: str(e.IbanAlternativo ?? e.ibanAlternativo),
          sede: str(e.Sede ?? e.sede),
          tipoRecibo: e['Tipo de recibo'] != null ? String(e['Tipo de recibo']).trim() : undefined,
        };
      }));
    }).catch(() => {});
    apiFetch('/api/facturacion/series').then((r) => r.json()).then((d) => setSeries(d.series ?? d ?? [])).catch(() => {});
    apiFetch('/api/locales').then((r) => r.json()).then((d) => setLocales(d.locales ?? d ?? [])).catch(() => {});
  }, []);

  // ── Fetch factura when editing ──
  const fetchFactura = useCallback(async () => {
    if (modo !== 'editar' || !facturaId) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${facturaId}`);
      if (!res.ok) throw new Error('No se pudo cargar la factura');
      const data = await res.json();
      const f: Factura = data.factura ?? data;
      markHydrationFromApi();
      const remesaRaw = data.remesaActiva ?? null;
      setRemesaActiva(
        remesaRaw && remesaRaw.remesaId
          ? {
              remesaId: String(remesaRaw.remesaId),
              nombre: String(remesaRaw.nombre ?? ''),
              estado: remesaRaw.estado === 'Generada' ? 'Generada' : 'Borrador',
            }
          : null,
      );
      setEstado(f.estado);
      setSaldoPendiente(Number(f.saldo_pendiente ?? f.total_factura ?? 0));
      setNumeroFactura(f.numero_factura ?? '');
      setSerie(f.serie);
      setFechaEmision(fechaEmisionFacturaAIso(f.fecha_emision ?? '') ?? '');
      setFechaOperacion(fechaEmisionFacturaAIso(f.fecha_operacion ?? '') ?? '');
      setFechaVencimiento(fechaEmisionFacturaAIso(f.fecha_vencimiento ?? '') ?? '');
      setCondicionesPago(f.condiciones_pago ?? 'contado');
      setFormaPago(f.forma_pago ?? 'transferencia');
      setObservaciones(f.observaciones ?? '');
      setLocalId(f.local_id ?? '');
      setEsAbono(!!f.es_abono);
      setEsRectificativa(!!f.es_rectificativa);
      setNumFacturaProveedor(f.numero_factura_proveedor ?? '');
      setFechaContabilizacionIso(String(f.fecha_contabilizacion ?? '').trim());
      setContabilizadoPor(String(f.contabilizado_por ?? '').trim());
      setCreadoEn(String(f.creado_en ?? '').trim());
      setEmisorId(f.emisor_id ?? '');
      setEmisorNombre(f.emisor_nombre ?? '');
      setEmisorCif(f.emisor_cif ?? '');
      setEmisorDireccion(f.emisor_direccion ?? '');
      setEmisorCp(f.emisor_cp ?? '');
      setEmisorMunicipio(f.emisor_municipio ?? '');
      setEmisorProvincia(f.emisor_provincia ?? '');
      setEmisorEmail(f.emisor_email ?? '');
      setEmisorIban(f.emisor_iban ?? '');
      setEmisorIbanAlt(f.emisor_iban_alternativo ?? '');
      setEmpresaId(f.empresa_id ?? '');
      setEmpresaNombre(f.empresa_nombre ?? '');
      setEmpresaCif(f.empresa_cif ?? '');
      setEmpresaDireccion(f.empresa_direccion ?? '');
      setEmpresaCp(f.empresa_cp ?? '');
      setEmpresaMunicipio(f.empresa_municipio ?? '');
      setEmpresaProvincia(f.empresa_provincia ?? '');
      setEmpresaEmail(f.empresa_email ?? '');
      setEmpresaIban(f.empresa_iban ?? '');
      setEmpresaIbanAlt(f.empresa_iban_alternativo ?? '');
      setVersion(f.version ?? 1);

      setLineas(hydrateLineasDesdeFactura(f, data.lineas));
      setPagos(data.pagos ?? []);
      setAuditLog(data.auditoria ?? []);

      apiFetch(`/api/facturacion/facturas/${facturaId}/adjuntos`)
        .then((r) => r.json())
        .then((d) => setAdjuntos(d.adjuntos ?? []))
        .catch(() => {});
    } catch (e: unknown) {
      setError(errorMessage(e, 'Error al cargar'));
    } finally {
      setLoading(false);
    }
  }, [modo, facturaId, markHydrationFromApi]);

  useEffect(() => { fetchFactura(); }, [fetchFactura]);

  // ── Emisor select ──
  const selectEmisor = (e: EmpresaFactura) => {
    setEmisorId(e.id_empresa);
    setEmisorNombre(e.nombre);
    setEmisorCif(e.cif);
    setEmisorDireccion(e.direccion);
    setEmisorCp(e.cp);
    setEmisorMunicipio(e.municipio);
    setEmisorProvincia(e.provincia);
    setEmisorEmail(e.email);
    setEmisorIban(e.iban);
    setEmisorIbanAlt(e.ibanAlternativo);
    setEmisorSearch('');
    setShowEmisorDropdown(false);
  };

  // ── Receptor select ──
  const selectEmpresa = (e: EmpresaFactura) => {
    setEmpresaId(e.id_empresa);
    setEmpresaNombre(e.nombre);
    setEmpresaCif(e.cif);
    setEmpresaDireccion(e.direccion);
    setEmpresaCp(e.cp);
    setEmpresaMunicipio(e.municipio);
    setEmpresaProvincia(e.provincia);
    setEmpresaEmail(e.email);
    setEmpresaIban(e.iban);
    setEmpresaIbanAlt(e.ibanAlternativo);
    setEmpresaSearch('');
    setShowEmpresaDropdown(false);
  };

  // ── Products modal ──
  const openProductModal = async () => {
    setShowProductModal(true);
    setProductoSearch('');
    if (productos.length === 0) {
      setLoadingProductos(true);
      try {
        const res = await apiFetch('/api/productos');
        const data = await res.json();
        setProductos(data.productos ?? data ?? []);
      } catch { /* ignore */ }
      setLoadingProductos(false);
    }
  };

  const selectProducto = (p: ProductoFactura) => {
    const newLinea: LineaFactura = {
      producto_id: p.id_producto,
      producto_ref: p.referencia,
      descripcion: p.nombre,
      cantidad: 1,
      precio_unitario: p.precio_venta ?? 0,
      descuento_pct: 0,
      tipo_iva: p.tipo_iva ?? 21,
      retencion_pct: 0,
    };
    setLineas((prev) => {
      if (prev.length === 1 && !prev[0].descripcion && prev[0].precio_unitario === 0) {
        return [newLinea];
      }
      return [...prev, newLinea];
    });
    setShowProductModal(false);
  };

  // ── Build payload ──
  const buildPayload = () => ({
    tipo,
    serie,
    estado,
    emisor_id: emisorId || null,
    emisor_nombre: emisorNombre,
    emisor_cif: emisorCif,
    emisor_direccion: emisorDireccion,
    emisor_cp: emisorCp,
    emisor_municipio: emisorMunicipio,
    emisor_provincia: emisorProvincia,
    emisor_email: emisorEmail,
    emisor_iban: emisorIban,
    emisor_iban_alternativo: emisorIbanAlt,
    empresa_id: empresaId,
    empresa_nombre: empresaNombre,
    empresa_cif: empresaCif,
    empresa_direccion: empresaDireccion,
    empresa_cp: empresaCp,
    empresa_municipio: empresaMunicipio,
    empresa_provincia: empresaProvincia,
    empresa_email: empresaEmail,
    empresa_iban: empresaIban,
    empresa_iban_alternativo: empresaIbanAlt,
    fecha_emision: fechaEmision,
    fecha_operacion: fechaOperacion || null,
    fecha_vencimiento: fechaVencimiento,
    condiciones_pago: condicionesPago,
    forma_pago: formaPago,
    observaciones,
    local_id: localId || null,
    /** En gastos el signo lo pone el proveedor, así que la marca no se toca. */
    ...(esVenta ? { es_abono: esAbono } : {}),
    numero_factura_proveedor: tipo === 'IN' ? numFacturaProveedor : null,
    /** Al crear IN el servidor fija fecha/hora/usuario; al editar se reenvía el ISO para no perder la hora */
    ...(tipo === 'IN' && modo === 'editar' ? { fecha_contabilizacion: fechaContabilizacionIso || null } : {}),
    lineas: lineasPayloadForApi(lineas),
    ...totales,
    usuario_id: user?.id_usuario,
    usuario_nombre: user?.Nombre,
    version,
  });

  // ── Save (borrador) ──
  const guardarBorrador = async () => {
    if (!emisorNombre) {
      alertMsg('Error', esVenta ? 'Selecciona un emisor' : 'Selecciona la empresa del grupo (GRUPO PARIPE)');
      return;
    }
    if (!empresaId) {
      alertMsg('Error', esVenta ? 'Selecciona un receptor' : 'Selecciona el proveedor');
      return;
    }
    // Texto escrito en un buscador sin elegir opción: el payload usaría los
    // datos anteriores aunque el input muestre lo tecleado. Avisar antes.
    if (emisorSearch.trim() && emisorSearch.trim() !== emisorNombre) {
      alertMsg('Atención', `Has escrito "${emisorSearch.trim()}" en ${esVenta ? 'Emisor' : 'Empresa'} pero no lo has seleccionado de la lista. Selecciónalo o borra el texto.`);
      return;
    }
    if (empresaSearch.trim() && empresaSearch.trim() !== empresaNombre) {
      alertMsg('Atención', `Has escrito "${empresaSearch.trim()}" en ${esVenta ? 'Receptor' : 'Proveedor'} pero no lo has seleccionado de la lista. Selecciónalo o borra el texto.`);
      return;
    }
    // La serie solo es imprescindible al CREAR (genera el número). Al editar,
    // el backend no la modifica y las facturas de gasto creadas por OCR llegan
    // sin serie: exigirla aquí bloqueaba guardar cualquier cambio en ellas.
    if (!serie && modo === 'crear') {
      if (seriesFiltradas.length === 0) alertMsg('Sin series', 'No hay series configuradas para este tipo de factura. Ve a Facturación > Series para crearlas.');
      else alertMsg('Error', 'Selecciona una serie');
      return;
    }
    if (!fechaEmision) { alertMsg('Error', 'Indica la fecha de emisión'); return; }
    setSaving(true);
    setError('');
    try {
      const url = modo === 'crear'
        ? `/api/facturacion/facturas`
        : `/api/facturacion/facturas/${facturaId}`;
      const method = modo === 'crear' ? 'POST' : 'PUT';
      const res = await apiFetch(url, {
        method,
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al guardar');
      const newId = idFacturaDeRespuesta(data);
      if (modo === 'crear' && newId) {
        alertMsg('Guardado', 'Factura guardada correctamente');
        router.replace({
          pathname: '/facturacion/factura-detalle',
          params: { tipo, modo: 'editar', id: newId },
        } as any);
      } else {
        // await: si no, la recarga termina después de reactivar el formulario
        // y pisa lo que el usuario esté editando con los datos anteriores.
        await fetchFactura();
        alertMsg('Guardado', 'Factura guardada correctamente');
      }
    } catch (e: unknown) {
      setError(errorMessage(e));
      alertMsg('Error', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Emitir ──
  const emitirFactura = async () => {
    const tituloAccion = esValidacionRevisionIn ? 'Validar revisión' : 'Emitir factura';
    const textoAccion = esValidacionRevisionIn
      ? '¿Confirmas que los datos OCR son correctos? La factura pasará a pendiente de pago.'
      : tipo === 'IN'
        ? '¿Seguro que deseas emitir esta factura? Pasará a pendiente de pago.'
        : '¿Seguro que deseas emitir esta factura? No podrá editarse después.';
    const ok = await confirmar(tituloAccion, textoAccion, {
      confirmarLabel: esValidacionRevisionIn ? 'Validar revisión' : 'Emitir',
    });
    if (!ok) return;
    setSaving(true);
    setError('');
    try {
      if (modo === 'crear') {
        if (!emisorNombre || !empresaId || !serie || !fechaEmision) { alertMsg('Error', 'Completa los campos obligatorios (emisor, receptor, serie, fecha)'); setSaving(false); return; }
        const createRes = await apiFetch('/api/facturacion/facturas', {
          method: 'POST',
          body: JSON.stringify(buildPayload()),
        });
        const createData = await createRes.json();
        if (!createRes.ok) throw new Error(createData.error ?? 'Error al crear');
        const newId = idFacturaDeRespuesta(createData);
        // Sin id no se puede emitir: cortar aquí evita reintentos que dupliquen el borrador.
        if (!newId) {
          throw new Error('La factura se ha creado pero no se ha recibido su identificador. Búscala en el listado y emítela desde ahí para no duplicarla.');
        }
        const emitRes = await apiFetch(`/api/facturacion/facturas/${newId}/emitir`, {
          method: 'POST',
          body: JSON.stringify({ usuario_id: user?.id_usuario, usuario_nombre: user?.Nombre }),
        });
        if (!emitRes.ok) {
          const d = await emitRes.json();
          const msg = d.errores ? `Validación:\n• ${d.errores.join('\n• ')}` : (d.error ?? 'Error al emitir');
          // El borrador ya está creado: pasar a edición evita que cada reintento lo duplique.
          router.replace({
            pathname: '/facturacion/factura-detalle',
            params: { tipo, modo: 'editar', id: newId },
          } as any);
          throw new Error(`${msg}\n\nLa factura ha quedado guardada como borrador: corrige los datos y vuelve a emitir.`);
        }
        alertMsg('Emitida', 'Factura emitida correctamente');
        router.replace({
          pathname: '/facturacion/factura-detalle',
          params: { tipo, modo: 'editar', id: newId },
        } as any);
      } else {
        // Persistir los cambios del formulario ANTES de emitir; si el PUT falla
        // hay que abortar, o se emitiría la versión antigua de la factura.
        const putRes = await apiFetch(`/api/facturacion/facturas/${facturaId}`, {
          method: 'PUT',
          body: JSON.stringify(buildPayload()),
        });
        if (!putRes.ok) {
          const d = await putRes.json().catch(() => ({} as { error?: string }));
          throw new Error(d.error ?? 'No se pudieron guardar los cambios antes de emitir');
        }
        const res = await apiFetch(`/api/facturacion/facturas/${facturaId}/emitir`, {
          method: 'POST',
          body: JSON.stringify({ usuario_id: user?.id_usuario, usuario_nombre: user?.Nombre }),
        });
        if (!res.ok) {
          const d = await res.json();
          const msg = d.errores ? `Validación:\n• ${d.errores.join('\n• ')}` : (d.error ?? 'Error al emitir');
          throw new Error(msg);
        }
        alertMsg(
          esValidacionRevisionIn ? 'Validada' : 'Emitida',
          esValidacionRevisionIn
            ? 'Factura validada. Ya está pendiente de pago.'
            : 'Factura emitida correctamente',
        );
        await fetchFactura();
      }
    } catch (e: unknown) {
      setError(errorMessage(e));
      alertMsg('Error', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Duplicar ──
  const duplicarFactura = async () => {
    const ok = await confirmar('Duplicar', '¿Crear una copia borrador de esta factura?', {
      confirmarLabel: 'Duplicar',
    });
    if (!ok) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${facturaId}/duplicar`, {
        method: 'POST',
        body: JSON.stringify({ usuario_id: user?.id_usuario, usuario_nombre: user?.Nombre }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al duplicar');
      const newId = idFacturaDeRespuesta(data);
      if (!newId) throw new Error('Se ha creado la copia pero no se ha recibido su identificador. Búscala en el listado.');
      alertMsg('Duplicada', 'Se ha creado la copia');
      router.replace({
        pathname: '/facturacion/factura-detalle',
        params: { tipo, modo: 'editar', id: newId },
      } as any);
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Rectificar ──
  const rectificarFactura = async () => {
    const ok = await confirmar('Rectificativa', '¿Generar una factura rectificativa?', {
      confirmarLabel: 'Generar',
    });
    if (!ok) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${facturaId}/rectificar`, {
        method: 'POST',
        body: JSON.stringify({ usuario_id: user?.id_usuario, usuario_nombre: user?.Nombre }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al rectificar');
      const newId = idFacturaDeRespuesta(data);
      if (!newId) throw new Error('Se ha creado la rectificativa pero no se ha recibido su identificador. Búscala en el listado.');
      alertMsg('Rectificativa creada', 'Se ha generado la factura rectificativa');
      router.replace({
        pathname: '/facturacion/factura-detalle',
        params: { tipo, modo: 'editar', id: newId },
      } as any);
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const abrirModalPago = () => {
    const emp = empresas.find((e) => e.id_empresa === empresaId);
    const { clave, otroTexto } = mapTipoReciboToFormaPago(emp?.tipoRecibo ?? '');

    const hoy = hoyISO();
    const fechaFactura = /^\d{4}-\d{2}-\d{2}$/.test(fechaEmision)
      ? fechaEmision
      : (fechaEmisionFacturaAIso(fechaEmision) ?? hoy);

    setFechaReferenciaTarjetaPago(fechaFactura);
    setPagoInitial({
      fecha: clave === 'tarjeta' ? fechaFactura : hoy,
      metodo: clave,
      metodoOtro: clave === 'otro' ? otroTexto : '',
      referencia: '',
      observaciones: '',
      importe: '',
    });
    setShowPagoModal(true);
  };

  // ── Registrar pago ──
  const registrarPago = async (payload: RegistrarPagoPayloadFactura) => {
    setSavingPago(true);
    try {
      await registrarPagoFacturaApi(facturaId!, payload, {
        id: user?.id_usuario,
        nombre: user?.Nombre,
      });
      alertMsg(
        'Registrado',
        payload.metodo_pago === 'compensacion'
          ? 'Compensación registrada correctamente'
          : 'Pago registrado correctamente',
      );
      setShowPagoModal(false);
      fetchFactura();
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setSavingPago(false);
    }
  };

  const quitarDeRemesa = async () => {
    if (!remesaActiva || !facturaId || tipo !== 'IN') return;
    const esGenerada = remesaActiva.estado === 'Generada';
    const ok = await confirmar(
      'Quitar de la remesa',
      esGenerada
        ? `¿Sacar esta factura de «${remesaActiva.nombre}»? La remesa pasará a Borrador.`
        : `¿Sacar esta factura de «${remesaActiva.nombre}»?`,
      { confirmarLabel: 'Quitar' },
    );
    if (!ok) return;
    setQuitandoRemesa(true);
    try {
      const res = await apiFetch(`/api/remesas/${remesaActiva.remesaId}`, {
        method: 'PATCH',
        body: JSON.stringify({ quitarFacturaIds: [facturaId] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo quitar de la remesa');
      showToast('Hecho', 'Factura quitada de la remesa', 'success');
      await fetchFactura();
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e, 'No se pudo quitar de la remesa'));
    } finally {
      setQuitandoRemesa(false);
    }
  };

  // ── PDF helpers ──
  const buildPdfParams = () => {
    const emisorData = {
      nombre: emisorNombre, cif: emisorCif, direccion: emisorDireccion,
      cp: emisorCp, municipio: emisorMunicipio, provincia: emisorProvincia,
      email: emisorEmail, telefono: DATOS_EMISOR.telefono,
      iban: emisorIban, ibanAlternativo: emisorIbanAlt,
    };
    const clienteData = {
      nombre: empresaNombre, cif: empresaCif, direccion: empresaDireccion,
      cp: empresaCp, municipio: empresaMunicipio, provincia: empresaProvincia,
      email: empresaEmail,
    };
    const numFactura = modo === 'editar' && numeroFactura ? numeroFactura : previewNumFactura || '';
    const facturaData = {
      // El borrador de venta aún no tiene correlativo; este valor sale en la cabecera del
      // PDF (ya con marca de agua BORRADOR), en el concepto de pago y en el nombre del fichero.
      id_factura: numeroProvisionalVenta ? 'Provisional' : numFactura || facturaId,
      tipo, serie, numero: 0, estado,
      fecha_emision: fechaEmision,
      fecha_operacion: fechaOperacion || undefined,
      fecha_vencimiento: fechaVencimiento || undefined,
      condiciones_pago: condicionesPago,
      forma_pago: formaPago,
      observaciones: observaciones || undefined,
      numero_factura_proveedor: numFacturaProveedor || undefined,
      base_imponible: totales.base_imponible,
      total_iva: totales.total_iva,
      total_retencion: totales.total_retencion,
      total_factura: totales.total_factura,
    };
    return { emisorData, clienteData, facturaData };
  };

  const descargarPDF = async () => {
    if (Platform.OS !== 'web') {
      alertMsg('PDF', 'La descarga de PDF solo está disponible en versión web');
      return;
    }
    try {
      const { descargarPDFFactura } = await import('../../components/FacturaPDF');
      const { emisorData, clienteData, facturaData } = buildPdfParams();
      await descargarPDFFactura(emisorData, clienteData, facturaData, lineas);
    } catch (e: unknown) {
      alertMsg('Error PDF', errorMessage(e, 'No se pudo generar el PDF'));
    }
  };

  const previsualizarPDF = async () => {
    if (Platform.OS !== 'web') {
      alertMsg('PDF', 'La previsualización de PDF solo está disponible en versión web');
      return;
    }
    try {
      const { generarPDFFactura } = await import('../../components/FacturaPDF');
      const { emisorData, clienteData, facturaData } = buildPdfParams();
      const doc = await generarPDFFactura(emisorData, clienteData, facturaData, lineas);
      const blobUrl = doc.output('bloburl');
      window.open(String(blobUrl), '_blank');
    } catch (e: unknown) {
      alertMsg('Error PDF', errorMessage(e, 'No se pudo generar la previsualización'));
    }
  };

  // ── Adjuntos ──
  const subirAdjunto = async () => {
    if (Platform.OS !== 'web') {
      alertMsg('Info', 'Subida de adjuntos solo disponible en web');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setSubiendoAdjunto(true);
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('usuario_id', user?.id_usuario ?? '');
        formData.append('usuario_nombre', user?.Nombre ?? '');
        const res = await apiFetch(`/api/facturacion/facturas/${facturaId}/adjuntos`, {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Error al subir');
        const adjRes = await apiFetch(`/api/facturacion/facturas/${facturaId}/adjuntos`);
        const adjData = await adjRes.json();
        setAdjuntos(adjData.adjuntos ?? []);
        fetchFactura();
      } catch (e: unknown) {
        alertMsg('Error', errorMessage(e));
      } finally {
        setSubiendoAdjunto(false);
      }
    };
    input.click();
  };

  const eliminarAdjunto = async (adjId: string) => {
    const ok = await confirmar('Eliminar adjunto', '¿Seguro que deseas eliminar este adjunto?', {
      confirmarLabel: 'Eliminar',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/facturacion/facturas/${facturaId}/adjuntos/${adjId}`, {
        method: 'DELETE',
        body: JSON.stringify({ usuario_id: user?.id_usuario, usuario_nombre: user?.Nombre }),
      });
      setAdjuntos((prev) => prev.filter((a) => a.id !== adjId));
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    }
  };

  const descargarAdjunto = async (adjId: string) => {
    if (!facturaId) return;
    setDescargandoAdjId(adjId);
    try {
      if (tipo === 'IN') {
        await descargarAdjuntoFacturaRecibida(facturaId, adjId);
        alertMsg('Descargado', 'Documento guardado con id_Documento');
        return;
      }
      const adj = adjuntos.find((a) => a.id === adjId);
      if (adj?.url && Platform.OS === 'web') window.open(adj.url, '_blank');
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setDescargandoAdjId(null);
    }
  };

  // ── Email ──
  const abrirModalEmail = () => {
    setEmailDestinatario(empresaEmail || '');
    setEmailAsunto(`Factura ${facturaId}`);
    setEmailCuerpo('');
    setShowEmailModal(true);
  };

  const enviarEmail = async () => {
    if (!emailDestinatario.trim()) { alertMsg('Error', 'Indica un destinatario'); return; }
    setSendingEmail(true);
    try {
      let pdf_base64 = '';
      if (Platform.OS === 'web') {
        const { generarPDFFactura } = await import('../../components/FacturaPDF');
        const emisorData = {
          nombre: emisorNombre, cif: emisorCif, direccion: emisorDireccion,
          cp: emisorCp, municipio: emisorMunicipio, provincia: emisorProvincia,
          email: emisorEmail, telefono: DATOS_EMISOR.telefono,
          iban: emisorIban, ibanAlternativo: emisorIbanAlt,
        };
        const doc = await generarPDFFactura(
          emisorData,
          { nombre: empresaNombre, cif: empresaCif, direccion: empresaDireccion, cp: empresaCp, municipio: empresaMunicipio, provincia: empresaProvincia, email: empresaEmail },
          { id_factura: facturaId, tipo, serie, numero: 0, estado, fecha_emision: fechaEmision, fecha_operacion: fechaOperacion || undefined, fecha_vencimiento: fechaVencimiento || undefined, condiciones_pago: condicionesPago, forma_pago: formaPago, observaciones: observaciones || undefined, numero_factura_proveedor: numFacturaProveedor || undefined, base_imponible: totales.base_imponible, total_iva: totales.total_iva, total_retencion: totales.total_retencion, total_factura: totales.total_factura },
          lineas,
        );
        const arrayBuf = doc.output('arraybuffer');
        const bytes = new Uint8Array(arrayBuf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        pdf_base64 = btoa(binary);
      }
      const res = await apiFetch(`/api/facturacion/facturas/${facturaId}/enviar-email`, {
        method: 'POST',
        body: JSON.stringify({
          destinatario: emailDestinatario,
          asunto: emailAsunto,
          cuerpo: emailCuerpo || undefined,
          pdf_base64: pdf_base64 || undefined,
          usuario_id: user?.id_usuario,
          usuario_nombre: user?.Nombre,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al enviar');
      alertMsg('Enviado', `Email enviado a ${emailDestinatario}`);
      setShowEmailModal(false);
      fetchFactura();
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setSendingEmail(false);
    }
  };

  // ── Title ──
  const titulo = modo === 'crear'
    ? esVenta ? 'Nueva factura de venta' : 'Nueva factura de gasto'
    : `Factura ${numeroFactura || facturaId}`;

  // ── Loading / Error ──
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando factura…</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      {/* ── HEADER ── */}
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push(backPath as any)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={20} color="#334155" />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.title}>{titulo}</Text>
          {modo === 'editar' && <BadgeEstado estado={estado} />}
          {tipo === 'IN' && remesaActiva ? <BadgeEnRemesa /> : null}
          {esVenta && esAbono ? <BadgeAbono /> : null}
        </View>
      </View>

      {tipo === 'IN' && modo === 'editar' && remesaActiva ? (
        <View style={styles.remesaActivaBanner}>
          <MaterialIcons name="account-balance" size={18} color="#1d4ed8" />
          <View style={styles.remesaActivaBannerBody}>
            <View style={styles.remesaActivaBannerLine}>
              <Text style={styles.remesaActivaBannerText}>Incluida en remesa </Text>
              {hasPermiso('remesas.ver') ? (
                <TouchableOpacity
                  onPress={() => router.push(`/facturacion/remesas/${remesaActiva.remesaId}` as never)}
                  hitSlop={6}
                >
                  <Text style={styles.remesaActivaLink}>
                    {remesaActiva.nombre || remesaActiva.remesaId}
                  </Text>
                </TouchableOpacity>
              ) : (
                <Text style={styles.remesaActivaNombre}>
                  {remesaActiva.nombre || remesaActiva.remesaId}
                </Text>
              )}
              <Text style={styles.remesaActivaBannerText}> ({remesaActiva.estado})</Text>
            </View>
            <Text style={styles.remesaActivaBannerHint}>
              No se pueden registrar, editar ni eliminar pagos mientras figure en esta remesa.
            </Text>
          </View>
          {hasPermiso('remesas.gestionar') ? (
            <TouchableOpacity
              style={styles.btnQuitarRemesa}
              onPress={quitarDeRemesa}
              disabled={quitandoRemesa}
            >
              {quitandoRemesa ? (
                <ActivityIndicator size="small" color="#1d4ed8" />
              ) : (
                <>
                  <MaterialIcons name="remove-circle-outline" size={16} color="#1d4ed8" />
                  <Text style={styles.btnQuitarRemesaText}>Quitar de la remesa</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {/* ── ACTION BUTTONS ── */}
      <View style={styles.actionsRow}>
        {esEditable && (
          <TouchableOpacity style={styles.btnPrimary} onPress={guardarBorrador} disabled={saving}>
            {saving ? <ActivityIndicator size="small" color="#fff" /> : (
              <>
                <MaterialIcons name="save" size={16} color="#fff" />
                <Text style={styles.btnPrimaryText}>
                  {tipo === 'IN' && estado !== 'borrador' ? 'Guardar' : 'Guardar borrador'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        )}
        {puedeEmitir && hasPermiso('facturacion.emitir') && (
          <TouchableOpacity style={styles.btnSuccess} onPress={emitirFactura} disabled={saving}>
            <MaterialIcons name={esValidacionRevisionIn ? 'task-alt' : 'send'} size={16} color="#fff" />
            <Text style={styles.btnSuccessText}>
              {esValidacionRevisionIn ? 'Validar revisión' : 'Emitir'}
            </Text>
          </TouchableOpacity>
        )}
        {puedeDuplicar && (
          <TouchableOpacity style={styles.btnOutline} onPress={duplicarFactura} disabled={saving}>
            <MaterialIcons name="content-copy" size={16} color="#0ea5e9" />
            <Text style={styles.btnOutlineText}>Duplicar</Text>
          </TouchableOpacity>
        )}
        {puedeRectificar && (
          <TouchableOpacity style={styles.btnOutlineWarn} onPress={rectificarFactura} disabled={saving}>
            <MaterialIcons name="replay" size={16} color="#b45309" />
            <Text style={styles.btnOutlineWarnText}>Rectificativa</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.btnOutline} onPress={previsualizarPDF}>
          <MaterialIcons name="visibility" size={16} color="#0ea5e9" />
          <Text style={styles.btnOutlineText}>Previsualizar PDF</Text>
        </TouchableOpacity>
        {modo === 'editar' && (
          <TouchableOpacity style={styles.btnOutline} onPress={descargarPDF}>
            <MaterialIcons name="picture-as-pdf" size={16} color="#0ea5e9" />
            <Text style={styles.btnOutlineText}>Descargar PDF</Text>
          </TouchableOpacity>
        )}
        {modo === 'editar' && estado !== 'borrador' && (
          <TouchableOpacity style={styles.btnOutline} onPress={abrirModalEmail}>
            <MaterialIcons name="email" size={16} color="#0ea5e9" />
            <Text style={styles.btnOutlineText}>Enviar email</Text>
          </TouchableOpacity>
        )}
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {/* ── EMISOR/EMPRESA + RECEPTOR/PROVEEDOR ── */}
      <View style={[styles.empresaRow, !isWide && { flexDirection: 'column' }]}>
        {/* EMISOR (OUT) o Empresa GRUPO PARIPE (IN) */}
        <View style={[styles.section, { flex: 1, zIndex: 110, overflow: 'visible' } as any]}>
          <Text style={styles.sectionTitle}>{esVenta ? 'Emisor *' : 'Empresa *'}</Text>
          {!esVenta ? (
            <Text style={styles.sectionHint}>Solo sociedades con sede GRUPO PARIPE (receptora del gasto)</Text>
          ) : null}
          <View style={styles.empresaSelector}>
            <TextInput
              style={styles.input}
              placeholder={esVenta ? 'Buscar emisor por nombre o CIF…' : 'Buscar empresa por nombre o CIF…'}
              placeholderTextColor="#94a3b8"
              value={emisorSearch || emisorNombre}
              onChangeText={(t) => {
                setEmisorSearch(t);
                setShowEmisorDropdown(true);
                if (!t) {
                  setEmisorId(''); setEmisorNombre(''); setEmisorCif('');
                  setEmisorDireccion(''); setEmisorCp(''); setEmisorMunicipio('');
                  setEmisorProvincia(''); setEmisorEmail('');
                  setEmisorIban(''); setEmisorIbanAlt('');
                }
              }}
              onFocus={() => { setShowEmisorDropdown(true); setShowEmpresaDropdown(false); }}
              editable={esEditable}
            />
            {showEmisorDropdown && emisorFiltradas.length > 0 && (
              <View style={styles.dropdown}>
                <ScrollView style={styles.dropdownScroll} nestedScrollEnabled>
                  {emisorFiltradas.slice(0, 20).map((e) => (
                    <TouchableOpacity
                      key={e.id_empresa}
                      style={styles.dropdownItem}
                      onPress={() => selectEmisor(e)}
                    >
                      <Text style={styles.dropdownName}>{e.nombre}</Text>
                      <Text style={styles.dropdownCif}>{e.cif}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}
          </View>
          {emisorNombre ? (
            <View style={styles.empresaInfo}>
              <Text style={styles.empresaInfoText}>{emisorCif} · {emisorDireccion}</Text>
              <Text style={styles.empresaInfoText}>{emisorCp} {emisorMunicipio}, {emisorProvincia}</Text>
              {emisorEmail ? <Text style={styles.empresaInfoText}>{emisorEmail}</Text> : null}
              {emisorIban ? <Text style={styles.empresaInfoText}>IBAN: {emisorIban}</Text> : null}
              {emisorIbanAlt ? <Text style={styles.empresaInfoText}>IBAN Alt: {emisorIbanAlt}</Text> : null}
            </View>
          ) : null}
        </View>

        {/* RECEPTOR (OUT) o Proveedor (IN) */}
        <View style={[styles.section, { flex: 1, zIndex: 100, overflow: 'visible' } as any]}>
          <Text style={styles.sectionTitle}>{esVenta ? 'Receptor *' : 'Proveedor *'}</Text>
          <View style={styles.empresaSelector}>
            <TextInput
              style={styles.input}
              placeholder={esVenta ? 'Buscar receptor por nombre o CIF…' : 'Buscar proveedor por nombre o CIF…'}
              placeholderTextColor="#94a3b8"
              value={empresaSearch || empresaNombre}
              onChangeText={(t) => {
                setEmpresaSearch(t);
                setShowEmpresaDropdown(true);
                if (!t) {
                  setEmpresaId(''); setEmpresaNombre(''); setEmpresaCif('');
                  setEmpresaDireccion(''); setEmpresaCp(''); setEmpresaMunicipio('');
                  setEmpresaProvincia(''); setEmpresaEmail('');
                  setEmpresaIban(''); setEmpresaIbanAlt('');
                }
              }}
              onFocus={() => { setShowEmpresaDropdown(true); setShowEmisorDropdown(false); }}
              editable={esEditable}
            />
            {showEmpresaDropdown && empresasFiltradas.length > 0 && (
              <View style={styles.dropdown}>
                <ScrollView style={styles.dropdownScroll} nestedScrollEnabled>
                  {empresasFiltradas.slice(0, 20).map((e) => (
                    <TouchableOpacity
                      key={e.id_empresa}
                      style={styles.dropdownItem}
                      onPress={() => selectEmpresa(e)}
                    >
                      <Text style={styles.dropdownName}>{e.nombre}</Text>
                      <Text style={styles.dropdownCif}>{e.cif}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}
          </View>
          {empresaId ? (
            <View style={styles.empresaInfo}>
              <Text style={styles.empresaInfoText}>{empresaCif} · {empresaDireccion}</Text>
              <Text style={styles.empresaInfoText}>{empresaCp} {empresaMunicipio}, {empresaProvincia}</Text>
              {empresaEmail ? <Text style={styles.empresaInfoText}>{empresaEmail}</Text> : null}
              {empresaIban ? <Text style={styles.empresaInfoText}>IBAN: {empresaIban}</Text> : null}
              {empresaIbanAlt ? <Text style={styles.empresaInfoText}>IBAN Alt: {empresaIbanAlt}</Text> : null}
            </View>
          ) : null}
        </View>
      </View>

      {/* ── FORM FIELDS ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Datos de la factura</Text>
        <View style={[styles.formGrid, isWide && styles.formGridWide]}>
          {/* Serie */}
          <View style={styles.field}>
            <Text style={styles.label}>Serie {esVenta ? '*' : ''}</Text>
            <View style={styles.pickerWrap}>
              {seriesFiltradas.length === 0 ? (
                <Text style={styles.pickerPlaceholder}>Sin series disponibles</Text>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {seriesFiltradas.map((s) => (
                    <TouchableOpacity
                      key={s.serie}
                      style={[styles.chip, serie === s.serie && styles.chipActive]}
                      onPress={() => esEditable && setSerie(s.serie)}
                      disabled={!esEditable}
                    >
                      <Text style={[styles.chipText, serie === s.serie && styles.chipTextActive]}>
                        {s.serie} – {s.descripcion}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          </View>

          {/* Nº Factura */}
          <View style={styles.field}>
            <Text style={styles.label}>Nº de factura</Text>
            {numeroProvisionalVenta ? (
              <>
                <Text style={styles.numeroFacturaProvisional}>Provisional</Text>
                <Text style={styles.numeroFacturaHint}>El número se asignará al emitir la factura</Text>
              </>
            ) : modo === 'editar' && numeroFactura ? (
              <Text style={styles.numeroFacturaText}>{numeroFactura}</Text>
            ) : previewNumFactura ? (
              <Text style={styles.numeroFacturaPreview}>{previewNumFactura}</Text>
            ) : (
              <Text style={styles.numeroFacturaAuto}>
                {esVenta
                  ? (!emisorId ? 'Seleccione emisor y serie' : !serie ? 'Seleccione una serie' : 'Calculando...')
                  : 'Se genera automáticamente al guardar'}
              </Text>
            )}
          </View>

          {mostrarIdFactura ? (
            <View style={styles.field}>
              <CampoIdFactura idFactura={facturaId} />
            </View>
          ) : null}

          {/* Fecha emisión */}
          <View style={styles.field}>
            <Text style={styles.label}>Fecha emisión *</Text>
            <InputFecha valueIso={fechaEmision} onChangeIso={setFechaEmision} placeholder="dd/mm/aaaa" editable={esEditable} />
          </View>

          {/* Fecha operación */}
          <View style={styles.field}>
            <Text style={styles.label}>Fecha operación</Text>
            <InputFecha valueIso={fechaOperacion} onChangeIso={setFechaOperacion} placeholder="dd/mm/aaaa" editable={esEditable} />
          </View>

          {/* Fecha vencimiento */}
          <View style={styles.field}>
            <Text style={styles.label}>Fecha vencimiento</Text>
            <InputFecha valueIso={fechaVencimiento} onChangeIso={setFechaVencimiento} placeholder="dd/mm/aaaa" editable={esEditable} />
          </View>

          {/* Condiciones + forma de pago: una fila, ambos desplegables */}
          <View style={[styles.field, styles.fieldCondFormaRow]}>
            <View style={styles.condFormaCol}>
              <Text style={styles.label}>Condiciones de pago</Text>
              {esEditable ? (
                <SelectorDesplegable
                  icono="event"
                  tituloLista="Condiciones de pago"
                  iconoLista="event"
                  valorId={condicionesPago}
                  opciones={CONDICIONES_PAGO.map((c) => ({ id: c, titulo: c }))}
                  onSeleccionar={(id) => setCondicionesPago(id)}
                />
              ) : (
                <Text style={styles.readOnlyInline}>{condicionesPago}</Text>
              )}
            </View>
            <View style={styles.condFormaCol}>
              <Text style={styles.label}>Forma de pago</Text>
              {esEditable ? (
                <SelectorDesplegable
                  icono="payments"
                  tituloLista="Forma de pago"
                  iconoLista="payments"
                  valorId={formaPago}
                  opciones={FORMAS_PAGO.map((fp) => ({ id: fp, titulo: labelFormaPago(fp), icono: 'payments' as const }))}
                  onSeleccionar={(id) => setFormaPago(id)}
                />
              ) : (
                <Text style={styles.readOnlyInline}>{labelFormaPago(formaPago)}</Text>
              )}
            </View>
          </View>

          {/* IN-only fields */}
          {tipo === 'IN' && (
            <>
              <View style={styles.field}>
                <Text style={styles.label}>Nº factura proveedor</Text>
                <TextInput
                  style={styles.input}
                  value={numFacturaProveedor}
                  onChangeText={setNumFacturaProveedor}
                  placeholder="Referencia del proveedor"
                  placeholderTextColor="#94a3b8"
                  editable={esEditable}
                />
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>Fecha contabilización</Text>
                <TextInput
                  style={[styles.input, styles.inputReadOnly]}
                  value={textoFechaContabilizacionGasto({
                    fechaContabilizacion: fechaContabilizacionIso,
                    contabilizadoPor,
                    creadoEn,
                  })}
                  editable={false}
                  multiline
                  placeholder="—"
                  placeholderTextColor="#94a3b8"
                />
              </View>
              <CampoIdDocumentoFacturaRecibida
                empresaNombre={emisorNombre}
                fechaEmision={fechaEmision}
                proveedorNombre={empresaNombre}
                numeroFacturaProveedor={numFacturaProveedor}
              />
              <CampoConceptoRemesaFacturaRecibida
                numeroFacturaProveedor={numFacturaProveedor}
                numeroFactura={numeroFactura || previewNumFactura}
                proveedorNombre={empresaNombre}
                observaciones={observaciones}
              />
            </>
          )}

          {/* Local */}
          <View style={styles.field}>
            <Text style={styles.label}>Local</Text>
            <View style={styles.pickerWrap}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <TouchableOpacity
                  style={[styles.chip, !localId && styles.chipActive]}
                  onPress={() => esEditable && setLocalId('')}
                  disabled={!esEditable}
                >
                  <Text style={[styles.chipText, !localId && styles.chipTextActive]}>Sin local</Text>
                </TouchableOpacity>
                {locales.map((l) => (
                  <TouchableOpacity
                    key={l.id_local}
                    style={[styles.chip, localId === l.id_local && styles.chipActive]}
                    onPress={() => esEditable && setLocalId(l.id_local)}
                    disabled={!esEditable}
                  >
                    <Text style={[styles.chipText, localId === l.id_local && styles.chipTextActive]}>{l.nombre}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </View>

          {/* Es abono: en ventas el total solo puede ser negativo si el documento es un abono */}
          {esVenta && esEditable && (
            <View style={[styles.field, styles.fieldFull]}>
              <TouchableOpacity
                style={styles.checkRow}
                onPress={() => setEsAbono((v) => !v)}
                activeOpacity={0.7}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: esAbono }}
                accessibilityLabel="Es abono (importes en negativo)"
              >
                <MaterialIcons
                  name={esAbono ? 'check-box' : 'check-box-outline-blank'}
                  size={20}
                  color={esAbono ? '#b91c1c' : '#64748b'}
                />
                <Text style={styles.checkLabel}>Es abono (importes en negativo)</Text>
              </TouchableOpacity>
              <Text style={styles.checkHint}>
                Márcalo para devolver importe (por ejemplo, abonos de rappel). Solo puede cambiarse mientras es un borrador.
              </Text>
            </View>
          )}

          {avisoAbono ? (
            <View style={[styles.field, styles.fieldFull, styles.avisoAbonoBox]}>
              <MaterialIcons name="warning" size={16} color="#b45309" />
              <Text style={styles.avisoAbonoText}>{avisoAbono}</Text>
            </View>
          ) : null}

          {/* Observaciones */}
          <View style={[styles.field, styles.fieldFull]}>
            <Text style={styles.label}>Observaciones</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={observaciones}
              onChangeText={setObservaciones}
              placeholder="Notas internas o para el cliente…"
              placeholderTextColor="#94a3b8"
              multiline
              numberOfLines={3}
              editable={esEditable}
            />
          </View>
        </View>
      </View>

      {/* ── LÍNEAS DE FACTURA ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Líneas de factura</Text>

        {esEditable && (
          <View style={styles.lineasActions}>
            <TouchableOpacity style={styles.btnSmall} onPress={addLinea}>
              <MaterialIcons name="add" size={16} color="#0ea5e9" />
              <Text style={styles.btnSmallText}>Añadir línea</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnSmall} onPress={openProductModal}>
              <MaterialIcons name="inventory" size={16} color="#0ea5e9" />
              <Text style={styles.btnSmallText}>Desde producto</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Column headers */}
        {isWide && (
          <View style={styles.lineaHeaderRow}>
            <Text style={[styles.lineaHeaderCell, { flex: 3, textAlign: 'left', paddingLeft: 6 }]}>Descripción</Text>
            <Text style={[styles.lineaHeaderCell, { flex: 1 }]}>Cant.</Text>
            <Text style={[styles.lineaHeaderCell, { flex: 1 }]}>Precio</Text>
            <Text style={[styles.lineaHeaderCell, { flex: 1 }]}>Dto%</Text>
            <Text style={[styles.lineaHeaderCell, { flex: 1 }]}>IVA%</Text>
            <Text style={[styles.lineaHeaderCell, { flex: 1 }]}>Ret%</Text>
            <Text style={[styles.lineaHeaderCell, { flex: 1.2 }]}>Base</Text>
            <Text style={[styles.lineaHeaderCell, { flex: 1.2 }]}>Total</Text>
            {esEditable && <View style={{ width: 32 }} />}
          </View>
        )}

        {lineas.map((linea, idx) => {
          const calc = calcularLinea(linea);
          return isWide ? (
            <View key={idx} style={styles.lineaRow}>
              <TextInput
                style={[styles.lineaInput, { flex: 3, textAlign: 'left' }]}
                value={linea.descripcion}
                onChangeText={(v) => updateLinea(idx, 'descripcion', v)}
                placeholder="Descripción"
                placeholderTextColor="#94a3b8"
                editable={esEditable}
              />
              <ImporteMonedaInput
                style={[styles.lineaInput, { flex: 1 }]}
                valor={linea.cantidad}
                onChangeValor={(n) => updateLinea(idx, 'cantidad', String(n))}
                maxDecimales={3}
                editable={esEditable}
              />
              <ImporteMonedaInput
                style={[styles.lineaInput, { flex: 1.2 }]}
                valor={linea.precio_unitario}
                onChangeValor={(n) => updateLinea(idx, 'precio_unitario', String(n))}
                editable={esEditable}
              />
              <TextInput
                style={[styles.lineaInput, { flex: 1 }]}
                value={String(linea.descuento_pct)}
                onChangeText={(v) => updateLinea(idx, 'descuento_pct', v)}
                keyboardType="decimal-pad"
                editable={esEditable}
              />
              <TextInput
                style={[styles.lineaInput, { flex: 1 }]}
                value={String(linea.tipo_iva)}
                onChangeText={(v) => updateLinea(idx, 'tipo_iva', v)}
                keyboardType="decimal-pad"
                editable={esEditable}
              />
              <TextInput
                style={[styles.lineaInput, { flex: 1 }]}
                value={String(linea.retencion_pct)}
                onChangeText={(v) => updateLinea(idx, 'retencion_pct', v)}
                keyboardType="decimal-pad"
                editable={esEditable}
              />
              <Text style={[styles.lineaCalc, { flex: 1.2 }]}>{formatMoneda(calc.base_linea)}</Text>
              <Text style={[styles.lineaCalc, { flex: 1.2 }]}>{formatMoneda(calc.total_linea)}</Text>
              {esEditable && (
                <TouchableOpacity style={styles.lineaDeleteBtn} onPress={() => removeLinea(idx)}>
                  <MaterialIcons name="delete-outline" size={18} color="#dc2626" />
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <View key={idx} style={styles.lineaCard}>
              <View style={styles.lineaCardHeader}>
                <Text style={styles.lineaCardNum}>Línea {idx + 1}</Text>
                {esEditable && (
                  <TouchableOpacity onPress={() => removeLinea(idx)}>
                    <MaterialIcons name="delete-outline" size={18} color="#dc2626" />
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={styles.input}
                value={linea.descripcion}
                onChangeText={(v) => updateLinea(idx, 'descripcion', v)}
                placeholder="Descripción"
                placeholderTextColor="#94a3b8"
                editable={esEditable}
              />
              <View style={styles.lineaCardRow}>
                <View style={styles.lineaCardField}>
                  <Text style={styles.labelSmall}>Cant.</Text>
                  <ImporteMonedaInput style={styles.inputSmall} valor={linea.cantidad} onChangeValor={(n) => updateLinea(idx, 'cantidad', String(n))} maxDecimales={3} editable={esEditable} />
                </View>
                <View style={styles.lineaCardField}>
                  <Text style={styles.labelSmall}>Precio</Text>
                  <ImporteMonedaInput style={styles.inputSmall} valor={linea.precio_unitario} onChangeValor={(n) => updateLinea(idx, 'precio_unitario', String(n))} editable={esEditable} />
                </View>
                <View style={styles.lineaCardField}>
                  <Text style={styles.labelSmall}>Dto%</Text>
                  <TextInput style={styles.inputSmall} value={String(linea.descuento_pct)} onChangeText={(v) => updateLinea(idx, 'descuento_pct', v)} keyboardType="decimal-pad" editable={esEditable} />
                </View>
              </View>
              <View style={styles.lineaCardRow}>
                <View style={styles.lineaCardField}>
                  <Text style={styles.labelSmall}>IVA%</Text>
                  <TextInput style={styles.inputSmall} value={String(linea.tipo_iva)} onChangeText={(v) => updateLinea(idx, 'tipo_iva', v)} keyboardType="decimal-pad" editable={esEditable} />
                </View>
                <View style={styles.lineaCardField}>
                  <Text style={styles.labelSmall}>Ret%</Text>
                  <TextInput style={styles.inputSmall} value={String(linea.retencion_pct)} onChangeText={(v) => updateLinea(idx, 'retencion_pct', v)} keyboardType="decimal-pad" editable={esEditable} />
                </View>
                <View style={styles.lineaCardField}>
                  <Text style={styles.labelSmall}>Base</Text>
                  <Text style={styles.lineaCalcSmall}>{formatMoneda(calc.base_linea)}</Text>
                </View>
              </View>
              <Text style={styles.lineaCardTotal}>Total: {formatMoneda(calc.total_linea)}</Text>
            </View>
          );
        })}

        {/* Resumen totales */}
        <View style={styles.totalesWrap}>
          <ResumenTotales
            base_imponible={totales.base_imponible}
            total_iva={totales.total_iva}
            total_retencion={totales.total_retencion}
            total_factura={totales.total_factura}
            desglose_iva={totales.desglose_iva}
            desglose_retencion={totales.desglose_retencion}
          />
        </View>
      </View>

      {/* ── PAGOS ── */}
      {(puedeRegistrarPago || (modo === 'editar' && pagos.length > 0)) && (
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>
              {esVenta ? 'Cobros' : 'Pagos'}
            </Text>
            {puedeRegistrarPago ? (
              <TouchableOpacity style={styles.btnSmall} onPress={abrirModalPago}>
                <MaterialIcons name="add" size={16} color="#0ea5e9" />
                <Text style={styles.btnSmallText}>Registrar {esVenta ? 'cobro' : 'pago'}</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {pagos.length === 0 ? (
            <Text style={styles.emptyText}>No hay {esVenta ? 'cobros' : 'pagos'} registrados</Text>
          ) : (
            pagos.map((p) => (
              <View key={p.id_pago} style={styles.pagoRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.pagoFecha}>{formatFechaPagoRow(p.fecha)}</Text>
                  <Text style={styles.pagoMeta}>
                    {labelFormaPago(p.metodo_pago)}
                    {p.referencia ? ` · ${p.referencia}` : ''}
                  </Text>
                  {p.observaciones ? <Text style={styles.pagoObs}>{p.observaciones}</Text> : null}
                  <Text style={styles.pagoAutor}>{p.creado_por_nombre} – {p.creado_en}</Text>
                </View>
                <Text style={styles.pagoImporte}>{formatMoneda(p.importe)}</Text>
              </View>
            ))
          )}
        </View>
      )}

      {/* ── ADJUNTOS ── */}
      {modo === 'editar' && (
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={styles.sectionTitle}>Adjuntos</Text>
            <TouchableOpacity
              style={[styles.btnOutline, { paddingVertical: 4, paddingHorizontal: 8 }]}
              onPress={subirAdjunto}
              disabled={subiendoAdjunto}
            >
              {subiendoAdjunto ? <ActivityIndicator size="small" color="#0ea5e9" /> : (
                <>
                  <MaterialIcons name="attach-file" size={14} color="#0ea5e9" />
                  <Text style={[styles.btnOutlineText, { fontSize: 11 }]}>Subir archivo</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
          {adjuntos.length === 0 ? (
            <Text style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>Sin adjuntos</Text>
          ) : (
            adjuntos.map((adj) => (
              <View key={adj.id} style={styles.adjuntoRow}>
                <MaterialIcons
                  name={adj.tipo?.includes('pdf') ? 'picture-as-pdf' : adj.tipo?.startsWith('image') ? 'image' : 'insert-drive-file'}
                  size={18}
                  color={adj.tipo?.includes('pdf') ? '#dc2626' : '#0ea5e9'}
                />
                <View style={{ flex: 1, marginLeft: 6 }}>
                  <Text style={styles.adjuntoNombre} numberOfLines={1}>{adj.nombre}</Text>
                  <Text style={styles.adjuntoMeta}>
                    {adj.subido_por} · {adj.subido_en ? new Date(adj.subido_en).toLocaleDateString('es-ES') : ''} · {((adj.size || 0) / 1024).toFixed(0)} KB
                  </Text>
                </View>
                {adj.url && (
                  <TouchableOpacity
                    onPress={() => descargarAdjunto(adj.id)}
                    style={{ padding: 4 }}
                    disabled={descargandoAdjId === adj.id}
                    accessibilityLabel={tipo === 'IN' ? 'Descargar documento' : 'Abrir documento'}
                  >
                    {descargandoAdjId === adj.id ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <MaterialIcons
                        name={tipo === 'IN' ? 'download' : 'open-in-new'}
                        size={16}
                        color="#0ea5e9"
                      />
                    )}
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => eliminarAdjunto(adj.id)} style={{ padding: 4 }}>
                  <MaterialIcons name="delete-outline" size={16} color="#dc2626" />
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>
      )}

      {/* ── AUDITORÍA ── */}
      {modo === 'editar' && auditLog.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Auditoría</Text>
          {auditLog.map((entry, idx) => (
            <View key={idx} style={styles.auditRow}>
              <MaterialIcons name="history" size={14} color="#94a3b8" />
              <View style={{ flex: 1, marginLeft: 6 }}>
                <Text style={styles.auditAction}>{entry.accion}</Text>
                <Text style={styles.auditMeta}>{entry.usuario_nombre} · {formatCreadoEn(entry.timestamp_accion)}</Text>
                {entry.detalle ? <Text style={styles.auditDetail}>{entry.detalle}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      )}

      <View style={{ height: 40 }} />

      {/* ── MODAL PRODUCTOS ── */}
      <Modal visible={showProductModal} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => setShowProductModal(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Seleccionar producto</Text>
              <TouchableOpacity onPress={() => setShowProductModal(false)}>
                <MaterialIcons name="close" size={22} color="#334155" />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.input}
              placeholder="Buscar por nombre o referencia…"
              placeholderTextColor="#94a3b8"
              value={productoSearch}
              onChangeText={setProductoSearch}
              autoFocus
            />
            {loadingProductos ? (
              <ActivityIndicator size="small" color="#0ea5e9" style={{ marginVertical: 16 }} />
            ) : (
              <ScrollView style={styles.modalScroll}>
                {productosFiltrados.length === 0 ? (
                  <Text style={styles.emptyText}>Sin resultados</Text>
                ) : (
                  productosFiltrados.slice(0, 50).map((p) => (
                    <TouchableOpacity key={p.id_producto} style={styles.productoRow} onPress={() => selectProducto(p)}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.productoNombre}>{p.nombre}</Text>
                        <Text style={styles.productoRef}>{p.referencia}</Text>
                      </View>
                      <Text style={styles.productoPrecio}>{formatMoneda(p.precio_venta)}</Text>
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <RegistrarPagoModal
        visible={showPagoModal}
        onClose={() => setShowPagoModal(false)}
        modo="factura"
        variant={esVenta ? 'cobro' : 'pago'}
        initial={pagoInitial}
        fechaReferenciaTarjeta={fechaReferenciaTarjetaPago}
        datosPago={datosPagoModal}
        habilitarCompensacion={!esVenta}
        facturaId={facturaId}
        saldoOrigen={saldoPendiente}
        submitting={savingPago}
        onValidationError={alertMsg}
        onSubmit={registrarPago}
      />

      {/* ── EMAIL MODAL ── */}
      <Modal visible={showEmailModal} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => setShowEmailModal(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Enviar factura por email</Text>
              <TouchableOpacity onPress={() => setShowEmailModal(false)}>
                <MaterialIcons name="close" size={22} color="#334155" />
              </TouchableOpacity>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Destinatario *</Text>
              <TextInput
                style={styles.input}
                value={emailDestinatario}
                onChangeText={setEmailDestinatario}
                placeholder="email@empresa.com"
                placeholderTextColor="#94a3b8"
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Asunto</Text>
              <TextInput
                style={styles.input}
                value={emailAsunto}
                onChangeText={setEmailAsunto}
                placeholder="Asunto del email"
                placeholderTextColor="#94a3b8"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Mensaje (opcional)</Text>
              <TextInput
                style={[styles.input, styles.inputMultiline]}
                value={emailCuerpo}
                onChangeText={setEmailCuerpo}
                placeholder="Mensaje personalizado…"
                placeholderTextColor="#94a3b8"
                multiline
                numberOfLines={4}
              />
              <Text style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                Si dejas vacío se usará un mensaje predeterminado. El PDF se adjuntará automáticamente.
              </Text>
            </View>

            <TouchableOpacity style={[styles.btnPrimary, { marginTop: 8 }]} onPress={enviarEmail} disabled={sendingEmail}>
              {sendingEmail ? <ActivityIndicator size="small" color="#fff" /> : (
                <>
                  <MaterialIcons name="send" size={14} color="#fff" />
                  <Text style={styles.btnPrimaryText}>Enviar</Text>
                </>
              )}
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
    {ToastView}
    {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  contentContainer: {
    padding: 12,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
  },
  loadingText: {
    marginTop: 8,
    fontSize: 13,
    color: '#64748b',
  },

  // Header
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  backBtn: {
    padding: 4,
  },
  headerTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    flexWrap: 'wrap',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#334155',
  },
  remesaActivaBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  remesaActivaBannerBody: {
    flex: 1,
    minWidth: 180,
    gap: 2,
  },
  remesaActivaBannerLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  remesaActivaBannerText: {
    fontSize: 13,
    color: '#1e3a8a',
    fontWeight: '600',
  },
  remesaActivaNombre: {
    fontWeight: '700',
    color: '#1e40af',
  },
  remesaActivaLink: {
    fontWeight: '700',
    color: '#2563eb',
    textDecorationLine: 'underline',
  },
  remesaActivaBannerHint: {
    fontSize: 12,
    color: '#64748b',
  },
  btnQuitarRemesa: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#93c5fd',
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    minHeight: MIN_TOUCH,
  },
  btnQuitarRemesaText: {
    color: '#1d4ed8',
    fontSize: 12,
    fontWeight: '600',
  },

  // Actions
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  btnPrimaryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  btnSuccess: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#059669',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  btnSuccessText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  btnOutline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#fff',
  },
  btnOutlineText: {
    color: '#0ea5e9',
    fontSize: 13,
    fontWeight: '600',
  },
  btnOutlineWarn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#b45309',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#fff',
  },
  btnOutlineWarnText: {
    color: '#b45309',
    fontSize: 13,
    fontWeight: '600',
  },
  btnSmall: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    backgroundColor: '#f0f9ff',
  },
  btnSmallText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0ea5e9',
  },

  errorText: {
    color: '#dc2626',
    fontSize: 12,
    marginBottom: 8,
  },

  // Sections
  section: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 10,
  },
  sectionHint: {
    fontSize: 11,
    color: '#64748b',
    marginTop: -6,
    marginBottom: 8,
    lineHeight: 15,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },

  // Empresa selector
  empresaRow: {
    flexDirection: 'row' as const,
    gap: 10,
    zIndex: 100,
    overflow: 'visible' as const,
  },
  empresaSelector: {
    position: 'relative' as const,
    zIndex: 100,
    overflow: 'visible' as const,
  },
  dropdown: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    maxHeight: 220,
    zIndex: 9999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 10,
  },
  dropdownScroll: {
    maxHeight: 200,
  },
  dropdownItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  dropdownName: {
    fontSize: 13,
    fontWeight: '500',
    color: '#334155',
  },
  dropdownCif: {
    fontSize: 11,
    color: '#64748b',
  },
  empresaInfo: {
    marginTop: 8,
    backgroundColor: '#f8fafc',
    borderRadius: 4,
    padding: 8,
    gap: 2,
  },
  empresaInfoText: {
    fontSize: 11,
    color: '#64748b',
  },

  // Form
  formGrid: {
    gap: 10,
  },
  formGridWide: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  field: {
    minWidth: 200,
    flexGrow: 1,
    flexBasis: '45%',
    marginBottom: 4,
  },
  fieldFull: {
    flexBasis: '100%',
  },
  /** Condiciones + forma de pago en una fila */
  fieldCondFormaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    flexBasis: '100%',
    minWidth: 280,
  },
  condFormaCol: {
    flex: 1,
    minWidth: 160,
  },
  readOnlyInline: {
    fontSize: 12,
    color: '#334155',
    paddingVertical: 8,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: MIN_TOUCH,
    alignSelf: 'flex-start',
    paddingRight: 8,
  },
  checkLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
  },
  checkHint: {
    fontSize: 11,
    color: '#64748b',
    lineHeight: 15,
  },
  avisoAbonoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  avisoAbonoText: {
    flex: 1,
    fontSize: 11,
    color: '#92400e',
    lineHeight: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
    marginBottom: 4,
  },
  inputReadOnly: {
    backgroundColor: '#f8fafc',
    color: '#334155',
    minHeight: 36,
  },
  numeroFacturaText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0369a1',
    paddingVertical: 4,
  },
  numeroFacturaAuto: {
    fontSize: 11,
    fontStyle: 'italic',
    color: '#94a3b8',
    paddingVertical: 4,
  },
  numeroFacturaPreview: {
    fontSize: 18,
    fontWeight: '700',
    color: '#059669',
    paddingVertical: 4,
    fontStyle: 'italic',
  },
  numeroFacturaProvisional: {
    fontSize: 18,
    fontWeight: '700',
    color: '#b45309',
    paddingVertical: 4,
    fontStyle: 'italic',
  },
  numeroFacturaHint: {
    fontSize: 10,
    color: '#94a3b8',
    lineHeight: 14,
  },
  labelSmall: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 2,
  },
  input: {
    fontSize: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
    backgroundColor: '#fff',
    color: '#334155',
  },
  inputSmall: {
    fontSize: 12,
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
    backgroundColor: '#fff',
    color: '#334155',
  },
  inputMultiline: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  pickerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  pickerPlaceholder: {
    fontSize: 12,
    color: '#94a3b8',
    fontStyle: 'italic',
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    marginRight: 6,
  },
  chipActive: {
    backgroundColor: '#0ea5e9',
    borderColor: '#0ea5e9',
  },
  chipText: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '500',
  },
  chipTextActive: {
    color: '#fff',
  },

  // Líneas
  lineasActions: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  lineaHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    marginBottom: 4,
  },
  lineaHeaderCell: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  lineaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  lineaInput: {
    fontSize: 12,
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
    backgroundColor: '#fff',
    color: '#334155',
    textAlign: 'center',
  },
  lineaCalc: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
    textAlign: 'center',
  },
  lineaDeleteBtn: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },

  // Líneas mobile
  lineaCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    padding: 10,
    marginBottom: 8,
    backgroundColor: '#fafbfc',
    gap: 6,
  },
  lineaCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  lineaCardNum: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
  },
  lineaCardRow: {
    flexDirection: 'row',
    gap: 8,
  },
  lineaCardField: {
    flex: 1,
  },
  lineaCalcSmall: {
    fontSize: 12,
    fontWeight: '500',
    color: '#334155',
    paddingVertical: 6,
  },
  lineaCardTotal: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    textAlign: 'right',
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },

  totalesWrap: {
    marginTop: 12,
    alignItems: 'flex-end',
  },

  // Pagos
  pagoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  pagoFecha: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
  },
  pagoMeta: {
    fontSize: 11,
    color: '#64748b',
  },
  pagoObs: {
    fontSize: 11,
    color: '#94a3b8',
    fontStyle: 'italic',
  },
  pagoAutor: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 2,
  },
  pagoImporte: {
    fontSize: 14,
    fontWeight: '700',
    color: '#059669',
  },
  emptyText: {
    fontSize: 12,
    color: '#94a3b8',
    textAlign: 'center',
    paddingVertical: 12,
  },

  // Audit
  adjuntoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 4,
  },
  adjuntoNombre: { fontSize: 12, fontWeight: '500', color: '#334155' },
  adjuntoMeta: { fontSize: 10, color: '#94a3b8' },

  auditRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  auditAction: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
  },
  auditMeta: {
    fontSize: 10,
    color: '#94a3b8',
  },
  auditDetail: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    width: '100%',
    maxWidth: 520,
    maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#334155',
  },
  modalScroll: {
    maxHeight: 320,
    marginTop: 10,
  },
  productoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  productoNombre: {
    fontSize: 13,
    fontWeight: '500',
    color: '#334155',
  },
  productoRef: {
    fontSize: 11,
    color: '#94a3b8',
  },
  productoPrecio: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0ea5e9',
  },
});
