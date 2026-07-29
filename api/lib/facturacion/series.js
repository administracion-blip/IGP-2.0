import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { normalizeCif } from '../empresaCif.js';
import { formatId6 } from '../usuarioLocales.js';

/**
 * Numeración de series de facturación.
 *
 * El ámbito del correlativo es **serie + año + sociedad emisora**: dos
 * sociedades del grupo pueden emitir el mismo número en la misma serie
 * (`FMI-2026-000001` de una y `FMI-2026-000001` de otra), pero una misma
 * sociedad no puede repetir número dentro de la serie y el año. Es lo que exige
 * la facturación interna del grupo, donde cualquier sociedad emite en la serie
 * compartida. El número visible no incluye al emisor, así que la unicidad real
 * es la tripleta serie + año + emisor + número.
 *
 * El correlativo de las facturas de venta se reserva de forma atómica en ítems
 * contador guardados en la propia tabla de series, con clave
 * `SERIE#AAAA#EMISOR` (o `SERIE##EMISOR`, sin año, cuando la serie no tiene
 * reinicio anual). Se distinguen de la configuración de serie porque la clave
 * contiene `#`, que es lo que filtran `GET /facturacion/series` y el borrado de
 * series. Los contadores antiguos con clave `SERIE#AAAA` quedan huérfanos y no
 * se vuelven a leer: cada contador nuevo se siembra desde el máximo ya emitido
 * por esa sociedad (ver `maxNumeroExistente`), que es lo que impide repetir un
 * número ya usado al cambiar el ámbito.
 */

function now() {
  return new Date().toISOString();
}

/**
 * `consistent` fuerza lectura consistente: los scans que deciden numeración
 * fiscal no pueden trabajar con una réplica atrasada y no ver una factura ya
 * emitida.
 */
async function scanAll(tableName, filterExpr, exprValues, exprNames, { consistent = false } = {}) {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ...(consistent && { ConsistentRead: true }),
        ...(lastKey && { ExclusiveStartKey: lastKey }),
        ...(filterExpr && { FilterExpression: filterExpr }),
        ...(exprValues && { ExpressionAttributeValues: exprValues }),
        ...(exprNames && { ExpressionAttributeNames: exprNames }),
      }),
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

function anioDe(fechaEmision) {
  return fechaEmision ? String(fechaEmision).substring(0, 4) : String(new Date().getFullYear());
}

export async function getSerieConfig(serie) {
  const existing = await docClient.send(new GetCommand({ TableName: tables.facturasSeries, Key: { serie } }));
  return existing.Item || null;
}

export function buildNumeroFactura(serieData, numero, fechaEmision) {
  const year = anioDe(fechaEmision);
  const digits = serieData.num_digitos || 6;
  const prefix = `${serieData.serie}-${year}-`;
  return `${prefix}${String(numero).padStart(digits, '0')}`;
}

/**
 * Normaliza el tipo de una serie o factura a 'OUT' | 'IN'. La pantalla de series
 * guarda siempre 'OUT'/'IN', pero se aceptan variantes por si hay filas antiguas
 * creadas a mano. Devuelve '' si el valor no se reconoce.
 */
function normalizarTipo(valor) {
  const v = String(valor ?? '').trim().toLowerCase();
  if (['out', 'venta', 'ventas', 'emitida', 'emitidas'].includes(v)) return 'OUT';
  if (['in', 'gasto', 'gastos', 'compra', 'compras', 'recibida', 'recibidas'].includes(v)) return 'IN';
  return '';
}

function etiquetaTipo(tipo) {
  return tipo === 'OUT' ? 'venta (OUT)' : 'gasto (IN)';
}

/**
 * Comprueba que la serie sirva para el tipo de factura que se está creando.
 * Compartir una serie entre ventas y gastos mezclaría el contador atómico (OUT)
 * con el cálculo por scan (IN) sobre el mismo correlativo.
 *
 * Tolerante con datos antiguos: si la serie no tiene `tipo` o ninguno de los dos
 * valores es reconocible, no bloquea.
 * @returns {string|null} mensaje de error en español, o null si es compatible
 */
export function errorSerieTipoIncompatible(serieConfig, tipoFactura) {
  const tipoSerie = normalizarTipo(serieConfig?.tipo);
  const tipoDestino = normalizarTipo(tipoFactura);
  if (!tipoSerie || !tipoDestino || tipoSerie === tipoDestino) return null;
  return `La serie "${serieConfig.serie}" está configurada para facturas de ${etiquetaTipo(tipoSerie)} y esta factura es de ${etiquetaTipo(tipoDestino)}. Elige una serie de ${etiquetaTipo(tipoDestino)}.`;
}

/**
 * Identificadores de la sociedad emisora de una factura, normalizados. Se
 * conservan los dos porque no todas las facturas traen ambos: la
 * previsualización del número solo recibe `emisor_id`, y facturas antiguas
 * pueden tener solo el CIF.
 * @param {{ emisor_id?: any, emisor_cif?: any }} datos factura, borrador o cuerpo de petición
 * @returns {{ id: string, cif: string }} vacíos si el emisor no está identificado
 */
export function emisorDeFactura(datos) {
  const idRaw = String(datos?.emisor_id ?? '').trim();
  // `formatId6` colapsaría a '000000' cualquier id no numérico: solo se aplica
  // al formato real del maestro de empresas.
  const id = /^\d+$/.test(idRaw) ? formatId6(idRaw) : idRaw.toUpperCase();
  return {
    id: id === '000000' ? '' : id,
    cif: normalizeCif(datos?.emisor_cif),
  };
}

/**
 * Parte de la clave del contador que identifica al emisor. Se prefiere el
 * `id_empresa` porque es el dato que traen todos los productores de facturas
 * (alta manual, facturación de mantenimiento y previsualización del número, que
 * solo recibe el id); el CIF es el respaldo cuando no hay id.
 */
function tokenEmisor(emisor) {
  if (emisor.id) return `ID:${emisor.id}`;
  if (emisor.cif) return `CIF:${emisor.cif}`;
  return 'SIN-EMISOR';
}

/**
 * ¿La factura ocupa numeración del emisor indicado?
 *
 * El criterio es "la misma salvo que se demuestre lo contrario", porque el
 * error caro es el falso negativo: dar por ajena una factura propia repite un
 * número ya emitido, mientras que dar por propia una ajena solo deja un hueco.
 *
 * - Coincide cualquiera de los dos identificadores → la misma sociedad. Una
 *   misma sociedad puede estar identificada por id en unas facturas y por CIF
 *   en otras, y tratar esas dos formas como sociedades distintas es justo lo
 *   que produciría números repetidos.
 * - No hay ningún identificador comparable (la factura no tiene emisor
 *   identificado, o cada una identifica al suyo por una vía distinta) → se
 *   cuenta como la misma. Es el caso del histórico anterior a este concepto:
 *   su número queda bloqueado para cualquier sociedad.
 * - Hay identificadores comparables y ninguno coincide → sociedades distintas,
 *   que es lo que permite `FMI-2026-000001` en dos sociedades del grupo.
 */
function mismoEmisor(factura, emisor) {
  const otro = emisorDeFactura(factura);
  if (emisor.id && otro.id && emisor.id === otro.id) return true;
  if (emisor.cif && otro.cif && emisor.cif === otro.cif) return true;
  const comparables = (emisor.id && otro.id) || (emisor.cif && otro.cif);
  return !comparables;
}

/** Clave del ítem contador: `SERIE#AAAA#EMISOR` (año vacío si no reinicia cada año). */
function claveContador(serieConfig, fechaEmision, emisor) {
  const anio = serieConfig.reinicio_anual === false ? '' : anioDe(fechaEmision);
  return `${serieConfig.serie}#${anio}#${tokenEmisor(emisor)}`;
}

/**
 * Máximo `numero` ya usado en la serie por esa sociedad emisora (y en el año, si
 * hay reinicio anual). Es la red de seguridad que permite estrechar el ámbito
 * del contador sin repetir numeración: un contador nuevo se siembra desde aquí.
 * Cuenta también las anuladas, que conservan su número.
 */
async function maxNumeroExistente(serieConfig, fechaEmision, emisor) {
  const todas = await scanAll(
    tables.facturas,
    'serie = :s',
    { ':s': serieConfig.serie },
    undefined,
    { consistent: true },
  );
  const relevantes = serieConfig.reinicio_anual === false
    ? todas
    : todas.filter((f) => (f.fecha_emision || '').startsWith(anioDe(fechaEmision)));
  return relevantes
    .filter((f) => mismoEmisor(f, emisor))
    .reduce((max, f) => Math.max(max, Number(f.numero) || 0), 0);
}

/**
 * Lectura consistente: ver un contador recién creado por otra petición evita un
 * scan de siembra innecesario y, sobre todo, garantiza que la siembra solo
 * ocurre cuando el contador realmente no existe.
 */
async function getContador(clave) {
  const existing = await docClient.send(
    new GetCommand({ TableName: tables.facturasSeries, Key: { serie: clave }, ConsistentRead: true }),
  );
  return existing.Item || null;
}

async function incrementarContador(clave) {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: tables.facturasSeries,
      Key: { serie: clave },
      UpdateExpression: 'SET actualizado_en = :now ADD ultimo_numero :uno',
      ExpressionAttributeValues: { ':uno': 1, ':now': now() },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return Number(result.Attributes?.ultimo_numero) || 1;
}

/**
 * Reserva de forma atómica el siguiente número de la serie para ese año y esa
 * sociedad emisora.
 *
 * Con contador existente el número sale de un incremento condicional de
 * DynamoDB (`ADD ultimo_numero :uno`), que es atómico: dos emisiones simultáneas
 * obtienen números distintos.
 *
 * Si el contador no existe aún —serie nueva, año nuevo, sociedad que estrena
 * numeración en la serie o cambio del ámbito de la clave— se siembra con el
 * máximo `numero` ya emitido por esa sociedad en esa serie y año, y se crea con
 * `attribute_not_exists`: dos reservas simultáneas no pueden sembrar valores
 * distintos, la que pierde la condición pasa al incremento atómico.
 *
 * @param {string} serie
 * @param {string} fechaEmision
 * @param {{ emisor_id?: any, emisor_cif?: any }} datosEmisor factura o borrador que se está emitiendo
 * @returns {Promise<{ serieConfig: object, numero: number, numero_factura: string, fecha_emision: string, emisor: { id: string, cif: string } } | null>}
 */
export async function reservarNumeroSerie(serie, fechaEmision, datosEmisor = {}) {
  const serieConfig = await getSerieConfig(serie);
  if (!serieConfig) return null;

  const emisor = emisorDeFactura(datosEmisor);
  if (!emisor.id && !emisor.cif) {
    // Sin emisor identificado el correlativo cae en el saco común de la serie,
    // que es el comportamiento antiguo. No bloquea la emisión, pero conviene
    // saberlo: una venta debería llevar siempre su sociedad emisora.
    console.warn('[series] reserva de número sin sociedad emisora identificada', { serie, fechaEmision });
  }
  const clave = claveContador(serieConfig, fechaEmision, emisor);
  let numero;
  const contador = await getContador(clave);

  if (contador) {
    numero = await incrementarContador(clave);
  } else {
    const siembra = (await maxNumeroExistente(serieConfig, fechaEmision, emisor)) + 1;
    try {
      await docClient.send(
        new PutCommand({
          TableName: tables.facturasSeries,
          Item: {
            serie: clave,
            es_contador: true,
            serie_base: serieConfig.serie,
            anio: serieConfig.reinicio_anual === false ? '' : anioDe(fechaEmision),
            emisor_id: emisor.id,
            emisor_cif: emisor.cif,
            ultimo_numero: siembra,
            actualizado_en: now(),
          },
          ConditionExpression: 'attribute_not_exists(serie)',
        }),
      );
      numero = siembra;
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      // Otra petición sembró el contador mientras calculábamos el máximo.
      numero = await incrementarContador(clave);
    }
  }

  return {
    serieConfig,
    numero,
    numero_factura: buildNumeroFactura(serieConfig, numero, fechaEmision),
    fecha_emision: fechaEmision || '',
    emisor,
  };
}

/**
 * Siguiente número sin reservarlo (preview). Usa el contador si ya existe; si no,
 * cae al cálculo por scan sobre las facturas de la serie.
 * @param {{ emisor_id?: any, emisor_cif?: any }} datosEmisor sociedad para la que se previsualiza
 * @returns {Promise<object|null>} config de serie con `ultimo_numero` = siguiente
 */
export async function peekNextNumero(serie, fechaEmision, datosEmisor = {}) {
  const serieConfig = await getSerieConfig(serie);
  if (!serieConfig) return null;

  const emisor = emisorDeFactura(datosEmisor);
  const contador = await getContador(claveContador(serieConfig, fechaEmision, emisor));
  if (contador) {
    return { ...serieConfig, ultimo_numero: (Number(contador.ultimo_numero) || 0) + 1 };
  }
  return { ...serieConfig, ultimo_numero: (await maxNumeroExistente(serieConfig, fechaEmision, emisor)) + 1 };
}

/**
 * Cálculo del siguiente número por scan (comportamiento histórico). Se mantiene
 * para las facturas de gasto (IN), que siguen numerándose al crearse. Usa el
 * mismo ámbito serie + año + emisor que el contador para no desalinearse de él.
 * @param {{ emisor_id?: any, emisor_cif?: any }} datosEmisor sociedad del grupo que registra el gasto
 * @returns {Promise<object|null>} config de serie con `ultimo_numero` = siguiente
 */
export async function calcNextNumeroPorScan(serie, fechaEmision, datosEmisor = {}) {
  const serieConfig = await getSerieConfig(serie);
  if (!serieConfig) return null;
  const maxNumero = await maxNumeroExistente(serieConfig, fechaEmision, emisorDeFactura(datosEmisor));
  return { ...serieConfig, ultimo_numero: maxNumero + 1 };
}

/**
 * Red de seguridad antes de persistir un correlativo reservado. Comprueba la
 * colisión por serie + año + emisor + `numero` (el correlativo real) y no solo
 * por la cadena `numero_factura`: esa cadena depende de `num_digitos` y del
 * formato del momento, así que facturas antiguas con otro formato no
 * coincidirían como texto aunque ocupen el mismo número.
 *
 * El mismo `numero_factura` en dos sociedades distintas **no** es duplicado: la
 * numeración es correlativa por sociedad emisora. Sí lo es cuando la factura
 * encontrada no tiene emisor identificado, porque no se puede descartar que
 * fuera de esta misma sociedad.
 * @param {{ serieConfig: object, numero: number, numero_factura: string, fecha_emision: string, emisor?: { id: string, cif: string }, emisor_id?: any, emisor_cif?: any }} reserva
 * @returns {Promise<boolean>}
 */
export async function existeCorrelativoDuplicado(reserva, idFacturaActual) {
  const { serieConfig, numero, numero_factura: numeroFactura, fecha_emision: fechaEmision } = reserva;
  const emisor = reserva.emisor || emisorDeFactura(reserva);
  const items = await scanAll(
    tables.facturas,
    'serie = :s AND (#num = :n OR numero_factura = :nf)',
    { ':s': serieConfig.serie, ':n': Number(numero), ':nf': numeroFactura || '' },
    { '#num': 'numero' },
    { consistent: true },
  );
  const anio = anioDe(fechaEmision);
  return items.some((f) => {
    if ((f.id_factura || f.id_entrada) === idFacturaActual) return false;
    if (!mismoEmisor(f, emisor)) return false;
    if (numeroFactura && f.numero_factura === numeroFactura) return true;
    if (Number(f.numero) !== Number(numero)) return false;
    if (serieConfig.reinicio_anual === false) return true;
    return (f.fecha_emision || '').startsWith(anio);
  });
}

/**
 * Serie por defecto para una rectificativa cuando el cliente no indica ninguna.
 * Se prefiere la serie de rectificativas clásica ('FR') si es del tipo correcto y,
 * si no, la primera serie activa de ese tipo; como último recurso se reutiliza la
 * serie de la factura original, para no bloquear el flujo.
 *
 * Criterio provisional: está pendiente de decidir con negocio si las
 * rectificativas de gasto deben tener serie propia o reutilizar la original.
 */
export async function serieRectificativaPorDefecto(tipoFactura, serieOriginal) {
  const items = await scanAll(tables.facturasSeries);
  const compatibles = items
    .filter((s) => !String(s.serie || '').includes('#'))
    .filter((s) => normalizarTipo(s.tipo) === normalizarTipo(tipoFactura))
    .sort((a, b) => String(a.serie).localeCompare(String(b.serie)));
  const elegida = compatibles.find((s) => s.serie === 'FR' && s.activa !== false)
    || compatibles.find((s) => s.activa !== false)
    || compatibles[0];
  return elegida?.serie || serieOriginal || '';
}
