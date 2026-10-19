/**
 * Normaliza números de documento de proveedor para comparar: deja solo
 * letras/dígitos en mayúsculas (los datos reales traen espacios y guiones,
 * p. ej. `F26 004418`). Mismo criterio que en conciliación de facturas.
 */
export function normDocProveedor(valor: unknown): string {
  return String(valor ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}
