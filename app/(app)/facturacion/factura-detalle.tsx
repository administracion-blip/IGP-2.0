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
  Alert,
  Platform,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../contexts/AuthContext';
import { InputFecha } from '../../components/InputFecha';
import { BadgeEstado } from '../../components/BadgeEstado';
import { ResumenTotales } from '../../components/ResumenTotales';
import {
  TIPOS_IVA,
  TIPOS_RETENCION,
  FORMAS_PAGO,
  CONDICIONES_PAGO,
  calcularLinea,
  calcularTotales,
  formatMoneda,
  labelFormaPago,
  type LineaFactura,
  type Factura,
} from '../../utils/facturacion';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalToast, detectToastType } from '../../components/Toast';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

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

type Empresa = {
  id_empresa: string;
  nombre: string;
  cif: string;
  direccion: string;
  cp: string;
  municipio: string;
  provincia: string;
  email: string;
  iban: string;
  ibanAlternativo: string;
  sede: string;
};

type Serie = { serie: string; descripcion: string; tipo: string; num_digitos?: number; ultimo_numero?: number; activa?: boolean };
type Local = { id_local: string; nombre: string };
type Producto = { id_producto: string; referencia: string; nombre: string; precio_venta: number; tipo_iva: number };
type Pago = {
  id_pago: string;
  fecha: string;
  importe: number;
  metodo_pago: string;
  referencia: string;
  observaciones: string;
  creado_por_nombre: string;
  creado_en: string;
};
type AuditEntry = { accion: string; usuario_nombre: string; fecha: string; detalle?: string };

const EMPTY_LINEA: LineaFactura = {
  descripcion: '',
  cantidad: 1,
  precio_unitario: 0,
  descuento_pct: 0,
  tipo_iva: 21,
  retencion_pct: 0,
};

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoToDmy(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const [y, m, d] = iso.substring(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function dmyToIso(dmy: string): string {
  if (!dmy) return '';
  const m = dmy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return dmy;
}

function hoyDmy() {
  return isoToDmy(hoyISO());
}

function calcularFechaVencimiento(fechaEmisionDmy: string, condicion: string): string {
  const iso = dmyToIso(fechaEmisionDmy);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  if (isNaN(base.getTime())) return '';
  let dias = 0;
  if (condicion === '15 días') dias = 15;
  else if (condicion === '30 días') dias = 30;
  else if (condicion === '60 días') dias = 60;
  else if (condicion === '90 días') dias = 90;
  base.setDate(base.getDate() + dias);
  const ry = base.getFullYear();
  const rm = String(base.getMonth() + 1).padStart(2, '0');
  const rd = String(base.getDate()).padStart(2, '0');
  return `${rd}/${rm}/${ry}`;
}

function confirmMsg(titulo: string, msg: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${titulo}\n${msg}`));
  return new Promise((res) =>
    Alert.alert(titulo, msg, [
      { text: 'Cancelar', style: 'cancel', onPress: () => res(false) },
      { text: 'Aceptar', onPress: () => res(true) },
    ]),
  );
}

export default function FacturaDetalleScreen() {
  const params = useLocalSearchParams<{ tipo: string; modo: string; id: string }>();
  const tipo = (params.tipo ?? 'OUT') as 'OUT' | 'IN';
  const modo = (params.modo ?? 'crear') as 'crear' | 'editar';
  const facturaId = params.id ?? '';
  const router = useRouter();
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const isWide = width >= 768;

  const esVenta = tipo === 'OUT';
  const backPath = esVenta ? '/facturacion/facturas-venta' : '/facturacion/facturas-gasto';

  // ── State ──
  const [loading, setLoading] = useState(modo === 'editar');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [estado, setEstado] = useState('borrador');
  const [numeroFactura, setNumeroFactura] = useState('');
  const [serie, setSerie] = useState('');
  const [fechaEmision, setFechaEmision] = useState(hoyDmy());
  const [fechaOperacion, setFechaOperacion] = useState('');
  const [fechaVencimiento, setFechaVencimiento] = useState('');
  const [condicionesPago, setCondicionesPago] = useState('contado');
  const [formaPago, setFormaPago] = useState('transferencia');
  const [observaciones, setObservaciones] = useState('');
  const [localId, setLocalId] = useState('');
  const [numFacturaProveedor, setNumFacturaProveedor] = useState('');
  const [fechaContabilizacion, setFechaContabilizacion] = useState(hoyDmy());

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

  const [lineas, setLineas] = useState<LineaFactura[]>([{ ...EMPTY_LINEA }]);
  const [pagos, setPagos] = useState<Pago[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [version, setVersion] = useState(1);

  // ── Catalogs ──
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [series, setSeries] = useState<Serie[]>([]);
  const [locales, setLocales] = useState<Local[]>([]);
  const [emisorSearch, setEmisorSearch] = useState('');
  const [showEmisorDropdown, setShowEmisorDropdown] = useState(false);
  const [empresaSearch, setEmpresaSearch] = useState('');
  const [showEmpresaDropdown, setShowEmpresaDropdown] = useState(false);

  // ── Product modal ──
  const [showProductModal, setShowProductModal] = useState(false);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [productoSearch, setProductoSearch] = useState('');
  const [loadingProductos, setLoadingProductos] = useState(false);

  // ── Pago modal ──
  const [showPagoModal, setShowPagoModal] = useState(false);
  const [pagoFecha, setPagoFecha] = useState(hoyDmy());
  const [pagoImporte, setPagoImporte] = useState('');
  const [pagoMetodo, setPagoMetodo] = useState('transferencia');
  const [pagoReferencia, setPagoReferencia] = useState('');
  const [pagoObservaciones, setPagoObservaciones] = useState('');
  const [savingPago, setSavingPago] = useState(false);

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

  // ── Toast nativo ──
  const { show: showToast, ToastView } = useLocalToast();
  const alertMsg = useCallback((titulo: string, msg: string) => {
    showToast(titulo, msg, detectToastType(titulo, msg));
  }, [showToast]);

  // ── Computed ──
  const seriesFiltradas = useMemo(() => series.filter((s) => s.tipo === tipo && s.activa !== false), [series, tipo]);

  const [previewNumFactura, setPreviewNumFactura] = useState('');
  useEffect(() => {
    if (!serie || !emisorId || modo === 'editar') { setPreviewNumFactura(''); return; }
    const s = series.find((x) => x.serie === serie);
    if (!s) { setPreviewNumFactura(''); return; }
    const iso = dmyToIso(fechaEmision);
    const year = iso && /^\d{4}/.test(iso) ? iso.substring(0, 4) : String(new Date().getFullYear());
    fetch(`${API_URL}/api/facturacion/series/next-number?serie=${encodeURIComponent(serie)}&emisor_id=${encodeURIComponent(emisorId)}`)
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
  }, [serie, emisorId, fechaEmision, series, modo]);

  const totales = useMemo(() => calcularTotales(lineas), [lineas]);

  const esEditable = estado === 'borrador' || (tipo === 'IN' && estado === 'pendiente_revision');
  const puedeEmitir = estado === 'borrador';
  const puedeRegistrarPago =
    modo === 'editar' &&
    ['emitida', 'parcialmente_cobrada', 'pendiente_pago', 'parcialmente_pagada'].includes(estado);
  const puedeDuplicar = modo === 'editar';
  const puedeRectificar =
    modo === 'editar' &&
    ['emitida', 'parcialmente_cobrada', 'cobrada', 'pendiente_pago', 'parcialmente_pagada', 'pagada'].includes(estado);

  const emisorFiltradas = useMemo(() => {
    let base = empresas;
    if (esVenta) {
      base = base.filter((e) => (e.sede || '').toUpperCase().includes('GRUPO PARIPE'));
    }
    if (!emisorSearch.trim()) return base;
    const q = emisorSearch.toLowerCase();
    return base.filter(
      (e) => (e.nombre || '').toLowerCase().includes(q) || (e.cif || '').toLowerCase().includes(q),
    );
  }, [empresas, emisorSearch, esVenta]);

  const empresasFiltradas = useMemo(() => {
    if (!empresaSearch.trim()) return empresas;
    const q = empresaSearch.toLowerCase();
    return empresas.filter(
      (e) => (e.nombre || '').toLowerCase().includes(q) || (e.cif || '').toLowerCase().includes(q),
    );
  }, [empresas, empresaSearch]);

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
    fetch(`${API_URL}/api/empresas`).then((r) => r.json()).then((d) => {
      const raw: any[] = d.empresas ?? d ?? [];
      setEmpresas(raw.map((e: any) => ({
        id_empresa: e.id_empresa ?? '',
        nombre: e.Nombre ?? e.nombre ?? '',
        cif: e.Cif ?? e.cif ?? '',
        direccion: e.Direccion ?? e.direccion ?? '',
        cp: e.Cp ?? e.cp ?? '',
        municipio: e.Municipio ?? e.municipio ?? '',
        provincia: e.Provincia ?? e.provincia ?? '',
        email: e.Email ?? e.email ?? '',
        iban: e.Iban ?? e.iban ?? '',
        ibanAlternativo: e.IbanAlternativo ?? e.ibanAlternativo ?? '',
        sede: e.Sede ?? e.sede ?? '',
      })));
    }).catch(() => {});
    fetch(`${API_URL}/api/facturacion/series`).then((r) => r.json()).then((d) => setSeries(d.series ?? d ?? [])).catch(() => {});
    fetch(`${API_URL}/api/locales`).then((r) => r.json()).then((d) => setLocales(d.locales ?? d ?? [])).catch(() => {});
  }, []);

  // ── Fetch factura when editing ──
  const fetchFactura = useCallback(async () => {
    if (modo !== 'editar' || !facturaId) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${facturaId}`);
      if (!res.ok) throw new Error('No se pudo cargar la factura');
      const data = await res.json();
      const f: Factura = data.factura ?? data;
      setEstado(f.estado);
      setNumeroFactura(f.numero_factura ?? '');
      setSerie(f.serie);
      setFechaEmision(isoToDmy(f.fecha_emision ?? ''));
      setFechaOperacion(isoToDmy(f.fecha_operacion ?? ''));
      setFechaVencimiento(isoToDmy(f.fecha_vencimiento ?? ''));
      setCondicionesPago(f.condiciones_pago ?? 'contado');
      setFormaPago(f.forma_pago ?? 'transferencia');
      setObservaciones(f.observaciones ?? '');
      setLocalId(f.local_id ?? '');
      setNumFacturaProveedor(f.numero_factura_proveedor ?? '');
      setFechaContabilizacion(isoToDmy(f.fecha_contabilizacion ?? ''));
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

      const ls: LineaFactura[] = data.lineas ?? [];
      setLineas(ls.length > 0 ? ls : [{ ...EMPTY_LINEA }]);
      setPagos(data.pagos ?? []);
      setAuditLog(data.audit_log ?? []);

      fetch(`${API_URL}/api/facturacion/facturas/${facturaId}/adjuntos`)
        .then((r) => r.json())
        .then((d) => setAdjuntos(d.adjuntos ?? []))
        .catch(() => {});
    } catch (e: any) {
      setError(e.message ?? 'Error al cargar');
    } finally {
      setLoading(false);
    }
  }, [modo, facturaId]);

  useEffect(() => { fetchFactura(); }, [fetchFactura]);

  useEffect(() => {
    if (modo === 'editar' && loading) return;
    const nueva = calcularFechaVencimiento(fechaEmision, condicionesPago);
    if (nueva) setFechaVencimiento(nueva);
  }, [condicionesPago, fechaEmision]);

  // ── Emisor select ──
  const selectEmisor = (e: Empresa) => {
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
  const selectEmpresa = (e: Empresa) => {
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

  // ── Lineas helpers ──
  const updateLinea = (idx: number, field: keyof LineaFactura, value: string) => {
    setLineas((prev) => {
      const copy = [...prev];
      const numFields: (keyof LineaFactura)[] = ['cantidad', 'precio_unitario', 'descuento_pct', 'tipo_iva', 'retencion_pct'];
      if (numFields.includes(field)) {
        (copy[idx] as any)[field] = value === '' ? 0 : parseFloat(value) || 0;
      } else {
        (copy[idx] as any)[field] = value;
      }
      return copy;
    });
  };

  const addLinea = () => setLineas((prev) => [...prev, { ...EMPTY_LINEA }]);

  const removeLinea = (idx: number) => {
    setLineas((prev) => {
      if (prev.length <= 1) return [{ ...EMPTY_LINEA }];
      return prev.filter((_, i) => i !== idx);
    });
  };

  // ── Products modal ──
  const openProductModal = async () => {
    setShowProductModal(true);
    setProductoSearch('');
    if (productos.length === 0) {
      setLoadingProductos(true);
      try {
        const res = await fetch(`${API_URL}/api/productos`);
        const data = await res.json();
        setProductos(data.productos ?? data ?? []);
      } catch { /* ignore */ }
      setLoadingProductos(false);
    }
  };

  const selectProducto = (p: Producto) => {
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
    fecha_emision: dmyToIso(fechaEmision),
    fecha_operacion: fechaOperacion ? dmyToIso(fechaOperacion) : null,
    fecha_vencimiento: dmyToIso(fechaVencimiento),
    condiciones_pago: condicionesPago,
    forma_pago: formaPago,
    observaciones,
    local_id: localId || null,
    numero_factura_proveedor: tipo === 'IN' ? numFacturaProveedor : null,
    fecha_contabilizacion: tipo === 'IN' ? dmyToIso(fechaContabilizacion) || null : null,
    lineas: lineas.map((l) => ({ ...l, ...calcularLinea(l) })),
    ...totales,
    usuario_id: user?.id_usuario,
    usuario_nombre: user?.Nombre,
    version,
  });

  // ── Save (borrador) ──
  const guardarBorrador = async () => {
    if (!emisorNombre) { alertMsg('Error', 'Selecciona un emisor'); return; }
    if (!empresaId) { alertMsg('Error', 'Selecciona un receptor'); return; }
    if (!serie) {
      if (seriesFiltradas.length === 0) alertMsg('Sin series', 'No hay series configuradas para este tipo de factura. Ve a Facturación > Series para crearlas.');
      else alertMsg('Error', 'Selecciona una serie');
      return;
    }
    if (!fechaEmision) { alertMsg('Error', 'Indica la fecha de emisión'); return; }
    setSaving(true);
    setError('');
    try {
      const url = modo === 'crear'
        ? `${API_URL}/api/facturacion/facturas`
        : `${API_URL}/api/facturacion/facturas/${facturaId}`;
      const method = modo === 'crear' ? 'POST' : 'PUT';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al guardar');
      alertMsg('Guardado', 'Factura guardada correctamente');
      const newId = data.factura?.id_entrada || data.id_factura;
      if (modo === 'crear' && newId) {
        router.replace({
          pathname: '/facturacion/factura-detalle',
          params: { tipo, modo: 'editar', id: newId },
        } as any);
      } else {
        fetchFactura();
      }
    } catch (e: any) {
      setError(e.message);
      alertMsg('Error', e.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Emitir ──
  const emitirFactura = async () => {
    const ok = await confirmMsg('Emitir factura', '¿Seguro que deseas emitir esta factura? No podrá editarse después.');
    if (!ok) return;
    setSaving(true);
    setError('');
    try {
      if (modo === 'crear') {
        if (!emisorNombre || !empresaId || !serie || !fechaEmision) { alertMsg('Error', 'Completa los campos obligatorios (emisor, receptor, serie, fecha)'); setSaving(false); return; }
        const createRes = await fetch(`${API_URL}/api/facturacion/facturas`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPayload()),
        });
        const createData = await createRes.json();
        if (!createRes.ok) throw new Error(createData.error ?? 'Error al crear');
        const newId = createData.id_factura;
        const emitRes = await fetch(`${API_URL}/api/facturacion/facturas/${newId}/emitir`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usuario_id: user?.id_usuario, usuario_nombre: user?.Nombre }),
        });
        if (!emitRes.ok) {
          const d = await emitRes.json();
          const msg = d.errores ? `Validación:\n• ${d.errores.join('\n• ')}` : (d.error ?? 'Error al emitir');
          throw new Error(msg);
        }
        alertMsg('Emitida', 'Factura emitida correctamente');
        router.replace({
          pathname: '/facturacion/factura-detalle',
          params: { tipo, modo: 'editar', id: newId },
        } as any);
      } else {
        await fetch(`${API_URL}/api/facturacion/facturas/${facturaId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPayload()),
        });
        const res = await fetch(`${API_URL}/api/facturacion/facturas/${facturaId}/emitir`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usuario_id: user?.id_usuario, usuario_nombre: user?.Nombre }),
        });
        if (!res.ok) {
          const d = await res.json();
          const msg = d.errores ? `Validación:\n• ${d.errores.join('\n• ')}` : (d.error ?? 'Error al emitir');
          throw new Error(msg);
        }
        alertMsg('Emitida', 'Factura emitida correctamente');
        fetchFactura();
      }
    } catch (e: any) {
      setError(e.message);
      alertMsg('Error', e.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Duplicar ──
  const duplicarFactura = async () => {
    const ok = await confirmMsg('Duplicar', '¿Crear una copia borrador de esta factura?');
    if (!ok) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${facturaId}/duplicar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario_id: user?.id_usuario, usuario_nombre: user?.Nombre }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al duplicar');
      alertMsg('Duplicada', 'Se ha creado la copia');
      router.replace({
        pathname: '/facturacion/factura-detalle',
        params: { tipo, modo: 'editar', id: data.id_factura },
      } as any);
    } catch (e: any) {
      alertMsg('Error', e.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Rectificar ──
  const rectificarFactura = async () => {
    const ok = await confirmMsg('Rectificativa', '¿Generar una factura rectificativa?');
    if (!ok) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${facturaId}/rectificar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario_id: user?.id_usuario, usuario_nombre: user?.Nombre }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al rectificar');
      alertMsg('Rectificativa creada', 'Se ha generado la factura rectificativa');
      router.replace({
        pathname: '/facturacion/factura-detalle',
        params: { tipo, modo: 'editar', id: data.id_factura },
      } as any);
    } catch (e: any) {
      alertMsg('Error', e.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Registrar pago ──
  const registrarPago = async () => {
    const importe = parseFloat(pagoImporte);
    if (!pagoFecha || isNaN(importe) || importe <= 0) {
      alertMsg('Error', 'Indica fecha e importe válidos');
      return;
    }
    setSavingPago(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${facturaId}/pagos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fecha: dmyToIso(pagoFecha),
          importe,
          metodo_pago: pagoMetodo,
          referencia: pagoReferencia,
          observaciones: pagoObservaciones,
          usuario_id: user?.id_usuario,
          usuario_nombre: user?.Nombre,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error al registrar pago');
      alertMsg('Registrado', 'Pago registrado correctamente');
      setShowPagoModal(false);
      setPagoImporte('');
      setPagoReferencia('');
      setPagoObservaciones('');
      fetchFactura();
    } catch (e: any) {
      alertMsg('Error', e.message);
    } finally {
      setSavingPago(false);
    }
  };

  // ── PDF helpers ──
  const buildPdfParams = () => {
    const emisorData = {
      nombre: emisorNombre, cif: emisorCif, direccion: emisorDireccion,
      cp: emisorCp, municipio: emisorMunicipio, provincia: emisorProvincia,
      email: emisorEmail, telefono: DATOS_EMISOR.telefono,
    };
    const clienteData = {
      nombre: empresaNombre, cif: empresaCif, direccion: empresaDireccion,
      cp: empresaCp, municipio: empresaMunicipio, provincia: empresaProvincia,
      email: empresaEmail,
    };
    const numFactura = modo === 'editar' && numeroFactura ? numeroFactura : previewNumFactura || '';
    const facturaData = {
      id_factura: numFactura || facturaId,
      tipo, serie, numero: 0, estado,
      fecha_emision: dmyToIso(fechaEmision) || fechaEmision,
      fecha_operacion: fechaOperacion ? dmyToIso(fechaOperacion) || fechaOperacion : undefined,
      fecha_vencimiento: fechaVencimiento ? dmyToIso(fechaVencimiento) || fechaVencimiento : undefined,
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
      descargarPDFFactura(emisorData, clienteData, facturaData, lineas);
    } catch (e: any) {
      alertMsg('Error PDF', e.message ?? 'No se pudo generar el PDF');
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
      const doc = generarPDFFactura(emisorData, clienteData, facturaData, lineas);
      const blobUrl = doc.output('bloburl');
      window.open(blobUrl as string, '_blank');
    } catch (e: any) {
      alertMsg('Error PDF', e.message ?? 'No se pudo generar la previsualización');
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
        const res = await fetch(`${API_URL}/api/facturacion/facturas/${facturaId}/adjuntos`, {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Error al subir');
        const adjRes = await fetch(`${API_URL}/api/facturacion/facturas/${facturaId}/adjuntos`);
        const adjData = await adjRes.json();
        setAdjuntos(adjData.adjuntos ?? []);
        fetchFactura();
      } catch (e: any) {
        alertMsg('Error', e.message);
      } finally {
        setSubiendoAdjunto(false);
      }
    };
    input.click();
  };

  const eliminarAdjunto = async (adjId: string) => {
    const ok = await confirmMsg('Eliminar adjunto', '¿Seguro que deseas eliminar este adjunto?');
    if (!ok) return;
    try {
      await fetch(`${API_URL}/api/facturacion/facturas/${facturaId}/adjuntos/${adjId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario_id: user?.id_usuario, usuario_nombre: user?.Nombre }),
      });
      setAdjuntos((prev) => prev.filter((a) => a.id !== adjId));
    } catch (e: any) {
      alertMsg('Error', e.message);
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
        };
        const doc = generarPDFFactura(
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
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${facturaId}/enviar-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    } catch (e: any) {
      alertMsg('Error', e.message);
    } finally {
      setSendingEmail(false);
    }
  };

  // ── Title ──
  const titulo = modo === 'crear'
    ? esVenta ? 'Nueva factura de venta' : 'Nueva factura de gasto'
    : `Factura ${facturaId}`;

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
        </View>
      </View>

      {/* ── ACTION BUTTONS ── */}
      <View style={styles.actionsRow}>
        {esEditable && (
          <TouchableOpacity style={styles.btnPrimary} onPress={guardarBorrador} disabled={saving}>
            {saving ? <ActivityIndicator size="small" color="#fff" /> : (
              <>
                <MaterialIcons name="save" size={16} color="#fff" />
                <Text style={styles.btnPrimaryText}>Guardar borrador</Text>
              </>
            )}
          </TouchableOpacity>
        )}
        {puedeEmitir && (
          <TouchableOpacity style={styles.btnSuccess} onPress={emitirFactura} disabled={saving}>
            <MaterialIcons name="send" size={16} color="#fff" />
            <Text style={styles.btnSuccessText}>Emitir</Text>
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

      {/* ── EMISOR + RECEPTOR ── */}
      <View style={[styles.empresaRow, !isWide && { flexDirection: 'column' }]}>
        {/* EMISOR */}
        <View style={[styles.section, { flex: 1, zIndex: 110, overflow: 'visible' } as any]}>
          <Text style={styles.sectionTitle}>Emisor *</Text>
          <View style={styles.empresaSelector}>
            <TextInput
              style={styles.input}
              placeholder="Buscar emisor por nombre o CIF…"
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

        {/* RECEPTOR */}
        <View style={[styles.section, { flex: 1, zIndex: 100, overflow: 'visible' } as any]}>
          <Text style={styles.sectionTitle}>Receptor *</Text>
          <View style={styles.empresaSelector}>
            <TextInput
              style={styles.input}
              placeholder="Buscar receptor por nombre o CIF…"
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
            {modo === 'editar' && numeroFactura ? (
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

          {/* Fecha emisión */}
          <View style={styles.field}>
            <Text style={styles.label}>Fecha emisión *</Text>
            <InputFecha value={fechaEmision} onChange={setFechaEmision} format="dmy" editable={esEditable} />
          </View>

          {/* Fecha operación */}
          <View style={styles.field}>
            <Text style={styles.label}>Fecha operación</Text>
            <InputFecha value={fechaOperacion} onChange={setFechaOperacion} format="dmy" placeholder="Opcional" editable={esEditable} />
          </View>

          {/* Fecha vencimiento */}
          <View style={styles.field}>
            <Text style={styles.label}>Fecha vencimiento</Text>
            <InputFecha value={fechaVencimiento} onChange={setFechaVencimiento} format="dmy" editable={esEditable} />
          </View>

          {/* Condiciones pago */}
          <View style={styles.field}>
            <Text style={styles.label}>Condiciones de pago</Text>
            <View style={styles.pickerWrap}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {CONDICIONES_PAGO.map((c) => (
                  <TouchableOpacity
                    key={c}
                    style={[styles.chip, condicionesPago === c && styles.chipActive]}
                    onPress={() => esEditable && setCondicionesPago(c)}
                    disabled={!esEditable}
                  >
                    <Text style={[styles.chipText, condicionesPago === c && styles.chipTextActive]}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </View>

          {/* Forma pago */}
          <View style={styles.field}>
            <Text style={styles.label}>Forma de pago</Text>
            <View style={styles.pickerWrap}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {FORMAS_PAGO.map((fp) => (
                  <TouchableOpacity
                    key={fp}
                    style={[styles.chip, formaPago === fp && styles.chipActive]}
                    onPress={() => esEditable && setFormaPago(fp)}
                    disabled={!esEditable}
                  >
                    <Text style={[styles.chipText, formaPago === fp && styles.chipTextActive]}>
                      {labelFormaPago(fp)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
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
                <InputFecha value={fechaContabilizacion} onChange={setFechaContabilizacion} format="dmy" editable={esEditable} />
              </View>
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
              <TextInput
                style={[styles.lineaInput, { flex: 1 }]}
                value={String(linea.cantidad)}
                onChangeText={(v) => updateLinea(idx, 'cantidad', v)}
                keyboardType="decimal-pad"
                editable={esEditable}
              />
              <TextInput
                style={[styles.lineaInput, { flex: 1 }]}
                value={String(linea.precio_unitario)}
                onChangeText={(v) => updateLinea(idx, 'precio_unitario', v)}
                keyboardType="decimal-pad"
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
                  <TextInput style={styles.inputSmall} value={String(linea.cantidad)} onChangeText={(v) => updateLinea(idx, 'cantidad', v)} keyboardType="decimal-pad" editable={esEditable} />
                </View>
                <View style={styles.lineaCardField}>
                  <Text style={styles.labelSmall}>Precio</Text>
                  <TextInput style={styles.inputSmall} value={String(linea.precio_unitario)} onChangeText={(v) => updateLinea(idx, 'precio_unitario', v)} keyboardType="decimal-pad" editable={esEditable} />
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
          />
        </View>
      </View>

      {/* ── PAGOS ── */}
      {puedeRegistrarPago && (
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>
              {esVenta ? 'Cobros' : 'Pagos'}
            </Text>
            <TouchableOpacity style={styles.btnSmall} onPress={() => { setPagoFecha(hoyISO()); setShowPagoModal(true); }}>
              <MaterialIcons name="add" size={16} color="#0ea5e9" />
              <Text style={styles.btnSmallText}>Registrar {esVenta ? 'cobro' : 'pago'}</Text>
            </TouchableOpacity>
          </View>

          {pagos.length === 0 ? (
            <Text style={styles.emptyText}>No hay {esVenta ? 'cobros' : 'pagos'} registrados</Text>
          ) : (
            pagos.map((p) => (
              <View key={p.id_pago} style={styles.pagoRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.pagoFecha}>{isoToDmy(p.fecha) || p.fecha}</Text>
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
                    onPress={() => { if (Platform.OS === 'web') window.open(adj.url, '_blank'); }}
                    style={{ padding: 4 }}
                  >
                    <MaterialIcons name="open-in-new" size={16} color="#0ea5e9" />
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
                <Text style={styles.auditMeta}>{entry.usuario_nombre} · {entry.fecha}</Text>
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

      {/* ── MODAL PAGO ── */}
      <Modal visible={showPagoModal} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => setShowPagoModal(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Registrar {esVenta ? 'cobro' : 'pago'}</Text>
              <TouchableOpacity onPress={() => setShowPagoModal(false)}>
                <MaterialIcons name="close" size={22} color="#334155" />
              </TouchableOpacity>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Fecha</Text>
              <InputFecha value={pagoFecha} onChange={setPagoFecha} format="dmy" />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Importe (€)</Text>
              <TextInput
                style={styles.input}
                value={pagoImporte}
                onChangeText={setPagoImporte}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor="#94a3b8"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Método de pago</Text>
              <View style={styles.pickerWrap}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {FORMAS_PAGO.map((fp) => (
                    <TouchableOpacity
                      key={fp}
                      style={[styles.chip, pagoMetodo === fp && styles.chipActive]}
                      onPress={() => setPagoMetodo(fp)}
                    >
                      <Text style={[styles.chipText, pagoMetodo === fp && styles.chipTextActive]}>
                        {labelFormaPago(fp)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Referencia</Text>
              <TextInput
                style={styles.input}
                value={pagoReferencia}
                onChangeText={setPagoReferencia}
                placeholder="Nº transferencia, cheque…"
                placeholderTextColor="#94a3b8"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Observaciones</Text>
              <TextInput
                style={[styles.input, styles.inputMultiline]}
                value={pagoObservaciones}
                onChangeText={setPagoObservaciones}
                placeholder="Notas opcionales…"
                placeholderTextColor="#94a3b8"
                multiline
                numberOfLines={2}
              />
            </View>

            <TouchableOpacity style={[styles.btnPrimary, { marginTop: 8 }]} onPress={registrarPago} disabled={savingPago}>
              {savingPago ? <ActivityIndicator size="small" color="#fff" /> : (
                <Text style={styles.btnPrimaryText}>Guardar {esVenta ? 'cobro' : 'pago'}</Text>
              )}
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

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
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#334155',
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
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
    marginBottom: 4,
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
