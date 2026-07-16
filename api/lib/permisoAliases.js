/**
 * Alias legacy: permisos antiguos que siguen concediendo el código canónico.
 * Mantener sincronizado con app/lib/permisoAliases.ts
 */
export const PERMISO_ALIASES = {
  'marketing.proponer': ['rrss.ver'],
};

/** Códigos a comprobar en DynamoDB (canónico + alias). */
export function codigosPermisoEfectivos(codigo) {
  const aliases = PERMISO_ALIASES[codigo] ?? [];
  return [codigo, ...aliases];
}
