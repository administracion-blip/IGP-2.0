/**
 * Escapa un texto para interpolarlo en HTML (contenido o valor de atributo entre
 * comillas). Todo dato que venga de BD o del usuario y acabe en el HTML de un
 * correo pasa por aquí; el marcado que genera el propio código, no.
 *
 * @param {unknown} valor
 * @returns {string}
 */
export function escapeHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Texto plano escrito por el usuario → HTML: escapado y con sus saltos de línea. */
export function textoPlanoAHtml(valor) {
  return escapeHtml(valor).replace(/\r?\n/g, '<br/>');
}
