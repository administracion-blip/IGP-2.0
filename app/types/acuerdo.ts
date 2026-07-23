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

/** Justificante antiguo embebido en Dynamo como base64 (compatibilidad). */
export type JustificanteLegacy = { name: string; data: string };

/** Justificante nuevo almacenado en S3; `url` firmada la añade el backend en el GET. */
export type JustificanteS3 = {
  fileKey: string;
  fileName: string;
  contentType?: string;
  size?: number;
  uploadedAt?: string;
  url?: string;
};

/** Un justificante puede venir en formato S3 (nuevo) o base64 (legacy). */
export type Justificante = JustificanteLegacy | JustificanteS3;

/** Devuelve `true` si el justificante está almacenado en S3. */
export function esJustificanteS3(j: Justificante): j is JustificanteS3 {
  return typeof (j as JustificanteS3).fileKey === 'string';
}

/** Nombre a mostrar de un justificante, sea S3 o legacy. */
export function justificanteNombre(j: Justificante): string {
  return esJustificanteS3(j) ? j.fileName : j.name;
}

/** Indica si el justificante se puede abrir (URL firmada S3 o data URL legacy). */
export function justificanteAbrible(j: Justificante): boolean {
  if (esJustificanteS3(j)) return Boolean(j.url);
  return Boolean(j.data);
}

/** Abre un justificante en nueva pestaña (web). S3 vía url firmada; legacy vía data URL. */
export function abrirJustificante(j: Justificante): void {
  if (typeof window === 'undefined') return;
  if (esJustificanteS3(j) && j.url) {
    window.open(j.url, '_blank');
    return;
  }
  if (!esJustificanteS3(j) && j.data) {
    window.open(j.data, '_blank');
  }
}

/** Icono MaterialIcons acorde al tipo de justificante. */
export function justificanteIcono(j: Justificante): { name: 'image' | 'picture-as-pdf' | 'insert-drive-file'; color: string } {
  const ct = esJustificanteS3(j) ? (j.contentType || '') : '';
  const legacy = !esJustificanteS3(j) ? (j.data || '') : '';
  const isImage = /^image\//i.test(ct) || legacy.startsWith('data:image/');
  const isPdf = /\/pdf$/i.test(ct) || legacy.includes('application/pdf');
  if (isImage) return { name: 'image', color: '#0ea5e9' };
  if (isPdf) return { name: 'picture-as-pdf', color: '#ef4444' };
  return { name: 'insert-drive-file', color: '#64748b' };
}

/** Imagen / justificante de pago asociado a un acuerdo — `IGP_AcuerdosImagen`. */
export type PagoImagen = {
  PK: string;
  SK: string;
  Locales: string[];
  Acciones: string[];
  Importe: number;
  Justificantes: Justificante[];
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
