/** Helpers de UI del módulo Refacturación (cálculo preview + heurística OCR). */

export const INCREMENTO_REFACTURACION_PCT = 5;
export const HANDOFF_OCR_KEY = 'igp_refacturacion_ocr_handoff';

export function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function recalcularLineaPreview(input: {
  cantidad?: number | string;
  precio_base_unitario?: number | string;
  tipo_iva?: number | string;
  descuento?: number | string;
  descuento_pct?: number | string;
}) {
  const cantidad = Number(input.cantidad) || 0;
  const precio_base_unitario = Number(input.precio_base_unitario) || 0;
  const tipo_iva = Number(input.tipo_iva) || 0;
  const descuento = Number(input.descuento ?? input.descuento_pct) || 0;
  const precio_refacturado_unitario = round2(
    precio_base_unitario * (1 + INCREMENTO_REFACTURACION_PCT / 100),
  );
  const base_linea = round2(
    cantidad * precio_refacturado_unitario * (1 - descuento / 100),
  );
  const iva_linea = round2((base_linea * tipo_iva) / 100);
  const total_linea = round2(base_linea + iva_linea);
  return {
    incremento_pct: INCREMENTO_REFACTURACION_PCT,
    precio_base_unitario: round2(precio_base_unitario),
    precio_refacturado_unitario,
    cantidad,
    tipo_iva,
    descuento,
    base_linea,
    iva_linea,
    total_linea,
  };
}

/** Heurística: nº factura proveedor + CIF + total > 0. */
export function pareceFactura(datosOcr: Record<string, unknown> = {}): boolean {
  const numero = String(
    datosOcr.numero_factura_proveedor
      ?? datosOcr.numero_factura
      ?? datosOcr.numero
      ?? '',
  ).trim();
  const cif = String(
    datosOcr.cif
      ?? datosOcr.emisor_cif
      ?? datosOcr.proveedor_cif
      ?? '',
  ).trim();
  const total = Number(
    datosOcr.total_factura
      ?? datosOcr.total
      ?? datosOcr.importe_total
      ?? 0,
  );
  return Boolean(numero && cif && total > 0);
}

export type LineaOcrMapeada = {
  descripcion: string;
  cantidad: number;
  precio_base_unitario: number;
  tipo_iva: number;
  descuento_pct: number;
};

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mapRawLineaArticulo(l: Record<string, unknown>): LineaOcrMapeada | null {
  const descripcion = String(
    l.descripcion ?? l.concepto ?? l.nombre ?? l.texto ?? '',
  ).trim();
  const cantidad = num(l.cantidad ?? l.uds ?? l.units, 1) || 1;
  const precio = num(
    l.precio_base_unitario
      ?? l.precio_unitario
      ?? l.precio
      ?? l.importe_unitario
      ?? l.base_unitaria,
  );
  const tipo_iva = num(l.tipo_iva ?? l.iva_pct ?? l.iva ?? l.porcentaje, 21);
  const descuento_pct = num(l.descuento_pct ?? l.descuento ?? l.dto);
  if (!descripcion && !precio) return null;
  return {
    descripcion: descripcion || '',
    cantidad,
    precio_base_unitario: precio,
    tipo_iva,
    descuento_pct,
  };
}

/** Deriva % IVA desde totales OCR (desglose_impuestos suele llegar vacío). */
function tipoIvaDesdeTotales(base: number, totalIva: number, total: number): number {
  if (base > 0 && totalIva > 0) {
    const pct = round2((totalIva / base) * 100);
    if (pct >= 0 && pct <= 100) return pct;
    return 21;
  }
  if (base > 0 && total > base) {
    const pct = round2(((total - base) / base) * 100);
    if (pct >= 0 && pct <= 100) return pct;
  }
  return 21;
}

function lineaFallbackDesdeTotales(datos: Record<string, unknown>): LineaOcrMapeada {
  const base = num(datos.base_imponible ?? datos.base_imponible_total);
  const totalIva = num(datos.total_iva);
  const total = num(datos.total_factura ?? datos.total ?? datos.importe_total);
  const tipo_iva = tipoIvaDesdeTotales(base, totalIva, total);

  let precio_base_unitario = 0;
  if (base > 0) {
    precio_base_unitario = round2(base);
  } else if (total > 0 && totalIva > 0 && total > totalIva) {
    precio_base_unitario = round2(total - totalIva);
  } else if (total > 0) {
    precio_base_unitario = tipo_iva > 0
      ? round2(total / (1 + tipo_iva / 100))
      : round2(total);
  }

  const descripcion = String(
    datos.proveedor_nombre ?? datos.emisor_nombre ?? 'Documento OCR',
  ).trim() || 'Documento OCR';

  return {
    descripcion,
    cantidad: 1,
    precio_base_unitario,
    tipo_iva,
    descuento_pct: 0,
  };
}

export type FuenteLineasOcr = 'lineas_articulos' | 'lineas' | 'totales_fallback';

export type LineasOcrConMeta = {
  lineas: LineaOcrMapeada[];
  fuente: FuenteLineasOcr;
};

/**
 * Extrae líneas de artículo del OCR con origen.
 * Prioridad: lineas_articulos (IA) → lineas/articulos/items → fallback 1 línea desde totales.
 * No usa desglose_impuestos como artículos (es fiscal).
 */
export function mapLineasDesdeOcrConMeta(
  datos: Record<string, unknown> = {},
): LineasOcrConMeta {
  let fuenteCandidata: Exclude<FuenteLineasOcr, 'totales_fallback'> = 'lineas';
  let raw: unknown[] = [];

  if (Array.isArray(datos.lineas_articulos) && datos.lineas_articulos.length > 0) {
    raw = datos.lineas_articulos;
    fuenteCandidata = 'lineas_articulos';
  } else if (Array.isArray(datos.lineas) && datos.lineas.length > 0) {
    raw = datos.lineas;
    fuenteCandidata = 'lineas';
  } else if (Array.isArray(datos.articulos) && datos.articulos.length > 0) {
    raw = datos.articulos;
    fuenteCandidata = 'lineas';
  } else if (Array.isArray(datos.items) && datos.items.length > 0) {
    raw = datos.items;
    fuenteCandidata = 'lineas';
  }

  const mapped = (raw as Record<string, unknown>[])
    .map(mapRawLineaArticulo)
    .filter((x): x is LineaOcrMapeada => x != null);

  if (mapped.length > 0) {
    return { lineas: mapped, fuente: fuenteCandidata };
  }

  return {
    lineas: [lineaFallbackDesdeTotales(datos)],
    fuente: 'totales_fallback',
  };
}

/** Extrae líneas de artículo del OCR (sin metadatos). */
export function mapLineasDesdeOcr(datos: Record<string, unknown> = {}): LineaOcrMapeada[] {
  return mapLineasDesdeOcrConMeta(datos).lineas;
}

export type HandoffOcrRefacturacion = {
  archivo: {
    fileKey: string;
    nombre: string;
    tipo: string;
    size: number;
    previewUrl?: string;
  };
  datos: Record<string, unknown>;
  returnTo: string;
};

/** Caché en memoria: sobrevive a limpiar sessionStorage en remount Strict Mode. */
let handoffMemory: HandoffOcrRefacturacion | null = null;

export function guardarHandoffOcr(payload: HandoffOcrRefacturacion): void {
  handoffMemory = payload;
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(HANDOFF_OCR_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota */
  }
}

/** Lee el handoff sin borrarlo (sessionStorage + memoria). */
export function peekHandoffOcr(): HandoffOcrRefacturacion | null {
  if (typeof sessionStorage !== 'undefined') {
    try {
      const raw = sessionStorage.getItem(HANDOFF_OCR_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as HandoffOcrRefacturacion;
        if (parsed?.archivo?.fileKey) {
          handoffMemory = parsed;
          return parsed;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return handoffMemory;
}

/** Quita solo sessionStorage (la memoria queda para un remount inmediato). */
export function limpiarHandoffOcr(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(HANDOFF_OCR_KEY);
  } catch {
    /* ignore */
  }
}

/** Purge completo (storage + memoria). Usar al salir del flujo. */
export function purgarHandoffOcr(): void {
  handoffMemory = null;
  limpiarHandoffOcr();
}

/** @deprecated Preferir peekHandoffOcr + limpiarHandoffOcr tras aplicar el borrador. */
export function leerYLimpiarHandoffOcr(): HandoffOcrRefacturacion | null {
  const parsed = peekHandoffOcr();
  if (parsed) limpiarHandoffOcr();
  return parsed;
}

/** Path interno seguro para retorno tras registro-masivo. */
export function returnToValido(path: unknown): string | null {
  const p = Array.isArray(path) ? path[0] : path;
  const s = String(p ?? '').trim();
  if (!s.startsWith('/')) return null;
  if (s.startsWith('/facturacion/') || s === '/facturacion' || s === '/') return s;
  return null;
}
