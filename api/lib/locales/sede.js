/**
 * Predicado de sede del grupo Paripe (locales / facturación / briefing IA).
 * Misma regla que el filtro `?grupoParipe=1` de GET /locales.
 */

/** @param {object} loc — item de igp_Locales */
export function esSedeGrupoParipeLocal(loc) {
  const s = String(loc?.sede ?? loc?.Sede ?? '').toUpperCase();
  return s.includes('PARIPE');
}

/**
 * Sociedad sede del grupo (emisora de refacturaciones). Misma regla que
 * `esEmpresaSedeGrupoParipe` de `app/utils/facturacion.ts`.
 * @param {object} empresa — item de igp_Empresas
 */
export function esSedeGrupoParipeEmpresa(empresa) {
  const s = String(empresa?.Sede ?? empresa?.sede ?? '').trim().toUpperCase();
  return s.includes('GRUPO PARIPE');
}
