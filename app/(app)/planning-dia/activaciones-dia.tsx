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
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH, SPACING } from '../../constants/layout';
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
} from '../../constants/theme';

type LocalItem = { id_Locales?: string; nombre?: string; Nombre?: string };

/** Valor especial: cargar activaciones de todos los locales permitidos. */
export const LOCAL_TODOS = '__todos__';

/** Hasta las 09:30 la hora cae en la madrugada de la jornada, después del tramo de noche. */
function claveMinutoJornada(hora: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hora.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const base = h * 60 + min;
  return h < 9 || (h === 9 && min <= 30) ? base + 24 * 60 : base;
}

function tituloJornada(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `Jornada ${m[3]}/${m[2]}/${m[1]}` : `Jornada ${iso}`;
}

export default function ActivacionesDiaScreen() {
  const router = useRouter();
  const { localPermitido, hasPermiso } = useAuth();
  const { isPhone, isTablet } = useBreakpoint();
  const puedeVer = puedeVerActivacionesPlanning(hasPermiso);

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [localSel, setLocalSel] = useState<string>(LOCAL_TODOS);
  const [sesiones, setSesiones] = useState<ActivacionSesionDia[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sesionModal, setSesionModal] = useState<ActivacionSesionDia | null>(null);
  const [fichaAbierta, setFichaAbierta] = useState(false);

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

  useEffect(() => {
    if (!isTablet) return;
    setSesionModal((actual) => {
      const fresca = actual ? sesiones.find((s) => s.id_sesion === actual.id_sesion) : undefined;
      return fresca ?? agrupado[0]?.sesiones[0] ?? null;
    });
  }, [isTablet, sesiones, agrupado]);

  const resumen = useMemo(() => {
    let programadas = 0;
    let realizadas = 0;
    let canceladas = 0;
    for (const s of sesiones) {
      if (s.estado_sesion === 'programada') programadas += 1;
      else if (s.estado_sesion === 'realizada') realizadas += 1;
      else if (s.estado_sesion === 'cancelada') canceladas += 1;
    }
    return { programadas, realizadas, canceladas };
  }, [sesiones]);

  const proxima = useMemo(() => {
    const ahora = new Date();
    const ahoraClave = claveMinutoJornada(
      `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`,
    );
    if (ahoraClave == null) return null;
    let mejor: ActivacionSesionDia | null = null;
    let mejorClave = Number.POSITIVE_INFINITY;
    for (const s of sesiones) {
      if (s.estado_sesion !== 'programada') continue;
      const clave = claveMinutoJornada(String(s.hora_inicio ?? ''));
      if (clave == null || clave < ahoraClave || clave >= mejorClave) continue;
      mejor = s;
      mejorClave = clave;
    }
    return mejor;
  }, [sesiones]);

  const cajasResumen = (
    <View style={[styles.resumen, isTablet && styles.resumenEnFila]}>
      <View style={styles.resumenCajas}>
        {([
          ['programada', resumen.programadas],
          ['realizada', resumen.realizadas],
          ['cancelada', resumen.canceladas],
        ] as const).map(([estado, total]) => {
          const meta = ESTADO_SESION_META[estado];
          const etiqueta = estado === 'programada' ? 'Programadas' : estado === 'realizada' ? 'Realizadas' : 'Canceladas';
          return (
            <View key={estado} style={[styles.resumenCaja, { backgroundColor: meta.bg }]}>
              <Text style={[styles.resumenNumero, { color: meta.text }]}>{total}</Text>
              <Text style={[styles.resumenEtiqueta, { color: meta.text }]} numberOfLines={1}>{etiqueta}</Text>
            </View>
          );
        })}
      </View>
      {proxima ? (
        <Text style={styles.proxima} numberOfLines={1}>
          Próxima: {proxima.hora_inicio} · {String(proxima.local_nombre || proxima.id_local || 'Local').trim()}
        </Text>
      ) : null}
    </View>
  );

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
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} accessibilityLabel="Volver">
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.tituloWrap}>
          <Text style={styles.title} numberOfLines={1}>{tituloJornada(jornada)}</Text>
        </View>
        <TouchableOpacity onPress={cargar} style={styles.iconBtn} disabled={loading} accessibilityLabel="Recargar">
          {loading ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <MaterialIcons name="refresh" size={22} color={colors.accent} />
          )}
        </TouchableOpacity>
      </View>

      {localesPermitidos.length > 0 ? (
        <View style={isTablet ? styles.filaTablet : undefined}>
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
            style={isTablet ? styles.selectorTablet : styles.selector}
          />
          {cajasResumen}
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBanner}>
          <MaterialIcons name="error-outline" size={16} color={statusColors.danger.text} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={cargar} style={styles.retryBtn} accessibilityLabel="Reintentar">
            <Text style={styles.retry}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={isTablet ? styles.filaDetalle : styles.listaCol}>
      <View style={styles.listaCol}>
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
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: SPACING.xl, gap: SPACING.lg }}>
          {agrupado.map((grupo) => (
            <View key={grupo.idKey} style={styles.seccion}>
              <View style={styles.seccionHeader}>
                <Text style={styles.seccionTitulo} numberOfLines={1}>{grupo.nombreLocal}</Text>
                <Text style={styles.seccionCount}>{grupo.sesiones.length}</Text>
              </View>
              {grupo.sesiones.map((s) => {
                const sm = ESTADO_SESION_META[s.estado_sesion] ?? ESTADO_SESION_META.programada;
                const cancelada = s.estado_sesion === 'cancelada';
                const detalle = [s.tipo_activacion, s.duracion_horas ? `${s.duracion_horas} h` : '']
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <Pressable
                    key={s.id_sesion}
                    style={({ pressed }) => [
                      styles.card,
                      { borderLeftColor: sm.text },
                      cancelada && styles.cardCancelada,
                      isTablet && sesionModal?.id_sesion === s.id_sesion && styles.cardSel,
                      pressed && styles.cardPressed,
                    ]}
                    onPress={() => {
                      setSesionModal(s);
                      if (!isTablet) setFichaAbierta(true);
                    }}
                  >
                    <View style={styles.horaCol}>
                      <Text style={styles.horaInicio}>{s.hora_inicio || '—'}</Text>
                      <Text style={styles.horaFin}>
                        {s.hora_fin || '—'}
                        {sesionCruzaMedianoche(s) ? ' 🌙' : ''}
                      </Text>
                    </View>
                    <View style={styles.cardCentro}>
                      <Text
                        style={[styles.cardTitle, cancelada && styles.cardTitleTachado]}
                        numberOfLines={2}
                      >
                        {s.marca} · {s.producto}
                      </Text>
                      {detalle ? <Text style={styles.cardMeta} numberOfLines={1}>{detalle}</Text> : null}
                    </View>
                    <View style={styles.cardDerecha}>
                      <View style={[styles.badge, { backgroundColor: sm.bg }]}>
                        <Text style={[styles.badgeText, { color: sm.text }]}>{sm.label}</Text>
                      </View>
                      <MaterialIcons name="chevron-right" size={22} color={colors.textMuted} />
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </ScrollView>
      )}
      </View>
      {isTablet ? (
        <View style={styles.panelCol}>
          {sesionModal ? (
            <ActivacionFichaModalDia
              modo="panel"
              sesion={sesionModal}
              visible
              onClose={() => {}}
              onSesionActualizada={cargar}
            />
          ) : (
            <View style={styles.centerBox}>
              <Text style={styles.emptyText}>Selecciona una activación</Text>
            </View>
          )}
        </View>
      ) : null}
      </View>

      {!isTablet ? (
        <ActivacionFichaModalDia
          modo={isPhone ? 'hoja' : 'ventana'}
          sesion={sesionModal}
          visible={fichaAbierta && sesionModal != null}
          onClose={() => {
            setFichaAbierta(false);
            setSesionModal(null);
          }}
          onSesionActualizada={cargar}
        />
      ) : null}
        </>
      )}
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, padding: SPACING.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.md, gap: SPACING.sm },
  iconBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  tituloWrap: { flex: 1, minWidth: 0 },
  title: { fontSize: fontSizes[20], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  filaTablet: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md, marginBottom: SPACING.md },
  selector: { marginBottom: SPACING.md },
  selectorTablet: { flex: 1, minWidth: 0 },
  resumen: { minWidth: 0, gap: SPACING.sm },
  resumenEnFila: { flex: 1 },
  resumenCajas: { flexDirection: 'row', gap: SPACING.sm },
  resumenCaja: {
    flex: 1,
    minWidth: 0,
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resumenNumero: { fontSize: fontSizes[20], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  resumenEtiqueta: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  proxima: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: statusColors.danger.bg,
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: RADIO_MEDIO,
    padding: SPACING.sm,
    marginBottom: SPACING.md,
    minHeight: MIN_TOUCH,
  },
  errorText: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: statusColors.danger.text },
  retryBtn: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  retry: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.accent },
  filaDetalle: { flex: 1, flexDirection: 'row', gap: SPACING.md, minHeight: 0 },
  listaCol: { flexGrow: 45, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 0 },
  panelCol: {
    flexGrow: 55,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 0,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  seccion: { gap: SPACING.sm },
  seccionHeader: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  seccionTitulo: { flex: 1, minWidth: 0, fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  seccionCount: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    gap: SPACING.md,
    minHeight: 76,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: SPACING.sm,
    paddingRight: SPACING.sm,
    paddingLeft: SPACING.md,
  },
  cardCancelada: { opacity: 0.55 },
  cardSel: { borderColor: colors.accent, backgroundColor: '#f0f9ff' },
  cardPressed: { backgroundColor: colors.bg },
  horaCol: { flexShrink: 0, alignItems: 'flex-start' },
  horaInicio: { fontSize: fontSizes[20], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, fontVariant: ['tabular-nums'] },
  horaFin: { fontSize: fontSizes[13], fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  cardCentro: { flex: 1, minWidth: 0, gap: 2 },
  cardDerecha: { flexShrink: 0, alignItems: 'flex-end', gap: SPACING.xs },
  badge: { borderRadius: radius.md, paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs },
  badgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  cardTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  cardTitleTachado: { textDecorationLine: 'line-through' },
  cardMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  emptyBox: { alignItems: 'center', gap: SPACING.sm, paddingVertical: 40 },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center' },
});
