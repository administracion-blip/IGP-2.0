export type ReporteVenue = {
  name: string;
  facturado: number;
  comparativa: number;
};

export type ReporteZone = {
  name: string;
  venues: ReporteVenue[];
  hasSubtotal: boolean;
  orden: number;
};

export type ReporteTotales = {
  facturado: number;
  comparativa: number;
};

export type ReporteObjetivosData = {
  tituloPeriodo: string;
  kickerMes: string;
  fechaHastaLabel: string;
  generadoLabel: string;
  totales: ReporteTotales;
  zones: ReporteZone[];
};

export function desvioEuro(facturado: number, comparativa: number): number {
  return facturado - comparativa;
}

/** Porcentaje de desvío respecto a comparativa; null si comparativa es 0. */
export function pctDesvio(facturado: number, comparativa: number): number | null {
  if (comparativa === 0) return null;
  return ((facturado - comparativa) / comparativa) * 100;
}

export function formatEuro(n: number): string {
  const rounded = Math.round(n);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded).toLocaleString('es-ES');
  return `${sign}${abs} €`;
}

export function formatPctDisplay(pct: number | null): string {
  if (pct == null || Number.isNaN(pct)) return '—';
  if (pct === 0) return '0,0%';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1).replace('.', ',')}%`;
}

export type DesvioColorKey = 'positive' | 'negative' | 'neutral';

export function desvioColorKey(facturado: number, comparativa: number): DesvioColorKey {
  const d = desvioEuro(facturado, comparativa);
  if (d > 0) return 'positive';
  if (d < 0) return 'negative';
  return 'neutral';
}

export const REPORTE_COLORS = {
  text: '#2a2d33',
  muted: '#64748b',
  accent: '#0ea5e9',
  accentLight: '#e0f2fe',
  accentBorder: '#bae6fd',
  green: '#059669',
  red: '#dc2626',
  grey: '#94a3b8',
  border: '#e2e8f0',
  pageBg: '#eceef2',
  cardBg: '#ffffff',
  kpiBg: '#f8fafc',
  zoneHeaderBg: '#f0f9ff',
} as const;

export function colorHexForKey(key: DesvioColorKey): string {
  if (key === 'positive') return REPORTE_COLORS.green;
  if (key === 'negative') return REPORTE_COLORS.red;
  return REPORTE_COLORS.grey;
}

type ShareLocal = {
  nombre: string;
  sumRealHastaAyer: number;
  sumCompHastaAyer: number;
};

type ShareGrupo = {
  nombre: string;
  orden?: number;
  locales: ShareLocal[];
};

export function buildReporteObjetivosData(opts: {
  tituloPeriodo: string;
  fechaHastaLabel: string;
  generadoLabel: string;
  totales: { sumRealHastaAyer: number; sumCompHastaAyer: number };
  grupos: ShareGrupo[];
  localesSueltos: ShareLocal[];
}): ReporteObjetivosData {
  const toVenue = (loc: ShareLocal): ReporteVenue => ({
    name: loc.nombre.trim() || '—',
    facturado: loc.sumRealHastaAyer,
    comparativa: loc.sumCompHastaAyer,
  });

  const sortVenues = (venues: ReporteVenue[]) =>
    [...venues].sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));

  const zones: ReporteZone[] = [...opts.grupos]
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
    .map((g) => ({
      name: g.nombre.trim() || 'Zona',
      venues: sortVenues(g.locales.map(toVenue)),
      hasSubtotal: true,
      orden: g.orden ?? 0,
    }));

  if (opts.localesSueltos.length > 0) {
    zones.push({
      name: opts.grupos.length === 0 ? 'Todos los locales' : 'Otros locales',
      venues: sortVenues(opts.localesSueltos.map(toVenue)),
      hasSubtotal: opts.grupos.length > 0,
      orden: 9999,
    });
  }

  return {
    tituloPeriodo: opts.tituloPeriodo,
    kickerMes: opts.tituloPeriodo.toUpperCase(),
    fechaHastaLabel: opts.fechaHastaLabel,
    generadoLabel: opts.generadoLabel,
    totales: {
      facturado: opts.totales.sumRealHastaAyer,
      comparativa: opts.totales.sumCompHastaAyer,
    },
    zones,
  };
}

export function subtotalZone(zone: ReporteZone): ReporteTotales {
  return zone.venues.reduce(
    (acc, v) => ({
      facturado: acc.facturado + v.facturado,
      comparativa: acc.comparativa + v.comparativa,
    }),
    { facturado: 0, comparativa: 0 },
  );
}

export const REPORTE_DOC_WIDTH = 900;
