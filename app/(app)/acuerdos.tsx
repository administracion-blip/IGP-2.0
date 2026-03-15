import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Modal,
  Pressable,
  ActivityIndicator,
  useWindowDimensions,
  Platform,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialIcons } from '@expo/vector-icons';
import { useProductosCache } from '../contexts/ProductosCache';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

type DetalleProducto = { PK: string; SK: string; ProductId: string; ProductName: string; Cantidad: number; Aportacion: number; Rappel: number; DescuentoExtra: number; Compradas: number; Restante: number; Porcentaje: number; createdAt?: string };

type PagoImagen = {
  PK: string;
  SK: string;
  Locales: string[];
  Acciones: string[];
  Importe: number;
  Justificantes: { name: string; data: string }[];
  Descripcion: string;
  Realizado: boolean;
  createdAt?: string;
  updatedAt?: string;
};

const ACCIONES_IMAGEN = ['Inversión', 'Prescripción', 'Visibilidad', 'Cocktail/Carta', 'RRSS', 'Activaciones'];

/** Polyfill: Alert.alert no funciona en web; usa modal de confirmación */
function useConfirmDelete() {
  const [visible, setVisible] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const onConfirmRef = useRef<(() => void) | null>(null);

  const confirmDelete = useCallback((t: string, m: string, onConfirm: () => void) => {
    if (Platform.OS === 'web') {
      setTitle(t);
      setMessage(m);
      onConfirmRef.current = onConfirm;
      setVisible(true);
    } else {
      Alert.alert(t, m, [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Eliminar', style: 'destructive', onPress: onConfirm },
      ]);
    }
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirmRef.current?.();
    setVisible(false);
    onConfirmRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    setVisible(false);
    onConfirmRef.current = null;
  }, []);

  const ModalConfirm = useCallback(() => (
    <Modal visible={visible} transparent animationType="fade">
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 24 }} onPress={handleCancel}>
        <Pressable style={{ backgroundColor: "#fff", borderRadius: 12, padding: 24, maxWidth: 400, width: "100%" }} onPress={(e) => e.stopPropagation()}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#1e293b', marginBottom: 8 }}>{title}</Text>
          <Text style={{ fontSize: 15, color: '#64748b', marginBottom: 24 }}>{message}</Text>
          <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end' }}>
            <TouchableOpacity onPress={handleCancel} style={{ paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#e2e8f0', borderRadius: 8 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: '#475569' }}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleConfirm} style={{ paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#ef4444', borderRadius: 8 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: '#fff' }}>Eliminar</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  ), [visible, title, message, handleConfirm, handleCancel]);

  return { confirmDelete, ModalConfirm };
}

/** Botón de eliminación para web: usa listener DOM nativo en fase de captura para evitar que ScrollView intercepte el evento */
function WebDeleteBtn({
  productId,
  productName,
  onDelete,
  onConfirmDelete,
}: {
  productId: string;
  productName: string;
  onDelete: (id: string) => void;
  onConfirmDelete: (title: string, message: string, onConfirm: () => void) => void;
}) {
  const ref = useRef<any>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const node = (el as any)._nativeTag ?? el;
    const handler = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      const msg = `¿Quieres eliminar el producto "${productName}" del acuerdo?`;
      onConfirmDelete('Confirmar eliminación', msg, () => onDelete(productId));
    };
    node.addEventListener('click', handler, true);
    return () => node.removeEventListener('click', handler, true);
  }, [productId, productName, onDelete, onConfirmDelete]);

  return (
    <View
      ref={ref}
      role="button"
      // @ts-ignore
      tabIndex={0}
      style={{ width: 80, minWidth: 80, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, padding: 4, cursor: 'pointer' } as any}
    >
      <MaterialIcons name="close" size={14} color="#ef4444" />
      <Text style={{ fontSize: 11, color: '#ef4444', fontWeight: '500' }}>Eliminar</Text>
    </View>
  );
}

function TooltipBtn({ tooltip, children, ...props }: { tooltip: string; children: React.ReactNode; style?: any; onPress?: () => void; disabled?: boolean }) {
  const [hover, setHover] = useState(false);
  const webProps = Platform.OS === 'web' ? { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } : {};
  return (
    <View style={{ position: 'relative' }} {...webProps}>
      <TouchableOpacity {...props}>{children}</TouchableOpacity>
      {hover && (
        <View style={tooltipStyles.bubble}>
          <Text style={tooltipStyles.text}>{tooltip}</Text>
        </View>
      )}
    </View>
  );
}

function DonutChart({ porcentaje, compradas, acordado, size = 120 }: { porcentaje: number; compradas: number; acordado: number; size?: number }) {
  const isMini = size <= 64;
  const strokeWidth = isMini ? 5 : 12;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const pctVisual = Math.min(Math.max(porcentaje, 0), 100);
  const pctText = Math.max(0, porcentaje);
  const offset = circumference - (pctVisual / 100) * circumference;
  const color = porcentaje >= 80 ? '#22c55e' : '#ef4444';
  const center = size / 2;

  if (Platform.OS !== 'web') {
    return (
      <View style={donutStyles.fallback}>
        <Text style={[donutStyles.fallbackPct, { color, fontSize: isMini ? 11 : 24 }]}>{pctText.toFixed(isMini ? 0 : 1)}%</Text>
        {!isMini && <Text style={donutStyles.fallbackSub}>{compradas.toLocaleString('es-ES')} / {acordado.toLocaleString('es-ES')}</Text>}
      </View>
    );
  }

  return (
    <View style={[donutStyles.wrap, isMini && { paddingVertical: 0 }]}>
      <View style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={center} cy={center} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={strokeWidth} />
          <circle
            cx={center} cy={center} r={radius} fill="none"
            stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={offset}
            transform={`rotate(-90 ${center} ${center})`}
          />
        </svg>
        <View style={[donutStyles.textWrap, { width: size, height: size }]}>
          <Text style={[donutStyles.pctText, { color, fontSize: isMini ? 11 : 20 }]}>{pctText.toFixed(isMini ? 0 : 1)}%</Text>
          {!isMini && <Text style={donutStyles.subText}>{compradas.toLocaleString('es-ES')} / {acordado.toLocaleString('es-ES')}</Text>}
        </View>
      </View>
    </View>
  );
}

const donutStyles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingVertical: 12 },
  textWrap: { position: 'absolute', top: 0, left: 0, justifyContent: 'center', alignItems: 'center' },
  pctText: { fontSize: 20, fontWeight: '800' },
  subText: { fontSize: 10, color: '#64748b', marginTop: 2 },
  fallback: { alignItems: 'center', paddingVertical: 12 },
  fallbackPct: { fontSize: 24, fontWeight: '800' },
  fallbackSub: { fontSize: 11, color: '#64748b', marginTop: 2 },
});

const tooltipStyles = StyleSheet.create({
  bubble: { position: 'absolute', top: '100%', left: '50%', transform: [{ translateX: -40 }], marginTop: 4, backgroundColor: '#1e293b', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, zIndex: 9999, elevation: 9999, minWidth: 80, alignItems: 'center' },
  text: { fontSize: 11, color: '#f8fafc', fontWeight: '500', whiteSpace: 'nowrap' as any },
});

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';
const ACUERDOS_LAST_SELECTED_KEY = 'acuerdos-last-selected-pk';

type Acuerdo = {
  PK: string;
  Nombre: string;
  Marca: string;
  FechaInicio: string;
  FechaFin: string;
  Contacto: string;
  Telefono: string;
  Email: string;
  Notas: string;
  Estado: string;
  createdAt: string;
  updatedAt: string;
};

const ESTADOS = ['Activo', 'Completado', 'Cancelado', 'Vencido'];

const EMPTY_FORM = {
  Nombre: '',
  Marca: '',
  FechaInicio: '',
  FechaFin: '',
  Contacto: '',
  Telefono: '',
  Email: '',
  Notas: '',
  Estado: 'Activo',
};

function formatFecha(iso: string): string {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatMoneda(n: number | null | undefined): string {
  if (n == null) return '0,00 €';
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function calcTiempoRestante(fechaFin: string): { texto: string; vencido: boolean } {
  if (!fechaFin) return { texto: 'Sin fecha fin', vencido: false };
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const fin = new Date(fechaFin + 'T00:00:00');
  if (isNaN(fin.getTime())) return { texto: 'Fecha inválida', vencido: false };

  const diff = fin.getTime() - hoy.getTime();
  const absDiff = Math.abs(diff);
  const vencido = diff < 0;

  const desde = vencido ? fin : hoy;
  const hasta = vencido ? hoy : fin;
  let meses = (hasta.getFullYear() - desde.getFullYear()) * 12 + (hasta.getMonth() - desde.getMonth());
  let dias = hasta.getDate() - desde.getDate();
  if (dias < 0) {
    meses -= 1;
    const mesAnterior = new Date(hasta.getFullYear(), hasta.getMonth(), 0);
    dias += mesAnterior.getDate();
  }

  let texto = '';
  if (meses > 0 && dias > 0) texto = `${meses} ${meses === 1 ? 'mes' : 'meses'} y ${dias} ${dias === 1 ? 'día' : 'días'}`;
  else if (meses > 0) texto = `${meses} ${meses === 1 ? 'mes' : 'meses'}`;
  else if (dias > 0) texto = `${dias} ${dias === 1 ? 'día' : 'días'}`;
  else return { texto: 'Finaliza hoy', vencido: false };

  return { texto: vencido ? `Vencido hace ${texto}` : `Quedan ${texto}`, vencido };
}

function valorEnLocal(obj: Record<string, unknown>, key: string): unknown {
  return obj[key] ?? obj[key.toLowerCase()] ?? obj[key.charAt(0).toUpperCase() + key.slice(1)];
}

export default function AcuerdosScreen() {
  const router = useRouter();
  const { width: winWidth } = useWindowDimensions();
  const { productosIgp, loading: loadingProductos, recargar: recargarProductos, lastFetch: productosLastFetch } = useProductosCache();
  const { confirmDelete, ModalConfirm } = useConfirmDelete();

  const [acuerdos, setAcuerdos] = useState<Acuerdo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [modalVisible, setModalVisible] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [guardando, setGuardando] = useState(false);

  const [seleccionado, setSeleccionado] = useState<Acuerdo | null>(null);
  const [detallesPorAcuerdo, setDetallesPorAcuerdo] = useState<Record<string, DetalleProducto[]>>({});
  const detalles = seleccionado ? (detallesPorAcuerdo[seleccionado.PK] ?? []) : [];
  const [loadingDetalles, setLoadingDetalles] = useState(false);
  const [prodDropdownOpen, setProdDropdownOpen] = useState(false);
  const [prodSearch, setProdSearch] = useState('');
  const [prodFocusedIndex, setProdFocusedIndex] = useState(0);
  const prodListScrollRef = useRef<ScrollView>(null);

  const [empresas, setEmpresas] = useState<Record<string, unknown>[]>([]);
  const [loadingEmpresas, setLoadingEmpresas] = useState(false);
  const [marcaDropdownOpen, setMarcaDropdownOpen] = useState(false);
  const [marcaSearch, setMarcaSearch] = useState('');

  const [pagosImagen, setPagosImagen] = useState<PagoImagen[]>([]);
  const [loadingPagos, setLoadingPagos] = useState(false);
  const [imgModalVisible, setImgModalVisible] = useState(false);
  const [imgEditSK, setImgEditSK] = useState<string | null>(null);
  const [imgForm, setImgForm] = useState({ Locales: [] as string[], Acciones: [] as string[], Importe: '', Descripcion: '' });
  const [imgFiles, setImgFiles] = useState<{ name: string; data: string }[]>([]);
  const [guardandoImg, setGuardandoImg] = useState(false);

  const [locales, setLocales] = useState<{ id: string; nombre: string }[]>([]);
  const [localesLoaded, setLocalesLoaded] = useState(false);
  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);
  const [localSearch, setLocalSearch] = useState('');
  const [accionDropdownOpen, setAccionDropdownOpen] = useState(false);
  const [productoTooltip, setProductoTooltip] = useState<{ id: string; name: string } | null>(null);
  const productoTooltipOpenedAt = useRef<number>(0);
  const cargarDetallesAcuerdoRef = useRef<string | null>(null);
  const cargarDetallesRequestIdRef = useRef<number>(0);
  const seleccionadoRef = useRef<string | null>(null);
  useEffect(() => { seleccionadoRef.current = seleccionado?.PK ?? null; }, [seleccionado]);

  // Sincronizar totales y edits cuando cambia el acuerdo seleccionado o su caché
  useEffect(() => {
    if (!seleccionado) return;
    const d = detallesPorAcuerdo[seleccionado.PK] || [];
    if (d.length === 0) {
      setTotalAcordado(0);
      setTotalCompradas(0);
      setTotalRestante(0);
      setCantidadEdits({});
      setAportacionEdits({});
      setRappelEdits({});
      setDescuentoEdits({});
      return;
    }
    const acordado = d.reduce((s, x) => s + (x.Cantidad || 0), 0);
    const compradas = d.reduce((s, x) => s + (x.Compradas || 0), 0);
    setTotalAcordado(acordado);
    setTotalCompradas(compradas);
    setTotalRestante(acordado - compradas);
    const edits: Record<string, string> = {};
    const apEdits: Record<string, string> = {};
    const raEdits: Record<string, string> = {};
    const deEdits: Record<string, string> = {};
    d.forEach((item: DetalleProducto) => {
      edits[item.ProductId] = String(item.Cantidad || 0);
      apEdits[item.ProductId] = String(item.Aportacion || 0);
      raEdits[item.ProductId] = String(item.Rappel || 0);
      deEdits[item.ProductId] = String(item.DescuentoExtra || 0);
    });
    setCantidadEdits(edits);
    setAportacionEdits(apEdits);
    setRappelEdits(raEdits);
    setDescuentoEdits(deEdits);
  }, [seleccionado?.PK, detallesPorAcuerdo]);

  useEffect(() => {
    if (seleccionado?.PK) AsyncStorage.setItem(ACUERDOS_LAST_SELECTED_KEY, seleccionado.PK);
    else AsyncStorage.removeItem(ACUERDOS_LAST_SELECTED_KEY);
  }, [seleccionado?.PK]);

  type ArchivoMeta = { fileKey: string; fileName: string; contentType: string; size: number; uploadedAt: string; url?: string };
  const [archivos, setArchivos] = useState<ArchivoMeta[]>([]);
  const [loadingArchivos, setLoadingArchivos] = useState(false);
  const [subiendoArchivo, setSubiendoArchivo] = useState(false);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/acuerdos`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      const items: Acuerdo[] = data.items || [];
      const hoy = new Date().toISOString().slice(0, 10);
      const vencidos: Promise<void>[] = [];
      for (const a of items) {
        if (a.Estado === 'Activo' && a.FechaFin && a.FechaFin < hoy) {
          a.Estado = 'Vencido';
          vencidos.push(
            fetch(`${API_URL}/api/acuerdos/${a.PK}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ Estado: 'Vencido' }),
            }).then(() => {}).catch(() => {})
          );
        }
      }
      if (vencidos.length > 0) await Promise.all(vencidos);
      setAcuerdos(items);
      setSeleccionado((prev) => {
        if (!prev) return null;
        const fresh = items.find((a) => a.PK === prev.PK);
        return fresh || null;
      });
      return items;
    } catch (err: any) {
      setError(err.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const cargarEmpresas = useCallback(async () => {
    if (empresas.length > 0) return;
    setLoadingEmpresas(true);
    try {
      const res = await fetch(`${API_URL}/api/empresas`);
      const data = await res.json();
      const list = data.empresas || [];
      list.sort((a: any, b: any) => (a.Alias || a.Nombre || '').localeCompare(b.Alias || b.Nombre || ''));
      setEmpresas(list);
    } catch (_) { /* silencioso */ }
    finally { setLoadingEmpresas(false); }
  }, [empresas.length]);

  const [totalesPorAcuerdo, setTotalesPorAcuerdo] = useState<Record<string, { totalAcordado: number; totalCompradas: number; porcentaje: number }>>({});

  const cargarTotales = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/acuerdos/totales`);
      const data = await res.json();
      if (res.ok && data.totales) setTotalesPorAcuerdo(data.totales);
    } catch (_) {}
  }, []);

  const [formPK, setFormPK] = useState('');

  const abrirCrear = () => {
    setEditId(null);
    setFormPK(crypto.randomUUID());
    setForm(EMPTY_FORM);
    setModalVisible(true);
    cargarEmpresas();
  };

  const abrirEditar = (a: Acuerdo) => {
    setEditId(a.PK);
    setFormPK(a.PK);
    setForm({
      Nombre: a.Nombre || '',
      Marca: a.Marca || '',
      FechaInicio: a.FechaInicio || '',
      FechaFin: a.FechaFin || '',
      Contacto: a.Contacto || '',
      Telefono: a.Telefono || '',
      Email: a.Email || '',
      Notas: a.Notas || '',
      Estado: a.Estado || 'Activo',
    });
    setModalVisible(true);
    cargarEmpresas();
  };

  const guardar = async () => {
    if (!formPK.trim()) return;
    if (form.FechaInicio && form.FechaFin && form.FechaInicio > form.FechaFin) {
      setError('La fecha de inicio no puede ser mayor que la fecha final');
      return;
    }
    setGuardando(true);
    setError('');
    try {
      const payload: Record<string, string> = {
        Nombre: form.Nombre,
        Marca: form.Marca,
        FechaInicio: form.FechaInicio,
        FechaFin: form.FechaFin,
        Contacto: form.Contacto,
        Telefono: form.Telefono,
        Email: form.Email,
        Notas: form.Notas,
        Estado: form.Estado,
      };
      if (!editId) payload.PK = formPK;
      const url = editId ? `${API_URL}/api/acuerdos/${editId}` : `${API_URL}/api/acuerdos`;
      const method = editId ? 'PATCH' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      setModalVisible(false);
      const creado = !editId ? (data.item as Acuerdo) : null;
      const items = await cargar();
      cargarTotales();
      if (creado) {
        const a = items.find((x) => x.PK === creado.PK) || creado;
        setSeleccionado(a);
        cargarDetalles(a.PK, { showLoading: true });
        cargarPagosImagen(a.PK);
        cargarArchivos(a.PK);
        cargarLocales();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setGuardando(false);
    }
  };

  const eliminar = async (id: string) => {
    try {
      await fetch(`${API_URL}/api/acuerdos/${id}`, { method: 'DELETE' });
      await cargar();
      cargarTotales();
    } catch (err: any) {
      setError(err.message);
    }
  };


  const acuerdosOrdenados = useMemo(() => {
    return [...acuerdos].sort((a, b) => {
      const aActivo = a.Estado === 'Activo' ? 0 : 1;
      const bActivo = b.Estado === 'Activo' ? 0 : 1;
      if (aActivo !== bActivo) return aActivo - bActivo;
      return (a.FechaFin || '').localeCompare(b.FechaFin || '');
    });
  }, [acuerdos]);

  const empresasFiltradas = useMemo(() => {
    const q = marcaSearch.trim().toLowerCase();
    if (!q) return empresas.slice(0, 60);
    return empresas.filter((e) => {
      const alias = String(e.Alias || '').toLowerCase();
      const nombre = String(e.Nombre || '').toLowerCase();
      return alias.includes(q) || nombre.includes(q);
    }).slice(0, 60);
  }, [empresas, marcaSearch]);

  const [totalAcordado, setTotalAcordado] = useState(0);
  const [totalCompradas, setTotalCompradas] = useState(0);
  const [totalRestante, setTotalRestante] = useState(0);

  const cargarDetalles = useCallback(async (acuerdoPK: string, options?: { showLoading?: boolean }) => {
    const requestId = ++cargarDetallesRequestIdRef.current;
    cargarDetallesAcuerdoRef.current = acuerdoPK;
    const showLoading = options?.showLoading !== false;
    if (showLoading) setLoadingDetalles(true);
    try {
      const res = await fetch(`${API_URL}/api/acuerdos/${acuerdoPK}/detalles-con-compras`);
      const data = await res.json();
      if (cargarDetallesRequestIdRef.current !== requestId) return;
      if (res.ok) {
        const items = Array.isArray(data.items) ? data.items : [];
        setDetallesPorAcuerdo((prev) => {
          const existing = prev[acuerdoPK] || [];
          if (items.length === 0 && existing.length > 0) return prev;
          return { ...prev, [acuerdoPK]: items };
        });
        const ta = data.totalAcordado || 0;
        const tc = data.totalCompradas || 0;
        const pctAcuerdo = ta > 0 ? Math.round((tc / ta) * 1000) / 10 : 0;
        setTotalesPorAcuerdo((p) => ({ ...p, [acuerdoPK]: { totalAcordado: ta, totalCompradas: tc, porcentaje: pctAcuerdo } }));
        if (acuerdoPK === seleccionadoRef.current) {
          setTotalAcordado(ta);
          setTotalCompradas(tc);
          setTotalRestante(data.totalRestante || 0);
          const edits: Record<string, string> = {};
          const apEdits: Record<string, string> = {};
          const raEdits: Record<string, string> = {};
          const deEdits: Record<string, string> = {};
          items.forEach((d: DetalleProducto) => {
            edits[d.ProductId] = String(d.Cantidad || 0);
            apEdits[d.ProductId] = String(d.Aportacion || 0);
            raEdits[d.ProductId] = String(d.Rappel || 0);
            deEdits[d.ProductId] = String(d.DescuentoExtra || 0);
          });
          setCantidadEdits(edits);
          setAportacionEdits(apEdits);
          setRappelEdits(raEdits);
          setDescuentoEdits(deEdits);
        }
      }
    } catch (_) { /* silencioso */ }
    finally {
      if (cargarDetallesAcuerdoRef.current === acuerdoPK) setLoadingDetalles(false);
    }
  }, []);

  const seleccionarAcuerdo = (a: Acuerdo) => {
    if (seleccionado?.PK === a.PK) { setSeleccionado(null); return; }
    setSeleccionado(a);
    const cached = detallesPorAcuerdo[a.PK] || [];
    const tieneCache = cached.length > 0;
    if (tieneCache) {
      const newAcordado = cached.reduce((s, x) => s + (x.Cantidad || 0), 0);
      const newCompradas = cached.reduce((s, x) => s + (x.Compradas || 0), 0);
      setTotalAcordado(newAcordado);
      setTotalCompradas(newCompradas);
      setTotalRestante(newAcordado - newCompradas);
      const pctCache = newAcordado > 0 ? Math.round((newCompradas / newAcordado) * 1000) / 10 : 0;
      setTotalesPorAcuerdo((p) => ({ ...p, [a.PK]: { totalAcordado: newAcordado, totalCompradas: newCompradas, porcentaje: pctCache } }));
      const edits: Record<string, string> = {};
      const apEdits: Record<string, string> = {};
      const raEdits: Record<string, string> = {};
      const deEdits: Record<string, string> = {};
      cached.forEach((d: DetalleProducto) => {
        edits[d.ProductId] = String(d.Cantidad || 0);
        apEdits[d.ProductId] = String(d.Aportacion || 0);
        raEdits[d.ProductId] = String(d.Rappel || 0);
        deEdits[d.ProductId] = String(d.DescuentoExtra || 0);
      });
      setCantidadEdits(edits);
      setAportacionEdits(apEdits);
      setRappelEdits(raEdits);
      setDescuentoEdits(deEdits);
    }
    cargarDetalles(a.PK, { showLoading: !tieneCache });
    cargarPagosImagen(a.PK);
    cargarArchivos(a.PK);
    cargarLocales();
    if (!productosLastFetch) recargarProductos();
  };

  const addProductoDetalle = async (prod: Record<string, unknown>) => {
    if (!seleccionado) return;
    const id = String(valorEnLocal(prod, 'Id') ?? '').trim();
    const name = String(valorEnLocal(prod, 'Name') ?? valorEnLocal(prod, 'Nombre') ?? id).trim();
    if (!id) return;
    try {
      const res = await fetch(`${API_URL}/api/acuerdos/${seleccionado.PK}/detalles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ProductId: id, ProductName: name, Cantidad: 0 }),
      });
      if (res.ok) {
        const nuevo: DetalleProducto = {
          PK: seleccionado.PK, SK: id, ProductId: id, ProductName: name,
          Cantidad: 0, Aportacion: 0, Rappel: 0, DescuentoExtra: 0,
          Compradas: 0, Restante: 0, Porcentaje: 0,
        };
        setDetallesPorAcuerdo((prev) => ({
          ...prev,
          [seleccionado.PK]: [...(prev[seleccionado.PK] || []), nuevo].sort((a, b) => (a.ProductName || '').localeCompare(b.ProductName || '')),
        }));
        setCantidadEdits((prev) => ({ ...prev, [id]: '0' }));
        setAportacionEdits((prev) => ({ ...prev, [id]: '0' }));
        setRappelEdits((prev) => ({ ...prev, [id]: '0' }));
        setDescuentoEdits((prev) => ({ ...prev, [id]: '0' }));
        cargarTotales();
        cargarDetalles(seleccionado.PK, { showLoading: false });
      }
    } catch (err: any) { setError(err.message); }
    setProdDropdownOpen(false);
    setProdSearch('');
  };

  const actualizarCantidad = async (productId: string, cantidad: number) => {
    if (!seleccionado) return;
    try {
      await fetch(`${API_URL}/api/acuerdos/${seleccionado.PK}/detalles/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Cantidad: cantidad }),
      });
    } catch (err: any) { setError(err.message); }
  };

  const actualizarCampoDetalle = async (productId: string, campo: string, valor: number) => {
    if (!seleccionado) return;
    try {
      await fetch(`${API_URL}/api/acuerdos/${seleccionado.PK}/detalles/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [campo]: valor }),
      });
    } catch (err: any) { setError(err.message); }
  };

  const [cantidadEdits, setCantidadEdits] = useState<Record<string, string>>({});
  const [aportacionEdits, setAportacionEdits] = useState<Record<string, string>>({});
  const [rappelEdits, setRappelEdits] = useState<Record<string, string>>({});
  const [descuentoEdits, setDescuentoEdits] = useState<Record<string, string>>({});

  const removeProductoDetalle = async (productId: string) => {
    if (!seleccionado) return;
    try {
      const res = await fetch(
        `${API_URL}/api/acuerdos/${encodeURIComponent(seleccionado.PK)}/detalles/${encodeURIComponent(productId)}`,
        { method: 'DELETE' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || `Error al eliminar producto (${res.status})`);
        return;
      }
      setDetallesPorAcuerdo((prev) => {
        const current = prev[seleccionado.PK] || [];
        const updated = current.filter((d) => d.ProductId !== productId);
        const newAcordado = updated.reduce((s, x) => s + (x.Cantidad || 0), 0);
        const newCompradas = updated.reduce((s, x) => s + (x.Compradas || 0), 0);
        setTotalAcordado(newAcordado);
        setTotalCompradas(newCompradas);
        setTotalRestante(newAcordado - newCompradas);
        const pct = newAcordado > 0 ? Math.round((newCompradas / newAcordado) * 1000) / 10 : 0;
        setTotalesPorAcuerdo((p) => ({ ...p, [seleccionado.PK]: { totalAcordado: newAcordado, totalCompradas: newCompradas, porcentaje: pct } }));
        return { ...prev, [seleccionado.PK]: updated };
      });
      setCantidadEdits((prev) => { const n = { ...prev }; delete n[productId]; return n; });
      setAportacionEdits((prev) => { const n = { ...prev }; delete n[productId]; return n; });
      setRappelEdits((prev) => { const n = { ...prev }; delete n[productId]; return n; });
      setDescuentoEdits((prev) => { const n = { ...prev }; delete n[productId]; return n; });
    } catch (err: any) { setError(err.message || 'Error de conexión'); }
  };

  const cargarPagosImagen = useCallback(async (acuerdoPK: string) => {
    setLoadingPagos(true);
    try {
      const res = await fetch(`${API_URL}/api/acuerdos/${acuerdoPK}/imagen`);
      const data = await res.json();
      if (res.ok) setPagosImagen(data.items || []);
    } catch (_) {}
    finally { setLoadingPagos(false); }
  }, []);

  const cargarLocales = useCallback(async () => {
    if (localesLoaded) return;
    try {
      const res = await fetch(`${API_URL}/api/locales?minimal=1`);
      const data = await res.json();
      const list = (data.locales || []).map((l: any) => ({ id: l.id_Locales || l.Id || '', nombre: l.nombre || l.Nombre || '' }));
      list.sort((a: any, b: any) => a.nombre.localeCompare(b.nombre));
      setLocales(list);
      setLocalesLoaded(true);
    } catch (_) {}
  }, [localesLoaded]);

  const cargarArchivos = useCallback(async (acuerdoPK: string) => {
    setLoadingArchivos(true);
    try {
      const res = await fetch(`${API_URL}/api/acuerdos/${acuerdoPK}/files`);
      const data = await res.json();
      if (res.ok) setArchivos(data);
    } catch (_) {}
    finally { setLoadingArchivos(false); }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const items = await cargar();
        if (cancelled) return;
        cargarTotales();
        const lastPK = await AsyncStorage.getItem(ACUERDOS_LAST_SELECTED_KEY);
        if (lastPK) {
          let a = items.find((x: Acuerdo) => x.PK === lastPK);
          if (!a) {
            try {
              const res = await fetch(`${API_URL}/api/acuerdos/${encodeURIComponent(lastPK)}`);
              const data = await res.json();
              if (res.ok && data.item) {
                a = data.item as Acuerdo;
                setAcuerdos((prev) => {
                  const exists = prev.some((x) => x.PK === a.PK);
                  if (exists) return prev;
                  return [a!, ...prev].sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || ''));
                });
              }
            } catch (_) {}
          }
          if (a) {
            setSeleccionado(a);
            cargarDetalles(a.PK, { showLoading: true });
            cargarPagosImagen(a.PK);
            cargarArchivos(a.PK);
            cargarLocales();
          }
        }
      })();
      return () => { cancelled = true; };
    }, [cargar, cargarTotales, cargarDetalles, cargarPagosImagen, cargarArchivos, cargarLocales])
  );

  const subirArchivo = useCallback(async () => {
    if (!seleccionado || Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
      const files = input.files;
      if (!files || files.length === 0) return;
      setSubiendoArchivo(true);
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const presignRes = await fetch(`${API_URL}/api/acuerdos/${seleccionado.PK}/files/presign-upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName: file.name, contentType: file.type }),
          });
          const { uploadUrl, fileKey } = await presignRes.json();

          await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type },
            body: file,
          });

          await fetch(`${API_URL}/api/acuerdos/${seleccionado.PK}/files`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileKey, fileName: file.name, contentType: file.type, size: file.size }),
          });
        }
        await cargarArchivos(seleccionado.PK);
      } catch (err) {
        console.error('Error subiendo archivo', err);
      } finally {
        setSubiendoArchivo(false);
      }
    };
    input.click();
  }, [seleccionado, cargarArchivos]);

  const eliminarArchivo = useCallback(async (fileKey: string) => {
    if (!seleccionado) return;
    try {
      await fetch(`${API_URL}/api/acuerdos/${seleccionado.PK}/files/${encodeURIComponent(fileKey)}`, { method: 'DELETE' });
      setArchivos((prev) => prev.filter((f) => f.fileKey !== fileKey));
    } catch (err) {
      console.error('Error eliminando archivo', err);
    }
  }, [seleccionado]);

  const abrirImgModal = (pago?: PagoImagen) => {
    cargarLocales();
    if (pago) {
      setImgEditSK(pago.SK);
      setImgForm({ Locales: pago.Locales || [], Acciones: pago.Acciones || [], Importe: String(pago.Importe || ''), Descripcion: pago.Descripcion || '' });
      setImgFiles(pago.Justificantes || []);
    } else {
      setImgEditSK(null);
      setImgForm({ Locales: [], Acciones: [], Importe: '', Descripcion: '' });
      setImgFiles([]);
    }
    setImgModalVisible(true);
  };

  const guardarPagoImagen = async () => {
    if (!seleccionado) return;
    setGuardandoImg(true);
    try {
      const payload = {
        Locales: imgForm.Locales,
        Acciones: imgForm.Acciones,
        Importe: parseFloat(imgForm.Importe) || 0,
        Justificantes: imgFiles,
        Descripcion: imgForm.Descripcion,
      };
      const url = imgEditSK
        ? `${API_URL}/api/acuerdos/${seleccionado.PK}/imagen/${imgEditSK}`
        : `${API_URL}/api/acuerdos/${seleccionado.PK}/imagen`;
      const method = imgEditSK ? 'PATCH' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (res.ok) {
        setImgModalVisible(false);
        await cargarPagosImagen(seleccionado.PK);
      }
    } catch (err: any) { setError(err.message); }
    finally { setGuardandoImg(false); }
  };

  const eliminarPagoImagen = async (sk: string) => {
    if (!seleccionado) return;
    try {
      await fetch(`${API_URL}/api/acuerdos/${seleccionado.PK}/imagen/${sk}`, { method: 'DELETE' });
      await cargarPagosImagen(seleccionado.PK);
    } catch (err: any) { setError(err.message); }
  };

  const handleFileSelect = () => {
    if (Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
      const files = input.files;
      if (!files) return;
      Array.from(files).forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          setImgFiles((prev) => [...prev, { name: file.name, data: reader.result as string }]);
        };
        reader.readAsDataURL(file);
      });
    };
    input.click();
  };

  const localNombre = useCallback((id: string) => {
    const l = locales.find((loc) => loc.id === id);
    return l ? l.nombre : id;
  }, [locales]);

  const localesFiltrados = useMemo(() => {
    const q = localSearch.trim().toLowerCase();
    if (!q) return locales.slice(0, 60);
    return locales.filter((l) => l.nombre.toLowerCase().includes(q) || l.id.includes(q)).slice(0, 60);
  }, [locales, localSearch]);

  const totalImporteImagen = useMemo(() => pagosImagen.reduce((s, p) => s + (p.Importe || 0), 0), [pagosImagen]);
  const totalImporteImagenRealizado = useMemo(() => pagosImagen.filter((p) => p.Realizado).reduce((s, p) => s + (p.Importe || 0), 0), [pagosImagen]);

  const aportacionVolumen = useMemo(() => detalles.reduce((s, d) => {
    const ta = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0);
    return s + (d.Cantidad || 0) * ta;
  }, 0), [detalles]);

  const aportacionVolumenGenerado = useMemo(() => detalles.reduce((s, d) => {
    const ta = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0);
    return s + (d.Compradas || 0) * ta;
  }, 0), [detalles]);

  const totalAcuerdo = aportacionVolumen + totalImporteImagen;
  const totalAcuerdoGenerado = aportacionVolumenGenerado + totalImporteImagenRealizado;

  const productosFiltrados = useMemo(() => {
    const q = prodSearch.trim().toLowerCase();
    const prods = (productosIgp || []) as Record<string, unknown>[];
    const asignados = new Set(detalles.map((d) => d.ProductId));
    const filtered = prods.filter((p) => {
      const id = String(valorEnLocal(p, 'Id') ?? '').trim();
      if (asignados.has(id)) return false;
      if (!q) return true;
      const name = String(valorEnLocal(p, 'Name') ?? valorEnLocal(p, 'Nombre') ?? '').toLowerCase();
      return name.includes(q) || id.toLowerCase().includes(q);
    });
    return filtered.slice(0, 50);
  }, [productosIgp, prodSearch, detalles]);

  const isCompact = winWidth < 700;

  const generarPDF = useCallback(() => {
    if (!seleccionado) return;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    let y = 15;

    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text(seleccionado.Marca || 'Sin marca', 14, y);
    y += 7;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100);
    doc.text(`${formatFecha(seleccionado.FechaInicio)} — ${formatFecha(seleccionado.FechaFin)}`, 14, y);
    const tr = calcTiempoRestante(seleccionado.FechaFin);
    doc.text(tr.texto, pageW - 14, y, { align: 'right' });
    y += 8;

    doc.setDrawColor(200);
    doc.line(14, y, pageW - 14, y);
    y += 6;

    doc.setTextColor(60);
    doc.setFontSize(9);
    const infoLines: [string, string][] = [
      ['PK', seleccionado.PK],
      ['Nombre', seleccionado.Nombre || '—'],
      ['Marca', seleccionado.Marca || '—'],
      ['Estado', seleccionado.Estado],
    ];
    if (seleccionado.Contacto) infoLines.push(['Contacto', seleccionado.Contacto]);
    if (seleccionado.Telefono) infoLines.push(['Teléfono', seleccionado.Telefono]);
    if (seleccionado.Email) infoLines.push(['Email', seleccionado.Email]);
    if (seleccionado.Notas) infoLines.push(['Notas', seleccionado.Notas]);

    const colX = 14;
    const col2X = pageW / 2 + 10;
    const half = Math.ceil(infoLines.length / 2);
    for (let i = 0; i < half; i++) {
      const left = infoLines[i];
      const right = infoLines[i + half];
      if (left) {
        doc.setFont('helvetica', 'bold');
        doc.text(`${left[0]}:`, colX, y);
        doc.setFont('helvetica', 'normal');
        doc.text(left[1], colX + 28, y);
      }
      if (right) {
        doc.setFont('helvetica', 'bold');
        doc.text(`${right[0]}:`, col2X, y);
        doc.setFont('helvetica', 'normal');
        doc.text(right[1], col2X + 28, y);
      }
      y += 5;
    }
    y += 4;

    const fmtNum = (n: number) => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    const totalesData = [
      ['Total Acuerdo', fmtNum(totalAcuerdo), 'Total Acuerdo Generado', fmtNum(totalAcuerdoGenerado)],
      ['Aport. Volumen', fmtNum(aportacionVolumen), 'Aport. Volumen Generado', fmtNum(aportacionVolumenGenerado)],
      ['Aport. Imagen', fmtNum(totalImporteImagen), 'Aport. Imagen Generada', fmtNum(totalImporteImagenRealizado)],
    ];
    autoTable(doc, {
      startY: y,
      head: [['Concepto', 'Importe', 'Concepto Generado', 'Importe Generado']],
      body: totalesData,
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'right' }, 3: { halign: 'right' } },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 8;

    const pctGlobal = totalAcordado > 0 ? (totalCompradas / totalAcordado * 100).toFixed(1) : '0.0';
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text(`Consecución global: ${pctGlobal}% — ${totalCompradas.toLocaleString('es-ES')} / ${totalAcordado.toLocaleString('es-ES')} uds.`, 14, y);
    y += 6;

    if (detalles.length > 0) {
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(15, 23, 42);
      doc.text('Productos del acuerdo', 14, y);
      y += 2;

      const prodHead = [['ID', 'Producto', 'Acordado', 'Compradas', 'Restante', '%', 'Total Aport.', 'Aportación', 'Rappel', 'Dto. extra', 'Prev. Pago', 'Prev. Confirm.']];
      const prodBody = detalles.map((d) => {
        const ta = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0);
        const rest = d.Restante || 0;
        return [
          d.ProductId,
          d.ProductName || d.ProductId,
          String(d.Cantidad || 0),
          String(d.Compradas || 0),
          rest > 0 ? `-${rest}` : rest < 0 ? `+${Math.abs(rest)}` : String(rest),
          `${(d.Porcentaje || 0).toFixed(1)}%`,
          fmtNum(ta),
          fmtNum(d.Aportacion || 0),
          fmtNum(d.Rappel || 0),
          fmtNum(d.DescuentoExtra || 0),
          fmtNum((d.Cantidad || 0) * ta),
          fmtNum((d.Compradas || 0) * ta),
        ];
      });

      const totAcord = detalles.reduce((s, d) => s + (d.Cantidad || 0), 0);
      const totComp = detalles.reduce((s, d) => s + (d.Compradas || 0), 0);
      const totRest = totAcord - totComp;
      const totTA = detalles.reduce((s, d) => s + (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0), 0);
      const totPrevPago = detalles.reduce((s, d) => { const ta = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0); return s + (d.Cantidad || 0) * ta; }, 0);
      const totPrevConf = detalles.reduce((s, d) => { const ta = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0); return s + (d.Compradas || 0) * ta; }, 0);

      prodBody.push([
        '', 'TOTAL',
        String(totAcord), String(totComp),
        totRest > 0 ? `-${totRest}` : totRest < 0 ? `+${Math.abs(totRest)}` : String(totRest),
        '', fmtNum(totTA), '', '', '',
        fmtNum(totPrevPago), fmtNum(totPrevConf),
      ]);

      autoTable(doc, {
        startY: y,
        head: prodHead,
        body: prodBody,
        theme: 'striped',
        styles: { fontSize: 7, cellPadding: 1.5 },
        headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold', fontSize: 7 },
        columnStyles: {
          0: { cellWidth: 18 },
          1: { cellWidth: 40 },
          2: { halign: 'center' },
          3: { halign: 'center' },
          4: { halign: 'center' },
          5: { halign: 'center' },
          6: { halign: 'right' },
          7: { halign: 'right' },
          8: { halign: 'right' },
          9: { halign: 'right' },
          10: { halign: 'right' },
          11: { halign: 'right' },
        },
        margin: { left: 14, right: 14 },
        didParseCell: (data: any) => {
          if (data.section === 'body' && data.row.index === prodBody.length - 1) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.fillColor = [240, 249, 255];
          }
        },
      });
      y = (doc as any).lastAutoTable.finalY + 8;
    }

    if (pagosImagen.length > 0) {
      if (y > doc.internal.pageSize.getHeight() - 30) { doc.addPage(); y = 15; }
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(15, 23, 42);
      doc.text('Pagos por imagen', 14, y);
      y += 2;

      const imgHead = [['Acciones', 'Locales', 'Importe', 'Realizado', 'Descripción']];
      const imgBody = pagosImagen.map((p) => [
        p.Acciones.join(', '),
        p.Locales.map((id) => { const l = locales.find((loc) => loc.id === id); return l ? l.nombre : id; }).join(', '),
        fmtNum(p.Importe || 0),
        p.Realizado ? 'Sí' : 'No',
        p.Descripcion || '',
      ]);
      imgBody.push(['', 'TOTAL', fmtNum(totalImporteImagen), `Realizado: ${fmtNum(totalImporteImagenRealizado)}`, '']);

      autoTable(doc, {
        startY: y,
        head: imgHead,
        body: imgBody,
        theme: 'striped',
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold' },
        columnStyles: {
          2: { halign: 'right' },
          3: { halign: 'center' },
        },
        margin: { left: 14, right: 14 },
        didParseCell: (data: any) => {
          if (data.section === 'body' && data.row.index === imgBody.length - 1) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.fillColor = [240, 249, 255];
          }
        },
      });
    }

    const pageCount = doc.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(150);
      doc.text(`Generado el ${new Date().toLocaleDateString('es-ES')} — Pág. ${i}/${pageCount}`, pageW - 14, doc.internal.pageSize.getHeight() - 8, { align: 'right' });
    }

    const fileName = `Acuerdo_${(seleccionado.Marca || seleccionado.PK).replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
    doc.save(fileName);
  }, [seleccionado, detalles, pagosImagen, locales, totalAcuerdo, totalAcuerdoGenerado, aportacionVolumen, aportacionVolumenGenerado, totalImporteImagen, totalImporteImagenRealizado, totalAcordado, totalCompradas]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Acuerdos con Marcas</Text>
        <TouchableOpacity style={styles.createBtn} onPress={abrirCrear}>
          <MaterialIcons name="add" size={20} color="#fff" />
          <Text style={styles.createBtnText}>Nuevo Acuerdo</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => setError('')}><MaterialIcons name="close" size={14} color="#dc2626" /></TouchableOpacity>
        </View>
      ) : null}

      {ModalConfirm()}

      <View style={styles.splitContainer}>
        {/* Lista de acuerdos */}
        <ScrollView style={[styles.list, seleccionado && !isCompact && { flex: 2 }]} contentContainerStyle={styles.listContent}>
          {loading && acuerdos.length === 0 ? (
            <View style={styles.emptyWrap}><ActivityIndicator size="large" color="#0ea5e9" /><Text style={styles.emptyText}>Cargando…</Text></View>
          ) : acuerdos.length === 0 ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name="handshake" size={48} color="#cbd5e1" />
              <Text style={styles.emptyText}>No hay acuerdos. Crea uno pulsando "Nuevo Acuerdo".</Text>
            </View>
          ) : (
            acuerdosOrdenados.map((a) => {
              const estadoColor = a.Estado === 'Activo' ? '#16a34a' : a.Estado === 'Completado' ? '#0ea5e9' : a.Estado === 'Vencido' ? '#ef4444' : '#94a3b8';
              const isSelected = seleccionado?.PK === a.PK;
              return (
                <TouchableOpacity key={a.PK} activeOpacity={0.7} onPress={() => seleccionarAcuerdo(a)} style={[styles.card, isSelected && styles.cardSelected]}>
                  <View style={styles.cardHeader}>
                    <View style={styles.cardTitleWrap}>
                      <Text style={styles.cardTitle}>{a.Marca || '—'}</Text>
                      <View style={[styles.badge, { backgroundColor: estadoColor + '18', borderColor: estadoColor }]}>
                        <Text style={[styles.badgeText, { color: estadoColor }]}>{a.Estado}</Text>
                      </View>
                    </View>
                    <View style={styles.cardActions}>
                      <TooltipBtn tooltip="Editar" onPress={() => abrirEditar(a)} style={styles.cardActionBtn}>
                        <MaterialIcons name="edit" size={18} color="#64748b" />
                      </TooltipBtn>
                      <TooltipBtn
                        tooltip="Eliminar"
                        onPress={() => confirmDelete('Confirmar eliminación', `¿Quieres eliminar el acuerdo "${a.Marca || a.Nombre || a.PK}"? Esta acción no se puede deshacer.`, () => eliminar(a.PK))}
                        style={styles.cardActionBtn}
                      >
                        <MaterialIcons name="delete-outline" size={18} color="#ef4444" />
                      </TooltipBtn>
                    </View>
                  </View>
                  <View style={styles.cardBodyWithDonut}>
                    {(() => {
                      const t = totalesPorAcuerdo[a.PK];
                      const pct = t?.porcentaje ?? 0;
                      const compradas = t?.totalCompradas ?? 0;
                      const acordado = t?.totalAcordado ?? 0;
                      return (
                        <DonutChart porcentaje={pct} compradas={compradas} acordado={acordado || 1} size={56} />
                      );
                    })()}
                    <View style={styles.cardBodyInfo}>
                      <View style={styles.cardField}>
                        <Text style={styles.cardFieldLabel}>Identificador</Text>
                        <Text style={styles.cardFieldValue}>{a.Nombre || a.PK.slice(0, 8)}</Text>
                      </View>
                      <View style={styles.cardField}>
                        <Text style={styles.cardFieldLabel}>Periodo</Text>
                        <Text style={styles.cardFieldValue}>{formatFecha(a.FechaInicio)} — {formatFecha(a.FechaFin)}</Text>
                      </View>
                    </View>
                  </View>
                  {a.Notas ? <Text style={styles.cardNotas}>{a.Notas}</Text> : null}
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>

        {/* Panel lateral: Detalle del acuerdo */}
        {seleccionado && (
          <View style={[styles.detailPanel, isCompact && styles.detailPanelCompact]}>
            <ScrollView keyboardShouldPersistTaps="handled">
              {/* Cabecera */}
              <View style={styles.detailPanelHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.detailPanelTitle}>{seleccionado.Marca || 'Sin marca'}</Text>
                  {(() => {
                    const tr = calcTiempoRestante(seleccionado.FechaFin);
                    return <Text style={[styles.detailPanelCountdown, tr.vencido && { color: '#ef4444' }]}>{tr.texto}</Text>;
                  })()}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {Platform.OS === 'web' && (
                    <TooltipBtn tooltip="Descargar PDF" onPress={generarPDF} style={{ padding: 4 }}>
                      <MaterialIcons name="picture-as-pdf" size={20} color="#ef4444" />
                    </TooltipBtn>
                  )}
                  <TouchableOpacity onPress={() => setSeleccionado(null)} style={{ padding: 4 }}>
                    <MaterialIcons name="close" size={20} color="#64748b" />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Info del acuerdo + Totales */}
              <View style={styles.detailInfoSection}>
                <View style={styles.detailInfoColumns}>
                  {/* Columna izquierda: datos del acuerdo */}
                  <View style={styles.detailInfoLeft}>
                    <View style={styles.detailInfoRow}>
                      <Text style={styles.detailInfoLabel}>PK</Text>
                      <Text style={styles.detailInfoValue} numberOfLines={1}>{seleccionado.PK}</Text>
                    </View>
                    {seleccionado.Nombre ? (
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>Nombre</Text>
                        <Text style={styles.detailInfoValue}>{seleccionado.Nombre}</Text>
                      </View>
                    ) : null}
                    <View style={styles.detailInfoRow}>
                      <Text style={styles.detailInfoLabel}>Marca</Text>
                      <Text style={styles.detailInfoValue}>{seleccionado.Marca || '—'}</Text>
                    </View>
                    <View style={styles.detailInfoRow}>
                      <Text style={styles.detailInfoLabel}>Periodo</Text>
                      <Text style={styles.detailInfoValue}>{formatFecha(seleccionado.FechaInicio)} — {formatFecha(seleccionado.FechaFin)}</Text>
                    </View>
                    <View style={styles.detailInfoRow}>
                      <Text style={styles.detailInfoLabel}>Estado</Text>
                      <Text style={[styles.detailInfoValue, { color: seleccionado.Estado === 'Activo' ? '#16a34a' : seleccionado.Estado === 'Completado' ? '#0ea5e9' : seleccionado.Estado === 'Vencido' ? '#ef4444' : '#94a3b8', fontWeight: '600' }]}>{seleccionado.Estado}</Text>
                    </View>
                    {seleccionado.Contacto ? (
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>Contacto</Text>
                        <Text style={styles.detailInfoValue}>{seleccionado.Contacto}</Text>
                      </View>
                    ) : null}
                    {seleccionado.Telefono ? (
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>Teléfono</Text>
                        <Text style={styles.detailInfoValue}>{seleccionado.Telefono}</Text>
                      </View>
                    ) : null}
                    {seleccionado.Email ? (
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>Email</Text>
                        <Text style={styles.detailInfoValue}>{seleccionado.Email}</Text>
                      </View>
                    ) : null}
                    {seleccionado.Notas ? (
                      <View style={styles.detailInfoRow}>
                        <Text style={styles.detailInfoLabel}>Notas</Text>
                        <Text style={[styles.detailInfoValue, { fontStyle: 'italic' }]}>{seleccionado.Notas}</Text>
                      </View>
                    ) : null}
                    <Text style={styles.detailInfoConcat}>
                      {seleccionado.Marca || '—'} ({formatFecha(seleccionado.FechaInicio)} - {formatFecha(seleccionado.FechaFin)})
                    </Text>
                  </View>
                  {/* Columna derecha: donut + totales económicos */}
                  <View style={styles.detailInfoRight}>
                    {totalAcordado > 0 && (
                      <DonutChart
                        porcentaje={Math.round((totalCompradas / totalAcordado) * 1000) / 10}
                        compradas={totalCompradas}
                        acordado={totalAcordado}
                        size={100}
                      />
                    )}
                    <View style={{ flex: 1, gap: 8 }}>
                      <View style={styles.totalCard}>
                        <Text style={styles.totalCardTitle}>Total Acuerdo</Text>
                        <Text style={styles.totalCardValue}>{totalAcuerdo.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        <View style={styles.totalCardSub}>
                          <Text style={styles.totalCardSubLabel}>Aport. Volumen</Text>
                          <Text style={styles.totalCardSubValue}>{aportacionVolumen.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        </View>
                        <View style={styles.totalCardSub}>
                          <Text style={styles.totalCardSubLabel}>Aport. Imagen</Text>
                          <Text style={styles.totalCardSubValue}>{totalImporteImagen.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        </View>
                      </View>
                      <View style={[styles.totalCard, { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' }]}>
                        <Text style={[styles.totalCardTitle, { color: '#16a34a' }]}>Total Acuerdo Generado</Text>
                        <Text style={[styles.totalCardValue, { color: '#16a34a' }]}>{totalAcuerdoGenerado.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        <View style={styles.totalCardSub}>
                          <Text style={styles.totalCardSubLabel}>Aport. Volumen Gen.</Text>
                          <Text style={[styles.totalCardSubValue, { color: '#16a34a' }]}>{aportacionVolumenGenerado.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        </View>
                        <View style={styles.totalCardSub}>
                          <Text style={styles.totalCardSubLabel}>Aport. Imagen Gen.</Text>
                          <Text style={[styles.totalCardSubValue, { color: '#16a34a' }]}>{totalImporteImagenRealizado.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                        </View>
                      </View>
                    </View>
                  </View>
                </View>
              </View>

              {/* Sección productos */}
              <View style={styles.detailProductsSection}>
                <View style={styles.detailProductsHeader}>
                  <Text style={styles.detailProductsSectionTitle}>Productos del acuerdo</Text>
                  <TouchableOpacity style={styles.detailAddBtn} onPress={() => { setProdSearch(''); setProdFocusedIndex(0); setProdDropdownOpen((o) => !o); }}>
                    <MaterialIcons name="add" size={14} color="#0ea5e9" />
                    <Text style={styles.detailAddBtnText}>Añadir</Text>
                  </TouchableOpacity>
                </View>

                {prodDropdownOpen && (
                  <View style={[styles.productoDropdown, styles.detailProdDropdown, { marginHorizontal: 14, marginBottom: 8 }]}>
                    <View style={[styles.productoDropdownSearch, styles.detailProdDropdownSearch]}>
                      <MaterialIcons name="search" size={14} color="#94a3b8" />
                      <TextInput
                        style={[styles.productoDropdownInput, styles.detailProdDropdownInput]}
                        value={prodSearch}
                        onChangeText={(v) => { setProdSearch(v); setProdFocusedIndex(0); }}
                        placeholder="Buscar producto…"
                        placeholderTextColor="#94a3b8"
                        autoFocus
                        {...(Platform.OS === 'web' ? {
                          onKeyDown: (e: any) => {
                            const list = productosFiltrados;
                            if (list.length === 0) return;
                            const key = e.key;
                            if (key === 'ArrowDown') {
                              e.preventDefault();
                              setProdFocusedIndex((i) => Math.min(i + 1, list.length - 1));
                            } else if (key === 'ArrowUp') {
                              e.preventDefault();
                              setProdFocusedIndex((i) => Math.max(i - 1, 0));
                            } else if (key === 'Enter') {
                              e.preventDefault();
                              const idx = prodFocusedIndex >= 0 && prodFocusedIndex < list.length ? prodFocusedIndex : 0;
                              addProductoDetalle(list[idx]);
                              setProdDropdownOpen(false);
                            }
                          },
                        } : {})}
                      />
                      <TouchableOpacity onPress={() => setProdDropdownOpen(false)}><MaterialIcons name="close" size={14} color="#94a3b8" /></TouchableOpacity>
                    </View>
                    <ScrollView ref={prodListScrollRef} style={[styles.productoDropdownList, styles.detailProdDropdownList]} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                      {loadingProductos ? <ActivityIndicator size="small" color="#0ea5e9" style={{ padding: 8 }} /> : (
                        productosFiltrados.length === 0 ? <Text style={[styles.productoDropdownEmpty, styles.detailProdDropdownEmpty]}>Sin resultados</Text> :
                        productosFiltrados.map((p, i) => {
                          const id = String(valorEnLocal(p, 'Id') ?? '').trim();
                          const name = String(valorEnLocal(p, 'Name') ?? valorEnLocal(p, 'Nombre') ?? id).trim();
                          return (
                            <TouchableOpacity key={id || i} style={[styles.productoDropdownItem, styles.detailProdDropdownItem]} onPress={() => addProductoDetalle(p)} {...(Platform.OS === 'web' ? { title: name } : {})}>
                              <Text style={[styles.productoDropdownItemText, styles.detailProdDropdownItemText]} numberOfLines={1}>{name}</Text>
                            </TouchableOpacity>
                          );
                        })
                      )}
                    </ScrollView>
                  </View>
                )}

                {/* Tabla de productos */}
                {loadingDetalles && detalles.length === 0 ? (
                  <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 20 }} />
                ) : detalles.length === 0 ? (
                  <Text style={styles.detailEmpty}>Sin productos asignados</Text>
                ) : (
                  <ScrollView horizontal style={styles.detailTableScroll} nestedScrollEnabled>
                    <View style={styles.detailTableWrap}>
                      <View style={styles.detailTableHeader}>
                        <Text style={[styles.detailTableHeaderText, { width: 60 }]}>ID</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 140 }]}>Producto</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 70, textAlign: 'center' }]}>Acordado</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 70, textAlign: 'center' }]}>Compradas</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 70, textAlign: 'center' }]}>Restante</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 55, textAlign: 'center' }]}>%</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 85, textAlign: 'center' }]}>Total aport.</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 80, textAlign: 'center' }]}>Aportación</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 80, textAlign: 'center' }]}>Rappel</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 80, textAlign: 'center' }]}>Dto. extra</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 100, textAlign: 'center' }]}>Prev. Pago</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 100, textAlign: 'center' }]}>Prev. Confirm.</Text>
                        <Text style={[styles.detailTableHeaderText, { width: 80 }]} />
                      </View>
                      {detalles.map((d) => {
                        const pctColor = d.Porcentaje >= 80 ? '#16a34a' : '#ef4444';
                        return (
                          <View key={d.SK} style={styles.detailTableRow}>
                            <Text style={[styles.detailTableCell, { width: 60, fontSize: 10, color: '#64748b' }]} numberOfLines={1}>{d.ProductId}</Text>
                            <View style={{ width: 140 }} {...(Platform.OS === 'web' ? { title: String(d.ProductName || d.ProductId || '') } : {})}>
                              <Text style={[styles.detailTableCell]} numberOfLines={1}>{d.ProductName || d.ProductId}</Text>
                            </View>
                            <View style={{ width: 70, alignItems: 'center' }}>
                              <TextInput
                                style={styles.cantidadInput}
                                value={cantidadEdits[d.ProductId] ?? String(d.Cantidad || 0)}
                                onChangeText={(v) => setCantidadEdits((prev) => ({ ...prev, [d.ProductId]: v }))}
                                onBlur={() => {
                                  if (!seleccionado) return;
                                  const val = parseFloat(cantidadEdits[d.ProductId] || '0') || 0;
                                  actualizarCantidad(d.ProductId, val);
                                  setDetallesPorAcuerdo((prev) => {
                                    const current = prev[seleccionado.PK] || [];
                                    const updated = current.map((x) => x.ProductId === d.ProductId ? { ...x, Cantidad: val, Restante: val - x.Compradas, Porcentaje: val > 0 ? Math.round((x.Compradas / val) * 1000) / 10 : 0 } : x);
                                    const newAcordado = updated.reduce((s, x) => s + (x.Cantidad || 0), 0);
                                    const newCompradas = updated.reduce((s, x) => s + (x.Compradas || 0), 0);
                                    setTotalAcordado(newAcordado);
                                    setTotalCompradas(newCompradas);
                                    setTotalRestante(newAcordado - newCompradas);
                                    const pct = newAcordado > 0 ? Math.round((newCompradas / newAcordado) * 1000) / 10 : 0;
                                    setTotalesPorAcuerdo((p) => ({ ...p, [seleccionado.PK]: { totalAcordado: newAcordado, totalCompradas: newCompradas, porcentaje: pct } }));
                                    return { ...prev, [seleccionado.PK]: updated };
                                  });
                                }}
                                keyboardType="numeric"
                                selectTextOnFocus
                              />
                            </View>
                            <Text style={[styles.detailTableCell, { width: 70, textAlign: 'center', fontWeight: '600' }]}>{(d.Compradas || 0).toLocaleString('es-ES')}</Text>
                            <Text style={[styles.detailTableCell, { width: 70, textAlign: 'center', color: d.Restante > 0 ? '#ef4444' : (d.Restante || 0) < 0 ? '#16a34a' : '#0f172a', fontWeight: (d.Restante || 0) !== 0 ? '600' : '400' }]}>{d.Restante > 0 ? `-${d.Restante.toLocaleString('es-ES')}` : (d.Restante || 0) < 0 ? `+${Math.abs(d.Restante || 0).toLocaleString('es-ES')}` : (d.Restante || 0).toLocaleString('es-ES')}</Text>
                            <Text style={[styles.detailTableCell, { width: 55, textAlign: 'center', fontWeight: '700', color: pctColor }]}>{d.Porcentaje?.toFixed(1)}%</Text>
                            <Text style={[styles.detailTableCell, { width: 85, textAlign: 'center', fontWeight: '700', color: '#0f172a' }]}>
                              {((d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0)).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €
                            </Text>
                            <View style={{ width: 80, alignItems: 'center' }}>
                              <TextInput
                                style={styles.cantidadInput}
                                value={aportacionEdits[d.ProductId] ?? String(d.Aportacion || 0)}
                                onChangeText={(v) => setAportacionEdits((prev) => ({ ...prev, [d.ProductId]: v }))}
                                onBlur={() => {
                                  if (!seleccionado) return;
                                  const val = parseFloat(aportacionEdits[d.ProductId] || '0') || 0;
                                  actualizarCampoDetalle(d.ProductId, 'Aportacion', val);
                                  setDetallesPorAcuerdo((prev) => ({ ...prev, [seleccionado.PK]: (prev[seleccionado.PK] || []).map((x) => x.ProductId === d.ProductId ? { ...x, Aportacion: val } : x) }));
                                }}
                                keyboardType="numeric"
                                selectTextOnFocus
                              />
                            </View>
                            <View style={{ width: 80, alignItems: 'center' }}>
                              <TextInput
                                style={styles.cantidadInput}
                                value={rappelEdits[d.ProductId] ?? String(d.Rappel || 0)}
                                onChangeText={(v) => setRappelEdits((prev) => ({ ...prev, [d.ProductId]: v }))}
                                onBlur={() => {
                                  if (!seleccionado) return;
                                  const val = parseFloat(rappelEdits[d.ProductId] || '0') || 0;
                                  actualizarCampoDetalle(d.ProductId, 'Rappel', val);
                                  setDetallesPorAcuerdo((prev) => ({ ...prev, [seleccionado.PK]: (prev[seleccionado.PK] || []).map((x) => x.ProductId === d.ProductId ? { ...x, Rappel: val } : x) }));
                                }}
                                keyboardType="numeric"
                                selectTextOnFocus
                              />
                            </View>
                            <View style={{ width: 80, alignItems: 'center' }}>
                              <TextInput
                                style={styles.cantidadInput}
                                value={descuentoEdits[d.ProductId] ?? String(d.DescuentoExtra || 0)}
                                onChangeText={(v) => setDescuentoEdits((prev) => ({ ...prev, [d.ProductId]: v }))}
                                onBlur={() => {
                                  if (!seleccionado) return;
                                  const val = parseFloat(descuentoEdits[d.ProductId] || '0') || 0;
                                  actualizarCampoDetalle(d.ProductId, 'DescuentoExtra', val);
                                  setDetallesPorAcuerdo((prev) => ({ ...prev, [seleccionado.PK]: (prev[seleccionado.PK] || []).map((x) => x.ProductId === d.ProductId ? { ...x, DescuentoExtra: val } : x) }));
                                }}
                                keyboardType="numeric"
                                selectTextOnFocus
                              />
                            </View>
                            {(() => {
                              const totalAport = (d.Aportacion || 0) + (d.Rappel || 0) + (d.DescuentoExtra || 0);
                              return (
                                <>
                                  <Text style={[styles.detailTableCell, { width: 100, textAlign: 'center', fontWeight: '600' }]}>
                                    {((d.Cantidad || 0) * totalAport).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €
                                  </Text>
                                  <Text style={[styles.detailTableCell, { width: 100, textAlign: 'center', fontWeight: '600', color: '#16a34a' }]}>
                                    {((d.Compradas || 0) * totalAport).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €
                                  </Text>
                                </>
                              );
                            })()}
                            {Platform.OS === 'web' ? (
                              <WebDeleteBtn
                                productId={d.ProductId}
                                productName={d.ProductName || d.ProductId}
                                onDelete={removeProductoDetalle}
                                onConfirmDelete={confirmDelete}
                              />
                            ) : (
                              <Pressable
                                onPress={() => confirmDelete('Confirmar eliminación', `¿Quieres eliminar el producto "${d.ProductName || d.ProductId}" del acuerdo?`, () => removeProductoDetalle(d.ProductId))}
                                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                                style={({ pressed }) => ({
                                  width: 32, minWidth: 32, height: 32, alignItems: 'center', justifyContent: 'center', padding: 4,
                                  opacity: pressed ? 0.6 : 1,
                                })}
                              >
                                <MaterialIcons name="close" size={14} color="#ef4444" />
                              </Pressable>
                            )}
                          </View>
                        );
                      })}
                    </View>
                  </ScrollView>
                )}

                {/* Resumen */}
                {detalles.length > 0 && (
                  <View style={styles.detailResumen}>
                    <View style={styles.detailResumenRow}>
                      <Text style={styles.detailResumenLabel}>Productos asignados</Text>
                      <Text style={styles.detailResumenValue}>{detalles.length}</Text>
                    </View>
                    <View style={styles.detailResumenRow}>
                      <Text style={styles.detailResumenLabel}>Total acordado</Text>
                      <Text style={styles.detailResumenValue}>{totalAcordado.toLocaleString('es-ES')} uds.</Text>
                    </View>
                    <View style={styles.detailResumenRow}>
                      <Text style={styles.detailResumenLabel}>Total compradas</Text>
                      <Text style={[styles.detailResumenValue, { color: '#16a34a' }]}>{totalCompradas.toLocaleString('es-ES')} uds.</Text>
                    </View>
                    <View style={styles.detailResumenRow}>
                      <Text style={styles.detailResumenLabel}>Total restante</Text>
                      <Text style={[styles.detailResumenValue, { color: totalRestante > 0 ? '#ef4444' : totalRestante < 0 ? '#16a34a' : '#0f172a' }]}>{totalRestante > 0 ? `-${totalRestante.toLocaleString('es-ES')}` : totalRestante < 0 ? `+${Math.abs(totalRestante).toLocaleString('es-ES')}` : totalRestante.toLocaleString('es-ES')} uds.</Text>
                    </View>
                  </View>
                )}
              </View>

              {/* Sección Pagos por Imagen */}
              <View style={styles.detailProductsSection}>
                <View style={styles.detailProductsHeader}>
                  <Text style={styles.detailProductsSectionTitle}>Pagos por imagen</Text>
                  <TouchableOpacity style={styles.detailAddBtn} onPress={() => abrirImgModal()}>
                    <MaterialIcons name="add" size={14} color="#0ea5e9" />
                    <Text style={styles.detailAddBtnText}>Añadir</Text>
                  </TouchableOpacity>
                </View>

                {loadingPagos ? (
                  <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 12 }} />
                ) : pagosImagen.length === 0 ? (
                  <Text style={styles.detailEmpty}>Sin pagos por imagen registrados</Text>
                ) : (
                  <View style={{ gap: 8, marginTop: 8 }}>
                    {pagosImagen.map((p) => (
                      <View key={p.SK} style={styles.imgCard}>
                        {/* Línea 1: Acciones | Importe | Realizado | Botones */}
                        <View style={styles.imgCardLine1}>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, flex: 1 }}>
                            {p.Acciones.map((ac) => (
                              <View key={ac} style={styles.imgAccionBadge}>
                                <Text style={styles.imgAccionBadgeText}>{ac}</Text>
                              </View>
                            ))}
                          </View>
                          <Text style={styles.imgCardImporte}>{(p.Importe || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                          <TouchableOpacity
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 8 }}
                            onPress={async () => {
                              const newVal = !p.Realizado;
                              setPagosImagen((prev) => prev.map((x) => x.SK === p.SK ? { ...x, Realizado: newVal } : x));
                              try {
                                await fetch(`${API_URL}/api/acuerdos/${seleccionado!.PK}/imagen/${p.SK}`, {
                                  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ Realizado: newVal }),
                                });
                              } catch (_) {}
                            }}
                          >
                            <MaterialIcons name={p.Realizado ? 'check-box' : 'check-box-outline-blank'} size={18} color={p.Realizado ? '#16a34a' : '#94a3b8'} />
                            <Text style={{ fontSize: 11, color: p.Realizado ? '#16a34a' : '#94a3b8', fontWeight: '600' }}>Realizado</Text>
                          </TouchableOpacity>
                          <View style={{ flexDirection: 'row', gap: 4, marginLeft: 8 }}>
                            <TouchableOpacity onPress={() => abrirImgModal(p)} style={{ padding: 4 }}>
                              <MaterialIcons name="edit" size={14} color="#64748b" />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => eliminarPagoImagen(p.SK)} style={{ padding: 4 }}>
                              <MaterialIcons name="delete-outline" size={14} color="#ef4444" />
                            </TouchableOpacity>
                          </View>
                        </View>
                        {/* Línea 2: Locales */}
                        {p.Locales.length > 0 && (
                          <Text style={styles.imgCardLocales} numberOfLines={2}>{p.Locales.map((id) => localNombre(id)).join(', ')}</Text>
                        )}
                        {/* Línea 3: Descripción */}
                        {p.Descripcion ? (
                          <Text style={styles.imgCardDesc}>{p.Descripcion}</Text>
                        ) : null}
                        {p.Justificantes && p.Justificantes.length > 0 && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            <MaterialIcons name="attach-file" size={12} color="#64748b" />
                            <Text style={styles.imgCardLabel}>{p.Justificantes.length} archivo(s)</Text>
                          </View>
                        )}
                      </View>
                    ))}
                    <View style={styles.detailResumen}>
                      <View style={styles.detailResumenRow}>
                        <Text style={styles.detailResumenLabel}>Total imagen</Text>
                        <Text style={[styles.detailResumenValue, { color: '#0ea5e9' }]}>{totalImporteImagen.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</Text>
                      </View>
                    </View>
                  </View>
                )}
              </View>

              {/* Sección Documentos */}
              <View style={styles.detailProductsSection}>
                <View style={styles.detailProductsHeader}>
                  <Text style={styles.detailProductsSectionTitle}>Documentos</Text>
                  <TouchableOpacity style={styles.detailAddBtn} onPress={subirArchivo} disabled={subiendoArchivo}>
                    {subiendoArchivo ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <>
                        <MaterialIcons name="upload-file" size={14} color="#0ea5e9" />
                        <Text style={styles.detailAddBtnText}>Subir archivo</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                {loadingArchivos ? (
                  <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 12 }} />
                ) : archivos.length === 0 ? (
                  <Text style={styles.detailEmpty}>Sin documentos adjuntos</Text>
                ) : (
                  <View style={{ gap: 6, marginTop: 8 }}>
                    {archivos.map((f) => {
                      const isImage = /^image\//i.test(f.contentType || '');
                      const isPdf = /\/pdf$/i.test(f.contentType || '');
                      const sizeKB = f.size ? (f.size / 1024).toFixed(1) : '?';
                      return (
                        <View key={f.fileKey} style={styles.fileCard}>
                          {isImage && f.url && (
                            <TouchableOpacity onPress={() => { if (Platform.OS === 'web') window.open(f.url!, '_blank'); }}>
                              <img src={f.url} alt={f.fileName} style={{ width: 120, height: 80, objectFit: 'cover', borderRadius: 6, marginBottom: 4 } as any} />
                            </TouchableOpacity>
                          )}
                          <View style={styles.fileCardRow}>
                            <MaterialIcons name={isImage ? 'image' : isPdf ? 'picture-as-pdf' : 'insert-drive-file'} size={18} color={isImage ? '#0ea5e9' : isPdf ? '#ef4444' : '#64748b'} />
                            <View style={{ flex: 1, marginLeft: 6 }}>
                              <Text style={styles.fileCardName} numberOfLines={1}>{f.fileName}</Text>
                              <Text style={styles.fileCardMeta}>{sizeKB} KB · {f.uploadedAt ? new Date(f.uploadedAt).toLocaleDateString('es-ES') : ''}</Text>
                            </View>
                            <TouchableOpacity onPress={() => { if (Platform.OS === 'web' && f.url) window.open(f.url, '_blank'); }} style={{ padding: 4 }}>
                              <MaterialIcons name="open-in-new" size={16} color="#0ea5e9" />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => eliminarArchivo(f.fileKey)} style={{ padding: 4 }}>
                              <MaterialIcons name="delete-outline" size={16} color="#ef4444" />
                            </TouchableOpacity>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            </ScrollView>
          </View>
        )}
      </View>

      {/* Modal Tooltip Producto (web): nombre completo en la parte superior, sin recorte */}
      {Platform.OS === 'web' && (
        <Modal visible={!!productoTooltip} transparent animationType="fade">
          <Pressable style={{ flex: 1, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 16 }} onPress={() => setProductoTooltip(null)}>
            {productoTooltip ? (
              <View style={[tooltipStyles.bubble, { left: undefined, transform: undefined, maxWidth: 340, marginHorizontal: 20 }]}>
                <Text style={[tooltipStyles.text, { whiteSpace: 'normal' as any, textAlign: 'center' }]}>{productoTooltip.name}</Text>
              </View>
            ) : null}
          </Pressable>
        </Modal>
      )}

      {/* Modal Pago por Imagen */}
      <Modal visible={imgModalVisible} transparent animationType="fade">
        <Pressable style={styles.overlay} onPress={(e) => { if (e.target === e.currentTarget) setImgModalVisible(false); }}>
          <View style={[styles.modal, isCompact && { width: '95%' }]}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>{imgEditSK ? 'Editar Pago por Imagen' : 'Nuevo Pago por Imagen'}</Text>

              {/* Local (multiselección) */}
              <Text style={styles.label}>Local</Text>
              <TouchableOpacity style={styles.input} onPress={() => { setLocalSearch(''); setLocalDropdownOpen((o) => !o); }}>
                <Text style={imgForm.Locales.length > 0 ? styles.inputValueText : styles.inputPlaceholderText} numberOfLines={2}>
                  {imgForm.Locales.length > 0 ? imgForm.Locales.map((id) => localNombre(id)).join(', ') : 'Seleccionar locales…'}
                </Text>
              </TouchableOpacity>
              {localDropdownOpen && (
                <View style={styles.productoDropdown}>
                  <TextInput
                    style={[styles.input, { marginBottom: 0, borderWidth: 0, borderBottomWidth: 1, borderColor: '#e2e8f0' }]}
                    placeholder="Buscar local…"
                    placeholderTextColor="#94a3b8"
                    value={localSearch}
                    onChangeText={setLocalSearch}
                    autoFocus
                  />
                  <ScrollView style={{ maxHeight: 160 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                    {localesFiltrados.map((l) => {
                      const selected = imgForm.Locales.includes(l.id);
                      return (
                        <TouchableOpacity
                          key={l.id}
                          style={[styles.productoDropdownItem, selected && { backgroundColor: '#e0f2fe' }]}
                          onPress={() => {
                            setImgForm((f) => ({
                              ...f,
                              Locales: selected ? f.Locales.filter((x) => x !== l.id) : [...f.Locales, l.id],
                            }));
                          }}
                        >
                          <Text style={styles.productoDropdownItemText} numberOfLines={1}>
                            {selected ? '✓ ' : ''}{l.nombre || l.id}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}

              {/* Acción (multiselección) */}
              <Text style={styles.label}>Acción</Text>
              <TouchableOpacity style={styles.input} onPress={() => setAccionDropdownOpen((o) => !o)}>
                <Text style={imgForm.Acciones.length > 0 ? styles.inputValueText : styles.inputPlaceholderText} numberOfLines={2}>
                  {imgForm.Acciones.length > 0 ? imgForm.Acciones.join(', ') : 'Seleccionar acciones…'}
                </Text>
              </TouchableOpacity>
              {accionDropdownOpen && (
                <View style={styles.productoDropdown}>
                  <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                    {ACCIONES_IMAGEN.map((ac) => {
                      const selected = imgForm.Acciones.includes(ac);
                      return (
                        <TouchableOpacity
                          key={ac}
                          style={[styles.productoDropdownItem, selected && { backgroundColor: '#e0f2fe' }]}
                          onPress={() => {
                            setImgForm((f) => ({
                              ...f,
                              Acciones: selected ? f.Acciones.filter((x) => x !== ac) : [...f.Acciones, ac],
                            }));
                          }}
                        >
                          <Text style={styles.productoDropdownItemText}>{selected ? '✓ ' : ''}{ac}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}

              {/* Importe */}
              <Text style={styles.label}>Importe (€)</Text>
              <TextInput
                style={styles.input}
                value={imgForm.Importe}
                onChangeText={(v) => setImgForm((f) => ({ ...f, Importe: v }))}
                keyboardType="numeric"
                placeholder="0,00"
                placeholderTextColor="#94a3b8"
              />

              {/* Justificante (archivos) */}
              <Text style={styles.label}>Justificante</Text>
              <TouchableOpacity style={[styles.input, { flexDirection: 'row', alignItems: 'center', gap: 6 }]} onPress={handleFileSelect}>
                <MaterialIcons name="attach-file" size={16} color="#64748b" />
                <Text style={styles.inputPlaceholderText}>Adjuntar archivos…</Text>
              </TouchableOpacity>
              {imgFiles.length > 0 && (
                <View style={{ gap: 4, marginBottom: 12 }}>
                  {imgFiles.map((f, i) => (
                    <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 }}>
                      <MaterialIcons name="insert-drive-file" size={14} color="#64748b" />
                      <Text style={{ fontSize: 12, color: '#334155', flex: 1 }} numberOfLines={1}>{f.name}</Text>
                      <TouchableOpacity onPress={() => setImgFiles((prev) => prev.filter((_, idx) => idx !== i))}>
                        <MaterialIcons name="close" size={14} color="#ef4444" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}

              {/* Descripción */}
              <Text style={styles.label}>Descripción</Text>
              <TextInput
                style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
                value={imgForm.Descripcion}
                onChangeText={(v) => setImgForm((f) => ({ ...f, Descripcion: v }))}
                multiline
                placeholder="Descripción del pago…"
                placeholderTextColor="#94a3b8"
              />

              <View style={styles.modalBtns}>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setImgModalVisible(false)}>
                  <Text style={styles.cancelBtnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.saveBtn, guardandoImg && { opacity: 0.6 }]} onPress={guardarPagoImagen} disabled={guardandoImg}>
                  <Text style={styles.saveBtnText}>{guardandoImg ? 'Guardando…' : 'Guardar'}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      {/* Modal Crear/Editar */}
      <Modal visible={modalVisible} transparent animationType="fade">
        <Pressable style={styles.overlay} onPress={(e) => { if (e.target === e.currentTarget) setModalVisible(false); }}>
          <View style={[styles.modal, isCompact && { width: '95%' }]}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>{editId ? 'Editar Acuerdo' : 'Nuevo Acuerdo'}</Text>

              <Text style={styles.label}>Identificador (PK) *</Text>
              <TextInput style={[styles.input, styles.inputReadonly]} value={formPK} editable={false} selectTextOnFocus={false} />

              <Text style={styles.label}>Nombre del acuerdo</Text>
              <TextInput style={styles.input} value={form.Nombre} onChangeText={(v) => setForm((f) => ({ ...f, Nombre: v }))} placeholder="Ej: Acuerdo Coca-Cola 2025" placeholderTextColor="#94a3b8" />

              <Text style={styles.label}>Marca</Text>
              <TouchableOpacity style={styles.input} onPress={() => { setMarcaSearch(''); setMarcaDropdownOpen((o) => !o); }}>
                <Text style={form.Marca ? styles.inputValueText : styles.inputPlaceholderText}>{form.Marca || 'Seleccionar marca…'}</Text>
              </TouchableOpacity>
              {marcaDropdownOpen && (
                <View style={styles.productoDropdown}>
                  <View style={styles.productoDropdownSearch}>
                    <MaterialIcons name="search" size={16} color="#94a3b8" />
                    <TextInput style={styles.productoDropdownInput} value={marcaSearch} onChangeText={setMarcaSearch} placeholder="Buscar empresa…" placeholderTextColor="#94a3b8" autoFocus />
                    <TouchableOpacity onPress={() => setMarcaDropdownOpen(false)}><MaterialIcons name="close" size={16} color="#94a3b8" /></TouchableOpacity>
                  </View>
                  <ScrollView style={styles.productoDropdownList} keyboardShouldPersistTaps="handled">
                    {loadingEmpresas ? <ActivityIndicator size="small" color="#0ea5e9" style={{ padding: 12 }} /> : (
                      empresasFiltradas.length === 0 ? <Text style={styles.productoDropdownEmpty}>Sin resultados</Text> :
                      empresasFiltradas.map((e, i) => {
                        const alias = String(e.Alias || e.Nombre || '');
                        return (
                          <TouchableOpacity key={String(e.CIF || e.Id || i)} style={styles.productoDropdownItem} onPress={() => { setForm((f) => ({ ...f, Marca: alias })); setMarcaDropdownOpen(false); }}>
                            <Text style={styles.productoDropdownItemText} numberOfLines={1}>{alias}</Text>
                          </TouchableOpacity>
                        );
                      })
                    )}
                  </ScrollView>
                </View>
              )}

              <View style={styles.row2}>
                <View style={styles.row2col}>
                  <Text style={styles.label}>Fecha inicio</Text>
                  <TextInput style={styles.input} value={form.FechaInicio} onChangeText={(v) => setForm((f) => ({ ...f, FechaInicio: v }))} placeholder="AAAA-MM-DD" placeholderTextColor="#94a3b8" />
                </View>
                <View style={styles.row2col}>
                  <Text style={styles.label}>Fecha fin</Text>
                  <TextInput style={styles.input} value={form.FechaFin} onChangeText={(v) => setForm((f) => ({ ...f, FechaFin: v }))} placeholder="AAAA-MM-DD" placeholderTextColor="#94a3b8" />
                </View>
              </View>

              <Text style={styles.label}>Contacto</Text>
              <TextInput style={styles.input} value={form.Contacto} onChangeText={(v) => setForm((f) => ({ ...f, Contacto: v }))} placeholder="Nombre del contacto" placeholderTextColor="#94a3b8" />

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Teléfono</Text>
                  <TextInput style={styles.input} value={form.Telefono} onChangeText={(v) => setForm((f) => ({ ...f, Telefono: v }))} placeholder="Ej: 612345678" placeholderTextColor="#94a3b8" keyboardType="phone-pad" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Email</Text>
                  <TextInput style={styles.input} value={form.Email} onChangeText={(v) => setForm((f) => ({ ...f, Email: v }))} placeholder="email@ejemplo.com" placeholderTextColor="#94a3b8" keyboardType="email-address" autoCapitalize="none" />
                </View>
              </View>

              <Text style={styles.label}>Estado</Text>
              <View style={styles.estadoRow}>
                {ESTADOS.map((e) => (
                  <TouchableOpacity key={e} style={[styles.estadoChip, form.Estado === e && styles.estadoChipActive]} onPress={() => setForm((f) => ({ ...f, Estado: e }))}>
                    <Text style={[styles.estadoChipText, form.Estado === e && styles.estadoChipTextActive]}>{e}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.label}>Notas</Text>
              <TextInput style={[styles.input, styles.inputMultiline]} value={form.Notas} onChangeText={(v) => setForm((f) => ({ ...f, Notas: v }))} multiline numberOfLines={3} placeholder="Observaciones…" placeholderTextColor="#94a3b8" />

              <View style={styles.modalBtns}>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setModalVisible(false)}>
                  <Text style={styles.cancelBtnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveBtn} onPress={guardar} disabled={guardando || !formPK.trim()}>
                  {guardando ? <ActivityIndicator size="small" color="#fff" /> : <MaterialIcons name="check" size={18} color="#fff" />}
                  <Text style={styles.saveBtnText}>{guardando ? 'Guardando…' : 'Guardar'}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  splitContainer: { flex: 1, flexDirection: 'row' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', gap: 12 },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: '#0f172a' },
  createBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: '#0ea5e9' },
  createBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  errorBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 16, marginTop: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fecaca' },
  errorText: { fontSize: 12, color: '#dc2626', flex: 1 },
  list: { flex: 1 },
  listContent: { padding: 16, gap: 12 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },

  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  cardSelected: { borderColor: '#0ea5e9', borderWidth: 2 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  cardActions: { flexDirection: 'row', gap: 4 },
  cardActionBtn: { padding: 6 },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  cardBodyWithDonut: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  cardBodyInfo: { flex: 1, gap: 6 },
  miniDonutPlaceholder: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  cardField: { minWidth: 120, marginRight: 16 },
  cardFieldLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 2 },
  cardFieldValue: { fontSize: 13, color: '#334155' },
  cardNotas: { fontSize: 12, color: '#64748b', fontStyle: 'italic', paddingHorizontal: 16, paddingBottom: 10 },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  modal: { backgroundColor: '#fff', borderRadius: 14, width: '90%', maxWidth: 560, maxHeight: '90%', padding: 20 },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a', marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 4, marginTop: 10 },
  input: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: '#334155' },
  inputReadonly: { backgroundColor: '#e2e8f0', color: '#64748b' },
  inputValueText: { fontSize: 14, color: '#334155' },
  inputPlaceholderText: { fontSize: 14, color: '#94a3b8' },
  inputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  row2: { flexDirection: 'row', gap: 10 },
  row2col: { flex: 1 },
  estadoRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  estadoChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  estadoChipActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  estadoChipText: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  estadoChipTextActive: { color: '#fff' },

  productoDropdown: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, marginTop: 4, maxHeight: 220, overflow: 'hidden' },
  productoDropdownSearch: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  productoDropdownInput: { flex: 1, fontSize: 13, color: '#334155', outlineStyle: 'none' as any },
  productoDropdownList: { maxHeight: 170 },
  productoDropdownEmpty: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', padding: 12, textAlign: 'center' },
  productoDropdownItem: { paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#f1f5f9', flexDirection: 'row', alignItems: 'center' },
  detailProdDropdown: { maxHeight: 160 },
  detailProdDropdownSearch: { paddingVertical: 4, paddingHorizontal: 8 },
  detailProdDropdownInput: { fontSize: 11 },
  detailProdDropdownList: { maxHeight: 120 },
  detailProdDropdownEmpty: { fontSize: 11, padding: 8 },
  detailProdDropdownItem: { paddingVertical: 5, paddingHorizontal: 8 },
  detailProdDropdownItemText: { fontSize: 11 },
  productoDropdownItemDisabled: { opacity: 0.4 },
  productoDropdownItemText: { fontSize: 13, color: '#334155', flex: 1 },

  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
  cancelBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#f1f5f9' },
  cancelBtnText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#0ea5e9' },
  saveBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },


  detailPanel: { flex: 3, backgroundColor: '#fff', borderLeftWidth: 1, borderLeftColor: '#e2e8f0' },
  detailPanelCompact: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 400, zIndex: 50, shadowColor: '#000', shadowOffset: { width: -2, height: 0 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 8 },
  detailPanelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  detailPanelTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  detailPanelCountdown: { fontSize: 12, color: '#64748b', marginTop: 2 },
  detailInfoSection: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  detailInfoColumns: { flexDirection: 'row', gap: 16 },
  detailInfoLeft: { flex: 1, minWidth: 200 },
  detailInfoRight: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  detailInfoRow: { flexDirection: 'row', marginBottom: 6 },
  detailInfoLabel: { width: 70, fontSize: 11, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', paddingTop: 2 },
  detailInfoValue: { flex: 1, fontSize: 13, color: '#334155' },
  detailInfoConcat: { fontSize: 12, fontStyle: 'italic', color: '#64748b', marginTop: 6 },
  totalCard: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, padding: 8 },
  totalCardTitle: { fontSize: 9, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: 1 },
  totalCardValue: { fontSize: 15, fontWeight: '800', color: '#0f172a', marginBottom: 4 },
  totalCardSub: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  totalCardSubLabel: { fontSize: 11, color: '#94a3b8' },
  totalCardSubValue: { fontSize: 11, fontWeight: '600', color: '#334155' },
  detailProductsSection: { paddingBottom: 14 },
  detailProductsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10 },
  detailProductsSectionTitle: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  detailAddBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: '#0ea5e9', borderStyle: 'dashed' },
  detailAddBtnText: { fontSize: 11, color: '#0ea5e9', fontWeight: '600' },
  detailEmpty: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', textAlign: 'center', marginTop: 24, paddingHorizontal: 14 },
  detailTableScroll: { marginHorizontal: 14 },
  detailTableWrap: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', minWidth: 1018 },
  detailTableHeader: { flexDirection: 'row', backgroundColor: '#f8fafc', paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  detailTableHeaderText: { fontSize: 9, fontWeight: '700', color: '#475569', textTransform: 'uppercase' },
  detailTableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  detailTableCell: { fontSize: 10, color: '#334155' },
  cantidadInput: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, fontSize: 11, color: '#334155', textAlign: 'center', width: 70 },
  detailResumen: { marginHorizontal: 14, marginTop: 12, backgroundColor: '#f0f9ff', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: '#bae6fd' },
  detailResumenRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  detailResumenLabel: { fontSize: 12, color: '#0369a1', fontWeight: '500' },
  detailResumenValue: { fontSize: 14, color: '#0f172a', fontWeight: '700' },
  imgCard: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, padding: 10 },
  imgCardLine1: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  imgCardLocales: { fontSize: 12, color: '#334155', marginBottom: 2 },
  imgCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  imgCardImporte: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  imgCardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 4 },
  imgCardLabel: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  imgCardValue: { fontSize: 12, color: '#334155', flex: 1 },
  imgCardDesc: { fontSize: 12, color: '#475569', fontStyle: 'italic', marginTop: 4 },
  imgAccionBadge: { backgroundColor: '#e0f2fe', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  imgAccionBadgeText: { fontSize: 10, color: '#0369a1', fontWeight: '600' },
  fileCard: { backgroundColor: '#f8fafc', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0', padding: 8 },
  fileCardRow: { flexDirection: 'row', alignItems: 'center' },
  fileCardName: { fontSize: 12, fontWeight: '600', color: '#1e293b' },
  fileCardMeta: { fontSize: 10, color: '#94a3b8', marginTop: 1 },
});
