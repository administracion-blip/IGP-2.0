import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Path } from 'react-native-svg';
import { MIN_TOUCH, SPACING } from '../../constants/layout';
import { tasksUi } from '../../constants/tasksUiTokens';
import { useLocalesPermitidos, valorEnLocal, type LocalItem } from '../../contexts/LocalesContext';
import { useAgrupacionesObjetivos } from '../../hooks/useAgrupacionesObjetivos';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { formatId6 } from '../../utils/idFormat';
import {
  FiltroFacturacionMes,
  etiquetaFiltroFacturacion,
  type LocalFiltroMes,
  type ValorFiltroFacturacionMes,
} from './FiltroFacturacionMes';

const FRANJA = ['#0ea5e9', '#ec4899'] as const;
const TINTES = ['#f0f9ff', '#ffffff'] as const;
const ANCHO_OCULTA_SUBTITULO = 960;
const AZUL = '#0ea5e9';
const AZUL_HOY = '#0369a1';
const ROSA = '#ec4899';
const MARCAS_EJE = new Set([1, 8, 15, 22, 29]);
const SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] as const;
const ALTO_GRAFICO = 130;
const ALTO_GRAFICO_MOVIL = 100;
const AZUL_CLARO = '#e0f2fe';
const PUNTO_HOY = 8;
const RADIO_BARRA = 4;
const ALTO_BARRA_MIN = 3;
const FLECHA = 8;
const DURACION_TOOLTIP = 150;
const DURACION_ENTRADA = 800;

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;

export type DiaFacturacionMes = {
  fecha: string;
  real: number;
  objetivo: number;
};

export type FacturacionMesDatos = {
  dias: DiaFacturacionMes[];
  ultimoDiaConDatos: string | null;
  totalReal: number;
  objetivoAHoy: number;
  objetivoMes: number;
  consecucionPct: number | null;
  proyeccionFinMes: number | null;
  diferenciaRitmo: number;
};

export type EstadoFacturacionMes = 'cargando' | 'vacio' | 'error' | 'listo';

type Props = {
  estado: EstadoFacturacionMes;
  datos?: FacturacionMesDatos | null;
  /** Ids pedidos desde fuera. Solo se conservan los que el usuario tiene asignados. */
  localIdsSolicitados?: string[];
  onCambioFiltro?: (valor: ValorFiltroFacturacionMes) => void;
  onReintentar?: () => void;
  style?: StyleProp<ViewStyle>;
};

function esSedeGrupoParipe(local: LocalItem): boolean {
  return String(valorEnLocal(local, 'sede') ?? '').toUpperCase().includes('PARIPE');
}

function localesDelFiltro(locales: LocalItem[]): LocalFiltroMes[] {
  const vistos = new Set<string>();
  const salida: LocalFiltroMes[] = [];
  for (const local of locales) {
    if (!esSedeGrupoParipe(local)) continue;
    const nombre = String(valorEnLocal(local, 'nombre') ?? '').trim();
    const id = formatId6(valorEnLocal(local, 'id_Locales'));
    if (!nombre || id === '000000' || vistos.has(id)) continue;
    vistos.add(id);
    salida.push({ id, nombre });
  }
  salida.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
  return salida;
}

function mismosIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, indice) => id === b[indice]);
}

function idsPermitidos(solicitados: string[] | undefined, permitidos: LocalFiltroMes[]): string[] {
  const validos = new Set(permitidos.map((local) => local.id));
  const pedidos = (solicitados ?? [])
    .map((id) => formatId6(id))
    .filter((id) => id !== '000000' && validos.has(id));
  return pedidos.length > 0 ? pedidos : permitidos.map((local) => local.id);
}

function fechaVisible(iso: string): string {
  const coincidencia = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!coincidencia) return iso;
  const mes = MESES_CORTOS[Number(coincidencia[2]) - 1];
  if (!mes) return iso;
  return `${Number(coincidencia[3])} ${mes} ${coincidencia[1]}`;
}

const formatoEuro0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });

function formatEuro0(valor: number | null | undefined): string {
  if (valor == null || !Number.isFinite(valor)) return '—';
  return `${formatoEuro0.format(valor)} €`;
}

function textoPorcentaje(pct: number): string {
  return `${pct.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

function textoChip(diferencia: number, pct: number | null): string {
  if (!Number.isFinite(diferencia)) return '—';
  const flecha = diferencia > 0 ? '▲' : diferencia < 0 ? '▼' : '';
  const importe = formatEuro0(Math.abs(diferencia));
  const base = flecha ? `${flecha} ${importe}` : importe;
  if (pct == null) return base;
  return `${base} · ${textoCrecimiento(pct)}`;
}

/** Crecimiento del facturado respecto al objetivo a hoy. La proyección usa el mismo ritmo. */
function crecimientoPct(datos: FacturacionMesDatos): number | null {
  if (!(datos.objetivoAHoy > 0) || !Number.isFinite(datos.totalReal)) return null;
  return Math.round(((datos.totalReal - datos.objetivoAHoy) / datos.objetivoAHoy) * 1000) / 10;
}

function textoCrecimiento(pct: number): string {
  const cuerpo = pct.toLocaleString('es-ES', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  });
  return `${cuerpo} %`;
}

function etiquetaRitmo(datos: FacturacionMesDatos): string {
  const sentido =
    datos.diferenciaRitmo > 0
      ? 'Por encima del ritmo'
      : datos.diferenciaRitmo < 0
        ? 'Por debajo del ritmo'
        : 'Al ritmo';
  return `${sentido}. ${textoChip(datos.diferenciaRitmo, crecimientoPct(datos))}`;
}

function clamp01(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  return Math.min(1, Math.max(0, valor));
}

function techoDe(dias: DiaFacturacionMes[]): number {
  return maximoDe(dias) * 1.15;
}

function yDe(valor: number, techo: number, alto: number): number {
  const v = Number.isFinite(valor) ? Math.max(0, valor) : 0;
  const t = techo > 0 ? Math.min(v, techo) / techo : 0;
  return alto * (1 - t);
}

function anchoBarraDe(ancho: number, dias: number): number {
  if (ancho <= 0 || dias <= 0) return 0;
  return Math.max(6, Math.min(18, (ancho / dias) * 0.55));
}

function maximoDe(dias: DiaFacturacionMes[]): number {
  let maximo = 0;
  for (const dia of dias) {
    if (Number.isFinite(dia.real) && dia.real > maximo) maximo = dia.real;
    if (Number.isFinite(dia.objetivo) && dia.objetivo > maximo) maximo = dia.objetivo;
  }
  return maximo > 0 ? maximo : 1;
}

type BarraDia = {
  indice: number;
  x: number;
  ancho: number;
  y: number;
  alto: number;
  futuro: boolean;
  hoy: boolean;
  baja: boolean;
  visible: boolean;
};

function diaDelMes(iso: string): number {
  const n = Number(iso.slice(8, 10));
  return Number.isFinite(n) ? n : 0;
}

function coord(valor: number): string {
  return (Math.round(valor * 10) / 10).toString();
}

function trazoBarra(x: number, y: number, ancho: number, alto: number): string {
  const radio = Math.min(RADIO_BARRA, ancho / 2, Math.max(0, alto));
  const base = y + alto;
  const derecha = x + ancho;
  if (radio <= 0) {
    return `M ${coord(x)} ${coord(base)} H ${coord(derecha)} V ${coord(y)} H ${coord(x)} Z`;
  }
  return [
    `M ${coord(x)} ${coord(base)}`,
    `V ${coord(y + radio)}`,
    `A ${coord(radio)} ${coord(radio)} 0 0 1 ${coord(x + radio)} ${coord(y)}`,
    `H ${coord(derecha - radio)}`,
    `A ${coord(radio)} ${coord(radio)} 0 0 1 ${coord(derecha)} ${coord(y + radio)}`,
    `V ${coord(base)}`,
    'Z',
  ].join(' ');
}

function barrasDe(
  dias: DiaFacturacionMes[],
  ultimo: string | null,
  ancho: number,
  techo: number,
  alto: number,
): BarraDia[] {
  if (ancho <= 0 || dias.length === 0 || alto <= 0) return [];
  const paso = ancho / dias.length;
  const grosor = anchoBarraDe(ancho, dias.length);
  return dias.map((dia, indice) => {
    const futuro = !ultimo || dia.fecha > ultimo;
    const hoy = ultimo != null && dia.fecha === ultimo;
    const tieneObjetivo = Number.isFinite(dia.objetivo) && dia.objetivo > 0;
    const natural = futuro
      ? tieneObjetivo
        ? alto - yDe(dia.objetivo, techo, alto)
        : 0
      : alto - yDe(dia.real, techo, alto);
    const baja = !futuro && natural < ALTO_BARRA_MIN;
    const altura = futuro ? natural : Math.max(ALTO_BARRA_MIN, natural);
    return {
      indice,
      x: paso * indice + (paso - grosor) / 2,
      ancho: grosor,
      y: alto - altura,
      alto: altura,
      futuro,
      hoy,
      baja,
      visible: futuro ? tieneObjetivo : true,
    };
  });
}

function lineaObjetivo(dias: DiaFacturacionMes[], ancho: number, techo: number, alto: number): string {
  if (ancho <= 0 || dias.length === 0) return '';
  const paso = ancho / dias.length;
  const grosor = anchoBarraDe(ancho, dias.length);
  return dias
    .map((dia, indice) => {
      const x = paso * indice + (paso - grosor) / 2 + grosor / 2;
      const y = yDe(dia.objetivo, techo, alto);
      return `${indice === 0 ? 'M' : 'L'} ${coord(x)} ${coord(y)}`;
    })
    .join(' ');
}

function diaSemanaCorto(iso: string): string {
  const coincidencia = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!coincidencia) return '';
  const fecha = new Date(Number(coincidencia[1]), Number(coincidencia[2]) - 1, Number(coincidencia[3]));
  return SEMANA[fecha.getDay()] ?? '';
}

function fechaTooltip(iso: string): string {
  const coincidencia = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!coincidencia) return iso;
  const mes = MESES_CORTOS[Number(coincidencia[2]) - 1] ?? '';
  return `${diaSemanaCorto(iso)} ${Number(coincidencia[3])} ${mes}`;
}

function pctDia(real: number, objetivo: number): number | null {
  if (!(objetivo > 0) || !Number.isFinite(real)) return null;
  return Math.round(((real - objetivo) / objetivo) * 1000) / 10;
}

function textoTooltip(dia: DiaFacturacionMes, ultimo: string | null): string {
  const futuro = !ultimo || dia.fecha > ultimo;
  const partes = [fechaTooltip(dia.fecha), futuro ? '—' : formatEuro0(dia.real), `Obj. ${formatEuro0(dia.objetivo)}`];
  if (!futuro) {
    const pct = pctDia(dia.real, dia.objetivo);
    if (pct != null) partes.push(textoCrecimiento(pct));
  }
  return partes.join(' · ');
}

function useReducirMovimiento(): boolean | null {
  const [reducir, setReducir] = useState<boolean | null>(null);
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

function useProgresoEntrada(firma: string, activo: boolean, reducir: boolean | null) {
  const progreso = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!activo || reducir == null) return undefined;
    if (reducir) {
      progreso.setValue(1);
      return undefined;
    }
    progreso.setValue(0);
    const anim = Animated.timing(progreso, {
      toValue: 1,
      duration: DURACION_ENTRADA,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    const respaldo = setTimeout(() => progreso.setValue(1), DURACION_ENTRADA + 40);
    return () => {
      anim.stop();
      clearTimeout(respaldo);
    };
  }, [activo, reducir, firma, progreso]);
  return progreso;
}

function entradaCaja(progreso: Animated.Value, indice: number) {
  const desde = indice * 0.15;
  const hasta = Math.min(1, desde + 0.4);
  return {
    opacity: progreso.interpolate({
      inputRange: [desde, hasta],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    }),
    transform: [
      {
        translateY: progreso.interpolate({
          inputRange: [desde, hasta],
          outputRange: [10, 0],
          extrapolate: 'clamp',
        }),
      },
    ],
  };
}

function eurosContador(valor: number): string {
  if (!Number.isFinite(valor)) return '—';
  return formatEuro0(valor);
}

const sombraTooltip: ViewStyle =
  Platform.OS === 'web'
    ? ({ boxShadow: '0 8px 20px rgba(15, 23, 42, 0.22)' } as ViewStyle)
    : {
        shadowColor: '#0f172a',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.22,
        shadowRadius: 16,
        elevation: 8,
      };

function TooltipDia({
  dia,
  ultimo,
  centroX,
  altoBarra,
  anchoGrafico,
  reducir,
}: {
  dia: DiaFacturacionMes;
  ultimo: string | null;
  centroX: number;
  altoBarra: number;
  anchoGrafico: number;
  reducir: boolean | null;
}) {
  const [anchoTip, setAnchoTip] = useState(0);
  const opacidad = useRef(new Animated.Value(0)).current;
  const escala = useRef(new Animated.Value(0.95)).current;
  const futuro = !ultimo || dia.fecha > ultimo;
  const pct = futuro ? null : pctDia(dia.real, dia.objetivo);

  useEffect(() => {
    if (anchoTip <= 0) return undefined;
    if (reducir !== false) {
      opacidad.setValue(1);
      escala.setValue(1);
      return undefined;
    }
    opacidad.setValue(0);
    escala.setValue(0.95);
    const anim = Animated.parallel([
      Animated.timing(opacidad, {
        toValue: 1,
        duration: DURACION_TOOLTIP,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(escala, {
        toValue: 1,
        duration: DURACION_TOOLTIP,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);
    anim.start();
    return () => anim.stop();
  }, [anchoTip, dia.fecha, reducir, opacidad, escala]);

  const tope = Math.max(0, anchoGrafico - anchoTip);
  const left = anchoTip > 0 ? Math.min(Math.max(0, centroX - anchoTip / 2), tope) : 0;
  const flechaLeft = Math.min(Math.max(8, centroX - left - FLECHA / 2), Math.max(8, anchoTip - FLECHA - 8));

  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      onLayout={(evento) => {
        const siguiente = evento.nativeEvent.layout.width;
        setAnchoTip((previo) => (Math.abs(previo - siguiente) < 0.5 ? previo : siguiente));
      }}
      style={[
        styles.tooltip,
        sombraTooltip,
        {
          bottom: altoBarra + 10 + FLECHA,
          left,
          maxWidth: anchoGrafico > 0 ? anchoGrafico : undefined,
          opacity: anchoTip > 0 ? opacidad : 0,
          transform: [{ scale: escala }],
        },
      ]}
    >
      <Text style={styles.tooltipFecha}>{fechaTooltip(dia.fecha)}</Text>
      <Text style={styles.tooltipImporte}>{futuro ? '—' : formatEuro0(dia.real)}</Text>
      <Text style={styles.tooltipLineaObj}>
        {`Obj. ${formatEuro0(dia.objetivo)}`}
        {pct != null ? (
          <Text style={pct < 0 ? styles.tooltipMal : styles.tooltipOk}>{` · ${textoCrecimiento(pct)}`}</Text>
        ) : null}
      </Text>
      <View pointerEvents="none" style={[styles.flecha, { left: flechaLeft }]} />
    </Animated.View>
  );
}

const GraficoDiario = memo(function GraficoDiario({
  dias,
  ultimoDiaConDatos,
}: {
  dias: DiaFacturacionMes[];
  ultimoDiaConDatos: string | null;
}) {
  const { isPhone } = useBreakpoint();
  const alto = isPhone ? ALTO_GRAFICO_MOVIL : ALTO_GRAFICO;
  const raizRef = useRef<View>(null);
  const [ancho, setAncho] = useState(0);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const techo = useMemo(() => techoDe(dias), [dias]);
  const barras = useMemo(
    () => barrasDe(dias, ultimoDiaConDatos, ancho, techo, alto),
    [ancho, dias, ultimoDiaConDatos, techo, alto],
  );
  const objetivo = useMemo(
    () => lineaObjetivo(dias, ancho, techo, alto),
    [ancho, dias, techo, alto],
  );
  const diaSel = dias.find((dia) => dia.fecha === seleccion) ?? null;
  const barraSel = barras.find((barra) => dias[barra.indice]?.fecha === seleccion) ?? null;
  const reducir = useReducirMovimiento();
  const firma = `${dias[0]?.fecha ?? ''}:${dias[dias.length - 1]?.fecha ?? ''}:${ultimoDiaConDatos ?? ''}`;

  useEffect(() => {
    setSeleccion(null);
  }, [firma]);

  useEffect(() => {
    if (!seleccion || Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    const cerrar = (evento: Event) => {
      const nodo = raizRef.current as unknown as { contains?: (objetivo: Node) => boolean } | null;
      const destino = evento.target;
      if (!nodo || typeof nodo.contains !== 'function' || !(destino instanceof Node)) return;
      if (nodo.contains(destino)) return;
      setSeleccion(null);
    };
    document.addEventListener('pointerdown', cerrar);
    return () => document.removeEventListener('pointerdown', cerrar);
  }, [seleccion]);

  return (
    <View ref={raizRef} style={styles.graficoBloque}>
      <View
        style={[styles.plot, { height: alto, overflow: 'visible' }]}
        accessibilityLabel="Gráfico diario de facturación"
        onLayout={(evento) => {
          const siguiente = evento.nativeEvent.layout.width;
          setAncho((previo) => (Math.abs(previo - siguiente) < 0.5 ? previo : siguiente));
        }}
      >
        <View style={styles.base} pointerEvents="none" />
        {ancho > 0 ? (
          <Svg
            width={ancho}
            height={alto}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          >
            {barras.map((barra) => {
              if (!barra.visible || barra.alto <= 0) return null;
              const fecha = dias[barra.indice]?.fecha;
              const activa = seleccion != null && fecha === seleccion;
              const opacidad = seleccion && !activa ? 0.35 : 1;
              const fill = barra.hoy ? AZUL_HOY : barra.futuro ? AZUL_CLARO : AZUL;
              return (
                <Path
                  key={`barra-${barra.indice}`}
                  d={trazoBarra(barra.x, barra.y, barra.ancho, barra.alto)}
                  fill={fill}
                  fillOpacity={opacidad}
                />
              );
            })}
            {objetivo ? (
              <Path
                d={objetivo}
                stroke="#cbd5e1"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                fill="none"
                strokeLinecap="butt"
                strokeLinejoin="round"
              />
            ) : null}
            {barras
              .filter((barra) => barra.hoy)
              .map((barra) => (
                <Circle
                  key={`hoy-${barra.indice}`}
                  cx={barra.x + barra.ancho / 2}
                  cy={Math.max(PUNTO_HOY / 2, barra.y - PUNTO_HOY / 2)}
                  r={PUNTO_HOY / 2}
                  fill={ROSA}
                  fillOpacity={seleccion && dias[barra.indice]?.fecha !== seleccion ? 0.35 : 1}
                />
              ))}
          </Svg>
        ) : null}
        <View style={styles.hits}>
          {dias.map((dia) => {
            const activo = dia.fecha === seleccion;
            return (
              <Pressable
                key={dia.fecha}
                accessibilityRole="button"
                accessibilityState={{ selected: activo }}
                accessibilityLabel={textoTooltip(dia, ultimoDiaConDatos)}
                onPress={() => setSeleccion((previo) => (previo === dia.fecha ? null : dia.fecha))}
                style={styles.diaHit}
              />
            );
          })}
        </View>
        {diaSel && barraSel ? (
          <TooltipDia
            key={diaSel.fecha}
            dia={diaSel}
            ultimo={ultimoDiaConDatos}
            centroX={barraSel.x + barraSel.ancho / 2}
            altoBarra={barraSel.alto}
            anchoGrafico={ancho}
            reducir={reducir}
          />
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cerrar el detalle del día"
        hitSlop={{ top: 8, bottom: 14 }}
        onPress={() => setSeleccion(null)}
        style={[styles.eje, Platform.OS === 'web' && styles.ejeWeb]}
      >
        {dias.map((dia, indice) => {
          const enWeb = Platform.OS === 'web';
          const numero = diaDelMes(dia.fecha);
          if (!enWeb && !MARCAS_EJE.has(numero)) return null;
          if (enWeb) {
            return (
              <View
                key={dia.fecha}
                style={[
                  styles.ejeCelda,
                  {
                    left: `${(indice / dias.length) * 100}%`,
                    width: `${100 / dias.length}%`,
                  },
                ]}
              >
                <Text style={styles.ejeNumero} numberOfLines={1}>
                  {numero}
                </Text>
                <Text style={styles.ejeSemana} numberOfLines={1}>
                  {diaSemanaCorto(dia.fecha)}
                </Text>
              </View>
            );
          }
          return (
            <Text
              key={dia.fecha}
              numberOfLines={1}
              style={[
                styles.ejeMarca,
                {
                  left: `${((indice + 0.5) / dias.length) * 100}%`,
                  width: 28,
                  marginLeft: -14,
                },
              ]}
            >
              {numero}
            </Text>
          );
        })}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cerrar el detalle del día"
        hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
        onPress={() => setSeleccion(null)}
        style={styles.leyenda}
      >
        <View style={styles.muestraReal} />
        <Text style={styles.leyendaTexto}>Real</Text>
        <View style={styles.muestraGuiones}>
          <View style={styles.guion} />
          <View style={styles.guion} />
          <View style={styles.guion} />
        </View>
        <Text style={styles.leyendaTexto}>Objetivo</Text>
      </Pressable>
    </View>
  );
});

function DatoCabecera({
  etiqueta,
  valor,
  color,
  entrada,
}: {
  etiqueta: string;
  valor: string;
  color: string;
  entrada: StyleProp<ViewStyle>;
}) {
  return (
    <Animated.View style={[styles.dato, entrada]} accessibilityLabel={`${etiqueta}: ${valor}`}>
      <Text style={styles.datoEtiqueta} numberOfLines={1}>
        {etiqueta}
      </Text>
      <Text style={[styles.datoValor, { color }, tasksUi.tabularNums]} numberOfLines={1}>
        {valor}
      </Text>
    </Animated.View>
  );
}

function DatosCabecera({
  datos,
  entradas,
  textoPct,
  compacto = false,
}: {
  datos: FacturacionMesDatos;
  entradas: StyleProp<ViewStyle>[];
  textoPct: string | null;
  compacto?: boolean;
}) {
  const sep = compacto ? styles.separadorCorto : styles.separador;
  return (
    <>
      <DatoCabecera
        etiqueta="Obj. a hoy"
        valor={formatEuro0(datos.objetivoAHoy)}
        color="#0f172a"
        entrada={entradas[0]}
      />
      <View style={sep} />
      <DatoCabecera
        etiqueta="Obj. mes"
        valor={formatEuro0(datos.objetivoMes)}
        color="#0369a1"
        entrada={entradas[1]}
      />
      <View style={sep} />
      <DatoCabecera
        etiqueta={textoPct ? `Proyección · ${textoPct}` : 'Proyección'}
        valor={formatEuro0(datos.proyeccionFinMes)}
        color="#be185d"
        entrada={entradas[2]}
      />
    </>
  );
}

function PastillaFiltro({
  etiqueta,
  deshabilitada,
  onPress,
  estilo,
}: {
  etiqueta: string;
  deshabilitada: boolean;
  onPress: () => void;
  estilo?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Filtro de facturación: ${etiqueta}`}
      accessibilityHint="Abre el mes y los locales"
      accessibilityState={{ disabled: deshabilitada }}
      disabled={deshabilitada}
      onPress={onPress}
      style={({ pressed }) => [styles.pastilla, estilo, pressed && styles.pulsado, deshabilitada && styles.inhabilitado]}
    >
      <Text style={styles.pastillaTexto} numberOfLines={1}>
        {etiqueta}
      </Text>
      <MaterialIcons name="expand-more" size={18} color="#0f172a" />
    </Pressable>
  );
}

function Esqueleto() {
  const { isPhone } = useBreakpoint();
  const alto = isPhone ? ALTO_GRAFICO_MOVIL : ALTO_GRAFICO;
  return (
    <View style={styles.bloque} accessibilityLabel="Cargando facturación del mes" accessibilityRole="progressbar">
      <View style={[styles.hueso, styles.huesoTotal]} />
      <View style={[styles.hueso, styles.huesoPista]} />
      <View style={[styles.hueso, styles.huesoGrafico, { height: alto }]} />
    </View>
  );
}

export function FacturacionMesCard({
  estado,
  datos = null,
  localIdsSolicitados,
  onCambioFiltro,
  onReintentar,
  style,
}: Props) {
  const { isPhone } = useBreakpoint();
  const { locales, loading: cargandoLocales, error: errorLocales, refresh } = useLocalesPermitidos();
  const { agrupaciones } = useAgrupacionesObjetivos();
  const permitidos = useMemo(() => localesDelFiltro(locales), [locales]);
  const [valor, setValor] = useState<ValorFiltroFacturacionMes | null>(null);
  const [abierto, setAbierto] = useState(false);
  const usuarioAplico = useRef(false);
  const onCambioRef = useRef(onCambioFiltro);
  const filaRef = useRef<View>(null);
  const [anchoTarjeta, setAnchoTarjeta] = useState(0);
  const [anchoPie, setAnchoPie] = useState(0);
  const [nivelExtra, setNivelExtra] = useState(0);
  onCambioRef.current = onCambioFiltro;

  useEffect(() => {
    if (cargandoLocales) return;
    const ahora = new Date();
    setValor((previo) => {
      if (previo && usuarioAplico.current) {
        const validos = new Set(permitidos.map((local) => local.id));
        const filtrados = previo.localIds.filter((id) => validos.has(id));
        const siguiente = filtrados.length > 0 ? filtrados : permitidos.map((local) => local.id);
        if (mismosIds(previo.localIds, siguiente)) return previo;
        return { ...previo, localIds: siguiente };
      }
      const year = previo?.year ?? ahora.getFullYear();
      const month = previo?.month ?? ahora.getMonth() + 1;
      const localIds = idsPermitidos(localIdsSolicitados, permitidos);
      if (previo && previo.year === year && previo.month === month && mismosIds(previo.localIds, localIds)) {
        return previo;
      }
      return { year, month, localIds };
    });
  }, [cargandoLocales, permitidos, localIdsSolicitados]);

  useEffect(() => {
    if (valor) onCambioRef.current?.(valor);
  }, [valor]);

  const etiquetaLarga = !valor
    ? 'Cargando…'
    : etiquetaFiltroFacturacion({
        year: valor.year,
        month: valor.month,
        localIds: valor.localIds,
        locales: permitidos,
        movil: false,
        agrupaciones,
      });
  const etiquetaCorta = !valor
    ? 'Cargando…'
    : etiquetaFiltroFacturacion({
        year: valor.year,
        month: valor.month,
        localIds: valor.localIds,
        locales: permitidos,
        movil: true,
        agrupaciones,
      });

  const abrirFiltro = () => {
    if (!valor) return;
    setAbierto(true);
  };
  const listo = estado === 'listo' && datos != null && datos.dias.length > 0;
  const piso = isPhone || anchoTarjeta <= 0 ? 0 : anchoTarjeta < 760 ? 3 : anchoTarjeta < 880 ? 2 : anchoTarjeta < ANCHO_OCULTA_SUBTITULO ? 1 : 0;
  const nivel = Math.min(3, piso + nivelExtra);
  const etiqueta = isPhone || nivel >= 2 ? etiquetaCorta : etiquetaLarga;

  useEffect(() => {
    setNivelExtra(0);
  }, [anchoTarjeta, etiquetaLarga, isPhone]);

  useEffect(() => {
    if (isPhone || Platform.OS !== 'web' || !listo) return undefined;
    const marco = requestAnimationFrame(() => {
      const nodo = filaRef.current as unknown as { scrollWidth?: number; clientWidth?: number } | null;
      if (!nodo?.clientWidth) return;
      if ((nodo.scrollWidth ?? 0) > nodo.clientWidth + 4 && piso + nivelExtra < 3) {
        setNivelExtra((actual) => actual + 1);
      }
    });
    return () => cancelAnimationFrame(marco);
  }, [anchoTarjeta, nivelExtra, piso, isPhone, listo, etiquetaLarga]);
  const vacio = estado === 'vacio' || (estado === 'listo' && !listo);
  const hayObjetivo = listo && datos != null && datos.objetivoMes > 0;
  const logro = hayObjetivo && datos != null ? clamp01(datos.totalReal / datos.objetivoMes) : 0;
  const ritmo = hayObjetivo && datos != null ? clamp01(datos.objetivoAHoy / datos.objetivoMes) : 0;
  // «Hoy» va bajo la marca, pero no puede tapar «% del mes» (a la izquierda).
  const ANCHO_PIE_MES = 92;
  const ANCHO_HOY = 96;
  const centroHoy = ritmo * anchoPie;
  const hoyPegadoIzq = anchoPie <= 0 || centroHoy < ANCHO_PIE_MES + ANCHO_HOY / 2;
  const hoyPegadoDer = !hoyPegadoIzq && centroHoy > anchoPie - ANCHO_HOY / 2;
  const hoyPct =
    hayObjetivo && datos != null ? Math.round((datos.objetivoAHoy / datos.objetivoMes) * 1000) / 10 : null;
  const mesPct =
    hayObjetivo && datos != null ? Math.round((datos.totalReal / datos.objetivoMes) * 1000) / 10 : null;
  const diferencia = listo && datos != null ? datos.diferenciaRitmo : 0;
  const tono = diferencia > 0 ? 'ok' : diferencia < 0 ? 'mal' : 'neutro';
  const pctRitmo = listo && datos ? crecimientoPct(datos) : null;
  const textoPct = pctRitmo == null ? null : textoCrecimiento(pctRitmo);
  const firmaEntrada =
    listo && datos
      ? `${datos.totalReal}:${datos.objetivoAHoy}:${datos.objetivoMes}:${datos.ultimoDiaConDatos ?? ''}:${datos.dias.length}`
      : '';
  const reducirMovimiento = useReducirMovimiento();
  const progresoEntrada = useProgresoEntrada(firmaEntrada, listo, reducirMovimiento);
  const escalaBarra = useMemo(
    () => progresoEntrada.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
    [progresoEntrada],
  );
  const entradasCaja = useMemo(
    () => [0, 1, 2].map((indice) => entradaCaja(progresoEntrada, indice)),
    [progresoEntrada],
  );
  const [firmaCuenta, setFirmaCuenta] = useState(firmaEntrada);
  const [totalAnimado, setTotalAnimado] = useState(0);
  let totalVisible = totalAnimado;
  if (firmaCuenta !== firmaEntrada) {
    const siguiente = listo && datos && reducirMovimiento ? datos.totalReal : 0;
    setFirmaCuenta(firmaEntrada);
    setTotalAnimado(siguiente);
    totalVisible = siguiente;
  }
  const totalReal = listo && datos ? datos.totalReal : 0;
  const diferenciaVisible =
    listo && datos && totalReal > 0 ? datos.diferenciaRitmo * (totalVisible / totalReal) : 0;
  const subtitulo =
    listo && datos
      ? datos.ultimoDiaConDatos
        ? `Cajas hasta ${fechaVisible(datos.ultimoDiaConDatos)}`
        : 'Sin cajas en este mes'
      : null;

  useEffect(() => {
    if (!listo || reducirMovimiento == null) return undefined;
    if (reducirMovimiento) {
      setTotalAnimado(totalReal);
      return undefined;
    }
    const animado = new Animated.Value(0);
    const id = animado.addListener(({ value }) => setTotalAnimado(value));
    const anim = Animated.timing(animado, {
      toValue: totalReal,
      duration: DURACION_ENTRADA,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    anim.start();
    return () => {
      anim.stop();
      animado.removeListener(id);
    };
  }, [listo, totalReal, reducirMovimiento, firmaEntrada]);

  return (
    <>
    <View
      style={[styles.tarjeta, style]}
      onLayout={(evento) => {
        const siguiente = evento.nativeEvent.layout.width;
        setAnchoTarjeta((previo) => (Math.abs(previo - siguiente) < 0.5 ? previo : siguiente));
      }}
    >
      <LinearGradient
        colors={TINTES}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.tinte}
        pointerEvents="none"
      />
      <View style={styles.cuerpo}>
        {isPhone || !listo ? (
          <View style={styles.filaTitulo}>
            <View style={styles.tituloBloque}>
              <Text style={styles.kicker}>Facturación</Text>
              {subtitulo && (isPhone || nivel < 1) ? (
                <Text style={styles.subtitulo} numberOfLines={1}>
                  {subtitulo}
                </Text>
              ) : null}
            </View>
            <PastillaFiltro
              etiqueta={etiqueta}
              deshabilitada={!valor}
              onPress={abrirFiltro}
              estilo={styles.pastillaEmpuja}
            />
          </View>
        ) : null}

        {estado === 'cargando' ? <Esqueleto /> : null}

        {estado === 'error' ? (
          <View style={styles.aviso}>
            <MaterialIcons name="error-outline" size={28} color={tasksUi.color.peligro} />
            <Text style={styles.avisoTexto}>No se ha podido cargar la facturación del mes.</Text>
            {onReintentar ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reintentar"
                onPress={onReintentar}
                style={({ pressed }) => [
                  styles.reintentar,
                  isPhone && styles.reintentarAncho,
                  pressed && styles.pulsado,
                ]}
              >
                <Text style={styles.reintentarTexto}>Reintentar</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {vacio ? (
          <View style={styles.aviso}>
            <MaterialIcons name="bar-chart" size={28} color={tasksUi.color.textoTerciario} />
            <Text style={styles.avisoTexto}>Sin facturación para este filtro.</Text>
          </View>
        ) : null}

        {listo && datos ? (
          <View style={styles.bloque}>
            {!isPhone ? (
              <View ref={filaRef} style={[styles.fila, nivel >= 3 && styles.filaSinMargen]}>
                <View style={styles.tituloBloque}>
                  <Text style={styles.kicker}>Facturación</Text>
                  {nivel < 1 && subtitulo ? (
                    <Text style={styles.subtitulo} numberOfLines={1}>
                      {subtitulo}
                    </Text>
                  ) : null}
                </View>
                <Text
                  style={styles.total}
                  accessibilityLabel={`Facturación del mes ${formatEuro0(datos.totalReal)}`}
                >
                  {eurosContador(totalVisible)}
                </Text>
                <View
                  style={[
                    styles.chip,
                    tono === 'ok' ? styles.chipOk : tono === 'mal' ? styles.chipMal : styles.chipNeutro,
                  ]}
                  accessibilityLabel={etiquetaRitmo(datos)}
                >
                  <Text
                    style={[
                      styles.chipTexto,
                      tono === 'ok' ? styles.chipTextoOk : tono === 'mal' ? styles.chipTextoMal : styles.chipTextoNeutro,
                    ]}
                  >
                    {textoChip(diferenciaVisible, pctRitmo)}
                  </Text>
                </View>
                {nivel < 3 ? (
                  <View style={styles.filaDatos}>
                    <DatosCabecera datos={datos} entradas={entradasCaja} textoPct={textoPct} />
                  </View>
                ) : null}
                <PastillaFiltro
                  etiqueta={etiqueta}
                  deshabilitada={!valor}
                  onPress={abrirFiltro}
                  estilo={styles.pastillaEmpuja}
                />
              </View>
            ) : (
              <View style={styles.heroPhone}>
                <Text
                  style={[styles.total, styles.totalMovil]}
                  accessibilityLabel={`Facturación del mes ${formatEuro0(datos.totalReal)}`}
                >
                  {eurosContador(totalVisible)}
                </Text>
                <View
                  style={[
                    styles.chip,
                    styles.chipMovil,
                    tono === 'ok' ? styles.chipOk : tono === 'mal' ? styles.chipMal : styles.chipNeutro,
                  ]}
                  accessibilityLabel={etiquetaRitmo(datos)}
                >
                  <Text
                    style={[
                      styles.chipTexto,
                      tono === 'ok' ? styles.chipTextoOk : tono === 'mal' ? styles.chipTextoMal : styles.chipTextoNeutro,
                    ]}
                  >
                    {textoChip(diferenciaVisible, pctRitmo)}
                  </Text>
                </View>
              </View>
            )}

            {!isPhone && nivel >= 3 ? (
              <View style={styles.filaDatosSegunda}>
                <DatosCabecera datos={datos} entradas={entradasCaja} textoPct={textoPct} />
              </View>
            ) : null}

            <View style={[styles.barraBloque, isPhone && styles.barraBloqueMovil]}>
              <View
                style={styles.pistaCaja}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: Math.round(logro * 100) }}
                accessibilityLabel={
                  hayObjetivo
                    ? `Facturado ${formatEuro0(datos.totalReal)}, ${mesPct == null ? '' : textoPorcentaje(mesPct)} del mes. Hoy ${hoyPct == null ? '' : textoPorcentaje(hoyPct)}.`
                    : 'Sin objetivo del mes'
                }
              >
                <View style={styles.pista}>
                  {logro > 0 ? (
                    <Animated.View
                      style={[
                        styles.relleno,
                        { width: `${logro * 100}%`, transform: [{ scaleX: escalaBarra }], transformOrigin: 'left center' },
                      ]}
                    >
                      <LinearGradient
                        colors={FRANJA}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={StyleSheet.absoluteFill}
                      />
                    </Animated.View>
                  ) : null}
                </View>
                {hayObjetivo ? <View style={[styles.marca, { left: `${ritmo * 100}%` }]} /> : null}
              </View>
              <View
                style={styles.barraPie}
                onLayout={(e) => {
                  const w = Math.round(e.nativeEvent.layout.width);
                  setAnchoPie((actual) => (actual === w ? actual : w));
                }}
              >
                <Text style={styles.barraPieTexto}>
                  {mesPct == null ? '— del mes' : `${textoPorcentaje(mesPct)} del mes`}
                </Text>
                {hayObjetivo && hoyPct != null ? (
                  <View
                    pointerEvents="none"
                    style={[
                      styles.hoyAncla,
                      hoyPegadoIzq
                        ? styles.hoyAnclaIzq
                        : hoyPegadoDer
                          ? styles.hoyAnclaDer
                          : { left: `${ritmo * 100}%` },
                    ]}
                  >
                    <Text style={styles.hoyTexto}>{`Hoy ${textoPorcentaje(hoyPct)}`}</Text>
                  </View>
                ) : null}
              </View>
            </View>

            {isPhone ? (
              <View style={styles.filaDatosMovil}>
                <DatosCabecera datos={datos} entradas={entradasCaja} textoPct={textoPct} compacto />
              </View>
            ) : null}

            <GraficoDiario dias={datos.dias} ultimoDiaConDatos={datos.ultimoDiaConDatos} />
            {!isPhone && nivel >= 1 && subtitulo ? (
              <Text style={styles.pieGrafico} numberOfLines={1}>
                {subtitulo}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
    {valor ? (
      <FiltroFacturacionMes
        visible={abierto}
        movil={isPhone}
        year={valor.year}
        month={valor.month}
        localIds={valor.localIds}
        locales={permitidos}
        agrupaciones={agrupaciones}
        errorLocales={errorLocales}
        onReintentarLocales={() => {
          void refresh();
        }}
        onCerrar={() => setAbierto(false)}
        onAplicar={(siguiente) => {
          usuarioAplico.current = true;
          setValor(siguiente);
          setAbierto(false);
        }}
      />
    ) : null}
    </>
  );
}

const sombraTarjeta: ViewStyle =
  Platform.OS === 'web'
    ? ({ boxShadow: '0 6px 24px rgba(15, 23, 42, 0.07)' } as ViewStyle)
    : {
        shadowColor: '#0f172a',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.07,
        shadowRadius: 24,
        elevation: 4,
      };

const styles = StyleSheet.create({
  tarjeta: {
    width: '100%',
    alignSelf: 'stretch',
    backgroundColor: tasksUi.color.superficie,
    borderRadius: 16,
    overflow: 'hidden',
    position: 'relative',
    ...sombraTarjeta,
  },
  tinte: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 40,
  },
  cuerpo: {
    paddingTop: 16,
    paddingBottom: 16,
    paddingHorizontal: 20,
  },
  cabecera: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  tituloFila: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    flexShrink: 1,
    minWidth: 0,
    gap: SPACING.sm,
  },
  kicker: {
    ...tasksUi.tipo.tituloSeccion,
    flexShrink: 0,
  },
  subtitulo: {
    fontSize: 12,
    lineHeight: 16,
    color: '#94a3b8',
  },
  tituloBloque: {
    flexShrink: 0,
  },
  filaTitulo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  fila: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    overflow: 'hidden',
    marginBottom: SPACING.md,
  },
  filaSinMargen: {
    marginBottom: 0,
  },
  filaDatos: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    marginLeft: SPACING.lg,
  },
  filaDatosSegunda: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.sm,
    marginBottom: SPACING.md,
  },
  filaDatosMovil: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.md,
    marginBottom: SPACING.lg,
  },
  separador: {
    width: 1,
    height: 32,
    marginHorizontal: SPACING.lg,
    backgroundColor: '#e2e8f0',
  },
  separadorCorto: {
    width: 1,
    height: 32,
    marginHorizontal: SPACING.sm,
    backgroundColor: '#e2e8f0',
  },
  dato: {
    flexShrink: 0,
  },
  datoEtiqueta: {
    fontSize: 11,
    lineHeight: 14,
    color: '#94a3b8',
  },
  datoValor: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  pieGrafico: {
    marginTop: SPACING.sm,
    fontSize: 12,
    lineHeight: 16,
    color: '#94a3b8',
  },
  ancla: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
  },
  pastilla: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    flexShrink: 0,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 14,
    borderRadius: tasksUi.radius.pildora,
    backgroundColor: '#f1f5f9',
  },
  pastillaEmpuja: {
    marginLeft: 'auto',
  },
  pastillaTexto: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: '#0f172a',
  },
  pulsado: {
    opacity: 0.72,
  },
  inhabilitado: {
    opacity: 0.4,
  },
  bloque: {
    gap: 0,
  },
  heroPhone: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    marginBottom: SPACING.sm,
  },
  total: {
    marginLeft: 24,
    fontSize: 26,
    fontWeight: '700',
    lineHeight: 32,
    color: '#0f172a',
    ...tasksUi.tabularNums,
    flexShrink: 0,
  },
  totalMovil: {
    marginLeft: 0,
    fontSize: 28,
    lineHeight: 34,
  },
  chip: {
    marginLeft: SPACING.sm,
    borderRadius: tasksUi.radius.pildora,
    paddingHorizontal: 10,
    paddingVertical: 4,
    flexShrink: 0,
  },
  chipMovil: {
    marginLeft: 0,
    marginTop: SPACING.xs,
  },
  chipOk: { backgroundColor: '#dcfce7' },
  chipMal: { backgroundColor: '#fee2e2' },
  chipNeutro: { backgroundColor: tasksUi.color.superficieHundida },
  chipTexto: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    ...tasksUi.tabularNums,
  },
  chipTextoOk: { color: '#15803d' },
  chipTextoMal: { color: '#b91c1c' },
  chipTextoNeutro: { color: tasksUi.color.textoSecundario },
  barraBloque: {
    marginBottom: SPACING.lg,
  },
  barraBloqueMovil: {
    marginBottom: 0,
  },
  pistaCaja: {
    position: 'relative',
    height: 12,
    justifyContent: 'center',
  },
  pista: {
    height: 6,
    borderRadius: tasksUi.radius.pildora,
    backgroundColor: '#e2e8f0',
    overflow: 'hidden',
  },
  relleno: {
    height: '100%',
    borderRadius: tasksUi.radius.pildora,
  },
  marca: {
    position: 'absolute',
    width: 2,
    height: 12,
    marginLeft: -1,
    top: 0,
    borderRadius: 1,
    backgroundColor: '#0f172a',
  },
  barraPie: {
    position: 'relative',
    minHeight: 16,
    marginTop: 2,
    justifyContent: 'center',
  },
  barraPieTexto: {
    fontSize: 11,
    lineHeight: 14,
    color: '#94a3b8',
    ...tasksUi.tabularNums,
  },
  hoyAncla: {
    position: 'absolute',
    top: 0,
    width: 96,
    marginLeft: -48,
    alignItems: 'center',
  },
  hoyAnclaIzq: {
    left: 92,
    marginLeft: 0,
    alignItems: 'flex-start',
  },
  hoyAnclaDer: {
    right: 0,
    marginLeft: 0,
    alignItems: 'flex-end',
  },
  hoyTexto: {
    fontSize: 11,
    lineHeight: 14,
    color: '#0f172a',
    fontWeight: '600',
    ...tasksUi.tabularNums,
  },
  cajas: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  cajasPhone: {
    flexDirection: 'column',
  },
  caja: {
    flex: 1,
    minWidth: 0,
    borderRadius: tasksUi.radius.control,
    padding: SPACING.sm,
    gap: SPACING.xs,
  },
  cajaEnFila: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  cajaEtiquetaFila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    minWidth: 0,
    flexShrink: 1,
  },
  cajaEtiqueta: {
    ...tasksUi.tipo.micro,
    color: tasksUi.color.textoTerciario,
    flexShrink: 1,
  },
  cajaValorFila: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACING.xs,
    minWidth: 0,
  },
  cajaValor: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
    flexShrink: 1,
  },
  graficoBloque: {
    gap: SPACING.sm,
    position: 'relative',
    overflow: 'visible',
    zIndex: 2,
  },
  plot: {
    minHeight: MIN_TOUCH,
    position: 'relative',
    overflow: 'visible',
  },
  base: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    backgroundColor: tasksUi.color.bordeSutil,
  },
  hits: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
  },
  diaHit: {
    flex: 1,
    minHeight: MIN_TOUCH,
  },
  eje: {
    height: 16,
    position: 'relative',
  },
  ejeWeb: {
    height: 28,
  },
  ejeCelda: {
    position: 'absolute',
    top: 0,
    alignItems: 'center',
  },
  ejeNumero: {
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '700',
    color: tasksUi.color.textoSecundario,
    textAlign: 'center',
  },
  ejeSemana: {
    ...tasksUi.tipo.micro,
    lineHeight: 13,
    textAlign: 'center',
  },
  ejeMarca: {
    position: 'absolute',
    top: 0,
    textAlign: 'center',
    ...tasksUi.tipo.micro,
    color: tasksUi.color.textoTerciario,
  },
  tooltip: {
    position: 'absolute',
    zIndex: 4,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  tooltipFecha: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
    color: '#94a3b8',
  },
  tooltipImporte: {
    marginTop: 2,
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '700',
    color: '#ffffff',
  },
  tooltipLineaObj: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 16,
    color: '#cbd5e1',
  },
  tooltipOk: {
    color: '#4ade80',
    fontWeight: '600',
  },
  tooltipMal: {
    color: '#f87171',
    fontWeight: '600',
  },
  flecha: {
    position: 'absolute',
    bottom: -FLECHA,
    width: 0,
    height: 0,
    borderLeftWidth: FLECHA / 2,
    borderRightWidth: FLECHA / 2,
    borderTopWidth: FLECHA,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#0f172a',
  },
  leyenda: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.xs,
  },
  muestraReal: {
    width: 8,
    height: 8,
    borderRadius: 2,
    backgroundColor: AZUL,
  },
  muestraGuiones: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginLeft: SPACING.sm,
  },
  guion: {
    width: 3,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#cbd5e1',
  },
  leyendaTexto: {
    ...tasksUi.tipo.micro,
  },
  pie: {
    ...tasksUi.tipo.micro,
    flexShrink: 1,
  },
  aviso: {
    alignItems: 'flex-start',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
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
    backgroundColor: tasksUi.color.superficie,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  reintentarAncho: {
    alignSelf: 'stretch',
  },
  reintentarTexto: {
    ...tasksUi.tipo.dato,
    color: tasksUi.color.textoPrimario,
  },
  hueso: {
    backgroundColor: tasksUi.color.bordeFuerte,
    borderRadius: tasksUi.radius.control,
  },
  huesoTotal: {
    height: 28,
    width: '46%',
  },
  huesoPista: {
    height: 6,
    width: '100%',
    borderRadius: tasksUi.radius.pildora,
    marginTop: SPACING.md,
    marginBottom: SPACING.lg,
  },
  huesoCaja: {
    flex: 1,
    height: 52,
  },
  huesoGrafico: {
    height: ALTO_GRAFICO,
    width: '100%',
  },
});
