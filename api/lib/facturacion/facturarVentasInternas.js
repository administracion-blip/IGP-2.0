/**
 * Facturación mensual de las ventas internas del grupo.
 *
 * Cada mes, los pedidos servidos desde un almacén a los locales se convierten en
 * facturas en **borrador** entre la sociedad que sirve y la sociedad que recibe:
 * no se llama a la emisión, así que generar no consume numeración (las ventas
 * nacen sin número y el correlativo se reserva al emitir).
 *
 * Este fichero es solo la **política** del dominio. La mecánica —cerrojo,
 * recuperación de meses perdidos, barrido de reconciliación, reclamo atómico,
 * escritura de la factura y descarte de importes a cero— vive en
 * `facturacionPeriodica.js` y la comparte con la facturación de mantenimiento.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECISIONES DE NEGOCIO QUE CONDICIONAN EL CÓDIGO
 *
 * **Emisora: la sociedad del almacén desde el que se sirvió** (`AlmacenOrigenId`).
 * A diferencia de mantenimiento, no es fija: la resuelve el dominio pedido a
 * pedido, y el motor solo mueve los grupos que aquí se forman.
 * - Almacén General (nombre exacto normalizado `almacen general` en
 *   `igp_Almacenes`, el mismo criterio que ya usa `api/routes/pedidos.js`): la
 *   sociedad se lee de la configuración, porque el almacén central no pertenece
 *   a ningún local y no hay nada de donde deducirla.
 * - Almacén de un local: la sociedad es el `id_empresa` de ese local. El vínculo
 *   va del `Id` del almacén a su nombre y del nombre al local, porque el local
 *   guarda una **lista de nombres** de almacén en el campo `almacen origen`. Si
 *   el almacén no se puede atribuir a un único local, el pedido se excluye: no
 *   se elige un local al azar.
 *
 * **Receptora: la sociedad del local que recibe** (`LocalId`). Se usa
 * `factura_id_empresa_local`, que `api/routes/pedidos.js` congela al completar
 * el pedido, y solo se cae al `id_empresa` del maestro si falta: entre que se
 * sirve la mercancía y se factura el mes, un local puede cambiar de sociedad y
 * la factura saldría a nombre de la equivocada.
 *
 * **Una factura por par emisora–receptora**, con las líneas agrupadas por local
 * de origen y, dentro de cada uno, **por tipo de IVA**: una factura necesita su
 * desglose de impuestos correcto y en un mismo local pueden convivir productos
 * al 10 % y al 21 %. Emisora y receptora iguales no producen factura: una
 * sociedad no se factura a sí misma.
 *
 * **Fecha de emisión y de operación: el último día del periodo facturado.** La
 * factura de diciembre, aunque se genere el 1 de enero, debe llevar numeración
 * del año que se cierra (el correlativo se ancla por año de `fecha_emision`).
 *
 * **Selección: la ventana del periodo.** Entran los pedidos `Completado` cuya
 * fecha de referencia cae en el periodo, no todo lo pendiente anterior. Es lo
 * que evita que activar esto facture de golpe el histórico entero en un único
 * documento fechado a fin de mes, y hace que un pedido completado tarde caiga
 * en el periodo siguiente por su propia fecha. Un pedido que se quedó fuera por
 * un dato incompleto se recupera **volviendo a generar su periodo** una vez
 * corregido: la marca de cada pedido hace que repetir un periodo sea idempotente
 * y solo recoja lo que falta. Para que ese hueco no pase inadvertido, la
 * previsualización cuenta los pedidos sin facturar de periodos anteriores.
 *
 * Configuración en `Igp_Ajustes`, PK 'compras' / SK 'facturacion'. Si el ítem no
 * existe se usan los valores por defecto, con la generación automática
 * desactivada: nada debe emitirse solo por desplegar esto.
 */

import { validarDatosEmision } from './emitirFactura.js';
import { construirFacturaConLineas } from './construirFactura.js';
import {
  crearCerrojo,
  facturasDelPeriodo as facturasDelPeriodoPorClave,
  generarPeriodo,
  leerAjustesPeriodicos,
  marcarIntentoGeneracion as marcarIntentoGeneracionPeriodica,
  marcarPeriodoGenerado as marcarPeriodoGeneradoPeriodico,
  previsualizarPeriodo,
  round2,
  ultimoDiaPeriodo,
  validarSerie as validarSeriePeriodica,
} from './facturacionPeriodica.js';
import {
  MOTIVOS_COMUNES,
  baseSegunInforme,
  cargarContextoPedidos,
  claveGrupo,
  cortePedidos,
  desgloseImpuestos,
  desgloseLocalesDestino,
  desgloseOrigenes,
  liberarPedido,
  lineasDocumentoDePedidos,
  normalizarIdEmpresa,
  planificarDocumentos,
  reclamarPedido,
  buscarPedidosMarcados,
} from './pedidosSociedades.js';

export {
  periodoValido,
  periodoDe,
  periodoAnterior,
  periodoSiguiente,
  periodosPendientes,
  ultimoDiaPeriodo,
} from './facturacionPeriodica.js';

export const AJUSTES_FACTURACION_PK = 'compras';
export const AJUSTES_FACTURACION_SK = 'facturacion';
/** Cerrojo de ejecución: mismo PK que la configuración para tenerlo a la vista. */
const AJUSTES_FACTURACION_SK_CERROJO = 'facturacion_lock';

const CLAVES_AJUSTES = { pk: AJUSTES_FACTURACION_PK, sk: AJUSTES_FACTURACION_SK };
/** Prefijo de los logs del dominio. */
const ETIQUETA = 'facturar ventas internas';

export const SERIE_VENTAS_DEFECTO = 'FMI';
export const SERIE_RAPPEL_DEFECTO = 'FRAPPEL';
export const DIA_GENERACION_DEFECTO = 1;
export const HORA_DEFECTO = '06:00';

/**
 * Marca de facturación del pedido.
 *
 * `factura_ventas_id` es el contrato con `api/routes/pedidos.js`: es el único
 * campo con el que ese router decide que un pedido tiene su venta facturada y
 * congela su importe y su periodo. El número (`factura_ventas_numero`) no se
 * escribe aquí a propósito: la factura nace en borrador y sin numeración, y el
 * router ya sabe nombrarla por su identificador mientras el número falte.
 *
 * Los otros cuatro campos son de este proceso: el periodo facturado, la fecha de
 * la marca (la que usa el barrido de reconciliación para decidir si un pedido
 * quedó huérfano), la ejecución que la escribió y la sociedad emisora.
 */
const CAMPOS_MARCA = {
  id: 'factura_ventas_id',
  periodo: 'factura_ventas_periodo',
  fecha: 'factura_ventas_fecha',
  ejecucion: 'factura_ventas_ejecucion',
  idEmpresa: 'factura_ventas_id_empresa',
};

const cerrojo = crearCerrojo({
  pk: AJUSTES_FACTURACION_PK,
  sk: AJUSTES_FACTURACION_SK_CERROJO,
  etiqueta: ETIQUETA,
  mensajeOcupado: (desde) =>
    `Ya hay una generación de facturas de ventas internas en curso${desde}. Espera a que termine e inténtalo de nuevo.`,
});

/**
 * ¿Hay una generación en vuelo? Lo usa el trabajo programado para no disparar
 * una petición cada minuto que rebotaría con 409 y marcaría fallo.
 */
export function hayGeneracionEnCurso() {
  return cerrojo.hayEnCurso();
}

/** Corte de selección: primer día del mes siguiente al periodo (excluido). */
export function corteVentas(periodo) {
  return cortePedidos(periodo);
}

// ─── Ajustes ───

/**
 * Configuración de la facturación. Tolerante a que el ítem no exista o a que la
 * lectura falle: en ese caso, valores por defecto (con la generación automática
 * desactivada, que es como nace).
 *
 * La serie de la mercancía se guarda en `serie_ventas` porque el mismo ítem
 * lleva también la de los abonos de rappel (`serie_rappel`, que consume
 * `facturarRappel.js`).
 */
export async function leerAjustesFacturacion() {
  return leerAjustesPeriodicos({
    ...CLAVES_AJUSTES,
    etiqueta: ETIQUETA,
    campoSerie: 'serie_ventas',
    defecto: {
      // Sin valor por defecto a conciencia: la sociedad del Almacén General no
      // se puede deducir y elegir una mal factura a la sociedad equivocada.
      id_empresa_almacen_general: '',
      serie: SERIE_VENTAS_DEFECTO,
      serie_rappel: SERIE_RAPPEL_DEFECTO,
      dia_generacion: DIA_GENERACION_DEFECTO,
      hora: HORA_DEFECTO,
      condiciones_pago: '',
      enabled: false,
      ultimo_periodo_generado: '',
    },
    extra: (item, defecto) => ({
      id_empresa_almacen_general: normalizarIdEmpresa(item.id_empresa_almacen_general),
      serie_rappel: String(item.serie_rappel ?? '').trim() || defecto.serie_rappel,
    }),
  });
}

export function marcarPeriodoGenerado(periodo, resumen = {}) {
  return marcarPeriodoGeneradoPeriodico(CLAVES_AJUSTES, periodo, resumen);
}

export function marcarIntentoGeneracion({ periodo = '', estado, mensaje = '' }) {
  return marcarIntentoGeneracionPeriodica(CLAVES_AJUSTES, { periodo, estado, mensaje });
}

function validarSerieVentas(ajustes) {
  return validarSeriePeriodica(ajustes.serie, {
    tipo: 'OUT',
    textoConfig: 'la configuración de facturación de compras',
    etiquetaProceso: 'las ventas internas',
  });
}

/**
 * Facturas de ventas internas ya creadas para un periodo, indexadas por el par
 * de sociedades: es la clave de "ya hay factura de esto".
 */
function facturasDelPeriodo(periodo) {
  return facturasDelPeriodoPorClave({
    campoPeriodo: 'ventas_internas_periodo',
    periodo,
    clave: (f) => claveGrupo(String(f.emisor_id ?? '').trim(), String(f.empresa_id ?? '').trim()),
  });
}

// ─── Planificación ───

const MOTIVOS = {
  ...MOTIVOS_COMUNES,
  iva_no_resuelto:
    'No se puede determinar el tipo de IVA de alguna línea: no lo tiene el pedido y el maestro de productos tampoco',
  pedido_sin_lineas_facturables: 'El pedido no tiene ninguna línea con importe',
  devolucion:
    'Es una devolución: la mercancía vuelve al almacén y anular lo ya facturado exige una rectificativa, no una factura nueva',
  factura_total_cero: 'La factura quedaría a 0 €',
  validacion_emision: 'La factura no pasaría la validación de emisión',
  concurrencia: 'El pedido cambió mientras se generaba la factura',
};

function excluido(motivo, datos = {}, detalle = '') {
  return {
    motivo,
    motivo_texto: MOTIVOS[motivo] || motivo,
    ...(detalle && { detalle }),
    ...datos,
  };
}

/**
 * Líneas de la factura: una por cada producto de cada pedido/albarán.
 */
function lineasFacturaDePedidos(pedidos) {
  return lineasDocumentoDePedidos(pedidos);
}

/** Datos del cuerpo de la factura, tal como los espera el constructor. */
function datosFactura({ emisora, receptora, periodo, ajustes, lineas }) {
  const fecha = ultimoDiaPeriodo(periodo);
  return {
    tipo: 'OUT',
    serie: ajustes.serie,
    emisor_id: emisora.id_empresa,
    emisor_nombre: emisora.nombre,
    emisor_cif: emisora.cif,
    emisor_direccion: emisora.direccion,
    emisor_cp: emisora.cp,
    emisor_municipio: emisora.municipio,
    emisor_provincia: emisora.provincia,
    emisor_email: emisora.email,
    emisor_iban: emisora.iban,
    empresa_id: receptora.id_empresa,
    empresa_nombre: receptora.nombre,
    empresa_cif: receptora.cif,
    empresa_direccion: receptora.direccion,
    empresa_cp: receptora.cp,
    empresa_municipio: receptora.municipio,
    empresa_provincia: receptora.provincia,
    empresa_email: receptora.email,
    // Fecha de operación = fecha de emisión = último día del periodo facturado.
    fecha_emision: fecha,
    fecha_operacion: fecha,
    condiciones_pago: ajustes.condiciones_pago,
    observaciones: `Ventas internas del grupo · mercancía servida en el periodo ${periodo}`,
    lineas,
  };
}

/**
 * Marcas propias de la factura: la identifican como generada por este proceso y
 * permiten avisar de que un periodo ya tiene factura para el par de sociedades.
 */
function marcarFactura({ factura, lineas }, pedidos, periodo, { ejecucion = '', origen = '' } = {}) {
  return {
    factura: {
      ...factura,
      ventas_internas_periodo: periodo,
      ventas_internas_origen: origen,
      ventas_internas_ejecucion: ejecucion,
      ventas_internas_pedidos: pedidos.length,
    },
    lineas,
  };
}

/**
 * Política de este dominio para el planificador compartido de pedidos.
 *
 * La venta factura `TotalLinea` en positivo. Las devoluciones se excluyen: una
 * devolución deshace una venta ya facturada y eso exige una rectificativa, no
 * una factura nueva. Un pedido completado sin ninguna línea con importe sí es
 * una anomalía, así que se informa pedido a pedido.
 */
const POLITICA = {
  campoMarca: CAMPOS_MARCA.id,
  campoImporte: 'TotalLinea',
  motivos: MOTIVOS,
  motivoIva: 'iva_no_resuelto',
  motivoSinLineas: 'pedido_sin_lineas_facturables',
  sinImporteEsNormal: false,
  excluirDevoluciones: true,
  validar: validarDatosEmision,
  construirDocumento: ({ emisora, receptora, periodo, ajustes }) => (pedidos, opciones = {}) =>
    marcarFactura(
      construirFacturaConLineas({
        id_factura: opciones.idFactura || 'PREVISUALIZACION',
        datos: datosFactura({
          emisora,
          receptora,
          periodo,
          ajustes,
          lineas: lineasFacturaDePedidos(pedidos),
        }),
      }),
      pedidos,
      periodo,
      opciones
    ),
};

/** Calcula qué se facturaría del periodo, sin escribir nada. */
export function planificarFacturacion({ periodo, ajustes, contexto }) {
  return planificarDocumentos({ periodo, ajustes, contexto, politica: POLITICA });
}

/** Quita del informe los datos internos que no interesan al cliente. */
function facturaPublica(f, facturasExistentes) {
  const existentes = facturasExistentes?.get(claveGrupo(f.id_empresa_emisora, f.id_empresa)) ?? [];
  return {
    id_empresa_emisora: f.id_empresa_emisora,
    empresa_emisora_nombre: f.empresa_emisora_nombre,
    empresa_emisora_cif: f.empresa_emisora_cif,
    id_empresa: f.id_empresa,
    empresa_nombre: f.empresa_nombre,
    empresa_cif: f.empresa_cif,
    num_pedidos: f.num_pedidos,
    base: f.base,
    iva: f.iva,
    total: f.total,
    ...(f.descuadre_centimos !== 0 && {
      descuadre_centimos: f.descuadre_centimos,
      base_informe: f.base_informe,
    }),
    impuestos: f.impuestos,
    origenes: f.origenes,
    locales: f.locales,
    ...(existentes.length > 0 && {
      aviso: `Ya existe ${existentes.length === 1 ? 'una factura' : `${existentes.length} facturas`} de ventas internas de este periodo entre estas dos sociedades: se crearía otra factura aparte.`,
      facturas_existentes: existentes,
    }),
  };
}

// ─── Dominio: lo que la mecánica de facturación periódica necesita saber ───

const dominio = {
  etiqueta: ETIQUETA,
  claves: CLAVES_AJUSTES,
  cerrojo,
  nombreElemento: 'el pedido',
  usuarioAuditoria: 'Facturación de ventas internas',
  mensajeCerrojoPerdido:
    'Otra generación tomó el cerrojo mientras esta seguía en marcha: se ha parado sin escribir la factura y los pedidos quedan libres.',
  mensajeCerrojoEnDuda: (minutos) =>
    `No se ha podido confirmar el cerrojo contra la base de datos desde hace ${minutos} min: se ha parado sin escribir la factura y los pedidos quedan libres, porque a partir de ese margen otra generación podría haberlo tomado.`,

  leerAjustes: leerAjustesFacturacion,
  validarSerie: validarSerieVentas,

  cargarContexto: async ({ periodo }) => {
    const [contexto, facturasExistentes] = await Promise.all([
      cargarContextoPedidos(),
      facturasDelPeriodo(periodo),
    ]);
    return { ...contexto, facturasExistentes };
  },

  planificar: ({ periodo, ajustes, contexto }) => planificarFacturacion({ periodo, ajustes, contexto }),

  reconciliacion: {
    // Un único ámbito: la tabla de pedidos no tiene índice por local, así que se
    // recorre entera una sola vez en vez de una por local.
    ambitos: () => [{ etiqueta: 'pedidos' }],
    buscarMarcados: (_ambito, limite) => buscarPedidosMarcados(CAMPOS_MARCA, limite),
    idFacturaDe: (pedido) => String(pedido.factura_ventas_id ?? '').trim(),
    ejecucionDe: (pedido) => String(pedido.factura_ventas_ejecucion ?? ''),
    describir: (pedido) => ({
      pedido_id: String(pedido.Id ?? ''),
      local_id: String(pedido.LocalId ?? '').trim(),
      factura_ventas_id: String(pedido.factura_ventas_id ?? '').trim(),
      periodo: String(pedido.factura_ventas_periodo ?? ''),
    }),
  },

  referencia: (pedido) => pedido.Id,
  liberarElemento: (pedido, idFactura) => liberarPedido(pedido, CAMPOS_MARCA, idFactura),
  reclamarElemento: (pedido, { idFactura, periodo, grupo, ejecucion, fecha }) =>
    reclamarPedido(pedido, CAMPOS_MARCA, {
      idFactura,
      periodo,
      ejecucion,
      fecha,
      idEmpresaEmisora: grupo.id_empresa_emisora,
    }),
  // No hay cierres sin factura: la ventana de selección es el propio periodo, así
  // que un pedido no facturable no vuelve a girar en las tandas siguientes.
  cerrarSinFactura: async () => false,

  identidadGrupo: (f) => ({
    id_empresa_emisora: f.id_empresa_emisora,
    empresa_emisora_nombre: f.empresa_emisora_nombre,
    id_empresa: f.id_empresa,
    empresa_nombre: f.empresa_nombre,
  }),
  excluirGrupo: (motivo, f, numPedidos, detalle) =>
    excluido(
      motivo,
      {
        ambito: 'sociedad',
        id_empresa_emisora: f.id_empresa_emisora,
        empresa_emisora_nombre: f.empresa_emisora_nombre,
        id_empresa: f.id_empresa,
        empresa_nombre: f.empresa_nombre,
        pedidos: numPedidos,
      },
      detalle
    ),
  describirDescartado: (pedido, f) => ({
    pedido_id: pedido.Id,
    fecha: pedido.fecha,
    local_id: pedido.local_id,
    local_nombre: pedido.local_nombre,
    id_empresa_emisora: f.id_empresa_emisora,
    id_empresa: f.id_empresa,
    motivo: 'concurrencia',
    motivo_texto: MOTIVOS.concurrencia,
  }),
  describirCerrado: () => ({}),

  detalleAuditoria: ({ grupo, factura, reclamados, periodo, ajustes, origen }) => ({
    origen: `ventas_internas_${origen}`,
    periodo,
    serie: ajustes.serie,
    id_empresa_emisora: grupo.id_empresa_emisora,
    pedidos: reclamados.length,
    total_factura: factura.total_factura,
  }),

  describirFacturaCreada: ({ idFactura, grupo, factura, lineas, reclamados, ajustes, contexto }) => {
    // El descuadre y los desgloses se recalculan sobre los pedidos realmente
    // facturados, que pueden ser menos que los planificados.
    const baseInforme = baseSegunInforme(reclamados);
    const descuadreCentimos = Math.round(round2(factura.base_imponible - baseInforme) * 100);
    return {
      id_factura: idFactura,
      id_empresa_emisora: grupo.id_empresa_emisora,
      empresa_emisora_nombre: grupo.empresa_emisora_nombre,
      empresa_emisora_cif: grupo.empresa_emisora_cif,
      id_empresa: grupo.id_empresa,
      empresa_nombre: grupo.empresa_nombre,
      empresa_cif: grupo.empresa_cif,
      serie: ajustes.serie,
      estado: factura.estado,
      fecha_emision: factura.fecha_emision,
      base: factura.base_imponible,
      iva: factura.total_iva,
      total: factura.total_factura,
      num_pedidos: reclamados.length,
      num_lineas: lineas.length,
      ...(descuadreCentimos !== 0 && { descuadre_centimos: descuadreCentimos, base_informe: baseInforme }),
      impuestos: desgloseImpuestos(lineas),
      origenes: desgloseOrigenes(reclamados),
      locales: desgloseLocalesDestino(reclamados),
      pedidos: reclamados.map((p) => ({
        id: p.Id,
        fecha: p.fecha,
        local_id: p.local_id,
        local_nombre: p.local_nombre,
        origen_nombre: p.origen_nombre,
      })),
      ...(contexto.facturasExistentes.get(claveGrupo(grupo.id_empresa_emisora, grupo.id_empresa))?.length > 0 && {
        aviso: 'Ya había una factura de ventas internas de este periodo entre estas dos sociedades: esta es adicional.',
      }),
    };
  },

  construirResumen: ({ creadas, excluidos, descartados, errores, origen, ejecucion }) => ({
    facturas: creadas.length,
    pedidos: creadas.reduce((s, f) => s + f.num_pedidos, 0),
    importe: round2(creadas.reduce((s, f) => s + f.total, 0)),
    excluidos: excluidos.length,
    descartados: descartados.length,
    errores: errores.length,
    origen,
    ejecucion,
  }),

  describirPrevisualizacion: ({ periodo, ajustes, contexto, plan }) => ({
    ok: true,
    periodo,
    inicio_seleccion: plan.inicio,
    corte_seleccion: plan.corte,
    fecha_emision: ultimoDiaPeriodo(periodo),
    serie: ajustes.serie,
    facturas: plan.facturas.map((f) => facturaPublica(f, contexto.facturasExistentes)),
    total_facturas: plan.facturas.length,
    total_pedidos: plan.facturas.reduce((s, f) => s + f.num_pedidos, 0),
    total_importe: round2(plan.facturas.reduce((s, f) => s + f.total, 0)),
    pedidos_revisados: plan.candidatos,
    no_facturables: plan.no_facturables,
    pendientes_periodos_anteriores: plan.pendientes_periodos_anteriores,
    lineas_sin_importe: plan.lineas_sin_importe,
    lineas_iva_desde_producto: plan.lineas_iva_desde_producto,
    excluidos: plan.excluidos,
  }),

  describirGeneracion: ({
    periodo,
    ajustes,
    plan,
    ejecucion,
    creadas,
    descartados,
    excluidos,
    liberados,
    errores,
    resumen,
    interrumpida,
    parcial,
    motivo_incompleto,
  }) => ({
    ok: true,
    periodo,
    inicio_seleccion: plan.inicio,
    corte_seleccion: plan.corte,
    fecha_emision: ultimoDiaPeriodo(periodo),
    serie: ajustes.serie,
    ejecucion,
    facturas: creadas,
    total_facturas: creadas.length,
    total_pedidos: resumen.pedidos,
    total_importe: resumen.importe,
    pedidos_revisados: plan.candidatos,
    no_facturables: plan.no_facturables,
    pendientes_periodos_anteriores: plan.pendientes_periodos_anteriores,
    lineas_iva_desde_producto: plan.lineas_iva_desde_producto,
    descartados,
    excluidos,
    pedidos_liberados: liberados,
    errores,
    ...(interrumpida && { interrumpida: true }),
    // El periodo no se ha marcado como generado: la tanda siguiente lo reintenta
    // y recoge solo los pedidos que quedaron sin facturar.
    ...(parcial && { parcial: true, motivo_incompleto, periodo_no_marcado: true }),
  }),
};

// ─── API pública del módulo ───

/**
 * Previsualización: qué se facturaría del periodo, sin escribir nada.
 * @returns {Promise<{ ok: true, ... } | { ok: false, status: number, error: string }>}
 */
export function previsualizarFacturacionVentasInternas({ periodo } = {}) {
  return previsualizarPeriodo(dominio, { periodo });
}

/**
 * Genera las facturas del periodo en estado borrador.
 * @returns {Promise<{ ok: true, ... } | { ok: false, status: number, error: string }>}
 */
export function generarFacturacionVentasInternas({
  periodo,
  usuario_id = '',
  usuario_nombre = '',
  origen = 'manual',
} = {}) {
  return generarPeriodo(dominio, { periodo, usuario_id, usuario_nombre, origen });
}

/** Solo para pruebas: el contrato de dominio que consume el motor compartido. */
export const _dominio = dominio;
