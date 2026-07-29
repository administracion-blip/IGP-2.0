/**
 * Facturación mensual de las ventas internas del grupo y de los abonos de
 * rappel (lado cliente).
 *
 * El contrato lo fijan `api/routes/comprasFacturacion.js` y
 * `api/lib/facturacion/facturarVentasInternas.js`:
 * - Periodo AAAA-MM; por defecto se factura el mes anterior.
 * - La unidad de facturación es el **par emisora–receptora**: la sociedad que
 *   sirve la mercancía (la del almacén de origen) factura a la del local que la
 *   recibe. A diferencia de mantenimiento, la emisora también varía.
 * - Dentro de cada factura las líneas se agrupan por local de origen y, en cada
 *   uno, por tipo de IVA.
 * - Un pedido facturado queda marcado con `factura_ventas_id` (o
 *   `factura_rappel_id` para el abono) y desde ese momento `api/routes/pedidos.js`
 *   rechaza modificarlo, borrarlo o tocar sus líneas.
 */
import {
  agruparPorMotivo,
  labelPeriodoCorto,
  type GrupoExcluidos,
  type ItemExcluido,
} from './facturacionPeriodica';

/**
 * Rutas de los dos flujos. El de rappel es gemelo del de ventas y puede no
 * estar desplegado todavía: la pantalla lo trata como «no disponible» en vez de
 * como error (ver `esFlujoNoDisponible`).
 */
export const ENDPOINTS_FACTURACION_COMPRAS = {
  ventas: {
    previsualizar: '/api/compras/facturacion/previsualizar',
    generar: '/api/compras/facturacion/generar',
  },
  rappel: {
    previsualizar: '/api/compras/facturacion/rappel/previsualizar',
    generar: '/api/compras/facturacion/rappel/generar',
  },
} as const;

export type FlujoFacturacionCompras = keyof typeof ENDPOINTS_FACTURACION_COMPRAS;

/**
 * El servidor no conoce la ruta: el flujo todavía no está desplegado. 404 y 405
 * son las dos respuestas posibles de Express ante una ruta que no existe o que
 * no admite el método.
 */
export function esFlujoNoDisponible(status: number): boolean {
  return status === 404 || status === 405;
}

// ─── Forma de la respuesta ───

/** Pedido concreto que entra en una línea de la factura. */
export type PedidoDesglose = {
  id?: string;
  fecha?: string;
  fecha_texto?: string;
  origen_nombre?: string;
  lineas?: number;
  base?: number;
};

/** Local que recibe la mercancía, con los pedidos que se le imputan. */
export type LocalDestinoDesglose = {
  local_id?: string;
  local_nombre?: string;
  base?: number;
  pedidos?: PedidoDesglose[];
};

/** Local o almacén desde el que se sirvió: es lo que agrupa las líneas de la factura. */
export type OrigenDesglose = {
  origen_clave?: string;
  origen_nombre?: string;
  num_pedidos?: number;
  base?: number;
};

export type ImpuestoDesglose = {
  tipo_iva?: number;
  base?: number;
  cuota?: number;
};

export type FacturaExistente = {
  id_factura?: string;
  numero_factura?: string;
  estado?: string;
  total_factura?: number;
};

/** Documento previsto o creado. La emisora varía, así que la identidad es el par. */
export type FacturaCompras = {
  /** Solo en el resultado de la generación: la previsualización no crea nada. */
  id_factura?: string;
  /** Abono de rappel: importes negativos y rectificativa por diferencias. */
  es_abono?: boolean;
  id_empresa_emisora?: string;
  empresa_emisora_nombre?: string;
  empresa_emisora_cif?: string;
  id_empresa?: string;
  empresa_nombre?: string;
  empresa_cif?: string;
  serie?: string;
  estado?: string;
  fecha_emision?: string;
  num_pedidos?: number;
  num_lineas?: number;
  base?: number;
  iva?: number;
  total?: number;
  /** Diferencia en céntimos con el informe de ventas por empresa. No bloquea. */
  descuadre_centimos?: number;
  base_informe?: number;
  impuestos?: ImpuestoDesglose[];
  origenes?: OrigenDesglose[];
  locales?: LocalDestinoDesglose[];
  pedidos?: { id?: string; fecha?: string; local_nombre?: string; origen_nombre?: string }[];
  aviso?: string;
  facturas_existentes?: FacturaExistente[];
};

export type ExcluidoCompras = {
  motivo?: string;
  motivo_texto?: string;
  detalle?: string;
  /** `sociedad` (el par entero) o `pedido` (un pedido concreto). */
  ambito?: string;
  pedido_id?: string;
  fecha?: string;
  local_id?: string;
  local_nombre?: string;
  pedidos?: number;
  id_empresa_emisora?: string;
  empresa_emisora_nombre?: string;
  id_empresa?: string;
  empresa_nombre?: string;
};

/** Pedidos de meses anteriores que siguen sin facturar. */
export type PendientePeriodo = { periodo?: string; pedidos?: number };

/** Pedidos que no generan documento por diseño, no por un dato incompleto. */
export type NoFacturables = {
  devoluciones?: number;
  misma_sociedad?: number;
  /** Pedidos sin importe en este flujo (la mayoría no lleva rappel). */
  sin_importe?: number;
};

export type PrevisualizacionCompras = {
  periodo: string;
  inicio_seleccion?: string;
  corte_seleccion?: string;
  fecha_emision?: string;
  serie?: string;
  /** Ventas internas. El flujo de rappel usa `abonos`: leer con `documentosDe`. */
  facturas?: FacturaCompras[];
  abonos?: FacturaCompras[];
  total_facturas?: number;
  total_pedidos?: number;
  total_importe?: number;
  pedidos_revisados?: number;
  no_facturables?: NoFacturables;
  pendientes_periodos_anteriores?: PendientePeriodo[];
  lineas_sin_importe?: number;
  lineas_iva_desde_producto?: number;
  excluidos?: ExcluidoCompras[];
  error?: string;
};

export type DescartadoCompras = {
  pedido_id?: string;
  fecha?: string;
  local_id?: string;
  local_nombre?: string;
  motivo?: string;
  motivo_texto?: string;
};

export type ErrorSociedadCompras = {
  id_empresa_emisora?: string;
  empresa_emisora_nombre?: string;
  id_empresa?: string;
  empresa_nombre?: string;
  error?: string;
};

export type ResultadoCompras = PrevisualizacionCompras & {
  ejecucion?: string;
  descartados?: DescartadoCompras[];
  errores?: ErrorSociedadCompras[];
  pedidos_liberados?: unknown[];
  /** La generación se paró a medias: parte del lote puede haberse creado. */
  interrumpida?: boolean;
};

/**
 * Documentos de la respuesta. Las ventas internas los devuelven en `facturas` y
 * los abonos de rappel en `abonos`: el mismo contenido con otro nombre, así que
 * la pantalla no debería tener que saber en qué flujo está.
 */
export function documentosDe(
  respuesta: PrevisualizacionCompras | ResultadoCompras | null | undefined,
): FacturaCompras[] {
  return respuesta?.facturas ?? respuesta?.abonos ?? [];
}

// ─── Motivos de exclusión ───

/**
 * Textos de respaldo. El backend ya envía `motivo_texto` en lenguaje claro;
 * este mapa cubre respuestas antiguas o motivos nuevos sin texto.
 */
const MOTIVOS_EXCLUSION: Record<string, string> = {
  almacen_origen_sin_dato: 'El pedido no dice desde qué almacén se sirvió la mercancía',
  almacen_desconocido: 'El almacén de origen del pedido no está en el maestro de almacenes',
  almacen_no_atribuible:
    'El almacén de origen no se puede atribuir a un único local, así que no se sabe qué sociedad sirvió la mercancía',
  emisora_almacen_general_sin_configurar:
    'Falta la sociedad del Almacén General en la configuración de facturación de compras',
  local_origen_sin_empresa: 'El local que sirvió la mercancía no tiene sociedad asignada',
  local_sin_empresa: 'El local que recibió la mercancía no tiene sociedad asignada',
  local_inexistente: 'El local que recibió la mercancía ya no existe en el maestro de locales',
  empresa_inexistente: 'La sociedad que recibe no existe en el maestro de empresas',
  empresa_emisora_inexistente: 'La sociedad que sirve no existe en el maestro de empresas',
  sociedad_sin_datos_fiscales: 'La sociedad que recibe no tiene los datos fiscales necesarios',
  sociedad_emisora_sin_datos_fiscales: 'La sociedad que sirve no tiene los datos fiscales necesarios',
  iva_no_resuelto: 'No se puede determinar el tipo de IVA de alguna línea',
  pedido_sin_lineas_facturables: 'El pedido no tiene ninguna línea con importe',
  pedido_sin_rappel: 'El pedido no tiene rappel que abonar',
  devolucion: 'Es una devolución: se informa, pero anular lo facturado exige una rectificativa',
  sociedad_misma: 'Quien sirve y quien recibe son la misma sociedad',
  factura_total_cero: 'El documento quedaría a 0 €',
  validacion_emision: 'El documento no pasaría la validación de emisión',
  concurrencia: 'El pedido cambió mientras se generaba el documento',
};

/**
 * Motivos que **no** piden ninguna corrección: son decisiones del proceso, no
 * datos incompletos. Se listan aparte y en segundo plano; el resto se trata
 * como algo que hay que arreglar para que entre en la próxima tanda.
 */
const MOTIVOS_INFORMATIVOS = new Set([
  'devolucion',
  'sociedad_misma',
  'pedido_sin_lineas_facturables',
  'pedido_sin_rappel',
  'factura_total_cero',
  'concurrencia',
]);

/** Motivo en lenguaje claro: el texto del backend y, si falta, el de respaldo. */
export function textoMotivoExclusionCompras(motivo?: string, motivoTexto?: string): string {
  const texto = String(motivoTexto ?? '').trim();
  if (texto) return texto;
  const clave = String(motivo ?? '').trim();
  return MOTIVOS_EXCLUSION[clave] ?? clave ?? 'Motivo no informado';
}

/** ¿Hay que corregir un dato para que esto se facture? */
export function motivoRequiereCorreccion(motivo?: string): boolean {
  return !MOTIVOS_INFORMATIVOS.has(String(motivo ?? '').trim());
}

/** Quién queda fuera: el par de sociedades o el pedido concreto. */
function etiquetaExcluido(ex: ExcluidoCompras): ItemExcluido {
  const pedidos = Number(ex.pedidos);
  const recuento =
    Number.isFinite(pedidos) && pedidos > 0
      ? `${pedidos} ${pedidos === 1 ? 'pedido' : 'pedidos'}`
      : undefined;
  const detalle = String(ex.detalle ?? '').trim() || undefined;

  if (String(ex.ambito ?? '').trim() === 'sociedad') {
    const emisora = String(ex.empresa_emisora_nombre ?? '').trim() || String(ex.id_empresa_emisora ?? '').trim();
    const receptora = String(ex.empresa_nombre ?? '').trim() || String(ex.id_empresa ?? '').trim();
    const etiqueta = [emisora || 'Sociedad sin identificar', receptora || 'sociedad sin identificar']
      .join(' → ');
    return { etiqueta, detalle, recuento };
  }

  const local = String(ex.local_nombre ?? '').trim() || String(ex.local_id ?? '').trim();
  const pedidoId = String(ex.pedido_id ?? '').trim();
  const fecha = String(ex.fecha ?? '').trim();
  const etiqueta =
    [pedidoId, local, fecha ? fechaCorta(fecha) : ''].filter(Boolean).join(' · ') ||
    'Pedido sin identificar';
  // En ámbito de pedido, el recuento es siempre 1 y no aporta nada.
  return { etiqueta, detalle };
}

/** dd/mm/aaaa a partir de un yyyy-mm-dd; el valor original si no lo reconoce. */
function fechaCorta(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso)
    ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
    : iso;
}

/**
 * Los excluidos, en dos montones: lo que hay que corregir y lo que solo se
 * informa. Sin esta separación las devoluciones (que no piden nada) esconden a
 * una sociedad sin CIF (que impide facturar de verdad).
 */
export function clasificarExcluidosCompras(excluidos: ExcluidoCompras[]): {
  correccion: GrupoExcluidos[];
  informativos: GrupoExcluidos[];
} {
  const fns = {
    motivo: (e: ExcluidoCompras) => String(e.motivo ?? '').trim(),
    texto: (e: ExcluidoCompras) => textoMotivoExclusionCompras(e.motivo, e.motivo_texto),
    item: etiquetaExcluido,
  };
  return {
    correccion: agruparPorMotivo(
      excluidos.filter((e) => motivoRequiereCorreccion(e.motivo)),
      fns,
    ),
    informativos: agruparPorMotivo(
      excluidos.filter((e) => !motivoRequiereCorreccion(e.motivo)),
      fns,
    ),
  };
}

// ─── Estado de facturación de un pedido (listados de compras) ───

type PedidoConMarca = Record<string, unknown>;

/** Marcas que congelan el pedido, con la etiqueta de su documento. */
const MARCAS_FACTURACION: { id: string; numero: string; periodo?: string; etiqueta: string }[] = [
  {
    id: 'factura_ventas_id',
    numero: 'factura_ventas_numero',
    periodo: 'factura_ventas_periodo',
    etiqueta: 'la factura de ventas internas',
  },
  {
    id: 'factura_rappel_id',
    numero: 'factura_rappel_numero',
    periodo: 'factura_rappel_periodo',
    etiqueta: 'el abono de rappel',
  },
];

function texto(pedido: PedidoConMarca, campo?: string): string {
  if (!campo) return '';
  const v = pedido?.[campo];
  return v == null ? '' : String(v).trim();
}

export type EstadoFacturacionPedido = {
  /**
   * `facturado`: tiene documento y el backend rechaza cambiarlo.
   * `pendiente`: completado y sin facturar, entrará en la tanda de su mes.
   * `no_aplica`: todavía no está completado, así que no entra en la facturación.
   */
  estado: 'facturado' | 'pendiente' | 'no_aplica';
  /** Etiqueta corta para la celda de la tabla. */
  texto: string;
  /** Explicación en lenguaje claro; vacía si no hay nada que explicar. */
  detalle: string;
  /** Números (o identificadores) de los documentos que lo congelan. */
  referencias: string[];
};

/**
 * Estado de facturación de un pedido, con el mismo criterio que
 * `api/routes/pedidos.js`: basta una marca para que el pedido esté congelado.
 * Las facturas generadas nacen en borrador y sin numeración, así que el número
 * puede faltar y entonces se nombra por su identificador.
 */
export function estadoFacturacionPedido(pedido: PedidoConMarca | null | undefined): EstadoFacturacionPedido {
  const item = pedido ?? {};
  const referencias: string[] = [];
  const documentos: string[] = [];
  let periodo = '';
  for (const marca of MARCAS_FACTURACION) {
    const id = texto(item, marca.id);
    if (!id) continue;
    referencias.push(texto(item, marca.numero) || id);
    documentos.push(marca.etiqueta);
    if (!periodo) periodo = texto(item, marca.periodo);
  }

  if (referencias.length > 0) {
    const cual = documentos.join(' y ');
    return {
      estado: 'facturado',
      texto: periodo ? labelPeriodoCorto(periodo) : 'Facturado',
      detalle:
        `Este pedido ya está facturado en ${referencias.join(' y ')}: no se puede modificar ni borrar. ` +
        `Para cambiarlo hay que rectificar ${cual}.`,
      referencias,
    };
  }

  const completado = texto(item, 'Estado') === 'Completado';
  if (!completado) {
    return {
      estado: 'no_aplica',
      texto: '—',
      detalle: 'Solo los pedidos completados entran en la facturación mensual.',
      referencias: [],
    };
  }
  return {
    estado: 'pendiente',
    texto: 'Pendiente',
    detalle: 'Entrará en la facturación mensual del mes al que corresponde su fecha.',
    referencias: [],
  };
}

/** Atajo para condicionar acciones que el backend rechaza si el pedido está facturado. */
export function pedidoFacturado(pedido: PedidoConMarca | null | undefined): boolean {
  return estadoFacturacionPedido(pedido).estado === 'facturado';
}
