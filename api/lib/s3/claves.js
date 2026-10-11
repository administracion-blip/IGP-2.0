/**
 * Validación de claves S3 que llegan del cliente.
 *
 * El bucket es compartido por todos los módulos (facturas, actas, firmas,
 * banca…): una clave recibida en un endpoint solo puede apuntar al prefijo que
 * ese endpoint genera, nunca a ficheros de otros módulos.
 */

const MAX_LONGITUD_CLAVE = 1024;

/**
 * @param {unknown} fileKey
 * @param {string[]} prefijosPermitidos Prefijos con barra final, p. ej. 'facturas/ocr-temp/'.
 * @returns {{ ok: true, key: string } | { ok: false, error: string }}
 */
export function validarClaveS3(fileKey, prefijosPermitidos) {
  if (typeof fileKey !== 'string' || fileKey.length === 0 || fileKey.length > MAX_LONGITUD_CLAVE) {
    return { ok: false, error: 'fileKey inválido' };
  }
  if (
    fileKey.startsWith('/')
    || fileKey.includes('\\')
    || fileKey.includes('//')
    || /[\u0000-\u001f\u007f]/.test(fileKey)
    || fileKey.split('/').some((seg) => seg === '.' || seg === '..')
  ) {
    return { ok: false, error: 'fileKey inválido' };
  }
  const permitido = (prefijosPermitidos || []).some(
    (p) => typeof p === 'string' && p.endsWith('/') && fileKey.startsWith(p) && fileKey.length > p.length,
  );
  if (!permitido) return { ok: false, error: 'fileKey inválido' };
  return { ok: true, key: fileKey };
}
