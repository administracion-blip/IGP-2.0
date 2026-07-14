/**
 * Tipos del dominio compras — sitio canónico (mismo patrón que `app/types/factura.ts`
 * y `app/types/acuerdo.ts`).
 *
 * Convención: el código nuevo importa desde aquí; los tipos antes vivían
 * en `app/(app)/compras/comprasProveedorShared.tsx`. Ese archivo sigue
 * re-exportando para no romper imports existentes, pero la fuente única
 * de verdad pasa a ser este módulo.
 *
 * Origen de datos: tabla DynamoDB de compras a proveedor sincronizada desde
 * Ágora. El backend (`api/routes/agora.js`) sirve los items 1:1 sin renombrar
 * atributos, así que los nombres y casing aquí coinciden con los de Ágora.
 */

/**
 * Línea de albarán de compra a proveedor — registro de la tabla
 * `IGP_ComprasProveedor` (sincronizado desde Ágora). Una compra puede tener
 * múltiples líneas, una por producto; `LineIndex` las ordena dentro del albarán.
 */
export type CompraLinea = {
  PK: string;
  SK: string;
  AlbaranSerie: string;
  AlbaranNumero: string;
  AlbaranFecha: string;
  SupplierDocumentNumber: string;
  Confirmed: boolean;
  Invoiced: boolean;
  SupplierId: string;
  SupplierName: string;
  SupplierCif: string;
  WarehouseId: string;
  WarehouseName: string;
  LineIndex: number;
  ProductId: string;
  ProductName: string;
  Quantity: number;
  Price: number;
  DiscountRate: number;
  CashDiscount: number;
  TotalAmount: number;
  VatRate: number;
  SurchargeRate: number;
  PurchaseUnitName: string;
  FamilyId: string;
  FamilyName: string;
  LotNumber: string;
  LineNotes: string;
  /** Total del ALBARÁN completo con impuestos (Totals.GrossAmount de Ágora); null en filas antiguas. */
  AlbaranGrossAmount?: number | null;
  /** Total del ALBARÁN completo sin impuestos (Totals.NetAmount de Ágora); null en filas antiguas. */
  AlbaranNetAmount?: number | null;
  /** Descuento a pie de documento (tanto por uno). */
  AlbaranDiscountRate?: number;
  syncedAt: string;
};

/** Opción individual de un dropdown de filtro (pares id/label). */
export type OpcionFiltro = { id: string; label: string };

/** Identificador del dropdown de filtro abierto en la UI compras. */
export type FiltroDropdownKey = 'alb' | 'prod' | 'prov' | 'fam' | 'alm';
