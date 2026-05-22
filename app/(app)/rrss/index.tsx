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
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch } from '../../utils/api';
import { useLocalToast } from '../../components/Toast';
import { InputFecha } from '../../components/InputFecha';
import { useMarketingLocales, valorEnLocal } from './LocalesContext';
import { formatId6 } from './lib/formatId6';
import { IdentidadLocalPanel } from './components/IdentidadLocalPanel';
import { dmyToIso, isoToDmy } from './lib/fechasUi';

type Propuesta = {
  id_propuesta: string;
  id_local: string;
  id_empresa?: string;
  tipo: string;
  redes: string[];
  fecha_sugerida: string;
  descripcion: string;
  estado: string;
  creado_por?: string;
  creado_en?: string;
  imagen_referencia_url?: string;
};

const ESTADOS = ['', 'pendiente', 'aprobada', 'rechazada', 'publicada'] as const;
const ESTADO_LABELS: Record<string, string> = {
  '': 'Todos',
  pendiente: 'Pendientes',
  aprobada: 'Aprobadas',
  rechazada: 'Rechazadas',
  publicada: 'Publicadas',
};

/** Chips de estado en tonos pastel (sin seleccionar / seleccionado). */
const CHIP_ESTILO_PASTEL: Record<
  string,
  { bg: string; border: string; text: string; bgSel: string; borderSel: string }
> = {
  '': {
    bg: '#f1f5f9',
    border: '#cbd5e1',
    text: '#475569',
    bgSel: '#e2e8f0',
    borderSel: '#64748b',
  },
  pendiente: {
    bg: '#fefce8',
    border: '#fde68a',
    text: '#92400e',
    bgSel: '#fef08a',
    borderSel: '#ca8a04',
  },
  aprobada: {
    bg: '#ecfdf5',
    border: '#a7f3d0',
    text: '#065f46',
    bgSel: '#d1fae5',
    borderSel: '#059669',
  },
  rechazada: {
    bg: '#fff1f2',
    border: '#fecdd3',
    text: '#9f1239',
    bgSel: '#fecdd3',
    borderSel: '#e11d48',
  },
  publicada: {
    bg: '#eff6ff',
    border: '#bfdbfe',
    text: '#1e40af',
    bgSel: '#dbeafe',
    borderSel: '#2563eb',
  },
};

function contarPropuestasPorEstado(lista: Propuesta[]) {
  const porEstado: Record<string, number> = {
    pendiente: 0,
    aprobada: 0,
    rechazada: 0,
    publicada: 0,
  };
  for (const p of lista) {
    const e = String(p.estado || '').toLowerCase();
    if (e in porEstado) porEstado[e]++;
  }
  return { total: lista.length, porEstado };
}

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

export default function RrssIndexScreen() {
  const router = useRouter();
  const { user, hasPermiso } = useAuth();
  const { locales, loading: loadingLocales, refetch: refetchLocales } = useMarketingLocales();
  const { show: showToast, ToastView } = useLocalToast();
  const esGestor = hasPermiso('marketing.gestionar');

  const userLocalesNorm = useMemo(
    () => (user?.Locales ?? []).map((l) => formatId6(l)).filter(Boolean),
    [user?.Locales]
  );

  // Local seleccionado: para proponente con varios locales o gestor con filtro.
  const [idLocalSel, setIdLocalSel] = useState<string>('');
  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);
  const [estadoSel, setEstadoSel] = useState<string>('');
  const [fechaDesde, setFechaDesde] = useState<string>('');
  const [fechaHasta, setFechaHasta] = useState<string>('');

  const [propuestas, setPropuestas] = useState<Propuesta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conteos, setConteos] = useState({
    total: 0,
    pendiente: 0,
    aprobada: 0,
    rechazada: 0,
    publicada: 0,
  });

  // Inicializa idLocalSel para proponente con un solo local.
  useEffect(() => {
    if (esGestor) return;
    if (userLocalesNorm.length === 1 && !idLocalSel) {
      setIdLocalSel(userLocalesNorm[0]);
    }
  }, [esGestor, userLocalesNorm, idLocalSel]);

  const localesFiltrables = useMemo(() => {
    if (esGestor) return locales;
    return locales.filter((l) => {
      const id = formatId6(valorEnLocal(l, 'id_Locales'));
      return userLocalesNorm.includes(id);
    });
  }, [esGestor, locales, userLocalesNorm]);

  const puedeEditarIdentidad =
    !!idLocalSel && (esGestor || userLocalesNorm.includes(formatId6(idLocalSel)));

  const refetch = useCallback(() => {
    const vaciarConteos = () =>
      setConteos({ total: 0, pendiente: 0, aprobada: 0, rechazada: 0, publicada: 0 });

    if (!esGestor) {
      if (userLocalesNorm.length === 0) {
        setPropuestas([]);
        vaciarConteos();
        return;
      }
      if (!idLocalSel) return;
    }

    const paramsTodos = new URLSearchParams();
    if (idLocalSel) paramsTodos.set('id_local', idLocalSel);
    if (esGestor) {
      if (fechaDesde.trim()) {
        const iso = dmyToIso(fechaDesde);
        if (!iso) {
          setError('La fecha «Desde» no es válida (usa DD/MM/AAAA).');
          return;
        }
        paramsTodos.set('fecha_desde', iso);
      }
      if (fechaHasta.trim()) {
        const iso = dmyToIso(fechaHasta);
        if (!iso) {
          setError('La fecha «Hasta» no es válida (usa DD/MM/AAAA).');
          return;
        }
        paramsTodos.set('fecha_hasta', iso);
      }
    }

    const qsTodos = paramsTodos.toString();
    const paramsList = new URLSearchParams(qsTodos);
    if (estadoSel) paramsList.set('estado', estadoSel);
    const qsList = paramsList.toString();

    const urlTodos = `/api/marketing/propuestas${qsTodos ? `?${qsTodos}` : ''}`;
    const urlList = `/api/marketing/propuestas${qsList ? `?${qsList}` : ''}`;
    const mismaUrl = urlTodos === urlList;

    const aplicarRespuestaLista = (data: { propuestas?: Propuesta[]; error?: string }) => {
      if (data.error) {
        setError(data.error);
        return;
      }
      const arr = Array.isArray(data.propuestas) ? data.propuestas : [];
      setPropuestas(arr);
      const { total, porEstado } = contarPropuestasPorEstado(arr);
      setConteos({ total, ...porEstado });
    };

    setLoading(true);
    setError(null);

    if (mismaUrl) {
      apiFetch(urlList)
        .then((res) => res.json())
        .then((data: { propuestas?: Propuesta[]; error?: string }) => {
          aplicarRespuestaLista(data);
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
        .finally(() => setLoading(false));
      return;
    }

    Promise.all([apiFetch(urlList).then((r) => r.json()), apiFetch(urlTodos).then((r) => r.json())])
      .then(([dataList, dataTodos]: [{ propuestas?: Propuesta[]; error?: string }, { propuestas?: Propuesta[]; error?: string }]) => {
        if (dataList.error) {
          setError(dataList.error);
          return;
        }
        if (dataTodos.error) {
          setError(dataTodos.error);
          return;
        }
        setPropuestas(Array.isArray(dataList.propuestas) ? dataList.propuestas : []);
        const arrTodos = Array.isArray(dataTodos.propuestas) ? dataTodos.propuestas : [];
        const { total, porEstado } = contarPropuestasPorEstado(arrTodos);
        setConteos({ total, ...porEstado });
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [esGestor, userLocalesNorm.length, idLocalSel, estadoSel, fechaDesde, fechaHasta]);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  const localesMap = useMemo(() => {
    const m: Record<string, string> = {};
    locales.forEach((l) => {
      const id = formatId6(valorEnLocal(l, 'id_Locales'));
      const nombre = valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? id;
      if (id) m[id] = nombre;
    });
    return m;
  }, [locales]);

  // ─── Sin locales asignados (proponente) ───
  if (!esGestor && userLocalesNorm.length === 0) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Marketing</Text>
        <View style={styles.emptyWrap}>
          <MaterialIcons name="info-outline" size={32} color="#94a3b8" />
          <Text style={styles.emptyText}>
            No tienes locales asignados. Contacta con el administrador.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Marketing</Text>
      <Text style={styles.subtitle}>
        {esGestor
          ? 'Gestión de propuestas, calendario, carteles y estilo visual.'
          : 'Tus propuestas de marketing y redes sociales.'}
      </Text>

      {/* Línea 1: botones de acción en una sola fila */}
      <View style={styles.lineActions}>
        {esGestor && (
          <>
            <TouchableOpacity style={styles.secBtnCompact} onPress={() => router.push('/rrss/calendario')} activeOpacity={0.7}>
              <MaterialIcons name="calendar-month" size={18} color="#0284c7" />
              <Text style={styles.secBtnCompactText}>Calendario</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secBtnCompact} onPress={() => router.push('/rrss/carteles-musico')} activeOpacity={0.7}>
              <MaterialIcons name="library-music" size={18} color="#0284c7" />
              <Text style={styles.secBtnCompactText}>Carteles músico</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secBtnCompact} onPress={() => router.push('/rrss/config-estilo')} activeOpacity={0.7}>
              <MaterialIcons name="palette" size={18} color="#0284c7" />
              <Text style={styles.secBtnCompactText}>Estilo visual</Text>
            </TouchableOpacity>
          </>
        )}
        <TouchableOpacity
          style={styles.primaryBtnCompact}
          onPress={() => router.push('/rrss/nueva-propuesta')}
          activeOpacity={0.7}
        >
          <MaterialIcons name="add-circle-outline" size={18} color="#fff" />
          <Text style={styles.primaryBtnCompactText}>Nueva propuesta</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.iconBtnCompact}
          onPress={refetch}
          disabled={loading}
          accessibilityLabel="Actualizar"
        >
          {loading ? (
            <ActivityIndicator size="small" color="#0ea5e9" />
          ) : (
            <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
          )}
        </TouchableOpacity>
      </View>

      {/* Línea 2: local + rango de fechas */}
      {(esGestor || userLocalesNorm.length > 1) && (
        <View style={styles.lineFilters}>
          <View style={styles.localCol}>
            <Text style={styles.filterLabel}>Local</Text>
            <TouchableOpacity
              style={styles.dropdownTrigger}
              onPress={() => setLocalDropdownOpen((v) => !v)}
              activeOpacity={0.7}
              disabled={loadingLocales}
            >
              <Text
                style={[styles.dropdownTriggerText, !idLocalSel && styles.dropdownPlaceholder]}
                numberOfLines={1}
              >
                {idLocalSel
                  ? localesMap[idLocalSel] ?? idLocalSel
                  : esGestor
                    ? 'Todos los locales'
                    : 'Selecciona un local'}
              </Text>
              <MaterialIcons name={localDropdownOpen ? 'expand-less' : 'expand-more'} size={20} color="#64748b" />
            </TouchableOpacity>
            {localDropdownOpen && (
              <View style={styles.dropdownList}>
                <ScrollView style={styles.dropdownScroll} nestedScrollEnabled>
                  {esGestor && (
                    <TouchableOpacity
                      style={[styles.dropdownOption, !idLocalSel && styles.dropdownOptionSelected]}
                      onPress={() => {
                        setIdLocalSel('');
                        setLocalDropdownOpen(false);
                      }}
                    >
                      <Text style={styles.dropdownOptionText}>Todos los locales</Text>
                      {!idLocalSel && <MaterialIcons name="check" size={18} color="#0ea5e9" />}
                    </TouchableOpacity>
                  )}
                  {localesFiltrables.map((l) => {
                    const id = formatId6(valorEnLocal(l, 'id_Locales'));
                    const nombre = valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? id;
                    const sel = id === idLocalSel;
                    return (
                      <TouchableOpacity
                        key={id || nombre}
                        style={[styles.dropdownOption, sel && styles.dropdownOptionSelected]}
                        onPress={() => {
                          setIdLocalSel(id);
                          setLocalDropdownOpen(false);
                        }}
                      >
                        <Text style={[styles.dropdownOptionText, sel && styles.dropdownOptionTextSelected]} numberOfLines={1}>
                          {nombre || id || '—'}
                        </Text>
                        {sel && <MaterialIcons name="check" size={18} color="#0ea5e9" />}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            )}
          </View>
          {esGestor && (
          <>
            <View style={styles.dateCol}>
              <Text style={styles.filterLabel}>Desde</Text>
              <InputFecha
                value={fechaDesde}
                onChange={setFechaDesde}
                format="dmy"
                placeholder="DD/MM/AAAA"
                style={styles.dateInputCompact}
              />
            </View>
            <View style={styles.dateCol}>
              <Text style={styles.filterLabel}>Hasta</Text>
              <InputFecha
                value={fechaHasta}
                onChange={setFechaHasta}
                format="dmy"
                placeholder="DD/MM/AAAA"
                style={styles.dateInputCompact}
              />
            </View>
          </>
          )}
        </View>
      )}

      {/* Línea 3: chips de estado pastel con contadores */}
      <View style={styles.lineEstado}>
        <Text style={styles.estadoHeading}>Estado</Text>
        <View style={styles.chipRowPastel}>
          {ESTADOS.map((e) => {
            const pastel = CHIP_ESTILO_PASTEL[e] ?? CHIP_ESTILO_PASTEL[''];
            const sel = estadoSel === e;
            const n =
              e === ''
                ? conteos.total
                : e === 'pendiente'
                  ? conteos.pendiente
                  : e === 'aprobada'
                    ? conteos.aprobada
                    : e === 'rechazada'
                      ? conteos.rechazada
                      : conteos.publicada;
            return (
              <TouchableOpacity
                key={e || 'todos'}
                style={[
                  styles.estadoChipPastel,
                  {
                    backgroundColor: sel ? pastel.bgSel : pastel.bg,
                    borderColor: sel ? pastel.borderSel : pastel.border,
                  },
                ]}
                onPress={() => setEstadoSel(e)}
                activeOpacity={0.75}
              >
                <Text style={[styles.estadoChipTextPastel, { color: pastel.text }, sel && styles.estadoChipTextPastelSel]}>
                  {ESTADO_LABELS[e]} ({n})
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {idLocalSel ? (
        <IdentidadLocalPanel
          idLocal={idLocalSel}
          nombreLocal={localesMap[idLocalSel]}
          puedeEditar={puedeEditarIdentidad}
          showToast={showToast}
          onGuardado={refetchLocales}
        />
      ) : esGestor ? (
        <View style={styles.identidadPlaceholder}>
          <MaterialIcons name="storefront" size={18} color="#94a3b8" />
          <Text style={styles.identidadPlaceholderText}>Selecciona un local para ver y editar su identidad visual.</Text>
        </View>
      ) : null}

      {error && (
        <View style={styles.errorWrap}>
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
            <Text style={styles.loadingText}>Cargando propuestas…</Text>
          </View>
        ) : propuestas.length === 0 ? (
          <View style={styles.emptyWrap}>
            <MaterialIcons name="inbox" size={32} color="#94a3b8" />
            <Text style={styles.emptyText}>No hay propuestas con esos filtros.</Text>
          </View>
        ) : (
          propuestas.map((p) => {
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
                <Text style={styles.cardDesc} numberOfLines={2}>
                  {p.descripcion}
                </Text>
                <View style={styles.cardFooter}>
                  <View style={styles.cardMeta}>
                    <MaterialIcons name="event" size={14} color="#64748b" />
                    <Text style={styles.cardMetaText}>{isoToDmy(p.fecha_sugerida) || '—'}</Text>
                  </View>
                  <View style={styles.cardMeta}>
                    <MaterialIcons name="store" size={14} color="#64748b" />
                    <Text style={styles.cardMetaText} numberOfLines={1}>{localNombre}</Text>
                  </View>
                  <View style={styles.cardMeta}>
                    <MaterialIcons name="share" size={14} color="#64748b" />
                    <Text style={styles.cardMetaText}>{(p.redes ?? []).join(', ') || '—'}</Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
      {ToastView}
    </View>
  );
}

const styles = StyleSheet.create({
  identidadPlaceholder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12,
  },
  identidadPlaceholderText: { flex: 1, fontSize: 12, color: '#64748b' },
  container: { flex: 1, padding: 10 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748b', lineHeight: 20, marginBottom: 10 },
  lineActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  secBtnCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  secBtnCompactText: { fontSize: 12, fontWeight: '600', color: '#0284c7' },
  primaryBtnCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
  },
  primaryBtnCompactText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  iconBtnCompact: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 40,
  },
  lineFilters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: 10,
    marginBottom: 10,
  },
  localCol: { flex: 1, minWidth: 200, flexGrow: 2 },
  dateCol: { width: 140, minWidth: 130, flexShrink: 0 },
  lineEstado: { marginBottom: 12, gap: 6 },
  estadoHeading: { fontSize: 12, fontWeight: '600', color: '#475569' },
  chipRowPastel: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  estadoChipPastel: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
  },
  estadoChipTextPastel: { fontSize: 12, fontWeight: '500' },
  estadoChipTextPastelSel: { fontWeight: '700' },
  filterLabel: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 6 },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  dropdownTriggerText: { fontSize: 13, color: '#334155', flex: 1 },
  dropdownPlaceholder: { color: '#94a3b8' },
  dropdownList: { marginTop: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff', maxHeight: 240 },
  dropdownScroll: { maxHeight: 240 },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  dropdownOptionSelected: { backgroundColor: '#f0f9ff' },
  dropdownOptionText: { fontSize: 13, color: '#334155', flex: 1 },
  dropdownOptionTextSelected: { color: '#0ea5e9', fontWeight: '500' },
  dateInputCompact: {
    fontSize: 13,
    paddingVertical: 8,
    paddingHorizontal: 10,
    color: '#334155',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  errorWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8, marginBottom: 12 },
  errorText: { fontSize: 12, color: '#f87171', flex: 1 },
  retryBtn: { paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#fff', borderRadius: 6 },
  retryBtnText: { fontSize: 12, color: '#dc2626', fontWeight: '600' },
  list: { flex: 1 },
  listContent: { paddingBottom: 20, gap: 10 },
  center: { paddingVertical: 24, alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  emptyWrap: { paddingVertical: 32, alignItems: 'center', gap: 8 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center', paddingHorizontal: 24 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    gap: 8,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTipo: { fontSize: 14, fontWeight: '700', color: '#334155' },
  badge: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: 12 },
  badgeText: { fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  cardDesc: { fontSize: 13, color: '#475569', lineHeight: 18 },
  cardFooter: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardMetaText: { fontSize: 11, color: '#64748b' },
});
