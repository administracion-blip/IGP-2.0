/**
 * Identificadores del maestro `igp_Locales`.
 *
 * El cálculo vive aquí porque hay dos altas de local: el maestro
 * (`app/(app)/locales.tsx`) y el alta rápida desde Usuarios. El backend rechaza
 * con `409` un `id_Locales` ya usado, así que ninguna de las dos puede enviarlo
 * en blanco.
 */
import { formatId6 } from '../utils/idFormat';

/** Forma mínima de un local: la API mezcla `id_Locales` con variantes en minúsculas. */
export type LocalConId = Record<string, unknown>;

function idLocalNumerico(local: LocalConId): number {
  const clave = Object.keys(local).find((k) => k.toLowerCase() === 'id_locales');
  const valor = clave != null ? local[clave] : undefined;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : 0;
  const n = parseInt(String(valor ?? '').trim().replace(/^0+/, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Próximo `id_Locales` libre: máximo id existente + 1, en formato de 6 dígitos. */
export function calcularProximoIdLocal(locales: LocalConId[]): string {
  if (!locales.length) return formatId6(1);
  return formatId6(Math.max(0, ...locales.map(idLocalNumerico)) + 1);
}
