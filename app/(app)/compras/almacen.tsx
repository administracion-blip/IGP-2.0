import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Modal,
  Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../constants/layout';
import { apiFetch } from '../../utils/api';
import { valorEnLocal } from '../../utils/valorEnLocal';
import { formatMoneda } from '../../utils/formatMoneda';
import { formatFecha } from '../../utils/formatFecha';
import NuevoPedidoModal from './NuevoPedidoModal';

type Registro = Record<string, string | number | boolean | undefined | null>;

/** Estados relevantes para almacén (el Borrador del bar nunca se muestra aquí). */
const ESTADOS_ALMACEN = ['Enviado', 'Pendiente', 'Completado'] as const;

/** Filtro de UI: 'activos' agrupa Enviado + Pendiente (todo lo pendiente de preparar). */
type FiltroKey = 'activos' | 'Completado' | null;

const CHIPS: { key: FiltroKey; label: string; color: string }[] = [
  { key: 'activos', label: 'Por preparar', color: '#d97706' },
  { key: 'Completado', label: 'Preparados', color: '#16a34a' },
  { key: null, label: 'Todos', color: '#475569' },
];

function colorEstado(estado: string): string {
  if (estado === 'Enviado') return '#d97706';
  if (estado === 'Pendiente') return '#0ea5e9';
  if (estado === 'Completado') return '#16a34a';
  return '#94a3b8';
}

function etiquetaEstado(estado: string): string {
  if (estado === 'Enviado') return 'Por preparar';
  if (estado === 'Pendiente') return 'En preparación';
  if (estado === 'Completado') return 'Preparado';
  return estado || '—';
}

export default function PedidosAlmacenScreen() {
  const router = useRouter();
  const { localPermitido, hasPermiso } = useAuth();
  const { shouldStackPanels } = useBreakpoint();

  const [pedidos, setPedidos] = useState<Registro[]>([]);
  const [locales, setLocales] = useState<Registro[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroEstado, setFiltroEstado] = useState<FiltroKey>('activos');
  const [busqueda, setBusqueda] = useState('');
  const [nuevoPedidoVisible, setNuevoPedidoVisible] = useState(false);

  const [pedidoSel, setPedidoSel] = useState<Registro | null>(null);
  const [lineas, setLineas] = useState<Registro[]>([]);
  const [loadingLineas, setLoadingLineas] = useState(false);
  const [guardandoLinea, setGuardandoLinea] = useState<string | null>(null);
  const [prepararTodoEnCurso, setPrepararTodoEnCurso] = useState(false);

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    Promise.all([
      apiFetch('/api/pedidos').then((r) => r.json()),
      apiFetch('/api/locales').then((r) => r.json()),
    ])
      .then(([dataPedidos, dataLocales]) => {
        if (dataPedidos.error) setError(dataPedidos.error);
        else setPedidos(Array.isArray(dataPedidos.pedidos) ? dataPedidos.pedidos : []);
        const all: Registro[] = dataLocales.locales || [];
        setLocales(
          all.filter((l) =>
            localPermitido(String(valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? '').trim()),
          ),
        );
      })
      .catch((e) => setError((e as Error).message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [localPermitido]);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  const nombresPorLocalId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const loc of locales) {
      const id = String(
        valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'Id_Locales') ?? valorEnLocal(loc, 'Id') ?? '',
      ).trim();
      const nombre = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id) || '—').trim();
      if (id) map[id] = nombre;
    }
    return map;
  }, [locales]);

  const nombreLocal = useCallback(
    (p: Registro) => {
      const localId = String(valorEnLocal(p, 'LocalId') ?? '').trim();
      return localId ? (nombresPorLocalId[localId] ?? localId) : '—';
    },
    [nombresPorLocalId],
  );

  // Solo pedidos de estados de almacén y de locales permitidos.
  const pedidosAlmacen = useMemo(() => {
    const localIdsPermitidos = new Set(Object.keys(nombresPorLocalId));
    return pedidos.filter((p) => {
      const estado = String(valorEnLocal(p, 'Estado') ?? '').trim();
      if (!ESTADOS_ALMACEN.includes(estado as (typeof ESTADOS_ALMACEN)[number])) return false;
      const localId = String(valorEnLocal(p, 'LocalId') ?? '').trim();
      // Si hay restricción de locales, respetarla; si el mapa está vacío (admin sin locales), pasar todo.
      if (localIdsPermitidos.size > 0 && localId && !localIdsPermitidos.has(localId)) return false;
      return true;
    });
  }, [pedidos, nombresPorLocalId]);

  const conteos = useMemo(() => {
    const c: Record<string, number> = { __todos: pedidosAlmacen.length, __activos: 0 };
    for (const p of pedidosAlmacen) {
      const e = String(valorEnLocal(p, 'Estado') ?? '').trim();
      if (e) c[e] = (c[e] ?? 0) + 1;
      if (e === 'Enviado' || e === 'Pendiente') c.__activos += 1;
    }
    return c;
  }, [pedidosAlmacen]);

  const pedidosFiltrados = useMemo(() => {
    const base =
      filtroEstado === 'activos'
        ? pedidosAlmacen.filter((p) => {
            const e = String(valorEnLocal(p, 'Estado') ?? '').trim();
            return e === 'Enviado' || e === 'Pendiente';
          })
        : filtroEstado === 'Completado'
          ? pedidosAlmacen.filter((p) => String(valorEnLocal(p, 'Estado') ?? '') === 'Completado')
          : pedidosAlmacen;
    const q = busqueda.trim().toLowerCase();
    const filtrados = q
      ? base.filter((p) => {
          const id = String(valorEnLocal(p, 'Id') ?? '');
          const local = nombreLocal(p);
          return `${id} ${local}`.toLowerCase().includes(q);
        })
      : base;
    return [...filtrados].sort((a, b) => {
      // Por fecha ascendente (lo más antiguo primero: lo que lleva más esperando).
      const fa = String(valorEnLocal(a, 'Fecha') ?? '').trim();
      const fb = String(valorEnLocal(b, 'Fecha') ?? '').trim();
      return fa.localeCompare(fb);
    });
  }, [pedidosAlmacen, filtroEstado, busqueda, nombreLocal]);

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

  const abrirPedido = useCallback(
    (p: Registro) => {
      setPedidoSel(p);
      setLineas([]);
      fetchLineas(String(valorEnLocal(p, 'Id') ?? ''));
    },
    [fetchLineas],
  );

  const cerrarPedido = useCallback(() => {
    setPedidoSel(null);
    setLineas([]);
  }, []);

  // Refresca el estado/progreso del pedido seleccionado en la lista sin recargar todo.
  const aplicarEstadoPedido = useCallback((pedidoId: string, nuevoEstado: string | undefined, lineasActuales: Registro[]) => {
    const preparadas = lineasActuales.filter((l) => !!l.Preparada).length;
    const total = lineasActuales.length;
    setPedidos((prev) =>
      prev.map((p) => {
        if (String(valorEnLocal(p, 'Id') ?? '') !== pedidoId) return p;
        return {
          ...p,
          ...(nuevoEstado ? { Estado: nuevoEstado } : {}),
          LineasTotal: total,
          LineasPreparadas: preparadas,
        };
      }),
    );
    setPedidoSel((prev) =>
      prev && String(valorEnLocal(prev, 'Id') ?? '') === pedidoId && nuevoEstado
        ? { ...prev, Estado: nuevoEstado }
        : prev,
    );
  }, []);

  const toggleLinea = useCallback(
    async (linea: Registro) => {
      if (!pedidoSel) return;
      const pedidoId = String(valorEnLocal(pedidoSel, 'Id') ?? '');
      const lineaIndex = String(linea.LineaIndex ?? '');
      if (!pedidoId || !lineaIndex) return;
      const nuevoValor = !linea.Preparada;
      setGuardandoLinea(lineaIndex);
      try {
        const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`, {
          method: 'PUT',
          body: JSON.stringify({ LineaIndex: lineaIndex, Preparada: nuevoValor }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Error al actualizar la línea');
        const nuevasLineas = lineas.map((l) =>
          String(l.LineaIndex ?? '') === lineaIndex ? { ...l, Preparada: nuevoValor } : l,
        );
        setLineas(nuevasLineas);
        aplicarEstadoPedido(pedidoId, data.estadoPedido, nuevasLineas);
      } catch (e) {
        alert((e as Error).message || 'Error al marcar la línea');
      } finally {
        setGuardandoLinea(null);
      }
    },
    [pedidoSel, lineas, aplicarEstadoPedido],
  );

  const prepararTodo = useCallback(
    async (preparar: boolean) => {
      if (!pedidoSel) return;
      const pedidoId = String(valorEnLocal(pedidoSel, 'Id') ?? '');
      if (!pedidoId) return;
      const objetivo = lineas.filter((l) => !!l.Preparada !== preparar);
      if (objetivo.length === 0) return;
      setPrepararTodoEnCurso(true);
      try {
        let estadoFinal: string | undefined;
        // Secuencial para que el recálculo de estado en backend converja sin carreras.
        for (const l of objetivo) {
          const res = await apiFetch(`/api/pedidos/${pedidoId}/lineas`, {
            method: 'PUT',
            body: JSON.stringify({ LineaIndex: String(l.LineaIndex ?? ''), Preparada: preparar }),
          });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || 'Error al preparar');
          if (data.estadoPedido) estadoFinal = data.estadoPedido;
        }
        const nuevasLineas = lineas.map((l) => ({ ...l, Preparada: preparar }));
        setLineas(nuevasLineas);
        aplicarEstadoPedido(pedidoId, estadoFinal, nuevasLineas);
      } catch (e) {
        alert((e as Error).message || 'Error al actualizar las líneas');
        fetchLineas(pedidoId);
      } finally {
        setPrepararTodoEnCurso(false);
      }
    },
    [pedidoSel, lineas, aplicarEstadoPedido, fetchLineas],
  );

  if (!hasPermiso('pedidos.preparar')) {
    return (
      <View style={[styles.container, styles.centro]}>
        <MaterialIcons name="lock-outline" size={32} color="#94a3b8" />
        <Text style={styles.sinPermisoText}>No tienes permiso para preparar pedidos de almacén.</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.volverBtn}>
          <Text style={styles.volverBtnText}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const progresoPedido = (p: Registro): { total: number; prep: number } => ({
    total: Number(valorEnLocal(p, 'LineasTotal') ?? 0),
    prep: Number(valorEnLocal(p, 'LineasPreparadas') ?? 0),
  });

  const renderToolbar = () => (
    <View style={styles.toolbar}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/compras' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Preparar pedidos</Text>
          <Text style={styles.subtitle}>Pedidos enviados por los locales · almacén</Text>
        </View>
        <TouchableOpacity onPress={refetch} style={styles.backBtn} accessibilityLabel="Recargar">
          <MaterialIcons name="refresh" size={22} color="#0ea5e9" />
        </TouchableOpacity>
      </View>

      <View style={styles.filtrosRow}>
        {hasPermiso('pedidos.crear') ? (
          <TouchableOpacity
            onPress={() => setNuevoPedidoVisible(true)}
            style={styles.nuevoBtn}
            activeOpacity={0.8}
            accessibilityLabel="Nuevo pedido"
          >
            <MaterialIcons name="add" size={20} color="#0f172a" />
            <Text style={styles.nuevoBtnText}>Nuevo pedido</Text>
          </TouchableOpacity>
        ) : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipsScroll}
          contentContainerStyle={styles.chipsRow}
        >
          {CHIPS.map((c) => {
            const activo = filtroEstado === c.key;
            const count =
              c.key === 'activos'
                ? (conteos.__activos ?? 0)
                : c.key
                  ? (conteos[c.key] ?? 0)
                  : (conteos.__todos ?? 0);
            return (
              <TouchableOpacity
                key={c.key ?? '__todos'}
                style={[styles.chip, activo && { backgroundColor: c.color, borderColor: c.color }]}
                onPress={() => {
                  setFiltroEstado(c.key);
                  cerrarPedido();
                }}
                activeOpacity={0.7}
              >
                <Text style={[styles.chipText, activo && styles.chipTextActivo]}>{c.label}</Text>
                <View style={[styles.chipBadge, activo && styles.chipBadgeActivo]}>
                  <Text style={[styles.chipBadgeText, activo && styles.chipBadgeTextActivo]}>{count}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <View style={styles.searchWrap}>
        <MaterialIcons name="search" size={18} color="#64748b" />
        <TextInput
          style={styles.searchInput}
          value={busqueda}
          onChangeText={setBusqueda}
          placeholder="Buscar por nº de pedido o local…"
          placeholderTextColor="#94a3b8"
        />
      </View>
    </View>
  );

  const renderListaContenido = () => (
    <View style={styles.listaContenido}>
      {loading ? (
        <View style={styles.listaVacio}>
          <ActivityIndicator size="large" color="#0ea5e9" />
        </View>
      ) : error ? (
        <View style={styles.listaVacio}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={refetch} style={styles.volverBtn}>
            <Text style={styles.volverBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : pedidosFiltrados.length === 0 ? (
        <View style={styles.listaVacio}>
          <MaterialIcons name="inventory-2" size={28} color="#94a3b8" />
          <Text style={styles.vacioText}>No hay pedidos en este estado.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.listaScrollContent} showsVerticalScrollIndicator>
          {pedidosFiltrados.map((p) => {
            const id = String(valorEnLocal(p, 'Id') ?? '');
            const estado = String(valorEnLocal(p, 'Estado') ?? '');
            const esDevolucion = String(valorEnLocal(p, 'Tipo') ?? '').trim() === 'Devolucion';
            const { total, prep } = progresoPedido(p);
            const pct = total > 0 ? Math.round((prep / total) * 100) : 0;
            const seleccionado = pedidoSel != null && String(valorEnLocal(pedidoSel, 'Id') ?? '') === id;
            return (
              <TouchableOpacity
                key={id}
                style={[styles.card, seleccionado && styles.cardSel]}
                onPress={() => abrirPedido(p)}
                activeOpacity={0.7}
              >
                <View style={styles.cardTopRow}>
                  <Text style={styles.cardId}>{id}</Text>
                  <View style={styles.cardBadges}>
                    {esDevolucion ? (
                      <View style={styles.devBadge}>
                        <MaterialIcons name="undo" size={11} color="#fff" />
                        <Text style={styles.estadoBadgeText}>Devolución</Text>
                      </View>
                    ) : null}
                    <View style={[styles.estadoBadge, { backgroundColor: colorEstado(estado) }]}>
                      <Text style={styles.estadoBadgeText}>{etiquetaEstado(estado)}</Text>
                    </View>
                  </View>
                </View>
                <Text style={styles.cardLocal} numberOfLines={1}>
                  {nombreLocal(p)}
                </Text>
                <View style={styles.cardBottomRow}>
                  <Text style={styles.cardFecha}>{formatFecha(valorEnLocal(p, 'Fecha'))}</Text>
                  <Text style={styles.cardTotal}>{formatMoneda(valorEnLocal(p, 'TotalAlbaran'))}</Text>
                </View>
                <View style={styles.progresoRow}>
                  <View style={styles.progresoBarBg}>
                    <View style={[styles.progresoBarFill, { width: `${pct}%`, backgroundColor: colorEstado(estado) }]} />
                  </View>
                  <Text style={styles.progresoText}>
                    {total > 0 ? `${prep}/${total}` : 'Sin líneas'}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );

  const renderDetalle = () => {
    if (!pedidoSel) {
      return (
        <View style={[styles.detalleWrap, styles.centro]}>
          <MaterialIcons name="touch-app" size={28} color="#94a3b8" />
          <Text style={styles.vacioText}>Selecciona un pedido para prepararlo.</Text>
        </View>
      );
    }
    const id = String(valorEnLocal(pedidoSel, 'Id') ?? '');
    const estado = String(valorEnLocal(pedidoSel, 'Estado') ?? '');
    const esDevolucion = String(valorEnLocal(pedidoSel, 'Tipo') ?? '').trim() === 'Devolucion';
    const notas = String(valorEnLocal(pedidoSel, 'Notas') ?? '').trim();
    const total = lineas.length;
    const prep = lineas.filter((l) => !!l.Preparada).length;
    const todasPreparadas = total > 0 && prep === total;

    return (
      <View style={styles.detalleWrap}>
        <View style={styles.detalleHeader}>
          <View style={{ flex: 1 }}>
            <View style={styles.detalleTitleRow}>
              <Text style={styles.detalleTitle} numberOfLines={1}>
                {id} · {nombreLocal(pedidoSel)}
              </Text>
              {esDevolucion ? (
                <View style={styles.devBadge}>
                  <MaterialIcons name="undo" size={11} color="#fff" />
                  <Text style={styles.estadoBadgeText}>Devolución</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.detalleSub}>
              {formatFecha(valorEnLocal(pedidoSel, 'Fecha'))} · {etiquetaEstado(estado)}
              {total > 0 ? ` · ${prep}/${total} preparadas` : ''}
            </Text>
          </View>
          {shouldStackPanels ? (
            <TouchableOpacity onPress={cerrarPedido} style={styles.cerrarBtn}>
              <MaterialIcons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          ) : null}
        </View>

        {notas ? (
          <View style={styles.notasBox}>
            <MaterialIcons name="sticky-note-2" size={16} color="#b45309" />
            <Text style={styles.notasText}>{notas}</Text>
          </View>
        ) : null}

        <View style={styles.accionesRow}>
          <TouchableOpacity
            style={[styles.accionBtn, styles.accionBtnPrimary, (prepararTodoEnCurso || todasPreparadas) && styles.accionBtnDisabled]}
            onPress={() => prepararTodo(true)}
            disabled={prepararTodoEnCurso || todasPreparadas || total === 0}
            activeOpacity={0.7}
          >
            {prepararTodoEnCurso ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialIcons name="done-all" size={18} color="#fff" />
            )}
            <Text style={styles.accionBtnPrimaryText}>Preparar todo</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.accionBtn, styles.accionBtnGhost, (prepararTodoEnCurso || prep === 0) && styles.accionBtnDisabled]}
            onPress={() => prepararTodo(false)}
            disabled={prepararTodoEnCurso || prep === 0}
            activeOpacity={0.7}
          >
            <MaterialIcons name="remove-done" size={18} color="#64748b" />
            <Text style={styles.accionBtnGhostText}>Desmarcar todo</Text>
          </TouchableOpacity>
        </View>

        {loadingLineas ? (
          <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 24 }} />
        ) : lineas.length === 0 ? (
          <Text style={styles.vacioText}>Este pedido no tiene líneas.</Text>
        ) : (
          <ScrollView style={styles.detalleScroll} contentContainerStyle={{ paddingBottom: 24, gap: 6 }} showsVerticalScrollIndicator>
            {lineas.map((l) => {
              const key = String(l.LineaIndex ?? '');
              const preparada = !!l.Preparada;
              const guardando = guardandoLinea === key;
              return (
                <TouchableOpacity
                  key={key}
                  style={[styles.linea, preparada && styles.lineaPreparada]}
                  onPress={() => toggleLinea(l)}
                  disabled={guardando || prepararTodoEnCurso}
                  activeOpacity={0.7}
                >
                  <View style={styles.lineaCheck}>
                    {guardando ? (
                      <ActivityIndicator size="small" color={preparada ? '#16a34a' : '#0ea5e9'} />
                    ) : (
                      <MaterialIcons
                        name={preparada ? 'check-circle' : 'radio-button-unchecked'}
                        size={26}
                        color={preparada ? '#16a34a' : '#94a3b8'}
                      />
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.lineaNombre, preparada && styles.lineaNombrePrep]} numberOfLines={2}>
                      {String(l.ProductoNombre || l.ProductId || '—')}
                    </Text>
                  </View>
                  <View style={styles.lineaCantidadBox}>
                    <Text style={styles.lineaCantidad}>{String(l.Cantidad ?? 0)}</Text>
                    <Text style={styles.lineaCantidadLabel}>uds</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
      </View>
    );
  };

  // Toolbar a ancho completo; debajo lista + detalle (split o modal en portrait).
  if (shouldStackPanels) {
    return (
      <View style={styles.container}>
        {renderToolbar()}
        {renderListaContenido()}
        <Modal visible={pedidoSel != null} animationType="slide" onRequestClose={cerrarPedido}>
          <View style={styles.modalContainer}>{renderDetalle()}</View>
        </Modal>
        <NuevoPedidoModal visible={nuevoPedidoVisible} onClose={() => setNuevoPedidoVisible(false)} onCreado={refetch} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {renderToolbar()}
      <View style={styles.splitRow}>
        <View style={styles.splitLista}>{renderListaContenido()}</View>
        <View style={styles.splitDetalle}>{renderDetalle()}</View>
      </View>
      <NuevoPedidoModal visible={nuevoPedidoVisible} onClose={() => setNuevoPedidoVisible(false)} onCreado={refetch} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#e2e8f0', padding: 12 },
  modalContainer: { flex: 1, backgroundColor: '#e2e8f0', padding: 12 },
  centro: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 40 },
  toolbar: { flexShrink: 0, marginBottom: 12, gap: 10 },
  splitRow: { flex: 1, flexDirection: 'row', gap: 12, minHeight: 0 },
  splitLista: { flex: 1, minWidth: 0, minHeight: 0 },
  splitDetalle: { width: '48%', maxWidth: '50%', minWidth: 320, minHeight: 0 },
  listaContenido: { flex: 1, minHeight: 0 },
  listaScrollContent: { paddingBottom: 24, gap: 8 },
  listaVacio: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 48, gap: 10 },
  detalleWrap: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#e2e8f0', minHeight: 0 },
  detalleScroll: { flex: 1 },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  filtrosRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chipsScroll: { flex: 1, flexGrow: 1, flexShrink: 1, maxHeight: MIN_TOUCH + 14 },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  nuevoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#ffedd5',
    borderWidth: 1,
    borderColor: '#fdba74',
  },
  nuevoBtnText: { fontSize: 14, fontWeight: '700', color: '#0f172a' },

  chipsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: MIN_TOUCH,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipText: { fontSize: 14, color: '#475569', fontWeight: '600' },
  chipTextActivo: { color: '#fff' },
  chipBadge: { minWidth: 22, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: '#e2e8f0', alignItems: 'center' },
  chipBadgeActivo: { backgroundColor: 'rgba(255,255,255,0.3)' },
  chipBadgeText: { fontSize: 12, fontWeight: '700', color: '#475569' },
  chipBadgeTextActivo: { color: '#fff' },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 10,
    minHeight: MIN_TOUCH,
  },
  searchInput: { flex: 1, fontSize: 15, color: '#334155', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) },

  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#e2e8f0', gap: 6 },
  cardSel: { borderColor: '#0ea5e9', borderWidth: 2 },
  cardTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardId: { fontSize: 15, fontWeight: '700', color: '#334155' },
  estadoBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  estadoBadgeText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  cardBadges: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  devBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: '#b45309' },
  detalleTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  cardLocal: { fontSize: 15, color: '#0f172a', fontWeight: '600' },
  cardBottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardFecha: { fontSize: 13, color: '#64748b' },
  cardTotal: { fontSize: 13, color: '#334155', fontWeight: '700' },
  progresoRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  progresoBarBg: { flex: 1, height: 8, borderRadius: 999, backgroundColor: '#e2e8f0', overflow: 'hidden' },
  progresoBarFill: { height: 8, borderRadius: 999 },
  progresoText: { fontSize: 12, color: '#64748b', fontWeight: '600', minWidth: 56, textAlign: 'right' },

  detalleHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  detalleTitle: { fontSize: 16, fontWeight: '700', color: '#334155' },
  detalleSub: { fontSize: 13, color: '#64748b', marginTop: 2 },
  cerrarBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#f1f5f9' },

  notasBox: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  notasText: { flex: 1, fontSize: 14, color: '#92400e' },

  accionesRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  accionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1,
  },
  accionBtnPrimary: { backgroundColor: '#16a34a', borderColor: '#16a34a' },
  accionBtnPrimaryText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  accionBtnGhost: { backgroundColor: '#fff', borderColor: '#e2e8f0' },
  accionBtnGhostText: { fontSize: 16, fontWeight: '600', color: '#64748b' },
  accionBtnDisabled: { opacity: 0.5 },

  linea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 56,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  lineaPreparada: { backgroundColor: '#f0fdf4', borderColor: '#86efac' },
  lineaCheck: { width: 30, alignItems: 'center', justifyContent: 'center' },
  lineaNombre: { fontSize: 15, color: '#334155', fontWeight: '500' },
  lineaNombrePrep: { color: '#15803d', fontWeight: '600' },
  lineaCantidadBox: { alignItems: 'center', minWidth: 48 },
  lineaCantidad: { fontSize: 17, fontWeight: '700', color: '#0f172a' },
  lineaCantidadLabel: { fontSize: 11, color: '#94a3b8' },

  sinPermisoText: { fontSize: 15, color: '#64748b', textAlign: 'center' },
  errorText: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
  vacioText: { fontSize: 14, color: '#64748b', textAlign: 'center' },
  volverBtn: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  volverBtnText: { fontSize: 14, fontWeight: '600', color: '#0ea5e9' },
});
