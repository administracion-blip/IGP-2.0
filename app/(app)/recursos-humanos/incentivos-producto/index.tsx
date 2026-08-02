import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { apiFetch } from '../../../utils/api';
import { formatMoneda } from '../../../utils/formatMoneda';
import { CampanaFormModal } from '../../../components/CampanaFormModal';
import { CampanaIncentivoCard } from '../../../components/incentivos/CampanaIncentivoCard';
import { VentasSyncAviso } from '../../../components/VentasSyncAviso';
import {
  CHIP_ESTADO_CAMPANA_PASTEL,
  FILTROS_ESTADO_CAMPANA,
} from '../../../lib/incentivosProducto';
import { estadoEfectivoCampana, campanaSePuedeBorrar } from '../../../lib/campanaEstado';
import { useConfirmar } from '../../../hooks/useConfirmar';
import type { Campana, EstadoCampana, ResultadosCampana } from '../../../types/incentivosProducto';

type CampanaConResultado = Campana & {
  costeIncentivo?: number | null;
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
  const puedeBorrar = hasPermiso('incentivos_producto.borrar');
  const puedeVer = hasPermiso('incentivos_producto.ver');
  const { confirmar, ConfirmarView } = useConfirmar();

  const [items, setItems] = useState<CampanaConResultado[]>([]);
  const [localesMap, setLocalesMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroEstado, setFiltroEstado] = useState<EstadoCampana | 'todos'>('Activa');
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editarCampana, setEditarCampana] = useState<Campana | null>(null);
  const [modoDuplicar, setModoDuplicar] = useState(false);

  const cargarResultado = useCallback(async (campanaId: string): Promise<number | null> => {
    try {
      const res = await apiFetch(`/api/campanas/${campanaId}/resultados`);
      const data = (await res.json()) as ResultadosCampana;
      if (!res.ok) return null;
      return data.totales?.costeIncentivo ?? null;
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

        const conResultado: CampanaConResultado[] = lista.map((c) => {
          const estado = estadoEfectivoCampana(c);
          return {
            ...c,
            estado,
            costeIncentivo: null,
            cargandoResultado: estado === 'Activa' || estado === 'Finalizada' || estado === 'Bonificada',
          };
        });
        setItems(conResultado);

        const paraResultados = conResultado.filter((c) => c.cargandoResultado);
        await Promise.all(
          paraResultados.map(async (c) => {
            const neto = await cargarResultado(c.campanaId);
            setItems((prev) =>
              prev.map((x) =>
                x.campanaId === c.campanaId
                  ? { ...x, costeIncentivo: neto, cargandoResultado: false }
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
    return items.filter((c) => estadoEfectivoCampana(c) === filtroEstado);
  }, [items, filtroEstado]);

  const conteoPorEstado = useMemo(() => {
    const counts: Record<string, number> = {
      todos: items.length,
      Activa: 0,
      Borrador: 0,
      Finalizada: 0,
      Bonificada: 0,
      Archivada: 0,
    };
    for (const c of items) {
      const e = estadoEfectivoCampana(c);
      if (counts[e] != null) counts[e]++;
    }
    return counts;
  }, [items]);

  const resumenKpi = useMemo(() => {
    const visibles = itemsFiltrados;
    const conIncentivo = visibles.filter((c) => c.costeIncentivo != null && !c.cargandoResultado);
    const sumIncentivo = conIncentivo.reduce((a, c) => a + (c.costeIncentivo ?? 0), 0);
    return {
      total: visibles.length,
      activas: visibles.filter((c) => estadoEfectivoCampana(c) === 'Activa').length,
      sumIncentivo,
      conIncentivo: conIncentivo.length,
    };
  }, [itemsFiltrados]);

  const abrirNueva = () => {
    setEditarCampana(null);
    setModoDuplicar(false);
    setModalAbierto(true);
  };

  const abrirDuplicar = (c: Campana) => {
    setEditarCampana(c);
    setModoDuplicar(true);
    setModalAbierto(true);
  };

  const confirmarBorrar = async (c: Campana) => {
    const ok = await confirmar(
      'Borrar campaña',
      `¿Seguro que quieres borrar «${c.nombre}»?`,
      { confirmarLabel: 'Borrar', variant: 'danger' },
    );
    if (!ok) return;
    try {
      const res = await apiFetch(`/api/campanas/${c.campanaId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo borrar');
      refetch();
    } catch (e) {
      setError((e as Error).message);
    }
  };

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
          ) : itemsFiltrados.map((c) => (
              <View key={c.campanaId} style={styles.cardWrap}>
                <CampanaIncentivoCard
                  campana={c}
                  localesMap={localesMap}
                  costeIncentivo={c.costeIncentivo}
                  cargandoResultado={c.cargandoResultado}
                  onPress={() => router.push(`/recursos-humanos/incentivos-producto/${c.campanaId}`)}
                />
                <View style={styles.cardActions}>
                  {puedeGestionar ? (
                    <TouchableOpacity
                      onPress={() => abrirDuplicar(c)}
                      style={styles.cardActionBtn}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <MaterialIcons name="content-copy" size={18} color="#0ea5e9" />
                    </TouchableOpacity>
                  ) : null}
                  {puedeBorrar && campanaSePuedeBorrar(c) ? (
                    <TouchableOpacity
                      onPress={() => confirmarBorrar(c)}
                      style={styles.cardActionBtn}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <MaterialIcons name="delete-outline" size={18} color="#ef4444" />
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            ))}
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
          label="Total incentivo"
          value={resumenKpi.conIncentivo ? formatMoneda(resumenKpi.sumIncentivo) : '—'}
          color="#d97706"
        />
        <KpiCard label="Con datos" value={`${resumenKpi.conIncentivo}/${resumenKpi.total}`} />
      </View>
      <Text style={styles.resumenHint}>
        Premios al equipo por vender productos concretos. El total incentivo es la suma devengada en el periodo.
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace('/recursos-humanos')} style={styles.backBtn}>
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

      <VentasSyncAviso />

      <View style={[styles.split, shouldStackPanels && styles.splitStack]}>
        {panelLista}
        <View style={[styles.panelKpiWrap, !shouldStackPanels && styles.panelKpiWrapSide, shouldStackPanels && styles.panelKpiWrapStack]}>
          {panelResumen}
        </View>
      </View>

      <CampanaFormModal
        visible={modalAbierto}
        onClose={() => {
          setModalAbierto(false);
          setModoDuplicar(false);
          setEditarCampana(null);
        }}
        onSaved={() => {
          setModoDuplicar(false);
          setEditarCampana(null);
          refetch();
        }}
        campana={editarCampana}
        duplicar={modoDuplicar}
        puedeGestionar={puedeGestionar}
      />
      {ConfirmarView}
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
  panelKpiWrap: { flex: 1, minWidth: 0, backgroundColor: '#fff' },
  panelKpiWrapSide: { flex: 1 },
  panelKpiWrapStack: { flex: undefined, borderTopWidth: 1, borderTopColor: '#e2e8f0' },

  list: { flex: 1 },
  listContent: { padding: 12, gap: 10, paddingBottom: 24 },

  cardWrap: { position: 'relative' },
  cardActions: {
    position: 'absolute',
    top: 6,
    right: 6,
    zIndex: 2,
    flexDirection: 'row',
    gap: 4,
  },
  cardActionBtn: {
    padding: 6,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 8,
  },

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
