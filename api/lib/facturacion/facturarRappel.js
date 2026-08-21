/**
 * Liquidación mensual del rappel de los pedidos internos, como **abono**.
 *
 * Cada mes, el rappel acumulado en las líneas de pedido (`TotalRappel`) se
 * convierte en un abono en **borrador** —importes negativos— entre las mismas dos
 * sociedades que intervienen en la venta de la mercancía. Documento aparte de la
 * factura de venta y con marca propia en el pedido (`factura_rappel_id`), así que
 * un pedido puede tener la venta facturada y el rappel sin abonar, o al revés.
 *
 * La mecánica —cerrojo, recuperación de meses perdidos, barrido de
 * reconciliación, reclamo atómico y escritura— es la de `facturacionPeriodica.js`.
 * La maquinaria de pedidos —emisor, receptor, ventana temporal, IVA de línea— es
 * la de `pedidosSociedades.js`, compartida con las ventas internas para que la
 * venta y su abono no puedan salir a nombre de sociedades distintas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECISIÓN 1 · DIRECCIÓN DEL ABONO: **lo emite quien sirvió la mercancía**
 *
 * Emisor = sociedad del almacén de origen (la que vendió). Receptor = sociedad
 * del local (la que compró). Importes negativos. Es decir, **quien vendió emite
 * un abono que reduce su venta**, no "quien compró factura el incentivo".
 *
 * No es una preferencia: es lo que ya dice el sistema en tres sitios.
 *  1. El informe `GET /pedidos/abonos?modo=abonos` define el rappel, con esas
 *     palabras, como «lo que el almacén debe abonar al local». Almacén → local:
 *     el que sirve es el que abona.
 *  2. La serie `FRAPPEL` está dada de alta en `Igp_FacturasSeries` como
 *     `tipo: 'OUT'`, «Facturas bonificadas por rappels». `OUT` es serie de
 *     **emisión nuestra** y la numeración de estas series va por sociedad
 *     emisora. Si el abono lo emitiera el local que compra, el documento
 *     tendría que nacer como gasto (`IN`) en la contabilidad de quien sirve, y
 *     entonces `FRAPPEL` no podría ser la serie: las series de gasto no llevan
 *     nuestro correlativo.
 *  3. El rappel nace del módulo de acuerdos comerciales (`Aportacion + Rappel +
 *     DescuentoExtra` por unidad, en `igp_AcuerdosDetalles`): es un incentivo que
 *     el proveedor concede sobre la compra y que el grupo traslada al local que
 *     consumió el producto. Trasladar una bonificación sobre una venta propia es
 *     un abono del vendedor, no una prestación de servicio del comprador.
 *
 * **Para invertirla** (que el local emita una factura de rappel a quien sirvió)
 * hay que tocar cuatro cosas, y ninguna está enterrada:
 *  a) `POLITICA.signoDe`: pasar de -1 a +1 los pedidos y de +1 a -1 las
 *     devoluciones, y `POLITICA.es_abono` a `false` (dejaría de ser un abono:
 *     sería una factura ordinaria).
 *  b) `datosAbono()`: intercambiar los bloques `emisor_*` y `empresa_*`, que es
 *     literalmente invertir emisor y receptor.
 *  c) La serie: `FRAPPEL` tendría que dejar de ser de emisión (`tipo: 'OUT'`)
 *     para la sociedad que sirve, o usarse una serie propia del local emisor.
 *     Con la numeración por sociedad emisora que ya existe, el correlativo
 *     pasaría a consumirlo el local.
 *  d) La clasificación fiscal: dejaría de ser rectificativa por diferencias
 *     (ver DECISIÓN 2) y sería una factura ordinaria por el incentivo, así que
 *     `es_rectificativa`, `rectificativa_tipo` y `motivo_rectificacion` se
 *     quedarían vacíos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECISIÓN 2 · QUÉ DOCUMENTO ES, DE CARA A VERI*FACTU
 *
 * VERI*FACTU no tiene un tipo "abono": un abono es una **factura rectificativa**.
 * El sistema ya tiene ese camino (`POST /facturacion/facturas/:id/rectificar`,
 * campos `es_rectificativa` / `factura_rectificada_id` /
 * `motivo_rectificacion`), y se reutiliza en vez de inventar un tipo nuevo.
 *
 * Pero no es la misma rectificativa. La que existe es **por sustitución**: copia
 * una factura concreta para rehacerla. El abono de rappel no rehace ninguna
 * factura: liquida el rappel acumulado de un mes, que es una **modificación de
 * la base imponible por descuentos posteriores a la operación** (art. 80.1.2º
 * LIVA) y se documenta rectificando **por diferencias**, sin necesidad de
 * identificar factura por factura cuando se rectifican operaciones de un periodo
 * (art. 15.4 RD 1619/2012). De ahí que el documento salga con:
 *
 *   es_abono: true                  → el signo negativo es intencionado
 *   es_rectificativa: true          → para VERI*FACTU es rectificativa (R1)
 *   rectificativa_tipo: 'diferencias'
 *   factura_rectificada_id: ''      → vacío **a propósito**: no rectifica una
 *                                     factura, rectifica un periodo
 *   motivo_rectificacion            → el periodo liquidado y la base legal
 *
 * `factura_rectificada_id` vacío es la señal que distingue las dos: un envío a
 * VERI*FACTU debe mapear «rectificativa con factura señalada» a sustitución y
 * «rectificativa sin factura señalada, con `rectificativa_tipo` a diferencias» a
 * R1 por diferencias, con el periodo como referencia rectificada.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECISIÓN 3 · EL IVA DEL RAPPEL: EL DE LA MERCANCÍA QUE LO GENERÓ
 *
 * El acuerdo comercial no guarda ningún tipo de IVA (`igp_AcuerdosDetalles` solo
 * tiene `Aportacion`, `Rappel`, `DescuentoExtra` y la cantidad), así que el tipo
 * no puede salir de ahí. Sale de la **línea de pedido** que generó el rappel, con
 * exactamente la misma cadena que las ventas (`tipoIvaDeLinea`: `VatRate` de la
 * línea y, si no lo dice, el maestro de productos). Y no es un apaño: si el
 * rappel reduce la base imponible de una entrega, la reduce **al tipo de esa
 * entrega**; abonar al 21 % un producto entregado al 10 % devolvería una cuota
 * que nunca se ingresó.
 *
 * Igual que en ventas, un tipo que no se puede determinar excluye el pedido y se
 * explica. Nunca se inventa un tipo por defecto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECISIÓN 4 · UN RAPPEL DE CERO NO GENERA DOCUMENTO
 *
 * La mayoría de los pedidos no llevan rappel: solo lo llevan los productos con
 * acuerdo vigente. Un pedido sin ninguna línea con `TotalRappel` mayor que 0 no
 * es una anomalía —se cuenta y no se denuncia—, y un par de sociedades cuyo
 * rappel neto del mes sea 0 no produce documento (lo descarta el motor por total
 * a cero). Así ninguna sociedad recibe un abono vacío cada mes.
 *
 * Configuración en `Igp_Ajustes`, PK 'compras' / SK 'facturacion': el **mismo**
 * ítem que las ventas internas, con `serie_rappel` como serie y marcadores de
 * periodo propios (sufijo `_rappel`). Generación desactivada por defecto.
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
  TIPO_DEVOLUCION,
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
/**
 * Cerrojo **propio**, distinto del de las ventas internas: los dos procesos
 * recorren los mismos pedidos pero escriben marcas distintas, así que pueden
 * correr a la vez sin pisarse y no tiene sentido que uno espere al otro.
 */
const AJUSTES_FACTURACION_SK_CERROJO = 'facturacion_rappel_lock';

/**
 * Sufijo de los marcadores de este dominio dentro del ítem de ajustes que
 * comparte con las ventas internas: `ultimo_periodo_generado_rappel`,
 * `ultimo_intento_estado_rappel`… Sin él, generar el abono daría por generada la
 * venta del mismo mes y el trabajo programado no volvería a intentarla.
 */
const SUFIJO_MARCADORES = '_rappel';

const CLAVES_AJUSTES = {
  pk: AJUSTES_FACTURACION_PK,
  sk: AJUSTES_FACTURACION_SK,
  sufijo: SUFIJO_MARCADORES,
};
/** Prefijo de los logs del dominio. */
const ETIQUETA = 'facturar rappel';

export const SERIE_RAPPEL_DEFECTO = 'FRAPPEL';
export const DIA_GENERACION_DEFECTO = 1;
export const HORA_DEFECTO = '06:00';

/**
 * Marca de rappel del pedido.
 *
 * `factura_rappel_id` es el contrato con `api/routes/pedidos.js`: con esa marca
 * puesta, ese router congela el pedido igual que con la de ventas. El número
 * (`factura_rappel_numero`) no se escribe aquí: el abono nace en borrador y sin
 * numeración, y el router ya sabe nombrarlo por su identificador.
 */
const CAMPOS_MARCA = {
  id: 'factura_rappel_id',
  periodo: 'factura_rappel_periodo',
  fecha: 'factura_rappel_fecha',
  ejecucion: 'factura_rappel_ejecucion',
  idEmpresa: 'factura_rappel_id_empresa',
};

const cerrojo = crearCerrojo({
  pk: AJUSTES_FACTURACION_PK,
  sk: AJUSTES_FACTURACION_SK_CERROJO,
  etiqueta: ETIQUETA,
  mensajeOcupado: (desde) =>
    `Ya hay una generación de abonos de rappel en curso${desde}. Espera a que termine e inténtalo de nuevo.`,
});

/**
 * ¿Hay una generación en vuelo? Lo usa el trabajo programado para no disparar
 * una petición cada minuto que rebotaría con 409 y marcaría fallo.
 */
export function hayGeneracionEnCurso() {
  return cerrojo.hayEnCurso();
}

/** Corte de selección: primer día del mes siguiente al periodo (excluido). */
export function corteRappel(periodo) {
  return cortePedidos(periodo);
}

// ─── Ajustes ───

/**
 * Configuración de la liquidación. Mismo ítem que las ventas internas —misma
 * sociedad de Almacén General, mismo día y hora, mismas condiciones de pago— y
 * la serie leída de `serie_rappel`.
 */
export async function leerAjustesRappel() {
  return leerAjustesPeriodicos({
    ...CLAVES_AJUSTES,
    etiqueta: ETIQUETA,
    campoSerie: 'serie_rappel',
    campoUltimoPeriodo: `ultimo_periodo_generado${SUFIJO_MARCADORES}`,
    defecto: {
      // Sin valor por defecto a conciencia: la sociedad del Almacén General no
      // se puede deducir y elegir una mal abona a la sociedad equivocada.
      id_empresa_almacen_general: '',
      serie: SERIE_RAPPEL_DEFECTO,
      dia_generacion: DIA_GENERACION_DEFECTO,
      hora: HORA_DEFECTO,
      condiciones_pago: '',
      enabled: false,
      ultimo_periodo_generado: '',
    },
    extra: (item) => ({
      id_empresa_almacen_general: normalizarIdEmpresa(item.id_empresa_almacen_general),
    }),
  });
}

export function marcarPeriodoGenerado(periodo, resumen = {}) {
  return marcarPeriodoGeneradoPeriodico(CLAVES_AJUSTES, periodo, resumen);
}

export function marcarIntentoGeneracion({ periodo = '', estado, mensaje = '' }) {
  return marcarIntentoGeneracionPeriodica(CLAVES_AJUSTES, { periodo, estado, mensaje });
}

function validarSerieRappel(ajustes) {
  return validarSeriePeriodica(ajustes.serie, {
    tipo: 'OUT',
    textoConfig: 'la configuración de facturación de compras',
    etiquetaProceso: 'los abonos de rappel',
  });
}

/**
 * Abonos de rappel ya creados para un periodo, indexados por el par de
 * sociedades: es la clave de "ya hay abono de esto".
 */
function facturasDelPeriodo(periodo) {
  return facturasDelPeriodoPorClave({
    campoPeriodo: 'rappel_periodo',
    periodo,
    clave: (f) => claveGrupo(String(f.emisor_id ?? '').trim(), String(f.empresa_id ?? '').trim()),
  });
}

// ─── Planificación ───

const MOTIVOS = {
  ...MOTIVOS_COMUNES,
  iva_no_resuelto:
    'No se puede determinar el tipo de IVA de alguna línea con rappel: no lo tiene el pedido y el maestro de productos tampoco',
  pedido_sin_rappel: 'El pedido no tiene rappel que abonar',
  factura_total_cero: 'El abono quedaría a 0 €',
  validacion_emision: 'El abono no pasaría la validación de emisión',
  concurrencia: 'El pedido cambió mientras se generaba el abono',
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
 * Líneas del abono: una por cada producto de cada pedido/albarán, en negativo.
 */
function lineasAbonoDePedidos(pedidos) {
  return lineasDocumentoDePedidos(pedidos);
}

/** Datos del cuerpo del abono, tal como los espera el constructor. */
function datosAbono({ emisora, receptora, periodo, ajustes, lineas }) {
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
    // Fecha de operación = fecha de emisión = último día del periodo liquidado.
    fecha_emision: fecha,
    fecha_operacion: fecha,
    condiciones_pago: ajustes.condiciones_pago,
    // Ver DECISIÓN 2 en la cabecera del fichero.
    es_abono: true,
    es_rectificativa: true,
    rectificativa_tipo: 'diferencias',
    factura_rectificada_id: '',
    motivo_rectificacion:
      `Rappel del periodo ${periodo}: modificación de la base imponible por descuentos posteriores a la operación` +
      ' (art. 80.1.2º LIVA), rectificando por diferencias las operaciones del periodo (art. 15.4 RD 1619/2012)',
    observaciones: `Abono de rappel del grupo · mercancía servida en el periodo ${periodo}`,
    lineas,
  };
}

/**
 * Marcas propias del abono: lo identifican como generado por este proceso y
 * permiten avisar de que un periodo ya tiene abono para el par de sociedades.
 */
function marcarAbono({ factura, lineas }, pedidos, periodo, { ejecucion = '', origen = '' } = {}) {
  return {
    factura: {
      ...factura,
      rappel_periodo: periodo,
      rappel_origen: origen,
      rappel_ejecucion: ejecucion,
      rappel_pedidos: pedidos.length,
    },
    lineas,
  };
}

/**
 * Política de este dominio para el planificador compartido de pedidos.
 *
 * Se abona `TotalRappel`, en negativo. Las devoluciones **sí** entran, con el
 * signo invertido: `api/routes/pedidos.js` calcula en una devolución el mismo
 * rappel que en la compra precisamente para que al restarse quede a cero (una
 * botella comprada y devuelta no genera rappel), y es lo que hace el informe
 * `modo=abonos`. Excluirlas dejaría al local un abono por mercancía que devolvió.
 *
 * Un pedido sin rappel no es una anomalía: la mayoría no lo tienen.
 */
const POLITICA = {
  campoMarca: CAMPOS_MARCA.id,
  campoImporte: 'TotalRappel',
  motivos: MOTIVOS,
  motivoIva: 'iva_no_resuelto',
  motivoSinLineas: 'pedido_sin_rappel',
  sinImporteEsNormal: true,
  excluirDevoluciones: false,
  signoDe: (_pedido, esDevolucion) => (esDevolucion ? 1 : -1),
  /**
   * La misma validación que las demás facturas. Es la que impide que un mes en
   * que las devoluciones superen a las compras salga como "abono" con importe
   * positivo: con `es_abono` puesto exige signo negativo, así que ese par de
   * sociedades se excluye y se explica en vez de emitir un documento que cobra
   * lo que debía devolver.
   */
  validar: validarDatosEmision,
  construirDocumento: ({ emisora, receptora, periodo, ajustes }) => (pedidos, opciones = {}) =>
    marcarAbono(
      construirFacturaConLineas({
        id_factura: opciones.idFactura || 'PREVISUALIZACION',
        datos: datosAbono({
          emisora,
          receptora,
          periodo,
          ajustes,
          lineas: lineasAbonoDePedidos(pedidos),
        }),
      }),
      pedidos,
      periodo,
      opciones
    ),
};

/** Calcula qué se abonaría del periodo, sin escribir nada. */
export function planificarRappel({ periodo, ajustes, contexto }) {
  return planificarDocumentos({ periodo, ajustes, contexto, politica: POLITICA });
}

/** Quita del informe los datos internos que no interesan al cliente. */
function abonoPublico(f, facturasExistentes) {
  const existentes = facturasExistentes?.get(claveGrupo(f.id_empresa_emisora, f.id_empresa)) ?? [];
  return {
    id_empresa_emisora: f.id_empresa_emisora,
    empresa_emisora_nombre: f.empresa_emisora_nombre,
    empresa_emisora_cif: f.empresa_emisora_cif,
    id_empresa: f.id_empresa,
    empresa_nombre: f.empresa_nombre,
    empresa_cif: f.empresa_cif,
    num_pedidos: f.num_pedidos,
    es_abono: true,
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
      aviso: `Ya existe ${existentes.length === 1 ? 'un abono' : `${existentes.length} abonos`} de rappel de este periodo entre estas dos sociedades: se crearía otro abono aparte.`,
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
  usuarioAuditoria: 'Abonos de rappel',
  mensajeCerrojoPerdido:
    'Otra generación tomó el cerrojo mientras esta seguía en marcha: se ha parado sin escribir el abono y los pedidos quedan libres.',
  mensajeCerrojoEnDuda: (minutos) =>
    `No se ha podido confirmar el cerrojo contra la base de datos desde hace ${minutos} min: se ha parado sin escribir el abono y los pedidos quedan libres, porque a partir de ese margen otra generación podría haberlo tomado.`,

  leerAjustes: leerAjustesRappel,
  validarSerie: validarSerieRappel,

  cargarContexto: async ({ periodo }) => {
    const [contexto, facturasExistentes] = await Promise.all([
      cargarContextoPedidos(),
      facturasDelPeriodo(periodo),
    ]);
    return { ...contexto, facturasExistentes };
  },

  planificar: ({ periodo, ajustes, contexto }) => planificarRappel({ periodo, ajustes, contexto }),

  reconciliacion: {
    // Un único ámbito: la tabla de pedidos no tiene índice por local, así que se
    // recorre entera una sola vez en vez de una por local.
    ambitos: () => [{ etiqueta: 'pedidos' }],
    buscarMarcados: (_ambito, limite) => buscarPedidosMarcados(CAMPOS_MARCA, limite),
    idFacturaDe: (pedido) => String(pedido.factura_rappel_id ?? '').trim(),
    ejecucionDe: (pedido) => String(pedido.factura_rappel_ejecucion ?? ''),
    describir: (pedido) => ({
      pedido_id: String(pedido.Id ?? ''),
      local_id: String(pedido.LocalId ?? '').trim(),
      factura_rappel_id: String(pedido.factura_rappel_id ?? '').trim(),
      periodo: String(pedido.factura_rappel_periodo ?? ''),
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
  // No hay cierres sin abono: la ventana de selección es el propio periodo, así
  // que un pedido sin rappel no vuelve a girar en las tandas siguientes.
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
    origen: `rappel_${origen}`,
    periodo,
    serie: ajustes.serie,
    es_abono: true,
    id_empresa_emisora: grupo.id_empresa_emisora,
    pedidos: reclamados.length,
    total_factura: factura.total_factura,
  }),

  describirFacturaCreada: ({ idFactura, grupo, factura, lineas, reclamados, ajustes, contexto }) => {
    // El descuadre y los desgloses se recalculan sobre los pedidos realmente
    // abonados, que pueden ser menos que los planificados.
    const baseInforme = baseSegunInforme(reclamados);
    const descuadreCentimos = Math.round(round2(factura.base_imponible - baseInforme) * 100);
    return {
      id_factura: idFactura,
      es_abono: true,
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
        ...(p.tipo === TIPO_DEVOLUCION && { tipo: TIPO_DEVOLUCION }),
      })),
      ...(contexto.facturasExistentes.get(claveGrupo(grupo.id_empresa_emisora, grupo.id_empresa))?.length > 0 && {
        aviso: 'Ya había un abono de rappel de este periodo entre estas dos sociedades: este es adicional.',
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
    abonos: plan.facturas.map((f) => abonoPublico(f, contexto.facturasExistentes)),
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
    abonos: creadas,
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
    // y recoge solo los pedidos que quedaron sin abonar.
    ...(parcial && { parcial: true, motivo_incompleto, periodo_no_marcado: true }),
  }),
};

// ─── API pública del módulo ───

/**
 * Previsualización: qué se abonaría del periodo, sin escribir nada.
 * @returns {Promise<{ ok: true, ... } | { ok: false, status: number, error: string }>}
 */
export function previsualizarFacturacionRappel({ periodo } = {}) {
  return previsualizarPeriodo(dominio, { periodo });
}

/**
 * Genera los abonos de rappel del periodo en estado borrador.
 * @returns {Promise<{ ok: true, ... } | { ok: false, status: number, error: string }>}
 */
export function generarFacturacionRappel({
  periodo,
  usuario_id = '',
  usuario_nombre = '',
  origen = 'manual',
} = {}) {
  return generarPeriodo(dominio, { periodo, usuario_id, usuario_nombre, origen });
}

/** Solo para pruebas: el contrato de dominio que consume el motor compartido. */
export const _dominio = dominio;
