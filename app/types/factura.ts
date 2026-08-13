/**
 * Tipos del dominio factura — sitio canónico para imports nuevos.
 *
 * Histórico: hasta hace poco los tipos del dominio vivían en
 * `app/utils/facturacion.ts` (junto con constantes y helpers). Para evitar
 * que el módulo de utils crezca como “god module” y para tener una capa
 * `app/types/` clara, este archivo se convierte en la fachada de tipos.
 *
 * - El código nuevo importa desde aquí (`'../../types/factura'`).
 * - El código existente sigue funcionando porque `utils/facturacion.ts`
 *   conserva las definiciones (re-exportadas desde aquí).
 * - Cuando todo el dominio esté migrado podemos invertir la fuente de
 *   verdad: mover las definiciones aquí y dejar `utils/facturacion.ts`
 *   con solo constantes, helpers y re-exports de tipos.
 */

import type { Factura } from '../utils/facturacion';
import type { RemesaActivaFactura } from './remesas';

export type {
  Factura,
  AlbaranConciliado,
  LineaFactura,
  AdjuntoFactura,
  EstadoOut,
  EstadoIn,
  DesgloseRetencion,
  FormaPagoClave,
  EmpresaFactura,
  SerieFactura,
  LocalFactura,
  ProductoFactura,
  PagoFactura,
  AuditoriaFactura,
} from '../utils/facturacion';

export type { RemesaActivaFactura } from './remesas';

/**
 * Vista parcial de Factura tal como llega en endpoints de listado
 * (`GET /api/facturacion/facturas?tipo=OUT|IN`).
 *
 * Es un subset de `Factura` con todos los campos opcionales excepto
 * `id_factura`, ya que la respuesta del listado puede no incluir todos
 * los campos del documento completo (eso solo viene en
 * `GET /api/facturacion/facturas/:id`).
 *
 * Sustituye el `type Factura = { ... }` que vivía duplicado en
 * `facturas-venta.tsx` y el uso del tipo `Factura` completo desde
 * `facturas-gasto.tsx` (que era demasiado estricto para el listado).
 *
 * Si en el futuro renombramos un campo en `Factura`, este `Pick` se
 * sincroniza automáticamente — y si eliminamos el campo, TypeScript
 * fallará aquí indicándonos que hay que actualizar el listado.
 */
export type FacturaListado = {
  id_factura: string;
  /** Presente si la factura IN está en una remesa Borrador/Generada */
  remesaActiva?: RemesaActivaFactura | null;
} & Partial<Pick<Factura,
  | 'estado'
  | 'fecha_emision'
  | 'numero_factura'
  | 'numero_factura_proveedor'
  | 'emisor_id'
  | 'emisor_nombre'
  | 'emisor_cif'
  | 'emisor_iban'
  | 'emisor_iban_alternativo'
  | 'empresa_id'
  | 'empresa_nombre'
  | 'empresa_cif'
  | 'empresa_iban'
  | 'empresa_iban_alternativo'
  | 'base_imponible'
  | 'total_iva'
  | 'total_retencion'
  | 'total_factura'
  | 'total_cobrado'
  | 'saldo_pendiente'
  | 'fecha_contabilizacion'
  | 'contabilizado_por'
  | 'creado_en'
  | 'impuestos_resumen'
  | 'forma_pago'
  | 'observaciones'
  | 'es_abono'
  | 'albaranes_conciliados'
>>;
