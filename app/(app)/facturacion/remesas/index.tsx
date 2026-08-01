import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { apiFetch } from '../../../utils/api';
import { formatMoneda } from '../../../utils/facturacion';
import { formatFecha } from '../../../utils/formatFecha';
import {
  colorEstadoRemesa,
  FILTROS_ESTADO_REMESA,
  labelEstadoRemesa,
} from '../../../lib/remesas';
import type { Remesa, EstadoRemesa } from '../../../types/remesas';

export default function RemesasIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackToolbar } = useBreakpoint();
  const puedeVer = hasPermiso('remesas.ver');
  const puedeGestionar = hasPermiso('remesas.gestionar');

  const [items, setItems] = useState<Remesa[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroEstado, setFiltroEstado] = useState<EstadoRemesa | 'todos'>('todos');

  const refetch = useCallback(() => {
    if (!puedeVer) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const q = filtroEstado !== 'todos' ? `?estado=${encodeURIComponent(filtroEstado)}` : '';
    apiFetch(`/api/remesas${q}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setItems(data.items || []);
      })
      .catch((e) => setError((e as Error).message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [filtroEstado, puedeVer]);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  if (!puedeVer) {
    return (
      <View style={styles.centered}>
        <Text style={styles.denied}>No tienes permiso para ver remesas de pago.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.pageContent}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => router.push('/facturacion' as never)}
          style={styles.backBtn}
          accessibilityLabel="Volver"
        >
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Remesas de pago</Text>
      </View>
      <Text style={styles.subtitle}>Agrupa facturas pendientes y genera el fichero para el banco</Text>

      <View style={[styles.toolbar, shouldStackToolbar && styles.toolbarStack]}>
        <View style={styles.toolbarSpacer} />
        <TouchableOpacity style={styles.btnSecondary} onPress={() => router.push('/facturacion/facturas-gasto' as never)}>
          <MaterialIcons name="description" size={18} color="#0ea5e9" />
          <Text style={styles.btnSecondaryText}>Ir a facturas recibidas</Text>
        </TouchableOpacity>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filtros}>
        {FILTROS_ESTADO_REMESA.map((f) => (
          <TouchableOpacity
            key={f.id}
            style={[styles.chip, filtroEstado === f.id && styles.chipActive]}
            onPress={() => setFiltroEstado(f.id)}
          >
            <Text style={[styles.chipText, filtroEstado === f.id && styles.chipTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {loading ? (
        <ActivityIndicator size="large" color="#0ea5e9" style={{ marginTop: 32 }} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : items.length === 0 ? (
        <View style={styles.empty}>
          <MaterialIcons name="account-balance" size={48} color="#94a3b8" />
          <Text style={styles.emptyText}>No hay remesas{puedeGestionar ? '. Selecciona facturas en Facturas recibidas.' : '.'}</Text>
        </View>
      ) : (
        <View style={styles.grid}>
          {items.map((r) => {
            const col = colorEstadoRemesa(r.estado);
            return (
              <TouchableOpacity
                key={r.remesaId}
                style={styles.card}
                onPress={() => router.push(`/facturacion/remesas/${r.remesaId}` as never)}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{r.nombre}</Text>
                  <View style={[styles.badge, { backgroundColor: col.bg }]}>
                    <Text style={[styles.badgeText, { color: col.text }]}>{labelEstadoRemesa(r.estado)}</Text>
                  </View>
                </View>
                <Text style={styles.cardMeta}>{r.sociedadNombre}</Text>
                <Text style={styles.cardMeta}>{r.lineas?.length || 0} facturas · {formatMoneda(r.importeTotal)}</Text>
                {r.creadoEn ? (
                  <Text style={styles.cardDate}>Creada {formatFecha(r.creadoEn.slice(0, 10))}</Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#e2e8f0' },
  pageContent: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  denied: { color: '#64748b', fontSize: 15 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  backBtn: { padding: 4 },
  toolbar: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'flex-start', marginBottom: 16, gap: 12 },
  toolbarStack: { flexDirection: 'column', alignItems: 'stretch' },
  toolbarSpacer: { flex: 1 },
  title: { fontSize: 22, fontWeight: '700', color: '#0f172a', flex: 1 },
  subtitle: { fontSize: 14, color: '#64748b', marginBottom: 12 },
  btnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  btnSecondaryText: { color: '#0ea5e9', fontWeight: '600', fontSize: 14 },
  filtros: { marginBottom: 16, maxHeight: 44 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#fff',
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  chipText: { color: '#475569', fontSize: 13, fontWeight: '500' },
  chipTextActive: { color: '#fff' },
  error: { color: '#b91c1c', marginTop: 16 },
  empty: { alignItems: 'center', marginTop: 48, gap: 12 },
  emptyText: { color: '#64748b', fontSize: 15, textAlign: 'center' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    minWidth: Platform.OS === 'web' ? 280 : '100%',
    flexGrow: 1,
    flexBasis: 280,
    maxWidth: Platform.OS === 'web' ? 360 : '100%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    ...Platform.select({
      web: { boxShadow: '0 1px 3px rgba(0,0,0,0.06)' as unknown as undefined },
      default: {},
    }),
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  cardTitle: { fontSize: 16, fontWeight: '600', color: '#0f172a', flex: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  cardMeta: { fontSize: 13, color: '#475569', marginBottom: 2 },
  cardDate: { fontSize: 12, color: '#94a3b8', marginTop: 8 },
});
