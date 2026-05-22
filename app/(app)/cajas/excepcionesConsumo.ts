/** Cliente Ágora "CONSUMO" (Id 1) — operativa permitida, excluida del control por defecto. */
export const CONSUMO_CUSTOMER_ID = '1';
export const CONSUMO_CUSTOMER_NAME = 'CONSUMO';

export function isConsumoCustomer(
  customerId: number | string | null | undefined,
  customerName: string | null | undefined,
): boolean {
  if (customerId != null && String(customerId).trim() === CONSUMO_CUSTOMER_ID) return true;
  if (String(customerName ?? '').trim() === CONSUMO_CUSTOMER_NAME) return true;
  return false;
}

export function consumoPdfLabel(incluirConsumo: boolean): string {
  return incluirConsumo
    ? 'Cliente CONSUMO (Id 1): incluido en este informe'
    : 'Cliente CONSUMO (Id 1): excluido de este informe';
}

export function filterExcepcionesConsumo<T extends {
  CustomerId?: number | string | null;
  CustomerName?: string | null;
}>(rows: T[], incluirConsumo: boolean): T[] {
  if (incluirConsumo) return rows;
  return rows.filter((r) => !isConsumoCustomer(r.CustomerId, r.CustomerName));
}
