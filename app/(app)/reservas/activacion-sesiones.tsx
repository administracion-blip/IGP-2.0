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
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';

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
        <MaterialIcons name="lock-outline" size={36} color={colors.textMuted} />
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
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>Sesiones</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {activacion ? `${activacion.codigo} · ${activacion.marca}` : '—'}
          </Text>
        </View>
        <TouchableOpacity style={styles.nuevaBtn} onPress={abrirModalCrear}>
          <MaterialIcons name="add" size={16} color={colors.surface} />
          <Text style={styles.nuevaBtnText}>Nueva sesión</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <MaterialIcons name="error-outline" size={16} color={statusColors.danger.text} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={cargar}>
            <Text style={styles.retry}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : grupos.length === 0 ? (
        <View style={styles.centerBox}>
          <MaterialIcons name="event-busy" size={48} color={colors.borderStrong} />
          <Text style={styles.emptyText}>No hay sesiones programadas. Crea la primera con «Nueva sesión».</Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
          {grupos.map((g) => (
            <View key={g.nombre} style={styles.grupoCard}>
              <View style={styles.grupoHeader}>
                <MaterialIcons name="storefront" size={16} color={statusColors.info.text} />
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
                      <MaterialIcons name="warning-amber" size={16} color={colors.warning} />
                    ) : null}
                    <View style={[styles.badgeMini, { backgroundColor: sm.bg }]}>
                      <Text style={[styles.badgeMiniText, { color: sm.text }]}>{sm.label}</Text>
                    </View>
                    <View style={{ flex: 1 }} />
                    {accionando ? (
                      <ActivityIndicator size="small" color={colors.accent} />
                    ) : (
                      <>
                        <TouchableOpacity
                          onPress={() => abrirModalEditar(s)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityLabel="Editar sesión"
                        >
                          <MaterialIcons name="edit" size={19} color={colors.accent} />
                        </TouchableOpacity>
                        {s.estado_sesion === 'programada' ? (
                          <TouchableOpacity
                            onPress={() => cancelarSesion(s)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            accessibilityLabel="Cancelar sesión"
                          >
                            <MaterialIcons name="event-busy" size={19} color={colors.warning} />
                          </TouchableOpacity>
                        ) : null}
                        {puedeEliminar(s) ? (
                          <TouchableOpacity
                            onPress={() => eliminarSesion(s)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            accessibilityLabel="Eliminar sesión"
                          >
                            <MaterialIcons name="delete-outline" size={19} color={colors.danger} />
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
                <MaterialIcons name="close" size={22} color={colors.textMuted} />
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
                    placeholderTextColor={colors.textMuted}
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
                    placeholderTextColor={colors.textMuted}
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
                  color={repetir ? colors.accent : colors.textMuted}
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
                  <MaterialIcons name="error-outline" size={16} color={statusColors.danger.text} />
                  <Text style={styles.errorText}>{modalError}</Text>
                </View>
              ) : null}

              <TouchableOpacity
                style={[styles.guardarBtn, guardandoSesion && { opacity: 0.6 }]}
                onPress={guardarSesion}
                disabled={guardandoSesion}
              >
                {guardandoSesion ? (
                  <ActivityIndicator size="small" color={colors.surface} />
                ) : (
                  <MaterialIcons name="save" size={16} color={colors.surface} />
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

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;
/** Entre radius.lg (12) y radius.xl (16). */
const RADIO_TARJETA = 14;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: SPACING.xl },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, textAlign: 'center' },
  retry: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.accent },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.md, gap: 10 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { fontSize: fontSizes[20], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: 1 },
  nuevaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: colors.accent,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.md,
    paddingVertical: 9,
  },
  nuevaBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: statusColors.danger.bg,
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: RADIO_MEDIO,
    padding: 10,
    marginBottom: 10,
  },
  errorText: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: statusColors.danger.text },
  grupoCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: 10,
    overflow: 'hidden',
  },
  grupoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  grupoNombre: { flex: 1, fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  grupoMeta: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted },
  sesionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: SPACING.md,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
  },
  sesionFecha: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, width: 84, fontVariant: ['tabular-nums'] },
  sesionHora: { fontSize: fontSizes[13], color: colors.textStrong, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontVariant: ['tabular-nums'] },
  badgeMini: { borderRadius: RADIO_MEDIO, paddingHorizontal: 7, paddingVertical: 3 },
  badgeMiniText: { fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  /** Negro al 35 %. colors.overlay es slate. */
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: colors.surface,
    borderRadius: RADIO_TARJETA,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  modalTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  label: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, marginBottom: SPACING.xs, marginTop: 10 },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontFamily: fontFamily.regular, fontSize: fontSizes[14],
    color: colors.textStrong,
  },
  row2: { flexDirection: 'row', gap: 10 },
  col: { flex: 1, minWidth: 0 },
  notaMadrugada: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: statusColors.warning.text, marginTop: SPACING.sm, fontStyle: 'italic' },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: 14 },
  checkLabel: { fontSize: fontSizes[13], color: colors.textPrimary, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  repetirBox: {
    marginTop: 6,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 10,
  },
  diasRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  /** Círculo 36×36. */
  diaChip: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  diaChipActivo: { backgroundColor: colors.accent, borderColor: colors.accent },
  diaChipText: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted },
  diaChipTextActivo: { color: colors.surface },
  guardarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.success,
    borderRadius: radius.md,
    paddingVertical: SPACING.md,
    marginTop: SPACING.lg,
  },
  guardarBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface },
});
