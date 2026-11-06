/**
 * Conteo de stock máximo: importar el Excel, calcular y ajustar líneas.
 * Los cambios se quedan en la fila hasta pulsar Guardar.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { useConfirmar } from '../../../hooks/useConfirmar';
import { apiFetch } from '../../../utils/api';
import { formatCreadoEn, formatFecha } from '../../../utils/formatFecha';
import { fechaJornadaNegocioIso } from '../../../lib/jornadaNegocio';
import { CampoSelector } from '../../../components/mia/CampoSelector';
import { SelectorDesplegableMulti } from '../../../components/SelectorDesplegableMulti';
import { SelectorDiasRango } from '../../../components/prevision/SelectorDiasRango';
import { altoControl, colores, familia, modoPrevision, peso } from '../../../components/prevision/tokens';
import {
  ConteoEditor,
  claveLinea,
  type BorradorLinea,
  type LineaConteo,
  type PedidoProveedor,
} from '../../../components/mia/ConteoEditor';
import { descargarPdfPedido, descargarZipPedidos, type PedidoPdf } from '../../../lib/miaPedidoPdf';
import { MIN_TOUCH, SPACING } from '../../../constants/layout';

type Almacen = { id: string; nombre: string };
type LocalPrevision = { id: string; nombre: string };
type ConteoResumen = {
  informeId: string;
  creadoEn: string | null;
  ficheroNombre: string | null;
  estado: string;
  multiplicador: number | null;
  semanasDesde?: string | null;
  semanasHasta?: string | null;
  rangoDesde?: string | null;
  rangoHasta?: string | null;
};
type Conteo = {
  informeId: string;
  creadoEn: string | null;
  ficheroNombre: string | null;
  multiplicador: number | null;
  previsionImporte: number | null;
  previsionAviso: string | null;
  rangoDesde: string | null;
  rangoHasta: string | null;
  semanasDesde: string | null;
  semanasHasta: string | null;
  desconocidos: string[];
  duplicados: string[];
  sinContar: { productId: string; nombre: string }[];
  lineasContadas: number;
  estado: string;
  editable: boolean;
  calculadoEn?: string | null;
  motivosRecalculo?: string[];
  pedidos: PedidoProveedor[];
  proveedores: { proveedorId: string; proveedorNombre: string }[];
  lineas: LineaConteo[];
};

type ConsultaLinea = {
  productId: string;
  proveedorId?: string;
  cantidadPedida: number | null;
  maximoFinal: number | null;
  purchaseUnitId?: string;
  unit?: string;
  aviso: string | null;
};

function textoMotivo(motivo: string) {
  if (motivo === 'sin_calcular') return 'sin calcular';
  if (motivo === 'tramos') return 'tramos cambiados';
  if (motivo === 'consulta') return 'rango o locales cambiados';
  if (motivo.startsWith('fichas:')) {
    const n = Number(motivo.slice(7)) || 0;
    return `${n} ficha${n === 1 ? '' : 's'} de stock máximo cambiada${n === 1 ? '' : 's'}`;
  }
  return motivo;
}
type Consulta = {
  informeId: string;
  multiplicador: number | null;
  previsionImporte: number | null;
  previsionAviso: string | null;
  lineas: ConsultaLinea[];
};
const TEXTO = '#0f172a';
const SECUNDARIO = '#64748b';
const ROSA = '#ec4899';
const ESTADO: Record<string, string> = {
  generado: 'Generado',
  enviando: 'Enviando',
  pedido: 'Pedido',
  confirmado: 'Confirmado',
  mixto: 'Mixto',
};
const ESTADO_CORTO: Record<string, string> = {
  generado: 'Bor',
  enviando: 'Env',
  pedido: 'Ped',
  confirmado: 'Conf',
  mixto: 'Mix',
};
const COLOR_ESTADO: Record<string, string> = {
  generado: '#64748b',
  enviando: '#d97706',
  pedido: '#0ea5e9',
  confirmado: '#16a34a',
  mixto: '#a855f7',
};

function canon(texto: string) {
  const t = texto.trim().replace(',', '.');
  if (!t) return '';
  const n = Number(t);
  return Number.isFinite(n) ? String(n) : t;
}

function esMultiplo(qty: number, formato: number) {
  const texto = String(formato);
  const coma = texto.indexOf('.');
  const decimales = coma < 0 ? 0 : Math.min(6, texto.length - coma - 1);
  const escala = 10 ** decimales;
  const paso = Math.round(formato * escala);
  return paso > 0 && Math.round(qty * escala) % paso === 0;
}

function errorCantidad(texto: string, formato: number | null) {
  const t = canon(texto);
  if (!texto.trim()) return 'La cantidad tiene que ser un número ≥ 0';
  if (texto.trim().startsWith('-')) return 'La cantidad no puede ser negativa';
  if (!/^\d+(\.\d+)?$/.test(t)) return 'La cantidad tiene que ser un número ≥ 0';
  if (formato != null && formato > 0 && !esMultiplo(Number(t), formato)) {
    return 'La cantidad tiene que ser un múltiplo del formato de compra';
  }
  return '';
}

function errorMaximo(texto: string) {
  const bruto = texto.trim();
  if (!bruto) return '';
  if (bruto.startsWith('-')) return 'El máximo final no puede ser negativo';
  const t = canon(bruto);
  if (!/^\d+(\.\d+)?$/.test(t)) return 'El máximo final tiene que ser un número ≥ 0';
  return '';
}

function identidadDe(linea: LineaConteo) {
  return {
    proveedorId: linea.proveedorId || 'SIN_PROVEEDOR',
    proveedorNombre: linea.proveedorNombre || '',
    purchaseUnitId: linea.purchaseUnitId || '',
    unit: linea.unit || '',
  };
}

function baseDe(linea: LineaConteo): BorradorLinea {
  return {
    cantidad: linea.cantidadPedida == null ? '' : String(linea.cantidadPedida),
    maximo: linea.maximoFinal == null ? '' : String(linea.maximoFinal),
    omitida: linea.omitida,
    ...identidadDe(linea),
  };
}

function calculadaDe(linea: LineaConteo): BorradorLinea {
  return {
    cantidad: String(linea.cantidadCalculada ?? 0),
    maximo: linea.maximoCalculado == null ? '' : String(linea.maximoCalculado),
    omitida: false,
    ...identidadDe(linea),
  };
}

function diaMadrid(iso: string | null) {
  const fecha = iso ? new Date(iso) : new Date();
  const base = Number.isNaN(fecha.getTime()) ? new Date() : fecha;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(base);
}

function igual(a: BorradorLinea, b: BorradorLinea) {
  return canon(a.cantidad) === canon(b.cantidad)
    && canon(a.maximo) === canon(b.maximo)
    && a.omitida === b.omitida
    && a.proveedorId === b.proveedorId
    && a.purchaseUnitId === b.purchaseUnitId
    && a.unit === b.unit;
}

function unidadesDe(b: BorradorLinea) {
  if (b.omitida) return 0;
  const t = canon(b.cantidad);
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : 0;
}

function formatoUnidades(n: number) {
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 4 }).format(n);
}

function parametro(valor: string | string[] | undefined) {
  return Array.isArray(valor) ? valor[0] || '' : valor || '';
}

/** El rango que usó el cálculo y, si aún no se ha calculado, el elegido al importar. */
function textoRango(c: ConteoResumen) {
  const desde = c.rangoDesde || c.semanasDesde;
  const hasta = c.rangoHasta || c.semanasHasta;
  if (!desde && !hasta) return 'Sin rango';
  return `${formatFecha(desde)} – ${formatFecha(hasta)}`;
}

function elegirAlmacen(lista: { id: string }[], pedido: string) {
  if (pedido && lista.some((a) => a.id === pedido)) return pedido;
  return lista[0]?.id ?? '';
}

export default function ConteoScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const almacenPedido = parametro(useLocalSearchParams<{ warehouseId?: string }>().warehouseId);
  const { hasPermiso } = useAuth();
  const { isPhone, isTablet, shouldStackToolbar, width } = useBreakpoint();
  const altoBoton = isPhone || isTablet ? MIN_TOUCH : 36;
  const alto = altoControl(modoPrevision(width));
  const { confirmar, ConfirmarView } = useConfirmar();
  const puedeVer = hasPermiso('mia.ver');
  const puedeCalcular = hasPermiso('mia.calcular');
  const puedeAprobar = hasPermiso('mia.aprobar');
  const puedeConfirmar = hasPermiso('mia.confirmar_agora');

  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [conteos, setConteos] = useState<ConteoResumen[]>([]);
  const [informeId, setInformeId] = useState('');
  const [conteo, setConteo] = useState<Conteo | null>(null);
  const [borradores, setBorradores] = useState<Record<string, BorradorLinea>>({});
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [localesPrevision, setLocalesPrevision] = useState<LocalPrevision[]>([]);
  const [localesSel, setLocalesSel] = useState<string[]>([]);
  const [localesListos, setLocalesListos] = useState(false);
  const [semanasDesde, setSemanasDesde] = useState('');
  const [semanasHasta, setSemanasHasta] = useState('');
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [borrandoId, setBorrandoId] = useState<string | null>(null);
  const borrando = borrandoId != null;
  const [importando, setImportando] = useState(false);
  const [aprobando, setAprobando] = useState(false);
  const [descargando, setDescargando] = useState(false);
  const [comprobando, setComprobando] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [consulta, setConsulta] = useState<Consulta | null>(null);
  const [consultando, setConsultando] = useState(false);
  const [avisoPrevisionAbierto, setAvisoPrevisionAbierto] = useState(false);
  const salirLibre = useRef(false);
  const omitidos = useRef(new Set<string>());
  const modoNuevo = useRef(false);
  const [filtroEstado, setFiltroEstado] = useState('todos');
  const sucioRef = useRef(false);
  const peticion = useRef(0);
  const consultaToken = useRef(0);

  const sucio = Object.keys(borradores).length;
  sucioRef.current = sucio > 0;

  useEffect(() => {
    if (!puedeVer) return;
    let vivo = true;
    apiFetch('/api/mia/locales-almacenes')
      .then((r) => r.json())
      .then((data) => {
        if (!vivo) return;
        const lista: Almacen[] = (data.almacenes || []).map((a: Almacen) => ({
          id: String(a.id),
          nombre: String(a.nombre || a.id),
        }));
        lista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        setAlmacenes(lista);
        setWarehouseId((prev) => prev || elegirAlmacen(lista, almacenPedido));
      })
      .catch(() => {
        if (vivo) setError('No se pudieron cargar los almacenes');
      });
    return () => {
      vivo = false;
    };
  }, [puedeVer, almacenPedido]);

  useEffect(() => {
    if (!puedeVer) return;
    let vivo = true;
    apiFetch('/api/mia/locales-prevision')
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!vivo) return;
        if (!ok || !Array.isArray(data.locales)) {
          setError(data.error || 'No se pudieron cargar los locales de la previsión');
          return;
        }
        const lista: LocalPrevision[] = data.locales.map((l: LocalPrevision) => ({
          id: String(l.id),
          nombre: String(l.nombre || l.id),
        }));
        setLocalesPrevision(lista);
        setLocalesSel(lista.map((l) => l.id));
        setLocalesListos(true);
      })
      .catch(() => {
        if (vivo) setError('No se pudieron cargar los locales de la previsión');
      });
    return () => {
      vivo = false;
    };
  }, [puedeVer]);

  const cargarLista = useCallback(async (almacen: string) => {
    if (!almacen) return;
    const r = await apiFetch(`/api/mia/conteos?warehouseId=${encodeURIComponent(almacen)}`);
    const data = await r.json();
    if (!r.ok) {
      setError(data.error || 'No se pudieron cargar los conteos');
      setConteos([]);
      return;
    }
    const lista: ConteoResumen[] = Array.isArray(data.conteos) ? data.conteos : [];
    const visibles = lista.filter((c) => !omitidos.current.has(String(c.informeId || '')));
    setConteos(visibles);
    setInformeId((prev) => {
      if (prev && visibles.some((c) => c.informeId === prev)) return prev;
      if (modoNuevo.current) return '';
      return visibles[0] ? String(visibles[0].informeId) : '';
    });
    if (visibles.length === 0) {
      setConteo(null);
      setBorradores({});
    }
  }, []);

  const cargarConteo = useCallback(async (id: string) => {
    const token = ++peticion.current;
    setCargando(true);
    setError('');
    setErrores({});
    try {
      const r = await apiFetch(`/api/mia/conteos/${encodeURIComponent(id)}`);
      const data = await r.json();
      if (token !== peticion.current) return;
      if (!r.ok) {
        setError(data.error || 'No se pudo cargar el conteo');
        setConteo(null);
        return;
      }
      setConteo(data);
      setBorradores({});
      setSemanasDesde(String(data.rangoDesde || data.semanasDesde || '').slice(0, 10));
      setSemanasHasta(String(data.rangoHasta || data.semanasHasta || '').slice(0, 10));
    } catch {
      if (token === peticion.current) setError('No se pudo cargar el conteo');
    } finally {
      if (token === peticion.current) setCargando(false);
    }
  }, []);

  useEffect(() => {
    if (!puedeVer || !warehouseId) return;
    modoNuevo.current = false;
    setInformeId('');
    setConteo(null);
    setBorradores({});
    void cargarLista(warehouseId);
  }, [puedeVer, warehouseId, cargarLista]);

  useEffect(() => {
    if (!informeId) return;
    setConsulta(null);
    void cargarConteo(informeId);
  }, [informeId, cargarConteo]);

  useEffect(() => {
    if (!puedeCalcular || !conteo || !localesListos || sucio > 0) {
      setConsulta(null);
      setConsultando(false);
      return undefined;
    }
    const guardadoDesde = conteo.rangoDesde || conteo.semanasDesde || '';
    const guardadoHasta = conteo.rangoHasta || conteo.semanasHasta || '';
    const fechasDistintas = Boolean(
      semanasDesde && semanasHasta
      && (semanasDesde !== guardadoDesde || semanasHasta !== guardadoHasta),
    );
    const todos = localesPrevision.map((l) => l.id).sort().join(',');
    const elegidos = [...localesSel].sort().join(',');
    const localesDistintos = elegidos !== todos;
    if (!fechasDistintas && !localesDistintos) {
      setConsulta(null);
      setConsultando(false);
      return undefined;
    }
    const token = ++consultaToken.current;
    const timer = setTimeout(() => {
      void (async () => {
        setConsultando(true);
        try {
          const cuerpo: { localIds: string[]; semanasDesde?: string; semanasHasta?: string } = {
            localIds: localesSel,
          };
          if (semanasDesde && semanasHasta) {
            cuerpo.semanasDesde = semanasDesde;
            cuerpo.semanasHasta = semanasHasta;
          }
          const r = await apiFetch(`/api/mia/conteos/${encodeURIComponent(conteo.informeId)}/simular`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cuerpo),
          });
          const data = await r.json();
          if (token !== consultaToken.current) return;
          if (!r.ok) {
            setConsulta(null);
            setError(data.error || 'No se pudo consultar la previsión');
            return;
          }
          setConsulta({
            informeId: conteo.informeId,
            multiplicador: data.multiplicador == null ? null : Number(data.multiplicador),
            previsionImporte: data.previsionImporte == null ? null : Number(data.previsionImporte),
            previsionAviso: data.previsionAviso || null,
            lineas: Array.isArray(data.lineas) ? data.lineas : [],
          });
        } catch {
          if (token === consultaToken.current) {
            setConsulta(null);
            setError('No se pudo consultar la previsión');
          }
        } finally {
          if (token === consultaToken.current) setConsultando(false);
        }
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [
    puedeCalcular,
    conteo,
    localesListos,
    localesPrevision,
    localesSel,
    semanasDesde,
    semanasHasta,
    sucio,
  ]);

  useEffect(() => {
    if (Platform.OS !== 'web' || sucio === 0) return undefined;
    const fn = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
      ev.returnValue = '';
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [sucio]);

  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e: { preventDefault: () => void; data: { action: unknown } }) => {
      if (salirLibre.current || !sucioRef.current) return;
      e.preventDefault();
      void (async () => {
        const ok = await confirmar(
          'Cambios sin guardar',
          'Hay líneas del conteo sin guardar. ¿Salir sin guardarlas?',
          { confirmarLabel: 'Salir sin guardar', variant: 'danger' },
        );
        if (!ok) return;
        salirLibre.current = true;
        navigation.dispatch(e.data.action as never);
      })();
    });
    return sub;
  }, [navigation, confirmar]);

  const confirmarSiSucio = useCallback(async (mensaje: string) => {
    if (!sucioRef.current) return true;
    return confirmar('Cambios sin guardar', mensaje, { confirmarLabel: 'Continuar', variant: 'danger' });
  }, [confirmar]);

  const pedirAlmacen = useCallback(async (id: string) => {
    if (id === warehouseId) return;
    const ok = await confirmarSiSucio('Si cambias de almacén se pierden las líneas sin guardar.');
    if (!ok) return;
    setAviso('');
    setWarehouseId(id);
  }, [warehouseId, confirmarSiSucio]);

  const abrirConteo = useCallback(async (id: string) => {
    if (id === informeId) return;
    const ok = await confirmarSiSucio('Si abres otro conteo se pierden las líneas sin guardar.');
    if (!ok) return;
    modoNuevo.current = false;
    setAviso('');
    setInformeId(id);
  }, [informeId, confirmarSiSucio]);

  const nuevoConteo = useCallback(async () => {
    const ok = await confirmarSiSucio('Si empiezas un conteo nuevo se pierden las líneas sin guardar.');
    if (!ok) return;
    modoNuevo.current = true;
    peticion.current += 1;
    setInformeId('');
    setConteo(null);
    setBorradores({});
    setConsulta(null);
    setCargando(false);
    setSemanasDesde('');
    setSemanasHasta('');
    setError('');
    setAviso('Conteo nuevo: elige las semanas e importa el Excel.');
  }, [confirmarSiSucio]);

  const onCambio = useCallback((clave: string, campo: 'cantidad' | 'maximo', valor: string) => {
    setAviso('');
    setErrores((prev) => {
      if (!prev[clave]) return prev;
      const copia = { ...prev };
      delete copia[clave];
      return copia;
    });
    setBorradores((prev) => {
      const linea = conteo?.lineas.find((ln) => claveLinea(ln) === clave);
      if (!linea) return prev;
      const actual = prev[clave] ?? baseDe(linea);
      const siguiente = { ...actual, [campo]: valor };
      const copia = { ...prev };
      if (igual(siguiente, baseDe(linea))) delete copia[clave];
      else copia[clave] = siguiente;
      return copia;
    });
  }, [conteo]);

  const onElegir = useCallback((clave: string, campo: 'proveedor' | 'unidad', id: string, nombre: string) => {
    setAviso('');
    setBorradores((prev) => {
      const linea = conteo?.lineas.find((ln) => claveLinea(ln) === clave);
      if (!linea) return prev;
      const actual = prev[clave] ?? baseDe(linea);
      const siguiente = campo === 'proveedor'
        ? { ...actual, proveedorId: id || 'SIN_PROVEEDOR', proveedorNombre: nombre }
        : { ...actual, purchaseUnitId: id, unit: nombre || id };
      const copia = { ...prev };
      if (igual(siguiente, baseDe(linea))) delete copia[clave];
      else copia[clave] = siguiente;
      return copia;
    });
  }, [conteo]);

  const onQuitar = useCallback((clave: string) => {
    setAviso('');
    setBorradores((prev) => {
      const linea = conteo?.lineas.find((ln) => claveLinea(ln) === clave);
      if (!linea) return prev;
      const actual = prev[clave] ?? baseDe(linea);
      const siguiente = { ...actual, omitida: true, cantidad: '0' };
      const copia = { ...prev };
      if (igual(siguiente, baseDe(linea))) delete copia[clave];
      else copia[clave] = siguiente;
      return copia;
    });
  }, [conteo]);

  const onRestaurar = useCallback((clave: string) => {
    setAviso('');
    setErrores((prev) => {
      if (!prev[clave]) return prev;
      const copia = { ...prev };
      delete copia[clave];
      return copia;
    });
    setBorradores((prev) => {
      const linea = conteo?.lineas.find((ln) => claveLinea(ln) === clave);
      if (!linea) return prev;
      const siguiente = calculadaDe(linea);
      const copia = { ...prev };
      if (igual(siguiente, baseDe(linea))) delete copia[clave];
      else copia[clave] = siguiente;
      return copia;
    });
  }, [conteo]);

  const erroresVista = useMemo(() => {
    const out = { ...errores };
    if (!conteo) return out;
    for (const [clave, b] of Object.entries(borradores)) {
      const linea = conteo.lineas.find((ln) => claveLinea(ln) === clave);
      if (!linea || b.omitida) continue;
      const msg = errorCantidad(b.cantidad, linea.formatoCompra) || errorMaximo(b.maximo);
      if (msg) out[clave] = msg;
    }
    return out;
  }, [errores, borradores, conteo]);

  const guardar = useCallback(async () => {
    if (!conteo || sucio === 0 || Object.keys(erroresVista).length > 0) return;
    setGuardando(true);
    setError('');
    setAviso('');
    const claves = Object.keys(borradores);
    try {
      const lineas = claves.map((clave) => {
        const linea = conteo.lineas.find((ln) => claveLinea(ln) === clave);
        const b = borradores[clave];
        const maximoCalculado = linea?.maximoCalculado == null ? '' : String(linea.maximoCalculado);
        const cantidadCalculada = String(linea?.cantidadCalculada ?? 0);
        const cambiaProveedor = !!linea && b.proveedorId !== (linea.proveedorId || 'SIN_PROVEEDOR');
        const cambiaUnidad = !!linea && (
          (b.purchaseUnitId || '') !== (linea.purchaseUnitId || '')
          || (b.unit || '') !== (linea.unit || '')
        );
        return {
          productId: linea?.productId,
          proveedorId: linea?.proveedorId,
          omitida: b.omitida,
          cantidadManual: !b.omitida && canon(b.cantidad) !== canon(cantidadCalculada),
          cantidadPedida: b.cantidad.trim().replace(',', '.'),
          maximoManual: canon(b.maximo) !== canon(maximoCalculado) && b.maximo.trim() !== '',
          maximoFinal: b.maximo.trim() === '' ? null : b.maximo.trim().replace(',', '.'),
          ...(cambiaProveedor ? {
            proveedorManual: true,
            proveedorDestino: b.proveedorId,
            proveedorNombre: b.proveedorNombre || b.proveedorId,
          } : {}),
          ...(cambiaUnidad ? {
            unidadManual: true,
            purchaseUnitId: b.purchaseUnitId,
            unit: b.unit || b.purchaseUnitId,
          } : {}),
        };
      });
      const r = await apiFetch(`/api/mia/conteos/${encodeURIComponent(conteo.informeId)}/lineas`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineas }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (Number.isInteger(data.indice) && claves[data.indice]) {
          setErrores({ [claves[data.indice]]: data.error || 'Revisa esta línea' });
        } else {
          setError(data.error || 'No se pudieron guardar las líneas');
        }
        return;
      }
      setConteo(data);
      setBorradores({});
      setAviso(`Guardadas ${claves.length} líneas`);
      void cargarLista(warehouseId);
    } catch {
      setError('No se pudieron guardar las líneas');
    } finally {
      setGuardando(false);
    }
  }, [conteo, sucio, erroresVista, borradores, warehouseId, cargarLista]);

  const borrarConteo = useCallback(async (id: string) => {
    if (borrando) return;
    const ok = await confirmar(
      'Borrar conteo',
      'Se borra este conteo y sus pedidos en Generado. No se toca Ágora.',
      { confirmarLabel: 'Borrar', variant: 'danger' },
    );
    if (!ok) return;
    setBorrandoId(id);
    setError('');
    setAviso('');
    try {
      const r = await apiFetch(`/api/mia/conteos/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error || 'No se pudo borrar el conteo');
        return;
      }
      omitidos.current.add(id);
      setConteos((prev) => prev.filter((c) => c.informeId !== id));
      if (conteo?.informeId === id) {
        setBorradores({});
        setConteo(null);
        setInformeId('');
      }
      setAviso('Conteo borrado');
      await cargarLista(warehouseId);
    } catch {
      setError('No se pudo borrar el conteo');
    } finally {
      setBorrandoId(null);
    }
  }, [conteo, borrando, confirmar, cargarLista, warehouseId]);

  const importar = useCallback(async () => {
    if (!warehouseId) return;
    const ok = await confirmarSiSucio('Si importas un conteo nuevo se pierden las líneas sin guardar.');
    if (!ok) return;
    const picked = await DocumentPicker.getDocumentAsync({
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      copyToCacheDirectory: true,
    });
    if (picked.canceled || !picked.assets?.[0]) return;
    setImportando(true);
    setError('');
    setAviso('');
    try {
      const asset = picked.assets[0];
      const form = new FormData();
      form.append('warehouseId', warehouseId);
      if (semanasDesde) form.append('semanasDesde', semanasDesde);
      if (semanasHasta) form.append('semanasHasta', semanasHasta);
      if (asset.file) {
        form.append('fichero', asset.file);
      } else {
        const blob = await (await fetch(asset.uri)).blob();
        form.append('fichero', blob, asset.name || 'conteo.xlsx');
      }
      const r = await apiFetch('/api/mia/conteos/importar', {
        method: 'POST',
        body: form,
        timeoutMs: 300000,
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || 'No se pudo importar el Excel');
        return;
      }
      setAviso(`Importadas ${data.lineasContadas ?? 0} líneas contadas`);
      await cargarLista(warehouseId);
      const nuevoId = String(data.informeId || '');
      if (nuevoId) {
        setConteos((prev) => (prev.some((c) => c.informeId === nuevoId) ? prev : [{
          informeId: nuevoId,
          creadoEn: new Date().toISOString(),
          ficheroNombre: data.ficheroNombre || null,
          estado: 'generado',
          multiplicador: null,
          semanasDesde: semanasDesde || null,
          semanasHasta: semanasHasta || null,
        }, ...prev]));
      }
      modoNuevo.current = false;
      setInformeId(nuevoId);
    } catch {
      setError('No se pudo importar el Excel');
    } finally {
      setImportando(false);
    }
  }, [warehouseId, semanasDesde, semanasHasta, confirmarSiSucio, cargarLista]);

  const calcular = useCallback(async () => {
    if (!conteo || !localesListos) return;
    const ok = await confirmarSiSucio('Calcular sustituye las cantidades por el valor del tramo. Se pierden los cambios sin guardar.');
    if (!ok) return;
    setGuardando(true);
    setError('');
    setAviso('');
    try {
      const r = await apiFetch(`/api/mia/conteos/${encodeURIComponent(conteo.informeId)}/calcular`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          localIds: localesSel,
          ...(semanasDesde && semanasHasta ? { semanasDesde, semanasHasta } : {}),
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || 'No se pudo calcular el conteo');
        return;
      }
      setAviso('Previsión calculada');
      await cargarConteo(conteo.informeId);
      void cargarLista(warehouseId);
    } catch {
      setError('No se pudo calcular el conteo');
    } finally {
      setGuardando(false);
    }
  }, [conteo, confirmarSiSucio, cargarConteo, warehouseId, cargarLista, localesListos, localesSel, semanasDesde, semanasHasta]);

  const euros = (n: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

  const fichaProveedor = useCallback((proveedorId: string) => {
    const pedido = conteo?.pedidos.find((p) => p.proveedorId === proveedorId);
    const lineas = (conteo?.lineas || []).filter((ln) => ln.proveedorId === proveedorId && !ln.omitida);
    let importe = 0;
    let sinPrecio = false;
    for (const ln of lineas) {
      const qty = Number(ln.cantidadPedida);
      const precio = Number(ln.costeUnitario);
      if (!Number.isFinite(precio)) sinPrecio = true;
      else if (Number.isFinite(qty)) importe += qty * precio;
    }
    const dinero = sinPrecio && importe === 0 ? 'sin precio' : euros(importe);
    return {
      proveedorId,
      nombre: pedido?.proveedorNombre || lineas[0]?.proveedorNombre || proveedorId,
      lineas: lineas.length,
      texto: `${pedido?.proveedorNombre || proveedorId}: ${lineas.length} línea${lineas.length === 1 ? '' : 's'} · ${dinero}`,
    };
  }, [conteo]);

  const enviarProveedor = useCallback(async (proveedorId: string, confirmed: boolean) => {
    if (!conteo) return { ok: false, error: 'No hay conteo' };
    const r = await apiFetch(
      `/api/mia/conteos/${encodeURIComponent(conteo.informeId)}/proveedores/${encodeURIComponent(proveedorId)}/aprobar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmed ? { statusAgora: 'Confirmed' } : {}),
      },
    );
    const data = await r.json();
    if (!r.ok) {
      const detalle = Array.isArray(data.lineas)
        ? data.lineas.map((ln: { nombre?: string; error?: string }) => `${ln.nombre}: ${ln.error}`).join('. ')
        : '';
      return { ok: false, error: detalle || data.error || 'No se pudo enviar' };
    }
    return { ok: true, error: '' };
  }, [conteo]);

  const aprobarUno = useCallback(async (proveedorId: string, confirmed: boolean) => {
    if (!conteo) return;
    if (!conteo.calculadoEn) {
      setError('Calcula el conteo antes de aprobarlo.');
      return;
    }
    if (sucioRef.current) {
      setError('Guarda los cambios antes de aprobar.');
      return;
    }
    const ficha = fichaProveedor(proveedorId);
    const modo = confirmed ? 'Confirmed' : 'borrador';
    const ok = await confirmar(
      confirmed ? 'Confirmar en Ágora' : 'Aprobar pedido',
      `${ficha.texto}\nSe envía como ${modo}.`,
      { confirmarLabel: confirmed ? 'Confirmar' : 'Aprobar', variant: 'danger' },
    );
    if (!ok) return;
    setAprobando(true);
    setError('');
    setAviso('');
    try {
      const resultado = await enviarProveedor(proveedorId, confirmed);
      if (!resultado.ok) setError(`${ficha.nombre}: ${resultado.error}`);
      else setAviso(`${ficha.nombre} enviado como ${modo}`);
      await cargarConteo(conteo.informeId);
      void cargarLista(warehouseId);
    } finally {
      setAprobando(false);
    }
  }, [conteo, fichaProveedor, confirmar, enviarProveedor, cargarConteo, cargarLista, warehouseId]);

  const aprobarTodos = useCallback(async () => {
    if (!conteo) return;
    if (!conteo.calculadoEn) {
      setError('Calcula el conteo antes de aprobarlo.');
      return;
    }
    if (sucioRef.current) {
      setError('Guarda los cambios antes de aprobar.');
      return;
    }
    const pendientes = conteo.pedidos.filter((p) => p.estado === 'generado');
    if (!pendientes.length) return;
    const fichas = pendientes.map((p) => fichaProveedor(p.proveedorId));
    const ok = await confirmar(
      'Aprobar todos',
      `Se envían como borrador, uno a uno:\n${fichas.map((f) => f.texto).join('\n')}`,
      { confirmarLabel: 'Aprobar todos', variant: 'danger' },
    );
    if (!ok) return;
    setAprobando(true);
    setError('');
    setAviso('');
    const enviados: string[] = [];
    const fallidos: string[] = [];
    try {
      for (const ficha of fichas) {
        const resultado = await enviarProveedor(ficha.proveedorId, false);
        if (resultado.ok) enviados.push(ficha.nombre);
        else fallidos.push(`${ficha.nombre}: ${resultado.error}`);
      }
      const partes = [];
      if (enviados.length) partes.push(`Enviados: ${enviados.join(', ')}`);
      if (fallidos.length) partes.push(`Fallaron: ${fallidos.join(' · ')}`);
      setAviso(partes.join('. ') || 'No se envió ningún pedido');
      await cargarConteo(conteo.informeId);
      void cargarLista(warehouseId);
    } finally {
      setAprobando(false);
    }
  }, [conteo, fichaProveedor, confirmar, enviarProveedor, cargarConteo, cargarLista, warehouseId]);

  const almacenNombre = almacenes.find((a) => a.id === warehouseId)?.nombre || warehouseId;
  const fechaPdf = useMemo(() => diaMadrid(conteo?.creadoEn || null), [conteo?.creadoEn]);

  const pedidoPdf = useCallback((proveedorId: string): PedidoPdf => {
    const pedido = conteo?.pedidos.find((p) => p.proveedorId === proveedorId);
    const filas = (conteo?.lineas || []).filter((ln) => ln.proveedorId === proveedorId);
    const lineas = filas.flatMap((ln) => {
      const borrador = borradores[claveLinea(ln)] ?? baseDe(ln);
      if (borrador.omitida) return [];
      const cantidad = Number(canon(borrador.cantidad));
      return [{
        nombre: ln.nombre || ln.productId,
        cantidad: Number.isFinite(cantidad) ? cantidad : 0,
        unit: ln.unit || '',
        costeUnitario: ln.costeUnitario ?? null,
      }];
    });
    return {
      proveedorNombre: pedido?.proveedorNombre || filas[0]?.proveedorNombre || proveedorId,
      almacenNombre,
      fecha: fechaPdf,
      estado: pedido?.estado || 'generado',
      serie: pedido?.serie,
      number: pedido?.number,
      lineas,
    };
  }, [conteo, borradores, almacenNombre, fechaPdf]);

  const descargarUno = useCallback(async (proveedorId: string) => {
    if (!conteo || descargando) return;
    setDescargando(true);
    setError('');
    try {
      await descargarPdfPedido(pedidoPdf(proveedorId));
    } catch {
      setError('No se pudo descargar el PDF');
    } finally {
      setDescargando(false);
    }
  }, [conteo, descargando, pedidoPdf]);

  const descargarTodos = useCallback(async () => {
    if (!conteo || descargando) return;
    const ids = [...new Set(conteo.lineas.map((ln) => ln.proveedorId))];
    if (!ids.length) return;
    setDescargando(true);
    setError('');
    try {
      await descargarZipPedidos(almacenNombre, fechaPdf, ids.map((id) => pedidoPdf(id)));
    } catch {
      setError('No se pudo descargar el zip');
    } finally {
      setDescargando(false);
    }
  }, [conteo, descargando, almacenNombre, fechaPdf, pedidoPdf]);

  const comprobarUno = useCallback(async (proveedorId: string) => {
    if (!conteo || comprobando) return;
    setComprobando(true);
    setError('');
    setAviso('');
    try {
      const r = await apiFetch(`/api/mia/conteos/${encodeURIComponent(conteo.informeId)}/proveedores/${encodeURIComponent(proveedorId)}/comprobar`, { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error || 'No se pudo comprobar el pedido en Ágora');
        return;
      }
      const nombre = conteo.pedidos.find((p) => p.proveedorId === proveedorId)?.proveedorNombre || proveedorId;
      if (data.estado === 'confirmado') setAviso(`${nombre}: el pedido está confirmado en Ágora.`);
      else if (data.estado === 'pedido') setAviso(`${nombre}: el pedido está en Ágora y pasa a Pedido.`);
      else setAviso(`${nombre}: no está en Ágora y vuelve a Generado.`);
      await cargarConteo(conteo.informeId);
      void cargarLista(warehouseId);
    } finally {
      setComprobando(false);
    }
  }, [conteo, comprobando, cargarConteo, cargarLista, warehouseId]);

  const puedeEditarProveedor = useCallback((id: string) => {
    if (!puedeCalcular || !conteo) return false;
    return conteo.pedidos.find((p) => p.proveedorId === id)?.estado === 'generado';
  }, [puedeCalcular, conteo]);

  const enConsulta = consulta?.informeId === conteo?.informeId;
  const lineasVista = useMemo(() => {
    if (!conteo) return [];
    if (!enConsulta || !consulta) return conteo.lineas;
    return conteo.lineas.map((ln) => {
      const fila = consulta.lineas.find((f) => (
        String(f.productId) === ln.productId
        && (!f.proveedorId || String(f.proveedorId) === ln.proveedorId)
      ));
      if (!fila) return ln;
      const cantidad = fila.cantidadPedida == null ? 0 : Number(fila.cantidadPedida);
      const maximo = fila.maximoFinal == null ? null : Number(fila.maximoFinal);
      const unidadConsulta = !ln.unidadManual && fila.purchaseUnitId
        ? { purchaseUnitId: String(fila.purchaseUnitId), unit: fila.unit || String(fila.purchaseUnitId) }
        : {};
      return {
        ...ln,
        ...unidadConsulta,
        cantidadPedida: cantidad,
        maximoFinal: maximo,
        cantidadCalculada: cantidad,
        maximoCalculado: maximo,
        aviso: fila.aviso || null,
      };
    });
  }, [conteo, consulta, enConsulta]);

  const sinCalcular = !!conteo && !conteo.calculadoEn;
  const motivosCalculo = useMemo(() => {
    if (!conteo?.editable) return [];
    const lista = [...(conteo.motivosRecalculo || [])];
    const consultaDistinta = enConsulta && consulta && (
      consulta.previsionImporte !== conteo.previsionImporte
      || consulta.multiplicador !== conteo.multiplicador
    );
    if (consultaDistinta && !lista.includes('sin_calcular')) lista.push('consulta');
    return lista;
  }, [conteo, consulta, enConsulta]);
  const necesitaCalcular = motivosCalculo.length > 0;

  const totalUnidades = useMemo(() => {
    return lineasVista.reduce((suma, ln) => suma + unidadesDe(borradores[claveLinea(ln)] ?? baseDe(ln)), 0);
  }, [lineasVista, borradores]);

  if (!puedeVer) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="lock-outline" size={32} color={SECUNDARIO} />
        <Text style={styles.avisoCentro}>No tienes permiso para ver los conteos.</Text>
      </View>
    );
  }

  const hayError = Object.keys(erroresVista).length > 0;
  const opcionesConteo = conteos
    .filter((c) => filtroEstado === 'todos' || c.estado === filtroEstado || c.informeId === informeId)
    .map((c) => ({
      id: c.informeId,
      titulo: `${formatCreadoEn(c.creadoEn)} · ${c.ficheroNombre || 'Sin fichero'}`,
      subtitulo: `${ESTADO[c.estado] || c.estado} · Semanas ${textoRango(c)}`,
      badge: ESTADO_CORTO[c.estado] || '?',
      badgeColor: COLOR_ESTADO[c.estado] || SECUNDARIO,
    }));
  const opcionesEstado = [
    { id: 'todos', titulo: 'Todos' },
    ...Object.keys(ESTADO)
      .filter((e) => conteos.some((c) => c.estado === e))
      .map((e) => ({ id: e, titulo: e === 'generado' ? 'Borrador (Generado)' : ESTADO[e] })),
  ];
  const hoy = fechaJornadaNegocioIso();
  const resumenAbierto = conteos.find((c) => c.informeId === informeId);
  const finAbierto = String(conteo?.rangoHasta || conteo?.semanasHasta || '').slice(0, 10);
  const conteoAntiguo = !!conteo && (
    (conteo.estado && conteo.estado !== 'generado')
    || (finAbierto !== '' && finAbierto < hoy)
  );
  const avisoAbierto = conteoAntiguo && conteo
    ? `Estás viendo un conteo del ${formatCreadoEn(conteo.creadoEn ?? resumenAbierto?.creadoEn ?? null)} (${ESTADO[conteo.estado] || conteo.estado}). Para uno nuevo, pulsa «Nuevo conteo».`
    : '';
  const hayGenerados = !!conteo?.pedidos.some((p) => p.estado === 'generado');

  return (
    <View style={styles.pantalla}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.panel}>
        <View style={styles.cabecera}>
          <Text style={styles.migas}>
            <Text style={styles.migaLink} onPress={() => router.push('/compras')}>Compras</Text>
            {' › Pedidos a proveedores › '}
            <Text style={styles.migaLink} onPress={() => router.push('/compras/aprovisionamiento')}>MIA — Aprovisionamiento</Text>
            {' › '}
            <Text style={styles.migaActual}>Conteo</Text>
          </Text>
          {aviso ? (
            <View style={styles.okFila}>
              <View style={styles.okPunto} />
              <Text style={styles.ok}>{aviso}</Text>
            </View>
          ) : null}
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={[styles.tarjeta, styles.tarjetaFiltros, shouldStackToolbar && styles.tarjetaPila]}>
          <View style={[styles.filtro, shouldStackToolbar && styles.filtroPila]}>
            <Text style={styles.etiqueta}>Almacén</Text>
            <View style={[styles.control, styles.controlAlmacen, shouldStackToolbar && styles.controlPila]}>
              <CampoSelector
                alto={alto}
                placeholder="Elige almacén…"
                buscador
                buscadorPlaceholder="Buscar almacén…"
                opciones={almacenes.map((a) => ({ id: a.id, titulo: a.nombre }))}
                valorId={warehouseId}
                onSeleccionar={(id) => { void pedirAlmacen(id); }}
              />
            </View>
          </View>
          <View style={[styles.filtro, shouldStackToolbar && styles.filtroPila]}>
            <Text style={styles.etiqueta}>Estado</Text>
            <View style={[styles.control, styles.controlEstado, shouldStackToolbar && styles.controlPila]}>
              <CampoSelector
                alto={alto}
                placeholder="Todos"
                opciones={opcionesEstado}
                valorId={filtroEstado}
                onSeleccionar={setFiltroEstado}
              />
            </View>
          </View>
          <View style={[styles.filtro, shouldStackToolbar && styles.filtroPila]}>
            <Text style={styles.etiqueta}>Conteo</Text>
            <View style={[styles.control, styles.controlConteo, shouldStackToolbar && styles.controlPila]}>
              <CampoSelector
                alto={alto}
                placeholder={conteos.length === 0 ? 'Sin conteos' : modoNuevo.current ? 'Conteo nuevo' : 'Elige conteo…'}
                opciones={opcionesConteo}
                valorId={informeId}
                onSeleccionar={(id) => { void abrirConteo(id); }}
              />
            </View>
            {puedeCalcular && conteos.find((c) => c.informeId === informeId)?.estado === 'generado' ? (
              <Pressable
                style={[styles.papelera, { minHeight: alto, height: alto, minWidth: alto }]}
                onPress={() => { void borrarConteo(informeId); }}
                disabled={borrando}
                accessibilityRole="button"
                accessibilityLabel="Borrar conteo"
              >
                <MaterialIcons name="delete-outline" size={20} color={borrando ? '#fca5a5' : '#b91c1c'} />
              </Pressable>
            ) : null}
          </View>
          {puedeCalcular ? (
            <View style={[styles.filtro, shouldStackToolbar && styles.filtroPila]}>
              <Text style={styles.etiqueta}>Semanas</Text>
              <View style={[styles.control, styles.controlSemanas, shouldStackToolbar && styles.controlPila]}>
                <SelectorDiasRango
                  desdeIso={semanasDesde}
                  hastaIso={semanasHasta}
                  onChangeDesde={setSemanasDesde}
                  onChangeHasta={setSemanasHasta}
                  variante="campo"
                  alto={alto}
                  soloFechas
                  hastaTrasDesde
                  etiqueta=""
                />
              </View>
              <Boton
                titulo="Nuevo conteo"
                icono="add"
                variante="contorno"
                alto={altoBoton}
                onPress={() => { void nuevoConteo(); }}
                disabled={importando || !informeId}
              />
              <Boton
                titulo={importando ? 'Importando…' : 'Importar Excel'}
                icono="file-upload"
                variante="contorno"
                alto={altoBoton}
                onPress={() => { void importar(); }}
                disabled={!warehouseId || importando}
                cargando={importando}
              />
            </View>
          ) : null}
        </View>

        {avisoAbierto && !cargando ? (
          <View style={styles.avisoAbierto}>
            <MaterialIcons name="history" size={18} color="#b45309" />
            <Text style={styles.avisoAbiertoTexto}>{avisoAbierto}</Text>
          </View>
        ) : null}

        {cargando ? <ActivityIndicator color="#ec4899" style={{ marginTop: SPACING.lg }} /> : null}

        {conteo && !cargando ? (
          <>
            <View style={[styles.tarjeta, styles.tarjetaPrevision]}>
              <View style={styles.previsionFila}>
                {(enConsulta ? consulta?.multiplicador : conteo.multiplicador) != null ? (
                  <Text style={styles.pastillaRosa}>×{enConsulta ? consulta?.multiplicador : conteo.multiplicador}</Text>
                ) : (
                  <Text style={styles.pastillaGris}>Sin calcular</Text>
                )}
                {(enConsulta ? consulta?.previsionImporte : conteo.previsionImporte) != null ? (
                  <Text style={styles.prevision}>
                    Previsión {euros(Number(enConsulta ? consulta?.previsionImporte : conteo.previsionImporte))}
                  </Text>
                ) : null}
                {puedeCalcular ? (
                  <View
                    style={styles.locales}
                    accessibilityHint="El tramo sale del importe de estos locales (sede Grupo Paripe)."
                  >
                    <SelectorDesplegableMulti
                      sinIconoTrigger
                      buscador
                      buscadorPlaceholder="Buscar local…"
                      placeholder="Ningún local"
                      etiquetaVarios="locales"
                      tituloLista="Locales"
                      opciones={localesPrevision.map((l) => ({ id: l.id, titulo: l.nombre }))}
                      valorIds={localesSel}
                      onChange={setLocalesSel}
                      style={styles.selectorLocales}
                      triggerStyle={[styles.triggerLocales, { minHeight: altoBoton, height: altoBoton }]}
                      triggerTextStyle={styles.triggerLocalesTexto}
                    />
                  </View>
                ) : null}
                {consultando ? <Text style={styles.nota}>Consultando…</Text> : null}
                {enConsulta ? (
                  <Text style={styles.consulta}>Consulta. El conteo y el pedido no se han modificado.</Text>
                ) : null}
                {(enConsulta ? consulta?.previsionAviso : conteo.previsionAviso) ? (
                  <Pressable
                    style={styles.avisoPrevision}
                    onPress={() => setAvisoPrevisionAbierto((v) => !v)}
                    accessibilityRole="button"
                  >
                    <MaterialIcons name="warning-amber" size={16} color="#b45309" />
                    <Text style={styles.avisoPrevisionTexto} numberOfLines={avisoPrevisionAbierto ? undefined : 1}>
                      {enConsulta ? consulta?.previsionAviso : conteo.previsionAviso}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {conteo.desconocidos.length > 0 ? (
                <Text style={styles.errorPeq}>Ids desconocidos, no se han guardado: {conteo.desconocidos.join(', ')}</Text>
              ) : null}
              {conteo.duplicados.length > 0 ? (
                <Text style={styles.errorPeq}>Ids duplicados, se usa la primera fila y no se suman: {conteo.duplicados.join(', ')}</Text>
              ) : null}
              {conteo.sinContar.length > 0 ? (
                <Text style={styles.errorPeq}>
                  Sin contar, no se piden: {conteo.sinContar.map((ln) => ln.nombre || ln.productId).join(', ')}
                </Text>
              ) : null}
            </View>

            {sinCalcular && puedeCalcular ? (
              <View style={styles.faltaCalcular}>
                <View style={styles.faltaCalcularTexto}>
                  <Text style={styles.faltaCalcularTitulo}>Falta calcular</Text>
                  <Text style={styles.faltaCalcularDetalle}>
                    Sin el cálculo, las cantidades no salen de la previsión. Aprobar está bloqueado hasta que calcules.
                  </Text>
                </View>
                <Boton
                  titulo="Calcular"
                  alto={Math.max(altoBoton, MIN_TOUCH)}
                  parpadeo={!guardando}
                  onPress={() => { void calcular(); }}
                  disabled={!conteo.editable || guardando || borrando || aprobando || !localesListos || localesSel.length === 0}
                  cargando={guardando}
                />
              </View>
            ) : null}

            <View style={[styles.barra, isPhone && styles.barraPila]}>
              <Text style={styles.contador}>
                {sucio === 0 ? 'Sin cambios pendientes' : `${sucio} cambio${sucio === 1 ? '' : 's'} sin guardar`}
                {` · ${conteo.lineasContadas} contadas · Total ${formatoUnidades(totalUnidades)} uds`}
                {puedeCalcular && necesitaCalcular && !sinCalcular ? (
                  <Text style={styles.necesitaCalcular}>
                    {` · Pulsa Calcular: ${motivosCalculo.map(textoMotivo).join(', ')}`}
                  </Text>
                ) : null}
              </Text>
              <View style={styles.acciones}>
                {puedeCalcular && !sinCalcular ? (
                  <Boton
                    titulo="Calcular"
                    alto={altoBoton}
                    parpadeo={necesitaCalcular && !guardando}
                    onPress={() => { void calcular(); }}
                    disabled={!conteo.editable || guardando || borrando || aprobando || !localesListos || localesSel.length === 0}
                    cargando={guardando}
                  />
                ) : null}
                {puedeCalcular ? (
                  <Boton
                    titulo={sucio > 0 ? `Guardar (${sucio})` : 'Guardar'}
                    alto={altoBoton}
                    onPress={() => { void guardar(); }}
                    disabled={sucio === 0 || hayError || guardando || borrando}
                    cargando={guardando}
                  />
                ) : null}
                <Boton
                  titulo="Todos los PDF"
                  icono="download"
                  variante="contorno"
                  alto={altoBoton}
                  onPress={() => { void descargarTodos(); }}
                  disabled={descargando || conteo.lineas.length === 0}
                  cargando={descargando}
                />
                {puedeAprobar && hayGenerados ? (
                  <Boton
                    titulo="Aprobar todos"
                    alto={altoBoton}
                    onPress={() => { void aprobarTodos(); }}
                    disabled={aprobando || comprobando || sucio > 0 || sinCalcular}
                    cargando={aprobando}
                  />
                ) : null}
                {puedeCalcular && conteo.editable ? (
                  <Boton
                    titulo={borrandoId === conteo.informeId ? 'Borrando…' : 'Borrar conteo'}
                    icono="delete-outline"
                    variante="peligro"
                    alto={altoBoton}
                    onPress={() => { void borrarConteo(conteo.informeId); }}
                    disabled={borrando || guardando || aprobando}
                  />
                ) : null}
                {!puedeCalcular && !puedeAprobar ? <Text style={styles.nota}>Solo lectura</Text> : null}
              </View>
            </View>
            {puedeCalcular && !conteo.editable ? (
              <Text style={styles.nota}>
                {hayGenerados
                  ? 'Los proveedores en Pedido, Confirmado o Enviando no se editan. Los que siguen en Generado sí.'
                  : 'Solo lectura: ningún proveedor sigue en Generado.'}
              </Text>
            ) : null}
            {hayError ? <Text style={styles.error}>Revisa las líneas marcadas antes de guardar.</Text> : null}

            <View style={styles.tablaCapa}>
              <ConteoEditor
                lineas={lineasVista}
                borradores={borradores}
                errores={erroresVista}
                pedidos={conteo.pedidos}
                proveedores={conteo.proveedores || []}
                puedeEditarProveedor={puedeEditarProveedor}
                puedeAprobar={puedeAprobar}
                puedeConfirmar={puedeConfirmar}
                aprobarBloqueado={sinCalcular}
                aprobando={aprobando}
                enTarjetas={isPhone}
                onCambio={onCambio}
                onElegir={onElegir}
                onQuitar={onQuitar}
                onRestaurar={onRestaurar}
                onAprobar={(proveedorId, confirmed) => { void aprobarUno(proveedorId, confirmed); }}
                onDescargar={(proveedorId) => { void descargarUno(proveedorId); }}
                onComprobar={(proveedorId) => { void comprobarUno(proveedorId); }}
                comprobando={comprobando}
              />
            </View>
          </>
        ) : !cargando ? (
          <Text style={styles.vacio}>
            {conteos.length === 0 ? 'Todavía no hay conteos de stock máximo en este almacén.' : 'Elige un conteo.'}
          </Text>
        ) : null}
      </ScrollView>
      {ConfirmarView}
    </View>
  );
}

type IconoBoton = 'file-upload' | 'download' | 'delete-outline' | 'add';

function Boton({
  titulo,
  icono,
  variante = 'relleno',
  alto,
  onPress,
  disabled,
  cargando,
  parpadeo = false,
}: {
  titulo: string;
  icono?: IconoBoton;
  variante?: 'relleno' | 'contorno' | 'peligro';
  alto: number;
  onPress: () => void;
  disabled?: boolean;
  cargando?: boolean;
  parpadeo?: boolean;
}) {
  const color = variante === 'relleno' ? '#fff' : variante === 'peligro' ? '#b91c1c' : ROSA;
  const pulso = useRef(new Animated.Value(1)).current;
  const activo = parpadeo && !disabled;
  useEffect(() => {
    if (!activo) {
      pulso.setValue(1);
      return undefined;
    }
    const nativo = Platform.OS !== 'web';
    const bucle = Animated.loop(Animated.sequence([
      Animated.timing(pulso, { toValue: 0.4, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: nativo }),
      Animated.timing(pulso, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: nativo }),
    ]));
    bucle.start();
    return () => {
      bucle.stop();
      pulso.setValue(1);
    };
  }, [activo, pulso]);
  return (
    <Animated.View style={{ opacity: pulso }}>
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, busy: !!cargando }}
      style={({ pressed }) => [
        styles.boton,
        { minHeight: alto, height: alto },
        variante === 'relleno' && styles.botonRelleno,
        variante === 'contorno' && styles.botonContorno,
        variante === 'peligro' && styles.botonPeligro,
        disabled && styles.botonOff,
        pressed && !disabled && styles.botonPulsado,
      ]}
    >
      {cargando ? (
        <ActivityIndicator size="small" color={color} />
      ) : icono ? (
        <MaterialIcons name={icono} size={16} color={color} />
      ) : null}
      <Text style={[styles.botonTexto, { color }]}>{titulo}</Text>
    </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pantalla: { flex: 1, minHeight: 0, backgroundColor: '#f8fafc' },
  scroll: { flex: 1 },
  panel: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.md, paddingBottom: SPACING.xl, gap: SPACING.md },
  vacio: { color: SECUNDARIO, fontSize: 15, paddingTop: SPACING.lg },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.lg },
  avisoCentro: { color: SECUNDARIO, fontSize: 15, textAlign: 'center' },
  cabecera: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.md },
  migas: { color: SECUNDARIO, fontSize: 13 },
  migaLink: { color: ROSA, fontWeight: '600' },
  necesitaCalcular: { color: '#be185d', fontWeight: '700' },
  faltaCalcular: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.md,
    backgroundColor: '#fdf2f8',
    borderWidth: 1,
    borderColor: '#f9a8d4',
    borderRadius: 12,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  faltaCalcularTexto: { flexGrow: 1, flexShrink: 1, gap: 2, minWidth: 220 },
  faltaCalcularTitulo: { color: '#be185d', fontSize: 16, fontWeight: '800' },
  faltaCalcularDetalle: { color: '#9d174d', fontSize: 13 },
  migaActual: { color: TEXTO, fontWeight: '700' },
  okFila: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  okPunto: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#16a34a' },
  ok: { color: '#047857', fontSize: 13, flexShrink: 1 },
  tarjeta: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: SPACING.md,
  },
  tarjetaFiltros: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACING.md,
    position: 'relative',
    zIndex: 30,
    elevation: 3,
  },
  tarjetaPila: { flexDirection: 'column', alignItems: 'stretch' },
  filtro: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  filtroPila: { flexWrap: 'wrap' },
  etiqueta: { color: SECUNDARIO, fontSize: 13 },
  control: { minWidth: 0 },
  controlAlmacen: { width: 200 },
  controlConteo: { width: 320 },
  controlSemanas: { width: 220 },
  controlEstado: { width: 170 },
  avisoAbierto: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 10,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  avisoAbiertoTexto: { color: '#92400e', fontSize: 13, flexShrink: 1 },
  papelera: { alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  controlPila: { flex: 1, minWidth: 180, width: 'auto' },
  tarjetaPrevision: { gap: SPACING.xs, position: 'relative', zIndex: 20, elevation: 2 },
  previsionFila: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.md },
  pastillaRosa: {
    color: '#be185d',
    backgroundColor: '#fdf2f8',
    fontWeight: '700',
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  pastillaGris: {
    color: SECUNDARIO,
    backgroundColor: '#f1f5f9',
    fontWeight: '600',
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  prevision: { color: TEXTO, fontWeight: '700', fontSize: 14 },
  locales: { width: 140 },
  selectorLocales: { width: '100%' },
  triggerLocales: {
    width: '100%',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  triggerLocalesTexto: {
    fontSize: 13,
    fontFamily: familia.medio,
    fontWeight: peso.medio,
    color: colores.texto,
  },
  avisoPrevision: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0, flexBasis: 200, flexGrow: 1 },
  avisoPrevisionTexto: { color: '#b45309', fontSize: 13, flexShrink: 1 },
  barra: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    position: 'relative',
    zIndex: 10,
  },
  barraPila: { flexDirection: 'column', alignItems: 'stretch' },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm },
  contador: { color: SECUNDARIO, fontSize: 13, flexShrink: 1 },
  nota: { color: SECUNDARIO, fontSize: 12 },
  consulta: { color: '#b45309', fontSize: 13, fontWeight: '700' },
  error: { color: '#b91c1c', fontSize: 13 },
  errorPeq: { color: '#b91c1c', fontSize: 12 },
  tablaCapa: { position: 'relative', zIndex: 0 },
  boton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  botonRelleno: { backgroundColor: ROSA, borderColor: ROSA },
  botonContorno: { backgroundColor: '#fff', borderColor: ROSA },
  botonPeligro: { backgroundColor: 'transparent' },
  botonOff: { opacity: 0.45 },
  botonPulsado: { opacity: 0.8 },
  botonTexto: { fontSize: 13, fontWeight: '700' },
});
