/**
 * Integración futura con A3 Software (facturación).
 *
 * Flujo previsto:
 *  1. La factura se registra en A3 (operativa manual de contabilidad).
 *  2. IGP consulta la API de A3 (solo lectura) y actualiza el acuerdo vinculado.
 *  3. Campos en Igp_Acuerdos META: A3FacturaId, A3FacturaNumero, EstadoFacturacion, etc.
 *
 * Pendiente: API key, documentación de endpoints y criterio de vinculación acuerdo ↔ documento.
 */

/** @returns {Promise<null>} Placeholder hasta disponer de credenciales A3. */
export async function syncFacturacionAcuerdoDesdeA3(_acuerdoPK) {
  return null;
}
