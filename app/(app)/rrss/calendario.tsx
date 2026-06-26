import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch } from '../../utils/api';
import { useMarketingLocales, valorEnLocal } from './LocalesContext';
import { formatId6 } from './lib/formatId6';
import { dmyToIso, finMesActualDmy, inicioMesActualDmy, isoToDmy } from './lib/fechasUi';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';

type Propuesta = {
  id_propuesta: string;
  id_local: string;
  tipo: string;
  redes: string[];
  fecha_sugerida: string;
  descripcion: string;
  estado: string;
};

const ESTADOS = ['', 'aprobada', 'publicada', 'pendiente', 'rechazada'] as const;
const ESTADO_LABELS: Record<string, string> = {
  '': 'Todas',
  aprobada: 'Aprobadas',
  publicada: 'Publicadas',
  pendiente: 'Pendientes',
  rechazada: 'Rechazadas',
};

function badgeStyles(estado: string): { backgroundColor: string; color: string } {
  switch (estado) {
    case 'pendiente':
      return { backgroundColor: '#fef3c7', color: '#b45309' };
    case 'aprobada':
      return { backgroundColor: '#d1fae5', color: '#047857' };
    case 'rechazada':
      return { backgroundColor: '#fee2e2', color: '#b91c1c' };
    case 'publicada':
      return { backgroundColor: '#dbeafe', color: '#1e40af' };
    default:
      return { backgroundColor: '#f1f5f9', color: '#475569' };
  }
}

export default function CalendarioScreen() {
  const router = useRouter();
  const { locales } = useMarketingLocales();

  const [fechaDesde, setFechaDesde] = useState(inicioMesActualDmy());
  const [fechaHasta, setFechaHasta] = useState(finMesActualDmy());
  const [estado, setEstado] = useState<string>('aprobada');
  const [idLocal, setIdLocal] = useState('');

  const [propuestas, setPropuestas] = useState<Propuesta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localesMap = useMemo(() => {
    const m: Record<string, string> = {};
    locales.forEach((l) => {
      const id = formatId6(valorEnLocal(l, 'id_Locales'));
      const nombre = valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? id;
      if (id) m[id] = nombre;
    });
    return m;
  }, [locales]);

  const refetch = useCallback(() => {
    let isoDesde = '';
    let isoHasta = '';
    if (fechaDesde.trim()) {
      isoDesde = dmyToIso(fechaDesde) || '';
      if (!isoDesde) {
        setError('La fecha «Desde» no es válida (usa DD/MM/AAAA).');
        return;
      }
    }
    if (fechaHasta.trim()) {
      isoHasta = dmyToIso(fechaHasta) || '';
      if (!isoHasta) {
        setError('La fecha «Hasta» no es válida (usa DD/MM/AAAA).');
        return;
      }
    }
    const params = new URLSearchParams();
    if (idLocal) params.set('id_local', idLocal);
    if (estado) params.set('estado', estado);
    if (isoDesde) params.set('fecha_desde', isoDesde);
    if (isoHasta) params.set('fecha_hasta', isoHasta);
    setLoading(true);
    setError(null);
    apiFetch(`/api/marketing/propuestas?${params.toString()}`)
      .then((res) => res.json())
      .then((data: { propuestas?: Propuesta[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        setPropuestas(Array.isArray(data.propuestas) ? data.propuestas : []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [idLocal, estado, fechaDesde, fechaHasta]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Agrupa por fecha (asc) y dentro por hora de creación.
  const agrupadas = useMemo(() => {
    const map = new Map<string, Propuesta[]>();
    [...propuestas]
      .sort((a, b) => (a.fecha_sugerida || '').localeCompare(b.fecha_sugerida || ''))
      .forEach((p) => {
        const k = p.fecha_sugerida || 'sin-fecha';
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(p);
      });
    return Array.from(map.entries());
  }, [propuestas]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <Text style={styles.title}>Calendario</Text>
      </View>

      <View style={styles.filtersWrap}>
        <View style={styles.row}>
          <View style={styles.field}>
            <Text style={styles.label}>Desde</Text>
            <InputFecha value={fechaDesde} onChange={setFechaDesde} format="dmy" placeholder="DD/MM/AAAA" style={styles.dateInput} />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Hasta</Text>
            <InputFecha value={fechaHasta} onChange={setFechaHasta} format="dmy" placeholder="DD/MM/AAAA" style={styles.dateInput} />
          </View>
        </View>

        <View style={styles.field}>
          <SelectorDesplegable
            label="Local"
            icono="store"
            placeholder="Todos los locales"
            tituloLista="Filtrar por local"
            iconoLista="store"
            valorId={idLocal}
            opciones={[
              { id: '', titulo: 'Todos los locales', icono: 'public' },
              ...locales.map((l) => {
                const id = formatId6(valorEnLocal(l, 'id_Locales'));
                const nombre = valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? id;
                return { id, titulo: nombre || id || '—', icono: 'store' as const };
              }),
            ]}
            onSeleccionar={setIdLocal}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Estado</Text>
          <View style={styles.chipRow}>
            {ESTADOS.map((e) => (
              <TouchableOpacity
                key={e || 'todos'}
                style={[styles.chip, estado === e && styles.chipSelected]}
                onPress={() => setEstado(e)}
              >
                <Text style={[styles.chipText, estado === e && styles.chipTextSelected]}>{ESTADO_LABELS[e]}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <MaterialIcons name="error-outline" size={18} color="#f87171" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refetch} colors={['#0ea5e9']} tintColor="#0ea5e9" />}
      >
        {loading && propuestas.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#0ea5e9" />
          </View>
        ) : agrupadas.length === 0 ? (
          <View style={styles.empty}>
            <MaterialIcons name="event-busy" size={32} color="#94a3b8" />
            <Text style={styles.emptyText}>No hay propuestas en este rango.</Text>
          </View>
        ) : (
          agrupadas.map(([fecha, items]) => (
            <View key={fecha} style={styles.dayBlock}>
              <View style={styles.dayHeader}>
                <Text style={styles.dayTitle}>{fecha === 'sin-fecha' ? 'Sin fecha' : isoToDmy(fecha) || fecha}</Text>
                <Text style={styles.dayCount}>{items.length}</Text>
              </View>
              {items.map((p) => {
                const estilo = badgeStyles(p.estado);
                const localNombre = localesMap[formatId6(p.id_local)] ?? p.id_local;
                return (
                  <TouchableOpacity
                    key={p.id_propuesta}
                    style={styles.card}
                    onPress={() => router.push(`/rrss/propuesta/${p.id_propuesta}`)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.cardHeader}>
                      <Text style={styles.cardTipo}>{p.tipo}</Text>
                      <View style={[styles.badge, { backgroundColor: estilo.backgroundColor }]}>
                        <Text style={[styles.badgeText, { color: estilo.color }]}>{p.estado}</Text>
                      </View>
                    </View>
                    <Text style={styles.cardDesc} numberOfLines={2}>{p.descripcion}</Text>
                    <View style={styles.cardFooter}>
                      <View style={styles.cardMeta}>
                        <MaterialIcons name="store" size={13} color="#64748b" />
                        <Text style={styles.cardMetaText} numberOfLines={1}>{localNombre}</Text>
                      </View>
                      <View style={styles.cardMeta}>
                        <MaterialIcons name="share" size={13} color="#64748b" />
                        <Text style={styles.cardMetaText}>{(p.redes ?? []).join(', ') || '—'}</Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  headerBtn: { padding: 6 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  filtersWrap: { padding: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  row: { flexDirection: 'row', gap: 10 },
  field: { flex: 1, gap: 6 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569' },
  dateInput: {
    fontSize: 13,
    paddingVertical: 8,
    paddingHorizontal: 10,
    color: '#334155',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 6 },
  chipSelected: { borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  chipText: { fontSize: 11, color: '#475569' },
  chipTextSelected: { color: '#0ea5e9', fontWeight: '600' },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, margin: 12, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8 },
  errorText: { fontSize: 12, color: '#dc2626', flex: 1 },
  retryBtn: { paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#fff', borderRadius: 6 },
  retryBtnText: { fontSize: 12, color: '#dc2626', fontWeight: '600' },
  list: { flex: 1 },
  listContent: { padding: 12, gap: 16, paddingBottom: 24 },
  center: { paddingVertical: 32, alignItems: 'center' },
  empty: { paddingVertical: 32, alignItems: 'center', gap: 8 },
  emptyText: { fontSize: 13, color: '#64748b' },
  dayBlock: { gap: 8 },
  dayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  dayTitle: { fontSize: 14, fontWeight: '700', color: '#334155' },
  dayCount: { fontSize: 12, color: '#64748b' },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', padding: 12, gap: 6 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTipo: { fontSize: 13, fontWeight: '700', color: '#334155' },
  badge: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 10 },
  badgeText: { fontSize: 10, fontWeight: '600', textTransform: 'capitalize' },
  cardDesc: { fontSize: 12, color: '#475569' },
  cardFooter: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardMetaText: { fontSize: 11, color: '#64748b' },
});
