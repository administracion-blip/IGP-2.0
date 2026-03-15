/**
 * Busca el valor de una clave en un objeto ignorando mayúsculas/minúsculas.
 * Útil para datos de DynamoDB donde las claves pueden variar en capitalización.
 */
export function valorEnLocal(
  item: Record<string, unknown>,
  key: string,
): string | number | undefined {
  const v = item[key];
  if (v !== undefined && v !== null) return v as string | number;
  const found = Object.keys(item).find((k) => k.toLowerCase() === key.toLowerCase());
  return found != null ? (item[found] as string | number | undefined) : undefined;
}
