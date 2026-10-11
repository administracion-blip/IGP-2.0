/**
 * Predicado de sede del grupo Paripe (locales / facturación / briefing IA).
 * Misma regla que el filtro `?grupoParipe=1` de GET /locales.
 */

/** @param {object} loc — item de igp_Locales */
export function esSedeGrupoParipeLocal(loc) {
  const s = String(loc?.sede ?? loc?.Sede ?? '').toUpperCase();
  return s.includes('PARIPE');
}
