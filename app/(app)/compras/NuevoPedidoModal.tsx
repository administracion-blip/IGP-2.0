import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Modal,
  Platform,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../constants/layout';
import { InputFecha } from '../../components/InputFecha';
import { InputCantidad } from '../../components/InputCantidad';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { useAuth } from '../../contexts/AuthContext';
import { useProductosCache } from '../../contexts/ProductosCache';
import { BadgeFormato, useMapaFormatosBase } from '../../components/compras/BadgeFormato';
import { EtiquetaZona, ordenarLineasPorZona, useMapaZonas } from '../../components/compras/EtiquetaZona';
import { apiFetch } from '../../utils/api';
import { valorEnLocal } from '../../utils/valorEnLocal';
import { formatMoneda } from '../../utils/formatMoneda';
import { formatFecha } from '../../utils/formatFecha';
import { hoyISO } from '../../utils/facturaFormLogic';
import { fetchPorcentajeBeneficio, aplicarPorcentajeBeneficio } from '../../lib/personalizacion';
import {
  almacenesDeLocal,
  avisoFacturacionSalida,
  buscarLocalPorId,
  idAlmacenGeneral,
  idLocal,
  nombreAlmacen,
  nombreLocal,
  type AvisoSalida,
} from '../../lib/pedidosEntreLocales';

type Registro = Record<string, string | number | boolean | undefined | null>;

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Se llama tras crear/enviar para que la pantalla padre recargue su listado. */
  onCreado?: () => void;
};

export default function NuevoPedidoModal({ visible, onClose, onCreado }: Props) {
  const { localPermitido, hasPermiso } = useAuth();
  const { isCompact } = useBreakpoint();
  const {
    productos,
    productosIgp: productosIgpCache,
    loading: loadingProductos,
    lastFetch: productosLastFetch,
    recargar: recargarProductos,
  } = useProductosCache();
  const formatos = useMapaFormatosBase(productos);
  const zonas = useMapaZonas(productos);
  const productosIgp = productosIgpCache as Registro[];

  const [locales, setLocales] = useState<Registro[]>([]);
  const [almacenes, setAlmacenes] = useState<Registro[]>([]);
  const [loadingDatos, setLoadingDatos] = useState(false);
  const [porcentajeBeneficio, setPorcentajeBeneficio] = useState(0);

  // Fase 1: cabecera; Fase 2: añadir líneas a un pedido ya creado.
  const [fase, setFase] = useState<'cabecera' | 'lineas'>('cabecera');
  // Tipo de movimiento: 'Pedido' (general → local) o 'Devolucion' (local → general).
  const [tipo, setTipo] = useState<'Pedido' | 'Devolucion'>('Pedido');
  const [form, setForm] = useState({ LocalId: '', AlmacenOrigenId: '', AlmacenDestinoId: '', Fecha: hoyISO(), Notas: '' });
  // Envío entre locales: la mercancía sale del almacén de otro local en vez del
  // Almacén General. Es la excepción, así que vive detrás de un chip y no cambia
  // el flujo habitual mientras esté apagado.
  const [origenOtroLocal, setOrigenOtroLocal] = useState(false);
  const [localOrigenId, setLocalOrigenId] = useState('');
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  // Certificación de la devolución antes de enviarla.
  const [certVisible, setCertVisible] = useState(false);
  const [certAceptada, setCertAceptada] = useState(false);

  const [pedidoCreado, setPedidoCreado] = useState<Registro | null>(null);
  const [lineas, setLineas] = useState<Registro[]>([]);
  const lineasPorZona = useMemo(() => ordenarLineasPorZona(lineas, zonas), [lineas, zonas]);
  const [loadingLineas, setLoadingLineas] = useState(false);
  const [eligiendoProductos, setEligiendoProductos] = useState(false);
  const [busquedaProducto, setBusquedaProducto] = useState('');
  const [cantidadesPicker, setCantidadesPicker] = useState<Record<string, string>>({});
  const [cantidadesLinea, setCantidadesLinea] = useState<Record<string, string>>({});
  const [guardandoLinea, setGuardandoLinea] = useState<string | null>(null);
  const [borrandoLinea, setBorrandoLinea] = useState<string | null>(null);
  const cantidadTimer = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lineasRef = useRef<Registro[]>([]);
  const deseoCantidad = useRef<Record<string, string>>({});
  const syncEnCurso = useRef<Set<string>>(new Set());
  lineasRef.current = lineas;
  const [enviando, setEnviando] = useState(false);

  // Carga de datos y reset al abrir.
  useEffect(() => {
    if (!visible) {
      Object.values(cantidadTimer.current).forEach(clearTimeout);
      cantidadTimer.current = {};
      return;
    }
    setFase('cabecera');
    setTipo('Pedido');
    setForm({ LocalId: '', AlmacenOrigenId: '', AlmacenDestinoId: '', Fecha: hoyISO(), Notas: '' });
    setOrigenOtroLocal(false);
    setLocalOrigenId('');
    setErrorForm(null);
    setPedidoCreado(null);
    setLineas([]);
    setEligiendoProductos(false);
    setBusquedaProducto('');
    setCantidadesPicker({});
    setCantidadesLinea({});
    setCertVisible(false);
    setCertAceptada(false);
    setLoadingDatos(true);
    Promise.all([
      apiFetch('/api/locales').then((r) => r.json()),
      apiFetch('/api/almacenes').then((r) => r.json()),
    ])
      .then(([dataLocales, dataAlmacenes]) => {
        const allLocales: Registro[] = dataLocales.locales || [];
        setLocales(
          allLocales.filter((l) =>
            localPermitido(String(valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? '').trim()),
          ),
        );
        setAlmacenes(dataAlmacenes.almacenes || []);
      })
      .catch(() => {
        setLocales([]);
        setAlmacenes([]);
      })
      .finally(() => setLoadingDatos(false));
    fetchPorcentajeBeneficio().then(setPorcentajeBeneficio).catch(() => {});
  }, [visible, localPermitido]);

  useEffect(() => {
    if (visible && !productosLastFetch) recargarProductos();
  }, [visible, productosLastFetch, recargarProductos]);

  // Almacén general por defecto como origen.
  const almacenGeneralId = useMemo(() => idAlmacenGeneral(almacenes), [almacenes]);

  /**
   * El maestro está cargado pero no hay ningún «Almacén General»: no se puede
   * preseleccionar el origen habitual, así que hay que decírselo al usuario en vez
   * de dejarle un formulario que no se rellena solo y sin explicación.
   */
  const generalNoIdentificado = !loadingDatos && almacenes.length > 0 && !almacenGeneralId;

  // Almacén general por defecto en el lado fijo según el tipo:
  // - Pedido: el general es el ORIGEN (salvo envío entre locales).
  // - Devolución: el general es el DESTINO (el local devuelve al general).
  useEffect(() => {
    if (!almacenGeneralId) return;
    if (tipo === 'Pedido' && !origenOtroLocal && !form.AlmacenOrigenId) {
      setForm((f) => ({ ...f, AlmacenOrigenId: almacenGeneralId }));
    } else if (tipo === 'Devolucion' && !form.AlmacenDestinoId) {
      setForm((f) => ({ ...f, AlmacenDestinoId: almacenGeneralId }));
    }
  }, [almacenGeneralId, tipo, origenOtroLocal, form.AlmacenOrigenId, form.AlmacenDestinoId]);

  // Alternar tipo: invierte el lado del local y limpia la selección manual para
  // que el efecto recoloque el almacén general en el lado correcto.
  const cambiarTipo = useCallback((nuevo: 'Pedido' | 'Devolucion') => {
    setTipo(nuevo);
    setErrorForm(null);
    setOrigenOtroLocal(false);
    setLocalOrigenId('');
    setForm((f) => ({ ...f, AlmacenOrigenId: '', AlmacenDestinoId: '' }));
  }, []);

  // El origen vuelve al Almacén General (el efecto lo repone al limpiarlo).
  const usarAlmacenGeneral = useCallback(() => {
    setOrigenOtroLocal(false);
    setLocalOrigenId('');
    setErrorForm(null);
    setForm((f) => ({ ...f, AlmacenOrigenId: '' }));
  }, []);

  const usarOtroLocalComoOrigen = useCallback(() => {
    setOrigenOtroLocal(true);
    setErrorForm(null);
    setForm((f) => ({ ...f, AlmacenOrigenId: '' }));
  }, []);

  const localesOrdenados = useMemo(
    () =>
      [...locales].sort((a, b) => {
        const na = String(valorEnLocal(a, 'nombre') ?? valorEnLocal(a, 'Nombre') ?? '').trim();
        const nb = String(valorEnLocal(b, 'nombre') ?? valorEnLocal(b, 'Nombre') ?? '').trim();
        return na.localeCompare(nb, 'es', { sensitivity: 'base' });
      }),
    [locales],
  );

  /** Local que recibe la mercancía (en devolución, el que la devuelve). */
  const localDestino = useMemo(
    () => buscarLocalPorId(form.LocalId, locales),
    [form.LocalId, locales],
  );

  const almacenesDestinoParaLocal = useMemo(
    () => almacenesDeLocal(localDestino, almacenes),
    [localDestino, almacenes],
  );

  const almacenesGeneralOpc = useMemo(
    () =>
      (almacenGeneralId
        ? almacenes.filter((alm) => String(valorEnLocal(alm, 'Id') ?? '').trim() === almacenGeneralId)
        : almacenes),
    [almacenes, almacenGeneralId],
  );

  /** Solo quien tenga el permiso puede sacar mercancía del almacén de otro local. */
  const puedeEnviarEntreLocales = hasPermiso('pedidos.crear_entre_locales');

  const localOrigen = useMemo(
    () => buscarLocalPorId(localOrigenId, locales),
    [localOrigenId, locales],
  );

  const almacenesDelLocalOrigen = useMemo(
    () => almacenesDeLocal(localOrigen, almacenes),
    [localOrigen, almacenes],
  );

  /** Locales que pueden servir: todos los permitidos menos el que recibe. */
  const localesOrigenOpciones = useMemo(
    () =>
      localesOrdenados
        .filter((loc) => !form.LocalId.trim() || idLocal(loc) !== form.LocalId.trim())
        .map((loc, idx) => ({
          id: idLocal(loc) || `loc-origen-${idx}`,
          titulo: nombreLocal(loc) || idLocal(loc) || '—',
          icono: 'store' as const,
        })),
    [localesOrdenados, form.LocalId],
  );

  const esDevolucion = tipo === 'Devolucion';
  // En devolución se invierten los lados: el local es el origen y el general el destino.
  const opcionesOrigen = esDevolucion ? almacenesDestinoParaLocal : almacenesGeneralOpc;
  const opcionesDestino = esDevolucion ? almacenesGeneralOpc : almacenesDestinoParaLocal;
  // El lado del local (el que depende de la configuración de almacenes del local).
  const localSinAlmacenes = form.LocalId.trim() !== '' && almacenesDestinoParaLocal.length === 0;

  /**
   * El local que sirve puede tener el Almacén General entre sus almacenes, así
   * que ese chip aparece también dentro de «Desde otro local». Si es el origen
   * elegido, la mercancía sale del almacén central: no hay factura entre
   * sociedades (ni el backend pide el permiso), así que no se anuncia ninguna.
   */
  const origenEsGeneral = almacenGeneralId !== '' && form.AlmacenOrigenId.trim() === almacenGeneralId;

  /** Consecuencia de facturación del envío entre locales, tal como quedará. */
  const avisoEntreLocales = useMemo<AvisoSalida | null>(() => {
    if (!origenOtroLocal || esDevolucion) return null;
    if (!form.AlmacenOrigenId.trim()) return null;
    if (origenEsGeneral) {
      return {
        tono: 'info',
        texto:
          'El origen elegido es el Almacén General: la mercancía sale del almacén central, así que este pedido no generará factura entre sociedades.',
      };
    }
    return avisoFacturacionSalida({ localOrigen, localDestino });
  }, [origenOtroLocal, esDevolucion, form.AlmacenOrigenId, origenEsGeneral, localOrigen, localDestino]);

  const totalAlbaran = useMemo(
    () => lineas.reduce((s, l) => s + Number(l.TotalLinea ?? 0), 0),
    [lineas],
  );

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

  const crearPedido = useCallback(async () => {
    if (!form.LocalId.trim()) {
      setErrorForm('Selecciona un local.');
      return;
    }
    if (origenOtroLocal && !localOrigenId.trim()) {
      setErrorForm('Selecciona el local que sirve la mercancía.');
      return;
    }
    if (!form.AlmacenOrigenId.trim()) {
      setErrorForm(
        origenOtroLocal && almacenesDelLocalOrigen.length === 0
          ? 'El local que sirve no tiene almacenes configurados.'
          : 'Selecciona un almacén de origen.',
      );
      return;
    }
    if (!form.AlmacenDestinoId.trim()) {
      setErrorForm(
        localSinAlmacenes
          ? 'Este local no tiene almacenes configurados.'
          : 'Selecciona un almacén de destino.',
      );
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
        LocalId: form.LocalId.trim(),
        AlmacenOrigenId: form.AlmacenOrigenId.trim(),
        AlmacenDestinoId: form.AlmacenDestinoId.trim(),
        TotalAlbaran: 0,
        Fecha: fechaIso,
        Estado: 'Borrador',
        Tipo: tipo,
        Notas: form.Notas.trim(),
      };
      const res = await apiFetch('/api/pedidos', { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al crear el pedido');
        return;
      }
      const nuevo = (data.pedido ?? { ...body }) as Registro;
      setPedidoCreado(nuevo);
      setLineas([]);
      setFase('lineas');
      onCreado?.();
    } catch {
      setErrorForm('No se pudo conectar con el servidor');
    } finally {
      setGuardando(false);
    }
  }, [form, tipo, localSinAlmacenes, origenOtroLocal, localOrigenId, almacenesDelLocalOrigen, onCreado]);

  const sincronizarProducto = useCallback(async (prod: Registro) => {
    if (!pedidoCreado) return;
    const pedidoId = String(valorEnLocal(pedidoCreado, 'Id') ?? '');
    const productId = String(valorEnLocal(prod, 'Id') ?? '').trim();
    if (!pedidoId || !productId) return;
    if (syncEnCurso.current.has(productId)) return;
    syncEnCurso.current.add(productId);
    setGuardandoLinea(productId);
    const nombre = String((valorEnLocal(prod, 'Name') ?? valorEnLocal(prod, 'Nombre') ?? productId) || '—').trim();
    const precio = Number(valorEnLocal(prod, 'CostPrice') ?? 0) || 0;
    const ivaRaw = valorEnLocal(prod, 'ultimo_iva_compra') ?? valorEnLocal(prod, 'VatPercent');
    const ivaPct = Number(ivaRaw ?? 0) || 0;
    const buscar = () => lineasRef.current.find((l) => String(valorEnLocal(l, 'ProductId') ?? '').trim() === productId);
    let aplicado = '';
    let repetir = false;
    try {
      while (aplicado !== (deseoCantidad.current[productId] ?? '0')) {
        const texto = deseoCantidad.current[productId] ?? '0';
        aplicado = texto;
        const cant = parseFloat(String(texto).replace(',', '.')) || 0;
        const existente = buscar();
        if (cant > 0 && !existente) {
          const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`, {
            method: 'POST',
            body: JSON.stringify({
              ProductId: productId,
              ProductoNombre: nombre,
              Cantidad: cant,
              PrecioUnitario: precio,
              VatRate: ivaPct / 100,
            }),
          });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || 'Error al añadir el producto');
          const linea = (data.linea ?? {}) as Registro;
          lineasRef.current = [
            ...lineasRef.current.filter((l) => String(valorEnLocal(l, 'ProductId') ?? '').trim() !== productId),
            linea,
          ];
        } else if (cant > 0 && existente && Number(existente.Cantidad ?? 0) !== cant) {
          const lineaIndex = String(existente.LineaIndex ?? '').trim();
          const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`, {
            method: 'PUT',
            body: JSON.stringify({ LineaIndex: lineaIndex, Cantidad: cant }),
          });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || 'Error al cambiar la cantidad');
          lineasRef.current = lineasRef.current.map((l) =>
            String(valorEnLocal(l, 'ProductId') ?? '').trim() === productId ? { ...l, Cantidad: cant } : l,
          );
        } else if (!(cant > 0) && existente) {
          const lineaIndex = String(existente.LineaIndex ?? '').trim();
          const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`, {
            method: 'DELETE',
            body: JSON.stringify({ LineaIndex: lineaIndex }),
          });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || 'Error al quitar el producto');
          lineasRef.current = lineasRef.current.filter((l) => String(valorEnLocal(l, 'ProductId') ?? '').trim() !== productId);
        }
      }
      setLineas(lineasRef.current);
      fetchLineas(pedidoId);
      onCreado?.();
      repetir = (deseoCantidad.current[productId] ?? '0') !== aplicado;
    } catch (e) {
      alert((e as Error).message || 'Error al actualizar el producto');
    } finally {
      syncEnCurso.current.delete(productId);
      setGuardandoLinea(null);
    }
    if (repetir) sincronizarProducto(prod);
  }, [pedidoCreado, fetchLineas, onCreado]);

  const programarCantidadProducto = useCallback((prod: Registro, cantidadTexto: string) => {
    const productId = String(valorEnLocal(prod, 'Id') ?? '').trim();
    if (!productId) return;
    setCantidadesPicker((prev) => ({ ...prev, [productId]: cantidadTexto }));
    deseoCantidad.current[productId] = cantidadTexto;
    const previo = cantidadTimer.current[productId];
    if (previo) clearTimeout(previo);
    cantidadTimer.current[productId] = setTimeout(() => {
      sincronizarProducto(prod);
    }, 400);
  }, [sincronizarProducto]);

  const guardarCantidadLinea = useCallback(async (linea: Registro, cantidadTexto: string) => {
    if (!pedidoCreado) return;
    const pedidoId = String(valorEnLocal(pedidoCreado, 'Id') ?? '');
    const lineaIndex = String(linea.LineaIndex ?? '').trim();
    if (!pedidoId || !lineaIndex) return;
    const cant = parseFloat(String(cantidadTexto).replace(',', '.')) || 0;
    if (!(cant > 0)) return;
    setGuardandoLinea(lineaIndex);
    try {
      const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`, {
        method: 'PUT',
        body: JSON.stringify({ LineaIndex: lineaIndex, Cantidad: cant }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error al cambiar la cantidad');
      fetchLineas(pedidoId);
      onCreado?.();
    } catch (e) {
      alert((e as Error).message || 'Error al cambiar la cantidad');
    } finally {
      setGuardandoLinea(null);
    }
  }, [pedidoCreado, fetchLineas, onCreado]);

  const programarCantidadLinea = useCallback((linea: Registro, cantidadTexto: string) => {
    const lineaIndex = String(linea.LineaIndex ?? '').trim();
    if (!lineaIndex) return;
    setCantidadesLinea((prev) => ({ ...prev, [lineaIndex]: cantidadTexto }));
    const previo = cantidadTimer.current[lineaIndex];
    if (previo) clearTimeout(previo);
    cantidadTimer.current[lineaIndex] = setTimeout(() => {
      guardarCantidadLinea(linea, cantidadTexto);
    }, 400);
  }, [guardarCantidadLinea]);

  const handleDeleteLinea = useCallback(async (lineaIndex: string) => {
    if (!pedidoCreado) return;
    const pedidoId = String(valorEnLocal(pedidoCreado, 'Id') ?? '');
    if (!pedidoId) return;
    setBorrandoLinea(lineaIndex);
    try {
      const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`, {
        method: 'DELETE',
        body: JSON.stringify({ LineaIndex: lineaIndex }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error al borrar línea');
      const productId = String(valorEnLocal(
        lineasRef.current.find((l) => String(l.LineaIndex ?? '') === lineaIndex) ?? {},
        'ProductId',
      ) ?? '').trim();
      if (productId) {
        deseoCantidad.current[productId] = '0';
        setCantidadesPicker((prev) => ({ ...prev, [productId]: '0' }));
        lineasRef.current = lineasRef.current.filter((l) => String(l.LineaIndex ?? '') !== lineaIndex);
      }
      fetchLineas(pedidoId);
      onCreado?.();
    } catch (e) {
      alert((e as Error).message || 'Error al borrar línea');
    } finally {
      setBorrandoLinea(null);
    }
  }, [pedidoCreado, fetchLineas, onCreado]);

  const enviarPedido = useCallback(async () => {
    if (!pedidoCreado) return;
    const pedidoId = String(valorEnLocal(pedidoCreado, 'Id') ?? '');
    if (!pedidoId) return;
    if (lineas.length === 0) {
      alert(esDevolucion ? 'Añade al menos un producto antes de enviar la devolución.' : 'Añade al menos un producto antes de enviar el pedido.');
      return;
    }
    setEnviando(true);
    try {
      const res = await apiFetch('/api/pedidos', {
        method: 'PUT',
        body: JSON.stringify({
          Id: pedidoId,
          Estado: 'Enviado',
          Tipo: tipo,
          ...(esDevolucion ? { certificarDevolucion: true } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error al enviar el envío');
      onCreado?.();
      onClose();
    } catch (e) {
      alert((e as Error).message || 'Error al enviar');
    } finally {
      setEnviando(false);
    }
  }, [pedidoCreado, lineas, tipo, esDevolucion, onCreado, onClose]);

  // En devoluciones se exige certificar antes de enviar; en pedidos se envía directo.
  const onPulsarEnviar = useCallback(() => {
    if (lineas.length === 0) {
      alert(esDevolucion ? 'Añade al menos un producto antes de enviar la devolución.' : 'Añade al menos un producto antes de enviar el pedido.');
      return;
    }
    if (esDevolucion) {
      setCertAceptada(false);
      setCertVisible(true);
      return;
    }
    enviarPedido();
  }, [lineas, esDevolucion, enviarPedido]);

  const confirmarCertificacion = useCallback(() => {
    if (!certAceptada) return;
    setCertVisible(false);
    enviarPedido();
  }, [certAceptada, enviarPedido]);

  const localNombre = useMemo(() => {
    const loc = locales.find(
      (l) => String(valorEnLocal(l, 'id_Locales') ?? valorEnLocal(l, 'Id_Locales') ?? valorEnLocal(l, 'Id') ?? '').trim() === form.LocalId.trim(),
    );
    return loc ? String(valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? form.LocalId).trim() : form.LocalId;
  }, [locales, form.LocalId]);

  /** Resumen del movimiento cuando origen y destino están elegidos. */
  const resumenTraspaso = useMemo(() => {
    const etiquetaAlmacen = (idAlm: string) => {
      const alm = almacenes.find((a) => String(valorEnLocal(a, 'Id') ?? '').trim() === idAlm.trim());
      return alm ? nombreAlmacen(alm as Record<string, unknown>) || idAlm : idAlm;
    };
    if (esDevolucion) {
      if (!form.LocalId.trim() || !form.AlmacenOrigenId.trim() || !form.AlmacenDestinoId.trim()) return null;
      const locNom = nombreLocal(localDestino as Record<string, unknown>) || localNombre;
      return `Devolución: ${etiquetaAlmacen(form.AlmacenOrigenId)} (${locNom}) → ${etiquetaAlmacen(form.AlmacenDestinoId)}`;
    }
    if (!form.LocalId.trim() || !form.AlmacenDestinoId.trim() || !form.AlmacenOrigenId.trim()) return null;
    const destLoc = nombreLocal(localDestino as Record<string, unknown>) || localNombre;
    const destAlm = etiquetaAlmacen(form.AlmacenDestinoId);
    const origAlm = etiquetaAlmacen(form.AlmacenOrigenId);
    if (origenOtroLocal && localOrigen) {
      const origLoc = nombreLocal(localOrigen as Record<string, unknown>);
      return `Traspaso: ${origAlm} (${origLoc}) → ${destAlm} (${destLoc})`;
    }
    return `Pedido: ${origAlm} → ${destAlm} (${destLoc})`;
  }, [
    esDevolucion,
    form.LocalId,
    form.AlmacenOrigenId,
    form.AlmacenDestinoId,
    localDestino,
    localNombre,
    localOrigen,
    origenOtroLocal,
    almacenes,
  ]);

  // Zona táctil cómoda para los chips en móvil y tablet.
  const chipTouch = isCompact ? styles.pickerChipTouch : null;

  const productosVisibles = useMemo(() => {
    const q = busquedaProducto.trim().toLowerCase();
    return productosIgp.filter((prod) => {
      const idProd = String(valorEnLocal(prod, 'Id') ?? '').trim();
      const nombre = String((valorEnLocal(prod, 'Name') ?? valorEnLocal(prod, 'Nombre') ?? idProd) || '').trim();
      if (!q) return true;
      return nombre.toLowerCase().includes(q) || idProd.toLowerCase().includes(q);
    });
  }, [productosIgp, busquedaProducto]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* El fondo no cierra el pedido en curso (evita perder datos); se cierra con la X o Cancelar. */}
      <Pressable style={styles.overlay}>
        <Pressable style={[styles.card, fase === 'lineas' && styles.cardLineas]} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              {fase === 'cabecera'
                ? (esDevolucion ? 'Nueva devolución' : 'Nuevo pedido')
                : eligiendoProductos
                  ? 'Productos'
                  : `${esDevolucion ? 'Devolución' : 'Añadir productos'} · ${String(valorEnLocal(pedidoCreado ?? {}, 'Id') ?? '')}`}
            </Text>
            {eligiendoProductos ? (
              <TouchableOpacity onPress={() => setEligiendoProductos(false)} style={styles.btnListo} activeOpacity={0.8}>
                <Text style={styles.btnListoText}>Listo</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={onClose} style={styles.close}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            )}
          </View>

          {loadingDatos ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="large" color="#0ea5e9" />
            </View>
          ) : fase === 'cabecera' ? (
            <>
              <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
                <View style={styles.group}>
                  <Text style={styles.label}>Tipo de movimiento</Text>
                  <View style={styles.segmented}>
                    <TouchableOpacity
                      style={[styles.segmentBtn, !esDevolucion && styles.segmentBtnActive]}
                      onPress={() => cambiarTipo('Pedido')}
                      activeOpacity={0.8}
                    >
                      <MaterialIcons name="local-shipping" size={16} color={!esDevolucion ? '#fff' : '#475569'} />
                      <Text style={[styles.segmentText, !esDevolucion && styles.segmentTextActive]}>Pedido</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.segmentBtn, esDevolucion && styles.segmentBtnActiveDev]}
                      onPress={() => cambiarTipo('Devolucion')}
                      activeOpacity={0.8}
                    >
                      <MaterialIcons name="undo" size={16} color={esDevolucion ? '#fff' : '#475569'} />
                      <Text style={[styles.segmentText, esDevolucion && styles.segmentTextActive]}>Devolución</Text>
                    </TouchableOpacity>
                  </View>
                  {esDevolucion ? (
                    <Text style={styles.devHint}>El local devuelve al almacén general. Sin rappel ni abono.</Text>
                  ) : null}
                </View>

                {esDevolucion ? (
                  <View style={styles.bloqueSeccion}>
                    <Text style={styles.bloqueSeccionTitulo}>Origen</Text>
                    <View style={styles.group}>
                      <Text style={styles.label}>Local *</Text>
                      <SelectorDesplegable
                        placeholder="— Seleccionar local —"
                        icono="store"
                        tituloLista="Selecciona un local"
                        iconoLista="store"
                        buscador
                        valorId={form.LocalId || null}
                        opciones={localesOrdenados.map((loc, idx) => {
                          const idLoc = String(valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'Id_Locales') ?? '').trim();
                          const nombre = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? idLoc) || '—').trim();
                          return { id: idLoc || `loc-${idx}`, titulo: nombre || idLoc || '—', icono: 'store' as const };
                        })}
                        onSeleccionar={(id) => {
                          setForm((f) => ({ ...f, LocalId: id, AlmacenDestinoId: '', AlmacenOrigenId: '' }));
                        }}
                      />
                    </View>
                    <View style={[styles.group, styles.groupUltimo]}>
                      <Text style={styles.label}>Almacén origen *</Text>
                      {localSinAlmacenes ? (
                        <Text style={styles.hintWarn}>Este local no tiene almacenes configurados.</Text>
                      ) : (
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow}>
                          {opcionesOrigen.map((alm) => {
                            const idAlm = String(valorEnLocal(alm, 'Id') ?? '').trim();
                            const nombre = String((valorEnLocal(alm, 'Nombre') ?? idAlm) || '—').trim();
                            const sel = idAlm !== '' && form.AlmacenOrigenId === idAlm;
                            return (
                              <TouchableOpacity
                                key={idAlm || nombre}
                                style={[styles.pickerChip, chipTouch, sel && styles.pickerChipActive]}
                                onPress={() => setForm((f) => ({ ...f, AlmacenOrigenId: sel ? '' : idAlm }))}
                              >
                                <Text style={[styles.pickerChipText, sel && styles.pickerChipTextActive]} numberOfLines={1}>
                                  {nombre || idAlm || '—'}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </ScrollView>
                      )}
                    </View>
                  </View>
                ) : (
                  <View style={styles.bloqueSeccion}>
                    <Text style={styles.bloqueSeccionTitulo}>Destino</Text>
                    <View style={styles.group}>
                      <Text style={styles.label}>Local *</Text>
                      <SelectorDesplegable
                        placeholder="— Seleccionar local —"
                        icono="store"
                        tituloLista="Selecciona un local"
                        iconoLista="store"
                        buscador
                        valorId={form.LocalId || null}
                        opciones={localesOrdenados.map((loc, idx) => {
                          const idLoc = String(valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'Id_Locales') ?? '').trim();
                          const nombre = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? idLoc) || '—').trim();
                          return { id: idLoc || `loc-${idx}`, titulo: nombre || idLoc || '—', icono: 'store' as const };
                        })}
                        onSeleccionar={(id) => {
                          if (origenOtroLocal && id === localOrigenId) {
                            setLocalOrigenId('');
                            setForm((f) => ({ ...f, LocalId: id, AlmacenDestinoId: '', AlmacenOrigenId: '' }));
                            return;
                          }
                          setForm((f) => ({ ...f, LocalId: id, AlmacenDestinoId: '' }));
                        }}
                      />
                    </View>
                    <View style={[styles.group, styles.groupUltimo]}>
                      <Text style={styles.label}>Almacén destino *</Text>
                      {localSinAlmacenes ? (
                        <Text style={styles.hintWarn}>Este local no tiene almacenes de destino configurados.</Text>
                      ) : (
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow}>
                          {opcionesDestino.map((alm) => {
                            const idAlm = String(valorEnLocal(alm, 'Id') ?? '').trim();
                            const nombre = String((valorEnLocal(alm, 'Nombre') ?? idAlm) || '—').trim();
                            const sel = idAlm !== '' && form.AlmacenDestinoId === idAlm;
                            return (
                              <TouchableOpacity
                                key={idAlm || nombre}
                                style={[styles.pickerChip, chipTouch, sel && styles.pickerChipActive]}
                                onPress={() => setForm((f) => ({ ...f, AlmacenDestinoId: sel ? '' : idAlm }))}
                              >
                                <Text style={[styles.pickerChipText, sel && styles.pickerChipTextActive]} numberOfLines={1}>
                                  {nombre || idAlm || '—'}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </ScrollView>
                      )}
                    </View>
                  </View>
                )}

                <View style={styles.bloqueSeccion}>
                  <Text style={styles.bloqueSeccionTitulo}>{esDevolucion ? 'Destino' : 'Origen'}</Text>
                  {esDevolucion ? (
                    <View style={[styles.group, styles.groupUltimo]}>
                      <Text style={styles.label}>Almacén destino *</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow}>
                        {opcionesDestino.map((alm) => {
                          const idAlm = String(valorEnLocal(alm, 'Id') ?? '').trim();
                          const nombre = String((valorEnLocal(alm, 'Nombre') ?? idAlm) || '—').trim();
                          const sel = idAlm !== '' && form.AlmacenDestinoId === idAlm;
                          return (
                            <TouchableOpacity
                              key={idAlm || nombre}
                              style={[styles.pickerChip, chipTouch, sel && styles.pickerChipActive]}
                              onPress={() => setForm((f) => ({ ...f, AlmacenDestinoId: sel ? '' : idAlm }))}
                            >
                              <Text style={[styles.pickerChipText, sel && styles.pickerChipTextActive]} numberOfLines={1}>
                                {nombre || idAlm || '—'}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>
                      {generalNoIdentificado ? (
                        <Text style={styles.avisoFactura}>
                          No hay ningún almacén llamado «Almacén General» en el maestro, así que no se ha podido
                          preseleccionar el destino de la devolución: elígelo a mano. Revisa el nombre del almacén
                          central en Almacenes.
                        </Text>
                      ) : null}
                    </View>
                  ) : (
                    <View style={[styles.group, styles.groupUltimo]}>
                      <Text style={styles.label}>Almacén origen *</Text>
                      <>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow}>
                          {almacenesGeneralOpc.map((alm) => {
                            const idAlm = String(valorEnLocal(alm, 'Id') ?? '').trim();
                            const nombre = String((valorEnLocal(alm, 'Nombre') ?? idAlm) || '—').trim();
                            const sel = !origenOtroLocal && idAlm !== '' && form.AlmacenOrigenId === idAlm;
                            return (
                              <TouchableOpacity
                                key={idAlm || nombre}
                                style={[styles.pickerChip, chipTouch, sel && styles.pickerChipActive]}
                                onPress={() => {
                                  if (origenOtroLocal) {
                                    usarAlmacenGeneral();
                                    setForm((f) => ({ ...f, AlmacenOrigenId: idAlm }));
                                    return;
                                  }
                                  setForm((f) => ({ ...f, AlmacenOrigenId: sel ? '' : idAlm }));
                                }}
                              >
                                <Text style={[styles.pickerChipText, sel && styles.pickerChipTextActive]} numberOfLines={1}>
                                  {nombre || idAlm || '—'}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                          {puedeEnviarEntreLocales ? (
                            <TouchableOpacity
                              style={[styles.pickerChip, chipTouch, origenOtroLocal && styles.pickerChipActive]}
                              onPress={origenOtroLocal ? usarAlmacenGeneral : usarOtroLocalComoOrigen}
                            >
                              <Text
                                style={[styles.pickerChipText, origenOtroLocal && styles.pickerChipTextActive]}
                                numberOfLines={1}
                              >
                                Desde otro local
                              </Text>
                            </TouchableOpacity>
                          ) : null}
                        </ScrollView>

                        {generalNoIdentificado ? (
                          <Text style={styles.avisoFactura}>
                            No hay ningún almacén llamado «Almacén General» en el maestro, así que no se ha podido
                            preseleccionar el origen habitual: elígelo a mano. Si el almacén elegido no es el central,
                            el pedido generará factura entre sociedades y se rechazará sin el permiso de envíos entre
                            locales. Revisa el nombre del almacén central en Almacenes.
                          </Text>
                        ) : null}

                        {origenOtroLocal ? (
                          <View style={styles.subGroup}>
                            <Text style={styles.label}>Local que sirve *</Text>
                            <SelectorDesplegable
                              placeholder="— Seleccionar local que sirve —"
                              icono="store"
                              tituloLista="¿Qué local sirve la mercancía?"
                              iconoLista="store"
                              buscador
                              valorId={localOrigenId || null}
                              opciones={localesOrigenOpciones}
                              vacioTexto="No hay otros locales disponibles."
                              onSeleccionar={(id) => {
                                setLocalOrigenId(id);
                                setErrorForm(null);
                                setForm((f) => ({ ...f, AlmacenOrigenId: '' }));
                              }}
                            />
                            {!localOrigenId ? (
                              <Text style={styles.hint}>Elige el local del que sale la mercancía.</Text>
                            ) : almacenesDelLocalOrigen.length === 0 ? (
                              <Text style={styles.hintWarn}>
                                Este local no tiene almacenes configurados. Asígnalos en Locales o elige otro origen.
                              </Text>
                            ) : (
                              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow}>
                                {almacenesDelLocalOrigen.map((alm) => {
                                    const idAlm = String(valorEnLocal(alm, 'Id') ?? '').trim();
                                    const nombre = String((valorEnLocal(alm, 'Nombre') ?? idAlm) || '—').trim();
                                    const sel = idAlm !== '' && form.AlmacenOrigenId === idAlm;
                                    return (
                                      <TouchableOpacity
                                        key={idAlm || nombre}
                                        style={[styles.pickerChip, chipTouch, sel && styles.pickerChipActive]}
                                        onPress={() => setForm((f) => ({ ...f, AlmacenOrigenId: sel ? '' : idAlm }))}
                                      >
                                        <Text
                                          style={[styles.pickerChipText, sel && styles.pickerChipTextActive]}
                                          numberOfLines={1}
                                        >
                                          {nombre || idAlm || '—'}
                                        </Text>
                                      </TouchableOpacity>
                                    );
                                  })}
                                </ScrollView>
                            )}
                            {avisoEntreLocales ? (
                              <Text style={avisoEntreLocales.tono === 'aviso' ? styles.avisoFactura : styles.hint}>
                                {avisoEntreLocales.texto}
                              </Text>
                            ) : null}
                          </View>
                        ) : null}
                      </>
                    </View>
                  )}
                </View>

                {resumenTraspaso ? (
                  <View style={[styles.resumenTraspaso, esDevolucion && styles.resumenTraspasoDev]}>
                    <MaterialIcons
                      name={esDevolucion ? 'undo' : 'swap-horiz'}
                      size={18}
                      color={esDevolucion ? '#b45309' : '#0369a1'}
                    />
                    <Text style={[styles.resumenTraspasoText, esDevolucion && styles.resumenTraspasoTextDev]} numberOfLines={2}>
                      {resumenTraspaso}
                    </Text>
                  </View>
                ) : null}

                <View style={styles.group}>
                  <Text style={styles.label}>Fecha *</Text>
                  <InputFecha
                    valueIso={form.Fecha}
                    onChangeIso={(v) => setForm((f) => ({ ...f, Fecha: v }))}
                    placeholder="dd/mm/aaaa"
                    style={styles.input}
                  />
                </View>

                <View style={styles.group}>
                  <Text style={styles.label}>Notas</Text>
                  <TextInput
                    style={[styles.input, styles.inputMultiline]}
                    value={form.Notas}
                    onChangeText={(v) => setForm((f) => ({ ...f, Notas: v }))}
                    placeholder="Observaciones"
                    placeholderTextColor="#94a3b8"
                    multiline
                  />
                </View>
              </ScrollView>
              {errorForm ? <Text style={styles.error}>{errorForm}</Text> : null}
              <View style={styles.footer}>
                <TouchableOpacity style={styles.btnPrimary} onPress={crearPedido} disabled={guardando} activeOpacity={0.8}>
                  {guardando ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <MaterialIcons name="arrow-forward" size={18} color="#fff" />
                  )}
                  <Text style={styles.btnPrimaryText}>{esDevolucion ? 'Crear y añadir botellas' : 'Crear y añadir productos'}</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              {!eligiendoProductos ? (
              <View style={[styles.resumenCabecera, esDevolucion && styles.resumenCabeceraDev]}>
                <MaterialIcons name={esDevolucion ? 'undo' : 'store'} size={16} color={esDevolucion ? '#b45309' : '#0369a1'} />
                <Text style={[styles.resumenText, esDevolucion && styles.resumenTextDev]} numberOfLines={1}>
                  {esDevolucion ? 'Devolución · ' : ''}
                  {origenOtroLocal && localOrigen && !origenEsGeneral ? `${nombreLocal(localOrigen)} → ` : ''}
                  {localNombre} · {formatFecha(form.Fecha)}
                </Text>
              </View>
              ) : null}
              {!eligiendoProductos && avisoEntreLocales?.tono === 'aviso' ? (
                <Text style={[styles.avisoFactura, styles.avisoFacturaLineas]}>{avisoEntreLocales.texto}</Text>
              ) : null}

              {eligiendoProductos ? (
                <View style={styles.pickerProductos}>
                  <View style={styles.buscadorProducto}>
                    <MaterialIcons name="search" size={22} color="#64748b" />
                    <TextInput
                      style={styles.buscadorProductoInput}
                      value={busquedaProducto}
                      onChangeText={setBusquedaProducto}
                      placeholder="Escribe el nombre del producto"
                      placeholderTextColor="#94a3b8"
                      autoFocus
                    />
                  </View>
                  {loadingProductos ? (
                    <ActivityIndicator size="small" color="#0ea5e9" style={{ marginVertical: 24 }} />
                  ) : productosVisibles.length === 0 ? (
                    <Text style={styles.lineasVacio}>Ningún producto con ese nombre.</Text>
                  ) : (
                    <ScrollView style={styles.productosScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>
                      {productosVisibles.map((prod, idx) => {
                        const idProd = String(valorEnLocal(prod, 'Id') ?? '').trim() || `p-${idx}`;
                        const nombre = String((valorEnLocal(prod, 'Name') ?? valorEnLocal(prod, 'Nombre') ?? idProd) || '—').trim();
                        const coste = Number(valorEnLocal(prod, 'CostPrice') ?? 0) || 0;
                        const precio = aplicarPorcentajeBeneficio(coste, porcentajeBeneficio);
                        const lineaYa = lineas.find((l) => String(valorEnLocal(l, 'ProductId') ?? '').trim() === idProd);
                        const cant = cantidadesPicker[idProd] ?? (lineaYa ? String(lineaYa.Cantidad ?? 0) : '0');
                        const guardandoEste = guardandoLinea === idProd;
                        return (
                          <View key={idProd} style={styles.prodCard}>
                            <View style={styles.prodTexto}>
                              <View style={styles.lineaArticulo}>
                                <EtiquetaZona zona={zonas.get(idProd)} />
                                <Text style={styles.lineaNombre} numberOfLines={2}>{nombre}</Text>
                              </View>
                              <View style={styles.lineaArticulo}>
                                <BadgeFormato nombre={formatos.get(idProd)} />
                                <Text style={styles.lineaMeta}>{formatMoneda(precio)}</Text>
                              </View>
                            </View>
                            <InputCantidad
                              value={cant}
                              min={0}
                              onChangeText={(v) => programarCantidadProducto(prod, v)}
                              disabled={guardandoEste}
                            />
                            {guardandoEste ? <ActivityIndicator size="small" color="#0ea5e9" /> : null}
                          </View>
                        );
                      })}
                    </ScrollView>
                  )}
                </View>
              ) : (
                <>
                  <View style={styles.lineasListWrap}>
                    <Text style={styles.enPedidoTitulo}>En este pedido{lineas.length > 0 ? ` · ${lineas.length}` : ''}</Text>
                    {loadingLineas ? (
                      <ActivityIndicator size="small" color="#0ea5e9" style={{ marginVertical: 16 }} />
                    ) : lineas.length === 0 ? (
                      <Text style={styles.lineasVacio}>Aún no hay productos en este pedido.</Text>
                    ) : (
                      <ScrollView style={styles.lineasScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>
                        {lineasPorZona.map((l) => {
                          const key = String(l.LineaIndex ?? '');
                          const borrando = borrandoLinea === key;
                          const cant = cantidadesLinea[key] ?? String(l.Cantidad ?? 0);
                          const ivaRaw = Number(l.VatRate ?? 0);
                          const ivaPct = Number.isFinite(ivaRaw) ? (ivaRaw <= 1 ? ivaRaw * 100 : ivaRaw) : 0;
                          const rappel = Number(l.TotalRappel ?? 0);
                          return (
                            <View key={key} style={styles.lineaItem}>
                              <InputCantidad
                                value={cant}
                                min={1}
                                style={styles.cantidadCuatro}
                                inputStyle={styles.cantidadCuatroInput}
                                onChangeText={(v) => programarCantidadLinea(l, v)}
                                disabled={borrando || guardandoLinea === key}
                              />
                              <View style={styles.prodTexto}>
                                <View style={styles.lineaArticulo}>
                                  <EtiquetaZona zona={zonas.get(String(l.ProductId ?? '').trim())} />
                                  <Text style={styles.lineaNombre} numberOfLines={1}>
                                    {String(l.ProductoNombre || l.ProductId || '—')}
                                  </Text>
                                  <BadgeFormato nombre={formatos.get(String(l.ProductId ?? '').trim())} />
                                </View>
                                <Text style={styles.lineaMeta}>
                                  {formatMoneda(Number(l.TotalLinea ?? 0))}
                                  {' · '}
                                  IVA {ivaPct.toLocaleString('es-ES', { maximumFractionDigits: 2 })} %
                                  {' · '}
                                  {rappel > 0 ? `rappel -${formatMoneda(rappel)}` : `rappel ${formatMoneda(0)}`}
                                </Text>
                              </View>
                              <TouchableOpacity onPress={() => handleDeleteLinea(key)} disabled={borrando} style={styles.lineaBorrar}>
                                {borrando ? (
                                  <ActivityIndicator size="small" color="#dc2626" />
                                ) : (
                                  <MaterialIcons name="delete-outline" size={22} color="#dc2626" />
                                )}
                              </TouchableOpacity>
                            </View>
                          );
                        })}
                      </ScrollView>
                    )}
                  </View>
                  <TouchableOpacity
                    style={styles.btnAnadirGrande}
                    onPress={() => setEligiendoProductos(true)}
                    activeOpacity={0.85}
                  >
                    <MaterialIcons name="add" size={28} color="#0369a1" />
                    <Text style={styles.btnAnadirGrandeText}>Añadir producto</Text>
                  </TouchableOpacity>
                </>
              )}

              {!eligiendoProductos ? (
                <>
                  <View style={styles.totalRow}>
                    <Text style={styles.totalLabel}>Total albarán</Text>
                    <Text style={styles.totalValor}>{formatMoneda(totalAlbaran)}</Text>
                  </View>
                  <View style={styles.footer}>
                    <TouchableOpacity
                      style={[styles.btnEnviar, esDevolucion && styles.btnEnviarDev, (enviando || lineas.length === 0) && styles.btnDisabled]}
                      onPress={onPulsarEnviar}
                      disabled={enviando || lineas.length === 0}
                      activeOpacity={0.8}
                    >
                      {enviando ? <ActivityIndicator size="small" color="#fff" /> : <MaterialIcons name={esDevolucion ? 'undo' : 'send'} size={18} color="#fff" />}
                      <Text style={styles.btnEnviarText}>{esDevolucion ? 'Enviar devolución' : 'Enviar pedido'}</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : null}
            </>
          )}
        </Pressable>
      </Pressable>

      {/* Certificación obligatoria antes de enviar una devolución. */}
      <Modal visible={certVisible} transparent animationType="fade" onRequestClose={() => setCertVisible(false)}>
        <Pressable style={styles.overlay} onPress={() => setCertVisible(false)}>
          <Pressable style={styles.certCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.certHeader}>
              <MaterialIcons name="verified-user" size={22} color="#b45309" />
              <Text style={styles.certTitle}>Certificar devolución</Text>
            </View>
            <Text style={styles.certBody}>
              Vas a registrar una devolución de {lineas.length} {lineas.length === 1 ? 'producto' : 'productos'} del local al almacén general.
              Esta operación no genera abono ni rappel y quedará registrada con tu usuario y la fecha.
            </Text>
            <Pressable style={styles.certCheckRow} onPress={() => setCertAceptada((v) => !v)}>
              <View style={[styles.certCheckbox, certAceptada && styles.certCheckboxOn]}>
                {certAceptada ? <MaterialIcons name="check" size={16} color="#fff" /> : null}
              </View>
              <Text style={styles.certCheckText}>
                Certifico que las botellas/productos han sido devueltos físicamente al almacén general.
              </Text>
            </Pressable>
            <View style={styles.certFooter}>
              <TouchableOpacity style={styles.btnGhost} onPress={() => setCertVisible(false)} activeOpacity={0.8}>
                <Text style={styles.btnGhostText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnEnviar, styles.btnEnviarDev, (!certAceptada || enviando) && styles.btnDisabled]}
                onPress={confirmarCertificacion}
                disabled={!certAceptada || enviando}
                activeOpacity={0.8}
              >
                {enviando ? <ActivityIndicator size="small" color="#fff" /> : <MaterialIcons name="undo" size={18} color="#fff" />}
                <Text style={styles.btnEnviarText}>Confirmar y enviar</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', alignItems: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 560, maxHeight: '90%', backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden' },
  cardLineas: { maxWidth: 760 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  title: { flex: 1, fontSize: 17, fontWeight: '700', color: '#334155' },
  close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  btnListo: { minHeight: MIN_TOUCH, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: '#e0f2fe' },
  btnListoText: { fontSize: 15, fontWeight: '700', color: '#0369a1' },
  loadingWrap: { paddingVertical: 48, alignItems: 'center' },
  body: { paddingHorizontal: 16, paddingTop: 12 },
  group: { marginBottom: 14 },
  groupUltimo: { marginBottom: 0 },
  bloqueSeccion: {
    marginBottom: 14,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  bloqueSeccionTitulo: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 10,
  },
  resumenTraspaso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#eff6ff',
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  resumenTraspasoDev: {
    backgroundColor: '#fffbeb',
    borderColor: '#fde68a',
  },
  resumenTraspasoText: { flex: 1, fontSize: 13, fontWeight: '600', color: '#0369a1', lineHeight: 18 },
  resumenTraspasoTextDev: { color: '#b45309' },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 6 },
  input: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 15, color: '#334155', backgroundColor: '#fff', justifyContent: 'center', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) },
  inputMultiline: { minHeight: 70, textAlignVertical: 'top', paddingTop: 10 },
  inputReadonly: { backgroundColor: '#f8fafc', color: '#64748b' },
  pickerRow: { flexDirection: 'row' },
  pickerChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc', marginRight: 8, minHeight: 40, justifyContent: 'center' },
  pickerChipTouch: { minHeight: MIN_TOUCH },
  pickerChipActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  pickerChipText: { fontSize: 13, color: '#475569', fontWeight: '600' },
  pickerChipTextActive: { color: '#fff' },
  hint: { fontSize: 12, color: '#64748b', marginTop: 6 },
  hintWarn: { fontSize: 12, color: '#b45309', marginTop: 2 },
  subGroup: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#f1f5f9' },
  avisoFactura: { fontSize: 12, color: '#b45309', backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fde68a', borderRadius: 10, padding: 10, marginTop: 8, lineHeight: 17, fontWeight: '500' },
  avisoFacturaLineas: { marginHorizontal: 16, marginTop: 10, marginBottom: 0 },
  hintOk: { fontSize: 12, color: '#15803d', marginTop: 2 },
  error: { fontSize: 13, color: '#dc2626', paddingHorizontal: 16, paddingTop: 8, fontWeight: '500' },
  footer: { flexDirection: 'row', gap: 10, padding: 16, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  btnPrimary: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 48, borderRadius: 12, backgroundColor: '#0ea5e9' },
  btnPrimaryText: { fontSize: 15, fontWeight: '700', color: '#fff' },
  btnGhost: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#fff' },
  btnGhostText: { fontSize: 15, fontWeight: '600', color: '#64748b' },
  btnEnviar: { flex: 1.4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 48, borderRadius: 12, backgroundColor: '#d97706' },
  btnEnviarDev: { backgroundColor: '#b45309' },
  btnEnviarText: { fontSize: 15, fontWeight: '700', color: '#fff' },
  btnDisabled: { opacity: 0.5 },

  segmented: { flexDirection: 'row', gap: 8 },
  segmentBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  segmentBtnActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  segmentBtnActiveDev: { backgroundColor: '#b45309', borderColor: '#b45309' },
  segmentText: { fontSize: 14, fontWeight: '700', color: '#475569' },
  segmentTextActive: { color: '#fff' },
  devHint: { fontSize: 12, color: '#b45309', marginTop: 6 },

  resumenCabecera: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#eff6ff', paddingHorizontal: 16, paddingVertical: 8 },
  resumenCabeceraDev: { backgroundColor: '#fef3c7' },
  resumenText: { flex: 1, fontSize: 13, fontWeight: '600', color: '#0369a1' },
  resumenTextDev: { color: '#b45309' },

  certCard: { width: '100%', maxWidth: 460, backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden', padding: 18 },
  certHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  certTitle: { fontSize: 17, fontWeight: '800', color: '#92400e' },
  certBody: { fontSize: 14, color: '#475569', lineHeight: 20, marginBottom: 14 },
  certCheckRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 18 },
  certCheckbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: '#d97706', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  certCheckboxOn: { backgroundColor: '#b45309', borderColor: '#b45309' },
  certCheckText: { flex: 1, fontSize: 13, color: '#334155', lineHeight: 18, fontWeight: '500' },
  certFooter: { flexDirection: 'row', gap: 10 },
  pickerProductos: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  buscadorProducto: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 52,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: '#fff',
    marginBottom: 12,
  },
  buscadorProductoInput: { flex: 1, fontSize: 16, color: '#0f172a', minHeight: 44, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) },
  productosScroll: { maxHeight: 460 },
  prodCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    backgroundColor: '#fff',
  },
  prodTexto: { flex: 1, minWidth: 0 },
  cantidadCuatro: { flexShrink: 0, minWidth: 210 },
  cantidadCuatroInput: { minWidth: 88 },
  btnAnadirGrande: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 72,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#7dd3fc',
    backgroundColor: '#f0f9ff',
  },
  btnAnadirGrandeText: { fontSize: 18, fontWeight: '800', color: '#0369a1' },
  enPedidoTitulo: { fontSize: 13, fontWeight: '700', color: '#64748b', marginBottom: 8 },

  lineasListWrap: { paddingHorizontal: 16, paddingTop: 12, flexShrink: 1 },
  lineasScroll: { maxHeight: 280 },
  lineasVacio: { fontSize: 14, color: '#94a3b8', paddingVertical: 16, textAlign: 'center' },
  lineaItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  lineaArticulo: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0 },
  lineaNombre: { fontSize: 14, color: '#334155', fontWeight: '600', flexShrink: 1 },
  lineaMeta: { fontSize: 12, color: '#64748b', marginTop: 1 },
  lineaBorrar: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },

  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  totalLabel: { fontSize: 14, fontWeight: '600', color: '#475569' },
  totalValor: { fontSize: 18, fontWeight: '800', color: '#0f172a' },
});
