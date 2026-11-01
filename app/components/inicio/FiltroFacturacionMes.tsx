import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH, SPACING } from '../../constants/layout';
import { tasksUi } from '../../constants/tasksUiTokens';
import { formatId6 } from '../../utils/idFormat';

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'] as const;
const MESES_LARGOS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;
const ANIO_MIN = 2000;

export type LocalFiltroMes = {
  id: string;
  nombre: string;
};

export type ValorFiltroFacturacionMes = {
  year: number;
  month: number;
  localIds: string[];
};

/** Agrupación de Objetivos: solo se ofrecen los locales que este filtro ya enseña. */
export type AgrupacionFiltroMes = {
  id: string;
  nombre: string;
  localIds: string[];
  color: string;
};

type Props = {
  visible: boolean;
  movil: boolean;
  year: number;
  month: number;
  localIds: string[];
  locales: LocalFiltroMes[];
  agrupaciones?: AgrupacionFiltroMes[];
  errorLocales?: string | null;
  onReintentarLocales?: () => void;
  onCerrar: () => void;
  onAplicar: (valor: ValorFiltroFacturacionMes) => void;
};

export function etiquetaFiltroFacturacion(opciones: {
  year: number;
  month: number;
  localIds: string[];
  locales: LocalFiltroMes[];
  movil: boolean;
  agrupaciones?: AgrupacionFiltroMes[];
}): string {
  const mes = MESES[opciones.month - 1] ?? '';
  const fecha = opciones.movil ? `${mes} ${String(opciones.year).slice(-2)}` : `${mes} ${opciones.year}`;
  return `${fecha} · ${etiquetaLocales(opciones)}`;
}

/** Locales de la agrupación que están en la lista del filtro, con el mismo id de 6 dígitos. */
function idsDeAgrupacion(agrupacion: AgrupacionFiltroMes, locales: LocalFiltroMes[]): string[] {
  const validos = new Set(locales.map((local) => local.id));
  const salida: string[] = [];
  const vistos = new Set<string>();
  for (const bruto of agrupacion.localIds) {
    const id = formatId6(bruto);
    if (id === '000000' || !validos.has(id) || vistos.has(id)) continue;
    vistos.add(id);
    salida.push(id);
  }
  return salida;
}

function mismosIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function nombreMes(mes: number): string {
  const nombre = MESES_LARGOS[mes - 1] ?? '';
  return nombre ? nombre.charAt(0).toUpperCase() + nombre.slice(1) : '';
}

function etiquetaLocales(opciones: {
  localIds: string[];
  locales: LocalFiltroMes[];
  movil: boolean;
  agrupaciones?: AgrupacionFiltroMes[];
}): string {
  const { locales, localIds, movil, agrupaciones } = opciones;
  if (locales.length === 1) return locales[0].nombre;
  const elegidos = locales.filter((local) => localIds.includes(local.id));
  const todos = locales.length > 0 && locales.every((local) => localIds.includes(local.id));
  if (todos) return movil ? 'Paripe' : 'Grupo Paripe';
  const grupo = agrupaciones?.find((agrupacion) => {
    const ids = idsDeAgrupacion(agrupacion, locales);
    return ids.length > 0 && mismosIds(ids, elegidos.map((local) => local.id));
  });
  if (grupo?.nombre.trim()) return grupo.nombre.trim();
  if (elegidos.length === 1) return elegidos[0].nombre;
  if (elegidos.length === 0) return 'Sin locales';
  return `${elegidos.length} locales`;
}

function mesFuturo(year: number, month: number, ahora = new Date()): boolean {
  const anio = ahora.getFullYear();
  const mes = ahora.getMonth() + 1;
  return year > anio || (year === anio && month > mes);
}

function useReducirMovimiento(): boolean {
  const [reducir, setReducir] = useState(false);
  useEffect(() => {
    let vivo = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((valor) => {
        if (vivo) setReducir(!!valor);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (valor) => {
      setReducir(!!valor);
    });
    return () => {
      vivo = false;
      sub.remove();
    };
  }, []);
  return reducir;
}

export function FiltroFacturacionMes({
  visible,
  movil,
  year,
  month,
  localIds,
  locales,
  agrupaciones = [],
  errorLocales = null,
  onReintentarLocales,
  onCerrar,
  onAplicar,
}: Props) {
  const { width: ventana, height: altoVentana } = useWindowDimensions();
  const reducir = useReducirMovimiento();
  const progreso = useRef(new Animated.Value(0)).current;
  const montadoRef = useRef(false);
  const [montado, setMontado] = useState(false);
  const [draftYear, setDraftYear] = useState(year);
  const [draftMonth, setDraftMonth] = useState(month);
  const [draftIds, setDraftIds] = useState<string[]>(localIds);
  const [mesAbierto, setMesAbierto] = useState(false);
  const fueVisible = useRef(false);
  const ahora = new Date();
  const anioTope = ahora.getFullYear();
  const unSoloLocal = locales.length === 1;
  const idsAplicables = unSoloLocal ? [locales[0].id] : draftIds;
  const sinEleccion = !unSoloLocal && locales.length > 0 && idsAplicables.length === 0;

  useEffect(() => {
    if (visible && !fueVisible.current) {
      const permitidos = new Set(locales.map((local) => local.id));
      setDraftYear(year);
      setDraftMonth(month);
      setDraftIds(localIds.filter((id) => permitidos.has(id)));
      setMesAbierto(false);
    }
    fueVisible.current = visible;
  }, [visible, year, month, localIds, locales]);

  useEffect(() => {
    if (!visible) return;
    montadoRef.current = true;
    setMontado(true);
  }, [visible]);

  useEffect(() => {
    if (!montado) return undefined;
    if (visible) {
      if (reducir) {
        progreso.setValue(1);
        return undefined;
      }
      progreso.setValue(0);
      const anim = Animated.timing(progreso, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      });
      anim.start();
      return () => anim.stop();
    }
    if (reducir) {
      montadoRef.current = false;
      setMontado(false);
      return undefined;
    }
    const anim = Animated.timing(progreso, {
      toValue: 0,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (!finished) return;
      montadoRef.current = false;
      setMontado(false);
    });
    return () => anim.stop();
  }, [visible, montado, reducir, progreso]);

  useEffect(() => {
    if (!mesFuturo(draftYear, draftMonth)) return;
    const hoy = new Date();
    setDraftMonth(draftYear === hoy.getFullYear() ? hoy.getMonth() + 1 : 12);
  }, [draftYear, draftMonth]);

  if (!montado) return null;

  const translateY = progreso.interpolate({
    inputRange: [0, 1],
    outputRange: [12, 0],
  });
  const margen = SPACING.lg;
  const anchoPanel = Math.max(0, Math.min(360, ventana - margen * 2));
  const altoMax = Math.max(320, altoVentana - margen * 2);
  const hayAgrupaciones = agrupaciones.some((agrupacion) => idsDeAgrupacion(agrupacion, locales).length > 0);
  const altoCromo =
    SPACING.md * 2 +
    MIN_TOUCH +
    SPACING.sm +
    MIN_TOUCH +
    SPACING.sm +
    MIN_TOUCH +
    (hayAgrupaciones ? MIN_TOUCH : 0) +
    MIN_TOUCH +
    SPACING.sm;
  const altoLista = Math.max(96, Math.min(200, altoMax - altoCromo));

  const cambiarAnio = (delta: number) => {
    const siguiente = draftYear + delta;
    if (siguiente < ANIO_MIN || siguiente > anioTope) return;
    setMesAbierto(false);
    setDraftYear(siguiente);
    if (mesFuturo(siguiente, draftMonth)) setDraftMonth(new Date().getMonth() + 1);
  };

  const alternar = (id: string) => {
    setMesAbierto(false);
    setDraftIds((previo) => (previo.includes(id) ? previo.filter((item) => item !== id) : [...previo, id]));
  };

  const limpiar = () => setDraftIds([]);

  const aplicarAgrupacion = (ids: string[]) => {
    setMesAbierto(false);
    setDraftIds(ids);
  };

  const restablecer = () => {
    const hoy = new Date();
    setMesAbierto(false);
    setDraftYear(hoy.getFullYear());
    setDraftMonth(hoy.getMonth() + 1);
    setDraftIds(locales.map((local) => local.id));
  };

  const aplicar = () => {
    if (sinEleccion || mesFuturo(draftYear, draftMonth)) return;
    onAplicar({ year: draftYear, month: draftMonth, localIds: idsAplicables });
  };

  const panel = (
    <Pressable
      pointerEvents="auto"
      onPress={(e) => e.stopPropagation()}
      style={[styles.panel, styles.desplegable, { width: anchoPanel, maxHeight: altoMax }]}
    >
      <View style={styles.anioFila}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Año anterior"
          disabled={draftYear <= ANIO_MIN}
          onPress={() => cambiarAnio(-1)}
          style={({ pressed }) => [styles.flecha, pressed && styles.pulsado, draftYear <= ANIO_MIN && styles.inhabilitado]}
        >
          <MaterialIcons name="chevron-left" size={22} color={tasksUi.color.textoPrimario} />
        </Pressable>
        <Text style={styles.anio} accessibilityLabel={`Año ${draftYear}`}>
          {draftYear}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Año siguiente"
          disabled={draftYear >= anioTope}
          onPress={() => cambiarAnio(1)}
          style={({ pressed }) => [styles.flecha, pressed && styles.pulsado, draftYear >= anioTope && styles.inhabilitado]}
        >
          <MaterialIcons name="chevron-right" size={22} color={tasksUi.color.textoPrimario} />
        </Pressable>
      </View>

      <View style={[styles.mesBloque, mesAbierto && styles.mesBloqueAbierta]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Mes ${nombreMes(draftMonth)}`}
          accessibilityState={{ expanded: mesAbierto }}
          onPress={(e) => {
            e.stopPropagation?.();
            setMesAbierto((abierto) => !abierto);
          }}
          style={({ pressed }) => [styles.mesTrigger, pressed && styles.pulsado]}
        >
          <Text style={styles.mesTriggerTexto}>{nombreMes(draftMonth)}</Text>
          <MaterialIcons name={mesAbierto ? 'expand-less' : 'expand-more'} size={22} color={tasksUi.color.textoPrimario} />
        </Pressable>
        {mesAbierto ? (
          <View style={styles.mesMenu}>
            <ScrollView style={styles.mesLista} nestedScrollEnabled keyboardShouldPersistTaps="handled">
              {MESES_LARGOS.map((nombre, indice) => {
                const mes = indice + 1;
                const activo = mes === draftMonth;
                const bloqueado = mesFuturo(draftYear, mes);
                return (
                  <Pressable
                    key={nombre}
                    accessibilityRole="button"
                    accessibilityLabel={nombre}
                    accessibilityState={{ selected: activo, disabled: bloqueado }}
                    disabled={bloqueado}
                    onPress={(e) => {
                      e.stopPropagation?.();
                      if (bloqueado) return;
                      setDraftMonth(mes);
                      setMesAbierto(false);
                    }}
                    style={({ pressed }) => [
                      styles.mesOpcion,
                      activo && styles.mesActivo,
                      bloqueado && styles.inhabilitado,
                      pressed && !bloqueado && styles.pulsado,
                    ]}
                  >
                    <Text style={[styles.mesTexto, activo && styles.mesTextoActivo]}>{nombreMes(mes)}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
      </View>

      {unSoloLocal ? null : (
        <View style={styles.localesBloque}>
          <View style={styles.rotuloFila}>
            <Text style={styles.rotulo}>Locales</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Limpiar selección de locales"
              disabled={draftIds.length === 0}
              onPress={(e) => {
                e.stopPropagation?.();
                limpiar();
              }}
              style={({ pressed }) => [styles.limpiar, draftIds.length === 0 && styles.inhabilitado, pressed && draftIds.length > 0 && styles.pulsado]}
            >
              <Text style={styles.limpiarTexto}>Limpiar</Text>
            </Pressable>
          </View>
          {hayAgrupaciones ? (
            <View style={styles.agrupaciones}>
              {agrupaciones.map((agrupacion) => {
                const ids = idsDeAgrupacion(agrupacion, locales);
                const activa = ids.length > 0 && mismosIds(ids, draftIds);
                const vacia = ids.length === 0;
                return (
                  <Pressable
                    key={agrupacion.id}
                    accessibilityRole="button"
                    accessibilityLabel={vacia ? `${agrupacion.nombre}, sin locales en este filtro` : agrupacion.nombre}
                    accessibilityState={{ selected: activa, disabled: vacia }}
                    disabled={vacia}
                    onPress={(e) => {
                      e.stopPropagation?.();
                      aplicarAgrupacion(ids);
                    }}
                    style={({ pressed }) => [
                      styles.agrupacion,
                      activa && { backgroundColor: agrupacion.color, borderColor: agrupacion.color },
                      vacia && styles.inhabilitado,
                      pressed && !vacia && styles.pulsado,
                    ]}
                  >
                    {activa ? null : <View style={[styles.agrupacionPunto, { backgroundColor: agrupacion.color }]} />}
                    <Text style={[styles.agrupacionTexto, activa && styles.agrupacionTextoActiva]} numberOfLines={1}>
                      {agrupacion.nombre}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {errorLocales ? (
            <View style={styles.aviso}>
              <Text style={styles.avisoTexto}>No se han podido cargar los locales.</Text>
              {onReintentarLocales ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Reintentar locales"
                  onPress={onReintentarLocales}
                  style={({ pressed }) => [styles.reintentar, pressed && styles.pulsado]}
                >
                  <Text style={styles.reintentarTexto}>Reintentar</Text>
                </Pressable>
              ) : null}
            </View>
          ) : locales.length === 0 ? (
            <Text style={styles.avisoTexto}>No tienes locales de Grupo Paripe.</Text>
          ) : (
            <ScrollView
              style={[styles.lista, { maxHeight: altoLista }]}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
            >
              {locales.map((local) => {
                const marcado = draftIds.includes(local.id);
                return (
                  <Pressable
                    key={local.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: marcado }}
                    accessibilityLabel={local.nombre}
                    onPress={() => alternar(local.id)}
                    style={({ pressed }) => [styles.local, pressed && styles.pulsado]}
                  >
                    <MaterialIcons
                      name={marcado ? 'check-box' : 'check-box-outline-blank'}
                      size={22}
                      color={marcado ? tasksUi.color.acento : tasksUi.color.textoTerciario}
                    />
                    <Text style={styles.localNombre} numberOfLines={1}>
                      {local.nombre}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
          {sinEleccion ? <Text style={styles.ayuda}>Elige al menos un local.</Text> : null}
        </View>
      )}

      <View style={styles.acciones}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Restablecer"
          onPress={restablecer}
          style={({ pressed }) => [styles.accion, styles.restablecer, pressed && styles.pulsado]}
        >
          <Text style={styles.restablecerTexto}>Restablecer</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Aplicar"
          disabled={sinEleccion}
          onPress={aplicar}
          style={({ pressed }) => [styles.accion, styles.aplicar, sinEleccion && styles.inhabilitado, pressed && !sinEleccion && styles.pulsado]}
        >
          <Text style={styles.aplicarTexto}>Aplicar</Text>
        </Pressable>
      </View>
    </Pressable>
  );

  return (
    <Modal visible={montado} transparent animationType="none" onRequestClose={onCerrar} statusBarTranslucent>
      <Pressable
        style={styles.marco}
        onPress={onCerrar}
        accessibilityViewIsModal
        accessibilityRole="button"
        accessibilityLabel="Cerrar filtro"
      >
        <Animated.View pointerEvents="none" style={[styles.velo, { opacity: progreso }]} />
        <View pointerEvents="box-none" style={styles.anclajeCentro}>
          <Animated.View pointerEvents="box-none" style={[styles.tarjetaAnim, { opacity: progreso, transform: [{ translateY }] }]}>
            {panel}
          </Animated.View>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  marco: {
    flex: 1,
  },
  velo: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: tasksUi.color.overlay,
  },
  anclajeCentro: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
    zIndex: 1,
  },
  tarjetaAnim: {
    maxWidth: '100%',
    maxHeight: '100%',
    alignItems: 'center',
  },
  panel: {
    backgroundColor: tasksUi.color.superficie,
    padding: SPACING.md,
    gap: SPACING.sm,
    overflow: 'visible',
  },
  desplegable: {
    borderRadius: tasksUi.radius.contenedor,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    ...tasksUi.sombraFlotante,
  },
  anioFila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  flecha: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tasksUi.radius.control,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeFuerte,
  },
  anio: {
    ...tasksUi.tipo.dato,
    ...tasksUi.tabularNums,
    flex: 1,
    textAlign: 'center',
    color: tasksUi.color.textoPrimario,
  },
  mesBloque: {
    position: 'relative',
    zIndex: 1,
  },
  mesBloqueAbierta: {
    zIndex: 2,
    elevation: 12,
  },
  mesTrigger: {
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    borderRadius: tasksUi.radius.control,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeFuerte,
    backgroundColor: tasksUi.color.superficie,
  },
  mesTriggerTexto: {
    ...tasksUi.tipo.dato,
    color: tasksUi.color.textoPrimario,
  },
  mesMenu: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: SPACING.xs,
    zIndex: 3,
    elevation: 13,
    backgroundColor: tasksUi.color.superficie,
    borderRadius: tasksUi.radius.control,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    ...tasksUi.sombraFlotante,
  },
  mesLista: {
    maxHeight: 220,
  },
  mesOpcion: {
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
  },
  mesActivo: {
    backgroundColor: tasksUi.color.acentoSuave,
  },
  mesTexto: {
    ...tasksUi.tipo.dato,
    color: tasksUi.color.textoPrimario,
  },
  mesTextoActivo: {
    color: tasksUi.color.acentoTexto,
  },
  localesBloque: {
    gap: SPACING.xs,
    flexShrink: 1,
    minHeight: 0,
    position: 'relative',
    zIndex: 0,
  },
  rotuloFila: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  rotulo: {
    ...tasksUi.tipo.etiqueta,
  },
  limpiar: {
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  limpiarTexto: {
    ...tasksUi.tipo.dato,
    color: tasksUi.color.acentoTexto,
  },
  agrupaciones: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
  },
  agrupacion: {
    minHeight: MIN_TOUCH,
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: tasksUi.radius.pildora,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeFuerte,
    backgroundColor: tasksUi.color.superficie,
  },
  agrupacionPunto: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  agrupacionTexto: {
    ...tasksUi.tipo.dato,
    flexShrink: 1,
    color: tasksUi.color.textoPrimario,
  },
  agrupacionTextoActiva: {
    color: '#ffffff',
  },
  lista: {
    flexGrow: 0,
  },
  local: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    minHeight: MIN_TOUCH,
  },
  localNombre: {
    ...tasksUi.tipo.dato,
    flex: 1,
    minWidth: 0,
    color: tasksUi.color.textoPrimario,
  },
  ayuda: {
    ...tasksUi.tipo.micro,
    color: tasksUi.color.peligro,
  },
  aviso: {
    gap: SPACING.sm,
  },
  avisoTexto: {
    ...tasksUi.tipo.cuerpo,
  },
  reintentar: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.lg,
    borderRadius: tasksUi.radius.control,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeFuerte,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  reintentarTexto: {
    ...tasksUi.tipo.dato,
    color: tasksUi.color.textoPrimario,
  },
  acciones: {
    flexDirection: 'row',
    flexShrink: 0,
    gap: SPACING.sm,
    paddingTop: SPACING.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tasksUi.color.bordeSutil,
  },
  accion: {
    flex: 1,
    minHeight: MIN_TOUCH,
    borderRadius: tasksUi.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  restablecer: {
    borderWidth: 1,
    borderColor: tasksUi.color.bordeFuerte,
    backgroundColor: tasksUi.color.superficie,
  },
  restablecerTexto: {
    ...tasksUi.tipo.dato,
    color: tasksUi.color.textoPrimario,
  },
  aplicar: {
    backgroundColor: tasksUi.color.acento,
  },
  aplicarTexto: {
    ...tasksUi.tipo.dato,
    color: tasksUi.color.textoInverso,
  },
  pulsado: {
    opacity: 0.72,
  },
  inhabilitado: {
    opacity: 0.4,
  },
});
