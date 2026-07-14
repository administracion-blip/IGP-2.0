import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch } from '../../utils/api';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { formatId6 } from '../../utils/idFormat';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { ActivacionFichaModalDia } from '../../components/ActivacionFichaModalDia';
import {
  type ActivacionSesionDia,
  ESTADO_SESION_META,
  sesionCruzaMedianoche,
} from '../../types/activaciones';

type LocalItem = { id_Locales?: string; nombre?: string; Nombre?: string };

/** Valor especial: cargar activaciones de todos los locales permitidos. */
export const LOCAL_TODOS = '__todos__';

export default function ActivacionesDiaScreen() {
  const router = useRouter();
  const { localPermitido } = useAuth();

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [localSel, setLocalSel] = useState<string>(LOCAL_TODOS);
  const [sesiones, setSesiones] = useState<ActivacionSesionDia[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sesionModal, setSesionModal] = useState<ActivacionSesionDia | null>(null);

  const jornada = fechaJornadaNegocioIso();

  useEffect(() => {
    apiFetch('/api/locales?minimal=1')
      .then((r) => r.json())
      .then((d: { locales?: LocalItem[] }) => setLocales(Array.isArray(d.locales) ? d.locales : []))
      .catch(() => setLocales([]));
  }, []);

  /** Locales que puede ver el usuario. */
  const localesPermitidos = useMemo(() => {
    return locales.filter((l) =>
      localPermitido(String(l.nombre ?? l.Nombre ?? '').trim()),
    );
  }, [locales, localPermitido]);

  const opcionesLocal = useMemo(
    () => [
      { id: LOCAL_TODOS, titulo: 'Todos los locales', icono: 'store' as const },
      ...localesPermitidos
        .map((l) => ({
          id: formatId6(String(l.id_Locales ?? '')),
          titulo: String(l.nombre ?? l.Nombre ?? '—'),
          icono: 'storefront' as const,
        }))
        .filter((o) => o.id && o.id !== '000000')
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')),
    ],
    [localesPermitidos],
  );

  const idsLocalesCarga = useMemo(() => {
    if (localSel === LOCAL_TODOS) {
      return opcionesLocal.filter((o) => o.id !== LOCAL_TODOS).map((o) => o.id);
    }
    return localSel ? [localSel] : [];
  }, [localSel, opcionesLocal]);

  const cargar = useCallback(async () => {
    if (idsLocalesCarga.length === 0) {
      setSesiones([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resultados = await Promise.all(
        idsLocalesCarga.map(async (idLocal) => {
          const r = await apiFetch(`/api/activaciones/sesiones/dia?id_local=${idLocal}&fecha=${jornada}`);
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'No se pudieron cargar las activaciones del día');
          return Array.isArray(d.sesiones) ? (d.sesiones as ActivacionSesionDia[]) : [];
        }),
      );
      const merged = resultados.flat();
      setSesiones(merged);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
      setSesiones([]);
    } finally {
      setLoading(false);
    }
  }, [idsLocalesCarga, jornada]);

  useFocusEffect(
    useCallback(() => {
      cargar();
    }, [cargar]),
  );

  const agrupado = useMemo(() => {
    const map = new Map<string, { idKey: string; nombreLocal: string; sesiones: ActivacionSesionDia[] }>();
    for (const s of sesiones) {
      const idKey = formatId6(String(s.id_local ?? '')) || '_';
      const nombreLocal = String(s.local_nombre || s.id_local || 'Local').trim();
      if (!map.has(idKey)) {
        map.set(idKey, { idKey, nombreLocal, sesiones: [] });
      }
      map.get(idKey)!.sesiones.push(s);
    }
    const list = [...map.values()];
    list.sort((a, b) => a.nombreLocal.localeCompare(b.nombreLocal, 'es', { sensitivity: 'base' }));
    for (const g of list) {
      g.sesiones.sort((a, b) => String(a.hora_inicio || '').localeCompare(String(b.hora_inicio || '')));
    }
    return list;
  }, [sesiones]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Activaciones del día</Text>
          <Text style={styles.subtitle}>Jornada {jornada}</Text>
        </View>
        <TouchableOpacity onPress={cargar} style={styles.backBtn} disabled={loading}>
          {loading ? (
            <ActivityIndicator size="small" color="#0ea5e9" />
          ) : (
            <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
          )}
        </TouchableOpacity>
      </View>

      {localesPermitidos.length > 0 ? (
        <SelectorDesplegable
          label="Local"
          icono="storefront"
          tituloLista="Local"
          iconoLista="storefront"
          placeholder="Todos los locales"
          opciones={opcionesLocal}
          valorId={localSel}
          onSeleccionar={setLocalSel}
          buscador={opcionesLocal.length > 8}
          style={{ marginBottom: 10 }}
        />
      ) : null}

      {error ? (
        <View style={styles.errorBanner}>
          <MaterialIcons name="error-outline" size={16} color="#b91c1c" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={cargar}>
            <Text style={styles.retry}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {localesPermitidos.length === 0 ? (
        <View style={styles.centerBox}>
          <MaterialIcons name="storefront" size={48} color="#cbd5e1" />
          <Text style={styles.emptyText}>No tienes locales asignados para consultar activaciones.</Text>
        </View>
      ) : loading && sesiones.length === 0 ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#0ea5e9" />
        </View>
      ) : sesiones.length === 0 ? (
        <View style={styles.centerBox}>
          <MaterialIcons name="celebration" size={48} color="#cbd5e1" />
          <Text style={styles.emptyText}>No hay activaciones programadas para hoy.</Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
          {agrupado.map((grupo) => (
            <View key={grupo.idKey} style={styles.bloqueLocal}>
              <View style={styles.localHeader}>
                <MaterialIcons name="storefront" size={18} color="#0ea5e9" />
                <Text style={styles.localNombre} numberOfLines={1}>
                  {grupo.nombreLocal.toUpperCase()}
                </Text>
                <View style={styles.localCountBadge}>
                  <Text style={styles.localCountText}>{grupo.sesiones.length}</Text>
                </View>
              </View>
              {grupo.sesiones.map((s) => {
                const sm = ESTADO_SESION_META[s.estado_sesion] ?? ESTADO_SESION_META.programada;
                return (
                  <Pressable
                    key={s.id_sesion}
                    style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
                    onPress={() => setSesionModal(s)}
                  >
                    <View style={styles.cardHeader}>
                      <View style={styles.horaBox}>
                        <MaterialIcons name="schedule" size={16} color="#0369a1" />
                        <Text style={styles.horaText}>
                          {s.hora_inicio} – {s.hora_fin}
                        </Text>
                        {sesionCruzaMedianoche(s) ? (
                          <Text style={styles.horaMadrugada}>(hasta madrugada)</Text>
                        ) : null}
                      </View>
                      <View style={[styles.badge, { backgroundColor: sm.bg }]}>
                        <Text style={[styles.badgeText, { color: sm.text }]}>{sm.label}</Text>
                      </View>
                    </View>

                    <Text style={styles.cardTitle}>
                      {s.marca} · {s.producto}
                    </Text>
                    {s.tipo_activacion ? <Text style={styles.cardTipo}>{s.tipo_activacion}</Text> : null}
                    {s.duracion_horas ? (
                      <Text style={styles.cardDuracion}>Duración: {s.duracion_horas} h</Text>
                    ) : null}

                    <View style={styles.verFichaRow}>
                      <Text style={styles.verFichaText}>Ver ficha</Text>
                      <MaterialIcons name="chevron-right" size={18} color="#0ea5e9" />
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </ScrollView>
      )}

      <ActivacionFichaModalDia
        sesion={sesionModal}
        visible={sesionModal != null}
        onClose={() => setSesionModal(null)}
        onSesionActualizada={cargar}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  errorText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  retry: { fontSize: 12, fontWeight: '700', color: '#0ea5e9' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  emptyText: { fontSize: 13, color: '#94a3b8', textAlign: 'center' },
  bloqueLocal: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
    marginBottom: 10,
  },
  localHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  localNombre: { fontSize: 13, fontWeight: '800', color: '#0369a1', flex: 1 },
  localCountBadge: {
    backgroundColor: '#e0f2fe',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 22,
    alignItems: 'center',
  },
  localCountText: { fontSize: 11, fontWeight: '800', color: '#0369a1' },
  card: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  cardPressed: { backgroundColor: '#f8fafc', borderColor: '#bae6fd' },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 6,
  },
  horaBox: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  horaText: { fontSize: 16, fontWeight: '800', color: '#0369a1' },
  horaMadrugada: { fontSize: 11, color: '#b45309', fontStyle: 'italic' },
  badge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  cardTipo: { fontSize: 12, color: '#64748b', marginTop: 2 },
  cardDuracion: { fontSize: 12, fontWeight: '600', color: '#0369a1', marginTop: 4 },
  verFichaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 10,
    gap: 2,
  },
  verFichaText: { fontSize: 12, fontWeight: '700', color: '#0ea5e9' },
});
