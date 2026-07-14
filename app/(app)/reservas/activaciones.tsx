import { useCallback, useEffect, useMemo, useState } from 'react';

import {

  View,

  Text,

  StyleSheet,

  TouchableOpacity,

  ScrollView,

  ActivityIndicator,

} from 'react-native';

import { useRouter } from 'expo-router';

import { useFocusEffect } from '@react-navigation/native';

import { MaterialIcons } from '@expo/vector-icons';

import { useAuth } from '../../contexts/AuthContext';

import { useBreakpoint } from '../../hooks/useBreakpoint';

import { apiFetch } from '../../utils/api';

import {

  ETIQUETAS_DIA_CORTO,

  etiquetaSemana,

  inicioSemanaLunes,

  isoDesdeDate,

  rangoSemanaDesde,

} from '../../lib/semana';

import {

  type Activacion,

  type ActivacionSesionDia,

  type EstadoActivacion,

  ESTADO_ACTIVACION_META,

  ESTADO_SESION_META,

} from '../../types/activaciones';



type FiltroEstado = EstadoActivacion | 'todas';

type VistaModo = 'lista' | 'calendario';



const FILTROS: { id: FiltroEstado; label: string }[] = [

  { id: 'activa', label: 'Activas' },

  { id: 'borrador', label: 'Borrador' },

  { id: 'archivada', label: 'Archivadas' },

  { id: 'todas', label: 'Todas' },

];



const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];



function fechaCorta(iso: string): string {

  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!m) return '';

  return `${parseInt(m[3], 10)} ${MESES_CORTOS[parseInt(m[2], 10) - 1]} ${m[1]}`;

}



function diaMes(iso: string): string {

  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  return m ? String(parseInt(m[3], 10)) : '';

}



export default function ActivacionesListaScreen() {

  const router = useRouter();

  const { hasPermiso } = useAuth();

  const { shouldStackPanels } = useBreakpoint();

  const puedeGestionar = hasPermiso('activaciones.gestionar');



  const [activaciones, setActivaciones] = useState<Activacion[]>([]);

  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);

  const [filtro, setFiltro] = useState<FiltroEstado>('activa');

  const [vista, setVista] = useState<VistaModo>('calendario');



  const [inicioSemana, setInicioSemana] = useState(() => inicioSemanaLunes(new Date()));

  const [sesionesSemana, setSesionesSemana] = useState<ActivacionSesionDia[]>([]);

  const [programadasSiguiente, setProgramadasSiguiente] = useState(0);

  const [loadingCal, setLoadingCal] = useState(false);



  const rangoSemana = useMemo(() => rangoSemanaDesde(inicioSemana), [inicioSemana]);

  const rangoSiguiente = useMemo(() => {

    const next = new Date(inicioSemana);

    next.setDate(next.getDate() + 7);

    return rangoSemanaDesde(next);

  }, [inicioSemana]);



  const cargar = useCallback(async () => {

    setLoading(true);

    setError(null);

    try {

      const r = await apiFetch('/api/activaciones');

      const d = await r.json();

      if (!r.ok) throw new Error(d.error || 'No se pudieron cargar las activaciones');

      setActivaciones(Array.isArray(d.activaciones) ? d.activaciones : []);

    } catch (e) {

      setError(e instanceof Error ? e.message : 'Error de red');

      setActivaciones([]);

    } finally {

      setLoading(false);

    }

  }, []);



  const cargarCalendario = useCallback(async () => {

    setLoadingCal(true);

    try {

      const [rSem, rSig] = await Promise.all([

        apiFetch(

          `/api/activaciones/sesiones/rango?desde=${encodeURIComponent(rangoSemana.desde)}&hasta=${encodeURIComponent(rangoSemana.hasta)}`,

        ),

        apiFetch(

          `/api/activaciones/sesiones/rango?desde=${encodeURIComponent(rangoSiguiente.desde)}&hasta=${encodeURIComponent(rangoSiguiente.hasta)}`,

        ),

      ]);

      const dSem = await rSem.json();

      const dSig = await rSig.json();

      setSesionesSemana(rSem.ok && Array.isArray(dSem.sesiones) ? dSem.sesiones : []);

      const sigSesiones = rSig.ok && Array.isArray(dSig.sesiones) ? dSig.sesiones : [];

      setProgramadasSiguiente(sigSesiones.filter((s: ActivacionSesionDia) => s.estado_sesion === 'programada').length);

    } catch {

      setSesionesSemana([]);

      setProgramadasSiguiente(0);

    } finally {

      setLoadingCal(false);

    }

  }, [rangoSemana.desde, rangoSemana.hasta, rangoSiguiente.desde, rangoSiguiente.hasta]);



  useFocusEffect(
    useCallback(() => {
      cargar();
      cargarCalendario();
    }, [cargar, cargarCalendario]),
  );

  useEffect(() => {
    if (vista === 'calendario') cargarCalendario();
  }, [inicioSemana, vista, cargarCalendario]);

  const visibles = useMemo(() => {

    if (filtro === 'todas') return activaciones;

    return activaciones.filter((a) => (a.estado || 'borrador') === filtro);

  }, [activaciones, filtro]);



  const sesionesPorDia = useMemo(() => {

    const map = new Map<string, ActivacionSesionDia[]>();

    for (const iso of rangoSemana.dias) map.set(iso, []);

    for (const s of sesionesSemana) {

      const list = map.get(s.fecha);

      if (list) list.push(s);

    }

    for (const list of map.values()) {

      list.sort((a, b) => String(a.hora_inicio).localeCompare(String(b.hora_inicio)));

    }

    return map;

  }, [sesionesSemana, rangoSemana.dias]);



  const programadasSemana = useMemo(

    () => sesionesSemana.filter((s) => s.estado_sesion === 'programada').length,

    [sesionesSemana],

  );



  const irSemanaAnterior = () => {

    const d = new Date(inicioSemana);

    d.setDate(d.getDate() - 7);

    setInicioSemana(d);

  };



  const irSemanaSiguiente = () => {

    const d = new Date(inicioSemana);

    d.setDate(d.getDate() + 7);

    setInicioSemana(d);

  };



  const irSemanaActual = () => setInicioSemana(inicioSemanaLunes(new Date()));



  return (

    <View style={styles.container}>

      <View style={styles.headerRow}>

        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>

          <MaterialIcons name="arrow-back" size={22} color="#334155" />

        </TouchableOpacity>

        <View style={{ flex: 1 }}>

          <Text style={styles.title}>Activaciones de marca</Text>

          <Text style={styles.subtitle}>Campañas pactadas con marcas de bebidas</Text>

        </View>

        <TouchableOpacity onPress={() => { cargar(); cargarCalendario(); }} style={styles.backBtn} disabled={loading || loadingCal}>

          {loading || loadingCal ? (

            <ActivityIndicator size="small" color="#0ea5e9" />

          ) : (

            <MaterialIcons name="refresh" size={20} color="#0ea5e9" />

          )}

        </TouchableOpacity>

      </View>



      <View style={styles.vistaRow}>

        <TouchableOpacity

          style={[styles.vistaBtn, vista === 'calendario' && styles.vistaBtnActivo]}

          onPress={() => setVista('calendario')}

        >

          <MaterialIcons name="calendar-view-week" size={16} color={vista === 'calendario' ? '#0369a1' : '#64748b'} />

          <Text style={[styles.vistaBtnText, vista === 'calendario' && styles.vistaBtnTextActivo]}>Semana</Text>

        </TouchableOpacity>

        <TouchableOpacity

          style={[styles.vistaBtn, vista === 'lista' && styles.vistaBtnActivo]}

          onPress={() => setVista('lista')}

        >

          <MaterialIcons name="list" size={16} color={vista === 'lista' ? '#0369a1' : '#64748b'} />

          <Text style={[styles.vistaBtnText, vista === 'lista' && styles.vistaBtnTextActivo]}>Lista</Text>

        </TouchableOpacity>

      </View>



      {vista === 'lista' ? (

        <>

          <View style={styles.chipsRow}>

            {FILTROS.map((f) => {

              const activo = filtro === f.id;

              return (

                <TouchableOpacity

                  key={f.id}

                  style={[styles.chip, activo && styles.chipActivo]}

                  onPress={() => setFiltro(f.id)}

                  activeOpacity={0.7}

                >

                  <Text style={[styles.chipText, activo && styles.chipTextActivo]}>{f.label}</Text>

                </TouchableOpacity>

              );

            })}

          </View>



          {error ? (

            <View style={styles.errorBanner}>

              <MaterialIcons name="error-outline" size={16} color="#b91c1c" />

              <Text style={styles.errorText}>{error}</Text>

            </View>

          ) : null}



          {loading && activaciones.length === 0 ? (

            <View style={styles.centerBox}>

              <ActivityIndicator size="large" color="#0ea5e9" />

            </View>

          ) : visibles.length === 0 ? (

            <View style={styles.centerBox}>

              <MaterialIcons name="celebration" size={48} color="#cbd5e1" />

              <Text style={styles.emptyText}>No hay activaciones con este filtro.</Text>

            </View>

          ) : (

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 90 }}>

              {visibles.map((a) => {

                const meta = ESTADO_ACTIVACION_META[a.estado] ?? ESTADO_ACTIVACION_META.borrador;

                return (

                  <TouchableOpacity

                    key={a.id_activacion}

                    style={styles.card}

                    onPress={() => router.push(`/reservas/activacion-detalle?id=${a.id_activacion}` as never)}

                    activeOpacity={0.7}

                  >

                    <View style={{ flex: 1, minWidth: 0 }}>

                      <Text style={styles.cardTitle} numberOfLines={1}>{a.marca} · {a.producto}</Text>

                      <Text style={styles.cardCodigo} numberOfLines={1}>{a.codigo}</Text>

                      <Text style={styles.cardMeta} numberOfLines={1}>

                        {[a.tipo_activacion, [fechaCorta(a.vigencia_inicio), fechaCorta(a.vigencia_fin)].filter(Boolean).join(' – ')].filter(Boolean).join(' · ')}

                      </Text>

                    </View>

                    {(a.sesiones_programadas ?? 0) > 0 ? (

                      <View style={styles.pendientes}>

                        <MaterialIcons name="pending-actions" size={14} color="#0369a1" />

                        <Text style={styles.pendientesText}>{a.sesiones_programadas}</Text>

                      </View>

                    ) : null}

                    <View style={[styles.badge, { backgroundColor: meta.bg }]}>

                      <Text style={[styles.badgeText, { color: meta.text }]}>{meta.label}</Text>

                    </View>

                    <MaterialIcons name="chevron-right" size={20} color="#94a3b8" />

                  </TouchableOpacity>

                );

              })}

            </ScrollView>

          )}

        </>

      ) : (

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 90 }}>

          <View style={styles.calNav}>

            <TouchableOpacity style={styles.calNavBtn} onPress={irSemanaAnterior}>

              <MaterialIcons name="chevron-left" size={22} color="#334155" />

            </TouchableOpacity>

            <TouchableOpacity style={styles.calNavCenter} onPress={irSemanaActual}>

              <Text style={styles.calNavTitulo}>{etiquetaSemana(rangoSemana.desde, rangoSemana.hasta)}</Text>

              <Text style={styles.calNavSub}>{programadasSemana} programada(s) esta semana</Text>

            </TouchableOpacity>

            <TouchableOpacity style={styles.calNavBtn} onPress={irSemanaSiguiente}>

              <MaterialIcons name="chevron-right" size={22} color="#334155" />

            </TouchableOpacity>

          </View>



          <View style={styles.sigSemanaBanner}>

            <MaterialIcons name="event" size={16} color="#0369a1" />

            <Text style={styles.sigSemanaText}>

              Siguiente semana: <Text style={styles.sigSemanaNum}>{programadasSiguiente}</Text> activación(es) programada(s)

            </Text>

          </View>



          {loadingCal ? (

            <ActivityIndicator size="large" color="#0ea5e9" style={{ marginTop: 24 }} />

          ) : (

            <View style={[styles.calGrid, shouldStackPanels && styles.calGridStack]}>

              {rangoSemana.dias.map((iso, idx) => {

                const list = sesionesPorDia.get(iso) ?? [];

                const esHoy = iso === isoDesdeDate(new Date());

                return (

                  <View key={iso} style={[styles.calDiaCol, shouldStackPanels && styles.calDiaColStack]}>

                    <View style={[styles.calDiaHead, esHoy && styles.calDiaHeadHoy]}>

                      <Text style={[styles.calDiaLabel, esHoy && styles.calDiaLabelHoy]}>{ETIQUETAS_DIA_CORTO[idx]}</Text>

                      <Text style={[styles.calDiaNum, esHoy && styles.calDiaLabelHoy]}>{diaMes(iso)}</Text>

                    </View>

                    {list.length === 0 ? (

                      <Text style={styles.calVacio}>—</Text>

                    ) : (

                      list.map((s) => {

                        const sm = ESTADO_SESION_META[s.estado_sesion] ?? ESTADO_SESION_META.programada;

                        return (

                          <TouchableOpacity

                            key={s.id_sesion}

                            style={styles.calEvento}

                            onPress={() => router.push(`/reservas/activacion-detalle?id=${s.id_activacion}` as never)}

                            activeOpacity={0.7}

                          >

                            <Text style={styles.calEventoHora}>{s.hora_inicio} – {s.hora_fin}</Text>

                            <Text style={styles.calEventoMarca} numberOfLines={2}>{s.marca}</Text>

                            <Text style={styles.calEventoLocal} numberOfLines={1}>{s.local_nombre || s.id_local}</Text>

                            {s.duracion_horas ? (

                              <Text style={styles.calEventoDur}>{s.duracion_horas} h</Text>

                            ) : null}

                            <View style={[styles.calEventoBadge, { backgroundColor: sm.bg }]}>

                              <Text style={[styles.calEventoBadgeText, { color: sm.text }]}>{sm.label}</Text>

                            </View>

                          </TouchableOpacity>

                        );

                      })

                    )}

                  </View>

                );

              })}

            </View>

          )}

        </ScrollView>

      )}



      {puedeGestionar ? (

        <TouchableOpacity

          style={styles.fab}

          onPress={() => router.push('/reservas/activacion-nueva' as never)}

          activeOpacity={0.8}

          accessibilityLabel="Nueva activación"

        >

          <MaterialIcons name="add" size={28} color="#fff" />

        </TouchableOpacity>

      ) : null}

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

  vistaRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },

  vistaBtn: {

    flex: 1,

    flexDirection: 'row',

    alignItems: 'center',

    justifyContent: 'center',

    gap: 6,

    paddingVertical: 8,

    borderRadius: 8,

    backgroundColor: '#f8fafc',

    borderWidth: 1,

    borderColor: '#e2e8f0',

  },

  vistaBtnActivo: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc' },

  vistaBtnText: { fontSize: 13, fontWeight: '600', color: '#64748b' },

  vistaBtnTextActivo: { color: '#0369a1' },

  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },

  chip: {

    paddingHorizontal: 12,

    paddingVertical: 6,

    borderRadius: 16,

    backgroundColor: '#f1f5f9',

    borderWidth: 1,

    borderColor: '#e2e8f0',

  },

  chipActivo: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc' },

  chipText: { fontSize: 12, color: '#475569', fontWeight: '500' },

  chipTextActivo: { color: '#0369a1', fontWeight: '700' },

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

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 200 },

  emptyText: { fontSize: 13, color: '#94a3b8', textAlign: 'center' },

  card: {

    flexDirection: 'row',

    alignItems: 'center',

    gap: 10,

    backgroundColor: '#fff',

    borderWidth: 1,

    borderColor: '#e2e8f0',

    borderRadius: 10,

    padding: 12,

    marginBottom: 8,

  },

  cardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a' },

  cardCodigo: { fontSize: 11, color: '#94a3b8', marginTop: 1 },

  cardMeta: { fontSize: 12, color: '#64748b', marginTop: 3 },

  pendientes: {

    flexDirection: 'row',

    alignItems: 'center',

    gap: 3,

    backgroundColor: '#e0f2fe',

    borderRadius: 10,

    paddingHorizontal: 7,

    paddingVertical: 3,

  },

  pendientesText: { fontSize: 11, fontWeight: '700', color: '#0369a1' },

  badge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },

  badgeText: { fontSize: 11, fontWeight: '700' },

  calNav: {

    flexDirection: 'row',

    alignItems: 'center',

    gap: 8,

    marginBottom: 10,

    backgroundColor: '#fff',

    borderWidth: 1,

    borderColor: '#e2e8f0',

    borderRadius: 10,

    padding: 8,

  },

  calNavBtn: {

    width: 36,

    height: 36,

    borderRadius: 8,

    backgroundColor: '#f8fafc',

    alignItems: 'center',

    justifyContent: 'center',

  },

  calNavCenter: { flex: 1, alignItems: 'center' },

  calNavTitulo: { fontSize: 14, fontWeight: '700', color: '#0f172a' },

  calNavSub: { fontSize: 11, color: '#64748b', marginTop: 2 },

  sigSemanaBanner: {

    flexDirection: 'row',

    alignItems: 'center',

    gap: 8,

    backgroundColor: '#f0f9ff',

    borderWidth: 1,

    borderColor: '#bae6fd',

    borderRadius: 8,

    padding: 10,

    marginBottom: 12,

  },

  sigSemanaText: { flex: 1, fontSize: 12, color: '#334155' },

  sigSemanaNum: { fontWeight: '800', color: '#0369a1' },

  calGrid: { flexDirection: 'row', gap: 6 },

  calGridStack: { flexDirection: 'column' },

  calDiaCol: {

    flex: 1,

    minWidth: 0,

    backgroundColor: '#fff',

    borderWidth: 1,

    borderColor: '#e2e8f0',

    borderRadius: 8,

    padding: 6,

    minHeight: 120,

  },

  calDiaColStack: { minHeight: 0 },

  calDiaHead: {

    alignItems: 'center',

    paddingBottom: 6,

    marginBottom: 6,

    borderBottomWidth: 1,

    borderBottomColor: '#f1f5f9',

  },

  calDiaHeadHoy: { backgroundColor: '#fef2f2', borderRadius: 6, marginHorizontal: -4, paddingTop: 4 },

  calDiaLabel: { fontSize: 10, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },

  calDiaNum: { fontSize: 16, fontWeight: '800', color: '#0f172a' },

  calDiaLabelHoy: { color: '#dc2626' },

  calVacio: { fontSize: 12, color: '#cbd5e1', textAlign: 'center', marginTop: 8 },

  calEvento: {

    backgroundColor: '#f8fafc',

    borderWidth: 1,

    borderColor: '#e2e8f0',

    borderRadius: 6,

    padding: 6,

    marginBottom: 6,

  },

  calEventoHora: { fontSize: 10, fontWeight: '700', color: '#0369a1' },

  calEventoMarca: { fontSize: 11, fontWeight: '600', color: '#0f172a', marginTop: 2 },

  calEventoLocal: { fontSize: 10, color: '#64748b', marginTop: 1 },

  calEventoDur: { fontSize: 10, fontWeight: '600', color: '#0369a1', marginTop: 2 },

  calEventoBadge: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2, marginTop: 4 },

  calEventoBadgeText: { fontSize: 9, fontWeight: '700' },

  fab: {

    position: 'absolute',

    right: 18,

    bottom: 18,

    width: 54,

    height: 54,

    borderRadius: 27,

    backgroundColor: '#0ea5e9',

    alignItems: 'center',

    justifyContent: 'center',

    elevation: 4,

  },

});


