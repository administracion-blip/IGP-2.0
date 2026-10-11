import type {
  EstadoRemesa,
  FallidaEjecucionRemesa,
  PendienteDescartadaRemesa,
  Remesa,
  RemesaActivaFactura,
} from '../types/remesas';

export const FILTROS_ESTADO_REMESA: { id: EstadoRemesa | 'todos'; label: string }[] = [
  { id: 'todos', label: 'Todas' },
  { id: 'Borrador', label: 'Borrador' },
  { id: 'Generada', label: 'Generada' },
  { id: 'Ejecutada', label: 'Ejecutada' },
  { id: 'Anulada', label: 'Anulada' },
];

export function colorEstadoRemesa(estado: EstadoRemesa): { bg: string; text: string } {
  const map: Record<EstadoRemesa, { bg: string; text: string }> = {
    Borrador: { bg: '#f1f5f9', text: '#475569' },
    Generada: { bg: '#dbeafe', text: '#1e40af' },
    Ejecutada: { bg: '#d1fae5', text: '#047857' },
    Anulada: { bg: '#fee2e2', text: '#b91c1c' },
  };
  return map[estado] || { bg: '#f1f5f9', text: '#64748b' };
}

export function labelEstadoRemesa(estado: EstadoRemesa): string {
  return FILTROS_ESTADO_REMESA.find((f) => f.id === estado)?.label || estado;
}

/** Estados de factura IN seleccionables en modo multiselección del listado */
export const ESTADOS_FACTURA_SELECCION = new Set([
  'pendiente_revision',
  'pendiente_pago',
  'parcialmente_pagada',
  'vencida',
]);

export function esFacturaSeleccionableEnListado(estado: string | undefined | null): boolean {
  return ESTADOS_FACTURA_SELECCION.has(String(estado || ''));
}

/** Estados de factura IN que permiten incluir en remesa */
export const ESTADOS_FACTURA_REMESABLES = new Set([
  'pendiente_pago',
  'parcialmente_pagada',
  'vencida',
]);

/** Factura IN con sociedad ordenante (emisor_*) para agrupar remesas. */
export type FacturaRemesaAgrupable = {
  id_factura: string;
  emisor_id?: string | null;
  emisor_nombre?: string | null;
};

export type GrupoRemesaPorSociedad = {
  sociedadId: string;
  sociedadNombre: string;
  facturas: FacturaRemesaAgrupable[];
};

/**
 * Una remesa FIT = una sociedad ordenante (emisor_id en facturas IN).
 * Varias sociedades en la selección → varios grupos / varias remesas.
 */
export function agruparFacturasRemesaPorSociedad(facturas: FacturaRemesaAgrupable[]): GrupoRemesaPorSociedad[] {
  const map = new Map<string, GrupoRemesaPorSociedad>();
  for (const f of facturas) {
    const sociedadId = String(f.emisor_id ?? '').trim();
    const sociedadNombre = String(f.emisor_nombre ?? '').trim();
    const key = sociedadId || sociedadNombre || '__sin_sociedad__';
    const prev = map.get(key);
    if (prev) {
      prev.facturas.push(f);
    } else {
      map.set(key, {
        sociedadId,
        sociedadNombre: sociedadNombre || 'Sin sociedad ordenante',
        facturas: [f],
      });
    }
  }
  return [...map.values()];
}

/** Slug seguro para nombre de fichero de remesa (sociedad ordenante). */
export function slugNombreArchivoRemesa(nombre: string | null | undefined): string {
  return String(nombre || 'sociedad')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'sociedad';
}

export const CODE_REMESA_EJECUCION_PARCIAL = 'REMESA_EJECUCION_PARCIAL';

/** Facturas de una remesa `Ejecutada` que quedaron sin pagar (re-ejecutar paga solo estas). */
export function lineasPendientesPagoRemesa(remesa: Pick<Remesa, 'estado' | 'lineasPendientesPago'>): string[] {
  if (remesa.estado !== 'Ejecutada' || !Array.isArray(remesa.lineasPendientesPago)) return [];
  return remesa.lineasPendientesPago.map(String);
}

/** «Proveedor · nº factura» de una línea de la remesa; si no está, el `id_factura`. */
export function etiquetaFacturaRemesa(remesa: Pick<Remesa, 'lineas'> | null | undefined, idFactura: string): string {
  const l = remesa?.lineas?.find((x) => String(x.id_factura) === String(idFactura));
  if (!l) return `Factura ${idFactura}`;
  const numero = l.numero_factura_proveedor || l.numero_factura || idFactura;
  return l.proveedorNombre ? `${l.proveedorNombre} · ${numero}` : numero;
}

/** Texto para el aviso de una ejecución parcial: pagadas, las que siguen pendientes y las que quitó el sistema. */
export function resumenEjecucionParcial(
  remesa: Pick<Remesa, 'lineas'> | null | undefined,
  pagadas: number,
  fallidas: FallidaEjecucionRemesa[],
): string {
  const total = pagadas + fallidas.length;
  const siguen = fallidas.filter((f) => f.siguePendiente !== false);
  const quitadas = fallidas.filter((f) => f.siguePendiente === false);
  const linea = (f: FallidaEjecucionRemesa, prefijo = '') =>
    `• ${etiquetaFacturaRemesa(remesa, f.id_factura)}: ${prefijo}${f.error || 'Error desconocido'}`;
  const bloques = [`Se han pagado ${pagadas} de ${total} factura(s).`];
  if (siguen.length > 0) {
    bloques.push(
      `Siguen pendientes de pago (${siguen.length}):\n${siguen.map((f) => linea(f)).join('\n')}\n`
      + 'Puedes reintentarlas o descartarlas desde el detalle de la remesa.',
    );
  }
  if (quitadas.length > 0) {
    bloques.push(
      `Quitadas de pendientes por el sistema (${quitadas.length}):\n`
      + quitadas.map((f) => linea(f, 'ya no era pagable: ')).join('\n'),
    );
  }
  return bloques.join('\n\n');
}

export const MENSAJE_REMESA_EN_PROCESO = 'La remesa se está procesando';

/**
 * Mensaje visible para un error de las acciones de remesa. El 409 de reclamo
 * ocupado se explica para que el usuario espere en vez de reintentar en bucle.
 */
export function mensajeErrorAccionRemesa(data: { error?: unknown } | null | undefined, fallback: string): string {
  const error = typeof data?.error === 'string' ? data.error : '';
  if (error.startsWith(MENSAJE_REMESA_EN_PROCESO)) {
    return 'La remesa se está procesando en otra sesión (hay una ejecución en curso). '
      + 'Espera un par de minutos y vuelve a cargarla antes de reintentar.';
  }
  return error || fallback;
}

/** Aviso de pagos bloqueados en una factura con `remesaActiva`. */
export function avisoPagosFacturaEnRemesa(remesa: Pick<RemesaActivaFactura, 'estado'> | null | undefined): string {
  if (remesa?.estado === 'Ejecutada') {
    return 'Figura como pago pendiente de esta remesa ejecutada. Para pagarla por otra vía, '
      + 'descarta la factura pendiente en la remesa.';
  }
  return 'No se pueden registrar, editar ni eliminar pagos mientras figure en esta remesa.';
}

export function etiquetaAutorDescarte(d: Pick<PendienteDescartadaRemesa, 'por' | 'porNombre'>): string {
  if (d.por === 'sistema') return 'Sistema';
  return d.porNombre || d.por || '—';
}
