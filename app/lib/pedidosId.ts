/**
 * IDs de pedido: PED-{año}-{secuencial 5 dígitos}, p. ej. PED-2026-00003.
 * El año se toma del campo Fecha del formulario (ISO o dd/mm/aaaa).
 */

/** Extrae el año (4 cifras) desde Fecha en ISO (YYYY-MM-DD) o formato formulario (dd/mm/aaaa). */
export function añoDesdeFechaPedido(fecha: string): number | null {
  const t = fecha.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return parseInt(t.slice(0, 4), 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return parseInt(m[3], 10);
  const m2 = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m2) {
    let y = parseInt(m2[3], 10);
    if (y < 100) y += 2000;
    return y;
  }
  return null;
}

/**
 * Siguiente Id para un año dado, mirando solo IDs con formato PED-AAAA-NNNNN.
 * Pedidos con formato antiguo (p. ej. PED-001) no cuentan para el correlativo.
 */
export function siguienteIdPedidoParaAño(ids: string[], año: number): string {
  const y =
    Number.isFinite(año) && año >= 1900 && año <= 2100 ? Math.floor(año) : new Date().getFullYear();
  const re = new RegExp(`^PED-${y}-(\\d+)$`, 'i');
  let max = 0;
  for (const raw of ids) {
    const m = String(raw).match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) max = Math.max(max, n);
    }
  }
  return `PED-${y}-${String(max + 1).padStart(5, '0')}`;
}

/** Siguiente Id de alta usando la fecha del formulario y la lista de Ids existentes. */
export function siguienteIdParaNuevoPedido(fechaForm: string, idsExistentes: string[]): string {
  const y = añoDesdeFechaPedido(fechaForm) ?? new Date().getFullYear();
  return siguienteIdPedidoParaAño(idsExistentes, y);
}
