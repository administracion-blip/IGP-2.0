/**
 * Claves DynamoDB para Igp_Escandallos.
 * IDs: trim, sin padding forzado.
 */

export function normalizeProductId(val) {
  if (val == null || String(val).trim() === '') return '';
  return String(val).trim();
}

export function pkProducto(productoId) {
  const id = normalizeProductId(productoId);
  return id ? `PRODUCT#${id}` : '';
}

export function skMeta() {
  return 'META';
}

export function skIng(ingredienteId) {
  const id = normalizeProductId(ingredienteId);
  return id ? `ING#${id}` : '';
}
