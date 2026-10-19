import { Platform, type TextStyle, type ViewStyle } from 'react-native';
import { MIN_TOUCH } from '../../constants/layout';
import { diaSemanaIso, formatEur, formatPct, type FranjaPrevision } from '../../lib/previsionFranjasApi';

/** Colores semánticos de Previsión. Los componentes no repiten estos hex. */
export const colores = {
  lienzo: '#f8fafc',
  superficie: '#ffffff',
  texto: '#0f172a',
  textoSecundario: '#64748b',
  textoTerciario: '#94a3b8',
  textoPestana: '#475569',
  borde: '#e2e8f0',
  separador: '#f1f5f9',
  acento: '#0ea5e9',
  textoSobreAcento: '#ffffff',
  positiva: '#16a34a',
  negativa: '#dc2626',
  festivoFondo: '#fef3c7',
  festivoTexto: '#92400e',
  enlace: '#0369a1',
  filaMarcada: '#f0f9ff',
  overlay: 'rgba(15,23,42,0.45)',
  tirador: '#cbd5e1',
  bordeCalorClaro: '#e0f2fe',
} as const;

export const radios = {
  superficie: 12,
  control: 8,
  pastilla: 999,
  hoja: 16,
  calcularHoja: 10,
} as const;

export const ESCALA_CALOR = [
  { fondo: '#f0f9ff', texto: colores.texto },
  { fondo: '#bae6fd', texto: colores.texto },
  { fondo: '#38bdf8', texto: colores.texto },
  { fondo: '#0284c7', texto: colores.textoSobreAcento },
  { fondo: '#0369a1', texto: colores.textoSobreAcento },
] as const;

export type ModoPrevision = 'escritorio' | 'tablet' | 'movil';

/** Umbrales de esta pantalla: móvil < 768, tablet 768–1279, escritorio ≥ 1280. */
export function modoPrevision(width: number): ModoPrevision {
  if (width < 768) return 'movil';
  if (width < 1280) return 'tablet';
  return 'escritorio';
}

export function altoControl(modo: ModoPrevision): number {
  return modo === 'escritorio' ? 36 : MIN_TOUCH;
}

export function paddingPagina(modo: ModoPrevision): number {
  if (modo === 'escritorio') return 48;
  if (modo === 'tablet') return 24;
  return 16;
}

export function gapPagina(modo: ModoPrevision): number {
  return modo === 'movil' ? 14 : 20;
}

export function tamanoCifra(modo: ModoPrevision): number {
  if (modo === 'escritorio') return 28;
  if (modo === 'tablet') return 26;
  return 22;
}

/** Lo más cercano a −0,02 em que admite React Native. */
export function trackingCifra(fontSize: number): number {
  return Math.round(-0.02 * fontSize * 10) / 10;
}

export const peso = {
  etiqueta: '500' as TextStyle['fontWeight'],
  medio: '500' as TextStyle['fontWeight'],
  semibold: '600' as TextStyle['fontWeight'],
  negrita: '700' as TextStyle['fontWeight'],
  titulo: (Platform.OS === 'web' ? '650' : '600') as unknown as TextStyle['fontWeight'],
};

export const estiloCifras: TextStyle = {
  fontVariant: ['tabular-nums'],
};

export const estiloEtiqueta: TextStyle = {
  fontSize: 11,
  fontWeight: peso.etiqueta,
  color: colores.textoSecundario,
};

export const sombraMenu: ViewStyle = Platform.select({
  web: { boxShadow: '0 8px 24px rgba(15, 23, 42, 0.08)' } as ViewStyle,
  default: {
    shadowColor: colores.texto,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 8,
  },
}) ?? {};

/** Paso 0–4 según el importe respecto al máximo de celdas de franja del local. */
export function indiceCalor(valor: number, max: number): number {
  if (!(max > 0) || !(valor > 0)) return 0;
  const t = Math.min(1, valor / max);
  if (t >= 1) return ESCALA_CALOR.length - 1;
  return Math.min(ESCALA_CALOR.length - 1, Math.floor(t * ESCALA_CALOR.length));
}

export function estiloCalor(valor: number, max: number): { fondo: string; texto: string; borde: string | null } {
  const i = indiceCalor(valor, max);
  return {
    fondo: ESCALA_CALOR[i].fondo,
    texto: ESCALA_CALOR[i].texto,
    borde: i === 0 ? colores.bordeCalorClaro : null,
  };
}

const MENOS = '\u2212';

/** Desviación con signo siempre: +4,2 % o −2,1 %. No altera el ratio. */
export function formatDesvio(ratio: number | null | undefined): string | null {
  if (ratio == null || !Number.isFinite(Number(ratio))) return null;
  const texto = formatPct(ratio);
  if (texto.startsWith('-')) return MENOS + texto.slice(1);
  if (texto.startsWith('+')) return texto;
  return `+${texto}`;
}

export function colorDesvio(ratio: number): string {
  if (ratio > 0) return colores.positiva;
  if (ratio < 0) return colores.negativa;
  return colores.textoSecundario;
}

/** "2026-12-31" → "31/12/25". */
export function fechaCompCorta(iso: string): string {
  const p = String(iso ?? '').split('-');
  if (p.length !== 3) return String(iso ?? '');
  return `${p[2]}/${p[1]}/${p[0].slice(2)}`;
}

const MESES_CORTOS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const MESES_MIN = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** "Dic 2026" o "Dic 2026 – Ene 2027" a partir de las fechas ISO del filtro. */
export function etiquetaRangoMeses(desde: string, hasta: string): string {
  const re = /^(\d{4})-(\d{2})-\d{2}$/;
  const a = re.exec(desde);
  if (!a) return 'Periodo';
  const izq = `${MESES_CORTOS[Number(a[2]) - 1] ?? ''} ${a[1]}`.trim();
  const b = re.exec(hasta);
  if (!b) return izq;
  const der = `${MESES_CORTOS[Number(b[2]) - 1] ?? ''} ${b[1]}`.trim();
  return izq === der ? izq : `${izq} – ${der}`;
}

/** "7 – 13 dic" (o con mes si el bloque cruza). */
export function etiquetaBloqueSemana(desde: string, hasta: string): string {
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = re.exec(desde);
  const b = re.exec(hasta);
  if (!a || !b) return '';
  const da = String(Number(a[3]));
  const db = String(Number(b[3]));
  const ma = MESES_MIN[Number(a[2]) - 1] ?? '';
  const mb = MESES_MIN[Number(b[2]) - 1] ?? '';
  if (desde === hasta) return `${da} ${ma}`;
  if (a[1] === b[1] && a[2] === b[2]) return `${da} – ${db} ${mb}`;
  return `${da} ${ma} – ${db} ${mb}`;
}

export function diaMesCorto(iso: string): string {
  const p = String(iso ?? '').split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}` : String(iso ?? '');
}

export function fechaLargaA11y(iso: string): string {
  const p = String(iso ?? '').split('-');
  if (p.length !== 3) return String(iso ?? '');
  const dia = DIAS[diaSemanaIso(iso)] ?? '';
  const mes = MESES[Number(p[1]) - 1] ?? '';
  return `${dia} ${Number(p[2])} de ${mes}`;
}

export function eurosA11y(n: number): string {
  return formatEur(n).replace(' €', ' euros');
}

export function nombreFranjaVisible(f: Pick<FranjaPrevision, 'etiqueta' | 'label' | 'desde' | 'hasta'>): string {
  const etiqueta = f.etiqueta?.trim();
  if (etiqueta) return etiqueta;
  const label = f.label?.trim();
  if (label) return label;
  return `${f.desde}–${f.hasta}`;
}

/** "12:00–18:00". Null si el título visible ya es solo ese rango. */
export function rangoFranja(f: Pick<FranjaPrevision, 'etiqueta' | 'label' | 'desde' | 'hasta'>): string | null {
  const desde = f.desde?.trim();
  const hasta = f.hasta?.trim();
  if (!desde || !hasta) return null;
  const rango = `${desde}–${hasta}`;
  return nombreFranjaVisible(f) === rango ? null : rango;
}

/** Quita el rango entre paréntesis de un label de KPI ("Cenas (20:00–00:00)"). */
export function nombreFranjaKpi(label: string): string {
  const limpio = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return limpio || label;
}
