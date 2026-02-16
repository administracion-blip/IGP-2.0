/** Formato mínimo de 6 dígitos para campos id_ (ej: 000001, 000002). */
export function formatId6(val: string | number | undefined | null): string {
  if (val === undefined || val === null) return '000000';
  const n =
    typeof val === 'number' ? val : parseInt(String(val).replace(/^0+/, '') || '0', 10);
  return String(Number.isNaN(n) ? 0 : Math.max(0, n)).padStart(6, '0');
}
