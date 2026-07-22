import { useCallback, useMemo, useState } from 'react';
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
import { formatMoneda } from '../../../utils/formatMoneda';
import { CampanaFormModal } from '../../../components/CampanaFormModal';
import {
  colorEstadoCampana,
  CHIP_ESTADO_CAMPANA_PASTEL,
  FILTROS_ESTADO_CAMPANA,
  etiquetaTipoIncentivo,
} from '../../../lib/incentivosProducto';
import type { Campana, EstadoCampana, ResultadosCampana } from '../../../types/incentivosProducto';

type CampanaConResultado = Campana & {
  resultadoNeto?: number | null;
  cargandoResultado?: boolean;
};

function KpiCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.kpiValue, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

export default function IncentivosProductoIndexScreen() {
  const router = useRouter();
  const { hasPermiso, localPermitido } = useAuth();
  const { shouldStackPanels } = useBreakpoint();
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
    Promise.all([
      apiFetch('/api/campanas').then((r) => r.json()),
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

        const lista: Campana[] = (dataCamp.items || []).filter((c: Campana) => {
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
  }, [puedeVer, localPermitido, cargarResultado]);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  const itemsFiltrados = useMemo(() => {
    if (filtroEstado === 'todos') return items;
    return items.filter((c) => c.estado === filtroEstado);
  }, [items, filtroEstado]);

  const conteoPorEstado = useMemo(() => {
    const counts: Record<string, number> = {
      todos: items.length,
      Activa: 0,
      Borrador: 0,
      Finalizada: 0,
      Archivada: 0,
    };
    for (const c of items) {
      if (counts[c.estado] != null) counts[c.estado]++;
    }
    return counts;
  }, [items]);

  const resumenKpi = useMemo(() => {
    const visibles = itemsFiltrados;
    const conNeto = visibles.filter((c) => c.resultadoNeto != null && !c.cargandoResultado);
    const sumNeto = conNeto.reduce((a, c) => a + (c.resultadoNeto ?? 0), 0);
    const rentables = conNeto.filter((c) => (c.resultadoNeto ?? 0) >= 0).length;
    return {
      total: visibles.length,
      activas: visibles.filter((c) => c.estado === 'Activa').length,
      sumNeto,
      rentables,
      conNeto: conNeto.length,
    };
  }, [itemsFiltrados]);

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
        .slice(0, 2);
      const extra = (c.locales?.length || 0) - nombres.length;
      const txt = nombres.join(', ');
      return extra > 0 ? `${txt} +${extra}` : txt || '—';
    },
    [localesMap],
  );

  if (!puedeVer) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
        <Text style={styles.emptyText}>No tienes permiso para ver incentivos por producto.</Text>
      </View>
    );
  }

  const panelLista = (
    <View style={[styles.panelLista, !shouldStackPanels && styles.panelListaBorder]}>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color="#0ea5e9" /></View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {itemsFiltrados.length === 0 ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name="emoji-events" size={40} color="#cbd5e1" />
              <Text style={styles.emptyText}>No hay campañas con este filtro.</Text>
            </View>
          ) : itemsFiltrados.map((c) => {
            const ec = colorEstadoCampana(c.estado);
            const sem =
              c.resultadoNeto == null
                ? null
                : c.resultadoNeto >= 0
                  ? 'verde'
                  : 'rojo';
            return (
              <TouchableOpacity
                key={c.campanaId}
                activeOpacity={0.7}
                onPress={() => router.push(`/cajas/incentivos-producto/${c.campanaId}`)}
                style={styles.card}
              >
                <View style={styles.cardHeader}>
                  <View style={styles.cardTitleWrap}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{c.nombre}</Text>
                    <View style={[styles.badge, { backgroundColor: ec + '18', borderColor: ec }]}>
                      <Text style={[styles.badgeText, { color: ec }]}>{c.estado}</Text>
                    </View>
                    {sem ? (
                      <View
                        style={[
                          styles.dotSem,
                          { backgroundColor: sem === 'verde' ? '#16a34a' : '#dc2626' },
                        ]}
                      />
                    ) : null}
                  </View>
                  <View style={styles.cardActions}>
                    {puedeGestionar && (c.estado === 'Borrador' || c.estado === 'Archivada') ? (
                      <TouchableOpacity
                        onPress={(e) => {
                          if (Platform.OS === 'web' && e && 'stopPropagation' in e) {
                            (e as unknown as { stopPropagation: () => void }).stopPropagation();
                          }
                          confirmarBorrar(c);
                        }}
                        style={styles.cardActionBtn}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <MaterialIcons name="delete-outline" size={18} color="#ef4444" />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
                <View style={styles.cardBody}>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Periodo</Text>
                    <Text style={styles.cardFieldValue}>
                      {formatFecha(c.fechaInicio)} — {formatFecha(c.fechaFin)}
                    </Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Locales</Text>
                    <Text style={styles.cardFieldValue} numberOfLines={1}>{resumenLocales(c)}</Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Productos</Text>
                    <Text style={styles.cardFieldValue}>{c.productos?.length || 0}</Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Incentivo</Text>
                    <Text style={styles.cardFieldValue} numberOfLines={1}>
                      {etiquetaTipoIncentivo(c.tipoIncentivo)} · {c.valorIncentivo}
                    </Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Resultado neto</Text>
                    {c.cargandoResultado ? (
                      <ActivityIndicator size="small" color="#94a3b8" />
                    ) : c.resultadoNeto != null ? (
                      <Text
                        style={[
                          styles.cardFieldValue,
                          {
                            fontWeight: '700',
                            color: c.resultadoNeto >= 0 ? '#16a34a' : '#dc2626',
                          },
                        ]}
                      >
                        {formatMoneda(c.resultadoNeto)}
                      </Text>
                    ) : (
                      <Text style={[styles.cardFieldValue, { color: '#94a3b8', fontStyle: 'italic' }]}>
                        Sin datos
                      </Text>
                    )}
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );

  const panelResumen = (
    <View style={styles.panelKpi}>
      <Text style={styles.sectionTitle}>Resumen del filtro</Text>
      <View style={styles.kpiRow}>
        <KpiCard label="Campañas" value={String(resumenKpi.total)} />
        <KpiCard label="Activas" value={String(resumenKpi.activas)} color="#16a34a" />
      </View>
      <View style={styles.kpiRow}>
        <KpiCard
          label="Resultado neto"
          value={resumenKpi.conNeto ? formatMoneda(resumenKpi.sumNeto) : '—'}
          color={resumenKpi.sumNeto >= 0 ? '#16a34a' : '#dc2626'}
        />
        <KpiCard label="Rentables" value={`${resumenKpi.rentables}/${resumenKpi.conNeto || 0}`} />
      </View>
      <Text style={styles.resumenHint}>
        Premios al equipo por vender productos concretos. El resultado neto combina margen incremental menos coste del incentivo.
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace('/cajas')} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Incentivos por producto</Text>
        {puedeGestionar ? (
          <TouchableOpacity style={styles.createBtn} onPress={abrirNueva}>
            <MaterialIcons name="add" size={16} color="#fff" />
            <Text style={styles.createBtnText}>Nueva</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.toolbar}>
        <View style={styles.chipRowEstado}>
          {FILTROS_ESTADO_CAMPANA.map((f) => {
            const key = f.key;
            const pastel = CHIP_ESTADO_CAMPANA_PASTEL[key] ?? CHIP_ESTADO_CAMPANA_PASTEL.todos;
            const sel = filtroEstado === key;
            const n = conteoPorEstado[key] ?? 0;
            return (
              <TouchableOpacity
                key={key}
                style={[
                  styles.estadoChip,
                  {
                    backgroundColor: sel ? pastel.bgSel : pastel.bg,
                    borderColor: sel ? pastel.borderSel : pastel.border,
                  },
                ]}
                onPress={() => setFiltroEstado(key)}
                activeOpacity={0.75}
              >
                <Text style={[styles.estadoChipText, { color: pastel.text }, sel && styles.estadoChipTextSel]}>
                  {f.label}
                </Text>
                <View style={[styles.estadoChipCount, sel && styles.estadoChipCountSel]}>
                  <Text style={[styles.estadoChipCountText, { color: pastel.text }, sel && styles.estadoChipTextSel]}>
                    {n}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {error ? (
        <View style={styles.errorBar}><Text style={styles.errorText}>{error}</Text></View>
      ) : null}

      <View style={[styles.split, shouldStackPanels && styles.splitStack]}>
        {panelLista}
        <View style={[styles.panelKpiWrap, !shouldStackPanels && styles.panelKpiWrapSide, shouldStackPanels && styles.panelKpiWrapStack]}>
          {panelResumen}
        </View>
      </View>

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
  container: { flex: 1, backgroundColor: '#f8fafc' },
  center: { padding: 40, alignItems: 'center', gap: 8 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 12,
  },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: '#0f172a' },
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  createBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  toolbar: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipRowEstado: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  estadoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  estadoChipText: { fontSize: 11, fontWeight: '600' },
  estadoChipTextSel: { fontWeight: '800' },
  estadoChipCount: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: 'rgba(15,23,42,0.06)',
    alignItems: 'center',
  },
  estadoChipCountSel: { backgroundColor: 'rgba(15,23,42,0.10)' },
  estadoChipCountText: { fontSize: 10, fontWeight: '700' },

  errorBar: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: { fontSize: 12, color: '#dc2626' },

  split: { flex: 1, flexDirection: 'row', minHeight: 0 },
  splitStack: { flexDirection: 'column' },
  panelLista: { flex: 1, minWidth: 0 },
  panelListaBorder: { borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  panelKpiWrap: { minWidth: 280, backgroundColor: '#fff' },
  panelKpiWrapSide: { flex: 0.42, maxWidth: 420 },
  panelKpiWrapStack: { flex: undefined, borderTopWidth: 1, borderTopColor: '#e2e8f0' },

  list: { flex: 1 },
  listContent: { padding: 12, gap: 10, paddingBottom: 24 },

  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a', flexShrink: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  dotSem: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  cardActionBtn: { padding: 6 },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: 8 },
  cardField: { minWidth: 84, marginRight: 8 },
  cardFieldLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontSize: 13, color: '#334155' },

  panelKpi: { flex: 1, padding: 12, gap: 10 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  kpiRow: { flexDirection: 'row', gap: 6 },
  kpiCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  kpiLabel: { fontSize: 9, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  kpiValue: { fontSize: 15, fontWeight: '800', color: '#0f172a', marginTop: 2 },
  resumenHint: { fontSize: 11, color: '#94a3b8', lineHeight: 16, marginTop: 4 },
});
