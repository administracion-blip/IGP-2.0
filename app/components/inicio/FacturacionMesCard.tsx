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
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { MIN_TOUCH, SPACING } from '../../constants/layout';
import { tasksUi } from '../../constants/tasksUiTokens';
import { useLocalesPermitidos, valorEnLocal, type LocalItem } from '../../contexts/LocalesContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { formatId6 } from '../../utils/idFormat';
import {
  FiltroFacturacionMes,
  etiquetaFiltroFacturacion,
  type LocalFiltroMes,
  type ValorFiltroFacturacionMes,
} from './FiltroFacturacionMes';

const FRANJA = ['#0ea5e9', '#ec4899'] as const;
const AZUL = '#0ea5e9';
const AZUL_HOY = '#0369a1';
const ROSA = '#ec4899';
const MARCAS_EJE = new Set([1, 8, 15, 22, 29]);
const SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] as const;
const CAJA_HOY = { fondo: '#f8fafc', texto: '#0f172a', icono: '#475569' } as const;
const CAJA_MES = { fondo: '#e0f2fe', texto: '#0369a1', icono: '#0369a1' } as const;
const CAJA_PROYECCION = { fondo: '#fdf2f8', texto: '#9d174d', icono: '#9d174d' } as const;
const ETIQUETA_CAJA = '#475569';
const ALTO_GRAFICO = 120;
const MARGEN_SUP = 8;
const MARGEN_INF = 4;
const BASE_Y = ALTO_GRAFICO - MARGEN_INF;
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

function euros(valor: number | null | undefined): string {
  if (valor == null || !Number.isFinite(valor)) return '—';
  return valor.toLocaleString('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function textoPorcentaje(pct: number): string {
  return `${pct.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

function textoChip(diferencia: number, pct: number | null): string {
  if (!Number.isFinite(diferencia)) return '—';
  const flecha = diferencia > 0 ? '▲' : diferencia < 0 ? '▼' : '';
  const importe = euros(Math.abs(diferencia));
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

function yDe(valor: number, maximo: number): number {
  const usable = Math.max(1, ALTO_GRAFICO - MARGEN_SUP - MARGEN_INF);
  const t = maximo > 0 ? Math.min(Math.max(valor, 0), maximo) / maximo : 0;
  return MARGEN_SUP + (1 - t) * usable;
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
};

function diaDelMes(iso: string): number {
  const n = Number(iso.slice(8, 10));
  return Number.isFinite(n) ? n : 0;
}

function coord(valor: number): string {
  return (Math.round(valor * 10) / 10).toString();
}

function barrasDe(
  dias: DiaFacturacionMes[],
  ultimo: string | null,
  ancho: number,
  maximo: number,
): BarraDia[] {
  if (ancho <= 0 || dias.length === 0) return [];
  const paso = ancho / dias.length;
  const grosor = Math.max(2, Math.min(7, paso * 0.42));
  return dias.map((dia, indice) => {
    const futuro = !ultimo || dia.fecha > ultimo;
    const hoy = ultimo != null && dia.fecha === ultimo;
    const y = futuro ? BASE_Y - 8 : Math.min(yDe(dia.real, maximo), BASE_Y - 2);
    return {
      indice,
      x: paso * indice + (paso - grosor) / 2,
      ancho: grosor,
      y,
      alto: Math.max(2, BASE_Y - y),
      futuro,
      hoy,
    };
  });
}

function lineaObjetivo(dias: DiaFacturacionMes[], ancho: number, maximo: number): string {
  if (ancho <= 0 || dias.length === 0) return '';
  const paso = ancho / dias.length;
  return dias
    .map((dia, indice) => {
      const x = paso * (indice + 0.5);
      const y = yDe(dia.objetivo, maximo);
      return `${indice === 0 ? 'M' : 'L'} ${coord(x)} ${coord(y)}`;
    })
    .join(' ');
}

function fechaTooltip(iso: string): string {
  const coincidencia = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!coincidencia) return iso;
  const fecha = new Date(Number(coincidencia[1]), Number(coincidencia[2]) - 1, Number(coincidencia[3]));
  const semana = SEMANA[fecha.getDay()] ?? '';
  const mes = MESES_CORTOS[Number(coincidencia[2]) - 1] ?? '';
  return `${semana} ${Number(coincidencia[3])} ${mes}`;
}

function pctDia(real: number, objetivo: number): number | null {
  if (!(objetivo > 0) || !Number.isFinite(real)) return null;
  return Math.round(((real - objetivo) / objetivo) * 1000) / 10;
}

function textoTooltip(dia: DiaFacturacionMes, ultimo: string | null): string {
  const futuro = !ultimo || dia.fecha > ultimo;
  const partes = [fechaTooltip(dia.fecha), futuro ? '—' : euros(dia.real), `Obj. ${euros(dia.objetivo)}`];
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
  return euros(valor);
}

const GraficoDiario = memo(function GraficoDiario({
  dias,
  ultimoDiaConDatos,
}: {
  dias: DiaFacturacionMes[];
  ultimoDiaConDatos: string | null;
}) {
  const raizRef = useRef<View>(null);
  const [ancho, setAncho] = useState(0);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const maximo = useMemo(() => maximoDe(dias), [dias]);
  const barras = useMemo(
    () => barrasDe(dias, ultimoDiaConDatos, ancho, maximo),
    [ancho, dias, ultimoDiaConDatos, maximo],
  );
  const objetivo = useMemo(() => lineaObjetivo(dias, ancho, maximo), [ancho, dias, maximo]);
  const diaSel = dias.find((dia) => dia.fecha === seleccion) ?? null;
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
        style={styles.plot}
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
            height={ALTO_GRAFICO}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          >
            {barras.map((barra) => {
              const fecha = dias[barra.indice]?.fecha;
              const activa = seleccion != null && fecha === seleccion;
              const opacidad = barra.futuro ? (activa ? 0.55 : 0.2) : seleccion && !activa ? 0.28 : 1;
              return (
                <Rect
                  key={`barra-${barra.indice}`}
                  x={barra.x}
                  y={barra.y}
                  width={barra.ancho}
                  height={barra.alto}
                  rx={barra.ancho / 2}
                  fill={barra.hoy ? AZUL_HOY : AZUL}
                  fillOpacity={opacidad}
                />
              );
            })}
            {objetivo ? (
              <Path
                d={objetivo}
                stroke="#94a3b8"
                strokeWidth={1.5}
                strokeDasharray="3 4"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            {barras
              .filter((barra) => barra.hoy)
              .map((barra) => (
                <Circle
                  key={`hoy-${barra.indice}`}
                  cx={barra.x + barra.ancho / 2}
                  cy={barra.y}
                  r={3.5}
                  fill={ROSA}
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
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cerrar el detalle del día"
        hitSlop={{ top: 8, bottom: 14 }}
        onPress={() => setSeleccion(null)}
        style={styles.eje}
      >
        {dias.map((dia, indice) => {
          const numero = diaDelMes(dia.fecha);
          if (!MARCAS_EJE.has(numero)) return null;
          return (
            <Text
              key={dia.fecha}
              style={[styles.ejeMarca, { left: `${((indice + 0.5) / dias.length) * 100}%` }]}
            >
              {numero}
            </Text>
          );
        })}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cerrar el detalle del día"
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

      {diaSel ? (
        <View style={styles.tooltip} accessibilityLiveRegion="polite">
          <Text style={styles.tooltipTexto}>{textoTooltip(diaSel, ultimoDiaConDatos)}</Text>
        </View>
      ) : null}
    </View>
  );
});

function CajaCifra({
  etiqueta,
  valor,
  accesible,
  enFila,
  entrada,
  icono,
  fondo,
  colorValor,
  colorIcono,
  crecimiento,
  tono,
}: {
  etiqueta: string;
  valor: string;
  accesible: string;
  enFila: boolean;
  entrada: StyleProp<ViewStyle>;
  icono: keyof typeof MaterialIcons.glyphMap;
  fondo: string;
  colorValor: string;
  colorIcono: string;
  crecimiento?: string | null;
  tono?: 'ok' | 'mal' | 'neutro';
}) {
  const tonoCaja = tono ?? 'neutro';
  return (
    <Animated.View
      style={[styles.caja, { backgroundColor: fondo }, enFila && styles.cajaEnFila, entrada]}
      accessibilityLabel={crecimiento ? `${accesible}: ${valor}. Crecimiento ${crecimiento}` : `${accesible}: ${valor}`}
    >
      <View style={styles.cajaEtiquetaFila}>
        <MaterialIcons name={icono} size={16} color={colorIcono} />
        <Text style={styles.cajaEtiqueta} numberOfLines={1}>
          {etiqueta}
        </Text>
      </View>
      <View style={styles.cajaValorFila}>
        <Text
          style={[styles.cajaValor, { color: colorValor }, tasksUi.tabularNums]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
        >
          {valor}
        </Text>
        {crecimiento ? (
          <View
            style={[
              styles.chip,
              styles.chipCaja,
              tonoCaja === 'ok' ? styles.chipOk : tonoCaja === 'mal' ? styles.chipMal : styles.chipNeutro,
            ]}
          >
            <Text
              style={[
                styles.chipTexto,
                styles.chipTextoCaja,
                tonoCaja === 'ok' ? styles.chipTextoOk : tonoCaja === 'mal' ? styles.chipTextoMal : styles.chipTextoNeutro,
              ]}
            >
              {crecimiento}
            </Text>
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

function Esqueleto() {
  return (
    <View style={styles.bloque} accessibilityLabel="Cargando facturación del mes" accessibilityRole="progressbar">
      <View style={[styles.hueso, styles.huesoTotal]} />
      <View style={[styles.hueso, styles.huesoPista]} />
      <View style={styles.cajas}>
        <View style={[styles.hueso, styles.huesoCaja]} />
        <View style={[styles.hueso, styles.huesoCaja]} />
        <View style={[styles.hueso, styles.huesoCaja]} />
      </View>
      <View style={[styles.hueso, styles.huesoGrafico]} />
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
  const permitidos = useMemo(() => localesDelFiltro(locales), [locales]);
  const [valor, setValor] = useState<ValorFiltroFacturacionMes | null>(null);
  const [abierto, setAbierto] = useState(false);
  const usuarioAplico = useRef(false);
  const onCambioRef = useRef(onCambioFiltro);
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

  const etiqueta = !valor
    ? 'Cargando…'
    : etiquetaFiltroFacturacion({
        year: valor.year,
        month: valor.month,
        localIds: valor.localIds,
        locales: permitidos,
        movil: isPhone,
      });

  const abrirFiltro = () => {
    if (!valor) return;
    setAbierto(true);
  };
  const listo = estado === 'listo' && datos != null && datos.dias.length > 0;
  const vacio = estado === 'vacio' || (estado === 'listo' && !listo);
  const hayObjetivo = listo && datos != null && datos.objetivoMes > 0;
  const logro = hayObjetivo && datos != null ? clamp01(datos.totalReal / datos.objetivoMes) : 0;
  const ritmo = hayObjetivo && datos != null ? clamp01(datos.objetivoAHoy / datos.objetivoMes) : 0;
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
    <View style={[styles.tarjeta, style]}>
      <LinearGradient
        colors={FRANJA}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.franja}
      />
      <View style={styles.cuerpo}>
        <View style={styles.cabecera}>
          <View style={styles.tituloFila}>
            <Text style={styles.kicker}>Facturación</Text>
            {listo && datos ? (
              <Text style={styles.pie} numberOfLines={1}>
                {datos.ultimoDiaConDatos
                  ? `Cajas hasta ${fechaVisible(datos.ultimoDiaConDatos)}`
                  : 'Sin cajas en este mes'}
              </Text>
            ) : null}
          </View>
          <View style={styles.ancla}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Filtro de facturación: ${etiqueta}`}
              accessibilityHint={permitidos.length === 1 ? 'Abre el mes' : 'Abre el mes y los locales'}
              accessibilityState={{ disabled: !valor }}
              disabled={!valor}
              onPress={abrirFiltro}
              style={({ pressed }) => [styles.pastilla, pressed && styles.pulsado, !valor && styles.inhabilitado]}
            >
              <Text style={styles.pastillaTexto} numberOfLines={1}>
                {etiqueta}
              </Text>
              <MaterialIcons name="expand-more" size={18} color={tasksUi.color.textoSecundario} />
            </Pressable>
          </View>
        </View>

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
            <View style={[styles.hero, isPhone && styles.heroPhone]}>
              <Text
                style={styles.total}
                accessibilityLabel={`Facturación del mes ${euros(datos.totalReal)}`}
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
                  {textoChip(datos.diferenciaRitmo, pctRitmo)}
                </Text>
              </View>
            </View>

            <View style={styles.barraBloque}>
              <View
                style={styles.pistaCaja}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: Math.round(logro * 100) }}
                accessibilityLabel={
                  hayObjetivo
                    ? `Facturado ${euros(datos.totalReal)}, ${mesPct == null ? '' : textoPorcentaje(mesPct)} del mes. Hoy ${hoyPct == null ? '' : textoPorcentaje(hoyPct)}. Objetivo del mes ${euros(datos.objetivoMes)}.`
                    : 'Sin objetivo del mes'
                }
              >
                {hayObjetivo && hoyPct != null ? (
                  <View
                    pointerEvents="none"
                    style={[
                      styles.hoyAncla,
                      ritmo < 0.14
                        ? styles.hoyAnclaIzq
                        : ritmo > 0.86
                          ? styles.hoyAnclaDer
                          : { left: `${ritmo * 100}%` },
                    ]}
                  >
                    <Text style={styles.hoyTexto}>{`Hoy ${textoPorcentaje(hoyPct)}`}</Text>
                  </View>
                ) : null}
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
              <View style={styles.barraPie}>
                <Text style={styles.barraPieTexto}>
                  {mesPct == null ? '— del mes' : `${textoPorcentaje(mesPct)} del mes`}
                </Text>
                <Text style={styles.barraPieTexto}>Obj. mes {euros(datos.objetivoMes)}</Text>
              </View>
            </View>

            <View style={[styles.cajas, isPhone && styles.cajasPhone]}>
              <CajaCifra
                etiqueta="Objetivo a hoy"
                accesible="Objetivo a hoy"
                valor={euros(datos.objetivoAHoy)}
                enFila={isPhone}
                entrada={entradasCaja[0]}
                icono="today"
                fondo={CAJA_HOY.fondo}
                colorValor={CAJA_HOY.texto}
                colorIcono={CAJA_HOY.icono}
              />
              <CajaCifra
                etiqueta="Objetivo del mes"
                accesible="Objetivo del mes"
                valor={euros(datos.objetivoMes)}
                enFila={isPhone}
                entrada={entradasCaja[1]}
                icono="calendar-month"
                fondo={CAJA_MES.fondo}
                colorValor={CAJA_MES.texto}
                colorIcono={CAJA_MES.icono}
              />
              <CajaCifra
                etiqueta="Proyección"
                accesible="Proyección a fin de mes"
                valor={euros(datos.proyeccionFinMes)}
                enFila={isPhone}
                entrada={entradasCaja[2]}
                icono="trending-up"
                fondo={CAJA_PROYECCION.fondo}
                colorValor={CAJA_PROYECCION.texto}
                colorIcono={CAJA_PROYECCION.icono}
                crecimiento={textoPct}
                tono={tono}
              />
            </View>

            <GraficoDiario dias={datos.dias} ultimoDiaConDatos={datos.ultimoDiaConDatos} />
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
    ? ({ boxShadow: '0 4px 16px rgba(15, 23, 42, 0.06)' } as ViewStyle)
    : {
        shadowColor: '#0f172a',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.06,
        shadowRadius: 16,
        elevation: 3,
      };

const styles = StyleSheet.create({
  tarjeta: {
    width: '100%',
    alignSelf: 'stretch',
    backgroundColor: tasksUi.color.superficie,
    borderRadius: tasksUi.radius.contenedor,
    overflow: 'hidden',
    ...sombraTarjeta,
  },
  franja: {
    height: 4,
  },
  cuerpo: {
    padding: SPACING.xl,
    gap: SPACING.md,
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
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.md,
    borderRadius: tasksUi.radius.pildora,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeFuerte,
    backgroundColor: tasksUi.color.superficie,
  },
  pastillaTexto: {
    ...tasksUi.tipo.dato,
    flexShrink: 1,
    color: tasksUi.color.textoPrimario,
  },
  pulsado: {
    opacity: 0.72,
  },
  inhabilitado: {
    opacity: 0.4,
  },
  bloque: {
    gap: SPACING.md,
  },
  hero: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: SPACING.md,
  },
  heroPhone: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  total: {
    fontSize: 36,
    fontWeight: '700',
    lineHeight: 42,
    color: tasksUi.color.textoPrimario,
    ...tasksUi.tabularNums,
    flexShrink: 1,
    minWidth: 0,
  },
  chip: {
    borderRadius: tasksUi.radius.pildora,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    alignSelf: 'flex-start',
  },
  chipCaja: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
  },
  chipOk: { backgroundColor: tasksUi.color.exitoSuave },
  chipMal: { backgroundColor: tasksUi.color.peligroSuave },
  chipNeutro: { backgroundColor: tasksUi.color.superficieHundida },
  chipTexto: {
    ...tasksUi.tipo.dato,
    ...tasksUi.tabularNums,
  },
  chipTextoOk: { color: tasksUi.color.exito },
  chipTextoMal: { color: tasksUi.color.peligro },
  chipTextoNeutro: { color: tasksUi.color.textoSecundario },
  chipTextoCaja: {
    ...tasksUi.tipo.micro,
  },
  barraBloque: {
    gap: SPACING.xs,
  },
  pistaCaja: {
    position: 'relative',
    height: 32,
    justifyContent: 'flex-end',
  },
  hoyAncla: {
    position: 'absolute',
    top: 0,
    width: 96,
    marginLeft: -48,
    alignItems: 'center',
  },
  hoyAnclaIzq: {
    left: 0,
    marginLeft: 0,
    alignItems: 'flex-start',
  },
  hoyAnclaDer: {
    right: 0,
    marginLeft: 0,
    alignItems: 'flex-end',
  },
  hoyTexto: {
    ...tasksUi.tipo.micro,
    color: tasksUi.color.textoPrimario,
    fontWeight: '600',
  },
  pista: {
    height: 10,
    borderRadius: tasksUi.radius.pildora,
    backgroundColor: tasksUi.color.superficieHundida,
    overflow: 'hidden',
  },
  relleno: {
    height: '100%',
    borderRadius: tasksUi.radius.pildora,
  },
  marca: {
    position: 'absolute',
    width: 2,
    height: 16,
    marginLeft: -1,
    bottom: -3,
    borderRadius: 1,
    backgroundColor: tasksUi.color.textoPrimario,
  },
  barraPie: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  barraPieTexto: {
    ...tasksUi.tipo.micro,
    ...tasksUi.tabularNums,
    flexShrink: 1,
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
    color: ETIQUETA_CAJA,
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
  },
  plot: {
    height: ALTO_GRAFICO,
    minHeight: MIN_TOUCH,
    position: 'relative',
    overflow: 'hidden',
  },
  base: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: MARGEN_INF,
    height: StyleSheet.hairlineWidth,
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
  ejeMarca: {
    position: 'absolute',
    top: 0,
    ...tasksUi.tipo.micro,
    color: tasksUi.color.textoTerciario,
    transform: [{ translateX: '-50%' }],
  },
  tooltip: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    backgroundColor: '#0f172a',
    borderRadius: tasksUi.radius.control,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  tooltipTexto: {
    ...tasksUi.tipo.micro,
    color: '#ffffff',
  },
  leyenda: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    minHeight: MIN_TOUCH,
  },
  muestraReal: {
    width: 12,
    height: 3,
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
    backgroundColor: tasksUi.color.textoTerciario,
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
    height: 8,
    width: '100%',
    borderRadius: tasksUi.radius.pildora,
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
