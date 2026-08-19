/** Unidades canónicas de escandallo. Sin conversiones entre ellas. */
export const UNIDADES_ESCANDALLO = [
  { id: 'KG', titulo: 'Kilogramo' },
  { id: 'L', titulo: 'Litro' },
  { id: 'UD', titulo: 'Unidad' },
] as const;

export type UnidadEscandallo = (typeof UNIDADES_ESCANDALLO)[number]['id'];

const ALIAS: Record<string, UnidadEscandallo> = {
  kg: 'KG',
  kilo: 'KG',
  kilos: 'KG',
  kilogramo: 'KG',
  kilogramos: 'KG',
  'kg.': 'KG',
  l: 'L',
  litro: 'L',
  litros: 'L',
  lt: 'L',
  lts: 'L',
  'l.': 'L',
  ud: 'UD',
  uds: 'UD',
  unidad: 'UD',
  unidades: 'UD',
  uno: 'UD',
  un: 'UD',
};

export function normalizeUnidadEscandallo(raw: string | null | undefined): UnidadEscandallo | '' {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  if (s === 'kg' || s === 'l' || s === 'ud') return s.toUpperCase() as UnidadEscandallo;
  return ALIAS[s] ?? '';
}

export function labelUnidadEscandallo(id: string | null | undefined): string {
  const n = normalizeUnidadEscandallo(id) || String(id ?? '').trim();
  const hit = UNIDADES_ESCANDALLO.find((u) => u.id === n);
  return hit?.titulo ?? (n || '—');
}

/** Compara IDs Ágora/almacén ignorando ceros a la izquierda (`000012` ≈ `12`). */
export function stripLeadingZerosId(id: string | number | null | undefined): string {
  const s = String(id ?? '').trim();
  if (!s) return '';
  const stripped = s.replace(/^0+/, '');
  return stripped || '0';
}

export function idsIgualesNorm(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): boolean {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  return stripLeadingZerosId(sa) === stripLeadingZerosId(sb);
}
