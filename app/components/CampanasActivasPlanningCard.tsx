import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useHubNavGrid } from '../hooks/useHubNavGrid';
import { MIN_TOUCH } from '../constants/layout';
import { apiFetch } from '../utils/api';
import { formatFecha } from '../utils/formatFecha';
import { formatMoneda } from '../utils/formatMoneda';
import {
  colorEstadoCampana,
  etiquetaTipoIncentivo,
  formatValorIncentivoDisplay,
} from '../lib/incentivosProducto';
import { estadoEfectivoCampana } from '../lib/campanaEstado';
import type { Campana, ResultadosCampana, TipoIncentivo } from '../types/incentivosProducto';

type CampanaConResultado = Campana & {
  costeIncentivo?: number | null;
  cargandoResultado?: boolean;
};

type Props = {
  localId?: string | null;
  filtrarPorLocal?: boolean;
  localIndex?: number;
  width?: `${number}%` | '100%';
  style?: StyleProp<ViewStyle>;
};

function campanaIncluyeLocal(c: Campana, localId: string): boolean {
  if (!localId) return false;
  if (!c.locales?.length) return true;
  return c.locales.includes(localId);
}

function PlanningInline({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <Text style={styles.inlineField} numberOfLines={1}>
      <Text style={styles.inlineLabel}>{label} </Text>
      <Text style={[styles.inlineValue, highlight && styles.inlineValueHighlight]}>{value}</Text>
    </Text>
  );
}

export function CampanasActivasPlanningCard({
  localId,
  filtrarPorLocal = false,
  localIndex = 0,
  width = '100%',
  style,
}: Props) {
  const router = useRouter();
  const { hasPermiso, localPermitido } = useAuth();
  const { compact } = useHubNavGrid();
  const puedeVer = hasPermiso('incentivos_producto.ver');

  const [items, setItems] = useState<CampanaConResultado[]>([]);
  const [localesMap, setLocalesMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [campanaIdx, setCampanaIdx] = useState(0);

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
      setItems([]);
      return;
    }
    setLoading(true);
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
          if (estadoEfectivoCampana(c) !== 'Activa') return false;
          if (!c.locales?.length) return true;
          return c.locales.some((lid) => {
            const nombre = map[lid];
            return nombre ? localPermitido(nombre) : true;
          });
        });

        const conResultado: CampanaConResultado[] = lista.map((c) => ({
          ...c,
          estado: estadoEfectivoCampana(c),
          costeIncentivo: null,
          cargandoResultado: true,
        }));
        setItems(conResultado);

        await Promise.all(
          conResultado.map(async (c) => {
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
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [puedeVer, localPermitido, cargarResultado]);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  const campanasLocal = useMemo(() => {
    const base = !filtrarPorLocal || !localId
      ? items
      : items.filter((c) => campanaIncluyeLocal(c, localId));
    return [...base].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }, [items, localId, filtrarPorLocal]);

  useEffect(() => {
    setCampanaIdx(0);
  }, [localId, localIndex]);

  useEffect(() => {
    if (campanaIdx >= campanasLocal.length && campanasLocal.length > 0) {
      setCampanaIdx(0);
    }
  }, [campanasLocal.length, campanaIdx]);

  if (!puedeVer) return null;

  const multi = campanasLocal.length > 1;
  const idx = campanasLocal.length
    ? Math.min(Math.max(0, campanaIdx), campanasLocal.length - 1)
    : 0;
  const campana = campanasLocal[idx];

  const prev = () => setCampanaIdx((i) => (i <= 0 ? campanasLocal.length - 1 : i - 1));
  const next = () => setCampanaIdx((i) => (i >= campanasLocal.length - 1 ? 0 : i + 1));

  const cardShell = (icon: ReactNode, title: string, desc: string) => (
    <View style={[styles.card, compact && styles.cardCompact, { width }, style]}>
      <View style={[styles.iconWrap, compact && styles.iconWrapCompact]}>{icon}</View>
      <View style={styles.body}>
        <Text style={[styles.title, compact && styles.titleCompact]} numberOfLines={1}>{title}</Text>
        <Text style={[styles.desc, compact && styles.descCompact]} numberOfLines={1}>{desc}</Text>
      </View>
    </View>
  );

  if (loading) {
    return cardShell(
      <ActivityIndicator size="small" color="#d97706" />,
      'Incentivos activos',
      'Cargando campañas…',
    );
  }

  if (filtrarPorLocal && !localId) {
    return cardShell(
      <MaterialIcons name="emoji-events" size={compact ? 22 : 26} color="#d97706" />,
      'Incentivos activos',
      'Cargando campañas del local…',
    );
  }

  if (!campana) {
    const nombreLocal = localId ? (localesMap[localId] || localId) : null;
    return cardShell(
      <MaterialIcons name="emoji-events" size={compact ? 22 : 26} color="#94a3b8" />,
      nombreLocal || 'Incentivos activos',
      nombreLocal ? 'Sin campañas activas en este local' : 'Sin campañas activas',
    );
  }

  const estado = estadoEfectivoCampana(campana);
  const ec = colorEstadoCampana(estado);
  const tipo = campana.tipoIncentivo as TipoIncentivo;
  const totalIncentivo = campana.cargandoResultado
    ? '…'
    : campana.costeIncentivo != null
      ? formatMoneda(campana.costeIncentivo)
      : 'Sin datos';

  const abrirDetalle = () => {
    router.push(`/recursos-humanos/incentivos-producto/${campana.campanaId}` as never);
  };

  return (
    <View style={[styles.card, compact && styles.cardCompact, { width }, style]}>
      {multi ? (
        <TouchableOpacity
          style={[styles.navBtn, compact && styles.navBtnCompact]}
          onPress={prev}
          accessibilityLabel="Campaña anterior"
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <MaterialIcons name="chevron-left" size={compact ? 22 : 24} color="#64748b" />
        </TouchableOpacity>
      ) : null}

      <TouchableOpacity
        style={styles.mainTap}
        activeOpacity={0.75}
        onPress={abrirDetalle}
        accessibilityLabel={`Campaña ${campana.nombre}`}
      >
        <View style={[styles.iconWrap, compact && styles.iconWrapCompact, { backgroundColor: '#fef3c7' }]}>
          <MaterialIcons name="emoji-events" size={compact ? 22 : 26} color="#d97706" />
        </View>

        <View style={styles.body}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, compact && styles.titleCompact]} numberOfLines={1}>
              {campana.nombre}
            </Text>
            <View style={[styles.estadoBadge, { backgroundColor: ec + '18', borderColor: ec }]}>
              <Text style={[styles.estadoBadgeText, { color: ec }]}>{estado}</Text>
            </View>
            {multi ? (
              <View style={styles.posBadge}>
                <Text style={styles.posBadgeText}>{idx + 1}/{campanasLocal.length}</Text>
              </View>
            ) : null}
          </View>

          <Text style={[styles.desc, compact && styles.descCompact]} numberOfLines={1}>
            {formatFecha(campana.fechaInicio)} — {formatFecha(campana.fechaFin)}
          </Text>

          <View style={styles.metricsRow}>
            <PlanningInline label="Productos" value={String(campana.productos?.length || 0)} />
            <PlanningInline
              label="Incentivo"
              value={`${etiquetaTipoIncentivo(tipo)} · ${formatValorIncentivoDisplay(tipo, campana.valorIncentivo)}`}
            />
          </View>

          <View style={styles.totalRow}>
            <PlanningInline label="Total incentivo" value={totalIncentivo} highlight />
          </View>
        </View>
      </TouchableOpacity>

      {multi ? (
        <TouchableOpacity
          style={[styles.navBtn, compact && styles.navBtnCompact]}
          onPress={next}
          accessibilityLabel="Campaña siguiente"
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <MaterialIcons name="chevron-right" size={compact ? 22 : 24} color="#64748b" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    minHeight: MIN_TOUCH + 24,
    alignSelf: 'stretch',
  },
  cardCompact: {
    gap: 10,
    padding: 12,
    borderRadius: 10,
  },
  mainTap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minWidth: 0,
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flexShrink: 0,
  },
  navBtnCompact: {
    width: 28,
    height: 28,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: '#fef3c7',
  },
  iconWrapCompact: {
    width: 40,
    height: 40,
    borderRadius: 10,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 6,
    justifyContent: 'center',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    flex: 1,
    minWidth: 0,
  },
  titleCompact: {
    fontSize: 14,
  },
  desc: {
    fontSize: 12,
    color: '#64748b',
    lineHeight: 16,
  },
  descCompact: {
    fontSize: 11,
    lineHeight: 14,
  },
  estadoBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
    flexShrink: 0,
  },
  estadoBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  posBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flexShrink: 0,
  },
  posBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
  },
  metricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 2,
    minHeight: 8,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  inlineField: {
    fontSize: 12,
    color: '#334155',
    flexShrink: 1,
  },
  inlineLabel: {
    color: '#94a3b8',
    fontWeight: '600',
    textTransform: 'uppercase',
    fontSize: 10,
  },
  inlineValue: {
    color: '#334155',
    fontWeight: '600',
    fontSize: 12,
  },
  inlineValueHighlight: {
    fontWeight: '800',
    color: '#0f172a',
  },
});
