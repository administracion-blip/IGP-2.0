import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useMantenimientoLocales, valorEnLocal } from './LocalesContext';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type Incidencia = Record<string, string | number | string[] | undefined>;

const PRIORIDAD_ORDER: Record<string, number> = {
  urgente: 0,
  alta: 1,
  media: 2,
  baja: 3,
};
const PRIORIDAD_COLOR: Record<string, string> = {
  urgente: '#dc2626',
  alta: '#ea580c',
  media: '#eab308',
  baja: '#16a34a',
};

function getPrioridadOrden(p: string | undefined): number {
  const key = (p ?? '').toString().trim().toLowerCase();
  return PRIORIDAD_ORDER[key] ?? 4;
}
function getPrioridadColor(p: string | undefined): string {
  const key = (p ?? '').toString().trim().toLowerCase();
  return PRIORIDAD_COLOR[key] ?? '#94a3b8';
}
function getPrioridadLabel(p: string | undefined): string {
  const key = (p ?? '').toString().trim().toLowerCase();
  if (!key) return '—';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function getHoyISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatearFecha(iso: string | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yy} ${hh}:${min}`;
  } catch {
    return String(iso);
  }
}

export default function ProgramadasHoyScreen() {
  const router = useRouter();
  const { locales } = useMantenimientoLocales();
  const [incidencias, setIncidencias] = useState<Incidencia[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [marcandoReparadoKey, setMarcandoReparadoKey] = useState<string | null>(null);

  const mapLocalIdToNombre = useMemo(() => {
    const m: Record<string, string> = {};
    locales.forEach((loc) => {
      const id = valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'id_locales') ?? '';
      const nombre = valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id;
      if (id) m[id] = nombre;
    });
    return m;
  }, [locales]);

  const refetch = useCallback(() => {
    fetch(`${API_URL}/api/mantenimiento/incidencias`)
      .then((res) => res.json())
      .then((data: { incidencias?: Incidencia[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        const list = data.incidencias || [];
        const hoy = getHoyISO();
        const filtradas = list.filter((i) => {
          const fp = (i.fecha_programada ?? '').toString().trim();
          const match = fp.match(/^(\d{4}-\d{2}-\d{2})/);
          const fecha = match ? match[1] : '';
          return fecha === hoy && (i.estado ?? '') !== 'CANCELADA';
        });
        setIncidencias(filtradas);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refetch();
  }, [refetch]);

  const marcarReparado = useCallback(
    async (inc: Incidencia) => {
      const localId = (inc.local_id ?? '').toString().trim();
      const idIncidencia = (inc.id_incidencia ?? '').toString().trim();
      const fechaCreacion = (inc.fecha_creacion ?? '').toString().trim();
      if (!localId || !idIncidencia || !fechaCreacion) return;
      const key = `${localId}-${idIncidencia}-${fechaCreacion}`;
      setMarcandoReparadoKey(key);
      setError(null);
      try {
        const res = await fetch(`${API_URL}/api/mantenimiento/incidencias`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ local_id: localId, id_incidencia: idIncidencia, fecha_creacion: fechaCreacion, marcar_reparado: true }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(data.error ?? 'Error al marcar como reparado');
          return;
        }
        refetch();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error de conexión');
      } finally {
        setMarcandoReparadoKey(null);
      }
    },
    [refetch]
  );

  const agrupadas = useMemo(() => {
    const byLocal = new Map<string, Incidencia[]>();
    const ordenadas = [...incidencias].sort((a, b) => {
      return getPrioridadOrden(a.prioridad_reportada as string) - getPrioridadOrden(b.prioridad_reportada as string);
    });
    ordenadas.forEach((inc) => {
      const localId = (inc.local_id ?? '').toString().trim() || '_sin_local';
      if (!byLocal.has(localId)) byLocal.set(localId, []);
      byLocal.get(localId)!.push(inc);
    });
    return Array.from(byLocal.entries()).map(([localId, incs]) => ({
      localId,
      nombreLocal: localId === '_sin_local' ? 'Sin local' : (mapLocalIdToNombre[localId] ?? localId),
      incidencias: incs,
    }));
  }, [incidencias, mapLocalIdToNombre]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando reparaciones de hoy…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Reparaciones programadas hoy</Text>
      </View>

      {error ? (
        <View style={styles.errorWrap}>
          <MaterialIcons name="error-outline" size={32} color="#dc2626" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#0ea5e9']} />}
        >
          {agrupadas.length === 0 ? (
            <View style={styles.empty}>
              <MaterialIcons name="today" size={48} color="#94a3b8" />
              <Text style={styles.emptyTitle}>No hay reparaciones programadas para hoy</Text>
              <Text style={styles.emptySub}>Las incidencias programadas para hoy aparecerán aquí, agrupadas por local.</Text>
            </View>
          ) : (
            agrupadas.map((grupo) => (
              <View key={grupo.localId} style={styles.group}>
                <View style={styles.groupHeader}>
                  <View style={styles.groupTitleWrap}>
                    <Text style={styles.groupTitle} numberOfLines={1} ellipsizeMode="tail">{grupo.nombreLocal}</Text>
                  </View>
                  <View style={styles.groupBadge}>
                    <Text style={styles.groupBadgeText}>
                      {grupo.incidencias.length} {grupo.incidencias.length === 1 ? 'reparación' : 'reparaciones'}
                    </Text>
                  </View>
                </View>
                <View style={styles.cardRow}>
                {grupo.incidencias.map((inc, idx) => {
                  const prioridad = (inc.prioridad_reportada ?? '—').toString().trim().toLowerCase();
                  const prioridadLabel = prioridad ? getPrioridadLabel(inc.prioridad_reportada as string) : '—';
                  const prioridadBg = getPrioridadColor(inc.prioridad_reportada as string);
                  return (
                    <View key={`${inc.id_incidencia ?? idx}-${inc.fecha_creacion}`} style={styles.card}>
                      <View style={styles.cardHeader}>
                        <Text style={styles.cardTitle}>{(inc.titulo ?? '—').toString()}</Text>
                        <View style={[styles.prioridadBadge, { backgroundColor: prioridadBg }]}>
                          <Text style={styles.prioridadBadgeText}>{prioridadLabel}</Text>
                        </View>
                      </View>
                      <Text style={styles.cardDesc}>{(inc.descripcion ?? '—').toString()}</Text>
                      <View style={styles.cardMeta}>
                        <Text style={styles.cardMetaText}>{(inc.categoria ?? '—').toString()}</Text>
                        <Text style={styles.cardMetaText}> • </Text>
                        <Text style={styles.cardMetaText}>{(inc.zona ?? '—').toString()}</Text>
                      </View>
                      <View style={styles.cardReparadoWrap}>
                        {(inc.estado_valoracion ?? '').toString().toUpperCase() === 'REPARADO' ? (
                          <View style={styles.cardReparadoRow}>
                            <MaterialIcons name="check-circle" size={12} color="#0f766e" />
                            <Text style={styles.cardReparadoText}>
                              Reparado {inc.fecha_completada ? formatearFecha(inc.fecha_completada as string) : ''}
                            </Text>
                          </View>
                        ) : (
                          <TouchableOpacity
                            onPress={() => marcarReparado(inc)}
                            disabled={marcandoReparadoKey === `${(inc.local_id ?? '').toString().trim()}-${(inc.id_incidencia ?? '').toString().trim()}-${(inc.fecha_creacion ?? '').toString().trim()}`}
                            style={styles.cardReparadoBtn}
                            activeOpacity={0.7}
                          >
                            {marcandoReparadoKey === `${(inc.local_id ?? '').toString().trim()}-${(inc.id_incidencia ?? '').toString().trim()}-${(inc.fecha_creacion ?? '').toString().trim()}` ? (
                              <ActivityIndicator size="small" color="#0f766e" />
                            ) : (
                              <MaterialIcons name="build" size={16} color="#0f766e" />
                            )}
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { fontSize: 14, color: '#64748b' },
  header: { flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  backBtn: { padding: 4, marginRight: 8 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155', flex: 1 },
  errorWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 12 },
  errorText: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
  retryBtn: { paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#f1f5f9', borderRadius: 10 },
  retryBtnText: { fontSize: 14, fontWeight: '600', color: '#0ea5e9' },
  scroll: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 24 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#64748b' },
  emptySub: { fontSize: 13, color: '#94a3b8', textAlign: 'center', maxWidth: 280 },
  group: { marginBottom: 20 },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingVertical: 4,
    paddingHorizontal: 12,
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#0ea5e9',
    width: 700,
    height: 20,
  },
  groupTitleWrap: { width: '25%', minWidth: 0 },
  groupTitle: { fontSize: 12, fontWeight: '700', color: '#334155' },
  groupBadge: { backgroundColor: '#0ea5e9', paddingVertical: 2, paddingHorizontal: 8, borderRadius: 10 },
  groupBadgeText: { fontSize: 11, fontWeight: '600', color: '#fff' },
  cardRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: {
    width: '31%',
    minWidth: 100,
    height: 100,
    aspectRatio: 1,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 8,
    overflow: 'hidden',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4, marginBottom: 4 },
  cardTitle: { fontSize: 12, fontWeight: '600', color: '#334155', flex: 1, minWidth: 0 },
  prioridadBadge: { paddingVertical: 2, paddingHorizontal: 6, borderRadius: 4 },
  prioridadBadgeText: { fontSize: 9, fontWeight: '700', color: '#fff' },
  cardDesc: { fontSize: 10, color: '#64748b', lineHeight: 14, marginBottom: 4 },
  cardMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  cardMetaText: { fontSize: 9, color: '#94a3b8' },
  cardReparadoWrap: { marginTop: -6, alignItems: 'flex-end' },
  cardReparadoRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardReparadoText: { fontSize: 9, fontWeight: '600', color: '#0d9488' },
  cardReparadoBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0,
    backgroundColor: '#f0fdfa',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#99f6e4',
  },
});
