import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { MIN_TOUCH, SPACING } from '../../constants/layout';
import { tasksUi } from '../../constants/tasksUiTokens';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { formatMoneda } from '../../utils/formatMoneda';

const FRANJA = ['#0ea5e9', '#ec4899'] as const;
const AZUL = '#0ea5e9';
const RELLENO = 'rgba(14, 165, 233, 0.16)';
const ALTO_GRAFICO = 120;
const MARGEN_SUP = 8;
const MARGEN_INF = 4;

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
  etiquetaFiltro: string;
  onAbrirFiltro: () => void;
  onReintentar?: () => void;
  style?: StyleProp<ViewStyle>;
};

type Punto = { x: number; y: number; indice: number };
type Trazo = { clave: string; left: number; top: number; ancho: number; grados: number };

function fechaVisible(iso: string): string {
  const coincidencia = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!coincidencia) return iso;
  const mes = MESES_CORTOS[Number(coincidencia[2]) - 1];
  if (!mes) return iso;
  return `${Number(coincidencia[3])} ${mes} ${coincidencia[1]}`;
}

function euros(valor: number | null | undefined): string {
  if (valor == null || !Number.isFinite(valor)) return '—';
  return formatMoneda(valor);
}

function textoRitmo(diferencia: number): string {
  if (!Number.isFinite(diferencia)) return '—';
  if (diferencia > 0) return `+${formatMoneda(diferencia)}`;
  return formatMoneda(diferencia);
}

function etiquetaRitmo(datos: FacturacionMesDatos): string {
  const sentido =
    datos.diferenciaRitmo > 0
      ? 'Por encima del ritmo'
      : datos.diferenciaRitmo < 0
        ? 'Por debajo del ritmo'
        : 'Al ritmo';
  const pct =
    datos.consecucionPct == null || !Number.isFinite(datos.consecucionPct)
      ? ''
      : `. Consecución ${datos.consecucionPct.toLocaleString('es-ES', {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })} por ciento`;
  return `${sentido}, ${textoRitmo(datos.diferenciaRitmo)}${pct}`;
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

/** La curva real se corta en el último día con cierre. El objetivo sigue el mes entero. */
function valoresReal(dias: DiaFacturacionMes[], ultimo: string | null): Array<number | null> {
  if (!ultimo) return dias.map(() => null);
  return dias.map((dia) => (dia.fecha <= ultimo && Number.isFinite(dia.real) ? dia.real : null));
}

function tramos(valores: Array<number | null>, ancho: number, maximo: number): Punto[][] {
  if (valores.length === 0 || ancho <= 0) return [];
  const paso = ancho / valores.length;
  const grupos: Punto[][] = [];
  let actual: Punto[] = [];
  valores.forEach((valor, indice) => {
    if (valor == null || !Number.isFinite(valor)) {
      if (actual.length > 0) grupos.push(actual);
      actual = [];
      return;
    }
    actual.push({ x: paso * (indice + 0.5), y: yDe(valor, maximo), indice });
  });
  if (actual.length > 0) grupos.push(actual);
  return grupos;
}

function segmentosDe(puntos: Punto[]): Trazo[] {
  const salida: Trazo[] = [];
  for (let i = 0; i < puntos.length - 1; i += 1) {
    const a = puntos[i];
    const b = puntos[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const largo = Math.hypot(dx, dy);
    if (largo < 1) continue;
    salida.push({
      clave: `s-${a.indice}`,
      left: (a.x + b.x) / 2 - largo / 2,
      top: (a.y + b.y) / 2 - 1,
      ancho: largo,
      grados: (Math.atan2(dy, dx) * 180) / Math.PI,
    });
  }
  return salida;
}

function trazosDe(puntos: Punto[]): Trazo[] {
  const salida: Trazo[] = [];
  for (let i = 0; i < puntos.length - 1; i += 1) {
    const a = puntos[i];
    const b = puntos[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const largo = Math.hypot(dx, dy);
    if (largo < 1) continue;
    const ux = dx / largo;
    const uy = dy / largo;
    const grados = (Math.atan2(dy, dx) * 180) / Math.PI;
    let recorrido = 0;
    let n = 0;
    while (recorrido < largo) {
      const trozo = Math.min(4, largo - recorrido);
      const cx = a.x + ux * (recorrido + trozo / 2);
      const cy = a.y + uy * (recorrido + trozo / 2);
      salida.push({
        clave: `t-${a.indice}-${n}`,
        left: cx - trozo / 2,
        top: cy - 1,
        ancho: trozo,
        grados,
      });
      recorrido += trozo + 4;
      n += 1;
    }
  }
  return salida;
}

function GraficoDiario({
  dias,
  ultimoDiaConDatos,
}: {
  dias: DiaFacturacionMes[];
  ultimoDiaConDatos: string | null;
}) {
  const [ancho, setAncho] = useState(0);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const maximo = useMemo(() => maximoDe(dias), [dias]);
  const reales = useMemo(
    () => (ancho > 0 ? tramos(valoresReal(dias, ultimoDiaConDatos), ancho, maximo) : []),
    [ancho, dias, ultimoDiaConDatos, maximo],
  );
  const objetivos = useMemo(
    () => (ancho > 0 ? tramos(dias.map((dia) => dia.objetivo), ancho, maximo) : []),
    [ancho, dias, maximo],
  );
  const diaSel = dias.find((dia) => dia.fecha === seleccion) ?? null;
  const paso = dias.length > 0 ? ancho / dias.length : 0;
  const firma = `${dias[0]?.fecha ?? ''}:${dias[dias.length - 1]?.fecha ?? ''}:${ultimoDiaConDatos ?? ''}`;

  useEffect(() => {
    setSeleccion(null);
  }, [firma]);

  return (
    <View style={styles.graficoBloque}>
      <View
        style={styles.plot}
        accessibilityLabel="Gráfico diario de facturación"
        onLayout={(evento) => {
          const siguiente = evento.nativeEvent.layout.width;
          setAncho((previo) => (Math.abs(previo - siguiente) < 0.5 ? previo : siguiente));
        }}
      >
        <View
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          {reales.flat().map((punto) => (
            <View
              key={`relleno-${punto.indice}`}
              style={{
                position: 'absolute',
                left: paso * punto.indice,
                width: paso,
                top: punto.y,
                bottom: 0,
                backgroundColor: RELLENO,
              }}
            />
          ))}
          {objetivos.flatMap((tramo) =>
            trazosDe(tramo).map((trazo) => (
              <View
                key={trazo.clave}
                style={[
                  styles.trazo,
                  styles.trazoObjetivo,
                  {
                    left: trazo.left,
                    top: trazo.top,
                    width: trazo.ancho,
                    transform: [{ rotate: `${trazo.grados}deg` }],
                  },
                ]}
              />
            )),
          )}
          {reales.flatMap((tramo) =>
            segmentosDe(tramo).map((trazo) => (
              <View
                key={trazo.clave}
                style={[
                  styles.trazo,
                  styles.trazoReal,
                  {
                    left: trazo.left,
                    top: trazo.top,
                    width: trazo.ancho,
                    transform: [{ rotate: `${trazo.grados}deg` }],
                  },
                ]}
              />
            )),
          )}
          {reales.flat().map((punto) => (
            <View
              key={`punto-${punto.indice}`}
              style={[styles.punto, { left: punto.x - 3, top: punto.y - 3 }]}
            />
          ))}
          <View style={styles.base} />
        </View>
        <View style={styles.hits}>
          {dias.map((dia) => {
            const activo = dia.fecha === seleccion;
            return (
              <Pressable
                key={dia.fecha}
                accessibilityRole="button"
                accessibilityState={{ selected: activo }}
                accessibilityLabel={`${fechaVisible(dia.fecha)}. Real ${euros(dia.real)}. Objetivo ${euros(dia.objetivo)}`}
                onPress={() => setSeleccion((previo) => (previo === dia.fecha ? null : dia.fecha))}
                style={[styles.diaHit, activo && styles.diaHitActivo]}
              />
            );
          })}
        </View>
      </View>

      <View style={styles.leyenda}>
        <View style={styles.muestraReal} />
        <Text style={styles.leyendaTexto}>Real</Text>
        <View style={styles.muestraGuiones}>
          <View style={styles.guion} />
          <View style={styles.guion} />
          <View style={styles.guion} />
        </View>
        <Text style={styles.leyendaTexto}>Objetivo</Text>
      </View>

      {diaSel ? (
        <View style={styles.ficha} accessibilityLiveRegion="polite">
          <Text style={styles.fichaFecha}>{fechaVisible(diaSel.fecha)}</Text>
          <Text style={styles.fichaReal}>{euros(diaSel.real)}</Text>
          <Text style={styles.fichaObj}>Objetivo {euros(diaSel.objetivo)}</Text>
        </View>
      ) : (
        <Text style={styles.ayuda}>Pulsa un día para ver el detalle.</Text>
      )}
    </View>
  );
}

function CajaCifra({
  etiqueta,
  valor,
  accesible,
  enFila,
}: {
  etiqueta: string;
  valor: string;
  accesible: string;
  enFila: boolean;
}) {
  return (
    <View style={[styles.caja, enFila && styles.cajaEnFila]} accessibilityLabel={`${accesible}: ${valor}`}>
      <Text style={styles.cajaEtiqueta}>{etiqueta}</Text>
      <Text style={[styles.cajaValor, tasksUi.tabularNums]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
        {valor}
      </Text>
    </View>
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
  etiquetaFiltro,
  onAbrirFiltro,
  onReintentar,
  style,
}: Props) {
  const { isPhone } = useBreakpoint();
  const listo = estado === 'listo' && datos != null && datos.dias.length > 0;
  const vacio = estado === 'vacio' || (estado === 'listo' && !listo);
  const hayObjetivo = listo && datos != null && datos.objetivoMes > 0;
  const logro = hayObjetivo && datos != null ? clamp01(datos.totalReal / datos.objetivoMes) : 0;
  const ritmo = hayObjetivo && datos != null ? clamp01(datos.objetivoAHoy / datos.objetivoMes) : 0;
  const diferencia = listo && datos != null ? datos.diferenciaRitmo : 0;
  const tono = diferencia > 0 ? 'ok' : diferencia < 0 ? 'mal' : 'neutro';

  return (
    <View style={[styles.tarjeta, style]}>
      <LinearGradient
        colors={FRANJA}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.franja}
      />
      <View style={styles.cuerpo}>
        <View style={styles.cabecera}>
          <Text style={styles.kicker}>Facturación</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Filtro de facturación: ${etiquetaFiltro}`}
            accessibilityHint="Abre el mes y los locales"
            onPress={onAbrirFiltro}
            style={({ pressed }) => [styles.pastilla, pressed && styles.pulsado]}
          >
            <Text style={styles.pastillaTexto} numberOfLines={1}>
              {etiquetaFiltro}
            </Text>
            <MaterialIcons name="expand-more" size={18} color={tasksUi.color.textoSecundario} />
          </Pressable>
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
                {euros(datos.totalReal)}
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
                  {textoRitmo(datos.diferenciaRitmo)}
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
                    ? `Facturado ${euros(datos.totalReal)} de un objetivo mensual de ${euros(datos.objetivoMes)}. La marca está en el objetivo a hoy, ${euros(datos.objetivoAHoy)}.`
                    : 'Sin objetivo del mes'
                }
              >
                <View style={styles.pista}>
                  {logro > 0 ? (
                    <LinearGradient
                      colors={FRANJA}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={[styles.relleno, { width: `${logro * 100}%` }]}
                    />
                  ) : null}
                </View>
                {hayObjetivo ? <View style={[styles.marca, { left: `${ritmo * 100}%` }]} /> : null}
              </View>
              <Text style={styles.ayuda}>La marca es el objetivo a hoy.</Text>
            </View>

            <View style={[styles.cajas, isPhone && styles.cajasPhone]}>
              <CajaCifra
                etiqueta="A hoy"
                accesible="Objetivo a hoy"
                valor={euros(datos.objetivoAHoy)}
                enFila={isPhone}
              />
              <CajaCifra
                etiqueta="Del mes"
                accesible="Objetivo del mes"
                valor={euros(datos.objetivoMes)}
                enFila={isPhone}
              />
              <CajaCifra
                etiqueta="Proyección"
                accesible="Proyección a fin de mes"
                valor={euros(datos.proyeccionFinMes)}
                enFila={isPhone}
              />
            </View>

            <GraficoDiario dias={datos.dias} ultimoDiaConDatos={datos.ultimoDiaConDatos} />

            <Text style={styles.pie}>
              {datos.ultimoDiaConDatos
                ? `Cajas hasta ${fechaVisible(datos.ultimoDiaConDatos)}`
                : 'Sin cajas en este mes'}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tarjeta: {
    width: '100%',
    alignSelf: 'stretch',
    backgroundColor: tasksUi.color.superficie,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    borderRadius: tasksUi.radius.contenedor,
    overflow: 'hidden',
  },
  franja: {
    height: 4,
  },
  cuerpo: {
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  cabecera: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  kicker: {
    ...tasksUi.tipo.etiqueta,
    textTransform: 'uppercase',
    flexShrink: 0,
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
  bloque: {
    gap: SPACING.md,
  },
  hero: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  heroPhone: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  total: {
    ...tasksUi.tipo.tituloPantalla,
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
  barraBloque: {
    gap: SPACING.xs,
  },
  pistaCaja: {
    height: 16,
    justifyContent: 'center',
  },
  pista: {
    height: 8,
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
    height: 14,
    marginLeft: -1,
    top: 1,
    borderRadius: 1,
    backgroundColor: tasksUi.color.textoPrimario,
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
    backgroundColor: tasksUi.color.superficieHundida,
    borderRadius: tasksUi.radius.control,
    padding: SPACING.sm,
    gap: 2,
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
  cajaEtiqueta: {
    ...tasksUi.tipo.micro,
  },
  cajaValor: {
    ...tasksUi.tipo.dato,
    color: tasksUi.color.textoPrimario,
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
  trazo: {
    position: 'absolute',
    height: 2,
    borderRadius: 1,
    transformOrigin: 'center',
  },
  trazoReal: {
    backgroundColor: AZUL,
  },
  trazoObjetivo: {
    backgroundColor: tasksUi.color.textoTerciario,
  },
  punto: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: AZUL,
  },
  base: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
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
  diaHitActivo: {
    backgroundColor: 'rgba(14, 165, 233, 0.08)',
  },
  leyenda: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.xs,
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
  ficha: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACING.sm,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    borderRadius: tasksUi.radius.control,
    backgroundColor: tasksUi.color.superficie,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    ...tasksUi.sombraFlotante,
  },
  fichaFecha: {
    ...tasksUi.tipo.dato,
    color: tasksUi.color.textoPrimario,
  },
  fichaReal: {
    ...tasksUi.tipo.dato,
    ...tasksUi.tabularNums,
    color: AZUL,
  },
  fichaObj: {
    ...tasksUi.tipo.micro,
    ...tasksUi.tabularNums,
  },
  ayuda: {
    ...tasksUi.tipo.micro,
  },
  pie: {
    ...tasksUi.tipo.micro,
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
