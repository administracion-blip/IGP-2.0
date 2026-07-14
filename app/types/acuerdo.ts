/**
 * Tipos del dominio acuerdos — sitio canónico (mismo patrón que `app/types/factura.ts`).
 *
 * Convención: el código nuevo importa desde aquí; los tipos antes vivían
 * como definiciones locales en cada pantalla (`acuerdos.tsx`,
 * `acuerdos-productos-activos.tsx`), con duplicaciones y shapes ligeramente
 * desincronizados respecto al backend. Centralizándolos aquí:
 *
 * - Una sola fuente de verdad por shape (Acuerdo, DetalleProducto, etc.).
 * - Si el backend cambia un campo, hay un solo sitio que actualizar.
 * - El compilador detecta usos rotos (rule del proyecto: tipado captura bugs).
 */

/** Estados posibles de un acuerdo. El backend puede devolver string libre,
 *  por eso `Acuerdo.Estado` queda como `string` (tolerante). Esta union literal
 *  está pensada para validaciones / componentes que conocen el catálogo. */
export type EstadoAcuerdo = 'Activo' | 'Completado' | 'Cancelado' | 'Vencido';

export type EstadoFacturacionAcuerdo = 'sin_factura' | 'pendiente_pago' | 'pagado_parcial' | 'pagado';

export type FacturacionOrigenAcuerdo = 'manual' | 'a3';

/** Acuerdo con marca/proveedor — registro `META` en `IGP_Acuerdos`. */
export type Acuerdo = {
  PK: string;
  Nombre: string;
  Marca: string;
  FechaInicio: string;
  FechaFin: string;
  Contacto: string;
  Telefono: string;
  Email: string;
  Notas: string;
  /** Cualquier `EstadoAcuerdo` o string libre (backend tolerante). */
  Estado: string;
  /** Facturación / pago del acuerdo (independiente de `Estado` operativo). */
  EstadoFacturacion?: EstadoFacturacionAcuerdo | string;
  /** Quién fijó el estado: manual en IGP o sync A3 (futuro). */
  FacturacionOrigen?: FacturacionOrigenAcuerdo | string;
  /** Nº factura visible (manual o copiado de A3). */
  A3FacturaNumero?: string;
  /** ID documento en A3 cuando exista integración. */
  A3FacturaId?: string;
  A3FacturaFecha?: string;
  A3UltimaSync?: string;
  A3EstadoRaw?: string;
  /** Si true, el sync A3 no debe sobrescribir `EstadoFacturacion`. */
  EstadoFacturacionManual?: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Línea de producto contratada en un acuerdo — registros `PROD#${ProductId}` en `IGP_AcuerdosDetalles`. */
export type DetalleProducto = {
  PK: string;
  SK: string;
  ProductId: string;
  ProductName: string;
  Cantidad: number;
  Aportacion: number;
  Rappel: number;
  DescuentoExtra: number;
  Compradas: number;
  Restante: number;
  Porcentaje: number;
  createdAt?: string;
};

/** Imagen / justificante de pago asociado a un acuerdo — `IGP_AcuerdosImagen`. */
export type PagoImagen = {
  PK: string;
  SK: string;
  Locales: string[];
  Acciones: string[];
  Importe: number;
  Justificantes: { name: string; data: string }[];
  Descripcion: string;
  Realizado: boolean;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Línea retornada por `GET /api/acuerdos/productos-activos`: detalle de
 * producto enriquecido con datos del acuerdo padre (marca, fechas, etc.).
 *
 * Antes vivía como `Linea` local en `acuerdos-productos-activos.tsx`.
 * Mantiene `Aportacion/Rappel/DescuentoExtra` opcionales porque el
 * endpoint los devuelve solo si están definidos en el detalle.
 */
export type LineaProductoActivo = {
  PK: string;
  SK?: string;
  ProductId: string;
  ProductName: string;
  Cantidad: number;
  acuerdoPK: string;
  MarcaAcuerdo: string;
  NombreAcuerdo: string;
  FechaInicioAcuerdo?: string;
  FechaFinAcuerdo?: string;
  Compradas: number;
  Restante: number;
  Porcentaje: number;
  Aportacion?: number;
  Rappel?: number;
  DescuentoExtra?: number;
};

/**
 * Empresa (proveedor) tal como llega de `GET /api/empresas` — usada en el
 * selector de marca de un acuerdo. Los campos vienen en PascalCase desde
 * Dynamo (no normalizados como en `EmpresaFactura`); todos opcionales para
 * tolerar respuestas parciales.
 */
export type EmpresaAcuerdo = {
  id_empresa?: string;
  Nombre?: string;
  Alias?: string;
  Cif?: string;
};

/** Local mínimo usado en el modal de pago de imagen / justificantes. */
export type LocalAcuerdo = {
  id: string;
  nombre: string;
};

/** Fila resumen del informe `GET /api/acuerdos/informe-compras`. */
export type InformeComprasResumenAcuerdo = {
  acuerdoPK: string;
  Marca: string;
  Nombre: string;
  Estado: string;
  FechaInicio: string;
  FechaFin: string;
  numProductos: number;
  totalCompradas: number;
  totalAportacionGenerada: number;
};

/** Línea de producto del informe de compras por acuerdo. */
export type InformeComprasLinea = {
  acuerdoPK: string;
  Marca: string;
  Nombre: string;
  Estado: string;
  FechaInicio: string;
  FechaFin: string;
  ProductId: string;
  ProductName: string;
  Cantidad: number;
  Compradas: number;
  Aportacion: number;
  Rappel: number;
  DescuentoExtra: number;
  AportacionUnitaria: number;
  AportacionGenerada: number;
};

/** Metadatos de un archivo adjunto a un acuerdo (almacenado en S3). */
export type ArchivoAcuerdo = {
  fileKey: string;
  fileName: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  /** URL firmada; viene en `GET /api/acuerdos/:pk/archivos`. */
  url?: string;
};
