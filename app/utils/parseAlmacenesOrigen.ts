/** Separa una cadena de almacenes separados por coma en un array limpio de strings. */
export function parseAlmacenesOrigen(val: string | number | undefined | null): string[] {
  if (val == null || String(val).trim() === '') return [];
  return String(val)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
