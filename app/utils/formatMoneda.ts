/**
 * Formatea un valor numérico como moneda (EUR) en formato español.
 *
 * @param sinSimbolo  — omite el símbolo € (ej. "1.234,56" en vez de "1.234,56 €")
 * @param ocultarCero — devuelve '—' cuando el valor es exactamente 0
 */
export function formatMoneda(
  val: string | number | undefined | null,
  opciones?: { sinSimbolo?: boolean; ocultarCero?: boolean },
): string {
  if (val == null || val === '—' || String(val).trim() === '') return '—';
  const n =
    typeof val === 'number'
      ? val
      : parseFloat(String(val).replace(',', '.').replace(/\s/g, ''));
  if (Number.isNaN(n)) return String(val);
  if (opciones?.ocultarCero && n === 0) return '—';

  if (opciones?.sinSimbolo) {
    return n.toLocaleString('es-ES', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}
