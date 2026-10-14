/** Formato mínimo de 6 dígitos para campos id_ (ej: 000001, 000002). */
export function formatId6(val: string | number | undefined | null): string {
  if (val === undefined || val === null) return '000000';
  const n =
    typeof val === 'number' ? val : parseInt(String(val).replace(/^0+/, '') || '0', 10);
  return String(Number.isNaN(n) ? 0 : Math.max(0, n)).padStart(6, '0');
}

/** Mismo id_ con o sin ceros a la izquierda ('45' = '000045'). Vacío nunca coincide. */
export function mismoId6(a: string | number | undefined | null, b: string | number | undefined | null): boolean {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  return /^\d+$/.test(sa) && /^\d+$/.test(sb) && formatId6(sa) === formatId6(sb);
}
