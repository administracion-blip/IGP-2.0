/**
 * Conteo de stock máximo: importar el Excel, calcular y ajustar líneas.
 * Los cambios se quedan en la fila hasta pulsar Guardar.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { formatCreadoEn } from '../../../utils/formatFecha';
import { BotonPrincipal } from '../../../components/ui/BotonPrincipal';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { RangoFechas } from '../../../components/RangoFechas';
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
type ConteoResumen = {
  informeId: string;
  creadoEn: string | null;
  ficheroNombre: string | null;
  estado: string;
  multiplicador: number | null;
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
  desconocidos: string[];
  duplicados: string[];
  sinContar: { productId: string; nombre: string }[];
  lineasContadas: number;
  estado: string;
  editable: boolean;
  pedidos: PedidoProveedor[];
  proveedores: { proveedorId: string; proveedorNombre: string }[];
  lineas: LineaConteo[];
};

const TEXTO = '#0f172a';
const SECUNDARIO = '#64748b';
const ESTADO: Record<string, string> = {
  generado: 'Generado',
  enviando: 'Enviando',
  pedido: 'Pedido',
  confirmado: 'Confirmado',
  mixto: 'Mixto',
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

function parametro(valor: string | string[] | undefined) {
  return Array.isArray(valor) ? valor[0] || '' : valor || '';
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
  const { isPhone } = useBreakpoint();
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
  const [semanasDesde, setSemanasDesde] = useState('');
  const [semanasHasta, setSemanasHasta] = useState('');
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [importando, setImportando] = useState(false);
  const [aprobando, setAprobando] = useState(false);
  const [descargando, setDescargando] = useState(false);
  const [comprobando, setComprobando] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const salirLibre = useRef(false);
  const sucioRef = useRef(false);
  const peticion = useRef(0);

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

  const cargarLista = useCallback(async (almacen: string) => {
    if (!almacen) return;
    const r = await apiFetch(`/api/mia/conteos?warehouseId=${encodeURIComponent(almacen)}`);
    const data = await r.json();
    if (!r.ok) {
      setError(data.error || 'No se pudieron cargar los conteos');
      setConteos([]);
      return;
    }
    setConteos(data.conteos || []);
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
    } catch {
      if (token === peticion.current) setError('No se pudo cargar el conteo');
    } finally {
      if (token === peticion.current) setCargando(false);
    }
  }, []);

  useEffect(() => {
    if (!puedeVer || !warehouseId) return;
    setInformeId('');
    setConteo(null);
    setBorradores({});
    void cargarLista(warehouseId);
  }, [puedeVer, warehouseId, cargarLista]);

  useEffect(() => {
    if (!informeId) return;
    void cargarConteo(informeId);
  }, [informeId, cargarConteo]);

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
    setAviso('');
    setInformeId(id);
  }, [informeId, confirmarSiSucio]);

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
      const r = await apiFetch('/api/mia/conteos/importar', { method: 'POST', body: form });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || 'No se pudo importar el Excel');
        return;
      }
      setAviso(`Importadas ${data.lineasContadas ?? 0} líneas contadas`);
      await cargarLista(warehouseId);
      setInformeId(String(data.informeId || ''));
    } catch {
      setError('No se pudo importar el Excel');
    } finally {
      setImportando(false);
    }
  }, [warehouseId, semanasDesde, semanasHasta, confirmarSiSucio, cargarLista]);

  const calcular = useCallback(async () => {
    if (!conteo) return;
    const ok = await confirmarSiSucio('Calcular sustituye las cantidades por el valor del tramo. Se pierden los cambios sin guardar.');
    if (!ok) return;
    setGuardando(true);
    setError('');
    setAviso('');
    try {
      const r = await apiFetch(`/api/mia/conteos/${encodeURIComponent(conteo.informeId)}/calcular`, { method: 'POST' });
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
  }, [conteo, confirmarSiSucio, cargarConteo, warehouseId, cargarLista]);

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

  if (!puedeVer) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="lock-outline" size={32} color={SECUNDARIO} />
        <Text style={styles.avisoCentro}>No tienes permiso para ver los conteos.</Text>
      </View>
    );
  }

  const puedeEditar = puedeCalcular && conteo?.editable === true;
  const hayError = Object.keys(erroresVista).length > 0;

  return (
    <View style={styles.pantalla}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.cabecera}>
          <Text style={styles.migas}>
            <Text style={styles.migaLink} onPress={() => router.push('/compras')}>Compras</Text>
            {' › Pedidos a proveedores › '}
            <Text style={styles.migaLink} onPress={() => router.push('/compras/aprovisionamiento')}>MIA — Aprovisionamiento</Text>
            {' › '}
            <Text style={styles.migaActual}>Conteo</Text>
          </Text>
          <View style={styles.filtro}>
            <SelectorDesplegable
              placeholder="Almacén"
              icono="warehouse"
              compact
              opciones={almacenes.map((a) => ({ id: a.id, titulo: a.nombre }))}
              valorId={warehouseId}
              onSeleccionar={(id) => { void pedirAlmacen(id); }}
            />
          </View>
          <Text style={styles.nota}>Conteos de este almacén</Text>
          {conteos.length === 0 ? (
            <Text style={styles.nota}>Todavía no hay conteos de stock máximo.</Text>
          ) : (
            <View style={styles.listaConteos}>
              {conteos.map((c) => (
                <Pressable
                  key={c.informeId}
                  style={[styles.conteoItem, c.informeId === informeId && styles.conteoOn]}
                  onPress={() => { void abrirConteo(c.informeId); }}
                  accessibilityRole="button"
                >
                  <Text style={styles.conteoFecha}>{formatCreadoEn(c.creadoEn)}</Text>
                  <Text style={styles.conteoNombre} numberOfLines={1}>{c.ficheroNombre || 'Sin fichero'}</Text>
                  <Text style={styles.conteoEstado}>{ESTADO[c.estado] || c.estado}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {puedeCalcular ? (
            <View style={styles.importar}>
              <RangoFechas
                desdeIso={semanasDesde}
                hastaIso={semanasHasta}
                onChangeDesde={setSemanasDesde}
                onChangeHasta={setSemanasHasta}
                placeholderDesde="Semana desde"
                placeholderHasta="Semana hasta"
                fill
              />
              <BotonPrincipal
                titulo={importando ? 'Importando' : 'Importar Excel'}
                onPress={() => { void importar(); }}
                disabled={!warehouseId || importando}
                estado={importando ? 'enviando' : 'idle'}
              />
            </View>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {aviso ? <Text style={styles.ok}>{aviso}</Text> : null}
        </View>

        {cargando ? <ActivityIndicator color="#ec4899" style={{ marginTop: SPACING.xl }} /> : null}

        {conteo && !cargando ? (
          <View>
            <View style={styles.resumen}>
              {conteo.multiplicador != null ? (
                <Text style={styles.nota}>
                  Multiplicador {conteo.multiplicador}
                  {conteo.previsionImporte != null ? ` · Previsión ${conteo.previsionImporte} €` : ''}
                  {conteo.previsionAviso ? ` · ${conteo.previsionAviso}` : ''}
                </Text>
              ) : (
                <Text style={styles.nota}>Todavía no está calculado. Las cantidades se pueden ajustar igual.</Text>
              )}
              {conteo.desconocidos.length > 0 ? (
                <Text style={styles.error}>Ids desconocidos, no se han guardado: {conteo.desconocidos.join(', ')}</Text>
              ) : null}
              {conteo.duplicados.length > 0 ? (
                <Text style={styles.error}>Ids duplicados, se usa la primera fila y no se suman: {conteo.duplicados.join(', ')}</Text>
              ) : null}
              {conteo.sinContar.length > 0 ? (
                <Text style={styles.error}>
                  Sin contar, no se piden: {conteo.sinContar.map((ln) => ln.nombre || ln.productId).join(', ')}
                </Text>
              ) : null}
              <View style={styles.guardarFila}>
                <Text style={styles.contador}>
                  {sucio === 0 ? 'Sin cambios pendientes' : `${sucio} cambio${sucio === 1 ? '' : 's'} sin guardar`}
                  {` · ${conteo.lineasContadas} contadas`}
                </Text>
                <BotonPrincipal
                  titulo="Descargar todos los PDF"
                  onPress={() => { void descargarTodos(); }}
                  disabled={descargando || conteo.lineas.length === 0}
                  estado={descargando ? 'enviando' : 'idle'}
                />
                {(puedeCalcular || puedeAprobar) ? (
                  <View style={[styles.acciones, isPhone && styles.accionesPila]}>
                    {puedeCalcular ? (
                      <BotonPrincipal
                        titulo="Calcular"
                        onPress={() => { void calcular(); }}
                        disabled={!conteo.editable || guardando || aprobando}
                        estado={guardando ? 'enviando' : 'idle'}
                      />
                    ) : null}
                    {puedeAprobar && conteo.pedidos.some((p) => p.estado === 'generado') ? (
                      <BotonPrincipal
                        titulo="Aprobar todos"
                        onPress={() => { void aprobarTodos(); }}
                        disabled={aprobando || comprobando || sucio > 0}
                        estado={aprobando ? 'enviando' : 'idle'}
                      />
                    ) : null}
                    {puedeCalcular ? (
                      <BotonPrincipal
                        titulo={sucio > 0 ? `Guardar (${sucio})` : 'Guardar'}
                        onPress={() => { void guardar(); }}
                        disabled={!puedeEditar || sucio === 0 || hayError || guardando}
                        estado={guardando ? 'enviando' : 'idle'}
                      />
                    ) : null}
                  </View>
                ) : (
                  <Text style={styles.nota}>Solo lectura</Text>
                )}
              </View>
              {puedeCalcular && !conteo.editable ? (
                <Text style={styles.nota}>Solo lectura: hay un pedido de proveedor en Pedido o Confirmado.</Text>
              ) : null}
              {hayError ? <Text style={styles.error}>Revisa las líneas marcadas antes de guardar.</Text> : null}
            </View>
            <ConteoEditor
              lineas={conteo.lineas}
              borradores={borradores}
              errores={erroresVista}
              pedidos={conteo.pedidos}
              proveedores={conteo.proveedores || []}
              puedeEditar={puedeEditar}
              puedeAprobar={puedeAprobar}
              puedeConfirmar={puedeConfirmar}
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
        ) : null}
      </ScrollView>
      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: '#f8fafc' },
  scroll: { paddingBottom: SPACING.xl },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.lg },
  avisoCentro: { color: SECUNDARIO, fontSize: 15, textAlign: 'center' },
  cabecera: {
    backgroundColor: '#fff',
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: SPACING.sm,
  },
  migas: { color: SECUNDARIO, fontSize: 13 },
  migaLink: { color: '#ec4899', fontWeight: '600' },
  migaActual: { color: TEXTO, fontWeight: '700' },
  filtro: { minWidth: 220, maxWidth: 420 },
  nota: { color: SECUNDARIO, fontSize: 13 },
  listaConteos: { gap: SPACING.xs },
  conteoItem: {
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  conteoOn: { borderColor: '#f9a8d4', backgroundColor: '#fdf2f8' },
  conteoFecha: { color: TEXTO, fontWeight: '700', minWidth: 120 },
  conteoNombre: { color: SECUNDARIO, flex: 1 },
  conteoEstado: { color: TEXTO, fontWeight: '700' },
  importar: { gap: SPACING.sm, alignItems: 'flex-start' },
  resumen: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.md, gap: SPACING.sm },
  guardarFila: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.md, flexWrap: 'wrap' },
  acciones: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  accionesPila: { flexDirection: 'column', alignItems: 'stretch' },
  contador: { color: SECUNDARIO, fontSize: 13, flex: 1 },
  error: { color: '#b91c1c', fontSize: 13 },
  ok: { color: '#047857', fontSize: 13 },
});
