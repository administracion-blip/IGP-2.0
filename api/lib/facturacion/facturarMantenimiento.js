/**
 * Facturación mensual de las reparaciones de mantenimiento.
 *
 * La sociedad de la sede central factura a las sociedades propietarias de los
 * locales las reparaciones ya valoradas del periodo, dejando las facturas en
 * **borrador**: no se llama a la emisión, así que generar no consume numeración
 * (las ventas nacen sin número y el correlativo se reserva al emitir).
 *
 * Este fichero es solo la **política** del dominio: qué se factura, cómo se
 * agrupa y qué concepto lleva cada línea. La mecánica de una facturación
 * periódica —cerrojo, recuperación de meses perdidos, barrido de reconciliación,
 * reclamo atómico, escritura de la factura— vive en `facturacionPeriodica.js` y
 * la comparten los demás generadores periódicos.
 *
 * Decisiones de negocio que condicionan el código:
 * - **Una factura por sociedad receptora**, no por local: varios locales
 *   comparten sociedad y todo va en una factura con las líneas agrupadas por
 *   local.
 * - **Una línea de factura por línea de valoración**, con el local y la fecha
 *   del parte en la descripción, para conservar el tipo de IVA de cada línea.
 * - **Fecha de emisión y de operación: el último día del periodo facturado.** La
 *   factura de diciembre, aunque se genere el 1 de enero, debe llevar
 *   numeración del año que se cierra (el correlativo se ancla por año de
 *   `fecha_emision`).
 *
 * Configuración en `Igp_Ajustes`, PK 'mantenimiento' / SK 'facturacion'. Si el
 * ítem no existe se usan los valores por defecto, igual que las tarifas de
 * desplazamiento: la falta de configuración no debe romper el proceso.
 */

import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { formatId6 } from '../usuarioLocales.js';
import { validarDatosEmision } from './emitirFactura.js';
import { construirFacturaConLineas } from './construirFactura.js';
import {
  ahoraIso,
  cargarEmpresasPorId,
  condicionRevision,
  corteSeleccion,
  crearCerrojo,
  datosEmpresaFiscal as datosEmpresa,
  facturasDelPeriodo as facturasDelPeriodoPorClave,
  generarPeriodo,
  leerAjustesPeriodicos,
  marcarIntentoGeneracion as marcarIntentoGeneracionPeriodica,
  marcarPeriodoGenerado as marcarPeriodoGeneradoPeriodico,
  previsualizarPeriodo,
  reconciliarElementosHuerfanos,
  round2,
  scanTodo,
  ultimoDiaPeriodo,
  validarSerie as validarSeriePeriodica,
} from './facturacionPeriodica.js';

export {
  periodoValido,
  periodoDe,
  periodoAnterior,
  periodoSiguiente,
  periodosPendientes,
  ultimoDiaPeriodo,
} from './facturacionPeriodica.js';

export const AJUSTES_FACTURACION_PK = 'mantenimiento';
export const AJUSTES_FACTURACION_SK = 'facturacion';
/** Cerrojo de ejecución: mismo PK que la configuración para tenerlo a la vista. */
const AJUSTES_FACTURACION_SK_CERROJO = 'facturacion_lock';

const CLAVES_AJUSTES = { pk: AJUSTES_FACTURACION_PK, sk: AJUSTES_FACTURACION_SK };
/** Prefijo de los logs del dominio. */
const ETIQUETA = 'facturar mantenimiento';

/** DEMANDA Y SERVICIOS SL, la sociedad de la sede central. */
export const ID_EMPRESA_EMISORA_DEFECTO = '000359';
export const SERIE_DEFECTO = 'FMANT';
export const DIA_GENERACION_DEFECTO = 1;
export const HORA_DEFECTO = '06:00';

const ESTADO_VALORADO = 'Valorado';

/**
 * Motivos de cierre sin factura: un parte que nunca podrá facturarse se marca
 * para que deje de aparecer cada mes como pendiente. Son marcas propias, y a
 * propósito **no** escriben `factura_mantenimiento_id`, que es el único campo
 * con el que el frontend decide si un parte está facturado.
 */
export const CIERRE_SIN_LINEAS = 'sin_lineas_facturables';
export const CIERRE_SOCIEDAD_EMISORA = 'sociedad_emisora';

const TEXTOS_CIERRE = {
  [CIERRE_SIN_LINEAS]:
    'Cerrado sin factura: todas las líneas de la valoración quedaron a cantidad 0 porque el desplazamiento se cobró entero en otro parte',
  [CIERRE_SOCIEDAD_EMISORA]:
    'Cerrado sin factura: el local pertenece a la sociedad emisora, que no se factura a sí misma',
};

/**
 * Campos de la marca de cierre sin factura. Los exporta el módulo porque toda
 * escritura que cambie las líneas de valoración debe borrarlos: si el importe
 * vuelve a ser facturable, el parte tiene que volver a girar.
 */
export const CAMPOS_CIERRE_SIN_FACTURA = [
  'factura_mantenimiento_cierre',
  'factura_mantenimiento_cierre_texto',
  'factura_mantenimiento_cierre_periodo',
  'factura_mantenimiento_cierre_en',
];

const cerrojo = crearCerrojo({
  pk: AJUSTES_FACTURACION_PK,
  sk: AJUSTES_FACTURACION_SK_CERROJO,
  etiqueta: ETIQUETA,
  mensajeOcupado: (desde) =>
    `Ya hay una generación de facturas de mantenimiento en curso${desde}. Espera a que termine e inténtalo de nuevo.`,
});

/**
 * ¿Hay una generación en vuelo? Lo usa el trabajo programado para no disparar
 * una petición cada minuto que rebotaría con 409 y marcaría fallo.
 */
export function hayGeneracionEnCurso() {
  return cerrojo.hayEnCurso();
}

// ─── Periodos ───

/**
 * Corte de selección: se facturan los partes con `fecha_valoracion` anterior al
 * primer día del mes siguiente al periodo.
 */
export function corteValoracion(periodo) {
  return corteSeleccion(periodo);
}

/** dd/mm/aaaa a partir de un ISO o de un yyyy-mm-dd. Vacío si no hay fecha. */
function fechaCorta(valor) {
  const s = String(valor ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return '';
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
}

/** Día del parte: el del trabajo si lo tiene, y si no el de la valoración. */
function fechaDelParte(parte) {
  const programada = String(parte?.fecha_programada ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(programada)) return programada.slice(0, 10);
  const valoracion = String(parte?.fecha_valoracion ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(valoracion) ? valoracion.slice(0, 10) : '';
}

// ─── Ajustes ───

/**
 * Configuración de la facturación. Tolerante a que el ítem no exista o a que la
 * lectura falle: en ese caso, valores por defecto (con la generación automática
 * desactivada, que es como nace).
 */
export async function leerAjustesFacturacion() {
  return leerAjustesPeriodicos({
    ...CLAVES_AJUSTES,
    etiqueta: ETIQUETA,
    defecto: {
      id_empresa_emisora: ID_EMPRESA_EMISORA_DEFECTO,
      serie: SERIE_DEFECTO,
      dia_generacion: DIA_GENERACION_DEFECTO,
      hora: HORA_DEFECTO,
      condiciones_pago: '',
      enabled: false,
      ultimo_periodo_generado: '',
    },
    // La sociedad emisora es fija para mantenimiento y se configura en ajustes.
    extra: (item, defecto) => {
      const idEmisora = String(item.id_empresa_emisora ?? '').trim();
      return { id_empresa_emisora: idEmisora || defecto.id_empresa_emisora };
    },
  });
}

export function marcarPeriodoGenerado(periodo, resumen = {}) {
  return marcarPeriodoGeneradoPeriodico(CLAVES_AJUSTES, periodo, resumen);
}

export function marcarIntentoGeneracion({ periodo = '', estado, mensaje = '' }) {
  return marcarIntentoGeneracionPeriodica(CLAVES_AJUSTES, { periodo, estado, mensaje });
}

function validarSerieMantenimiento(ajustes) {
  return validarSeriePeriodica(ajustes.serie, {
    tipo: 'OUT',
    textoConfig: 'la configuración de facturación de mantenimiento',
    etiquetaProceso: 'mantenimiento',
  });
}

// ─── Lectura de maestros y partes ───

async function cargarLocales() {
  const items = await scanTodo(tables.locales, 'id_Locales, nombre, id_empresa');
  return items
    .map((l) => ({
      id: String(l.id_Locales ?? '').trim(),
      nombre: String(l.nombre ?? '').trim(),
      id_empresa: String(l.id_empresa ?? '').trim(),
    }))
    .filter((l) => l.id !== '');
}

/** Facturas de mantenimiento ya creadas para un periodo, indexadas por sociedad. */
function facturasDelPeriodo(periodo) {
  return facturasDelPeriodoPorClave({
    campoPeriodo: 'mantenimiento_periodo',
    periodo,
    clave: (f) => String(f.empresa_id ?? '').trim(),
  });
}

/**
 * Partes candidatos de un local: valorados, sin facturar, sin cierre sin
 * factura y con la valoración anterior al corte. La tabla no tiene índice
 * secundario: se consulta local a local (18 particiones), como ya hace la
 * búsqueda de hermanos del reparto.
 *
 * Ojo con lo que ahorra cada cosa: el `FilterExpression` se aplica **después** de
 * leer, así que la partición del local se lee entera —todo su histórico— y se
 * paga como lectura; lo que ahorra es red. El que evita traerse las
 * descripciones y las fotos de cada parte es el `ProjectionExpression`.
 *
 * `reabrirCierreEmisora` recupera los partes cerrados por pertenecer a la
 * sociedad emisora cuando su local ya está en otra sociedad: ese cierre depende
 * de un dato del maestro de locales que puede cambiar, y sin esto el parte no se
 * facturaría nunca.
 */
async function buscarCandidatosLocal(idLocal, corte, { reabrirCierreEmisora = false } = {}) {
  const filtroCierre = reabrirCierreEmisora
    ? '(attribute_not_exists(factura_mantenimiento_cierre) OR factura_mantenimiento_cierre = :cierreEmisora)'
    : 'attribute_not_exists(factura_mantenimiento_cierre)';
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.mantenimiento,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        FilterExpression:
          `EstadoValoracion = :val AND attribute_not_exists(factura_mantenimiento_id) AND fecha_valoracion < :corte AND ${filtroCierre}`,
        ProjectionExpression:
          'PK, SK, local_id, id_incidencia, titulo, fecha_programada, fecha_valoracion, valoracion_rev, valoracion_lineas, valoracion_total',
        ExpressionAttributeValues: {
          ':pk': `LOCAL#${idLocal}`,
          ':sk': 'INC#',
          ':val': ESTADO_VALORADO,
          ':corte': corte,
          ...(reabrirCierreEmisora && { ':cierreEmisora': CIERRE_SOCIEDAD_EMISORA }),
        },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Partes ya marcados como facturados hace más del margen de reconciliación.
 *
 * La antigüedad se mide con `factura_mantenimiento_fecha`, que es de este proceso
 * y solo lo escribe el reclamo. `fecha_facturacion` guarda la misma fecha, pero
 * es el campo que ve el frontend y no es exclusivo: si otro flujo lo escribiera,
 * el barrido no debe poder confundirlo con una marca propia.
 *
 * Se exige que **las dos** fechas presentes sean antiguas. Las marcas escritas
 * antes de que existiera el campo propio solo tienen `fecha_facturacion`, y así
 * siguen reconciliándose igual sin necesidad de migrar nada; y en la dirección
 * peligrosa —dar por huérfano algo en vuelo— el criterio es conservador: basta
 * una de las dos fechas reciente para que el parte quede protegido.
 */
async function buscarMarcadosLocal(idLocal, limite) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.mantenimiento,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        // Sin ninguna de las dos fechas no hay forma de saber si la marca es
        // reciente, pero el reclamo las escribe con el identificador de factura:
        // si faltan, la marca no la ha puesto este proceso y no hay ejecución en
        // curso que proteger.
        FilterExpression:
          'attribute_exists(factura_mantenimiento_id)' +
          ' AND (attribute_not_exists(factura_mantenimiento_fecha) OR factura_mantenimiento_fecha < :lim)' +
          ' AND (attribute_not_exists(fecha_facturacion) OR fecha_facturacion < :lim)',
        ProjectionExpression:
          'PK, SK, local_id, titulo, factura_mantenimiento_id, factura_mantenimiento_periodo, factura_mantenimiento_ejecucion, factura_mantenimiento_fecha, fecha_facturacion',
        ExpressionAttributeValues: { ':pk': `LOCAL#${idLocal}`, ':sk': 'INC#', ':lim': limite },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

// ─── Escrituras sobre los partes ───

/**
 * Campos de la marca de facturación. `factura_mantenimiento_fecha` es la fecha
 * propia del proceso —la que usa el barrido— y `fecha_facturacion` la misma fecha
 * con el nombre que ya expone `GET /mantenimiento/incidencias` y consume el
 * frontend: se escriben las dos y se quitan las dos.
 */
const CAMPOS_MARCA = [
  'factura_mantenimiento_id',
  'factura_mantenimiento_periodo',
  'factura_mantenimiento_fecha',
  'fecha_facturacion',
  'factura_mantenimiento_ejecucion',
  'factura_mantenimiento_id_empresa',
];

/**
 * Testigo de que la valoración leída sigue vigente.
 *
 * `fecha_valoracion` no basta: el reparto de kilómetros sobre un parte hermano
 * reescribe sus líneas y sus totales sin tocarla —no puede tocarla, porque tiene
 * significado fiscal y es el criterio de corte del periodo—, así que un importe
 * puede cambiar con la fecha intacta. `valoracion_rev` es un contador que sube
 * con ADD en toda escritura de las líneas y es el único que detecta ese caso.
 */
function condicionRevValoracion(parte) {
  return condicionRevision(parte, 'valoracion_rev');
}

/**
 * Reclama un parte para una factura. Esta escritura condicional es la garantía
 * de que nada se factura dos veces: si otra ejecución lo reclamó, si dejó de
 * estar valorado o si su valoración cambió entre la lectura y ahora, la
 * condición falla y el parte se descarta del lote.
 *
 * Se comparan `fecha_valoracion` y `valoracion_rev` para no facturar un importe
 * distinto del previsualizado: es el mismo cierre optimista que usa el router de
 * mantenimiento.
 */
async function reclamarParte(parte, { idFactura, periodo, idEmpresa, ejecucion, fecha }) {
  const rev = condicionRevValoracion(parte);
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.mantenimiento,
        Key: { PK: parte.PK, SK: parte.SK },
        // El cierre sin factura se borra: si el parte llega hasta aquí es que ha
        // vuelto a ser facturable y la marca antigua confundiría.
        UpdateExpression:
          'SET factura_mantenimiento_id = :fid, factura_mantenimiento_periodo = :per, factura_mantenimiento_fecha = :fec, fecha_facturacion = :fec, factura_mantenimiento_ejecucion = :eje, factura_mantenimiento_id_empresa = :emp' +
          ` REMOVE ${CAMPOS_CIERRE_SIN_FACTURA.join(', ')}`,
        ConditionExpression:
          'attribute_exists(PK) AND attribute_not_exists(factura_mantenimiento_id) AND EstadoValoracion = :valorado AND fecha_valoracion = :fechaLeida AND ' +
          rev.expresion,
        ExpressionAttributeValues: {
          ':fid': idFactura,
          ':per': periodo,
          ':fec': fecha,
          ':eje': ejecucion,
          ':emp': idEmpresa,
          ':valorado': ESTADO_VALORADO,
          ':fechaLeida': parte.fecha_valoracion,
          ...rev.valores,
        },
      })
    );
    return { ok: true };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { ok: false };
    throw err;
  }
}

/**
 * Marca un parte que nunca podrá facturarse para que deje de girar: sin esto
 * reaparece cada mes en la lista de excluidos y en las pantallas figura como
 * pendiente de facturar para siempre.
 *
 * No escribe `factura_mantenimiento_id`, así que el frontend no lo confunde con
 * un parte facturado, y la condición es la misma del reclamo: si la valoración
 * ha cambiado entre la lectura y ahora, no se cierra nada.
 */
async function marcarCerradoSinFactura(parte, periodo) {
  const rev = condicionRevValoracion(parte);
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.mantenimiento,
        Key: { PK: parte.PK, SK: parte.SK },
        UpdateExpression:
          'SET factura_mantenimiento_cierre = :mot, factura_mantenimiento_cierre_texto = :txt, factura_mantenimiento_cierre_periodo = :per, factura_mantenimiento_cierre_en = :fecha',
        ConditionExpression:
          'attribute_exists(PK) AND attribute_not_exists(factura_mantenimiento_id) AND attribute_not_exists(factura_mantenimiento_cierre) AND EstadoValoracion = :valorado AND fecha_valoracion = :fechaLeida AND ' +
          rev.expresion,
        ExpressionAttributeValues: {
          ':mot': parte.motivo,
          ':txt': TEXTOS_CIERRE[parte.motivo] || parte.motivo,
          ':per': periodo,
          ':fecha': ahoraIso(),
          ':valorado': ESTADO_VALORADO,
          ':fechaLeida': parte.fecha_valoracion,
          ...rev.valores,
        },
      })
    );
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      // La valoración cambió entre el plan y el cierre: el parte se reevalúa en la
      // tanda siguiente. No es un error, pero sin rastro no hay forma de saber por
      // qué un parte que salió como cerrable sigue girando.
      console.warn(
        `[${ETIQUETA}] El parte cambió y no se ha cerrado sin factura: se reevaluará en la tanda siguiente`,
        parte.SK
      );
      return false;
    }
    // Cerrar un parte es cosmético frente a facturar: no debe tumbar la tanda.
    console.warn(`[${ETIQUETA}] No se pudo cerrar sin factura`, parte.SK, err?.message || err);
    return false;
  }
}

/** Quita la marca de facturación de un parte. Devuelve true si la quitó. */
async function liberarParte(parte, idFactura) {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.mantenimiento,
        Key: { PK: parte.PK, SK: parte.SK },
        UpdateExpression: `REMOVE ${CAMPOS_MARCA.join(', ')}`,
        ConditionExpression: 'attribute_exists(PK) AND factura_mantenimiento_id = :fid',
        ExpressionAttributeValues: { ':fid': idFactura },
      })
    );
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Libera los partes marcados con una factura que ya no existe. La mecánica está
 * en `facturacionPeriodica.js`; aquí solo se aportan las consultas y las marcas.
 */
export async function reconciliarPartesHuerfanos(locales, { ejecucionPropia = '' } = {}) {
  return reconciliarElementosHuerfanos(dominio, { locales }, { ejecucionPropia });
}

// ─── Planificación ───

const MOTIVOS = {
  local_sin_empresa: 'El local no tiene sociedad asignada (id_empresa)',
  empresa_inexistente: 'La sociedad del local ya no existe en el maestro de empresas',
  local_inexistente: 'El local del parte ya no existe en el maestro de locales',
  sociedad_sin_datos_fiscales: 'La sociedad no tiene los datos fiscales necesarios para facturarle',
  sociedad_es_emisora: 'La sede central no se factura a sí misma',
  parte_sin_lineas_facturables:
    'Todas las líneas de la valoración tienen cantidad 0 (el desplazamiento ya se cobró en otro parte)',
  factura_total_cero: 'La factura de la sociedad quedaría a 0 €',
  validacion_emision: 'La factura no pasaría la validación de emisión',
  concurrencia: 'El parte cambió mientras se generaba la factura',
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
 * Líneas de factura de un parte. Se descartan las de cantidad 0, que aparecen
 * legítimamente cuando el desplazamiento ya se cobró entero en otro parte del
 * mismo día: dejarlas haría que la validación de emisión rechazara la factura
 * completa.
 */
function lineasFacturaDeParte(parte, localNombre) {
  const dia = fechaCorta(fechaDelParte(parte));
  const prefijo = [localNombre, dia].filter(Boolean).join(' · ');
  const lineas = [];
  for (const l of Array.isArray(parte.valoracion_lineas) ? parte.valoracion_lineas : []) {
    const cantidad = Number(l?.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) continue;
    const precio = Number(l?.precio);
    const tipoIva = Number(l?.tipo_iva);
    const articulo = String(l?.articulo ?? '').trim() || 'Reparación';
    lineas.push({
      descripcion: prefijo ? `${prefijo} · ${articulo}` : articulo,
      cantidad,
      precio_unitario: Number.isFinite(precio) && precio >= 0 ? precio : 0,
      tipo_iva: Number.isFinite(tipoIva) && tipoIva >= 0 ? tipoIva : 21,
      descuento_pct: 0,
      retencion_pct: 0,
    });
  }
  return lineas;
}

/** Importes de un conjunto de líneas con el redondeo de facturación. */
function totalesDeLineas(lineas) {
  let base = 0;
  let iva = 0;
  for (const l of lineas) {
    const b = round2(Number(l.cantidad) * Number(l.precio_unitario));
    base += b;
    iva += round2((b * Number(l.tipo_iva)) / 100);
  }
  base = round2(base);
  iva = round2(iva);
  return { base, iva, total: round2(base + iva) };
}

/**
 * Datos del cuerpo de la factura de una sociedad, tal como los espera el
 * constructor. `sociedad` debe ser el objeto fiscal completo
 * (`datosEmpresaFiscal`): sin domicilio, código postal, municipio y provincia
 * del destinatario la factura es defectuosa y así se enviaría a VERI*FACTU.
 */
function datosFactura({ sociedad, emisora, periodo, ajustes, lineas }) {
  const fecha = ultimoDiaPeriodo(periodo);
  return {
    tipo: 'OUT',
    serie: ajustes.serie,
    emisor_id: emisora.id,
    emisor_nombre: emisora.nombre,
    emisor_cif: emisora.cif,
    emisor_direccion: emisora.direccion,
    emisor_cp: emisora.cp,
    emisor_municipio: emisora.municipio,
    emisor_provincia: emisora.provincia,
    emisor_email: emisora.email,
    emisor_iban: emisora.iban,
    emisor_iban_alternativo: emisora.iban_alternativo,
    empresa_id: sociedad.id_empresa,
    empresa_nombre: sociedad.nombre,
    empresa_cif: sociedad.cif,
    empresa_direccion: sociedad.direccion,
    empresa_cp: sociedad.cp,
    empresa_municipio: sociedad.municipio,
    empresa_provincia: sociedad.provincia,
    empresa_email: sociedad.email,
    // Fecha de operación = fecha de emisión = último día del periodo facturado.
    fecha_emision: fecha,
    fecha_operacion: fecha,
    condiciones_pago: ajustes.condiciones_pago,
    observaciones: `Reparaciones de mantenimiento · periodo ${periodo}`,
    lineas,
  };
}

/**
 * Cabecera y líneas de la factura de una sociedad. **Único** constructor: lo
 * usan la previsualización y la generación para que no puedan divergir. Cuando
 * cada una armaba la cabecera con su propio objeto, la generación partía de una
 * copia recortada de la sociedad y emitía facturas sin domicilio fiscal del
 * cliente, algo que la previsualización no delataba.
 */
function construirFacturaSociedad({ idFactura, fiscal, emisora, periodo, ajustes, lineas }) {
  return construirFacturaConLineas({
    id_factura: idFactura,
    datos: datosFactura({ sociedad: fiscal, emisora, periodo, ajustes, lineas }),
  });
}

/**
 * Calcula qué se facturaría, sin escribir nada. `cerrables` son los partes que
 * nunca podrán facturarse y que la generación marcará como cerrados sin factura.
 *
 * `grupos` es lo que consume la mecánica de generación: cada sociedad con sus
 * elementos reclamables y su constructor de factura.
 * @returns {Promise<{ ok: true, periodo, corte, sociedades, grupos, excluidos, cerrables } | { ok: false, status, error }>}
 */
export async function planificarFacturacion({ periodo, locales, empresasPorId, ajustes }) {
  const emisoraId = formatId6(ajustes.id_empresa_emisora);
  const emisoraItem = empresasPorId.get(emisoraId);
  if (!emisoraItem) {
    return {
      ok: false,
      status: 400,
      error: `La sociedad emisora ${emisoraId} no existe en el maestro de empresas. Revisa la configuración de facturación de mantenimiento.`,
    };
  }
  const emisora = datosEmpresa(emisoraItem);
  if (!emisora.cif) {
    return {
      ok: false,
      status: 400,
      error: `La sociedad emisora ${emisoraId} (${emisora.nombre || 'sin nombre'}) no tiene CIF: completa sus datos fiscales antes de facturar.`,
    };
  }

  const corte = corteValoracion(periodo);
  const localesPorId = new Map(locales.map((l) => [l.id, l]));
  const excluidos = [];
  const cerrables = [];
  const porSociedad = new Map();

  for (const local of locales) {
    // La sociedad del local se resuelve antes de consultar porque decide si hay
    // que recuperar los partes cerrados por pertenecer a la sociedad emisora.
    const idEmpresa = local.id_empresa ? formatId6(local.id_empresa) : '';
    const candidatos = await buscarCandidatosLocal(local.id, corte, {
      reabrirCierreEmisora: idEmpresa !== '' && idEmpresa !== emisoraId,
    });
    if (candidatos.length === 0) continue;

    if (!local.id_empresa) {
      excluidos.push(
        excluido('local_sin_empresa', {
          ambito: 'local',
          local_id: local.id,
          local_nombre: local.nombre,
          partes: candidatos.length,
        })
      );
      continue;
    }
    const empresaItem = empresasPorId.get(idEmpresa);
    if (!empresaItem) {
      excluidos.push(
        excluido(
          'empresa_inexistente',
          {
            ambito: 'local',
            local_id: local.id,
            local_nombre: local.nombre,
            id_empresa: idEmpresa,
            partes: candidatos.length,
          },
          `El local apunta a la sociedad ${idEmpresa}, que no está en el maestro`
        )
      );
      continue;
    }

    for (const parte of candidatos) {
      // El parte guarda su propio `local_id`: si apunta a un local que ya no
      // existe, no hay nombre ni sociedad con los que facturarlo.
      const localParte = String(parte.local_id ?? '').trim();
      if (localParte && localParte !== local.id && !localesPorId.has(localParte)) {
        excluidos.push(
          excluido('local_inexistente', {
            ambito: 'parte',
            local_id: localParte,
            local_nombre: '',
            sk: parte.SK,
            titulo: String(parte.titulo ?? ''),
            partes: 1,
          })
        );
        continue;
      }

      const lineas = lineasFacturaDeParte(parte, local.nombre || local.id);
      if (lineas.length === 0) {
        excluidos.push(
          excluido('parte_sin_lineas_facturables', {
            ambito: 'parte',
            local_id: local.id,
            local_nombre: local.nombre,
            id_empresa: idEmpresa,
            sk: parte.SK,
            titulo: String(parte.titulo ?? ''),
            fecha: fechaDelParte(parte),
            partes: 1,
          })
        );
        cerrables.push({
          PK: parte.PK,
          SK: parte.SK,
          fecha_valoracion: parte.fecha_valoracion,
          valoracion_rev: parte.valoracion_rev,
          local_id: local.id,
          local_nombre: local.nombre || local.id,
          titulo: String(parte.titulo ?? ''),
          motivo: CIERRE_SIN_LINEAS,
        });
        continue;
      }

      let grupo = porSociedad.get(idEmpresa);
      if (!grupo) {
        // `fiscal` es la única fuente de la cabecera de la factura, para
        // previsualización y generación.
        const fiscal = { ...datosEmpresa(empresaItem), id_empresa: idEmpresa };
        grupo = { ...fiscal, fiscal, partes: [] };
      }
      const totales = totalesDeLineas(lineas);
      grupo.partes.push({
        PK: parte.PK,
        SK: parte.SK,
        fecha_valoracion: parte.fecha_valoracion,
        valoracion_rev: parte.valoracion_rev,
        local_id: local.id,
        local_nombre: local.nombre || local.id,
        titulo: String(parte.titulo ?? ''),
        fecha: fechaDelParte(parte),
        valoracion_total: Number(parte.valoracion_total ?? 0),
        lineas,
        ...totales,
      });
      porSociedad.set(idEmpresa, grupo);
    }
  }

  const sociedades = [];
  for (const grupo of porSociedad.values()) {
    if (grupo.id_empresa === emisoraId) {
      excluidos.push(
        excluido('sociedad_es_emisora', {
          ambito: 'sociedad',
          id_empresa: grupo.id_empresa,
          empresa_nombre: grupo.nombre,
          partes: grupo.partes.length,
        })
      );
      for (const p of grupo.partes) {
        cerrables.push({
          PK: p.PK,
          SK: p.SK,
          fecha_valoracion: p.fecha_valoracion,
          valoracion_rev: p.valoracion_rev,
          local_id: p.local_id,
          local_nombre: p.local_nombre,
          titulo: p.titulo,
          motivo: CIERRE_SOCIEDAD_EMISORA,
        });
      }
      continue;
    }
    // Sin CIF o sin nombre la factura no se podría emitir: se excluye la
    // sociedad entera y sus partes quedan libres para el mes siguiente.
    const faltan = [];
    if (!grupo.cif) faltan.push('CIF');
    if (!grupo.nombre) faltan.push('nombre');
    if (faltan.length > 0) {
      excluidos.push(
        excluido(
          'sociedad_sin_datos_fiscales',
          {
            ambito: 'sociedad',
            id_empresa: grupo.id_empresa,
            empresa_nombre: grupo.nombre,
            partes: grupo.partes.length,
          },
          `Falta ${faltan.join(' y ')} en el maestro de empresas`
        )
      );
      continue;
    }

    // Líneas agrupadas por local y, dentro de cada local, por fecha del parte.
    grupo.partes.sort(
      (a, b) =>
        a.local_nombre.localeCompare(b.local_nombre) ||
        String(a.fecha).localeCompare(String(b.fecha)) ||
        String(a.SK).localeCompare(String(b.SK))
    );
    /**
     * Constructor de la factura de esta sociedad a partir de los partes que
     * realmente se hayan podido reclamar. Lo usa la previsualización con todos
     * los partes y la generación con los reclamados.
     */
    const construir = (partes, { idFactura = 'PREVISUALIZACION' } = {}) =>
      construirFacturaSociedad({
        idFactura,
        fiscal: grupo.fiscal,
        emisora,
        periodo,
        ajustes,
        lineas: partes.flatMap((p) => p.lineas),
      });
    const { factura, lineas: lineasFactura } = construir(grupo.partes);

    if (factura.total_factura === 0) {
      excluidos.push(
        excluido('factura_total_cero', {
          ambito: 'sociedad',
          id_empresa: grupo.id_empresa,
          empresa_nombre: grupo.nombre,
          partes: grupo.partes.length,
        })
      );
      continue;
    }
    const errores = validarDatosEmision(factura, lineasFactura);
    if (errores.length > 0) {
      excluidos.push(
        excluido(
          'validacion_emision',
          {
            ambito: 'sociedad',
            id_empresa: grupo.id_empresa,
            empresa_nombre: grupo.nombre,
            partes: grupo.partes.length,
          },
          errores.join(' · ')
        )
      );
      continue;
    }

    // Mantenimiento y facturación redondean distinto: los totales salen siempre
    // de las líneas, nunca del total de la valoración. Un descuadre de céntimos
    // no bloquea, pero se informa.
    const totalValoraciones = round2(grupo.partes.reduce((s, p) => s + Number(p.valoracion_total ?? 0), 0));
    const descuadre = round2(factura.total_factura - totalValoraciones);

    sociedades.push({
      id_empresa: grupo.id_empresa,
      nombre: grupo.nombre,
      cif: grupo.cif,
      // Datos fiscales completos: la generación construye la cabecera con esto.
      fiscal: grupo.fiscal,
      partes: grupo.partes,
      num_partes: grupo.partes.length,
      base: factura.base_imponible,
      iva: factura.total_iva,
      total: factura.total_factura,
      total_valoraciones: totalValoraciones,
      descuadre_centimos: descuadre === 0 ? 0 : Math.round(descuadre * 100),
      locales: desgloseLocales(grupo.partes),
      // Lo que consume la mecánica de generación.
      elementos: grupo.partes,
      construir: (partes, opciones) => marcarFactura(construir(partes, opciones), partes, periodo, opciones),
    });
  }

  sociedades.sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { ok: true, periodo, corte, emisora, sociedades, grupos: sociedades, excluidos, cerrables };
}

/**
 * Marcas propias de la factura: identifican la factura como generada por este
 * proceso y permiten avisar de que un periodo ya tiene factura para la sociedad.
 */
function marcarFactura({ factura, lineas }, partes, periodo, { ejecucion = '', origen = '' } = {}) {
  return {
    factura: {
      ...factura,
      mantenimiento_periodo: periodo,
      mantenimiento_origen: origen,
      mantenimiento_ejecucion: ejecucion,
      mantenimiento_partes: partes.length,
    },
    lineas,
  };
}

/** Desglose por local con la fecha de cada parte, para el informe. */
function desgloseLocales(partes) {
  const porLocal = new Map();
  for (const p of partes) {
    const grupo = porLocal.get(p.local_id) || {
      local_id: p.local_id,
      local_nombre: p.local_nombre,
      partes: [],
      base: 0,
      iva: 0,
      total: 0,
    };
    grupo.partes.push({
      fecha: p.fecha,
      titulo: p.titulo,
      base: p.base,
      iva: p.iva,
      total: p.total,
      lineas: p.lineas.length,
    });
    grupo.base = round2(grupo.base + p.base);
    grupo.iva = round2(grupo.iva + p.iva);
    grupo.total = round2(grupo.total + p.total);
    porLocal.set(p.local_id, grupo);
  }
  return [...porLocal.values()].sort((a, b) => a.local_nombre.localeCompare(b.local_nombre));
}

/** Quita del informe los datos internos que no interesan al cliente. */
function sociedadPublica(soc, facturasExistentes) {
  const existentes = facturasExistentes?.get(soc.id_empresa) ?? [];
  return {
    id_empresa: soc.id_empresa,
    nombre: soc.nombre,
    cif: soc.cif,
    num_partes: soc.num_partes,
    base: soc.base,
    iva: soc.iva,
    total: soc.total,
    ...(soc.descuadre_centimos !== 0 && {
      descuadre_centimos: soc.descuadre_centimos,
      total_valoraciones: soc.total_valoraciones,
    }),
    locales: soc.locales,
    ...(existentes.length > 0 && {
      aviso: `Ya existe ${existentes.length === 1 ? 'una factura' : `${existentes.length} facturas`} de mantenimiento de este periodo para esta sociedad: se crearía otra factura aparte.`,
      facturas_existentes: existentes,
    }),
  };
}

// ─── Dominio: lo que la mecánica de facturación periódica necesita saber ───

const dominio = {
  etiqueta: ETIQUETA,
  claves: CLAVES_AJUSTES,
  cerrojo,
  nombreElemento: 'el parte',
  usuarioAuditoria: 'Facturación de mantenimiento',
  mensajeCerrojoPerdido:
    'Otra generación tomó el cerrojo mientras esta seguía en marcha: se ha parado sin escribir la factura y los partes quedan libres.',
  mensajeCerrojoEnDuda: (minutos) =>
    `No se ha podido confirmar el cerrojo contra la base de datos desde hace ${minutos} min: se ha parado sin escribir la factura y los partes quedan libres, porque a partir de ese margen otra generación podría haberlo tomado.`,

  leerAjustes: leerAjustesFacturacion,
  validarSerie: validarSerieMantenimiento,

  cargarContexto: async ({ periodo }) => {
    const [locales, empresasPorId, facturasExistentes] = await Promise.all([
      cargarLocales(),
      cargarEmpresasPorId(),
      facturasDelPeriodo(periodo),
    ]);
    return { locales, empresasPorId, facturasExistentes };
  },

  planificar: ({ periodo, ajustes, contexto }) =>
    planificarFacturacion({
      periodo,
      locales: contexto.locales,
      empresasPorId: contexto.empresasPorId,
      ajustes,
    }),

  reconciliacion: {
    ambitos: (contexto) => contexto.locales,
    buscarMarcados: (local, limite) => buscarMarcadosLocal(local.id, limite),
    idFacturaDe: (parte) => String(parte.factura_mantenimiento_id ?? '').trim(),
    ejecucionDe: (parte) => String(parte.factura_mantenimiento_ejecucion ?? ''),
    describir: (parte, local) => ({
      local_id: local.id,
      local_nombre: local.nombre,
      sk: parte.SK,
      titulo: String(parte.titulo ?? ''),
      factura_mantenimiento_id: String(parte.factura_mantenimiento_id ?? '').trim(),
      periodo: String(parte.factura_mantenimiento_periodo ?? ''),
    }),
  },

  referencia: (parte) => parte.SK,
  liberarElemento: liberarParte,
  reclamarElemento: (parte, { idFactura, periodo, grupo, ejecucion, fecha }) =>
    reclamarParte(parte, { idFactura, periodo, idEmpresa: grupo.id_empresa, ejecucion, fecha }),
  cerrarSinFactura: marcarCerradoSinFactura,

  identidadGrupo: (soc) => ({ id_empresa: soc.id_empresa, empresa_nombre: soc.nombre }),
  excluirGrupo: (motivo, soc, numPartes, detalle) =>
    excluido(
      motivo,
      {
        ambito: 'sociedad',
        id_empresa: soc.id_empresa,
        empresa_nombre: soc.nombre,
        partes: numPartes,
      },
      detalle
    ),
  describirDescartado: (parte, soc) => ({
    local_id: parte.local_id,
    local_nombre: parte.local_nombre,
    sk: parte.SK,
    titulo: parte.titulo,
    fecha: parte.fecha,
    id_empresa: soc.id_empresa,
    empresa_nombre: soc.nombre,
    motivo: 'concurrencia',
    motivo_texto: MOTIVOS.concurrencia,
  }),
  describirCerrado: (parte) => ({
    local_id: parte.local_id,
    local_nombre: parte.local_nombre,
    sk: parte.SK,
    titulo: parte.titulo,
    motivo: parte.motivo,
    motivo_texto: TEXTOS_CIERRE[parte.motivo] || parte.motivo,
  }),

  detalleAuditoria: ({ factura, reclamados, periodo, ajustes, origen }) => ({
    origen: `mantenimiento_${origen}`,
    periodo,
    serie: ajustes.serie,
    partes: reclamados.length,
    total_factura: factura.total_factura,
  }),

  describirFacturaCreada: ({ idFactura, grupo, factura, lineas, reclamados, ajustes, contexto }) => {
    // El descuadre se recalcula sobre los partes realmente facturados, que
    // pueden ser menos que los planificados.
    const totalValoraciones = round2(reclamados.reduce((s, p) => s + Number(p.valoracion_total ?? 0), 0));
    const descuadreCentimos = Math.round(round2(factura.total_factura - totalValoraciones) * 100);
    return {
      id_factura: idFactura,
      id_empresa: grupo.id_empresa,
      empresa_nombre: grupo.nombre,
      empresa_cif: grupo.cif,
      serie: ajustes.serie,
      estado: factura.estado,
      fecha_emision: factura.fecha_emision,
      base: factura.base_imponible,
      iva: factura.total_iva,
      total: factura.total_factura,
      num_partes: reclamados.length,
      num_lineas: lineas.length,
      ...(descuadreCentimos !== 0 && { descuadre_centimos: descuadreCentimos, total_valoraciones: totalValoraciones }),
      locales: desgloseLocales(reclamados),
      partes: reclamados.map((p) => ({
        local_id: p.local_id,
        local_nombre: p.local_nombre,
        sk: p.SK,
        titulo: p.titulo,
        fecha: p.fecha,
        total: p.total,
      })),
      ...(contexto.facturasExistentes.get(grupo.id_empresa)?.length > 0 && {
        aviso: 'Ya había una factura de mantenimiento de este periodo para esta sociedad: esta es adicional.',
      }),
    };
  },

  construirResumen: ({ creadas, excluidos, descartados, cerrados, errores, origen, ejecucion }) => ({
    facturas: creadas.length,
    partes: creadas.reduce((s, f) => s + f.num_partes, 0),
    importe: round2(creadas.reduce((s, f) => s + f.total, 0)),
    excluidos: excluidos.length,
    descartados: descartados.length,
    cerrados_sin_factura: cerrados.length,
    errores: errores.length,
    origen,
    ejecucion,
  }),

  describirPrevisualizacion: ({ periodo, ajustes, contexto, plan }) => ({
    ok: true,
    periodo,
    corte_valoracion: plan.corte,
    fecha_emision: ultimoDiaPeriodo(periodo),
    serie: ajustes.serie,
    emisora: { id_empresa: plan.emisora.id, nombre: plan.emisora.nombre, cif: plan.emisora.cif },
    sociedades: plan.sociedades.map((s) => sociedadPublica(s, contexto.facturasExistentes)),
    total_facturas: plan.sociedades.length,
    total_partes: plan.sociedades.reduce((s, x) => s + x.num_partes, 0),
    total_importe: round2(plan.sociedades.reduce((s, x) => s + x.total, 0)),
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
    cerrados,
    liberados,
    errores,
    resumen,
    interrumpida,
    parcial,
    motivo_incompleto,
  }) => ({
    ok: true,
    periodo,
    corte_valoracion: plan.corte,
    fecha_emision: ultimoDiaPeriodo(periodo),
    serie: ajustes.serie,
    ejecucion,
    facturas: creadas,
    total_facturas: creadas.length,
    total_partes: resumen.partes,
    total_importe: resumen.importe,
    descartados,
    excluidos,
    cerrados_sin_factura: cerrados,
    partes_liberados: liberados,
    errores,
    ...(interrumpida && { interrumpida: true }),
    // El periodo no se ha marcado como generado: la tanda siguiente lo reintenta
    // y recoge solo los partes que quedaron sin facturar.
    ...(parcial && { parcial: true, motivo_incompleto, periodo_no_marcado: true }),
  }),
};

// ─── API pública del módulo ───

/**
 * Previsualización: qué se facturaría del periodo, sin escribir nada.
 * @returns {Promise<{ ok: true, ... } | { ok: false, status: number, error: string }>}
 */
export function previsualizarFacturacionMantenimiento({ periodo } = {}) {
  return previsualizarPeriodo(dominio, { periodo });
}

/**
 * Genera las facturas del periodo en estado borrador.
 * @returns {Promise<{ ok: true, ... } | { ok: false, status: number, error: string }>}
 */
export function generarFacturacionMantenimiento({
  periodo,
  usuario_id = '',
  usuario_nombre = '',
  origen = 'manual',
} = {}) {
  return generarPeriodo(dominio, { periodo, usuario_id, usuario_nombre, origen });
}
