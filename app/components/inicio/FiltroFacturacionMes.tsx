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

type Props = {
  visible: boolean;
  movil: boolean;
  year: number;
  month: number;
  localIds: string[];
  locales: LocalFiltroMes[];
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
}): string {
  const mes = MESES[opciones.month - 1] ?? '';
  const fecha = opciones.movil ? `${mes} ${String(opciones.year).slice(-2)}` : `${mes} ${opciones.year}`;
  return `${fecha} · ${etiquetaLocales(opciones)}`;
}

function etiquetaLocales(opciones: {
  localIds: string[];
  locales: LocalFiltroMes[];
  movil: boolean;
}): string {
  const { locales, localIds, movil } = opciones;
  if (locales.length === 1) return locales[0].nombre;
  const elegidos = locales.filter((local) => localIds.includes(local.id));
  if (elegidos.length === 1) return elegidos[0].nombre;
  const todos = locales.length > 0 && locales.every((local) => localIds.includes(local.id));
  if (todos) return movil ? 'Paripe' : 'Grupo Paripe';
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
  const altoCromo = SPACING.md * 2 + MIN_TOUCH + SPACING.sm + MIN_TOUCH * 3 + SPACING.sm + 22 + MIN_TOUCH + SPACING.sm;
  const altoLista = Math.max(96, Math.min(200, altoMax - altoCromo));

  const cambiarAnio = (delta: number) => {
    setDraftYear((previo) => {
      const siguiente = previo + delta;
      if (siguiente < ANIO_MIN || siguiente > anioTope) return previo;
      return siguiente;
    });
  };

  const alternar = (id: string) => {
    setDraftIds((previo) => (previo.includes(id) ? previo.filter((item) => item !== id) : [...previo, id]));
  };

  const restablecer = () => {
    const hoy = new Date();
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

      <View style={styles.meses}>
        {MESES.map((nombre, indice) => {
          const mes = indice + 1;
          const activo = mes === draftMonth;
          const bloqueado = mesFuturo(draftYear, mes);
          return (
            <View key={nombre} style={styles.mesCelda}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={MESES_LARGOS[indice]}
                accessibilityState={{ selected: activo, disabled: bloqueado }}
                disabled={bloqueado}
                onPress={() => setDraftMonth(mes)}
                style={({ pressed }) => [
                  styles.mesBoton,
                  activo && styles.mesActivo,
                  bloqueado && styles.inhabilitado,
                  pressed && !bloqueado && styles.pulsado,
                ]}
              >
                <Text style={[styles.mesTexto, activo && styles.mesTextoActivo]}>{nombre}</Text>
              </Pressable>
            </View>
          );
        })}
      </View>

      {unSoloLocal ? null : (
        <View style={styles.localesBloque}>
          <Text style={styles.rotulo}>Locales</Text>
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
    overflow: 'hidden',
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
  meses: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  mesCelda: {
    flexBasis: '25%',
    maxWidth: '25%',
    padding: 2,
  },
  mesBoton: {
    minHeight: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tasksUi.radius.control,
  },
  mesActivo: {
    backgroundColor: tasksUi.color.acentoSuave,
  },
  mesTexto: {
    ...tasksUi.tipo.dato,
    color: tasksUi.color.textoSecundario,
  },
  mesTextoActivo: {
    color: tasksUi.color.acentoTexto,
  },
  localesBloque: {
    gap: SPACING.xs,
    flexShrink: 1,
    minHeight: 0,
  },
  rotulo: {
    ...tasksUi.tipo.etiqueta,
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
