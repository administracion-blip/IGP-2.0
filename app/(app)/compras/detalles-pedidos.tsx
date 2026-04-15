import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { TablaBasica } from '../../components/TablaBasica';
import { fetchPorcentajeBeneficio, aplicarPorcentajeBeneficio } from '../../lib/personalizacion';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const COLUMNAS = ['PedidoId', 'LineaIndex', 'ProductId', 'ProductoNombre', 'Cantidad', 'PrecioUnitario', 'TotalLinea'];

type Pedido = Record<string, string | number | undefined>;
type Detalle = Record<string, string | number | undefined>;

function valorEnLocal(item: Record<string, unknown>, key: string): string | number | undefined {
  if (item[key] !== undefined && item[key] !== null) return item[key] as string | number;
  const found = Object.keys(item).find((k) => k.toLowerCase() === key.toLowerCase());
  return found != null ? (item[found] as string | number) : undefined;
}

function formatMoneda(val: string | number | undefined): string {
  if (val == null || String(val).trim() === '') return '—';
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  if (Number.isNaN(n)) return String(val);
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function DetallesPedidosScreen() {
  const router = useRouter();
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [pedidoSeleccionado, setPedidoSeleccionado] = useState<string | null>(null);
  const [details, setDetails] = useState<Detalle[]>([]);
  const [loadingPedidos, setLoadingPedidos] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [porcentajeBeneficio, setPorcentajeBeneficio] = useState(0);

  const refetchPedidos = useCallback(() => {
    setError(null);
    setLoadingPedidos(true);
    fetch(`${API_URL}/api/pedidos`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setPedidos(data.pedidos || []);
      })
      .catch((e) => setError(e.message || 'Error de conexión'))
      .finally(() => setLoadingPedidos(false));
  }, []);

  const refetchDetails = useCallback((pedidoId: string) => {
    setLoadingDetails(true);
    setError(null);
    fetch(`${API_URL}/api/pedidos/${encodeURIComponent(pedidoId)}/details`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setDetails(data.details || []);
      })
      .catch((e) => {
        setError(e.message || 'Error de conexión');
        setDetails([]);
      })
      .finally(() => setLoadingDetails(false));
  }, []);

  useEffect(() => {
    refetchPedidos();
  }, [refetchPedidos]);

  useEffect(() => {
    fetchPorcentajeBeneficio().then(setPorcentajeBeneficio);
  }, []);

  useEffect(() => {
    if (pedidoSeleccionado) refetchDetails(pedidoSeleccionado);
    else setDetails([]);
  }, [pedidoSeleccionado, refetchDetails]);

  const detailsFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return details;
    return details.filter((d) => {
      const texto = COLUMNAS.map((c) => String(valorEnLocal(d, c) ?? '')).join(' ').toLowerCase();
      return texto.includes(q);
    });
  }, [details, filtroBusqueda]);

  const getValorCelda = useCallback(
    (item: Detalle, col: string): string => {
      const v = valorEnLocal(item, col);
      if (col === 'PrecioUnitario' || col === 'TotalLinea') {
        const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
        if (Number.isNaN(n)) return v != null ? String(v) : '—';
        return formatMoneda(aplicarPorcentajeBeneficio(n, porcentajeBeneficio));
      }
      return v != null ? String(v) : '—';
    },
    [porcentajeBeneficio],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.subtitle}>Artículos asociados a cada pedido (Igp_PedidosDetails)</Text>

      <View style={styles.selectorWrap}>
        <Text style={styles.selectorLabel}>Pedido:</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsWrap} contentContainerStyle={styles.chipsContent}>
          {loadingPedidos ? (
            <ActivityIndicator size="small" color="#0ea5e9" style={styles.chipLoader} />
          ) : (
            <>
              <TouchableOpacity
                style={[styles.chip, !pedidoSeleccionado && styles.chipActive]}
                onPress={() => setPedidoSeleccionado(null)}
              >
                <Text style={[styles.chipText, !pedidoSeleccionado && styles.chipTextActive]}>Todos</Text>
              </TouchableOpacity>
              {pedidos.map((p) => {
                const id = String(valorEnLocal(p, 'Id') ?? '');
                const sel = pedidoSeleccionado === id;
                return (
                  <TouchableOpacity
                    key={id}
                    style={[styles.chip, sel && styles.chipActive]}
                    onPress={() => setPedidoSeleccionado(id)}
                  >
                    <Text style={[styles.chipText, sel && styles.chipTextActive]} numberOfLines={1}>
                      {id || '—'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </>
          )}
        </ScrollView>
      </View>

      {!pedidoSeleccionado ? (
        <View style={styles.emptyState}>
          <MaterialIcons name="info-outline" size={48} color="#94a3b8" />
          <Text style={styles.emptyText}>Selecciona un pedido para ver sus artículos</Text>
        </View>
      ) : (
        <TablaBasica<Detalle>
          title={`Detalles Pedidos - ${pedidoSeleccionado}`}
          onBack={() => router.back()}
          columnas={[...COLUMNAS]}
          datos={detailsFiltrados}
          getValorCelda={getValorCelda}
          loading={loadingDetails}
          error={error}
          onRetry={() => pedidoSeleccionado && refetchDetails(pedidoSeleccionado)}
          filtroBusqueda={filtroBusqueda}
          onFiltroChange={setFiltroBusqueda}
          selectedRowIndex={selectedRowIndex}
          onSelectRow={setSelectedRowIndex}
          onCrear={() => {}}
          onEditar={() => {}}
          onBorrar={() => {}}
          columnasMoneda={['PrecioUnitario', 'TotalLinea']}
          emptyMessage="No hay artículos en este pedido"
          emptyFilterMessage="Ningún artículo coincide con el filtro"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  subtitle: { fontSize: 14, color: '#64748b', marginBottom: 12 },
  selectorWrap: { marginBottom: 12 },
  selectorLabel: { fontSize: 12, fontWeight: '600', color: '#64748b', marginBottom: 6 },
  chipsWrap: { maxHeight: 40 },
  chipsContent: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chipLoader: { paddingHorizontal: 16 },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  chipText: { fontSize: 12, color: '#64748b', fontWeight: '500' },
  chipTextActive: { color: '#fff' },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 48,
  },
  emptyText: { fontSize: 14, color: '#94a3b8' },
});
