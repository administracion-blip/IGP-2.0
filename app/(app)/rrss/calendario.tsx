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
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';
import { useLocalesMarketing, valorEnLocal } from '../../contexts/LocalesContext';
import { formatId6 } from './lib/formatId6';
import { esIsoFechaValida, finMesActualIso, inicioMesActualIso, isoToDmy } from './lib/fechasUi';
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
      return { backgroundColor: statusColors.warning.bg, color: statusColors.warning.text };
    case 'aprobada':
      return { backgroundColor: '#d1fae5', color: '#047857' };
    case 'rechazada':
      return { backgroundColor: statusColors.danger.bg, color: statusColors.danger.text };
    case 'publicada':
      return { backgroundColor: '#dbeafe', color: '#1e40af' };
    default:
      return { backgroundColor: colors.navActive, color: colors.textPrimary };
  }
}

export default function CalendarioScreen() {
  const router = useRouter();
  const { locales } = useLocalesMarketing();

  const [fechaDesde, setFechaDesde] = useState(inicioMesActualIso());
  const [fechaHasta, setFechaHasta] = useState(finMesActualIso());
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
      if (!esIsoFechaValida(fechaDesde)) {
        setError('Indica una fecha válida (dd/mm/aaaa) en «Desde».');
        return;
      }
      isoDesde = fechaDesde.trim();
    }
    if (fechaHasta.trim()) {
      if (!esIsoFechaValida(fechaHasta)) {
        setError('Indica una fecha válida (dd/mm/aaaa) en «Hasta».');
        return;
      }
      isoHasta = fechaHasta.trim();
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
          <MaterialIcons name="arrow-back" size={22} color={colors.accent} />
        </TouchableOpacity>
        <Text style={styles.title}>Calendario</Text>
      </View>

      <View style={styles.filtersWrap}>
        <View style={styles.row}>
          <View style={styles.field}>
            <Text style={styles.label}>Desde</Text>
            <InputFecha valueIso={fechaDesde} onChangeIso={setFechaDesde} placeholder="dd/mm/aaaa" style={styles.dateInput} />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Hasta</Text>
            <InputFecha valueIso={fechaHasta} onChangeIso={setFechaHasta} placeholder="dd/mm/aaaa" style={styles.dateInput} />
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
          <MaterialIcons name="error-outline" size={18} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refetch} colors={[colors.accent]} tintColor={colors.accent} />}
      >
        {loading && propuestas.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
        ) : agrupadas.length === 0 ? (
          <View style={styles.empty}>
            <MaterialIcons name="event-busy" size={32} color={colors.textMuted} />
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
                        <MaterialIcons name="store" size={13} color={colors.textMuted} />
                        <Text style={styles.cardMetaText} numberOfLines={1}>{localNombre}</Text>
                      </View>
                      <View style={styles.cardMeta}>
                        <MaterialIcons name="share" size={13} color={colors.textMuted} />
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

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, padding: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerBtn: { padding: 6 },
  title: { fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  filtersWrap: { padding: SPACING.md, gap: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  row: { flexDirection: 'row', gap: 10 },
  field: { flex: 1, gap: 6 },
  label: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  dateInput: {
    fontFamily: fontFamily.regular, fontSize: fontSizes[13],
    paddingVertical: 8,
    paddingHorizontal: 10,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingVertical: 6, paddingHorizontal: 10, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  chipText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textPrimary },
  chipTextSelected: { color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, margin: SPACING.md, padding: 10, backgroundColor: statusColors.danger.bg, borderRadius: RADIO_MEDIO },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, flex: 1 },
  retryBtn: { paddingVertical: 6, paddingHorizontal: SPACING.md, backgroundColor: colors.surface, borderRadius: radius.sm },
  retryBtnText: { fontSize: fontSizes[12], color: colors.danger, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  list: { flex: 1 },
  listContent: { padding: SPACING.md, gap: 16, paddingBottom: 24 },
  center: { paddingVertical: 32, alignItems: 'center' },
  empty: { paddingVertical: 32, alignItems: 'center', gap: SPACING.sm },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted },
  dayBlock: { gap: SPACING.sm },
  dayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  dayTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  dayCount: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  card: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: SPACING.md, gap: 6 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTipo: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  badge: { paddingVertical: 2, paddingHorizontal: SPACING.sm, borderRadius: radius.md },
  badgeText: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, textTransform: 'capitalize' },
  cardDesc: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textPrimary },
  cardFooter: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardMetaText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted },
});
