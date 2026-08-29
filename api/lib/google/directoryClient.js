/**
 * Cliente de Google Directory (Fase 3, D-26).
 *
 * Stub: no llama a Google ni exige `googleapis`. Cuando haya service account,
 * este fichero se sustituye por el adaptador real sin cambiar la firma.
 *
 * Lista blanca de escritura en usuarios IGP (cuando exista adaptador real):
 * solo `google_directory_id` (y campos cosméticos explícitos si se aprueban).
 * Nunca Email, Nombre, Password, Rol, Locales, Departamentos.
 * Ausente en Directory ≠ baja en IGP.
 */

const MOTIVO_NO_CONFIGURADO = 'Google Directory no está configurado';

/** Campos que un adaptador real podría escribir en `igp_usuarios`. */
export const CAMPOS_DIRECTORY_PERMITIDOS = Object.freeze(['google_directory_id']);

/** `false` mientras no haya credenciales / adaptador real. */
export function disponible() {
  return false;
}

/**
 * Sincronización no-op: no toca usuarios.
 *
 * @returns {Promise<{ ok: boolean, sincronizados: number, mensaje: string }>}
 */
export async function sincronizar() {
  return {
    ok: false,
    sincronizados: 0,
    mensaje: MOTIVO_NO_CONFIGURADO,
  };
}
