export const MESES_OBJETIVO = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

export function labelPeriodoMensual(mes: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  if (!m) return mes;
  const y = Number(m[1]);
  const mi = Number(m[2]);
  const nombreMes = MESES_OBJETIVO[mi - 1] ?? m[2];
  return `${nombreMes} ${y} · hasta ayer`;
}

export function labelPeriodoDiario(fecha: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) return fecha;
  return `Ayer · ${m[3]}/${m[2]}/${m[1]}`;
}

export function colorConsecucion(pct: number): string {
  if (pct < 95) return '#dc2626';
  if (pct < 100) return '#d97706';
  return '#059669';
}

export function accentForPct(pct: number | null, sinDatos: boolean): { bg: string; fg: string } {
  if (pct == null || sinDatos) return { bg: '#f1f5f9', fg: '#94a3b8' };
  if (pct < 95) return { bg: '#fee2e2', fg: '#dc2626' };
  if (pct < 100) return { bg: '#ffedd5', fg: '#d97706' };
  return { bg: '#dcfce7', fg: '#059669' };
}

export function formatPctConsecucion(pct: number): string {
  const s = Number.isInteger(pct) ? String(pct) : pct.toFixed(1).replace('.', ',');
  return `${s} %`;
}
