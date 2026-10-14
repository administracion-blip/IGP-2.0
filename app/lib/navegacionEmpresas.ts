/** Navegación desde facturación al maestro de empresas con retorno al listado/modal. */

export type ContextoRetornoEmpresas = {
  returnTo: string;
  returnModalFactura?: string;
};

export function listadoFacturaReturnPath(tipo: 'IN' | 'OUT'): string {
  return tipo === 'IN' ? '/facturacion/facturas-gasto' : '/facturacion/facturas-venta';
}

/** Maestro de empresas con retorno al listado de facturas (gasto o emitidas). */
export function buildEmpresasDesdeFacturasHref(tipo: 'IN' | 'OUT'): string {
  const params = new URLSearchParams();
  params.set('returnTo', listadoFacturaReturnPath(tipo));
  return `/empresas?${params.toString()}`;
}

export function buildEmpresasEditarHref(opts: {
  idEmpresa: string;
  returnTo: string;
  returnModalFactura?: string;
}): string {
  const params = new URLSearchParams();
  params.set('id_empresa', opts.idEmpresa.trim());
  params.set('editar', '1');
  params.set('returnTo', opts.returnTo);
  if (opts.returnModalFactura?.trim()) {
    params.set('returnModalFactura', opts.returnModalFactura.trim());
  }
  return `/empresas?${params.toString()}`;
}

export function buildReturnFromEmpresasHref(
  ctx: ContextoRetornoEmpresas & { maestroActualizado?: boolean },
): string {
  const params = new URLSearchParams();
  if (ctx.returnModalFactura?.trim()) {
    params.set('modalFactura', ctx.returnModalFactura.trim());
  }
  if (ctx.maestroActualizado) {
    params.set('maestroActualizado', '1');
  }
  const q = params.toString();
  return q ? `${ctx.returnTo}?${q}` : ctx.returnTo;
}

export function tipoListadoDesdeReturnTo(returnTo: string): 'IN' | 'OUT' | null {
  if (returnTo.includes('facturas-gasto')) return 'IN';
  if (returnTo.includes('facturas-venta')) return 'OUT';
  return null;
}

/**
 * Aviso al listado cuando se vuelve con router.back(), sin cambiar la URL.
 * Así no se monta un listado nuevo y no se pierden los filtros.
 */
export type RetornoListadoFacturas = {
  tipo: 'IN' | 'OUT';
  maestro: boolean;
  modalFactura?: string;
};

let retornoPendiente: RetornoListadoFacturas | null = null;

export function marcarRetornoListadoFacturas(retorno: RetornoListadoFacturas) {
  retornoPendiente = retorno;
}

export function consumirRetornoListadoFacturas(tipo: 'IN' | 'OUT'): RetornoListadoFacturas | null {
  if (!retornoPendiente || retornoPendiente.tipo !== tipo) return null;
  const retorno = retornoPendiente;
  retornoPendiente = null;
  return retorno;
}

export function parseContextoRetornoEmpresas(params: {
  returnTo?: string | string[];
  returnModalFactura?: string | string[];
}): ContextoRetornoEmpresas | null {
  const returnTo = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnModalFactura = Array.isArray(params.returnModalFactura)
    ? params.returnModalFactura[0]
    : params.returnModalFactura;
  const to = returnTo?.trim();
  if (!to) return null;
  const modal = returnModalFactura?.trim();
  return { returnTo: to, returnModalFactura: modal || undefined };
}
