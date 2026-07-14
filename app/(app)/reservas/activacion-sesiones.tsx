import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  Pressable,
  TextInput,
  Platform,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch } from '../../utils/api';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import {
  type Activacion,
  type ActivacionSesion,
  ESTADO_SESION_META,
  sesionCruzaMedianoche,
} from '../../types/activaciones';

type LocalItem = { id_Locales?: string; nombre?: string; Nombre?: string };

const DIAS_SEMANA = [
  { id: 1, label: 'L' },
  { id: 2, label: 'M' },
  { id: 3, label: 'X' },
  { id: 4, label: 'J' },
  { id: 5, label: 'V' },
  { id: 6, label: 'S' },
  { id: 0, label: 'D' },
];

function fechaEs(iso: string): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '—');
}

function hoyIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Fechas ISO entre desde y hasta (incluidas) cuyo día de semana esté en `dias`. */
function enumerarFechasRepeticion(desdeIso: string, hastaIso: string, dias: Set<number>): string[] {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(desdeIso) || !re.test(hastaIso) || dias.size === 0) return [];
  const out: string[] = [];
  const [y1, m1, d1] = desdeIso.split('-').map(Number);
  const [y2, m2, d2] = hastaIso.split('-').map(Number);
  const cursor = new Date(y1, m1 - 1, d1);
  const fin = new Date(y2, m2 - 1, d2);
  let guard = 0;
  while (cursor.getTime() <= fin.getTime() && guard < 400) {
    if (dias.has(cursor.getDay())) {
      out.push(
        `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`,
      );
    }
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  return out;
}

function normalizarHora(v: string): string {
  const m = String(v || '').trim().match(/^(\d{1,2})[:.]?(\d{2})?$/);
  if (!m) return '';
  const hh = Math.min(23, parseInt(m[1], 10) || 0);
  const mm = Math.min(59, m[2] != null ? parseInt(m[2], 10) : 0);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function confirmar(titulo: string, mensaje: string, onOk: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(`${titulo}\n\n${mensaje}`)) onOk();
    return;
  }
  Alert.alert(titulo, mensaje, [
    { text: 'No', style: 'cancel' },
    { text: 'Sí', style: 'destructive', onPress: onOk },
  ]);
}

export default function ActivacionSesionesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { hasPermiso } = useAuth();
  const puedeGestionar = hasPermiso('activaciones.gestionar');

  const [activacion, setActivacion] = useState<Activacion | null>(null);
  const [sesiones, setSesiones] = useState<ActivacionSesion[]>([]);
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accionandoId, setAccionandoId] = useState<string | null>(null);

  // Modal crear / editar sesión
  const [modalSesion, setModalSesion] = useState(false);
  const [editSesionId, setEditSesionId] = useState<string | null>(null);
  const [nuevaLocalId, setNuevaLocalId] = useState<string | null>(null);
  const [nuevaFecha, setNuevaFecha] = useState('');
  const [nuevaHoraInicio, setNuevaHoraInicio] = useState('');
  const [nuevaHoraFin, setNuevaHoraFin] = useState('');
  const [repetir, setRepetir] = useState(false);
  const [diasRepeticion, setDiasRepeticion] = useState<Set<number>>(new Set());
  const [hastaFecha, setHastaFecha] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);
  const [guardandoSesion, setGuardandoSesion] = useState(false);

  useEffect(() => {
    apiFetch('/api/locales?minimal=1')
      .then((r) => r.json())
      .then((d: { locales?: LocalItem[] }) => setLocales(Array.isArray(d.locales) ? d.locales : []))
      .catch(() => setLocales([]));
  }, []);

  const cargar = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [rFicha, rSes] = await Promise.all([
        apiFetch(`/api/activaciones/${id}`),
        apiFetch(`/api/activaciones/${id}/sesiones`),
      ]);
      const dFicha = await rFicha.json();
      if (!rFicha.ok) throw new Error(dFicha.error || 'No se pudo cargar la activación');
      setActivacion(dFicha.activacion as Activacion);
      const dSes = await rSes.json();
      setSesiones(rSes.ok && Array.isArray(dSes.sesiones) ? dSes.sesiones : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      cargar();
    }, [cargar]),
  );

  const opcionesLocal = useMemo(
    () =>
      locales
        .map((l) => ({
          id: String(l.id_Locales ?? ''),
          titulo: String(l.nombre ?? l.Nombre ?? '—'),
        }))
        .filter((o) => o.id)
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')),
    [locales],
  );

  /** Sesiones agrupadas por local, ordenadas por fecha + hora. */
  const grupos = useMemo(() => {
    const map = new Map<string, { nombre: string; sesiones: ActivacionSesion[] }>();
    for (const s of sesiones) {
      const key = s.id_local || '—';
      if (!map.has(key)) {
        map.set(key, { nombre: s.local_nombre || s.id_local || 'Local sin identificar', sesiones: [] });
      }
      map.get(key)!.sesiones.push(s);
    }
    const out = [...map.values()];
    out.forEach((g) =>
      g.sesiones.sort((a, b) =>
        `${a.fecha}#${a.hora_inicio}`.localeCompare(`${b.fecha}#${b.hora_inicio}`),
      ),
    );
    out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return out;
  }, [sesiones]);

  const abrirModalCrear = () => {
    const fechaDef = activacion?.vigencia_inicio || fechaJornadaNegocioIso();
    setEditSesionId(null);
    setNuevaLocalId(null);
    setNuevaFecha(fechaDef);
    setNuevaHoraInicio('');
    setNuevaHoraFin('');
    setRepetir(false);
    setDiasRepeticion(new Set());
    setHastaFecha(activacion?.vigencia_fin || fechaDef);
    setModalError(null);
    setModalSesion(true);
  };

  const abrirModalEditar = (s: ActivacionSesion) => {
    setEditSesionId(s.id_sesion);
    setNuevaLocalId(s.id_local || null);
    setNuevaFecha(s.fecha);
    setNuevaHoraInicio(s.hora_inicio);
    setNuevaHoraFin(s.hora_fin);
    setRepetir(false);
    setDiasRepeticion(new Set());
    setHastaFecha('');
    setModalError(null);
    setModalSesion(true);
  };

  const cerrarModalSesion = () => {
    setModalSesion(false);
    setEditSesionId(null);
  };

  const guardarSesion = useCallback(async () => {
    setModalError(null);
    const hi = normalizarHora(nuevaHoraInicio);
    let hf = normalizarHora(nuevaHoraFin);
    if (!nuevaLocalId) return setModalError('Selecciona el local.');
    if (!nuevaFecha) return setModalError('Indica la fecha de la jornada.');
    if (!hi) return setModalError('Indica la hora de inicio (HH:mm).');
    if (!hf && activacion?.duracion_horas) {
      const dur = Number(activacion.duracion_horas) || 0;
      const [hh, mm] = hi.split(':').map(Number);
      const totalMin = (hh * 60 + mm + Math.round(dur * 60)) % (24 * 60);
      hf = `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
    }
    if (!hf) return setModalError('Indica la hora de fin (HH:mm).');

    setGuardandoSesion(true);
    try {
      if (editSesionId) {
        const r = await apiFetch(`/api/activaciones/sesiones/${editSesionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id_local: nuevaLocalId,
            fecha: nuevaFecha,
            hora_inicio: hi,
            hora_fin: hf,
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'No se pudo actualizar la sesión');
      } else {
        let entradas: { id_local: string; fecha: string; hora_inicio: string; hora_fin: string }[];
        if (repetir) {
          if (diasRepeticion.size === 0) return setModalError('Selecciona al menos un día de la semana.');
          if (!hastaFecha) return setModalError('Indica la fecha límite de la repetición.');
          const fechas = enumerarFechasRepeticion(nuevaFecha, hastaFecha, diasRepeticion);
          if (fechas.length === 0) return setModalError('El rango de repetición no genera ninguna sesión.');
          entradas = fechas.map((f) => ({ id_local: nuevaLocalId, fecha: f, hora_inicio: hi, hora_fin: hf }));
        } else {
          entradas = [{ id_local: nuevaLocalId, fecha: nuevaFecha, hora_inicio: hi, hora_fin: hf }];
        }
        const r = await apiFetch(`/api/activaciones/${id}/sesiones`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entradas),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'No se pudieron crear las sesiones');
      }
      cerrarModalSesion();
      await cargar();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setGuardandoSesion(false);
    }
  }, [
    id, editSesionId, nuevaLocalId, nuevaFecha, nuevaHoraInicio, nuevaHoraFin, repetir,
    diasRepeticion, hastaFecha, activacion?.duracion_horas, cargar,
  ]);

  const cancelarSesion = useCallback(
    (s: ActivacionSesion) => {
      confirmar('Cancelar sesión', `¿Seguro que quieres cancelar la sesión del ${fechaEs(s.fecha)} en ${s.local_nombre || s.id_local}?`, async () => {
        setAccionandoId(s.id_sesion);
        try {
          const r = await apiFetch(`/api/activaciones/sesiones/${s.id_sesion}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ estado_sesion: 'cancelada' }),
          });
          if (!r.ok) {
            const d = await r.json();
            throw new Error(d.error || 'No se pudo cancelar');
          }
          await cargar();
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Error de red');
        } finally {
          setAccionandoId(null);
        }
      });
    },
    [cargar],
  );

  const eliminarSesion = useCallback(
    (s: ActivacionSesion) => {
      confirmar('Eliminar sesión', `¿Eliminar definitivamente la sesión del ${fechaEs(s.fecha)}?`, async () => {
        setAccionandoId(s.id_sesion);
        try {
          const r = await apiFetch(`/api/activaciones/sesiones/${s.id_sesion}`, { method: 'DELETE' });
          if (!r.ok) {
            const d = await r.json();
            throw new Error(d.error || 'No se pudo eliminar');
          }
          await cargar();
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Error de red');
        } finally {
          setAccionandoId(null);
        }
      });
    },
    [cargar],
  );

  if (!puedeGestionar) {
    return (
      <View style={styles.centerBox}>
        <MaterialIcons name="lock-outline" size={36} color="#94a3b8" />
        <Text style={styles.emptyText}>No tienes permiso para gestionar sesiones.</Text>
      </View>
    );
  }

  const puedeEliminar = (s: ActivacionSesion) =>
    s.estado_sesion === 'cancelada' || s.fecha >= hoyIso();

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>Sesiones</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {activacion ? `${activacion.codigo} · ${activacion.marca}` : '—'}
          </Text>
        </View>
        <TouchableOpacity style={styles.nuevaBtn} onPress={abrirModalCrear}>
          <MaterialIcons name="add" size={16} color="#fff" />
          <Text style={styles.nuevaBtnText}>Nueva sesión</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <MaterialIcons name="error-outline" size={16} color="#b91c1c" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={cargar}>
            <Text style={styles.retry}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#0ea5e9" />
        </View>
      ) : grupos.length === 0 ? (
        <View style={styles.centerBox}>
          <MaterialIcons name="event-busy" size={48} color="#cbd5e1" />
          <Text style={styles.emptyText}>No hay sesiones programadas. Crea la primera con «Nueva sesión».</Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
          {grupos.map((g) => (
            <View key={g.nombre} style={styles.grupoCard}>
              <View style={styles.grupoHeader}>
                <MaterialIcons name="storefront" size={16} color="#0369a1" />
                <Text style={styles.grupoNombre}>{g.nombre}</Text>
                <Text style={styles.grupoMeta}>{g.sesiones.length} sesión(es)</Text>
              </View>
              {g.sesiones.map((s) => {
                const sm = ESTADO_SESION_META[s.estado_sesion] ?? ESTADO_SESION_META.programada;
                const accionando = accionandoId === s.id_sesion;
                return (
                  <View key={s.id_sesion} style={styles.sesionRow}>
                    <Text style={styles.sesionFecha}>{fechaEs(s.fecha)}</Text>
                    <Text style={styles.sesionHora}>
                      {s.hora_inicio} – {s.hora_fin}
                      {sesionCruzaMedianoche(s) ? ' (+1)' : ''}
                    </Text>
                    {s.incidencia ? (
                      <MaterialIcons name="warning-amber" size={16} color="#d97706" />
                    ) : null}
                    <View style={[styles.badgeMini, { backgroundColor: sm.bg }]}>
                      <Text style={[styles.badgeMiniText, { color: sm.text }]}>{sm.label}</Text>
                    </View>
                    <View style={{ flex: 1 }} />
                    {accionando ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <>
                        <TouchableOpacity
                          onPress={() => abrirModalEditar(s)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityLabel="Editar sesión"
                        >
                          <MaterialIcons name="edit" size={19} color="#0ea5e9" />
                        </TouchableOpacity>
                        {s.estado_sesion === 'programada' ? (
                          <TouchableOpacity
                            onPress={() => cancelarSesion(s)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            accessibilityLabel="Cancelar sesión"
                          >
                            <MaterialIcons name="event-busy" size={19} color="#d97706" />
                          </TouchableOpacity>
                        ) : null}
                        {puedeEliminar(s) ? (
                          <TouchableOpacity
                            onPress={() => eliminarSesion(s)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            accessibilityLabel="Eliminar sesión"
                          >
                            <MaterialIcons name="delete-outline" size={19} color="#dc2626" />
                          </TouchableOpacity>
                        ) : null}
                      </>
                    )}
                  </View>
                );
              })}
            </View>
          ))}
        </ScrollView>
      )}

      <Modal visible={modalSesion} transparent animationType="fade" onRequestClose={cerrarModalSesion}>
        <Pressable style={styles.overlay} onPress={cerrarModalSesion}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editSesionId ? 'Editar sesión' : 'Nueva sesión'}</Text>
              <TouchableOpacity onPress={cerrarModalSesion} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ padding: 14 }} keyboardShouldPersistTaps="handled">
              <SelectorDesplegable
                label="Local"
                icono="storefront"
                tituloLista="Local"
                iconoLista="storefront"
                placeholder="Selecciona el local…"
                opciones={opcionesLocal}
                valorId={nuevaLocalId}
                onSeleccionar={setNuevaLocalId}
                buscador
              />
              <Text style={styles.label}>Fecha de la jornada (día en que empieza la activación)</Text>
              <InputFecha valueIso={nuevaFecha} onChangeIso={setNuevaFecha} style={styles.input} />
              <View style={styles.row2}>
                <View style={styles.col}>
                  <Text style={styles.label}>Hora de inicio</Text>
                  <TextInput
                    style={styles.input}
                    value={nuevaHoraInicio}
                    onChangeText={setNuevaHoraInicio}
                    placeholder="23:00"
                    placeholderTextColor="#94a3b8"
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
                <View style={styles.col}>
                  <Text style={styles.label}>Hora de fin</Text>
                  <TextInput
                    style={styles.input}
                    value={nuevaHoraFin}
                    onChangeText={setNuevaHoraFin}
                    placeholder="01:00"
                    placeholderTextColor="#94a3b8"
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
              </View>
              {normalizarHora(nuevaHoraFin) && normalizarHora(nuevaHoraInicio) &&
              normalizarHora(nuevaHoraFin) < normalizarHora(nuevaHoraInicio) ? (
                <Text style={styles.notaMadrugada}>
                  La activación finaliza en la madrugada del día siguiente (misma jornada).
                </Text>
              ) : null}

              {!editSesionId ? (
              <TouchableOpacity style={styles.checkRow} onPress={() => setRepetir((v) => !v)} activeOpacity={0.7}>
                <MaterialIcons
                  name={repetir ? 'check-box' : 'check-box-outline-blank'}
                  size={20}
                  color={repetir ? '#0ea5e9' : '#94a3b8'}
                />
                <Text style={styles.checkLabel}>Repetir esta sesión</Text>
              </TouchableOpacity>
              ) : null}

              {repetir && !editSesionId ? (
                <View style={styles.repetirBox}>
                  <Text style={styles.label}>Días de la semana</Text>
                  <View style={styles.diasRow}>
                    {DIAS_SEMANA.map((d) => {
                      const activo = diasRepeticion.has(d.id);
                      return (
                        <TouchableOpacity
                          key={d.id}
                          style={[styles.diaChip, activo && styles.diaChipActivo]}
                          onPress={() =>
                            setDiasRepeticion((prev) => {
                              const next = new Set(prev);
                              if (next.has(d.id)) next.delete(d.id);
                              else next.add(d.id);
                              return next;
                            })
                          }
                        >
                          <Text style={[styles.diaChipText, activo && styles.diaChipTextActivo]}>{d.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <Text style={styles.label}>Hasta la fecha</Text>
                  <InputFecha valueIso={hastaFecha} onChangeIso={setHastaFecha} style={styles.input} />
                </View>
              ) : null}

              {modalError ? (
                <View style={styles.errorBanner}>
                  <MaterialIcons name="error-outline" size={16} color="#b91c1c" />
                  <Text style={styles.errorText}>{modalError}</Text>
                </View>
              ) : null}

              <TouchableOpacity
                style={[styles.guardarBtn, guardandoSesion && { opacity: 0.6 }]}
                onPress={guardarSesion}
                disabled={guardandoSesion}
              >
                {guardandoSesion ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <MaterialIcons name="save" size={16} color="#fff" />
                )}
                <Text style={styles.guardarBtnText}>Guardar</Text>
              </TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  retry: { fontSize: 12, fontWeight: '700', color: '#0ea5e9' },
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
  subtitle: { fontSize: 12, color: '#94a3b8', marginTop: 1 },
  nuevaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  nuevaBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
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
  grupoCard: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    marginBottom: 10,
    overflow: 'hidden',
  },
  grupoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  grupoNombre: { flex: 1, fontSize: 14, fontWeight: '700', color: '#0f172a' },
  grupoMeta: { fontSize: 11, color: '#94a3b8' },
  sesionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  sesionFecha: { fontSize: 13, color: '#334155', width: 84 },
  sesionHora: { fontSize: 13, color: '#0f172a', fontWeight: '600' },
  badgeMini: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  badgeMiniText: { fontSize: 10, fontWeight: '700' },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  modalTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  label: { fontSize: 12, fontWeight: '600', color: '#64748b', marginBottom: 4, marginTop: 10 },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
    color: '#0f172a',
  },
  row2: { flexDirection: 'row', gap: 10 },
  col: { flex: 1, minWidth: 0 },
  notaMadrugada: { fontSize: 12, color: '#b45309', marginTop: 8, fontStyle: 'italic' },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  checkLabel: { fontSize: 13, color: '#334155', fontWeight: '500' },
  repetirBox: {
    marginTop: 6,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 10,
  },
  diasRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  diaChip: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  diaChipActivo: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  diaChipText: { fontSize: 12, fontWeight: '700', color: '#64748b' },
  diaChipTextActivo: { color: '#fff' },
  guardarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#16a34a',
    borderRadius: 10,
    paddingVertical: 12,
    marginTop: 16,
  },
  guardarBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});
