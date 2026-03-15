import { useEffect, useState, useCallback, useMemo } from 'react';
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
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { TablaBasica } from '../../components/TablaBasica';
import { InputFecha } from '../../components/InputFecha';
import { useProductosCache } from '../../contexts/ProductosCache';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const COLUMNAS = ['Id', 'Fecha', 'CreadoEn', 'LocalId', 'Local', 'AlmacenOrigen', 'AlmacenDestino', 'TotalAlbaran', 'Estado'] as const;
const ESTADOS = ['Borrador', 'Pendiente', 'Enviado', 'Exportado', 'Completado'] as const;
const NOMBRE_ALMACEN_GENERAL = 'Almacén General';

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

function valorEnLocal(item: Record<string, any>, key: string): any {
  if (item[key] !== undefined && item[key] !== null) return item[key];
  const found = Object.keys(item).find((k) => k.toLowerCase() === key.toLowerCase());
  return found != null ? item[found] : undefined;
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

function formatCreadoEn(val: string | number | undefined): string {
  if (val == null || String(val).trim() === '') return '—';
  const s = String(val).trim();
  const dateMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    const timeMatch = s.match(/T(\d{2}):(\d{2})/);
    const time = timeMatch ? ` ${timeMatch[1]}:${timeMatch[2]}` : '';
    return `${d}/${m}/${y}${time}`;
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

const READ_ONLY = true;

export default function PedidosCompletadosScreen() {
  const router = useRouter();
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [locales, setLocales] = useState<Local[]>([]);
  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');

  const [modalFormVisible, setModalFormVisible] = useState(false);
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
  const [modalLineaFormVisible, setModalLineaFormVisible] = useState(false);
  const [formLinea, setFormLinea] = useState({ ProductId: '', ProductoNombre: '', Cantidad: '', PrecioUnitario: '', Iva: '', TotalRappel: '' });
  const [guardandoLinea, setGuardandoLinea] = useState(false);
  const { productosIgp: productosIgpCache, loading: loadingProductosCache, lastFetch: productosLastFetch, recargar: recargarProductos } = useProductosCache();
  const productosIgp = productosIgpCache as Record<string, string | number | boolean>[];
  const loadingProductos = loadingProductosCache;
  const [productoDropdownOpen, setProductoDropdownOpen] = useState(false);
  const [productoBusqueda, setProductoBusqueda] = useState('');
  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    Promise.all([
      fetch(`${API_URL}/api/pedidos`).then((r) => r.json()),
      fetch(`${API_URL}/api/locales`).then((r) => r.json()),
      fetch(`${API_URL}/api/almacenes`).then((r) => r.json()),
    ])
      .then(([dataPedidos, dataLocales, dataAlmacenes]) => {
        if (dataPedidos.error) setError(dataPedidos.error);
        else setPedidos(dataPedidos.pedidos || []);
        setLocales(dataLocales.locales || []);
        setAlmacenes(dataAlmacenes.almacenes || []);
      })
      .catch((e) => setError(e.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

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

  const almacenGeneralId = useMemo(() => {
    const alm = almacenes.find((a) => {
      const n = String(valorEnLocal(a, 'Nombre') ?? '').trim();
      return n === NOMBRE_ALMACEN_GENERAL || n.toLowerCase().includes('almacén general') || n.toLowerCase().includes('almacen general');
    });
    return alm ? String(valorEnLocal(alm, 'Id') ?? '').trim() : '';
  }, [almacenes]);

  const totalAlbaranCalculado = useMemo(() => {
    if (editingPedidoId == null) return 0;
    const pedidoIdForm = form.Id.trim();
    const pedidoIdLineas = pedidoParaLineas ? String(valorEnLocal(pedidoParaLineas, 'Id') ?? '').trim() : '';
    if (pedidoIdForm !== pedidoIdLineas || lineas.length === 0) return parseFloat(form.TotalAlbaran) || 0;
    return lineas.reduce((sum, l) => {
      const cant = Number(l.Cantidad ?? 0);
      const precio = Number(l.PrecioUnitario ?? 0);
      return sum + cant * precio;
    }, 0);
  }, [editingPedidoId, form.Id, form.TotalAlbaran, pedidoParaLineas, lineas]);

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

  const pedidosFiltrados = useMemo(() => {
    const soloCompletados = pedidos.filter((p) => String(valorEnLocal(p, 'Estado') ?? '') === 'Completado');
    const q = filtroBusqueda.trim().toLowerCase();
    const filtered = q
      ? soloCompletados.filter((p) => {
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
      : soloCompletados;
    return [...filtered].sort((a, b) => {
      const ca = String(valorEnLocal(a, 'CreadoEn') ?? '').trim();
      const cb = String(valorEnLocal(b, 'CreadoEn') ?? '').trim();
      return ca.localeCompare(cb);
    });
  }, [pedidos, filtroBusqueda, nombresPorLocalId, nombresPorAlmacenId]);

  const handleCrear = () => {};
  const handleEditar = (_item: Pedido) => {};
  const handleBorrar = (_item: Pedido) => {};

  const getValorCelda = useCallback((item: Pedido, col: string): string => {
    const v = valorEnLocal(item, col);
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
    return v != null ? String(v) : '—';
  }, [nombresPorLocalId, nombresPorAlmacenId]);

  const proximoId = useMemo(() => {
    const nums = pedidos
      .map((p) => {
        const id = String(valorEnLocal(p, 'Id') ?? '');
        const m = id.match(/^PED-(\d+)$/i);
        return m ? parseInt(m[1], 10) : 0;
      })
      .filter((n) => !Number.isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    return `PED-${String(max + 1).padStart(3, '0')}`;
  }, [pedidos]);

  const abrirModalCrear = () => {
    setEditingPedidoId(null);
    setForm({
      Id: proximoId,
      LocalId: '',
      AlmacenOrigenId: almacenGeneralId,
      AlmacenDestinoId: '',
      TotalAlbaran: '0',
      Fecha: new Date().toISOString().slice(0, 10),
      Estado: 'Borrador',
      Notas: '',
    });
    setErrorForm(null);
    setModalFormVisible(true);
  };

  const abrirModalEditar = (item: Pedido) => {
    const id = valorEnLocal(item, 'Id');
    setEditingPedidoId(id != null ? String(id) : null);
    const fecha = valorEnLocal(item, 'Fecha');
    const fechaStr = fecha != null ? String(fecha) : '';
    setForm({
      Id: id != null ? String(id) : '',
      LocalId: valorEnLocal(item, 'LocalId') != null ? String(valorEnLocal(item, 'LocalId')) : '',
      AlmacenOrigenId: valorEnLocal(item, 'AlmacenOrigenId') != null ? String(valorEnLocal(item, 'AlmacenOrigenId')) : '',
      AlmacenDestinoId: valorEnLocal(item, 'AlmacenDestinoId') != null ? String(valorEnLocal(item, 'AlmacenDestinoId')) : '',
      TotalAlbaran: valorEnLocal(item, 'TotalAlbaran') != null ? String(valorEnLocal(item, 'TotalAlbaran')) : '0',
      Fecha: fechaStr,
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
    setErrorForm(null);
    setGuardando(true);
    try {
      const body = {
        Id: id,
        LocalId: form.LocalId.trim(),
        AlmacenOrigenId: form.AlmacenOrigenId.trim(),
        AlmacenDestinoId: form.AlmacenDestinoId.trim(),
        TotalAlbaran: totalAlbaranCalculado,
        Fecha: fechaToIso(form.Fecha) || form.Fecha.trim(),
        Estado: form.Estado || 'Borrador',
        Notas: form.Notas.trim(),
      };
      const res = await fetch(`${API_URL}/api/pedidos`, {
        method: editingPedidoId != null ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al guardar');
        return;
      }
      refetch();
      setSelectedRowIndex(null);
      cerrarModalForm();
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
      const res = await fetch(`${API_URL}/api/pedidos`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Id: idStr }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al borrar');
        return;
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
      const res = await fetch(`${API_URL}/api/pedidos/${pedidoId}/lineas`);
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
        const res = await fetch(`${API_URL}/api/pedidos/${pedidoId}/lineas`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
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
      const res = await fetch(`${API_URL}/api/pedidos/${pedidoId}/lineas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      setModalLineaFormVisible(false);
      fetchLineas(pedidoId);
      refetch();
    } catch (e) {
      alert((e as Error).message || 'Error al añadir línea');
    } finally {
      setGuardandoLinea(false);
    }
  }, [pedidoParaLineas, formLinea, fetchLineas, refetch]);

  const togglePreparadaLinea = useCallback(async (lineaIndex: string) => {
    if (!pedidoParaLineas) return;
    const pedidoId = String(valorEnLocal(pedidoParaLineas, 'Id') ?? '');
    if (!pedidoId) return;
    const linea = lineas.find((l) => String(l.LineaIndex ?? '') === lineaIndex);
    if (!linea) return;
    const nuevoValor = !linea.Preparada;
    setGuardandoPreparada(lineaIndex);
    try {
      const res = await fetch(`${API_URL}/api/pedidos/${pedidoId}/lineas`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ LineaIndex: lineaIndex, Preparada: nuevoValor }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error al actualizar preparada');
      await fetchLineas(pedidoId);
      const lineasTrasToggle = lineas.map((l) => (String(l.LineaIndex) === lineaIndex ? { ...l, Preparada: nuevoValor } : l));
      const todasPreparadas = lineasTrasToggle.length > 0 && lineasTrasToggle.every((l) => !!l.Preparada);
      const estadoActual = String(valorEnLocal(pedidoParaLineas, 'Estado') ?? '');
      if (todasPreparadas) {
        await fetch(`${API_URL}/api/pedidos`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ Id: pedidoId, Estado: 'Completado' }),
        });
        setPedidoParaLineas((p) => (p ? { ...p, Estado: 'Completado' } : null));
        refetch();
      } else if (estadoActual === 'Completado') {
        await fetch(`${API_URL}/api/pedidos`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
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


  const { width } = useWindowDimensions();
  const isWide = width > 768;

  return (
    <View style={styles.container}>
      <View style={[styles.mainRow, !isWide && styles.mainRowColumn]}>
        <View style={styles.pedidosSection}>
          <TablaBasica<Pedido>
            title="Pedidos Completados"
            onBack={() => router.back()}
            columnas={[...COLUMNAS]}
            defaultColWidth={76}
            datos={pedidosFiltrados}
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
            columnasMoneda={['TotalAlbaran']}
            getColumnCellStyle={(col) => col === 'TotalAlbaran' ? { text: { fontWeight: '700' } } : undefined}
            getRowStyle={() => ({ backgroundColor: '#dcfce7' })}
            hideToolbarActions
            emptyMessage="No hay pedidos completados"
            emptyFilterMessage="Ningún pedido completado coincide con el filtro"
          />
        </View>
        <View style={[styles.lineasSection, !isWide && styles.lineasSectionColumn]}>
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
          {!pedidoParaLineas ? (
            <Text style={styles.lineasEmptyHint}>Selecciona un pedido para ver sus líneas</Text>
          ) : loadingLineas ? (
            <ActivityIndicator size="small" color="#0ea5e9" style={{ marginVertical: 24 }} />
          ) : (
            <>
            {!READ_ONLY && (
            <View style={styles.lineasEditBar}>
              {!editModeLineas ? (
                <>
                  <TouchableOpacity style={styles.lineasEditarBtn} onPress={entrarModoEditarLineas} disabled={loadingLineas || lineas.length === 0}>
                    <MaterialIcons name="edit" size={14} color="#0ea5e9" />
                    <Text style={styles.lineasEditarBtnText}>Editar</Text>
                  </TouchableOpacity>
                  {!modalLineaFormVisible && (
                    <TouchableOpacity style={styles.lineasAddBtn} onPress={() => setModalLineaFormVisible(true)} disabled={loadingLineas}>
                      <MaterialIcons name="add" size={14} color="#16a34a" />
                      <Text style={styles.lineasAddBtnText}>Añadir línea</Text>
                    </TouchableOpacity>
                  )}
                </>
              ) : (
                <View style={styles.lineasEditActions}>
                  <TouchableOpacity style={styles.lineasGuardarBtn} onPress={guardarCantidadesLineas} disabled={guardandoCantidades}>
                    {guardandoCantidades ? <ActivityIndicator size="small" color="#fff" /> : <MaterialIcons name="check" size={14} color="#fff" />}
                    <Text style={styles.lineasGuardarBtnText}>{guardandoCantidades ? 'Guardando...' : 'Guardar'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.lineasCancelarBtn} onPress={cancelarEdicionLineas} disabled={guardandoCantidades}>
                    <MaterialIcons name="close" size={14} color="#64748b" />
                    <Text style={styles.lineasCancelarBtnText}>Cancelar</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
            )}
            <ScrollView style={styles.lineasList} showsVerticalScrollIndicator>
              <ScrollView horizontal showsHorizontalScrollIndicator>
              <View style={styles.lineasTable}>
                <View style={styles.lineasTableHeader}>
                  <View style={styles.lineasColPreparada}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'center' }]}>✓</Text></View>
                  <View style={styles.lineasColCantidad}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'center' }]}>Cantidad</Text></View>
                  <View style={styles.lineasColArticulo}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'center' }]}>Artículo</Text></View>
                  <View style={styles.lineasColPrecio}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'right' }]}>Precio</Text></View>
                  <View style={styles.lineasColIva}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'right' }]}>IVA</Text></View>
                  <View style={styles.lineasColTotalRappel}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, styles.lineasHeaderTwoLines, { textAlign: 'right' }]}>Total{'\n'}Rappel</Text></View>
                  <View style={styles.lineasColTotal}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'right' }]}>Total</Text></View>
                  <View style={styles.lineasColId}><Text style={[styles.lineasTableCell, styles.lineasTableHeaderCell, { textAlign: 'center' }]}>ID</Text></View>
                </View>
                {lineas.length === 0 ? (
                  <View style={styles.lineasTableEmpty}>
                    <Text style={styles.lineasEmpty}>No hay líneas</Text>
                  </View>
                ) : (
                  lineas.map((l, idx) => {
                    const key = String(l.LineaIndex ?? idx);
                    const cantEdit = lineasEditValues[key] ?? String(l.Cantidad ?? '');
                    const cant = editModeLineas ? (parseFloat(String(cantEdit).replace(',', '.')) || 0) : Number(l.Cantidad ?? 0);
                    const precio = Number(l.PrecioUnitario ?? 0);
                    const total = cant * precio;
                    const totalRappel = Number(l.TotalRappel ?? 0);
                    const iva = l.VatRate != null ? `${Number(l.VatRate) * 100}%` : '—';
                    const preparada = !!l.Preparada;
                    return (
                      <View key={key} style={styles.lineasTableRow}>
                        <View style={styles.lineasColPreparada}>
                          {READ_ONLY ? (
                            <MaterialIcons name={preparada ? 'check-circle' : 'check-circle-outline'} size={22} color={preparada ? '#16a34a' : '#94a3b8'} />
                          ) : (
                            <TouchableOpacity
                              onPress={() => togglePreparadaLinea(key)}
                              disabled={guardandoPreparada !== null}
                              style={[styles.lineasCheckBtn, preparada && styles.lineasCheckBtnActive]}
                            >
                              {guardandoPreparada === key ? (
                                <ActivityIndicator size="small" color={preparada ? '#fff' : '#0ea5e9'} />
                              ) : (
                                <MaterialIcons name={preparada ? 'check-circle' : 'check-circle-outline'} size={22} color={preparada ? '#16a34a' : '#94a3b8'} />
                              )}
                            </TouchableOpacity>
                          )}
                        </View>
                        <View style={styles.lineasColCantidad}>
                          {editModeLineas ? (
                            <TextInput
                              style={[styles.lineasTableCell, styles.lineasCellCantidad, styles.lineasEditInput]}
                              value={cantEdit}
                              onChangeText={(v) => setLineasEditValues((prev) => ({ ...prev, [key]: v }))}
                              keyboardType="numeric"
                              placeholder="0"
                              placeholderTextColor="#94a3b8"
                            />
                          ) : (
                            <Text style={[styles.lineasTableCell, styles.lineasCellCantidad]}>{String(cant)}</Text>
                          )}
                        </View>
                        <View style={[styles.lineasColArticulo, preparada && styles.lineasColArticuloPreparada]}>
                          <Text style={[styles.lineasTableCell, preparada && styles.lineasCellArticuloPreparada]} numberOfLines={1}>{String(l.ProductoNombre || l.ProductId || '—')}</Text>
                        </View>
                        <View style={styles.lineasColPrecio}><Text style={[styles.lineasTableCell, { textAlign: 'right' }]}>{formatMoneda(precio)}</Text></View>
                        <View style={styles.lineasColIva}><Text style={[styles.lineasTableCell, { textAlign: 'right' }]}>{iva}</Text></View>
                        <View style={styles.lineasColTotalRappel}><Text style={[styles.lineasTableCell, { textAlign: 'right' }]}>{formatMoneda(totalRappel)}</Text></View>
                        <View style={styles.lineasColTotal}><Text style={[styles.lineasTableCell, styles.lineasCellTotal]}>{formatMoneda(total)}</Text></View>
                        <View style={styles.lineasColId}>
                          <View style={styles.lineasCellIdBadge}>
                            <Text style={styles.lineasCellIdText} numberOfLines={1}>{String(l.ProductId ?? '—')}</Text>
                          </View>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
              </ScrollView>
            </ScrollView>
            </>
          )}
          {!READ_ONLY && pedidoParaLineas && modalLineaFormVisible && (
            <View style={styles.lineaForm}>
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>Producto</Text>
                {loadingProductos ? (
                  <ActivityIndicator size="small" color="#0ea5e9" style={{ marginVertical: 8 }} />
                ) : (
                  <>
                    <TouchableOpacity
                      style={styles.selectTouchable}
                      onPress={() => { setProductoBusqueda(''); setProductoDropdownOpen(true); }}
                    >
                      <Text style={[styles.selectTouchableText, !formLinea.ProductoNombre && styles.selectTouchablePlaceholder]}>
                        {formLinea.ProductoNombre || 'Buscar producto…'}
                      </Text>
                      <MaterialIcons name="arrow-drop-down" size={24} color="#64748b" />
                    </TouchableOpacity>
                    <Modal visible={productoDropdownOpen} transparent animationType="fade">
                      <Pressable style={styles.modalOverlay} onPress={() => setProductoDropdownOpen(false)}>
                        <View style={styles.selectDropdownCard} onStartShouldSetResponder={() => true}>
                          <View style={styles.dropdownSearchWrap}>
                            <MaterialIcons name="search" size={18} color="#94a3b8" />
                            <TextInput
                              style={styles.dropdownSearchInput}
                              value={productoBusqueda}
                              onChangeText={setProductoBusqueda}
                              placeholder="Buscar producto…"
                              placeholderTextColor="#94a3b8"
                              autoFocus
                            />
                            {productoBusqueda.length > 0 && (
                              <TouchableOpacity onPress={() => setProductoBusqueda('')} hitSlop={8}>
                                <MaterialIcons name="close" size={16} color="#94a3b8" />
                              </TouchableOpacity>
                            )}
                          </View>
                          <ScrollView style={styles.selectDropdownList} keyboardShouldPersistTaps="handled">
                            {productosIgp
                              .filter((prod) => {
                                if (!productoBusqueda.trim()) return true;
                                const q = productoBusqueda.trim().toLowerCase();
                                const idProd = String(valorEnLocal(prod, 'Id') ?? '').toLowerCase();
                                const nombre = String(valorEnLocal(prod, 'Name') ?? valorEnLocal(prod, 'Nombre') ?? '').toLowerCase();
                                return nombre.includes(q) || idProd.includes(q);
                              })
                              .map((prod, idx) => {
                                const idProd = String(valorEnLocal(prod, 'Id') ?? '').trim();
                                const nombre = String((valorEnLocal(prod, 'Name') ?? valorEnLocal(prod, 'Nombre') ?? idProd) || '—').trim();
                                return (
                                  <TouchableOpacity
                                    key={idProd || `p-${idx}`}
                                    style={[styles.selectDropdownItem, formLinea.ProductId === idProd && styles.selectDropdownItemActive]}
                                    onPress={() => {
                                      const costPrice = valorEnLocal(prod, 'CostPrice');
                                      const precioStr = costPrice != null ? String(costPrice) : '';
                                      setFormLinea((f) => ({ ...f, ProductId: idProd, ProductoNombre: nombre, PrecioUnitario: precioStr }));
                                      setProductoDropdownOpen(false);
                                    }}
                                  >
                                    <Text style={[styles.selectDropdownItemText, formLinea.ProductId === idProd && styles.selectDropdownItemTextActive]} numberOfLines={1}>
                                      {nombre || idProd || '—'}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })}
                            {productosIgp.filter((prod) => {
                              if (!productoBusqueda.trim()) return true;
                              const q = productoBusqueda.trim().toLowerCase();
                              const idProd = String(valorEnLocal(prod, 'Id') ?? '').toLowerCase();
                              const nombre = String(valorEnLocal(prod, 'Name') ?? valorEnLocal(prod, 'Nombre') ?? '').toLowerCase();
                              return nombre.includes(q) || idProd.includes(q);
                            }).length === 0 && (
                              <View style={styles.selectDropdownItem}>
                                <Text style={[styles.selectDropdownItemText, { color: '#94a3b8', fontStyle: 'italic' }]}>Sin resultados</Text>
                              </View>
                            )}
                          </ScrollView>
                        </View>
                      </Pressable>
                    </Modal>
                  </>
                )}
              </View>
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>Cantidad</Text>
                <TextInput
                  style={[styles.formInput, styles.formInputCompact]}
                  value={formLinea.Cantidad}
                  onChangeText={(v) => setFormLinea((f) => ({ ...f, Cantidad: v }))}
                  placeholder="0"
                  placeholderTextColor="#94a3b8"
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={styles.formRow}>
                <View style={[styles.formGroup, styles.formGroupFlex]}>
                  <Text style={styles.formLabel}>Precio unitario</Text>
                  <TextInput
                    style={[styles.formInput, styles.formInputPrecioReadonly, styles.formInputCompact]}
                    value={formLinea.PrecioUnitario ? formatMoneda(formLinea.PrecioUnitario) : ''}
                    editable={false}
                    placeholder="Selecciona producto"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                <View style={[styles.formGroup, styles.formGroupFlex]}>
                  <Text style={styles.formLabel}>IVA %</Text>
                  <TextInput
                    style={[styles.formInput, styles.formInputCompact]}
                    value={formLinea.Iva}
                    onChangeText={(v) => setFormLinea((f) => ({ ...f, Iva: v }))}
                    placeholder="0"
                    placeholderTextColor="#94a3b8"
                    keyboardType="decimal-pad"
                  />
                </View>
                <View style={[styles.formGroup, styles.formGroupFlex]}>
                  <Text style={styles.formLabel}>Total Rappel</Text>
                  <TextInput
                    style={[styles.formInput, styles.formInputCompact]}
                    value={formLinea.TotalRappel}
                    onChangeText={(v) => setFormLinea((f) => ({ ...f, TotalRappel: v }))}
                    placeholder="0"
                    placeholderTextColor="#94a3b8"
                    keyboardType="decimal-pad"
                  />
                </View>
              </View>
              <View style={styles.lineaFormBtns}>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnCancel]}
                  onPress={() => {
                    setModalLineaFormVisible(false);
                    setFormLinea({ ProductId: '', ProductoNombre: '', Cantidad: '', PrecioUnitario: '', Iva: '', TotalRappel: '' });
                  }}
                >
                  <Text style={styles.modalBtnCancelText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalBtn} onPress={handleAddLinea} disabled={guardandoLinea || !formLinea.ProductId?.trim()}>
                  {guardandoLinea ? (
                    <ActivityIndicator size="small" color="#0ea5e9" />
                  ) : (
                    <MaterialIcons name="save" size={20} color="#0ea5e9" />
                  )}
                  <Text style={styles.modalBtnText}>Guardar</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </View>

      <Modal visible={modalFormVisible} transparent animationType="fade" onRequestClose={cerrarModalForm}>
        <Pressable style={styles.modalOverlay} onPress={cerrarModalForm}>
          <KeyboardAvoidingView style={styles.modalWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{editingPedidoId ? 'Editar pedido' : 'Nuevo pedido'}</Text>
                <TouchableOpacity onPress={cerrarModalForm} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Id *</Text>
                  <TextInput
                    style={[styles.formInput, editingPedidoId != null && styles.formInputDisabled]}
                    value={form.Id}
                    onChangeText={(v) => setForm((f) => ({ ...f, Id: v }))}
                    placeholder="PED-001"
                    placeholderTextColor="#94a3b8"
                    editable={editingPedidoId == null}
                  />
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Local</Text>
                  {Platform.OS === 'web' ? (
                    <select
                      value={form.LocalId}
                      onChange={(e) => {
                        const v = e.target.value;
                        setForm((f) => ({ ...f, LocalId: v, AlmacenDestinoId: '' }));
                      }}
                      style={styles.selectNative as object}
                    >
                      <option value="">— Seleccionar local —</option>
                      {locales.map((loc, idx) => {
                        const idLoc = String(valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'Id_Locales') ?? '').trim();
                        const nombre = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? idLoc) || '—').trim();
                        return <option key={idLoc || `loc-${idx}`} value={idLoc}>{nombre || idLoc || '—'}</option>;
                      })}
                    </select>
                  ) : (
                    <>
                      <TouchableOpacity
                        style={styles.selectTouchable}
                        onPress={() => setLocalDropdownOpen(true)}
                      >
                        <Text style={[styles.selectTouchableText, !form.LocalId && styles.selectTouchablePlaceholder]}>
                          {form.LocalId ? (nombresPorLocalId[form.LocalId] ?? form.LocalId) : '— Seleccionar local —'}
                        </Text>
                        <MaterialIcons name="arrow-drop-down" size={24} color="#64748b" />
                      </TouchableOpacity>
                      <Modal visible={localDropdownOpen} transparent animationType="fade">
                        <Pressable style={styles.modalOverlay} onPress={() => setLocalDropdownOpen(false)}>
                          <View style={styles.selectDropdownCard} onStartShouldSetResponder={() => true}>
                            <ScrollView style={styles.selectDropdownList} keyboardShouldPersistTaps="handled">
                              <TouchableOpacity
                                style={styles.selectDropdownItem}
                                onPress={() => { setForm((f) => ({ ...f, LocalId: '', AlmacenDestinoId: '' })); setLocalDropdownOpen(false); }}
                              >
                                <Text style={styles.selectDropdownItemText}>— Ninguno —</Text>
                              </TouchableOpacity>
                              {locales.map((loc, idx) => {
                                const idLoc = String(valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'Id_Locales') ?? '').trim();
                                const nombre = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? idLoc) || '—').trim();
                                return (
                                  <TouchableOpacity
                                    key={idLoc || `loc-${idx}`}
                                    style={[styles.selectDropdownItem, form.LocalId === idLoc && styles.selectDropdownItemActive]}
                                    onPress={() => {
                                      setForm((f) => ({ ...f, LocalId: idLoc, AlmacenDestinoId: '' }));
                                      setLocalDropdownOpen(false);
                                    }}
                                  >
                                    <Text style={[styles.selectDropdownItemText, form.LocalId === idLoc && styles.selectDropdownItemTextActive]} numberOfLines={1}>
                                      {nombre || idLoc || '—'}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })}
                            </ScrollView>
                          </View>
                        </Pressable>
                      </Modal>
                    </>
                  )}
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Almacén origen</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow}>
                    {editingPedidoId != null ? (
                      <>
                        <TouchableOpacity
                          style={[styles.pickerChip, !form.AlmacenOrigenId && styles.pickerChipActive]}
                          onPress={() => setForm((f) => ({ ...f, AlmacenOrigenId: '' }))}
                        >
                          <Text style={[styles.pickerChipText, !form.AlmacenOrigenId && styles.pickerChipTextActive]}>—</Text>
                        </TouchableOpacity>
                        {almacenes.map((alm) => {
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
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Almacén destino</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow}>
                    <TouchableOpacity
                      style={[styles.pickerChip, !form.AlmacenDestinoId && styles.pickerChipActive]}
                      onPress={() => setForm((f) => ({ ...f, AlmacenDestinoId: '' }))}
                    >
                      <Text style={[styles.pickerChipText, !form.AlmacenDestinoId && styles.pickerChipTextActive]}>—</Text>
                    </TouchableOpacity>
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
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Fecha</Text>
                  <InputFecha
                    value={form.Fecha}
                    onChange={(v) => setForm((f) => ({ ...f, Fecha: v }))}
                    format="iso"
                    placeholder="YYYY-MM-DD"
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
                    placeholderTextColor="#94a3b8"
                    multiline
                  />
                </View>
              </ScrollView>
              {errorForm ? <Text style={styles.formError}>{errorForm}</Text> : null}
              <View style={styles.modalFooter}>
                <TouchableOpacity style={styles.modalBtn} onPress={guardar} disabled={guardando}>
                  {guardando ? (
                    <ActivityIndicator size="small" color="#0ea5e9" />
                  ) : (
                    <MaterialIcons name="save" size={20} color="#0ea5e9" />
                  )}
                  <Text style={styles.modalBtnText}>{editingPedidoId ? 'Guardar' : 'Crear'}</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      <Modal visible={modalBorrarVisible} transparent animationType="fade" onRequestClose={cerrarModalBorrar}>
        <Pressable style={styles.modalOverlay} onPress={cerrarModalBorrar}>
          <Pressable style={styles.modalCardBorrar} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Borrar pedido</Text>
              <TouchableOpacity onPress={cerrarModalBorrar} style={styles.modalClose}>
                <MaterialIcons name="close" size={22} color="#64748b" />
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
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <MaterialIcons name="delete" size={20} color="#fff" />
                )}
                <Text style={styles.modalBtnDangerText}>Borrar</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  mainRow: {
    flex: 1,
    flexDirection: 'row',
    minHeight: 0,
  },
  mainRowColumn: { flexDirection: 'column' },
  pedidosSection: { flex: 1, minWidth: 0, minHeight: 0 },
  lineasSection: {
    flex: 1,
    minWidth: 280,
    borderLeftWidth: 1,
    borderLeftColor: '#e2e8f0',
    backgroundColor: '#fafafa',
  },
  lineasSectionColumn: {
    borderLeftWidth: 0,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    minWidth: 0,
  },
  lineasPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  lineasPanelTitle: { fontSize: 15, fontWeight: '600', color: '#334155', flex: 1 },
  lineasPanelTotal: { fontSize: 15, fontWeight: '700', color: '#334155' },
  lineasEmptyHint: { fontSize: 14, color: '#94a3b8', textAlign: 'center', paddingVertical: 24, paddingHorizontal: 16 },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalWrap: { width: '100%', maxWidth: 420, padding: 24, alignItems: 'center' },
  modalCard: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 16,
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
    backgroundColor: '#fff',
    borderRadius: 16,
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
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#334155' },
  modalClose: { padding: 4 },
  modalBody: { paddingHorizontal: 20, paddingVertical: 16, maxHeight: 400 },
  formGroup: { marginBottom: 12 },
  formRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  formGroupFlex: { flex: 1, marginBottom: 0 },
  formLabel: { fontSize: 12, fontWeight: '500', color: '#475569', marginBottom: 4 },
  formInput: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#334155',
  },
  formInputCompact: { paddingVertical: 4, minHeight: 36 },
  formInputDisabled: { backgroundColor: '#f1f5f9', color: '#94a3b8' },
  formInputPrecioReadonly: { backgroundColor: '#fafbfc', color: '#64748b' },
  formInputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  formError: { fontSize: 12, color: '#dc2626', paddingHorizontal: 20, paddingVertical: 8 },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  modalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: '#f0f9ff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#0ea5e9',
  },
  modalBtnText: { fontSize: 14, fontWeight: '600', color: '#0ea5e9' },
  modalBtnCancel: { backgroundColor: '#f8fafc', borderColor: '#e2e8f0' },
  modalBtnCancelText: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  modalBtnDanger: { backgroundColor: '#dc2626', borderColor: '#dc2626' },
  modalBtnDangerText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  modalBorrarText: { fontSize: 14, color: '#475569', lineHeight: 22 },
  modalBorrarId: { fontWeight: '700', color: '#334155' },
  pickerRow: { flexDirection: 'row', marginTop: 4 },
  pickerChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginRight: 8,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  pickerChipActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  pickerChipText: { fontSize: 13, color: '#64748b' },
  pickerChipTextActive: { color: '#fff', fontWeight: '600' },
  selectNative: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    fontSize: 13,
    color: '#334155',
    minWidth: 200,
    minHeight: 36,
    width: '100%',
    cursor: 'pointer',
  },
  selectTouchable: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  selectTouchableText: { fontSize: 14, color: '#334155', flex: 1 },
  selectTouchablePlaceholder: { color: '#94a3b8' },
  selectDropdownCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    maxHeight: 400,
    minWidth: 340,
    alignSelf: 'center',
    marginTop: 80,
    overflow: 'hidden',
  },
  dropdownSearchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 8,
    backgroundColor: '#f8fafc',
  },
  dropdownSearchInput: {
    flex: 1,
    fontSize: 14,
    color: '#334155',
    paddingVertical: 4,
    paddingHorizontal: 0,
    outlineStyle: 'none' as any,
  },
  selectDropdownList: { maxHeight: 340 },
  selectDropdownItem: { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  selectDropdownItemActive: { backgroundColor: '#f0f9ff' },
  selectDropdownItemText: { fontSize: 14, color: '#334155' },
  selectDropdownItemTextActive: { color: '#0ea5e9', fontWeight: '600' },
  lineasEditBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 6, gap: 6 },
  lineasEditarBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8, backgroundColor: '#f0f9ff', borderRadius: 6, borderWidth: 1, borderColor: '#0ea5e9' },
  lineasEditarBtnText: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  lineasEditActions: { flexDirection: 'row', gap: 6 },
  lineasGuardarBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8, backgroundColor: '#22c55e', borderRadius: 6 },
  lineasGuardarBtnText: { fontSize: 12, fontWeight: '600', color: '#fff' },
  lineasCancelarBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8, backgroundColor: '#f1f5f9', borderRadius: 6 },
  lineasCancelarBtnText: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  lineasEditInput: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 6, paddingVertical: 4, paddingHorizontal: 6, backgroundColor: '#fff' },
  lineasList: { flex: 1, maxHeight: 300, marginBottom: 12, paddingHorizontal: 16 },
  lineasEmpty: { fontSize: 14, color: '#94a3b8', textAlign: 'center', paddingVertical: 20 },
  lineasTable: { minWidth: 520 },
  lineasTableHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingHorizontal: 8, borderBottomWidth: 2, borderBottomColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  lineasTableHeaderCell: { fontWeight: '600', color: '#475569' },
  lineasHeaderTwoLines: { lineHeight: 14 },
  lineasTableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  lineasTableCell: { fontSize: 13, color: '#334155' },
  lineasCellCantidad: { textAlign: 'center', fontWeight: '700', color: '#E91E63' },
  lineasCellTotal: { textAlign: 'right', fontWeight: '700' },
  lineasColPreparada: { width: 44, alignItems: 'center', justifyContent: 'center' },
  lineasCheckBtn: { padding: 4 },
  lineasCheckBtnActive: {},
  lineasColCantidad: { width: 52 },
  lineasColId: { width: 60, alignItems: 'center', justifyContent: 'center' },
  lineasColArticulo: { flex: 1, minWidth: 120 },
  lineasColArticuloPreparada: { backgroundColor: '#dcfce7' },
  lineasCellArticuloPreparada: { color: '#16a34a', fontWeight: '600' },
  lineasCellIdBadge: { backgroundColor: '#dbeafe', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, alignSelf: 'center' },
  lineasCellIdText: { fontSize: 10, color: '#1e40af', fontWeight: '500' },
  lineasColPrecio: { width: 70 },
  lineasColIva: { width: 44 },
  lineasColTotal: { width: 78 },
  lineasColTotalRappel: { width: 66 },
  lineasTableEmpty: { paddingVertical: 24 },
  lineasAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: '#dcfce7',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#86efac',
  },
  lineasAddBtnText: { fontSize: 12, fontWeight: '600', color: '#16a34a' },
  lineaForm: { marginTop: 8, paddingTop: 12, paddingHorizontal: 16, marginHorizontal: 0, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  lineaFormBtns: { flexDirection: 'row', gap: 12, marginTop: 12, justifyContent: 'flex-end' },
});
