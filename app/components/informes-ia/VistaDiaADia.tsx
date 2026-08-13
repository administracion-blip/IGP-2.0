import { useMemo, useState, type ReactNode } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { formatMoneda } from '../../utils/formatMoneda';
import { formatFecha } from '../../utils/formatFecha';

type ImporteHora = { hora: number; real: number; comparativa: number };

type FacturacionLocal = {
  localId: string;
  nombre: string;
  real: number;
  comparativa: number;
  delta?: number;
  pctVsComp?: number | null;
  diferenciaLabel?: string | null;
  variacionPct?: number | null;
  variacionPctLabel?: string | null;
  sinDatos?: boolean;
};

type ObjetivoLocal = {
  localId: string;
  nombre: string;
  pctConsecucion?: number | null;
  pctDesviacion?: number | null;
  pctDesviacionLabel?: string | null;
  importeRealHastaAyer?: number;
  importeCompHastaAyer?: number;
  realLabel?: string | null;
  objetivoLabel?: string | null;
  sinDatos?: boolean;
};

type AgrupacionObj = {
  id?: string;
  nombre?: string;
  importeRealHastaAyer?: number;
  importeCompHastaAyer?: number;
  pctConsecucion?: number | null;
  pctDesviacion?: number | null;
  pctDesviacionLabel?: string | null;
  realLabel?: string | null;
  objetivoLabel?: string | null;
  localesIncluidos?: number;
};

type RatioLocal = {
  localId: string;
  nombre: string;
  facturacionReal?: number;
  gastoPersonal?: number | null;
  gastoMercaderia?: number | null;
  gastoMusicos?: number | null;
  ratioPersonal?: number | null;
  ratioMercaderia?: number | null;
  ratioMusicos?: number | null;
  sinFacturacion?: boolean;
  avisos?: string[];
};

type VentasLocal = {
  localId: string;
  nombre: string;
  porHora: ImporteHora[];
  totalReal?: number;
  totalComparativa?: number;
};

type ExcepcionItem = {
  tipo?: string;
  quien?: string | null;
  localNombre?: string;
  importe?: number;
  cantidad?: number | null;
  producto?: string | null;
  motivo?: string | null;
  ticket?: string | null;
  hora?: string | null;
  discountRate?: number | null;
};

type PorTipoResumen = { count?: number; importe?: number };

type TopVentaItem = {
  rank?: number;
  userId?: string;
  userName?: string;
  amount?: number;
};

type TopVentasLocal = {
  localId: string;
  nombre: string;
  sinDatos?: boolean;
  top?: TopVentaItem[];
};

type ParteMant = {
  id?: string;
  localId?: string;
  localNombre?: string;
  titulo?: string;
  categoria?: string | null;
  zona?: string | null;
  origen?: string;
  fechaCompletada?: string;
  estadoValoracion?: string | null;
  valoracionTotal?: number | null;
};

export type ObjetivoFacturacionHoy = {
  fecha?: string;
  fechaLabel?: string | null;
  fechaComparativa?: string | null;
  comparativaLabel?: string | null;
  nota?: string | null;
  total?: {
    objetivo?: number;
    objetivoLabel?: string | null;
  };
  locales?: Array<{
    localId?: string;
    nombre?: string;
    objetivo?: number;
    objetivoLabel?: string | null;
  }>;
};

type LimpiezaMant = {
  id?: string;
  localId?: string;
  localNombre?: string;
  objetoNombre?: string | null;
  tareaNombre?: string | null;
  ubicacion?: string | null;
  completadoAt?: string | null;
  realizadoPorNombre?: string | null;
};

export type DatosDiaADia = {
  fecha?: string;
  fechaComparativa?: string;
  origenComparativa?: string;
  comparativaLabel?: string;
  facturacion?: {
    total?: {
      real?: number;
      comparativa?: number;
      delta?: number;
      pctVsComp?: number | null;
      diferenciaLabel?: string | null;
      variacionPct?: number | null;
      variacionPctLabel?: string | null;
    };
    locales?: FacturacionLocal[];
  };
  objetivos?: {
    mes?: string;
    hastaFecha?: string;
    total?: ObjetivoLocal;
    locales?: ObjetivoLocal[];
    peoresPorCaida?: ObjetivoLocal[];
    agrupaciones?: AgrupacionObj[];
  };
  ratiosPorLocal?: RatioLocal[];
  ventasHoraComparativa?: {
    grupo?: { porHora?: ImporteHora[]; totalReal?: number; totalComparativa?: number };
    locales?: VentasLocal[];
  };
  /** Opcional: informes históricos pueden no traer el bloque. */
  excepcionesSospechosas?: {
    resumen?: {
      total?: number;
      porTipo?: {
        invitacion?: PorTipoResumen;
        descuento?: PorTipoResumen;
        [k: string]: PorTipoResumen | undefined;
      };
    };
    items?: ExcepcionItem[];
    error?: string;
  };
  topVentasPorLocal?: {
    fecha?: string;
    locales?: TopVentasLocal[];
  };
  mantenimientoDia?: {
    fecha?: string;
    resumen?: {
      incidencias?: number;
      recurrentes?: number;
      limpiezas?: number;
      valoradas?: number;
    };
    partes?: ParteMant[];
    limpiezas?: LimpiezaMant[];
  };
  /** Objetivo de facturación del día foco (comparativa). Informes antiguos pueden no traerlo. */
  objetivoFacturacionHoy?: ObjetivoFacturacionHoy;
};

/** Atributo DOM para captura PDF por secciones (solo web / RN-web). */
function pdfAttrs(section: string): object {
  if (Platform.OS !== 'web') return {};
  // RN Web emite data-pdf-section desde dataSet.pdfSection (no desde 'data-pdf-section' literal).
  return { dataSet: { pdfSection: section } } as object;
}

const PDF_CHUNK_LOCALES = 6;
const PDF_CHUNK_RATIOS = 12;
const PDF_CHUNK_EXC = 18;
const PDF_CHUNK_TOP = 6;
const PDF_CHUNK_MANT = 12;

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

const C = {
  success: '#16a34a',
  successBg: '#dcfce7',
  successSoft: '#f0fdf4',
  danger: '#dc2626',
  dangerBg: '#fee2e2',
  dangerSoft: '#fef2f2',
  sky: '#0ea5e9',
  skyBg: '#e0f2fe',
  skySoft: '#f0f9ff',
  warning: '#d97706',
  warningBg: '#fef3c7',
  amberBg: '#ffedd5',
  amberFg: '#c2410c',
  muted: '#94a3b8',
  slate: '#64748b',
  text: '#0f172a',
  textSec: '#475569',
  border: '#e2e8f0',
  borderSky: '#bae6fd',
} as const;

/**
 * Semáforo de ratios (heurística suave, sin cruzar maestros ratio_*):
 * - null / sin dato → gris
 * - ≤ 40 % → verde (ratio contenido)
 * - > 40 % y ≤ 55 % → ámbar
 * - > 55 % → rojo
 */
const RATIO_AMBRA_UMBRAL = 40;
const RATIO_ROJO_UMBRAL = 55;

function formatPct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
}

function formatPctSigned(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
}

function formatMonedaSigned(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${formatMoneda(v)}`;
}

function colorDelta(n: number | null | undefined): string {
  if (n == null || n === 0) return C.slate;
  return n > 0 ? C.success : C.danger;
}

function colorPct(n: number | null | undefined): string {
  if (n == null) return C.muted;
  if (n >= 100) return C.success;
  if (n >= 90) return C.warning;
  return C.danger;
}

function colorBarraDesv(desv: number | null | undefined): string {
  if (desv == null) return C.sky;
  if (desv > 0.5) return C.success;
  if (desv < -0.5) return C.danger;
  return C.sky;
}

function badgeVariacionGrupo(kpiVar: number | null): { label: string; bg: string; fg: string } {
  if (kpiVar == null || Number.isNaN(kpiVar)) {
    return { label: 'Sin dato', bg: '#f1f5f9', fg: C.slate };
  }
  if (Math.abs(kpiVar) < 0.5) {
    return { label: 'En línea', bg: C.skyBg, fg: '#0369a1' };
  }
  if (kpiVar > 0) {
    return { label: 'Por encima', bg: C.successBg, fg: '#15803d' };
  }
  return { label: 'Por debajo', bg: C.dangerBg, fg: '#b91c1c' };
}

function semaforoRatio(ratio: number | null | undefined): { bg: string; fg: string } {
  if (ratio == null || Number.isNaN(Number(ratio))) {
    return { bg: '#f1f5f9', fg: C.muted };
  }
  const v = Number(ratio);
  if (v > RATIO_ROJO_UMBRAL) return { bg: C.dangerBg, fg: C.danger };
  if (v > RATIO_AMBRA_UMBRAL) return { bg: C.warningBg, fg: C.warning };
  return { bg: C.successBg, fg: C.success };
}

function fallbackComparativaLabel(datos: DatosDiaADia): string {
  if (datos.comparativaLabel) return datos.comparativaLabel;
  const f = datos.fechaComparativa ? formatFecha(datos.fechaComparativa) : '—';
  if (datos.origenComparativa === 'festivo') {
    return `Comparado con ${f} (día mapeado en festivos)`;
  }
  if (datos.fechaComparativa) {
    return `Comparado con ${f} (mismo día año anterior)`;
  }
  return '';
}

function pctVariacionLocal(l: FacturacionLocal): number | null {
  if (l.sinDatos) return null;
  if (l.variacionPct != null) return Number(l.variacionPct);
  if (l.pctVsComp != null && l.comparativa > 0) {
    return Number(l.real) / Number(l.comparativa) * 100 - 100;
  }
  return null;
}

function cellDiferencia(l: FacturacionLocal): { text: string; color: string } {
  if (l.sinDatos) return { text: '—', color: C.muted };
  const delta = l.delta != null ? Number(l.delta) : Number(l.real) - Number(l.comparativa);
  if (l.diferenciaLabel) {
    const short = l.diferenciaLabel.replace(/^Diferencia:\s*/i, '');
    return { text: short, color: colorDelta(delta) };
  }
  return { text: formatMonedaSigned(delta), color: colorDelta(delta) };
}

function cellVariacion(l: FacturacionLocal): { text: string; color: string; pct: number | null } {
  if (l.sinDatos) return { text: '—', color: C.muted, pct: null };
  const pct = pctVariacionLocal(l);
  if (l.variacionPctLabel) {
    const short = l.variacionPctLabel.replace(/\s*respecto al día comparable$/i, '');
    return { text: short, color: colorDelta(pct), pct };
  }
  if (pct != null) {
    return { text: formatPctSigned(pct), color: colorDelta(pct), pct };
  }
  return { text: '—', color: C.muted, pct: null };
}

function desviacionDe(obj: ObjetivoLocal | undefined | null): number | null {
  if (!obj || obj.sinDatos) return null;
  if (obj.pctDesviacion != null) return Number(obj.pctDesviacion);
  if (obj.pctConsecucion != null) return Number(obj.pctConsecucion) - 100;
  return null;
}

function labelDesviacion(obj: ObjetivoLocal | undefined | null): string {
  if (!obj || obj.sinDatos) return '—';
  if (obj.pctDesviacionLabel) return obj.pctDesviacionLabel;
  const d = desviacionDe(obj);
  return d == null ? '—' : `${formatPctSigned(d)} vs objetivo`;
}

function labelReal(obj: ObjetivoLocal | AgrupacionObj | undefined | null): string {
  if (!obj) return '—';
  if ('sinDatos' in obj && obj.sinDatos) return '—';
  if (obj.realLabel) return obj.realLabel;
  if (obj.importeRealHastaAyer == null) return '—';
  return `Real: ${formatMoneda(obj.importeRealHastaAyer)}`;
}

function labelObjetivo(obj: ObjetivoLocal | AgrupacionObj | undefined | null): string {
  if (!obj) return '—';
  if ('sinDatos' in obj && obj.sinDatos) return '—';
  if (obj.objetivoLabel) return obj.objetivoLabel;
  if (obj.importeCompHastaAyer == null) return '—';
  return `Objetivo: ${formatMoneda(obj.importeCompHastaAyer)}`;
}

function inicialNombre(nombre?: string | null): string {
  if (!nombre?.trim()) return '?';
  return nombre.trim().charAt(0).toUpperCase();
}

function horaPuntaDe(porHora: ImporteHora[]): { hora: number; real: number } | null {
  let best: { hora: number; real: number } | null = null;
  for (const p of porHora) {
    const real = Number(p.real) || 0;
    if (!best || real > best.real) best = { hora: p.hora, real };
  }
  if (!best || best.real <= 0) return null;
  return best;
}

function VariacionBadge({ pct, text }: { pct: number | null; text: string }) {
  if (pct == null || text === '—') {
    return (
      <View style={[styles.varBadge, { backgroundColor: '#f1f5f9' }]}>
        <Text style={[styles.varBadgeText, { color: C.muted }]}>—</Text>
      </View>
    );
  }
  const up = pct > 0.05;
  const down = pct < -0.05;
  const bg = up ? C.successBg : down ? C.dangerBg : C.skyBg;
  const fg = up ? C.success : down ? C.danger : '#0369a1';
  return (
    <View style={[styles.varBadge, { backgroundColor: bg }]}>
      {up || down ? (
        <MaterialIcons name={up ? 'trending-up' : 'trending-down'} size={12} color={fg} />
      ) : null}
      <Text style={[styles.varBadgeText, { color: fg }]} numberOfLines={1}>{text}</Text>
    </View>
  );
}

function RatioBadge({ value, sinFacturacion }: { value: number | null | undefined; sinFacturacion?: boolean }) {
  const ratio = sinFacturacion ? null : value;
  const sem = semaforoRatio(ratio);
  return (
    <View style={[styles.ratioBadge, { backgroundColor: sem.bg }]}>
      <Text style={[styles.ratioBadgeText, { color: sem.fg }]}>
        {ratio == null ? '—' : formatPct(ratio)}
      </Text>
    </View>
  );
}

function Seccion({
  titulo,
  icono,
  children,
  pdfSection,
}: {
  titulo: string;
  icono: keyof typeof MaterialIcons.glyphMap;
  children: ReactNode;
  pdfSection?: string;
}) {
  return (
    <View style={styles.seccion} {...(pdfSection ? pdfAttrs(pdfSection) : {})}>
      <View style={styles.seccionHead}>
        <View style={styles.seccionIconWrap}>
          <MaterialIcons name={icono} size={16} color="#0369a1" />
        </View>
        <Text style={styles.seccionTitulo}>{titulo}</Text>
      </View>
      {children}
    </View>
  );
}

function EmptyState({ texto }: { texto: string }) {
  return (
    <View style={styles.emptyBox}>
      <MaterialIcons name="inbox" size={18} color={C.muted} />
      <Text style={styles.emptyText}>{texto}</Text>
    </View>
  );
}

function TablaExcepciones({ items, isCompact }: { items: ExcepcionItem[]; isCompact: boolean }) {
  const mostrarProducto = !isCompact && items.some((it) => !!it.producto);
  if (items.length === 0) return null;
  return (
    <View style={styles.table}>
      <View style={[styles.tr, styles.trHead]}>
        <Text style={[styles.th, styles.colNombre]}>Quién</Text>
        <Text style={[styles.th, styles.colLocalSm]}>Local</Text>
        <Text style={[styles.th, styles.colNum]}>Importe</Text>
        {mostrarProducto ? (
          <Text style={[styles.th, styles.colProducto]}>Producto</Text>
        ) : null}
      </View>
      {items.map((it, idx) => (
        <View key={`${it.tipo}-${it.quien}-${it.ticket}-${idx}`} style={[styles.tr, styles.trExc]}>
          <View style={[styles.colNombre, styles.quienCell]}>
            <View style={styles.avatarCircle}>
              <Text style={styles.avatarText}>{inicialNombre(it.quien)}</Text>
            </View>
            <Text style={styles.quienNombre} numberOfLines={2}>{it.quien || '—'}</Text>
          </View>
          <Text style={[styles.td, styles.colLocalSm]} numberOfLines={2}>{it.localNombre || '—'}</Text>
          <Text style={[styles.td, styles.colNum, styles.importeBold]}>{formatMoneda(it.importe)}</Text>
          {mostrarProducto ? (
            <Text style={[styles.td, styles.colProducto]} numberOfLines={2}>{it.producto || '—'}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const DELTA_VERDE = 100;
const MAX_HORAS_TABLA_PDF = 13;

type FilaVentasHoraPdf = {
  key: string;
  label: string;
  byHora: Map<number, ImporteHora>;
  totalReal: number;
  totalComparativa: number;
};

/** Semáforo por delta real−comparativa (€). Null = sin datos. */
function colorSemaforoDelta(real: number, comparativa: number): { bg: string; fg: string } | null {
  if (!(real > 0) && !(comparativa > 0)) return null;
  const delta = real - comparativa;
  if (delta > DELTA_VERDE) return { bg: '#dcfce7', fg: '#15803d' };
  if (delta < -DELTA_VERDE) return { bg: '#fee2e2', fg: '#b91c1c' };
  return { bg: '#fef3c7', fg: '#b45309' };
}

function formatImporteHoraCompact(n: number): string {
  if (!(n > 0)) return '—';
  if (n >= 10000) {
    return `${(n / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })}k`;
  }
  return `${Math.round(n).toLocaleString('es-ES')}€`;
}

function mapPorHora(porHora: ImporteHora[]): Map<number, ImporteHora> {
  const m = new Map<number, ImporteHora>();
  for (const p of porHora) {
    m.set(Number(p.hora), {
      hora: Number(p.hora),
      real: Number(p.real) || 0,
      comparativa: Number(p.comparativa) || 0,
    });
  }
  return m;
}

function horasEjeVentasPdf(
  grupoPorHora: ImporteHora[],
  locales: VentasLocal[],
): number[] {
  const conVenta = new Set<number>();
  const mark = (arr: ImporteHora[]) => {
    for (const p of arr) {
      if ((Number(p.real) || 0) > 0 || (Number(p.comparativa) || 0) > 0) {
        conVenta.add(Number(p.hora));
      }
    }
  };
  mark(grupoPorHora);
  for (const loc of locales) mark(loc.porHora || []);

  if (grupoPorHora.length > 0) {
    const ordered: number[] = [];
    const seen = new Set<number>();
    for (const p of grupoPorHora) {
      const h = Number(p.hora);
      if (conVenta.has(h) && !seen.has(h)) {
        ordered.push(h);
        seen.add(h);
      }
    }
    const extras = [...conVenta].filter((h) => !seen.has(h)).sort((a, b) => a - b);
    return [...ordered, ...extras];
  }
  return [...conVenta].sort((a, b) => a - b);
}

function filasVentasHoraPdf(
  grupo: { porHora?: ImporteHora[]; totalReal?: number; totalComparativa?: number } | undefined,
  locales: VentasLocal[],
): FilaVentasHoraPdf[] {
  const grupoPorHora = grupo?.porHora || [];
  const filas: FilaVentasHoraPdf[] = [];

  if (grupoPorHora.length || grupo?.totalReal != null) {
    const byHora = mapPorHora(grupoPorHora);
    const totalReal = grupo?.totalReal != null
      ? Number(grupo.totalReal) || 0
      : [...byHora.values()].reduce((s, p) => s + p.real, 0);
    const totalComparativa = grupo?.totalComparativa != null
      ? Number(grupo.totalComparativa) || 0
      : [...byHora.values()].reduce((s, p) => s + p.comparativa, 0);
    filas.push({ key: 'grupo', label: 'GRUPO', byHora, totalReal, totalComparativa });
  }

  for (const loc of locales) {
    const byHora = mapPorHora(loc.porHora || []);
    const totalReal = loc.totalReal != null
      ? Number(loc.totalReal) || 0
      : [...byHora.values()].reduce((s, p) => s + p.real, 0);
    const totalComparativa = loc.totalComparativa != null
      ? Number(loc.totalComparativa) || 0
      : [...byHora.values()].reduce((s, p) => s + p.comparativa, 0);
    filas.push({
      key: loc.localId,
      label: loc.nombre || loc.localId,
      byHora,
      totalReal,
      totalComparativa,
    });
  }
  return filas;
}

function CeldaImporteHoraPdf({
  real,
  comparativa,
  esTotal,
}: {
  real: number;
  comparativa: number;
  esTotal?: boolean;
}) {
  const sem = colorSemaforoDelta(real, comparativa);
  const texto = formatImporteHoraCompact(real);
  return (
    <View
      style={[
        styles.vhPdfCell,
        esTotal && styles.vhPdfCellTotal,
        sem ? { backgroundColor: sem.bg } : null,
      ]}
    >
      <Text
        style={[
          styles.vhPdfCellText,
          esTotal && styles.vhPdfCellTextTotal,
          { color: sem ? sem.fg : C.muted },
        ]}
        numberOfLines={1}
      >
        {texto}
      </Text>
    </View>
  );
}

function TablaVentasHoraPdfMatrix({
  horas,
  filas,
  mostrarTotal,
}: {
  horas: number[];
  filas: FilaVentasHoraPdf[];
  mostrarTotal: boolean;
}) {
  return (
    <View style={styles.vhPdfTable}>
      <View style={[styles.vhPdfTr, styles.vhPdfTrHead]}>
        <Text style={[styles.vhPdfTh, styles.vhPdfColLabel]}>Local</Text>
        {horas.map((h) => (
          <Text key={h} style={[styles.vhPdfTh, styles.vhPdfColHora]}>
            {String(h).padStart(2, '0')}
          </Text>
        ))}
        {mostrarTotal ? (
          <Text style={[styles.vhPdfTh, styles.vhPdfColTotal]}>Total</Text>
        ) : null}
      </View>
      {filas.map((fila) => (
        <View key={fila.key} style={styles.vhPdfTr}>
          <Text
            style={[
              styles.vhPdfTdLabel,
              styles.vhPdfColLabel,
              fila.key === 'grupo' && styles.vhPdfTdLabelGrupo,
            ]}
            numberOfLines={1}
          >
            {fila.label}
          </Text>
          {horas.map((h) => {
            const p = fila.byHora.get(h);
            return (
              <CeldaImporteHoraPdf
                key={`${fila.key}-${h}`}
                real={p?.real ?? 0}
                comparativa={p?.comparativa ?? 0}
              />
            );
          })}
          {mostrarTotal ? (
            <CeldaImporteHoraPdf
              real={fila.totalReal}
              comparativa={fila.totalComparativa}
              esTotal
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function LeyendaVentasHoraPdf() {
  return (
    <View style={styles.vhPdfLeyenda}>
      <View style={styles.leyendaItem}>
        <View style={[styles.leyendaDot, { backgroundColor: '#dcfce7', borderWidth: 1, borderColor: '#86efac' }]} />
        <Text style={styles.vhPdfLeyendaText}>{'> +100 €'}</Text>
      </View>
      <View style={styles.leyendaItem}>
        <View style={[styles.leyendaDot, { backgroundColor: '#fef3c7', borderWidth: 1, borderColor: '#fcd34d' }]} />
        <Text style={styles.vhPdfLeyendaText}>±100 €</Text>
      </View>
      <View style={styles.leyendaItem}>
        <View style={[styles.leyendaDot, { backgroundColor: '#fee2e2', borderWidth: 1, borderColor: '#fca5a5' }]} />
        <Text style={styles.vhPdfLeyendaText}>{'< −100 €'}</Text>
      </View>
      <Text style={styles.vhPdfLeyendaHint}>Color = real − comparativa</Text>
    </View>
  );
}

/** Varias secciones PDF (una por bloque de horas) para no superar A4. */
function SeccionesVentasHoraPdf({
  grupo,
  locales,
}: {
  grupo?: { porHora?: ImporteHora[]; totalReal?: number; totalComparativa?: number };
  locales: VentasLocal[];
}) {
  const horas = useMemo(
    () => horasEjeVentasPdf(grupo?.porHora || [], locales),
    [grupo?.porHora, locales],
  );
  const filas = useMemo(() => filasVentasHoraPdf(grupo, locales), [grupo, locales]);

  if (horas.length === 0 || filas.length === 0) {
    return (
      <Seccion titulo="Ventas por hora (real vs comparativa)" icono="schedule" pdfSection="ventas-hora-1">
        <EmptyState texto="Sin serie horaria para este periodo" />
      </Seccion>
    );
  }

  const chunks =
    horas.length > MAX_HORAS_TABLA_PDF
      ? [
          horas.slice(0, Math.ceil(horas.length / 2)),
          horas.slice(Math.ceil(horas.length / 2)),
        ]
      : [horas];

  return (
    <>
      {chunks.map((chunk, idx) => (
        <Seccion
          key={`vh-sec-${idx}`}
          titulo={idx === 0 ? 'Ventas por hora (real vs comparativa)' : 'Ventas por hora (cont.)'}
          icono="schedule"
          pdfSection={`ventas-hora-${idx + 1}`}
        >
          <View style={styles.vhPdfWrap}>
            {idx === 0 ? <LeyendaVentasHoraPdf /> : null}
            <TablaVentasHoraPdfMatrix
              horas={chunk}
              filas={filas}
              mostrarTotal={idx === chunks.length - 1}
            />
          </View>
        </Seccion>
      ))}
    </>
  );
}

function GraficaDualHora({ porHora, compact }: { porHora: ImporteHora[]; compact: boolean }) {
  const max = useMemo(() => {
    let m = 0;
    for (const p of porHora) {
      m = Math.max(m, Number(p.real) || 0, Number(p.comparativa) || 0);
    }
    return m || 1;
  }, [porHora]);

  const alto = compact ? 120 : 160;
  const mostrarLabel = !compact;

  return (
    <View>
      <View style={styles.leyendaRow}>
        <View style={styles.leyendaItem}>
          <View style={[styles.leyendaDot, { backgroundColor: C.sky }]} />
          <Text style={styles.leyendaText}>Real</Text>
        </View>
        <View style={styles.leyendaItem}>
          <View style={[styles.leyendaDot, { backgroundColor: C.muted }]} />
          <Text style={styles.leyendaText}>Comparativa</Text>
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={!compact}>
        <View style={[styles.chartBars, { height: alto, minWidth: Math.max(porHora.length * (compact ? 18 : 28), 280) }]}>
          {porHora.map((p, idx) => {
            const real = Number(p.real) || 0;
            const comparativa = Number(p.comparativa) || 0;
            const hReal = real <= 0 ? 0 : (real / max) * (alto - 18);
            const hComp = comparativa <= 0 ? 0 : (comparativa / max) * (alto - 18);
            return (
              <View key={`${idx}-${p.hora}`} style={styles.chartCol}>
                <View style={styles.chartPair}>
                  <View style={[styles.bar, { height: hReal, backgroundColor: C.sky }]} />
                  <View style={[styles.bar, { height: hComp, backgroundColor: C.muted }]} />
                </View>
                {mostrarLabel || p.hora % 3 === 0 ? (
                  <Text style={styles.chartLabel}>{String(p.hora).padStart(2, '0')}</Text>
                ) : (
                  <Text style={styles.chartLabel}> </Text>
                )}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

type Props = {
  datos: DatosDiaADia;
  /** En true (captura PDF): tabla densa ventas/hora en lugar de gráficas + chips. */
  modoPdf?: boolean;
  /** Opcional; si se pasa aquí no hace falta renderizarlo fuera. */
  resumenIa?: string | null;
};

export function VistaDiaADia({ datos, modoPdf = false }: Props) {
  const { isCompact, shouldStackPanels } = useBreakpoint();
  const localesVentas = datos.ventasHoraComparativa?.locales || [];
  const [localSel, setLocalSel] = useState('');

  const porHora = useMemo(() => {
    if (localSel) {
      const loc = localesVentas.find((l) => l.localId === localSel);
      if (loc?.porHora?.length) return loc.porHora;
    }
    return datos.ventasHoraComparativa?.grupo?.porHora || [];
  }, [datos.ventasHoraComparativa, localSel, localesVentas]);

  const factLocales = datos.facturacion?.locales || [];
  const factTotal = datos.facturacion?.total;
  const objLocales = datos.objetivos?.locales || [];
  const objTotal = datos.objetivos?.total;
  const peores = datos.objetivos?.peoresPorCaida
    || [...objLocales]
      .filter((l) => {
        const d = desviacionDe(l);
        return !l.sinDatos && d != null && d < 0;
      })
      .sort((a, b) => (desviacionDe(a) ?? 0) - (desviacionDe(b) ?? 0))
      .slice(0, 5);
  const agrupaciones = datos.objetivos?.agrupaciones || [];
  const ratios = datos.ratiosPorLocal || [];
  const mostrarGastosRatio = !isCompact && ratios.some(
    (r) => r.gastoPersonal != null || r.gastoMercaderia != null || r.gastoMusicos != null,
  );

  const comparativaLabel = fallbackComparativaLabel(datos);
  const kpiDelta = factTotal?.delta != null
    ? Number(factTotal.delta)
    : factTotal
      ? Number(factTotal.real || 0) - Number(factTotal.comparativa || 0)
      : null;
  const kpiVar = factTotal?.variacionPct != null
    ? Number(factTotal.variacionPct)
    : factTotal?.comparativa && Number(factTotal.comparativa) > 0
      ? (Number(factTotal.real || 0) / Number(factTotal.comparativa) * 100 - 100)
      : null;

  const badgeGrupo = badgeVariacionGrupo(kpiVar);

  const excepciones = datos.excepcionesSospechosas;
  const excepcionItems = excepciones?.items || [];
  const invitaciones = excepcionItems.filter((it) => it.tipo === 'invitacion');
  const descuentos = excepcionItems.filter((it) => it.tipo === 'descuento');
  const resumenExc = excepciones?.resumen;
  const invCount = resumenExc?.porTipo?.invitacion?.count ?? invitaciones.length;
  const desCount = resumenExc?.porTipo?.descuento?.count ?? descuentos.length;
  const invImporte = resumenExc?.porTipo?.invitacion?.importe;
  const desImporte = resumenExc?.porTipo?.descuento?.importe;

  const topLocales = datos.topVentasPorLocal?.locales || [];
  const mant = datos.mantenimientoDia;
  const mantResumen = mant?.resumen;
  const mantPartes = mant?.partes || [];
  const mantLimpiezas = mant?.limpiezas || [];

  const desvGrupo = desviacionDe(objTotal);
  const cardWidth = shouldStackPanels ? '100%' as const : '48%' as const;
  const tituloObj = [
    'Consecución del mes',
    datos.objetivos?.mes || null,
    datos.objetivos?.hastaFecha
      ? `hasta ${formatFecha(datos.objetivos.hastaFecha)}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={styles.wrap}>
      {/* Cabecera + KPIs + facturación */}
      <View style={styles.pdfBlock} {...pdfAttrs('cabecera-kpis-facturacion')}>
        <View style={styles.cabecera}>
          <View style={styles.cabeceraIcon}>
            <MaterialIcons name="today" size={22} color="#0369a1" />
          </View>
          <View style={{ flex: 1, gap: 8 }}>
            <View style={styles.cabeceraTituloRow}>
              <Text style={styles.cabeceraTitulo}>Briefing día a día</Text>
              {factTotal ? (
                <View style={[styles.statusBadge, { backgroundColor: badgeGrupo.bg }]}>
                  <MaterialIcons
                    name={
                      kpiVar == null || Math.abs(kpiVar) < 0.5
                        ? 'remove'
                        : kpiVar > 0
                          ? 'arrow-upward'
                          : 'arrow-downward'
                    }
                    size={12}
                    color={badgeGrupo.fg}
                  />
                  <Text style={[styles.statusBadgeText, { color: badgeGrupo.fg }]}>{badgeGrupo.label}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.cabeceraChips}>
              <View style={styles.metaChip}>
                <MaterialIcons name="event" size={13} color="#0369a1" />
                <Text style={styles.metaChipText}>
                  {datos.fecha ? formatFecha(datos.fecha) : '—'}
                </Text>
              </View>
              {comparativaLabel ? (
                <View style={[styles.metaChip, styles.metaChipComp]}>
                  <MaterialIcons name="compare-arrows" size={13} color={C.slate} />
                  <Text style={styles.metaChipTextComp}>{comparativaLabel}</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>

        {factTotal ? (
          <View style={[styles.kpiRow, shouldStackPanels && styles.kpiRowStack]}>
            <View style={[styles.kpiCard, shouldStackPanels && styles.kpiCardStack]}>
              <Text style={styles.kpiLabel}>Facturado real</Text>
              <Text style={styles.kpiValorGrande}>{formatMoneda(factTotal.real)}</Text>
            </View>
            <View style={[styles.kpiCard, shouldStackPanels && styles.kpiCardStack]}>
              <Text style={styles.kpiLabel}>Día comparable</Text>
              <Text style={styles.kpiValorSec}>{formatMoneda(factTotal.comparativa)}</Text>
              {datos.fechaComparativa ? (
                <View style={styles.kpiFechaChip}>
                  <MaterialIcons name="history" size={11} color={C.slate} />
                  <Text style={styles.kpiFechaChipText}>{formatFecha(datos.fechaComparativa)}</Text>
                </View>
              ) : null}
            </View>
            <View style={[styles.kpiCard, styles.kpiCardDesvio, shouldStackPanels && styles.kpiCardStack]}>
              <Text style={styles.kpiLabel}>Desvío</Text>
              <Text style={[styles.kpiValorDesvio, { color: colorDelta(kpiVar) }]}>
                {kpiVar == null ? '—' : formatPctSigned(kpiVar)}
              </Text>
              {kpiDelta != null ? (
                <Text style={[styles.kpiDeltaEur, { color: colorDelta(kpiDelta) }]}>
                  {formatMonedaSigned(kpiDelta)}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}

        <Seccion titulo="Facturación por local" icono="payments">
          {isCompact ? (
            <View style={styles.localCards}>
              {factLocales.map((l) => {
                const varc = cellVariacion(l);
                const softBg = varc.pct == null || Math.abs(varc.pct) < 0.05
                  ? '#fff'
                  : varc.pct > 0
                    ? C.successSoft
                    : C.dangerSoft;
                return (
                  <View key={l.localId} style={[styles.localMiniCard, { backgroundColor: softBg }]}>
                    <Text style={styles.localMiniNombre} numberOfLines={1}>{l.nombre}</Text>
                    <View style={styles.localMiniRight}>
                      <Text style={styles.localMiniReal}>
                        {l.sinDatos ? '—' : formatMoneda(l.real)}
                      </Text>
                      <VariacionBadge pct={varc.pct} text={varc.text} />
                    </View>
                  </View>
                );
              })}
              {factTotal ? (() => {
                const varc = cellVariacion({
                  localId: '_total',
                  nombre: 'Total grupo',
                  real: Number(factTotal.real) || 0,
                  comparativa: Number(factTotal.comparativa) || 0,
                  delta: factTotal.delta,
                  pctVsComp: factTotal.pctVsComp,
                  diferenciaLabel: factTotal.diferenciaLabel,
                  variacionPct: factTotal.variacionPct,
                  variacionPctLabel: factTotal.variacionPctLabel,
                });
                return (
                  <View style={[styles.localMiniCard, styles.localMiniTotal]}>
                    <Text style={[styles.localMiniNombre, styles.tdStrong]}>Total grupo</Text>
                    <View style={styles.localMiniRight}>
                      <Text style={[styles.localMiniReal, styles.tdStrong]}>{formatMoneda(factTotal.real)}</Text>
                      <VariacionBadge pct={varc.pct} text={varc.text} />
                    </View>
                  </View>
                );
              })() : null}
              {factLocales.length === 0 ? (
                <EmptyState texto="Sin datos de facturación para este día" />
              ) : null}
            </View>
          ) : (
            <View style={styles.table}>
              <View style={[styles.tr, styles.trHead]}>
                <Text style={[styles.th, styles.colLocal]}>Local</Text>
                <Text style={[styles.th, styles.colNum]}>Real</Text>
                <Text style={[styles.th, styles.colNum]}>Comparable</Text>
                <Text style={[styles.th, styles.colDiff]}>Diferencia</Text>
                <Text style={[styles.th, styles.colPct]}>% vs comparable</Text>
              </View>
              {factLocales.map((l) => {
                const dif = cellDiferencia(l);
                const varc = cellVariacion(l);
                const rowBg = varc.pct == null || Math.abs(varc.pct) < 0.05
                  ? undefined
                  : varc.pct > 0
                    ? C.successSoft
                    : C.dangerSoft;
                return (
                  <View key={l.localId} style={[styles.tr, rowBg ? { backgroundColor: rowBg, borderRadius: 6, paddingHorizontal: 4 } : null]}>
                    <Text style={[styles.td, styles.colLocal]} numberOfLines={1}>{l.nombre}</Text>
                    <Text style={[styles.td, styles.colNum]}>{l.sinDatos ? '—' : formatMoneda(l.real)}</Text>
                    <Text style={[styles.td, styles.colNum]}>{l.sinDatos ? '—' : formatMoneda(l.comparativa)}</Text>
                    <Text style={[styles.td, styles.colDiff, { color: dif.color }]} numberOfLines={2}>{dif.text}</Text>
                    <View style={[styles.colPct, styles.badgeCell]}>
                      <VariacionBadge pct={varc.pct} text={varc.text} />
                    </View>
                  </View>
                );
              })}
              {factTotal ? (() => {
                const dif = cellDiferencia({
                  localId: '_total',
                  nombre: 'Total grupo',
                  real: Number(factTotal.real) || 0,
                  comparativa: Number(factTotal.comparativa) || 0,
                  delta: factTotal.delta,
                  pctVsComp: factTotal.pctVsComp,
                  diferenciaLabel: factTotal.diferenciaLabel,
                  variacionPct: factTotal.variacionPct,
                  variacionPctLabel: factTotal.variacionPctLabel,
                });
                const varc = cellVariacion({
                  localId: '_total',
                  nombre: 'Total grupo',
                  real: Number(factTotal.real) || 0,
                  comparativa: Number(factTotal.comparativa) || 0,
                  delta: factTotal.delta,
                  pctVsComp: factTotal.pctVsComp,
                  diferenciaLabel: factTotal.diferenciaLabel,
                  variacionPct: factTotal.variacionPct,
                  variacionPctLabel: factTotal.variacionPctLabel,
                });
                return (
                  <View style={[styles.tr, styles.trTotal]}>
                    <Text style={[styles.td, styles.colLocal, styles.tdStrong]}>Total grupo</Text>
                    <Text style={[styles.td, styles.colNum, styles.tdStrong]}>{formatMoneda(factTotal.real)}</Text>
                    <Text style={[styles.td, styles.colNum, styles.tdStrong]}>{formatMoneda(factTotal.comparativa)}</Text>
                    <Text style={[styles.td, styles.colDiff, styles.tdStrong, { color: dif.color }]} numberOfLines={2}>{dif.text}</Text>
                    <View style={[styles.colPct, styles.badgeCell]}>
                      <VariacionBadge pct={varc.pct} text={varc.text} />
                    </View>
                  </View>
                );
              })() : null}
              {factLocales.length === 0 ? (
                <EmptyState texto="Sin datos de facturación para este día" />
              ) : null}
            </View>
          )}
        </Seccion>
      </View>

      {/* Objetivos grupo (solo KPI/barra) */}
      <Seccion titulo={tituloObj} icono="flag" pdfSection="objetivos-grupo">
        {objTotal && (objTotal.pctConsecucion != null || desvGrupo != null) ? (
          <View style={styles.grupoPctBox}>
            <View style={styles.grupoPctHead}>
              <Text style={styles.grupoPctLabel}>Grupo</Text>
              <View style={[styles.desvBadge, { backgroundColor: desvGrupo == null || Math.abs(desvGrupo) < 0.5 ? C.skyBg : desvGrupo > 0 ? C.successBg : C.dangerBg }]}>
                <Text style={[styles.desvBadgeText, { color: colorDelta(desvGrupo) }]}>
                  {labelDesviacion(objTotal)}
                </Text>
              </View>
            </View>
            <Text style={styles.grupoImportes}>
              {labelReal(objTotal)} · {labelObjetivo(objTotal)}
            </Text>
            {objTotal.pctConsecucion != null ? (
              <View style={styles.barraTrackLg}>
                <View
                  style={[
                    styles.barraFill,
                    {
                      width: `${Math.min(100, Math.max(0, objTotal.pctConsecucion))}%`,
                      backgroundColor: colorBarraDesv(desvGrupo),
                    },
                  ]}
                />
              </View>
            ) : null}
            {objTotal.pctConsecucion != null ? (
              <Text style={[styles.grupoPctNum, { color: colorPct(objTotal.pctConsecucion) }]}>
                {formatPct(objTotal.pctConsecucion)} consecución
              </Text>
            ) : null}
          </View>
        ) : (
          <EmptyState texto="Sin datos de consecución de grupo" />
        )}
      </Seccion>

      {/* Objetivos: peores / locales (chunk) / agrupaciones — secciones PDF separadas */}
      {peores.length > 0 ? (
        <Seccion titulo="Peores por caída vs objetivo" icono="warning" pdfSection="objetivos-peores">
          <View style={styles.peoresChips}>
            {peores.map((l) => (
              <View key={`peor-${l.localId}`} style={styles.peorChip}>
                <MaterialIcons name="warning" size={14} color={C.danger} />
                <Text style={styles.peorNombre} numberOfLines={1}>{l.nombre}</Text>
                <Text style={styles.peorPct}>{labelDesviacion(l)}</Text>
              </View>
            ))}
          </View>
        </Seccion>
      ) : null}

      {chunkArray(objLocales, PDF_CHUNK_LOCALES).map((chunk, idx) => (
        <Seccion
          key={`obj-loc-${idx}`}
          titulo={idx === 0 ? 'Objetivos por local' : 'Objetivos por local (cont.)'}
          icono="storefront"
          pdfSection={`objetivos-locales-${idx + 1}`}
        >
          {chunk.length === 0 ? (
            <EmptyState texto="Sin objetivos por local en este informe" />
          ) : (
            <View style={[styles.objGrid, shouldStackPanels && styles.objGridStack]}>
              {chunk.map((l) => {
                const pct = l.pctConsecucion;
                const desv = desviacionDe(l);
                const w = pct == null ? 0 : Math.min(100, Math.max(0, pct));
                return (
                  <View key={l.localId} style={[styles.objCard, { width: cardWidth }]}>
                    <View style={styles.objCardHead}>
                      <Text style={styles.objNombre} numberOfLines={1}>{l.nombre}</Text>
                      <View style={[styles.desvBadgeSm, { backgroundColor: desv == null || Math.abs(desv) < 0.5 ? C.skyBg : desv > 0 ? C.successBg : C.dangerBg }]}>
                        <Text style={[styles.desvBadgeTextSm, { color: colorDelta(desv) }]}>
                          {l.sinDatos ? '—' : formatPctSigned(desv)}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.objImportes} numberOfLines={2}>
                      {labelReal(l)} · {labelObjetivo(l)}
                    </Text>
                    <View style={styles.barraTrack}>
                      <View style={[styles.barraFill, { width: `${w}%`, backgroundColor: colorBarraDesv(desv) }]} />
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </Seccion>
      ))}

      {agrupaciones.length > 0 ? (
        <Seccion titulo="Agrupaciones" icono="layers" pdfSection="objetivos-agrupaciones">
          <View style={[styles.agrupGrid, shouldStackPanels && styles.objGridStack]}>
            {agrupaciones.map((ag) => {
              const desv = ag.pctDesviacion != null
                ? Number(ag.pctDesviacion)
                : ag.pctConsecucion != null
                  ? Number(ag.pctConsecucion) - 100
                  : null;
              const pct = ag.pctConsecucion;
              const w = pct == null ? 0 : Math.min(100, Math.max(0, pct));
              return (
                <View
                  key={ag.id || ag.nombre}
                  style={[styles.agrupCard, { width: cardWidth }]}
                >
                  <View style={styles.objCardHead}>
                    <Text style={styles.agrupNombre} numberOfLines={1}>{ag.nombre || '—'}</Text>
                    <View style={[styles.desvBadgeSm, { backgroundColor: desv == null || Math.abs(desv) < 0.5 ? C.skyBg : desv > 0 ? C.successBg : C.dangerBg }]}>
                      <Text style={[styles.desvBadgeTextSm, { color: colorDelta(desv) }]}>
                        {ag.pctDesviacionLabel || (desv == null ? '—' : formatPctSigned(desv))}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.agrupImportes} numberOfLines={2}>
                    {labelReal(ag)} · {labelObjetivo(ag)}
                  </Text>
                  <View style={styles.barraTrack}>
                    <View style={[styles.barraFill, { width: `${w}%`, backgroundColor: colorBarraDesv(desv) }]} />
                  </View>
                  {ag.localesIncluidos != null ? (
                    <Text style={styles.agrupMeta}>
                      {ag.localesIncluidos} local{ag.localesIncluidos === 1 ? '' : 'es'}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        </Seccion>
      ) : null}

      {/* Ratios (chunk si hay muchos locales) */}
      {ratios.length === 0 ? (
        <Seccion titulo="Ratios por local" icono="pie-chart" pdfSection="ratios-1">
          <EmptyState texto="Sin ratios calculados para este día" />
        </Seccion>
      ) : (
        chunkArray(ratios, PDF_CHUNK_RATIOS).map((chunk, idx) => (
          <Seccion
            key={`ratios-${idx}`}
            titulo={idx === 0 ? 'Ratios por local' : 'Ratios por local (cont.)'}
            icono="pie-chart"
            pdfSection={`ratios-${idx + 1}`}
          >
            <View style={styles.table}>
              <View style={[styles.tr, styles.trHead]}>
                <Text style={[styles.th, styles.colLocal]}>Local</Text>
                <View style={[styles.colRatio, styles.thIconCol]}>
                  <MaterialIcons name="people" size={13} color={C.slate} />
                  {!isCompact ? <Text style={styles.th}>Personal</Text> : null}
                </View>
                <View style={[styles.colRatio, styles.thIconCol]}>
                  <MaterialIcons name="inventory" size={13} color={C.slate} />
                  {!isCompact ? <Text style={styles.th}>Mercadería</Text> : null}
                </View>
                <View style={[styles.colRatio, styles.thIconCol]}>
                  <MaterialIcons name="music-note" size={13} color={C.slate} />
                  {!isCompact ? <Text style={styles.th}>Músicos</Text> : null}
                </View>
              </View>
              {chunk.map((r) => (
                <View key={r.localId} style={styles.ratioBlock}>
                  <View style={styles.tr}>
                    <Text style={[styles.td, styles.colLocal]} numberOfLines={1}>{r.nombre}</Text>
                    <View style={[styles.colRatio, styles.badgeCell]}>
                      <RatioBadge value={r.ratioPersonal} sinFacturacion={r.sinFacturacion} />
                    </View>
                    <View style={[styles.colRatio, styles.badgeCell]}>
                      <RatioBadge value={r.ratioMercaderia} sinFacturacion={r.sinFacturacion} />
                    </View>
                    <View style={[styles.colRatio, styles.badgeCell]}>
                      <RatioBadge value={r.ratioMusicos} sinFacturacion={r.sinFacturacion} />
                    </View>
                  </View>
                  {mostrarGastosRatio ? (
                    <Text style={styles.ratioGastos} numberOfLines={2}>
                      {[
                        r.gastoPersonal != null ? `Pers. ${formatMoneda(r.gastoPersonal)}` : null,
                        r.gastoMercaderia != null ? `Merc. ${formatMoneda(r.gastoMercaderia)}` : null,
                        r.gastoMusicos != null ? `Mús. ${formatMoneda(r.gastoMusicos)}` : null,
                      ].filter(Boolean).join(' · ')}
                    </Text>
                  ) : null}
                  {(r.avisos || []).map((a, aIdx) => (
                    <Text key={`${r.localId}-av-${aIdx}`} style={styles.avisoRatio}>{a}</Text>
                  ))}
                </View>
              ))}
            </View>
          </Seccion>
        ))
      )}

      {/* Ventas por hora: PDF = tablas por bloque de horas; web = chips + gráfica */}
      {modoPdf ? (
        <SeccionesVentasHoraPdf
          grupo={datos.ventasHoraComparativa?.grupo}
          locales={localesVentas}
        />
      ) : (
        <Seccion titulo="Ventas por hora (real vs comparativa)" icono="schedule" pdfSection="ventas-hora">
          {localesVentas.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsScroll}>
              <TouchableOpacity
                style={[styles.chip, !localSel && styles.chipActivo]}
                onPress={() => setLocalSel('')}
              >
                <Text style={[styles.chipText, !localSel && styles.chipTextActivo]}>Grupo</Text>
              </TouchableOpacity>
              {localesVentas.map((l) => (
                <TouchableOpacity
                  key={l.localId}
                  style={[styles.chip, localSel === l.localId && styles.chipActivo]}
                  onPress={() => setLocalSel(l.localId)}
                >
                  <Text style={[styles.chipText, localSel === l.localId && styles.chipTextActivo]} numberOfLines={1}>
                    {l.nombre}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}
          {porHora.length > 0 ? (
            <View style={styles.chartCard}>
              {(() => {
                const hp = horaPuntaDe(porHora);
                return hp ? (
                  <View style={styles.horaPuntaChip}>
                    <MaterialIcons name="whatshot" size={14} color="#c2410c" />
                    <Text style={styles.horaPuntaText}>
                      Hora punta: {String(hp.hora).padStart(2, '0')}:00 · {formatMoneda(hp.real)}
                    </Text>
                  </View>
                ) : null;
              })()}
              <GraficaDualHora porHora={porHora} compact={isCompact} />
            </View>
          ) : (
            <EmptyState texto="Sin serie horaria para este periodo" />
          )}
        </Seccion>
      )}

      {/* Invitaciones */}
      {invitaciones.length === 0 ? (
        <Seccion titulo="Invitaciones" icono="card-giftcard" pdfSection="invitaciones-1">
          {excepciones?.error ? (
            <Text style={styles.avisoErr}>{excepciones.error}</Text>
          ) : null}
          <View style={styles.excBadgesRow}>
            <View style={[styles.excBadge, { backgroundColor: C.successBg }]}>
              <MaterialIcons name="card-giftcard" size={13} color="#047857" />
              <Text style={[styles.excBadgeText, { color: '#047857' }]}>
                {invCount} invitación{invCount === 1 ? '' : 'es'}
              </Text>
            </View>
            {invImporte != null ? (
              <View style={[styles.excBadge, { backgroundColor: C.skyBg }]}>
                <Text style={[styles.excBadgeText, { color: '#0369a1' }]}>{formatMoneda(invImporte)}</Text>
              </View>
            ) : null}
          </View>
          <EmptyState texto="Sin invitaciones relevantes (>2 €) en el día" />
        </Seccion>
      ) : (
        chunkArray(invitaciones, PDF_CHUNK_EXC).map((chunk, idx) => (
          <Seccion
            key={`inv-${idx}`}
            titulo={idx === 0 ? 'Invitaciones' : 'Invitaciones (cont.)'}
            icono="card-giftcard"
            pdfSection={`invitaciones-${idx + 1}`}
          >
            {idx === 0 && excepciones?.error ? (
              <Text style={styles.avisoErr}>{excepciones.error}</Text>
            ) : null}
            {idx === 0 ? (
              <View style={styles.excBadgesRow}>
                <View style={[styles.excBadge, { backgroundColor: C.successBg }]}>
                  <MaterialIcons name="card-giftcard" size={13} color="#047857" />
                  <Text style={[styles.excBadgeText, { color: '#047857' }]}>
                    {invCount} invitación{invCount === 1 ? '' : 'es'}
                  </Text>
                </View>
                {invImporte != null ? (
                  <View style={[styles.excBadge, { backgroundColor: C.skyBg }]}>
                    <Text style={[styles.excBadgeText, { color: '#0369a1' }]}>{formatMoneda(invImporte)}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            <TablaExcepciones items={chunk} isCompact={isCompact} />
          </Seccion>
        ))
      )}

      {/* Descuentos */}
      {descuentos.length === 0 ? (
        <Seccion titulo="Descuentos" icono="percent" pdfSection="descuentos-1">
          {excepciones?.error ? (
            <Text style={styles.avisoErr}>{excepciones.error}</Text>
          ) : null}
          <View style={styles.excBadgesRow}>
            <View style={[styles.excBadge, { backgroundColor: C.amberBg }]}>
              <MaterialIcons name="percent" size={13} color={C.amberFg} />
              <Text style={[styles.excBadgeText, { color: C.amberFg }]}>
                {desCount} descuento{desCount === 1 ? '' : 's'}
              </Text>
            </View>
            {desImporte != null ? (
              <View style={[styles.excBadge, { backgroundColor: C.skyBg }]}>
                <Text style={[styles.excBadgeText, { color: '#0369a1' }]}>{formatMoneda(desImporte)}</Text>
              </View>
            ) : null}
          </View>
          <EmptyState texto="Sin descuentos relevantes (>2 €) en el día" />
        </Seccion>
      ) : (
        chunkArray(descuentos, PDF_CHUNK_EXC).map((chunk, idx) => (
          <Seccion
            key={`des-${idx}`}
            titulo={idx === 0 ? 'Descuentos' : 'Descuentos (cont.)'}
            icono="percent"
            pdfSection={`descuentos-${idx + 1}`}
          >
            {idx === 0 && excepciones?.error ? (
              <Text style={styles.avisoErr}>{excepciones.error}</Text>
            ) : null}
            {idx === 0 ? (
              <View style={styles.excBadgesRow}>
                <View style={[styles.excBadge, { backgroundColor: C.amberBg }]}>
                  <MaterialIcons name="percent" size={13} color={C.amberFg} />
                  <Text style={[styles.excBadgeText, { color: C.amberFg }]}>
                    {desCount} descuento{desCount === 1 ? '' : 's'}
                  </Text>
                </View>
                {desImporte != null ? (
                  <View style={[styles.excBadge, { backgroundColor: C.skyBg }]}>
                    <Text style={[styles.excBadgeText, { color: '#0369a1' }]}>{formatMoneda(desImporte)}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            <TablaExcepciones items={chunk} isCompact={isCompact} />
          </Seccion>
        ))
      )}

      {/* Top ventas */}
      {topLocales.length === 0 ? (
        <Seccion titulo="Top 3 ventas por local" icono="emoji-events" pdfSection="top-ventas-1">
          <EmptyState texto="Sin ranking de ventas por local" />
        </Seccion>
      ) : (
        chunkArray(topLocales, PDF_CHUNK_TOP).map((chunk, idx) => (
          <Seccion
            key={`top-${idx}`}
            titulo={idx === 0 ? 'Top 3 ventas por local' : 'Top 3 ventas por local (cont.)'}
            icono="emoji-events"
            pdfSection={`top-ventas-${idx + 1}`}
          >
            <View style={[styles.topGrid, shouldStackPanels && styles.objGridStack]}>
              {chunk.map((loc) => (
                <View key={loc.localId} style={[styles.topCard, { width: cardWidth }]}>
                  <Text style={styles.topLocalNombre} numberOfLines={1}>{loc.nombre}</Text>
                  {loc.sinDatos || !(loc.top || []).length ? (
                    <Text style={styles.vacio}>Sin ventas destacadas</Text>
                  ) : (
                    (loc.top || []).slice(0, 3).map((t, tIdx) => (
                      <View key={`${loc.localId}-${t.userId || tIdx}`} style={styles.topRow}>
                        <Text style={styles.topRank}>{t.rank ?? tIdx + 1}.</Text>
                        <Text style={styles.topName} numberOfLines={1}>{t.userName || '—'}</Text>
                        <Text style={styles.topAmount}>{formatMoneda(t.amount)}</Text>
                      </View>
                    ))
                  )}
                </View>
              ))}
            </View>
          </Seccion>
        ))
      )}

      {/* Mantenimiento: resumen + partes chunk + limpiezas chunk */}
      <Seccion titulo="Mantenimiento del día" icono="build" pdfSection="mantenimiento-resumen">
        <View style={styles.excBadgesRow}>
          <View style={[styles.excBadge, { backgroundColor: C.skyBg }]}>
            <MaterialIcons name="handyman" size={13} color="#0369a1" />
            <Text style={[styles.excBadgeText, { color: '#0369a1' }]}>
              {mantResumen?.incidencias ?? mantPartes.length} parte{(mantResumen?.incidencias ?? mantPartes.length) === 1 ? '' : 's'}
            </Text>
          </View>
          <View style={[styles.excBadge, { backgroundColor: '#ede9fe' }]}>
            <MaterialIcons name="replay" size={13} color="#6d28d9" />
            <Text style={[styles.excBadgeText, { color: '#6d28d9' }]}>
              {mantResumen?.recurrentes ?? 0} rec.
            </Text>
          </View>
          <View style={[styles.excBadge, { backgroundColor: C.successBg }]}>
            <MaterialIcons name="cleaning-services" size={13} color="#047857" />
            <Text style={[styles.excBadgeText, { color: '#047857' }]}>
              {mantResumen?.limpiezas ?? mantLimpiezas.length} limpiezas
            </Text>
          </View>
          <View style={[styles.excBadge, { backgroundColor: C.warningBg }]}>
            <MaterialIcons name="star-rate" size={13} color={C.warning} />
            <Text style={[styles.excBadgeText, { color: C.warning }]}>
              {mantResumen?.valoradas ?? 0} valoradas
            </Text>
          </View>
        </View>
      </Seccion>

      {mantPartes.length === 0 ? (
        <Seccion titulo="Partes completados" icono="handyman" pdfSection="mantenimiento-partes-1">
          <EmptyState texto="Ningún parte completado en el día" />
        </Seccion>
      ) : (
        chunkArray(mantPartes, PDF_CHUNK_MANT).map((chunk, idx) => (
          <Seccion
            key={`mant-p-${idx}`}
            titulo={idx === 0 ? 'Partes completados' : 'Partes completados (cont.)'}
            icono="handyman"
            pdfSection={`mantenimiento-partes-${idx + 1}`}
          >
            <View style={styles.mantList}>
              {chunk.map((p, pIdx) => (
                <View key={p.id || `parte-${idx}-${pIdx}`} style={styles.mantRow}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.mantTitulo} numberOfLines={2}>{p.titulo || '—'}</Text>
                    <Text style={styles.mantMeta} numberOfLines={1}>
                      {[p.localNombre, p.origen === 'recurrente' ? 'Recurrente' : 'Incidencia', p.categoria]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  {p.valoracionTotal != null ? (
                    <View style={[styles.excBadge, { backgroundColor: C.warningBg }]}>
                      <Text style={[styles.excBadgeText, { color: C.warning }]}>
                        {Number(p.valoracionTotal).toLocaleString('es-ES', { maximumFractionDigits: 1 })}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          </Seccion>
        ))
      )}

      {mantLimpiezas.length === 0 ? (
        <Seccion titulo="Limpiezas hechas" icono="cleaning-services" pdfSection="mantenimiento-limpiezas-1">
          <EmptyState texto="Ninguna limpieza registrada en el día" />
        </Seccion>
      ) : (
        chunkArray(mantLimpiezas, PDF_CHUNK_MANT).map((chunk, idx) => (
          <Seccion
            key={`mant-l-${idx}`}
            titulo={idx === 0 ? 'Limpiezas hechas' : 'Limpiezas hechas (cont.)'}
            icono="cleaning-services"
            pdfSection={`mantenimiento-limpiezas-${idx + 1}`}
          >
            <View style={styles.mantList}>
              {chunk.map((l, lIdx) => (
                <View key={l.id || `limp-${idx}-${lIdx}`} style={styles.mantRow}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.mantTitulo} numberOfLines={2}>
                      {l.objetoNombre || l.tareaNombre || 'Limpieza'}
                    </Text>
                    <Text style={styles.mantMeta} numberOfLines={1}>
                      {[l.localNombre, l.ubicacion, l.realizadoPorNombre]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </Seccion>
        ))
      )}
    </View>
  );
}

const shadowSoft =
  Platform.OS === 'web'
    ? ({ boxShadow: '0 2px 10px rgba(15, 23, 42, 0.06)' } as const)
    : ({ elevation: 2 } as const);

const styles = StyleSheet.create({
  wrap: { gap: 18, marginBottom: 12 },
  pdfBlock: { gap: 18 },
  emptyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  emptyText: { fontSize: 12, color: C.muted, fontStyle: 'italic', flex: 1 },
  cabecera: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: C.skySoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.borderSky,
    padding: 14,
  },
  cabeceraIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: C.skyBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cabeceraTituloRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  cabeceraTitulo: { fontSize: 15, fontWeight: '800', color: '#0c4a6e' },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  statusBadgeText: { fontSize: 11, fontWeight: '700' },
  cabeceraChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: C.borderSky,
  },
  metaChipComp: { borderColor: C.border, backgroundColor: '#f8fafc', maxWidth: '100%' },
  metaChipText: { fontSize: 12, fontWeight: '700', color: '#0369a1' },
  metaChipTextComp: { fontSize: 12, fontWeight: '600', color: C.textSec, flexShrink: 1 },

  kpiRow: { flexDirection: 'row', gap: 12 },
  kpiRowStack: { flexDirection: 'column' },
  kpiCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.borderSky,
    padding: 14,
    gap: 4,
    minWidth: 0,
    ...(shadowSoft as object),
  },
  kpiCardStack: { width: '100%', flex: undefined },
  kpiCardDesvio: { borderColor: '#cbd5e1', backgroundColor: '#f8fafc' },
  kpiLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: C.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  kpiValorGrande: { fontSize: 28, fontWeight: '800', color: C.text, marginTop: 2 },
  kpiValorSec: { fontSize: 24, fontWeight: '700', color: C.textSec, marginTop: 2 },
  kpiValorDesvio: { fontSize: 28, fontWeight: '800', marginTop: 2 },
  kpiDeltaEur: { fontSize: 13, fontWeight: '700', marginTop: 2 },
  kpiFechaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: '#f1f5f9',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 4,
  },
  kpiFechaChipText: { fontSize: 11, fontWeight: '600', color: C.slate },

  seccion: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    gap: 4,
  },
  seccionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  seccionIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: C.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seccionTitulo: { fontSize: 13, fontWeight: '700', color: '#334155', flex: 1 },
  subSecTitulo: {
    fontSize: 11,
    fontWeight: '700',
    color: C.slate,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 14,
    letterSpacing: 0.3,
  },

  table: { gap: 0 },
  tr: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
    gap: 4,
  },
  trHead: { borderBottomWidth: 1, borderBottomColor: '#cbd5e1', paddingBottom: 8 },
  trTotal: {
    backgroundColor: C.skySoft,
    marginTop: 4,
    borderBottomWidth: 0,
    borderRadius: 8,
    paddingHorizontal: 6,
  },
  trExc: { alignItems: 'flex-start', paddingVertical: 9 },
  th: { fontSize: 10, fontWeight: '700', color: C.slate, textTransform: 'uppercase' },
  td: { fontSize: 12, color: '#334155' },
  tdStrong: { fontWeight: '700', color: C.text },
  colLocal: { flex: 1.4, minWidth: 72 },
  colLocalSm: { flex: 1, minWidth: 56 },
  colNum: { flex: 1, textAlign: 'right', minWidth: 56 },
  colDiff: { flex: 1.1, textAlign: 'right', minWidth: 64 },
  colPct: { flex: 1.1, minWidth: 72 },
  colRatio: { flex: 1, minWidth: 56 },
  colNombre: { flex: 1.3, minWidth: 80 },
  colTipo: { flex: 0.9, minWidth: 72 },
  colProducto: { flex: 1.2, minWidth: 64 },
  badgeCell: { alignItems: 'flex-end', justifyContent: 'center' },
  thIconCol: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3 },

  varBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    maxWidth: '100%',
  },
  varBadgeText: { fontSize: 11, fontWeight: '700' },

  localCards: { gap: 8 },
  localMiniCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  localMiniTotal: { backgroundColor: C.skySoft, borderColor: C.borderSky },
  localMiniNombre: { flex: 1, fontSize: 13, fontWeight: '600', color: '#334155' },
  localMiniRight: { alignItems: 'flex-end', gap: 4 },
  localMiniReal: { fontSize: 14, fontWeight: '700', color: C.text },

  vacio: { fontSize: 12, color: C.muted, fontStyle: 'italic', marginTop: 4 },

  grupoPctBox: {
    marginBottom: 12,
    backgroundColor: C.skySoft,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.borderSky,
    padding: 12,
    gap: 4,
  },
  grupoPctHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  grupoPctLabel: { fontSize: 11, color: C.slate, fontWeight: '700', textTransform: 'uppercase' },
  grupoImportes: { fontSize: 12, color: C.textSec, fontWeight: '600' },
  grupoPctNum: { fontSize: 12, fontWeight: '700', marginTop: 2 },
  barraTrack: {
    height: 8,
    backgroundColor: '#e2e8f0',
    borderRadius: 4,
    overflow: 'hidden',
    marginTop: 6,
  },
  barraTrackLg: {
    height: 12,
    backgroundColor: '#e2e8f0',
    borderRadius: 6,
    overflow: 'hidden',
    marginTop: 8,
  },
  barraFill: { height: '100%', borderRadius: 4 },

  desvBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  desvBadgeText: { fontSize: 12, fontWeight: '800' },
  desvBadgeSm: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  desvBadgeTextSm: { fontSize: 11, fontWeight: '800' },

  objGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  objGridStack: { flexDirection: 'column' },
  objCard: {
    flexGrow: 1,
    minWidth: 140,
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  objCardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  objNombre: { flex: 1, fontSize: 12, fontWeight: '600', color: '#334155' },
  objImportes: { fontSize: 11, color: C.slate, marginBottom: 2 },

  peoresBox: { marginBottom: 4 },
  peoresChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  peorChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: C.dangerSoft,
    borderWidth: 1,
    borderColor: C.dangerBg,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxWidth: '100%',
  },
  peorNombre: { fontSize: 12, fontWeight: '600', color: '#334155', maxWidth: 140 },
  peorPct: { fontSize: 12, fontWeight: '800', color: C.danger },

  agrupWrap: { marginTop: 4 },
  agrupGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  agrupCard: {
    flexGrow: 1,
    minWidth: 140,
    backgroundColor: '#dbeafe',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#93c5fd',
  },
  agrupNombre: { flex: 1, fontSize: 13, fontWeight: '700', color: '#1e3a8a' },
  agrupImportes: { fontSize: 11, color: '#1e40af', fontWeight: '600', marginBottom: 2 },
  agrupMeta: { fontSize: 10, color: C.slate, marginTop: 6 },

  ratioBlock: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
    paddingBottom: 4,
  },
  ratioBadge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    minWidth: 52,
    alignItems: 'center',
  },
  ratioBadgeText: { fontSize: 11, fontWeight: '700' },
  ratioGastos: { fontSize: 10, color: C.muted, textAlign: 'right', paddingBottom: 2 },
  avisoRatio: { fontSize: 11, color: '#b45309', marginTop: 2, marginBottom: 2 },

  chipsScroll: { marginBottom: 10, maxHeight: 40 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: C.border,
    marginRight: 6,
  },
  chipActivo: { backgroundColor: C.skyBg, borderColor: '#7dd3fc' },
  chipText: { fontSize: 12, color: C.slate, fontWeight: '600' },
  chipTextActivo: { color: '#0369a1' },

  chartCard: {
    backgroundColor: '#fafbfc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
    gap: 10,
    ...(shadowSoft as object),
  },
  horaPuntaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: C.amberBg,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  horaPuntaText: { fontSize: 12, fontWeight: '700', color: C.amberFg },

  leyendaRow: { flexDirection: 'row', gap: 14, marginBottom: 8 },
  leyendaItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  leyendaDot: { width: 10, height: 10, borderRadius: 2 },
  leyendaText: { fontSize: 11, color: C.slate },
  chartBars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, paddingBottom: 2 },
  chartCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', minWidth: 14 },
  chartPair: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
    height: '100%',
    justifyContent: 'center',
  },
  bar: { width: 5, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  chartLabel: { fontSize: 9, color: C.muted, marginTop: 2 },

  vhPdfWrap: { gap: 10 },
  vhPdfLeyenda: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    marginBottom: 2,
  },
  vhPdfLeyendaText: { fontSize: 9, color: C.slate, fontWeight: '600' },
  vhPdfLeyendaHint: { fontSize: 9, color: C.muted, fontStyle: 'italic' },
  vhPdfTable: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    overflow: 'hidden',
  },
  vhPdfTr: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  vhPdfTrHead: {
    backgroundColor: '#f1f5f9',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
  },
  vhPdfTh: {
    fontSize: 8,
    fontWeight: '700',
    color: C.slate,
    textAlign: 'center',
    paddingVertical: 4,
    paddingHorizontal: 1,
  },
  vhPdfColLabel: {
    width: 72,
    minWidth: 72,
    maxWidth: 72,
    paddingLeft: 4,
    textAlign: 'left',
  },
  vhPdfColHora: { flex: 1, minWidth: 28 },
  vhPdfColTotal: {
    width: 44,
    minWidth: 44,
    maxWidth: 48,
    fontWeight: '800',
  },
  vhPdfTdLabel: {
    fontSize: 8,
    fontWeight: '600',
    color: '#334155',
    paddingVertical: 3,
    paddingHorizontal: 2,
    paddingLeft: 4,
    alignSelf: 'center',
  },
  vhPdfTdLabelGrupo: { fontWeight: '800', color: C.text },
  vhPdfCell: {
    flex: 1,
    minWidth: 28,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 3,
    paddingHorizontal: 1,
  },
  vhPdfCellTotal: {
    flex: 0,
    width: 44,
    minWidth: 44,
    maxWidth: 48,
  },
  vhPdfCellText: { fontSize: 8, fontWeight: '600', textAlign: 'center' },
  vhPdfCellTextTotal: { fontWeight: '800' },

  excBadgesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  excBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  excBadgeText: { fontSize: 12, fontWeight: '700' },
  quienCell: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  avatarCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: C.skyBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 11, fontWeight: '800', color: '#0369a1' },
  quienNombre: { flex: 1, fontSize: 12, color: '#334155' },
  tipoWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingTop: 2 },
  tipoChip: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  tipoText: { fontSize: 10, fontWeight: '700' },
  importeBold: { fontWeight: '800', color: C.text },
  avisoErr: { fontSize: 12, color: '#b91c1c', marginBottom: 6 },

  topGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  topCard: {
    flexGrow: 1,
    minWidth: 140,
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: C.border,
    gap: 6,
  },
  topLocalNombre: { fontSize: 13, fontWeight: '700', color: '#0c4a6e', marginBottom: 2 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  topRank: { fontSize: 12, fontWeight: '800', color: C.slate, width: 18 },
  topName: { flex: 1, fontSize: 12, color: '#334155', fontWeight: '600' },
  topAmount: { fontSize: 12, fontWeight: '800', color: C.text },

  mantList: { gap: 8, marginBottom: 4 },
  mantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  mantTitulo: { fontSize: 13, fontWeight: '600', color: '#334155' },
  mantMeta: { fontSize: 11, color: C.slate },
});
