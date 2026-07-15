import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { apiFetch } from '../../../utils/api';
import { formatFecha } from '../../../utils/formatFecha';
import { CampanaFormModal } from '../../../components/CampanaFormModal';
import {
  colorEstadoCampana,
  FILTROS_ESTADO_CAMPANA,
  etiquetaTipoIncentivo,
} from '../../../lib/incentivosProducto';
import type { Campana, EstadoCampana, ResultadosCampana } from '../../../types/incentivosProducto';

type CampanaConResultado = Campana & {
  resultadoNeto?: number | null;
  cargandoResultado?: boolean;
};

export default function IncentivosProductoIndexScreen() {
  const router = useRouter();
  const { hasPermiso, localPermitido } = useAuth();
  const { shouldStackToolbar } = useBreakpoint();
  const puedeGestionar = hasPermiso('incentivos_producto.gestionar');
  const puedeVer = hasPermiso('incentivos_producto.ver');

  const [items, setItems] = useState<CampanaConResultado[]>([]);
  const [localesMap, setLocalesMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroEstado, setFiltroEstado] = useState<EstadoCampana | 'todos'>('Activa');
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editarCampana, setEditarCampana] = useState<Campana | null>(null);

  const cargarResultado = useCallback(async (campanaId: string): Promise<number | null> => {
    try {
      const res = await apiFetch(`/api/campanas/${campanaId}/resultados`);
      const data = (await res.json()) as ResultadosCampana;
      if (!res.ok) return null;
      return data.totales?.resultadoNeto ?? null;
    } catch {
      return null;
    }
  }, []);

  const refetch = useCallback(() => {
    if (!puedeVer) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const q = filtroEstado !== 'todos' ? `?estado=${encodeURIComponent(filtroEstado)}` : '';
    Promise.all([
      apiFetch(`/api/campanas${q}`).then((r) => r.json()),
      apiFetch('/api/locales').then((r) => r.json()),
    ])
      .then(async ([dataCamp, dataLoc]) => {
        if (dataCamp.error) throw new Error(dataCamp.error);
        const map: Record<string, string> = {};
        for (const l of dataLoc.locales || []) {
          const id = String(l.id_Locales ?? '').trim();
          const nombre = String(l.nombre ?? l.Nombre ?? id).trim();
          if (id) map[id] = nombre;
        }
        setLocalesMap(map);

        let lista: Campana[] = (dataCamp.items || []).filter((c: Campana) => {
          if (!c.locales?.length) return true;
          return c.locales.some((lid) => {
            const nombre = map[lid];
            return nombre ? localPermitido(nombre) : true;
          });
        });

        const conResultado: CampanaConResultado[] = lista.map((c) => ({
          ...c,
          resultadoNeto: null,
          cargandoResultado: c.estado === 'Activa' || c.estado === 'Finalizada',
        }));
        setItems(conResultado);

        const paraResultados = conResultado.filter((c) => c.cargandoResultado);
        await Promise.all(
          paraResultados.map(async (c) => {
            const neto = await cargarResultado(c.campanaId);
            setItems((prev) =>
              prev.map((x) =>
                x.campanaId === c.campanaId
                  ? { ...x, resultadoNeto: neto, cargandoResultado: false }
                  : x,
              ),
            );
          }),
        );
      })
      .catch((e) => setError((e as Error).message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [filtroEstado, puedeVer, localPermitido, cargarResultado]);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  const abrirNueva = () => {
    setEditarCampana(null);
    setModalAbierto(true);
  };

  const confirmarBorrar = (c: Campana) => {
    const run = async () => {
      try {
        const res = await apiFetch(`/api/campanas/${c.campanaId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo borrar');
        refetch();
      } catch (e) {
        setError((e as Error).message);
      }
    };
    if (Platform.OS === 'web') {
      if (window.confirm(`¿Borrar la campaña «${c.nombre}»?`)) run();
    } else {
      Alert.alert('Borrar campaña', `¿Seguro que quieres borrar «${c.nombre}»?`, [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Borrar', style: 'destructive', onPress: run },
      ]);
    }
  };

  const resumenLocales = useCallback(
    (c: Campana) => {
      const nombres = (c.locales || [])
        .map((id) => localesMap[id] || id)
        .slice(0, 3);
      const extra = (c.locales?.length || 0) - nombres.length;
      const txt = nombres.join(', ');
      return extra > 0 ? `${txt} +${extra}` : txt || '—';
    },
    [localesMap],
  );

  if (!puedeVer) {
    return (
      <View style={styles.container}>
        <Text style={styles.sinPermiso}>No tienes permiso para ver incentivos por producto.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.toolbar, shouldStackToolbar && styles.toolbarStack]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.replace('/cajas')}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <View style={styles.tituloBlock}>
          <Text style={styles.title}>Incentivos por producto</Text>
          <Text style={styles.subtitle}>Premios al equipo por vender productos concretos</Text>
        </View>
        {puedeGestionar ? (
          <TouchableOpacity style={styles.btnNuevo} onPress={abrirNueva}>
            <MaterialIcons name="add" size={20} color="#fff" />
            <Text style={styles.btnNuevoText}>Nueva</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsScroll}>
        <View style={styles.chipsRow}>
          {FILTROS_ESTADO_CAMPANA.map((f) => (
            <TouchableOpacity
              key={f.key}
              style={[styles.chip, filtroEstado === f.key && styles.chipActivo]}
              onPress={() => setFiltroEstado(f.key)}
            >
              <Text style={[styles.chipText, filtroEstado === f.key && styles.chipTextActivo]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 32 }} color="#0ea5e9" />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={styles.vacio}>No hay campañas con este filtro.</Text>
      ) : (
        <ScrollView style={styles.lista} contentContainerStyle={styles.listaContent}>
          {items.map((c) => {
            const semaforo =
              c.resultadoNeto == null
                ? null
                : c.resultadoNeto >= 0
                  ? 'verde'
                  : 'rojo';
            return (
              <TouchableOpacity
                key={c.campanaId}
                style={styles.card}
                onPress={() => router.push(`/cajas/incentivos-producto/${c.campanaId}`)}
                activeOpacity={0.75}
              >
                <View style={styles.cardTop}>
                  <Text style={styles.cardNombre} numberOfLines={2}>{c.nombre}</Text>
                  <View style={[styles.estadoBadge, { backgroundColor: colorEstadoCampana(c.estado) + '22' }]}>
                    <Text style={[styles.estadoText, { color: colorEstadoCampana(c.estado) }]}>
                      {c.estado}
                    </Text>
                  </View>
                </View>
                <Text style={styles.cardMeta}>
                  {formatFecha(c.fechaInicio)} — {formatFecha(c.fechaFin)}
                </Text>
                <Text style={styles.cardMeta} numberOfLines={1}>
                  {resumenLocales(c)} · {c.productos?.length || 0} producto(s)
                </Text>
                <Text style={styles.cardMeta}>
                  {etiquetaTipoIncentivo(c.tipoIncentivo)} · {c.valorIncentivo}
                </Text>
                <View style={styles.cardFooter}>
                  {c.cargandoResultado ? (
                    <ActivityIndicator size="small" color="#94a3b8" />
                  ) : semaforo ? (
                    <View style={styles.semaforoRow}>
                      <View
                        style={[
                          styles.semaforo,
                          { backgroundColor: semaforo === 'verde' ? '#16a34a' : '#dc2626' },
                        ]}
                      />
                      <Text style={styles.semaforoText}>
                        {c.resultadoNeto != null && c.resultadoNeto >= 0 ? 'Rentable' : 'Revisar'}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.sinResultado}>Sin resultados aún</Text>
                  )}
                  {puedeGestionar && (c.estado === 'Borrador' || c.estado === 'Archivada') ? (
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.();
                        confirmarBorrar(c);
                      }}
                      hitSlop={8}
                    >
                      <MaterialIcons name="delete-outline" size={20} color="#94a3b8" />
                    </TouchableOpacity>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      <CampanaFormModal
        visible={modalAbierto}
        onClose={() => setModalAbierto(false)}
        onSaved={refetch}
        campana={editarCampana}
        puedeGestionar={puedeGestionar}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, backgroundColor: '#e2e8f0' },
  sinPermiso: { padding: 24, textAlign: 'center', color: '#64748b' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  toolbarStack: { flexWrap: 'wrap' },
  backBtn: { padding: 6 },
  tituloBlock: { flex: 1 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  btnNuevo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnNuevoText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  chipsScroll: { maxHeight: 44, marginBottom: 12 },
  chipsRow: { flexDirection: 'row', gap: 8, paddingRight: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipActivo: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  chipText: { fontSize: 13, color: '#64748b' },
  chipTextActivo: { color: '#0369a1', fontWeight: '600' },
  lista: { flex: 1 },
  listaContent: { gap: 10, paddingBottom: 24 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' },
  cardNombre: { flex: 1, fontSize: 16, fontWeight: '600', color: '#334155' },
  estadoBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  estadoText: { fontSize: 11, fontWeight: '700' },
  cardMeta: { fontSize: 13, color: '#64748b', marginTop: 4 },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  semaforoRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  semaforo: { width: 10, height: 10, borderRadius: 5 },
  semaforoText: { fontSize: 13, fontWeight: '600', color: '#475569' },
  sinResultado: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  error: { color: '#dc2626', padding: 16 },
  vacio: { textAlign: 'center', color: '#94a3b8', marginTop: 40, fontSize: 15 },
});
