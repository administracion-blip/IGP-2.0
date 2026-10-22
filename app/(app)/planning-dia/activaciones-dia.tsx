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
import { puedeVerActivacionesPlanning } from '../../lib/permisosModulos';
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

/** Valor especial: cargar activaciones de todos los locales permitidos. */
export const LOCAL_TODOS = '__todos__';

export default function ActivacionesDiaScreen() {
  const router = useRouter();
  const { localPermitido, hasPermiso } = useAuth();
  const puedeVer = puedeVerActivacionesPlanning(hasPermiso);

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
      {!puedeVer ? (
        <View style={styles.emptyBox}>
          <MaterialIcons name="lock-outline" size={28} color={colors.textMuted} />
          <Text style={styles.emptyText}>No tienes permiso para ver las activaciones del día.</Text>
        </View>
      ) : (
        <>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Activaciones del día</Text>
          <Text style={styles.subtitle}>Jornada {jornada}</Text>
        </View>
        <TouchableOpacity onPress={cargar} style={styles.backBtn} disabled={loading}>
          {loading ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <MaterialIcons name="refresh" size={20} color={colors.accent} />
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
          <MaterialIcons name="error-outline" size={16} color={statusColors.danger.text} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={cargar}>
            <Text style={styles.retry}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {localesPermitidos.length === 0 ? (
        <View style={styles.centerBox}>
          <MaterialIcons name="storefront" size={48} color={colors.borderStrong} />
          <Text style={styles.emptyText}>No tienes locales asignados para consultar activaciones.</Text>
        </View>
      ) : loading && sesiones.length === 0 ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : sesiones.length === 0 ? (
        <View style={styles.centerBox}>
          <MaterialIcons name="celebration" size={48} color={colors.borderStrong} />
          <Text style={styles.emptyText}>No hay activaciones programadas para hoy.</Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: SPACING.xl }}>
          {agrupado.map((grupo) => (
            <View key={grupo.idKey} style={styles.bloqueLocal}>
              <View style={styles.localHeader}>
                <MaterialIcons name="storefront" size={18} color={colors.accent} />
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
                        <MaterialIcons name="schedule" size={16} color={statusColors.info.text} />
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
                      <MaterialIcons name="chevron-right" size={18} color={colors.accent} />
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
        </>
      )}
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
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
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, marginTop: 2 },
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
  retry: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.accent },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: SPACING.xl },
  bloqueLocal: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    marginBottom: 10,
  },
  localHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: SPACING.sm,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  localNombre: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text, flex: 1 },
  localCountBadge: {
    backgroundColor: colors.accentMuted,
    borderRadius: radius.md,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    minWidth: 22,
    alignItems: 'center',
  },
  localCountText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text, fontVariant: ['tabular-nums'] },
  card: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  cardPressed: { backgroundColor: colors.bg, borderColor: '#bae6fd' },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 6,
  },
  horaBox: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  horaText: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text, fontVariant: ['tabular-nums'] },
  horaMadrugada: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: statusColors.warning.text, fontStyle: 'italic' },
  badge: { borderRadius: radius.md, paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs },
  badgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  cardTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  cardTipo: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: 2 },
  cardDuracion: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text, marginTop: SPACING.xs },
  verFichaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 10,
    gap: 2,
  },
  verFichaText: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.accent },
  emptyBox: { alignItems: 'center', gap: SPACING.sm, paddingVertical: 40 },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center' },
});
