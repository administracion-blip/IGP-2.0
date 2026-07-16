/**
 * Alias legacy: permisos antiguos que siguen concediendo el código canónico.
 * Mantener sincronizado con api/lib/permisoAliases.js
 */
export const PERMISO_ALIASES: Record<string, readonly string[]> = {
  'marketing.proponer': ['rrss.ver'],
};

export function permisoConcedido(permisos: string[], codigo: string): boolean {
  if (permisos.includes(codigo)) return true;
  const aliases = PERMISO_ALIASES[codigo];
  if (!aliases?.length) return false;
  return aliases.some((a) => permisos.includes(a));
}

/** Códigos a comprobar en DynamoDB (canónico + alias). Solo backend. */
export function codigosPermisoEfectivos(codigo: string): string[] {
  const aliases = PERMISO_ALIASES[codigo] ?? [];
  return [codigo, ...aliases];
}
