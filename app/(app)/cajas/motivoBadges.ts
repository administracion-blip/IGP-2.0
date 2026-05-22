/**
 * Colores pastel consistentes para badges de motivo (Control de Excepciones).
 * Usado en tabla React Native y en PDF (jsPDF/autoTable).
 */

export type MotivoBadgeStyle = {
  bg: string;
  text: string;
  border: string;
};

/** Motivos canónicos del backend (api/routes/agora.js) */
const KNOWN_MOTIVO_COLORS: Record<string, MotivoBadgeStyle> = {
  invitación: { bg: '#d1fae5', text: '#047857', border: '#6ee7b7' },
  invitacion: { bg: '#d1fae5', text: '#047857', border: '#6ee7b7' },
  'producto cortesía': { bg: '#f3e8ff', text: '#6b21a8', border: '#d8b4fe' },
  'producto cortesia': { bg: '#f3e8ff', text: '#6b21a8', border: '#d8b4fe' },
  'descuento manual': { bg: '#ffedd5', text: '#c2410c', border: '#fdba74' },
  'documento anulado': { bg: '#fee2e2', text: '#b91c1c', border: '#fca5a5' },
  'línea anulada': { bg: '#fce7f3', text: '#be185d', border: '#f9a8d4' },
  'linea anulada': { bg: '#fce7f3', text: '#be185d', border: '#f9a8d4' },
};

/** Paleta pastel para nombres de descuento u otros motivos dinámicos de Ágora */
const MOTIVO_PALETTE: MotivoBadgeStyle[] = [
  { bg: '#ede9fe', text: '#5b21b6', border: '#c4b5fd' },
  { bg: '#e0f2fe', text: '#0369a1', border: '#7dd3fc' },
  { bg: '#ecfccb', text: '#4d7c0f', border: '#bef264' },
  { bg: '#fef9c3', text: '#a16207', border: '#fde047' },
  { bg: '#f3e8ff', text: '#7e22ce', border: '#d8b4fe' },
  { bg: '#cffafe', text: '#0e7490', border: '#67e8f9' },
  { bg: '#ffe4e6', text: '#be123c', border: '#fda4af' },
  { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1' },
];

const DEFAULT_MOTIVO: MotivoBadgeStyle = {
  bg: '#f8fafc',
  text: '#64748b',
  border: '#e2e8f0',
};

function normalizeMotivoKey(reason: string | null | undefined): string {
  return String(reason ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function hashMotivoKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function formatMotivoLabel(
  reason: string | null | undefined,
  discountRate?: number | null,
): string {
  const base = String(reason ?? '').trim() || '—';
  if (discountRate && discountRate > 0) return `${base} (${discountRate}%)`;
  return base;
}

export function getMotivoBadgeStyle(reason: string | null | undefined): MotivoBadgeStyle {
  const key = normalizeMotivoKey(reason);
  if (!key) return DEFAULT_MOTIVO;
  const known = KNOWN_MOTIVO_COLORS[key];
  if (known) return known;
  return MOTIVO_PALETTE[hashMotivoKey(key) % MOTIVO_PALETTE.length];
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  if (h.length !== 6) return [248, 250, 252];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Estilos autoTable para la celda Motivo en PDF */
export function applyMotivoPdfCellStyle(
  cellStyles: Record<string, unknown>,
  reason: string | null | undefined,
): void {
  const badge = getMotivoBadgeStyle(reason);
  cellStyles.fillColor = hexToRgb(badge.bg);
  cellStyles.textColor = hexToRgb(badge.text);
  cellStyles.fontStyle = 'bold';
}
